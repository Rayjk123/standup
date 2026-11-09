import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { LaunchProcess, LaunchProcessKind } from "@standup/shared";

/**
 * The registry of long-lived processes workers started (migration 081): one
 * row per registered pid or systemd unit. A row is live until `stopped_at` is
 * set, when the process is stopped or found already gone.
 */

interface LaunchProcessRow {
  id: string;
  launch_id: string;
  job_id: string | null;
  kind: string;
  pid: number | null;
  pgid: number | null;
  unit: string | null;
  label: string;
  port: number | null;
  args_fingerprint: string | null;
  registered_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
}

function toLaunchProcess(r: LaunchProcessRow): LaunchProcess {
  return {
    id: r.id,
    launchId: r.launch_id,
    ...(r.job_id ? { jobId: r.job_id } : {}),
    kind: r.kind as LaunchProcessKind,
    ...(r.pid !== null ? { pid: r.pid } : {}),
    ...(r.pgid !== null ? { pgid: r.pgid } : {}),
    ...(r.unit ? { unit: r.unit } : {}),
    label: r.label,
    ...(r.port !== null ? { port: r.port } : {}),
    ...(r.args_fingerprint ? { argsFingerprint: r.args_fingerprint } : {}),
    registeredAt: r.registered_at,
    ...(r.stopped_at ? { stoppedAt: r.stopped_at } : {}),
    ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
  };
}

export interface NewLaunchProcess {
  launchId: string;
  jobId?: string;
  kind: LaunchProcessKind;
  pid?: number;
  pgid?: number;
  unit?: string;
  label: string;
  port?: number;
  argsFingerprint?: string;
}

/** Registers a process a worker started; returns the stored row. */
export function createLaunchProcess(db: Database, p: NewLaunchProcess): LaunchProcess {
  const id = randomUUID();
  db.run(
    `INSERT INTO launch_processes (id, launch_id, job_id, kind, pid, pgid, unit, label, port, args_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      p.launchId,
      p.jobId ?? null,
      p.kind,
      p.pid ?? null,
      p.pgid ?? null,
      p.unit ?? null,
      p.label,
      p.port ?? null,
      p.argsFingerprint ?? null,
    ]
  );
  return toLaunchProcess(db.query("SELECT * FROM launch_processes WHERE id = ?").get(id) as LaunchProcessRow);
}

/** The launch's registered processes not yet stopped, oldest first. */
export function listLiveProcessesForLaunch(db: Database, launchId: string): LaunchProcess[] {
  const rows = db
    .query("SELECT * FROM launch_processes WHERE launch_id = ? AND stopped_at IS NULL ORDER BY registered_at, rowid")
    .all(launchId) as LaunchProcessRow[];
  return rows.map(toLaunchProcess);
}

/** Every registered process not yet stopped, across all launches, oldest first. */
export function listLiveProcesses(db: Database): LaunchProcess[] {
  const rows = db.query("SELECT * FROM launch_processes WHERE stopped_at IS NULL ORDER BY registered_at, rowid").all() as LaunchProcessRow[];
  return rows.map(toLaunchProcess);
}

/** The job's registered processes not yet stopped, across all its launches, oldest first. */
export function listLiveProcessesForJob(db: Database, jobId: string): LaunchProcess[] {
  const rows = db
    .query("SELECT * FROM launch_processes WHERE job_id = ? AND stopped_at IS NULL ORDER BY registered_at, rowid")
    .all(jobId) as LaunchProcessRow[];
  return rows.map(toLaunchProcess);
}

/**
 * Marks a registered process stopped, with why. A row already stopped keeps
 * its first stop time and reason; returns whether this call stopped it.
 */
export function markProcessStopped(db: Database, id: string, reason: string): boolean {
  const res = db.run(
    "UPDATE launch_processes SET stopped_at = datetime('now'), stop_reason = ? WHERE id = ? AND stopped_at IS NULL",
    [reason, id]
  );
  return res.changes > 0;
}
