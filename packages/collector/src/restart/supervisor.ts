import { readdirSync, rmSync } from "fs";
import { join } from "path";
import type { GatewayStats, LeaderInfo, StandbyInfo } from "@standup/shared/topology";
import { gatewayStatsUrlFor } from "./authorize.js";
import type { RestartExec, Supervision } from "./exec.js";
import {
  collectorBranch,
  gitDirtyFiles,
  gitHead,
  isCollectorProcess,
  isInstallDevScript,
  processInfo,
} from "./exec.js";
import type {
  GoodHead,
  HealthCheck,
  PreflightResult,
  RestartAttempt,
  RestartHistoryEntry,
  RestartMode,
  RestartRecord,
  RestartSource,
  UserImpact,
} from "./state.js";
import { RestartPreempted, canonicalPath, isFinal, rollbackTarget } from "./state.js";
import { DEV_RESPAWN_SIGNAL, gatewayFilePath, leaderFilePath, readJsonFile, slotPorts, standbyDirPath, standbyFilePath } from "./topology-files.js";

// ── Planning (pure) ─────────────────────────────────────────────────────────

/** A restart of the commit the previous restart ran is refused this soon after it. */
export const SAME_HEAD_COOLDOWN_MS = 30 * 60_000;
/** At most this many restarts are asked for per hour. */
export const MAX_RESTARTS_PER_HOUR = 3;
/** At most this many redeploys (the post-merge hook) run per hour; they don't count toward MAX_RESTARTS_PER_HOUR. */
export const MAX_REDEPLOYS_PER_HOUR = 20;

export interface PlanInput {
  /** The latest restart record, if any. */
  latest: RestartRecord | null;
  /** Whether `latest`, not yet done, is still being carried out (its supervisor lives, or it is this process's own). */
  latestActive: boolean;
  batchKey?: string;
  threadId?: string;
  /** The install's HEAD now; null when git could not read it. */
  headBefore: string | null;
  goodHeads: readonly GoodHead[];
  supervision: Supervision;
  /** Recent restart requests, newest first. */
  history?: readonly RestartHistoryEntry[];
  /** Epoch ms now. */
  now?: number;
  /** The owner approved this very restart (a held restart_standup card): the rate limit doesn't apply. */
  ownerApproved?: boolean;
  /** A redeploy (the post-merge hook): the rate limit doesn't apply, and it isn't counted toward Persona's. */
  source?: RestartSource;
  /** A live standby of this install waits behind the gateway, so a supervised restart can hand off to it. */
  standbyReady?: boolean;
  /**
   * dev.ts runs this collector as a slot behind the gateway (the leader file
   * names it with a slot, or dev.json says gateway mode), standby or not: a
   * supervised restart then hands off, never stops the leader for whatever
   * slot would take the lock next.
   */
  slotted?: boolean;
  /**
   * The dev.ts dev.json names, verified to be this install's dev.ts and
   * running the gateway topology. A slot collector that dev.ts doesn't own
   * (one a restart started while dev.ts was gone) hands off through it.
   */
  gatewayDevPid?: number;
}

/**
 * How the 409 refusing a restart of a slot collector with no dev.ts of the
 * install to hand off through begins; standup-redeploy.ts answers it with a
 * full restart, which brings dev.ts back.
 */
export const NO_DEV_SLOT_REFUSAL = "this collector runs as a slot behind the gateway, but no dev.ts of this install runs";

export type RestartPlan =
  | { kind: "refuse"; status: 409 | 429 | 500; error: string }
  | { kind: "duplicate"; record: RestartRecord }
  | {
      kind: "start";
      mode: RestartMode;
      headBefore: string;
      rollbackHead?: string;
      /** Why there is no rollback target although known-good commits exist. */
      rollbackWithheld?: string;
      devPid?: number;
      wrapperPid?: number;
    };

/**
 * Decides what a restart request does. The same Persona batch asking again
 * (a retried turn) is the restart it already asked for; any other request
 * while one is under way is refused; one needs a readable HEAD to roll back
 * from. Restarts are rate-limited unless the owner approved this one: the
 * commit the previous restart ran is not restarted again within
 * SAME_HEAD_COOLDOWN_MS (a restart that failed fails the same way again), and
 * no more than MAX_RESTARTS_PER_HOUR are asked for in an hour (redeploys
 * neither count nor are counted; they have their own cap,
 * MAX_REDEPLOYS_PER_HOUR). Supervised (dev.ts above the collector) restarts
 * by stopping the collector and letting dev.ts bring it back — or, when
 * dev.ts runs it as a slot behind the gateway, by handing off to the
 * standby; otherwise the supervisor starts the collector itself. A slot
 * collector always hands off, through dev.ts above it or else the gateway
 * dev.ts dev.json names, and is refused with neither: started standalone it
 * would bind the gateway's public ports beside the slots. A handoff rolls
 * back only to a commit that passed health behind the gateway.
 */
export function planRestart(input: PlanInput): RestartPlan {
  const { latest } = input;
  if (latest && input.batchKey && latest.batchKey === input.batchKey && latest.threadId === input.threadId) {
    return { kind: "duplicate", record: latest };
  }
  if (latest && !isFinal(latest) && input.latestActive) {
    return { kind: "refuse", status: 409, error: `restart ${latest.id} is already in progress (${latest.phase})` };
  }
  if (!input.headBefore) {
    return { kind: "refuse", status: 500, error: "cannot read the Standup install's git HEAD, so a failed restart could not roll back" };
  }
  const now = input.now ?? Date.now();
  // A refused redeploy is recorded for the owner's sake; it never ran, so it neither counts nor cools down.
  const history = (input.history ?? []).filter((h) => !h.refused);
  if (!input.ownerApproved && input.source !== "redeploy") {
    const previous = history[0];
    if (previous && previous.headBefore === input.headBefore && now - previous.at < SAME_HEAD_COOLDOWN_MS) {
      return {
        kind: "refuse",
        status: 429,
        error:
          `Standup was already restarted on ${short(input.headBefore)} ${Math.max(1, Math.round((now - previous.at) / 60_000))} min ago (restart ${previous.id}) ` +
          `and nothing new is checked out since; restarting it again won't change the outcome. Tell the owner what the last report said instead of retrying.`,
      };
    }
    const lastHour = history.filter((h) => h.source !== "redeploy" && now - h.at < 60 * 60_000).length;
    if (lastHour >= MAX_RESTARTS_PER_HOUR) {
      return {
        kind: "refuse",
        status: 429,
        error: `Standup has been restarted ${lastHour} times in the last hour (the limit is ${MAX_RESTARTS_PER_HOUR}); ask the owner before restarting again.`,
      };
    }
  }
  if (input.source === "redeploy") {
    const lastHour = history.filter((h) => h.source === "redeploy" && now - h.at < 60 * 60_000).length;
    if (lastHour >= MAX_REDEPLOYS_PER_HOUR) {
      return {
        kind: "refuse",
        status: 429,
        error: `Standup has been redeployed ${lastHour} times in the last hour (the limit is ${MAX_REDEPLOYS_PER_HOUR}); the next merge after the hour is up redeploys it`,
      };
    }
  }
  const slotted = !!input.standbyReady || !!input.slotted;
  const devPid = input.supervision.devPid ?? (slotted ? input.gatewayDevPid : undefined);
  if (slotted && devPid === undefined) {
    return {
      kind: "refuse",
      status: 409,
      error:
        `${NO_DEV_SLOT_REFUSAL} to bring up a standby, ` +
        "and a standalone start would collide with the gateway's ports; restart Standup with `systemctl --user restart standup.service`",
    };
  }
  const supervised = devPid !== undefined;
  const mode: RestartMode = slotted ? "handoff" : supervised ? "supervised" : "standalone";
  const rollbackHead = rollbackTarget(input.goodHeads, input.headBefore, { gatewayOnly: mode === "handoff" });
  const withheld =
    mode === "handoff" && !rollbackHead && rollbackTarget(input.goodHeads, input.headBefore)
      ? "no known-good commit has run behind the gateway yet, and an older one may not run as a collector slot"
      : undefined;
  return {
    kind: "start",
    mode,
    headBefore: input.headBefore,
    rollbackHead,
    ...(withheld ? { rollbackWithheld: withheld } : {}),
    ...(supervised ? { devPid } : {}),
    ...(input.supervision.wrapperPid !== undefined ? { wrapperPid: input.supervision.wrapperPid } : {}),
  };
}

/**
 * When the hourly redeploy cap next admits a redeploy, given `history`
 * (newest first): once the MAX_REDEPLOYS_PER_HOUR-th newest redeploy of the
 * last hour leaves the window. Undefined while the cap admits one now.
 */
export function redeployWindowFreesAt(history: readonly RestartHistoryEntry[], now: number): number | undefined {
  const inWindow = history
    .filter((h) => !h.refused && h.source === "redeploy" && now - h.at < 60 * 60_000)
    .sort((a, b) => b.at - a.at);
  if (inWindow.length < MAX_REDEPLOYS_PER_HOUR) return undefined;
  return inWindow[MAX_REDEPLOYS_PER_HOUR - 1]!.at + 60 * 60_000;
}

// ── Carrying it out ─────────────────────────────────────────────────────────

export interface RestartTimings {
  /** How long a stopped collector gets to exit before SIGKILL. */
  stopTimeoutMs: number;
  /** How long a wrapper (`bun run dev`) gets to exit after the collector before it is stopped too. */
  wrapperGraceMs: number;
  /** How long a collector gets to answer /health after it is (re)started. */
  bootTimeoutMs: number;
  /**
   * How much longer than bootTimeoutMs the boot wait goes on while a live
   * collector that took the leader lock during the wait reports, in
   * collector-leader.json, that it is copying the database before a pending
   * migration or applying migrations (LeaderInfo.bootPhase). The copy of a
   * database of many GB takes minutes.
   */
  migrateTimeoutMs: number;
  /** How long Persona's state route gets once /health answers. */
  personaTimeoutMs: number;
  /** How long the UI gets. */
  uiTimeoutMs: number;
  /** How long the gateway's stats endpoint gets. */
  gatewayTimeoutMs: number;
  /** Handoff mode: how long a respawned standby gets to load the code and write collector-standby.json. */
  preflightTimeoutMs: number;
  /**
   * How long the boot wait goes on once collector-leader.json names a dead
   * collector that took the lock during the wait (or, after a promotion to a
   * warm standby, still names the stopped leader) and no live one has taken
   * it over: then the wait fails early rather than run out bootTimeoutMs.
   */
  deadLeaderMs: number;
  /** Delay between probes. */
  pollMs: number;
}

export const DEFAULT_TIMINGS: RestartTimings = {
  stopTimeoutMs: 15_000,
  wrapperGraceMs: 3_000,
  bootTimeoutMs: 180_000,
  migrateTimeoutMs: 45 * 60_000,
  personaTimeoutMs: 20_000,
  uiTimeoutMs: 15_000,
  gatewayTimeoutMs: 15_000,
  preflightTimeoutMs: 90_000,
  deadLeaderMs: 20_000,
  pollMs: 1_000,
};

/** scripts/dev.ts stops restarting a service that exits more than 5 times in this window. */
export const DEV_RESTART_WINDOW_MS = 60_000;
/**
 * How many times dev.ts may have restarted the collector within
 * DEV_RESTART_WINDOW_MS before the supervisor waits instead of stopping it
 * again: dev.ts gives up after 5, and a crashing build adds exits of its own.
 */
const DEV_RESTART_BUDGET = 3;

/**
 * The timings a supervisor runs with: the defaults, with
 * STANDUP_RESTART_BOOT_TIMEOUT_S as the boot timeout,
 * STANDUP_RESTART_MIGRATE_TIMEOUT_S as the migrate timeout and
 * STANDUP_RESTART_PREFLIGHT_TIMEOUT_S as the preflight timeout when set.
 */
export function timingsFromEnv(env: NodeJS.ProcessEnv = process.env): RestartTimings {
  const seconds = (value: string | undefined): number | undefined => {
    const s = Number.parseInt(value ?? "", 10);
    return Number.isFinite(s) && s > 0 ? s * 1_000 : undefined;
  };
  const boot = seconds(env.STANDUP_RESTART_BOOT_TIMEOUT_S);
  const migrate = seconds(env.STANDUP_RESTART_MIGRATE_TIMEOUT_S);
  const preflight = seconds(env.STANDUP_RESTART_PREFLIGHT_TIMEOUT_S);
  if (boot === undefined && migrate === undefined && preflight === undefined) return DEFAULT_TIMINGS;
  return {
    ...DEFAULT_TIMINGS,
    ...(boot !== undefined ? { bootTimeoutMs: boot } : {}),
    ...(migrate !== undefined ? { migrateTimeoutMs: migrate } : {}),
    ...(preflight !== undefined ? { preflightTimeoutMs: preflight } : {}),
  };
}

/**
 * How many processes a rollback stops in dev.ts's collector branch, at most
 * as budgeted by worstCaseMs: the `bun run start` (or `bun run dev`) wrapper,
 * the collector, and one more for a `--watch` child.
 */
export const BRANCH_STOPS_BOUND = 3;

/** How long the `bun install --frozen-lockfile` after a rollback checkout may run. */
const ROLLBACK_INSTALL_MS = 120_000;

/** The rollback's commands, at their timeouts: git status, checkout and rev-parse, then bun install. */
const ROLLBACK_GIT_MS = 20_000 + 60_000 + 10_000 + ROLLBACK_INSTALL_MS;

/** How long a finishing restart waits for the gateway to release the requests it still holds before it reads its counters. */
const GATEWAY_SETTLE_MS = 10_000;

/** How many times a handoff refreshes the standby once more when it loaded another commit than the one on disk. */
const STALE_STANDBY_RETRIES = 1;

/**
 * The longest a restart can take with `t`. Stops, each with its SIGKILL
 * grace: the collector and its wrapper first (plus the wrapper's grace), then
 * on rollback dev.ts's collector branch (BRANCH_STOPS_BOUND) and the failed
 * collector. Two bring-ups that may each wait out the boot timeout twice
 * (dev.ts, then a standalone start) before the Persona and UI checks; the
 * rollback's git commands; a dev.ts cool-down before each round of stops; a
 * minute for the `ps` and `git` calls between; and one migrate timeout, for
 * the boot that copies and migrates the database (the code a rollback returns
 * to has no migration pending). A handoff restart is bounded apart
 * (handoffWorstCaseMs); this is the longer of the two. A collector waiting
 * on a supervisor waits this long before it gives up on it.
 */
export function worstCaseMs(t: RestartTimings): number {
  const stop = t.stopTimeoutMs + 5_000;
  const stops = 2 + BRANCH_STOPS_BOUND + 1;
  const bringUp = 2 * (t.bootTimeoutMs + t.pollMs + 3_000) + t.personaTimeoutMs + t.uiTimeoutMs + 2 * (t.pollMs + 5_000);
  const classic = stops * stop + t.wrapperGraceMs + 2 * bringUp + ROLLBACK_GIT_MS + 2 * DEV_RESTART_WINDOW_MS + 60_000 + t.migrateTimeoutMs;
  return Math.max(classic, handoffWorstCaseMs(t));
}

/**
 * How many collectors a standby refresh is budgeted to stop (standbyTargets):
 * the standby in collector-standby.json, one of dev.ts's slots hung before
 * it wrote its marker, one a restart started while dev.ts was gone, and one
 * more left over from a dev.ts that exited. More are still stopped; the
 * budget just doesn't cover their grace.
 */
export const REFRESH_STOPS_BOUND = 4;

/**
 * How long a handoff supervisor may run before it stops the leader: the
 * standby refreshes (the new code, STALE_STANDBY_RETRIES more when a standby
 * loaded another commit, then one more as slack for a rollback's refresh),
 * each stopping up to REFRESH_STOPS_BOUND collectors and their wrappers and
 * then waiting out the preflight timeout, plus the rollback's commands. The
 * collector that asked holds Persona this much longer.
 */
export function handoffPreflightMs(t: RestartTimings): number {
  const stop = t.stopTimeoutMs + 5_000;
  const refresh = REFRESH_STOPS_BOUND * (2 * stop + t.wrapperGraceMs) + t.preflightTimeoutMs + t.pollMs;
  return (2 + STALE_STANDBY_RETRIES) * refresh + ROLLBACK_GIT_MS;
}

/**
 * The longest a handoff restart can take with `t`: the preflight budget
 * (handoffPreflightMs), two promotions (the leader and its wrapper, each with
 * its grace), two health rounds that may each wait out the boot timeout
 * before the Persona, UI and gateway checks, the wait for the gateway to
 * release what it holds, a minute for the `ps` and `git` calls between, and
 * one migrate timeout (as in worstCaseMs).
 */
export function handoffWorstCaseMs(t: RestartTimings): number {
  const stop = t.stopTimeoutMs + 5_000;
  const promote = 2 * stop + t.wrapperGraceMs;
  const health = t.bootTimeoutMs + t.pollMs + 3_000 + t.personaTimeoutMs + t.uiTimeoutMs + t.gatewayTimeoutMs + 3 * (t.pollMs + 5_000);
  return handoffPreflightMs(t) + 2 * promote + 2 * health + GATEWAY_SETTLE_MS + 60_000 + t.migrateTimeoutMs;
}

export interface RestartDeps {
  exec: RestartExec;
  /**
   * Persists the record (each phase, so the next collector can tell where it
   * stands). Throws RestartPreempted when the record on disk is no longer this
   * run's, which ends the run without another write.
   */
  save(record: RestartRecord): void;
  /** Adds a commit to the known-good history; `gateway` when it passed health as a slot behind the gateway. */
  recordGoodHead(head: string, opts?: { gateway?: boolean }): void;
  /** The tail of a log file ("" when absent). */
  readTail(path: string): string;
  /** The supervisor's own log line. */
  log(line: string): void;
  timings?: Partial<RestartTimings>;
  /** The supervisor's pid, recorded so a collector can tell it still runs. */
  pid?: number;
}

interface CollectorProbe {
  ok: boolean;
  pid?: number;
  /** Anything answered on the collector's port during the wait. */
  answered: boolean;
  /** The install's HEAD, another commit than the one checked, which the collector that answered loaded. */
  supersededBy?: string;
  /** The wait ended before bootTimeoutMs: collectors kept exiting after taking the leader lock (waitCollector). */
  early?: boolean;
  /** The boot time the collector that answered reported in its /health (`bootMs`). */
  bootMs?: number;
  detail: string;
  ms: number;
}

/**
 * Carries out a planned restart from outside the collector: stop it, bring it
 * back (dev.ts does in supervised mode; the supervisor starts it otherwise, and
 * also when dev.ts never brings it back and runs no collector of its own),
 * then health-check the collector, Persona's state and the UI. A failed check
 * rolls the install back to the last known-good commit — only with a clean
 * working tree (no changes, no untracked files), and as a detached checkout so
 * the branch keeps pointing at the new commit — stops everything that may
 * still hold the port (dev.ts's whole collector branch included), and brings
 * the collector up once more. Only a pid that is this install's collector, a
 * process in dev.ts's collector branch, or one this run started is ever
 * signalled. Returns the finished record (also saved).
 */
export async function runRestart(initial: RestartRecord, deps: RestartDeps): Promise<RestartRecord> {
  const t = { ...DEFAULT_TIMINGS, ...deps.timings };
  const { exec } = deps;
  const record: RestartRecord = { ...initial, attempts: [...initial.attempts] };
  delete record.nonceHash;
  if (deps.pid !== undefined) record.supervisorPid = deps.pid;
  const iso = () => new Date(exec.now()).toISOString();
  const save = (patch: Partial<RestartRecord>) => {
    Object.assign(record, patch);
    deps.save(record);
  };
  /** Collectors this supervisor started; stopped before any later attempt. */
  const spawned: number[] = [];
  /** Collectors known stopped: a /health answer from one of them is not the new collector. */
  const stoppedPids = new Set<number>();
  let mode: RestartMode = record.mode;
  /** Notes for the first attempt, from before it started. */
  const startNotes: string[] = [];
  /** When dev.ts was seen restarting its collector branch (a new branch root). */
  const devRestarts: number[] = [];
  const seenRoots = new Set<number>([record.wrapperPid ?? record.collectorPid]);
  /** When the serving collector was first signalled: the start of the users' gap. */
  let gapStart: number | undefined;
  /** When the latest attempt's collector answered /health; the gap's end when that attempt is the last. */
  let answeredAt: number | undefined;
  /** The boot time that collector reported in its /health. */
  let answeredBootMs: number | undefined;

  const waitUntil = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = exec.now() + timeoutMs;
    while (!cond()) {
      if (exec.now() >= deadline) return false;
      await exec.sleep(Math.min(t.pollMs, 250));
    }
    return true;
  };

  /** The gateway's pids (its stats, gateway.json): it outlives every restart, so nothing here signals it. */
  const gatewayPids = new Set<number>(
    [record.gatewayBefore?.pid, readJsonFile<{ pid?: unknown }>(gatewayFilePath(record.dataDir))?.pid].filter(isPid)
  );

  /** SIGTERM, then SIGKILL after stopTimeoutMs. Callers vouch that `pid` is one to signal. */
  const stop = async (pid: number, label: string): Promise<void> => {
    if (gatewayPids.has(pid)) {
      deps.log(`pid ${pid} is the gateway; not signalling it`);
      return;
    }
    if (!exec.isAlive(pid)) {
      stoppedPids.add(pid);
      return;
    }
    deps.log(`stopping ${label} (pid ${pid})`);
    exec.kill(pid, "SIGTERM");
    if (!(await waitUntil(() => !exec.isAlive(pid), t.stopTimeoutMs))) {
      deps.log(`${label} (pid ${pid}) ignored SIGTERM for ${t.stopTimeoutMs}ms; sending SIGKILL`);
      exec.kill(pid, "SIGKILL");
      await waitUntil(() => !exec.isAlive(pid), 5_000);
    }
    stoppedPids.add(pid);
  };

  /** Stops `pid` when it is this install's collector; false (nothing signalled) when it lives and is not. */
  const stopCollector = async (pid: number, label: string): Promise<boolean> => {
    if (!exec.isAlive(pid)) {
      stoppedPids.add(pid);
      return true;
    }
    if (!(await isCollectorProcess(exec, pid, record.installDir))) {
      deps.log(`pid ${pid} is not this install's collector; not signalling it`);
      return false;
    }
    await stop(pid, label);
    return true;
  };

  /** dev.ts's collector branch now, noting any root dev.ts started since the last look. */
  const branchNow = async () => {
    if (mode !== "supervised" || record.devPid === undefined) return null;
    const branch = await collectorBranch(exec, record.devPid, record.installDir);
    for (const root of branch?.roots ?? []) {
      if (!seenRoots.has(root)) {
        seenRoots.add(root);
        devRestarts.push(exec.now());
      }
    }
    return branch;
  };

  /** Waits until stopping dev.ts's collector once more can't trip its crash-loop breaker. */
  const coolDevBreaker = async (): Promise<void> => {
    for (;;) {
      const now = exec.now();
      const recent = devRestarts.filter((at) => now - at < DEV_RESTART_WINDOW_MS);
      if (recent.length < DEV_RESTART_BUDGET) return;
      const waitMs = Math.min(...recent) + DEV_RESTART_WINDOW_MS - now + 1;
      deps.log(`dev.ts restarted the collector ${recent.length}× in the last minute; waiting ${waitMs}ms so its crash-loop breaker does not trip`);
      await exec.sleep(waitMs);
    }
  };

  /** Stops dev.ts's whole collector branch, deepest first, so what dev.ts brings up next is the only collector. */
  const stopBranch = async (label: string): Promise<void> => {
    const branch = await branchNow();
    if (!branch || branch.pids.length === 0) return;
    await coolDevBreaker();
    for (const pid of [...branch.pids].reverse()) await stop(pid, label);
  };

  const spawnCollector = (): number => {
    const pid = exec.spawnDetached(record.collector.argv, { cwd: record.collector.cwd, logFile: record.collectorLog });
    spawned.push(pid);
    deps.log(`started the collector standalone (pid ${pid}), logging to ${record.collectorLog}`);
    return pid;
  };

  /**
   * Polls /health until a collector other than a stopped one answers ok,
   * loaded from `expected.head`: in handoff mode (`leader`) it must be the
   * leader collector-leader.json names; otherwise only while the file names
   * it or another live process. Either way, when the file records the commit
   * its pid loaded, it must be `head` (a merge landing mid-restart is not the
   * commit this one checks). With `superseding`, a leader that loaded the
   * install's HEAD as it is now, another commit than `head`, ends the wait at
   * once with `supersededBy`: a merge landed and the collector booted it.
   *
   * The wait fails early (`early`), without running out bootTimeoutMs, once
   * collectors crash after taking the leader lock: when the lock changed
   * hands twice during the wait with no collector answering, or when the file
   * names a collector that took the lock during the wait and has exited, and
   * no live one replaced it within deadLeaderMs. With `warm` (a warm standby
   * was waiting when the leader was stopped) the file still naming the dead,
   * stopped leader after deadLeaderMs fails the wait too: nothing took the lock.
   */
  const waitCollector = async (expected: { head: string; leader?: boolean; superseding?: boolean; warm?: boolean }): Promise<CollectorProbe> => {
    const start = exec.now();
    const deadline = start + t.bootTimeoutMs;
    let answered = false;
    let detail = "no answer";
    const startLeader = readLeaderFile(record.dataDir)?.pid;
    /** Collectors that took the leader lock during this wait, in order. */
    const newLeaders: number[] = [];
    /** Since when collector-leader.json has named a dead collector (one that counts, see above). */
    let deadSince: number | undefined;
    const early = (why: string): CollectorProbe => ({ ok: false, answered, early: true, detail: `${why} (last probe: ${detail})`, ms: exec.now() - start });
    /**
     * What the leader collector-leader.json names reports it does before
     * listening, if anything, when it lives, wasn't stopped by this restart
     * and loaded `expected.head`. In a handoff the standby takes the lock
     * while the leader is being stopped, before this wait starts.
     */
    const bootPhase = (): string | undefined => {
      const file = readLeaderFile(record.dataDir);
      if (!file?.bootPhase || stoppedPids.has(file.pid) || !exec.isAlive(file.pid)) return undefined;
      if (file.head && !sameCommit(file.head, expected.head)) return undefined;
      const doing = file.bootPhase === "migrating" ? "is applying migrations" : "is copying the database before a migration";
      return `the leader (pid ${file.pid}) ${doing}${file.bootPhaseAt ? ` (since ${file.bootPhaseAt})` : ""}`;
    };
    let extended = false;
    for (;;) {
      const res = await exec.httpGet(`${record.collectorUrl}/health`, { timeoutMs: 3_000 });
      if (res.status !== 0) answered = true;
      if (res.status === 200) {
        const body = parseJson(res.body);
        const pid = typeof body?.pid === "number" ? body.pid : undefined;
        const fresh = body?.status === "ok" && (pid === undefined || !stoppedPids.has(pid));
        const read = readLeaderFile(record.dataDir) ?? undefined;
        // Outside a handoff, a file naming a dead pid is a stale one (left by
        // a collector that predates leader files, or that crashed).
        const file = expected.leader || (read && (read.pid === pid || exec.isAlive(read.pid))) ? read : undefined;
        const leaderOk = (expected.leader || file) ? pid !== undefined && file?.pid === pid && (!file.head || sameCommit(file.head, expected.head)) : true;
        if (fresh && leaderOk) {
          answeredAt = exec.now();
          const bootMs = typeof body?.bootMs === "number" && Number.isFinite(body.bootMs) && body.bootMs >= 0 ? body.bootMs : undefined;
          answeredBootMs = bootMs;
          return {
            ok: true,
            pid,
            answered,
            ...(bootMs !== undefined ? { bootMs } : {}),
            detail: `ok${pid ? ` (pid ${pid})` : ""}${file?.slot ? `, slot ${file.slot}` : ""}`,
            ms: exec.now() - start,
          };
        }
        if (expected.superseding && fresh && pid !== undefined && file?.pid === pid && file.head && !sameCommit(file.head, expected.head)) {
          const disk = await gitHead(exec, record.installDir);
          if (disk !== null && sameCommit(disk, file.head)) {
            answeredAt = exec.now();
            return {
              ok: false,
              pid,
              answered,
              supersededBy: disk,
              detail: `the leader (pid ${pid}) runs ${short(file.head)}, which the install moved to meanwhile, not ${short(expected.head)}`,
              ms: exec.now() - start,
            };
          }
        }
        detail =
          pid !== undefined && stoppedPids.has(pid)
            ? `still the stopped collector (pid ${pid})`
            : !fresh
              ? `unexpected body ${clip(res.body)}`
              : file?.pid !== pid
                ? `pid ${pid ?? "?"} answered, but collector-leader.json names ${file ? `pid ${file.pid}` : "no leader"}`
                : `the leader (pid ${pid}) runs ${short(file?.head)}, not ${short(expected.head)}`;
      } else {
        detail = res.status === 0 ? `unreachable: ${clip(res.body)}` : `HTTP ${res.status}`;
      }
      const holder = readLeaderFile(record.dataDir)?.pid;
      if (holder !== undefined && holder !== startLeader && !stoppedPids.has(holder) && !newLeaders.includes(holder)) newLeaders.push(holder);
      if (newLeaders.length >= 2) {
        return early(
          `the leader lock changed hands ${newLeaders.length} times during the wait (pid ${newLeaders.join(", ")}) with no collector answering /health: the code crashes after taking the lock`
        );
      }
      const counts = holder !== undefined && (newLeaders.includes(holder) || (expected.warm === true && holder === startLeader));
      if (counts && !exec.isAlive(holder!)) deadSince ??= exec.now();
      else deadSince = undefined;
      if (deadSince !== undefined && exec.now() - deadSince >= t.deadLeaderMs) {
        return early(
          newLeaders.includes(holder!)
            ? `the collector that took the leader lock (pid ${holder}) exited, and no collector took the lock over within ${t.deadLeaderMs}ms`
            : `no collector took the leader lock within ${t.deadLeaderMs}ms of the leader's exit (collector-leader.json still names pid ${holder})`
        );
      }
      if (exec.now() >= deadline) {
        // A copy or migration of a large database outlasts the boot timeout;
        // the wait goes on while the collector doing it lives, up to the migrate timeout.
        const phase = bootPhase();
        if (!phase) return { ok: false, answered, detail, ms: exec.now() - start };
        if (exec.now() >= deadline + t.migrateTimeoutMs) {
          return { ok: false, answered, detail: `${phase}, still after ${t.bootTimeoutMs + t.migrateTimeoutMs}ms (last probe: ${detail})`, ms: exec.now() - start };
        }
        if (!extended) {
          extended = true;
          deps.log(`${phase}; waiting past the ${t.bootTimeoutMs}ms boot timeout, up to ${t.migrateTimeoutMs}ms more`);
        }
      }
      await branchNow();
      await exec.sleep(t.pollMs);
    }
  };

  /** Retries `probe` until it passes or `timeoutMs` runs out. */
  const retry = async (
    timeoutMs: number,
    probe: () => Promise<{ ok: boolean; detail: string }>
  ): Promise<{ ok: boolean; detail: string; ms: number }> => {
    const start = exec.now();
    for (;;) {
      const r = await probe();
      if (r.ok || exec.now() - start >= timeoutMs) return { ...r, ms: exec.now() - start };
      await exec.sleep(t.pollMs);
    }
  };

  const personaCheck = async (): Promise<HealthCheck> => {
    const r = await retry(t.personaTimeoutMs, async () => {
      const res = await exec.httpGet(`${record.collectorUrl}/api/persona/state`, { timeoutMs: 5_000 });
      if (res.status !== 200) return { ok: false, detail: res.status === 0 ? `unreachable: ${clip(res.body)}` : `HTTP ${res.status}: ${clip(res.body)}` };
      const runState = parseJson(res.body)?.runState;
      if (typeof runState !== "string") return { ok: false, detail: `unexpected body ${clip(res.body)}` };
      if (record.personaEnabled && runState === "disabled") return { ok: false, detail: "Persona ran before the restart but is disabled now" };
      return { ok: true, detail: `runState ${runState}` };
    });
    return { name: "persona", required: true, ...r };
  };

  const uiCheck = async (): Promise<HealthCheck> => {
    const r = await retry(record.uiReachableBefore ? t.uiTimeoutMs : 0, async () => {
      const res = await exec.httpGet(record.uiUrl, { timeoutMs: 5_000 });
      const ok = res.status >= 200 && res.status < 400;
      return { ok, detail: ok ? `HTTP ${res.status}` : res.status === 0 ? `unreachable: ${clip(res.body)}` : `HTTP ${res.status}` };
    });
    const detail = record.uiReachableBefore ? r.detail : `${r.detail} (the UI was not reachable before the restart either, so it does not gate the outcome)`;
    return { name: "ui", required: record.uiReachableBefore, ...r, detail };
  };

  const gatewayUrl = record.gatewayStatsUrl !== undefined ? gatewayStatsUrlFor(record.collectorUrl) : undefined;

  /** The gateway's counters now, or null when it doesn't answer. */
  const gatewayStats = async (): Promise<{ stats: GatewayStats | null; detail: string }> => {
    if (!gatewayUrl) return { stats: null, detail: "no gateway" };
    const res = await exec.httpGet(gatewayUrl, { timeoutMs: 3_000 });
    if (res.status !== 200) return { stats: null, detail: res.status === 0 ? `unreachable: ${clip(res.body)}` : `HTTP ${res.status}` };
    const stats = parseGatewayStats(res.body);
    return stats ? { stats, detail: `pid ${stats.pid}` } : { stats: null, detail: `unexpected body ${clip(res.body)}` };
  };

  /** The gateway answers its stats and its process lives: required in handoff mode, reported otherwise. */
  const gatewayCheck = async (): Promise<HealthCheck> => {
    const r = await retry(t.gatewayTimeoutMs, async () => {
      const { stats, detail } = await gatewayStats();
      if (!stats) return { ok: false, detail };
      if (!exec.isAlive(stats.pid)) return { ok: false, detail: `its stats name pid ${stats.pid}, which is not running` };
      return { ok: true, detail: `pid ${stats.pid}, ${stats.heldNow} held now` };
    });
    return { name: "gateway", required: mode === "handoff", ...r };
  };

  /**
   * One bring-up: start the collector (or let dev.ts), then check it. When
   * dev.ts brings nothing up, the collector is started standalone only if
   * dev.ts runs no collector branch at all (its breaker gave up, or dev.ts is
   * gone): a collector of dev.ts's that is alive but not serving hangs, or has
   * crashed and idles under `bun --watch`, and could come back beside a
   * second one. `superseding`: a collector that came back on the install's
   * moved HEAD supersedes the attempt (waitCollector) rather than fail it.
   */
  const bringUp = async (head: string, notes: string[] = [], opts: { superseding?: boolean } = {}): Promise<RestartAttempt> => {
    const attempt: RestartAttempt = { head, mode, startedAt: iso(), checks: [], ok: false, notes: [...notes] };
    save({ phase: "starting" });
    let pid = mode === "standalone" ? spawnCollector() : undefined;
    let probe = await waitCollector({ head, superseding: opts.superseding });
    // A collector that crashed after taking the lock came up and fails: one started standalone would too.
    if (!probe.ok && mode === "supervised" && !probe.answered && !probe.early) {
      const branch = await branchNow();
      if (branch === null) {
        attempt.notes.push("dev.ts did not bring the collector back and its process tree could not be read; not starting a second collector");
      } else if (branch.pids.length > 0) {
        const live = branch.collectors.length > 0 ? branch.collectors : branch.pids;
        attempt.notes.push(
          `dev.ts's collector branch (pid ${live.join(", ")}) is running but nothing served within ${t.bootTimeoutMs}ms — ` +
            "it hangs or crashed at boot and idles (as under `bun --watch`); not starting a second collector beside it"
        );
      } else {
        attempt.notes.push(`dev.ts did not bring the collector back within ${t.bootTimeoutMs}ms and runs no collector; started it standalone`);
        mode = "standalone";
        attempt.mode = "standalone";
        pid = spawnCollector();
        probe = await waitCollector({ head, superseding: opts.superseding });
      }
    }
    attempt.collectorPid = probe.pid ?? pid;
    save({ phase: "checking" });
    attempt.checks.push({ name: "collector", ok: probe.ok, required: true, detail: probe.detail, ms: probe.ms });
    noteSuperseded(attempt, probe);
    await checkServing(attempt, probe.ok);
    return attempt;
  };

  /** The commit a merge moved the install to, set when a collector came back on it (waitCollector `superseding`). */
  let supersededBy: string | undefined;

  /** After a collector probe: a failed one leaves the gap open, unless a collector serves the install's moved HEAD. */
  const noteSuperseded = (attempt: RestartAttempt, probe: CollectorProbe): void => {
    if (probe.supersededBy !== undefined) {
      supersededBy = probe.supersededBy;
      attempt.notes.push(`the install moved to ${short(probe.supersededBy)} meanwhile, and the collector came back on it`);
    } else if (!probe.ok) {
      answeredAt = undefined;
      answeredBootMs = undefined;
    }
  };

  /** The checks after the collector's: Persona, the UI and (when one fronts it) the gateway; then the attempt is recorded. */
  const checkServing = async (attempt: RestartAttempt, collectorOk: boolean): Promise<void> => {
    if (collectorOk) {
      attempt.checks.push(await personaCheck());
      attempt.checks.push(await uiCheck());
      if (gatewayUrl) attempt.checks.push(await gatewayCheck());
    }
    attempt.ok = attempt.checks.every((c) => c.ok || !c.required);
    attempt.finishedAt = iso();
    record.attempts.push(attempt);
    deps.log(`attempt on ${short(attempt.head)}: ${attempt.ok ? "healthy" : "unhealthy"} — ${attempt.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAILED"}: ${c.detail}`).join("; ")}`);
  };

  const finish = async (outcome: RestartRecord["outcome"], error?: string): Promise<RestartRecord> => {
    const tail = [deps.readTail(record.collectorLog), deps.readTail(record.supervisorLog)].filter(Boolean);
    const last = record.attempts[record.attempts.length - 1];
    // The gap ends when the last attempt's collector answered; with none
    // signalled there was no gap, and with nothing answering it hasn't ended.
    const gapMs = gapStart === undefined ? 0 : last && answeredAt !== undefined ? Math.max(0, answeredAt - gapStart) : undefined;
    // Requests still held are not yet counted as served or failed: the
    // counters are read once the gateway holds none, or after a short wait.
    let after: GatewayStats | null = null;
    if (gatewayUrl) {
      const deadline = exec.now() + GATEWAY_SETTLE_MS;
      for (;;) {
        after = (await gatewayStats()).stats;
        if (!after || after.heldNow === 0 || exec.now() >= deadline) break;
        await exec.sleep(Math.min(t.pollMs, 500));
      }
    }
    save({
      phase: "done",
      outcome,
      finishedAt: iso(),
      ...(error ? { error } : {}),
      ...(tail.length > 0 ? { logTail: tail.join("\n---\n").slice(-6_000) } : {}),
      ...(after ? { gatewayAfter: after } : {}),
      ...(mode === "handoff" && gapStart === undefined ? { leaderUntouched: true } : {}),
      userImpact: {
        ...userImpactOf(record.gatewayBefore, after ?? undefined, gapMs),
        ...(gapMs !== undefined && answeredBootMs !== undefined ? { bootMs: answeredBootMs } : {}),
      },
    });
    deps.log(`restart ${record.id} finished: ${outcome}${error ? ` — ${error}` : ""}`);
    return record;
  };

  /**
   * Ends a restart a merge overtook: the install moved to `diskHead` and is
   * left there, nothing is rolled back, and one more redeploy follows the
   * report (the coalesced-redeploy path, which runs when HEAD moved past
   * headBefore).
   */
  const finishSuperseded = (diskHead: string, error: string): Promise<RestartRecord> => {
    record.supersededBy = diskHead;
    record.rerunRequested = true;
    return finish("failed", error);
  };

  /** The error of a restart whose collector came back on `diskHead`, a commit merged meanwhile. */
  const supersededError = (diskHead: string): string =>
    `the install moved from ${short(record.headBefore)} to ${short(diskHead)} while the collector restarted, and the collector came back on ${short(diskHead)}, so nothing was rolled back`;

  /**
   * Stops a slot collector (vouched for by stopCollector) and then its `bun
   * run start` wrapper: the collector's parent, only while that parent is
   * dev.ts's child. A collector under anything else (init, systemd, the
   * supervisor that started it) has no wrapper to wait on.
   */
  const stopSlot = async (pid: number, label: string): Promise<boolean> => {
    const devPid = record.devPid;
    const info = exec.isAlive(pid) ? await processInfo(exec, pid) : null;
    const parent = devPid !== undefined && info && info.ppid > 1 && info.ppid !== devPid ? await processInfo(exec, info.ppid) : null;
    const wrapper = parent && parent.ppid === devPid ? info!.ppid : undefined;
    if (!(await stopCollector(pid, label))) return false;
    if (wrapper !== undefined && !(await waitUntil(() => !exec.isAlive(wrapper), t.wrapperGraceMs))) {
      const winfo = await processInfo(exec, wrapper);
      if (winfo?.ppid === devPid) await stop(wrapper, `${label}'s wrapper`);
      else deps.log(`pid ${wrapper} is not dev.ts's child; not signalling it`);
    }
    return true;
  };

  /** The leader collector-leader.json names, while it runs and is this install's collector. */
  const liveLeader = async (): Promise<LeaderInfo | null> => {
    const leader = readLeaderFile(record.dataDir);
    if (!leader || stoppedPids.has(leader.pid) || !exec.isAlive(leader.pid)) return null;
    return (await isCollectorProcess(exec, leader.pid, record.installDir)) ? leader : null;
  };

  /**
   * Sends dev.ts DEV_RESPAWN_SIGNAL, which resets its crash-loop breakers and
   * respawns the services it gave up on — from the code on disk now. Only
   * this install's dev.ts is signalled; false when it isn't running.
   */
  const respawnDev = async (why: string): Promise<boolean> => {
    const devPid = record.devPid;
    if (devPid === undefined || !(await isInstallDevScript(exec, devPid, record.installDir))) {
      deps.log(`dev.ts (pid ${devPid ?? "?"}) is not running; nothing to ask to respawn the collector slots`);
      return false;
    }
    deps.log(`asking dev.ts (pid ${devPid}) to respawn the services it gave up on (${DEV_RESPAWN_SIGNAL}): ${why}`);
    return exec.kill(devPid, DEV_RESPAWN_SIGNAL);
  };

  type Refresh = PreflightResult & {
    leaderGone?: boolean;
    /** The commit the fresh standby loaded, when it is not the one expected. */
    staleHead?: string;
    /** The install's HEAD when the standby turned out stale. */
    diskHead?: string;
  };

  /**
   * Handoff step 2: refreshes the standby (refreshOnce) and requires it to
   * have loaded `head`. A standby that loaded another commit — the install
   * moved while it reloaded, as when a merge lands mid-restart — is refreshed
   * once more while the install is back on `head`; otherwise the refresh
   * fails with the commit it loaded (`staleHead`) and the install's
   * (`diskHead`). A marker that records no commit is taken to have loaded
   * the install's HEAD as it is now.
   */
  const refreshStandby = async (leaderPid: number | undefined, head: string, opts: { respawn?: string } = {}): Promise<Refresh> => {
    const start = exec.now();
    for (let round = 0; ; round++) {
      const r = await refreshOnce(leaderPid, round === 0 ? opts.respawn : undefined);
      if (!r.ok) return { ...r, ms: exec.now() - start };
      const disk = await gitHead(exec, record.installDir);
      const loaded = r.loadedHead ?? disk ?? undefined;
      if (loaded === undefined || sameCommit(loaded, head)) return { ok: true, standbyPid: r.standbyPid, detail: r.detail, ms: exec.now() - start };
      if (round < STALE_STANDBY_RETRIES && disk !== null && sameCommit(disk, head)) {
        deps.log(`the standby (pid ${r.standbyPid}) loaded ${short(loaded)}, not ${short(head)}, which the install is on again; refreshing it once more`);
        continue;
      }
      const moved = disk !== null && !sameCommit(disk, head) ? `; the install moved to ${short(disk)} meanwhile` : "";
      return {
        ok: false,
        ...(r.standbyPid !== undefined ? { standbyPid: r.standbyPid } : {}),
        staleHead: loaded,
        ...(disk !== null ? { diskHead: disk } : {}),
        detail: `the fresh standby (pid ${r.standbyPid}) loaded ${short(loaded)}, not ${short(head)}${moved}`,
        ms: exec.now() - start,
      };
    }
  };

  /**
   * The collectors a standby refresh stops: this data dir's standbys — the
   * one in collector-standby.json first, then every one with a per-pid marker
   * in standby/ (dev.ts's, one a restart started while dev.ts was gone, one a
   * dev.ts that exited left behind) — and dev.ts's own collectors (a slot
   * that hung before it wrote a marker). Each must be alive and this
   * install's collector (isCollectorProcess); never `leaderPid`, the gateway
   * or this supervisor. A marker whose pid is gone is deleted. Collectors of
   * this install that serve another data dir have markers only there, so
   * they are never stopped here.
   */
  const standbyTargets = async (leaderPid: number | undefined): Promise<number[]> => {
    const out: number[] = [];
    const add = async (pid: number) => {
      if (pid === leaderPid || pid === deps.pid || pid === record.devPid || gatewayPids.has(pid) || out.includes(pid) || !exec.isAlive(pid)) return;
      if (await isCollectorProcess(exec, pid, record.installDir)) out.push(pid);
    };
    const marker = readStandbyFile(record.dataDir);
    if (marker) await add(marker.pid);
    for (const { pid, path } of listStandbyMarkers(record.dataDir)) {
      if (!exec.isAlive(pid)) {
        rmSync(path, { force: true });
        continue;
      }
      await add(pid);
    }
    if (record.devPid !== undefined) {
      for (const pid of (await collectorBranch(exec, record.devPid, record.installDir))?.collectors ?? []) await add(pid);
    }
    return out;
  };

  /**
   * One standby refresh: stops every standby of this data dir and every
   * collector of dev.ts's that is not `leaderPid` (standbyTargets), so none
   * runs old code beside the leader, then sends dev.ts DEV_RESPAWN_SIGNAL — always, as it only
   * respawns what it gave up on — so its slots come back from the code on
   * disk, and waits for a collector-standby.json written since by a live
   * collector of this install that is none of the stopped ones. The leader
   * is never signalled here. `leaderGone`: the leader exited meanwhile, so a
   * fresh standby took the lock instead of waiting (and wrote no marker).
   */
  const refreshOnce = async (leaderPid: number | undefined, respawn: string | undefined): Promise<Refresh & { loadedHead?: string }> => {
    const start = exec.now();
    const marker = readStandbyFile(record.dataDir);
    const targets = await standbyTargets(leaderPid);
    const replaced = new Set<number>(targets);
    if (marker) replaced.add(marker.pid);
    for (const pid of targets) await stopSlot(pid, "the standby collector");
    await respawnDev(respawn ?? (targets.length === 0 ? "no standby collector is running" : "its standby slot was stopped to reload the code on disk"));
    // Any collector that started since `start` loaded the code on disk then;
    // the ones stopped are excluded by pid.
    const since = start;
    /** The preflight timeout runs from here, so slow stops don't use it up. */
    const stoppedAt = exec.now();
    let detail = "no collector-standby.json was written";
    for (;;) {
      const s = readStandbyFile(record.dataDir);
      if (s && !replaced.has(s.pid) && s.pid !== leaderPid) {
        const startedAt = Date.parse(s.startedAt);
        if (!(startedAt >= since)) detail = `collector-standby.json (pid ${s.pid}) predates the refresh`;
        else if (canonicalPath(s.installDir) !== canonicalPath(record.installDir)) detail = `collector-standby.json names install ${s.installDir}`;
        else if (!exec.isAlive(s.pid)) detail = `collector-standby.json names pid ${s.pid}, which is not running`;
        else if (!(await isCollectorProcess(exec, s.pid, record.installDir))) detail = `collector-standby.json names pid ${s.pid}, which is not this install's collector`;
        else {
          return {
            ok: true,
            standbyPid: s.pid,
            ...(typeof s.head === "string" && s.head ? { loadedHead: s.head } : {}),
            detail: `standby pid ${s.pid}${s.slot ? ` (slot ${s.slot})` : ""} loaded ${typeof s.head === "string" && s.head ? short(s.head) : "the code"}`,
            ms: exec.now() - start,
          };
        }
      } else if (s) {
        detail = `collector-standby.json still names the replaced standby (pid ${s.pid})`;
      }
      if (leaderPid !== undefined && !exec.isAlive(leaderPid)) {
        return { ok: false, leaderGone: true, detail: `the leader (pid ${leaderPid}) exited while the standby was reloading`, ms: exec.now() - start };
      }
      if (exec.now() - stoppedAt >= t.preflightTimeoutMs) {
        return { ok: false, detail: `no standby loaded the code within ${t.preflightTimeoutMs}ms: ${detail}`, ms: exec.now() - start };
      }
      await exec.sleep(t.pollMs);
    }
  };

  /** Handoff step 3: SIGTERM the leader; the standby takes the lock while the gateway holds traffic. */
  const promote = async (leaderPid: number): Promise<boolean> => {
    save({ phase: "stopping" });
    gapStart ??= exec.now();
    return stopSlot(leaderPid, "the leader collector");
  };

  /**
   * Handoff step 4: the new leader serves `head`, then Persona, the UI and
   * the gateway check out. `superseding` as for bringUp; `warm` as for
   * waitCollector, when the leader was just stopped for a standby that loaded `head`.
   */
  const checkLeader = async (
    head: string,
    preflight: HealthCheck | undefined,
    notes: string[] = [],
    opts: { superseding?: boolean; warm?: boolean } = {}
  ): Promise<RestartAttempt> => {
    const attempt: RestartAttempt = { head, mode, startedAt: iso(), checks: preflight ? [preflight] : [], ok: false, notes: [...notes] };
    save({ phase: "starting" });
    const probe = await waitCollector({ head, leader: true, superseding: opts.superseding, warm: opts.warm });
    attempt.collectorPid = probe.pid;
    save({ phase: "checking" });
    attempt.checks.push({ name: "collector", ok: probe.ok, required: true, detail: probe.detail, ms: probe.ms });
    noteSuperseded(attempt, probe);
    await checkServing(attempt, probe.ok);
    return attempt;
  };

  const preflightCheck = (r: PreflightResult, required = true): HealthCheck => ({ name: "preflight", ok: r.ok, required, detail: r.detail, ms: r.ms });

  /**
   * Checks out `target` detached, only on a clean working tree (no changes,
   * no untracked files). Null when it is checked out; else the error the
   * restart finishes with, its reason recorded in `record.rollback`.
   */
  const checkoutRollback = async (target: string, why: string): Promise<string | null> => {
    const dirty = await gitDirtyFiles(exec, record.installDir);
    if (dirty === null || dirty.length > 0) {
      const untracked = (dirty ?? []).filter((l) => l.startsWith("??")).map((l) => l.slice(2).trim());
      const changed = (dirty ?? []).filter((l) => !l.startsWith("??")).map((l) => l.slice(2).trim());
      const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
      // File names are whatever is in the install, so they stay out of the
      // reason and travel in `files`, which a report quotes as untrusted.
      const refused =
        dirty === null
          ? "git status failed in the install"
          : [
              changed.length > 0 ? `the install has uncommitted changes (${count(changed.length, "file")})` : "",
              untracked.length > 0 ? `the install has untracked files a checkout would keep (${count(untracked.length, "file")})` : "",
            ]
              .filter(Boolean)
              .join("; ");
      record.rollback = {
        refused,
        head: target,
        ...(dirty !== null ? { files: { changed: changed.slice(0, 20), untracked: untracked.slice(0, 20) } } : {}),
      };
      return `${why}; rollback refused: ${refused}`;
    }
    deps.log(`rolling back: git checkout --detach ${target}`);
    const checkout = await exec.run(["git", "-C", record.installDir, "checkout", "--detach", target], { timeoutMs: 60_000 });
    const nowHead = await gitHead(exec, record.installDir);
    if (checkout.code !== 0 || (nowHead !== null && nowHead !== target)) {
      const output = clip(checkout.stderr || checkout.stdout, 500);
      record.rollback = {
        head: target,
        error: checkout.code !== 0 ? `git checkout exited ${checkout.code}` : `HEAD is ${short(nowHead ?? undefined)} after the checkout, not ${short(target)}`,
        ...(output ? { output } : {}),
      };
      return `${why} and the rollback checkout failed (${record.rollback.error})`;
    }
    record.rollback = { head: target, detached: true };
    // The rolled-back commit's dependencies, best-effort: a failure is only logged.
    const bun = record.collector.argv[0] ?? "bun";
    const install = await exec.run([bun, "install", "--frozen-lockfile"], { cwd: record.installDir, timeoutMs: ROLLBACK_INSTALL_MS });
    if (install.code !== 0) deps.log(`bun install --frozen-lockfile exited ${install.code} after the rollback checkout; continuing: ${clip(install.stderr || install.stdout)}`);
    return null;
  };

  /** Records `head` as known-good, tagged as a gateway-topology commit when it ran as a slot behind the gateway. */
  const recordGood = (head: string): void => deps.recordGoodHead(head, mode === "handoff" ? { gateway: true } : undefined);

  /**
   * Starts a collector on the code on disk as slot `slot`, binding that
   * slot's ports, for when dev.ts is gone: it takes the free leader lock
   * behind the gateway. dev.ts doesn't own it, so nothing restarts it.
   * While it waits for the lock it keeps a per-pid standby marker in the
   * data dir, so every standby refresh stops it, and a waiting slot exits on
   * its own once this supervisor (its parent) is gone (leader.ts). While it
   * leads, the next restart plans a handoff through the dev.ts dev.json
   * names (planRestart), so dev.ts's slots take over from it.
   */
  const spawnSlotCollector = (slot: "a" | "b"): number => {
    const publicHttp = Number(new URL(record.collectorUrl).port) || 7777;
    const publicWs = Number.parseInt(process.env.WS_PORT ?? "", 10) || 7778;
    const ports = slotPorts(publicHttp, publicWs, slot);
    const pid = exec.spawnDetached(record.collector.argv, {
      cwd: record.collector.cwd,
      logFile: record.collectorLog,
      env: {
        ...process.env,
        STANDUP_COLLECTOR_SLOT: slot,
        STANDUP_LISTEN_PORT: String(ports.http),
        STANDUP_LISTEN_WS_PORT: String(ports.ws),
      },
    });
    spawned.push(pid);
    deps.log(`dev.ts is gone; started a collector as slot ${slot} (pid ${pid}, ports ${ports.http}/${ports.ws}), logging to ${record.collectorLog}`);
    return pid;
  };

  /** Records `head` as known-good when the tree is clean (HEAD then vouches for all that runs); otherwise notes why not. */
  const recordGoodIfClean = async (head: string, attempt: RestartAttempt): Promise<void> => {
    const dirtyNow = await gitDirtyFiles(exec, record.installDir);
    if (dirtyNow !== null && dirtyNow.length === 0) recordGood(head);
    else {
      attempt.notes.push(
        `${short(head)} was not recorded as a known-good commit: ${dirtyNow === null ? "git status failed in the install" : "the install has uncommitted or untracked files, so its HEAD is not all that runs"}`
      );
    }
  };

  /**
   * A handoff restart (see scripts/zero-downtime-check.ts): the standby reloads
   * the new code first, and only once it has does the leader stop, so new
   * code that fails to load never takes the console down. The standby must
   * have loaded headBefore itself: one that loaded a commit merged meanwhile
   * ends the restart before the switch, the newer commit left for the
   * redeploy that follows. A failed preflight leaves the leader alone and
   * checks nothing out (the install stays on its branch, so the fix merged
   * next redeploys), and asks dev.ts to respawn its standby slot; a failed
   * health check after the switch rolls back to the
   * last known-good commit that ran behind the gateway and hands off once
   * more, respawning dev.ts's slots (or starting one, without dev.ts) when
   * none is left.
   */
  const runHandoff = async (): Promise<RestartRecord> => {
    const untouched = "the running collector was never stopped";
    const devPid = record.devPid;
    if (devPid === undefined || !(await isInstallDevScript(exec, devPid, record.installDir))) {
      return finish("failed", `dev.ts (pid ${devPid ?? "?"}) no longer runs, so no standby could load the new code; ${untouched}`);
    }
    const leader = await liveLeader();
    if (!leader || leader.pid !== record.collectorPid || (record.leaderPid !== undefined && record.leaderPid !== leader.pid)) {
      return finish(
        "failed",
        `collector-leader.json names ${leader ? `pid ${leader.pid}` : "no running leader"}, not the collector that asked for this restart (pid ${record.collectorPid}); ${untouched}`
      );
    }

    save({ phase: "preflight" });
    const preflight = await refreshStandby(leader.pid, record.headBefore);
    record.preflight = { ok: preflight.ok, ...(preflight.standbyPid !== undefined ? { standbyPid: preflight.standbyPid } : {}), detail: preflight.detail, ms: preflight.ms };
    deps.log(`preflight on ${short(record.headBefore)}: ${preflight.ok ? "ok" : "FAILED"} — ${preflight.detail}`);

    if (!preflight.ok && !preflight.leaderGone && preflight.staleHead !== undefined && preflight.diskHead !== undefined && !sameCommit(preflight.diskHead, record.headBefore)) {
      // A merge landed mid-restart: the standby loaded the newer commit, not
      // the one this restart deploys. The leader keeps serving, the install
      // keeps the newer commit, and one more redeploy follows this report.
      record.attempts.push({
        head: record.headBefore,
        mode,
        startedAt: iso(),
        finishedAt: iso(),
        checks: [preflightCheck(preflight)],
        ok: false,
        notes: [`the install moved to ${short(preflight.diskHead)} while the standby reloaded; ${untouched}`],
      });
      return finishSuperseded(
        preflight.diskHead,
        `the install moved from ${short(record.headBefore)} to ${short(preflight.diskHead)} while the standby reloaded (${preflight.detail}), so the restart stopped before the switch; ${untouched}`
      );
    }

    if (!preflight.ok && !preflight.leaderGone) {
      // Nothing is checked out: the leader keeps serving the code it loaded,
      // and the install stays on its branch at the new commit, so the next
      // merge (a fix) redeploys as usual. dev.ts is asked to reset its
      // breakers, so its standby slot keeps retrying the code on disk.
      const notes = [`the new code did not load; ${untouched}`];
      if (!(await respawnDev("the standby failed to load the new code; it retries on the code on disk"))) {
        notes.push("dev.ts could not be asked to respawn its standby slot");
      }
      record.attempts.push({
        head: record.headBefore,
        mode,
        startedAt: iso(),
        finishedAt: iso(),
        checks: [preflightCheck(preflight)],
        ok: false,
        notes,
      });
      return finish(
        "failed",
        `the new code on ${short(record.headBefore)} did not load in the standby (${preflight.detail}); nothing was restarted: ${untouched}, and the install was left on ${short(record.headBefore)}`
      );
    }

    const notes = preflight.leaderGone ? [`${preflight.detail}; whichever collector took over is checked`] : [];
    if (!preflight.leaderGone && !(await promote(leader.pid))) {
      return finish("failed", `pid ${leader.pid} is not this install's collector, so the restart did not signal it`);
    }
    gapStart ??= exec.now();
    const first = await checkLeader(record.headBefore, preflightCheck(preflight, !preflight.leaderGone), notes, {
      superseding: true,
      warm: !preflight.leaderGone,
    });
    if (first.ok) {
      await recordGoodIfClean(record.headBefore, first);
      return finish("ok");
    }
    if (supersededBy !== undefined) return finishSuperseded(supersededBy, supersededError(supersededBy));

    // ── Rollback ──
    save({ phase: "rolling_back" });
    const target = record.rollbackHead;
    if (!target) {
      if (record.rollbackWithheld) {
        record.rollback = { refused: record.rollbackWithheld };
        return finish("failed", "the restart failed its health check, and no known-good commit is safe to roll back to in this topology");
      }
      record.rollback = { refused: "no earlier known-good commit is recorded" };
      return finish("failed", "the restart failed its health check and there is no earlier known-good commit to roll back to");
    }
    const refused = await checkoutRollback(target, "the restart failed its health check");
    if (refused) return finish("failed", refused);
    // The failing leader keeps serving until a standby has loaded the
    // rolled-back code. With no leader left (both slots crash on the failing
    // code, and dev.ts may have given up on them), everything dev.ts runs is
    // stopped, dev.ts is asked to respawn its slots from the rolled-back
    // code, and its next collector takes the lock itself, writing no standby
    // marker. With dev.ts gone too, the supervisor starts a slot collector.
    const failing = await liveLeader();
    let preflightAgain: HealthCheck | undefined;
    let warm = false;
    const rollbackNotes: string[] = [];
    if (failing) {
      const again = await refreshStandby(failing.pid, target, { respawn: "rolled back after a failed health check" });
      if (!again.ok && !again.leaderGone) {
        record.attempts.push({ head: target, mode, startedAt: iso(), finishedAt: iso(), checks: [preflightCheck(again)], ok: false, notes: [] });
        return finish("failed", `no standby loaded the rolled-back code ${short(target)} (${again.detail}); the collector on ${short(record.headBefore)} still runs, failing its checks`);
      }
      if (!again.leaderGone) await promote(failing.pid);
      warm = !again.leaderGone;
      preflightAgain = preflightCheck(again, !again.leaderGone);
    } else {
      for (const pid of await standbyTargets(undefined)) await stopSlot(pid, "the failed collector");
      if (!(await respawnDev("rolled back after both collector slots failed"))) {
        const slot = readLeaderFile(record.dataDir)?.slot === "b" ? "b" : "a";
        const pid = spawnSlotCollector(slot);
        rollbackNotes.push(
          `dev.ts no longer runs, so the supervisor started a collector as slot ${slot} (pid ${pid}) on ${short(target)}; ` +
            "dev.ts doesn't own it, so the next restart hands off from it to dev.ts's slots, or a refresh stops it while it waits"
        );
      }
    }
    const second = await checkLeader(target, preflightAgain, rollbackNotes, { warm });
    if (second.ok) {
      recordGood(target);
      return finish("rolled-back");
    }
    return finish("failed", "the rolled-back commit failed its health check too; the collector may be down");
  };

  /** A supervised or standalone restart: stop the collector, bring it back, check it, and roll back on failure. */
  const runClassic = async (): Promise<RestartRecord> => {
    save({ phase: "stopping" });
    if (mode === "supervised") {
      const devOk = record.devPid !== undefined && (await isInstallDevScript(exec, record.devPid, record.installDir));
      if (!devOk) {
        startNotes.push(`dev.ts (pid ${record.devPid ?? "?"}) no longer runs; the collector was started standalone`);
        mode = "standalone";
      }
    }
    const stopAt = exec.now();
    if (!(await stopCollector(record.collectorPid, "the collector"))) {
      return finish("failed", `pid ${record.collectorPid} is not this install's collector, so the restart did not signal it`);
    }
    gapStart = stopAt;
    const wrapperPid = record.wrapperPid;
    if (mode === "supervised" && wrapperPid !== undefined && wrapperPid !== record.devPid) {
      // The wrapper exits with its child, which is what makes dev.ts restart
      // it; one that lingers would leave the collector down. It is stopped
      // only while it is still dev.ts's child.
      if (!(await waitUntil(() => !exec.isAlive(wrapperPid), t.wrapperGraceMs))) {
        const info = await processInfo(exec, wrapperPid);
        if (info?.ppid === record.devPid) await stop(wrapperPid, "the collector's wrapper");
        else deps.log(`pid ${wrapperPid} is no longer dev.ts's child; not signalling it`);
      }
    }

    const first = await bringUp(record.headBefore, startNotes, { superseding: true });
    if (first.ok) {
      // HEAD vouches for what runs only on a clean tree: with uncommitted or
      // untracked files, a later rollback to it would not bring this back.
      await recordGoodIfClean(record.headBefore, first);
      return finish("ok");
    }
    if (supersededBy !== undefined) return finishSuperseded(supersededBy, supersededError(supersededBy));

    // ── Rollback ──
    save({ phase: "rolling_back" });
    const target = record.rollbackHead;
    if (!target) {
      record.rollback = { refused: "no earlier known-good commit is recorded" };
      return finish("failed", "the restart failed its health check and there is no earlier known-good commit to roll back to");
    }
    const refused = await checkoutRollback(target, "the restart failed its health check");
    if (refused) return finish("failed", refused);

    // Whatever runs now runs the code that failed: stop all of it so the old
    // commit comes up alone — dev.ts's whole collector branch first (stopping
    // it once, before dev.ts can respawn anything), then any collector this
    // supervisor started, then whatever answered /health.
    if (mode === "supervised") await stopBranch("the failed collector's dev.ts branch");
    // A spawned collector may have exited and its pid been reused since: it
    // is signalled only while it is still this install's collector.
    for (const pid of spawned) await stopCollector(pid, "the failed collector");
    if (first.collectorPid !== undefined && !spawned.includes(first.collectorPid)) {
      await stopCollector(first.collectorPid, "the failed collector");
    }

    const second = await bringUp(target);
    if (second.ok) {
      deps.recordGoodHead(target);
      return finish("rolled-back");
    }
    return finish("failed", "the rolled-back commit failed its health check too; the collector may be down");
  };

  try {
    return await (mode === "handoff" ? runHandoff() : runClassic());
  } catch (err) {
    if (err instanceof RestartPreempted) throw err;
    return finish("failed", `the restart supervisor crashed: ${(err as Error).message}`);
  }
}

const isPid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 1;

/** Whether two commit ids name the same commit, either possibly abbreviated (at least 7 hex digits). */
function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** collector-leader.json in `dataDir`, when it names a pid. */
export function readLeaderFile(dataDir: string): LeaderInfo | null {
  const leader = readJsonFile<LeaderInfo>(leaderFilePath(dataDir));
  return leader && isPid(leader.pid) ? leader : null;
}

/** collector-standby.json in `dataDir`, when it names a pid, its start and its install. */
export function readStandbyFile(dataDir: string): StandbyInfo | null {
  const standby = readJsonFile<StandbyInfo>(standbyFilePath(dataDir));
  return standby && isPid(standby.pid) && typeof standby.startedAt === "string" && typeof standby.installDir === "string" ? standby : null;
}

/** The per-pid standby markers in `dataDir`'s standby/ (`<pid>.json`), by the pid their name carries. */
export function listStandbyMarkers(dataDir: string): Array<{ pid: number; path: string }> {
  const dir = standbyDirPath(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ pid: number; path: string }> = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    const pid = m ? Number(m[1]) : NaN;
    if (isPid(pid)) out.push({ pid, path: join(dir, name) });
  }
  return out.sort((x, y) => x.pid - y.pid);
}

/** A gateway stats body, when it has the counters a restart diffs. */
export function parseGatewayStats(text: string): GatewayStats | null {
  const body = parseJson(text);
  if (!body || !isPid(body.pid)) return null;
  for (const key of ["held", "heldNow", "maxHoldMs", "failed", "wsUpstreamCloses"] as const) {
    if (typeof body[key] !== "number") return null;
  }
  return body as unknown as GatewayStats;
}

/**
 * What a restart cost users, from the gateway's counters before and after
 * (cumulative, so diffed) and the gap. A gateway that restarted meanwhile (a
 * different pid or start) counted from zero, so its counters are taken as
 * they are. The gateway keeps only its all-time longest hold: one that grew
 * is the restart's; otherwise every hold of the restart was at most the
 * previous longest and at most the gap (a held request waits only while no
 * collector serves), and the smaller bound is reported as such. `heldNow`
 * is what the gateway still held when `after` was read: requests not yet
 * counted either way.
 */
export function userImpactOf(before: GatewayStats | undefined, after: GatewayStats | undefined, gapMs: number | undefined): UserImpact {
  if (!before || !after) return { ...(gapMs !== undefined ? { gapMs } : {}), gatewayMeasured: false };
  const restarted = before.pid !== after.pid || before.startedAt !== after.startedAt;
  const base = restarted ? { held: 0, failed: 0, wsUpstreamCloses: 0, maxHoldMs: 0 } : before;
  const held = Math.max(0, after.held - base.held);
  const grew = after.maxHoldMs > base.maxHoldMs;
  const bound = gapMs !== undefined ? Math.min(base.maxHoldMs, gapMs) : base.maxHoldMs;
  return {
    ...(gapMs !== undefined ? { gapMs } : {}),
    heldRequests: held,
    maxHoldMs: held === 0 ? 0 : grew ? after.maxHoldMs : bound,
    ...(held > 0 && !grew ? { maxHoldIsBound: true } : {}),
    failedRequests: Math.max(0, after.failed - base.failed),
    wsReconnects: Math.max(0, after.wsUpstreamCloses - base.wsUpstreamCloses),
    heldNow: after.heldNow,
    gatewayMeasured: true,
    ...(restarted ? { gatewayRestarted: true } : {}),
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function short(head: string | undefined): string {
  return head ? head.slice(0, 12) : "?";
}
