import { describe, expect, test } from "bun:test";
import { createStore } from "../store.js";
import {
  enqueuePersonaLaunch,
  findQueuedPersonaLaunch,
  getPersonaQueuedLaunch,
  listQueuedPersonaLaunches,
  personaLaunchQueuePosition,
  settlePersonaQueuedLaunch,
} from "./persona-launch-queue.js";

describe("persona launch queue", () => {
  test("queues oldest first, per owner, and keeps the arguments", () => {
    const { db } = createStore();
    const a = enqueuePersonaLaunch(db, { owner: "o", threadId: "t", args: { task: "a", projectId: "p" }, task: "a", reason: "cap" }, new Date(1000));
    const b = enqueuePersonaLaunch(db, { owner: "o", args: { task: "b" }, task: "b", reason: "budget", scheduleRunId: "run1" }, new Date(2000));
    enqueuePersonaLaunch(db, { owner: "other", args: { task: "c" }, task: "c", reason: "cap" });
    expect(listQueuedPersonaLaunches(db, "o").map((q) => q.id)).toEqual([a.id, b.id]);
    expect(getPersonaQueuedLaunch(db, a.id)).toMatchObject({ threadId: "t", args: { task: "a", projectId: "p" }, status: "queued" });
    expect(getPersonaQueuedLaunch(db, b.id)?.scheduleRunId).toBe("run1");
    expect(personaLaunchQueuePosition(db, b.id)).toBe(1);
  });

  test("finds a waiting launch of the same task from the same thread", () => {
    const { db } = createStore();
    const a = enqueuePersonaLaunch(db, { owner: "o", threadId: "t", args: {}, task: "fix it", reason: "cap" });
    expect(findQueuedPersonaLaunch(db, "o", "t", "fix it")?.id).toBe(a.id);
    expect(findQueuedPersonaLaunch(db, "o", "u", "fix it")).toBeNull();
    expect(findQueuedPersonaLaunch(db, "o", "t", "other")).toBeNull();
  });

  test("settles a queued row once", () => {
    const { db } = createStore();
    const a = enqueuePersonaLaunch(db, { owner: "o", args: {}, task: "x", reason: "cap" });
    const started = settlePersonaQueuedLaunch(db, a.id, { status: "started", launchId: "l1", jobId: "j1" });
    expect(started).toMatchObject({ status: "started", launchId: "l1", jobId: "j1" });
    expect(settlePersonaQueuedLaunch(db, a.id, { status: "failed", error: "late" })).toBeNull();
    expect(listQueuedPersonaLaunches(db, "o")).toEqual([]);
    expect(personaLaunchQueuePosition(db, a.id)).toBe(-1);
  });
});
