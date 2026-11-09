import type { Database } from "bun:sqlite";
import { DRAFT_VERIFY_CWD, ensureInternalCwd } from "./internal-cwd.js";
import { findNearestDocs, type NearestDoc } from "./knowledge-dedup.js";
import {
  PLAYBOOK_SOURCE_KIND,
  deriveConfidence,
  ensureJudgmentSchema,
  formatContradictsClaim,
  isUncheckedVerdict,
  parseContradictsClaim,
  queueRejudge,
  recordJudgment,
} from "@standup/knowledge";
import type {
  KnowledgeDocFile,
  ScopeAudience,
  SearchResult,
  SearchOptions,
  DraftDispute,
} from "@standup/knowledge";
import { headlessSettingsArgs } from "./claude-cli.js";
import { supersededTombstone } from "./knowledge-resolve.js";
import { withoutSlotEnv } from "./worker-env.js";

/**
 * Corpus coherence (roadmap r7) — keeps the self-growing knowledge base from
 * drifting into contradiction or bloat as the r6 distiller and the r5 re-verify
 * pass keep writing to it. Two checks, both reusing the r6 near-dup
 * infrastructure (embedding-backed hybrid search + the lexical near-dup gate):
 *
 * - DEDUP at write: before a doc becomes accepted, it is compared against the
 *   accepted docs its audience can see with the shared near-duplicate detector
 *   (knowledge-dedup.ts — raw cosine, token overlap and title similarity). A
 *   near-duplicate is suppressed rather than added.
 *
 * - CONTRADICTION detection: a newly-accepted or re-verified doc is compared to
 *   the accepted docs most similar to it (embedding recall via the same search),
 *   and a judge confirms whether any states an OPPOSING claim — embedding
 *   similarity alone cannot tell "X is true" from "X is false". A cheap LLM
 *   judge decides; a judge that cannot answer is a judge ERROR — retried,
 *   recorded, never read as "no contradiction". (Claims about the repository's
 *   own state are checked against git by the doc's fact-check, as findings on
 *   that doc — see knowledge-repo-claims.ts.) A confirmed contradiction flags
 *   only the side that loses (fact-disputed below clean, agent below owner,
 *   unverified below verified, lower confidence, older) as "contradicted" with
 *   a dispute naming the winner; a
 *   pair with no deterministic loser marks both "contradicted" as undecided, so
 *   retrieval shows both sides with a conflict marker and neither is silently
 *   trusted. The judge also tells a timeline (`supersedes`) and complementary
 *   docs apart from a contradiction; neither becomes a contradiction edge.
 *
 * Both are pure of I/O beyond their injected deps (search, doc reads, the judge,
 * the verdict write), so the whole decision is unit-testable with a mocked
 * judge and no database, filesystem, or `claude` spawn.
 */

/** The minimal doc shape the coherence checks compare. */
export interface DocText {
  slug: string;
  title: string;
  body: string;
  /** The doc's project; set by detection so a judge wrapper can locate the
   *  repo and log the pair. */
  projectId?: string;
}

// ── Dedup at accept ───────────────────────────────────────────────────────────

export type DedupOutcome =
  | { status: "distinct"; nearest: NearestDoc[] }
  | {
      status: "duplicate";
      dupSlug: string;
      dupProjectId: string;
      score: number;
      nearest: NearestDoc[];
    };

export interface DedupDeps {
  search: (projectId: string, query: string, options?: SearchOptions) => Promise<SearchResult[]>;
  readAcceptedDoc: (projectId: string, slug: string) => Promise<KnowledgeDocFile | null>;
  /** Whether search fuses an embedding arm; undefined reads as yes. */
  embeddingsEnabled?: boolean;
  /** A doc's live verdict, so a superseded copy is never the match. */
  getVerdict?: (projectId: string, slug: string) => string | undefined;
}

/**
 * Whether `subject` duplicates an accepted doc visible to `audience` (omitted:
 * the project's own docs). `excludeSlugs` drops the doc's own slug and any it is
 * explicitly replacing, so a doc never reads as a duplicate of itself or of the
 * doc it is a deliberate regenerate of. Always returns the nearest neighbors so
 * a caller can show them.
 */
export async function detectDuplicate(
  deps: DedupDeps,
  projectId: string,
  subject: DocText,
  excludeSlugs: readonly string[] = [],
  audience?: ScopeAudience
): Promise<DedupOutcome> {
  const nearest = await findNearestDocs(deps, projectId, subject, {
    audience,
    exclude: excludeSlugs.map((slug) => `${projectId}/${slug}`),
  });
  const dup = nearest.find((n) => n.duplicate);
  return dup
    ? {
        status: "duplicate",
        dupSlug: dup.slug,
        dupProjectId: dup.projectId,
        score: dup.similarity,
        nearest,
      }
    : { status: "distinct", nearest };
}

// ── Contradiction detection ─────────────────────────────────────────────────

/**
 * How two docs about the same subject relate, as the judge answers it. Only
 * `contradicts` (both cannot be true) yields a contradiction dispute and so a
 * `contradicts` graph edge. `supersedes` is a timeline — the newer doc updates
 * the older — and may retire the older doc (see applySupersessions);
 * `complementary` (different facets of one subject) and `consistent` record the
 * judgment and change nothing.
 */
export type JudgeRelation = "contradicts" | "supersedes" | "complementary" | "consistent";

export interface ContradictionJudgment {
  /** Whether the relation is `contradicts`. */
  contradicts: boolean;
  /** The judge's relation; omitted by a judge that answers only `contradicts`,
   *  which then reads as `contradicts` or `consistent` (judgmentRelation). */
  relation?: JudgeRelation;
  /** For `supersedes`: which document is the newer one, updating the other. */
  newer?: "a" | "b";
  /** The judge's confidence in its relation, 0..1, when it gave one. */
  confidence?: number;
  /** One-line explanation of the opposing claims; empty when not contradicting. */
  reason: string;
  /**
   * Set when the judge could not answer (a failed spawn, an auth error, a
   * timeout, an unreadable reply): `contradicts` is then meaningless and the
   * pair is unjudged, never "consistent".
   */
  error?: string;
  /** How the judgment was reached. */
  method?: "llm";
  /** Set with `error` when the judge was never asked because the run's spawn
   *  budget is spent: nothing to retry and nothing to record. */
  skipped?: boolean;
  /** Set with `error` when retrying now cannot help (the check's time budget is
   *  used up): recorded and queued for a later run, not retried here. */
  final?: boolean;
  /** Judge calls spent on this pair, retries included. */
  attempts?: number;
}

/** The LLM judge: does doc B state a claim that OPPOSES doc A? Injected so the
 *  detection logic is testable without spawning a model. */
export type ContradictionJudge = (a: DocText, b: DocText) => Promise<ContradictionJudgment>;

/** A judgment's relation, reading a bare `contradicts` answer as contradicts / consistent. */
export function judgmentRelation(j: ContradictionJudgment): JudgeRelation {
  return j.relation ?? (j.contradicts ? "contradicts" : "consistent");
}

export interface Contradiction {
  /** The accepted doc that opposes the subject. */
  slug: string;
  reason: string;
}

/** A judged timeline pair: `newerSlug` updates `olderSlug`. */
export interface Supersession {
  olderSlug: string;
  newerSlug: string;
  /** The judge's confidence, 0..1 (0 when it gave none). */
  confidence: number;
  reason: string;
}

/**
 * detectContradictions' result: the confirmed contradictions, carrying the
 * judged supersessions alongside so flagContradictions — handed the same value
 * — applies both.
 */
export type DetectedContradictions = Contradiction[] & { supersessions?: Supersession[] };

/** Thrown by detectContradictions when every candidate it tried to judge hit a
 *  judge error, so the subject reads as unchecked rather than clean. */
export class ContradictionJudgeError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`contradiction judge failed for every candidate: ${errors.join("; ")}`);
  }
}

export interface ContradictionDeps {
  search: (projectId: string, query: string, options?: SearchOptions) => Promise<SearchResult[]>;
  readAcceptedDoc: (projectId: string, slug: string) => Promise<KnowledgeDocFile | null>;
  judge: ContradictionJudge;
  /**
   * A candidate's current verdict + disputes, read from the index. Load-bearing
   * for excluding a "superseded" candidate — the tombstoned loser of an
   * already-resolved contradiction (roadmap r7). Search recalls a doc regardless
   * of verdict, and the accepted `.md` stays on disk, so without this guard a
   * re-verified-clean winner would re-recall its retired loser, the judge would
   * re-confirm the (still-on-disk) opposition, and the resolver would re-supersede
   * it every cron cycle — perpetual churn. Optional so a test that doesn't care
   * omits it; production passes the backend's getDoc.
   */
  getDoc?: (projectId: string, slug: string) => DocVerdictState | null;
  /**
   * Whether the backing search fuses an embedding arm. This picks the candidate
   * floor's scale (see CONTRADICTION_CANDIDATE_FLOOR): rawScore's achievable
   * ceiling collapses from ~1.0 to `textWeight` (0.4) when embeddings are off, so
   * one absolute floor cannot serve both modes. Omitted/undefined reads as the
   * hybrid scale — production callers pass the backend's real state.
   */
  embeddingsEnabled?: boolean;
}

/**
 * Minimum fused-search similarity for a hit to be worth judging in HYBRID
 * (embedding-backed) mode. Below this two docs share too little to be about the
 * same claim, so the (spawn-a-model) judge is not worth running. Read off the
 * same fused rawScore the near-dup gate uses; a moderate floor, because an
 * opposing doc (same subject, opposite conclusion) recalls near — but well below
 * a near-duplicate of — the subject. Calibrated on the default 0.4/0.6
 * text/embedding weights, where rawScore's ceiling is ~1.0, so 0.5 is roughly
 * half the achievable relevance.
 */
export const CONTRADICTION_CANDIDATE_FLOOR = 0.5;

/**
 * The candidate floor for TEXT-ONLY (no embedding provider) deployments. There
 * the fused rawScore is `textScore * textWeight` with embeddingScoreRaw = 0, and
 * textScore is max-normalized to 1.0 for the best FTS hit — so rawScore can never
 * exceed textWeight (0.4 by default), strictly below the hybrid floor of 0.5. A
 * single 0.5 floor would gate out EVERY hit and silently disable contradiction
 * detection in the zero-config default deployment (index.ts auto-detects and
 * supports text-only). This floor mirrors the hybrid floor's "roughly half the
 * achievable relevance" on the FTS-only ceiling (~0.5 * 0.4), so a moderately
 * relevant FTS hit — a hit whose BM25 is at least half the top hit's — still
 * clears it and reaches the judge. Calibrated on the default weights, the same
 * discipline the hybrid floor and NEAR_DUP_THRESHOLD follow.
 */
export const CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY = 0.2;

/** Default search recall breadth for contradiction candidates. */
const CONTRADICTION_SEARCH_LIMIT = 5;
/** Default hard cap on judge (i.e. `claude`) spawns per subject, so a subject
 *  that recalls many related docs can't fan out into an unbounded batch. */
const MAX_JUDGED = 3;

/**
 * Per-call recall/judge overrides. Both default to the accept-time constants
 * above; a caller that wants wider recall than accept-time used (a graph-wide
 * sweep looking for opposing docs the top-CONTRADICTION_SEARCH_LIMIT recall
 * ranked too low to judge) raises `searchLimit`, still bounded by `maxJudged`.
 */
export interface DetectContradictionOptions {
  searchLimit?: number;
  maxJudged?: number;
}

/**
 * Finds accepted docs that CONTRADICT `subject`. Pulls the docs most similar to
 * it (embedding-backed recall — an opposing doc is ABOUT the same thing, so it
 * recalls near the subject), skips the subject itself and anything below the
 * candidate floor, reads each candidate's authoritative body, and asks the judge
 * to confirm genuine opposition. Judges at most `maxJudged` candidates to bound
 * model spawns. Returns every confirmed contradiction, with each judged
 * supersession on `supersessions`; a complementary or consistent pair adds
 * nothing. A candidate whose judge errored is left unjudged, and when that is
 * every judged candidate it throws ContradictionJudgeError.
 */
export async function detectContradictions(
  deps: ContradictionDeps,
  projectId: string,
  subject: DocText,
  excludeSlugs: readonly string[] = [],
  options: DetectContradictionOptions = {}
): Promise<DetectedContradictions> {
  const searchLimit = options.searchLimit ?? CONTRADICTION_SEARCH_LIMIT;
  const maxJudged = options.maxJudged ?? MAX_JUDGED;
  const exclude = new Set([subject.slug, ...excludeSlugs]);
  const query = `${subject.title}\n${subject.body}`.slice(0, 2000);
  const hits = await deps.search(projectId, query, {
    corpus: "project",
    limit: searchLimit,
  });
  // In text-only mode rawScore is capped at textWeight (0.4 < the 0.5 hybrid
  // floor), so a single floor would gate out every hit and never run the judge;
  // pick the floor that matches the search's actual score scale.
  const floor =
    deps.embeddingsEnabled === false
      ? CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY
      : CONTRADICTION_CANDIDATE_FLOOR;
  const found: DetectedContradictions = [];
  const supersessions: Supersession[] = [];
  const errors: string[] = [];
  let judged = 0;
  for (const hit of hits) {
    if (judged >= maxJudged) break;
    if (hit.projectId !== projectId || exclude.has(hit.slug)) continue;
    // A playbook is one owner's own method, never a peer of the corpus: it is
    // not judged against other docs, so no resolution can flag or rewrite it,
    // or carry its text into another doc.
    if (hit.sourceKind === PLAYBOOK_SOURCE_KIND) continue;
    const similarity = hit.rawScore ?? hit.score;
    if (similarity < floor) continue;
    // A tombstoned (superseded) candidate is the retired loser of an
    // already-resolved contradiction — skip it before spending a judge spawn, so
    // a clean winner never re-recalls it into a fresh conflict.
    if (deps.getDoc?.(projectId, hit.slug)?.verdict === "superseded") continue;
    const existing = await deps.readAcceptedDoc(projectId, hit.slug);
    if (!existing) continue;
    judged++;
    const judgment = await deps.judge(
      { ...subject, projectId: subject.projectId ?? projectId },
      { slug: hit.slug, title: existing.title, body: existing.body, projectId: hit.projectId }
    );
    if (judgment.error !== undefined) {
      errors.push(`${hit.slug}: ${judgment.error}`);
      continue;
    }
    const relation = judgmentRelation(judgment);
    if (relation === "contradicts") {
      found.push({ slug: hit.slug, reason: judgment.reason });
    } else if (relation === "supersedes" && judgment.newer) {
      supersessions.push({
        olderSlug: judgment.newer === "a" ? hit.slug : subject.slug,
        newerSlug: judgment.newer === "a" ? subject.slug : hit.slug,
        confidence: judgment.confidence ?? 0,
        reason: judgment.reason,
      });
    }
  }
  // Every judged candidate errored: the subject is not known to be coherent, so
  // the caller must not treat it as checked.
  if (judged > 0 && errors.length === judged) throw new ContradictionJudgeError(errors);
  if (supersessions.length > 0) found.supersessions = supersessions;
  return found;
}

// ── Flagging ────────────────────────────────────────────────────────────────

/** Builds the dispute record stored on a doc flagged as contradicting another,
 *  reusing the DraftDispute shape the fact-check pass and the Knowledge tab
 *  already render. `basis` says why this side lost, or that no side could be
 *  chosen. */
export function contradictionDispute(otherSlug: string, reason: string, basis?: string): DraftDispute {
  return {
    claim: formatContradictsClaim(otherSlug),
    finding:
      reason ||
      "An accepted doc states an opposing claim; a human must resolve which is correct.",
    evidence: basis
      ? `Contradiction with ${otherSlug} — ${basis}`
      : `Contradiction with ${otherSlug} — resolve by editing or discarding one of the two docs`,
  };
}

/**
 * The current verdict + disputes a doc carries, as read back from the store,
 * plus the provenance and confidence fields the loser choice reads (all
 * optional; the index's KnowledgeDoc carries them).
 */
export interface DocVerdictState {
  verdict?: string;
  disputes?: DraftDispute[];
  originClass?: string;
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  generatedAt?: string;
}

export interface FlagDeps {
  recordVerdict: (
    projectId: string,
    slug: string,
    verdict: string,
    disputes: unknown[]
  ) => void;
  /**
   * Reads a doc's current verdict + disputes (and provenance) so flagging a doc
   * that ALREADY carries findings folds this contradiction onto them rather than
   * clobbering them, and so the losing side can be chosen. Returns null for a
   * doc with no row.
   */
  getDoc: (projectId: string, slug: string) => DocVerdictState | null;
  now?: () => Date;
}

/** Verdicts whose disputes are human-actionable findings we must never drop when
 *  folding a contradiction onto a doc that already carries them. */
function preservesDisputes(verdict: string | undefined): boolean {
  return verdict === "disputed" || verdict === "contradicted" || isUncheckedVerdict(verdict);
}

/**
 * The verdict + disputes to record on a doc newly found to contradict another,
 * folded onto whatever it already carries. A doc the fact-check already
 * DISPUTED (or a prior contradiction flagged) keeps those findings, with the
 * new dispute(s) appended, deduped by claim so a re-run never stacks
 * duplicates. A "disputed" doc keeps that stronger verdict; otherwise the doc
 * takes `verdict`.
 */
function foldContradiction(
  current: DocVerdictState | null,
  newDisputes: DraftDispute[],
  verdict: "contradicted" | "disputed"
): { verdict: string; disputes: DraftDispute[] } {
  const keep =
    current && preservesDisputes(current.verdict) ? [...(current.disputes ?? [])] : [];
  const disputes = [...keep];
  for (const d of newDisputes) {
    if (!disputes.some((e) => e.claim === d.claim)) disputes.push(d);
  }
  return { verdict: current?.verdict === "disputed" ? "disputed" : verdict, disputes };
}

/** Whether a doc has been verified: an agent doc is published at
 *  UNVERIFIED_CONFIDENCE with no last_verified_at, and only a passing
 *  fact-check stamps one. */
function isVerified(state: DocVerdictState): boolean {
  return !!state.lastVerifiedAt;
}

/** Whether a doc carries a model fact-check finding — not a contradiction edge,
 *  a tombstone, or a git or no-repo note (which are for a human, never weighed). */
function hasFactDispute(state: DocVerdictState): boolean {
  return (state.disputes ?? []).some(
    (d) => parseContradictsClaim(d.claim) === null && !d.claim.startsWith("Superseded by ") && d.origin === undefined
  );
}

/** Confidence gaps smaller than this do not decide a conflict. */
const CONFIDENCE_MARGIN = 0.05;

/**
 * The deterministic choice of which side of a contradiction loses, or null when
 * nothing separates them. In order: a doc whose own fact-check found claims the
 * repository contradicts; an agent-written doc below an owner-written one; an unverified
 * doc below a verified one; lower current confidence; the older doc. Returns
 * the basis so the dispute can say why.
 */
export function chooseLoser(
  a: { slug: string; state: DocVerdictState | null },
  b: { slug: string; state: DocVerdictState | null },
  now: Date = new Date()
): { loser: string; winner: string; basis: string } | null {
  const pick = (loserIsA: boolean, basis: string) =>
    loserIsA
      ? { loser: a.slug, winner: b.slug, basis }
      : { loser: b.slug, winner: a.slug, basis };
  const sa = a.state ?? {};
  const sb = b.state ?? {};
  const factDisputedA = sa.verdict === "disputed" && hasFactDispute(sa);
  const factDisputedB = sb.verdict === "disputed" && hasFactDispute(sb);
  if (factDisputedA !== factDisputedB) {
    return pick(factDisputedA, "this doc's own fact-check found claims the repository contradicts");
  }
  const ownerA = sa.originClass === "owner";
  const ownerB = sb.originClass === "owner";
  if (ownerA !== ownerB) return pick(ownerB, "the other doc is owner-written");
  const verifiedA = isVerified(sa);
  const verifiedB = isVerified(sb);
  if (verifiedA !== verifiedB) return pick(verifiedB, "the other doc is verified and this one is not");
  const confA = deriveConfidence(sa, now);
  const confB = deriveConfidence(sb, now);
  if (confA !== undefined && confB !== undefined && Math.abs(confA - confB) > CONFIDENCE_MARGIN) {
    return pick(confA < confB, `the other doc holds higher confidence (${Math.max(confA, confB).toFixed(2)})`);
  }
  const atA = sa.generatedAt ? Date.parse(sa.generatedAt) : NaN;
  const atB = sb.generatedAt ? Date.parse(sb.generatedAt) : NaN;
  if (Number.isFinite(atA) && Number.isFinite(atB) && atA !== atB) {
    return pick(atA < atB, "the other doc is newer");
  }
  return null;
}

/** The basis a contradiction dispute carries when neither side could be preferred. */
export const UNDECIDED_BASIS = "neither side could be preferred; a human must decide which is correct";

/** Judge confidence a supersession needs before it retires the older doc. */
export const SUPERSEDE_MIN_CONFIDENCE = 0.8;

/**
 * Why a judged supersession may not retire its older doc, or null when it may.
 * It may only when the judge was confident (SUPERSEDE_MIN_CONFIDENCE), the
 * newer doc is verified and itself unflagged, the older doc is not
 * owner-written (retiring an owner's claim needs a human, as in the resolver),
 * and the docs' recorded write times do not put the "newer" doc first.
 */
export function supersessionBlocker(
  s: Supersession,
  older: DocVerdictState | null,
  newer: DocVerdictState | null
): string | null {
  if (s.confidence < SUPERSEDE_MIN_CONFIDENCE) return `judge confidence ${s.confidence.toFixed(2)} is below ${SUPERSEDE_MIN_CONFIDENCE}`;
  if (!newer || !isVerified(newer)) return `${s.newerSlug} is not verified`;
  if (newer.verdict === "disputed" || newer.verdict === "contradicted" || newer.verdict === "superseded") {
    return `${s.newerSlug} is ${newer.verdict}`;
  }
  if (!older) return `${s.olderSlug} has no row`;
  if (older.verdict === "superseded") return `${s.olderSlug} is already superseded`;
  if (older.originClass === "owner") return `${s.olderSlug} is owner-written`;
  const olderAt = older.generatedAt ? Date.parse(older.generatedAt) : NaN;
  const newerAt = newer.generatedAt ? Date.parse(newer.generatedAt) : NaN;
  if (Number.isFinite(olderAt) && Number.isFinite(newerAt) && newerAt < olderAt) {
    return `${s.newerSlug} was written before ${s.olderSlug}`;
  }
  return null;
}

/**
 * Retires the older doc of each supersession that clears supersessionBlocker:
 * verdict "superseded" with a tombstone naming the newer doc, its own
 * fact-check findings kept and its contradiction edges dropped (the same
 * tombstone the resolver writes). A blocked supersession writes nothing — the
 * judgment ledger already holds it. Returns the slugs retired.
 */
export function applySupersessions(
  deps: FlagDeps,
  projectId: string,
  supersessions: readonly Supersession[]
): string[] {
  const retired: string[] = [];
  for (const s of supersessions) {
    const older = deps.getDoc(projectId, s.olderSlug);
    const blocker = supersessionBlocker(s, older, deps.getDoc(projectId, s.newerSlug));
    if (blocker !== null) {
      console.log(`[knowledge-coherence] ${projectId}: ${s.newerSlug} supersedes ${s.olderSlug}, recorded only: ${blocker}`);
      continue;
    }
    const kept = (older?.disputes ?? []).filter((d) => parseContradictsClaim(d.claim) === null);
    deps.recordVerdict(projectId, s.olderSlug, "superseded", [
      ...kept,
      supersededTombstone(s.newerSlug, s.reason || `${s.newerSlug} is a newer account of the same subject.`),
    ]);
    retired.push(s.olderSlug);
  }
  return retired;
}

/**
 * Flags the losing side of each contradiction with `subject` as "contradicted",
 * with a dispute naming the winner; the winner is left as it is. When no side
 * can be chosen (see chooseLoser), both are marked "contradicted" with an
 * undecided conflict marker naming the other — not "disputed", which would
 * hide both from every surface; an undecided pair is admissible with its
 * marker (isVerdictAdmissible). Writes go through the accepted-doc verdict
 * channel (recordDocVerdict), so a flag renders in the Knowledge tab like a
 * re-verification dispute. Each write is FOLDED onto the doc's current
 * verdict/disputes so findings it already carries are kept. Judged
 * supersessions carried on `contradictions` are applied too
 * (applySupersessions). Returns every slug it flagged as contradicting.
 */
export function flagContradictions(
  deps: FlagDeps,
  projectId: string,
  subject: DocText,
  contradictions: DetectedContradictions
): string[] {
  // The SUBJECT may be a tombstoned (superseded) loser when detection ran over a
  // stale snapshot taken before a resolution retired it. Re-flagging it would
  // fold onto its live "superseded" verdict and strip its tombstone, reviving a
  // claim a resolution deliberately retired. Refuse outright.
  if (deps.getDoc(projectId, subject.slug)?.verdict === "superseded") return [];
  const retired = new Set(
    contradictions.supersessions?.length ? applySupersessions(deps, projectId, contradictions.supersessions) : []
  );
  if (retired.has(subject.slug)) return [];
  // Likewise drop any candidate that is a tombstoned loser of an already-resolved
  // contradiction, or was just retired.
  const live = contradictions.filter(
    (c) => !retired.has(c.slug) && deps.getDoc(projectId, c.slug)?.verdict !== "superseded"
  );
  if (live.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  // Collected per slug: one doc may lose to several others in one pass.
  const pending = new Map<string, DraftDispute[]>();
  const add = (slug: string, dispute: DraftDispute) => {
    pending.set(slug, [...(pending.get(slug) ?? []), dispute]);
  };
  for (const c of live) {
    const decision = chooseLoser(
      { slug: subject.slug, state: deps.getDoc(projectId, subject.slug) },
      { slug: c.slug, state: deps.getDoc(projectId, c.slug) },
      now
    );
    if (decision) {
      add(
        decision.loser,
        contradictionDispute(decision.winner, c.reason, `${decision.winner} was kept: ${decision.basis}`)
      );
    } else {
      add(subject.slug, contradictionDispute(c.slug, c.reason, UNDECIDED_BASIS));
      add(c.slug, contradictionDispute(subject.slug, c.reason, UNDECIDED_BASIS));
    }
  }
  const flagged: string[] = [];
  for (const [slug, disputes] of pending) {
    const fold = foldContradiction(deps.getDoc(projectId, slug), disputes, "contradicted");
    deps.recordVerdict(projectId, slug, fold.verdict, fold.disputes);
    flagged.push(slug);
  }
  return flagged;
}

// ── Judge reliability ─────────────────────────────────────────────────────────

/** Judge calls per pair before an error is accepted as the outcome. */
export const JUDGE_MAX_ATTEMPTS = 3;
/** Delay before the first retry; doubled for each later one. */
export const JUDGE_RETRY_BASE_MS = 2_000;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries a judge whose answer is an error, with exponential backoff, up to
 * `attempts` calls. An answered judgment (contradicts or not) returns at once.
 * The last error is returned when every attempt failed. `attempts` on the
 * result counts the calls made.
 */
export function withJudgeRetry(judge: ContradictionJudge, options: RetryOptions = {}): ContradictionJudge {
  const attempts = Math.max(1, options.attempts ?? JUDGE_MAX_ATTEMPTS);
  const base = options.baseDelayMs ?? JUDGE_RETRY_BASE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (a, b) => {
    let last: ContradictionJudgment = { contradicts: false, reason: "", error: "judge not run" };
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(base * 2 ** (i - 1));
      last = await judge(a, b);
      if (last.error === undefined) return { ...last, attempts: (last.attempts ?? 0) + i + 1 };
      if (last.skipped || last.final) return last;
    }
    return { ...last, attempts };
  };
}

/** Wall-clock budget for all the judge calls of one contradiction check. */
export const JUDGE_CHECK_DEADLINE_MS = 3 * 60_000;

/**
 * Bounds the total time one check spends judging: once `totalMs` has passed
 * since the wrapper was made, further pairs are left unjudged — a judge error
 * the judgment ledger records and queues for a later run — rather than each
 * costing up to a full retry cycle. Make one per check, inside withJudgmentLog.
 */
export function withJudgeDeadline(
  judge: ContradictionJudge,
  totalMs: number = JUDGE_CHECK_DEADLINE_MS,
  now: () => number = Date.now
): ContradictionJudge {
  const deadline = now() + totalMs;
  return async (a, b) =>
    now() >= deadline
      ? { contradicts: false, reason: "", error: "judge time budget for this check used up", final: true }
      : judge(a, b);
}

/**
 * Wraps a judge so every outcome lands in the judgment ledger: its relation
 * (contradicts / supersedes / complementary / consistent) when it answered,
 * judge_error with the reason when it could not — and a judge error also
 * queues the subject for re-judging, so the pair is revisited instead of
 * passing as checked. Building it brings the ledger's schema up to date
 * (ensureJudgmentSchema), which also starts the verdict history.
 */
export function withJudgmentLog(judge: ContradictionJudge, db: Database): ContradictionJudge {
  try {
    ensureJudgmentSchema(db);
  } catch (err) {
    console.error("[knowledge-coherence] could not update the judgment schema:", err);
  }
  return async (a, b) => {
    const judgment = await judge(a, b);
    if (!a.projectId || judgment.skipped) return judgment;
    try {
      recordJudgment(db, {
        projectId: a.projectId,
        subjectSlug: a.slug,
        candidateProjectId: b.projectId ?? a.projectId,
        candidateSlug: b.slug,
        outcome: judgment.error !== undefined ? "judge_error" : judgmentRelation(judgment),
        method: "llm",
        reason: judgment.error ?? judgment.reason,
        attempts: judgment.attempts ?? 1,
      });
      if (judgment.error !== undefined) {
        queueRejudge(db, a.projectId, a.slug, `judge error against ${b.slug}: ${judgment.error}`);
      }
    } catch (err) {
      console.error(`[knowledge-coherence] could not log judgment ${a.slug}/${b.slug}:`, err);
    }
    return judgment;
  };
}

// ── Production judge ──────────────────────────────────────────────────────────

const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_TIMEOUT_MS = 60_000;

function buildJudgePrompt(a: DocText, b: DocText): string {
  return `You are classifying how two knowledge-base documents relate. Answer exactly one relation:

- "contradicts": both make a claim about the SAME thing and those claims cannot both be true at the same time (opposite values, opposite directions, "always" vs "never", "use X" vs "do not use X").
- "supersedes": one is a LATER account of the same subject that updates or replaces the other — a plan then its outcome, an old design then the shipped one, a status that moved on. A timeline, not a conflict. Say which document is the newer one.
- "complementary": they cover different facets, steps or cases of one subject, and both can hold.
- "consistent": they agree, or are about different things.

Be strict: choose "contradicts" only when no timeline or difference of scope reconciles the two.

--- DOCUMENT A (${a.slug}) ---
${a.title}

${a.body}
--- END A ---

--- DOCUMENT B (${b.slug}) ---
${b.title}

${b.body}
--- END B ---

Reply with ONLY a JSON object and nothing else:
{"relation": "contradicts"|"supersedes"|"complementary"|"consistent", "newer": "A"|"B"|null, "confidence": <0 to 1>, "reason": "<one sentence naming the claims behind the relation>"}
("newer" names the newer document for "supersedes" and is null otherwise.)`;
}

const RELATIONS: readonly JudgeRelation[] = ["contradicts", "supersedes", "complementary", "consistent"];

/**
 * Parses the judge's reply into a judgment. Reads the `relation` reply, and a
 * bare `{"contradicts": boolean}` reply as contradicts / consistent. A reply
 * with no JSON object, an unknown relation, or neither field is a judge error
 * — unreadable is not "does not contradict".
 */
export function parseJudgeOutput(raw: string): ContradictionJudgment {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const unreadable = (detail: string): ContradictionJudgment => ({
    contradicts: false,
    reason: "",
    error: `unparseable judge reply (${detail})`,
  });
  if (start === -1 || end <= start) return unreadable("no JSON object");
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      relation?: unknown;
      newer?: unknown;
      confidence?: unknown;
      contradicts?: unknown;
      reason?: unknown;
    };
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    if (parsed.relation !== undefined) {
      const relation = typeof parsed.relation === "string" ? parsed.relation.trim().toLowerCase() : "";
      if (!RELATIONS.includes(relation as JudgeRelation)) return unreadable("unknown `relation`");
      const judgment: ContradictionJudgment = {
        contradicts: relation === "contradicts",
        relation: relation as JudgeRelation,
        reason,
        method: "llm",
      };
      if (typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1) {
        judgment.confidence = parsed.confidence;
      }
      const newer = typeof parsed.newer === "string" ? parsed.newer.trim().toLowerCase() : "";
      if (relation === "supersedes" && (newer === "a" || newer === "b")) judgment.newer = newer;
      return judgment;
    }
    if (typeof parsed.contradicts !== "boolean") return unreadable("no `relation` or boolean `contradicts`");
    return { contradicts: parsed.contradicts, reason, method: "llm" };
  } catch {
    return unreadable("invalid JSON");
  }
}

/** A short, single-line excerpt of process output for an error reason. */
function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * One call of the production contradiction judge: a read-only Haiku `claude`
 * comparing two doc texts, same trust level and feed-isolation handling as
 * draft-verify (the reserved cwd plus dropping the `user` setting source so
 * global hooks never fire and this never registers as a session). Needs no
 * repository — it reasons over the two texts alone — so it runs with no tools
 * and no added dir. Never throws; a failed spawn, a nonzero exit, an `is_error`
 * reply (e.g. a Bedrock 403), a timeout or an unreadable reply resolves to a
 * judgment carrying `error`.
 */
export async function runClaudeContradictionJudgeOnce(
  a: DocText,
  b: DocText
): Promise<ContradictionJudgment> {
  const failed = (error: string): ContradictionJudgment => ({ contradicts: false, reason: "", error });
  try {
    ensureInternalCwd(DRAFT_VERIFY_CWD);
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        buildJudgePrompt(a, b),
        "--model",
        JUDGE_MODEL,
        // No tools at all. The judge reasons over the two doc texts in the prompt
        // and needs nothing else — and its inputs are UNTRUSTED corpus bodies
        // (agent-distilled from arbitrary analyzed repos), so a prompt-injection in
        // a doc body must never reach Bash/Write/Edit. `--tools ""` disables the
        // whole built-in toolset, so even with permissions bypassed below there is
        // nothing to bypass — the stricter analog of draft-verify's read-only list.
        "--tools",
        "",
        "--permission-mode",
        "bypassPermissions",
        // Drop the user setting source so global hooks never fire — otherwise this
        // subprocess registers as a phantom session in Standup's own feed — and
        // --strict-mcp-config makes the resulting lack of MCP explicit.
        "--setting-sources",
        "project",
        ...headlessSettingsArgs(),
        "--strict-mcp-config",
        "--output-format",
        "json",
      ],
      { cwd: DRAFT_VERIFY_CWD, stdout: "pipe", stderr: "pipe", env: withoutSlotEnv() }
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, JUDGE_TIMEOUT_MS);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      if (timedOut) return failed(`timed out after ${JUDGE_TIMEOUT_MS / 1000}s`);
      if (proc.exitCode !== 0) {
        return failed(`exit ${proc.exitCode}: ${excerpt(stderr || stdout) || "no output"}`);
      }
      let parsed: { result?: string; is_error?: boolean };
      try {
        parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      } catch {
        return failed(`unreadable CLI output: ${excerpt(stdout) || "empty"}`);
      }
      if (parsed.is_error) return failed(`judge reported an error: ${excerpt(parsed.result ?? "")}`);
      if (!parsed.result) return failed("empty judge reply");
      return parseJudgeOutput(parsed.result);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return failed(`spawn failed: ${(err as Error).message}`);
  }
}

/** The production contradiction judge: runClaudeContradictionJudgeOnce with
 *  bounded retries on error (see withJudgeRetry). */
export const runClaudeContradictionJudge: ContradictionJudge = withJudgeRetry(
  runClaudeContradictionJudgeOnce
);
