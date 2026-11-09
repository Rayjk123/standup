import type { Database } from "bun:sqlite";
import {
  KnowledgeStore,
  LocalMarkdownBackend,
  contradictionDisputes,
  parseContradictsClaim,
  isContradictionEndpoint,
  isRejudgeQueued,
  PLAYBOOK_SOURCE_KIND,
  settleRejudge,
  updateDocFrontmatter,
  INITIAL_CONFIDENCE,
  getVerificationState,
  recordVerificationAttempt,
  type KnowledgeDoc,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "@standup/knowledge";
import { existsSync } from "fs";
import { getSetting, setSetting, getKnowledgeResolution, getProjects } from "@standup/store";
import { verifyDraft, type DraftVerification } from "./draft-verify.js";
import { retryPendingVerifications } from "./knowledge-publish-verify.js";
import {
  dbVerificationInputs,
  isCorpusProject,
  repoMayServeProject,
  resolveVerificationRepo,
  sourceSessionProject,
} from "./knowledge-verify-repos.js";
import { primaryRepoPath } from "./knowledge-staleness.js";
import {
  runClaudeContradictionJudgeOnce,
  withJudgeRetry,
  withJudgmentLog,
  type ContradictionJudge,
  type ContradictionJudgment,
  type DocText,
} from "./knowledge-coherence.js";
import {
  buildResolveDeps,
  resolveContradiction,
  resolveContradictionsAsync,
  resolutionId,
  runClaudeContradictionResolver,
  type ContradictionResolver,
  type ResolveDeps,
} from "./knowledge-resolve.js";
import {
  runReverifyContradictionPass,
  type ReverifyCoherenceDeps,
} from "./knowledge-reverify.js";
import type { KnowledgeSync } from "./knowledge-sync.js";
import { deferForHostPressure } from "./host-headroom.js";

/**
 * Nightly graph-wide contradiction sweep + backfill.
 *
 * The accept-time and daily-reverify triggers both miss a whole class of flagged
 * pairs: accept-time only fires the resolver on a NEW accept, and the reverify
 * cron only hands the resolver docs it just found CLEAN — so a pair already at
 * verdict "contradicted" is never revisited, and the stranded pairs sit flagged
 * with no resolution row forever. This pass closes both holes, once a night, in
 * the SAME collector process as accept-time/reverify so the resolver's process-
 * local idempotency (inFlightPairs + the order-independent resolutionId under
 * INSERT OR IGNORE) still applies:
 *
 * - BACKFILL: enumerate every pair currently flagged as contradicting (a doc
 *   carrying a `Contradicts <slug>` dispute — the same signal deriveEdges projects
 *   into a `contradicts` graph edge) that has NO resolution ledger row of any
 *   status, and hand each to the existing resolver so the stranded pairs finally
 *   resolve or route to needs-review.
 * - MISSED-DETECTION: run the existing detect→flag→resolve pass over accepted docs
 *   that carry no contradiction flag yet, with WIDER search recall than accept-time
 *   used, to surface opposing docs the accept-time top-K recall ranked too low to
 *   judge. Detection is blocked per project and shortlisted by the existing search
 *   recall — never an O(n^2) all-pairs judge fan-out.
 *
 * Everything reuses the shipped detection (detectContradictions via
 * runReverifyContradictionPass) and resolution (resolveContradiction) code; this
 * module only enumerates, bounds, and gates. It is DEFAULT ON — it runs unless
 * explicitly disabled by a falsy env flag or settings key.
 */

/** Poll interval: nightly. A per-day settings gate (see {@link lastRunKey}) keeps
 *  a `bun --watch` restart mid-day from re-running the sweep. */
const DEFAULT_INTERVAL_MS = 86_400_000; // 24h
/** Delay before the first kick so the server binds and the initial syncAll
 *  settles before a sweep reads the corpus. */
const INITIAL_DELAY_MS = 60_000;
/** Default per-run budget of judge + resolver `claude` spawns. The whole run
 *  stops spending model spawns once this is exhausted; remaining work is logged,
 *  never silently truncated. */
export const DEFAULT_MAX_SPAWNS = 50;
/** Default per-run cap on the number of flagged pairs the backfill hands to the
 *  resolver — a coarse second bound on top of the spawn budget. */
export const DEFAULT_MAX_PAIRS = 100;
/** Default cap on knowledge-change feed emissions per run, so a first-sweep spike
 *  of needs-review resolutions can't flood the feed. */
export const DEFAULT_MAX_FEED_EMITS = 10;
/** Wider recall than accept-time's CONTRADICTION_SEARCH_LIMIT (5), so the sweep
 *  surfaces opposing docs the accept-time top-K ranked too low to judge. */
export const DEFAULT_DETECT_SEARCH_LIMIT = 12;

/** Env flag gating the sweep (DEFAULT ON; a falsy value opts out). */
export const NIGHTLY_SWEEP_ENV = "STANDUP_KB_NIGHTLY_SWEEP";
/** Settings key gating the sweep (DEFAULT ON; a falsy value opts out), an
 *  alternative to the env flag. */
export const NIGHTLY_SWEEP_SETTING_KEY = "knowledge.nightly_sweep";

const NIGHTLY_SWEEP_INTERVAL_ENV = "STANDUP_KB_NIGHTLY_SWEEP_INTERVAL_MS";
const NIGHTLY_SWEEP_MAX_SPAWNS_ENV = "STANDUP_KB_NIGHTLY_SWEEP_MAX_SPAWNS";
const NIGHTLY_SWEEP_MAX_PAIRS_ENV = "STANDUP_KB_NIGHTLY_SWEEP_MAX_PAIRS";

/** The per-run daily gate key — deliberately distinct from the reverify cron's
 *  `knowledge_reverify_last_run:*` so the sweep neither reads nor writes another
 *  cron's gate and can't starve or be starved by it. */
export const AUDIT_LAST_RUN_KEY = "knowledge_graph_audit_last_run";

/** Persisted monotonic per-night counter that rotates the project the sweep starts
 *  at. `getAllDocs()` returns the same (project_id, slug) order every night, so
 *  under a bounded budget a fixed order would let the alphabetically-first project
 *  perpetually starve the same later ones; rotating the start each night guarantees
 *  every project is the start within N nights (see {@link rotateProjectsByCursor}). */
export const AUDIT_CURSOR_KEY = "knowledge_graph_audit_cursor";

/** Settings-key prefix for a doc's last missed-detection sweep date. Detection is
 *  otherwise read-only, so a per-doc frontmatter write (as the reverify cron does)
 *  would be far too heavy; the sweep date lives in settings instead. */
const AUDIT_DETECT_SWEPT_PREFIX = "knowledge_graph_audit_detect:";

/** A doc swept by missed-detection within this many days is NOT re-judged — a
 *  per-doc recency backoff mirroring the reverify cron's REVERIFY_COOLDOWN_DAYS.
 *  Without it the sweep re-searches and re-judges every unflagged doc every night,
 *  re-spending a bounded budget confirming the same clean docs instead of advancing
 *  to docs it has never checked. */
export const AUDIT_DETECT_COOLDOWN_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** The settings key holding a doc's last missed-detection sweep date. */
function detectSweptKey(projectId: string, slug: string): string {
  return `${AUDIT_DETECT_SWEPT_PREFIX}${projectId}/${slug}`;
}

/**
 * Whether a doc is still inside the missed-detection cooldown. A doc is in
 * cooldown only when its persisted swept stamp is BOTH within `cooldownMs` of
 * `now` AND at or after the doc's `updatedAt` — an edit after the sweep
 * (updatedAt newer than the stamp) re-opens the doc for re-checking on the next
 * sweep, since the edit may have introduced a contradiction only the sweep's
 * wider recall would surface. An absent or unparseable stamp is never in
 * cooldown. Pure, so the edit-aware decision is unit-testable.
 */
export function inDetectCooldown(
  lastSwept: string | null,
  updatedAt: Date,
  now: Date,
  cooldownMs: number
): boolean {
  if (!lastSwept) return false;
  const ms = Date.parse(lastSwept);
  if (!Number.isFinite(ms)) return false;
  return now.getTime() - ms < cooldownMs && ms >= updatedAt.getTime();
}

/** Parses the persisted rotation cursor, defaulting a missing/negative/non-numeric
 *  value to 0 so a corrupt setting can never poison the rotation with NaN. */
function parseCursorSetting(value: string | null): number {
  if (value == null) return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Parses a positive integer from an env value, falling back to `fallback` for an
 *  unset, non-numeric, or non-positive value — so a malformed override can never
 *  silently unbound the spawn budget (an NaN limit would let every spawn through). */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function todayLocalIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isTruthyFlag(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes" || s === "enabled";
}

function isFalsyFlag(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no" || s === "disabled";
}

/**
 * Whether the nightly sweep is enabled. DEFAULT ON: with neither the env flag nor
 * the settings key set, it runs — the sweep is the only trigger that revisits
 * already-flagged pairs, so leaving it off strands resolved winners and unresolved
 * contradictions forever. An explicit env off-value (`off`/`0`/`false`) hard-disables
 * it even if the settings key is on, so an operator can always kill the sweep from
 * the environment; a falsy settings value disables it when the env flag is unset.
 */
export function isNightlySweepEnabled(
  env: string | undefined,
  setting: string | null
): boolean {
  if (isFalsyFlag(env)) return false;
  if (isTruthyFlag(env)) return true;
  if (isFalsyFlag(setting)) return false;
  return true;
}

/** An unordered flagged pair, slugs sorted so `(a,b)` and `(b,a)` collapse to one. */
export interface FlaggedPair {
  a: string;
  b: string;
}

function pairId(a: string, b: string): string {
  return [a, b].sort().join(" ");
}

/**
 * Every unordered pair currently flagged as contradicting within one project's
 * docs, read off the `Contradicts <slug>` disputes the coherence pass wrote (the
 * same signal deriveEdges turns into a `contradicts` graph edge). A pair is
 * included only when BOTH endpoints are live accepted docs and NEITHER is a
 * tombstoned (superseded) loser of an already-resolved conflict — a superseded
 * endpoint means the pair is already resolved, so re-handing it to the resolver
 * would only be skipped. Deduped so a mutual flag surfaces once.
 */
export function collectFlaggedPairs(docs: KnowledgeDoc[]): FlaggedPair[] {
  const bySlug = new Map<string, KnowledgeDoc>();
  for (const doc of docs) bySlug.set(doc.slug, doc);

  const seen = new Set<string>();
  const pairs: FlaggedPair[] = [];
  for (const doc of docs) {
    if (doc.verdict === "superseded") continue;
    for (const dispute of contradictionDisputes(doc)) {
      const other = parseContradictsClaim(dispute.claim);
      if (!other) continue;
      const otherDoc = bySlug.get(other);
      if (!otherDoc || otherDoc.verdict === "superseded") continue;
      const id = pairId(doc.slug, other);
      if (seen.has(id)) continue;
      seen.add(id);
      const [a, b] = [doc.slug, other].sort();
      pairs.push({ a, b });
    }
  }
  return pairs;
}

/** The backfill's pair selection: flagged pairs with NO resolution row yet,
 *  capped at `maxPairs`. `capped` is how many unresolved pairs were dropped by
 *  the cap so the caller can log what it skipped. */
export interface BackfillSelection {
  pairs: FlaggedPair[];
  capped: number;
}

/**
 * Selects the flagged pairs a backfill should resolve: pairs that carry a live
 * contradiction flag but have NO row in the resolutions ledger under any status.
 * `hasResolution` is the ledger lookup (project already bound), keyed on the same
 * stable id the resolver writes. A pair that already has a resolution row — applied
 * OR needs_review — is dropped, so the backfill never re-resolves a settled pair or
 * re-notifies a pending one. The result is capped at `maxPairs`.
 */
export function selectBackfillPairs(
  docs: KnowledgeDoc[],
  hasResolution: (a: string, b: string) => boolean,
  maxPairs: number
): BackfillSelection {
  const flagged = collectFlaggedPairs(docs);
  const unresolved = flagged.filter((p) => !hasResolution(p.a, p.b));
  const pairs = unresolved.slice(0, Math.max(0, maxPairs));
  return { pairs, capped: unresolved.length - pairs.length };
}

/**
 * A per-run cap on `claude` spawns (contradiction judges + resolvers combined).
 * `tryConsume` claims one spawn slot and returns whether it was available; once
 * the budget is exhausted it returns false and counts the miss so the run can log
 * how much it skipped. Both wrappers below share ONE budget, so the whole night's
 * model spend is bounded regardless of how detection and resolution interleave.
 */
export interface SpawnBudget {
  readonly limit: number;
  /** True (and a slot consumed) while budget remains; false once exhausted. */
  tryConsume(): boolean;
  remaining(): number;
  spawned(): number;
  skipped(): number;
}

export function makeSpawnBudget(limit: number): SpawnBudget {
  let used = 0;
  let skipped = 0;
  return {
    limit,
    tryConsume() {
      if (used >= limit) {
        skipped++;
        return false;
      }
      used++;
      return true;
    },
    remaining() {
      return Math.max(0, limit - used);
    },
    spawned() {
      return used;
    },
    skipped() {
      return skipped;
    },
  };
}

/**
 * Wraps a contradiction judge so it only spawns a model while the shared budget
 * has room; once exhausted it answers with an error WITHOUT spawning, so the
 * pair stays unjudged (never read as "does not contradict" and never flagged)
 * and the subject is left for the next run.
 */
export function budgetedJudge(judge: ContradictionJudge, budget: SpawnBudget): ContradictionJudge {
  return async (a: DocText, b: DocText): Promise<ContradictionJudgment> => {
    if (!budget.tryConsume()) {
      return { contradicts: false, reason: "", error: "spawn budget exhausted", skipped: true };
    }
    return judge(a, b);
  };
}

/**
 * Wraps a contradiction resolver so it only spawns a model while the shared budget
 * has room; once exhausted it returns null WITHOUT spawning — the resolver's own
 * "cannot decide" signal, which leaves the pair flagged for the next run rather
 * than mutating anything.
 */
export function budgetedResolver(resolve: ContradictionResolver, budget: SpawnBudget): ContradictionResolver {
  return async (input) => {
    if (!budget.tryConsume()) return null;
    return resolve(input);
  };
}

/** Wraps a feed emitter so at most `max` items are surfaced per run; further
 *  emits are suppressed and counted, so a first-sweep spike of needs-review
 *  resolutions can't flood the feed. */
function makeRateLimitedFeed<A extends unknown[]>(
  emit: ((...args: A) => void) | undefined,
  max: number
): { emit: (...args: A) => void; suppressed: () => number } {
  let emitted = 0;
  let suppressed = 0;
  return {
    emit: (...args: A) => {
      if (!emit) return;
      if (emitted >= max) {
        suppressed++;
        return;
      }
      emitted++;
      emit(...args);
    },
    suppressed: () => suppressed,
  };
}

/** The injected seams the backfill phase needs — the resolver wiring, the ledger
 *  lookup, the shared budget, and the pair cap. All are the SAME seams the
 *  accept-time and reverify paths use, so the sweep adds no new resolution logic. */
export interface BackfillDeps {
  resolveDeps: ResolveDeps;
  /** Ledger lookup for one pair (project already bound). */
  hasResolution: (a: string, b: string) => boolean;
  budget: SpawnBudget;
  maxPairs: number;
}

export interface BackfillResult {
  /** Flagged-but-unresolved pairs selected for backfill. */
  selected: number;
  applied: number;
  review: number;
  /** Pairs not resolved this run: dropped by the pair cap, the spawn budget, or the
   *  resolver's own idempotency short-circuits (already resolved / in flight). */
  skipped: number;
}

/**
 * Backfill for one project: hand every stranded flagged pair (a live contradiction
 * flag with NO ledger row) to the SAME resolveContradiction the accept/reverify
 * paths use — its inFlightPairs lock and getExistingResolution short-circuit make a
 * double-fire on an in-flight or already-resolved pair a no-op. Stops consuming the
 * budget once it is exhausted; the counts returned say exactly what was skipped.
 */
export async function runBackfillForProject(
  projectId: string,
  docs: KnowledgeDoc[],
  deps: BackfillDeps
): Promise<BackfillResult> {
  const selection = selectBackfillPairs(docs, deps.hasResolution, deps.maxPairs);
  let applied = 0;
  let review = 0;
  let skipped = selection.capped;
  for (const pair of selection.pairs) {
    // No model spawn left — stop resolving and count the rest as skipped rather
    // than spinning through loadClaim/grounding for pairs we can't judge.
    if (deps.budget.remaining() <= 0) {
      skipped++;
      continue;
    }
    const outcome = await resolveContradiction(deps.resolveDeps, projectId, pair.a, pair.b);
    if (outcome.status === "applied") applied++;
    else if (outcome.status === "needs-review") review++;
    else skipped++;
  }
  return { selected: selection.pairs.length, applied, review, skipped };
}

/** The injected seams the missed-detection phase needs — the coherence wiring, the
 *  shared budget, the recall breadth, and an OPTIONAL per-doc cooldown so a bounded
 *  budget isn't re-spent re-judging the same clean docs every night. */
export interface DetectionDeps {
  coherence: ReverifyCoherenceDeps;
  budget: SpawnBudget;
  detectSearchLimit: number;
  /** True to skip a subject still in the missed-detection cooldown — swept within
   *  the window AND not edited since (see {@link inDetectCooldown}). `updatedAt`
   *  is the subject's last-edit time, so an edit after the sweep re-opens it.
   *  Absent → no cooldown (every eligible subject is a candidate). */
  inCooldown?: (slug: string, updatedAt: Date) => boolean;
  /** Record that a subject was swept this run, for the cooldown. Absent → no-op. */
  markSwept?: (slug: string) => void;
}

export interface DetectionResult {
  /** Docs whose detection genuinely completed this run (and were marked swept). */
  subjects: number;
  /** Docs NOT swept — dropped by the spawn budget, the per-doc cooldown, a live
   *  "superseded"/endpoint verdict written after the snapshot was taken, or a
   *  detection that errored (a transient search/judge failure leaves the subject
   *  eligible next run rather than entering cooldown). */
  skipped: number;
}

/**
 * Missed-detection for one project: run the existing detect→flag→resolve pass over
 * docs that carry no contradiction flag yet (backfill owns the flagged ones), with
 * wider recall than accept-time used. Each subject's LIVE verdict is re-read before
 * it is judged: `docs` is a snapshot taken before backfill ran, so a doc backfill
 * (or an earlier detached resolution) tombstoned since reads "superseded" now —
 * feeding it to detection would re-recall its still-on-disk opposing doc and the
 * re-flag would strip the tombstone, reviving a claim a resolution retired. The live
 * re-read also skips a subject an earlier subject's detection this run has since
 * flagged (now a contradiction endpoint the backfill phase owns), mirroring the
 * snapshot's own superseded/endpoint subject filter. A per-doc cooldown
 * lets a bounded budget flow to docs not yet checked instead of re-judging clean
 * ones nightly. Detection's search recall shortlists each subject's candidates —
 * never an all-pairs judge fan-out. Stops consuming the budget once it is exhausted.
 */
export async function runDetectionForProject(
  projectId: string,
  docs: KnowledgeDoc[],
  deps: DetectionDeps
): Promise<DetectionResult> {
  // A playbook is one owner's own method, never weighed against the corpus
  // (knowledge-coherence.ts skips it as a candidate too).
  const subjects = docs.filter(
    (d) => d.verdict !== "superseded" && !isContradictionEndpoint(d) && d.sourceKind !== PLAYBOOK_SOURCE_KIND
  );
  let processed = 0;
  let skipped = 0;
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i]!;
    if (deps.budget.remaining() <= 0) {
      // Everything from here on (this subject included) is skipped for budget.
      skipped += subjects.length - i;
      break;
    }
    // A doc still in the cooldown steps aside (no spawn) so the budget flows to
    // docs not yet checked, rather than re-judging the same unchanged clean docs.
    // An edit since the last sweep re-opens the doc (see inDetectCooldown).
    if (deps.inCooldown?.(subject.slug, subject.updatedAt)) {
      skipped++;
      continue;
    }
    // Re-read the LIVE doc (see the doc comment) and re-apply the snapshot's subject
    // guard to it: a subject a backfill (or a detached resolution) tombstoned since
    // the snapshot reads "superseded" now — re-flagging it would strip its tombstone —
    // and a subject an EARLIER subject's detection this run has since flagged is now a
    // contradiction endpoint owned by the backfill phase, so re-judging it only
    // re-spends the budget. Both mirror the snapshot filter above.
    const live = deps.coherence.backend.getDoc(projectId, subject.slug);
    if (live && (live.verdict === "superseded" || isContradictionEndpoint(live))) {
      skipped++;
      continue;
    }
    const completed = await runReverifyContradictionPass(deps.coherence, projectId, [subject], {
      searchLimit: deps.detectSearchLimit,
    });
    // Mark swept (entering the cooldown) ONLY when detection genuinely completed.
    // runReverifyContradictionPass swallows a per-doc search/judge error and still
    // returns, so gating on its completion signal keeps a subject whose check
    // errored eligible on the next run instead of suppressing it for the window.
    if (completed.includes(subject.slug)) {
      deps.markSwept?.(subject.slug);
      processed++;
    } else {
      skipped++;
    }
  }
  return { subjects: processed, skipped };
}

/**
 * Rotates a fixed project ordering so successive nights start at a different
 * project. `getAllDocs()` returns the same (project_id, slug) order every night, so
 * without rotation a budget-exhausting early project would perpetually starve the
 * same later projects. `cursor` is a monotonic per-night counter; the start index is
 * `cursor mod N`, so over N nights every project is the start at least once. A
 * negative or non-finite cursor reads as 0. Pure, so the rotation is unit-testable.
 */
export function rotateProjectsByCursor<T>(ids: T[], cursor: number): T[] {
  const n = ids.length;
  if (n === 0) return ids;
  const c = Number.isFinite(cursor) ? Math.trunc(cursor) : 0;
  const start = ((c % n) + n) % n;
  return [...ids.slice(start), ...ids.slice(0, start)];
}

/** The seams the whole-graph audit needs. `hasResolution`/`inCooldown`/`markSwept`
 *  are project-aware (the DB rows are keyed by project + slug). */
export interface GraphAuditDeps {
  resolveDeps: ResolveDeps;
  coherence: ReverifyCoherenceDeps;
  hasResolution: (projectId: string, a: string, b: string) => boolean;
  budget: SpawnBudget;
  maxPairs: number;
  detectSearchLimit: number;
  /** Monotonic per-night rotation counter (persisted); rotates the project start. */
  cursor: number;
  inCooldown?: (projectId: string, slug: string, updatedAt: Date) => boolean;
  markSwept?: (projectId: string, slug: string) => void;
}

export interface GraphAuditResult {
  projectsBackfilled: number;
  projectsDetected: number;
  backfillApplied: number;
  backfillReview: number;
  backfillSkipped: number;
  detectionSubjects: number;
  /** Projects reached by NEITHER phase because the budget was already spent. */
  projectsSkipped: number;
  /** The cursor to persist for the next night (this night's + 1). */
  nextCursor: number;
}

/**
 * Audits the whole graph in TWO global phases under ONE shared spawn budget:
 *
 *  1. BACKFILL across EVERY project first — resolving the stranded, already-flagged
 *     pairs is the sweep's PRIMARY goal, so it gets the budget before any project's
 *     speculative missed-detection. Enforcing backfill-before-detection only WITHIN
 *     a project (the prior shape) let an early project's detection drain the whole
 *     budget and permanently starve every later project's backfill.
 *  2. MISSED-DETECTION across EVERY project (a secondary goal) with whatever budget
 *     remains, bounded per doc by the cooldown so it isn't re-spent re-judging clean
 *     docs each night.
 *
 * Projects are visited in a cursor-rotated order each night (rotateProjectsByCursor)
 * so a budget-exhausting early project can't perpetually starve the same later ones.
 * Per-project failures are isolated so one bad project never aborts the sweep.
 */
export async function runGraphAudit(
  byProject: Map<string, KnowledgeDoc[]>,
  deps: GraphAuditDeps
): Promise<GraphAuditResult> {
  const order = rotateProjectsByCursor([...byProject.keys()], deps.cursor);
  const totals: GraphAuditResult = {
    projectsBackfilled: 0,
    projectsDetected: 0,
    backfillApplied: 0,
    backfillReview: 0,
    backfillSkipped: 0,
    detectionSubjects: 0,
    projectsSkipped: 0,
    nextCursor: deps.cursor + 1,
  };
  const backfilled = new Set<string>();
  const detected = new Set<string>();

  // PHASE 1 — backfill across ALL projects first (the primary goal).
  for (const projectId of order) {
    if (deps.budget.remaining() <= 0) break;
    try {
      const r = await runBackfillForProject(projectId, byProject.get(projectId)!, {
        resolveDeps: deps.resolveDeps,
        hasResolution: (a, b) => deps.hasResolution(projectId, a, b),
        budget: deps.budget,
        maxPairs: deps.maxPairs,
      });
      backfilled.add(projectId);
      totals.backfillApplied += r.applied;
      totals.backfillReview += r.review;
      totals.backfillSkipped += r.skipped;
    } catch (err) {
      console.error(`[knowledge-graph-audit] ${projectId} backfill failed:`, err);
    }
  }

  // PHASE 2 — missed-detection across ALL projects with the remaining budget.
  for (const projectId of order) {
    if (deps.budget.remaining() <= 0) break;
    try {
      const r = await runDetectionForProject(projectId, byProject.get(projectId)!, {
        coherence: deps.coherence,
        budget: deps.budget,
        detectSearchLimit: deps.detectSearchLimit,
        inCooldown: deps.inCooldown
          ? (slug, updatedAt) => deps.inCooldown!(projectId, slug, updatedAt)
          : undefined,
        markSwept: deps.markSwept ? (slug) => deps.markSwept!(projectId, slug) : undefined,
      });
      detected.add(projectId);
      totals.detectionSubjects += r.subjects;
    } catch (err) {
      console.error(`[knowledge-graph-audit] ${projectId} detection failed:`, err);
    }
  }

  totals.projectsBackfilled = backfilled.size;
  totals.projectsDetected = detected.size;
  // A project neither phase reached (budget spent before its turn in both).
  totals.projectsSkipped = [...byProject.keys()].filter(
    (p) => !backfilled.has(p) && !detected.has(p)
  ).length;
  return totals;
}

/** Groups docs by their project id, preserving store order within each group. */
function groupByProject(docs: KnowledgeDoc[]): Map<string, KnowledgeDoc[]> {
  const byProject = new Map<string, KnowledgeDoc[]>();
  for (const doc of docs) {
    const arr = byProject.get(doc.projectId) ?? [];
    arr.push(doc);
    byProject.set(doc.projectId, arr);
  }
  return byProject;
}

export interface GraphAuditCronOptions {
  /** Poll interval; env STANDUP_KB_NIGHTLY_SWEEP_INTERVAL_MS overrides. */
  intervalMs?: number;
  /** Per-run judge+resolver spawn budget; env overrides. */
  maxSpawns?: number;
  /** Per-run cap on backfilled pairs; env overrides. */
  maxPairs?: number;
  /** Per-run cap on feed emissions (rate-limit). */
  maxFeedEmits?: number;
  /** Detection recall breadth for the missed-detection sweep. */
  detectSearchLimit?: number;
  embeddingProvider?: EmbeddingProvider | null;
  embeddingConfig?: EmbeddingConfig;
  /** Override the judge for tests; production spawns Haiku. */
  contradictionJudge?: ContradictionJudge;
  /** Override the publish fact-check for tests; production spawns Haiku. */
  publishVerifier?: (slug: string, body: string, repoPath: string, additionalRepos?: string[]) => Promise<DraftVerification>;
  /** Override the resolver for tests; production spawns Haiku. */
  contradictionResolver?: ContradictionResolver;
  /** Surface a flagged/withheld contradiction as a feed line (rate-limited). */
  onContradiction?: (projectId: string, slug: string, title: string, contradicted: string[]) => void;
  /** Injectable clock for the daily gate (tests). */
  now?: () => Date;
}

/** One scheduler tick: the whole graph, once per day, bounded by the spawn budget.
 *  Exported so a test can drive the daily gate + cursor persistence under an
 *  injected {@link GraphAuditCronOptions.now} clock without waiting on the timer. */
export async function tick(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  opts: GraphAuditCronOptions
): Promise<void> {
  const now = opts.now?.() ?? new Date();
  const today = todayLocalIso(now);
  if (getSetting(db, AUDIT_LAST_RUN_KEY) === today) return;

  const maxSpawns =
    opts.maxSpawns ?? parsePositiveInt(process.env[NIGHTLY_SWEEP_MAX_SPAWNS_ENV], DEFAULT_MAX_SPAWNS);
  const maxPairs =
    opts.maxPairs ?? parsePositiveInt(process.env[NIGHTLY_SWEEP_MAX_PAIRS_ENV], DEFAULT_MAX_PAIRS);
  const maxFeedEmits = opts.maxFeedEmits ?? DEFAULT_MAX_FEED_EMITS;
  const detectSearchLimit = opts.detectSearchLimit ?? DEFAULT_DETECT_SEARCH_LIMIT;

  // A fresh budget + feed rate-limit per night. Both wrappers share the ONE budget
  // so judges and resolvers draw from the same pool.
  const budget = makeSpawnBudget(maxSpawns);
  const feed = makeRateLimitedFeed(opts.onContradiction, maxFeedEmits);

  // The backend/resolve/coherence deps are built exactly as startKnowledgeReverifyCron
  // builds them, then the judge and resolver are budget-wrapped so every model spawn
  // this sweep triggers — from either detection or resolution — draws down one pool.
  const backend = new LocalMarkdownBackend(
    db,
    opts.embeddingProvider ?? null,
    opts.embeddingConfig ?? {},
    knowledgeDir
  );

  const resolveDeps = buildResolveDeps({
    db,
    backend,
    knowledgeDir,
    recordDocVerdict: (projectId, slug, verdict, disputes) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes),
    clearDocVerdict: (projectId, slug) => knowledgeSync.clearDocVerdict(projectId, slug),
    syncProject: (projectId) => knowledgeSync.syncProject(projectId),
    resolve: budgetedResolver(
      opts.contradictionResolver ?? runClaudeContradictionResolver,
      budget
    ),
    onNeedsReview: (record) =>
      feed.emit(record.projectId, record.loserSlug, record.loserSlug, [record.winnerSlug]),
    now: opts.now,
  });

  const coherence: ReverifyCoherenceDeps = {
    backend,
    // The budget is charged per model call: the production judge's retries sit
    // outside it, so each attempt draws a slot. A budget cut-off is not a judge
    // failure, so the ledger neither records nor queues it.
    judge: withJudgmentLog(
      opts.contradictionJudge
        ? budgetedJudge(opts.contradictionJudge, budget)
        : withJudgeRetry(budgetedJudge(runClaudeContradictionJudgeOnce, budget)),
      db
    ),
    recordVerdict: (projectId, slug, verdict, disputes) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes),
    onContradiction: (projectId, slug, title, contradicted) =>
      feed.emit(projectId, slug, title, contradicted),
    resolveContradictions: (projectId, subjectSlug, contradictedSlugs) =>
      resolveContradictionsAsync(resolveDeps, projectId, subjectSlug, contradictedSlugs),
  };

  const store = new KnowledgeStore(db);
  const byProject = groupByProject(store.getAllDocs());

  // Per-doc missed-detection cooldown, backed by settings (detection is otherwise
  // read-only). A doc swept within the window is skipped UNLESS it was edited after
  // that sweep, so a bounded budget flows to docs not yet checked (and to freshly
  // edited ones) instead of re-judging the same unchanged clean docs every night.
  const cooldownMs = AUDIT_DETECT_COOLDOWN_DAYS * MS_PER_DAY;

  const result = await runGraphAudit(byProject, {
    resolveDeps,
    coherence,
    hasResolution: (projectId, a, b) =>
      getKnowledgeResolution(db, resolutionId(projectId, a, b)) !== null,
    budget,
    maxPairs,
    detectSearchLimit,
    cursor: parseCursorSetting(getSetting(db, AUDIT_CURSOR_KEY)),
    // A doc queued for re-judging (its verdict came from a judge that could not
    // answer, or a pair of it errored) is never in the cooldown.
    inCooldown: (projectId, slug, updatedAt) =>
      !isRejudgeQueued(db, projectId, slug) &&
      inDetectCooldown(getSetting(db, detectSweptKey(projectId, slug)), updatedAt, now, cooldownMs),
    markSwept: (projectId, slug) => {
      setSetting(db, detectSweptKey(projectId, slug), today);
      settleRejudge(db, projectId, slug);
    },
  });

  console.log(
    `[knowledge-graph-audit] swept ${result.projectsBackfilled} project(s) backfill / ` +
      `${result.projectsDetected} detection: ` +
      `backfill ${result.backfillApplied} applied / ${result.backfillReview} needs-review / ` +
      `${result.backfillSkipped} skipped; detection over ${result.detectionSubjects} doc(s); ` +
      `spawns ${budget.spawned()}/${budget.limit} used, ${budget.skipped()} skipped; ` +
      `${result.projectsSkipped} project(s) skipped for budget; ${feed.suppressed()} feed item(s) suppressed`
  );

  // Agent docs still waiting on a passing fact-check get a bounded retry from
  // what is left of the spawn budget.
  const repoByProject = new Map(
    getProjects(db).map((p) => {
      const repo = primaryRepoPath(p);
      return [p.id, repo && existsSync(repo) ? repo : null] as const;
    })
  );
  const verificationInputs = dbVerificationInputs(db);
  const retried = await retryPendingVerifications(
    {
      verifyDeps: {
        verify: (slug, body, repoPath, additionalRepos) =>
          opts.publishVerifier
            ? opts.publishVerifier(slug, body, repoPath, additionalRepos)
            : verifyDraft(slug, body, repoPath, additionalRepos?.length ? { additionalRepos } : {}),
        readAcceptedDoc: (projectId, slug) => backend.readAcceptedDoc(projectId, slug),
        currentDisputes: (projectId, slug) => backend.getDoc(projectId, slug)?.disputes ?? [],
        stampVerified: async (projectId, slug) => {
          await updateDocFrontmatter(knowledgeDir, projectId, slug, {
            confidence: INITIAL_CONFIDENCE,
            last_verified_at: new Date().toISOString(),
          });
          await knowledgeSync.syncProject(projectId);
        },
        recordVerdict: (projectId, slug, verdict, disputes, repoPath) =>
          knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes, repoPath),
        otherRepos: (projectId) => {
          const repo = repoByProject.get(projectId);
          return repo ? [repo] : [];
        },
        recordAttempt: (projectId, slug, body, outcome, repoPath) =>
          recordVerificationAttempt(db, projectId, slug, body, outcome, repoPath),
      },
      // The checkout the doc was written in, while it exists and the guard
      // accepts it for the doc's project; else the checkout(s) resolved from
      // the doc itself.
      repoFor: (projectId, slug, body) => {
        const written = getVerificationState(db, projectId, slug, body).repoPath;
        if (
          written &&
          existsSync(written) &&
          !isCorpusProject(projectId) &&
          repoMayServeProject(written, projectId, verificationInputs.ownership)
        ) {
          return written;
        }
        const target = resolveVerificationRepo({
          targetProject: projectId,
          sourceProject: sourceSessionProject(db, backend.getDoc(projectId, slug)?.sourceSessionId),
          body,
          ...verificationInputs,
        });
        return target.repo === null ? null : target;
      },
      attempts: (projectId, slug, body) => getVerificationState(db, projectId, slug, body).attempts,
      tryConsume: () => budget.tryConsume(),
    },
    store.getAllDocs()
  );
  if (retried > 0) console.log(`[knowledge-graph-audit] retried the fact-check of ${retried} unverified doc(s)`);

  // Advance the rotation cursor and record the run regardless of per-project
  // failures so a single bad project doesn't re-fire the whole sweep every poll for
  // the rest of the day, and so the next night starts at a different project.
  setSetting(db, AUDIT_CURSOR_KEY, String(result.nextCursor));
  setSetting(db, AUDIT_LAST_RUN_KEY, today);
}

/**
 * Start the nightly graph-audit scheduler. The CALLER gates registration on
 * {@link isNightlySweepEnabled}; once started, it kicks after INITIAL_DELAY_MS and
 * then on the interval, with a per-day settings gate so a `bun --watch` restart
 * can't re-run the sweep the same day. Returns the interval timer so the caller
 * can clearInterval it on shutdown, mirroring startKnowledgeReverifyCron.
 */
export function startKnowledgeGraphAuditCron(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  opts: GraphAuditCronOptions = {}
): ReturnType<typeof setInterval> {
  const intervalMs =
    opts.intervalMs ?? parsePositiveInt(process.env[NIGHTLY_SWEEP_INTERVAL_ENV], DEFAULT_INTERVAL_MS);

  const kick = () => {
    // The sweep spawns judge and resolver models; a host short on headroom
    // skips this poll, and the per-day gate runs the sweep on a later one.
    if (deferForHostPressure("knowledge-graph-audit")) return;
    tick(db, knowledgeSync, knowledgeDir, opts).catch((e) =>
      console.error("[knowledge-graph-audit]", e)
    );
  };
  setTimeout(kick, INITIAL_DELAY_MS);
  return setInterval(kick, intervalMs);
}
