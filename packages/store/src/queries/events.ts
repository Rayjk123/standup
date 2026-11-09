import type { Database } from "bun:sqlite";
import type { HookEvent, HookEventType, HookPayload } from "@standup/shared";
import { SILENCE_METER_MINUTES } from "@standup/shared";

export function insertEvent(
  db: Database,
  sessionId: string,
  type: HookEventType,
  // Only ever JSON.stringified, never indexed — accepts the real hook
  // payload shapes directly rather than forcing every caller to cast.
  payload: Record<string, unknown> | HookPayload
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

/**
 * The most recent `limit` events, oldest-first.
 *
 * Distinct from getEventsBySession, which pages forward from a sequence
 * number and therefore returns the *oldest* rows when called with afterSeq
 * 0. Anything reasoning about what an agent is doing right now needs the
 * tail, and silently got the head instead.
 */
export function getRecentEventsBySession(
  db: Database,
  sessionId: string,
  limit = 60
): HookEvent[] {
  const rows = db
    .query(
      `SELECT * FROM events
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?`
    )
    .all(sessionId, limit) as Array<{
    id: number;
    session_id: string;
    seq: number;
    type: HookEventType;
    payload_json: string;
    created_at: string;
  }>;

  return rows.reverse().map((row) => ({
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

  return silenceTicks(new Set(rows.map((r) => r.bucket)), windowMinutes, Date.now());
}

/** One boolean per minute ending at `now`, oldest first: whether that minute is in `activeBuckets`. */
function silenceTicks(activeBuckets: Set<string>, windowMinutes: number, now: number): boolean[] {
  const ticks: boolean[] = [];
  for (let i = windowMinutes - 1; i >= 0; i--) {
    const bucket = new Date(now - i * 60_000).toISOString().slice(0, 16);
    ticks.push(activeBuckets.has(bucket));
  }
  return ticks;
}

/**
 * getSilenceTicks for many sessions in one query, keyed by session id; every
 * id gets an entry. The CROSS JOIN keeps the session list as the outer loop so
 * each session reads only its window through idx_events_session_created rather
 * than the whole events table.
 */
export function getSilenceTicksBySession(
  db: Database,
  sessionIds: readonly string[],
  windowMinutes: number = SILENCE_METER_MINUTES
): Map<string, boolean[]> {
  const rows = db
    .query(
      `SELECT e.session_id AS session_id, strftime('%Y-%m-%dT%H:%M', e.created_at) AS bucket
         FROM json_each(?) AS j CROSS JOIN events AS e
        WHERE e.session_id = j.value AND e.created_at >= datetime('now', ?)
        GROUP BY e.session_id, bucket`
    )
    .all(JSON.stringify(sessionIds), `-${windowMinutes} minutes`) as Array<{
    session_id: string;
    bucket: string;
  }>;

  const buckets = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = buckets.get(row.session_id);
    if (set) set.add(row.bucket);
    else buckets.set(row.session_id, new Set([row.bucket]));
  }
  const now = Date.now();
  const none = new Set<string>();
  return new Map(
    sessionIds.map((id) => [id, silenceTicks(buckets.get(id) ?? none, windowMinutes, now)])
  );
}

/**
 * Identifies a session's newest event: its seq, and its row id, which
 * AUTOINCREMENT never reuses once committed — so a session deleted and
 * recreated under the same id never matches a mark taken before the delete,
 * even at the same seq. (A rolled-back insert's id is handed out again, so a
 * mark read inside a transaction that then rolls back can recur.) Events only
 * append, so anything derived from a session's events is unchanged while
 * this is.
 */
export interface LatestEventMark {
  seq: number;
  id: number;
}

/** The mark of a session's newest event, or null when it has none. Reads one row of the (session_id, seq) index. */
export function getLatestEventMark(db: Database, sessionId: string): LatestEventMark | null {
  return (
    (db
      .query("SELECT seq, id FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
      .get(sessionId) as LatestEventMark | null) ?? null
  );
}

/** getLatestEventMark for many sessions in one query; a session with no events has no entry. */
export function getLatestEventMarks(
  db: Database,
  sessionIds: readonly string[]
): Map<string, LatestEventMark> {
  const rows = db
    .query(
      `SELECT j.value AS session_id, e.seq AS seq, e.id AS id
         FROM json_each(?) AS j CROSS JOIN events AS e
        WHERE e.id = (SELECT id FROM events WHERE session_id = j.value ORDER BY seq DESC LIMIT 1)`
    )
    .all(JSON.stringify(sessionIds)) as Array<{ session_id: string } & LatestEventMark>;
  return new Map(rows.map((r) => [r.session_id, { seq: r.seq, id: r.id }]));
}

/**
 * Deletes all but a session's newest `keepCount` events. It leaves the newest
 * event — and so the session's LatestEventMark — in place, so the collector's
 * transcript path / effort memo (transcript.ts) would keep answering from a
 * pruned event. Nothing calls this today; a caller must invalidate that memo
 * for the session as well.
 */
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
