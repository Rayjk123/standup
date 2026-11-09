/**
 * Detects status-report markers in a knowledge proposal. A knowledge doc holds
 * durable facts; a review or ticket id, a "merged <sha>", a "DEPLOYED" or a
 * dated parenthetical marks a progress note that goes stale the day it is
 * written.
 *
 * A title carrying one is refused, since the title is what every search result
 * shows. A body carrying two or more is refused too; a body with a single one
 * is only warned about, as a durable doc may still cite a review or a date in
 * passing.
 */

import { activeOrgProfile } from "./org-profile/load.js";

/**
 * A review or ticket id: an uppercase key, `-` and six or more digits (e.g.
 * `REV-1234567`), or a pull request number of three or more digits (`PR #482`).
 */
const REVIEW_ID = /\b(?:[A-Z][A-Z0-9]{1,9}-\d{6,}\b|PR ?#\d{3,}\b)/g;
/** "merged" or "in review", which mark status only beside a SHA or review id. */
const MERGE_STATE = /\b(?:merged|in review)\b/i;
/** A commit SHA: 7 to 40 lowercase hex characters with at least one digit and one letter. */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
/** A review id, or a pull request number of any length, as a merge-state companion. */
const ANY_REVIEW_ID = /\b(?:[A-Z][A-Z0-9]{1,9}-\d{6,}\b|PR ?#\d+\b)/;
let orgReviewIdCache: { source: string; re: RegExp | null } | null = null;

/**
 * The org profile's bare review id (codeReview.linkFormat.idPattern, read
 * case-insensitively as code-review links read it), which marks status beside
 * "merged" or "in review" at any length; null when the profile names none.
 */
function orgReviewId(): RegExp | null {
  const source = activeOrgProfile().codeReview.linkFormat.idPattern ?? "";
  if (orgReviewIdCache?.source !== source) {
    let re: RegExp | null = null;
    try {
      re = source ? new RegExp(source, "i") : null;
    } catch {
      re = null;
    }
    orgReviewIdCache = { source, re };
  }
  return orgReviewIdCache.re;
}

/** "DEPLOYED" in capitals; "Deployed" is an ordinary word. */
const DEPLOYED = /\bDEPLOYED\b/g;
/** Live-validation claims, in any case. */
const VALIDATION_CLAIM = /\b(?:live-validated|validated live)\b/gi;
/** "all tests pass", which marks status only beside a SHA or review id. */
const ALL_TESTS_PASS = /\ball tests pass(?:ed|ing)?\b/i;
/**
 * A parenthetical holding an ISO date, e.g. "(2026-10-06)" or "(proposed
 * 2026-10-06)", with at most 80 characters either side of the date so the scan
 * stays linear in the line's length.
 */
const DATED_PARENTHETICAL = /\(([^()\n]{0,80}?)\b(\d{4}-\d{2}-\d{2})\b([^()\n]{0,80})\)/g;
/** Words that make a dated parenthetical a status note whatever its date. */
const DATED_STATUS_WORD = /\b(?:proposed|merged|deployed|validated|as of|updated|done)\b/i;
/**
 * How far back a bare date in parentheses still reads as a status stamp. An
 * older one is a version identifier, e.g. an AWS API version such as
 * "(2012-10-17)" or "S3 API (2006-03-01)".
 */
const RECENT_DATE_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;
/** The longest stretch of a line scanned for markers; the rest is ignored. */
const MAX_SCANNED_LINE = 2_000;

/** Least number of markers in a body that refuses the proposal; fewer (but any) draw a warning. */
export const BODY_STATUS_MARKER_THRESHOLD = 2;

/**
 * Whether a dated parenthetical reads as a status stamp: it carries a status
 * word (DATED_STATUS_WORD), or its date is no more than two years before `now`
 * (a later date included).
 */
function isStatusDate(inner: string, date: string, now: Date): boolean {
  if (DATED_STATUS_WORD.test(inner)) return true;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && now.getTime() - at <= RECENT_DATE_WINDOW_MS;
}

/** Every status marker in one line of text, in order of kind. */
export function statusMarkers(line: string, now: Date = new Date()): string[] {
  const text = line.length > MAX_SCANNED_LINE ? line.slice(0, MAX_SCANNED_LINE) : line;
  const found: string[] = [];
  for (const re of [REVIEW_ID, DEPLOYED, VALIDATION_CLAIM]) {
    for (const m of text.matchAll(re)) found.push(m[0]);
  }
  for (const m of text.matchAll(DATED_PARENTHETICAL)) {
    if (isStatusDate(`${m[1]} ${m[3]}`, m[2]!, now)) found.push(m[0]);
  }
  const orgId = orgReviewId();
  const beside = SHA.test(text) || ANY_REVIEW_ID.test(text) || (orgId?.test(text) ?? false);
  const passing = ALL_TESTS_PASS.exec(text);
  if (passing && beside) found.push(passing[0]);
  const state = MERGE_STATE.exec(text);
  if (state && beside) found.push(state[0]);
  return found;
}

/** The 400 error for a title that reads as a status note, or null when it doesn't. */
export function statusTitleRefusal(title: string, now: Date = new Date()): string | null {
  const markers = statusMarkers(title, now);
  if (markers.length === 0) return null;
  return (
    `title reads as a status note (${markers.map((m) => `"${m}"`).join(", ")}). Knowledge docs hold durable ` +
    "facts, not progress: drop review and ticket ids, SHAs, merge or deploy state, validation claims and dates from the title " +
    "and name the subject instead (e.g. \"Deploy order: CMK before IAM\"). Renaming the title is fine when " +
    "updating an existing doc: propose under its slug with the new title. If this was only a status report, " +
    "don't propose it."
  );
}

function bodyMarkers(body: string, now: Date): string[] {
  return body.split("\n").flatMap((line) => statusMarkers(line, now));
}

function shownMarkers(markers: readonly string[]): string {
  return [...new Set(markers)].slice(0, 5).map((m) => `"${m}"`).join(", ");
}

/** The 400 error for a body carrying {@link BODY_STATUS_MARKER_THRESHOLD} or more status markers, or null. */
export function statusBodyRefusal(body: string, now: Date = new Date()): string | null {
  const markers = bodyMarkers(body, now);
  if (markers.length < BODY_STATUS_MARKER_THRESHOLD) return null;
  return (
    `the body reads as a status report: it carries ${markers.length} status markers (${shownMarkers(markers)}). ` +
    "Knowledge docs hold durable facts, not progress: remove review and ticket ids, merge or deploy state, validation claims and " +
    "dated notes and propose again. If this was only a status report, don't propose it."
  );
}

/** A warning for a body carrying a single status marker, or null (none, or enough to refuse). */
export function statusBodyWarning(body: string, now: Date = new Date()): string | null {
  const markers = bodyMarkers(body, now);
  if (markers.length === 0 || markers.length >= BODY_STATUS_MARKER_THRESHOLD) return null;
  return (
    `the body carries a status marker (${shownMarkers(markers)}); a knowledge doc should state durable facts. ` +
    "Consider removing it and re-proposing under the same slug."
  );
}
