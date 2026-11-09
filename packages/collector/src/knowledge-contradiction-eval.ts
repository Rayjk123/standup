import type { Database } from "bun:sqlite";
import {
  searchKnowledge,
  KnowledgeStore,
  DEFAULT_HALF_LIFE_DAYS,
  type SearchResult,
  type SearchOptions,
  type KnowledgeDoc,
  type KnowledgeDocFile,
  type DraftDispute,
} from "@standup/knowledge";
import {
  detectContradictions,
  flagContradictions,
  parseJudgeOutput,
  type ContradictionJudge,
  type ContradictionJudgment,
  type DocText,
} from "./knowledge-coherence.js";
import type { DocVerdictState } from "./knowledge-coherence.js";
import {
  resolveContradiction,
  type ClaimRecord,
  type ContradictionResolver,
  type ResolveDeps,
  type ResolveOutcome,
} from "./knowledge-resolve.js";

/**
 * Contradiction / temporal eval harness — the coherence-layer counterpart to the
 * retrieval eval in @standup/knowledge (eval.ts). It measures the differentiator
 * of Standup's KB (contradiction handling + temporal invalidation) the way the
 * retrieval harness measures search quality: a small LABELED golden set scored
 * through the REAL detection + resolution pipeline, with every LLM seam replaced
 * by a deterministic stub. So the whole thing is pure of I/O beyond an in-memory
 * SQLite — NO async spawn, NO subprocess, NO live model, NO live DB — and cannot
 * be flaky.
 *
 * Three things are measured:
 *  - the "contradicts" class precision / recall / F1 of the detect+flag pipeline
 *    over labeled contradictions, non-contradictions, and HARD NEGATIVES (same
 *    topic, different scope / time / subject). A deterministic ORACLE judge
 *    isolates the pipeline's candidate-gating + flag/fold logic from live-LLM
 *    accuracy; a NAIVE similarity-only judge is scored alongside it to prove the
 *    hard negatives actually discriminate (the LLM judge earns its keep).
 *  - resolution accuracy: a deterministic recency/owner rule resolver run through
 *    resolveContradiction picks the labeled winner, auto-applying the safe cases
 *    and withholding the protected ones.
 *  - a FreshQA-style temporal case (in knowledge-contradiction-eval.test.ts): a
 *    superseding fact_v2 retires fact_v1, and a "now" query prefers v2 because v1
 *    carries the supersede tombstone that holds it out of injection.
 */

/** The project the harness scores under — arbitrary; every fixture shares it so
 *  the cross-project skip in detection never fires. */
export const EVAL_PROJECT = "kb-eval";

// ── Detector golden set (precision / recall / F1) ─────────────────────────────

/** How the doc PAIR relates, for documentation and per-cut reporting. A hard
 *  negative shares the subject's TOPIC but differs on scope / time / subject, so
 *  a similarity-only detector fabricates a contradiction the LLM judge rejects. */
export type ContradictionCategory = "contradiction" | "non-contradiction" | "hard-negative";

/** One labeled `subject × candidate` pair. `similarity` is the fused rawScore the
 *  search recalls the candidate at — fixing the retrieval step so the metric
 *  measures DETECTION, not recall. `contradicts` is the ground truth. */
export interface ContradictionCase {
  name: string;
  category: ContradictionCategory;
  subject: DocText;
  candidate: DocText;
  similarity: number;
  contradicts: boolean;
}

/**
 * The golden set. Every candidate is recalled ABOVE the hybrid candidate floor
 * (so it reaches the judge) — the metric isolates whether detection FLAGS a
 * genuine opposition and whether it FABRICATES one on a same-topic non-conflict.
 * The hard negatives are the discriminating cases: same topic, above the floor,
 * but reconciled by scope / time / subject rather than truly opposing.
 */
export const CONTRADICTION_GOLDEN_SET: ContradictionCase[] = [
  {
    name: "runtime: Bun vs Node",
    category: "contradiction",
    subject: { slug: "runtime-bun", title: "Runtime", body: "The collector runs on Bun." },
    candidate: { slug: "runtime-node", title: "Runtime", body: "The project runs on Node, never Bun." },
    similarity: 0.82,
    contradicts: true,
  },
  {
    name: "deploy region: us-east-1 vs eu-west-1",
    category: "contradiction",
    subject: { slug: "region-use1", title: "Deploy region", body: "Production deploys to us-east-1." },
    candidate: { slug: "region-euw1", title: "Deploy region", body: "Production deploys to eu-west-1, not us-east-1." },
    similarity: 0.74,
    contradicts: true,
  },
  {
    name: "agreement: Postgres primary store",
    category: "non-contradiction",
    subject: { slug: "store-pg", title: "Datastore", body: "The primary store is Postgres." },
    candidate: { slug: "store-pg-detail", title: "Datastore", body: "Postgres backs the primary store and holds the write path." },
    similarity: 0.71,
    contradicts: false,
  },
  {
    name: "hard negative (scope): cache TTL prod vs beta",
    category: "hard-negative",
    subject: { slug: "ttl-prod", title: "Cache TTL", body: "The cache TTL is 60 seconds in production." },
    candidate: { slug: "ttl-beta", title: "Cache TTL", body: "The cache TTL is 5 seconds on the beta stack." },
    similarity: 0.78,
    contradicts: false,
  },
  {
    name: "hard negative (time): 2024 DMS vs 2026 Kinesis",
    category: "hard-negative",
    subject: { slug: "mig-2024", title: "Migration path", body: "The 2024 migration used DMS to move rows." },
    candidate: { slug: "mig-2026", title: "Migration path", body: "The 2026 migration uses Kinesis to stream rows." },
    similarity: 0.72,
    contradicts: false,
  },
  {
    name: "hard negative (subject): timeout of service A vs B",
    category: "hard-negative",
    subject: { slug: "timeout-a", title: "Request timeout", body: "Service A has a 30 second request timeout." },
    candidate: { slug: "timeout-b", title: "Request timeout", body: "Service B has a 10 second request timeout." },
    similarity: 0.7,
    contradicts: false,
  },
];

/** A SearchResult carrying the case's recalled similarity as the fused rawScore,
 *  the field the candidate floor gates on. */
function hitFor(candidate: DocText, similarity: number): SearchResult {
  return {
    id: `id-${candidate.slug}`,
    projectId: EVAL_PROJECT,
    slug: candidate.slug,
    title: candidate.title,
    excerpt: "",
    score: similarity,
    rawScore: similarity,
    source: "embedding",
    originClass: "agent",
    sourceKind: "code",
    generated: true,
  };
}

/** The candidate's authoritative body, in the shape readAcceptedDoc returns. */
function docFileFor(candidate: DocText): KnowledgeDocFile {
  return {
    slug: candidate.slug,
    title: candidate.title,
    body: candidate.body,
    tags: [],
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    sourceKind: "code",
  };
}

/**
 * The deterministic ORACLE judge: it answers from the case's ground-truth label,
 * but does so by emitting the exact JSON shape the production prompt asks for and
 * running it through the REAL parseJudgeOutput — so the golden run also exercises
 * the judge parse contract, not just the label. `bySlug` maps a candidate slug to
 * its labeled truth.
 */
export function oracleJudge(cases: readonly ContradictionCase[]): ContradictionJudge {
  const bySlug = new Map(cases.map((c) => [c.candidate.slug, c.contradicts]));
  return async (_a, b): Promise<ContradictionJudgment> => {
    const truth = bySlug.get(b.slug) ?? false;
    const raw = truth
      ? `{"contradicts": true, "reason": "opposing claim in ${b.slug}"}`
      : `{"contradicts": false, "reason": ""}`;
    return parseJudgeOutput(raw);
  };
}

/**
 * A NAIVE similarity-only judge: it flags EVERY candidate that reaches it (i.e.
 * every above-floor hit) as contradicting. Modelling a detector with no LLM step,
 * only the recall gate — scored against the golden set it fabricates on the hard
 * negatives, so its precision collapses. Its whole purpose is to prove the metric
 * has teeth and the judge step is load-bearing.
 */
export function naiveSimilarityJudge(): ContradictionJudge {
  return async (): Promise<ContradictionJudgment> => ({ contradicts: true, reason: "same topic" });
}

/** Precision / recall / F1 of the "contradicts" class plus the true/false positive and negative counts. */
export interface DetectionScore {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  perCase: Array<{ name: string; category: ContradictionCategory; label: boolean; predicted: boolean }>;
}

/**
 * Scores the detect+flag pipeline over the golden set with the given judge.
 * Prediction per case = "the candidate ends up FLAGGED contradicted" — the
 * composition of detectContradictions (candidate-gating + judge) and
 * flagContradictions (the flag/fold write), so the metric covers both. No model
 * spawn: the judge is the injected deterministic stub.
 */
export async function scoreContradictionDetection(
  cases: readonly ContradictionCase[],
  judge: ContradictionJudge,
  options: { embeddingsEnabled?: boolean } = {}
): Promise<DetectionScore> {
  const embeddingsEnabled = options.embeddingsEnabled ?? true;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const perCase: DetectionScore["perCase"] = [];

  for (const c of cases) {
    const search = async (
      _projectId: string,
      _query: string,
      _opts?: SearchOptions
    ): Promise<SearchResult[]> => [hitFor(c.candidate, c.similarity)];
    const contradictions = await detectContradictions(
      {
        search,
        readAcceptedDoc: async () => docFileFor(c.candidate),
        judge,
        embeddingsEnabled,
      },
      EVAL_PROJECT,
      c.subject
    );
    const flagged = flagContradictions(
      { recordVerdict: () => {}, getDoc: () => null },
      EVAL_PROJECT,
      c.subject,
      contradictions
    );
    const predicted = flagged.includes(c.candidate.slug);

    if (c.contradicts && predicted) tp++;
    else if (!c.contradicts && predicted) fp++;
    else if (c.contradicts && !predicted) fn++;
    else tn++;
    perCase.push({ name: c.name, category: c.category, label: c.contradicts, predicted });
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn, tn, perCase };
}

// ── Resolution accuracy (recency / owner rules) ───────────────────────────────

/** Picks the winner of a conflicting pair by deterministic precedence: newer
 *  `lastVerifiedAt` wins (recency — the FreshQA rule); an owner-authored doc wins
 *  a date tie over an agent-authored one (provenance); higher confidence breaks a
 *  remaining tie. Exported so the temporal case and the accuracy score share one
 *  rule. */
export function pickWinnerByRules(a: ClaimRecord, b: ClaimRecord): ClaimRecord {
  const ta = a.lastVerifiedAt ? Date.parse(a.lastVerifiedAt) : NaN;
  const tb = b.lastVerifiedAt ? Date.parse(b.lastVerifiedAt) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb ? a : b;
  const aOwner = a.originClass === "owner";
  const bOwner = b.originClass === "owner";
  if (aOwner !== bOwner) return aOwner ? a : b;
  return (a.confidence ?? 0) >= (b.confidence ?? 0) ? a : b;
}

/** A deterministic resolver: choose the winner by {@link pickWinnerByRules} and
 *  propose superseding the loser. Stands in for the production Haiku resolver so
 *  the resolution path runs with no model spawn. */
export const ruleBasedResolver: ContradictionResolver = async ({ a, b }) => {
  const winner = pickWinnerByRules(a, b);
  const loser = winner.slug === a.slug ? b : a;
  return {
    type: "supersede",
    winnerSlug: winner.slug,
    loserSlug: loser.slug,
    rationale: `${winner.slug} supersedes ${loser.slug} by recency/provenance`,
  };
};

/** One labeled resolution case: the two claims, the winner the rules should pick,
 *  and whether the autonomy gate should auto-apply (a protected loser withholds). */
export interface ResolutionCase {
  name: string;
  a: ClaimRecord;
  b: ClaimRecord;
  winnerSlug: string;
  expectAutoApply: boolean;
}

/** A ClaimRecord with harness defaults (agent-authored, low confidence). */
function claim(slug: string, over: Partial<ClaimRecord> = {}): ClaimRecord {
  return { slug, title: slug, body: `body of ${slug}`, originClass: "agent", sourceKind: "code", confidence: 0.2, ...over };
}

export const RESOLUTION_GOLDEN_SET: ResolutionCase[] = [
  {
    name: "recency: newer agent fact wins, older is tombstoned",
    a: claim("fact-old", { lastVerifiedAt: "2026-01-01T00:00:00Z" }),
    b: claim("fact-new", { lastVerifiedAt: "2026-06-01T00:00:00Z" }),
    winnerSlug: "fact-new",
    expectAutoApply: true,
  },
  {
    name: "owner beats agent on a date tie",
    a: claim("owner-doc", { originClass: "owner", lastVerifiedAt: "2026-03-01T00:00:00Z" }),
    b: claim("agent-doc", { originClass: "agent", lastVerifiedAt: "2026-03-01T00:00:00Z" }),
    winnerSlug: "owner-doc",
    expectAutoApply: true,
  },
  {
    name: "newer agent wins but the owner loser withholds for review",
    a: claim("owner-old", { originClass: "owner", lastVerifiedAt: "2026-01-01T00:00:00Z" }),
    b: claim("agent-new", { originClass: "agent", lastVerifiedAt: "2026-06-01T00:00:00Z" }),
    winnerSlug: "agent-new",
    expectAutoApply: false,
  },
];

/** A recording in-memory ResolveDeps over a fixed pair of claims — no store, no
 *  filesystem, no spawn. Captures verdict writes so a caller can assert the loser
 *  was tombstoned. */
export function memoryResolveDeps(
  claims: Record<string, ClaimRecord>,
  resolve: ContradictionResolver,
  now: Date
): { deps: ResolveDeps; verdicts: Array<{ slug: string; verdict: string | null; disputes: DraftDispute[] }> } {
  const verdicts: Array<{ slug: string; verdict: string | null; disputes: DraftDispute[] }> = [];
  const state: Record<string, DocVerdictState> = {};
  for (const slug of Object.keys(claims)) {
    state[slug] = { verdict: "contradicted", disputes: [{ claim: "Contradicts other", finding: "f", evidence: "e" }] };
  }
  const deps: ResolveDeps = {
    loadClaim: (_p, slug) => claims[slug] ?? null,
    getVerdictState: (_p, slug) => state[slug] ?? null,
    search: async () => [],
    resolve,
    decayConfidence: async () => {},
    setVerdict: (_p, slug, verdict, disputes) => {
      verdicts.push({ slug, verdict, disputes });
      state[slug] = { verdict: verdict ?? undefined, disputes };
    },
    rescopeBody: async () => {},
    mergeBody: async () => {},
    resync: async () => {},
    findContradictors: () => [],
    recordResolution: () => {},
    now: () => now,
  };
  return { deps, verdicts };
}

/** Accuracy of the rule resolver: the fraction of golden cases whose resolved
 *  winner equals the labeled winner AND whose auto-apply status matches. */
export interface ResolutionAccuracy {
  accuracy: number;
  perCase: Array<{
    name: string;
    expectedWinner: string;
    gotWinner: string | null;
    status: ResolveOutcome["status"];
    autoApplyOk: boolean;
    correct: boolean;
  }>;
}

export async function scoreResolutionAccuracy(
  cases: readonly ResolutionCase[],
  now: Date = new Date("2026-09-01T00:00:00Z")
): Promise<ResolutionAccuracy> {
  const perCase: ResolutionAccuracy["perCase"] = [];
  let correct = 0;
  for (const c of cases) {
    const { deps } = memoryResolveDeps({ [c.a.slug]: c.a, [c.b.slug]: c.b }, ruleBasedResolver, now);
    const outcome = await resolveContradiction(deps, EVAL_PROJECT, c.a.slug, c.b.slug);
    const gotWinner =
      outcome.status === "applied" || outcome.status === "needs-review" ? outcome.winnerSlug : null;
    const autoApplyOk =
      (outcome.status === "applied") === c.expectAutoApply &&
      (outcome.status === "applied" || outcome.status === "needs-review");
    const isCorrect = gotWinner === c.winnerSlug && autoApplyOk;
    if (isCorrect) correct++;
    perCase.push({ name: c.name, expectedWinner: c.winnerSlug, gotWinner, status: outcome.status, autoApplyOk, correct: isCorrect });
  }
  return { accuracy: cases.length === 0 ? 0 : correct / cases.length, perCase };
}

// ── Temporal (FreshQA) wiring ─────────────────────────────────────────────────

/**
 * A store-backed ResolveDeps for the temporal case: reads/writes verdicts and
 * confidence against a real in-memory KnowledgeStore and grounds via the real
 * searchKnowledge, but takes the resolver as an injected deterministic stub — so
 * the supersede genuinely lands on the DB row (its verdict column) that a "now"
 * query and the injection gate then read, with no model spawn and no live DB.
 */
export function storeResolveDeps(db: Database, resolve: ContradictionResolver, now: Date): ResolveDeps {
  const store = new KnowledgeStore(db);
  const load = (projectId: string, slug: string): KnowledgeDoc | null =>
    store.getDocById(`${projectId}/${slug}`);
  return {
    loadClaim: (projectId, slug) => {
      const d = load(projectId, slug);
      return d
        ? {
            slug: d.slug,
            title: d.title,
            body: d.body,
            originClass: d.originClass,
            sourceKind: d.sourceKind,
            confidence: d.confidence,
            lastVerifiedAt: d.lastVerifiedAt,
            halfLifeDays: d.halfLifeDays,
            generatedFromSha: d.generatedFromSha,
          }
        : null;
    },
    getVerdictState: (projectId, slug) => {
      const d = load(projectId, slug);
      return d ? { verdict: d.verdict, disputes: d.disputes } : null;
    },
    search: (projectId, query, options) => searchKnowledge(db, projectId, query, null, options),
    resolve,
    decayConfidence: async (projectId, slug, confidence, lastVerifiedAt) => {
      const d = load(projectId, slug);
      if (!d) return;
      store.upsertDoc({ ...d, confidence, lastVerifiedAt, halfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    },
    setVerdict: (projectId, slug, verdict, disputes) => {
      if (verdict === null) store.clearDocVerdict(projectId, slug);
      else store.setDocVerdict(projectId, slug, verdict, disputes);
    },
    rescopeBody: async () => {},
    mergeBody: async () => {},
    resync: async () => {},
    findContradictors: () => [],
    recordResolution: () => {},
    now: () => now,
  };
}
