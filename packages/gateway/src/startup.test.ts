import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_HOST, restartRecordPath, standbyDirPath, standbyFilePath, type GatewayStats } from "@standup/shared/topology";
import { createGateway } from "./gateway.js";
import {
  FAST_BIND_PHASE_MS,
  FAST_BIND_RETRY_MS,
  OrphanWatch,
  RESTART_ACTIVE_WINDOW_MS,
  bindDecision,
  bindWithRetry,
  isAddrInUse,
  probeGateway,
  recordedStandbyPids,
  restartActivity,
  type PortProbe,
} from "./startup.js";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function statsFor(pid: number, dataDir?: string): GatewayStats {
  return {
    pid,
    version: "v",
    startedAt: new Date().toISOString(),
    dataDir,
    held: 0,
    heldNow: 0,
    maxHoldMs: 0,
    failed: 0,
    retried: 0,
    wsUpstreamCloses: 0,
    upstream: {},
  };
}

// Probe `port` fields are labels only: nothing here binds them.
const gatewayAt = (port: number, pid: number, dataDir?: string): PortProbe => ({ port, kind: "gateway", stats: statsFor(pid, dataDir) });
const SELF = 1;
const none = () => false;

describe("bindDecision", () => {
  test("proceeds when nothing or a non-gateway answers", () => {
    expect(bindDecision([], "/data/a", none, SELF)).toEqual({ proceed: true, retire: [] });
    expect(bindDecision([{ port: 1, kind: "none" }, { port: 2, kind: "other" }], "/data/a", none, SELF)).toEqual({ proceed: true, retire: [] });
  });

  test("this install's gateway is retired, whatever data dir it reports", () => {
    const ours = (stats: GatewayStats) => stats.pid === 21;
    expect(bindDecision([gatewayAt(1, 21, "/data/a"), gatewayAt(2, 21, "/data/a/")], "/data/a", ours, SELF)).toEqual({ proceed: true, retire: [21] });
    expect(bindDecision([gatewayAt(1, 21, "/data/old")], "/data/a", ours, SELF)).toEqual({ proceed: true, retire: [21] });
    expect(bindDecision([gatewayAt(1, 21)], "/data/a", ours, SELF)).toEqual({ proceed: true, retire: [21] });
  });

  test("another install's gateway on the same data dir is refused, never retired", () => {
    const decision = bindDecision([gatewayAt(1, 11, "/data/a"), gatewayAt(2, 11, "/data/x/../a")], "/data/a", none, SELF);
    expect(decision.proceed).toBe(false);
    if (!decision.proceed) {
      expect(decision.reason).toContain("pid 11");
      expect(decision.reason).toContain("serves this data dir (/data/a)");
      expect(decision.reason).toContain("not this install's gateway");
      expect(decision.reason).toContain("DB_PATH");
    }
  });

  test("another install's gateway on a different data dir, or reporting none, is refused", () => {
    const other = bindDecision([{ port: 1, kind: "none" }, gatewayAt(2, 11, "/data/b")], "/data/a", none, SELF);
    expect(other.proceed).toBe(false);
    if (!other.proceed) {
      expect(other.reason).toContain("port 2");
      expect(other.reason).toContain("/data/b");
      for (const name of ["STANDUP_WEB_PORT", "COLLECTOR_PORT", "WS_PORT", "STANDUP_VITE_PORT"]) expect(other.reason).toContain(name);
    }
    expect(bindDecision([gatewayAt(1, 12)], "/data/a", none, SELF).proceed).toBe(false);
  });

  test("one foreign gateway refuses even beside this install's own", () => {
    const ours = (stats: GatewayStats) => stats.pid === 21;
    expect(bindDecision([gatewayAt(1, 21, "/data/a"), gatewayAt(2, 22, "/data/a")], "/data/a", ours, SELF).proceed).toBe(false);
  });

  test("this process answering its own probe is skipped", () => {
    expect(bindDecision([gatewayAt(1, SELF, "/data/b")], "/data/a", none, SELF)).toEqual({ proceed: true, retire: [] });
  });
});

describe("probeGateway", () => {
  test("reads a running gateway's stats on the collector and ws listeners, not the web listener", async () => {
    const gateway = createGateway({
      ports: { web: 0, collector: 0, ws: 0 },
      vitePort: 1,
      holdMs: 50,
      retryIntervalMs: 10,
      leaderSource: () => undefined,
      dataDir: "/data/p",
    });
    cleanups.push(() => gateway.stop({ drainMs: 10 }));
    for (const port of [gateway.ports.collector, gateway.ports.ws]) {
      const probe = await probeGateway(GATEWAY_HOST, port);
      expect(probe.kind).toBe("gateway");
      if (probe.kind === "gateway") {
        expect(probe.stats.dataDir).toBe("/data/p");
        expect(probe.stats.pid).toBe(process.pid);
      }
    }
    // The web listener proxies the stats path to vite (absent here), so it is no gateway answer.
    expect((await probeGateway(GATEWAY_HOST, gateway.ports.web)).kind).not.toBe("gateway");
  });

  test("classifies a non-gateway and a closed port", async () => {
    const other = Bun.serve({ hostname: GATEWAY_HOST, port: 0, fetch: () => new Response("not found", { status: 404 }) });
    cleanups.push(() => other.stop(true));
    expect((await probeGateway(GATEWAY_HOST, other.port ?? 0)).kind).toBe("other");
    const closed = Bun.serve({ hostname: GATEWAY_HOST, port: 0, fetch: () => new Response("") });
    const port = closed.port ?? 0;
    closed.stop(true);
    expect((await probeGateway(GATEWAY_HOST, port)).kind).toBe("none");
  });
});

describe("bindWithRetry", () => {
  const inUse = () => Object.assign(new Error("Failed to start server. Is port 1 in use?"), { code: "EADDRINUSE" });

  test("retries EADDRINUSE with backoff until the bind succeeds", async () => {
    let calls = 0;
    const waits: number[] = [];
    let clock = 0;
    const result = await bindWithRetry(
      () => {
        calls++;
        if (calls < 4) throw inUse();
        return "bound";
      },
      { sleep: async (ms) => void waits.push(ms), now: () => (clock += 10), initialDelayMs: 100, maxDelayMs: 250 }
    );
    expect(result).toBe("bound");
    expect(calls).toBe(4);
    expect(waits).toEqual([100, 200, 250]);
  });

  test("retries at the fast interval through the fast phase, then backs off", async () => {
    let clock = 0;
    const waits: number[] = [];
    let calls = 0;
    await bindWithRetry(
      () => {
        calls++;
        if (calls < 8) throw inUse();
        return "bound";
      },
      {
        initialDelayMs: FAST_BIND_RETRY_MS,
        fastPhaseMs: FAST_BIND_RETRY_MS * 4,
        maxDelayMs: 1000,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
        now: () => clock,
      }
    );
    const f = FAST_BIND_RETRY_MS;
    // The fast interval through the phase, then backoff that starts from it.
    expect(waits).toEqual([f, f, f, f, f, f * 2, f * 4]);
    expect(FAST_BIND_RETRY_MS).toBeLessThanOrEqual(20);
    expect(FAST_BIND_PHASE_MS).toBeGreaterThan(FAST_BIND_RETRY_MS);
  });

  test("gives up after the timeout with the last error", async () => {
    let clock = 0;
    let calls = 0;
    const attempt = bindWithRetry(
      () => {
        calls++;
        throw inUse();
      },
      { timeoutMs: 1000, sleep: async (ms) => void (clock += ms), now: () => clock, initialDelayMs: 300, maxDelayMs: 300 }
    );
    await expect(attempt).rejects.toThrow("in use");
    expect(calls).toBe(5);
  });

  test("does not retry other errors", async () => {
    let calls = 0;
    const attempt = bindWithRetry(() => {
      calls++;
      throw new Error("permission denied");
    });
    await expect(attempt).rejects.toThrow("permission denied");
    expect(calls).toBe(1);
  });

  test("isAddrInUse", () => {
    expect(isAddrInUse(inUse())).toBe(true);
    expect(isAddrInUse(new Error("listen EADDRINUSE: address already in use 127.0.0.1:1"))).toBe(true);
    expect(isAddrInUse(new Error("EACCES"))).toBe(false);
    expect(isAddrInUse(undefined)).toBe(false);
  });
});

describe("OrphanWatch", () => {
  const GRACE = 8_000;

  test("fires once dev.ts has been gone and no leader has validated, both for the grace period", () => {
    const watch = new OrphanWatch(GRACE);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: 1_000 })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: 1_000 + GRACE - 1 })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: 1_000 + GRACE })).toBe(true);
  });

  test("never fires while dev.ts lives, however long no leader validates", () => {
    const watch = new OrphanWatch(GRACE);
    for (let t = 0; t <= 10 * GRACE; t += 1_000) expect(watch.observe({ devAlive: true, lastLeaderValidAt: 0, now: t })).toBe(false);
  });

  test("a valid leader holds it off even with dev.ts gone", () => {
    const watch = new OrphanWatch(GRACE);
    for (let t = 0; t <= 3 * GRACE; t += 1_000) expect(watch.observe({ devAlive: false, lastLeaderValidAt: t, now: t })).toBe(false);
  });

  test("a dev.ts restart (gone about a second, then a new live dev.ts) resets the clock", () => {
    const watch = new OrphanWatch(GRACE);
    // The old dev.ts stopped its slots and exited: no leader from t=0 on.
    let t = 0;
    for (; t < 2_000; t += 1_000) expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: t })).toBe(false);
    expect(watch.observe({ devAlive: true, lastLeaderValidAt: 0, now: t })).toBe(false);
    // The new dev.ts's slots are slow to lead; it later dies too.
    t = GRACE + 5_000;
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: t })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: t + GRACE - 1 })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: t + GRACE })).toBe(true);
  });

  test("restart activity holds it off with dev.ts gone, and the clock starts once it ends", () => {
    const watch = new OrphanWatch(GRACE);
    for (let t = 0; t <= 5 * GRACE; t += 1_000) {
      expect(watch.observe({ devAlive: false, restartActive: true, lastLeaderValidAt: 0, now: t })).toBe(false);
    }
    const end = 5 * GRACE + 1_000;
    expect(watch.observe({ devAlive: false, restartActive: false, lastLeaderValidAt: 0, now: end })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: end + GRACE - 1 })).toBe(false);
    expect(watch.observe({ devAlive: false, lastLeaderValidAt: 0, now: end + GRACE })).toBe(true);
  });
});

describe("restartActivity", () => {
  const NOW = Date.parse("2026-10-08T12:00:00Z");
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const none = { standbyPids: () => [], alive: () => true, now: () => NOW };

  test("a restart not yet done and updated within the window is activity", () => {
    expect(restartActivity("/d", { ...none, readRecord: () => ({ phase: "rollback", updatedAt: at(60_000) }) })).toContain("phase rollback");
    expect(restartActivity("/d", { ...none, readRecord: () => ({ phase: "promote", updatedAt: at(RESTART_ACTIVE_WINDOW_MS) }) })).toBeDefined();
  });

  test("a done, stale, malformed or missing record is not", () => {
    expect(restartActivity("/d", { ...none, readRecord: () => ({ phase: "done", updatedAt: at(1_000) }) })).toBeUndefined();
    expect(restartActivity("/d", { ...none, readRecord: () => ({ phase: "rollback", updatedAt: at(RESTART_ACTIVE_WINDOW_MS + 1) }) })).toBeUndefined();
    expect(restartActivity("/d", { ...none, readRecord: () => ({ phase: "rollback", updatedAt: "yesterday-ish" }) })).toBeUndefined();
    expect(restartActivity("/d", { ...none, readRecord: () => ({ updatedAt: at(1_000) }) })).toBeUndefined();
    expect(restartActivity("/d", { ...none, readRecord: () => undefined })).toBeUndefined();
  });

  test("a live standby is activity; a dead one is not", () => {
    const base = { readRecord: () => undefined, now: () => NOW };
    expect(restartActivity("/d", { ...base, standbyPids: () => [11, 12], alive: (pid) => pid === 12 })).toContain("pid 12");
    expect(restartActivity("/d", { ...base, standbyPids: () => [11], alive: () => false })).toBeUndefined();
  });

  test("reads the data dir's restart record and standby markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-restart-activity-"));
    try {
      const dead = 2 ** 22 + 12345;
      expect(restartActivity(dir)).toBeUndefined();
      expect(recordedStandbyPids(dir)).toEqual([]);

      writeFileSync(standbyFilePath(dir), JSON.stringify({ pid: dead }));
      mkdirSync(standbyDirPath(dir));
      writeFileSync(join(standbyDirPath(dir), `${process.pid}.json`), JSON.stringify({ pid: process.pid }));
      writeFileSync(join(standbyDirPath(dir), "junk.json"), "{");
      writeFileSync(join(standbyDirPath(dir), "notes.txt"), JSON.stringify({ pid: 7 }));
      expect(recordedStandbyPids(dir).sort()).toEqual([dead, process.pid].sort());
      expect(restartActivity(dir)).toContain(`pid ${process.pid}`);

      rmSync(standbyDirPath(dir), { recursive: true });
      expect(restartActivity(dir)).toBeUndefined();

      mkdirSync(join(dir, "restart"));
      writeFileSync(restartRecordPath(dir), JSON.stringify({ id: "r1", phase: "health", updatedAt: new Date().toISOString() }));
      expect(restartActivity(dir)).toContain("phase health");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
