import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createPersonaJob, createSteer, getOrCreatePersonaConsoleThread, getPipelineRun, listPipelineDecisions } from "@standup/store";
import type { PipelineRun } from "@standup/shared";
import {
  MAX_STOP_BLOCKS,
  formatPipelineInstruction,
  markRunWaiting,
  personaParkDecision,
  pipelineJobSummary,
  pipelinePromptSubmitted,
  pipelineStopDecision,
  recordPaneSend,
} from "./engine.js";
import { EVIDENCE, OWNER, WORKTREE, advance, makeWorld, post, type World } from "./test-world.js";
import { formatPipelineStatus } from "../../../mcp/src/tools.js";

/*
 * Parking: a worker told to wait (on another job landing) ends its turns
 * without the Stop hook demanding a stage report or an ask; the next message
 * to it, an un-park or an advance lets the pipeline hold its Stops again.
 */

const REASON = "waiting for the schema job to land on main first";
const runOf = (w: World) => getPipelineRun(w.store.db, w.run.id)!;

async function hook(w: World, event: string, extra: Record<string, unknown> = {}) {
  const res = await post(w, "/hook", { session_id: w.sessionId, cwd: WORKTREE, hook_event_name: event, ...extra });
  return (await res.json()) as Record<string, any>;
}

async function toCoding(w: World) {
  await advance(w, "start");
  expect(runOf(w).currentStage).toBe("coding");
}

async function park(w: World, body: Record<string, unknown>) {
  const res = await post(w, "/api/pipeline/park", { session_id: w.sessionId, cwd: WORKTREE, ...body });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function unpark(w: World) {
  const res = await post(w, "/api/pipeline/unpark", { session_id: w.sessionId, cwd: WORKTREE });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** One of the owner's Persona jobs, for a park to wait on. */
function otherJob(w: World, owner = OWNER) {
  const thread = getOrCreatePersonaConsoleThread(w.store.db, owner);
  return createPersonaJob(w.store.db, { owner, threadId: thread.id, title: "Schema change", goal: "land the schema" });
}

const parkedFrames = (w: World) =>
  w.broadcasts.filter((m) => m.type === "pipeline:updated" && (m.payload as PipelineRun).id === w.run.id).map((m) => (m.payload as PipelineRun).parked);

describe("the Stop hook while parked", () => {
  test("an unparked worker at coding has its Stop blocked", async () => {
    const w = makeWorld();
    await toCoding(w);
    const out = await hook(w, "Stop");
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("you're at");
    expect(runOf(w).stopBlocks).toBe(1);
  });

  test("a parked worker's Stops go through, uncounted and never stalled; pipeline_status shows the park", async () => {
    const w = makeWorld();
    await toCoding(w);
    const job = otherJob(w);
    const res = await park(w, { reason: REASON, waitingOnJobId: job.id });
    expect(res.status).toBe(200);
    expect(res.body.parked).toMatchObject({ reason: REASON, waitingOnJobId: job.id, by: "worker", actor: w.sessionId });
    expect(parkedFrames(w).at(-1)).toMatchObject({ reason: REASON, waitingOnJobId: job.id });

    for (let i = 0; i < MAX_STOP_BLOCKS + 2; i++) {
      const out = await hook(w, "Stop");
      expect(out.decision).toBeUndefined();
    }
    const run = runOf(w);
    expect(run.stopBlocks).toBe(0);
    expect(run.status).toBe("active");
    expect(run.currentStage).toBe("coding");

    const status = await post(w, "/api/pipeline/status", { session_id: w.sessionId, cwd: WORKTREE });
    const view = (await status.json()) as Parameters<typeof formatPipelineStatus>[0];
    expect(view.run.parked).toMatchObject({ reason: REASON, waitingOnJobId: job.id, by: "worker" });
    expect(formatPipelineStatus(view)).toContain(`Parked waiting on job ${job.id}: ${REASON}`);
  });

  test("a park doesn't change the run's updated_at, so an advance read before it still applies", async () => {
    const w = makeWorld();
    await toCoding(w);
    const before = runOf(w).updatedAt;
    await park(w, { reason: REASON });
    expect(runOf(w).updatedAt).toBe(before);
  });
});

describe("what un-parks a run", () => {
  test("the next prompt to the worker clears the park, and its Stop is blocked again", async () => {
    const w = makeWorld();
    await toCoding(w);
    await park(w, { reason: REASON });
    expect((await hook(w, "Stop")).decision).toBeUndefined();
    await hook(w, "UserPromptSubmit", { prompt: "the schema job landed; carry on" });
    expect(runOf(w).parked).toBeUndefined();
    expect(parkedFrames(w).at(-1)).toBeUndefined();
    expect((await hook(w, "Stop")).decision).toBe("block");
    // Clearing again is a no-op.
    await hook(w, "UserPromptSubmit", { prompt: "again" });
    expect(runOf(w).parked).toBeUndefined();
  });

  test("a steer delivered at a checkpoint clears the park", async () => {
    const w = makeWorld();
    await toCoding(w);
    await park(w, { reason: REASON });
    createSteer(w.store.db, w.sessionId, "stop waiting, the job landed");
    const res = await post(w, "/api/checkpoint", { session_id: w.sessionId, cwd: WORKTREE, summary: "still waiting" });
    expect(((await res.json()) as { steers?: string }).steers).toContain("stop waiting");
    expect(runOf(w).parked).toBeUndefined();
    expect((await hook(w, "Stop")).decision).toBe("block");
  });

  test("a checkpoint with nothing to deliver leaves the park", async () => {
    const w = makeWorld();
    await toCoding(w);
    await park(w, { reason: REASON });
    await post(w, "/api/checkpoint", { session_id: w.sessionId, cwd: WORKTREE, summary: "still waiting" });
    expect(runOf(w).parked).toBeDefined();
  });

  describe("a message typed into a busy worker's pane, then Persona's park", () => {
    const SENT = "hold off until the schema job lands, then rebase";
    const personaPark = (w: World) =>
      expect(personaParkDecision(w.store.db, w.run.id, { park: true, why: REASON, actor: `${OWNER}'s Persona` }, w.deps).ok).toBe(true);
    afterEach(() => setSystemTime());

    test("is submitted 30 seconds later as the worker's prompt and keeps the park", async () => {
      const w = makeWorld({ persona: true });
      await toCoding(w);
      const t0 = Date.now();
      setSystemTime(new Date(t0));
      recordPaneSend(w.sessionId, SENT);
      setSystemTime(new Date(t0 + 1000));
      personaPark(w);
      setSystemTime(new Date(t0 + 30_000));
      await hook(w, "UserPromptSubmit", { prompt: `  ${SENT}\n` });
      expect(runOf(w).parked).toBeDefined();
      // That send was taken: the same text again is a new message.
      await hook(w, "UserPromptSubmit", { prompt: SENT });
      expect(runOf(w).parked).toBeUndefined();
    });

    test("joined with the other messages sent before the park, still keeps it", async () => {
      const w = makeWorld({ persona: true });
      await toCoding(w);
      recordPaneSend(w.sessionId, SENT);
      recordPaneSend(w.sessionId, "and keep the branch name");
      setSystemTime(new Date(Date.now() + 5));
      personaPark(w);
      setSystemTime(new Date(Date.now() + 30_000));
      await hook(w, "UserPromptSubmit", { prompt: `${SENT}\nand keep the branch name` });
      expect(runOf(w).parked).toBeDefined();
    });

    test("a different, later message clears it", async () => {
      const w = makeWorld({ persona: true });
      await toCoding(w);
      recordPaneSend(w.sessionId, SENT);
      setSystemTime(new Date(Date.now() + 5));
      personaPark(w);
      await hook(w, "UserPromptSubmit", { prompt: "the schema job landed, carry on" });
      expect(runOf(w).parked).toBeUndefined();
    });

    test("a send after the park, submitted as a prompt, clears it", async () => {
      const w = makeWorld({ persona: true });
      await toCoding(w);
      personaPark(w);
      setSystemTime(new Date(Date.now() + 5));
      recordPaneSend(w.sessionId, SENT);
      await hook(w, "UserPromptSubmit", { prompt: SENT });
      expect(runOf(w).parked).toBeUndefined();
    });

    test("a worker's own park ends with the prompt of a message typed before it", async () => {
      const w = makeWorld();
      await toCoding(w);
      recordPaneSend(w.sessionId, SENT);
      setSystemTime(new Date(Date.now() + 5));
      await park(w, { reason: REASON });
      await hook(w, "UserPromptSubmit", { prompt: SENT });
      expect(runOf(w).parked).toBeUndefined();
    });

    test("a prompt with no text recorded reads as a new message", async () => {
      const w = makeWorld({ persona: true });
      await toCoding(w);
      personaPark(w);
      pipelinePromptSubmitted(w.store.db, w.sessionId, w.deps);
      expect(runOf(w).parked).toBeUndefined();
    });
  });

  test("a worker's advance clears its park, even one the server refuses", async () => {
    const w = makeWorld();
    await toCoding(w);
    await park(w, { reason: REASON });
    const refused = await advance(w, "coding");
    expect(refused.status).toBe(422);
    expect(runOf(w).parked).toBeUndefined();

    await park(w, { reason: REASON });
    const moved = await advance(w, "coding", EVIDENCE.coding);
    expect(moved.status).toBe(200);
    expect(moved.body.run.parked).toBeUndefined();
    expect(runOf(w).parked).toBeUndefined();
  });

  test("the worker's own unpark clears it, and un-parking twice is a no-op", async () => {
    const w = makeWorld();
    await toCoding(w);
    await park(w, { reason: REASON });
    const first = await unpark(w);
    expect(first).toMatchObject({ status: 200, body: { cleared: true } });
    expect(runOf(w).parked).toBeUndefined();
    expect((await hook(w, "Stop")).decision).toBe("block");
    expect(await unpark(w)).toMatchObject({ status: 200, body: { cleared: false } });
  });
});

describe("refusals", () => {
  test("a reason under 10 characters, an unknown job and another owner's job are refused", async () => {
    const w = makeWorld();
    await toCoding(w);
    expect(await park(w, { reason: "wait" })).toMatchObject({ status: 422 });
    expect(await park(w, { reason: "x".repeat(9000) })).toMatchObject({ status: 422 });
    expect(await park(w, { reason: REASON, waitingOnJobId: "no-such-job" })).toMatchObject({ status: 422 });
    const theirs = otherJob(w, "mallory");
    expect(await park(w, { reason: REASON, waitingOnJobId: theirs.id })).toMatchObject({ status: 422 });
    expect(runOf(w).parked).toBeUndefined();
  });

  test("a complete run can't be parked, and a session without a run gets 404", async () => {
    const w = makeWorld();
    w.store.db.run("UPDATE pipeline_runs SET status = 'complete', current_stage = 'complete' WHERE id = ?", [w.run.id]);
    const res = await park(w, { reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already complete");
    const none = await post(w, "/api/pipeline/park", { session_id: "nobody", cwd: "/nowhere", reason: REASON });
    expect(none.status).toBe(404);
  });
});

describe("parking and the owner's wait", () => {
  test("parking a run waiting on its owner leaves its waiting state as it was", async () => {
    const w = makeWorld();
    await toCoding(w);
    markRunWaiting(w.store.db, runOf(w), "code review stage needs an issue id — Persona asks the owner for it", "owner_input", w.deps);
    const waiting = runOf(w);
    expect(await park(w, { reason: REASON })).toMatchObject({ status: 200 });
    const after = runOf(w);
    expect(after).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", waitingReason: waiting.waitingReason, currentStage: "coding" });
    expect(after.parked).toBeDefined();
    expect(pipelineStopDecision(w.store.db, w.sessionId, w.deps)).toBeNull();
    expect(runOf(w)).toMatchObject({ status: "waiting_user", waitingKind: "owner_input", stopBlocks: 0 });
  });
});

describe("what Persona sees and records", () => {
  test("Persona's park and unpark are recorded in the owner's audit; the job summary shows the park", async () => {
    const w = makeWorld({ persona: true });
    await toCoding(w);
    const job = otherJob(w);
    const actor = `${OWNER}'s Persona`;
    const parked = personaParkDecision(w.store.db, w.run.id, { park: true, why: REASON, waitingOnJobId: job.id, actor }, w.deps);
    expect(parked.ok && parked.run.parked).toMatchObject({ by: "persona", actor, waitingOnJobId: job.id });
    expect(pipelineJobSummary(w.store.db, [w.launch.id])?.parked).toEqual({ reason: REASON, waitingOnJobId: job.id, by: "persona" });

    expect(personaParkDecision(w.store.db, w.run.id, { park: false, why: "short", actor }, w.deps)).toMatchObject({ ok: false, status: 422 });
    const unparked = personaParkDecision(w.store.db, w.run.id, { park: false, why: "the schema job landed on main", actor }, w.deps);
    expect(unparked).toMatchObject({ ok: true, cleared: true });
    expect(pipelineJobSummary(w.store.db, [w.launch.id])?.parked).toBeUndefined();
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toEqual([
      expect.objectContaining({ kind: "park", stage: "coding", reason: REASON, actor, detail: { waitingOnJobId: job.id } }),
      expect.objectContaining({ kind: "unpark", stage: "coding", reason: "the schema job landed on main", actor }),
    ]);
    // An un-park of a run that isn't parked records nothing.
    expect(personaParkDecision(w.store.db, w.run.id, { park: false, why: "the schema job landed on main", actor }, w.deps)).toMatchObject({
      ok: true,
      cleared: false,
    });
    expect(listPipelineDecisions(w.store.db, OWNER, { runId: w.run.id })).toHaveLength(2);
  });

  test("the worker's brief tells it to park instead of asking repeatedly", () => {
    const w = makeWorld();
    expect(formatPipelineInstruction(runOf(w).definition)).toContain("call `pipeline_park` {reason, waitingOnJobId?} and end your turn");
  });
});
