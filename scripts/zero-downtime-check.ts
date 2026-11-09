#!/usr/bin/env bun
/**
 * End-to-end check of Standup's zero-downtime restarts, against a scratch
 * install that shares nothing with a live one:
 *
 *   bun run scripts/zero-downtime-check.ts [--cleanup] [--probe-timeout-ms N]
 *     [--from <rev>] [--to <rev>] [--persona-stub]
 *
 * --from starts the scratch install on <rev> instead of this checkout's HEAD;
 * --to makes scenario A redeploy <rev> (a fast-forward of the start) instead
 * of a trivial commit, which rehearses a real landing; --persona-stub runs
 * Persona with scripted turns, as a live install runs it.
 *
 * It clones this (clean) checkout's HEAD into /tmp/standup-zd-XXXX/install,
 * runs `scripts/dev.ts` there on spare ports with a scratch HOME and data dir,
 * and probes the UI, the API through vite and the collector through the
 * gateway every 100ms (a hook POST every 500ms; at most one probe per target in
 * flight), with a WebSocket client that reconnects like the web app. A
 * simulated worker on a private tmux server is registered as a real session
 * through a SessionStart hook, and it owns a checkpoint and a pending ask whose
 * waiter re-attaches by request id like the MCP client. Before any restart the
 * WebSocket client drops its own connection and resumes within the epoch.
 * Then it runs:
 *
 *   A. a redeploy (`scripts/standup-redeploy.ts post-merge`) of a trivial
 *      collector commit, which must hand off to the warm standby;
 *   B. a full restart of dev.ts (what `systemctl restart` does with
 *      KillMode=process): SIGTERM to dev.ts only, then start it again.
 *
 * It passes (exit 0) only with zero failed probes of any kind (refused, reset,
 * non-2xx, timeout), no failed or never-opened WebSocket dial, a fresh hello
 * after each restart whose snapshot still holds the worker's session, ask and
 * checkpoint, a gateway that never restarted and failed nothing, a restart
 * record with outcome ok, and no process of the run on a live port. It
 * always tears the scratch processes down; the scratch root is kept for
 * inspection unless --cleanup is given. See plan/zero-downtime-restarts.md.
 */
import { Database } from "bun:sqlite";
import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT } from "../packages/shared/src/constants.js";
import {
  COLLECTOR_SLOTS,
  DEFAULT_VITE_PORT,
  DEFAULT_WEB_PORT,
  DRAINING_HEADER,
  DRAINING_RELEASED,
  GATEWAY_STATS_PATH,
  gatewayFilePath,
  gatewayLogPath,
  leaderFilePath,
  publicPorts,
  readJsonFile,
  slotPorts,
  standbyFilePath,
  vitePortFor,
  type GatewayInfo,
  type GatewayStats,
  type LeaderInfo,
  type StandbyInfo,
} from "../packages/shared/src/topology.js";
import {
  PROCESS_TABLE_ARGV,
  ProbeLoop,
  RUN_MARKER_VAR,
  WsObserver,
  assertPortsSafe,
  formatSummary,
  parseListeners,
  parseProcessRows,
  pickPorts,
  realClock,
  runProcessPids,
  sleep,
  summarize,
  waitFor,
  type Assertion,
  type ChosenPorts,
  type ProbeResult,
  type ProcessRow,
  type ProbeTarget,
  type TargetSummary,
  type WsHello,
  type WsLike,
  type WsOutage,
  withNoOpMigration,
} from "./zero-downtime-probe.js";

const WORKTREE = resolve(import.meta.dir, "..");
const REAL_HOME = process.env.HOME || homedir();
const args = process.argv.slice(2);
const CLEANUP = args.includes("--cleanup");
/** `--from <rev>`: the commit the scratch install starts on (default: this checkout's HEAD). */
const FROM_REV = argValue("--from");
/** `--to <rev>`: scenario A redeploys this commit (a fast-forward of --from) instead of a trivial one. */
const TO_REV = argValue("--to");
/** `--persona-stub`: Persona runs, with scripted turns (no claude), as on a live install. */
const PERSONA_STUB = args.includes("--persona-stub");
/** `--fill-db-mb <n>`: before scenario A, the scratch database grows by about n MB, so its pre-migration copy takes time. */
const FILL_DB_MB = Number.parseInt(argValue("--fill-db-mb") ?? "", 10) || 0;
/** `--with-migration`: scenario A's trivial commit also adds a no-op migration, so the new leader copies the database first. */
const WITH_MIGRATION = args.includes("--with-migration");
/** `--boot-timeout-s <s>`: the restarts' boot timeout (STANDUP_RESTART_BOOT_TIMEOUT_S). */
const BOOT_TIMEOUT_S = argValue("--boot-timeout-s");
function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1]?.trim() || undefined : undefined;
}
/** The gateway's default hold (STANDUP_GATEWAY_HOLD_MS): how long a request may legitimately wait. */
const HOLD_MS = 60_000;
const timeoutArg = args.indexOf("--probe-timeout-ms");
/** A probe only times out once it has outlasted the gateway's hold. */
const PROBE_TIMEOUT_MS = (timeoutArg >= 0 ? Number.parseInt(args[timeoutArg + 1] ?? "", 10) : NaN) || HOLD_MS + 5_000;
/** Successful probes slower than this are flagged in the report, not failed. */
const SOFT_BUDGET_MS = 10_000;
/** Held-request cap for the scratch gateway: far above what the probes can hold at once. */
const GATEWAY_MAX_HELD = "5000";
const BOOT_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 180_000;
const SETTLE_MS = 3_000;
const OVERALL_TIMEOUT_MS = 25 * 60_000;
const MAX_TIMER_MS = "2147483647";
/**
 * Collector/ws ports come from 10000–12699, so slot a (+10000) sits in
 * 20000–22699 and slot b (+20000) at or below 32699; web from 13000–14999,
 * with vite (vitePortFor, +10000) in 23000–24999, clear of both slots.
 * Everything sits below the kernel's default ephemeral range (32768+), so no
 * outgoing connection's source port can take one.
 */
const COLLECTOR_RANGE: [number, number] = [10_000, 12_700];
const WEB_RANGE: [number, number] = [13_000, 15_000];
const MAX_PORT = 32_767;
const SYS_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// ── Small helpers ───────────────────────────────────────────────────────────

let logPath: string | undefined;
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logPath) {
    try {
      appendFileSync(logPath, line + "\n");
    } catch {
      // the console still has it
    }
  }
}

const assertions: Assertion[] = [];
const warnings: string[] = [];
function expect(name: string, ok: boolean, detail: string): boolean {
  assertions.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  return ok;
}
function warn(message: string): void {
  warnings.push(message);
  log(`WARNING ${message}`);
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** Set once teardown starts; nothing new is launched after that. */
let tearingDown = false;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Process groups and sessions this script started (each led by the pid it
 * spawned), and pids already identified as the run's with the command line
 * they had then; together they identify the run's processes (runProcessPids).
 */
const runGroups = new Set<number>();
const knownRunPids = new Map<number, string>();

/**
 * Runs a command in its own session with a hard timeout (the whole session is
 * killed on expiry). Its session is recorded as the run's unless `untracked`
 * (the read-only system commands). Refused once teardown has started, except
 * for the commands teardown itself runs (`duringTeardown`).
 */
function run(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; duringTeardown?: boolean; untracked?: boolean }): Promise<RunResult> {
  if (tearingDown && !opts.duringTeardown) {
    return Promise.resolve({ code: 125, stdout: "", stderr: `refused (tearing down): ${argv.join(" ")}`, timedOut: false });
  }
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolveRun({ code: 127, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    if (child.pid && !opts.untracked) runGroups.add(child.pid);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) signal(-child.pid, "SIGKILL");
    }, opts.timeoutMs);
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    // A daemonized grandchild that kept the pipes open must not hold the
    // result past the command's own exit.
    child.on("exit", (code) => setTimeout(() => finish(code ?? (timedOut ? 124 : 1)), 2_000));
  });
}

/** A read-only system command (ps, ss): system PATH, allowed during teardown. */
function sys(argv: string[], timeoutMs = 10_000): Promise<RunResult> {
  return run(argv, { cwd: "/", env: { PATH: SYS_PATH }, timeoutMs, duringTeardown: true, untracked: true });
}

async function mustRun(what: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0) {
    throw new Error(`${what} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${(r.stderr || r.stdout).trim().slice(-800)}`);
  }
  return r.stdout.trim();
}

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<{ status: number; json?: T; text: string } | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: T | undefined;
    try {
      json = JSON.parse(text) as T;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  } catch {
    return undefined;
  }
}

async function postJson(url: string, body: unknown, timeoutMs = 15_000): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: String(err) };
  }
}

function canListen(hostname: string, port: number): boolean {
  try {
    const listener = Bun.listen({ hostname, port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Whether this host has an IPv6 loopback to bind (checked once, on an ephemeral port). */
let ipv6Loopback: boolean | undefined;

/**
 * A port is free only when it can be bound on 127.0.0.1 and, where the host
 * has an IPv6 loopback, on ::1 too: the scratch gateway binds both.
 */
async function portFree(port: number): Promise<boolean> {
  if (!canListen("127.0.0.1", port)) return false;
  ipv6Loopback ??= canListen("::1", 0);
  return !ipv6Loopback || canListen("::1", port);
}

/** Every process's ids and command line; never its environment. */
async function processTable(): Promise<ProcessRow[]> {
  const r = await sys([...PROCESS_TABLE_ARGV]);
  return parseProcessRows(r.stdout);
}

/**
 * The run's live processes (runProcessPids), remembering each one found so a
 * process that outlives its parent or leaves its group (a standalone
 * collector, `bun run src/index.ts` in a session of its own, once the
 * supervisor that started it exits) is still the run's. startRunScanner
 * keeps the record current between the scans teardown and the checks make.
 */
async function scanRun(): Promise<ProcessRow[]> {
  const root = state.root;
  if (!root) return [];
  const rows = await processTable();
  const ours = runProcessPids(rows, { root, groups: runGroups, known: knownRunPids, exclude: new Set([process.pid]) });
  const out = rows.filter((row) => ours.has(row.pid));
  for (const row of out) knownRunPids.set(row.pid, row.args);
  return out;
}

/** Records `pids`, processes this script just started by other means, as the run's. */
function adoptRunPids(pids: readonly number[], rows: readonly ProcessRow[]): void {
  for (const row of rows) if (pids.includes(row.pid) && row.pid > 1 && row.pid !== process.pid) knownRunPids.set(row.pid, row.args);
}

/** Whether `pid` is a live process of the run. */
async function isRunPid(pid: number): Promise<boolean> {
  return (await scanRun()).some((row) => row.pid === pid);
}

/** Scans the process table every second while the run is up, so short-lived parents are seen. */
let scanTimer: ReturnType<typeof setInterval> | undefined;
function startRunScanner(): void {
  let inFlight = false;
  scanTimer ??= setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void scanRun()
      .catch(() => undefined)
      .finally(() => (inFlight = false));
  }, 1_000);
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

// ── The live install (computed, never chosen or touched) ────────────────────

function livePorts(): Set<number> {
  const ports = new Set<number>([DEFAULT_WEB_PORT, DEFAULT_VITE_PORT, DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT]);
  for (const p of [publicPorts({}), publicPorts(process.env)]) {
    ports.add(p.web).add(vitePortFor(p.web)).add(p.collector).add(p.ws);
    for (const slot of COLLECTOR_SLOTS) {
      const s = slotPorts(p.collector, p.ws, slot);
      ports.add(s.http).add(s.ws);
    }
  }
  const vite = Number.parseInt(process.env.STANDUP_VITE_PORT ?? "", 10);
  if (Number.isFinite(vite)) ports.add(vite);
  // Other Standup instances on this host serve the console here; never pick or probe them.
  for (const extra of (process.env.STANDUP_ZD_EXCLUDE_PORTS ?? "5199").split(",")) {
    const port = Number.parseInt(extra.trim(), 10);
    if (Number.isFinite(port)) ports.add(port);
  }
  return ports;
}

interface LiveSnapshot {
  /** Live port → listening pids; undefined when ss is unavailable. */
  listeners?: Map<number, number[]>;
}

async function snapshotLive(): Promise<LiveSnapshot> {
  const ss = await sys(["ss", "-ltnpH"]);
  return { listeners: ss.code === 0 ? parseListeners(ss.stdout, livePorts()) : undefined };
}

// ── Run state (what teardown needs) ─────────────────────────────────────────

interface DevRun {
  pid: number;
  exited: Promise<number | null>;
  done: boolean;
}

const state: {
  root?: string;
  runId?: string;
  install?: string;
  dataDir?: string;
  tmuxSock?: string;
  tmuxEnv?: NodeJS.ProcessEnv;
  workerPid?: number;
  devRuns: DevRun[];
  probes?: ProbeLoop;
  observer?: WsObserver;
  askWaiter?: { abort: AbortController; done: Promise<void> };
  liveBefore?: LiveSnapshot;
} = { devRuns: [] };

function startDev(env: NodeJS.ProcessEnv, n: number): DevRun {
  if (tearingDown) throw new Error(`refusing to start dev.ts #${n}: tearing down`);
  const logFile = join(state.root!, `dev-${n}.log`);
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = spawnChild(process.execPath, ["run", join(state.install!, "scripts", "dev.ts")], {
      cwd: state.install!,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    if (!child.pid) throw new Error("dev.ts spawn returned no pid");
    // detached: dev.ts leads a session of its own, and everything it starts
    // without detaching stays in it.
    runGroups.add(child.pid);
    startRunScanner();
    const runRef: DevRun = { pid: child.pid, done: false, exited: Promise.resolve(null) };
    runRef.exited = new Promise((resolveExit) =>
      child.on("exit", (code) => {
        runRef.done = true;
        resolveExit(code);
      })
    );
    state.devRuns.push(runRef);
    log(`started dev.ts #${n} pid ${child.pid} (log ${logFile})`);
    return runRef;
  } finally {
    closeSync(fd);
  }
}

function tmuxArgv(...rest: string[]): string[] {
  return ["tmux", "-f", "/dev/null", "-L", state.tmuxSock!, ...rest];
}

// ── Teardown ────────────────────────────────────────────────────────────────

let teardownPromise: Promise<string[]> | undefined;

/**
 * Stops everything this run started; returns the processes that survived it.
 * A process is only ever signalled when it is one this script spawned and is
 * still waiting on, or when scanRun says it is the run's (in a group or
 * session this script started, descended from one of the run's processes,
 * already recorded as the run's, or running code from the scratch install or
 * its restart supervisor copy).
 */
function teardown(): Promise<string[]> {
  tearingDown = true;
  teardownPromise ??= (async () => {
    if (scanTimer) clearInterval(scanTimer);
    // Recorded before anything is stopped, while every parent is still alive.
    await scanRun().catch(() => undefined);
    log("teardown: stopping probes, the ask waiter and the WebSocket observer");
    state.observer?.stop();
    state.askWaiter?.abort.abort();
    if (state.probes) await Promise.race([state.probes.stop(), sleep(PROBE_TIMEOUT_MS + 2_000)]);
    if (state.askWaiter) await Promise.race([state.askWaiter.done, sleep(5_000)]);

    for (const dev of state.devRuns) {
      if (dev.done) continue;
      log(`teardown: SIGTERM dev.ts process group ${dev.pid}`);
      signal(-dev.pid, "SIGTERM");
    }
    for (const dev of state.devRuns) {
      if (dev.done) continue;
      if (!(await Promise.race([dev.exited.then(() => true), sleep(15_000).then(() => false)])) && !dev.done) {
        log(`teardown: dev.ts ${dev.pid} still running after 15s; SIGKILL to its group`);
        signal(-dev.pid, "SIGKILL");
      }
    }

    const root = state.root;
    if (state.dataDir && root) {
      const gw = readJsonFile<GatewayInfo>(gatewayFilePath(state.dataDir));
      if (gw?.pid && pidAlive(gw.pid)) {
        if (await isRunPid(gw.pid)) {
          log(`teardown: SIGTERM gateway ${gw.pid}`);
          signal(gw.pid, "SIGTERM");
          if (!(await waitExit(gw.pid, 13_000))) {
            log(`teardown: gateway ${gw.pid} still running; SIGKILL`);
            signal(gw.pid, "SIGKILL");
          }
        } else {
          log(`teardown: gateway.json names pid ${gw.pid}, which is not this run's; left alone`);
        }
      }
    }

    if (state.tmuxSock && state.tmuxEnv) {
      await run(tmuxArgv("kill-server"), { cwd: "/", env: state.tmuxEnv, timeoutMs: 10_000, duringTeardown: true });
      if (state.workerPid && pidAlive(state.workerPid) && (await isRunPid(state.workerPid)) && !(await waitExit(state.workerPid, 3_000))) {
        log(`teardown: tmux worker ${state.workerPid} survived kill-server; SIGKILL`);
        signal(state.workerPid, "SIGKILL");
      }
    }

    const survivors: string[] = [];
    if (root) {
      const ours = scanRun;
      const describe = (p: ProcessRow) => `${p.pid} ${p.args.slice(0, 160)}`;
      let left = await ours();
      for (const p of left) {
        log(`teardown: leftover process ${describe(p)}; SIGTERM`);
        signal(p.pid, "SIGTERM");
      }
      if (left.length > 0) {
        await sleep(5_000);
        left = await ours();
        for (const p of left) {
          log(`teardown: ${p.pid} survived SIGTERM; SIGKILL`);
          signal(p.pid, "SIGKILL");
        }
        await sleep(1_000);
        left = await ours();
      }
      for (const p of left) survivors.push(describe(p));
      if (survivors.length > 0) log(`teardown: WARNING ${survivors.length} process(es) still alive: ${survivors.join(" | ")}`);
      else log("teardown: no process of this run is left");
    }
    return survivors;
  })();
  return teardownPromise;
}

let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log(`${sig}: tearing down`);
    void teardown().finally(() => process.exit(130));
  });
}

// ── Live-state guard ────────────────────────────────────────────────────────

/**
 * Compares the live ports' listeners with the snapshot taken before the run;
 * a process of the run listening on a live port fails separately
 * (runListenersOnLivePorts).
 */
async function liveGuard(): Promise<Record<string, unknown>> {
  const before = state.liveBefore;
  if (!before) return { skipped: "no snapshot before the run" };
  const after = await snapshotLive();
  const listenerReport: Record<string, unknown> = {};
  if (before.listeners && after.listeners) {
    for (const port of [...livePorts()].sort((a, b) => a - b)) {
      const b = before.listeners.get(port);
      const a = after.listeners.get(port);
      listenerReport[port] = { before: b ?? null, after: a ?? null };
      if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) warn(`live port ${port} listeners changed: ${JSON.stringify(b ?? null)} -> ${JSON.stringify(a ?? null)}`);
    }
  }
  return { listeners: listenerReport };
}

/** `port/pid` for each process of the run listening on a live port; undefined when ss is unavailable. */
async function runListenersOnLivePorts(): Promise<string[] | undefined> {
  const { listeners } = await snapshotLive();
  if (!listeners || !state.root) return undefined;
  const runPids = new Set((await scanRun()).map((p) => p.pid));
  const out: string[] = [];
  for (const [port, pids] of listeners) for (const pid of pids) if (runPids.has(pid)) out.push(`${port}/${pid}`);
  return out;
}

// ── The check ───────────────────────────────────────────────────────────────

/** The parts of the restart record (packages/collector/src/restart/state.ts) the check reads. */
interface RestartRecordView {
  id: string;
  phase: string;
  outcome?: string;
  mode: string;
  requestedAt: string;
  finishedAt?: string;
  headBefore?: string;
  userImpact?: Record<string, unknown>;
  preflight?: Record<string, unknown>;
  error?: string;
  attempts?: Array<{ head: string; ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }>;
}

interface Healthy {
  leader: LeaderInfo;
  standby: StandbyInfo;
  health: { pid: number; head?: string; epoch?: string; slot?: string };
  gateway: GatewayStats;
}

interface Verdict {
  targets: Record<string, TargetSummary>;
  failures: ProbeResult[];
  outages: WsOutage[];
  extra: Record<string, unknown>;
  report: Record<string, unknown>;
}
let verdict: Verdict | undefined;

async function main(): Promise<number> {
  // 1. A clean checkout, cloned into a scratch root.
  const hostEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: REAL_HOME };
  const dirty = await mustRun("git status", ["git", "-C", WORKTREE, "status", "--porcelain"], { cwd: WORKTREE, env: hostEnv, timeoutMs: 30_000 });
  if (dirty) {
    console.error(`The worktree has uncommitted changes; commit them first (the check clones HEAD):\n${dirty}`);
    return 2;
  }
  const head = await mustRun("git rev-parse", ["git", "-C", WORKTREE, "rev-parse", "--verify", `${FROM_REV ?? "HEAD"}^{commit}`], { cwd: WORKTREE, env: hostEnv, timeoutMs: 10_000 });
  const toHead = TO_REV
    ? await mustRun("git rev-parse", ["git", "-C", WORKTREE, "rev-parse", "--verify", `${TO_REV}^{commit}`], { cwd: WORKTREE, env: hostEnv, timeoutMs: 10_000 })
    : undefined;

  state.liveBefore = await snapshotLive();
  const root = realpathSync(mkdtempSync("/tmp/standup-zd-"));
  state.root = root;
  logPath = join(root, "check.log");
  const install = join(root, "install");
  const dataDir = join(root, "data");
  state.install = install;
  state.dataDir = dataDir;
  const id = basename(root).replace(/^standup-zd-/, "").replace(/[^A-Za-z0-9]/g, "");
  state.runId = id;
  const home = join(root, "home");
  const workDir = join(root, "work");
  const noHooks = join(root, "no-hooks");
  const binDir = join(root, "bin");
  for (const dir of [dataDir, home, workDir, noHooks, binDir, join(root, "knowledge"), join(root, "icons"), join(root, "internal"), join(root, "worktrees"), join(root, "tmp"), join(root, "tmux"), join(root, "claude-config")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  log(`scratch root ${root} (run ${id}); cloning ${WORKTREE} at ${head.slice(0, 12)}`);

  // A PATH without the live install's node_modules/.bin entries or ollama
  // (dev.ts would otherwise start or pull an ollama model): bun, node, the
  // system dirs, and a private bin with ripgrep.
  const rg = Bun.which("rg");
  if (rg) symlinkSync(rg, join(binDir, "rg"));
  const node = Bun.which("node");
  const pathDirs = [dirname(process.execPath), ...(node ? [dirname(node)] : []), binDir, "/usr/bin", "/bin"];
  const PATH = [...new Set(pathDirs)].join(":");
  for (const tool of ["bun", "git", "tmux", "ps", "sh", "touch"]) {
    if (!Bun.which(tool, { PATH })) throw new Error(`${tool} is not on the scratch PATH (${PATH})`);
  }

  const markerEnv = { [RUN_MARKER_VAR]: id };
  const gitEnv: NodeJS.ProcessEnv = { PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...markerEnv };
  // --no-checkout: no checkout hook runs before core.hooksPath is pinned.
  const cloneArgs = (mode: string) => ["git", "-c", `core.hooksPath=${noHooks}`, "clone", mode, "--no-hardlinks", "--no-checkout", "-q", WORKTREE, install];
  const cloned = await run(cloneArgs("--local"), { cwd: root, env: gitEnv, timeoutMs: 300_000 });
  if (cloned.code !== 0) {
    log(`git clone --local failed (exit ${cloned.code}): ${cloned.stderr.trim().slice(-300)}; retrying with --no-local`);
    rmSync(install, { recursive: true, force: true });
    await mustRun("git clone --no-local", cloneArgs("--no-local"), { cwd: root, env: gitEnv, timeoutMs: 300_000 });
  }
  const git = (...rest: string[]) => ["git", "-C", install, ...rest];
  await mustRun("git config", git("config", "core.hooksPath", noHooks), { cwd: install, env: gitEnv, timeoutMs: 10_000 });
  await mustRun(`git cat-file ${head.slice(0, 12)}`, git("cat-file", "-e", `${head}^{commit}`), { cwd: install, env: gitEnv, timeoutMs: 10_000 });
  // On `main`, the branch a redeploy follows by default, like the live install.
  await mustRun("git checkout", git("checkout", "-q", "-B", "main", head), { cwd: install, env: gitEnv, timeoutMs: 120_000 });
  // Nothing in the clone can push back to the worktree.
  await mustRun("git remote remove", git("remote", "remove", "origin"), { cwd: install, env: gitEnv, timeoutMs: 10_000 });
  if (existsSync(join(install, "packages", "slack", ".env"))) throw new Error("the clone has packages/slack/.env; refusing to start Slack from a scratch run");
  if (!existsSync(join(install, "packages", "gateway", "src", "cli.ts"))) throw new Error("the clone has no packages/gateway (is the gateway committed?)");

  // 2. Spare ports below the ephemeral range, and the slot ports they imply.
  const forbidden = livePorts();
  const ports: ChosenPorts = await pickPorts({ isFree: portFree, forbidden, collectorRange: COLLECTOR_RANGE, webRange: WEB_RANGE, maxPort: MAX_PORT });
  assertPortsSafe(ports, forbidden, MAX_PORT);
  log(`ports: web ${ports.web}, vite ${ports.vite}, collector ${ports.collector}, ws ${ports.ws} (slots a ${ports.collector + 10_000}/${ports.ws + 10_000}, b ${ports.collector + 20_000}/${ports.ws + 20_000})`);

  // 3. A scratch environment, built from scratch rather than inherited, so no
  // live STANDUP_*/TMUX/CLAUDE_* variable leaks in. HOME is scratch too, so
  // anything that falls back to ~ (write token, ~/.claude.json, caches) lands
  // under the root; only bun's package cache is shared, to keep installs fast.
  const fullRestartFlag = join(root, "full-restart-requested");
  const env: NodeJS.ProcessEnv = {
    PATH,
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME ?? process.env.USER,
    SHELL: "/bin/sh",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    TERM: "dumb",
    TMPDIR: join(root, "tmp"),
    TMUX_TMPDIR: join(root, "tmux"),
    // The collector's legacy-server tmux calls (tmux-launch.ts legacyTmux) take
    // their socket from $TMUX, so they too name a scratch socket outright.
    TMUX: `${join(root, "tmux", "legacy.sock")},0,0`,
    BUN_INSTALL_CACHE_DIR: join(REAL_HOME, ".bun", "install", "cache"),
    ...markerEnv,
    CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    DB_PATH: join(dataDir, "standup.db"),
    KNOWLEDGE_DIR: join(root, "knowledge"),
    ICONS_DIR: join(root, "icons"),
    STANDUP_PROJECTS_PATH: join(root, "projects.toml"),
    STANDUP_WRITE_TOKEN_FILE: join(root, "write-token"),
    STANDUP_OWNER_TOKEN_FILE: join(dataDir, "secrets", "owner.token"),
    STANDUP_INTERNAL_ROOT: join(root, "internal"),
    STANDUP_WORKTREE_ROOT: join(root, "worktrees"),
    STANDUP_SELF_REPO: install,
    STANDUP_GATEWAY: "1",
    STANDUP_GATEWAY_MAX_HELD: GATEWAY_MAX_HELD,
    STANDUP_WEB_PORT: String(ports.web),
    STANDUP_VITE_PORT: String(ports.vite),
    COLLECTOR_PORT: String(ports.collector),
    WS_PORT: String(ports.ws),
    STANDUP_BIND_HOST: "127.0.0.1",
    STANDUP_WEB_URL: `http://127.0.0.1:${ports.web}/`,
    STANDUP_GATEWAY_IDLE_EXIT_MS: "180000",
    ...(PERSONA_STUB ? { STANDUP_PERSONA: "1", STANDUP_PERSONA_STUB_TURNS: "1" } : { STANDUP_PERSONA: "0" }),
    ...(BOOT_TIMEOUT_S ? { STANDUP_RESTART_BOOT_TIMEOUT_S: BOOT_TIMEOUT_S } : {}),
    STANDUP_DIGEST: "0",
    STANDUP_KB_NIGHTLY_SWEEP: "0",
    STANDUP_KNOWLEDGE_REVERIFY: "0",
    NTFY_TOPIC: "",
    NTFY_OWNER_TOPICS: "",
    STANDUP_HOST_HEADROOM: "0",
    STANDUP_REAPER_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_TASK_RUN_SWEEP_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_REVIEW_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_KNOWLEDGE_DISTILL_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_KNOWLEDGE_REVERIFY_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_KB_NIGHTLY_SWEEP_INTERVAL_MS: MAX_TIMER_MS,
    STANDUP_NATIVE_MEMORY_EXCLUDE_HOME: "1",
    EMBEDDING_PROVIDER: "",
    STANDUP_DISABLE_VEC: "1",
    STANDUP_REDEPLOY_FULL_RESTART_CMD: `touch ${fullRestartFlag}`,
  };
  writeFileSync(join(root, "env.json"), JSON.stringify(env, null, 2) + "\n", { mode: 0o600 });

  const install1 = await run(["bun", "install", "--frozen-lockfile"], { cwd: install, env, timeoutMs: 300_000 });
  if (install1.code !== 0) {
    log(`bun install --frozen-lockfile failed (exit ${install1.code}): ${(install1.stderr || install1.stdout).trim().slice(-400)}; retrying without --frozen-lockfile`);
    await mustRun("bun install", ["bun", "install"], { cwd: install, env, timeoutMs: 300_000 });
  }

  const webUrl = `http://127.0.0.1:${ports.web}`;
  const collectorUrl = `http://127.0.0.1:${ports.collector}`;
  const statsUrl = `${collectorUrl}${GATEWAY_STATS_PATH}`;

  /** Gateway up, a leader serving /health through it, the UI answering, and a live standby. */
  const waitHealthy = async (label: string, timeoutMs: number, notPids: ReadonlySet<number> = new Set()): Promise<Healthy> => {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1_000, deadline - Date.now());
    const gateway = await waitFor(
      `${label}: gateway stats on ${statsUrl}`,
      async () => {
        const s = (await getJson<GatewayStats>(statsUrl, 2_000))?.json;
        return typeof s?.pid === "number" ? s : undefined;
      },
      { timeoutMs: left(), intervalMs: 500 }
    );
    const { leader, health } = await waitFor(
      `${label}: a collector leader answering /health through the gateway`,
      async () => {
        const l = readJsonFile<LeaderInfo>(leaderFilePath(dataDir));
        if (!l) throw new Error("no collector-leader.json yet");
        if (!pidAlive(l.pid)) throw new Error(`leader pid ${l.pid} is not alive`);
        if (notPids.has(l.pid)) throw new Error(`the leader is still pid ${l.pid}`);
        const h = await getJson<Healthy["health"]>(`${collectorUrl}/health`, 2_000);
        if (h?.json?.pid !== l.pid) throw new Error(`/health answered ${h ? `${h.status} ${h.text.slice(0, 120)}` : "nothing"}`);
        return { leader: l, health: h.json };
      },
      { timeoutMs: left(), intervalMs: 500 }
    );
    await waitFor(`${label}: the UI on ${webUrl}/`, async () => ((await getJson(`${webUrl}/`, 3_000))?.status === 200 ? true : undefined), { timeoutMs: left(), intervalMs: 500 });
    const standby = await waitFor(
      `${label}: a live standby`,
      () => {
        const s = readJsonFile<StandbyInfo>(standbyFilePath(dataDir));
        if (!s) throw new Error("no collector-standby.json");
        if (!pidAlive(s.pid)) throw new Error(`standby pid ${s.pid} is not alive`);
        if (s.pid === leader.pid || notPids.has(s.pid)) throw new Error(`standby file names pid ${s.pid}`);
        return s;
      },
      { timeoutMs: left(), intervalMs: 500 }
    );
    log(`${label}: healthy — leader pid ${leader.pid} slot ${leader.slot} epoch ${leader.epoch} head ${leader.head?.slice(0, 12)}; standby pid ${standby.pid} slot ${standby.slot} head ${standby.head?.slice(0, 12)}; gateway pid ${gateway.pid}`);
    return { leader, standby, health, gateway };
  };

  // 4. Boot.
  const dev1 = startDev(env, 1);
  const boot = await waitHealthy("boot", BOOT_TIMEOUT_MS);
  const gatewayPid = boot.gateway.pid;
  if (!(await isRunPid(gatewayPid))) throw new Error(`the gateway answering on ${ports.collector} (pid ${gatewayPid}) is not this run's`);

  // 5. The WebSocket observer, dialing the UI origin's /ws like a browser.
  const wsLog = join(root, "ws.jsonl");
  const observer = new WsObserver({
    baseUrl: `ws://127.0.0.1:${ports.web}/ws`,
    create: (url) => new WebSocket(url) as unknown as WsLike,
    clock: realClock,
    connectTimeoutMs: HOLD_MS + 15_000,
    onEvent: (e) => appendFileSync(wsLog, JSON.stringify(e) + "\n"),
  });
  state.observer = observer;
  observer.start();
  await waitFor("the WebSocket observer's first hello-ok", () => (observer.open ? true : undefined), { timeoutMs: 30_000, intervalMs: 200 });

  // 6. A simulated worker on a private tmux server (no config file, plain sh),
  // registered with the scratch collector as a real session by its
  // SessionStart hook. Its cwd is a scratch dir no project claims and no
  // internal-cwd rule ignores, so it is homed in `scratch`.
  state.tmuxSock = `zd-${id}`;
  state.tmuxEnv = { PATH, HOME: home, USER: process.env.USER, LANG: env.LANG, TMUX_TMPDIR: join(root, "tmux"), TERM: "xterm", SHELL: "/bin/sh", ...markerEnv };
  await mustRun("tmux new-session", tmuxArgv("new-session", "-d", "-s", "zd-worker", "-c", workDir, "sleep 100000"), { cwd: workDir, env: state.tmuxEnv, timeoutMs: 10_000 });
  const workerPid = Number.parseInt(await mustRun("tmux list-panes", tmuxArgv("list-panes", "-t", "zd-worker", "-F", "#{pane_pid}"), { cwd: root, env: state.tmuxEnv, timeoutMs: 10_000 }), 10);
  state.workerPid = workerPid;
  // The tmux server daemonizes into a session of its own, so neither it nor
  // the worker it parents is in a group this script started: record both.
  const tmuxServerPid = Number.parseInt(await mustRun("tmux display-message", tmuxArgv("display-message", "-p", "#{pid}"), { cwd: root, env: state.tmuxEnv, timeoutMs: 10_000 }), 10);
  adoptRunPids([tmuxServerPid, workerPid], await processTable());
  const sessionId = randomUUID();
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  const started = await postJson(`${collectorUrl}/hook`, { session_id: sessionId, hook_event_name: "SessionStart", source: "startup", cwd: workDir, transcript_path: transcriptPath });
  if (started.status !== 200) throw new Error(`the worker's SessionStart hook answered ${started.status}: ${started.text.slice(0, 200)}`);
  type SessionView = { id: string; endedAt?: string | null; status?: string; projectId?: string };
  const activeSession = async (): Promise<SessionView | undefined> => {
    const r = await getJson<SessionView[]>(`${webUrl}/api/sessions`);
    return Array.isArray(r?.json) ? r.json.find((s) => s.id === sessionId && !s.endedAt) : undefined;
  };
  const registered = await waitFor("the worker's session in /api/sessions", activeSession, { timeoutMs: 15_000, intervalMs: 300 });
  log(`tmux worker pid ${workerPid} on socket -L ${state.tmuxSock}; session ${sessionId} (project ${registered.projectId}, status ${registered.status})`);

  // 7. The worker's state that a restart must not lose: a checkpoint, and a
  // pending ask whose waiter re-sends with its request id whenever a draining
  // collector releases it, the way the MCP client re-attaches.
  type CheckpointView = { id: string; sessionId: string; summary: string };
  type AskView = { id: string; sessionId: string; question: string; status?: string };
  const findCheckpoint = (summary: string) =>
    waitFor(
      `checkpoint "${summary}"`,
      async () => {
        const r = await getJson<CheckpointView[]>(`${collectorUrl}/api/checkpoints?limit=200`);
        return Array.isArray(r?.json) ? r.json.find((c) => c.sessionId === sessionId && c.summary === summary) : undefined;
      },
      { timeoutMs: 15_000, intervalMs: 300 }
    );
  const checkpointSummary = `zd-check checkpoint ${id}`;
  const cp = await postJson(`${collectorUrl}/api/checkpoint`, { session_id: sessionId, cwd: workDir, summary: checkpointSummary });
  if (cp.status !== 200) throw new Error(`POST /api/checkpoint answered ${cp.status}: ${cp.text.slice(0, 200)}`);
  const checkpointId = (await findCheckpoint(checkpointSummary)).id;

  const askQuestion = `zd-check pending ask ${id}`;
  const askRequestId = `zd-check-${id}`;
  const askAbort = new AbortController();
  const waiterResults: Array<{ at: number; status: number; draining?: string; body: string }> = [];
  const askWaiterDone = (async () => {
    while (!askAbort.signal.aborted && !tearingDown) {
      const at = Date.now();
      try {
        // A long-poll: Bun's own client-side fetch timeout is off.
        const init: BunFetchRequestInit & { timeout?: boolean } = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, cwd: workDir, question: askQuestion, request_id: askRequestId, timeout_s: 3600 }),
          signal: askAbort.signal,
          timeout: false,
        };
        const res = await fetch(`${collectorUrl}/api/ask`, init);
        const body = await res.text();
        const draining = res.headers.get(DRAINING_HEADER) ?? undefined;
        waiterResults.push({ at, status: res.status, ...(draining ? { draining } : {}), body: body.slice(0, 200) });
        log(`ask waiter: ${res.status}${draining ? ` (${DRAINING_HEADER}: ${draining})` : ""} ${body.slice(0, 120)}`);
        if (!(res.status === 503 && draining === DRAINING_RELEASED)) return;
      } catch (err) {
        if (askAbort.signal.aborted) return;
        waiterResults.push({ at, status: 0, body: String(err).slice(0, 200) });
        log(`ask waiter: ${String(err).slice(0, 160)}`);
        return;
      }
    }
  })();
  state.askWaiter = { abort: askAbort, done: askWaiterDone };
  const pendingAsks = async (): Promise<AskView[]> => {
    const r = await getJson<AskView[]>(`${collectorUrl}/api/asks/pending`);
    return Array.isArray(r?.json) ? r.json.filter((a) => a.sessionId === sessionId) : [];
  };
  const askId = (await waitFor("the worker's pending ask", async () => (await pendingAsks()).find((a) => a.question === askQuestion), { timeoutMs: 15_000, intervalMs: 300 })).id;
  log(`worker state: checkpoint ${checkpointId}, pending ask ${askId} (request id ${askRequestId})`);

  /** After a restart: the worker's session, pane and state survived, in REST and in the new epoch's hello-ok snapshot. */
  const checkWorker = async (label: string, epoch: string | undefined): Promise<void> => {
    const session = await activeSession();
    expect(`${label}: the worker's session is still active`, !!session, session ? `status ${session.status}` : `${sessionId} is not among the active sessions`);
    const alive = (await run(tmuxArgv("has-session", "-t", "zd-worker"), { cwd: root, env: state.tmuxEnv!, timeoutMs: 10_000 })).code === 0;
    const pane = Number.parseInt((await run(tmuxArgv("list-panes", "-t", "zd-worker", "-F", "#{pane_pid}"), { cwd: root, env: state.tmuxEnv!, timeoutMs: 10_000 })).stdout.trim(), 10);
    expect(`${label}: the worker's tmux pane is alive and unchanged`, alive && pane === workerPid && pidAlive(workerPid), `has-session ${alive}, pane pid ${pane} (was ${workerPid})`);
    const ends = observer.frameLog.filter((f) => f.type === "session:end" && f.sessionId === sessionId);
    expect(`${label}: no session:end broadcast for the worker`, ends.length === 0, `${ends.length} seen`);
    const asks = await pendingAsks();
    expect(`${label}: the pending ask survived, with no duplicate`, asks.length === 1 && asks[0].id === askId, `pending for the worker: ${asks.map((a) => a.id).join(", ") || "none"} (want ${askId})`);
    const cps = await getJson<CheckpointView[]>(`${collectorUrl}/api/checkpoints?limit=200`);
    expect(`${label}: the checkpoint survived`, Array.isArray(cps?.json) && cps.json.some((c) => c.id === checkpointId), `checkpoint ${checkpointId}`);
    let hello: WsHello | undefined;
    if (epoch) {
      try {
        hello = await waitFor(`${label}: a hello-ok in epoch ${epoch}`, () => observer.hellos().find((h) => h.epoch === epoch), { timeoutMs: 30_000, intervalMs: 200 });
      } catch {
        hello = undefined;
      }
    }
    const snap = hello?.snapshot;
    expect(
      `${label}: the new epoch's hello-ok snapshot has the worker's session, ask and checkpoint`,
      !!snap && snap.sessions.includes(sessionId) && snap.asks.includes(askId) && snap.checkpoints.includes(checkpointId),
      snap
        ? `session ${snap.sessions.includes(sessionId)}, ask ${snap.asks.includes(askId)}, checkpoint ${snap.checkpoints.includes(checkpointId)}`
        : `no hello-ok${epoch ? ` in epoch ${epoch}` : ""} with a snapshot`
    );
  };

  // 8. Probes. At most one probe per target is in flight, so a held upstream
  // shows as one long probe and skipped ticks rather than a pile-up.
  let phase = "baseline";
  const probesLog = join(root, "probes.jsonl");
  const internalRoot = resolve(join(root, "internal"));
  const json = (pred: (v: unknown) => boolean, what: string) => (r: { body: string }) => {
    try {
      return pred(JSON.parse(r.body)) ? null : `${what}: ${r.body.slice(0, 120)}`;
    } catch {
      return `not JSON: ${r.body.slice(0, 120)}`;
    }
  };
  const targets: ProbeTarget[] = [
    { name: "web-ui", url: `${webUrl}/`, intervalMs: 100, check: (r) => (r.contentType.includes("text/html") || /<!doctype html/i.test(r.body) ? null : `not HTML (${r.contentType})`) },
    { name: "web-api", url: `${webUrl}/api/projects`, intervalMs: 100, check: json((v) => Array.isArray(v), "not a project list") },
    { name: "collector-health", url: `${collectorUrl}/health`, intervalMs: 100, check: json((v) => (v as { status?: unknown })?.status === "ok", "not ok") },
    {
      // A hook from one of Standup's own internal cwds is acknowledged and
      // otherwise ignored (isInternalCwd), so this POST writes nothing.
      name: "hook-post",
      url: `${collectorUrl}/hook`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "zd-probe", hook_event_name: "Notification", cwd: internalRoot }),
      intervalMs: 500,
      check: json((v) => (v as { ok?: unknown })?.ok === true, "no ok ack"),
    },
  ];
  const probes = new ProbeLoop({
    targets,
    fetch: (url, init) => fetch(url, init),
    clock: realClock,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxInflight: 1,
    phase: () => phase,
    onResult: (r) => appendFileSync(probesLog, JSON.stringify(r) + "\n"),
  });
  state.probes = probes;
  const statsAtStart = (await getJson<GatewayStats>(statsUrl))?.json;
  probes.start();
  await sleep(5_000);

  // 9. Same-epoch resume: the observer drops its own socket, a checkpoint is
  // broadcast while it is away, and the reconnect with ?epoch&since must be
  // resumed and replay that frame.
  phase = "resume";
  const dropped = observer.disconnect();
  const droppedConn = observer.connections.length - 1;
  if (dropped) await waitFor("the observer's socket to close", () => (observer.connections[droppedConn].closedAt !== undefined ? true : undefined), { timeoutMs: 10_000, intervalMs: 50 }).catch(() => undefined);
  // Read once the socket is closed, so no frame can still move it.
  const cursor = observer.cursor();
  const resumeSummary = `zd-check resume checkpoint ${id}`;
  const rcp = await postJson(`${collectorUrl}/api/checkpoint`, { session_id: sessionId, cwd: workDir, summary: resumeSummary });
  const resumeCheckpointId = rcp.status === 200 ? (await findCheckpoint(resumeSummary).catch(() => undefined))?.id : undefined;
  await sleep(500);
  observer.reconnect();
  let resumedHello: WsHello | undefined;
  try {
    resumedHello = await waitFor("the observer's resumed hello-ok", () => observer.hellos().find((h) => h.conn > droppedConn), { timeoutMs: 30_000, intervalMs: 100 });
    await sleep(1_000);
  } catch {
    resumedHello = undefined;
  }
  expect(
    "WS: a client-side reconnect within the epoch is resumed",
    dropped && !!resumedHello && resumedHello.resumed === true && resumedHello.epoch === cursor.epoch && resumedHello.serverSeq === cursor.lastSeq,
    resumedHello ? `resumed ${resumedHello.resumed}, epoch ${resumedHello.epoch} (was ${cursor.epoch}), serverSeq ${resumedHello.serverSeq} (since ${cursor.lastSeq})` : `dropped ${dropped}; no hello-ok after the reconnect`
  );
  const replayedFrame = resumedHello ? observer.frameLog.find((f) => f.conn === resumedHello!.conn && f.type === "checkpoint:new" && f.id === resumeCheckpointId) : undefined;
  expect(
    "WS: the frame broadcast while disconnected was replayed",
    !!resumeCheckpointId && !!replayedFrame && (replayedFrame.seq ?? -1) > (cursor.lastSeq ?? Number.MAX_SAFE_INTEGER),
    resumeCheckpointId ? (replayedFrame ? `checkpoint:new seq ${replayedFrame.seq} after since ${cursor.lastSeq}` : `checkpoint:new ${resumeCheckpointId} not received on the resumed connection`) : `POST /api/checkpoint answered ${rcp.status}: ${rcp.text.slice(0, 120)}`
  );
  phase = "resume:settle";
  await sleep(SETTLE_MS);

  if (FILL_DB_MB > 0) {
    // Filler the next pre-migration copy has to write out, in 256 MB transactions.
    phase = "A:fill-db";
    const dbFile = env.DB_PATH!;
    const fill = new Database(dbFile);
    fill.exec("PRAGMA busy_timeout = 30000");
    fill.exec("CREATE TABLE IF NOT EXISTS zd_fill (b BLOB)");
    const insert = fill.prepare("INSERT INTO zd_fill (b) SELECT randomblob(1048576) FROM (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT i FROM n)");
    for (let left = FILL_DB_MB; left > 0; left -= 256) {
      insert.run(Math.min(256, left));
      fill.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    fill.close();
    log(`A: grew the scratch database to ${Math.round(statSync(dbFile).size / 1e6)} MB`);
  }

  // 10. Scenario A: a collector-only commit, redeployed through the hook path.
  phase = "A:redeploy";
  const statsBeforeA = (await getJson<GatewayStats>(statsUrl))?.json;
  if (toHead) {
    await mustRun(`git merge --ff-only ${toHead.slice(0, 12)}`, git("merge", "-q", "--ff-only", toHead), { cwd: install, env: gitEnv, timeoutMs: 120_000 });
  } else {
    const indexPath = join(install, "packages", "collector", "src", "index.ts");
    appendFileSync(indexPath, `// zd-check ${new Date().toISOString()}\n`);
    const files = ["packages/collector/src/index.ts"];
    if (WITH_MIGRATION) {
      const migrationsPath = join(install, "packages", "store", "src", "migrations.ts");
      const added = withNoOpMigration(readFileSync(migrationsPath, "utf8"));
      if (!added) throw new Error("--with-migration: can't find the end of VERSIONED_MIGRATIONS in migrations.ts");
      const { version } = added;
      writeFileSync(migrationsPath, added.source);
      files.push("packages/store/src/migrations.ts");
      log(`A: the commit adds no-op migration ${version}`);
    }
    const commitEnv = { ...gitEnv, GIT_AUTHOR_NAME: "zd-check", GIT_AUTHOR_EMAIL: "zd-check@localhost", GIT_COMMITTER_NAME: "zd-check", GIT_COMMITTER_EMAIL: "zd-check@localhost" };
    await mustRun("git commit", git("commit", "-q", "-m", "zd-check: trivial collector change", "--", ...files), { cwd: install, env: commitEnv, timeoutMs: 30_000 });
  }
  const newHead = await mustRun("git rev-parse", git("rev-parse", "HEAD"), { cwd: install, env: gitEnv, timeoutMs: 10_000 });
  log(`A: committed ${newHead.slice(0, 12)}; running standup-redeploy post-merge`);
  const startedA = Date.now();
  const redeploy = await run(["bun", join(install, "scripts", "standup-redeploy.ts"), "post-merge"], { cwd: install, env, timeoutMs: 240_000 });
  writeFileSync(join(root, "redeploy.log"), `exit ${redeploy.code}\n--- stdout\n${redeploy.stdout}\n--- stderr\n${redeploy.stderr}\n`);
  const redeployLine = redeploy.stdout.trim().split("\n").at(-1) ?? "";
  log(`A: redeploy exited ${redeploy.code}: ${redeployLine}`);
  const restartId = redeployLine.match(/\(restart ([0-9a-f]{6,}),/)?.[1];
  const fullRestartTaken = existsSync(fullRestartFlag);
  expect("A: redeploy asked the collector (no full restart)", redeploy.code === 0 && !!restartId && !fullRestartTaken, redeployLine || redeploy.stderr.trim().slice(-200));

  let record: RestartRecordView | undefined;
  let afterA: Healthy | undefined;
  if (fullRestartTaken) {
    // The flag stands in for systemctl; scenario B below is that full
    // restart, so the run carries on from there.
    log("A: the redeploy chose a full restart (STANDUP_REDEPLOY_FULL_RESTART_CMD ran); scenario B performs it");
    rmSync(fullRestartFlag, { force: true });
  }
  if (restartId) {
    try {
      record = await waitFor(
        `A: restart ${restartId} to finish`,
        () => {
          const r = readJsonFile<RestartRecordView>(join(dataDir, "restart", "current.json"));
          if (!r) throw new Error("no restart/current.json");
          if (r.id !== restartId) throw new Error(`current.json is restart ${r.id}`);
          if (r.phase !== "done") throw new Error(`phase ${r.phase}`);
          return r;
        },
        { timeoutMs: RESTART_TIMEOUT_MS, intervalMs: 500 }
      );
    } catch (err) {
      expect("A: restart finished", false, (err as Error).message);
    }
  }
  if (record) {
    const duration = record.finishedAt ? Date.parse(record.finishedAt) - Date.parse(record.requestedAt) : undefined;
    log(`A: restart ${record.id} done: outcome ${record.outcome}, mode ${record.mode}, ${duration}ms; userImpact ${JSON.stringify(record.userImpact)}`);
    expect("A: restart outcome ok", record.outcome === "ok", `outcome ${record.outcome}${record.error ? `: ${record.error}` : ""}`);
    expect("A: restart handed off to the standby", record.mode === "handoff", `mode ${record.mode}`);
    expect("A: restart recorded userImpact", !!record.userImpact, JSON.stringify(record.userImpact ?? null));
    try {
      afterA = await waitHealthy("after A", 90_000, new Set([boot.leader.pid]));
      expect("A: a new leader runs the new commit", afterA.leader.head === newHead && afterA.health.head === newHead, `leader ${afterA.leader.pid} head ${afterA.leader.head?.slice(0, 12)}, /health head ${afterA.health.head?.slice(0, 12)}, want ${newHead.slice(0, 12)}`);
    } catch (err) {
      expect("A: healthy after the restart", false, (err as Error).message);
    }
  }
  phase = "A:settle";
  await sleep(SETTLE_MS);
  const statsAfterA = (await getJson<GatewayStats>(statsUrl))?.json;
  await checkWorker("A", afterA?.leader.epoch);
  log(`A: took ${Date.now() - startedA}ms end to end`);

  // 11. Scenario B: dev.ts restarted the way systemd's KillMode=process does it.
  phase = "B:restart";
  const beforeB = afterA ?? boot;
  const oldCollectors = new Set([beforeB.leader.pid, beforeB.standby.pid]);
  const startedB = Date.now();
  log(`B: SIGTERM dev.ts ${dev1.pid} only`);
  signal(dev1.pid, "SIGTERM");
  const dev1Exited = await Promise.race([dev1.exited.then(() => true), sleep(20_000).then(() => false)]);
  expect("B: dev.ts exited on SIGTERM", dev1Exited, dev1Exited ? `pid ${dev1.pid} exited` : `pid ${dev1.pid} still running after 20s`);
  if (!dev1Exited && !dev1.done) signal(dev1.pid, "SIGKILL");
  startDev(env, 2);
  let afterB: Healthy | undefined;
  try {
    afterB = await waitHealthy("after B", BOOT_TIMEOUT_MS, oldCollectors);
    expect("B: a fresh leader serves after the full restart", !oldCollectors.has(afterB.leader.pid), `leader ${afterB.leader.pid} (old ${[...oldCollectors].join(", ")}), took ${Date.now() - startedB}ms`);
  } catch (err) {
    expect("B: healthy after the full restart", false, (err as Error).message);
  }
  const lingering: number[] = [];
  for (const pid of oldCollectors) if (!(await waitExit(pid, 20_000))) lingering.push(pid);
  expect("B: the old collectors exited", lingering.length === 0, lingering.length ? `still alive: ${lingering.join(", ")}` : "both gone");
  phase = "B:settle";
  await sleep(SETTLE_MS);
  await checkWorker("B", afterB?.leader.epoch);
  const statsAfterB = (await getJson<GatewayStats>(statsUrl))?.json;
  const onLive = await runListenersOnLivePorts();
  if (onLive) expect("no process of the run listens on a live port (after B)", onLive.length === 0, onLive.length ? onLive.join(", ") : "none");
  else log("live ports: ss unavailable; listener check skipped");

  // 12. Stop probing and judge.
  phase = "done";
  await probes.stop();
  const targetSummary = summarize(probes.results, probes.skipped, SOFT_BUDGET_MS);
  const failures: ProbeResult[] = probes.results.filter((r) => r.outcome !== "ok");
  const refused = probes.results.filter((r) => r.outcome === "refused");
  expect("zero refused connections (web and collector ports)", refused.length === 0, `${refused.length} refused`);
  expect(
    "zero failed probes (refused, reset, non-2xx, timeout, error, unexpected body)",
    failures.length === 0,
    failures.length ? `${failures.length} failed: ${[...new Set(failures.map((f) => `${f.target}/${f.outcome}`))].join(", ")}` : `${probes.results.length} probes ok`
  );
  const skippedTotal = Object.values(probes.skipped).reduce((a, b) => a + b, 0);
  const overBudget = Object.values(targetSummary).reduce((a, s) => a + s.overBudget, 0);
  log(`probes: ${skippedTotal} tick(s) skipped while a probe of the same target was in flight; ${overBudget} ok probe(s) over the ${SOFT_BUDGET_MS}ms soft budget`);
  if (overBudget > 0) warn(`${overBudget} probe(s) succeeded but took longer than ${SOFT_BUDGET_MS}ms`);

  const waiterBad = waiterResults.filter((w) => !(w.status === 503 && w.draining === DRAINING_RELEASED));
  expect("ask waiter: only released by draining collectors, never failed or answered", waiterBad.length === 0, waiterBad.length ? waiterBad.map((w) => `${w.status} ${w.body.slice(0, 80)}`).join("; ") : `${waiterResults.length} release(s), re-attached each time`);
  askAbort.abort();

  const hellos = observer.hellos();
  const wsOpen = observer.open;
  observer.stop();
  const outages = observer.outages();
  const neverOpened = observer.neverOpened();
  if (afterA) expect("WS: fresh hello-ok after A", hellos.some((h) => h.epoch === afterA!.leader.epoch), `epochs seen: ${[...new Set(hellos.map((h) => h.epoch))].join(", ")}`);
  if (afterB) expect("WS: fresh hello-ok after B", hellos.some((h) => h.epoch === afterB!.leader.epoch), `epochs seen: ${[...new Set(hellos.map((h) => h.epoch))].join(", ")}`);
  expect("WS: the last connection was open at the end", wsOpen, `${observer.connections.length} connection(s) dialed`);
  expect("WS: every dial opened", neverOpened.length === 0, neverOpened.length ? neverOpened.map((c) => `${c.url} closed ${c.closeCode}`).join("; ") : `${observer.connections.length} dial(s)`);
  const longestWs = Math.max(0, ...outages.filter((o) => !o.deliberate).map((o) => o.gapMs));
  expect(`WS: no disconnection longer than the ${HOLD_MS / 1000}s hold`, longestWs < HOLD_MS, `longest ${longestWs}ms`);

  const finalGateway = statsAfterB ?? (await getJson<GatewayStats>(statsUrl))?.json;
  expect("the gateway never restarted", finalGateway?.pid === gatewayPid && pidAlive(gatewayPid), `pid ${finalGateway?.pid} (was ${gatewayPid})`);
  const failedDelta = finalGateway && statsAtStart ? finalGateway.failed - statsAtStart.failed : undefined;
  expect("the gateway failed no request during the run", failedDelta === 0, failedDelta === undefined ? "gateway stats unavailable" : `failed ${statsAtStart!.failed} -> ${finalGateway!.failed}`);

  // 13. The report (written, with the live-state guard, after teardown).
  const pickStats = (s: GatewayStats | undefined) => (s ? { pid: s.pid, held: s.held, heldNow: s.heldNow, maxHoldMs: s.maxHoldMs, failed: s.failed, retried: s.retried, wsUpstreamCloses: s.wsUpstreamCloses } : null);
  const frameTypes: Record<string, number> = {};
  for (const f of observer.frameLog) frameTypes[f.type] = (frameTypes[f.type] ?? 0) + 1;
  const extra = {
    "gateway stats (probes start)": pickStats(statsAtStart),
    "gateway stats (before A)": pickStats(statsBeforeA),
    "gateway stats (after A)": pickStats(statsAfterA),
    "gateway stats (after B)": pickStats(statsAfterB),
    "restart record": record ? { id: record.id, outcome: record.outcome, mode: record.mode, requestedAt: record.requestedAt, finishedAt: record.finishedAt, durationMs: record.finishedAt ? Date.parse(record.finishedAt) - Date.parse(record.requestedAt) : null } : null,
    "restart userImpact": record?.userImpact ?? null,
    "probe ticks skipped (one already in flight)": probes.skipped,
    "ok probes over the soft budget": overBudget,
    "longest wait a probe saw (ms)": Math.max(0, ...Object.values(targetSummary).map((s) => s.maxOkMs)),
    "longest WebSocket outage (ms)": longestWs,
    "ask waiter releases": waiterResults.length,
  };
  verdict = {
    targets: targetSummary,
    failures,
    outages,
    extra,
    report: {
      root,
      runId: id,
      head,
      newHead,
      ports,
      env,
      targets: targetSummary,
      skipped: probes.skipped,
      softBudgetMs: SOFT_BUDGET_MS,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      failures,
      worker: { sessionId, workerPid, checkpointId, askId, askRequestId, resumeCheckpointId, waiterResults },
      ws: { connections: observer.connections, hellos, outages, frameTypes, framesDropped: observer.framesDropped, sessionEnds: observer.frameLog.filter((f) => f.type === "session:end") },
      leaders: { boot: boot.leader, afterA: afterA?.leader, afterB: afterB?.leader },
      gateway: { boot: boot.gateway, atStart: statsAtStart, beforeA: statsBeforeA, afterA: statsAfterA, afterB: statsAfterB },
      record: record ?? null,
      redeploy: { code: redeploy.code, line: redeployLine },
      logs: { check: logPath, probes: probesLog, ws: wsLog, dev: [join(root, "dev-1.log"), join(root, "dev-2.log")], gateway: gatewayLogPath(dataDir), redeploy: join(root, "redeploy.log") },
    },
  };
  return assertions.every((a) => a.ok) ? 0 : 1;
}

const watchdog = setTimeout(() => {
  log(`the check ran past ${OVERALL_TIMEOUT_MS / 60_000} min; tearing down`);
  void teardown().finally(() => process.exit(3));
}, OVERALL_TIMEOUT_MS);

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  log(`ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  exitCode = 1;
} finally {
  const survivors = await teardown();
  clearTimeout(watchdog);
  expect("no process of the run survived teardown", survivors.length === 0, survivors.length ? survivors.join(" | ") : "none");
  let guard: Record<string, unknown> = {};
  try {
    guard = await liveGuard();
  } catch (err) {
    expect("live-state guard ran", false, String(err));
  }
  const ok = assertions.every((a) => a.ok);
  if (exitCode === 0 && !ok) exitCode = 1;
  if (state.root) {
    const report = { ok: exitCode === 0, ...(verdict?.report ?? { root: state.root }), assertions, warnings, liveGuard: guard };
    try {
      writeFileSync(join(state.root, "report.json"), JSON.stringify(report, null, 2) + "\n");
    } catch (err) {
      log(`could not write report.json: ${String(err)}`);
    }
    console.log(
      formatSummary({
        root: state.root,
        ok: exitCode === 0,
        targets: verdict?.targets ?? {},
        failures: verdict?.failures ?? [],
        assertions,
        wsOutages: verdict?.outages ?? [],
        softBudgetMs: SOFT_BUDGET_MS,
        warnings,
        extra: verdict?.extra,
      })
    );
    if (CLEANUP && survivors.length === 0) {
      rmSync(state.root, { recursive: true, force: true });
      console.log(`removed ${state.root}`);
    } else {
      console.log(`scratch root kept: ${state.root} (report.json, check.log, probes.jsonl, ws.jsonl, dev-*.log, redeploy.log, data/gateway/gateway.log)`);
    }
  }
}
process.exit(exitCode);
