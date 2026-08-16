import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import type { Database } from "bun:sqlite";
import { upsertProject, getProjects } from "@standup/store";
import type { Project, ProjectConfig } from "@standup/shared";

const SCRATCH_PROJECT_ID = "scratch";

const DEFAULT_SCRATCH: Project = {
  id: SCRATCH_PROJECT_ID,
  name: "scratch",
  emoji: "🦑",
  repos: [],
  branch: "main",
};

export function defaultProjectsPath(): string {
  return (
    process.env.STANDUP_PROJECTS_PATH ??
    join(homedir(), ".config", "standup", "projects.toml")
  );
}

/**
 * SQLite is the source of truth for projects; this class only bootstraps and
 * imports.
 *
 * The design originally specified projects.toml as authoritative, for
 * dotfile portability. That fights in-app editing: a continuous
 * TOML->DB overwrite silently discards anything changed through the UI. So
 * TOML is now a *seed and explicit import* path instead —
 *
 *   - `bootstrap()` seeds from TOML only when the projects table is empty,
 *     so a fresh machine with dotfiles still comes up configured.
 *   - `importFromToml()` is an explicit, user-triggered overwrite.
 *   - Nothing watches the file anymore; watching implied authority the file
 *     no longer has.
 *
 * `scratch` is always ensured, since unmatched sessions land there and must
 * never be dropped.
 */
export class ProjectsRegistry {
  constructor(
    private db: Database,
    private tomlPath: string
  ) {}

  private async readToml(): Promise<Project[]> {
    if (!existsSync(this.tomlPath)) return [];
    const content = await readFile(this.tomlPath, "utf-8");
    const parsed = parseToml(content) as unknown as ProjectConfig;
    return parsed.project ?? [];
  }

  private ensureScratch(): void {
    const existing = getProjects(this.db);
    if (!existing.some((p) => p.id === SCRATCH_PROJECT_ID)) {
      upsertProject(this.db, DEFAULT_SCRATCH);
    }
  }

  /**
   * Called once at startup. Seeds from TOML only if no projects exist yet —
   * an established database is left alone.
   */
  async bootstrap(): Promise<Project[]> {
    const existing = getProjects(this.db);
    const userDefined = existing.filter((p) => p.id !== SCRATCH_PROJECT_ID);

    if (userDefined.length === 0) {
      const fromToml = await this.readToml();
      for (const project of fromToml) {
        upsertProject(this.db, project);
      }
      if (fromToml.length > 0) {
        console.log(
          `[registry] Seeded ${fromToml.length} project(s) from ${this.tomlPath}`
        );
      }
    }

    this.ensureScratch();
    return getProjects(this.db);
  }

  /** Explicit re-import; overwrites DB rows that share an id with the file. */
  async importFromToml(): Promise<{ imported: number; path: string }> {
    const fromToml = await this.readToml();
    for (const project of fromToml) {
      upsertProject(this.db, project);
    }
    this.ensureScratch();
    return { imported: fromToml.length, path: this.tomlPath };
  }

  /** Serializes current DB projects back to TOML, for dotfile portability. */
  exportToToml(): string {
    const projects = getProjects(this.db).filter(
      (p) => p.id !== SCRATCH_PROJECT_ID
    );

    return projects
      .map((p) => {
        const lines = [
          "[[project]]",
          `id      = ${JSON.stringify(p.id)}`,
          `name    = ${JSON.stringify(p.name)}`,
        ];
        if (p.emoji) lines.push(`emoji   = ${JSON.stringify(p.emoji)}`);
        lines.push(
          `repos   = [${p.repos.map((r) => JSON.stringify(r)).join(", ")}]`
        );
        if (p.setup) lines.push(`setup   = ${JSON.stringify(p.setup)}`);
        if (p.expert) lines.push(`expert  = ${JSON.stringify(p.expert)}`);
        lines.push(`branch  = ${JSON.stringify(p.branch)}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }
}
