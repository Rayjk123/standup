import type { Database } from "bun:sqlite";
import { readFile } from "fs/promises";

export interface Project {
  id: string;
  name: string;
  repos: string[];
}

/**
 * The `projects` table is the source of truth for the project registry.
 * projects.toml is read once by importProjectsToml (first boot, or an explicit
 * import from the console); nothing watches the file afterwards, so edits to it
 * have no effect until it is imported again.
 */
export function loadProjects(db: Database): Project[] {
  const rows = db.query(`SELECT id, name, repos_json FROM projects ORDER BY name`).all() as {
    id: string;
    name: string;
    repos_json: string;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, repos: JSON.parse(r.repos_json) }));
}

export async function importProjectsToml(db: Database, path: string): Promise<number> {
  const text = await readFile(path, "utf-8");
  const projects = parseProjectsToml(text);
  const insert = db.query(
    `INSERT INTO projects (id, name, repos_json) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, repos_json = excluded.repos_json`
  );
  for (const p of projects) insert.run(p.id, p.name, JSON.stringify(p.repos));
  return projects.length;
}

function parseProjectsToml(text: string): Project[] {
  const out: Project[] = [];
  let cur: Project | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "[[project]]") {
      cur = { id: "", name: "", repos: [] };
      out.push(cur);
    } else if (cur) {
      const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      const value = JSON.parse(m[2]);
      if (m[1] === "id") cur.id = value;
      if (m[1] === "name") cur.name = value;
      if (m[1] === "repos") cur.repos = value;
    }
  }
  return out;
}
