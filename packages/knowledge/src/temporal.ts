/**
 * Validity intervals of knowledge docs.
 *
 * Every doc carries `valid_from` (when its claim became current), `valid_to`
 * (when it stopped being current; absent = current) and `superseded_by` (the
 * `project/slug` of the doc that replaced it). A doc stops being current in two
 * ways:
 *
 * - A supersede: the contradiction resolver, the coherence pass's supersedes
 *   outcome or the mirror collapse sets its verdict to "superseded" with a
 *   "Superseded by X" tombstone dispute. The knowledge table's
 *   `knowledge_supersede_validity` trigger closes the row at that moment, so
 *   every writer of the verdict closes it without calling anything.
 * - A replacing accept: the prior body is copied to
 *   `<project>/.history/<slug>.<stamp>.md` with `valid_to` = the accept time and
 *   `superseded_by` = the doc itself, and the new body is written with
 *   `valid_from` = the accept time. History files are indexed in their own
 *   table and reached only by an `asOf` search.
 *
 * Instants are compared as ISO-8601 UTC strings (toISOString's format), which
 * order lexicographically; normalizeInstant brings hand-written dates there.
 */

/** Subdirectory of a project's knowledge dir holding closed doc versions. */
export const HISTORY_SUBDIR = ".history";

/** The tag a retired Persona memory carries; it closes the doc like a supersede. */
export const SUPERSEDED_TAG = "superseded";

/** The claim prefix of the tombstone dispute a supersede stamps, naming the winner. */
export const SUPERSEDED_BY_PREFIX = "Superseded by ";

/** An ISO-8601 UTC instant for a date-ish value, or undefined when absent or unparseable. */
export function normalizeInstant(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Parses a caller's `asOf` into an ISO instant. Undefined/empty means "now"
 * (undefined is returned); anything that does not parse is an error the caller
 * reports, never silently read as "now".
 */
export function parseAsOf(value: unknown): { ok: true; asOf: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, asOf: undefined };
  const asOf = typeof value === "string" ? normalizeInstant(value.trim()) : undefined;
  if (!asOf) return { ok: false, error: "as_of must be an ISO-8601 date or timestamp" };
  return { ok: true, asOf };
}

/** Whether an interval has closed by `at` (valid_to set and not after it). */
export function isClosedAt(validTo: string | null | undefined, at: string): boolean {
  return !!validTo && validTo <= at;
}

/**
 * Whether an interval covers `at`: began at or before it (an unknown start is
 * open-ended) and had not closed by it.
 */
export function isValidAt(
  interval: { validFrom?: string | null; validTo?: string | null },
  at: string
): boolean {
  if (interval.validFrom && interval.validFrom > at) return false;
  return !isClosedAt(interval.validTo, at);
}

/**
 * The `project/slug` a supersede tombstone names, read off the first
 * "Superseded by X" dispute; a bare slug is taken to live in `projectId`.
 */
export function supersededByFromDisputes(
  projectId: string,
  disputes: ReadonlyArray<{ claim?: unknown }> | null | undefined
): string | undefined {
  for (const d of disputes ?? []) {
    if (typeof d?.claim !== "string" || !d.claim.startsWith(SUPERSEDED_BY_PREFIX)) continue;
    const ref = d.claim.slice(SUPERSEDED_BY_PREFIX.length).trim().split(/\s/)[0];
    if (!ref) continue;
    return ref.includes("/") ? ref : `${projectId}/${ref}`;
  }
  return undefined;
}

/**
 * The file-name stamp of a history version: its valid_from with the
 * characters a file name should not carry (`:` and `.`) replaced, so
 * `<slug>.<stamp>.md` sorts by time.
 */
export function historyStamp(validFrom: string): string {
  return validFrom.replace(/[:.]/g, "-");
}

/** The slug a history file name `<slug>.<stamp>.md` belongs to. */
export function historySlugOf(fileName: string): string {
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const dot = base.indexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}
