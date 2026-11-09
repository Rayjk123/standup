import type { Database } from "bun:sqlite";
import { createTicket, getTicketByIssueId } from "@standup/store";
import type { Lens, ReviewProcess, Ticket, TicketSeverity } from "@standup/shared";
import type { TrackerAdapter, TrackerStatusUpdate, TrackerTask } from "./adapter.js";

/**
 * Two-way issue-tracker sync over a TrackerAdapter: a task assigned to
 * Standup becomes a work item (a ticket), a session is dispatched on it, and
 * when its review is cut the task gets a status and a link back.
 *
 * The collector owns the mapping (ticket.issueId = the task id,
 * ticket.sessionId = the implementing session); the adapter decides who makes
 * the outward writeback (its own client, or the dispatched session).
 */

/**
 * The lens stamped on a work item that originated from a tracker task, as
 * opposed to a daily-review finding (bugs/security/…). The review gate keys
 * the writeback off it, so an ordinary review ticket's `issueId` never
 * triggers one.
 */
export const TRACKER_LENS: Lens = "tracker";

/** Whether a ticket originated from a tracker task (and so is eligible for writeback). */
export function isTrackerTicket(ticket: Ticket): boolean {
  return ticket.lens === TRACKER_LENS && !!ticket.issueId?.trim();
}

/**
 * Whether a project's review gate fires the writeback for this tracker. An
 * agent-driven writeback needs a live implementation session at review time:
 * `review-agent` (the session cuts its own review) and `command` (the session
 * is still live when the review command reports a URL). A collector-driven
 * one fires from any gate that records a review URL — the same two modes.
 * `pause`/unset has no gate, so the task is updated by hand.
 */
export function firesTrackerWriteback(tracker: TrackerAdapter, reviewProcess?: ReviewProcess): boolean {
  if (!tracker.enabled || tracker.writeback === "none") return false;
  return reviewProcess === "review-agent" || reviewProcess === "command";
}

/**
 * Maps a task to the createTicket input: the task id becomes the ticket's
 * `issueId`, the task's link `taskUrl`, and the lens TRACKER_LENS. The task's
 * inbound status is not mapped: an ingested task always begins `proposed`
 * and Standup owns its lifecycle from there.
 */
export function taskToTicketInput(
  task: TrackerTask,
  opts: { projectId: string; severity?: TicketSeverity }
): {
  projectId: string;
  lens: Lens;
  title: string;
  body: string;
  severity?: TicketSeverity;
  issueId: string;
  taskUrl?: string;
} {
  return {
    projectId: opts.projectId,
    lens: TRACKER_LENS,
    title: task.title,
    body: task.description ?? "",
    severity: opts.severity,
    issueId: task.id,
    taskUrl: task.url?.trim() || undefined,
  };
}

/**
 * Ingests a task as a work item. Idempotent per project: a task already
 * ingested resolves to its existing ticket rather than a duplicate.
 */
export function ingestTaskAsWorkItem(
  db: Database,
  task: TrackerTask,
  opts: { projectId: string; severity?: TicketSeverity }
): { ticket: Ticket; created: boolean } {
  const existing = getTicketByIssueId(db, opts.projectId, task.id);
  if (existing) return { ticket: existing, created: false };
  const ticket = createTicket(db, taskToTicketInput(task, opts));
  return { ticket, created: true };
}

/** Fetches a task through the adapter and ingests it. */
export async function fetchTaskAndIngest(
  db: Database,
  tracker: TrackerAdapter,
  opts: { projectId: string; taskId: string; severity?: TicketSeverity }
): Promise<{ ticket: Ticket; created: boolean; task: TrackerTask }> {
  const task = await tracker.getTask(opts.taskId);
  const { ticket, created } = ingestTaskAsWorkItem(db, task, {
    projectId: opts.projectId,
    severity: opts.severity,
  });
  return { ticket, created, task };
}

/**
 * The status writeback for a ticket at (or past) review: the adapter's status
 * plus a comment linking the review — the ticket's recorded `reviewUrl`, else
 * `artifactUrl`, else a note that the review is being prepared.
 */
export function composeTaskWriteback(
  tracker: TrackerAdapter,
  ticket: Ticket,
  artifactUrl?: string
): TrackerStatusUpdate {
  const link = ticket.reviewUrl?.trim() || artifactUrl?.trim();
  const status = tracker.statusFor(ticket.status);
  const comment = link
    ? `Standup: ${ticket.title} — ${status.toLowerCase()}. Review: ${link}`
    : `Standup: ${ticket.title} — ${status.toLowerCase()}; review is being prepared.`;
  return { status, comment };
}

/**
 * Writes a status back through the adapter, sending only `status` and
 * `comment` so a widened object can never carry a priority along. Returns the
 * update sent.
 */
export async function writeBackTaskStatus(
  tracker: TrackerAdapter,
  taskId: string,
  update: TrackerStatusUpdate
): Promise<TrackerStatusUpdate> {
  const safe: TrackerStatusUpdate = { status: update.status, comment: update.comment };
  await tracker.updateTask(taskId, safe);
  return safe;
}

/**
 * The writeback directive for a ticket's dispatched session, or undefined when
 * the ticket isn't a tracker ticket or the adapter doesn't drive the session.
 */
export function trackerWritebackFor(
  tracker: TrackerAdapter,
  ticket: Ticket,
  reviewUrl?: string
): string | undefined {
  if (!isTrackerTicket(ticket) || tracker.writeback !== "agent") return undefined;
  return tracker.writebackInstruction(ticket.issueId!, { reviewUrl }) ?? undefined;
}
