import { describe, expect, test } from "bun:test";
import { describeCron, describeScheduleEnd, fireHorizon, scheduleEndReason, timezoneLabel } from "./schedules.js";

const SUMMER = new Date("2026-07-01T12:00:00Z");
const WINTER = new Date("2026-01-15T12:00:00Z");

describe("timezoneLabel", () => {
  test("US zones read as their generic abbreviation in any season", () => {
    for (const at of [SUMMER, WINTER]) {
      expect(timezoneLabel("America/Los_Angeles", at)).toBe("PT");
      expect(timezoneLabel("America/New_York", at)).toBe("ET");
      expect(timezoneLabel("America/Chicago", at)).toBe("CT");
    }
  });

  test("UTC", () => {
    expect(timezoneLabel("UTC")).toBe("UTC");
    expect(timezoneLabel("Etc/UTC")).toBe("UTC");
  });

  test("a zone without a short generic name falls back to its offset", () => {
    expect(timezoneLabel("Asia/Tokyo", SUMMER)).toBe("GMT+9");
    expect(timezoneLabel("Asia/Kolkata", SUMMER)).toBe("GMT+5:30");
  });

  test("an unknown zone comes back as given", () => {
    expect(timezoneLabel("Nowhere/Special", SUMMER)).toBe("Nowhere/Special");
  });
});

describe("describeCron", () => {
  test.each([
    ["0 9 * * 1-5", "America/Los_Angeles", "Weekdays at 9:00 PT"],
    ["0 9 * * MON-FRI", "America/Los_Angeles", "Weekdays at 9:00 PT"],
    ["0 9 * * 1,2,3,4,5", "America/New_York", "Weekdays at 9:00 ET"],
    ["30 8 * * *", "America/New_York", "Daily at 8:30 ET"],
    ["05 07 * * *", "UTC", "Daily at 7:05 UTC"],
    ["0 9,17 * * *", "UTC", "Daily at 9:00, 17:00 UTC"],
    ["0 10 * * 0,6", "UTC", "Weekends at 10:00 UTC"],
    ["0 10 * * 6,7", "UTC", "Weekends at 10:00 UTC"],
    ["0 10 * * 0-6", "UTC", "Every day at 10:00 UTC"],
    ["0 10 * * 1,3,5", "UTC", "Mon, Wed, Fri at 10:00 UTC"],
    ["0 10 * * 7", "UTC", "Sun at 10:00 UTC"],
    ["0 9 1 * *", "UTC", "Monthly on the 1st at 9:00 UTC"],
    ["0 9 1,15 * *", "UTC", "Monthly on the 1st, 15th at 9:00 UTC"],
    ["0 9 2,3,22 * *", "UTC", "Monthly on the 2nd, 3rd, 22nd at 9:00 UTC"],
    ["0 9 11,12,13 * *", "UTC", "Monthly on the 11th, 12th, 13th at 9:00 UTC"],
    ["0 9 1 1 *", "UTC", "Every Jan 1 at 9:00 UTC"],
    ["0 9 25 dec *", "UTC", "Every Dec 25 at 9:00 UTC"],
    ["*/15 * * * *", "UTC", "Every 15 minutes"],
    ["*/1 * * * *", "UTC", "Every minute"],
    ["* * * * *", "UTC", "Every minute"],
    ["0 * * * *", "UTC", "Hourly at :00"],
    ["7 * * * *", "UTC", "Hourly at :07"],
    ["0 */2 * * *", "UTC", "Every 2 hours at :00"],
    ["15 */1 * * *", "UTC", "Every hour at :15"],
  ])("%p in %p → %p", (expr, tz, expected) => {
    expect(describeCron(expr, tz, SUMMER)).toBe(expected);
  });

  test.each([
    "0 9-17 * * *",
    "*/30 9 * * *",
    "0 */2 * * 1-5",
    "0 9 1 * 1",
    "0 9 1-3 1 *",
    "0 9 * 1-3 *",
    "0 9 * * 5-1",
    "0 9 0 * *",
    "0 9 1 0 *",
    "0 9 L * *",
    "0 9 * * 1#2",
    "0 0 9 * * 1",
    "nonsense",
  ])("%p has no phrasing and falls back to the expression", (expr) => {
    expect(describeCron(expr, "America/New_York", SUMMER)).toBe(`cron ${expr.trim()} (ET)`);
  });

  test("the fallback trims the expression", () => {
    expect(describeCron("  0 9-17 * * *  ", "UTC")).toBe("cron 0 9-17 * * * (UTC)");
  });
});

describe("scheduleEndReason", () => {
  const now = "2026-05-01T12:00:00.000Z";
  test("max_runs once the run count reaches the limit", () => {
    expect(scheduleEndReason({ maxRuns: 2 }, { runCount: 1, nextRunAt: "2026-05-01T13:00:00.000Z", now })).toBeNull();
    expect(scheduleEndReason({ maxRuns: 2 }, { runCount: 2, nextRunAt: "2026-05-01T13:00:00.000Z", now })).toBe("max_runs");
  });

  test("ends_at once the next slot falls after it (a slot exactly at it still runs), or with none, once it has passed", () => {
    const bound = { endsAt: "2026-05-01T13:00:00.000Z" };
    expect(scheduleEndReason(bound, { runCount: 0, nextRunAt: "2026-05-01T13:00:00.000Z", now })).toBeNull();
    expect(scheduleEndReason(bound, { runCount: 0, nextRunAt: "2026-05-01T14:00:00.000Z", now })).toBe("ends_at");
    expect(scheduleEndReason(bound, { runCount: 0, nextRunAt: null, now })).toBeNull();
    expect(scheduleEndReason(bound, { runCount: 0, nextRunAt: null, now: "2026-05-01T13:00:01.000Z" })).toBe("ends_at");
  });

  test("whichever comes first; no bound never ends", () => {
    const bound = { endsAt: "2026-05-02T00:00:00.000Z", maxRuns: 3 };
    expect(scheduleEndReason(bound, { runCount: 3, nextRunAt: "2026-05-01T13:00:00.000Z", now })).toBe("max_runs");
    expect(scheduleEndReason(bound, { runCount: 1, nextRunAt: "2026-05-02T01:00:00.000Z", now })).toBe("ends_at");
    expect(scheduleEndReason({}, { runCount: 1_000, nextRunAt: null, now })).toBeNull();
  });
});

describe("fireHorizon", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");
  test("endsAt when it is before now, else now", () => {
    expect(fireHorizon({ endsAt: "2026-05-01T11:00:00.000Z" }, now).toISOString()).toBe("2026-05-01T11:00:00.000Z");
    expect(fireHorizon({ endsAt: "2026-05-01T13:00:00.000Z" }, now)).toBe(now);
    expect(fireHorizon({}, now)).toBe(now);
  });
});

describe("describeScheduleEnd", () => {
  const base = { timezone: "America/New_York", runCount: 0 };
  test("none without a bound", () => {
    expect(describeScheduleEnd(base)).toBeNull();
  });

  test("the bound in the schedule's timezone, with runs left", () => {
    expect(describeScheduleEnd({ ...base, maxRuns: 5, runCount: 2 })).toBe("Ends after 5 runs (3 left)");
    expect(describeScheduleEnd({ ...base, endsAt: "2026-10-19T05:00:00.000Z" })).toBe("Ends Oct 19, 1:00 AM ET");
    expect(describeScheduleEnd({ ...base, endsAt: "2026-10-19T05:00:00.000Z" }, "UTC")).toBe("Ends Oct 19, 5:00 AM UTC");
    expect(describeScheduleEnd({ ...base, maxRuns: 1, endsAt: "2026-10-19T05:00:00.000Z" })).toBe(
      "Ends after 1 run (1 left) or at Oct 19, 1:00 AM ET"
    );
  });

  test("an ended schedule says when, why and how many runs it fired", () => {
    expect(
      describeScheduleEnd({ ...base, maxRuns: 2, runCount: 2, endedAt: "2026-10-12T14:05:00.000Z", endReason: "max_runs" })
    ).toBe("Ended Oct 12, 10:05 AM ET (run limit reached; 2 runs)");
    expect(
      describeScheduleEnd({ ...base, endsAt: "2026-10-12T14:00:00.000Z", runCount: 1, endedAt: "2026-10-12T14:00:00.000Z", endReason: "ends_at" })
    ).toBe("Ended Oct 12, 10:00 AM ET (no run left before the end time; 1 run)");
  });
});
