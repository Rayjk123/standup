import type { Database } from "bun:sqlite";
import type {
  BoardQuery,
  BoardStatus,
  BoardTask,
  BoardTaskAreas,
  BoardTaskFlag,
  BoardTaskInput,
  BoardTaskLinks,
  BoardTaskSource,
} from "@standup/shared";
import { boardTaskId, isOpenBoardStatus, matchesBoardQuery } from "@standup/shared";

interface BoardTaskRow {
  id: string;
  owner: string;
  source: BoardTaskSource;
  source_id: string;
  project_id: string | null;
  title: string;
  goal: string | null;
  status: BoardStatus;
  flag: string | null;
  stage: string | null;
  waiting_on: string | null;
  links_json: string;
  areas_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

function parseObject<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function toAreas(json: string): BoardTaskAreas {
  const raw = parseObject<Partial<BoardTaskAreas>>(json, {});
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  return { files: strings(raw.files), packages: strings(raw.packages) };
}

function toTask(row: BoardTaskRow): BoardTask {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    owner: row.owner,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    title: row.title,
    ...(row.goal ? { goal: row.goal } : {}),
    status: row.status,
    ...(row.flag ? { flag: row.flag as BoardTaskFlag } : {}),
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.waiting_on ? { waitingOn: row.waiting_on } : {}),
    links: parseObject<BoardTaskLinks>(row.links_json, {}),
    areas: toAreas(row.areas_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  };
}

/**
 * The links with empty fields dropped, so equal links serialize equally —
 * except `launchIds`, kept even when empty: its presence marks a job card the
 * board adapter has projected (a backfilled card has none).
 */
function cleanLinks(links: BoardTaskLinks): BoardTaskLinks {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(links).sort()) {
    const value = (links as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0 || key === "launchIds") out[key] = value;
      continue;
    }
    if (typeof value === "object") {
      const inner = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .sort(([a], [b]) => a.localeCompare(b))
      );
      if (Object.keys(inner).length > 0) out[key] = inner;
      continue;
    }
    out[key] = value;
  }
  return out as BoardTaskLinks;
}

/** A JSON serialization with object keys sorted, for comparing stored values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const optional = (v: string | undefined | null): string | null => (v && v.trim() ? v : null);

/** Each database's board version: bumped on every write that changes a task. */
const boardVersions = new WeakMap<Database, number>();

/**
 * A counter that moves whenever a board task is written with a change or
 * removed, so a reader can cache what it derived from the board until then.
 */
export function boardVersion(db: Database): number {
  return boardVersions.get(db) ?? 0;
}

function bumpBoardVersion(db: Database): void {
  boardVersions.set(db, boardVersion(db) + 1);
}

export function getBoardTask(db: Database, id: string): BoardTask | null {
  const row = db.query("SELECT * FROM board_tasks WHERE id = ?").get(id) as BoardTaskRow | null;
  return row ? toTask(row) : null;
}

export function getBoardTaskBySource(db: Database, source: BoardTaskSource, sourceId: string): BoardTask | null {
  const row = db
    .query("SELECT * FROM board_tasks WHERE source = ? AND source_id = ?")
    .get(source, sourceId) as BoardTaskRow | null;
  return row ? toTask(row) : null;
}

/**
 * Writes a source's task, keyed by (source, sourceId). The task keeps its
 * created_at; closed_at is stamped when it enters a closed column and cleared
 * when it reopens. updated_at moves on every change, except a closed task
 * that stays in its column with the same flag — only its stage, waiting-on,
 * links, areas, title, goal, owner or project refined — which keeps its
 * updated_at and so its place among the closed tasks. `changed` is false —
 * and nothing is written — when every stored field already holds what
 * `input` gives.
 */
export function upsertBoardTask(
  db: Database,
  input: BoardTaskInput,
  now: string = new Date().toISOString()
): { task: BoardTask; changed: boolean } {
  const existing = getBoardTaskBySource(db, input.source, input.sourceId);
  const closed = !isOpenBoardStatus(input.status);
  const closedAt = closed ? (existing?.closedAt && !isOpenBoardStatus(existing.status) ? existing.closedAt : now) : null;
  const next = {
    owner: input.owner ?? "",
    project_id: optional(input.projectId),
    title: input.title,
    goal: optional(input.goal),
    status: input.status,
    flag: optional(input.flag),
    stage: optional(input.stage),
    waiting_on: optional(input.waitingOn),
    links_json: canonical(cleanLinks(input.links ?? {})),
    areas_json: canonical({ files: input.areas?.files ?? [], packages: input.areas?.packages ?? [] }),
    closed_at: closedAt,
  };
  let updatedAt = now;
  if (existing) {
    const stored = db.query("SELECT * FROM board_tasks WHERE id = ?").get(existing.id) as BoardTaskRow;
    // A closed card staying in its column with its flag is only refined (its stage, links, areas or
    // title filled in by a reprojection), so it keeps its place among the closed cards.
    const refinement = closed && !isOpenBoardStatus(stored.status) && stored.status === next.status && stored.flag === next.flag;
    if (refinement) updatedAt = stored.updated_at;
    const same =
      stored.owner === next.owner &&
      stored.project_id === next.project_id &&
      stored.title === next.title &&
      stored.goal === next.goal &&
      stored.status === next.status &&
      stored.flag === next.flag &&
      stored.stage === next.stage &&
      stored.waiting_on === next.waiting_on &&
      stored.closed_at === next.closed_at &&
      canonical(cleanLinks(parseObject<BoardTaskLinks>(stored.links_json, {}))) === next.links_json &&
      canonical(toAreas(stored.areas_json)) === next.areas_json;
    if (same) return { task: existing, changed: false };
  }
  const id = existing?.id ?? boardTaskId(input.source, input.sourceId);
  db.run(
    `INSERT INTO board_tasks
       (id, owner, source, source_id, project_id, title, goal, status, flag, stage, waiting_on,
        links_json, areas_json, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, source_id) DO UPDATE SET
       owner = excluded.owner, project_id = excluded.project_id, title = excluded.title, goal = excluded.goal,
       status = excluded.status, flag = excluded.flag, stage = excluded.stage, waiting_on = excluded.waiting_on,
       links_json = excluded.links_json, areas_json = excluded.areas_json,
       updated_at = excluded.updated_at, closed_at = excluded.closed_at`,
    [
      id,
      next.owner,
      input.source,
      input.sourceId,
      next.project_id,
      next.title,
      next.goal,
      next.status,
      next.flag,
      next.stage,
      next.waiting_on,
      next.links_json,
      next.areas_json,
      now,
      updatedAt,
      next.closed_at,
    ]
  );
  bumpBoardVersion(db);
  return { task: getBoardTask(db, id)!, changed: true };
}

export interface ListBoardTasksQuery extends BoardQuery {
  /** Only this user's tasks (with `includeShared`, the team-wide ones too). */
  owner?: string;
  /** With `owner`: also the team-wide tasks (owner ""). */
  includeShared?: boolean;
  /**
   * Only the cards of these job ids: their job cards and the backlog cards
   * linking them (an empty list matches none).
   */
  jobIds?: readonly string[];
  /** The most closed tasks returned, most recently updated first (default DEFAULT_CLOSED_BOARD_TASKS). */
  closedLimit?: number;
  /**
   * Only closed tasks past this cursor (a page of older closed tasks); no open
   * ones. The cursor is the last task of the previous page, read in the order
   * `updated_at DESC, id DESC`: tasks updated before `closedBefore`, or
   * updated at it with an id below `closedBeforeId`. Without
   * `closedBeforeId`, only tasks updated strictly before `closedBefore`.
   */
  closedBefore?: string;
  /** With `closedBefore`: the id of the cursor task, so tasks tied on its time aren't skipped. */
  closedBeforeId?: string;
  /** Leaves out each job card a backlog card links, which represents the job instead. */
  hideLinkedJobs?: boolean;
}

/** A board read: the tasks, and whether more closed tasks match past the closed cap. */
export interface BoardTaskPage {
  tasks: BoardTask[];
  closedMore: boolean;
}

/** How many closed tasks a board read returns by default; open tasks are never capped. */
export const DEFAULT_CLOSED_BOARD_TASKS = 200;
const MAX_CLOSED_BOARD_TASKS = 2000;

/** The board's order: most recently updated first, ties by id descending (SQLite's binary collation). */
function newestFirst(a: BoardTaskRow, b: BoardTaskRow): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

/**
 * Whether the row is a job card a backlog card of the same owner links (SQL,
 * against the outer board_tasks row), which that backlog card represents. A
 * backlog card of another owner — a team-wide one — never hides the job.
 */
const LINKED_JOB_CARD = `source = 'job' AND EXISTS (
  SELECT 1 FROM board_tasks AS linking
   WHERE linking.source = 'backlog' AND linking.owner = board_tasks.owner
     AND json_extract(linking.links_json, '$.jobId') = board_tasks.source_id)`;

/**
 * Tasks matching `q`, most recently updated first: every open task, and at
 * most `closedLimit` closed ones. Owner, status, source, project, job ids and
 * open-ness filter in SQL; text and files through matchesBoardQuery, before
 * the closed cap.
 */
export function listBoardTasks(db: Database, q: ListBoardTasksQuery = {}): BoardTask[] {
  return listBoardTaskPage(db, q).tasks;
}

/**
 * listBoardTasks with whether more closed tasks match past the cap. With
 * `closedBefore` (and `closedBeforeId`), only the closed tasks past that
 * cursor, newest first. Ties on updated_at go by id, descending.
 */
export function listBoardTaskPage(db: Database, q: ListBoardTasksQuery = {}): BoardTaskPage {
  const where: string[] = [];
  const params: string[] = [];
  if (q.owner !== undefined) {
    where.push(q.includeShared && q.owner !== "" ? "owner IN (?, '')" : "owner = ?");
    params.push(q.owner);
  }
  if (q.status && q.status.length > 0) {
    where.push(`status IN (${q.status.map(() => "?").join(", ")})`);
    params.push(...q.status);
  }
  if (q.source && q.source.length > 0) {
    where.push(`source IN (${q.source.map(() => "?").join(", ")})`);
    params.push(...q.source);
  }
  if (q.projectId) {
    where.push("project_id = ?");
    params.push(q.projectId);
  }
  if (q.jobIds) {
    if (q.jobIds.length === 0) return { tasks: [], closedMore: false };
    const marks = q.jobIds.map(() => "?").join(", ");
    where.push(
      `((source = 'job' AND source_id IN (${marks})) OR (source = 'backlog' AND json_extract(links_json, '$.jobId') IN (${marks})))`
    );
    params.push(...q.jobIds, ...q.jobIds);
  }
  if (q.hideLinkedJobs) where.push(`NOT (${LINKED_JOB_CARD})`);
  const filtered = !!(q.text?.trim() || (q.files && q.files.length > 0));
  const matches = (task: BoardTask) => !filtered || matchesBoardQuery(task, { text: q.text, files: q.files });
  /**
   * The matching rows, newest first. A read that may stop early (a text or
   * files filter past the closed cap) walks its own prepared statement,
   * finalized after, so an abandoned walk never leaves a cached one mid-step.
   */
  function* select(conditions: string[], conditionParams: string[], limit?: number): Generator<BoardTaskRow> {
    const sql = `SELECT * FROM board_tasks WHERE ${[...where, ...conditions].join(" AND ")}
          ORDER BY updated_at DESC, id DESC${limit !== undefined ? ` LIMIT ${limit}` : ""}`;
    if (limit !== undefined) {
      yield* db.query(sql).all(...params, ...conditionParams) as BoardTaskRow[];
      return;
    }
    const stmt = db.prepare(sql);
    try {
      yield* stmt.iterate(...params, ...conditionParams) as Iterable<BoardTaskRow>;
    } finally {
      stmt.finalize();
    }
  }

  const rows: BoardTaskRow[] = [];
  const tasks = new Map<BoardTaskRow, BoardTask>();
  if (q.closedBefore === undefined) {
    for (const row of select(["status NOT IN ('done', 'failed')"], [])) {
      const task = toTask(row);
      if (!matches(task)) continue;
      rows.push(row);
      tasks.set(row, task);
    }
  }
  let closedMore = false;
  // A page (closedBefore) holds only closed tasks, so excluding them leaves it empty.
  if (q.includeClosed !== false) {
    const cap = Math.max(0, Math.min(q.closedLimit ?? DEFAULT_CLOSED_BOARD_TASKS, MAX_CLOSED_BOARD_TASKS));
    const closed = ["status IN ('done', 'failed')"];
    const closedParams: string[] = [];
    if (q.closedBefore !== undefined && q.closedBeforeId !== undefined) {
      closed.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      closedParams.push(q.closedBefore, q.closedBefore, q.closedBeforeId);
    } else if (q.closedBefore !== undefined) {
      closed.push("updated_at < ?");
      closedParams.push(q.closedBefore);
    }
    // Unfiltered, SQL caps the read (one past the cap, to tell whether more exist); a text or
    // files filter matches rows in JS first.
    let taken = 0;
    for (const row of select(closed, closedParams, filtered ? undefined : cap + 1)) {
      const task = toTask(row);
      if (!matches(task)) continue;
      if (taken >= cap) {
        closedMore = true;
        break;
      }
      rows.push(row);
      tasks.set(row, task);
      taken++;
    }
  }
  rows.sort(newestFirst);
  return { tasks: rows.map((row) => tasks.get(row)!), closedMore };
}

/** The backlog cards whose `links.jobId` names `jobId`, oldest first. */
export function listBoardTasksByJob(db: Database, jobId: string): BoardTask[] {
  const rows = db
    .query(
      `SELECT * FROM board_tasks WHERE source = 'backlog' AND json_extract(links_json, '$.jobId') = ?
        ORDER BY created_at, rowid`
    )
    .all(jobId) as BoardTaskRow[];
  return rows.map(toTask);
}

/**
 * Whether a backlog card of `owner` (the job's owner) links `jobId`, so the
 * job's own card is hidden behind it. Another owner's backlog card linking
 * the job — a team-wide one — never hides it.
 */
export function boardJobLinkedByBacklog(db: Database, jobId: string, owner: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM board_tasks WHERE source = 'backlog' AND owner = ? AND json_extract(links_json, '$.jobId') = ? LIMIT 1`
    )
    .get(owner, jobId);
}

/**
 * The ids of every user's Persona jobs a board reconcile reprojects: those
 * still open, those closed at or after `closedSince`, those whose card is
 * still open however long ago the job closed (or that no longer exist), and
 * those a backlog card links.
 */
export function boardJobIdsToReconcile(db: Database, closedSince: string): string[] {
  const rows = db
    .query(
      `SELECT id FROM (
         SELECT id, created_at AS at, rowid AS r FROM persona_jobs
          WHERE status IN ('active', 'waiting_user') OR updated_at >= ?
         UNION
         SELECT source_id AS id, created_at AS at, rowid AS r FROM board_tasks
          WHERE source = 'job' AND status NOT IN ('done', 'failed')
         UNION
         SELECT json_extract(links_json, '$.jobId') AS id, created_at AS at, rowid AS r FROM board_tasks
          WHERE source = 'backlog' AND json_extract(links_json, '$.jobId') IS NOT NULL
       )
       GROUP BY id
       ORDER BY MIN(at), MIN(r)`
    )
    .all(closedSince) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** How many never-projected job cards one reconcile refines. */
export const MAX_UNREFINED_BOARD_JOBS = 500;

/**
 * The job ids of cards the board adapter has never projected (a backfilled
 * card, whose links carry no `launchIds`), however long ago the job closed,
 * oldest first and at most `limit`. Projecting a card marks it refined.
 */
export function boardUnrefinedJobIds(db: Database, limit: number = MAX_UNREFINED_BOARD_JOBS): string[] {
  const rows = db
    .query(
      `SELECT source_id AS id FROM board_tasks
        WHERE source = 'job' AND json_type(links_json, '$.launchIds') IS NULL
        ORDER BY created_at, rowid LIMIT ?`
    )
    .all(Math.max(0, limit)) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * The ids of the tickets a board reconcile reprojects: those not yet shipped
 * or dismissed, and any whose card's column disagrees with its status.
 */
export function boardTicketIdsToReconcile(db: Database): string[] {
  const rows = db
    .query(
      `SELECT t.id FROM tickets t
         LEFT JOIN board_tasks b ON b.source = 'ticket' AND b.source_id = t.id
        WHERE t.status NOT IN ('shipped', 'dismissed')
           OR (b.id IS NOT NULL AND b.status <> CASE t.status
                 WHEN 'shipped' THEN 'done'
                 WHEN 'dismissed' THEN 'failed'
                 ELSE '' END)
        ORDER BY t.created_at, t.rowid`
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Removes a source's task; returns the removed task, or null when it had none. */
export function deleteBoardTask(db: Database, source: BoardTaskSource, sourceId: string): BoardTask | null {
  const existing = getBoardTaskBySource(db, source, sourceId);
  if (!existing) return null;
  db.run("DELETE FROM board_tasks WHERE id = ?", [existing.id]);
  bumpBoardVersion(db);
  return existing;
}
