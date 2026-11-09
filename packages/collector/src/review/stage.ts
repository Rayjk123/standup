import type { Database } from "bun:sqlite";
import type { Launch, ReviewPacket, Session, WsMessage } from "@standup/shared";
import {
  createReviewPacket,
  createSteer,
  findDraftReviewPacketForLaunch,
  findLaunchByCwd,
  getCheckpointsBySession,
  getLaunch,
  getLaunchBySession,
  personaJobForLaunch,
} from "@standup/store";
import { scratchRoot } from "@standup/shared/scratch";
import { launchScratchId } from "../floor/launch.js";
import { scrubSecretEnv } from "../owner-secret.js";
import { FALLBACK_BRANCH, resolveTargetBranch } from "../target-branch.js";
import { codeReviewRequirement } from "./code-review-requirement.js";
import { isOwnDirectory, launchScratchMediaDir } from "./media.js";
import { buildReviewWriterBrief } from "./writer-brief.js";

/** The alias a request with no trusted identity resolves to (server.ts ANONYMOUS_ALIAS). */
export const ANONYMOUS_ALIAS = "anonymous";

/** Runs `git <args>` in `cwd`; its trimmed stdout, or null when git fails or times out. */
export type GitRunner = (args: string[], cwd: string) => string | null;

const GIT_TIMEOUT_MS = 10_000;
/** How deep a subagent's parent chain is followed to its launch. */
const MAX_SESSION_DEPTH = 5;
const BRIEF_CHECKPOINTS = 10;

/** git, run directly (no shell) with the collector's secrets scrubbed from its environment. */
export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: scrubSecretEnv(),
      timeout: GIT_TIMEOUT_MS,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
};

/** A change's refs and the files it touches, as git reports them in its worktree. */
export interface ReviewRefs {
  branch?: string;
  headSha?: string;
  baseSha?: string;
  /** Null when git could not list them. */
  changedFiles: string[] | null;
  diffStat?: string;
}

/**
 * The refs of the change checked out in `worktree`: its branch and head, and
 * its base — the merge base of HEAD with the branch the work is actually
 * based on. Every candidate is tried (the launch's base branch and main,
 * local then its remote ref, resolveTargetBranch) and the newest of their merge bases wins
 * (newestBase), because either copy of the target branch can be the stale
 * one: merges can land on the local branch without ever being pushed, and a
 * local branch can equally sit behind its remote. Taking the older base would
 * put every file merged since into the change, and submitting a packet would
 * then need a fetch or push first.
 */
export function reviewRefs(worktree: string, git: GitRunner = defaultGitRunner, baseBranch?: string): ReviewRefs {
  const branchName = git(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
  const headSha = git(["rev-parse", "HEAD"], worktree) || undefined;
  const base = baseBranch?.trim();
  const fallback = resolveTargetBranch(worktree, FALLBACK_BRANCH, git);
  const candidates = [
    ...(base ? [base, resolveTargetBranch(worktree, base, git).remote] : []),
    fallback.local,
    fallback.remote,
  ].filter((ref, i, all) => all.indexOf(ref) === i);
  const bases = candidates.flatMap((ref) => {
    const found = git(["merge-base", "HEAD", ref], worktree);
    return found ? [found] : [];
  });
  const baseSha = newestBase(bases, worktree, git);
  let changedFiles: string[] | null = null;
  let diffStat: string | undefined;
  if (baseSha) {
    const names = git(["diff", "--name-only", `${baseSha}..HEAD`], worktree);
    changedFiles = names === null ? null : names.split("\n").map((l) => l.trim()).filter(Boolean);
    diffStat = git(["diff", "--shortstat", `${baseSha}..HEAD`], worktree) || undefined;
  }
  return {
    branch: branchName && branchName !== "HEAD" ? branchName : undefined,
    headSha,
    baseSha,
    changedFiles,
    diffStat,
  };
}

/**
 * The newest of `bases`: the one every other is an ancestor of. Undefined
 * when there are none, and the first when they are unrelated (no candidate
 * contains the rest), so a base is always picked from what git could read.
 */
function newestBase(bases: string[], worktree: string, git: GitRunner): string | undefined {
  const unique = [...new Set(bases)];
  if (unique.length <= 1) return unique[0];
  const newest = unique.find((candidate) =>
    unique.every((other) => other === candidate || git(["merge-base", "--is-ancestor", other, candidate], worktree) !== null)
  );
  return newest ?? unique[0];
}

/** The launch `sessionId` belongs to, following a subagent's parent sessions. */
export function launchForSession(db: Database, sessionId: string): Launch | null {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < MAX_SESSION_DEPTH; depth++) {
    const launch = getLaunchBySession(db, current);
    if (launch) return launch;
    const row = db.query("SELECT parent_session_id FROM sessions WHERE id = ?").get(current) as
      | { parent_session_id: string | null }
      | null;
    current = row?.parent_session_id ?? null;
  }
  return null;
}

/**
 * Whose review a launch's change is: who the collector resolved as launching
 * it (launchedBy), else its Persona job's owner; null when neither names
 * anyone, so the launch has no trusted owner. The launch's `requester` is a
 * caller-named actor and is never used here.
 */
export function reviewOwnerForLaunch(db: Database, launch: Launch): string | null {
  const launchedBy = launch.launchedBy?.trim();
  if (launchedBy && launchedBy !== ANONYMOUS_ALIAS) return launchedBy;
  const jobOwner = personaJobForLaunch(db, launch.id)?.job.owner?.trim();
  if (jobOwner && jobOwner !== ANONYMOUS_ALIAS) return jobOwner;
  return null;
}

/**
 * Whether the launch's worktree path is a checkout Standup made for this
 * launch: a worktree or bootstrap launch that neither works in place (the
 * project's real repo, or another launch's tree it reuses, both recorded as
 * `inPlace`) nor in a dir a project `provision` command made. Any other
 * launch's tree is shared with something it doesn't own.
 */
export function launchOwnsWorktree(launch: Launch): boolean {
  return (launch.kind === "worktree" || launch.kind === "bootstrap") && !launch.inPlace && !launch.provisioned;
}

/**
 * The launch's whole working dir when review media may be read from it, else
 * undefined: a worktree or bootstrap launch's tree that is not shared with
 * anything else (not `inPlace`), including a dir a project `provision`
 * command made for this launch (a whole multi-repo workspace, not only the
 * package the worker starts in), and only while it is a real directory of
 * this user's, not a symlink to somewhere else. The review brief names
 * exactly this, the launch's TMPDIR scratch dir (reviewMediaLaunchScratch)
 * and its review scratch dir, and submit_review_packet accepts media from
 * exactly those.
 */
export function reviewMediaWorktree(launch: Launch): string | undefined {
  const ownTree = (launch.kind === "worktree" || launch.kind === "bootstrap") && !launch.inPlace;
  const tree = ownTree ? launch.worktreePath || undefined : undefined;
  return tree && isOwnDirectory(tree) ? tree : undefined;
}

/**
 * The launch's own scratch dir, its TMPDIR (`<root>/<launchScratchId>`), when
 * review media may be read from it (launchScratchMediaDir), else undefined.
 * `root` defaults to the scratch root the launcher makes TMPDIRs under.
 */
export function reviewMediaLaunchScratch(
  db: Database,
  launch: Pick<Launch, "id" | "kind" | "sessionId">,
  root: string = scratchRoot()
): string | undefined {
  return launchScratchMediaDir(root, launchScratchId(db, launch));
}

/** The worker a review request comes from, resolved server-side from its session or cwd. */
export interface ReviewWorker {
  session: Session | null;
  launch: Launch;
  /** Null when the launch has no trusted owner (reviewOwnerForLaunch). */
  owner: string | null;
  jobId?: string;
  projectId?: string;
  worktree?: string;
}

/**
 * The calling worker's launch, from its session (a subagent through its
 * parents), else from its cwd; null when neither names a launch.
 */
export function resolveReviewWorker(
  db: Database,
  input: { sessionId?: string | null; cwd?: string | null },
  resolveCallingSession: (sessionId: string | null | undefined, cwd: string) => Session | null
): ReviewWorker | null {
  const session = resolveCallingSession(input.sessionId, input.cwd ?? "");
  const launch = session ? launchForSession(db, session.id) : input.cwd ? findLaunchByCwd(db, input.cwd) : null;
  if (!launch) return null;
  return {
    session,
    launch,
    owner: reviewOwnerForLaunch(db, launch),
    jobId: personaJobForLaunch(db, launch.id)?.job.id,
    projectId: launch.projectId || undefined,
    worktree: launch.worktreePath || undefined,
  };
}

/** The calling worker and its change's refs (null refs when its worktree is unknown). */
export function reviewContextForSession(
  db: Database,
  input: { sessionId?: string | null; cwd?: string | null },
  resolveCallingSession: (sessionId: string | null | undefined, cwd: string) => Session | null,
  git: GitRunner = defaultGitRunner
): { worker: ReviewWorker; refs: ReviewRefs | null } | null {
  const worker = resolveReviewWorker(db, input, resolveCallingSession);
  if (!worker) return null;
  return { worker, refs: worker.worktree ? reviewRefs(worker.worktree, git, worker.launch.baseBranch) : null };
}

export interface HumanReviewEntry {
  owner: string;
  launchId: string;
  sessionId: string;
  jobId?: string;
  projectId?: string;
  pipelineRunId?: string;
  worktree?: string;
  /** The launch's review scratch dir (ensureReviewScratchDir), named in the brief. */
  scratchDir?: string;
  /** The root the launch's TMPDIR scratch dir is under (default: scratchRoot()). */
  scratchRoot?: string;
}

export interface HumanReviewDeps {
  git?: GitRunner;
  broadcast?: (message: WsMessage) => void;
  /** Whether the brief is queued to the session as a steer (default true). */
  queueSteer?: boolean;
  /** The launch's checkout reads as changing no code, so a code review owed only for code isn't asked for (see CodeReviewRequirement.onlyForCode). */
  changesNoCode?: boolean;
}

/**
 * Enters human review for a launch: reuses the owner's draft packet for it or
 * creates one carrying the change's refs, builds the review-writer brief from
 * the change's files and the session's checkpoints, and (unless told not to)
 * queues the brief to the session as a steer.
 */
export function onEnterHumanReview(
  db: Database,
  ctx: HumanReviewEntry,
  deps: HumanReviewDeps = {}
): { packet: ReviewPacket; brief: string; steerId?: string } {
  const git = deps.git ?? defaultGitRunner;
  const launch = getLaunch(db, ctx.launchId);
  const refs = ctx.worktree ? reviewRefs(ctx.worktree, git, launch?.baseBranch) : null;
  const packet =
    findDraftReviewPacketForLaunch(db, ctx.owner, ctx.launchId) ??
    createReviewPacket(db, {
      owner: ctx.owner,
      launchId: ctx.launchId,
      sessionId: ctx.sessionId,
      jobId: ctx.jobId,
      projectId: ctx.projectId,
      pipelineRunId: ctx.pipelineRunId,
      branch: refs?.branch,
      commitSha: refs?.headSha,
      baseSha: refs?.baseSha,
    });
  const checkpoints = getCheckpointsBySession(db, ctx.sessionId)
    .slice(-BRIEF_CHECKPOINTS)
    .map((c) => c.summary);
  const owed = codeReviewRequirement(db, ctx.projectId ?? launch?.projectId, ctx.launchId, { git });
  const review = owed?.onlyForCode && deps.changesNoCode ? null : owed;
  const brief = buildReviewWriterBrief({
    packetId: packet.id,
    branch: refs?.branch ?? packet.branch ?? undefined,
    baseSha: refs?.baseSha ?? packet.baseSha ?? undefined,
    headSha: refs?.headSha ?? packet.commitSha ?? undefined,
    changedFiles: refs?.changedFiles ?? [],
    checkpoints,
    diffStat: refs?.diffStat,
    scratchDir: ctx.scratchDir,
    mediaWorktree: launch ? reviewMediaWorktree(launch) : undefined,
    launchScratchDir: launch ? reviewMediaLaunchScratch(db, launch, ctx.scratchRoot) : undefined,
    ...(review
      ? {
          codeReview: {
            ...(review.recorded ? { recorded: review.recorded } : {}),
            howToCut: review.howToCut,
            noun: review.adapter.noun,
            link: review.adapter.exampleLink(review.recorded),
          },
        }
      : {}),
  });
  if (deps.queueSteer === false) return { packet, brief };
  const steer = createSteer(db, ctx.sessionId, brief, { audience: ctx.owner });
  deps.broadcast?.({
    type: "steer:queued",
    payload: steer,
    timestamp: new Date().toISOString(),
    audience: ctx.owner,
    requireProof: true,
  });
  return { packet, brief, steerId: steer.id };
}
