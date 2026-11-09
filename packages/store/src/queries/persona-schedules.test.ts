import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore } from "../store.js";
import {
  activePersonaScheduleRun,
  attachSessionToLaunch,
  cancelPersonaInbox,
  claimDuePersonaInbox,
  claimPersonaScheduleRun,
  createLaunch,
  createPersonaJob,
  createPersonaSchedule,
  createSession,
  deletePersonaSchedule,
  endSession,
  enqueuePersonaInbox,
  getOrCreatePersonaConsoleThread,
  getPersonaSchedule,
  getPersonaScheduleRun,
  linkPersonaJobLaunch,
  listDuePersonaSchedules,
  listPersonaScheduleRuns,
  listPersonaScheduleRunsByStatus,
  listPersonaSchedules,
  markPersonaInboxDone,
  nextPersonaScheduleDue,
  parkPersonaSchedule,
  personaInboxIdByCoalesceKey,
  prunePersonaScheduleRuns,
  reconcilePersonaScheduleRuns,
  settlePersonaScheduleRun,
  updateLaunchStatus,
  updatePersonaJob,
  updatePersonaSchedule,
  upsertProject,
} from "../index.js";
import type { CreatePersonaScheduleInput } from "./persona-schedules.js";

const OWNER = "alice";
const T0 = "2026-05-01T09:00:00.000Z";
const T1 = "2026-05-01T10:00:00.000Z";
const T2 = "2026-05-01T11:00:00.000Z";

function seed() {
  const store = createStore();
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

function schedule(db: ReturnType<typeof seed>["db"], input: Partial<CreatePersonaScheduleInput> = {}) {
  return createPersonaSchedule(db, {
    owner: OWNER,
    title: "nightly",
    cron: "0 * * * *",
    timezone: "UTC",
    kind: "launch_job",
    brief: "tidy up",
    createdBy: OWNER,
    nextRunAt: T0,
    ...input,
  });
}

function claim(db: ReturnType<typeof seed>["db"], scheduleId: string, slot: string, next: string | null, extra: { skipReason?: string } = {}) {
  return claimPersonaScheduleRun(db, {
    scheduleId,
    owner: OWNER,
    expectedNextRunAt: slot,
    scheduledFor: slot,
    trigger: "cron",
    nextRunAt: next,
    now: slot,
    ...extra,
  });
}

describe("persona schedules", () => {
  test("create, read, list and patch round-trip", () => {
    const { db } = seed();
    const a = schedule(db, { title: "b-later", nextRunAt: T1, model: "opus", effort: "high", projectId: "p" });
    const b = schedule(db, { title: "a-sooner", kind: "wake_persona", note: "check in", brief: undefined, nextRunAt: T0 });
    const paused = schedule(db, { title: "paused", enabled: false, nextRunAt: null });
    expect(a).toMatchObject({ owner: OWNER, kind: "launch_job", enabled: true, overlap: "skip", catchUp: "run_once", model: "opus" });
    expect(b.note).toBe("check in");
    expect(paused.nextRunAt).toBeUndefined();
    expect(listPersonaSchedules(db, OWNER).map((s) => s.title)).toEqual(["a-sooner", "b-later", "paused"]);
    expect(listPersonaSchedules(db, OWNER, { enabledOnly: true })).toHaveLength(2);
    expect(listPersonaSchedules(db, "bob")).toHaveLength(0);

    const patched = updatePersonaSchedule(db, a.id, { title: "renamed", enabled: false, nextRunAt: null, model: null });
    expect(patched).toMatchObject({ title: "renamed", enabled: false, model: undefined, nextRunAt: undefined });
    expect(updatePersonaSchedule(db, a.id, {})?.title).toBe("renamed");
    expect(updatePersonaSchedule(db, "missing", { title: "x" })).toBeNull();
  });

  test("due listing and the earliest next slot skip paused and parked schedules", () => {
    const { db } = seed();
    const a = schedule(db, { nextRunAt: T1 });
    const b = schedule(db, { nextRunAt: T0 });
    schedule(db, { nextRunAt: T0, enabled: false });
    schedule(db, { owner: "bob", nextRunAt: T0 });
    expect(listDuePersonaSchedules(db, OWNER, T0).map((s) => s.id)).toEqual([b.id]);
    expect(listDuePersonaSchedules(db, OWNER, T2).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(nextPersonaScheduleDue(db, OWNER)).toBe(T0);
    parkPersonaSchedule(db, b.id, "can't compute");
    expect(getPersonaSchedule(db, b.id)).toMatchObject({ nextRunAt: undefined, lastOutcome: "failed", lastOutcomeDetail: "can't compute" });
    expect(nextPersonaScheduleDue(db, OWNER)).toBe(T1);
    expect(nextPersonaScheduleDue(db, "carol")).toBeNull();
  });

  test("delete removes the schedule and its runs, only for its owner", () => {
    const { db } = seed();
    const s = schedule(db);
    claim(db, s.id, T0, T1);
    expect(deletePersonaSchedule(db, s.id, "bob")).toBe(false);
    expect(deletePersonaSchedule(db, s.id, OWNER)).toBe(true);
    expect(getPersonaSchedule(db, s.id)).toBeNull();
    expect(listPersonaScheduleRuns(db, s.id)).toHaveLength(0);
    expect(deletePersonaSchedule(db, s.id, OWNER)).toBe(false);
  });
});

describe("claimPersonaScheduleRun", () => {
  test("claims a slot: inserts a starting run and advances the schedule", () => {
    const { db } = seed();
    const s = schedule(db);
    const c = claim(db, s.id, T0, T1);
    expect(c.outcome).toBe("started");
    if (c.outcome === "stale") throw new Error("stale");
    expect(c.run).toMatchObject({ scheduleId: s.id, scheduledFor: T0, trigger: "cron", status: "starting", startedAt: T0 });
    expect(c.schedule).toMatchObject({ nextRunAt: T1, lastRunAt: T0, lastOutcome: "starting" });
  });

  test("a second claim of the same slot with the same expectation is stale", () => {
    const { db } = seed();
    const s = schedule(db);
    expect(claim(db, s.id, T0, T1).outcome).toBe("started");
    expect(claim(db, s.id, T0, T1).outcome).toBe("stale");
    expect(listPersonaScheduleRuns(db, s.id)).toHaveLength(1);
  });

  test("a slot already in the history is not run again, but the schedule moves past it", () => {
    const { db } = seed();
    const s = schedule(db);
    claim(db, s.id, T0, T1);
    // The schedule is pointed back at a slot it already ran (a clock set back, then an edit).
    updatePersonaSchedule(db, s.id, { nextRunAt: T0 });
    const again = claim(db, s.id, T0, T1);
    expect(again.outcome).toBe("stale");
    expect(listPersonaScheduleRuns(db, s.id)).toHaveLength(1);
    expect(getPersonaSchedule(db, s.id)?.nextRunAt).toBe(T1);
  });

  test("an edit or pause in between makes the claim stale", () => {
    const { db } = seed();
    const s = schedule(db);
    updatePersonaSchedule(db, s.id, { nextRunAt: T1 });
    expect(claim(db, s.id, T0, T1).outcome).toBe("stale");
    updatePersonaSchedule(db, s.id, { enabled: false });
    expect(claim(db, s.id, T1, T2).outcome).toBe("stale");
    expect(listPersonaScheduleRuns(db, s.id)).toHaveLength(0);
  });

  test("a missing schedule, or another owner's, is stale", () => {
    const { db } = seed();
    const s = schedule(db);
    expect(claimPersonaScheduleRun(db, { scheduleId: "nope", owner: OWNER, scheduledFor: T0, trigger: "manual", now: T0 }).outcome).toBe("stale");
    expect(claimPersonaScheduleRun(db, { scheduleId: s.id, owner: "bob", scheduledFor: T0, trigger: "manual", now: T0 }).outcome).toBe("stale");
  });

  test("a skip reason records the slot skipped and still advances", () => {
    const { db } = seed();
    const s = schedule(db);
    const c = claim(db, s.id, T0, T1, { skipReason: "missed" });
    expect(c.outcome).toBe("skipped");
    if (c.outcome === "stale") throw new Error("stale");
    expect(c.run).toMatchObject({ status: "skipped", reason: "missed", endedAt: T0 });
    expect(c.schedule).toMatchObject({ nextRunAt: T1, lastOutcome: "skipped", lastOutcomeDetail: "missed" });
  });

  test("overlap skip: a slot while the previous run is starting or running is skipped", () => {
    const { db } = seed();
    const s = schedule(db);
    const first = claim(db, s.id, T0, T1);
    if (first.outcome === "stale") throw new Error("stale");
    const second = claim(db, s.id, T1, T2);
    expect(second.outcome).toBe("skipped");
    if (second.outcome === "stale") throw new Error("stale");
    expect(second.run.reason).toBe(`the previous run (${first.run.id.slice(0, 8)}) is still starting`);
    settlePersonaScheduleRun(db, first.run.id, { status: "running" });
    const third = claim(db, s.id, T2, null);
    expect(third.outcome).toBe("skipped");
    if (third.outcome === "stale") throw new Error("stale");
    expect(third.run.reason).toContain("is still running");
    expect(activePersonaScheduleRun(db, s.id)?.id).toBe(first.run.id);
    expect(getPersonaSchedule(db, s.id)?.nextRunAt).toBeUndefined();
  });

  test("overlap allow: runs beside an active run", () => {
    const { db } = seed();
    const s = schedule(db, { overlap: "allow" });
    claim(db, s.id, T0, T1);
    expect(claim(db, s.id, T1, T2).outcome).toBe("started");
  });

  test("manual runs ignore next_run_at, don't move it, and sit outside the slot index", () => {
    const { db } = seed();
    const s = schedule(db, { overlap: "allow", enabled: false, nextRunAt: null });
    const manual = (now: string) =>
      claimPersonaScheduleRun(db, { scheduleId: s.id, owner: OWNER, scheduledFor: now, trigger: "manual", now, expectedNextRunAt: "ignored" });
    expect(manual(T0).outcome).toBe("started");
    expect(manual(T0).outcome).toBe("started");
    expect(listPersonaScheduleRuns(db, s.id)).toHaveLength(2);
    expect(getPersonaSchedule(db, s.id)).toMatchObject({ nextRunAt: undefined, lastRunAt: T0 });
  });

  test("two connections to one database claim a slot once", () => {
    const dir = mkdtempSync(join(tmpdir(), "persona-sched-"));
    try {
      const path = join(dir, "db.sqlite");
      const a = createStore(path);
      const b = createStore(path);
      const s = schedule(a.db);
      const outcomes = [claim(a.db, s.id, T0, T1).outcome, claim(b.db, s.id, T0, T1).outcome];
      expect(outcomes.sort()).toEqual(["stale", "started"]);
      expect(listPersonaScheduleRuns(b.db, s.id)).toHaveLength(1);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settlePersonaScheduleRun", () => {
  test("settles with links, and records the outcome only for the latest run", () => {
    const { db } = seed();
    const s = schedule(db, { overlap: "allow" });
    const a = claim(db, s.id, T0, T1);
    const b = claim(db, s.id, T1, T2);
    if (a.outcome === "stale" || b.outcome === "stale") throw new Error("stale");
    const settled = settlePersonaScheduleRun(db, a.run.id, { status: "failed", error: "boom" });
    expect(settled).toMatchObject({ status: "failed", error: "boom" });
    expect(settled?.endedAt).toEqual(expect.any(String));
    expect(getPersonaSchedule(db, s.id)?.lastOutcome).toBe("starting");
    settlePersonaScheduleRun(db, b.run.id, { status: "running", jobId: "j", launchId: "l" });
    expect(getPersonaScheduleRun(db, b.run.id)).toMatchObject({ jobId: "j", launchId: "l", endedAt: undefined });
    expect(getPersonaSchedule(db, s.id)?.lastOutcome).toBe("running");
    expect(settlePersonaScheduleRun(db, "missing", { status: "done" })).toBeNull();
  });

  test("a run set running again clears the end time and error recovery gave it", () => {
    const { db } = seed();
    const s = schedule(db);
    const c = claim(db, s.id, T0, T1);
    if (c.outcome === "stale") throw new Error("stale");
    settlePersonaScheduleRun(db, c.run.id, { status: "failed", error: "interrupted" });
    const resumed = settlePersonaScheduleRun(db, c.run.id, { status: "running", launchId: "l" });
    expect(resumed).toMatchObject({ status: "running", launchId: "l", error: undefined, endedAt: undefined });
    const done = settlePersonaScheduleRun(db, c.run.id, { status: "done", endedAt: T2 });
    expect(done).toMatchObject({ status: "done", launchId: "l", endedAt: T2 });
  });
});

describe("reconcilePersonaScheduleRuns", () => {
  function launched(store: ReturnType<typeof seed>, opts: { link?: boolean; session?: boolean } = {}) {
    const { db } = store;
    const s = schedule(db, { overlap: "allow" });
    const c = claim(db, s.id, T0, T1);
    if (c.outcome === "stale") throw new Error("stale");
    const launchId = `l-${c.run.id}`;
    createLaunch(db, { id: launchId, projectId: "p", task: "t", worktreePath: `/wt/${launchId}`, branch: "b" });
    const thread = getOrCreatePersonaConsoleThread(db, OWNER);
    const job = createPersonaJob(db, { owner: OWNER, threadId: thread.id, title: "j", goal: "g" });
    if (opts.link !== false) linkPersonaJobLaunch(db, job.id, launchId);
    const sessionId = `s-${c.run.id}`;
    if (opts.session) {
      createSession(db, { id: sessionId, projectId: "p", title: "w", cwd: "/wt", status: "running" });
      attachSessionToLaunch(db, launchId, sessionId);
    }
    settlePersonaScheduleRun(db, c.run.id, {
      status: "running",
      launchId,
      jobId: opts.link !== false ? job.id : undefined,
    });
    return { schedule: s, runId: c.run.id, launchId, jobId: job.id, sessionId };
  }

  test("a launch whose session hasn't bound yet stays running", () => {
    const store = seed();
    const r = launched(store);
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)).toHaveLength(0);
    expect(getPersonaScheduleRun(store.db, r.runId)?.status).toBe("running");
  });

  test("fills in the session once it binds, and stays running while it lives", () => {
    const store = seed();
    const r = launched(store, { session: true });
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)).toHaveLength(0);
    expect(getPersonaScheduleRun(store.db, r.runId)).toMatchObject({ status: "running", sessionId: r.sessionId });
  });

  test("settles done when the session ends", () => {
    const store = seed();
    const r = launched(store, { session: true });
    endSession(store.db, r.sessionId);
    const settled = reconcilePersonaScheduleRuns(store.db, OWNER, T1);
    expect(settled.map((x) => x.id)).toEqual([r.runId]);
    expect(settled[0]).toMatchObject({ status: "done", sessionId: r.sessionId });
    expect(settled[0]!.endedAt).toEqual(expect.any(String));
  });

  test("settles when the job closes, with the job's outcome", () => {
    const store = seed();
    const r = launched(store, { session: true });
    updatePersonaJob(store.db, r.jobId, { status: "done", outcome: "shipped" });
    const [settled] = reconcilePersonaScheduleRuns(store.db, OWNER, T1);
    expect(settled).toMatchObject({ id: r.runId, status: "done", reason: "job done: shipped", endedAt: T1 });
  });

  test("a failed job or launch settles failed", () => {
    const store = seed();
    const r = launched(store);
    updateLaunchStatus(store.db, r.launchId, "failed", "no worktree");
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)[0]).toMatchObject({ status: "failed", error: "no worktree" });
    const r2 = launched(store);
    updatePersonaJob(store.db, r2.jobId, { status: "failed" });
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)[0]).toMatchObject({ id: r2.runId, status: "failed" });
  });

  test("a job closed done records done though closing it stopped the worker (its launch reads failed)", () => {
    const store = seed();
    const r = launched(store, { session: true });
    // close_job: the job closes first, then its worker is stopped, which
    // records the launch failed ("Stopped by you") and ends the session.
    updatePersonaJob(store.db, r.jobId, { status: "done", outcome: "Host is healthy" });
    updateLaunchStatus(store.db, r.launchId, "failed", "Stopped by you");
    endSession(store.db, r.sessionId);
    const [settled] = reconcilePersonaScheduleRuns(store.db, OWNER, T1);
    expect(settled).toMatchObject({ id: r.runId, status: "done", reason: "job done: Host is healthy" });
    expect(getPersonaSchedule(store.db, r.schedule.id)).toMatchObject({ lastOutcome: "done", lastOutcomeDetail: "job done: Host is healthy" });

    // A job closed failed or cancelled the same way keeps its own verdict.
    const failedRun = launched(store);
    updatePersonaJob(store.db, failedRun.jobId, { status: "failed", outcome: "disk full" });
    updateLaunchStatus(store.db, failedRun.launchId, "failed", "Stopped by you");
    const cancelledRun = launched(store);
    updatePersonaJob(store.db, cancelledRun.jobId, { status: "cancelled" });
    updateLaunchStatus(store.db, cancelledRun.launchId, "failed", "Stopped by you");
    const byId = new Map(reconcilePersonaScheduleRuns(store.db, OWNER, T1).map((x) => [x.id, x]));
    expect(byId.get(failedRun.runId)).toMatchObject({ status: "failed", reason: "job failed: disk full", error: undefined });
    expect(byId.get(cancelledRun.runId)).toMatchObject({ status: "done", reason: "job cancelled" });
  });

  test("a recovered run whose launch has no job yet is not settled early, and picks up the job once linked", () => {
    const store = seed();
    const r = launched(store, { link: false });
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)).toHaveLength(0);
    expect(getPersonaScheduleRun(store.db, r.runId)).toMatchObject({ status: "running", jobId: undefined });
    linkPersonaJobLaunch(store.db, r.jobId, r.launchId);
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)).toHaveLength(0);
    expect(getPersonaScheduleRun(store.db, r.runId)?.jobId).toBe(r.jobId);
  });

  test("a jobless run settles when its launch goes", () => {
    const store = seed();
    const r = launched(store, { link: false, session: true });
    endSession(store.db, r.sessionId);
    expect(reconcilePersonaScheduleRuns(store.db, OWNER, T1)[0]).toMatchObject({ id: r.runId, status: "done" });
  });

  test("a wake run settles when its inbox item is done, failed or cancelled", () => {
    const { db } = seed();
    const s = schedule(db, { kind: "wake_persona", note: "n", brief: undefined, overlap: "allow" });
    const wake = (slot: string, next: string) => {
      const c = claim(db, s.id, slot, next);
      if (c.outcome === "stale") throw new Error("stale");
      const { item } = enqueuePersonaInbox(db, { owner: OWNER, kind: "schedule", payload: {}, coalesceKey: `k-${c.run.id}` });
      settlePersonaScheduleRun(db, c.run.id, { status: "running", inboxId: item.id });
      return { runId: c.run.id, itemId: item.id };
    };
    const a = wake(T0, T1);
    const b = wake(T1, T2);
    expect(reconcilePersonaScheduleRuns(db, OWNER, T2)).toHaveLength(0);
    // A turn claims the item before it marks it done.
    expect(claimDuePersonaInbox(db, OWNER, undefined, 1).map((i) => i.id)).toEqual([a.itemId]);
    expect(reconcilePersonaScheduleRuns(db, OWNER, T2)).toHaveLength(0);
    markPersonaInboxDone(db, [a.itemId]);
    cancelPersonaInbox(db, b.itemId, OWNER);
    const settled = reconcilePersonaScheduleRuns(db, OWNER, T2);
    expect(settled.find((x) => x.id === a.runId)?.status).toBe("done");
    expect(settled.find((x) => x.id === b.runId)).toMatchObject({ status: "done", reason: "the wake was cancelled" });
    expect(personaInboxIdByCoalesceKey(db, OWNER, `k-${a.runId}`)).toBe(a.itemId);
    expect(personaInboxIdByCoalesceKey(db, "bob", `k-${a.runId}`)).toBeNull();
  });

  test("leaves starting runs alone", () => {
    const { db } = seed();
    const s = schedule(db);
    claim(db, s.id, T0, T1);
    expect(reconcilePersonaScheduleRuns(db, OWNER, T2)).toHaveLength(0);
    expect(listPersonaScheduleRunsByStatus(db, OWNER, ["starting"])).toHaveLength(1);
    expect(listPersonaScheduleRunsByStatus(db, OWNER, [])).toHaveLength(0);
  });
});

describe("prunePersonaScheduleRuns", () => {
  test("drops old settled runs beyond each schedule's newest `keep`, never active ones", () => {
    const { db } = seed();
    const a = schedule(db, { overlap: "allow" });
    const b = schedule(db, { overlap: "allow" });
    const slots = Array.from({ length: 6 }, (_, i) => new Date(Date.parse("2026-01-01T00:00:00Z") + i * 3_600_000).toISOString());
    const ids: string[] = [];
    for (let i = 0; i < slots.length; i++) {
      for (const s of [a, b]) {
        updatePersonaSchedule(db, s.id, { nextRunAt: slots[i] });
        const c = claim(db, s.id, slots[i]!, null);
        if (c.outcome === "stale") throw new Error("stale");
        if (s === a) ids.push(c.run.id);
        if (i > 0) settlePersonaScheduleRun(db, c.run.id, { status: "done" });
      }
    }
    // The oldest run of each schedule is still starting.
    const removed = prunePersonaScheduleRuns(db, OWNER, "2026-06-01T00:00:00Z", 2);
    expect(removed).toBe(6);
    const left = listPersonaScheduleRuns(db, a.id).map((r) => r.id);
    expect(left.sort()).toEqual([ids[0]!, ids[4]!, ids[5]!].sort());
    expect(listPersonaScheduleRuns(db, b.id)).toHaveLength(3);
  });

  test("keeps recent runs and other owners' runs", () => {
    const { db } = seed();
    const s = schedule(db);
    const other = schedule(db, { owner: "bob" });
    const c = claim(db, s.id, T0, T1, { skipReason: "x" });
    claimPersonaScheduleRun(db, {
      scheduleId: other.id, owner: "bob", expectedNextRunAt: T0, scheduledFor: T0, trigger: "cron", nextRunAt: T1, now: T0, skipReason: "x",
    });
    expect(c.outcome).toBe("skipped");
    expect(prunePersonaScheduleRuns(db, OWNER, "2026-04-01T00:00:00Z", 0)).toBe(0);
    expect(prunePersonaScheduleRuns(db, OWNER, "2026-06-01T00:00:00Z", 0)).toBe(1);
    expect(listPersonaScheduleRuns(db, other.id)).toHaveLength(1);
  });
});
