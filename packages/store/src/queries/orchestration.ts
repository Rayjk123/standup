import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type {
  OrchestrationScope,
  OrchestrationProfile,
  OrchestrationRun,
  OrchestrationRunStatus,
  OrchestrationGateResult,
} from "@standup/shared";
import { MAX_REVIEW_ROUNDS } from "@standup/shared";
import { getSetting, setSetting } from "./settings.js";

/**
 * Orchestration profiles + run ledger — a named, scoped develop → deploy →
 * review workflow. Profiles are keyed by (scope, owner_key, name); runs are a
 * separate enforcement ledger cloning the task-runs transition guard, but a run
 * STAYS `running` across convergence rounds (bumpOrchestrationRound advances the
 * round counter) rather than re-entering `running`, which the transition table
 * forbids. See migration 047.
 */

/** owner_key for the one account-wide profile set (the `global` scope). */
export const GLOBAL_ORCH_OWNER_KEY = "__global__";

/** The settings k/v key holding the account-wide default profile name. */
export const ORCHESTRATION_DEFAULT_PROFILE_KEY = "orchestration.default_profile";

/**
 * Derives the owner key a profile is stored under from its scope: the alias for
 * a personal profile, the project id for a project profile, the reserved
 * `__global__` sentinel for the account-wide set. Throws when the identifying
 * value a scope needs is missing — the server derives this from the acting
 * identity, never from a client-supplied owner.
 */
export function ownerKeyFor(
  scope: OrchestrationScope,
  opts: { alias?: string; projectId?: string }
): string {
  switch (scope) {
    case "global":
      return GLOBAL_ORCH_OWNER_KEY;
    case "personal":
      if (!opts.alias) throw new Error("personal scope requires an alias");
      return opts.alias;
    case "project":
      if (!opts.projectId) throw new Error("project scope requires a projectId");
      return opts.projectId;
  }
}

// ============================================================================
// Profile CRUD
// ============================================================================

interface OrchestrationProfileRow {
  id: string;
  name: string;
  scope: string;
  owner_key: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Rebuilds a profile from its row: name/scope come from the authoritative
 * columns, the ordered steps and review knobs from the JSON blob. A corrupt
 * blob reads as an empty step list rather than throwing on a read.
 */
export function rowToProfile(row: OrchestrationProfileRow): OrchestrationProfile {
  let def: Partial<OrchestrationProfile> = {};
  try {
    def = JSON.parse(row.definition_json) as Partial<OrchestrationProfile>;
  } catch {
    def = {};
  }
  return {
    name: row.name,
    scope: row.scope as OrchestrationScope,
    steps: Array.isArray(def.steps) ? def.steps : [],
    maxReviewRounds: def.maxReviewRounds,
    blockOnSeverity: def.blockOnSeverity,
  };
}

/** The profile stored at (scope, ownerKey, name), or null when there is none. */
export function getProfile(
  db: Database,
  scope: OrchestrationScope,
  ownerKey: string,
  name: string
): OrchestrationProfile | null {
  const row = db
    .query(
      "SELECT * FROM orchestration_profiles WHERE scope = ? AND owner_key = ? AND name = ?"
    )
    .get(scope, ownerKey, name) as OrchestrationProfileRow | null;
  return row ? rowToProfile(row) : null;
}

/**
 * The profiles matching an optional scope/owner filter, name-ordered. An empty
 * filter lists everything; the CRUD API always narrows to the resolved owner.
 */
export function listProfiles(
  db: Database,
  filter: { scope?: OrchestrationScope; ownerKey?: string } = {}
): OrchestrationProfile[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.scope) {
    clauses.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.ownerKey) {
    clauses.push("owner_key = ?");
    params.push(filter.ownerKey);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .query(`SELECT * FROM orchestration_profiles ${where} ORDER BY name`)
    .all(...params) as OrchestrationProfileRow[];
  return rows.map(rowToProfile);
}

/**
 * Upserts a profile at (scope, ownerKey, name) — a full replace of its
 * definition. The name/scope columns are set from the explicit args (the
 * server-derived scope and the profile's name), keeping them authoritative for
 * the UNIQUE lookup even if the passed profile's own `scope` disagrees. A
 * re-upsert keeps the existing row's id and created_at. Returns the stored profile.
 */
export function upsertProfile(
  db: Database,
  scope: OrchestrationScope,
  ownerKey: string,
  profile: OrchestrationProfile
): OrchestrationProfile {
  const definitionJson = JSON.stringify({
    name: profile.name,
    scope,
    steps: profile.steps ?? [],
    maxReviewRounds: profile.maxReviewRounds,
    blockOnSeverity: profile.blockOnSeverity,
  });
  db.run(
    `INSERT INTO orchestration_profiles
       (id, name, scope, owner_key, definition_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(scope, owner_key, name) DO UPDATE SET
       definition_json = excluded.definition_json,
       updated_at = datetime('now')`,
    [randomUUID(), profile.name, scope, ownerKey, definitionJson]
  );
  return getProfile(db, scope, ownerKey, profile.name)!;
}

/**
 * Removes the profile at (scope, ownerKey, name); a no-op when none exists. In
 * the same transaction it clears a same-scope default pointer that named this
 * profile — the project column, the user_prefs field, or the global setting —
 * so a delete never strands a default at a profile that is gone (which would
 * resolve to null and silently drop the workflow). For project/personal scope
 * the ownerKey IS the projectId/alias the pointer lives under.
 */
export function deleteProfile(
  db: Database,
  scope: OrchestrationScope,
  ownerKey: string,
  name: string
): void {
  db.transaction(() => {
    db.run(
      "DELETE FROM orchestration_profiles WHERE scope = ? AND owner_key = ? AND name = ?",
      [scope, ownerKey, name]
    );
    if (scope === "project") {
      if (getProjectDefaultProfile(db, ownerKey) === name) {
        setProjectDefaultProfile(db, ownerKey, null);
      }
    } else if (scope === "personal") {
      if (getPersonalDefaultProfile(db, ownerKey) === name) {
        setPersonalDefaultProfile(db, ownerKey, null);
      }
    } else if (getGlobalDefaultProfile(db) === name) {
      setGlobalDefaultProfile(db, null);
    }
  })();
}

/** The severities a review step (or a profile) is allowed to block on. */
const ORCH_BLOCK_SEVERITIES = new Set(["high", "medium"]);

/** The longest profile name the store will accept (it is a path-like key). */
const MAX_ORCH_PROFILE_NAME_LENGTH = 200;

/** A profile-definition validation outcome: ok, or a single human-readable reason. */
export type OrchestrationProfileValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validates a profile before it is stored, returning the first failure found.
 * The name must be present, not oversized, and free of `/` or control
 * characters (it is a URL path segment and a storage key). `steps` must be an
 * array, and each step must carry the fields its kind requires: gate needs a
 * name and a command; deploy needs a runnable command (explicit or on its
 * target); review's optional `rounds` must be a positive integer no greater than
 * MAX_REVIEW_ROUNDS and its optional `blockOnSeverity` one of high/medium;
 * human_pause is rejected outright (no resume mechanism exists yet). An
 * unrecognized kind is rejected. The profile-wide
 * `maxReviewRounds` (also capped at MAX_REVIEW_ROUNDS) and `blockOnSeverity` are
 * held to the same shape when present. Step fields are read defensively — the
 * input reaches here straight off the wire, so the declared types are not yet
 * guaranteed.
 */
export function validateOrchestrationProfileDefinition(
  profile: OrchestrationProfile
): OrchestrationProfileValidation {
  const fail = (error: string): OrchestrationProfileValidation => ({ ok: false, error });

  const name: unknown = profile.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return fail("name is required");
  }
  if (name.length > MAX_ORCH_PROFILE_NAME_LENGTH) {
    return fail(`name must be at most ${MAX_ORCH_PROFILE_NAME_LENGTH} characters`);
  }
  if (name.includes("/")) {
    return fail("name must not contain '/'");
  }
  const hasControlChar = Array.from(name).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (hasControlChar) {
    return fail("name must not contain control characters");
  }

  if (!Array.isArray(profile.steps)) {
    return fail("steps must be an array");
  }

  if (
    profile.maxReviewRounds !== undefined &&
    !(Number.isInteger(profile.maxReviewRounds) && profile.maxReviewRounds > 0)
  ) {
    return fail("maxReviewRounds must be a positive integer");
  }
  if (
    profile.maxReviewRounds !== undefined &&
    profile.maxReviewRounds > MAX_REVIEW_ROUNDS
  ) {
    return fail(`maxReviewRounds must be at most ${MAX_REVIEW_ROUNDS}`);
  }
  if (
    profile.blockOnSeverity !== undefined &&
    !ORCH_BLOCK_SEVERITIES.has(profile.blockOnSeverity)
  ) {
    return fail("blockOnSeverity must be one of: high, medium");
  }

  for (let i = 0; i < profile.steps.length; i++) {
    const raw = profile.steps[i] as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return fail(`step ${i} must be an object`);
    }
    const step = raw as Record<string, unknown>;
    switch (step.kind) {
      case "gate":
        if (typeof step.name !== "string" || step.name.trim().length === 0) {
          return fail(`step ${i} (gate): name is required`);
        }
        if (typeof step.command !== "string" || step.command.trim().length === 0) {
          return fail(`step ${i} (gate): command is required`);
        }
        break;
      case "deploy": {
        // A deploy step must resolve to a runnable command — either an explicit
        // `command` or one carried on its `target`. A target that names only an
        // account with no command is not deployable: the loop would otherwise
        // record a no-op skip and let the run succeed WITHOUT deploying.
        const target =
          step.target && typeof step.target === "object" && !Array.isArray(step.target)
            ? (step.target as Record<string, unknown>)
            : undefined;
        const hasCommand =
          (typeof step.command === "string" && step.command.trim().length > 0) ||
          (typeof target?.command === "string" &&
            (target.command as string).trim().length > 0);
        if (!hasCommand) {
          return fail(`step ${i} (deploy): a command is required`);
        }
        break;
      }
      case "review":
        if (
          step.rounds !== undefined &&
          !(Number.isInteger(step.rounds) && (step.rounds as number) > 0)
        ) {
          return fail(`step ${i} (review): rounds must be a positive integer`);
        }
        if (step.rounds !== undefined && (step.rounds as number) > MAX_REVIEW_ROUNDS) {
          return fail(`step ${i} (review): rounds must be at most ${MAX_REVIEW_ROUNDS}`);
        }
        if (
          step.blockOnSeverity !== undefined &&
          !ORCH_BLOCK_SEVERITIES.has(step.blockOnSeverity as string)
        ) {
          return fail(`step ${i} (review): blockOnSeverity must be one of: high, medium`);
        }
        break;
      case "human_pause":
        // human_pause has no resume mechanism yet, so a run parked on it would
        // lock the ticket's completion choke forever. Reject it until a resume
        // path exists; the OrchestrationStep variant is retained for that work.
        return fail(
          `step ${i} (human_pause): human_pause steps are not yet supported (a resume mechanism is coming); remove this step`
        );
      default:
        return fail(`step ${i}: unknown kind '${String(step.kind)}'`);
    }
  }

  return { ok: true };
}

// ============================================================================
// Per-scope default resolution (mirrors resolvePlanGate precedence)
// ============================================================================

/** The project's default profile name (projects.orchestration_profile), or null. */
export function getProjectDefaultProfile(
  db: Database,
  projectId: string
): string | null {
  const row = db
    .query("SELECT orchestration_profile FROM projects WHERE id = ?")
    .get(projectId) as { orchestration_profile: string | null } | null;
  return row?.orchestration_profile ?? null;
}

/** The user's default profile name (user_prefs.orchestration_profile), or null. */
export function getPersonalDefaultProfile(
  db: Database,
  alias: string
): string | null {
  const row = db
    .query("SELECT orchestration_profile FROM user_prefs WHERE alias = ?")
    .get(alias) as { orchestration_profile: string | null } | null;
  return row?.orchestration_profile ?? null;
}

/** The account-wide default profile name (settings key), or null when unset/blank. */
export function getGlobalDefaultProfile(db: Database): string | null {
  const v = getSetting(db, ORCHESTRATION_DEFAULT_PROFILE_KEY);
  return v && v.trim() ? v : null;
}

/** Sets (or clears, with null) the project's default profile column. */
export function setProjectDefaultProfile(
  db: Database,
  projectId: string,
  name: string | null
): void {
  db.run("UPDATE projects SET orchestration_profile = ? WHERE id = ?", [
    name,
    projectId,
  ]);
}

/**
 * Sets (or clears, with null) the user's default profile. Upserts the user_prefs
 * row touching ONLY the orchestration_profile column, so it neither requires an
 * existing profile nor disturbs the full-replace fields putUserPrefs owns.
 */
export function setPersonalDefaultProfile(
  db: Database,
  alias: string,
  name: string | null
): void {
  db.run(
    `INSERT INTO user_prefs (alias, orchestration_profile, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(alias) DO UPDATE SET
         orchestration_profile = excluded.orchestration_profile,
         updated_at = datetime('now')`,
    [alias, name]
  );
}

/** Sets (or clears, with null) the account-wide default profile setting. */
export function setGlobalDefaultProfile(db: Database, name: string | null): void {
  // setSetting stores strings and has no delete; a blank string reads back as
  // "unset" via getGlobalDefaultProfile's trim check.
  setSetting(db, ORCHESTRATION_DEFAULT_PROFILE_KEY, name ?? "");
}

/**
 * The NAME of the profile a launch adopts — precisely the profile
 * resolveActiveProfile loads, so the two never disagree. Null when no scope
 * resolves to a stored profile, INCLUDING when a default names a profile that no
 * longer exists: that dangling name falls through to the next scope rather than
 * being reported as the active name (which would then load as null downstream).
 */
export function resolveActiveProfileName(
  db: Database,
  opts: { launchOverride?: string | null; projectId?: string; alias?: string }
): string | null {
  return resolveActiveProfile(db, opts)?.name ?? null;
}

/**
 * Loads the resolved profile for a launch by precedence
 * override → project → personal → global, taking it from the nearest scope that
 * both names it AND has it stored. With an override the named profile wins and
 * is looked up project → personal → global; without one each layer contributes
 * its own default. A default that names a missing profile (dangling) falls
 * through to the next scope. Null when nothing resolves to a stored profile.
 * This is the single resolution walk; resolveActiveProfileName returns this
 * profile's name so the name and the loaded row always agree.
 */
export function resolveActiveProfile(
  db: Database,
  opts: { launchOverride?: string | null; projectId?: string; alias?: string }
): OrchestrationProfile | null {
  const { launchOverride, projectId, alias } = opts;

  if (projectId) {
    const name = launchOverride ?? getProjectDefaultProfile(db, projectId);
    if (name) {
      const prof = getProfile(db, "project", projectId, name);
      if (prof) return prof;
    }
  }
  if (alias) {
    const name = launchOverride ?? getPersonalDefaultProfile(db, alias);
    if (name) {
      const prof = getProfile(db, "personal", alias, name);
      if (prof) return prof;
    }
  }
  const globalName = launchOverride ?? getGlobalDefaultProfile(db);
  if (globalName) {
    const prof = getProfile(db, "global", GLOBAL_ORCH_OWNER_KEY, globalName);
    if (prof) return prof;
  }
  return null;
}

// ============================================================================
// Run ledger (clones the task-runs transition guard trio)
// ============================================================================

/**
 * The orchestration lifecycle state machine. A run may only move to a status
 * listed for its current one. queued/running are active; the terminals are
 * closed — with the single exception that a `succeeded` run may move to
 * `superseded` when later rework invalidates it, so a stale success can no
 * longer authorize completion of the new change. There is deliberately NO
 * running -> running self-loop: convergence rounds advance via
 * bumpOrchestrationRound while the run stays `running`.
 * updateOrchestrationRunStatus is the single enforcement point.
 */
export const ALLOWED_ORCH_RUN_TRANSITIONS: Record<
  OrchestrationRunStatus,
  OrchestrationRunStatus[]
> = {
  queued: ["running", "failed", "cancelled", "lost"],
  running: ["succeeded", "failed", "cancelled", "lost"],
  succeeded: ["superseded"],
  failed: [],
  cancelled: [],
  lost: [],
  superseded: [],
};

/** Statuses that count as "still in flight" for the active-run lookups and sweep. */
const ACTIVE_ORCH_STATUSES: OrchestrationRunStatus[] = ["queued", "running"];

/** The active-status set as a SQL IN-list literal. */
const ACTIVE_ORCH_IN = ACTIVE_ORCH_STATUSES.map((s) => `'${s}'`).join(", ");

/** Default silence tolerated before the sweep calls a running orchestration lost. */
export const DEFAULT_ORCH_RUN_GRACE_MS = 2 * 60 * 1000;

/** Thrown by updateOrchestrationRunStatus for an edge not in ALLOWED_ORCH_RUN_TRANSITIONS. */
export class OrchestrationRunTransitionError extends Error {
  constructor(
    public readonly from: OrchestrationRunStatus,
    public readonly to: OrchestrationRunStatus
  ) {
    super(`Illegal orchestration-run transition: ${from} -> ${to}`);
    this.name = "OrchestrationRunTransitionError";
  }
}

interface OrchestrationRunRow {
  id: string;
  profile_name: string;
  scope: string;
  owner_key: string;
  project_id: string | null;
  ticket_id: string | null;
  session_id: string | null;
  launch_id: string | null;
  status: OrchestrationRunStatus;
  round: number;
  max_rounds: number;
  last_event_at: string;
  created_at: string;
  ended_at: string | null;
  summary: string | null;
  error: string | null;
}

function toOrchestrationRun(row: OrchestrationRunRow): OrchestrationRun {
  return {
    id: row.id,
    profileName: row.profile_name,
    scope: row.scope as OrchestrationScope,
    ownerKey: row.owner_key,
    projectId: row.project_id ?? undefined,
    ticketId: row.ticket_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    status: row.status,
    round: row.round,
    maxRounds: row.max_rounds,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
  };
}

export function createOrchestrationRun(
  db: Database,
  input: {
    id: string;
    profileName: string;
    scope: OrchestrationScope;
    ownerKey: string;
    projectId?: string;
    ticketId?: string;
    sessionId?: string;
    launchId?: string;
    maxRounds?: number;
  }
): OrchestrationRun {
  db.run(
    `INSERT INTO orchestration_runs
       (id, profile_name, scope, owner_key, project_id, ticket_id, session_id, launch_id,
        status, round, max_rounds, last_event_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, datetime('now'), datetime('now'))`,
    [
      input.id,
      input.profileName,
      input.scope,
      input.ownerKey,
      input.projectId ?? null,
      input.ticketId ?? null,
      input.sessionId ?? null,
      input.launchId ?? null,
      input.maxRounds ?? 3,
    ]
  );
  return getOrchestrationRun(db, input.id)!;
}

export function getOrchestrationRun(
  db: Database,
  id: string
): OrchestrationRun | null {
  const row = db
    .query("SELECT * FROM orchestration_runs WHERE id = ?")
    .get(id) as OrchestrationRunRow | null;
  return row ? toOrchestrationRun(row) : null;
}

/**
 * Moves a run to `to`, enforcing ALLOWED_ORCH_RUN_TRANSITIONS and stamping
 * `ended_at` on any terminal transition. `last_event_at` bumps on every
 * transition (it doubles as the liveness clock). `summary`/`error` are recorded
 * when provided. Throws OrchestrationRunTransitionError on an illegal edge.
 */
export function updateOrchestrationRunStatus(
  db: Database,
  id: string,
  to: OrchestrationRunStatus,
  opts?: { summary?: string; error?: string }
): OrchestrationRun {
  const current = getOrchestrationRun(db, id);
  if (!current) throw new Error(`orchestration run not found: ${id}`);
  if (!ALLOWED_ORCH_RUN_TRANSITIONS[current.status].includes(to)) {
    throw new OrchestrationRunTransitionError(current.status, to);
  }

  const sets = ["status = ?", "last_event_at = datetime('now')"];
  const params: (string | null)[] = [to];

  if (
    to === "succeeded" ||
    to === "failed" ||
    to === "cancelled" ||
    to === "lost" ||
    to === "superseded"
  ) {
    sets.push("ended_at = datetime('now')");
  }
  if (opts?.summary !== undefined) {
    sets.push("summary = ?");
    params.push(opts.summary);
  }
  if (opts?.error !== undefined) {
    sets.push("error = ?");
    params.push(opts.error);
  }

  params.push(id);
  db.run(`UPDATE orchestration_runs SET ${sets.join(", ")} WHERE id = ?`, params);
  return getOrchestrationRun(db, id)!;
}

/**
 * Advances a run's convergence round by one while it stays `running` — the loop
 * primitive the transition table has no self-edge for. Returns null WITHOUT
 * touching the row when the next round would exceed max_rounds: the run has
 * exhausted its bounded review budget and the caller should terminate it rather
 * than loop forever. Otherwise stamps last_event_at, advances the round, and
 * returns the updated run. Throws when the run is not currently running.
 */
export function bumpOrchestrationRound(
  db: Database,
  id: string
): OrchestrationRun | null {
  const current = getOrchestrationRun(db, id);
  if (!current) throw new Error(`orchestration run not found: ${id}`);
  if (current.status !== "running") {
    throw new Error(`cannot bump round of a ${current.status} orchestration run`);
  }
  if (current.round + 1 > current.maxRounds) return null;
  db.run(
    "UPDATE orchestration_runs SET round = round + 1, last_event_at = datetime('now') WHERE id = ?",
    [id]
  );
  return getOrchestrationRun(db, id)!;
}

/** Records agent liveness by bumping `last_event_at` without changing status. */
export function heartbeatOrchestrationRun(
  db: Database,
  id: string
): OrchestrationRun {
  db.run(
    "UPDATE orchestration_runs SET last_event_at = datetime('now') WHERE id = ?",
    [id]
  );
  return getOrchestrationRun(db, id)!;
}

export interface ReconcileOrchestrationRunsOptions {
  /** Silence tolerated before a still-running run is called lost. */
  graceMs?: number;
  /**
   * Liveness probe for a run, injected. Defaults to "assume alive" so a caller
   * that forgets to wire a real probe never reaps anything — the enforcement
   * loop passes a probe backed by the run's session/launch pane.
   */
  isAlive?: (run: OrchestrationRun) => boolean;
}

/**
 * Reconciliation sweep: marks an active run `lost` when it has been silent past
 * the grace window and the injected liveness probe says it is gone. Idle time is
 * computed in SQL (UTC julianday) to avoid timezone skew between the stored
 * timestamps and the wall clock. BOTH `queued` and `running` runs are swept: a
 * run stranded `queued` (a controller that crashed before the queued -> running
 * flip) is just as orphaned as one stranded `running`, and both have a `-> lost`
 * edge.
 */
export function reconcileLostOrchestrationRuns(
  db: Database,
  opts: ReconcileOrchestrationRunsOptions = {}
): OrchestrationRun[] {
  const graceSeconds = (opts.graceMs ?? DEFAULT_ORCH_RUN_GRACE_MS) / 1000;
  const isAlive = opts.isAlive ?? (() => true);

  const rows = db
    .query(
      `SELECT *,
              (julianday('now') - julianday(COALESCE(last_event_at, created_at))) * 86400.0
                AS idle_seconds
         FROM orchestration_runs WHERE status IN (${ACTIVE_ORCH_IN})`
    )
    .all() as Array<OrchestrationRunRow & { idle_seconds: number }>;

  const lost: OrchestrationRun[] = [];
  for (const row of rows) {
    if (row.idle_seconds < graceSeconds) continue; // still within grace
    const run = toOrchestrationRun(row);
    if (isAlive(run)) continue; // probe says alive
    lost.push(
      updateOrchestrationRunStatus(db, row.id, "lost", {
        error: "orchestration run went silent past the grace window with no live session",
      })
    );
  }
  return lost;
}

/** The active (queued/running) run for a ticket, most recent first, or null. */
export function getActiveOrchestrationRunByTicket(
  db: Database,
  ticketId: string
): OrchestrationRun | null {
  const row = db
    .query(
      `SELECT * FROM orchestration_runs
        WHERE ticket_id = ? AND status IN (${ACTIVE_ORCH_IN})
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(ticketId) as OrchestrationRunRow | null;
  return row ? toOrchestrationRun(row) : null;
}

/**
 * The most recent run for a ticket regardless of status, or null when the
 * ticket has never had one. The completion choke reads this to allow the
 * developing -> needs_review transition ONLY when the latest run `succeeded`:
 * getActiveOrchestrationRunByTicket alone can't distinguish "never ran" from
 * "ran and terminated" (both yield null), so a terminal failed/lost run would
 * otherwise read as "no run" and let the change through un-enforced.
 */
export function getLatestOrchestrationRunByTicket(
  db: Database,
  ticketId: string
): OrchestrationRun | null {
  const row = db
    .query(
      `SELECT * FROM orchestration_runs
        WHERE ticket_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(ticketId) as OrchestrationRunRow | null;
  return row ? toOrchestrationRun(row) : null;
}

/**
 * Retires a ticket's orchestration runs on the needs_review -> developing rework
 * edge so no run tied to the pre-rework change can authorize completion of the
 * new, un-reviewed work. Two classes are retired: a `succeeded` run moves to
 * `superseded` (its pass is now stale), and an in-flight `queued`/`running` run
 * moves to `cancelled` — one kicked off while the ticket sat in needs_review
 * would otherwise survive the edge and later succeed against a stale pre-rework
 * diff, re-authorizing un-reviewed work. Either way the completion choke
 * re-blocks until a fresh run passes over the reworked change. Idempotent: a
 * no-op once the ticket has no succeeded or active run.
 */
export function supersedeOrchestrationRunsForTicket(
  db: Database,
  ticketId: string
): void {
  const succeeded = db
    .query(
      "SELECT id FROM orchestration_runs WHERE ticket_id = ? AND status = 'succeeded'"
    )
    .all(ticketId) as Array<{ id: string }>;
  for (const row of succeeded) {
    updateOrchestrationRunStatus(db, row.id, "superseded", {
      summary: "superseded by rework — a fresh orchestration run must pass over the reworked change",
    });
  }
  const active = db
    .query(
      `SELECT id FROM orchestration_runs WHERE ticket_id = ? AND status IN (${ACTIVE_ORCH_IN})`
    )
    .all(ticketId) as Array<{ id: string }>;
  for (const row of active) {
    updateOrchestrationRunStatus(db, row.id, "cancelled", {
      summary: "cancelled by rework — an in-flight run was verifying the pre-rework change",
    });
  }
}

/** The active (queued/running) run for a session, most recent first, or null. */
export function getActiveOrchestrationRunBySession(
  db: Database,
  sessionId: string
): OrchestrationRun | null {
  const row = db
    .query(
      `SELECT * FROM orchestration_runs
        WHERE session_id = ? AND status IN (${ACTIVE_ORCH_IN})
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId) as OrchestrationRunRow | null;
  return row ? toOrchestrationRun(row) : null;
}

// ============================================================================
// Gate results
// ============================================================================

interface OrchestrationGateResultRow {
  id: string;
  run_id: string;
  round: number;
  step_index: number;
  kind: string;
  passed: number;
  detail: string | null;
  created_at: string;
}

function toGateResult(row: OrchestrationGateResultRow): OrchestrationGateResult {
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    stepIndex: row.step_index,
    kind: row.kind,
    passed: row.passed === 1,
    detail: row.detail ?? undefined,
    createdAt: row.created_at,
  };
}

function getGateResult(
  db: Database,
  id: string
): OrchestrationGateResult | null {
  const row = db
    .query("SELECT * FROM orchestration_gate_results WHERE id = ?")
    .get(id) as OrchestrationGateResultRow | null;
  return row ? toGateResult(row) : null;
}

/** Records the outcome of one step evaluation within a run. */
export function recordGateResult(
  db: Database,
  input: {
    id?: string;
    runId: string;
    round: number;
    stepIndex: number;
    kind: string;
    passed: boolean;
    detail?: string;
  }
): OrchestrationGateResult {
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO orchestration_gate_results
       (id, run_id, round, step_index, kind, passed, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      id,
      input.runId,
      input.round,
      input.stepIndex,
      input.kind,
      input.passed ? 1 : 0,
      input.detail ?? null,
    ]
  );
  return getGateResult(db, id)!;
}

/** A run's recorded step outcomes, oldest first (chronological, then step order). */
export function getGateResults(
  db: Database,
  runId: string
): OrchestrationGateResult[] {
  const rows = db
    .query(
      `SELECT * FROM orchestration_gate_results
        WHERE run_id = ? ORDER BY created_at ASC, round ASC, step_index ASC`
    )
    .all(runId) as OrchestrationGateResultRow[];
  return rows.map(toGateResult);
}
