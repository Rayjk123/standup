import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { HUMAN_REVIEW_STAGE_KIND, deriveJobState } from "@standup/shared";
import type {
  JobStateFacts,
  PersonaJobWaitingSource,
  SessionStatus,
  PersonaApproval,
  PersonaApprovalStatus,
  PersonaAttachment,
  PersonaAudience,
  PersonaChannel,
  PersonaInboxKind,
  PersonaJob,
  PersonaJobAction,
  PersonaJobStatus,
  PersonaJobTagSource,
  PersonaMessage,
  PersonaMessageCommand,
  PersonaMessageJobTag,
  PersonaMessageNotify,
  PersonaMessageRole,
  PersonaThread,
  PersonaThreadSummary,
  PipelineOverride,
} from "@standup/shared";
import { claimPersonaAttachments } from "./persona-attachments.js";
import { personaJobBudget } from "./persona-budget.js";
import { pendingReviewPacketsForJob } from "./review-packets.js";

/**
 * Persona's durable state — threads + messages, the wake inbox, the per-owner
 * runtime row, jobs and their launches, and held approvals. See migrations 050
 * and 051.
 * Timestamps are ISO-8601 strings, so lexical comparison is chronological.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null): T | undefined {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// ── Threads ─────────────────────────────────────────────────────────────────

interface ThreadRow {
  id: string;
  owner: string;
  channel: string;
  external_ref: string | null;
  title: string | null;
  audience: string | null;
  created_at: string;
  updated_at: string;
}

/** Audiences from narrowest to widest readership. */
const AUDIENCE_RANK: Record<PersonaAudience, number> = { private: 0, shared: 1, external: 2 };

function asAudience(value: string | null | undefined): PersonaAudience {
  return value === "shared" || value === "external" ? value : "private";
}

/**
 * The audience a thread ends up with when `requested` is asked of one that
 * has `current`: only ever widened toward `external`, never back toward
 * `private`, so a thread other people have read is never treated as the
 * owner's alone.
 */
export function mergePersonaAudience(current: PersonaAudience, requested: PersonaAudience | undefined): PersonaAudience {
  if (!requested) return current;
  return AUDIENCE_RANK[requested] > AUDIENCE_RANK[current] ? requested : current;
}

function toThread(row: ThreadRow): PersonaThread {
  return {
    id: row.id,
    owner: row.owner,
    channel: row.channel as PersonaChannel,
    externalRef: row.external_ref ?? undefined,
    title: row.title ?? undefined,
    audience: asAudience(row.audience),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPersonaThread(db: Database, threadId: string): PersonaThread | null {
  const row = db
    .query("SELECT * FROM persona_threads WHERE id = ?")
    .get(threadId) as ThreadRow | null;
  return row ? toThread(row) : null;
}

/**
 * The owner's console thread, created on first use. There is one per owner;
 * the oldest wins should a race ever have inserted two.
 */
export function getOrCreatePersonaConsoleThread(db: Database, owner: string): PersonaThread {
  const existing = db
    .query(
      "SELECT * FROM persona_threads WHERE owner = ? AND channel = 'console' ORDER BY created_at ASC, rowid ASC LIMIT 1"
    )
    .get(owner) as ThreadRow | null;
  if (existing) return toThread(existing);
  const id = randomUUID();
  const at = nowIso();
  db.run(
    "INSERT INTO persona_threads (id, owner, channel, created_at, updated_at) VALUES (?, ?, 'console', ?, ?)",
    [id, owner, at, at]
  );
  return getPersonaThread(db, id)!;
}

/**
 * The owner's thread bound to `externalRef` on `channel` (e.g. a Slack DM or
 * channel thread), created on first use. The insert is guarded by the unique
 * (owner, channel, external_ref) index, so concurrent callers converge on one
 * row. A given `title` replaces the stored one (channel names can change)
 * without counting as thread activity. A new thread takes `audience` (default
 * `shared`); an existing one only ever widens to it (see mergePersonaAudience).
 */
export function getOrCreatePersonaThreadByRef(
  db: Database,
  owner: string,
  channel: PersonaChannel,
  externalRef: string,
  title?: string,
  audience?: PersonaAudience
): PersonaThread {
  return db.transaction(() => {
    const at = nowIso();
    db.run(
      `INSERT OR IGNORE INTO persona_threads (id, owner, channel, external_ref, title, audience, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), owner, channel, externalRef, title ?? null, audience ?? "shared", at, at]
    );
    if (title !== undefined) {
      db.run(
        "UPDATE persona_threads SET title = ? WHERE owner = ? AND channel = ? AND external_ref = ? AND COALESCE(title, '') != ?",
        [title, owner, channel, externalRef, title]
      );
    }
    const row = db
      .query("SELECT * FROM persona_threads WHERE owner = ? AND channel = ? AND external_ref = ?")
      .get(owner, channel, externalRef) as ThreadRow;
    const current = asAudience(row.audience);
    const merged = mergePersonaAudience(current, audience);
    if (merged !== current) {
      db.run("UPDATE persona_threads SET audience = ? WHERE id = ?", [merged, row.id]);
      return toThread({ ...row, audience: merged });
    }
    return toThread(row);
  })();
}

/**
 * The Claude session a non-private thread's turns resume. Private threads
 * share the owner's session in persona_state instead.
 */
export function getPersonaThreadSessionId(db: Database, threadId: string): string | undefined {
  const row = db
    .query("SELECT claude_session_id FROM persona_threads WHERE id = ?")
    .get(threadId) as { claude_session_id: string | null } | null;
  return row?.claude_session_id ?? undefined;
}

export function setPersonaThreadSessionId(db: Database, threadId: string, sessionId: string | null): void {
  db.run("UPDATE persona_threads SET claude_session_id = ? WHERE id = ?", [sessionId, threadId]);
}

/** Forgets every per-thread Claude session of the owner, so each thread's next turn starts fresh. */
export function clearPersonaThreadSessions(db: Database, owner: string): void {
  db.run("UPDATE persona_threads SET claude_session_id = NULL WHERE owner = ? AND claude_session_id IS NOT NULL", [owner]);
}

/** The owner's threads with their message count and latest message, newest activity first. */
export function listPersonaThreads(db: Database, owner: string): PersonaThreadSummary[] {
  const rows = db
    .query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM persona_messages m WHERE m.thread_id = t.id) AS message_count
         FROM persona_threads t
        WHERE t.owner = ?
        ORDER BY t.updated_at DESC, t.rowid DESC`
    )
    .all(owner) as Array<ThreadRow & { message_count: number }>;
  const lastOf = db.query(
    "SELECT seq, role, text, created_at FROM persona_messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 1"
  );
  return rows.map((row) => {
    const last = lastOf.get(row.id) as { seq: number; role: string; text: string; created_at: string } | null;
    return {
      ...toThread(row),
      messageCount: row.message_count,
      ...(last
        ? {
            lastMessage: {
              seq: last.seq,
              role: last.role as PersonaMessageRole,
              text: last.text,
              createdAt: last.created_at,
            },
          }
        : {}),
    };
  });
}

// ── Messages ────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  text: string;
  actor: string | null;
  options_json: string | null;
  recommended_option?: number | null;
  job_ids_json: string | null;
  approval_id: string | null;
  idempotency_key: string | null;
  attachments_json?: string | null;
  notify_json?: string | null;
  command_json?: string | null;
  answered_at?: string | null;
  reply_to_id?: string | null;
  created_at: string;
}

/**
 * Maps a row to a message carrying `tags` (its rows of persona_message_jobs,
 * oldest first). `jobIds` comes from the tags, not job_ids_json, so a removed
 * tag leaves both.
 */
function toMessage(row: MessageRow, tags: PersonaMessageJobTag[]): PersonaMessage {
  const options = parseJson<string[]>(row.options_json);
  const jobIds = tags.map((t) => t.jobId);
  const recommended = row.recommended_option;
  const attachments = parseJson<PersonaAttachment[]>(row.attachments_json ?? null);
  const notify = parseJson<PersonaMessageNotify>(row.notify_json ?? null);
  const command = parseJson<PersonaMessageCommand>(row.command_json ?? null);
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role as PersonaMessageRole,
    text: row.text,
    actor: row.actor ?? undefined,
    options: options && options.length > 0 ? options : undefined,
    ...(options && recommended != null && recommended >= 0 && recommended < options.length ? { recommendedOption: recommended } : {}),
    ...(options && row.answered_at ? { answeredAt: row.answered_at } : {}),
    ...(row.reply_to_id ? { replyToMessageId: row.reply_to_id } : {}),
    jobIds: jobIds.length > 0 ? jobIds : undefined,
    ...(tags.length > 0 ? { jobTags: tags } : {}),
    approvalId: row.approval_id ?? undefined,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    idempotencyKey: row.idempotency_key ?? undefined,
    ...(notify && typeof notify.kind === "string" && Array.isArray(notify.channels) ? { notify } : {}),
    ...(command && typeof command.name === "string" ? { command } : {}),
    createdAt: row.created_at,
  };
}

/** Maps rows to messages with their job tags, read in one query. */
function hydrateMessages(db: Database, rows: MessageRow[]): PersonaMessage[] {
  if (rows.length === 0) return [];
  const tagRows = db
    .query(
      `SELECT message_id, job_id, source FROM persona_message_jobs
        WHERE message_id IN (SELECT value FROM json_each(?))
        ORDER BY created_at ASC, rowid ASC`
    )
    .all(JSON.stringify(rows.map((r) => r.id))) as Array<{ message_id: string; job_id: string; source: string }>;
  const byMessage = new Map<string, PersonaMessageJobTag[]>();
  for (const t of tagRows) {
    const list = byMessage.get(t.message_id) ?? [];
    list.push({ jobId: t.job_id, source: t.source as PersonaJobTagSource });
    byMessage.set(t.message_id, list);
  }
  return rows.map((row) => toMessage(row, byMessage.get(row.id) ?? []));
}

function hydrateMessage(db: Database, row: MessageRow): PersonaMessage {
  return hydrateMessages(db, [row])[0]!;
}

export interface AppendPersonaMessageInput {
  threadId: string;
  role: PersonaMessageRole;
  text: string;
  actor?: string;
  options?: string[];
  /** Index into `options` of the one Persona recommends; ignored when out of range. */
  recommendedOption?: number;
  jobIds?: string[];
  approvalId?: string;
  idempotencyKey?: string;
  /**
   * Staged attachments of this thread the message carries: owner uploads
   * (stageOwnerUpload) on a `user` message, Persona's attach_image rows
   * (stagePersonaAttachment) on any other. Each is claimed in the same
   * transaction, so it rides on one message only.
   */
  attachmentIds?: string[];
  /** The notification the message is (its update kind and channels); omitted for a conversational reply. */
  notify?: PersonaMessageNotify;
  /** The slash command the message ran, or the command result it carries. */
  command?: PersonaMessageCommand;
  /** On an owner's quick-reply tap, the question it answers (personaTappedQuestion). */
  replyToMessageId?: string;
}

/**
 * Appends a message at the thread's next seq. The read-max-then-insert runs in
 * one transaction so concurrent appends cannot collide on a seq. A repeated
 * idempotency key returns the row it first created (`created: false`) instead
 * of appending a duplicate.
 *
 * `jobIds` is written to job_ids_json here, at insert, and nowhere else (only
 * removePersonaMessageJobTag narrows it). Every boot backfills a tag row for
 * each id in it that has none (ensurePersonaMessageJobsShape), so rewriting
 * job_ids_json would bring back tags the owner removed.
 */
export function appendPersonaMessage(
  db: Database,
  input: AppendPersonaMessageInput
): { message: PersonaMessage; created: boolean } {
  return db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = db
        .query("SELECT * FROM persona_messages WHERE thread_id = ? AND idempotency_key = ?")
        .get(input.threadId, input.idempotencyKey) as MessageRow | null;
      if (existing) return { message: hydrateMessage(db, existing), created: false };
    }
    const max = db
      .query("SELECT COALESCE(MAX(seq), 0) AS m FROM persona_messages WHERE thread_id = ?")
      .get(input.threadId) as { m: number };
    const id = randomUUID();
    const at = nowIso();
    const optionCount = input.options?.length ?? 0;
    const recommended =
      input.recommendedOption !== undefined &&
      Number.isInteger(input.recommendedOption) &&
      input.recommendedOption >= 0 &&
      input.recommendedOption < optionCount
        ? input.recommendedOption
        : null;
    db.run(
      `INSERT INTO persona_messages
         (id, thread_id, seq, role, text, actor, options_json, recommended_option, job_ids_json, approval_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        max.m + 1,
        input.role,
        input.text,
        input.actor ?? null,
        optionCount > 0 ? JSON.stringify(input.options) : null,
        recommended,
        input.jobIds && input.jobIds.length > 0 ? JSON.stringify(input.jobIds) : null,
        input.approvalId ?? null,
        input.idempotencyKey ?? null,
        at,
      ]
    );
    if (input.jobIds && input.jobIds.length > 0) {
      const tag = db.query(
        `INSERT OR IGNORE INTO persona_message_jobs (message_id, job_id, owner, source, created_at)
         SELECT ?, ?, owner, 'explicit', ? FROM persona_threads WHERE id = ?`
      );
      for (const jobId of input.jobIds) {
        if (jobId) tag.run(id, jobId, at, input.threadId);
      }
    }
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      const attachments = claimPersonaAttachments(db, input.threadId, id, input.attachmentIds, input.role === "user");
      if (attachments.length > 0) {
        db.run("UPDATE persona_messages SET attachments_json = ? WHERE id = ?", [JSON.stringify(attachments), id]);
      }
    }
    if (input.notify) {
      db.run("UPDATE persona_messages SET notify_json = ? WHERE id = ?", [JSON.stringify(input.notify), id]);
    }
    if (input.command) {
      db.run("UPDATE persona_messages SET command_json = ? WHERE id = ?", [JSON.stringify(input.command), id]);
    }
    if (input.replyToMessageId) {
      db.run("UPDATE persona_messages SET reply_to_id = ? WHERE id = ?", [input.replyToMessageId, id]);
    }
    db.run("UPDATE persona_threads SET updated_at = ? WHERE id = ?", [at, input.threadId]);
    const row = db.query("SELECT * FROM persona_messages WHERE id = ?").get(id) as MessageRow;
    return { message: hydrateMessage(db, row), created: true };
  })();
}

/**
 * A thread's messages in ascending seq. With `afterSeq`, the first `limit`
 * messages after it (a tail fetch); without it, the latest `limit`. With
 * `beforeSeq`, only messages below it: alone, the latest `limit` of those (a
 * page of older history); with `afterSeq` too, the first `limit` strictly
 * between the two. With `jobIds`, only messages tagged with at least one of
 * them (none for an empty list). With `excludeCommands`, slash commands and
 * their result cards are left out.
 */
export function listPersonaMessages(
  db: Database,
  threadId: string,
  opts: { afterSeq?: number; beforeSeq?: number; limit?: number; jobIds?: string[]; excludeCommands?: boolean } = {}
): PersonaMessage[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  if (opts.jobIds && opts.jobIds.length === 0) return [];
  const jobFilter =
    (opts.jobIds
      ? ` AND EXISTS (SELECT 1 FROM persona_message_jobs j
                     WHERE j.message_id = persona_messages.id
                       AND j.job_id IN (SELECT value FROM json_each(?)))`
      : "") + (opts.excludeCommands ? " AND command_json IS NULL" : "");
  const jobParams = opts.jobIds ? [JSON.stringify(opts.jobIds)] : [];
  const beforeFilter = opts.beforeSeq != null ? " AND seq < ?" : "";
  const beforeParams = opts.beforeSeq != null ? [opts.beforeSeq] : [];
  if (opts.afterSeq != null) {
    const rows = db
      .query(
        `SELECT * FROM persona_messages WHERE thread_id = ? AND seq > ?${beforeFilter}${jobFilter} ORDER BY seq ASC LIMIT ?`
      )
      .all(threadId, opts.afterSeq, ...beforeParams, ...jobParams, limit) as MessageRow[];
    return hydrateMessages(db, rows);
  }
  const rows = db
    .query(`SELECT * FROM persona_messages WHERE thread_id = ?${beforeFilter}${jobFilter} ORDER BY seq DESC LIMIT ?`)
    .all(threadId, ...beforeParams, ...jobParams, limit) as MessageRow[];
  return hydrateMessages(db, rows.reverse());
}

/** The message of `threadId` first appended with `idempotencyKey`, or null. */
export function getPersonaMessageByIdempotencyKey(db: Database, threadId: string, idempotencyKey: string): PersonaMessage | null {
  const row = db
    .query("SELECT * FROM persona_messages WHERE thread_id = ? AND idempotency_key = ?")
    .get(threadId, idempotencyKey) as MessageRow | null;
  return row ? hydrateMessage(db, row) : null;
}

/** One search_thread match: the message and where it was said. */
export interface PersonaMessageHit {
  id: string;
  threadId: string;
  channel: PersonaChannel;
  seq: number;
  role: PersonaMessageRole;
  actor?: string;
  createdAt: string;
  /** The message's whole text, unredacted: redact it before cutting a window of it. */
  text: string;
  /** The words of `text` the query matched (after stemming and accent folding), as written, deduped. */
  matched: string[];
}

/**
 * The best-ranked messages matching the FTS5 query `match` (bm25 order), slash
 * commands and their result cards left out. `scope` picks the threads searched:
 * one thread, or every private thread `owner` has.
 */
export function searchPersonaMessages(
  db: Database,
  match: string,
  scope: { threadId: string } | { owner: string },
  limit = 20
): PersonaMessageHit[] {
  const [where, param] = "threadId" in scope ? ["m.thread_id = ?", scope.threadId] : ["t.owner = ? AND t.audience = 'private'", scope.owner];
  const rows = db
    .query(
      `SELECT m.id, m.thread_id, t.channel, m.seq, m.role, m.actor, m.created_at, m.text,
              highlight(persona_messages_fts, 1, char(1), char(2)) AS marked
         FROM persona_messages_fts f
         JOIN persona_messages m ON m.id = f.message_id
         JOIN persona_threads t ON t.id = m.thread_id
        WHERE persona_messages_fts MATCH ? AND m.command_json IS NULL AND ${where}
        ORDER BY bm25(persona_messages_fts) LIMIT ?`
    )
    .all(match, param, Math.max(1, Math.min(limit, 100))) as Array<{
    id: string;
    thread_id: string;
    channel: string;
    seq: number;
    role: string;
    actor: string | null;
    created_at: string;
    text: string;
    marked: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    threadId: r.thread_id,
    channel: r.channel as PersonaChannel,
    seq: r.seq,
    role: r.role as PersonaMessageRole,
    ...(r.actor ? { actor: r.actor } : {}),
    createdAt: r.created_at,
    text: r.text,
    matched: [...new Set(Array.from(r.marked.matchAll(/\u0001([^\u0002]*)\u0002/g), (x) => x[1]))],
  }));
}

/**
 * Persona's questions in `owner`'s threads since `since` still awaiting an
 * answer, oldest first: a question with quick replies until it is answered
 * (`answered_at`), and one routed as a decision (an ask_user question raised
 * without options) until any owner message in the same thread follows it. A
 * slash command the owner ran (`/state`) is no reply, so it leaves one open.
 */
export function listUnansweredPersonaQuestions(db: Database, owner: string, since: string, limit = 20): PersonaMessage[] {
  const rows = db
    .query(
      `SELECT m.* FROM persona_messages m
         JOIN persona_threads t ON t.id = m.thread_id
        WHERE t.owner = ? AND m.role = 'persona' AND m.created_at >= ?
          AND ((m.options_json IS NOT NULL AND m.answered_at IS NULL)
            OR (m.options_json IS NULL AND json_extract(m.notify_json, '$.kind') = 'decision'
                AND NOT EXISTS (SELECT 1 FROM persona_messages r
                                 WHERE r.thread_id = m.thread_id AND r.role = 'user' AND r.seq > m.seq
                                   AND r.command_json IS NULL)))
        ORDER BY m.created_at ASC LIMIT ?`
    )
    .all(owner, since, Math.max(1, Math.min(limit, 100))) as MessageRow[];
  return hydrateMessages(db, rows);
}

export function getPersonaMessage(db: Database, id: string): PersonaMessage | null {
  const row = db.query("SELECT * FROM persona_messages WHERE id = ?").get(id) as MessageRow | null;
  return row ? hydrateMessage(db, row) : null;
}

function isJobTagSource(value: unknown): value is PersonaJobTagSource {
  return value === "explicit" || value === "declared" || value === "inferred";
}

/** The message `messageId` when its thread belongs to `owner`. */
function ownedMessageRow(db: Database, messageId: string, owner: string): MessageRow | null {
  return db
    .query(
      `SELECT m.* FROM persona_messages m JOIN persona_threads t ON t.id = m.thread_id
        WHERE m.id = ? AND t.owner = ?`
    )
    .get(messageId, owner) as MessageRow | null;
}

/**
 * Tags `owner`'s message with jobs. A job the message is already tagged with
 * keeps its tag, upgraded to the given source when that is stronger (explicit
 * > declared > inferred) and never downgraded. Tags with an empty job id, an
 * unknown source, or a job that isn't `owner`'s are ignored. Returns the updated message, or undefined when
 * there is no such message in a thread of `owner`'s.
 */
export function addPersonaMessageJobTags(
  db: Database,
  input: { messageId: string; owner: string; tags: PersonaMessageJobTag[] }
): PersonaMessage | undefined {
  return db.transaction(() => {
    if (!ownedMessageRow(db, input.messageId, input.owner)) return undefined;
    // A source's strength; a tag only ever moves to a stronger one.
    const rank = (column: string) =>
      `CASE ${column} WHEN 'explicit' THEN 3 WHEN 'declared' THEN 2 ELSE 1 END`;
    const upsert = db.query(
      `INSERT INTO persona_message_jobs (message_id, job_id, owner, source, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (SELECT 1 FROM persona_jobs WHERE id = ?2 AND owner = ?3)
       ON CONFLICT (message_id, job_id) DO UPDATE SET source = excluded.source
        WHERE ${rank("excluded.source")} > ${rank("persona_message_jobs.source")}`
    );
    const at = nowIso();
    for (const tag of input.tags) {
      if (!tag.jobId || !isJobTagSource(tag.source)) continue;
      upsert.run(input.messageId, tag.jobId, input.owner, tag.source, at);
    }
    return getPersonaMessage(db, input.messageId) ?? undefined;
  })();
}

/**
 * Removes `owner`'s message's tag for `jobId`, and drops the id from the
 * message's job_ids_json so the two agree. Returns the updated message (also
 * when it had no such tag), or undefined when there is no such message in a
 * thread of `owner`'s.
 *
 * Dropping the id from job_ids_json is what keeps the tag removed: every boot
 * backfills a tag row for each id job_ids_json still holds
 * (ensurePersonaMessageJobsShape). job_ids_json is otherwise written only at
 * insert (appendPersonaMessage).
 */
export function removePersonaMessageJobTag(
  db: Database,
  input: { messageId: string; jobId: string; owner: string }
): PersonaMessage | undefined {
  return db.transaction(() => {
    const row = ownedMessageRow(db, input.messageId, input.owner);
    if (!row) return undefined;
    db.run("DELETE FROM persona_message_jobs WHERE message_id = ? AND job_id = ?", [input.messageId, input.jobId]);
    const legacy = parseJson<unknown>(row.job_ids_json);
    if (Array.isArray(legacy) && legacy.includes(input.jobId)) {
      const kept = legacy.filter((id) => id !== input.jobId);
      db.run("UPDATE persona_messages SET job_ids_json = ? WHERE id = ?", [
        kept.length > 0 ? JSON.stringify(kept) : null,
        input.messageId,
      ]);
    }
    return getPersonaMessage(db, input.messageId) ?? undefined;
  })();
}

/**
 * The Persona question a quick-reply tap in `threadId` answers: the message
 * `replyTo.messageId` when it is a Persona message of that thread with options
 * and `replyTo.optionIndex` is one of them; null otherwise.
 */
export function personaTappedQuestion(
  db: Database,
  threadId: string,
  replyTo: { messageId: string; optionIndex: number } | undefined
): PersonaMessage | null {
  if (!replyTo) return null;
  const question = getPersonaMessage(db, replyTo.messageId);
  const index = replyTo.optionIndex;
  return question &&
    question.threadId === threadId &&
    question.role === "persona" &&
    question.options &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < question.options.length
    ? question
    : null;
}

/**
 * The Persona message an owner's `message` answers: the question it is a
 * quick-reply tap on (`replyToMessageId`), else Persona's latest message
 * before it in the thread.
 */
export function personaMessageAnswered(db: Database, message: PersonaMessage): PersonaMessage | null {
  const tapped = message.replyToMessageId ? getPersonaMessage(db, message.replyToMessageId) : null;
  return tapped && tapped.threadId === message.threadId ? tapped : personaMessageBefore(db, message.threadId, message.seq);
}

/** Persona's own latest message in `threadId` before `seq`, if any. */
export function personaMessageBefore(db: Database, threadId: string, seq: number): PersonaMessage | null {
  const row = db
    .query("SELECT * FROM persona_messages WHERE thread_id = ? AND seq < ? AND role = 'persona' ORDER BY seq DESC LIMIT 1")
    .get(threadId, seq) as MessageRow | null;
  return row ? hydrateMessage(db, row) : null;
}

// ── Inbox ───────────────────────────────────────────────────────────────────

export type PersonaInboxStatus = "pending" | "processing" | "done" | "failed" | "cancelled";

/** One reason for Persona to wake; drained in batches by the turn loop. */
export interface PersonaInboxItem {
  id: string;
  owner: string;
  kind: PersonaInboxKind;
  threadId?: string;
  payload: Record<string, unknown>;
  coalesceKey?: string;
  status: PersonaInboxStatus;
  attempts: number;
  notBefore?: string;
  error?: string;
  createdAt: string;
  processedAt?: string;
}

interface InboxRow {
  id: string;
  owner: string;
  kind: string;
  thread_id: string | null;
  payload_json: string;
  coalesce_key: string | null;
  status: string;
  attempts: number;
  not_before: string | null;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

function toInboxItem(row: InboxRow): PersonaInboxItem {
  return {
    id: row.id,
    owner: row.owner,
    kind: row.kind as PersonaInboxKind,
    threadId: row.thread_id ?? undefined,
    payload: parseJson<Record<string, unknown>>(row.payload_json) ?? {},
    coalesceKey: row.coalesce_key ?? undefined,
    status: row.status as PersonaInboxStatus,
    attempts: row.attempts,
    notBefore: row.not_before ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    processedAt: row.processed_at ?? undefined,
  };
}

export function getPersonaInboxItem(db: Database, id: string): PersonaInboxItem | null {
  const row = db.query("SELECT * FROM persona_inbox WHERE id = ?").get(id) as InboxRow | null;
  return row ? toInboxItem(row) : null;
}

export interface EnqueuePersonaInboxInput {
  owner: string;
  kind: PersonaInboxKind;
  payload: Record<string, unknown>;
  threadId?: string;
  coalesceKey?: string;
  /** ISO time before which the item is not due; absent = due now. */
  notBefore?: string;
}

/**
 * Queues a wake item. With a `coalesceKey`, a still-pending item under the same
 * key absorbs the new payload in place (keeping its original due time, so a
 * stream of events cannot postpone the wake indefinitely) and is returned with
 * `coalesced: true`. An item already retried after a failed turn is not
 * absorbed into — its backoff and error belong to the old payload — so the new
 * event gets a fresh row.
 */
export function enqueuePersonaInbox(
  db: Database,
  input: EnqueuePersonaInboxInput
): { item: PersonaInboxItem; coalesced: boolean } {
  return db.transaction(() => {
    if (input.coalesceKey) {
      const existing = db
        .query(
          "SELECT * FROM persona_inbox WHERE owner = ? AND coalesce_key = ? AND status = 'pending' AND attempts = 0 ORDER BY created_at ASC LIMIT 1"
        )
        .get(input.owner, input.coalesceKey) as InboxRow | null;
      if (existing) {
        db.run("UPDATE persona_inbox SET payload_json = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?", [
          JSON.stringify(input.payload),
          input.threadId ?? null,
          existing.id,
        ]);
        return { item: getPersonaInboxItem(db, existing.id)!, coalesced: true };
      }
    }
    const id = randomUUID();
    db.run(
      `INSERT INTO persona_inbox (id, owner, kind, thread_id, payload_json, coalesce_key, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.owner,
        input.kind,
        input.threadId ?? null,
        JSON.stringify(input.payload),
        input.coalesceKey ?? null,
        input.notBefore ?? null,
        nowIso(),
      ]
    );
    return { item: getPersonaInboxItem(db, id)!, coalesced: false };
  })();
}

/**
 * Moves due pending items (no `not_before`, or `not_before` ≤ `now`) to
 * `processing` and returns them oldest first — at most `limit` of them, the
 * rest staying pending for a later claim. Select and update share one
 * transaction so two claimers can never take the same item.
 */
export function claimDuePersonaInbox(
  db: Database,
  owner: string,
  now: string = nowIso(),
  limit?: number
): PersonaInboxItem[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT * FROM persona_inbox
          WHERE owner = ? AND status = 'pending' AND (not_before IS NULL OR not_before <= ?)
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`
      )
      .all(owner, now, limit !== undefined && limit > 0 ? Math.floor(limit) : -1) as InboxRow[];
    for (const row of rows) {
      db.run("UPDATE persona_inbox SET status = 'processing' WHERE id = ?", [row.id]);
    }
    return rows.map((row) => toInboxItem({ ...row, status: "processing" }));
  })();
}

/**
 * Claims the due items of ONE thread: the thread of the oldest due item, where
 * an item without a thread counts as `defaultThreadId`'s. Those items (at most
 * `limit`, oldest first) move to `processing`; due items of other threads stay
 * pending for a later claim. Select and update share one transaction.
 */
export function claimDuePersonaInboxForThread(
  db: Database,
  owner: string,
  defaultThreadId: string,
  now: string = nowIso(),
  limit?: number
): { threadId: string; items: PersonaInboxItem[] } | null {
  return db.transaction(() => {
    const oldest = db
      .query(
        `SELECT thread_id FROM persona_inbox
          WHERE owner = ? AND status = 'pending' AND (not_before IS NULL OR not_before <= ?)
          ORDER BY created_at ASC, rowid ASC
          LIMIT 1`
      )
      .get(owner, now) as { thread_id: string | null } | null;
    if (!oldest) return null;
    const threadId = oldest.thread_id ?? defaultThreadId;
    const rows = db
      .query(
        `SELECT * FROM persona_inbox
          WHERE owner = ? AND status = 'pending' AND (not_before IS NULL OR not_before <= ?)
            AND COALESCE(thread_id, ?) = ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`
      )
      .all(owner, now, defaultThreadId, threadId, limit !== undefined && limit > 0 ? Math.floor(limit) : -1) as InboxRow[];
    for (const row of rows) {
      db.run("UPDATE persona_inbox SET status = 'processing' WHERE id = ?", [row.id]);
    }
    return { threadId, items: rows.map((row) => toInboxItem({ ...row, status: "processing" })) };
  })();
}

export function markPersonaInboxDone(db: Database, ids: string[]): void {
  const at = nowIso();
  db.transaction(() => {
    for (const id of ids) {
      db.run(
        "UPDATE persona_inbox SET status = 'done', processed_at = ?, error = NULL WHERE id = ? AND status = 'processing'",
        [at, id]
      );
    }
  })();
}

/**
 * Records a failed turn against its items. Each goes back to `pending` with
 * `attempts + 1` and `not_before = now + baseDelayMs · 2^(attempts-1)`; an item
 * reaching `maxAttempts` is marked `failed` instead. Returns the items that
 * were retried and those that gave up.
 */
export function failPersonaInbox(
  db: Database,
  ids: string[],
  error: string,
  opts: { maxAttempts?: number; baseDelayMs?: number; nowMs?: number } = {}
): { retried: PersonaInboxItem[]; failed: PersonaInboxItem[] } {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 30_000;
  const nowMs = opts.nowMs ?? Date.now();
  const retried: PersonaInboxItem[] = [];
  const failed: PersonaInboxItem[] = [];
  db.transaction(() => {
    for (const id of ids) {
      const row = db
        .query("SELECT * FROM persona_inbox WHERE id = ? AND status = 'processing'")
        .get(id) as InboxRow | null;
      if (!row) continue;
      const attempts = row.attempts + 1;
      if (attempts >= maxAttempts) {
        db.run(
          "UPDATE persona_inbox SET status = 'failed', attempts = ?, error = ?, processed_at = ? WHERE id = ?",
          [attempts, error, new Date(nowMs).toISOString(), id]
        );
        failed.push(getPersonaInboxItem(db, id)!);
      } else {
        const notBefore = new Date(nowMs + baseDelayMs * 2 ** (attempts - 1)).toISOString();
        db.run(
          "UPDATE persona_inbox SET status = 'pending', attempts = ?, error = ?, not_before = ? WHERE id = ?",
          [attempts, error, notBefore, id]
        );
        retried.push(getPersonaInboxItem(db, id)!);
      }
    }
  })();
  return { retried, failed };
}

/**
 * Returns `processing` items to `pending` without charging an attempt — used on
 * boot, when a turn that was mid-flight died with the process, and when a turn
 * is abandoned for a reason that is not the items' fault.
 */
export function resetProcessingPersonaInbox(db: Database, owner?: string, ids?: string[]): number {
  if (ids) {
    let n = 0;
    db.transaction(() => {
      for (const id of ids) {
        n += db.run("UPDATE persona_inbox SET status = 'pending' WHERE id = ? AND status = 'processing'", [id]).changes;
      }
    })();
    return n;
  }
  const result = owner
    ? db.run("UPDATE persona_inbox SET status = 'pending' WHERE owner = ? AND status = 'processing'", [owner])
    : db.run("UPDATE persona_inbox SET status = 'pending' WHERE status = 'processing'");
  return result.changes;
}

/** Cancels a still-pending item of `owner` (optionally only of `kind`); false when none matched. */
export function cancelPersonaInbox(
  db: Database,
  id: string,
  owner: string,
  kind?: PersonaInboxKind
): boolean {
  const result = kind
    ? db.run(
        "UPDATE persona_inbox SET status = 'cancelled', processed_at = ? WHERE id = ? AND owner = ? AND kind = ? AND status = 'pending'",
        [nowIso(), id, owner, kind]
      )
    : db.run(
        "UPDATE persona_inbox SET status = 'cancelled', processed_at = ? WHERE id = ? AND owner = ? AND status = 'pending'",
        [nowIso(), id, owner]
      );
  return result.changes > 0;
}

/**
 * Deletes `owner`'s settled inbox items (done, failed, cancelled) processed
 * before `olderThan`; returns how many were removed.
 */
export function prunePersonaInbox(db: Database, owner: string, olderThan: string): number {
  return db.run(
    `DELETE FROM persona_inbox
      WHERE owner = ? AND status IN ('done', 'failed', 'cancelled')
        AND COALESCE(processed_at, created_at) < ?`,
    [owner, olderThan]
  ).changes;
}

/** Pending items of `owner` (due or not), oldest first. */
export function listPendingPersonaInbox(
  db: Database,
  owner: string,
  kind?: PersonaInboxKind
): PersonaInboxItem[] {
  const rows = kind
    ? (db
        .query("SELECT * FROM persona_inbox WHERE owner = ? AND kind = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC")
        .all(owner, kind) as InboxRow[])
    : (db
        .query("SELECT * FROM persona_inbox WHERE owner = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC")
        .all(owner) as InboxRow[]);
  return rows.map(toInboxItem);
}

export function countPendingPersonaInbox(db: Database, owner: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM persona_inbox WHERE owner = ? AND status IN ('pending', 'processing')")
    .get(owner) as { n: number };
  return row.n;
}

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Every UUID (an ask id, say: the ask was already handed to Persona) that
 * some inbox item of `owner`'s, in any status, carries in its payload,
 * lower-cased. One pass over the inbox, so checking many ids against it
 * costs the inbox's size once rather than once per id.
 */
export function personaInboxMentionedIds(db: Database, owner: string): Set<string> {
  const ids = new Set<string>();
  const rows = db.query("SELECT payload_json AS payload FROM persona_inbox WHERE owner = ?").iterate(owner) as Iterable<{ payload: string }>;
  for (const row of rows) {
    for (const m of row.payload.matchAll(UUID_IN_TEXT)) ids.add(m[0].toLowerCase());
  }
  return ids;
}

/** Whether `owner` has a pending item due at `now`. */
export function hasDuePersonaInbox(db: Database, owner: string, now: string = nowIso()): boolean {
  const row = db
    .query(
      "SELECT 1 AS x FROM persona_inbox WHERE owner = ? AND status = 'pending' AND (not_before IS NULL OR not_before <= ?) LIMIT 1"
    )
    .get(owner, now);
  return !!row;
}

/** The earliest `not_before` among `owner`'s pending items, if any are deferred. */
export function nextPersonaInboxDue(db: Database, owner: string): string | null {
  const row = db
    .query("SELECT MIN(not_before) AS t FROM persona_inbox WHERE owner = ? AND status = 'pending' AND not_before IS NOT NULL")
    .get(owner) as { t: string | null };
  return row.t;
}

// ── Runtime state ───────────────────────────────────────────────────────────

export interface PersonaStateRecord {
  owner: string;
  paused: boolean;
  claudeSessionId?: string;
  epoch: number;
  lastContextTokens?: number;
  handoffNote?: string;
  lastTurnAt?: string;
  lastError?: string;
  updatedAt: string;
}

interface StateRow {
  owner: string;
  paused: number;
  claude_session_id: string | null;
  epoch: number;
  last_context_tokens: number | null;
  handoff_note: string | null;
  last_turn_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function toStateRecord(row: StateRow): PersonaStateRecord {
  return {
    owner: row.owner,
    paused: row.paused === 1,
    claudeSessionId: row.claude_session_id ?? undefined,
    epoch: row.epoch,
    lastContextTokens: row.last_context_tokens ?? undefined,
    handoffNote: row.handoff_note ?? undefined,
    lastTurnAt: row.last_turn_at ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function getOrCreatePersonaState(db: Database, owner: string): PersonaStateRecord {
  db.run("INSERT OR IGNORE INTO persona_state (owner, updated_at) VALUES (?, ?)", [owner, nowIso()]);
  const row = db.query("SELECT * FROM persona_state WHERE owner = ?").get(owner) as StateRow;
  return toStateRecord(row);
}

/**
 * Patches the owner's runtime row. A key present with `null` clears the
 * column; an absent key leaves it unchanged.
 */
export function updatePersonaState(
  db: Database,
  owner: string,
  patch: {
    paused?: boolean;
    claudeSessionId?: string | null;
    epoch?: number;
    lastContextTokens?: number | null;
    handoffNote?: string | null;
    lastTurnAt?: string | null;
    lastError?: string | null;
  }
): PersonaStateRecord {
  getOrCreatePersonaState(db, owner);
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  const columns: Array<[keyof typeof patch, string]> = [
    ["claudeSessionId", "claude_session_id"],
    ["epoch", "epoch"],
    ["lastContextTokens", "last_context_tokens"],
    ["handoffNote", "handoff_note"],
    ["lastTurnAt", "last_turn_at"],
    ["lastError", "last_error"],
  ];
  if (patch.paused !== undefined) {
    sets.push("paused = ?");
    params.push(patch.paused ? 1 : 0);
  }
  for (const [key, column] of columns) {
    if (key in patch && patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(patch[key] as string | number | null);
    }
  }
  sets.push("updated_at = ?");
  params.push(nowIso());
  db.run(`UPDATE persona_state SET ${sets.join(", ")} WHERE owner = ?`, [...params, owner]);
  return getOrCreatePersonaState(db, owner);
}

// ── Jobs ────────────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  owner: string;
  thread_id: string;
  title: string;
  goal: string;
  acceptance: string | null;
  status: string;
  outcome: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  waiting_since?: string | null;
  waiting_source?: string | null;
  open_ask_message_id?: string | null;
  open_ask_at?: string | null;
  owner_responded_at?: string | null;
  note_at?: string | null;
  waiting_session_id?: string | null;
  worker_resumed_at?: string | null;
  pipeline_override_json?: string | null;
}

/** The job's stored pipeline layer, or undefined when it has none (or it doesn't parse as an object). */
function jobPipelineOverride(json: string | null | undefined): PipelineOverride | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PipelineOverride) : undefined;
  } catch {
    // A malformed layer reads as none rather than failing the job read.
    return undefined;
  }
}

/**
 * Reads a stored time as ISO-8601. Tables written by SQLite defaults hold
 * `YYYY-MM-DD HH:MM:SS` in UTC, which Date.parse would read as local time.
 */
function isoTime(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
}

/**
 * What the job's owner can act on right now, in the order the console shows
 * them: each pending approval card, Persona's own unanswered question, every
 * pending ask on the job's workers, every review packet of the job waiting on
 * them, and each pipeline run waiting on them. A job Persona itself set
 * `waiting_user` with none of those links to its note in the job's thread; a
 * waiting a worker's hand-off raised links to that worker's session, whose
 * report says what the owner is asked to do (and to nothing when the session
 * isn't known — the job is then not shown as needing them). A closed job has
 * none.
 */
export function jobActions(
  db: Database,
  row: Pick<JobRow, "id" | "owner" | "thread_id" | "status" | "open_ask_message_id" | "waiting_source" | "waiting_session_id">,
  links: { launchIds: string[]; sessionIds: string[] }
): PersonaJobAction[] {
  if (row.status !== "active" && row.status !== "waiting_user") return [];
  const actions: PersonaJobAction[] = [];
  const cards = db
    .query("SELECT id FROM persona_approvals WHERE job_id = ? AND status = 'pending' AND (approver IS NULL OR approver = ?) ORDER BY created_at, rowid")
    .all(row.id, row.owner) as Array<{ id: string }>;
  for (const card of cards) actions.push({ kind: "approval", id: card.id, label: "decide the approval card" });
  if (row.open_ask_message_id) {
    actions.push({ kind: "message", id: row.open_ask_message_id, label: "answer Persona's question in the Persona tab" });
  }
  if (links.sessionIds.length > 0) {
    const asks = db
      .query(
        `SELECT id FROM asks WHERE session_id IN (${links.sessionIds.map(() => "?").join(", ")}) AND status = 'pending'
          ORDER BY created_at, rowid`
      )
      .all(...links.sessionIds) as Array<{ id: string }>;
    for (const ask of asks) actions.push({ kind: "ask", id: ask.id, label: "answer the worker's question" });
  }
  for (const packetId of pendingReviewPacketsForJob(db, row.owner, row.id, links.launchIds)) {
    actions.push({ kind: "review", id: packetId, label: "decide the review packet in the Review tab" });
  }
  if (links.launchIds.length > 0) {
    const runs = db
      .query(
        `SELECT r.id, r.current_stage, r.definition_json,
                EXISTS (SELECT 1 FROM review_packets p WHERE p.launch_id = r.launch_id AND p.owner = ? AND p.status = 'pending') AS packet_pending
           FROM pipeline_runs r
          WHERE r.launch_id IN (${links.launchIds.map(() => "?").join(", ")}) AND r.status = 'waiting_user'
          ORDER BY r.created_at, r.rowid`
      )
      .all(row.owner, ...links.launchIds) as Array<{ id: string; current_stage: string; definition_json: string; packet_pending: number }>;
    for (const run of runs) {
      // A run waiting at human review on its own pending packet is that
      // packet's to decide — already linked above — not a run to waive.
      if (run.packet_pending && stageKindOf(run.definition_json, run.current_stage) === HUMAN_REVIEW_STAGE_KIND) continue;
      actions.push({ kind: "pipeline", id: run.id, label: `waive or unblock the delivery pipeline at ${run.current_stage}` });
    }
  }
  if (actions.length === 0 && row.status === "waiting_user" && row.waiting_source === "handoff") {
    // The worker's report is what asks the owner to act; it opens there.
    if (row.waiting_session_id) {
      actions.push({ kind: "session", id: row.waiting_session_id, label: "see what the worker handed you" });
    }
    return actions;
  }
  if (actions.length === 0 && row.status === "waiting_user") {
    actions.push({ kind: "message", id: row.thread_id, label: "reply to Persona in the Persona tab" });
  }
  return actions;
}

/** What job `jobId`'s owner can act on right now (jobActions), whether or not the job reads as needing them. */
export function personaJobActions(db: Database, jobId: string): PersonaJobAction[] {
  const row = db.query("SELECT * FROM persona_jobs WHERE id = ?").get(jobId) as JobRow | null;
  return row ? jobActions(db, row, jobLinks(db, jobId)) : [];
}

/** The kind of stage `stageId` in a stored pipeline definition, or undefined when it can't be read. */
function stageKindOf(definitionJson: string, stageId: string): string | undefined {
  try {
    const def = JSON.parse(definitionJson) as { stages?: Array<{ id?: unknown; kind?: unknown }> };
    const kind = def.stages?.find((s) => s.id === stageId)?.kind;
    return typeof kind === "string" ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** The live facts deriveJobState reads for one job row. */
function jobFacts(db: Database, row: JobRow, sessionIds: string[], launchIds: string[]): JobStateFacts {
  const approvals = db
    .query(
      `SELECT
         SUM(CASE WHEN status = 'pending' AND (approver IS NULL OR approver = ?) THEN 1 ELSE 0 END) AS pending,
         MAX(CASE WHEN decided_by = ? AND status IN ('approved', 'executed', 'failed', 'denied')
                  THEN decided_at END) AS decided
         FROM persona_approvals WHERE job_id = ?`
    )
    .get(row.owner, row.owner, row.id) as { pending: number | null; decided: string | null };
  const sessions = sessionIds.flatMap((id) => {
    const s = db
      .query(
        `SELECT id, status, ended_at, started_at,
           (SELECT MAX(te.created_at) FROM transcript_events te WHERE te.session_id = sessions.id) AS transcript_at,
           (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = sessions.id) AS event_at
           FROM sessions WHERE id = ?`
      )
      .get(id) as {
      id: string;
      status: SessionStatus;
      ended_at: string | null;
      started_at: string | null;
      transcript_at: string | null;
      event_at: string | null;
    } | null;
    if (!s) return [];
    // The two tables may store different time formats, so the latest is picked after normalizing.
    const lastActivityAt = [s.transcript_at, s.event_at, s.started_at]
      .map(isoTime)
      .filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return [{ id: s.id, status: s.status, endedAt: isoTime(s.ended_at), lastActivityAt }];
  });
  const checkpoint =
    sessionIds.length > 0
      ? (db
          .query(
            `SELECT session_id, summary, created_at FROM checkpoints
              WHERE session_id IN (${sessionIds.map(() => "?").join(", ")}) AND source != 'structural'
              ORDER BY created_at DESC, rowid DESC LIMIT 1`
          )
          .get(...sessionIds) as { session_id: string; summary: string; created_at: string } | null)
      : null;
  const waitingSource = row.waiting_source === "handoff" ? "handoff" : "persona";
  return {
    status: row.status as PersonaJobStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    note: row.note ?? undefined,
    noteAt: row.note_at ?? undefined,
    waiting: row.waiting_since ? { since: row.waiting_since, source: waitingSource as PersonaJobWaitingSource } : undefined,
    workerResumedAt: row.worker_resumed_at ?? undefined,
    pendingApprovals: approvals.pending ?? 0,
    lastApprovalDecidedAt: approvals.decided ?? undefined,
    openAskAt: row.open_ask_message_id ? (row.open_ask_at ?? row.updated_at) : undefined,
    ownerRespondedAt: row.owner_responded_at ?? undefined,
    startingLaunches: countStartingPersonaJobLaunches(db, row.id),
    actions: jobActions(db, row, { launchIds, sessionIds }),
    sessions,
    latestCheckpoint: checkpoint
      ? { sessionId: checkpoint.session_id, summary: checkpoint.summary, at: isoTime(checkpoint.created_at)! }
      : undefined,
  };
}

function jobLinks(db: Database, jobId: string): { launchIds: string[]; sessionIds: string[] } {
  const rows = db
    .query(
      `SELECT pjl.launch_id AS launch_id, l.session_id AS session_id
         FROM persona_job_launches pjl
         LEFT JOIN launches l ON l.id = pjl.launch_id
        WHERE pjl.job_id = ?
        ORDER BY pjl.created_at ASC, pjl.rowid ASC`
    )
    .all(jobId) as Array<{ launch_id: string; session_id: string | null }>;
  return {
    launchIds: rows.map((r) => r.launch_id),
    sessionIds: rows.flatMap((r) => (r.session_id ? [r.session_id] : [])),
  };
}

/** `{ budget }` for the job: its resolved time and spend budget and its use. */
function budgetOf(db: Database, jobId: string): { budget?: PersonaJob["budget"] } {
  const budget = personaJobBudget(db, jobId);
  return budget ? { budget } : {};
}

/**
 * The job row as served. `withView: false` skips the derived view (and the
 * queries behind it) for ownership lookups that only read the job's identity.
 */
function toJob(
  db: Database,
  row: JobRow,
  opts: { withView?: boolean; links?: ReturnType<typeof jobLinks>; facts?: JobStateFacts } = {}
): PersonaJob {
  const links = opts.links ?? jobLinks(db, row.id);
  const withView = opts.withView ?? true;
  const pipelineOverride = jobPipelineOverride(row.pipeline_override_json);
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.thread_id,
    title: row.title,
    goal: row.goal,
    acceptance: row.acceptance ?? undefined,
    status: row.status as PersonaJobStatus,
    ...links,
    outcome: row.outcome ?? undefined,
    note: row.note ?? undefined,
    ...(row.note_at ? { noteAt: row.note_at } : {}),
    ...(withView ? { view: deriveJobState(opts.facts ?? jobFacts(db, row, links.sessionIds, links.launchIds)).view } : {}),
    ...(withView ? budgetOf(db, row.id) : {}),
    ...(pipelineOverride ? { pipelineOverride } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPersonaJob(
  db: Database,
  input: { owner: string; threadId: string; title: string; goal: string; acceptance?: string }
): PersonaJob {
  const id = randomUUID();
  const at = nowIso();
  db.run(
    `INSERT INTO persona_jobs (id, owner, thread_id, title, goal, acceptance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.owner, input.threadId, input.title, input.goal, input.acceptance ?? null, at, at]
  );
  return getPersonaJob(db, id)!;
}

export function getPersonaJob(db: Database, jobId: string, opts: { withView?: boolean } = {}): PersonaJob | null {
  const row = db.query("SELECT * FROM persona_jobs WHERE id = ?").get(jobId) as JobRow | null;
  return row ? toJob(db, row, opts) : null;
}

/**
 * Who put a waiting job to its owner: a worker's hand-off, or Persona's own
 * escalation. Undefined when the job isn't waiting (or doesn't exist).
 */
export function getPersonaJobWaitingSource(db: Database, jobId: string): PersonaJobWaitingSource | undefined {
  const row = db
    .query("SELECT status, waiting_source FROM persona_jobs WHERE id = ?")
    .get(jobId) as { status: string; waiting_source: string | null } | null;
  if (!row || row.status !== "waiting_user") return undefined;
  return row.waiting_source === "handoff" ? "handoff" : "persona";
}

export function updatePersonaJob(
  db: Database,
  jobId: string,
  patch: {
    status?: PersonaJobStatus;
    outcome?: string;
    note?: string;
    title?: string;
    goal?: string;
    acceptance?: string;
  }
): PersonaJob | null {
  const sets: string[] = [];
  const params: string[] = [];
  const columns: Array<[keyof typeof patch, string]> = [
    ["status", "status"],
    ["outcome", "outcome"],
    ["note", "note"],
    ["title", "title"],
    ["goal", "goal"],
    ["acceptance", "acceptance"],
  ];
  for (const [key, column] of columns) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(patch[key] as string);
    }
  }
  const at = nowIso();
  if (patch.note !== undefined) {
    sets.push("note_at = ?");
    params.push(at);
  }
  if (patch.status === "waiting_user") {
    // An explicit waiting_user starts afresh: only what happens after it answers it.
    sets.push("waiting_since = ?", "waiting_source = 'persona'", "waiting_session_id = NULL", "worker_resumed_at = NULL");
    params.push(at);
  } else if (patch.status !== undefined) {
    sets.push("waiting_since = NULL", "waiting_source = NULL", "waiting_session_id = NULL", "worker_resumed_at = NULL");
    // A closed job has no question left to answer; an active one keeps its
    // open question until it is answered (or cleared with clearPersonaJobOpenAsk).
    if (patch.status !== "active") sets.push("open_ask_message_id = NULL", "open_ask_at = NULL");
  }
  sets.push("updated_at = ?");
  params.push(at);
  db.run(`UPDATE persona_jobs SET ${sets.join(", ")} WHERE id = ?`, [...params, jobId]);
  return getPersonaJob(db, jobId);
}

/** The open-question condition on persona_messages `m`: a Persona question with quick replies, not yet answered. */
const OPEN_QUESTION = "m.role = 'persona' AND m.options_json IS NOT NULL AND m.answered_at IS NULL";

/**
 * Closes the open questions tagged with `jobId` whose every tagged job has
 * closed — nothing is left for the answer to steer — and returns them as they
 * are now. A question also about a job still open keeps its quick replies.
 */
export function closePersonaQuestionsOfClosedJob(db: Database, jobId: string): PersonaMessage[] {
  const rows = db
    .query(
      `SELECT m.id FROM persona_messages m
        WHERE ${OPEN_QUESTION}
          AND m.id IN (SELECT message_id FROM persona_message_jobs WHERE job_id = ?)
          AND NOT EXISTS (SELECT 1 FROM persona_message_jobs t JOIN persona_jobs j ON j.id = t.job_id
                           WHERE t.message_id = m.id AND j.status IN ('active', 'waiting_user'))
        ORDER BY m.seq`
    )
    .all(jobId) as Array<{ id: string }>;
  return closeQuestions(
    db,
    rows.map((r) => r.id),
    nowIso()
  );
}

/** Marks the questions `ids` answered at `at`; returns the ones that were open, as they are now, oldest first. */
function closeQuestions(db: Database, ids: string[], at: string): PersonaMessage[] {
  const closed: MessageRow[] = [];
  for (const id of ids) {
    const row = db
      .query(`UPDATE persona_messages AS m SET answered_at = ? WHERE m.id = ? AND ${OPEN_QUESTION} RETURNING *`)
      .get(at, id) as MessageRow | null;
    if (row) closed.push(row);
  }
  return hydrateMessages(
    db,
    closed.sort((a, b) => a.seq - b.seq)
  );
}

/**
 * Closes the open questions of `owner` that the owner's message `reply` in
 * thread `threadId` answers, and returns them as they are now. A quick-reply
 * tap (`replyToMessageId`, a question of this thread, and `optionIndex` one of
 * its options) answers that question alone, so the thread's other open
 * questions keep their quick replies. A message tagged with a job (`jobId`)
 * answers the open questions about that job asked before it, in whichever of
 * the owner's threads they were asked. An untagged typed message answers
 * none: it may be about something else entirely, so Persona, reading it,
 * closes what it answered (closePersonaQuestion).
 */
export function recordPersonaQuestionReply(
  db: Database,
  owner: string,
  threadId: string,
  reply: { seq: number; replyToMessageId?: string; optionIndex?: number; jobId?: string }
): PersonaMessage[] {
  if (!db.query("SELECT 1 FROM persona_threads WHERE id = ? AND owner = ?").get(threadId, owner)) return [];
  const at = nowIso();
  if (reply.replyToMessageId) {
    const asked = db
      .query("SELECT m.id, m.options_json FROM persona_messages m WHERE m.id = ? AND m.thread_id = ? AND m.role = 'persona' AND m.options_json IS NOT NULL")
      .get(reply.replyToMessageId, threadId) as { id: string; options_json: string } | null;
    const count = parseJson<string[]>(asked?.options_json ?? null)?.length ?? 0;
    const index = reply.optionIndex;
    if (asked && (index === undefined || (Number.isInteger(index) && index >= 0 && index < count))) {
      return closeQuestions(db, [asked.id], at);
    }
  }
  if (!reply.jobId) return [];
  const rows = db
    .query(
      `SELECT m.id FROM persona_messages m
         JOIN persona_message_jobs j ON j.message_id = m.id
         JOIN persona_threads t ON t.id = m.thread_id
        WHERE j.job_id = ? AND t.owner = ? AND (m.thread_id != ? OR m.seq < ?) AND ${OPEN_QUESTION}
        ORDER BY m.created_at, m.seq`
    )
    .all(reply.jobId, owner, threadId, reply.seq) as Array<{ id: string }>;
  return closeQuestions(
    db,
    rows.map((r) => r.id),
    at
  );
}

/**
 * Closes the open questions about `jobId` — Persona saying they were answered
 * elsewhere or no longer matter — and returns them as they are now.
 */
export function closePersonaJobQuestions(db: Database, jobId: string): PersonaMessage[] {
  const rows = db
    .query(
      `SELECT m.id FROM persona_messages m JOIN persona_message_jobs j ON j.message_id = m.id
        WHERE j.job_id = ? AND ${OPEN_QUESTION}
        ORDER BY m.seq`
    )
    .all(jobId) as Array<{ id: string }>;
  return closeQuestions(
    db,
    rows.map((r) => r.id),
    nowIso()
  );
}

/**
 * Closes the open question `messageId` of `owner`'s thread `threadId` —
 * Persona saying the owner answered it some other way, or it no longer
 * matters — and drops it as the open question of any job it was. Returns the
 * question as it is now and the jobs whose open question changed, or null
 * when `messageId` is no open question of that thread.
 */
export function closePersonaQuestion(
  db: Database,
  owner: string,
  threadId: string,
  messageId: string
): { message: PersonaMessage; jobIds: string[] } | null {
  const asked = db
    .query(
      `SELECT m.id FROM persona_messages m JOIN persona_threads t ON t.id = m.thread_id
        WHERE m.id = ? AND m.thread_id = ? AND t.owner = ? AND ${OPEN_QUESTION}`
    )
    .get(messageId, threadId, owner) as { id: string } | null;
  if (!asked) return null;
  const [message] = closeQuestions(db, [asked.id], nowIso());
  if (!message) return null;
  return { message, jobIds: releasePersonaJobOpenAsks(db, owner, [asked.id]) };
}

/**
 * Moves `owner`'s jobs whose open question is one of the closed `messageIds`
 * on to their next open question, or to none; returns those jobs' ids.
 */
export function releasePersonaJobOpenAsks(db: Database, owner: string, messageIds: string[]): string[] {
  if (messageIds.length === 0) return [];
  const jobIds = (
    db
      .query("SELECT id FROM persona_jobs WHERE owner = ? AND open_ask_message_id IN (SELECT value FROM json_each(?))")
      .all(owner, JSON.stringify(messageIds)) as Array<{ id: string }>
  ).map((r) => r.id);
  for (const jobId of jobIds) {
    clearPersonaJobOpenAsk(db, jobId);
    syncPersonaJobOpenAsk(db, jobId);
  }
  return jobIds;
}

/**
 * Points an open job that has no open question recorded at its newest
 * question still open, if any, so the job keeps needing the owner while a
 * question about it still offers quick replies. Returns whether it changed.
 */
export function syncPersonaJobOpenAsk(db: Database, jobId: string): boolean {
  const newest = db
    .query(
      `SELECT m.id, m.created_at FROM persona_messages m JOIN persona_message_jobs j ON j.message_id = m.id
        WHERE j.job_id = ? AND ${OPEN_QUESTION}
        ORDER BY m.created_at DESC, m.seq DESC LIMIT 1`
    )
    .get(jobId) as { id: string; created_at: string } | null;
  if (!newest) return false;
  const changed = db.run(
    `UPDATE persona_jobs SET open_ask_message_id = ?, open_ask_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'waiting_user') AND open_ask_message_id IS NULL`,
    [newest.id, newest.created_at, nowIso(), jobId]
  );
  return changed.changes > 0;
}

/** The newest `limit` open questions of `threadId`, oldest first. */
export function listOpenPersonaQuestions(db: Database, threadId: string, limit = 20): PersonaMessage[] {
  const rows = db
    .query(`SELECT m.* FROM persona_messages m WHERE m.thread_id = ? AND ${OPEN_QUESTION} ORDER BY m.seq DESC LIMIT ?`)
    .all(threadId, Math.max(1, Math.min(limit, 100))) as MessageRow[];
  return hydrateMessages(db, rows.reverse());
}

/**
 * The owner's jobs, newest first. `status` filters to one or more statuses;
 * `closedSince` additionally keeps terminal jobs updated at/after that time
 * (the "recently finished" tail of a snapshot).
 */
export function listPersonaJobs(
  db: Database,
  owner: string,
  opts: { status?: PersonaJobStatus | PersonaJobStatus[]; closedSince?: string; limit?: number } = {}
): PersonaJob[] {
  const statuses = opts.status == null ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  let where = "owner = ?";
  const params: Array<string | number> = [owner];
  if (statuses && opts.closedSince) {
    where += ` AND (status IN (${statuses.map(() => "?").join(", ")}) OR (status IN ('done', 'failed', 'cancelled') AND updated_at >= ?))`;
    params.push(...statuses, opts.closedSince);
  } else if (statuses) {
    where += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
    params.push(...statuses);
  }
  const rows = db
    .query(`SELECT * FROM persona_jobs WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params, limit) as JobRow[];
  return rows.map((row) => toJob(db, row));
}

/** The ids of every one of the owner's jobs opened in a thread, unbounded and without building views. */
export function personaJobIdsInThread(db: Database, owner: string, threadId: string): string[] {
  const rows = db
    .query("SELECT id FROM persona_jobs WHERE owner = ? AND thread_id = ?")
    .all(owner, threadId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Sets Persona's latest free-form note on a job (distinct from its closing `outcome`). */
export function setPersonaJobNote(db: Database, jobId: string, note: string): PersonaJob | null {
  return updatePersonaJob(db, jobId, { note });
}

/**
 * Replaces the job's pipeline layer (null clears it), which a launch of the
 * job's resolves over its owner's and project's layers. Leaves updated_at as
 * it is: the layer is configuration, not progress on the job.
 */
export function setPersonaJobPipeline(db: Database, jobId: string, override: PipelineOverride | null): PersonaJob | null {
  db.run("UPDATE persona_jobs SET pipeline_override_json = ? WHERE id = ?", [override ? JSON.stringify(override) : null, jobId]);
  return getPersonaJob(db, jobId, { withView: false });
}

/**
 * Marks an `active` job `waiting_user` with `note` because checkpoint
 * `checkpointId` handed the next step to the owner. A no-op (null) when the
 * job is in any other status, or was updated after that checkpoint was
 * written (Persona or the owner already moved it on), compared at the
 * checkpoint's one-second resolution.
 */
export function flagPersonaJobWaitingUser(
  db: Database,
  jobId: string,
  checkpointId: string,
  note: string
): PersonaJob | null {
  const at = nowIso();
  const res = db.run(
    `UPDATE persona_jobs
        SET status = 'waiting_user', note = ?, note_at = ?, waiting_since = ?, waiting_source = 'handoff',
            waiting_session_id = (SELECT session_id FROM checkpoints WHERE id = ?), worker_resumed_at = NULL,
            updated_at = ?
      WHERE id = ? AND status = 'active'
        AND CAST(strftime('%s', updated_at) AS INTEGER)
            <= (SELECT CAST(strftime('%s', created_at) AS INTEGER) FROM checkpoints WHERE id = ?)`,
    [note, at, at, checkpointId, at, jobId, checkpointId]
  );
  return res.changes > 0 ? getPersonaJob(db, jobId) : null;
}

/**
 * Records that `sessionId` started running again, which answers a hand-off
 * waiting that session raised (see deriveJobState). A no-op for any other
 * session or a job not waiting on that session's hand-off.
 */
export function markPersonaJobWorkerResumed(db: Database, jobId: string, sessionId: string): boolean {
  const res = db.run(
    `UPDATE persona_jobs SET worker_resumed_at = ?
      WHERE id = ? AND status = 'waiting_user' AND waiting_source = 'handoff' AND waiting_session_id = ?`,
    [nowIso(), jobId, sessionId]
  );
  return res.changes > 0;
}

/**
 * Re-derives `jobId`'s state from live facts. A `waiting_user` that something
 * has since answered (see deriveJobState's waitingSuperseded) is cleared back
 * to `active` — compare-and-set on the waiting it derived from, so an explicit
 * waiting_user set meanwhile stands. Returns the job (null when missing) and
 * whether it was cleared.
 */
export function refreshPersonaJob(db: Database, jobId: string): { job: PersonaJob; cleared: boolean } | null {
  const row = db.query("SELECT * FROM persona_jobs WHERE id = ?").get(jobId) as JobRow | null;
  if (!row) return null;
  const links = jobLinks(db, row.id);
  const facts = jobFacts(db, row, links.sessionIds, links.launchIds);
  if (!deriveJobState(facts).waitingSuperseded || !row.waiting_since) {
    return { job: toJob(db, row, { links, facts }), cleared: false };
  }
  const res = db.run(
    `UPDATE persona_jobs
        SET status = 'active', waiting_since = NULL, waiting_source = NULL, waiting_session_id = NULL,
            worker_resumed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'waiting_user' AND waiting_since = ?`,
    [nowIso(), jobId, row.waiting_since]
  );
  const job = getPersonaJob(db, jobId);
  return job ? { job, cleared: res.changes > 0 } : null;
}

/** Records `messageId` as the unanswered `ask_user` question about `jobId`, replacing any earlier one. */
export function setPersonaJobOpenAsk(db: Database, jobId: string, messageId: string): PersonaJob | null {
  const at = nowIso();
  db.run(
    `UPDATE persona_jobs SET open_ask_message_id = ?, open_ask_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'waiting_user')`,
    [messageId, at, at, jobId]
  );
  return getPersonaJob(db, jobId);
}

/**
 * Drops `jobId`'s open ask_user question without an owner reply — Persona
 * saying it was answered elsewhere or no longer matters.
 */
export function clearPersonaJobOpenAsk(db: Database, jobId: string): PersonaJob | null {
  db.run(
    `UPDATE persona_jobs SET open_ask_message_id = NULL, open_ask_at = NULL, updated_at = ?
      WHERE id = ? AND open_ask_message_id IS NOT NULL`,
    [nowIso(), jobId]
  );
  return getPersonaJob(db, jobId);
}

/**
 * Records an owner reply in `threadId` against the jobs it answers, clearing
 * their open question and stamping owner_responded_at; returns those jobs' ids.
 * A reply answers: the jobs whose question it quick-replies to (`replyTo` —
 * the question still open, or an earlier one tagged with those jobs); else
 * the job it is tagged with (`jobId`); else, untagged, the job whose open
 * question was asked in this thread — only when exactly one is, since with
 * several the reply can't be told apart.
 */
export function recordPersonaJobOwnerReply(
  db: Database,
  owner: string,
  threadId: string,
  reply: { jobId?: string; replyToMessageId?: string }
): string[] {
  const open = "j.owner = ? AND j.status IN ('active', 'waiting_user')";
  const idsOf = (rows: unknown) => (rows as Array<{ id: string }>).map((r) => r.id);
  let ids: string[] = [];
  if (reply.replyToMessageId) {
    ids = idsOf(
      db.query(`SELECT j.id FROM persona_jobs j WHERE ${open} AND j.open_ask_message_id = ?`).all(owner, reply.replyToMessageId)
    );
    if (ids.length === 0) {
      const question = db
        .query("SELECT job_ids_json FROM persona_messages WHERE id = ? AND role = 'persona' AND options_json IS NOT NULL")
        .get(reply.replyToMessageId) as { job_ids_json: string | null } | null;
      const tagged = parseJson<string[]>(question?.job_ids_json ?? null) ?? [];
      for (const id of tagged) {
        if (db.query(`SELECT j.id FROM persona_jobs j WHERE ${open} AND j.id = ?`).get(owner, id)) ids.push(id);
      }
    }
  }
  if (ids.length === 0 && reply.jobId) {
    ids = idsOf(db.query(`SELECT j.id FROM persona_jobs j WHERE ${open} AND j.id = ?`).all(owner, reply.jobId));
  }
  if (ids.length === 0 && !reply.jobId && !reply.replyToMessageId) {
    const asked = idsOf(
      db
        .query(
          `SELECT j.id FROM persona_jobs j JOIN persona_messages m ON m.id = j.open_ask_message_id
            WHERE ${open} AND m.thread_id = ? LIMIT 2`
        )
        .all(owner, threadId)
    );
    if (asked.length === 1) ids = asked;
  }
  const at = nowIso();
  for (const id of ids) {
    db.run(
      `UPDATE persona_jobs SET open_ask_message_id = NULL, open_ask_at = NULL, owner_responded_at = ?, updated_at = ?
        WHERE id = ?`,
      [at, at, id]
    );
  }
  return ids;
}

/**
 * Launches of `jobId` still starting: linked, not yet bound to a session, and
 * neither failed nor cleaned up.
 */
export function countStartingPersonaJobLaunches(db: Database, jobId: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM persona_job_launches pjl
         JOIN launches l ON l.id = pjl.launch_id
        WHERE pjl.job_id = ? AND l.session_id IS NULL AND l.status IN ('starting', 'running')`
    )
    .get(jobId) as { n: number };
  return row.n;
}

/** Records that Persona started `launchId` for `jobId`; idempotent. */
export function linkPersonaJobLaunch(
  db: Database,
  jobId: string,
  launchId: string,
  personaPlanGate = false
): void {
  db.run(
    `INSERT OR IGNORE INTO persona_job_launches (job_id, launch_id, persona_plan_gate, created_at)
     VALUES (?, ?, ?, ?)`,
    [jobId, launchId, personaPlanGate ? 1 : 0, nowIso()]
  );
  db.run("UPDATE persona_jobs SET updated_at = ? WHERE id = ?", [nowIso(), jobId]);
}

/** How a session belongs to a Persona job. */
export interface PersonaSessionOwnership {
  job: PersonaJob;
  launchId: string;
  /** The root session the launch bound to (differs from the asked id for a subagent child). */
  rootSessionId: string;
  /** Whether Persona itself requested the launch's plan gate. */
  personaPlanGate: boolean;
}

export function personaJobForLaunch(
  db: Database,
  launchId: string
): { job: PersonaJob; personaPlanGate: boolean } | null {
  const row = db
    .query("SELECT job_id, persona_plan_gate FROM persona_job_launches WHERE launch_id = ? LIMIT 1")
    .get(launchId) as { job_id: string; persona_plan_gate: number } | null;
  if (!row) return null;
  const job = getPersonaJob(db, row.job_id, { withView: false });
  return job ? { job, personaPlanGate: row.persona_plan_gate === 1 } : null;
}

/**
 * The Persona job owning `sessionId`, through the launch the session bound to.
 * A subagent child session resolves through its parent chain (bounded, so a
 * malformed cycle cannot spin). Null when no Persona launch owns it.
 */
export function personaJobForSession(db: Database, sessionId: string): PersonaSessionOwnership | null {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < 5; depth++) {
    const row = db
      .query(
        `SELECT pjl.job_id AS job_id, pjl.launch_id AS launch_id, pjl.persona_plan_gate AS gate
           FROM launches l JOIN persona_job_launches pjl ON pjl.launch_id = l.id
          WHERE l.session_id = ?
          LIMIT 1`
      )
      .get(current) as { job_id: string; launch_id: string; gate: number } | null;
    if (row) {
      const job = getPersonaJob(db, row.job_id, { withView: false });
      if (!job) return null;
      return { job, launchId: row.launch_id, rootSessionId: current, personaPlanGate: row.gate === 1 };
    }
    const parent = db
      .query("SELECT parent_session_id FROM sessions WHERE id = ?")
      .get(current) as { parent_session_id: string | null } | null;
    current = parent?.parent_session_id ?? null;
  }
  return null;
}

/**
 * Which of `sessionIds` are live root sessions bound to a launch of an open
 * (active or waiting_user) Persona job — in one query, for decorating a whole
 * session list. Subagents aren't followed up their parent chain; use
 * personaJobForSession for one session.
 */
export function openPersonaWorkerSessions(db: Database, sessionIds: readonly string[]): Set<string> {
  if (sessionIds.length === 0) return new Set();
  const rows = db
    .query(
      `SELECT DISTINCT s.id AS id
         FROM json_each(?) AS j
         JOIN sessions s ON s.id = j.value
         JOIN launches l ON l.session_id = s.id
         JOIN persona_job_launches pjl ON pjl.launch_id = l.id
         JOIN persona_jobs pj ON pj.id = pjl.job_id
        WHERE s.ended_at IS NULL AND pj.status IN ('active', 'waiting_user')`
    )
    .all(JSON.stringify(sessionIds)) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Converts an instant to the bare UTC `YYYY-MM-DD HH:MM:SS` form `launches.created_at` uses. */
function sqliteUtc(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/** Persona-originated launches of `owner` created since local midnight of `now`. */
export function countPersonaLaunchesToday(db: Database, owner: string, now: Date = new Date()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM persona_job_launches pjl
         JOIN persona_jobs j ON j.id = pjl.job_id
         LEFT JOIN launches l ON l.id = pjl.launch_id
        WHERE j.owner = ? AND COALESCE(l.created_at, ?) >= ?`
    )
    .get(owner, sqliteUtc(now), sqliteUtc(midnight)) as { n: number };
  return row.n;
}

/**
 * Persona-owned launches still in flight: starting/running, belonging to a job
 * that is still open (active or waiting on the owner), and not bound to a
 * session that has already ended. An idle worker left over from a closed job
 * does not hold a slot.
 */
export function countActivePersonaLaunches(db: Database, owner: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM persona_job_launches pjl
         JOIN persona_jobs j ON j.id = pjl.job_id
         JOIN launches l ON l.id = pjl.launch_id
         LEFT JOIN sessions s ON s.id = l.session_id
        WHERE j.owner = ?
          AND j.status IN ('active', 'waiting_user')
          AND l.status IN ('starting', 'running')
          AND (s.id IS NULL OR (s.ended_at IS NULL AND s.status != 'done'))`
    )
    .get(owner) as { n: number };
  return row.n;
}

/**
 * The share of countActivePersonaLaunches still waiting for host headroom
 * (status `starting`, phase `queued`): committed work that has not started.
 */
export function countQueuedPersonaLaunches(db: Database, owner: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
         FROM persona_job_launches pjl
         JOIN persona_jobs j ON j.id = pjl.job_id
         JOIN launches l ON l.id = pjl.launch_id
        WHERE j.owner = ?
          AND j.status IN ('active', 'waiting_user')
          AND l.status = 'starting'
          AND l.phase = 'queued'`
    )
    .get(owner) as { n: number };
  return row.n;
}

// ── Approvals ───────────────────────────────────────────────────────────────

interface ApprovalRow {
  id: string;
  owner: string;
  job_id: string | null;
  thread_id: string | null;
  action: string;
  summary: string;
  reason: string | null;
  hold_rule?: string | null;
  approver?: string | null;
  args_json: string;
  status: string;
  result: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

function toApproval(row: ApprovalRow): PersonaApproval {
  return {
    id: row.id,
    owner: row.owner,
    jobId: row.job_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    action: row.action,
    summary: row.summary,
    reason: row.reason ?? undefined,
    ...(row.hold_rule ? { holdRule: row.hold_rule } : {}),
    ...(row.approver ? { approver: row.approver } : {}),
    args: parseJson<Record<string, unknown>>(row.args_json) ?? {},
    status: row.status as PersonaApprovalStatus,
    result: row.result ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

export function createPersonaApproval(
  db: Database,
  input: {
    owner: string;
    jobId?: string;
    threadId?: string;
    action: string;
    summary: string;
    reason?: string;
    /** The policy rule the action is held under (@standup/shared hold-rules). */
    holdRule?: string;
    /** Who must decide the card when not its owner; stored NULL when absent or the owner. */
    approver?: string;
    args: Record<string, unknown>;
  }
): PersonaApproval {
  const id = randomUUID();
  const approver = input.approver?.trim() || null;
  db.run(
    `INSERT INTO persona_approvals (id, owner, job_id, thread_id, action, summary, reason, hold_rule, approver, args_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.jobId ?? null,
      input.threadId ?? null,
      input.action,
      input.summary,
      input.reason ?? null,
      input.holdRule ?? null,
      approver === input.owner ? null : approver,
      JSON.stringify(input.args),
      nowIso(),
    ]
  );
  return getPersonaApproval(db, id)!;
}

export function getPersonaApproval(db: Database, id: string): PersonaApproval | null {
  const row = db.query("SELECT * FROM persona_approvals WHERE id = ?").get(id) as ApprovalRow | null;
  return row ? toApproval(row) : null;
}

/** The owner's approvals, newest first, optionally filtered by status. */
export function listPersonaApprovals(
  db: Database,
  owner: string,
  status?: PersonaApprovalStatus
): PersonaApproval[] {
  const rows = status
    ? (db
        .query("SELECT * FROM persona_approvals WHERE owner = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT 100")
        .all(owner, status) as ApprovalRow[])
    : (db
        .query("SELECT * FROM persona_approvals WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT 100")
        .all(owner) as ApprovalRow[]);
  return rows.map(toApproval);
}

/**
 * The approvals `alias` must decide, newest first, optionally filtered by
 * status: those naming `alias` as approver, plus those `alias` owns with no
 * approver set.
 */
export function listPersonaApprovalsForDecider(
  db: Database,
  alias: string,
  status?: PersonaApprovalStatus
): PersonaApproval[] {
  const decider = "(approver = ? OR (approver IS NULL AND owner = ?))";
  const rows = status
    ? (db
        .query(`SELECT * FROM persona_approvals WHERE ${decider} AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`)
        .all(alias, alias, status) as ApprovalRow[])
    : (db
        .query(`SELECT * FROM persona_approvals WHERE ${decider} ORDER BY created_at DESC, rowid DESC LIMIT 100`)
        .all(alias, alias) as ApprovalRow[]);
  return rows.map(toApproval);
}

/** The pending approvals `alias` must decide (see listPersonaApprovalsForDecider), newest first. */
export function listPendingPersonaApprovalsAwaiting(db: Database, alias: string, limit = 100): PersonaApproval[] {
  const rows = db
    .query(
      `SELECT * FROM persona_approvals
        WHERE (approver = ? OR (approver IS NULL AND owner = ?)) AND status = 'pending'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(alias, alias, limit) as ApprovalRow[];
  return rows.map(toApproval);
}

/** Every alias with a Persona runtime row, sorted. */
export function listPersonaOwners(db: Database): string[] {
  const rows = db.query("SELECT owner FROM persona_state ORDER BY owner").all() as Array<{ owner: string }>;
  return rows.map((r) => r.owner);
}

/** Every owner's approvals still waiting on a decision, oldest first. */
export function listAllPendingPersonaApprovals(db: Database, limit = 100): PersonaApproval[] {
  const rows = db
    .query("SELECT * FROM persona_approvals WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?")
    .all(limit) as ApprovalRow[];
  return rows.map(toApproval);
}

/**
 * Compare-and-set transition of an approval: applies only while the row is in
 * `from`, so two deciders racing the same approval cannot both win. Returns
 * the updated approval, or null when the row was not in `from`.
 */
export function transitionPersonaApproval(
  db: Database,
  id: string,
  from: PersonaApprovalStatus,
  to: PersonaApprovalStatus,
  patch: { result?: string; decidedBy?: string } = {}
): PersonaApproval | null {
  const result = db.run(
    `UPDATE persona_approvals
        SET status = ?, result = COALESCE(?, result), decided_by = COALESCE(?, decided_by),
            decided_at = COALESCE(decided_at, ?)
      WHERE id = ? AND status = ?`,
    [to, patch.result ?? null, patch.decidedBy ?? null, nowIso(), id, from]
  );
  return result.changes > 0 ? getPersonaApproval(db, id) : null;
}

/**
 * Marks `owner`'s approvals left in `approved` — decided, but the process died
 * before the action's outcome was recorded — as failed with `reason`; returns
 * them. Run on boot, when no execution can still be in flight.
 */
export function failInterruptedPersonaApprovals(db: Database, owner: string, reason: string): PersonaApproval[] {
  return db.transaction(() => {
    const rows = db
      .query("SELECT id FROM persona_approvals WHERE owner = ? AND status = 'approved'")
      .all(owner) as Array<{ id: string }>;
    const failed: PersonaApproval[] = [];
    for (const { id } of rows) {
      const approval = transitionPersonaApproval(db, id, "approved", "failed", { result: reason });
      if (approval) failed.push(approval);
    }
    return failed;
  })();
}

/** Marks a pending approval superseded with `reason`; returns it, or null when it was no longer pending. */
export function supersedePersonaApproval(db: Database, id: string, reason: string): PersonaApproval | null {
  return transitionPersonaApproval(db, id, "pending", "superseded", { result: reason });
}

/** Marks `owner`'s pending approvals created before `olderThan` expired; returns them. */
export function expirePersonaApprovals(db: Database, owner: string, olderThan: string): PersonaApproval[] {
  return db.transaction(() => {
    const rows = db
      .query("SELECT id FROM persona_approvals WHERE owner = ? AND status = 'pending' AND created_at < ?")
      .all(owner, olderThan) as Array<{ id: string }>;
    const expired: PersonaApproval[] = [];
    for (const { id } of rows) {
      const approval = transitionPersonaApproval(db, id, "pending", "expired", { result: "expired after 24h" });
      if (approval) expired.push(approval);
    }
    return expired;
  })();
}
