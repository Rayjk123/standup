import { describe, expect, test } from "bun:test";
import {
  createAsk,
  createLaunch,
  createSession,
  createSteer,
  createStore,
  getLaunch,
  getPendingSteers,
  getRecentEventsBySession,
  getSession,
  insertEvent,
  upsertProject,
} from "@standup/store";
import type { Launch, WsMessage } from "@standup/shared";
import { createServer, pendingAskUserQuestion } from "./server.js";
import {
  classifyClaudePane,
  recoverSession,
  resyncStaleRunningSessions,
  settleAfterInterrupt,
  WAKE_PROMPT,
  type PaneDriver,
} from "./session-recovery.js";

const RULE = "─".repeat(80);
const FOOTER = ["  Opus 5.5 (1M context) | Context: 21%", "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"];

const IDLE = [
  "● Write(packages/web/bunfig.toml)",
  "  ⎿  User rejected write to packages/web/bunfig.toml",
  RULE,
  "❯ ",
  RULE,
  ...FOOTER,
].join("\n");

const INTERRUPTED = [
  "● Bash(bun test)",
  "  ⎿  Interrupted · What should Claude do instead?",
  "  [Request interrupted by user for tool use]",
  RULE,
  "❯ ",
  RULE,
  ...FOOTER,
].join("\n");

const BUSY = [
  "● Update(packages/collector/src/floor/classify.ts)",
  "  ⎿  Added 1 line, removed 1 line",
  "✽ Doodling… (12m 25s · ↓ 15.4k tokens)",
  RULE,
  "❯ ",
  RULE,
  ...FOOTER,
].join("\n");

const PERMISSION = [
  "● Bash(git push origin main)",
  RULE,
  " Bash command",
  "   git push origin main",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for git push commands",
  "   3. No, and tell Claude what to do differently (esc)",
].join("\n");

const QUESTION = [
  "☐ Approach",
  "Which storage should the cache use?",
  "❯ 1. SQLite",
  "  2. In memory",
  "  3. Type something.",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

// The rewind picker a stray double-Esc opens: a menu with no input box.
const REWIND = [
  "Rewind",
  "Restore the conversation to the point before…",
  "❯ 1. add the resync sweep",
  "  2. fix the classifier",
  "Enter to continue · Esc to exit",
].join("\n");

describe("classifyClaudePane", () => {
  test("an empty prompt under a rule is idle", () => {
    expect(classifyClaudePane(IDLE)).toEqual({ kind: "idle", composer: "", interrupted: false });
  });
  test("an interrupted turn back at its prompt is idle and marked interrupted", () => {
    expect(classifyClaudePane(INTERRUPTED)).toEqual({ kind: "idle", composer: "", interrupted: true });
  });
  test("the working spinner above the prompt is busy", () => {
    expect(classifyClaudePane(BUSY).kind).toBe("busy");
  });
  test("the spinner is found above the input box when a subagent panel fills the bottom", () => {
    const panel = Array.from({ length: 12 }, (_, i) => `  ◯ general-purpose  Reading file ${i}…  ${i + 30}s · ↓ 50k tokens`);
    const screen = ["· Herding… (5m 51s · ↓ 16.3k tokens)", RULE, "❯ ", RULE, ...FOOTER, "  ● main", ...panel].join("\n");
    expect(classifyClaudePane(screen).kind).toBe("busy");
    const idle = [RULE, "❯ ", RULE, ...FOOTER, "  ● main", ...panel].join("\n");
    expect(classifyClaudePane(idle).kind).toBe("idle");
  });
  test("a tool-permission dialog is recognized as one", () => {
    expect(classifyClaudePane(PERMISSION).kind).toBe("permission");
  });
  test("an AskUserQuestion modal is a question", () => {
    expect(classifyClaudePane(QUESTION).kind).toBe("question");
  });
  test("a menu with no input box and no Yes option is a dismissable dialog", () => {
    expect(classifyClaudePane(REWIND).kind).toBe("dialog");
  });
  test("a worker's own question above an idle prompt is not a permission dialog", () => {
    const screen = ["● Done. Do you want to proceed with the merge?", RULE, "❯ ", RULE, ...FOOTER].join("\n");
    expect(classifyClaudePane(screen).kind).toBe("idle");
  });
  test("placeholder text in the input box reads as empty; typed text is kept", () => {
    expect(classifyClaudePane([RULE, '❯ Try "fix lint errors"', RULE].join("\n"))).toMatchObject({ composer: "" });
    expect(classifyClaudePane([RULE, "❯ half a message", RULE].join("\n"))).toMatchObject({ composer: "half a message" });
  });
  test("an empty screen is unknown", () => {
    expect(classifyClaudePane("\n\n").kind).toBe("unknown");
  });
});

/** A scripted pane: each capture returns the current screen; keys and typed text are recorded. */
function fakePane(screens: string[], onType?: (text: string) => Promise<void>) {
  const keys: string[] = [];
  const typed: string[] = [];
  let i = 0;
  const pane: PaneDriver = {
    exists: () => true,
    capture: () => screens[Math.min(i, screens.length - 1)]!,
    sendKey: (_s, key) => {
      keys.push(key);
      i++;
      return true;
    },
    type: async (_l, text) => {
      typed.push(text);
      await onType?.(text);
      return { ok: true };
    },
    sleep: async () => {
      i++;
    },
  };
  return { pane, keys, typed, advance: () => i++ };
}

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, { id: "s1", projectId: "p", title: "worker", cwd: "/tmp/s1", status: "running" });
  createLaunch(store.db, {
    id: "l1",
    projectId: "p",
    task: "t",
    worktreePath: "/tmp/s1",
    branch: "b",
    tmuxSession: "tmux-s1",
    sessionId: "s1",
    status: "running",
  });
  const broadcasts: WsMessage[] = [];
  const launch = getLaunch(store.db, "l1") as Launch;
  // A turn cut off mid-tool: a PreToolUse with no PostToolUse and no Stop after it.
  insertEvent(store.db, "s1", "UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "go" });
  insertEvent(store.db, "s1", "PreToolUse", {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "which?", options: [{ label: "a" }] }] },
  });
  return { store, launch, broadcasts, broadcast: (m: WsMessage) => broadcasts.push(m) };
}

/** Plays Claude Code's part when the wake line is typed: its UserPromptSubmit hook. */
function hookOnType(app: ReturnType<typeof createServer>, contexts: string[]) {
  return async (text: string) => {
    const res = await app.request("/hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", cwd: "/tmp/s1", hook_event_name: "UserPromptSubmit", prompt: text }),
    });
    const json = (await res.json()) as { hookSpecificOutput?: { additionalContext?: string } };
    contexts.push(json.hookSpecificOutput?.additionalContext ?? "");
  };
}

describe("settling after an interrupt", () => {
  test("the session settles idle once the pane returns to its prompt, and the cut-off tool no longer reads as in flight", async () => {
    const h = setUp();
    expect(pendingAskUserQuestion(h.store, "s1")).not.toBeNull();
    // Still drawing the interrupt for one poll, then at the prompt.
    const { pane, typed } = fakePane([BUSY, INTERRUPTED]);
    const settled = await settleAfterInterrupt({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch, { pollMs: 1 });
    expect(settled).toEqual({ delivered: 0 });
    expect(getSession(h.store.db, "s1")!.status).toBe("idle");
    expect(h.broadcasts).toContainEqual(expect.objectContaining({ type: "session:status", payload: { sessionId: "s1", status: "idle" } }));
    const last = getRecentEventsBySession(h.store.db, "s1", 1)[0]!;
    expect(last.type).toBe("Stop");
    expect(last.payload).toMatchObject({ standup_settled: "interrupted" });
    expect(pendingAskUserQuestion(h.store, "s1")).toBeNull();
    // Nothing queued, so nothing typed.
    expect(typed).toEqual([]);
  });

  test("a pane that never comes back to its prompt keeps its status", async () => {
    const h = setUp();
    const { pane } = fakePane([PERMISSION]);
    const settled = await settleAfterInterrupt({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch, {
      timeoutMs: 20,
      pollMs: 1,
    });
    expect(settled).toBeNull();
    expect(getSession(h.store.db, "s1")!.status).toBe("running");
  });

  test("queued next_turn steers are delivered once the interrupted worker settles", async () => {
    const h = setUp();
    const app = createServer(h.store, h.broadcast, null);
    createSteer(h.store.db, "s1", "switch to the smaller fix");
    const contexts: string[] = [];
    const { pane, typed } = fakePane([INTERRUPTED], hookOnType(app, contexts));
    const settled = await settleAfterInterrupt({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch, { pollMs: 1 });
    expect(settled).toEqual({ delivered: 1 });
    expect(typed).toEqual([WAKE_PROMPT]);
    expect(contexts[0]).toContain("switch to the smaller fix");
    expect(getPendingSteers(h.store.db, "s1")).toHaveLength(0);
    expect(getSession(h.store.db, "s1")!.status).toBe("running");
  });
});

describe("resync of stale running sessions", () => {
  const later = () => Date.now() + 10 * 60_000;

  test("a silent running session whose pane shows the idle prompt is settled idle", async () => {
    const h = setUp();
    const { pane } = fakePane([IDLE]);
    const settled = await resyncStaleRunningSessions({ db: h.store.db, broadcast: h.broadcast, pane }, { staleMs: 60_000, now: later() });
    expect(settled).toEqual(["s1"]);
    expect(getSession(h.store.db, "s1")!.status).toBe("idle");
    expect(getRecentEventsBySession(h.store.db, "s1", 1)[0]!.payload).toMatchObject({ standup_settled: "resynced" });
  });

  test("a session that is still active, busy, or waiting on an ask is left alone", async () => {
    const h = setUp();
    const deps = (screen: string) => ({ db: h.store.db, broadcast: h.broadcast, pane: fakePane([screen]).pane });
    // Recent activity: not stale yet.
    expect(await resyncStaleRunningSessions(deps(IDLE), { staleMs: 60_000, now: Date.now() })).toEqual([]);
    // Spinner up: genuinely working.
    expect(await resyncStaleRunningSessions(deps(BUSY), { staleMs: 60_000, now: later() })).toEqual([]);
    // A pending ask: the ask flow owns it.
    createAsk(h.store.db, "s1", "ask_human", "which?");
    expect(await resyncStaleRunningSessions(deps(IDLE), { staleMs: 60_000, now: later() })).toEqual([]);
    expect(getSession(h.store.db, "s1")!.status).toBe("running");
  });
});

describe("recoverSession", () => {
  test("a non-permission dialog is closed with Escape, then the idle prompt settles", async () => {
    const h = setUp();
    const { pane, keys } = fakePane([REWIND, IDLE]);
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch);
    expect(keys).toEqual(["Escape"]);
    expect(result).toMatchObject({ state: "idle", status: "idle", keys: ["Escape"] });
    expect(getSession(h.store.db, "s1")!.status).toBe("idle");
  });

  test("a permission dialog is never typed into", async () => {
    const h = setUp();
    const { pane, keys, typed } = fakePane([PERMISSION]);
    createSteer(h.store.db, "s1", "carry on");
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch);
    expect(result).toMatchObject({ state: "permission", status: "waiting", delivered: 0 });
    expect(keys).toEqual([]);
    expect(typed).toEqual([]);
    expect(getPendingSteers(h.store.db, "s1")).toHaveLength(1);
  });

  test("a pending safety-floor ask leaves the pane untouched", async () => {
    const h = setUp();
    const ask = createAsk(h.store.db, "s1", "ask_human", "Allow `git push`?", ["Allow once", "Deny"], { gate: "safety_floor_owner" });
    const { pane, keys, typed } = fakePane([REWIND]);
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch);
    expect(result.detail).toContain(ask.id);
    expect(result.status).toBe("waiting");
    expect(keys).toEqual([]);
    expect(typed).toEqual([]);
  });

  test("a mid-turn worker is reported busy and nothing is sent", async () => {
    const h = setUp();
    const { pane, keys } = fakePane([BUSY]);
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch);
    expect(result).toMatchObject({ state: "busy", status: "running" });
    expect(keys).toEqual([]);
  });

  test("after recovery the queued next_turn messages reach the worker", async () => {
    const h = setUp();
    const app = createServer(h.store, h.broadcast, null);
    createSteer(h.store.db, "s1", "rebase before you continue");
    createSteer(h.store.db, "s1", "then rerun the suite");
    const contexts: string[] = [];
    const { pane, keys, typed } = fakePane([REWIND, INTERRUPTED], hookOnType(app, contexts));
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane }, "s1", h.launch);
    expect(keys).toEqual(["Escape"]);
    expect(typed).toEqual([WAKE_PROMPT]);
    expect(result.delivered).toBe(2);
    expect(contexts[0]).toContain("rebase before you continue");
    expect(contexts[0]).toContain("then rerun the suite");
    expect(getPendingSteers(h.store.db, "s1")).toHaveLength(0);
    expect(getSession(h.store.db, "s1")!.status).toBe("running");
  });

  test("a gone pane is reported, not acted on", async () => {
    const h = setUp();
    const { pane } = fakePane([IDLE]);
    const result = await recoverSession({ db: h.store.db, broadcast: h.broadcast, pane: { ...pane, exists: () => false } }, "s1", h.launch);
    expect(result.state).toBe("gone");
    expect(getSession(h.store.db, "s1")!.status).toBe("running");
  });
});
