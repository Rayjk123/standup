import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { DEFAULT_PIPELINE } from "@standup/shared";
import type { ReviewPacketDraft, StateReport } from "@standup/shared";
import {
  appendPersonaMessage,
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createPersonaSchedule,
  createPipelineRun,
  createReviewPacket,
  createSession,
  createStore,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  openPersonaCommitment,
  submitReviewPacket,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import { FLOOR_GATE } from "../../floor/gate.js";
import { HostMonitor } from "../../host-headroom.js";
import type { RestartRecord } from "../../restart/state.js";
import { IDLE_NOTICE_GATE } from "../events.js";
import { buildStateReport, stageTitle } from "./state.js";

const ALICE = "alice";
const BOB = "bob";
const MIN = 60_000;

function draft(title: string): ReviewPacketDraft {
  return {
    title,
    intent: "i",
    changes: [{ area: "a", bullets: ["b"], files: ["f.ts"] }],
    validation: { samples: [] },
    risks: { risks: [], questions: [] },
    links: [],
  };
}

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store.db;
}

let seq = 0;
/** A job of `owner` with a launch and a running worker session. */
function jobWithWorker(db: Database, owner: string, title: string) {
  const job = createPersonaJob(db, { owner, threadId: `t-${owner}`, title, goal: "g" });
  const launchId = `l${++seq}`;
  const sessionId = `s-${launchId}`;
  createLaunch(db, { id: launchId, projectId: "p", task: "t", worktreePath: `/w/${launchId}`, branch: "b" });
  linkPersonaJobLaunch(db, job.id, launchId);
  createSession(db, { id: sessionId, projectId: "p", title: "w", cwd: `/w/${launchId}`, status: "running" });
  attachSessionToLaunch(db, launchId, sessionId);
  return { job, launchId, sessionId };
}

/** Moves a job's and its worker's clocks to `at`, so the job reads as last active then. */
function activeAt(db: Database, w: { job: { id: string }; sessionId: string }, at: Date) {
  db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [at.toISOString(), w.sessionId]);
  db.run("UPDATE persona_jobs SET updated_at = ?, created_at = ? WHERE id = ?", [at.toISOString(), at.toISOString(), w.job.id]);
}

const quietHost = () => new HostMonitor({ provider: () => ({ memAvailableBytes: 40 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, load1: 1.5, cores: 16 }) });

describe("stageTitle", () => {
  test("words a pipeline stage id plainly", () => {
    expect(stageTitle("human_review")).toBe("Human review");
    expect(stageTitle("live_check")).toBe("Live check");
    expect(stageTitle("")).toBe("No pipeline");
  });
});

describe("buildStateReport", () => {
  test("an empty store is all good, with the collector's uptime, version and host reading", () => {
    const db = setUp();
    const now = new Date();
    const r = buildStateReport({
      db,
      owner: ALICE,
      now,
      args: "",
      health: { head: "abc123def456", startedAt: new Date(now.getTime() - 90 * MIN).toISOString() },
      latestRestart: () => null,
      hostMonitor: quietHost(),
    });
    expect(r.verdict).toEqual({ needYou: 0, lookOff: 0, line: "All good" });
    expect(r.waiting).toEqual({ jobs: [], questions: [], approvals: [], reviews: [] });
    expect(r.inFlight).toEqual({ total: 0, stalled: 0, stages: [] });
    expect(r.holds).toEqual([]);
    expect(r.health.collector).toEqual({ head: "abc123def456", startedAt: expect.any(String), uptimeMs: 90 * MIN });
    expect(r.health.restart).toBeNull();
    expect(r.health.host).toMatchObject({ memAvailableBytes: 40 * 1024 ** 3, load1: 1.5, cores: 16, active: 0, cap: 6, hostLimited: false });
  });

  test("a representative store: every section, links, and the verdict counts", () => {
    const db = setUp();
    const now = new Date(Date.now() + 45 * MIN);
    const thread = getOrCreatePersonaConsoleThread(db, ALICE);

    // Waiting on you.
    const waiting = createPersonaJob(db, { owner: ALICE, threadId: thread.id, title: "Pick a name", goal: "g" });
    updatePersonaJob(db, waiting.id, { status: "waiting_user", note: "Two names to choose from" });
    const carded = createPersonaJob(db, { owner: ALICE, threadId: thread.id, title: "Deploy beta", goal: "g" });
    const card = createPersonaApproval(db, { owner: ALICE, jobId: carded.id, action: "launch_session", summary: "Launch the deploy worker", args: {} });
    const question = appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: "Which branch should I use?", options: ["main", "dev"] }).message;
    const packet = createReviewPacket(db, { owner: ALICE, launchId: "L-review" });
    submitReviewPacket(db, { id: packet.id, owner: ALICE, draft: draft("Add the Review tab") });

    // In flight: one fresh at coding, one stalled at review, one with no pipeline.
    const fresh = jobWithWorker(db, ALICE, "Fresh worker");
    createPipelineRun(db, { launchId: fresh.launchId, owner: ALICE, definition: DEFAULT_PIPELINE, definitionHash: "h", currentStage: "coding" });
    activeAt(db, fresh, new Date(now.getTime() - 2 * MIN));
    const stalled = jobWithWorker(db, ALICE, "Quiet worker");
    createPipelineRun(db, { launchId: stalled.launchId, owner: ALICE, definition: DEFAULT_PIPELINE, definitionHash: "h", currentStage: "review" });
    const loose = jobWithWorker(db, ALICE, "No pipeline worker");
    activeAt(db, loose, new Date(now.getTime() - MIN));

    // Holds on Alice's workers; an idle notice and Bob's ask are not hers to see.
    const ask = createAsk(db, fresh.sessionId, "ask_human", "Use the staging account?");
    const floor = createAsk(db, loose.sessionId, "permission_prompt", "Bash: git push origin main", undefined, { gate: FLOOR_GATE });
    createAsk(db, stalled.sessionId, "permission_prompt", "Waiting for your input", undefined, { gate: IDLE_NOTICE_GATE });
    const bobs = jobWithWorker(db, BOB, "Bob's job");
    createAsk(db, bobs.sessionId, "ask_human", "Bob's question");

    // Health problems.
    const failed = createPersonaSchedule(db, { owner: ALICE, title: "Nightly sweep", cron: "0 1 * * *", timezone: "UTC", kind: "wake_persona", note: "n", createdBy: ALICE });
    db.run("UPDATE persona_schedules SET last_outcome = 'failed', last_outcome_detail = 'worker crashed', last_run_at = ? WHERE id = ?", [now.toISOString(), failed.id]);
    const missed = createPersonaSchedule(db, { owner: ALICE, title: "Morning check", cron: "0 9 * * *", timezone: "UTC", kind: "wake_persona", note: "n", createdBy: ALICE });
    db.run("UPDATE persona_schedules SET next_run_at = ? WHERE id = ?", [new Date(now.getTime() - 30 * MIN).toISOString(), missed.id]);
    createPersonaSchedule(db, { owner: ALICE, title: "Fine", cron: "0 9 * * *", timezone: "UTC", kind: "wake_persona", note: "n", createdBy: ALICE });
    const pricey = createPersonaJob(db, { owner: ALICE, threadId: thread.id, title: "Long haul", goal: "g" });
    db.run("UPDATE persona_jobs SET created_at = ? WHERE id = ?", [new Date(Date.now() - 9 * 60 * MIN).toISOString(), pricey.id]);
    const overdue = openPersonaCommitment(db, {
      owner: ALICE,
      assignee: "persona",
      jobId: fresh.job.id,
      action: "Report back on the deploy",
      doneCheck: "a reply",
      staleAfter: new Date(now.getTime() - 5 * MIN).toISOString(),
    }).commitment;
    openPersonaCommitment(db, { owner: ALICE, assignee: "persona", action: "Later", doneCheck: "c", staleAfter: new Date(now.getTime() + 60 * MIN).toISOString() });
    const restart = { id: "r1", outcome: "rolled-back", phase: "done", requestedAt: now.toISOString(), finishedAt: now.toISOString(), error: "health check failed" } as RestartRecord;

    const r: StateReport = buildStateReport({ db, owner: ALICE, now, args: "", latestRestart: () => restart, hostMonitor: quietHost() });

    expect(r.waiting.approvals.map((a) => [a.id, a.href])).toEqual([[card.id, `/persona?job=${encodeURIComponent(carded.id)}`]]);
    expect(r.waiting.questions.map((q) => [q.id, q.title])).toEqual([[question.id, "Which branch should I use?"]]);
    expect(r.waiting.reviews.map((p) => [p.id, p.title, p.href])).toEqual([[packet.id, "Add the Review tab", `/review/${packet.id}`]]);
    expect(r.waiting.jobs.map((j) => [j.id, j.detail])).toEqual([[waiting.id, "Two names to choose from"]]);

    const stages = Object.fromEntries(r.inFlight.stages.map((g) => [g.title, g.jobs.map((j) => [j.title, j.stalled])]));
    expect(stages["Coding"]).toEqual([["Fresh worker", false]]);
    expect(stages["Review"]).toEqual([["Quiet worker", true]]);
    expect(stages["No pipeline"]).toEqual(expect.arrayContaining([["No pipeline worker", false]]));
    expect(r.inFlight.stages[r.inFlight.stages.length - 1]!.stage).toBe("");
    expect(r.inFlight.stalled).toBe(1);
    expect(r.inFlight.stages.flatMap((g) => g.jobs).find((j) => j.title === "Fresh worker")!.lastActivityAt).toBeDefined();

    expect(r.holds.map((h) => [h.id, h.detail, h.href]).sort()).toEqual(
      [
        [ask.id, "Worker question on “Fresh worker”", `/work/s/${fresh.sessionId}`],
        [floor.id, "Safety hold on “No pipeline worker”", `/work/s/${loose.sessionId}`],
      ].sort()
    );

    expect(r.health.schedules.map((s) => [s.title, s.detail]).sort()).toEqual([
      ["Morning check", "Missed its last slot"],
      ["Nightly sweep", "Last run failed: worker crashed"],
    ]);
    expect(r.health.budgets.map((b) => [b.title, b.detail])).toEqual([["Long haul", "Over budget"]]);
    expect(r.health.commitments.map((c) => [c.id, c.detail])).toEqual([[overdue.id, "Overdue: Persona promised this"]]);
    expect(r.health.restart).toEqual({ id: "r1", outcome: "rolled-back", phase: "done", at: now.toISOString(), error: "health check failed" });

    // Need you: 1 job + 1 question + 1 approval + 1 review.
    // Look off: 1 stalled + 2 holds waiting 45 min + restart + 2 schedules + 1 over budget + 1 commitment.
    expect(r.verdict).toEqual({ needYou: 4, lookOff: 8, line: "4 things need you · 8 things look off" });
  });

  test("a fresh hold is listed but not counted; a carded one is shown once, as its card", () => {
    const db = setUp();
    const w = jobWithWorker(db, ALICE, "Worker");
    const fresh = createAsk(db, w.sessionId, "ask_human", "Use staging?");
    const carded = createAsk(db, w.sessionId, "permission_prompt", "Bash: rm -rf build", undefined, { gate: FLOOR_GATE });
    createPersonaApproval(db, { owner: ALICE, jobId: w.job.id, action: "answer_ask", summary: "Allow rm -rf build", args: { askId: carded.id, answer: "Allow once" } });
    openPersonaCommitment(db, {
      owner: ALICE,
      assignee: "persona",
      autoKey: `ask:${carded.id}`,
      action: "Answer the hold",
      doneCheck: "answered",
      staleAfter: new Date(Date.now() - 60_000).toISOString(),
    });
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: quietHost() });
    expect(r.holds.map((h) => h.id)).toEqual([fresh.id]);
    expect(r.waiting.approvals).toHaveLength(1);
    expect(r.health.commitments).toEqual([]);
    expect(r.verdict).toEqual({ needYou: 1, lookOff: 0, line: "1 thing needs you" });
  });

  test("a job waiting on a pending review is shown once, under the review", () => {
    const db = setUp();
    const w = jobWithWorker(db, ALICE, "Ship tab");
    updatePersonaJob(db, w.job.id, { status: "waiting_user" });
    const packet = createReviewPacket(db, { owner: ALICE, launchId: w.launchId, jobId: w.job.id });
    submitReviewPacket(db, { id: packet.id, owner: ALICE, draft: draft("Review tab") });
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: quietHost() });
    expect(r.waiting.reviews.map((p) => p.id)).toEqual([packet.id]);
    expect(r.waiting.jobs).toEqual([]);
  });

  test("slots missed while Standup was down show; an old failed restart no longer looks off", () => {
    const db = setUp();
    const s = createPersonaSchedule(db, { owner: ALICE, title: "Morning check", cron: "0 9 * * *", timezone: "UTC", kind: "wake_persona", note: "n", createdBy: ALICE });
    db.run("UPDATE persona_schedules SET last_outcome = 'skipped', last_outcome_detail = ?, last_run_at = ? WHERE id = ?", [
      "missed 2 runs while Standup wasn't running (catch-up policy: skip)",
      new Date().toISOString(),
      s.id,
    ]);
    const old = { id: "r", outcome: "failed", phase: "done", requestedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } as RestartRecord;
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: quietHost(), latestRestart: () => old });
    expect(r.health.schedules).toHaveLength(1);
    expect(r.health.schedules[0]!.detail).toStartWith("Missed while Standup was down: 2 runs while Standup wasn't running");
    expect(r.health.restart?.outcome).toBe("failed");
    expect(r.verdict.lookOff).toBe(1);
  });

  test("a job waiting on a listed approval is shown once, under the approval", () => {
    const db = setUp();
    const job = createPersonaJob(db, { owner: ALICE, threadId: "t", title: "Deploy", goal: "g" });
    updatePersonaJob(db, job.id, { status: "waiting_user" });
    createPersonaApproval(db, { owner: ALICE, jobId: job.id, action: "launch_session", summary: "Launch it", args: {} });
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: quietHost() });
    expect(r.waiting.jobs).toEqual([]);
    expect(r.waiting.approvals).toHaveLength(1);
    expect(r.verdict.line).toBe("1 thing needs you");
  });

  test("a busy host and a failed restart look off", () => {
    const db = setUp();
    const busy = new HostMonitor({ provider: () => ({ memAvailableBytes: 512 * 1024 ** 2, memTotalBytes: 64 * 1024 ** 3, load1: 90, cores: 16 }) });
    const restart = { id: "r2", outcome: "failed", phase: "done", requestedAt: new Date().toISOString() } as RestartRecord;
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: busy, latestRestart: () => restart });
    expect(r.health.host?.hostLimited).toBe(true);
    expect(r.verdict).toEqual({ needYou: 0, lookOff: 2, line: "2 things look off" });
  });

  test("runs well inside 300ms over a few hundred rows", () => {
    const db = setUp();
    const thread = getOrCreatePersonaConsoleThread(db, ALICE);
    for (let i = 0; i < 60; i++) {
      const w = jobWithWorker(db, ALICE, `Job ${i}`);
      createPipelineRun(db, { launchId: w.launchId, owner: ALICE, definition: DEFAULT_PIPELINE, definitionHash: "h", currentStage: i % 2 ? "coding" : "review" });
      createAsk(db, w.sessionId, "ask_human", `Question ${i}`);
      if (i % 3 === 0) createPersonaApproval(db, { owner: ALICE, jobId: w.job.id, action: "launch_session", summary: `Card ${i}`, args: {} });
      appendPersonaMessage(db, { threadId: thread.id, role: "persona", text: `Update ${i}` });
    }
    const started = performance.now();
    const r = buildStateReport({ db, owner: ALICE, now: new Date(), args: "", hostMonitor: quietHost() });
    const ms = performance.now() - started;
    expect(r.inFlight.total).toBe(60);
    expect(ms).toBeLessThan(300);
  });
});
