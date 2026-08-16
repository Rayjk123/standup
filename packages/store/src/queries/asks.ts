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
