import { describe, expect, test } from "bun:test";
import type { PersonaJob, PersonaMessage } from "@standup/shared";
import { RECENT_CLOSED_JOBS, filterOptions } from "./MessageJobTags";

function job(id: string, status: PersonaJob["status"], minute: number): PersonaJob {
  const at = `2026-10-06T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return { id, title: `Job ${id}`, goal: "", status, sessionIds: [], launchIds: [], createdAt: at, updatedAt: at } as unknown as PersonaJob;
}

function tagged(seq: number, jobIds: string[]): PersonaMessage {
  return { id: `m${seq}`, threadId: "t1", seq, role: "persona", text: "", createdAt: "2026-10-06T12:00:00.000Z", jobIds };
}

const ids = (options: { jobId: string }[]) => options.map((o) => o.jobId);

describe("filterOptions", () => {
  // Ten closed jobs, c0 the oldest; two open ones.
  const closed = Array.from({ length: 10 }, (_, i) => job(`c${i}`, "done", i));
  const open = [job("a1", "active", 20), job("a2", "waiting_user", 21)];
  const jobs = [...closed, ...open];
  const byId = new Map(jobs.map((j) => [j.id, j]));

  test("lists open jobs first, then the most recently active closed ones up to the cap", () => {
    const { active, closed: shown } = filterOptions([], jobs, byId, []);
    expect(ids(active)).toEqual(["a2", "a1"]);
    expect(ids(shown)).toEqual(["c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2"]);
    expect(shown).toHaveLength(RECENT_CLOSED_JOBS);
  });

  test("an old closed job past the cap still lists when the thread is tagged with it or it is selected", () => {
    const { closed: shown } = filterOptions([tagged(1, ["c0"])], jobs, byId, ["c1"]);
    expect(ids(shown)).toEqual(["c9", "c8", "c7", "c6", "c5", "c4", "c3", "c2", "c1", "c0"]);
    expect(shown.find((o) => o.jobId === "c0")!.count).toBe(1);
    expect(shown.find((o) => o.jobId === "c1")!.count).toBeUndefined();
  });

  test("the recent cap goes by last activity, not by closed state", () => {
    // Eight older failed jobs and one newer done job: the done job is among the eight most recent.
    const failed = Array.from({ length: 8 }, (_, i) => job(`f${i}`, "failed", i));
    const done = job("d-new", "done", 30);
    const all = [...failed, done];
    const { closed: shown } = filterOptions([], all, new Map(all.map((j) => [j.id, j])), []);
    expect(ids(shown)).toEqual(["d-new", "f7", "f6", "f5", "f4", "f3", "f2", "f1"]);
  });

  test("counts the thread's tagged messages per job, and lists tagged or selected unknown jobs last", () => {
    const messages = [tagged(1, ["a1", "gone"]), tagged(2, ["a1"])];
    const { active, closed: shown } = filterOptions(messages, jobs, byId, ["lost"]);
    expect(active.map((o) => [o.jobId, o.count])).toEqual([
      ["a2", undefined],
      ["a1", 2],
    ]);
    expect(ids(shown).slice(-2)).toEqual(["gone", "lost"]);
    expect(shown.at(-1)!.job).toBeUndefined();
  });
});
