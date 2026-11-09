import type { Database } from "bun:sqlite";
import { tunnelSlug } from "@standup/shared";
import { getLaunches, liveReviewTunnelNames } from "@standup/store";
import { launchLiveForHygiene, type PaneAlive } from "./launch-holds.js";
import { launchFinished } from "./orphan-sweep.js";
import { buildGuard, protectedReason, stopProcesses, unitPrefix, type ProcessSystem, type StopOutcome } from "./process-registry.js";
import { isReservedTunnelName, REVIEW_TUNNEL_RESERVED_PORTS } from "./review-tunnel/manager.js";
import { argsNamePort } from "./review-tunnel/system.js";

/**
 * Tunnels a worker opens by hand with the tunnel provider's CLI. A worker
 * names one with its launch's `sw-<id8>-` prefix — the prefix its systemd
 * units carry — as `sw-<id8>-<name>`, which the tunnel service lists as
 * `<user>-sw-<id8>-<name>` (the provider's listing, see TunnelProvider.list).
 * The name alone ties the tunnel to its launch, so it is stopped once the
 * launch is finished (its job closed, or without a job, cleaned up) and no
 * longer live, whether or not the worker registered it: a tunnel command
 * names no worktree or scratch path, so the orphan sweep can't recognise it.
 * With no provider (the default) nothing is listed and nothing is stopped.
 *
 * A tunnel is stopped only when every launch whose id starts with that id8 is
 * finished, the tunnel service lists it for this host with a pid and a local
 * port, the port and name are not reserved (the standing tunnels), no live
 * review tunnel holds the name, and that pid's command line, read from `ps`,
 * still names the port and the prefix — so a reused pid is left alone. The
 * pid alone is signalled, never its process group, which may be a shell's.
 */

/**
 * The part of a worker tunnel's name after the host user: `sw-<id8>-<name>`.
 * Any case and unit-name characters are read, whatever the tunnel CLI keeps:
 * the id8 and the checks after it are what make a match safe.
 */
const WORKER_TUNNEL_SUFFIX = /^sw-([0-9a-f]{8})-[a-z0-9][\w.-]*$/i;

/** The `--name` a launch's hand-opened tunnel takes: `sw-<id8>-<name>`. */
export function workerTunnelSuffix(launchId: string, name: string): string {
  return `${unitPrefix(launchId)}${tunnelSlug(name, 40) || "tunnel"}`;
}

/** The launch id8 tunnel `name` (as the service lists it) carries, or null when it is no worker tunnel of `hostUser`'s. */
export function workerTunnelLaunchPrefix(name: string, hostUser: string): string | null {
  const prefix = `${tunnelSlug(hostUser, 24) || "user"}-`;
  if (!name.startsWith(prefix)) return null;
  return WORKER_TUNNEL_SUFFIX.exec(name.slice(prefix.length))?.[1]?.toLowerCase() ?? null;
}

export interface WorkerTunnelStop {
  name: string;
  pid: number;
  port: number;
  launchId: string;
  outcome: StopOutcome;
}

export interface ReapWorkerTunnelsOptions {
  installDir: string;
  /** Only tunnels of these launches; every finished launch's when unset. */
  launchIds?: readonly string[];
  /** Whether a running launch's pane still exists (launchLiveForHygiene); defaults to the workers' tmux server. */
  paneAlive?: PaneAlive;
  graceMs?: number;
}

/**
 * Stops the hand-opened tunnels of finished launches that are no longer live
 * (see the module comment for every check). Does nothing when `sys` has no
 * tunnel service or it can't be listed. Returns what it signalled.
 */
export async function reapWorkerTunnels(db: Database, sys: ProcessSystem, opts: ReapWorkerTunnelsOptions): Promise<WorkerTunnelStop[]> {
  const host = sys.tunnels;
  if (!host) return [];
  const liveness = opts.paneAlive ? { paneAlive: opts.paneAlive } : {};
  const finished = new Map<string, string>();
  const kept = new Set<string>();
  for (const launch of getLaunches(db)) {
    const id8 = launch.id.slice(0, 8);
    if (launchFinished(db, launch) && !launchLiveForHygiene(db, launch, liveness)) {
      if (!finished.has(id8)) finished.set(id8, launch.id);
    } else kept.add(id8);
  }
  const scope = opts.launchIds ? new Set(opts.launchIds.map((id) => id.slice(0, 8))) : null;
  for (const id8 of [...finished.keys()]) if (kept.has(id8) || (scope && !scope.has(id8))) finished.delete(id8);
  if (finished.size === 0) return [];

  const listed = await host.list();
  if (!listed) return [];
  const liveReview = liveReviewTunnelNames(db);
  const picks: Array<{ name: string; pid: number; port: number; id8: string }> = [];
  for (const entry of listed) {
    const id8 = workerTunnelLaunchPrefix(entry.name, host.hostUser);
    if (!id8 || !finished.has(id8)) continue;
    if (isReservedTunnelName(entry.name, host.hostUser) || liveReview.has(entry.name)) continue;
    if (entry.hostname !== host.hostname || entry.pid === undefined || entry.localPort === undefined) continue;
    if (REVIEW_TUNNEL_RESERVED_PORTS.has(entry.localPort)) continue;
    picks.push({ name: entry.name, pid: entry.pid, port: entry.localPort, id8 });
  }
  if (picks.length === 0) return [];

  const table = sys.processTable();
  if (!table) return [];
  const guard = buildGuard(table, sys, opts.installDir);
  const targets: Array<(typeof picks)[number] & { args: string; started?: number }> = [];
  for (const p of picks) {
    const row = guard.byPid.get(p.pid);
    if (!row || protectedReason(row, guard) !== null) continue;
    if (!argsNamePort(row.args, p.port) || !row.args.toLowerCase().includes(`sw-${p.id8}-`)) continue;
    targets.push({ ...p, args: row.args, ...(row.started !== undefined ? { started: row.started } : {}) });
  }
  if (targets.length === 0) return [];
  const outcomes = await stopProcesses(
    sys,
    targets.map((t) => ({ pid: t.pid, args: t.args, ...(t.started !== undefined ? { started: t.started } : {}) })),
    { ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}), groupOk: () => false }
  );
  return targets.map((t, i) => ({ name: t.name, pid: t.pid, port: t.port, launchId: finished.get(t.id8)!, outcome: outcomes[i]! }));
}

/** One line naming the tunnels stopped, for an activity note; null when none was. */
export function describeWorkerTunnels(stops: WorkerTunnelStop[]): string | null {
  const stopped = stops.filter((s) => s.outcome === "terminated" || s.outcome === "killed");
  if (stopped.length === 0) return null;
  return stopped.map((s) => `tunnel ${s.name} (pid ${s.pid}, port ${s.port})${s.outcome === "killed" ? " — needed SIGKILL" : ""}`).join(", ");
}
