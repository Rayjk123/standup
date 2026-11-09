import { spawnSync } from "child_process";
import { realpathSync } from "fs";
import { homedir, hostname } from "os";
// Its own line: the floor reads the import line of each name a function it
// follows uses, and takes `userInfo` as a way to the real home dir.
import { userInfo } from "os";
import { basename, isAbsolute, join, normalize } from "path";
import type { Database } from "bun:sqlite";
import type { Launch, LaunchProcess } from "@standup/shared";
import { SCRATCH_ID, scratchRoot } from "@standup/shared/scratch";
import { createLaunchProcess, listLiveProcessesForJob, listLiveProcessesForLaunch, markProcessStopped } from "@standup/store";
import { REVIEW_TUNNEL_RESERVED } from "./review-tunnel/manager.js";
import { activeTunnelProvider, type ListedTunnel } from "./tunnels/provider.js";
import { workerTmux } from "./tmux-launch.js";

/**
 * The registry of long-lived processes workers start (dev servers, proxies,
 * tunnels, `systemd --user` units): a worker registers one through the
 * `register_process` MCP tool, and it is stopped when its job closes or its
 * launch is cleaned up. Registration accepts only what the calling launch
 * started — a pid under its pane, or one reparented to the service manager
 * that names its worktree or scratch dir; a unit named with the launch's
 * `sw-<id8>-` prefix — and refuses anything Standup's own, another user's, or
 * a pane's.
 */

/** One row of `ps -eo pid=,ppid=,pgid=,uid=,lstart=,args=`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** When it started, in epoch seconds (`lstart`); unset when `ps` didn't show it. */
  started?: number;
  args: string;
}

/**
 * The host effects the registry and the orphan sweep need, injectable so a
 * test stops processes without touching real ones. Everything is read from
 * `ps`, never /proc.
 */
export interface ProcessSystem {
  /** The collector's own pid: it, its ancestors and Standup's own process tree are never stopped. */
  selfPid: number;
  /** Every process, from `ps`; null when it can't run. */
  processTable: () => ProcessRow[] | null;
  /** `pid`'s command line, trimmed; null when it is gone or can't be read. */
  argsOf: (pid: number) => string | null;
  /** When `pid` started, in epoch seconds; null when it is gone or can't be read. */
  startedOf: (pid: number) => number | null;
  /** The pid of the pane process of worker tmux session `tmuxSession` (exact name, workers' server); null when there is none. */
  panePid: (tmuxSession: string) => number | null;
  /** Whether `target` (a pid, or a negated process group id) still exists. */
  isAlive: (target: number) => boolean;
  /** Sends `sig` to `target` (a pid, or a negated process group id); false when it could not be sent. */
  signal: (target: number, sig: NodeJS.Signals) => boolean;
  /** `systemctl --user stop <unit>`; whether it succeeded. */
  stopUnit: (unit: string) => Promise<boolean>;
  /** The collector's uid; only this user's processes are ever registered or stopped. */
  uid: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The tunnel provider, for stopping the tunnels a finished launch opened by hand (worker-tunnels.ts); unset, none are. */
  tunnels?: TunnelHost;
}

/** The tunnel provider as seen from this host. */
export interface TunnelHost {
  /** The user the tunnel CLI prefixes names with. */
  hostUser: string;
  hostname: string;
  /** The tunnels the provider's list command reports; null when it can't be asked. */
  list: () => Promise<ListedTunnel[] | null>;
}

/** How long a SIGTERM'd process gets to exit before SIGKILL. */
export const PROCESS_STOP_GRACE_MS = 3_000;

/** A systemd unit name the registry stops: one `.service` or `.scope` of plain unit characters. */
export const UNIT_NAME = /^[\w@.:-]+\.(service|scope)$/;

/** The part of a worker's unit name after its launch prefix. */
const UNIT_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(service|scope)$/;

/** The prefix a launch's units must carry, `sw-<first 8 of the launch id>-`, so a unit it registers is one it named. */
export function unitPrefix(launchId: string): string {
  return `sw-${launchId.slice(0, 8)}-`;
}

/** Whether `unit` is a unit name launch `launchId` may register: `sw-<id8>-<name>.service|.scope`. */
export function isLaunchUnit(unit: string, launchId: string): boolean {
  const prefix = unitPrefix(launchId);
  return UNIT_NAME.test(unit) && unit.startsWith(prefix) && UNIT_SUFFIX.test(unit.slice(prefix.length));
}

/**
 * `installDir` as written and, when it differs, with symlinks resolved: a
 * process may name either form.
 */
export function installDirForms(installDir: string): string[] {
  if (!installDir) return [];
  const forms = [installDir];
  try {
    const real = realpathSync(installDir);
    if (real !== installDir) forms.push(real);
  } catch {
    // A missing install dir has only the form it was written in.
  }
  return forms;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * A path specific enough to match a process by: absolute, at least three
 * components deep, not home, and neither inside nor around the install dir
 * (in either of its forms).
 */
export function usablePath(path: string, installDir: string): boolean {
  if (!path || !isAbsolute(path)) return false;
  const p = normalize(path).replace(/\/+$/, "");
  if (p.split("/").filter(Boolean).length < 3 || p === homedir()) return false;
  return !installDirForms(installDir).some((dir) => within(p, dir) || within(dir, p));
}

/**
 * The fingerprint recorded for a registered pid: `<start epoch>\t<args>`, or
 * the args alone when the start time is unknown (and in rows recorded before
 * start times were).
 */
export function processFingerprint(args: string, started?: number): string {
  return started !== undefined ? `${started}\t${args.trim()}` : args.trim();
}

/** The args and start time a fingerprint recorded. */
export function parseFingerprint(fingerprint: string): { args: string; started?: number } {
  const m = /^(\d+)\t([\s\S]*)$/.exec(fingerprint);
  return m ? { args: m[2]!.trim(), started: Number(m[1]) } : { args: fingerprint.trim() };
}

/**
 * Units never stopped through the registry: Standup's own (`standup*`), the
 * user manager and its plumbing (`user@`, `systemd-*`, `dbus*`,
 * `init.scope`), login sessions (`session-*`) and tmux's scopes (`tmux-*`),
 * which hold every worker's pane. Any other unit the host keeps running is
 * out of reach too, since a registered unit must carry the launch's own
 * `sw-<id8>-` prefix (isLaunchUnit).
 */
const RESERVED_UNITS: readonly RegExp[] = [/^standup/i, /^user@/, /^systemd-/, /^dbus/, /^init\.scope$/, /^session-/, /^tmux-/];

/** Whether `args` names `path` as a whole path: not inside a longer component on either side. */
export function argsReferencePath(args: string, path: string): boolean {
  const p = path.replace(/\/+$/, "");
  if (!p || p === "/") return false;
  let from = 0;
  for (;;) {
    const i = args.indexOf(p, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : args[i - 1]!;
    const after = args[i + p.length] ?? "";
    if (!/[\w.\-/]/.test(before) && (after === "" || after === "/" || /[\s"'=:,;]/.test(after))) return true;
    from = i + 1;
  }
}

/** The program name of a command line: argv[0]'s basename. */
export function argv0(args: string): string {
  return basename(args.trim().split(/\s+/)[0] ?? "");
}

/**
 * The command lines of the standing tunnels named by `suffixes` (the reserved
 * review-tunnel suffixes): a tunnel command passing one of them to `--name`,
 * which the tunnel service publishes as `<user>-<suffix>`, or a URL host whose
 * first label is `<user>-<suffix>`, on whatever domain the tunnel provider
 * serves (at least two more labels). Null when there are no suffixes.
 */
export function standingTunnelPattern(suffixes: Iterable<string>): RegExp | null {
  const names = [...suffixes].filter(Boolean).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (names.length === 0) return null;
  const alt = `(?:${names.join("|")})`;
  return new RegExp(`(?:^|\\s)--name[= ]+(?:[\\w.]+-)?${alt}(?=\\s|$)|(?:^|[\\s/])[\\w.]+-${alt}\\.[\\w-]+\\.[\\w-]+`);
}

/**
 * The standing tunnels the collector runs with: Standup's console tunnel
 * (`<user>-standup`) and any the owner reserves with
 * STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES (REVIEW_TUNNEL_RESERVED).
 */
const STANDING_TUNNEL = standingTunnelPattern(REVIEW_TUNNEL_RESERVED.suffixes);

/**
 * Why a command line is never a worker's to stop, judged on its args alone;
 * null when nothing about it is protected:
 *  - it references the install dir, as written or resolved (the collector,
 *    web, gateway and slack Standup runs from there, and their scripts);
 *  - it is tmux (any server or client — the shared worker server among them);
 *  - it is a Claude agent (`claude`, the `claude-code` node process);
 *  - it is `systemd` (the user manager);
 *  - it is one of the standing tunnels: Standup's console tunnel or one the
 *    owner reserved (`--name <suffix>` for a suffix in `suffixes`, by default
 *    the collector's reserved review-tunnel suffixes).
 */
export function protectedArgsReason(
  args: string,
  installDir: string | readonly string[],
  suffixes?: ReadonlySet<string>
): string | null {
  const standing = suffixes ? standingTunnelPattern(suffixes) : STANDING_TUNNEL;
  const name = argv0(args);
  const dirs = typeof installDir === "string" ? installDirForms(installDir) : installDir;
  if (dirs.some((dir) => argsReferencePath(args, dir))) return "it runs from Standup's install dir";
  if (name === "tmux" || /^tmux: /.test(args)) return "it is tmux, which holds the workers' panes";
  if (name === "claude" || /\/claude-code\/|@anthropic-ai\/claude-code/.test(args)) return "it is a Claude agent";
  if (name === "systemd") return "it is systemd";
  if (standing?.test(args)) return "it is one of the host's standing tunnels";
  return null;
}

/** What the guards know about the process table: who is Standup's and who is a pane. */
export interface ProcessGuard {
  table: ProcessRow[];
  byPid: Map<number, ProcessRow>;
  uid: number;
  selfPid: number;
  selfPgid?: number;
  /** The collector and its ancestors. */
  ancestors: Set<number>;
  /**
   * Standup's own process tree: everything under the collector's topmost
   * ancestor below the service manager (dev.ts and the web, slack and gateway
   * services it runs, the Persona runtime, the collector's own children).
   */
  standupTree: Set<number>;
  installDir: string;
  /** installDirForms(installDir), resolved once for the whole table. */
  installDirs: string[];
}

/** Whether `row` is the user service manager (`systemd --user`) or init. */
export function isServiceManager(row: ProcessRow): boolean {
  return row.pid === 1 || /(^|\/)systemd\s+--user(\s|$)/.test(row.args);
}

/** The guard over `table`, from the collector's place in it. */
export function buildGuard(table: ProcessRow[], sys: Pick<ProcessSystem, "selfPid" | "uid">, installDir: string): ProcessGuard {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const children = new Map<number, number[]>();
  for (const r of table) {
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const ancestors = new Set<number>();
  let root: number | undefined;
  let cur = byPid.get(sys.selfPid);
  for (let depth = 0; cur && depth < 64 && !ancestors.has(cur.pid); depth++) {
    if (isServiceManager(cur)) break;
    ancestors.add(cur.pid);
    root = cur.pid;
    cur = byPid.get(cur.ppid);
  }
  const standupTree = new Set<number>();
  const stack = root === undefined ? [] : [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (standupTree.has(pid)) continue;
    standupTree.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return {
    table,
    byPid,
    uid: sys.uid(),
    selfPid: sys.selfPid,
    ...(byPid.get(sys.selfPid) ? { selfPgid: byPid.get(sys.selfPid)!.pgid } : {}),
    ancestors,
    standupTree,
    installDir,
    installDirs: installDirForms(installDir),
  };
}

/** Why `row` is never stopped through the registry or the sweep; null when it may be. */
export function protectedReason(row: ProcessRow, guard: ProcessGuard): string | null {
  if (row.pid <= 1) return "it is init";
  if (row.pid === guard.selfPid) return "it is the collector";
  if (guard.ancestors.has(row.pid)) return "it is an ancestor of the collector";
  if (guard.standupTree.has(row.pid)) return "it is one of Standup's own processes";
  if (row.uid !== guard.uid) return "it belongs to another user";
  const byArgs = protectedArgsReason(row.args, guard.installDirs);
  if (byArgs) return byArgs;
  const parent = guard.byPid.get(row.ppid);
  if (parent && argv0(parent.args) === "tmux") return "it is a tmux pane's own process";
  return null;
}

/**
 * Whether signalling process group `pgid` stops only stoppable processes:
 * not the collector's group, and no member of it is protected.
 */
export function groupStoppable(pgid: number, guard: ProcessGuard): boolean {
  if (pgid <= 1 || pgid === guard.selfPgid) return false;
  return guard.table.every((r) => r.pgid !== pgid || protectedReason(r, guard) === null);
}

export type RegisterResult = { ok: true; process: LaunchProcess } | { ok: false; reason: string };

export interface RegisterProcessInput {
  launch: Launch;
  jobId?: string;
  pid?: number;
  unit?: string;
  label: string;
  port?: number;
}

/**
 * The paths a process reparented away from a launch's pane must name to be
 * the launch's: its worktree (unless it ran in the user's own checkout —
 * adopted or in place) and the scratch dirs of it and every launch of its
 * session (an adoption reuses the original launch's scratch dir).
 */
function launchPaths(db: Database, launch: Launch, root: string, installDir: string): string[] {
  const paths: string[] = [];
  if (launch.worktreePath && launch.kind !== "adopted" && !launch.inPlace) paths.push(normalize(launch.worktreePath).replace(/\/+$/, ""));
  const ids = new Set([launch.id]);
  if (launch.sessionId) {
    const rows = db.query("SELECT id FROM launches WHERE session_id = ?").all(launch.sessionId) as Array<{ id: string }>;
    for (const r of rows) ids.add(r.id);
  }
  for (const id of ids) if (SCRATCH_ID.test(id)) paths.push(join(root, id));
  return paths.filter((p) => usablePath(p, installDir));
}

/** Whether `row` descends from `ancestor` (strictly), walking ppid through the table. */
function descendsFrom(row: ProcessRow, ancestor: number, byPid: Map<number, ProcessRow>): boolean {
  let cur = byPid.get(row.ppid);
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur.pid === ancestor) return true;
    if (cur.pid <= 1 || cur.ppid === cur.pid) return false;
    cur = byPid.get(cur.ppid);
  }
  return false;
}

/**
 * Whether `row` is a process `launch` started: a descendant of its pane's
 * process, or a process reparented to the user service manager (or init)
 * whose command line names the launch's worktree or scratch dir.
 */
function startedByLaunch(db: Database, sys: ProcessSystem, guard: ProcessGuard, row: ProcessRow, launch: Launch, root: string): boolean {
  const pane = launch.tmuxSession ? sys.panePid(launch.tmuxSession) : null;
  if (pane !== null && pane > 1 && descendsFrom(row, pane, guard.byPid)) return true;
  const parent = guard.byPid.get(row.ppid);
  const reparented = row.ppid === 1 || (parent !== undefined && parent.uid === guard.uid && isServiceManager(parent));
  if (!reparented) return false;
  return launchPaths(db, launch, root, guard.installDir).some((p) => argsReferencePath(row.args, p));
}

/**
 * Registers a process the launch's worker started, after the guards: a pid
 * must be a live process of this user's that is not Standup's own, a pane's,
 * tmux, a Claude agent or a standing tunnel; when it leads a process group no
 * member of the group may be either; and it must be the launch's own
 * (startedByLaunch). A unit must be named `sw-<id8>-<name>.service|.scope`
 * (isLaunchUnit) and lie outside RESERVED_UNITS. The pid's command line,
 * start time and process group are recorded, so a stop later can tell a
 * reused pid. Registering a live pid (or unit) the launch already registered
 * returns that row.
 */
export function registerProcess(
  db: Database,
  sys: ProcessSystem,
  input: RegisterProcessInput,
  opts: { installDir: string; reservedUnits?: string[]; scratchRoot?: string }
): RegisterResult {
  const label = input.label.trim().slice(0, 200);
  if (!label) return { ok: false, reason: "label is required" };
  if ((input.pid === undefined) === (input.unit === undefined)) return { ok: false, reason: "pass exactly one of pid or unit" };
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    return { ok: false, reason: "port must be an integer from 1 to 65535" };
  }
  const live = listLiveProcessesForLaunch(db, input.launch.id);
  if (input.unit !== undefined) {
    const unit = input.unit.trim();
    const prefix = unitPrefix(input.launch.id);
    if (!isLaunchUnit(unit, input.launch.id)) {
      return {
        ok: false,
        reason: `unit must be named ${prefix}<name>.service or ${prefix}<name>.scope (<name>: letters, digits, '.', '_', '-'); start it with \`systemd-run --user --unit=${prefix}<name> …\``,
      };
    }
    if (RESERVED_UNITS.some((re) => re.test(unit)) || (opts.reservedUnits ?? []).includes(unit)) {
      return { ok: false, reason: `${unit} is not a worker's unit to stop` };
    }
    const existing = live.find((p) => p.kind === "unit" && p.unit === unit);
    if (existing) return { ok: true, process: existing };
    return {
      ok: true,
      process: createLaunchProcess(db, { launchId: input.launch.id, ...(input.jobId ? { jobId: input.jobId } : {}), kind: "unit", unit, label, ...(input.port !== undefined ? { port: input.port } : {}) }),
    };
  }
  const pid = input.pid!;
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: "pid must be a process id above 1" };
  const table = sys.processTable();
  if (!table) return { ok: false, reason: "the process table could not be read" };
  const guard = buildGuard(table, sys, opts.installDir);
  const row = guard.byPid.get(pid);
  if (!row) return { ok: false, reason: `no process ${pid} is running` };
  const refused = protectedReason(row, guard);
  if (refused) return { ok: false, reason: `process ${pid} can't be registered: ${refused}` };
  if (row.pgid === pid && !groupStoppable(pid, guard)) {
    return { ok: false, reason: `process ${pid} leads a process group holding a process that can't be stopped` };
  }
  if (!startedByLaunch(db, sys, guard, row, input.launch, opts.scratchRoot ?? scratchRoot())) {
    return {
      ok: false,
      reason: `process ${pid} can't be registered: it is not a process this launch started (it is neither under the launch's pane nor, reparented to the service manager, running from its worktree or scratch dir)`,
    };
  }
  const fingerprint = processFingerprint(row.args, row.started);
  const existing = live.find((p) => p.kind === "pid" && p.pid === pid && p.argsFingerprint !== undefined && sameProcess(parseFingerprint(p.argsFingerprint), row.args, row.started ?? null));
  if (existing) return { ok: true, process: existing };
  return {
    ok: true,
    process: createLaunchProcess(db, {
      launchId: input.launch.id,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      kind: "pid",
      pid,
      pgid: row.pgid,
      label,
      ...(input.port !== undefined ? { port: input.port } : {}),
      argsFingerprint: fingerprint,
    }),
  };
}

/**
 * How far (seconds) a process's read start time may drift from the recorded
 * one and still be the same process: `ps` derives lstart from boot time and
 * the wall clock, so a small clock step (an NTP correction) shifts every
 * process's read start time alike. The command line must still match exactly.
 */
export const START_TIME_TOLERANCE_S = 2;

/**
 * Whether a live process with `args` and start time `started` is the one
 * `recorded` describes: the same command line and, when a start time was
 * recorded, a start time within START_TIME_TOLERANCE_S of it (an unreadable
 * one doesn't match).
 */
export function sameProcess(recorded: { args: string; started?: number }, args: string, started: number | null): boolean {
  if (args.trim() !== recorded.args.trim()) return false;
  if (recorded.started === undefined) return true;
  return started !== null && Math.abs(started - recorded.started) <= START_TIME_TOLERANCE_S;
}

/** How one process ended up: stopped (SIGTERM was enough, or SIGKILL was needed), or left alone. */
export type StopOutcome = "terminated" | "killed" | "gone" | "reused" | "refused";

export interface StopTarget {
  pid: number;
  pgid?: number;
  /** The command line it must still have; a different one means the pid was reused. */
  args: string;
  /** The start time (epoch seconds) it must still have, when it was recorded. */
  started?: number;
}

/** Whether live `pid` is still the process `t` names: same command line and, when recorded, start time. */
function stillTarget(sys: ProcessSystem, t: StopTarget): boolean | null {
  const current = sys.argsOf(t.pid);
  if (current === null) return null;
  return sameProcess(t, current, t.started !== undefined ? sys.startedOf(t.pid) : null);
}

/**
 * Stops each target. One whose command line or start time changed (a reused
 * pid) is left alone. One that is gone is left alone too — unless it led its
 * process group, the group is still there and `groupOk` allows it, when the
 * group is signalled (a leader can exit before the children it started).
 * Otherwise SIGTERM goes to its process group when it leads one that
 * `groupOk` allows, else to the pid alone; after `graceMs` whatever is still
 * there (a live leader re-checked to be the same process) gets SIGKILL. All
 * targets share the one grace period.
 */
export async function stopProcesses(
  sys: ProcessSystem,
  targets: StopTarget[],
  opts: { graceMs?: number; groupOk: (pgid: number) => boolean; protectedPid?: (pid: number) => boolean }
): Promise<StopOutcome[]> {
  const graceMs = opts.graceMs ?? PROCESS_STOP_GRACE_MS;
  const outcomes: StopOutcome[] = targets.map(() => "gone");
  const signalled: Array<{ index: number; target: number; t: StopTarget }> = [];
  targets.forEach((t, index) => {
    if (t.pid <= 1 || t.pid === sys.selfPid || opts.protectedPid?.(t.pid)) {
      outcomes[index] = "refused";
      return;
    }
    const same = sys.isAlive(t.pid) ? stillTarget(sys, t) : null;
    if (same === null) {
      // The pid of a group's leader can't be reused while its group lives, so
      // a live group of a gone leader is still the one registered.
      if (t.pgid === t.pid && sys.isAlive(-t.pid) && opts.groupOk(t.pid)) {
        sys.signal(-t.pid, "SIGTERM");
        outcomes[index] = "terminated";
        signalled.push({ index, target: -t.pid, t });
      }
      return;
    }
    if (!same) {
      outcomes[index] = "reused";
      return;
    }
    const target = t.pgid === t.pid && opts.groupOk(t.pid) ? -t.pid : t.pid;
    sys.signal(target, "SIGTERM");
    outcomes[index] = "terminated";
    signalled.push({ index, target, t });
  });
  if (signalled.length === 0) return outcomes;
  const step = Math.max(1, Math.min(100, graceMs));
  for (let waited = 0; waited < graceMs; waited += step) {
    if (signalled.every((s) => !sys.isAlive(s.target))) break;
    await sys.sleep(step);
  }
  for (const s of signalled) {
    if (!sys.isAlive(s.target)) continue;
    // A live leader must still be the process signalled; a group whose leader
    // is gone still holds its id, so it can't have been reused.
    if (sys.isAlive(s.t.pid) && stillTarget(sys, s.t) === false) continue;
    sys.signal(s.target, "SIGKILL");
    outcomes[s.index] = "killed";
  }
  return outcomes;
}

export interface TerminatedProcess {
  process: LaunchProcess;
  outcome: StopOutcome | "unit_stopped" | "unit_failed";
}

/**
 * Stops the live registered processes of a job or a launch and marks each
 * stopped with what happened (`reason`, or `gone`/`reused`/`refused`/
 * `unit_failed`). Rows already stopped are not listed again, so a second call
 * is a no-op. Rows of a launch `skipLaunch` names are left live.
 */
export async function terminateRegistered(
  db: Database,
  sys: ProcessSystem,
  scope: { jobId: string } | { launchId: string },
  reason: string,
  opts: { installDir: string; graceMs?: number; skipLaunch?: (launchId: string) => boolean }
): Promise<TerminatedProcess[]> {
  const listed = "jobId" in scope ? listLiveProcessesForJob(db, scope.jobId) : listLiveProcessesForLaunch(db, scope.launchId);
  const rows = opts.skipLaunch ? listed.filter((r) => !opts.skipLaunch!(r.launchId)) : listed;
  if (rows.length === 0) return [];
  const results: TerminatedProcess[] = [];
  const pidRows = rows.filter((r) => r.kind === "pid" && r.pid !== undefined);
  if (pidRows.length > 0) {
    const table = sys.processTable();
    const guard = table ? buildGuard(table, sys, opts.installDir) : null;
    const outcomes = await stopProcesses(
      sys,
      pidRows.map((r) => ({ pid: r.pid!, ...(r.pgid !== undefined ? { pgid: r.pgid } : {}), ...parseFingerprint(r.argsFingerprint ?? "") })),
      {
        ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}),
        groupOk: (pgid) => guard !== null && groupStoppable(pgid, guard),
        protectedPid: (pid) => {
          const row = guard?.byPid.get(pid);
          return row !== undefined && protectedReason(row, guard!) !== null;
        },
      }
    );
    pidRows.forEach((r, i) => {
      const outcome = outcomes[i]!;
      markProcessStopped(db, r.id, outcome === "terminated" || outcome === "killed" ? reason : outcome);
      results.push({ process: r, outcome });
    });
  }
  for (const r of rows) {
    if (r.kind !== "unit" || !r.unit) continue;
    const ok = UNIT_NAME.test(r.unit) && (await sys.stopUnit(r.unit));
    markProcessStopped(db, r.id, ok ? reason : "unit_failed");
    results.push({ process: r, outcome: ok ? "unit_stopped" : "unit_failed" });
  }
  return results;
}

/** One line per stopped process, for an activity note; null when nothing was stopped. */
export function describeTerminated(results: TerminatedProcess[]): string | null {
  const stopped = results.filter((r) => r.outcome === "terminated" || r.outcome === "killed" || r.outcome === "unit_stopped");
  if (stopped.length === 0) return null;
  return stopped
    .map((r) => `${r.process.label} (${r.process.unit ?? `pid ${r.process.pid}`}${r.process.port ? `, port ${r.process.port}` : ""})${r.outcome === "killed" ? " — needed SIGKILL" : ""}`)
    .join(", ");
}

/** `ps` run in the C locale and UTC, so `lstart` reads the same way every time. */
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

function psTable(): ProcessRow[] | null {
  const out = spawnSync("ps", ["-ww", "-eo", "pid=,ppid=,pgid=,uid=,lstart=,args="], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024, env: PS_ENV });
  if (out.status !== 0 || out.error) return null;
  return parsePsTable(out.stdout);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `lstart`'s five fields (`Mon Oct 12 09:05:03 2026`, UTC). */
const LSTART = /([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})/;

/** Epoch seconds of an `lstart` value printed in UTC; null when it isn't one. */
export function parseLstart(text: string): number | null {
  const m = new RegExp(`^\\s*${LSTART.source}\\s*$`).exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!);
  if (month < 0) return null;
  return Date.UTC(Number(m[7]), month, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000;
}

const PS_ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(${LSTART.source})(?:\\s+(.*))?$`);
const PS_ROW_NO_START = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/;

/**
 * Parses `ps -eo pid=,ppid=,pgid=,uid=,lstart=,args=` output (lstart in UTC);
 * a line without a start time is read as `pid ppid pgid uid args`.
 */
export function parsePsTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PS_ROW.exec(line);
    const started = m ? parseLstart(m[5]!) : null;
    if (m && started !== null) {
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), started, args: (m[13] ?? "").trim() });
      continue;
    }
    const plain = PS_ROW_NO_START.exec(line);
    if (plain) rows.push({ pid: Number(plain[1]), ppid: Number(plain[2]), pgid: Number(plain[3]), uid: Number(plain[4]), args: (plain[5] ?? "").trim() });
  }
  return rows;
}

/** `tmux display-message`'s target for the pane of session `name`: the exact session (`=name:`), never a prefix match. */
export function panePidArgv(name: string): string[] {
  return workerTmux("display-message", "-p", "-t", `=${name}:`, "#{pane_pid}");
}

let cachedOwnGroup: number | undefined;
function ownGroup(): number | undefined {
  if (cachedOwnGroup !== undefined) return cachedOwnGroup;
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5_000 });
  const pgid = Number(out.stdout?.trim());
  if (out.status === 0 && Number.isInteger(pgid) && pgid > 0) cachedOwnGroup = pgid;
  return cachedOwnGroup;
}

/**
 * The real host: `ps`, signals and `systemctl --user`. Signals never go to
 * pid 0/1, this process or its own process group, whatever a caller passes.
 * A pane's pid is read from the workers' tmux server only (`-S` socket, exact
 * session). Tunnels are listed through the collector's tunnel provider
 * (activeTunnelProvider; none while it is disabled), except under `bun
 * test`, where the real tunnel service is never asked. `selfPid` overrides
 * whose tree the guards protect, `panePid` where a pane's process is found
 * and `tunnels` the tunnel service (null: none) (tests).
 */
export function createProcessSystem(
  opts: { selfPid?: number; panePid?: (tmuxSession: string) => number | null; tunnels?: TunnelHost | null } = {}
): ProcessSystem {
  const provider = activeTunnelProvider();
  const realTunnels =
    process.env.NODE_ENV === "test" || !provider.enabled
      ? null
      : { hostUser: userInfo().username, hostname: hostname(), list: () => provider.list() };
  const tunnels: TunnelHost | null = opts.tunnels !== undefined ? opts.tunnels : realTunnels;
  return {
    ...(tunnels ? { tunnels } : {}),
    selfPid: opts.selfPid ?? process.pid,
    processTable: psTable,
    argsOf(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const out = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
      if (out.status !== 0 || out.error) return null;
      const args = out.stdout.trim();
      return args || null;
    },
    startedOf(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: PS_ENV });
      if (out.status !== 0 || out.error) return null;
      return parseLstart(out.stdout);
    },
    panePid:
      opts.panePid ??
      ((tmuxSession) => {
        if (!/^[\w.-]+$/.test(tmuxSession)) return null;
        const [cmd, ...argv] = panePidArgv(tmuxSession);
        const out = spawnSync(cmd!, argv, { encoding: "utf8", timeout: 5_000 });
        if (out.status !== 0 || out.error) return null;
        const pid = Number(out.stdout.trim());
        return Number.isInteger(pid) && pid > 1 ? pid : null;
      }),
    isAlive(target) {
      if (!Number.isInteger(target) || Math.abs(target) <= 1) return false;
      try {
        process.kill(target, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signal(target, sig) {
      if (!Number.isInteger(target) || Math.abs(target) <= 1 || target === process.pid) return false;
      if (target < 0 && -target === ownGroup()) return false;
      try {
        process.kill(target, sig);
        return true;
      } catch {
        return false;
      }
    },
    async stopUnit(unit) {
      if (!UNIT_NAME.test(unit)) return false;
      try {
        const proc = Bun.spawn(["systemctl", "--user", "stop", unit], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
        await proc.exited;
        clearTimeout(timer);
        return proc.exitCode === 0;
      } catch {
        return false;
      }
    },
    uid: () => (typeof process.getuid === "function" ? process.getuid() : -1),
    sleep: (ms) => Bun.sleep(ms),
  };
}
