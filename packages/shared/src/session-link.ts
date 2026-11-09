// Short, shareable session addresses. A session id is a long uuid; the short
// address is its first `SHORT_SESSION_ID_LEN` characters, which is what Slack
// and the console already show as a session's handle. `/s/<shortId>` resolves
// back to the full `/work/s/<fullId>` route so a teammate can jump straight to
// a session from a Slack link or an MCP tool response. Pure (no I/O) so the
// resolver is trivially testable and usable on both client and server.

/** Length of the short id prefix — matches the handle shown in Slack/console. */
export const SHORT_SESSION_ID_LEN = 8;

/** The short handle for a session — the leading prefix of its full id. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, SHORT_SESSION_ID_LEN);
}

/** Path of the short, shareable session address (client route `/s/:shortId`). */
export function sessionSharePath(sessionId: string): string {
  return `/s/${shortSessionId(sessionId)}`;
}

/**
 * Absolute shareable URL for a session, given the console's web base URL
 * (e.g. `http://localhost:5173`). A trailing slash on `webBaseUrl` is trimmed
 * so the join never doubles up.
 */
export function sessionShareUrl(webBaseUrl: string, sessionId: string): string {
  const base = webBaseUrl.replace(/\/+$/, "");
  return `${base}${sessionSharePath(sessionId)}`;
}

/**
 * Resolve a short id back to a full session id against a set of known ids.
 * An exact id wins outright; otherwise the short id is treated as a prefix and
 * resolves only when it matches exactly one session (an ambiguous prefix is
 * left unresolved rather than guessing). Comparison is case-insensitive since
 * the id is copied from URLs and Slack. Returns undefined when nothing matches
 * or the match is ambiguous.
 */
export function resolveShortSessionId(
  shortId: string,
  sessionIds: readonly string[]
): string | undefined {
  const needle = shortId.trim().toLowerCase();
  if (!needle) return undefined;
  const exact = sessionIds.find((id) => id.toLowerCase() === needle);
  if (exact) return exact;
  const prefixed = sessionIds.filter((id) => id.toLowerCase().startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
