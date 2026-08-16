import type { Database } from "bun:sqlite";
import type { Ask, AskKind, AskStatus } from "@standup/shared";
import { randomUUID } from "crypto";

export function createAsk(
  db: Database,
  sessionId: string,
  kind: AskKind,
  question: string,
  options?: string[]
): Ask {
  const id = randomUUID();

  db.run(
    "INSERT INTO asks (id, session_id, kind, question, options_json) VALUES (?, ?, ?, ?, ?)",
    [id, sessionId, kind, question, options ? JSON.stringify(options) : null]
  );

  return {
    id,
    sessionId,
    kind,
    question,
    options,
    status: "pending",
    createdAt: new Date(),
  };
}

export function resolveAsk(
  db: Database,
  askId: string,
  answer: string
): void {
  db.run(
    "UPDATE asks SET answer = ?, status = 'answered', resolved_at = datetime('now') WHERE id = ?",
    [answer, askId]
  );
}

export function timeoutAsk(db: Database, askId: string): void {
  db.run(
    "UPDATE asks SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?",
    [askId]
  );
}

export function cancelAsk(db: Database, askId: string): void {
  db.run(
    "UPDATE asks SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?",
    [askId]
  );
}

export function getAsk(db: Database, askId: string): Ask | null {
  const row = db.query("SELECT * FROM asks WHERE id = ?").get(askId) as {
    id: string;
    session_id: string;
    kind: AskKind;
    question: string;
    options_json: string | null;
    answer: string | null;
    status: AskStatus;
    created_at: string;
    resolved_at: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
  };
}

/**
 * Cancels pending prompt-asks for a session and returns what was cancelled.
 *
 * These are raised from Notification hooks rather than a blocking tool call,
 * so nothing resolves them when the human answers in the terminal directly.
 * Any sign of the session moving again means they're stale. Deliberately
 * scoped to `permission_prompt` — an `ask_human` has a real waiter and must
 * never be cancelled out from under it.
 */
/**
 * Cancels every pending ask for a session, `ask_human` included.
 *
 * `cancelPromptAsks` deliberately excludes `ask_human` because it has a real
 * waiter (an MCP tool call long-polling for the answer) that must not be
 * cancelled out from under a session that's still running. This function is
 * for the opposite case: the session itself is gone — stopped or deleted —
 * so nothing can ever resolve that waiter anyway. Left pending, an ask like
 * this outlives the session and sits in Blocked forever with no session to
 * answer.
 */
export function cancelAllPendingAsks(db: Database, sessionId: string): Ask[] {
  const stale = db
    .query(
      `UPDATE asks
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE session_id = ? AND status = 'pending'
       RETURNING id, session_id, kind, question, options_json, answer, status,
                 created_at, resolved_at`
    )
    .all(sessionId) as Array<{
    id: string;
    session_id: string;
    kind: AskKind;
    question: string;
    options_json: string | null;
    answer: string | null;
    status: AskStatus;
    created_at: string;
    resolved_at: string | null;
  }>;

  return stale.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
  }));
}

export function cancelPromptAsks(db: Database, sessionId: string): Ask[] {
  const stale = db
    .query(
      `UPDATE asks
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE session_id = ? AND status = 'pending' AND kind = 'permission_prompt'
       RETURNING id, session_id, kind, question, options_json, answer, status,
                 created_at, resolved_at`
    )
    .all(sessionId) as Array<{
    id: string;
    session_id: string;
    kind: AskKind;
    question: string;
    options_json: string | null;
    answer: string | null;
    status: AskStatus;
    created_at: string;
    resolved_at: string | null;
  }>;

  return stale.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
  }));
}

export function getPendingAsks(db: Database): Ask[] {
  const rows = db
    .query("SELECT * FROM asks WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as Array<{
    id: string;
    session_id: string;
    kind: AskKind;
    question: string;
    options_json: string | null;
    answer: string | null;
    status: AskStatus;
    created_at: string;
    resolved_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
  }));
}

export function getPendingAsksBySession(
  db: Database,
  sessionId: string
): Ask[] {
  const rows = db
    .query(
      "SELECT * FROM asks WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC"
    )
    .all(sessionId) as Array<{
    id: string;
    session_id: string;
    kind: AskKind;
    question: string;
    options_json: string | null;
    answer: string | null;
    status: AskStatus;
    created_at: string;
    resolved_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
  }));
}
