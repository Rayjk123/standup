import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createSession,
  createLaunch,
  insertEvent,
  endSession,
  setSessionCreatedActor,
  assignSessionOwner,
  mergeActors,
  createPersonaJob,
  getOrCreatePersonaConsoleThread,
  recordPersonaTurn,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { UserUsage } from "@standup/shared";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { hostUserAlias } from "./host-user.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/**
 * GET /api/usage/me — the You tab's cost section. Served over a real loopback
 * socket (the console proxy's hop), so the tunnel identity header is honored
 * exactly as it is in production; the question each case asks is whose spend
 * a request can see.
 */

const HOST = hostUserAlias();
const GUEST = "alice";
const OTHER = "bob";

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const j = (o: unknown) => JSON.stringify(o);

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-usage-me-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A transcript with one assistant turn of `input` + `output` tokens on a priced model. */
async function seedSession(store: Store, projectId: string, title: string, input: number, output: number): Promise<string> {
  const dir = await tempDir();
  const path = join(dir, "transcript.jsonl");
  const turn = j({
    type: "assistant",
    uuid: randomUUID(),
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", id: randomUUID(), model: "claude-sonnet-5", content: [], usage: { input_tokens: input, output_tokens: output } },
  });
  await writeFile(path, turn + "\n", "utf8");
  const id = randomUUID();
  createSession(store.db, { id, projectId, title, cwd: dir, status: "running" });
  insertEvent(store.db, id, "PostToolUse", { transcript_path: path });
  return id;
}

async function seedCodexLaunch(store: Store, projectId: string, task: string, requester: string): Promise<void> {
  const dir = await tempDir();
  const sidecar = join(dir, "codex-events.jsonl");
  await writeFile(
    sidecar,
    [j({ type: "thread.started", thread_id: randomUUID() }), j({ type: "turn.completed", usage: { input_tokens: 70, output_tokens: 30 } })].join("\n") + "\n",
    "utf8"
  );
  createLaunch(store.db, {
    id: randomUUID(),
    projectId,
    task,
    worktreePath: join(dir, "wt"),
    branch: "main",
    status: "running",
    harness: "codex",
    codexEventLog: sidecar,
    requester,
  });
}

async function setUp() {
  const store = createStore(":memory:");
  const projectId = `usage-me-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id: projectId, name: "Usage Me", branch: "main", repos: [] });

  const hostRun = await seedSession(store, projectId, "host run", 100, 10);
  setSessionCreatedActor(store.db, hostRun, HOST);
  const guestRun = await seedSession(store, projectId, "guest run", 200, 20);
  setSessionCreatedActor(store.db, guestRun, GUEST);
  // The guest started it, but it was handed to OTHER: it is OTHER's spend now.
  const handedOff = await seedSession(store, projectId, "handed off", 400, 40);
  setSessionCreatedActor(store.db, handedOff, GUEST);
  assignSessionOwner(store.db, handedOff, OTHER);
  await seedCodexLaunch(store, projectId, "guest codex", GUEST);
  const unattributed = await seedSession(store, projectId, "nobody's", 800, 80);
  void unattributed;

  const secrets = generateOwnerSecrets();
  const app = createServer(
    store,
    () => {},
    null,
    undefined,
    undefined,
    "",
    "",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    { ownerSecrets: secrets }
  );
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanup.push(() => server.stop(true));
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
  return { get, secrets, store, projectId };
}

const titles = (body: UserUsage) => body.sessions.map((s) => s.title).sort();

describe("GET /api/usage/me", () => {
  test("the host on loopback sees only its own sessions, totalled", async () => {
    const { get } = await setUp();
    const res = await get("/api/usage/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserUsage;
    expect(body.user).toBe(HOST);
    expect(titles(body)).toEqual(["host run"]);
    expect(body.totals.sessionCount).toBe(1);
    expect(body.totals.totalTokens).toBe(110);
    expect(body.totals.costUsd).not.toBeNull();
  });

  test("a guest proved by its user channel token sees its own Claude and codex runs, not a session handed to someone else", async () => {
    const { get, secrets } = await setUp();
    const res = await get("/api/usage/me", {
      [DEFAULT_IDENTITY_HEADER]: GUEST,
      [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserUsage;
    expect(body.user).toBe(GUEST);
    expect(titles(body)).toEqual(["guest codex", "guest run"]);
    expect(body.totals.totalTokens).toBe(220 + 100);
    // Reconciles to its own rows: nobody else's tokens leak into the headline.
    expect(body.totals.totalTokens).toBe(body.sessions.reduce((n, s) => n + s.totalTokens, 0));
  });

  test("the tunnel identity header alone is not proof: a forged alias gets a sign-in refusal, not that user's spend", async () => {
    const { get } = await setUp();
    const res = await get("/api/usage/me", { [DEFAULT_IDENTITY_HEADER]: GUEST });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string; sessions?: unknown };
    expect(body.reason).toBe("sign-in");
    expect(body.sessions).toBeUndefined();
  });

  test("a channel token minted for another user proves nothing", async () => {
    const { get, secrets } = await setUp();
    const res = await get("/api/usage/me", {
      [DEFAULT_IDENTITY_HEADER]: GUEST,
      [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, OTHER),
    });
    expect(res.status).toBe(403);
  });

  test("the owner token alone reads as the host", async () => {
    const { get, secrets } = await setUp();
    const res = await get("/api/usage/me", { [OWNER_TOKEN_HEADER]: secrets.ownerToken });
    expect(res.status).toBe(200);
    expect(titles((await res.json()) as UserUsage)).toEqual(["host run"]);
  });

  test("the owner token does not prove a guest alias named in the identity header", async () => {
    const { get, secrets } = await setUp();
    const res = await get("/api/usage/me", { [OWNER_TOKEN_HEADER]: secrets.ownerToken, [DEFAULT_IDENTITY_HEADER]: GUEST });
    expect(res.status).toBe(403);
  });

  test("each viewer sees only their own Persona's turns and jobs, never another user's", async () => {
    const { get, secrets, store } = await setUp();
    const at = "2026-10-08T10:00:00.000Z";
    const hostThread = getOrCreatePersonaConsoleThread(store.db, HOST).id;
    const guestThread = getOrCreatePersonaConsoleThread(store.db, GUEST).id;
    const hostJob = createPersonaJob(store.db, { owner: HOST, threadId: hostThread, title: "host's job", goal: "g" });
    const guestJob = createPersonaJob(store.db, { owner: GUEST, threadId: guestThread, title: "guest's job", goal: "g" });
    recordPersonaTurn(store.db, { user: HOST, threadId: hostThread, jobIds: [hostJob.id], ok: true, startedAt: at, durationMs: 1, costUsd: 0.5, inputTokens: 10, outputTokens: 2 });
    recordPersonaTurn(store.db, { user: GUEST, threadId: guestThread, jobIds: [guestJob.id], ok: true, startedAt: at, durationMs: 1, costUsd: 0.25 });
    recordPersonaTurn(store.db, { user: GUEST, threadId: guestThread, ok: true, startedAt: at, durationMs: 1, costUsd: 0.05 });

    const guest = (await (
      await get("/api/usage/me", { [DEFAULT_IDENTITY_HEADER]: GUEST, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST) })
    ).json()) as UserUsage;
    expect(guest.persona?.turns).toBe(2);
    expect(guest.persona?.costUsd).toBeCloseTo(0.3, 10);
    expect(guest.persona?.jobs.map((j) => j.title)).toEqual(["guest's job"]);
    expect(guest.persona?.jobs[0]!.budget.personaUsd).toBeCloseTo(0.25, 10);

    const host = (await (await get("/api/usage/me")).json()) as UserUsage;
    expect(host.persona?.turns).toBe(1);
    expect(host.persona?.costUsd).toBeCloseTo(0.5, 10);
    expect(host.persona?.jobs.map((j) => j.title)).toEqual(["host's job"]);

    // A user with no Persona of their own sees nobody else's.
    const other = (await (
      await get("/api/usage/me", { [DEFAULT_IDENTITY_HEADER]: OTHER, [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, OTHER) })
    ).json()) as UserUsage;
    expect(other.persona).toEqual({ turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, jobs: [] });
  });

  test("merging another user's actor into the viewer's does not hand the viewer their spend", async () => {
    const { get, secrets, store } = await setUp();
    // The merge route takes no proof of either identity, so a tombstone is no
    // basis for ownership: OTHER's handed-off session stays OTHER's.
    mergeActors(store.db, OTHER, GUEST);
    const res = await get("/api/usage/me", {
      [DEFAULT_IDENTITY_HEADER]: GUEST,
      [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST),
    });
    expect(titles((await res.json()) as UserUsage)).toEqual(["guest codex", "guest run"]);
  });
});

describe("GET /api/usage/fleet", () => {
  test("every user's cost is the owner's alone to read", async () => {
    const { get, secrets } = await setUp();
    expect((await get("/api/usage/fleet")).status).toBe(403);
    const guest = await get("/api/usage/fleet", {
      [DEFAULT_IDENTITY_HEADER]: GUEST,
      [USER_CHANNEL_HEADER]: userChannelToken(secrets.ownerToken, GUEST),
    });
    expect(guest.status).toBe(403);
    const owner = await get("/api/usage/fleet", { [OWNER_TOKEN_HEADER]: secrets.ownerToken });
    expect(owner.status).toBe(200);
  });

  test("ended sessions stay out unless ?all=1", async () => {
    const { get, store, projectId } = await setUp();
    const ended = await seedSession(store, projectId, "host ended", 5, 5);
    setSessionCreatedActor(store.db, ended, HOST);
    endSession(store.db, ended);
    const active = (await (await get("/api/usage/me")).json()) as UserUsage;
    const all = (await (await get("/api/usage/me?all=1")).json()) as UserUsage;
    expect(titles(active)).toEqual(["host run"]);
    expect(titles(all)).toEqual(["host ended", "host run"]);
  });
});
