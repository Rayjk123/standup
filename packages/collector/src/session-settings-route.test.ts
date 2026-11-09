import { expect, test, describe, mock, afterAll, beforeEach } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createLaunch,
  getLaunch,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { HarnessId, WsMessage } from "@standup/shared";

// The settings route types `/model` and `/effort` into the agent's pane, so
// stub sendToLaunch to record the keystrokes without touching real tmux.
// Snapshot the real module first so the mock can be lifted in afterAll —
// mock.module persists process-wide and would otherwise leak to later files.
import * as launcher from "./launcher.js";
const realLauncher = { ...launcher };

let sendResult: { ok: boolean; error?: string } = { ok: true };
const sendToLaunch = mock(async (_launch: unknown, _text: string) => sendResult);

mock.module("./launcher.js", () => ({
  ...realLauncher,
  sendToLaunch,
}));

afterAll(() => {
  mock.module("./launcher.js", () => realLauncher);
});

const { createServer } = await import("./server.js");

function setUp(opts: { harness?: HarnessId; launched?: boolean } = {}): {
  store: Store;
  app: ReturnType<typeof createServer>;
  broadcasts: WsMessage[];
} {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "S1",
    projectId: "p",
    title: "",
    cwd: "/tmp/S1",
    status: "idle",
  });
  if (opts.launched !== false) {
    createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      tmuxSession: "standup-S1",
      sessionId: "S1",
      status: "running",
      model: "sonnet",
      effort: "medium",
      harness: opts.harness,
    });
  }
  const broadcasts: WsMessage[] = [];
  return { store, app: createServer(store, (m) => broadcasts.push(m), null), broadcasts };
}

function post(app: ReturnType<typeof createServer>, body: unknown) {
  return app.request("/api/sessions/S1/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sendToLaunch.mockClear();
  sendResult = { ok: true };
});

describe("POST /api/sessions/:id/settings", () => {
  test("types /model and /effort into the pane and persists both", async () => {
    const { store, app, broadcasts } = setUp();

    const res = await post(app, { model: "claude-opus-4-8", effort: "max" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: "claude-opus-4-8", effort: "max" });

    expect(sendToLaunch.mock.calls.map((c) => c[1])).toEqual([
      "/model claude-opus-4-8",
      "/effort max",
    ]);
    const launch = getLaunch(store.db, "L1");
    expect(launch?.model).toBe("claude-opus-4-8");
    expect(launch?.effort).toBe("max");
    expect(
      broadcasts.some(
        (m) => m.type === "session:status" && (m.payload as { sessionId: string }).sessionId === "S1"
      )
    ).toBe(true);
    store.close();
  });

  test("an effort-only change leaves the stored model alone", async () => {
    const { store, app } = setUp();

    const res = await post(app, { effort: "high" });
    expect(res.status).toBe(200);
    expect(sendToLaunch.mock.calls.map((c) => c[1])).toEqual(["/effort high"]);
    expect(getLaunch(store.db, "L1")?.model).toBe("sonnet");
    expect(getLaunch(store.db, "L1")?.effort).toBe("high");
    store.close();
  });

  test("rejects an unknown model or effort without typing anything", async () => {
    const { store, app } = setUp();

    expect((await post(app, { model: "gpt-9" })).status).toBe(400);
    expect((await post(app, { effort: "ludicrous" })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect(sendToLaunch).not.toHaveBeenCalled();
    expect(getLaunch(store.db, "L1")?.model).toBe("sonnet");
    store.close();
  });

  test("refuses a session Standup didn't launch", async () => {
    const { store, app } = setUp({ launched: false });
    const res = await post(app, { model: "opus" });
    expect(res.status).toBe(409);
    expect(sendToLaunch).not.toHaveBeenCalled();
    store.close();
  });

  test("refuses a non-Claude harness", async () => {
    const { store, app } = setUp({ harness: "codex" });
    const res = await post(app, { effort: "high" });
    expect(res.status).toBe(409);
    expect(sendToLaunch).not.toHaveBeenCalled();
    store.close();
  });

  test("a dead pane fails with 409 and persists nothing", async () => {
    const { store, app } = setUp();
    sendResult = { ok: false, error: "tmux session is no longer running" };

    const res = await post(app, { model: "opus", effort: "low" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("tmux session is no longer running");
    expect(getLaunch(store.db, "L1")?.model).toBe("sonnet");
    expect(getLaunch(store.db, "L1")?.effort).toBe("medium");
    store.close();
  });
});
