import { readdirSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Launch, PersonaJob, WsMessage } from "@standup/shared";
import { SCRATCH_ID, scratchRoot } from "@standup/shared/scratch";
import { appendPersonaMessage, createCheckpoint, getLaunch, getPersonaJob, getSession, personaJobForLaunch, personaJobForSession } from "@standup/store";
import { launchLiveForHygiene, resumeSettled, type PaneAlive } from "./launch-holds.js";
import { ORPHAN_SWEEP_MS, orphanSweepEnabled, sweepOrphans } from "./orphan-sweep.js";
import { describeTerminated, terminateRegistered, type ProcessSystem, type TerminatedProcess } from "./process-registry.js";
import { checkScratchFs, hasScratchMarker, removeScratchDir, sweepScratchDirs } from "./scratch-dirs.js";
import { describeWorkerTunnels, reapWorkerTunnels, type WorkerTunnelStop } from "./worker-tunnels.js";

/**
 * What closing a job (or cleaning up a launch) leaves behind gets cleared
 * here: the processes its workers registered are stopped and its launches'
 * scratch dirs removed, with a short note on the job's activity. Every step
 * is idempotent, so running it twice does nothing the second time.
 */

export { holdForResume } from "./launch-holds.js";

const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);

export interface HygieneOptions {
  installDir: string;
  graceMs?: number;
  scratchRoot?: string;
  /** Records a note on the job's activity; defaults to noteJobActivity without a broadcast. */
  note?: (job: PersonaJob, text: string, sessionId?: string) => void;
  /** Whether a running launch's pane still exists (launchLiveForHygiene); defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
}

export interface HygieneResult {
  processes: TerminatedProcess[];
  /** Launch ids whose scratch dir was removed. */
  scratchRemoved: string[];
  /** Hand-opened tunnels of the launches that were stopped (worker-tunnels.ts); unset when none was. */
  tunnels?: WorkerTunnelStop[];
}

/**
 * A note on a job's activity: a system line on its Persona thread and, when a
 * session is named, a structural checkpoint on it (which the job drawer shows).
 * `broadcast` pushes both to open consoles.
 */
export function noteJobActivity(db: Database, job: PersonaJob, text: string, sessionId?: string, broadcast?: (m: WsMessage) => void): void {
  const timestamp = new Date().toISOString();
  try {
    const { message, created } = appendPersonaMessage(db, { threadId: job.threadId, role: "system", text, jobIds: [job.id] });
    if (created) broadcast?.({ type: "persona:message", payload: message, timestamp, audience: job.owner });
  } catch (err) {
    console.error("[job-hygiene] could not post a job note:", err);
  }
  if (sessionId && getSession(db, sessionId)) {
    const checkpoint = createCheckpoint(db, sessionId, "structural", text);
    broadcast?.({ type: "checkpoint:new", payload: checkpoint, timestamp });
  }
}

/** The job's launches: those linked to it and any adopted or resumed launch of its sessions. */
export function jobLaunchIds(db: Database, job: PersonaJob): string[] {
  const ids = new Set(job.launchIds);
  const sessions = new Set(job.sessionIds);
  for (const id of job.launchIds) {
    const sessionId = getLaunch(db, id)?.sessionId;
    if (sessionId) sessions.add(sessionId);
  }
  if (sessions.size > 0) {
    const list = [...sessions];
    const rows = db.query(`SELECT id FROM launches WHERE session_id IN (${list.map(() => "?").join(", ")})`).all(...list) as Array<{ id: string }>;
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** Whether the launch's worker session is still live, so its scratch dir is in use. */
function sessionLive(db: Database, launch: Launch): boolean {
  const session = launch.sessionId ? getSession(db, launch.sessionId) : null;
  return session !== null && !session.endedAt;
}

/** Hygiene runs in progress, per launch id they may clear (hygieneSettled). */
const hygieneRuns = new Map<string, Set<Promise<unknown>>>();

/** Resolves once every hygiene run in progress that may clear the launch has settled; at once when none is. */
export async function hygieneSettled(launchId: string): Promise<void> {
  const runs = hygieneRuns.get(launchId);
  if (runs) await Promise.allSettled([...runs]);
}

function trackHygiene<T>(launchIds: string[], run: Promise<T>): Promise<T> {
  for (const id of launchIds) {
    let runs = hygieneRuns.get(id);
    if (!runs) hygieneRuns.set(id, (runs = new Set()));
    runs.add(run);
  }
  const untrack = () => {
    for (const id of launchIds) {
      const runs = hygieneRuns.get(id);
      runs?.delete(run);
      if (runs?.size === 0) hygieneRuns.delete(id);
    }
  };
  run.then(untrack, untrack);
  return run;
}

function describe(result: HygieneResult, what: string): string | null {
  const stopped = [describeTerminated(result.processes), describeWorkerTunnels(result.tunnels ?? [])].filter(Boolean).join(", ");
  const parts: string[] = [];
  if (stopped) parts.push(`stopped ${stopped}`);
  if (result.scratchRemoved.length > 0) parts.push(`removed ${result.scratchRemoved.length} scratch dir${result.scratchRemoved.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? `${what}: ${parts.join("; ")}.` : null;
}

/**
 * After a job closes: stops the processes its workers registered and removes
 * its launches' scratch dirs — for every launch that is no longer live
 * (launchLiveForHygiene), checked again just before each launch's processes are stopped
 * and again before its scratch dir is removed, so a worker the close kept
 * running, or one resumed while this runs, keeps its dev server and TMPDIR.
 * Does nothing for a job that is still open or unknown. While it runs,
 * hygieneSettled of any of the job's launches waits for it.
 *
 * One run per job at a time: a call while one is in progress (a stopped
 * worker's after-stop step racing close_job's hygiene request, say) shares a
 * single follow-up run that starts once it settles, so nothing is signalled
 * or noted twice, and a launch that stopped being live mid-run is still
 * cleared.
 */
export function onJobClosed(db: Database, sys: ProcessSystem, jobId: string, reason: string, opts: HygieneOptions): Promise<HygieneResult> {
  const job = getPersonaJob(db, jobId, { withView: false });
  if (!job || !CLOSED_JOB.has(job.status)) return Promise.resolve({ processes: [], scratchRemoved: [] });
  const inFlight = jobRuns.get(jobId);
  if (inFlight) {
    if (!inFlight.next) {
      const next = inFlight.current
        .then(noop, noop)
        .then(() => {
          if (jobRuns.get(jobId) === inFlight) jobRuns.delete(jobId);
          return onJobClosed(db, sys, jobId, reason, opts);
        });
      inFlight.next = trackHygiene(jobLaunchIds(db, job), next);
    }
    return inFlight.next;
  }
  const launchIds = jobLaunchIds(db, job);
  const run = trackHygiene(launchIds, clearClosedJob(db, sys, job, launchIds, reason, opts));
  const entry: JobRun = { current: run };
  jobRuns.set(jobId, entry);
  const settle = () => {
    if (jobRuns.get(jobId) === entry && !entry.next) jobRuns.delete(jobId);
  };
  run.then(settle, settle);
  return run;
}

/** A job's hygiene run in progress and the one follow-up run queued behind it. */
interface JobRun {
  current: Promise<HygieneResult>;
  next?: Promise<HygieneResult>;
}

/** onJobClosed runs in progress, per job id. */
const jobRuns = new Map<string, JobRun>();

function noop(): void {}

async function clearClosedJob(
  db: Database,
  sys: ProcessSystem,
  job: PersonaJob,
  launchIds: string[],
  reason: string,
  opts: HygieneOptions
): Promise<HygieneResult> {
  const live = (id: string) => launchLiveForHygiene(db, id, opts.paneAlive ? { paneAlive: opts.paneAlive } : {});
  const processes = await terminateRegistered(db, sys, { jobId: job.id }, reason, { ...opts, skipLaunch: live });
  for (const id of launchIds) {
    if (live(id)) continue;
    processes.push(...(await terminateRegistered(db, sys, { launchId: id }, reason, opts)));
  }
  const tunnels = await reapWorkerTunnels(db, sys, { ...opts, launchIds: launchIds.filter((id) => !live(id)) });
  const scratchRemoved: string[] = [];
  for (const id of launchIds) {
    if (live(id)) continue;
    if (opts.scratchRoot ? removeScratchDir(id, opts.scratchRoot) : removeScratchDir(id)) scratchRemoved.push(id);
  }
  const result: HygieneResult = { processes, scratchRemoved, ...(tunnels.length > 0 ? { tunnels } : {}) };
  const text = describe(result, `Job closed (${reason})`);
  if (text) (opts.note ?? ((j, t) => noteJobActivity(db, j, t)))(job, text);
  return result;
}

/**
 * After a launch is cleaned up: stops its registered processes and removes
 * its scratch dir, noting it on its job when it has one. A resume of the
 * launch still in progress settles first, so what it started is cleared too.
 */
export async function onLaunchCleaned(db: Database, sys: ProcessSystem, launchId: string, opts: HygieneOptions): Promise<HygieneResult> {
  await resumeSettled(launchId);
  const processes = await terminateRegistered(db, sys, { launchId }, "launch_cleaned", opts);
  const scratchRemoved = (opts.scratchRoot ? removeScratchDir(launchId, opts.scratchRoot) : removeScratchDir(launchId)) ? [launchId] : [];
  const result: HygieneResult = { processes, scratchRemoved };
  const text = describe(result, `Launch ${launchId} cleaned up`);
  if (text) {
    const launch = getLaunch(db, launchId);
    const job = personaJobForLaunch(db, launchId)?.job ?? (launch?.sessionId ? personaJobForSession(db, launch.sessionId)?.job : undefined);
    if (job) (opts.note ?? ((j, t, s) => noteJobActivity(db, j, t, s)))(job, text, launch?.sessionId);
    else console.log(`[job-hygiene] ${text}`);
  }
  return result;
}

function jobOfLaunch(db: Database, launchId: string): PersonaJob | undefined {
  const launch = getLaunch(db, launchId);
  return personaJobForLaunch(db, launchId)?.job ?? (launch?.sessionId ? personaJobForSession(db, launch.sessionId)?.job : undefined);
}

/**
 * The backstop for a job's hygiene that never ran or didn't finish (a failed
 * hygiene request, a restart mid-close): every closed job that still has live
 * registered processes or a scratch dir on disk, and none of whose launches
 * has a live session, gets onJobClosed again. Idempotent: a job left with
 * nothing to clear isn't picked up again. Does nothing when
 * STANDUP_ORPHAN_SWEEP turns the orphan sweep off (orphanSweepEnabled of
 * `env`). Returns the job ids it ran for.
 */
export async function hygieneBackstop(db: Database, sys: ProcessSystem, opts: HygieneOptions & { env?: NodeJS.ProcessEnv }): Promise<string[]> {
  if (!orphanSweepEnabled(opts.env)) return [];
  const candidates = new Map<string, PersonaJob>();
  const consider = (job: PersonaJob | undefined | null) => {
    if (job && CLOSED_JOB.has(job.status)) candidates.set(job.id, job);
  };
  const live = db.query("SELECT DISTINCT launch_id, job_id FROM launch_processes WHERE stopped_at IS NULL").all() as Array<{ launch_id: string; job_id: string | null }>;
  for (const r of live) {
    if (r.job_id) consider(getPersonaJob(db, r.job_id, { withView: false }));
    consider(jobOfLaunch(db, r.launch_id));
  }
  const root = opts.scratchRoot ?? scratchRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // No scratch root yet: nothing on disk to clear.
  }
  // Only a marked dir can be removed, so only one keeps its job a candidate.
  for (const name of names) if (SCRATCH_ID.test(name) && hasScratchMarker(join(root, name), name)) consider(jobOfLaunch(db, name));
  const ran: string[] = [];
  for (const job of candidates.values()) {
    const anyLive = jobLaunchIds(db, job).some((id) => {
      const launch = getLaunch(db, id);
      return launch !== null && sessionLive(db, launch);
    });
    if (anyLive) continue;
    await onJobClosed(db, sys, job.id, "job_closed", opts);
    ran.push(job.id);
  }
  return ran;
}

/** How long after the collector starts the first hygiene tick runs. */
export const STARTUP_HYGIENE_DELAY_MS = 30_000;

/** How often scratch dirs no launch claims are swept. */
export const SCRATCH_SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Starts the worker hygiene loops: warns once now when the scratch root is on
 * tmpfs, sweeps unclaimed scratch dirs older than SCRATCH_MAX_AGE_MS every
 * six hours, and STARTUP_HYGIENE_DELAY_MS after start and every
 * ORPHAN_SWEEP_MS runs the hygiene backstop
 * (hygieneBackstop), the orphan sweep and the reap of finished launches'
 * hand-opened tunnels (reapWorkerTunnels) — none when STANDUP_ORPHAN_SWEEP
 * turns the sweep off — noting each stop on its job.
 * Returns a stop function that clears the timers.
 */
export function startWorkerHygieneMaintenance(
  db: Database,
  sys: ProcessSystem,
  opts: { installDir: string; broadcast?: (m: WsMessage) => void; env?: NodeJS.ProcessEnv; paneAlive?: PaneAlive }
): () => void {
  checkScratchFs();
  const liveness = opts.paneAlive ? { paneAlive: opts.paneAlive } : {};
  const scratch = setInterval(() => {
    try {
      const removed = sweepScratchDirs(db, liveness);
      if (removed.length > 0) console.log(`[scratch] removed ${removed.length} unclaimed scratch dir(s)`);
    } catch (err) {
      console.error("[scratch] sweep failed:", err);
    }
  }, SCRATCH_SWEEP_MS);
  const sweepEnabled = orphanSweepEnabled(opts.env);
  let running = false;
  const tick = async () => {
    if (!sweepEnabled) return;
    try {
      await hygieneBackstop(db, sys, {
        installDir: opts.installDir,
        env: opts.env,
        ...liveness,
        note: (job, text, sessionId) => noteJobActivity(db, job, text, sessionId, opts.broadcast),
      });
    } catch (err) {
      console.error("[job-hygiene] backstop failed:", err);
    }
    await sweepOrphans(db, sys, {
      installDir: opts.installDir,
      ...liveness,
      note: (target, text) => {
        const job = target.jobId ? getPersonaJob(db, target.jobId, { withView: false }) : null;
        if (job) noteJobActivity(db, job, text, target.sessionId, opts.broadcast);
      },
    }).catch((err) => console.error("[orphan-sweep] failed:", err));
    try {
      const stops = await reapWorkerTunnels(db, sys, { installDir: opts.installDir, ...liveness });
      for (const s of stops) {
        if (s.outcome !== "terminated" && s.outcome !== "killed") continue;
        const text = `Stopped tunnel ${s.name} (pid ${s.pid}, port ${s.port}) of finished launch ${s.launchId}.`;
        console.log(`[worker-tunnels] ${text}`);
        const job = jobOfLaunch(db, s.launchId);
        if (job) noteJobActivity(db, job, text, getLaunch(db, s.launchId)?.sessionId, opts.broadcast);
      }
    } catch (err) {
      console.error("[worker-tunnels] reap failed:", err);
    }
  };
  const runTick = () => {
    if (running) return;
    running = true;
    void tick().finally(() => {
      running = false;
    });
  };
  // Once soon after start, so what finished while the collector was down is cleared without waiting a
  // full interval — deferred so the startup reconciles (paused panes adopted as resumed) run first.
  const startup = setTimeout(runTick, STARTUP_HYGIENE_DELAY_MS);
  const orphans = setInterval(runTick, ORPHAN_SWEEP_MS);
  return () => {
    clearTimeout(startup);
    clearInterval(scratch);
    clearInterval(orphans);
  };
}

/**
 * After a launch's worker is stopped — paused by the idle reaper, or stopped
 * outright: when the launch's job is already closed (it was closed with its
 * workers kept), runs the job's hygiene now that this launch is no longer
 * live. Null when the job is open or there is none.
 */
export function hygieneAfterReap(db: Database, sys: ProcessSystem, launch: Launch, opts: HygieneOptions): Promise<HygieneResult | null> {
  const job = jobOfLaunch(db, launch.id);
  if (!job || !CLOSED_JOB.has(job.status)) return Promise.resolve(null);
  return onJobClosed(db, sys, job.id, "job_closed", opts);
}

/**
 * hygieneAfterReap as a step to run once a launch's worker is stopped or
 * paused: in the background, so the stop doesn't wait out the processes'
 * grace period, with its note broadcast and any failure logged.
 */
export function closedJobHygieneStep(
  db: Database,
  sys: ProcessSystem,
  opts: { installDir: string; broadcast?: (m: WsMessage) => void; paneAlive?: PaneAlive }
): (launch: Launch) => void {
  return (launch) => {
    void hygieneAfterReap(db, sys, launch, {
      installDir: opts.installDir,
      ...(opts.paneAlive ? { paneAlive: opts.paneAlive } : {}),
      note: (job, text, sessionId) => noteJobActivity(db, job, text, sessionId, opts.broadcast),
    }).catch((err) => console.error(`[job-hygiene] hygiene after stopping launch ${launch.id} failed:`, err));
  };
}
