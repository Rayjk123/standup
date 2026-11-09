import type { Database } from "bun:sqlite";
import type { Ask, AskKind, AskStatus } from "@standup/shared";
import { randomUUID } from "crypto";

interface AskRow {
  id: string;
  session_id: string;
  kind: AskKind;
  question: string;
  options_json: string | null;
  answer: string | null;
  status: AskStatus;
  created_at: string;
  resolved_at: string | null;
  gate?: string | null;
  request_id?: string | null;
  answered_by?: string | null;
}

function toAsk(row: AskRow): Ask {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    question: row.question,
    options: row.options_json ? JSON.parse(row.options_json) : undefined,
    answer: row.answer ?? undefined,
    status: row.status,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
    ...(row.gate ? { gate: row.gate } : {}),
    ...(row.answered_by ? { answeredBy: row.answered_by } : {}),
  };
}

/**
 * Persists a pending ask. `opts.gate` marks an ask a server-side confirmation
 * gate raised (see `Ask.gate`) so a delegate allowed to answer ordinary asks
 * can tell it apart.
 */
export function createAsk(
  db: Database,
  sessionId: string,
  kind: AskKind,
  question: string,
  options?: string[],
  opts: { gate?: string; requestId?: string; callHash?: string; floorExpiresAt?: Date } = {}
): Ask {
  const id = randomUUID();
  const gate = opts.gate?.trim() || undefined;
  const requestId = opts.requestId?.trim() || null;

  db.run(
    "INSERT INTO asks (id, session_id, kind, question, options_json, gate, request_id, call_hash, floor_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      sessionId,
      kind,
      question,
      options ? JSON.stringify(options) : null,
      gate ?? null,
      requestId,
      opts.callHash ?? null,
      opts.floorExpiresAt ? opts.floorExpiresAt.toISOString() : null,
    ]
  );

  return {
    id,
    sessionId,
    kind,
    question,
    options,
    status: "pending",
    createdAt: new Date(),
    ...(gate ? { gate } : {}),
  };
}

/**
 * The ask a session raised for `requestId` (see createAsk's `opts.requestId`),
 * whatever its status: a waiter re-attaching after its connection dropped
 * waits on it again, or reads the answer it already has.
 */
export function getAskByRequestId(db: Database, sessionId: string, requestId: string): Ask | null {
  const row = db
    .query("SELECT * FROM asks WHERE session_id = ? AND request_id = ? LIMIT 1")
    .get(sessionId, requestId) as AskRow | null;
  return row ? toAsk(row) : null;
}

/** The safety floor's bookkeeping on one of its asks (see createAsk's `callHash` / `floorExpiresAt`). */
export interface FloorAskState {
  /** Hash of the tool call the hold was raised for, or null for an ask raised without one. */
  callHash: string | null;
  /** When the hold's waiter gives up, or null when unknown. */
  expiresAt: Date | null;
  /** When an allow of it was handed to the hook, or null when none was. */
  deliveredAt: Date | null;
  /** The raiser's request id: a hook's tool-use id, or `criterion:…` for an acceptance criterion's hold. */
  requestId: string | null;
}

export function getFloorAskState(db: Database, askId: string): FloorAskState | null {
  const row = db
    .query("SELECT call_hash, floor_expires_at, floor_delivered_at, request_id FROM asks WHERE id = ?")
    .get(askId) as {
    call_hash: string | null;
    floor_expires_at: string | null;
    floor_delivered_at: string | null;
    request_id: string | null;
  } | null;
  if (!row) return null;
  return {
    callHash: row.call_hash,
    expiresAt: row.floor_expires_at ? new Date(row.floor_expires_at) : null,
    deliveredAt: row.floor_delivered_at ? new Date(row.floor_delivered_at) : null,
    requestId: row.request_id,
  };
}

/**
 * Marks a floor ask's allow as handed to the hook. True for exactly one
 * caller: the first; every later claim (a re-attach, a concurrent waiter)
 * gets false, so one allow runs the call at most once.
 */
export function claimFloorAllowDelivery(db: Database, askId: string, now: Date = new Date()): boolean {
  const result = db.run(
    "UPDATE asks SET floor_delivered_at = ? WHERE id = ? AND floor_delivered_at IS NULL",
    [now.toISOString(), askId]
  );
  return result.changes === 1;
}

/**
 * Times out every pending ask carrying one of `gates` whose waiter's deadline
 * has passed — or that records none — as of `now`. Run on collector start: a
 * hold whose hook gave up while the collector was down must not stay pending,
 * where a late allow could still be read by a re-attach. Returns the ids.
 */
export function timeoutExpiredGatedAsks(db: Database, gates: string[], now: Date = new Date()): string[] {
  if (gates.length === 0) return [];
  const placeholders = gates.map(() => "?").join(", ");
  const rows = db
    .query(
      `UPDATE asks
         SET status = 'timeout', resolved_at = datetime('now')
       WHERE status = 'pending' AND gate IN (${placeholders})
         AND (floor_expires_at IS NULL OR floor_expires_at <= ?)
       RETURNING id`
    )
    .all(...gates, now.toISOString()) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Times out every pending `ask_human` raised without a request id before
 * `startedAt` (the booting collector's start). Its waiter was a call into the
 * collector that stopped, and with no request id the call it re-sends can't
 * re-attach: left pending, the ask would linger beside the duplicate the
 * re-sent call raises. Returns the ids.
 */
export function timeoutOrphanedAsks(db: Database, startedAt: Date): string[] {
  const rows = db
    .query(
      `UPDATE asks
         SET status = 'timeout', resolved_at = datetime('now')
       WHERE status = 'pending' AND kind = 'ask_human' AND request_id IS NULL
         AND julianday(created_at) < julianday(?)
       RETURNING id`
    )
    .all(startedAt.toISOString()) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Records `answer` on an ask; `answeredBy` is the alias that decided it, kept for the audit. */
export function resolveAsk(
  db: Database,
  askId: string,
  answer: string,
  answeredBy?: string
): void {
  db.run(
    "UPDATE asks SET answer = ?, status = 'answered', resolved_at = datetime('now'), answered_by = ? WHERE id = ?",
    [answer, answeredBy?.trim() || null, askId]
  );
}

export function timeoutAsk(db: Database, askId: string): void {
  db.run(
    "UPDATE asks SET status = 'timeout', resolved_at = datetime('now') WHERE id = ?",
    [askId]
  );
}

/** Answers `askId` only while it is still pending; true when it did. */
export function resolvePendingAsk(db: Database, askId: string, answer: string, answeredBy?: string): boolean {
  const result = db.run(
    "UPDATE asks SET answer = ?, status = 'answered', resolved_at = datetime('now'), answered_by = ? WHERE id = ? AND status = 'pending'",
    [answer, answeredBy?.trim() || null, askId]
  );
  return result.changes === 1;
}

/**
 * Puts an ask that `answeredBy` claimed with resolvePendingAsk back to
 * pending, clearing the answer, for when what the claim was for did not
 * happen. Only that claim is undone: an ask since answered by someone else,
 * cancelled or timed out is left as it is. True when it reopened the ask.
 */
export function reopenClaimedAsk(db: Database, askId: string, answeredBy: string): boolean {
  const result = db.run(
    "UPDATE asks SET answer = NULL, status = 'pending', resolved_at = NULL, answered_by = NULL WHERE id = ? AND status = 'answered' AND answered_by = ?",
    [askId, answeredBy.trim()]
  );
  return result.changes === 1;
}

/**
 * Asks this process has claimed with claimPendingAsk and not yet released:
 * marked answered while the answer is still being carried out, so they can
 * still go back to pending. Kept in memory because a claim lives only as long
 * as the request holding it.
 */
const claimedAskIds = new Set<string>();

/**
 * Claims `askId` for `answeredBy`: answers it only while it is still pending
 * (resolvePendingAsk) and holds it as claimed until releaseAskClaim. While
 * held it still counts as surfaced (getSurfacedAsksBySession) and is still
 * cleaned up (cancelPromptAsks). True when it claimed the ask.
 */
export function claimPendingAsk(db: Database, askId: string, answer: string, answeredBy: string): boolean {
  if (!resolvePendingAsk(db, askId, answer, answeredBy)) return false;
  claimedAskIds.add(askId);
  return true;
}

/** Ends the claim claimPendingAsk took on `askId`, whatever the ask's status now. */
export function releaseAskClaim(askId: string): void {
  claimedAskIds.delete(askId);
}

/** The ids held as claimed that are still answered, as SQL placeholders and values. */
function claimedClause(): { sql: string; ids: string[] } {
  const ids = [...claimedAskIds];
  if (ids.length === 0) return { sql: "", ids };
  return { sql: ` OR (status = 'answered' AND id IN (${ids.map(() => "?").join(", ")}))`, ids };
}

/**
 * A session's asks that stand for a block someone still has to answer: the
 * pending ones and the ones held as claimed (claimPendingAsk), oldest first.
 */
export function getSurfacedAsksBySession(db: Database, sessionId: string): Ask[] {
  const claimed = claimedClause();
  const rows = db
    .query(`SELECT * FROM asks WHERE session_id = ? AND (status = 'pending'${claimed.sql}) ORDER BY created_at ASC`)
    .all(sessionId, ...claimed.ids) as AskRow[];
  return rows.map(toAsk);
}

/** Times out `askId` only while it is still pending; true when it did. */
export function timeoutPendingAsk(db: Database, askId: string): boolean {
  const result = db.run(
    "UPDATE asks SET status = 'timeout', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'",
    [askId]
  );
  return result.changes === 1;
}

export function cancelAsk(db: Database, askId: string): void {
  db.run(
    "UPDATE asks SET status = 'cancelled', resolved_at = datetime('now') WHERE id = ?",
    [askId]
  );
}

export function getAsk(db: Database, askId: string): Ask | null {
  const row = db.query("SELECT * FROM asks WHERE id = ?").get(askId) as AskRow | null;
  return row ? toAsk(row) : null;
}

/**
 * Cancels pending prompt-asks for a session and returns what was cancelled.
 *
 * These are raised from Notification hooks rather than a blocking tool call,
 * so nothing resolves them when the human answers in the terminal directly.
 * Any sign of the session moving again means they're stale. Deliberately
 * scoped to `permission_prompt` — an `ask_human` has a real waiter and must
 * never be cancelled out from under it.
 */
/**
 * Cancels every pending ask for a session, `ask_human` included.
 *
 * `cancelPromptAsks` deliberately excludes `ask_human` because it has a real
 * waiter (an MCP tool call long-polling for the answer) that must not be
 * cancelled out from under a session that's still running. This function is
 * for the opposite case: the session itself is gone — stopped or deleted —
 * so nothing can ever resolve that waiter anyway. Left pending, an ask like
 * this outlives the session and sits in Blocked forever with no session to
 * answer.
 */
export function cancelAllPendingAsks(db: Database, sessionId: string): Ask[] {
  const stale = db
    .query(
      `UPDATE asks
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE session_id = ? AND status = 'pending'
       RETURNING id, session_id, kind, question, options_json, answer, status,
                 created_at, resolved_at, gate, answered_by`
    )
    .all(sessionId) as AskRow[];

  return stale.map(toAsk);
}

/**
 * Cancels pending asks in bulk — the "Clear all" action in the "Needs you"
 * feed, for when the human wants to stop tracking their backlog rather than
 * answer each one. Same terminal state a single dismiss uses ('cancelled'), so
 * a still-running session's own retry/re-ask path is unaffected: an agent that
 * blocks again simply creates a new pending ask. Returns the cancelled ids so
 * the caller can broadcast a resolve per row.
 *
 * `ids` scopes the sweep to a specific set (the caller's own responsible asks),
 * so clearing one user's queue never ends a teammate's wait; only rows still
 * pending are touched. Omit `ids` to clear every pending ask across all
 * sessions.
 */
export function dismissAllPendingAsks(db: Database, ids?: string[]): string[] {
  if (ids !== undefined) {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .query(
        `UPDATE asks
           SET status = 'cancelled', resolved_at = datetime('now')
         WHERE status = 'pending' AND id IN (${placeholders})
         RETURNING id`
      )
      .all(...ids) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  const rows = db
    .query(
      `UPDATE asks
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE status = 'pending'
       RETURNING id`
    )
    .all() as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/**
 * The request-id prefix of a permission ask tied to one tool call:
 * `permission:<tool_use_id>`, or `permission:<tool_use_id>#<n>` for the n-th
 * later ask about the same call. Reserved: an ask_human may not use it.
 */
export const PERMISSION_REQUEST_PREFIX = "permission:";

/** The request id of the `n`-th permission ask tied to the call `toolUseId` (n = 0 for the first). */
export function permissionAskRequestId(toolUseId: string, n = 0): string {
  return `${PERMISSION_REQUEST_PREFIX}${toolUseId}${n > 0 ? `#${n}` : ""}`;
}

/** The tool_use_id a permission ask was raised for, or null when it names no call. */
export function getPermissionAskToolUseId(db: Database, askId: string): string | null {
  const row = db.query("SELECT kind, request_id FROM asks WHERE id = ?").get(askId) as
    | { kind: string; request_id: string | null }
    | null;
  if (row?.kind !== "permission_prompt" || !row.request_id?.startsWith(PERMISSION_REQUEST_PREFIX)) return null;
  return row.request_id.slice(PERMISSION_REQUEST_PREFIX.length).replace(/#\d+$/, "") || null;
}

/**
 * The request-id prefix of a permission ask tied to no one call, which
 * records the calls its dialog could be for:
 * `permission-any:<tool_use_id>,<tool_use_id>…`, `#<n>` for later ones.
 * Reserved like PERMISSION_REQUEST_PREFIX.
 */
export const PERMISSION_ANY_REQUEST_PREFIX = "permission-any:";

/** The request id of the `n`-th permission ask whose dialog could be any of `toolUseIds`. */
export function permissionCandidatesRequestId(toolUseIds: string[], n = 0): string {
  return `${PERMISSION_ANY_REQUEST_PREFIX}${[...toolUseIds].sort().join(",")}${n > 0 ? `#${n}` : ""}`;
}

/** The calls a permission ask tied to no one call recorded as candidates, or null when it recorded none. */
export function getPermissionAskCandidateIds(db: Database, askId: string): string[] | null {
  const row = db.query("SELECT kind, request_id FROM asks WHERE id = ?").get(askId) as
    | { kind: string; request_id: string | null }
    | null;
  if (row?.kind !== "permission_prompt" || !row.request_id?.startsWith(PERMISSION_ANY_REQUEST_PREFIX)) return null;
  const ids = row.request_id.slice(PERMISSION_ANY_REQUEST_PREFIX.length).replace(/#\d+$/, "").split(",").filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/** How many asks, of any status, a session has raised with request id `base` or `base#<n>`. */
export function countAsksWithRequestBase(db: Database, sessionId: string, base: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM asks
        WHERE session_id = ? AND (request_id = ? OR substr(request_id, 1, ?) = ?)`
    )
    .get(sessionId, base, base.length + 1, `${base}#`) as { n: number };
  return row.n;
}

export function cancelPromptAsks(db: Database, sessionId: string): Ask[] {
  const claimed = claimedClause();
  const stale = db
    .query(
      `UPDATE asks
         SET status = 'cancelled', resolved_at = datetime('now')
       WHERE session_id = ? AND (status = 'pending'${claimed.sql}) AND kind = 'permission_prompt'
       RETURNING id, session_id, kind, question, options_json, answer, status,
                 created_at, resolved_at, gate, answered_by`
    )
    .all(sessionId, ...claimed.ids) as AskRow[];

  return stale.map(toAsk);
}

/**
 * Asks resolved (answered / timed out / cancelled) at or after `sinceIso`, most
 * recent first — the windowed set the daily digest gathers. Scoped to rows that
 * actually carry a `resolved_at` in the window so a still-pending ask is never
 * counted as resolved work.
 */
export function getRecentResolvedAsks(
  db: Database,
  sinceIso: string,
  limit = 200
): Ask[] {
  const rows = db
    .query(
      `SELECT * FROM asks
         WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at >= ?
         ORDER BY resolved_at DESC LIMIT ?`
    )
    .all(sinceIso, limit) as AskRow[];

  return rows.map(toAsk);
}

export function getPendingAsks(db: Database): Ask[] {
  const rows = db
    .query("SELECT * FROM asks WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as AskRow[];

  return rows.map(toAsk);
}

export function getPendingAsksBySession(
  db: Database,
  sessionId: string
): Ask[] {
  const rows = db
    .query(
      "SELECT * FROM asks WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC"
    )
    .all(sessionId) as AskRow[];

  return rows.map(toAsk);
}
