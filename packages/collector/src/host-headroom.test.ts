import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, getLaunch, getActiveTaskRunByWorktree } from "@standup/store";
import type { Project } from "@standup/shared";
import { activeBudgetLine } from "@standup/shared";
import {
  DEFAULT_HEADROOM_THRESHOLDS,
  HostMonitor,
  LaunchQueue,
  assessHeadroom,
  deferForHostPressure,
  effectiveCap,
  hostHeadroomView,
  parseLoad1,
  parseMemAvailable,
  parseMemTotal,
  queuedLaunchNote,
  resolveHeadroomThresholds,
  type HostMetrics,
} from "./host-headroom.js";
import {
  launchSession,
  stopLaunch,
  drainLaunchQueue,
  failStrandedQueuedLaunches,
  STRANDED_QUEUED_LAUNCH_REASON,
} from "./launcher.js";

const GiB = 1024 ** 3;
const T = DEFAULT_HEADROOM_THRESHOLDS;

/** A settable fake host: no /proc reads, no load generation. */
function fakeHost(initial: HostMetrics) {
  let reading: HostMetrics | null = initial;
  let nowMs = 1_000_000;
  const monitor = new HostMonitor({ provider: () => reading, thresholds: T, now: () => nowMs });
  return {
    monitor,
    set(next: Partial<HostMetrics> | null) {
      reading = next === null ? null : { ...(reading ?? initial), ...next };
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("host readings", () => {
  test("parses MemAvailable and MemTotal (kB) and the 1-minute load", () => {
    const meminfo = "MemTotal:       64424176 kB\nMemFree:        13541000 kB\nMemAvailable:    3250000 kB\n";
    expect(parseMemAvailable(meminfo)).toBe(3_250_000 * 1024);
    expect(parseMemAvailable("MemTotal: 1 kB\n")).toBeNull();
    expect(parseMemTotal(meminfo)).toBe(64_424_176 * 1024);
    expect(parseMemTotal("MemAvailable: 1 kB\n")).toBeNull();
    expect(parseLoad1("1.20 0.85 0.60 2/1234 5678\n")).toBe(1.2);
    expect(parseLoad1("")).toBeNull();
  });

  test("thresholds default to a 2 GB reserve, 1.5 GB per worker, load ≤ cores, 2 min warm-up; env overrides each", () => {
    expect(resolveHeadroomThresholds({})).toEqual({
      minFreeBytes: 2 * GiB,
      perWorkerBytes: 1.5 * GiB,
      maxLoadPerCore: 1,
      warmupMs: 120_000,
    });
    expect(
      resolveHeadroomThresholds({
        STANDUP_HOST_MIN_FREE_MB: "4096",
        STANDUP_HOST_WORKER_MB: "1024",
        STANDUP_HOST_MAX_LOAD_PER_CORE: "0.75",
        STANDUP_HOST_WARMUP_S: "30",
      })
    ).toEqual({ minFreeBytes: 4 * GiB, perWorkerBytes: 1 * GiB, maxLoadPerCore: 0.75, warmupMs: 30_000 });
    // Nonsense falls back to the default rather than disabling the check.
    expect(resolveHeadroomThresholds({ STANDUP_HOST_MIN_FREE_MB: "-1" }).minFreeBytes).toBe(2 * GiB);
  });
});

describe("assessHeadroom / effectiveCap", () => {
  test("each 1.5 GB above the 2 GB reserve is one slot", () => {
    const h = assessHeadroom({ memAvailableBytes: 6.6 * GiB, load1: 1, cores: 4 }, T);
    expect(h.slots).toBe(3);
    expect(h.shortReason).toBeNull();
  });

  test("memory under the reserve admits nothing, in plain words", () => {
    const h = assessHeadroom({ memAvailableBytes: 1.4 * GiB, load1: 1, cores: 4 }, T);
    expect(h.slots).toBe(0);
    expect(h.shortReason).toBe("memory is low (1.4 GB free, 2.0 GB is kept in reserve)");
  });

  test("a 1-minute load above the core count admits nothing, however much memory is free", () => {
    const h = assessHeadroom({ memAvailableBytes: 30 * GiB, load1: 4.5, cores: 4 }, T);
    expect(h.slots).toBe(0);
    expect(h.shortReason).toBe("the CPU is busy (load 4.5 on 4 cores, limit 4.0)");
  });

  test("free memory above the reserve but short of one worker's budget admits nothing", () => {
    const h = assessHeadroom({ memAvailableBytes: 3.1 * GiB, load1: 1, cores: 4 }, T);
    expect(h.slots).toBe(0);
    expect(h.shortReason).toContain("3.1 GB free leaves no room for another worker");
  });

  test("workers still warming up are counted against the slots", () => {
    const h = assessHeadroom({ memAvailableBytes: 5.1 * GiB, load1: 1, cores: 4 }, T, 2);
    expect(h.slots).toBe(0);
    expect(h.shortReason).toBe("2 workers just started and are still claiming memory; 5.1 GB free");
  });

  test("no reading (non-Linux, or turned off) enforces nothing", () => {
    expect(assessHeadroom(null, T)).toEqual({ metrics: null, slots: Infinity, shortReason: null });
    expect(effectiveCap(6, 2, assessHeadroom(null, T))).toEqual({ cap: 6, hostLimited: false });
  });

  test("effective cap = min(configured, running + slots)", () => {
    const roomy = assessHeadroom({ memAvailableBytes: 40 * GiB, load1: 2, cores: 32 }, T);
    expect(effectiveCap(6, 2, roomy)).toEqual({ cap: 6, hostLimited: false });
    const tight = assessHeadroom({ memAvailableBytes: 3.6 * GiB, load1: 1.2, cores: 4 }, T);
    expect(effectiveCap(6, 2, tight)).toEqual({ cap: 3, hostLimited: true });
  });
});

describe("budget line", () => {
  test("shows the effective cap and the host reading; queued launches are counted apart", () => {
    const host = fakeHost({ memAvailableBytes: 3.6 * GiB, load1: 1.2, cores: 4 });
    expect(activeBudgetLine(2, 6, hostHeadroomView(6, 2, 0, host.monitor))).toBe(
      "active 2/3 (host-limited; 3.6 GB free, load 1.2/4)"
    );
    host.set({ memAvailableBytes: 1.2 * GiB });
    expect(activeBudgetLine(3, 6, hostHeadroomView(6, 3, 1, host.monitor))).toBe(
      "active 2/2 (host-limited; 1.2 GB free, load 1.2/4) · 1 queued for host room"
    );
    host.set({ memAvailableBytes: 40 * GiB, cores: 32, load1: 2 });
    expect(activeBudgetLine(2, 6, hostHeadroomView(6, 2, 0, host.monitor))).toBe(
      "active 2/6 (host: 40.0 GB free, load 2.0/32)"
    );
    host.set(null);
    expect(activeBudgetLine(2, 6, hostHeadroomView(6, 2, 0, host.monitor))).toBe("active 2/6");
    expect(activeBudgetLine(2, 6)).toBe("active 2/6");
  });

  test("the view carries MemTotal next to MemAvailable when the reading has it", () => {
    const host = fakeHost({ memAvailableBytes: 224 * GiB, memTotalBytes: 247 * GiB, load1: 5.2, cores: 64 });
    expect(hostHeadroomView(55, 4, 0, host.monitor)).toEqual({
      effectiveMaxActive: 55,
      hostLimited: false,
      memAvailableBytes: 224 * GiB,
      memTotalBytes: 247 * GiB,
      load1: 5.2,
      cores: 64,
      queued: 0,
    });
    host.set({ memTotalBytes: undefined });
    expect(hostHeadroomView(55, 4, 0, host.monitor)).not.toHaveProperty("memTotalBytes");
  });
});

describe("HostMonitor.pressure / deferForHostPressure", () => {
  test("background work yields only under the hard floors, not for want of a worker slot", () => {
    const host = fakeHost({ memAvailableBytes: 3 * GiB, load1: 1, cores: 4 });
    // No slot for a worker, but above the reserve: batch work goes on.
    expect(host.monitor.headroom().slots).toBe(0);
    expect(host.monitor.pressure()).toBeNull();
    expect(deferForHostPressure("test-job", host.monitor)).toBe(false);

    host.set({ memAvailableBytes: 1.5 * GiB });
    expect(host.monitor.pressure()).toBe("memory is low (1.5 GB free, 2.0 GB is kept in reserve)");
    expect(deferForHostPressure("test-job", host.monitor)).toBe(true);

    host.set({ memAvailableBytes: 8 * GiB, load1: 9 });
    expect(deferForHostPressure("test-job", host.monitor)).toBe(true);

    host.set({ load1: 2 });
    expect(deferForHostPressure("test-job", host.monitor)).toBe(false);
  });
});

describe("LaunchQueue", () => {
  test("admits while there is room, queues once there is not, and starts the queue in order as room returns", async () => {
    const host = fakeHost({ memAvailableBytes: 5 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    // 5 GB − 2 GB reserve = 2 slots.
    expect(queue.admit("a")).toBeNull();
    expect(queue.admit("b")).toBeNull();
    // Both are warming up, so the same reading has no room left.
    const c = queue.admit("c");
    expect(c).not.toBeNull();
    expect(c!.ahead).toBe(0);
    expect(c!.reason).toBe("2 workers just started and are still claiming memory; 5.0 GB free");
    const d = queue.admit("d")!;
    expect(d.ahead).toBe(1);
    expect(queue.describe("d")).toMatchObject({ ahead: 1 });

    // Still warming up: nothing drains.
    expect(queue.drain()).toEqual([]);
    // Past the warm-up, the reading's two slots start both, oldest first.
    host.advance(T.warmupMs + 1);
    expect(queue.drain()).toEqual(["c", "d"]);
    expect(queue.size).toBe(0);
    expect(await c!.ready).toBe(true);
    expect(await d.ready).toBe(true);
  });

  test("a later launch never jumps an earlier one, even when a slot opens", () => {
    const host = fakeHost({ memAvailableBytes: 1 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    expect(queue.admit("first")).not.toBeNull();
    host.set({ memAvailableBytes: 10 * GiB });
    const second = queue.admit("second");
    expect(second).not.toBeNull();
    expect(second!.reason).toBe("1 earlier launch is already waiting for room");
    expect(queue.drain()).toEqual(["first", "second"]);
  });

  test("a stopped launch is dropped without taking a slot, and cancel releases it as not-started", async () => {
    const host = fakeHost({ memAvailableBytes: 1 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    const gone = queue.admit("gone")!;
    const kept = queue.admit("kept")!;
    const cancelled = queue.admit("cancelled")!;
    expect(queue.cancel("cancelled")).toBe(true);
    expect(await cancelled.ready).toBe(false);
    expect(queue.cancel("cancelled")).toBe(false);

    host.set({ memAvailableBytes: 3.6 * GiB }); // one slot
    expect(queue.drain((id) => id !== "gone")).toEqual(["kept"]);
    expect(await gone.ready).toBe(false);
    expect(await kept.ready).toBe(true);
  });

  test("the queued note says it was queued, why, and what happens next", () => {
    expect(queuedLaunchNote({ reason: "the CPU is busy (load 35.2 on 32 cores, limit 32.0)", ahead: 0 })).toBe(
      "Queued, not started: the CPU is busy (load 35.2 on 32 cores, limit 32.0). It starts on its own, in order, " +
        "when the host has room; it is next in line."
    );
    expect(queuedLaunchNote({ reason: "x", ahead: 2 })).toContain("2 launches are ahead of it.");
  });
});

// launchSession through the queue, with the spawn seam stubbed to a no-op (no
// agent, no real pane) and an injected queue over a fake host reading.
const dirs: string[] = [];
const savedEnv = { HOME: process.env.HOME, WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT };
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv.WORKTREE_ROOT;
});

async function scratchStore() {
  const root = await mkdtemp(join(tmpdir(), "standup-headroom-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  const home = await mkdtemp(join(tmpdir(), "standup-headroom-home-"));
  dirs.push(home);
  process.env.HOME = home;
  const store = createStore(":memory:");
  const id = `headroom-${randomUUID().slice(0, 8)}`;
  upsertProject(store.db, { id, name: "H", branch: "main", repos: [] });
  return { store, project: { id, name: "H", branch: "main", repos: [] } as Project };
}

function seam() {
  const spawned: string[] = [];
  return {
    spawned,
    deps: {
      buildSpawnArgv: (_harness: unknown, spec: { launchId: string }) => {
        spawned.push(spec.launchId);
        return ["true"];
      },
      deliverPrompt: async () => {},
    },
  };
}

describe("launchSession — host headroom", () => {
  test("a launch the host has no room for is queued (starting/queued), then starts when headroom returns", async () => {
    const { store, project } = await scratchStore();
    const host = fakeHost({ memAvailableBytes: 1.4 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    const { spawned, deps } = seam();

    const result = await launchSession(store.db, { project, task: "run the suite" }, undefined, undefined, {
      ...deps,
      queue,
    });
    expect(result.queued).toEqual({
      reason: "memory is low (1.4 GB free, 2.0 GB is kept in reserve)",
      ahead: 0,
      note:
        "Queued, not started: memory is low (1.4 GB free, 2.0 GB is kept in reserve). It starts on its own, " +
        "in order, when the host has room; it is next in line.",
    });
    expect(result.launch.phase).toBe("queued");
    const queuedRow = getLaunch(store.db, result.launch.id)!;
    expect(queuedRow).toMatchObject({ status: "starting", phase: "queued" });
    expect(queuedRow.log).toContain("Queued, not started: memory is low");
    // Nothing has been spawned yet, and a tick while still short starts nothing.
    await Promise.resolve();
    expect(spawned).toEqual([]);
    expect(drainLaunchQueue(store.db, queue)).toEqual([]);

    host.set({ memAvailableBytes: 8 * GiB });
    expect(drainLaunchQueue(store.db, queue)).toEqual([result.launch.id]);
    await result.done;
    expect(spawned).toEqual([result.launch.id]);
    const row = getLaunch(store.db, result.launch.id)!;
    expect(row.status).toBe("running");
    expect(row.phase).toBeUndefined();
    expect(row.log).toContain("The host has room now; starting.");
  });

  test("with room, a launch starts straight away and is not marked queued", async () => {
    const { store, project } = await scratchStore();
    const host = fakeHost({ memAvailableBytes: 20 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    const { spawned, deps } = seam();
    const result = await launchSession(store.db, { project, task: "go" }, undefined, undefined, { ...deps, queue });
    expect(result.queued).toBeUndefined();
    await result.done;
    expect(spawned).toEqual([result.launch.id]);
    expect(getLaunch(store.db, result.launch.id)!.status).toBe("running");
  });

  test("stopping a queued launch removes it from the queue; it never spawns", async () => {
    const { store, project } = await scratchStore();
    const host = fakeHost({ memAvailableBytes: 1 * GiB, load1: 1, cores: 4 });
    const queue = new LaunchQueue(host.monitor);
    const { spawned, deps } = seam();
    const result = await launchSession(store.db, { project, task: "stop me" }, undefined, undefined, {
      ...deps,
      queue,
    });
    const stopped = await stopLaunch(store.db, getLaunch(store.db, result.launch.id)!, queue);
    expect(stopped.log).toContain("Removed from the host-headroom queue before it started");
    await result.done;
    expect(queue.size).toBe(0);
    expect(spawned).toEqual([]);
    expect(getLaunch(store.db, result.launch.id)).toMatchObject({ status: "failed", error: "Stopped by you" });
    expect(getActiveTaskRunByWorktree(store.db, result.launch.worktreePath)).toBeNull();
  });

  test("launches a previous collector left queued are failed at startup with a reason", async () => {
    const { store, project } = await scratchStore();
    const host = fakeHost({ memAvailableBytes: 1 * GiB, load1: 1, cores: 4 });
    const { deps } = seam();
    const result = await launchSession(store.db, { project, task: "stranded" }, undefined, undefined, {
      ...deps,
      queue: new LaunchQueue(host.monitor),
    });
    const failed = failStrandedQueuedLaunches(store.db);
    expect(failed.map((l) => l.id)).toEqual([result.launch.id]);
    expect(getLaunch(store.db, result.launch.id)).toMatchObject({
      status: "failed",
      error: STRANDED_QUEUED_LAUNCH_REASON,
    });
    expect(getActiveTaskRunByWorktree(store.db, result.launch.worktreePath)).toBeNull();
    expect(failStrandedQueuedLaunches(store.db)).toEqual([]);
  });
});
