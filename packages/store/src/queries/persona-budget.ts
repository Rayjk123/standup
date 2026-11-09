import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { jobBudgetLevel, resolveJobBudget } from "@standup/shared";
import type { JobBudgetLayer, JobBudgetLevel, PersonaJobBudget, ResolvedJobBudget } from "@standup/shared";

/**
 * Persona's cost ledger (persona_turns, persona_turn_jobs), each owner's
 * default job budgets (persona_budget_prefs) and the budget columns on
 * persona_jobs. See migration 073.
 */

// ── Turn ledger ──────────────────────────────────────────────────────────────

export interface RecordPersonaTurnInput {
  user: string;
  threadId?: string | null;
  /** The jobs the turn is attributed to; its cost is split evenly across them. */
  jobIds?: readonly string[];
  /** `delegate`: a delegate agent's turn, run in its own cwd on a fresh session. */
  kind?: "turn" | "handoff" | "delegate";
  ok: boolean;
  startedAt: string;
  durationMs: number;
  /** The turn's own cost. Ignored when `reportedCostUsd` is given, from which it is worked out. */
  costUsd?: number | null;
  /** The result's total_cost_usd as the CLI reported it. */
  reportedCostUsd?: number | null;
  /** The Claude session the turn ran on. */
  claudeSessionId?: string | null;
  /** The turn resumed a session rather than starting one. */
  resumed?: boolean;
  /**
   * The session it resumed, when that isn't `claudeSessionId`: a resume the
   * CLI reported under another id carries the resumed session's history, and
   * so its running total, which is the baseline the turn's cost is read from.
   */
  resumedSessionId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
  epoch?: number | null;
}

/** Where a resumed turn's session stands in the ledger, for personaTurnOwnCost. */
export interface PersonaTurnSessionHistory {
  /** The user's ledger has a turn with a session: false only before the ledger's first. */
  anyTurn: boolean;
  /** The user's latest turn with a session ran on this one (so the CLI ran it last in the shared cwd). */
  ranLast: boolean;
  /** The session's latest reported total_cost_usd, or null when none was reported. */
  previous: number | null;
}

/**
 * A turn's own cost from what its result reported. A user's turns share one
 * cwd, and resuming the session the CLI ran last there restores that
 * session's cost, so the turn's total_cost_usd is then the session's running
 * total and the turn cost the difference from its previous report (a lower
 * report means the CLI started from zero after all). Resuming any other
 * session starts from zero, so the report is the turn's own. With no earlier
 * report to subtract — the ledger's first turn, or a session none of whose
 * turns reported a cost — the restored total can't be split off, so the turn's
 * cost is unknown (null) and only serves as the next turn's baseline.
 */
export function personaTurnOwnCost(reported: number | null, resumed: boolean, history: PersonaTurnSessionHistory): number | null {
  if (reported === null) return null;
  if (!resumed) return reported;
  if (!history.anyTurn) return null;
  if (!history.ranLast) return reported;
  if (history.previous === null) return null;
  return reported < history.previous ? reported : reported - history.previous;
}

/**
 * `claudeSessionId`'s place in `user`'s ledger (see PersonaTurnSessionHistory).
 * A delegate turn runs in a cwd of its own, so it never is the session the
 * CLI ran last where Persona's own turns run.
 */
export function personaTurnSessionHistory(db: Database, user: string, claudeSessionId: string): PersonaTurnSessionHistory {
  const last = db
    .query(
      `SELECT claude_session_id AS session FROM persona_turns
        WHERE user = ? AND claude_session_id IS NOT NULL AND kind != 'delegate'
        ORDER BY started_at DESC, rowid DESC LIMIT 1`
    )
    .get(user) as { session: string } | null;
  const previous = db
    .query(
      `SELECT reported_cost_usd AS cost FROM persona_turns
        WHERE user = ? AND claude_session_id = ? AND reported_cost_usd IS NOT NULL
        ORDER BY started_at DESC, rowid DESC LIMIT 1`
    )
    .get(user, claudeSessionId) as { cost: number } | null;
  return { anyTurn: !!last, ranLast: last?.session === claudeSessionId, previous: previous?.cost ?? null };
}

export interface PersonaTurnRecord {
  id: string;
  user: string;
  threadId: string | null;
  jobIds: string[];
  kind: string;
  ok: boolean;
  startedAt: string;
  durationMs: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  model: string | null;
  epoch: number | null;
  claudeSessionId: string | null;
  reportedCostUsd: number | null;
}

interface TurnRow {
  id: string;
  user: string;
  thread_id: string | null;
  job_ids_json: string;
  kind: string;
  ok: number;
  started_at: string;
  duration_ms: number;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  epoch: number | null;
  claude_session_id: string | null;
  reported_cost_usd: number | null;
}

function toTurn(row: TurnRow): PersonaTurnRecord {
  let jobIds: string[] = [];
  try {
    const parsed = JSON.parse(row.job_ids_json) as unknown;
    if (Array.isArray(parsed)) jobIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // A corrupt list reads as no jobs.
  }
  return {
    id: row.id,
    user: row.user,
    threadId: row.thread_id,
    jobIds,
    kind: row.kind,
    ok: row.ok === 1,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    model: row.model,
    epoch: row.epoch,
    claudeSessionId: row.claude_session_id,
    reportedCostUsd: row.reported_cost_usd,
  };
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Records one Persona turn and each attributed job's even share of its cost. */
export function recordPersonaTurn(db: Database, input: RecordPersonaTurnInput): PersonaTurnRecord {
  const id = randomUUID();
  const jobIds = [...new Set((input.jobIds ?? []).filter((j) => typeof j === "string" && j))];
  const reported = finiteOrNull(input.reportedCostUsd);
  const sessionId = input.claudeSessionId || null;
  const baselineSession = (input.resumed && input.resumedSessionId) || sessionId;
  db.transaction(() => {
    const cost =
      input.reportedCostUsd !== undefined
        ? personaTurnOwnCost(
            reported,
            !!input.resumed,
            baselineSession
              ? personaTurnSessionHistory(db, input.user, baselineSession)
              : { anyTurn: false, ranLast: false, previous: null }
          )
        : finiteOrNull(input.costUsd);
    const share = cost === null || jobIds.length === 0 ? null : cost / jobIds.length;
    db.run(
      `INSERT INTO persona_turns (id, user, thread_id, job_ids_json, kind, ok, started_at, duration_ms, cost_usd, input_tokens, output_tokens, model, epoch, claude_session_id, reported_cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.user,
        input.threadId ?? null,
        JSON.stringify(jobIds),
        input.kind ?? "turn",
        input.ok ? 1 : 0,
        input.startedAt,
        Math.max(0, Math.round(input.durationMs)),
        cost,
        finiteOrNull(input.inputTokens),
        finiteOrNull(input.outputTokens),
        input.model ?? null,
        finiteOrNull(input.epoch),
        sessionId,
        reported,
      ]
    );
    for (const jobId of jobIds) {
      db.run("INSERT OR IGNORE INTO persona_turn_jobs (turn_id, job_id, share_usd) VALUES (?, ?, ?)", [id, jobId, share]);
    }
  })();
  return getPersonaTurn(db, id)!;
}

export function getPersonaTurn(db: Database, id: string): PersonaTurnRecord | null {
  const row = db.query("SELECT * FROM persona_turns WHERE id = ?").get(id) as TurnRow | null;
  return row ? toTurn(row) : null;
}

/** `user`'s turns, newest first; `since` keeps those started at/after it. */
export function listPersonaTurns(db: Database, user: string, opts: { since?: string; limit?: number } = {}): PersonaTurnRecord[] {
  const rows = db
    .query(
      `SELECT * FROM persona_turns WHERE user = ? ${opts.since ? "AND started_at >= ?" : ""}
        ORDER BY started_at DESC, rowid DESC LIMIT ?`
    )
    .all(...(opts.since ? [user, opts.since] : [user]), opts.limit ?? 200) as TurnRow[];
  return rows.map(toTurn);
}

export interface PersonaTurnTotals {
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** The sum of `user`'s turns; `since` keeps those started at/after it. */
export function personaTurnTotals(db: Database, user: string, since?: string): PersonaTurnTotals {
  const row = db
    .query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
         FROM persona_turns WHERE user = ? ${since ? "AND started_at >= ?" : ""}`
    )
    .get(...(since ? [user, since] : [user])) as { n: number; cost: number; input: number; output: number };
  return { turns: row.n, costUsd: row.cost, inputTokens: row.input, outputTokens: row.output };
}

/** The Persona spend attributed to `jobId`: its share of every turn that touched it. */
export function personaJobTurnCost(db: Database, jobId: string): number {
  const row = db
    .query("SELECT COALESCE(SUM(share_usd), 0) AS cost FROM persona_turn_jobs WHERE job_id = ?")
    .get(jobId) as { cost: number };
  return row.cost;
}

// ── Budget layers ────────────────────────────────────────────────────────────

interface PrefsRow {
  budget_usd: number | null;
  budget_minutes: number | null;
  updated_at: string;
}

export interface JobBudgetPrefs extends JobBudgetLayer {
  updatedAt?: string;
}

/** `alias`'s budget layer: the global one, or the one for `projectId`. Null when never saved. */
export function getJobBudgetPrefs(db: Database, alias: string, projectId: string | null): JobBudgetPrefs | null {
  const row = db
    .query("SELECT budget_usd, budget_minutes, updated_at FROM persona_budget_prefs WHERE alias = ? AND project_id = ?")
    .get(alias, projectId ?? "") as PrefsRow | null;
  return row ? { usd: row.budget_usd, minutes: row.budget_minutes, updatedAt: row.updated_at } : null;
}

/** Saves `alias`'s layer (a full replace: an absent dimension inherits). */
export function setJobBudgetPrefs(db: Database, alias: string, projectId: string | null, layer: JobBudgetLayer): JobBudgetPrefs {
  db.run(
    `INSERT INTO persona_budget_prefs (alias, project_id, budget_usd, budget_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(alias, project_id) DO UPDATE SET
       budget_usd = excluded.budget_usd, budget_minutes = excluded.budget_minutes, updated_at = excluded.updated_at`,
    [alias, projectId ?? "", layer.usd ?? null, layer.minutes ?? null, new Date().toISOString()]
  );
  return getJobBudgetPrefs(db, alias, projectId)!;
}

export function deleteJobBudgetPrefs(db: Database, alias: string, projectId: string | null): void {
  db.run("DELETE FROM persona_budget_prefs WHERE alias = ? AND project_id = ?", [alias, projectId ?? ""]);
}

/** The owner's budget for a job in `projectId` with no budget of its own. */
export function resolveOwnerJobBudget(db: Database, owner: string, projectId: string | null): ResolvedJobBudget {
  return resolveJobBudget({
    project: projectId ? getJobBudgetPrefs(db, owner, projectId) : null,
    user: getJobBudgetPrefs(db, owner, null),
  });
}

/**
 * The least budget any of the owner's layers gives a job, per dimension: the
 * global resolution and each project's. A new job's project is set only by its
 * first launch, so a job-level value above this would override a lower
 * project setting.
 */
export function lowestOwnerJobBudget(db: Database, owner: string): Pick<ResolvedJobBudget, "usd" | "minutes"> {
  const projects = (
    db.query("SELECT project_id FROM persona_budget_prefs WHERE alias = ? AND project_id != ''").all(owner) as Array<{
      project_id: string;
    }>
  ).map((r) => r.project_id);
  const all = [resolveOwnerJobBudget(db, owner, null), ...projects.map((p) => resolveOwnerJobBudget(db, owner, p))];
  // null is no limit, the most of all.
  const least = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  return all.reduce((acc, b) => ({ usd: least(acc.usd, b.usd), minutes: least(acc.minutes, b.minutes) }), {
    usd: all[0]!.usd,
    minutes: all[0]!.minutes,
  });
}

// ── Per-job budget ───────────────────────────────────────────────────────────

interface JobBudgetRow {
  id: string;
  owner: string;
  status: string;
  created_at: string;
  updated_at: string;
  budget_usd: number | null;
  budget_minutes: number | null;
  worker_usd_cached: number | null;
  spent_at: string | null;
  budget_level: string | null;
  waiting_since: string | null;
  waiting_ms: number | null;
}

const OPEN_STATUSES = new Set(["active", "waiting_user"]);

/** The project of the job's first launch, which picks the owner's project layer. */
export function personaJobProject(db: Database, jobId: string): string | null {
  const row = db
    .query(
      `SELECT l.project_id AS project_id FROM persona_job_launches pjl JOIN launches l ON l.id = pjl.launch_id
        WHERE pjl.job_id = ? AND l.project_id IS NOT NULL ORDER BY pjl.created_at ASC, pjl.rowid ASC LIMIT 1`
    )
    .get(jobId) as { project_id: string | null } | null;
  return row?.project_id ?? null;
}

/**
 * The job's resolved budget and its use: Persona's share of its turns (read
 * now), its workers' cost as last cached, and the wall-clock minutes since it
 * opened — until `now` while open, until its last update once closed.
 */
export function personaJobBudget(db: Database, jobId: string, now: Date = new Date()): PersonaJobBudget | null {
  const row = db
    .query(
      `SELECT id, owner, status, created_at, updated_at, budget_usd, budget_minutes, worker_usd_cached, spent_at, budget_level,
              waiting_since, waiting_ms
         FROM persona_jobs WHERE id = ?`
    )
    .get(jobId) as JobBudgetRow | null;
  if (!row) return null;
  const projectId = personaJobProject(db, jobId);
  const resolved = resolveJobBudget({
    job: { usd: row.budget_usd, minutes: row.budget_minutes },
    project: projectId ? getJobBudgetPrefs(db, row.owner, projectId) : null,
    user: getJobBudgetPrefs(db, row.owner, null),
  });
  const personaUsd = personaJobTurnCost(db, jobId);
  const workerUsd = row.worker_usd_cached ?? 0;
  const spentUsd = personaUsd + workerUsd;
  const open = OPEN_STATUSES.has(row.status);
  const end = open ? now.getTime() : Date.parse(row.updated_at);
  // Time spent waiting on the owner — finished periods, and the current one — is left out.
  const waitingNow = open && row.waiting_since ? Math.max(0, end - Date.parse(row.waiting_since)) : 0;
  const elapsedMinutes = Math.max(0, (end - Date.parse(row.created_at) - (row.waiting_ms ?? 0) - waitingNow) / 60_000);
  return {
    ...resolved,
    spentUsd,
    personaUsd,
    workerUsd,
    elapsedMinutes,
    level: jobBudgetLevel(resolved, spentUsd, elapsedMinutes),
    ...(row.spent_at ? { checkedAt: row.spent_at } : {}),
  };
}

/** The job's budget as it would resolve with `patch` applied to its own values (see setPersonaJobBudget). */
export function previewPersonaJobBudget(db: Database, jobId: string, patch: JobBudgetLayer = {}): ResolvedJobBudget | null {
  const row = db
    .query("SELECT owner, budget_usd, budget_minutes FROM persona_jobs WHERE id = ?")
    .get(jobId) as { owner: string; budget_usd: number | null; budget_minutes: number | null } | null;
  if (!row) return null;
  const projectId = personaJobProject(db, jobId);
  return resolveJobBudget({
    job: {
      usd: patch.usd !== undefined ? patch.usd : row.budget_usd,
      minutes: patch.minutes !== undefined ? patch.minutes : row.budget_minutes,
    },
    project: projectId ? getJobBudgetPrefs(db, row.owner, projectId) : null,
    user: getJobBudgetPrefs(db, row.owner, null),
  });
}

/** Sets the job's own budget; an absent dimension is left as it is, null makes it inherit again. */
export function setPersonaJobBudget(db: Database, jobId: string, layer: JobBudgetLayer): void {
  const sets: string[] = [];
  const params: Array<number | null> = [];
  if (layer.usd !== undefined) {
    sets.push("budget_usd = ?");
    params.push(layer.usd);
  }
  if (layer.minutes !== undefined) {
    sets.push("budget_minutes = ?");
    params.push(layer.minutes);
  }
  if (sets.length === 0) return;
  db.run(`UPDATE persona_jobs SET ${sets.join(", ")} WHERE id = ?`, [...params, jobId]);
}

/** Caches the workers' cost read for the job. */
export function setPersonaJobWorkerSpend(db: Database, jobId: string, workerUsd: number, at: string): void {
  db.run("UPDATE persona_jobs SET worker_usd_cached = ?, spent_at = ? WHERE id = ?", [workerUsd, at, jobId]);
}

/** The budget level last announced for the job (null below `near`). */
export function getPersonaJobBudgetLevel(db: Database, jobId: string): JobBudgetLevel | null {
  const row = db.query("SELECT budget_level FROM persona_jobs WHERE id = ?").get(jobId) as { budget_level: string | null } | null;
  const level = row?.budget_level;
  return level === "near" || level === "exceeded" ? level : null;
}

/** Records the budget level announced for the job; `ok` clears it, so the notices re-arm. */
export function setPersonaJobBudgetLevel(db: Database, jobId: string, level: JobBudgetLevel, at: string): void {
  db.run("UPDATE persona_jobs SET budget_level = ?, budget_level_at = ? WHERE id = ?", [
    level === "ok" ? null : level,
    level === "ok" ? null : at,
    jobId,
  ]);
}

/** The owner's open jobs' ids, oldest first — the ones the budget check reads. */
export function listOpenPersonaJobIds(db: Database, owner: string): string[] {
  return (
    db
      .query("SELECT id FROM persona_jobs WHERE owner = ? AND status IN ('active', 'waiting_user') ORDER BY created_at ASC")
      .all(owner) as Array<{ id: string }>
  ).map((r) => r.id);
}
