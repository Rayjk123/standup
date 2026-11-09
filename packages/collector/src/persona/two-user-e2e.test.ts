import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createPersonaApproval,
  createSession,
  createStore,
  getAsk,
  listPersonaApprovals,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { PersonaApproval, PersonaMessage, PersonaSchedule, SchedulesResponse, Snapshot, WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { FLOOR_GATE, FLOOR_OPTIONS, floorQuestion } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { KnowledgeSync } from "../knowledge-sync.js";
import type { TurnSlots } from "./fleet.js";
import type { TurnInput, TurnResult } from "./turn.js";

// Typing into a pane goes through tmux, and phone pushes leave the host; stub
// both, and lift the stubs afterwards — mock.module is process-wide.
import * as launcher from "../launcher.js";
const realLauncher = { ...launcher };
mock.module("../launcher.js", () => ({
  ...realLauncher,
  sendToLaunch: async () => ({ ok: true }),
  interruptLaunch: async () => ({ ok: true }),
}));
import * as push from "../push.js";
const realPush = { ...push };
mock.module("../push.js", () => ({ ...realPush, pushNotification: async () => {} }));

const { createServer, resolveUserAlias, resolveIdentityConfigFromEnv } = await import("../server.js");
const { createWsServer } = await import("../ws.js");
const { PersonaRuntime } = await import("./runtime.js");
const { PersonaFleet } = await import("./fleet.js");
const { createBroadcastTap } = await import("./events.js");
const { resolvePersonaConfig } = await import("./config.js");
const { PERSONA_TOKEN_HEADER } = await import("./routes.js");
type LaunchFn = import("../server.js").LaunchFn;
type Runtime = InstanceType<typeof PersonaRuntime>;

/** The host: the user the collector runs as, whom a header-less loopback request resolves to. */
const HOST = resolveUserAlias(undefined);
const GUEST = "luportoi";
const OLD_REFUSALS = ["single-user", "takes direction only from its owner"];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const BARE_STATE_KEYS = ["canWrite", "hostAlias", "isHost", "reason", "runState"];

/** The fake turn's reply to its owner, so a test can find it in that owner's thread. */
const replyFor = (owner: string) => `Persona for ${owner} here: noted.`;

type Who = "host" | "guest" | "forged" | "bare";
type Me = "host" | "guest";

interface LaunchCall {
  project: { id: string };
  task: string;
  label?: string;
  requester?: string;
  launchedBy?: string;
  idempotencyKey?: string;
}

/** A WebSocket client of the in-process WS server, collecting the frames it receives. */
interface Socket {
  ws: WebSocket;
  frames: WsMessage[];
}

/**
 * The collector as two users see it: a file-backed temp store, a PersonaFleet
 * of real runtimes (a fake turn runner, no claude), the REST app served over
 * real HTTP on an ephemeral loopback port, and the WS server on another.
 */
interface Harness {
  root: string;
  store: Store;
  fleet: InstanceType<typeof PersonaFleet>;
  secrets: ReturnType<typeof generateOwnerSecrets>;
  base: string;
  wsPort: number;
  frames: WsMessage[];
  launchCalls: LaunchCall[];
  turnCwdOf: (owner: string) => string;
  /** Bodies run inside the next turn of an owner's Persona, in order. */
  turnBodies: Map<string, Array<() => Promise<void>>>;
  stopHttp: () => void;
}

let h: Harness;
const sockets: Socket[] = [];

function findFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port!;
}

function buildHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "persona-two-user-e2e-"));
  const store = createStore(join(root, "standup.db"));
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  upsertProject(store.db, { id: "global", name: "Global", branch: "main", repos: [], reserved: true });
  const knowledgeDir = join(root, "kb");
  const dataDir = join(root, "data");
  const secrets = generateOwnerSecrets();

  const wsPort = findFreePort();
  const wsServer = createWsServer(
    wsPort,
    async () => ({}) as Snapshot,
    () => {},
    resolveIdentityConfigFromEnv(),
    { ownerSecrets: () => secrets }
  );
  const wsBroadcast = wsServer.broadcast;
  const frames: WsMessage[] = [];
  const tap = createBroadcastTap((m) => {
    frames.push(m);
    wsBroadcast(m);
  });

  const turnCwdOf = (owner: string) => {
    const dir = join(root, "turns", owner);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const turnBodies = new Map<string, Array<() => Promise<void>>>();
  const runtimeFor = (owner: string, shared?: { turnSlots: TurnSlots; host: string }): Runtime =>
    new PersonaRuntime({
      db: store.db,
      owner,
      host: shared?.host,
      turnSlots: shared?.turnSlots,
      turnCwd: turnCwdOf(owner),
      config: resolvePersonaConfig({}),
      broadcast: tap.broadcast,
      dataDir,
      turnRunner: async (_input: TurnInput): Promise<TurnResult> => {
        const body = turnBodies.get(owner)?.shift();
        if (body) {
          await body();
          return { ok: true, text: "[silent]", sessionId: `sid-${owner}` };
        }
        return { ok: true, text: replyFor(owner), sessionId: `sid-${owner}` };
      },
      ownerToken: () => secrets.ownerToken,
    });
  const fleet = new PersonaFleet({ db: store.db, host: HOST, create: runtimeFor });
  tap.subscribe(fleet.eventListener());

  const launchCalls: LaunchCall[] = [];
  const launchFn = (async (db: Store["db"], request: LaunchCall) => {
    launchCalls.push(request);
    const id = randomUUID();
    const launch = createLaunch(db, {
      id,
      projectId: request.project.id,
      task: request.task,
      worktreePath: `/tmp/wt-${id}`,
      branch: request.label ?? "b",
      requester: request.requester,
      launchedBy: request.launchedBy,
      idempotencyKey: request.idempotencyKey,
    });
    return { launch, log: [] };
  }) as unknown as LaunchFn;

  const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
  const app = createServer(
    store,
    tap.broadcast,
    null,
    knowledgeSync,
    undefined,
    knowledgeDir,
    "",
    {},
    undefined,
    undefined,
    launchFn,
    undefined,
    { fleet, ownerSecrets: secrets }
  );
  fleet.start();

  // Loopback only, so the tunnel header is honored as it is behind the console proxy.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return {
    root,
    store,
    fleet,
    secrets,
    base: `http://127.0.0.1:${server.port}`,
    wsPort,
    frames,
    launchCalls,
    turnCwdOf,
    turnBodies,
    stopHttp: () => server.stop(true),
  };
}

/** Headers of a request from `who`: the host's console, the guest's signed-in browser, a forged guest header, a header-less loopback caller. */
function headersOf(who: Who): Record<string, string> {
  switch (who) {
    case "host":
      return { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken };
    case "guest":
      return { [DEFAULT_IDENTITY_HEADER]: GUEST, [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, GUEST) };
    case "forged":
      return { [DEFAULT_IDENTITY_HEADER]: GUEST };
    case "bare":
      return {};
  }
}

/** A real HTTP request to the served collector as `who`. */
function as(who: Who, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...headersOf(who), ...(init.headers as Record<string, string> | undefined) },
  });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const aliasOf = (me: Me) => (me === "host" ? HOST : GUEST);
const otherOf = (me: Me): Me => (me === "host" ? "guest" : "host");
const runtimeOf = (me: Me): Runtime => h.fleet.get(aliasOf(me))!;

/** One of `runtime`'s tool calls, as its turn's MCP proxy makes it. */
async function tool(runtime: Runtime, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${h.base}/api/persona/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
    body: JSON.stringify({ name, arguments: args }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content.map((c) => c.text).join("");
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { isError: !!result.isError, text, json: parsed };
}

/** Polls `check` until it returns a value, failing after `ms`. */
async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/**
 * `me` says `said` over HTTP; the turn it wakes runs `body` (its tool calls
 * made as that Persona) and the test waits for that turn to finish.
 */
async function inTurn(me: Me, said: string, body: () => Promise<void>): Promise<void> {
  let done = false;
  let failure: unknown;
  const owner = aliasOf(me);
  const queue = h.turnBodies.get(owner) ?? [];
  h.turnBodies.set(owner, queue);
  queue.push(async () => {
    try {
      await body();
    } catch (err) {
      failure = err;
    } finally {
      done = true;
    }
  });
  const sent = await as(me, "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: said }) });
  expect(sent.status).toBe(201);
  await until(`${owner}'s turn`, () => (done ? true : undefined));
  await runtimeOf(me).drain();
  if (failure) throw failure;
}

/** A worker session of `me`'s Persona's job in project `projectId`. */
async function ownedSession(me: Me, projectId = "p") {
  const launched = await tool(runtimeOf(me), "launch_session", { task: `fix the flaky test for ${me}`, projectId });
  expect(launched.isError).toBe(false);
  const launchId = launched.json!.launchId as string;
  const sessionId = randomUUID();
  createSession(h.store.db, { id: sessionId, projectId, title: "worker", cwd: `/tmp/wt-${launchId}`, status: "running" });
  attachSessionToLaunch(h.store.db, launchId, sessionId);
  return { launchId, sessionId, jobId: launched.json!.jobId as string };
}

/** Opens a WebSocket to the in-process WS server with `headers`, resolving once hello-ok arrives. */
async function openSocket(headers: Record<string, string>): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.wsPort}`, { headers } as unknown as string[]);
  const socket: Socket = { ws, frames: [] };
  sockets.push(socket);
  ws.addEventListener("message", (e) => {
    const text = String(e.data);
    if (text === "pong") return;
    socket.frames.push(JSON.parse(text) as WsMessage);
  });
  await until("hello-ok", () => (socket.frames.some((f) => f.type === "hello-ok") ? true : undefined));
  return socket;
}

/** Everything the scenario creates, by user, for the later steps to check against. */
const made: Record<Me, { threadId: string; scheduleId: string; wakeupId: string; jobId: string; approvalId: string; attachmentId: string; memorySlug: string }> = {
  host: { threadId: "", scheduleId: "", wakeupId: "", jobId: "", approvalId: "", attachmentId: "", memorySlug: "" },
  guest: { threadId: "", scheduleId: "", wakeupId: "", jobId: "", approvalId: "", attachmentId: "", memorySlug: "" },
};

beforeAll(() => {
  expect(HOST).not.toBe(GUEST);
  h = buildHarness();
});

afterAll(() => {
  for (const s of sockets) s.ws.close();
  h?.fleet.stop();
  h?.stopHttp();
  mock.module("../launcher.js", () => realLauncher);
  mock.module("../push.js", () => realPush);
  h?.store.db.close();
  if (h) rmSync(h.root, { recursive: true, force: true });
});

describe("per-user Persona — two users end to end over real HTTP and WebSocket", () => {
  test("1. migration 059: schema_version has 59; persona_user_access, approver and answered_by exist", () => {
    const versions = (h.store.db.query("SELECT version FROM schema_version").all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toContain(59);
    const table = h.store.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'persona_user_access'").get();
    expect(table).toEqual({ name: "persona_user_access" });
    const columns = (t: string) => (h.store.db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns("persona_approvals")).toContain("approver");
    expect(columns("asks")).toContain("answered_by");
    expect(columns("persona_user_access")).toEqual(
      expect.arrayContaining(["alias", "enabled", "launch_projects_json", "updated_by", "updated_at"])
    );
  });

  test("2. host: /state is the host's own; a message gets a Persona reply in the host's thread", async () => {
    const state = await as("host", "/api/persona/state");
    expect(state.status).toBe(200);
    expect(await json(state)).toMatchObject({ owner: HOST, hostAlias: HOST, isHost: true, canWrite: true });

    const sent = await as("host", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "hello from the host" }) });
    expect(sent.status).toBe(201);
    const { message } = await json<{ message: PersonaMessage }>(sent);
    expect(message.actor).toBe(HOST);
    made.host.threadId = message.threadId;
    expect(made.host.threadId).toBe(h.fleet.hostRuntime().consoleThreadId());

    const messages = await until("the host's reply", async () => {
      const { messages } = await json<{ messages: PersonaMessage[] }>(await as("host", "/api/persona/messages"));
      return messages.some((m) => m.role === "persona" && m.text === replyFor(HOST)) ? messages : undefined;
    });
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello from the host"],
      ["persona", replyFor(HOST)],
    ]);
  });

  test("3. guest: /state is luportoi's own and never single-user; a message gets a reply in the guest's thread", async () => {
    expect(h.fleet.get(GUEST)).toBeUndefined();
    const state = await as("guest", "/api/persona/state");
    expect(state.status).toBe(200);
    const stateText = await state.text();
    expect(JSON.parse(stateText)).toMatchObject({ owner: GUEST, hostAlias: HOST, isHost: false, canWrite: true });

    const sent = await as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "hello from luportoi" }) });
    expect(sent.status).toBe(201);
    const sentText = await sent.text();
    const { message } = JSON.parse(sentText) as { message: PersonaMessage };
    expect(message.actor).toBe(GUEST);
    // The guest's first write built their own runtime.
    expect(h.fleet.get(GUEST)).toBeDefined();
    made.guest.threadId = message.threadId;
    expect(made.guest.threadId).toBe(runtimeOf("guest").consoleThreadId());
    expect(made.guest.threadId).not.toBe(made.host.threadId);

    const messages = await until("the guest's reply", async () => {
      const { messages } = await json<{ messages: PersonaMessage[] }>(await as("guest", "/api/persona/messages"));
      return messages.some((m) => m.role === "persona" && m.text === replyFor(GUEST)) ? messages : undefined;
    });
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello from luportoi"],
      ["persona", replyFor(GUEST)],
    ]);
    for (const text of [stateText, sentText, JSON.stringify(messages)]) {
      for (const refusal of OLD_REFUSALS) expect(text).not.toContain(refusal);
    }
  });

  test("4. each user makes a schedule, a wakeup, a job, a memory, an approval card and an attachment", async () => {
    for (const me of ["host", "guest"] as const) {
      const res = await as(me, "/api/persona/schedules", {
        method: "POST",
        body: JSON.stringify({ title: `${me} triage`, cron: "0 9 * * 1-5", kind: "wake_persona", note: `${me} note` }),
      });
      expect(res.status).toBe(201);
      const { schedule } = await json<{ schedule: PersonaSchedule }>(res);
      expect(schedule.owner).toBe(aliasOf(me));
      made[me].scheduleId = schedule.id;

      // A memory, as the owner asked for it in that turn.
      await inTurn(me, `From now on, keep ${me} zebra briefs under 150 words. Remember that.`, async () => {
        const r = await tool(runtimeOf(me), "remember", {
          topic: "zebra-briefs",
          quote: `keep ${me} zebra briefs under 150 words`,
          kind: "preference",
        });
        expect(r.json).toMatchObject({ saved: true });
        made[me].memorySlug = r.json!.slug as string;
      });
      await Bun.sleep(30);

      // A job, a wakeup and an attachment, in one turn.
      await inTurn(me, "open a job for the briefs, wake me in an hour and show me the picture", async () => {
        const runtime = runtimeOf(me);
        const job = await tool(runtime, "open_job", { title: `${me} briefs`, goal: "keep the briefs short" });
        expect(job.isError).toBe(false);
        made[me].jobId = (job.json!.jobId ?? job.json!.id) as string;
        const wakeup = await tool(runtime, "schedule_wakeup", { note: `${me} wakeup`, inMinutes: 60 });
        expect(wakeup.isError).toBe(false);
        made[me].wakeupId = wakeup.json!.id as string;
        const dir = h.turnCwdOf(aliasOf(me));
        const path = join(dir, `${me}.png`);
        writeFileSync(path, PNG);
        const attached = await tool(runtime, "attach_image", { path });
        expect(attached.isError).toBe(false);
        made[me].attachmentId = attached.json!.attachmentId as string;
      });

      made[me].approvalId = createPersonaApproval(h.store.db, {
        owner: aliasOf(me),
        action: "launch_session",
        summary: `${me}'s card`,
        reason: "held",
        args: { task: me },
      }).id;
    }
    for (const me of ["host", "guest"] as const) {
      for (const [key, value] of Object.entries(made[me])) expect({ me, key, set: value !== "" }).toEqual({ me, key, set: true });
    }
  });

  test("5. isolation over HTTP, both directions: lists, by-id access and knowledge", async () => {
    for (const me of ["host", "guest"] as const) {
      const them = otherOf(me);
      const mine = made[me];
      const theirs = made[them];

      const { threads } = await json<{ threads: Array<{ id: string; owner: string }> }>(await as(me, "/api/persona/threads"));
      expect(threads.map((t) => t.id)).toContain(mine.threadId);
      expect(threads.map((t) => t.id)).not.toContain(theirs.threadId);
      expect(new Set(threads.map((t) => t.owner))).toEqual(new Set([aliasOf(me)]));

      const msgsText = await (await as(me, "/api/persona/messages")).text();
      expect(msgsText).toContain(replyFor(aliasOf(me)));
      expect(msgsText).not.toContain(replyFor(aliasOf(them)));
      expect(msgsText).not.toContain(`hello from ${them === "host" ? "the host" : "luportoi"}`);

      const { jobs } = await json<{ jobs: Array<{ id: string; owner: string }> }>(await as(me, "/api/persona/jobs"));
      expect(jobs.map((j) => j.id)).toEqual([mine.jobId]);

      const { approvals } = await json<{ approvals: PersonaApproval[] }>(await as(me, "/api/persona/approvals"));
      expect(approvals.map((a) => a.id)).toEqual([mine.approvalId]);

      const schedules = await json<SchedulesResponse>(await as(me, "/api/persona/schedules"));
      expect(schedules.schedules.map((s) => s.id)).toEqual([mine.scheduleId]);
      expect(schedules.wakeups.map((w) => w.id)).toEqual([mine.wakeupId]);

      // By id: the other user's thread, schedule, card and attachment are unknown.
      expect((await as(me, `/api/persona/messages?threadId=${theirs.threadId}`)).status).toBe(404);
      const intoTheirs = await as(me, "/api/persona/messages", {
        method: "POST",
        body: JSON.stringify({ text: "into theirs", threadId: theirs.threadId }),
      });
      expect(intoTheirs.status).toBe(404);
      expect((await as(me, `/api/persona/schedules/${theirs.scheduleId}`, { method: "PATCH", body: JSON.stringify({ title: "taken" }) })).status).toBe(404);
      expect((await as(me, `/api/persona/schedules/${theirs.scheduleId}/runs`)).status).toBe(404);
      expect((await as(me, `/api/persona/approvals/${theirs.approvalId}/approve`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await as(me, `/api/persona/approvals/${theirs.approvalId}/deny`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await as(me, `/api/persona/attachments/${theirs.attachmentId}`)).status).toBe(404);
      expect((await as(me, `/api/persona/attachments/${mine.attachmentId}`)).status).toBe(200);
    }
    expect(listPersonaApprovals(h.store.db, HOST, "pending").map((a) => a.id)).toEqual([made.host.approvalId]);
    expect(listPersonaApprovals(h.store.db, GUEST, "pending").map((a) => a.id)).toEqual([made.guest.approvalId]);

    // Knowledge: each user's scoped search sees their own memory, never the other's.
    const search = async (who: Who) =>
      (
        await as(who, "/api/knowledge/search", {
          method: "POST",
          body: JSON.stringify({ cwd: "/nowhere", query: "zebra briefs under 150 words", project: "global", scoped: true, includePersonal: true, lowConfidence: 20 }),
        })
      ).text();
    const guestSees = await search("guest");
    expect(guestSees).toContain(made.guest.memorySlug);
    expect(guestSees).not.toContain(made.host.memorySlug);
    const hostSees = await search("host");
    expect(hostSees).toContain(made.host.memorySlug);
    expect(hostSees).not.toContain(made.guest.memorySlug);
    expect(await search("forged")).not.toContain(made.guest.memorySlug);

    expect((await as("guest", `/api/projects/global/knowledge/${made.guest.memorySlug}`)).status).toBe(200);
    expect((await as("forged", `/api/projects/global/knowledge/${made.guest.memorySlug}`)).status).toBe(404);
    expect((await as("host", `/api/projects/global/knowledge/${made.host.memorySlug}`)).status).toBe(200);
  });

  test("6. a forged header without a token is a sign-in 403; a header-less loopback caller gets only the bare state", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/persona/messages", undefined],
      ["GET", "/api/persona/threads", undefined],
      ["GET", "/api/persona/jobs", undefined],
      ["GET", "/api/persona/approvals", undefined],
      ["GET", "/api/persona/schedules", undefined],
      ["GET", `/api/persona/attachments/${made.guest.attachmentId}`, undefined],
      ["POST", "/api/persona/messages", { text: "forged" }],
      ["POST", "/api/persona/pause", {}],
      ["POST", "/api/persona/schedules", { title: "x", cron: "0 9 * * *", kind: "wake_persona", note: "n" }],
    ] as const) {
      const res = await as("forged", path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ reason: "sign-in" });
      expect(text).not.toContain("hello from luportoi");
    }
    const forgedState = await json(await as("forged", "/api/persona/state"));
    expect(forgedState).toEqual({ runState: "idle", hostAlias: HOST, isHost: false, canWrite: false, reason: "sign-in" });

    const bareState = await as("bare", "/api/persona/state");
    expect(bareState.status).toBe(200);
    const bareText = await bareState.text();
    const bareBody = JSON.parse(bareText) as Record<string, unknown>;
    expect(Object.keys(bareBody).sort()).toEqual(BARE_STATE_KEYS);
    expect(bareBody).toEqual({ runState: "idle", hostAlias: HOST, isHost: true, canWrite: false, reason: "sign-in" });
    for (const leak of [made.host.threadId, made.guest.threadId, "hello from the host"]) expect(bareText).not.toContain(leak);
    for (const path of ["/api/persona/messages", "/api/persona/threads", "/api/persona/jobs", "/api/persona/approvals", "/api/persona/schedules"]) {
      const res = await as("bare", path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  test("7. a guest's browser can't bind a Slack thread; the owner channel naming the guest can", async () => {
    const refused = await as("guest", "/api/persona/threads", {
      method: "POST",
      body: JSON.stringify({ channel: "slack", externalRef: "dm:DALICE1" }),
    });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ reason: "host-only" });
    const relayed = await as("bare", "/api/persona/threads", {
      method: "POST",
      headers: { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken, [PERSONA_USER_HEADER]: GUEST },
      body: JSON.stringify({ channel: "slack", externalRef: "dm:DALICE1" }),
    });
    expect(relayed.status).toBe(200);
    expect((await json<{ thread: { owner: string } }>(relayed)).thread.owner).toBe(GUEST);
  });

  test("8. launch allowlist and a floor hold in the guest's worker that only the host decides", async () => {
    const refused = await tool(runtimeOf("guest"), "launch_session", { task: "fix the flaky test", projectId: "p" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`ask ${HOST} to allow project p for you`);
    expect(h.launchCalls).toHaveLength(0);

    const self = await as("guest", `/api/persona/users/${GUEST}/access`, { method: "PUT", body: JSON.stringify({ launchProjects: ["p"] }) });
    expect(self.status).toBe(403);
    expect(await json(self)).toMatchObject({ reason: "host-only" });
    const granted = await as("host", `/api/persona/users/${GUEST}/access`, { method: "PUT", body: JSON.stringify({ launchProjects: ["p"] }) });
    expect(granted.status).toBe(200);

    const { sessionId } = await ownedSession("guest");
    expect(h.launchCalls).toHaveLength(1);
    expect(h.launchCalls[0]!.requester).toBe(GUEST);

    const ask = createAsk(
      h.store.db,
      sessionId,
      "ask_human",
      floorQuestion(
        { toolName: "Bash", toolInput: { command: "rm -rf /tmp/other-checkout/build" }, cwd: "/wt" },
        { category: "destructive", ownerOnly: false, reason: "held", step: "rm -rf /tmp/other-checkout/build" }
      ),
      [...FLOOR_OPTIONS],
      { gate: FLOOR_GATE, requestId: `toolu_${randomUUID()}` }
    );
    const held = await tool(runtimeOf("guest"), "answer_ask", { askId: ask.id, answer: "Allow once" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");

    const card = listPersonaApprovals(h.store.db, GUEST, "pending").find((a) => a.args.askId === ask.id)!;
    expect(card).toMatchObject({ owner: GUEST, approver: HOST });
    const hostCards = await json<{ approvals: PersonaApproval[] }>(await as("host", "/api/persona/approvals"));
    expect(hostCards.approvals.find((a) => a.id === card.id)).toMatchObject({ owner: GUEST, approver: HOST });

    const byGuest = await as("guest", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" });
    expect(byGuest.status).toBe(403);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    const byHost = await as("host", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" });
    expect(byHost.status).toBe(200);
    expect((await json<{ approval: PersonaApproval }>(byHost)).approval).toMatchObject({ status: "executed", decidedBy: HOST });
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "Allow once", answeredBy: HOST });
    const row = h.store.db.query("SELECT answered_by FROM asks WHERE id = ?").get(ask.id) as { answered_by: string };
    expect(row.answered_by).toBe(HOST);
  });

  test("9. admin: the host lists both users; the guest is refused host-only", async () => {
    const res = await as("host", "/api/persona/users");
    expect(res.status).toBe(200);
    const { users } = await json<{ users: Array<{ alias: string; isHost: boolean; running: boolean; access: { launchProjects: string[] } | null }> }>(res);
    expect(users.map((u) => u.alias)).toEqual([HOST, GUEST]);
    expect(users[0]).toMatchObject({ isHost: true, running: true });
    expect(users[1]).toMatchObject({ isHost: false, running: true, access: { launchProjects: ["p"] } });
    const refused = await as("guest", "/api/persona/users");
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ reason: "host-only" });
  });

  test("10. WebSocket: each proven socket gets its own user's persona frames; a forged header's gets none", async () => {
    const guestSocket = await openSocket(headersOf("guest"));
    const forgedSocket = await openSocket(headersOf("forged"));
    const hostSocket = await openSocket(headersOf("host"));
    for (const s of [guestSocket, forgedSocket, hostSocket]) s.frames.length = 0;

    await as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "ws ping from luportoi" }) });
    await as("host", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "ws ping from the host" }) });
    const sawMessage = (s: Socket, text: string) =>
      s.frames.some((f) => f.type === "persona:message" && (f.payload as { text?: string }).text === text);
    await until("the guest's frame", () => (sawMessage(guestSocket, "ws ping from luportoi") ? true : undefined));
    await until("the host's frame", () => (sawMessage(hostSocket, "ws ping from the host") ? true : undefined));
    // Let both fake turns reply and their frames land.
    await Promise.all([runtimeOf("guest").drain(), runtimeOf("host").drain()]);
    await Bun.sleep(100);

    const persona = (s: Socket) => s.frames.filter((f) => f.type.startsWith("persona:"));
    expect(persona(guestSocket).length).toBeGreaterThan(0);
    expect(new Set(persona(guestSocket).map((f) => f.audience))).toEqual(new Set([GUEST]));
    expect(sawMessage(guestSocket, "ws ping from the host")).toBe(false);
    expect(persona(hostSocket).length).toBeGreaterThan(0);
    expect(new Set(persona(hostSocket).map((f) => f.audience))).toEqual(new Set([HOST]));
    expect(sawMessage(hostSocket, "ws ping from luportoi")).toBe(false);
    expect(persona(forgedSocket)).toEqual([]);
  });
});
