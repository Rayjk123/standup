import { createHash } from "crypto";

/**
 * Default confidence half-life in days — the span over which a doc's stored
 * confidence decays to half unless re-verified. A 90-day half-life resurfaces
 * a fact for re-verification about once a quarter.
 */
export const DEFAULT_HALF_LIFE_DAYS = 90;

/**
 * Confidence a freshly authored-and-verified doc starts at (full). Decay in
 * deriveConfidence erodes it from this baseline as `last_verified_at` ages past
 * the half-life; a re-verification pass (roadmap #5) resets it.
 */
export const INITIAL_CONFIDENCE = 1;

/**
 * Confidence decay for knowledge docs (roadmap r2 — the schema foundation the
 * self-iterating staleness work, roadmap #5, builds on).
 *
 * A doc stores a base `confidence` (0..1) as of `last_verified_at`, plus a
 * `half_life_days`. Current confidence is that base decayed by an exponential
 * half-life since it was last verified: after one half-life it is halved, after
 * two a quarter, and so on. The stored fields are the source of truth; the
 * current value is always DERIVED (never persisted) so it stays honest as time
 * passes without a write. Re-verifying a doc resets `last_verified_at`, which
 * lifts the derived value back to the base.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Minimum CURRENT confidence for a doc that HAS a confidence opinion to stay
 * eligible for automatic injection (roadmap r5's freshness gate). A doc whose
 * decayed confidence has fallen below this — a generated doc left un-reverified
 * past ~two half-lives, or one the re-verification pass wrote down to
 * DISPUTED_CONFIDENCE after refuting it — is still recalled by search for a
 * human to inspect, but is no longer fed to an agent as authoritative context
 * until a re-verification lifts it back. Env-tunable, the same discipline the
 * relevance floor and provenance weight follow: a number to measure, not a
 * belief to encode. Default 0.25 = the value a full-confidence doc decays to
 * after two default half-lives (180 days) with no re-verification.
 */
export const MIN_INJECTION_CONFIDENCE = (() => {
  const parsed = Number(process.env.KNOWLEDGE_MIN_INJECTION_CONFIDENCE);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.25;
})();

/**
 * Confidence the re-verification pass (roadmap r5) writes to a doc it just
 * DISPROVED against current code. Deliberately below MIN_INJECTION_CONFIDENCE
 * so a disputed doc drops straight out of the auto-injection gate rather than
 * lingering as trusted context, while staying non-zero (and searchable) so a
 * human still finds it and its recorded disputes. The pass also stamps
 * last_verified_at when it writes this, so the low value holds at the floor
 * rather than decaying further into indistinguishable noise.
 */
export const DISPUTED_CONFIDENCE = 0.1;

/** A finite env number accepted by `valid`, else `fallback`. */
function envNumber(name: string, fallback: number, valid: (n: number) => boolean): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && valid(parsed) ? parsed : fallback;
}

/**
 * Base confidence a doc that asserts none is held at — a hand-written owner doc,
 * a plan doc mirrored from a repo, a native-memory mirror. Below a freshly
 * verified doc (INITIAL_CONFIDENCE) because nothing has checked it, and well
 * above the injection floor so it takes about three default half-lives of no
 * re-verification before it stops being injected. Every doc decays from a
 * base: an unasserted one is not exempt from the clock because of who wrote it.
 * Env-tunable (KNOWLEDGE_DEFAULT_BASE_CONFIDENCE, 0 < x ≤ 1).
 */
export const DEFAULT_BASE_CONFIDENCE = envNumber(
  "KNOWLEDGE_DEFAULT_BASE_CONFIDENCE",
  0.9,
  (n) => n > 0 && n <= 1
);

/**
 * Half-life for status-like content (isStatusLike): phase tables, test counts,
 * "IN PROGRESS"/"QUEUED"/"not implemented", dated run logs. Such a doc records
 * where work stood on a day, and it is usually wrong within weeks, so it decays
 * on a short clock: a default-base status doc falls below the injection floor
 * about 26 days after it was last verified. Env-tunable
 * (KNOWLEDGE_STATUS_HALF_LIFE_DAYS, > 0).
 */
export const STATUS_HALF_LIFE_DAYS = envNumber("KNOWLEDGE_STATUS_HALF_LIFE_DAYS", 14, (n) => n > 0);

const STATUS_WORD =
  "(?:DONE|NOT STARTED|IN PROGRESS|IN-PROGRESS|QUEUED|SHIPPED|DEPLOYED|BLOCKED|PENDING|TODO|WIP|MERGED|LANDED|PARKED|COMPLETE|PARTIAL)";
const STATUS_TABLE_CELL = new RegExp(`\\|[ \\t]*(?:\\p{Extended_Pictographic}[ \\t]*)?${STATUS_WORD}\\b`, "u");
const PHASE_TABLE_ROW = /^\|[ \t]*(?:phase|step|milestone)[ \t]*\d/i;
const TEST_COUNT = /\b\d+[ \t]+(?:tests?[ \t]+)?(?:pass(?:ing|ed)?|green)\b|\b\d+[ \t]+fail(?:ing|ed|ures?)?\b/i;
/** An all-caps work state used as a marker: opening a line or list item, after a colon or table bar, or in parentheses. */
const CAPS_STATE = /^(?:[ \t]*(?:[-*]|\d+\.)?[ \t]*\**|.*?[:|(][ \t]*\**)(?:QUEUED|IN PROGRESS|NOT STARTED|DEPLOYED)\b/;
const PHASE_HEADING =
  /^#{1,6}[ \t]*(?:phase|step|milestone)[ \t]*\d+[^\n(]*\((?:done|in progress|planned|not started|deferred|blocked|shipped|complete)\b/i;
const DATED_ENTRY = /^(?:#{1,6}[ \t][^\n]*?|[ \t]*[-*][ \t]+\**)\b\d{4}-\d{2}-\d{2}\b/;
const NOT_DONE = /\bnot (?:yet )?(?:implemented|started|wired|merged|shipped|deployed|done)\b/i;
const NOT_YET = /\b(?:not|no|never)\b(?:[ \t]+[\w-]+){0,4}[ \t]+yet\b/i;
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]/;
/** Inline code on one line: an enum value or a log line quoted as code is not a status claim. */
const INLINE_CODE = /`[^`]*`/g;
/** A chain of states joined by arrows (`QUEUED → RUNNING → DONE`) describes a lifecycle, not where work stands. */
const STATE_CHAIN = /\b[A-Z][A-Z_]*(?:[ \t]?(?:→|->|=>)[ \t]?[A-Z][A-Z_/]*)+/g;
const DATED_CLAIM =
  /\b(?:validated|verified|deployed|shipped|merged|landed|checked) (?:on |against [^\n]{0,40} on )?\d{4}-\d{2}-\d{2}|\bjust (?:shipped|landed|merged|deployed)\b|\b(?:status )?as of (?:\*\*)?\d{4}-\d{2}-\d{2}|\bstatus as of\b/i;
/** Lines are read up to this many characters: a status marker is never that far into a line, and capping keeps every pattern linear. */
const MAX_LINE_CHARS = 2_000;
/** A body this long is a reference or analysis doc unless status markers are dense in it (see isStatusLike). */
const LONG_DOC_CHARS = 16_000;
/** In a long body, at least one line in this many characters must carry a status marker. */
const CHARS_PER_MARKER_LINE = 2_000;

/**
 * The body's prose lines: fenced code blocks dropped, each line capped at
 * MAX_LINE_CHARS, inline code and arrow-joined state chains blanked. One pass,
 * linear in the body's length.
 */
function proseLines(body: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of (body ?? "").split("\n")) {
    if (/^[ \t]*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    out.push(raw.slice(0, MAX_LINE_CHARS).replace(INLINE_CODE, " ").replace(STATE_CHAIN, " "));
  }
  return out;
}

/**
 * Which status markers a body carries. Strong markers are the shape of a status
 * report — a table of states, a test count, an all-caps work state, phase
 * headings marked done/in progress, a dated log of three or more entries, two or
 * more list items of things not done ("not implemented", "no … yet"). Weak
 * markers ("not implemented", "verified on <date>") also appear in ordinary
 * gotchas and decisions, so they only count alongside others. Code (inline or
 * fenced) and arrow-joined state chains are ignored: a reference doc that quotes
 * an enum or documents a `QUEUED → RUNNING` lifecycle is not reporting status.
 * Every pattern runs per line over capped lines, so the cost is linear in the
 * body.
 */
export function statusSignals(body: string): { strong: string[]; weak: string[]; markerLines: number } {
  const lines = proseLines(body);
  const strong: string[] = [];
  const weak: string[] = [];
  const count = (re: RegExp) => lines.reduce((n, l) => (re.test(l) ? n + 1 : n), 0);
  const any = (re: RegExp) => lines.some((l) => re.test(l));
  const rows = lines.map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (
    rows.filter((l) => STATUS_TABLE_CELL.test(l)).length >= 2 ||
    rows.filter((l) => PHASE_TABLE_ROW.test(l)).length >= 2
  ) {
    strong.push("status-table");
  }
  if (any(TEST_COUNT)) strong.push("test-count");
  if (any(CAPS_STATE)) strong.push("work-state");
  if (count(PHASE_HEADING) >= 2) strong.push("phase-headings");
  if (count(DATED_ENTRY) >= 3) strong.push("dated-log");
  if (lines.filter((l) => LIST_ITEM.test(l) && (NOT_YET.test(l) || NOT_DONE.test(l))).length >= 2) {
    strong.push("pending-list");
  }
  if (any(NOT_DONE)) weak.push("not-done");
  if (any(DATED_CLAIM)) weak.push("dated-claim");
  const markerLines = lines.filter((l) => MARKERS.some((re) => re.test(l))).length;
  return { strong, weak, markerLines };
}

/** Every per-line marker statusSignals looks for, for counting how many lines carry one. */
const MARKERS = [STATUS_TABLE_CELL, TEST_COUNT, CAPS_STATE, PHASE_HEADING, DATED_ENTRY, NOT_DONE, NOT_YET, DATED_CLAIM];

/** Classifications by content hash, so a doc read on every search is classified once per version. */
const statusCache = new Map<string, boolean>();
const STATUS_CACHE_LIMIT = 5_000;

/**
 * Whether a body reads as a status snapshot rather than a durable fact: at
 * least one strong marker plus any other marker, or three weak ones. A single
 * marker is not enough — a decision that mentions "412 tests" once, or a gotcha
 * "verified on 2026-09-03", is not a status report. A body over LONG_DOC_CHARS
 * must also be dense with markers — a marked line per CHARS_PER_MARKER_LINE
 * characters — because a long analysis that mentions a test count and a few
 * open items in passing is still a reference doc, while a long status log is
 * markers throughout. Cached by content hash.
 */
export function isStatusLike(body: string): boolean {
  const text = body ?? "";
  const key = createHash("sha1").update(text).digest("hex");
  const known = statusCache.get(key);
  if (known !== undefined) return known;
  const { strong, weak, markerLines } = statusSignals(text);
  const total = strong.length + weak.length;
  const shaped = (strong.length >= 1 && total >= 2) || weak.length >= 3;
  const result =
    text.length > LONG_DOC_CHARS ? shaped && markerLines * CHARS_PER_MARKER_LINE >= text.length : shaped;
  if (statusCache.size >= STATUS_CACHE_LIMIT) statusCache.clear();
  statusCache.set(key, result);
  return result;
}
/** The fields confidence defaults are derived from: the stored opinion plus the doc's own dates and body. */
export interface ConfidenceDefaultsSource extends ConfidenceInputs {
  body?: string;
  generatedAt?: string;
  /** When the index first saw this exact body (a content-hash clock, unmoved by rewrites that keep the body). */
  contentFirstSeen?: string;
  /** The file time: used only when the doc has no other date at all. */
  updatedAt?: Date | string;
  /** When the doc's source last changed, where something knows better than the index (a repo mirror's last commit). */
  anchorAt?: string;
}

/** An ISO timestamp, or undefined when absent or unparseable. */
function isoOf(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The later of two ISO timestamps, either of which may be absent. */
function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * The confidence inputs a doc is judged on, derived each time from what it
 * asserts plus its own dates and body — never written back:
 *
 * - base: the asserted `confidence`, else DEFAULT_BASE_CONFIDENCE;
 * - as of: the later of the asserted `last_verified_at` and `anchorAt` (a
 *   source that changed after the last verification restarts the clock); with
 *   neither, the later of `generated_at` and `contentFirstSeen` (a changed
 *   body is its author re-stating it; a rewrite that keeps the body is not);
 *   the file time only when there is nothing else;
 * - half-life: STATUS_HALF_LIFE_DAYS for a status-like body unless the doc
 *   asserts a half-life of its own. A half-life equal to DEFAULT_HALF_LIFE_DAYS
 *   is the value the write paths stamp by default, not an opinion about this
 *   doc, so it does not stop a status snapshot from getting the short one.
 */
export function withConfidenceDefaults(doc: ConfidenceDefaultsSource): ConfidenceInputs {
  const asserted = doc.confidence !== undefined && doc.confidence !== null;
  const verified = later(isoOf(doc.lastVerifiedAt), isoOf(doc.anchorAt));
  const written = later(isoOf(doc.generatedAt), isoOf(doc.contentFirstSeen));
  const lastVerifiedAt = verified ?? written ?? isoOf(doc.updatedAt);
  const ownHalfLife =
    doc.halfLifeDays !== undefined && doc.halfLifeDays !== DEFAULT_HALF_LIFE_DAYS ? doc.halfLifeDays : undefined;
  const statusLike = doc.body !== undefined && isStatusLike(doc.body);
  const halfLifeDays = ownHalfLife ?? (statusLike ? STATUS_HALF_LIFE_DAYS : doc.halfLifeDays);
  return {
    confidence: asserted ? doc.confidence : DEFAULT_BASE_CONFIDENCE,
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(halfLifeDays !== undefined ? { halfLifeDays } : {}),
  };
}

/**
 * When `inputs`' decayed confidence fell (or will fall) below
 * MIN_INJECTION_CONFIDENCE, as an ISO timestamp. Undefined when the base is
 * already below the floor (an explicit write-down, not decay), when it never
 * decays (no date, non-positive half-life), or when there is no base.
 */
export function belowFloorSince(inputs: ConfidenceInputs): string | undefined {
  const { confidence, lastVerifiedAt } = inputs;
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) return undefined;
  if (confidence < MIN_INJECTION_CONFIDENCE || !lastVerifiedAt) return undefined;
  const halfLife = inputs.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const from = Date.parse(lastVerifiedAt);
  if (!(halfLife > 0) || !Number.isFinite(from)) return undefined;
  const days = halfLife * Math.log2(confidence / MIN_INJECTION_CONFIDENCE);
  return new Date(from + days * MS_PER_DAY).toISOString();
}

/** `inputs` with its base held to at most `cap` (the evidence pass's current findings), or unchanged with no cap. */
export function withConfidenceCap(inputs: ConfidenceInputs, cap: number | undefined): ConfidenceInputs {
  if (cap === undefined || inputs.confidence === undefined || inputs.confidence === null) return inputs;
  return { ...inputs, confidence: Math.min(inputs.confidence, cap) };
}
/** The stored confidence fields a doc carries; every field is optional. */
export interface ConfidenceInputs {
  /** Base confidence at `lastVerifiedAt`, 0..1. Absent = the doc has no opinion. */
  confidence?: number;
  /** ISO timestamp the base confidence was last affirmed. */
  lastVerifiedAt?: string;
  /** Decay half-life in days; absent falls back to DEFAULT_HALF_LIFE_DAYS. */
  halfLifeDays?: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Current confidence after half-life decay of the stored base since it was
 * last verified.
 *
 * - Returns `undefined` when there is no base confidence to decay — a doc with
 *   no confidence opinion (e.g. a legacy human-authored doc) stays opinion-less
 *   rather than being invented at some default.
 * - Returns the base unchanged when there is no `lastVerifiedAt` to age from,
 *   when the half-life is non-positive (decay disabled), or when the timestamp
 *   is unparseable — decay is opt-in and never fabricated from bad data.
 * - Never extrapolates upward: a `lastVerifiedAt` in the future (clock skew)
 *   yields the base, not a value above it.
 *
 * `now` is injectable so the derivation is deterministically testable.
 */
export function deriveConfidence(
  inputs: ConfidenceInputs,
  now: Date = new Date()
): number | undefined {
  const { confidence, lastVerifiedAt, halfLifeDays } = inputs;
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) {
    return undefined;
  }
  const base = clamp01(confidence);

  const halfLife = halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (!lastVerifiedAt || !(halfLife > 0)) return base;

  const verifiedMs = Date.parse(lastVerifiedAt);
  if (!Number.isFinite(verifiedMs)) return base;

  const elapsedDays = (now.getTime() - verifiedMs) / MS_PER_DAY;
  // Not yet aged (or future-dated by clock skew): the base still holds.
  if (elapsedDays <= 0) return base;

  const decayed = base * Math.pow(0.5, elapsedDays / halfLife);
  return clamp01(decayed);
}

/**
 * Whether a doc's current confidence is high enough to be auto-injected
 * (roadmap r5). This is the freshness half of the injection gate; the trust
 * half is isOriginEligibleForInjection (origin_class). Both must pass.
 *
 * A doc with NO confidence opinion (deriveConfidence → undefined) is not gated
 * here. The loader gives every indexed doc one (withConfidenceDefaults), so
 * this only covers a doc that reached the index some other way.
 *
 * The gate distinguishes two ways a doc's confidence gets low, because their
 * cure is different:
 *
 * - A STORED base below the floor was written down by evidence — a
 *   re-verification dispute (DISPUTED_CONFIDENCE) or a deterministic finding
 *   (confidenceUnderEvidence) — not by the passage of time. It is gated out
 *   ALWAYS, even where re-verification cannot run: only a re-verification or a
 *   human re-accepting the doc should lift a refuted fact back into injection.
 * - A base that is fine but has DECAYED below the floor with age is gated out
 *   ONLY when re-verification is active for the doc's project
 *   (`reverifyActive`). The re-verification cron is what lifts a decayed doc
 *   back on a clean pass, so it is the recovery path; with no recovery path
 *   time-decay alone must not silently and permanently drop a doc out of
 *   auto-injection.
 *
 *   `reverifyActive` is the recovery-path signal for the doc's OWN project: the
 *   cron re-verifies any doc of a project whose repo resolves on this host and
 *   that has not opted out (projectReverifyOperational in the collector). A doc
 *   homed in a project with no repo has no recovery path, so its decay must not
 *   gate it out here.
 */
export function isConfidenceEligibleForInjection(
  inputs: ConfidenceInputs,
  opts: { reverifyActive?: boolean; now?: Date } = {}
): boolean {
  const { confidence } = inputs;
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) {
    return true;
  }
  const base = clamp01(confidence);
  if (base < MIN_INJECTION_CONFIDENCE) return false;
  if (!opts.reverifyActive) return true;
  const current = deriveConfidence(inputs, opts.now ?? new Date());
  return current === undefined ? true : current >= MIN_INJECTION_CONFIDENCE;
}
