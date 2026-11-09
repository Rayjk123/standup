import { describe, expect, test } from "bun:test";
import type { PersonaHoldReportRow } from "@standup/shared";
import { formatDecideTime, holdReportLine } from "./persona";

const row = (over: Partial<PersonaHoldReportRow> = {}): PersonaHoldReportRow => ({
  holdRule: "hold-knob:approve_plan",
  inferred: false,
  retired: false,
  decided: 10,
  approved: 9,
  denied: 1,
  approveRate: 0.9,
  medianDecideMs: 14 * 60_000,
  pending: 0,
  expired: 0,
  superseded: 0,
  noisy: true,
  actions: [],
  lastAt: "2026-10-06T00:00:00.000Z",
  ...over,
});

describe("formatDecideTime", () => {
  test("coarse units, and a dash for nothing", () => {
    expect(formatDecideTime(24_000)).toBe("24 s");
    expect(formatDecideTime(14 * 60_000)).toBe("14 min");
    expect(formatDecideTime(3.5 * 3_600_000)).toBe("3.5 h");
    expect(formatDecideTime(50 * 3_600_000)).toBe("2.1 d");
    expect(formatDecideTime(null)).toBe("—");
    expect(formatDecideTime(-1)).toBe("—");
  });
});

describe("holdReportLine", () => {
  test("a noisy rule shows its counts, rate and median", () => {
    expect(holdReportLine(row())).toEqual({
      rule: "hold-knob:approve_plan",
      count: "9/10 approved",
      rate: "90%",
      median: "14 min",
      tag: "noisy",
    });
  });

  test("undecided approvals are counted apart, and a rule with no decisions has no rate", () => {
    const line = holdReportLine(row({ decided: 0, approved: 0, approveRate: null, medianDecideMs: null, pending: 1, expired: 2, noisy: false }));
    expect(line).toMatchObject({ count: "0/0 approved · 3 undecided", rate: "—", median: "—", tag: "" });
  });

  test("a rule kept for the owner, a retired rule and an inferred one say so", () => {
    expect(holdReportLine(row({ holdRule: "floor:outward", noisy: false, excluded: "a safety-floor category only the owner may allow" }))).toMatchObject({
      tag: "kept",
      note: "a safety-floor category only the owner may allow",
    });
    expect(holdReportLine(row({ holdRule: "text:outward", noisy: false, retired: true, inferred: true }))).toMatchObject({
      tag: "retired",
      note: "rule removed from the policy",
    });
    expect(holdReportLine(row({ noisy: false, inferred: true }))).toMatchObject({ tag: "", note: "some rules read from older reasons" });
  });
});
