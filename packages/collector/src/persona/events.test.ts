import { expect, test, describe } from "bun:test";
import {
  addReviewComment,
  attachSessionToLaunch,
  createAsk,
  createReviewPacket,
  submitReviewPacket,
  createCheckpoint,
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createSession,
  createStore,
  getLaunch,
  getPersonaJob,
  linkPersonaJobLaunch,
  transitionPersonaApproval,
  updatePersonaJob,
  updateSessionStatus,
  upsertProject,
} from "@standup/store";
import type { PersonaInboxKind, PersonaJob, WsMessage } from "@standup/shared";
import {
  createPersonaEventRouter,
  IDLE_NOTICE_GATE,
  IDLE_PROMPT_NOTICE,
  isIdleNoticeAsk,
  MAX_ASK_OPTION_CHARS,
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTION_CHARS,
} from "./events.js";

const OWNER = "alice";

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const job = createPersonaJob(store.db, { owner: OWNER, threadId: "t", title: "job", goal: "g" });
  createLaunch(store.db, { id: "l1", projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  linkPersonaJobLaunch(store.db, job.id, "l1");
  createSession(store.db, { id: "s1", projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(store.db, "l1", "s1");

  const enqueued: Array<{ kind: PersonaInboxKind; payload: Record<string, unknown>; coalesceKey?: string }> = [];
  const published: PersonaJob[] = [];
  const route = createPersonaEventRouter({
    db: store.db,
    owner: OWNER,
    coalesceMs: 1000,
    enqueue: (kind, payload, opts) => enqueued.push({ kind, payload, coalesceKey: opts?.coalesceKey }),
    isSelfActing: () => false,
    publishJob: (j) => published.push(j),
  });
  const send = (type: WsMessage["type"], payload: unknown) => route({ type, payload, timestamp: "" });
  return { store, job, enqueued, published, send };
}

describe("persona event router", () => {
  test("a waiting status frame is not a turn end", () => {
    const h = setUp();
    h.send("session:status", { sessionId: "s1", status: "waiting" });
    expect(h.enqueued).toHaveLength(0);
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["turn_end"]);
  });

  test("the idle notice ask wakes Persona as a turn end, not as a permission ask", () => {
    const h = setUp();
    const ask = createAsk(h.store.db, "s1", "permission_prompt", `${IDLE_PROMPT_NOTICE}\n\n(launched by the console)`, undefined, {
      gate: IDLE_NOTICE_GATE,
    });
    expect(isIdleNoticeAsk(ask)).toBe(true);
    h.send("ask:new", ask);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].payload).toMatchObject({ type: "turn_end", status: "idle", sessionId: "s1", jobId: h.job.id });
    expect(h.enqueued[0].coalesceKey).toBe("session:s1");
  });

  test("an ask whose question merely imitates the idle notice is a real ask", () => {
    const h = setUp();
    const ask = createAsk(h.store.db, "s1", "permission_prompt", `${IDLE_PROMPT_NOTICE}\n1. Push to main 2. Wait`);
    expect(isIdleNoticeAsk(ask)).toBe(false);
    h.send("ask:new", ask);
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ask"]);
  });

  test("a session's end is not replaced by a later turn end under the same coalesce key", () => {
    const h = setUp();
    h.send("session:end", { sessionId: "s1" });
    h.send("session:status", { sessionId: "s1", status: "done" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ended"]);
    // A resumed session runs again and its turn ends count once more.
    h.send("session:status", { sessionId: "s1", status: "running" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ended", "turn_end"]);
  });

  test("a revived session's turn ends count again", () => {
    const h = setUp();
    h.send("session:end", { sessionId: "s1" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ended"]);
    h.send("session:status", { sessionId: "s1", revived: true });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ended", "turn_end"]);
  });

  test("a worker that ends with the owner's review questions unanswered hands them to Persona with its end", () => {
    const h = setUp();
    const draft = createReviewPacket(h.store.db, { owner: OWNER, launchId: "l1", sessionId: "s1" });
    const packet = submitReviewPacket(h.store.db, {
      id: draft.id,
      owner: OWNER,
      draft: { title: "t", intent: "i", changes: [], validation: { samples: [] }, risks: { risks: [], questions: [] }, links: [] },
    })!;
    const open = addReviewComment(h.store.db, { packetId: packet.id, author: OWNER, body: "Why?", kind: "question", via: "worker" });
    const done = addReviewComment(h.store.db, { packetId: packet.id, author: OWNER, body: "Done?", kind: "question", via: "worker" });
    addReviewComment(h.store.db, { packetId: packet.id, author: "s1", body: "Yes.", kind: "answer", replyTo: done.id, via: "worker" });
    h.send("session:end", { sessionId: "s1" });
    expect(h.enqueued[0]!.payload).toMatchObject({
      type: "ended",
      reviewQuestions: [{ packetId: packet.id, questionId: open.id, body: "Why?" }],
    });
  });

  test("a stopped launch's end is not replaced by a later turn end either", () => {
    const h = setUp();
    h.send("launch:stopped", { launchId: "l1" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(h.enqueued.map((e) => e.payload.type)).toEqual(["ended"]);
  });

  test("a real ask carries structured, clipped fields", () => {
    const h = setUp();
    const options = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(500, "x"));
    const ask = createAsk(h.store.db, "s1", "ask_human", "q".repeat(5000), options);
    h.send("ask:new", ask);
    const payload = h.enqueued[0].payload as { type: string; ask: { question: string; options: string[] } };
    expect(payload.type).toBe("ask");
    expect(payload.ask.question.length).toBeLessThanOrEqual(MAX_ASK_QUESTION_CHARS + 1);
    expect(payload.ask.options).toHaveLength(MAX_ASK_OPTIONS);
    expect(payload.ask.options.every((o) => o.length <= MAX_ASK_OPTION_CHARS + 1)).toBe(true);
  });

  test("a ticket that returns to review wakes Persona again", () => {
    const h = setUp();
    const ticket = { id: "t1", status: "needs_review", launchId: "l1", title: "Fix", readyAt: "2026-10-01T00:00:00Z" };
    h.send("ticket:updated", ticket);
    h.send("ticket:updated", ticket);
    h.send("ticket:updated", { ...ticket, status: "developing" });
    h.send("ticket:updated", { ...ticket, readyAt: "2026-10-02T00:00:00Z" });
    expect(h.enqueued.filter((e) => e.payload.type === "ready_for_review")).toHaveLength(2);
    const keys = new Set(h.enqueued.map((e) => e.coalesceKey));
    expect(keys.size).toBe(2);
  });

  test("an owned launch binding its session republishes the job once", () => {
    const h = setUp();
    const launch = getLaunch(h.store.db, "l1")!;
    h.send("launch:started", launch);
    h.send("launch:started", launch);
    expect(h.published).toHaveLength(1);
    expect(h.published[0].sessionIds).toEqual(["s1"]);
    expect(h.enqueued).toHaveLength(0);
  });
});

describe("persona event router: live job state", () => {
  const states = (h: ReturnType<typeof setUp>) => h.published.map((j) => j.view?.state);

  test("a worker's status change republishes the job's derived state, once per change", () => {
    const h = setUp();
    updateSessionStatus(h.store.db, "s1", "idle");
    h.send("session:status", { sessionId: "s1", status: "idle" });
    h.send("session:status", { sessionId: "s1", status: "idle" });
    updateSessionStatus(h.store.db, "s1", "running");
    h.send("session:status", { sessionId: "s1", status: "running" });
    expect(states(h)).toEqual(["idle", "running"]);
  });

  test("an approval card for the job shows it needing the owner, and deciding it clears that", () => {
    const h = setUp();
    const card = createPersonaApproval(h.store.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {} });
    h.send("persona:approval", card);
    expect(h.published.at(-1)?.view).toMatchObject({ state: "needs_you", needs: ["approval"] });
    const decided = transitionPersonaApproval(h.store.db, card.id, "pending", "approved", { decidedBy: OWNER })!;
    h.send("persona:approval", decided);
    expect(states(h)).toEqual(["needs_you", "running"]);
  });

  test("deciding the job's card clears a waiting_user Persona set for it", () => {
    const h = setUp();
    const card = createPersonaApproval(h.store.db, { owner: OWNER, jobId: h.job.id, action: "x", summary: "s", args: {} });
    updatePersonaJob(h.store.db, h.job.id, { status: "waiting_user" });
    h.store.db.run("UPDATE persona_jobs SET waiting_since = ? WHERE id = ?", [new Date(Date.now() - 5000).toISOString(), h.job.id]);
    const decided = transitionPersonaApproval(h.store.db, card.id, "pending", "denied", { decidedBy: OWNER })!;
    h.send("persona:approval", decided);
    expect(getPersonaJob(h.store.db, h.job.id)!.status).toBe("active");
    expect(h.published.at(-1)).toMatchObject({ status: "active", view: { state: "running" } });
  });

  test("a hand-off waiting clears when the worker that raised it runs again", () => {
    const h = setUp();
    const cp = createCheckpoint(h.store.db, "s1", "self-reported", "The owner merges it.");
    h.store.db.run("UPDATE checkpoints SET created_at = '2099-01-01 00:00:00' WHERE id = ?", [cp.id]);
    updateSessionStatus(h.store.db, "s1", "idle");
    h.send("session:status", { sessionId: "s1", status: "idle" });
    expect(getPersonaJob(h.store.db, h.job.id)!.status).toBe("waiting_user");
    h.store.db.run("UPDATE persona_jobs SET waiting_since = ? WHERE id = ?", [new Date(Date.now() - 5000).toISOString(), h.job.id]);
    updateSessionStatus(h.store.db, "s1", "running");
    h.send("session:status", { sessionId: "s1", status: "running" });
    expect(getPersonaJob(h.store.db, h.job.id)!.status).toBe("active");
    expect(h.published.at(-1)).toMatchObject({ status: "active", view: { state: "running" } });
  });

  test("another owner's approval frame is ignored", () => {
    const h = setUp();
    h.send("persona:approval", { id: "a", owner: "bob", jobId: h.job.id, status: "pending" });
    expect(h.published).toHaveLength(0);
  });

  test("a worker ask and its resolution refresh the job", () => {
    const h = setUp();
    const ask = createAsk(h.store.db, "s1", "ask_human", "which?");
    updateSessionStatus(h.store.db, "s1", "waiting");
    h.send("ask:new", ask);
    updateSessionStatus(h.store.db, "s1", "running");
    h.send("ask:resolved", { askId: ask.id, answer: "a" });
    expect(states(h)).toEqual(["idle", "running"]);
  });

  test("a persona:job frame published elsewhere is not echoed back", () => {
    const h = setUp();
    const current = getPersonaJob(h.store.db, h.job.id)!;
    h.send("persona:job", current);
    h.send("session:status", { sessionId: "s1", status: "running" });
    expect(h.published).toHaveLength(0);
  });
});
