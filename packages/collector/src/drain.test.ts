import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  approvePlan,
  createAsk,
  createLaunch,
  createPlanApproval,
  createSession,
  createStore,
  createTicket,
  getAsk,
  getPlanApprovalByLaunch,
  getTicket,
  resolveAsk,
  submitPlan,
  updateTicketStatus,
  upsertProject,
} from "@standup/store";
import { DRAINING_HEADER, DRAINING_RELEASED, DRAINING_REFUSED } from "@standup/shared/topology";
import {
  Drain,
  DrainReleasedError,
  drainReleasedResponse,
  shutdownSignalGate,
  sleepUnlessReleased,
  waitForIdle,
} from "./drain.js";
import { waitForAskResolution } from "./asks.js";
import { checkAcceptanceCriterion } from "./plan-gate.js";
import { createServer } from "./server.js";
import { generateOwnerSecrets } from "./owner-secret.js";

/** A minimal app wired the way createServer wires drain: middleware first, released waits via onError. */
function app(drain: Drain) {
  const a = new Hono();
  a.use("*", drain.middleware());
  a.onError((err, c) => (err instanceof DrainReleasedError ? drainReleasedResponse() : c.text("boom", 500)));
  a.get("/quick", (c) => c.json({ ok: true }));
  a.get("/wait", async (c) => {
    await sleepUnlessReleased(10_000, drain.signal);
    return c.json({ ok: true });
  });
  return a;
}

describe("Drain", () => {
  test("serves normally until draining begins", async () => {
    const drain = new Drain();
    const res = await app(drain).request("/quick");
    expect(res.status).toBe(200);
    expect(res.headers.get(DRAINING_HEADER)).toBeNull();
    expect(drain.draining).toBe(false);
  });

  test("a request arriving while draining is refused, never processed", async () => {
    const drain = new Drain();
    const a = app(drain);
    let ran = false;
    a.get("/side-effect", (c) => {
      ran = true;
      return c.json({});
    });
    drain.begin();
    for (const path of ["/quick", "/side-effect", "/health"]) {
      const res = await a.request(path);
      expect(res.status).toBe(503);
      expect(res.headers.get(DRAINING_HEADER)).toBe(DRAINING_REFUSED);
      expect(await res.json()).toEqual({ error: "draining" });
    }
    expect(ran).toBe(false);
  });

  test("an in-flight long wait is released with the released header", async () => {
    const drain = new Drain();
    const pending = app(drain).request("/wait");
    await Bun.sleep(20);
    const startedAt = Date.now();
    drain.begin();
    const res = await pending;
    // Released at once, not at the end of its 10s wait.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(res.status).toBe(503);
    expect(res.headers.get(DRAINING_HEADER)).toBe(DRAINING_RELEASED);
    expect(await res.json()).toEqual({ error: "draining" });
  });

  test("begin is idempotent", () => {
    const drain = new Drain();
    expect(drain.begin()).toBe(true);
    expect(drain.begin()).toBe(false);
    expect(drain.draining).toBe(true);
    expect(drain.signal.aborted).toBe(true);
  });

  test("a wait started after draining began is released at once", async () => {
    const drain = new Drain();
    drain.begin();
    await expect(sleepUnlessReleased(10_000, drain.signal)).rejects.toBeInstanceOf(DrainReleasedError);
  });

  test("waitForIdle resolves when the count reaches zero, or false at the deadline", async () => {
    let n = 2;
    setTimeout(() => (n = 0), 30);
    expect(await waitForIdle(() => n, 1_000, 5)).toBe(true);
    expect(await waitForIdle(() => 1, 40, 5)).toBe(false);
  });
});

describe("waitForAskResolution under drain", () => {
  test("releases the waiter and leaves the ask pending for a re-attach", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp", parentSessionId: undefined, status: "running" });
    const ask = createAsk(store.db, "s", "ask_human", "Proceed?", undefined, { requestId: "req-1" });
    const drain = new Drain();
    const waiting = waitForAskResolution(store.db, ask.id, 60, drain.signal);
    await Bun.sleep(20);
    drain.begin();
    await expect(waiting).rejects.toBeInstanceOf(DrainReleasedError);
    expect(getAsk(store.db, ask.id)?.status).toBe("pending");
    store.close();
  });

  test("an answer that landed since the last poll is returned instead of a release", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
    createSession(store.db, { id: "s", projectId: "p", title: "t", cwd: "/tmp", parentSessionId: undefined, status: "running" });
    const ask = createAsk(store.db, "s", "ask_human", "Proceed?", undefined, { requestId: "req-2" });
    const drain = new Drain();
    const waiting = waitForAskResolution(store.db, ask.id, 60, drain.signal);
    await Bun.sleep(20);
    resolveAsk(store.db, ask.id, "Yes, go.");
    drain.begin();
    expect(await waiting).toEqual({ answer: "Yes, go.", timedOut: false });
    store.close();
  });
});

describe("shutdownSignalGate", () => {
  test("the first signal drains, a repeat within the grace is ignored, a later one forces", () => {
    let t = 1_000;
    const classify = shutdownSignalGate(1_000, () => t);
    expect(classify()).toBe("drain");
    // Ctrl+C's SIGINT, then dev.ts's relayed SIGTERM.
    t += 40;
    expect(classify()).toBe("ignore");
    t += 900;
    expect(classify()).toBe("ignore");
    t += 100;
    expect(classify()).toBe("force");
  });
});

describe("Drain.track", () => {
  test("counts a task until it settles, resolved or rejected", async () => {
    const drain = new Drain();
    let resolveA!: () => void;
    let rejectB!: (e: Error) => void;
    const a = drain.track(new Promise<void>((r) => (resolveA = r)));
    const b = drain.track(new Promise<void>((_, r) => (rejectB = r)));
    b.catch(() => {});
    expect(drain.pendingTasks).toBe(2);
    resolveA();
    await a;
    expect(drain.pendingTasks).toBe(1);
    rejectB(new Error("x"));
    await b.catch(() => {});
    await Bun.sleep(0);
    expect(drain.pendingTasks).toBe(0);
  });
});

/** Whether `pid` is still a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `file` until it holds a pid. */
async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (/^\d+$/.test(text)) return Number(text);
    await Bun.sleep(10);
  }
  throw new Error(`no pid in ${file}`);
}

// The criterion backgrounds a grandchild and waits on it, so a kill of the
// shell alone would leave it running: only a group kill passes.
const LONG_CRITERION = "sleep 30 & echo $! > child.pid; wait";

describe("checkAcceptanceCriterion under drain", () => {
  test("a drain kills the criterion's whole process group and releases the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-drain-criterion-"));
    try {
      const drain = new Drain();
      const running = checkAcceptanceCriterion(dir, LONG_CRITERION, 60_000, undefined, drain.signal);
      const child = await readPid(join(dir, "child.pid"));
      expect(alive(child)).toBe(true);
      const startedAt = Date.now();
      drain.begin();
      await expect(running).rejects.toBeInstanceOf(DrainReleasedError);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await Bun.sleep(20);
      expect(alive(child)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a criterion started after the drain began is released without running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-drain-criterion-"));
    try {
      const drain = new Drain();
      drain.begin();
      await expect(checkAcceptanceCriterion(dir, "touch ran", 60_000, undefined, drain.signal)).rejects.toBeInstanceOf(
        DrainReleasedError
      );
      expect(existsSync(join(dir, "ran"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a drain signal a failing criterion is just not met", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-drain-criterion-"));
    try {
      expect((await checkAcceptanceCriterion(dir, "exit 3")).met).toBe(false);
      expect((await checkAcceptanceCriterion(dir, "true")).met).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mark_ready_for_review under drain", () => {
  test("a criterion run in flight is released as 503 released and leaves the ticket for the retry", async () => {
    const store = createStore(":memory:");
    const worktree = mkdtempSync(join(tmpdir(), "standup-drain-ready-"));
    try {
      upsertProject(store.db, { id: "p", name: "P", branch: "main", repos: [] });
      const launch = createLaunch(store.db, {
        id: randomUUID(),
        projectId: "p",
        task: "Do the thing",
        worktreePath: worktree,
        branch: "standup/thing",
        status: "running",
      });
      const gate = createPlanApproval(store.db, { launchId: launch.id, projectId: "p", worktreePath: worktree });
      submitPlan(store.db, gate.id, { relevantFiles: [], plan: "the plan", acceptanceCriterion: LONG_CRITERION });
      approvePlan(store.db, gate.id, { acceptanceCriterion: LONG_CRITERION });
      const ticket = createTicket(store.db, { projectId: "p", lens: "bugs", title: "Fix it", body: "…" });
      store.db.run("UPDATE tickets SET launch_id = ? WHERE id = ?", [launch.id, ticket.id]);
      updateTicketStatus(store.db, ticket.id, "approved");
      updateTicketStatus(store.db, ticket.id, "developing");

      const drain = new Drain();
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
        { ownerSecrets: generateOwnerSecrets() },
        undefined,
        { drain }
      );
      const ready = (server: typeof app) =>
        server.request(`/api/tickets/${ticket.id}/ready`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: worktree, readyReason: "done" }),
        });

      const pending = ready(app);
      const child = await readPid(join(worktree, "child.pid"));
      drain.begin();
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.headers.get(DRAINING_HEADER)).toBe(DRAINING_RELEASED);
      await Bun.sleep(20);
      expect(alive(child)).toBe(false);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
      expect(getPlanApprovalByLaunch(store.db, launch.id)!.criterionMet).toBeFalsy();

      // The retry, on the next leader, runs the criterion again: nothing was cached.
      approvePlan(store.db, gate.id, { acceptanceCriterion: "false" });
      const next = createServer(
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
        { ownerSecrets: generateOwnerSecrets() },
        undefined,
        { drain: new Drain() }
      );
      expect((await ready(next)).status).toBe(409);
      expect(getTicket(store.db, ticket.id)!.status).toBe("developing");
    } finally {
      store.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
