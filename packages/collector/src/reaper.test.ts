import { expect, test, describe } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  createSession,
  createLaunch,
  createAsk,
  endSession,
  getSession,
  getPendingAsksBySession,
  getCheckpointsBySession,
  getRecentEventsBySession,
  insertEvent,
  reviveSession,
  retireLaunchHookAuth,
  setLaunchHookAuth,
  setLaunchHookTokenHash,
  updateLaunchStatus,
  upsertProject,
  getLaunch,
  setLaunchPhase,
  createTaskRun,
  getTaskRun,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { LaunchPhase, SessionStatus, WsMessage } from "@standup/shared";
import { IDLE_NOTICE_GATE } from "./persona/events.js";
import {
  reapDeadSessions,
  endStaleMonitoredSessions,
  monitoredStaleThresholds,
  MIN_MONITORED_STALE_MS,
  type MonitoredStaleThresholds,
  failStaleStartingLaunches,
  failStrandedStartingLaunches,
  reaperTick,
  killStartingPane,
  staleStartingMs,
  StartingPhaseClock,
  LAUNCHER_PROVISION_TIMEOUT_MS,
  STRANDED_STARTING_LAUNCH_REASON,
  type StaleStartingOptions,
} from "./reaper.js";
import { drainLaunchQueue, stepTimeoutMs } from "./launcher.js";
import { DEFAULT_HEADROOM_THRESHOLDS, HostMonitor, LaunchQueue, type HostMetrics } from "./host-headroom.js";

function setUp(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return store;
}

/** A launched session with a tmux pane and one pending permission ask. */
function launchedSessionWithAsk(store: Store, id: string): void {
  createSession(store.db, {
    id,
    projectId: "p",
    title: "t",
    cwd: `/tmp/${id}`,
    status: "waiting",
  });
  createLaunch(store.db, {
    id: `launch-${id}`,
    projectId: "p",
    task: "t",
    worktreePath: `/tmp/${id}`,
    branch: "main",
    tmuxSession: `tmux-${id}`,
    sessionId: id,
    status: "running",
  });
  createAsk(store.db, id, "permission_prompt", "may I?");
}

describe("reapDeadSessions", () => {
  test("reaps a launched session whose tmux pane is gone and cancels its asks", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "dead");

    const reaped = reapDeadSessions(store.db, () => false); // pane gone

    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.sessionId).toBe("dead");
    expect(reaped[0]!.cancelledAsks).toHaveLength(1);
    // Session is now ended and the ask no longer sits in "Needs you".
    expect(getSession(store.db, "dead")?.endedAt).toBeDefined();
    expect(getPendingAsksBySession(store.db, "dead")).toHaveLength(0);
  });

  test("leaves a launched session whose pane is still alive untouched", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "alive");

    const reaped = reapDeadSessions(store.db, () => true); // pane alive

    expect(reaped).toHaveLength(0);
    expect(getSession(store.db, "alive")?.endedAt).toBeUndefined();
    expect(getPendingAsksBySession(store.db, "alive")).toHaveLength(1);
  });

  test("ignores monitored sessions with no launch (Standup doesn't own their terminal)", () => {
    const store = setUp();
    createSession(store.db, {
      id: "monitored",
      projectId: "p",
      title: "t",
      cwd: "/tmp/monitored",
      status: "waiting",
    });
    createAsk(store.db, "monitored", "permission_prompt", "may I?");

    // Even claiming every pane is dead, a session with no launch is skipped.
    const reaped = reapDeadSessions(store.db, () => false);

    expect(reaped).toHaveLength(0);
    expect(getSession(store.db, "monitored")?.endedAt).toBeUndefined();
    expect(getPendingAsksBySession(store.db, "monitored")).toHaveLength(1);
  });
});

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");

/** SQLite `datetime('now')` text for `ms`. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** A `starting` launch in `phase`, created `ageMs` before NOW, with its queued task run. */
function startingLaunch(store: Store, id: string, phase: LaunchPhase, ageMs: number): void {
  createLaunch(store.db, {
    id,
    projectId: "p",
    task: "t",
    worktreePath: `/tmp/wt-${id}`,
    branch: `b-${id}`,
    tmuxSession: `tmux-${id}`,
    status: "starting",
  });
  setLaunchPhase(store.db, id, phase);
  store.db.run("UPDATE launches SET created_at = ? WHERE id = ?", [sqliteUtc(NOW - ageMs), id]);
  createTaskRun(store.db, { id: `run-${id}`, projectId: "p", worktreePath: `/tmp/wt-${id}` });
}

describe("staleStartingMs", () => {
  test("defaults to the provision cap plus a setup step plus five minutes", () => {
    expect(staleStartingMs({})).toBe(40 * MINUTE);
  });

  test("follows STANDUP_PROVISION_TIMEOUT_MS, and STANDUP_STALE_STARTING_MS overrides it", () => {
    expect(staleStartingMs({ STANDUP_PROVISION_TIMEOUT_MS: String(60 * MINUTE) })).toBe(70 * MINUTE);
    expect(staleStartingMs({ STANDUP_STALE_STARTING_MS: String(90 * MINUTE) })).toBe(90 * MINUTE);
    expect(staleStartingMs({ STANDUP_STALE_STARTING_MS: "nonsense" })).toBe(40 * MINUTE);
  });

  test("the provision cap it mirrors still matches launcher.ts, and the step cap is launcher.ts's own", () => {
    const launcher = readFileSync(join(import.meta.dir, "launcher.ts"), "utf8");
    expect(launcher).toMatch(/const PROVISION_TIMEOUT_MS = [^;]*: 30 \* 60 \* 1000;/);
    expect(LAUNCHER_PROVISION_TIMEOUT_MS).toBe(30 * MINUTE);
    expect(stepTimeoutMs({})).toBe(5 * MINUTE);
    expect(staleStartingMs({})).toBe(LAUNCHER_PROVISION_TIMEOUT_MS + stepTimeoutMs({}) + 5 * MINUTE);
  });

  test("a raised STANDUP_STEP_TIMEOUT_MS raises the stale cutoff, and one the launcher ignores is ignored here too", () => {
    expect(staleStartingMs({ STANDUP_STEP_TIMEOUT_MS: String(20 * MINUTE) })).toBe(55 * MINUTE);
    expect(staleStartingMs({ STANDUP_STEP_TIMEOUT_MS: "5m" })).toBe(40 * MINUTE);
    expect(staleStartingMs({ STANDUP_STEP_TIMEOUT_MS: String(20 * MINUTE), STANDUP_STALE_STARTING_MS: String(90 * MINUTE) })).toBe(
      90 * MINUTE
    );
  });
});

describe("failStaleStartingLaunches", () => {
  /** Sweep options pinned to NOW and a 40-minute threshold, with pane kills recorded instead of run. */
  function sweepOpts(overrides: Partial<StaleStartingOptions> = {}) {
    const killed: string[] = [];
    const opts: StaleStartingOptions = {
      now: NOW,
      maxAgeMs: 40 * MINUTE,
      isQueued: () => false,
      clock: new StartingPhaseClock(),
      killPane: async (session) => {
        killed.push(session);
        return { ok: true, output: "" };
      },
      ...overrides,
    };
    return { opts, killed };
  }

  test("fails a 40-minute-old provisioning launch, kills its pane and cancels its task run", async () => {
    const store = setUp();
    startingLaunch(store, "old", "provisioning", 40 * MINUTE);
    const { opts, killed } = sweepOpts();

    const failed = failStaleStartingLaunches(store.db, opts);
    await Bun.sleep(0);

    expect(failed.map((l) => l.id)).toEqual(["old"]);
    const launch = getLaunch(store.db, "old")!;
    expect(launch.status).toBe("failed");
    expect(launch.phase).toBeUndefined();
    expect(launch.error).toContain("while provisioning");
    expect(getTaskRun(store.db, "run-old")?.status).toBe("cancelled");
    expect(killed).toEqual(["tmux-old"]);
  });

  test("leaves a fresh provisioning launch alone", () => {
    const store = setUp();
    startingLaunch(store, "fresh", "provisioning", 2 * MINUTE);
    const { opts, killed } = sweepOpts();

    const failed = failStaleStartingLaunches(store.db, opts);

    expect(failed).toHaveLength(0);
    expect(getLaunch(store.db, "fresh")?.status).toBe("starting");
    expect(getTaskRun(store.db, "run-fresh")?.status).toBe("queued");
    expect(killed).toEqual([]);
  });

  test("leaves a launch the host-headroom queue still holds alone, however old", () => {
    const store = setUp();
    startingLaunch(store, "waiting", "queued", 3 * 60 * MINUTE);
    const { opts } = sweepOpts({ isQueued: (id) => id === "waiting" });

    const failed = failStaleStartingLaunches(store.db, opts);

    expect(failed).toHaveLength(0);
    expect(getLaunch(store.db, "waiting")?.status).toBe("starting");
  });

  test("by default asks the collector's launch queue whether a launch is queued", () => {
    const store = setUp();
    startingLaunch(store, "orphan", "queued", 3 * 60 * MINUTE);
    const { opts } = sweepOpts({ isQueued: undefined });

    // The collector's queue holds nothing in this process, so the old queued row is stale.
    const failed = failStaleStartingLaunches(store.db, opts);

    expect(failed.map((l) => l.id)).toEqual(["orphan"]);
  });

  test("time spent queued never counts once the queue releases the launch", () => {
    const store = setUp();
    const clock = new StartingPhaseClock();
    startingLaunch(store, "late", "queued", 60 * MINUTE);
    failStaleStartingLaunches(store.db, sweepOpts({ isQueued: () => true, clock }).opts);

    // Released by the drain; the row still reads `queued` until its first step starts.
    const released = failStaleStartingLaunches(store.db, sweepOpts({ now: NOW + MINUTE / 2, clock }).opts);
    expect(released).toHaveLength(0);

    setLaunchPhase(store.db, "late", "provisioning");
    const soon = failStaleStartingLaunches(store.db, sweepOpts({ now: NOW + MINUTE, clock }).opts);
    expect(soon).toHaveLength(0);

    const later = failStaleStartingLaunches(store.db, sweepOpts({ now: NOW + 41 * MINUTE, clock }).opts);
    expect(later.map((l) => l.id)).toEqual(["late"]);
  });

  test("the threshold is configurable", () => {
    const store = setUp();
    startingLaunch(store, "building", "building", 10 * MINUTE);

    expect(failStaleStartingLaunches(store.db, sweepOpts({ maxAgeMs: 15 * MINUTE }).opts)).toHaveLength(0);
    const strict = failStaleStartingLaunches(store.db, sweepOpts({ maxAgeMs: 5 * MINUTE }).opts);
    expect(strict.map((l) => l.id)).toEqual(["building"]);
  });

  test("a pane that can't be killed is logged and its launch is still failed", async () => {
    const store = setUp();
    startingLaunch(store, "a", "provisioning", 50 * MINUTE);
    startingLaunch(store, "b", "provisioning", 50 * MINUTE);
    startingLaunch(store, "c", "provisioning", 50 * MINUTE);
    const errors: string[] = [];
    const { opts } = sweepOpts({
      killPane: async (session) => {
        if (session === "tmux-a") return { ok: false, output: "no server running" };
        if (session === "tmux-b") throw new Error("spawn failed");
        return { ok: true, output: "" };
      },
      log: { error: (msg: string) => errors.push(msg) },
    });

    const failed = failStaleStartingLaunches(store.db, opts);
    await Bun.sleep(0);

    expect(failed.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(getTaskRun(store.db, "run-a")?.status).toBe("cancelled");
    expect(errors.sort()).toEqual([
      "[reaper] could not kill the pane of starting launch a: no server running",
      "[reaper] could not kill the pane of starting launch b: spawn failed",
    ]);
  });
});

describe("killStartingPane", () => {
  test("kills a live session by its exact name", async () => {
    const ran: string[][] = [];
    const result = await killStartingPane("tmux-x", {
      exists: () => true,
      run: async (argv) => {
        ran.push(argv);
        return { ok: true, output: "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(1);
    expect(ran[0]![0]).toBe("tmux");
    expect(ran[0]!.slice(-3)).toEqual(["kill-session", "-t", "=tmux-x"]);
  });

  test("runs nothing for a session that isn't up", async () => {
    const ran: string[][] = [];
    const result = await killStartingPane("tmux-x", {
      exists: () => false,
      run: async (argv) => {
        ran.push(argv);
        return { ok: true, output: "" };
      },
    });

    expect(result.ok).toBe(true);
    expect(ran).toHaveLength(0);
  });

  test("reports a failed kill", async () => {
    const result = await killStartingPane("tmux-x", {
      exists: () => true,
      run: async () => ({ ok: false, output: "can't find session" }),
    });

    expect(result).toEqual({ ok: false, output: "can't find session" });
  });
});

describe("failStrandedStartingLaunches", () => {
  test("fails every non-queued starting launch at boot, whatever its age, and leaves queued and running ones", async () => {
    const store = setUp();
    startingLaunch(store, "prov", "provisioning", 0);
    startingLaunch(store, "build", "building", MINUTE);
    startingLaunch(store, "spawn", "starting", MINUTE);
    startingLaunch(store, "queued", "queued", MINUTE);
    createLaunch(store.db, { id: "running", projectId: "p", task: "t", worktreePath: "/tmp/r", branch: "r", status: "running" });
    const killed: string[] = [];

    const failed = failStrandedStartingLaunches(store.db, {
      killPane: async (session) => {
        killed.push(session);
        return { ok: true, output: "" };
      },
    });
    await Bun.sleep(0);

    expect(failed.map((l) => l.id).sort()).toEqual(["build", "prov", "spawn"]);
    expect(killed.sort()).toEqual(["tmux-build", "tmux-prov", "tmux-spawn"]);
    for (const id of ["prov", "build", "spawn"]) {
      expect(getLaunch(store.db, id)?.error).toBe(STRANDED_STARTING_LAUNCH_REASON);
      expect(getTaskRun(store.db, `run-${id}`)?.status).toBe("cancelled");
    }
    expect(getLaunch(store.db, "queued")?.status).toBe("starting");
    expect(getLaunch(store.db, "running")?.status).toBe("running");
  });
});

/** A host whose free memory can be set: no /proc reads. */
function fakeHost(memAvailableBytes: number) {
  let reading: HostMetrics = { memAvailableBytes, load1: 0, cores: 4 };
  const monitor = new HostMonitor({ provider: () => reading, thresholds: { ...DEFAULT_HEADROOM_THRESHOLDS, warmupMs: 0 } });
  return {
    monitor,
    setFree(bytes: number) {
      reading = { ...reading, memAvailableBytes: bytes };
    },
  };
}

describe("reaperTick", () => {
  const GiB = 1024 ** 3;

  test("a step that throws is logged and the queue is still drained", async () => {
    const store = setUp();
    startingLaunch(store, "q", "queued", 0);
    const host = fakeHost(0);
    const queue = new LaunchQueue(host.monitor);
    const ticket = queue.admit("q");
    expect(ticket).not.toBeNull();
    host.setFree(64 * GiB);

    const errors: string[] = [];
    const sent: WsMessage[] = [];
    reaperTick({
      db: store.db,
      broadcast: (m) => sent.push(m),
      unwatch: () => {},
      reapDeadSessions: () => {
        throw new Error("boom");
      },
      reapDeadCodexLaunches: () => [],
      failStaleStartingLaunches: () => [],
      drainLaunchQueue: (db) => drainLaunchQueue(db, queue),
      log: { log: () => {}, error: (msg: string) => errors.push(msg) },
    });

    expect(await ticket!.ready).toBe(true);
    expect(queue.size).toBe(0);
    expect(errors).toEqual(["[reaper] dead-session reap failed: boom"]);
  });

  test("ends a stale monitored session, broadcasts its end and logs an audit line", () => {
    const store = setUp();
    monitoredSession(store, "gone", { lastEventAgoMs: 7 * HOUR });
    monitoredSession(store, "gone-child", { lastEventAgoMs: 7 * HOUR, parentSessionId: "gone" });
    const ask = createAsk(store.db, "gone", "permission_prompt", "still there?", undefined, { gate: IDLE_NOTICE_GATE });
    const sent: WsMessage[] = [];
    const logged: string[] = [];
    const unwatched: string[] = [];
    reaperTick({
      db: store.db,
      broadcast: (m) => sent.push(m),
      unwatch: (id) => unwatched.push(id),
      reapDeadSessions: () => [],
      endStaleMonitoredSessions: (db) => endStaleMonitoredSessions(db, { now: NOW, thresholds: THRESHOLDS }),
      reapDeadCodexLaunches: () => [],
      failStaleStartingLaunches: () => [],
      drainLaunchQueue: () => [],
      log: { log: (msg: string) => logged.push(msg), error: () => {} },
    });

    expect(unwatched).toEqual(["gone-child", "gone"]);
    expect(sent.map((m) => [m.type, m.payload])).toEqual([
      ["ask:resolved", { askId: ask.id, answer: "" }],
      ["checkpoint:new", expect.objectContaining({ sessionId: "gone", source: "structural" })],
      ["session:end", { sessionId: "gone-child", endReason: "stale" }],
      ["session:end", { sessionId: "gone", endReason: "stale" }],
    ]);
    expect(logged).toEqual([
      "[reaper] Ended monitored session gone as stale: silent 7h since 2026-10-13T05:00:00.000Z, no SessionEnd; 1 subagent(s) ended, 1 ask(s) cancelled",
    ]);
  });

  test("broadcasts each launch the stale sweep failed", () => {
    const store = setUp();
    startingLaunch(store, "stuck", "provisioning", 0);
    const stuck = getLaunch(store.db, "stuck")!;
    const sent: WsMessage[] = [];
    reaperTick({
      db: store.db,
      broadcast: (m) => sent.push(m),
      unwatch: () => {},
      reapDeadSessions: () => [],
      reapDeadCodexLaunches: () => [],
      failStaleStartingLaunches: () => [{ ...stuck, status: "failed" }],
      drainLaunchQueue: () => [],
      log: { log: () => {}, error: () => {} },
    });

    expect(sent.map((m) => m.type)).toEqual(["launch:started"]);
    expect((sent[0]!.payload as { id: string }).id).toBe("stuck");
  });
});

const HOUR = 60 * MINUTE;
const THRESHOLDS: MonitoredStaleThresholds = { enabled: true, staleMs: 6 * HOUR, waitingMs: 24 * HOUR };

/**
 * A session with no launch, started a day before NOW, whose one event landed
 * `lastEventAgoMs` before NOW (none when null).
 */
function monitoredSession(
  store: Store,
  id: string,
  {
    lastEventAgoMs,
    status = "idle",
    parentSessionId,
    payload = {},
  }: { lastEventAgoMs: number | null; status?: SessionStatus; parentSessionId?: string; payload?: Record<string, unknown> }
): void {
  createSession(store.db, { id, projectId: "p", title: "t", cwd: `/tmp/${id}`, status, parentSessionId });
  store.db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [sqliteUtc(NOW - 24 * HOUR), id]);
  if (lastEventAgoMs === null) return;
  const seq = insertEvent(store.db, id, "Stop", { hook_event_name: "Stop", session_id: id, ...payload });
  store.db.run("UPDATE events SET created_at = ? WHERE session_id = ? AND seq = ?", [
    sqliteUtc(NOW - lastEventAgoMs),
    id,
    seq,
  ]);
}

describe("endStaleMonitoredSessions", () => {
  const sweep = (store: Store, opts: { now?: number; thresholds?: MonitoredStaleThresholds; maxEnds?: number } = {}) =>
    endStaleMonitoredSessions(store.db, { now: NOW, thresholds: THRESHOLDS, ...opts });

  test("ends a monitored session silent past the threshold, records a checkpoint and cancels its asks", () => {
    const store = setUp();
    monitoredSession(store, "gone", { lastEventAgoMs: 7 * HOUR });
    createAsk(store.db, "gone", "permission_prompt", "still there?", undefined, { gate: IDLE_NOTICE_GATE });

    const ended = sweep(store);

    expect(ended.map((e) => e.sessionId)).toEqual(["gone"]);
    expect(ended[0]!.silentMs).toBe(7 * HOUR);
    expect(ended[0]!.cancelledAsks).toHaveLength(1);
    expect(getSession(store.db, "gone")).toMatchObject({ endedAt: expect.any(Date), endReason: "stale" });
    expect(getPendingAsksBySession(store.db, "gone")).toHaveLength(0);
    const checkpoints = getCheckpointsBySession(store.db, "gone");
    expect(checkpoints.map((c) => [c.source, c.summary])).toEqual([
      ["structural", "Ended (stale): no hook event or transcript write for 7h; its next hook revives it."],
    ]);
    // The end adds no event, so the session's recency is unchanged.
    expect(getRecentEventsBySession(store.db, "gone", 10)).toHaveLength(1);
  });

  test("keeps a monitored session with recent activity", () => {
    const store = setUp();
    monitoredSession(store, "active", { lastEventAgoMs: 5 * MINUTE, status: "running" });

    expect(sweep(store)).toEqual([]);
    expect(getSession(store.db, "active")?.endedAt).toBeUndefined();
    expect(getCheckpointsBySession(store.db, "active")).toHaveLength(0);
  });

  test("the threshold is inclusive: silent exactly staleMs is ended, a second less is kept", () => {
    const store = setUp();
    monitoredSession(store, "edge", { lastEventAgoMs: 6 * HOUR });

    expect(sweep(store, { now: NOW - 1000 })).toEqual([]);
    expect(sweep(store).map((e) => e.sessionId)).toEqual(["edge"]);
  });

  test("a transcript still growing keeps a session whose last hook event is old", () => {
    const store = setUp();
    const dir = mkdtempSync(join(tmpdir(), "reaper-transcript-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "{}\n");
    utimesSync(transcript, new Date(NOW - 10 * MINUTE), new Date(NOW - 10 * MINUTE));
    try {
      monitoredSession(store, "writing", { lastEventAgoMs: 12 * HOUR, payload: { transcript_path: transcript } });
      expect(sweep(store)).toEqual([]);

      utimesSync(transcript, new Date(NOW - 8 * HOUR), new Date(NOW - 8 * HOUR));
      monitoredSession(store, "quiet", { lastEventAgoMs: 12 * HOUR, payload: { transcript_path: transcript } });
      expect(sweep(store).map((e) => e.sessionId).sort()).toEqual(["quiet", "writing"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session with no events is timed from its start", () => {
    const store = setUp();
    monitoredSession(store, "silent", { lastEventAgoMs: null });

    expect(sweep(store, { now: NOW - 20 * HOUR })).toEqual([]);
    expect(sweep(store).map((e) => e.sessionId)).toEqual(["silent"]);
  });

  test("a session a human owes an answer gets the longer threshold", () => {
    const store = setUp();
    monitoredSession(store, "asking", { lastEventAgoMs: 7 * HOUR });
    createAsk(store.db, "asking", "ask_human", "which one?");
    monitoredSession(store, "waiting", { lastEventAgoMs: 7 * HOUR, status: "waiting" });

    expect(sweep(store)).toEqual([]);
    expect(sweep(store, { now: NOW + 18 * HOUR }).map((e) => e.sessionId).sort()).toEqual(["asking", "waiting"]);
    expect(getPendingAsksBySession(store.db, "asking")).toHaveLength(0);
  });

  test("never touches a launched worker, with or without a pane, however silent", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "worker");
    store.db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [sqliteUtc(NOW - 30 * 24 * HOUR), "worker"]);
    monitoredSession(store, "paneless", { lastEventAgoMs: 30 * 24 * HOUR, status: "running" });
    createLaunch(store.db, {
      id: "launch-paneless",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/paneless",
      branch: "main",
      sessionId: "paneless",
      status: "running",
    });

    expect(sweep(store, { now: NOW + 30 * 24 * HOUR })).toEqual([]);
    for (const id of ["worker", "paneless"]) {
      expect(getSession(store.db, id)?.endedAt).toBeUndefined();
      expect(getCheckpointsBySession(store.db, id)).toHaveLength(0);
    }
    expect(getPendingAsksBySession(store.db, "worker")).toHaveLength(1);
  });

  test("a session resumed by hand outside its launch is swept as monitored, and the pane reaper leaves it", () => {
    const store = setUp();
    // A failed adopt whose session was revived by hand after it ended.
    launchedSessionWithAsk(store, "hand-resumed");
    updateLaunchStatus(store.db, "launch-hand-resumed", "failed", "adopt failed");
    endSession(store.db, "hand-resumed");
    reviveSession(store.db, "hand-resumed", { outsideLaunch: true });
    // A running launch whose session now reports without its hook token.
    launchedSessionWithAsk(store, "retired");
    setLaunchHookTokenHash(store.db, "launch-retired", "hash");
    setLaunchHookAuth(store.db, "launch-retired");
    retireLaunchHookAuth(store.db, "launch-retired");
    // A cleaned launch whose pane was killed with no SessionEnd: its own worker's session.
    launchedSessionWithAsk(store, "cleaned");
    updateLaunchStatus(store.db, "launch-cleaned", "cleaned");
    // A running launch whose proof holds.
    launchedSessionWithAsk(store, "proven");
    setLaunchHookTokenHash(store.db, "launch-proven", "hash-2");
    setLaunchHookAuth(store.db, "launch-proven");
    for (const id of ["hand-resumed", "retired", "cleaned", "proven"]) {
      store.db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [sqliteUtc(NOW - 48 * HOUR), id]);
    }

    // Every pane is gone: the launches' own sessions are reaped at once, as before.
    expect(reapDeadSessions(store.db, () => false).map((r) => r.sessionId).sort()).toEqual(["cleaned", "proven"]);
    expect(getSession(store.db, "cleaned")?.endReason).toBeUndefined();
    expect(getSession(store.db, "hand-resumed")?.endedAt).toBeUndefined();

    const ended = sweep(store);
    expect(ended.map((e) => e.sessionId).sort()).toEqual(["hand-resumed", "retired"]);
    for (const id of ["hand-resumed", "retired"]) expect(getSession(store.db, id)?.endReason).toBe("stale");
  });

  test("a dead pane whose session a hand copy reports for is ended as stale, and the tick says so", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "copied");
    launchedSessionWithAsk(store, "plain");

    const reaped = reapDeadSessions(store.db, () => false, (id) => id === "copied");
    expect(reaped.map((r) => [r.sessionId, r.stale ?? false]).sort()).toEqual([
      ["copied", true],
      ["plain", false],
    ]);
    expect(getSession(store.db, "copied")?.endReason).toBe("stale");
    expect(getSession(store.db, "plain")?.endReason).toBeUndefined();

    const sent: WsMessage[] = [];
    reaperTick({
      db: store.db,
      broadcast: (m) => sent.push(m),
      unwatch: () => {},
      reapDeadSessions: () => [{ sessionId: "copied", cancelledAsks: [], stale: true }],
      endStaleMonitoredSessions: () => [],
      reapDeadCodexLaunches: () => [],
      failStaleStartingLaunches: () => [],
      drainLaunchQueue: () => [],
      log: { log: () => {}, error: () => {} },
    });
    expect(sent.map((m) => m.payload)).toEqual([{ sessionId: "copied", endReason: "stale" }]);
  });

  test("a running launch's session revived from inside it stays the pane reaper's", () => {
    const store = setUp();
    launchedSessionWithAsk(store, "own");
    endSession(store.db, "own");
    reviveSession(store.db, "own");
    store.db.run("UPDATE sessions SET started_at = ? WHERE id = ?", [sqliteUtc(NOW - 48 * HOUR), "own"]);

    expect(sweep(store)).toEqual([]);
    expect(reapDeadSessions(store.db, () => false).map((r) => r.sessionId)).toEqual(["own"]);
  });

  test("ends the open subagent sessions under an ended session", () => {
    const store = setUp();
    monitoredSession(store, "root", { lastEventAgoMs: 7 * HOUR });
    monitoredSession(store, "root-child", { lastEventAgoMs: 7 * HOUR, parentSessionId: "root" });
    createAsk(store.db, "root-child", "permission_prompt", "still there?", undefined, { gate: IDLE_NOTICE_GATE });

    const ended = sweep(store);

    expect(ended.map((e) => [e.sessionId, e.endedChildren, e.cancelledAsks.length])).toEqual([["root", ["root-child"], 1]]);
    expect(getSession(store.db, "root-child")?.endReason).toBe("stale");
    expect(getPendingAsksBySession(store.db, "root-child")).toHaveLength(0);
  });

  test("a revived session is active again and swept afresh", () => {
    const store = setUp();
    monitoredSession(store, "back", { lastEventAgoMs: 7 * HOUR });
    expect(sweep(store)).toHaveLength(1);

    reviveSession(store.db, "back");
    expect(getSession(store.db, "back")?.endReason).toBeUndefined();
    expect(sweep(store, { now: NOW + 1 })).toHaveLength(1);
  });

  test("ends at most maxEnds sessions per sweep, and none when disabled", () => {
    const store = setUp();
    for (const id of ["a", "b", "c"]) monitoredSession(store, id, { lastEventAgoMs: 7 * HOUR });

    expect(sweep(store, { thresholds: { ...THRESHOLDS, enabled: false } })).toEqual([]);
    expect(sweep(store, { maxEnds: 2 })).toHaveLength(2);
    expect(sweep(store, { maxEnds: 2 })).toHaveLength(1);
  });
});

describe("monitoredStaleThresholds", () => {
  test("defaults to 6h, 24h when a human owes an answer, and reads its overrides", () => {
    expect(monitoredStaleThresholds({})).toEqual({ enabled: true, staleMs: 6 * HOUR, waitingMs: 24 * HOUR });
    expect(
      monitoredStaleThresholds({
        STANDUP_MONITORED_REAP: "0",
        STANDUP_MONITORED_STALE_MS: "3600000",
        STANDUP_MONITORED_WAITING_STALE_MS: "nope",
      })
    ).toEqual({ enabled: false, staleMs: HOUR, waitingMs: 24 * HOUR });
  });

  test("a suffixed value is ignored, a tiny one is raised to the floor, and waiting is never shorter", () => {
    expect(monitoredStaleThresholds({ STANDUP_MONITORED_STALE_MS: "1000", STANDUP_MONITORED_WAITING_STALE_MS: "6h" })).toEqual({
      enabled: true,
      staleMs: MIN_MONITORED_STALE_MS,
      waitingMs: 24 * HOUR,
    });
    expect(monitoredStaleThresholds({ STANDUP_MONITORED_WAITING_STALE_MS: "1000" })).toEqual({
      enabled: true,
      staleMs: 6 * HOUR,
      waitingMs: 6 * HOUR,
    });
  });

  test("a session whose end fails stays active, and the others in the sweep are still returned", () => {
    const store = setUp();
    monitoredSession(store, "ok", { lastEventAgoMs: 7 * HOUR });
    monitoredSession(store, "broken", { lastEventAgoMs: 7 * HOUR });
    store.db.exec(
      "CREATE TRIGGER fail_broken BEFORE INSERT ON checkpoints WHEN NEW.session_id = 'broken' BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    );

    const ended = endStaleMonitoredSessions(store.db, { now: NOW, thresholds: THRESHOLDS });

    expect(ended.map((e) => e.sessionId)).toEqual(["ok"]);
    expect(getSession(store.db, "broken")).toMatchObject({ endedAt: undefined, endReason: undefined });
    expect(getSession(store.db, "ok")?.endReason).toBe("stale");
  });
});
