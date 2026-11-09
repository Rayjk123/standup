import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createPersonaApproval,
  createPersonaJob,
  createSession,
  createStore,
  getAsk,
  getOrCreatePersonaState,
  getOrCreatePersonaThreadByRef,
  getParticipants,
  getPersonaApproval,
  getSession,
  listPendingPersonaInbox,
  listPersonaApprovals,
  listPersonaMessages,
  listPersonaOwners,
  setSetting,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { PersonaApproval, PersonaSchedule, SchedulesResponse, WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { FLOOR_GATE, FLOOR_OPTIONS, FLOOR_OWNER_GATE, floorQuestion } from "../floor/gate.js";
import type { FloorCategory } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { KnowledgeSync } from "../knowledge-sync.js";
import { memorySlug } from "./memory-slug.js";
import type { TurnSlots } from "./fleet.js";

// Typing into a pane goes through tmux, and phone pushes leave the host; stub
// both, and lift the stubs afterwards — mock.module is process-wide.
import * as launcher from "../launcher.js";
import { CALLER_GUARD_ERRORS } from "../caller-guard.js";
const realLauncher = { ...launcher };
mock.module("../launcher.js", () => ({
  ...realLauncher,
  sendToLaunch: async () => ({ ok: true }),
  interruptLaunch: async () => ({ ok: true }),
}));
import * as push from "../push.js";
const realPush = { ...push };
const pushNotification = mock(async (_title: string, _message: string, _actor?: string | null) => {});
mock.module("../push.js", () => ({ ...realPush, pushNotification }));

const dirs: string[] = [];
const stoppers: Array<() => void> = [];
afterAll(() => {
  mock.module("../launcher.js", () => realLauncher);
  mock.module("../push.js", () => realPush);
  for (const stop of stoppers) stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer, resolveUserAlias } = await import("../server.js");
const { PersonaRuntime } = await import("./runtime.js");
const { PersonaFleet } = await import("./fleet.js");
const { createBroadcastTap } = await import("./events.js");
const { resolvePersonaConfig } = await import("./config.js");
const { PERSONA_TOKEN_HEADER } = await import("./routes.js");
const { GUEST_FLOOR_SETTING } = await import("./tools.js");
type LaunchFn = import("../server.js").LaunchFn;
type Runtime = InstanceType<typeof PersonaRuntime>;

/** The host: the user the collector runs as, whom a loopback request without a tunnel header resolves to. */
const HOST = resolveUserAlias(undefined);
const GUEST = "luportoi";
/** The text the single-user Persona refused everyone else with; no response may carry it. */
const OLD_REFUSALS = ["single-user", "takes direction only from its owner"];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

interface LaunchCall {
  project: { id: string };
  task: string;
  label?: string;
  requester?: string;
  launchedBy?: string;
  idempotencyKey?: string;
  allowProjectInference?: boolean;
}

type Who = "host" | "guest" | "guest-unsigned" | "anonymous";

let seq = 0;

function setUp() {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  upsertProject(store.db, { id: "q", name: "Project Q", branch: "main", repos: ["/repo/q"] });
  upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
  upsertProject(store.db, { id: "global", name: "Global", branch: "main", repos: [], reserved: true });
  const root = mkdtempSync(join(tmpdir(), "persona-isolation-"));
  dirs.push(root);
  const knowledgeDir = join(root, "kb");
  const dataDir = join(root, "data");

  const frames: WsMessage[] = [];
  const tap = createBroadcastTap((m) => frames.push(m));
  const secrets = generateOwnerSecrets();
  /** Each runtime's own turn directory. */
  const turnCwdOf = (owner: string) => {
    const dir = join(root, "turns", owner);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const runtimeFor = (owner: string, shared?: { turnSlots: TurnSlots; host: string }): Runtime => {
    const runtime = new PersonaRuntime({
      db: store.db,
      owner,
      host: shared?.host,
      turnSlots: shared?.turnSlots,
      turnCwd: turnCwdOf(owner),
      config: resolvePersonaConfig({}),
      broadcast: tap.broadcast,
      dataDir,
      turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
      ownerToken: () => secrets.ownerToken,
    });
    stoppers.push(() => runtime.stop());
    return runtime;
  };
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

  const host = fleet.hostRuntime();
  const guest = fleet.getOrCreate(GUEST)!;

  /** Headers of a request from `who`: the host's console (owner token), a guest's signed-in browser, a guest without the channel proof. */
  const headersOf = (who: Who): Record<string, string> => {
    switch (who) {
      case "host":
        return { [OWNER_TOKEN_HEADER]: secrets.ownerToken };
      case "guest":
        return { [DEFAULT_IDENTITY_HEADER]: GUEST, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST) };
      case "guest-unsigned":
        return { [DEFAULT_IDENTITY_HEADER]: GUEST };
      case "anonymous":
        return {};
    }
  };

  /** A request to the collector as `who`; anonymous comes from a non-loopback address. */
  const as = (who: Who, path: string, init: RequestInit = {}) =>
    app.request(
      path,
      {
        ...init,
        headers: { "content-type": "application/json", ...headersOf(who), ...(init.headers as Record<string, string> | undefined) },
      },
      who === "anonymous" ? { requestIP: () => ({ address: "10.1.2.3", family: "IPv4", port: 40000 }) } : undefined
    );
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  /** One of `runtime`'s tool calls, as its turn's MCP proxy makes it. */
  const tool = async (runtime: Runtime, name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request("/api/persona/tool", {
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
  };

  /** Runs `body` inside a turn of `runtime` woken by its owner saying `said`. */
  const inTurn = async (runtime: Runtime, body: () => Promise<void>, said = "please handle it") => {
    (runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
      await body();
      return { ok: true, text: "[silent]", sessionId: `sid-${runtime.owner}` };
    };
    runtime.receiveUserMessage({ text: said, actor: runtime.owner });
    await runtime.drain();
  };

  /** A worker session `runtime`'s Persona launched into `projectId`. */
  const ownedSession = async (runtime: Runtime, projectId = "p") => {
    const launched = await tool(runtime, "launch_session", { task: `do the thing, number ${++seq}`, projectId });
    expect(launched.isError).toBe(false);
    const launchId = launched.json!.launchId as string;
    const sessionId = randomUUID();
    createSession(store.db, { id: sessionId, projectId, title: "worker", cwd: `/tmp/wt-${launchId}`, status: "running" });
    attachSessionToLaunch(store.db, launchId, sessionId);
    return { launchId, sessionId, jobId: launched.json!.jobId as string };
  };

  const allowGuest = async (projects: string[]) => {
    const res = await as("host", `/api/persona/users/${GUEST}/access`, {
      method: "PUT",
      body: JSON.stringify({ launchProjects: projects }),
    });
    expect(res.status).toBe(200);
  };

  const floorAsk = (sessionId: string, gate: string, category: FloorCategory, command: string) =>
    createAsk(
      store.db,
      sessionId,
      "ask_human",
      floorQuestion(
        { toolName: "Bash", toolInput: { command }, cwd: "/wt" },
        { category, ownerOnly: gate === FLOOR_OWNER_GATE, reason: "held", step: command }
      ),
      [...FLOOR_OPTIONS],
      { gate, requestId: `toolu_${randomUUID()}` }
    );

  /** A PNG named `name` in `dir` (the harness root when omitted). */
  const image = (name: string, dir = root) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, PNG);
    return path;
  };

  return { store, app, fleet, host, guest, secrets, frames, launchCalls, knowledgeDir, root, turnCwdOf, as, json, tool, inTurn, ownedSession, allowGuest, floorAsk, image };
}

type Harness = ReturnType<typeof setUp>;

/** Whether any of `bodies` carries the single-user refusal text. */
function carriesOldRefusal(bodies: string[]): boolean {
  return bodies.some((b) => OLD_REFUSALS.some((r) => b.includes(r)));
}

describe("per-user Persona — a guest's own Persona", () => {
  test("a guest reads and directs their own Persona, never told it is single-user", async () => {
    const h = setUp();
    const bodies: string[] = [];
    const state = await h.as("guest", "/api/persona/state");
    expect(state.status).toBe(200);
    const stateText = await state.text();
    bodies.push(stateText);
    expect(JSON.parse(stateText)).toMatchObject({ owner: GUEST, hostAlias: HOST, isHost: false, canWrite: true });

    const sent = await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "hi from luportoi" }) });
    expect(sent.status).toBe(201);
    const sentText = await sent.text();
    bodies.push(sentText);
    const { message } = JSON.parse(sentText) as { message: { actor: string; threadId: string } };
    expect(message.actor).toBe(GUEST);
    expect(message.threadId).toBe(h.guest.consoleThreadId());
    expect(listPendingPersonaInbox(h.store.db, GUEST).filter((i) => i.kind === "user_message")).toHaveLength(1);
    expect(listPendingPersonaInbox(h.store.db, HOST).filter((i) => i.kind === "user_message")).toHaveLength(0);

    for (const path of ["/api/persona/messages", "/api/persona/threads", "/api/persona/jobs", "/api/persona/approvals", "/api/persona/schedules"]) {
      const res = await h.as("guest", path);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    bodies.push(await (await h.as("guest-unsigned", "/api/persona/pause", { method: "POST", body: "{}" })).text());
    expect(carriesOldRefusal(bodies)).toBe(false);
  });

  test("the host's state reports the host, unchanged", async () => {
    const h = setUp();
    const state = await h.json(await h.as("host", "/api/persona/state"));
    expect(state).toMatchObject({ owner: HOST, hostAlias: HOST, isHost: true, canWrite: true });
  });
});

describe("per-user Persona — identity and write proofs", () => {
  test("a guest without the channel token can neither read nor write (sign-in)", async () => {
    const h = setUp();
    const state = await h.as("guest-unsigned", "/api/persona/state");
    expect(state.status).toBe(200);
    // Only that Persona runs here and a sign-in is needed: no owner, thread or counts.
    const body: Record<string, unknown> = await h.json(state);
    expect(body).toEqual({ runState: "idle", hostAlias: HOST, isHost: false, canWrite: false, reason: "sign-in" });
    for (const [method, path, body] of [
      ["POST", "/api/persona/messages", { text: "hi" }],
      ["POST", "/api/persona/pause", {}],
      ["POST", "/api/persona/schedules", { title: "x", cron: "0 9 * * *", kind: "wake_persona", note: "n" }],
    ] as const) {
      const res = await h.as("guest-unsigned", path, { method, body: JSON.stringify(body) });
      expect(res.status).toBe(403);
      expect(await h.json(res)).toMatchObject({ reason: "sign-in" });
    }
    expect(getOrCreatePersonaState(h.store.db, GUEST).paused).toBe(false);
  });

  test("a forged tunnel header from loopback, without a token, reads none of the guest's Persona", async () => {
    const h = setUp();
    // The guest's Persona has a message, a Slack thread, a job, a card, a schedule and an attachment.
    const sent = await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "private to luportoi" }) });
    expect(sent.status).toBe(201);
    const bound = await h.app.request("/api/persona/threads", {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: h.secrets.ownerToken, [PERSONA_USER_HEADER]: GUEST },
      body: JSON.stringify({ channel: "slack", externalRef: "dm:D42" }),
    });
    expect(bound.status).toBe(200);
    await h.allowGuest(["p"]);
    const { jobId } = await h.ownedSession(h.guest);
    createPersonaApproval(h.store.db, { owner: GUEST, action: "launch_session", summary: "guest card", reason: "held", args: {}, jobId });
    const schedule = await h.as("guest", "/api/persona/schedules", {
      method: "POST",
      body: JSON.stringify({ title: "guest triage", cron: "0 9 * * *", kind: "wake_persona", note: "n" }),
    });
    expect(schedule.status).toBe(201);
    let attachmentId = "";
    await h.inTurn(h.guest, async () => {
      attachmentId = (await h.tool(h.guest, "attach_image", { path: h.image("g.png", h.turnCwdOf(GUEST)) })).json!.attachmentId as string;
    });
    expect(attachmentId).not.toBe("");

    for (const path of [
      "/api/persona/messages",
      "/api/persona/threads",
      "/api/persona/jobs",
      "/api/persona/approvals",
      "/api/persona/schedules",
      "/api/persona/hold-report",
      "/api/persona/knowledge-decisions",
      `/api/persona/attachments/${attachmentId}`,
    ]) {
      const res = await h.as("guest-unsigned", path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ reason: "sign-in" });
      expect(text).not.toContain("private to luportoi");
    }
    // With its own token the guest reads all of it.
    for (const path of ["/api/persona/messages", "/api/persona/jobs", "/api/persona/approvals", `/api/persona/attachments/${attachmentId}`]) {
      expect((await h.as("guest", path)).status).toBe(200);
    }
  });

  test("a credential-less GET /api/persona/state is a bare 200 with no user, thread or job data", async () => {
    const h = setUp();
    // Both Personas have a thread, messages, a job and pending work.
    await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "guest data" }) });
    await h.as("host", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "host data" }) });
    await h.allowGuest(["p"]);
    await h.ownedSession(h.guest);
    await h.ownedSession(h.host);
    const allowed = ["runState", "hostAlias", "isHost", "canWrite", "reason"];
    const forbidden = ["owner", "threadId", "jobs", "activeLaunches", "pendingInbox", "lastError", "claudeSessionId", "lastTurnAt"];
    for (const [who, headers, isHost] of [
      ["header-less loopback", {}, true],
      ["forged guest header", { [DEFAULT_IDENTITY_HEADER]: GUEST }, false],
    ] as const) {
      const res = await h.app.request("/api/persona/state", { headers });
      expect({ who, status: res.status }).toEqual({ who, status: 200 });
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      for (const key of Object.keys(body)) expect({ who, key, allowed: allowed.includes(key) }).toEqual({ who, key, allowed: true });
      for (const key of forbidden) expect({ who, key, present: key in body }).toEqual({ who, key, present: false });
      expect(body).toEqual({ runState: "idle", hostAlias: HOST, isHost, canWrite: false, reason: "sign-in" });
      for (const leak of ["guest data", "host data", h.guest.consoleThreadId(), h.host.consoleThreadId()]) expect(text).not.toContain(leak);
    }
  });

  test("header-less loopback without the owner token can't read the host's Persona", async () => {
    const h = setUp();
    h.host.receiveUserMessage({ text: "the host's own note", actor: HOST });
    const bare = (path: string) => h.app.request(path, { headers: { "content-type": "application/json" } });
    for (const path of ["/api/persona/messages", "/api/persona/threads", "/api/persona/jobs", "/api/persona/approvals", "/api/persona/schedules"]) {
      const res = await bare(path);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(await res.text()).not.toContain("the host's own note");
    }
    const state = await h.json(await bare("/api/persona/state"));
    expect(state).toEqual({ runState: "idle", hostAlias: HOST, isHost: true, canWrite: false, reason: "sign-in" });
    // The users list is the host's admin view: it needs the owner token too.
    expect((await bare("/api/persona/users")).status).toBe(403);
  });

  test("a forged tunnel header can't write, even with the owner token or another alias's channel token", async () => {
    const h = setUp();
    // The owner token alone proves only the host.
    const withOwner = await h.as("guest-unsigned", "/api/persona/messages", {
      method: "POST",
      headers: { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken },
      body: JSON.stringify({ text: "forged" }),
    });
    expect(withOwner.status).toBe(403);
    expect(await h.json(withOwner)).toMatchObject({ reason: "sign-in" });
    const wrongAlias = await h.as("guest-unsigned", "/api/persona/messages", {
      method: "POST",
      headers: { [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, "someone-else") },
      body: JSON.stringify({ text: "forged" }),
    });
    expect(wrongAlias.status).toBe(403);
    expect(listPersonaMessages(h.store.db, h.guest.consoleThreadId())).toHaveLength(0);
  });

  test("a guest's browser can't bind their Persona to a Slack address; only the bridge can", async () => {
    const h = setUp();
    for (const externalRef of ["dm:DALICE1", "GPRIV1:100.000"]) {
      const res = await h.as("guest", "/api/persona/threads", {
        method: "POST",
        body: JSON.stringify({ channel: "slack", externalRef }),
      });
      expect(res.status).toBe(403);
      expect(await h.json(res)).toMatchObject({ reason: "host-only" });
    }
    const { threads } = await h.json<{ threads: Array<{ channel: string }> }>(await h.as("guest", "/api/persona/threads"));
    expect(threads.filter((t) => t.channel === "slack")).toHaveLength(0);
    const relayed = await h.app.request("/api/persona/threads", {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: h.secrets.ownerToken, [PERSONA_USER_HEADER]: GUEST },
      body: JSON.stringify({ channel: "slack", externalRef: "dm:DLUPO1" }),
    });
    expect(relayed.status).toBe(200);
    expect((await h.json<{ thread: { owner: string } }>(relayed)).thread.owner).toBe(GUEST);
  });

  test("an owner channel speaks for a named user only with the owner token", async () => {
    const h = setUp();
    const relayed = await h.app.request("/api/persona/messages", {
      method: "POST",
      headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: h.secrets.ownerToken, [PERSONA_USER_HEADER]: GUEST },
      body: JSON.stringify({ text: "from slack" }),
    });
    expect(relayed.status).toBe(201);
    expect((await h.json<{ message: { actor: string; threadId: string } }>(relayed)).message).toMatchObject({
      actor: GUEST,
      threadId: h.guest.consoleThreadId(),
    });
    // Without the token the header is ignored: a loopback request is the host's, and needs the token to write.
    const bare = await h.app.request("/api/persona/messages", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_USER_HEADER]: GUEST },
      body: JSON.stringify({ text: "forged" }),
    });
    expect(bare.status).toBe(403);
    expect(listPersonaMessages(h.store.db, h.guest.consoleThreadId())).toHaveLength(1);
  });

  test("a body actor can't spoof the caller", async () => {
    const h = setUp();
    const spoof = await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "as host?", actor: HOST }) });
    expect(spoof.status).toBe(201);
    expect((await h.json<{ message: { actor: string; threadId: string } }>(spoof)).message).toMatchObject({
      actor: GUEST,
      threadId: h.guest.consoleThreadId(),
    });
    expect(listPersonaMessages(h.store.db, h.host.consoleThreadId())).toHaveLength(0);
  });

  test("an anonymous caller on another machine is refused before any Persona route runs", async () => {
    const h = setUp();
    for (const path of ["/api/persona/state", "/api/persona/messages", "/api/persona/approvals"]) {
      const res = await h.as("anonymous", path);
      expect(res.status).toBe(403);
      expect(await h.json(res)).toMatchObject({ error: CALLER_GUARD_ERRORS.credential });
    }
  });
});

describe("per-user Persona — isolation, both directions", () => {
  const pairs = (h: Harness) =>
    [
      { me: "host" as const, mine: h.host, theirs: h.guest },
      { me: "guest" as const, mine: h.guest, theirs: h.host },
    ] as const;

  test("threads and messages, by list and by id", async () => {
    const h = setUp();
    await h.as("host", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "host secret" }) });
    await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "guest secret" }) });
    for (const { me, mine, theirs } of pairs(h)) {
      const { threads } = await h.json<{ threads: Array<{ id: string; owner: string }> }>(await h.as(me, "/api/persona/threads"));
      expect(threads.map((t) => t.id)).toContain(mine.consoleThreadId());
      expect(threads.map((t) => t.id)).not.toContain(theirs.consoleThreadId());
      const { messages } = await h.json<{ messages: Array<{ text: string }> }>(await h.as(me, "/api/persona/messages"));
      expect(messages.map((m) => m.text)).toEqual([me === "host" ? "host secret" : "guest secret"]);
      expect((await h.as(me, `/api/persona/messages?threadId=${theirs.consoleThreadId()}`)).status).toBe(404);
      const post = await h.as(me, "/api/persona/messages", {
        method: "POST",
        body: JSON.stringify({ text: "into theirs", threadId: theirs.consoleThreadId() }),
      });
      expect(post.status).toBe(404);
    }
  });

  test("jobs, by list and by id", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    const hostJob = (await h.ownedSession(h.host)).jobId;
    const guestJob = (await h.ownedSession(h.guest)).jobId;
    for (const { me, mine, theirs } of pairs(h)) {
      const { jobs } = await h.json<{ jobs: Array<{ id: string; owner: string }> }>(await h.as(me, "/api/persona/jobs"));
      expect(jobs.map((j) => j.id)).toEqual([mine === h.host ? hostJob : guestJob]);
      const other = await h.tool(mine, "update_job", { jobId: theirs === h.host ? hostJob : guestJob, note: "mine now" });
      expect(other.isError).toBe(true);
      expect(other.text).toContain("no job");
      const listed = await h.tool(mine, "list_jobs");
      expect(listed.text).not.toContain(theirs === h.host ? hostJob : guestJob);
    }
  });

  test("approvals, by list and by id", async () => {
    const h = setUp();
    const card = (owner: string) =>
      createPersonaApproval(h.store.db, { owner, action: "launch_session", summary: `${owner}'s card`, reason: "held", args: { task: owner } });
    const hostCard = card(HOST);
    const guestCard = card(GUEST);
    for (const { me, mine } of pairs(h)) {
      const myCard = mine === h.host ? hostCard : guestCard;
      const theirCard = mine === h.host ? guestCard : hostCard;
      const { approvals } = await h.json<{ approvals: PersonaApproval[] }>(await h.as(me, "/api/persona/approvals"));
      expect(approvals.map((a) => a.id)).toEqual([myCard.id]);
      expect(approvals[0]).toMatchObject({ owner: mine.owner });
      const denied = await h.as(me, `/api/persona/approvals/${theirCard.id}/deny`, { method: "POST", body: "{}" });
      expect(denied.status).toBe(404);
      const approved = await h.as(me, `/api/persona/approvals/${theirCard.id}/approve`, { method: "POST", body: "{}" });
      expect(approved.status).toBe(404);
    }
    expect(listPersonaApprovals(h.store.db, HOST, "pending")).toHaveLength(1);
    expect(listPersonaApprovals(h.store.db, GUEST, "pending")).toHaveLength(1);
  });

  test("schedules and wakeups, by list and by id", async () => {
    const h = setUp();
    const created: Record<string, PersonaSchedule> = {};
    for (const who of ["host", "guest"] as const) {
      const res = await h.as(who, "/api/persona/schedules", {
        method: "POST",
        body: JSON.stringify({ title: `${who} triage`, cron: "0 9 * * 1-5", kind: "wake_persona", note: who }),
      });
      expect(res.status).toBe(201);
      created[who] = (await h.json<{ schedule: PersonaSchedule }>(res)).schedule;
    }
    const wakeups: Record<string, string> = {};
    for (const [who, runtime] of [["host", h.host], ["guest", h.guest]] as const) {
      const r = await h.tool(runtime, "schedule_wakeup", { note: `${who} wakeup`, inMinutes: 60 });
      expect(r.isError).toBe(false);
      wakeups[who] = r.json!.id as string;
    }
    for (const { me, mine } of pairs(h)) {
      const them = me === "host" ? "guest" : "host";
      const list = await h.json<SchedulesResponse>(await h.as(me, "/api/persona/schedules"));
      expect(list.schedules.map((s) => s.id)).toEqual([created[me]!.id]);
      expect(list.wakeups.map((w) => w.id)).toEqual([wakeups[me]!]);
      const patch = await h.as(me, `/api/persona/schedules/${created[them]!.id}`, { method: "PATCH", body: JSON.stringify({ title: "taken" }) });
      expect(patch.status).toBe(404);
      expect((await h.as(me, `/api/persona/schedules/${created[them]!.id}/runs`)).status).toBe(404);
      expect((await h.as(me, `/api/persona/schedules/${created[them]!.id}/run`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await h.as(me, `/api/persona/schedules/${created[them]!.id}`, { method: "DELETE", body: "{}" })).status).toBe(404);
      const cancel = await h.tool(mine, "cancel_wakeup", { id: wakeups[them]! });
      expect(cancel.isError).toBe(true);
      const del = await h.tool(mine, "delete_schedule", { id: created[them]!.id });
      expect(del.isError).toBe(true);
    }
    expect(h.host.schedules.get(created.host!.id)?.title).toBe("host triage");
    expect(h.guest.schedules.get(created.guest!.id)?.title).toBe("guest triage");
  });

  test("attachments, by id", async () => {
    const h = setUp();
    const ids: Record<string, string> = {};
    for (const [who, runtime] of [["host", h.host], ["guest", h.guest]] as const) {
      (runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
        ids[who] = (await h.tool(runtime, "attach_image", { path: h.image(`${who}.png`, h.turnCwdOf(runtime.owner)) })).json!
          .attachmentId as string;
        return { ok: true, text: "Here it is.", sessionId: "sid-attach" };
      };
      runtime.receiveUserMessage({ text: "show me", actor: runtime.owner });
      await runtime.drain();
    }
    expect((await h.as("host", `/api/persona/attachments/${ids.host}`)).status).toBe(200);
    expect((await h.as("guest", `/api/persona/attachments/${ids.guest}`)).status).toBe(200);
    expect((await h.as("host", `/api/persona/attachments/${ids.guest}`)).status).toBe(404);
    expect((await h.as("guest", `/api/persona/attachments/${ids.host}`)).status).toBe(404);
  });

  test("memories: each Persona remembers as its owner and recalls and forgets only its own", async () => {
    const h = setUp();
    const saved: Record<string, string> = {};
    for (const [who, runtime] of [["host", h.host], ["guest", h.guest]] as const) {
      const said = `From now on, keep ${who} zebra briefs under 150 words. Remember that.`;
      await h.inTurn(
        runtime,
        async () => {
          const r = await h.tool(runtime, "remember", {
            topic: "zebra-briefs",
            quote: `keep ${who} zebra briefs under 150 words`,
            kind: "preference",
          });
          expect(r.json).toMatchObject({ saved: true });
          saved[who] = r.json!.slug as string;
        },
        said
      );
      await Bun.sleep(30);
    }
    expect(saved.host).toBe(memorySlug(HOST, "zebra-briefs")!.slug);
    expect(saved.guest).toBe(memorySlug(GUEST, "zebra-briefs")!.slug);
    const hostDoc = readFileSync(join(h.knowledgeDir, "global", `${saved.host}.md`), "utf8");
    const guestDoc = readFileSync(join(h.knowledgeDir, "global", `${saved.guest}.md`), "utf8");
    expect(hostDoc).toContain(`owner_user: ${HOST}`);
    expect(guestDoc).toContain(`owner_user: ${GUEST}`);

    for (const [who, runtime, other] of [["host", h.host, "guest"], ["guest", h.guest, "host"]] as const) {
      const recalled = await h.tool(runtime, "recall", { query: "zebra briefs under 150 words" });
      expect(recalled.isError).toBe(false);
      expect(recalled.text).toContain(saved[who]!);
      expect(recalled.text).not.toContain(saved[other]!);
      const forgot = await h.tool(runtime, "forget", { slug: saved[other]! });
      expect(forgot.isError).toBe(true);
    }
    expect(readFileSync(join(h.knowledgeDir, "global", `${saved.host}.md`), "utf8")).not.toContain("superseded");
    expect(readFileSync(join(h.knowledgeDir, "global", `${saved.guest}.md`), "utf8")).not.toContain("superseded");
  });

  test("a forged tunnel header reads none of the guest's memories; its channel token, its runtime and the host read as before", async () => {
    const h = setUp();
    const saved: Record<string, string> = {};
    for (const [who, runtime] of [["host", h.host], ["guest", h.guest]] as const) {
      await h.inTurn(
        runtime,
        async () => {
          const r = await h.tool(runtime, "remember", {
            topic: "okapi-notes",
            quote: `keep ${who} okapi notes under 90 words`,
            kind: "preference",
          });
          expect(r.json).toMatchObject({ saved: true });
          saved[who] = r.json!.slug as string;
        },
        `From now on, keep ${who} okapi notes under 90 words. Remember that.`
      );
      await Bun.sleep(30);
    }
    const guestSlug = saved.guest!;
    const hostSlug = saved.host!;
    const bare = (path: string, init: RequestInit = {}) =>
      h.app.request(path, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
    const readers = {
      forged: (path: string, init: RequestInit = {}) => h.as("guest-unsigned", path, init),
      signed: (path: string, init: RequestInit = {}) => h.as("guest", path, init),
      host: bare,
    };
    type Reader = (path: string, init?: RequestInit) => Response | Promise<Response>;
    const search = async (read: Reader, scoped: boolean) =>
      (
        await read("/api/knowledge/search", {
          method: "POST",
          body: JSON.stringify({ cwd: "/nowhere", query: "okapi notes under 90 words", project: "global", scoped, includePersonal: true, lowConfidence: 20 }),
        })
      ).text();
    const surfaces = async (read: Reader) => [
      await search(read, true),
      await search(read, false),
      await (await read("/api/projects/global/knowledge")).text(),
      await (await read("/api/knowledge/graph?project=global")).text(),
      await (await read("/api/knowledge/agent-view?project=global&q=okapi")).text(),
      await (await read("/api/knowledge-changes?limit=200")).text(),
      await (await read("/api/knowledge/usage")).text(),
      await (await read("/api/knowledge/stats")).text(),
    ];

    // The forged header gets a 404 for the doc and finds it nowhere.
    expect((await readers.forged(`/api/projects/global/knowledge/${guestSlug}`)).status).toBe(404);
    for (const text of await surfaces(readers.forged)) expect(text).not.toContain(guestSlug);
    // Nor by naming the guest in agent-view's preview knob.
    const preview = await (await readers.forged(`/api/knowledge/agent-view?project=global&q=okapi&user=${GUEST}`)).text();
    expect(preview).not.toContain(guestSlug);
    const hostPreview = await (await bare(`/api/knowledge/agent-view?project=global&q=okapi&user=${GUEST}`)).text();
    expect(hostPreview).not.toContain(guestSlug);

    // With the guest's channel token the doc is theirs to read.
    expect((await readers.signed(`/api/projects/global/knowledge/${guestSlug}`)).status).toBe(200);
    expect(await search(readers.signed, true)).toContain(guestSlug);
    expect(await search(readers.signed, false)).toContain(guestSlug);
    // An owner channel naming the guest reads as the guest.
    const relayed = await bare(`/api/projects/global/knowledge/${guestSlug}`, {
      headers: { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken, [PERSONA_USER_HEADER]: GUEST },
    });
    expect(relayed.status).toBe(200);

    // The guest's runtime still recalls its own memory.
    const recalled = await h.tool(h.guest, "recall", { query: "okapi notes under 90 words" });
    expect(recalled.isError).toBe(false);
    expect(recalled.text).toContain(guestSlug);

    // Header-less loopback is the host, unchanged: its own memory, not the guest's.
    expect((await bare(`/api/projects/global/knowledge/${hostSlug}`)).status).toBe(200);
    expect(await search(bare, true)).toContain(hostSlug);
    for (const text of await surfaces(bare)) expect(text).not.toContain(guestSlug);
  });

  test("every persona frame goes to its owner's audience alone", async () => {
    const h = setUp();
    await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "guest only" }) });
    await h.as("host", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "host only" }) });
    const persona = h.frames.filter((f) => f.type.startsWith("persona:"));
    expect(persona.length).toBeGreaterThan(0);
    for (const frame of persona) expect(frame.audience === HOST || frame.audience === GUEST).toBe(true);
    const messageFrames = persona.filter((f) => f.type === "persona:message");
    const audienceOf = (text: string) =>
      messageFrames.filter((f) => (f.payload as { text: string }).text === text).map((f) => f.audience);
    expect(audienceOf("guest only")).toEqual([GUEST]);
    expect(audienceOf("host only")).toEqual([HOST]);
  });
});

describe("per-user Persona — a guest's launches", () => {
  test("refused until the host allowlists the project, then recorded as the guest's", async () => {
    const h = setUp();
    const refused = await h.tool(h.guest, "launch_session", { task: "fix the flaky test", projectId: "p" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`ask ${HOST} to allow project p for you`);
    expect(h.launchCalls).toHaveLength(0);
    // The guest can't grant itself access.
    const self = await h.as("guest", `/api/persona/users/${GUEST}/access`, { method: "PUT", body: JSON.stringify({ launchProjects: ["p"] }) });
    expect(self.status).toBe(403);
    expect(await h.json(self)).toMatchObject({ reason: "host-only" });
    const unknown = await h.as("host", `/api/persona/users/${GUEST}/access`, { method: "PUT", body: JSON.stringify({ launchProjects: ["nope"] }) });
    expect(unknown.status).toBe(400);

    await h.allowGuest(["p"]);
    const launched = await h.tool(h.guest, "launch_session", { task: "fix the flaky test", projectId: "p" });
    expect(launched.isError).toBe(false);
    const call = h.launchCalls.at(-1)!;
    expect(call.requester).toBe(GUEST);
    expect(call.task).toContain(`You are working for ${GUEST}`);
    expect(call.task).toContain(`credentials`);
    expect(call.task).toContain(`goes out as ${HOST}`);
    // A guest's launch is never re-targeted by project inference.
    expect(call.allowProjectInference).toBe(false);
    // Only the allowlisted project.
    const other = await h.tool(h.guest, "launch_session", { task: "and this one", projectId: "q" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain(`ask ${HOST} to allow project q for you`);
    // The host's own launches are unaffected and record the host.
    const hosts = await h.tool(h.host, "launch_session", { task: "host work", projectId: "q" });
    expect(hosts.isError).toBe(false);
    expect(h.launchCalls.at(-1)!.requester).toBe(HOST);
    expect(h.launchCalls.at(-1)!.task).not.toContain("You are working for");
    expect(h.launchCalls.at(-1)!.allowProjectInference).toBeUndefined();
  });

  test("the host-only tools are refused to a guest's Persona", async () => {
    const h = setUp();
    for (const [name, args] of [
      ["restart_standup", { reason: "roll in a change" }],
      ["update_project_repos", { projectId: "p", repos: ["/repo/x"] }],
      ["decide_knowledge_draft", { draftId: "p/x", decision: "reject", reason: "r" }],
    ] as const) {
      const r = await h.tool(h.guest, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`${HOST}'s alone`);
    }
    expect(listPersonaApprovals(h.store.db, GUEST, "pending")).toHaveLength(0);
  });
});

describe("per-user Persona — floor holds in a guest's worker", () => {
  test("a guest's allow becomes the host's card; its own token can't allow; the host's approval resolves it", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const ask = h.floorAsk(sessionId, FLOOR_GATE, "destructive", "rm -rf /tmp/other-checkout/build");
    pushNotification.mockClear();

    const held = await h.tool(h.guest, "answer_ask", { askId: ask.id, answer: "Allow once" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    const [card] = listPersonaApprovals(h.store.db, GUEST, "pending");
    expect(card).toMatchObject({ owner: GUEST, approver: HOST });
    expect(card!.summary).toContain(`from ${GUEST}'s Persona`);
    expect(pushNotification.mock.calls.some((c) => c[2] === HOST)).toBe(true);
    expect(h.frames.some((f) => f.type === "persona:approval" && f.audience === HOST && (f.payload as PersonaApproval).id === card!.id)).toBe(true);
    // Both see it: the guest owns it, the host decides it.
    for (const who of ["host", "guest"] as const) {
      const { approvals } = await h.json<{ approvals: PersonaApproval[] }>(await h.as(who, "/api/persona/approvals"));
      expect(approvals.map((a) => a.id)).toContain(card!.id);
    }

    // The guest runtime's own token may not allow it on the collector either.
    const direct = await h.app.request(`/api/asks/${ask.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.guest.token },
      body: JSON.stringify({ answer: "Allow once" }),
    });
    expect(direct.status).toBe(403);
    expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");

    // Only its approver decides it.
    const byGuest = await h.as("guest", `/api/persona/approvals/${card!.id}/approve`, { method: "POST", body: "{}" });
    expect(byGuest.status).toBe(403);
    expect(await h.json(byGuest)).toMatchObject({ reason: "approver" });
    const byHost = await h.as("host", `/api/persona/approvals/${card!.id}/approve`, { method: "POST", body: "{}" });
    expect(byHost.status).toBe(200);
    expect((await h.json<{ approval: PersonaApproval }>(byHost)).approval).toMatchObject({ status: "executed", decidedBy: HOST });
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "Allow once", answeredBy: HOST });
  });

  test("an owner-only hold goes to the host too; a deny passes straight through", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const push = h.floorAsk(sessionId, FLOOR_OWNER_GATE, "outward", "git push origin HEAD");
    const held = await h.tool(h.guest, "answer_ask", { askId: push.id, answer: "1" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    expect(listPersonaApprovals(h.store.db, GUEST, "pending")[0]).toMatchObject({ approver: HOST });

    const rm = h.floorAsk(sessionId, FLOOR_GATE, "destructive", "rm -rf /tmp/x");
    const denied = await h.tool(h.guest, "answer_ask", { askId: rm.id, answer: "Deny" });
    expect(denied).toMatchObject({ isError: false, text: "answered" });
    expect(getAsk(h.store.db, rm.id)).toMatchObject({ status: "answered", answer: "Deny", answeredBy: `persona:${GUEST}` });
  });

  test("split mode: the guest's own card decides a review/destructive hold, never an owner-only one", async () => {
    const h = setUp();
    setSetting(h.store.db, GUEST_FLOOR_SETTING, "split");
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const rm = h.floorAsk(sessionId, FLOOR_GATE, "destructive", "rm -rf /tmp/x");
    const held = await h.tool(h.guest, "answer_ask", { askId: rm.id, answer: "Allow once" });
    expect(held.json).toMatchObject({ status: "pending_approval" });
    const card = listPersonaApprovals(h.store.db, GUEST, "pending").find((a) => a.args.askId === rm.id)!;
    expect(card.approver).toBeUndefined();
    // Not the host's to decide.
    expect((await h.as("host", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" })).status).toBe(404);
    const approved = await h.as("guest", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" });
    expect(approved.status).toBe(200);
    expect((await h.json<{ approval: PersonaApproval }>(approved)).approval.status).toBe("executed");
    expect(getAsk(h.store.db, rm.id)).toMatchObject({ status: "answered", answer: "Allow once", answeredBy: `persona:${GUEST}` });

    const pushAsk = h.floorAsk(sessionId, FLOOR_OWNER_GATE, "outward", "git push origin HEAD");
    await h.tool(h.guest, "answer_ask", { askId: pushAsk.id, answer: "Allow once" });
    expect(listPersonaApprovals(h.store.db, GUEST, "pending").find((a) => a.args.askId === pushAsk.id)).toMatchObject({ approver: HOST });
  });

  test("the host's Persona token allows only in a session its own job owns", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const allowWith = (askId: string, token: string) =>
      h.app.request(`/api/asks/${askId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: token },
        body: JSON.stringify({ answer: "Allow once" }),
      });
    for (const [gate, category, command] of [
      [FLOOR_GATE, "destructive", "rm -rf /tmp/x"],
      [FLOOR_OWNER_GATE, "outward", "git push origin HEAD"],
    ] as const) {
      const ask = h.floorAsk(sessionId, gate, category, command);
      expect((await allowWith(ask.id, h.host.token)).status).toBe(403);
      expect(getAsk(h.store.db, ask.id)!.status).toBe("pending");
    }
    const own = await h.ownedSession(h.host);
    const mine = h.floorAsk(own.sessionId, FLOOR_GATE, "destructive", "rm -rf /tmp/y");
    const ok = await h.tool(h.host, "answer_ask", { askId: mine.id, answer: "Allow once", reason: "a scratch dir of this job" });
    expect(ok).toMatchObject({ isError: false, text: "answered" });
    expect(getAsk(h.store.db, mine.id)).toMatchObject({ status: "answered", answeredBy: `persona:${HOST}` });
    const push = h.floorAsk(own.sessionId, FLOOR_OWNER_GATE, "outward", "git push origin HEAD");
    expect((await allowWith(push.id, h.host.token)).status).toBe(200);
    expect(getAsk(h.store.db, push.id)).toMatchObject({ status: "answered", answer: "Allow once", answeredBy: `persona:${HOST}` });
    expect(listPersonaApprovals(h.store.db, HOST, "pending")).toHaveLength(0);
  });

  test("a guest's Persona token can't allow an owner-gated hold, even in split mode", async () => {
    const h = setUp();
    setSetting(h.store.db, GUEST_FLOOR_SETTING, "split");
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const push = h.floorAsk(sessionId, FLOOR_OWNER_GATE, "outward", "git push origin HEAD");
    const direct = await h.app.request(`/api/asks/${push.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.guest.token },
      body: JSON.stringify({ answer: "Allow once" }),
    });
    expect(direct.status).toBe(403);
    expect(getAsk(h.store.db, push.id)!.status).toBe("pending");
    const denied = await h.tool(h.guest, "answer_ask", { askId: push.id, answer: "Deny" });
    expect(denied).toMatchObject({ isError: false, text: "answered" });
    expect(getAsk(h.store.db, push.id)).toMatchObject({ status: "answered", answer: "Deny" });
  });
});

describe("per-user Persona — the host's admin routes", () => {
  test("the host lists every user's Persona; a guest is refused (host-only)", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    createPersonaApproval(h.store.db, { owner: GUEST, action: "launch_session", summary: "s", reason: "r", args: {}, approver: HOST });
    const res = await h.as("host", "/api/persona/users");
    expect(res.status).toBe(200);
    const { users } = await h.json<{ users: Array<{ alias: string; isHost: boolean; state: { paused: boolean }; pendingApprovals: number; access: { launchProjects: string[] } | null }> }>(res);
    expect(users.map((u) => u.alias)).toEqual([HOST, GUEST]);
    expect(users[0]).toMatchObject({ isHost: true, pendingApprovals: 1, access: null });
    expect(users[1]).toMatchObject({ isHost: false, state: { paused: false }, pendingApprovals: 0, access: { launchProjects: ["p"] } });
    const refused = await h.as("guest", "/api/persona/users");
    expect(refused.status).toBe(403);
    expect(await h.json(refused)).toMatchObject({ reason: "host-only" });
    const unsigned = await h.as("guest-unsigned", "/api/persona/users");
    expect(unsigned.status).toBe(403);
    expect(await h.json(unsigned)).toMatchObject({ reason: "sign-in" });
  });

  test("a user listed only by their allowlist has no state and no runtime", async () => {
    const h = setUp();
    const res = await h.as("host", `/api/persona/users/newcomer/access`, { method: "PUT", body: JSON.stringify({ launchProjects: ["p"] }) });
    expect(res.status).toBe(200);
    const { users } = await h.json<{ users: Array<{ alias: string; running: boolean; state: unknown }> }>(await h.as("host", "/api/persona/users"));
    expect(users.find((u) => u.alias === "newcomer")).toMatchObject({ running: false, state: null });
    expect(users.find((u) => u.alias === GUEST)).toMatchObject({ running: true, state: { paused: false } });
    expect(h.fleet.get("newcomer")).toBeUndefined();
    expect(listPersonaOwners(h.store.db)).not.toContain("newcomer");
  });

  test("?user= on /state: the host reads another user's state, built for no one; a guest is refused", async () => {
    const h = setUp();
    const guest = await h.json(await h.as("host", `/api/persona/state?user=${GUEST}`));
    expect(guest).toMatchObject({ owner: GUEST, hostAlias: HOST, isHost: false, threadId: h.guest.consoleThreadId() });
    const absent = await h.json(await h.as("host", `/api/persona/state?user=nobody-yet`));
    expect(absent).toMatchObject({ owner: "nobody-yet", runState: "idle", threadId: "", pendingInbox: 0 });
    expect(h.fleet.get("nobody-yet")).toBeUndefined();
    expect(listPersonaOwners(h.store.db)).not.toContain("nobody-yet");
    const refused = await h.as("guest", `/api/persona/state?user=${HOST}`);
    expect(refused.status).toBe(403);
    expect(await h.json(refused)).toMatchObject({ reason: "host-only" });
    // Naming oneself is one's own state.
    expect(await h.json(await h.as("guest", `/api/persona/state?user=${GUEST}`))).toMatchObject({ owner: GUEST });
  });

  test("pause and resume a user's Persona", async () => {
    const h = setUp();
    expect((await h.as("guest", `/api/persona/users/${GUEST}/pause`, { method: "POST", body: "{}" })).status).toBe(403);
    const paused = await h.as("host", `/api/persona/users/${GUEST}/pause`, { method: "POST", body: "{}" });
    expect(paused.status).toBe(200);
    expect(await h.json(paused)).toMatchObject({ user: { alias: GUEST, state: { paused: true } } });
    expect(h.guest.runState()).toBe("paused");
    expect(h.host.runState()).not.toBe("paused");
    await h.as("host", `/api/persona/users/${GUEST}/resume`, { method: "POST", body: "{}" });
    expect(h.guest.runState()).not.toBe("paused");
  });

  test("?user= shows another user's Persona to the host, read-only", async () => {
    const h = setUp();
    await h.as("guest", "/api/persona/messages", { method: "POST", body: JSON.stringify({ text: "guest note" }) });
    await h.as("guest", "/api/persona/schedules", {
      method: "POST",
      body: JSON.stringify({ title: "guest triage", cron: "0 9 * * 1-5", kind: "wake_persona", note: "n" }),
    });
    const msgs = await h.json<{ threadId: string; messages: Array<{ text: string }> }>(await h.as("host", `/api/persona/messages?user=${GUEST}`));
    expect(msgs.threadId).toBe(h.guest.consoleThreadId());
    expect(msgs.messages.map((m) => m.text)).toEqual(["guest note"]);
    const threads = await h.json<{ threads: Array<{ id: string }> }>(await h.as("host", `/api/persona/threads?user=${GUEST}`));
    expect(threads.threads.map((t) => t.id)).toContain(h.guest.consoleThreadId());
    const schedules = await h.json<SchedulesResponse>(await h.as("host", `/api/persona/schedules?user=${GUEST}`));
    expect(schedules.schedules.map((s) => s.title)).toEqual(["guest triage"]);
    const runs = await h.as("host", `/api/persona/schedules/${schedules.schedules[0]!.id}/runs?user=${GUEST}`);
    expect(runs.status).toBe(200);
    for (const path of ["jobs", "approvals"]) expect((await h.as("host", `/api/persona/${path}?user=${GUEST}`)).status).toBe(200);
    // A guest can't view anyone else's.
    const refused = await h.as("guest", `/api/persona/messages?user=${HOST}`);
    expect(refused.status).toBe(403);
    expect(await h.json(refused)).toMatchObject({ reason: "host-only" });
    // Writes never act on the viewed user: a host's post lands in the host's own Persona.
    const posted = await h.as("host", `/api/persona/messages?user=${GUEST}`, { method: "POST", body: JSON.stringify({ text: "host's own" }) });
    expect(posted.status).toBe(201);
    expect(listPersonaMessages(h.store.db, h.guest.consoleThreadId()).map((m) => m.text)).toEqual(["guest note"]);
  });
});

describe("per-user Persona — the fleet", () => {
  test("re-creates a runtime at start for every owner with stored state, up to its limit", () => {
    const store = createStore(":memory:");
    getOrCreatePersonaState(store.db, "alice");
    getOrCreatePersonaState(store.db, "bob");
    getOrCreatePersonaState(store.db, "carol");
    const built: string[] = [];
    const fleet = new PersonaFleet({
      db: store.db,
      host: HOST,
      maxUsers: 3,
      create: (owner, shared) => {
        built.push(owner);
        const runtime = new PersonaRuntime({
          db: store.db,
          owner,
          host: shared.host,
          turnSlots: shared.turnSlots,
          config: resolvePersonaConfig({}),
          broadcast: () => {},
          turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "s" }),
        });
        stoppers.push(() => runtime.stop());
        return runtime;
      },
    });
    const skipped = fleet.start();
    expect(built).toEqual([HOST, "alice", "bob"]);
    expect(skipped).toEqual([{ owner: "carol", reason: expect.stringContaining("STANDUP_PERSONA_MAX_USERS") }]);
    expect(fleet.getOrCreate("carol")).toBeUndefined();
    expect(fleet.unavailableReason("carol")).toContain("STANDUP_PERSONA_MAX_USERS");
    expect(fleet.getOrCreate("../etc")).toBeUndefined();
    expect(fleet.get("alice")!.isHost).toBe(false);
    expect(fleet.hostRuntime().isHost).toBe(true);
    fleet.stop();
  });

  test("the turn semaphore holds turns past its limit until one ends", async () => {
    const { TurnSemaphore } = await import("./fleet.js");
    const slots = new TurnSemaphore(2);
    const a = await slots.acquire();
    const b = await slots.acquire();
    let third = false;
    const c = slots.acquire().then((release) => {
      third = true;
      return release;
    });
    await Bun.sleep(5);
    expect(third).toBe(false);
    a();
    (await c)();
    expect(third).toBe(true);
    b();
    expect(slots.active).toBe(0);
  });

  test("a guest's turn cwd is its own directory under the host's", async () => {
    const { personaTurnCwd } = await import("./fleet.js");
    expect(personaTurnCwd("/base", HOST, HOST)).toBe("/base");
    expect(personaTurnCwd("/base", GUEST, HOST)).toBe(`/base/users/${GUEST}`);
    expect(() => personaTurnCwd("/base", "../x", HOST)).toThrow();
  });

  /**
   * A fleet of real runtimes whose turns run `turns[owner]` (a silent reply
   * when unset), counting each runtime's start() calls.
   */
  const testFleet = (opts: { maxConcurrentTurns?: number } = {}) => {
    const store = createStore(":memory:");
    const starts = new Map<string, number>();
    const turnsRun = new Map<string, number>();
    const turns = new Map<string, () => Promise<void>>();
    const fleet = new PersonaFleet({
      db: store.db,
      host: HOST,
      maxConcurrentTurns: opts.maxConcurrentTurns,
      create: (owner, shared) => {
        const runtime = new PersonaRuntime({
          db: store.db,
          owner,
          host: shared.host,
          turnSlots: shared.turnSlots,
          config: resolvePersonaConfig({}),
          broadcast: () => {},
          turnRunner: async () => {
            turnsRun.set(owner, (turnsRun.get(owner) ?? 0) + 1);
            await turns.get(owner)?.();
            return { ok: true, text: "[silent]", sessionId: `s-${owner}` };
          },
        });
        const start = runtime.start.bind(runtime);
        runtime.start = () => {
          starts.set(owner, (starts.get(owner) ?? 0) + 1);
          start();
        };
        stoppers.push(() => runtime.stop());
        return runtime;
      },
    });
    return { store, fleet, starts, turnsRun, turns };
  };

  /** Runs `body` with setInterval/clearInterval tracked; returns the intervals still live afterwards. */
  const liveIntervalsAfter = async (body: () => void | Promise<void>): Promise<number> => {
    const live = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      live.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearInterval;
    try {
      await body();
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
    for (const id of live) realClear(id as ReturnType<typeof setInterval>);
    return live.size;
  };

  test("start() starts each runtime once, a stored guest's included, and stop() leaves no interval running", async () => {
    const t = testFleet();
    getOrCreatePersonaState(t.store.db, GUEST);
    const leaked = await liveIntervalsAfter(() => {
      t.fleet.start();
      t.fleet.start();
      t.fleet.stop();
    });
    expect(Object.fromEntries(t.starts)).toEqual({ [HOST]: 1, [GUEST]: 1 });
    expect(leaked).toBe(0);
  });

  test("a runtime's start() is a no-op while it runs, so a second call leaks no interval", async () => {
    const t = testFleet();
    const runtime = t.fleet.hostRuntime();
    const leaked = await liveIntervalsAfter(() => {
      runtime.start();
      runtime.start();
      runtime.schedules.start();
      runtime.stop();
    });
    expect(leaked).toBe(0);
  });

  test("a runtime built while the fleet is held for a restart takes no turn until release()", async () => {
    const t = testFleet();
    t.fleet.start();
    expect(await t.fleet.quiesce(1_000)).toBe(true);
    expect(t.fleet.isHeld).toBe(true);
    const guest = t.fleet.getOrCreate(GUEST)!;
    guest.receiveUserMessage({ text: "hello", actor: GUEST });
    await guest.drain();
    expect(t.turnsRun.get(GUEST) ?? 0).toBe(0);
    expect(listPendingPersonaInbox(t.store.db, GUEST).filter((i) => i.kind === "user_message")).toHaveLength(1);
    t.fleet.release();
    await guest.drain();
    expect(t.turnsRun.get(GUEST)).toBe(1);
    t.fleet.stop();
  });

  test("a turn waiting for the host-wide slot when a hold begins runs no turn and leaves its items pending", async () => {
    const t = testFleet({ maxConcurrentTurns: 1 });
    t.fleet.start();
    const host = t.fleet.hostRuntime();
    const guest = t.fleet.getOrCreate(GUEST)!;
    let finishHostTurn!: () => void;
    t.turns.set(HOST, () => new Promise<void>((resolve) => (finishHostTurn = resolve)));
    host.receiveUserMessage({ text: "long one", actor: HOST });
    const hostDrain = host.drain();
    await Bun.sleep(5);
    expect(t.fleet.turnSlots.active).toBe(1);
    // The guest's turn claims its items, then waits for the only slot.
    guest.receiveUserMessage({ text: "queued", actor: GUEST });
    const guestDrain = guest.drain();
    await Bun.sleep(5);
    const quiet = t.fleet.quiesce(2_000);
    finishHostTurn();
    await Promise.all([hostDrain, guestDrain]);
    expect(await quiet).toBe(true);
    expect(t.turnsRun.get(HOST)).toBe(1);
    expect(t.turnsRun.get(GUEST) ?? 0).toBe(0);
    expect(t.fleet.turnSlots.active).toBe(0);
    expect(listPendingPersonaInbox(t.store.db, GUEST).filter((i) => i.kind === "user_message")).toHaveLength(1);
    t.fleet.release();
    await guest.drain();
    expect(t.turnsRun.get(GUEST)).toBe(1);
    t.fleet.stop();
  });
});

describe("per-user Persona — reads build nothing", () => {
  test("GETs from 20 signed-in users build no runtime, state row or thread; their first write builds one", async () => {
    const h = setUp();
    const runtimesBefore = h.fleet.all().length;
    const ownersBefore = listPersonaOwners(h.store.db);
    const signedIn = (alias: string) => ({
      "content-type": "application/json",
      [DEFAULT_IDENTITY_HEADER]: alias,
      [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, alias),
    });
    for (let i = 0; i < 20; i++) {
      const alias = `reader${i}`;
      for (const path of [
        "/api/persona/state",
        "/api/persona/messages",
        "/api/persona/threads",
        "/api/persona/jobs",
        "/api/persona/approvals",
        "/api/persona/schedules",
        "/api/persona/hold-report",
        "/api/persona/knowledge-decisions",
      ]) {
        const res = await h.app.request(path, { headers: signedIn(alias) });
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        if (path === "/api/persona/state") {
          expect(await res.json()).toMatchObject({ owner: alias, runState: "idle", threadId: "", isHost: false, canWrite: true });
        }
        if (path === "/api/persona/messages") expect(await res.json()).toEqual({ threadId: "", messages: [] });
        if (path === "/api/persona/threads") expect(await res.json()).toEqual({ threads: [] });
      }
    }
    expect(h.fleet.all().length).toBe(runtimesBefore);
    expect(listPersonaOwners(h.store.db)).toEqual(ownersBefore);
    const threads = h.store.db.query("SELECT COUNT(*) AS n FROM persona_threads WHERE owner LIKE 'reader%'").get() as { n: number };
    expect(threads.n).toBe(0);

    const sent = await h.app.request("/api/persona/messages", {
      method: "POST",
      headers: signedIn("reader0"),
      body: JSON.stringify({ text: "hi" }),
    });
    expect(sent.status).toBe(201);
    expect(h.fleet.all().length).toBe(runtimesBefore + 1);
    expect(h.fleet.get("reader0")).toBeDefined();
    expect(listPersonaOwners(h.store.db)).toContain("reader0");
  });
});

describe("per-user Persona — deciding a card whose owner has no runtime", () => {
  test("the host denies it without a runtime; the result waits in the owner's inbox; approve is 503", async () => {
    const h = setUp();
    for (let i = h.fleet.all().length; i < h.fleet.maxUsers; i++) expect(h.fleet.getOrCreate(`filler${i}`)).toBeDefined();
    const card = createPersonaApproval(h.store.db, {
      owner: "overflow",
      action: "launch_session",
      summary: "overflow's card",
      reason: "held",
      args: {},
      approver: HOST,
    });
    const approve = await h.as("host", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" });
    expect(approve.status).toBe(503);
    expect(await h.json(approve)).toMatchObject({ reason: "unavailable" });
    h.frames.length = 0;
    const denied = await h.as("host", `/api/persona/approvals/${card.id}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason: "not now" }),
    });
    expect(denied.status).toBe(200);
    expect(await h.json(denied)).toMatchObject({ approval: { id: card.id, status: "denied", decidedBy: HOST } });
    expect(h.fleet.get("overflow")).toBeUndefined();
    const results = listPendingPersonaInbox(h.store.db, "overflow").filter((i) => i.kind === "approval_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.payload).toMatchObject({ approvalId: card.id, status: "denied", decidedBy: HOST, reason: "not now" });
    expect(h.frames.filter((f) => f.type === "persona:approval").map((f) => f.audience).sort()).toEqual([HOST, "overflow"].sort());
    // Denied once: a second deny is not pending.
    expect((await h.as("host", `/api/persona/approvals/${card.id}/deny`, { method: "POST", body: "{}" })).status).toBe(409);
  });

  const fillFleet = (h: Harness) => {
    for (let i = h.fleet.all().length; i < h.fleet.maxUsers; i++) expect(h.fleet.getOrCreate(`filler${i}`)).toBeDefined();
  };
  const overflowCard = (h: Harness, extra: { jobId?: string } = {}) =>
    createPersonaApproval(h.store.db, {
      owner: "overflow",
      action: "launch_session",
      summary: "overflow's card",
      reason: "held",
      args: {},
      approver: HOST,
      ...extra,
    });
  const age = (h: Harness, id: string) =>
    h.store.db.run("UPDATE persona_approvals SET created_at = ? WHERE id = ?", [new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), id]);

  test("approving an expired or decided card is 409 before the missing runtime's 503", async () => {
    const h = setUp();
    fillFleet(h);
    const stale = overflowCard(h);
    age(h, stale.id);
    const res = await h.as("host", `/api/persona/approvals/${stale.id}/approve`, { method: "POST", body: "{}" });
    expect(res.status).toBe(409);
    expect(await h.json(res)).toMatchObject({ error: "Approval has expired" });
    const decided = overflowCard(h);
    expect((await h.as("host", `/api/persona/approvals/${decided.id}/deny`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await h.as("host", `/api/persona/approvals/${decided.id}/approve`, { method: "POST", body: "{}" })).status).toBe(409);
  });

  test("a card with no thread of its own, denied without a runtime, reports to its job's thread", async () => {
    const h = setUp();
    fillFleet(h);
    const thread = getOrCreatePersonaThreadByRef(h.store.db, "overflow", "slack", "dm:D77");
    const job = createPersonaJob(h.store.db, { owner: "overflow", threadId: thread.id, title: "t", goal: "g" });
    const card = overflowCard(h, { jobId: job.id });
    expect(card.threadId).toBeFalsy();
    expect((await h.as("host", `/api/persona/approvals/${card.id}/deny`, { method: "POST", body: "{}" })).status).toBe(200);
    const results = listPendingPersonaInbox(h.store.db, "overflow").filter((i) => i.kind === "approval_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.threadId).toBe(thread.id);
  });

  test("the host's tick expires a stale card whose owner has no runtime; a running owner's tick keeps its own", async () => {
    const h = setUp();
    fillFleet(h);
    const thread = getOrCreatePersonaThreadByRef(h.store.db, "overflow", "slack", "dm:D78");
    const job = createPersonaJob(h.store.db, { owner: "overflow", threadId: thread.id, title: "t", goal: "g" });
    const stale = overflowCard(h, { jobId: job.id });
    const fresh = overflowCard(h);
    age(h, stale.id);
    const guestCard = createPersonaApproval(h.store.db, { owner: GUEST, action: "remember", summary: "s", args: {} });
    age(h, guestCard.id);
    h.frames.length = 0;
    await h.host.tick();
    expect(getPersonaApproval(h.store.db, stale.id)?.status).toBe("expired");
    expect(getPersonaApproval(h.store.db, fresh.id)?.status).toBe("pending");
    // The guest has a runtime, whose own tick expires its card.
    expect(getPersonaApproval(h.store.db, guestCard.id)?.status).toBe("pending");
    const results = listPendingPersonaInbox(h.store.db, "overflow").filter((i) => i.kind === "approval_result");
    expect(results.map((r) => [r.payload.approvalId, r.payload.status, r.threadId])).toEqual([[stale.id, "expired", thread.id]]);
    const expiredFrames = h.frames.filter((f) => f.type === "persona:approval" && (f.payload as PersonaApproval).id === stale.id);
    expect(expiredFrames.map((f) => f.audience).sort()).toEqual([HOST, "overflow"].sort());
    expect(h.fleet.get("overflow")).toBeUndefined();
  });

  /** A pending safety-floor hold on an overflow worker, and the overflow card answering it `answer`. */
  const overflowFloorCard = (h: Harness, answer: string) => {
    const sessionId = randomUUID();
    createSession(h.store.db, { id: sessionId, projectId: "p", title: "worker", cwd: "/w", status: "waiting" });
    const ask = createAsk(h.store.db, sessionId, "ask_human", "Safety floor held a Bash call (floor-tamper): cat secret. Only the owner can allow this.", [...FLOOR_OPTIONS], {
      gate: FLOOR_OWNER_GATE,
      requestId: `toolu_${randomUUID()}`,
      floorExpiresAt: new Date(Date.now() + 3_600_000),
    });
    const card = createPersonaApproval(h.store.db, {
      owner: "overflow",
      action: "answer_ask",
      summary: "overflow's floor card",
      reason: "held",
      args: { askId: ask.id, answer },
      approver: HOST,
    });
    return { ask, card };
  };

  test("denying a floor card whose hold was already decided reports what happened, not a deny", async () => {
    const h = setUp();
    fillFleet(h);
    const { ask, card } = overflowFloorCard(h, "Allow once");
    h.store.db.run("UPDATE asks SET status = 'answered', answer = 'Deny', answered_by = 'alice' WHERE id = ?", [ask.id]);
    const res = await h.as("host", `/api/persona/approvals/${card.id}/deny`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await h.json(res)).toMatchObject({ approval: { id: card.id, status: "superseded", result: expect.stringContaining("already denied by alice") } });
    const results = listPendingPersonaInbox(h.store.db, "overflow").filter((i) => i.kind === "approval_result");
    expect(results.map((r) => r.payload.status)).toEqual(["superseded"]);
  });

  test("approving a floor card whose hold timed out closes it as expired rather than refusing for the missing runtime", async () => {
    const h = setUp();
    fillFleet(h);
    const { ask, card } = overflowFloorCard(h, "Allow once");
    h.store.db.run("UPDATE asks SET status = 'timeout' WHERE id = ?", [ask.id]);
    const res = await h.as("host", `/api/persona/approvals/${card.id}/approve`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await h.json(res)).toMatchObject({ approval: { status: "expired", result: expect.stringContaining("timed out") } });
  });

  test("denying a card holding Persona's own Deny leaves the hold pending", async () => {
    const h = setUp();
    fillFleet(h);
    const { ask, card } = overflowFloorCard(h, "Deny");
    const res = await h.as("host", `/api/persona/approvals/${card.id}/deny`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(await h.json(res)).toMatchObject({ approval: { status: "denied" } });
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
    await h.host.tick();
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
  });

  test("denying a floor allow card without a runtime denies the hold as the decider and puts the worker back to running", async () => {
    const h = setUp();
    fillFleet(h);
    const { ask, card } = overflowFloorCard(h, "Allow once");
    h.frames.length = 0;
    const res = await h.as("host", `/api/persona/approvals/${card.id}/deny`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const { approval } = (await h.json(res)) as { approval: PersonaApproval };
    expect(approval.status).toBe("denied");
    expect(getAsk(h.store.db, ask.id)).toMatchObject({ status: "answered", answer: "Deny", answeredBy: approval.decidedBy });
    expect(getParticipants(h.store.db, ask.sessionId).map((p) => p.actorId)).toContain(approval.decidedBy!);
    expect(getSession(h.store.db, ask.sessionId)?.status).toBe("running");
    expect(h.frames.some((f) => f.type === "ask:resolved" && (f.payload as { askId: string }).askId === ask.id)).toBe(true);
    expect(
      h.frames.some((f) => f.type === "session:status" && (f.payload as { sessionId: string; status: string }).sessionId === ask.sessionId)
    ).toBe(true);
  });

  test("the host's tick closes a floor card whose hold was settled, for an owner with no runtime", async () => {
    const h = setUp();
    fillFleet(h);
    const { ask, card } = overflowFloorCard(h, "Allow once");
    h.store.db.run("UPDATE asks SET status = 'answered', answer = 'Allow once', answered_by = 'alice' WHERE id = ?", [ask.id]);
    await h.host.tick();
    expect(getPersonaApproval(h.store.db, card.id)).toMatchObject({ status: "superseded", result: expect.stringContaining("already allowed by alice") });
  });
});

describe("per-user Persona — a host alias outside the guest alias rule", () => {
  test("a host whose STANDUP_HOST_USER carries an '@' reads and directs its Persona, and the bare health probe answers", async () => {
    const prev = process.env.STANDUP_HOST_USER;
    process.env.STANDUP_HOST_USER = "jdoe@corp.example.com";
    try {
      const host = resolveUserAlias(undefined);
      expect(host).toBe("jdoe@corp.example.com");
      const store = createStore(":memory:");
      const root = mkdtempSync(join(tmpdir(), "persona-at-host-"));
      dirs.push(root);
      const secrets = generateOwnerSecrets();
      const runtime = new PersonaRuntime({
        db: store.db,
        owner: host,
        turnCwd: root,
        config: resolvePersonaConfig({}),
        broadcast: () => {},
        dataDir: join(root, "data"),
        turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
        ownerToken: () => secrets.ownerToken,
      });
      stoppers.push(() => runtime.stop());
      const fleet = PersonaFleet.of(runtime, store.db);
      const app = createServer(store, () => {}, null, undefined, undefined, undefined, "", {}, undefined, undefined, undefined, undefined, {
        fleet,
        ownerSecrets: secrets,
      });
      const owner = { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken };

      const state = await app.request("/api/persona/state", { headers: owner });
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ owner: host, hostAlias: host, isHost: true, canWrite: true });
      const sent = await app.request("/api/persona/messages", { method: "POST", headers: owner, body: JSON.stringify({ text: "hi" }) });
      expect(sent.status).toBe(201);
      const relayed = await app.request("/api/persona/state", { headers: { ...owner, [PERSONA_USER_HEADER]: host } });
      expect(relayed.status).toBe(200);

      const probe = await app.request("/api/persona/state");
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual({ runState: "idle", hostAlias: host, isHost: true, canWrite: false, reason: "sign-in" });
    } finally {
      if (prev === undefined) delete process.env.STANDUP_HOST_USER;
      else process.env.STANDUP_HOST_USER = prev;
    }
  });
});

describe("per-user Persona — a guest's launch checks before the idempotency dedupe", () => {
  test("a key naming an existing launch can't hand a guest's Persona a launch it may not make", async () => {
    const h = setUp();
    const existing = createLaunch(h.store.db, {
      id: randomUUID(),
      projectId: "q",
      task: "the host's own",
      worktreePath: "/tmp/wt-host",
      branch: "b",
      idempotencyKey: "host-key",
    });
    const res = await h.app.request("/api/projects/q/launch", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: h.guest.token },
      body: JSON.stringify({ task: "anything", idempotencyKey: "host-key" }),
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(existing.id);
    expect(body).toContain("may not launch into project q");
  });
});

describe("per-user Persona — a guest's attach_image stays inside its own ground", () => {
  test("only its own turn directory and its own workers' worktrees", async () => {
    const h = setUp();
    await h.allowGuest(["p"]);
    const { sessionId } = await h.ownedSession(h.guest);
    const worktree = join(h.root, "guest-worktree");
    mkdirSync(worktree, { recursive: true });
    h.store.db.run("UPDATE sessions SET cwd = ? WHERE id = ?", [worktree, sessionId]);
    const results: Record<string, { isError: boolean; text: string }> = {};
    await h.inTurn(h.guest, async () => {
      results.turnCwd = await h.tool(h.guest, "attach_image", { path: h.image("own.png", h.turnCwdOf(GUEST)) });
      results.worktree = await h.tool(h.guest, "attach_image", { path: h.image("shot.png", worktree) });
      results.elsewhere = await h.tool(h.guest, "attach_image", { path: h.image("hosts.png") });
      results.hostTurnCwd = await h.tool(h.guest, "attach_image", { path: h.image("host-own.png", h.turnCwdOf(HOST)) });
    });
    expect(results.turnCwd!.isError).toBe(false);
    expect(results.worktree!.isError).toBe(false);
    for (const refused of [results.elsewhere!, results.hostTurnCwd!]) {
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("only images inside its own workers' worktrees");
    }
    // The host's Persona attaches from anywhere the floor allows.
    let hostResult: { isError: boolean } | undefined;
    await h.inTurn(h.host, async () => {
      hostResult = await h.tool(h.host, "attach_image", { path: h.image("anywhere.png") });
    });
    expect(hostResult!.isError).toBe(false);
  });
});
