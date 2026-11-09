import type { Database } from "bun:sqlite";
import type { DeployTarget, UserPrefs } from "@standup/shared";

/**
 * Per-user profile — "a CLAUDE.md for each user", keyed by SSO alias. See
 * migration 023. Written rarely (a settings save) and read at launch time to
 * personalize the opening prompt.
 */

interface UserPrefsRow {
  alias: string;
  personal_instructions: string | null;
  review_rigor: string | null;
  deploy_target_json: string | null;
  updated_at: string;
}

/**
 * True when a deploy target carries no field — an all-empty object round-trips
 * to `undefined` so callers see "unset", never a hollow `{}` that reads as
 * configured.
 */
function isEmptyTarget(t: DeployTarget | undefined): boolean {
  return !t || (!t.account?.trim() && !t.role?.trim() && !t.command?.trim());
}

function parseDeployTarget(json: string | null): DeployTarget | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as DeployTarget;
    return isEmptyTarget(parsed) ? undefined : parsed;
  } catch {
    // A corrupt blob reads as "no deploy target" rather than throwing on a
    // read that has to stay cheap and infallible at launch time.
    return undefined;
  }
}

function toUserPrefs(row: UserPrefsRow): UserPrefs {
  return {
    alias: row.alias,
    personalInstructions: row.personal_instructions ?? undefined,
    reviewRigor: row.review_rigor ?? undefined,
    deployTarget: parseDeployTarget(row.deploy_target_json),
    updatedAt: new Date(row.updated_at),
  };
}

/** The prefs for `alias`, or null when the user has never saved a profile. */
export function getUserPrefs(db: Database, alias: string): UserPrefs | null {
  const row = db
    .query("SELECT * FROM user_prefs WHERE alias = ?")
    .get(alias) as UserPrefsRow | null;
  return row ? toUserPrefs(row) : null;
}

/** The editable fields of a profile — everything but the alias and timestamp. */
export interface UserPrefsInput {
  personalInstructions?: string;
  reviewRigor?: string;
  deployTarget?: DeployTarget;
}

/**
 * Upserts the whole profile for `alias` — a PUT, not a patch: an omitted field
 * clears it, so the settings form is the single source of the stored value.
 * Blank strings and an all-empty deploy target normalize to NULL so a read
 * never resurrects an empty value as if it were set. Returns the stored row.
 */
export function putUserPrefs(
  db: Database,
  alias: string,
  input: UserPrefsInput
): UserPrefs {
  const deployJson = isEmptyTarget(input.deployTarget)
    ? null
    : JSON.stringify(input.deployTarget);
  db.run(
    `INSERT INTO user_prefs (alias, personal_instructions, review_rigor, deploy_target_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(alias) DO UPDATE SET
         personal_instructions = excluded.personal_instructions,
         review_rigor = excluded.review_rigor,
         deploy_target_json = excluded.deploy_target_json,
         updated_at = datetime('now')`,
    [
      alias,
      input.personalInstructions?.trim() || null,
      input.reviewRigor?.trim() || null,
      deployJson,
    ]
  );
  return getUserPrefs(db, alias)!;
}

// ============================================================================
// Per-user, per-project overlay — see migration 026. The overlay layers on
// top of the global profile above, mirroring CLAUDE.md's global + per-project
// layering. Same three fields; getEffectiveUserPrefs merges the two for a launch.
// ============================================================================

interface UserProjectPrefsRow {
  alias: string;
  project_id: string;
  personal_instructions: string | null;
  review_rigor: string | null;
  deploy_target_json: string | null;
  updated_at: string;
}

function toUserProjectPrefs(row: UserProjectPrefsRow): UserPrefs {
  return {
    alias: row.alias,
    projectId: row.project_id,
    personalInstructions: row.personal_instructions ?? undefined,
    reviewRigor: row.review_rigor ?? undefined,
    deployTarget: parseDeployTarget(row.deploy_target_json),
    updatedAt: new Date(row.updated_at),
  };
}

/** A user's overlay for one project, or null when they've saved none there. */
export function getUserProjectPrefs(
  db: Database,
  alias: string,
  projectId: string
): UserPrefs | null {
  const row = db
    .query("SELECT * FROM user_project_prefs WHERE alias = ? AND project_id = ?")
    .get(alias, projectId) as UserProjectPrefsRow | null;
  return row ? toUserProjectPrefs(row) : null;
}

/**
 * Upserts a user's overlay for one project — a full replace like putUserPrefs:
 * an omitted field clears it, blank strings and an all-empty deploy target
 * normalize to NULL. Returns the stored overlay.
 */
export function putUserProjectPrefs(
  db: Database,
  alias: string,
  projectId: string,
  input: UserPrefsInput
): UserPrefs {
  const deployJson = isEmptyTarget(input.deployTarget)
    ? null
    : JSON.stringify(input.deployTarget);
  db.run(
    `INSERT INTO user_project_prefs (alias, project_id, personal_instructions, review_rigor, deploy_target_json, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(alias, project_id) DO UPDATE SET
         personal_instructions = excluded.personal_instructions,
         review_rigor = excluded.review_rigor,
         deploy_target_json = excluded.deploy_target_json,
         updated_at = datetime('now')`,
    [
      alias,
      projectId,
      input.personalInstructions?.trim() || null,
      input.reviewRigor?.trim() || null,
      deployJson,
    ]
  );
  return getUserProjectPrefs(db, alias, projectId)!;
}

/**
 * Merges a user's GLOBAL profile with their per-project overlay into
 * the effective profile for a launch in that project, mirroring the CLAUDE.md
 * layering the overlay imitates:
 *  - `personalInstructions`: BOTH apply — global first, then the project text,
 *    so the project instructions REFINE (not replace) the standing ones.
 *  - `reviewRigor` / `deployTarget`: the project value OVERRIDES the global when
 *    the overlay sets it, else the global applies. A structured field is one
 *    choice ("this project deploys to that stack"), not additive prose.
 *
 * Returns null when neither layer exists, so a user with no profile at all
 * still injects nothing. The merged `alias` is the user's; `projectId` marks it
 * as the project-scoped effective view. Pure, so the precedence is unit-testable
 * without a live launch.
 */
export function mergeUserPrefs(
  global: UserPrefs | null,
  project: UserPrefs | null
): UserPrefs | null {
  if (!global && !project) return null;

  const layered = [global?.personalInstructions?.trim(), project?.personalInstructions?.trim()]
    .filter((s): s is string => !!s)
    .join("\n\n");

  const projectTarget = project?.deployTarget;
  const deployTarget = !isEmptyTarget(projectTarget)
    ? projectTarget
    : !isEmptyTarget(global?.deployTarget)
      ? global?.deployTarget
      : undefined;

  return {
    alias: (project ?? global)!.alias,
    projectId: project?.projectId,
    personalInstructions: layered || undefined,
    reviewRigor: project?.reviewRigor?.trim() || global?.reviewRigor?.trim() || undefined,
    deployTarget,
    updatedAt: (project ?? global)!.updatedAt,
  };
}

/**
 * The effective profile for a launch: the user's global profile alone when no
 * project is given, else the global merged with that project's overlay (see
 * mergeUserPrefs). Null when the user has neither. This is what the launcher
 * injects and what the review-flow default reads, so global + project prefs both
 * follow a user into the project they're working in.
 */
export function getEffectiveUserPrefs(
  db: Database,
  alias: string,
  projectId?: string
): UserPrefs | null {
  const global = getUserPrefs(db, alias);
  const project = projectId ? getUserProjectPrefs(db, alias, projectId) : null;
  return mergeUserPrefs(global, project);
}
