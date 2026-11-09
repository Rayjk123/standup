import { describe, expect, test } from "bun:test";
import {
  claimPersonaScheduleRun,
  createStore,
  createLaunch,
  enqueuePersonaLaunch,
  getPersonaSchedule,
  getPersonaQueuedLaunch,
  listPersonaApprovals,
  listPersonaMessages,
  listQueuedPersonaLaunches,
  updateLaunchStatus,
  upsertProject,
} from "@standup/store";
import type { PersonaSchedule, PersonaScheduleRun } from "@standup/shared";
import { resolvePersonaConfig } from "./config.js";
import type { PersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";

const OWNER = "alice";

/** A runtime whose launch route records a launch row, as the collector's would. */
function harness(config: Partial<PersonaConfig>) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  let nowMs = Date.parse("2026-10-04T12:00:00.000Z");
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), ...config },
    broadcast: () => {},
    turnRunner: async () => ({ ok: true, text: "ok", sessionId: "sid", contextTokens: 1 }),
    now: () => new Date(nowMs),
  });
  const launched: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  runtime.bindApp({
    request: async (path: string, init?: RequestInit) => {
      if (!/\/launch$/.test(path)) return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { task: string };
      bodies.push(body);
      const id = `L${launched.length + 1}`;
      createLaunch(store.db, { id, projectId: "p", task: body.task, worktreePath: `/wt/${id}`, branch: `b${id}`, launchedBy: OWNER });
      store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", [new Date(nowMs).toISOString().slice(0, 19).replace("T", " "), id]);
      launched.push(id);
      return new Response(JSON.stringify({ launch: { id, projectId: "p", status: "starting", branch: `b${id}` } }), { status: 200 });
    },
  });
  const launch = async (task: string) => {
    const result = await runtime.tools.call("launch_session", { task, projectId: "p" });
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };
  return {
    store,
    runtime,
    launched,
    bodies,
    launch,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("persona launch queue", () => {
  test("there is no daily launch count: launches keep starting while the active cap has room", async () => {
    const h = harness({ maxActive: 2 });
    for (let i = 1; i <= 30; i++) {
      const result = await h.launch(`task ${i}`);
      expect(result.launchId).toBe(`L${i}`);
      updateLaunchStatus(h.store.db, `L${i}`, "cleaned");
    }
    expect(h.launched).toHaveLength(30);
    expect(listQueuedPersonaLaunches(h.store.db, OWNER)).toEqual([]);
    expect(listPersonaApprovals(h.store.db, OWNER)).toEqual([]);
  });

  test("a launch queued for the former daily budget starts on the next tick", async () => {
    const h = harness({ maxActive: 6 });
    const queued = enqueuePersonaLaunch(h.store.db, {
      owner: OWNER,
      threadId: h.runtime.consoleThreadId(),
      args: { task: "waiting task", projectId: "p" },
      task: "waiting task",
      reason: "daily launch budget reached (20/20)",
    });

    await h.runtime.tick();
    expect(h.launched).toEqual(["L1"]);
    expect(getPersonaQueuedLaunch(h.store.db, queued.id)).toMatchObject({ status: "started", launchId: "L1" });
    expect(listPersonaMessages(h.store.db, h.runtime.consoleThreadId()).some((m) => /Started a queued launch: "waiting task"/.test(m.text))).toBe(true);
    expect(listPersonaApprovals(h.store.db, OWNER)).toEqual([]);
  });

  test("a launch past the active cap queues and starts when a worker finishes", async () => {
    const h = harness({ maxActive: 1 });
    await h.launch("one");
    const queued = await h.launch("two");
    expect(queued.queued).toBe(true);
    expect(String(queued.queuedReason)).toMatch(/active launch cap reached \(1\/1\)/);
    expect(listPersonaApprovals(h.store.db, OWNER)).toEqual([]);

    await h.runtime.tick();
    expect(h.launched).toEqual(["L1"]);

    updateLaunchStatus(h.store.db, "L1", "cleaned");
    await h.runtime.tick();
    expect(h.launched).toEqual(["L1", "L2"]);
    expect(listQueuedPersonaLaunches(h.store.db, OWNER)).toEqual([]);
  });

  test("a launch past the active cap dedupes against the same task already waiting", async () => {
    const h = harness({ maxActive: 1 });
    await h.launch("one");
    const second = await h.launch("two");
    expect(second).toMatchObject({ queued: true, position: 0 });
    const again = await h.launch("two");
    expect(again).toMatchObject({ queued: true, queueId: second.queueId, deduped: true });
    expect(listQueuedPersonaLaunches(h.store.db, OWNER)).toHaveLength(1);
  });

  test("a scheduled run past the active cap queues with its run id, not held", async () => {
    const h = harness({ maxActive: 1 });
    await h.launch("already running");
    const schedule = { id: "sch1", kind: "launch_job", title: "Nightly", brief: "run the nightly sweep", projectId: "p" } as PersonaSchedule;
    const run = { id: "run1", scheduleId: "sch1" } as PersonaScheduleRun;
    const outcome = await h.runtime.tools.launchScheduled(schedule, run, { approved: false, threadId: h.runtime.consoleThreadId() });
    expect(outcome).toMatchObject({ status: "queued" });
    const [queued] = listQueuedPersonaLaunches(h.store.db, OWNER);
    expect(queued).toMatchObject({ scheduleRunId: "run1", task: "run the nightly sweep" });
    expect(h.launched).toEqual(["L1"]);
    expect(listPersonaApprovals(h.store.db, OWNER)).toEqual([]);
  });

  test("a queued scheduled launch that fails to start gives back its maxRuns count and reopens the schedule", async () => {
    const h = harness({ maxActive: 1 });
    await h.launch("already running");
    const created = h.runtime.schedules.create(
      { title: "Nightly", cron: "0 * * * *", timezone: "UTC", kind: "launch_job", brief: "run the nightly sweep", projectId: "p", maxRuns: 1 },
      { createdBy: OWNER }
    );
    if (!created.ok) throw new Error(created.error);
    const claim = claimPersonaScheduleRun(h.store.db, {
      scheduleId: created.value.id,
      owner: OWNER,
      expectedNextRunAt: created.value.nextRunAt,
      scheduledFor: created.value.nextRunAt!,
      trigger: "cron",
      nextRunAt: "2026-10-04T14:00:00.000Z",
      now: "2026-10-04T13:00:05.000Z",
    });
    if (claim.outcome !== "started") throw new Error(claim.outcome);
    expect(getPersonaSchedule(h.store.db, created.value.id)).toMatchObject({ runCount: 1, enabled: false, endReason: "max_runs" });
    const outcome = await h.runtime.tools.launchScheduled(claim.schedule, claim.run, { approved: false, threadId: h.runtime.consoleThreadId() });
    expect(outcome).toMatchObject({ status: "queued" });

    // The project is gone by the time there is room: the queued launch fails at drain.
    h.store.db.run("UPDATE projects SET reserved = 1 WHERE id = 'p'");
    updateLaunchStatus(h.store.db, "L1", "cleaned");
    await h.runtime.tick();
    expect(h.launched).toEqual(["L1"]);
    expect(listQueuedPersonaLaunches(h.store.db, OWNER)).toEqual([]);
    const after = getPersonaSchedule(h.store.db, created.value.id)!;
    expect(after).toMatchObject({ runCount: 0, enabled: true });
    expect(after.endedAt).toBeUndefined();
    const counted = h.store.db.query("SELECT counted FROM persona_schedule_runs WHERE id = ?").get(claim.run.id);
    expect(counted).toEqual({ counted: 0 });
  });

  test("a scheduled run of a pipeline-off schedule launches with pipeline off; others leave it unset", async () => {
    const h = harness({ maxActive: 6 });
    const threadId = h.runtime.consoleThreadId();
    const off = { id: "sch1", kind: "launch_job", title: "Research", brief: "survey the options", projectId: "p", pipeline: false } as PersonaSchedule;
    const on = { id: "sch2", kind: "launch_job", title: "Nightly", brief: "run the nightly sweep", projectId: "p" } as PersonaSchedule;
    expect(await h.runtime.tools.launchScheduled(off, { id: "run1", scheduleId: "sch1" } as PersonaScheduleRun, { approved: true, threadId })).toMatchObject({ status: "launched" });
    expect(await h.runtime.tools.launchScheduled(on, { id: "run2", scheduleId: "sch2" } as PersonaScheduleRun, { approved: true, threadId })).toMatchObject({ status: "launched" });
    expect(h.bodies[0]!.pipeline).toBe("off");
    expect("pipeline" in h.bodies[1]!).toBe(false);
  });

  test("queued launches start oldest first, only as far as there is room", async () => {
    const h = harness({ maxActive: 1 });
    await h.launch("one");
    await h.launch("two");
    await h.launch("three");
    updateLaunchStatus(h.store.db, "L1", "cleaned");
    await h.runtime.tick();
    expect(h.launched).toEqual(["L1", "L2"]);
    expect(listQueuedPersonaLaunches(h.store.db, OWNER).map((q) => q.task)).toEqual(["three"]);
  });
});
