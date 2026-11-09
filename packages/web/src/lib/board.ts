import {
  BOARD_STATUSES,
  BOARD_STATUS_LABEL,
  isOpenBoardStatus,
  matchesBoardQuery,
  type BoardStatus,
  type BoardTask,
  type BoardTaskFrame,
  type BoardTaskSource,
  type BoardTaskWithConflicts,
} from "@standup/shared";
import { safeHref } from "./safeHref";
import { liveWorkersPath, type WorkerSelection } from "./liveWorkers";

/** How long after the last board:task frame the board list is re-read for fresh conflicts. */
export const BOARD_CONFLICT_REFRESH_MS = 1500;

/** The longest a steady stream of board:task frames can hold off that re-read. */
export const BOARD_CONFLICT_REFRESH_MAX_WAIT_MS = 5000;

/** How long a board list read may wait for the response to start before it counts as failed, so a read stuck on a dead connection is retried. */
export const BOARD_READ_TIMEOUT_MS = 10_000;

/**
 * The board list read sent before the Board view first opens: only the open
 * tasks waiting on someone, the Board tab badge's count, rather than the whole
 * list of open and recently closed cards.
 */
export const BOARD_WAITING_PATH = "/api/board/tasks?status=waiting&open=1";

/** The console routes that open the Board view: /board itself and /tickets, which redirects to it. */
export const BOARD_ROUTE = /^\/(?:board|tickets)\/?$/;

/** How long a whole board list read, body included, may take before it counts as failed. */
export const BOARD_READ_DEADLINE_MS = 60_000;

/** The waits before each retry of a failed board list read; the last repeats until a read lands. */
export const BOARD_READ_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 15_000];

/** The wait before retry number `attempt` (0-based) of a failed board list read. */
export function boardReadRetryDelay(attempt: number): number {
  return BOARD_READ_RETRY_MS[Math.min(attempt, BOARD_READ_RETRY_MS.length - 1)]!;
}

/** The reader's board version from a `GET /api/board/version` or list body; undefined when it carries none. */
export function boardVersionOf(body: unknown): string | undefined {
  const v = (body as { version?: unknown } | null)?.version;
  return typeof v === "string" && v ? v : undefined;
}

/**
 * When the debounced re-read fires, given when the current burst of frames
 * began and the latest frame arrived: BOARD_CONFLICT_REFRESH_MS after the
 * latest frame, but never later than BOARD_CONFLICT_REFRESH_MAX_WAIT_MS after
 * the first.
 */
export function boardRefreshDueAt(burstStartedAt: number, lastFrameAt: number): number {
  return Math.min(lastFrameAt + BOARD_CONFLICT_REFRESH_MS, burstStartedAt + BOARD_CONFLICT_REFRESH_MAX_WAIT_MS);
}

/**
 * Lays a list-route response over the held tasks. A task named in `lateIds`
 * had a board:task frame applied after the read was issued, so the held
 * version (or its absence, for a removal) is newer than the listed one and is
 * kept; every other task is as listed.
 */
export function mergeBoardList(
  listed: readonly BoardTaskWithConflicts[],
  held: readonly BoardTaskWithConflicts[],
  lateIds: ReadonlySet<string>,
): BoardTaskWithConflicts[] {
  if (lateIds.size === 0) return listed.slice();
  const heldById = new Map(held.map((t) => [t.id, t]));
  const out: BoardTaskWithConflicts[] = [];
  const seen = new Set<string>();
  for (const t of listed) {
    seen.add(t.id);
    if (!lateIds.has(t.id)) out.push(t);
    else if (heldById.has(t.id)) out.push(heldById.get(t.id)!);
  }
  for (const id of lateIds) {
    const h = heldById.get(id);
    if (h && !seen.has(id)) out.push(h);
  }
  return out;
}

/**
 * How the board list read went: `ok` answered with the viewer's own tasks,
 * `team` with only the team-wide tasks (the ticket queue) because the route
 * couldn't tell who the viewer is, `refused` with 401/403, and `failed` with
 * no answer; `pending` until the first read settles.
 */
/** `unavailable`: the collector has no board routes (a 404), so the read is retried only now and then. */
export type BoardListState = "pending" | "ok" | "team" | "refused" | "failed" | "unavailable";

/** A list-route or closed-page response, read defensively. */
export interface BoardListBody {
  tasks: BoardTaskWithConflicts[];
  /** `team` when the route answered with only the team-wide tasks. */
  scope: "user" | "team";
  /** Whether more closed tasks exist past the ones returned (`closedMore` on the list, `more` on a page). */
  more: boolean;
  /** On a page: where the page after it starts (`nextClosedBefore`, `nextClosedBeforeId`). */
  next?: ClosedCursor;
}

/** Reads a list-route response, or a closed page of one; a missing scope reads as the viewer's own. */
export function boardListOf(body: unknown): BoardListBody {
  const b = (body ?? {}) as {
    scope?: unknown;
    closedMore?: unknown;
    more?: unknown;
    nextClosedBefore?: unknown;
    nextClosedBeforeId?: unknown;
  };
  const out: BoardListBody = {
    tasks: boardTasksOf(body),
    scope: b.scope === "team" ? "team" : "user",
    more: b.closedMore === true || b.more === true,
  };
  if (typeof b.nextClosedBefore === "string" && b.nextClosedBefore) {
    out.next = { before: b.nextClosedBefore, beforeId: typeof b.nextClosedBeforeId === "string" ? b.nextClosedBeforeId : "" };
  }
  return out;
}

/** How many of the most recent tasks a closed column shows before folding the rest into "+N older". */
export const CLOSED_COLUMN_CAP = 30;

/** How many closed tasks one "Load older" read asks the route for. */
export const CLOSED_PAGE_SIZE = 30;

/**
 * The route's closed-task order, `updatedAt DESC, id DESC`: negative when `a`
 * comes first (is newer, or as new with the greater id).
 */
export function closedOrder(a: BoardTask, b: BoardTask): number {
  const byTime = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Where the next closed page starts: the last loaded closed task under the route's closed order. */
export interface ClosedCursor {
  before: string;
  beforeId: string;
}

/**
 * The oldest closed (done or failed) task under `updatedAt DESC, id DESC`,
 * the cursor for the next closed page.
 */
export function oldestClosedCursor(tasks: readonly BoardTask[]): ClosedCursor | undefined {
  let oldest: BoardTask | undefined;
  for (const t of tasks) {
    if (isOpenBoardStatus(t.status)) continue;
    if (!oldest || closedOrder(t, oldest) > 0) oldest = t;
  }
  return oldest ? { before: oldest.updatedAt, beforeId: oldest.id } : undefined;
}

/**
 * The list-route path for the page of closed tasks after `cursor` in the
 * route's closed order, narrowed by the board filter's text, project, source
 * and status.
 */
export function closedPagePath(
  cursor: ClosedCursor,
  filter: BoardFilter = EMPTY_BOARD_FILTER,
  limit = CLOSED_PAGE_SIZE,
): string {
  const params = new URLSearchParams({ closedBefore: cursor.before, closedBeforeId: cursor.beforeId, closedLimit: String(limit) });
  if (filter.status) params.set("status", filter.status);
  if (filter.source) params.set("source", filter.source);
  if (filter.projectId) params.set("project", filter.projectId);
  if (filter.text) params.set("q", filter.text);
  return `/api/board/tasks?${params.toString()}`;
}

/** How long a closed-page read may take before it is abandoned. */
export const CLOSED_PAGE_TIMEOUT_MS = 30_000;

/**
 * Reads one closed page at `path`, or null when the route answered with an
 * error status. A read still unanswered (headers or body) after `timeoutMs`
 * is aborted and rejects, so a hung read always settles.
 */
export async function readClosedPage(
  path: string,
  timeoutMs = CLOSED_PAGE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardListBody | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`closed page read timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const read = async () => {
    const r = await fetchImpl(path, { signal: controller.signal });
    if (!r.ok) return null;
    return boardListOf(await r.json());
  };
  try {
    return await Promise.race([read(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `older` joined by `page`, the fresher of the two: a task of `page` replaces
 * the one with its id in place, and the rest join at the end.
 */
export function appendClosedPage(
  older: readonly BoardTaskWithConflicts[],
  page: readonly BoardTaskWithConflicts[],
): BoardTaskWithConflicts[] {
  const fresh = new Map(page.map((t) => [t.id, t]));
  const out = older.map((t) => fresh.get(t.id) ?? t);
  const ids = new Set(older.map((t) => t.id));
  return [...out, ...page.filter((t) => !ids.has(t.id))];
}

/** The older of two closed-page cursors under `updatedAt DESC, id DESC`. */
export function olderCursor(a: ClosedCursor | undefined, b: ClosedCursor | undefined): ClosedCursor | undefined {
  if (!a || !b) return a ?? b;
  const byTime = new Date(a.before).getTime() - new Date(b.before).getTime();
  if (byTime !== 0) return byTime < 0 ? a : b;
  return a.beforeId <= b.beforeId ? a : b;
}

/**
 * The tasks the board shows: the held list, then each paged-in older closed
 * task the list doesn't hold, so a list re-read never drops what the viewer
 * paged in.
 */
export function withOlderClosed(
  held: readonly BoardTaskWithConflicts[],
  older: readonly BoardTaskWithConflicts[],
): BoardTaskWithConflicts[] {
  if (older.length === 0) return held.slice();
  const ids = new Set(held.map((t) => t.id));
  return [...held, ...older.filter((t) => !ids.has(t.id))];
}

/** The tasks the board holds: the list as last read and framed, and the closed tasks paged in beside it. */
export interface HeldBoard {
  held: BoardTaskWithConflicts[];
  older: BoardTaskWithConflicts[];
}

/**
 * Lays a viewer-scoped list read over the held board (see mergeBoardList).
 * While closed tasks are paged in, a held closed task the read left out —
 * pushed past the route's closed cap by newer closes — moves into the paged-in
 * set rather than vanishing from between the list and the pages; a task a
 * removal frame named after the read was issued (in `lateIds`) stays gone.
 */
export function settleBoardRead(
  board: HeldBoard,
  listed: readonly BoardTaskWithConflicts[],
  lateIds: ReadonlySet<string>,
): HeldBoard {
  const held = mergeBoardList(listed, board.held, lateIds);
  if (board.older.length === 0) return { held, older: board.older };
  const kept = new Set(held.map((t) => t.id));
  const dropped = board.held.filter((t) => !isOpenBoardStatus(t.status) && !kept.has(t.id) && !lateIds.has(t.id));
  return { held, older: dropped.length > 0 ? appendClosedPage(board.older, dropped) : board.older };
}

/**
 * Applies a board:task frame to the paged-in older closed tasks, but only to a
 * task already among them: the held list takes in new tasks.
 */
export function applyFrameToOlder(older: BoardTaskWithConflicts[], frame: BoardTaskFrame): BoardTaskWithConflicts[] {
  const id = frame.removed?.id ?? frame.task?.id;
  if (!id || !older.some((t) => t.id === id)) return older;
  return upsertBoardTask(older, frame);
}

/**
 * Who a card's waitingOn line is on: the viewer, Persona, its worker or the
 * host getting on with it, or nobody while parked.
 */
export type WaitingOnTone = "viewer" | "persona" | "parked";

/**
 * The waitingOn lines that don't wait on the viewer, by prefix: whether each
 * reads as given or after "waiting on", and its tone.
 */
const NON_VIEWER_WAITS: { prefix: string; given: boolean; tone: WaitingOnTone }[] = [
  { prefix: "Persona deciding", given: true, tone: "persona" },
  { prefix: "parked:", given: true, tone: "parked" },
  { prefix: "code review in progress", given: true, tone: "persona" },
  { prefix: "Persona to close out", given: false, tone: "persona" },
  { prefix: "host room to start", given: false, tone: "persona" },
];

/**
 * How a card's waitingOn line reads: a line that doesn't wait on the viewer
 * (Persona deciding, parked, a code review in progress, Persona closing out, the host
 * finding room to start) takes the muted or parked tone, and all but the last
 * two read as given; anything else is what the task waits on the viewer for.
 */
export function waitingOnLine(waitingOn: string): { text: string; tone: WaitingOnTone } {
  const known = NON_VIEWER_WAITS.find((w) => waitingOn.startsWith(w.prefix));
  if (known) return { text: known.given ? waitingOn : `waiting on ${waitingOn}`, tone: known.tone };
  return { text: `waiting on ${waitingOn}`, tone: "viewer" };
}

/**
 * Applies one `board:task` frame to the held list: a removal drops the task, a
 * task replaces the one with its id (or joins at the front). Conflicts are
 * computed only by the list route, so a replaced open task keeps the conflicts
 * it was listed with until the next list read; a task that closed loses them,
 * since closed tasks are never checked. Returns `list` itself when nothing changed.
 */
export function upsertBoardTask(list: BoardTaskWithConflicts[], frame: BoardTaskFrame): BoardTaskWithConflicts[] {
  if (frame.removed) {
    const id = frame.removed.id;
    return list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : list;
  }
  const task = frame.task;
  if (!task) return list;
  const i = list.findIndex((t) => t.id === task.id);
  if (i === -1) return [task, ...list];
  const prev = list[i];
  const conflicts = isOpenBoardStatus(task.status) ? prev.conflicts : undefined;
  const next = list.slice();
  next[i] = conflicts ? { ...task, conflicts } : { ...task };
  return next;
}

export interface BoardColumn {
  status: BoardStatus;
  label: string;
  /** The tasks shown, most recently updated first. */
  tasks: BoardTaskWithConflicts[];
  /** Every task in the column, shown or not. */
  total: number;
  /** Older tasks of a closed column left out past the cap. */
  hidden: number;
}

function byUpdatedDesc(a: BoardTask, b: BoardTask): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/**
 * The board's columns in BOARD_STATUSES order, each most recently updated
 * first. The closed columns (done, failed) keep only their `cap` most recent
 * tasks and count the rest as hidden, so a long history never buries the board;
 * a closed column in `uncapped` (the viewer expanded it) shows every task.
 */
export function groupByColumn(
  tasks: readonly BoardTaskWithConflicts[],
  cap = CLOSED_COLUMN_CAP,
  uncapped: ReadonlySet<BoardStatus> = new Set(),
): BoardColumn[] {
  const buckets = new Map<BoardStatus, BoardTaskWithConflicts[]>(BOARD_STATUSES.map((s) => [s, []]));
  for (const t of tasks) buckets.get(t.status)?.push(t);
  return BOARD_STATUSES.map((status) => {
    const all = (buckets.get(status) ?? []).sort(byUpdatedDesc);
    const shown = isOpenBoardStatus(status) || uncapped.has(status) ? all : all.slice(0, cap);
    return { status, label: BOARD_STATUS_LABEL[status], tasks: shown, total: all.length, hidden: all.length - shown.length };
  });
}

/** The board's client-side filter, mirrored in the URL query (?q=&project=&source=&status=). */
export interface BoardFilter {
  text: string;
  projectId: string;
  source: BoardTaskSource | "";
  status: BoardStatus | "";
}

/** The filter that keeps every task. */
export const EMPTY_BOARD_FILTER: BoardFilter = { text: "", projectId: "", source: "", status: "" };

/** A filter as one comparable string: equal filters give equal keys. */
export function boardFilterKey(filter: BoardFilter): string {
  return writeBoardFilter(new URLSearchParams(), filter).toString();
}

const SOURCE_ALIASES: Record<string, BoardTaskSource> = {
  job: "job",
  jobs: "job",
  ticket: "ticket",
  tickets: "ticket",
  backlog: "backlog",
};

function parseStatus(raw: string | null): BoardStatus | "" {
  const value = (raw ?? "").toLowerCase();
  return (BOARD_STATUSES as readonly string[]).includes(value) ? (value as BoardStatus) : "";
}

/** Reads the filter from the board's URL query; an unknown source or status reads as all. */
export function parseBoardFilter(params: URLSearchParams): BoardFilter {
  return {
    text: params.get("q") ?? "",
    projectId: params.get("project") ?? "",
    source: SOURCE_ALIASES[(params.get("source") ?? "").toLowerCase()] ?? "",
    status: parseStatus(params.get("status")),
  };
}

/** Writes `filter` into `params` (empty fields are removed), keeping every other key. */
export function writeBoardFilter(params: URLSearchParams, filter: BoardFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  set("q", filter.text);
  set("project", filter.projectId);
  set("source", filter.source);
  set("status", filter.status);
  return next;
}

/** The tasks matching the filter's text, project, source and status. */
export function filterBoardTasks<T extends BoardTask>(tasks: readonly T[], filter: BoardFilter): T[] {
  const query = {
    text: filter.text || undefined,
    projectId: filter.projectId || undefined,
    source: filter.source ? [filter.source] : undefined,
    status: filter.status ? [filter.status] : undefined,
  };
  return tasks.filter((t) => matchesBoardQuery(t, query));
}

/** Tasks waiting on their owner — the Board tab's badge. */
export function waitingCount(tasks: readonly BoardTask[]): number {
  return tasks.filter((t) => t.status === "waiting").length;
}

/** The ticket a ticket-sourced card stands for. */
export function ticketIdOf(task: BoardTask): string | undefined {
  if (task.source !== "ticket") return undefined;
  return task.links.ticketId ?? task.sourceId;
}

export type BoardCardLinkKind = "job" | "session" | "launch" | "review" | "code_review" | "tunnel";

/**
 * One link on a card: `to` is a console route, `href` an external URL. A code
 * review whose recorded URL is not plain http(s) carries neither and renders as text.
 */
export interface BoardCardLink {
  kind: BoardCardLinkKind;
  label: string;
  to?: string;
  href?: string;
  /** What the link opens in the Live workers drawer; the Board opens it in place, keeping its filter. */
  worker?: WorkerSelection;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * The links a card offers, in display order: its Persona job (the job drawer
 * is the /persona?job= query), each worker session (or, before any session
 * attaches, each launch) in the Live workers drawer, its review packet, its code review and its live
 * review tunnel.
 */
export function cardLinks(task: BoardTask): BoardCardLink[] {
  const { links } = task;
  const out: BoardCardLink[] = [];
  if (links.jobId) out.push({ kind: "job", label: "Job", to: `/persona?job=${encodeURIComponent(links.jobId)}` });
  const sessions = links.sessionIds ?? [];
  const worker = (kind: "session" | "launch", label: string, selection: WorkerSelection): BoardCardLink =>
    ({ kind, label, to: liveWorkersPath(selection), worker: selection });
  for (const id of sessions) out.push(worker("session", `Session ${shortId(id)}`, { kind: "s", id }));
  if (sessions.length === 0) {
    for (const id of links.launchIds ?? []) out.push(worker("launch", `Launch ${shortId(id)}`, { kind: "l", id }));
  }
  if (links.packetId) out.push({ kind: "review", label: "Review", to: `/review/${encodeURIComponent(links.packetId)}` });
  if (links.codeReview && (links.codeReview.id || links.codeReview.url)) {
    const href = safeHref(links.codeReview.url) ?? undefined;
    out.push({ kind: "code_review", label: links.codeReview.id ?? "Code review", href });
  }
  const tunnel = safeHref(links.tunnelUrl);
  if (tunnel) out.push({ kind: "tunnel", label: "Tunnel", href: tunnel });
  return out;
}

/** The task list in a list-route response; anything else reads as empty. */
export function boardTasksOf(body: unknown): BoardTaskWithConflicts[] {
  const tasks = (body as { tasks?: unknown } | null)?.tasks;
  return Array.isArray(tasks) ? (tasks as BoardTaskWithConflicts[]) : [];
}
