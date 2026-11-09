import type { Database } from "bun:sqlite";
import type { Ticket, TicketStatus, TicketSeverity, Lens } from "@standup/shared";
import { randomUUID } from "crypto";

/**
 * The lifecycle state machine. A ticket may only move to a status listed for
 * its current one. proposed/approved/developing/needs_review are active and can
 * always be dismissed. `shipped` is terminal (no outbound edges); `dismissed`
 * can be un-dismissed back to `proposed` or `approved` (rework). needs_review
 * can be sent back to `developing` (rework — the review found more to do).
 * updateTicketStatus is the single enforcement point.
 */
export const ALLOWED_TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  proposed: ["approved", "dismissed"],
  approved: ["developing", "dismissed"],
  developing: ["needs_review", "dismissed"],
  needs_review: ["shipped", "developing", "dismissed"],
  shipped: [],
  dismissed: ["proposed", "approved"],
};

/** Per-transition timestamp column stamped for each target status. */
const STATUS_TIMESTAMP_COLUMN: Record<TicketStatus, string | null> = {
  proposed: null, // covered by created_at at insert time
  approved: "approved_at",
  developing: "developing_at",
  needs_review: "ready_at",
  shipped: "shipped_at",
  dismissed: "dismissed_at",
};

/** Thrown by updateTicketStatus when a transition is not in ALLOWED_TICKET_TRANSITIONS. */
export class TicketTransitionError extends Error {
  constructor(
    public readonly from: TicketStatus,
    public readonly to: TicketStatus
  ) {
    super(`Illegal ticket transition: ${from} -> ${to}`);
    this.name = "TicketTransitionError";
  }
}

interface TicketRow {
  id: string;
  project_id: string;
  lens: string;
  title: string;
  body: string;
  severity: TicketSeverity;
  status: TicketStatus;
  proposed_by_session_id: string | null;
  launch_id: string | null;
  session_id: string | null;
  attempt_group: string | null;
  issue_id: string | null;
  task_url: string | null;
  review_url: string | null;
  ready_reason: string | null;
  note: string | null;
  reported_by_actor: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  developing_at: string | null;
  ready_at: string | null;
  shipped_at: string | null;
  dismissed_at: string | null;
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    lens: row.lens,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    proposedBySessionId: row.proposed_by_session_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    attemptGroup: row.attempt_group ?? undefined,
    issueId: row.issue_id ?? undefined,
    taskUrl: row.task_url ?? undefined,
    reviewUrl: row.review_url ?? undefined,
    readyReason: row.ready_reason ?? undefined,
    note: row.note ?? undefined,
    reportedByActor: row.reported_by_actor ?? undefined,
    error: row.error ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
    developingAt: row.developing_at ? new Date(row.developing_at) : undefined,
    readyAt: row.ready_at ? new Date(row.ready_at) : undefined,
    shippedAt: row.shipped_at ? new Date(row.shipped_at) : undefined,
    dismissedAt: row.dismissed_at ? new Date(row.dismissed_at) : undefined,
  };
}

export function createTicket(
  db: Database,
  input: {
    projectId: string;
    lens: Lens;
    title: string;
    body: string;
    severity?: TicketSeverity;      // defaults to "medium"
    proposedBySessionId?: string;
    issueId?: string;
    // Deep link back to the originating tracker task (surfaced on the card).
    taskUrl?: string;
  }
): Ticket {
  const id = randomUUID();
  db.run(
    `INSERT INTO tickets (id, project_id, lens, title, body, severity, proposed_by_session_id, issue_id, task_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.lens,
      input.title,
      input.body,
      input.severity ?? "medium",
      input.proposedBySessionId ?? null,
      input.issueId?.trim() || null,
      input.taskUrl?.trim() || null,
    ]
  );
  return getTicket(db, id)!;
}

export function getTicket(db: Database, ticketId: string): Ticket | null {
  const row = db.query("SELECT * FROM tickets WHERE id = ?").get(ticketId) as TicketRow | null;
  return row ? toTicket(row) : null;
}

export function getTickets(db: Database): Ticket[] {
  const rows = db.query("SELECT * FROM tickets ORDER BY created_at DESC").all() as TicketRow[];
  return rows.map(toTicket);
}

export function getTicketsByProject(db: Database, projectId: string): Ticket[] {
  const rows = db
    .query("SELECT * FROM tickets WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as TicketRow[];
  return rows.map(toTicket);
}

/**
 * The ticket whose approval fired this implementation launch, if any. Used to
 * auto-advance approved -> developing when the launch's session reports in
 * (reuses the attachSessionToLaunch signal in server.ts ensureSession) and to
 * resolve which ticket a mark_ready_for_review call belongs to.
 */
export function getTicketByLaunch(db: Database, launchId: string): Ticket | null {
  const row = db
    .query("SELECT * FROM tickets WHERE launch_id = ? LIMIT 1")
    .get(launchId) as TicketRow | null;
  return row ? toTicket(row) : null;
}

/**
 * The ticket implemented by a given session — the impl session attached to its
 * approval launch (setTicketSession). Used to sync a task-run's terminal state
 * back to the ticket it was implementing (the dispatcher's "syncs status back").
 * A session maps to at most one open ticket; most-recently-updated wins.
 */
export function getTicketBySession(db: Database, sessionId: string): Ticket | null {
  const row = db
    .query("SELECT * FROM tickets WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(sessionId) as TicketRow | null;
  return row ? toTicket(row) : null;
}

/**
 * The ticket that owns a given best-of-N attempt group. A group is minted per
 * dispatch and stamped on exactly one ticket (setTicketAttemptGroup), so this is
 * a unique lookup. Used to resolve the ticket a non-anchor attempt's session
 * belongs to: the ticket anchors to attempt 1's launch, so getTicketByLaunch
 * only resolves attempt 1 — any other attempt starting resolves its ticket
 * through the group instead, so it can still auto-advance approved -> developing.
 */
export function getTicketByAttemptGroup(db: Database, attemptGroup: string): Ticket | null {
  const row = db
    .query("SELECT * FROM tickets WHERE attempt_group = ? ORDER BY updated_at DESC LIMIT 1")
    .get(attemptGroup) as TicketRow | null;
  return row ? toTicket(row) : null;
}

/**
 * The ticket carrying a given tracking issue/task id, scoped to a project — the
 * tracker task↔work-item mapping (createTicket stores the task id as `issue_id`).
 * Used by the tracker ingest to dedup a re-assigned task onto its existing work
 * item instead of minting a second, and to surface the ticket/session a task is
 * being worked in. Most-recently-updated wins when more than one ever shares an
 * id. Returns null when nothing maps to it yet.
 */
export function getTicketByIssueId(
  db: Database,
  projectId: string,
  issueId: string
): Ticket | null {
  const row = db
    .query(
      "SELECT * FROM tickets WHERE project_id = ? AND issue_id = ? ORDER BY updated_at DESC LIMIT 1"
    )
    .get(projectId, issueId) as TicketRow | null;
  return row ? toTicket(row) : null;
}

/**
 * Open (active) tickets for a project + lens — proposed/approved/developing/
 * needs_review. Used by the daily-review fan-out to dedup: don't re-propose a
 * lens's finding while an earlier one is still open.
 */
export function getOpenTicketsByProjectLens(db: Database, projectId: string, lens: string): Ticket[] {
  const rows = db.query(
    `SELECT * FROM tickets WHERE project_id = ? AND lens = ?
       AND status IN ('proposed','approved','developing','needs_review')`
  ).all(projectId, lens) as TicketRow[];
  return rows.map(toTicket);
}

/**
 * Moves a ticket to `to`, enforcing ALLOWED_TICKET_TRANSITIONS and stamping the
 * matching per-transition timestamp (approved_at / developing_at / ready_at /
 * shipped_at / dismissed_at) plus updated_at. Throws TicketTransitionError on an
 * illegal edge. There are no self-loops, so re-firing the same transition
 * throws — callers reacting to repeatable signals (session attach, a
 * double-called MCP tool) MUST guard on the current status first. `readyReason`
 * is recorded only on the needs_review transition (the ready summary); `note` is
 * the general status-change note and is recorded on ANY edge that carries one,
 * so a report's rationale (a send-back, a dismiss, a claim) is never dropped.
 * `actor` records who reported the status (the decoupled status setter's
 * attribution); `sessionId` links the reporting session so an externally-claimed
 * ticket resolves by session like a launch-attached one. Returns the updated
 * ticket so the route can broadcast it.
 * The target column name comes from a fixed internal map (never user input), so
 * the interpolation is injection-safe.
 */
export function updateTicketStatus(
  db: Database,
  ticketId: string,
  to: TicketStatus,
  opts?: { readyReason?: string; note?: string; actor?: string; sessionId?: string }
): Ticket {
  const current = getTicket(db, ticketId);
  if (!current) throw new Error(`ticket not found: ${ticketId}`);
  if (!ALLOWED_TICKET_TRANSITIONS[current.status].includes(to)) {
    throw new TicketTransitionError(current.status, to);
  }

  const sets = ["status = ?", "updated_at = datetime('now')"];
  const params: string[] = [to];

  const tsColumn = STATUS_TIMESTAMP_COLUMN[to];
  if (tsColumn) sets.push(`${tsColumn} = datetime('now')`);

  if (to === "needs_review" && opts?.readyReason !== undefined) {
    sets.push("ready_reason = ?");
    params.push(opts.readyReason);
  }
  if (opts?.note !== undefined) {
    sets.push("note = ?");
    params.push(opts.note);
  }
  if (opts?.actor !== undefined) {
    sets.push("reported_by_actor = ?");
    params.push(opts.actor);
  }
  if (opts?.sessionId !== undefined) {
    sets.push("session_id = ?");
    params.push(opts.sessionId);
  }

  params.push(ticketId);
  db.run(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, params);
  return getTicket(db, ticketId)!;
}

/** Records the implementation launch fired when the ticket was approved. */
export function setTicketLaunch(db: Database, ticketId: string, launchId: string): void {
  db.run("UPDATE tickets SET launch_id = ?, updated_at = datetime('now') WHERE id = ?", [
    launchId,
    ticketId,
  ]);
}

/**
 * Records the session the implementation launch attached. Status is advanced
 * to "developing" separately via updateTicketStatus, so this stays a pure
 * setter (mirroring setTicketLaunch / setReviewUrl and keeping the transition
 * guard the single source of truth for status changes). Passing null clears it —
 * used when a best-of-N pick lands on an attempt that has not attached a session.
 */
export function setTicketSession(db: Database, ticketId: string, sessionId: string | null): void {
  db.run("UPDATE tickets SET session_id = ?, updated_at = datetime('now') WHERE id = ?", [
    sessionId,
    ticketId,
  ]);
}

/**
 * Records the best-of-N attempt group a multi-attempt dispatch opened for this
 * ticket, so the compare + pick UI can resolve its parallel runs. Kept a pure
 * setter (like setTicketLaunch/setTicketSession); the group's runs live on
 * task_runs. Passing null clears it.
 */
export function setTicketAttemptGroup(
  db: Database,
  ticketId: string,
  attemptGroup: string | null
): void {
  db.run("UPDATE tickets SET attempt_group = ?, updated_at = datetime('now') WHERE id = ?", [
    attemptGroup,
    ticketId,
  ]);
}

/** Stores the code review URL produced by the review gate (command or review-agent). */
export function setReviewUrl(db: Database, ticketId: string, reviewUrl: string): void {
  db.run("UPDATE tickets SET review_url = ?, updated_at = datetime('now') WHERE id = ?", [
    reviewUrl,
    ticketId,
  ]);
}

/** Removes the ticket's review url (the review it named is no longer the ticket's). */
export function clearReviewUrl(db: Database, ticketId: string): void {
  db.run("UPDATE tickets SET review_url = NULL, updated_at = datetime('now') WHERE id = ?", [ticketId]);
}

/**
 * Records a failure message from the launch or the review gate. Orthogonal to
 * status — the ticket is left where it is (e.g. a launch that fails leaves the
 * ticket in `approved`) with the error surfaced on the card for the human.
 */
export function setTicketError(db: Database, ticketId: string, error: string): void {
  db.run("UPDATE tickets SET error = ?, updated_at = datetime('now') WHERE id = ?", [
    error,
    ticketId,
  ]);
}
