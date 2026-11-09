import type { Database } from "bun:sqlite";
import { join } from "path";
import type { WsMessage } from "@standup/shared";
import { tokenMatches } from "@standup/shared/write-token";
import { listPersonaOwners } from "@standup/store";
import type { InProcessFetch, PersonaRuntime } from "./runtime.js";
import type { DelegateLane } from "./delegate-lane.js";

/** An alias a Persona may be created for: it names a directory, so letters, digits, `.`, `_` and `-` only. */
const PERSONA_ALIAS = /^[a-z0-9._-]+$/i;

/** Whether `alias` may own a Persona (see PERSONA_ALIAS); `.` and `..` never do. */
export function isPersonaAlias(alias: string | null | undefined): alias is string {
  return !!alias && PERSONA_ALIAS.test(alias) && alias !== "." && alias !== ".." && alias !== "anonymous";
}

/**
 * The turn cwd of `alias`'s Persona: `base` (PERSONA_CWD) for the host, and
 * `base/users/<alias>` for a guest, so each runtime's MCP config (carrying its
 * own token) and system prompt live in a directory of their own.
 */
export function personaTurnCwd(base: string, alias: string, host: string): string {
  if (alias === host) return base;
  if (!isPersonaAlias(alias)) throw new Error(`not a valid Persona user: ${JSON.stringify(alias)}`);
  return join(base, "users", alias);
}

/** The turn cwd of one delegate agent's lane in the runtime whose turns run in `turnCwd`. */
export function delegateTurnCwd(turnCwd: string, agentId: string): string {
  return join(turnCwd, "delegates", agentId);
}

/** A slot for one Claude turn; acquire() resolves with its release once one is free. */
export interface TurnSlots {
  acquire(): Promise<() => void>;
}

/** At most `max` turns at once, granted in arrival order. */
export class TurnSemaphore implements TurnSlots {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly max: number) {}

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.running++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.running--;
          this.waiting.shift()?.();
        });
      };
      if (this.running < this.max) grant();
      else this.waiting.push(grant);
    });
  }

  /** Turns running right now. */
  get active(): number {
    return this.running;
  }
}

export interface PersonaFleetOptions {
  db: Database;
  /** The host alias (hostUserAlias): the user every worker's credentials belong to. */
  host: string;
  /** Builds `alias`'s runtime; every runtime it builds shares `turnSlots` and names `host`. */
  create?(alias: string, shared: { turnSlots: TurnSlots; host: string }): PersonaRuntime;
  /** Runtimes kept at most, the host's included (STANDUP_PERSONA_MAX_USERS). */
  maxUsers?: number;
  /** Claude turns at once across every runtime (STANDUP_PERSONA_MAX_CONCURRENT_TURNS). */
  maxConcurrentTurns?: number;
  /** The host's runtime, when built by the caller; otherwise `create(host)` builds it. */
  hostRuntime?: PersonaRuntime;
}

/**
 * Every user's Persona on this host: one PersonaRuntime per alias, the host's
 * built at once and a guest's on their first authenticated Persona request
 * (or at start() for every owner with stored Persona state, so their
 * schedules keep firing). The runtimes share one turn semaphore, and one
 * broadcast-tap listener fans each frame out to every runtime's event router,
 * each of which keeps only its own owner's sessions.
 */
export class PersonaFleet {
  readonly host: string;
  readonly turnSlots: TurnSemaphore;
  readonly maxUsers: number;
  private readonly db: Database;
  private readonly create?: PersonaFleetOptions["create"];
  private readonly runtimes = new Map<string, PersonaRuntime>();
  private readonly listeners = new Map<string, (message: WsMessage) => void>();
  private app?: { request: InProcessFetch };
  private started = false;
  /** Set by quiesce() until release(): a runtime built meanwhile is born held. */
  private held = false;

  constructor(opts: PersonaFleetOptions) {
    this.db = opts.db;
    this.host = opts.host;
    this.create = opts.create;
    this.maxUsers = Math.max(1, opts.maxUsers ?? 10);
    this.turnSlots = new TurnSemaphore(Math.max(1, opts.maxConcurrentTurns ?? 2));
    const hostRuntime = opts.hostRuntime ?? this.create?.(this.host, { turnSlots: this.turnSlots, host: this.host });
    if (!hostRuntime) throw new Error("a PersonaFleet needs the host's runtime or a factory to build it");
    if (hostRuntime.owner !== this.host) throw new Error(`the host runtime serves ${hostRuntime.owner}, not ${this.host}`);
    this.add(hostRuntime);
    hostRuntime.serveOwnersWithoutRuntime((owner) => this.runtimes.has(owner));
  }

  /** A fleet of `runtime` alone, its owner the host; no guest runtime can be created. */
  static of(runtime: PersonaRuntime, db: Database): PersonaFleet {
    return new PersonaFleet({ db, host: runtime.owner, hostRuntime: runtime, maxUsers: 1 });
  }

  /** The host's runtime. */
  hostRuntime(): PersonaRuntime {
    return this.runtimes.get(this.host)!;
  }

  get(alias: string): PersonaRuntime | undefined {
    return this.runtimes.get(alias);
  }

  /**
   * `alias`'s runtime, built (and started, once the fleet runs) when it has
   * none yet. While the fleet is held for a restart, a new runtime is held
   * before it starts, so it takes no turn until release(). Undefined when
   * `alias` can't own a Persona, there is no factory, or the fleet already
   * holds maxUsers runtimes.
   */
  getOrCreate(alias: string): PersonaRuntime | undefined {
    const existing = this.runtimes.get(alias);
    if (existing) return existing;
    if (!this.create || !isPersonaAlias(alias) || this.runtimes.size >= this.maxUsers) return undefined;
    const runtime = this.create(alias, { turnSlots: this.turnSlots, host: this.host });
    this.add(runtime);
    if (this.held) runtime.hold();
    if (this.started) runtime.start();
    return runtime;
  }

  /** Whether the fleet is held (hold() or quiesce() until release()). */
  get isHeld(): boolean {
    return this.held;
  }

  /** Why getOrCreate(alias) would return undefined, or null when it wouldn't. */
  unavailableReason(alias: string): string | null {
    if (this.runtimes.has(alias)) return null;
    if (!isPersonaAlias(alias)) return `${JSON.stringify(alias)} can't have a Persona`;
    if (!this.create) return `Persona runs only for ${this.host} on this host`;
    if (this.runtimes.size >= this.maxUsers) {
      return `this host already runs ${this.maxUsers} Personas (STANDUP_PERSONA_MAX_USERS)`;
    }
    return null;
  }

  all(): PersonaRuntime[] {
    return [...this.runtimes.values()];
  }

  /** The runtime whose Persona token is `token`. */
  byToken(token: string | null | undefined): PersonaRuntime | undefined {
    if (!token) return undefined;
    return this.all().find((r) => tokenMatches(token, r.token));
  }

  /**
   * The runtime and delegate lane whose lane token is `token`. A lane token
   * is accepted only here (the Persona tool routes), never by byToken, so a
   * delegate reaches no other Persona route.
   */
  byDelegateToken(token: string | null | undefined): { runtime: PersonaRuntime; lane: DelegateLane } | undefined {
    if (!token) return undefined;
    for (const runtime of this.all()) {
      const lane = runtime.delegateLanes().find((l) => tokenMatches(token, l.token));
      if (lane) return { runtime, lane };
    }
    return undefined;
  }

  /** The runtime whose writer secret is `secret` (its own in-process requests). */
  byWriterSecret(secret: string | null | undefined): PersonaRuntime | undefined {
    if (!secret) return undefined;
    return this.all().find((r) => r.isOwnWrite(secret));
  }

  /** Binds the collector app every runtime (and every one built later) calls in-process. */
  bindApp(app: { request: InProcessFetch }): void {
    this.app = app;
    for (const runtime of this.runtimes.values()) runtime.bindApp(app);
  }

  /** The broadcast-tap listener: every frame goes to every runtime's event router. */
  eventListener(): (message: WsMessage) => void {
    return (message) => {
      for (const [alias, listener] of this.listeners) {
        try {
          listener(message);
        } catch (err) {
          console.error(`[persona] ${alias}'s event router failed:`, err);
        }
      }
    };
  }

  /**
   * Starts the host's runtime and re-creates one for every other owner with
   * stored Persona state (up to maxUsers), so their schedules and wakeups
   * keep firing across restarts. Each runtime starts once: those built
   * before start() here, and every later one as getOrCreate builds it.
   * Returns the stored owners left without a runtime, each with the reason.
   */
  start(): Array<{ owner: string; reason: string }> {
    if (this.started) return [];
    this.started = true;
    for (const runtime of this.runtimes.values()) runtime.start();
    const skipped: Array<{ owner: string; reason: string }> = [];
    for (const owner of listPersonaOwners(this.db)) {
      if (owner === this.host || this.getOrCreate(owner)) continue;
      const reason = this.unavailableReason(owner) ?? "no runtime could be built";
      skipped.push({ owner, reason });
      console.warn(`[persona] Not running ${JSON.stringify(owner)}'s stored Persona: ${reason}`);
    }
    return skipped;
  }

  /** Stops every runtime, killing the turns still running (see PersonaRuntime.stop). */
  stop(): void {
    this.started = false;
    for (const runtime of this.runtimes.values()) runtime.stop();
  }

  /**
   * Kills every runtime's running turns and nothing else, for an exit that
   * skips the orderly stop (a forced or failed shutdown). Returns how many.
   */
  killTurns(): number {
    let killed = 0;
    for (const runtime of this.runtimes.values()) killed += runtime.killTurns();
    return killed;
  }

  /** Holds every runtime (see PersonaRuntime.hold) without waiting for running work. */
  hold(): void {
    this.held = true;
    for (const runtime of this.runtimes.values()) runtime.hold();
  }

  /** Holds every runtime for a collector restart (see PersonaRuntime.quiesce); true once all are quiet. */
  async quiesce(timeoutMs: number): Promise<boolean> {
    this.held = true;
    const results = await Promise.all(this.all().map((r) => r.quiesce(timeoutMs)));
    return results.every(Boolean);
  }

  /** Lifts a quiesce() hold on every runtime. */
  release(): void {
    this.held = false;
    for (const runtime of this.runtimes.values()) runtime.release();
  }

  private add(runtime: PersonaRuntime): void {
    this.runtimes.set(runtime.owner, runtime);
    this.listeners.set(runtime.owner, runtime.eventListener());
    if (this.app) runtime.bindApp(this.app);
  }
}
