import type { Database } from "bun:sqlite";
import type { TaskRun, TaskRunStatus, TaskRunAttemptStatus } from "@standup/shared";
import { getLaunchBySession, getActiveLaunchByWorktree } from "./launches.js";

/**
 * The dispatcher lifecycle state machine. A run may only move to a status
 * listed for its current one. queued/running are active; succeeded/failed/
 * cancelled/lost are terminal (no outbound edges). updateTaskRunStatus is the
 * single enforcement point.
 */
export const ALLOWED_TASK_RUN_TRANSITIONS: Record<TaskRunStatus, TaskRunStatus[]> = {
  queued: ["running", "failed", "cancelled", "lost"],
  running: ["succeeded", "failed", "cancelled", "lost"],
  succeeded: [],
  failed: [],
  cancelled: [],
  lost: [],
};

/** Statuses that count as "still in flight" for the guard and the sweep. */
const ACTIVE_STATUSES: TaskRunStatus[] = ["queued", "running"];

/** The active-status set as a SQL IN-list literal. */
const ACTIVE_IN = ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ");

/** Default grace after a pane goes away before the sweep calls a run `lost`. */
export const DEFAULT_TASK_RUN_GRACE_MS = 2 * 60 * 1000;

/** Thrown by updateTaskRunStatus when a transition is not in ALLOWED_TASK_RUN_TRANSITIONS. */
export class TaskRunTransitionError extends Error {
  constructor(
    public readonly from: TaskRunStatus,
    public readonly to: TaskRunStatus
  ) {
    super(`Illegal task-run transition: ${from} -> ${to}`);
    this.name = "TaskRunTransitionError";
  }
}

interface TaskRunRow {
  id: string;
  kind: string;
  project_id: string;
  session_id: string | null;
  worktree_path: string;
  status: TaskRunStatus;
  requester: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_event_at: string | null;
  summary: string | null;
  error: string | null;
  attempt_group: string | null;
  attempt_status: TaskRunAttemptStatus | null;
}

function toTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
    worktreePath: row.worktree_path,
    status: row.status,
    requester: row.requester ?? undefined,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    lastEventAt: row.last_event_at ? new Date(row.last_event_at) : undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    attemptGroup: row.attempt_group ?? undefined,
    attemptStatus: row.attempt_status ?? undefined,
  };
}

export function createTaskRun(
  db: Database,
  input: {
    id: string;
    projectId: string;
    worktreePath: string;
    kind?: string; // defaults to "worktree"
    sessionId?: string;
    requester?: string;
    /**
     * Groups this run with the other best-of-N attempts on the same ticket.
     * When set, the run also starts in attempt_status 'pending' (a picked
     * winner flips it to 'selected', the losers to 'superseded'). Omitted for an
     * ordinary single dispatch, which is never grouped.
     */
    attemptGroup?: string;
  }
): TaskRun {
  db.run(
    `INSERT INTO task_runs
       (id, kind, project_id, session_id, worktree_path, requester, attempt_group, attempt_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.kind ?? "worktree",
      input.projectId,
      input.sessionId ?? null,
      input.worktreePath,
      input.requester ?? null,
      input.attemptGroup ?? null,
      input.attemptGroup ? "pending" : null,
    ]
  );
  return getTaskRun(db, input.id)!;
}

export function getTaskRun(db: Database, id: string): TaskRun | null {
  const row = db.query("SELECT * FROM task_runs WHERE id = ?").get(id) as TaskRunRow | null;
  return row ? toTaskRun(row) : null;
}

export function getTaskRuns(db: Database): TaskRun[] {
  const rows = db.query("SELECT * FROM task_runs ORDER BY created_at DESC").all() as TaskRunRow[];
  return rows.map(toTaskRun);
}

export function getTaskRunsByProject(db: Database, projectId: string): TaskRun[] {
  const rows = db
    .query("SELECT * FROM task_runs WHERE project_id = ? ORDER BY created_at DESC")
    .all(projectId) as TaskRunRow[];
  return rows.map(toTaskRun);
}

/**
 * A project's runs that FINISHED (ended_at set) at/after `sinceIso` — a bare UTC
 * sqlite datetime (`YYYY-MM-DD HH:MM:SS`, e.g. from a 24h digest window). The
 * window is applied in SQL against the stored UTC `ended_at`, so the boundary is
 * computed in true UTC rather than against toTaskRun's `endedAt` Date — a bare
 * stamp parsed as LOCAL time, which skews a `getTime()` comparison by the UTC
 * offset (the same reason reconcileLostTaskRuns does its idle math in SQL).
 * Most-recently-finished first.
 */
export function getTaskRunsFinishedSince(
  db: Database,
  projectId: string,
  sinceIso: string
): TaskRun[] {
  const rows = db
    .query(
      `SELECT * FROM task_runs
        WHERE project_id = ? AND ended_at IS NOT NULL AND ended_at >= ?
        ORDER BY ended_at DESC`
    )
    .all(projectId, sinceIso) as TaskRunRow[];
  return rows.map(toTaskRun);
}

/**
 * The runs of one best-of-N attempt group, oldest first so "attempt 1..N" reads
 * left-to-right in the compare UI. Backs the diff-collection and the pick flow.
 */
export function getTaskRunsByAttemptGroup(db: Database, attemptGroup: string): TaskRun[] {
  const rows = db
    .query("SELECT * FROM task_runs WHERE attempt_group = ? ORDER BY created_at ASC")
    .all(attemptGroup) as TaskRunRow[];
  return rows.map(toTaskRun);
}

/**
 * Sets a run's best-of-N selection state (see TaskRunAttemptStatus) — orthogonal
 * to the run's lifecycle `status`, so a picked winner keeps whatever terminal
 * state it reported. The pick flow flips one run to 'selected' and the rest to
 * 'superseded'; the lifecycle cancel of an in-flight loser is a separate
 * updateTaskRunStatus call.
 */
export function setTaskRunAttemptStatus(
  db: Database,
  id: string,
  attemptStatus: TaskRunAttemptStatus
): TaskRun {
  db.run("UPDATE task_runs SET attempt_status = ? WHERE id = ?", [attemptStatus, id]);
  return getTaskRun(db, id)!;
}

/**
 * The active (queued/running) run for a session — how report_task/heartbeat
 * find the row to update. session_id is FK-free, so this is a plain lookup.
 */
export function getActiveTaskRunBySession(db: Database, sessionId: string): TaskRun | null {
  const row = db
    .query(
      `SELECT * FROM task_runs WHERE session_id = ? AND status IN (${ACTIVE_IN})
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId) as TaskRunRow | null;
  return row ? toTaskRun(row) : null;
}

/**
 * The active run occupying a worktree, if any — the per-worktree serialization
 * guard. A second launch into the same worktree while a run is still in flight
 * is refused (see launcher.ts). Worktree-kind launches always get a unique
 * slug-suffixed path so they never collide; the guard bites for in-place runs
 * that reuse the same real repo path.
 */
export function getActiveTaskRunByWorktree(db: Database, worktreePath: string): TaskRun | null {
  const row = db
    .query(
      `SELECT * FROM task_runs WHERE worktree_path = ? AND status IN (${ACTIVE_IN})
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(worktreePath) as TaskRunRow | null;
  return row ? toTaskRun(row) : null;
}

/** How many runs are in flight right now — enforces the global concurrency cap. */
export function countActiveTaskRuns(db: Database): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM task_runs WHERE status IN (${ACTIVE_IN})`)
    .get() as { n: number };
  return row.n;
}

/**
 * Links a run to the Claude Code session that reported in from its worktree —
 * the most recent still-unclaimed active run for that path. Write-once: a run
 * that already carries a session is left alone. Called alongside
 * attachSessionToLaunch when a launched session first appears.
 */
export function attachSessionToTaskRun(
  db: Database,
  worktreePath: string,
  sessionId: string
): void {
  const row = db
    .query(
      `SELECT id FROM task_runs
        WHERE worktree_path = ? AND session_id IS NULL AND status IN (${ACTIVE_IN})
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(worktreePath) as { id: string } | null;
  if (row) {
    db.run(
      "UPDATE task_runs SET session_id = ?, last_event_at = datetime('now') WHERE id = ?",
      [sessionId, row.id]
    );
  }
}

/**
 * Re-points run `runId` at `sessionId`, whatever session it carried: for a
 * launch whose own hooks proved the session is its worker's, over a session
 * that was linked from the worktree path alone.
 */
export function reattachSessionToTaskRun(db: Database, runId: string, sessionId: string): void {
  db.run("UPDATE task_runs SET session_id = ?, last_event_at = datetime('now') WHERE id = ?", [sessionId, runId]);
}

/**
 * Moves a run to `to`, enforcing ALLOWED_TASK_RUN_TRANSITIONS and stamping the
 * matching lifecycle timestamps: `started_at` on queued -> running, `ended_at`
 * on any terminal transition. `last_event_at` is bumped on every transition
 * (it doubles as the liveness clock). `summary`/`error` are recorded when
 * provided. Throws TaskRunTransitionError on an illegal edge — there are no
 * self-loops, so callers reacting to a repeatable signal (a re-sent
 * report_task) must guard on the current status first. Returns the updated run.
 */
export function updateTaskRunStatus(
  db: Database,
  id: string,
  to: TaskRunStatus,
  opts?: { summary?: string; error?: string }
): TaskRun {
  const current = getTaskRun(db, id);
  if (!current) throw new Error(`task run not found: ${id}`);
  if (!ALLOWED_TASK_RUN_TRANSITIONS[current.status].includes(to)) {
    throw new TaskRunTransitionError(current.status, to);
  }

  const sets = ["status = ?", "last_event_at = datetime('now')"];
  const params: (string | null)[] = [to];

  if (to === "running") sets.push("started_at = datetime('now')");
  if (to === "succeeded" || to === "failed" || to === "cancelled" || to === "lost") {
    sets.push("ended_at = datetime('now')");
  }
  if (opts?.summary !== undefined) {
    sets.push("summary = ?");
    params.push(opts.summary);
  }
  if (opts?.error !== undefined) {
    sets.push("error = ?");
    params.push(opts.error);
  }

  params.push(id);
  db.run(`UPDATE task_runs SET ${sets.join(", ")} WHERE id = ?`, params);
  return getTaskRun(db, id)!;
}

/** Records agent liveness by bumping `last_event_at` without changing status. */
export function heartbeatTaskRun(db: Database, id: string): TaskRun {
  db.run("UPDATE task_runs SET last_event_at = datetime('now') WHERE id = ?", [id]);
  return getTaskRun(db, id)!;
}

export interface ReconcileTaskRunsOptions {
  /** Silence tolerated after a pane vanishes before calling a run lost. */
  graceMs?: number;
  /**
   * tmux-pane liveness probe, injected. Defaults to "assume alive" so a caller
   * that forgets to wire a real probe never reaps anything — production passes
   * the collector's tmuxSessionExists.
   */
  sessionExists?: (tmuxSession: string) => boolean;
}

/**
 * Reconciliation sweep: marks a `running` run `lost` when the tmux pane hosting
 * it is gone and it has been silent past the grace window without a terminal
 * report. This is the ledger analog of the session reaper — a launched agent
 * whose pane is killed out-of-band sends no report, so its run would otherwise
 * sit `running` forever.
 *
 * Only `running` runs are swept: a `queued` run has no pane to probe yet (a
 * still-provisioning launch can legitimately run for many minutes), and
 * terminal runs are done. The pane is located via the launch sharing this
 * run's worktree/session; a run whose launch/pane can't be resolved is left
 * alone rather than guessed dead, as is one whose launch was reaped for
 * idleness (its pane is gone until it resumes). Idle time is computed in SQL (UTC julianday)
 * to avoid timezone skew between stored timestamps and the wall clock.
 */
export function reconcileLostTaskRuns(
  db: Database,
  opts: ReconcileTaskRunsOptions = {}
): TaskRun[] {
  const graceSeconds = (opts.graceMs ?? DEFAULT_TASK_RUN_GRACE_MS) / 1000;
  const sessionExists = opts.sessionExists ?? (() => true);

  const rows = db
    .query(
      `SELECT *,
              (julianday('now') - julianday(COALESCE(last_event_at, started_at, created_at))) * 86400.0
                AS idle_seconds
         FROM task_runs WHERE status = 'running'`
    )
    .all() as Array<TaskRunRow & { idle_seconds: number }>;

  const lost: TaskRun[] = [];
  for (const row of rows) {
    const launch =
      (row.session_id ? getLaunchBySession(db, row.session_id) : null) ??
      getActiveLaunchByWorktree(db, row.worktree_path);
    const pane = launch?.tmuxSession;
    if (!pane) continue; // can't probe — leave it
    // A worker paused for idleness has no pane on purpose; it resumes on its next message.
    if (launch?.reapedAt) continue;
    if (sessionExists(pane)) continue; // pane alive
    if (row.idle_seconds < graceSeconds) continue; // gone, but still within grace

    lost.push(
      updateTaskRunStatus(db, row.id, "lost", {
        error: "tmux pane gone — no terminal report before the grace window elapsed",
      })
    );
  }
  return lost;
}
