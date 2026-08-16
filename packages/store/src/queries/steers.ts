import type { Database } from "bun:sqlite";
import type { Steer, SteerStatus } from "@standup/shared";
import { randomUUID } from "crypto";

export function createSteer(
  db: Database,
  sessionId: string,
  body: string
): Steer {
  const id = randomUUID();

  db.run(
    "INSERT INTO steers (id, session_id, body) VALUES (?, ?, ?)",
    [id, sessionId, body]
  );

  return {
    id,
    sessionId,
    body,
    status: "pending",
    createdAt: new Date(),
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

export function getAllPendingSteers(db: Database): Steer[] {
  const rows = db
    .query("SELECT * FROM steers WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as Array<{
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
