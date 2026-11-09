import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import {
  clearLaunchReaped,
  createCheckpoint,
  getLaunch,
  getLaunchBySession,
  getPendingAsksBySession,
  getSession,
  insertEvent,
  reviveSession,
} from "@standup/store";
import type { Launch, WsMessage } from "@standup/shared";
import { killWorkerSession, respawnLaunchPane, type AdoptDeps } from "./launcher.js";
import { isFloorGate } from "./floor/gate.js";
import { pauseSettled } from "./idle-reaper.js";
import { hygieneSettled } from "./job-hygiene.js";
import { cleanupInProgress, holdForResume, launchLiveForHygiene, type PaneAlive } from "./launch-holds.js";
import { classifyClaudePane, settleIdle, tmuxPaneDriver, type PaneDriver } from "./session-recovery.js";

/*
 * Resuming a worker the idle reaper paused (idle-reaper.ts).
 *
 * A reaped launch keeps its row `running`, its task run open and its session
 * id; only its pane is gone. The next message to it relaunches
 * `claude --resume <session>` into the SAME launch row and tmux session name,
 * so everything keyed by the launch (job link, pipeline run, plan gate,
 * review packets, scratch dir) carries on as if the worker had never left.
 */

export interface LaunchResumeDeps {
  broadcast?: (message: WsMessage) => void;
  /** Re-watches the session's transcript (the tailer's watch). */
  watch?: (sessionId: string) => void;
  /** Pane reads and typing; defaults to tmux. */
  pane?: PaneDriver;
  /** The respawn's seams (spawner, floor check, data dir); defaults to the real ones. */
  spawn?: AdoptDeps;
  /** How long a wake waits for the resumed pane to reach its prompt. */
  idleTimeoutMs?: number;
  /** Poll interval of that wait. */
  pollMs?: number;
  /**
   * Called once a resume's hold is released when the launch is not live by
   * launchLiveForHygiene, so a closed job's hygiene the hold deferred can run
   * (closedJobHygieneStep).
   */
  afterNotLive?: (launch: Launch) => void;
  /** Whether a running launch's pane still exists, for that liveness check; defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
}

export interface ResumeOutcome {
  resumed: boolean;
  /** Why nothing was resumed. */
  reason?: string;
  launch: Launch | null;
  log: string[];
}

/** The `notification_type` of the event a resume records on its session. */
export const RESUMED_NOTIFICATION = "standup_resumed";

/** Resumes in progress, per launch, so concurrent wakes share one respawn. */
const inFlight = new Map<string, Promise<ResumeOutcome>>();

/** Wakes for queued work in progress, per session, so concurrent ones start one turn. */
const queuedWakes = new Map<string, Promise<ResumeOutcome>>();

/**
 * Whether a safety-floor hold still waits on the session. A message must not
 * restart a worker whose held call the owner hasn't decided: the hold is
 * answered first.
 */
function floorHoldPending(db: Database, sessionId: string): boolean {
  return getPendingAsksBySession(db, sessionId).some((a) => isFloorGate(a.gate));
}

/**
 * A resume holds the launch against hygiene from its start (holdForResume), so
 * a closed job's hygiene leaves this launch's processes and scratch dir alone,
 * and waits out a hygiene run already clearing them before it respawns. Once
 * the hold is released, a launch that is not live after all (the resume did
 * nothing, or the worker was stopped meanwhile) is handed to
 * `deps.afterNotLive`, which runs a closed job's hygiene the hold deferred.
 */
async function resume(db: Database, launchId: string, deps: LaunchResumeDeps): Promise<ResumeOutcome> {
  const release = holdForResume(launchId);
  let outcome: ResumeOutcome | undefined;
  try {
    outcome = await resumeHeld(db, launchId, deps);
    return outcome;
  } finally {
    release();
    try {
      if (deps.afterNotLive && !launchLiveForHygiene(db, launchId, deps.paneAlive ? { paneAlive: deps.paneAlive } : {})) {
        const launch = getLaunch(db, launchId) ?? outcome?.launch;
        if (launch) deps.afterNotLive(launch);
      }
    } catch (err) {
      console.error(`[launch-resume] hygiene after resuming ${launchId} failed:`, err);
    }
  }
}

/**
 * Marks a launch whose pane is up again as resumed: clears its reaped mark,
 * revives and re-watches its session, and records the resume as activity.
 */
function markResumed(db: Database, launch: Launch & { sessionId: string }, deps: LaunchResumeDeps, log: string[]): ResumeOutcome {
  clearLaunchReaped(db, launch.id);
  // The resumed process reports in as the same session id; clear the ended
  // marker now rather than waiting for its first hook to revive it.
  reviveSession(db, launch.sessionId);
  deps.watch?.(launch.sessionId);
  // An event of its own marks the resume as activity, so the idle reaper
  // measures the worker's idleness from now rather than from before the pause.
  insertEvent(db, launch.sessionId, "Notification", {
    hook_event_name: "Notification",
    session_id: launch.sessionId,
    notification_type: RESUMED_NOTIFICATION,
    message: "Resumed after idle pause.",
  });
  const checkpoint = createCheckpoint(db, launch.sessionId, "structural", "Resumed after idle pause.");
  const resumed = getLaunch(db, launch.id) ?? launch;
  const at = new Date().toISOString();
  deps.broadcast?.({ type: "checkpoint:new", payload: checkpoint, timestamp: at });
  deps.broadcast?.({ type: "launch:started", payload: resumed, timestamp: at });
  return { resumed: true, launch: resumed, log };
}

async function resumeHeld(db: Database, launchId: string, deps: LaunchResumeDeps): Promise<ResumeOutcome> {
  // A pause still closing the pane finishes first, so a message sent while it
  // runs resumes the worker instead of finding it half-stopped; then any
  // hygiene the pause started on a closed job finishes too.
  await pauseSettled(launchId);
  await hygieneSettled(launchId);
  const launch = getLaunch(db, launchId);
  const noop = (reason: string): ResumeOutcome => ({ resumed: false, reason, launch, log: [] });
  if (!launch) return noop("no such launch");
  if (cleanupInProgress(launch.id)) return noop("it is being cleaned up");
  if (!launch.reapedAt) return noop("it was not paused");
  if (launch.status === "cleaned" || !existsSync(launch.worktreePath)) return noop("its worktree is gone");
  // Only a paused worker's launch is still `running`; a stopped or failed one stays stopped.
  if (launch.status !== "running") return noop(`it is ${launch.status}, not paused`);
  if (!launch.tmuxSession || !launch.sessionId) return noop("it has no pane or session to resume");
  const pane = deps.pane ?? tmuxPaneDriver;
  // A pane that is up while the launch is still marked paused outlived the
  // pause or the respawn (a collector restart mid-way): the worker is adopted
  // as resumed rather than respawned.
  if (pane.exists(launch.tmuxSession)) {
    return markResumed(db, { ...launch, sessionId: launch.sessionId }, deps, ["Adopted the worker's running pane."]);
  }
  if (floorHoldPending(db, launch.sessionId)) return noop("a safety-floor hold is pending on it");

  // Claude starts where the session first ran (a package under the worktree
  // for a multi-package workspace), else at the worktree root.
  const session = getSession(db, launch.sessionId);
  const cwd = session?.cwd && existsSync(session.cwd) ? session.cwd : launch.worktreePath;
  let log: string[];
  try {
    log = await respawnLaunchPane(db, launch, cwd, deps.spawn);
  } catch (err) {
    return { resumed: false, reason: `its pane could not be restarted: ${(err as Error).message}`, launch, log: [] };
  }

  // A deliberate stop or a cleanup that landed while the pane respawned keeps
  // the worker stopped: the new pane is killed and the launch is not revived.
  const current = getLaunch(db, launch.id);
  if (!current || current.status !== "running" || !current.reapedAt || cleanupInProgress(launch.id)) {
    await killWorkerSession(launch.tmuxSession, log, deps.spawn?.run);
    return { resumed: false, reason: "it was stopped while resuming", launch: current, log };
  }

  return markResumed(db, { ...launch, sessionId: launch.sessionId }, deps, log);
}

/**
 * Startup reconcile: every launch still marked paused (running and reaped)
 * whose pane is up on the workers' tmux server, left so by a collector
 * restart mid-pause or mid-respawn, is adopted as resumed (markResumed) so
 * messages reach it and the idle reaper watches it again. Returns the
 * launches adopted.
 */
export function adoptLiveReapedPanes(db: Database, deps: LaunchResumeDeps = {}): Launch[] {
  const pane = deps.pane ?? tmuxPaneDriver;
  const rows = db.query("SELECT id FROM launches WHERE status = 'running' AND reaped_at IS NOT NULL").all() as Array<{ id: string }>;
  const adopted: Launch[] = [];
  for (const { id } of rows) {
    const launch = getLaunch(db, id);
    if (!launch?.reapedAt || launch.status !== "running" || !launch.tmuxSession || !launch.sessionId) continue;
    if (cleanupInProgress(id) || inFlight.has(id)) continue;
    if (!pane.exists(launch.tmuxSession)) continue;
    const outcome = markResumed(db, { ...launch, sessionId: launch.sessionId }, deps, []);
    if (outcome.launch) adopted.push(outcome.launch);
  }
  return adopted;
}

/**
 * Resumes a launch the idle reaper paused. A no-op (resumed: false, with the
 * reason) unless the launch is reaped, no cleanup of it is in progress, its
 * worktree is still there, and either its pane is still up (adopted as
 * resumed, no respawn) or no safety-floor hold waits on it. Concurrent
 * callers for one launch share the same attempt.
 */
export function resumeReapedLaunch(db: Database, launch: Launch, deps: LaunchResumeDeps = {}): Promise<ResumeOutcome> {
  const running = inFlight.get(launch.id);
  if (running) return running;
  const attempt = resume(db, launch.id, deps).finally(() => inFlight.delete(launch.id));
  inFlight.set(launch.id, attempt);
  return attempt;
}

/**
 * Waits (bounded) for a launch's pane to show Claude's idle prompt, so text
 * typed into a just-resumed worker isn't lost to its startup screen. False on
 * timeout or when the pane is gone.
 */
export async function waitForIdlePane(
  launch: Launch,
  { timeoutMs = 30_000, pollMs = 400, pane = tmuxPaneDriver }: { timeoutMs?: number; pollMs?: number; pane?: PaneDriver } = {}
): Promise<boolean> {
  const session = launch.tmuxSession;
  if (!session) return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pane.exists(session)) return false;
    if (classifyClaudePane(pane.capture(session)).kind === "idle") return true;
    if (Date.now() >= deadline) return false;
    await pane.sleep(pollMs);
  }
}

/**
 * Resumes the session's worker when the idle reaper paused it, then waits for
 * its prompt. A no-op for any other session.
 */
export async function wakeIfReaped(db: Database, sessionId: string, deps: LaunchResumeDeps = {}): Promise<ResumeOutcome> {
  const launch = getLaunchBySession(db, sessionId);
  if (!launch?.reapedAt) return { resumed: false, reason: "it was not paused", launch, log: [] };
  const outcome = await resumeReapedLaunch(db, launch, deps);
  if (outcome.resumed && outcome.launch) {
    await waitForIdlePane(outcome.launch, { timeoutMs: deps.idleTimeoutMs, pollMs: deps.pollMs, pane: deps.pane });
  }
  return outcome;
}

/**
 * Resumes a paused worker for queued work (a steer or mailbox message), then
 * starts its next turn so the queued items are delivered. Concurrent calls
 * for one session share the attempt, so the turn is started once.
 */
export function wakeForQueued(db: Database, sessionId: string, deps: LaunchResumeDeps = {}): Promise<ResumeOutcome> {
  const running = queuedWakes.get(sessionId);
  if (running) return running;
  const attempt = wakeAndSettle(db, sessionId, deps).finally(() => queuedWakes.delete(sessionId));
  queuedWakes.set(sessionId, attempt);
  return attempt;
}

/** Whether a broadcast frame queues work for a session: the session it queues it for, else null. */
export function queuedWorkSession(message: WsMessage): string | null {
  if (message.type !== "steer:queued") return null;
  const sessionId = (message.payload as { sessionId?: unknown } | null)?.sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

async function wakeAndSettle(db: Database, sessionId: string, deps: LaunchResumeDeps): Promise<ResumeOutcome> {
  const outcome = await wakeIfReaped(db, sessionId, deps);
  if (!outcome.resumed || !outcome.launch) return outcome;
  const settled = await settleIdle(
    { db, broadcast: deps.broadcast ?? (() => {}), pane: deps.pane ?? tmuxPaneDriver },
    sessionId,
    outcome.launch,
    "resumed"
  );
  if (settled.deliveryError) outcome.log.push(`[warn] queued items not started: ${settled.deliveryError}`);
  return outcome;
}
