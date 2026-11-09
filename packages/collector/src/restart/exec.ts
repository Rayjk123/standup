import { spawn as spawnChild } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { canonicalPath } from "./state.js";

/**
 * The conventional default-branch names, in the order they are tried. A copy
 * of base-branch.ts's list: the supervisor snapshot loads restart/ files only.
 */
export const DEFAULT_BRANCH_NAMES: readonly string[] = ["main", "mainline", "master"];

/** The outcome of a command run to completion. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The signals a restart sends: stops, and dev.ts's respawn signal (DEV_RESPAWN_SIGNAL). */
export type RestartSignal = "SIGTERM" | "SIGKILL" | "SIGUSR2";

/** An HTTP response; `status` 0 means nothing answered (`body` then holds the error). */
export interface HttpResult {
  status: number;
  body: string;
}

/**
 * Every process, git and HTTP effect a restart has. The collector-side service
 * and the detached supervisor take one; tests pass fakes, the CLI and the
 * collector pass createSystemExec().
 */
export interface RestartExec {
  run(argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
  /**
   * Starts `argv` in its own session (it outlives the caller) with stdout and
   * stderr appended to `logFile`, and returns its pid. `stdin`, when given, is
   * written to the child's stdin, which is then closed: a secret passed this
   * way never shows in `ps` or the child's environment.
   */
  spawnDetached(argv: string[], opts: { cwd: string; logFile: string; env?: NodeJS.ProcessEnv; stdin?: string }): number;
  kill(pid: number, signal: RestartSignal): boolean;
  isAlive(pid: number): boolean;
  httpGet(url: string, opts?: { timeoutMs?: number }): Promise<HttpResult>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The real effects: child processes, signals, fetch, timers. */
export function createSystemExec(): RestartExec {
  return {
    async run(argv, opts = {}) {
      const proc = Bun.spawn(argv, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = opts.timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs) : undefined;
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, stdout, stderr };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    spawnDetached(argv, opts) {
      mkdirSync(dirname(opts.logFile), { recursive: true, mode: 0o700 });
      const fd = openSync(opts.logFile, "a", 0o600);
      try {
        const child = spawnChild(argv[0]!, argv.slice(1), {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          detached: true,
          stdio: [opts.stdin !== undefined ? "pipe" : "ignore", fd, fd],
        });
        if (child.pid === undefined) throw new Error(`could not start ${argv[0]}`);
        if (opts.stdin !== undefined && child.stdin) {
          // A child that exits before reading is reported by its own exit, not an EPIPE here.
          child.stdin.on("error", () => {});
          child.stdin.end(opts.stdin);
        }
        child.unref();
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },

    kill(pid, signal) {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },

    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM: it exists but belongs to someone else.
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },

    async httpGet(url, opts = {}) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000), redirect: "manual" });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { status: 0, body: (err as Error).message || "unreachable" };
      }
    },

    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  };
}

/** The last `lines` lines of a file, or "" when it is missing or unreadable. */
export function readTail(path: string, lines = 40): string {
  if (!path || !existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    return text.split("\n").slice(-lines - 1).join("\n").trim();
  } catch {
    return "";
  }
}

// ── Git and process facts, over an executor ────────────────────────────────

export async function gitHead(exec: RestartExec, dir: string): Promise<string | null> {
  const r = await exec.run(["git", "-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
  const head = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{7,64}$/.test(head) ? head : null;
}

/** The checked-out branch, or undefined when HEAD is detached or unreadable. */
export async function gitBranch(exec: RestartExec, dir: string): Promise<string | undefined> {
  const r = await exec.run(["git", "-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"], { timeoutMs: 10_000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

/**
 * The checkout's default branch, whatever is checked out: the branch
 * `origin/HEAD` names, else the first of main, mainline, master the checkout
 * has locally; undefined when there is none.
 */
export async function gitDefaultBranch(exec: RestartExec, dir: string): Promise<string | undefined> {
  const head = await exec.run(["git", "-C", dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { timeoutMs: 10_000 });
  const remote = head.code === 0 ? head.stdout.trim() : "";
  const candidates = remote.startsWith("origin/") ? [remote.slice("origin/".length), ...DEFAULT_BRANCH_NAMES] : [...DEFAULT_BRANCH_NAMES];
  for (const name of candidates) {
    if (!name || name === "HEAD") continue;
    const r = await exec.run(["git", "-C", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], { timeoutMs: 10_000 });
    if (r.code === 0) return name;
  }
  return undefined;
}

/**
 * What a checkout would not account for: tracked files with uncommitted
 * changes and untracked files that aren't ignored (`git status --porcelain
 * --untracked-files=all`, so `?? path` lines are the untracked ones), or null
 * when git could not tell. Untracked files survive a checkout, so a rollback
 * with any would keep running files no commit vouches for.
 */
export async function gitDirtyFiles(exec: RestartExec, dir: string): Promise<string[] | null> {
  const r = await exec.run(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"], { timeoutMs: 20_000 });
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

export interface ProcessInfo {
  ppid: number;
  args: string;
}

/** A process's parent and command line (`ps`, on Linux and macOS alike). */
export async function processInfo(exec: RestartExec, pid: number): Promise<ProcessInfo | null> {
  const r = await exec.run(["ps", "-o", "ppid=", "-o", "args=", "-p", String(pid)], { timeoutMs: 5_000 });
  const line = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  if (r.code !== 0 || !line) return null;
  const m = /^(\d+)\s+(.*)$/.exec(line);
  return m ? { ppid: Number(m[1]), args: m[2]! } : null;
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

/** Every process's pid, parent and command line, or null when `ps` failed. */
export async function listProcesses(exec: RestartExec): Promise<ProcessRow[] | null> {
  const r = await exec.run(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "args="], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  const rows: ProcessRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]!.trim() });
  }
  return rows;
}

/**
 * A process's working directory: `/proc/<pid>/cwd` on Linux, `lsof` on macOS;
 * null when neither can tell.
 */
export async function processCwd(exec: RestartExec, pid: number): Promise<string | null> {
  const proc = await exec.run(["readlink", `/proc/${pid}/cwd`], { timeoutMs: 5_000 });
  if (proc.code === 0 && proc.stdout.trim()) return proc.stdout.trim();
  const lsof = await exec.run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 5_000 });
  const line = lsof.code === 0 ? lsof.stdout.split("\n").find((l) => l.startsWith("n")) : undefined;
  return line ? line.slice(1).trim() || null : null;
}

/**
 * A command line that runs an entry point `src/index.ts` (any directory) under
 * bun: `bun` (any path) first, then only `run` and flags before the entry, as
 * in `bun run src/index.ts` or `/usr/bin/bun --hot src/index.ts`. An editor,
 * pager or compiler given the same file (`vim src/index.ts`, `bun build
 * src/index.ts`) is no collector.
 */
const COLLECTOR_ENTRY = /^(?:\S*\/)?bun(?:\s+(?:run|-\S+))*\s+(?:\S*\/)?src\/index\.ts(?:\s|$)/;

/** The collector package of an install: where its entry point runs from. */
export function collectorCwd(installDir: string): string {
  return join(installDir, "packages", "collector");
}

function isCollectorCwd(cwd: string, installDir: string): boolean {
  return canonicalPath(cwd) === canonicalPath(collectorCwd(installDir));
}

/**
 * Whether `pid` is this install's collector: bun runs `src/index.ts`
 * (COLLECTOR_ENTRY) from `<install>/packages/collector`, or names that entry
 * point by its full path. Anything else — a recycled pid, a forged record's
 * pid, an editor open on the entry point — is never signalled as "the
 * collector".
 */
export async function isCollectorProcess(exec: RestartExec, pid: number, installDir: string): Promise<boolean> {
  const info = await processInfo(exec, pid);
  if (!info || !COLLECTOR_ENTRY.test(info.args)) return false;
  if (info.args.includes(join(collectorCwd(installDir), "src", "index.ts"))) return true;
  const cwd = await processCwd(exec, pid);
  return cwd !== null && isCollectorCwd(cwd, installDir);
}

/** dev.ts's collector branch: the processes it runs for the collector. */
export interface CollectorBranch {
  /** dev.ts's direct children running from the collector package (its `bun run dev`). */
  roots: number[];
  /** The roots and every process below them. */
  pids: number[];
  /** Those whose command line is the collector's entry point. */
  collectors: number[];
}

/**
 * The processes dev.ts runs for this install's collector: its children whose
 * working directory is the collector package, and their descendants. Other
 * services (web, Slack) share the `bun run dev` command line but not the
 * directory. Null when the process table can't be read.
 */
export async function collectorBranch(exec: RestartExec, devPid: number, installDir: string): Promise<CollectorBranch | null> {
  const rows = await listProcesses(exec);
  if (!rows) return null;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const roots: number[] = [];
  for (const child of children.get(devPid) ?? []) {
    const cwd = await processCwd(exec, child.pid);
    if (cwd !== null && isCollectorCwd(cwd, installDir)) roots.push(child.pid);
  }
  const pids: number[] = [];
  const collectors: number[] = [];
  const byPid = new Map(rows.map((r) => [r.pid, r] as const));
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (pids.includes(pid)) continue;
    pids.push(pid);
    if (COLLECTOR_ENTRY.test(byPid.get(pid)?.args ?? "")) collectors.push(pid);
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return { roots, pids, collectors };
}

/** Whether `pid` runs `scripts/dev.ts`. */
export async function isDevScript(exec: RestartExec, pid: number): Promise<boolean> {
  const info = await processInfo(exec, pid);
  return !!info && DEV_SCRIPT.test(info.args);
}

/**
 * Whether `pid` is this install's dev.ts: it runs `scripts/dev.ts` and names
 * `<install>/scripts/dev.ts` by its full path or runs from the install.
 */
export async function isInstallDevScript(exec: RestartExec, pid: number, installDir: string): Promise<boolean> {
  if (!exec.isAlive(pid)) return false;
  const info = await processInfo(exec, pid);
  if (!info || !DEV_SCRIPT.test(info.args)) return false;
  if (info.args.includes(join(installDir, "scripts", "dev.ts"))) return true;
  const cwd = await processCwd(exec, pid);
  return cwd !== null && canonicalPath(cwd) === canonicalPath(installDir);
}

/** How the running collector is supervised. */
export interface Supervision {
  /** `scripts/dev.ts`, which restarts a collector that exits. */
  devPid?: number;
  /** The process between dev.ts and the collector (its `bun run dev`), if any. */
  wrapperPid?: number;
}

const DEV_SCRIPT = /(?:^|[\s/])scripts\/dev\.ts(?:\s|$)/;

/**
 * Walks up from the collector looking for `scripts/dev.ts`. Found, the
 * collector is supervised: dev.ts restarts it a second after it exits. The
 * process just below dev.ts in the chain (`bun run dev`) is the wrapper.
 */
export async function detectSupervision(exec: RestartExec, pid: number, maxDepth = 5): Promise<Supervision> {
  let child = pid;
  let current = await processInfo(exec, pid);
  for (let depth = 0; current && depth < maxDepth; depth++) {
    const parentPid = current.ppid;
    if (parentPid <= 1) return {};
    const parent = await processInfo(exec, parentPid);
    if (!parent) return {};
    if (DEV_SCRIPT.test(parent.args)) {
      return { devPid: parentPid, ...(child !== pid ? { wrapperPid: child } : {}) };
    }
    child = parentPid;
    current = parent;
  }
  return {};
}

const WATCH_FLAG = /^--(?:watch|hot)(?:=.*)?$/;
const WATCH_ARGS = /(?:^|\s)bun(?:\s.*)?\s--(?:watch|hot)(?:[\s=]|$)/;

/**
 * How the collector shows it runs under `bun --watch` (or `--hot`), which
 * reloads it on every file change in the install — a merge included — with
 * no quiesce, health check or rollback; null when it doesn't. Looks at the
 * runtime flags it was started with (`execArgv`), then its own command line
 * and its ancestors' up to dev.ts (a watch wrapper above it).
 */
export async function detectWatchMode(
  exec: RestartExec,
  pid: number,
  execArgv: readonly string[],
  maxDepth = 4
): Promise<string | null> {
  const flag = execArgv.find((a) => WATCH_FLAG.test(a));
  if (flag) return `bun ${flag}`;
  let current = await processInfo(exec, pid);
  for (let depth = 0; current && depth <= maxDepth; depth++) {
    if (DEV_SCRIPT.test(current.args)) return null;
    const args = current.args.replace(/^\S*\/(bun)(?=\s|$)/, "$1");
    if (WATCH_ARGS.test(args)) return current.args;
    if (current.ppid <= 1) return null;
    current = await processInfo(exec, current.ppid);
  }
  return null;
}
