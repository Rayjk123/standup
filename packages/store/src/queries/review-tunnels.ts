import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import type { ReviewTunnel, ReviewTunnelCloseReason, ReviewTunnelStatus } from "@standup/shared";

/**
 * Review-tunnel persistence (migration 070): one row per tunnel Standup
 * opened to a launch's branch build. A row is live while `opening` or `open`;
 * the partial unique indexes on its port, name and launch make a second live
 * row for any of them fail to insert, which is how ports are allocated
 * without collisions.
 */

interface TunnelRow {
  id: string;
  launch_id: string;
  run_id: string | null;
  job_id: string | null;
  owner: string;
  project_id: string | null;
  name: string;
  url: string;
  port: number;
  serve_pid: number | null;
  tunnel_pid: number | null;
  status: string;
  error: string | null;
  close_reason: string | null;
  opened_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const LIVE = "status IN ('opening', 'open')";

function toTunnel(r: TunnelRow): ReviewTunnel {
  return {
    id: r.id,
    launchId: r.launch_id,
    ...(r.run_id ? { runId: r.run_id } : {}),
    ...(r.job_id ? { jobId: r.job_id } : {}),
    owner: r.owner,
    ...(r.project_id ? { projectId: r.project_id } : {}),
    name: r.name,
    url: r.url,
    port: r.port,
    ...(r.serve_pid !== null ? { servePid: r.serve_pid } : {}),
    ...(r.tunnel_pid !== null ? { tunnelPid: r.tunnel_pid } : {}),
    status: r.status as ReviewTunnelStatus,
    ...(r.error ? { error: r.error } : {}),
    ...(r.close_reason ? { closeReason: r.close_reason as ReviewTunnelCloseReason } : {}),
    ...(r.opened_at ? { openedAt: r.opened_at } : {}),
    ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
    ...(r.closed_at ? { closedAt: r.closed_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Whether `err` is SQLite refusing a row that a unique index already holds. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export interface NewReviewTunnel {
  launchId: string;
  runId?: string;
  jobId?: string;
  owner: string;
  projectId?: string;
  name: string;
  url: string;
  port: number;
}

/**
 * Inserts a live (`opening`) row claiming `input.port` and `input.name` for
 * the launch. Returns `{conflict}` naming what a live row already holds
 * instead: the launch, the port or the name.
 */
export function claimReviewTunnel(
  db: Database,
  input: NewReviewTunnel
): { tunnel: ReviewTunnel } | { conflict: "launch" | "port" | "name" } {
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    db.run(
      `INSERT INTO review_tunnels (id, launch_id, run_id, job_id, owner, project_id, name, url, port, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?, ?)`,
      [id, input.launchId, input.runId ?? null, input.jobId ?? null, input.owner, input.projectId ?? null, input.name, input.url, input.port, now, now]
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const msg = (err as Error).message;
    if (/review_tunnels\.port/.test(msg)) return { conflict: "port" };
    if (/review_tunnels\.name/.test(msg)) return { conflict: "name" };
    return { conflict: "launch" };
  }
  return { tunnel: getReviewTunnel(db, id)! };
}

export function getReviewTunnel(db: Database, id: string): ReviewTunnel | null {
  const row = db.query("SELECT * FROM review_tunnels WHERE id = ?").get(id) as TunnelRow | null;
  return row ? toTunnel(row) : null;
}

/** Records the processes a live tunnel holds. */
export function setReviewTunnelPids(db: Database, id: string, pids: { servePid?: number; tunnelPid?: number }): void {
  const sets: string[] = [];
  const values: Array<number | string> = [];
  if (pids.servePid !== undefined) {
    sets.push("serve_pid = ?");
    values.push(pids.servePid);
  }
  if (pids.tunnelPid !== undefined) {
    sets.push("tunnel_pid = ?");
    values.push(pids.tunnelPid);
  }
  if (sets.length === 0) return;
  db.run(`UPDATE review_tunnels SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...values, new Date().toISOString(), id]);
}

/** Marks an `opening` tunnel open until `expiresAt`; false when it is no longer opening (closed meanwhile). */
export function markReviewTunnelOpen(db: Database, id: string, expiresAt: string): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    "UPDATE review_tunnels SET status = 'open', opened_at = ?, expires_at = ?, updated_at = ? WHERE id = ? AND status = 'opening'",
    [now, expiresAt, now, id]
  );
  return result.changes > 0;
}

/**
 * Ends a live tunnel's record: `closed` with `reason`, or `failed` with
 * `error` when it never opened. False when the row was already ended, so only
 * one caller tears a tunnel down.
 */
export function endReviewTunnel(
  db: Database,
  id: string,
  end: { status: "closed"; reason: ReviewTunnelCloseReason; error?: string } | { status: "failed"; error: string }
): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE review_tunnels SET status = ?, close_reason = ?, error = COALESCE(?, error), closed_at = ?, updated_at = ?
      WHERE id = ? AND ${LIVE}`,
    [end.status, end.status === "closed" ? end.reason : null, end.error ?? null, now, now, id]
  );
  return result.changes > 0;
}

/** Every live tunnel, oldest first. */
export function listLiveReviewTunnels(db: Database): ReviewTunnel[] {
  return (db.query(`SELECT * FROM review_tunnels WHERE ${LIVE} ORDER BY created_at`).all() as TunnelRow[]).map(toTunnel);
}

/**
 * Ended tunnels whose stop couldn't be checked when they closed (see
 * setReviewTunnelStopUnverified), closed at or after `since`, oldest first.
 */
export function listUnverifiedStopReviewTunnels(db: Database, since: string): ReviewTunnel[] {
  return (
    db
      .query(
        `SELECT * FROM review_tunnels
          WHERE status IN ('closed', 'failed') AND stop_unverified = 1 AND closed_at >= ?
          ORDER BY closed_at`
      )
      .all(since) as TunnelRow[]
  ).map(toTunnel);
}

/** Marks (or clears) an ended tunnel's stop as unverified: its processes couldn't be checked yet. */
export function setReviewTunnelStopUnverified(db: Database, id: string, unverified: boolean): void {
  db.run("UPDATE review_tunnels SET stop_unverified = ? WHERE id = ?", [unverified ? 1 : 0, id]);
}

/** The launch's live tunnel, or null. */
export function liveReviewTunnelForLaunch(db: Database, launchId: string): ReviewTunnel | null {
  const row = db.query(`SELECT * FROM review_tunnels WHERE launch_id = ? AND ${LIVE}`).get(launchId) as TunnelRow | null;
  return row ? toTunnel(row) : null;
}

/** The tunnels of `launchIds`, newest first; at most `limit` per launch. */
export function listReviewTunnelsByLaunches(db: Database, launchIds: string[], limit = 5): ReviewTunnel[] {
  if (launchIds.length === 0) return [];
  const rows = db
    .query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY launch_id ORDER BY created_at DESC, rowid DESC) AS n
           FROM review_tunnels WHERE launch_id IN (${launchIds.map(() => "?").join(", ")})
       ) WHERE n <= ? ORDER BY created_at DESC`
    )
    .all(...launchIds, limit) as TunnelRow[];
  return rows.map(toTunnel);
}

/** The live tunnels of every launch linked to Persona job `jobId`. */
export function liveReviewTunnelsForJob(db: Database, jobId: string): ReviewTunnel[] {
  const rows = db
    .query(
      `SELECT t.* FROM review_tunnels t
        WHERE t.status IN ('opening', 'open')
          AND (t.job_id = ? OR t.launch_id IN (SELECT launch_id FROM persona_job_launches WHERE job_id = ?))
        ORDER BY t.created_at`
    )
    .all(jobId, jobId) as TunnelRow[];
  return rows.map(toTunnel);
}

/** The ports live tunnels hold. */
export function liveReviewTunnelPorts(db: Database): Set<number> {
  const rows = db.query(`SELECT port FROM review_tunnels WHERE ${LIVE}`).all() as Array<{ port: number }>;
  return new Set(rows.map((r) => r.port));
}

/** The names live tunnels hold. */
export function liveReviewTunnelNames(db: Database): Set<string> {
  const rows = db.query(`SELECT name FROM review_tunnels WHERE ${LIVE}`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Every name a tunnel row created at or after `since` carried, with the ports
 * it was opened on — the tunnels Standup itself opened lately.
 */
export function knownReviewTunnelEndpoints(db: Database, since = ""): Map<string, Set<number>> {
  const rows = db.query("SELECT DISTINCT name, port FROM review_tunnels WHERE created_at >= ?").all(since) as Array<{
    name: string;
    port: number;
  }>;
  const out = new Map<string, Set<number>>();
  for (const r of rows) {
    const ports = out.get(r.name) ?? new Set<number>();
    ports.add(r.port);
    out.set(r.name, ports);
  }
  return out;
}
