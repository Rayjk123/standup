import { expect, test, describe, mock, afterAll } from "bun:test";
import {
  createStore,
  upsertProject,
  createSession,
  createAsk,
  getAsk,
  createLaunch,
} from "@standup/store";
import type { Store } from "@standup/store";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "./owner-secret.js";

// The override path drives the agent's pane (Escape, wait, type), so stub the
// three launcher primitives to record the drive without touching real tmux.
// Snapshot the real module first so the mock can be lifted in afterAll —
// mock.module persists process-wide and would otherwise leak to later files.
import * as launcher from "./launcher.js";
const realLauncher = { ...launcher };

const interruptLaunch = mock(async (_launch: unknown) => {});
const waitForClaudePromptReady = mock(async (_session: string) => true);
const sendToLaunch = mock(async (_launch: unknown, _text: string) => ({
  ok: true as const,
}));

mock.module("./launcher.js", () => ({
  ...realLauncher,
  interruptLaunch,
  waitForClaudePromptReady,
  sendToLaunch,
}));

afterAll(() => {
  mock.module("./launcher.js", () => realLauncher);
});

const { createServer } = await import("./server.js");

// Answering a tool-permission prompt is the owner's.
const secrets = generateOwnerSecrets();
const ownerHeaders = { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken };

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  createSession(store.db, {
    id: "S1",
    projectId: "p",
    title: "",
    cwd: "/tmp/S1",
    status: "waiting",
  });
  createLaunch(store.db, {
    id: "L1",
    projectId: "p",
    task: "t",
    worktreePath: "/tmp/L1",
    branch: "main",
    tmuxSession: "standup-S1",
    sessionId: "S1",
    status: "running",
  });
  return {
    store,
    app: createServer(store, () => {}, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
      ownerSecrets: secrets,
    }),
  };
}

describe("POST /api/asks/:id/resolve override", () => {
  test("dismisses the menu, types the text, and resolves with the override", async () => {
    interruptLaunch.mockClear();
    sendToLaunch.mockClear();
    const { store, app } = setUp();
    const ask = createAsk(store.db, "S1", "permission_prompt", "pick one");

    const res = await app.request(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ answer: "  do it differently  ", override: true }),
    });
    expect(res.status).toBe(200);

    // The menu was dismissed and the trimmed text typed into the pane.
    expect(interruptLaunch).toHaveBeenCalledTimes(1);
    expect(sendToLaunch).toHaveBeenCalledTimes(1);
    expect(sendToLaunch.mock.calls[0][1]).toBe("do it differently");

    // The ask row records the override text as its answer.
    const resolved = getAsk(store.db, ask.id);
    expect(resolved?.status).toBe("answered");
    expect(resolved?.answer).toBe("do it differently");
    store.close();
  });

  test("rejects an override with no message and leaves the pane untouched", async () => {
    interruptLaunch.mockClear();
    sendToLaunch.mockClear();
    const { store, app } = setUp();
    const ask = createAsk(store.db, "S1", "permission_prompt", "pick one");

    const res = await app.request(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ answer: "   ", override: true }),
    });
    expect(res.status).toBe(400);
    expect(interruptLaunch).not.toHaveBeenCalled();
    expect(sendToLaunch).not.toHaveBeenCalled();
    expect(getAsk(store.db, ask.id)?.status).toBe("pending");
    store.close();
  });
});
