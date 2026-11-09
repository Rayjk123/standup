/**
 * The process topology `bun run dev` runs, and the long-lived gateway it keeps
 * alive in gateway mode. Pure planning plus gateway ensure/watchdog logic with
 * injected side effects, so dev.ts stays a thin shell and this is unit-testable.
 * In gateway mode the gateway holds the public ports and forwards to whichever
 * collector slot leads, so a collector restart hands off to the standby slot
 * without the front door going away.
 */
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliPathsOf, commandLineOf, pidAlive, runsCliPath, runsDevScript, samePath, validPid } from "../packages/shared/src/process-identity.js";
import {
  COLLECTOR_SLOTS,
  EXIT_FOREIGN_GATEWAY,
  GATEWAY_HOST,
  GATEWAY_STATS_PATH,
  gatewayEnabled,
  slotPorts,
  type DevInfo,
  type GatewayInfo,
  type GatewayStats,
  type PublicPorts,
} from "../packages/shared/src/topology.js";

/** One supervised service: what runProcess spawns, plus env layered over dev.ts's own. */
export interface ServicePlan {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  /** Vars removed from dev.ts's env before `env` is layered on. */
  unset?: string[];
}

export interface PlanOptions {
  /** Repo root (with or without a trailing slash, as dev.ts computes it). */
  root: string;
  slackConfigured: boolean;
  /** Overrides the env-derived mode, e.g. when the gateway sources are missing. */
  gateway?: boolean;
  /** The public ports; the collector slots bind offsets of them in gateway mode. */
  ports: PublicPorts;
  /** Vite's own port in gateway mode. */
  vitePort: number;
}

export interface Plan {
  mode: "classic" | "gateway";
  services: ServicePlan[];
}

/**
 * The services dev.ts supervises. Classic mode: one collector on the public
 * ports and vite on the public web port. Gateway mode: collector slots a and b
 * on their slot ports and vite on STANDUP_VITE_PORT; the gateway itself is not
 * a supervised service (it is spawned detached and outlives dev.ts).
 */
export function planServices(env: NodeJS.ProcessEnv, opts: PlanOptions): Plan {
  const gateway = opts.gateway ?? gatewayEnabled(env);
  const collectorCmd = ["bun", "run", env.STANDUP_COLLECTOR_WATCH === "1" ? "dev" : "start"];
  const collectorCwd = `${opts.root}/packages/collector`;
  // The console is served from a production build (packages/web/serve.ts):
  // the vite dev server sends every source module as its own request, which
  // over a tunnel takes seconds to load. STANDUP_WEB_DEV=1 runs the dev
  // server instead, with hot module reload, for working on the console.
  const webCmd = ["bun", "run", env.STANDUP_WEB_DEV === "1" ? "dev" : "serve"];
  const services: ServicePlan[] = [];

  if (gateway) {
    for (const slot of COLLECTOR_SLOTS) {
      const listen = slotPorts(opts.ports.collector, opts.ports.ws, slot);
      services.push({
        name: `collector:${slot}`,
        cmd: collectorCmd,
        cwd: collectorCwd,
        env: {
          STANDUP_COLLECTOR_SLOT: slot,
          STANDUP_LISTEN_PORT: String(listen.http),
          STANDUP_LISTEN_WS_PORT: String(listen.ws),
        },
      });
    }
    services.push({
      name: "web",
      cmd: webCmd,
      cwd: `${opts.root}/packages/web`,
      env: { STANDUP_VITE_PORT: String(opts.vitePort) },
    });
  } else {
    services.push({ name: "collector", cmd: collectorCmd, cwd: collectorCwd, env: {} });
    // vite.config.ts treats STANDUP_VITE_PORT as "behind the gateway"; classic
    // vite must serve the public web port itself.
    services.push({ name: "web", cmd: webCmd, cwd: `${opts.root}/packages/web`, env: {}, unset: ["STANDUP_VITE_PORT"] });
  }

  if (opts.slackConfigured) {
    services.push({ name: "slack", cmd: ["bun", "run", "dev"], cwd: `${opts.root}/packages/slack`, env: {} });
  }
  return { mode: gateway ? "gateway" : "classic", services };
}

/** The env a service runs with: dev.ts's own minus `unset`, with `extra` and the service's env on top. */
export function serviceEnv(base: NodeJS.ProcessEnv, service: Pick<ServicePlan, "env" | "unset">, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of service.unset ?? []) delete env[key];
  return { ...env, ...service.env };
}

/** What dev.ts needs from a gateway it reuses. */
export interface GatewayConfig {
  ports: PublicPorts;
  /** Where the gateway proxies the web port to. */
  vitePort: number;
  /** Absolute data dir whose collector leader the gateway routes to. */
  dataDir: string;
}

/**
 * Why a recorded gateway can't serve this dev.ts, or undefined when it can:
 * it must run the gateway source on disk, own the same public ports, proxy to
 * the same vite port and route the same data dir. Fields a gateway doesn't
 * report (an absent dataDir, or no stats) are not held against it.
 */
export function gatewayMismatch(
  info: Pick<GatewayInfo, "version" | "ports" | "dataDir">,
  stats: Pick<GatewayStats, "dataDir" | "upstream"> | undefined,
  want: GatewayConfig & { version: string },
): string | undefined {
  if (info.version !== want.version) {
    return `runs version ${String(info.version).slice(0, 12)}, source is ${want.version.slice(0, 12)}`;
  }
  const p = info.ports;
  if (!p || p.web !== want.ports.web || p.collector !== want.ports.collector || p.ws !== want.ports.ws) {
    return `owns ports ${JSON.stringify(p)}, want ${JSON.stringify(want.ports)}`;
  }
  const dataDir = info.dataDir ?? stats?.dataDir;
  if (dataDir !== undefined && resolve(dataDir) !== resolve(want.dataDir)) {
    return `routes data dir ${dataDir}, want ${want.dataDir}`;
  }
  const web = stats?.upstream?.web;
  if (web !== undefined && web !== want.vitePort) {
    return `proxies the web port to ${web}, want ${want.vitePort}`;
  }
  return undefined;
}

/**
 * Whether a recorded gateway can keep serving: its pid is verified as this
 * install's gateway, its stats (when they answer) come from that pid, and it
 * matches the wanted version and config.
 */
export function shouldReuseGateway(
  info: Pick<GatewayInfo, "pid" | "version" | "ports" | "dataDir"> | undefined,
  verified: boolean,
  want: GatewayConfig & { version: string },
  stats?: Pick<GatewayStats, "pid" | "dataDir" | "upstream">,
): boolean {
  if (info === undefined || !validPid(info.pid) || !verified) return false;
  if (stats !== undefined && stats.pid !== info.pid) return false;
  return gatewayMismatch(info, stats, want) === undefined;
}

/** Side effects the gateway ensure/watchdog logic needs. */
export interface GatewayDeps {
  readInfo(): GatewayInfo | undefined;
  /**
   * Whether `pid` is a live process running this install's gateway CLI. A pid
   * from gateway.json may have been recycled (reboot, OOM) by an unrelated
   * process, so it is checked before it is reused or signalled.
   */
  isGateway(pid: number): boolean;
  /** Version of the gateway source on disk. */
  version(): string;
  /** The config a reused gateway must match. */
  config: GatewayConfig;
  /** Starts the gateway in its own session, outside dev.ts's kill list; returns its pid. */
  spawnDetached(): number | undefined;
  /** Exit code of a gateway spawnDetached started, once it has exited (undefined while running or when killed by a signal). */
  exitCode(pid: number): number | undefined;
  kill(pid: number, signal: NodeJS.Signals): void;
  fetchStats(): Promise<GatewayStats | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Console log line. */
  log(message: string): void;
  /** Line appended to gateway.log. */
  appendLog(message: string): void;
}

/**
 * How long ensureGateway waits for a spawned gateway to serve. The gateway
 * retries a busy bind for 30s before it gives up, so this outlasts that.
 */
export const GATEWAY_READY_TIMEOUT_MS = 40_000;
export const GATEWAY_READY_POLL_MS = 200;
export const GATEWAY_WATCH_INTERVAL_MS = 2_000;
/** Consecutive stats failures from a live pid before it counts as hung. */
export const GATEWAY_UNRESPONSIVE_CHECKS = 3;
/** The same for a gateway gateway.json marks `binding`: its whole ready window. */
export const GATEWAY_BINDING_UNRESPONSIVE_CHECKS = Math.ceil(GATEWAY_READY_TIMEOUT_MS / GATEWAY_WATCH_INTERVAL_MS);
/**
 * How long a hung gateway gets to exit on SIGTERM before it is SIGKILLed. Its
 * replacement is only spawned once it is gone, since its listeners hold the
 * public ports (they are never shared).
 */
export const GATEWAY_HUNG_TERM_GRACE_MS = 3_000;
/** How long a SIGKILLed hung gateway gets to disappear before the replacement is spawned anyway. */
export const GATEWAY_HUNG_KILL_WAIT_MS = 1_000;
export const GATEWAY_RESPAWN_WINDOW_MS = 60_000;
export const GATEWAY_MAX_RESPAWNS_PER_WINDOW = 5;

export type EnsureResult =
  | { action: "reused"; pid: number }
  | { action: "spawned"; pid: number; ready: boolean }
  /** A recorded gateway still binding the ports was waited for instead of doubled. */
  | { action: "awaited"; pid: number; ready: boolean }
  | { action: "foreign"; pid: number }
  | { action: "failed"; reason: string };

/** How often a watchdog stopped by a foreign gateway re-checks whether that gateway is gone. */
export const GATEWAY_FOREIGN_REPROBE_MS = 30_000;

/**
 * Console and gateway.log line for a gateway that exited with
 * EXIT_FOREIGN_GATEWAY. `otherDataDir` is what the gateway now answering the
 * collector port reports, when it answers.
 */
export function foreignGatewayMessage(pid: number, otherDataDir?: string): string {
  const other = otherDataDir !== undefined ? `another gateway (data dir ${otherDataDir})` : "another gateway (a different data dir)";
  return (
    `[dev] gateway pid ${pid} exited: ${other} owns the public ports, so they are NOT served by this install. ` +
    `Re-checking every ${GATEWAY_FOREIGN_REPROBE_MS / 1000}s and respawning once it is gone. Or stop it, or give this install ` +
    `other ports (STANDUP_WEB_PORT / COLLECTOR_PORT / WS_PORT / STANDUP_VITE_PORT) and send SIGUSR2 to dev.ts.`
  );
}

/** Logs foreignGatewayMessage for `pid`, naming the data dir of whichever gateway answers now. */
async function reportForeign(deps: GatewayDeps, pid: number): Promise<void> {
  const other = await deps.fetchStats();
  const msg = foreignGatewayMessage(pid, other?.dataDir);
  deps.appendLog(msg);
  deps.log(msg);
}

/**
 * Reuses the recorded gateway when it is verified as this install's, current
 * and configured the same, else spawns one and waits for its stats endpoint to
 * answer with the new pid. A newer gateway retires the one in gateway.json
 * itself, so an outdated live gateway is left for it to stop rather than
 * killed here. A recorded pid that isn't this install's gateway is ignored.
 */
export async function ensureGateway(deps: GatewayDeps, opts: { replace?: boolean } = {}): Promise<EnsureResult> {
  const version = deps.version();
  const want = { ...deps.config, version };
  const info = deps.readInfo();
  const recorded = info !== undefined && validPid(info.pid) ? info.pid : undefined;
  const verified = recorded !== undefined && deps.isGateway(recorded);
  if (info && recorded !== undefined && verified) {
    if (!opts.replace && info.binding === true && gatewayMismatch(info, undefined, want) === undefined) {
      // A current gateway still in its bind retry: a second one beside it
      // would only race it for the same ports.
      deps.log(`[dev] Gateway pid ${recorded} is still binding the public ports — waiting for it`);
      const result = await waitForServing(deps, recorded);
      return result.action === "spawned" ? { action: "awaited", pid: recorded, ready: result.ready } : result;
    }
    if (!opts.replace) {
      const stats = await deps.fetchStats();
      const reason =
        stats !== undefined && stats.pid !== recorded
          ? `is recorded but pid ${stats.pid} answers ${GATEWAY_STATS_PATH}`
          : gatewayMismatch(info, stats, want);
      if (reason === undefined) {
        deps.log(`[dev] Reusing gateway pid ${recorded} (version ${version.slice(0, 12)})`);
        return { action: "reused", pid: recorded };
      }
      deps.log(`[dev] Gateway pid ${recorded} ${reason} — starting a new one (it retires the old)`);
    }
  } else if (recorded !== undefined) {
    deps.log(`[dev] gateway.json names pid ${recorded}, which is not a running gateway of this install — ignoring it`);
  }

  let pid: number | undefined;
  try {
    pid = deps.spawnDetached();
  } catch (err) {
    const reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    deps.log(`[dev] Gateway ${reason}`);
    return { action: "failed", reason };
  }
  if (pid === undefined) {
    deps.log("[dev] Gateway spawn returned no pid");
    return { action: "failed", reason: "spawn returned no pid" };
  }
  return waitForServing(deps, pid);
}

/**
 * Waits up to GATEWAY_READY_TIMEOUT_MS for `pid`'s stats to answer. A gateway
 * that exits EXIT_FOREIGN_GATEWAY on the way is reported as foreign.
 */
async function waitForServing(deps: GatewayDeps, pid: number): Promise<EnsureResult> {
  const deadline = deps.now() + GATEWAY_READY_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const stats = await deps.fetchStats();
    if (stats?.pid === pid) {
      deps.log(`[dev] Gateway pid ${pid} is serving`);
      return { action: "spawned", pid, ready: true };
    }
    if (!deps.isGateway(pid)) {
      // One more poll lets the exit be reaped and its code recorded.
      await deps.sleep(GATEWAY_READY_POLL_MS);
      if (deps.exitCode(pid) === EXIT_FOREIGN_GATEWAY) {
        await reportForeign(deps, pid);
        return { action: "foreign", pid };
      }
      break;
    }
    await deps.sleep(GATEWAY_READY_POLL_MS);
  }
  deps.log(`[dev] Gateway pid ${pid} did not answer ${GATEWAY_STATS_PATH} within ${GATEWAY_READY_TIMEOUT_MS / 1000}s — continuing; see gateway.log`);
  return { action: "spawned", pid, ready: false };
}

export interface GatewayWatchdog {
  /** One watchdog pass; the interval timer calls this. */
  check(): Promise<void>;
  /** True once the crash-loop breaker has tripped. */
  readonly gaveUp: boolean;
  /**
   * True once a gateway exited EXIT_FOREIGN_GATEWAY. Checks then only re-probe
   * the collector port every GATEWAY_FOREIGN_REPROBE_MS, and resume once no
   * other gateway answers there (or on reset()).
   */
  readonly foreign: boolean;
  /** Clears the crash-loop breaker, the foreign stop and the unresponsive count, so checks resume. */
  reset(): void;
}

/**
 * Keeps the gateway alive: a gateway.json pid that is gone (or now belongs to
 * some other process), or a live gateway whose stats endpoint stops answering
 * as that pid for GATEWAY_UNRESPONSIVE_CHECKS passes in a row, is logged to
 * gateway.log and respawned. More than GATEWAY_MAX_RESPAWNS_PER_WINDOW
 * respawns in GATEWAY_RESPAWN_WINDOW_MS trips a breaker that stops respawning.
 * A gateway refused by another install's gateway stops respawns until that
 * gateway is gone (see `foreign`). Passes never overlap, so the watchdog never races its own spawn.
 * `initialPid` is the gateway dev.ts just ensured (spawned or reused).
 */
export function createGatewayWatchdog(deps: GatewayDeps, initialPid?: number, opts: { foreign?: boolean } = {}): GatewayWatchdog {
  let known = initialPid;
  const respawns: number[] = [];
  let running = false;
  let gaveUp = false;
  let foreign = opts.foreign ?? false;
  let foreignCheckedAt = deps.now();
  let unresponsive = 0;
  // Gateways whose foreign refusal has been acted on, so their exit code
  // never stops the watchdog a second time.
  const handledRefusals = new Set<number>();
  if (foreign && initialPid !== undefined) handledRefusals.add(initialPid);

  const stopForeign = (pid?: number): void => {
    foreign = true;
    foreignCheckedAt = deps.now();
    if (pid !== undefined) handledRefusals.add(pid);
  };

  /**
   * While stopped by a foreign gateway, re-probes the collector port every
   * GATEWAY_FOREIGN_REPROBE_MS. True once nothing answers there, or only this
   * install's own gateway serving this data dir, so the watchdog resumes. This
   * install's gateway serving another data dir still counts as foreign: it
   * belongs to a second dev.ts and refuses this one's gateway again.
   */
  const foreignGone = async (): Promise<boolean> => {
    if (deps.now() - foreignCheckedAt < GATEWAY_FOREIGN_REPROBE_MS) return false;
    foreignCheckedAt = deps.now();
    const stats = await deps.fetchStats();
    if (stats !== undefined) {
      if (!deps.isGateway(stats.pid)) return false;
      if (stats.dataDir !== undefined && resolve(stats.dataDir) !== resolve(deps.config.dataDir)) return false;
    }
    const msg = "[dev] no other gateway answers on the collector port any more; resuming the gateway watchdog";
    deps.appendLog(msg);
    deps.log(msg);
    return true;
  };

  const respawn = async (why: string, hungPid?: number): Promise<void> => {
    const now = deps.now();
    respawns.push(now);
    while (respawns.length > 0 && now - respawns[0] > GATEWAY_RESPAWN_WINDOW_MS) respawns.shift();
    if (respawns.length > GATEWAY_MAX_RESPAWNS_PER_WINDOW) {
      gaveUp = true;
      const msg = `[dev] gateway ${why} and has been respawned ${respawns.length - 1}× in ${GATEWAY_RESPAWN_WINDOW_MS / 1000}s — not respawning. The public ports are DOWN; check gateway.log and rerun \`bun run dev\`.`;
      deps.appendLog(msg);
      deps.log(msg);
      return;
    }
    deps.appendLog(`[dev] ${why}; respawning`);
    deps.log(`[dev] ${why}; respawning`);
    unresponsive = 0;
    if (hungPid !== undefined) await stopHung(hungPid);
    const result = await ensureGateway(deps, { replace: hungPid !== undefined });
    if (result.action === "foreign") {
      stopForeign(result.pid);
      return;
    }
    if (result.action !== "failed") known = result.pid;
  };

  /**
   * Stops a hung gateway before its replacement is spawned: its listeners hold
   * the public ports, so the replacement could not bind beside it. SIGTERM
   * first (a gateway that still handles signals stops listening at once),
   * then SIGKILL past GATEWAY_HUNG_TERM_GRACE_MS. Every signal is preceded by
   * a check that the pid is still this install's gateway.
   */
  const stopHung = async (pid: number): Promise<void> => {
    if (!deps.isGateway(pid)) return;
    deps.kill(pid, "SIGTERM");
    if (await waitGone(pid, GATEWAY_HUNG_TERM_GRACE_MS)) return;
    const msg = `[dev] gateway pid ${pid} still alive ${GATEWAY_HUNG_TERM_GRACE_MS / 1000}s after SIGTERM; sending SIGKILL`;
    deps.appendLog(msg);
    deps.log(msg);
    deps.kill(pid, "SIGKILL");
    await waitGone(pid, GATEWAY_HUNG_KILL_WAIT_MS);
  };

  /** Polls until `pid` is no longer this install's gateway; false if it still is after `ms`. */
  const waitGone = async (pid: number, ms: number): Promise<boolean> => {
    const deadline = deps.now() + ms;
    for (;;) {
      if (!deps.isGateway(pid)) return true;
      if (deps.now() >= deadline) return false;
      await deps.sleep(GATEWAY_READY_POLL_MS);
    }
  };

  const check = async (): Promise<void> => {
    if (running || gaveUp) return;
    running = true;
    try {
      if (foreign) {
        if (!(await foreignGone())) return;
        foreign = false;
      }
      const info = deps.readInfo();
      // The recorded pid, else the one dev.ts last started: a gateway still
      // booting may not have written gateway.json yet, and spawning a second
      // one beside it would leave two gateways sharing the ports.
      let pid: number | undefined;
      if (info && validPid(info.pid) && deps.isGateway(info.pid)) pid = info.pid;
      else if (known !== undefined && deps.isGateway(known)) pid = known;
      if (pid === undefined) {
        // A gateway that found another install's gateway on the ports exits
        // EXIT_FOREIGN_GATEWAY; a respawn would only meet the same refusal.
        const refused = [known, info?.pid].find(
          (p): p is number => validPid(p) && !handledRefusals.has(p) && deps.exitCode(p) === EXIT_FOREIGN_GATEWAY
        );
        if (refused !== undefined) {
          stopForeign(refused);
          await reportForeign(deps, refused);
          return;
        }
        const gone = info && validPid(info.pid) ? info.pid : known;
        await respawn(gone !== undefined ? `gateway pid ${gone} gone` : "gateway not running (no gateway.json)");
        return;
      }
      const stats = await deps.fetchStats();
      if (stats?.pid === pid) {
        unresponsive = 0;
        return;
      }
      unresponsive += 1;
      // A gateway still in its bind retry doesn't serve yet; it gets the
      // whole ready window before it counts as hung.
      const binding = info?.binding === true && info.pid === pid;
      if (unresponsive >= (binding ? GATEWAY_BINDING_UNRESPONSIVE_CHECKS : GATEWAY_UNRESPONSIVE_CHECKS)) {
        await respawn(`gateway pid ${pid} unresponsive on ${GATEWAY_STATS_PATH}`, pid);
      }
    } finally {
      running = false;
    }
  };

  return {
    check,
    get gaveUp() {
      return gaveUp;
    },
    get foreign() {
      return foreign;
    },
    reset() {
      respawns.length = 0;
      unresponsive = 0;
      gaveUp = false;
      foreign = false;
    },
  };
}

export const CLASSIC_GATEWAY_STOP_TIMEOUT_MS = 15_000;
export const CLASSIC_GATEWAY_STOP_POLL_MS = 200;

export interface ClassicStopDeps extends Pick<GatewayDeps, "readInfo" | "isGateway" | "kill" | "sleep" | "now" | "log" | "appendLog"> {
  /** Whether nothing accepts connections on any of `ports` on GATEWAY_HOST. */
  portsFree(ports: PublicPorts): Promise<boolean>;
}

export type ClassicStopResult = "none" | "stopped" | "timeout";

/**
 * Classic mode binds the public ports itself, so a gateway of this install
 * still holding them (left by an earlier gateway-mode run) is SIGTERMed and
 * given CLASSIC_GATEWAY_STOP_TIMEOUT_MS to exit and free `ports`. A recorded
 * pid that isn't this install's gateway is never signalled.
 */
export async function stopGatewayForClassic(deps: ClassicStopDeps, ports: PublicPorts): Promise<ClassicStopResult> {
  const info = deps.readInfo();
  if (!info || !validPid(info.pid) || !deps.isGateway(info.pid)) return "none";
  const pid = info.pid;
  const start = `[dev] Classic mode: stopping gateway pid ${pid} so the classic services can bind the public ports`;
  deps.log(start);
  deps.appendLog(start);
  deps.kill(pid, "SIGTERM");
  const deadline = deps.now() + CLASSIC_GATEWAY_STOP_TIMEOUT_MS;
  const signalled = new Set([pid]);
  for (;;) {
    // A gateway stopped while still binding puts back the record of the one
    // it was replacing, which then holds the ports and is stopped too.
    const next = deps.readInfo()?.pid;
    if (validPid(next) && !signalled.has(next) && deps.isGateway(next)) {
      signalled.add(next);
      const msg = `[dev] Classic mode: stopping gateway pid ${next} too`;
      deps.log(msg);
      deps.appendLog(msg);
      deps.kill(next, "SIGTERM");
    }
    if ([...signalled].every((p) => !deps.isGateway(p)) && (await deps.portsFree(ports))) {
      deps.log(`[dev] Gateway pid ${pid} stopped; public ports are free`);
      return "stopped";
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(CLASSIC_GATEWAY_STOP_POLL_MS);
  }
  const msg = `[dev] Gateway pid ${pid} did not exit and free the public ports within ${CLASSIC_GATEWAY_STOP_TIMEOUT_MS / 1000}s — starting the classic services anyway; they may fail to bind`;
  deps.log(msg);
  deps.appendLog(msg);
  return "timeout";
}

/** Whether something accepts a TCP connection on `host:port` within `timeoutMs`. */
export function portAcceptsConnections(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (open: boolean): void => {
      socket.destroy();
      done(open);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Whether none of `ports` accepts connections on GATEWAY_HOST. */
export async function publicPortsFree(ports: PublicPorts): Promise<boolean> {
  const open = await Promise.all([ports.web, ports.collector, ports.ws].map((port) => portAcceptsConnections(GATEWAY_HOST, port)));
  return open.every((o) => !o);
}

/**
 * Crash-loop breaker for one supervised service: more than `max` exits within
 * `windowMs` trips it.
 */
export class CrashLoopBreaker {
  private exits: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an exit; false once the service has exited more than `max` times in the window. */
  recordExit(): boolean {
    const now = this.now();
    this.exits.push(now);
    while (this.exits.length > 0 && now - this.exits[0] > this.windowMs) this.exits.shift();
    return this.exits.length <= this.max;
  }

  /** Exits counted in the current window. */
  get recent(): number {
    return this.exits.length;
  }

  reset(): void {
    this.exits = [];
  }
}

/** A service dev.ts supervises, as the respawn signal sees it. */
export interface SupervisedService {
  name: string;
  breaker: CrashLoopBreaker;
  /** True once the breaker tripped and dev.ts stopped restarting it. */
  gaveUp: boolean;
  start(): void;
}

/**
 * DEV_RESPAWN_SIGNAL handling: resets every service's breaker and starts the
 * ones dev.ts gave up on. Services still running (or about to restart) are
 * left alone. Returns the names started.
 */
export function respawnGivenUp(services: readonly SupervisedService[]): string[] {
  const started: string[] = [];
  for (const service of services) {
    service.breaker.reset();
    if (!service.gaveUp) continue;
    service.gaveUp = false;
    service.start();
    started.push(service.name);
  }
  return started;
}

/** The absolute gateway CLI path of `root`, plus its realpath when that differs (a symlinked checkout). */
export function gatewayCliPaths(root: string): string[] {
  return cliPathsOf(gatewayCliPath(root));
}

/**
 * Whether `pid` is alive and its command line runs one of `cliPaths`. An
 * exited but unreaped gateway reads as alive here; the watchdog's stats probe
 * still catches it, since a zombie never answers.
 */
export function isInstallGateway(
  pid: number,
  cliPaths: readonly string[],
  commandLine: (pid: number) => string | undefined = commandLineOf,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  if (!validPid(pid) || !alive(pid)) return false;
  const cmdline = commandLine(pid);
  return cmdline !== undefined && runsCliPath(cmdline, cliPaths);
}

/**
 * Why this dev.ts must not start on `dataDir`, or undefined when it may: the
 * data dir's dev.json names a live dev.ts (not this process) of a different
 * install. Two installs on one data dir would fight over its collector lock
 * and gateway. A recorded pid whose command line isn't dev.ts was recycled by
 * another program and doesn't count; one whose command line can't be read
 * does, since starting beside a live dev.ts is the worse mistake.
 */
export function devOwnershipConflict(
  record: Partial<DevInfo> | undefined,
  own: { pid: number; installDir: string; dataDir: string },
  deps: { alive?: (pid: number) => boolean; commandLine?: (pid: number) => string | undefined } = {},
): string | undefined {
  if (!record || !validPid(record.pid) || record.pid === own.pid) return undefined;
  // Symlinks resolved: a checkout reached through a symlink is the same install.
  if (typeof record.installDir !== "string" || samePath(record.installDir, own.installDir)) return undefined;
  if (!(deps.alive ?? pidAlive)(record.pid)) return undefined;
  const cmdline = (deps.commandLine ?? commandLineOf)(record.pid);
  if (cmdline !== undefined && !runsDevScript(cmdline)) return undefined;
  return (
    `[dev] Refusing to start: data dir ${own.dataDir} belongs to another install's dev.ts ` +
    `(pid ${record.pid}, install dir ${resolve(record.installDir)}); this install is ${resolve(own.installDir)}. ` +
    "Stop that one first, or give this install its own data dir with DB_PATH (and its own STANDUP_WEB_PORT, COLLECTOR_PORT, WS_PORT, STANDUP_VITE_PORT)."
  );
}

/** `env` without GIT_* vars, so git resolves the repo from its -C dir, not an inherited GIT_DIR. */
export function stripGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_")) out[key] = value;
  }
  return out;
}

/** The commit checked out at `dir`, best-effort. */
export function gitHead(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const out = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", env: stripGitEnv(env), timeout: 5_000 });
    if (out.status !== 0) return undefined;
    const head = out.stdout.trim();
    return /^[0-9a-f]{7,64}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Absolute DB_PATH every child gets, so the gateway, both slots and vite agree
 * on the data dir. A relative DB_PATH is resolved against packages/collector,
 * the cwd the collector has always run in.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv, root: string): string {
  const dbPath = env.DB_PATH?.trim();
  return dbPath ? resolve(root, "packages", "collector", dbPath) : join(homedir(), ".local", "share", "standup", "standup.db");
}

export interface DetachedSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  /** Called with the child's exit code (null when a signal ended it). */
  onExit?: (pid: number, code: number | null) => void;
}

/** The node:child_process spawn signature spawnDetached relies on, injectable for tests. */
export type ChildSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: ["ignore", number, number] },
) => { pid?: number; unref(): void; once(event: "exit", listener: (code: number | null) => void): unknown };

/**
 * Spawns `cmd` in its own session and process group (detached: setsid), with
 * stdout/stderr appended to `logPath`, and unrefs it. The child is never
 * tracked by the caller, so neither dev.ts's signal handlers nor a terminal
 * Ctrl+C (delivered to the foreground process group) reach it.
 */
export function spawnDetached(cmd: string[], opts: DetachedSpawnOptions, spawnFn: ChildSpawn = spawnChild as unknown as ChildSpawn): number | undefined {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a", 0o600);
  try {
    const child = spawnFn(cmd[0], cmd.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", fd, fd] });
    const pid = child.pid;
    const onExit = opts.onExit;
    if (onExit && pid !== undefined) child.once("exit", (code) => onExit(pid, code));
    child.unref();
    return pid;
  } finally {
    closeSync(fd);
  }
}

/** Appends a timestamped line to `logPath`, best-effort. */
export function appendLogLine(logPath: string, message: string): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // best-effort: a failed log write must not take the watchdog down
  }
}

/** Fetches gateway stats from `url`, or undefined when nothing (or not a gateway) answers. */
export async function fetchGatewayStats(url: string, timeoutMs = 800): Promise<GatewayStats | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<GatewayStats>;
    return typeof body.pid === "number" ? (body as GatewayStats) : undefined;
  } catch {
    return undefined;
  }
}

export const gatewayCliPath = (root: string): string => join(root, "packages", "gateway", "src", "cli.ts");
const gatewayVersionModulePath = (root: string): string => join(root, "packages", "gateway", "src", "version.ts");

/**
 * Loads `gatewayVersion` from the gateway package, or undefined when the
 * gateway sources are absent. Resolved at run time so dev.ts still starts
 * (in classic mode) from a checkout without packages/gateway.
 */
export async function loadGatewayVersion(root: string): Promise<(() => string) | undefined> {
  const modulePath = gatewayVersionModulePath(root);
  if (!existsSync(modulePath) || !existsSync(gatewayCliPath(root))) return undefined;
  try {
    const mod = (await import(pathToFileURL(modulePath).href)) as { gatewayVersion?: () => string };
    if (typeof mod.gatewayVersion !== "function") return undefined;
    const version = mod.gatewayVersion;
    version();
    return version;
  } catch (err) {
    console.error(`[dev] Could not load the gateway version (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
}

/** Stats URL on the public collector port, on GATEWAY_HOST (which a gateway always binds). */
export function gatewayStatsUrl(collectorPort: number): string {
  return `http://${GATEWAY_HOST}:${collectorPort}${GATEWAY_STATS_PATH}`;
}
