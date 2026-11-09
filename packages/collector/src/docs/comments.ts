import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { DocComment, DocCommentAnchor, DocCommentState } from "@standup/shared";
import { DOC_COMMENT_BODY_MAX, DOC_COMMENT_LIMITS, docCommentRefusal } from "@standup/shared";
import {
  addDocCommentReply,
  countDocAgentReplies,
  countDocComments,
  countOpenDocComments,
  createDocComment,
  docAccessFor,
  getDoc,
  getDocComment,
  listDocComments,
  listPendingDocComments,
  setDocCommentResolved,
  setDocCommentState,
  settleOwnerDocComments,
} from "@standup/store";
import type { DocAccess, DocCommentTarget } from "@standup/store";
import type { DocAnswerer } from "./answer.js";

/**
 * Comments on a doc's passages. Anyone who can read a doc (docAccessFor: its
 * owner, shared or not, or any signed-in user when the doc is shareable) can
 * comment on it, under their own signed-in alias; the doc agent replies to a
 * reader's comment from the doc alone when it can (answer.ts), never to the
 * owner's; only the doc's owner replies and resolves.
 *
 * Limits (DOC_COMMENT_LIMITS). A comment past its author's per-minute or
 * per-hour count, the doc's per-hour count or the doc's open-comment cap is
 * refused with a 429. Past the doc agent's caps (per doc per hour, per owner
 * per day) a comment is still taken but gets no agent reply: it waits for
 * the owner. At most `agentConcurrent` replies are written at once; the rest
 * queue, and the queue only ever holds comments the caps let through. The
 * counts are read and the comment written with no await between them, so
 * concurrent requests can't both pass on the same count.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `text` with whitespace and markdown's punctuation dropped, so rendered text and its markdown compare. */
function plain(text: string): string {
  return text.replace(/[\s*_`~>#[\]()!|\\-]+/g, "");
}

/**
 * Whether the doc's markdown holds the quoted passage, as far as rendered
 * text and markdown can be compared: a quote spanning a link's target, say,
 * reads as not in the doc.
 */
export function quoteInDoc(body: string, quote: string): boolean {
  const q = plain(quote);
  return q.length > 0 && plain(body).includes(q);
}

/** A comment's fields as they leave the collector, each copied by name. */
export function publicDocComment(c: DocComment): DocComment {
  return {
    id: c.id,
    anchor: { quote: c.anchor.quote, prefix: c.anchor.prefix, suffix: c.anchor.suffix },
    author: c.author,
    ...(c.byOwner ? { byOwner: true as const } : {}),
    body: c.body,
    state: c.state,
    resolved: c.resolved,
    createdAt: c.createdAt,
    replies: c.replies.map((r) => ({
      id: r.id,
      authorKind: r.authorKind,
      ...(r.authorKind === "owner" && r.author ? { author: r.author } : {}),
      ...(r.authorKind === "agent" && r.fromDoc ? { fromDoc: true as const } : {}),
      body: r.body,
      createdAt: r.createdAt,
    })),
  };
}

/**
 * Writes the doc agent's replies, at most `concurrent` at once. A comment
 * still pending when the collector starts (one cut off by a restart) is
 * picked up again by `resume`.
 */
export class DocCommentAgent {
  private running = 0;
  private readonly queue: DocCommentTarget[] = [];
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly db: Database,
    private readonly answer: DocAnswerer,
    private readonly concurrent: number = DOC_COMMENT_LIMITS.agentConcurrent
  ) {}

  enqueue(target: DocCommentTarget): void {
    this.queue.push(target);
    this.pump();
  }

  /** Queues every reader's comment left pending; the owner's own are settled first, never sent. */
  resume(): void {
    settleOwnerDocComments(this.db);
    for (const target of listPendingDocComments(this.db)) this.enqueue(target);
  }

  /** Resolves once nothing is queued or being written (for tests). */
  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrent && this.queue.length > 0) {
      const target = this.queue.shift()!;
      this.running++;
      void this.reply(target).finally(() => {
        this.running--;
        this.pump();
        if (this.running === 0 && this.queue.length === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
        }
      });
    }
  }

  private async reply({ comment, owner, docId }: DocCommentTarget): Promise<void> {
    const doc = getDoc(this.db, docId, owner);
    if (!doc) return;
    // A doc unshared since the comment was left gets no model call: the comment waits for its owner.
    if (!docAccessFor(this.db, docId, comment.author)) {
      setDocCommentState(this.db, comment.id, "pending", "waiting");
      return;
    }
    let answer = null;
    try {
      // The quote is the reader's too: it goes to the agent only when the doc says it.
      const passage = quoteInDoc(doc.body, comment.anchor.quote) ? comment.anchor.quote : undefined;
      answer = await this.answer({ docName: doc.name, body: doc.body, ...(passage ? { passage } : {}), question: comment.body });
    } catch (err) {
      console.error("[doc-comments] agent reply failed:", err);
    }
    if (!answer) {
      setDocCommentState(this.db, comment.id, "pending", "waiting");
      return;
    }
    // An owner who replied while the agent was working has answered it: the agent's reply is dropped.
    const state: DocCommentState = answer.kind === "answer" ? "answered" : "waiting";
    addDocCommentReply(this.db, {
      docId,
      commentId: comment.id,
      authorKind: "agent",
      body: answer.text,
      state,
      from: "pending",
      fromDoc: answer.kind === "answer",
    });
  }
}

/** The answer to a comment request: a status and its JSON. */
export interface CommentResult {
  status: 200 | 400 | 429;
  json: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/** Why the doc takes no comment from `author` right now (a 429), or null. */
function commentLimit(db: Database, author: string, docId: string, now: Date): CommentResult | null {
  const L = DOC_COMMENT_LIMITS;
  const tooMany = (message: string, retryAfterSeconds: number): CommentResult => ({ status: 429, json: { error: message }, retryAfterSeconds });
  if (countDocComments(db, { author }, new Date(now.getTime() - MINUTE)) >= L.perUserPerMinute) {
    return tooMany("You've left several comments just now. Try again in a minute.", 60);
  }
  if (countDocComments(db, { author }, new Date(now.getTime() - HOUR)) >= L.perUserPerHour) {
    return tooMany("You've reached your comments for the hour. Try again later.", 3600);
  }
  if (countDocComments(db, { docId }, new Date(now.getTime() - HOUR)) >= L.perDocPerHour) {
    return tooMany("This doc has reached its comments for the hour. Try again later.", 3600);
  }
  if (countOpenDocComments(db, docId) >= L.openPerDoc) {
    return tooMany("This doc has too many open comments right now.", 3600);
  }
  return null;
}

/** Whether the doc agent may reply to one more comment on the doc. */
function agentMayReply(db: Database, owner: string, docId: string, now: Date): boolean {
  const L = DOC_COMMENT_LIMITS;
  return (
    countDocAgentReplies(db, { docId }, new Date(now.getTime() - HOUR)) < L.agentPerDocPerHour &&
    countDocAgentReplies(db, { owner }, new Date(now.getTime() - DAY)) < L.agentPerOwnerPerDay
  );
}

/**
 * Takes `author`'s comment on the doc `access` names (the caller already
 * decided `author` may read it), and queues the doc agent's reply when its
 * caps allow.
 */
export function takeDocComment(
  db: Database,
  agent: DocCommentAgent,
  access: Pick<DocAccess, "owner"> & { docId: string },
  author: string,
  body: Record<string, unknown>,
  now: Date = new Date()
): CommentResult {
  const refusal = docCommentRefusal({ body: body.body, anchor: body.anchor });
  if (refusal) return { status: 400, json: { error: refusal } };
  const limited = commentLimit(db, author, access.docId, now);
  if (limited) return limited;
  const raw = body.anchor as DocCommentAnchor;
  const anchor = { quote: raw.quote, prefix: raw.prefix, suffix: raw.suffix };
  // The owner is the authority on their own doc: their comment gets no agent reply and waits on no one.
  const byOwner = author === access.owner;
  const state: DocCommentState = byOwner ? "answered" : agentMayReply(db, access.owner, access.docId, now) ? "pending" : "waiting";
  const comment = createDocComment(db, { owner: access.owner, docId: access.docId, author, body: (body.body as string).trim(), anchor, state }, now);
  if (state === "pending") agent.enqueue({ comment, owner: access.owner, docId: access.docId });
  return { status: 200, json: { comment: publicDocComment(comment) } };
}

export interface DocCommentRoutesOptions {
  db: Database;
  agent: DocCommentAgent;
  /** The signed-in person a console request is from, or the refusal (docs/routes.ts callerOf). */
  callerOf(c: Context): { owner: string } | Response;
  /** callerOf for a JSON write (docs/routes.ts writerOf). */
  writerOf(c: Context): { owner: string } | Response;
}

/** The comment routes: a doc's readers list and leave comments; its owner replies and resolves. */
export function mountDocCommentRoutes(app: Hono, opts: DocCommentRoutesOptions): void {
  const { db, agent } = opts;

  /** The caller and what they may do with the doc the path names, or the refusal. */
  const accessOf = (c: Context, write: boolean, ownerOnly: boolean): { viewer: string; access: DocAccess } | Response => {
    const caller = write ? opts.writerOf(c) : opts.callerOf(c);
    if (caller instanceof Response) return caller;
    const docId = c.req.param("id") ?? "";
    const access = DOC_ID.test(docId) ? docAccessFor(db, docId, caller.owner) : null;
    // A reader asking for the owner's actions learns no more than "unknown".
    if (!access || (ownerOnly && access.role !== "owner")) return c.json({ error: "Unknown doc" }, 404);
    return { viewer: caller.owner, access };
  };

  const json = async (c: Context): Promise<Record<string, unknown> | null> => {
    const body = await c.req.json<unknown>().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  };

  app.get("/api/docs/:id/comments", (c) => {
    const a = accessOf(c, false, false);
    if (a instanceof Response) return a;
    return c.json({ comments: listDocComments(db, a.access.doc.id).map(publicDocComment) });
  });

  app.post("/api/docs/:id/comments", async (c) => {
    const a = accessOf(c, true, false);
    if (a instanceof Response) return a;
    const body = await json(c);
    if (!body) return c.json({ error: "malformed request body" }, 400);
    // Read again after the body: a doc unshared meanwhile takes nothing.
    const access = docAccessFor(db, a.access.doc.id, a.viewer);
    if (!access) return c.json({ error: "Unknown doc" }, 404);
    const result = takeDocComment(db, agent, { owner: access.owner, docId: access.doc.id }, a.viewer, body);
    return c.json(result.json, result.status, result.retryAfterSeconds ? { "retry-after": String(result.retryAfterSeconds) } : {});
  });

  app.post("/api/docs/:id/comments/:commentId/reply", async (c) => {
    const a = accessOf(c, true, true);
    if (a instanceof Response) return a;
    const body = await json(c);
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text) return c.json({ error: "A reply needs some text" }, 400);
    if (text.length > DOC_COMMENT_BODY_MAX) return c.json({ error: `A reply is at most ${DOC_COMMENT_BODY_MAX} characters` }, 400);
    const commentId = c.req.param("commentId");
    const docId = a.access.doc.id;
    if (!addDocCommentReply(db, { docId, commentId, authorKind: "owner", author: a.viewer, body: text, state: "answered" })) {
      return c.json({ error: "Unknown comment" }, 404);
    }
    return c.json({ comment: publicDocComment(getDocComment(db, commentId, docId)!) });
  });

  app.post("/api/docs/:id/comments/:commentId/resolve", async (c) => {
    const a = accessOf(c, true, true);
    if (a instanceof Response) return a;
    const body = await json(c);
    if (typeof body?.resolved !== "boolean") return c.json({ error: "resolved must be true or false" }, 400);
    const commentId = c.req.param("commentId");
    const docId = a.access.doc.id;
    if (!setDocCommentResolved(db, commentId, docId, body.resolved)) return c.json({ error: "Unknown comment" }, 404);
    return c.json({ comment: publicDocComment(getDocComment(db, commentId, docId)!) });
  });
}
