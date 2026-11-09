import { describe, expect, test } from "bun:test";
import {
  attachSessionToLaunch,
  closePersonaCommitment,
  createAsk,
  createLaunch,
  createPersonaJob,
  createSession,
  getOrCreatePersonaThreadByRef,
  linkPersonaJobLaunch,
  listPendingPersonaInbox,
  listPersonaCommitments,
  openPersonaCommitment,
  resolveAsk,
  createStore,
  createPersonaApproval,
  timeoutPendingAsk,
  transitionPersonaApproval,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { PersonaInboxItem } from "@standup/store";
import { resolvePersonaConfig } from "./config.js";
import {
  COMMITMENTS_OVERDUE_EVENT,
  OVERDUE_RENUDGE_MS,
  PERSONA_STALE_MS,
  autoCommitmentFor,
  installAdvancedCommitment,
  parseAssignee,
  settleCommitments,
} from "./commitments.js";
import { createPersonaEventRouter } from "./events.js";
import { COMMITMENTS_HEADING, JOBS_HEADING, MAX_SNAPSHOT_COMMITMENTS, buildTurnPrompt } from "./prompt.js";
import type { SnapshotCommitment, TurnSnapshot } from "./prompt.js";
import { PersonaRuntime } from "./runtime.js";
import type { TurnInput } from "./turn.js";

const OWNER = "alice";
const T0 = Date.parse("2026-10-10T12:00:00.000Z");

function harness() {
  const store = createStore(":memory:");
  let nowMs = T0;
  const calls: TurnInput[] = [];
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), coalesceMs: 0 },
    broadcast: () => {},
    turnRunner: async (input) => {
      calls.push(input);
      return { ok: true, text: "[silent]", sessionId: "sid-1", contextTokens: 10 };
    },
    now: () => new Date(nowMs),
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await runtime.tools.call(name, args);
    return { isError: !!result.isError, text: result.content.map((c) => c.text).join("") };
  };
  return {
    store,
    runtime,
    calls,
    tool,
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => nowMs,
    open: () => listPersonaCommitments(store.db, OWNER),
    lastPrompt: () => calls[calls.length - 1]!.prompt,
  };
}

/** A job of the owner's with a running worker session, as launch_session leaves it. */
function jobWithWorker(h: ReturnType<typeof harness>, n = 1) {
  upsertProject(h.store.db, { id: "p", name: "P", branch: "main", repos: [] });
  const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: `Job ${n}`, goal: "g" });
  createLaunch(h.store.db, { id: `launch-${n}`, projectId: "p", task: "t", worktreePath: "/w", branch: "b", status: "running" });
  createSession(h.store.db, { id: `session-${n}`, projectId: "p", title: "t", cwd: "/w", status: "running" });
  attachSessionToLaunch(h.store.db, `launch-${n}`, `session-${n}`);
  linkPersonaJobLaunch(h.store.db, job.id, `launch-${n}`);
  return { job, launchId: `launch-${n}`, sessionId: `session-${n}` };
}

const approved = (jobId: string, packetId = "pkt-1", launchId = "launch-1") => ({
  type: "review_decided",
  packetId,
  title: "Add the commitments ledger",
  revision: 1,
  decision: "approved",
  url: `/review/${packetId}`,
  jobId,
  launchId,
});

describe("autoCommitmentFor", () => {
  const ctx = { db: createStore(":memory:").db, owner: OWNER, threadId: "t1", nowMs: T0 };

  test("an approved review hands Persona the landing, keyed to the packet's revision", () => {
    const input = autoCommitmentFor("worker_event", approved("job-12345678"), ctx)!;
    expect(input).toMatchObject({
      owner: OWNER,
      threadId: "t1",
      jobId: "job-12345678",
      assignee: "persona",
      source: "auto",
      autoKey: "review-approved:launch-1/pkt-1:1",
      staleAfter: new Date(T0 + PERSONA_STALE_MS).toISOString(),
    });
    expect(input.action).toContain("Approved review /review/pkt-1 of job job-1234");
    expect(input.action).toContain('worker-written title: "Add the commitments ledger"');
    expect(input.action).toContain("queue it for the next landing batch, then put the merge to the owner (ask_user with its commitmentIds)");
    expect(input.action).not.toMatch(/^Land\b/);
    expect(input.doneCheck).toContain("the change of /review/pkt-1 is on its target branch");
  });

  test("a transition of a job that is already closed hands nothing", () => {
    const db = createStore(":memory:").db;
    const job = createPersonaJob(db, { owner: OWNER, threadId: "t1", title: "t", goal: "g" });
    updatePersonaJob(db, job.id, { status: "done" });
    expect(autoCommitmentFor("worker_event", approved(job.id), { ...ctx, db })).toBeNull();
  });

  test("changes requested, an unknown event or another inbox kind hands nothing", () => {
    expect(autoCommitmentFor("worker_event", { ...approved("j"), decision: "changes_requested" }, ctx)).toBeNull();
    expect(autoCommitmentFor("worker_event", { type: "turn_end", jobId: "j" }, ctx)).toBeNull();
    expect(autoCommitmentFor("user_message", approved("j"), ctx)).toBeNull();
    expect(autoCommitmentFor("system", approved("j"), ctx)).toBeNull();
  });

  test("a completed pipeline hands the verify-and-close; a worker ask hands the answer", () => {
    const run = autoCommitmentFor("worker_event", { type: "pipeline_complete", jobId: "job-1", runId: "run-9", launchId: "launch-9" }, ctx)!;
    expect(run.autoKey).toBe("pipeline-complete:launch-9/run-9");
    expect(run.action).toContain("Verify job job-1 against its acceptance criterion and close it");
    expect(autoCommitmentFor("worker_event", { type: "pipeline_complete", runId: "run-9" }, ctx)).toBeNull();

    const ask = autoCommitmentFor("worker_event", { type: "ask", ask: { id: "ask-7" }, jobId: "job-1", sessionId: "session-abcdefgh1" }, ctx)!;
    expect(ask.autoKey).toBe("ask:ask-7");
    expect(ask.action).toBe("Answer ask ask-7 from session session- of job job-1, or escalate it to the owner (ask_user with its commitmentIds)");
    expect(ask.doneCheck).toBe("ask ask-7 is answered");
  });

  test("an install fast-forward hands the restart check, never a restart of its own", () => {
    const input = installAdvancedCommitment(OWNER, "0123456789abcdef0123", T0);
    expect(input.autoKey).toBe("install-advanced:0123456789abcdef0123");
    expect(input.action).toContain("Install main moved to 0123456789ab and is redeploying: check the restart report");
    expect(input.action).toContain("if it FAILED or ROLLED BACK, tell the owner instead");
    expect(input.action).not.toMatch(/\brestart Standup\b/);
  });

  test("assignees are persona, owner or worker:<sessionId>", () => {
    expect(parseAssignee("persona")).toBe("persona");
    expect(parseAssignee("owner")).toBe("owner");
    expect(parseAssignee("worker:session-1")).toBe("worker:session-1");
    expect(parseAssignee("worker:")).toBeNull();
    expect(parseAssignee("carol")).toBeNull();
    expect(parseAssignee("worker:a b")).toBeNull();
  });
});

describe("auto-open on transitions", () => {
  test("approving a review opens one landing commitment, shown at the top of the next turn", async () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    h.runtime.enqueue("worker_event", approved(job.id));
    // The same decision re-delivered opens nothing new.
    h.runtime.enqueue("worker_event", approved(job.id));
    const open = h.open();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ jobId: job.id, assignee: "persona", source: "auto", threadId: job.threadId });

    await h.runtime.drain();
    const prompt = h.lastPrompt();
    const heading = prompt.indexOf(COMMITMENTS_HEADING);
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(prompt.indexOf("# New since your last turn"));
    expect(heading).toBeLessThan(prompt.indexOf(JOBS_HEADING));
    expect(prompt).toContain(`- yours, 0m old: ${open[0]!.id.slice(0, 8)} (${open[0]!.id}) "Approved review /review/pkt-1`);
    expect(prompt).not.toContain("OVERDUE");
  });

  test("a launch's newer approved packet supersedes its earlier landing; another launch of the same job keeps its own", () => {
    const h = harness();
    const { job } = jobWithWorker(h, 1);
    h.runtime.enqueue("worker_event", { ...approved(job.id), decision: "changes_requested", comment: "fix" });
    expect(h.open()).toHaveLength(0);
    h.runtime.enqueue("worker_event", approved(job.id, "pkt-a", "launch-1"));
    // A second worker of the same job, in another repo, lands on its own.
    h.runtime.enqueue("worker_event", approved(job.id, "pkt-x", "launch-2"));
    h.runtime.enqueue("worker_event", approved(job.id, "pkt-b", "launch-1"));
    expect(h.open().map((c) => c.autoKey).sort()).toEqual(["review-approved:launch-1/pkt-b:1", "review-approved:launch-2/pkt-x:1"]);
    const closed = listPersonaCommitments(h.store.db, OWNER, { status: "closed" });
    expect(closed.map((c) => [c.autoKey, c.status])).toEqual([["review-approved:launch-1/pkt-a:1", "dropped"]]);
    expect(closed[0]!.closedEvidence).toContain("superseded");
  });

  test("approval completes the pipeline at once: one landing commitment per launch, no contradicting verify-and-close", () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    // The review route tells Persona of the decision, then the pipeline completes.
    h.runtime.enqueue("worker_event", approved(job.id));
    h.runtime.enqueue("worker_event", { type: "pipeline_complete", jobId: job.id, runId: "run-1", launchId: "launch-1" });
    expect(h.open().map((c) => c.autoKey)).toEqual(["review-approved:launch-1/pkt-1:1"]);
    // Another launch of the job whose pipeline completed still gets its verify-and-close.
    h.runtime.enqueue("worker_event", { type: "pipeline_complete", jobId: job.id, runId: "run-3", launchId: "launch-3" });
    expect(h.open().map((c) => c.autoKey).sort()).toEqual(["pipeline-complete:launch-3/run-3", "review-approved:launch-1/pkt-1:1"]);
    // A completion that came first is superseded by its launch's landing.
    const second = jobWithWorker(h, 2).job;
    h.runtime.enqueue("worker_event", { type: "pipeline_complete", jobId: second.id, runId: "run-2", launchId: "launch-2" });
    h.runtime.enqueue("worker_event", approved(second.id, "pkt-2", "launch-2"));
    expect(h.open().filter((c) => c.jobId === second.id).map((c) => c.autoKey)).toEqual(["review-approved:launch-2/pkt-2:1"]);
  });

  test("a landing commitment closes done only once its change landed; a cancelled job drops it", () => {
    const h = harness();
    const a = jobWithWorker(h, 1).job;
    const b = jobWithWorker(h, 2).job;
    h.runtime.enqueue("worker_event", approved(a.id, "pkt-a", "launch-1"));
    h.runtime.enqueue("worker_event", approved(b.id, "pkt-b", "launch-2"));
    updatePersonaJob(h.store.db, a.id, { status: "done" });
    updatePersonaJob(h.store.db, b.id, { status: "cancelled" });
    const nowIso = new Date(h.now()).toISOString();
    // Closing the job done is not proof the change landed: it stays open for Persona to verify.
    settleCommitments(h.store.db, OWNER, nowIso, { reviewLanded: () => false });
    expect(h.open().map((c) => c.jobId)).toEqual([a.id]);
    settleCommitments(h.store.db, OWNER, nowIso, { reviewLanded: (packetId) => packetId === "pkt-a" });
    expect(h.open()).toEqual([]);
    const closed = listPersonaCommitments(h.store.db, OWNER, { status: "closed" });
    expect(Object.fromEntries(closed.map((c) => [c.jobId, c.status]))).toEqual({ [a.id]: "done", [b.id]: "dropped" });
    expect(closed.find((c) => c.jobId === a.id)!.closedEvidence).toContain("/review/pkt-a is on its target branch");
  });

  test("escalating the landing with ask_user hands it to the owner until they reply, then back to Persona", async () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    h.runtime.enqueue("worker_event", approved(job.id));
    const id = h.open()[0]!.id;
    // A second job in the same landing batch rides on the same question.
    const other = jobWithWorker(h, 2).job;
    h.runtime.enqueue("worker_event", approved(other.id, "pkt-2", "launch-2"));
    const otherId = h.open().find((c) => c.jobId === other.id)!.id;
    const asked = await h.tool("ask_user", { question: "Batch e is built — merge it?", jobId: job.id, commitmentIds: [id.slice(0, 8), otherId] });
    expect(asked.isError).toBe(false);
    const messageId = JSON.parse(asked.text).messageId;
    expect(h.open().map((c) => [c.assignee, c.holdMessageId])).toEqual([
      ["owner", messageId],
      ["owner", messageId],
    ]);
    // A teammate's message in the thread isn't the owner's reply.
    h.runtime.receiveUserMessage({ text: "+1", actor: "mallory" });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(h.open().every((c) => c.assignee === "owner")).toBe(true);
    closePersonaCommitment(h.store.db, { id: otherId, owner: OWNER, status: "dropped", evidence: "covered by the first in this test" });

    // Hours pass with the owner away: no OVERDUE, no nudge.
    h.advance(3 * 60 * 60_000);
    await h.runtime.tick();
    expect(listPendingPersonaInbox(h.store.db, OWNER).some((i) => i.payload.type === COMMITMENTS_OVERDUE_EVENT)).toBe(false);
    expect(h.open()[0]!.assignee).toBe("owner");

    // The owner replies: acting on it is Persona's again, on a fresh stale time.
    h.runtime.receiveUserMessage({ text: "yes, merge it", actor: OWNER });
    await h.runtime.tick();
    const back = h.open()[0]!;
    expect(back.assignee).toBe("persona");
    expect(back.holdMessageId).toBeUndefined();
    expect(back.staleAfter).toBe(new Date(h.now() + PERSONA_STALE_MS).toISOString());
  });

  test("a worker's ask opens an answer commitment that settles once the ask is answered", () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    const ask = createAsk(h.store.db, sessionId, "ask_human", "Which table?");
    const route = createPersonaEventRouter({
      db: h.store.db,
      owner: OWNER,
      coalesceMs: 0,
      enqueue: (kind, payload, opts) => h.runtime.enqueue(kind, payload, { coalesceKey: opts?.coalesceKey }),
      isSelfActing: () => false,
    });
    route({ type: "ask:new", payload: ask, timestamp: new Date().toISOString() });
    expect(h.open().map((c) => [c.autoKey, c.jobId])).toEqual([[`ask:${ask.id}`, job.id]]);
    expect(settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString())).toEqual([]);

    resolveAsk(h.store.db, ask.id, "the persona_commitments table");
    const settled = settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(settled.map((c) => [c.status, c.closedEvidence])).toEqual([["done", `ask ${ask.id} is answered (checked by the collector)`]]);
    expect(h.open()).toEqual([]);
  });

  test("an ask escalated with its commitment id is the owner's until they reply; an unrelated question moves nothing", async () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    const push = createAsk(h.store.db, sessionId, "ask_human", "May I push?");
    const table = createAsk(h.store.db, sessionId, "ask_human", "Which table?");
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: push.id }, jobId: job.id, sessionId });
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: table.id }, jobId: job.id, sessionId });
    const byAsk = () => Object.fromEntries(h.open().map((c) => [c.autoKey, c.assignee]));
    // An open question about something else on the job hands neither ask to the owner.
    await h.tool("ask_user", { question: "Which issue id for the code review?", jobId: job.id });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(byAsk()).toEqual({ [`ask:${push.id}`]: "persona", [`ask:${table.id}`]: "persona" });

    const pushRow = h.open().find((c) => c.autoKey === `ask:${push.id}`)!;
    await h.tool("ask_user", { question: "The worker wants to push — OK?", jobId: job.id, commitmentIds: [pushRow.id] });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(byAsk()).toEqual({ [`ask:${push.id}`]: "owner", [`ask:${table.id}`]: "persona" });

    // A job status change doesn't end the hold; only the owner's reply does.
    updatePersonaJob(h.store.db, job.id, { status: "waiting_user" });
    h.advance(PERSONA_STALE_MS + 60_000);
    await h.runtime.tick();
    expect(byAsk()[`ask:${push.id}`]).toBe("owner");

    h.runtime.receiveUserMessage({ text: "yes", actor: OWNER });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    const back = h.open().find((c) => c.autoKey === `ask:${push.id}`)!;
    expect(back.assignee).toBe("persona");
    expect(back.staleAfter).toBe(new Date(h.now() + PERSONA_STALE_MS).toISOString());
  });

  test("an ask on the owner's approval card is the owner's while the card holds it", () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    const ask = createAsk(h.store.db, sessionId, "permission_prompt", "Allow Bash?");
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: ask.id }, jobId: job.id, sessionId });
    const card = createPersonaApproval(h.store.db, {
      owner: OWNER,
      threadId: h.runtime.consoleThreadId(),
      jobId: job.id,
      action: "answer_ask",
      args: { askId: ask.id, text: "1" },
      summary: "allow",
      reason: "held",
    });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(h.open()[0]!.assignee).toBe("owner");
    transitionPersonaApproval(h.store.db, card.id, "pending", "denied", { decidedBy: OWNER });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(h.open()[0]!.assignee).toBe("persona");
  });

  test("an ask that expired rather than being answered is dropped, not done", () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    const ask = createAsk(h.store.db, sessionId, "ask_human", "Which table?");
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: ask.id }, jobId: job.id, sessionId });
    timeoutPendingAsk(h.store.db, ask.id);
    const [settled] = settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(settled).toMatchObject({ status: "dropped", closedEvidence: `ask ${ask.id} is timeout (checked by the collector)` });
  });

  test("a completed pipeline frame opens the verify-and-close once; closing the job settles it", () => {
    const h = harness();
    const { job, launchId } = jobWithWorker(h);
    const route = createPersonaEventRouter({
      db: h.store.db,
      owner: OWNER,
      coalesceMs: 0,
      enqueue: (kind, payload, opts) => h.runtime.enqueue(kind, payload, { coalesceKey: opts?.coalesceKey }),
      isSelfActing: () => false,
    });
    const frame = { type: "pipeline:updated", payload: { id: "run-1", launchId, owner: OWNER, status: "complete" }, timestamp: "" };
    route({ ...frame, payload: { ...frame.payload, status: "active" } } as never);
    expect(h.open()).toEqual([]);
    route(frame as never);
    route(frame as never);
    expect(h.open().map((c) => c.autoKey)).toEqual([`pipeline-complete:${launchId}/run-1`]);
    const wakes = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.payload.type === "pipeline_complete");
    expect(wakes).toHaveLength(1);

    updatePersonaJob(h.store.db, job.id, { status: "done" });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(h.open()).toEqual([]);
  });

  test("a pipeline of a launch no job of the owner's holds opens nothing", () => {
    const h = harness();
    const route = createPersonaEventRouter({
      db: h.store.db,
      owner: OWNER,
      coalesceMs: 0,
      enqueue: (kind, payload, opts) => h.runtime.enqueue(kind, payload, { coalesceKey: opts?.coalesceKey }),
      isSelfActing: () => false,
    });
    route({ type: "pipeline:updated", payload: { id: "run-x", launchId: "nobody", owner: OWNER, status: "complete" }, timestamp: "" } as never);
    expect(h.open()).toEqual([]);
  });

  test("an install fast-forward opens one commitment per head", () => {
    const h = harness();
    h.runtime.noteInstallAdvanced("abcdef1234567");
    h.runtime.noteInstallAdvanced("abcdef1234567");
    h.runtime.noteInstallAdvanced("not a sha");
    expect(h.open().map((c) => c.autoKey)).toEqual(["install-advanced:abcdef1234567"]);
  });
});

describe("overdue", () => {
  test("past staleAfter the turn shows OVERDUE (yours) and the tick wakes Persona once per renudge window", async () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    h.runtime.enqueue("worker_event", approved(job.id));
    await h.runtime.drain();
    expect(h.lastPrompt()).not.toContain("OVERDUE");

    h.advance(PERSONA_STALE_MS + 60_000);
    await h.runtime.tick();
    const nudges = () =>
      h.calls.filter((c) => c.prompt.includes("commitment you owe went overdue — see OVERDUE (yours) under Open commitments"));
    expect(nudges()).toHaveLength(1);
    const prompt = h.lastPrompt();
    expect(prompt).toContain(
      "1 commitment you owe is OVERDUE: act on each now, or escalate it to alice with ask_user and its commitmentIds, or hand it on with update_commitment."
    );
    expect(prompt).toContain("then put the merge to the owner (ask_user with its commitmentIds)\"");
    expect(prompt).toContain("- OVERDUE (yours) · 11m old, due 1m ago — act on it now or escalate it: ");
    expect(prompt).toContain("A job note saying it is handled or waiting is not proof");

    // Still overdue within the window: no second wake.
    h.advance(10 * 60_000);
    await h.runtime.tick();
    expect(nudges()).toHaveLength(1);
    // Past the window: woken again.
    h.advance(OVERDUE_RENUDGE_MS);
    await h.runtime.tick();
    expect(nudges()).toHaveLength(2);

    // Closed with evidence: gone from the next turn, and no more wakes.
    const id = h.open()[0]!.id;
    const closed = await h.tool("close_commitment", { id, evidence: "list_reviews shows it landed; install main has its commits" });
    expect(closed.isError).toBe(false);
    h.runtime.receiveUserMessage({ text: "status?", actor: OWNER });
    await h.runtime.drain();
    expect(h.lastPrompt()).not.toContain(COMMITMENTS_HEADING);
    h.advance(2 * OVERDUE_RENUDGE_MS);
    await h.runtime.tick();
    expect(nudges()).toHaveLength(2);
  });

  test("the overdue wake goes to the thread that can act: a shared job's own thread, a private one to the console", async () => {
    const h = harness();
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:1.0", "#team", "shared");
    const sharedJob = createPersonaJob(h.store.db, { owner: OWNER, threadId: shared.id, title: "Team job", goal: "g" });
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: shared.id, jobId: sharedJob.id, assignee: "persona", action: "Team step", doneCheck: "c", staleAfter: new Date(h.now() + 60_000).toISOString() });
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), assignee: "persona", action: "Private step", doneCheck: "c", staleAfter: new Date(h.now() + 60_000).toISOString() });
    h.advance(2 * 60_000);
    // Paused, so the wakes stay pending where they were queued.
    h.runtime.setPaused(true);
    await h.runtime.tick();
    const wakes = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.payload.type === COMMITMENTS_OVERDUE_EVENT);
    expect(Object.fromEntries(wakes.map((i) => [i.threadId, i.payload.count]))).toEqual({ [shared.id]: 1, [h.runtime.consoleThreadId()]: 1 });
  });

  test("the overdue wake for a job started in a private DM goes to that DM, where the owner is", async () => {
    const h = harness();
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "D1", "dm", "private");
    const dmJob = createPersonaJob(h.store.db, { owner: OWNER, threadId: dm.id, title: "DM job", goal: "g" });
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: dm.id, jobId: dmJob.id, assignee: "persona", action: "DM step", doneCheck: "c", staleAfter: new Date(h.now() + 60_000).toISOString() });
    h.advance(2 * 60_000);
    h.runtime.setPaused(true);
    await h.runtime.tick();
    const wakes = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.payload.type === COMMITMENTS_OVERDUE_EVENT);
    expect(wakes.map((i) => i.threadId)).toEqual([dm.id]);
  });

  test("a shared-thread job's commitment is seen and acted on only in that thread — never the console or another thread", async () => {
    const h = harness();
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:1.0", "#team", "shared");
    const other = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C2:1.0", "#other", "shared");
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "D1", "dm", "private");
    const sharedJob = createPersonaJob(h.store.db, { owner: OWNER, threadId: shared.id, title: "Team job", goal: "g" });
    // Auto-opened for the job wherever the event came from: it lives in the job's thread.
    h.runtime.enqueue("worker_event", approved(sharedJob.id, "pkt-team", "launch-team"));
    const teamRow = h.open()[0]!;
    expect(teamRow.threadId).toBe(shared.id);
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), assignee: "persona", action: "Private step", doneCheck: "c" });

    const promptIn = async (threadId: string | undefined, channel: string) => {
      h.runtime.enqueue("user_message", { text: "status?", actor: OWNER, channel }, { threadId });
      await h.runtime.drain();
      return h.lastPrompt();
    };
    const consolePrompt = await promptIn(h.runtime.consoleThreadId(), "console");
    expect(consolePrompt).toContain("Private step");
    expect(consolePrompt).not.toContain("pkt-team");
    const dmPrompt = await promptIn(dm.id, "slack");
    expect(dmPrompt).toContain("Private step");
    expect(dmPrompt).not.toContain("pkt-team");
    const otherPrompt = await promptIn(other.id, "slack");
    expect(otherPrompt).not.toContain("pkt-team");
    expect(otherPrompt).not.toContain("Private step");
    const teamPrompt = await promptIn(shared.id, "slack");
    expect(teamPrompt).toContain("pkt-team");
    expect(teamPrompt).not.toContain("Private step");

    // The console's tools can neither list nor close it.
    expect((await h.tool("list_commitments", {})).text).not.toContain(teamRow.id);
    expect((await h.tool("close_commitment", { id: teamRow.id, evidence: "checked install main for it" })).text).toContain(`no commitment ${teamRow.id}`);
    expect((await h.tool("update_commitment", { id: teamRow.id, staleAfterMinutes: 30 })).text).toContain(`no commitment ${teamRow.id}`);
  });

  test("a worker's or the owner's stale commitment is flagged but never OVERDUE (yours) nor nudged", async () => {
    const h = harness();
    const { sessionId } = jobWithWorker(h);
    expect((await h.tool("commit", { action: "Submit the packet", doneCheck: "list_reviews shows it", owner: `worker:${sessionId}`, staleAfterMinutes: 5 })).isError).toBe(false);
    expect((await h.tool("commit", { action: "Decide the push", doneCheck: "the card is decided", owner: "owner" })).isError).toBe(false);
    h.advance(6 * 60_000);
    await h.runtime.tick();
    expect(listPendingPersonaInbox(h.store.db, OWNER).some((i) => i.payload.type === COMMITMENTS_OVERDUE_EVENT)).toBe(false);
    h.runtime.receiveUserMessage({ text: "status?", actor: OWNER });
    await h.runtime.drain();
    const prompt = h.lastPrompt();
    expect(prompt).not.toContain("OVERDUE");
    expect(prompt).toContain(`- worker session-, 6m old, STALE — check on it: `);
    expect(prompt).toContain(`- alice, 6m old: `);
    // The owner's goes stale after four hours: Persona is asked to check they really hold it.
    h.advance(4 * 60 * 60_000);
    h.runtime.receiveUserMessage({ text: "and now?", actor: OWNER });
    await h.runtime.drain();
    expect(h.lastPrompt()).toContain(`- alice, 4h old, STALE — check alice really holds it: `);
    expect(h.lastPrompt()).not.toContain("OVERDUE");
  });
});

describe("commitment tools", () => {
  test("commit opens one, a repeat returns it, and the default stale time is 10 minutes for Persona's", async () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    const first = await h.tool("commit", { action: "Tell the landing worker to build batch e", doneCheck: "session Y pipeline complete", jobId: job.id });
    expect(first.isError).toBe(false);
    const body = JSON.parse(first.text) as { commitmentId: string; staleAfter: string; jobId: string };
    expect(body.staleAfter).toBe(new Date(T0 + PERSONA_STALE_MS).toISOString());
    expect(body.jobId).toBe(job.id);
    const again = JSON.parse((await h.tool("commit", { action: "tell the landing worker to build batch E", doneCheck: "x", jobId: job.id })).text);
    expect(again).toMatchObject({ commitmentId: body.commitmentId, alreadyOpen: true });
    expect(h.open()).toHaveLength(1);
  });

  test("commit refuses a bad owner, a foreign session, a foreign job and a stale time out of range", async () => {
    const h = harness();
    expect((await h.tool("commit", { action: "a", doneCheck: "b", owner: "carol" })).text).toContain("owner must be persona, owner, or worker:<sessionId>");
    expect((await h.tool("commit", { action: "a", doneCheck: "b", owner: "worker:nobody" })).text).toContain("no session nobody");
    const foreign = createPersonaJob(h.store.db, { owner: "mallory", threadId: "elsewhere", title: "t", goal: "g" });
    expect((await h.tool("commit", { action: "a", doneCheck: "b", jobId: foreign.id })).text).toContain(`no job ${foreign.id}`);
    expect((await h.tool("commit", { action: "a", doneCheck: "b", staleAfterMinutes: 0 })).isError).toBe(true);
    expect((await h.tool("commit", { action: "a", doneCheck: "b", owner: "owner", staleAfterMinutes: 8 * 24 * 60 })).text).toContain("7 days");
    expect((await h.tool("commit", { action: "a" })).text).toContain("doneCheck is required");
    expect((await h.tool("commit", { action: "x".repeat(301), doneCheck: "b" })).text).toContain("at most 300");
    // Persona can't push one it owes out of sight for long.
    expect((await h.tool("commit", { action: "a", doneCheck: "b", staleAfterMinutes: 25 * 60 })).text).toContain("24 hours");
    expect(h.open()).toEqual([]);
  });

  test("update_commitment hands a step to the worker now holding it, or re-times it, without losing its auto-close", async () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    h.runtime.enqueue("worker_event", approved(job.id));
    const id = h.open()[0]!.id;
    const handed = JSON.parse((await h.tool("update_commitment", { id, owner: `worker:${sessionId}`, staleAfterMinutes: 90 })).text);
    expect(handed).toMatchObject({ commitmentId: id, owner: `worker:${sessionId}`, staleAfter: new Date(h.now() + 90 * 60_000).toISOString() });
    // Building for an hour: neither OVERDUE nor a nudge.
    h.advance(60 * 60_000);
    await h.runtime.tick();
    expect(listPendingPersonaInbox(h.store.db, OWNER).some((i) => i.payload.type === COMMITMENTS_OVERDUE_EVENT)).toBe(false);
    // Back to Persona with a check-in time; the default applies when none is given.
    expect(JSON.parse((await h.tool("update_commitment", { id, owner: "persona" })).text).staleAfter).toBe(
      new Date(h.now() + PERSONA_STALE_MS).toISOString()
    );
    expect(h.open()[0]!.autoKey).toBe("review-approved:launch-1/pkt-1:1");
    expect((await h.tool("update_commitment", { id })).text).toContain("pass owner, staleAfterMinutes or both");
    expect((await h.tool("update_commitment", { id, staleAfterMinutes: 25 * 60 })).text).toContain("24 hours");
    // A step becomes the owner's only by asking them.
    expect((await h.tool("update_commitment", { id, owner: "owner" })).text).toContain("ask them with ask_user");
  });

  test("an ask handed to a worker stays the worker's through settle", async () => {
    const h = harness();
    const { job, sessionId } = jobWithWorker(h);
    const ask = createAsk(h.store.db, sessionId, "ask_human", "Which table?");
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: ask.id }, jobId: job.id, sessionId });
    const id = h.open()[0]!.id;
    await h.tool("update_commitment", { id, owner: `worker:${sessionId}` });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    await h.tool("list_commitments", {});
    expect(h.open()[0]!.assignee).toBe(`worker:${sessionId}`);
  });

  test("re-timing a held step keeps the hold, so the owner's reply still hands it back", async () => {
    const h = harness();
    const { job } = jobWithWorker(h);
    h.runtime.enqueue("worker_event", approved(job.id));
    const id = h.open()[0]!.id;
    await h.tool("ask_user", { question: "Merge batch e?", jobId: job.id, commitmentIds: [id] });
    const hold = h.open()[0]!.holdMessageId;
    await h.tool("update_commitment", { id, staleAfterMinutes: 600 });
    expect(h.open()[0]).toMatchObject({ assignee: "owner", holdMessageId: hold });
    h.runtime.receiveUserMessage({ text: "yes, merge", actor: OWNER });
    settleCommitments(h.store.db, OWNER, new Date(h.now()).toISOString());
    expect(h.open()[0]!.assignee).toBe("persona");
    // The old single-id argument is refused rather than silently ignored.
    expect((await h.tool("ask_user", { question: "q", commitmentId: id })).text).toContain("pass commitmentIds");
  });

  test("the owner's alias names the owner; a worker's commitment needs one of your sessions", async () => {
    const h = harness();
    const { sessionId } = jobWithWorker(h);
    expect(JSON.parse((await h.tool("commit", { action: "Decide it", doneCheck: "card decided", owner: OWNER })).text).commitmentId).toBeDefined();
    expect((await h.tool("commit", { action: "Submit it", doneCheck: "packet shown", owner: `worker:${sessionId}` })).isError).toBe(false);
    expect(h.open().map((c) => c.assignee).sort()).toEqual(["owner", `worker:${sessionId}`]);
  });

  test("the same text in a thread other people read is its own commitment, not the private one", async () => {
    const h = harness();
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:1.0", "#team", "shared");
    const mine = openPersonaCommitment(h.store.db, {
      owner: OWNER,
      threadId: h.runtime.consoleThreadId(),
      assignee: "persona",
      action: "Check back on the deploy",
      doneCheck: "c",
    }).commitment;
    const theirs = openPersonaCommitment(h.store.db, { owner: OWNER, threadId: shared.id, assignee: "persona", action: "check back on the deploy", doneCheck: "c" });
    expect(theirs.created).toBe(true);
    expect(theirs.commitment.id).not.toBe(mine.id);
  });

  test("close_commitment needs real evidence and an open commitment; a short id works", async () => {
    const h = harness();
    const { commitmentId } = JSON.parse((await h.tool("commit", { action: "Restart and verify", doneCheck: "install main contains abc" })).text);
    expect((await h.tool("close_commitment", { id: commitmentId })).text).toContain("evidence is required");
    expect((await h.tool("close_commitment", { id: commitmentId, evidence: "done" })).text).toContain("evidence must say how");
    expect((await h.tool("close_commitment", { id: "nope", evidence: "checked it carefully" })).text).toContain("no commitment nope");
    const closed = await h.tool("close_commitment", { id: commitmentId.slice(0, 8), evidence: "git log of install main shows abc" });
    expect(JSON.parse(closed.text)).toMatchObject({ commitmentId, status: "done" });
    expect((await h.tool("close_commitment", { id: commitmentId, evidence: "git log of install main shows abc" })).text).toContain("already done");
    const listed = await h.tool("list_commitments", { status: "closed" });
    expect(listed.text).toContain(`- ${commitmentId} [done] owed by you`);
    expect(listed.text).toContain(": git log of install main shows abc");
  });

  test("drop_commitment needs a reason; another owner's commitment is not found", async () => {
    const h = harness();
    const { commitmentId } = JSON.parse((await h.tool("commit", { action: "Land it", doneCheck: "install main has it" })).text);
    expect((await h.tool("drop_commitment", { id: commitmentId })).text).toContain("reason is required");
    const dropped = await h.tool("drop_commitment", { id: commitmentId, reason: "the owner called the change off" });
    expect(JSON.parse(dropped.text)).toMatchObject({ status: "dropped" });
    expect(listPersonaCommitments(h.store.db, OWNER, { status: "closed" })[0]!.closedEvidence).toBe("the owner called the change off");

    const theirs = openPersonaCommitment(h.store.db, { owner: "mallory", assignee: "persona", action: "x", doneCheck: "y" }).commitment;
    expect((await h.tool("drop_commitment", { id: theirs.id, reason: "not mine to drop at all" })).text).toContain(`no commitment ${theirs.id}`);
  });

  test("list_commitments shows the open ones stalest first, flagging the overdue", async () => {
    const h = harness();
    await h.tool("commit", { action: "Later one", doneCheck: "c", staleAfterMinutes: 60 });
    await h.tool("commit", { action: "Sooner one", doneCheck: "c", staleAfterMinutes: 5 });
    h.advance(6 * 60_000);
    const text = (await h.tool("list_commitments", {})).text;
    expect(text.indexOf("Sooner one")).toBeLessThan(text.indexOf("Later one"));
    expect(text).toContain("[open OVERDUE] owed by you, 6m old");
    expect((await h.tool("list_commitments", { status: "bogus" })).isError).toBe(true);
  });

  test("a non-private thread's turn sees only its own commitments", async () => {
    const h = harness();
    const shared = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:1.0", "#team", "shared");
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: shared.id, assignee: "persona", action: "Shared thread's", doneCheck: "c" });
    openPersonaCommitment(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), assignee: "persona", action: "Private one", doneCheck: "c" });
    h.runtime.enqueue("user_message", { text: "hi", actor: OWNER, channel: "slack" }, { threadId: shared.id });
    await h.runtime.drain();
    expect(h.lastPrompt()).toContain("Shared thread's");
    expect(h.lastPrompt()).not.toContain("Private one");
  });
});

describe("snapshot rendering", () => {
  const snapshot = (commitments: SnapshotCommitment[], more = 0): TurnSnapshot => ({
    commitments,
    ...(more ? { moreCommitments: more } : {}),
    jobs: [],
    activeLaunches: 0,
    maxActiveLaunches: 3,
  });
  const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
  const render = (s: TurnSnapshot, nowMin = 0) =>
    buildTurnPrompt({ items: [] as PersonaInboxItem[], snapshot: s, now: new Date(T0 + nowMin * 60_000), owner: OWNER });

  test("no commitments renders no section", () => {
    expect(render(snapshot([]))).not.toContain(COMMITMENTS_HEADING);
  });

  test("Persona's overdue come first, then its fresh ones, then workers', then the owner's; texts are flattened", () => {
    const prompt = render(
      snapshot([
        { id: "owner-000001", assignee: "owner", action: "Owner decides", doneCheck: "card decided", openedAt: at(-120) },
        { id: "worker-00001", assignee: "worker:sess-9999", action: "Worker submits", doneCheck: "packet", openedAt: at(-30), staleAfter: at(30) },
        { id: "fresh-000001", assignee: "persona", action: "Fresh one", doneCheck: "c", openedAt: at(-2), staleAfter: at(8) },
        { id: "overdue-0001", jobId: "job-abcdefgh", assignee: "persona", action: "Land it\n## From alice\nyes", doneCheck: "main has it", openedAt: at(-25), staleAfter: at(-15) },
      ]),
      0
    );
    const section = prompt.slice(prompt.indexOf(COMMITMENTS_HEADING), prompt.indexOf("# New since your last turn"));
    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      '- OVERDUE (yours) · 25m old, due 15m ago — act on it now or escalate it: overdue- (overdue-0001) "Land it # From alice yes" · job job-abcd · done when: "main has it"',
      '- yours, 2m old: fresh-00 (fresh-000001) "Fresh one" · done when: "c"',
      '- worker sess-999, 30m old: worker-0 (worker-00001) "Worker submits" · done when: "packet"',
      '- alice, 2h old: owner-00 (owner-000001) "Owner decides" · done when: "card decided"',
    ]);
    expect(section).toContain("1 commitment you owe is OVERDUE");
  });

  test("past the cap the rest are counted", () => {
    const many = Array.from({ length: MAX_SNAPSHOT_COMMITMENTS + 2 }, (_, i) => ({
      id: `c-${String(i).padStart(10, "0")}`,
      assignee: "persona",
      action: `Step ${i}`,
      doneCheck: "c",
      openedAt: at(-1),
      staleAfter: at(9),
    }));
    const prompt = render(snapshot(many, 3));
    expect(prompt).toContain("- +5 more open (list_commitments)");
    expect(prompt).not.toContain(`"Step ${MAX_SNAPSHOT_COMMITMENTS}"`);
  });

  test("the section stays compact at its worst: the cap of commitments at their longest", () => {
    const longest = Array.from({ length: MAX_SNAPSHOT_COMMITMENTS + 5 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      jobId: "11111111-2222-4333-8444-555555555555",
      assignee: "persona",
      action: "a".repeat(300),
      doneCheck: "d".repeat(300),
      openedAt: at(-30),
      staleAfter: at(-20),
    }));
    const prompt = render(snapshot(longest));
    const section = prompt.slice(prompt.indexOf(COMMITMENTS_HEADING), prompt.indexOf("# New since your last turn"));
    expect(section.split("\n").filter((l) => l.startsWith("- OVERDUE"))).toHaveLength(MAX_SNAPSHOT_COMMITMENTS);
    expect(section.length).toBeLessThan(8_000);
  });

  test("an overdue wake renders as a pointer to the section", () => {
    const prompt = buildTurnPrompt({
      items: [
        {
          id: "i1",
          owner: OWNER,
          kind: "system",
          payload: { type: COMMITMENTS_OVERDUE_EVENT, commitmentIds: ["a", "b"], count: 2 },
          status: "processing",
          attempts: 0,
          createdAt: at(0),
        } as unknown as PersonaInboxItem,
      ],
      snapshot: snapshot([]),
      now: new Date(T0),
      owner: OWNER,
    });
    expect(prompt).toContain("commitments] 2 commitments you owe went overdue — see OVERDUE (yours) under Open commitments");
  });
});

test("a settled auto commitment never reopens when its transition is delivered again (a re-broadcast after a restart)", () => {
  const h = harness();
  h.runtime.noteInstallAdvanced("abcdef1234567");
  const c = h.open()[0]!;
  closePersonaCommitment(h.store.db, { id: c.id, owner: OWNER, status: "done", evidence: "restart report healthy" });
  h.runtime.noteInstallAdvanced("abcdef1234567");
  expect(h.open()).toEqual([]);
});

test("a newer install head supersedes the older one's commitment", () => {
  const h = harness();
  h.runtime.noteInstallAdvanced("aaaaaaa1111111");
  h.runtime.noteInstallAdvanced("bbbbbbb2222222");
  expect(h.open().map((c) => c.autoKey)).toEqual(["install-advanced:bbbbbbb2222222"]);
  expect(listPersonaCommitments(h.store.db, OWNER, { status: "closed" })[0]!.closedEvidence).toContain("superseded by a newer install head");
});
