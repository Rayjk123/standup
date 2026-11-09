import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  cancelAsk,
  createLaunch,
  createSession,
  createStore,
  getAsk,
  insertEvent,
  listPersonaApprovals,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { createPermissionAsk, noticeTarget } from "../held-call.js";
import { generateOwnerSecrets } from "../owner-secret.js";

/*
 * Persona's "allow once" on a tool-permission prompt, end to end through the
 * collector: a plainly read-only call (classified by Standup from the call the
 * worker's hook recorded) is answered in the pane with no owner card; a write,
 * an outward step, a secret read and a call that can't be told keep the card,
 * and nothing is typed for them.
 */

import * as launcher from "../launcher.js";
const realLauncher = { ...launcher };
const sendToLaunch = mock(async (_launch: unknown, _text: string) => ({ ok: true }));
/** What the worker's pane shows when the read-only answer is typed; null draws the dialog of the call the answer is for. */
let paneScreen: string | null = null;
const RULE = "─".repeat(60);
/** Claude Code's Bash permission dialog for `command`, under the transcript line that started it. */
const bashDialog = (command: string, description?: string) =>
  [
    `● Bash(${command.split("\n")[0]})`,
    RULE,
    " Bash command",
    ...command.split("\n").map((l) => `   ${l}`),
    ...(description ? [`   ${description}`] : []),
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for similar commands in /repo",
    "   3. No, and tell Claude what to do differently (esc)",
  ].join("\n");
/** Digits typed into the pane by the read-only path, and the dialogs they answered. */
const typedDigits: string[] = [];
const answerPermissionDialog = mock(async (_launch: unknown, digit: string, refusal: (screen: string) => string | null, _opts?: unknown) => {
  const why = refusal(paneScreen ?? "");
  if (why) return { ok: false, typed: false, error: why };
  typedDigits.push(digit);
  if (queuedDialogAfterTyping) return { ok: false, typed: true, error: "the dialog is still open after its option key; answer it in the terminal" };
  return { ok: true, typed: true };
});
/** A dialog with the same options opens behind the answered one, so the pane still reads as open. */
let queuedDialogAfterTyping = false;
mock.module("../launcher.js", () => ({ ...realLauncher, sendToLaunch, answerPermissionDialog }));
import * as push from "../push.js";
const realPush = { ...push };
mock.module("../push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("../launcher.js", () => realLauncher);
  mock.module("../push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer, resolveUserAlias } = await import("../server.js");
const { PersonaRuntime } = await import("./runtime.js");
const { PersonaFleet } = await import("./fleet.js");
const { createBroadcastTap } = await import("./events.js");
const { resolvePersonaConfig } = await import("./config.js");
const { PERSONA_TOKEN_HEADER } = await import("./routes.js");type LaunchFn = import("../server.js").LaunchFn;

const OWNER = resolveUserAlias(undefined);

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  const tap = createBroadcastTap(() => {});
  const secrets = generateOwnerSecrets();
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}) },
    broadcast: tap.broadcast,
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
    ownerToken: () => secrets.ownerToken,
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: () => runtime });
  tap.subscribe(fleet.eventListener());

  const root = realpathSync(mkdtempSync(join(tmpdir(), "perm-ro-api-")));
  dirs.push(root);
  writeFileSync(join(root, "PRODUCT.md"), "# Product\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.tsx"), 'export const A = () => <Button variant="primary" />;\n');

  const launchFn = (async (
    db: Store["db"],
    request: { project: { id: string }; task: string; label?: string; requester?: string; launchedBy?: string; idempotencyKey?: string }
  ) => {
    const id = randomUUID();
    const launch = createLaunch(db, {
      id,
      projectId: request.project.id,
      task: request.task,
      worktreePath: root,
      branch: request.label ?? "b",
      requester: request.requester,
      launchedBy: request.launchedBy,
      idempotencyKey: request.idempotencyKey,
    });
    return { launch, log: [] };
  }) as unknown as LaunchFn;
  const app = createServer(
    store,
    tap.broadcast,
    null,
    undefined,
    undefined,
    join(root, "kb"),
    "",
    {},
    undefined,
    undefined,
    launchFn,
    undefined,
    { fleet, ownerSecrets: secrets },
    {},
    { stopLaunch: async () => ({ ok: true, log: [] }), paneAlive: () => false }
  );

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name, arguments: args }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content.map((c) => c.text).join("");
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!result.isError, text, json };
  };

  /** A Persona worker whose session has started. */
  const ownedSession = async () => {
    const launched = await tool("launch_session", { task: `scan the UI, number ${randomUUID().slice(0, 4)}`, projectId: "p" });
    expect(launched.isError ? launched.text : "").toBe("");
    const launchId = launched.json!.launchId as string;
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
    attachSessionToLaunch(store.db, launchId, sessionId);
    return { launchId, sessionId };
  };

  let seq = 0;
  /** A background subagent's call in flight and the permission ask its dialog raised. */
  const prompt = (sessionId: string, toolName: string, toolInput: Record<string, unknown>) => {
    insertEvent(store.db, sessionId, "PreToolUse", { tool_use_id: `toolu_${++seq}`, agent_id: "agent-a", tool_name: toolName, tool_input: toolInput, cwd: root });
    paneScreen =
      toolName === "Bash"
        ? bashDialog(String(toolInput.command), typeof toolInput.description === "string" ? toolInput.description : undefined)
        : [RULE, ` ${toolName === "Read" ? "Read file" : toolName}`, `   ${String(toolInput.file_path ?? toolInput.path ?? toolInput.pattern)}`, " Do you want to proceed?", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently (esc)"].join("\n");
    return createPermissionAsk(store.db, sessionId, "Claude needs your permission", noticeTarget(store.db, sessionId));
  };
  /** The call `toolu_<n>` finished. */
  const finish = (sessionId: string, n: number) =>
    insertEvent(store.db, sessionId, "PostToolUse", { tool_use_id: `toolu_${n}`, agent_id: "agent-a", tool_name: "Bash", tool_input: {} });
  const resolve = (askId: string, answer: string) =>
    app.request(`/api/asks/${askId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ answer }),
    });
  const seqNow = () => seq;
  const pendingCards = () => listPersonaApprovals(store.db, OWNER, "pending").filter((a) => a.action === "answer_ask");
  /** A Slack channel thread, which other people read. */
  const sharedThread = async () => {
    const res = await app.request("/api/persona/threads", {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken },
      body: JSON.stringify({ channel: "slack", externalRef: `CTEAM:${randomUUID().slice(0, 6)}` }),
    });
    const thread = ((await res.json()) as { thread: { id: string; audience: string } }).thread;
    expect(thread.audience).toBe("shared");
    return thread.id;
  };
  /** Runs one turn in `threadId` with `body` as its tool calls. */
  const turn = async (threadId: string, body: () => Promise<void>) => {
    const r = runtime as unknown as { turnRunner: () => Promise<unknown> };
    r.turnRunner = async () => {
      await body();
      return { ok: true, text: "[silent]", sessionId: `sid-${threadId}` };
    };
    runtime.receiveUserMessage({ text: "go on", threadId, actor: OWNER });
    await runtime.drain();
  };
  return { store, app, token: runtime.token, tool, ownedSession, prompt, finish, resolve, seqNow, pendingCards, root, sharedThread, turn };
}

describe("Persona's allow once on a tool-permission prompt", () => {
  test("a plainly read-only call is answered in the pane with no owner card", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const command = `bash -c '\necho "== primary count"; grep -c "variant=\\"primary\\"" src/*.tsx; true'`;
    const ask = h.prompt(sessionId, "Bash", { command, description: "scan" });
    sendToLaunch.mockClear();
    typedDigits.length = 0;
    const res = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
    expect(res).toMatchObject({ isError: false, text: "answered" });
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "1" });
    // Only the digit, through the dialog check; no text-and-Enter send.
    expect(typedDigits).toEqual(["1"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
    expect(h.pendingCards()).toHaveLength(0);
  });

  test("a cat of a doc and a Read are answered with no card", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const cat = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    expect((await h.tool("answer_ask", { askId: cat.id, answer: "1" })).text).toBe("answered");
    insertEvent(h.store.db, sessionId, "PostToolUse", { tool_use_id: "toolu_1", agent_id: "agent-a", tool_name: "Bash", tool_input: {} });
    const read = h.prompt(sessionId, "Read", { file_path: join(h.root, "PRODUCT.md") });
    expect((await h.tool("answer_ask", { askId: read.id, answer: "1" })).text).toBe("answered");
    expect(h.pendingCards()).toHaveLength(0);
  });

  test("a sed | tr | grep pipeline over the worktree's build report is answered with no card", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const command = "sed -e 's/<[^>]*>/ /g' build/unit-tests/index.html | tr -s ' \\n' ' ' | grep -o -E 'Tests run: [0-9]+|Failures: [0-9]+'";
    const ask = h.prompt(sessionId, "Bash", { command, description: "Read unit test totals" });
    typedDigits.length = 0;
    expect((await h.tool("answer_ask", { askId: ask.id, answer: "1" })).text).toBe("answered");
    expect(typedDigits).toEqual(["1"]);
    expect(h.pendingCards()).toHaveLength(0);
  });

  const carded: Array<[string, string, Record<string, unknown>]> = [
    ["a sed script that writes", "Bash", { command: "sed 's/<[^>]*>/ /gw out.txt' build/unit-tests/index.html" }],
    ["a path assembled at run time", "Bash", { command: "a=/pr; b=oc; cat $a$b/1/environ" }],
    ["a path from a command substitution", "Bash", { command: 'cat "$(echo /proc/1/environ)"' }],
    ["a write", "Bash", { command: "echo x > notes.txt" }],
    ["an outward step", "Bash", { command: "git push origin HEAD" }],
    ["a secret read", "Bash", { command: `cat ${join(homedir(), ".ssh", "id_ed25519")}` }],
    ["a file write tool", "Write", { file_path: "notes.txt", content: "x" }],
  ];
  for (const [name, toolName, input] of carded) {
    test(`keeps the owner card: ${name}`, async () => {
      const h = setUp();
      const { sessionId } = await h.ownedSession();
      const ask = h.prompt(sessionId, toolName, input);
      sendToLaunch.mockClear();
      const held = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
      expect(held.json).toMatchObject({ status: "pending_approval" });
      expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
      expect(sendToLaunch).not.toHaveBeenCalled();
      expect(h.pendingCards()).toHaveLength(1);
    });
  }

  test("keeps the owner card: a dialog that could be for either of two calls", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_a", agent_id: "a", tool_name: "Bash", tool_input: { command: "cat PRODUCT.md" }, cwd: h.root });
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_b", agent_id: "b", tool_name: "Bash", tool_input: { command: "cat src/a.tsx" }, cwd: h.root });
    const ask = createPermissionAsk(h.store.db, sessionId, "Claude needs your permission", noticeTarget(h.store.db, sessionId));
    sendToLaunch.mockClear();
    const held = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(sendToLaunch).not.toHaveBeenCalled();
  });

  test("a deny of any call is typed in the pane with no owner card; its allow stays held", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const command = "W=$(pwd); P=$(mktemp -d -p /tmp parentXXXX); git archive HEAD | tar -x -C $P; for d in packages/*/node_modules; do rm -rf $P/$d; ln -s $W/$d $P/$d; done";
    const ask = h.prompt(sessionId, "Bash", { command });
    sendToLaunch.mockClear();
    typedDigits.length = 0;
    const held = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(h.pendingCards()).toHaveLength(1);
    const denied = await h.tool("answer_ask", { askId: ask.id, answer: "3" });
    expect(denied).toMatchObject({ isError: false, text: "answered" });
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "3" });
    expect(typedDigits).toEqual(["3"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
  });

  test("a deny is typed only once the pane shows its call's dialog with a No at that digit", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const ask = h.prompt(sessionId, "Bash", { command: "rm -rf b" });
    sendToLaunch.mockClear();
    typedDigits.length = 0;
    for (const screen of [
      [RULE, " Bash command", "   rm -rf b", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again"].join("\n"),
      bashDialog("rm -rf c"),
    ]) {
      paneScreen = screen;
      expect((await h.resolve(ask.id, "3")).status).toBe(409);
      expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    }
    expect(typedDigits).toEqual([]);
    paneScreen = bashDialog("rm -rf b");
    expect((await h.resolve(ask.id, "3")).status).toBe(200);
    expect(typedDigits).toEqual(["3"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
  });

  test("keeps the owner card: a deny that can't be told is for the open dialog", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    // Either of two calls, and an Edit (whose dialog isn't read) beside another call.
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_a", agent_id: "a", tool_name: "Bash", tool_input: { command: "rm -rf a" }, cwd: h.root });
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_b", agent_id: "b", tool_name: "Bash", tool_input: { command: "rm -rf b" }, cwd: h.root });
    const either = createPermissionAsk(h.store.db, sessionId, "Claude needs your permission", noticeTarget(h.store.db, sessionId));
    paneScreen = bashDialog("rm -rf b");
    typedDigits.length = 0;
    expect((await h.resolve(either.id, "3")).status).toBe(403);
    expect((await h.tool("answer_ask", { askId: either.id, answer: "3" })).json).toMatchObject({ status: "pending_approval" });
    const edit = h.prompt(sessionId, "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" });
    paneScreen = bashDialog("rm -rf b");
    expect((await h.resolve(edit.id, "3")).status).toBe(403);
    expect(typedDigits).toEqual([]);
  });

  test("a typed deny with a queued dialog opening behind it stays answered, never back to pending", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const ask = h.prompt(sessionId, "Edit", { file_path: "a.ts", old_string: "a", new_string: "b" });
    paneScreen = [RULE, " Edit file", "   a.ts", " Do you want to make this edit to a.ts?", " ❯ 1. Yes", "   2. Yes, allow all edits during this session", "   3. No"].join("\n");
    typedDigits.length = 0;
    queuedDialogAfterTyping = true;
    try {
      expect((await h.resolve(ask.id, "3")).status).toBe(200);
    } finally {
      queuedDialogAfterTyping = false;
    }
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "3" });
    expect(typedDigits).toEqual(["3"]);
  });

  test("the collector classifies the call itself: Persona's token answers only a read-only call's allow once", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const resolve = h.resolve;
    sendToLaunch.mockClear();
    typedDigits.length = 0;
    const write = h.prompt(sessionId, "Bash", { command: "rm -rf build" });
    expect((await resolve(write.id, "1")).status).toBe(403);
    expect(getAsk(h.store.db, write.id)!.status).toBe("pending");
    insertEvent(h.store.db, sessionId, "PostToolUse", { tool_use_id: "toolu_1", agent_id: "agent-a", tool_name: "Bash", tool_input: {} });
    const read = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    expect((await resolve(read.id, "2")).status).toBe(403);
    expect((await resolve(read.id, "1")).status).toBe(200);
    expect(getAsk(h.store.db, read.id)).toMatchObject({ status: "answered", answer: "1" });
    expect(typedDigits).toEqual(["1"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
  });
});

describe("Persona's read-only allow once at answer time", () => {
  const reset = () => {
    sendToLaunch.mockClear();
    answerPermissionDialog.mockClear();
    typedDigits.length = 0;
  };

  test("a second call started after the ask keeps the card at answer time, and the resolve route refuses Persona's token", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const ask = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    // A background subagent starts call B; its dialog would queue behind A's.
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_b", agent_id: "agent-b", tool_name: "Bash", tool_input: { command: "cat src/a.tsx" }, cwd: h.root });
    reset();
    expect((await h.resolve(ask.id, "1")).status).toBe(403);
    const held = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    expect(answerPermissionDialog).not.toHaveBeenCalled();
    expect(sendToLaunch).not.toHaveBeenCalled();
  });

  test("a subagent running alongside a main-thread call keeps the card", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_agent", tool_name: "Agent", tool_input: { prompt: "scan" }, cwd: h.root });
    insertEvent(h.store.db, sessionId, "PreToolUse", { tool_use_id: "toolu_main", tool_name: "Bash", tool_input: { command: "cat PRODUCT.md" }, cwd: h.root });
    const ask = createPermissionAsk(h.store.db, sessionId, "Claude needs your permission", noticeTarget(h.store.db, sessionId));
    paneScreen = bashDialog("cat PRODUCT.md");
    reset();
    expect((await h.resolve(ask.id, "1")).status).toBe(403);
    expect(typedDigits).toEqual([]);
  });

  test("the pane showing another call's dialog types nothing and leaves the prompt pending", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const ask = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    reset();
    for (const screen of [
      bashDialog("cat PRODUCT.md; rm -rf build"),
      bashDialog("rm -rf build"),
      [RULE, " Bash command", "   cat PRODUCT.md", " Do you want to proceed?", " ❯ 1. Yes, and don't ask again for cat commands", "   2. No"].join("\n"),
      [RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n"),
      "",
    ]) {
      paneScreen = screen;
      const res = await h.resolve(ask.id, "1");
      expect(res.status).toBe(409);
      expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    }
    expect(typedDigits).toEqual([]);
    expect(sendToLaunch).not.toHaveBeenCalled();
    paneScreen = bashDialog("cat PRODUCT.md");
    expect((await h.resolve(ask.id, "1")).status).toBe(200);
    expect(typedDigits).toEqual(["1"]);
  });

  test("an allow once asked for from a thread other people read keeps the card", async () => {
    const h = setUp();
    const threadId = await h.sharedThread();
    let launched: Awaited<ReturnType<typeof h.tool>> | undefined;
    await h.turn(threadId, async () => {
      launched = await h.tool("launch_session", { task: "scan the UI for the team", projectId: "p" });
    });
    const launchId = launched!.json!.launchId as string;
    const sessionId = randomUUID();
    createSession(h.store.db, { id: sessionId, projectId: "p", title: "worker", cwd: h.root, status: "running" });
    attachSessionToLaunch(h.store.db, launchId, sessionId);
    const ask = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    reset();
    let held: Awaited<ReturnType<typeof h.tool>> | undefined;
    await h.turn(threadId, async () => {
      held = await h.tool("answer_ask", { askId: ask.id, answer: "1" });
    });
    expect(held!.json).toMatchObject({ status: "pending_approval" });
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    expect(typedDigits).toEqual([]);
    expect(h.pendingCards()).toHaveLength(1);
  });

  test("an answered or cancelled prompt whose call still runs is not answered again with Persona's token", async () => {
    const h = setUp();
    const { sessionId } = await h.ownedSession();
    const ask = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    reset();
    expect((await h.resolve(ask.id, "1")).status).toBe(200);
    expect((await h.resolve(ask.id, "1")).status).toBe(403);
    const dismissed = h.prompt(sessionId, "Bash", { command: "cat PRODUCT.md" });
    h.finish(sessionId, h.seqNow() - 1);
    cancelAsk(h.store.db, dismissed.id);
    expect((await h.resolve(dismissed.id, "1")).status).toBe(403);
    expect(typedDigits).toEqual(["1"]);
    expect(sendToLaunch).not.toHaveBeenCalled();
  });
});
