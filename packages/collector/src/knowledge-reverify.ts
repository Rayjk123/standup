import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import {
  updateDocFrontmatter,
  readRawDocFile,
  LocalMarkdownBackend,
  INITIAL_CONFIDENCE,
  DISPUTED_CONFIDENCE,
  DEFAULT_BASE_CONFIDENCE,
  evidenceCap,
  isContradictionEndpoint,
  contradictionDisputes,
  layerOf,
  getVerificationState,
  recordVerificationAttempt,
  KnowledgeStore,
  type ConfidenceEvidence,
  type KnowledgeBackend,
  type KnowledgeDoc,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "@standup/knowledge";
import { getProjects, getSetting, setSetting } from "@standup/store";
import type { Project } from "@standup/shared";
import {
  computeStaleness,
  computeFileScopedStaleness,
  computeDocEvidence,
  deriveOwnedPaths,
  hasProvenance,
  isAboutRepo,
  isModelReverifyEnabled,
  isRepoRoot,
  isReverifyEnabled,
  lastCommitDate,
  primaryRepoPath,
  projectReverifyOperational,
  rebaselineSha,
  resolveHeadSha,
  RepoEvidenceContext,
  type GitLineRunner,
  type GitStatusRunner,
  type Staleness,
  type FileScopedStaleness,
} from "./knowledge-staleness.js";
import {
  attemptStateFor,
  freshnessGate,
  isReverifyVerdict,
  MAX_REVERIFY_ATTEMPTS,
  readProjectReverifyAttempts,
  recordModelPassVerdicts,
  recordReverifyAttempt,
  replaceProjectFreshness,
  type FreshnessRecord,
  type ReverifyAttemptState,
} from "./knowledge-freshness.js";
import {
  isPendingVerification,
  isVerificationInFlight,
  retryPendingVerifications,
  type PublishVerifyDeps,
  type RetryPendingDeps,
} from "./knowledge-publish-verify.js";
import {
  dbVerificationInputs,
  repairWrongRepoDisputesInDb,
  retryRepoFor,
  sourceSessionProject,
} from "./knowledge-verify-repos.js";
import {
  verifyDraft,
  type DraftVerification,
  type DraftVerdict,
  type DraftDispute,
} from "./draft-verify.js";
import {
  detectContradictions,
  flagContradictions,
  runClaudeContradictionJudge,
  withJudgmentLog,
  type ContradictionJudge,
  type DetectContradictionOptions,
} from "./knowledge-coherence.js";
import {
  buildResolveDeps,
  resolveContradictionsAsync,
  runClaudeContradictionResolver,
  type ContradictionResolver,
} from "./knowledge-resolve.js";
import type { KnowledgeSync } from "./knowledge-sync.js";
import { deferForHostPressure } from "./host-headroom.js";
import {
  isConfirmedLanding,
  landedClaimDeps,
  newLandingCache,
  settleBranchClaims,
  type LandedClaimDeps,
} from "./knowledge-repo-claims.js";

/**
 * Self-iterating knowledge staleness (spec r5) — the automatic re-verification
 * half, on top of the shipped commit-drift signal (knowledge-staleness.ts) and
 * the confidence decay (r2, confidence.ts).
 *
 * Each daily pass, per project whose repo resolves on this host, runs in two
 * steps:
 *
 * 1. An evidence pass over every doc of the project (runEvidencePass): git
 *    plumbing only, no model, on unless re-verification is switched off
 *    (isReverifyEnabled). It writes no doc: it records, in knowledge_freshness,
 *    the date each repo mirror stands as of and the findings that hold now
 *    (computeDocEvidence — named paths/symbols gone since the doc's anchor, an
 *    unmerged sha, a newer doc contradicting it cap its base; churn on its
 *    files only raises priority). The freshness gate reads that record.
 * 2. A bounded model pass, OPT-IN (isModelReverifyEnabled) because it spends
 *    model calls, that re-points the draft-verify refutation machinery at
 *    accepted docs about this repo (isAboutRepo — provenance, or named paths
 *    that mostly resolve here). Docs are ranked by how often they are retrieved
 *    times how likely they are stale; the top few are fact-checked against
 *    current code, where a name merely absent from the repo is not a refutation
 *    (verifyAcceptedDoc). A clean result resets last_verified_at (lifting
 *    decayed confidence back and re-opening the auto-injection gate); a
 *    disputed result writes confidence down below the injection floor and
 *    records the disputes so a human sees them.
 *
 * The model pass's confidence + last_verified_at land in the doc's frontmatter
 * (they are its verdict and must survive a DB rebuild); the verdict + disputes
 * and the evidence findings are DB-only verification state.
 *
 * The scheduler mirrors review-cron.ts's seam: a plain interval with a
 * per-project once-per-day settings gate, because the collector is a local-first
 * process that may not run continuously — "has today's pass happened yet?" is
 * the honest question, not "fire at 09:00".
 */

const DEFAULT_INTERVAL_MS = 3_600_000; // 1h poll

/**
 * Max docs the model pass re-verifies per project per daily pass — bounds
 * `claude` spawns. Env STANDUP_KNOWLEDGE_REVERIFY_MAX_PER_PROJECT overrides.
 */
export const DEFAULT_MAX_PER_PROJECT_PER_RUN = 10;

function maxPerProjectPerRun(): number {
  const parsed = parseInt(process.env.STANDUP_KNOWLEDGE_REVERIFY_MAX_PER_PROJECT ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PER_PROJECT_PER_RUN;
}

/** The retrieval window the model pass ranks by: retrievals in the last this-many days. */
export const RETRIEVAL_WINDOW_DAYS = 30;
/**
 * A doc re-verified within this many days is NOT a candidate again yet — a
 * recency backoff so the bounded daily budget can't be monopolized by the same
 * docs every run (roadmap r5 review). Without it a persistently-DISPUTED doc,
 * pinned at DISPUTED_CONFIDENCE (the lowest confidence bucket), would win the
 * confidence sort and be re-checked every single day — starving a genuinely
 * clean doc that is merely AGING (decaying with time, never drift-flagged) until
 * it decays below the injection floor and drops out of context. The cooldown
 * lets the recency signal act: a doc just verified (clean OR disputed) steps
 * aside so aging docs get their turn. 14 days keeps a disputed doc re-checked
 * ~twice a month while it waits for a human, not daily.
 */
export const REVERIFY_COOLDOWN_DAYS = 14;

/**
 * A doc whose last fact-check ended without a verdict (error / unverified) is
 * not a candidate again for this many days, and after MAX_REVERIFY_ATTEMPTS
 * such attempts on the same body not at all — a doc the verifier cannot judge
 * must not take the daily budget from docs it can.
 */
export const REVERIFY_RETRY_COOLDOWN_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/** Today as a local ISO date (YYYY-MM-DD), matching the settings-key value. */
function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The settings key holding the local date a project's re-verification pass last ran. */
export function lastRunKey(projectId: string): string {
  return `knowledge_reverify_last_run:${projectId}`;
}

export interface ReverifyTarget {
  doc: KnowledgeDoc;
  /** Repo-global commit-drift signal for the doc's generated_from_sha, or null
   *  when it can't be computed (no repo, or a doc with no sha). Kept as a weaker
   *  signal behind the file-scoped one. */
  staleness: Staleness | null;
  /** File-scoped drift: commits touching the doc's OWN files (deriveOwnedPaths
   *  over the doc) since its sha. Weighted above repo-global `staleness` so the
   *  bounded daily budget is spent on docs whose own files churned, not docs
   *  merely sitting in a repo where something unrelated churned. Optional so a
   *  caller (or a test) that only has the repo-global signal still type-checks. */
  fileScopedStaleness?: FileScopedStaleness | null;
  /** Current (decayed) confidence as of the tick, or undefined for a doc with
   *  no confidence opinion. */
  currentConfidence: number | undefined;
  /** How many times the doc was retrieved in the last RETRIEVAL_WINDOW_DAYS. */
  retrievals?: number;
  /** The evidence pass's findings against the doc this tick. */
  evidence?: readonly ConfidenceEvidence[];
  /** The model pass's record for the doc's current body. */
  attempts?: ReverifyAttemptState;
}

/** Parsed ms of an ISO timestamp, or 0 for absent/unparseable — a doc with no
 *  last_verified_at sorts oldest (most urgent), and a bad string never poisons
 *  the comparator with NaN. */
function verifiedMs(lastVerifiedAt: string | undefined): number {
  if (!lastVerifiedAt) return 0;
  const parsed = Date.parse(lastVerifiedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

const STALENESS_RISK_FLOOR = 0.05;

/**
 * How likely a target is to be stale, at least STALENESS_RISK_FLOOR: the
 * confidence it has lost (1 − current), plus a fixed amount for each signal
 * that its claims may have moved — a deterministic finding, churn on its own
 * files, and (weaker) repo-wide churn since its sha. The floor keeps a
 * still-fresh but heavily retrieved doc in the running, so retrieval frequency
 * can lift it.
 */
export function stalenessRisk(t: ReverifyTarget): number {
  let risk = 1 - (t.currentConfidence ?? INITIAL_CONFIDENCE);
  if ((t.evidence?.length ?? 0) > 0) risk += 0.5;
  if (t.fileScopedStaleness?.stale) risk += 0.5;
  if (t.staleness?.stale) risk += 0.25;
  return Math.max(STALENESS_RISK_FLOOR, risk);
}

/**
 * Re-verification priority: retrieval frequency × staleness risk. A doc agents
 * read every day that has started to slip is worth a model call before a stale
 * doc nobody reads; with no retrievals at all, risk alone orders them.
 */
export function reverifyPriority(t: ReverifyTarget): number {
  return (1 + Math.max(0, t.retrievals ?? 0)) * stalenessRisk(t);
}

/**
 * Ranks re-verification targets by urgency and returns the top `limit`. Docs
 * of every origin are candidates — owner-written, mirrored from the repo, and
 * agent-generated alike: the most-read docs are often hand-written ones, and
 * exempting them would leave exactly those unchecked. An agent doc still
 * awaiting its publish fact-check (isPendingVerification) or with one running
 * is excluded: that check, with its repository-state claims, decides it. A doc
 * whose current body has run out of verdict-less attempts, or whose last one
 * was within REVERIFY_RETRY_COOLDOWN_DAYS, is excluded. A doc re-verified within
 * REVERIFY_COOLDOWN_DAYS of `now` is excluded — the recency backoff that stops
 * a persistently-disputed doc (pinned at the lowest confidence) from
 * monopolizing the bounded daily budget and starving aging clean docs. Order of
 * what remains: a doc flagged as an endpoint of a coherence contradiction first
 * (a live conflict between two accepted docs is the most urgent human review),
 * then reverifyPriority (retrieval frequency × staleness risk), then — on a
 * tie — file-scoped drift, repo-global drift, lowest current confidence, and
 * oldest last-verified.
 *
 * Pure so the cron's selection is unit-testable without spawning a verifier;
 * the cron builds the targets and calls this. `now` is injectable for the same
 * reason.
 */
export function selectReverifyCandidates(
  targets: ReverifyTarget[],
  limit: number,
  now: Date = new Date()
): ReverifyTarget[] {
  const cooldownMs = REVERIFY_COOLDOWN_DAYS * MS_PER_DAY;
  return targets
    // A "superseded" doc is the tombstoned loser of an auto-resolved contradiction
    // (roadmap r7). Re-verifying it would let a clean fact-check reset its verdict
    // to "clean" and lift its confidence back — reviving a claim a resolution
    // deliberately retired, since the doc↔doc supersession is invisible to a
    // code fact-check. Leave it retired until a human revives it by editing.
    .filter((t) => t.doc.verdict !== "superseded")
    .filter((t) => !isPendingVerification(t.doc) && !isVerificationInFlight(t.doc.projectId, t.doc.slug))
    .filter((t) => {
      const a = t.attempts;
      if (!a || a.attempts === 0) return true;
      if (a.attempts >= MAX_REVERIFY_ATTEMPTS) return false;
      const at = verifiedMs(a.lastAttemptAt);
      return at === 0 || now.getTime() - at >= REVERIFY_RETRY_COOLDOWN_DAYS * MS_PER_DAY;
    })
    .filter((t) => {
      // A doc with no last_verified_at has never been checked — most urgent,
      // never in cooldown. Otherwise skip it while it is still within the
      // backoff window (a bad/future timestamp reads as ms 0, i.e. long past
      // cooldown, so it stays eligible rather than being wrongly suppressed).
      const verifiedAt = verifiedMs(t.doc.lastVerifiedAt);
      if (verifiedAt === 0) return true;
      return now.getTime() - verifiedAt >= cooldownMs;
    })
    .sort((a, b) => {
      // Contradiction endpoints first: a doc flagged as opposing another accepted
      // doc needs a human. 0 sorts ahead of 1.
      const conflictA = isContradictionEndpoint(a.doc) ? 0 : 1;
      const conflictB = isContradictionEndpoint(b.doc) ? 0 : 1;
      if (conflictA !== conflictB) return conflictA - conflictB;
      const priorityA = reverifyPriority(a);
      const priorityB = reverifyPriority(b);
      if (priorityA !== priorityB) return priorityB - priorityA;
      const fileStaleA = a.fileScopedStaleness?.stale ? 0 : 1;
      const fileStaleB = b.fileScopedStaleness?.stale ? 0 : 1;
      if (fileStaleA !== fileStaleB) return fileStaleA - fileStaleB;
      const staleA = a.staleness?.stale ? 0 : 1;
      const staleB = b.staleness?.stale ? 0 : 1;
      if (staleA !== staleB) return staleA - staleB;
      const confA = a.currentConfidence ?? INITIAL_CONFIDENCE;
      const confB = b.currentConfidence ?? INITIAL_CONFIDENCE;
      if (confA !== confB) return confA - confB;
      return verifiedMs(a.doc.lastVerifiedAt) - verifiedMs(b.doc.lastVerifiedAt);
    })
    .slice(0, limit);
}

/** The side effects reverifyDoc needs, injected so the update logic is testable
 *  without a real verifier, filesystem, or database. */
export interface ReverifyDeps {
  verify: (slug: string, body: string, repoPath: string) => Promise<DraftVerification>;
  /** Patches confidence + last_verified_at into the doc's frontmatter. When
   *  `generatedFromSha` is given (a clean pass re-baselines to current HEAD),
   *  it is patched too so the commit-drift signal stops reporting the doc stale
   *  against the commit it was originally distilled from. */
  updateConfidence: (
    projectId: string,
    slug: string,
    confidence: number,
    lastVerifiedAt: string,
    generatedFromSha?: string
  ) => Promise<void>;
  /** Re-reads the project's docs from disk into the index after the write. */
  resync: (projectId: string) => Promise<void>;
  /** Records the verdict + disputes against the accepted doc (DB-only), with
   *  the checkout the fact-check ran against. */
  recordVerdict: (
    projectId: string,
    slug: string,
    verdict: DraftVerdict,
    disputes: unknown[],
    repoPath?: string
  ) => void;
  now?: () => Date;
}

/**
 * Re-verifies one accepted doc against current code and writes the result back.
 *
 * - clean → confidence reset to full and last_verified_at bumped to now, which
 *   lifts the decayed value back to the base and re-opens the injection gate;
 *   generated_from_sha is also re-baselined to current HEAD (when known) so the
 *   commit-drift signal agrees with the fresh verdict instead of reporting the
 *   doc stale against the commit it was originally distilled from.
 * - disputed → confidence written down to DISPUTED_CONFIDENCE (below the
 *   injection floor, so a contradicted doc stops being fed to agents) with the
 *   disputes recorded for a human, and last_verified_at bumped so the low value
 *   holds at the floor rather than decaying further into noise. generated_from_sha
 *   is left as-is: the doc is wrong at HEAD, so re-baselining would falsely clear
 *   its drift flag.
 * - error / unverified / unverifiable → left entirely untouched: a transient
 *   verifier failure, or a repository whose mainline could not be refreshed,
 *   must not erode a doc's confidence or clobber a prior verdict.
 *
 * A doc already flagged as CONTRADICTING another accepted doc is special: the
 * code fact-check cannot see a doc↔doc conflict, so its verdict is FOLDED onto
 * the contradiction rather than allowed to clear it (the pass ranks these docs
 * first, so this is the common case, not a corner). A clean result keeps the
 * "contradicted" verdict and its `Contradicts <slug>` dispute(s) — the doc still
 * opposes another and must stay out of injection, so the gate is NOT re-opened
 * and the sha is NOT re-baselined; last_verified_at is bumped (with no confidence
 * penalty — a contradiction carries none) only so the pass stops re-spawning on
 * it daily. A disputed result records the code findings AND the preserved
 * contradiction dispute(s) so the human loses neither.
 *
 * Returns the verdict the pass produced. `headSha` is the repo's current HEAD
 * (null when it can't be resolved), stamped onto a clean re-verification.
 */
export async function reverifyDoc(
  deps: ReverifyDeps,
  projectId: string,
  doc: KnowledgeDoc,
  repoPath: string,
  headSha: string | null
): Promise<DraftVerdict> {
  const result = await deps.verify(doc.slug, doc.body, repoPath);
  if (result.verdict === "error" || result.verdict === "unverified" || result.verdict === "unverifiable") {
    return result.verdict;
  }

  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // Fold onto an existing doc↔doc contradiction instead of clobbering it.
  const held = contradictionDisputes(doc);
  if (held.length > 0) {
    if (result.verdict === "clean") {
      // Correct against code, but still opposes another accepted doc — keep it
      // held out. Preserve base confidence (no penalty) but bump last_verified_at
      // so the cooldown applies; do not re-baseline the sha (drift is moot while
      // the doc is held out of injection anyway).
      await deps.updateConfidence(
        projectId,
        doc.slug,
        doc.confidence ?? DEFAULT_BASE_CONFIDENCE,
        nowIso
      );
      await deps.resync(projectId);
      deps.recordVerdict(projectId, doc.slug, "contradicted", held, repoPath);
      return "contradicted";
    }
    // Also wrong against code: record the code findings with the contradiction
    // dispute(s) appended (deduped by claim), keeping the stronger code-grounded
    // "disputed" verdict. Either verdict holds the doc out of injection.
    const disputes = dedupeByClaim([...result.disputes, ...held]);
    await deps.updateConfidence(projectId, doc.slug, DISPUTED_CONFIDENCE, nowIso);
    await deps.resync(projectId);
    deps.recordVerdict(projectId, doc.slug, "disputed", disputes, repoPath);
    return "disputed";
  }

  const confidence =
    result.verdict === "clean" ? INITIAL_CONFIDENCE : DISPUTED_CONFIDENCE;
  // Only a doc that already carries a sha is re-baselined: stamping one onto an
  // owner-written doc would turn it into a "generated" one.
  const rebaselineSha =
    result.verdict === "clean" && headSha && hasProvenance(doc.generatedFromSha) ? headSha : undefined;

  await deps.updateConfidence(projectId, doc.slug, confidence, nowIso, rebaselineSha);
  // Re-read from disk BEFORE recording the verdict: the resync's upsertDoc omits
  // the verdict columns, so it preserves whatever verdict is already there —
  // recording after the resync is what makes this pass's verdict the one that
  // sticks.
  await deps.resync(projectId);
  deps.recordVerdict(projectId, doc.slug, result.verdict, result.disputes, repoPath);
  return result.verdict;
}

/** Disputes with duplicate `claim`s collapsed, first occurrence winning — a
 *  code finding and a contradiction dispute never stack a repeated claim. */
function dedupeByClaim(disputes: DraftDispute[]): DraftDispute[] {
  const seen = new Set<string>();
  const out: DraftDispute[] = [];
  for (const d of disputes) {
    if (seen.has(d.claim)) continue;
    seen.add(d.claim);
    out.push(d);
  }
  return out;
}

interface ReverifyCronOptions {
  /** Poll interval; env STANDUP_KNOWLEDGE_REVERIFY_INTERVAL_MS overrides. */
  intervalMs?: number;
  /** Embedding provider/config for the contradiction pass's corpus search
   *  (roadmap r7). Absent → the pass runs on FTS-only recall, and the candidate
   *  floor drops to its text-only scale (CONTRADICTION_CANDIDATE_FLOOR_TEXT_ONLY)
   *  so it can still surface a candidate — an FTS-only rawScore never reaches the
   *  hybrid floor. */
  embeddingProvider?: EmbeddingProvider | null;
  embeddingConfig?: EmbeddingConfig;
  /** Override the contradiction judge for tests; production spawns Haiku. */
  contradictionJudge?: ContradictionJudge;
  /** Override the contradiction resolver for tests; production spawns Haiku. */
  contradictionResolver?: ContradictionResolver;
  /** Override the publish fact-check a pending doc is retried with; production spawns Haiku. */
  publishVerifier?: PublishVerifyDeps["verify"];
  /** Surface a cron-flagged contradiction as a feed line (wired to the WS
   *  broadcaster in production; omitted in tests). */
  onContradiction?: (projectId: string, slug: string, title: string, contradicted: string[]) => void;
}

/** The production publish fact-check, against `repoPath` and any further checkouts. */
const defaultPublishVerifier: PublishVerifyDeps["verify"] = (slug, body, repoPath, additionalRepos = []) =>
  verifyDraft(slug, body, repoPath, additionalRepos.length > 0 ? { additionalRepos } : {});

/**
 * The retry of pending publish fact-checks over the store: each doc is retried
 * against the checkout(s) the repo-ownership guard resolves for it now (for a
 * corpus doc, with its source session's project), counting attempts against
 * the doc's current body in `knowledge_verifications`.
 */
export function pendingVerificationRetryDeps(
  db: Database,
  knowledgeSync: Pick<KnowledgeSync, "recordDocVerdict" | "syncProject">,
  knowledgeDir: string,
  backend: Pick<KnowledgeBackend, "readAcceptedDoc" | "getDoc">,
  verify: PublishVerifyDeps["verify"] = defaultPublishVerifier
): RetryPendingDeps {
  // Projects, repos and launches change while the server runs, so the
  // ownership inputs are read afresh for every doc a sweep retries.
  const inputs = () => dbVerificationInputs(db);
  const sourceProject = (projectId: string, slug: string) =>
    sourceSessionProject(db, backend.getDoc(projectId, slug)?.sourceSessionId);
  return {
    verifyDeps: {
      verify,
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
      otherRepos: (projectId) => inputs().projectRepos(projectId),
      recordAttempt: (projectId, slug, body, outcome, repoPath) =>
        recordVerificationAttempt(db, projectId, slug, body, outcome, repoPath),
    },
    repoFor: (projectId, slug, body) => retryRepoFor(inputs(), sourceProject)(projectId, slug, body),
    attempts: (projectId, slug, body) => getVerificationState(db, projectId, slug, body).attempts,
  };
}

/** Retries the fact-check of agent docs still pending verification (bounded
 *  per run and per body; see retryPendingVerifications). */
export async function retryPendingPublishVerifications(db: Database, deps: RetryPendingDeps): Promise<number> {
  const retried = await retryPendingVerifications(deps, new KnowledgeStore(db).getAllDocs());
  if (retried > 0) console.log(`[knowledge-reverify] retried the fact-check of ${retried} pending doc(s)`);
  return retried;
}

/**
 * The coherence-check side effects the re-verify pass runs after a clean
 * fact-check (roadmap r7): a corpus search + doc reads to surface contradiction
 * candidates, the LLM judge that confirms genuine opposition, and the verdict
 * write that flags a confirmed pair. Injected so the pass is exercised without a
 * backend or a `claude` spawn.
 */
export interface ReverifyCoherenceDeps {
  backend: Pick<
    KnowledgeBackend,
    "search" | "readAcceptedDoc" | "getDoc" | "embeddingsEnabled"
  >;
  judge: ContradictionJudge;
  recordVerdict: (projectId: string, slug: string, verdict: string, disputes: unknown[]) => void;
  /** Surface a confirmed contradiction as a feed line on both surfaces (the
   *  reverify-path analog of the accept-path's emitKnowledgeChange). Optional so
   *  the pass stays testable without a broadcaster. */
  onContradiction?: (projectId: string, slug: string, title: string, contradicted: string[]) => void;
  /** Fire the automatic resolver over each freshly-flagged pair (roadmap r7),
   *  detached. Optional so the pass stays testable without the resolver wiring. */
  resolveContradictions?: (
    projectId: string,
    subjectSlug: string,
    contradictedSlugs: readonly string[]
  ) => void;
}

/**
 * Contradiction pass over the docs a re-verify tick just found CLEAN (roadmap
 * r7). A clean doc is one the fact-check affirmed against current code; here we
 * ask whether it also OPPOSES another accepted doc, and flag BOTH when it does.
 * Runs only over clean docs on purpose — a disputed doc is already flagged, and
 * overwriting its verdict with "contradicted" would drop the fact-check's own
 * disputes. Each detection is bounded internally (detectContradictions caps the
 * judge spawns), and a per-doc failure never aborts the rest.
 *
 * Returns the slugs whose detection genuinely completed — i.e. ran to the end of
 * the pass without a swallowed per-doc error. A caller gating a durable side
 * effect (the nightly sweep's swept-cooldown stamp) uses this to withhold that
 * effect from a subject whose search/judge errored, keeping it eligible on the
 * next run instead of suppressing it for the cooldown window on a transient fail.
 */
export async function runReverifyContradictionPass(
  coherence: ReverifyCoherenceDeps,
  projectId: string,
  cleanDocs: KnowledgeDoc[],
  detect: DetectContradictionOptions = {}
): Promise<string[]> {
  const completed: string[] = [];
  for (const doc of cleanDocs) {
    const subject = { slug: doc.slug, title: doc.title, body: doc.body };
    try {
      const contradictions = await detectContradictions(
        {
          search: (pid, query, options) => coherence.backend.search(pid, query, options),
          readAcceptedDoc: (pid, slug) => coherence.backend.readAcceptedDoc(pid, slug),
          judge: coherence.judge,
          // Skip a tombstoned (superseded) candidate so a re-verified-clean winner
          // never re-recalls its retired loser into a fresh conflict.
          getDoc: (pid, slug) => coherence.backend.getDoc(pid, slug),
          // FTS-only recall caps rawScore below the hybrid candidate floor; pass
          // the backend's real state so the pass uses the text-only floor there.
          embeddingsEnabled: coherence.backend.embeddingsEnabled,
        },
        projectId,
        subject,
        [],
        detect
      );
      const flagged = flagContradictions(
        {
          recordVerdict: coherence.recordVerdict,
          // Fold onto an opposing doc's current verdict/disputes rather than
          // clobbering them: a candidate recalled here may be "disputed" with
          // fact-check findings a human still needs.
          getDoc: (pid, slug) => coherence.backend.getDoc(pid, slug),
        },
        projectId,
        subject,
        contradictions
      );
      if (flagged.length > 0) {
        console.log(
          `[knowledge-reverify] ${projectId}/${doc.slug}: flagged ${flagged.join(", ")} as contradicting`
        );
        coherence.onContradiction?.(projectId, doc.slug, doc.title, flagged);
        // Hand each freshly-flagged pair to the automatic resolver (roadmap r7),
        // detached — a non-destructive fix is applied and the edge cleared, or a
        // needs-review entry is recorded when an owner/high-confidence claim would
        // be superseded.
        coherence.resolveContradictions?.(
          projectId,
          doc.slug,
          contradictions.map((c) => c.slug)
        );
      }
      // Reached only when detection ran without throwing — a swallowed error
      // below skips this, so an errored subject is absent from `completed`.
      completed.push(doc.slug);
    } catch (err) {
      console.error(`[knowledge-reverify] contradiction check ${projectId}/${doc.slug} failed:`, err);
    }
  }
  return completed;
}

/** The side effects the evidence pass needs, injected so it runs against a temp repo and DB in tests and the eval. */
export interface EvidencePassDeps {
  /** The doc file's parsed frontmatter, or null when the file is unreadable. */
  readFrontmatter: (projectId: string, slug: string) => Promise<Record<string, unknown> | null>;
  /** Replaces the project's recorded findings with this pass's (see replaceProjectFreshness). */
  record: (projectId: string, records: FreshnessRecord[], checkedAt: string) => void;
  /** Where landed not-merged claims are recorded and their review drafts written; claims are not checked without it. */
  landedClaims?: LandedClaimDeps;
  git?: GitStatusRunner;
  lines?: GitLineRunner;
  now?: () => Date;
}

export interface EvidencePassResult {
  projectId: string;
  /** Why the pass did nothing, when it did nothing. */
  skipped?: "not-a-repo-root";
  /** Docs the pass looked at (personal and activity docs are not checked). */
  checked: number;
  /** Docs mirrored from a repo file, anchored to that file's last commit. */
  anchored: string[];
  /** Docs whose base is capped by a current finding, with the cap. */
  capped: Array<{ slug: string; cap: number; evidence: ConfidenceEvidence[] }>;
  /** Every finding by slug, capping or not (drift only raises re-verify priority). */
  findings: Record<string, ConfidenceEvidence[]>;
  /** Docs whose not-merged claims have landed (settleBranchClaims), and whether this pass wrote their review draft. */
  landed: Array<{ slug: string; how: string; draftWritten: boolean }>;
  /** The repo context the pass built, reused by the model pass. */
  context?: RepoEvidenceContext;
}

/**
 * The deterministic half of re-verification, over every doc of one project:
 * git plumbing only, no model, so it runs over a whole corpus each day.
 *
 * Writes nothing into the docs. It records, per doc, the date a repo mirror
 * stands as of (its source file's last commit), the findings that hold
 * against it now (computeDocEvidence) with the cap they put on its base, and
 * whether the model pass could fact-check it against this repo (isAboutRepo) —
 * and replaces the project's previous record wholesale, so a finding that no
 * longer holds is gone after the next pass. The freshness gate reads that
 * record at injection time.
 *
 * With `landedClaims`, a doc saying its work is "on branch X, not yet merged"
 * is checked for that work on the default branch by content
 * (settleBranchClaims); once it has landed the landing is recorded and a
 * review draft rewriting the claim is written for a human to accept — the doc
 * itself is still never written. A landing found by the branch
 * (isConfirmedLanding) also drops the doc's `unmerged` finding; one inferred
 * only from content keeps it until the draft is accepted.
 *
 * Skips a repo path that is not itself the top of a git work tree (a directory
 * inside another checkout), whose history would be the enclosing repo's, and
 * clears the project's record.
 * Personal and activity docs are not checked; a superseded doc is already
 * retired.
 */
export async function runEvidencePass(
  deps: EvidencePassDeps,
  projectId: string,
  docs: readonly KnowledgeDoc[],
  repoPath: string
): Promise<EvidencePassResult> {
  const result: EvidencePassResult = { projectId, checked: 0, anchored: [], capped: [], findings: {}, landed: [] };
  if (!(await isRepoRoot(repoPath, deps.git))) {
    // Findings from an earlier pass no longer describe a repo this pass can
    // read; clear them rather than leave them capping docs indefinitely.
    result.skipped = "not-a-repo-root";
    deps.record(projectId, [], (deps.now?.() ?? new Date()).toISOString());
    return result;
  }
  const checkable = docs.filter((d) => {
    const layer = layerOf(d);
    return layer !== "personal" && layer !== "activity" && d.verdict !== "superseded";
  });
  const ctx = await RepoEvidenceContext.forDocs(repoPath, checkable, { git: deps.git, lines: deps.lines });
  result.context = ctx;
  const peers = new Map(docs.map((d) => [`${d.projectId}/${d.slug}`, d]));
  const records: FreshnessRecord[] = [];
  const treeAtHead = (await ctx.treeAt("HEAD")) ?? new Set<string>();
  const landedClaims = deps.landedClaims ? { ...deps.landedClaims, now: deps.landedClaims.now ?? deps.now } : undefined;
  const knownLanded = landedClaims?.read(projectId) ?? new Map();
  const landingCache = newLandingCache();

  for (const doc of checkable) {
    result.checked++;
    const fm = (await deps.readFrontmatter(projectId, doc.slug)) ?? {};
    let anchorAt: string | undefined;
    if (typeof fm.ingested_from === "string" && fm.ingested_from.trim()) {
      anchorAt = (await lastCommitDate(repoPath, fm.ingested_from.trim(), deps.git)) ?? undefined;
      if (anchorAt) result.anchored.push(doc.slug);
    }
    let findings = await computeDocEvidence(ctx, doc, peers, anchorAt);
    // A doc whose not-merged claims have landed is not provisional, whatever
    // its own sha says: the work it describes is on the default branch. A
    // landing inferred only from content keeps the finding; its review draft
    // is still written and synced.
    const settled = landedClaims ? await settleBranchClaims(landedClaims, ctx, doc, knownLanded, landingCache) : null;
    if (settled?.record) {
      if (isConfirmedLanding(settled.record)) findings = findings.filter((f) => f.kind !== "unmerged");
      result.landed.push({ slug: doc.slug, how: settled.record.how, draftWritten: settled.draftWritten });
    }
    const cap = evidenceCap(findings);
    if (findings.length > 0) result.findings[doc.slug] = findings;
    if (cap !== undefined) result.capped.push({ slug: doc.slug, cap, evidence: findings });
    records.push({ slug: doc.slug, anchorAt, cap, findings, aboutRepo: isAboutRepo(doc, treeAtHead) });
  }

  deps.record(projectId, records, (deps.now?.() ?? new Date()).toISOString());
  return result;
}

/** The production evidence-pass deps: frontmatter read from `knowledgeDir`, findings recorded in `db`. */
export function evidencePassDeps(db: Database, knowledgeDir: string): EvidencePassDeps {
  return {
    readFrontmatter: async (projectId, slug) =>
      (await readRawDocFile(knowledgeDir, projectId, slug))?.data ?? null,
    record: (projectId, records, checkedAt) => replaceProjectFreshness(db, projectId, records, checkedAt),
    landedClaims: landedClaimDeps(db, knowledgeDir),
  };
}

/**
 * Retrievals per doc slug of `projectId` (as the doc's home project) in the
 * RETRIEVAL_WINDOW_DAYS before `now`, across every surface. A missing table
 * (an older DB) reads as no retrievals.
 */
export function retrievalCounts(db: Database, projectId: string, now: Date = new Date()): Map<string, number> {
  const since = new Date(now.getTime() - RETRIEVAL_WINDOW_DAYS * MS_PER_DAY)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  try {
    const rows = db
      .query(
        "SELECT doc_slug, COUNT(*) AS n FROM knowledge_retrievals WHERE doc_project = ? AND created_at >= ? GROUP BY doc_slug"
      )
      .all(projectId, since) as Array<{ doc_slug: string; n: number }>;
    return new Map(rows.map((r) => [r.doc_slug, r.n]));
  } catch {
    return new Map();
  }
}

/**
 * A fact-check finding that only says a path, file or symbol is not there. The
 * model pass checks a doc against one repo; a doc may describe another
 * checkout or system, so absence here is not a refutation.
 */
const ABSENCE_FINDING =
  /\b(?:not found|does not exist|doesn't exist|no such (?:file|directory|path)|cannot find|could not find|couldn't find|is absent|not present|no (?:file|directory|path|match(?:es)?) (?:named|at|for)|returned no (?:results|matches))\b/i;

/**
 * verifyDraft for an accepted doc: told that a name merely absent from this
 * repo is not a mismatch, and with any dispute whose finding is only "not
 * found" dropped — a verdict left with no real dispute reads as unverified, so
 * the doc is left untouched rather than written down to DISPUTED_CONFIDENCE.
 */
export async function verifyAcceptedDoc(
  slug: string,
  body: string,
  repoPath: string,
  verify: typeof verifyDraft = verifyDraft
): Promise<DraftVerification> {
  const result = await verify(slug, body, repoPath, { absenceIsNotAMismatch: true });
  if (result.verdict !== "disputed") return result;
  const disputes = result.disputes.filter((d) => !ABSENCE_FINDING.test(d.finding));
  if (disputes.length === 0) return { verdict: "unverified", disputes: [] };
  return { verdict: "disputed", disputes };
}

/**
 * Runs the evidence pass and — when the project opted into it — the bounded
 * model re-verification for a single project.
 */
async function reverifyProject(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  project: Project,
  coherence?: ReverifyCoherenceDeps
): Promise<void> {
  const repoPath = primaryRepoPath(project);
  // Existence is checked, not just configuration: a repo path that no longer
  // resolves on this host leaves git and verifyDraft running against a bad cwd.
  // The tick only reaches projects projectReverifyOperational accepts — the
  // predicate the injection freshness gate couples decay to.
  if (!repoPath || !existsSync(repoPath)) {
    console.log(`[knowledge-reverify] ${project.id}: no resolvable repo, skipping`);
    replaceProjectFreshness(db, project.id, [], new Date().toISOString());
    return;
  }

  const evidencePass = await runEvidencePass(
    evidencePassDeps(db, knowledgeDir),
    project.id,
    knowledgeSync.getDocs(project.id),
    repoPath
  );
  if (evidencePass.landed.some((l) => l.draftWritten)) await knowledgeSync.syncDrafts(project.id);
  for (const landed of evidencePass.landed.filter((l) => l.draftWritten)) {
    console.log(`[knowledge-reverify] ${project.id}/${landed.slug}: not-merged claim landed (${landed.how}); review draft written`);
  }
  if (evidencePass.skipped) {
    console.log(`[knowledge-reverify] ${project.id}: ${repoPath} is not a git repo root, evidence skipped`);
  } else if (evidencePass.capped.length > 0 || evidencePass.anchored.length > 0) {
    console.log(
      `[knowledge-reverify] ${project.id}: evidence caps ${evidencePass.capped.length}, anchored ${evidencePass.anchored.length} of ${evidencePass.checked}`
    );
  }

  const limit = maxPerProjectPerRun();
  const ctx = evidencePass.context;
  if (limit === 0 || !ctx || !isModelReverifyEnabled(db, project)) return;

  const now = new Date();
  const treeAtHead = (await ctx.treeAt("HEAD")) ?? new Set<string>();
  const gate = freshnessGate(db, now);
  const retrievals = retrievalCounts(db, project.id, now);
  const attempts = readProjectReverifyAttempts(db, project.id);
  const targets: ReverifyTarget[] = [];
  for (const doc of knowledgeSync.getDocs(project.id)) {
    const layer = layerOf(doc);
    if (layer === "personal" || layer === "activity") continue;
    // A doc about another system or checkout cannot be fact-checked against
    // this repo; one that names nothing here has nothing to check.
    if (!isAboutRepo(doc, treeAtHead)) continue;
    // An accepted doc does not persist the distiller's touchedFiles, so the
    // ownedPaths are derived from the doc body — a heuristic (deriveOwnedPaths)
    // that scopes drift to the files the doc actually names. Commit drift needs a
    // sha; a doc without one is covered by the evidence pass's date anchor.
    const sha = hasProvenance(doc.generatedFromSha) ? doc.generatedFromSha : null;
    targets.push({
      doc,
      staleness: sha ? await computeStaleness(repoPath, sha) : null,
      fileScopedStaleness: sha
        ? await computeFileScopedStaleness(repoPath, sha, deriveOwnedPaths(doc.body))
        : null,
      currentConfidence: gate.currentConfidence(doc),
      retrievals: retrievals.get(doc.slug) ?? 0,
      evidence: evidencePass.findings[doc.slug] ?? [],
      attempts: attemptStateFor(attempts, doc.slug, doc.body),
    });
  }

  const candidates = selectReverifyCandidates(targets, limit, now);
  if (candidates.length === 0) return;

  // Resolved once per pass: a clean re-verification re-baselines the doc's
  // generated_from_sha to a commit on the default branch at or behind HEAD, so
  // the drift signal stops flagging it and the unmerged check never flags a
  // sha this pass wrote.
  const head = await resolveHeadSha(repoPath);
  const rebaseTo = head ? await rebaselineSha(repoPath, head, ctx.defaultRefs) : null;
  const halfLifeBySlug = new Map(candidates.map((c) => [c.doc.slug, c.doc.halfLifeDays]));

  const deps: ReverifyDeps = {
    verify: (slug, body, repo) => verifyAcceptedDoc(slug, body, repo),
    updateConfidence: async (projectId, slug, confidence, lastVerifiedAt, generatedFromSha) => {
      // Only what the doc asserts is written: its own half-life when it has
      // one (a status-like doc's short half-life is derived, never stamped).
      // generated_from_sha is patched only on a clean pass (caller passes it).
      const halfLife = halfLifeBySlug.get(slug);
      await updateDocFrontmatter(knowledgeDir, projectId, slug, {
        confidence,
        last_verified_at: lastVerifiedAt,
        ...(halfLife !== undefined ? { half_life_days: halfLife } : {}),
        ...(generatedFromSha ? { generated_from_sha: generatedFromSha } : {}),
      });
    },
    resync: (projectId) => knowledgeSync.syncProject(projectId),
    recordVerdict: (projectId, slug, verdict, disputes, verdictRepo) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes, verdictRepo),
  };

  const cleanDocs: KnowledgeDoc[] = [];
  let attempted = 0;
  let verdicts = 0;
  for (const target of candidates) {
    // The publish fact-check may have started on this doc since selection.
    if (isVerificationInFlight(project.id, target.doc.slug)) continue;
    attempted++;
    let outcome: string = "error";
    try {
      const verdict = await reverifyDoc(deps, project.id, target.doc, repoPath, rebaseTo);
      outcome = verdict;
      console.log(`[knowledge-reverify] ${project.id}/${target.doc.slug}: ${verdict}`);
      // A doc the fact-check affirmed against code is a contradiction-pass
      // candidate — it might still oppose ANOTHER accepted doc, which the
      // per-doc code fact-check can't see. A disputed doc is already flagged and
      // left out so its fact-check disputes survive.
      if (verdict === "clean") cleanDocs.push(target.doc);
    } catch (err) {
      console.error(
        `[knowledge-reverify] ${project.id}/${target.doc.slug} failed:`,
        err
      );
    }
    if (isReverifyVerdict(outcome)) verdicts++;
    recordReverifyAttempt(db, project.id, target.doc.slug, target.doc.body, outcome, new Date().toISOString());
  }
  // The freshness gate keeps decayed docs gated only while the pass is
  // reaching verdicts; a pass that judged nothing (verifier down) demotes them.
  if (attempted > 0) recordModelPassVerdicts(db, project.id, verdicts > 0);

  // Contradiction pass over the just-affirmed docs (roadmap r7). The DB verdict
  // written above is authoritative and unchanged by a resync, so flagging here
  // sticks; a doc found to contradict another is moved from "clean" to
  // "contradicted" and its opposing doc flagged too.
  if (coherence && cleanDocs.length > 0) {
    await runReverifyContradictionPass(coherence, project.id, cleanDocs);
  }
}

/**
 * The projects re-verification runs for (projectReverifyOperational). Every
 * other project's freshness findings are cleared: no pass will replace them,
 * so they would otherwise cap its docs forever.
 */
export function reverifiableProjects(db: Database, now: Date = new Date()): Project[] {
  const all = getProjects(db);
  const projects = all.filter((p) => projectReverifyOperational(p, isReverifyEnabled(db, p.id)));
  const checkedAt = now.toISOString();
  for (const project of all) {
    if (!projects.includes(project)) replaceProjectFreshness(db, project.id, [], checkedAt);
  }
  return projects;
}

/** One scheduler tick: for every project re-verification can run for
 *  (projectReverifyOperational) whose pass has not run today, run it and record
 *  today's date. */
async function tick(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  coherence?: ReverifyCoherenceDeps,
  retryDeps?: RetryPendingDeps
): Promise<void> {
  const today = todayLocalIso();
  // Disputes recorded against another project's repository say nothing about
  // the doc; they are set aside to `unverifiable` before any pass reads them.
  try {
    repairWrongRepoDisputesInDb(db, (projectId, slug, verdict, disputes, repoPath) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes, repoPath)
    );
  } catch (err) {
    console.error("[knowledge-reverify] wrong-repo dispute repair failed:", err);
  }
  const projects = reverifiableProjects(db);

  for (const project of projects) {
    const key = lastRunKey(project.id);
    if (getSetting(db, key) === today) continue;
    try {
      await reverifyProject(db, knowledgeSync, knowledgeDir, project, coherence);
    } catch (err) {
      console.error(`[knowledge-reverify] ${project.id} pass failed:`, err);
    }
    // Record the run regardless — a per-doc failure is not fatal, and we don't
    // want a single bad project re-firing every poll for the rest of the day.
    setSetting(db, key, today);
  }

  // Agent docs still waiting on a passing publish fact-check get a bounded
  // retry each poll.
  if (retryDeps) {
    try {
      await retryPendingPublishVerifications(db, retryDeps);
    } catch (err) {
      console.error("[knowledge-reverify] pending fact-check retry failed:", err);
    }
  }
}

/**
 * Start the knowledge re-verification scheduler. Returns the interval timer so
 * the caller can clearInterval it on shutdown, mirroring the reaper and the
 * review cron.
 */
export function startKnowledgeReverifyCron(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string,
  opts: ReverifyCronOptions = {}
): ReturnType<typeof setInterval> {
  const intervalMs =
    opts.intervalMs ??
    parseInt(
      process.env.STANDUP_KNOWLEDGE_REVERIFY_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS)
    );

  // Coherence deps for the contradiction pass (roadmap r7): its own backend over
  // the shared db (reusing the corpus's embedding index for candidate recall),
  // the production Haiku judge, and the same DB-only verdict write the fact-check
  // uses. Constructed once and reused across ticks.
  const backend = new LocalMarkdownBackend(
    db,
    opts.embeddingProvider ?? null,
    opts.embeddingConfig ?? {},
    knowledgeDir
  );

  // The automatic resolver's deps, sharing the same backend and DB-only verdict
  // writes as the pass. Fired detached over each freshly-flagged pair.
  const resolveDeps = buildResolveDeps({
    db,
    backend,
    knowledgeDir,
    recordDocVerdict: (projectId, slug, verdict, disputes) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes),
    clearDocVerdict: (projectId, slug) => knowledgeSync.clearDocVerdict(projectId, slug),
    syncProject: (projectId) => knowledgeSync.syncProject(projectId),
    // A test-injected resolver is used as-is; the production default spawns Haiku
    // over the two doc texts + corpus grounding with no tools and no repo access.
    resolve: opts.contradictionResolver ?? runClaudeContradictionResolver,
    onNeedsReview: opts.onContradiction
      ? (record) =>
          opts.onContradiction!(record.projectId, record.loserSlug, record.loserSlug, [
            record.winnerSlug,
          ])
      : undefined,
  });

  const coherence: ReverifyCoherenceDeps = {
    backend,
    // Every outcome — judge errors included — lands in the judgment ledger, as
    // it does for the accept-time checks, so a failed judgment is counted and
    // re-queued rather than read as "no contradiction".
    judge: withJudgmentLog(opts.contradictionJudge ?? runClaudeContradictionJudge, db),
    recordVerdict: (projectId, slug, verdict, disputes) =>
      knowledgeSync.recordDocVerdict(projectId, slug, verdict, disputes),
    onContradiction: opts.onContradiction,
    resolveContradictions: (projectId, subjectSlug, contradictedSlugs) =>
      resolveContradictionsAsync(resolveDeps, projectId, subjectSlug, contradictedSlugs),
  };

  const retryDeps = pendingVerificationRetryDeps(db, knowledgeSync, knowledgeDir, backend, opts.publishVerifier);

  // Fire a little after startup (not synchronously — let the server bind and
  // the initial syncAll settle), then on the interval.
  const kick = () => {
    // The fact-check and contradiction passes spawn models; a host short on
    // headroom skips this poll, and the per-day gate runs them on a later one.
    if (deferForHostPressure("knowledge-reverify")) return;
    tick(db, knowledgeSync, knowledgeDir, coherence, retryDeps).catch((e) =>
      console.error("[knowledge-reverify]", e)
    );
  };
  setTimeout(kick, 10_000);
  return setInterval(kick, intervalMs);
}
