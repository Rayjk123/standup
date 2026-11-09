import { expect, test, describe } from "bun:test";
import { createStore, upsertProject, createSession, insertEvent, createAsk } from "@standup/store";
import type { Ask } from "@standup/shared";
import { createServer, pendingAskUserQuestion } from "./server.js";
import { IDLE_NOTICE_GATE } from "./persona/policy.js";

/**
 * The pending-AskUserQuestion scan (findPendingToolEvent, exercised through
 * pendingAskUserQuestion). The block that surfaces an AskUserQuestion is a
 * Notification recorded *after* the tool's PreToolUse, so the live-DB ordering
 * is PreToolUse → Notification and the pending modal must still be found by
 * scanning back — not by reading the single latest event.
 */

function scratchStore() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  createSession(store.db, {
    id: "s",
    projectId: "p",
    title: "t",
    cwd: "/tmp",
    parentSessionId: undefined,
    status: "running",
  });
  return store;
}

const askUserQuestion = {
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [{ question: "Which?", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
  },
};

describe("pendingAskUserQuestion — scanning back past the block", () => {
  test("an AskUserQuestion PreToolUse followed by a blocking Notification still resolves", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", askUserQuestion);
    // The permission_prompt Notification lands after the tool call — the exact
    // live ordering that left the newest event as the Notification.
    insertEvent(store.db, "s", "Notification", { message: "permission_prompt" });

    const questions = pendingAskUserQuestion(store, "s");
    expect(questions).not.toBeNull();
    expect(questions?.[0]?.header).toBe("Choice");
    store.close();
  });

  test("the AskUserQuestion's own PostToolUse does not stop the scan", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", askUserQuestion);
    insertEvent(store.db, "s", "Notification", { message: "permission_prompt" });
    insertEvent(store.db, "s", "PostToolUse", askUserQuestion);

    expect(pendingAskUserQuestion(store, "s")).not.toBeNull();
    store.close();
  });

  test("a UserPromptSubmit after the AskUserQuestion makes it stale (null)", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", askUserQuestion);
    // A new turn began — any earlier AskUserQuestion was already answered.
    insertEvent(store.db, "s", "UserPromptSubmit", { prompt: "next" });

    expect(pendingAskUserQuestion(store, "s")).toBeNull();
    store.close();
  });

  test("a Stop after the AskUserQuestion makes it stale (null)", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", askUserQuestion);
    insertEvent(store.db, "s", "Stop", {});

    expect(pendingAskUserQuestion(store, "s")).toBeNull();
    store.close();
  });

  test("the latest event being the AskUserQuestion PreToolUse still resolves", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", askUserQuestion);

    expect(pendingAskUserQuestion(store, "s")).not.toBeNull();
    store.close();
  });

  test("a non-AskUserQuestion pending tool returns null", () => {
    const store = scratchStore();
    insertEvent(store.db, "s", "PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    insertEvent(store.db, "s", "Notification", { message: "permission_prompt" });

    expect(pendingAskUserQuestion(store, "s")).toBeNull();
    store.close();
  });
});

describe("GET /api/sessions/:id/pending-ask", () => {
  async function read(store: ReturnType<typeof scratchStore>) {
    const res = await createServer(store, () => {}, null).request("/api/sessions/s/pending-ask");
    expect(res.status).toBe(200);
    return (await res.json()) as { ask: Ask | null; questions: unknown };
  }

  test("a pending ask_human (a floor hold included) is the session's pending ask", async () => {
    const store = scratchStore();
    const hold = createAsk(store.db, "s", "ask_human", "Safety floor held a Bash call (outward): git push", ["Allow once", "Deny"], {
      gate: "safety_floor",
    });
    const body = await read(store);
    expect(body.ask?.id).toBe(hold.id);
    expect(body.questions).toBeNull();
    store.close();
  });

  test("a prompt-ask comes first, since the pane is blocked on it", async () => {
    const store = scratchStore();
    createAsk(store.db, "s", "ask_human", "Which branch?");
    const prompt = createAsk(store.db, "s", "permission_prompt", "Claude needs your permission");
    expect((await read(store)).ask?.id).toBe(prompt.id);
    store.close();
  });

  test("an idle notice never hides a real question behind it", async () => {
    const store = scratchStore();
    createAsk(store.db, "s", "permission_prompt", "Agent stopped and may need you", undefined, { gate: IDLE_NOTICE_GATE });
    const hold = createAsk(store.db, "s", "ask_human", "Safety floor held a Bash call (outward): git push", ["Allow once", "Deny"], {
      gate: "safety_floor",
    });
    expect((await read(store)).ask?.id).toBe(hold.id);
    store.close();
  });

  test("no pending ask reads as null", async () => {
    const store = scratchStore();
    expect(await read(store)).toEqual({ ask: null, questions: null });
    store.close();
  });
});
