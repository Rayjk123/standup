import type { Database } from "bun:sqlite";
import { realpathSync } from "fs";
import type { Project } from "@standup/shared";

/**
 * Expands a leading `~` and resolves symlinks to a canonical absolute path.
 *
 * Session cwds and configured repo paths routinely name the same directory
 * through different routes — a repo stored as `~/ax-workplace/...` expands to
 * `/Users/me/ax-workplace/...`, but the OS reports a session's cwd as
 * `/Volumes/ax-workplace/...` when `~/ax-workplace` is a symlink to the
 * volume. A literal string prefix compares those as different trees and drops
 * the session into `scratch`. Canonicalizing both sides first is what makes
 * the match reflect the real filesystem. Falls back to the expanded (but
 * unresolved) path when the target doesn't exist yet, so matching still works
 * for a path that isn't on disk.
 */
function canonicalPath(p: string): string {
  const expanded = p.replace(/^~/, process.env.HOME ?? "");
  try {
    return realpathSync(expanded);
  } catch {
    return expanded;
  }
}

/**
 * True when `target` is `root` or a directory inside it, compared on whole
 * path segments so `/a/foo` does not match `/a/foobar`.
 */
function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return target.startsWith(prefix);
}

export function upsertProject(db: Database, project: Project): void {
  db.run(
    `INSERT INTO projects (id, name, emoji, icon_path, expert, branch, setup, launch_args, repos_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       emoji = excluded.emoji,
       icon_path = excluded.icon_path,
       expert = excluded.expert,
       branch = excluded.branch,
       setup = excluded.setup,
       launch_args = excluded.launch_args,
       repos_json = excluded.repos_json,
       updated_at = datetime('now')`,
    [
      project.id,
      project.name,
      project.emoji ?? null,
      project.iconPath ?? null,
      project.expert ?? null,
      project.branch,
      project.setup ?? null,
      project.launchArgs ?? null,
      JSON.stringify(project.repos),
    ]
  );
}

export function getProjects(db: Database): Project[] {
  const rows = db.query("SELECT * FROM projects ORDER BY name").all() as Array<{
    id: string;
    name: string;
    emoji: string | null;
    icon_path: string | null;
    expert: string | null;
    branch: string;
    setup: string | null;
    launch_args: string | null;
    repos_json: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    emoji: row.emoji ?? undefined,
    iconPath: row.icon_path ?? undefined,
    expert: row.expert ?? undefined,
    branch: row.branch,
    setup: row.setup ?? undefined,
    launchArgs: row.launch_args ?? undefined,
    repos: JSON.parse(row.repos_json),
  }));
}

/**
 * Re-homes `scratch` sessions whose cwd matches a project's repos.
 *
 * Projects are matched at SessionStart, so a session that began before its
 * project existed is stranded in `scratch` forever — which is the normal
 * order of events, since you notice you want a project *because* work is
 * already happening in that directory.
 *
 * Only moves sessions out of `scratch`: a session already attributed to
 * another project stays there, so overlapping repo paths can't silently
 * steal history from one project to another.
 *
 * Returns the ids moved, so the caller can tell the UI what changed.
 */
export function rehomeScratchSessions(db: Database, project: Project): string[] {
  if (project.id === "scratch" || project.repos.length === 0) return [];

  const stranded = db
    .query("SELECT id, cwd FROM sessions WHERE project_id = 'scratch'")
    .all() as Array<{ id: string; cwd: string }>;

  const roots = project.repos.map(canonicalPath);

  const moved: string[] = [];
  for (const session of stranded) {
    const target = canonicalPath(session.cwd);
    const matches = roots.some((root) => isWithin(root, target));
    if (!matches) continue;

    db.run("UPDATE sessions SET project_id = ? WHERE id = ?", [
      project.id,
      session.id,
    ]);
    moved.push(session.id);
  }

  return moved;
}

export function getProject(db: Database, id: string): Project | null {
  return getProjects(db).find((p) => p.id === id) ?? null;
}

/**
 * Removes a project. Sessions that referenced it are reassigned to `scratch`
 * rather than deleted — a project going away shouldn't erase the history of
 * work done under it, and sessions.project_id has a foreign key that would
 * otherwise block the delete.
 */
export function deleteProject(db: Database, id: string): void {
  db.run("UPDATE sessions SET project_id = 'scratch' WHERE project_id = ?", [id]);
  db.run("DELETE FROM projects WHERE id = ?", [id]);
}

export function findProjectByCwd(db: Database, cwd: string): Project | null {
  const projects = getProjects(db);
  const target = canonicalPath(cwd);

  for (const project of projects) {
    for (const repo of project.repos) {
      if (isWithin(canonicalPath(repo), target)) {
        return project;
      }
    }
  }

  return null;
}
