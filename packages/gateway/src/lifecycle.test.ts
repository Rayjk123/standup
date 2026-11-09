import { describe, expect, test } from "bun:test";
import { EXIT_BIND_FAILED, EXIT_FOREIGN_GATEWAY, type GatewayInfo, type GatewayStats } from "@standup/shared/topology";
import type { Gateway } from "./gateway.js";
import { runGateway, type LifecycleDeps } from "./lifecycle.js";
import { FAST_BIND_RETRY_MS, type PortProbe } from "./startup.js";

const SELF = 100;
const DATA_DIR = "/data/a";
// Labels only: nothing here binds a port.
const PORTS = { web: 1, collector: 2, ws: 3 };
const ORPHAN_MS = 8_000;

function statsFor(pid: number, dataDir?: string): GatewayStats {
  return { pid, version: "old", startedAt: "t", dataDir, held: 0, heldNow: 0, maxHoldMs: 0, failed: 0, retried: 0, wsUpstreamCloses: 0, upstream: {} };
}

const gatewayProbe = (pid: number, dataDir?: string): PortProbe => ({ port: PORTS.collector, kind: "gateway", stats: statsFor(pid, dataDir) });
const inUse = () => Object.assign(new Error("Failed to start server. Is port 2 in use?"), { code: "EADDRINUSE" });
const priorRecord = (pid: number): GatewayInfo => ({ pid, version: "old", ports: PORTS, startedAt: "t0", dataDir: DATA_DIR });

interface WorldOptions {
  prior?: GatewayInfo;
  /** Probe results, per probe call (the last repeats). */
  probes?: PortProbe[][];
  /** Pids that run this install's gateway CLI. */
  own?: number[];
  /** Listen attempts that fail with EADDRINUSE before one succeeds; Infinity never binds. */
  busyAttempts?: number;
  /** Called on every bind-retry sleep. */
  onSleep?: (w: World) => void;
  devAlive?: boolean;
}

type World = ReturnType<typeof world>;

function world(opts: WorldOptions = {}) {
  const events: string[] = [];
  let info: GatewayInfo | undefined = opts.prior;
  let clock = 0;
  let probeCalls = 0;
  let listenCalls = 0;
  const exits: number[] = [];
  const logs: string[] = [];
  const timers: Array<() => void> = [];
  let stopHandler: ((signal: NodeJS.Signals) => void) | undefined;
  const state = { devAlive: opts.devAlive ?? true, leaderValidAt: 0, stopped: false, restartActivity: undefined as string | undefined };
  const own = new Set(opts.own ?? []);
  const gateway: Gateway = {
    ports: PORTS,
    stats: () => statsFor(SELF, DATA_DIR),
    lastLeaderValidAt: () => state.leaderValidAt,
    checkLeader: async () => {
      events.push("checkLeader");
      return false;
    },
    stop: async () => {
      events.push("stop");
      state.stopped = true;
    },
  };
  const w = {
    events,
    exits,
    logs,
    state,
    get info() {
      return info;
    },
    get listenCalls() {
      return listenCalls;
    },
    signal: (signal: NodeJS.Signals) => stopHandler?.(signal),
    advance: (ms: number) => {
      clock += ms;
    },
    /** Runs every registered timer once and lets its async work settle. */
    tick: async () => {
      for (const fn of timers) fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    deps: undefined as unknown as LifecycleDeps,
  };
  w.deps = {
    pid: SELF,
    dataDir: DATA_DIR,
    version: "new",
    startedAt: "t1",
    ports: PORTS,
    readInfo: () => info,
    writeInfo: (next) => {
      events.push(next.binding ? `write:binding:${next.pid}` : `write:${next.pid}`);
      info = next;
    },
    removeInfo: () => {
      events.push("remove");
      info = undefined;
    },
    probe: async () => {
      events.push("probe");
      const list = opts.probes ?? [[]];
      return list[Math.min(probeCalls++, list.length - 1)] ?? [];
    },
    ownsStats: (stats) => own.has(stats.pid),
    isOwnGateway: (pid) => pid !== SELF && own.has(pid),
    kill: (pid, signal) => events.push(`kill:${pid}:${signal}`),
    listen: () => {
      listenCalls++;
      events.push("listen");
      if (listenCalls <= (opts.busyAttempts ?? 0)) throw inUse();
      events.push("bound");
      return gateway;
    },
    devAlive: () => state.devAlive,
    restartActivity: () => state.restartActivity,
    orphanExitMs: ORPHAN_MS,
    every: (_ms, fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    onStopSignal: (handler) => {
      stopHandler = handler;
    },
    exit: (code) => {
      events.push(`exit:${code}`);
      exits.push(code);
    },
    log: (m) => logs.push(m),
    error: () => {},
    now: () => clock,
    bindRetry: {
      timeoutMs: 1_000,
      sleep: async (ms) => {
        clock += ms;
        opts.onSleep?.(w);
      },
    },
  };
  return w;
}

const before = (events: string[], a: string, b: string): boolean => {
  const i = events.indexOf(a);
  const j = events.indexOf(b);
  return i !== -1 && j !== -1 && i < j;
};

describe("runGateway: binding", () => {
  test("records itself as binding before the bind, and without binding once bound", async () => {
    const w = world();
    const result = await runGateway(w.deps);
    expect(result.outcome).toBe("serving");
    expect(before(w.events, `write:binding:${SELF}`, "listen")).toBe(true);
    expect(before(w.events, "bound", `write:${SELF}`)).toBe(true);
    expect(w.info).toEqual({ pid: SELF, version: "new", ports: PORTS, startedAt: "t1", dataDir: DATA_DIR });
    expect(w.exits).toEqual([]);
  });

  test("retires this install's gateways only after initializing, and before binding", async () => {
    const w = world({ prior: priorRecord(50), own: [50, 60], probes: [[gatewayProbe(60, "/data/old"), gatewayProbe(50, DATA_DIR)]] });
    expect((await runGateway(w.deps)).outcome).toBe("serving");
    expect(w.events.filter((e) => e.startsWith("kill:"))).toEqual(["kill:60:SIGTERM", "kill:50:SIGTERM"]);
    for (const kill of ["kill:60:SIGTERM", "kill:50:SIGTERM"]) {
      expect(before(w.events, `write:binding:${SELF}`, kill)).toBe(true);
      expect(before(w.events, "probe", kill)).toBe(true);
      expect(before(w.events, kill, "listen")).toBe(true);
    }
  });

  test("a recorded gateway that isn't this install's is never signalled", async () => {
    const w = world({ prior: priorRecord(51) });
    expect((await runGateway(w.deps)).outcome).toBe("serving");
    expect(w.events.some((e) => e.startsWith("kill:"))).toBe(false);
    expect(w.logs.some((m) => m.includes("pid 51") && m.includes("left alone"))).toBe(true);
  });

  test("after retiring, retries the bind at the fast interval until the old gateway lets go", async () => {
    const sleeps: number[] = [];
    const w = world({ prior: priorRecord(50), own: [50], busyAttempts: 3 });
    const deps = w.deps;
    const sleep = deps.bindRetry?.sleep;
    deps.bindRetry = {
      ...deps.bindRetry,
      sleep: async (ms) => {
        sleeps.push(ms);
        await sleep?.(ms);
      },
    };
    expect((await runGateway(deps)).outcome).toBe("serving");
    expect(w.listenCalls).toBe(4);
    expect(sleeps).toEqual([FAST_BIND_RETRY_MS, FAST_BIND_RETRY_MS, FAST_BIND_RETRY_MS]);
  });

  test("a bind that never succeeds puts back the prior record and exits EXIT_BIND_FAILED", async () => {
    const prior = priorRecord(51);
    const w = world({ prior, probes: [[{ port: PORTS.collector, kind: "other" }]], busyAttempts: Infinity });
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: EXIT_BIND_FAILED });
    expect(w.exits).toEqual([EXIT_BIND_FAILED]);
    expect(w.info).toEqual(prior);
    expect(w.events.some((e) => e.startsWith("kill:"))).toBe(false);
  });

  test("with no prior record, a failed bind removes its own", async () => {
    const w = world({ busyAttempts: Infinity });
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: EXIT_BIND_FAILED });
    expect(w.info).toBeUndefined();
  });

  test("SIGTERM while binding puts back the prior record and exits 0 without binding", async () => {
    const prior = priorRecord(51);
    const w = world({ prior, busyAttempts: Infinity, onSleep: (self) => self.signal("SIGTERM") });
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: 0 });
    expect(w.exits).toEqual([0]);
    expect(w.info).toEqual(prior);
    expect(w.listenCalls).toBe(1);
  });

  test("a newer gateway's record is never overwritten by a restore", async () => {
    const w = world({ prior: priorRecord(51), busyAttempts: Infinity });
    const write = w.deps.writeInfo;
    w.deps.bindRetry = {
      ...w.deps.bindRetry,
      sleep: async () => {
        write({ ...priorRecord(200), version: "newer", binding: true });
        w.signal("SIGTERM");
      },
    };
    await runGateway(w.deps);
    expect(w.info?.pid).toBe(200);
  });
});

describe("runGateway: refusing another install", () => {
  test("another install's gateway on this same data dir: exit EXIT_FOREIGN_GATEWAY, never retired", async () => {
    const prior = priorRecord(80);
    const w = world({ prior, probes: [[gatewayProbe(80, DATA_DIR)]] });
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: EXIT_FOREIGN_GATEWAY });
    expect(w.events.some((e) => e.startsWith("kill:"))).toBe(false);
    expect(w.listenCalls).toBe(0);
    expect(w.info).toEqual(prior);
  });

  test("another install's gateway on another data dir: the same", async () => {
    const w = world({ probes: [[gatewayProbe(81, "/data/b")]] });
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: EXIT_FOREIGN_GATEWAY });
    expect(w.listenCalls).toBe(0);
  });

  test("a foreign gateway that shows up while the bind retries is refused at the re-probe", async () => {
    const w = world({ busyAttempts: Infinity, probes: [[], [gatewayProbe(82, DATA_DIR)]] });
    w.deps.bindRetry = { ...w.deps.bindRetry, timeoutMs: 10_000 };
    expect(await runGateway(w.deps)).toEqual({ outcome: "exited", code: EXIT_FOREIGN_GATEWAY });
    expect(w.events.some((e) => e.startsWith("kill:"))).toBe(false);
  });
});

describe("runGateway: serving", () => {
  test("SIGTERM drains, removes its record and exits 0", async () => {
    const w = world();
    await runGateway(w.deps);
    w.signal("SIGTERM");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(w.state.stopped).toBe(true);
    expect(w.info).toBeUndefined();
    expect(w.exits).toEqual([0]);
  });

  test("exits once dev.ts is gone and no leader has validated for the orphan grace period", async () => {
    const w = world({ devAlive: false });
    await runGateway(w.deps);
    for (let t = 0; t < ORPHAN_MS; t += 1_000) {
      await w.tick();
      w.advance(1_000);
      expect(w.exits).toEqual([]);
    }
    await w.tick();
    expect(w.state.stopped).toBe(true);
    expect(w.exits).toEqual([0]);
    expect(w.info).toBeUndefined();
    expect(w.logs.some((m) => m.includes("dev.ts recorded in dev.json is gone"))).toBe(true);
  });

  test("never orphaned while dev.ts lives, and leaves the leader unchecked meanwhile", async () => {
    const w = world({ devAlive: true });
    await runGateway(w.deps);
    for (let t = 0; t < 5 * ORPHAN_MS; t += 1_000) {
      await w.tick();
      w.advance(1_000);
    }
    expect(w.exits).toEqual([]);
    expect(w.events).not.toContain("checkLeader");
  });

  test("a dev.ts restart (gone for a second, then back) does not orphan it", async () => {
    const w = world({ devAlive: true });
    await runGateway(w.deps);
    w.advance(30_000);
    w.state.devAlive = false;
    await w.tick();
    w.advance(1_000);
    await w.tick();
    w.state.devAlive = true;
    for (let t = 0; t < 3 * ORPHAN_MS; t += 1_000) {
      w.advance(1_000);
      await w.tick();
    }
    expect(w.exits).toEqual([]);
  });

  test("a restart in progress keeps it up after dev.ts is gone; the orphan clock starts once it ends", async () => {
    const w = world({ devAlive: false });
    w.state.restartActivity = "a restart is in progress (phase rollback)";
    await runGateway(w.deps);
    for (let t = 0; t < 5 * ORPHAN_MS; t += 1_000) {
      await w.tick();
      w.advance(1_000);
    }
    expect(w.exits).toEqual([]);
    expect(w.logs.filter((m) => m.includes("a restart is in progress")).length).toBe(1);
    w.state.restartActivity = undefined;
    for (let t = 0; t < ORPHAN_MS; t += 1_000) {
      await w.tick();
      w.advance(1_000);
      expect(w.exits).toEqual([]);
    }
    await w.tick();
    expect(w.exits).toEqual([0]);
  });

  test("restart activity is not consulted while dev.ts lives", async () => {
    const w = world({ devAlive: true });
    let asked = 0;
    w.deps.restartActivity = () => {
      asked++;
      return undefined;
    };
    await runGateway(w.deps);
    await w.tick();
    expect(asked).toBe(0);
  });

  test("a collector leader validating keeps it up after dev.ts is gone", async () => {
    const w = world({ devAlive: false });
    await runGateway(w.deps);
    for (let t = 0; t < 3 * ORPHAN_MS; t += 1_000) {
      w.state.leaderValidAt = t;
      await w.tick();
      w.advance(1_000);
    }
    expect(w.exits).toEqual([]);
  });
});
