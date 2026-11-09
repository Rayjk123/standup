import type { Context, Hono } from "hono";
import type {
  PersonaJobStatus,
  PersonaScheduleRun,
  PersonaWakeupSummary,
  SchedulesResponse,
} from "@standup/shared";
import {
  getLaunch,
  getOrCreatePersonaConsoleThread,
  getPersonaJob,
  getPersonaSchedule,
  listPendingPersonaInbox,
  listPersonaScheduleRuns,
  listPersonaSchedules,
} from "@standup/store";
import type { Database } from "bun:sqlite";
import { ownerTimezone } from "./cron.js";
import type { PersonaRuntime } from "./runtime.js";

const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

/**
 * A schedule run as the Schedules page shows it: the run plus the job it
 * launched (title and status) and the session the launch bound to, so the row
 * can link straight to the worker.
 */
export interface PersonaScheduleRunDetail extends PersonaScheduleRun {
  jobTitle?: string;
  jobStatus?: PersonaJobStatus;
}

export interface ScheduleRoutesOptions {
  db: Database;
  /** The human-route gate: the caller's own Persona, or a refusal Response. */
  gate(c: Context): { owner: string; runtime: PersonaRuntime } | Response;
  /** The read-only gate: the caller's Persona, or (`?user=`, the host only) another user's. */
  viewGate(c: Context): { owner: string; runtime?: PersonaRuntime } | Response;
}

/** The owner's pending one-shot wakeups (schedule_wakeup), soonest first; recurring runs and briefs in flight are left out. */
export function listOneShotWakeups(db: Database, owner: string): PersonaWakeupSummary[] {
  return listPendingPersonaInbox(db, owner, "schedule")
    .filter((item) => item.payload.scheduleId === undefined && item.payload.brief !== true)
    .map((item) => ({
      id: item.id,
      note: typeof item.payload.note === "string" ? item.payload.note : "",
      ...(item.notBefore ? { at: item.notBefore } : {}),
      ...(item.threadId ? { threadId: item.threadId } : {}),
      ...(typeof item.payload.jobId === "string" ? { jobId: item.payload.jobId } : {}),
      createdAt: item.createdAt,
    }))
    .sort((a, b) => (a.at ?? a.createdAt).localeCompare(b.at ?? b.createdAt));
}

/** A run with its job's title and status, and the session its launch bound to when the run hasn't recorded one. */
function detailRun(db: Database, run: PersonaScheduleRun): PersonaScheduleRunDetail {
  const job = run.jobId ? getPersonaJob(db, run.jobId) : null;
  const launch = run.launchId ? getLaunch(db, run.launchId) : null;
  const sessionId = run.sessionId ?? launch?.sessionId ?? job?.sessionIds[job.sessionIds.length - 1];
  return {
    ...run,
    ...(sessionId ? { sessionId } : {}),
    ...(job ? { jobTitle: job.title, jobStatus: job.status } : {}),
  };
}

function parseLimit(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RUN_LIMIT;
  return Math.min(n, MAX_RUN_LIMIT);
}

/** A scheduler refusal as a response: its status when it names one the routes use, else 400. */
function failure(c: Context, result: { error: string; status?: number }): Response {
  const status = result.status === 404 ? 404 : result.status === 409 ? 409 : result.status === 503 ? 503 : 400;
  return c.json({ error: result.error }, status);
}

async function jsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const body = await c.req.json<unknown>().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * The caller's schedule routes under `/api/persona/schedules`, behind the same
 * gates as Persona's other human routes: each user sees and changes only their
 * own Persona's schedules (another user's id reads as unknown), and the host
 * may view a user's with `?user=`. These are the user acting directly: a
 * create is not put to Persona's policy (the scheduler still validates every
 * field), and Run now is attended, so a launch the policy would hold still runs.
 */
export function mountScheduleRoutes(app: Hono, opts: ScheduleRoutesOptions): void {
  const { db, gate, viewGate } = opts;

  app.get("/api/persona/schedules", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const response: SchedulesResponse = {
      schedules: listPersonaSchedules(db, g.owner),
      wakeups: listOneShotWakeups(db, g.owner),
      defaultTimezone: g.runtime?.schedules.defaultTimezone() ?? ownerTimezone(),
    };
    return c.json(response);
  });

  app.post("/api/persona/schedules", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const body = await jsonObject(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);
    const result = g.runtime.schedules.create(body, {
      createdBy: g.owner,
      threadId: getOrCreatePersonaConsoleThread(db, g.owner).id,
    });
    if (!result.ok) return failure(c, result);
    return c.json({ schedule: result.value }, 201);
  });

  app.patch("/api/persona/schedules/:id", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const body = await jsonObject(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);
    const result = g.runtime.schedules.update(c.req.param("id"), body);
    if (!result.ok) return failure(c, result);
    return c.json({ schedule: result.value });
  });

  app.delete("/api/persona/schedules/:id", (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    if (!g.runtime.schedules.remove(id)) return c.json({ error: `no schedule ${id}` }, 404);
    return c.json({ id, deleted: true });
  });

  app.post("/api/persona/schedules/:id/run", async (c) => {
    const g = gate(c);
    if (g instanceof Response) return g;
    const result = await g.runtime.schedules.runNow(c.req.param("id"), { approved: true });
    if (!result.ok) return failure(c, result);
    return c.json({ run: detailRun(db, result.value), schedule: g.runtime.schedules.get(c.req.param("id")) });
  });

  app.get("/api/persona/schedules/:id/runs", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    const schedule = getPersonaSchedule(db, id);
    if (!schedule || schedule.owner !== g.owner) return c.json({ error: `no schedule ${id}` }, 404);
    const runs = listPersonaScheduleRuns(db, id, parseLimit(c.req.query("limit"))).map((run) => detailRun(db, run));
    return c.json({ runs });
  });
}
