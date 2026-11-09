import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  getAsk,
  linkPersonaJobLaunch,
  listPersonaApprovals,
  listPersonaMessages,
  setLaunchWorkerTokenHash,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { PersonaApproval, WsMessage } from "@standup/shared";
import { OWNER_TOKEN_HEADER } from "@standup/shared/owner-token";
import { FLOOR_WORKER_TOKEN_HEADER, workerTokenHash } from "../floor/gate.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { FakeProcessSystem } from "../process-registry-fake.js";
import { createWsServer } from "../ws.js";
import { resolveIdentityConfigFromEnv } from "../identity.js";
import type { WsServerHandle } from "../ws.js";
import { createServer, buildSnapshot, resolveUserAlias } from "../server.js";
import type { LaunchFn } from "../server.js";
import { PersonaRuntime } from "./runtime.js";
import { PersonaFleet } from "./fleet.js";
import { createBroadcastTap } from "./events.js";
import { resolvePersonaConfig } from "./config.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { setActiveOrgProfile } from "../org-profile/load.js";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";

// The example.corp fixture profile, the org vocabulary these cases use.
beforeAll(() => setActiveOrgProfile(exampleCorpProfile()));
afterAll(() => setActiveOrgProfile());

/*
 * The owner's "Allow once" card over a safety-floor hold Persona can't allow,
 * end to end in one process: a file-backed scratch DB, the real HTTP routes, a
 * Persona runtime on stub turns (no model), and the WS server on an ephemeral
 * 127.0.0.1 port with a real socket client signed in as the owner. A worker's
 * hook holds calls through POST /api/floor/hold. Every hold goes to Persona
 * first with no card:
 *   A: a read of another process's environment -> Persona's Deny ends it, no card
 *   B: the same read Persona tries to allow -> carded; the owner's Allow once releases the hook
 *   C: an AWS credentials read Persona tries to allow -> carded; the owner's Deny denies it
 *   D: a plain print of the profile's SSO cookie -> an ordinary hold; Persona's Allow once runs it, no card
 *   E: a high-risk call Persona may allow -> no card; Persona's Deny clears it
 * The held commands are built at run time.
 */

const OWNER = resolveUserAlias(undefined);
const WORKER_TOKEN = "w".repeat(64);
const SSO_READ = ["cat", ["~", ".corp-sso", "cookie"].join("/")].join(" ");
const PROC_READ = ["cat", ["", "proc", "1", "environ"].join("/")].join(" ");
const AWS_READ = ["cat", ["~", ".aws", "credentials"].join("/")].join(" ");
const DB_READ = ["sqlite3", ["~", ".local", "share", "standup", "standup.db"].join("/"), ".tables"].join(" ");

let dir: string;
let store: Store;
let runtime: InstanceType<typeof PersonaRuntime>;
let ws: WsServerHandle;
let app: ReturnType<typeof createServer>;
let secrets: ReturnType<typeof generateOwnerSecrets>;
const frames: WsMessage[] = [];
let socket: WebSocket;
let job: { id: string; threadId: string };
let launchId: string;
let sessionId: string;
const worktree = "/tmp/wt-owner-floor-card";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "owner-floor-card-"));
  store = createStore(join(dir, "standup.db"));
  secrets = generateOwnerSecrets();
  ws = createWsServer(0, async () => buildSnapshot(store), () => {}, resolveIdentityConfigFromEnv(), {
    hostname: "127.0.0.1",
    ownerSecrets: () => secrets,
  });
  const tap = createBroadcastTap(ws.broadcast);
  runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: resolvePersonaConfig({}),
    broadcast: tap.broadcast,
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "stub" }),
    ownerToken: () => secrets.ownerToken,
  });
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: () => runtime });
  tap.subscribe(fleet.eventListener());
  const noLaunch = (async () => {
    throw new Error("this check launches no workers");
  }) as unknown as LaunchFn;
  app = createServer(store, tap.broadcast, null, undefined, undefined, dir, "", {}, undefined, undefined, noLaunch, undefined, { fleet, ownerSecrets: secrets }, {}, {
    stopLaunch: async () => ({ ok: true, log: [] }),
    processes: new FakeProcessSystem(),
    paneAlive: () => false,
  });

  upsertProject(store.db, { id: "docs-sync", name: "Docs sync", branch: "main", repos: [] });
  job = createPersonaJob(store.db, {
    owner: OWNER,
    threadId: runtime.consoleThreadId(),
    title: "Fix the docs sync's wiki sign-in",
    goal: "Find out why the nightly docs sync can't reach the internal wiki, and fix it",
  });
  launchId = randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "docs-sync", task: "fix the docs sync", worktreePath: worktree, branch: "fix/docs-sync" });
  linkPersonaJobLaunch(store.db, job.id, launchId);
  sessionId = randomUUID();
  createSession(store.db, { id: sessionId, projectId: "docs-sync", title: "docs-sync worker", cwd: worktree, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(WORKER_TOKEN));

  // The owner's console socket: the owner secret on the upgrade proves the host, so it gets Persona's frames.
  socket = new WebSocket(`ws://127.0.0.1:${ws.port}/`, { headers: { [OWNER_TOKEN_HEADER]: secrets.ownerToken } } as unknown as string[]);
  socket.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as WsMessage));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("ws connect failed")));
  });
  for (let i = 0; i < 200 && !frames.some((f) => f.type === "hello-ok"); i++) await Bun.sleep(10);
});

afterAll(() => {
  socket?.close();
  runtime?.stop();
  void ws?.close();
  store?.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The worker's hook holding `command` through the real floor route; `reply` is the floor's answer once decided. */
async function hold(command: string, verdict: Record<string, unknown> = { category: "unclassified", ownerOnly: false, reason: "the hook held it" }) {
  const requestId = `toolu_${randomUUID()}`;
  const reply = Promise.resolve(
    app.request("/api/floor/hold", {
      method: "POST",
      headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: WORKER_TOKEN },
      // The hook's own verdict is the least it would send; the route classifies the call itself and keeps the stricter.
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        launch_id: launchId,
        request_id: requestId,
        tool_name: "Bash",
        tool_input: { command },
        hold: { ...verdict, step: command },
        wait_s: 60,
      }),
    })
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
  for (let i = 0; i < 400; i++) {
    const row = store.db.query("SELECT id FROM asks WHERE request_id = ?").get(requestId) as { id: string } | null;
    if (row) return { askId: row.id, reply };
    await Bun.sleep(5);
  }
  throw new Error(`the hold raised no ask: ${JSON.stringify(await Promise.race([reply, Bun.sleep(100).then(() => "no reply")]))}`);
}

const cardsFor = (askId: string) => listPersonaApprovals(store.db, OWNER).filter((a) => a.action === "answer_ask" && a.args.askId === askId);
const owner = (path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", [OWNER_TOKEN_HEADER]: secrets.ownerToken }, body: JSON.stringify(body) });
const frame = async (match: (f: WsMessage) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const found = frames.find(match);
    if (found) return found;
    await Bun.sleep(10);
  }
  return undefined;
};

const persona = (args: Record<string, unknown>) =>
  app.request("/api/persona/tool", {
    method: "POST",
    headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
    body: JSON.stringify({ name: "answer_ask", arguments: args }),
  });

describe("a safety-floor hold Persona can't allow, end to end", () => {
  test("a read of another process's environment goes to Persona first, and Persona's Deny ends it with no card", async () => {
    const { askId, reply } = await hold(PROC_READ);
    expect(getAsk(store.db, askId)!.question).toContain("HIGH RISK");
    expect(cardsFor(askId)).toHaveLength(0);
    const askFrame = await frame((f) => f.type === "ask:new" && (f.payload as { id: string }).id === askId);
    expect(askFrame?.payload).not.toHaveProperty("cardDecider");
    expect((await persona({ askId, answer: "Deny", reason: "not for this job" })).status).toBe(200);
    expect(await reply).toMatchObject({ decision: "deny", answer: "Deny: not for this job" });
    expect(cardsFor(askId)).toHaveLength(0);
  });

  test("Persona's Allow once of a read of another process's environment puts it on the owner's Allow once card over the API and the socket, and Allow once releases the hook", async () => {
    const { askId, reply } = await hold(PROC_READ);
    expect(cardsFor(askId)).toHaveLength(0);
    const allowed = (await (await persona({ askId, answer: "Allow once", reason: "the worker needs the env" })).json()) as { isError?: boolean; text?: string };
    expect(allowed.isError).toBe(true);
    expect(getAsk(store.db, askId)!.status).toBe("pending");
    const [card] = cardsFor(askId);
    expect(card).toMatchObject({ status: "pending", jobId: job.id, args: { askId, answer: "Allow once", floorHold: true } });
    expect(card!.reason).toStartWith("Persona can't allow this safety-floor hold: the call reads or moves secrets");

    // The owner's console reads it from the API and gets it on the socket.
    const listed = (await (await app.request("/api/persona/approvals", { headers: { [OWNER_TOKEN_HEADER]: secrets.ownerToken } })).json()) as
      | PersonaApproval[]
      | { approvals: PersonaApproval[] };
    const approvals = Array.isArray(listed) ? listed : listed.approvals;
    expect(approvals.some((a) => a.id === card!.id && a.status === "pending")).toBe(true);
    const cardFrame = await frame((f) => f.type === "persona:approval" && (f.payload as PersonaApproval).id === card!.id);
    expect(cardFrame?.payload).toMatchObject({ status: "pending", args: { floorHold: true } });
    // The card's line is in the Persona chat.
    expect(listPersonaMessages(store.db, job.threadId).some((m) => m.approvalId === card!.id)).toBe(true);

    const res = await owner(`/api/persona/approvals/${card!.id}/approve`);
    expect(res.status).toBe(200);
    expect(await reply).toMatchObject({ decision: "allow", answer: "Allow once" });
    expect(getAsk(store.db, askId)).toMatchObject({ status: "answered", answer: "Allow once", answeredBy: OWNER });
    expect(cardsFor(askId)[0]!.status).toBe("executed");
    expect(await frame((f) => f.type === "ask:resolved" && (f.payload as { askId?: string }).askId === askId)).toBeDefined();
  });

  test("an AWS credentials read Persona tries to allow is carded too, and the owner's Deny denies the hook", async () => {
    const { askId, reply } = await hold(AWS_READ);
    expect(getAsk(store.db, askId)!.question).toContain("HIGH RISK");
    expect(cardsFor(askId)).toHaveLength(0);
    expect((await persona({ askId, answer: "Allow once", reason: "the worker needs the credentials" })).status).toBe(200);
    const [card] = cardsFor(askId);
    expect(card).toMatchObject({ status: "pending", args: { floorHold: true } });
    const res = await owner(`/api/persona/approvals/${card!.id}/deny`, { reason: "not for this job" });
    expect(res.status).toBe(200);
    // The owner's reason reaches the worker's hook with the deny.
    expect(await reply).toMatchObject({ decision: "deny", answer: "Deny: not for this job" });
    expect(getAsk(store.db, askId)).toMatchObject({ status: "answered", answer: "Deny: not for this job" });
  });

  test("a plain SSO cookie print is an ordinary hold: Persona's Allow once runs it, and no card is raised", async () => {
    const { askId, reply } = await hold(SSO_READ);
    expect(getAsk(store.db, askId)!.question).not.toContain("HIGH RISK");
    const res = await persona({ askId, answer: "Allow once", reason: "the job uploads to the wiki with the owner's SSO cookie" });
    expect(res.status).toBe(200);
    expect(await reply).toMatchObject({ decision: "allow", answer: "Allow once" });
    expect(cardsFor(askId)).toHaveLength(0);
  });

  test("a high-risk hold Persona may allow raises no card, and Persona's Deny clears it", async () => {
    // Under this test's /tmp HOME the route doesn't read the path as Standup's data dir; the hook's verdict says it is.
    const { askId, reply } = await hold(DB_READ, { category: "floor-tamper", ownerOnly: true, ownerReserved: true, reason: "reads Standup's own database" });
    expect(getAsk(store.db, askId)!.question).toContain("HIGH RISK");
    expect(cardsFor(askId)).toHaveLength(0);
    const res = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name: "answer_ask", arguments: { askId, answer: "Deny" } }),
    });
    expect(res.status).toBe(200);
    expect(await reply).toMatchObject({ decision: "deny", answer: "Deny" });
    expect(cardsFor(askId)).toHaveLength(0);
  });

  test("Persona's Deny with a reason carries the reason to the worker's hook", async () => {
    const { askId, reply } = await hold(DB_READ, { category: "floor-tamper", ownerOnly: true, ownerReserved: true, reason: "reads Standup's own database" });
    const why = "read a scratch copy under /tmp instead of the live DB";
    const res = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name: "answer_ask", arguments: { askId, answer: "Deny", reason: why } }),
    });
    expect(res.status).toBe(200);
    expect(await reply).toMatchObject({ decision: "deny", answer: `Deny: ${why}` });
    expect(getAsk(store.db, askId)).toMatchObject({ status: "answered", answer: `Deny: ${why}` });
  });
});
