import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import { WORKER_TOKEN_HEADER, type Launch, type PersonaJob } from "@standup/shared";
import {
  createLaunch,
  createPersonaJob,
  createSession,
  createStore,
  endSession,
  getOrCreatePersonaConsoleThread,
  linkPersonaJobLaunch,
  listLiveProcessesForLaunch,
  setLaunchReviewTokenHash,
  updateLaunchStatus,
  updatePersonaJob,
  upsertProject,
} from "@standup/store";
import type { Store } from "@standup/store";
import { workerTokenHash } from "./floor/gate.js";
import { FakeProcessSystem } from "./process-registry-fake.js";
import type { ProcessRow } from "./process-registry.js";
import { mountProcessRoutes } from "./process-routes.js";

const INSTALL = "/srv/me/standup";
const WT = "/wt/proj/a";
const TOKEN = "a".repeat(64);
const r = (pid: number, ppid: number, pgid: number, args: string): ProcessRow => ({ pid, ppid, pgid, uid: 1000, args });

let store: Store;
let sys: FakeProcessSystem;
let app: Hono;
let launch: Launch;
let sessionId: string;
let job: PersonaJob;

beforeEach(() => {
  store = createStore(":memory:");
  upsertProject(store.db, { id: "proj", name: "P", branch: "main", repos: [] });
  sys = new FakeProcessSystem(
    [
      r(900, 1, 900, "/usr/lib/systemd/systemd --user"),
      r(4000, 900, 4000, "bun run src/index.ts"),
      r(5000, 900, 5000, `node ${WT}/server.js`),
      r(5100, 900, 5100, "node /elsewhere/proj/server.js"),
    ],
    { selfPid: 4000, uid: 1000 }
  );
  sessionId = `s-${randomUUID().slice(0, 8)}`;
  createSession(store.db, { id: sessionId, projectId: "proj", title: "W", cwd: WT, status: "running" });
  launch = createLaunch(store.db, { id: randomUUID(), projectId: "proj", task: "t", worktreePath: WT, branch: "b", status: "running", sessionId, launchedBy: "alice" });
  setLaunchReviewTokenHash(store.db, launch.id, workerTokenHash(TOKEN));
  const thread = getOrCreatePersonaConsoleThread(store.db, "alice");
  job = createPersonaJob(store.db, { owner: "alice", threadId: thread.id, title: "J", goal: "g" });
  linkPersonaJobLaunch(store.db, job.id, launch.id);
  app = new Hono();
  mountProcessRoutes(app, {
    db: store.db,
    sys,
    installDir: INSTALL,
    humanRefusal: (c) => (c.req.header("x-test-human") ? null : c.json({ error: "humans only" }, 403)),
    identityOf: (c) => c.req.header("x-test-human") ?? "",
    personaOwnerOf: (c) => c.req.header("x-test-persona"),
    scratchRoot: mkdtempSync(join(tmpdir(), "standup-scratch-proc-routes-")),
    graceMs: 0,
    // No panes on the workers' tmux server, so hygiene's liveness checks never reach real tmux.
    paneAlive: () => false,
  });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("POST /api/processes/register", () => {
  test("a worker token registers a process under its launch and job", async () => {
    const res = await post("/api/processes/register", { pid: 5000, label: "api", port: 8080 }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { process: { launchId: string; jobId: string; pid: number } };
    expect(body.process).toMatchObject({ launchId: launch.id, jobId: job.id, pid: 5000 });
  });

  test("a worker token registers a launch-prefixed unit", async () => {
    const unit = `sw-${launch.id.slice(0, 8)}-dev.service`;
    const res = await post("/api/processes/register", { unit, label: "dev" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(200);
    expect(listLiveProcessesForLaunch(store.db, launch.id).map((p) => p.unit)).toEqual([unit]);
  });

  test("a session id or cwd without a token is refused, however well it names the launch", async () => {
    const unit = `sw-${launch.id.slice(0, 8)}-dev.service`;
    expect((await post("/api/processes/register", { session_id: sessionId, cwd: WT, unit, label: "dev" })).status).toBe(403);
    expect((await post("/api/processes/register", { session_id: sessionId, cwd: WT, pid: 5000, label: "dev" })).status).toBe(403);
    expect(listLiveProcessesForLaunch(store.db, launch.id)).toHaveLength(0);
  });

  test("a wrong token, Persona, or no launch is refused", async () => {
    expect((await post("/api/processes/register", { pid: 5000, label: "x" }, { [WORKER_TOKEN_HEADER]: "b".repeat(64) })).status).toBe(403);
    expect((await post("/api/processes/register", { pid: 5000, label: "x" }, { [WORKER_TOKEN_HEADER]: TOKEN, "x-test-persona": "alice" })).status).toBe(403);
    expect((await post("/api/processes/register", { session_id: "nope", cwd: "/nowhere", pid: 5000, label: "x" })).status).toBe(403);
  });

  test("a refused process is a 400 naming why", async () => {
    const res = await post("/api/processes/register", { pid: 4000, label: "x" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("collector");
  });

  test("a process the launch didn't start is a 400", async () => {
    const res = await post("/api/processes/register", { pid: 5100, label: "x" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not a process this launch started");
  });

  test("an unprefixed unit is a 400 naming the prefix", async () => {
    const res = await post("/api/processes/register", { unit: "my-dev.service", label: "x" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(`--unit=sw-${launch.id.slice(0, 8)}-`);
  });
});

describe("GET /api/processes", () => {
  test("a worker lists its own by token; the owner lists a job's; others get 404", async () => {
    await post("/api/processes/register", { pid: 5000, label: "api" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    const own = await app.request("/api/processes", { headers: { [WORKER_TOKEN_HEADER]: TOKEN } });
    const ownBody = (await own.json()) as { processes: unknown[]; unitPrefix: string };
    expect(ownBody.processes).toHaveLength(1);
    expect(ownBody.unitPrefix).toBe(`sw-${launch.id.slice(0, 8)}-`);
    expect((await app.request(`/api/processes?session_id=${sessionId}&cwd=${WT}`)).status).toBe(403);
    const owner = await app.request(`/api/processes?jobId=${job.id}`, { headers: { "x-test-persona": "alice" } });
    expect(((await owner.json()) as { processes: unknown[] }).processes).toHaveLength(1);
    const byLaunch = await app.request(`/api/processes?launchId=${launch.id}`, { headers: { "x-test-human": "alice" } });
    expect(((await byLaunch.json()) as { processes: unknown[] }).processes).toHaveLength(1);
    expect((await app.request(`/api/processes?jobId=${job.id}`, { headers: { "x-test-human": "bob" } })).status).toBe(404);
    expect((await app.request(`/api/processes?jobId=${job.id}`)).status).toBe(403);
  });
});

describe("POST /api/jobs/:id/hygiene", () => {
  test("stops a closed job's processes for its owner; an open job is a 409; another owner a 404", async () => {
    await post("/api/processes/register", { pid: 5000, label: "api" }, { [WORKER_TOKEN_HEADER]: TOKEN });
    expect((await post(`/api/jobs/${job.id}/hygiene`, { reason: "job_closed" }, { "x-test-persona": "alice" })).status).toBe(409);
    // close_job stops the job's workers before it asks for hygiene; a live worker keeps its processes.
    endSession(store.db, sessionId);
    updateLaunchStatus(store.db, launch.id, "failed", "Stopped by you");
    updatePersonaJob(store.db, job.id, { status: "done" });
    expect((await post(`/api/jobs/${job.id}/hygiene`, {}, { "x-test-persona": "bob" })).status).toBe(404);
    const res = await post(`/api/jobs/${job.id}/hygiene`, { reason: "job_closed" }, { "x-test-persona": "alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processes: Array<{ outcome: string }> };
    expect(body.processes.map((p) => p.outcome)).toEqual(["terminated"]);
    expect(sys.signals).toEqual([{ target: -5000, sig: "SIGTERM" }]);
    const again = (await (await post(`/api/jobs/${job.id}/hygiene`, { reason: "job_closed" }, { "x-test-persona": "alice" })).json()) as { processes: unknown[] };
    expect(again.processes).toEqual([]);
  });
});
