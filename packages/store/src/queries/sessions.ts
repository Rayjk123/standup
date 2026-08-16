import type { Database } from "bun:sqlite";
import type { Session, SessionStatus } from "@standup/shared";

export function createSession(
  db: Database,
  session: Omit<Session, "startedAt" | "endedAt">
): void {
  db.run(
    `INSERT INTO sessions (id, project_id, title, cwd, parent_session_id, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.projectId,
      // Normalize "" to NULL — updateSessionTitle only fires on IS NULL, so
      // an empty string here would permanently block the title from ever
      // being set by the first UserPromptSubmit.
      session.title || null,
      session.cwd,
      session.parentSessionId ?? null,
      session.status,
    ]
  );
}

export function updateSessionStatus(
  db: Database,
  sessionId: string,
  status: SessionStatus
): void {
  db.run("UPDATE sessions SET status = ? WHERE id = ?", [status, sessionId]);
}

export function updateSessionTitle(
  db: Database,
  sessionId: string,
  title: string
): void {
  // Only update if title is not already set
  db.run(
    "UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL",
    [title, sessionId]
  );
}

export function endSession(db: Database, sessionId: string): void {
  db.run(
    "UPDATE sessions SET status = 'idle', ended_at = datetime('now') WHERE id = ?",
    [sessionId]
  );
}

/**
 * Clears ended_at so a session counts as active again.
 *
 * SessionEnd is not always terminal: Claude Code fires it on transitions the
 * session survives (resume, clear), and hooks keep arriving afterward from
 * the same session id. Without this, such a session keeps a stale ended_at
 * while its status goes back to 'running' — invisible to getActiveSessions
 * and therefore missing from the UI entirely, despite being alive.
 */
export function reviveSession(db: Database, sessionId: string): void {
  db.run(
    "UPDATE sessions SET ended_at = NULL WHERE id = ? AND ended_at IS NOT NULL",
    [sessionId]
  );
}

export function getSession(db: Database, sessionId: string): Session | null {
  const row = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId) as {
    id: string;
    project_id: string;
    title: string | null;
    cwd: string;
    parent_session_id: string | null;
    status: SessionStatus;
    started_at: string;
    ended_at: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? "",
    cwd: row.cwd,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
  };
}

export function getSessionsByProject(
  db: Database,
  projectId: string
): Session[] {
  const rows = db
    .query("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC")
    .all(projectId) as Array<{
    id: string;
    project_id: string;
    title: string | null;
    cwd: string;
    parent_session_id: string | null;
    status: SessionStatus;
    started_at: string;
    ended_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? "",
    cwd: row.cwd,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
  }));
}

/**
 * Correlates an MCP tool call back to the session that spawned it. The MCP
 * server subprocess has no reliable session id from Claude Code — it only
 * inherits the process cwd, which is why this is a cwd lookup rather than a
 * direct id lookup. Most-recent-active is a heuristic: two sessions sharing
 * a cwd (two windows on the same repo) will collide onto the newer one.
 */
export function getMostRecentActiveSessionByCwd(
  db: Database,
  cwd: string
): Session | null {
  const row = db
    .query(
      "SELECT * FROM sessions WHERE cwd = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get(cwd) as {
    id: string;
    project_id: string;
    title: string | null;
    cwd: string;
    parent_session_id: string | null;
    status: SessionStatus;
    started_at: string;
    ended_at: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? "",
    cwd: row.cwd,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
  };
}

export function getActiveSessions(db: Database): Session[] {
  const rows = db
    .query(
      "SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC"
    )
    .all() as Array<{
    id: string;
    project_id: string;
    title: string | null;
    cwd: string;
    parent_session_id: string | null;
    status: SessionStatus;
    started_at: string;
    ended_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? "",
    cwd: row.cwd,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    endedAt: undefined,
  }));
}
