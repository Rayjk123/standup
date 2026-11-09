import type { Database } from "bun:sqlite";
import type { NotifyPrefs, PersonaJob, PersonaSchedule } from "@standup/shared";
import { CODE_REVIEW_STAGE_KIND, STALL_THRESHOLD_MINUTES, parseBriefTime } from "@standup/shared";
import {
  countQueuedPersonaLaunches,
  getPersonaSchedule,
  lastSentPersonaBrief,
  listPendingPersonaApprovalsAwaiting,
  listPersonaApprovals,
  listPersonaFloorDecisions,
  listPersonaJobs,
  listPersonaScheduleRunsByStatus,
  listPersonaSchedules,
  listPipelineRunsByLaunches,
  listReviewPackets,
  listUnansweredPersonaQuestions,
} from "@standup/store";
import { nextSlot, parseSchedule } from "./cron.js";
import { sanitizeUntrusted } from "./prompt.js";

// The daily brief: a digest of one user's own Standup state, assembled here in
// code, that Persona turns into a short message at the user's brief time.
// Every source is read by owner, so a brief never names another user's jobs
// or reviews; a card another user's Persona raised for this user to decide is
// named by its summary alone.

/** How long a pending approval lives before it expires. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** How far back the first brief (or one after a long gap) looks. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** A slot missed by more than this (the collector was down) is skipped, not sent late. */
export const BRIEF_GRACE_MS = 3 * 60 * 60 * 1000;
/** Most lines of each digest section. */
const MAX_SECTION_LINES = 12;
/** Stages at or past which a run's work is built but not yet published (code review not cut, review not decided). */
const UNPUBLISHED_STAGES = new Set(["deploy", "screenshot", CODE_REVIEW_STAGE_KIND, "human_review"]);

export interface BriefJobLine {
  jobId: string;
  title: string;
  /** What happened or where it stands, already worded. */
  detail: string;
}

export interface BriefDigest {
  since: string;
  until: string;
  /** Jobs opened, progressed or closed since the last brief. */
  did: BriefJobLine[];
  /** What waits on the user: approvals, questions, reviews, held or unpublished work. */
  waiting: BriefJobLine[];
  /** Jobs whose workers are running now. */
  running: BriefJobLine[];
  /** Launches queued for a free slot. */
  queued: number;
  /** Schedule runs that failed since the last brief. */
  failures: string[];
}

/** Whether the digest has nothing to report: nothing changed and nothing waits on the user. */
export function briefIsEmpty(d: BriefDigest): boolean {
  return d.did.length === 0 && d.waiting.length === 0 && d.failures.length === 0;
}

/**
 * How long a pending card has left, worded ("5h", "10 min"); null once it has
 * lapsed. A carded safety-floor hold is denied at its own `holdExpiresAt`,
 * usually well before the card's TTL, so the earlier of the two counts.
 */
function timeLeft(card: { createdAt: string; args: Record<string, unknown> }, nowMs: number): string | null {
  let expiresMs = Date.parse(card.createdAt) + APPROVAL_TTL_MS;
  const holdMs = typeof card.args.holdExpiresAt === "string" ? Date.parse(card.args.holdExpiresAt) : Number.NaN;
  if (holdMs < expiresMs) expiresMs = holdMs;
  const ms = expiresMs - nowMs;
  if (!(ms > 0)) return null;
  const minutes = Math.ceil(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.round(ms / 3_600_000)}h`;
}

function within(iso: string | undefined, since: string): boolean {
  return !!iso && iso >= since;
}

/**
 * The digest of `owner`'s own state since `since`. Reads only rows the user
 * owns (and approvals they decide), so it is safe to hand to their Persona
 * whichever thread it replies in.
 */
export function buildBriefDigest(db: Database, owner: string, opts: { since: string; now: Date }): BriefDigest {
  const { since } = opts;
  const nowMs = opts.now.getTime();
  const jobs = listPersonaJobs(db, owner, { limit: 500 });
  const open = jobs.filter((j) => j.status === "active" || j.status === "waiting_user");

  const did: BriefJobLine[] = [];
  // An Allow once on a safety-floor hold posts no thread message; it is
  // recorded as a floor decision, so the brief reads it from there. These
  // lead the section so its line cap never hides them.
  for (const f of listPersonaFloorDecisions(db, owner, { limit: 100 }).reverse()) {
    if (!within(f.createdAt, since)) continue;
    const job = f.jobId ? jobs.find((j) => j.id === f.jobId) : undefined;
    did.push({ jobId: job?.id ?? "", title: job?.title ?? "Safety floor", detail: `allowed once: ${f.call} (reason: ${f.reason})` });
  }
  for (const job of jobs) {
    const closed = job.status === "done" || job.status === "failed" || job.status === "cancelled";
    if (closed && within(job.updatedAt, since)) {
      did.push({ jobId: job.id, title: job.title, detail: `${job.status}${job.outcome ? `: ${job.outcome}` : ""}` });
    } else if (!closed && within(job.noteAt, since) && job.note) {
      did.push({ jobId: job.id, title: job.title, detail: `progress: ${job.note}` });
    } else if (!closed && within(job.createdAt, since)) {
      did.push({ jobId: job.id, title: job.title, detail: "opened" });
    }
  }

  const waiting: BriefJobLine[] = [];
  const approvalJobs = new Set<string>();
  for (const a of listPendingPersonaApprovalsAwaiting(db, owner)) {
    const left = timeLeft(a, nowMs);
    // Past its TTL or hold deadline, the card expires on the next tick.
    if (!left) continue;
    if (a.owner !== owner) {
      // A card raised by another user's Persona that this user decides: its
      // job is the other user's, so only the card itself is named.
      waiting.push({ jobId: "", title: `${a.owner}'s Persona`, detail: `decision for them: ${a.summary} (expires in ${left})` });
      continue;
    }
    if (a.jobId) approvalJobs.add(a.jobId);
    const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : undefined;
    waiting.push({ jobId: a.jobId ?? "", title: job?.title ?? a.action, detail: `approval waiting: ${a.summary} (expires in ${left})` });
  }

  const questionJobs = new Set<string>();
  for (const q of listUnansweredPersonaQuestions(db, owner, new Date(nowMs - MAX_LOOKBACK_MS).toISOString())) {
    const jobId = q.jobIds?.find((id) => jobs.some((j) => j.id === id)) ?? "";
    if (jobId) questionJobs.add(jobId);
    const title = jobs.find((j) => j.id === jobId)?.title ?? "Question";
    waiting.push({ jobId, title, detail: `Persona asked: ${q.text}` });
  }

  const runsByJob = new Map(open.map((j) => [j.id, listPipelineRunsByLaunches(db, j.launchIds).filter((r) => r.status !== "disabled")]));
  const stalled = new Set<string>();
  for (const job of open) {
    const needs = job.view?.state === "needs_you" ? (job.view.needs ?? []) : [];
    if (needs.includes("question") && !questionJobs.has(job.id)) {
      waiting.push({ jobId: job.id, title: job.title, detail: "Persona asked you a question" });
    }
    const held = (runsByJob.get(job.id) ?? []).filter((r) => r.status === "waiting_user");
    // A held pipeline marks its job waiting too; its line says why, so the job's own is left out.
    if (needs.includes("waiting") && !approvalJobs.has(job.id) && held.length === 0) {
      waiting.push({ jobId: job.id, title: job.title, detail: `waiting on you${job.note ? `: ${job.note}` : ""}` });
    }
    for (const run of runsByJob.get(job.id) ?? []) {
      if (run.status === "waiting_user") {
        waiting.push({ jobId: job.id, title: job.title, detail: `pipeline held at ${run.currentStage}${run.waitingReason ? `: ${run.waitingReason}` : ""}` });
      } else if (run.status === "active" && UNPUBLISHED_STAGES.has(run.currentStage) && job.view?.state !== "running") {
        waiting.push({ jobId: job.id, title: job.title, detail: `unpublished: stopped at the ${run.currentStage} stage` });
      }
    }
    const quietMs = job.view?.lastActivityAt ? nowMs - Date.parse(job.view.lastActivityAt) : 0;
    if (job.view?.state === "running" && quietMs > STALL_THRESHOLD_MINUTES * 60_000) {
      stalled.add(job.id);
      waiting.push({ jobId: job.id, title: job.title, detail: `worker looks stalled: no activity for ${Math.round(quietMs / 60_000)} min` });
    }
  }
  for (const a of listPersonaApprovals(db, owner, "pending")) {
    if (a.approver && a.approver !== owner) {
      const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : undefined;
      waiting.push({ jobId: a.jobId ?? "", title: job?.title ?? a.action, detail: `held for ${a.approver}'s approval: ${a.summary}` });
    }
  }
  for (const p of listReviewPackets(db, { owner, status: "pending", limit: 50 })) {
    waiting.push({ jobId: "", title: p.title, detail: `review packet awaiting your decision${p.branch ? ` (${p.branch})` : ""}` });
  }

  const running: BriefJobLine[] = [];
  for (const job of open) {
    if (job.view?.state !== "running" || stalled.has(job.id)) continue;
    const run = (runsByJob.get(job.id) ?? []).find((r) => r.status === "active");
    running.push({ jobId: job.id, title: job.title, detail: run ? `running, at the ${run.currentStage} stage` : "running" });
  }

  // A skipped run is routine (an overlap, a paused Persona); only failures are reported.
  const failures = listPersonaScheduleRunsByStatus(db, owner, ["failed"])
    .filter((r) => within(r.startedAt, since))
    .map((r) => {
      const title = getPersonaSchedule(db, r.scheduleId)?.title ?? "a schedule";
      return `"${title}" ${r.status}${r.error || r.reason ? `: ${r.error ?? r.reason}` : ""}`;
    });

  return {
    since,
    until: opts.now.toISOString(),
    did,
    waiting,
    running,
    queued: countQueuedPersonaLaunches(db, owner),
    failures,
  };
}

/** Where the next digest starts: the last sent brief's slot, within MAX_LOOKBACK_MS, else a day back. */
export function briefSince(db: Database, owner: string, now: Date): string {
  const nowMs = now.getTime();
  const last = lastSentPersonaBrief(db, owner);
  const lastMs = last ? Date.parse(last.slot) : NaN;
  const from = Number.isFinite(lastMs) && nowMs - lastMs <= MAX_LOOKBACK_MS ? lastMs : nowMs - DEFAULT_LOOKBACK_MS;
  return new Date(from).toISOString();
}

function jobLine(l: BriefJobLine): string {
  const ref = l.jobId ? ` (job ${l.jobId})` : "";
  // A title can't close its own quotes and pass the rest for another entry.
  const title = sanitizeUntrusted(l.title, 120).replace(/"/g, "'");
  return `- "${title}"${ref} — ${sanitizeUntrusted(l.detail, 240)}`;
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [`${title}: none`];
  const shown = lines.slice(0, MAX_SECTION_LINES);
  const more = lines.length - shown.length;
  return [`${title}:`, ...shown, ...(more > 0 ? [`- …and ${more} more`] : [])];
}

/** The digest as plain lines for the turn prompt; every field from a job, worker or schedule is flattened and clipped. */
export function renderBriefDigest(d: BriefDigest): string[] {
  return [
    `Window: ${d.since} → ${d.until}`,
    ...section("What you (Persona) did", d.did.map(jobLine)),
    ...section("Waiting on the owner", d.waiting.map(jobLine)),
    ...section("Running", d.running.map(jobLine)),
    ...(d.queued > 0 ? [`Queued launches: ${d.queued}`] : []),
    ...section("Failed schedule runs", d.failures.map((f) => `- ${sanitizeUntrusted(f, 240)}`)),
  ];
}

/**
 * The latest brief slot at or before `now` for a daily `time` in `timezone`,
 * or null when the time is malformed.
 */
export function latestBriefSlot(time: string, timezone: string, now: Date): Date | null {
  const t = parseBriefTime(time);
  if (!t) return null;
  const parsed = parseSchedule(`${t.minute} ${t.hour} * * *`, timezone, now);
  if (!parsed.ok) return null;
  let latest: Date | null = null;
  // Two days back always contains at least one daily slot, DST included.
  for (let at = nextSlot(parsed.cron, new Date(now.getTime() - 48 * 3_600_000)); at && at.getTime() <= now.getTime(); at = nextSlot(parsed.cron, at)) {
    latest = at;
  }
  return latest;
}

/** The next brief slot after `now`, or null when the time is malformed. */
export function nextBriefSlot(time: string, timezone: string, now: Date): Date | null {
  const t = parseBriefTime(time);
  if (!t) return null;
  const parsed = parseSchedule(`${t.minute} ${t.hour} * * *`, timezone, now);
  return parsed.ok ? nextSlot(parsed.cron, now) : null;
}

/** Whether `a` and `b` fall on the same calendar day in `timezone`. */
export function sameLocalDay(a: Date, b: Date, timezone: string): boolean {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  return day.format(a) === day.format(b);
}

const REPORT_TITLE_RE = /\b(report|brief|briefing|digest|check-in)\b/i;
/** A schedule firing at least this far apart fires at most once a day. */
const DAILY_GAP_MS = 20 * 60 * 60 * 1000;

/** Whether `s` fires at most once a day (daily, weekdays, weekly). */
function firesAtMostDaily(s: PersonaSchedule, now: Date): boolean {
  const parsed = parseSchedule(s.cron, s.timezone, now);
  if (!parsed.ok) return false;
  let at = nextSlot(parsed.cron, now);
  for (let i = 0; at && i < 3; i++) {
    const next = nextSlot(parsed.cron, at);
    if (next && next.getTime() - at.getTime() < DAILY_GAP_MS) return false;
    at = next;
  }
  return true;
}

/**
 * The user's enabled recurring wakeups that read as a report they set up
 * themselves (e.g. "Daily report (9am ET)"): titled like one and firing at
 * most once a day. While one runs, the brief stays off unless the user turns
 * it on, so they never get two morning reports.
 */
export function legacyReportSchedules(db: Database, owner: string, now: Date = new Date()): PersonaSchedule[] {
  return listPersonaSchedules(db, owner, { enabledOnly: true }).filter(
    (s) => s.kind === "wake_persona" && REPORT_TITLE_RE.test(s.title) && firesAtMostDaily(s, now)
  );
}

/** Whether the user's brief is on: their explicit choice, else on unless a legacy report schedule runs. */
export function briefEnabled(db: Database, owner: string, prefs: NotifyPrefs, now: Date = new Date()): boolean {
  if (prefs.brief.enabled !== undefined) return prefs.brief.enabled;
  return legacyReportSchedules(db, owner, now).length === 0;
}

/** Whether a job is waiting on its owner, for progress updates routed `needs_you`. */
export function jobNeedsOwner(job: PersonaJob | null | undefined): boolean {
  return !!job && (job.status === "waiting_user" || job.view?.state === "needs_you");
}
