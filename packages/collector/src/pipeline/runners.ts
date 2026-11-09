import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync } from "fs";
import { join } from "path";
import {
  checkApplies,
  CODE_REVIEW_STAGE_KIND,
  computeFacts,
  DEFAULT_CHECK_TIMEOUT_MS,
  HUMAN_REVIEW_STAGE_KIND,
  isHttpUrl,
  MIN_CHECK_TIMEOUT_MS,
  VALIDATION_CHECK_BUDGET_MS,
} from "@standup/shared";
import type {
  FloorAskRecord,
  Launch,
  PipelineDefinition,
  PipelineFacts,
  PipelineRun,
  PipelineStageDef,
  ValidationCheckResult,
  WsMessage,
} from "@standup/shared";
import {
  findDraftReviewPacketForLaunch,
  getLaunch,
  getProject,
  getTicketByLaunch,
  latestSubmittedReviewPacketForLaunch,
  personaJobForLaunch,
  reviewPacketReadyForLaunch,
} from "@standup/store";
import { FLOOR_GATE, FLOOR_OWNER_GATE, floorAnswerAllows } from "../floor/gate.js";
import { scrubSecretEnv } from "../owner-secret.js";
import { codeReviewRemote } from "../code-review/adapter.js";
import { activeProjectLayout, type LaunchCheckout, type ProjectLayout } from "../project-layout/layout.js";
import { codeReviewRequirement, projectCodeReview } from "../review/code-review-requirement.js";
import { defaultGitRunner, onEnterHumanReview, reviewOwnerForLaunch, type GitRunner } from "../review/stage.js";
import { localTargetBranch, resolveTargetBranch } from "../target-branch.js";
import type { ScreenshotStore, ScreenshotValidation } from "./screenshots.js";

/**
 * Stage runners: the server side of a stage kind. The shared registry
 * (registerPipelineStageKind in @standup/shared) says what evidence a kind
 * takes and how it decides the outcome; a runner registered here for the same
 * kind lets the collector complete or check that evidence itself before the
 * outcome is computed (prepareEvidence), react when a run enters a stage of
 * the kind (onEnter), and say why a worker's Stop at such a stage should go to
 * the owner instead of being blocked (stopReason). A kind without a runner
 * takes the worker's evidence as given. The built-in runners below cover
 * coding (changed files and facts), validation (the approved acceptance
 * criterion and the stage's checks), screenshot (validated, copied PNGs, and
 * the review tunnel on entry) and code_review (the issue id, and a
 * review the review gate already cut); prepareOutwardEvidence covers every
 * outward stage (the floor asks raised during it).
 */

/** Stop at most this many parent hops walking a session tree. */
export const MAX_SESSION_DEPTH = 5;

export type CriterionResult = { command: string; met: boolean; output: string };
export type CheckResult = { met: boolean; output: string };

/** What a run update is pushed through. */
export interface PipelineNotify {
  broadcast: (message: WsMessage) => void;
}

/** Side effects the engine and runners need, injectable so a test runs without git, a shell or real files. */
export interface PipelineDeps extends PipelineNotify {
  /** Repo-relative files changed in the worktree against its base; throws when git can't tell. */
  changedFiles: (worktreePath: string, baseBranch: string | undefined) => Promise<string[]>;
  /**
   * The launch's approved acceptance criterion, run through the plan gate
   * afresh (a pass cached by an earlier run doesn't count); null when there is
   * none.
   */
  runCriterion: (launch: Launch) => Promise<CriterionResult | null>;
  /** Runs a validation check's command in the launch's worktree through the safety floor; never cached. */
  runCheck: (launch: Launch, command: string, timeoutMs?: number) => Promise<CheckResult>;
  validateScreenshot: (path: string) => ScreenshotValidation;
  /** The collector's own copies of accepted screenshots. */
  screenshots: ScreenshotStore;
  /** Writes a structural checkpoint for `sessionId`. */
  checkpoint: (sessionId: string, text: string) => void;
  /** The worktree's HEAD and its own reflog (gitHeadState, the default); throws when git can't tell. */
  headState?: (worktreePath: string) => Promise<HeadState>;
  /** The launch's review scratch dir, created when missing (ensureReviewScratchDir); undefined when it can't be. */
  reviewScratchDir: (launchId: string) => string | undefined;
  /**
   * Starts opening the run's review tunnel when its definition configures one
   * (see ReviewTunnels.open); returns at once, the tunnel opens in the
   * background. Absent: no tunnels are opened.
   */
  openReviewTunnel?: (run: PipelineRun) => void;
}

/**
 * A checkout's HEAD commit and the entries of its own HEAD reflog, newest
 * first, as "<sha> <message>" — every commit, checkout, reset or stash made
 * in it. A linked worktree keeps its HEAD reflog to itself.
 */
export interface HeadState {
  head: string;
  reflog: string[];
}

/** `worktreePath`'s HeadState; throws when it isn't a git checkout. */
export async function gitHeadState(worktreePath: string): Promise<HeadState> {
  const head = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
  const log = await git(worktreePath, ["reflog", "show", "--format=%H %gs", "HEAD", "--"]);
  return { head, reflog: log.split("\n").map((l) => l.trim()).filter(Boolean) };
}

export type { LaunchCheckout } from "../project-layout/layout.js";

/**
 * The git checkouts a launch's working dir holds, as the project layout
 * (activeProjectLayout) reads it: the working dir itself in the default git
 * layout; a provisioned workspace's checkouts in the workspace layout.
 */
export function workingDirCheckouts(launch: Launch, layout: ProjectLayout = activeProjectLayout()): LaunchCheckout[] {
  return layout.checkouts(launch);
}

/**
 * `checkout`'s changed files (`changedFiles`, read against its base, or its
 * fallback base when that doesn't resolve), each prefixed with its label.
 * Throws when git can't read it.
 */
export async function checkoutChangedFiles(checkout: LaunchCheckout, changedFiles: PipelineDeps["changedFiles"]): Promise<string[]> {
  let files: string[];
  try {
    files = await changedFiles(checkout.path, checkout.baseBranch);
  } catch (err) {
    if (!checkout.fallbackBase) throw err;
    files = await changedFiles(checkout.path, checkout.fallbackBase);
  }
  return checkout.label ? files.map((f) => `${checkout.label}/${f}`) : files;
}

/**
 * The launch's changed files across every checkout its working dir holds
 * (workingDirCheckouts), labelled by package on a provisioned workspace.
 * Throws when it holds none or git can't read one of them.
 */
export async function launchChangedFiles(launch: Launch, changedFiles: PipelineDeps["changedFiles"]): Promise<string[]> {
  const layout = activeProjectLayout();
  const checkouts = workingDirCheckouts(launch, layout);
  if (checkouts.length === 0) {
    throw new Error(
      layout.id === "git"
        ? "its working dir isn't a git checkout (a workspace of several checkouts needs STANDUP_PROJECT_LAYOUT=workspace)"
        : "its workspace has no package checked out"
    );
  }
  const files: string[] = [];
  for (const checkout of checkouts) files.push(...(await checkoutChangedFiles(checkout, changedFiles)));
  return files;
}

/** The largest file workingFileDigests hashes; a larger one gets no digest. */
const MAX_DIGEST_BYTES = 8 * 1024 * 1024;
/** The most bytes one workingFileDigests call reads in all; the files past it get no digest. */
const MAX_DIGEST_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * A digest of the mode and bytes of each of `files` (paths relative to
 * `root`) as it stands in the working dir, hashed as it is on disk so none of
 * a checkout's own git filters run. Only a regular file of at most
 * MAX_DIGEST_BYTES, within MAX_DIGEST_TOTAL_BYTES read in all, gets one: a
 * dir (a nested repo, a submodule), a link, a path that isn't on disk as
 * named (git quotes unusual names) or anything unreadable is left out, so it
 * never reads as unchanged.
 */
export function workingFileDigests(root: string, files: string[]): Record<string, string> {
  const digests: Record<string, string> = {};
  let read = 0;
  for (const file of files) {
    try {
      const path = join(root, file);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_DIGEST_BYTES || read + stat.size > MAX_DIGEST_TOTAL_BYTES) continue;
      read += stat.size;
      digests[file] = createHash("sha256").update(`${stat.mode}\0`).update(readFileSync(path)).digest("hex");
    } catch {
      // Not on disk as named, or unreadable: no digest.
    }
  }
  return digests;
}

/** Where a stage's evidence came from: the worker, or Standup's review gate recording the review it cut. */
export type EvidenceSource = "worker" | "review_gate";

export interface StageRunnerContext {
  db: Database;
  run: PipelineRun;
  stage: PipelineStageDef;
  launch: Launch | null;
  /** The evidence so far (already through validateEvidence); a runner returns its completed copy. */
  evidence: Record<string, unknown>;
  facts: PipelineFacts;
  sessionId?: string;
  source: EvidenceSource;
  /** The id the attempt will be recorded under, for anything stored alongside it. */
  attemptId: string;
  deps: PipelineDeps;
}

export type PreparedEvidence =
  | {
      evidence: Record<string, unknown>;
      /** Replaces the run's facts. */
      facts?: PipelineFacts;
      /** Undoes side effects (stored files) when the advance doesn't commit. */
      cleanup?: () => void;
    }
  | { error: string; status: 409 | 422; missing?: string[] };

export interface StageEnterContext {
  db: Database;
  run: PipelineRun;
  stage: PipelineStageDef;
  launch: Launch | null;
  deps: PipelineDeps;
  /**
   * Records a review url from the ticket as the stage's evidence (see
   * recordReviewUrl): as the review gate's once the gate ran, otherwise as a
   * worker's report (which needs an issue id).
   */
  recordReviewUrl: (url: string) => Promise<void>;
}

export interface StageStopContext {
  db: Database;
  run: PipelineRun;
  stage: PipelineStageDef;
  launch: Launch | null;
}

export interface PipelineStageRunner {
  prepareEvidence?: (ctx: StageRunnerContext) => Promise<PreparedEvidence> | PreparedEvidence;
  onEnter?: (ctx: StageEnterContext) => Promise<void> | void;
  /** Why a Stop at the stage goes to the owner (the run waits on them with this reason), or null to block it as usual. */
  stopReason?: (ctx: StageStopContext) => string | null;
  /** What a blocked Stop at the stage tells the worker to do, in place of reporting it with pipeline_advance. */
  stopHint?: (ctx: StageStopContext) => string | null;
  /**
   * Why the run may not enter the stage yet, or null when it may. The move
   * that would land there is refused with this, and the run stays where it is
   * for the worker to put it right.
   */
  entryBlock?: (ctx: StageStopContext) => string | null;
  /**
   * Why the stage can't apply to this run's launch at all, or null when it
   * does. A stage that doesn't apply is skipped by the server, with this
   * reason recorded, as soon as the run is found at it.
   */
  notApplicable?: (ctx: StageStopContext) => string | null;
}

const RUNNERS = new Map<string, PipelineStageRunner>();

/** Registers the collector's runner for stage `kind` (replacing any earlier one). */
export function registerPipelineStageRunner(kind: string, runner: PipelineStageRunner): void {
  RUNNERS.set(kind, runner);
}

/** The runner registered for `kind`, or undefined. */
export function getPipelineStageRunner(kind: string): PipelineStageRunner | undefined {
  return RUNNERS.get(kind);
}

// ----------------------------------------------------------------------------
// Shared lookups.
// ----------------------------------------------------------------------------

/** The issue id a code review for the launch would carry, when Standup already knows it (its ticket's). */
export function knownIssueId(db: Database, launchId: string): string | undefined {
  return getTicketByLaunch(db, launchId)?.issueId?.trim() || undefined;
}

/**
 * Why a code_review stage can't apply to `run`, or null when it can: its
 * project has no code review to cut — no review gate, and its code-review
 * adapter requires no linked review — the launch's ticket names no issue id
 * or review either, and the checkout's remotes (read through `git`) are on
 * no code host an adapter reviews on (codeReviewRemote), or it has none. A
 * run with no known project, or whose checkout git can't read, keeps its
 * code_review stage.
 */
export function codeReviewNotApplicable(
  db: Database,
  run: PipelineRun,
  launch: Launch | null,
  git: GitRunner = defaultGitRunner
): string | null {
  const projectId = run.projectId ?? launch?.projectId;
  const project = projectId ? getProject(db, projectId) : null;
  if (!project) return null;
  if (project.reviewProcess === "command" || project.reviewProcess === "review-agent") return null;
  // A project opted in to a linked review cuts one whatever its checkout
  // shows. Asked of the adapter projectCodeReview resolves, as every other
  // question about the project's review is.
  if (projectCodeReview(db, project, { checkout: launch?.worktreePath, git }).requiresLinkedReview) return null;
  // A ticket that carries an issue id or a review already says this change
  // has a code review, whatever the project's registration shows.
  const ticket = getTicketByLaunch(db, run.launchId);
  if (ticket?.issueId?.trim() || ticket?.reviewUrl?.trim()) return null;
  // The registration alone is only a guess: the checkout itself has to show
  // a plain git repo — its remotes on no code-review host, or none at all (a
  // local-only repo). A checkout git can't read keeps the stage.
  const remotes = checkoutRemotes([launch?.worktreePath, ...project.repos], git);
  if (remotes === null || remotes.some((url) => codeReviewRemote(url))) return null;
  const where = remotes.length === 0 ? "it has no git remote" : `its remote ${remoteHost(remotes[0]!)} isn't a code-review host`;
  return `not applicable: project ${project.id} has no code review to cut (no linked review required, no review gate, and ${where})`;
}

/**
 * The remote urls of the first of `dirs` that is a git checkout (none for a
 * local-only repo), or null when git can read none of them.
 */
export function checkoutRemotes(dirs: Array<string | undefined>, git: GitRunner = defaultGitRunner): string[] | null {
  for (const dir of dirs) {
    const urls = readRemotes(dir, git);
    if (urls !== null) return urls;
  }
  return null;
}

/**
 * The remote urls of every one of `dirs` that is a git checkout, together
 * (none when each read is a local-only repo), or null when git can read none
 * of them.
 */
export function allCheckoutRemotes(dirs: Array<string | undefined>, git: GitRunner = defaultGitRunner): string[] | null {
  let read = false;
  const urls = new Set<string>();
  for (const dir of new Set(dirs)) {
    const listed = readRemotes(dir, git);
    if (listed === null) continue;
    read = true;
    for (const url of listed) urls.add(url);
  }
  return read ? [...urls] : null;
}

/** The remote urls of the git checkout `dir`, or null when it isn't one git can read. */
function readRemotes(dir: string | undefined, git: GitRunner): string[] | null {
  if (!dir || !existsSync(dir)) return null;
  if (git(["rev-parse", "--git-dir"], dir) === null) return null;
  const listed = git(["remote", "-v"], dir);
  if (listed === null) return null;
  const urls = listed
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((u): u is string => !!u);
  return [...new Set(urls)];
}

/** The host part of a remote url, for a reason line (never its credentials). */
function remoteHost(url: string): string {
  const scp = /^[^@/]+@([^:/]+):/.exec(url);
  if (scp) return scp[1]!;
  try {
    return new URL(url).host;
  } catch {
    return "(unreadable)";
  }
}

/**
 * Reflog entries that put a commit of the branch's own on it: one made there
 * (`commit`, amend and merge commits included), or its commits rewritten by a
 * rebase or cherry-pick. A reset, fast-forward or pull only moves it.
 */
const OWN_COMMIT_ENTRY = /^\S+ (?:commit\b|rebase\b.*\(finish\)|cherry-pick\b)/;

/**
 * Whether `branch`, read in the git checkout `dir`, carries work that landed
 * in `target` (or its remote ref, resolveTargetBranch — `origin/trunk`
 * for a `main` that tracks it): the newest commit made on the branch
 * (its newest OWN_COMMIT_ENTRY) is still its tip and is contained in the
 * target. Keyed on the branch's own commit, not just its tip, so a branch
 * reset or fast-forwarded onto the target after its work was abandoned
 * doesn't read as landed. A branch with no reflog (git can't tell) or no
 * commit of its own never counts. `remoteOnly` counts only the remote ref
 * — where a reviewed change lands — never a local branch anyone in the
 * checkout can move.
 */
export async function gitBranchLanded(dir: string, branch: string, target: string, opts: { remoteOnly?: boolean } = {}): Promise<boolean> {
  return branchLanded(dir, branch, target, opts, defaultGitRunner);
}

/** gitBranchLanded, read synchronously through `git` (a runner that returns null when git fails). */
export function branchLanded(
  dir: string,
  branch: string,
  target: string,
  opts: { remoteOnly?: boolean },
  git: GitRunner
): boolean {
  const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], dir);
  const log = git(["reflog", "show", "--format=%H %gs", `refs/heads/${branch}`, "--"], dir);
  if (!tip || log === null) return false;
  const entries = log.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = entries.find((e) => OWN_COMMIT_ENTRY.test(e))?.split(" ", 1)[0];
  if (!own || own !== tip) return false;
  const remote = resolveTargetBranch(dir, target, git).remote;
  for (const ref of opts.remoteOnly ? [remote] : [target, remote]) {
    if (ref.startsWith("-")) continue;
    // Contained in this ref when git exits 0; a missing ref or a commit it doesn't hold fails.
    if (git(["merge-base", "--is-ancestor", own, ref], dir) !== null) return true;
  }
  return false;
}

/**
 * Whether the launch's own work already landed in its target, read in its
 * checkout. Where the run has a code-review stage that applies — cut or not —
 * only the target's remote ref (resolveTargetBranch) counts: a change that goes through a code review lands upstream,
 * and a local branch can be moved from inside the checkout by anyone, the
 * worker included. A launch on the target itself never has.
 */
export function launchWorkLanded(db: Database, run: PipelineRun, launch: Launch, git: GitRunner = defaultGitRunner): boolean {
  const branch = launch.branch?.trim();
  const target = localTargetBranch(launch.worktreePath, launch.baseBranch, git);
  if (!branch || branch === target || launch.inPlace || launch.kind === "adopted") return false;
  if (!launch.worktreePath || !existsSync(launch.worktreePath)) return false;
  return branchLanded(launch.worktreePath, branch, target, { remoteOnly: codeReviewApplies(db, run, launch, git) }, git);
}

/**
 * Whether a launch outside the pipeline has a change of its own still to hand
 * over, read in its checkout: edits not yet committed, or commits on HEAD that
 * no copy of its base holds — and its branch's work hasn't already landed in
 * that base. A launch git can't read, or one with no checkout, has none.
 */
export function launchHasOwnChange(launch: Launch, git: GitRunner = defaultGitRunner): boolean {
  const dir = launch.worktreePath;
  if (!dir || !existsSync(dir)) return false;
  const dirty = git(["status", "--porcelain"], dir);
  if (dirty === null) return false;
  const { local: target, remote } = resolveTargetBranch(dir, launch.baseBranch, git);
  const branch = launch.branch?.trim();
  if (branch && branch !== target && branchLanded(dir, branch, target, {}, git)) return false;
  if (dirty) return true;
  const bases = [target, remote].filter(
    (ref) => !ref.startsWith("-") && git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir) !== null
  );
  if (bases.length === 0) return false;
  const ahead = git(["rev-list", "--count", "HEAD", "--not", ...bases], dir);
  return !!ahead && Number(ahead) > 0;
}

/** Whether `run` has a code_review stage that applies to its launch, whether or not it has run. */
export function codeReviewApplies(db: Database, run: PipelineRun, launch: Launch | null, git: GitRunner = defaultGitRunner): boolean {
  return run.definition.stages.some((s) => s.kind === CODE_REVIEW_STAGE_KIND) && !codeReviewNotApplicable(db, run, launch, git);
}


/**
 * Why `run` can't be handed to its owner for review yet, or null: its
 * launch's change isn't in the Review tab as it stands (reviewPacketReadyForLaunch
 * — none submitted, the newest was sent back for changes, or it was approved
 * at a commit the checkout has since moved past, see approvalIsCurrent), so
 * there would be nothing there to look at. The screenshots the run recorded are named,
 * since the packet carries them. Null while the packet can't be submitted
 * yet because it owes a code review whose code_review stage isn't done
 * (reviewPacketAwaitsCodeReview).
 */
export function reviewPacketNeeded(db: Database, run: PipelineRun, git: GitRunner = defaultGitRunner): string | null {
  const gate = reviewPacketGate(db, run, git);
  return gate.kind === "needed" ? gate.reason : null;
}

/**
 * Whether `run`'s launch is short of the packet the owner reviews, but can't
 * submit it yet: the packet must link the review its code_review stage cuts
 * (a project that requires a linked review) and is refused until that stage
 * is done, so the run goes through code_review first and human_review asks
 * for the packet.
 */
export function reviewPacketAwaitsCodeReview(db: Database, run: PipelineRun, git: GitRunner = defaultGitRunner): boolean {
  return reviewPacketGate(db, run, git).kind === "review-first";
}

type ReviewPacketGate = { kind: "none" } | { kind: "review-first" } | { kind: "needed"; reason: string };

function reviewPacketGate(db: Database, run: PipelineRun, git: GitRunner): ReviewPacketGate {
  const none: ReviewPacketGate = { kind: "none" };
  const launch = getLaunch(db, run.launchId);
  if (reviewPacketReadyForLaunch(db, run.launchId)) {
    const latest = latestSubmittedReviewPacketForLaunch(db, run.launchId);
    if (latest?.status !== "approved" || !launch || approvalIsCurrent(launch, latest, git, run, db)) return none;
  }
  // A launch with no trusted owner can't submit a packet (the review routes
  // refuse it), so the gate can't be met; it is not held to it.
  if (!launch || !reviewOwnerForLaunch(db, launch)) return none;
  // Work that already landed in its target has nothing left to review: its
  // job closes as landed, and a packet written now would only hold that up.
  if (launchWorkLanded(db, run, launch, git)) return none;
  // Read for the launch's project, as the submission it waits on is.
  if (codeReviewRequirement(db, launch.projectId || run.projectId, run.launchId, { git })?.pendingStages.length) return { kind: "review-first" };
  const shots = run.attempts.reduce((n, a) => {
    const list = (a.evidence as { screenshots?: unknown[] } | undefined)?.screenshots;
    return n + (Array.isArray(list) ? list.length : 0);
  }, 0);
  const media = shots > 0 ? ` Attach the ${plural(shots, "screenshot")} this run recorded as its media.` : "";
  return {
    kind: "needed",
    reason:
      "no review packet of this launch has reached the owner's Review tab: submit one with submit_review_packet " +
      `first — the owner reviews that packet, and a hand-off without it leaves them nothing to look at.${media}`,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Whether the owner's approval of `packet` still covers the launch's change:
 * it was given in `run`'s current epoch (not before the work was sent back),
 * the checkout has no uncommitted edits to tracked files, and it stands at
 * the commit the packet was submitted at — or at one whose change against
 * the base is the same (a rebase or squash). An approval given before the
 * work was redone is the owner's sign-off on other code. When git can't read
 * the checkout, or the packet named no commit, the commit checks stand aside.
 * Given `db` too, a run whose code_review stage applies, in a checkout whose
 * origin is on a code-review host, compares the change against the base's remote ref (resolveTargetBranch)
 * only — where its review is cut — never a local base anyone in the checkout can
 * move.
 */
export function approvalIsCurrent(
  launch: Launch,
  packet: { commitSha: string | null; decidedAt?: string | null },
  git: GitRunner = defaultGitRunner,
  run?: PipelineRun,
  db?: Database
): boolean {
  if (run && !decidedThisEpoch(run, packet.decidedAt)) return false;
  if (!launch.worktreePath) return true;
  const dir = launch.worktreePath;
  // Uncommitted edits to tracked files are a change the approval never saw.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"], dir);
  if (dirty === null) return true;
  if (dirty) return false;
  if (!packet.commitSha) return true;
  const head = git(["rev-parse", "HEAD"], dir);
  if (!head || head === packet.commitSha) return true;
  // A rebase or squash (the code-review flow) moves HEAD without changing the change:
  // the approval stands while the change itself — each side's diff from where
  // it forked off the base, binary content included — is the same. Either
  // copy of the base may be the one the rebase went onto, so a match against
  // any of them counts — only the remote one where a review is cut; both sides are
  // always read against the same one. Two empty diffs say nothing: a base
  // moved up to HEAD empties both.
  const { local: base, remote } = resolveTargetBranch(dir, launch.baseBranch, git);
  const commit = packet.commitSha;
  const remoteOnly = !!(db && run && codeReviewApplies(db, run, launch, git)) && cutsAgainstRemote(dir, remote, git);
  return (remoteOnly ? [remote] : [remote, base]).some((ref) => {
    if (ref.startsWith("-")) return false;
    const approved = git(["diff", "--binary", "--unified=3", `${ref}...${commit}`], dir);
    const now = git(["diff", "--binary", "--unified=3", `${ref}...HEAD`], dir);
    return !!approved?.trim() && now !== null && changeOf(approved) === changeOf(now);
  });
}

/**
 * Whether checkout `dir` cuts its review against `remote`, its base's remote
 * ref (resolveTargetBranch): its origin is on a code-review host
 * (codeReviewRemote) and that ref resolves. A checkout without one (a
 * local-only repo behind a review gate, or a remote kept behind the local
 * base) is compared against its local base too.
 */
function cutsAgainstRemote(dir: string, remote: string, git: GitRunner): boolean {
  const url = git(["remote", "get-url", "origin"], dir);
  if (!url || !codeReviewRemote(url) || remote.startsWith("-")) return false;
  return git(["rev-parse", "--verify", "--quiet", `${remote}^{commit}`], dir) !== null;
}

/**
 * A diff reduced to the change it makes: without its `index <sha>..<sha>`
 * lines and hunk headers — the line numbers, and the enclosing-function text
 * git appends — which a rebase moves though the change is the same. The
 * context lines stay, so the same lines added somewhere else in a file are a
 * different change. With --binary the content of a binary file stays in, so
 * two different versions of one never compare equal.
 */
function changeOf(diff: string): string {
  return diff
    .split("\n")
    .filter((l) => !l.startsWith("index "))
    .map((l) => (l.startsWith("@@ ") ? "@@" : l))
    .join("\n");
}

/**
 * Whether a decision made at `decidedAt` belongs to the run's current round
 * of work: one made before the work was sent back — for rework (the newest
 * attempt of an earlier epoch), or by the owner's send-back at human review —
 * was about the change as it was then. A send-back the run already acted on
 * is that history too. Epoch 0 with no send-back takes any.
 */
export function decidedThisEpoch(run: PipelineRun, decidedAt: string | null | undefined): boolean {
  const sentBack = run.attempts
    .filter((a) => {
      const kind = run.definition.stages.find((s) => s.id === a.stageId)?.kind;
      return kind === HUMAN_REVIEW_STAGE_KIND && (a.evidence as { decision?: unknown } | undefined)?.decision === "changes_requested";
    })
    .at(-1)?.createdAt;
  if (sentBack && (!decidedAt || Date.parse(decidedAt) <= Date.parse(sentBack))) return false;
  const epoch = run.epoch ?? 0;
  if (epoch === 0) return true;
  const reopened = run.attempts.filter((a) => (a.epoch ?? 0) < epoch).at(-1)?.createdAt;
  if (!reopened || !decidedAt) return !reopened;
  // Strictly after: a decision stamped the same moment as the reopening
  // can't be told to have followed it.
  return Date.parse(decidedAt) > Date.parse(reopened);
}

/**
 * Opens the owner's draft review packet for `run`'s launch and steers its
 * worker with the review-writer brief (the change's refs, files and
 * checkpoints), when the run was held for a packet (reviewPacketNeeded) and
 * no draft is open yet — so the worker learns what the packet needs once,
 * not on every refusal. A failure is logged and never fails the caller.
 */
export function briefReviewPacket(db: Database, run: PipelineRun, deps: Pick<PipelineDeps, "broadcast" | "reviewScratchDir">): void {
  try {
    const launch = getLaunch(db, run.launchId);
    const owner = launch ? reviewOwnerForLaunch(db, launch) : null;
    if (!launch || !owner || !launch.sessionId) return;
    if (findDraftReviewPacketForLaunch(db, owner, launch.id)) return;
    if (launchWorkLanded(db, run, launch)) return;
    onEnterHumanReview(
      db,
      {
        owner,
        launchId: launch.id,
        sessionId: launch.sessionId,
        jobId: personaJobForLaunch(db, launch.id)?.job.id,
        projectId: launch.projectId || undefined,
        pipelineRunId: run.id,
        worktree: launch.worktreePath || undefined,
        scratchDir: deps.reviewScratchDir(launch.id),
      },
      { broadcast: deps.broadcast }
    );
  } catch (err) {
    console.error(`[pipeline] briefing run ${run.id}'s review packet failed:`, err);
  }
}

/** The ids of `rootId` and every subagent session beneath it. */
export function sessionTree(db: Database, rootId: string): string[] {
  const rows = db
    .query(
      `WITH RECURSIVE tree(id, depth) AS (
         SELECT ?, 0
         UNION
         SELECT s.id, t.depth + 1 FROM sessions s JOIN tree t ON s.parent_session_id = t.id WHERE t.depth < ?
       )
       SELECT id FROM tree`
    )
    .all(rootId, MAX_SESSION_DEPTH) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: scrubSecretEnv() });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${proc.exitCode}: ${err.trim().slice(-300)}`);
  return out;
}

/**
 * Files changed in `worktreePath` since it left `baseBranch`: the diff of the
 * working tree against the merge base of HEAD and the base branch, plus
 * untracked files. Both copies of the base branch are tried (local and
 * `origin/`) and the newest of their merge bases wins — either can be the
 * stale one (a merge that landed locally and was never pushed, or a local
 * branch behind its remote), and the older base would put every file merged
 * since into the change. Throws when the directory isn't a git checkout or no
 * base resolves.
 */
export async function gitChangedFiles(worktreePath: string, baseBranch: string | undefined): Promise<string[]> {
  const base = baseBranch?.trim();
  if (!base) throw new Error("the launch has no base branch");
  const bases: string[] = [];
  for (const ref of [base, resolveTargetBranch(worktreePath, base, defaultGitRunner).remote]) {
    try {
      const found = (await git(worktreePath, ["merge-base", "HEAD", ref])).trim();
      if (found && !bases.includes(found)) bases.push(found);
    } catch {
      // This copy of the base branch is missing; try the next.
    }
  }
  let mergeBase = bases[0];
  for (const candidate of bases.slice(1)) {
    try {
      await git(worktreePath, ["merge-base", "--is-ancestor", mergeBase!, candidate]);
      mergeBase = candidate;
    } catch {
      // `candidate` isn't newer (or they are unrelated); keep the one we have.
    }
  }
  if (!mergeBase) throw new Error(`no merge base between HEAD and ${base}`);
  const diff = await git(worktreePath, ["diff", "--name-only", mergeBase]);
  const untracked = await git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...diff.split("\n"), ...untracked.split("\n")].map((l) => l.trim()).filter(Boolean))];
}

/** The uiPaths of the first stage that declares them (the screenshot stage's), for computing facts. */
export function definitionUiPaths(def: PipelineDefinition): string[] | undefined {
  return def.stages.find((s) => s.uiPaths && s.uiPaths.length > 0)?.uiPaths;
}

/** The changed files the worker reported across the run's attempts. */
export function reportedChangedFiles(run: PipelineRun): string[] {
  return run.attempts.flatMap((a) => {
    const files = (a.evidence as { changedFiles?: unknown } | undefined)?.changedFiles;
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  });
}

/**
 * The change's facts from the launch's changed files (launchChangedFiles) unioned with
 * `reported` (the worker's list), and that union; null facts when neither git
 * nor the worker named any file. `fromGit` says whether git answered at all.
 */
export async function changeFacts(
  launch: Launch | null,
  reported: string[],
  uiPaths: string[] | undefined,
  deps: PipelineDeps
): Promise<{ facts: PipelineFacts | null; files: string[]; fromGit: boolean }> {
  let files: string[] | null = null;
  if (launch?.worktreePath) {
    try {
      files = await launchChangedFiles(launch, deps.changedFiles);
    } catch {
      // git couldn't tell (not a checkout, no base); the worker's list stands alone.
      files = null;
    }
  }
  const union = [...new Set([...(files ?? []), ...reported])];
  const fromGit = files !== null;
  if (!fromGit && reported.length === 0) return { facts: null, files: union, fromGit };
  return { facts: computeFacts(launch ? matchPaths(launch, union) : union, uiPaths), files: union, fromGit };
}

/**
 * `files` as path globs are matched against: on a provisioned workspace each
 * file under a package (labelled `<packagesDir>/<pkg>/…`, launchChangedFiles) also as
 * its path inside that package, so a glob anchored at a package's root
 * still matches it.
 */
export function matchPaths(launch: Launch, files: string[]): string[] {
  const paths = pathsToMatch(launch);
  return [...new Set(files.flatMap(paths))];
}

/** One file's paths as matchPaths gives them, with the launch's package labels read once. */
export function pathsToMatch(launch: Launch): (file: string) => string[] {
  const labels = workingDirCheckouts(launch).flatMap((c) => (c.label ? [`${c.label}/`] : []));
  return (file) => [file, ...labels.filter((l) => file.startsWith(l)).map((l) => file.slice(l.length))];
}

// ----------------------------------------------------------------------------
// Outward stages: the floor asks.
// ----------------------------------------------------------------------------

/**
 * The safety-floor asks the launch's session (and its subagents) raised since
 * the run entered its current stage — the record of what the floor held while
 * an outward stage ran.
 */
export function floorAsksDuringStage(db: Database, run: PipelineRun, launch: Launch | null): FloorAskRecord[] {
  if (!launch?.sessionId) return [];
  const ids = sessionTree(db, launch.sessionId);
  const rows = db
    .query(
      `SELECT id, gate, question, answer, status FROM asks
        WHERE session_id IN (${ids.map(() => "?").join(", ")})
          AND gate IN (?, ?)
          AND datetime(created_at) >= datetime(?)
        ORDER BY created_at, rowid`
    )
    .all(...ids, FLOOR_GATE, FLOOR_OWNER_GATE, run.stageEnteredAt) as Array<{
    id: string;
    gate: string;
    question: string;
    answer: string | null;
    status: string;
  }>;
  return rows.map((r) => ({
    askId: r.id,
    gate: r.gate,
    question: r.question,
    ...(r.answer !== null ? { answer: r.answer } : {}),
    status: r.status,
  }));
}

/** Whether one of `asks` is an owner-gate floor ask the owner allowed. */
export function hasOwnerAllowedFloorAsk(asks: FloorAskRecord[]): boolean {
  return asks.some((a) => a.gate === FLOOR_OWNER_GATE && a.status === "answered" && floorAnswerAllows(a.answer));
}

/**
 * Completes an outward stage's evidence with the floor asks raised during it
 * (whatever the worker reported there is replaced). With `requireOwnerGate`,
 * a worker's report is refused until one of them is an owner-allowed
 * owner-gate ask; the review gate's own record is not (Standup ran the gate).
 */
export function prepareOutwardEvidence(ctx: StageRunnerContext): PreparedEvidence {
  const asks = floorAsksDuringStage(ctx.db, ctx.run, ctx.launch);
  if (ctx.stage.requireOwnerGate && ctx.source !== "review_gate" && !hasOwnerAllowedFloorAsk(asks)) {
    return {
      error: `The ${ctx.stage.id} stage requires an owner-approved floor ask (${FLOOR_OWNER_GATE}) during the stage`,
      status: 422,
      missing: ["evidence.floorAsks (an owner-allowed safety_floor_owner ask raised during this stage)"],
    };
  }
  return { evidence: { ...ctx.evidence, floorAsks: asks } };
}

// ----------------------------------------------------------------------------
// Built-in runners.
// ----------------------------------------------------------------------------

registerPipelineStageRunner("coding", {
  // Leaving coding fixes the change's facts: git's changed files unioned with the worker's list.
  async prepareEvidence(ctx) {
    const reported = Array.isArray(ctx.evidence.changedFiles) ? (ctx.evidence.changedFiles as string[]) : [];
    const { facts, files } = await changeFacts(ctx.launch, reported, ctx.stage.uiPaths ?? definitionUiPaths(ctx.run.definition), ctx.deps);
    if (!facts) return { evidence: ctx.evidence };
    return { evidence: { ...ctx.evidence, changedFiles: files }, facts };
  },
});

/**
 * Runs the stage's checks that apply to the change (its files as coding
 * fixed them: git's unioned with the worker's reports) and records each,
 * the ones whose paths no changed file matches as skipped. When git can't
 * name the change, every check runs: the worker's own list may add files but
 * never narrows which checks apply.
 */
async function runValidationChecks(ctx: StageRunnerContext, launch: Launch, deadline: number): Promise<ValidationCheckResult[]> {
  const checks = ctx.stage.checks ?? [];
  if (checks.length === 0) return [];
  const known = await changeFacts(launch, reportedChangedFiles(ctx.run), undefined, ctx.deps);
  const files = known.fromGit ? matchPaths(launch, known.files) : [];
  const results: ValidationCheckResult[] = [];
  for (const check of checks) {
    if (!checkApplies(check, files)) {
      results.push({ command: check.command, met: true, output: "no changed file matches its paths", skipped: true });
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining < MIN_CHECK_TIMEOUT_MS) {
      results.push({ command: check.command, met: false, output: "the validation's time budget ran out before this check ran" });
      continue;
    }
    const timeoutMs = Math.min(check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, remaining);
    const { met, output } = await ctx.deps.runCheck(launch, check.command, timeoutMs);
    results.push({ command: check.command, met, output });
  }
  return results;
}

type ServerValidation = { criterion: Awaited<ReturnType<PipelineDeps["runCriterion"]>>; checks: ValidationCheckResult[] };

/**
 * The server-run part of a validation in flight, by run and visit to the
 * stage. A worker whose pipeline_advance timed out client-side calls again
 * while the first call's checks still run; the second call waits on those
 * rather than starting a second set beside them. A later visit (after a
 * waiver or a loop back through coding) is new code and runs its own.
 */
const validationsInFlight = new Map<string, Promise<ServerValidation>>();

function validationVisitKey(run: StageRunnerContext["run"]): string {
  return `${run.id}:${run.epoch ?? 0}:${run.stageEnteredAt}`;
}

/** The criterion and the applicable checks, together within VALIDATION_CHECK_BUDGET_MS. */
async function runServerValidation(ctx: StageRunnerContext, launch: Launch): Promise<ServerValidation> {
  const deadline = Date.now() + VALIDATION_CHECK_BUDGET_MS;
  const criterion = await ctx.deps.runCriterion(launch);
  const checks = await runValidationChecks(ctx, launch, deadline);
  return { criterion, checks };
}

registerPipelineStageRunner("validation", {
  // The acceptance criterion and the checks are the server's to run; whatever the worker put there is dropped.
  async prepareEvidence(ctx) {
    const { criterion: _criterion, checks: _checks, ...evidence } = ctx.evidence;
    if (!ctx.launch) return { evidence };
    const key = validationVisitKey(ctx.run);
    let pending = validationsInFlight.get(key);
    if (!pending) {
      pending = runServerValidation(ctx, ctx.launch).finally(() => validationsInFlight.delete(key));
      validationsInFlight.set(key, pending);
    }
    const { criterion, checks } = await pending;
    return {
      evidence: {
        ...evidence,
        ...(criterion ? { criterion } : {}),
        ...(checks.length > 0 ? { checks } : {}),
      },
    };
  },
});

/** The most screenshots one advance may record. */
export const MAX_SCREENSHOTS_PER_ADVANCE = 10;

/** The most screenshot bytes one advance may record, all files together. */
export const MAX_SCREENSHOT_TOTAL_BYTES = 100 * 1024 * 1024;

/** The stored copy's name for screenshot `index` of attempt `attemptId` — derived from ids alone. */
export function screenshotCopyName(attemptId: string, index: number): string {
  return `${attemptId}-${index}.png`;
}

registerPipelineStageRunner("screenshot", {
  // Each path is validated and its bytes copied into the collector's store
  // under the attempt's id, one file at a time (so at most one file's bytes
  // are held at once); the console is only ever served the copy.
  prepareEvidence(ctx) {
    const shots = ctx.evidence.screenshots as Array<Record<string, unknown>>;
    if (shots.length > MAX_SCREENSHOTS_PER_ADVANCE) {
      return {
        error: "Too many screenshots",
        status: 422,
        missing: [`evidence.screenshots (at most ${MAX_SCREENSHOTS_PER_ADVANCE} per advance)`],
      };
    }
    const problems: string[] = [];
    const stored: string[] = [];
    const cleanup = () => {
      for (const p of stored) ctx.deps.screenshots.remove(p);
    };
    const screenshots: Array<Record<string, unknown>> = [];
    let total = 0;
    try {
      for (const [i, shot] of shots.entries()) {
        const check = ctx.deps.validateScreenshot(String(shot.path));
        if (!check.ok) {
          problems.push(`evidence.screenshots[${i}].path (${check.error})`);
          continue;
        }
        total += check.bytes.length;
        if (total > MAX_SCREENSHOT_TOTAL_BYTES) {
          cleanup();
          return {
            error: "The screenshots are too large together",
            status: 422,
            missing: [`evidence.screenshots (at most ${MAX_SCREENSHOT_TOTAL_BYTES / (1024 * 1024)} MB in all)`],
          };
        }
        // Once one path is refused nothing is stored; the rest are still checked so every problem is named.
        if (problems.length > 0) continue;
        const storedPath = ctx.deps.screenshots.save(ctx.run.id, screenshotCopyName(ctx.attemptId, i), check.bytes);
        stored.push(storedPath);
        screenshots.push({
          path: check.path,
          storedPath,
          ...(typeof shot.caption === "string" ? { caption: shot.caption } : {}),
          width: check.width,
          height: check.height,
        });
      }
    } catch (err) {
      cleanup();
      return { error: `The screenshots could not be stored: ${(err as Error).message}`, status: 422, missing: [] };
    }
    if (problems.length > 0) {
      cleanup();
      return { error: "Some screenshots can't be accepted", status: 422, missing: problems };
    }
    return { evidence: { ...ctx.evidence, screenshots }, cleanup };
  },
  // Entering the stage means the change is UI-visible (the stage auto-skips
  // otherwise), so a project that serves its UI for review gets its tunnel
  // to the branch build here: the screenshots can be shot against it, and it
  // stays up through human review until the job closes or the review is decided.
  onEnter(ctx) {
    if (ctx.run.definition.reviewTunnel) ctx.deps.openReviewTunnel?.(ctx.run);
  },
});

/** The review urls already recorded at `stageId` in earlier rounds of the run. */
function recordedReviewUrls(run: PipelineRun, stageId: string): Set<string> {
  const urls = new Set<string>();
  for (const a of run.attempts) {
    const url = (a.evidence as { url?: unknown } | undefined)?.url;
    if (a.stageId === stageId && typeof url === "string") urls.add(url);
  }
  return urls;
}

registerPipelineStageRunner(CODE_REVIEW_STAGE_KIND, {
  // A worker's issue id must be the one Standup knows (the ticket's) when it
  // knows one; the review gate's record takes the known id when it has one.
  prepareEvidence(ctx) {
    const known = knownIssueId(ctx.db, ctx.run.launchId);
    const given = typeof ctx.evidence.issueId === "string" ? ctx.evidence.issueId.trim() : "";
    if (ctx.source === "review_gate") {
      const issueId = given || known;
      return { evidence: { ...ctx.evidence, source: "review_gate", ...(issueId ? { issueId } : {}) } };
    }
    if (known && given !== known) {
      return {
        error: `The code review's issue id must be the ticket's (${known})`,
        status: 422,
        missing: [`evidence.issueId (${known}, the ticket's issue id)`],
      };
    }
    return { evidence: { ...ctx.evidence, issueId: given, source: "worker" } };
  },
  // A review already on the ticket before the run reached code_review is
  // recorded as soon as the run gets here (as the gate's or the worker's, see
  // StageEnterContext.recordReviewUrl) — unless an earlier round already
  // recorded that same review.
  async onEnter(ctx) {
    const url = getTicketByLaunch(ctx.db, ctx.run.launchId)?.reviewUrl?.trim();
    if (!url || !isHttpUrl(url) || recordedReviewUrls(ctx.run, ctx.stage.id).has(url)) return;
    await ctx.recordReviewUrl(url);
  },
  notApplicable: (ctx) => codeReviewNotApplicable(ctx.db, ctx.run, ctx.launch),
  // Past the code_review stage the run is the owner's: everything left (the
  // review, the human review) asks them to look at the change, so the packet
  // they look at must be in the Review tab before the run gets there — unless
  // that packet must link the review cut here, in which case human_review asks for it.
  entryBlock: (ctx) => reviewPacketNeeded(ctx.db, ctx.run),
});
