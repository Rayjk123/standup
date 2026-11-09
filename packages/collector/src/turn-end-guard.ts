import type { Database } from "bun:sqlite";
import {
  getActiveTaskRunBySession,
  getChildSessions,
  getLaunchBySession,
  getSession,
  updateSessionStatus,
} from "@standup/store";
import type { Session } from "@standup/shared";
import { tmuxAvailable, tmuxSessionExists } from "./launcher.js";
import { lastActivityMs } from "./session-recovery.js";

/**
 * Whether a session that just ended a turn is still alive with work in hand,
 * which rules out the terminal `done` status whatever the turn-end classifier
 * concluded from the transcript.
 *
 * A `Stop` hook only means the current turn ended. A worker that started
 * background subagents ends its turn with them still running and resumes when
 * their task-notifications arrive; a launched worker whose pane is still up and
 * whose task run it never reported finished is waiting for its next message.
 * Both are idle, not finished. The turn-end classifier is the only path that
 * sets a root session `done`, and the Persona launch cap and schedule-run
 * settling key off it, so a worker that has reported its run finished (or has
 * no run) is still allowed through.
 */

/**
 * A subagent child with no SubagentStop and no activity for this long is taken
 * as abandoned (its stop hook was lost), so it doesn't hold its parent idle
 * forever. Wide on purpose: SubagentStart carries no transcript path, so a
 * child's own row can show nothing newer than its start while it works, and
 * holding a parent idle too long costs only a late `done`.
 */
export const OPEN_SUBAGENT_STALE_MS = 2 * 60 * 60 * 1000;

export interface TurnEndGuardDeps {
  /** Whether a tmux session by this name exists. */
  tmuxSessionExists: (name: string) => boolean;
  /** Whether tmux can be queried at all on this host. */
  tmuxAvailable: () => boolean;
  now: () => number;
}

const defaultDeps: TurnEndGuardDeps = {
  tmuxSessionExists,
  tmuxAvailable,
  now: Date.now,
};

/** The newest parent event fired from inside the subagent `agentId`, in ms. */
function lastParentEventForAgent(db: Database, parentId: string, agentId: string): number | null {
  const row = db
    .query(
      "SELECT MAX(created_at) AS at FROM events WHERE session_id = ? AND json_extract(payload_json, '$.agent_id') = ?"
    )
    .get(parentId, agentId) as { at: string | null } | null;
  // SQLite's datetime('now') is UTC without a zone marker.
  return row?.at ? Date.parse(`${row.at.replace(" ", "T")}Z`) : null;
}

function lastSubagentActivityMs(db: Database, parentId: string, child: Session): number {
  const signals = [
    child.startedAt.getTime(),
    lastActivityMs(db, child.id),
    child.agentId ? lastParentEventForAgent(db, parentId, child.agentId) : null,
  ].filter((t): t is number => t !== null && !Number.isNaN(t));
  return signals.length ? Math.max(...signals) : NaN;
}

/**
 * The session's subagent children still running at `now`: not ended or done,
 * and active within OPEN_SUBAGENT_STALE_MS.
 */
export function openSubagents(db: Database, sessionId: string, now: number): Session[] {
  return getChildSessions(db, sessionId).filter((child) => {
    if (child.endedAt || child.status === "done") return false;
    const last = lastSubagentActivityMs(db, sessionId, child);
    return !Number.isNaN(last) && now - last < OPEN_SUBAGENT_STALE_MS;
  });
}

/**
 * Why the session must stay idle rather than go `done`, or null when nothing
 * says it is still alive.
 */
export function liveWorkAtTurnEnd(
  db: Database,
  sessionId: string,
  deps: TurnEndGuardDeps = defaultDeps
): string | null {
  const open = openSubagents(db, sessionId, deps.now());
  if (open.length > 0) {
    return `${open.length} background subagent(s) still running`;
  }

  const launch = getLaunchBySession(db, sessionId);
  if (!launch || (launch.status !== "running" && launch.status !== "starting")) return null;
  if (!getActiveTaskRunBySession(db, sessionId)) return null;
  // Without tmux to ask, the launch row's own live status is the best signal.
  if (!launch.tmuxSession || !deps.tmuxAvailable()) {
    return `its launch is still ${launch.status} and its task run is unreported`;
  }
  if (deps.tmuxSessionExists(launch.tmuxSession)) {
    return "its launch pane is still alive and its task run is unreported";
  }
  return null;
}

/**
 * Applies the turn-end classifier's DONE: moves the session `idle` → `done`
 * unless it moved on (a new turn, a wait) or still has live work. Returns
 * whether it was marked done.
 */
export function markDoneAtTurnEnd(
  db: Database,
  sessionId: string,
  deps: TurnEndGuardDeps = defaultDeps
): boolean {
  if (getSession(db, sessionId)?.status !== "idle") return false;
  const liveWork = liveWorkAtTurnEnd(db, sessionId, deps);
  if (liveWork) {
    console.log(`[turn-end] ${sessionId.slice(0, 8)} stays idle, not done — ${liveWork}`);
    return false;
  }
  updateSessionStatus(db, sessionId, "done");
  return true;
}
