/**
 * The zero-downtime topology shared by the gateway, dev.ts, the collector and
 * the restart supervisor: which ports each process binds, and the files a
 * collector leader, a waiting standby and the gateway publish under the data
 * dir. A restart hands the public ports' traffic from one collector to the
 * next through the gateway, so a client never sees a refused connection.
 *
 * Node-only (fs/os/path) — imported through the `@standup/shared/topology`
 * subpath so the browser bundle never pulls it in.
 *
 * Self-contained, with no relative imports: vite's config loads this file
 * through Node, which does not map a `./x.js` specifier onto `x.ts` the way
 * Bun does (owner-token.ts is self-contained for the same reason).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Same values as constants.ts's DEFAULT_COLLECTOR_PORT / DEFAULT_WS_PORT (a test pins them). */
const DEFAULT_COLLECTOR_PORT = 7777;
const DEFAULT_WS_PORT = 7778;

export type CollectorSlot = "a" | "b";
export const COLLECTOR_SLOTS: readonly CollectorSlot[] = ["a", "b"];

export const DEFAULT_WEB_PORT = 5173;

/** How far vite's own port sits from the public web port in gateway mode. */
export const VITE_PORT_OFFSET = 10_000;

/**
 * Vite's own port in gateway mode when STANDUP_VITE_PORT is unset: the public
 * web port + VITE_PORT_OFFSET (5173 → 15173), so an install on another web
 * port gets its own vite port too. It is far from the web port on purpose:
 * any other vite on the host that finds 5173 taken hops to 5174, 5175, …, and
 * would take a vite port next to the web port before Standup's strict vite
 * could bind it. A web port too high for the offset uses it downwards.
 */
export function vitePortFor(webPort: number): number {
  return webPort + VITE_PORT_OFFSET <= 65_535 ? webPort + VITE_PORT_OFFSET : webPort - VITE_PORT_OFFSET;
}

export const DEFAULT_VITE_PORT = vitePortFor(DEFAULT_WEB_PORT);

/** Header a draining collector sets on the 503s it answers while shutting down. */
export const DRAINING_HEADER = "x-standup-draining";
/** The request was never processed: safe for the gateway to retry elsewhere. */
export const DRAINING_REFUSED = "refused";
/** A long-poll was released mid-wait: passed through, the client re-attaches by request id. */
export const DRAINING_RELEASED = "released";
/** WebSocket close code a collector or gateway uses when it goes away for a restart. */
export const WS_CLOSE_SERVICE_RESTART = 1012;

/**
 * Path of the gateway's stats endpoint. The collector and ws listeners answer
 * it for any loopback peer; the web listener (which a tunnel reaches) never
 * does and proxies the path to vite like any other.
 */
export const GATEWAY_STATS_PATH = "/__gateway/stats";

/** Gateway exit code: binding the public ports kept failing (EADDRINUSE past the retry window). */
export const EXIT_BIND_FAILED = 1;
/**
 * Gateway exit code: another install's gateway serves the public ports (for
 * another data dir, or for this one from a different install dir). Respawning
 * cannot help while it serves.
 */
export const EXIT_FOREIGN_GATEWAY = 3;

/** Response header naming why the gateway answered a request itself instead of an upstream. */
export const GATEWAY_REASON_HEADER = "x-standup-gateway";
/** The values of GATEWAY_REASON_HEADER. */
export const GATEWAY_REASON = {
  /** No collector leader has validated for the hold time: answered at once, not held. */
  noLeader: "no-leader",
  /** Held for the whole hold time without an upstream. */
  holdTimeout: "hold-timeout",
  /** The held-request cap was reached. */
  heldCap: "held-cap",
  /** The request ended while held (the client left or the gateway is stopping). */
  aborted: "aborted",
  /** The request body is over the per-request cap. */
  bodyCap: "body-cap",
  /** The total buffered-body cap was reached. */
  bufferCap: "buffer-cap",
  /** The client's body stream failed. */
  bodyAborted: "body-aborted",
  /** The upstream failed after the request was sent; never retried. */
  upstreamReset: "upstream-reset",
  /** The upstream answered a WebSocket handshake with something other than 101. */
  wsRejected: "ws-rejected",
  /** The client's WebSocket upgrade failed after the upstream opened. */
  upgradeFailed: "upgrade-failed",
  /** The stats endpoint was asked by a non-loopback peer. */
  statsForbidden: "stats-forbidden",
  /** The gateway's own handler threw. */
  internal: "internal",
} as const;
export type GatewayReason = (typeof GATEWAY_REASON)[keyof typeof GATEWAY_REASON];

/** The ports a collector slot binds: slot a at public+10000, slot b at public+20000. */
export function slotPorts(publicHttp: number, publicWs: number, slot: CollectorSlot): { http: number; ws: number } {
  const offset = slot === "a" ? 10_000 : 20_000;
  return { http: publicHttp + offset, ws: publicWs + offset };
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface PublicPorts {
  web: number;
  collector: number;
  ws: number;
}

/** The public ports: STANDUP_WEB_PORT, COLLECTOR_PORT, WS_PORT. */
export function publicPorts(env: NodeJS.ProcessEnv = process.env): PublicPorts {
  return {
    web: intEnv(env.STANDUP_WEB_PORT, DEFAULT_WEB_PORT),
    collector: intEnv(env.COLLECTOR_PORT, DEFAULT_COLLECTOR_PORT),
    ws: intEnv(env.WS_PORT, DEFAULT_WS_PORT),
  };
}

/** Vite's own port in gateway mode: STANDUP_VITE_PORT, else vitePortFor the public web port. */
export function vitePortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.STANDUP_VITE_PORT, vitePortFor(publicPorts(env).web));
}

/**
 * Every port that reaches a collector: the public collector and WS ports
 * (the defaults and any configured in `env`) and both slots' HTTP and WS
 * ports derived from each. Classifiers that recognize traffic to the
 * collector match against this set, so a slot port is held exactly like the
 * public port it stands behind.
 */
export function collectorPortSet(env: NodeJS.ProcessEnv = process.env): ReadonlySet<number> {
  const ports = new Set<number>();
  for (const { collector, ws } of [publicPorts({}), publicPorts(env)]) {
    ports.add(collector);
    ports.add(ws);
    for (const slot of COLLECTOR_SLOTS) {
      const bound = slotPorts(collector, ws, slot);
      ports.add(bound.http);
      ports.add(bound.ws);
    }
  }
  return ports;
}

/**
 * Env vars that tell a collector process which slot it is and which ports it
 * binds. They describe the collector itself, so processes it launches for
 * workers never inherit them.
 */
export const SLOT_ENV_VARS = ["STANDUP_LISTEN_PORT", "STANDUP_LISTEN_WS_PORT", "STANDUP_COLLECTOR_SLOT"] as const;

/** The one address the collector slots and vite bind, and the gateway dials, in gateway mode. */
export const GATEWAY_HOST = "127.0.0.1";
/**
 * The gateway also binds this address on each public port, when the host has
 * an IPv6 loopback: clients that resolve `localhost` to ::1 first reach the
 * gateway there, rather than whatever else could bind [::1] on the port.
 */
export const GATEWAY_HOST_IPV6 = "::1";

/**
 * Whether gateway mode is on: STANDUP_GATEWAY isn't "0" and the bind host is
 * unset or GATEWAY_HOST. Any other bind host, loopback or not, keeps the
 * classic topology, so the gateway and the processes behind it never disagree
 * on an address.
 */
export function gatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STANDUP_GATEWAY === "0") return false;
  const host = env.STANDUP_BIND_HOST?.trim();
  return !host || host === GATEWAY_HOST;
}

/** The collector's data dir: the directory of its SQLite file (DB_PATH, else ~/.local/share/standup/standup.db). */
export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dbPath = env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db");
  return dirname(dbPath);
}

export const leaderLockPath = (dataDir: string): string => join(dataDir, "collector.leader.lock");
export const leaderFilePath = (dataDir: string): string => join(dataDir, "collector-leader.json");
export const standbyFilePath = (dataDir: string): string => join(dataDir, "collector-standby.json");
/**
 * Per-pid standby markers: `<pid>.json` (StandbyInfo) for every collector of
 * this data dir waiting on the lock, each removed by its own process when it
 * takes the lock or exits. A restart's standby refresh stops exactly these.
 */
export const standbyDirPath = (dataDir: string): string => join(dataDir, "standby");
export const gatewayDir = (dataDir: string): string => join(dataDir, "gateway");
export const gatewayFilePath = (dataDir: string): string => join(gatewayDir(dataDir), "gateway.json");
export const gatewayLogPath = (dataDir: string): string => join(gatewayDir(dataDir), "gateway.log");
export const devFilePath = (dataDir: string): string => join(dataDir, "dev.json");
/** The latest restart's record, written by the collector that asked for it and its restart supervisor. */
export const restartRecordPath = (dataDir: string): string => join(dataDir, "restart", "current.json");

/**
 * Written by dev.ts as soon as it starts. `head` is the commit dev.ts and the
 * gateway it ensured were loaded from, which the redeploy compares against to
 * decide whether a change needs a full restart. `installDir` is the install
 * that owns the data dir: a dev.ts from another install refuses to start
 * while this one lives, and a gateway exits once this dev.ts is gone and no
 * collector leads for its orphan window (STANDUP_GATEWAY_ORPHAN_EXIT_MS).
 */
export interface DevInfo {
  pid: number;
  head?: string;
  startedAt: string;
  installDir: string;
  gateway: boolean;
}

/**
 * Signal dev.ts handles by resetting every service's crash-loop breaker and
 * respawning the ones it gave up on, so a slot that crash-looped on bad code
 * comes back once the code on disk is fixed (e.g. after a rollback).
 */
export const DEV_RESPAWN_SIGNAL = "SIGUSR2";

/** Written by a collector right after it acquires the leader lock. */
export interface LeaderInfo {
  pid: number;
  slot?: CollectorSlot;
  httpPort: number;
  wsPort: number;
  /** Random per leadership term; the WS replay cursor is only valid within one epoch. */
  epoch: string;
  acquiredAt: string;
  installDir: string;
  /** The commit this process's code was loaded from, read when the process started, not when it took the lock. */
  head?: string;
  /**
   * Set while the leader, holding the lock but not yet listening, copies the
   * database before a pending migration or applies migrations: on a large
   * database these outlast a restart's boot timeout, so a restart keeps
   * waiting on a live leader in one (supervisor.ts waitCollector).
   */
  bootPhase?: LeaderBootPhase;
  /** When bootPhase was set. */
  bootPhaseAt?: string;
}

/** What a leader that holds the lock is doing before it listens (LeaderInfo.bootPhase). */
export type LeaderBootPhase = "pre-migrate-backup" | "migrating";

/** Written by a collector while it waits for the leader lock with its code loaded. */
export interface StandbyInfo {
  pid: number;
  slot?: CollectorSlot;
  startedAt: string;
  installDir: string;
  /** The commit this process's code was loaded from, read when the process started. */
  head?: string;
}

export interface GatewayInfo {
  pid: number;
  version: string;
  ports: PublicPorts;
  startedAt: string;
  /** The data dir whose collector leader this gateway routes to. */
  dataDir?: string;
  /**
   * True while the gateway is still trying to bind the ports (its bind retry
   * can take ~30s): the pid is a live gateway that doesn't serve yet. Cleared
   * once it listens.
   */
  binding?: boolean;
}

/** Cumulative gateway counters, served at GATEWAY_STATS_PATH. */
export interface GatewayStats {
  pid: number;
  version: string;
  startedAt: string;
  /** The data dir whose collector leader this gateway routes to. */
  dataDir?: string;
  /** Requests that had to wait for an upstream at least once. */
  held: number;
  /** Requests waiting right now. */
  heldNow: number;
  /** Longest single wait, ms. */
  maxHoldMs: number;
  /** Requests the gateway itself failed (hold timeout, cap, upstream reset after sending). */
  failed: number;
  /** Upstream attempts retried (connection refused or a `refused` 503). */
  retried: number;
  /** Proxied WebSocket connections the upstream closed. */
  wsUpstreamCloses: number;
  /**
   * Proxied WebSocket client legs the gateway tore down for sending nothing
   * (no frame, no pong) past its idle limit. Absent from a gateway build that
   * doesn't track it; a long-lived gateway may be older than its reader.
   */
  wsClientIdleCloses?: number;
  upstream: { collector?: number; ws?: number; web?: number };
}

/** Writes `value` as JSON to `path` atomically (temp file, then rename). */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Parsed JSON at `path`, or undefined when missing or unreadable. */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
