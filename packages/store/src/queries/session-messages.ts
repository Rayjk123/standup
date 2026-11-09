import type { Database } from "bun:sqlite";
import type { SessionMessage, SessionMessageStatus } from "@standup/shared";
import { randomUUID } from "crypto";

interface SessionMessageRow {
  id: string;
  to_session_id: string;
  from_session_id: string | null;
  from_label: string | null;
  body: string;
  status: SessionMessageStatus;
  created_at: string;
  delivered_at: string | null;
}

function rowToMessage(row: SessionMessageRow): SessionMessage {
  return {
    id: row.id,
    toSessionId: row.to_session_id,
    fromSessionId: row.from_session_id ?? undefined,
    fromLabel: row.from_label ?? undefined,
    body: row.body,
    status: row.status,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
  };
}

/**
 * Enqueues a message from one session for another into the recipient's mailbox.
 * The row starts `pending`; it reaches the target agent at its next turn
 * boundary, drained by claimPendingMessages through the same injection seam
 * steers ride. `fromSessionId` / `fromLabel` attribute it to the sender.
 */
export function createSessionMessage(
  db: Database,
  input: {
    toSessionId: string;
    fromSessionId?: string;
    fromLabel?: string;
    body: string;
  }
): SessionMessage {
  const id = randomUUID();

  db.run(
    `INSERT INTO session_messages (id, to_session_id, from_session_id, from_label, body)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      input.toSessionId,
      input.fromSessionId ?? null,
      input.fromLabel ?? null,
      input.body,
    ]
  );

  return {
    id,
    toSessionId: input.toSessionId,
    fromSessionId: input.fromSessionId,
    fromLabel: input.fromLabel,
    body: input.body,
    status: "pending",
    createdAt: new Date(),
  };
}

/**
 * Atomically claims every pending message for a session: marks them delivered
 * and returns them in one statement. Single-statement RETURNING (rather than
 * SELECT-then-UPDATE) so two delivery points firing near-simultaneously — a
 * UserPromptSubmit hook and a checkpoint call — can't both hand the same
 * message to the agent. Mirrors claimPendingSteers.
 */
export function claimPendingMessages(db: Database, sessionId: string): SessionMessage[] {
  const rows = db
    .query(
      `UPDATE session_messages
         SET status = 'delivered', delivered_at = datetime('now')
       WHERE to_session_id = ? AND status = 'pending'
       RETURNING id, to_session_id, from_session_id, from_label, body, status, created_at, delivered_at`
    )
    .all(sessionId) as SessionMessageRow[];

  return rows.map(rowToMessage);
}

/**
 * A single message by id, in any status, or null when there is no such row.
 * Used by the cancel path to resolve the message's sender/recipient so a caller
 * can be checked for standing before it is allowed to destroy the queued row.
 */
export function getSessionMessage(db: Database, messageId: string): SessionMessage | null {
  const row = db
    .query("SELECT * FROM session_messages WHERE id = ?")
    .get(messageId) as SessionMessageRow | null;
  return row ? rowToMessage(row) : null;
}

/** The pending messages for a session, without draining them (a peek). */
export function getPendingMessages(db: Database, sessionId: string): SessionMessage[] {
  const rows = db
    .query(
      "SELECT * FROM session_messages WHERE to_session_id = ? AND status = 'pending' ORDER BY created_at ASC"
    )
    .all(sessionId) as SessionMessageRow[];

  return rows.map(rowToMessage);
}

export function cancelSessionMessage(db: Database, messageId: string): void {
  db.run("UPDATE session_messages SET status = 'cancelled' WHERE id = ?", [messageId]);
}

/**
 * Cancels every still-pending message addressed to a session in one statement
 * and returns the cancelled rows, so a caller discarding a mailbox wholesale
 * can broadcast their new state. A pending message is otherwise left to ride
 * to the recipient's next turn (like a queued steer), so this is reserved for
 * an explicit discard — it is deliberately NOT wired to SessionEnd or a console
 * stop, since those are non-terminal for the session id (resume/clear revive
 * it) and would silently drop coordination the sender was told had landed.
 */
export function cancelPendingMessagesFor(
  db: Database,
  sessionId: string
): SessionMessage[] {
  const rows = db
    .query(
      `UPDATE session_messages
         SET status = 'cancelled'
       WHERE to_session_id = ? AND status = 'pending'
       RETURNING id, to_session_id, from_session_id, from_label, body, status, created_at, delivered_at`
    )
    .all(sessionId) as SessionMessageRow[];

  return rows.map(rowToMessage);
}
