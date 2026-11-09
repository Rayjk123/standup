/** Refused calls logged one row each per alias in a window; more are counted into one summary row. */
export const REFUSED_LOGGED_PER_ALIAS = 20;

/** Refused calls logged one row each across all aliases in a window. */
export const REFUSED_LOGGED_TOTAL = 200;

/** `/whoami` calls logged one row each per alias in a window. */
export const WHOAMI_LOGGED_PER_ALIAS = 5;

/** Answered (2xx) calls other than `/whoami` logged one row each per alias in a window. */
export const SUCCESS_LOGGED_PER_ALIAS = 60;

/** Answered calls logged one row each across all aliases in a window. */
export const SUCCESS_LOGGED_TOTAL = 600;

/** How long a counting window lasts. */
export const REFUSED_LOG_WINDOW_MS = 60_000;

/** Most aliases a window counts separately; the rest share one overflow count. */
const MAX_TRACKED_ALIASES = 1_000;

/** The overflow count's key, which no alias can spell. */
const OVERFLOW_KEY = "*";

/** A summary row for the refused calls a window counted instead of logging. */
export interface CollapsedRefusals {
  /** The alias the calls carried; null for calls with none, `*` for aliases past the tracking cap. */
  alias: string | null;
  count: number;
  /** The last status among them. */
  status: number;
  /** ISO-8601 start of the window. */
  since: string;
}

export interface RefusedLogThrottle {
  /**
   * Whether a throttled call (a refusal, or another call whose rows are
   * capped) from `alias` at `at` gets its own log row; false when it is only
   * counted, to be reported by `closed`.
   */
  admit(alias: string | null, status: number, at: number): boolean;
  /** The counts of the window that has closed by `at`, if any; it is then reset. */
  closed(at: number): CollapsedRefusals[];
}

/** How many rows a throttle logs one each in a window, per alias and in all. */
export interface LogThrottleLimits {
  perAlias?: number;
  total?: number;
}

/**
 * Bounds how many log rows throttled calls write: in each window, the first
 * `perAlias` (REFUSED_LOGGED_PER_ALIAS) per alias and `total`
 * (REFUSED_LOGGED_TOTAL) in all are logged; the rest are counted per alias
 * and reported as one row each when the window closes (on the first call
 * after it ends). So a caller cycling forged aliases or unknown paths can't
 * flush the log's real rows out.
 */
export function refusedLogThrottle(limits: LogThrottleLimits = {}): RefusedLogThrottle {
  const perAlias = limits.perAlias ?? REFUSED_LOGGED_PER_ALIAS;
  const totalCap = limits.total ?? REFUSED_LOGGED_TOTAL;
  let windowStart: number | null = null;
  let total = 0;
  const logged = new Map<string, number>();
  const counted = new Map<string, { alias: string | null; count: number; status: number }>();
  const keyOf = (alias: string | null) => (alias === null ? "" : `a:${alias}`);
  return {
    admit(alias, status, at) {
      if (windowStart === null) windowStart = at;
      const key = keyOf(alias);
      const mine = logged.get(key) ?? 0;
      if (mine < perAlias && total < totalCap) {
        if (logged.has(key) || logged.size < MAX_TRACKED_ALIASES) logged.set(key, mine + 1);
        total += 1;
        return true;
      }
      const tracked = counted.has(key) || counted.size < MAX_TRACKED_ALIASES;
      const countKey = tracked ? key : OVERFLOW_KEY;
      const entry = counted.get(countKey) ?? { alias: tracked ? alias : OVERFLOW_KEY, count: 0, status };
      entry.count += 1;
      entry.status = status;
      counted.set(countKey, entry);
      return false;
    },
    closed(at) {
      if (windowStart === null || at - windowStart < REFUSED_LOG_WINDOW_MS) return [];
      const since = new Date(windowStart).toISOString();
      const rows = [...counted.values()].map((e) => ({ alias: e.alias, count: e.count, status: e.status, since }));
      windowStart = null;
      total = 0;
      logged.clear();
      counted.clear();
      return rows;
    },
  };
}
