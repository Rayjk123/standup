import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type {
  ReviewChangeArea,
  ReviewComment,
  ReviewCommentKind,
  ReviewCommentVia,
  ReviewDecision,
  ReviewLink,
  ReviewMediaInfo,
  ReviewMediaKind,
  ReviewPacket,
  ReviewPacketDraft,
  ReviewPacketSummary,
  ReviewRisks,
  ReviewStatus,
  ReviewValidation,
} from "@standup/shared";
import { findLiveGrantByToken, getLiveGrant, revokeGrantsFor, setShare } from "./share-grants.js";

/** A stored review media file; `sha256` names its content-addressed copy. */
export interface ReviewMediaRow {
  id: string;
  packetId: string;
  owner: string;
  kind: ReviewMediaKind;
  mime: string;
  sha256: string;
  bytes: number;
  caption: string;
  position: number;
  createdAt: string;
}

interface PacketRow {
  id: string;
  owner: string;
  project_id: string | null;
  launch_id: string | null;
  job_id: string | null;
  session_id: string | null;
  pipeline_run_id: string | null;
  branch: string | null;
  commit_sha: string | null;
  base_sha: string | null;
  submitted_by_session: string | null;
  submitted_by_root: number;
  resubmitted_from_other_session: number;
  title: string;
  intent: string;
  changes_json: string;
  validation_json: string;
  risks_json: string;
  links_json: string;
  status: ReviewStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface SummaryRow {
  id: string;
  owner: string;
  project_id: string | null;
  launch_id: string | null;
  job_id: string | null;
  session_id: string | null;
  branch: string | null;
  commit_sha: string | null;
  title: string;
  intent: string;
  status: ReviewStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  image_count: number;
  video_count: number;
  open_questions: number;
}

interface CommentRow {
  id: string;
  packet_id: string;
  author: string;
  body: string;
  decision: ReviewDecision | null;
  kind: ReviewCommentKind;
  reply_to: string | null;
  via: ReviewCommentVia | null;
  created_at: string;
}

interface MediaRow {
  id: string;
  packet_id: string;
  owner: string;
  kind: ReviewMediaKind;
  mime: string;
  sha256: string;
  bytes: number;
  caption: string;
  position: number;
  created_at: string;
}

function parseJson<T>(text: string, fallback: T, accept: (value: unknown) => boolean): T {
  try {
    const parsed = JSON.parse(text) as unknown;
    return accept(parsed) ? (parsed as T) : fallback;
  } catch {
    // An unreadable column reads as its empty shape.
    return fallback;
  }
}

const isObject = (v: unknown): boolean => typeof v === "object" && v !== null && !Array.isArray(v);

function toPacket(row: PacketRow): ReviewPacket {
  return {
    id: row.id,
    owner: row.owner,
    projectId: row.project_id,
    launchId: row.launch_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    pipelineRunId: row.pipeline_run_id,
    branch: row.branch,
    commitSha: row.commit_sha,
    baseSha: row.base_sha,
    submittedBySession: row.submitted_by_session ?? null,
    submittedByRootSession: row.submitted_by_root === 1,
    resubmittedFromOtherSession: row.resubmitted_from_other_session === 1,
    title: row.title,
    intent: row.intent,
    changes: parseJson<ReviewChangeArea[]>(row.changes_json, [], Array.isArray),
    validation: parseJson<ReviewValidation>(row.validation_json, { samples: [] }, isObject),
    risks: parseJson<ReviewRisks>(row.risks_json, { risks: [], questions: [] }, isObject),
    links: parseJson<ReviewLink[]>(row.links_json, [], Array.isArray),
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

function toSummary(row: SummaryRow): ReviewPacketSummary {
  return {
    id: row.id,
    owner: row.owner,
    projectId: row.project_id,
    launchId: row.launch_id,
    jobId: row.job_id,
    sessionId: row.session_id,
    branch: row.branch,
    commitSha: row.commit_sha,
    title: row.title,
    intent: row.intent,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imageCount: row.image_count,
    videoCount: row.video_count,
    openQuestions: row.open_questions,
  };
}

function toComment(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    decision: row.decision,
    kind: row.kind,
    replyTo: row.reply_to,
    via: row.via,
    createdAt: row.created_at,
  };
}

function toMedia(row: MediaRow): ReviewMediaRow {
  return {
    id: row.id,
    packetId: row.packet_id,
    owner: row.owner,
    kind: row.kind,
    mime: row.mime,
    sha256: row.sha256,
    bytes: row.bytes,
    caption: row.caption,
    position: row.position,
    createdAt: row.created_at,
  };
}

/** The public view of a stored media file, with the URL the console fetches it from. */
export function toReviewMediaInfo(row: ReviewMediaRow): ReviewMediaInfo {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    caption: row.caption,
    position: row.position,
    url: `/api/reviews/${encodeURIComponent(row.packetId)}/media/${encodeURIComponent(row.id)}`,
  };
}

function getPacketRow(db: Database, id: string, owner: string): PacketRow | null {
  return db.query("SELECT * FROM review_packets WHERE id = ? AND owner = ?").get(id, owner) as PacketRow | null;
}

/** Creates an empty draft packet for the owner; returns it. */
export function createReviewPacket(
  db: Database,
  input: {
    owner: string;
    projectId?: string;
    launchId?: string;
    jobId?: string;
    sessionId?: string;
    pipelineRunId?: string;
    branch?: string;
    commitSha?: string;
    baseSha?: string;
  },
  now: Date = new Date()
): ReviewPacket {
  const id = randomUUID();
  const at = now.toISOString();
  db.run(
    `INSERT INTO review_packets
       (id, owner, project_id, launch_id, job_id, session_id, pipeline_run_id, branch, commit_sha, base_sha,
        status, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
    [
      id,
      input.owner,
      input.projectId ?? null,
      input.launchId ?? null,
      input.jobId ?? null,
      input.sessionId ?? null,
      input.pipelineRunId ?? null,
      input.branch ?? null,
      input.commitSha ?? null,
      input.baseSha ?? null,
      at,
      at,
    ]
  );
  return getReviewPacket(db, id, input.owner)!;
}

/** The owner's most recent draft packet for a launch, if any. */
export function findDraftReviewPacketForLaunch(db: Database, owner: string, launchId: string): ReviewPacket | null {
  const row = db
    .query(
      `SELECT * FROM review_packets
        WHERE owner = ? AND launch_id = ? AND status = 'draft'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(owner, launchId) as PacketRow | null;
  return row ? toPacket(row) : null;
}

/**
 * The ids of `owner`'s packets for a job that wait on their decision — those
 * recorded under `jobId` or for any of its `launchIds` — oldest first.
 */
export function pendingReviewPacketsForJob(db: Database, owner: string, jobId: string, launchIds: string[]): string[] {
  const launches = launchIds.length > 0 ? ` OR launch_id IN (${launchIds.map(() => "?").join(", ")})` : "";
  const rows = db
    .query(
      `SELECT id FROM review_packets
        WHERE owner = ? AND (job_id = ?${launches}) AND status = 'pending'
        ORDER BY created_at, rowid`
    )
    .all(owner, jobId, ...launchIds) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** pendingReviewPacketsForJob, each with the launch its packet is for (null for one tied to the job alone). */
export function pendingReviewPacketLaunchesForJob(
  db: Database,
  owner: string,
  jobId: string,
  launchIds: string[]
): Array<{ id: string; launchId: string | null }> {
  const launches = launchIds.length > 0 ? ` OR launch_id IN (${launchIds.map(() => "?").join(", ")})` : "";
  const rows = db
    .query(
      `SELECT id, launch_id FROM review_packets
        WHERE owner = ? AND (job_id = ?${launches}) AND status = 'pending'
        ORDER BY created_at, rowid`
    )
    .all(owner, jobId, ...launchIds) as Array<{ id: string; launch_id: string | null }>;
  return rows.map((r) => ({ id: r.id, launchId: r.launch_id }));
}

/**
 * `owner`'s newest submitted packet for a job — recorded under `jobId` or for
 * any of its `launchIds`, pending or decided, never a draft or a superseded
 * one — or null when it has none.
 */
export function latestReviewPacketForJob(db: Database, owner: string, jobId: string, launchIds: string[]): ReviewPacket | null {
  const launches = launchIds.length > 0 ? ` OR launch_id IN (${launchIds.map(() => "?").join(", ")})` : "";
  const row = db
    .query(
      `SELECT * FROM review_packets
        WHERE owner = ? AND (job_id = ?${launches}) AND status IN ('pending', 'approved', 'changes_requested')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(owner, jobId, ...launchIds) as PacketRow | null;
  return row ? toPacket(row) : null;
}

/**
 * The launch's newest submitted packet — pending or decided, never a draft or
 * a superseded one — by when it was created (a decision doesn't make an old
 * packet newer), with the commit it was submitted at. Null when it has none.
 */
export function latestSubmittedReviewPacketForLaunch(
  db: Database,
  launchId: string
): { id: string; status: ReviewStatus; commitSha: string | null; decidedAt: string | null; updatedAt: string } | null {
  const row = db
    .query(
      `SELECT id, status, commit_sha, decided_at, updated_at FROM review_packets
        WHERE launch_id = ? AND status IN ('pending', 'approved', 'changes_requested')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(launchId) as {
    id: string;
    status: ReviewStatus;
    commit_sha: string | null;
    decided_at: string | null;
    updated_at: string;
  } | null;
  return row
    ? { id: row.id, status: row.status, commitSha: row.commit_sha, decidedAt: row.decided_at, updatedAt: row.updated_at }
    : null;
}

/** Whether a submitted packet for `launchId` waits on its owner's decision. */
export function hasPendingReviewPacketForLaunch(db: Database, launchId: string): boolean {
  return db.query("SELECT 1 AS found FROM review_packets WHERE launch_id = ? AND status = 'pending' LIMIT 1").get(launchId) !== null;
}

/**
 * Whether the launch's change is in its owner's Review tab as it stands: its
 * newest submitted packet waits on them or was approved. One the owner sent
 * back (changes requested) doesn't count — the rework needs a new packet.
 */
export function reviewPacketReadyForLaunch(db: Database, launchId: string): boolean {
  const latest = latestSubmittedReviewPacketForLaunch(db, launchId);
  return latest?.status === "pending" || latest?.status === "approved";
}

/**
 * Submits a draft (or resubmits a pending packet): writes its content, moves it
 * to `pending` with the next revision for its owner and launch, and supersedes
 * any other pending packet for that owner and launch, in one transaction. A
 * superseded packet's media rows are removed with it; the copies they named
 * are pushed onto `removedMedia`, for the caller to delete those no other row
 * names (countReviewMediaRefs). Returns null when the packet isn't the
 * owner's or is already decided.
 *
 * A ref left undefined keeps the packet's stored one; null clears it. The
 * submitter is recorded on the revision, which is flagged
 * resubmittedFromOtherSession when the launch's previous revision was
 * submitted by a known session other than this one.
 */
export function submitReviewPacket(
  db: Database,
  input: {
    id: string;
    owner: string;
    draft: ReviewPacketDraft;
    branch?: string | null;
    commitSha?: string | null;
    baseSha?: string | null;
    submittedBySession?: string | null;
    submittedByRootSession?: boolean;
    removedMedia?: Array<{ sha256: string; mime: string }>;
  },
  now: Date = new Date()
): ReviewPacket | null {
  const at = now.toISOString();
  const submit = db.transaction((): ReviewPacket | null => {
    const row = getPacketRow(db, input.id, input.owner);
    if (!row || (row.status !== "draft" && row.status !== "pending")) return null;
    const submitter = input.submittedBySession ?? null;
    const previous =
      row.launch_id !== null
        ? (db
            .query(
              `SELECT submitted_by_session FROM review_packets
                WHERE owner = ? AND launch_id = ? AND revision > 0
                ORDER BY revision DESC, rowid DESC LIMIT 1`
            )
            .get(input.owner, row.launch_id) as { submitted_by_session: string | null } | null)
        : row.revision > 0
          ? { submitted_by_session: row.submitted_by_session }
          : null;
    const fromOtherSession = !!previous?.submitted_by_session && previous.submitted_by_session !== submitter;
    let maxRevision = row.revision;
    if (row.launch_id !== null) {
      const max = db
        .query("SELECT COALESCE(MAX(revision), 0) AS max FROM review_packets WHERE owner = ? AND launch_id = ?")
        .get(input.owner, row.launch_id) as { max: number };
      maxRevision = Math.max(maxRevision, max.max);
      const superseded = `SELECT id FROM review_packets
          WHERE owner = ? AND launch_id = ? AND status = 'pending' AND id != ?`;
      const supersededArgs = [input.owner, row.launch_id, row.id];
      const removed = db
        .query(`SELECT sha256, mime FROM review_media WHERE owner = ? AND packet_id IN (${superseded})`)
        .all(input.owner, ...supersededArgs) as Array<{ sha256: string; mime: string }>;
      db.run(`DELETE FROM review_media WHERE owner = ? AND packet_id IN (${superseded})`, [input.owner, ...supersededArgs]);
      input.removedMedia?.push(...removed);
      // A superseded packet's share link is revoked: it would show a stale revision.
      const supersededIds = (db.query(superseded).all(...supersededArgs) as Array<{ id: string }>).map((r) => r.id);
      revokeGrantsFor(db, "review", supersededIds, now);
      // The owner's questions and their answers carry on on the new revision,
      // as review comments do across a pull request's revisions.
      db.run(`UPDATE review_comments SET packet_id = ? WHERE kind != 'comment' AND packet_id IN (${superseded})`, [row.id, ...supersededArgs]);
      db.run(
        `UPDATE review_packets SET status = 'superseded', updated_at = ?
          WHERE owner = ? AND launch_id = ? AND status = 'pending' AND id != ?`,
        [at, input.owner, row.launch_id, row.id]
      );
    }
    const { draft } = input;
    // A resubmission revokes the packet's share link: the owner shared the
    // content as it was, not whatever the worker submits next.
    revokeGrantsFor(db, "review", [row.id], now);
    db.run(
      `UPDATE review_packets
          SET title = ?, intent = ?, changes_json = ?, validation_json = ?, risks_json = ?, links_json = ?,
              branch = ?, commit_sha = ?, base_sha = ?,
              submitted_by_session = ?, submitted_by_root = ?, resubmitted_from_other_session = ?,
              status = 'pending', revision = ?, updated_at = ?
        WHERE id = ? AND owner = ?`,
      [
        draft.title,
        draft.intent,
        JSON.stringify(draft.changes),
        JSON.stringify(draft.validation),
        JSON.stringify(draft.risks),
        JSON.stringify(draft.links),
        input.branch === undefined ? row.branch : input.branch,
        input.commitSha === undefined ? row.commit_sha : input.commitSha,
        input.baseSha === undefined ? row.base_sha : input.baseSha,
        submitter,
        submitter !== null && input.submittedByRootSession ? 1 : 0,
        fromOtherSession ? 1 : 0,
        maxRevision + 1,
        at,
        row.id,
        input.owner,
      ]
    );
    return getReviewPacket(db, row.id, input.owner);
  });
  return submit();
}

/** The packet, only when it belongs to `owner`. */
export function getReviewPacket(db: Database, id: string, owner: string): ReviewPacket | null {
  const row = getPacketRow(db, id, owner);
  return row ? toPacket(row) : null;
}

/**
 * The owner's packets, newest first, with their image and video counts.
 * Drafts are left out unless `status` names them.
 */
export function listReviewPackets(
  db: Database,
  input: { owner: string; status?: ReviewStatus | ReviewStatus[]; limit?: number }
): ReviewPacketSummary[] {
  const statuses = input.status === undefined ? null : Array.isArray(input.status) ? input.status : [input.status];
  if (statuses !== null && statuses.length === 0) return [];
  const statusClause = statuses ? `p.status IN (${statuses.map(() => "?").join(", ")})` : "p.status != 'draft'";
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const rows = db
    .query(
      `SELECT p.id, p.owner, p.project_id, p.launch_id, p.job_id, p.session_id, p.branch, p.commit_sha, p.title, p.intent, p.status, p.revision,
              p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM review_media m WHERE m.packet_id = p.id AND m.kind = 'image') AS image_count,
              (SELECT COUNT(*) FROM review_media m WHERE m.packet_id = p.id AND m.kind = 'video') AS video_count,
              (SELECT COUNT(*) FROM review_comments q
                WHERE p.status = 'pending' AND q.packet_id = p.id AND q.kind = 'question' AND q.via != 'none'
                  AND NOT EXISTS (SELECT 1 FROM review_comments a WHERE a.packet_id = q.packet_id AND a.kind = 'answer' AND a.reply_to = q.id)
              ) AS open_questions
         FROM review_packets p
        WHERE p.owner = ? AND ${statusClause}
        ORDER BY p.created_at DESC, p.rowid DESC
        LIMIT ?`
    )
    .all(input.owner, ...(statuses ?? []), limit) as SummaryRow[];
  return rows.map(toSummary);
}

/** How many of the owner's packets await a decision. */
export function countPendingReviews(db: Database, owner: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM review_packets WHERE owner = ? AND status = 'pending'")
    .get(owner) as { n: number };
  return row.n;
}

/**
 * Records a decision on a pending packet, atomically: only a packet of the
 * owner's still `pending` moves. A non-empty comment is kept alongside, tagged
 * with the decision.
 */
export function decideReviewPacket(
  db: Database,
  input: { id: string; owner: string; decision: ReviewDecision; comment?: string; actor: string },
  now: Date = new Date()
): { ok: true; packet: ReviewPacket } | { ok: false; reason: "not_found" | "not_pending" } {
  const at = now.toISOString();
  const decide = db.transaction(
    (): { ok: true; packet: ReviewPacket } | { ok: false; reason: "not_found" | "not_pending" } => {
      const result = db.run(
        `UPDATE review_packets SET status = ?, decided_at = ?, decided_by = ?, updated_at = ?
          WHERE id = ? AND owner = ? AND status = 'pending'`,
        [input.decision, at, input.actor, at, input.id, input.owner]
      );
      if (result.changes !== 1) {
        return { ok: false, reason: getPacketRow(db, input.id, input.owner) ? "not_pending" : "not_found" };
      }
      const body = input.comment?.trim() ?? "";
      if (body.length > 0) {
        addReviewComment(db, { packetId: input.id, author: input.actor, body, decision: input.decision }, now);
      }
      return { ok: true, packet: getReviewPacket(db, input.id, input.owner)! };
    }
  );
  return decide();
}

/** Adds a comment to a packet (a remark unless `kind` says otherwise); returns it. */
export function addReviewComment(
  db: Database,
  input: {
    packetId: string;
    author: string;
    body: string;
    decision?: ReviewDecision;
    kind?: ReviewCommentKind;
    replyTo?: string;
    via?: ReviewCommentVia;
  },
  now: Date = new Date()
): ReviewComment {
  const id = randomUUID();
  db.run(
    "INSERT INTO review_comments (id, packet_id, author, body, decision, kind, reply_to, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      input.packetId,
      input.author,
      input.body,
      input.decision ?? null,
      input.kind ?? "comment",
      input.replyTo ?? null,
      input.via ?? null,
      now.toISOString(),
    ]
  );
  return getReviewComment(db, input.packetId, id)!;
}

/** One of a packet's comments by id; null when the packet has none with that id. */
export function getReviewComment(db: Database, packetId: string, id: string): ReviewComment | null {
  const row = db.query("SELECT * FROM review_comments WHERE packet_id = ? AND id = ?").get(packetId, id) as CommentRow | null;
  return row ? toComment(row) : null;
}

/** The owner's questions sent to the launch's worker on its pending packets that no answer names yet, oldest first. */
export function unansweredWorkerQuestionsForLaunch(db: Database, launchId: string): Array<{ packetId: string; questionId: string; body: string }> {
  return db
    .query(
      `SELECT q.packet_id AS packetId, q.id AS questionId, q.body
         FROM review_comments q JOIN review_packets p ON p.id = q.packet_id
        WHERE p.launch_id = ? AND p.status = 'pending' AND q.kind = 'question' AND q.via = 'worker'
          AND NOT EXISTS (SELECT 1 FROM review_comments a WHERE a.packet_id = q.packet_id AND a.kind = 'answer' AND a.reply_to = q.id)
        ORDER BY q.created_at, q.rowid`
    )
    .all(launchId) as Array<{ packetId: string; questionId: string; body: string }>;
}

/** A comment by id alone, with the packet it is on now (a resubmission carries questions to the new revision). */
export function findReviewComment(db: Database, id: string): { packetId: string; comment: ReviewComment } | null {
  const row = db.query("SELECT * FROM review_comments WHERE id = ?").get(id) as CommentRow | null;
  return row ? { packetId: row.packet_id, comment: toComment(row) } : null;
}

/** A packet's comments, oldest first. */
export function listReviewComments(db: Database, packetId: string): ReviewComment[] {
  const rows = db
    .query("SELECT * FROM review_comments WHERE packet_id = ? ORDER BY created_at, rowid")
    .all(packetId) as CommentRow[];
  return rows.map(toComment);
}

/** Records a media file attached to a packet; returns the row. */
export function addReviewMedia(
  db: Database,
  input: {
    packetId: string;
    owner: string;
    kind: ReviewMediaKind;
    mime: string;
    sha256: string;
    bytes: number;
    caption: string;
    position: number;
  },
  now: Date = new Date()
): ReviewMediaRow {
  const id = randomUUID();
  db.run(
    `INSERT INTO review_media (id, packet_id, owner, kind, mime, sha256, bytes, caption, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.packetId,
      input.owner,
      input.kind,
      input.mime,
      input.sha256,
      input.bytes,
      input.caption,
      input.position,
      now.toISOString(),
    ]
  );
  return getReviewMedia(db, { packetId: input.packetId, mediaId: id, owner: input.owner })!;
}

/** A packet's media, in position order, only when the packet belongs to `owner`. */
export function listReviewMedia(db: Database, packetId: string, owner: string): ReviewMediaRow[] {
  const rows = db
    .query(
      `SELECT m.* FROM review_media m
         JOIN review_packets p ON p.id = m.packet_id
        WHERE m.packet_id = ? AND m.owner = ? AND p.owner = ?
        ORDER BY m.position, m.created_at, m.rowid`
    )
    .all(packetId, owner, owner) as MediaRow[];
  return rows.map(toMedia);
}

/** One media file, only when it belongs to that packet and the packet to `owner`. */
export function getReviewMedia(
  db: Database,
  input: { packetId: string; mediaId: string; owner: string }
): ReviewMediaRow | null {
  const row = db
    .query(
      `SELECT m.* FROM review_media m
         JOIN review_packets p ON p.id = m.packet_id
        WHERE m.id = ? AND m.packet_id = ? AND m.owner = ? AND p.owner = ?`
    )
    .get(input.mediaId, input.packetId, input.owner, input.owner) as MediaRow | null;
  return row ? toMedia(row) : null;
}

/** How many media rows, any owner's and any packet's, name the stored copy `sha256`. */
export function countReviewMediaRefs(db: Database, sha256: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM review_media WHERE sha256 = ?").get(sha256) as { n: number };
  return row.n;
}

/** Packets a submission is about to replace, whose media the owner's quota leaves out. */
export interface ReviewMediaQuotaExcept {
  /** The draft whose media the submission replaces. */
  packetId?: string;
  /** The launch whose pending packets the submission supersedes. */
  launchId?: string;
}

/**
 * The distinct stored copies (sha256 → bytes) the owner's open packets name:
 * only `draft` and `pending` packets count, so a decided or superseded
 * packet's media never holds the owner's quota. A copy named by several rows
 * counts once. `except` leaves out the packets a submission replaces.
 */
export function heldReviewMedia(db: Database, owner: string, except: ReviewMediaQuotaExcept = {}): Map<string, number> {
  const rows = db
    .query(
      `SELECT m.sha256 AS sha256, MAX(m.bytes) AS bytes
         FROM review_media m
         JOIN review_packets p ON p.id = m.packet_id
        WHERE m.owner = ? AND p.owner = ?
          AND p.status IN ('draft', 'pending')
          AND p.id != ?
          AND NOT (p.status = 'pending' AND p.launch_id IS NOT NULL AND p.launch_id = ?)
        GROUP BY m.sha256`
    )
    .all(owner, owner, except.packetId ?? "", except.launchId ?? "") as Array<{ sha256: string; bytes: number }>;
  return new Map(rows.map((r) => [r.sha256, r.bytes]));
}

/** The bytes of the distinct stored copies the owner's open packets hold (heldReviewMedia). */
export function sumReviewMediaBytes(db: Database, owner: string, except: ReviewMediaQuotaExcept = {}): number {
  let total = 0;
  for (const bytes of heldReviewMedia(db, owner, except).values()) total += bytes;
  return total;
}

/** How many submissions a launch has made: the highest revision any of its packets reached. */
export function countLaunchReviewSubmissions(db: Database, launchId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(revision), 0) AS n FROM review_packets WHERE launch_id = ?")
    .get(launchId) as { n: number };
  return row.n;
}

/** Removes every media row of the owner's packet; returns how many were removed. */
export function clearReviewMedia(db: Database, packetId: string, owner: string): number {
  const result = db.run(
    `DELETE FROM review_media
      WHERE packet_id = ? AND owner = ?
        AND EXISTS (SELECT 1 FROM review_packets p WHERE p.id = review_media.packet_id AND p.owner = ?)`,
    [packetId, owner, owner]
  );
  return result.changes;
}

// ── Sharing by link ─────────────────────────────────────────────────────────

/** A packet's share state: whether a link is live and, while it is, the link's token. */
export interface ReviewShareRow {
  enabled: boolean;
  token: string | null;
}

/** The owner's packet's share state (its live grant); null when the packet isn't the owner's. */
export function getReviewShare(db: Database, id: string, owner: string): ReviewShareRow | null {
  if (!getPacketRow(db, id, owner)) return null;
  const grant = getLiveGrant(db, "review", id, owner);
  return grant ? { enabled: true, token: grant.token } : { enabled: false, token: null };
}

/** Why a packet of `status` can't be shared, or null when it can: a draft has nothing to show, a superseded one is stale. */
export function reviewShareRefusal(status: ReviewStatus): "draft" | "superseded" | null {
  return status === "draft" || status === "superseded" ? status : null;
}

/**
 * Turns sharing of the owner's packet on or off (setShare). Turning it on
 * always mints a new token, so a link from an earlier share never works
 * again; turning it off revokes the link. A draft (nothing to show yet) or a
 * superseded packet (a stale revision whose media is gone) can't be shared,
 * and its status is returned instead; null when the packet isn't the owner's.
 */
export function setReviewShare(
  db: Database,
  input: { id: string; owner: string; enabled: boolean }
): ReviewShareRow | "draft" | "superseded" | null {
  const set = db.transaction((): ReviewShareRow | "draft" | "superseded" | null => {
    const row = getPacketRow(db, input.id, input.owner);
    if (!row) return null;
    if (input.enabled) {
      const refusal = reviewShareRefusal(row.status);
      if (refusal) return refusal;
    }
    const grant = setShare(db, "review", input.id, input.owner, input.enabled);
    return grant ? { enabled: true, token: grant.token } : { enabled: false, token: null };
  });
  return set();
}

/** The packet a live share token names: a live grant whose token matches, never a draft or a superseded packet. */
export function getSharedReviewPacket(db: Database, token: string): ReviewPacket | null {
  const grant = findLiveGrantByToken(db, "review", token);
  if (!grant) return null;
  const row = getPacketRow(db, grant.resourceId, grant.owner);
  if (!row || reviewShareRefusal(row.status)) return null;
  return toPacket(row);
}
