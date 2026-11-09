import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Launch, LaunchProcess, WsMessage } from "@standup/shared";
import { WORKER_TOKEN_HEADER } from "@standup/shared";
import { tokenMatches } from "@standup/shared/write-token";
import {
  getLaunch,
  getLaunchByReviewTokenHash,
  getLaunchReviewTokenHash,
  getPersonaJob,
  listLiveProcessesForJob,
  listLiveProcessesForLaunch,
  personaJobForLaunch,
  personaJobForSession,
} from "@standup/store";
import { workerTokenHash } from "./floor/gate.js";
import { noteJobActivity, onJobClosed } from "./job-hygiene.js";
import type { PaneAlive } from "./launch-holds.js";
import { registerProcess, unitPrefix, type ProcessSystem } from "./process-registry.js";

export interface ProcessRoutesOptions {
  db: Database;
  sys: ProcessSystem;
  installDir: string;
  /** A refusal unless the request is a human's through the console (server.ts humanRefusal). */
  humanRefusal: (c: Context, what: string) => Response | null;
  /** The request's own identity — never a body-supplied actor. */
  identityOf: (c: Context) => string;
  /** The owner whose Persona made the request, or undefined when it isn't Persona's. */
  personaOwnerOf: (c: Context) => string | undefined;
  broadcast?: (message: WsMessage) => void;
  scratchRoot?: string;
  graceMs?: number;
  /** Whether a running launch's pane still exists, for a hygiene run's liveness checks; defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
}

function isLive(launch: Launch): boolean {
  return launch.status === "starting" || launch.status === "running";
}

function jobIdOf(db: Database, launch: Launch): string | undefined {
  return personaJobForLaunch(db, launch.id)?.job.id ?? (launch.sessionId ? personaJobForSession(db, launch.sessionId)?.job.id : undefined);
}

/**
 * The worker process registry's API. A worker registers the long-lived
 * processes it starts and lists its own; Persona (for its owner's jobs) and
 * the console read a job's or launch's registry and run a closed job's
 * hygiene (stop its processes, remove its scratch dirs).
 */
export function mountProcessRoutes(app: Hono, opts: ProcessRoutesOptions): void {
  const { db } = opts;

  const notAWorker = (c: Context) => c.json({ error: "Processes are registered only by a worker holding a Standup worker token (a Claude launch, for its own launch); Codex and adopted launches without one can't register" }, 403);

  /**
   * The launch a worker request speaks for: the one whose worker token it
   * carries (WORKER_TOKEN_HEADER) — a session id or cwd, which any local
   * process can name, never stands in for it. A refusal for Persona, no token
   * or one that doesn't match, or a launch no longer running.
   */
  const workerLaunchOf = (c: Context): Launch | Response => {
    if (opts.personaOwnerOf(c)) return notAWorker(c);
    const presented = c.req.header(WORKER_TOKEN_HEADER)?.trim();
    if (!presented) return notAWorker(c);
    const hash = workerTokenHash(presented);
    const launch = getLaunchByReviewTokenHash(db, hash);
    const expected = launch ? getLaunchReviewTokenHash(db, launch.id) : null;
    if (!launch || !expected || !tokenMatches(hash, expected)) return notAWorker(c);
    if (!isLive(launch)) return notAWorker(c);
    return launch;
  };

  /** Who a read or hygiene request acts for: Persona's owner, or the signed-in human; a refusal otherwise. */
  const actorOf = (c: Context, what: string): { owner: string } | Response => {
    const personaOwner = opts.personaOwnerOf(c);
    if (personaOwner) return { owner: personaOwner };
    const refused = opts.humanRefusal(c, what);
    return refused ?? { owner: opts.identityOf(c) };
  };

  app.post("/api/processes/register", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const launch = workerLaunchOf(c);
    if (launch instanceof Response) return launch;
    const pid = body.pid;
    const unit = body.unit;
    const port = body.port;
    if (pid !== undefined && typeof pid !== "number") return c.json({ error: "pid must be a number" }, 400);
    if (unit !== undefined && typeof unit !== "string") return c.json({ error: "unit must be a string" }, 400);
    if (port !== undefined && typeof port !== "number") return c.json({ error: "port must be a number" }, 400);
    if (typeof body.label !== "string") return c.json({ error: "label is required" }, 400);
    const jobId = jobIdOf(db, launch);
    const result = registerProcess(
      db,
      opts.sys,
      {
        launch,
        ...(jobId ? { jobId } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(unit !== undefined ? { unit } : {}),
        label: body.label,
        ...(port !== undefined ? { port } : {}),
      },
      { installDir: opts.installDir, ...(opts.scratchRoot ? { scratchRoot: opts.scratchRoot } : {}) }
    );
    if (!result.ok) return c.json({ error: result.reason }, 400);
    return c.json({ process: result.process });
  });

  app.get("/api/processes", (c) => {
    const launchId = c.req.query("launchId")?.trim();
    const jobId = c.req.query("jobId")?.trim();
    if (!launchId && !jobId) {
      const launch = workerLaunchOf(c);
      if (launch instanceof Response) return launch;
      return c.json({ processes: listLiveProcessesForLaunch(db, launch.id), unitPrefix: unitPrefix(launch.id) });
    }
    const actor = actorOf(c, "read worker processes");
    if (actor instanceof Response) return actor;
    if (jobId) {
      const job = getPersonaJob(db, jobId, { withView: false });
      if (!job || job.owner !== actor.owner) return c.json({ error: "Unknown job" }, 404);
      return c.json({ processes: listLiveProcessesForJob(db, job.id) });
    }
    const launch = getLaunch(db, launchId!);
    const owner = launch ? (personaJobForLaunch(db, launch.id)?.job.owner ?? launch.launchedBy) : undefined;
    if (!launch || owner !== actor.owner) return c.json({ error: "Unknown launch" }, 404);
    const processes: LaunchProcess[] = listLiveProcessesForLaunch(db, launch.id);
    return c.json({ processes });
  });

  // A closed job's cleanup: its registered processes stopped and its scratch dirs removed (Persona's close_job).
  app.post("/api/jobs/:id/hygiene", async (c) => {
    const actor = actorOf(c, "clean up after a job");
    if (actor instanceof Response) return actor;
    const job = getPersonaJob(db, c.req.param("id") ?? "", { withView: false });
    if (!job || job.owner !== actor.owner) return c.json({ error: "Unknown job" }, 404);
    if (job.status !== "done" && job.status !== "failed" && job.status !== "cancelled") {
      return c.json({ error: "The job is still open; its processes are stopped when it closes" }, 409);
    }
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
    const reason = body.reason === "job_closed" ? "job_closed" : "manual";
    const result = await onJobClosed(db, opts.sys, job.id, reason, {
      installDir: opts.installDir,
      ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
      ...(opts.scratchRoot ? { scratchRoot: opts.scratchRoot } : {}),
      ...(opts.paneAlive ? { paneAlive: opts.paneAlive } : {}),
      note: (j, text, sessionId) => noteJobActivity(db, j, text, sessionId, opts.broadcast),
    });
    return c.json({
      processes: result.processes.map((p) => ({ id: p.process.id, label: p.process.label, outcome: p.outcome })),
      scratchRemoved: result.scratchRemoved,
      tunnels: (result.tunnels ?? []).map((t) => ({ name: t.name, port: t.port, outcome: t.outcome })),
    });
  });
}
