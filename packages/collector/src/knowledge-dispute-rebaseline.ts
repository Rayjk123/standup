import type { Database } from "bun:sqlite";
import {
  UNVERIFIABLE_VERDICT,
  ensureJudgmentSchema,
  pairJudgment,
  parseContradictsClaim,
  recordJudgment,
  type KnowledgeDocFile,
} from "@standup/knowledge";
import { droppedNote, type DraftDispute } from "./draft-verify.js";
import { filterEntailedDisputes, type EntailmentJudge } from "./knowledge-dispute-evidence.js";
import {
  UNDECIDED_BASIS,
  applySupersessions,
  judgmentRelation,
  type ContradictionJudge,
  type DocVerdictState,
  type JudgeRelation,
} from "./knowledge-coherence.js";
import { isSupersededTombstone } from "./knowledge-resolve.js";

/**
 * Re-baselines the dispute labels already stored on accepted docs under the
 * current verdict rules, so labels written by an earlier, noisier check stop
 * hiding accurate docs:
 *
 * (a) every stored fact dispute that cites lines is re-run through the
 *     entailment filter (knowledge-dispute-evidence.ts); a refuted one is
 *     replaced by a note, as a fresh fact-check would have dropped it;
 * (b) a pair once marked "disputed" on both sides for want of a loser becomes
 *     "contradicted" and undecided (shown with a conflict marker);
 * (c) a `Contradicts <slug>` edge whose pair the judge now reads as
 *     supersedes / complementary / consistent is cleared from both sides — the
 *     judge is re-run when one is given, else the pair's latest ledger outcome
 *     is read; a confident supersession may also retire the older doc
 *     (applySupersessions);
 * (d) every doc still "disputed" afterwards is handed to `queueReverify`, so a
 *     fresh fact-check on current mainline decides it.
 *
 * Idempotent: a second run over its own output changes nothing. Model steps
 * (`judge`, `entailmentJudge`) are injected; without them the pass is
 * deterministic only. Superseded docs are retired and left alone.
 */

export interface RebaselineDeps {
  db: Database;
  /** Writes a doc's verdict and disputes; a null verdict clears both. */
  setVerdict: (projectId: string, slug: string, verdict: string | null, disputes: DraftDispute[]) => void;
  /** Re-judges each contradiction pair; omitted, the ledger's latest outcome is used. */
  judge?: ContradictionJudge;
  /** Reads a doc's accepted text for `judge`. */
  readAcceptedDoc?: (projectId: string, slug: string) => Promise<KnowledgeDocFile | null>;
  /** Decides fact disputes the deterministic entailment rule leaves undecided. */
  entailmentJudge?: EntailmentJudge;
  /** Schedules a doc for a fresh fact-check; omitted, the docs are only listed. */
  queueReverify?: (projectId: string, slug: string) => void;
  /** Cap on judge calls in one run. */
  maxJudged?: number;
}

export interface RebaselineCounts {
  docsScanned: number;
  docsChanged: number;
  /** Fact disputes dropped as refuted by their own evidence. */
  refutedDisputes: number;
  /** Docs moved from a both-sides "disputed" tie to undecided "contradicted". */
  tiesConverted: number;
  /** Contradiction pairs whose edge was cleared. */
  edgesCleared: number;
  /** Older docs retired by a confident supersession. */
  superseded: number;
  /** Judge calls made. */
  judged: number;
  /** `project/slug` of every doc still disputed, handed to queueReverify when given. */
  reverify: string[];
}

/** Judge calls one run makes at most, by default. */
export const REBASELINE_MAX_JUDGED = 50;

interface Row {
  project_id: string;
  slug: string;
  verdict: string | null;
  disputes_json: string | null;
  origin_class: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  generated_at: string | null;
}

interface Entry {
  projectId: string;
  slug: string;
  original: { verdict: string | null; disputes: string };
  verdict: string | null;
  disputes: DraftDispute[];
  state: Omit<DocVerdictState, "verdict" | "disputes">;
  /** Whether the verdict must be recomputed from the disputes. */
  touched: boolean;
}

const COLUMNS =
  "project_id, slug, verdict, disputes_json, origin_class, confidence, last_verified_at, half_life_days, generated_at";

function parseDisputes(json: string | null): DraftDispute[] {
  try {
    const parsed = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? (parsed as DraftDispute[]).filter((d) => d && typeof d.claim === "string")
      : [];
  } catch {
    return [];
  }
}

function entryOf(r: Row): Entry {
  const disputes = parseDisputes(r.disputes_json);
  return {
    projectId: r.project_id,
    slug: r.slug,
    original: { verdict: r.verdict, disputes: JSON.stringify(disputes) },
    verdict: r.verdict,
    disputes,
    state: {
      originClass: r.origin_class ?? undefined,
      confidence: r.confidence ?? undefined,
      lastVerifiedAt: r.last_verified_at ?? undefined,
      halfLifeDays: r.half_life_days ?? undefined,
      generatedAt: r.generated_at ?? undefined,
    },
    touched: false,
  };
}

/** A model fact-check finding: not an edge, a tombstone or a note. */
function isFactDispute(d: DraftDispute): boolean {
  return parseContradictsClaim(d.claim) === null && !isSupersededTombstone(d.claim) && d.origin === undefined;
}

/** The verdict a doc's remaining disputes amount to. */
function verdictFor(disputes: readonly DraftDispute[], previous: string | null): string | null {
  if (disputes.some((d) => isSupersededTombstone(d.claim))) return "superseded";
  if (disputes.some(isFactDispute)) return "disputed";
  if (disputes.some((d) => parseContradictsClaim(d.claim) !== null)) return "contradicted";
  if (disputes.some((d) => d.origin === "git")) return "unverified";
  if (disputes.some((d) => d.origin !== undefined)) {
    return previous === UNVERIFIABLE_VERDICT ? UNVERIFIABLE_VERDICT : "unverified";
  }
  return null;
}

export async function rebaselineDisputes(deps: RebaselineDeps): Promise<RebaselineCounts> {
  const { db } = deps;
  ensureJudgmentSchema(db);
  const counts: RebaselineCounts = {
    docsScanned: 0,
    docsChanged: 0,
    refutedDisputes: 0,
    tiesConverted: 0,
    edgesCleared: 0,
    superseded: 0,
    judged: 0,
    reverify: [],
  };
  const entries = new Map<string, Entry>();
  const key = (projectId: string, slug: string) => `${projectId}/${slug}`;
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM knowledge
        WHERE verdict IS NOT NULL AND verdict != 'superseded'
          AND disputes_json IS NOT NULL AND disputes_json != '[]'
        ORDER BY project_id, slug`
    )
    .all() as Row[];
  for (const r of rows) entries.set(key(r.project_id, r.slug), entryOf(r));
  counts.docsScanned = entries.size;
  const rowQuery = db.query(`SELECT ${COLUMNS} FROM knowledge WHERE project_id = ? AND slug = ?`);
  /** A doc's entry, loading one with no disputes on demand (a supersession's newer side). */
  const entry = (projectId: string, slug: string): Entry | null => {
    const k = key(projectId, slug);
    const found = entries.get(k);
    if (found) return found;
    const row = rowQuery.get(projectId, slug) as Row | null;
    if (!row) return null;
    const loaded = entryOf(row);
    entries.set(k, loaded);
    return loaded;
  };

  // (a) Entailment over stored fact disputes.
  for (const e of [...entries.values()]) {
    const cited = e.disputes.filter((d) => isFactDispute(d) && (d.citations?.length ?? 0) > 0);
    if (cited.length === 0) continue;
    const { kept, refuted } = await filterEntailedDisputes(cited, deps.entailmentJudge);
    if (refuted.length === 0) continue;
    const keptSet = new Set(kept);
    e.disputes = [
      ...e.disputes.filter((d) => !cited.includes(d) || keptSet.has(d)),
      ...refuted.map(droppedNote),
    ];
    e.touched = true;
    counts.refutedDisputes += refuted.length;
  }

  // (b) Both-sides "disputed" ties.
  for (const e of entries.values()) {
    if (e.verdict !== "disputed") continue;
    const tie = e.disputes.some(
      (d) => parseContradictsClaim(d.claim) !== null && d.evidence.includes(UNDECIDED_BASIS)
    );
    if (tie && !e.disputes.some(isFactDispute)) {
      e.touched = true;
      counts.tiesConverted++;
    }
  }

  // (c) Contradiction edges the judge no longer reads as contradictions.
  const pairs = new Map<string, { projectId: string; a: string; b: string }>();
  for (const e of entries.values()) {
    for (const d of e.disputes) {
      const other = parseContradictsClaim(d.claim);
      if (!other || other === e.slug) continue;
      const [a, b] = [e.slug, other].sort() as [string, string];
      pairs.set(`${e.projectId}/${a} ${b}`, { projectId: e.projectId, a, b });
    }
  }
  const maxJudged = deps.maxJudged ?? REBASELINE_MAX_JUDGED;
  const flagDeps = {
    getDoc: (projectId: string, slug: string): DocVerdictState | null => {
      const e = entry(projectId, slug);
      return e ? { ...e.state, verdict: e.verdict ?? undefined, disputes: e.disputes } : null;
    },
    recordVerdict: (projectId: string, slug: string, verdict: string, disputes: unknown[]) => {
      const e = entry(projectId, slug);
      if (!e) return;
      e.verdict = verdict;
      e.disputes = disputes as DraftDispute[];
    },
  };
  for (const { projectId, a, b } of pairs.values()) {
    let relation: JudgeRelation | null = null;
    let supersession: { newer: "a" | "b"; confidence: number; reason: string } | null = null;
    if (deps.judge && deps.readAcceptedDoc && counts.judged < maxJudged) {
      const [docA, docB] = await Promise.all([deps.readAcceptedDoc(projectId, a), deps.readAcceptedDoc(projectId, b)]);
      if (docA && docB) {
        counts.judged++;
        const judgment = await deps.judge(
          { slug: a, title: docA.title, body: docA.body, projectId },
          { slug: b, title: docB.title, body: docB.body, projectId }
        );
        if (judgment.error === undefined) {
          relation = judgmentRelation(judgment);
          recordJudgment(db, {
            projectId,
            subjectSlug: a,
            candidateProjectId: projectId,
            candidateSlug: b,
            outcome: relation,
            method: "llm",
            reason: judgment.reason,
            attempts: judgment.attempts ?? 1,
          });
          if (relation === "supersedes" && judgment.newer) {
            supersession = { newer: judgment.newer, confidence: judgment.confidence ?? 0, reason: judgment.reason };
          }
        }
      }
    } else {
      const outcome = pairJudgment(db, projectId, a, projectId, b);
      if (outcome === "supersedes" || outcome === "complementary" || outcome === "consistent") relation = outcome;
    }
    if (relation === null || relation === "contradicts") continue;
    for (const [slug, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const e = entries.get(key(projectId, slug));
      if (!e) continue;
      const kept = e.disputes.filter((d) => parseContradictsClaim(d.claim) !== other);
      if (kept.length === e.disputes.length) continue;
      e.disputes = kept;
      e.touched = true;
    }
    counts.edgesCleared++;
    if (supersession) {
      // Verdicts are settled first, so the newer side reads as the clean doc it now is.
      for (const slug of [a, b]) {
        const e = entries.get(key(projectId, slug));
        if (e?.touched) e.verdict = verdictFor(e.disputes, e.verdict);
      }
      const newerSlug = supersession.newer === "a" ? a : b;
      const olderSlug = supersession.newer === "a" ? b : a;
      const retired = applySupersessions(flagDeps, projectId, [
        { olderSlug, newerSlug, confidence: supersession.confidence, reason: supersession.reason },
      ]);
      counts.superseded += retired.length;
    }
  }

  // Write what changed, then list the docs still disputed.
  for (const e of entries.values()) {
    if (e.touched && e.verdict !== "superseded") e.verdict = verdictFor(e.disputes, e.verdict);
    const disputes = JSON.stringify(e.disputes);
    if (e.verdict !== e.original.verdict || disputes !== e.original.disputes) {
      deps.setVerdict(e.projectId, e.slug, e.verdict, e.verdict === null ? [] : e.disputes);
      counts.docsChanged++;
    }
    if (e.verdict === "disputed") {
      counts.reverify.push(key(e.projectId, e.slug));
      deps.queueReverify?.(e.projectId, e.slug);
    }
  }
  return counts;
}
