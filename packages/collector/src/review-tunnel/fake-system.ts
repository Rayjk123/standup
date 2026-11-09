import { argsNamePort, type ListedTunnel, type ReviewTunnelSystem } from "./system.js";
import { commandTunnelProvider, type TunnelProvider } from "../tunnels/provider.js";

/** The fake host's tunnel CLI. */
export const FAKE_TUNNEL_BIN = "/fake/tunnelctl";

/** The URL the fake tunnel provider gives a tunnel named `name`. */
export const fakeTunnelUrl = (name: string) => `https://${name}.tunnels.example.test`;

/** A process the fake host started. */
export interface FakeProcess {
  pid: number;
  /** Its process group: its own pid unless a test says otherwise. */
  pgid: number;
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  credentials: boolean;
  alive: boolean;
}

/**
 * A fake host for review-tunnel tests: spawned processes are records with
 * pids, ports are free unless listed in `busy`, a served port answers once
 * its serve process "started", and the provider's listing returns `listed`. Nothing
 * real is started, bound or signalled.
 */
export class FakeTunnelSystem implements ReviewTunnelSystem {
  hostUser = "alice";
  hostname = "alice-test-host";
  tunnelBin = FAKE_TUNNEL_BIN;
  workDir = "/fake/review-tunnels";
  /** A command provider over the fake CLI, listing what `listed` holds. */
  provider: TunnelProvider = {
    ...commandTunnelProvider({
      create: `${FAKE_TUNNEL_BIN} open {port} --name {name} --region {region} --allow {allow}`,
      url: fakeTunnelUrl("{name}"),
    }),
    list: async () => this.listed,
  };
  processes: FakeProcess[] = [];
  killed: number[] = [];
  runs: Array<{ argv: string[]; cwd: string; pid: number }> = [];
  /** Ports something else listens on. */
  busy = new Set<number>();
  /** The exit code setup returns. */
  setupCode = 0;
  /** Runs while setup "runs", before it returns. */
  duringSetup: () => void = () => {};
  /** false: the serve process never answers on its port. */
  serveAnswers = true;
  /** true: the serve process exits as soon as its port answers (another process holds the port). */
  serveExitsAfterAnswer = false;
  /** false: the tunnel process exits right after it starts. */
  tunnelStays = true;
  /** What the provider's listing reports; null when it can't be asked. */
  listed: ListedTunnel[] | null = [];
  /** Extra command lines for pids the fake didn't spawn (a leaked process, a reused pid). */
  foreign = new Map<number, string>();
  clock = new Date("2026-10-08T12:00:00Z");
  private nextPid = 40_000;

  logFile = (id: string, part: string) => `/fake/logs/${id}-${part}.log`;

  spawn: ReviewTunnelSystem["spawn"] = (argv, opts) => {
    const pid = this.nextPid++;
    const isTunnel = argv[0] === this.tunnelBin;
    this.processes.push({ pid, pgid: pid, argv, cwd: opts.cwd, env: opts.env, credentials: opts.credentials, alive: !isTunnel || this.tunnelStays });
    return pid;
  };

  run: ReviewTunnelSystem["run"] = async (argv, opts) => {
    const pid = this.nextPid++;
    this.processes.push({ pid, pgid: pid, argv, cwd: opts.cwd, credentials: false, alive: true });
    this.runs.push({ argv, cwd: opts.cwd, pid });
    opts.onStart?.(pid);
    this.duringSetup();
    const proc = this.processes.find((p) => p.pid === pid)!;
    const killed = !proc.alive;
    proc.alive = false;
    return killed ? -1 : this.setupCode;
  };

  portFree = async (port: number) =>
    !this.busy.has(port) && !this.processes.some((p) => p.alive && p.argv.includes(String(port)) && p.argv[0] !== this.tunnelBin);

  waitForPort: ReviewTunnelSystem["waitForPort"] = async (_port, _timeoutMs, pid) => {
    if (this.serveExitsAfterAnswer) {
      this.crash(pid);
      return true;
    }
    return this.serveAnswers && this.isAlive(pid);
  };

  isAlive = (pid: number) => this.processes.some((p) => p.pid === pid && p.alive) || this.foreign.has(pid);

  commandMentions = (pid: number, port: number) => {
    const proc = this.processes.find((p) => p.pid === pid && p.alive);
    if (proc) return argsNamePort(proc.argv.join(" "), port);
    const args = this.foreign.get(pid);
    return args !== undefined && argsNamePort(args, port);
  };

  /** true: `ps` fails, so group membership can't be told. */
  psBroken = false;

  groupMentions = (pgid: number, port: number): boolean | null => {
    if (this.psBroken) return null;
    return (
      this.processes.some((p) => p.pgid === pgid && p.alive && argsNamePort(p.argv.join(" "), port)) ||
      (this.foreign.has(pgid) && argsNamePort(this.foreign.get(pgid)!, port))
    );
  };

  killGroup = (pgid: number) => {
    this.killed.push(pgid);
    for (const p of this.processes) if (p.pgid === pgid) p.alive = false;
    this.foreign.delete(pgid);
  };

  listTunnels = async () => this.listed;

  sleep = async (_ms: number) => {};

  now = () => this.clock;

  /** When the fake host booted (default: long before any test's clock). */
  booted = new Date("2026-01-01T00:00:00Z");
  bootedAt = () => this.booted;

  /** The live processes whose argv starts with `bin` (the tunnel CLI when omitted). */
  live(bin = this.tunnelBin): FakeProcess[] {
    return this.processes.filter((p) => p.alive && p.argv[0] === bin);
  }

  /** Marks `pid` dead without it being killed (the process crashed). */
  crash(pid: number): void {
    for (const p of this.processes) if (p.pid === pid) p.alive = false;
  }

  /** Adds a live child to `pgid`'s group, running `argv` (e.g. the server an `npm run` wrapper started). */
  child(pgid: number, argv: string[]): number {
    const pid = this.nextPid++;
    this.processes.push({ pid, pgid, argv, cwd: "/", credentials: false, alive: true });
    return pid;
  }
}
