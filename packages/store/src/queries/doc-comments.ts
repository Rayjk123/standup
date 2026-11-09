import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { DocComment, DocCommentAnchor, DocCommentReply, DocCommentState } from "@standup/shared";

/**
 * Comments on a doc's passages (migration 096). A comment is left by a
 * signed-in user who can read the doc (queries/doc-sharing.ts decides who),
 * the doc's owner included; its replies are the doc agent's and the doc
 * owner's. Rows carry the doc's owner, and every read names the doc. A
 * top-level row is always `author_kind = 'reader'`, even the owner's own:
 * whether the owner left it is `author = owner` (DocComment.byOwner). A doc's comments go when the doc does
 * (deleteDoc, deleteDocFolder).
 */

interface CommentRow {
  id: string;
  owner: string;
  doc_id: string;
  parent_id: string | null;
  author: string;
  author_kind: "reader" | "agent" | "owner";
  body: string;
  quote: string;
  prefix: string;
  suffix: string;
  state: DocCommentState | null;
  from_doc: number;
  resolved_at: string | null;
  created_at: string;
}

/** A comment and the doc it is on, as the doc agent's reply job needs it. */
export interface DocCommentTarget {
  comment: DocComment;
  owner: string;
  docId: string;
}

/** The author recorded on the doc agent's replies. */
const AGENT_AUTHOR = "doc-agent";

function toComment(row: CommentRow, replies: DocCommentReply[]): DocComment {
  return {
    id: row.id,
    anchor: { quote: row.quote, prefix: row.prefix, suffix: row.suffix },
    author: row.author,
    ...(row.author === row.owner ? { byOwner: true as const } : {}),
    body: row.body,
    state: row.state ?? "waiting",
    resolved: row.resolved_at !== null,
    createdAt: row.created_at,
    replies,
  };
}

function toReply(row: CommentRow): DocCommentReply {
  return row.author_kind === "owner"
    ? { id: row.id, authorKind: "owner", author: row.author, body: row.body, createdAt: row.created_at }
    : { id: row.id, authorKind: "agent", ...(row.from_doc ? { fromDoc: true as const } : {}), body: row.body, createdAt: row.created_at };
}

/** The doc's comments, oldest first, each with its replies oldest first. */
export function listDocComments(db: Database, docId: string): DocComment[] {
  const rows = db.query("SELECT * FROM doc_comments WHERE doc_id = ? ORDER BY created_at, rowid").all(docId) as CommentRow[];
  const replies = new Map<string, DocCommentReply[]>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    const list = replies.get(row.parent_id) ?? [];
    list.push(toReply(row));
    replies.set(row.parent_id, list);
  }
  return rows.filter((r) => r.parent_id === null).map((r) => toComment(r, replies.get(r.id) ?? []));
}

/** One comment (not a reply) on the doc, or null. */
export function getDocComment(db: Database, id: string, docId: string): DocComment | null {
  return listDocComments(db, docId).find((c) => c.id === id) ?? null;
}

/** `author`'s comment on `owner`'s doc, in state `state`. */
export function createDocComment(
  db: Database,
  input: { owner: string; docId: string; author: string; body: string; anchor: DocCommentAnchor; state: DocCommentState },
  now: Date = new Date()
): DocComment {
  const id = randomUUID();
  const createdAt = now.toISOString();
  db.run(
    `INSERT INTO doc_comments (id, owner, doc_id, parent_id, author, author_kind, body, quote, prefix, suffix, state, agent_tried, created_at)
     VALUES (?, ?, ?, NULL, ?, 'reader', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.docId,
      input.author,
      input.body,
      input.anchor.quote,
      input.anchor.prefix,
      input.anchor.suffix,
      input.state,
      // A comment taken as pending is handed to the doc agent, and counts against its caps from now on.
      input.state === "pending" ? 1 : 0,
      createdAt,
    ]
  );
  return getDocComment(db, id, input.docId)!;
}

/**
 * Adds a reply to a comment on the doc and moves the comment to `state`;
 * false when there is no such comment, or (with `from`) when the comment is
 * no longer in that state. An owner's reply names the owner as `author`.
 */
export function addDocCommentReply(
  db: Database,
  input: {
    docId: string;
    commentId: string;
    authorKind: "agent" | "owner";
    author?: string;
    body: string;
    state: DocCommentState;
    from?: DocCommentState;
    /** On an agent reply: it answered from the doc. */
    fromDoc?: boolean;
  },
  now: Date = new Date()
): boolean {
  const add = db.transaction((): boolean => {
    const parent = db
      .query(`SELECT owner FROM doc_comments WHERE id = ? AND doc_id = ? AND parent_id IS NULL${input.from ? " AND state = ?" : ""}`)
      .get(input.commentId, input.docId, ...(input.from ? [input.from] : [])) as { owner: string } | null;
    if (!parent) return false;
    db.run("UPDATE doc_comments SET state = ? WHERE id = ?", [input.state, input.commentId]);
    db.run(
      `INSERT INTO doc_comments (id, owner, doc_id, parent_id, author, author_kind, body, from_doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        parent.owner,
        input.docId,
        input.commentId,
        input.authorKind === "owner" ? (input.author ?? parent.owner) : AGENT_AUTHOR,
        input.authorKind,
        input.body,
        input.authorKind === "agent" && input.fromDoc ? 1 : 0,
        now.toISOString(),
      ]
    );
    return true;
  });
  return add();
}

/** Moves a comment to `state`, but only from `from`; false when it wasn't there in that state. */
export function setDocCommentState(db: Database, commentId: string, from: DocCommentState, state: DocCommentState): boolean {
  return db.run("UPDATE doc_comments SET state = ? WHERE id = ? AND parent_id IS NULL AND state = ?", [state, commentId, from]).changes > 0;
}

/** Resolves or reopens a comment on the doc; false when there is no such comment. */
export function setDocCommentResolved(db: Database, commentId: string, docId: string, resolved: boolean, now: Date = new Date()): boolean {
  return (
    db.run("UPDATE doc_comments SET resolved_at = ? WHERE id = ? AND doc_id = ? AND parent_id IS NULL", [
      resolved ? now.toISOString() : null,
      commentId,
      docId,
    ]).changes > 0
  );
}

/** Deletes every comment and reply on the docs. */
export function deleteDocComments(db: Database, docIds: readonly string[]): void {
  for (const id of docIds) db.run("DELETE FROM doc_comments WHERE doc_id = ?", [id]);
}

/** Comments (not replies) left since `since`: by one user, or on one doc. */
export function countDocComments(db: Database, by: { author: string } | { docId: string }, since: Date): number {
  const [column, value] = "author" in by ? ["author", by.author] : ["doc_id", by.docId];
  const row = db
    .query(`SELECT COUNT(*) AS n FROM doc_comments WHERE ${column} = ? AND parent_id IS NULL AND created_at >= ?`)
    .get(value, since.toISOString()) as { n: number };
  return row.n;
}

/** The doc's unresolved comments. */
export function countOpenDocComments(db: Database, docId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM doc_comments WHERE doc_id = ? AND parent_id IS NULL AND resolved_at IS NULL")
    .get(docId) as { n: number };
  return row.n;
}

/**
 * The doc agent's use since `since`, on one doc or on all of one owner's
 * docs: every comment handed to it, whether its call answered, failed or is
 * still running, so a call that fails costs the cap like one that answers.
 */
export function countDocAgentReplies(db: Database, by: { docId: string } | { owner: string }, since: Date): number {
  const [column, value] = "docId" in by ? ["doc_id", by.docId] : ["owner", by.owner];
  const row = db
    // A comment still pending counts however old it is: a restart's resume sends it to the model again.
    .query(
      `SELECT COUNT(*) AS n FROM doc_comments WHERE ${column} = ? AND parent_id IS NULL AND agent_tried = 1
         AND (created_at >= ? OR state = 'pending')`
    )
    .get(value, since.toISOString()) as { n: number };
  return row.n;
}

/**
 * Moves the owner's own comments that an older collector left `pending` or
 * `waiting` to `answered`, as they are taken now: the owner's comment waits
 * on no one, and a pending one would count against the agent's caps for good.
 */
export function settleOwnerDocComments(db: Database): number {
  return db.run("UPDATE doc_comments SET state = 'answered' WHERE parent_id IS NULL AND state IN ('pending', 'waiting') AND author = owner").changes;
}

/** Every comment still `pending`, as a restarted collector finds them. */
export function listPendingDocComments(db: Database): DocCommentTarget[] {
  const rows = db.query("SELECT * FROM doc_comments WHERE parent_id IS NULL AND state = 'pending'").all() as CommentRow[];
  return rows.map((r) => ({ comment: toComment(r, []), owner: r.owner, docId: r.doc_id }));
}
