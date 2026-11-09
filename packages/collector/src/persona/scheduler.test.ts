import { describe, expect, test } from "bun:test";
import {
  claimPersonaScheduleRun,
  createLaunch,
  createStore,
  enqueuePersonaInbox,
  getOrCreatePersonaConsoleThread,
  getPersonaSchedule,
  listPersonaScheduleRuns,
  listPersonaSchedules,
  upsertProject,
} from "@standup/store";
import type { PersonaSchedule, PersonaScheduleRun, WsMessage } from "@standup/shared";
import { MAX_RUNS_LIMIT, MISS_GRACE_MS, PersonaScheduler, scheduleRunLaunchKey, scheduleRunWakeKey } from "./scheduler.js";
import type { ScheduledLaunchOutcome, SchedulerDeps } from "./scheduler.js";

const OWNER = "alice";
const HOUR = 60 * 60 * 1000;

interface Harness {
  db: ReturnType<typeof createStore>["db"];
  scheduler: PersonaScheduler;
  clock: { now: Date };
  wakes: Array<{ schedule: PersonaSchedule; run: PersonaScheduleRun; threadId: string }>;
  launches: Array<{ schedule: PersonaSchedule; run: PersonaScheduleRun; approved: boolean }>;
  notices: PersonaScheduleRun[];
  frames: WsMessage[];
  state: { paused: boolean; canFire: boolean; launch: ScheduledLaunchOutcome };
}

/** A scheduler over its own store (or `shared`'s), with recording fakes for every dependency. */
function harness(opts: { shared?: Harness; at?: string; deps?: Partial<SchedulerDeps> } = {}): Harness {
  const db = opts.shared?.db ?? createStore(":memory:").db;
  if (!opts.shared) upsertProject(db, { id: "p", name: "p", branch: "main", repos: ["/repo/p"] });
  const clock = opts.shared?.clock ?? { now: new Date(opts.at ?? "2026-05-01T08:30:00.000Z") };
  const h = {
    db,
    clock,
    wakes: [],
    launches: [],
    notices: [],
    frames: [],
    state: { paused: false, canFire: true, launch: { status: "launched", jobId: "job-1", launchId: "launch-1" } },
  } as unknown as Harness;
  h.scheduler = new PersonaScheduler({
    db,
    owner: OWNER,
    now: () => clock.now,
    defaultTimezone: () => "America/New_York",
    launch: async (schedule, run, launchOpts) => {
      h.launches.push({ schedule, run, approved: launchOpts.approved });
      return h.state.launch;
    },
    wake: (schedule, run, threadId) => {
      h.wakes.push({ schedule, run, threadId });
      return enqueuePersonaInbox(db, { owner: OWNER, kind: "schedule", payload: {}, threadId, coalesceKey: scheduleRunWakeKey(run.id) }).item.id;
    },
    notify: (_schedule, run) => void h.notices.push(run),
    canFire: () => h.state.canFire,
    isPaused: () => h.state.paused,
    broadcast: (m) => void h.frames.push(m),
    ...opts.deps,
  });
  return h;
}

function wake(h: Harness, fields: Record<string, unknown> = {}): PersonaSchedule {
  const r = h.scheduler.create(
    { title: "Hourly check", cron: "0 * * * *", timezone: "UTC", kind: "wake_persona", note: "check the fleet", ...fields },
    { createdBy: "persona" }
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function job(h: Harness, fields: Record<string, unknown> = {}): PersonaSchedule {
  return wake(h, { kind: "launch_job", note: undefined, brief: "Run the tests and report.", projectId: "p", ...fields });
}

describe("PersonaScheduler: create and update", () => {
  test("create computes the next slot and defaults the timezone to the owner's", () => {
    const h = harness();
    const s = wake(h, { timezone: undefined, cron: "0 9 * * *" });
    expect(s.timezone).toBe("America/New_York");
    // 09:00 New York (EDT, UTC-4) on 2026-05-01 is 13:00Z.
    expect(s.nextRunAt).toBe("2026-05-01T13:00:00.000Z");
    expect(h.frames.at(-1)?.type).toBe("persona:schedule");
  });

  test("create rejects bad input", () => {
    const h = harness();
    const bad = (fields: Record<string, unknown>) => {
      const r = h.scheduler.create(
        { title: "t", cron: "0 * * * *", timezone: "UTC", kind: "wake_persona", note: "n", ...fields },
        { createdBy: "persona" }
      );
      return r.ok ? null : r.error;
    };
    expect(bad({ cron: "* * * * *" })).toContain("5 minutes");
    expect(bad({ cron: "0 9 * *" })).toContain("five fields");
    expect(bad({ timezone: "Mars/Olympus" })).toContain("unknown timezone");
    expect(bad({ note: undefined })).toContain("note is required");
    expect(bad({ kind: "launch_job", note: undefined })).toContain("brief is required");
    expect(bad({ kind: "launch_job", brief: "b", projectId: "nope" })).toContain("not a registered");
    expect(bad({ kind: "other" })).toContain("kind must be one of");
    expect(bad({ cron: "*/5 * * * *" })).toBeNull();
  });

  test("pausing clears the next slot; resuming starts from now, not from the missed slots", () => {
    const h = harness();
    const s = wake(h);
    const paused = h.scheduler.update(s.id, { enabled: false });
    expect(paused.ok && paused.value.nextRunAt).toBeUndefined();
    h.clock.now = new Date("2026-05-01T12:10:00.000Z");
    const resumed = h.scheduler.update(s.id, { enabled: true });
    expect(resumed.ok && resumed.value.nextRunAt).toBe("2026-05-01T13:00:00.000Z");
  });

  test("an update can't change the kind or give a wake_persona schedule a brief", () => {
    const h = harness();
    const s = wake(h);
    const kind = h.scheduler.update(s.id, { kind: "launch_job" });
    expect(!kind.ok && kind.error).toContain("kind can't be changed");
    const brief = h.scheduler.update(s.id, { brief: "do it" });
    expect(!brief.ok && brief.error).toContain("only to launch_job");
  });

  test("pipeline: launch_job keeps false (absent means on); wake_persona refuses it; non-booleans are rejected", () => {
    const h = harness();
    const off = job(h, { pipeline: false });
    expect(off.pipeline).toBe(false);
    expect(getPersonaSchedule(h.db, off.id)?.pipeline).toBe(false);
    expect(job(h, { title: "Default" }).pipeline).toBeUndefined();
    expect(job(h, { title: "Explicit on", pipeline: true }).pipeline).toBeUndefined();

    const restored = h.scheduler.update(off.id, { pipeline: true });
    expect(restored.ok && restored.value.pipeline).toBeUndefined();
    const offAgain = h.scheduler.update(off.id, { pipeline: false });
    expect(offAgain.ok && offAgain.value.pipeline).toBe(false);

    expect(() => wake(h, { pipeline: false })).toThrow("pipeline applies only to launch_job");
    const w = wake(h);
    const onWake = h.scheduler.update(w.id, { pipeline: false });
    expect(!onWake.ok && onWake.error).toContain("pipeline applies only to launch_job");
    const notBool = h.scheduler.update(off.id, { pipeline: "no" });
    expect(!notBool.ok && notBool.error).toContain("pipeline must be a boolean");
  });
});

describe("PersonaScheduler: firing", () => {
  test("a due wake_persona slot wakes Persona once and advances to the next slot", async () => {
    const h = harness();
    const s = wake(h);
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(0);

    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.threadId).toBe(getOrCreatePersonaConsoleThread(h.db, OWNER).id);
    const [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run).toMatchObject({ trigger: "cron", status: "running", scheduledFor: "2026-05-01T09:00:00.000Z" });
    expect(run!.inboxId).toBeTruthy();
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-01T10:00:00.000Z");
  });

  test("two collectors on one database fire a slot once", async () => {
    const a = harness();
    const s = wake(a);
    const b = harness({ shared: a });
    a.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
    // A restarted collector reaching the same slot again finds it taken.
    const c = harness({ shared: a });
    await c.scheduler.tick();
    expect(a.wakes.length + b.wakes.length + c.wakes.length).toBe(1);
    expect(listPersonaScheduleRuns(a.db, s.id)).toHaveLength(1);
  });

  test("a claimed slot is never re-run after a restart, even with next_run_at rolled back", async () => {
    const h = harness({ at: "2026-05-01T09:00:10.000Z" });
    const s = wake(h, { cron: "0 9 * * *" });
    // Created after 09:00 the next slot is tomorrow; force today's back in.
    h.db.run("UPDATE persona_schedules SET next_run_at = ? WHERE id = ?", ["2026-05-01T09:00:00.000Z", s.id]);
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(1);
    h.db.run("UPDATE persona_schedules SET next_run_at = ? WHERE id = ?", ["2026-05-01T09:00:00.000Z", s.id]);
    const restarted = harness({ shared: h });
    await restarted.scheduler.tick();
    expect(restarted.wakes).toHaveLength(0);
    expect(listPersonaScheduleRuns(h.db, s.id)).toHaveLength(1);
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-02T09:00:00.000Z");
  });

  test("missed slots run once (run_once): the latest, as a catch-up", async () => {
    const h = harness();
    const s = wake(h);
    h.clock.now = new Date("2026-05-01T13:20:00.000Z");
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(1);
    const runs = listPersonaScheduleRuns(h.db, s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "catch_up", scheduledFor: "2026-05-01T13:00:00.000Z", status: "running" });
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-01T14:00:00.000Z");
  });

  test("missed slots are recorded skipped under catchUp skip", async () => {
    const h = harness();
    const s = wake(h, { catchUp: "skip" });
    h.clock.now = new Date("2026-05-01T13:20:00.000Z");
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(0);
    const [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run).toMatchObject({ trigger: "catch_up", status: "skipped" });
    expect(run!.reason).toContain("missed 5 runs");
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-01T14:00:00.000Z");
  });

  test("a slot reached within the grace window is on time", async () => {
    const h = harness();
    const s = wake(h);
    h.clock.now = new Date(Date.parse("2026-05-01T09:00:00.000Z") + MISS_GRACE_MS - 1000);
    await h.scheduler.tick();
    expect(listPersonaScheduleRuns(h.db, s.id)[0]!.trigger).toBe("cron");
  });

  test("nothing fires while the collector is quiescing", async () => {
    const h = harness();
    const s = wake(h);
    h.state.canFire = false;
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    expect(h.wakes).toHaveLength(0);
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-01T09:00:00.000Z");
  });
});

describe("PersonaScheduler: launch_job runs", () => {
  test("a launched run is running with its job and launch, unapproved", async () => {
    const h = harness();
    const s = job(h);
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.approved).toBe(false);
    expect(listPersonaScheduleRuns(h.db, s.id)[0]).toMatchObject({ status: "running", jobId: "job-1", launchId: "launch-1" });
    expect(h.notices).toHaveLength(0);
  });

  test("a schedule saved with pipeline false fires its launch with pipeline false", async () => {
    const h = harness();
    job(h, { pipeline: false });
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.schedule.pipeline).toBe(false);
  });

  test("a held launch is skipped and Persona is told; an error fails the run", async () => {
    const h = harness();
    const s = job(h);
    h.state.launch = { status: "held", reason: "the owner holds launch_session for approval (STANDUP_PERSONA_HOLD)" };
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    let [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run).toMatchObject({ status: "skipped" });
    expect(run!.reason).toContain("held: the owner holds launch_session");
    expect(h.notices.map((n) => n.status)).toEqual(["skipped"]);

    h.state.launch = { status: "error", error: "git worktree add failed" };
    h.clock.now = new Date("2026-05-01T10:00:10.000Z");
    await h.scheduler.tick();
    [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run).toMatchObject({ status: "failed", error: "git worktree add failed" });
    expect(getPersonaSchedule(h.db, s.id)!.lastOutcome).toBe("failed");
  });

  test("while Persona is paused a launch_job slot is skipped, a wake_persona one still fires", async () => {
    const h = harness();
    const launch = job(h);
    const w = wake(h);
    h.state.paused = true;
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    expect(h.launches).toHaveLength(0);
    expect(listPersonaScheduleRuns(h.db, launch.id)[0]!.status).toBe("skipped");
    expect(h.wakes).toHaveLength(1);
    expect(listPersonaScheduleRuns(h.db, w.id)[0]!.status).toBe("running");
  });

  test("overlap skip: a slot is skipped while the previous run is still active; allow runs beside it", async () => {
    const h = harness();
    const skip = job(h);
    const allow = job(h, { title: "allow", overlap: "allow" });
    // A live launch behind the fake's "launch-1", so reconcile keeps its runs active.
    createLaunch(h.db, { id: "launch-1", projectId: "p", task: "t", worktreePath: "/wt/launch-1", branch: "b", status: "running" });
    h.clock.now = new Date("2026-05-01T09:00:10.000Z");
    await h.scheduler.tick();
    h.clock.now = new Date("2026-05-01T10:00:10.000Z");
    await h.scheduler.tick();
    expect(listPersonaScheduleRuns(h.db, skip.id).map((r) => r.status)).toEqual(["skipped", "running"]);
    expect(listPersonaScheduleRuns(h.db, allow.id).map((r) => r.status)).toEqual(["running", "running"]);
  });

  test("run now is manual, takes no slot and passes `approved` through", async () => {
    const h = harness();
    const s = job(h);
    const r = await h.scheduler.runNow(s.id, { approved: true });
    expect(r.ok && r.value).toMatchObject({ trigger: "manual", status: "running" });
    expect(h.launches[0]!.approved).toBe(true);
    expect(getPersonaSchedule(h.db, s.id)!.nextRunAt).toBe("2026-05-01T09:00:00.000Z");
    const missing = await h.scheduler.runNow("nope", { approved: false });
    expect(!missing.ok && missing.status).toBe(404);
  });
});

describe("PersonaScheduler: recovering runs a dead collector left starting", () => {
  function starting(h: Harness, s: PersonaSchedule): PersonaScheduleRun {
    const claim = claimPersonaScheduleRun(h.db, {
      scheduleId: s.id,
      owner: OWNER,
      expectedNextRunAt: s.nextRunAt,
      scheduledFor: s.nextRunAt!,
      trigger: "cron",
      nextRunAt: new Date(Date.parse(s.nextRunAt!) + HOUR).toISOString(),
      now: h.clock.now.toISOString(),
    });
    if (claim.outcome !== "started") throw new Error(claim.outcome);
    return claim.run;
  }

  test("a run whose launch went through is linked, not launched again", () => {
    const h = harness();
    const s = job(h);
    const run = starting(h, s);
    createLaunch(h.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt/L1", branch: "b", idempotencyKey: scheduleRunLaunchKey(run.id) });
    h.scheduler.recoverStarting(0);
    expect(listPersonaScheduleRuns(h.db, s.id)[0]).toMatchObject({ status: "running", launchId: "L1" });
    expect(h.launches).toHaveLength(0);
  });

  test("a wake whose inbox item was queued is linked", () => {
    const h = harness();
    const s = wake(h);
    const run = starting(h, s);
    const item = enqueuePersonaInbox(h.db, { owner: OWNER, kind: "schedule", payload: {}, coalesceKey: scheduleRunWakeKey(run.id) }).item;
    h.scheduler.recoverStarting(0);
    expect(listPersonaScheduleRuns(h.db, s.id)[0]).toMatchObject({ status: "running", inboxId: item.id });
  });

  test("a run that got nowhere is failed and never retried; a fresh one is left for its starter", async () => {
    const h = harness();
    const s = job(h);
    starting(h, s);
    h.scheduler.recoverStarting(5 * 60 * 1000);
    expect(listPersonaScheduleRuns(h.db, s.id)[0]!.status).toBe("starting");
    h.scheduler.recoverStarting(0);
    const [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("not retried");
    await h.scheduler.tick();
    expect(h.launches).toHaveLength(0);
  });
});

/** Ticks with the clock at `iso`. */
async function tickAt(h: Harness, iso: string): Promise<void> {
  h.clock.now = new Date(iso);
  await h.scheduler.tick();
}

describe("PersonaScheduler: end bound (endsAt / maxRuns)", () => {
  test("create refuses a bound that leaves no run, rather than saving it already ended", () => {
    const h = harness();
    const bad = (fields: Record<string, unknown>) => {
      const r = h.scheduler.create(
        { title: "t", cron: "0 * * * *", timezone: "UTC", kind: "wake_persona", note: "n", ...fields },
        { createdBy: "persona" }
      );
      return r.ok ? null : r.error;
    };
    expect(bad({ endsAt: "2026-05-01T08:00:00Z" })).toContain("already passed");
    // Now is 08:30Z: the first slot, 09:00Z, is after 08:50Z.
    expect(bad({ endsAt: "2026-05-01T08:50:00Z" })).toContain("no run falls at or before endsAt");
    expect(bad({ endsAt: "next tuesday" })).toContain("ISO date-time");
    expect(bad({ endsAt: "2026-02-30T09:00" })).toContain("ISO date-time");
    expect(bad({ endsAt: 12 })).toContain("endsAt must be");
    for (const maxRuns of [0, -1, 1.5, "2", MAX_RUNS_LIMIT + 1]) expect(bad({ maxRuns })).toContain("maxRuns must be");
    expect(bad({ endsAt: "2026-05-01T09:00:00Z" })).toBeNull();
    expect(bad({ maxRuns: 1 })).toBeNull();
    expect(bad({ endsAt: null, maxRuns: null })).toBeNull();
  });

  test("maxRuns counts runs that started; the last one ends the schedule, kept and listed", async () => {
    const h = harness();
    const s = wake(h, { maxRuns: 2, overlap: "allow" });
    expect(s).toMatchObject({ maxRuns: 2, runCount: 0, enabled: true });
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, nextRunAt: "2026-05-01T10:00:00.000Z", enabled: true });

    await tickAt(h, "2026-05-01T10:00:10.000Z");
    const ended = getPersonaSchedule(h.db, s.id)!;
    expect(ended).toMatchObject({ runCount: 2, enabled: false, endReason: "max_runs", endedAt: "2026-05-01T10:00:10.000Z" });
    expect(ended.nextRunAt).toBeUndefined();
    expect(h.frames.at(-1)?.payload).toMatchObject({ id: s.id, endReason: "max_runs" });

    await tickAt(h, "2026-05-01T11:00:10.000Z");
    await tickAt(h, "2026-05-01T12:00:10.000Z");
    expect(h.wakes.map((w) => w.run.trigger)).toEqual(["cron", "cron"]);
    // Run now past the end still runs, outside the bound: not counted, still ended.
    const manual = await h.scheduler.runNow(s.id, { approved: true });
    expect(manual.ok).toBe(true);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 2, enabled: false, endReason: "max_runs" });
    expect(listPersonaScheduleRuns(h.db, s.id)).toHaveLength(3);
    expect(listPersonaSchedules(h.db, OWNER).map((x) => x.id)).toContain(s.id);
  });

  test("Run now counts toward maxRuns before the end and can use up its last run", async () => {
    const h = harness();
    const s = wake(h, { maxRuns: 2, overlap: "allow" });
    await h.scheduler.runNow(s.id, { approved: true });
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, enabled: true, nextRunAt: "2026-05-01T09:00:00.000Z" });
    await h.scheduler.runNow(s.id, { approved: true });
    const ended = getPersonaSchedule(h.db, s.id)!;
    expect(ended).toMatchObject({ runCount: 2, enabled: false, endReason: "max_runs" });
    expect(ended.nextRunAt).toBeUndefined();
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(h.wakes.map((w) => w.run.trigger)).toEqual(["manual", "manual"]);
  });

  test("a refused Run now that ended a paused schedule gives its count back and leaves it paused", async () => {
    const h = harness();
    const s = job(h, { maxRuns: 1, enabled: false });
    h.state.launch = { status: "refused", reason: "not launchable" };
    const run = await h.scheduler.runNow(s.id, { approved: true });
    expect(run.ok && run.value.status).toBe("skipped");
    const after = getPersonaSchedule(h.db, s.id)!;
    expect(after).toMatchObject({ runCount: 0, enabled: false });
    expect(after.endedAt).toBeUndefined();
    expect(after.nextRunAt).toBeUndefined();
  });

  test("a queued launch that never starts gives its count back once; an unreadable schedule stays ended", async () => {
    const h = harness();
    const s = job(h, { maxRuns: 1, overlap: "allow" });
    h.state.launch = { status: "queued", reason: "at the active cap", queueId: "q1" };
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    // Queued counts: it starts on its own later.
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, enabled: false, endReason: "max_runs" });
    const [run] = listPersonaScheduleRuns(h.db, s.id);

    // The queue then fails to start it.
    h.clock.now = new Date("2026-05-01T09:20:00.000Z");
    h.scheduler.releaseRunCount(run!.id);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 0, enabled: true, nextRunAt: "2026-05-01T10:00:00.000Z" });
    h.scheduler.releaseRunCount(run!.id);
    expect(getPersonaSchedule(h.db, s.id)!.runCount).toBe(0);

    // With its next slot unreadable, a release leaves it ended rather than "on" with no next run.
    await tickAt(h, "2026-05-01T10:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, endReason: "max_runs" });
    const second = listPersonaScheduleRuns(h.db, s.id)[0]!;
    h.db.run("UPDATE persona_schedules SET timezone = 'Mars/Olympus' WHERE id = ?", [s.id]);
    h.scheduler.releaseRunCount(second.id);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 0, enabled: false, endReason: "max_runs" });
  });

  test("a skipped slot doesn't count toward maxRuns", async () => {
    const h = harness();
    // overlap skip: the first wake is still pending, so the 10:00 slot is skipped.
    const s = wake(h, { maxRuns: 2 });
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    await tickAt(h, "2026-05-01T10:00:10.000Z");
    expect(listPersonaScheduleRuns(h.db, s.id).map((r) => r.status)).toEqual(["skipped", "running"]);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, enabled: true, nextRunAt: "2026-05-01T11:00:00.000Z" });
  });

  test("a launch held or refused by policy gives its count back, reopening a schedule it had ended", async () => {
    const h = harness();
    const s = job(h, { maxRuns: 1, overlap: "allow" });
    h.state.launch = { status: "held", reason: "the brief needs the owner" };
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(listPersonaScheduleRuns(h.db, s.id)[0]).toMatchObject({ status: "skipped" });
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 0, enabled: true, nextRunAt: "2026-05-01T10:00:00.000Z" });
    expect(getPersonaSchedule(h.db, s.id)!.endedAt).toBeUndefined();

    h.state.launch = { status: "refused", reason: "not launchable" };
    await tickAt(h, "2026-05-01T10:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 0, enabled: true });

    // A failed launch fired, so it counts.
    h.state.launch = { status: "error", error: "boom" };
    await tickAt(h, "2026-05-01T11:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 1, enabled: false, endReason: "max_runs" });
  });

  test("a held last run inside endsAt stays ended for the end time, not reopened past it", async () => {
    const h = harness();
    const s = job(h, { maxRuns: 1, endsAt: "2026-05-01T09:30:00Z" });
    h.state.launch = { status: "held", reason: "the brief needs the owner" };
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 0, enabled: false, endReason: "ends_at" });
  });

  test("an ended schedule resumes on a new cadence that leaves it a run before endsAt; one that doesn't stays ended", async () => {
    const h = harness();
    // Daily at 09:00 UTC with endsAt that evening: the 09:00 run leaves no slot before it.
    const s = wake(h, { cron: "0 9 * * *", endsAt: "2026-05-01T20:00:00Z", overlap: "allow" });
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ enabled: false, endReason: "ends_at" });

    const stillNone = h.scheduler.update(s.id, { cron: "0 21 * * *" });
    expect(stillNone.ok && stillNone.value).toMatchObject({ cron: "0 21 * * *", enabled: false, endReason: "ends_at" });
    const refused = h.scheduler.update(s.id, { enabled: true });
    expect(!refused.ok && refused.error).toContain("extend or clear");

    const hourly = h.scheduler.update(s.id, { cron: "0 * * * *" });
    expect(hourly.ok && hourly.value).toMatchObject({ enabled: true, nextRunAt: "2026-05-01T10:00:00.000Z" });
    expect(hourly.ok && hourly.value.endedAt).toBeUndefined();
  });

  test("endsAt: the run whose next slot falls after it ends the schedule; a slot exactly at endsAt runs", async () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-01T10:00:00Z", overlap: "allow" });
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)!.endedAt).toBeUndefined();
    await tickAt(h, "2026-05-01T10:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 2, enabled: false, endReason: "ends_at" });
    await tickAt(h, "2026-05-01T11:00:10.000Z");
    expect(h.wakes.map((w) => w.run.scheduledFor)).toEqual(["2026-05-01T09:00:00.000Z", "2026-05-01T10:00:00.000Z"]);
  });

  test("catch-up after downtime never fires a slot later than endsAt", async () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-01T11:30:00Z" });
    // Down from before 09:00 until 15:20: the latest slot at or before endsAt is 11:00.
    await tickAt(h, "2026-05-01T15:20:00.000Z");
    const runs = listPersonaScheduleRuns(h.db, s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "catch_up", scheduledFor: "2026-05-01T11:00:00.000Z", status: "running" });
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ enabled: false, endReason: "ends_at", runCount: 1 });
    await tickAt(h, "2026-05-01T16:20:00.000Z");
    expect(h.wakes).toHaveLength(1);
  });

  test("catch-up skip past endsAt records the bounded slot skipped and ends the schedule", async () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-01T11:30:00Z", catchUp: "skip" });
    await tickAt(h, "2026-05-01T15:20:00.000Z");
    const [run] = listPersonaScheduleRuns(h.db, s.id);
    expect(run).toMatchObject({ trigger: "catch_up", status: "skipped", scheduledFor: "2026-05-01T11:00:00.000Z" });
    expect(run!.reason).toContain("missed 3 runs");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ enabled: false, endReason: "ends_at", runCount: 0 });
    expect(h.wakes).toHaveLength(0);
  });

  test("a due slot already past endsAt is ended without firing", async () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-01T11:30:00Z" });
    h.db.run("UPDATE persona_schedules SET next_run_at = ? WHERE id = ?", ["2026-05-01T12:00:00.000Z", s.id]);
    await tickAt(h, "2026-05-01T12:00:10.000Z");
    expect(h.wakes).toHaveLength(0);
    expect(listPersonaScheduleRuns(h.db, s.id)).toHaveLength(0);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ enabled: false, endReason: "ends_at" });
  });

  test("a paused schedule is marked ended once its endsAt passes", async () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-01T12:00:00Z", enabled: false });
    await tickAt(h, "2026-05-01T11:59:00.000Z");
    expect(getPersonaSchedule(h.db, s.id)!.endedAt).toBeUndefined();
    await tickAt(h, "2026-05-01T12:00:01.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ enabled: false, endReason: "ends_at", endedAt: "2026-05-01T12:00:01.000Z" });
  });

  test("update extends or clears the bound: an ended schedule resumes from now; the count carries on", async () => {
    const h = harness();
    const s = wake(h, { maxRuns: 1, overlap: "allow" });
    await tickAt(h, "2026-05-01T09:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)!.endReason).toBe("max_runs");

    const resume = h.scheduler.update(s.id, { enabled: true });
    expect(!resume.ok && resume.error).toContain("extend or clear");
    const same = h.scheduler.update(s.id, { maxRuns: 1 });
    expect(!same.ok && same.error).toContain("still ends it");
    // Editing the title leaves it ended.
    const retitled = h.scheduler.update(s.id, { title: "Renamed" });
    expect(retitled.ok && retitled.value).toMatchObject({ title: "Renamed", enabled: false, endReason: "max_runs" });

    h.clock.now = new Date("2026-05-01T11:20:00.000Z");
    const extended = h.scheduler.update(s.id, { maxRuns: 3 });
    expect(extended.ok && extended.value).toMatchObject({ enabled: true, maxRuns: 3, runCount: 1, nextRunAt: "2026-05-01T12:00:00.000Z" });
    expect(extended.ok && extended.value.endedAt).toBeUndefined();
    await tickAt(h, "2026-05-01T12:00:10.000Z");
    await tickAt(h, "2026-05-01T13:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 3, enabled: false, endReason: "max_runs" });

    const cleared = h.scheduler.update(s.id, { maxRuns: null });
    expect(cleared.ok && cleared.value).toMatchObject({ enabled: true, nextRunAt: "2026-05-01T14:00:00.000Z" });
    expect(cleared.ok && cleared.value.maxRuns).toBeUndefined();
    await tickAt(h, "2026-05-01T14:00:10.000Z");
    await tickAt(h, "2026-05-01T15:00:10.000Z");
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 5, enabled: true });
  });

  test("update refuses a bound that would leave no run, and clears endsAt with null", () => {
    const h = harness();
    const s = wake(h, { endsAt: "2026-05-02T00:00:00Z" });
    const past = h.scheduler.update(s.id, { endsAt: "2026-05-01T08:00:00Z" });
    expect(!past.ok && past.error).toContain("already passed");
    // The next slot stays 09:00Z; an endsAt before it would leave none.
    const early = h.scheduler.update(s.id, { endsAt: "2026-05-01T08:45:00Z" });
    expect(!early.ok && early.error).toContain("no run falls at or before endsAt");
    h.db.run("UPDATE persona_schedules SET run_count = 4 WHERE id = ?", [s.id]);
    const fewer = h.scheduler.update(s.id, { maxRuns: 4 });
    expect(!fewer.ok && fewer.error).toContain("already fired 4");
    const later = h.scheduler.update(s.id, { endsAt: "2026-05-03T00:00:00Z", maxRuns: 6 });
    expect(later.ok && later.value).toMatchObject({ endsAt: "2026-05-03T00:00:00.000Z", maxRuns: 6, enabled: true });
    const cleared = h.scheduler.update(s.id, { endsAt: null });
    expect(cleared.ok && cleared.value.endsAt).toBeUndefined();
    expect(cleared.ok && cleared.value).toMatchObject({ maxRuns: 6, nextRunAt: "2026-05-01T09:00:00.000Z" });
  });

  test("endsAt without an offset is read in the schedule's timezone, across a DST change", async () => {
    // 1:00 New York nightly; the clocks fall back on Sun 2026-11-01.
    const h = harness({ at: "2026-10-30T12:00:00.000Z" });
    const s = wake(h, { cron: "0 1 * * *", timezone: "America/New_York", endsAt: "2026-11-02T01:00", overlap: "allow" });
    // 01:00 EST (UTC-5) on Nov 2 is 06:00Z.
    expect(s.endsAt).toBe("2026-11-02T06:00:00.000Z");
    expect(s.nextRunAt).toBe("2026-10-31T05:00:00.000Z");
    for (const at of ["2026-10-31T05:00:10Z", "2026-11-01T05:00:10Z", "2026-11-02T06:00:10Z", "2026-11-03T06:00:10Z"]) {
      await tickAt(h, at);
    }
    // 01:00 EDT on Oct 31 and Nov 1 (the first 1:00 of the repeated hour), 01:00 EST on Nov 2 — exactly at endsAt.
    expect(h.wakes.map((w) => w.run.scheduledFor)).toEqual([
      "2026-10-31T05:00:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
    ]);
    expect(getPersonaSchedule(h.db, s.id)).toMatchObject({ runCount: 3, enabled: false, endReason: "ends_at" });

    // The same instant given with an offset, and in UTC, reads the same.
    const offset = wake(h, { title: "b", cron: "0 1 * * *", timezone: "America/New_York", endsAt: "2026-11-05T01:00:00-05:00" });
    const utc = wake(h, { title: "c", cron: "0 1 * * *", timezone: "UTC", endsAt: "2026-11-05T06:00:00Z" });
    expect(offset.endsAt).toBe("2026-11-05T06:00:00.000Z");
    expect(utc.endsAt).toBe(offset.endsAt);
  });

  test("a schedule's timezone changing later doesn't move an endsAt already stored", () => {
    const h = harness();
    const s = wake(h, { cron: "0 9 * * *", timezone: "America/New_York", endsAt: "2026-05-10T09:00" });
    expect(s.endsAt).toBe("2026-05-10T13:00:00.000Z");
    const moved = h.scheduler.update(s.id, { timezone: "America/Los_Angeles" });
    expect(moved.ok && moved.value.endsAt).toBe("2026-05-10T13:00:00.000Z");
    // A new naive endsAt in the same update is read in the new timezone.
    const both = h.scheduler.update(s.id, { timezone: "UTC", endsAt: "2026-05-10T09:00" });
    expect(both.ok && both.value.endsAt).toBe("2026-05-10T09:00:00.000Z");
  });
});
