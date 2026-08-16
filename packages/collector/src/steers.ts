import type { Database } from "bun:sqlite";
import type { Steer, SteerStatus } from "@standup/shared";

/**
 * Atomically claims every pending steer for a session: marks them delivered
 * and returns them in one statement. Single-statement RETURNING (rather than
 * SELECT-then-UPDATE) so two delivery points firing near-simultaneously —
 * e.g. a UserPromptSubmit hook and a checkpoint call — can't both hand the
 * same steer to the agent.
 */
export function claimPendingSteers(db: Database, sessionId: string): Steer[] {
  const rows = db
    .query(
      `UPDATE steers
         SET status = 'delivered', delivered_at = datetime('now')
       WHERE session_id = ? AND status = 'pending'
       RETURNING id, session_id, body, status, created_at, delivered_at`
    )
    .all(sessionId) as Array<{
    id: string;
    session_id: string;
    body: string;
    status: SteerStatus;
    created_at: string;
    delivered_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    body: row.body,
    status: row.status,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
  }));
}

/**
 * Renders claimed steers as context text for the agent. Explicitly framed as
 * coming from the human so the agent treats it as a real instruction rather
 * than ambient background context it can ignore.
 */
export function formatSteers(steers: Steer[]): string {
  if (steers.length === 1) {
    return (
      `[Steering message from your human, sent via the Standup console]\n` +
      `${steers[0].body}`
    );
  }

  const numbered = steers.map((s, i) => `${i + 1}. ${s.body}`).join("\n");
  return (
    `[${steers.length} steering messages from your human, sent via the Standup console]\n` +
    numbered
  );
}

/**
 * Claims and formats in one step. Returns null when nothing is queued, so
 * callers can skip adding an empty context block.
 */
export function takeSteerContext(
  db: Database,
  sessionId: string
): { text: string; steers: Steer[] } | null {
  const steers = claimPendingSteers(db, sessionId);
  if (steers.length === 0) return null;
  return { text: formatSteers(steers), steers };
}
