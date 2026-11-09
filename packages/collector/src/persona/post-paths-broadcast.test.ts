import { afterEach, describe, expect, test } from "bun:test";
import {
  attachSessionToLaunch,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getOrCreatePersonaThreadByRef,
  linkPersonaJobLaunch,
  listPersonaMessages,
  upsertProject,
} from "@standup/store";
import type { PersonaMessage, Snapshot, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { resolvePersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";
import { createStubTurnRunner } from "./stub-turn.js";
import type { TurnRunner } from "./turn.js";
import { createWsServer, type WsServerHandle } from "../ws.js";
import { resolveIdentityConfigFromEnv, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";

/*
 * Every way Persona posts to a thread — an owner turn, a one-shot wakeup, a
 * wake_persona schedule run, a worker event — must leave the runtime as a
 * `persona:message` frame addressed to the owner, carrying the stored row, so
 * the console shows it without a refresh. Turns are scripted; nothing spawns.
 */

// The owner secret proves the host alone on a plain upgrade, so the owner is the host.
const OWNER = resolveUserAlias(undefined);

type Harness = ReturnType<typeof harness>;

function harness(opts: { broadcast?: (m: WsMessage) => void } = {}) {
  const store = createStore(":memory:");
  const frames: WsMessage[] = [];
  let nowMs = Date.parse("2026-10-04T12:00:00.000Z");
  const stub = createStubTurnRunner();
  let script: TurnRunner = stub;
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), coalesceMs: 0 },
    broadcast: (m) => {
      frames.push(m);
      opts.broadcast?.(m);
    },
    turnRunner: (input) => script(input),
    now: () => new Date(nowMs),
  });
  return {
    store,
    runtime,
    frames,
    stub,
    script(runner: TurnRunner) {
      script = runner;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/** The `persona:message` frames broadcast from index `from` on. */
function messageFrames(h: Harness, from = 0): WsMessage[] {
  return h.frames.slice(from).filter((f) => f.type === "persona:message");
}

/** Asserts `frame` is addressed to the owner, in `threadId`, and carries the row stored there. */
function expectPosted(h: Harness, frame: WsMessage | undefined, threadId: string, role: PersonaMessage["role"]) {
  expect(frame).toBeDefined();
  expect(frame!.type).toBe("persona:message");
  expect(frame!.audience).toBe(OWNER);
  const payload = frame!.payload as PersonaMessage;
  expect(payload.role).toBe(role);
  expect(payload.threadId).toBe(threadId);
  const stored = listPersonaMessages(h.store.db, threadId).find((m) => m.id === payload.id);
  expect(stored).toBeDefined();
  expect(stored!.role).toBe(role);
  expect(stored!.text).toBe(payload.text);
}

/** Each path drives the runtime to post one Persona reply and returns where it should land. */
type Path = (h: Harness) => Promise<{ threadId: string; from: number }>;

const ownerTurn: Path = async (h) => {
  const threadId = h.runtime.consoleThreadId();
  const from = h.frames.length;
  h.runtime.receiveUserMessage({ text: "fix the build", actor: OWNER });
  await h.runtime.drain();
  return { threadId, from };
};

const wakeup: Path = async (h) => {
  const thread = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C1:1.0", "wakeup thread", "shared");
  let scheduled: { isError?: boolean } | undefined;
  h.script(async (input) => {
    if (input.prompt.includes("remind me")) {
      scheduled = await h.runtime.tools.call("schedule_wakeup", { note: "check CI", inMinutes: 5 });
    }
    return h.stub(input);
  });
  h.runtime.receiveUserMessage({ text: "remind me to check CI", actor: OWNER, threadId: thread.id });
  await h.runtime.drain();
  h.script(h.stub);
  expect(scheduled).toBeDefined();
  expect(scheduled!.isError).toBeFalsy();
  const from = h.frames.length;
  h.advance(6 * 60_000);
  await h.runtime.drain();
  return { threadId: thread.id, from };
};

const scheduleRun: Path = async (h) => {
  const thread = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", "C2:2.0", "schedule thread", "shared");
  const created = h.runtime.schedules.create(
    { title: "new year check", cron: "0 0 1 1 *", kind: "wake_persona", note: "check the year" },
    { createdBy: OWNER, threadId: thread.id }
  );
  if (!created.ok) throw new Error(created.error);
  const from = h.frames.length;
  const run = await h.runtime.schedules.runNow(created.value.id, { approved: true });
  if (!run.ok) throw new Error(run.error);
  await h.runtime.drain();
  return { threadId: thread.id, from };
};

let workerSeq = 0;
const workerEvent: Path = async (h) => {
  const n = ++workerSeq;
  const thread = getOrCreatePersonaThreadByRef(h.store.db, OWNER, "slack", `C3:${n}.0`, "job thread", "shared");
  upsertProject(h.store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const job = createPersonaJob(h.store.db, { owner: OWNER, threadId: thread.id, title: "job", goal: "g" });
  createLaunch(h.store.db, { id: `l${n}`, projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  linkPersonaJobLaunch(h.store.db, job.id, `l${n}`);
  createSession(h.store.db, { id: `s${n}`, projectId: "p", title: "w", cwd: "/w", status: "running" });
  attachSessionToLaunch(h.store.db, `l${n}`, `s${n}`);
  const from = h.frames.length;
  h.runtime.eventListener()({
    type: "session:status",
    payload: { sessionId: `s${n}`, status: "idle" },
    timestamp: new Date().toISOString(),
  });
  await h.runtime.drain();
  return { threadId: thread.id, from };
};

const PATHS: Array<[string, Path]> = [
  ["owner turn", ownerTurn],
  ["wakeup", wakeup],
  ["schedule run", scheduleRun],
  ["worker event", workerEvent],
];

describe("persona post paths — every post is broadcast to the owner", () => {
  test("an owner turn broadcasts the owner's message and Persona's reply", async () => {
    const h = harness();
    const { threadId, from } = await ownerTurn(h);
    const frames = messageFrames(h, from);
    expect(frames).toHaveLength(2);
    expectPosted(h, frames[0], threadId, "user");
    expect((frames[0]!.payload as PersonaMessage).text).toBe("fix the build");
    expectPosted(h, frames[1], threadId, "persona");
  });

  test("a one-shot wakeup coming due broadcasts its reply in the thread that scheduled it", async () => {
    const h = harness();
    const { threadId, from } = await wakeup(h);
    expect(threadId).not.toBe(h.runtime.consoleThreadId());
    const frames = messageFrames(h, from);
    expect(frames).toHaveLength(1);
    expectPosted(h, frames[0], threadId, "persona");
  });

  test("a wake_persona schedule run broadcasts its reply in the schedule's thread", async () => {
    const h = harness();
    const { threadId, from } = await scheduleRun(h);
    expect(threadId).not.toBe(h.runtime.consoleThreadId());
    const frames = messageFrames(h, from);
    expect(frames).toHaveLength(1);
    expectPosted(h, frames[0], threadId, "persona");
  });

  test("a worker event broadcasts its reply in the job's thread", async () => {
    const h = harness();
    const { threadId, from } = await workerEvent(h);
    expect(threadId).not.toBe(h.runtime.consoleThreadId());
    const frames = messageFrames(h, from);
    expect(frames).toHaveLength(1);
    expectPosted(h, frames[0], threadId, "persona");
  });
});

describe("persona post paths — through the collector's WebSocket server", () => {
  type Frame = { type: string; audience?: string; payload?: unknown };
  const secrets = generateOwnerSecrets();
  const servers: WsServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const s of servers.splice(0)) await s.close(1000, 200);
  });

  /** Opens a socket, resolving once its hello-ok arrived; `headers` carry its proof, if any. */
  async function connect(port: number, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers } as unknown as string[]);
    sockets.push(ws);
    const frames: Frame[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("error", () => reject(new Error("socket error")));
      ws.addEventListener("message", (e) => {
        const frame = JSON.parse(String(e.data)) as Frame;
        if (frame.type === "presence:state") return;
        frames.push(frame);
        if (frame.type === "hello-ok") resolve();
      });
    });
    return frames;
  }

  const messageIds = (frames: Frame[]) =>
    frames.filter((f) => f.type === "persona:message").map((f) => (f.payload as PersonaMessage).id);

  test("a proven owner socket receives every path's reply; a socket without proof receives none", async () => {
    const server = createWsServer(
      0,
      async () => ({}) as Snapshot,
      () => {},
      resolveIdentityConfigFromEnv({}),
      { ownerSecrets: () => secrets, hostname: "127.0.0.1" }
    );
    servers.push(server);
    const h = harness({ broadcast: (m) => server.broadcast(m) });
    const owner = await connect(server.port, { [OWNER_TOKEN_HEADER]: secrets.ownerToken });
    const stranger = await connect(server.port);

    const replies = new Map<string, string>();
    for (const [name, path] of PATHS) {
      const { threadId, from } = await path(h);
      const reply = messageFrames(h, from).find((f) => (f.payload as PersonaMessage).role === "persona");
      expectPosted(h, reply, threadId, "persona");
      replies.set(name, (reply!.payload as PersonaMessage).id);
    }

    const deadline = Date.now() + 5_000;
    while ([...replies.values()].some((id) => !messageIds(owner).includes(id)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    for (const [name, id] of replies) {
      expect({ path: name, received: messageIds(owner).includes(id) }).toEqual({ path: name, received: true });
    }
    for (const frame of owner.filter((f) => f.type === "persona:message")) expect(frame.audience).toBe(OWNER);

    // A socket gets frames in broadcast order, so once a later shared frame
    // reaches the stranger, every Persona frame before it was withheld.
    server.broadcast({ type: "session:status", payload: { marker: true }, timestamp: new Date().toISOString() });
    const markerDeadline = Date.now() + 5_000;
    while (!stranger.some((f) => f.type === "session:status") && Date.now() < markerDeadline) await Bun.sleep(20);
    expect(stranger.some((f) => f.type === "session:status")).toBe(true);
    expect(stranger.filter((f) => f.type.startsWith("persona:"))).toEqual([]);
  });
});
