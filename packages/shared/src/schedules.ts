/**
 * Persona's recurring schedules: a cron expression in an IANA timezone that
 * either wakes Persona with a note or launches a worker with a stored brief.
 * See migration 054 and packages/collector/src/persona/scheduler.ts.
 */

/** `wake_persona` wakes Persona with the note; `launch_job` launches a worker with the brief. */
export type ScheduleKind = "wake_persona" | "launch_job";

/** `skip`: a slot is skipped while the previous run is still active. `allow` runs it anyway. */
export type ScheduleOverlapPolicy = "skip" | "allow";

/** After downtime: `run_once` runs the latest missed slot once; `skip` records it skipped. */
export type ScheduleCatchUpPolicy = "run_once" | "skip";

/**
 * `starting`: claimed, its launch or wake not yet confirmed. `running`: the
 * worker was launched (or Persona woken) and is still at it. `done` / `failed`:
 * settled. `skipped`: never started (overlap, budget, cap, a held brief, a
 * missed slot) — `reason` says why.
 */
export type ScheduleRunStatus = "starting" | "running" | "done" | "failed" | "skipped";

/** `cron`: an on-time slot. `catch_up`: a slot missed while Standup was down. `manual`: run now. */
export type ScheduleRunTrigger = "cron" | "catch_up" | "manual";

/** Why a schedule ended: `ends_at` had no slot left at or before it; `max_runs` fired its last run. */
export type ScheduleEndReason = "ends_at" | "max_runs";

/** What a watched wake_persona schedule checks before it wakes Persona. */
export type ScheduleWatchKind = "jobs" | "reviews" | "job";

export const SCHEDULE_WATCH_KINDS: readonly ScheduleWatchKind[] = ["jobs", "reviews", "job"];

/**
 * A wake_persona schedule's pre-check, read by the collector with no model
 * turn: a run wakes Persona only when what it watches changed since the
 * last wake (or since the watch was set), and is recorded skipped otherwise.
 *  - `jobs`: any of the owner's jobs (status, worker sessions, pipeline
 *    stage, what waits on the owner: asks, approvals, review packets) or
 *    pending review packets;
 *  - `reviews`: the owner's pending review packets;
 *  - `job`: one job, `jobId`.
 */
export interface ScheduleWatch {
  kind: ScheduleWatchKind;
  /** `job` only. */
  jobId?: string;
}

/** What a watch looks at, in words: "your jobs and reviews", "pending reviews", "job 1a2b3c4d". */
export function describeScheduleWatch(watch: ScheduleWatch): string {
  if (watch.kind === "reviews") return "pending reviews";
  if (watch.kind === "job") return `job ${(watch.jobId ?? "").slice(0, 8)}`;
  return "your jobs and reviews";
}

export interface PersonaSchedule {
  id: string;
  owner: string;
  /** The Persona thread its wakes and launched jobs report to. */
  threadId?: string;
  title: string;
  /** Five-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
  /** IANA timezone the expression is read in, fixed when the schedule is created. */
  timezone: string;
  kind: ScheduleKind;
  /** wake_persona: the note Persona wakes with. */
  note?: string;
  /** wake_persona: wake only when this changed (see ScheduleWatch). */
  watch?: ScheduleWatch;
  /** Runs the watch skipped because nothing had changed. */
  watchSkips?: number;
  /** When the watch was set or last saw a change (UTC ISO). */
  watchChangedAt?: string;
  /** launch_job: the worker's brief. */
  brief?: string;
  projectId?: string;
  model?: string;
  effort?: string;
  /**
   * launch_job: false launches the worker without the delivery pipeline
   * (research, investigation, docs drafting). Absent means true.
   */
  pipeline?: boolean;
  enabled: boolean;
  overlap: ScheduleOverlapPolicy;
  catchUp: ScheduleCatchUpPolicy;
  /** The last instant (UTC ISO) a slot may fire at; no slot after it runs, catch-up included. */
  endsAt?: string;
  /** How many runs it fires in all (see runCount); then it ends. */
  maxRuns?: number;
  /**
   * Runs it has fired: cron, catch-up and Run now runs that started (Run now
   * only before it has ended). Skipped slots and launches that never started
   * (held, refused, failed out of the launch queue) don't count; a run that
   * failed does. Never reset, so maxRuns is a lifetime total.
   */
  runCount: number;
  /** When it ended (UTC ISO). An ended schedule is disabled and kept, with its history. */
  endedAt?: string;
  endReason?: ScheduleEndReason;
  /** `persona`, or the alias of the person who created it. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The next slot (UTC ISO); absent while paused or when the expression has no future slot. */
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: ScheduleRunStatus;
  /** The last run's reason or error, when it has one. */
  lastOutcomeDetail?: string;
}

export interface PersonaScheduleRun {
  id: string;
  scheduleId: string;
  owner: string;
  /** The slot this run is for (the fire time for a manual run). */
  scheduledFor: string;
  trigger: ScheduleRunTrigger;
  status: ScheduleRunStatus;
  /** Why it was skipped, or what it settled with. */
  reason?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  jobId?: string;
  launchId?: string;
  sessionId?: string;
  /** wake_persona: the inbox item that woke Persona. */
  inboxId?: string;
}

export interface CreateScheduleRequest {
  title: string;
  cron: string;
  timezone?: string;
  kind: ScheduleKind;
  note?: string;
  /** wake_persona: wake only when this changed. */
  watch?: ScheduleWatch;
  brief?: string;
  projectId?: string;
  model?: string;
  effort?: string;
  /**
   * launch_job: false launches the worker without the delivery pipeline
   * (research, investigation, docs drafting). Absent means true.
   */
  pipeline?: boolean;
  enabled?: boolean;
  overlap?: ScheduleOverlapPolicy;
  catchUp?: ScheduleCatchUpPolicy;
  /**
   * ISO date-time after which no slot fires. With an offset or Z it is that
   * instant; without one ("2026-10-19T01:00") it is read in the schedule's
   * timezone. Refused when no slot falls between now and it.
   */
  endsAt?: string;
  /** End after this many scheduled runs (a positive integer). */
  maxRuns?: number;
}

/** As create, but kind is fixed; `endsAt: null` / `maxRuns: null` clear a bound, `watch: null` the watch. */
export type UpdateScheduleRequest = Partial<Omit<CreateScheduleRequest, "kind" | "endsAt" | "maxRuns" | "watch">> & {
  endsAt?: string | null;
  maxRuns?: number | null;
  watch?: ScheduleWatch | null;
};

// ── End bound ───────────────────────────────────────────────────────────────

/** A schedule's optional end: a last instant, a run count, or both (whichever comes first). */
export interface ScheduleEndBound {
  /** UTC ISO. */
  endsAt?: string;
  maxRuns?: number;
}

/**
 * Why a schedule with `bound` is over, or null while it has runs left:
 * `max_runs` once it has fired `runCount >= maxRuns` runs; `ends_at` once its
 * next slot (`nextRunAt`, UTC ISO) falls after endsAt — or, with no next slot,
 * once `now` has passed endsAt.
 */
export function scheduleEndReason(
  bound: ScheduleEndBound,
  state: { runCount: number; nextRunAt: string | null; now: string }
): ScheduleEndReason | null {
  if (bound.maxRuns !== undefined && state.runCount >= bound.maxRuns) return "max_runs";
  if (bound.endsAt !== undefined) {
    if (state.nextRunAt !== null ? state.nextRunAt > bound.endsAt : state.now > bound.endsAt) return "ends_at";
  }
  return null;
}

/** The latest instant a slot of a schedule with `bound` may fire at, as of `now`: now, or endsAt when that is earlier. */
export function fireHorizon(bound: ScheduleEndBound, now: Date): Date {
  const endsAt = bound.endsAt ? Date.parse(bound.endsAt) : NaN;
  return Number.isFinite(endsAt) && endsAt < now.getTime() ? new Date(endsAt) : now;
}

/**
 * The end condition in words, e.g. "Ends after 5 runs (3 left)", "Ends Oct
 * 19, 1:00 AM ET", "Ended Oct 19, 1:00 AM ET (run limit reached; 7 runs)", or
 * null when it has none. Times are shown in `timezone` (the schedule's).
 */
export function describeScheduleEnd(
  schedule: Pick<PersonaSchedule, "endsAt" | "maxRuns" | "runCount" | "endedAt" | "endReason" | "timezone">,
  timezone: string = schedule.timezone
): string | null {
  const when = (iso: string): string => {
    const date = new Date(iso);
    let shown: string;
    try {
      shown = date.toLocaleString("en-US", { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch {
      shown = iso;
    }
    return `${shown} ${timezoneLabel(timezone, date)}`;
  };
  const runs = (n: number) => (n === 1 ? "1 run" : `${n} runs`);
  if (schedule.endedAt) {
    const why = schedule.endReason === "max_runs" ? "run limit reached" : "no run left before the end time";
    return `Ended ${when(schedule.endedAt)} (${why}; ${runs(schedule.runCount)})`;
  }
  const parts: string[] = [];
  if (schedule.maxRuns !== undefined) {
    const left = Math.max(0, schedule.maxRuns - schedule.runCount);
    parts.push(`after ${runs(schedule.maxRuns)} (${left} left)`);
  }
  if (schedule.endsAt) parts.push(`${schedule.maxRuns !== undefined ? "or at " : ""}${when(schedule.endsAt)}`);
  return parts.length > 0 ? `Ends ${parts.join(" ")}` : null;
}

/** A pending one-shot wakeup Persona scheduled with schedule_wakeup. */
export interface PersonaWakeupSummary {
  id: string;
  note: string;
  at?: string;
  threadId?: string;
  jobId?: string;
  createdAt: string;
}

export interface SchedulesResponse {
  schedules: PersonaSchedule[];
  wakeups: PersonaWakeupSummary[];
  /** The timezone a schedule created without one gets. */
  defaultTimezone: string;
}

// ── Human-readable cadence ──────────────────────────────────────────────────

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_ALIASES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_ALIASES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** A short label for `timezone`: "PT", "ET", "UTC", else its short offset form ("GMT+1"). */
export function timezoneLabel(timezone: string, at: Date = new Date()): string {
  if (timezone === "UTC" || timezone === "Etc/UTC") return "UTC";
  const part = (style: "shortGeneric" | "short") => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: style })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };
  const generic = part("shortGeneric");
  if (generic && generic.length <= 4 && !generic.includes(" ")) return generic;
  return part("short") ?? timezone;
}

/** The values in [min, max] a plain field lists (`5`, `1,3,5`, `1-5`, names), or null for anything else. */
function fieldValues(field: string, aliases: Record<string, number>, min: number, max: number): number[] | null {
  const values: number[] = [];
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length > 2) return null;
    const nums = range.map((r) => {
      const lower = r.toLowerCase();
      if (lower in aliases) return aliases[lower]!;
      return /^\d+$/.test(r) ? Number(r) : NaN;
    });
    if (nums.some((n) => !Number.isInteger(n) || n < min || n > max)) return null;
    if (nums.length === 2 && nums[0]! > nums[1]!) return null;
    if (nums.length === 1) values.push(nums[0]!);
    else for (let v = nums[0]!; v <= nums[1]!; v++) values.push(v);
  }
  return values;
}

function clockTime(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function dayList(days: number[]): string {
  const set = [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b);
  if (set.length === 7) return "Every day";
  if (set.join(",") === "1,2,3,4,5") return "Weekdays";
  if (set.join(",") === "0,6") return "Weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}

function ordinal(n: number): string {
  const rem = n % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * A human-readable cadence for a five-field cron expression, e.g. "Weekdays at
 * 9:00 PT" or "Every 15 minutes". Expressions it has no phrasing for come back
 * as `cron <expr> (<tz>)`.
 */
export function describeCron(expr: string, timezone: string, at: Date = new Date()): string {
  const tz = timezoneLabel(timezone, at);
  const fallback = `cron ${expr.trim()} (${tz})`;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];

  const anyDay = dom === "*" && mon === "*" && dow === "*";
  const step = /^\*\/(\d+)$/;
  if (anyDay && hour === "*") {
    if (min === "*") return "Every minute";
    const m = step.exec(min);
    if (m) return Number(m[1]) === 1 ? "Every minute" : `Every ${Number(m[1])} minutes`;
    const mins = fieldValues(min, {}, 0, 59);
    if (mins && mins.length === 1) return `Hourly at :${String(mins[0]).padStart(2, "0")}`;
    return fallback;
  }
  const hourStep = step.exec(hour);
  const mins = fieldValues(min, {}, 0, 59);
  if (anyDay && hourStep && mins && mins.length === 1) {
    const n = Number(hourStep[1]);
    return `Every ${n === 1 ? "hour" : `${n} hours`} at :${String(mins[0]).padStart(2, "0")}`;
  }

  const hours = fieldValues(hour, {}, 0, 23);
  if (!mins || mins.length !== 1 || !hours || hours.length === 0 || hours.length > 4) return fallback;
  const times = hours.map((h) => clockTime(h, mins[0]!)).join(", ");
  const when = `at ${times} ${tz}`;

  if (mon !== "*") {
    const months = fieldValues(mon, MONTH_ALIASES, 1, 12);
    const days = fieldValues(dom, {}, 1, 31);
    if (!months || !days || dow !== "*" || months.length !== 1 || days.length !== 1) return fallback;
    return `Every ${MONTH_NAMES[months[0]! - 1]} ${days[0]} ${when}`;
  }
  if (dom !== "*") {
    const days = fieldValues(dom, {}, 1, 31);
    if (!days || dow !== "*" || days.length > 3) return fallback;
    return `Monthly on the ${days.map(ordinal).join(", ")} ${when}`;
  }
  if (dow === "*") return `Daily ${when}`;
  const days = fieldValues(dow, DAY_ALIASES, 0, 7);
  if (!days) return fallback;
  return `${dayList(days)} ${when}`;
}
