import type { Database } from "bun:sqlite";
import type { TranscriptEvent, TranscriptEventsPage } from "@standup/shared";

/**
 * The durable, sequence-numbered transcript log.
 *
 * transcript_events is the ordered per-session log; transcript_event_identities
 * maps a record's stable identity (its JSONL uuid, plus an optional
 * idempotency_key for a future optimistic send) onto its seq. Appends dedup on
 * that identity so re-ingesting the same JSONL — or replaying a send — resolves
 * to the existing seq rather than adding a duplicate.
 */

export interface AppendEventInput {
  /** The source record's stable id — the JSONL uuid for an ingested record. */
  eventId: string;
  /** The transcript record to store; JSON-serialized into event_json. */
  event: unknown;
  /**
   * Dedup key for a side-effecting send (optimistic + idempotent). Ingested
   * records leave this unset — the partial unique index ignores nulls.
   */
  idempotencyKey?: string | null;
}

export interface AppendEventResult {
  seq: number;
  /** False when the append was a dedup hit — the event was already logged. */
  inserted: boolean;
}

/**
 * Appends one event to a session's log, assigning the next per-session seq.
 *
 * Idempotent: a repeat eventId (or idempotency_key) resolves to the seq the
 * event already holds and inserts nothing, so ingest and send replays are safe
 * to run repeatedly. The read-then-write runs in one transaction so a
 * concurrent append can't hand out the same seq twice.
 */
export function appendEvent(
  db: Database,
  sessionId: string,
  input: AppendEventInput
): AppendEventResult {
  const idempotencyKey = input.idempotencyKey ?? null;

  const tx = db.transaction((): AppendEventResult => {
    const byId = db
      .query(
        "SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?"
      )
      .get(sessionId, input.eventId) as { seq: number } | null;
    if (byId) return { seq: byId.seq, inserted: false };

    if (idempotencyKey !== null) {
      const byKey = db
        .query(
          "SELECT seq FROM transcript_event_identities WHERE session_id = ? AND idempotency_key = ?"
        )
        .get(sessionId, idempotencyKey) as { seq: number } | null;
      if (byKey) return { seq: byKey.seq, inserted: false };
    }

    const { next } = db
      .query(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transcript_events WHERE session_id = ?"
      )
      .get(sessionId) as { next: number };

    db.run(
      "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
      [sessionId, next, JSON.stringify(input.event)]
    );
    db.run(
      "INSERT INTO transcript_event_identities (session_id, event_id, seq, idempotency_key) VALUES (?, ?, ?, ?)",
      [sessionId, input.eventId, next, idempotencyKey]
    );

    return { seq: next, inserted: true };
  });

  return tx();
}

/**
 * A forward page of events after `sinceSeq`, oldest-first, plus the cursor to
 * resume from. The cursor is the last returned event's seq, or `sinceSeq`
 * unchanged when the page is empty — so a caller that keeps passing the cursor
 * back walks the whole log exactly once and then idles at the head.
 */
export function getEventsSince(
  db: Database,
  sessionId: string,
  sinceSeq = 0,
  limit = 500
): TranscriptEventsPage {
  const rows = db
    .query(
      `SELECT te.seq AS seq,
              tei.event_id AS event_id,
              te.event_json AS event_json,
              te.created_at AS created_at
         FROM transcript_events te
         LEFT JOIN transcript_event_identities tei
           ON tei.session_id = te.session_id AND tei.seq = te.seq
        WHERE te.session_id = ? AND te.seq > ?
        ORDER BY te.seq ASC
        LIMIT ?`
    )
    .all(sessionId, sinceSeq, limit) as Array<{
    seq: number;
    event_id: string | null;
    event_json: string;
    created_at: string;
  }>;

  const events: TranscriptEvent[] = rows.map((row) => ({
    seq: row.seq,
    eventId: row.event_id,
    event: JSON.parse(row.event_json),
    createdAt: row.created_at,
  }));

  const cursor = events.length > 0 ? events[events.length - 1].seq : sinceSeq;
  return { events, cursor };
}

/**
 * A backward (tail) page: the newest `limit` events with `seq < before`, or —
 * when `before` is 0 — the newest `limit` events in the session (the tail).
 * Returned OLDEST-first so a caller can concat or prepend them in log order.
 *
 * This is what lets a client open a long session in constant time: it loads
 * only the tail window instead of paging the whole log forward from seq 0, then
 * pages further back on demand by passing the returned `firstSeq` as the next
 * `before`. `hasEarlier` reports whether any event still precedes the page,
 * `headSeq` is the session head at query time (where forward live-tailing
 * resumes), and `cursor` mirrors getEventsSince's forward-resume contract.
 */
export function getEventsBefore(
  db: Database,
  sessionId: string,
  before = 0,
  limit = 300
): TranscriptEventsPage {
  const upper = before > 0 ? before : Number.MAX_SAFE_INTEGER;
  const rows = db
    .query(
      `SELECT te.seq AS seq,
              tei.event_id AS event_id,
              te.event_json AS event_json,
              te.created_at AS created_at
         FROM transcript_events te
         LEFT JOIN transcript_event_identities tei
           ON tei.session_id = te.session_id AND tei.seq = te.seq
        WHERE te.session_id = ? AND te.seq < ?
        ORDER BY te.seq DESC
        LIMIT ?`
    )
    .all(sessionId, upper, limit) as Array<{
    seq: number;
    event_id: string | null;
    event_json: string;
    created_at: string;
  }>;
  // Query is newest-first (so LIMIT keeps the tail); flip to oldest-first.
  rows.reverse();

  const events: TranscriptEvent[] = rows.map((row) => ({
    seq: row.seq,
    eventId: row.event_id,
    event: JSON.parse(row.event_json),
    createdAt: row.created_at,
  }));

  const firstSeq = events.length > 0 ? events[0].seq : before;
  const cursor = events.length > 0 ? events[events.length - 1].seq : before;
  const hasEarlier =
    events.length > 0 &&
    !!db
      .query(
        "SELECT 1 FROM transcript_events WHERE session_id = ? AND seq < ? LIMIT 1"
      )
      .get(sessionId, firstSeq);

  return { events, cursor, hasEarlier, firstSeq, headSeq: headSeq(db, sessionId) };
}

/** The synthetic identity a pending optimistic reply is logged under. */
function pendingEventId(idempotencyKey: string): string {
  return `pending:${idempotencyKey}`;
}

export interface PendingReplyInput {
  /** Client-minted key; the same key on a retry resolves to the same seq. */
  idempotencyKey: string;
  /** The reply text, typed into the pane and shown as an optimistic message. */
  text: string;
  /** The actor who sent the reply, carried on the optimistic event. */
  actor?: string | null;
}

/**
 * Logs an optimistic "pending" user reply keyed by its idempotency key, so the
 * sender's message shows in the transcript the instant it is sent rather than
 * only once the agent's JSONL records it. The event is shaped like a real user
 * record (type/message.content) so the existing projection renders it with no
 * special-casing; `pending`/`sentBy` mark its provenance.
 *
 * Idempotent on the key: a retried or double-clicked send resolves to the seq
 * the first send already claimed and inserts nothing (inserted: false) — the
 * caller uses that to type into the pane exactly once.
 */
export function appendPendingReply(
  db: Database,
  sessionId: string,
  input: PendingReplyInput
): AppendEventResult {
  const event = {
    type: "user",
    uuid: pendingEventId(input.idempotencyKey),
    timestamp: new Date().toISOString(),
    message: { role: "user", content: input.text },
    pending: true,
    sentBy: input.actor ?? undefined,
  };
  return appendEvent(db, sessionId, {
    eventId: pendingEventId(input.idempotencyKey),
    event,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Drops a pending optimistic reply — used when the send that claimed the key
 * fails to type into the pane, so a genuine retry with the same key is not
 * treated as a duplicate. A no-op if the key was already reconciled to a real
 * record (its event_id no longer matches the synthetic pending id).
 */
export function releasePendingReply(
  db: Database,
  sessionId: string,
  idempotencyKey: string
): void {
  const eventId = pendingEventId(idempotencyKey);
  const tx = db.transaction(() => {
    const row = db
      .query(
        "SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = ?"
      )
      .get(sessionId, eventId) as { seq: number } | null;
    if (!row) return;
    db.run(
      "DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
      [sessionId, eventId]
    );
    db.run("DELETE FROM transcript_events WHERE session_id = ? AND seq = ?", [
      sessionId,
      row.seq,
    ]);
  });
  tx();
}

/**
 * Reconciles a real user record ingested from the JSONL against a pending
 * optimistic reply of the same text: the pending event is rewritten in place
 * (same seq, preserving order and the client's optimistic position) to the real
 * record, and its identity is repointed to the real JSONL uuid so a re-ingest
 * dedups on it. The idempotency key is kept, so a retried send still resolves to
 * this seq. Returns true when a pending event was reconciled — the caller then
 * skips appending the real record, which would otherwise duplicate the message.
 */
export function reconcilePendingReply(
  db: Database,
  sessionId: string,
  input: { text: string; eventId: string; event: unknown }
): boolean {
  const wanted = input.text.trim();
  if (!wanted) return false;

  const tx = db.transaction((): boolean => {
    // Never reconcile against a record already in the log. Ingest re-reads the
    // whole transcript from offset 0 on a cold start, so it re-encounters
    // historical records whose text can match a still-pending reply (a short
    // 'continue'/'ok' recurs constantly). Repointing a pending row's event_id
    // onto an id that already exists violates the identity PK and throws,
    // wedging the session's ingest; leave an already-logged record to
    // appendEvent's own dedup instead.
    const already = db
      .query(
        "SELECT 1 FROM transcript_event_identities WHERE session_id = ? AND event_id = ?"
      )
      .get(sessionId, input.eventId);
    if (already) return false;

    // Newest pending first: the record now ingesting corresponds to the most
    // recently sent reply, so match that one rather than an older pending of the
    // same text. A stale pending — a reply consumed by a TUI/permission dialog
    // that never became its own user record — would otherwise be repointed ahead
    // of the real one, dragging the message back to the stale seq and orphaning
    // the newer pending.
    const rows = db
      .query(
        `SELECT te.seq AS seq, te.event_json AS event_json
           FROM transcript_events te
           JOIN transcript_event_identities tei
             ON tei.session_id = te.session_id AND tei.seq = te.seq
          WHERE te.session_id = ? AND tei.idempotency_key IS NOT NULL
          ORDER BY te.seq DESC`
      )
      .all(sessionId) as Array<{ seq: number; event_json: string }>;

    for (const row of rows) {
      let parsed: {
        type?: string;
        pending?: boolean;
        sentBy?: unknown;
        message?: { content?: unknown };
      };
      try {
        parsed = JSON.parse(row.event_json);
      } catch {
        continue;
      }
      if (parsed.type !== "user" || parsed.pending !== true) continue;
      const content = parsed.message?.content;
      if (typeof content !== "string" || content.trim() !== wanted) continue;

      // Carry the optimistic event's attribution onto the durable record. The
      // raw JSONL turn has no sender, so without this the reply's author would be
      // discarded the instant the real turn ingests.
      const sentBy = typeof parsed.sentBy === "string" ? parsed.sentBy : undefined;
      const stored =
        sentBy &&
        input.event &&
        typeof input.event === "object" &&
        !Array.isArray(input.event)
          ? { ...(input.event as Record<string, unknown>), sentBy }
          : input.event;

      db.run(
        "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = ?",
        [JSON.stringify(stored), sessionId, row.seq]
      );
      db.run(
        "UPDATE transcript_event_identities SET event_id = ? WHERE session_id = ? AND seq = ?",
        [input.eventId, sessionId, row.seq]
      );
      return true;
    }
    return false;
  });

  return tx();
}

/** The highest seq logged for a session, or 0 when it has no events yet. */
export function headSeq(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_events WHERE session_id = ?")
    .get(sessionId) as { seq: number };
  return row.seq;
}
