import type { Database } from "bun:sqlite";
import type { Project } from "@standup/shared";

export function upsertProject(db: Database, project: Project): void {
  db.run(
    `INSERT INTO projects (id, name, emoji, icon_path, expert, branch, repos_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       emoji = excluded.emoji,
       icon_path = excluded.icon_path,
       expert = excluded.expert,
       branch = excluded.branch,
       repos_json = excluded.repos_json,
       updated_at = datetime('now')`,
    [
      project.id,
      project.name,
      project.emoji ?? null,
      project.iconPath ?? null,
      project.expert ?? null,
      project.branch,
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
    repos_json: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    emoji: row.emoji ?? undefined,
    iconPath: row.icon_path ?? undefined,
    expert: row.expert ?? undefined,
    branch: row.branch,
    repos: JSON.parse(row.repos_json),
  }));
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
