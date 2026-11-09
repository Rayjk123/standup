import type { Database } from "bun:sqlite";
import type {
  CreateScheduleRequest,
  PersonaSchedule,
  PersonaScheduleRun,
  ScheduleCatchUpPolicy,
  ScheduleEndBound,
  ScheduleKind,
  ScheduleOverlapPolicy,
  ScheduleRunTrigger,
  ScheduleWatch,
  ScheduleWatchKind,
  UpdateScheduleRequest,
  WsMessage,
} from "@standup/shared";
import { SCHEDULE_WATCH_KINDS, describeScheduleWatch, fireHorizon, scheduleEndReason } from "@standup/shared";
import {
  claimPersonaScheduleRun,
  createPersonaSchedule,
  deletePersonaSchedule,
  endExpiredPersonaSchedules,
  getLaunchByIdempotencyKey,
  getOrCreatePersonaConsoleThread,
  getPersonaJob,
  getPersonaSchedule,
  getPersonaScheduleWatchState,
  getPersonaThread,
  getProject,
  activePersonaScheduleRun,
  listDuePersonaSchedules,
  listPersonaScheduleRunsByStatus,
  nextPersonaScheduleDue,
  parkPersonaSchedule,
  personaInboxIdByCoalesceKey,
  personaJobForLaunch,
  prunePersonaScheduleRuns,
  reconcilePersonaScheduleRuns,
  recordPersonaScheduleWatch,
  releasePersonaScheduleRunCount,
  settlePersonaScheduleRun,
  updatePersonaSchedule,
} from "@standup/store";
import type { PersonaSchedulePatch, ScheduleWatchFacts } from "@standup/store";
import { missedSlots, nextSlot, ownerTimezone, parseInstant, parseSchedule } from "./cron.js";
import { WATCH_SCOPE_KEY, isWatchJobKey, watchChanges, watchFacts } from "./schedule-watch.js";

/** A slot reached within this long of its time runs as an on-time slot; later, it was missed. */
export const MISS_GRACE_MS = 5 * 60 * 1000;
/** Most schedules one tick fires; the rest fire on the next tick. */
export const MAX_FIRES_PER_TICK = 4;
/** A run left `starting` this long by no fire of this process is recovered (see recoverStarting). */
export const STALE_STARTING_MS = 5 * 60 * 1000;
/** Settled runs older than this are pruned, keeping each schedule's newest 50. */
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export const MAX_TITLE_CHARS = 120;
export const MAX_NOTE_CHARS = 4_000;
export const MAX_BRIEF_CHARS = 20_000;
const MAX_SETTING_CHARS = 60;
/** Largest maxRuns accepted. */
export const MAX_RUNS_LIMIT = 100_000;

/** The launch idempotency key of a launch_job run: a retried or recovered run maps to one launch. */
export function scheduleRunLaunchKey(runId: string): string {
  return `persona-schedule-run:${runId}`;
}

/** The inbox coalesce key of a wake_persona run's wake item. */
export function scheduleRunWakeKey(runId: string): string {
  return `persona-schedule-run:${runId}`;
}

/** What starting a launch_job run came to. */
export type ScheduledLaunchOutcome =
  | { status: "launched"; jobId: string; launchId: string }
  /** Policy holds the launch (an owner hold): skipped, never run unattended. */
  | { status: "held"; reason: string }
  /** Past the budget or cap: queued, it starts on its own when there is room (Persona's launch queue). */
  | { status: "queued"; reason: string; queueId: string }
  /** Policy refuses it outright (e.g. the project is not launchable). */
  | { status: "refused"; reason: string }
  | { status: "error"; error: string };

export interface SchedulerDeps {
  db: Database;
  owner: string;
  now: () => Date;
  /**
   * Launches a launch_job run through Persona's launch path and policy. With
   * `approved`, a held verdict runs (the owner is present: an approved card or
   * the owner's own Run now); without it, a held verdict comes back `held`.
   */
  launch(schedule: PersonaSchedule, run: PersonaScheduleRun, opts: { approved: boolean }): Promise<ScheduledLaunchOutcome>;
  /**
   * Wakes Persona in the schedule's thread with its note — and, for a watched
   * schedule, what changed since its last wake; returns the inbox item id.
   */
  wake(schedule: PersonaSchedule, run: PersonaScheduleRun, threadId: string, changes?: string[]): string;
  /** Tells Persona, in the schedule's thread, that a launch_job run was skipped or failed. */
  notify(schedule: PersonaSchedule, run: PersonaScheduleRun, threadId: string): void;
  /** False while the collector is quiescing for a restart: nothing new fires. */
  canFire(): boolean;
  /** Whether the owner has paused Persona: launch_job runs are skipped meanwhile. */
  isPaused(): boolean;
  broadcast(message: WsMessage): void;
  /** Interval of the scheduler's tick. */
  tickMs?: number;
  /** Timezone given to a schedule created without one (default: ownerTimezone()). */
  defaultTimezone?: () => string;
}

/** A watched schedule's reading before a run: what it saw, what changed, and — nothing having changed — why the run is skipped. */
interface WatchCheck {
  facts: ScheduleWatchFacts;
  changes: string[];
  skipReason?: string;
  /** The skip is the watch starting again (its scope changed), not a run with nothing changed. */
  rebaselined?: boolean;
}

export type ScheduleResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

function fail<T>(error: string, status = 400): ScheduleResult<T> {
  return { ok: false, error, status };
}

function optionalString(raw: Record<string, unknown>, key: string, max: number): ScheduleResult<string | null | undefined> {
  if (!(key in raw) || raw[key] === undefined) return { ok: true, value: undefined };
  const value = raw[key];
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return fail(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) return fail(`${key} is longer than ${max} characters`);
  return { ok: true, value: trimmed || null };
}

function optionalEnum<T extends string>(raw: Record<string, unknown>, key: string, values: readonly T[]): ScheduleResult<T | undefined> {
  const value = raw[key];
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "string" || !values.includes(value as T)) return fail(`${key} must be one of ${values.join(", ")}`);
  return { ok: true, value: value as T };
}

/** The validated, normalized fields of a create or update request. */
interface NormalizedFields {
  title?: string;
  cron?: string;
  timezone?: string;
  kind?: ScheduleKind;
  note?: string | null;
  brief?: string | null;
  projectId?: string | null;
  model?: string | null;
  effort?: string | null;
  /** null clears a stored false back to the default (with the delivery pipeline). */
  pipeline?: boolean | null;
  enabled?: boolean;
  overlap?: ScheduleOverlapPolicy;
  catchUp?: ScheduleCatchUpPolicy;
  /** As given; read in the schedule's timezone by resolveEndsAt. null clears it. */
  endsAt?: string | null;
  /** null clears it. */
  maxRuns?: number | null;
  /** null clears it. */
  watch?: ScheduleWatch | null;
}

/** `raw.watch` as a ScheduleWatch (null clears it), its keys in a fixed order. */
function normalizeWatch(raw: unknown): ScheduleResult<ScheduleWatch | null> {
  if (raw === null) return { ok: true, value: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("watch must be an object like {\"kind\": \"jobs\"}, or null");
  const { kind, jobId, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return fail(`watch takes only kind and jobId, not ${Object.keys(rest).join(", ")}`);
  if (typeof kind !== "string" || !SCHEDULE_WATCH_KINDS.includes(kind as ScheduleWatchKind)) {
    return fail(`watch.kind must be one of ${SCHEDULE_WATCH_KINDS.join(", ")}`);
  }
  if (kind !== "job") {
    if (jobId !== undefined) return fail("watch.jobId applies only to watch kind job");
    return { ok: true, value: { kind: kind as ScheduleWatchKind } };
  }
  if (typeof jobId !== "string" || !jobId.trim()) return fail("watch kind job needs jobId");
  return { ok: true, value: { kind: "job", jobId: jobId.trim() } };
}

function normalizeFields(raw: Record<string, unknown>, creating: boolean): ScheduleResult<NormalizedFields> {
  const out: NormalizedFields = {};
  const strings: Array<[keyof NormalizedFields, number]> = [
    ["title", MAX_TITLE_CHARS],
    ["cron", 200],
    ["timezone", 80],
    ["note", MAX_NOTE_CHARS],
    ["brief", MAX_BRIEF_CHARS],
    ["projectId", 200],
    ["model", MAX_SETTING_CHARS],
    ["effort", MAX_SETTING_CHARS],
  ];
  for (const [key, max] of strings) {
    const r = optionalString(raw, key, max);
    if (!r.ok) return r;
    if (r.value !== undefined) (out as Record<string, unknown>)[key] = r.value;
  }
  if (out.title === null) return fail("title is required");
  if (out.cron === null) return fail("cron is required");
  if (out.timezone === null) delete out.timezone;
  if ("kind" in raw && raw.kind !== undefined) {
    if (!creating) return fail("kind can't be changed; create a new schedule instead");
    const kind = optionalEnum(raw, "kind", ["wake_persona", "launch_job"] as const);
    if (!kind.ok) return kind;
    out.kind = kind.value;
  }
  const overlap = optionalEnum(raw, "overlap", ["skip", "allow"] as const);
  if (!overlap.ok) return overlap;
  if (overlap.value) out.overlap = overlap.value;
  const catchUp = optionalEnum(raw, "catchUp", ["run_once", "skip"] as const);
  if (!catchUp.ok) return catchUp;
  if (catchUp.value) out.catchUp = catchUp.value;
  if ("enabled" in raw && raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") return fail("enabled must be a boolean");
    out.enabled = raw.enabled;
  }
  if ("pipeline" in raw && raw.pipeline !== undefined) {
    if (raw.pipeline !== null && typeof raw.pipeline !== "boolean") return fail("pipeline must be a boolean");
    out.pipeline = raw.pipeline;
  }
  if ("endsAt" in raw && raw.endsAt !== undefined) {
    if (raw.endsAt !== null && typeof raw.endsAt !== "string") return fail("endsAt must be an ISO date-time string");
    const endsAt = typeof raw.endsAt === "string" ? raw.endsAt.trim() : "";
    if (endsAt.length > 64) return fail("endsAt is longer than 64 characters");
    out.endsAt = endsAt || null;
  }
  if ("maxRuns" in raw && raw.maxRuns !== undefined) {
    const n = raw.maxRuns;
    if (n !== null && (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RUNS_LIMIT)) {
      return fail(`maxRuns must be a whole number from 1 to ${MAX_RUNS_LIMIT}`);
    }
    out.maxRuns = n;
  }
  if ("watch" in raw && raw.watch !== undefined) {
    const watch = normalizeWatch(raw.watch);
    if (!watch.ok) return watch;
    out.watch = watch.value;
  }
  if (creating) {
    if (!out.title) return fail("title is required");
    if (!out.cron) return fail("cron is required");
    if (!out.kind) return fail("kind is required (wake_persona or launch_job)");
  }
  return { ok: true, value: out };
}

/**
 * Persona's recurring schedules for one owner: validation and storage of
 * schedules, and the loop that fires their slots.
 *
 * Firing is at most once per slot, across restarts and overlapping
 * collectors: a slot is claimed by inserting its run under the unique
 * (schedule, slot) index in the same IMMEDIATE transaction that advances
 * `next_run_at` (claimPersonaScheduleRun), and only the claimer acts on it.
 * A collector that dies between the claim and the launch leaves the run
 * `starting`; recoverStarting() finds the launch by its idempotency key (or
 * the wake by its coalesce key) and links it, or marks the run failed —
 * it never launches it again.
 *
 * A slot reached more than MISS_GRACE_MS late was missed (the collector was
 * down, or the clock jumped ahead): the catch-up policy then runs the latest
 * missed slot once (`run_once`) or records it skipped (`skip`), and the
 * schedule resumes at its next future slot. A clock set back leaves
 * `next_run_at` ahead, so nothing fires twice; the slot index backs that up.
 *
 * A schedule may carry an end bound — `endsAt`, `maxRuns`, or both — read by
 * scheduleEndReason (@standup/shared). The claim that fires the last run
 * allowed ends it; endExpiredPersonaSchedules ends one whose endsAt passed
 * with nothing left to fire; catch-up looks no further than fireHorizon. An
 * ended schedule is disabled and kept with its history. A bound that would
 * leave no run (endsAt already passed, or before the next slot; maxRuns not
 * above the runs already fired) is refused at create and update rather than
 * saved as already ended; extending or clearing an ended schedule's bound
 * resumes it from now.
 */
export class PersonaScheduler {
  readonly owner: string;
  private readonly db: Database;
  private readonly deps: SchedulerDeps;
  private readonly tickMs: number;
  private tickTimer?: ReturnType<typeof setInterval>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  /** Runs this process is starting right now; recovery leaves them alone. */
  private readonly inFlight = new Set<string>();
  private lastPruneMs = 0;
  private active = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.owner = deps.owner;
    this.tickMs = deps.tickMs ?? 15_000;
  }

  defaultTimezone(): string {
    return this.deps.defaultTimezone?.() ?? ownerTimezone();
  }

  /** Whether a fire is in flight (a launch or wake being started). */
  busy(): boolean {
    return this.inFlight.size > 0 || this.ticking !== null;
  }

  /** Boot: recover runs a previous collector left starting, then tick on an interval. A no-op while already started. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.recoverStarting(0);
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  stop(): void {
    this.active = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.tickTimer = undefined;
    this.wakeTimer = undefined;
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  private publish(schedule: PersonaSchedule | null, deleted?: string): void {
    this.deps.broadcast({
      type: "persona:schedule",
      payload: deleted ? { id: deleted, deleted: true } : schedule,
      timestamp: new Date().toISOString(),
      audience: this.owner,
    });
  }

  /** The thread a schedule's runs report to: its own, else the owner's console thread. */
  threadOf(schedule: PersonaSchedule): string {
    return schedule.threadId ?? getOrCreatePersonaConsoleThread(this.db, this.owner).id;
  }

  /** Checks the kind-specific fields of a schedule as it would stand. */
  private checkShape(s: {
    kind: ScheduleKind;
    note?: string | null;
    brief?: string | null;
    projectId?: string | null;
    watch?: ScheduleWatch | null;
  }): string | null {
    if (s.kind === "wake_persona") {
      if (!s.note) return "note is required for a wake_persona schedule";
      if (s.watch?.kind === "job") {
        const job = getPersonaJob(this.db, s.watch.jobId!, { withView: false });
        if (!job || job.owner !== this.owner) return `watch: no job ${s.watch.jobId}`;
      }
      return null;
    }
    if (s.watch) return "watch applies only to wake_persona schedules";
    if (!s.brief) return "brief is required for a launch_job schedule";
    if (s.projectId) {
      const project = getProject(this.db, s.projectId);
      if (!project || project.reserved) return `project ${s.projectId} is not a registered, launchable project`;
    }
    return null;
  }

  /** The schedule's next slot from now, or null while it is paused or has none. */
  private nextFromNow(cronExpr: string, timezone: string, enabled: boolean): ScheduleResult<string | null> {
    const parsed = parseSchedule(cronExpr, timezone, this.deps.now());
    if (!parsed.ok) return fail(parsed.error);
    if (!enabled) return { ok: true, value: null };
    return { ok: true, value: nextSlot(parsed.cron, this.deps.now())?.toISOString() ?? null };
  }

  /** endsAt as a UTC ISO instant (a wall time read in `timezone`), refused unless it is still ahead. */
  private resolveEndsAt(value: string, timezone: string): ScheduleResult<string> {
    const at = parseInstant(value, timezone);
    if (!at) {
      return fail(`endsAt must be an ISO date-time, e.g. "2026-10-19T01:00" (read in ${timezone}) or "2026-10-19T05:00Z"`);
    }
    if (at.getTime() <= this.deps.now().getTime()) {
      return fail(`endsAt ${at.toISOString()} has already passed; an end bound must be in the future`);
    }
    return { ok: true, value: at.toISOString() };
  }

  /**
   * Why `bound` would leave a schedule no run to fire — it has fired
   * `runCount` runs and its next slot is `nextRunAt` — or null when it has
   * runs left. A bound like that is refused, not saved as already ended.
   */
  private boundRefusal(bound: ScheduleEndBound, runCount: number, nextRunAt: string | null): string | null {
    const end = scheduleEndReason(bound, { runCount, nextRunAt, now: this.deps.now().toISOString() });
    if (end === "max_runs") return `it has already fired ${runCount} runs; maxRuns must be more than that`;
    if (end === "ends_at") return `no run falls at or before endsAt ${bound.endsAt}${nextRunAt ? ` (the next is at ${nextRunAt})` : ""}`;
    return null;
  }

  /** Validates `raw` as a new schedule without saving it; the normalized request on success. */
  validateCreate(raw: Record<string, unknown>): ScheduleResult<CreateScheduleRequest & { timezone: string }> {
    const fields = normalizeFields(raw, true);
    if (!fields.ok) return fields;
    const f = fields.value;
    if (f.kind === "wake_persona" && f.pipeline !== undefined && f.pipeline !== null) {
      return fail("pipeline applies only to launch_job schedules");
    }
    const timezone = f.timezone ?? this.defaultTimezone();
    const next = this.nextFromNow(f.cron!, timezone, true);
    if (!next.ok) return next;
    const shape = this.checkShape({ kind: f.kind!, note: f.note, brief: f.brief, projectId: f.projectId, watch: f.watch });
    if (shape) return fail(shape);
    let endsAt: string | undefined;
    if (f.endsAt) {
      const resolved = this.resolveEndsAt(f.endsAt, timezone);
      if (!resolved.ok) return resolved;
      endsAt = resolved.value;
    }
    const maxRuns = f.maxRuns ?? undefined;
    const refusal = this.boundRefusal({ endsAt, maxRuns }, 0, next.value);
    if (refusal) return fail(`can't create it: ${refusal}`);
    return {
      ok: true,
      value: {
        title: f.title!,
        cron: f.cron!,
        timezone,
        kind: f.kind!,
        ...(f.kind === "wake_persona" ? { note: f.note ?? undefined, ...(f.watch ? { watch: f.watch } : {}) } : {}),
        ...(f.kind === "launch_job"
          ? {
              brief: f.brief ?? undefined,
              projectId: f.projectId ?? undefined,
              model: f.model ?? undefined,
              effort: f.effort ?? undefined,
              ...(f.pipeline === false ? { pipeline: false } : {}),
            }
          : {}),
        enabled: f.enabled ?? true,
        overlap: f.overlap ?? "skip",
        catchUp: f.catchUp ?? "run_once",
        ...(endsAt ? { endsAt } : {}),
        ...(maxRuns !== undefined ? { maxRuns } : {}),
      },
    };
  }

  create(raw: Record<string, unknown>, opts: { createdBy: string; threadId?: string }): ScheduleResult<PersonaSchedule> {
    const valid = this.validateCreate(raw);
    if (!valid.ok) return valid;
    const v = valid.value;
    const next = this.nextFromNow(v.cron, v.timezone, v.enabled !== false);
    if (!next.ok) return next;
    const schedule = createPersonaSchedule(this.db, {
      owner: this.owner,
      threadId: opts.threadId,
      title: v.title,
      cron: v.cron,
      timezone: v.timezone,
      kind: v.kind,
      note: v.note,
      brief: v.brief,
      projectId: v.projectId,
      model: v.model,
      effort: v.effort,
      pipeline: v.pipeline,
      enabled: v.enabled,
      overlap: v.overlap,
      catchUp: v.catchUp,
      endsAt: v.endsAt,
      maxRuns: v.maxRuns,
      ...(v.watch ? { watch: v.watch, watchState: this.readWatch(v.watch, opts.threadId) } : {}),
      createdBy: opts.createdBy,
      nextRunAt: next.value,
    });
    this.publish(schedule);
    this.armWake();
    return { ok: true, value: schedule };
  }

  /** The owner's schedule `id`, or null. */
  get(id: string): PersonaSchedule | null {
    const schedule = getPersonaSchedule(this.db, id);
    return schedule && schedule.owner === this.owner ? schedule : null;
  }

  /** The patch an update would write, validated against the schedule as it would stand. */
  validateUpdate(id: string, raw: Record<string, unknown>): ScheduleResult<{ schedule: PersonaSchedule; patch: PersonaSchedulePatch }> {
    const schedule = this.get(id);
    if (!schedule) return fail(`no schedule ${id}`, 404);
    const fields = normalizeFields(raw, false);
    if (!fields.ok) return fields;
    const f = fields.value;
    const patch: PersonaSchedulePatch = {};
    if (f.title) patch.title = f.title;
    if (f.cron) patch.cron = f.cron;
    if (f.timezone) patch.timezone = f.timezone;
    if (f.overlap) patch.overlap = f.overlap;
    if (f.catchUp) patch.catchUp = f.catchUp;
    if (f.enabled !== undefined) patch.enabled = f.enabled;
    if (schedule.kind === "wake_persona") {
      if (f.note !== undefined) patch.note = f.note;
      if (f.watch !== undefined) patch.watch = f.watch;
      if (f.brief || f.projectId || f.model || f.effort) return fail("brief, projectId, model and effort apply only to launch_job schedules");
      if (typeof f.pipeline === "boolean") return fail("pipeline applies only to launch_job schedules");
    } else {
      if (f.note) return fail("note applies only to wake_persona schedules");
      if (f.watch) return fail("watch applies only to wake_persona schedules");
      for (const key of ["brief", "projectId", "model", "effort"] as const) {
        if (f[key] !== undefined) patch[key] = f[key];
      }
      if (f.pipeline !== undefined) patch.pipeline = f.pipeline;
    }
    const shape = this.checkShape({
      kind: schedule.kind,
      note: patch.note !== undefined ? patch.note : schedule.note,
      brief: patch.brief !== undefined ? patch.brief : schedule.brief,
      projectId: patch.projectId !== undefined ? patch.projectId : schedule.projectId,
      watch: patch.watch,
    });
    if (shape) return fail(shape);
    const cronExpr = patch.cron ?? schedule.cron;
    const timezone = patch.timezone ?? schedule.timezone;
    if (f.endsAt !== undefined) {
      if (f.endsAt === null) patch.endsAt = null;
      else {
        const resolved = this.resolveEndsAt(f.endsAt, timezone);
        if (!resolved.ok) return resolved;
        patch.endsAt = resolved.value;
      }
    }
    if (f.maxRuns !== undefined) patch.maxRuns = f.maxRuns;
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : schedule.endsAt;
    const maxRuns = patch.maxRuns !== undefined ? patch.maxRuns : schedule.maxRuns;
    const bound: ScheduleEndBound = {
      ...(endsAt ? { endsAt } : {}),
      ...(maxRuns !== null && maxRuns !== undefined ? { maxRuns } : {}),
    };
    const boundChanged = patch.endsAt !== undefined || patch.maxRuns !== undefined;
    const upcoming = this.nextFromNow(cronExpr, timezone, true);
    if (!upcoming.ok) return upcoming;
    let enabled = patch.enabled ?? schedule.enabled;
    // A new cadence, or a resume, starts from now: slots skipped while paused
    // are not caught up.
    let retimed =
      patch.cron !== undefined || patch.timezone !== undefined || (patch.enabled !== undefined && patch.enabled !== schedule.enabled);
    if (schedule.endedAt) {
      // An ended schedule runs again once its bound, or a new cadence, leaves
      // it a run. Asked for outright (a bound change, or enabled true), a
      // resume that wouldn't is refused; a cadence edit alone leaves it ended.
      const cadenceChanged = patch.cron !== undefined || patch.timezone !== undefined;
      const asked = boundChanged || patch.enabled === true;
      if (asked || cadenceChanged) {
        const refusal = this.boundRefusal(bound, schedule.runCount, upcoming.value);
        if (refusal && asked) {
          return fail(
            boundChanged
              ? `the schedule has ended and the new bound still ends it: ${refusal}`
              : `the schedule has ended (${refusal}); extend or clear endsAt / maxRuns to run it again`
          );
        }
        if (!refusal) {
          patch.endedAt = null;
          patch.endReason = null;
          enabled = patch.enabled ?? true;
          patch.enabled = enabled;
          retimed = true;
        }
      }
    } else if (boundChanged || (retimed && enabled)) {
      const nextRunAt = enabled && !retimed && schedule.nextRunAt ? schedule.nextRunAt : upcoming.value;
      const refusal = this.boundRefusal(bound, schedule.runCount, nextRunAt);
      if (refusal) return fail(refusal);
    }
    if (retimed) patch.nextRunAt = enabled ? upcoming.value : null;
    return { ok: true, value: { schedule, patch } };
  }

  update(id: string, raw: UpdateScheduleRequest | Record<string, unknown>): ScheduleResult<PersonaSchedule> {
    // Validated and written in one IMMEDIATE transaction, so a claim in
    // another collector can't end the schedule between the two.
    const write = this.db.transaction((): ScheduleResult<PersonaSchedule | null> => {
      const valid = this.validateUpdate(id, raw as Record<string, unknown>);
      if (!valid.ok) return valid;
      const { schedule, patch } = valid.value;
      // A new watch starts from what is there now; the same watch given again keeps its baseline.
      if (patch.watch !== undefined && JSON.stringify(patch.watch) !== JSON.stringify(schedule.watch ?? null)) {
        patch.watchState = patch.watch ? this.readWatch(patch.watch, schedule.threadId) : null;
        patch.watchChangedAt = patch.watch ? this.deps.now().toISOString() : null;
        patch.watchPending = null;
        patch.watchSkips = 0;
      }
      return { ok: true, value: updatePersonaSchedule(this.db, id, patch) };
    });
    const result = write.immediate();
    if (!result.ok) return result;
    const updated = result.value;
    if (!updated) return fail(`no schedule ${id}`, 404);
    this.publish(updated);
    this.armWake();
    return { ok: true, value: updated };
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    const removed = deletePersonaSchedule(this.db, id, this.owner);
    if (removed) this.publish(null, id);
    return removed;
  }

  // ── Firing ────────────────────────────────────────────────────────────────

  /**
   * Runs a schedule once now, outside its cadence. The overlap policy still
   * applies. `approved` is set when the owner is present for it (their own
   * Run now, or an approved card), so a launch policy would hold still runs.
   */
  async runNow(id: string, opts: { approved: boolean }): Promise<ScheduleResult<PersonaScheduleRun>> {
    const schedule = this.get(id);
    if (!schedule) return fail(`no schedule ${id}`, 404);
    if (!this.deps.canFire()) return fail("Standup is restarting; try again in a moment", 503);
    reconcilePersonaScheduleRuns(this.db, this.owner, this.deps.now().toISOString());
    const now = this.deps.now().toISOString();
    const paused = this.pausedSkip(schedule);
    const watch = paused ? undefined : this.checkWatch(schedule);
    const claim = claimPersonaScheduleRun(this.db, {
      scheduleId: schedule.id,
      owner: this.owner,
      scheduledFor: now,
      trigger: "manual",
      now,
      skipReason: paused ?? watch?.skipReason,
    });
    if (claim.outcome === "stale") return fail(`no schedule ${id}`, 404);
    if (claim.outcome === "skipped" && watch?.skipReason && !watch.rebaselined) {
      recordPersonaScheduleWatch(this.db, schedule.id, { skipped: true });
    }
    const run = claim.outcome === "started" ? await this.execute(claim.schedule, claim.run, opts.approved, watch) : claim.run;
    this.publish(this.get(id));
    return { ok: true, value: run };
  }

  private pausedSkip(schedule: PersonaSchedule): string | undefined {
    return schedule.kind === "launch_job" && this.deps.isPaused()
      ? "Persona is paused; scheduled launches wait until it is resumed"
      : undefined;
  }

  /**
   * One pass: settle finished runs, recover abandoned ones, and fire up to
   * MAX_FIRES_PER_TICK due schedules, one at a time (each launch passes the
   * active cap as it goes). Single-flight.
   */
  tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.tickOnce();
        } while (this.tickAgain);
      } catch (err) {
        console.error("[persona] schedule tick failed:", err);
      } finally {
        this.ticking = null;
        this.armWake();
      }
    })();
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (!this.deps.canFire()) return;
    const now = this.deps.now();
    const nowIso = now.toISOString();
    this.recoverStarting(STALE_STARTING_MS);
    for (const run of reconcilePersonaScheduleRuns(this.db, this.owner, nowIso)) {
      this.publish(this.get(run.scheduleId));
    }
    for (const ended of endExpiredPersonaSchedules(this.db, this.owner, nowIso)) this.publish(ended);
    if (now.getTime() - this.lastPruneMs >= PRUNE_EVERY_MS) {
      this.lastPruneMs = now.getTime();
      prunePersonaScheduleRuns(this.db, this.owner, new Date(now.getTime() - RUN_RETENTION_MS).toISOString());
    }
    const due = listDuePersonaSchedules(this.db, this.owner, nowIso);
    for (const schedule of due.slice(0, MAX_FIRES_PER_TICK)) {
      if (!this.deps.canFire()) return;
      await this.fireDue(schedule, this.deps.now());
    }
    if (due.length > MAX_FIRES_PER_TICK) this.tickAgain = true;
  }

  /** Claims and runs a due schedule's slot (or the latest of its missed slots). */
  private async fireDue(schedule: PersonaSchedule, now: Date): Promise<void> {
    const dueIso = schedule.nextRunAt!;
    const parsed = parseSchedule(schedule.cron, schedule.timezone, now);
    if (!parsed.ok) {
      // Unreadable now (e.g. a timezone this runtime no longer knows): park it
      // until it is edited, rather than retry it every tick.
      parkPersonaSchedule(this.db, schedule.id, `can't compute the next run: ${parsed.error}`);
      this.publish(this.get(schedule.id));
      return;
    }
    const dueAt = new Date(dueIso);
    let trigger: ScheduleRunTrigger = "cron";
    let slot = dueAt;
    let skipReason: string | undefined;
    if (now.getTime() - dueAt.getTime() > MISS_GRACE_MS) {
      // Catch-up never reaches past endsAt; endExpiredPersonaSchedules has
      // already ended a schedule whose due slot is itself past it.
      const missed = missedSlots(parsed.cron, dueAt, fireHorizon(schedule, now));
      slot = missed.latest;
      trigger = "catch_up";
      const count = missed.count === 1 ? "1 run" : `${missed.count} runs`;
      if (schedule.catchUp === "skip") {
        skipReason = `missed ${count} while Standup wasn't running (catch-up policy: skip)`;
      }
    }
    skipReason ??= this.pausedSkip(schedule);
    const watch = skipReason ? undefined : this.checkWatch(schedule);
    skipReason ??= watch?.skipReason;
    const after = slot.getTime() > now.getTime() ? slot : now;
    const next = nextSlot(parsed.cron, after)?.toISOString() ?? null;
    const claim = claimPersonaScheduleRun(this.db, {
      scheduleId: schedule.id,
      owner: this.owner,
      expectedNextRunAt: dueIso,
      scheduledFor: slot.toISOString(),
      trigger,
      nextRunAt: next,
      now: now.toISOString(),
      skipReason,
    });
    if (claim.outcome === "stale") {
      this.publish(this.get(schedule.id));
      return;
    }
    if (claim.outcome === "skipped" && watch?.skipReason && !watch.rebaselined) {
      recordPersonaScheduleWatch(this.db, schedule.id, { skipped: true });
    }
    if (claim.outcome === "started") await this.execute(claim.schedule, claim.run, false, watch);
    this.publish(this.get(schedule.id));
  }

  /**
   * Starts a claimed run: wakes Persona (with what changed, given the watch's
   * reading), or launches the worker through Persona's launch policy.
   */
  private async execute(
    schedule: PersonaSchedule,
    run: PersonaScheduleRun,
    approved: boolean,
    watch?: WatchCheck
  ): Promise<PersonaScheduleRun> {
    this.inFlight.add(run.id);
    const threadId = this.threadOf(schedule);
    try {
      if (schedule.kind === "wake_persona") return this.wakePersona(schedule, run, threadId, watch);
      let outcome: ScheduledLaunchOutcome;
      try {
        outcome = await this.deps.launch(schedule, run, { approved });
      } catch (err) {
        outcome = { status: "error", error: (err as Error).message || "launch failed" };
      }
      let settled: PersonaScheduleRun | null;
      if (outcome.status === "launched") {
        settled = settlePersonaScheduleRun(this.db, run.id, {
          status: "running",
          jobId: outcome.jobId,
          launchId: outcome.launchId,
        });
      } else if (outcome.status === "error") {
        settled = settlePersonaScheduleRun(this.db, run.id, { status: "failed", error: outcome.error.slice(0, 500) });
      } else if (outcome.status === "queued") {
        // The queued launch keeps this run's idempotency key, so it is still this run's launch when it starts.
        settled = settlePersonaScheduleRun(this.db, run.id, {
          status: "skipped",
          reason: `queued (${outcome.queueId}): ${outcome.reason}; it starts when there is room`.slice(0, 500),
        });
      } else {
        settled = settlePersonaScheduleRun(this.db, run.id, {
          status: "skipped",
          reason: `${outcome.status === "held" ? "held" : "refused"}: ${outcome.reason}`.slice(0, 500),
        });
        // Never launched, so it doesn't use up the schedule's maxRuns.
        this.releaseRunCount(run.id);
      }
      const result = settled ?? run;
      if (result.status !== "running") this.deps.notify(schedule, result, threadId);
      return result;
    } catch (err) {
      console.error(`[persona] schedule ${schedule.id} run ${run.id} failed:`, err);
      return (
        settlePersonaScheduleRun(this.db, run.id, { status: "failed", error: ((err as Error).message || "failed").slice(0, 500) }) ??
        run
      );
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  /**
   * Wakes Persona for a wake_persona run — with what changed, for a watched
   * one, whose reading is kept as pending. The baseline itself stays until
   * Persona's turn on the wake ends (wakesHandled), so a turn that fails, or
   * a collector that dies first, leaves the change to be reported again.
   */
  private wakePersona(schedule: PersonaSchedule, run: PersonaScheduleRun, threadId: string, watch?: WatchCheck): PersonaScheduleRun {
    const inboxId = this.deps.wake(schedule, run, threadId, watch?.changes);
    if (watch) recordPersonaScheduleWatch(this.db, schedule.id, { pending: watch.facts, changedAt: this.deps.now().toISOString() });
    return settlePersonaScheduleRun(this.db, run.id, { status: "running", inboxId }) ?? run;
  }

  /**
   * The schedule's thread unless it is known to be the owner's private one: a
   * watch there sees only that thread's work (see watchFacts). No thread is
   * the owner's console thread.
   */
  private restrictedThread(threadId: string | undefined): string | undefined {
    if (!threadId) return undefined;
    const thread = getPersonaThread(this.db, threadId);
    return thread && thread.owner === this.owner && thread.audience === "private" ? undefined : threadId;
  }

  /** What `watch` on a schedule reporting to `threadId` sees now. */
  private readWatch(watch: ScheduleWatch, threadId: string | undefined): ScheduleWatchFacts {
    return watchFacts(this.db, this.owner, watch, this.deps.now(), this.restrictedThread(threadId));
  }

  /**
   * A watched wake_persona schedule's pre-check, before its run is claimed:
   * what changed since its baseline, or — nothing having changed — the
   * reason the run is skipped, so it is recorded skipped at the claim (no
   * wake, and no maxRuns count). Undefined for a schedule with no watch.
   */
  private checkWatch(schedule: PersonaSchedule): WatchCheck | undefined {
    if (schedule.kind !== "wake_persona" || !schedule.watch) return undefined;
    const facts = this.readWatch(schedule.watch, schedule.threadId);
    // While an earlier wake is still waiting for Persona, compare with the
    // reading that wake reported, so this run doesn't report it again.
    const before =
      (activePersonaScheduleRun(this.db, schedule.id)?.inboxId && getPersonaScheduleWatchState(this.db, schedule.id, "pending")) ||
      getPersonaScheduleWatchState(this.db, schedule.id);
    if (before && before[WATCH_SCOPE_KEY] !== facts[WATCH_SCOPE_KEY]) {
      // The thread's audience changed since the baseline: what it held from
      // outside the thread must not be listed there, even as gone.
      recordPersonaScheduleWatch(this.db, schedule.id, { state: facts, pending: facts });
      return { facts, changes: [], skipReason: "the thread's audience changed; the watch starts again from what it sees now", rebaselined: true };
    }
    const changes = before ? watchChanges(before, facts) : ["(no earlier reading to compare with; this one is the new baseline)"];
    if (changes.length > 0) return { facts, changes };
    const since = schedule.watchChangedAt ? ` since ${schedule.watchChangedAt}` : "";
    return { facts, changes, skipReason: `no change${since} in ${describeScheduleWatch(schedule.watch)}` };
  }

  /**
   * Called as a Persona turn that handled the wakes of `scheduleIds` ends; a
   * watched one moves its baseline on. Its jobs are taken as they stand now,
   * so what Persona itself did in that turn (a launch, a question, a closed
   * job) doesn't wake it again — the turn's snapshot showed it those jobs as
   * they stood when it began, and a worker's later change reaches it as a
   * worker event. Everything else (review packets, which Persona doesn't
   * change) is taken as its wake reported it, so a packet that came in while
   * the wake waited or ran still wakes it.
   */
  wakesHandled(scheduleIds: readonly string[]): void {
    for (const id of new Set(scheduleIds)) {
      const schedule = this.get(id);
      if (schedule?.kind !== "wake_persona" || !schedule.watch) continue;
      const now = this.readWatch(schedule.watch, schedule.threadId);
      const reported = getPersonaScheduleWatchState(this.db, schedule.id, "pending");
      const state =
        reported && reported[WATCH_SCOPE_KEY] === now[WATCH_SCOPE_KEY]
          ? Object.fromEntries([
              ...Object.entries(reported).filter(([key]) => !isWatchJobKey(key)),
              ...Object.entries(now).filter(([key]) => isWatchJobKey(key)),
            ])
          : now;
      recordPersonaScheduleWatch(this.db, schedule.id, { state });
    }
  }

  /**
   * Gives back the maxRuns count of a run whose launch never started — held,
   * refused, or failed out of the launch queue (see
   * releasePersonaScheduleRunCount) — reopening a schedule it had ended at its
   * next slot from now. A no-op for a run that holds no count.
   */
  releaseRunCount(runId: string): void {
    const now = this.deps.now();
    const schedule = releasePersonaScheduleRunCount(
      this.db,
      runId,
      (s) => {
        const parsed = parseSchedule(s.cron, s.timezone, now);
        return parsed.ok ? (nextSlot(parsed.cron, now)?.toISOString() ?? null) : null;
      },
      now.toISOString()
    );
    if (schedule) {
      this.publish(schedule);
      this.armWake();
    }
  }

  /**
   * Resolves runs left `starting` for at least `olderThanMs` that no fire of
   * this process owns — a collector died between claiming a slot and starting
   * it. The launch (by its idempotency key) or wake (by its coalesce key) it
   * got to is linked and the run goes on as running; with neither, it is
   * marked failed. A run is never started again here, so a slot fires at most
   * once.
   */
  recoverStarting(olderThanMs: number): void {
    const cutoff = this.deps.now().getTime() - olderThanMs;
    for (const run of listPersonaScheduleRunsByStatus(this.db, this.owner, ["starting"])) {
      if (this.inFlight.has(run.id) || Date.parse(run.startedAt) > cutoff) continue;
      const launch = getLaunchByIdempotencyKey(this.db, scheduleRunLaunchKey(run.id));
      if (launch) {
        const job = personaJobForLaunch(this.db, launch.id);
        settlePersonaScheduleRun(this.db, run.id, {
          status: "running",
          launchId: launch.id,
          jobId: job?.job.id,
          sessionId: launch.sessionId,
        });
        continue;
      }
      const inboxId = personaInboxIdByCoalesceKey(this.db, this.owner, scheduleRunWakeKey(run.id));
      if (inboxId) {
        settlePersonaScheduleRun(this.db, run.id, { status: "running", inboxId });
        continue;
      }
      settlePersonaScheduleRun(this.db, run.id, {
        status: "failed",
        error: "interrupted by a collector restart before it started; not retried",
      });
    }
  }

  /** Arms one timer for the earliest next slot when it falls before the next tick. */
  private armWake(): void {
    if (!this.active) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const next = nextPersonaScheduleDue(this.db, this.owner);
    if (!next) return;
    const delay = Date.parse(next) - this.deps.now().getTime();
    if (delay >= this.tickMs) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      void this.tick();
    }, Math.max(0, delay) + 50);
  }
}
