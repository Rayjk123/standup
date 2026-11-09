import type { Database } from "bun:sqlite";
import type { PersonaJob, ScheduleWatch } from "@standup/shared";
import {
  getPersonaJob,
  getSession,
  listPersonaJobs,
  listReviewPackets,
  personaJobActions,
  personaJobIdsInThread,
} from "@standup/store";
import type { ScheduleWatchFacts } from "@standup/store";
import { pipelineJobSummary } from "../pipeline/engine.js";

/**
 * A watched wake_persona schedule's pre-check (see ScheduleWatch): the facts
 * it watches, read straight from the store with no model turn, and what
 * changed between two readings. A run wakes Persona only when the changes
 * are non-empty.
 */

/** Closed jobs stay in a `jobs` reading this long, so a job closing reads as a change. */
const CLOSED_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 200;
const MAX_REVIEWS = 200;
const MAX_TITLE_CHARS = 60;
/** Changes listed in a wake's note; the rest are counted. */
export const MAX_WATCH_CHANGES = 10;
const MAX_CHANGE_CHARS = 300;

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** The reading's entry naming what it was scoped to: every thread, or one non-private thread. */
export const WATCH_SCOPE_KEY = "scope";

function short(id: string): string {
  return id.slice(0, 8);
}

function titled(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat);
}

/** One job's state in a line: status, worker sessions, pipeline stage, and what waits on the owner. */
function jobLine(db: Database, job: PersonaJob): string {
  if (TERMINAL.has(job.status)) return job.status;
  const parts: string[] = [job.status];
  const sessions = job.sessionIds.map((id) => {
    const session = getSession(db, id);
    const status = !session ? "unknown" : session.endedAt || session.status === "done" ? "ended" : session.status;
    return `${short(id)} ${status}`;
  });
  if (sessions.length > 0) parts.push(`sessions ${sessions.join(", ")}`);
  const pipeline = pipelineJobSummary(db, job.launchIds);
  if (pipeline) parts.push(`pipeline ${pipeline.stage} ${pipeline.status}${pipeline.round ? ` round ${pipeline.round}` : ""}`);
  const actions = personaJobActions(db, job.id);
  if (actions.length > 0) parts.push(`waiting on you: ${actions.map((a) => `${a.kind} ${short(a.id)}`).join(", ")}`);
  return parts.join("; ");
}

function jobKey(job: PersonaJob): string {
  return `job ${short(job.id)} ${titled(job.title)}`;
}

/** Whether a reading's entry is a job's (rather than a review packet's or the scope). */
export function isWatchJobKey(key: string): boolean {
  return key.startsWith("job ");
}

/**
 * What `watch` sees of `owner`'s work right now. `threadId` names the
 * schedule's thread when it isn't private: as in that thread's turn
 * snapshot, only its own jobs, and only review packets of those jobs, count.
 */
export function watchFacts(db: Database, owner: string, watch: ScheduleWatch, now: Date, threadId?: string): ScheduleWatchFacts {
  const facts: ScheduleWatchFacts = { [WATCH_SCOPE_KEY]: threadId ? `thread ${threadId}` : "all" };
  const inScope = (job: PersonaJob) => job.owner === owner && (!threadId || job.threadId === threadId);
  if (watch.kind === "job") {
    const job = watch.jobId ? getPersonaJob(db, watch.jobId) : null;
    if (job && inScope(job)) facts[jobKey(job)] = jobLine(db, job);
    return facts;
  }
  if (watch.kind === "jobs") {
    const since = new Date(now.getTime() - CLOSED_JOB_WINDOW_MS).toISOString();
    for (const job of listPersonaJobs(db, owner, { status: ["active", "waiting_user"], closedSince: since, limit: MAX_JOBS })) {
      if (inScope(job)) facts[jobKey(job)] = jobLine(db, job);
    }
  }
  const threadJobs = threadId ? new Set(personaJobIdsInThread(db, owner, threadId)) : null;
  for (const packet of listReviewPackets(db, { owner, status: "pending", limit: MAX_REVIEWS })) {
    if (threadJobs && !(packet.jobId && threadJobs.has(packet.jobId))) continue;
    facts[`review ${short(packet.id)} ${titled(packet.title)}`] = `pending, revision ${packet.revision}`;
  }
  return facts;
}

/**
 * What changed from `before` to `after`, one line each: a thing that is new,
 * one whose state moved, one no longer there. A closed job ageing out of the
 * reading isn't a change. At most MAX_WATCH_CHANGES lines, then a count.
 */
export function watchChanges(before: ScheduleWatchFacts, after: ScheduleWatchFacts): string[] {
  const changes: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    if (was === undefined) changes.push(`${key}: new — ${value}`);
    else if (was !== value) changes.push(`${key}: ${was} → ${value}`);
  }
  for (const [key, was] of Object.entries(before)) {
    if (key in after || TERMINAL.has(was)) continue;
    changes.push(key.startsWith("review ") ? `${key}: decided or withdrawn` : `${key}: no longer listed (was ${was})`);
  }
  const clipped = changes.map((c) => (c.length > MAX_CHANGE_CHARS ? `${c.slice(0, MAX_CHANGE_CHARS - 1)}…` : c));
  if (clipped.length <= MAX_WATCH_CHANGES) return clipped;
  return [...clipped.slice(0, MAX_WATCH_CHANGES), `and ${clipped.length - MAX_WATCH_CHANGES} more`];
}
