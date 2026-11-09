import { Cron } from "croner";

/**
 * Cron reading for Persona's schedules, on croner (DST-aware: a slot in a
 * spring-forward gap runs once, at the first valid time after it, and a slot
 * in a fall-back hour runs once).
 */

/** The timezone the owner's local time is read in when none is given — shared with the digest. */
export const DEFAULT_OWNER_TZ = "America/New_York";
export const OWNER_TZ_ENV = "STANDUP_DIGEST_TZ";

/** Slots closer together than this are refused: a schedule is not a polling loop. */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;

/** Whether `timezone` is an IANA zone this runtime knows. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The owner's timezone: STANDUP_DIGEST_TZ when it is a valid zone, else America/New_York. */
export function ownerTimezone(env: Record<string, string | undefined> = process.env): string {
  const configured = env[OWNER_TZ_ENV]?.trim();
  return configured && isValidTimezone(configured) ? configured : DEFAULT_OWNER_TZ;
}

export type ParsedSchedule = { ok: true; cron: Cron } | { ok: false; error: string };

/**
 * Checks a five-field cron expression (minute hour day-of-month month
 * day-of-week) in `timezone`: well-formed, with a future slot, and no two of
 * its next slots closer than MIN_SCHEDULE_INTERVAL_MS.
 */
export function parseSchedule(expr: string, timezone: string, from: Date = new Date()): ParsedSchedule {
  const trimmed = typeof expr === "string" ? expr.trim() : "";
  if (!trimmed) return { ok: false, error: "cron is required" };
  if (trimmed.split(/\s+/).length !== 5) {
    return { ok: false, error: "cron must have five fields: minute hour day-of-month month day-of-week (e.g. \"0 9 * * 1-5\")" };
  }
  if (!isValidTimezone(timezone)) return { ok: false, error: `unknown timezone ${JSON.stringify(timezone)} (use an IANA name like America/New_York)` };
  let cron: Cron;
  try {
    cron = new Cron(trimmed, { timezone, paused: true });
  } catch (err) {
    return { ok: false, error: `invalid cron: ${(err as Error).message.replace(/^CronPattern:\s*/, "")}` };
  }
  const slots: Date[] = [];
  for (let at: Date | null = from; slots.length < 12; ) {
    at = nextSlot(cron, at);
    if (!at) break;
    slots.push(at);
  }
  if (slots.length === 0) return { ok: false, error: "the expression never runs" };
  for (let i = 1; i < slots.length; i++) {
    if (slots[i]!.getTime() - slots[i - 1]!.getTime() < MIN_SCHEDULE_INTERVAL_MS) {
      return { ok: false, error: "runs closer together than every 5 minutes are not allowed" };
    }
  }
  return { ok: true, cron };
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** `timezone`'s offset from UTC at `at`, in ms (whole seconds). */
function utcOffsetMs(timezone: string, at: number): number {
  let format = offsetFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    offsetFormats.set(timezone, format);
  }
  const parts = format.formatToParts(new Date(at));
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * An ISO date-time as an instant. With `Z` or an offset it is that instant;
 * without one ("2026-10-19T01:00") it is a wall-clock time in `timezone`. A
 * wall time a fall-back hour repeats reads as its first occurrence; one in a
 * spring-forward gap, as the same clock time at the offset before the gap.
 * Null when it isn't such a date-time.
 */
export function parseInstant(value: string, timezone: string): Date | null {
  const m = INSTANT_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), ms);
  const check = new Date(wall);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59 || Number(s ?? 0) > 59) {
    return null;
  }
  if (zone) {
    if (zone.toUpperCase() === "Z") return new Date(wall);
    const digits = zone.replace(":", "").padEnd(5, "0");
    const minutes = Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5));
    if (Number(digits.slice(3, 5)) > 59 || minutes > 14 * 60) return null;
    return new Date(wall - (digits[0] === "-" ? -1 : 1) * minutes * 60_000);
  }
  if (!isValidTimezone(timezone)) return null;
  // The offset in force a day either side picks the earlier reading of a repeated hour.
  const before = utcOffsetMs(timezone, wall - 24 * 60 * 60 * 1000);
  const after = utcOffsetMs(timezone, wall + 24 * 60 * 60 * 1000);
  for (const offset of before >= after ? [before, after] : [after, before]) {
    const at = wall - offset;
    if (utcOffsetMs(timezone, at) === offset) return new Date(at);
  }
  return new Date(wall - before);
}

/** How far back a spring-forward gap is looked for: longer than any real-world DST shift. */
const MAX_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * A slot as it runs. croner moves a wall-clock time that falls in a
 * spring-forward gap (02:30 on the day clocks jump 02:00 → 03:00) forward by
 * the gap, to 03:30; such a slot no longer reads as the pattern's time, and
 * runs instead at the first valid instant after the gap — the moment the
 * clocks jumped (03:00).
 */
function slotAsRun(cron: Cron, slot: Date): Date {
  const timezone = cron.options.timezone;
  if (!timezone || cron.match(slot)) return slot;
  let lo = slot.getTime() - MAX_GAP_MS;
  let hi = slot.getTime();
  const before = utcOffsetMs(timezone, lo);
  if (utcOffsetMs(timezone, hi) <= before) return slot;
  // The first second at the later offset.
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (utcOffsetMs(timezone, mid) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/**
 * The first slot strictly after `after`, or null when there is none. Slots in
 * a spring-forward gap run once, at the end of the gap (see slotAsRun).
 */
export function nextSlot(cron: Cron, after: Date): Date | null {
  let from = after;
  for (let i = 0; i < 1_000; i++) {
    const raw = cron.nextRun(from);
    if (!raw) return null;
    const slot = slotAsRun(cron, raw);
    if (slot.getTime() > after.getTime()) return slot;
    from = raw;
  }
  return null;
}

/**
 * The slots from `dueAt` (itself a slot) up to and including `now`: how many
 * there are (at least 1) and the latest. Bounded, so a schedule left behind
 * for years cannot spin.
 */
export function missedSlots(cron: Cron, dueAt: Date, now: Date, limit = 10_000): { count: number; latest: Date } {
  let latest = dueAt;
  let count = 1;
  for (; count < limit; count++) {
    const next = nextSlot(cron, latest);
    if (!next || next.getTime() > now.getTime()) break;
    latest = next;
  }
  if (count >= limit) {
    const previous = cron.previousRuns(1, new Date(now.getTime() + 1))[0];
    if (previous) {
      const asRun = slotAsRun(cron, previous);
      if (asRun.getTime() > latest.getTime() && asRun.getTime() <= now.getTime()) latest = asRun;
    }
  }
  return { count, latest };
}
