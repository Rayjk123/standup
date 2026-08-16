import type { Database } from "bun:sqlite";
import type { ExpertExchange } from "@standup/shared";
import { randomUUID } from "crypto";

interface ExpertRow {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  region: string | null;
  sources_json: string;
  created_at: string;
}

function toExchange(row: ExpertRow): ExpertExchange {
  return {
    id: row.id,
    sessionId: row.session_id,
    question: row.question,
    answer: row.answer,
    region: row.region ?? "",
    sources: JSON.parse(row.sources_json),
    createdAt: new Date(row.created_at),
  };
}

export function recordExpertExchange(
  db: Database,
  sessionId: string,
  question: string,
  answer: string,
  region: string,
  sources: string[]
): ExpertExchange {
  const id = randomUUID();

  db.run(
    `INSERT INTO expert_exchanges (id, session_id, question, answer, region, sources_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, sessionId, question, answer, region || null, JSON.stringify(sources)]
  );

  return {
    id,
    sessionId,
    question,
    answer,
    region,
    sources,
    createdAt: new Date(),
  };
}

export function getRecentExpertExchanges(db: Database, limit = 50): ExpertExchange[] {
  const rows = db
    .query("SELECT * FROM expert_exchanges ORDER BY created_at DESC LIMIT ?")
    .all(limit) as ExpertRow[];
  return rows.map(toExchange);
}

export function getExpertExchangesBySession(
  db: Database,
  sessionId: string
): ExpertExchange[] {
  const rows = db
    .query(
      "SELECT * FROM expert_exchanges WHERE session_id = ? ORDER BY created_at ASC"
    )
    .all(sessionId) as ExpertRow[];
  return rows.map(toExchange);
}
