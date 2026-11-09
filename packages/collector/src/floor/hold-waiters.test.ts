import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { Hono } from "hono";
import {
  attachSessionToLaunch,
  createAsk,
  createLaunch,
  createSession,
  createStore,
  getAsk,
  getSession,
  resolvePendingAsk,
  setLaunchWorkerTokenHash,
  upsertProject,
} from "@standup/store";
import type { Ask, WsMessage } from "@standup/shared";
import { generateOwnerSecrets } from "../owner-secret.js";
import { waitForAskResolution } from "../asks.js";
import {
  FLOOR_ABANDON_GRACE_MS,
  FLOOR_GATE,
  FLOOR_HOLD_ROUTE,
  FLOOR_OPTIONS,
  FLOOR_UNREACHABLE_GRACE_MS,
  FLOOR_WORKER_TOKEN_HEADER,
  floorCallHash,
  workerTokenHash,
} from "./gate.js";
import type { FloorHoldRequest, FloorHoldResponse } from "./gate.js";
import { mountFloorRoutes, type FloorRoutesOptions } from "./routes.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A store with one launched worker; `seed` runs before the routes mount (the previous collector's holds). */
function setUp(opts: Partial<FloorRoutesOptions> = {}, seed?: (ctx: { db: ReturnType<typeof createStore>["db"]; sessionId: string }) => void) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
  const root = mkdtempSync(join(tmpdir(), "floor-waiters-"));
  dirs.push(root);
  const launchId = randomUUID();
  const sessionId = randomUUID();
  const workerToken = randomUUID() + randomUUID();
  createLaunch(store.db, { id: launchId, projectId: "p", task: "t", worktreePath: root, branch: "feature" });
  createSession(store.db, { id: sessionId, projectId: "p", title: "worker", cwd: root, status: "running" });
  attachSessionToLaunch(store.db, launchId, sessionId);
  setLaunchWorkerTokenHash(store.db, launchId, workerTokenHash(workerToken));
  seed?.({ db: store.db, sessionId });
  const frames: WsMessage[] = [];
  const app = new Hono();
  mountFloorRoutes(app, {
    db: store.db,
    broadcast: (m) => frames.push(m),
    personaHandles: () => true,
    resolveCallingSession: (id) => (id ? getSession(store.db, id) : null),
    notifyOwner: () => {},
    secrets: generateOwnerSecrets(),
    awsIdentity: { cached: () => null, resolve: async () => null },
    log: () => {},
    abandonGraceMs: 300,
    ...opts,
  });

  const body = (command: string, requestId = `toolu_${randomUUID()}`): FloorHoldRequest => ({
    session_id: sessionId,
    cwd: root,
    launch_id: launchId,
    request_id: requestId,
    tool_name: "Bash",
    tool_input: { command },
    hold: { category: "destructive", ownerOnly: false, reason: "deletes outside the worktree", step: command },
    wait_s: 30,
  });
  const init = (b: FloorHoldRequest, signal?: AbortSignal): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: workerToken },
    body: JSON.stringify(b),
    ...(signal ? { signal } : {}),
  });
  const askFor = async (requestId: string): Promise<Ask> => {
    for (let i = 0; i < 400; i++) {
      const row = store.db.query("SELECT id FROM asks WHERE request_id = ?").get(requestId) as { id: string } | null;
      if (row) return getAsk(store.db, row.id)!;
      await Bun.sleep(5);
    }
    throw new Error(`no ask for ${requestId}`);
  };
  const resolvedFrames = (askId: string) =>
    frames.filter((f) => f.type === "ask:resolved" && (f.payload as { askId: string }).askId === askId);
  return { store, app, root, sessionId, frames, body, init, askFor, resolvedFrames };
}

describe("a hold whose hook goes away", () => {
  test("Bun aborts the request when the hook's connection closes, and the hold times out after the grace with an ask:resolved", async () => {
    const h = setUp();
    const server = Bun.serve({ port: 0, fetch: h.app.fetch, idleTimeout: 0 });
    try {
      const b = h.body("rm -rf /tmp/elsewhere");
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${server.port}${FLOOR_HOLD_ROUTE}`, h.init(b, controller.signal)).catch(() => null);
      const ask = await h.askFor(b.request_id);
      expect(getSession(h.store.db, h.sessionId)?.status).toBe("waiting");
      controller.abort();
      await pending;
      // Still pending inside the grace: the hook may be about to re-attach.
      await Bun.sleep(150);
      expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
      for (let i = 0; i < 100 && getAsk(h.store.db, ask.id)?.status === "pending"; i++) await Bun.sleep(20);
      expect(getAsk(h.store.db, ask.id)?.status).toBe("timeout");
      expect(h.resolvedFrames(ask.id).map((f) => (f.payload as { answer: string }).answer)).toEqual([""]);
      expect(getSession(h.store.db, h.sessionId)?.status).toBe("running");
      expect(h.frames.some((f) => f.type === "session:status" && (f.payload as { status: string }).status === "running")).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a hook that re-attaches within the grace keeps its hold, and gets the decision on the new request", async () => {
    const h = setUp();
    const b = h.body("rm -rf /tmp/elsewhere");
    const controller = new AbortController();
    const first = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, controller.signal));
    const ask = await h.askFor(b.request_id);
    controller.abort();
    expect((await first).status).toBe(400);
    const second = h.app.request(FLOOR_HOLD_ROUTE, h.init(b));
    await Bun.sleep(600);
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
    expect(h.resolvedFrames(ask.id)).toHaveLength(0);
    resolvePendingAsk(h.store.db, ask.id, "Allow once", "alice");
    const r = await second;
    expect(r.status).toBe(200);
    expect((await r.json()) as FloorHoldResponse).toMatchObject({ decision: "allow", askId: ask.id });
  });

  test("an allow that lands after the hook left isn't spent on the closed connection", async () => {
    const h = setUp({ abandonGraceMs: 5_000 });
    const b = h.body("rm -rf /tmp/elsewhere");
    const controller = new AbortController();
    const first = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, controller.signal));
    const ask = await h.askFor(b.request_id);
    controller.abort();
    resolvePendingAsk(h.store.db, ask.id, "Allow once", "alice");
    expect((await first).status).toBe(400);
    const again = await h.app.request(FLOOR_HOLD_ROUTE, h.init(b));
    expect((await again.json()) as FloorHoldResponse).toMatchObject({ decision: "allow", askId: ask.id });
  });

  test("a hook that re-attached and dropped again isn't timed out by the first drop's grace", async () => {
    const h = setUp({ abandonGraceMs: 400 });
    const b = h.body("rm -rf /tmp/elsewhere");
    const first = new AbortController();
    const one = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, first.signal));
    const ask = await h.askFor(b.request_id);
    first.abort();
    await one;
    await Bun.sleep(250);
    const second = new AbortController();
    const two = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, second.signal));
    await Bun.sleep(50);
    second.abort();
    await two;
    // Past the first drop's grace, but not the second's.
    await Bun.sleep(250);
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
    for (let i = 0; i < 100 && getAsk(h.store.db, ask.id)?.status === "pending"; i++) await Bun.sleep(20);
    expect(getAsk(h.store.db, ask.id)?.status).toBe("timeout");
  });

  test("requests under the hold's request id without the worker token don't hold off its lapse", async () => {
    const h = setUp({ abandonGraceMs: 300 });
    const b = h.body("rm -rf /tmp/elsewhere");
    const controller = new AbortController();
    const first = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, controller.signal));
    const ask = await h.askFor(b.request_id);
    controller.abort();
    await first;
    const forged = { ...h.init(b), headers: { "content-type": "application/json", [FLOOR_WORKER_TOKEN_HEADER]: "not-the-token" } };
    for (let i = 0; i < 12 && getAsk(h.store.db, ask.id)?.status === "pending"; i++) {
      expect((await h.app.request(FLOOR_HOLD_ROUTE, forged)).status).toBe(403);
      await Bun.sleep(50);
    }
    expect(getAsk(h.store.db, ask.id)?.status).toBe("timeout");
  });

  test("a hook still long-polling when an earlier drop's grace runs out keeps its hold", async () => {
    const h = setUp({ abandonGraceMs: 200 });
    const b = h.body("rm -rf /tmp/elsewhere");
    const first = new AbortController();
    const one = h.app.request(FLOOR_HOLD_ROUTE, h.init(b, first.signal));
    const ask = await h.askFor(b.request_id);
    // A second request for the hold arrives before the first drops.
    const two = h.app.request(FLOOR_HOLD_ROUTE, h.init(b));
    await Bun.sleep(20);
    first.abort();
    await one;
    await Bun.sleep(400);
    expect(getAsk(h.store.db, ask.id)?.status).toBe("pending");
    resolvePendingAsk(h.store.db, ask.id, "Deny", "alice");
    expect(((await (await two).json()) as FloorHoldResponse).decision).toBe("deny");
  });

  test("the abandon grace outlasts the hook's unreachable grace, so a gateway restart doesn't lapse live holds", () => {
    expect(FLOOR_ABANDON_GRACE_MS).toBeGreaterThan(FLOOR_UNREACHABLE_GRACE_MS);
  });

  test("a hold whose wait runs out is announced as resolved", async () => {
    const h = setUp();
    const b = { ...h.body("rm -rf /tmp/elsewhere"), wait_s: 1 };
    const r = await h.app.request(FLOOR_HOLD_ROUTE, h.init(b));
    const reply = (await r.json()) as FloorHoldResponse;
    expect(reply).toMatchObject({ decision: "deny", timed_out: true });
    expect(h.resolvedFrames(reply.askId)).toHaveLength(1);
  });
});

describe("holds the previous collector raised", () => {
  const seedHold = (db: ReturnType<typeof createStore>["db"], sessionId: string, requestId: string, command = "rm -rf /tmp/x", cwd = "/") =>
    createAsk(db, sessionId, "ask_human", `Safety floor held a Bash call (destructive): ${command}`, [...FLOOR_OPTIONS], {
      gate: FLOOR_GATE,
      requestId,
      callHash: floorCallHash({ toolName: "Bash", toolInput: { command }, cwd }),
      floorExpiresAt: new Date(Date.now() + 3_600_000),
    });

  test("time out once the hook's grace has passed unless their hook re-attached; a criterion's hold is left to its deadline", async () => {
    const ids: Record<string, string> = {};
    const h = setUp({ bootReattachGraceMs: 400 }, ({ db, sessionId }) => {
      ids.gone = seedHold(db, sessionId, "toolu_gone").id;
      ids.criterion = seedHold(db, sessionId, "criterion:gate-1:abc:0").id;
    });
    // The surviving hook re-attaches: same request id, same call.
    const back = h.body("rm -rf /tmp/back", "toolu_back");
    ids.back = seedHold(h.store.db, h.sessionId, "toolu_back", "rm -rf /tmp/back", h.root).id;
    const waiting = h.app.request(FLOOR_HOLD_ROUTE, h.init(back));
    await Bun.sleep(700);
    expect(getAsk(h.store.db, ids.gone)?.status).toBe("timeout");
    expect(h.resolvedFrames(ids.gone)).toHaveLength(1);
    expect(getAsk(h.store.db, ids.criterion)?.status).toBe("pending");
    expect(getAsk(h.store.db, ids.back)?.status).toBe("pending");
    resolvePendingAsk(h.store.db, ids.back, "Deny", "alice");
    expect(((await (await waiting).json()) as FloorHoldResponse).decision).toBe("deny");
  });

  test("one whose hook re-attached and then dropped isn't lapsed by the boot grace, but by the abandon grace after its drop", async () => {
    let id = "";
    const h = setUp({ bootReattachGraceMs: 300, abandonGraceMs: 600 }, ({ db, sessionId }) => {
      id = seedHold(db, sessionId, "toolu_back", "rm -rf /tmp/back", "").id;
    });
    // The seed ran before the worktree root was known; point the hold's call hash at it.
    h.store.db.run("UPDATE asks SET call_hash = ? WHERE id = ?", [
      floorCallHash({ toolName: "Bash", toolInput: { command: "rm -rf /tmp/back" }, cwd: h.root }),
      id,
    ]);
    const controller = new AbortController();
    const back = h.app.request(FLOOR_HOLD_ROUTE, h.init(h.body("rm -rf /tmp/back", "toolu_back"), controller.signal));
    await Bun.sleep(100);
    controller.abort();
    await back;
    // Past the boot grace: the drop's own grace owns the lapse now.
    await Bun.sleep(350);
    expect(getAsk(h.store.db, id)?.status).toBe("pending");
    for (let i = 0; i < 100 && getAsk(h.store.db, id)?.status === "pending"; i++) await Bun.sleep(20);
    expect(getAsk(h.store.db, id)?.status).toBe("timeout");
  });

  test("a draining collector times out nothing", async () => {
    const drain = new AbortController();
    let id = "";
    const h = setUp({ bootReattachGraceMs: 50, drainSignal: drain.signal }, ({ db, sessionId }) => {
      id = seedHold(db, sessionId, "toolu_gone").id;
    });
    drain.abort();
    await Bun.sleep(200);
    expect(getAsk(h.store.db, id)?.status).toBe("pending");
    expect(h.resolvedFrames(id)).toHaveLength(0);
  });
});

describe("waitForAskResolution", () => {
  test("its deadline doesn't overwrite an answer that landed since the last poll", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    createSession(store.db, { id: "s", projectId: "p", title: "w", cwd: "/", status: "running" });
    const ask = createAsk(store.db, "s", "ask_human", "q?");
    resolvePendingAsk(store.db, ask.id, "yes", "alice");
    expect(await waitForAskResolution(store.db, ask.id, 0)).toEqual({ answer: "yes", timedOut: false });
    expect(getAsk(store.db, ask.id)).toMatchObject({ status: "answered", answer: "yes" });
  });
});
