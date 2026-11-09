import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type {
  Launch,
  PipelineRun,
  Project,
  TaskRun,
  Ticket,
  TicketAttempt,
  WsMessage,
} from "@standup/shared";
import {
  getTaskRun,
  getTaskRunsByAttemptGroup,
  getActiveTaskRunByWorktree,
  setTaskRunAttemptStatus,
  updateTaskRunStatus,
  getLaunchByWorktree,
  getTicket,
  setTicketLaunch,
  setTicketSession,
  setTicketAttemptGroup,
  setTicketError,
  clearReviewUrl,
  countActiveTaskRuns,
} from "@standup/store";
import { launchSession, MAX_ACTIVE_TASK_RUNS } from "./launcher.js";
import { hostUserAlias } from "./host-user.js";
import { startPickedAttemptPipeline, type PickedAttemptPipeline } from "./pipeline/engine.js";
import { defaultGitRunner } from "./review/stage.js";
import { resolveTargetBranch } from "./target-branch.js";

/**
 * How many parallel attempts a single dispatch may fan out to. Bounded because
 * each attempt is a full worktree + `claude` session — the cost grows linearly
 * and the global concurrency cap (launcher's MAX_ACTIVE_TASK_RUNS) is shared
 * across every ticket, so an unbounded N would starve the fleet.
 */
export const MAX_ATTEMPTS = 4;

/** Clamps a requested attempt count into 1..MAX_ATTEMPTS, defaulting to 1. */
export function clampAttempts(n: number | undefined): number {
  if (!Number.isFinite(n as number)) return 1;
  return Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(n as number)));
}

/**
 * The launch seam best-of-N dispatch fires each attempt through — exactly
 * launchSession's signature, so the real launcher is the default and a test
 * passes a mock that records rows WITHOUT spawning a worktree or tmux session.
 */
export type AttemptLauncher = typeof launchSession;

/** launchSession's `onUpdate` broadcast callback (its 3rd argument). */
type LaunchOnUpdate = Parameters<AttemptLauncher>[2];

/** launchSession's retrieval argument (its 4th argument), threaded unchanged. */
type LaunchRetrieval = Parameters<AttemptLauncher>[3];

export interface DispatchAttemptsInput {
  ticket: Ticket;
  project: Project;
  /** Requested attempt count; clamped to 1..MAX_ATTEMPTS. */
  attempts: number;
  /** Dispatching user's alias, stamped on every attempt's launch + run. */
  requester?: string;
  /**
   * Server-resolved identity that scopes the knowledge injected into each
   * attempt's opening prompt — distinct from `requester` (see LaunchRequest),
   * so the caller cannot steer which user's user-scoped docs are injected.
   */
  retrievalUser?: string;
  /** Who launched the attempts, as the server resolved it (LaunchRequest.launchedBy). */
  launchedBy?: string;
  /** Product/spec retrieval passed to each attempt's launch (roadmap r8). */
  retrieval?: LaunchRetrieval;
}

export interface DispatchAttemptsResult {
  attemptGroup: string;
  launches: Launch[];
  runs: TaskRun[];
}

/**
 * Dispatches a ticket as N parallel best-of-N attempts. Each attempt is fired
 * through the injected launcher seam, which provisions its own git worktree and
 * dispatcher-ledger run; all N runs share a freshly minted `attemptGroup` (also
 * stamped on the ticket) so the compare + pick flow can find them later.
 *
 * The shared concurrency budget is checked up front: each launch re-checks the
 * launcher's global cap and throws once it is hit, so dispatching N attempts
 * with fewer than N free slots would otherwise spawn a partial group and then
 * throw mid-loop — leaving already-live agents the caller thinks never started.
 * The pre-check refuses the whole dispatch (zero side effects) unless the fleet
 * has room for all N.
 *
 * The group is stamped on the ticket the instant the FIRST attempt is live (and
 * the ticket anchored to that attempt's launch, which the SessionStart
 * auto-advance moves approved -> developing). A human later repoints the ticket
 * at whichever attempt they pick (pickAttempt). Because the group is stamped
 * after attempt 1 succeeds, a later transient launcher error (a git/tmux hiccup
 * on attempt i>1) does NOT orphan the attempts already spawned: they stay
 * reachable — and stoppable — through the ticket's group, and the partial set is
 * returned rather than thrown away. Only a failure on attempt 1 (before any row
 * exists) leaves the ticket untouched and propagates, which the caller turns
 * into a 4xx.
 */
export async function dispatchTicketAttempts(
  db: Database,
  input: DispatchAttemptsInput,
  onUpdate?: LaunchOnUpdate,
  launch: AttemptLauncher = launchSession
): Promise<DispatchAttemptsResult> {
  const { ticket, project, requester, retrievalUser, launchedBy, retrieval } = input;
  const n = clampAttempts(input.attempts);
  const attemptGroup = randomUUID();
  const task = `${ticket.title}\n\n${ticket.body}\n\nImplement this fix.`;

  // Refuse before spawning anything unless the shared fleet has room for ALL N
  // attempts. Each launch enforces the same global cap and throws once it is
  // reached; without this pre-check, dispatching N with fewer than N slots free
  // would spawn some attempts and then throw on the one that trips the cap —
  // orphaning the live ones. Checking once, up front, keeps a doomed dispatch
  // side-effect-free so the caller can 4xx it cleanly.
  const active = countActiveTaskRuns(db);
  if (active + n > MAX_ACTIVE_TASK_RUNS) {
    throw new Error(
      `Too many active task runs to dispatch ${n} attempts (cap ${MAX_ACTIVE_TASK_RUNS}, ${active} active). ` +
        "Wait for some to finish, or raise STANDUP_MAX_ACTIVE_TASK_RUNS."
    );
  }

  const priorGroup = ticket.attemptGroup ?? null;
  const launches: Launch[] = [];
  const runs: TaskRun[] = [];
  try {
    for (let i = 1; i <= n; i++) {
      const result = await launch(
        db,
        {
          project,
          task,
          // A distinct label per attempt so their worktree slugs, branches, and
          // feed rows are told apart (launches are meant to be watched per-pane).
          label: `${ticket.title} · attempt ${i}/${n}`,
          requester,
          retrievalUser,
          launchedBy,
          attemptGroup,
          // Best-of-N is defined by N independent worktrees — the whole point is
          // to compare N parallel trees. Force a fresh worktree per attempt even
          // when the project's default (or its inPlace flag) is in-place: sharing
          // one repo path would resolve every attempt's worktree to that path, so
          // the per-worktree guard would reject attempt 2+ and the group would
          // silently collapse to a single agent mutating the real repo. An
          // explicit false overrides both the project and the multiplayer default.
          inPlace: false,
          // Parallel attempts run without the delivery pipeline, so N of them
          // don't each validate, deploy and cut a code review; pickAttempt turns the
          // winner's run on from coding. A lone attempt has no pick ahead of
          // it, so it runs the pipeline like any launch.
          ...(n > 1 ? { pipeline: false } : {}),
        },
        onUpdate,
        retrieval
      );
      launches.push(result.launch);
      // The run the launcher created alongside this launch shares its worktree
      // path (the launcher's per-worktree invariant), so it resolves exactly.
      const run = getActiveTaskRunByWorktree(db, result.launch.worktreePath);
      if (run) runs.push(run);

      // Own the group on the ticket the moment the first attempt is live, so a
      // failure on any LATER attempt can't orphan the ones already spawned —
      // they stay resolvable (and stoppable) through the ticket's group.
      if (i === 1) {
        setTicketAttemptGroup(db, ticket.id, attemptGroup);
        setTicketLaunch(db, ticket.id, result.launch.id);
        setTicketError(db, ticket.id, "");
      }
    }
  } catch (err) {
    // Nothing launched (attempt 1 threw before any row existed): leave the
    // ticket exactly as it was — restore its prior group — and propagate so the
    // caller reports a fully-failed dispatch. If at least one attempt is live,
    // fall through and return the partial group: the ticket already owns it
    // (stamped after attempt 1), so the spawned attempts are visible in the
    // compare/pick UI rather than orphaned.
    if (launches.length === 0) {
      setTicketAttemptGroup(db, ticket.id, priorGroup);
      throw err;
    }
  }

  return { attemptGroup, launches, runs };
}

/**
 * Reads one attempt worktree's diff against its base branch — the seam
 * collectAttemptDiffs uses. Injected so tests supply canned diffs and never
 * touch git. The default (gitWorktreeDiff) is a read-only `git diff`, so even in
 * production it mutates nothing.
 */
export interface WorktreeDiffResult {
  diff: string;
  truncated?: boolean;
  error?: string;
}

/**
 * Reads one attempt worktree's diff. May be async (the default gitWorktreeDiff
 * shells out to git off the event loop); collectAttemptDiffs awaits it either
 * way, so a test's synchronous fake reader stays valid.
 */
export type WorktreeDiffReader = (
  worktreePath: string,
  baseBranch: string
) => WorktreeDiffResult | Promise<WorktreeDiffResult>;

/** Diff output is clipped to this so a huge change can't bloat the response. */
const DIFF_CHAR_CAP = 40_000;

/**
 * Hard cap on how many untracked files a single attempt spawns a `git diff` for.
 * The char cap already bounds the *output*, but a worktree with thousands of tiny
 * new files could still fan out into thousands of subprocess spawns before that
 * cap is reached; this bounds the spawn count regardless. New-file work beyond it
 * is simply omitted from the compare view.
 */
export const MAX_UNTRACKED_DIFFS = 200;

/**
 * Default WorktreeDiffReader: the working-tree diff of an attempt's worktree
 * against its base branch (`git -C <worktree> diff <base>`), capturing the
 * agent's committed and uncommitted changes relative to where it branched, PLUS
 * its untracked (new, un-added) files. Plain `git diff` never shows untracked
 * files, so an attempt whose work is mostly new-file creation would render blank
 * in the compare UI; each untracked file is diffed against /dev/null with
 * `git diff --no-index` (read-only — it touches neither the index nor the
 * working tree) so new-file work shows as an addition. Safe to run against a
 * live worktree. A missing worktree or a git error resolves to an empty diff
 * plus a surfaced reason rather than throwing.
 */
export const gitWorktreeDiff: WorktreeDiffReader = async (worktreePath, baseBranch) => {
  if (!worktreePath || !existsSync(worktreePath)) {
    return { diff: "", error: `worktree no longer exists: ${worktreePath}` };
  }
  const base = baseBranch?.trim() && !baseBranch.trimStart().startsWith("(") ? baseBranch : "HEAD";

  // Async spawn (not Bun.spawnSync): the collector is single-threaded, so a
  // synchronous git-diff over a large multi-attempt change blocks the event loop
  // and stalls every other in-flight request for its whole duration. Awaiting the
  // process lets the loop serve others while git runs.
  const git = async (
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const proc = Bun.spawn(["git", "-C", worktreePath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { exitCode: proc.exitCode ?? 0, stdout, stderr };
  };

  // A base that exists only as its remote copy (a launch cut from origin/<base>) is read there.
  const resolves = async (ref: string) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).exitCode === 0;
  const remote = base !== "HEAD" && !(await resolves(base)) ? resolveTargetBranch(worktreePath, base, defaultGitRunner).remote : undefined;
  const baseRef = remote && (await resolves(remote)) ? remote : base;
  const diffed = await git(["diff", baseRef]);
  let out = diffed.stdout;
  if (diffed.exitCode !== 0) {
    const err = diffed.stderr.trim();
    return { diff: out.slice(0, DIFF_CHAR_CAP), error: err.slice(0, 400) || `git diff exited ${diffed.exitCode}` };
  }

  // Append untracked files, which the diff above omits entirely. `--no-index`
  // against /dev/null renders each as a new-file addition without staging it;
  // stop once the output fills the char cap OR the per-attempt spawn cap is hit,
  // so a huge new tree can't fan out into unbounded subprocess spawns.
  const listed = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listed.exitCode === 0) {
    const untracked = listed.stdout.split("\0").filter(Boolean);
    let spawned = 0;
    for (const file of untracked) {
      if (out.length >= DIFF_CHAR_CAP || spawned >= MAX_UNTRACKED_DIFFS) break;
      spawned += 1;
      // `git diff --no-index` exits 1 when the inputs differ (always true vs
      // /dev/null), so its exit code is not an error here — take its stdout.
      const added = await git(["diff", "--no-index", "--", "/dev/null", file]);
      out += added.stdout;
    }
  }

  return { diff: out.slice(0, DIFF_CHAR_CAP), truncated: out.length > DIFF_CHAR_CAP };
};

/**
 * Collects every attempt in a group for the compare UI: each run (carrying its
 * attempt_status), the launch that produced it (for branch/base), and the diff
 * of its worktree read through the injected seam. Pure w.r.t. the reader, so a
 * test drives it with a fake reader and asserts the per-attempt wiring without
 * any git. Oldest-first, matching getTaskRunsByAttemptGroup, so "attempt 1..N"
 * reads left-to-right.
 */
export async function collectAttemptDiffs(
  db: Database,
  attemptGroup: string,
  readDiff: WorktreeDiffReader = gitWorktreeDiff
): Promise<TicketAttempt[]> {
  return Promise.all(
    getTaskRunsByAttemptGroup(db, attemptGroup).map(async (run) => {
      const launch = getLaunchByWorktree(db, run.worktreePath) ?? undefined;
      const res = await readDiff(run.worktreePath, launch?.baseBranch ?? "HEAD");
      return {
        run,
        launch,
        diff: res.diff,
        diffTruncated: res.truncated,
        diffError: res.error,
      };
    })
  );
}

export interface PickAttemptResult {
  ticket: Ticket;
  /** The winning run, re-read with attempt_status 'selected'. */
  selected: TaskRun;
  /** The losing runs, re-read with attempt_status 'superseded'. */
  superseded: TaskRun[];
  /** The winner's launch, whose branch becomes the ticket output. */
  winnerLaunch?: Launch;
  /**
   * The still-live losers' launches whose panes the caller should stop (a
   * best-effort live tmux action done outside this pure store logic). Only
   * attempts whose run was active (queued/running) when superseded appear here.
   */
  stopLaunches: Launch[];
  /**
   * The winner's delivery-pipeline run, turned active from coding (attempts
   * launch with it disabled). Absent when there is no winner launch or the
   * run could not be enabled.
   */
  pipelineRun?: PipelineRun;
  /**
   * The pipeline brief for a winner whose session isn't mid-turn (idle, or
   * not attached yet — a queued steer would sit undelivered): the caller
   * types it into the winner's pane.
   */
  pipelineBriefToType?: string;
}

/** Where pickAttempt announces the winner's enabled pipeline run (pipeline:updated). */
export interface PickAttemptNotify {
  broadcast: (m: WsMessage) => void;
}

/**
 * Picks one attempt as the winner of its best-of-N group. The winner's run is
 * marked attempt_status 'selected' and the ticket is repointed at its launch +
 * session, so the winner's branch is what the Publisher assembles the PR from.
 * Every other run in the group is marked 'superseded'; a still-in-flight loser
 * (queued/running) is additionally cancelled on the ledger — a deliberate stop,
 * not a lost pane. Attempts launch with the delivery pipeline off, so the
 * winner's run is enabled here at coding, owned by the winner launch's
 * requester (else the host user), its worker briefed (or the run handed to
 * the owner when that worker has ended — see startPickedAttemptPipeline), an
 * earlier pick's run turned off, and each run announced through `notify`. Store logic
 * only (no git, no tmux), so it is fully unit-testable; the caller stops the
 * losers' panes from `stopLaunches`.
 *
 * Throws when the run is unknown, is not part of an attempt group, or is not
 * part of THIS ticket's own attempt group — including the case where the ticket
 * carries no group at all (a never-dispatched ticket cannot pick a foreign
 * attempt). A ticket may only pick a winner from the group it owns; any mismatch
 * is a caller-turned 4xx rather than silently repointing the wrong ticket at,
 * and cancelling the running attempts of, an unrelated ticket's group.
 */
export function pickAttempt(
  db: Database,
  input: { ticketId: string; taskRunId: string },
  notify: PickAttemptNotify = { broadcast: () => {} }
): PickAttemptResult {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) throw new Error(`ticket not found: ${input.ticketId}`);

  const winner = getTaskRun(db, input.taskRunId);
  if (!winner) throw new Error(`task run not found: ${input.taskRunId}`);
  if (!winner.attemptGroup) {
    throw new Error("this run is not part of a best-of-N attempt group");
  }
  // Strict equality (not `ticket.attemptGroup && …`): the guard must also reject
  // a ticket with NO group, otherwise a never-dispatched ticket could be
  // repointed at another ticket's attempt and cancel its in-flight runs.
  if (ticket.attemptGroup !== winner.attemptGroup) {
    throw new Error("this attempt belongs to a different ticket");
  }

  // Refuse a dead attempt. A failed/lost/cancelled run's worktree holds no usable
  // change — its branch is empty or abandoned — so repointing the ticket output
  // at it (below) would feed the Publisher a dead branch and, for a cancelled
  // loser, resurrect an already-superseded attempt. A queued or running attempt
  // is a legitimate mid-flight pick (its branch is real and still advancing), and
  // a succeeded one is the ordinary case; only the terminal-failure states are
  // rejected, before any run or ticket state is mutated.
  if (winner.status === "failed" || winner.status === "lost" || winner.status === "cancelled") {
    throw new Error(`this attempt is ${winner.status} — pick a live or succeeded attempt instead`);
  }

  const group = getTaskRunsByAttemptGroup(db, winner.attemptGroup);
  const selected = setTaskRunAttemptStatus(db, winner.id, "selected");

  const superseded: TaskRun[] = [];
  const stopLaunches: Launch[] = [];
  const otherLaunchIds: string[] = [];
  for (const run of group) {
    if (run.id === winner.id) continue;
    const otherLaunch = getLaunchByWorktree(db, run.worktreePath);
    if (otherLaunch) otherLaunchIds.push(otherLaunch.id);
    // Cancel the losing run on the ledger BEFORE flagging it superseded, so an
    // in-flight loser reads as a deliberate stop rather than a lost pane. A run
    // already terminal keeps its reported state; only its attempt_status moves.
    if (run.status === "queued" || run.status === "running") {
      updateTaskRunStatus(db, run.id, "cancelled");
      if (otherLaunch) stopLaunches.push(otherLaunch);
    }
    superseded.push(setTaskRunAttemptStatus(db, run.id, "superseded"));
  }

  // The winner's branch is the ticket's output — repoint the ticket at its
  // launch (and session, when it attached) so the Publisher composes the PR from
  // the chosen worktree, and clear any stale error from a losing attempt.
  const winnerLaunch = getLaunchByWorktree(db, winner.worktreePath) ?? undefined;
  if (winnerLaunch) setTicketLaunch(db, ticket.id, winnerLaunch.id);
  // Point the ticket at the winner's session, or CLEAR it when the winner hasn't
  // attached one yet. Leaving the prior value would strand the ticket pointing at
  // a losing (or older) attempt's session while its launch points at the winner —
  // an inconsistent pair. The winner's session, once it reports in, relinks the
  // ticket by launch id regardless, so clearing is safe.
  setTicketSession(db, ticket.id, winner.sessionId ?? null);
  setTicketError(db, ticket.id, "");
  // A review url already on the ticket came from before the pick — an
  // attempt's code review that isn't the ticket's output now — so the
  // winner's code_review stage must not take it as its own.
  clearReviewUrl(db, ticket.id);

  // The winner carries on through the delivery pipeline from coding, and an
  // earlier pick's run is turned off. A failure here is logged and never
  // undoes the pick.
  let pipeline: PickedAttemptPipeline | null = null;
  if (winnerLaunch) {
    try {
      pipeline = startPickedAttemptPipeline(
        db,
        {
          launch: winnerLaunch,
          owner: winnerLaunch.requester?.trim() || hostUserAlias(),
          sessionId: winner.sessionId,
          previousLaunchIds: otherLaunchIds,
        },
        notify
      );
    } catch (err) {
      console.error(`[pipeline] could not enable the run for picked launch ${winnerLaunch.id}:`, err);
    }
  }

  return {
    ticket: getTicket(db, ticket.id)!,
    selected,
    superseded,
    winnerLaunch,
    stopLaunches,
    pipelineRun: pipeline?.run,
    ...(pipeline?.brief && !pipeline.steered ? { pipelineBriefToType: pipeline.brief } : {}),
  };
}
