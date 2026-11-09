import type { Database } from "bun:sqlite";
import type { Session, SessionEndReason, SessionKind, SessionStatus, HarnessId } from "@standup/shared";
import { capTitle } from "@standup/shared";
import { getActor } from "./actors.js";
import { ALLOWED_TASK_RUN_TRANSITIONS, getActiveTaskRunByWorktree, updateTaskRunStatus } from "./task-runs.js";

interface SessionRow {
  id: string;
  project_id: string;
  title: string | null;
  cwd: string;
  parent_session_id: string | null;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  created_actor: string | null;
  owner_actor: string | null;
  kind: string | null;
  agent_type: string | null;
  agent_id: string | null;
  end_reason?: string | null;
  revived_outside_launch?: number | null;
  /**
   * Derived recency — COALESCE of the latest transcript/event time, else
   * started_at — present only on reads that compute it for ordering
   * (getAllSessions). Absent, and read as undefined, on a plain `SELECT *` row.
   */
  last_activity_at?: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title ?? "",
    cwd: row.cwd,
    parentSessionId: row.parent_session_id ?? undefined,
    status: row.status,
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : undefined,
    createdActor: row.created_actor ?? undefined,
    ownerActor: row.owner_actor ?? undefined,
    // NULL reads as unset — the Session type treats an unset kind as `root`, so
    // every pre-subsessions row and every ordinary session stays a root.
    kind: (row.kind as SessionKind | null) ?? undefined,
    agentType: row.agent_type ?? undefined,
    agentId: row.agent_id ?? undefined,
    endReason: (row.end_reason as SessionEndReason | null | undefined) ?? undefined,
    revivedOutsideLaunch: row.revived_outside_launch === 1 ? true : undefined,
  };
}

export function createSession(
  db: Database,
  session: Omit<Session, "startedAt" | "endedAt">
): void {
  db.run(
    `INSERT INTO sessions
       (id, project_id, title, cwd, parent_session_id, status, kind, agent_type, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.projectId,
      // Normalize "" to NULL — updateSessionTitle only fires on IS NULL, so
      // an empty string here would permanently block the title from ever
      // being set by the first UserPromptSubmit.
      session.title || null,
      session.cwd,
      session.parentSessionId ?? null,
      session.status,
      // Root rows leave these NULL (kind unset reads as `root`); a subagent
      // child carries all three so the row nests and labels itself.
      session.kind ?? null,
      session.agentType ?? null,
      session.agentId ?? null,
    ]
  );
}

export function updateSessionStatus(
  db: Database,
  sessionId: string,
  status: SessionStatus
): void {
  db.run("UPDATE sessions SET status = ? WHERE id = ?", [status, sessionId]);
}

/**
 * Moves a session out of `scratch` into a real project.
 *
 * Guarded to only ever move a session that is *currently* in `scratch`, the
 * same one-way invariant `rehomeScratchSessions` keeps: a session already
 * attributed to a project must never be silently re-homed elsewhere. The
 * `WHERE project_id = 'scratch'` clause makes that atomic, so a concurrent
 * reassignment can't race it. Returns whether a row actually moved, so a
 * caller only broadcasts (and spends the follow-up) when something changed.
 */
export function reassignSessionProject(
  db: Database,
  sessionId: string,
  projectId: string
): boolean {
  const { changes } = db.run(
    "UPDATE sessions SET project_id = ? WHERE id = ? AND project_id = 'scratch'",
    [projectId, sessionId]
  );
  return changes > 0;
}

export function updateSessionTitle(
  db: Database,
  sessionId: string,
  title: string
): void {
  // First-write-wins: only set the title when it is not already set. Capped
  // here so every stored title is bounded no matter which caller wrote it.
  db.run(
    "UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL",
    [capTitle(title), sessionId]
  );
}

/**
 * Overwrites a session's title with a summarized one — the async title
 * summarizer's write path, distinct from the first-write-wins updateSessionTitle.
 * Conditioned on the title still being `expected` (the capped raw title the
 * summary was based on) so a /clear or a later prompt that moved the title on in
 * the meantime is never clobbered. Capped like every other write. Returns true
 * when it actually wrote.
 */
export function upgradeSessionTitle(
  db: Database,
  sessionId: string,
  title: string,
  expected: string
): boolean {
  const result = db.run(
    "UPDATE sessions SET title = ? WHERE id = ? AND title = ?",
    [capTitle(title), sessionId, expected]
  );
  return result.changes > 0;
}

/**
 * `/clear` keeps Claude Code's session_id (and thus this row) alive, so
 * without this the title stays locked to whatever the first prompt was
 * hours or days ago — stale and unrelated to what the session is doing now.
 * Clearing it back to NULL lets the next UserPromptSubmit's first-write-wins
 * update in updateSessionTitle set a fresh one.
 */
export function resetSessionTitle(db: Database, sessionId: string): void {
  db.run("UPDATE sessions SET title = NULL WHERE id = ?", [sessionId]);
}

/**
 * Stamps who first brought a session into being. Write-once: the `IS NULL`
 * guard makes the first caller win and every later one a no-op, so a session's
 * origin can never be rewritten by a subsequent hook. Set once at first
 * appearance (see the collector's ensureSession).
 */
export function setSessionCreatedActor(
  db: Database,
  sessionId: string,
  actorId: string
): void {
  db.run(
    "UPDATE sessions SET created_actor = ? WHERE id = ? AND created_actor IS NULL",
    [actorId, sessionId]
  );
}

/**
 * (Re)assigns a session's owner. Touches only `owner_actor` — `created_actor`
 * and everything else are left exactly as they were, so ownership can move
 * without rewriting the session's origin.
 */
export function assignSessionOwner(
  db: Database,
  sessionId: string,
  actorId: string
): void {
  db.run("UPDATE sessions SET owner_actor = ? WHERE id = ?", [actorId, sessionId]);
}

export function endSession(db: Database, sessionId: string): void {
  db.run(
    "UPDATE sessions SET status = 'idle', ended_at = datetime('now'), end_reason = NULL, revived_outside_launch = NULL WHERE id = ?",
    [sessionId]
  );
}

/**
 * Ends a session's record because it went silent, marking the end `stale`:
 * no SessionEnd proved the process exited, so it may still be running. Its
 * next hook revives it (reviveSession), and Resume refuses it until then.
 */
export function endStaleSession(db: Database, sessionId: string): void {
  db.run(
    "UPDATE sessions SET status = 'idle', ended_at = datetime('now'), end_reason = 'stale', revived_outside_launch = NULL WHERE id = ?",
    [sessionId]
  );
}

/**
 * Clears ended_at so a session counts as active again.
 *
 * SessionEnd is not always terminal: Claude Code fires it on transitions the
 * session survives (resume, clear), and hooks keep arriving afterward from
 * the same session id. Without this, such a session keeps a stale ended_at
 * while its status goes back to 'running' — invisible to getActiveSessions
 * and therefore missing from the UI entirely, despite being alive.
 *
 * `outsideLaunch` records that the session's launch could not have sent the
 * hooks that revived it — it was resumed by hand (Session.revivedOutsideLaunch).
 */
export function reviveSession(db: Database, sessionId: string, { outsideLaunch = false }: { outsideLaunch?: boolean } = {}): void {
  db.run(
    "UPDATE sessions SET ended_at = NULL, end_reason = NULL, revived_outside_launch = ? WHERE id = ? AND ended_at IS NOT NULL",
    [outsideLaunch ? 1 : null, sessionId]
  );
}

/** Drops the revived-outside-launch mark: the session's own launch's token reported it. */
export function clearRevivedOutsideLaunch(db: Database, sessionId: string): void {
  db.run("UPDATE sessions SET revived_outside_launch = NULL WHERE id = ? AND revived_outside_launch IS NOT NULL", [sessionId]);
}

export interface DeletedSessionCounts {
  events: number;
  checkpoints: number;
  asks: number;
  steers: number;
  messages: number;
}

/**
 * Permanently removes a session and everything hanging off it.
 *
 * Child rows are deleted explicitly rather than by cascade — the schema
 * declares plain foreign keys without ON DELETE, so a bare delete of the
 * parent fails once any event exists. Events dominate the row count (a busy
 * session accumulates hundreds), which is what makes this worth having as a
 * cleanup action at all.
 *
 * session_messages hangs off `to_session_id` (a NOT NULL FK to sessions), not
 * the `session_id` column every other child shares, so it is purged on its own
 * line rather than inside the column-pattern loop — miss it and deleting any
 * session that ever received a coordination message fails the sessions FK.
 * Rows this session *sent* (from_session_id) are left alone: from_session_id is
 * FK-free, and the recipient can still read a message whose sender was cleaned
 * up.
 *
 * Subagent children are deleted too, deepest-first: parent_session_id is a plain
 * self-FK with no ON DELETE, so a parent with surviving children would fail the
 * constraint. Descendants are collected in post-order (a session's children
 * precede it) and each has its own child rows purged, so a whole subagent subtree
 * comes down with its root — and the returned counts sum across the subtree.
 *
 * Callers should refuse this for a live session: `ensureSession` recreates a
 * row on the very next hook, so deleting one mid-flight just discards its
 * history while leaving it running.
 */
export function deleteSession(
  db: Database,
  sessionId: string
): DeletedSessionCounts {
  // Post-order: every descendant precedes its ancestor, so deleting in this
  // order never leaves a parent whose children still reference it.
  const order: string[] = [];
  const visit = (id: string): void => {
    for (const child of getChildSessions(db, id)) visit(child.id);
    order.push(id);
  };
  visit(sessionId);

  const count = (table: string): number =>
    order.reduce(
      (sum, id) =>
        sum +
        (
          db
            .query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
            .get(id) as { n: number }
        ).n,
      0
    );

  const counts: DeletedSessionCounts = {
    events: count("events"),
    checkpoints: count("checkpoints"),
    asks: count("asks"),
    steers: count("steers"),
    messages: order.reduce(
      (sum, id) =>
        sum +
        (
          db
            .query("SELECT COUNT(*) AS n FROM session_messages WHERE to_session_id = ?")
            .get(id) as { n: number }
        ).n,
      0
    ),
  };

  db.transaction(() => {
    for (const id of order) {
      for (const table of [
        "events",
        "checkpoints",
        "asks",
        "steers",
        // Neither read nor written; its legacy rows still reference sessions.
        "expert_exchanges",
        "stall_detections",
        "transcript_events",
        "transcript_event_identities",
        "session_participants",
      ]) {
        db.run(`DELETE FROM ${table} WHERE session_id = ?`, [id]);
      }
      // Keyed on to_session_id, so outside the loop's session_id pattern — must be
      // purged explicitly or the sessions FK delete below fails.
      db.run("DELETE FROM session_messages WHERE to_session_id = ?", [id]);
      // Keep the launch row: it records what was started and where the
      // worktree lives, which outlives the session it spawned. A launch still
      // starting or running is failed with it: once its session_id is cleared
      // it would read as a launch whose worker hasn't reported in yet. Its
      // open task run is marked lost too: the lost-run sweep finds panes
      // only through starting/running launches, so it never would.
      const failing = db
        .query("SELECT worktree_path, kind FROM launches WHERE session_id = ? AND status IN ('starting', 'running')")
        .all(id) as Array<{ worktree_path: string; kind: string | null }>;
      for (const launch of failing) {
        if (launch.kind === "adopted") continue;
        const run = getActiveTaskRunByWorktree(db, launch.worktree_path);
        if (run && ALLOWED_TASK_RUN_TRANSITIONS[run.status].includes("lost")) {
          updateTaskRunStatus(db, run.id, "lost", { error: "worker session deleted before a terminal report" });
        }
      }
      db.run(
        `UPDATE launches SET status = 'failed', error = COALESCE(error, 'Session deleted'), phase = NULL
          WHERE session_id = ? AND status IN ('starting', 'running')`,
        [id]
      );
      db.run("UPDATE launches SET session_id = NULL WHERE session_id = ?", [id]);
      db.run("DELETE FROM sessions WHERE id = ?", [id]);
    }
  })();

  return counts;
}

export function getSession(db: Database, sessionId: string): Session | null {
  const row = db
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as SessionRow | null;
  return row ? rowToSession(row) : null;
}

/** Records that launch `launchId`'s hook token reported for a session. */
export function setSessionHookLaunch(db: Database, sessionId: string, launchId: string): void {
  db.run("UPDATE sessions SET hook_launch_id = ? WHERE id = ? AND hook_launch_id IS NOT ?", [launchId, sessionId, launchId]);
}

/** The launch whose hook token last reported for a session, or null. */
export function getSessionHookLaunch(db: Database, sessionId: string): string | null {
  const row = db.query("SELECT hook_launch_id FROM sessions WHERE id = ?").get(sessionId) as { hook_launch_id: string | null } | null;
  return row?.hook_launch_id ?? null;
}

/**
 * The hook events a session recorded after its last SessionEnd (all of them
 * if it never ended), and the age in seconds of the newest one (null when
 * there are none).
 */
export function eventsSinceLastSessionEnd(db: Database, sessionId: string): { count: number; newestAgeS: number | null } {
  const row = db
    .query(
      `SELECT COUNT(*) AS count, (julianday('now') - julianday(MAX(created_at))) * 86400 AS age
         FROM events
        WHERE session_id = ?1
          AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE session_id = ?1 AND type = 'SessionEnd'), -1)`
    )
    .get(sessionId) as { count: number; age: number | null };
  return { count: row.count, newestAgeS: row.age };
}

/** Seconds since a session's row was created (computed in SQL, so no timezone parsing), or null. */
export function sessionAgeSeconds(db: Database, sessionId: string): number | null {
  const row = db
    .query("SELECT (julianday('now') - julianday(started_at)) * 86400 AS age FROM sessions WHERE id = ?")
    .get(sessionId) as { age: number | null } | null;
  return row?.age ?? null;
}

/**
 * Top-level (root) sessions for a project. Subagent children are excluded
 * (parent_session_id IS NULL) so they never render as their own project row —
 * they nest under their parent instead. getChildSessions is the read path for a
 * given parent's children.
 */
export function getSessionsByProject(
  db: Database,
  projectId: string
): Session[] {
  const rows = db
    .query(
      "SELECT * FROM sessions WHERE project_id = ? AND parent_session_id IS NULL ORDER BY started_at DESC"
    )
    .all(projectId) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * A parent session's direct subagent children (its subsessions), newest first.
 * The complement of the roots-only filter the flat lists apply — this is how a
 * parent's nested rows are read, and how deleteSession walks a subtree.
 */
export function getChildSessions(db: Database, parentId: string): Session[] {
  const rows = db
    .query(
      "SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC"
    )
    .all(parentId) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Every subagent child across all parents (parent_session_id IS NOT NULL),
 * newest first. The flat root lists exclude children so they don't appear as
 * top-level rows or poison fleet counts, but the console still needs them in the
 * same payload to nest each under its parent — this is the read that supplies them.
 */
export function getSubagentSessions(db: Database): Session[] {
  const rows = db
    .query(
      "SELECT * FROM sessions WHERE parent_session_id IS NOT NULL ORDER BY started_at DESC"
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Correlates an MCP tool call back to the session that spawned it. The MCP
 * server subprocess has no reliable session id from Claude Code — it only
 * inherits the process cwd, which is why this is a cwd lookup rather than a
 * direct id lookup. Most-recent-active is a heuristic: two sessions sharing
 * a cwd (two windows on the same repo) will collide onto the newer one.
 */
export function getMostRecentActiveSessionByCwd(
  db: Database,
  cwd: string
): Session | null {
  // Subagent children share their parent's cwd, so without excluding them a
  // just-finished subsession could win this most-recent lookup and misattribute
  // an MCP tool call to the child instead of the real working session.
  const row = db
    .query(
      "SELECT * FROM sessions WHERE cwd = ? AND ended_at IS NULL AND parent_session_id IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get(cwd) as SessionRow | null;
  return row ? rowToSession(row) : null;
}

/**
 * Every session including ended ones. The console needs these to offer
 * cleanup — an ended session is invisible to getActiveSessions, so its rows
 * would accumulate with no way to see or remove them.
 */
export function getAllSessions(db: Database): Session[] {
  // Roots only — subagent children nest under their parent (getChildSessions /
  // getSubagentSessions), so they are kept out of the flat top-level list and out
  // of the fleet/telemetry reads that walk it.
  //
  // last_activity_at is the most-recent transcript/event time (else started_at) —
  // the same recency getActiveWork derives. Ordering roots by it means a new
  // message (which appends a transcript_events row) bumps its session to the
  // front of the Work list, and the grouped view inherits the same order.
  const rows = db
    .query(
      `SELECT sessions.*, COALESCE(
         (SELECT MAX(te.created_at) FROM transcript_events te WHERE te.session_id = sessions.id),
         (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = sessions.id),
         started_at
       ) AS last_activity_at
       FROM sessions
       WHERE parent_session_id IS NULL
       ORDER BY last_activity_at DESC`
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function getActiveSessions(db: Database): Session[] {
  const rows = db
    .query(
      "SELECT * FROM sessions WHERE ended_at IS NULL AND parent_session_id IS NULL ORDER BY started_at DESC"
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * One row of the ephemeral cross-agent activity view — what a ROOT session is
 * working on right now, derived purely from session + event recency (never the
 * durable knowledge path). `actor` is the canonical owner (owner_actor, else
 * created_actor) resolved through the actor-merge tombstones; nullable for a
 * session that never recorded one. `lastActivityAt` is the recency the window
 * and ordering are computed from.
 */
export interface ActiveWorkItem {
  sessionId: string;
  title: string;
  /**
   * The session's status, or `paused` for an idle-paused worker: its pane was
   * reaped (the session reads ended) but its launch is still running, so a
   * message resumes it.
   */
  status: ActiveWorkStatus;
  actor?: string;
  kind?: SessionKind;
  /** The agent CLI that drove the session, from its launch; unset for a default Claude launch that recorded none. */
  harness?: HarnessId;
  /** The Persona job the session's launch serves, when one does. */
  job?: { id: string; title: string };
  lastActivityAt: string;
}

export type ActiveWorkStatus = SessionStatus | "paused";

export interface GetActiveWorkOptions {
  /** Recency window in hours — a session outside it is dropped unless still active. */
  sinceHours?: number;
  /** Drop sessions whose canonical actor equals this (launch/caller self-exclusion). */
  excludeActor?: string;
  /** Drop this one session (the caller's own) without hiding its owner's other sessions. */
  excludeSessionId?: string;
  /**
   * Who reads the rows: a row carries its Persona job only when this actor owns
   * the job. Job titles are the job owner's (often from a private thread), so
   * without a viewer no row carries one.
   */
  jobViewer?: string;
  /** Cap on returned rows (most-recent first). */
  limit?: number;
}

interface ActiveWorkRow {
  id: string;
  title: string | null;
  status: SessionStatus;
  kind: string | null;
  harness: string | null;
  owner_actor: string | null;
  created_actor: string | null;
  paused: number;
  job_id: string | null;
  job_title: string | null;
  job_owner: string | null;
  last_activity_at: string;
}

/**
 * The ephemeral, pull-first activity view for a project: the ROOT sessions
 * (parent_session_id IS NULL) whose recency falls within `sinceHours` OR that
 * are still active — ended_at IS NULL AND a non-terminal status, or an
 * idle-paused worker — most-recent first and bounded.
 *
 * An idle-paused worker is a non-`done` session that reads ended because the
 * reaper stopped its idle pane, while its launch is still `running` with
 * `reaped_at` set, so a message resumes it. It reads `paused` and stays listed
 * past the window — unless its Persona job is closed, since nothing resumes a
 * closed job's worker. The session's launch is chosen as getLaunchBySession
 * chooses it (live statuses first, then newest), and its job through any of
 * the session's launches, as personaJobForSession resolves it.
 *
 * A terminal (`done`) root whose ended_at was never stamped
 * (the Stop hook clears ended_at and classifyTurnEnd sets `done` without
 * restamping it) is NOT active forever: it only shows while its recency is
 * inside the window. Recently ENDED sessions inside the window are likewise
 * kept so a "just finished" run still shows (its terminal status labels it done).
 *
 * Recency is MAX(transcript_events.created_at), falling back to the raw events
 * log's MAX(created_at), then the session's started_at — so a session with a
 * live transcript sorts by its latest turn, and one that predates the transcript
 * substrate still orders by whatever activity it has.
 *
 * This is a recency FILTER over existing rows, not a new store: it reads only
 * sessions + transcript_events + events, and writes nothing. `excludeActor` (and
 * each row's actor) is resolved through the actor-merge tombstones so a since-
 * merged alias compares equal to its canonical identity.
 */
export function getActiveWork(
  db: Database,
  projectId: string,
  options: GetActiveWorkOptions = {}
): ActiveWorkItem[] {
  const sinceHours = options.sinceHours ?? 24;
  const limit = options.limit ?? 20;

  const rows = db
    .query(
      `SELECT * FROM (
           SELECT
             w.id AS id,
             w.title AS title,
             w.status AS status,
             w.kind AS kind,
             w.harness AS harness,
             w.owner_actor AS owner_actor,
             w.created_actor AS created_actor,
             w.ended_at AS ended_at,
             (w.ended_at IS NOT NULL AND w.status NOT IN ('done')
               AND l.status = 'running' AND l.reaped_at IS NOT NULL
               AND (pj.status IS NULL OR pj.status NOT IN ('done', 'failed', 'cancelled'))) AS paused,
             pj.id AS job_id,
             pj.title AS job_title,
             pj.owner AS job_owner,
             w.last_activity_at AS last_activity_at
           FROM (
             SELECT
               s.id AS id,
               s.title AS title,
               s.status AS status,
               s.kind AS kind,
               (
                 SELECT l.harness FROM launches l
                  WHERE l.session_id = s.id AND l.harness IS NOT NULL
                  ORDER BY l.created_at DESC LIMIT 1
               ) AS harness,
               (
                 SELECT l.id FROM launches l
                  WHERE l.session_id = s.id
                  ORDER BY (l.status IN ('running', 'starting')) DESC, l.created_at DESC, l.rowid DESC
                  LIMIT 1
               ) AS launch_id,
               (
                 SELECT pjl.job_id FROM launches l JOIN persona_job_launches pjl ON pjl.launch_id = l.id
                  WHERE l.session_id = s.id
                  ORDER BY pjl.created_at DESC, pjl.rowid DESC
                  LIMIT 1
               ) AS job_id,
               s.owner_actor AS owner_actor,
               s.created_actor AS created_actor,
               s.ended_at AS ended_at,
               COALESCE(
                 (SELECT MAX(te.created_at) FROM transcript_events te WHERE te.session_id = s.id),
                 (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id),
                 s.started_at
               ) AS last_activity_at
             FROM sessions s
             WHERE s.project_id = ? AND s.parent_session_id IS NULL
           ) w
           LEFT JOIN launches l ON l.id = w.launch_id
           LEFT JOIN persona_jobs pj ON pj.id = w.job_id
         )
        WHERE (ended_at IS NULL AND status NOT IN ('done'))
              OR paused
              OR last_activity_at >= datetime('now', ?)
        ORDER BY last_activity_at DESC`
    )
    .all(projectId, `-${sinceHours} hours`) as ActiveWorkRow[];

  const canonical = (raw: string | null | undefined): string | undefined => {
    const trimmed = raw?.trim();
    if (!trimmed) return undefined;
    return getActor(db, trimmed)?.id ?? trimmed;
  };
  const excluded = canonical(options.excludeActor);
  const viewer = canonical(options.jobViewer);

  const items: ActiveWorkItem[] = [];
  for (const row of rows) {
    const actor = canonical(row.owner_actor ?? row.created_actor);
    if (excluded && actor === excluded) continue;
    if (options.excludeSessionId && row.id === options.excludeSessionId) continue;
    const jobVisible = !!viewer && !!row.job_id && !!row.job_title && canonical(row.job_owner) === viewer;
    items.push({
      sessionId: row.id,
      title: row.title ?? "",
      status: row.paused ? "paused" : row.status,
      actor,
      kind: (row.kind as SessionKind | null) ?? undefined,
      harness: (row.harness as HarnessId | null) ?? undefined,
      ...(jobVisible ? { job: { id: row.job_id!, title: row.job_title! } } : {}),
      lastActivityAt: row.last_activity_at,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * Marks a subagent child session finished: a terminal `done` status plus an
 * ended_at stamp. Distinct from endSession (which parks a root session `idle` as
 * a non-terminal SessionEnd survivor that a later hook can revive) — a subagent
 * that emitted SubagentStop is genuinely complete, so it reads `done`, the same
 * terminal state the Stop turn-end classifier gives a finished root session.
 */
export function endSubagentSession(db: Database, sessionId: string): void {
  db.run(
    "UPDATE sessions SET status = 'done', ended_at = datetime('now'), end_reason = NULL, revived_outside_launch = NULL WHERE id = ?",
    [sessionId]
  );
}
