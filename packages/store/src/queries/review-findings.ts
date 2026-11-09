import type { Database } from "bun:sqlite";
import type {
  ReviewFinding,
  ReviewFindingStatus,
  ReviewFindingEvidence,
  TicketSeverity,
} from "@standup/shared";
import { randomUUID } from "crypto";

interface ReviewFindingRow {
  id: string;
  ticket_id: string;
  session_id: string | null;
  severity: TicketSeverity;
  title: string;
  body: string;
  file: string | null;
  line: number | null;
  status: ReviewFindingStatus;
  fix_launch_id: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

/** An empty bundle — the shape callers can always read `.checks`/`.screenshots` off. */
const EMPTY_EVIDENCE: ReviewFindingEvidence = { checks: [], screenshots: [] };

/**
 * Parse the stored evidence JSON into a well-formed bundle. A missing/garbled
 * column never throws into a read — findings are a soft UI signal, not a
 * correctness dependency — it degrades to the empty bundle, and `checks`/
 * `screenshots` are always arrays so the UI and fixer seed can map over them.
 */
function parseEvidence(raw: string | null): ReviewFindingEvidence {
  if (!raw) return { ...EMPTY_EVIDENCE };
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewFindingEvidence>;
    return {
      checks: Array.isArray(parsed.checks) ? parsed.checks.filter((c) => typeof c === "string") : [],
      screenshots: Array.isArray(parsed.screenshots)
        ? parsed.screenshots.filter((s) => typeof s === "string")
        : [],
      diff: typeof parsed.diff === "string" ? parsed.diff : undefined,
    };
  } catch {
    return { ...EMPTY_EVIDENCE };
  }
}

function toReviewFinding(row: ReviewFindingRow): ReviewFinding {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sessionId: row.session_id ?? undefined,
    severity: row.severity,
    title: row.title,
    body: row.body,
    file: row.file ?? undefined,
    line: row.line ?? undefined,
    status: row.status,
    fixLaunchId: row.fix_launch_id ?? undefined,
    evidence: parseEvidence(row.evidence),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** High/critical are the only severities that surface on the review-queue. */
export function isHighSeverity(severity: TicketSeverity): boolean {
  return severity === "high" || severity === "critical";
}

export function createReviewFinding(
  db: Database,
  input: {
    ticketId: string;
    sessionId?: string;
    severity?: TicketSeverity; // defaults to "medium"
    title: string;
    body?: string;
    file?: string;
    line?: number;
    evidence?: ReviewFindingEvidence;
  }
): ReviewFinding {
  const id = randomUUID();
  db.run(
    `INSERT INTO review_findings (id, ticket_id, session_id, severity, title, body, file, line, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.ticketId,
      input.sessionId ?? null,
      input.severity ?? "medium",
      input.title,
      input.body ?? "",
      input.file ?? null,
      input.line ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
    ]
  );
  return getReviewFinding(db, id)!;
}

export function getReviewFinding(db: Database, id: string): ReviewFinding | null {
  const row = db
    .query("SELECT * FROM review_findings WHERE id = ?")
    .get(id) as ReviewFindingRow | null;
  return row ? toReviewFinding(row) : null;
}

/** Every finding for a ticket, newest first — the full set the reviewer produced. */
export function getReviewFindingsByTicket(db: Database, ticketId: string): ReviewFinding[] {
  const rows = db
    .query("SELECT * FROM review_findings WHERE ticket_id = ? ORDER BY created_at DESC")
    .all(ticketId) as ReviewFindingRow[];
  return rows.map(toReviewFinding);
}

/**
 * The High/critical, still-open findings for a ticket — exactly what surfaces on
 * the Work review-queue. This is the de-noise filter: low/medium findings are
 * recorded but never pushed at the human, and a dispatched/dismissed one drops
 * off the queue.
 */
export function getHighFindingsByTicket(db: Database, ticketId: string): ReviewFinding[] {
  const rows = db
    .query(
      `SELECT * FROM review_findings
         WHERE ticket_id = ? AND status = 'open' AND severity IN ('high', 'critical')
         ORDER BY created_at DESC`
    )
    .all(ticketId) as ReviewFindingRow[];
  return rows.map(toReviewFinding);
}

/** Every High/critical, still-open finding across all tickets (the queue snapshot). */
export function getOpenHighFindings(db: Database): ReviewFinding[] {
  const rows = db
    .query(
      `SELECT * FROM review_findings
         WHERE status = 'open' AND severity IN ('high', 'critical')
         ORDER BY created_at DESC`
    )
    .all() as ReviewFindingRow[];
  return rows.map(toReviewFinding);
}

/**
 * Supersede a ticket's still-`open` findings ahead of a fresh review pass, so a
 * re-review (the needs_review -> developing -> needs_review rework edge) doesn't
 * stack a second set of findings — and a stale duplicate carrying a pre-fix diff
 * — on top of the first. Only `open` rows are touched: a `dispatched` finding has
 * a fixer in flight and a `dismissed` one is already a human verdict, so both are
 * left as-is. Returns the findings it superseded (post-update) so the caller can
 * broadcast their removal from the live queue.
 */
export function supersedeOpenFindings(db: Database, ticketId: string): ReviewFinding[] {
  const open = db
    .query("SELECT * FROM review_findings WHERE ticket_id = ? AND status = 'open'")
    .all(ticketId) as ReviewFindingRow[];
  if (open.length === 0) return [];
  db.run(
    "UPDATE review_findings SET status = 'superseded', updated_at = datetime('now') WHERE ticket_id = ? AND status = 'open'",
    [ticketId]
  );
  return open
    .map((row) => getReviewFinding(db, row.id))
    .filter((f): f is ReviewFinding => f !== null);
}

export function setFindingStatus(
  db: Database,
  id: string,
  status: ReviewFindingStatus
): ReviewFinding | null {
  db.run(
    "UPDATE review_findings SET status = ?, updated_at = datetime('now') WHERE id = ?",
    [status, id]
  );
  return getReviewFinding(db, id);
}

/** Records the fresh fixer launch a human dispatched for a finding. */
export function setFindingFixLaunch(db: Database, id: string, launchId: string): void {
  db.run(
    "UPDATE review_findings SET fix_launch_id = ?, updated_at = datetime('now') WHERE id = ?",
    [launchId, id]
  );
}
