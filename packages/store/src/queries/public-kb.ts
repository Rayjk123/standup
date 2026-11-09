import type { Database } from "bun:sqlite";

/** Longest query text a logged call keeps. */
export const PUBLIC_KB_QUERY_MAX = 200;

/** How many calls the log keeps; older rows are pruned as new ones arrive. */
export const PUBLIC_KB_CALLS_KEPT = 5000;

/** One request to the public knowledge API, as logged. */
export interface PublicKbCall {
  /** ISO-8601 time the request was answered. */
  at: string;
  /** The caller's tunnel alias; null when the request carried none. */
  alias: string | null;
  endpoint: string;
  /** The question, search text or doc reference, truncated to PUBLIC_KB_QUERY_MAX. */
  query: string | null;
  status: number;
}

/**
 * C0 and C1 controls, DEL, the bidi embedding/override/isolate controls
 * (U+202A-202E, U+2066-2069) and marks (U+200E/200F, U+061C), the zero-width
 * characters (U+200B-200D, U+2060, U+FEFF), and the line and paragraph
 * separators (U+2028/2029).
 */
const LOG_UNSAFE_CHARS = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff]", "g");

/** What each unsafe character is shown as. */
const REPLACEMENT_CHAR = String.fromCodePoint(0xfffd);

/**
 * `text` made safe to show in the owner's call log: every control or bidi
 * character replaced with U+FFFD (so a caller can't forge line breaks or
 * reorder what the owner reads), cut to PUBLIC_KB_QUERY_MAX characters, with a
 * high surrogate the cut left unpaired dropped.
 */
export function sanitizeLogField(text: string): string {
  const cut = text.replace(LOG_UNSAFE_CHARS, REPLACEMENT_CHAR).slice(0, PUBLIC_KB_QUERY_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Logs one public knowledge API request and prunes the log to its newest
 * PUBLIC_KB_CALLS_KEPT rows. The alias, endpoint and query text are sanitized
 * and truncated here (sanitizeLogField), so no caller can store more than
 * PUBLIC_KB_QUERY_MAX characters of any of them, or a control character.
 */
export function recordPublicKbCall(
  db: Database,
  call: { alias: string | null; endpoint: string; query?: string | null; status: number; at?: string }
): void {
  const query = call.query ? sanitizeLogField(call.query) : null;
  const alias = call.alias === null ? null : sanitizeLogField(call.alias);
  const result = db.run(
    "INSERT INTO public_kb_calls (at, alias, endpoint, query, status) VALUES (?, ?, ?, ?, ?)",
    [call.at ?? new Date().toISOString(), alias, sanitizeLogField(call.endpoint), query, call.status]
  );
  const id = Number(result.lastInsertRowid);
  if (id > PUBLIC_KB_CALLS_KEPT) {
    db.run("DELETE FROM public_kb_calls WHERE id <= ?", [id - PUBLIC_KB_CALLS_KEPT]);
  }
}

/** The newest `limit` logged calls, newest first. */
export function listPublicKbCalls(db: Database, limit = 100): PublicKbCall[] {
  const n = Math.max(1, Math.min(PUBLIC_KB_CALLS_KEPT, Math.floor(limit)));
  return db
    .query("SELECT at, alias, endpoint, query, status FROM public_kb_calls ORDER BY id DESC LIMIT ?")
    .all(n) as PublicKbCall[];
}
