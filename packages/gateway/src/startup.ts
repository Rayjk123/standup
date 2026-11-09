/**
 * What the gateway CLI decides before and while binding the public ports.
 *
 * Listeners never share a port (no SO_REUSEPORT), so a gateway can only bind
 * once whatever holds the ports has let go. Before binding, the CLI asks
 * whatever answers GATEWAY_STATS_PATH on the public collector and ws ports
 * who it is. A gateway of this install (its command line runs this install's
 * CLI, see retire.ts) is retired: SIGTERMed, after which it stops listening at
 * once while the new one retries its bind every few milliseconds. Any other
 * gateway, whichever data dir it serves, belongs to another install and is
 * never signalled: this one refuses to start.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pidAlive, validPid } from "@standup/shared/process-identity";
import {
  GATEWAY_STATS_PATH,
  readJsonFile,
  restartRecordPath,
  standbyDirPath,
  standbyFilePath,
  type GatewayStats,
} from "@standup/shared/topology";

/** How long startup keeps retrying a bind that fails with EADDRINUSE. */
export const DEFAULT_BIND_RETRY_MS = 30_000;
/**
 * The bind retry interval right after a retirement. The retired gateway stops
 * listening as soon as it handles SIGTERM, so the public ports go unserved for
 * at most about this long during a self-update.
 */
export const FAST_BIND_RETRY_MS = 20;
/** How long the fast retry interval lasts before the retry backs off. */
export const FAST_BIND_PHASE_MS = 2_000;

export type PortProbe =
  | { port: number; kind: "none" }
  | { port: number; kind: "other" }
  | { port: number; kind: "gateway"; stats: GatewayStats };

function isGatewayStats(value: unknown): value is GatewayStats {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === "number" && typeof v.version === "string" && typeof v.startedAt === "string";
}

/** Asks `host:port` for gateway stats: `none` when nothing usable answers, `other` when a non-gateway does. */
export async function probeGateway(host: string, port: number, timeoutMs = 1000): Promise<PortProbe> {
  let res: Response;
  try {
    res = await fetch(`http://${host}:${port}${GATEWAY_STATS_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      keepalive: false,
    });
  } catch {
    return { port, kind: "none" };
  }
  try {
    const body: unknown = res.ok ? await res.json() : undefined;
    if (!res.ok) await res.body?.cancel().catch(() => {});
    return isGatewayStats(body) ? { port, kind: "gateway", stats: body } : { port, kind: "other" };
  } catch {
    return { port, kind: "other" };
  }
}

/** `retire`: gateways of this install found on the ports, to SIGTERM before binding. */
export type BindDecision = { proceed: true; retire: number[] } | { proceed: false; reason: string };

/** The env vars that move an install's public and vite ports, named when two installs collide. */
export const PORT_ENV_HINT = "STANDUP_WEB_PORT, COLLECTOR_PORT, WS_PORT and STANDUP_VITE_PORT";

/**
 * Whether this gateway may take the ports from whatever the probes found. A
 * gateway `ours` accepts (this install's own CLI, see retire.ts
 * isRetirableOwnGateway) is listed in `retire`. Any other gateway is another
 * install's, even one serving this same data dir, and is refused: it is never
 * retired. Anything that isn't a gateway is left to the bind and its retry.
 */
export function bindDecision(
  probes: readonly PortProbe[],
  dataDir: string,
  ours: (stats: GatewayStats) => boolean,
  selfPid: number = process.pid,
): BindDecision {
  const own = resolve(dataDir);
  const retire: number[] = [];
  for (const probe of probes) {
    if (probe.kind !== "gateway") continue;
    const { pid, dataDir: theirs } = probe.stats;
    if (pid === selfPid) continue;
    if (ours(probe.stats)) {
      if (!retire.includes(pid)) retire.push(pid);
      continue;
    }
    const where = theirs === undefined ? "reports no data dir" : resolve(theirs) === own ? `serves this data dir (${own})` : `serves data dir ${resolve(theirs)}`;
    return {
      proceed: false,
      reason:
        `port ${probe.port} is served by gateway pid ${pid}, which ${where} but is not this install's gateway ` +
        `(its command line doesn't run this install's gateway CLI); refusing to replace it. ` +
        `Stop it, or give one install its own DB_PATH and distinct ${PORT_ENV_HINT}`,
    };
  }
  return { proceed: true, retire };
}

/** Whether a bind failed because another socket holds the address. */
export function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "EADDRINUSE") return true;
  return typeof e?.message === "string" && /EADDRINUSE|address already in use|port \d+ in use/i.test(e.message);
}

export interface BindRetryOptions {
  /** Give up once this long has passed since the first attempt. */
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /**
   * For this long from the first attempt, retry every `initialDelayMs`
   * without backing off. Default 0.
   */
  fastPhaseMs?: number;
  /** Called before each wait with the error and the delay about to be slept. */
  onRetry?: (err: unknown, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Runs `bind`, retrying while it fails with EADDRINUSE: every
 * `initialDelayMs` during `fastPhaseMs`, then with exponential backoff, so a
 * bind that races the process it replaces (a retired gateway, or a
 * classic-mode vite or collector still exiting) waits for the port instead of
 * failing at once. Any other error, or EADDRINUSE past `timeoutMs`, is thrown.
 */
export async function bindWithRetry<T>(bind: () => T | Promise<T>, opts: BindRetryOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BIND_RETRY_MS;
  const maxDelayMs = opts.maxDelayMs ?? 2000;
  const fastPhaseMs = opts.fastPhaseMs ?? 0;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts.now ?? Date.now;
  const start = now();
  const initialDelay = opts.initialDelayMs ?? 250;
  let delay = initialDelay;
  for (;;) {
    try {
      return await bind();
    } catch (err) {
      const at = now();
      const left = start + timeoutMs - at;
      if (!isAddrInUse(err) || left <= 0) throw err;
      const fast = at - start < fastPhaseMs;
      const wait = Math.min(fast ? initialDelay : delay, left);
      opts.onRetry?.(err, wait);
      await sleep(wait);
      if (!fast) delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/** How long the gateway outlives its dev.ts with no collector leader before it exits. */
export const DEFAULT_ORPHAN_EXIT_MS = 8_000;

/**
 * How recently a restart record must have been updated to count as a restart
 * in progress. A supervisor rewrites the record at every phase; one silent
 * for longer than this died without finishing it.
 */
export const RESTART_ACTIVE_WINDOW_MS = 30 * 60_000;

export interface RestartActivityDeps {
  /** The parsed restart record (restartRecordPath); default reads the data dir. */
  readRecord?: (dataDir: string) => { phase?: unknown; updatedAt?: unknown } | undefined;
  /** The pids of the data dir's standby records (collector-standby.json and standby/<pid>.json). */
  standbyPids?: (dataDir: string) => number[];
  alive?: (pid: number) => boolean;
  now?: () => number;
}

/** The pids recorded in `dataDir`'s collector-standby.json and standby/*.json. */
export function recordedStandbyPids(dataDir: string): number[] {
  const pids: number[] = [];
  const add = (pid: unknown) => {
    if (validPid(pid) && !pids.includes(pid)) pids.push(pid);
  };
  add(readJsonFile<{ pid?: unknown }>(standbyFilePath(dataDir))?.pid);
  let names: string[] = [];
  try {
    names = readdirSync(standbyDirPath(dataDir));
  } catch {
    // No standby dir: no per-pid markers.
  }
  for (const name of names) {
    if (name.endsWith(".json")) add(readJsonFile<{ pid?: unknown }>(join(standbyDirPath(dataDir), name))?.pid);
  }
  return pids;
}

/**
 * What, besides dev.ts, may still bring a collector up behind the gateway,
 * or undefined when nothing does: a restart in progress (its record's phase
 * isn't `done` and it was updated within RESTART_ACTIVE_WINDOW_MS; a
 * supervisor rolling back with dev.ts gone starts a collector itself), or a
 * live collector waiting as a standby.
 */
export function restartActivity(dataDir: string, deps: RestartActivityDeps = {}): string | undefined {
  const record = (deps.readRecord ?? ((dir: string) => readJsonFile<{ phase?: unknown; updatedAt?: unknown }>(restartRecordPath(dir))))(dataDir);
  if (record && typeof record.phase === "string" && record.phase !== "done" && typeof record.updatedAt === "string") {
    const updatedAt = Date.parse(record.updatedAt);
    if (Number.isFinite(updatedAt) && (deps.now ?? Date.now)() - updatedAt <= RESTART_ACTIVE_WINDOW_MS) {
      return `a restart is in progress (phase ${record.phase})`;
    }
  }
  const alive = deps.alive ?? pidAlive;
  const standby = (deps.standbyPids ?? recordedStandbyPids)(dataDir).find((pid) => alive(pid));
  return standby === undefined ? undefined : `standby collector pid ${standby} is waiting`;
}

/**
 * Decides when a gateway is orphaned: the dev.ts recorded in dev.json has
 * been gone, and no collector leader has validated, both for `graceMs`. Then
 * nothing will come back to serve behind it (e.g. the install was rolled back
 * to a dev.ts without gateway mode, whose own services need the public ports),
 * so it should exit and free them. A dev.ts restart rewrites dev.json within
 * about a second, which resets the clock.
 */
export class OrphanWatch {
  private devGoneSince: number | undefined;

  constructor(private readonly graceMs: number) {}

  /**
   * Records one observation; true once the gateway should exit. While
   * `restartActive` (see restartActivity) a collector may still come up
   * without dev.ts, so the gateway is not orphaned and the clock restarts
   * once the activity ends.
   */
  observe(state: { devAlive: boolean; restartActive?: boolean; lastLeaderValidAt: number; now: number }): boolean {
    if (state.devAlive || state.restartActive) {
      this.devGoneSince = undefined;
      return false;
    }
    this.devGoneSince ??= state.now;
    return state.now - this.devGoneSince >= this.graceMs && state.now - state.lastLeaderValidAt >= this.graceMs;
  }
}
