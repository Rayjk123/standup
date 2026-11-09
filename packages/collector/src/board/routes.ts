import type { Context, Hono } from "hono";
import type { BoardConflict, BoardConflictProbe, BoardStatus, BoardTaskSource, BoardTaskWithConflicts } from "@standup/shared";
import { BOARD_STATUSES, boardConflictMap, isOpenBoardStatus } from "@standup/shared";
import { PERSONA_WRITER_HEADER } from "../persona/memory-trust.js";
import { PERSONA_TOKEN_HEADER } from "../persona/routes.js";
import { ANONYMOUS_ALIAS } from "../review/stage.js";
import type { Board } from "./board.js";

export interface BoardRoutesOptions {
  board: Board;
  /** The request's own identity (the server's actingAlias) — never a body field. */
  identityOf: (c: Context) => string;
  /** Whether the request carries the owner secret (OWNER_TOKEN_HEADER). */
  ownerChannel: (c: Context) => boolean;
  /** Whether the request carries `alias`'s user channel token (USER_CHANNEL_HEADER). */
  userChannel: (c: Context, alias: string) => boolean;
}

const SOURCES: readonly BoardTaskSource[] = ["job", "ticket", "backlog"];
/** The most paths a filter or probe takes. */
const MAX_PATHS = 200;
/** The most owners whose conflict maps are cached at once. */
const MAX_CACHED_OWNERS = 64;
/** How many closed tasks a read returns by default, and at most. */
export const DEFAULT_BOARD_CLOSED_LIMIT = 200;
export const MAX_BOARD_CLOSED_LIMIT = 500;

/** A comma-separated query parameter as its trimmed, non-empty entries. */
function listParam(c: Context, name: string): string[] {
  return (c.req.query(name) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_PATHS);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, MAX_PATHS);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * A time as the board stores it (UTC ISO with milliseconds), so a cursor
 * written with an offset or without milliseconds compares correctly; undefined
 * when it can't be read as a time.
 */
function isoTime(raw: string): string | undefined {
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/**
 * The Board API: the console's reads of the signed-in user's task cards
 * (their own and the team-wide ones), each with the open tasks it may
 * collide with, and a conflict check for work about to start. An identified
 * caller is a person at the console: the owner channel, or a teammate's own
 * user channel token for the alias the request identifies — never a Persona
 * credential. A reader who can't be identified still reads the team-wide
 * tasks (which every socket is sent anyway), scoped "team".
 *
 * `GET /api/board/tasks` answers `{tasks, scope, closedMore}`: every open
 * task and the `closedLimit` (default 200, at most 500) most recent closed
 * ones. With `closedBefore=<ISO updatedAt>&closedBeforeId=<task id>` — the
 * previous page's last task — it answers `{tasks, scope, more}`: only the
 * closed tasks past that cursor (updated before it, or at it with a lower
 * id), in the board's order `updatedAt` then id, both descending, at most
 * `closedLimit`, filtered as the list is — the next page. Without
 * `closedBeforeId`, only the tasks updated strictly before `closedBefore`.
 * A page also carries `nextClosedBefore` and `nextClosedBeforeId`, the cursor
 * for the page after it (its last task, or the request's cursor when it holds
 * none), so a filtered page that matched nothing still says where to go on.
 * With `open=1` a page is empty: it holds only closed tasks. The list also
 * carries `version`, the reader's board version (Board.viewerVersion) when
 * the read began.
 *
 * `GET /api/board/version` answers `{version}`: that token alone, for the
 * same reader the list would serve (an unidentified one gets the team-wide
 * token), read in constant time. The console polls it under the live socket
 * and re-reads the list when it differs from the last list's, so a
 * `board:task` frame the socket lost (they are addressed and unsequenced,
 * never replayed) still shows. It moves only with frames that reader is
 * sent, and carries the board's boot id, so a restart always changes it.
 */
export function mountBoardRoutes(app: Hono, opts: BoardRoutesOptions): void {
  const { board } = opts;

  const personaRefusal = (c: Context, what: string): Response | null =>
    c.req.header(PERSONA_TOKEN_HEADER) || c.req.header(PERSONA_WRITER_HEADER)
      ? c.json({ error: `Persona's token cannot be used to ${what}` }, 403)
      : null;

  /** The identified person making the request, or undefined when they can't be identified. */
  const identified = (c: Context): string | undefined => {
    const alias = opts.identityOf(c);
    if (!alias || alias === ANONYMOUS_ALIAS) return undefined;
    return opts.ownerChannel(c) || opts.userChannel(c, alias) ? alias : undefined;
  };

  /** The person reading the board, or the refusal. */
  const callerOf = (c: Context, what: string): { alias: string } | Response => {
    const refused = personaRefusal(c, what);
    if (refused) return refused;
    const alias = opts.identityOf(c);
    if (!opts.ownerChannel(c) && !(alias && alias !== ANONYMOUS_ALIAS && opts.userChannel(c, alias))) {
      return c.json({ error: `Only a person can ${what}: use the Standup console.` }, 403);
    }
    if (!alias || alias === ANONYMOUS_ALIAS) return c.json({ error: `An identified user is required to ${what}` }, 403);
    return { alias };
  };

  /** Each owner's conflict map ("" for the team-wide tasks alone), kept until the board next changes. */
  const conflictCache = new Map<string, { version: number; map: Map<string, BoardConflict[]> }>();
  const conflictMapFor = (owner: string): Map<string, BoardConflict[]> => {
    const version = board.version();
    const cached = conflictCache.get(owner);
    if (cached && cached.version === version) return cached.map;
    const map = boardConflictMap(board.list({ owner, includeClosed: false }).tasks);
    conflictCache.delete(owner);
    conflictCache.set(owner, { version, map });
    while (conflictCache.size > MAX_CACHED_OWNERS) conflictCache.delete(conflictCache.keys().next().value!);
    return map;
  };

  app.get("/api/board/tasks", (c) => {
    const refused = personaRefusal(c, "read the board");
    if (refused) return refused;
    const alias = identified(c);
    const owner = alias ?? "";
    const scope = alias ? "user" : "team";
    const status = listParam(c, "status").filter((s): s is BoardStatus => (BOARD_STATUSES as readonly string[]).includes(s));
    const source = listParam(c, "source").filter((s): s is BoardTaskSource => SOURCES.includes(s as BoardTaskSource));
    const open = c.req.query("open");
    const rawLimit = c.req.query("closedLimit");
    let closedLimit = DEFAULT_BOARD_CLOSED_LIMIT;
    if (rawLimit !== undefined && rawLimit.trim() !== "") {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 0) return c.json({ error: "closedLimit must be a whole number" }, 400);
      closedLimit = Math.min(n, MAX_BOARD_CLOSED_LIMIT);
    }
    const rawBefore = c.req.query("closedBefore")?.trim();
    let closedBefore: string | undefined;
    if (rawBefore) {
      closedBefore = isoTime(rawBefore);
      if (closedBefore === undefined) return c.json({ error: "closedBefore must be an ISO time" }, 400);
    }
    const closedBeforeId = closedBefore ? c.req.query("closedBeforeId")?.trim() || undefined : undefined;
    // Read before the list, so a change landing during the read leaves the console's next version check differing.
    const version = board.viewerVersion(owner);
    const { tasks, closedMore } = board.list({
      owner,
      status,
      source,
      projectId: c.req.query("project")?.trim() || undefined,
      text: c.req.query("q")?.trim() || undefined,
      files: listParam(c, "files"),
      includeClosed: open === "1" || open === "true" ? false : undefined,
      closedLimit,
      ...(closedBefore ? { closedBefore } : {}),
      ...(closedBeforeId ? { closedBeforeId } : {}),
    });
    if (closedBefore) {
      // The read walks every older closed row until a page of matches or the end,
      // so the last task served is where the next page starts; with none, the cursor stands.
      const last = tasks.at(-1);
      const next = last ? { before: last.updatedAt, beforeId: last.id } : { before: closedBefore, beforeId: closedBeforeId };
      return c.json({
        tasks,
        scope,
        more: closedMore,
        nextClosedBefore: next.before,
        ...(next.beforeId ? { nextClosedBeforeId: next.beforeId } : {}),
      });
    }
    // Conflicts are judged against every open task on the board, filtered or not.
    const conflicts = conflictMapFor(owner);
    const served: BoardTaskWithConflicts[] = tasks.map((task) => {
      const found = isOpenBoardStatus(task.status) ? conflicts.get(task.id) : undefined;
      return found ? { ...task, conflicts: found } : task;
    });
    return c.json({ tasks: served, scope, closedMore, version });
  });

  app.get("/api/board/version", (c) => {
    const refused = personaRefusal(c, "read the board");
    if (refused) return refused;
    return c.json({ version: board.viewerVersion(identified(c) ?? "") });
  });

  app.post("/api/board/conflicts", async (c) => {
    const caller = callerOf(c, "check the board for conflicts");
    if (caller instanceof Response) return caller;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "malformed request body" }, 400);
    const probe: BoardConflictProbe = {
      projectId: optionalString(body.projectId),
      title: optionalString(body.title),
      goal: optionalString(body.goal),
      files: stringList(body.files),
      packages: stringList(body.packages),
      excludeTaskId: optionalString(body.excludeTaskId),
      excludeJobId: optionalString(body.excludeJobId),
    };
    return c.json({ conflicts: board.conflicts(caller.alias, probe) });
  });
}
