import type { Database } from "bun:sqlite";
import { describeJobBudget } from "@standup/shared";
import type { JobBudgetLevel, PersonaJob, PersonaJobBudget, WsMessage } from "@standup/shared";
import {
  createSteer,
  getPersonaJob,
  getPersonaJobBudgetLevel,
  listOpenPersonaJobIds,
  personaJobBudget,
  setPersonaJobBudgetLevel,
  setPersonaJobWorkerSpend,
} from "@standup/store";
import { readCodexSessionUsage } from "../harness/codex-usage.js";
import { transcriptPathForSession } from "../transcript.js";
import { readSessionUsage } from "../usage.js";

/** How often the budget check reads the open jobs' workers' cost. */
export const JOB_BUDGET_CHECK_MS = 5 * 60 * 1000;

/** Subagent generations below a worker session whose transcripts count toward its job. */
const MAX_CHILD_DEPTH = 4;

const LEVEL_RANK: Record<JobBudgetLevel, number> = { ok: 0, near: 1, exceeded: 2 };

/** The steer a job's live workers get when the job reaches its budget. */
export function budgetStopSteer(job: Pick<PersonaJob, "title">, budget: PersonaJobBudget): string {
  return (
    `Standup: the job "${job.title}" has reached its time and spend budget (${describeJobBudget(budget)}). ` +
    "Finish the step you are on, call checkpoint with where you stand and what is left, then stop and wait. " +
    "Don't start new work until you are told the owner extended the budget."
  );
}

/**
 * The cost of a job's workers: every linked launch's session transcript (and
 * its subagents' own transcripts), or a Codex launch's event log. A launch
 * whose usage can't be read or priced counts as $0.
 */
export async function jobWorkerCost(db: Database, jobId: string): Promise<number> {
  const launches = db
    .query(
      `SELECT l.session_id AS session_id, l.harness AS harness, l.codex_event_log AS codex_event_log, l.codex_model AS codex_model
         FROM persona_job_launches pjl JOIN launches l ON l.id = pjl.launch_id
        WHERE pjl.job_id = ?`
    )
    .all(jobId) as Array<{ session_id: string | null; harness: string | null; codex_event_log: string | null; codex_model: string | null }>;
  let total = 0;
  const seen = new Set<string>();
  for (const launch of launches) {
    if (launch.harness === "codex" && launch.codex_event_log) {
      total += (await readCodexSessionUsage(launch.codex_event_log, launch.codex_model ?? undefined)).costUsd ?? 0;
      continue;
    }
    if (!launch.session_id || seen.has(launch.session_id)) continue;
    seen.add(launch.session_id);
    const rootPath = transcriptPathForSession(db, launch.session_id);
    total += (await readSessionUsage(rootPath, launch.session_id)).costUsd ?? 0;
    // A subagent's own transcript file (one other than its parent's) holds
    // usage the parent's does not; its records carry the parent's session id,
    // so it is read unfiltered.
    const paths = new Set(rootPath ? [rootPath] : []);
    let parents = [launch.session_id];
    for (let depth = 0; depth < MAX_CHILD_DEPTH && parents.length > 0; depth++) {
      const children = db
        .query(`SELECT id FROM sessions WHERE parent_session_id IN (${parents.map(() => "?").join(", ")})`)
        .all(...parents) as Array<{ id: string }>;
      parents = [];
      for (const { id } of children) {
        if (seen.has(id)) continue;
        seen.add(id);
        parents.push(id);
        const path = transcriptPathForSession(db, id);
        if (!path || paths.has(path)) continue;
        paths.add(path);
        total += (await readSessionUsage(path)).costUsd ?? 0;
      }
    }
  }
  return total;
}

export interface JobBudgetMonitorDeps {
  db: Database;
  owner: string;
  now: () => Date;
  /** Tells Persona, in the job's thread, that the job is near or over its budget. */
  notifyPersona: (job: PersonaJob, budget: PersonaJobBudget, level: Exclude<JobBudgetLevel, "ok">, steered: string[]) => void;
  /** Posts a system line the owner reads in the job's thread, tagged to the job. */
  postSystem: (job: PersonaJob, text: string) => void;
  broadcast: (message: WsMessage) => void;
  /** The workers' cost of a job (default jobWorkerCost). */
  workerCost?: (jobId: string) => Promise<number>;
  intervalMs?: number;
}

/**
 * Keeps the owner's open jobs within their budgets. Each check re-reads every
 * open job's workers' cost, then compares the job's spend and wall-clock time
 * with its budget. Crossing JOB_BUDGET_NEAR_FRACTION tells Persona once.
 * Reaching the budget tells Persona, asks each live worker (by a steer at its
 * next turn) to checkpoint and stop at a safe point, and tells the owner in
 * the job's thread; nothing running is killed, and policy holds new launches
 * for the job for the owner (launchVerdict). A budget raised back under a
 * threshold re-arms its notice.
 */
export class JobBudgetMonitor {
  private readonly deps: JobBudgetMonitorDeps;
  private readonly intervalMs: number;
  private lastCheckMs = -Infinity;
  private dirty = false;
  private running: Promise<void> | null = null;

  constructor(deps: JobBudgetMonitorDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? JOB_BUDGET_CHECK_MS;
  }

  /** Asks for a check on the next maybeCheck, whatever the interval (a turn just added spend). */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Runs a full check (re-reading the workers' cost) when the interval has
   * passed, else a light one (on the cached workers' cost) when one was asked
   * for; single-flight.
   */
  maybeCheck(): Promise<void> {
    const nowMs = this.deps.now().getTime();
    if (nowMs - this.lastCheckMs >= this.intervalMs) return this.check();
    if (this.dirty) return this.check({ readWorkers: false });
    return Promise.resolve();
  }

  check(opts: { readWorkers?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    const readWorkers = opts.readWorkers ?? true;
    this.dirty = false;
    if (readWorkers) this.lastCheckMs = this.deps.now().getTime();
    this.running = (async () => {
      try {
        for (const jobId of listOpenPersonaJobIds(this.deps.db, this.deps.owner)) {
          try {
            await this.checkJob(jobId, readWorkers);
          } catch (err) {
            console.error(`[persona] budget check of job ${jobId} failed:`, err);
          }
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async checkJob(jobId: string, readWorkers: boolean): Promise<void> {
    const { db } = this.deps;
    if (readWorkers) {
      const workerUsd = await (this.deps.workerCost ?? ((id) => jobWorkerCost(db, id)))(jobId);
      setPersonaJobWorkerSpend(db, jobId, workerUsd, this.deps.now().toISOString());
    }
    const at = this.deps.now();
    const job = getPersonaJob(db, jobId);
    const budget = personaJobBudget(db, jobId, at);
    if (!job || !budget || job.owner !== this.deps.owner) return;
    const previous = getPersonaJobBudgetLevel(db, jobId) ?? "ok";
    if (budget.level !== previous) setPersonaJobBudgetLevel(db, jobId, budget.level, at.toISOString());
    // Every check re-sends the job, so the console's budget bar follows the spend and the clock.
    const updated = getPersonaJob(db, jobId) ?? job;
    this.deps.broadcast({ type: "persona:job", payload: updated, timestamp: at.toISOString() });
    if (budget.level === previous) return;
    if (LEVEL_RANK[budget.level] < LEVEL_RANK[previous]) {
      if (previous === "exceeded") {
        this.deps.postSystem(updated, `Job "${job.title}" is back within its budget (${describeJobBudget(budget)}); launches for it no longer need your approval.`);
      }
      return;
    }
    // A job that went past 80% and its budget between two checks still gets the 80% notice first.
    if (previous === "ok") this.deps.notifyPersona(updated, budget, "near", []);
    if (budget.level === "near") return;
    const steered = this.steerWorkers(updated, budget);
    this.deps.notifyPersona(updated, budget, "exceeded", steered);
    const workers =
      steered.length === 0
        ? "It has no running workers."
        : `Asked its ${steered.length === 1 ? "running worker" : `${steered.length} running workers`} to checkpoint and stop at a safe point; nothing was killed.`;
    this.deps.postSystem(
      updated,
      `Job "${job.title}" reached its budget (${describeJobBudget(budget)}). ${workers} New launches for it wait for your approval.`
    );
  }

  /** Queues the stop steer for each of the job's live worker sessions; returns their ids. */
  private steerWorkers(job: PersonaJob, budget: PersonaJobBudget): string[] {
    const { db } = this.deps;
    const text = budgetStopSteer(job, budget);
    const steered: string[] = [];
    for (const sessionId of job.sessionIds) {
      const live = db
        .query("SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL AND status != 'done'")
        .get(sessionId);
      if (!live) continue;
      const steer = createSteer(db, sessionId, text);
      this.deps.broadcast({ type: "steer:queued", payload: steer, timestamp: new Date().toISOString() });
      steered.push(sessionId);
    }
    return steered;
  }
}
