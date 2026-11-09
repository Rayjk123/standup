import type { Database } from "bun:sqlite";
import { realpathSync } from "fs";
import type {
  HarnessId,
  Project,
  ReviewProcess,
  CodeReviewAdapterId,
} from "@standup/shared";
import { CODE_REVIEW_ADAPTER_IDS, GLOBAL_PROJECT_ID } from "@standup/shared";
import { getSetting } from "./settings.js";

/**
 * Expands a leading `~` and resolves symlinks to a canonical absolute path.
 *
 * Session cwds and configured repo paths routinely name the same directory
 * through different routes — a repo stored as `~/code/...` expands to
 * `/Users/me/code/...`, but the OS reports a session's cwd as
 * `/Volumes/code/...` when `~/code` is a symlink to the
 * volume. A literal string prefix compares those as different trees and drops
 * the session into `scratch`. Canonicalizing both sides first is what makes
 * the match reflect the real filesystem. Falls back to the expanded (but
 * unresolved) path when the target doesn't exist yet, so matching still works
 * for a path that isn't on disk.
 */
export function canonicalPath(p: string): string {
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
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return target.startsWith(prefix);
}

export function upsertProject(db: Database, project: Project): void {
  db.run(
    `INSERT INTO projects (id, name, emoji, icon_path, branch, setup, launch_args, worktree_root, provision, launch_subdir, in_place, review_process, review_command, review_artifact_provider, daily_review_active, review_lenses, plan_gate, bypass_permissions, reserved, harness, knowledge_scope, related_json, repos_json, shareable, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       emoji = excluded.emoji,
       icon_path = excluded.icon_path,
       branch = excluded.branch,
       setup = excluded.setup,
       launch_args = excluded.launch_args,
       worktree_root = excluded.worktree_root,
       provision = excluded.provision,
       launch_subdir = excluded.launch_subdir,
       in_place = excluded.in_place,
       review_process = excluded.review_process,
       review_command = excluded.review_command,
       review_artifact_provider = excluded.review_artifact_provider,
       daily_review_active = excluded.daily_review_active,
       review_lenses = excluded.review_lenses,
       plan_gate = excluded.plan_gate,
       bypass_permissions = excluded.bypass_permissions,
       reserved = excluded.reserved,
       harness = excluded.harness,
       knowledge_scope = excluded.knowledge_scope,
       related_json = excluded.related_json,
       repos_json = excluded.repos_json,
       updated_at = datetime('now')`,
    [
      project.id,
      project.name,
      project.emoji ?? null,
      project.iconPath ?? null,
      project.branch,
      project.setup ?? null,
      project.launchArgs ?? null,
      project.worktreeRoot ?? null,
      project.provision ?? null,
      project.launchSubdir ?? null,
      project.inPlace ? 1 : 0,
      project.reviewProcess ?? null,
      project.reviewCommand ?? null,
      project.codeReviewAdapter ?? null,
      project.dailyReviewActive ? 1 : 0,
      project.reviewLenses ? JSON.stringify(project.reviewLenses) : null,
      project.planGate ? 1 : 0,
      // Unset means bypass (the default); only an explicit false opts out.
      project.bypassPermissions === false ? 0 : 1,
      project.reserved ? 1 : 0,
      project.harness ?? null,
      project.knowledgeScope ?? null,
      project.related && project.related.length > 0 ? JSON.stringify(project.related) : null,
      JSON.stringify(project.repos),
      // Only a new row takes it; ON CONFLICT leaves the stored value alone.
      project.shareable === false ? 0 : 1,
    ]
  );
}

/**
 * Sets whether a project's knowledge is served by the public knowledge API.
 * The only writer of an existing row's `shareable`: upsertProject leaves it
 * alone, so a registry re-seed or an unrelated project edit never re-shares a
 * project the owner withheld.
 */
export function setProjectShareable(db: Database, id: string, shareable: boolean): void {
  db.run("UPDATE projects SET shareable = ?, updated_at = datetime('now') WHERE id = ?", [shareable ? 1 : 0, id]);
}

export function getProjects(db: Database): Project[] {
  const rows = db.query("SELECT * FROM projects ORDER BY name").all() as Array<{
    id: string;
    name: string;
    emoji: string | null;
    icon_path: string | null;
    branch: string;
    setup: string | null;
    launch_args: string | null;
    worktree_root: string | null;
    provision: string | null;
    launch_subdir: string | null;
    in_place: number | null;
    review_process: string | null;
    review_command: string | null;
    review_artifact_provider: string | null;
    daily_review_active: number | null;
    review_lenses: string | null;
    plan_gate: number | null;
    bypass_permissions: number | null;
    reserved: number | null;
    harness: string | null;
    knowledge_scope: string | null;
    related_json: string | null;
    repos_json: string;
    shareable: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    emoji: row.emoji ?? undefined,
    iconPath: row.icon_path ?? undefined,
    branch: row.branch,
    setup: row.setup ?? undefined,
    launchArgs: row.launch_args ?? undefined,
    worktreeRoot: row.worktree_root ?? undefined,
    provision: row.provision ?? undefined,
    launchSubdir: row.launch_subdir ?? undefined,
    inPlace: row.in_place === 1,
    reviewProcess: (row.review_process as ReviewProcess) ?? undefined,
    reviewCommand: row.review_command ?? undefined,
    // An id no built-in adapter has reads as unset (auto-detect).
    codeReviewAdapter: (CODE_REVIEW_ADAPTER_IDS as readonly string[]).includes(row.review_artifact_provider ?? "")
      ? (row.review_artifact_provider as CodeReviewAdapterId)
      : undefined,
    dailyReviewActive: row.daily_review_active === 1,
    reviewLenses: row.review_lenses ? JSON.parse(row.review_lenses) : undefined,
    planGate: row.plan_gate === 1,
    // Only a stored 0 opts out; NULL (a row written before the column) bypasses.
    bypassPermissions: row.bypass_permissions !== 0,
    reserved: row.reserved === 1,
    harness: (row.harness as HarnessId | null) ?? undefined,
    // Only the two project-level defaults are valid here; a stray value (a
    // legacy or hand-edited row) reads as no override rather than a bogus scope.
    knowledgeScope:
      row.knowledge_scope === "global" || row.knowledge_scope === "project"
        ? row.knowledge_scope
        : undefined,
    related: parseRelated(row.related_json),
    repos: JSON.parse(row.repos_json),
    // Only a stored 0 withholds; NULL (a row written before the column) shares.
    shareable: row.shareable !== 0,
  }));
}

/** The stored related-project ids, or undefined when none (or the value is not a string array). */
function parseRelated(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
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

/** The settings k/v key holding the account-wide default knowledge scope. */
export const KNOWLEDGE_DEFAULT_SCOPE_KEY = "knowledge.default_scope";

/**
 * The default SCOPE a doc authored under `projectId` takes when it asserts none,
 * resolved by precedence: the project's own `knowledge_scope` override wins, else
 * the account-wide `knowledge.default_scope` setting, else 'project' — the scope
 * every doc predating the scope dimension already had. Only 'global' and
 * 'project' are project-level defaults, so a stored value outside that set (a
 * legacy or hand-edited row/setting) is skipped in favor of the next layer rather
 * than surfaced as a bogus default. Callers pass the result to
 * resolveAuthoredScope as the requested scope when the author supplied none; an
 * explicit per-doc scope always takes precedence over this default.
 *
 * A doc authored under the reserved GLOBAL corpus defaults to 'global' (matching
 * the loader's global-home inference) unless the project carries an explicit
 * override — the reserved project exists to reach every session, so its docs are
 * global by default rather than falling to the account setting/'project'.
 */
export function getKnowledgeDefaultScope(
  db: Database,
  projectId: string
): "global" | "project" {
  const fromProject = getProject(db, projectId)?.knowledgeScope;
  if (fromProject === "global" || fromProject === "project") return fromProject;
  if (projectId === GLOBAL_PROJECT_ID) return "global";
  const fromSetting = getSetting(db, KNOWLEDGE_DEFAULT_SCOPE_KEY);
  if (fromSetting === "global" || fromSetting === "project") return fromSetting;
  return "project";
}

/**
 * Removes a project. Sessions that referenced it are reassigned to `scratch`
 * rather than deleted — a project going away shouldn't erase the history of
 * work done under it, and sessions.project_id has a foreign key that would
 * otherwise block the delete.
 *
 * Per-user, per-project overlays (`user_project_prefs`) are dropped outright —
 * an overlay is config FOR this specific project, meaningless once it's gone,
 * and its FK on project_id would otherwise block the delete.
 */
export function deleteProject(db: Database, id: string): void {
  db.run("UPDATE sessions SET project_id = 'scratch' WHERE project_id = ?", [id]);
  db.run("DELETE FROM user_project_prefs WHERE project_id = ?", [id]);
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
