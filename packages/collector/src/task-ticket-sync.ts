import type { Database } from "bun:sqlite";
import type { TaskRun, Ticket } from "@standup/shared";
import {
  getTicket,
  getTicketBySession,
  setTicketError,
} from "@standup/store";

/**
 * Syncs a task-run's TERMINAL state back to the ticket it was implementing
 * (the dispatchable board: the run ledger drives the card, not just a
 * status badge). Mirrors OpenClaw's `LIFECYCLE_TARGETS` (`succeeded→review`,
 * `failed→blocked`), adapted to Standup's ticket state machine — which has no
 * distinct `blocked`, so a failure is surfaced on the card the same way a failed
 * launch already is (setTicketError), leaving status where it is so the human
 * can re-dispatch it from the board.
 *
 * - `succeeded`: a still-`developing` ticket advances to `needs_review` — but
 *   only through the `reviewTransition` the caller supplies, which owns the
 *   project review gate (`runReviewGate`, resident in the server request
 *   closure). This is the fallback for a run that finished successfully without
 *   the impl agent self-reporting via mark_ready_for_review, so the card doesn't
 *   sit in `developing` forever AND still clears the same gate the agent's own
 *   report would — never a force-mark to review-ready un-reviewed. A ticket
 *   already past `developing` is left alone (the agent already reported ready —
 *   no double transition); a caller that can't run the gate (the lost-run sweep,
 *   which only ever sees failed/lost runs) passes no transition, so the edge is
 *   a no-op rather than an un-gated advance.
 * - `failed` / `lost`: the reason is stamped on the ticket when it is still
 *   mid-implementation (`approved`/`developing`) — a run that died AFTER the
 *   work was reported ready (needs_review+) isn't flagged, since that pane
 *   exiting is expected. Terminal tickets (shipped/dismissed) are never touched.
 *
 * A run whose ticket can't be resolved (an ad-hoc launch, a run that never
 * attached a session) is a no-op. Returns the updated ticket when something
 * changed, else null — the caller broadcasts it.
 */
export function syncTicketForTerminalRun(
  db: Database,
  run: TaskRun,
  reviewTransition?: (ticket: Ticket, readyReason: string) => Ticket
): Ticket | null {
  if (!run.sessionId) return null;
  const ticket = getTicketBySession(db, run.sessionId);
  if (!ticket) return null;

  if (run.status === "succeeded") {
    if (ticket.status !== "developing") return null;
    // The developing -> needs_review edge must clear the project review gate, so
    // it goes through the caller's gated transition; without one, leave the
    // ticket developing rather than mark it review-ready un-reviewed.
    if (!reviewTransition) return null;
    return reviewTransition(
      ticket,
      run.summary?.trim() || "Implementation run reported success."
    );
  }

  if (run.status === "failed" || run.status === "lost") {
    if (ticket.status !== "approved" && ticket.status !== "developing") return null;
    setTicketError(
      db,
      ticket.id,
      run.error?.trim() || run.summary?.trim() || `Implementation run ${run.status}.`
    );
    return getTicket(db, ticket.id);
  }

  return null;
}
