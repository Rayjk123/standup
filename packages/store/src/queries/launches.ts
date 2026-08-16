import type { Database } from "bun:sqlite";
import type { Launch, LaunchStatus, LaunchKind } from "@standup/shared";

interface LaunchRow {
  id: string;
  kind: "worktree" | "adopted";
  project_id: string;
  task: string;
  worktree_path: string;
  branch: string;
  base_branch: string | null;
  tmux_session: string | null;
  session_id: string | null;
  status: LaunchStatus;
  error: string | null;
  created_at: string;
}

function toLaunch(row: LaunchRow): Launch {
  return {
    id: row.id,
    kind: row.kind ?? "worktree",
    projectId: row.project_id,
    task: row.task,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch ?? undefined,
    tmuxSession: row.tmux_session ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    createdAt: new Date(row.created_at),
  };
}

export function createLaunch(
  db: Database,
  launch: Omit<Launch, "createdAt" | "status" | "kind"> & {
    status?: LaunchStatus;
    kind?: LaunchKind;
  }
): Launch {
  db.run(
    `INSERT INTO launches
       (id, kind, project_id, task, worktree_path, branch, base_branch, tmux_session, session_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      launch.id,
      launch.kind ?? "worktree",
      launch.projectId,
      launch.task,
      launch.worktreePath,
      launch.branch,
      launch.baseBranch ?? null,
      launch.tmuxSession ?? null,
      launch.sessionId ?? null,
      launch.status ?? "starting",
    ]
  );

  return getLaunch(db, launch.id)!;
}

export function updateLaunchStatus(
  db: Database,
  launchId: string,
  status: LaunchStatus,
  error?: string
): void {
  db.run("UPDATE launches SET status = ?, error = ? WHERE id = ?", [
    status,
    error ?? null,
    launchId,
  ]);
}

export function getLaunch(db: Database, launchId: string): Launch | null {
  const row = db
    .query("SELECT * FROM launches WHERE id = ?")
    .get(launchId) as LaunchRow | null;
  return row ? toLaunch(row) : null;
}

export function getLaunches(db: Database): Launch[] {
  const rows = db
    .query("SELECT * FROM launches ORDER BY created_at DESC")
    .all() as LaunchRow[];
  return rows.map(toLaunch);
}

/**
 * Maps a launched session's cwd back to the project that launched it.
 *
 * A worktree lives outside the project's configured `repos`, so the normal
 * findProjectByCwd path can't match it and the session would land in
 * `scratch` despite being deliberately started for a project.
 */
export function findLaunchByCwd(db: Database, cwd: string): Launch | null {
  const row = db
    .query(
      `SELECT * FROM launches
       WHERE ? = worktree_path OR ? LIKE worktree_path || '/%'
       ORDER BY length(worktree_path) DESC
       LIMIT 1`
    )
    .get(cwd, cwd) as LaunchRow | null;
  return row ? toLaunch(row) : null;
}

/**
 * Whether this session was started by the console rather than by a human in
 * their own terminal. The distinction changes how signals are read: an
 * "agent is waiting for input" notification is routine for a monitored
 * session (you are sitting at that terminal) and means nobody is coming for
 * a launched one.
 */
export function getLaunchBySession(
  db: Database,
  sessionId: string
): Launch | null {
  const row = db
    .query("SELECT * FROM launches WHERE session_id = ? LIMIT 1")
    .get(sessionId) as LaunchRow | null;
  return row ? toLaunch(row) : null;
}

export function isLaunchedSession(db: Database, sessionId: string): boolean {
  const row = db
    .query("SELECT 1 AS found FROM launches WHERE session_id = ? LIMIT 1")
    .get(sessionId) as { found: number } | null;
  return row !== null;
}

/** Links a launch to the Claude Code session that reported in from it. */
export function attachSessionToLaunch(
  db: Database,
  launchId: string,
  sessionId: string
): void {
  db.run(
    "UPDATE launches SET session_id = ?, status = 'running' WHERE id = ?",
    [sessionId, launchId]
  );
}
