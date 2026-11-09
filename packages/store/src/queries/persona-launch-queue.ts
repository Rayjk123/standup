import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

/** A Persona launch waiting for room under its daily budget or active cap. */
export interface PersonaQueuedLaunch {
  id: string;
  owner: string;
  /** The thread the launch was asked from; it starts as that thread's call. */
  threadId?: string;
  /** The launch_session arguments, as Persona's tool layer accepted them. */
  args: Record<string, unknown>;
  /** The launch's task, for deduplication and display. */
  task: string;
  /** Why it waits, e.g. "active launch cap reached (6/6)". */
  reason: string;
  /** The schedule run it is the launch of, when a schedule fired it. */
  scheduleRunId?: string;
  status: "queued" | "started" | "failed" | "cancelled";
  error?: string;
  launchId?: string;
  jobId?: string;
  createdAt: string;
  settledAt?: string;
}

interface Row {
  id: string;
  owner: string;
  thread_id: string | null;
  args_json: string;
  task: string;
  reason: string;
  schedule_run_id: string | null;
  status: PersonaQueuedLaunch["status"];
  error: string | null;
  launch_id: string | null;
  job_id: string | null;
  created_at: string;
  settled_at: string | null;
}

function toQueued(row: Row): PersonaQueuedLaunch {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.args_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    // A row whose arguments can't be read starts with none and fails on its own.
  }
  return {
    id: row.id,
    owner: row.owner,
    threadId: row.thread_id ?? undefined,
    args,
    task: row.task,
    reason: row.reason,
    scheduleRunId: row.schedule_run_id ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    launchId: row.launch_id ?? undefined,
    jobId: row.job_id ?? undefined,
    createdAt: row.created_at,
    settledAt: row.settled_at ?? undefined,
  };
}

/** Queues a launch; returns the row. */
export function enqueuePersonaLaunch(
  db: Database,
  input: { owner: string; threadId?: string; args: Record<string, unknown>; task: string; reason: string; scheduleRunId?: string },
  now: Date = new Date()
): PersonaQueuedLaunch {
  const id = randomUUID();
  db.run(
    `INSERT INTO persona_launch_queue (id, owner, thread_id, args_json, task, reason, schedule_run_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [id, input.owner, input.threadId ?? null, JSON.stringify(input.args), input.task, input.reason, input.scheduleRunId ?? null, now.toISOString()]
  );
  return getPersonaQueuedLaunch(db, id)!;
}

export function getPersonaQueuedLaunch(db: Database, id: string): PersonaQueuedLaunch | null {
  const row = db.query("SELECT * FROM persona_launch_queue WHERE id = ?").get(id) as Row | null;
  return row ? toQueued(row) : null;
}

/** The owner's queued launches, oldest first. */
export function listQueuedPersonaLaunches(db: Database, owner: string): PersonaQueuedLaunch[] {
  const rows = db
    .query("SELECT * FROM persona_launch_queue WHERE owner = ? AND status = 'queued' ORDER BY created_at, rowid")
    .all(owner) as Row[];
  return rows.map(toQueued);
}

/** A queued launch of the same task from the same thread, if one is waiting. */
export function findQueuedPersonaLaunch(db: Database, owner: string, threadId: string | undefined, task: string): PersonaQueuedLaunch | null {
  const row = db
    .query(
      `SELECT * FROM persona_launch_queue
        WHERE owner = ? AND status = 'queued' AND task = ? AND thread_id IS ?
        ORDER BY created_at, rowid LIMIT 1`
    )
    .get(owner, task, threadId ?? null) as Row | null;
  return row ? toQueued(row) : null;
}

/** The 0-based place of a queued launch in its owner's queue, or -1 when it isn't queued. */
export function personaLaunchQueuePosition(db: Database, id: string): number {
  const queued = getPersonaQueuedLaunch(db, id);
  if (!queued || queued.status !== "queued") return -1;
  return listQueuedPersonaLaunches(db, queued.owner).findIndex((q) => q.id === id);
}

/**
 * Settles a queued launch: started (with its launch and job), failed (with
 * why) or cancelled. Only a row still `queued` moves; returns the row, or
 * null when it was already settled.
 */
export function settlePersonaQueuedLaunch(
  db: Database,
  id: string,
  outcome:
    | { status: "started"; launchId: string; jobId?: string }
    | { status: "failed"; error: string }
    | { status: "cancelled"; error?: string },
  now: Date = new Date()
): PersonaQueuedLaunch | null {
  const result = db.run(
    `UPDATE persona_launch_queue
        SET status = ?, launch_id = ?, job_id = ?, error = ?, settled_at = ?
      WHERE id = ? AND status = 'queued'`,
    [
      outcome.status,
      outcome.status === "started" ? outcome.launchId : null,
      outcome.status === "started" ? outcome.jobId ?? null : null,
      outcome.status === "started" ? null : outcome.error ?? null,
      now.toISOString(),
      id,
    ]
  );
  return result.changes === 1 ? getPersonaQueuedLaunch(db, id) : null;
}
