/**
 * Collector leadership: exactly one collector process per data dir serves.
 *
 * A collector takes an exclusive kernel `flock` on leaderLockPath(dataDir)
 * before it opens the DB or binds a port. The lock belongs to the open file
 * description, so the kernel drops it the moment the holder exits or crashes —
 * no stale-lock cleanup, no heartbeat. A second collector (the warm standby)
 * polls the lock with LOCK_NB and takes over within one poll interval of the
 * leader's exit; drain.ts finishes the outgoing leader's in-flight work.
 *
 * flock is reached through bun:ffi. Where libc can't be loaded the collector
 * runs unlocked (degraded mode, logged): the classic single-collector topology
 * never needed the lock, and refusing to boot would be worse there. A slotted
 * collector (gateway mode, two collectors per data dir) never runs unlocked,
 * since both slots would lead: it fails with LeadershipUnavailableError. A
 * slotted standby whose parent is gone exits rather than wait on, and any
 * collector exits with ForeignLeaderError while the data dir's live leader
 * runs from another install.
 *
 * While it waits, a standby also keeps `<dataDir>/standby/<pid>.json`
 * (standbyPidFilePath), which it removes when it takes the lock or exits
 * (orphaned, SIGTERM/SIGINT, or any process.exit): the restart supervisor
 * stops exactly the standbys listed there, never a process it merely finds
 * in the process table.
 */
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  leaderFilePath,
  leaderLockPath,
  readJsonFile,
  standbyDirPath,
  standbyFilePath,
  writeJsonAtomic,
  type CollectorSlot,
  type LeaderBootPhase,
  type LeaderInfo,
  type StandbyInfo,
} from "@standup/shared/topology";
import { cliPathsOf, pidAlive, validPid } from "@standup/shared/process-identity";

const LOCK_EX = 2;
const LOCK_NB = 4;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const EINTR = 4;
/** EWOULDBLOCK: 11 on Linux, 35 on macOS. */
const EWOULDBLOCK = process.platform === "darwin" ? 35 : 11;

/**
 * The outcome of one non-blocking lock attempt. `unidentified`: flock failed
 * and its errno could not be read, so it may be busy or broken.
 */
export type LockAttempt = "acquired" | "busy" | "unidentified";

/** Non-blocking exclusive locks on an open fd. */
export interface FileLocker {
  tryLock(fd: number): LockAttempt;
  /** Marks `fd` close-on-exec so no child process can keep the lock alive. */
  setCloseOnExec(fd: number): void;
}

const LIBC_CANDIDATES =
  process.platform === "darwin"
    ? ["libc.dylib", "/usr/lib/libSystem.B.dylib", "libSystem.B.dylib"]
    : ["libc.so.6", "libc.so"];

let cachedLocker: FileLocker | null | undefined;

/**
 * flock(2) via bun:ffi, or null when libc can't be loaded. Cached: the library
 * handle lives for the process, so its symbols are never unloaded under a held lock.
 */
export function libcLocker(): FileLocker | null {
  if (cachedLocker !== undefined) return cachedLocker;
  cachedLocker = null;
  for (const name of LIBC_CANDIDATES) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const errnoLib = openErrno(name);
      // fcntl is variadic; calling it with a fixed signature is only sound
      // where variadic ints are passed like fixed ones (Linux on x86-64 and
      // arm64). Elsewhere Bun's spawn closes inherited fds on its own.
      const fcntlLib = process.platform === "linux" ? openFcntl(name) : null;
      // errno is read in a second FFI call, so a single odd value could be
      // the runtime's rather than flock's; only a repeated one is an error.
      let unexpected = 0;
      cachedLocker = {
        tryLock(fd) {
          for (;;) {
            if (lib.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) {
              unexpected = 0;
              return "acquired";
            }
            const errno = errnoLib?.();
            if (errno === EINTR) continue;
            if (errno === undefined) return "unidentified";
            if (errno === EWOULDBLOCK || ++unexpected < 3) {
              if (errno === EWOULDBLOCK) unexpected = 0;
              return "busy";
            }
            throw new Error(`flock(${fd}) failed with errno ${errno}`);
          }
        },
        setCloseOnExec(fd) {
          fcntlLib?.(fd, F_SETFD, FD_CLOEXEC);
        },
      };
      return cachedLocker;
    } catch {
      // Try the next candidate.
    }
  }
  return cachedLocker;
}

/** Reads the calling thread's errno, or undefined when it can't be located. */
function openErrno(libName: string): (() => number | undefined) | null {
  const symbol = process.platform === "darwin" ? "__error" : "__errno_location";
  try {
    const lib = dlopen(libName, { [symbol]: { args: [], returns: FFIType.ptr } });
    const fn = lib.symbols[symbol] as () => Pointer | null;
    return () => {
      const p = fn();
      return p ? read.i32(p, 0) : undefined;
    };
  } catch {
    return null;
  }
}

function openFcntl(libName: string): ((fd: number, cmd: number, arg: number) => number) | null {
  try {
    const lib = dlopen(libName, { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg);
  } catch {
    return null;
  }
}

export interface AcquireLeadershipOptions {
  dataDir: string;
  slot?: CollectorSlot;
  /** The ports this process binds (recorded in the leader file for the gateway). */
  httpPort: number;
  wsPort: number;
  installDir: string;
  /**
   * The commit this process's code was loaded from (readInstallHead at process
   * start), recorded in the standby and leader files as is. Never re-read
   * here: by the time a standby takes the lock, the checkout may have moved on.
   */
  head?: string;
  /** Called once, after the standby file is written, when the lock is already held. */
  onWaiting?: (info: StandbyInfo) => void;
  /** Lock poll interval while waiting. */
  pollMs?: number;
  log?: (line: string) => void;
  /** The lock implementation; null runs unlocked. Defaults to libcLocker(). */
  locker?: FileLocker | null;
  /**
   * Consecutive `unidentified` lock failures, with no live leader recorded in
   * the leader file, after which the lock counts as broken and the collector
   * runs unlocked (default 100).
   */
  maxUnidentified?: number;
  /** The process's parent pid now (default process.ppid); read on every poll while a slotted collector waits. */
  parentPid?: () => number;
  /** Whether `pid` runs (default a signal-0 probe). */
  isAlive?: (pid: number) => boolean;
  /** How an orphaned standby, or one that found another install's leader, exits (default process.exit). */
  exit?: (code: number) => void;
  /**
   * How long the leader file must keep naming a live leader of another
   * install, while the lock stays busy, before this process gives up (default
   * 1000ms). A leader of this install rewrites the file right after it takes
   * the lock, so a record that persists is the lock holder's.
   */
  foreignLeaderGraceMs?: number;
}

/** Another install's collector leads this data dir; this one exited rather than wait to lead it. */
export class ForeignLeaderError extends Error {
  constructor(
    readonly leaderPid: number,
    readonly leaderInstallDir: string,
    readonly dataDir: string,
    readonly installDir: string
  ) {
    super(
      `the collector leading ${dataDir} (pid ${leaderPid}) runs from another install, ${leaderInstallDir}, ` +
        `not ${installDir}; refusing to wait to lead another install's data dir. ` +
        "Give this install its own data dir (DB_PATH), or stop the other one."
    );
    this.name = "ForeignLeaderError";
  }
}

/** A slotted standby's parent is gone; it left the lock alone (see acquireLeadership). */
export class StandbyOrphanedError extends Error {
  constructor(reason: string) {
    super(`standby orphaned: ${reason}`);
    this.name = "StandbyOrphanedError";
  }
}

/** Leadership can't be made exclusive, and a slotted collector must not run unlocked. */
export class LeadershipUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `${reason}; refusing to run unlocked as a slotted collector (STANDUP_COLLECTOR_SLOT is set), ` +
        "since both slots would lead. Fix flock on this host or run with STANDUP_GATEWAY=0."
    );
    this.name = "LeadershipUnavailableError";
  }
}

export interface Leadership {
  /** Random per leadership term. */
  epoch: string;
  acquiredAt: Date;
  /** The commit this process's code was loaded from (the `head` option). */
  head?: string;
  /** False in degraded mode (no flock available, or the lock proved unusable). */
  locked: boolean;
  /**
   * Records in the leader file what this leader does before it listens (the
   * pre-migration copy, then migrations), or, with undefined, that it is done.
   */
  setBootPhase(phase: LeaderBootPhase | undefined): void;
  /**
   * Drops the lock and removes the leader file if it is still ours. A serving
   * collector never calls this — its exit releases the lock — so it exists for
   * tests and for a caller that hands leadership off in-process.
   */
  release(): void;
}

/**
 * Lock fds held for the life of the process. A plain fd number has no finalizer,
 * so nothing closes it behind our back; this list just keeps the holders reachable.
 */
const heldLocks: Array<{ fd: number }> = [];

/**
 * The commit `installDir` has checked out, best-effort. Read once when the
 * process starts, so it names the code this process loaded. GIT_* variables are
 * dropped so an inherited GIT_DIR or GIT_WORK_TREE can't point it at another
 * repository.
 */
export function readInstallHead(installDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const gitEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.startsWith("GIT_")) gitEnv[key] = value;
  }
  try {
    const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: installDir,
      env: gitEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5_000,
    });
    if (out.exitCode !== 0) return undefined;
    const head = out.stdout.toString().trim();
    return /^[0-9a-f]{7,64}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** This process's per-pid standby marker in `dataDir`. */
export function standbyPidFilePath(dataDir: string, pid: number): string {
  return join(standbyDirPath(dataDir), `${pid}.json`);
}

function removeIfOurs(path: string, pid: number, epoch?: string): void {
  const current = readJsonFile<{ pid?: number; epoch?: string }>(path);
  if (!current || current.pid !== pid) return;
  if (epoch !== undefined && current.epoch !== epoch) return;
  rmSync(path, { force: true });
}

/** Whether the leader file names a live process other than this one. */
function liveLeaderRecorded(dataDir: string, self: number): boolean {
  const pid = readJsonFile<{ pid?: unknown }>(leaderFilePath(dataDir))?.pid;
  if (!validPid(pid) || pid === self) return false;
  return pidAlive(pid);
}

/** Whether two install dirs name the same checkout, symlinks resolved. */
function sameInstall(a: string, b: string): boolean {
  const ours = cliPathsOf(a);
  return cliPathsOf(b).some((p) => ours.includes(p));
}

/**
 * The leader file's record when it names a live process other than this one
 * that runs from another install than `installDir`, else undefined.
 */
function foreignLeaderRecorded(
  dataDir: string,
  self: number,
  installDir: string,
  isAlive: (pid: number) => boolean
): { pid: number; installDir: string } | undefined {
  const info = readJsonFile<{ pid?: unknown; installDir?: unknown }>(leaderFilePath(dataDir));
  if (!info || !validPid(info.pid) || info.pid === self) return undefined;
  if (typeof info.installDir !== "string" || !info.installDir || sameInstall(info.installDir, installDir)) return undefined;
  return isAlive(info.pid) ? { pid: info.pid, installDir: info.installDir } : undefined;
}

/**
 * Waits until this process holds the collector leader lock for `dataDir`, then
 * publishes the leader file. While another process holds it, this process is
 * the standby: it publishes the standby file once and polls every `pollMs`.
 */
export async function acquireLeadership(opts: AcquireLeadershipOptions): Promise<Leadership> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const pollMs = opts.pollMs ?? 50;
  const locker = opts.locker === undefined ? libcLocker() : opts.locker;
  const pid = process.pid;
  const slotLabel = opts.slot ? ` (slot ${opts.slot})` : "";

  const maxUnidentified = opts.maxUnidentified ?? 100;
  const head = opts.head;

  /** Degraded mode, or LeadershipUnavailableError for a slotted collector. */
  const runUnlocked = (reason: string): void => {
    if (opts.slot) throw new LeadershipUnavailableError(reason);
    log(`[collector] WARNING: ${reason}; running without the leader lock (only one collector per data dir is safe)`);
  };

  const parentPid = opts.parentPid ?? (() => process.ppid);
  const isAlive = opts.isAlive ?? pidAlive;
  const originalParent = parentPid();
  /** Why a waiting slot counts as orphaned: its parent exited (it was re-parented, or the pid is gone); null while it lives. */
  const orphaned = (): string | null => {
    const now = parentPid();
    if (now === 1) return "re-parented to init";
    if (now !== originalParent) return `re-parented from pid ${originalParent} to ${now}`;
    if (!isAlive(originalParent)) return `parent pid ${originalParent} is gone`;
    return null;
  };

  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const foreignLeaderGraceMs = opts.foreignLeaderGraceMs ?? 1_000;
  const pidFile = standbyPidFilePath(opts.dataDir, pid);
  /** Set while this process waits: removes its per-pid marker and the handlers that remove it on exit. */
  let endWait: (() => void) | undefined;
  const beginWait = (standby: StandbyInfo): void => {
    const dropMarker = () => rmSync(pidFile, { force: true });
    // No other SIGTERM/SIGINT handler runs this early in boot, so these
    // replace the signals' default action: exit, without the marker.
    const onSignal = (signal: NodeJS.Signals) => {
      endWait?.();
      removeIfOurs(standbyFilePath(opts.dataDir), pid);
      log(`[collector] Standby${slotLabel} exiting on ${signal}`);
      exit(0);
    };
    process.on("exit", dropMarker);
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    endWait = () => {
      process.off("exit", dropMarker);
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
      dropMarker();
      endWait = undefined;
    };
    writeJsonAtomic(pidFile, standby);
  };

  mkdirSync(opts.dataDir, { recursive: true });
  let fd: number | undefined;
  if (locker) {
    fd = openSync(leaderLockPath(opts.dataDir), "a+", 0o600);
    locker.setCloseOnExec(fd);
    let waiting = false;
    let waitStart = 0;
    let unidentified = 0;
    /** When the leader file started naming another install's live leader, while it still does. */
    let foreignSince: number | undefined;
    for (;;) {
      const attempt = locker.tryLock(fd);
      if (attempt === "acquired") break;
      if (attempt === "unidentified" && !liveLeaderRecorded(opts.dataDir, pid)) {
        if (++unidentified >= maxUnidentified) {
          closeSync(fd);
          fd = undefined;
          endWait?.();
          if (waiting) removeIfOurs(standbyFilePath(opts.dataDir), pid);
          log(
            `[collector] ERROR: flock on ${leaderLockPath(opts.dataDir)} failed ${unidentified} times in a row with an unreadable errno ` +
              "and no live leader recorded; treating the lock as broken"
          );
          runUnlocked("the leader lock is unusable (flock keeps failing with an unreadable errno)");
          break;
        }
      } else {
        unidentified = 0;
      }
      if (!waiting) {
        waiting = true;
        waitStart = Date.now();
        const standby: StandbyInfo = {
          pid,
          ...(opts.slot ? { slot: opts.slot } : {}),
          startedAt: new Date().toISOString(),
          installDir: opts.installDir,
          ...(head ? { head } : {}),
        };
        beginWait(standby);
        writeJsonAtomic(standbyFilePath(opts.dataDir), standby);
        log(`[collector] Standby${slotLabel}: waiting for the leader lock at ${leaderLockPath(opts.dataDir)}`);
        opts.onWaiting?.(standby);
      }
      // A slot's parent (dev.ts's `bun run start`, or the restart supervisor
      // that started it) restarts or retires it; with that parent gone,
      // nothing would, and a standby left waiting could take the lock on
      // stale code long after. It exits instead, without the lock.
      const why = opts.slot ? orphaned() : null;
      if (why !== null) {
        closeSync(fd);
        endWait?.();
        removeIfOurs(standbyFilePath(opts.dataDir), pid);
        log(`[collector] Standby${slotLabel} exiting: ${why}, so nothing would retire it`);
        exit(0);
        throw new StandbyOrphanedError(why);
      }
      // Two installs on one data dir would take turns leading it, each on its
      // own code: never wait to win the lock from another install's leader.
      const foreign = foreignLeaderRecorded(opts.dataDir, pid, opts.installDir, isAlive);
      if (!foreign) {
        foreignSince = undefined;
      } else if (foreignSince === undefined) {
        foreignSince = Date.now();
      } else if (Date.now() - foreignSince >= foreignLeaderGraceMs) {
        closeSync(fd);
        endWait?.();
        removeIfOurs(standbyFilePath(opts.dataDir), pid);
        const err = new ForeignLeaderError(foreign.pid, foreign.installDir, opts.dataDir, opts.installDir);
        log(`[collector] ERROR: ${err.message}`);
        exit(1);
        throw err;
      }
      await Bun.sleep(pollMs);
    }
    if (fd !== undefined) {
      heldLocks.push({ fd });
      if (waiting) {
        endWait?.();
        removeIfOurs(standbyFilePath(opts.dataDir), pid);
        log(`[collector] Acquired the leader lock${slotLabel} after ${Date.now() - waitStart}ms as standby`);
      } else {
        log(`[collector] Acquired the leader lock${slotLabel}`);
      }
    }
  } else {
    runUnlocked("flock is unavailable on this platform");
  }

  const acquiredAt = new Date();
  const epoch = randomBytes(8).toString("hex");
  const info: LeaderInfo = {
    pid,
    ...(opts.slot ? { slot: opts.slot } : {}),
    httpPort: opts.httpPort,
    wsPort: opts.wsPort,
    epoch,
    acquiredAt: acquiredAt.toISOString(),
    installDir: opts.installDir,
    ...(head ? { head } : {}),
  };
  writeJsonAtomic(leaderFilePath(opts.dataDir), info);

  let released = false;
  return {
    epoch,
    acquiredAt,
    head,
    locked: fd !== undefined,
    setBootPhase(phase) {
      if (released) return;
      writeJsonAtomic(leaderFilePath(opts.dataDir), phase ? { ...info, bootPhase: phase, bootPhaseAt: new Date().toISOString() } : info);
    },
    release() {
      if (released) return;
      released = true;
      removeIfOurs(leaderFilePath(opts.dataDir), pid, epoch);
      if (fd !== undefined) {
        const i = heldLocks.findIndex((h) => h.fd === fd);
        if (i >= 0) heldLocks.splice(i, 1);
        closeSync(fd);
      }
    },
  };
}
