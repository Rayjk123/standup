import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createPersonaApproval,
  createPlanApproval,
  createSession,
  createStore,
  enqueuePersonaInbox,
  getAskByRequestId,
  getPersonaApproval,
  getPersonaInboxItem,
  getPlanApproval,
  getPlanReviewRemark,
  listPendingPersonaInbox,
  resolveAsk,
  timeoutOrphanedAsks,
  upsertProject,
} from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { FakeWorld } from "../test-support/restart-world.js";
import type { RestartExec } from "./exec.js";
import { currentRecordPath, readGoodHeads, readRecord, recordGoodHead, writeRecord } from "./state.js";
import { runRestart } from "./supervisor.js";

// Phone pushes are recorded rather than sent. Snapshot the real module so the
// mock is lifted afterwards — mock.module is process-wide.
import * as push from "../push.js";
const realPush = { ...push };
mock.module("../push.js", () => ({ ...realPush, pushNotification: mock(async () => {}) }));

const dirs: string[] = [];
afterAll(() => {
  mock.module("../push.js", () => realPush);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const { createServer, resolveUserAlias } = await import("../server.js");
const { PersonaRuntime } = await import("../persona/runtime.js");
const { createBroadcastTap } = await import("../persona/events.js");
const { resolvePersonaConfig } = await import("../persona/config.js");
const { PERSONA_TOKEN_HEADER } = await import("../persona/routes.js");
const { WRITE_TOKEN_HEADER } = await import("./routes.js");
const { RestartService } = await import("./service.js");
const { generateOwnerSecrets } = await import("../owner-secret.js");
const { OWNER_TOKEN_HEADER } = await import("@standup/shared/owner-token");
type PersonaConfig = import("../persona/config.js").PersonaConfig;
type LaunchFn = import("../server.js").LaunchFn;

const OWNER = resolveUserAlias(undefined);
/** The install's owner secret, which the owner's channels present on owner decisions. */
const OWNER_SECRETS = generateOwnerSecrets();
const A = "a".repeat(40);
const B = "b".repeat(40);
/** The first collector's pid; the ones dev.ts brings back get 600, 601, … */
const OLD_PID = 12;
/** The per-user local write token the redeploy hook presents. */
const WRITE_TOKEN = "w".repeat(64);

/**
 * One collector process over a SQLite file: store, Persona runtime, restart
 * service and HTTP app, as index.ts wires them. Closing one and starting
 * another on the same file and data dir is a restart.
 */
function startCollector(
  dbPath: string,
  dataDir: string,
  exec: RestartExec,
  pid: number,
  config: Partial<PersonaConfig> = {},
  launch?: (db: unknown, request: { idempotencyKey?: string }) => Promise<unknown>
) {
  const store = createStore(dbPath);
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  // As index.ts does at boot: asks whose waiter left with the previous process.
  const orphanedAsks = timeoutOrphanedAsks(store.db, new Date());
  const knowledgeDir = mkdtempSync(join(tmpdir(), "restart-kb-"));
  dirs.push(knowledgeDir);
  const frames: WsMessage[] = [];
  const tap = createBroadcastTap((m) => frames.push(m));
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), ...config },
    broadcast: tap.broadcast,
    turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
  });
  tap.subscribe(runtime.eventListener());
  const restart = new RestartService({
    db: store.db,
    owner: OWNER,
    dataDir,
    installDir: "/install",
    collectorUrl: "http://collector.test",
    uiUrl: "http://ui.test/",
    exec,
    persona: runtime,
    pid,
    supervisorArgv: (path) => ["supervisor", path],
    execArgv: [],
    pollMs: 5,
    orphanedAsks,
    writeToken: WRITE_TOKEN,
  });
  // Launches (a released self-fix) are recorded, never provisioned.
  const launchCalls: unknown[] = [];
  const launchFn = (launch ??
    (async (_db: unknown, request: unknown) => {
      launchCalls.push(request);
      return { launch: { id: `launch-${launchCalls.length}`, status: "starting" }, log: [] };
    })) as unknown as LaunchFn;
  const app = createServer(
    store,
    tap.broadcast,
    null,
    undefined,
    undefined,
    knowledgeDir,
    "",
    {},
    undefined,
    undefined,
    launchFn,
    undefined,
    { runtime, restart, ownerSecrets: OWNER_SECRETS }
  );
  // A waiter still polling once its collector is closed fails quietly, as it
  // would in a stopped process.
  app.onError((err, c) => c.json({ error: err.message }, 500));
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await post("/api/persona/tool", { name, arguments: args }, { [PERSONA_TOKEN_HEADER]: runtime.token });
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    return { isError: !!result.isError, text: result.content.map((c) => c.text).join("") };
  };
  const close = () => {
    runtime.stop();
    restart.stop();
    store.close();
  };
  return { pid, store, app, runtime, restart, frames, launchCalls, post, tool, close };
}

type Collector = ReturnType<typeof startCollector>;

/** The machine's next collector, launching self-fixes with `launch`. */
function startCollectorWith(
  machine: { dbPath: string; dataDir: string; exec: RestartExec },
  pid: number,
  launch: (db: unknown, request: { idempotencyKey?: string }) => Promise<unknown>
): Collector {
  return startCollector(machine.dbPath, machine.dataDir, machine.exec, pid, {}, launch);
}

/**
 * The machine the restart runs on: dev.ts (10) → `bun run dev` (11) → the
 * collector (OLD_PID) on commit B, with A known-good. Stopping the collector
 * closes it and dev.ts brings up the next one on the same files; the
 * supervisor's probes reach whichever collector is running.
 */
function setUpMachine() {
  const dataDir = mkdtempSync(join(tmpdir(), "restart-e2e-"));
  dirs.push(dataDir);
  const dbPath = join(dataDir, "standup.db");
  recordGoodHead(dataDir, A, "2026-10-01T00:00:00.000Z");
  const world = new FakeWorld();
  world.head = B;
  world.ps.set(OLD_PID, { ppid: 11, args: "bun run --watch src/index.ts" });
  world.cwds.set(OLD_PID, "/install/packages/collector");
  world.ps.set(11, { ppid: 10, args: "bun run dev" });
  world.cwds.set(11, "/install/packages/collector");
  world.alive.add(11);
  world.ps.set(10, { ppid: 1, args: "bun run scripts/dev.ts" });
  world.cwds.set(10, "/install");
  world.alive.add(10);
  // The supervisor takes the restart over the moment it starts, as cli.ts does.
  // Only the supervisor is ever spawned here, on this machine's own record:
  // anything else would be written outside the temp dir.
  world.onSpawn = (pid, argv) => {
    world.alive.add(pid);
    const path = argv[argv.length - 1]!;
    if (argv[0] !== "supervisor" || path !== currentRecordPath(dataDir)) {
      throw new Error(`unexpected spawn ${argv.join(" ")}: only the supervisor, on ${currentRecordPath(dataDir)}, runs here`);
    }
    writeRecord(path, { ...readRecord(path)!, phase: "stopping", supervisorPid: pid });
  };
  const machine = {
    dataDir,
    dbPath,
    world,
    current: null as Collector | null,
    nextPid: 600,
    exec: null as unknown as RestartExec,
    /** Answers a probe of the running collector; replaceable to make a commit unhealthy. */
    probe: async (c: Collector, path: string): Promise<{ status: number; body: string }> => {
      const res = await c.app.request(path);
      return { status: res.status, body: await res.text() };
    },
  };
  const exec: RestartExec = {
    ...world.exec,
    kill: (pid, signal) => {
      world.kills.push([pid, signal]);
      if (machine.current && pid === machine.current.pid) {
        machine.current.close();
        // Its wrapper exits with it, and dev.ts brings the collector back (as
        // its direct child) on the same database and checkout.
        world.ps.delete(pid);
        world.alive.delete(11);
        world.ps.delete(11);
        const next = machine.nextPid++;
        world.ps.set(next, { ppid: 10, args: "bun run --watch src/index.ts" });
        world.cwds.set(next, "/install/packages/collector");
        machine.current = startCollector(dbPath, dataDir, exec, next);
        return true;
      }
      return world.exec.kill(pid, signal);
    },
    isAlive: (pid) => machine.current?.pid === pid || world.alive.has(pid),
    httpGet: async (url) => {
      if (url.startsWith("http://ui.test")) return { status: 200, body: "<html>" };
      const c = machine.current;
      if (!c) return { status: 0, body: "ECONNREFUSED" };
      const path = new URL(url).pathname;
      // Each collector answers /health with its own pid, as separate processes would.
      if (path === "/health") return { status: 200, body: JSON.stringify({ status: "ok", pid: c.pid }) };
      return machine.probe(c, path);
    },
  };
  machine.exec = exec;
  machine.current = startCollector(dbPath, dataDir, exec, OLD_PID);
  return machine;
}

/** The supervisor's run, with the machine's effects. */
async function superviseRestart(machine: ReturnType<typeof setUpMachine>) {
  const path = currentRecordPath(machine.dataDir);
  return runRestart(readRecord(path)!, {
    exec: machine.exec,
    save: (r) => writeRecord(path, r),
    recordGoodHead: (head) => {
      recordGoodHead(machine.dataDir, head);
    },
    readTail: () => "",
    log: () => {},
    pid: 777,
  });
}

/** A worker session behind a plan-gated launch. */
function seedWorker(c: Collector) {
  const launch = createLaunch(c.store.db, { id: randomUUID(), projectId: "p", task: "t", worktreePath: "/w", branch: "b" });
  const sessionId = randomUUID();
  createSession(c.store.db, { id: sessionId, projectId: "p", title: "worker", cwd: "/w", status: "running" });
  attachSessionToLaunch(c.store.db, launch.id, sessionId);
  const plan = createPlanApproval(c.store.db, { launchId: launch.id, projectId: "p", worktreePath: "/w" });
  return { sessionId, plan };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5);
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe("a Persona-requested restart, end to end", () => {
  test("approvals, asks, plan notes and inbox items survive; waiters re-attach; the report reaches Persona", async () => {
    const machine = setUpMachine();
    const c1 = machine.current!;
    const { sessionId, plan } = seedWorker(c1);

    // The worker's plan is reviewed with a note while its submit_plan call is
    // not waiting (its client gave up), so the note is still undelivered.
    expect(await (await c1.post("/api/plan/submit", { session_id: sessionId, plan: "Edit a.ts.", timeout_s: 0.05 })).json()).toMatchObject({
      status: "timeout",
    });
    expect((await c1.post(`/api/plans/${plan.id}/approve`, { note: "Keep the old API." })).status).toBe(200);
    // The worker is blocked in ask_human when the collector goes away.
    const abandoned = c1
      .post("/api/ask", { session_id: sessionId, cwd: "/w", question: "Approach A or B?", timeout_s: 60, request_id: "req-1" })
      .catch(() => null);
    await until(() => !!getAskByRequestId(c1.store.db, sessionId, "req-1"), "the ask");
    const askId = getAskByRequestId(c1.store.db, sessionId, "req-1")!.id;
    // An approval card waits on the owner; a wakeup waits in the inbox.
    const approval = createPersonaApproval(c1.store.db, { owner: OWNER, action: "answer_ask", summary: "Answer a permission prompt", args: {} });
    const { item: wakeup } = enqueuePersonaInbox(c1.store.db, {
      owner: OWNER,
      kind: "schedule",
      payload: { note: "check on the worker" },
      notBefore: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // Persona asks for the restart, outside of any turn.
    const asked = await c1.tool("restart_standup", { reason: "roll in the merged plan-note fix" });
    expect(asked.isError).toBe(false);
    expect(asked.text).toMatch(/^restart scheduled \(id \w+\); you will get a report after the collector is back$/);
    await c1.restart.handoff;
    expect(machine.world.spawns.map((s) => s.argv[0])).toEqual(["supervisor"]);
    const handedOff = readRecord(currentRecordPath(machine.dataDir))!;
    expect(handedOff.mode).toBe("supervised");
    expect(handedOff.pendingBefore).toMatchObject({ approvals: [approval.id], asks: [askId], planRemarks: [plan.id], inbox: [wakeup.id] });

    // The supervisor stops the collector; dev.ts starts the next one.
    const finished = await superviseRestart(machine);
    expect(finished.outcome).toBe("ok");
    expect(finished.attempts[0]!.checks.map((c) => [c.name, c.ok])).toEqual([
      ["collector", true],
      ["persona", true],
      ["ui", true],
    ]);
    await abandoned;
    const c2 = machine.current!;
    expect(c2).not.toBe(c1);
    expect(readGoodHeads(machine.dataDir)[0]!.head).toBe(B);

    // The new collector boots: Persona starts, the report lands in its inbox.
    c2.runtime.start();
    await c2.restart.onCollectorReady();
    const reports = listPendingPersonaInbox(c2.store.db, OWNER, "system");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.threadId).toBe(c2.runtime.consoleThreadId());
    expect(reports[0]!.payload).toMatchObject({ type: "restart_report", restartId: handedOff.id, outcome: "ok" });
    const summary = String(reports[0]!.payload.summary);
    for (const line of ["approval cards 1/1 still pending", "worker asks 1/1 still pending", "plan review notes 1/1 still pending", "inbox items 1/1 still pending"]) {
      expect(summary).toContain(line);
    }
    expect(readRecord(currentRecordPath(machine.dataDir))!.delivered).toBe(true);

    // The approval card is still the owner's to decide.
    expect(getPersonaApproval(c2.store.db, approval.id)!.status).toBe("pending");
    const denied = await c2.post(`/api/persona/approvals/${approval.id}/deny`, { reason: "not now" }, { [OWNER_TOKEN_HEADER]: OWNER_SECRETS.ownerToken });
    expect(denied.status).toBe(200);
    expect(getPersonaInboxItem(c2.store.db, wakeup.id)!.status).toBe("pending");

    // The owner answers while the worker is still disconnected; its MCP
    // re-sends the call with the same request id and gets that answer.
    resolveAsk(c2.store.db, askId, "B, with the cache");
    const retried = await c2.post("/api/ask", { session_id: sessionId, cwd: "/w", question: "Approach A or B?", timeout_s: 60, request_id: "req-1" });
    expect(await retried.json()).toEqual({ answer: "B, with the cache" });
    const asks = c2.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE session_id = ?").get(sessionId) as { n: number };
    expect(asks.n).toBe(1);

    // The plan note written before the restart reaches the worker's retry.
    expect(getPlanReviewRemark(c2.store.db, plan.id)).toMatchObject({ note: "Keep the old API.", delivered: false });
    const planRetry = await c2.post("/api/plan/submit", { session_id: sessionId, plan: "Edit a.ts (again).", timeout_s: 0.05 });
    expect(await planRetry.json()).toMatchObject({ status: "approved", plan: "Edit a.ts.", note: "Keep the old API." });
    expect(getPlanApproval(c2.store.db, plan.id)!.status).toBe("approved");
    c2.close();
  });

  test("a re-sent submit_plan counts as re-attached; an ask raised without a request id is timed out at boot and reported", async () => {
    const machine = setUpMachine();
    const c1 = machine.current!;
    const { sessionId, plan } = seedWorker(c1);
    // The plan awaits review; the worker's call gave up waiting on it.
    expect(await (await c1.post("/api/plan/submit", { session_id: sessionId, plan: "Edit a.ts.", timeout_s: 0.05 })).json()).toMatchObject({
      status: "timeout",
    });
    // An older client (in another, ungated session) asks without a request id, so it can't re-attach after the restart.
    const other = randomUUID();
    createSession(c1.store.db, { id: other, projectId: "p", title: "other worker", cwd: "/w2", status: "running" });
    const abandoned = c1.post("/api/ask", { session_id: other, cwd: "/w2", question: "Old client?", timeout_s: 60 }).catch(() => null);
    const orphanId = () => (c1.store.db.query("SELECT id FROM asks WHERE question = 'Old client?'").get() as { id: string } | null)?.id;
    await until(() => !!orphanId(), "the ask");
    const orphan = orphanId()!;

    expect((await c1.tool("restart_standup", { reason: "roll in the fix" })).isError).toBe(false);
    await c1.restart.handoff;
    expect(readRecord(currentRecordPath(machine.dataDir))!.pendingBefore).toMatchObject({ asks: [orphan], plans: [plan.id] });
    expect((await superviseRestart(machine)).outcome).toBe("ok");
    await abandoned;
    const c2 = machine.current!;
    expect(c2.store.db.query("SELECT status FROM asks WHERE id = ?").get(orphan)).toEqual({ status: "timeout" });

    // The worker's MCP re-sends submit_plan to the new collector.
    expect(await (await c2.post("/api/plan/submit", { session_id: sessionId, plan: "Edit a.ts.", timeout_s: 0.05 })).json()).toMatchObject({
      status: "timeout",
    });
    c2.runtime.start();
    await c2.restart.onCollectorReady();
    const summary = String(listPendingPersonaInbox(c2.store.db, OWNER, "system")[0]!.payload.summary);
    expect(summary).toContain("plans awaiting review 1/1 still pending, 1 re-sent by their worker");
    expect(summary).toContain("worker asks 0/1 still pending, 1 timed out at boot");
    c2.close();
  });

  test("a waiter that re-attaches before the answer waits on the same ask and gets it", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    const { sessionId, plan } = seedWorker(c);
    expect((await c.post(`/api/plans/${plan.id}/approve`, {})).status).toBe(200);
    const first = c.post("/api/ask", { session_id: sessionId, cwd: "/w", question: "Q?", timeout_s: 60, request_id: "req-9" }).catch(() => null);
    await until(() => !!getAskByRequestId(c.store.db, sessionId, "req-9"), "the ask");
    const retry = c.post("/api/ask", { session_id: sessionId, cwd: "/w", question: "Q?", timeout_s: 60, request_id: "req-9" });
    await Bun.sleep(30);
    resolveAsk(c.store.db, getAskByRequestId(c.store.db, sessionId, "req-9")!.id, "yes");
    expect(await (await retry).json()).toEqual({ answer: "yes" });
    await first;
    const n = (c.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE session_id = ?").get(sessionId) as { n: number }).n;
    expect(n).toBe(1);
    // A request id naming a confirmation gate's ask is not an ask_human to re-attach to.
    createAsk(c.store.db, sessionId, "ask_human", "Fire the fix?", ["Fire the fix"], { gate: "standup_improvement", requestId: "g-1" });
    const gated = await c.post("/api/ask", { session_id: sessionId, cwd: "/w", question: "Q?", timeout_s: 1, request_id: "g-1" });
    expect(gated.status).toBe(409);
    c.close();
  });

  test("a self-fix proposal re-attaches by request id and launches once", async () => {
    const machine = setUpMachine();
    const c1 = machine.current!;
    const { sessionId } = seedWorker(c1);
    const propose = (c: Collector) =>
      c.post("/api/standup/improve", { session_id: sessionId, cwd: "/w", title: "Fix it", description: "Broken", kind: "bug", request_id: "imp-1" });
    const abandoned = propose(c1).catch(() => null);
    await until(() => !!getAskByRequestId(c1.store.db, sessionId, "imp-1"), "the confirmation");
    const askId = getAskByRequestId(c1.store.db, sessionId, "imp-1")!.id;
    // The collector restarts; the owner confirms on the new one before the worker re-sends.
    c1.close();
    await abandoned;
    const c2 = startCollector(machine.dbPath, machine.dataDir, machine.exec, 600);
    resolveAsk(c2.store.db, askId, "Fire the fix");
    const first = (await (await propose(c2)).json()) as { launched: boolean; askId: string; launch: { id: string } };
    expect(first).toMatchObject({ launched: true, askId, launch: { id: "launch-1" } });
    // The same call re-sent again (its reply was lost) gets that launch, not another.
    const again = (await (await propose(c2)).json()) as { launched: boolean; launch: { id: string } };
    expect(again).toMatchObject({ launched: true, launch: { id: "launch-1" } });
    expect(c2.launchCalls).toHaveLength(1);
    const n = (c2.store.db.query("SELECT COUNT(*) AS n FROM asks WHERE session_id = ?").get(sessionId) as { n: number }).n;
    expect(n).toBe(1);
    // A request id naming an ordinary ask (one ask_human raised) can't release a launch.
    const ordinary = createAsk(c2.store.db, sessionId, "ask_human", "Fire the fix?", ["Fire the fix"], { requestId: "q-1" });
    resolveAsk(c2.store.db, ordinary.id, "Fire the fix");
    const forged = await c2.post("/api/standup/improve", { session_id: sessionId, cwd: "/w", title: "x", description: "y", kind: "bug", request_id: "q-1" });
    expect(forged.status).toBe(409);
    expect(c2.launchCalls).toHaveLength(1);
    c2.close();
  });

  test("a self-fix re-sent with a different proposal is refused; concurrent re-sends launch once", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    const { sessionId } = seedWorker(c);
    const propose = (title: string) =>
      c.post("/api/standup/improve", { session_id: sessionId, cwd: "/w", title, description: "Broken", kind: "bug", request_id: "imp-2" });
    const first = propose("Fix it").catch(() => null);
    await until(() => !!getAskByRequestId(c.store.db, sessionId, "imp-2"), "the confirmation");
    const askId = getAskByRequestId(c.store.db, sessionId, "imp-2")!.id;
    // The owner confirmed "Fix it"; the same request id can't carry another proposal.
    const swapped = await propose("Delete the knowledge base");
    expect(swapped.status).toBe(409);
    expect(((await swapped.json()) as { error: string }).error).toContain("different self-fix proposal");
    // Launches are slow; two re-sent calls race once the owner confirms.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const launches: string[] = [];
    const slowLaunch = async (_db: unknown, request: { idempotencyKey?: string }) => {
      launches.push(String(request.idempotencyKey));
      await gate;
      return { launch: { id: "launch-slow", status: "starting" }, log: [] };
    };
    c.close();
    await first;
    const c2 = startCollectorWith(machine, 600, slowLaunch);
    resolveAsk(c2.store.db, askId, "Fire the fix");
    const send = () =>
      c2.post("/api/standup/improve", { session_id: sessionId, cwd: "/w", title: "Fix it", description: "Broken", kind: "bug", request_id: "imp-2" });
    const a = send();
    await until(() => launches.length === 1, "the launch");
    const b = await send();
    // The second waits on the first: told to re-send (a 5xx its MCP retries), never launched.
    expect(b.status).toBe(503);
    release();
    expect(await (await a).json()).toMatchObject({ launched: true, launch: { id: "launch-slow" } });
    expect(await (await send()).json()).toMatchObject({ launched: true, launch: { id: "launch-slow" } });
    expect(launches).toEqual([`improve:${askId}`]);
    c2.close();
  });

  test("a self-fix launch cut off by a restart resolves to the launch it stamped, or launches once", async () => {
    const machine = setUpMachine();
    const c1 = machine.current!;
    const { sessionId } = seedWorker(c1);
    const body = { session_id: sessionId, cwd: "/w", title: "Fix it", description: "Broken", kind: "bug" };
    const abandoned = c1.post("/api/standup/improve", { ...body, request_id: "imp-3" }).catch(() => null);
    await until(() => !!getAskByRequestId(c1.store.db, sessionId, "imp-3"), "the confirmation");
    const askId = getAskByRequestId(c1.store.db, sessionId, "imp-3")!.id;
    // The collector died mid-launch: its claim is left, and the launch row it stamped exists.
    c1.store.db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [`standup-improve-launch:${askId}`, JSON.stringify({ claim: "old-boot" })]);
    createLaunch(c1.store.db, { id: "launch-stamped", projectId: "p", task: "t", worktreePath: "/w2", branch: "b2", idempotencyKey: `improve:${askId}` });
    c1.close();
    await abandoned;
    const c2 = startCollector(machine.dbPath, machine.dataDir, machine.exec, 600);
    resolveAsk(c2.store.db, askId, "Fire the fix");
    expect(await (await c2.post("/api/standup/improve", { ...body, request_id: "imp-3" })).json()).toMatchObject({
      launched: true,
      launch: { id: "launch-stamped" },
    });
    expect(c2.launchCalls).toHaveLength(0);
    // A claim left with no launch row: that process died before launching, so this one launches, once.
    const other = createAsk(c2.store.db, sessionId, "ask_human", `Standup self-improvement proposed (bug): Fix it\n\nBroken\n\nFire a Claude session against the Standup repo to work this fix?`, ["Fire the fix", "Not now"], {
      gate: "standup_improvement",
      requestId: "imp-4",
    });
    resolveAsk(c2.store.db, other.id, "Fire the fix");
    c2.store.db.run("INSERT INTO settings (key, value) VALUES (?, ?)", [`standup-improve-launch:${other.id}`, JSON.stringify({ claim: "old-boot" })]);
    expect(await (await c2.post("/api/standup/improve", { ...body, request_id: "imp-4" })).json()).toMatchObject({ launched: true, launch: { id: "launch-1" } });
    expect(await (await c2.post("/api/standup/improve", { ...body, request_id: "imp-4" })).json()).toMatchObject({ launched: true, launch: { id: "launch-1" } });
    expect(c2.launchCalls).toHaveLength(1);
    expect(c2.launchCalls[0]).toMatchObject({ idempotencyKey: `improve:${other.id}` });
    c2.close();
  });

  test("a failed health check after the restart rolls back and the report says so", async () => {
    const machine = setUpMachine();
    const c1 = machine.current!;
    expect((await c1.tool("restart_standup", { reason: "roll in B" })).isError).toBe(false);
    await c1.restart.handoff;
    // B's collector comes up but Persona's state route fails; A is fine.
    const healthy = machine.probe;
    machine.probe = async (c, path) =>
      path === "/api/persona/state" && machine.world.head === B ? { status: 500, body: "{}" } : healthy(c, path);
    const finished = await superviseRestart(machine);
    expect(finished.outcome).toBe("rolled-back");
    expect(machine.world.runs).toContainEqual(["git", "-C", "/install", "checkout", "--detach", A]);
    expect(finished.attempts.map((a) => a.collectorPid)).toEqual([600, 601]);
    expect(readGoodHeads(machine.dataDir)[0]!.head).toBe(A);
    const c3 = machine.current!;
    c3.runtime.start();
    await c3.restart.onCollectorReady();
    const [report] = listPendingPersonaInbox(c3.store.db, OWNER, "system");
    expect(report!.payload).toMatchObject({ outcome: "rolled-back" });
    expect(String(report!.payload.summary)).toContain("ROLLED BACK");
    c3.close();
  });
});

describe("restart route and tool", () => {
  test("only Persona's token can restart; the owner can read progress", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    const body = { reason: "x" };
    expect((await c.post("/api/standup/restart", body)).status).toBe(401);
    expect((await c.post("/api/standup/restart", body, { [PERSONA_TOKEN_HEADER]: "nope" })).status).toBe(401);
    expect((await c.post("/api/standup/restart", body, { [DEFAULT_IDENTITY_HEADER]: "mallory-not-owner" })).status).toBe(401);
    const formPost = await c.app.request("/api/standup/restart", {
      method: "POST",
      headers: { "content-type": "text/plain", [PERSONA_TOKEN_HEADER]: c.runtime.token },
      body: JSON.stringify(body),
    });
    expect(formPost.status).toBe(403);
    const foreignHost = await c.app.request("http://evil.example/api/standup/restart", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: c.runtime.token },
      body: JSON.stringify(body),
    });
    expect(foreignHost.status).toBe(403);
    expect((await c.post("/api/standup/restart", {}, { [PERSONA_TOKEN_HEADER]: c.runtime.token })).status).toBe(400);
    expect(machine.world.spawns).toHaveLength(0);

    // Reading progress takes the owner secret (an identity alone is what any worker on the machine has) or Persona's token.
    expect((await c.app.request("/api/standup/restart")).status).toBe(403);
    expect((await c.app.request("/api/standup/restart", { headers: { [OWNER_TOKEN_HEADER]: "wrong" } })).status).toBe(403);
    expect((await c.app.request("/api/standup/restart", { headers: { [OWNER_TOKEN_HEADER]: OWNER_SECRETS.ownerToken } })).status).toBe(200);
    expect((await c.app.request("/api/standup/restart", { headers: { [PERSONA_TOKEN_HEADER]: c.runtime.token } })).status).toBe(200);
    expect(
      (await c.app.request("/api/standup/restart", { headers: { [OWNER_TOKEN_HEADER]: OWNER_SECRETS.ownerToken, [DEFAULT_IDENTITY_HEADER]: "mallory-not-owner" } })).status
    ).toBe(403);
    c.close();
  });

  test("a redeploy takes the local write token, not Persona's; it is a no-op when nothing changed and coalesces while a restart runs", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    const redeploy = { source: "redeploy", reason: "redeploy (post-merge) to bbbbbbb" };
    // No token at all is Persona's path, which refuses; a wrong write token is refused too.
    expect((await c.post("/api/standup/restart", redeploy)).status).toBe(401);
    expect((await c.post("/api/standup/restart", redeploy, { [WRITE_TOKEN_HEADER]: "nope" })).status).toBe(401);
    expect((await c.post("/api/standup/restart", redeploy, { [WRITE_TOKEN_HEADER]: "" })).status).toBe(401);
    // The write token asks only for redeploys, from a loopback Host, as JSON.
    expect((await c.post("/api/standup/restart", { reason: "x" }, { [WRITE_TOKEN_HEADER]: WRITE_TOKEN })).status).toBe(400);
    const foreignHost = await c.app.request("http://evil.example/api/standup/restart", {
      method: "POST",
      headers: { "content-type": "application/json", [WRITE_TOKEN_HEADER]: WRITE_TOKEN },
      body: JSON.stringify(redeploy),
    });
    expect(foreignHost.status).toBe(403);
    const formPost = await c.app.request("/api/standup/restart", {
      method: "POST",
      headers: { "content-type": "text/plain", [WRITE_TOKEN_HEADER]: WRITE_TOKEN },
      body: JSON.stringify(redeploy),
    });
    expect(formPost.status).toBe(403);
    expect(machine.world.spawns).toHaveLength(0);

    // HEAD (B) is not the last good commit (A): the redeploy restarts, with no Persona thread.
    const scheduled = await c.post("/api/standup/restart", redeploy, { [WRITE_TOKEN_HEADER]: WRITE_TOKEN });
    expect(scheduled.status).toBe(202);
    const body = (await scheduled.json()) as { status: string; id: string };
    expect(body.status).toBe("scheduled");
    await c.restart.handoff;
    expect(readRecord(currentRecordPath(machine.dataDir))).toMatchObject({ id: body.id, source: "redeploy", requestedBy: "redeploy" });
    const again = await c.post("/api/standup/restart", redeploy, { [WRITE_TOKEN_HEADER]: WRITE_TOKEN });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "coalesced", id: body.id });
    expect(machine.world.spawns).toHaveLength(1);
    // Persona's token still restarts (here: refused, one is under way).
    expect((await c.post("/api/standup/restart", { reason: "x" }, { [PERSONA_TOKEN_HEADER]: c.runtime.token })).status).toBe(409);
    c.close();

    // A collector already on HEAD answers a redeploy with a no-op.
    const fresh = setUpMachine();
    recordGoodHead(fresh.dataDir, B);
    const noop = await fresh.current!.post("/api/standup/restart", redeploy, { [WRITE_TOKEN_HEADER]: WRITE_TOKEN });
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ status: "noop", head: B });
    expect(fresh.world.spawns).toHaveLength(0);
    fresh.current!.close();
  });

  test("a second restart while one is under way is refused", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    expect((await c.tool("restart_standup", { reason: "first" })).isError).toBe(false);
    await c.restart.handoff;
    const second = await c.tool("restart_standup", { reason: "second" });
    expect(second.isError).toBe(true);
    expect(second.text).toContain("already in progress");
    expect(machine.world.spawns).toHaveLength(1);
    c.close();
  });

  test("restart_standup needs a reason and acts without an approval card, unless the owner holds it", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    expect((await c.tool("restart_standup", {})).text).toContain("reason is required");
    expect((await c.tool("restart_standup", { reason: "x", uiUrl: "file:///etc/passwd" })).text).toContain("uiUrl must be an http(s) URL");
    c.close();
    const held = startCollector(join(machine.dataDir, "held.db"), machine.dataDir, machine.exec, OLD_PID, { hold: ["restart_standup"] });
    const card = await held.tool("restart_standup", { reason: "roll in the fix" });
    expect(JSON.parse(card.text)).toMatchObject({ status: "pending_approval" });
    expect(machine.world.spawns).toHaveLength(0);
    held.close();
  });

  test("a restart asked for inside a turn waits for that turn to settle, and its retry is the same restart", async () => {
    const machine = setUpMachine();
    const c = machine.current!;
    let spawnedDuringTurn = -1;
    const r = c.runtime as unknown as { turnRunner: () => Promise<unknown> };
    const replies: string[] = [];
    r.turnRunner = async () => {
      replies.push((await c.tool("restart_standup", { reason: "roll in the fix" })).text);
      await Bun.sleep(20);
      spawnedDuringTurn = machine.world.spawns.length;
      return { ok: true, text: "Restarting Standup now; I'll report back.", sessionId: "sid-turn" };
    };
    const message = c.runtime.receiveUserMessage({ text: "restart standup to pick up the fix", actor: OWNER });
    await c.runtime.drain();
    await c.restart.handoff;
    expect(replies[0]).toMatch(/^restart scheduled/);
    expect(spawnedDuringTurn).toBe(0);
    expect(machine.world.spawns).toHaveLength(1);
    // The turn's item settled before the stop, so the next collector won't replay it.
    const item = c.store.db.query("SELECT status FROM persona_inbox WHERE payload_json LIKE ?").get(`%${message.id}%`) as { status: string };
    expect(item.status).toBe("done");
    // The same batch asking again (a retried turn) maps to the same restart.
    const record = readRecord(currentRecordPath(machine.dataDir))!;
    const again = await c.post(
      "/api/standup/restart",
      { reason: "roll in the fix", threadId: record.threadId, batchKey: record.batchKey },
      { [PERSONA_TOKEN_HEADER]: c.runtime.token }
    );
    expect(again.status).toBe(200);
    // The collector runs under bun --watch here, which the answer warns about.
    expect(await again.json()).toMatchObject({ id: record.id, duplicate: true, warnings: [expect.stringContaining("bun --watch")] });
    c.close();
  });
});
