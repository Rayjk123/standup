import type { Database } from "bun:sqlite";
import { existsSync, realpathSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import {
  DEFAULT_COLLECTOR_PORT,
  DEFAULT_REVIEW_TUNNEL_NAME_PATTERN,
  DEFAULT_REVIEW_TUNNEL_PORT_RANGE,
  DEFAULT_REVIEW_TUNNEL_TTL_HOURS,
  MAX_REVIEW_TUNNEL_NAME,
  DEFAULT_WS_PORT,
  MAX_REVIEW_TUNNEL_TTL_HOURS,
  REVIEW_TUNNEL_RESERVED_SUFFIXES,
  reviewTunnelActive,
  reviewTunnelName,
  splitCommand,
  tunnelSlug,
} from "@standup/shared";
import type { Launch, PipelineRun, ReviewTunnel, ReviewTunnelCloseReason, ReviewTunnelConfig } from "@standup/shared";
import {
  claimReviewTunnel,
  endReviewTunnel,
  getLaunch,
  getPersonaJob,
  getPipelineRunByLaunch,
  getReviewTunnel,
  knownReviewTunnelEndpoints,
  listUnverifiedStopReviewTunnels,
  setReviewTunnelStopUnverified,
  listLiveReviewTunnels,
  liveReviewTunnelForLaunch,
  liveReviewTunnelNames,
  liveReviewTunnelPorts,
  liveReviewTunnelsForJob,
  markReviewTunnelOpen,
  personaJobForLaunch,
  setReviewTunnelPids,
} from "@standup/store";
import type { ReviewTunnelSystem } from "./system.js";

/**
 * Review tunnels: an HTTPS tunnel (through the collector's TunnelProvider) to
 * a launch's branch build, so its UI can be reviewed from a browser while the
 * job is in review. With the default provider (disabled) no tunnel opens.
 *
 * Opening (`open`): the run's frozen definition says how the project serves
 * its UI (reviewTunnel). A port is claimed from the config's range — a row in
 * review_tunnels, whose partial unique index refuses a port, name or launch a
 * live row already holds, so concurrent openings never collide — and checked
 * free on loopback. Setup runs (unless its skip path exists), the serve
 * command starts in its own process group with `{port}` filled in, and once
 * the port answers the provider's tunnel command starts beside it.
 * Both are spawned by the collector itself, never through a worker's shell.
 *
 * Closing (`close`): both process groups are signalled and the row ends with
 * its reason. Only processes the row recorded are signalled, and only after
 * checking their command line still names the tunnel's port, so a pid the OS
 * reused is left alone. A standing tunnel the host keeps open by hand is out
 * of reach once its port and name suffix are reserved (ReservedTunnels), as
 * Standup's own console tunnel is by default and any the owner adds through
 * RESERVED_PORTS_ENV and RESERVED_SUFFIXES_ENV are; it is never recorded in
 * review_tunnels.
 *
 * Sweeping (`sweep`, periodic): live tunnels past their TTL, whose job closed,
 * whose launch ended, whose run completed or whose processes died are torn
 * down. Reconciling (`reconcile`, at collector start and nightly) also sweeps,
 * then looks for tunnel processes the tunnel service lists for this host under
 * a name Standup opened but no live row holds — a leak from a crash between
 * spawning and recording — and stops them.
 */

/** Standup's own ports: the console (5173) and the collector's HTTP and WS ports. */
export const STANDUP_OWN_PORTS: readonly number[] = [5173, DEFAULT_COLLECTOR_PORT, DEFAULT_WS_PORT];

/** The setting that adds ports a review tunnel never serves on (comma-separated). */
export const RESERVED_PORTS_ENV = "STANDUP_REVIEW_TUNNEL_RESERVED_PORTS";
/** The setting that adds tunnel name suffixes a review tunnel never takes (comma-separated). */
export const RESERVED_SUFFIXES_ENV = "STANDUP_REVIEW_TUNNEL_RESERVED_SUFFIXES";

/**
 * What a review tunnel never takes or touches: ports it never serves on,
 * whatever its range says, and name suffixes (after `<host user>-`) it never
 * opens or stops. They keep the host's standing tunnels, Standup's own
 * console tunnel included, out of reach.
 */
export interface ReservedTunnels {
  ports: ReadonlySet<number>;
  suffixes: ReadonlySet<string>;
}

const RESERVED_SUFFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The comma-separated entries of a setting, trimmed, empties dropped. */
function listSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * The reserved ports and suffixes: Standup's own built-in ones
 * (STANDUP_OWN_PORTS and REVIEW_TUNNEL_RESERVED_SUFFIXES) plus the ones
 * RESERVED_PORTS_ENV and RESERVED_SUFFIXES_ENV add for the host's standing
 * tunnels. An entry that isn't a port (1-65535) or a lowercase DNS label is
 * skipped and named in `invalid`.
 */
export function reservedTunnelsFromEnv(env: NodeJS.ProcessEnv = process.env): ReservedTunnels & { invalid: string[] } {
  const ports = new Set(STANDUP_OWN_PORTS);
  const suffixes = new Set(REVIEW_TUNNEL_RESERVED_SUFFIXES);
  const invalid: string[] = [];
  for (const raw of listSetting(env[RESERVED_PORTS_ENV])) {
    const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
    if (port >= 1 && port <= 65_535) ports.add(port);
    else invalid.push(`${RESERVED_PORTS_ENV}: ${raw}`);
  }
  for (const raw of listSetting(env[RESERVED_SUFFIXES_ENV])) {
    const suffix = raw.toLowerCase();
    if (RESERVED_SUFFIX_PATTERN.test(suffix)) suffixes.add(suffix);
    else invalid.push(`${RESERVED_SUFFIXES_ENV}: ${raw}`);
  }
  return { ports, suffixes, invalid };
}

/** The reserved ports and suffixes the collector runs with, read from its environment once. */
export const REVIEW_TUNNEL_RESERVED: ReservedTunnels = (() => {
  const { ports, suffixes, invalid } = reservedTunnelsFromEnv();
  if (invalid.length) console.warn(`[review-tunnel] Ignoring reserved entries that don't parse: ${invalid.join("; ")}`);
  return { ports, suffixes };
})();

/** Ports a review tunnel never serves on (REVIEW_TUNNEL_RESERVED.ports). */
export const REVIEW_TUNNEL_RESERVED_PORTS: ReadonlySet<number> = REVIEW_TUNNEL_RESERVED.ports;

/** How long the serve command may take to answer on its port. */
export const SERVE_READY_TIMEOUT_MS = 120_000;
/** How long setup may run. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
/** How long the tunnel process must stay up after starting before the tunnel counts as open. */
export const TUNNEL_SETTLE_MS = 2_000;

export interface ReviewTunnelNotify {
  /** Writes a structural checkpoint for `sessionId`. */
  checkpoint: (sessionId: string, text: string) => void;
  /** Called whenever a tunnel's record changes. */
  changed?: (tunnel: ReviewTunnel) => void;
}

export type OpenResult =
  | { opened: ReviewTunnel }
  | { existing: ReviewTunnel }
  | { skipped: string }
  | { failed: string; tunnel?: ReviewTunnel };

export interface SweepResult {
  closed: Array<{ id: string; reason: ReviewTunnelCloseReason }>;
  /** Leaked tunnel processes stopped (reconcile only). */
  leaked: Array<{ name: string; pid: number }>;
}

const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);
/**
 * Launch statuses that end a tunnel: a cleaned launch's worktree is gone. A
 * stopped (failed) launch keeps its worktree and its tunnel — a worker is
 * often stopped while its review is still pending — until the job closes,
 * the review is decided or the TTL runs out.
 */
const ENDED_LAUNCH = new Set(["cleaned"]);

/**
 * Whether `name` is a tunnel name a review tunnel may never touch: outside
 * the host user's names, or one with a reserved suffix (`suffixes`). The
 * host user is normalised as review-tunnel names are (reviewTunnelName).
 */
export function isReservedTunnelName(
  name: string,
  hostUser: string,
  suffixes: ReadonlySet<string> = REVIEW_TUNNEL_RESERVED.suffixes
): boolean {
  const prefix = `${tunnelSlug(hostUser, 24) || "user"}-`;
  if (!name.startsWith(prefix)) return true;
  return suffixes.has(name.slice(prefix.length));
}

/**
 * The directory `config.dir` names inside the launch's worktree, or an error.
 * A launch whose worktree already is that directory (the package checked out
 * on its own) serves from the worktree. The real path must stay inside the
 * worktree, so a symlink can't point the serve command elsewhere.
 */
export function serveDir(worktreePath: string, dir: string | undefined): { dir: string } | { error: string } {
  if (!worktreePath || !isAbsolute(worktreePath)) return { error: "the launch has no worktree" };
  let root: string;
  try {
    root = realpathSync(worktreePath);
  } catch {
    return { error: `the worktree ${worktreePath} does not exist` };
  }
  let target = dir ? resolve(root, dir) : root;
  if (dir && !existsSync(target) && basename(root) === basename(dir)) target = root;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return { error: `${dir ?? "."} does not exist in the worktree` };
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: `${dir} leaves the worktree` };
  if (!statSync(real).isDirectory()) return { error: `${dir} is not a directory` };
  return { dir: real };
}

/** The argv a config command gives with `{port}` filled in, or null when it doesn't parse. */
export function commandArgv(command: string, port: number): string[] | null {
  const argv = splitCommand(command);
  if (!argv || argv.length === 0) return null;
  return argv.map((a) => a.split("{port}").join(String(port)));
}

export class ReviewTunnels {
  /** Launch ids an opening is in flight for, so a re-entered stage doesn't race itself. */
  private readonly opening = new Set<string>();
  private readonly inflight = new Set<Promise<OpenResult>>();
  /** The process group of each opening's setup while it runs, by tunnel id. */
  private readonly setupPids = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly sys: ReviewTunnelSystem,
    private readonly notify: ReviewTunnelNotify,
    private readonly reserved: ReservedTunnels = REVIEW_TUNNEL_RESERVED
  ) {}

  /** The host user the tunnel CLI prefixes names with. */
  get hostUser(): string {
    return this.sys.hostUser;
  }

  private changed(id: string): ReviewTunnel | null {
    const t = getReviewTunnel(this.db, id);
    if (t) this.notify.changed?.(t);
    return t;
  }

  private checkpoint(launch: Launch | null, text: string): void {
    if (launch?.sessionId) this.notify.checkpoint(launch.sessionId, text);
  }

  /** A free port in `range` no live tunnel holds and nothing listens on, lowest first; null when none is. */
  private async freePort(range: readonly [number, number], skip: Set<number>): Promise<number | null> {
    const held = liveReviewTunnelPorts(this.db);
    for (let p = range[0]; p <= range[1]; p++) {
      if (this.reserved.ports.has(p) || held.has(p) || skip.has(p)) continue;
      if (await this.sys.portFree(p)) return p;
      skip.add(p);
    }
    return null;
  }

  /**
   * The tunnel name for the launch and the suffix `--name` gets, made unique
   * with a numeric suffix among live review tunnels and every tunnel the
   * tunnel service lists (`listed`) — so a review tunnel never takes over one
   * the owner made by hand. When the list couldn't be read (`unlisted`), the
   * launch id's start is appended, since a hand-made tunnel can't be ruled out.
   */
  private tunnelName(
    config: ReviewTunnelConfig,
    launch: Launch,
    owner: string,
    listed: Set<string>,
    unlisted: boolean
  ): { name: string; suffix: string } {
    const job = personaJobForLaunch(this.db, launch.id)?.job;
    const jobSlug = job?.title || launch.branch.split("/").pop() || launch.id;
    const base = reviewTunnelName(config.namePattern ?? DEFAULT_REVIEW_TUNNEL_NAME_PATTERN, {
      hostUser: this.sys.hostUser,
      jobSlug,
      user: owner,
      launchId: launch.id,
    });
    const prefix = base.name.slice(0, base.name.length - base.suffix.length);
    const taken = liveReviewTunnelNames(this.db);
    const free = (suffix: string) =>
      !this.reserved.suffixes.has(suffix) && !taken.has(`${prefix}${suffix}`) && !listed.has(`${prefix}${suffix}`);
    const room = MAX_REVIEW_TUNNEL_NAME - prefix.length - 4;
    if (unlisted) {
      const suffix = `${base.suffix.slice(0, room - 4).replace(/-+$/, "")}-${launch.id.slice(0, 6)}`;
      if (free(suffix)) return { name: `${prefix}${suffix}`, suffix };
    } else if (free(base.suffix)) return base;
    for (let n = 2; n < 100; n++) {
      const suffix = `${base.suffix.slice(0, room).replace(/-+$/, "")}-${n}`;
      if (free(suffix)) return { name: `${prefix}${suffix}`, suffix };
    }
    const suffix = `${base.suffix.slice(0, room - 4).replace(/-+$/, "")}-${launch.id.slice(0, 6)}`;
    return { name: `${prefix}${suffix}`, suffix };
  }

  /**
   * Opens a review tunnel for the run's launch when its frozen definition
   * configures one. Idempotent: a launch with a live tunnel keeps it.
   */
  async open(run: PipelineRun): Promise<OpenResult> {
    const config = run.definition.reviewTunnel;
    if (!reviewTunnelActive(config)) return { skipped: "the project has no review tunnel configured" };
    if (!this.sys.provider.enabled) return { skipped: this.sys.provider.disabledReason ?? "tunnels are disabled" };
    const launch = getLaunch(this.db, run.launchId);
    if (!launch) return { skipped: "the launch is gone" };
    if (ENDED_LAUNCH.has(launch.status)) return { skipped: `the launch is ${launch.status}` };
    const live = liveReviewTunnelForLaunch(this.db, launch.id);
    if (live) return { existing: live };
    if (this.opening.has(launch.id)) return { skipped: "an opening is already in flight" };
    this.opening.add(launch.id);
    const pending = this.openFor(run, launch, config).finally(() => {
      this.opening.delete(launch.id);
      this.inflight.delete(pending);
    });
    this.inflight.add(pending);
    return pending;
  }

  /** Resolves once every opening in flight has finished (opened or failed). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async openFor(run: PipelineRun, launch: Launch, config: ReviewTunnelConfig & { serve: string }): Promise<OpenResult> {
    const where = serveDir(launch.worktreePath, config.dir);
    if ("error" in where) return this.failEarly(launch, where.error);
    // An audience the provider can't pass fails here, before any setup or serve command runs.
    const audience = this.sys.provider.audienceProblem?.(config.allow);
    if (audience) return this.failEarly(launch, audience);
    const range = config.portRange ?? DEFAULT_REVIEW_TUNNEL_PORT_RANGE;
    const job = personaJobForLaunch(this.db, launch.id)?.job;
    const listing = await this.sys.listTunnels();
    const listed = new Set(listing?.map((t) => t.name) ?? []);

    // Claim a port and name: the insert is what reserves them, so a lost race retries the next port.
    let claimed: ReviewTunnel | null = null;
    let suffix = "";
    const skip = new Set<number>();
    for (let tries = 0; tries < 20 && !claimed; tries++) {
      const port = await this.freePort(range, skip);
      if (port === null) {
        let usable = 0;
        for (let p = range[0]; p <= range[1]; p++) if (!this.reserved.ports.has(p)) usable++;
        const why =
          usable === 0
            ? `port range ${range[0]}-${range[1]} holds only reserved ports (${[...this.reserved.ports].sort((a, b) => a - b).join(", ")})`
            : `no free port in ${range[0]}-${range[1]}`;
        return this.failEarly(launch, why);
      }
      const named = this.tunnelName(config, launch, run.owner, listed, listing === null);
      const name = named.name;
      suffix = named.suffix;
      const result = claimReviewTunnel(this.db, {
        launchId: launch.id,
        runId: run.id,
        ...(job ? { jobId: job.id } : {}),
        owner: run.owner,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        name,
        url: this.sys.provider.url(name),
        port,
      });
      if ("tunnel" in result) claimed = result.tunnel;
      else if (result.conflict === "launch") {
        const live = liveReviewTunnelForLaunch(this.db, launch.id);
        return live ? { existing: live } : { skipped: "another opening holds the launch" };
      } else skip.add(port);
    }
    if (!claimed) return this.failEarly(launch, "could not claim a port and name");
    const tunnel = claimed;
    // Belt and braces: the name handed to the CLI is never a reserved one, whatever produced it.
    if (this.reserved.suffixes.has(suffix)) {
      endReviewTunnel(this.db, tunnel.id, { status: "failed", error: `refused the reserved tunnel name ${tunnel.name}` });
      return this.failEarly(launch, `refused the reserved tunnel name ${tunnel.name}`);
    }
    this.changed(tunnel.id);

    const fail = async (error: string): Promise<OpenResult> => {
      const t = getReviewTunnel(this.db, tunnel.id);
      this.stopOrFlag(t ?? tunnel);
      // Closed on purpose meanwhile (its own teardown already said so): not a failure to report.
      if (!endReviewTunnel(this.db, tunnel.id, { status: "failed", error })) {
        return { failed: "closed while opening", tunnel: getReviewTunnel(this.db, tunnel.id) ?? tunnel };
      }
      const ended = this.changed(tunnel.id) ?? tunnel;
      this.checkpoint(launch, `Review tunnel for ${launch.branch} failed to open: ${error}`);
      return { failed: error, tunnel: ended };
    };

    if (config.setup && !(config.setupSkipIf && existsSync(join(where.dir, config.setupSkipIf)))) {
      const argv = commandArgv(config.setup, tunnel.port);
      if (!argv) return fail("the setup command does not parse");
      let code: number;
      try {
        code = await this.sys.run(argv, {
          cwd: where.dir,
          logFile: this.sys.logFile(tunnel.id, "setup"),
          timeoutMs: SETUP_TIMEOUT_MS,
          onStart: (pid) => this.setupPids.set(tunnel.id, pid),
        });
      } finally {
        this.setupPids.delete(tunnel.id);
      }
      if (!this.stillOpening(tunnel.id)) return { failed: "closed while opening", tunnel: getReviewTunnel(this.db, tunnel.id) ?? tunnel };
      if (code !== 0) return fail(`setup (${argv.join(" ")}) exited ${code}`);
      // Only the row held the port while setup ran; something else may have bound it meanwhile.
      if (!(await this.sys.portFree(tunnel.port))) return fail(`127.0.0.1:${tunnel.port} was taken while setup ran`);
    }

    const serve = commandArgv(config.serve, tunnel.port);
    if (!serve) return fail("the serve command does not parse");
    let servePid: number;
    try {
      servePid = this.sys.spawn(serve, { cwd: where.dir, logFile: this.sys.logFile(tunnel.id, "serve"), env: { PORT: String(tunnel.port) }, credentials: false });
    } catch (err) {
      return fail(`the serve command could not start: ${(err as Error).message}`);
    }
    setReviewTunnelPids(this.db, tunnel.id, { servePid });
    if (!(await this.sys.waitForPort(tunnel.port, SERVE_READY_TIMEOUT_MS, servePid))) {
      return fail(`nothing answered on 127.0.0.1:${tunnel.port} within ${SERVE_READY_TIMEOUT_MS / 1000}s`);
    }
    // Something answering while the serve command is gone is someone else's listener (e.g. a
    // `--strictPort` server that lost the port race): never publish it.
    if (!this.sys.isAlive(servePid)) return fail(`the serve command exited; 127.0.0.1:${tunnel.port} is held by another process`);
    if (!this.stillOpening(tunnel.id)) {
      this.stopOrFlag(getReviewTunnel(this.db, tunnel.id) ?? tunnel);
      return { failed: "closed while opening", tunnel: getReviewTunnel(this.db, tunnel.id) ?? tunnel };
    }

    // Setup may have run for minutes: make sure no tunnel took the name meanwhile.
    if ((await this.sys.listTunnels())?.some((l) => l.name === tunnel.name)) {
      return fail(`a tunnel named ${tunnel.name} appeared while this one was opening`);
    }
    // Torn down during that wait: the CLI, which runs with the owner's credentials, must not start.
    if (!this.stillOpening(tunnel.id)) {
      this.stopOrFlag(getReviewTunnel(this.db, tunnel.id) ?? tunnel);
      return { failed: "closed while opening", tunnel: getReviewTunnel(this.db, tunnel.id) ?? tunnel };
    }
    const tunnelCommand = this.sys.provider.createArgv({
      port: tunnel.port,
      suffix,
      ...(config.region ? { region: config.region } : {}),
      ...(config.allow ? { allow: config.allow } : {}),
    });
    if (!tunnelCommand) {
      return fail(this.sys.provider.audienceProblem?.(config.allow) ?? this.sys.provider.disabledReason ?? "the tunnel provider opens no tunnels");
    }
    let tunnelPid: number;
    try {
      // The CLI runs with the owner's credentials, so never from the worktree branch code controls.
      tunnelPid = this.sys.spawn(tunnelCommand, {
        cwd: this.sys.workDir,
        logFile: this.sys.logFile(tunnel.id, "tunnel"),
        credentials: true,
      });
    } catch (err) {
      return fail(`the tunnel command could not start: ${(err as Error).message}`);
    }
    setReviewTunnelPids(this.db, tunnel.id, { tunnelPid });
    await this.sys.sleep(TUNNEL_SETTLE_MS);
    if (!this.sys.isAlive(tunnelPid)) return fail(`the tunnel process exited (see ${this.sys.logFile(tunnel.id, "tunnel")})`);
    if (!this.sys.isAlive(servePid)) return fail(`the serve command exited (see ${this.sys.logFile(tunnel.id, "serve")})`);

    const ttlHours = config.ttlHours ?? DEFAULT_REVIEW_TUNNEL_TTL_HOURS;
    const expiresAt = new Date(this.sys.now().getTime() + ttlHours * 3_600_000).toISOString();
    if (!markReviewTunnelOpen(this.db, tunnel.id, expiresAt)) {
      // Closed during the settle wait: its teardown already signalled what it recorded; this makes sure.
      this.stopOrFlag(getReviewTunnel(this.db, tunnel.id) ?? tunnel);
      return { failed: "closed while opening", tunnel: getReviewTunnel(this.db, tunnel.id) ?? tunnel };
    }
    const opened = this.changed(tunnel.id)!;
    this.checkpoint(
      launch,
      `Review tunnel open: ${opened.url} serves ${launch.branch} (local http://127.0.0.1:${opened.port}; torn down when the job closes, the review is decided, or after ${ttlHours}h).`
    );
    return { opened };
  }

  private stillOpening(id: string): boolean {
    return getReviewTunnel(this.db, id)?.status === "opening";
  }

  private failEarly(launch: Launch, error: string): OpenResult {
    this.checkpoint(launch, `Review tunnel for ${launch.branch} not opened: ${error}`);
    return { failed: error };
  }

  /**
   * Signals the tunnel's recorded process groups (each spawned as its own
   * group, so the pid is the group id) — each only while some member of the
   * group still names the tunnel's port, so a reused pid is never touched,
   * and a group whose leader died (an `npm run` wrapper whose server child
   * lives on) is still stopped.
   */
  private stopProcesses(t: ReviewTunnel, skip: ReadonlySet<number> = new Set()): boolean {
    if (this.reserved.ports.has(t.port)) return true;
    let verified = true;
    for (const pgid of [t.tunnelPid, t.servePid]) {
      if (pgid === undefined || skip.has(pgid)) continue;
      const mentions = this.sys.groupMentions(pgid, t.port);
      if (mentions === true) this.sys.killGroup(pgid);
      else if (mentions === null) verified = false;
    }
    return verified;
  }

  /** stopProcesses, flagging the row for a retry when its processes couldn't be checked. */
  private stopOrFlag(t: ReviewTunnel): void {
    if (!this.stopProcesses(t)) setReviewTunnelStopUnverified(this.db, t.id, true);
  }

  /**
   * Stops the processes of tunnels that were closed but whose processes
   * couldn't be checked then (`ps` failed; the row is flagged, so this
   * survives a restart); each is retried until it can be. Only rows closed
   * since the host booted: before that, their process groups are gone and the
   * ids may since belong to anything. A group a live tunnel holds is skipped.
   */
  private retryUnverifiedStops(): void {
    const pending = listUnverifiedStopReviewTunnels(this.db, this.sys.bootedAt().toISOString());
    if (pending.length === 0) return;
    const liveGroups = new Set(
      listLiveReviewTunnels(this.db)
        .flatMap((t) => [t.servePid, t.tunnelPid])
        .filter((p): p is number => p !== undefined)
    );
    for (const t of pending) if (this.stopProcesses(t, liveGroups)) setReviewTunnelStopUnverified(this.db, t.id, false);
  }

  /** Tears down live tunnel `id` with `reason`; false when it wasn't live (already closed). */
  close(id: string, reason: ReviewTunnelCloseReason): boolean {
    const t = getReviewTunnel(this.db, id);
    if (!t || (t.status !== "opening" && t.status !== "open")) return false;
    if (!endReviewTunnel(this.db, id, { status: "closed", reason })) return false;
    // A setup still running for an opening is stopped too; it holds no port yet.
    const setupPid = this.setupPids.get(id);
    if (setupPid !== undefined) {
      this.sys.killGroup(setupPid);
      this.setupPids.delete(id);
    }
    this.stopOrFlag(t);
    const closed = this.changed(id);
    const launch = getLaunch(this.db, t.launchId);
    this.checkpoint(launch, `Review tunnel ${t.url} torn down (${reason.replace(/_/g, " ")}).`);
    return !!closed;
  }

  /** Tears down the launch's live tunnel; the ids closed. */
  closeForLaunch(launchId: string, reason: ReviewTunnelCloseReason): string[] {
    const t = liveReviewTunnelForLaunch(this.db, launchId);
    return t && this.close(t.id, reason) ? [t.id] : [];
  }

  /** Tears down every live tunnel of the job's launches; the ids closed. */
  closeForJob(jobId: string, reason: ReviewTunnelCloseReason): string[] {
    return liveReviewTunnelsForJob(this.db, jobId)
      .filter((t) => this.close(t.id, reason))
      .map((t) => t.id);
  }

  /** Why live tunnel `t` should be torn down now, or null to keep it. */
  private staleReason(t: ReviewTunnel, now: number): ReviewTunnelCloseReason | null {
    if (t.expiresAt && Date.parse(t.expiresAt) <= now) return "expired";
    // An opening that never finished (the collector stopped mid-open) is stale after the serve timeout.
    if (t.status === "opening" && Date.parse(t.updatedAt) + SERVE_READY_TIMEOUT_MS + SETUP_TIMEOUT_MS < now && !this.opening.has(t.launchId)) {
      return "lost";
    }
    const jobId = t.jobId ?? personaJobForLaunch(this.db, t.launchId)?.job.id;
    const job = jobId ? getPersonaJob(this.db, jobId, { withView: false }) : null;
    if (job && CLOSED_JOB.has(job.status)) return "job_closed";
    const launch = getLaunch(this.db, t.launchId);
    if (!launch || ENDED_LAUNCH.has(launch.status)) return "launch_ended";
    const run = getPipelineRunByLaunch(this.db, t.launchId);
    if (run?.status === "complete") return "review_decided";
    // A Best-of-N attempt the owner didn't pick (or a run turned off) is no longer up for review.
    if (run?.status === "disabled") return "run_disabled";
    if (t.status === "open") {
      // Dead means no member of the group still names the port; a pid merely reused by something else is dead too.
      const dead = [t.servePid, t.tunnelPid].some((pgid) => pgid === undefined || this.sys.groupMentions(pgid, t.port) === false);
      if (dead) return "lost";
    }
    return null;
  }

  /** Tears down every live tunnel that is stale (see staleReason). */
  sweep(): SweepResult {
    this.retryUnverifiedStops();
    const now = this.sys.now().getTime();
    const closed: SweepResult["closed"] = [];
    for (const t of listLiveReviewTunnels(this.db)) {
      const reason = this.staleReason(t, now);
      if (reason && this.close(t.id, reason)) closed.push({ id: t.id, reason });
    }
    return { closed, leaked: [] };
  }

  /**
   * sweep, then stops leaked tunnel processes: ones the tunnel service lists
   * on this host under a name and port a review tunnel of Standup's had (a
   * row in review_tunnels) while no live row holds that name. A name a live
   * row holds is that row's to manage, whatever pid the service reports (the
   * CLI may run behind a launcher). Entries without a hostname, the reserved
   * names and ports, and anything Standup never opened are never touched.
   */
  async reconcile(): Promise<SweepResult> {
    // The sweep also retries stops left unverified, including ones from before a restart.
    const result = this.sweep();
    const since = new Date(this.sys.now().getTime() - MAX_REVIEW_TUNNEL_TTL_HOURS * 3_600_000).toISOString();
    const listed = await this.sys.listTunnels();
    if (!listed) return result;
    // Only recent records count: an old review tunnel's name reused by hand long after is the owner's.
    const known = knownReviewTunnelEndpoints(this.db, since);
    const live = liveReviewTunnelNames(this.db);
    for (const entry of listed) {
      if (live.has(entry.name) || isReservedTunnelName(entry.name, this.sys.hostUser, this.reserved.suffixes)) continue;
      if (entry.hostname !== this.sys.hostname) continue;
      if (entry.pid === undefined || entry.localPort === undefined) continue;
      if (this.reserved.ports.has(entry.localPort)) continue;
      if (!known.get(entry.name)?.has(entry.localPort)) continue;
      if (!this.sys.isAlive(entry.pid) || !this.sys.commandMentions(entry.pid, entry.localPort)) continue;
      this.sys.killGroup(entry.pid);
      result.leaked.push({ name: entry.name, pid: entry.pid });
    }
    return result;
  }
}
