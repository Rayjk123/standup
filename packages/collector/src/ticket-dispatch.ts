import type { Database } from "bun:sqlite";
import type { TaskRun, Ticket } from "@standup/shared";
import {
  getLaunch,
  getActiveTaskRunByWorktree,
  getActiveTaskRunBySession,
  getTaskRunsByAttemptGroup,
} from "@standup/store";

/**
 * The in-flight (queued/running) task-run for a ticket, if any — the check the
 * dispatch endpoint uses to refuse a double-dispatch.
 *
 * The obvious keying, the ticket's stored `session_id`, is wrong for exactly
 * the case the guard protects: a re-dispatched ticket still points at the
 * PREVIOUS, now-terminal run's session (a new session links only once the
 * launched agent reports in, seconds later), so a session lookup finds no
 * active run and lets a second click spawn a duplicate agent. The freshly
 * created run has no session yet and lives at a unique worktree path, so it is
 * invisible to both that lookup and launcher's per-worktree serialization guard
 * during that window.
 *
 * Resolve through the ticket's CURRENT launch instead: the run created
 * alongside a launch shares its `worktree_path`, so the launch's worktree finds
 * the run whether or not a session has attached yet. Fall back to the session
 * lookup for an older run whose launch row can't be resolved.
 *
 * Best-of-N: a ticket anchors to only its FIRST attempt's launch, but attempts
 * 2..N run in their own worktrees. Attempt 1 can reach a terminal state while
 * the others are still live, so also treat ANY still-active run in the ticket's
 * attempt group as in-flight — otherwise a re-dispatch would slip past the guard
 * and orphan the survivors under a fresh group.
 */
export function activeRunForTicket(db: Database, ticket: Ticket): TaskRun | null {
  if (ticket.launchId) {
    const launch = getLaunch(db, ticket.launchId);
    if (launch) {
      const run = getActiveTaskRunByWorktree(db, launch.worktreePath);
      if (run) return run;
    }
  }
  if (ticket.attemptGroup) {
    const active = getTaskRunsByAttemptGroup(db, ticket.attemptGroup).find(
      (run) => run.status === "queued" || run.status === "running"
    );
    if (active) return active;
  }
  if (ticket.sessionId) {
    return getActiveTaskRunBySession(db, ticket.sessionId);
  }
  return null;
}
