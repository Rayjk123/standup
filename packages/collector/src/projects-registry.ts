import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import type { Database } from "bun:sqlite";
import { upsertProject, getProject, getProjects } from "@standup/store";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import type { Project, ProjectConfig } from "@standup/shared";

/** The fallback project a session lands in when no registered project matches it. */
export const SCRATCH_PROJECT_ID = "scratch";

/**
 * The reserved self-fix project propose_standup_improvement launches into (see
 * the collector's ensureStandupSelfProject), and the project whose knowledge
 * its corpus copies.
 */
export const STANDUP_SELF_PROJECT_ID = "standup-self";
export const STANDUP_PROJECT_ID = "standup";

/**
 * Reserved mirror project → the canonical project it copies. Knowledge search
 * reads a mirror as an alias of its canonical project (SearchOptions
 * mirrorProjects): a mirror copy of a canonical doc collapses onto it.
 */
export const MIRROR_PROJECTS: Readonly<Record<string, string>> = {
  [STANDUP_SELF_PROJECT_ID]: STANDUP_PROJECT_ID,
};

const DEFAULT_SCRATCH: Project = {
  id: SCRATCH_PROJECT_ID,
  name: "scratch",
  emoji: "🦑",
  repos: [],
  branch: "main",
};

// The reserved GLOBAL knowledge corpus: generic best-practices / general notes
// not tied to any repo. `reserved` hides it from the launchable-project UI (it
// has no repo to launch against), while corpus:"all" search and launch-time
// injection span it like any other registered project — so one doc here reaches
// every session. Auto-ensured on boot so it always exists as a propose target
// and a search source. Its corpus dir is created lazily on first write (the
// loader treats a missing dir as empty), so nothing to mkdir here.
const DEFAULT_GLOBAL: Project = {
  id: GLOBAL_PROJECT_ID,
  name: "Global — best practices",
  emoji: "🌐",
  repos: [],
  branch: "main",
  reserved: true,
};

/** A TOML entry's `related` kept only as a list of non-empty, trimmed ids. */
function normalizedRelated(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/**
 * The ids of the projects related to `projectId` among `allProjects`, sorted.
 * Two projects are related when either lists the other under `related`
 * (symmetric, so one side suffices) or when their ids form a prefix family —
 * one id is the other's followed by `-` and more (`policy` and
 * `policy-control-plane`). Never the project itself, `scratch`, or a reserved
 * project (the global corpus, the self-fix `standup-self` copy): those hold
 * knowledge every session already sees, or a corpus kept apart on purpose —
 * `standup-self` would otherwise join `standup`'s prefix family.
 */
export function relatedProjects(
  projectId: string,
  allProjects: readonly Pick<Project, "id" | "related" | "reserved">[]
): string[] {
  const self = allProjects.find((p) => p.id === projectId);
  if (projectId === SCRATCH_PROJECT_ID || projectId === GLOBAL_PROJECT_ID || self?.reserved) return [];
  const excluded = new Set([projectId, SCRATCH_PROJECT_ID, GLOBAL_PROJECT_ID]);
  const listed = new Set(self?.related ?? []);
  const related = new Set<string>();
  for (const other of allProjects) {
    if (excluded.has(other.id) || other.reserved) continue;
    const prefixFamily = other.id.startsWith(`${projectId}-`) || projectId.startsWith(`${other.id}-`);
    if (prefixFamily || listed.has(other.id) || (other.related ?? []).includes(projectId)) {
      related.add(other.id);
    }
  }
  return [...related].sort();
}

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

  /** The TOML's projects. */
  private async readToml(): Promise<Project[]> {
    if (!existsSync(this.tomlPath)) return [];
    const content = await readFile(this.tomlPath, "utf-8");
    const parsed = parseToml(content) as unknown as ProjectConfig;
    return (parsed.project ?? []).map((p) => ({ ...p, related: normalizedRelated(p.related) }));
  }

  private ensureScratch(): void {
    const existing = getProjects(this.db);
    if (!existing.some((p) => p.id === SCRATCH_PROJECT_ID)) {
      upsertProject(this.db, DEFAULT_SCRATCH);
    }
  }

  /**
   * Ensures the reserved GLOBAL corpus exists. Re-upserts DEFAULT_GLOBAL every
   * boot so the `reserved` flag can't be lost — TOML seeding a `global` id, or a
   * row that predates the reserved column, would otherwise leave it launchable
   * and cluttering the picker. Its knowledge (accepted docs / drafts) lives in
   * the corpus dir, untouched by this metadata upsert.
   */
  private ensureGlobal(): void {
    upsertProject(this.db, DEFAULT_GLOBAL);
  }

  /**
   * Called once at startup. Seeds from TOML only if no projects exist yet —
   * an established database is left alone.
   */
  async bootstrap(): Promise<Project[]> {
    const existing = getProjects(this.db);
    // The reserved projects (scratch, global) are auto-ensured, so their
    // presence must not count as "already configured" — otherwise a DB holding
    // only reserved rows would suppress the first TOML seed.
    const userDefined = existing.filter(
      (p) => p.id !== SCRATCH_PROJECT_ID && p.id !== GLOBAL_PROJECT_ID
    );

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
    this.ensureGlobal();
    return getProjects(this.db);
  }

  /**
   * Explicit re-import. For a project already in the DB, only the fields the
   * TOML entry sets are overwritten; settings it omits (setup, provision,
   * launch args, icon, review config, …) keep their stored values, so a
   * minimal TOML entry can't wipe what was configured in the console.
   */
  async importFromToml(): Promise<{ imported: number; path: string }> {
    const fromToml = await this.readToml();
    for (const project of fromToml) {
      const existing = getProject(this.db, project.id);
      const present = Object.fromEntries(
        Object.entries(project).filter(([, v]) => v !== undefined)
      ) as Partial<Project>;
      upsertProject(this.db, existing ? { ...existing, ...present } : project);
    }
    this.ensureScratch();
    this.ensureGlobal();
    return { imported: fromToml.length, path: this.tomlPath };
  }

  /** Serializes current DB projects back to TOML, for dotfile portability. */
  exportToToml(): string {
    const projects = getProjects(this.db).filter(
      (p) => p.id !== SCRATCH_PROJECT_ID && p.id !== GLOBAL_PROJECT_ID
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
        lines.push(`branch  = ${JSON.stringify(p.branch)}`);
        if (p.launchArgs)
          lines.push(`launchArgs = ${JSON.stringify(p.launchArgs)}`);
        if (p.worktreeRoot)
          lines.push(`worktreeRoot = ${JSON.stringify(p.worktreeRoot)}`);
        if (p.provision)
          lines.push(`provision = ${JSON.stringify(p.provision)}`);
        if (p.launchSubdir)
          lines.push(`launchSubdir = ${JSON.stringify(p.launchSubdir)}`);
        if (p.inPlace)
          lines.push(`inPlace = ${JSON.stringify(p.inPlace)}`);
        if (p.reviewProcess)
          lines.push(`reviewProcess = ${JSON.stringify(p.reviewProcess)}`);
        if (p.reviewCommand)
          lines.push(`reviewCommand = ${JSON.stringify(p.reviewCommand)}`);
        if (p.codeReviewAdapter)
          lines.push(`codeReviewAdapter = ${JSON.stringify(p.codeReviewAdapter)}`);
        if (p.dailyReviewActive !== undefined)
          lines.push(`dailyReviewActive = ${JSON.stringify(p.dailyReviewActive)}`);
        if (p.reviewLenses)
          lines.push(
            `reviewLenses = [${p.reviewLenses.map((l) => JSON.stringify(l)).join(", ")}]`
          );
        if (p.planGate)
          lines.push(`planGate = ${JSON.stringify(p.planGate)}`);
        // Bypass is the default, so only an opt-out is written; a seeded or
        // imported project without the key bypasses.
        if (p.bypassPermissions === false)
          lines.push(`bypassPermissions = false`);
        if (p.harness)
          lines.push(`harness = ${JSON.stringify(p.harness)}`);
        if (p.related && p.related.length > 0)
          lines.push(
            `related = [${p.related.map((r) => JSON.stringify(r)).join(", ")}]`
          );
        return lines.join("\n");
      })
      .join("\n\n");
  }
}
