import { spawn as spawnChild, spawnSync } from "child_process";
import { closeSync, mkdirSync, openSync } from "fs";
import { createConnection, createServer } from "net";
import { hostname, uptime, userInfo } from "os";
import { join } from "path";
import { killProcessGroup } from "../drain.js";
import { scrubCredentialEnv, scrubSecretEnv } from "../owner-secret.js";
import { activeTunnelProvider, type ListedTunnel, type TunnelProvider } from "../tunnels/provider.js";

export type { ListedTunnel } from "../tunnels/provider.js";

/**
 * The host effects review tunnels need, injectable so a test opens and closes
 * tunnels without real processes, ports or the tunnel service.
 */
export interface ReviewTunnelSystem {
  /** The user the tunnel provider's CLI prefixes names with. */
  hostUser: string;
  hostname: string;
  /** The tunnel provider: the command that opens a tunnel, its URL, and the listing. */
  provider: TunnelProvider;
  /** A directory of Standup's own the tunnel CLI runs in — never a worktree, which branch code controls. */
  workDir: string;
  /** Where a tunnel's setup/serve/tunnel output goes. */
  logFile: (tunnelId: string, part: "setup" | "serve" | "tunnel") => string;
  /**
   * Starts `argv` in its own process group, detached, output appended to
   * `logFile`; returns its pid (which is also its process group id).
   * `credentials: false` strips the owner's credentials from its environment
   * (branch code runs there).
   */
  spawn: (argv: string[], opts: { cwd: string; logFile: string; env?: Record<string, string>; credentials: boolean }) => number;
  /**
   * Runs `argv` in its own process group to completion without the owner's
   * credentials; its exit code (-1 on timeout or a failed start). `onStart`
   * gets its pid, so a close meanwhile can stop it.
   */
  run: (argv: string[], opts: { cwd: string; logFile: string; timeoutMs: number; onStart?: (pid: number) => void }) => Promise<number>;
  /** Whether nothing listens on 127.0.0.1:`port`. */
  portFree: (port: number) => Promise<boolean>;
  /** Waits until 127.0.0.1:`port` accepts a connection; false on timeout or once `pid` exits. */
  waitForPort: (port: number, timeoutMs: number, pid: number) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
  /** Whether `pid`'s command line names `port` as a whole number (false when it can't be read). */
  commandMentions: (pid: number, port: number) => boolean;
  /**
   * Whether process group `pgid` still has a member whose command line names
   * `port` — the leader may be gone. Null when that can't be told (`ps`
   * failed), so the caller neither kills nor gives up.
   */
  groupMentions: (pgid: number, port: number) => boolean | null;
  /**
   * SIGTERM to process group `pgid` (to `pgid` alone when it leads no group),
   * then SIGKILL to the group shortly after if any of it is still there —
   * never to a bare pid, which may have been reused by then.
   */
  killGroup: (pgid: number) => void;
  /** The tunnels the tunnel service lists for this user; null when it can't be asked. */
  listTunnels: () => Promise<ListedTunnel[] | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** When the host booted: process groups recorded before then are gone. */
  bootedAt: () => Date;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `args` names `port` as a whole number (not as part of 52001 or a timestamp). */
export function argsNamePort(args: string, port: number): boolean {
  return new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(args);
}

/** Every process's pid, process group and command line, from `ps`; null when it can't run. */
function processTable(): Array<{ pid: number; pgid: number; args: string }> | null {
  const out = spawnSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (out.status !== 0 || out.error) return null;
  const rows: Array<{ pid: number; pgid: number; args: string }> = [];
  for (const line of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), args: m[3]! });
  }
  return rows;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolveFree(true)));
  });
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolveAnswers) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolveAnswers(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The real host: child processes, loopback sockets, `ps` and the tunnel provider (default: the collector's). */
export function createReviewTunnelSystem(logDir: string, provider: TunnelProvider = activeTunnelProvider()): ReviewTunnelSystem {
  const openLog = (file: string): number => {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    return openSync(file, "a", 0o600);
  };
  return {
    hostUser: userInfo().username,
    hostname: hostname(),
    provider,
    get workDir() {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      return logDir;
    },
    logFile: (id, part) => join(logDir, `${id}-${part}.log`),

    spawn(argv, opts) {
      const fd = openLog(opts.logFile);
      try {
        const base = opts.credentials ? scrubSecretEnv() : scrubCredentialEnv();
        const child = spawnChild(argv[0]!, argv.slice(1), {
          cwd: opts.cwd,
          env: { ...base, ...(opts.env ?? {}) },
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        if (child.pid === undefined) throw new Error(`could not start ${argv[0]}`);
        child.on("error", () => {});
        child.unref();
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },

    async run(argv, opts) {
      const fd = openLog(opts.logFile);
      try {
        const child = spawnChild(argv[0]!, argv.slice(1), {
          cwd: opts.cwd,
          env: scrubCredentialEnv(),
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        if (child.pid !== undefined) opts.onStart?.(child.pid);
        return await new Promise<number>((resolveCode) => {
          const timer = setTimeout(() => {
            if (child.pid) killProcessGroup(child.pid);
            resolveCode(-1);
          }, opts.timeoutMs);
          child.once("error", () => {
            clearTimeout(timer);
            resolveCode(-1);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolveCode(code ?? -1);
          });
        });
      } finally {
        closeSync(fd);
      }
    },

    portFree,

    async waitForPort(port, timeoutMs, pid) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await portAnswers(port)) return true;
        if (!isAlive(pid)) return false;
        await Bun.sleep(500);
      }
      return false;
    },

    isAlive,

    commandMentions(pid, port) {
      const out = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
      return out.status === 0 && argsNamePort(out.stdout.trim(), port);
    },

    groupMentions(pgid, port) {
      if (pgid === ownGroup() || !groupAlive(pgid)) return false;
      const table = processTable();
      if (!table) return null;
      return table.some((p) => p.pgid === pgid && argsNamePort(p.args, port));
    },

    killGroup(pgid) {
      // Never the collector's own group, whatever a reused id says.
      if (pgid === ownGroup()) return;
      killProcessGroup(pgid, "SIGTERM");
      setTimeout(() => {
        if (!groupAlive(pgid)) return;
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // Gone meanwhile.
        }
      }, 3_000).unref();
    },

    listTunnels: () => provider.list(),

    sleep: (ms) => Bun.sleep(ms),
    now: () => new Date(),
    bootedAt: () => new Date(Date.now() - uptime() * 1000),
  };
}

let cachedOwnGroup: number | null | undefined;
/** The collector's own process group, read once (null when `ps` can't tell, then every call retries). */
function ownGroup(): number | null {
  if (cachedOwnGroup) return cachedOwnGroup;
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5_000 });
  const pgid = Number(out.stdout?.trim());
  cachedOwnGroup = out.status === 0 && Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  return cachedOwnGroup;
}
