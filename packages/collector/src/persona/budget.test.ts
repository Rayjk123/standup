import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createLaunch,
  createPersonaJob,
  createSession,
  endSession,
  getPendingSteers,
  getPersonaApproval,
  insertEvent,
  linkPersonaJobLaunch,
  listPendingPersonaInbox,
  listPersonaMessages,
  listPersonaTurns,
  personaJobBudget,
  personaTurnOwnCost,
  recordPersonaTurn,
  setJobBudgetPrefs,
  setPersonaJobBudget,
  upsertProject,
  createStore,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { resolvePersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";
import { parseTurnOutput } from "./turn.js";
import type { TurnInput, TurnResult } from "./turn.js";
import { jobWorkerCost } from "./budget.js";
import { budgetAmountsMissing } from "./tools.js";

const OWNER = "alice";

/** A turn's stream-json stdout whose result reports `cost` and some tokens. */
function turnStdout(cost: number): string {
  return [
    { type: "system", subtype: "init", session_id: "sid-1" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "sid-1",
      result: "ok",
      total_cost_usd: cost,
      usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 42 },
      modelUsage: { "claude-opus-4-1": { costUSD: cost } },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
}

function harness(opts: { runner?: (input: TurnInput) => Promise<TurnResult>; workerCost?: () => number } = {}) {
  const store = createStore(":memory:");
  const frames: WsMessage[] = [];
  let nowMs = Date.parse("2026-10-08T12:00:00.000Z");
  let workerUsd = 0;
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: (m) => frames.push(m),
    turnRunner: opts.runner ?? (async () => parseTurnOutput(turnStdout(0.031), "", 0)),
    now: () => new Date(nowMs),
    jobWorkerCost: async () => opts.workerCost?.() ?? workerUsd,
  });
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  /** A job with one running worker in project `p`. */
  const jobWithWorker = (title = "Ship it") => {
    const job = createPersonaJob(store.db, { owner: OWNER, threadId: runtime.consoleThreadId(), title, goal: "g" });
    // Opened on the harness clock, so its wall-clock time is the harness's.
    store.db.run("UPDATE persona_jobs SET created_at = ?, updated_at = ? WHERE id = ?", [
      new Date(nowMs).toISOString(),
      new Date(nowMs).toISOString(),
      job.id,
    ]);
    const launchId = `L-${randomUUID().slice(0, 6)}`;
    const sessionId = `S-${randomUUID().slice(0, 6)}`;
    createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: `/wt/${launchId}`, branch: "b" });
    createSession(store.db, { id: sessionId, projectId: "p", title: "w", cwd: `/wt/${launchId}`, status: "running" });
    attachSessionToLaunch(store.db, launchId, sessionId);
    linkPersonaJobLaunch(store.db, job.id, launchId, false);
    return { job, launchId, sessionId };
  };
  return {
    store,
    runtime,
    frames,
    jobWithWorker,
    setWorkerUsd(v: number) {
      workerUsd = v;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    now() {
      return new Date(nowMs);
    },
    systemItems() {
      return listPendingPersonaInbox(store.db, OWNER, "system").filter((i) => i.payload.type === "job_budget");
    },
  };
}

describe("Persona's cost ledger", () => {
  test("every turn writes a persona_turns row whose cost matches the turn's result JSON", async () => {
    // The CLI restores a resumed session's cost, so each result reports the session's running total.
    let reported = 0;
    const h = harness({
      runner: async () => {
        reported += 0.031;
        return parseTurnOutput(turnStdout(reported), "", 0);
      },
    });
    const { job } = h.jobWithWorker();
    h.runtime.receiveUserMessage({ text: "how is it going?", actor: OWNER, jobId: job.id });
    await h.runtime.drain();
    h.runtime.receiveUserMessage({ text: "and now?", actor: OWNER });
    await h.runtime.drain();

    const turns = listPersonaTurns(h.store.db, OWNER).reverse();
    expect(turns).toHaveLength(2);
    // As reported in each result's JSON; the second resumed the first's session.
    expect(turns.map((t) => t.reportedCostUsd)).toEqual([0.031, 0.062]);
    expect(turns.map((t) => t.claudeSessionId)).toEqual(["sid-1", "sid-1"]);
    for (const turn of turns) {
      expect(turn.costUsd).toBeCloseTo(0.031, 10);
      expect(turn.inputTokens).toBe(1000);
      expect(turn.outputTokens).toBe(42);
      expect(turn.model).toBe("claude-opus-4-1");
      expect(turn.ok).toBe(true);
      expect(turn.threadId).toBe(h.runtime.consoleThreadId());
    }
    // The turn about the job is the job's; the other is attributed to none.
    expect(turns[0]!.jobIds).toEqual([job.id]);
    expect(turns[1]!.jobIds).toEqual([]);
    expect(personaJobBudget(h.store.db, job.id)!.personaUsd).toBeCloseTo(0.031, 10);
  });

  test("a failed turn that still reported a result records its cost; a turn split across jobs shares it evenly", async () => {
    const h = harness({
      runner: async () =>
        parseTurnOutput(turnStdout(0.2).replace('"is_error":false', '"is_error":true'), "", 1),
    });
    const a = h.jobWithWorker("A").job;
    const b = h.jobWithWorker("B").job;
    h.runtime.enqueue("worker_event", { type: "ask", jobId: a.id });
    h.runtime.enqueue("worker_event", { type: "ask", jobId: b.id });
    await h.runtime.drain();
    const [turn] = listPersonaTurns(h.store.db, OWNER);
    expect(turn!.ok).toBe(false);
    expect(turn!.costUsd).toBe(0.2);
    expect([...turn!.jobIds].sort()).toEqual([a.id, b.id].sort());
    expect(personaJobBudget(h.store.db, a.id)!.personaUsd).toBeCloseTo(0.1, 10);
    expect(personaJobBudget(h.store.db, b.id)!.personaUsd).toBeCloseTo(0.1, 10);
  });
});

describe("per-job budgets", () => {
  test("a $1 job whose worker passes $1 gets an 80% notice, then a stop steer at 100%, and its next launch waits for the owner", async () => {
    const h = harness();
    const { job, sessionId } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { usd: 1 });

    h.setWorkerUsd(0.5);
    await h.runtime.budgets.check();
    expect(h.systemItems()).toHaveLength(0);

    h.setWorkerUsd(0.85);
    await h.runtime.budgets.check();
    const near = h.systemItems();
    expect(near).toHaveLength(1);
    expect(near[0]!.payload).toMatchObject({ level: "near", jobId: job.id, budgetUsd: 1 });
    expect(getPendingSteers(h.store.db, sessionId)).toHaveLength(0);
    // Once per threshold.
    await h.runtime.budgets.check();
    expect(h.systemItems()).toHaveLength(1);

    h.setWorkerUsd(1.3);
    await h.runtime.budgets.check();
    const items = h.systemItems();
    expect(items.map((i) => i.payload.level)).toEqual(["near", "exceeded"]);
    expect(items[1]!.payload.steered).toEqual([sessionId]);
    const steers = getPendingSteers(h.store.db, sessionId);
    expect(steers).toHaveLength(1);
    expect(steers[0]!.body).toContain("checkpoint");
    expect(steers[0]!.body).toContain("stop and wait");
    // The worker is asked, never killed.
    expect(h.store.db.query("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId)).toEqual({ ended_at: null });
    // The owner is told in the job's thread.
    const owner = listPersonaMessages(h.store.db, h.runtime.consoleThreadId()).filter((m) => m.role === "system");
    expect(owner.at(-1)!.text).toContain("reached its budget");
    expect(owner.at(-1)!.jobIds).toEqual([job.id]);

    // Relaunching for the job is held for the owner.
    const result = await h.runtime.tools.call("launch_session", { task: "keep going", projectId: "p", jobId: job.id });
    const body = JSON.parse(result.content[0]!.text) as { status: string; approvalId: string };
    expect(body.status).toBe("pending_approval");
    const approval = getPersonaApproval(h.store.db, body.approvalId)!;
    expect(approval.holdRule).toBe("job-budget");
    expect(approval.summary).toContain("over its budget");
  });

  test("raising an exceeded job's budget is the owner's; once raised it re-arms and launches no longer wait", async () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { usd: 1 });
    h.setWorkerUsd(1.5);
    await h.runtime.budgets.check();

    const raise = await h.runtime.tools.call("update_job", { jobId: job.id, budgetUsd: 3 });
    const held = JSON.parse(raise.content[0]!.text) as { status: string; approvalId: string };
    expect(held.status).toBe("pending_approval");
    expect(getPersonaApproval(h.store.db, held.approvalId)!.holdRule).toBe("job-budget-raise");
    expect(personaJobBudget(h.store.db, job.id)!.usd).toBe(1);

    // Lowering is bookkeeping.
    const lower = await h.runtime.tools.call("update_job", { jobId: job.id, budgetMinutes: 60 });
    expect(lower.isError).toBeFalsy();
    expect(personaJobBudget(h.store.db, job.id)!.minutes).toBe(60);

    // The owner raises it (their approval runs the stored call).
    setPersonaJobBudget(h.store.db, job.id, { usd: 3 });
    await h.runtime.budgets.check();
    const owner = listPersonaMessages(h.store.db, h.runtime.consoleThreadId()).filter((m) => m.role === "system");
    expect(owner.at(-1)!.text).toContain("back within its budget");
    expect(personaJobBudget(h.store.db, job.id, h.now())!.level).toBe("ok");
  });

  test("the wall-clock budget is enforced the same way", async () => {
    const h = harness();
    const { job, sessionId } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { minutes: 60 });
    h.advance(50 * 60_000);
    await h.runtime.budgets.check();
    expect(h.systemItems().map((i) => i.payload.level)).toEqual(["near"]);
    h.advance(15 * 60_000);
    await h.runtime.budgets.check();
    expect(h.systemItems().map((i) => i.payload.level)).toEqual(["near", "exceeded"]);
    expect(getPendingSteers(h.store.db, sessionId)).toHaveLength(1);
  });

  test("an ended worker is not steered, and a job with no limit never notifies", async () => {
    const h = harness();
    const { job, sessionId } = h.jobWithWorker();
    endSession(h.store.db, sessionId);
    setPersonaJobBudget(h.store.db, job.id, { usd: 1 });
    h.setWorkerUsd(2);
    await h.runtime.budgets.check();
    expect(h.systemItems()[0]!.payload.steered).toEqual([]);
    expect(getPendingSteers(h.store.db, sessionId)).toHaveLength(0);

    const free = h.jobWithWorker("free").job;
    setPersonaJobBudget(h.store.db, free.id, { usd: 0, minutes: 0 });
    h.advance(30 * 24 * 60 * 60_000);
    await h.runtime.budgets.check();
    expect(h.systemItems().filter((i) => i.payload.jobId === free.id)).toHaveLength(0);
  });

  test("defaults resolve job > the owner's project layer > the owner's default > Standup's, scoped to the owner", () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: null, minutes: 480, source: { usd: "default", minutes: "default" } });
    setJobBudgetPrefs(h.store.db, OWNER, null, { usd: 10, minutes: null });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 10, minutes: 480, source: { usd: "user", minutes: "default" } });
    setJobBudgetPrefs(h.store.db, OWNER, "p", { usd: 4, minutes: 90 });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 4, minutes: 90, source: { usd: "project", minutes: "project" } });
    setPersonaJobBudget(h.store.db, job.id, { usd: 2 });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 2, minutes: 90, source: { usd: "job", minutes: "project" } });
    // Another user's layers never reach this owner's job.
    setJobBudgetPrefs(h.store.db, "bob", "p", { usd: 999, minutes: 999 });
    setJobBudgetPrefs(h.store.db, "bob", null, { usd: 999, minutes: 999 });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 2, minutes: 90 });
  });

  test("open_job with a budget above the owner's default is held; within it, it opens", async () => {
    const h = harness();
    setJobBudgetPrefs(h.store.db, OWNER, null, { usd: 10, minutes: null });
    const within = await h.runtime.tools.call("open_job", { title: "small", goal: "g", budgetUsd: 5 });
    const opened = JSON.parse(within.content[0]!.text) as { jobId: string };
    expect(personaJobBudget(h.store.db, opened.jobId)!.usd).toBe(5);
    const above = await h.runtime.tools.call("open_job", { title: "big", goal: "g", budgetUsd: 500 });
    expect(JSON.parse(above.content[0]!.text).status).toBe("pending_approval");
    // No limit is above the owner's $10.
    const noUsdLimit = await h.runtime.tools.call("open_job", { title: "free spend", goal: "g", budgetUsd: 0 });
    expect(JSON.parse(noUsdLimit.content[0]!.text).status).toBe("pending_approval");
    const unlimited = await h.runtime.tools.call("open_job", { title: "free", goal: "g", budgetMinutes: 0 });
    expect(JSON.parse(unlimited.content[0]!.text).status).toBe("pending_approval");
    const bad = await h.runtime.tools.call("open_job", { title: "x", goal: "g", budgetUsd: -1 });
    expect(bad.isError).toBe(true);
  });
});

describe("per-job budgets — no spend limit by default", () => {
  test("with no owner setting, budgetUsd 0 and any dollar amount open directly; a time raise is still held", async () => {
    const h = harness();
    const free = await h.runtime.tools.call("open_job", { title: "free", goal: "g", budgetUsd: 0 });
    const freeJob = JSON.parse(free.content[0]!.text) as { jobId: string; status: string };
    expect(freeJob.status).toBe("active");
    expect(personaJobBudget(h.store.db, freeJob.jobId)).toMatchObject({ usd: null, minutes: 480, source: { usd: "job" } });
    const capped = await h.runtime.tools.call("open_job", { title: "capped", goal: "g", budgetUsd: 500 });
    expect(JSON.parse(capped.content[0]!.text).status).toBe("active");
    const longer = await h.runtime.tools.call("open_job", { title: "long", goal: "g", budgetUsd: 0, budgetMinutes: 600 });
    expect(JSON.parse(longer.content[0]!.text).status).toBe("pending_approval");
    const shorter = await h.runtime.tools.call("open_job", { title: "short", goal: "g", budgetUsd: 0, budgetMinutes: 60 });
    expect(JSON.parse(shorter.content[0]!.text).status).toBe("active");
  });

  test("a new job picks up the owner's default; a project layer still overrides it", async () => {
    const h = harness();
    setJobBudgetPrefs(h.store.db, OWNER, null, { usd: 0, minutes: 120 });
    const opened = await h.runtime.tools.call("open_job", { title: "plain", goal: "g" });
    const { jobId } = JSON.parse(opened.content[0]!.text) as { jobId: string };
    expect(personaJobBudget(h.store.db, jobId)).toMatchObject({ usd: null, minutes: 120, source: { usd: "user", minutes: "user" } });
    // budgetUsd 0 matches the owner's no-limit default, so it isn't held.
    const zero = await h.runtime.tools.call("open_job", { title: "zero", goal: "g", budgetUsd: 0 });
    expect(JSON.parse(zero.content[0]!.text).status).toBe("active");
    const { job } = h.jobWithWorker();
    setJobBudgetPrefs(h.store.db, OWNER, "p", { usd: 3, minutes: null });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 3, minutes: 120, source: { usd: "project", minutes: "user" } });
  });

  test("a job with no spend limit never gets a spend notice; its time budget still warns", async () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    h.setWorkerUsd(1_000_000);
    await h.runtime.budgets.check();
    expect(personaJobBudget(h.store.db, job.id)!.usd).toBeNull();
    expect(h.systemItems().filter((i) => i.payload.jobId === job.id)).toHaveLength(0);
    h.advance(7 * 60 * 60_000);
    await h.runtime.budgets.check();
    expect(h.systemItems().filter((i) => i.payload.jobId === job.id).map((i) => i.payload.level)).toEqual(["near"]);
  });

  test("an existing job keeps its stored dollar budget when the default has none", () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { usd: 25 });
    expect(personaJobBudget(h.store.db, job.id)).toMatchObject({ usd: 25, source: { usd: "job" } });
  });

  test("update_job: lifting a stored dollar limit is a raise; lowering, or 0 on an inheriting job, is not", async () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    const inherit = await h.runtime.tools.call("update_job", { jobId: job.id, budgetUsd: 0 });
    expect(JSON.parse(inherit.content[0]!.text).status).toBe("active");
    setPersonaJobBudget(h.store.db, job.id, { usd: 25 });
    const lower = await h.runtime.tools.call("update_job", { jobId: job.id, budgetUsd: 10 });
    expect(JSON.parse(lower.content[0]!.text).status).toBe("active");
    const lift = await h.runtime.tools.call("update_job", { jobId: job.id, budgetUsd: 0 });
    expect(JSON.parse(lift.content[0]!.text).status).toBe("pending_approval");
  });
});

describe("per-job budgets — review fixes", () => {
  test("a check that finds a job past its budget straight from under 80% still sends the 80% notice first", async () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { usd: 1 });
    h.setWorkerUsd(5);
    await h.runtime.budgets.check();
    expect(h.systemItems().map((i) => i.payload.level)).toEqual(["near", "exceeded"]);
  });

  test("every check re-sends the job so the console's bar follows the spend", async () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    h.setWorkerUsd(1);
    await h.runtime.budgets.check();
    h.setWorkerUsd(2);
    await h.runtime.budgets.check();
    const frames = h.frames.filter((f) => f.type === "persona:job" && (f.payload as { id: string }).id === job.id);
    expect(frames.map((f) => (f.payload as { budget?: { workerUsd: number } }).budget?.workerUsd)).toEqual([1, 2]);
  });

  test("a light check after a turn uses the cached workers' cost; transcripts are read on the interval", async () => {
    let reads = 0;
    const h = harness({ workerCost: () => (reads++, 0.5) });
    h.jobWithWorker();
    await h.runtime.budgets.maybeCheck();
    expect(reads).toBe(1);
    h.runtime.budgets.markDirty();
    await h.runtime.budgets.maybeCheck();
    expect(reads).toBe(1);
    h.advance(5 * 60_000);
    await h.runtime.budgets.maybeCheck();
    expect(reads).toBe(2);
  });

  test("time spent waiting on the owner doesn't count against the time budget", () => {
    const h = harness();
    const { job } = h.jobWithWorker();
    const hoursAgo = (n: number) => new Date(h.now().getTime() - n * 3_600_000).toISOString();
    h.store.db.run("UPDATE persona_jobs SET created_at = ? WHERE id = ?", [hoursAgo(10), job.id]);
    // Waiting now, for the last 9 hours.
    h.store.db.run("UPDATE persona_jobs SET status = 'waiting_user', waiting_since = ? WHERE id = ?", [hoursAgo(9), job.id]);
    expect(Math.round(personaJobBudget(h.store.db, job.id, h.now())!.elapsedMinutes)).toBe(60);
    // A finished waiting period is kept by the trigger when waiting_since clears.
    h.store.db.run("UPDATE persona_jobs SET waiting_since = ? WHERE id = ?", [new Date(Date.now() - 2 * 3_600_000).toISOString(), job.id]);
    h.store.db.run("UPDATE persona_jobs SET status = 'active', waiting_since = NULL WHERE id = ?", [job.id]);
    const waitingMs = (h.store.db.query("SELECT waiting_ms FROM persona_jobs WHERE id = ?").get(job.id) as { waiting_ms: number }).waiting_ms;
    // The first period (9h → replaced) and the second (≈2h of real time) both count.
    expect(waitingMs).toBeGreaterThan(2 * 3_600_000 - 60_000);
  });

  test("open_job above the owner's lowest project setting is held, since its first launch may land there", async () => {
    const h = harness();
    setJobBudgetPrefs(h.store.db, OWNER, "p", { usd: 5, minutes: null });
    const res = await h.runtime.tools.call("open_job", { title: "sneaky", goal: "g", budgetUsd: 20 });
    expect(JSON.parse(res.content[0]!.text).status).toBe("pending_approval");
  });

  test("ordinary bookkeeping is never held as a raise: no budget args, a job with its own no-limit budget, a note after a raise", async () => {
    const h = harness();
    setJobBudgetPrefs(h.store.db, OWNER, "p", { usd: 5, minutes: 60 });
    const opened = await h.runtime.tools.call("open_job", { title: "plain", goal: "g" });
    const { jobId } = JSON.parse(opened.content[0]!.text) as { jobId: string };
    expect(jobId).toBeTruthy();
    // Lower on one dimension only: the other isn't compared.
    const lower = await h.runtime.tools.call("open_job", { title: "cheap", goal: "g", budgetUsd: 2 });
    expect(JSON.parse(lower.content[0]!.text).jobId).toBeTruthy();
    const note = await h.runtime.tools.call("update_job", { jobId, note: "progress" });
    expect(note.isError).toBeFalsy();
    expect(JSON.parse(note.content[0]!.text).status).toBe("active");
    // A job with its own no-limit budget (as a job open before budgets got) takes notes and a set budget freely.
    setPersonaJobBudget(h.store.db, jobId, { usd: 0, minutes: 0 });
    expect(JSON.parse((await h.runtime.tools.call("update_job", { jobId, note: "more" })).content[0]!.text).status).toBe("active");
    expect(JSON.parse((await h.runtime.tools.call("update_job", { jobId, budgetUsd: 100 })).content[0]!.text).status).toBe("active");
  });

  test("messaging or recovering a worker of a job over its budget is held for the owner; stopping it is not", async () => {
    const h = harness();
    const { job, sessionId } = h.jobWithWorker();
    setPersonaJobBudget(h.store.db, job.id, { usd: 1 });
    h.setWorkerUsd(2);
    await h.runtime.budgets.check();
    for (const [name, args] of [
      ["send_to_session", { sessionId, text: "keep going", mode: "next_turn" }],
      ["recover_session", { sessionId }],
    ] as const) {
      const res = await h.runtime.tools.call(name, args);
      const body = JSON.parse(res.content[0]!.text) as { status: string; approvalId: string };
      expect(body.status).toBe("pending_approval");
      expect(getPersonaApproval(h.store.db, body.approvalId)!.holdRule).toBe("job-budget");
    }
  });
});

describe("personaTurnOwnCost", () => {
  test("a resumed session's running total is turned into the turn's own cost", () => {
    const last = (previous: number | null) => ({ anyTurn: true, ranLast: true, previous });
    expect(personaTurnOwnCost(0.5, false, last(0.2))).toBe(0.5);
    expect(personaTurnOwnCost(0.5, true, last(0.2))).toBeCloseTo(0.3, 10);
    // A failed resumed turn that made no call reports the restored total unchanged: it cost nothing.
    expect(personaTurnOwnCost(0.2, true, last(0.2))).toBe(0);
    // Below the previous report the CLI started from zero after all.
    expect(personaTurnOwnCost(0.05, true, last(0.2))).toBe(0.05);
    expect(personaTurnOwnCost(null, true, last(0.2))).toBeNull();
    // Another session ran in the cwd since: the CLI started from zero, so the report is the turn's own.
    expect(personaTurnOwnCost(0.3, true, { anyTurn: true, ranLast: false, previous: 0.1 })).toBe(0.3);
    // Nothing to subtract a restored total from (the ledger's first turn): unknown, kept as the baseline.
    expect(personaTurnOwnCost(15, true, { anyTurn: false, ranLast: false, previous: null })).toBeNull();
    expect(personaTurnOwnCost(15, true, last(null))).toBeNull();
  });

  test("interleaved private and thread sessions in one cwd are each charged their own cost", () => {
    const store = createStore(":memory:");
    const turn = (session: string, reported: number, resumed: boolean) =>
      recordPersonaTurn(store.db, {
        user: OWNER,
        ok: true,
        startedAt: new Date(Date.now() + Math.random()).toISOString(),
        durationMs: 1,
        reportedCostUsd: reported,
        claudeSessionId: session,
        resumed,
      }).costUsd;
    expect(turn("P", 0.1, false)).toBe(0.1);
    expect(turn("P", 0.25, true)).toBeCloseTo(0.15, 10);
    expect(turn("T", 0.05, false)).toBe(0.05);
    // P resumed after T ran: the CLI started from zero.
    expect(turn("P", 0.3, true)).toBe(0.3);
  });

  test("a resume the CLI reports under another session id is charged against the resumed session's total", () => {
    const store = createStore(":memory:");
    const at = () => new Date(Date.now() + Math.random()).toISOString();
    recordPersonaTurn(store.db, { user: OWNER, ok: true, startedAt: at(), durationMs: 1, reportedCostUsd: 4, claudeSessionId: "S" });
    const forked = recordPersonaTurn(store.db, {
      user: OWNER,
      ok: true,
      startedAt: at(),
      durationMs: 1,
      reportedCostUsd: 4.1,
      claudeSessionId: "S2",
      resumed: true,
      resumedSessionId: "S",
    });
    expect(forked.costUsd).toBeCloseTo(0.1, 10);
    expect(forked.claudeSessionId).toBe("S2");
  });
});

describe("budgetAmountsMissing", () => {
  test("an owner's yes covers a budget raise only when it names the new amount", () => {
    expect(budgetAmountsMissing("yes, bump it to $30", { budgetUsd: 30 })).toBeNull();
    expect(budgetAmountsMissing("yes, 30.00 is fine", { budgetUsd: 30 })).toBeNull();
    expect(budgetAmountsMissing("yes, bump it to $30", { budgetUsd: 10000 })).toBe("budgetUsd 10000");
    expect(budgetAmountsMissing("yes go ahead", { budgetUsd: 0 })).toBe("budgetUsd no limit");
    expect(budgetAmountsMissing("yes, no limit on time", { budgetMinutes: 0 })).toBeNull();
    expect(budgetAmountsMissing("yes $5 and 90 minutes", { budgetUsd: 5, budgetMinutes: 90 })).toBeNull();
    expect(budgetAmountsMissing("extend it to 10h", { budgetMinutes: 600 })).toBeNull();
    expect(budgetAmountsMissing("yes, back to the default", { budgetUsd: null })).toBeNull();
    expect(budgetAmountsMissing("yes", { budgetUsd: null })).toBe("budgetUsd default");
  });
});

describe("jobWorkerCost", () => {
  test("sums the job's workers' transcripts, including a subagent's own file", () => {
    const store = createStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "job-worker-cost-"));
    try {
      upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
      const line = (tokens: number) =>
        JSON.stringify({
          type: "assistant",
          uuid: randomUUID(),
          sessionId: "S1",
          message: { role: "assistant", id: randomUUID(), model: "claude-sonnet-4-6", usage: { input_tokens: tokens, output_tokens: 0 } },
        });
      writeFileSync(join(dir, "root.jsonl"), line(1_000_000) + "\n");
      writeFileSync(join(dir, "child.jsonl"), line(1_000_000) + "\n");
      createLaunch(store.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt/L1", branch: "b" });
      createSession(store.db, { id: "S1", projectId: "p", title: "w", cwd: "/wt/L1", status: "running" });
      attachSessionToLaunch(store.db, "L1", "S1");
      insertEvent(store.db, "S1", "PostToolUse", { transcript_path: join(dir, "root.jsonl") });
      createSession(store.db, { id: "S1-child", projectId: "p", title: "sub", cwd: "/wt/L1", status: "running", parentSessionId: "S1", kind: "subagent" });
      insertEvent(store.db, "S1-child", "PostToolUse", { transcript_path: join(dir, "child.jsonl") });
      const job = createPersonaJob(store.db, { owner: OWNER, threadId: "t", title: "j", goal: "g" });
      linkPersonaJobLaunch(store.db, job.id, "L1", false);
      return jobWorkerCost(store.db, job.id).then((cost) => {
        // $3 per million input tokens on Sonnet, twice.
        expect(cost).toBeCloseTo(6, 6);
      });
    } finally {
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 1000);
    }
  });
});
