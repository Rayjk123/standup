import type { Database } from "bun:sqlite";
import type { HookEvent, HookEventType } from "@standup/shared";
import { SILENCE_METER_MINUTES } from "@standup/shared";

export function insertEvent(
  db: Database,
  sessionId: string,
  type: HookEventType,
  payload: Record<string, unknown>
): number {
  // Get next sequence number for this session
  const seqRow = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM events WHERE session_id = ?")
    .get(sessionId) as { next_seq: number };

  const seq = seqRow.next_seq;

  db.run(
    "INSERT INTO events (session_id, seq, type, payload_json) VALUES (?, ?, ?, ?)",
    [sessionId, seq, type, JSON.stringify(payload)]
  );

  return seq;
}

export function getEventsBySession(
  db: Database,
  sessionId: string,
  limit = 100,
  afterSeq = 0
): HookEvent[] {
  const rows = db
    .query(
      `SELECT * FROM events
       WHERE session_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(sessionId, afterSeq, limit) as Array<{
    id: number;
    session_id: string;
    seq: number;
    type: HookEventType;
    payload_json: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload_json),
    createdAt: new Date(row.created_at),
  }));
}

export function getLatestEventSeq(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) as seq FROM events WHERE session_id = ?")
    .get(sessionId) as { seq: number };

  return row.seq;
}

/**
 * One boolean per minute for the last `windowMinutes`, oldest first, true if
 * any event landed in that minute. Powers the silence meter — this is the
 * "no checkpoint/activity in N minutes" signal made visible per-session.
 */
export function getSilenceTicks(
  db: Database,
  sessionId: string,
  windowMinutes: number = SILENCE_METER_MINUTES
): boolean[] {
  const rows = db
    .query(
      `SELECT strftime('%Y-%m-%dT%H:%M', created_at) as bucket
       FROM events
       WHERE session_id = ? AND created_at >= datetime('now', ?)
       GROUP BY bucket`
    )
    .all(sessionId, `-${windowMinutes} minutes`) as Array<{ bucket: string }>;

  const activeBuckets = new Set(rows.map((r) => r.bucket));

  const ticks: boolean[] = [];
  const now = Date.now();
  for (let i = windowMinutes - 1; i >= 0; i--) {
    const bucket = new Date(now - i * 60_000).toISOString().slice(0, 16);
    ticks.push(activeBuckets.has(bucket));
  }

  return ticks;
}

export function pruneOldEvents(
  db: Database,
  sessionId: string,
  keepCount: number
): number {
  const result = db.run(
    `DELETE FROM events
     WHERE session_id = ? AND seq <= (
       SELECT seq FROM events WHERE session_id = ?
       ORDER BY seq DESC LIMIT 1 OFFSET ?
     )`,
    [sessionId, sessionId, keepCount]
  );

  return result.changes;
}
