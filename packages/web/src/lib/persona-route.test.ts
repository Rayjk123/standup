import { describe, expect, test } from "bun:test";
import type { PersonaJob } from "@standup/shared";
import { byRecentActivity, composerRoute, jobTaggableOn } from "./persona";

function job(id: string, threadId: string, status: PersonaJob["status"] = "active", minute = 0): PersonaJob {
  const at = `2026-10-06T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return { id, threadId, title: `Job ${id}`, goal: "", status, sessionIds: [], launchIds: [], createdAt: at, updatedAt: at } as unknown as PersonaJob;
}

describe("composerRoute — where the composer sends while the thread is filtered by job", () => {
  const console1 = job("c1", "console");
  const slack1 = job("s1", "slack-t");
  const closed = job("d1", "console", "done");
  const byId = new Map([console1, slack1, closed].map((j) => [j.id, j]));
  const onConsole = { id: "console", private: true };
  const onShared = { id: "slack-t", private: false };
  // A thread the threads list hasn't named yet (a first paint, the cached view).
  const onUnnamed = { id: "dm-t", private: undefined };

  test.each([
    ["unfiltered", [], true, onConsole, null],
    ["one job on a private thread", ["c1"], true, onConsole, { kind: "job", jobId: "c1" }],
    ["another thread's job on a private thread", ["s1"], true, onConsole, { kind: "job", jobId: "s1" }],
    ["a closed job the collector still knows", ["d1"], true, onConsole, { kind: "job", jobId: "d1" }],
    ["the shared thread's own job", ["s1"], true, onShared, { kind: "job", jobId: "s1" }],
    ["another thread's job on a shared thread", ["c1"], true, onShared, { kind: "untagged", reason: "otherThread", jobId: "c1" }],
    ["another thread's job while the thread's audience is unknown", ["c1"], true, onUnnamed, { kind: "job", jobId: "c1" }],
    ["a job missing from a loaded jobs list", ["gone"], true, onConsole, { kind: "untagged", reason: "unknown", jobId: "gone" }],
    ["a job missing before the jobs list loads", ["gone"], false, onConsole, { kind: "job", jobId: "gone" }],
    ["several jobs", ["c1", "d1"], true, onConsole, { kind: "untagged", reason: "several" }],
  ] as const)("%s", (_label, filter, jobsKnown, thread, want) => {
    const got = composerRoute(filter, byId, jobsKnown, thread);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatchObject(want);
  });

  test("jobTaggableOn follows the same rule for a # tag", () => {
    expect(jobTaggableOn(console1, onShared)).toBe(false);
    expect(jobTaggableOn(slack1, onShared)).toBe(true);
    expect(jobTaggableOn(slack1, onConsole)).toBe(true);
    expect(jobTaggableOn(console1, onUnnamed)).toBe(true);
  });
});

describe("byRecentActivity", () => {
  test("orders by last activity alone, whatever the state", () => {
    const jobs = [job("f-old", "t", "failed", 1), job("d-new", "t", "done", 9), job("x-mid", "t", "cancelled", 5)];
    expect(byRecentActivity(jobs).map((j) => j.id)).toEqual(["d-new", "x-mid", "f-old"]);
  });
});
