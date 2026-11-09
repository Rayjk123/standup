import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type {
  PipelineAttemptStatus,
  PipelineDefinition,
  PipelineFacts,
  PipelineOverride,
  PipelineRun,
  PipelineRunStatus,
  PipelineStageAttempt,
  PipelineWaitingKind,
  PipelineDisabledReason,
  PipelineWorker,
  PipelineWorkerState,
  PipelineDecision,
  PipelineDecisionKind,
  PipelinePresetId,
  PipelinePark,
  PipelineParkBy,
} from "@standup/shared";

/**
 * Delivery-pipeline persistence (migration 067): each owner's configuration
 * layers, and one run per launch with its stage attempts. A run stores the
 * definition it was started with, so later configuration changes never
 * reshape a run in flight.
 */

interface ConfigRow {
  owner: string;
  project_id: string;
  override_json: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  launch_id: string;
  owner: string;
  project_id: string | null;
  definition_json: string;
  definition_hash: string;
  current_stage: string;
  status: string;
  waiting_reason: string | null;
  waiting_kind: string | null;
  flagged_job_id: string | null;
  flagged_job_note: string | null;
  facts_json: string;
  stop_blocks: number;
  stage_entered_at: string;
  epoch: number | null;
  disabled_reason: string | null;
  review_handoff_at: string | null;
  launch_override_json: string | null;
  preset: string | null;
  parked_reason: string | null;
  parked_job_id: string | null;
  parked_by: string | null;
  parked_actor: string | null;
  parked_at: string | null;
  parked_messages_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  owner: string;
  run_id: string | null;
  job_id: string | null;
  project_id: string | null;
  stage: string | null;
  kind: string;
  reason: string;
  actor: string;
  detail_json: string | null;
  created_at: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  stage_id: string;
  attempt: number;
  status: string;
  evidence_json: string | null;
  reason: string | null;
  session_id: string | null;
  next_stage: string | null;
  epoch: number | null;
  created_at: string;
}

/** The project key of a configuration row: '' is the owner's global layer. */
function configKey(projectId: string | null | undefined): string {
  return projectId ?? "";
}

function parseObject<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    // A malformed blob reads as the fallback rather than failing the read.
    return fallback;
  }
}

/** The strings of a JSON array; anything else reads as none. */
function parseStringList(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // A malformed blob reads as an empty list rather than failing the read.
    return [];
  }
}

/** The owner's override for `projectId` (null or omitted: the global layer), or null when unset. */
export function getPipelineConfig(db: Database, owner: string, projectId?: string | null): PipelineOverride | null {
  const row = db
    .query("SELECT * FROM pipeline_configs WHERE owner = ? AND project_id = ?")
    .get(owner, configKey(projectId)) as ConfigRow | null;
  return row ? parseObject<PipelineOverride>(row.override_json, {}) : null;
}

/** When the owner's override for `projectId` (null: the global layer) was last written, or null when unset. */
export function getPipelineConfigVersion(db: Database, owner: string, projectId?: string | null): string | null {
  const row = db
    .query("SELECT updated_at FROM pipeline_configs WHERE owner = ? AND project_id = ?")
    .get(owner, configKey(projectId)) as { updated_at: string } | null;
  return row?.updated_at ?? null;
}

/** Replaces the owner's override for `projectId` (null: the global layer). */
export function setPipelineConfig(
  db: Database,
  owner: string,
  projectId: string | null,
  override: PipelineOverride
): void {
  // updated_at is the layer's version (getPipelineConfigVersion): every write
  // moves it forward, even two within the same millisecond.
  const previous = getPipelineConfigVersion(db, owner, projectId);
  let at = Date.now();
  const before = previous ? Date.parse(previous) : NaN;
  if (Number.isFinite(before) && before >= at) at = before + 1;
  db.run(
    `INSERT INTO pipeline_configs (owner, project_id, override_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner, project_id) DO UPDATE SET override_json = excluded.override_json, updated_at = excluded.updated_at`,
    [owner, configKey(projectId), JSON.stringify(override), new Date(at).toISOString()]
  );
}

/** Removes the owner's override for `projectId`; true when one existed. */
export function deletePipelineConfig(db: Database, owner: string, projectId: string | null): boolean {
  const result = db.run("DELETE FROM pipeline_configs WHERE owner = ? AND project_id = ?", [owner, configKey(projectId)]);
  return result.changes > 0;
}

/** Every override the owner has saved, the global layer (projectId null) first. */
export function listPipelineConfigs(
  db: Database,
  owner: string
): Array<{ projectId: string | null; override: PipelineOverride; updatedAt: string }> {
  const rows = db
    .query("SELECT * FROM pipeline_configs WHERE owner = ? ORDER BY project_id")
    .all(owner) as ConfigRow[];
  return rows.map((r) => ({
    projectId: r.project_id === "" ? null : r.project_id,
    override: parseObject<PipelineOverride>(r.override_json, {}),
    updatedAt: r.updated_at,
  }));
}

function toAttempt(row: AttemptRow): PipelineStageAttempt {
  let evidence: unknown;
  if (row.evidence_json !== null) {
    try {
      evidence = JSON.parse(row.evidence_json) as unknown;
    } catch {
      // Unreadable evidence is dropped rather than failing the run read.
      evidence = undefined;
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    attempt: row.attempt,
    status: row.status as PipelineAttemptStatus,
    ...(evidence !== undefined ? { evidence } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.next_stage !== null ? { nextStage: row.next_stage } : {}),
    epoch: row.epoch ?? 0,
    createdAt: row.created_at,
  };
}

function attemptsFor(db: Database, runIds: string[]): Map<string, PipelineStageAttempt[]> {
  const out = new Map<string, PipelineStageAttempt[]>();
  if (runIds.length === 0) return out;
  const rows = db
    .query(
      `SELECT * FROM pipeline_stage_attempts WHERE run_id IN (${runIds.map(() => "?").join(", ")})
       ORDER BY created_at, rowid`
    )
    .all(...runIds) as AttemptRow[];
  for (const row of rows) {
    const list = out.get(row.run_id) ?? [];
    list.push(toAttempt(row));
    out.set(row.run_id, list);
  }
  return out;
}

interface WorkerRow {
  launch_id: string;
  status: string;
  has_session: number;
  ended_at: string | null;
  session_status: string | null;
  superseded: number;
}

/** A SQLite `datetime('now')` value ("YYYY-MM-DD HH:MM:SS", UTC) as ISO-8601; an ISO value is kept. */
function isoTime(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
}

/**
 * The worker state of each of `launchIds` that has a launch row (see
 * PipelineWorkerState). A launch is live under the rule the Persona job
 * queries use: starting or running, with no session yet or one neither ended
 * nor marked done at turn end (a later prompt sets it running again). A newer
 * link is a later persona_job_launches row of the same job.
 */
function workersFor(db: Database, launchIds: string[]): Map<string, PipelineWorker> {
  const out = new Map<string, PipelineWorker>();
  const ids = [...new Set(launchIds)];
  if (ids.length === 0) return out;
  const rows = db
    .query(
      `SELECT l.id AS launch_id, l.status,
              (l.session_id IS NOT NULL AND s.id IS NOT NULL) AS has_session,
              s.ended_at, s.status AS session_status,
              EXISTS (
                SELECT 1 FROM persona_job_launches mine
                JOIN persona_job_launches later ON later.job_id = mine.job_id AND later.rowid > mine.rowid
                WHERE mine.launch_id = l.id
              ) AS superseded
         FROM launches l LEFT JOIN sessions s ON s.id = l.session_id
        WHERE l.id IN (${ids.map(() => "?").join(", ")})`
    )
    .all(...ids) as WorkerRow[];
  for (const row of rows) {
    const sessionLive = row.ended_at === null && row.session_status !== "done";
    const live = (row.status === "starting" || row.status === "running") && (!row.has_session || sessionLive);
    const state: PipelineWorkerState = live ? "live" : row.superseded ? "superseded" : "ended";
    out.set(row.launch_id, { state, ...(row.ended_at !== null ? { endedAt: isoTime(row.ended_at) } : {}) });
  }
  return out;
}

function toRun(row: RunRow, attempts: PipelineStageAttempt[], worker?: PipelineWorker): PipelineRun {
  return {
    id: row.id,
    launchId: row.launch_id,
    owner: row.owner,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    definition: parseObject<PipelineDefinition>(row.definition_json, { version: 1, stages: [] }),
    definitionHash: row.definition_hash,
    currentStage: row.current_stage,
    status: row.status as PipelineRunStatus,
    ...(row.waiting_reason !== null ? { waitingReason: row.waiting_reason } : {}),
    ...(row.waiting_kind ? { waitingKind: row.waiting_kind as PipelineWaitingKind } : {}),
    ...(row.flagged_job_id ? { flaggedJob: { id: row.flagged_job_id, note: row.flagged_job_note ?? "" } } : {}),
    facts: parseObject<PipelineFacts>(row.facts_json, {}),
    stopBlocks: row.stop_blocks,
    stageEnteredAt: row.stage_entered_at,
    epoch: row.epoch ?? 0,
    ...(row.status === "disabled" && row.disabled_reason ? { disabledReason: row.disabled_reason as PipelineDisabledReason } : {}),
    ...(row.review_handoff_at ? { reviewHandoffAt: row.review_handoff_at } : {}),
    ...(worker ? { worker } : {}),
    ...(row.preset === "full" || row.preset === "light" ? { preset: row.preset as PipelinePresetId } : {}),
    ...(row.launch_override_json ? { launchOverride: parseObject<PipelineOverride>(row.launch_override_json, {}) } : {}),
    ...(row.parked_at
      ? {
          parked: {
            reason: row.parked_reason ?? "",
            ...(row.parked_job_id ? { waitingOnJobId: row.parked_job_id } : {}),
            by: (row.parked_by === "persona" ? "persona" : "worker") as PipelineParkBy,
            actor: row.parked_actor ?? "",
            at: row.parked_at,
            ...(row.parked_messages_json ? { queuedMessageIds: parseStringList(row.parked_messages_json) } : {}),
          },
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts,
  };
}

function hydrate(db: Database, rows: RunRow[]): PipelineRun[] {
  const attempts = attemptsFor(db, rows.map((r) => r.id));
  const workers = workersFor(db, rows.map((r) => r.launch_id));
  return rows.map((r) => toRun(r, attempts.get(r.id) ?? [], workers.get(r.launch_id)));
}

export interface CreatePipelineRunInput {
  launchId: string;
  owner: string;
  projectId?: string | null;
  definition: PipelineDefinition;
  definitionHash: string;
  /** Defaults to "active". */
  status?: PipelineRunStatus;
  facts?: PipelineFacts;
  /** Defaults to "start". */
  currentStage?: string;
  /** Why a disabled run is off; ignored for any other status. */
  disabledReason?: PipelineDisabledReason;
  /** The preset the definition was resolved from. */
  preset?: PipelinePresetId;
  /** The launch's own configuration layer, when it had one. */
  launchOverride?: PipelineOverride | null;
}

/** Starts a run for a launch. A launch has at most one run (launch_id is UNIQUE). */
export function createPipelineRun(db: Database, input: CreatePipelineRunInput): PipelineRun {
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = input.status ?? "active";
  db.run(
    `INSERT INTO pipeline_runs
       (id, launch_id, owner, project_id, definition_json, definition_hash, current_stage, status,
        facts_json, stop_blocks, stage_entered_at, created_at, updated_at, disabled_reason, preset, launch_override_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.launchId,
      input.owner,
      input.projectId ?? null,
      JSON.stringify(input.definition),
      input.definitionHash,
      input.currentStage ?? "start",
      status,
      JSON.stringify(input.facts ?? {}),
      now,
      now,
      now,
      status === "disabled" ? (input.disabledReason ?? "other") : null,
      input.preset ?? null,
      input.launchOverride ? JSON.stringify(input.launchOverride) : null,
    ]
  );
  return getPipelineRun(db, id)!;
}

/** The run with `id`, with its attempts oldest first, or null. */
export function getPipelineRun(db: Database, id: string): PipelineRun | null {
  const row = db.query("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as RunRow | null;
  return row ? hydrate(db, [row])[0]! : null;
}

/** The run started for `launchId`, or null. */
export function getPipelineRunByLaunch(db: Database, launchId: string): PipelineRun | null {
  const row = db.query("SELECT * FROM pipeline_runs WHERE launch_id = ?").get(launchId) as RunRow | null;
  return row ? hydrate(db, [row])[0]! : null;
}

/** The runs of any of `launchIds`, oldest first. */
export function listPipelineRunsByLaunches(db: Database, launchIds: string[]): PipelineRun[] {
  if (launchIds.length === 0) return [];
  const rows = db
    .query(
      `SELECT * FROM pipeline_runs WHERE launch_id IN (${launchIds.map(() => "?").join(", ")})
       ORDER BY created_at, rowid`
    )
    .all(...launchIds) as RunRow[];
  return hydrate(db, rows);
}

/** Every run still open (active or waiting on its owner), oldest first. */
export function listOpenPipelineRuns(db: Database): PipelineRun[] {
  const rows = db
    .query("SELECT * FROM pipeline_runs WHERE status IN ('active', 'waiting_user') ORDER BY created_at, rowid")
    .all() as RunRow[];
  return hydrate(db, rows);
}

/** Every run parked waiting on job `jobId`, oldest first. */
export function listParkedPipelineRunsOnJob(db: Database, jobId: string): PipelineRun[] {
  const rows = db
    .query("SELECT * FROM pipeline_runs WHERE parked_job_id = ? AND parked_at IS NOT NULL ORDER BY created_at, rowid")
    .all(jobId) as RunRow[];
  return hydrate(db, rows);
}

export interface UpdatePipelineRunPatch {
  currentStage?: string;
  status?: PipelineRunStatus;
  /** null clears the reason. */
  waitingReason?: string | null;
  facts?: PipelineFacts;
  stopBlocks?: number;
  stageEnteredAt?: string;
  /** null clears it. */
  waitingKind?: PipelineWaitingKind | null;
  /** null clears it. */
  flaggedJob?: { id: string; note: string } | null;
  epoch?: number;
  /** null clears it. */
  disabledReason?: PipelineDisabledReason | null;
  /** null clears it. */
  reviewHandoffAt?: string | null;
  /** Replaces the frozen definition (with its hash) — only for a run that hasn't got past coding. */
  definition?: { definition: PipelineDefinition; hash: string; preset: PipelinePresetId };
  /** null clears it. */
  launchOverride?: PipelineOverride | null;
}

/**
 * An updated_at stamp strictly after `previous`: now, or `previous` + 1 ms
 * when the clock hasn't moved past it — so every write gives the row a new
 * stamp and a compare-and-set on it never matches a stale read.
 */
function nextStamp(previous: string | null | undefined): string {
  const now = Date.now();
  const prev = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isFinite(prev) && prev >= now ? prev + 1 : now).toISOString();
}

/** Applies the given fields to a run and stamps updated_at; null when no such run. */
export function updatePipelineRun(db: Database, id: string, patch: UpdatePipelineRunPatch): PipelineRun | null {
  const current = db.query("SELECT updated_at FROM pipeline_runs WHERE id = ?").get(id) as { updated_at: string } | null;
  if (!current) return null;
  const { sets, values } = patchColumns(patch, current.updated_at);
  db.run(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
  return getPipelineRun(db, id);
}

/**
 * Applies `patch` only while the run is still where its caller read it — at
 * `expected.currentStage`, last written at `expected.updatedAt`. Returns the
 * updated run, or null when the run moved (or no longer exists) in between:
 * the caller's read is stale and nothing was written.
 */
export function updatePipelineRunIf(
  db: Database,
  id: string,
  expected: { currentStage: string; updatedAt: string },
  patch: UpdatePipelineRunPatch
): PipelineRun | null {
  const { sets, values } = patchColumns(patch, expected.updatedAt);
  const result = db.run(`UPDATE pipeline_runs SET ${sets.join(", ")} WHERE id = ? AND current_stage = ? AND updated_at = ?`, [
    ...values,
    id,
    expected.currentStage,
    expected.updatedAt,
  ]);
  return result.changes > 0 ? getPipelineRun(db, id) : null;
}

function patchColumns(
  patch: UpdatePipelineRunPatch,
  previousStamp: string
): { sets: string[]; values: Array<string | number | null> } {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.waitingKind !== undefined) {
    sets.push("waiting_kind = ?");
    values.push(patch.waitingKind);
  }
  if (patch.flaggedJob !== undefined) {
    sets.push("flagged_job_id = ?", "flagged_job_note = ?");
    values.push(patch.flaggedJob?.id ?? null, patch.flaggedJob?.note ?? null);
  }
  if (patch.currentStage !== undefined) {
    sets.push("current_stage = ?");
    values.push(patch.currentStage);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.waitingReason !== undefined) {
    sets.push("waiting_reason = ?");
    values.push(patch.waitingReason);
  }
  if (patch.facts !== undefined) {
    sets.push("facts_json = ?");
    values.push(JSON.stringify(patch.facts));
  }
  if (patch.stopBlocks !== undefined) {
    sets.push("stop_blocks = ?");
    values.push(patch.stopBlocks);
  }
  if (patch.stageEnteredAt !== undefined) {
    sets.push("stage_entered_at = ?");
    values.push(patch.stageEnteredAt);
  }
  if (patch.epoch !== undefined) {
    sets.push("epoch = ?");
    values.push(patch.epoch);
  }
  if (patch.disabledReason !== undefined) {
    sets.push("disabled_reason = ?");
    values.push(patch.disabledReason);
  }
  if (patch.reviewHandoffAt !== undefined) {
    sets.push("review_handoff_at = ?");
    values.push(patch.reviewHandoffAt);
  }
  if (patch.definition !== undefined) {
    sets.push("definition_json = ?", "definition_hash = ?", "preset = ?");
    values.push(JSON.stringify(patch.definition.definition), patch.definition.hash, patch.definition.preset);
  }
  if (patch.launchOverride !== undefined) {
    sets.push("launch_override_json = ?");
    values.push(patch.launchOverride ? JSON.stringify(patch.launchOverride) : null);
  }
  sets.push("updated_at = ?");
  values.push(nextStamp(previousStamp));
  return { sets, values };
}

export interface RecordPipelineAttemptInput {
  /** The attempt's id when the caller named files after it beforehand; a fresh UUID otherwise. */
  id?: string;
  stageId: string;
  status: PipelineAttemptStatus;
  evidence?: unknown;
  reason?: string;
  sessionId?: string;
  nextStage?: string;
  /** The epoch to record it in; the run's current epoch by default. */
  epoch?: number;
}

/**
 * Sets which Persona job the run flagged and the note it left there (null
 * clears it) without touching the run's updated_at: the flag is bookkeeping
 * about the job, not a move of the run, so it never makes a concurrent
 * advance's compare-and-set stale.
 */
export function setPipelineRunFlaggedJob(db: Database, id: string, flag: { id: string; note: string } | null): void {
  db.run("UPDATE pipeline_runs SET flagged_job_id = ?, flagged_job_note = ? WHERE id = ?", [flag?.id ?? null, flag?.note ?? null, id]);
}

/**
 * Marks (`at`, an ISO stamp) or clears (null) the review-agent gate's hand-off
 * of the code review to the run's worker, without touching updated_at — like the job
 * flag, it is bookkeeping rather than a move of the run.
 */
export function setPipelineRunReviewHandoff(db: Database, id: string, at: string | null): void {
  db.run("UPDATE pipeline_runs SET review_handoff_at = ? WHERE id = ?", [at, id]);
}

/**
 * Parks the run (`park`) or clears its park (null) without touching
 * updated_at: parking says the worker waits, not that the run moved, so it
 * never makes a concurrent advance's compare-and-set stale. Returns whether
 * anything changed — clearing a run that isn't parked changes nothing.
 */
export function setPipelineRunPark(db: Database, id: string, park: PipelinePark | null): boolean {
  if (!park) {
    return (
      db.run(
        `UPDATE pipeline_runs SET parked_reason = NULL, parked_job_id = NULL, parked_by = NULL, parked_actor = NULL, parked_at = NULL,
           parked_messages_json = NULL
         WHERE id = ? AND parked_at IS NOT NULL`,
        [id]
      ).changes > 0
    );
  }
  return (
    db.run(
      `UPDATE pipeline_runs SET parked_reason = ?, parked_job_id = ?, parked_by = ?, parked_actor = ?, parked_at = ?, parked_messages_json = ?
       WHERE id = ?`,
      [
        park.reason,
        park.waitingOnJobId ?? null,
        park.by,
        park.actor,
        park.at,
        park.queuedMessageIds && park.queuedMessageIds.length > 0 ? JSON.stringify(park.queuedMessageIds) : null,
        id,
      ]
    ).changes > 0
  );
}

/** Clears the run's open review hand-off; true when there was one to take (each hand-off is taken once). */
export function takePipelineRunReviewHandoff(db: Database, id: string): boolean {
  return db.run("UPDATE pipeline_runs SET review_handoff_at = NULL WHERE id = ? AND review_handoff_at IS NOT NULL", [id]).changes > 0;
}

/**
 * Records an attempt at a stage of `runId`, numbered 1 + the run's prior
 * attempts at that stage (across every epoch), and returns it.
 */
export function recordPipelineAttempt(
  db: Database,
  runId: string,
  input: RecordPipelineAttemptInput
): PipelineStageAttempt {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  db.transaction(() => {
    const prior = db
      .query("SELECT COUNT(*) AS n FROM pipeline_stage_attempts WHERE run_id = ? AND stage_id = ?")
      .get(runId, input.stageId) as { n: number };
    db.run(
      `INSERT INTO pipeline_stage_attempts
         (id, run_id, stage_id, attempt, status, evidence_json, reason, session_id, next_stage, created_at, epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT epoch FROM pipeline_runs WHERE id = ?), 0))`,
      [
        id,
        runId,
        input.stageId,
        prior.n + 1,
        input.status,
        input.evidence === undefined ? null : JSON.stringify(input.evidence),
        input.reason ?? null,
        input.sessionId ?? null,
        input.nextStage ?? null,
        now,
        input.epoch ?? null,
        runId,
      ]
    );
  })();
  const row = db.query("SELECT * FROM pipeline_stage_attempts WHERE id = ?").get(id) as AttemptRow;
  return toAttempt(row);
}

export interface RecordPipelineDecisionInput {
  owner: string;
  runId?: string | null;
  jobId?: string | null;
  projectId?: string | null;
  stage?: string | null;
  kind: PipelineDecisionKind;
  reason: string;
  actor: string;
  detail?: Record<string, unknown>;
}

function toDecision(row: DecisionRow): PipelineDecision {
  const detail = parseObject<Record<string, unknown> | null>(row.detail_json, null);
  return {
    id: row.id,
    owner: row.owner,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.stage ? { stage: row.stage } : {}),
    kind: row.kind as PipelineDecisionKind,
    reason: row.reason,
    actor: row.actor,
    ...(detail ? { detail } : {}),
    createdAt: row.created_at,
  };
}

/** Appends one of Persona's pipeline decisions to the owner's audit, and returns it. */
export function recordPipelineDecision(db: Database, input: RecordPipelineDecisionInput): PipelineDecision {
  const id = randomUUID();
  db.run(
    `INSERT INTO pipeline_decisions (id, owner, run_id, job_id, project_id, stage, kind, reason, actor, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.runId ?? null,
      input.jobId ?? null,
      input.projectId ?? null,
      input.stage ?? null,
      input.kind,
      input.reason,
      input.actor,
      input.detail ? JSON.stringify(input.detail) : null,
      new Date().toISOString(),
    ]
  );
  return toDecision(db.query("SELECT * FROM pipeline_decisions WHERE id = ?").get(id) as DecisionRow);
}

/** The most decisions listPipelineDecisions returns: the newest ones. */
export const MAX_LISTED_PIPELINE_DECISIONS = 500;

/**
 * The owner's newest recorded pipeline decisions (at most
 * MAX_LISTED_PIPELINE_DECISIONS), oldest first — of one job, one run or one
 * of the owner's own layers when given.
 */
export function listPipelineDecisions(
  db: Database,
  owner: string,
  opts: {
    jobId?: string;
    runId?: string;
    /** Only the changes to one of the owner's own layers: their default (`user`) or one project's. */
    layer?: { scope: "user" } | { scope: "project"; projectId: string };
  } = {}
): PipelineDecision[] {
  let where = "owner = ?";
  const params: string[] = [owner];
  if (opts.jobId) {
    where += " AND job_id = ?";
    params.push(opts.jobId);
  }
  if (opts.runId) {
    where += " AND run_id = ?";
    params.push(opts.runId);
  }
  if (opts.layer) {
    where += " AND kind = 'config' AND json_extract(detail_json, '$.scope') = ?";
    params.push(opts.layer.scope);
    if (opts.layer.scope === "project") {
      where += " AND project_id = ?";
      params.push(opts.layer.projectId);
    }
  }
  const rows = db
    .query(`SELECT * FROM pipeline_decisions WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_LISTED_PIPELINE_DECISIONS}`)
    .all(...params) as DecisionRow[];
  return rows.reverse().map(toDecision);
}
