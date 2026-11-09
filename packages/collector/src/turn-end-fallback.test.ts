import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createLaunch,
  createSession,
  createStore,
  getPendingAsksBySession,
  getSession,
  updateSessionStatus,
  upsertProject,
} from "@standup/store";
import { IDLE_NOTICE_GATE } from "./persona/policy.js";

/*
 * Auto-checkpoint always runs, and the turn-end classifier decides whether a
 * launched worker's idle notice needs the owner. When the classifier returns
 * nothing (no transcript, or the model call fails) the coarse rule still
 * applies: a launched session that goes idle needs you.
 */

import * as cli from "./claude-cli.js";
const realCli = { ...cli };
/**
 * The classifier's reply for the next turn end; null is a failed model call,
 * and a promise is a call still in flight until it settles.
 */
let classifierReply: string | null | Promise<string | null> = null;
let classifierCalls = 0;
const runClaudeText = mock(async (prompt: string) => {
  if (!prompt.includes("classify its state")) return null;
  classifierCalls++;
  return await classifierReply;
});
mock.module("./claude-cli.js", () => ({ ...realCli, runClaudeText }));
import * as push from "./push.js";
const realPush = { ...push };
mock.module("./push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("./claude-cli.js", () => realCli);
  mock.module("./push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer } = await import("./server.js");
const { turnEndJudged } = await import("./auto-checkpoint.js");

const settle = () => new Promise((r) => setTimeout(r, 20));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await settle();
  expect(check()).toBe(true);
}

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: [] });
  const app = createServer(store, () => {}, null);
  const root = mkdtempSync(join(tmpdir(), "turn-end-fallback-"));
  dirs.push(root);

  /** A launched session; with a transcript, the classifier has something to read. */
  const launchedSession = (withTranscript: boolean) => {
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
    const launch = createLaunch(store.db, { id: randomUUID(), projectId: "p", task: "fix it", worktreePath: root, branch: "b" });
    attachSessionToLaunch(store.db, launch.id, sessionId);
    const transcript = withTranscript ? join(root, `${sessionId}.jsonl`) : undefined;
    if (transcript) {
      const line = (role: string, uuid: string, text: string) =>
        JSON.stringify({ type: role, uuid, sessionId, timestamp: "2026-01-01T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
      writeFileSync(transcript, [line("user", "u1", "Fix the bug."), line("assistant", "a1", "Fixed and tested.")].join("\n") + "\n");
    }
    return { sessionId, transcript };
  };

  const hook = (sessionId: string, body: Record<string, unknown>) =>
    app.request("/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, cwd: root, ...body }),
    });

  /** A Stop hook, then waits until its turn-end classification has run. */
  const stop = async (session: { sessionId: string; transcript?: string }) => {
    const before = classifierCalls;
    expect((await hook(session.sessionId, { hook_event_name: "Stop", transcript_path: session.transcript })).status).toBe(200);
    if (session.transcript) await until(() => classifierCalls > before);
    await settle();
  };

  const idleNotice = (sessionId: string) =>
    hook(sessionId, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });

  const idleAsks = (sessionId: string) =>
    store.db
      .query("SELECT id FROM asks WHERE session_id = ? AND gate = ? AND status = 'pending'")
      .all(sessionId, IDLE_NOTICE_GATE) as Array<{ id: string }>;

  return { store, launchedSession, hook, stop, idleNotice, idleAsks };
}

describe("a launched session's idle notice when the classifier returns nothing", () => {
  test("with no transcript to read, the idle notice raises an ask and the session waits", async () => {
    const h = setUp();
    const session = h.launchedSession(false);
    await h.stop(session);
    expect(turnEndJudged(session.sessionId)).toBe(false);

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(1);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("waiting");
  });

  test("when the model call fails, the idle notice raises an ask and the session waits", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    classifierReply = null;
    await h.stop(session);
    expect(turnEndJudged(session.sessionId)).toBe(false);

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(1);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("waiting");
  });

  test("a session already done raises no ask, even with no verdict held in memory", async () => {
    const h = setUp();
    const session = h.launchedSession(false);
    await h.stop(session);
    updateSessionStatus(h.store.db, session.sessionId, "done");

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(0);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("done");
  });
});

describe("a launched session's idle notice while the classifier is still running", () => {
  test("the fallback ask is retired once the classifier judges the turn end done", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    let release!: (reply: string) => void;
    classifierReply = new Promise<string>((r) => (release = r));
    const before = classifierCalls;
    expect((await h.hook(session.sessionId, { hook_event_name: "Stop", transcript_path: session.transcript })).status).toBe(200);
    await until(() => classifierCalls > before);

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(1);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("waiting");

    release("DONE\nIt finished the fix.");
    await until(() => getSession(h.store.db, session.sessionId)?.status === "done");
    expect(h.idleAsks(session.sessionId)).toHaveLength(0);
  });

  test("a needs-you verdict that lands after a new prompt raises no ask on the new turn", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    let release!: (reply: string) => void;
    classifierReply = new Promise<string>((r) => (release = r));
    const before = classifierCalls;
    expect((await h.hook(session.sessionId, { hook_event_name: "Stop", transcript_path: session.transcript })).status).toBe(200);
    await until(() => classifierCalls > before);

    expect((await h.hook(session.sessionId, { hook_event_name: "UserPromptSubmit", prompt: "Now the docs." })).status).toBe(200);
    release("NEEDS_YOU\nIt asked which branch to use.");
    await settle();
    await settle();
    expect(getPendingAsksBySession(h.store.db, session.sessionId)).toHaveLength(0);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("running");
  });
});

describe("a launched session's idle notice when the classifier judged the turn end", () => {
  test("a turn end judged done raises no ask", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    classifierReply = "DONE\nIt finished the fix.";
    await h.stop(session);
    expect(turnEndJudged(session.sessionId)).toBe(true);

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(0);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("done");
  });

  test("a turn end judged idle raises no ask", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    classifierReply = "IDLE\nIt stopped mid-exchange.";
    await h.stop(session);
    expect(turnEndJudged(session.sessionId)).toBe(true);

    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(0);
    expect(getSession(h.store.db, session.sessionId)?.status).not.toBe("waiting");
  });

  test("a new turn end forgets the last verdict, so a failed classification falls back again", async () => {
    const h = setUp();
    const session = h.launchedSession(true);
    classifierReply = "DONE\nIt finished the fix.";
    await h.stop(session);
    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(0);

    classifierReply = null;
    await h.stop(session);
    expect(turnEndJudged(session.sessionId)).toBe(false);
    await h.idleNotice(session.sessionId);
    expect(h.idleAsks(session.sessionId)).toHaveLength(1);
    expect(getSession(h.store.db, session.sessionId)?.status).toBe("waiting");
  });
});
