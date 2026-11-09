import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { PersonaAttachment, PersonaAttachmentMime, PersonaMediaMime } from "@standup/shared";
import { isPersonaVideoMime } from "@standup/shared";

/**
 * Media on Persona messages (migrations 058, 068). Two kinds of row share the
 * table:
 *
 * - Images and videos Persona attaches to its replies: staged by attach_image
 *   or attach_video for the running turn (thread + batch key) and claimed by
 *   the reply that turn posts (appendPersonaMessage's `attachmentIds`).
 * - Images and videos the owner uploads: staged with batch key
 *   `upload:<uuid>` (stageOwnerUpload), which no turn's batch key matches,
 *   and claimed by the owner's `user` message that carries them.
 */

/** The batch-key prefix of an owner upload. */
export const OWNER_UPLOAD_BATCH_PREFIX = "upload:";

/** A still image the collector derived from an upload, stored content-addressed beside it. */
export interface PersonaDerivedImage {
  sha256: string;
  mimeType: PersonaAttachmentMime;
}

/** A still frame extracted from a video, at `atSec` seconds in. */
export interface PersonaVideoFrame {
  sha256: string;
  mimeType: "image/jpeg";
  atSec: number;
}

/** What the collector derived from an owner upload or a video Persona attached (persona_attachments.media_json). */
export interface PersonaAttachmentMedia {
  width?: number;
  height?: number;
  durationSec?: number;
  /** A video's still frames, in time order. */
  frames?: PersonaVideoFrame[];
  /** The still frame a video Persona attached shows before it plays. */
  poster?: PersonaDerivedImage;
  /** The re-encoded, downscaled JPEG of an image that Persona is shown in its place. */
  modelCopy?: PersonaDerivedImage;
  /** Why Persona sees less than the whole upload (no frames, no image). */
  note?: string;
}

/** An attachment row with the fields only the collector sees. */
export interface PersonaAttachmentRecord extends PersonaAttachment {
  owner: string;
  threadId: string;
  batchKey: string;
  /** The message that carries it; undefined while staged. */
  messageId?: string;
  /** Names the stored copy (content-addressed). */
  sha256: string;
  createdAt: string;
  /** Set on an owner upload. */
  media?: PersonaAttachmentMedia;
}

export interface StagePersonaAttachmentInput {
  owner: string;
  threadId: string;
  batchKey: string;
  sha256: string;
  mimeType: PersonaMediaMime;
  bytes: number;
  name: string;
  caption?: string;
  /** A video's duration and poster frame. */
  media?: PersonaAttachmentMedia;
  /**
   * When set, refuse (PersonaAttachmentCapError) a new row once the turn
   * already has this many staged of the same kind (videos, or images).
   */
  maxOfKind?: number;
}

/** stagePersonaAttachment refused a new row: the turn already has `staged` of its kind, its cap. */
export class PersonaAttachmentCapError extends Error {
  constructor(readonly staged: number) {
    super(`this reply already carries ${staged} attachment(s) of that kind`);
  }
}

export interface StageOwnerUploadInput {
  owner: string;
  threadId: string;
  sha256: string;
  mimeType: PersonaMediaMime;
  bytes: number;
  name: string;
  media?: PersonaAttachmentMedia;
}

interface Row {
  id: string;
  owner: string;
  thread_id: string;
  batch_key: string;
  message_id: string | null;
  sha256: string;
  mime_type: string;
  bytes: number;
  name: string;
  caption: string | null;
  created_at: string;
  media_json: string | null;
}

function parseMedia(json: string | null): PersonaAttachmentMedia | undefined {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as PersonaAttachmentMedia) : undefined;
  } catch {
    return undefined;
  }
}

function toRecord(row: Row): PersonaAttachmentRecord {
  const media = parseMedia(row.media_json);
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.thread_id,
    batchKey: row.batch_key,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    sha256: row.sha256,
    mimeType: row.mime_type as PersonaMediaMime,
    bytes: row.bytes,
    name: row.name,
    ...(row.caption ? { caption: row.caption } : {}),
    createdAt: row.created_at,
    ...(media ? { media } : {}),
  };
}

/** The public fields of an attachment, as a message carries them. */
export function publicPersonaAttachment(record: PersonaAttachmentRecord): PersonaAttachment {
  const video = isPersonaVideoMime(record.mimeType)
    ? {
        ...(record.media?.durationSec !== undefined ? { durationSec: record.media.durationSec } : {}),
        frames: record.media?.frames?.length ?? 0,
        ...(record.media?.note ? { note: record.media.note } : {}),
        ...(personaAttachmentPoster(record) ? { poster: true } : {}),
      }
    : undefined;
  return {
    id: record.id,
    mimeType: record.mimeType,
    bytes: record.bytes,
    name: record.name,
    ...(record.caption ? { caption: record.caption } : {}),
    ...(video ? { video } : {}),
  };
}

/**
 * The still frame a video shows before it plays: the poster of one Persona
 * attached, else the first frame extracted from an owner upload; undefined
 * for an image or a video with neither.
 */
export function personaAttachmentPoster(record: Pick<PersonaAttachmentRecord, "mimeType" | "media">): PersonaDerivedImage | undefined {
  if (!isPersonaVideoMime(record.mimeType)) return undefined;
  const frame = record.media?.frames?.[0];
  return record.media?.poster ?? (frame ? { sha256: frame.sha256, mimeType: frame.mimeType } : undefined);
}

/** Whether `record` is an owner upload (stageOwnerUpload) rather than a Persona attach_image or attach_video row. */
export function isOwnerUpload(record: Pick<PersonaAttachmentRecord, "batchKey">): boolean {
  return record.batchKey.startsWith(OWNER_UPLOAD_BATCH_PREFIX);
}

/**
 * Stages an image for a turn's reply. The same image staged again in the same
 * turn (a retried turn re-running attach_image) returns the first row, with
 * `created: false`, and keeps its caption unless a new one is given. The
 * `maxOfKind` cap is checked in the same transaction as the insert, so two
 * calls racing can't both get past it.
 */
export function stagePersonaAttachment(
  db: Database,
  input: StagePersonaAttachmentInput
): { attachment: PersonaAttachmentRecord; created: boolean } {
  if (input.batchKey.startsWith(OWNER_UPLOAD_BATCH_PREFIX)) {
    throw new Error(`a turn's batch key may not start with ${OWNER_UPLOAD_BATCH_PREFIX}`);
  }
  return db.transaction(() => {
    const existing = db
      .query(
        "SELECT * FROM persona_attachments WHERE thread_id = ? AND batch_key = ? AND sha256 = ? AND message_id IS NULL"
      )
      .get(input.threadId, input.batchKey, input.sha256) as Row | null;
    if (existing) {
      if (input.caption !== undefined && input.caption !== (existing.caption ?? undefined)) {
        db.run("UPDATE persona_attachments SET caption = ? WHERE id = ?", [input.caption || null, existing.id]);
        existing.caption = input.caption || null;
      }
      return { attachment: toRecord(existing), created: false };
    }
    if (input.maxOfKind !== undefined) {
      const video = isPersonaVideoMime(input.mimeType);
      const staged = (
        db
          .query("SELECT mime_type FROM persona_attachments WHERE thread_id = ? AND batch_key = ? AND message_id IS NULL")
          .all(input.threadId, input.batchKey) as Array<{ mime_type: string }>
      ).filter((r) => isPersonaVideoMime(r.mime_type) === video).length;
      if (staged >= input.maxOfKind) throw new PersonaAttachmentCapError(staged);
    }
    const id = randomUUID();
    db.run(
      `INSERT INTO persona_attachments
         (id, owner, thread_id, batch_key, message_id, sha256, mime_type, bytes, name, caption, created_at, media_json)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.owner,
        input.threadId,
        input.batchKey,
        input.sha256,
        input.mimeType,
        input.bytes,
        input.name,
        input.caption || null,
        new Date().toISOString(),
        input.media ? JSON.stringify(input.media) : null,
      ]
    );
    const row = db.query("SELECT * FROM persona_attachments WHERE id = ?").get(id) as Row;
    return { attachment: toRecord(row), created: true };
  })();
}

/**
 * Stages an image or video the owner uploaded, unsent, for a later `user`
 * message of `threadId` to claim. Every upload is its own row (its own
 * `upload:<uuid>` batch key), even of bytes uploaded before.
 */
export function stageOwnerUpload(db: Database, input: StageOwnerUploadInput): PersonaAttachmentRecord {
  const id = randomUUID();
  db.run(
    `INSERT INTO persona_attachments
       (id, owner, thread_id, batch_key, message_id, sha256, mime_type, bytes, name, caption, created_at, media_json)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.owner,
      input.threadId,
      `${OWNER_UPLOAD_BATCH_PREFIX}${randomUUID()}`,
      input.sha256,
      input.mimeType,
      input.bytes,
      input.name,
      new Date().toISOString(),
      input.media ? JSON.stringify(input.media) : null,
    ]
  );
  return toRecord(db.query("SELECT * FROM persona_attachments WHERE id = ?").get(id) as Row);
}

/**
 * Deletes `owner`'s owner uploads no message claimed that were staged before
 * `olderThan` (ISO-8601) and returns them, so the caller can remove stored
 * files no remaining row references (isPersonaAttachmentFileReferenced).
 */
export function pruneStaleOwnerUploads(db: Database, owner: string, olderThan: string): PersonaAttachmentRecord[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT * FROM persona_attachments
          WHERE owner = ? AND message_id IS NULL AND substr(batch_key, 1, ?) = ? AND created_at < ?`
      )
      .all(owner, OWNER_UPLOAD_BATCH_PREFIX.length, OWNER_UPLOAD_BATCH_PREFIX, olderThan) as Row[];
    const del = db.query("DELETE FROM persona_attachments WHERE id = ?");
    for (const row of rows) del.run(row.id);
    return rows.map(toRecord);
  })();
}

/**
 * Deletes `owner`'s rows staged by attach_image or attach_video that no reply
 * claimed (their turn failed for good, or ended first) and that were staged
 * before `olderThan` (ISO-8601), and returns them, so the caller can remove
 * stored files no remaining row references.
 */
export function pruneStaleTurnAttachments(db: Database, owner: string, olderThan: string): PersonaAttachmentRecord[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT * FROM persona_attachments
          WHERE owner = ? AND message_id IS NULL AND substr(batch_key, 1, ?) <> ? AND created_at < ?`
      )
      .all(owner, OWNER_UPLOAD_BATCH_PREFIX.length, OWNER_UPLOAD_BATCH_PREFIX, olderThan) as Row[];
    const del = db.query("DELETE FROM persona_attachments WHERE id = ?");
    for (const row of rows) del.run(row.id);
    return rows.map(toRecord);
  })();
}

/**
 * Whether any attachment row still uses the stored file named `sha256`: as
 * its own copy, or as a frame or model copy derived from it.
 */
export function isPersonaAttachmentFileReferenced(db: Database, sha256: string): boolean {
  return !!db
    .query("SELECT 1 FROM persona_attachments WHERE sha256 = ? OR instr(COALESCE(media_json, ''), ?) > 0 LIMIT 1")
    .get(sha256, sha256);
}

/**
 * Deletes `owner`'s owner upload `id` when no message has claimed it, and
 * returns it; null (nothing deleted) for any other row or none.
 */
export function deleteUnsentOwnerUpload(db: Database, owner: string, id: string): PersonaAttachmentRecord | null {
  return db.transaction(() => {
    const row = db
      .query(
        `SELECT * FROM persona_attachments
          WHERE id = ? AND owner = ? AND message_id IS NULL AND substr(batch_key, 1, ?) = ?`
      )
      .get(id, owner, OWNER_UPLOAD_BATCH_PREFIX.length, OWNER_UPLOAD_BATCH_PREFIX) as Row | null;
    if (!row) return null;
    db.run("DELETE FROM persona_attachments WHERE id = ?", [id]);
    return toRecord(row);
  })();
}

/** A stored file passed to a worker: its digest and the attachment it belongs to. */
export interface PersonaMediaShareFile {
  sha256: string;
  attachmentId: string;
}

/** A recorded pass of a stored file to a worker. */
export interface PersonaMediaShare {
  key: string;
  sha256: string;
  attachmentId: string;
  owner: string;
  sharedAt: string;
}

/** The share key of a launch whose session isn't known yet. */
export function launchShareKey(launchId: string): string {
  return `launch:${launchId}`;
}

/**
 * Records that `owner`'s Persona passed `files` to the worker `key` names (a
 * session id, or launchShareKey). A file passed before keeps its first time.
 */
export function recordPersonaMediaShares(
  db: Database,
  input: { key: string; owner: string; files: readonly PersonaMediaShareFile[]; at: string }
): void {
  const insert = db.query(
    `INSERT INTO persona_media_shares (session_id, sha256, attachment_id, owner, shared_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, sha256) DO NOTHING`
  );
  db.transaction(() => {
    for (const file of input.files) insert.run(input.key, file.sha256, file.attachmentId, input.owner, input.at);
  })();
}

/** The earliest recorded pass of the stored file `sha256` to any of `keys` by `owner`'s Persona, or null. */
export function findPersonaMediaShare(
  db: Database,
  owner: string,
  keys: readonly string[],
  sha256: string
): PersonaMediaShare | null {
  const row = db
    .query(
      `SELECT session_id, sha256, attachment_id, owner, shared_at FROM persona_media_shares
        WHERE owner = ? AND sha256 = ? AND session_id IN (SELECT value FROM json_each(?))
        ORDER BY shared_at ASC LIMIT 1`
    )
    .get(owner, sha256, JSON.stringify(keys)) as
    | { session_id: string; sha256: string; attachment_id: string; owner: string; shared_at: string }
    | null;
  return row
    ? { key: row.session_id, sha256: row.sha256, attachmentId: row.attachment_id, owner: row.owner, sharedAt: row.shared_at }
    : null;
}

/** The bytes of `owner`'s uploads no message has claimed yet. */
export function unsentOwnerUploadBytes(db: Database, owner: string): number {
  const row = db
    .query(
      `SELECT COALESCE(SUM(bytes), 0) AS n FROM persona_attachments
        WHERE owner = ? AND message_id IS NULL AND substr(batch_key, 1, ?) = ?`
    )
    .get(owner, OWNER_UPLOAD_BATCH_PREFIX.length, OWNER_UPLOAD_BATCH_PREFIX) as { n: number };
  return row.n;
}

/** What the Claude session `sessionId` has been sent of images: blocks and their base64 bytes (zeros when none is recorded). */
export function personaSessionImages(db: Database, sessionId: string): { images: number; base64Bytes: number } {
  const row = db
    .query("SELECT images, base64_bytes FROM persona_session_images WHERE session_id = ?")
    .get(sessionId) as { images: number; base64_bytes: number } | null;
  return { images: row?.images ?? 0, base64Bytes: row?.base64_bytes ?? 0 };
}

/**
 * Adds `images` blocks of `base64Bytes` in all to what the Claude session
 * `sessionId` has been sent, stamped `at` (ISO-8601; the caller's clock, which
 * its prune cutoffs use too).
 */
export function addPersonaSessionImages(
  db: Database,
  sessionId: string,
  images: number,
  base64Bytes: number,
  at: string = new Date().toISOString()
): void {
  if (!sessionId || images <= 0) return;
  db.run(
    `INSERT INTO persona_session_images (session_id, images, base64_bytes, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         images = images + excluded.images,
         base64_bytes = base64_bytes + excluded.base64_bytes,
         updated_at = excluded.updated_at`,
    [sessionId, images, Math.max(0, base64Bytes), at]
  );
}

/**
 * Adds what the Claude session `from` was sent to `to`, the id the session
 * goes on under (its history, and so its images, come along).
 */
export function carryPersonaSessionImages(db: Database, from: string, to: string, at?: string): void {
  if (!from || !to || from === to) return;
  const sent = personaSessionImages(db, from);
  addPersonaSessionImages(db, to, sent.images, sent.base64Bytes, at);
}

/**
 * Deletes the image counts of sessions neither a thread nor any Persona's
 * state names any more (rotated, reset, dropped), except `keep` and, when
 * `updatedBefore` (ISO-8601) is given, rows updated since then (a turn in
 * progress may not have stored its session yet). Returns how many rows went.
 */
export function prunePersonaSessionImages(db: Database, keep: readonly string[] = [], updatedBefore?: string): number {
  return db.run(
    `DELETE FROM persona_session_images
      WHERE session_id NOT IN (SELECT claude_session_id FROM persona_threads WHERE claude_session_id IS NOT NULL)
        AND session_id NOT IN (SELECT claude_session_id FROM persona_state WHERE claude_session_id IS NOT NULL)
        AND session_id NOT IN (SELECT value FROM json_each(?))
        AND (? IS NULL OR updated_at < ?)`,
    [JSON.stringify(keep), updatedBefore ?? null, updatedBefore ?? null]
  ).changes;
}

/** The images staged for a turn and not yet claimed by a message, oldest first. */
export function stagedPersonaAttachments(db: Database, threadId: string, batchKey: string): PersonaAttachmentRecord[] {
  const rows = db
    .query(
      "SELECT * FROM persona_attachments WHERE thread_id = ? AND batch_key = ? AND message_id IS NULL ORDER BY created_at ASC, rowid ASC"
    )
    .all(threadId, batchKey) as Row[];
  return rows.map(toRecord);
}

export function getPersonaAttachment(db: Database, id: string): PersonaAttachmentRecord | null {
  const row = db.query("SELECT * FROM persona_attachments WHERE id = ?").get(id) as Row | null;
  return row ? toRecord(row) : null;
}

/**
 * Marks staged rows `ids` of `threadId` as carried by `messageId` and returns
 * their public fields in `ids` order. A row of another thread, one another
 * message already claimed, or one of the other kind (`ownerUploads` true
 * claims only owner uploads, false only Persona's attach_image rows) is
 * skipped. Runs inside the caller's transaction when there is one.
 */
export function claimPersonaAttachments(
  db: Database,
  threadId: string,
  messageId: string,
  ids: readonly string[],
  ownerUploads = false
): PersonaAttachment[] {
  const claimed: PersonaAttachment[] = [];
  for (const id of new Set(ids)) {
    const row = db
      .query("SELECT * FROM persona_attachments WHERE id = ? AND thread_id = ? AND message_id IS NULL")
      .get(id, threadId) as Row | null;
    if (!row) continue;
    if (row.batch_key.startsWith(OWNER_UPLOAD_BATCH_PREFIX) !== ownerUploads) continue;
    db.run("UPDATE persona_attachments SET message_id = ? WHERE id = ?", [messageId, id]);
    claimed.push(publicPersonaAttachment(toRecord(row)));
  }
  return claimed;
}
