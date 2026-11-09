import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { scheduleEndReason } from "@standup/shared";
import type {
  PersonaSchedule,
  PersonaScheduleRun,
  ScheduleCatchUpPolicy,
  ScheduleEndBound,
  ScheduleEndReason,
  ScheduleKind,
  ScheduleOverlapPolicy,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  ScheduleWatch,
} from "@standup/shared";
import { getLaunch } from "./launches.js";
import { getSession } from "./sessions.js";
import { getPersonaInboxItem, getPersonaJob, personaJobForLaunch } from "./persona.js";

/**
 * Persona's recurring schedules and their run history (migration 054).
 * Timestamps are UTC ISO-8601 strings, so lexical comparison is chronological.
 */

function nowIso(): string {
  return new Date().toISOString();
}

// ── Schedules ───────────────────────────────────────────────────────────────

interface ScheduleRow {
  id: string;
  owner: string;
  thread_id: string | null;
  title: string;
  cron: string;
  timezone: string;
  kind: string;
  note: string | null;
  brief: string | null;
  project_id: string | null;
  model: string | null;
  effort: string | null;
  /** 0: launches run without the delivery pipeline. NULL: with it. */
  pipeline: number | null;
  enabled: number;
  overlap: string;
  catch_up: string;
  ends_at: string | null;
  max_runs: number | null;
  run_count: number;
  ended_at: string | null;
  end_reason: string | null;
  watch: string | null;
  watch_skips: number | null;
  watch_changed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_outcome: string | null;
  last_outcome_detail: string | null;
}

function parseWatch(raw: string | null): ScheduleWatch | undefined {
  if (!raw) return undefined;
  try {
    const watch = JSON.parse(raw) as ScheduleWatch;
    return watch && typeof watch.kind === "string" ? watch : undefined;
  } catch {
    return undefined;
  }
}

function toSchedule(row: ScheduleRow): PersonaSchedule {
  const watch = parseWatch(row.watch);
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.thread_id ?? undefined,
    title: row.title,
    cron: row.cron,
    timezone: row.timezone,
    kind: row.kind as ScheduleKind,
    note: row.note ?? undefined,
    ...(watch
      ? { watch, watchSkips: row.watch_skips ?? 0, ...(row.watch_changed_at ? { watchChangedAt: row.watch_changed_at } : {}) }
      : {}),
    brief: row.brief ?? undefined,
    projectId: row.project_id ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    pipeline: row.pipeline === 0 ? false : undefined,
    enabled: row.enabled === 1,
    overlap: row.overlap as ScheduleOverlapPolicy,
    catchUp: row.catch_up as ScheduleCatchUpPolicy,
    ...(row.ends_at ? { endsAt: row.ends_at } : {}),
    ...(row.max_runs !== null ? { maxRuns: row.max_runs } : {}),
    runCount: row.run_count ?? 0,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.end_reason ? { endReason: row.end_reason as ScheduleEndReason } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastOutcome: (row.last_outcome as ScheduleRunStatus | null) ?? undefined,
    lastOutcomeDetail: row.last_outcome_detail ?? undefined,
  };
}

export interface CreatePersonaScheduleInput {
  owner: string;
  threadId?: string;
  title: string;
  cron: string;
  timezone: string;
  kind: ScheduleKind;
  note?: string;
  brief?: string;
  projectId?: string;
  model?: string;
  effort?: string;
  pipeline?: boolean;
  enabled?: boolean;
  overlap?: ScheduleOverlapPolicy;
  catchUp?: ScheduleCatchUpPolicy;
  endsAt?: string;
  maxRuns?: number;
  watch?: ScheduleWatch;
  /** The facts the watch starts from (ScheduleWatchFacts). */
  watchState?: ScheduleWatchFacts;
  createdBy: string;
  nextRunAt?: string | null;
}

/** What a watch saw: one line of state per thing it watches, keyed by its label. */
export type ScheduleWatchFacts = Record<string, string>;

export function createPersonaSchedule(db: Database, input: CreatePersonaScheduleInput): PersonaSchedule {
  const id = randomUUID();
  const at = nowIso();
  db.run(
    `INSERT INTO persona_schedules
       (id, owner, thread_id, title, cron, timezone, kind, note, brief, project_id, model, effort,
        pipeline, enabled, overlap, catch_up, ends_at, max_runs, watch, watch_state, watch_changed_at,
        created_by, created_at, updated_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.owner,
      input.threadId ?? null,
      input.title,
      input.cron,
      input.timezone,
      input.kind,
      input.note ?? null,
      input.brief ?? null,
      input.projectId ?? null,
      input.model ?? null,
      input.effort ?? null,
      input.pipeline === false ? 0 : null,
      input.enabled === false ? 0 : 1,
      input.overlap ?? "skip",
      input.catchUp ?? "run_once",
      input.endsAt ?? null,
      input.maxRuns ?? null,
      input.watch ? JSON.stringify(input.watch) : null,
      input.watch ? JSON.stringify(input.watchState ?? {}) : null,
      input.watch ? at : null,
      input.createdBy,
      at,
      at,
      input.nextRunAt ?? null,
    ]
  );
  return getPersonaSchedule(db, id)!;
}

export function getPersonaSchedule(db: Database, id: string): PersonaSchedule | null {
  const row = db.query("SELECT * FROM persona_schedules WHERE id = ?").get(id) as ScheduleRow | null;
  return row ? toSchedule(row) : null;
}

/** `owner`'s schedules, optionally only one thread's, by next run (paused ones last), then title. */
export function listPersonaSchedules(
  db: Database,
  owner: string,
  opts: { threadId?: string; enabledOnly?: boolean } = {}
): PersonaSchedule[] {
  const where = ["owner = ?"];
  const params: string[] = [owner];
  if (opts.threadId) {
    where.push("thread_id = ?");
    params.push(opts.threadId);
  }
  if (opts.enabledOnly) where.push("enabled = 1");
  const rows = db
    .query(
      `SELECT * FROM persona_schedules WHERE ${where.join(" AND ")}
        ORDER BY enabled DESC, next_run_at IS NULL, next_run_at ASC, title ASC, created_at ASC`
    )
    .all(...params) as ScheduleRow[];
  return rows.map(toSchedule);
}

export interface PersonaSchedulePatch {
  title?: string;
  cron?: string;
  timezone?: string;
  note?: string | null;
  brief?: string | null;
  projectId?: string | null;
  model?: string | null;
  effort?: string | null;
  /** false: launches run without the delivery pipeline; true or null: with it. */
  pipeline?: boolean | null;
  enabled?: boolean;
  overlap?: ScheduleOverlapPolicy;
  catchUp?: ScheduleCatchUpPolicy;
  /** null clears the bound. */
  endsAt?: string | null;
  maxRuns?: number | null;
  /** null reopens an ended schedule. */
  endedAt?: string | null;
  endReason?: ScheduleEndReason | null;
  nextRunAt?: string | null;
  /** null clears the watch (and what it saw). */
  watch?: ScheduleWatch | null;
  /** The facts a new watch starts from; written with watchChangedAt. */
  watchState?: ScheduleWatchFacts | null;
  watchChangedAt?: string | null;
  watchPending?: ScheduleWatchFacts | null;
  watchSkips?: number;
}

const PATCH_COLUMNS: Record<keyof PersonaSchedulePatch, string> = {
  title: "title",
  cron: "cron",
  timezone: "timezone",
  note: "note",
  brief: "brief",
  projectId: "project_id",
  model: "model",
  effort: "effort",
  pipeline: "pipeline",
  enabled: "enabled",
  overlap: "overlap",
  catchUp: "catch_up",
  endsAt: "ends_at",
  maxRuns: "max_runs",
  endedAt: "ended_at",
  endReason: "end_reason",
  nextRunAt: "next_run_at",
  watch: "watch",
  watchState: "watch_state",
  watchChangedAt: "watch_changed_at",
  watchPending: "watch_pending",
  watchSkips: "watch_skips",
};

export function updatePersonaSchedule(db: Database, id: string, patch: PersonaSchedulePatch): PersonaSchedule | null {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof PersonaSchedulePatch, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    if (key === "pipeline") params.push(value === false ? 0 : null);
    else if (typeof value === "object" && value !== null) params.push(JSON.stringify(value));
    else params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    params.push(nowIso());
    db.run(`UPDATE persona_schedules SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return getPersonaSchedule(db, id);
}

/** Stops a schedule from firing (no next slot) and records why as its last outcome. */
export function parkPersonaSchedule(db: Database, id: string, detail: string): void {
  db.run(
    "UPDATE persona_schedules SET next_run_at = NULL, last_outcome = 'failed', last_outcome_detail = ?, updated_at = ? WHERE id = ?",
    [detail, nowIso(), id]
  );
}

/** The facts a watched schedule's last wake (or the watch being set) saw; null with no watch or none stored. */
export function getPersonaScheduleWatchState(
  db: Database,
  id: string,
  which: "state" | "pending" = "state"
): ScheduleWatchFacts | null {
  const row = db.query("SELECT watch, watch_state, watch_pending FROM persona_schedules WHERE id = ?").get(id) as
    | { watch: string | null; watch_state: string | null; watch_pending: string | null }
    | null;
  const raw = which === "pending" ? row?.watch_pending : row?.watch_state;
  if (!row?.watch || !raw) return null;
  try {
    const state = JSON.parse(raw) as unknown;
    return state && typeof state === "object" && !Array.isArray(state) ? (state as ScheduleWatchFacts) : null;
  } catch {
    return null;
  }
}

/**
 * Records what a watched schedule saw: `state` becomes the watch's baseline,
 * `pending` the reading its latest wake reported (not yet handled by
 * Persona), `changedAt` the time it last saw a change; `skipped` counts a
 * run it skipped with nothing changed.
 */
export function recordPersonaScheduleWatch(
  db: Database,
  id: string,
  input: { state?: ScheduleWatchFacts; pending?: ScheduleWatchFacts; changedAt?: string } | { skipped: true }
): void {
  if ("skipped" in input) {
    db.run("UPDATE persona_schedules SET watch_skips = watch_skips + 1 WHERE id = ? AND watch IS NOT NULL", [id]);
    return;
  }
  const json = (facts: ScheduleWatchFacts | undefined) => (facts ? JSON.stringify(facts) : null);
  db.run(
    `UPDATE persona_schedules
        SET watch_state = COALESCE(?, watch_state), watch_pending = COALESCE(?, watch_pending),
            watch_changed_at = COALESCE(?, watch_changed_at)
      WHERE id = ? AND watch IS NOT NULL`,
    [json(input.state), json(input.pending), input.changedAt ?? null, id]
  );
}

/** Deletes `owner`'s schedule and its run history; false when there was none. */
export function deletePersonaSchedule(db: Database, id: string, owner: string): boolean {
  return db.transaction(() => {
    db.run("DELETE FROM persona_schedule_runs WHERE schedule_id = ? AND owner = ?", [id, owner]);
    return db.run("DELETE FROM persona_schedules WHERE id = ? AND owner = ?", [id, owner]).changes > 0;
  })();
}

/** `owner`'s enabled schedules whose next slot is at or before `now`, earliest first. */
export function listDuePersonaSchedules(db: Database, owner: string, now: string): PersonaSchedule[] {
  const rows = db
    .query(
      `SELECT * FROM persona_schedules
        WHERE owner = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC, created_at ASC`
    )
    .all(owner, now) as ScheduleRow[];
  return rows.map(toSchedule);
}

/** The earliest next slot among `owner`'s enabled schedules. */
export function nextPersonaScheduleDue(db: Database, owner: string): string | null {
  const row = db
    .query("SELECT MIN(next_run_at) AS t FROM persona_schedules WHERE owner = ? AND enabled = 1 AND next_run_at IS NOT NULL")
    .get(owner) as { t: string | null };
  return row.t;
}

// ── Runs ────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  schedule_id: string;
  owner: string;
  scheduled_for: string;
  trigger: string;
  status: string;
  reason: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
  job_id: string | null;
  launch_id: string | null;
  session_id: string | null;
  inbox_id: string | null;
}

function toRun(row: RunRow): PersonaScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    owner: row.owner,
    scheduledFor: row.scheduled_for,
    trigger: row.trigger as ScheduleRunTrigger,
    status: row.status as ScheduleRunStatus,
    reason: row.reason ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    jobId: row.job_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    inboxId: row.inbox_id ?? undefined,
  };
}

export function getPersonaScheduleRun(db: Database, id: string): PersonaScheduleRun | null {
  const row = db.query("SELECT * FROM persona_schedule_runs WHERE id = ?").get(id) as RunRow | null;
  return row ? toRun(row) : null;
}

/** A schedule's runs, newest first. */
export function listPersonaScheduleRuns(db: Database, scheduleId: string, limit = 50): PersonaScheduleRun[] {
  const rows = db
    .query(
      "SELECT * FROM persona_schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?"
    )
    .all(scheduleId, Math.max(1, Math.floor(limit))) as RunRow[];
  return rows.map(toRun);
}

/** `owner`'s runs in `statuses`, oldest first. */
export function listPersonaScheduleRunsByStatus(
  db: Database,
  owner: string,
  statuses: ScheduleRunStatus[]
): PersonaScheduleRun[] {
  if (statuses.length === 0) return [];
  const rows = db
    .query(
      `SELECT * FROM persona_schedule_runs WHERE owner = ? AND status IN (${statuses.map(() => "?").join(", ")})
        ORDER BY started_at ASC, rowid ASC`
    )
    .all(owner, ...statuses) as RunRow[];
  return rows.map(toRun);
}

/** The schedule's run still starting or running, if any (newest first). */
export function activePersonaScheduleRun(db: Database, scheduleId: string): PersonaScheduleRun | null {
  const row = db
    .query(
      `SELECT * FROM persona_schedule_runs WHERE schedule_id = ? AND status IN ('starting', 'running')
        ORDER BY started_at DESC, rowid DESC LIMIT 1`
    )
    .get(scheduleId) as RunRow | null;
  return row ? toRun(row) : null;
}

/** Records the run's outcome on its schedule, when it is the schedule's latest run. */
function recordLastOutcome(db: Database, run: PersonaScheduleRun): void {
  const latest = db
    .query("SELECT id FROM persona_schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(run.scheduleId) as { id: string } | null;
  if (latest?.id !== run.id) return;
  db.run("UPDATE persona_schedules SET last_outcome = ?, last_outcome_detail = ? WHERE id = ?", [
    run.status,
    run.error ?? run.reason ?? null,
    run.scheduleId,
  ]);
}

export interface ClaimPersonaScheduleRunInput {
  scheduleId: string;
  owner: string;
  /**
   * The `next_run_at` the caller read. The claim goes through only while the
   * schedule still holds it, so an edit, pause or another claimer in between
   * wins. Ignored for a manual run.
   */
  expectedNextRunAt?: string | null;
  /** The slot being run; the fire time for a manual run. */
  scheduledFor: string;
  trigger: ScheduleRunTrigger;
  /** The schedule's slot after this one (null: none). Not written for a manual run. */
  nextRunAt?: string | null;
  now: string;
  /** Records the slot skipped with this reason instead of starting it. */
  skipReason?: string;
}

export type ClaimPersonaScheduleRunResult =
  | { outcome: "started"; run: PersonaScheduleRun; schedule: PersonaSchedule }
  | { outcome: "skipped"; run: PersonaScheduleRun; schedule: PersonaSchedule }
  /** The schedule is gone, paused, or moved on (edited, or another claimer took the slot). */
  | { outcome: "stale" };

function scheduleBound(row: ScheduleRow): ScheduleEndBound {
  return {
    ...(row.ends_at ? { endsAt: row.ends_at } : {}),
    ...(row.max_runs !== null ? { maxRuns: row.max_runs } : {}),
  };
}

/**
 * Ends `owner`'s schedules whose endsAt has passed with no slot left to fire
 * (scheduleEndReason) — paused ones included — without running anything. A
 * schedule still holding a missed slot at or before endsAt is left for that
 * slot to fire as a catch-up first. Returns the schedules it ended.
 */
export function endExpiredPersonaSchedules(db: Database, owner: string, now: string = nowIso()): PersonaSchedule[] {
  const candidates = db
    .query(
      `SELECT id FROM persona_schedules
        WHERE owner = ? AND ended_at IS NULL AND ends_at IS NOT NULL AND ends_at < ?`
    )
    .all(owner, now) as Array<{ id: string }>;
  const ended: PersonaSchedule[] = [];
  for (const { id } of candidates) {
    // Re-read inside the transaction, so an edit or claim in between decides on the row as it now stands.
    const end = db.transaction((): PersonaSchedule | null => {
      const row = db.query("SELECT * FROM persona_schedules WHERE id = ?").get(id) as ScheduleRow | null;
      if (!row || row.ended_at || !row.ends_at || row.ends_at >= now) return null;
      const reason = scheduleEndReason(scheduleBound(row), { runCount: row.run_count, nextRunAt: row.next_run_at, now });
      if (!reason) return null;
      db.run(
        "UPDATE persona_schedules SET next_run_at = NULL, enabled = 0, ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ?",
        [now, reason, now, id]
      );
      return getPersonaSchedule(db, id);
    });
    const schedule = end.immediate();
    if (schedule) ended.push(schedule);
  }
  return ended;
}

/**
 * Gives back the max_runs count a run took at its claim, for a run that never
 * launched (its launch was held, refused, or failed to start from the launch
 * queue). Once per run: the run is marked uncounted. `nextRunAt` is the
 * schedule's next slot from now, worked out by the caller from the schedule
 * as `nextSlotOf` reads it (`null`: none, or unreadable). A schedule the run
 * ended on max_runs is reopened there — paused instead when the run was a
 * Run now, which may have ended a paused schedule — or, when endsAt leaves no
 * slot there or there is none, stays ended. Returns the schedule as it now
 * stands; null when the run wasn't counted.
 */
export function releasePersonaScheduleRunCount(
  db: Database,
  runId: string,
  nextSlotOf: (schedule: PersonaSchedule) => string | null,
  now: string = nowIso()
): PersonaSchedule | null {
  const release = db.transaction((): PersonaSchedule | null => {
    const counted = db.query("SELECT schedule_id, trigger FROM persona_schedule_runs WHERE id = ? AND counted = 1").get(runId) as
      | { schedule_id: string; trigger: string }
      | null;
    if (!counted) return null;
    db.run("UPDATE persona_schedule_runs SET counted = 0 WHERE id = ?", [runId]);
    const row = db.query("SELECT * FROM persona_schedules WHERE id = ?").get(counted.schedule_id) as ScheduleRow | null;
    if (!row || row.run_count <= 0) return null;
    const runCount = row.run_count - 1;
    if (row.ended_at && row.end_reason === "max_runs") {
      const nextRunAt = nextSlotOf(toSchedule(row));
      const end = nextRunAt === null ? "max_runs" : scheduleEndReason(scheduleBound(row), { runCount, nextRunAt, now });
      if (end) {
        db.run("UPDATE persona_schedules SET run_count = ?, end_reason = ?, updated_at = ? WHERE id = ?", [runCount, end, now, row.id]);
      } else if (counted.trigger === "manual") {
        // Run now may have ended a paused schedule; it comes back paused, for the owner to resume.
        db.run(
          `UPDATE persona_schedules SET run_count = ?, next_run_at = NULL, ended_at = NULL, end_reason = NULL, updated_at = ?
            WHERE id = ?`,
          [runCount, now, row.id]
        );
      } else {
        db.run(
          `UPDATE persona_schedules SET run_count = ?, enabled = 1, next_run_at = ?, ended_at = NULL, end_reason = NULL, updated_at = ?
            WHERE id = ?`,
          [runCount, nextRunAt, now, row.id]
        );
      }
    } else {
      db.run("UPDATE persona_schedules SET run_count = ? WHERE id = ?", [runCount, row.id]);
    }
    return getPersonaSchedule(db, row.id);
  });
  return release.immediate();
}

/**
 * Claims one slot of a schedule, atomically: checks the schedule still holds
 * the `next_run_at` the caller read (not for a manual run), inserts the run —
 * `starting`, or `skipped` when `skipReason` is given or the overlap policy
 * finds a run still active — and advances `next_run_at` and `last_run_at`.
 * A run that starts counts toward `max_runs` (a manual one only before the
 * schedule has ended) and is marked `counted`; when the end bound
 * (scheduleEndReason) leaves no slot after this one, the schedule is ended
 * in the same transaction: disabled, `next_run_at` cleared, `ended_at` set.
 * A slot already in the history (another collector took it) is not run
 * again; the schedule is only advanced past it. Runs in an IMMEDIATE
 * transaction, so two processes sharing the database serialize on it.
 */
export function claimPersonaScheduleRun(
  db: Database,
  input: ClaimPersonaScheduleRunInput
): ClaimPersonaScheduleRunResult {
  const claim = db.transaction((): ClaimPersonaScheduleRunResult => {
    const row = db
      .query("SELECT * FROM persona_schedules WHERE id = ? AND owner = ?")
      .get(input.scheduleId, input.owner) as ScheduleRow | null;
    if (!row) return { outcome: "stale" };
    const manual = input.trigger === "manual";
    if (!manual) {
      if (row.enabled !== 1) return { outcome: "stale" };
      if ((row.next_run_at ?? null) !== (input.expectedNextRunAt ?? null)) return { outcome: "stale" };
    }

    let skipReason = input.skipReason;
    if (!skipReason && row.overlap === "skip") {
      const active = activePersonaScheduleRun(db, row.id);
      if (active) skipReason = `the previous run (${active.id.slice(0, 8)}) is still ${active.status}`;
    }

    // A run that starts counts toward max_runs — a manual one too, while the
    // schedule hasn't ended (one past its end is outside the bound).
    const counts = !skipReason && !(manual && row.ended_at);
    const id = randomUUID();
    const inserted = db.run(
      `INSERT OR IGNORE INTO persona_schedule_runs
         (id, schedule_id, owner, scheduled_for, trigger, status, reason, started_at, ended_at, counted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        row.id,
        row.owner,
        input.scheduledFor,
        input.trigger,
        skipReason ? "skipped" : "starting",
        skipReason ?? null,
        input.now,
        skipReason ? input.now : null,
        counts ? 1 : 0,
      ]
    ).changes;

    if (manual) {
      if (inserted > 0 && counts) {
        const runCount = row.run_count + 1;
        // Run now doesn't move the cadence; it can only use up the last of maxRuns.
        if (row.max_runs !== null && runCount >= row.max_runs) {
          db.run(
            `UPDATE persona_schedules SET next_run_at = NULL, enabled = 0, run_count = ?, ended_at = ?, end_reason = 'max_runs', updated_at = ?
              WHERE id = ?`,
            [runCount, input.now, input.now, row.id]
          );
        } else {
          db.run("UPDATE persona_schedules SET run_count = ? WHERE id = ?", [runCount, row.id]);
        }
      }
    } else {
      // A slot another claimer took is already in run_count.
      const runCount = row.run_count + (inserted > 0 && counts ? 1 : 0);
      const nextRunAt = input.nextRunAt ?? null;
      const end = scheduleEndReason(scheduleBound(row), { runCount, nextRunAt, now: input.now });
      if (end) {
        db.run(
          `UPDATE persona_schedules SET next_run_at = NULL, enabled = 0, run_count = ?, ended_at = ?, end_reason = ?, updated_at = ?
            WHERE id = ?`,
          [runCount, input.now, end, input.now, row.id]
        );
      } else {
        db.run("UPDATE persona_schedules SET next_run_at = ?, run_count = ? WHERE id = ?", [nextRunAt, runCount, row.id]);
      }
    }
    if (inserted === 0) return { outcome: "stale" };
    db.run("UPDATE persona_schedules SET last_run_at = ? WHERE id = ?", [input.now, row.id]);
    const run = getPersonaScheduleRun(db, id)!;
    recordLastOutcome(db, run);
    const schedule = getPersonaSchedule(db, row.id)!;
    return skipReason ? { outcome: "skipped", run, schedule } : { outcome: "started", run, schedule };
  });
  return claim.immediate();
}

export interface SettlePersonaScheduleRunInput {
  status: ScheduleRunStatus;
  reason?: string;
  error?: string;
  endedAt?: string;
  jobId?: string;
  launchId?: string;
  sessionId?: string;
  inboxId?: string;
}

/**
 * Updates a run's status and links, and the schedule's last outcome when it
 * is the latest run. A run set starting or running again (a launch that went
 * through after recovery gave up on it) loses its end time and error.
 */
export function settlePersonaScheduleRun(
  db: Database,
  runId: string,
  input: SettlePersonaScheduleRunInput
): PersonaScheduleRun | null {
  const settled = input.status === "done" || input.status === "failed" || input.status === "skipped";
  db.run(
    `UPDATE persona_schedule_runs
        SET status = ?,
            reason = COALESCE(?, reason),
            error = ${settled ? "COALESCE(?, error)" : "?"},
            ended_at = ${settled ? "COALESCE(?, ended_at)" : "?"},
            job_id = COALESCE(?, job_id),
            launch_id = COALESCE(?, launch_id),
            session_id = COALESCE(?, session_id),
            inbox_id = COALESCE(?, inbox_id)
      WHERE id = ?`,
    [
      input.status,
      input.reason ?? null,
      input.error ?? null,
      input.endedAt ?? (settled ? nowIso() : null),
      input.jobId ?? null,
      input.launchId ?? null,
      input.sessionId ?? null,
      input.inboxId ?? null,
      runId,
    ]
  );
  const run = getPersonaScheduleRun(db, runId);
  if (run) recordLastOutcome(db, run);
  return run;
}

/**
 * Settles `owner`'s running runs whose work has finished, and fills in the
 * session a launched run bound to. A launch_job run is active while its job
 * is open (active or waiting on the owner), its launch is starting or running,
 * and its session (once bound) has not ended — the rule the active-launch cap
 * counts by. A wake_persona run is active while its inbox item is pending or
 * processing. Returns the runs it settled.
 */
export function reconcilePersonaScheduleRuns(db: Database, owner: string, now: string = nowIso()): PersonaScheduleRun[] {
  const settled: PersonaScheduleRun[] = [];
  for (const run of listPersonaScheduleRunsByStatus(db, owner, ["running"])) {
    if (run.launchId) {
      const launch = getLaunch(db, run.launchId);
      const session = launch?.sessionId ? getSession(db, launch.sessionId) : null;
      // A run recovered after a restart can predate its job's link to the
      // launch; with no job at all, the launch and its session decide.
      const job = run.jobId ? getPersonaJob(db, run.jobId) : (personaJobForLaunch(db, run.launchId)?.job ?? null);
      const jobOpen = !job || job.status === "active" || job.status === "waiting_user";
      const launchLive = !!launch && (launch.status === "starting" || launch.status === "running");
      const sessionLive = !session || (!session.endedAt && session.status !== "done");
      if ((launch?.sessionId && !run.sessionId) || (job && !run.jobId)) {
        settlePersonaScheduleRun(db, run.id, {
          status: "running",
          sessionId: run.sessionId ? undefined : launch?.sessionId,
          jobId: run.jobId ? undefined : job?.id,
        });
      }
      if (jobOpen && launchLive && sessionLive) continue;
      // A closed job is the run's verdict. Closing a job stops its workers,
      // which records their launches failed ("Stopped by you"), so the
      // launch's status only decides a run whose job is gone or still open.
      const jobDecides = !!job && !jobOpen;
      const failed = jobDecides ? job.status === "failed" : launch?.status === "failed";
      const outcome = jobDecides ? `job ${job.status}${job.outcome ? `: ${job.outcome}` : ""}` : undefined;
      const result = settlePersonaScheduleRun(db, run.id, {
        status: failed ? "failed" : "done",
        reason: outcome ? outcome.slice(0, 300) : undefined,
        error: failed && !jobDecides && launch?.error ? launch.error.slice(0, 500) : undefined,
        sessionId: launch?.sessionId,
        endedAt: session?.endedAt ? session.endedAt.toISOString() : now,
      });
      if (result) settled.push(result);
      continue;
    }
    if (run.inboxId) {
      const item = getPersonaInboxItem(db, run.inboxId);
      if (item && (item.status === "pending" || item.status === "processing")) continue;
      const result = settlePersonaScheduleRun(db, run.id, {
        status: item?.status === "failed" ? "failed" : "done",
        error: item?.status === "failed" ? item.error ?? "Persona's turn failed" : undefined,
        reason: item?.status === "cancelled" ? "the wake was cancelled" : undefined,
        endedAt: item?.processedAt ?? now,
      });
      if (result) settled.push(result);
      continue;
    }
    const result = settlePersonaScheduleRun(db, run.id, { status: "done", endedAt: now });
    if (result) settled.push(result);
  }
  return settled;
}

/** The id of `owner`'s inbox item queued under `coalesceKey` (any status), if one exists. */
export function personaInboxIdByCoalesceKey(db: Database, owner: string, coalesceKey: string): string | null {
  const row = db
    .query("SELECT id FROM persona_inbox WHERE owner = ? AND coalesce_key = ? ORDER BY created_at ASC LIMIT 1")
    .get(owner, coalesceKey) as { id: string } | null;
  return row?.id ?? null;
}

/** Deletes settled runs older than `olderThan`, keeping each schedule's newest `keep`. */
export function prunePersonaScheduleRuns(db: Database, owner: string, olderThan: string, keep = 50): number {
  return db.run(
    `DELETE FROM persona_schedule_runs
      WHERE owner = ? AND status IN ('done', 'failed', 'skipped') AND started_at < ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY started_at DESC, rowid DESC) AS n
              FROM persona_schedule_runs WHERE owner = ?
          ) WHERE n <= ?
        )`,
    [owner, olderThan, owner, keep]
  ).changes;
}
