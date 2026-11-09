import { describe, expect, test } from "bun:test";
import type { Cron } from "croner";
import {
  DEFAULT_OWNER_TZ,
  MIN_SCHEDULE_INTERVAL_MS,
  isValidTimezone,
  missedSlots,
  nextSlot,
  ownerTimezone,
  parseInstant,
  parseSchedule,
} from "./cron.js";

function cron(expr: string, timezone: string, from = new Date("2026-01-01T00:00:00Z")): Cron {
  const parsed = parseSchedule(expr, timezone, from);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.cron;
}

/** The slots from `from` (exclusive) up to `until`, by repeated nextSlot. */
function slotsBetween(c: Cron, from: Date, until: Date): Date[] {
  const out: Date[] = [];
  let at = from;
  for (;;) {
    const next = nextSlot(c, at);
    if (!next || next.getTime() > until.getTime()) return out;
    out.push(next);
    at = next;
  }
}

/** `at` as wall-clock "YYYY-MM-DD HH:MM" in `timezone`. */
function wallClock(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

describe("parseSchedule", () => {
  test("accepts a five-field expression in an IANA zone", () => {
    const parsed = parseSchedule("0 9 * * 1-5", "America/Los_Angeles");
    expect(parsed.ok).toBe(true);
  });

  test("accepts surrounding whitespace and an exactly-5-minute cadence", () => {
    expect(parseSchedule("  */5 * * * *  ", "UTC").ok).toBe(true);
  });

  test.each([
    ["", "cron is required"],
    ["   ", "cron is required"],
    ["0 0 9 * * 1-5", "five fields"],
    ["9 * * 1-5", "five fields"],
    ["@daily", "five fields"],
    ["* * * * *", "closer together than every 5 minutes"],
    ["*/2 * * * *", "closer together than every 5 minutes"],
    ["0,1 9 * * *", "closer together than every 5 minutes"],
    ["0 0 30 2 *", "never runs"],
    ["0 0 31 4 *", "never runs"],
    ["61 * * * *", "invalid cron"],
    ["0 25 * * *", "invalid cron"],
    ["a b c d e", "invalid cron"],
  ])("rejects %p", (expr, message) => {
    const parsed = parseSchedule(expr, "UTC");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  test("rejects a non-string expression", () => {
    const parsed = parseSchedule(undefined as unknown as string, "UTC");
    expect(parsed).toEqual({ ok: false, error: "cron is required" });
  });

  test.each(["Mars/Olympus_Mons", "", "EST5EDT-not", "America/New York"])("rejects timezone %p", (tz) => {
    const parsed = parseSchedule("0 9 * * *", tz);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("unknown timezone");
  });

  test("the minimum interval is five minutes", () => {
    expect(MIN_SCHEDULE_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

describe("timezones", () => {
  test("isValidTimezone", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Nowhere/Special")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });

  test("ownerTimezone reads STANDUP_DIGEST_TZ, falling back to New York", () => {
    expect(ownerTimezone({})).toBe(DEFAULT_OWNER_TZ);
    expect(ownerTimezone({ STANDUP_DIGEST_TZ: "America/Los_Angeles" })).toBe("America/Los_Angeles");
    expect(ownerTimezone({ STANDUP_DIGEST_TZ: "  Europe/Berlin " })).toBe("Europe/Berlin");
    expect(ownerTimezone({ STANDUP_DIGEST_TZ: "Not/AZone" })).toBe(DEFAULT_OWNER_TZ);
    expect(ownerTimezone({ STANDUP_DIGEST_TZ: "" })).toBe(DEFAULT_OWNER_TZ);
  });
});

// 2026 US DST: spring forward Sun Mar 8 (02:00 → 03:00), fall back Sun Nov 1 (02:00 → 01:00).
describe.each([
  ["America/New_York", { est: -5, edt: -4 }],
  ["America/Los_Angeles", { est: -8, edt: -7 }],
])("DST in %s", (tz, offsets) => {
  /** The UTC instant of local `day` `hh:mm` at UTC offset `offset` hours. */
  const local = (day: string, hh: number, mm: number, offset: number) =>
    new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hh - offset, mm));

  test("a 02:30 daily slot on spring-forward day runs once, at the first valid time", () => {
    const c = cron("30 2 * * *", tz);
    const slots = slotsBetween(c, local("2026-03-07", 12, 0, offsets.est), local("2026-03-09", 12, 0, offsets.edt));
    expect(slots).toHaveLength(2);
    // Mar 8: 02:30 does not exist; it runs at 03:00 EDT, the first valid time after the gap.
    expect(slots[0]!.toISOString()).toBe(local("2026-03-08", 3, 0, offsets.edt).toISOString());
    expect(wallClock(slots[0]!, tz)).toBe("2026-03-08 03:00");
    expect(wallClock(slots[1]!, tz)).toBe("2026-03-09 02:30");
  });

  test("several slots in the gap collapse into one run at its end", () => {
    const c = cron("*/15 2 * * *", tz);
    const slots = slotsBetween(c, local("2026-03-08", 0, 0, offsets.est), local("2026-03-08", 12, 0, offsets.edt));
    expect(slots.map((s) => wallClock(s, tz))).toEqual(["2026-03-08 03:00"]);
  });

  test("slots just after the gap are untouched", () => {
    const c = cron("0,30 3 * * *", tz);
    const slots = slotsBetween(c, local("2026-03-08", 0, 0, offsets.est), local("2026-03-08", 12, 0, offsets.edt));
    expect(slots.map((s) => wallClock(s, tz))).toEqual(["2026-03-08 03:00", "2026-03-08 03:30"]);
  });

  test("a gap slot and a real slot at the same instant run once", () => {
    const c = cron("0 2,3 * * *", tz);
    const slots = slotsBetween(c, local("2026-03-08", 0, 0, offsets.est), local("2026-03-08", 12, 0, offsets.edt));
    expect(slots.map((s) => wallClock(s, tz))).toEqual(["2026-03-08 03:00"]);
  });

  test("missedSlots across the gap counts the gap slot once", () => {
    const c = cron("30 2 * * *", tz);
    const due = nextSlot(c, local("2026-03-06", 12, 0, offsets.est))!;
    const missed = missedSlots(c, due, local("2026-03-08", 12, 0, offsets.edt));
    expect(missed.count).toBe(2);
    expect(wallClock(missed.latest, tz)).toBe("2026-03-08 03:00");
  });

  test("a 01:30 slot on fall-back day runs exactly once", () => {
    const c = cron("30 1 * * *", tz);
    const slots = slotsBetween(c, local("2026-10-31", 12, 0, offsets.edt), local("2026-11-02", 12, 0, offsets.est));
    const onFallBack = slots.filter((s) => wallClock(s, tz).startsWith("2026-11-01"));
    expect(onFallBack).toHaveLength(1);
    expect(wallClock(onFallBack[0]!, tz)).toBe("2026-11-01 01:30");
    expect(slots).toHaveLength(2);
  });

  test("an hourly slot on fall-back day does not run the repeated hour twice", () => {
    const c = cron("15 * * * *", tz);
    const slots = slotsBetween(c, local("2026-11-01", 0, 0, offsets.edt), local("2026-11-01", 4, 0, offsets.est));
    const at115 = slots.filter((s) => wallClock(s, tz) === "2026-11-01 01:15");
    expect(at115.length).toBeGreaterThanOrEqual(1);
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(slots.length);
  });

  test("weekday 9:00 keeps wall-clock time across both DST changes", () => {
    const c = cron("0 9 * * 1-5", tz);
    for (const [from, until] of [
      ["2026-03-02", "2026-03-14"],
      ["2026-10-26", "2026-11-07"],
    ] as const) {
      const slots = slotsBetween(c, local(from, 0, 0, offsets.est), local(until, 23, 0, offsets.est));
      expect(slots.length).toBeGreaterThanOrEqual(9);
      for (const s of slots) {
        expect(wallClock(s, tz).endsWith(" 09:00")).toBe(true);
        const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(s);
        expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(weekday);
      }
      // Both sides of the change are present: the UTC hour of 9:00 local differs by one.
      expect(new Set(slots.map((s) => s.getUTCHours())).size).toBe(2);
    }
  });
});

describe("nextSlot", () => {
  test("is strictly after the given instant", () => {
    const c = cron("0 9 * * *", "UTC");
    const at = new Date("2026-05-01T09:00:00.000Z");
    expect(nextSlot(c, at)!.toISOString()).toBe("2026-05-02T09:00:00.000Z");
    expect(nextSlot(c, new Date(at.getTime() - 1))!.toISOString()).toBe(at.toISOString());
  });
});

describe("missedSlots", () => {
  const c = cron("0 * * * *", "UTC");

  test("one slot due exactly now counts once", () => {
    const due = new Date("2026-05-01T09:00:00Z");
    expect(missedSlots(c, due, due)).toEqual({ count: 1, latest: due });
  });

  test("counts every slot from the due one through now, and returns the latest", () => {
    const due = new Date("2026-05-01T09:00:00Z");
    const now = new Date("2026-05-01T14:30:00Z");
    const missed = missedSlots(c, due, now);
    expect(missed.count).toBe(6);
    expect(missed.latest.toISOString()).toBe("2026-05-01T14:00:00.000Z");
  });

  test("a slot exactly at now is included", () => {
    const due = new Date("2026-05-01T09:00:00Z");
    const missed = missedSlots(c, due, new Date("2026-05-01T12:00:00Z"));
    expect(missed.count).toBe(4);
    expect(missed.latest.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  test("stops at the limit and still reports the latest slot before now", () => {
    const due = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-03-01T05:30:00Z");
    const missed = missedSlots(c, due, now, 50);
    expect(missed.count).toBe(50);
    expect(missed.latest.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });
});

describe("parseInstant", () => {
  const iso = (value: string, timezone = "America/New_York") => parseInstant(value, timezone)?.toISOString() ?? null;

  test("Z and offsets are that instant, whatever the timezone", () => {
    expect(iso("2026-05-01T09:00:00Z")).toBe("2026-05-01T09:00:00.000Z");
    expect(iso("2026-05-01T09:00:00.25z", "Asia/Tokyo")).toBe("2026-05-01T09:00:00.250Z");
    expect(iso("2026-05-01T05:00-04:00")).toBe("2026-05-01T09:00:00.000Z");
    expect(iso("2026-05-01T18:30+0930")).toBe("2026-05-01T09:00:00.000Z");
    expect(iso("2026-05-01T14:00+05")).toBe("2026-05-01T09:00:00.000Z");
    expect(iso("2026-05-01 09:00Z")).toBe("2026-05-01T09:00:00.000Z");
  });

  test("a wall time without an offset is read in the timezone, at the offset in force then", () => {
    expect(iso("2026-07-01T09:00")).toBe("2026-07-01T13:00:00.000Z");
    expect(iso("2026-01-15T09:00")).toBe("2026-01-15T14:00:00.000Z");
    expect(iso("2026-01-15T09:00", "Asia/Kolkata")).toBe("2026-01-15T03:30:00.000Z");
    expect(iso("2026-01-15T09:00", "UTC")).toBe("2026-01-15T09:00:00.000Z");
    // Hours either side of the switches.
    expect(iso("2026-03-08T01:59")).toBe("2026-03-08T06:59:00.000Z");
    expect(iso("2026-03-08T03:00")).toBe("2026-03-08T07:00:00.000Z");
    expect(iso("2026-11-01T00:30")).toBe("2026-11-01T04:30:00.000Z");
    expect(iso("2026-11-01T02:00")).toBe("2026-11-01T07:00:00.000Z");
  });

  test("a repeated fall-back hour reads as its first occurrence; a spring-forward gap at the offset before it", () => {
    expect(iso("2026-11-01T01:30")).toBe("2026-11-01T05:30:00.000Z");
    expect(iso("2026-03-08T02:30")).toBe("2026-03-08T07:30:00.000Z");
  });

  test("anything else is null", () => {
    for (const bad of ["", "tomorrow", "2026-05-01", "2026-02-30T09:00", "2026-05-01T24:00", "2026-05-01T09:60", "2026-05-01T09:00+15:00", "2026-05-01T09:00+05:75"]) {
      expect(iso(bad)).toBeNull();
    }
    expect(iso("2026-05-01T09:00", "Mars/Olympus")).toBeNull();
  });
});
