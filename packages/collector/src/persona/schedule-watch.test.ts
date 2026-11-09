import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { PersonaSchedule, PersonaScheduleRun, ReviewPacketDraft } from "@standup/shared";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createPersonaJob,
  createReviewPacket,
  createSession,
  createStore,
  enqueuePersonaInbox,
  getOrCreatePersonaThreadByRef,
  getPersonaSchedule,
  listPersonaScheduleRuns,
  linkPersonaJobLaunch,
  submitReviewPacket,
  updatePersonaJob,
  updateSessionStatus,
  upsertProject,
} from "@standup/store";
import { PersonaScheduler, scheduleRunWakeKey } from "./scheduler.js";
import { watchChanges } from "./schedule-watch.js";

const OWNER = "alice";

const PACKET_DRAFT: ReviewPacketDraft = {
  title: "Ship the thing",
  intent: "Implements the task.",
  changes: [{ area: "Store", bullets: ["Changes a.ts"], files: [] }],
  validation: { samples: [{ label: "tests", input: "bun test", output: "green" }] },
  risks: { risks: [], questions: [] },
  links: [],
};

interface Wake {
  schedule: PersonaSchedule;
  run: PersonaScheduleRun;
  changes?: string[];
}

/** A scheduler over `db` that records its wakes. */
function scheduler(db: Database, wakes: Wake[]): PersonaScheduler {
  return new PersonaScheduler({
    db,
    owner: OWNER,
    now: () => new Date(),
    defaultTimezone: () => "UTC",
    launch: async () => ({ status: "error", error: "no launches here" }),
    wake: (schedule, run, threadId, changes) => {
      wakes.push({ schedule, run, ...(changes ? { changes } : {}) });
      return enqueuePersonaInbox(db, { owner: OWNER, kind: "schedule", payload: {}, threadId, coalesceKey: scheduleRunWakeKey(run.id) })
        .item.id;
    },
    notify: () => {},
    canFire: () => true,
    isPaused: () => false,
    broadcast: () => {},
  });
}

/** A store with a job whose one worker session `s1` is running. */
function setUp(db: Database = createStore(":memory:").db) {
  upsertProject(db, { id: "p", name: "p", branch: "main", repos: ["/repo/p"] });
  const job = createPersonaJob(db, { owner: OWNER, threadId: "t1", title: "Fix the flaky test", goal: "g" });
  createLaunch(db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  linkPersonaJobLaunch(db, job.id, "l1");
  createSession(db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(db, "l1", "s1");
  return { db, job };
}

function create(s: PersonaScheduler, fields: Record<string, unknown> = {}): PersonaSchedule {
  const r = s.create(
    { title: "Reconcile jobs", cron: "*/15 * * * *", kind: "wake_persona", note: "reconcile job status", watch: { kind: "jobs" }, ...fields },
    { createdBy: "persona" }
  );
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Runs `id` once now and settles the wake it queued, as Persona's turn on it ending would. */
async function fire(s: PersonaScheduler, db: Database, id: string): Promise<PersonaScheduleRun> {
  const r = await s.runNow(id, { approved: true });
  if (!r.ok) throw new Error(r.error);
  if (r.value.status === "running") {
    db.run("UPDATE persona_inbox SET status = 'done' WHERE status = 'pending'");
    s.wakesHandled([id]);
  }
  return r.value;
}

describe("schedule watch: wake only when something changed", () => {
  test("no change: the run is skipped, Persona is not woken, and the skip is counted", async () => {
    const { db } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    const run = await fire(s, db, schedule.id);
    expect(run.status).toBe("skipped");
    expect(run.reason).toContain("no change");
    expect(run.reason).toContain("your jobs and reviews");
    expect(wakes).toHaveLength(0);
    const after = getPersonaSchedule(db, schedule.id)!;
    expect(after.watchSkips).toBe(1);
    expect(after.lastOutcome).toBe("skipped");
    // A skip doesn't use up the schedule's runs.
    expect(after.runCount).toBe(0);
  });

  test("a job status change wakes Persona with what changed; the next unchanged run is skipped", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    const run = await fire(s, db, schedule.id);
    expect(run.status).toBe("running");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.changes!.join("\n")).toContain(`job ${job.id.slice(0, 8)} "Fix the flaky test": active`);
    expect(wakes[0]!.changes!.join("\n")).toContain("→ waiting_user");
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    expect(wakes).toHaveLength(1);
  });

  test("a session status change and a job closing each read as a change", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    updateSessionStatus(db, "s1", "idle");
    await fire(s, db, schedule.id);
    expect(wakes.at(-1)!.changes!.join("\n")).toContain("s1 running");
    expect(wakes.at(-1)!.changes!.join("\n")).toContain("s1 idle");
    updatePersonaJob(db, job.id, { status: "done" });
    await fire(s, db, schedule.id);
    expect(wakes.at(-1)!.changes!.join("\n")).toContain("→ done");
    expect(wakes).toHaveLength(2);
  });

  test("a new pending ask wakes Persona and names it", async () => {
    const { db } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    const ask = createAsk(db, "s1", "ask_human", "Which branch?");
    const run = await fire(s, db, schedule.id);
    expect(run.status).toBe("running");
    expect(wakes[0]!.changes!.join("\n")).toContain(`waiting on you: ask ${ask.id.slice(0, 8)}`);
  });

  test("a new review packet wakes a reviews watch; deciding it wakes it again", async () => {
    const { db } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s, { watch: { kind: "reviews" } });
    // A job change isn't what a reviews watch looks at.
    updateSessionStatus(db, "s1", "idle");
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    const packet = createReviewPacket(db, { owner: OWNER, projectId: "p", launchId: "l1" });
    submitReviewPacket(db, { id: packet.id, owner: OWNER, draft: PACKET_DRAFT });
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect(wakes[0]!.changes).toEqual([`review ${packet.id.slice(0, 8)} "Ship the thing": new — pending, revision 1`]);
    db.run("UPDATE review_packets SET status = 'approved' WHERE id = ?", [packet.id]);
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect(wakes[1]!.changes).toEqual([`review ${packet.id.slice(0, 8)} "Ship the thing": decided or withdrawn`]);
  });

  test("a job watch looks at that job only", async () => {
    const { db, job } = setUp();
    const other = createPersonaJob(db, { owner: OWNER, threadId: "t1", title: "Other", goal: "g" });
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s, { watch: { kind: "job", jobId: job.id } });
    updatePersonaJob(db, other.id, { status: "done" });
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    updatePersonaJob(db, job.id, { status: "failed" });
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect(wakes[0]!.changes).toEqual([`job ${job.id.slice(0, 8)} "Fix the flaky test": active; sessions s1 running → failed`]);
  });

  test("the baseline persists across a collector restart", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "schedule-watch-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "standup.db");
    const first = createStore(path);
    const { job } = setUp(first.db);
    const schedule = create(scheduler(first.db, []));
    first.db.close();

    const second = createStore(path);
    const wakes: Wake[] = [];
    const s = scheduler(second.db, wakes);
    expect((await fire(s, second.db, schedule.id)).status).toBe("skipped");
    updatePersonaJob(second.db, job.id, { status: "waiting_user" });
    expect((await fire(s, second.db, schedule.id)).status).toBe("running");
    second.db.close();

    const third = createStore(path);
    const later = scheduler(third.db, wakes);
    expect((await fire(later, third.db, schedule.id)).status).toBe("skipped");
    expect(wakes).toHaveLength(1);
    expect(getPersonaSchedule(third.db, schedule.id)!.watchSkips).toBe(2);
    third.db.close();
  });

  test("a schedule without a watch wakes on every run, with no change list", async () => {
    const { db } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s, { watch: undefined });
    expect(schedule.watch).toBeUndefined();
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect(wakes).toHaveLength(2);
    expect(wakes.every((w) => w.changes === undefined)).toBe(true);
    expect(listPersonaScheduleRuns(db, schedule.id).every((r) => r.status === "done" || r.status === "running")).toBe(true);
  });

  test("update sets a watch from what is there now, keeps it when given again, and null clears it", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s, { watch: undefined });
    const watched = s.update(schedule.id, { watch: { kind: "jobs" } });
    expect(watched.ok && watched.value.watch).toEqual({ kind: "jobs" });
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    // The same watch again keeps the baseline, so the change still wakes.
    s.update(schedule.id, { watch: { kind: "jobs" } });
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    const cleared = s.update(schedule.id, { watch: null });
    expect(cleared.ok && cleared.value.watch).toBeUndefined();
    expect((await fire(s, db, schedule.id)).status).toBe("running");
    expect(wakes.at(-1)!.changes).toBeUndefined();
  });

  test("a cron slot with nothing changed is recorded skipped at the claim, and the schedule moves on", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    const due = () => db.run("UPDATE persona_schedules SET next_run_at = ? WHERE id = ?", [new Date(Date.now() - 60_000).toISOString(), schedule.id]);
    due();
    await s.tick();
    const [skipped] = listPersonaScheduleRuns(db, schedule.id);
    expect(skipped).toMatchObject({ trigger: "cron", status: "skipped" });
    expect(Date.parse(getPersonaSchedule(db, schedule.id)!.nextRunAt!)).toBeGreaterThan(Date.now());
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    due();
    await s.tick();
    expect(listPersonaScheduleRuns(db, schedule.id)[0]).toMatchObject({ trigger: "cron", status: "running" });
    expect(wakes).toHaveLength(1);
  });

  test("a no-change run uses up no maxRuns, so it can't end or pause the schedule", async () => {
    const { db } = setUp();
    const s = scheduler(db, []);
    const schedule = create(s, { maxRuns: 1 });
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    const after = getPersonaSchedule(db, schedule.id)!;
    expect(after).toMatchObject({ enabled: true, runCount: 0 });
    expect(after.endedAt).toBeUndefined();
    expect(after.nextRunAt).toBe(schedule.nextRunAt);
  });

  test("what Persona does in the turn a wake starts doesn't wake it again", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    updateSessionStatus(db, "s1", "idle");
    const r = await s.runNow(schedule.id, { approved: true });
    expect(r.ok && r.value.status).toBe("running");
    // Persona's turn on that wake closes the job; the turn ends.
    updatePersonaJob(db, job.id, { status: "done" });
    db.run("UPDATE persona_inbox SET status = 'done' WHERE status = 'pending'");
    s.wakesHandled([schedule.id]);
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
    expect(wakes).toHaveLength(1);
    // A change after the turn ended still wakes it.
    createPersonaJob(db, { owner: OWNER, threadId: "t1", title: "Next job", goal: "g" });
    expect((await fire(s, db, schedule.id)).status).toBe("running");
  });

  test("a review packet that comes in while the wake waits for Persona still wakes it after the turn", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    expect((await s.runNow(schedule.id, { approved: true })).ok).toBe(true);
    const packet = createReviewPacket(db, { owner: OWNER, projectId: "p", launchId: "l1" });
    submitReviewPacket(db, { id: packet.id, owner: OWNER, draft: PACKET_DRAFT });
    db.run("UPDATE persona_inbox SET status = 'done' WHERE status = 'pending'");
    s.wakesHandled([schedule.id]);
    const run = await fire(s, db, schedule.id);
    expect(run.status).toBe("running");
    expect(wakes[1]!.changes).toEqual([`review ${packet.id.slice(0, 8)} "Ship the thing": new — pending, revision 1`]);
  });

  test("overlap allow: a run while the last wake is unhandled doesn't report the same change again", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s, { overlap: "allow" });
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    expect((await s.runNow(schedule.id, { approved: true })).ok).toBe(true);
    const again = await s.runNow(schedule.id, { approved: true });
    expect(again.ok && again.value.status).toBe("skipped");
    expect(wakes).toHaveLength(1);
  });

  test("a wake whose turn fails reports the change again on the next run", async () => {
    const { db, job } = setUp();
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const schedule = create(s);
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    expect((await s.runNow(schedule.id, { approved: true })).ok).toBe(true);
    db.run("UPDATE persona_inbox SET status = 'failed' WHERE status = 'pending'");
    const again = await fire(s, db, schedule.id);
    expect(again.status).toBe("running");
    expect(wakes.map((w) => w.changes)).toEqual([wakes[0]!.changes, wakes[0]!.changes]);
    expect((await fire(s, db, schedule.id)).status).toBe("skipped");
  });

  test("a thread whose audience widens re-baselines without listing what it held from outside the thread", async () => {
    const { db, job } = setUp();
    const thread = getOrCreatePersonaThreadByRef(db, OWNER, "slack", "dm:1", "dm", "private");
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const r = s.create(
      { title: "Reconcile", cron: "*/15 * * * *", kind: "wake_persona", note: "n", watch: { kind: "jobs" } },
      { createdBy: "persona", threadId: thread.id }
    );
    if (!r.ok) throw new Error(r.error);
    db.run("UPDATE persona_threads SET audience = 'shared' WHERE id = ?", [thread.id]);
    const run = await fire(s, db, r.value.id);
    expect(run.status).toBe("skipped");
    expect(run.reason).toContain("audience changed");
    expect(wakes).toHaveLength(0);
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    expect((await fire(s, db, r.value.id)).status).toBe("skipped");
  });

  test("in a shared thread a watch sees only that thread's jobs and their review packets", async () => {
    const { db, job } = setUp();
    const shared = getOrCreatePersonaThreadByRef(db, OWNER, "slack", "C1:1", "channel", "shared");
    const mine = createPersonaJob(db, { owner: OWNER, threadId: shared.id, title: "Channel job", goal: "g" });
    const wakes: Wake[] = [];
    const s = scheduler(db, wakes);
    const r = s.create(
      { title: "Reconcile", cron: "*/15 * * * *", kind: "wake_persona", note: "n", watch: { kind: "jobs" } },
      { createdBy: "persona", threadId: shared.id }
    );
    if (!r.ok) throw new Error(r.error);
    // A private job changing and a review packet of no job here: neither is this thread's.
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    const packet = createReviewPacket(db, { owner: OWNER, projectId: "p", launchId: "l1", jobId: job.id });
    submitReviewPacket(db, { id: packet.id, owner: OWNER, draft: PACKET_DRAFT });
    expect((await fire(s, db, r.value.id)).status).toBe("skipped");
    updatePersonaJob(db, mine.id, { status: "waiting_user" });
    expect((await fire(s, db, r.value.id)).status).toBe("running");
    expect(wakes[0]!.changes).toEqual([`job ${mine.id.slice(0, 8)} "Channel job": active → waiting_user; waiting on you: message ${shared.id.slice(0, 8)}`]);
    const job2 = s.create(
      { title: "Other job", cron: "*/15 * * * *", kind: "wake_persona", note: "n", watch: { kind: "job", jobId: job.id } },
      { createdBy: "persona", threadId: shared.id }
    );
    if (!job2.ok) throw new Error(job2.error);
    updatePersonaJob(db, job.id, { status: "failed" });
    expect((await fire(s, db, job2.value.id)).status).toBe("skipped");
  });

  test("validation: a launch_job can't watch; kinds, jobId and unknown keys are checked", () => {
    const { db, job } = setUp();
    const s = scheduler(db, []);
    const bad = (fields: Record<string, unknown>) => {
      const r = s.validateCreate({ title: "t", cron: "0 * * * *", kind: "wake_persona", note: "n", ...fields });
      return r.ok ? null : r.error;
    };
    expect(bad({ watch: { kind: "jobs" } })).toBeNull();
    expect(bad({ watch: { kind: "job", jobId: job.id } })).toBeNull();
    expect(bad({ watch: { kind: "everything" } })).toContain("watch.kind must be one of");
    expect(bad({ watch: { kind: "job" } })).toContain("needs jobId");
    expect(bad({ watch: { kind: "job", jobId: "nope" } })).toContain("no job nope");
    expect(bad({ watch: { kind: "jobs", jobId: job.id } })).toContain("only to watch kind job");
    expect(bad({ watch: { kind: "jobs", url: "http://x" } })).toContain("only kind and jobId");
    expect(bad({ watch: "jobs" })).toContain("must be an object");
    expect(bad({ kind: "launch_job", note: undefined, brief: "b", projectId: "p", watch: { kind: "jobs" } })).toContain(
      "only to wake_persona"
    );
  });
});

describe("watchChanges", () => {
  test("lists new, moved and gone things; a closed job ageing out is not a change", () => {
    expect(watchChanges({ a: "active", b: "done", c: "active" }, { a: "waiting_user", d: "active" })).toEqual([
      "a: active → waiting_user",
      "d: new — active",
      "c: no longer listed (was active)",
    ]);
    expect(watchChanges({ a: "x" }, { a: "x" })).toEqual([]);
  });

  test("caps the list and counts the rest", () => {
    const after = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "v"]));
    const changes = watchChanges({}, after);
    expect(changes).toHaveLength(11);
    expect(changes.at(-1)).toBe("and 5 more");
  });
});
