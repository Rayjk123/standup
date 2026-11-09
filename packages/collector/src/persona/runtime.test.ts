import { expect, test, describe } from "bun:test";
import {
  appendPersonaMessage,
  createStore,
  claimDuePersonaInbox,
  createPersonaApproval,
  enqueuePersonaInbox,
  getPersonaApproval,
  transitionPersonaApproval,
  getOrCreatePersonaState,
  getPersonaInboxItem,
  listPendingPersonaInbox,
  listPersonaMessages,
  updatePersonaState,
  createPersonaJob,
  getOrCreatePersonaThreadByRef,
  listPersonaJobs,
  upsertProject,
  createLaunch,
  createSession,
  attachSessionToLaunch,
  linkPersonaJobLaunch,
  createAsk,
  resolveAsk,
  getPersonaThreadSessionId,
  setPersonaThreadSessionId,
  createCheckpoint,
  endSession,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { PERSONA_SILENT_REPLY } from "@standup/shared";
import { resolvePersonaConfig } from "./config.js";
import type { PersonaConfig } from "./config.js";
import { MAX_TURN_ITEMS, PersonaRuntime, isNearDuplicateReply, isSilentReply } from "./runtime.js";
import type { TurnInput, TurnResult } from "./turn.js";
import { HANDOFF_PROMPT, HISTORY_HEADING, OPEN_QUESTIONS_HEADING } from "./prompt.js";
import { KnowledgeStore } from "@standup/knowledge";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { PERSONA_WRITER } from "./memory-trust.js";
import { memorySlug } from "./memory-slug.js";
import { buildOwnerProfile } from "./owner-profile.js";

const OWNER = "alice";

function harness(opts: {
  runner?: (input: TurnInput) => Promise<TurnResult>;
  config?: Partial<PersonaConfig>;
} = {}) {
  const store = createStore(":memory:");
  const frames: WsMessage[] = [];
  let nowMs = Date.parse("2026-10-04T12:00:00.000Z");
  const calls: TurnInput[] = [];
  const runner =
    opts.runner ??
    (async (): Promise<TurnResult> => ({ ok: true, text: "ok", sessionId: "sid-1", contextTokens: 1000 }));
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), ...opts.config },
    broadcast: (m) => frames.push(m),
    turnRunner: async (input) => {
      calls.push(input);
      return runner(input);
    },
    now: () => new Date(nowMs),
  });
  return {
    store,
    runtime,
    frames,
    calls,
    advance(ms: number) {
      nowMs += ms;
    },
    messages() {
      return listPersonaMessages(store.db, runtime.consoleThreadId());
    },
  };
}

describe("persona runtime — open questions in the turn prompt", () => {
  test("a typed reply leaves the thread's open questions open and listed for Persona to close", async () => {
    const h = harness();
    const thread = h.runtime.consoleThreadId();
    const q1 = appendPersonaMessage(h.store.db, { threadId: thread, role: "persona", text: "Which branch?", options: ["main", "dev"] }).message;
    const q2 = appendPersonaMessage(h.store.db, { threadId: thread, role: "persona", text: "Rotate now?", options: ["yes", "no"] }).message;
    h.runtime.receiveUserMessage({ text: "main, and not yet", actor: OWNER });
    await h.runtime.drain();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain(OPEN_QUESTIONS_HEADING);
    expect(prompt).toContain(`- ${q1.id} · 0m ago · "Which branch?"`);
    expect(prompt).toContain(`- ${q2.id} · 0m ago · "Rotate now?"`);
    expect(h.messages().filter((m) => m.options && !m.answeredAt).map((m) => m.id)).toEqual([q1.id, q2.id]);
  });

  test("a quick-reply tap drops its question from the next turn's list", async () => {
    const h = harness();
    const thread = h.runtime.consoleThreadId();
    const q1 = appendPersonaMessage(h.store.db, { threadId: thread, role: "persona", text: "Which branch?", options: ["main", "dev"] }).message;
    const q2 = appendPersonaMessage(h.store.db, { threadId: thread, role: "persona", text: "Rotate now?", options: ["yes", "no"] }).message;
    h.runtime.receiveUserMessage({ text: "main", actor: OWNER, replyTo: { messageId: q1.id, optionIndex: 0 } });
    await h.runtime.drain();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).not.toContain(q1.id + " ·");
    expect(prompt).toContain(`- ${q2.id} · `);
  });
});

describe("persona runtime — a quick-reply tap names the question it answers", () => {
  function twoQuestions(h: ReturnType<typeof harness>) {
    const thread = h.runtime.consoleThreadId();
    const push = createPersonaJob(h.store.db, { owner: OWNER, threadId: thread, title: "Push Standup main", goal: "g" });
    const rotate = createPersonaJob(h.store.db, { owner: OWNER, threadId: thread, title: "Rotate the keys", goal: "g" });
    const q1 = appendPersonaMessage(h.store.db, {
      threadId: thread,
      role: "persona",
      text: "Push Standup main to origin now?\nIt is 3 commits ahead.",
      options: ["Yes", "Later"],
      jobIds: [push.id],
    }).message;
    const q2 = appendPersonaMessage(h.store.db, {
      threadId: thread,
      role: "persona",
      text: "Rotate the keys today?",
      options: ["Yes", "No"],
      jobIds: [rotate.id],
    }).message;
    return { push, rotate, q1, q2 };
  }

  test("a tap renders with the question's id, first line and job tag", async () => {
    const h = harness();
    const { push, q1 } = twoQuestions(h);
    const message = h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, replyTo: { messageId: q1.id, optionIndex: 0 } });
    expect(message.replyToMessageId).toBe(q1.id);
    expect(message.jobIds).toBeUndefined();
    await h.runtime.drain();
    expect(h.calls[0]!.prompt).toContain(
      `· msg ${message.id}] [answers question ${q1.id} "Push Standup main to origin now?"] [re job ${push.id} "Push Standup main"] Yes`
    );
  });

  test("two open questions sharing an option each resolve to the one tapped", async () => {
    const h = harness();
    const { push, rotate, q1, q2 } = twoQuestions(h);
    const second = h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, replyTo: { messageId: q2.id, optionIndex: 0 } });
    await h.runtime.drain();
    const first = h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, replyTo: { messageId: q1.id, optionIndex: 0 } });
    await h.runtime.drain();
    expect(second.replyToMessageId).toBe(q2.id);
    expect(first.replyToMessageId).toBe(q1.id);
    expect(h.calls[0]!.prompt).toContain(`[answers question ${q2.id} "Rotate the keys today?"] [re job ${rotate.id} "Rotate the keys"] Yes`);
    expect(h.calls[0]!.prompt).not.toContain(`[answers question ${q1.id}`);
    expect(h.calls[1]!.prompt).toContain(`[answers question ${q1.id} "Push Standup main to origin now?"] [re job ${push.id} "Push Standup main"] Yes`);
    expect(h.calls[1]!.prompt).not.toContain(`[answers question ${q2.id}`);
  });

  test("a job the owner tagged the tap with is named once", async () => {
    const h = harness();
    const { push, q1 } = twoQuestions(h);
    h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, jobId: push.id, replyTo: { messageId: q1.id, optionIndex: 0 } });
    await h.runtime.drain();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain(`[answers question ${q1.id} "Push Standup main to origin now?"] [re job ${push.id} "Push Standup main"] Yes`);
    expect(prompt.split(`[re job ${push.id}`).length).toBe(2);
  });

  test("a typed message, or a tap naming no valid option, carries no question tag", async () => {
    const h = harness();
    const { q1 } = twoQuestions(h);
    const typed = h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER });
    const outOfRange = h.runtime.receiveUserMessage({ text: "Maybe", actor: OWNER, replyTo: { messageId: q1.id, optionIndex: 5 } });
    const unknown = h.runtime.receiveUserMessage({ text: "Sure", actor: OWNER, replyTo: { messageId: "nope", optionIndex: 0 } });
    await h.runtime.drain();
    for (const m of [typed, outOfRange, unknown]) expect(m.replyToMessageId).toBeUndefined();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).not.toContain("[answers question");
    expect(prompt).toContain(`· msg ${typed.id}] Yes`);
  });

  test("a question's job the thread may no longer name is left out of the tap's tags", async () => {
    const h = harness();
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "D1:1.0", "dm", "private");
    const consoleJob = createPersonaJob(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "Secret console job", goal: "g" });
    const dmJob = createPersonaJob(h.store.db, { owner: OWNER, threadId: dm.id, title: "DM job", goal: "g" });
    const q = appendPersonaMessage(h.store.db, {
      threadId: dm.id,
      role: "persona",
      text: "Go ahead?",
      options: ["Yes"],
      jobIds: [consoleJob.id, dmJob.id],
    }).message;
    getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "D1:1.0", "dm", "shared");
    h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, threadId: dm.id, replyTo: { messageId: q.id, optionIndex: 0 } });
    await h.runtime.drain();
    const prompt = h.calls[0]!.prompt;
    expect(prompt).toContain(`[answers question ${q.id} "Go ahead?"] [re job ${dmJob.id} "DM job"] Yes`);
    expect(prompt).not.toContain(`[re job ${consoleJob.id}`);
  });

  test("a tap on a question of another thread is not linked", async () => {
    const h = harness();
    const other = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "D1:1.0", "dm", "private");
    const q = appendPersonaMessage(h.store.db, { threadId: other.id, role: "persona", text: "Elsewhere?", options: ["Yes"] }).message;
    const message = h.runtime.receiveUserMessage({ text: "Yes", actor: OWNER, replyTo: { messageId: q.id, optionIndex: 0 } });
    expect(message.replyToMessageId).toBeUndefined();
  });
});

describe("persona runtime — a message tagged to a job", () => {
  test("stores the job id on the message and names the job in the turn prompt", async () => {
    const h = harness();
    const job = createPersonaJob(h.store.db, {
      owner: OWNER,
      threadId: h.runtime.consoleThreadId(),
      title: "Fix the flaky test",
      goal: "g",
    });
    const message = h.runtime.receiveUserMessage({ text: "any news?", actor: OWNER, jobId: job.id });
    expect(message.jobIds).toEqual([job.id]);
    expect(h.messages()[0]?.jobIds).toEqual([job.id]);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.prompt).toContain(`· msg ${message.id}] [re job ${job.id} "Fix the flaky test"] any news?`);
  });

  test("another owner's job is not tagged", async () => {
    const h = harness();
    const foreign = createPersonaJob(h.store.db, { owner: "mallory", threadId: "elsewhere", title: "secret", goal: "g" });
    const message = h.runtime.receiveUserMessage({ text: "hi", actor: OWNER, jobId: foreign.id });
    expect(message.jobIds).toBeUndefined();
    await h.runtime.drain();
    expect(h.calls[0]!.prompt).not.toContain("[re job");
  });

  test("no job is taggable in a missing thread or one that isn't the owner's", () => {
    const h = harness();
    const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "t", goal: "g" });
    expect(h.runtime.jobTaggableIn(h.runtime.consoleThreadId(), job.id)?.id).toBe(job.id);
    expect(h.runtime.jobTaggableIn("no-such-thread", job.id)).toBeNull();
    const theirs = getOrCreatePersonaThreadByRef(h.store.db, "mallory", "slack", "D9:1.0", "mallory dm", "private");
    expect(h.runtime.jobTaggableIn(theirs.id, job.id)).toBeNull();
  });
});

describe("persona runtime — the owner profile in the system prompt", () => {
  test("opens with the profile's usage header", async () => {
    const h = harness();
    const k = new KnowledgeStore(h.store.db);
    const slug = memorySlug(OWNER, "tables")!.slug;
    k.upsertDoc({
      id: "m1",
      projectId: GLOBAL_PROJECT_ID,
      slug,
      title: "Tables",
      body: "Prefer tables in summaries.",
      tags: ["persona", "preference"],
      scope: "user",
      ownerUser: OWNER,
      sourceKind: "decision",
      originClass: "agent",
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      filePath: "/nonexistent/tables.md",
    });
    k.stampWriter(GLOBAL_PROJECT_ID, slug, PERSONA_WRITER);
    h.runtime.receiveUserMessage({ text: "hi", actor: OWNER });
    await h.runtime.drain();
    const text = buildOwnerProfile(h.store.db, OWNER).text;
    expect(text).toContain("Prefer tables in summaries.");
    expect(h.calls[0].systemPrompt).toContain(
      `## Your profile of alice — loaded every turn\n\nHow alice works, saved from their own messages and files — not from worker text.\n\n[${text.length}/10,000 chars]\n\n${text}`
    );
  });
});

describe("persona runtime — turns", () => {
  test("a user message runs one turn whose reply posts to the console thread", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: "  On it.  ", sessionId: "sid-1", contextTokens: 10 }) });
    h.runtime.receiveUserMessage({ text: " fix the build ", actor: OWNER, idempotencyKey: "k1" });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt).toMatch(/· alice · console · msg [0-9a-f-]{36}\] fix the build/);
    expect(h.calls[0].resumeSessionId).toBeUndefined();
    expect(h.calls[0].systemPrompt).toContain("You are Persona, alice's");
    expect(h.calls[0].systemPrompt).not.toContain("## Your profile of alice");
    const msgs = h.messages();
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ["user", "fix the build"],
      ["persona", "On it."],
    ]);
    expect(msgs[0].idempotencyKey).toBe("k1");
    const state = h.runtime.getState();
    expect(state.claudeSessionId).toBe("sid-1");
    expect(state.lastContextTokens).toBe(10);
    expect(state.runState).toBe("idle");
    expect(state.pendingInbox).toBe(0);
    expect(h.frames.some((f) => f.type === "persona:message")).toBe(true);
    expect(h.frames.filter((f) => f.type === "persona:state").some((f) => (f.payload as { runState: string }).runState === "thinking")).toBe(true);

    // The next turn resumes the session.
    h.runtime.receiveUserMessage({ text: "and then?", actor: OWNER });
    await h.runtime.drain();
    expect(h.calls[1].resumeSessionId).toBe("sid-1");
  });

  test("a repeated idempotency key neither duplicates the message nor wakes Persona twice", async () => {
    const h = harness();
    const a = h.runtime.receiveUserMessage({ text: "x", actor: OWNER, idempotencyKey: "same" });
    const b = h.runtime.receiveUserMessage({ text: "x", actor: OWNER, idempotencyKey: "same" });
    expect(b.id).toBe(a.id);
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(1);
  });

  test("[silent] (any case) and an empty reply post nothing", async () => {
    for (const text of ["[silent]", " [SILENT] ", ""]) {
      const h = harness({ runner: async () => ({ ok: true, text, sessionId: "s" }) });
      h.runtime.enqueue("schedule", { note: "check" });
      await h.runtime.drain();
      expect(h.calls).toHaveLength(1);
      expect(h.messages()).toEqual([]);
    }
  });

  test("a mixed batch across two threads runs two turns, each replying in its own thread", async () => {
    const h = harness({
      runner: async (input) => ({
        ok: true,
        text: input.prompt.includes("from slack") ? "slack reply" : "console reply",
        sessionId: "s",
      }),
    });
    const slack = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:100.1", "#eng");
    h.runtime.receiveUserMessage({ text: "from console", actor: OWNER });
    h.advance(1000);
    h.runtime.receiveUserMessage({ text: "from slack", actor: OWNER, threadId: slack.id });
    h.advance(1000);
    h.runtime.enqueue("schedule", { note: "console wakeup" });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(2);
    // The oldest due item's thread (console) goes first and takes only its own items.
    expect(h.calls[0].prompt).toContain("from console");
    expect(h.calls[0].prompt).toContain('"console wakeup"');
    expect(h.calls[0].prompt).not.toContain("from slack");
    expect(h.calls[1].prompt).toMatch(/· alice · slack · msg [0-9a-f-]{36}\] from slack/);
    expect(h.calls[1].prompt).not.toContain("from console");
    expect(h.messages().map((m) => m.text)).toEqual(["from console", "console reply"]);
    expect(listPersonaMessages(h.store.db, slack.id).map((m) => m.text)).toEqual(["from slack", "slack reply"]);
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toEqual([]);
  });

  test("an owner message records its thread's channel and carries its context", async () => {
    const h = harness();
    const slack = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:D1");
    const context = [{ author: "bob", text: "the deploy is red", ts: "1.1" }];
    h.runtime.receiveUserMessage({ text: "look at this", actor: OWNER, threadId: slack.id, context });
    h.runtime.receiveUserMessage({ text: "console one", actor: OWNER });
    const items = listPendingPersonaInbox(h.store.db, OWNER);
    expect(items[0]).toMatchObject({ threadId: slack.id, payload: { channel: "slack", context } });
    expect(items[1].payload.channel).toBe("console");
    expect(items[1].payload.context).toBeUndefined();
  });

  test("a worker event for a job started in a Slack thread replies in that thread", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: "worker is asking about X", sessionId: "s" }) });
    const slack = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:200.2");
    const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: slack.id, title: "t", goal: "g" });
    const item = h.runtime.enqueue("worker_event", { type: "ask", jobId: job.id, ask: { id: "a1", kind: "ask_human", question: "X?" } });
    expect(item.threadId).toBe(slack.id);
    await h.runtime.drain();
    expect(listPersonaMessages(h.store.db, slack.id).map((m) => m.text)).toEqual(["worker is asking about X"]);
    expect(h.messages()).toEqual([]);
  });

  test("items resolve to a thread: job thread first, else the given thread, else the console; a wakeup stays where it was scheduled", async () => {
    const h = harness();
    const slack = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:D9");
    const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: slack.id, title: "t", goal: "g" });
    const foreign = createPersonaJob(h.store.db, { owner: "mallory", threadId: "elsewhere", title: "t", goal: "g" });
    const consoleId = h.runtime.consoleThreadId();
    expect(h.runtime.enqueue("worker_event", { type: "turn_end", jobId: job.id }).threadId).toBe(slack.id);
    expect(h.runtime.enqueue("schedule", { note: "n", jobId: job.id }, { threadId: consoleId }).threadId).toBe(consoleId);
    expect(h.runtime.enqueue("approval_result", { approvalId: "x" }, { threadId: slack.id }).threadId).toBe(slack.id);
    expect(h.runtime.enqueue("worker_event", { type: "ask", jobId: foreign.id }).threadId).toBeUndefined();
    expect(h.runtime.enqueue("schedule", { note: "plain" }).threadId).toBeUndefined();
    // An unthreaded item is the console thread's: it runs in the console turn.
    let prompt = "";
    const r = h.runtime as unknown as { turnRunner: (input: TurnInput) => Promise<TurnResult> };
    r.turnRunner = async (input) => {
      if (input.prompt.includes('"plain"')) prompt = input.prompt;
      return { ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" };
    };
    await h.runtime.drain();
    expect(prompt).toContain(foreign.id);
  });

  test("approval results report in the thread the approval was raised from", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: "noted", sessionId: "s" }) });
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:D2");
    const approval = createPersonaApproval(h.store.db, {
      owner: OWNER,
      threadId: dm.id,
      action: "open_job",
      summary: "Open a job",
      args: { title: "t", goal: "g" },
    });
    h.runtime.deny(approval.id, OWNER, "not now");
    const item = listPendingPersonaInbox(h.store.db, OWNER, "approval_result")[0];
    expect(item.threadId).toBe(dm.id);
    await h.runtime.drain();
    expect(listPersonaMessages(h.store.db, dm.id).map((m) => m.text)).toEqual(["noted"]);
    expect(h.messages()).toEqual([]);
  });

  test("an approved action without a job runs for the approval's thread", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" }) });
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:D3");
    const approval = createPersonaApproval(h.store.db, {
      owner: OWNER,
      threadId: dm.id,
      action: "open_job",
      summary: "Open a job",
      args: { title: "from dm", goal: "g" },
    });
    h.runtime.start();
    try {
      const final = await h.runtime.approve(approval.id, OWNER);
      expect(final?.status).toBe("executed");
    } finally {
      h.runtime.stop();
    }
    const job = listPersonaJobs(h.store.db, OWNER).find((j) => j.title === "from dm");
    expect(job?.threadId).toBe(dm.id);
    const activity = h.frames.find((f) => f.type === "persona:activity");
    expect((activity?.payload as { threadId?: string }).threadId).toBe(dm.id);
  });

  test("a turn that keeps failing reports in its own thread, with the error only in a private one", async () => {
    const h = harness({ runner: async () => ({ ok: false, error: "boom: ENOENT /home/alice/.claude/projects/secret.jsonl" }) });
    const slack = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:D2", undefined, "private");
    h.runtime.receiveUserMessage({ text: "do it", actor: OWNER, threadId: slack.id });
    for (const wait of [0, 30_000, 60_000]) {
      h.advance(wait);
      await h.runtime.drain();
    }
    const system = listPersonaMessages(h.store.db, slack.id).filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain("boom");
    expect(h.messages()).toEqual([]);

    const chan = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C2:1.1", "#team", "shared");
    h.runtime.receiveUserMessage({ text: "status?", actor: OWNER, threadId: chan.id });
    for (const wait of [0, 30_000, 60_000]) {
      h.advance(wait);
      await h.runtime.drain();
    }
    const notice = listPersonaMessages(h.store.db, chan.id).filter((m) => m.role === "system");
    expect(notice.map((m) => m.text)).toEqual(["I hit an error and couldn't finish this — details are in the Standup console."]);
    expect(getOrCreatePersonaState(h.store.db, OWNER).lastError).toContain("boom");
  });

  test("single-flight: concurrent drains never overlap, and mid-turn items get their own turn", async () => {
    let release!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness({
      runner: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (!release) await new Promise<void>((r) => (release = r));
        inFlight--;
        return { ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" };
      },
    });
    h.runtime.receiveUserMessage({ text: "one", actor: OWNER });
    const first = h.runtime.drain();
    await Bun.sleep(5);
    h.runtime.receiveUserMessage({ text: "two", actor: OWNER });
    const second = h.runtime.drain();
    const third = h.runtime.drain();
    await Bun.sleep(5);
    expect(h.calls).toHaveLength(1);
    release();
    await Promise.all([first, second, third]);
    expect(maxInFlight).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].prompt).toContain("] one");
    expect(h.calls[0].prompt).not.toContain("] two");
    expect(h.calls[1].prompt).toContain("] two");
  });

  test("routine worker events wait out the coalesce window and merge under one key", async () => {
    const h = harness({ config: { coalesceMs: 20_000 } });
    h.runtime.enqueue("worker_event", { type: "turn_end", status: "idle" }, { coalesceKey: "session:s1" });
    h.runtime.enqueue("worker_event", { type: "turn_end", status: "waiting" }, { coalesceKey: "session:s1" });
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: "q" } }, { coalesceKey: "ask:q" });
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(2);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt).toContain("worker ask");
    expect(h.calls[0].prompt).not.toContain("turn ended");
    h.advance(20_000);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].prompt).toContain("turn ended — status waiting");
  });

  test("failures back off 30s then 60s, then fail with a system message and error state", async () => {
    const h = harness({ runner: async () => ({ ok: false, error: "Bedrock 403" }) });
    const msg = h.runtime.receiveUserMessage({ text: "do it", actor: OWNER });
    const itemId = listPendingPersonaInbox(h.store.db, OWNER)[0].id;
    await h.runtime.drain();
    let item = getPersonaInboxItem(h.store.db, itemId)!;
    expect(item.status).toBe("pending");
    expect(item.attempts).toBe(1);
    expect(item.notBefore).toBe("2026-10-04T12:00:30.000Z");
    expect(h.runtime.getState()).toMatchObject({ runState: "error", lastError: "Bedrock 403" });

    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    h.advance(30_000);
    await h.runtime.drain();
    item = getPersonaInboxItem(h.store.db, itemId)!;
    expect(item.attempts).toBe(2);
    expect(item.notBefore).toBe("2026-10-04T12:01:30.000Z");

    h.advance(60_000);
    await h.runtime.drain();
    item = getPersonaInboxItem(h.store.db, itemId)!;
    expect(item.status).toBe("failed");
    expect(h.calls).toHaveLength(3);
    const system = h.messages().filter((m) => m.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0].text).toContain("after 3 attempts");
    expect(system[0].text).toContain("Bedrock 403");
    expect(h.messages()[0].id).toBe(msg.id);
  });

  test("a turn that throws still settles its items instead of leaving them processing", async () => {
    const h = harness({
      runner: async () => {
        throw new Error("kaboom");
      },
    });
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    const [item] = h.store.db.query("SELECT status, attempts FROM persona_inbox").all() as Array<{ status: string; attempts: number }>;
    expect(item).toEqual({ status: "pending", attempts: 1 });
  });

  test("an unknown resumed session is cleared and the turn retried once fresh", async () => {
    const h = harness({
      runner: async (input) =>
        input.resumeSessionId
          ? { ok: false, error: "No conversation found", sessionNotFound: true }
          : { ok: true, text: "fresh", sessionId: "sid-new" },
    });
    updatePersonaState(h.store.db, OWNER, { claudeSessionId: "sid-gone" });
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    expect(h.calls.map((c) => c.resumeSessionId)).toEqual(["sid-gone", undefined]);
    expect(h.runtime.getState().claudeSessionId).toBe("sid-new");
  });

  test("past the rotation threshold a handoff turn seeds a fresh epoch", async () => {
    const h = harness({
      config: { rotateTokens: 5000 },
      runner: async (input) =>
        input.prompt === HANDOFF_PROMPT
          ? { ok: true, text: "J1 waits on review.", sessionId: "sid-1" }
          : { ok: true, text: PERSONA_SILENT_REPLY, sessionId: input.resumeSessionId ?? "sid-1", contextTokens: 6000 },
    });
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].prompt).toBe(HANDOFF_PROMPT);
    expect(h.calls[1].resumeSessionId).toBe("sid-1");
    const state = getOrCreatePersonaState(h.store.db, OWNER);
    expect(state.handoffNote).toBe("J1 waits on review.");
    expect(state.claudeSessionId).toBeUndefined();
    expect(state.epoch).toBe(2);

    h.runtime.enqueue("schedule", { note: "y" });
    await h.runtime.drain();
    expect(h.calls[2].resumeSessionId).toBeUndefined();
    expect(h.calls[2].systemPrompt).toContain("## Your own notes from your previous session\n\n");
    expect(h.calls[2].systemPrompt).toContain("not alice's instructions.\n\nJ1 waits on review.");
  });

  test("paused: items accumulate without a turn; resume drains them", async () => {
    const h = harness();
    h.runtime.setPaused(true);
    h.runtime.receiveUserMessage({ text: "queued", actor: OWNER });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(0);
    expect(h.runtime.getState()).toMatchObject({ runState: "paused", pendingInbox: 1 });
    h.runtime.setPaused(false);
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.runtime.getState().runState).toBe("idle");
  });

  test("paused: repeated drains publish no identical state frames", async () => {
    const h = harness();
    h.runtime.setPaused(true);
    h.runtime.receiveUserMessage({ text: "queued", actor: OWNER });
    const before = h.frames.filter((f) => f.type === "persona:state").length;
    for (let i = 0; i < 5; i++) await h.runtime.drain();
    expect(h.frames.filter((f) => f.type === "persona:state").length).toBe(before);
  });

  test("reset clears the session and bumps the epoch without a handoff turn", async () => {
    const h = harness();
    updatePersonaState(h.store.db, OWNER, { claudeSessionId: "s", lastError: "x" });
    const state = h.runtime.reset();
    expect(state.claudeSessionId).toBeUndefined();
    expect(state.epoch).toBe(2);
    expect(state.runState).toBe("idle");
    expect(h.calls).toHaveLength(0);
  });

  test("boot returns items a crashed turn left processing to pending", async () => {
    const h = harness();
    h.runtime.enqueue("schedule", { note: "x" });
    claimDuePersonaInbox(h.store.db, OWNER, "2026-10-04T12:00:00.000Z");
    h.runtime.start();
    await h.runtime.drain();
    h.runtime.stop();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt).toContain('"x"');
    const [item] = h.store.db.query("SELECT status FROM persona_inbox").all() as Array<{ status: string }>;
    expect(item.status).toBe("done");
  });
});


describe("persona runtime — review fixes", () => {
  test("a reply whose last non-empty line is [silent] posts nothing", async () => {
    expect(isSilentReply("Answered J3.\n\n[silent]")).toBe(true);
    expect(isSilentReply("[Silent]\n\n")).toBe(true);
    expect(isSilentReply("[silent] — but here is news")).toBe(false);
    expect(isSilentReply("Done.")).toBe(false);
    const h = harness({ runner: async () => ({ ok: true, text: "Answered J3.\n\n[silent]", sessionId: "s" }) });
    h.runtime.enqueue("schedule", { note: "check" });
    await h.runtime.drain();
    expect(h.messages()).toEqual([]);
  });

  test("a reply written beside the turn's last tool call posts; a handoff note never comes from it", async () => {
    const reply = "Launched a worker and stopped the idle one.\n\nI'll report once its tests pass.";
    const h = harness({
      config: { rotateTokens: 5000 },
      runner: async (input) =>
        input.prompt === HANDOFF_PROMPT
          ? { ok: true, text: "", earlierText: "Let me check the jobs first.", sessionId: "sid-1" }
          : { ok: true, text: "", earlierText: reply, sessionId: "sid-1", contextTokens: 6000 },
    });
    h.runtime.receiveUserMessage({ text: "go ahead", actor: OWNER });
    await h.runtime.drain();
    expect(h.messages().filter((m) => m.role === "persona").map((m) => m.text)).toEqual([reply]);
    expect(getOrCreatePersonaState(h.store.db, OWNER).handoffNote).toContain("Auto-generated");
  });

  test("reset during a running turn is not undone when the turn settles", async () => {
    let release!: () => void;
    const h = harness({
      config: { rotateTokens: 100 },
      runner: async () => {
        await new Promise<void>((r) => (release = r));
        return { ok: true, text: "done", sessionId: "sid-old", contextTokens: 5000 };
      },
    });
    updatePersonaState(h.store.db, OWNER, { claudeSessionId: "sid-old", handoffNote: "old note" });
    h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
    const turn = h.runtime.drain();
    await Bun.sleep(5);
    const after = h.runtime.reset();
    expect(after.claudeSessionId).toBeUndefined();
    release();
    await turn;
    const state = getOrCreatePersonaState(h.store.db, OWNER);
    expect(state.claudeSessionId).toBeUndefined();
    expect(state.lastContextTokens).toBeUndefined();
    expect(state.handoffNote).toBeUndefined();
    expect(state.epoch).toBe(2);
    // No rotation turn for the abandoned epoch, and the reply still posts.
    expect(h.calls).toHaveLength(1);
    expect(h.messages().map((m) => m.text)).toEqual(["go", "done"]);
  });

  test("a failed handoff turn still rotates, with an auto-generated note from the job snapshot", async () => {
    let turns = 0;
    const h = harness({
      config: { rotateTokens: 5000 },
      runner: async (input) =>
        input.prompt === HANDOFF_PROMPT
          ? { ok: false, error: "turn timed out after 600s" }
          : { ok: true, text: PERSONA_SILENT_REPLY, sessionId: "sid-1", contextTokens: ++turns === 1 ? 6000 : 100 },
    });
    const thread = h.runtime.consoleThreadId();
    h.store.db.run(
      "INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at) VALUES ('job-1', ?, ?, 'Fix flaky test', 'g', ?, ?)",
      [OWNER, thread, new Date().toISOString(), new Date().toISOString()]
    );
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    const state = getOrCreatePersonaState(h.store.db, OWNER);
    expect(state.epoch).toBe(2);
    expect(state.claudeSessionId).toBeUndefined();
    expect(state.handoffNote).toContain("Auto-generated");
    expect(state.handoffNote).toContain("turn timed out after 600s");
    expect(state.handoffNote).toContain('job job-1 "Fix flaky test" (active)');

    // The next turn starts fresh instead of retrying the handoff.
    h.runtime.enqueue("schedule", { note: "y" });
    await h.runtime.drain();
    expect(h.calls.map((c) => c.prompt === HANDOFF_PROMPT)).toEqual([false, true, false]);
    expect(h.calls[2].resumeSessionId).toBeUndefined();
  });

  test("one turn takes at most MAX_TURN_ITEMS items; the rest get the next turn", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" }) });
    for (let i = 0; i < MAX_TURN_ITEMS + 5; i++) {
      enqueuePersonaInbox(h.store.db, { owner: OWNER, kind: "schedule", payload: { note: `n${i}` } });
    }
    await h.runtime.drain();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].prompt).toContain('"n0"');
    expect(h.calls[0].prompt).toContain(`"n${MAX_TURN_ITEMS - 1}"`);
    expect(h.calls[0].prompt).not.toContain(`"n${MAX_TURN_ITEMS}"`);
    expect(h.calls[1].prompt).toContain(`"n${MAX_TURN_ITEMS}"`);
    expect(h.runtime.getState().pendingInbox).toBe(0);
  });

  test("pausing mid-turn reads as thinking until the turn settles, then paused", async () => {
    let release!: () => void;
    const h = harness({
      runner: async () => {
        await new Promise<void>((r) => (release = r));
        return { ok: true, text: "reply", sessionId: "s" };
      },
    });
    h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
    const turn = h.runtime.drain();
    await Bun.sleep(5);
    expect(h.runtime.setPaused(true).runState).toBe("thinking");
    release();
    await turn;
    expect(h.runtime.getState().runState).toBe("paused");
  });

  test("approve: another owner's approval is left pending, not consumed", async () => {
    const h = harness();
    const bobs = createPersonaApproval(h.store.db, { owner: "bob", action: "remember", summary: "s", args: {} });
    expect(await h.runtime.approve(bobs.id, OWNER)).toBeNull();
    expect(getPersonaApproval(h.store.db, bobs.id)?.status).toBe("pending");
  });

  test("an owner approval made while Persona is held for a restart runs only once it is released", async () => {
    const h = harness();
    const a = createPersonaApproval(h.store.db, { owner: OWNER, action: "remember", summary: "s", args: {} });
    expect(await h.runtime.quiesce(1_000)).toBe(true);
    const held = await h.runtime.approve(a.id, OWNER);
    expect(held?.status).toBe("pending");
    expect(getPersonaApproval(h.store.db, a.id)?.status).toBe("pending");
    expect(listPendingPersonaInbox(h.store.db, OWNER, "approval_result")).toHaveLength(0);
    h.runtime.release();
    for (let i = 0; i < 200 && ["pending", "approved"].includes(getPersonaApproval(h.store.db, a.id)!.status); i++) await Bun.sleep(5);
    const ran = getPersonaApproval(h.store.db, a.id)!;
    expect(["executed", "failed"]).toContain(ran.status);
    expect(ran.decidedBy).toBe(OWNER);
    expect(listPendingPersonaInbox(h.store.db, OWNER, "approval_result")).toHaveLength(1);
  });

  test("a held runtime with a due item arms no wake loop, and takes its turn once released", async () => {
    const h = harness();
    const rt = h.runtime as unknown as { runOnce: () => Promise<void> };
    const runOnce = rt.runOnce.bind(h.runtime);
    let runs = 0;
    rt.runOnce = async () => {
      runs++;
      return runOnce();
    };
    h.runtime.start();
    try {
      await h.runtime.drain();
      expect(await h.runtime.quiesce(1_000)).toBe(true);
      runs = 0;
      h.runtime.receiveUserMessage({ text: "while held", actor: OWNER });
      await Bun.sleep(300);
      expect(runs).toBeLessThanOrEqual(2);
      expect(h.calls).toHaveLength(0);
      expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(1);

      h.runtime.release();
      for (let i = 0; i < 200 && h.calls.length === 0; i++) await Bun.sleep(5);
      await h.runtime.drain();
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.prompt).toContain("while held");
      expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(0);
    } finally {
      h.runtime.stop();
    }
  });

  test("a turn killed on shutdown after hold() puts its items back untouched, and no new turn starts", async () => {
    let finish!: (result: TurnResult) => void;
    const h = harness({
      runner: () => new Promise<TurnResult>((resolve) => (finish = resolve)),
    });
    h.runtime.start();
    try {
      h.runtime.receiveUserMessage({ text: "first", actor: OWNER });
      const firstId = listPendingPersonaInbox(h.store.db, OWNER)[0]!.id;
      const before = getPersonaInboxItem(h.store.db, firstId)!;
      for (let i = 0; i < 200 && h.calls.length === 0; i++) await Bun.sleep(5);
      expect(h.calls).toHaveLength(1);
      // Due while the turn runs: a follow-up drain is flagged for it.
      h.runtime.receiveUserMessage({ text: "second", actor: OWNER });
      await Bun.sleep(20);

      h.runtime.hold();
      finish({ ok: false, error: "turn killed on shutdown", killed: true });
      await Bun.sleep(100);
      expect(h.calls).toHaveLength(1);

      const after = getPersonaInboxItem(h.store.db, firstId)!;
      expect(after.status).toBe("pending");
      expect(after.attempts).toBe(before.attempts);
      expect(after.notBefore).toBe(before.notBefore);
      expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(2);
      expect(h.runtime.getState().lastError ?? null).toBeNull();
      expect(h.messages().filter((m) => m.role === "system")).toHaveLength(0);
    } finally {
      h.runtime.stop();
    }
  });

  test("a held approval the owner denies before the release is not run", async () => {
    const h = harness();
    const a = createPersonaApproval(h.store.db, { owner: OWNER, action: "remember", summary: "s", args: {} });
    await h.runtime.quiesce(1_000);
    await h.runtime.approve(a.id, OWNER);
    expect(h.runtime.deny(a.id, OWNER, "changed my mind")?.status).toBe("denied");
    h.runtime.release();
    await Bun.sleep(20);
    expect(getPersonaApproval(h.store.db, a.id)?.status).toBe("denied");
  });

  test("approve past the 24h expiry records it expired instead of executing", async () => {
    const h = harness();
    const a = createPersonaApproval(h.store.db, { owner: OWNER, action: "remember", summary: "s", args: {} });
    h.store.db.run("UPDATE persona_approvals SET created_at = '2026-10-03T11:00:00.000Z' WHERE id = ?", [a.id]);
    expect(await h.runtime.approve(a.id, OWNER)).toBeNull();
    expect(getPersonaApproval(h.store.db, a.id)?.status).toBe("expired");
    expect(listPendingPersonaInbox(h.store.db, OWNER, "approval_result")).toHaveLength(1);
  });

  test("boot fails approvals a crash left mid-execution and tells Persona", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" }) });
    const a = createPersonaApproval(h.store.db, { owner: OWNER, action: "launch_session", summary: "Launch X", args: {} });
    transitionPersonaApproval(h.store.db, a.id, "pending", "approved", { decidedBy: OWNER });
    h.runtime.start();
    await h.runtime.drain();
    h.runtime.stop();
    const after = getPersonaApproval(h.store.db, a.id)!;
    expect(after.status).toBe("failed");
    expect(after.result).toBe("interrupted by a collector restart");
    expect(h.calls[0].prompt).toContain("interrupted by a collector restart");
  });

  test("the tick publishes persona:state only when it changed", async () => {
    const h = harness();
    await h.runtime.tick();
    const count = () => h.frames.filter((f) => f.type === "persona:state").length;
    const first = count();
    expect(first).toBeGreaterThan(0);
    await h.runtime.tick();
    await h.runtime.tick();
    expect(count()).toBe(first);
    updatePersonaState(h.store.db, OWNER, { lastError: "boom" });
    await h.runtime.tick();
    expect(count()).toBe(first + 1);
  });

  test("the tick prunes settled inbox rows older than 7 days", async () => {
    const h = harness();
    const old = enqueuePersonaInbox(h.store.db, { owner: OWNER, kind: "schedule", payload: {} }).item;
    h.store.db.run("UPDATE persona_inbox SET status = 'done', processed_at = '2026-09-20T00:00:00.000Z' WHERE id = ?", [old.id]);
    await h.runtime.tick();
    expect(getPersonaInboxItem(h.store.db, old.id)).toBeNull();
  });

  test("every persona:* frame leaving the runtime is addressed to the owner", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: "reply", sessionId: "s" }) });
    const a = createPersonaApproval(h.store.db, { owner: OWNER, action: "nope_unknown", summary: "s", args: {} });
    h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
    await h.runtime.drain();
    await h.runtime.approve(a.id, OWNER);
    await h.runtime.tick();
    const persona = h.frames.filter((f) => f.type.startsWith("persona:"));
    expect(new Set(persona.map((f) => f.type))).toEqual(new Set(["persona:state", "persona:message", "persona:approval"]));
    expect(persona.every((f) => f.audience === OWNER)).toBe(true);
  });

  test("the snapshot counts only launches still starting", async () => {
    const h = harness();
    const thread = h.runtime.consoleThreadId();
    const at = new Date().toISOString();
    h.store.db.run("INSERT INTO projects (id, name, branch, repos_json) VALUES ('p', 'p', 'main', '[]')");
    h.store.db.run(
      "INSERT INTO persona_jobs (id, owner, thread_id, title, goal, created_at, updated_at) VALUES ('job-1', ?, ?, 't', 'g', ?, ?)",
      [OWNER, thread, at, at]
    );
    for (const [id, status] of [["L1", "starting"], ["L2", "failed"]]) {
      h.store.db.run(
        "INSERT INTO launches (id, project_id, task, worktree_path, branch, status) VALUES (?, 'p', 't', ?, 'b', ?)",
        [id, `/wt/${id}`, status]
      );
      h.store.db.run(
        "INSERT INTO persona_job_launches (job_id, launch_id, persona_plan_gate, created_at) VALUES ('job-1', ?, 0, ?)",
        [id, at]
      );
    }
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    expect(h.calls[0].prompt).toContain("1 launch starting");
  });

  test("the snapshot lists open jobs in full, recently closed jobs on one line, and counts older ones", async () => {
    const h = harness();
    const threadId = h.runtime.consoleThreadId();
    upsertProject(h.store.db, { id: "p", name: "p", branch: "main", repos: [] });
    for (const id of ["S1", "S2", "S3"]) {
      createLaunch(h.store.db, { id: `L-${id}`, projectId: "p", task: "t", worktreePath: `/wt/${id}`, branch: "b" });
      createSession(h.store.db, { id, projectId: "p", title: "w", cwd: `/wt/${id}`, status: "running" });
      attachSessionToLaunch(h.store.db, `L-${id}`, id);
      createCheckpoint(h.store.db, id, "self-reported", `checkpoint of ${id}`);
    }
    endSession(h.store.db, "S2");
    const open = createPersonaJob(h.store.db, { owner: OWNER, threadId, title: "Open job", goal: "g" });
    for (const id of ["S1", "S2"]) linkPersonaJobLaunch(h.store.db, open.id, `L-${id}`, false);
    const close = (title: string, minutesAgo: number, launch?: string) => {
      const job = createPersonaJob(h.store.db, { owner: OWNER, threadId, title, goal: "g" });
      if (launch) linkPersonaJobLaunch(h.store.db, job.id, launch, false);
      const at = new Date(Date.parse("2026-10-04T12:00:00.000Z") - minutesAgo * 60_000).toISOString();
      h.store.db.run("UPDATE persona_jobs SET status = 'done', outcome = ?, updated_at = ? WHERE id = ?", [
        `${title} outcome ${"x".repeat(200)}`,
        at,
        job.id,
      ]);
    };
    close("Recent job", 30, "L-S3");
    close("Older job", 3 * 60);
    close("Yesterday job", 30 * 60);
    h.runtime.enqueue("schedule", { note: "x" });
    await h.runtime.drain();
    const prompt = h.calls[0].prompt;
    expect(prompt).toContain('"Open job" (active) — S1 (S1) [p] running · ');
    expect(prompt).toContain('"checkpoint of S1"');
    expect(prompt).toContain("1 ended session");
    expect(prompt).not.toContain("checkpoint of S2");
    const recent = prompt.split("\n").find((l) => l.includes('"Recent job"'))!;
    expect(recent).toMatch(/^- \S+ "Recent job" \(done\) — outcome: "Recent job outcome x+…"$/);
    expect(recent).not.toContain("checkpoint of S3");
    expect(recent.split('outcome: "')[1]!.length).toBeLessThanOrEqual(101);
    expect(prompt).not.toContain("Older job");
    expect(prompt).not.toContain("Yesterday job");
    expect(prompt).toContain("- +1 closed job today (list_jobs for details)");
  });
});

describe("persona runtime — repeated replies", () => {
  const replies = (texts: string[]) => {
    let i = 0;
    return harness({ runner: async () => ({ ok: true, text: texts[i++] ?? "[silent]", sessionId: "sid-1", contextTokens: 10 }) });
  };
  const personaTexts = (h: ReturnType<typeof harness>) => h.messages().filter((m) => m.role === "persona").map((m) => m.text);
  /** Dates the thread's messages to the harness clock, so the age check reads its time. */
  const stamp = (h: ReturnType<typeof harness>, at: string) =>
    h.store.db.run("UPDATE persona_messages SET created_at = ?", [at]);

  test("a reply that repeats the previous persona message within 15 minutes is dropped", async () => {
    const h = replies([
      "Job J1 is running in project p; I'll report when the tests pass.",
      "Job J1 is running in project p — I'll report when the tests pass!",
      "Job J1 is still running in project p; I'll report when the tests pass.",
      "Job J1 finished: tests pass.",
    ]);
    for (let i = 0; i < 4; i++) {
      h.runtime.receiveUserMessage({ text: `status? ${i}`, actor: OWNER });
      await h.runtime.drain();
      stamp(h, "2026-10-04T12:00:00.000Z");
    }
    expect(personaTexts(h)).toEqual(["Job J1 is running in project p; I'll report when the tests pass.", "Job J1 finished: tests pass."]);
  });

  test("the same reply posts again once the previous one is older than 15 minutes", async () => {
    const h = replies(["On it.", "On it."]);
    h.runtime.receiveUserMessage({ text: "a", actor: OWNER });
    await h.runtime.drain();
    stamp(h, "2026-10-04T12:00:00.000Z");
    h.advance(16 * 60 * 1000);
    h.runtime.receiveUserMessage({ text: "b", actor: OWNER });
    await h.runtime.drain();
    expect(personaTexts(h)).toEqual(["On it.", "On it."]);
  });

  test("near-duplicate detection", () => {
    expect(isNearDuplicateReply("On it.", "on it")).toBe(true);
    expect(isNearDuplicateReply("Job J1 failed.", "Job J2 failed.")).toBe(false);
    expect(isNearDuplicateReply("On it.", "On it, starting now.")).toBe(false);
    expect(isNearDuplicateReply("", "x")).toBe(false);
  });
});

describe("persona runtime — audience", () => {
  function confidentialSetup(h: ReturnType<typeof harness>) {
    const dm = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "dm:DOWNER", "Slack DM", "private");
    const chan = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "CTEAM:10.1", "#team", "shared");
    createPersonaJob(h.store.db, { owner: OWNER, threadId: dm.id, title: "PIP doc for Bob (confidential)", goal: "draft" });
    createPersonaJob(h.store.db, { owner: OWNER, threadId: chan.id, title: "Fix the team build", goal: "fix" });
    return { dm, chan };
  }

  test("a shared-thread turn runs on its own session, sees only its jobs, and says who reads it", async () => {
    let n = 0;
    const h = harness({ runner: async () => ({ ok: true, text: "reply", sessionId: `sid-${++n}`, contextTokens: 10 }) });
    const { dm, chan } = confidentialSetup(h);
    updatePersonaState(h.store.db, OWNER, { handoffNote: "Bob's PIP is underway" });
    h.runtime.receiveUserMessage({ text: "Draft the PIP doc. Keep this between us.", threadId: dm.id, actor: OWNER });
    await h.runtime.drain();
    h.runtime.receiveUserMessage({ text: "what's on my plate today?", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    h.runtime.receiveUserMessage({ text: "and the build?", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    h.runtime.receiveUserMessage({ text: "back in the DM", threadId: dm.id, actor: OWNER });
    await h.runtime.drain();

    const [dmTurn, chanTurn, chanTurn2, dmTurn2] = h.calls;
    expect(dmTurn.resumeSessionId).toBeUndefined();
    expect(dmTurn.prompt).toContain("PIP doc for Bob");
    expect(dmTurn.prompt).toContain("You are replying in a Slack DM — private to alice.");
    // The channel thread never resumes the private session and never sees the DM's job or the handoff note.
    expect(chanTurn.resumeSessionId).toBeUndefined();
    expect(chanTurn.prompt).not.toContain("PIP doc");
    expect(chanTurn.systemPrompt).not.toContain("Bob's PIP");
    expect(chanTurn.prompt).toContain("Fix the team build");
    expect(chanTurn.prompt).toContain("You are replying in a Slack thread in #team — shared with other people");
    // It resumes its own session next time; the DM keeps the owner's session.
    expect(chanTurn2.resumeSessionId).toBe("sid-2");
    expect(dmTurn2.resumeSessionId).toBe("sid-1");
    expect(h.runtime.getState().claudeSessionId).toBe("sid-4");
  });

  test("a non-private thread whose session grew past the rotation size starts fresh, without a handoff", async () => {
    const h = harness({
      config: { rotateTokens: 100 },
      runner: async () => ({ ok: true, text: "reply", sessionId: "sid-chan", contextTokens: 500 }),
    });
    const { chan } = confidentialSetup(h);
    const epoch = getOrCreatePersonaState(h.store.db, OWNER).epoch;
    h.runtime.receiveUserMessage({ text: "one", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    h.runtime.receiveUserMessage({ text: "two", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    expect(h.calls.map((c) => c.prompt === HANDOFF_PROMPT)).toEqual([false, false]);
    expect(h.calls[1].resumeSessionId).toBeUndefined();
    expect(getOrCreatePersonaState(h.store.db, OWNER).epoch).toBe(epoch);
    // The fresh session is seeded with the thread's earlier messages, fenced.
    const history = h.calls[1].prompt.split(HISTORY_HEADING)[1]?.split("```")[1] ?? "";
    expect(history).toContain("] one");
    expect(history).toContain("· you] reply");
    expect(history).not.toContain("two");
    expect(h.calls[1].prompt).toMatch(/· alice · slack · msg [0-9a-f-]{36}\] two/);
    expect(h.calls[0].prompt).not.toContain(HISTORY_HEADING);
  });

  test("a resumed non-private session gets no history, and a fresh one at most the last 10 messages", async () => {
    let n = 0;
    const h = harness({
      config: { rotateTokens: 1_000_000 },
      runner: async () => ({ ok: true, text: `reply ${++n}`, sessionId: "sid-chan", contextTokens: 5 }),
    });
    const { chan } = confidentialSetup(h);
    for (let i = 1; i <= 7; i++) {
      h.runtime.receiveUserMessage({ text: `message ${i}`, threadId: chan.id, actor: OWNER });
      await h.runtime.drain();
    }
    expect(h.calls.slice(1).every((c) => c.resumeSessionId === "sid-chan" && !c.prompt.includes(HISTORY_HEADING))).toBe(true);
    setPersonaThreadSessionId(h.store.db, chan.id, null);
    h.runtime.receiveUserMessage({ text: "message 8", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    const lines = h.calls.at(-1)!.prompt.split(HISTORY_HEADING)[1]!.split("```")[1]!.replace(/^text\n/, "").trim().split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/· alice · msg [0-9a-f-]{36}\] message 3/);
    expect(lines.at(-1)).toContain("· you] reply 7");
  });

  test("reset forgets every per-thread session", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: "reply", sessionId: "sid-chan", contextTokens: 5 }) });
    const { chan } = confidentialSetup(h);
    h.runtime.receiveUserMessage({ text: "one", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    h.runtime.reset();
    h.runtime.receiveUserMessage({ text: "two", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    expect(h.calls[1].resumeSessionId).toBeUndefined();
  });

  test("a stale per-thread session is dropped and the turn retried fresh", async () => {
    const h = harness({
      runner: async (input) =>
        input.resumeSessionId
          ? { ok: false, error: "no conversation", sessionNotFound: true }
          : { ok: true, text: "reply", sessionId: "sid-new", contextTokens: 5 },
    });
    const { chan } = confidentialSetup(h);
    setPersonaThreadSessionId(h.store.db, chan.id, "sid-gone");
    h.runtime.receiveUserMessage({ text: "one", threadId: chan.id, actor: OWNER });
    await h.runtime.drain();
    expect(h.calls.map((c) => c.resumeSessionId)).toEqual(["sid-gone", undefined]);
    expect(getPersonaThreadSessionId(h.store.db, chan.id)).toBe("sid-new");
    expect(h.runtime.getState().claudeSessionId).toBeUndefined();
  });

  test("an approval result returns to the thread the approval was raised from, not its job's", async () => {
    const h = harness();
    const { dm, chan } = confidentialSetup(h);
    const chanJob = listPersonaJobs(h.store.db, OWNER).find((j) => j.threadId === chan.id)!;
    const approval = createPersonaApproval(h.store.db, {
      owner: OWNER,
      jobId: chanJob.id,
      threadId: dm.id,
      action: "remember",
      summary: "s",
      args: {},
    });
    h.runtime.deny(approval.id, OWNER, "no");
    const items = listPendingPersonaInbox(h.store.db, OWNER).filter((i) => i.kind === "approval_result");
    expect(items.map((i) => i.threadId)).toEqual([dm.id]);
  });
});

describe("persona runtime — asks it can no longer act on", () => {
  function ownedAsk(h: ReturnType<typeof harness>) {
    upsertProject(h.store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(h.store.db, { id: "L1", projectId: "p", task: "t", worktreePath: "/wt/L1", branch: "b" });
    createSession(h.store.db, { id: "S1", projectId: "p", title: "w", cwd: "/wt/L1", status: "running" });
    attachSessionToLaunch(h.store.db, "L1", "S1");
    const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: h.runtime.consoleThreadId(), title: "j", goal: "g" });
    linkPersonaJobLaunch(h.store.db, job.id, "L1", false);
    createLaunch(h.store.db, { id: "L2", projectId: "p", task: "t", worktreePath: "/wt/L2", branch: "b" });
    createSession(h.store.db, { id: "S2", projectId: "p", title: "mine", cwd: "/wt/L2", status: "running" });
    attachSessionToLaunch(h.store.db, "L2", "S2");
    const ask = createAsk(h.store.db, "S1", "ask_human", "Which DB?");
    createAsk(h.store.db, "S2", "ask_human", "not Persona's");
    return ask;
  }
  const reannounced = (h: ReturnType<typeof harness>) =>
    h.frames.filter((f) => f.type === "ask:new" && (f.payload as { personaHandled?: boolean }).personaHandled === false);

  test("pausing re-broadcasts Persona's pending asks unflagged, once", () => {
    const h = harness();
    const ask = ownedAsk(h);
    h.runtime.start();
    try {
      expect(reannounced(h)).toHaveLength(0);
      h.runtime.setPaused(true);
      expect(reannounced(h).map((f) => (f.payload as { id: string }).id)).toEqual([ask.id]);
      h.runtime.publishState();
      expect(reannounced(h)).toHaveLength(1);
      // Resuming announces nothing: Persona reads its pending asks from the snapshot.
      h.runtime.setPaused(false);
      expect(reannounced(h)).toHaveLength(1);
    } finally {
      h.runtime.stop();
    }
  });

  test("pausing leaves an ask on the owner's card to the card, and re-broadcasts the rest", () => {
    const h = harness();
    const ask = ownedAsk(h);
    const carded = createAsk(h.store.db, "S1", "ask_human", "Allow the owner-only call?");
    createPersonaApproval(h.store.db, { owner: OWNER, action: "answer_ask", summary: "s", args: { askId: carded.id, answer: "Allow once" } });
    h.runtime.start();
    try {
      h.runtime.setPaused(true);
      expect(reannounced(h).map((f) => (f.payload as { id: string }).id)).toEqual([ask.id]);
    } finally {
      h.runtime.stop();
    }
  });

  test("a failing turn re-broadcasts them, and the next turn's snapshot still lists the ask", async () => {
    let fail = true;
    const h = harness({
      runner: async () => (fail ? { ok: false, error: "claude exited 1" } : { ok: true, text: "ok", sessionId: "s", contextTokens: 1 }),
    });
    const ask = ownedAsk(h);
    h.runtime.start();
    try {
      h.runtime.receiveUserMessage({ text: "hi", actor: OWNER });
      await h.runtime.drain();
      expect(h.runtime.canAct()).toBe(false);
      expect(reannounced(h).map((f) => (f.payload as { id: string }).id)).toEqual([ask.id]);
      fail = false;
      h.advance(10 * 60_000);
      await h.runtime.drain();
      expect(h.calls.at(-1)!.prompt).toContain(`ask ${ask.id} (ask_human): "Which DB?"`);
    } finally {
      h.runtime.stop();
    }
  });

  test("stopping for shutdown does not re-broadcast them", () => {
    const h = harness();
    ownedAsk(h);
    h.runtime.start();
    h.runtime.stop();
    expect(reannounced(h)).toHaveLength(0);
  });

  test("an ask answered elsewhere before its turn is dropped, not relayed", async () => {
    const h = harness({ runner: async () => ({ ok: true, text: PERSONA_SILENT_REPLY, sessionId: "s" }) });
    const ask = ownedAsk(h);
    const answered = createAsk(h.store.db, "S1", "ask_human", "Which branch?");
    resolveAsk(h.store.db, answered.id, "main");
    const stale = h.runtime.enqueue("worker_event", { type: "ask", ask: { id: answered.id, kind: "ask_human", question: "Which branch?" } });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(0);
    expect(getPersonaInboxItem(h.store.db, stale.id)?.status).toBe("done");

    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: answered.id, kind: "ask_human", question: "Which branch?" } });
    h.runtime.enqueue("worker_event", { type: "ask", ask: { id: ask.id, kind: "ask_human", question: "Which DB?" } });
    await h.runtime.drain();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prompt).toContain("Which DB?");
    expect(h.calls[0].prompt).not.toContain('"Which branch?"');
  });

  test("Persona's own event router ignores the re-announcement", () => {
    const h = harness();
    const ask = ownedAsk(h);
    const listener = h.runtime.eventListener();
    listener({ type: "ask:new", payload: { ...ask, personaHandled: false }, timestamp: new Date().toISOString() });
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(0);
    listener({ type: "ask:new", payload: ask, timestamp: new Date().toISOString() });
    expect(listPendingPersonaInbox(h.store.db, OWNER)).toHaveLength(1);
  });
});
