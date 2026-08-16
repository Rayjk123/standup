import type { Database } from "bun:sqlite";
import type { Project } from "@standup/shared";

export function upsertProject(db: Database, project: Project): void {
  db.run(
    `INSERT INTO projects (id, name, emoji, icon_path, expert, branch, setup, repos_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       emoji = excluded.emoji,
       icon_path = excluded.icon_path,
       expert = excluded.expert,
       branch = excluded.branch,
       setup = excluded.setup,
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

  const home = process.env.HOME ?? "";
  const roots = project.repos.map((r) => r.replace(/^~/, home));

  const moved: string[] = [];
  for (const session of stranded) {
    const matches = roots.some(
      (root) => session.cwd === root || session.cwd.startsWith(`${root}/`)
    );
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

  for (const project of projects) {
    for (const repo of project.repos) {
      // Expand ~ to home directory
      const expandedRepo = repo.replace(/^~/, process.env.HOME ?? "");
      if (cwd.startsWith(expandedRepo)) {
        return project;
      }
    }
  }

  return null;
}
