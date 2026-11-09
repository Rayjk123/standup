#!/usr/bin/env bun
/**
 * Redeploys the Standup install this script sits in after its code changed —
 * the post-merge (or post-checkout) hook's job:
 *
 *   bun scripts/standup-redeploy.ts [hook-name]
 *
 * It runs `bun install --frozen-lockfile` (a failure is logged, not fatal),
 * then picks how to restart:
 *
 *   - When a file only a full restart loads (FULL_RESTART_PATHS: scripts/dev.ts,
 *     scripts/dev-topology.ts, the gateway, the shared topology and process
 *     identity) changed between the commit dev.ts booted on (dev.json
 *     `head`) and HEAD — or that commit is unknown (no dev.json, as on the
 *     first rollout from an install that predates it) — only a full restart
 *     loads them: `systemctl --user restart --no-block standup.service`, or
 *     the shell command in STANDUP_REDEPLOY_FULL_RESTART_CMD. The gateway
 *     outlives it and holds the front door meanwhile.
 *   - Otherwise it asks the running collector for a redeploy
 *     (POST /api/standup/restart, `{source: "redeploy"}`, with the per-user
 *     local write token), which hands off to the warm standby in gateway
 *     mode, is a no-op when HEAD is what already runs, and is coalesced into
 *     a restart already under way.
 *   - Nothing answering, the gateway answering that no collector leads (its
 *     fail-fast 503), or the collector refusing because it runs as a slot
 *     with no dev.ts to hand off through (a 409 beginning
 *     NO_DEV_SLOT_REFUSAL), gets the full restart. Any other refusal (409,
 *     429, other 5xx) is printed and the script exits non-zero, restarting
 *     nothing.
 *   - Run from an install other than the one dev.json names (a worktree of
 *     the repository, say), it refuses and restarts nothing.
 *
 * After a full restart it waits (up to FULL_RESTART_SETTLE_MS) for a new
 * dev.ts on HEAD and a healthy collector leader that loaded HEAD (only the
 * leader when no dev.json named a dev.ts before), and says whether they
 * came — for the record only: nothing is rolled back. A `pending` line goes
 * to the log before the restart is issued; should the restart stop this
 * script, the collector that boots healthy, or the next redeploy, logs the
 * outcome (restart/full-restart-pending.json).
 *
 * It prints one line saying what it did, and appends every line it prints
 * to `<dataDir>/restart/redeploy.log` with a timestamp.
 */
import { join, resolve } from "path";
import { createSystemExec, isInstallDevScript } from "../packages/collector/src/restart/exec.js";
import type { FullRestartPending } from "../packages/collector/src/restart/state.js";
import {
  appendRedeployLog,
  canonicalPath,
  clearFullRestartPending,
  needsFullRestart,
  readFullRestartPending,
  redeployLogPath,
  sameCommit,
  writeFullRestartPending,
} from "../packages/collector/src/restart/state.js";
import { NO_DEV_SLOT_REFUSAL, timingsFromEnv, worstCaseMs } from "../packages/collector/src/restart/supervisor.js";
import { pidAlive } from "../packages/shared/src/process-identity.js";
import type { DevInfo } from "../packages/shared/src/topology.js";
import { GATEWAY_REASON, GATEWAY_REASON_HEADER, dataDirFromEnv, devFilePath, publicPorts, readJsonFile } from "../packages/shared/src/topology.js";
import { localWriteTokenPath, readLocalWriteToken } from "../packages/shared/src/write-token.js";

/** Files only a full restart loads (dev.ts's own code, the gateway's, and the topology both share), and the filter by them. */
export { FULL_RESTART_PATHS, needsFullRestart } from "../packages/collector/src/restart/state.js";
/** The redeploy log (`<dataDir>/restart/redeploy.log`) and its timestamped append. */
export { appendRedeployLog, redeployLogPath } from "../packages/collector/src/restart/state.js";

/** The gateway's reasons (GATEWAY_REASON_HEADER) that mean no collector leads. */
const NO_LEADER_REASONS: ReadonlySet<string> = new Set([GATEWAY_REASON.noLeader, GATEWAY_REASON.holdTimeout]);

export const DEFAULT_FULL_RESTART: readonly string[] = ["systemctl", "--user", "restart", "--no-block", "standup.service"];

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The redeploy's effects; tests pass fakes. */
export interface RedeployDeps {
  /** The install: the repository root this script sits in. */
  installDir: string;
  /** The collector's public base URL. */
  collectorUrl: string;
  /** STANDUP_REDEPLOY_FULL_RESTART_CMD, when set: the full restart as a shell command. */
  fullRestartCmd?: string;
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
  shell(command: string, cwd: string): Promise<CommandResult>;
  /** POSTs JSON; status 0 when nothing answered (`body` then holds the error). Header names are lower-case. */
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  /** dev.json, while the pid it names is this install's dev.ts (not just a live pid); undefined otherwise. */
  readDev(): DevInfo | undefined | Promise<DevInfo | undefined>;
  readWriteToken(): string | undefined;
  /** A restart is under way (restart/current.json not done; see restartUnderwayIn). */
  restartUnderway(): boolean;
  sleep(ms: number): Promise<void>;
  /** How long a full restart waits for a restart under way to finish (default FULL_RESTART_WAIT_MS). */
  waitMs?: number;
  log(line: string): void;
  /** The bun that runs `bun install` (default process.execPath, this very bun). */
  bunPath?: string;
  /** The install dev.json names, whether or not its dev.ts still runs; undefined without one. */
  devInstallDir?(): string | undefined;
  /** Appends a line to the redeploy log (restart/redeploy.log), timestamped. */
  appendLog?(line: string): void;
  /**
   * The collector's /health through its public URL: status 0 when nothing
   * answered. Without it a full restart is not waited on.
   */
  readHealth?(): Promise<{ status: number; body: string }>;
  /** How long a full restart's outcome is waited for (default FULL_RESTART_SETTLE_MS). */
  settleMs?: number;
  /**
   * restart/full-restart-pending.json: written before a full restart is
   * issued and removed once its outcome is logged, so a script the restart
   * stopped leaves the outcome to the next redeploy or the collector that
   * boots. Without it nothing is recorded.
   */
  pending?: {
    read(): FullRestartPending | null;
    write(pending: FullRestartPending): void;
    clear(): void;
  };
  /** This script's pid (default process.pid). */
  pid?: number;
  /** Whether `pid` runs (default: every pid counts as gone). */
  isAlive?(pid: number): boolean;
}

/**
 * How long a full restart waits at most for a restart under way, which it
 * would cut off: the longest a restart supervisor runs (worstCaseMs, which
 * covers a handoff's worst case, with the timings it reads from `env`), and
 * a minute more.
 */
export function fullRestartWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  return worstCaseMs(timingsFromEnv(env)) + 60_000;
}

/** fullRestartWaitMs for this process's environment. */
export const FULL_RESTART_WAIT_MS = fullRestartWaitMs();
const WAIT_POLL_MS = 5_000;

/** How long a full restart waits for the new dev.ts and a healthy collector leader on HEAD. */
export const FULL_RESTART_SETTLE_MS = 5 * 60_000;

/**
 * `full`: a full restart came back healthy (or was not waited on);
 * `full-unhealthy`: it was issued, but no healthy leader on HEAD came within
 * the settle time; `refused`: run from an install dev.json doesn't name.
 */
export type RedeployKind = "noop" | "scheduled" | "coalesced" | "full" | "full-unhealthy" | "refused" | "failed";

export interface RedeployOutcome {
  kind: RedeployKind;
  /** The one line printed. */
  line: string;
  exitCode: number;
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : "?");

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Runs the full restart: the configured shell command, else systemctl. A
 * restart already under way is waited out first (up to waitMs): stopping
 * dev.ts mid-restart would fail its health checks and roll the install back.
 * Once issued, it is waited on (awaitFullRestart) when `readHealth` is given:
 * `full-unhealthy` (exit 1) when no healthy leader on `head` came back.
 */
async function fullRestart(deps: RedeployDeps, why: string, prefix: string, head: string): Promise<RedeployOutcome> {
  const issued = await issueFullRestart(deps, why, prefix, head);
  if (issued.kind !== "full" || !deps.readHealth) {
    deps.pending?.clear();
    return { kind: issued.kind, line: issued.line, exitCode: issued.exitCode };
  }
  const settleMs = deps.settleMs ?? FULL_RESTART_SETTLE_MS;
  const what = issued.devPidBefore !== undefined ? "dev.ts and a healthy collector" : "a healthy collector leader";
  deps.log(`${issued.line}; waiting up to ${Math.round(settleMs / 1000)}s for ${what} on ${short(head)}`);
  const settled = await awaitFullRestart(deps, issued, head, settleMs);
  deps.pending?.clear();
  if (settled.ok) return { kind: "full", line: `${issued.line}; ${settled.detail}`, exitCode: 0 };
  return {
    kind: "full-unhealthy",
    line:
      `${issued.line}, but Standup is UNHEALTHY: ${settled.detail}. Nothing was rolled back; ` +
      "see `systemctl --user status standup.service` and `journalctl --user -u standup.service`",
    exitCode: 1,
  };
}

/** The collector's /health, parsed: its status, and the pid and head it reports. */
async function readHealthBody(deps: RedeployDeps): Promise<{ status: number; raw: string; ok: boolean; pid?: unknown; head?: string }> {
  const res = await deps.readHealth!();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // Reported as an unexpected body by the caller.
  }
  return {
    status: res.status,
    raw: res.body,
    ok: res.status === 200 && body.status === "ok",
    pid: body.pid,
    ...(typeof body.head === "string" ? { head: body.head } : {}),
  };
}

/**
 * Polls, for up to `settleMs`, until the full restart is back on `head`.
 * With a dev.ts before it (`devPidBefore`): a dev.ts other than that one
 * runs on `head` (dev.json) and the collector's /health answers ok from a
 * leader that loaded `head`. Without one (an install whose dev.ts writes no
 * dev.json): a healthy leader that reports loading `head` or, reporting no
 * head, is another collector than the one before (`healthPidBefore`).
 * `detail` says what came back, or what was last missing.
 */
async function awaitFullRestart(
  deps: RedeployDeps,
  before: { devPidBefore?: number; healthPidBefore?: unknown },
  head: string,
  settleMs: number
): Promise<{ ok: boolean; detail: string }> {
  const { devPidBefore, healthPidBefore } = before;
  let waited = 0;
  let detail = "nothing was checked";
  for (;;) {
    const dev = devPidBefore !== undefined ? await deps.readDev() : undefined;
    if (devPidBefore !== undefined && !dev) detail = "no dev.ts of this install runs (dev.json)";
    else if (dev && dev.pid === devPidBefore) detail = `dev.ts is still the one from before (pid ${dev.pid})`;
    else if (dev && (!dev.head || !sameCommit(dev.head, head))) detail = `dev.ts (pid ${dev.pid}) runs ${short(dev.head)}, not ${short(head)}`;
    else {
      const health = await readHealthBody(deps);
      const lead = dev ? `dev.ts (pid ${dev.pid}) runs ${short(head)}, but ` : "";
      if (health.status === 0) detail = `${lead}the collector is unreachable: ${clip(health.raw, 120)}`;
      else if (!health.ok) detail = `${lead}the collector's /health answered HTTP ${health.status}: ${clip(health.raw, 120)}`;
      else if (health.head !== undefined && !sameCommit(health.head, head)) detail = `the collector leader (pid ${String(health.pid ?? "?")}) runs ${short(health.head)}, not ${short(head)}`;
      else if (!dev && health.head === undefined && health.pid === healthPidBefore) detail = `the collector (pid ${String(health.pid ?? "?")}) is still the one from before`;
      else {
        const who = dev ? `dev.ts (pid ${dev.pid}) and the collector leader` : "the collector leader";
        return { ok: true, detail: `${who} (pid ${String(health.pid ?? "?")}) ${dev ? "are" : "is"} back on ${short(head)} after ${Math.round(waited / 1000)}s` };
      }
    }
    if (waited >= settleMs) return { ok: false, detail: `after ${Math.round(settleMs / 1000)}s ${detail}` };
    await deps.sleep(WAIT_POLL_MS);
    waited += WAIT_POLL_MS;
  }
}

/**
 * Issues the full restart (fullRestart), noting the dev.ts it replaces (or,
 * with none, the collector answering /health); `full` once the command
 * succeeded. Before the command runs, a `pending` line is logged and
 * full-restart-pending.json written, so the outcome is still logged if the
 * restart stops this script.
 */
async function issueFullRestart(
  deps: RedeployDeps,
  why: string,
  prefix: string,
  head: string
): Promise<RedeployOutcome & { devPidBefore?: number; healthPidBefore?: unknown }> {
  const waitMs = deps.waitMs ?? FULL_RESTART_WAIT_MS;
  let waited = 0;
  if (deps.restartUnderway()) deps.log(`${prefix}: a restart is under way; waiting up to ${Math.round(waitMs / 1000)}s before the full restart`);
  while (deps.restartUnderway() && waited < waitMs) {
    await deps.sleep(WAIT_POLL_MS);
    waited += WAIT_POLL_MS;
  }
  if (deps.restartUnderway()) {
    return { kind: "failed", line: `${prefix}: full restart (${why}) not run: a restart was still under way after ${Math.round(waitMs / 1000)}s`, exitCode: 1 };
  }
  const devPidBefore = (await deps.readDev())?.pid;
  const healthBefore = devPidBefore === undefined && deps.readHealth ? await readHealthBody(deps) : undefined;
  const how = deps.fullRestartCmd?.trim() ? "STANDUP_REDEPLOY_FULL_RESTART_CMD" : DEFAULT_FULL_RESTART.join(" ");
  deps.pending?.write({ pid: deps.pid ?? process.pid, at: new Date().toISOString(), head, why });
  deps.log(`${prefix}: full restart (${why}) to ${short(head)} pending: running ${how}; its outcome follows in this log`);
  const r = deps.fullRestartCmd?.trim() ? await deps.shell(deps.fullRestartCmd.trim(), deps.installDir) : await deps.run(DEFAULT_FULL_RESTART, deps.installDir);
  if (r.code !== 0) {
    return { kind: "failed", line: `${prefix}: full restart (${why}) failed: ${how} exited ${r.code}: ${clip(r.stderr || r.stdout)}`, exitCode: 1 };
  }
  return {
    kind: "full",
    line: `${prefix}: full restart (${why}) via ${how}`,
    exitCode: 0,
    ...(devPidBefore !== undefined ? { devPidBefore } : {}),
    ...(healthBefore?.ok ? { healthPidBefore: healthBefore.pid } : {}),
  };
}

/**
 * Logs the outcome of a full restart an earlier run of this script issued
 * but was stopped before it logged (full-restart-pending.json from a pid
 * that is gone): what the collector's /health answers now.
 */
async function resolveStalePending(deps: RedeployDeps, prefix: string): Promise<void> {
  const stale = deps.pending?.read();
  const self = deps.pid ?? process.pid;
  if (!stale || stale.pid === self || deps.isAlive?.(stale.pid)) return;
  let now = "the collector's /health was not read";
  if (deps.readHealth) {
    const health = await readHealthBody(deps);
    now = !health.ok
      ? health.status === 0
        ? `the collector is unreachable now: ${clip(health.raw, 120)}`
        : `the collector's /health answers HTTP ${health.status} now`
      : health.head === undefined
        ? `a collector (pid ${String(health.pid ?? "?")}) answers healthy now, reporting no commit`
        : `the collector leader (pid ${String(health.pid ?? "?")}) answers healthy on ${short(health.head)} now${sameCommit(health.head, stale.head) ? "" : `, not ${short(stale.head)}`}`;
  }
  deps.log(`${prefix}: the full restart (${stale.why}) to ${short(stale.head)} issued at ${stale.at} stopped the run that issued it before it logged an outcome; ${now}`);
  deps.pending?.clear();
}

/**
 * The redeploy, with its effects in `deps`: install dependencies, decide
 * between the collector's redeploy and a full restart, and carry it out.
 * Every line it logs, and the outcome's, also goes to the redeploy log.
 */
export async function redeploy(hook: string, deps: RedeployDeps): Promise<RedeployOutcome> {
  const prefix = `standup-redeploy (${hook})`;
  const logged: RedeployDeps = {
    ...deps,
    log: (line) => {
      deps.log(line);
      deps.appendLog?.(line);
    },
  };
  const outcome = await redeployOnce(hook, prefix, logged);
  deps.appendLog?.(outcome.line);
  return outcome;
}

async function redeployOnce(hook: string, prefix: string, deps: RedeployDeps): Promise<RedeployOutcome> {
  // Only the install dev.json names is Standup's; a worktree's merge never restarts it.
  const named = deps.devInstallDir?.();
  if (named !== undefined && canonicalPath(named) !== canonicalPath(deps.installDir)) {
    return {
      kind: "refused",
      line: `${prefix}: refused: this script runs from ${deps.installDir}, but dev.json names the install ${named}; only that install's own merges redeploy Standup, so nothing was restarted`,
      exitCode: 1,
    };
  }
  await resolveStalePending(deps, prefix);
  const bun = deps.bunPath ?? process.execPath;
  const install = await deps.run([bun, "install", "--frozen-lockfile"], deps.installDir);
  if (install.code !== 0) deps.log(`${prefix}: bun install --frozen-lockfile exited ${install.code}; continuing: ${clip(install.stderr || install.stdout)}`);

  const rev = await deps.run(["git", "-C", deps.installDir, "rev-parse", "HEAD"], deps.installDir);
  const head = rev.code === 0 ? rev.stdout.trim() : "";
  if (!/^[0-9a-f]{7,64}$/.test(head)) {
    return { kind: "failed", line: `${prefix}: cannot read the install's HEAD (git exited ${rev.code}); nothing restarted`, exitCode: 1 };
  }

  // dev.ts and the gateway it ensured were loaded from dev.json's head; a
  // change to them since only a full restart picks up.
  const devHead = (await deps.readDev())?.head;
  if (!devHead) return fullRestart(deps, "the commit dev.ts runs is unknown (no dev.json with a head)", prefix, head);
  if (devHead !== head) {
    const diff = await deps.run(["git", "-C", deps.installDir, "diff", "--name-only", devHead, head], deps.installDir);
    if (diff.code !== 0) return fullRestart(deps, `cannot diff dev.ts's ${short(devHead)} against ${short(head)}`, prefix, head);
    const changed = needsFullRestart(diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    if (changed.length > 0) {
      return fullRestart(deps, `${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""} changed since ${short(devHead)}`, prefix, head);
    }
  }

  const token = deps.readWriteToken();
  if (!token) return fullRestart(deps, "no local write token to ask the collector with", prefix, head);
  const reason = `redeploy (${hook}) to ${short(head)}`;
  const res = await deps.post(`${deps.collectorUrl}/api/standup/restart`, { source: "redeploy", reason }, { "x-standup-write-token": token });
  if (res.status === 0) return fullRestart(deps, `the collector is unreachable: ${clip(res.body, 120)}`, prefix, head);
  const gatewayReason = res.headers?.[GATEWAY_REASON_HEADER];
  if (res.status === 503 && gatewayReason && NO_LEADER_REASONS.has(gatewayReason)) {
    return fullRestart(deps, `the gateway has no collector leader to ask (${gatewayReason})`, prefix, head);
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    // A body that is not JSON is reported as is below.
  }
  if (res.status === 200 && body.status === "noop") {
    return { kind: "noop", line: `${prefix}: nothing to do — Standup already runs ${short(head)}`, exitCode: 0 };
  }
  if (res.status === 202 && body.status === "coalesced") {
    return { kind: "coalesced", line: `${prefix}: a restart is under way${body.id ? ` (${String(body.id)})` : ""}; ${short(head)} follows once it is done`, exitCode: 0 };
  }
  if (res.status === 202 || res.status === 200) {
    return { kind: "scheduled", line: `${prefix}: redeploying ${short(head)} (restart ${String(body.id ?? "?")}, ${String(body.mode ?? "?")})`, exitCode: 0 };
  }
  const error = typeof body.error === "string" ? body.error : res.body;
  if (res.status === 409 && error.startsWith(NO_DEV_SLOT_REFUSAL)) {
    return fullRestart(deps, "the collector runs as a slot with no dev.ts to hand off through", prefix, head);
  }
  return { kind: "failed", line: `${prefix}: the collector refused the redeploy (HTTP ${res.status}): ${clip(error)}`, exitCode: 1 };
}

/** The fields of restart/current.json restartUnderwayIn reads. */
export interface UnderwayRecord {
  phase?: string;
  supervisorPid?: number;
  updatedAt?: string;
}

/**
 * How long a restart no supervisor has claimed yet counts as under way:
 * the collector holds it while Persona finishes its turn (up to 5 minutes)
 * and its supervisor takes over (up to a minute), with room to spare.
 */
export const UNCLAIMED_RESTART_MS = 10 * 60_000;

/**
 * Whether the restart in `record` is under way: any phase but `done`. Once a
 * supervisor has claimed it, while that supervisor lives; before (scheduled,
 * quiescing, handed_off — the collector still holds it) while the record was
 * written within UNCLAIMED_RESTART_MS, so a record a crashed collector left
 * behind doesn't hold every full restart off for good.
 */
export function restartUnderwayIn(record: UnderwayRecord | undefined, now: number, isAlive: (pid: number) => boolean): boolean {
  if (!record || record.phase === "done") return false;
  if (typeof record.supervisorPid === "number") return isAlive(record.supervisorPid);
  const updated = Date.parse(record.updatedAt ?? "");
  return Number.isFinite(updated) && now - updated < UNCLAIMED_RESTART_MS;
}

/** Git variables a hook runs with, which would point the commands here at the hook's repository. */
const HOOK_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"];

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of HOOK_GIT_VARS) delete out[name];
  return out;
}

async function runCommand(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  try {
    const proc = Bun.spawn([...argv], { cwd, env: childEnv(env), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
}

/** The real effects, for the install at `installDir`. */
export function systemDeps(installDir: string, env: NodeJS.ProcessEnv = process.env): RedeployDeps {
  const dataDir = dataDirFromEnv(env);
  return {
    installDir,
    collectorUrl: `http://127.0.0.1:${publicPorts(env).collector}`,
    fullRestartCmd: env.STANDUP_REDEPLOY_FULL_RESTART_CMD,
    run: (argv, cwd) => runCommand(argv, cwd, env),
    shell: (command, cwd) => runCommand(["sh", "-c", command], cwd, env),
    async post(url, body, headers) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          // Longer than the gateway holds a request while no collector serves
          // (STANDUP_GATEWAY_HOLD_MS, a minute by default), so a hold isn't
          // taken for an unreachable collector.
          signal: AbortSignal.timeout(90_000),
        });
        const reason = res.headers.get(GATEWAY_REASON_HEADER);
        return { status: res.status, body: await res.text(), ...(reason ? { headers: { [GATEWAY_REASON_HEADER]: reason } } : {}) };
      } catch (err) {
        return { status: 0, body: (err as Error).message || "unreachable" };
      }
    },
    readDev: async () => {
      const dev = readJsonFile<DevInfo>(devFilePath(dataDir));
      if (!dev || typeof dev.pid !== "number" || !Number.isInteger(dev.pid) || dev.pid <= 1) return undefined;
      if (typeof dev.installDir !== "string" || canonicalPath(dev.installDir) !== canonicalPath(installDir)) return undefined;
      // A live pid is not enough: it must still be this install's dev.ts, not a recycled pid.
      return (await isInstallDevScript(createSystemExec(), dev.pid, installDir)) ? dev : undefined;
    },
    readWriteToken: () => readLocalWriteToken(localWriteTokenPath(env)),
    restartUnderway: () => restartUnderwayIn(readJsonFile<UnderwayRecord>(join(dataDir, "restart", "current.json")), Date.now(), pidAlive),
    sleep: (ms) => Bun.sleep(ms),
    log: (line) => console.error(line),
    devInstallDir: () => {
      const dir = readJsonFile<{ installDir?: unknown }>(devFilePath(dataDir))?.installDir;
      return typeof dir === "string" && dir ? dir : undefined;
    },
    appendLog: (line) => appendRedeployLog(redeployLogPath(dataDir), line),
    pending: {
      read: () => readFullRestartPending(dataDir),
      write: (pending) => writeFullRestartPending(dataDir, pending),
      clear: () => clearFullRestartPending(dataDir),
    },
    isAlive: pidAlive,
    async readHealth() {
      try {
        const res = await fetch(`http://127.0.0.1:${publicPorts(env).collector}/health`, { signal: AbortSignal.timeout(5_000) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        return { status: 0, body: (err as Error).message || "unreachable" };
      }
    },
  };
}

if (import.meta.main) {
  const hook = process.argv[2]?.trim() || "manual";
  const outcome = await redeploy(hook, systemDeps(resolve(import.meta.dir, "..")));
  console.log(outcome.line);
  process.exit(outcome.exitCode);
}
