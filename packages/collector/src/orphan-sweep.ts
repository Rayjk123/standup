import { join, normalize } from "path";
import type { Database } from "bun:sqlite";
import type { Launch, PersonaJob } from "@standup/shared";
import { SCRATCH_ID, scratchRoot } from "@standup/shared/scratch";
import { getLaunches, personaJobForLaunch, personaJobForSession } from "@standup/store";
import { launchLiveForHygiene, type PaneAlive } from "./launch-holds.js";
import {
  argsReferencePath,
  buildGuard,
  groupStoppable,
  isServiceManager,
  protectedReason,
  stopProcesses,
  usablePath,
  type ProcessRow,
  type ProcessSystem,
  type StopOutcome,
} from "./process-registry.js";

/**
 * The orphan sweep: processes a worker left running that outlived their
 * parent (reparented to `systemd --user` or init) and still name a finished
 * launch's worktree or scratch dir — a dev server started with `nohup … &`
 * that nobody registered. Only launches whose Persona job is closed (or,
 * without a job, that were cleaned up) and whose session is no longer live
 * are matched, never Standup's own processes or another user's.
 */

/** How often the orphan sweep runs. */
export const ORPHAN_SWEEP_MS = 10 * 60 * 1000;

/** Whether the orphan sweep runs: STANDUP_ORPHAN_SWEEP=0/off/false/no turns it off. */
export function orphanSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.STANDUP_ORPHAN_SWEEP?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

/** A finished launch whose leftover processes may be stopped, and the paths that identify them. */
export interface OrphanTarget {
  launchId: string;
  jobId?: string;
  sessionId?: string;
  paths: string[];
}

export interface Orphan {
  row: ProcessRow;
  target: OrphanTarget;
  /** The target path its command line names. */
  path: string;
}

export interface FindOrphansOptions {
  selfPid: number;
  uid: number;
  installDir: string;
  /** The collector's process group, when the table doesn't show it. */
  selfPgid?: number;
}

/**
 * The orphans in `table`: processes of this user whose parent is the user
 * service manager or init, outside the collector's process group and Standup's
 * own tree, not protected (protectedReason), whose command line names one of
 * a target's paths as a whole path.
 */
export function findOrphans(table: ProcessRow[], targets: OrphanTarget[], opts: FindOrphansOptions): Orphan[] {
  const guard = buildGuard(table, { selfPid: opts.selfPid, uid: () => opts.uid }, opts.installDir);
  const selfPgid = guard.selfPgid ?? opts.selfPgid;
  const managers = new Set<number>([1]);
  for (const r of table) if (r.uid === opts.uid && isServiceManager(r)) managers.add(r.pid);
  const found: Orphan[] = [];
  for (const row of table) {
    if (!managers.has(row.ppid) || managers.has(row.pid)) continue;
    if (row.uid !== opts.uid || row.pgid === selfPgid) continue;
    if (protectedReason(row, guard) !== null) continue;
    for (const target of targets) {
      const path = target.paths.find((p) => argsReferencePath(row.args, p));
      if (path) {
        found.push({ row, target, path });
        break;
      }
    }
  }
  return found;
}

const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** The Persona job a launch belongs to, through its launch link or its session's. */
export function jobOf(db: Database, launch: Launch): PersonaJob | undefined {
  return personaJobForLaunch(db, launch.id)?.job ?? (launch.sessionId ? personaJobForSession(db, launch.sessionId)?.job : undefined);
}

/** Whether `launch` is finished: its Persona job is closed or, without a job, it was cleaned up. */
export function launchFinished(db: Database, launch: Launch, job: PersonaJob | undefined = jobOf(db, launch)): boolean {
  return job ? CLOSED_JOB.has(job.status) : launch.status === "cleaned";
}

/** The paths a launch's processes name: its scratch dir, and its worktree unless the launch ran in the user's own checkout (adopted, in place). */
export function launchPaths(launch: Launch, root: string = scratchRoot()): string[] {
  const paths: string[] = [];
  if (SCRATCH_ID.test(launch.id)) paths.push(join(root, launch.id));
  if (launch.worktreePath && launch.kind !== "adopted" && !launch.inPlace) paths.push(normalize(launch.worktreePath).replace(/\/+$/, ""));
  return paths;
}

export interface PartitionOptions {
  installDir: string;
  scratchRoot?: string;
  paneAlive?: PaneAlive;
  /** Every launch that isn't live may be a target, not only the finished ones (launchFinished). */
  everyLaunch?: boolean;
}

/**
 * Every launch split into the ones live by launchLiveForHygiene and the
 * targets: launches that are finished (a Persona launch whose job is closed,
 * or a launch with no job that was cleaned up), or any with `everyLaunch`,
 * and not live (no live session, not starting, not running unpaused with its
 * pane still up, no resume or cleanup in progress, nor any of that for
 * another launch of its session). Each target names launchPaths; a path any
 * launch kept out of the targets still uses (equal, inside or around it, its
 * worktree even when in place) is dropped.
 */
export function partitionLaunches(db: Database, opts: PartitionOptions): {
  /** The live launches among those that may be targets (liveness is checked only for them). */
  live: Launch[];
  targets: OrphanTarget[];
} {
  const root = opts.scratchRoot ?? scratchRoot();
  const liveness = opts.paneAlive ? { paneAlive: opts.paneAlive } : {};
  const keep: string[] = [];
  const live: Launch[] = [];
  const candidates: Array<{ launch: Launch; job?: PersonaJob; paths: string[] }> = [];
  for (const launch of getLaunches(db)) {
    const paths = launchPaths(launch, root);
    const job = jobOf(db, launch);
    const included = opts.everyLaunch === true || launchFinished(db, launch, job);
    const isLive = included && launchLiveForHygiene(db, launch, liveness);
    if (isLive) live.push(launch);
    if (!included || isLive) {
      keep.push(...paths, ...(launch.worktreePath ? [normalize(launch.worktreePath).replace(/\/+$/, "")] : []));
      continue;
    }
    candidates.push({ launch, ...(job ? { job } : {}), paths });
  }
  const targets: OrphanTarget[] = [];
  for (const c of candidates) {
    const paths = c.paths.filter((p) => usablePath(p, opts.installDir) && !keep.some((k) => within(k, p) || within(p, k)));
    if (paths.length === 0) continue;
    targets.push({
      launchId: c.launch.id,
      ...(c.job ? { jobId: c.job.id } : {}),
      ...(c.launch.sessionId ? { sessionId: c.launch.sessionId } : {}),
      paths,
    });
  }
  return { live, targets };
}

/** The launches the sweep may clean up after: partitionLaunches' targets among the finished launches. */
export function orphanTargets(db: Database, opts: { installDir: string; scratchRoot?: string; paneAlive?: PaneAlive }): OrphanTarget[] {
  return partitionLaunches(db, opts).targets;
}

export interface SweepOrphansOptions {
  installDir: string;
  /** Report what would be stopped without signalling anything. */
  dryRun?: boolean;
  graceMs?: number;
  scratchRoot?: string;
  /** Whether a running launch's pane still exists (launchLiveForHygiene); defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
  /** Records a note on the target's job / session activity. */
  note?: (target: OrphanTarget, text: string) => void;
}

export interface SweepOrphansResult {
  orphans: Orphan[];
  /** Per orphan, what stopping it did; empty on a dry run. */
  outcomes: StopOutcome[];
}

function shortArgs(args: string): string {
  return args.length > 120 ? `${args.slice(0, 117)}…` : args;
}

/**
 * Finds the orphans of every finished launch and, unless `dryRun`, stops them
 * (SIGTERM to the process group each leads when every member may be stopped,
 * else to the pid; SIGKILL after the grace period), noting each stop on its
 * launch's job.
 */
export async function sweepOrphans(db: Database, sys: ProcessSystem, opts: SweepOrphansOptions): Promise<SweepOrphansResult> {
  const targets = orphanTargets(db, {
    installDir: opts.installDir,
    ...(opts.scratchRoot ? { scratchRoot: opts.scratchRoot } : {}),
    ...(opts.paneAlive ? { paneAlive: opts.paneAlive } : {}),
  });
  if (targets.length === 0) return { orphans: [], outcomes: [] };
  const table = sys.processTable();
  if (!table) return { orphans: [], outcomes: [] };
  const orphans = findOrphans(table, targets, { selfPid: sys.selfPid, uid: sys.uid(), installDir: opts.installDir });
  if (opts.dryRun || orphans.length === 0) return { orphans, outcomes: [] };
  const guard = buildGuard(table, sys, opts.installDir);
  const outcomes = await stopProcesses(
    sys,
    orphans.map((o) => ({ pid: o.row.pid, pgid: o.row.pgid, args: o.row.args, ...(o.row.started !== undefined ? { started: o.row.started } : {}) })),
    { ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}), groupOk: (pgid) => groupStoppable(pgid, guard) }
  );
  const byTarget = new Map<string, string[]>();
  orphans.forEach((o, i) => {
    const outcome = outcomes[i];
    if (outcome !== "terminated" && outcome !== "killed") return;
    const list = byTarget.get(o.target.launchId) ?? [];
    list.push(`pid ${o.row.pid} (${shortArgs(o.row.args)})${outcome === "killed" ? " with SIGKILL" : ""}`);
    byTarget.set(o.target.launchId, list);
  });
  for (const [launchId, stopped] of byTarget) {
    const target = targets.find((t) => t.launchId === launchId)!;
    const text = `Stopped ${stopped.length} leftover process${stopped.length === 1 ? "" : "es"} of finished launch ${launchId}: ${stopped.join("; ")}`;
    console.log(`[orphan-sweep] ${text}`);
    opts.note?.(target, text);
  }
  return { orphans, outcomes };
}
