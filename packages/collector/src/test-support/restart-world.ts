import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { CollectorSlot, GatewayStats, LeaderInfo, StandbyInfo } from "@standup/shared/topology";
import { GATEWAY_STATS_PATH, leaderFilePath, readJsonFile, standbyDirPath, standbyFilePath, writeJsonAtomic } from "@standup/shared/topology";
import type { CommandResult, HttpResult, RestartExec } from "../restart/exec.js";
import type { RestartRecord } from "../restart/state.js";
import { RESTART_SCHEMA_VERSION, emptySnapshot } from "../restart/state.js";

/**
 * How a commit's collector behaves once loaded: healthy; crashing at import
 * (in gateway mode it never writes a standby marker); up with Persona's state
 * route failing; hanging at import (alive, never ready); loading fine as a
 * standby but crashing once it takes the leader lock; or, once it takes the
 * lock, copying the database before a migration for migrateMs (the leader
 * file says so) before it serves.
 */
export type Behaviour = "ok" | "crash" | "persona" | "hang" | "lead-crash" | "migrate";

/** One collector slot dev.ts runs in gateway mode: `bun run start` and its `bun run src/index.ts`. */
interface SlotProcs {
  wrapper?: number;
  collector?: number;
  /** The commit the collector loaded. */
  head?: string;
}

/**
 * A fake machine for restart tests: processes, a dev.ts that respawns the
 * collector, a git checkout, and the HTTP endpoints a restart probes. Time is
 * virtual — sleep() advances it — so a whole restart runs in milliseconds.
 */
export class FakeWorld {
  t = 1_000_000;
  private nextPid = 500;
  readonly alive = new Set<number>();
  /** `ps` rows: pid → { ppid, args }. */
  readonly ps = new Map<number, { ppid: number; args: string }>();
  readonly runs: string[][] = [];
  readonly kills: Array<[number, string]> = [];
  /** Called after each virtual sleep, e.g. to land a merge at a chosen moment. */
  onTick?: () => void;
  readonly spawns: Array<{ argv: string[]; cwd: string; logFile: string }> = [];
  /** What each spawn got on stdin, by spawn index ("" for none). */
  readonly spawnInputs: string[] = [];
  /** The environment each spawn was given, by spawn index (undefined: the caller's). */
  readonly spawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  /** Working directories (`readlink /proc/<pid>/cwd`); a booted collector runs from the install's collector package. */
  readonly cwds = new Map<number, string>();
  head = "b".repeat(40);
  dirty: string[] = [];
  /** Untracked files in the install (`?? path` in git status). */
  untracked: string[] = [];
  /** What `git diff --name-only <a> <b>` lists, whatever the commits. */
  changed: string[] = [];
  /** The install the fake collectors run from. */
  installDir = "/install";
  /** dev.ts's pid: the parent of the collectors it (re)starts. */
  devPid = 10;
  /** A collector that crashes at boot under dev.ts stays alive and idle, as `bun run --watch` keeps it. */
  watchIdle = false;
  /** When dev.ts saw its collector exit; more than 5 in a minute and it stops restarting it. */
  readonly devExits: number[] = [];
  /** dev.ts's crash-loop breaker tripped. */
  breakerTripped = false;
  /** Times a collector booted while another one was alive and serving: two collectors racing for the port. */
  portConflicts = 0;
  /** The next this-many collectors dev.ts starts run (not serving) for crashDelayMs, then crash. */
  crashLateBoots = 0;
  crashDelayMs = 1_500;
  private readonly crashAt = new Map<number, number>();
  /** How a commit behaves once booted (classic mode knows ok, crash and persona). */
  readonly behaviour = new Map<string, Behaviour>();
  /** The collector serving the port. */
  up: { pid: number; head: string } | null = null;
  /** dev.ts supervises: a dead collector comes back this long after it exits. */
  supervised = false;
  devRespawns = true;
  respawnDelayMs = 1_000;
  private respawnAt?: number;
  uiUp = true;
  /** Processes that ignore SIGTERM. */
  readonly stubborn = new Set<number>();
  /** Called when a supervisor-spawned process starts (pid, argv). */
  onSpawn?: (pid: number, argv: string[]) => void;

  // ── Gateway mode (startGateway) ──
  /** dev.ts runs two collector slots behind a gateway, with leader and standby files in `dataDir`. */
  gateway = false;
  dataDir = "";
  readonly gatewayPid = 20;
  /** A tmux server the restart must never signal. */
  readonly tmuxPid = 30;
  /** The gateway's stats endpoint answers. */
  gatewayUp = true;
  readonly stats: GatewayStats = {
    pid: 20,
    version: "test",
    startedAt: new Date(1_000_000).toISOString(),
    held: 0,
    heldNow: 0,
    maxHoldMs: 0,
    failed: 0,
    retried: 0,
    wsUpstreamCloses: 0,
    upstream: {},
  };
  readonly slots: Record<CollectorSlot, SlotProcs> = { a: {}, b: {} };
  /** The leader serving behind the gateway. */
  leaderPid?: number;
  /** Collectors waiting on the lock with their code loaded. */
  readonly standbys = new Set<number>();
  /** How long a spawned slot collector takes to load its code. */
  loadDelayMs = 2_000;
  /** How long a standby takes from getting the lock to serving. */
  takeoverDelayMs = 500;
  /** A "migrate" leader's pre-migration copy, from the lock to serving. */
  migrateMs = 0;
  /** WebSocket clients connected; each is closed when the leader goes away. */
  wsClients = 2;
  /** Requests the gateway held during the current gap, and when the gap began. */
  private gapHeld = 0;
  private gapSince?: number;
  /** Requests clients send per second of a gap (each one held until a leader serves). */
  heldPerSecond = 0;
  /** Slot exits dev.ts saw, for its per-slot crash-loop breaker. */
  private readonly slotExits: Record<CollectorSlot, number[]> = { a: [], b: [] };
  /** Pending timed events (loads, takeovers, respawns), by virtual time. */
  private events: Array<{ at: number; run: () => void }> = [];
  /** Every pid that was the leader, in order. */
  readonly leaders: number[] = [];

  constructor() {
    this.behaviour.set(this.head, "ok");
  }

  /**
   * Gateway mode: dev.ts (10) with slot a leading and slot b standing by on
   * the current head, a gateway (20, dev.ts's detached child) and a tmux
   * server (30); leader and standby files go in `dataDir`.
   */
  startGateway(dataDir: string): void {
    this.gateway = true;
    this.supervised = true;
    this.dataDir = dataDir;
    this.alive.add(this.devPid);
    this.ps.set(this.devPid, { ppid: 1, args: "bun run scripts/dev.ts" });
    this.cwds.set(this.devPid, this.installDir);
    this.alive.add(this.gatewayPid);
    this.ps.set(this.gatewayPid, { ppid: this.devPid, args: "bun run src/index.ts" });
    this.cwds.set(this.gatewayPid, `${this.installDir}/packages/gateway`);
    this.alive.add(this.tmuxPid);
    this.ps.set(this.tmuxPid, { ppid: 1, args: "tmux new-session -d -s worker" });
    const a = this.spawnSlot("a", 0);
    this.load(a);
    const b = this.spawnSlot("b", 0);
    this.load(b);
  }

  private schedule(delayMs: number, run: () => void): void {
    this.events.push({ at: this.t + delayMs, run });
  }

  private tickEvents(): void {
    for (;;) {
      const due = this.events.filter((e) => e.at <= this.t).sort((x, y) => x.at - y.at)[0];
      if (!due) return;
      this.events.splice(this.events.indexOf(due), 1);
      due.run();
    }
  }

  slotOf(pid: number): CollectorSlot | undefined {
    for (const slot of ["a", "b"] as const) {
      if (this.slots[slot].collector === pid || this.slots[slot].wrapper === pid) return slot;
    }
    return undefined;
  }

  /** dev.ts starts `bun run start` for `slot`, which starts the collector on the code now on disk. */
  spawnSlot(slot: CollectorSlot, loadDelayMs = this.loadDelayMs): number {
    const wrapper = this.pid();
    const collector = this.pid();
    const dir = `${this.installDir}/packages/collector`;
    this.alive.add(wrapper);
    this.ps.set(wrapper, { ppid: this.devPid, args: "bun run start" });
    this.cwds.set(wrapper, dir);
    this.alive.add(collector);
    this.ps.set(collector, { ppid: wrapper, args: "bun run src/index.ts" });
    this.cwds.set(collector, dir);
    this.slots[slot] = { wrapper, collector, head: this.head };
    if (loadDelayMs > 0) this.schedule(loadDelayMs, () => this.load(collector));
    return collector;
  }

  /** A collector started outside dev.ts with the slot env (STANDUP_COLLECTOR_SLOT): no wrapper, on the code now on disk. */
  private spawnSlotDirect(pid: number, slot: CollectorSlot): void {
    this.alive.add(pid);
    this.ps.set(pid, { ppid: 1, args: "bun run src/index.ts" });
    this.cwds.set(pid, `${this.installDir}/packages/collector`);
    this.slots[slot] = { collector: pid, head: this.head };
    this.schedule(this.loadDelayMs, () => this.load(pid));
  }

  /** Respawn signals dev.ts got (DEV_RESPAWN_SIGNAL). */
  devRespawnSignals = 0;

  /**
   * dev.ts's DEV_RESPAWN_SIGNAL: every crash-loop breaker is reset, and each
   * slot it gave up on (no process, no respawn pending) is respawned.
   */
  private devRespawn(): void {
    this.devRespawnSignals++;
    if (!this.devRespawns) return;
    this.breakerTripped = false;
    for (const slot of ["a", "b"] as const) {
      this.slotExits[slot].length = 0;
      if (this.slots[slot].collector === undefined && !this.pendingRespawn.has(slot)) this.spawnSlot(slot);
    }
  }

  /**
   * Puts both slots' crash-loop breakers on the brink, as after a burst of
   * crashes: the next exit of either trips it, and dev.ts respawns that slot
   * only on DEV_RESPAWN_SIGNAL.
   */
  primeBreakers(): void {
    for (const slot of ["a", "b"] as const) {
      this.slotExits[slot].length = 0;
      for (let i = 0; i < 5; i++) this.slotExits[slot].push(this.t);
    }
  }

  /** Slots dev.ts has a respawn scheduled for. */
  private readonly pendingRespawn = new Set<CollectorSlot>();

  private liveLeader(): number | undefined {
    return this.leaderPid !== undefined && this.alive.has(this.leaderPid) ? this.leaderPid : undefined;
  }

  /** A slot collector has loaded its code: it crashes, hangs, takes the free lock, or waits as the standby. */
  private load(pid: number): void {
    if (!this.alive.has(pid)) return;
    const slot = this.slotOf(pid)!;
    const behaviour = this.behaviour.get(this.slots[slot].head!) ?? "ok";
    if (behaviour === "crash") return this.exit(pid);
    if (behaviour === "hang") return;
    if (this.liveLeader() === undefined) return this.lead(pid);
    this.standbys.add(pid);
    const marker: StandbyInfo = { pid, slot, startedAt: new Date(this.t).toISOString(), installDir: this.installDir, head: this.slots[slot].head };
    writeJsonAtomic(standbyFilePath(this.dataDir), marker);
    writeJsonAtomic(this.standbyMarkerPath(pid), marker);
  }

  /** `pid`'s per-pid standby marker in the data dir (leader.ts keeps one while it waits). */
  standbyMarkerPath(pid: number, dataDir = this.dataDir): string {
    return join(standbyDirPath(dataDir), `${pid}.json`);
  }

  /** A standby leaves its per-pid marker when it takes the lock or exits, except on SIGKILL. */
  private dropStandbyMarker(pid: number): void {
    if (this.dataDir && !this.sigkilled.has(pid)) rmSync(this.standbyMarkerPath(pid), { force: true });
  }

  /** Processes ended by SIGKILL, which leave their per-pid standby marker behind. */
  private readonly sigkilled = new Set<number>();

  /** `pid` takes the leader lock: writes the leader file, drops its standby marker, serves. */
  private lead(pid: number): void {
    const slot = this.slotOf(pid)!;
    const head = this.slots[slot].head!;
    this.standbys.delete(pid);
    this.dropStandbyMarker(pid);
    const leader: LeaderInfo = {
      pid,
      slot,
      httpPort: slot === "a" ? 1 : 2,
      wsPort: slot === "a" ? 3 : 4,
      epoch: `e${pid}`,
      acquiredAt: new Date(this.t).toISOString(),
      installDir: this.installDir,
      head,
    };
    writeJsonAtomic(leaderFilePath(this.dataDir), leader);
    const marker = readJsonFile<StandbyInfo>(standbyFilePath(this.dataDir));
    if (marker?.pid === pid && existsSync(standbyFilePath(this.dataDir))) rmSync(standbyFilePath(this.dataDir));
    this.leaderPid = pid;
    this.leaders.push(pid);
    const behaviour = this.behaviour.get(head) ?? "ok";
    if (behaviour === "lead-crash") return this.exit(pid);
    if (behaviour === "migrate") {
      writeJsonAtomic(leaderFilePath(this.dataDir), { ...leader, bootPhase: "pre-migrate-backup", bootPhaseAt: new Date(this.t).toISOString() });
      this.schedule(this.migrateMs, () => {
        if (!this.alive.has(pid) || this.leaderPid !== pid) return;
        writeJsonAtomic(leaderFilePath(this.dataDir), leader);
        this.up = { pid, head };
        this.endGap();
      });
      return;
    }
    this.up = { pid, head };
    this.endGap();
  }

  /** The leader went away: the gateway starts holding, and its WebSocket clients are closed. */
  private startGap(): void {
    this.gapSince ??= this.t;
    this.stats.wsUpstreamCloses += this.wsClients;
  }

  /** A leader serves again: the requests held meanwhile are released. */
  private endGap(): void {
    if (this.gapSince === undefined) return;
    const gap = this.t - this.gapSince;
    const held = this.gapHeld + Math.floor((gap / 1_000) * this.heldPerSecond);
    this.stats.held += held;
    if (held > 0) this.stats.maxHoldMs = Math.max(this.stats.maxHoldMs, gap);
    this.gapHeld = 0;
    this.gapSince = undefined;
  }

  /** A slot process exits: a collector takes its wrapper with it, and dev.ts respawns the slot. */
  private slotExit(pid: number): void {
    const slot = this.slotOf(pid)!;
    const procs = this.slots[slot];
    this.alive.delete(pid);
    this.ps.delete(pid);
    this.standbys.delete(pid);
    this.dropStandbyMarker(pid);
    if (pid === this.leaderPid) {
      this.up = null;
      this.startGap();
      // The kernel releases the lock; the warm standby takes it.
      const next = [...this.standbys].find((p) => this.alive.has(p));
      // With no delay the standby has the lock by the time the leader is seen gone.
      if (next !== undefined && this.takeoverDelayMs === 0) this.lead(next);
      else if (next !== undefined) this.schedule(this.takeoverDelayMs, () => this.alive.has(next) && this.liveLeader() === undefined && this.lead(next));
    }
    const other = pid === procs.collector ? procs.wrapper : procs.collector;
    if (other !== undefined && this.alive.has(other)) return this.slotExit(other);
    this.slots[slot] = {};
    if (!this.devRespawns || !this.alive.has(this.devPid)) return;
    const exits = this.slotExits[slot];
    exits.push(this.t);
    if (exits.filter((at) => this.t - at <= 60_000).length > 5) {
      this.breakerTripped = true;
      return;
    }
    this.pendingRespawn.add(slot);
    this.schedule(this.respawnDelayMs, () => {
      this.pendingRespawn.delete(slot);
      if (this.slots[slot].collector === undefined && this.alive.has(this.devPid)) this.spawnSlot(slot);
    });
  }

  pid(): number {
    return this.nextPid++;
  }

  /**
   * Starts a collector on the current checkout (dev.ts, under `parent`, or a
   * standalone spawn), registering its `ps` row and cwd.
   */
  boot(pid = this.pid(), parent = 1): number {
    this.alive.add(pid);
    if (!this.ps.has(pid)) this.ps.set(pid, { ppid: parent, args: "bun run --watch src/index.ts" });
    if (!this.cwds.has(pid)) this.cwds.set(pid, `${this.installDir}/packages/collector`);
    if (this.up && this.alive.has(this.up.pid)) this.portConflicts++;
    if (parent === this.devPid && this.crashLateBoots > 0) {
      this.crashLateBoots--;
      this.crashAt.set(pid, this.t + this.crashDelayMs);
      return pid;
    }
    const behaviour = this.behaviour.get(this.head) ?? "ok";
    if (behaviour === "crash") {
      if (this.watchIdle && parent === this.devPid) return pid;
      this.alive.delete(pid);
      this.ps.delete(pid);
      if (this.supervised && parent === this.devPid) this.devSawExit();
      return pid;
    }
    this.up = { pid, head: this.head };
    return pid;
  }

  /** dev.ts restarts its collector a second after it exits, unless its crash-loop breaker trips. */
  private devSawExit(): void {
    if (!this.devRespawns || !this.alive.has(this.devPid)) return;
    this.devExits.push(this.t);
    const recent = this.devExits.filter((at) => this.t - at <= 60_000);
    if (recent.length > 5) {
      this.breakerTripped = true;
      return;
    }
    this.respawnAt = this.t + this.respawnDelayMs;
  }

  private tickRespawn(): void {
    this.tickEvents();
    for (const [pid, at] of [...this.crashAt]) {
      if (this.t >= at) {
        this.crashAt.delete(pid);
        if (this.alive.has(pid)) this.exit(pid);
      }
    }
    if (this.respawnAt !== undefined && this.t >= this.respawnAt) {
      this.respawnAt = undefined;
      this.boot(this.pid(), this.devPid);
    }
  }

  /** A process exits (killed, or on its own, like a wrapper whose child exited). */
  exit(pid: number): void {
    if (this.gateway && this.slotOf(pid) !== undefined) return this.slotExit(pid);
    const row = this.ps.get(pid);
    this.alive.delete(pid);
    this.ps.delete(pid);
    if (this.up?.pid === pid) this.up = null;
    if (this.supervised && row?.ppid === this.devPid) this.devSawExit();
  }

  readonly exec: RestartExec = {
    run: async (argv, _opts): Promise<CommandResult> => {
      this.runs.push(argv);
      const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
      if (argv[0] === "git") {
        const sub = argv.slice(3);
        if (sub[0] === "rev-parse" && sub[1] === "HEAD") return ok(`${this.head}\n`);
        if (sub[0] === "symbolic-ref") return ok("main\n");
        if (sub[0] === "status") return ok([...this.dirty.map((f) => ` M ${f}`), ...this.untracked.map((f) => `?? ${f}`)].join("\n"));
        if (sub[0] === "diff" && sub[1] === "--name-only") return ok(this.changed.join("\n") + (this.changed.length > 0 ? "\n" : ""));
        if (sub[0] === "checkout" && sub[1] === "--detach") {
          this.head = sub[2]!;
          return ok();
        }
        return { code: 1, stdout: "", stderr: `unexpected git ${sub.join(" ")}` };
      }
      if (argv[0] === "ps" && argv[1] === "-A") {
        const rows = [...this.ps.entries()].map(([pid, row]) => `${String(pid).padStart(6)} ${String(row.ppid).padStart(6)} ${row.args}`);
        return ok(rows.join("\n") + "\n");
      }
      if (argv[0] === "readlink") {
        const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(argv[1] ?? "")?.[1]);
        const cwd = this.cwds.get(pid);
        return cwd && this.ps.has(pid) ? ok(`${cwd}\n`) : { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "lsof") return { code: 1, stdout: "", stderr: "" };
      if (argv[1] === "install" && argv[2] === "--frozen-lockfile") return ok();
      if (argv[0] === "ps") {
        const pid = Number(argv[argv.length - 1]);
        const row = this.ps.get(pid);
        return row ? ok(`${row.ppid} ${row.args}\n`) : { code: 1, stdout: "", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: `unexpected command ${argv.join(" ")}` };
    },
    spawnDetached: (argv, opts) => {
      const pid = this.pid();
      this.spawns.push({ argv, cwd: opts.cwd, logFile: opts.logFile });
      this.spawnInputs.push(opts.stdin ?? "");
      this.spawnEnvs.push(opts.env);
      const slot = opts.env?.STANDUP_COLLECTOR_SLOT;
      if (this.onSpawn) this.onSpawn(pid, argv);
      else if (this.gateway && (slot === "a" || slot === "b")) this.spawnSlotDirect(pid, slot);
      else this.boot(pid);
      return pid;
    },
    kill: (pid, signal) => {
      this.kills.push([pid, signal]);
      if (!this.alive.has(pid)) return false;
      if (signal === "SIGUSR2") {
        if (pid === this.devPid && this.gateway) this.devRespawn();
        return true;
      }
      if (signal === "SIGTERM" && this.stubborn.has(pid)) return true;
      if (signal === "SIGKILL") this.sigkilled.add(pid);
      this.exit(pid);
      return true;
    },
    isAlive: (pid) => this.alive.has(pid),
    httpGet: async (url): Promise<HttpResult> => {
      this.tickRespawn();
      const path = new URL(url).pathname;
      if (url.startsWith("http://ui.test")) return this.uiUp ? { status: 200, body: "<html>" } : { status: 0, body: "ECONNREFUSED" };
      if (path === GATEWAY_STATS_PATH) {
        return this.gateway && this.gatewayUp && this.alive.has(this.gatewayPid)
          ? { status: 200, body: JSON.stringify(this.stats) }
          : { status: this.gateway ? 0 : 404, body: this.gateway ? "ECONNREFUSED" : "" };
      }
      if (this.gateway) {
        if (!this.alive.has(this.gatewayPid)) return { status: 0, body: "ECONNREFUSED" };
        // No leader: the gateway holds the request past the caller's timeout.
        if (!this.up) {
          this.gapHeld++;
          return { status: 0, body: "The operation timed out." };
        }
      }
      if (!this.up) return { status: 0, body: "ECONNREFUSED" };
      if (path === "/health") {
        const slot = this.gateway ? this.slotOf(this.up.pid) : undefined;
        return {
          status: 200,
          body: JSON.stringify({ status: "ok", pid: this.up.pid, ...(slot ? { slot, epoch: `e${this.up.pid}`, head: this.up.head } : {}) }),
        };
      }
      if (path === "/api/persona/state") {
        return this.behaviour.get(this.up.head) === "persona"
          ? { status: 500, body: JSON.stringify({ error: "boom" }) }
          : { status: 200, body: JSON.stringify({ runState: "idle" }) };
      }
      return { status: 404, body: "" };
    },
    sleep: async (ms) => {
      this.t += ms;
      this.tickRespawn();
      this.onTick?.();
    },
    now: () => this.t,
  };
}

/** A restart record for a collector `collectorPid` running `head`. */
export function makeRecord(over: Partial<RestartRecord> = {}): RestartRecord {
  return {
    id: "r1",
    schemaVersion: RESTART_SCHEMA_VERSION,
    requestedAt: new Date(1_000_000).toISOString(),
    requestedBy: "persona (alice)",
    reason: "roll in the merged fix",
    phase: "handed_off",
    installDir: "/install",
    dataDir: "/data",
    mode: "supervised",
    collectorPid: 12,
    collector: { argv: ["bun", "run", "src/index.ts"], cwd: "/install/packages/collector" },
    collectorUrl: "http://127.0.0.1:7777",
    uiUrl: "http://ui.test/",
    uiReachableBefore: true,
    personaEnabled: true,
    headBefore: "b".repeat(40),
    rollbackHead: "a".repeat(40),
    supervisorLog: "/data/restart/r1.log",
    collectorLog: "/data/restart/collector-r1.log",
    pendingBefore: emptySnapshot(),
    attempts: [],
    updatedAt: new Date(1_000_000).toISOString(),
    ...over,
  };
}
