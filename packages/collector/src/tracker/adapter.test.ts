import { describe, expect, test } from "bun:test";
import type { TicketStatus } from "@standup/shared";
import {
  agentTracker,
  genericTrackerStatus,
  noneTracker,
  resolveTrackerAdapter,
  TrackerUnavailableError,
} from "./adapter.js";

describe("resolveTrackerAdapter", () => {
  const cases: Array<[string, Record<string, string | undefined>, string, boolean]> = [
    ["unset is none", {}, "none", false],
    ["blank is none", { STANDUP_TRACKER: "  " }, "none", false],
    ["explicit none", { STANDUP_TRACKER: "none" }, "none", false],
    ["agent", { STANDUP_TRACKER: "agent", STANDUP_TRACKER_NAME: "Jira" }, "agent", true],
    ["case-insensitive", { STANDUP_TRACKER: "AGENT" }, "agent", true],
    ["unknown falls back to none", { STANDUP_TRACKER: "bogus" }, "none", false],
  ];
  for (const [name, env, id, enabled] of cases) {
    test(name, () => {
      const warnings: string[] = [];
      const t = resolveTrackerAdapter(env, (m) => warnings.push(m));
      expect(t.id).toBe(id);
      expect(t.enabled).toBe(enabled);
      expect(warnings.length).toBe(name.startsWith("unknown") ? 1 : 0);
    });
  }

  test("an agent tracker carries its configured name", () => {
    expect(resolveTrackerAdapter({ STANDUP_TRACKER: "agent", STANDUP_TRACKER_NAME: "Linear" }).name).toBe("Linear");
    expect(resolveTrackerAdapter({ STANDUP_TRACKER: "agent" }).name).toBe("the issue tracker");
  });
});

describe("noneTracker — the built-in default", () => {
  test("is disabled with no writeback", () => {
    expect(noneTracker.enabled).toBe(false);
    expect(noneTracker.writeback).toBe("none");
    expect(noneTracker.writebackInstruction("T-1", { reviewUrl: "https://x/1" })).toBeNull();
  });

  test("every outward call refuses", async () => {
    await expect(noneTracker.getTask("T-1")).rejects.toBeInstanceOf(TrackerUnavailableError);
    await expect(noneTracker.listTasks()).rejects.toBeInstanceOf(TrackerUnavailableError);
    await expect(noneTracker.updateTask("T-1", { status: "x" })).rejects.toBeInstanceOf(TrackerUnavailableError);
  });
});

describe("agentTracker", () => {
  const jira = agentTracker("Jira");

  test("writes back through the session, never the collector", async () => {
    expect(jira.writeback).toBe("agent");
    await expect(jira.getTask("T-1")).rejects.toBeInstanceOf(TrackerUnavailableError);
    await expect(jira.updateTask("T-1", {})).rejects.toBeInstanceOf(TrackerUnavailableError);
  });

  test("the instruction names the tracker, task, status and the no-priority rule", () => {
    const out = jira.writebackInstruction("T-1")!;
    expect(out).toContain("Jira task T-1");
    expect(out).toContain('"In Review"');
    expect(out).toContain("the URL of the review you just created");
    expect(out).toContain("Do NOT set a priority");
  });

  test("the instruction names a known review URL", () => {
    expect(jira.writebackInstruction("T-1", { reviewUrl: "https://review.example/7" })).toContain(
      "the review URL (https://review.example/7)"
    );
  });
});

describe("genericTrackerStatus", () => {
  const cases: Array<[TicketStatus, string]> = [
    ["proposed", "Backlog"],
    ["approved", "Backlog"],
    ["developing", "In Progress"],
    ["needs_review", "In Review"],
    ["shipped", "Resolved"],
    ["dismissed", "Cancelled"],
  ];
  for (const [status, expected] of cases) {
    test(`${status} → ${expected}`, () => expect(genericTrackerStatus(status)).toBe(expected));
  }
});
