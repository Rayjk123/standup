import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { pidAlive } from "../packages/shared/src/process-identity.js";
import {
  EXIT_FOREIGN_GATEWAY,
  GATEWAY_HOST,
  slotPorts,
  type GatewayInfo,
  type GatewayStats,
  type PublicPorts,
} from "../packages/shared/src/topology.js";
import {
  appendLogLine,
  CLASSIC_GATEWAY_STOP_TIMEOUT_MS,
  CrashLoopBreaker,
  createGatewayWatchdog,
  devOwnershipConflict,
  ensureGateway,
  GATEWAY_BINDING_UNRESPONSIVE_CHECKS,
  GATEWAY_FOREIGN_REPROBE_MS,
  GATEWAY_HUNG_TERM_GRACE_MS,
  GATEWAY_MAX_RESPAWNS_PER_WINDOW,
  GATEWAY_UNRESPONSIVE_CHECKS,
  gatewayCliPath,
  gatewayCliPaths,
  gatewayMismatch,
  gatewayStatsUrl,
  isInstallGateway,
  loadGatewayVersion,
  planServices,
  resolveDbPath,
  respawnGivenUp,
  serviceEnv,
  shouldReuseGateway,
  spawnDetached,
  stopGatewayForClassic,
  stripGitEnv,
  type ChildSpawn,
  type ClassicStopDeps,
  type GatewayConfig,
  type GatewayDeps,
  type SupervisedService,
} from "./dev-topology.js";

const ROOT = "/repo/";
const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-topology-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Made-up ports: the plan must only ever use what it is given.
const PORTS: PublicPorts = { web: 41002, collector: 41000, ws: 41001 };
const VITE = 41003;
const base = { root: ROOT, ports: PORTS, vitePort: VITE };
const DATA_DIR = "/data/standup";
const CONFIG: GatewayConfig = { ports: PORTS, vitePort: VITE, dataDir: DATA_DIR };

describe("planServices", () => {
  test("classic mode matches the original topology", () => {
    const plan = planServices({ STANDUP_GATEWAY: "0" }, { ...base, slackConfigured: true });
    expect(plan.mode).toBe("classic");
    expect(plan.services).toEqual([
      { name: "collector", cmd: ["bun", "run", "start"], cwd: "/repo//packages/collector", env: {} },
      { name: "web", cmd: ["bun", "run", "serve"], cwd: "/repo//packages/web", env: {}, unset: ["STANDUP_VITE_PORT"] },
      { name: "slack", cmd: ["bun", "run", "dev"], cwd: "/repo//packages/slack", env: {} },
    ]);
  });

  test("STANDUP_WEB_DEV=1 runs the vite dev server instead of the production build, in both modes", () => {
    for (const STANDUP_GATEWAY of ["0", "1"]) {
      const env = { STANDUP_GATEWAY, STANDUP_BIND_HOST: GATEWAY_HOST };
      const web = (e: NodeJS.ProcessEnv) => planServices(e, { ...base, slackConfigured: false }).services.find((s) => s.name === "web")!;
      expect(web({ ...env, STANDUP_WEB_DEV: "1" }).cmd).toEqual(["bun", "run", "dev"]);
      expect(web(env).cmd).toEqual(["bun", "run", "serve"]);
      expect(web({ ...env, STANDUP_WEB_DEV: "0" }).cmd).toEqual(["bun", "run", "serve"]);
    }
  });

  test("classic vite never inherits STANDUP_VITE_PORT", () => {
    const plan = planServices({ STANDUP_GATEWAY: "0" }, { ...base, slackConfigured: false });
    const web = plan.services.find((s) => s.name === "web")!;
    const env = serviceEnv({ STANDUP_VITE_PORT: String(VITE), KEEP: "1" }, web, { FORCE_COLOR: "1" });
    expect(env.STANDUP_VITE_PORT).toBeUndefined();
    expect(env.KEEP).toBe("1");
    expect(env.FORCE_COLOR).toBe("1");
  });

  test("serviceEnv layers the service env over the base and extras", () => {
    expect(serviceEnv({ A: "base", B: "base" }, { env: { B: "svc" } }, { A: "extra" })).toEqual({ A: "extra", B: "svc" });
  });

  test("classic mode honours STANDUP_COLLECTOR_WATCH and omits unconfigured slack", () => {
    const plan = planServices({ STANDUP_GATEWAY: "0", STANDUP_COLLECTOR_WATCH: "1" }, { ...base, slackConfigured: false });
    expect(plan.services.map((s) => s.name)).toEqual(["collector", "web"]);
    expect(plan.services[0].cmd).toEqual(["bun", "run", "dev"]);
  });

  test("any bind host other than GATEWAY_HOST forces classic mode", () => {
    for (const host of ["0.0.0.0", "localhost", "::1"]) {
      const plan = planServices({ STANDUP_BIND_HOST: host }, { ...base, slackConfigured: false });
      expect(plan.mode).toBe("classic");
      expect(plan.services.every((s) => Object.keys(s.env).length === 0)).toBe(true);
    }
  });

  test("gateway: false override forces classic even when the env enables it", () => {
    expect(planServices({}, { ...base, slackConfigured: false, gateway: false }).mode).toBe("classic");
  });

  test("gateway mode runs two collector slots on slot ports and vite on its own port", () => {
    const plan = planServices({ STANDUP_BIND_HOST: GATEWAY_HOST }, { ...base, slackConfigured: false });
    const a = slotPorts(PORTS.collector, PORTS.ws, "a");
    const b = slotPorts(PORTS.collector, PORTS.ws, "b");
    expect(plan.mode).toBe("gateway");
    expect(plan.services).toEqual([
      {
        name: "collector:a",
        cmd: ["bun", "run", "start"],
        cwd: "/repo//packages/collector",
        env: { STANDUP_COLLECTOR_SLOT: "a", STANDUP_LISTEN_PORT: String(a.http), STANDUP_LISTEN_WS_PORT: String(a.ws) },
      },
      {
        name: "collector:b",
        cmd: ["bun", "run", "start"],
        cwd: "/repo//packages/collector",
        env: { STANDUP_COLLECTOR_SLOT: "b", STANDUP_LISTEN_PORT: String(b.http), STANDUP_LISTEN_WS_PORT: String(b.ws) },
      },
      { name: "web", cmd: ["bun", "run", "serve"], cwd: "/repo//packages/web", env: { STANDUP_VITE_PORT: String(VITE) } },
    ]);
    expect(a.http).not.toBe(b.http);
    // The gateway is never a supervised (killable) service.
    expect(plan.services.some((s) => s.name.includes("gateway") || s.cwd.includes("gateway"))).toBe(false);
  });
});

describe("shouldReuseGateway", () => {
  const info: GatewayInfo = { pid: 42, version: "v1", ports: PORTS, startedAt: "t", dataDir: DATA_DIR };
  const want = { ...CONFIG, version: "v1" };
  const stats = { pid: 42, dataDir: DATA_DIR, upstream: { web: VITE } };
  test("reuses a verified gateway on the current version and config", () => {
    expect(shouldReuseGateway(info, true, want)).toBe(true);
    expect(shouldReuseGateway(info, true, want, stats)).toBe(true);
  });
  test("respawns on version mismatch, unverified pid, or no record", () => {
    expect(shouldReuseGateway(info, true, { ...want, version: "v2" })).toBe(false);
    expect(shouldReuseGateway(info, false, want)).toBe(false);
    expect(shouldReuseGateway(undefined, true, want)).toBe(false);
    expect(shouldReuseGateway({ ...info, pid: 0 }, true, want)).toBe(false);
  });
  test("respawns when the stats come from another pid", () => {
    expect(shouldReuseGateway(info, true, want, { ...stats, pid: 43 })).toBe(false);
  });
  test("respawns when ports, vite port or data dir differ", () => {
    expect(shouldReuseGateway({ ...info, ports: { ...PORTS, web: PORTS.web + 1 } }, true, want)).toBe(false);
    expect(shouldReuseGateway({ ...info, dataDir: "/elsewhere" }, true, want)).toBe(false);
    expect(shouldReuseGateway(info, true, want, { ...stats, upstream: { web: VITE + 1 } })).toBe(false);
    expect(shouldReuseGateway({ ...info, dataDir: undefined }, true, want, { ...stats, dataDir: "/elsewhere" })).toBe(false);
  });
  test("fields a gateway doesn't report are not held against it", () => {
    expect(gatewayMismatch({ ...info, dataDir: undefined }, { upstream: {} }, want)).toBeUndefined();
    expect(gatewayMismatch({ ...info, dataDir: `${DATA_DIR}/` }, undefined, want)).toBeUndefined();
  });
});

/**
 * A fake world: gateway.json, a process table, a stats endpoint and a virtual
 * clock. `impostors` are live pids that belong to some other program.
 */
function fakeWorld(
  opts: {
    version?: string;
    info?: GatewayInfo;
    statsAnswers?: boolean;
    spawnedDies?: boolean;
    oldIgnoresRetire?: boolean;
    /** Pids that survive SIGTERM (only SIGKILL ends them). */
    ignoresTerm?: number[];
    vitePort?: number;
  } = {},
) {
  const alive = new Set<number>();
  const impostors = new Set<number>();
  const exits = new Map<number, number>();
  const logLines: string[] = [];
  const fileLines: string[] = [];
  let info = opts.info;
  if (info) alive.add(info.pid);
  let nextPid = 1000;
  let clock = 0;
  const spawned: number[] = [];
  const state = {
    statsAnswers: opts.statsAnswers ?? true,
    statsPid: undefined as number | undefined,
    vitePort: opts.vitePort ?? VITE,
    /** When set, every spawned gateway exits at once with this code. */
    spawnedExitCode: undefined as number | undefined,
    /** Another install's gateway answering the collector port while no gateway of this install serves. */
    foreignStats: undefined as { pid: number; dataDir?: string } | undefined,
  };
  const kills: [number, string][] = [];
  const deps: GatewayDeps = {
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (signal === "SIGTERM" && opts.ignoresTerm?.includes(pid)) return;
      alive.delete(pid);
    },
    readInfo: () => info,
    isGateway: (pid) => alive.has(pid) && !impostors.has(pid),
    exitCode: (pid) => exits.get(pid),
    version: () => opts.version ?? "v1",
    config: CONFIG,
    spawnDetached: () => {
      const pid = nextPid++;
      spawned.push(pid);
      if (state.spawnedExitCode !== undefined) {
        exits.set(pid, state.spawnedExitCode);
      } else if (!opts.spawnedDies) {
        alive.add(pid);
        // A new gateway retires the recorded one (only if it really is a gateway) and records itself.
        if (info && !opts.oldIgnoresRetire && !impostors.has(info.pid)) alive.delete(info.pid);
        state.statsAnswers = opts.statsAnswers ?? true;
        state.statsPid = undefined;
        state.vitePort = VITE;
        info = { pid, version: opts.version ?? "v1", ports: PORTS, startedAt: "t", dataDir: DATA_DIR };
      }
      return pid;
    },
    fetchStats: async () => {
      if (!info || !alive.has(info.pid) || impostors.has(info.pid)) {
        return state.foreignStats ? ({ ...state.foreignStats, version: "theirs", upstream: {} } as GatewayStats) : undefined;
      }
      if (!state.statsAnswers) return undefined;
      return { pid: state.statsPid ?? info.pid, version: info.version, upstream: { web: state.vitePort } } as GatewayStats;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (m) => logLines.push(m),
    appendLog: (m) => fileLines.push(m),
  };
  return {
    deps,
    alive,
    impostors,
    spawned,
    kills,
    logLines,
    fileLines,
    state,
    kill: (pid: number) => alive.delete(pid),
    advance: (ms: number) => {
      clock += ms;
    },
    get info() {
      return info;
    },
  };
}

const record = (pid: number, version: string): GatewayInfo => ({
  pid,
  version,
  ports: PORTS,
  startedAt: "t",
  dataDir: DATA_DIR,
});

describe("ensureGateway", () => {
  test("reuses a live gateway on the current version without spawning", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    expect(await ensureGateway(w.deps)).toEqual({ action: "reused", pid: 7 });
    expect(w.spawned).toEqual([]);
  });

  test("spawns a new gateway on version mismatch and waits for its stats pid", async () => {
    const w = fakeWorld({ info: record(7, "old"), version: "new" });
    expect(await ensureGateway(w.deps)).toEqual({ action: "spawned", pid: 1000, ready: true });
    expect(w.spawned).toEqual([1000]);
  });

  test("spawns when the recorded pid is dead or there is no record", async () => {
    const dead = fakeWorld({ info: record(7, "v1") });
    dead.kill(7);
    expect((await ensureGateway(dead.deps)).action).toBe("spawned");
    const none = fakeWorld();
    expect((await ensureGateway(none.deps)).action).toBe("spawned");
  });

  test("gives up waiting after the ready timeout and continues", async () => {
    const w = fakeWorld({ statsAnswers: false });
    expect(await ensureGateway(w.deps)).toEqual({ action: "spawned", pid: 1000, ready: false });
    expect(w.logLines.some((l) => l.includes("did not answer"))).toBe(true);
  });

  test("a spawned gateway that dies at once ends the wait early", async () => {
    const w = fakeWorld({ spawnedDies: true });
    expect(await ensureGateway(w.deps)).toEqual({ action: "spawned", pid: 1000, ready: false });
  });

  test("a recycled gateway.json pid owned by another program is never reused or signalled", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    w.impostors.add(7);
    expect((await ensureGateway(w.deps)).action).toBe("spawned");
    expect(w.logLines.some((l) => l.includes("not a running gateway of this install"))).toBe(true);
    expect(w.kills).toEqual([]);
    expect(w.alive.has(7)).toBe(true);
  });

  test("replaces a current gateway whose stats answer as another pid", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    w.state.statsPid = 8;
    expect(await ensureGateway(w.deps)).toEqual({ action: "spawned", pid: 1000, ready: true });
    expect(w.logLines.some((l) => l.includes("pid 8 answers"))).toBe(true);
  });

  test("replaces a current gateway configured for other ports, vite port or data dir", async () => {
    const ports = fakeWorld({ info: { ...record(7, "v1"), ports: { ...PORTS, ws: PORTS.ws + 1 } } });
    expect((await ensureGateway(ports.deps)).action).toBe("spawned");
    const vite = fakeWorld({ info: record(7, "v1"), vitePort: VITE + 1 });
    expect((await ensureGateway(vite.deps)).action).toBe("spawned");
    const dir = fakeWorld({ info: { ...record(7, "v1"), dataDir: "/other" } });
    expect((await ensureGateway(dir.deps)).action).toBe("spawned");
    expect(dir.logLines.some((l) => l.includes("data dir"))).toBe(true);
  });

  test("reuses a current gateway whose stats endpoint is not answering yet", async () => {
    const w = fakeWorld({ info: record(7, "v1"), statsAnswers: false });
    expect(await ensureGateway(w.deps)).toEqual({ action: "reused", pid: 7 });
  });

  test("waits for a current gateway still binding instead of spawning beside it", async () => {
    const w = fakeWorld({ info: { ...record(7, "v1"), binding: true }, statsAnswers: false });
    const sleep = w.deps.sleep;
    let slept = 0;
    w.deps.sleep = async (ms) => {
      slept += ms;
      if (slept >= 1_000) w.state.statsAnswers = true;
      await sleep(ms);
    };
    expect(await ensureGateway(w.deps)).toEqual({ action: "awaited", pid: 7, ready: true });
    expect(w.spawned).toEqual([]);
    expect(w.logLines.some((l) => l.includes("still binding"))).toBe(true);
  });

  test("a binding gateway on an outdated version is replaced, not waited for", async () => {
    const w = fakeWorld({ info: { ...record(7, "old"), binding: true }, version: "new" });
    expect((await ensureGateway(w.deps)).action).toBe("spawned");
    expect(w.spawned).toEqual([1000]);
  });
});

describe("gateway watchdog", () => {
  test("leaves a healthy gateway alone", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    for (let i = 0; i < 5; i++) await dog.check();
    expect(w.spawned).toEqual([]);
    expect(w.fileLines).toEqual([]);
  });

  test("respawns a dead gateway and logs it to gateway.log", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    w.kill(7);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(w.fileLines).toEqual(["[dev] gateway pid 7 gone; respawning"]);
    expect(w.info?.pid).toBe(1000);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
  });

  test("respawns a live gateway only after repeated stats failures", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    w.state.statsAnswers = false;
    for (let i = 0; i < GATEWAY_UNRESPONSIVE_CHECKS - 1; i++) await dog.check();
    expect(w.spawned).toEqual([]);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(w.fileLines[0]).toContain("unresponsive");
    expect(w.kills).toEqual([[7, "SIGTERM"]]);
  });

  test("a gateway recorded as binding gets its whole ready window before it counts as hung", async () => {
    const w = fakeWorld({ info: { ...record(7, "v1"), binding: true }, statsAnswers: false });
    const dog = createGatewayWatchdog(w.deps, 7);
    for (let i = 0; i < GATEWAY_BINDING_UNRESPONSIVE_CHECKS - 1; i++) await dog.check();
    expect(GATEWAY_BINDING_UNRESPONSIVE_CHECKS).toBeGreaterThan(GATEWAY_UNRESPONSIVE_CHECKS);
    expect(w.spawned).toEqual([]);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
  });

  test("a hung gateway is SIGTERMed and gone before its replacement is spawned", async () => {
    const w = fakeWorld({ info: record(7, "v1"), oldIgnoresRetire: true });
    const spawn = w.deps.spawnDetached;
    let hungAliveAtSpawn: boolean | undefined;
    w.deps.spawnDetached = () => {
      hungAliveAtSpawn = w.alive.has(7);
      return spawn();
    };
    const dog = createGatewayWatchdog(w.deps);
    w.state.statsAnswers = false;
    for (let i = 0; i < GATEWAY_UNRESPONSIVE_CHECKS; i++) await dog.check();
    expect(w.kills).toEqual([[7, "SIGTERM"]]);
    expect(hungAliveAtSpawn).toBe(false);
    expect(w.spawned).toEqual([1000]);
    expect(w.alive.has(1000)).toBe(true);
  });

  test("a hung gateway that ignores SIGTERM is SIGKILLed after the grace period, then replaced", async () => {
    const w = fakeWorld({ info: record(7, "v1"), oldIgnoresRetire: true, ignoresTerm: [7] });
    const spawn = w.deps.spawnDetached;
    let spawnedAt: number | undefined;
    w.deps.spawnDetached = () => {
      spawnedAt = w.deps.now();
      return spawn();
    };
    const dog = createGatewayWatchdog(w.deps);
    w.state.statsAnswers = false;
    const start = w.deps.now();
    for (let i = 0; i < GATEWAY_UNRESPONSIVE_CHECKS; i++) await dog.check();
    expect(w.kills).toEqual([
      [7, "SIGTERM"],
      [7, "SIGKILL"],
    ]);
    expect(w.fileLines.some((l) => l.includes("SIGKILL"))).toBe(true);
    expect((spawnedAt ?? 0) - start).toBeGreaterThanOrEqual(GATEWAY_HUNG_TERM_GRACE_MS);
    expect(w.spawned).toEqual([1000]);
  });

  test("breaker stops respawning after 5 respawns in 60s", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    for (let i = 0; i < 10; i++) {
      if (w.info) w.kill(w.info.pid);
      await dog.check();
      w.advance(2_000);
    }
    expect(w.spawned.length).toBe(GATEWAY_MAX_RESPAWNS_PER_WINDOW);
    expect(dog.gaveUp).toBe(true);
    expect(w.fileLines.at(-1)).toContain("not respawning");
  });

  test("respawns spread over more than 60s never trip the breaker", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    for (let i = 0; i < 10; i++) {
      if (w.info) w.kill(w.info.pid);
      await dog.check();
      w.advance(20_000);
    }
    expect(w.spawned.length).toBe(10);
    expect(dog.gaveUp).toBe(false);
  });

  test("a booting gateway that has not written gateway.json yet is not doubled", async () => {
    const w = fakeWorld();
    w.alive.add(55);
    const dog = createGatewayWatchdog(w.deps, 55);
    await dog.check();
    expect(w.spawned).toEqual([]);
    w.kill(55);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(w.fileLines).toEqual(["[dev] gateway pid 55 gone; respawning"]);
  });

  test("overlapping passes never spawn twice", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    w.kill(7);
    await Promise.all([dog.check(), dog.check(), dog.check()]);
    expect(w.spawned).toEqual([1000]);
  });

  test("a gateway.json pid recycled by another program counts as gone and is never killed", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    w.impostors.add(7);
    const dog = createGatewayWatchdog(w.deps, 7);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(w.fileLines).toEqual(["[dev] gateway pid 7 gone; respawning"]);
    expect(w.kills).toEqual([]);
    expect(w.alive.has(7)).toBe(true);
  });

  test("a hung gateway whose pid is recycled before the SIGKILL is left alone", async () => {
    const w = fakeWorld({ info: record(7, "v1"), oldIgnoresRetire: true, ignoresTerm: [7] });
    const sleep = w.deps.sleep;
    w.deps.sleep = async (ms) => {
      // The hung gateway exits during the grace period and its pid is taken by another program.
      if (w.kills.length > 0) w.impostors.add(7);
      await sleep(ms);
    };
    const dog = createGatewayWatchdog(w.deps);
    w.state.statsAnswers = false;
    for (let i = 0; i < GATEWAY_UNRESPONSIVE_CHECKS; i++) await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(w.kills).toEqual([[7, "SIGTERM"]]);
  });

  test("stats answered by a pid other than the recorded one count as unresponsive", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    w.state.statsPid = 8;
    for (let i = 0; i < GATEWAY_UNRESPONSIVE_CHECKS - 1; i++) await dog.check();
    expect(w.spawned).toEqual([]);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
  });

  test("reset() clears a tripped breaker so the watchdog respawns again", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps);
    for (let i = 0; i <= GATEWAY_MAX_RESPAWNS_PER_WINDOW; i++) {
      if (w.info) w.kill(w.info.pid);
      await dog.check();
    }
    expect(dog.gaveUp).toBe(true);
    const before = w.spawned.length;
    await dog.check();
    expect(w.spawned.length).toBe(before);
    dog.reset();
    expect(dog.gaveUp).toBe(false);
    await dog.check();
    expect(w.spawned.length).toBe(before + 1);
  });

  test("ensureGateway reports a gateway that refused another install's ports as foreign", async () => {
    const w = fakeWorld();
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    expect(await ensureGateway(w.deps)).toEqual({ action: "foreign", pid: 1000 });
    expect(w.fileLines.at(-1)).toContain("another gateway (a different data dir) owns the public ports");
    expect(w.fileLines.at(-1)).toContain("STANDUP_VITE_PORT");
  });

  test("the foreign message names the other gateway's data dir when it answers", async () => {
    const w = fakeWorld();
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    w.state.foreignStats = { pid: 4242, dataDir: "/data/elsewhere" };
    expect((await ensureGateway(w.deps)).action).toBe("foreign");
    expect(w.fileLines.at(-1)).toContain("another gateway (data dir /data/elsewhere) owns the public ports");
  });

  test("a foreign stop re-probes every 30s and respawns once no other gateway answers", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    w.state.foreignStats = { pid: 4242, dataDir: "/data/elsewhere" };
    const dog = createGatewayWatchdog(w.deps, 7);
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    w.kill(7);
    await dog.check();
    expect(dog.foreign).toBe(true);
    // Before the re-probe interval nothing is probed or spawned.
    w.advance(GATEWAY_FOREIGN_REPROBE_MS - 1_000);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    // Still foreign at the re-probe: stays stopped.
    w.advance(1_000);
    await dog.check();
    expect(dog.foreign).toBe(true);
    expect(w.spawned).toEqual([1000]);
    // The other gateway goes away; the next re-probe resumes and respawns.
    w.state.foreignStats = undefined;
    w.state.spawnedExitCode = undefined;
    w.advance(GATEWAY_FOREIGN_REPROBE_MS);
    await dog.check();
    expect(dog.foreign).toBe(false);
    expect(w.spawned).toEqual([1000, 1001]);
    expect(w.fileLines.some((l) => l.includes("resuming the gateway watchdog"))).toBe(true);
    expect(dog.gaveUp).toBe(false);
  });

  test("this install's gateway serving another data dir stays foreign at the re-probe", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps, 7);
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    w.kill(7);
    // A second dev.ts of this install runs its own gateway on another data dir.
    w.alive.add(4242);
    w.state.foreignStats = { pid: 4242, dataDir: "/data/elsewhere" };
    await dog.check();
    expect(dog.foreign).toBe(true);
    for (let i = 0; i < 3; i++) {
      w.advance(GATEWAY_FOREIGN_REPROBE_MS);
      await dog.check();
    }
    expect(dog.foreign).toBe(true);
    expect(w.spawned).toEqual([1000]);
    expect(w.fileLines.some((l) => l.includes("resuming the gateway watchdog"))).toBe(false);
  });

  test("a watchdog started after a foreign ensure re-probes too, without re-reporting the refusal", async () => {
    const w = fakeWorld();
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    const ensured = await ensureGateway(w.deps);
    expect(ensured.action).toBe("foreign");
    const dog = createGatewayWatchdog(w.deps, 1000, { foreign: true });
    w.state.spawnedExitCode = undefined;
    w.advance(GATEWAY_FOREIGN_REPROBE_MS);
    await dog.check();
    expect(dog.foreign).toBe(false);
    expect(w.spawned).toEqual([1000, 1001]);
  });

  test("a foreign refusal stops the watchdog without tripping the breaker, until reset()", async () => {
    const w = fakeWorld({ info: record(7, "v1") });
    const dog = createGatewayWatchdog(w.deps, 7);
    w.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    w.kill(7);
    await dog.check();
    expect(w.spawned).toEqual([1000]);
    expect(dog.foreign).toBe(true);
    expect(dog.gaveUp).toBe(false);
    for (let i = 0; i < 10; i++) await dog.check();
    expect(w.spawned).toEqual([1000]);
    w.state.spawnedExitCode = undefined;
    dog.reset();
    await dog.check();
    expect(w.spawned).toEqual([1000, 1001]);
    expect(dog.foreign).toBe(false);
  });

  test("a watchdog started after a foreign ensure stays stopped, and a refused known pid stops it too", async () => {
    const stopped = fakeWorld();
    const dog = createGatewayWatchdog(stopped.deps, 1000, { foreign: true });
    await dog.check();
    expect(stopped.spawned).toEqual([]);
    const refused = fakeWorld();
    refused.state.spawnedExitCode = EXIT_FOREIGN_GATEWAY;
    const pid = refused.deps.spawnDetached()!;
    const dog2 = createGatewayWatchdog(refused.deps, pid);
    await dog2.check();
    expect(dog2.foreign).toBe(true);
    expect(refused.spawned).toEqual([pid]);
  });

  test("a gateway that exits with a bind failure is respawned and counts toward the breaker", async () => {
    const w = fakeWorld();
    w.state.spawnedExitCode = 1;
    const dog = createGatewayWatchdog(w.deps);
    for (let i = 0; i <= GATEWAY_MAX_RESPAWNS_PER_WINDOW + 2; i++) await dog.check();
    expect(dog.foreign).toBe(false);
    expect(dog.gaveUp).toBe(true);
    expect(w.spawned.length).toBe(GATEWAY_MAX_RESPAWNS_PER_WINDOW);
  });

});

/** A fake world for stopping a leftover gateway before the classic topology starts. */
function classicWorld(opts: { info?: GatewayInfo; exitsAfterMs?: number; ignoresTerm?: boolean; portsBusyAfterExitMs?: number } = {}) {
  let clock = 0;
  const alive = new Set<number>(opts.info ? [opts.info.pid] : []);
  const impostors = new Set<number>();
  const kills: [number, string][] = [];
  const logLines: string[] = [];
  const fileLines: string[] = [];
  let termAt: number | undefined;
  let exitedAt: number | undefined;
  const tick = (): void => {
    if (termAt === undefined || opts.ignoresTerm || !opts.info) return;
    if (clock - termAt >= (opts.exitsAfterMs ?? 0) && alive.has(opts.info.pid)) {
      alive.delete(opts.info.pid);
      exitedAt = clock;
    }
  };
  const deps: ClassicStopDeps = {
    readInfo: () => opts.info,
    isGateway: (pid) => {
      tick();
      return alive.has(pid) && !impostors.has(pid);
    },
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      if (signal === "SIGTERM") termAt = clock;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (m) => logLines.push(m),
    appendLog: (m) => fileLines.push(m),
    portsFree: async () => exitedAt !== undefined && clock - exitedAt >= (opts.portsBusyAfterExitMs ?? 0),
  };
  return { deps, alive, impostors, kills, logLines, fileLines, get clock() {
    return clock;
  } };
}

describe("stopGatewayForClassic", () => {
  test("does nothing without a recorded gateway", async () => {
    const w = classicWorld();
    expect(await stopGatewayForClassic(w.deps, PORTS)).toBe("none");
    expect(w.kills).toEqual([]);
  });

  test("never signals a recorded pid that is not this install's gateway", async () => {
    const w = classicWorld({ info: record(7, "v1") });
    w.impostors.add(7);
    expect(await stopGatewayForClassic(w.deps, PORTS)).toBe("none");
    expect(w.kills).toEqual([]);
  });

  test("SIGTERMs a live gateway and waits for it to exit and the ports to free", async () => {
    const w = classicWorld({ info: record(7, "v1"), exitsAfterMs: 3_000, portsBusyAfterExitMs: 1_000 });
    expect(await stopGatewayForClassic(w.deps, PORTS)).toBe("stopped");
    expect(w.kills).toEqual([[7, "SIGTERM"]]);
    expect(w.clock).toBeGreaterThanOrEqual(4_000);
    expect(w.clock).toBeLessThan(CLASSIC_GATEWAY_STOP_TIMEOUT_MS);
    expect(w.fileLines[0]).toContain("Classic mode: stopping gateway pid 7");
  });

  test("a binding gateway that puts back its predecessor's record gets that predecessor stopped too", async () => {
    let clock = 0;
    let info: GatewayInfo | undefined = { ...record(7, "v1"), binding: true };
    const alive = new Set([7, 8]);
    const kills: [number, string][] = [];
    const deps: ClassicStopDeps = {
      readInfo: () => info,
      isGateway: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        alive.delete(pid);
        // The binding gateway restores the record of the gateway it was replacing.
        if (pid === 7) info = record(8, "v0");
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
      appendLog: () => {},
      portsFree: async () => !alive.has(8),
    };
    expect(await stopGatewayForClassic(deps, PORTS)).toBe("stopped");
    expect(kills).toEqual([
      [7, "SIGTERM"],
      [8, "SIGTERM"],
    ]);
  });

  test("gives up after the timeout and says so", async () => {
    const w = classicWorld({ info: record(7, "v1"), ignoresTerm: true });
    expect(await stopGatewayForClassic(w.deps, PORTS)).toBe("timeout");
    expect(w.clock).toBeGreaterThanOrEqual(CLASSIC_GATEWAY_STOP_TIMEOUT_MS);
    expect(w.kills).toEqual([[7, "SIGTERM"]]);
    expect(w.logLines.at(-1)).toContain("did not exit");
  });
});

describe("crash-loop breaker and the respawn signal", () => {
  test("trips after more than max exits in the window, and reset() clears it", () => {
    let clock = 0;
    const breaker = new CrashLoopBreaker(60_000, 5, () => clock);
    for (let i = 0; i < 5; i++) expect(breaker.recordExit()).toBe(true);
    expect(breaker.recordExit()).toBe(false);
    expect(breaker.recent).toBe(6);
    breaker.reset();
    expect(breaker.recent).toBe(0);
    expect(breaker.recordExit()).toBe(true);
    clock += 61_000;
    for (let i = 0; i < 4; i++) breaker.recordExit();
    expect(breaker.recent).toBe(4);
  });

  test("respawnGivenUp resets every breaker and restarts only the given-up services", () => {
    const starts: string[] = [];
    const make = (name: string, gaveUp: boolean): SupervisedService => {
      const breaker = new CrashLoopBreaker(60_000, 1, () => 0);
      breaker.recordExit();
      breaker.recordExit();
      return { name, breaker, gaveUp, start: () => starts.push(name) };
    };
    const services = [make("collector:a", true), make("collector:b", false), make("web", true)];
    expect(respawnGivenUp(services)).toEqual(["collector:a", "web"]);
    expect(starts).toEqual(["collector:a", "web"]);
    expect(services.every((s) => s.breaker.recent === 0 && !s.gaveUp)).toBe(true);
    expect(respawnGivenUp(services)).toEqual([]);
    expect(starts).toEqual(["collector:a", "web"]);
  });
});

describe("gateway identity", () => {
  const cli = gatewayCliPath("/install");

  test("isInstallGateway needs a live pid whose command line runs the CLI", () => {
    const lines = new Map<number, string>([[process.pid, `bun run ${cli}`]]);
    const lookup = (pid: number) => lines.get(pid);
    expect(isInstallGateway(process.pid, [cli], lookup)).toBe(true);
    expect(isInstallGateway(process.pid, [gatewayCliPath("/elsewhere")], lookup)).toBe(false);
    expect(isInstallGateway(process.pid, [cli], () => undefined)).toBe(false);
    expect(isInstallGateway(process.pid, [cli], lookup, () => false)).toBe(false);
    expect(isInstallGateway(0, [cli], lookup, () => true)).toBe(false);
    // Another install's gateway runs the same relative path from elsewhere.
    expect(isInstallGateway(process.pid, [cli], () => `bun run ${gatewayCliPath("/other-install")}`)).toBe(false);
  });

  test("a real unrelated process is not a gateway", async () => {
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(isInstallGateway(child.pid, gatewayCliPaths(ROOT))).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("gatewayCliPaths is absolute and includes the realpath of a symlinked install", () => {
    const real = tmp();
    const src = join(real, "packages", "gateway", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cli.ts"), "");
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    const paths = gatewayCliPaths(`${link}/`);
    expect(paths[0]).toBe(join(link, "packages", "gateway", "src", "cli.ts"));
    expect(paths).toContain(join(realpathSync(real), "packages", "gateway", "src", "cli.ts"));
  });
});

describe("devOwnershipConflict", () => {
  const own = { pid: 500, installDir: "/installs/b", dataDir: "/data/shared" };
  const record = (pid: number, installDir: string) => ({ pid, installDir, startedAt: "t", gateway: true });
  const live = (cmdline: string | undefined) => ({ alive: () => true, commandLine: () => cmdline });

  test("refuses beside a live dev.ts of another install, naming both install dirs, the data dir and DB_PATH", () => {
    const msg = devOwnershipConflict(record(400, "/installs/a"), own, live("bun run scripts/dev.ts"));
    expect(msg).toBeDefined();
    for (const part of ["/installs/a", "/installs/b", "/data/shared", "DB_PATH", "pid 400"]) expect(msg).toContain(part);
  });

  test("an unreadable command line of a live pid still counts as that dev.ts", () => {
    expect(devOwnershipConflict(record(400, "/installs/a"), own, live(undefined))).toBeDefined();
  });

  test("starts when the record is this install's, its own, dead, recycled, or missing", () => {
    expect(devOwnershipConflict(record(400, "/installs/b/"), own, live("bun run scripts/dev.ts"))).toBeUndefined();
    expect(devOwnershipConflict(record(500, "/installs/a"), own, live("bun run scripts/dev.ts"))).toBeUndefined();
    expect(devOwnershipConflict(record(400, "/installs/a"), own, { alive: () => false, commandLine: () => "bun run scripts/dev.ts" })).toBeUndefined();
    expect(devOwnershipConflict(record(400, "/installs/a"), own, live("/usr/bin/vim notes.txt"))).toBeUndefined();
    expect(devOwnershipConflict(undefined, own, live("bun run scripts/dev.ts"))).toBeUndefined();
    expect(devOwnershipConflict({ pid: 400 }, own, live("bun run scripts/dev.ts"))).toBeUndefined();
  });

  test("an install reached through a symlink is the same install, not another", () => {
    const dir = tmp();
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);
    const mine = { pid: 500, installDir: real, dataDir: "/data/shared" };
    expect(devOwnershipConflict(record(400, link), mine, live("bun run scripts/dev.ts"))).toBeUndefined();
    expect(devOwnershipConflict(record(400, real), { ...mine, installDir: link }, live("bun run scripts/dev.ts"))).toBeUndefined();
    expect(devOwnershipConflict(record(400, join(dir, "other")), mine, live("bun run scripts/dev.ts"))).toBeDefined();
  });
});

describe("spawnDetached", () => {
  test("spawns detached with stdio on the log file and unrefs the child", () => {
    const dir = tmp();
    const logPath = join(dir, "gateway", "gateway.log");
    const calls: { command: string; args: string[]; options: Parameters<ChildSpawn>[2] }[] = [];
    let unrefs = 0;
    let exitListener: ((code: number | null) => void) | undefined;
    const fake: ChildSpawn = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        pid: 4242,
        unref: () => void unrefs++,
        once: (_event, listener) => {
          exitListener = listener;
        },
      };
    };
    const exitsSeen: [number, number | null][] = [];
    const pid = spawnDetached(
      ["bun", "run", "cli.ts"],
      { cwd: dir, env: { A: "1", STANDUP_VITE_PORT: String(VITE) }, logPath, onExit: (p, code) => exitsSeen.push([p, code]) },
      fake,
    );
    expect(pid).toBe(4242);
    exitListener?.(EXIT_FOREIGN_GATEWAY);
    expect(exitsSeen).toEqual([[4242, EXIT_FOREIGN_GATEWAY]]);
    expect(unrefs).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("bun");
    expect(calls[0].args).toEqual(["run", "cli.ts"]);
    expect(calls[0].options.detached).toBe(true);
    expect(calls[0].options.stdio[0]).toBe("ignore");
    expect(typeof calls[0].options.stdio[1]).toBe("number");
    expect(calls[0].options.env.STANDUP_VITE_PORT).toBe(String(VITE));
  });

  test("a real detached child gets its own process group and survives its parent's SIGTERM", async () => {
    const dir = tmp();
    const logPath = join(dir, "gateway.log");
    const pidFile = join(dir, "child.pid");
    // A parent that, like dev.ts, spawns the child detached and then is SIGTERMed.
    const parentScript = join(dir, "parent.ts");
    writeFileSync(
      parentScript,
      `import { writeFileSync } from "node:fs";
import { spawnDetached } from ${JSON.stringify(join(import.meta.dir, "dev-topology.ts"))};
const pid = spawnDetached(["sleep", "30"], { cwd: ${JSON.stringify(dir)}, env: process.env, logPath: ${JSON.stringify(logPath)} });
writeFileSync(${JSON.stringify(pidFile)}, String(pid));
process.on("SIGTERM", () => process.exit(0));
await new Promise(() => {});
`,
    );
    const parent = Bun.spawn([process.execPath, "run", parentScript], { stdout: "ignore", stderr: "inherit" });
    let childPid = 0;
    try {
      for (let i = 0; i < 100 && !childPid; i++) {
        await Bun.sleep(50);
        try {
          childPid = Number(readFileSync(pidFile, "utf8"));
        } catch {
          // not written yet
        }
      }
      expect(childPid).toBeGreaterThan(0);
      parent.kill("SIGTERM");
      await parent.exited;
      await Bun.sleep(200);
      expect(pidAlive(childPid)).toBe(true);
      // setsid: the child leads its own session and process group, so a
      // terminal Ctrl+C aimed at dev.ts's group never reaches it.
      const ps = Bun.spawnSync(["ps", "-o", "pgid=,sid=", "-p", String(childPid)]);
      const [pgid, sid] = ps.stdout.toString().trim().split(/\s+/).map(Number);
      expect(pgid).toBe(childPid);
      expect(sid).toBe(childPid);
    } finally {
      parent.kill("SIGKILL");
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

describe("helpers", () => {
  test("appendLogLine writes timestamped lines", () => {
    const logPath = join(tmp(), "gateway", "gateway.log");
    appendLogLine(logPath, "[dev] gateway pid 9 gone; respawning");
    expect(readFileSync(logPath, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z \[dev\] gateway pid 9 gone; respawning\n$/);
  });

  test("gatewayStatsUrl targets GATEWAY_HOST on the public collector port", () => {
    expect(gatewayStatsUrl(PORTS.collector)).toBe(`http://${GATEWAY_HOST}:${PORTS.collector}/__gateway/stats`);
  });

  test("stripGitEnv drops GIT_* vars only", () => {
    expect(stripGitEnv({ GIT_DIR: "/x", GIT_WORK_TREE: "/y", PATH: "/bin", GITHUB_TOKEN: "t" })).toEqual({ PATH: "/bin", GITHUB_TOKEN: "t" });
  });

  test("resolveDbPath is absolute: relative DB_PATH resolves against packages/collector", () => {
    expect(resolveDbPath({ DB_PATH: "/abs/standup.db" }, ROOT)).toBe("/abs/standup.db");
    expect(resolveDbPath({ DB_PATH: "data/standup.db" }, ROOT)).toBe("/repo/packages/collector/data/standup.db");
    expect(resolveDbPath({}, ROOT)).toBe(join(homedir(), ".local", "share", "standup", "standup.db"));
    expect(resolveDbPath({ DB_PATH: "" }, ROOT)).toBe(join(homedir(), ".local", "share", "standup", "standup.db"));
  });

  test("loadGatewayVersion is undefined without gateway sources and loads them when present", async () => {
    const root = tmp();
    expect(await loadGatewayVersion(root)).toBeUndefined();
    const src = join(root, "packages", "gateway", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "cli.ts"), "");
    writeFileSync(join(src, "version.ts"), 'export function gatewayVersion(): string { return "abc"; }\n');
    expect((await loadGatewayVersion(root))?.()).toBe("abc");
  });
});
