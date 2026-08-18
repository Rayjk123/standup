import type { Database } from "bun:sqlite";
import {
  getActiveSessions,
  getLaunchBySession,
  endSession,
  cancelAllPendingAsks,
} from "@standup/store";
import type { Ask } from "@standup/shared";
import { tmuxSessionExists } from "./launcher.js";

export interface ReapedSession {
  sessionId: string;
  cancelledAsks: Ask[];
}

/**
 * Reaps launched sessions whose tmux pane has gone away.
 *
 * SessionEnd only fires when Claude Code exits and actually delivers the hook.
 * A pane killed out-of-band (tmux kill-session, closing the terminal, a hard
 * kill) delivers nothing, so the session row keeps `ended_at IS NULL` and any
 * pending ask it raised sits in "Needs you" forever — the process that would
 * answer it is gone. Nothing else notices, because blocking is otherwise only
 * observed as hooks arrive and a dead session sends no more hooks.
 *
 * Only launched sessions are checked: Standup owns their tmux pane, so its
 * absence is authoritative. A monitored session belongs to the human's own
 * terminal — it may not be in tmux at all, and reaching into it is exactly
 * what the design declines to do.
 */
export function reapDeadSessions(
  db: Database,
  // Injectable for tests; production uses the real tmux liveness probe.
  sessionExists: (name: string) => boolean = tmuxSessionExists
): ReapedSession[] {
  const reaped: ReapedSession[] = [];

  for (const session of getActiveSessions(db)) {
    const launch = getLaunchBySession(db, session.id);
    // No launch, or a launch that never got a pane (failed before start) /
    // was already cleaned — nothing to check liveness against.
    if (!launch?.tmuxSession) continue;
    if (sessionExists(launch.tmuxSession)) continue;

    endSession(db, session.id);
    const cancelledAsks = cancelAllPendingAsks(db, session.id);
    reaped.push({ sessionId: session.id, cancelledAsks });
  }

  return reaped;
}
