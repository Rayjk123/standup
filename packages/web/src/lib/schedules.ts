/**
 * The Schedules page's logic: the `/api/persona/schedules` calls, the edit
 * form's mapping to and from create/update requests, and the formatting of a
 * schedule row and its runs. Kept free of React so it can be unit tested.
 */
import { describeCron } from "@standup/shared";
import type {
  CreateScheduleRequest,
  PersonaJobStatus,
  PersonaSchedule,
  PersonaScheduleRun,
  ScheduleCatchUpPolicy,
  ScheduleKind,
  ScheduleOverlapPolicy,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  SchedulesResponse,
  UpdateScheduleRequest,
} from "@standup/shared";
import { personaCall, signInNeededAs, withUser, type PersonaCallResult, type PersonaViewState } from "./persona";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** A run as the runs route returns it: the run plus the job it launched. */
export interface ScheduleRunDetail extends PersonaScheduleRun {
  jobTitle?: string;
  jobStatus?: PersonaJobStatus;
}

// ── API ─────────────────────────────────────────────────────────────────────

/** The viewer's schedules, or with `user` the host's read-only view of that user's. */
export function fetchSchedules(fetchFn: FetchFn = fetch, user?: string | null): Promise<PersonaCallResult<SchedulesResponse>> {
  return personaCall<SchedulesResponse>(withUser("/schedules", user), undefined, fetchFn);
}

export function createSchedule(
  request: CreateScheduleRequest,
  fetchFn: FetchFn = fetch
): Promise<PersonaCallResult<{ schedule: PersonaSchedule }>> {
  return personaCall("/schedules", { method: "POST", body: request }, fetchFn);
}

export function updateSchedule(
  id: string,
  patch: UpdateScheduleRequest,
  fetchFn: FetchFn = fetch
): Promise<PersonaCallResult<{ schedule: PersonaSchedule }>> {
  return personaCall(`/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }, fetchFn);
}

/** Sends `{}` as JSON like every Persona write: the collector refuses a write that isn't `application/json`. */
export function deleteSchedule(
  id: string,
  fetchFn: FetchFn = fetch
): Promise<PersonaCallResult<{ id: string; deleted: true }>> {
  return personaCall(`/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }, fetchFn);
}

export function runScheduleNow(
  id: string,
  fetchFn: FetchFn = fetch
): Promise<PersonaCallResult<{ run: ScheduleRunDetail; schedule: PersonaSchedule | null }>> {
  return personaCall(`/schedules/${encodeURIComponent(id)}/run`, { method: "POST" }, fetchFn);
}

export function fetchScheduleRuns(
  id: string,
  fetchFn: FetchFn = fetch,
  user?: string | null
): Promise<PersonaCallResult<{ runs: ScheduleRunDetail[] }>> {
  return personaCall(withUser(`/schedules/${encodeURIComponent(id)}/runs`, user), undefined, fetchFn);
}

/** What the Schedules page may do: write (create, edit, toggle, run, delete), and who must sign in when it can't. */
export interface ScheduleAccess {
  canWrite: boolean;
  /** Set when the viewer's own schedules are read-only until this browser signs in. */
  signInAs?: "owner" | "user";
}

/**
 * The Schedules page's access, from the shared Persona state: the host viewing
 * another user's schedules (`viewUser`) only reads; otherwise the page writes
 * unless this browser must sign in first (the state says it can't write, or a
 * Persona or schedule write was refused `sign-in`, `refusedSignIn`).
 */
export function scheduleAccess(
  persona: Pick<PersonaViewState, "state" | "signInNeeded" | "forbidden" | "forbiddenReason">,
  currentUser: string,
  viewUser: string | null,
  refusedSignIn = false
): ScheduleAccess {
  if (viewUser !== null) return { canWrite: false };
  const signInAs = signInNeededAs({ ...persona, signInNeeded: Boolean(persona.signInNeeded) || refusedSignIn }, currentUser);
  return signInAs ? { canWrite: false, signInAs } : { canWrite: true };
}

// ── Form ────────────────────────────────────────────────────────────────────

export interface ScheduleForm {
  /** The schedule being edited, or null for a new one. */
  id: string | null;
  title: string;
  kind: ScheduleKind;
  cron: string;
  timezone: string;
  note: string;
  brief: string;
  projectId: string;
  model: string;
  effort: string;
  overlap: ScheduleOverlapPolicy;
  catchUp: ScheduleCatchUpPolicy;
  /** A wall time in `timezone` ("2026-10-19T01:00", as a datetime-local input gives it), or "" for none. */
  endsAt: string;
  /** A positive whole number, or "" for none. */
  maxRuns: string;
}

/** `iso` as a wall time in `timezone`, "YYYY-MM-DDTHH:mm" (a datetime-local value). */
export function wallTimeIn(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
  } catch {
    return iso.slice(0, 16);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function blankScheduleForm(defaultTimezone: string): ScheduleForm {
  return {
    id: null,
    title: "",
    kind: "wake_persona",
    cron: "0 9 * * 1-5",
    timezone: defaultTimezone,
    note: "",
    brief: "",
    projectId: "",
    model: "",
    effort: "",
    overlap: "skip",
    catchUp: "run_once",
    endsAt: "",
    maxRuns: "",
  };
}

export function scheduleToForm(schedule: PersonaSchedule): ScheduleForm {
  return {
    id: schedule.id,
    title: schedule.title,
    kind: schedule.kind,
    cron: schedule.cron,
    timezone: schedule.timezone,
    note: schedule.note ?? "",
    brief: schedule.brief ?? "",
    projectId: schedule.projectId ?? "",
    model: schedule.model ?? "",
    effort: schedule.effort ?? "",
    overlap: schedule.overlap,
    catchUp: schedule.catchUp,
    endsAt: schedule.endsAt ? wallTimeIn(schedule.endsAt, schedule.timezone) : "",
    maxRuns: schedule.maxRuns !== undefined ? String(schedule.maxRuns) : "",
  };
}

/** The form's maxRuns as a number, null when blank, NaN when it isn't a positive whole number. */
function formMaxRuns(form: Pick<ScheduleForm, "maxRuns">): number | null {
  const raw = form.maxRuns.trim();
  if (!raw) return null;
  return /^\d+$/.test(raw) && Number(raw) >= 1 ? Number(raw) : NaN;
}

/** The obvious mistakes, caught before the round-trip; the collector validates everything again. */
export function validateScheduleForm(form: ScheduleForm): string | null {
  if (!form.title.trim()) return "A title is required.";
  const fields = form.cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return "The cron expression needs five fields: minute hour day-of-month month day-of-week.";
  if (!form.timezone.trim()) return "A timezone is required.";
  if (form.kind === "wake_persona" && !form.note.trim()) return "A wake schedule needs the note Persona wakes with.";
  if (form.kind === "launch_job" && !form.brief.trim()) return "A launch schedule needs the brief its worker starts from.";
  if (Number.isNaN(formMaxRuns(form))) return "Max runs must be a whole number of 1 or more, or blank for no limit.";
  if (form.endsAt.trim() && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(form.endsAt.trim())) return "The end time must be a date and time.";
  return null;
}

export function formToCreateRequest(form: ScheduleForm): CreateScheduleRequest {
  const base = {
    title: form.title.trim(),
    cron: form.cron.trim(),
    timezone: form.timezone.trim(),
    kind: form.kind,
    overlap: form.overlap,
    catchUp: form.catchUp,
    ...(form.endsAt.trim() ? { endsAt: form.endsAt.trim() } : {}),
    ...(formMaxRuns(form) ? { maxRuns: formMaxRuns(form)! } : {}),
  };
  if (form.kind === "wake_persona") return { ...base, note: form.note.trim() };
  return {
    ...base,
    brief: form.brief.trim(),
    ...(form.projectId.trim() ? { projectId: form.projectId.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.effort.trim() ? { effort: form.effort.trim() } : {}),
  };
}

/**
 * The fields the form changed from `original`. Only changed fields are sent:
 * a changed cadence or timezone restarts the schedule from now, so an edit to
 * the title alone leaves its next run where it was. A cleared optional field
 * goes as "", which clears it.
 */
export function formToUpdateRequest(form: ScheduleForm, original: PersonaSchedule): UpdateScheduleRequest {
  const was = scheduleToForm(original);
  const patch: UpdateScheduleRequest = {};
  const keys: Array<keyof UpdateScheduleRequest & keyof ScheduleForm> =
    original.kind === "wake_persona"
      ? ["title", "cron", "timezone", "note", "overlap", "catchUp"]
      : ["title", "cron", "timezone", "brief", "projectId", "model", "effort", "overlap", "catchUp"];
  for (const key of keys) {
    const next = String(form[key]).trim();
    if (next !== String(was[key]).trim()) (patch as Record<string, string>)[key] = next;
  }
  // An edited end time goes as the wall time typed, read in the form's
  // timezone; blank clears it. Left alone, the stored instant stays put, even
  // when the timezone changes.
  if (form.endsAt.trim() !== was.endsAt.trim()) patch.endsAt = form.endsAt.trim() || null;
  const maxRuns = formMaxRuns(form);
  if (maxRuns !== (original.maxRuns ?? null)) patch.maxRuns = maxRuns;
  return patch;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const KIND_LABELS: Record<ScheduleKind, string> = {
  wake_persona: "wake Persona",
  launch_job: "launch job",
};

export const TRIGGER_LABELS: Record<ScheduleRunTrigger, string> = {
  cron: "scheduled",
  catch_up: "catch-up",
  manual: "run now",
};

export const OVERLAP_LABELS: Record<ScheduleOverlapPolicy, string> = {
  skip: "Skip a run while the last one is still going",
  allow: "Run even if the last one is still going",
};

export const CATCH_UP_LABELS: Record<ScheduleCatchUpPolicy, string> = {
  run_once: "Run the latest missed slot once",
  skip: "Skip missed slots",
};

/** The colour family of an outcome badge; the view maps it to theme colours. */
export type OutcomeTone = "running" | "done" | "failed" | "skipped";

export function outcomeBadge(status: ScheduleRunStatus): { label: string; tone: OutcomeTone } {
  switch (status) {
    case "starting":
      return { label: "starting", tone: "running" };
    case "running":
      return { label: "running", tone: "running" };
    case "done":
      return { label: "done", tone: "done" };
    case "failed":
      return { label: "failed", tone: "failed" };
    case "skipped":
      return { label: "skipped", tone: "skipped" };
  }
}

/**
 * The cadence in words with the stored timezone always named, e.g. "Weekdays
 * at 9:00 ET (America/New_York)". The IANA name is left off only when it reads
 * the same as the short label ("UTC").
 */
export function cadenceLabel(schedule: Pick<PersonaSchedule, "cron" | "timezone">, at: Date = new Date()): string {
  const described = describeCron(schedule.cron, schedule.timezone, at);
  if (described.startsWith("cron ")) return `cron ${schedule.cron.trim()} (${schedule.timezone})`;
  return described.endsWith(` ${schedule.timezone}`) ? described : `${described} (${schedule.timezone})`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "in 5m", "in 3h 10m", "in 2d", "4m ago", "just now". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = Date.parse(iso) - now.getTime();
  if (!Number.isFinite(diff)) return "";
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "just now";
  let span: string;
  if (abs < HOUR) span = `${Math.round(abs / MINUTE)}m`;
  else if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs - h * HOUR) / MINUTE);
    span = m > 0 && h < 6 ? `${h}h ${m}m` : `${Math.round(abs / HOUR)}h`;
  } else span = `${Math.round(abs / DAY)}d`;
  return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** A local absolute time, e.g. "Mon, Oct 6, 9:00 AM". `timeZone` pins it (tests); the viewer's zone otherwise. */
export function absoluteTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** What the Next run column says: absolute and relative, or why there is none. */
export function nextRunLabel(
  schedule: Pick<PersonaSchedule, "enabled" | "nextRunAt" | "endedAt">,
  now: Date = new Date(),
  timeZone?: string
): { primary: string; secondary?: string } {
  if (schedule.endedAt) return { primary: "ended", secondary: relativeTime(schedule.endedAt, now) };
  if (!schedule.enabled) return { primary: "paused" };
  if (!schedule.nextRunAt) return { primary: "no upcoming run" };
  return { primary: absoluteTime(schedule.nextRunAt, timeZone), secondary: relativeTime(schedule.nextRunAt, now) };
}

/** Where a run's links go: its session, else its launch, and the job it belongs to. */
export function runLinks(run: ScheduleRunDetail): Array<{ label: string; to: string }> {
  const links: Array<{ label: string; to: string }> = [];
  if (run.sessionId) links.push({ label: "session", to: `/work/s/${run.sessionId}` });
  else if (run.launchId) links.push({ label: "launch", to: `/work/l/${run.launchId}` });
  if (run.jobId) links.push({ label: run.jobTitle ? `job: ${run.jobTitle}` : "job", to: "/persona" });
  return links;
}

/** A run's reason or error, for its row and the last-outcome tooltip. */
export function runDetail(run: Pick<PersonaScheduleRun, "reason" | "error">): string | undefined {
  return run.error ?? run.reason;
}

/** The timezones the form offers: the browser's list when it has one, with the current value kept. */
export function timezoneOptions(current: string, defaultTimezone: string): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const listed = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  const all = new Set<string>(["UTC", ...listed]);
  for (const tz of [current, defaultTimezone]) if (tz) all.add(tz);
  return [...all].sort((a, b) => a.localeCompare(b));
}
