import { afterAll, beforeAll, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createPersonaApproval, createPersonaJob, createStore, getNotifyPrefs, listPersonaBriefRuns, updateLaunchStatus, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import type { NotifyPrefs, PersonaMessage, Snapshot } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, DEFAULT_NOTIFY_PREFS } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { generateOwnerSecrets } from "../owner-secret.js";
import { FakeProcessSystem } from "../process-registry-fake.js";
import { KnowledgeSync } from "../knowledge-sync.js";
import type { TurnSlots } from "./fleet.js";
import type { TurnInput, TurnResult } from "./turn.js";
import { BRIEF_HEADING } from "./prompt.js";
import { nextBriefSlot } from "./brief.js";

// Phone pushes leave the host: record them, and lift the stub afterwards —
// mock.module is process-wide.
import * as push from "../push.js";
const realPush = { ...push };
const pushes: Array<{ title: string; body: string; recipient: string | null | undefined }> = [];
mock.module("../push.js", () => ({
  ...realPush,
  pushNotification: async (title: string, body: string, recipient?: string | null) => {
    pushes.push({ title, body, recipient });
  },
}));

const { createServer, resolveUserAlias, resolveIdentityConfigFromEnv } = await import("../server.js");
const { createWsServer } = await import("../ws.js");
const { PersonaRuntime } = await import("./runtime.js");
const { PersonaFleet } = await import("./fleet.js");
const { createBroadcastTap } = await import("./events.js");
const { resolvePersonaConfig } = await import("./config.js");
const { PERSONA_TOKEN_HEADER } = await import("./routes.js");
type Runtime = InstanceType<typeof PersonaRuntime>;

const HOST = resolveUserAlias(undefined);
const GUEST = "luportoi";
const NY = "America/New_York";
/** The next 08:30 in New York; rows the test writes (stamped with the wall clock) fall in the day before it. */
const SLOT = nextBriefSlot("08:30", NY, new Date())!;

type Me = "host" | "guest";
type Who = Me | "forged" | "bare";

interface Harness {
  root: string;
  store: Store;
  fleet: InstanceType<typeof PersonaFleet>;
  secrets: ReturnType<typeof generateOwnerSecrets>;
  base: string;
  clock: { ms: number };
  /** Every turn prompt, by owner. */
  prompts: Map<string, string[]>;
  /** Bodies run inside the next turn of an owner's Persona; each returns the turn's reply. */
  turnBodies: Map<string, Array<() => Promise<string>>>;
  stopHttp: () => void;
  stopWs: () => void;
}

let h: Harness;

function findFreePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port!;
}

/** The fake turn's brief, so a test can find it in that owner's thread. */
const briefFor = (owner: string) => `Brief for ${owner}: one approval waits.`;

function buildHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "persona-brief-e2e-"));
  const store = createStore(join(root, "standup.db"));
  upsertProject(store.db, { id: "p", name: "Project P", branch: "main", repos: ["/repo/p"] });
  upsertProject(store.db, { id: "global", name: "Global", branch: "main", repos: [], reserved: true });
  const knowledgeDir = join(root, "kb");
  const dataDir = join(root, "data");
  const secrets = generateOwnerSecrets();
  // Before the slot, so the runtimes' own start-up tick doesn't fire it.
  const clock = { ms: SLOT.getTime() - 10 * 60_000 };

  const wsServer = createWsServer(findFreePort(), async () => ({}) as Snapshot, () => {}, resolveIdentityConfigFromEnv(), {
    ownerSecrets: () => secrets,
  });
  const tap = createBroadcastTap(wsServer.broadcast);
  const prompts = new Map<string, string[]>();
  const turnBodies = new Map<string, Array<() => Promise<string>>>();
  const runtimeFor = (owner: string, shared?: { turnSlots: TurnSlots; host: string }): Runtime => {
    const turnCwd = join(root, "turns", owner);
    mkdirSync(turnCwd, { recursive: true });
    return new PersonaRuntime({
      db: store.db,
      owner,
      host: shared?.host,
      turnSlots: shared?.turnSlots,
      turnCwd,
      config: resolvePersonaConfig({}),
      broadcast: tap.broadcast,
      dataDir,
      now: () => new Date(clock.ms),
      // The test drives every tick itself.
      tickMs: 60 * 60_000,
      dailyBrief: true,
      turnRunner: async (input: TurnInput): Promise<TurnResult> => {
        prompts.set(owner, [...(prompts.get(owner) ?? []), input.prompt]);
        const body = turnBodies.get(owner)?.shift();
        const text = body ? await body() : briefFor(owner);
        return { ok: true, text, sessionId: `sid-${owner}` };
      },
      ownerToken: () => secrets.ownerToken,
    });
  };
  const fleet = new PersonaFleet({ db: store.db, host: HOST, create: runtimeFor });
  tap.subscribe(fleet.eventListener());

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
    undefined,
    undefined,
    { fleet, ownerSecrets: secrets },
    {},
    // Stopping a worker and a closed job's hygiene run against fakes, never real tmux or processes.
    {
      paneAlive: () => false,
      processes: new FakeProcessSystem(),
      stopLaunch: async (db, launch, { pause }) => {
        if (!pause) updateLaunchStatus(db, launch.id, "failed", "Stopped by you");
        return { ok: true, log: [] };
      },
    }
  );
  fleet.start();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return {
    root,
    store,
    fleet,
    secrets,
    base: `http://127.0.0.1:${server.port}`,
    clock,
    prompts,
    turnBodies,
    stopHttp: () => server.stop(true),
    stopWs: () => wsServer.close?.(),
  };
}

/**
 * Headers of a request from `who`. A signed-in user's browser reaches the
 * collector through the console's proxy, which adds the owner token; the
 * guest's also carries their tunnel identity and user channel token.
 */
function headersOf(who: Who): Record<string, string> {
  switch (who) {
    case "host":
      return { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken };
    case "guest":
      return {
        [OWNER_TOKEN_HEADER]: h.secrets.ownerToken,
        [DEFAULT_IDENTITY_HEADER]: GUEST,
        [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, GUEST),
      };
    case "forged":
      return { [DEFAULT_IDENTITY_HEADER]: GUEST };
    case "bare":
      return {};
  }
}

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
const runtimeOf = (me: Me): Runtime => h.fleet.getOrCreate(aliasOf(me))!;

/** One of `runtime`'s tool calls, as its turn's MCP proxy makes it. */
async function tool(runtime: Runtime, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${h.base}/api/persona/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
    body: JSON.stringify({ name, arguments: args }),
  });
  expect(res.status).toBe(200);
  const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: !!result.isError, text: result.content.map((c) => c.text).join("") };
}

interface PrefsView {
  global: Record<string, unknown> | null;
  project: Record<string, unknown> | null;
  resolved: NotifyPrefs;
  defaults: NotifyPrefs;
  projects: string[];
  brief: { enabled: boolean; auto: boolean; timezone: string; nextAt: string | null; reportSchedules: unknown[]; recent: Array<{ slot: string; status: string }> };
}

const put = (who: Who, override: unknown, query = "") =>
  as(who, `/api/notify-prefs${query}`, { method: "PUT", body: JSON.stringify({ override }) });

/** Each user's own work, named so a leak into the other's brief is visible. */
const work: Record<Me, { jobTitle: string; approvalSummary: string; jobId: string }> = {
  host: { jobTitle: "Host's zebra migration", approvalSummary: "launch the host's zebra worker", jobId: "" },
  guest: { jobTitle: "Guest's okapi refactor", approvalSummary: "launch the guest's okapi worker", jobId: "" },
};

beforeAll(() => {
  expect(HOST).not.toBe(GUEST);
  h = buildHarness();
});

afterAll(() => {
  h?.fleet.stop();
  h?.stopHttp();
  h?.stopWs();
  mock.module("../push.js", () => realPush);
  h?.store.db.close();
  if (h) rmSync(h.root, { recursive: true, force: true });
});

describe("notify-prefs routes, per signed-in user", () => {
  test("GET: the defaults for a user who set nothing", async () => {
    const res = await as("host", "/api/notify-prefs");
    expect(res.status).toBe(200);
    const view = await json<PrefsView>(res);
    expect(view.global).toBeNull();
    expect(view.project).toBeNull();
    expect(view.resolved).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(view.defaults).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(view.projects).toEqual([]);
    expect(view.brief).toMatchObject({ enabled: true, auto: true, reportSchedules: [] });
    // The runtime's start-up tick found the previous day's slot long past and left it alone.
    expect(view.brief.recent).toEqual([]);
  });

  test("GET: privatePush is true for the host and false for a guest when no owner-topic map is set", async () => {
    const previousTopics = process.env.NTFY_OWNER_TOPICS;
    delete process.env.NTFY_OWNER_TOPICS;
    try {
      expect((await json<{ privatePush: boolean }>(await as("host", "/api/notify-prefs"))).privatePush).toBe(true);
      expect((await json<{ privatePush: boolean }>(await as("guest", "/api/notify-prefs"))).privatePush).toBe(false);
      process.env.NTFY_OWNER_TOPICS = `${GUEST}:guest-topic`;
      expect((await json<{ privatePush: boolean }>(await as("guest", "/api/notify-prefs"))).privatePush).toBe(true);
      expect((await json<{ privatePush: boolean }>(await as("host", "/api/notify-prefs"))).privatePush).toBe(false);
    } finally {
      if (previousTopics === undefined) delete process.env.NTFY_OWNER_TOPICS;
      else process.env.NTFY_OWNER_TOPICS = previousTopics;
    }
  });

  test("PUT: a malformed layer is a 400 listing every problem, and nothing is stored", async () => {
    const res = await put("host", { routes: { done: { channels: ["email"] } }, brief: { time: "8am" }, extra: 1 });
    expect(res.status).toBe(400);
    const body = await json<{ errors: string[] }>(res);
    expect(body.errors).toHaveLength(3);
    expect(body.errors).toContain("brief.time must be HH:MM (24-hour)");
    expect((await put("host", "not an object")).status).toBe(400);
    expect(
      (await as("host", "/api/notify-prefs", { method: "PUT", body: "{not json" })).status
    ).toBe(400);
    expect(getNotifyPrefs(h.store.db, HOST)).toBeNull();
  });

  test("PUT: each user stores their own global layer, with their timezone", async () => {
    for (const me of ["host", "guest"] as const) {
      const res = await put(me, { timezone: NY });
      expect(res.status).toBe(200);
      const view = await json<PrefsView>(res);
      expect(view.global).toEqual({ timezone: NY });
      expect(view.resolved.timezone).toBe(NY);
      expect(view.brief.nextAt).toBe(SLOT.toISOString());
    }
    expect(getNotifyPrefs(h.store.db, HOST)).toEqual({ timezone: NY });
    expect(getNotifyPrefs(h.store.db, GUEST)).toEqual({ timezone: NY });
  });

  test("a project layer overrides the global one in that project's resolved prefs only", async () => {
    const res = await put("guest", { routes: { progress: { channels: ["slack"], when: "always" } } }, "?project=p");
    expect(res.status).toBe(200);
    const view = await json<PrefsView>(res);
    expect(view.project).toEqual({ routes: { progress: { channels: ["slack"], when: "always" } } });
    expect(view.resolved.routes.progress).toEqual({ channels: ["slack"], when: "always" });
    expect(view.resolved.timezone).toBe(NY);
    expect(view.projects).toEqual(["p"]);

    const global = await json<PrefsView>(await as("guest", "/api/notify-prefs"));
    expect(global.resolved.routes.progress).toEqual(DEFAULT_NOTIFY_PREFS.routes.progress);
    expect(global.projects).toEqual(["p"]);

    // The brief and timezone are user-level only; an unknown project is a 404.
    expect((await put("guest", { brief: { enabled: false } }, "?project=p")).status).toBe(400);
    expect((await put("guest", { routes: { brief: { channels: [] } } }, "?project=p")).status).toBe(400);
    expect((await put("guest", {}, "?project=nope")).status).toBe(404);
    expect((await as("guest", "/api/notify-prefs?project=nope")).status).toBe(404);
  });

  test("one user can neither see nor change another's layers", async () => {
    const hostView = await json<PrefsView>(await as("host", "/api/notify-prefs?project=p"));
    expect(hostView.project).toBeNull();
    expect(hostView.projects).toEqual([]);
    expect(hostView.resolved.routes.progress).toEqual(DEFAULT_NOTIFY_PREFS.routes.progress);

    // The host's DELETE of "the project layer" removes only the host's (none).
    expect((await as("host", "/api/notify-prefs?project=p", { method: "DELETE" })).status).toBe(200);
    expect(getNotifyPrefs(h.store.db, GUEST, "p")).toEqual({ routes: { progress: { channels: ["slack"], when: "always" } } });
    // The guest deletes their own.
    const deleted = await json<PrefsView>(await as("guest", "/api/notify-prefs?project=p", { method: "DELETE" }));
    expect(deleted.project).toBeNull();
    expect(deleted.projects).toEqual([]);
    expect(getNotifyPrefs(h.store.db, GUEST)).toEqual({ timezone: NY });
  });

  test("Persona's token, a forged identity and a header-less caller are refused", async () => {
    const runtime = runtimeOf("guest");
    const personaHeaders: Array<Record<string, string>> = [
      { [PERSONA_TOKEN_HEADER]: runtime.token },
      { [PERSONA_TOKEN_HEADER]: runtime.token, [OWNER_TOKEN_HEADER]: h.secrets.ownerToken },
    ];
    for (const headers of personaHeaders) {
      for (const [method, path, body] of [
        ["GET", "/api/notify-prefs", undefined],
        ["PUT", "/api/notify-prefs", JSON.stringify({ override: { brief: { enabled: false } } })],
        ["DELETE", "/api/notify-prefs", undefined],
        ["GET", "/api/notify-prefs/brief/preview", undefined],
      ] as const) {
        const res = await fetch(`${h.base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
        expect((await json<{ error: string }>(res)).error).toContain("Persona's token cannot be used");
      }
    }
    for (const who of ["forged", "bare"] as const) {
      expect((await as(who, "/api/notify-prefs")).status).toBe(403);
      expect((await put(who, { brief: { enabled: false } })).status).toBe(403);
    }
    expect(getNotifyPrefs(h.store.db, GUEST)).toEqual({ timezone: NY });
  });
});

describe("ACCEPTANCE: each user's 08:30 brief covers only their own work and lands in their own console", () => {
  test("setup: each user has their own job and approval", () => {
    for (const me of ["host", "guest"] as const) {
      const runtime = runtimeOf(me);
      expect(runtime.owner).toBe(aliasOf(me));
      const job = createPersonaJob(h.store.db, { owner: aliasOf(me), threadId: runtime.consoleThreadId(), title: work[me].jobTitle, goal: "g" });
      work[me].jobId = job.id;
      createPersonaApproval(h.store.db, { owner: aliasOf(me), jobId: job.id, action: "launch_session", summary: work[me].approvalSummary, args: {} });
    }
  });

  test("the preview shows each user only their own digest", async () => {
    for (const me of ["host", "guest"] as const) {
      const res = await as(me, "/api/notify-prefs/brief/preview");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain(work[me].jobTitle);
      expect(text).toContain(work[me].approvalSummary);
      expect(text).not.toContain(work[otherOf(me)].jobTitle);
      expect(text).not.toContain(work[otherOf(me)].approvalSummary);
      expect(JSON.parse(text).empty).toBe(false);
    }
  });

  test("before 08:30 nothing fires", async () => {
    for (const me of ["host", "guest"] as const) await runtimeOf(me).tick();
    expect(h.prompts.get(HOST) ?? []).toEqual([]);
    expect(h.prompts.get(GUEST) ?? []).toEqual([]);
  });

  test("just after 08:30 each brief's turn lists only that user's jobs and approvals", async () => {
    pushes.length = 0;
    h.clock.ms = SLOT.getTime() + 5_000;
    for (const me of ["host", "guest"] as const) {
      await runtimeOf(me).tick();
      await runtimeOf(me).drain();
    }
    for (const me of ["host", "guest"] as const) {
      const prompts = h.prompts.get(aliasOf(me)) ?? [];
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt).toContain(BRIEF_HEADING);
      expect(prompt).toContain(work[me].jobTitle);
      expect(prompt).toContain(`approval waiting: ${work[me].approvalSummary}`);
      expect(prompt).not.toContain(work[otherOf(me)].jobTitle);
      expect(prompt).not.toContain(work[otherOf(me)].approvalSummary);
      expect(listPersonaBriefRuns(h.store.db, aliasOf(me))[0]).toMatchObject({ slot: SLOT.toISOString(), status: "sent" });
      expect(listPersonaBriefRuns(h.store.db, aliasOf(me)).filter((r) => r.status === "sent")).toHaveLength(1);
    }
    // The brief's default route is Slack only.
    expect(pushes).toEqual([]);
  });

  test("each brief is in that user's own console thread, routed to Slack (their DM), and not in the other's", async () => {
    for (const me of ["host", "guest"] as const) {
      const { messages } = await json<{ messages: PersonaMessage[] }>(await as(me, "/api/persona/messages"));
      const briefs = messages.filter((m) => m.notify?.kind === "brief");
      expect(briefs).toHaveLength(1);
      expect(briefs[0]).toMatchObject({
        threadId: runtimeOf(me).consoleThreadId(),
        role: "persona",
        text: briefFor(aliasOf(me)),
        notify: { kind: "brief", channels: ["slack"] },
      });
      expect(JSON.stringify(messages)).not.toContain(briefFor(aliasOf(otherOf(me))));
    }
    expect(runtimeOf("host").consoleThreadId()).not.toBe(runtimeOf("guest").consoleThreadId());
  });

  test("a second tick the same morning sends no second brief", async () => {
    h.clock.ms += 30 * 60_000;
    for (const me of ["host", "guest"] as const) {
      await runtimeOf(me).tick();
      await runtimeOf(me).drain();
      expect(h.prompts.get(aliasOf(me))).toHaveLength(1);
    }
    const recent = await json<PrefsView>(await as("guest", "/api/notify-prefs"));
    expect(recent.brief.recent.filter((r) => r.status === "sent")).toEqual([expect.objectContaining({ slot: SLOT.toISOString() })]);
  });

  test("moving the brief later the same day: the next brief shown is tomorrow's, as the guard won't send a second today", async () => {
    // The settings routes read the wall clock: set it to the test's, the morning of the brief.
    setSystemTime(new Date(h.clock.ms));
    let view: PrefsView;
    try {
      view = await json<PrefsView>(await put("guest", { timezone: NY, brief: { time: "10:00" } }));
    } finally {
      setSystemTime();
    }
    expect(view.brief.nextAt).toBe(nextBriefSlot("10:00", NY, nextBriefSlot("10:00", NY, SLOT)!)!.toISOString());
  });

  test("done routed to push: closing a job posts a done update for that user and pushes to them, not to Slack", async () => {
    pushes.length = 0;
    const set = await put("guest", { timezone: NY, routes: { done: { channels: ["push"] } } });
    expect(set.status).toBe(200);
    expect((await json<PrefsView>(set)).resolved.routes.done).toEqual({ channels: ["push"], when: "always" });

    const guest = runtimeOf("guest");
    const queue = h.turnBodies.get(GUEST) ?? [];
    h.turnBodies.set(GUEST, queue);
    queue.push(async () => {
      const closed = await tool(guest, "close_job", { jobId: work.guest.jobId, status: "done", outcome: "refactor merged" });
      expect(closed.isError).toBe(false);
      return "Closed the okapi refactor: merged.";
    });
    guest.enqueue("schedule", { note: "wrap up the okapi refactor" }, { threadId: guest.consoleThreadId() });
    await guest.drain();

    const { messages } = await json<{ messages: PersonaMessage[] }>(await as("guest", "/api/persona/messages"));
    const done = messages.find((m) => m.text === "Closed the okapi refactor: merged.");
    expect(done).toMatchObject({ threadId: guest.consoleThreadId(), notify: { kind: "done", channels: ["push"] } });
    // The guest has no ntfy topic of their own, so their job content is never pushed to the shared default.
    expect(pushes).toEqual([]);

    // With a topic of their own, the next done update pushes to them.
    const previousTopics = process.env.NTFY_OWNER_TOPICS;
    process.env.NTFY_OWNER_TOPICS = `${GUEST}:guest-topic`;
    try {
      queue.push(async () => {
        const opened = await tool(guest, "open_job", { title: "okapi follow-up", goal: "tidy" });
        const jobId = (JSON.parse(opened.text) as { jobId: string }).jobId;
        const closed = await tool(guest, "close_job", { jobId, status: "cancelled", outcome: "not needed" });
        expect(closed.isError).toBe(false);
        return "Closed the okapi follow-up: not needed.";
      });
      guest.enqueue("schedule", { note: "tidy the okapi follow-up" }, { threadId: guest.consoleThreadId() });
      await guest.drain();
    } finally {
      if (previousTopics === undefined) delete process.env.NTFY_OWNER_TOPICS;
      else process.env.NTFY_OWNER_TOPICS = previousTopics;
    }
    expect(pushes).toEqual([{ title: "Persona: a job ended unfinished", body: "Closed the okapi follow-up: not needed.", recipient: GUEST }]);

    // The host's prefs are untouched: their done route is still the default.
    const hostView = await json<PrefsView>(await as("host", "/api/notify-prefs"));
    expect(hostView.resolved.routes.done).toEqual(DEFAULT_NOTIFY_PREFS.routes.done);
  });
});
