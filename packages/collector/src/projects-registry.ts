import { readFile, watch } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import type { Database } from "bun:sqlite";
import { upsertProject } from "@standup/store";
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
 * Loads projects.toml into the store and keeps it in sync as the file
 * changes. Sessions map to projects by cwd (see findProjectByCwd); this
 * registry is what makes that lookup possible, and its "scratch" fallback is
 * what keeps unmatched sessions visible instead of dropped.
 */
export class ProjectsRegistry {
  constructor(
    private db: Database,
    private tomlPath: string
  ) {}

  async load(): Promise<Project[]> {
    let projects: Project[] = [];

    if (existsSync(this.tomlPath)) {
      const content = await readFile(this.tomlPath, "utf-8");
      const parsed = parseToml(content) as unknown as ProjectConfig;
      projects = parsed.project ?? [];
    } else {
      console.warn(
        `[registry] No projects.toml found at ${this.tomlPath} — only "scratch" will be available. ` +
          `See config/projects.example.toml.`
      );
    }

    if (!projects.some((p) => p.id === SCRATCH_PROJECT_ID)) {
      projects.push(DEFAULT_SCRATCH);
    }

    for (const project of projects) {
      upsertProject(this.db, project);
    }

    return projects;
  }

  /**
   * Watches the TOML file and reloads on change. No-op if the file doesn't
   * exist yet — nothing to watch, and the scratch fallback already covers
   * that case from `load()`.
   */
  async startWatching(onChange: (projects: Project[]) => void): Promise<void> {
    if (!existsSync(this.tomlPath)) return;

    try {
      const watcher = watch(this.tomlPath);
      for await (const event of watcher) {
        void event; // any change to the file triggers a full reload
        try {
          const projects = await this.load();
          onChange(projects);
        } catch (err) {
          console.error("[registry] Failed to reload projects.toml:", err);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
