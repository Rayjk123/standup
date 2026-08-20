import type { Database } from "bun:sqlite";
import type { Launch, LaunchStatus, LaunchKind, LaunchPhase } from "@standup/shared";
import { canonicalPath, isWithin } from "./projects.js";

/**
 * Tail cap for a launch's streamed provision/build log. Build output can run
 * to megabytes; only the tail is useful for "what is it doing right now", and
 * an unbounded column would bloat the row and every launch broadcast.
 */
const LAUNCH_LOG_CAP = 100_000;

interface LaunchRow {
  id: string;
  kind: "worktree" | "adopted" | "bootstrap";
  project_id: string;
  task: string;
  worktree_path: string;
  branch: string;
  base_branch: string | null;
  tmux_session: string | null;
  session_id: string | null;
  status: LaunchStatus;
  error: string | null;
  model: string | null;
  effort: string | null;
  provisioned: number | null;
  phase: string | null;
  log: string | null;
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
    model: (row.model as Launch["model"]) ?? undefined,
    effort: (row.effort as Launch["effort"]) ?? undefined,
    provisioned: row.provisioned === 1,
    phase: (row.phase as LaunchPhase | null) ?? undefined,
    log: row.log ?? undefined,
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
       (id, kind, project_id, task, worktree_path, branch, base_branch, tmux_session, session_id, status, model, effort, provisioned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      launch.model ?? null,
      launch.effort ?? null,
      launch.provisioned ? 1 : 0,
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
  // Clear phase on any terminal transition — it only describes an in-flight
  // "starting" launch, and a stale phase on a running row would mislabel it.
  db.run("UPDATE launches SET status = ?, error = ?, phase = NULL WHERE id = ?", [
    status,
    error ?? null,
    launchId,
  ]);
}

/** Records which slow step a still-"starting" launch is currently in. */
export function setLaunchPhase(
  db: Database,
  launchId: string,
  phase: LaunchPhase
): void {
  db.run("UPDATE launches SET phase = ? WHERE id = ?", [phase, launchId]);
}

/**
 * Appends streamed provision/build output to a launch's log, keeping only the
 * last LAUNCH_LOG_CAP characters so a noisy build can't bloat the row.
 */
export function appendLaunchLog(
  db: Database,
  launchId: string,
  chunk: string
): void {
  db.run(
    `UPDATE launches
       SET log = substr(COALESCE(log, '') || ?, -${LAUNCH_LOG_CAP})
     WHERE id = ?`,
    [chunk, launchId]
  );
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
 *
 * Only matches a launch that's still unclaimed (never attached to a session)
 * or whose attached session is still live. Once that session has ended, the
 * launch is spent — its task/project already flowed into that session's row,
 * and matching it again would silently hand a brand-new, unrelated session
 * the old one's title and steal the launch out from under it via
 * attachSessionToLaunch. This matters most for an *adopted* launch, whose
 * `worktree_path` is the session's original cwd rather than a fresh, unique
 * worktree (see launcher.ts's adopt path) — for a bare repo directory that
 * path is shared by every plain session anyone starts there afterward.
 * `status != 'cleaned'` additionally excludes a launch whose worktree has
 * since been removed.
 *
 * Paths are canonicalized (realpath, `~` expanded) on both sides before
 * comparing — exactly as findProjectByCwd does. A launch's worktree_path is
 * stored from the configured worktree root (e.g. `~/workplace/...`) while a
 * session's cwd is reported by the OS as the resolved realpath (e.g.
 * `/Volumes/workplace/...` when that root is a symlinked mount). A literal
 * string compare treats those as different trees, so the SessionStart hook
 * never attaches and the launch is stranded sessionless, rendering forever as
 * "provisioning workspace…". Canonicalizing is what makes the match reflect
 * the real filesystem. The match runs in JS because each row's stored path
 * must be resolved individually.
 */
export function findLaunchByCwd(db: Database, cwd: string): Launch | null {
  const rows = db
    .query(
      `SELECT l.* FROM launches l
       LEFT JOIN sessions s ON s.id = l.session_id
       WHERE l.status != 'cleaned'
         AND (l.session_id IS NULL OR s.ended_at IS NULL)`
    )
    .all() as LaunchRow[];

  const target = canonicalPath(cwd);
  const match = rows
    .filter((row) => isWithin(canonicalPath(row.worktree_path), target))
    // Deepest worktree_path wins (a nested launch beats an ancestor), then
    // most recent — mirrors the old SQL ORDER BY.
    .sort((a, b) => {
      const byDepth = b.worktree_path.length - a.worktree_path.length;
      if (byDepth !== 0) return byDepth;
      return b.created_at.localeCompare(a.created_at);
    })[0];

  return match ? toLaunch(match) : null;
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
