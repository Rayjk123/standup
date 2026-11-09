import { Database } from "bun:sqlite";
import { KnowledgeStore, LocalMarkdownBackend, compileGraph, draftFileExists } from "@standup/knowledge";
import { getSetting } from "@standup/store";
import { runClaudeContradictionJudge, type ContradictionJudge } from "./knowledge-coherence.js";
import { rebaselineDisputes, type RebaselineDeps } from "./knowledge-dispute-rebaseline.js";
import { NIGHTLY_SWEEP_ENV, NIGHTLY_SWEEP_SETTING_KEY, isNightlySweepEnabled } from "./knowledge-graph-audit.js";
import { MAX_REVERIFY_ATTEMPTS } from "./knowledge-freshness.js";
import { collapseMirrorDuplicates } from "./knowledge-mirror-collapse.js";
import {
  expireLandedBranchClaims,
  readLandedClaims,
  recordLandedClaim,
  type ExpireLandedDeps,
  type LandedClaimDeps,
} from "./knowledge-repo-claims.js";
import { lastRunKey } from "./knowledge-reverify.js";
import type { KnowledgeSync } from "./knowledge-sync.js";

/**
 * One-time corpus maintenance the collector runs over its own database at
 * boot, once per MAINTENANCE_VERSION:
 *
 *  1. `mirror` — collapseMirrorDuplicates: mirror-project copies (standup-self)
 *     of canonical docs are superseded; near-duplicate clusters inside a
 *     project only get review drafts.
 *  2. `landed` — expireLandedBranchClaims: "on branch X, not yet merged"
 *     claims whose work is on the default branch are recorded as landed, with
 *     a review draft rewriting them.
 *  3. `disputes` — rebaselineDisputes: deterministic re-baseline of stored
 *     dispute labels (refuted fact disputes, both-sides ties, edges the ledger
 *     reads as a timeline); a judge re-reads pairs only when the collector's
 *     model passes are on AND MAINTENANCE_JUDGE_ENV opts in. Docs still
 *     disputed afterwards are marked due for the re-verification cron
 *     (markReverifyDue), at most MAINTENANCE_REVERIFY_MAX of them per version:
 *     a doc marked under this version is never marked again by it.
 *  4. `graph` — a forced compileGraph, so `[[slug]]` wikilink and same-session
 *     provenance edges are persisted; edge counts by kind before and after.
 *
 * Each step is isolated: one that throws is logged and the rest still run.
 * Each step that completes is recorded (knowledge_maintenance_steps) and is not
 * run again for this version, so a later boot runs only the steps that failed,
 * were deferred by the budget, or stopped part-way (a step returning
 * `incomplete`); every step is idempotent, so the retry is safe. The version is
 * recorded (knowledge_maintenance_runs) once every step has completed. A dry
 * run executes the same steps against an in-memory copy of the database with
 * every file write disabled, and returns their counts.
 */

/** Bumped whenever a step is added or changes what it repairs, so the routine runs again once. */
export const MAINTENANCE_VERSION = 1;
/** Opt-out: an off value (`0`/`false`/`off`/`no`) skips the routine. */
export const MAINTENANCE_ENV = "STANDUP_KNOWLEDGE_MAINTENANCE";
/** Opt-in for the model judge in the dispute step (also needs the nightly sweep's model passes on). */
export const MAINTENANCE_JUDGE_ENV = "STANDUP_KNOWLEDGE_MAINTENANCE_JUDGE";
/** Wall-clock budget for one run; a step not started within it is deferred to the next boot. */
export const MAINTENANCE_BUDGET_MS = 5 * 60_000;
/** Most docs one run marks due for re-verification. */
export const MAINTENANCE_REVERIFY_MAX = 25;
/** Most judge calls one run makes when the judge is enabled. */
export const MAINTENANCE_MAX_JUDGED = 20;

export type MaintenanceStepName = "mirror" | "landed" | "disputes" | "graph";
const STEP_ORDER: readonly MaintenanceStepName[] = ["mirror", "landed", "disputes", "graph"];

export type MaintenanceCounts = Record<string, number | Record<string, number>>;

/** A step's counts carrying a positive value under this key stopped part-way and runs again next boot. */
export const STEP_INCOMPLETE_KEY = "incomplete";

export interface MaintenanceStepResult {
  name: MaintenanceStepName;
  /** `done`: completed by an earlier run of this version and not run again. `partial`: stopped part-way. */
  status: "ok" | "done" | "partial" | "error" | "deferred";
  counts?: MaintenanceCounts;
  error?: string;
  ms: number;
}

export interface KnowledgeMaintenanceResult {
  version: number;
  status: "ran" | "incomplete" | "disabled" | "already-ran";
  dryRun: boolean;
  steps: MaintenanceStepResult[];
  /** Whether this run recorded the version as done. */
  recorded: boolean;
}

/** What a step runs against: the live DB, or the dry run's copy with `knowledgeDir` withheld from writers. */
export interface MaintenanceStepContext {
  db: Database;
  knowledgeDir: string;
  dryRun: boolean;
  deps: KnowledgeMaintenanceDeps;
  /** The run's budget deadline, in `now` ms: a long step checks it and stops part-way. */
  deadline: number;
  now: () => number;
}

export type MaintenanceStep = (ctx: MaintenanceStepContext) => Promise<MaintenanceCounts>;

export interface KnowledgeMaintenanceDeps {
  db: Database;
  knowledgeDir: string;
  /** Run the steps on an in-memory copy, write nothing, return the counts. */
  dryRun?: boolean;
  /** Run even though this version is already recorded. */
  force?: boolean;
  /** Environment read for the opt-out and judge flags. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  budgetMs?: number;
  /** Clock for the budget, in ms. Default Date.now. */
  now?: () => number;
  log?: (line: string) => void;
  /** Re-reads a project's drafts into the index after the landed step wrote some. */
  syncDrafts?: (projectId: string) => Promise<void>;
  /** Contradiction judge for the dispute step; used only when maintenanceJudgeEnabled. */
  judge?: ContradictionJudge;
  readAcceptedDoc?: RebaselineDeps["readAcceptedDoc"];
  /** Mirror project → canonical project for the mirror step. Default MIRROR_PROJECTS. */
  mirrors?: Readonly<Record<string, string>>;
  /** Projects the landed step checks. Default every registered project with a repo. */
  landedProjects?: ExpireLandedDeps["projects"];
  /** Replaces individual steps (tests). */
  steps?: Partial<Record<MaintenanceStepName, MaintenanceStep>>;
}

const RUNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_maintenance_runs (
  version INTEGER PRIMARY KEY,
  ran_at TEXT NOT NULL,
  counts_json TEXT NOT NULL
)`;

const STEPS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_maintenance_steps (
  version INTEGER NOT NULL,
  step TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  PRIMARY KEY (version, step)
)`;

const REVERIFY_MARKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS knowledge_maintenance_reverify_marks (
  version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (version, project_id, slug)
)`;

/** The steps of `version` an earlier run completed. */
export function completedMaintenanceSteps(db: Database, version: number): Set<MaintenanceStepName> {
  db.run(STEPS_TABLE_SQL);
  const rows = db.query("SELECT step FROM knowledge_maintenance_steps WHERE version = ?").all(version) as Array<{
    step: MaintenanceStepName;
  }>;
  return new Set(rows.map((r) => r.step));
}

function recordMaintenanceStep(db: Database, version: number, step: MaintenanceStepResult): void {
  db.run(STEPS_TABLE_SQL);
  db.run("INSERT OR REPLACE INTO knowledge_maintenance_steps (version, step, ran_at, counts_json) VALUES (?, ?, ?, ?)", [
    version,
    step.name,
    new Date().toISOString(),
    JSON.stringify(step.counts ?? {}),
  ]);
}

/** Docs `version` already marked due for re-verification, as `project\0slug`. */
function reverifyMarksOf(db: Database, version: number): Set<string> {
  db.run(REVERIFY_MARKS_TABLE_SQL);
  const rows = db
    .query("SELECT project_id, slug FROM knowledge_maintenance_reverify_marks WHERE version = ?")
    .all(version) as Array<{ project_id: string; slug: string }>;
  return new Set(rows.map((r) => `${r.project_id}\u0000${r.slug}`));
}

function recordReverifyMark(db: Database, version: number, projectId: string, slug: string): void {
  db.run(
    "INSERT OR IGNORE INTO knowledge_maintenance_reverify_marks (version, project_id, slug, marked_at) VALUES (?, ?, ?, ?)",
    [version, projectId, slug, new Date().toISOString()]
  );
}

function isOffValue(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "0" || s === "false" || s === "off" || s === "no" || s === "disabled";
}

function isOnValue(v: string | null | undefined): boolean {
  if (v == null) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes" || s === "enabled";
}

/** Whether the routine runs at all: on unless MAINTENANCE_ENV is an off value. */
export function isMaintenanceEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !isOffValue(env[MAINTENANCE_ENV]);
}

/**
 * Whether the dispute step may call the model judge: MAINTENANCE_JUDGE_ENV is
 * on and the collector's background model passes (the nightly sweep's switch)
 * are not turned off.
 */
export function maintenanceJudgeEnabled(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  if (!isOnValue(env[MAINTENANCE_JUDGE_ENV])) return false;
  return isNightlySweepEnabled(env[NIGHTLY_SWEEP_ENV], getSetting(db, NIGHTLY_SWEEP_SETTING_KEY));
}

/** The recorded run of `version`, or null. */
export function maintenanceRunOf(db: Database, version: number): { ranAt: string; counts: unknown } | null {
  db.run(RUNS_TABLE_SQL);
  const row = db.query("SELECT ran_at, counts_json FROM knowledge_maintenance_runs WHERE version = ?").get(version) as
    | { ran_at: string; counts_json: string }
    | null;
  return row ? { ranAt: row.ran_at, counts: JSON.parse(row.counts_json) as unknown } : null;
}

/** Records `version` as done, with each step's counts from the run that completed it. */
function recordMaintenanceRun(db: Database, version: number): void {
  db.run(RUNS_TABLE_SQL);
  db.run(STEPS_TABLE_SQL);
  const rows = db.query("SELECT step, counts_json FROM knowledge_maintenance_steps WHERE version = ?").all(version) as Array<{
    step: string;
    counts_json: string;
  }>;
  const counts = Object.fromEntries(rows.map((r) => [r.step, JSON.parse(r.counts_json) as unknown]));
  db.run("INSERT OR REPLACE INTO knowledge_maintenance_runs (version, ran_at, counts_json) VALUES (?, ?, ?)", [
    version,
    new Date().toISOString(),
    JSON.stringify(counts),
  ]);
}

/** The last_attempt_at markReverifyDue writes: the epoch, which the cron reads as no recorded attempt time. */
const REVERIFY_COOLDOWN_CLEARED_AT = new Date(0).toISOString();

/**
 * Makes a disputed doc a candidate on the re-verification cron's next poll:
 * its last_verified_at (the 14-day recency backoff) is cleared, the retry
 * cooldown of its verdict-less attempt record is lifted (last_attempt_at reset
 * to the epoch, which reads as "never attempted"), and the project's
 * once-a-day gate is lifted. The attempt count is kept, so a doc that has
 * spent its MAX_REVERIFY_ATTEMPTS stays out of the cron. The file keeps its own
 * last_verified_at; the next fact-check writes a fresh one. Returns whether
 * anything changed.
 */
export function markReverifyDue(db: Database, projectId: string, slug: string): boolean {
  let changed =
    db.run(
      "UPDATE knowledge SET last_verified_at = NULL WHERE project_id = ? AND slug = ? AND last_verified_at IS NOT NULL",
      [projectId, slug]
    ).changes > 0;
  try {
    changed =
      db.run(
        `UPDATE knowledge_reverify_attempts SET last_attempt_at = ?
         WHERE project_id = ? AND slug = ? AND attempts < ? AND last_attempt_at != ?`,
        [REVERIFY_COOLDOWN_CLEARED_AT, projectId, slug, MAX_REVERIFY_ATTEMPTS, REVERIFY_COOLDOWN_CLEARED_AT]
      ).changes > 0 || changed;
  } catch {
    // No attempts table yet: nothing has been attempted.
  }
  changed = db.run("DELETE FROM settings WHERE key = ?", [lastRunKey(projectId)]).changes > 0 || changed;
  return changed;
}

/** Persisted edge counts by kind; `related` edges written from a body `[[slug]]` count as `wikilink`. */
export function edgeCountsByKind(db: Database): Record<string, number> {
  const counts: Record<string, number> = {};
  let rows: Array<{ kind: string; evidence: string | null }> = [];
  try {
    rows = db.query("SELECT kind, evidence FROM knowledge_edges").all() as typeof rows;
  } catch {
    return counts;
  }
  for (const r of rows) {
    const kind = r.kind === "related" && !(r.evidence ?? "").startsWith("frontmatter related:") ? "wikilink" : r.kind;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

const mirrorStep: MaintenanceStep = async ({ db, knowledgeDir, dryRun, deps, deadline, now }) => {
  const counts = await collapseMirrorDuplicates({ db, mirrors: deps.mirrors, knowledgeDir, dryRun, deadline, now });
  return { ...counts, ...(counts.clusterScanIncomplete > 0 ? { [STEP_INCOMPLETE_KEY]: 1 } : {}) };
};

const landedStep: MaintenanceStep = async ({ db, knowledgeDir, dryRun, deps }) => {
  const landed: LandedClaimDeps | undefined = dryRun
    ? {
        read: (projectId) => readLandedClaims(db, projectId),
        record: (projectId, rec) => recordLandedClaim(db, projectId, rec),
        writeDraft: async (projectId, draft) => !draftFileExists(knowledgeDir, projectId, draft.slug),
      }
    : undefined;
  const result = await expireLandedBranchClaims({
    db,
    knowledgeDir,
    landed,
    projects: deps.landedProjects,
    syncDrafts: dryRun ? undefined : deps.syncDrafts,
  });
  return { ...result };
};

const disputesStep: MaintenanceStep = async ({ db, deps }) => {
  const store = new KnowledgeStore(db);
  const useJudge = deps.judge !== undefined && deps.readAcceptedDoc !== undefined && maintenanceJudgeEnabled(db, deps.env);
  const alreadyMarked = reverifyMarksOf(db, MAINTENANCE_VERSION);
  let marked = 0;
  let queued = 0;
  const result = await rebaselineDisputes({
    db,
    setVerdict: (projectId, slug, verdict, disputes) =>
      verdict === null ? store.clearDocVerdict(projectId, slug) : store.setDocVerdict(projectId, slug, verdict, disputes),
    ...(useJudge ? { judge: deps.judge, readAcceptedDoc: deps.readAcceptedDoc, maxJudged: MAINTENANCE_MAX_JUDGED } : {}),
    queueReverify: (projectId, slug) => {
      if (alreadyMarked.has(`${projectId}\u0000${slug}`)) return;
      if (alreadyMarked.size + queued >= MAINTENANCE_REVERIFY_MAX) return;
      queued++;
      if (markReverifyDue(db, projectId, slug)) marked++;
      recordReverifyMark(db, MAINTENANCE_VERSION, projectId, slug);
    },
  });
  const { reverify, ...rest } = result;
  return { ...rest, stillDisputed: reverify.length, reverifyQueued: queued, reverifyMarked: marked };
};

const graphStep: MaintenanceStep = async ({ db }) => {
  const before = edgeCountsByKind(db);
  // A fresh store has no compile memo, so this derives and persists the graph.
  compileGraph(new KnowledgeStore(db));
  return { before, after: edgeCountsByKind(db) };
};

const DEFAULT_STEPS: Record<MaintenanceStepName, MaintenanceStep> = {
  mirror: mirrorStep,
  landed: landedStep,
  disputes: disputesStep,
  graph: graphStep,
};

function formatCounts(counts: MaintenanceCounts | undefined): string {
  if (!counts) return "";
  return Object.entries(counts)
    .map(([k, v]) =>
      typeof v === "number"
        ? `${k}=${v}`
        : `${k}{${Object.entries(v)
            .map(([kk, vv]) => `${kk}:${vv}`)
            .join(",")}}`
    )
    .join(" ");
}

/** The one summary line a run logs. */
export function maintenanceSummary(result: KnowledgeMaintenanceResult): string {
  const head = `[knowledge-maintenance] v${result.version}${result.dryRun ? " (dry run)" : ""} ${result.status}`;
  if (result.steps.length === 0) return head;
  return `${head}: ${result.steps
    .map((s) => `${s.name} ${s.status}${s.counts ? ` ${formatCounts(s.counts)}` : ""}${s.error ? ` (${s.error})` : ""}`)
    .join("; ")}`;
}

/**
 * An in-memory copy of `db` for a dry run. A WAL database's image marks the
 * WAL format in its header (bytes 18 and 19), which an in-memory database
 * cannot open, so the copy is switched to the rollback-journal format.
 */
function inMemoryCopy(db: Database): Database {
  const image = db.serialize();
  if (image.length > 19 && image[18] === 2 && image[19] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return Database.deserialize(image);
}

/** Runs the maintenance steps once per MAINTENANCE_VERSION (see the module comment). */
export async function runKnowledgeMaintenance(deps: KnowledgeMaintenanceDeps): Promise<KnowledgeMaintenanceResult> {
  const dryRun = deps.dryRun ?? false;
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: KnowledgeMaintenanceResult = {
    version: MAINTENANCE_VERSION,
    status: "ran",
    dryRun,
    steps: [],
    recorded: false,
  };
  if (!isMaintenanceEnabled(deps.env)) {
    result.status = "disabled";
    log(`${maintenanceSummary(result)} (${MAINTENANCE_ENV})`);
    return result;
  }
  if (!deps.force && !dryRun && maintenanceRunOf(deps.db, MAINTENANCE_VERSION)) {
    result.status = "already-ran";
    return result;
  }

  const db = dryRun ? inMemoryCopy(deps.db) : deps.db;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? MAINTENANCE_BUDGET_MS);
  const ctx: MaintenanceStepContext = { db, knowledgeDir: deps.knowledgeDir, dryRun, deps, deadline, now };
  try {
    const completed = deps.force ? new Set<MaintenanceStepName>() : completedMaintenanceSteps(db, MAINTENANCE_VERSION);
    for (const name of STEP_ORDER) {
      if (completed.has(name)) {
        result.steps.push({ name, status: "done", ms: 0 });
        continue;
      }
      const started = now();
      if (started > deadline) {
        result.steps.push({ name, status: "deferred", ms: 0 });
        continue;
      }
      const step = deps.steps?.[name] ?? DEFAULT_STEPS[name];
      try {
        const counts = await step(ctx);
        const incomplete = counts[STEP_INCOMPLETE_KEY];
        const partial = typeof incomplete === "number" && incomplete > 0;
        const done: MaintenanceStepResult = { name, status: partial ? "partial" : "ok", counts, ms: now() - started };
        result.steps.push(done);
        if (!partial) recordMaintenanceStep(db, MAINTENANCE_VERSION, done);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[knowledge-maintenance] step ${name} failed:`, err);
        result.steps.push({ name, status: "error", error: message, ms: now() - started });
      }
    }
  } finally {
    if (dryRun) db.close();
  }

  if (result.steps.some((s) => s.status !== "ok" && s.status !== "done")) result.status = "incomplete";
  else if (!dryRun) {
    recordMaintenanceRun(deps.db, MAINTENANCE_VERSION);
    result.recorded = true;
  }
  log(maintenanceSummary(result));
  return result;
}

export interface CorpusSyncThenMaintainDeps {
  sync: () => Promise<void>;
  maintain: () => Promise<unknown>;
  /** Whether the collector is draining: checked before each phase. */
  draining: () => boolean;
  error?: (line: string, err: unknown) => void;
}

/**
 * The boot's corpus sync followed by maintenance. Maintenance reads the index
 * as the corpus, so it runs only when the sync completed: after a failed sync
 * it would supersede, draft and re-mark against a stale or partial index.
 * Never throws; returns which way it went.
 */
export async function syncCorpusThenMaintain(
  deps: CorpusSyncThenMaintainDeps
): Promise<"maintained" | "sync-failed" | "draining"> {
  const error = deps.error ?? ((line: string, err: unknown) => console.error(line, err));
  if (deps.draining()) return "draining";
  try {
    await deps.sync();
  } catch (err) {
    if (deps.draining()) return "draining";
    error("[knowledge] corpus sync failed; knowledge maintenance skipped until the next boot:", err);
    return "sync-failed";
  }
  if (deps.draining()) return "draining";
  try {
    await deps.maintain();
  } catch (err) {
    error("[knowledge-maintenance] run failed:", err);
  }
  return "maintained";
}

/**
 * The collector's boot call: runs the routine over its own database and
 * knowledge dir, with the model judge wired only when maintenanceJudgeEnabled.
 * Never throws.
 */
export async function runBootKnowledgeMaintenance(
  db: Database,
  knowledgeSync: KnowledgeSync,
  knowledgeDir: string
): Promise<KnowledgeMaintenanceResult | null> {
  try {
    const judged = maintenanceJudgeEnabled(db);
    const backend = judged ? new LocalMarkdownBackend(db, null, {}, knowledgeDir) : null;
    return await runKnowledgeMaintenance({
      db,
      knowledgeDir,
      syncDrafts: (projectId) => knowledgeSync.syncDrafts(projectId),
      ...(backend
        ? {
            judge: runClaudeContradictionJudge,
            readAcceptedDoc: (projectId: string, slug: string) => backend.readAcceptedDoc(projectId, slug),
          }
        : {}),
    });
  } catch (err) {
    console.error("[knowledge-maintenance] run failed:", err);
    return null;
  }
}
