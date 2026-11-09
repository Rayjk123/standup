import type { Database } from "bun:sqlite";
import type { Steer, SteerStatus } from "@standup/shared";
import { randomUUID } from "crypto";

/** A `steers` row as SELECT * (or RETURNING *) reads it. */
export interface SteerRow {
  id: string;
  session_id: string;
  body: string;
  status: SteerStatus;
  created_at: string;
  delivered_at: string | null;
  audience?: string | null;
}

export function toSteer(row: SteerRow): Steer {
  return {
    id: row.id,
    sessionId: row.session_id,
    body: row.body,
    status: row.status,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : undefined,
    ...(row.audience ? { audience: row.audience } : {}),
  };
}

/**
 * Queues a steer for a session. `audience` names the one user its body is
 * for (Steer.audience); an ordinary steer has none.
 */
export function createSteer(
  db: Database,
  sessionId: string,
  body: string,
  opts: { audience?: string } = {}
): Steer {
  const id = randomUUID();
  const audience = opts.audience?.trim() || undefined;

  if (audience) {
    db.run("INSERT INTO steers (id, session_id, body, audience) VALUES (?, ?, ?, ?)", [id, sessionId, body, audience]);
  } else {
    db.run("INSERT INTO steers (id, session_id, body) VALUES (?, ?, ?)", [id, sessionId, body]);
  }

  return {
    id,
    sessionId,
    body,
    status: "pending",
    createdAt: new Date(),
    ...(audience ? { audience } : {}),
  };
}

export function deliverSteer(db: Database, steerId: string): void {
  db.run(
    "UPDATE steers SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?",
    [steerId]
  );
}

export function cancelSteer(db: Database, steerId: string): void {
  db.run(
    "UPDATE steers SET status = 'cancelled' WHERE id = ?",
    [steerId]
  );
}

export function getPendingSteers(
  db: Database,
  sessionId: string
): Steer[] {
  const rows = db
    .query(
      "SELECT * FROM steers WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC"
    )
    .all(sessionId) as SteerRow[];

  return rows.map(toSteer);
}

/**
 * How many steers with exactly `body` were queued for the session, whatever
 * became of them — only those queued after `since` (an ISO time) when given.
 */
export function countSteersWithBody(db: Database, sessionId: string, body: string, since?: string): number {
  const row = (
    since
      ? db
          .query("SELECT COUNT(*) AS n FROM steers WHERE session_id = ? AND body = ? AND created_at > datetime(?)")
          .get(sessionId, body, since)
      : db.query("SELECT COUNT(*) AS n FROM steers WHERE session_id = ? AND body = ?").get(sessionId, body)
  ) as { n: number };
  return row.n;
}

export function getAllPendingSteers(db: Database): Steer[] {
  const rows = db
    .query("SELECT * FROM steers WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as SteerRow[];

  return rows.map(toSteer);
}
