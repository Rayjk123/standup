import { readFileSync } from "fs";
import { cpus, platform } from "os";
import { formatGb, type HostHeadroomView } from "@standup/shared";

/**
 * Host headroom: how many more worker sessions this machine can take right now.
 *
 * Every launched worker is a Claude Code process plus whatever it runs (test
 * suites, builds, subagents), all on the collector's own host. Past the host's
 * memory or CPU, the kernel starts killing processes and every worker's tmux
 * pane goes with them. So the launch path asks this module before spawning, a
 * launch the host has no room for waits in LaunchQueue instead of failing, and
 * heavy background jobs check `pressure()` and yield while the host is short.
 */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** One reading of the host. */
export interface HostMetrics {
  /** `MemAvailable` from /proc/meminfo: memory the kernel can hand out without swapping. */
  memAvailableBytes: number;
  /** `MemTotal` from /proc/meminfo: the host's usable RAM; absent where the platform gives none. */
  memTotalBytes?: number;
  /** 1-minute load average. */
  load1: number;
  cores: number;
}

/** Reads the host; null when the platform has no reading (headroom is then not enforced). */
export type HostMetricsProvider = () => HostMetrics | null;

export interface HeadroomThresholds {
  /** Memory kept free for the collector, the OS and the workers already running. */
  minFreeBytes: number;
  /** Memory each new worker is budgeted on top of the floor. */
  perWorkerBytes: number;
  /** 1-minute load per core above which no new work starts. */
  maxLoadPerCore: number;
  /**
   * How long a just-started worker is counted against headroom: a fresh worker
   * has not grown to its working size yet, so the next reading would otherwise
   * see room it does not have and admit a burst.
   */
  warmupMs: number;
}

export const DEFAULT_HEADROOM_THRESHOLDS: HeadroomThresholds = {
  minFreeBytes: 2 * GiB,
  perWorkerBytes: 1.5 * GiB,
  maxLoadPerCore: 1,
  warmupMs: 120_000,
};

function positiveNumber(raw: string | undefined): number | undefined {
  const n = Number.parseFloat(raw?.trim() ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Thresholds from the environment, each falling back to its default:
 * `STANDUP_HOST_MIN_FREE_MB`, `STANDUP_HOST_WORKER_MB`,
 * `STANDUP_HOST_MAX_LOAD_PER_CORE`, `STANDUP_HOST_WARMUP_S`.
 */
export function resolveHeadroomThresholds(env: NodeJS.ProcessEnv = process.env): HeadroomThresholds {
  const d = DEFAULT_HEADROOM_THRESHOLDS;
  const mb = (raw: string | undefined, fallback: number) => {
    const n = positiveNumber(raw);
    return n === undefined ? fallback : n * MiB;
  };
  const warmupS = positiveNumber(env.STANDUP_HOST_WARMUP_S);
  return {
    minFreeBytes: mb(env.STANDUP_HOST_MIN_FREE_MB, d.minFreeBytes),
    perWorkerBytes: mb(env.STANDUP_HOST_WORKER_MB, d.perWorkerBytes),
    maxLoadPerCore: positiveNumber(env.STANDUP_HOST_MAX_LOAD_PER_CORE) ?? d.maxLoadPerCore,
    warmupMs: warmupS === undefined ? d.warmupMs : warmupS * 1000,
  };
}

/** Parses one kB field (`MemTotal`, `SwapFree`, …) out of /proc/meminfo text, in bytes; null when absent. */
export function parseMeminfoField(meminfo: string, field: string): number | null {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s*kB`, "m").exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/** Parses `MemAvailable` (kB) out of /proc/meminfo text; null when absent. */
export function parseMemAvailable(meminfo: string): number | null {
  return parseMeminfoField(meminfo, "MemAvailable");
}

/** Parses `MemTotal` (kB) out of /proc/meminfo text; null when absent. */
export function parseMemTotal(meminfo: string): number | null {
  return parseMeminfoField(meminfo, "MemTotal");
}

/** Parses the 1-minute load out of /proc/loadavg text; null when malformed. */
export function parseLoad1(loadavg: string): number | null {
  const n = Number.parseFloat(loadavg.trim().split(/\s+/)[0] ?? "");
  return Number.isFinite(n) ? n : null;
}

/** The Linux reading (/proc/meminfo, /proc/loadavg, os.cpus()); null elsewhere or on a read error. */
export function readLinuxHostMetrics(): HostMetrics | null {
  if (platform() !== "linux") return null;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const memAvailableBytes = parseMemAvailable(meminfo);
    const memTotalBytes = parseMemTotal(meminfo);
    const load1 = parseLoad1(readFileSync("/proc/loadavg", "utf8"));
    if (memAvailableBytes === null || load1 === null) return null;
    return {
      memAvailableBytes,
      ...(memTotalBytes === null ? {} : { memTotalBytes }),
      load1,
      cores: Math.max(1, cpus().length),
    };
  } catch {
    return null;
  }
}

/** What the host can take right now. */
export interface Headroom {
  metrics: HostMetrics | null;
  /** New workers the host has room for now; Infinity when headroom is not enforced. */
  slots: number;
  /** Why no new work fits, in plain words; null while it does. */
  shortReason: string | null;
}

function formatLoad(load: number): string {
  return load.toFixed(1);
}

/**
 * The host's room for new workers. Busy CPU (1-minute load above
 * cores × maxLoadPerCore) or memory under the floor admit none; otherwise each
 * perWorkerBytes above the floor is one slot, less the workers still warming up.
 */
export function assessHeadroom(
  metrics: HostMetrics | null,
  t: HeadroomThresholds,
  warmingUp = 0
): Headroom {
  if (!metrics) return { metrics, slots: Infinity, shortReason: null };
  const loadCap = metrics.cores * t.maxLoadPerCore;
  if (metrics.load1 > loadCap) {
    return {
      metrics,
      slots: 0,
      shortReason: `the CPU is busy (load ${formatLoad(metrics.load1)} on ${metrics.cores} cores, limit ${formatLoad(loadCap)})`,
    };
  }
  if (metrics.memAvailableBytes < t.minFreeBytes) {
    return {
      metrics,
      slots: 0,
      shortReason: `memory is low (${formatGb(metrics.memAvailableBytes)} free, ${formatGb(t.minFreeBytes)} is kept in reserve)`,
    };
  }
  const fit = Math.floor((metrics.memAvailableBytes - t.minFreeBytes) / t.perWorkerBytes);
  const slots = Math.max(0, fit - warmingUp);
  if (slots > 0) return { metrics, slots, shortReason: null };
  const room = `${formatGb(metrics.memAvailableBytes)} free leaves no room for another worker (each needs about ${formatGb(t.perWorkerBytes)} on top of ${formatGb(t.minFreeBytes)} in reserve)`;
  return {
    metrics,
    slots: 0,
    shortReason:
      fit > 0
        ? `${warmingUp} worker${warmingUp === 1 ? "" : "s"} just started and ${warmingUp === 1 ? "is" : "are"} still claiming memory; ${formatGb(metrics.memAvailableBytes)} free`
        : room,
  };
}

/** The active-worker cap after the host's headroom: never above the configured cap. */
export function effectiveCap(
  configured: number,
  running: number,
  headroom: Headroom
): { cap: number; hostLimited: boolean } {
  const cap = Math.min(configured, running + headroom.slots);
  return { cap, hostLimited: cap < configured };
}

/**
 * The console's and Persona's view of the host for a cap of `configured`
 * workers: `active` launches of which `queued` are still waiting for room.
 */
export function hostHeadroomView(
  configured: number,
  active: number,
  queued: number,
  monitor: HostMonitor = hostMonitor
): HostHeadroomView {
  const headroom = monitor.headroom();
  const { cap, hostLimited } = effectiveCap(configured, Math.max(0, active - queued), headroom);
  return {
    effectiveMaxActive: cap,
    hostLimited,
    ...(headroom.metrics
      ? {
          memAvailableBytes: headroom.metrics.memAvailableBytes,
          ...(headroom.metrics.memTotalBytes === undefined ? {} : { memTotalBytes: headroom.metrics.memTotalBytes }),
          load1: headroom.metrics.load1,
          cores: headroom.metrics.cores,
        }
      : {}),
    queued,
  };
}

export interface HostMonitorOptions {
  provider?: HostMetricsProvider;
  thresholds?: HeadroomThresholds;
  now?: () => number;
  /** False turns headroom off: every reading is treated as unknown. */
  enabled?: boolean;
}

/** The host reading plus warm-up accounting for workers started recently. */
export class HostMonitor {
  private provider: HostMetricsProvider;
  private thresholdsValue: HeadroomThresholds;
  private now: () => number;
  private enabled: boolean;
  private starts: number[] = [];

  constructor(opts: HostMonitorOptions = {}) {
    this.provider = opts.provider ?? readLinuxHostMetrics;
    this.thresholdsValue = opts.thresholds ?? DEFAULT_HEADROOM_THRESHOLDS;
    this.now = opts.now ?? Date.now;
    this.enabled = opts.enabled ?? true;
  }

  /** Replaces any of the monitor's inputs; the warm-up record is cleared. */
  configure(opts: HostMonitorOptions): void {
    if (opts.provider) this.provider = opts.provider;
    if (opts.thresholds) this.thresholdsValue = opts.thresholds;
    if (opts.now) this.now = opts.now;
    if (opts.enabled !== undefined) this.enabled = opts.enabled;
    this.starts = [];
  }

  get thresholds(): HeadroomThresholds {
    return this.thresholdsValue;
  }

  metrics(): HostMetrics | null {
    return this.enabled ? this.provider() : null;
  }

  /** Records a worker spawn, counted against headroom for the warm-up window. */
  noteStart(): void {
    this.starts.push(this.now());
  }

  private warmingUp(): number {
    const since = this.now() - this.thresholdsValue.warmupMs;
    this.starts = this.starts.filter((t) => t > since);
    return this.starts.length;
  }

  headroom(): Headroom {
    return assessHeadroom(this.metrics(), this.thresholdsValue, this.warmingUp());
  }

  /**
   * Why heavy background work should wait, or null when the host is fine. Only
   * the hard floors count here (busy CPU, memory under the reserve), not the
   * per-worker slots: a batch job is not a worker and holds no worker budget.
   */
  pressure(): string | null {
    const m = this.metrics();
    if (!m) return null;
    const t = this.thresholdsValue;
    if (m.load1 <= m.cores * t.maxLoadPerCore && m.memAvailableBytes >= t.minFreeBytes) return null;
    return assessHeadroom(m, t).shortReason;
  }
}

/**
 * The collector's host monitor. `STANDUP_HOST_HEADROOM=0` turns enforcement
 * off; so does `bun test` (NODE_ENV=test), so a suite never queues launches or
 * defers jobs on the load of the machine running it. Tests that exercise
 * headroom configure it with an injected provider.
 */
export const hostMonitor = new HostMonitor({
  thresholds: resolveHeadroomThresholds(),
  enabled: process.env.STANDUP_HOST_HEADROOM?.trim() !== "0" && process.env.NODE_ENV !== "test",
});

// Heavy background jobs log their first deferral per stretch of pressure, not every tick.
const deferredJobs = new Set<string>();

/**
 * True when `job` should skip this run because the host is short on headroom;
 * logs once when a stretch of pressure begins for that job and once when it ends.
 */
export function deferForHostPressure(job: string, monitor: HostMonitor = hostMonitor): boolean {
  const reason = monitor.pressure();
  if (reason) {
    if (!deferredJobs.has(job)) console.log(`[${job}] deferred: ${reason}`);
    deferredJobs.add(job);
    return true;
  }
  if (deferredJobs.delete(job)) console.log(`[${job}] host headroom is back; resuming`);
  return false;
}

/** A launch waiting for host headroom. */
export interface QueuedLaunchInfo {
  launchId: string;
  /** Why it waited, as it was when the launch was queued. */
  reason: string;
  /** Launches ahead of it in the queue. */
  ahead: number;
  queuedAt: number;
}

interface QueueEntry {
  launchId: string;
  reason: string;
  queuedAt: number;
  release: (start: boolean) => void;
}

/** A queued launch's handle: `ready` resolves true when it may start, false when it was dropped. */
export interface QueueTicket {
  ready: Promise<boolean>;
  reason: string;
  ahead: number;
}

/**
 * Launches waiting for host headroom, started first-in first-out by `drain`
 * (called from the collector's maintenance tick). A launch only skips the queue
 * when the queue is empty and the host has a slot, so a later launch never
 * jumps an earlier one.
 */
export class LaunchQueue {
  private entries: QueueEntry[] = [];

  constructor(private monitor: HostMonitor = hostMonitor) {}

  /** Null when the launch may start now (counted as started); otherwise its queue ticket. */
  admit(launchId: string): QueueTicket | null {
    const headroom = this.monitor.headroom();
    if (this.entries.length === 0 && headroom.slots >= 1) {
      this.monitor.noteStart();
      return null;
    }
    const ahead = this.entries.length;
    const reason =
      headroom.shortReason ??
      `${ahead} earlier launch${ahead === 1 ? " is" : "es are"} already waiting for room`;
    let release!: (start: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    this.entries.push({ launchId, reason, queuedAt: Date.now(), release });
    return { ready, reason, ahead };
  }

  /**
   * Starts queued launches, oldest first, while the host has slots. A launch
   * `isLive` no longer recognizes (stopped or failed meanwhile) is dropped
   * without taking a slot. Returns the ids it started.
   */
  drain(isLive: (launchId: string) => boolean = () => true): string[] {
    const started: string[] = [];
    while (this.entries.length > 0) {
      const head = this.entries[0]!;
      if (!isLive(head.launchId)) {
        this.entries.shift();
        head.release(false);
        continue;
      }
      if (this.monitor.headroom().slots < 1) break;
      this.entries.shift();
      this.monitor.noteStart();
      head.release(true);
      started.push(head.launchId);
    }
    return started;
  }

  /** Drops a queued launch so it never starts; false when it was not queued. */
  cancel(launchId: string): boolean {
    const i = this.entries.findIndex((e) => e.launchId === launchId);
    if (i < 0) return false;
    const [entry] = this.entries.splice(i, 1);
    entry!.release(false);
    return true;
  }

  describe(launchId: string): QueuedLaunchInfo | null {
    const i = this.entries.findIndex((e) => e.launchId === launchId);
    if (i < 0) return null;
    const e = this.entries[i]!;
    return { launchId, reason: e.reason, ahead: i, queuedAt: e.queuedAt };
  }

  get size(): number {
    return this.entries.length;
  }
}

/** The collector's launch queue. */
export const launchQueue = new LaunchQueue(hostMonitor);

/**
 * The plain-words note for a queued launch, e.g. "Queued, not started: memory
 * is low (1.4 GB free, 2.0 GB is kept in reserve). It starts on its own, in
 * order, when the host has room; 1 launch is ahead of it."
 */
export function queuedLaunchNote(info: Pick<QueuedLaunchInfo, "reason" | "ahead">): string {
  const ahead =
    info.ahead === 0
      ? "it is next in line"
      : `${info.ahead} launch${info.ahead === 1 ? " is" : "es are"} ahead of it`;
  return `Queued, not started: ${info.reason}. It starts on its own, in order, when the host has room; ${ahead}.`;
}
