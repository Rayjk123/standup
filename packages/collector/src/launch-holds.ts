import type { Database } from "bun:sqlite";
import type { Launch } from "@standup/shared";
import { workerTmuxSocket } from "@standup/shared/owner-token";
import { getLaunch, getSession } from "@standup/store";

/**
 * In-memory holds on a launch while a resume or a cleanup of it is in
 * progress, and the one liveness rule worker hygiene (job hygiene, the
 * scratch sweep, the orphan sweep) applies before clearing what a launch left
 * behind (launchLiveForHygiene).
 */

interface ResumeHold {
  count: number;
  waiters: Array<() => void>;
}

/** Resumes in progress, per launch id, counted, with the callers waiting for them to settle. */
const resumes = new Map<string, ResumeHold>();

/** Cleanups in progress, per launch id, counted. */
const cleanups = new Map<string, number>();

/**
 * Marks a resume of the launch in progress: until the returned release is
 * called, hygiene treats the launch as live and leaves its processes and
 * scratch dir alone. Releasing twice is harmless.
 */
export function holdForResume(launchId: string): () => void {
  const hold = resumes.get(launchId) ?? { count: 0, waiters: [] };
  hold.count += 1;
  resumes.set(launchId, hold);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hold.count -= 1;
    if (hold.count > 0) return;
    if (resumes.get(launchId) === hold) resumes.delete(launchId);
    for (const wake of hold.waiters.splice(0)) wake();
  };
}

/** Whether a resume of the launch is in progress. */
export function resumeInProgress(launchId: string): boolean {
  return resumes.has(launchId);
}

/** Resolves once no resume of the launch is in progress; at once when none is. */
export function resumeSettled(launchId: string): Promise<void> {
  const hold = resumes.get(launchId);
  if (!hold) return Promise.resolve();
  return new Promise((resolve) => hold.waiters.push(resolve));
}

/**
 * Marks a cleanup of the launch in progress: until the returned release is
 * called, a resume of it does nothing (and kills a pane it just respawned),
 * and hygiene leaves the launch to the cleanup. Releasing twice is harmless.
 */
export function holdForCleanup(launchId: string): () => void {
  cleanups.set(launchId, (cleanups.get(launchId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (cleanups.get(launchId) ?? 1) - 1;
    if (left > 0) cleanups.set(launchId, left);
    else cleanups.delete(launchId);
  };
}

/** Whether a cleanup of the launch is in progress. */
export function cleanupInProgress(launchId: string): boolean {
  return cleanups.has(launchId);
}

/** Whether a tmux session of the given name exists on the workers' server. */
export type PaneAlive = (tmuxSession: string) => boolean;

/** PaneAlive on the workers' tmux server: an exact-name `has-session`. */
export function workerPaneAlive(tmuxSession: string): boolean {
  try {
    return Bun.spawnSync(["tmux", "-S", workerTmuxSocket(), "has-session", "-t", `=${tmuxSession}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

export interface LivenessOptions {
  /** Whether a running launch's pane still exists; defaults to workerPaneAlive. */
  paneAlive?: PaneAlive;
}

/** The launch's own liveness, without looking at the other launches of its session. */
function liveByOwnRule(db: Database, launch: Launch, paneAlive: PaneAlive): boolean {
  if (resumes.has(launch.id) || cleanups.has(launch.id)) return true;
  if (launch.status === "starting") return true;
  const session = launch.sessionId ? getSession(db, launch.sessionId) : null;
  if (session !== null && !session.endedAt) return true;
  if (launch.status !== "running" || launch.reapedAt) return false;
  // Nothing moves a launch whose pane died on its own out of `running`, so
  // with its session ended only the pane itself says whether it is live. A
  // launch with no pane name can't be checked and counts as live.
  return !launch.tmuxSession || paneAlive(launch.tmuxSession);
}

/**
 * Whether a launch's worker may still be using its processes and scratch
 * dir, so hygiene must leave them: a resume or cleanup of it is in progress,
 * it is starting, its session is live, it is running and not paused with its
 * pane still on the workers' server (paneAlive), or any other launch of its
 * session is live by those same rules (one hop: an adoption that resumed the
 * session keeps the original launch's leftovers). A paused (reaped) launch
 * whose session has ended is not live, nor is a stopped one, nor a running
 * one whose session has ended and whose pane is gone. An unknown launch id is
 * live only while held.
 */
export function launchLiveForHygiene(db: Database, launch: Launch | string, opts: LivenessOptions = {}): boolean {
  const paneAlive = opts.paneAlive ?? workerPaneAlive;
  const row = typeof launch === "string" ? getLaunch(db, launch) : launch;
  if (!row) return typeof launch === "string" && (resumes.has(launch) || cleanups.has(launch));
  if (liveByOwnRule(db, row, paneAlive)) return true;
  if (!row.sessionId) return false;
  const others = db.query("SELECT id FROM launches WHERE session_id = ? AND id != ?").all(row.sessionId, row.id) as Array<{ id: string }>;
  return others.some(({ id }) => {
    const other = getLaunch(db, id);
    return other !== null && liveByOwnRule(db, other, paneAlive);
  });
}
