import type { Database } from "bun:sqlite";
import type { Checkpoint, CheckpointSource } from "@standup/shared";
import { randomUUID } from "crypto";

export function createCheckpoint(
  db: Database,
  sessionId: string,
  source: CheckpointSource,
  summary: string
): Checkpoint {
  const id = randomUUID();

  db.run(
    "INSERT INTO checkpoints (id, session_id, source, summary) VALUES (?, ?, ?, ?)",
    [id, sessionId, source, summary]
  );

  return {
    id,
    sessionId,
    source,
    summary,
    createdAt: new Date(),
  };
}

export function getCheckpointsBySession(
  db: Database,
  sessionId: string
): Checkpoint[] {
  const rows = db
    .query(
      "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC"
    )
    .all(sessionId) as Array<{
    id: string;
    session_id: string;
    source: CheckpointSource;
    summary: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    summary: row.summary,
    createdAt: new Date(row.created_at),
  }));
}

export function getRecentCheckpoints(
  db: Database,
  limit = 50
): Checkpoint[] {
  const rows = db
    .query(
      "SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit) as Array<{
    id: string;
    session_id: string;
    source: CheckpointSource;
    summary: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    summary: row.summary,
    createdAt: new Date(row.created_at),
  }));
}

export function getLatestCheckpoint(
  db: Database,
  sessionId: string
): Checkpoint | null {
  const row = db
    .query(
      "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(sessionId) as {
    id: string;
    session_id: string;
    source: CheckpointSource;
    summary: string;
    created_at: string;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    summary: row.summary,
    createdAt: new Date(row.created_at),
  };
}
