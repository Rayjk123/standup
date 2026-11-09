import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "crypto";
import { join } from "path";
import type { PersonaInboxKind } from "@standup/shared";
import type { DevInfo, GatewayStats } from "@standup/shared/topology";
import { devFilePath, gatewayLogPath, readJsonFile } from "@standup/shared/topology";
import {
  getAsk,
  getPendingAsks,
  getPendingPlanApprovals,
  getPersonaApproval,
  getPersonaInboxItem,
  getPlanApproval,
  getPlanReviewRemark,
  listPendingPersonaInbox,
  listPersonaApprovals,
  listUndeliveredPlanReviewRemarks,
} from "@standup/store";
import type { RestartExec } from "./exec.js";
import { gatewayStatsUrlFor, isAllowedUiUrl } from "./authorize.js";
import {
  DEFAULT_BRANCH_NAMES,
  collectorCwd,
  detectSupervision,
  detectWatchMode,
  gitBranch,
  gitDefaultBranch,
  gitDirtyFiles,
  gitHead,
  isCollectorProcess,
  isInstallDevScript,
  processInfo,
} from "./exec.js";
import { snapshotSupervisor } from "./snapshot.js";
import type {
  DeferredRedeploy,
  PendingCategory,
  PendingSnapshot,
  RestartRecord,
  RestartSource,
  SurvivalCategory,
  SurvivalReport,
  UserImpact,
} from "./state.js";
import {
  PENDING_CATEGORIES,
  RESTART_SCHEMA_VERSION,
  appendRedeployLog,
  appendRestartHistory,
  canonicalPath,
  clearDeferredRedeploy,
  clearFullRestartPending,
  clearRerun,
  currentRecordPath,
  emptySnapshot,
  fullRestartWarning,
  hashNonce,
  isFinal,
  needsFullRestart,
  readDeferredRedeploy,
  readFullRestartPending,
  readGoodHeads,
  readRecord,
  readRerun,
  readRestartHistory,
  recordGoodHead,
  recordRefusal,
  redeployLogPath,
  requestRerun,
  restartDir,
  sameCommit,
  writeDeferredRedeploy,
  writeRecord,
  writeRecordIfCurrent,
} from "./state.js";
import {
  NO_DEV_SLOT_REFUSAL,
  handoffPreflightMs,
  parseGatewayStats,
  planRestart,
  readLeaderFile,
  readStandbyFile,
  redeployWindowFreesAt,
  short,
  timingsFromEnv,
  worstCaseMs,
} from "./supervisor.js";

/** What the service needs from Persona: a pause around the restart, and an inbox for the report. */
export interface RestartPersona {
  quiesce(timeoutMs: number): Promise<boolean>;
  release(): void;
  enqueue(
    kind: PersonaInboxKind,
    payload: Record<string, unknown>,
    opts?: { threadId?: string; coalesceKey?: string }
  ): unknown;
  /** A redeploy is rolling the install's main, now at `head`, in: Persona's to verify (see commitments.ts). */
  noteInstallAdvanced?(head: string): void;
}

export interface RestartServiceOptions {
  db: Database;
  owner: string;
  /** Where the collector keeps its data (the SQLite file's directory). */
  dataDir: string;
  /** The Standup install (a git checkout) the collector runs from. */
  installDir: string;
  /** The collector's own loopback base URL, e.g. http://127.0.0.1:7777. */
  collectorUrl: string;
  /**
   * The web UI checked after the restart (STANDUP_WEB_URL), unless a request
   * names another; a request may name only this one or a loopback URL.
   */
  uiUrl?: string;
  exec: RestartExec;
  /** Undefined when Persona is disabled: nothing is held, and reports wait for a collector that runs it. */
  persona?: RestartPersona;
  /** The collector's pid (default process.pid). */
  pid?: number;
  /** How the supervisor starts the collector when nothing supervises it. */
  collector?: { argv: string[]; cwd: string };
  /**
   * The supervisor's command line for a record path (its nonce goes on
   * stdin). By default the supervisor's code is copied into the data dir for
   * restart `id` (snapshotSupervisor) and that copy runs.
   */
  supervisorArgv?: (recordPath: string, id: string) => string[];
  /** The runtime flags the collector was started with (default process.execArgv), to tell `bun --watch`. */
  execArgv?: readonly string[];
  /**
   * Asks this collector timed out as it booted because their waiter could not
   * re-attach (see timeoutOrphanedAsks); a restart report names them.
   */
  orphanedAsks?: readonly string[];
  /** How long Persona gets to finish its turn before the collector stops anyway. */
  quiesceTimeoutMs?: number;
  /** How long a spawned supervisor gets to take the restart over before it counts as failed. */
  takeoverTimeoutMs?: number;
  /**
   * How long Persona stays held once the supervisor took over without this
   * collector being stopped; then the restart is failed here, the supervisor
   * stopped, and Persona released.
   */
  holdTimeoutMs?: number;
  /** Interval of the record polls (takeover watch, report pickup). */
  pollMs?: number;
  /**
   * How long a collector waits on an unfinished restart's supervisor before
   * giving up on it; by default the supervisor's worst case with the timings
   * it runs with (timingsFromEnv), plus a minute.
   */
  pickupTimeoutMs?: number;
  /** How long a report waits for the waiters of asks pending before the restart to re-attach. */
  reattachGraceMs?: number;
  /**
   * The per-user local write token (`~/.standup/write-token`): a redeploy
   * (POST /api/standup/restart with source "redeploy") must present it.
   * Undefined: redeploys are refused.
   */
  writeToken?: string;
  /**
   * The commit this collector's code was loaded from, read when the process
   * started. What it records as known-good and reports as running; without
   * it, the install's HEAD when it checks (which a merge since boot may have moved).
   */
  loadedHead?: string;
  /**
   * The branch redeploys follow: one runs only while the install is checked
   * out on it (not detached, as after a rollback). Default: the branch the
   * latest restart started from, else the branch the install is on when it
   * is main, mainline or master, else its default branch (origin/HEAD's,
   * else main, mainline or master), else `main`.
   */
  branch?: string;
  /**
   * Runs `fn` once after `ms`; returns what cancels it. Default: an unref'd
   * setTimeout (it never keeps the process alive).
   */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface RestartRequest {
  reason: string;
  requestedBy: string;
  uiUrl?: string;
  threadId?: string;
  /** The Persona turn batch, or `approval:<id>` for a restart the owner approved on a held card. */
  batchKey?: string;
  /** Default `persona`. */
  source?: RestartSource;
}

export type RestartRequestResult =
  | { status: 202; id: string; record: RestartRecord }
  | { status: 200; id: string; duplicate: true; record: RestartRecord }
  | { status: 400 | 409 | 429 | 500; error: string };

export type RedeployResult =
  | RestartRequestResult
  /** HEAD is what the running collector already runs. */
  | { status: 200; noop: true; head: string }
  /** A restart is under way; once it is done, one more redeploy runs if HEAD moved. */
  | { status: 202; coalesced: true; id?: string };

export const DEFAULT_UI_URL = "http://localhost:5173/";

/** A kind of redeploy refusal is told to Persona at most once in this long. */
export const REFUSAL_REPORT_EVERY_MS = 60 * 60_000;

/** The kind of a refusal by the hourly redeploy cap (MAX_REDEPLOYS_PER_HOUR). */
export const CAP_REFUSAL_KIND = "429:cap";

/**
 * The class of a redeploy refusal — its status and the reason behind it —
 * which Persona's reports are keyed and rate-limited by: the same refusal
 * recurring on every merge is one kind, whatever commit it refused.
 */
export function refusalKind(status: number, error: string): string {
  if (status === 429) return CAP_REFUSAL_KIND;
  if (status === 409) {
    if (error.startsWith(NO_DEV_SLOT_REFUSAL)) return "409:no-dev-slot";
    if (/on a detached HEAD/.test(error)) return "409:detached";
    if (/^the install is on branch /.test(error)) return "409:branch";
    if (/already in progress|already being scheduled|still being delivered/.test(error)) return "409:busy";
  }
  if (status === 500 && /git HEAD/.test(error)) return "500:head";
  return `${status}:other`;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * The warning a restart carries when the collector runs under `bun --watch`:
 * the restart itself is guarded, but every other change to the install
 * reloads the collector unguarded.
 */
export function watchModeWarning(shownBy: string): string {
  return (
    `the collector runs under bun --watch (${shownBy.slice(0, 200)}), so every merge or checkout in the install hot-reloads it at once — ` +
    "with no quiesce, health check or rollback; only restarts through restart_standup are guarded. " +
    "To switch, stop `bun run dev` and start it again without STANDUP_COLLECTOR_WATCH=1 (scripts/dev.ts then runs the collector with `bun run start`)"
  );
}

/**
 * The collector's side of a restart. A request records what is pending and
 * where the code stands, lets Persona finish its turn, then hands the restart
 * to a detached supervisor (restart/cli.ts) and returns; the supervisor stops
 * this collector. The next collector, once it serves, picks the record up and
 * delivers the outcome to Persona's inbox in the thread that asked
 * (onCollectorReady), and records its own commit as known-good when it boots
 * outside a restart and its /health and Persona's state both answer.
 */
export class RestartService {
  private readonly opts: RestartServiceOptions;
  private readonly recordPath: string;
  private readonly pid: number;
  /** The restart this collector is handing off, from request to takeover. */
  private inFlight: RestartRecord | null = null;
  /** Set synchronously on request, so overlapping requests can't both pass the checks. */
  private busy = false;
  private supervisorPid?: number;
  private stopped = false;
  /** Asks and plans whose waiters re-attached to this collector (their MCP re-sent the call). */
  private readonly reattached = new Set<string>();
  /** Set while onCollectorReady reports a previous restart; a new one waits for it. */
  private pickingUp = false;
  /** Reports being delivered right now. */
  private delivering = 0;
  /** Settles once the latest request's supervisor has taken over, or the hand-off has failed. */
  handoff: Promise<void> = Promise.resolve();
  /**
   * Settles once this collector stops watching the latest handed-off restart:
   * it was stopped, or the restart ended (and was reported) here.
   */
  watch: Promise<void> = Promise.resolve();
  /** Settles once onCollectorReady has delivered (or given up on) a report. */
  pickup: Promise<void> = Promise.resolve();
  /** A redeploy coalesced while a request was being scheduled, before its record existed. */
  private rerunPending = false;
  /** Settles once the redeploy a finished restart triggered (rerunRequested) has been asked for. */
  rerun: Promise<void> = Promise.resolve();
  /** Settles once the latest run of the redeploy the hourly cap deferred has been asked for. */
  deferred: Promise<void> = Promise.resolve();
  private cancelDeferredTimer?: () => void;

  constructor(opts: RestartServiceOptions) {
    this.opts = opts;
    this.recordPath = currentRecordPath(opts.dataDir);
    this.pid = opts.pid ?? process.pid;
  }

  /** The local write token a redeploy presents; undefined when redeploys are off. */
  get writeToken(): string | undefined {
    return this.opts.writeToken?.trim() || undefined;
  }

  /** The latest restart record, if any. */
  current(): RestartRecord | null {
    return readRecord(this.recordPath);
  }

  /**
   * A redeploy (the post-merge hook): a restart onto the install's HEAD that
   * the rate limit doesn't apply to. A no-op when HEAD is what the running
   * collector runs. One asked for while a restart is under way is coalesced
   * into it: once that restart is done and reported, one more redeploy runs
   * if HEAD moved past what it deployed. Redeploys follow one branch
   * (`branch`): with the install on another, or detached (as a rollback
   * leaves it), one is refused. A refusal is recorded in the restart history
   * and, unless the redeploy script answers it with a full restart
   * (NO_DEV_SLOT_REFUSAL), told to Persona; a redeploy that runs, is
   * coalesced or is a no-op is not.
   */
  async redeploy(input: { reason: string }): Promise<RedeployResult> {
    const result = await this.redeployOnce(input);
    if ("error" in result) return this.noteRefusedRedeploy(result);
    // HEAD is deployed, or being deployed: a deferred redeploy has nothing left to do.
    if (!("coalesced" in result)) this.dropDeferred();
    return result;
  }

  /**
   * Records a refused redeploy in refusals.json (apart from the restart
   * history, so it counts toward no cap) and tells Persona's console thread,
   * at most once per kind of refusal (refusalKind) every
   * REFUSAL_REPORT_EVERY_MS, in one inbox item per kind; the rest are only
   * logged. A refusal by the hourly redeploy cap is never told: one redeploy
   * is deferred to when the window frees instead (deferRedeploy), and the
   * refusal says when.
   */
  private async noteRefusedRedeploy(result: { status: 400 | 409 | 429 | 500; error: string }): Promise<RedeployResult> {
    const { exec, dataDir } = this.opts;
    const { status } = result;
    let { error } = result;
    try {
      const head = (await gitHead(exec, this.opts.installDir)) ?? "";
      const now = exec.now();
      const kind = refusalKind(status, error);
      if (kind === CAP_REFUSAL_KIND && head) {
        const at = redeployWindowFreesAt(readRestartHistory(dataDir), now) ?? now + 60_000;
        this.deferRedeploy({ at, head, deferredAt: now });
        error = `${error}; a redeploy of ${short(head)} is deferred to ${new Date(at).toISOString()}, when the hourly window frees`;
      }
      const id = `refused-${randomUUID().slice(0, 8)}`;
      const persona = this.opts.persona;
      const reportable = !!persona && kind !== CAP_REFUSAL_KIND && !error.startsWith(NO_DEV_SLOT_REFUSAL);
      const { report } = recordRefusal(
        dataDir,
        { id, at: now, headBefore: head, status, kind, error },
        { reportEveryMs: REFUSAL_REPORT_EVERY_MS, reportable }
      );
      console.warn(
        `[restart] redeploy to ${short(head || undefined)} refused (HTTP ${status}, ${kind}): ${error}` +
          (reportable && !report ? "; Persona was already told of this kind of refusal within the hour" : "")
      );
      if (persona && report) {
        persona.enqueue(
          "system",
          {
            type: "restart_report",
            restartId: id,
            outcome: "refused",
            summary:
              `REDEPLOY REFUSED — the merge to ${short(head || undefined)} was not deployed (HTTP ${status}): ${error}. Standup keeps running the code it already runs; nothing was restarted. ` +
              "Further refusals of this kind within the hour are only logged (restart/redeploy.log).",
          },
          { coalesceKey: `redeploy-refused:${kind}` }
        );
      }
    } catch (err) {
      console.error("[restart] could not record a refused redeploy:", err);
    }
    return { status, error };
  }

  /** Persists `deferred` (replacing any other) and arms the timer that runs it. */
  private deferRedeploy(deferred: DeferredRedeploy): void {
    writeDeferredRedeploy(this.opts.dataDir, deferred);
    this.armDeferred(deferred.at);
  }

  private dropDeferred(): void {
    this.cancelDeferredTimer?.();
    this.cancelDeferredTimer = undefined;
    clearDeferredRedeploy(this.opts.dataDir);
  }

  private armDeferred(at: number): void {
    this.cancelDeferredTimer?.();
    const schedule = this.opts.schedule ?? defaultSchedule;
    this.cancelDeferredTimer = schedule(() => {
      this.cancelDeferredTimer = undefined;
      this.deferred = this.runDeferredRedeploy().catch((err) => console.error("[restart] deferred redeploy failed:", err));
    }, Math.max(0, at - this.opts.exec.now()));
  }

  /**
   * Runs the redeploy deferred by the hourly cap once it is due (arming the
   * timer for it when it isn't yet): a no-op when HEAD is what the leader
   * already runs. Called by its timer and once the collector serves.
   */
  private async runDeferredRedeploy(): Promise<void> {
    const deferred = readDeferredRedeploy(this.opts.dataDir);
    if (!deferred || this.stopped) return;
    if (deferred.at > this.opts.exec.now()) {
      this.armDeferred(deferred.at);
      return;
    }
    clearDeferredRedeploy(this.opts.dataDir);
    const result = await this.redeploy({ reason: `deferred redeploy (the hourly redeploy cap refused ${short(deferred.head)})` });
    const outcome = "error" in result ? `refused: ${result.error}` : "noop" in result ? "a no-op" : "coalesced" in result ? "coalesced" : `restart ${result.id}`;
    console.log(`[restart] the deferred redeploy is ${outcome}`);
  }

  private async redeployOnce(input: { reason: string }): Promise<RedeployResult> {
    // Decided and flagged before any await, so a restart finishing meanwhile
    // can't miss the flag.
    if (this.inFlight && !this.busy) {
      const onDisk = this.current();
      if (onDisk?.id === this.inFlight.id && isFinal(onDisk)) this.inFlight = null;
    }
    const latest = this.current();
    if (this.busy) {
      this.rerunPending = true;
      return { status: 202, coalesced: true };
    }
    const underway = !!this.inFlight || this.pickingUp || this.delivering > 0 || (!!latest && !isFinal(latest) && this.isActive(latest));
    if (underway && latest && this.flagCoalesced(latest.id)) return { status: 202, coalesced: true, id: latest.id };
    const [head, branch] = await Promise.all([gitHead(this.opts.exec, this.opts.installDir), gitBranch(this.opts.exec, this.opts.installDir)]);
    const running = this.runningHead();
    if (head && running && head === running) return { status: 200, noop: true, head };
    // With nothing recorded, an install on a conventional default branch
    // follows it (as one on `main` always did); any other branch or a detached
    // HEAD is held to the install's default branch, so a topic branch is refused.
    const follows =
      this.opts.branch ??
      latest?.branchBefore ??
      (branch && DEFAULT_BRANCH_NAMES.includes(branch) ? branch : undefined) ??
      (await gitDefaultBranch(this.opts.exec, this.opts.installDir)) ??
      "main";
    if (branch !== follows) {
      const fix = `\`git -C ${this.opts.installDir} checkout ${follows}\``;
      return {
        status: 409,
        error: branch
          ? `the install is on branch ${branch}, not ${follows}; redeploys follow ${follows} only, so nothing was restarted. Run ${fix} to resume them`
          : `the install is on a detached HEAD, not ${follows} (a failed restart's rollback leaves it so); redeploys follow ${follows} only, so nothing was restarted. ` +
            `Fix forward on ${follows}, then run ${fix} to resume them`,
      };
    }
    return this.request({ reason: input.reason, requestedBy: "redeploy", source: "redeploy" });
  }

  /**
   * Requests one more redeploy after restart `id` (rerun.json; current.json
   * is never rewritten here, since a supervisor may own it). A finished one
   * takes the request only while its report is still to go out here, or is
   * being taken up (pickingUp), since that is what consumes it; false when
   * nothing would, or the record on disk is another restart.
   */
  private flagCoalesced(id: string): boolean {
    const disk = this.current();
    if (!disk || disk.id !== id) return false;
    if (isFinal(disk) && disk.delivered && !this.pickingUp) return false;
    requestRerun(this.opts.dataDir, id, new Date(this.opts.exec.now()).toISOString());
    return true;
  }

  /**
   * The commit this collector runs: the head in collector-leader.json when it
   * names this collector, else the newest known-good commit (recorded at boot
   * and by each healthy restart) — unless it knows the commit it loaded.
   */
  private runningHead(): string | undefined {
    if (this.opts.loadedHead) return this.opts.loadedHead;
    const leader = readLeaderFile(this.opts.dataDir);
    if (leader?.pid === this.pid && leader.head) return leader.head;
    return readGoodHeads(this.opts.dataDir)[0]?.head;
  }

  /** Whether one more redeploy is requested after `record`: on the record itself, or in rerun.json. */
  private rerunWanted(record: RestartRecord): boolean {
    return !!record.rerunRequested || readRerun(this.opts.dataDir)?.id === record.id;
  }

  /**
   * Consumes the coalesced-redeploy request of a finished restart (rerun.json
   * and the record's own flag): the record when it had one, else null.
   */
  private takeRerun(): RestartRecord | null {
    const record = this.current();
    if (!record || !isFinal(record)) return null;
    const filed = clearRerun(this.opts.dataDir, record.id);
    if (!record.rerunRequested && !filed) return null;
    if (record.rerunRequested) writeRecordIfCurrent(this.recordPath, { ...record, rerunRequested: false });
    return record;
  }

  /**
   * Runs the redeploy coalesced into `finished` when HEAD moved past what it
   * deployed — unless that move touches files only a full restart loads:
   * then nothing is handed off, and the record says a full restart is needed.
   */
  private async rerunIfMoved(finished: RestartRecord | null): Promise<void> {
    if (!finished || this.stopped) return;
    const head = await gitHead(this.opts.exec, this.opts.installDir);
    if (!head || head === finished.headBefore) {
      console.log(`[restart] ${finished.id}: a redeploy was coalesced into it, and HEAD has not moved since`);
      return;
    }
    const skipped = await this.skippedRerunNote(finished);
    if (skipped) {
      this.markFullRestart(finished.id, skipped);
      console.warn(`[restart] ${finished.id}: ${skipped}`);
      return;
    }
    const result = await this.redeploy({ reason: `redeploy (coalesced into restart ${finished.id}) to ${short(head)}` });
    const outcome = "error" in result ? `refused: ${result.error}` : "noop" in result ? "a no-op" : "coalesced" in result ? "coalesced again" : `restart ${result.id}`;
    console.log(`[restart] ${finished.id}: HEAD moved to ${short(head)}; the coalesced redeploy is ${outcome}`);
  }

  /** After a restart's report went out here: the redeploy coalesced into it, if any. */
  private afterReport(): void {
    const finished = this.takeRerun();
    if (finished) this.rerun = this.rerunIfMoved(finished).catch((err) => console.error("[restart] coalesced redeploy failed:", err));
  }

  /**
   * dev.json, while the pid it names is this install's dev.ts (its command
   * line and working directory, not just a live pid: a recycled pid or
   * another install's dev.ts is not trusted).
   */
  private async verifiedDev(): Promise<DevInfo | null> {
    const { exec, dataDir, installDir } = this.opts;
    const dev = readJsonFile<DevInfo>(devFilePath(dataDir));
    if (!dev || typeof dev.pid !== "number" || !Number.isInteger(dev.pid) || dev.pid <= 1) return null;
    if (typeof dev.installDir !== "string" || canonicalPath(dev.installDir) !== canonicalPath(installDir)) return null;
    return (await isInstallDevScript(exec, dev.pid, installDir)) ? dev : null;
  }

  /**
   * The full-restart-only files (FULL_RESTART_PATHS) changed between `from`
   * and `to`; empty when none did, or git can't tell.
   */
  private async fullRestartChanges(from: string | undefined, to: string | null): Promise<string[]> {
    if (!from || !to || from === to) return [];
    const diff = await this.opts.exec.run(["git", "-C", this.opts.installDir, "diff", "--name-only", from, to], { timeoutMs: 20_000 });
    if (diff.code !== 0) return [];
    return needsFullRestart(diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  }

  /** The commit a finished restart left running: the rolled-back one, else the one it deployed. */
  private static deployedHead(record: RestartRecord): string {
    return record.outcome === "rolled-back" && record.rollback?.head ? record.rollback.head : record.headBefore;
  }

  /**
   * The note a finished restart's record and report carry when the redeploy
   * coalesced into it is not run: HEAD moved past what it deployed in files
   * only a full restart loads. Null when it would run (or HEAD didn't move).
   */
  private async skippedRerunNote(finished: RestartRecord): Promise<string | null> {
    const head = await gitHead(this.opts.exec, this.opts.installDir);
    if (!head || head === finished.headBefore) return null;
    const deployed = RestartService.deployedHead(finished);
    const files = await this.fullRestartChanges(deployed, head);
    if (files.length === 0) return null;
    return `the redeploy coalesced into this restart, to ${short(head)}, was not run: ${fullRestartWarning(files, `this restart deployed ${short(deployed)}`)}`;
  }

  /** Marks restart `id` (as on disk) as needing a full restart, with `note` among its warnings. */
  private markFullRestart(id: string, note: string): RestartRecord | null {
    const disk = this.current();
    if (!disk || disk.id !== id) return null;
    if (disk.fullRestartNeeded && disk.warnings?.includes(note)) return disk;
    const marked: RestartRecord = { ...disk, fullRestartNeeded: true, warnings: [...(disk.warnings ?? []), note] };
    return writeRecordIfCurrent(this.recordPath, marked) ? marked : null;
  }

  /**
   * Whether this collector runs as a slot behind the gateway — the leader
   * file names it with a slot, a live standby of this install waits, or
   * dev.json says this install's dev.ts runs the gateway topology — so the
   * restart hands off (through that dev.ts, `devPid`, when none is above
   * this collector); and the gateway's counters, which are only reported: a
   * gateway that doesn't answer them is the handoff's gateway check to
   * report, never a reason to stop the leader for whichever slot takes the
   * lock next.
   */
  private async detectHandoff(): Promise<{ stats: GatewayStats | null; slotted: boolean; standbyPid?: number; leaderHead?: string; devPid?: number }> {
    const { exec, dataDir, installDir } = this.opts;
    const res = await exec.httpGet(gatewayStatsUrlFor(this.opts.collectorUrl), { timeoutMs: 3_000 });
    const stats = res.status === 200 ? parseGatewayStats(res.body) : null;
    const leader = readLeaderFile(dataDir);
    const ours = leader?.pid === this.pid ? leader : null;
    const standby = readStandbyFile(dataDir);
    const ready =
      !!standby &&
      standby.pid !== this.pid &&
      canonicalPath(standby.installDir) === canonicalPath(installDir) &&
      exec.isAlive(standby.pid) &&
      (await isCollectorProcess(exec, standby.pid, installDir));
    const dev = await this.verifiedDev();
    const devGateway = dev?.gateway === true;
    const slotted = !!ours?.slot || ready || devGateway;
    const leaderHead = ours?.head ?? this.opts.loadedHead;
    return {
      stats,
      slotted,
      ...(ready ? { standbyPid: standby!.pid } : {}),
      ...(leaderHead ? { leaderHead } : {}),
      ...(devGateway ? { devPid: dev!.pid } : {}),
    };
  }

  stop(): void {
    this.stopped = true;
    this.cancelDeferredTimer?.();
    this.cancelDeferredTimer = undefined;
  }

  /**
   * Notes that the waiter of ask (or plan) `id` re-attached here — its MCP
   * re-sent the call with the same request id, or re-sent submit_plan — for
   * the survival part of a restart report.
   */
  noteReattached(id: string): void {
    this.reattached.add(id);
  }

  async request(input: RestartRequest): Promise<RestartRequestResult> {
    // A handed-off restart that finished without stopping this collector is
    // over; it no longer blocks the next one.
    if (this.inFlight && !this.busy) {
      const onDisk = this.current();
      if (onDisk?.id === this.inFlight.id && isFinal(onDisk)) this.inFlight = null;
    }
    if (this.busy || this.inFlight) {
      const active = this.inFlight;
      if (active && input.batchKey && active.batchKey === input.batchKey && active.threadId === input.threadId) {
        return { status: 200, id: active.id, duplicate: true, record: active };
      }
      return { status: 409, error: active ? `restart ${active.id} is already in progress` : "a restart is already being scheduled" };
    }
    // A new record replaces current.json, so the previous restart's report
    // must have gone out first.
    if (this.pickingUp || this.delivering > 0) {
      const pending = this.current();
      return { status: 409, error: `the report of restart ${pending?.id ?? "?"} is still being delivered; ask again in a moment` };
    }
    const uiUrl = input.uiUrl ?? this.opts.uiUrl ?? DEFAULT_UI_URL;
    if (!isAllowedUiUrl(uiUrl, this.opts.uiUrl)) {
      return { status: 400, error: `uiUrl ${uiUrl.slice(0, 200)} must be a loopback URL or the configured STANDUP_WEB_URL` };
    }
    this.busy = true;
    try {
      const { exec, installDir } = this.opts;
      const previous = this.current();
      if (previous && isFinal(previous) && !previous.delivered && this.opts.persona) {
        await this.deliver(previous, { waitForWaiters: false });
      }
      const latest = this.current();
      const latestActive = latest && !isFinal(latest) ? this.isActive(latest) : false;
      const now = exec.now();
      const source = input.source ?? "persona";
      const [headBefore, branchBefore, supervision, watchedBy, handoff] = await Promise.all([
        gitHead(exec, installDir),
        gitBranch(exec, installDir),
        detectSupervision(exec, this.pid),
        detectWatchMode(exec, this.pid, this.opts.execArgv ?? process.execArgv),
        this.detectHandoff(),
      ]);
      const plan = planRestart({
        latest,
        latestActive,
        batchKey: input.batchKey,
        threadId: input.threadId,
        headBefore,
        goodHeads: readGoodHeads(this.opts.dataDir),
        supervision,
        history: readRestartHistory(this.opts.dataDir),
        now,
        ownerApproved: this.ownerApproved(input.batchKey),
        source,
        standbyReady: handoff.standbyPid !== undefined,
        slotted: handoff.slotted,
        ...(handoff.devPid !== undefined ? { gatewayDevPid: handoff.devPid } : {}),
      });
      if (plan.kind === "refuse") return { status: plan.status, error: plan.error };
      if (plan.kind === "duplicate") return { status: 200, id: plan.record.id, duplicate: true, record: plan.record };
      // A redeploy (the post-merge hook's, a coalesced rerun or a deferred
      // one) rolls in a merge that moved the install's main: verifying it and
      // closing the landed jobs is Persona's next step.
      if (source === "redeploy" && headBefore) {
        try {
          this.opts.persona?.noteInstallAdvanced?.(headBefore);
        } catch (err) {
          console.error("[restart] could not note the install's new head for Persona:", err);
        }
      }
      // dev.ts and the gateway keep running the commit dev.ts started on.
      const devHead = (await this.verifiedDev())?.head;
      const fullFiles = await this.fullRestartChanges(devHead, headBefore);
      const full = fullFiles.length > 0;
      const warnings = [
        ...(watchedBy ? [watchModeWarning(watchedBy)] : []),
        ...(full ? [fullRestartWarning(fullFiles, `dev.ts started on ${short(devHead)}`)] : []),
      ];

      const ui = await exec.httpGet(uiUrl, { timeoutMs: 3_000 });
      const id = randomUUID().slice(0, 8);
      const dir = restartDir(this.opts.dataDir);
      const requestedAt = new Date(now).toISOString();
      const record: RestartRecord = {
        id,
        schemaVersion: RESTART_SCHEMA_VERSION,
        requestedAt,
        requestedBy: input.requestedBy,
        reason: input.reason,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.batchKey ? { batchKey: input.batchKey } : {}),
        source,
        ...(this.rerunPending ? { rerunRequested: true } : {}),
        phase: "scheduled",
        installDir,
        dataDir: this.opts.dataDir,
        mode: plan.mode,
        ...(plan.devPid !== undefined ? { devPid: plan.devPid } : {}),
        ...(plan.wrapperPid !== undefined ? { wrapperPid: plan.wrapperPid } : {}),
        collectorPid: this.pid,
        ...(plan.mode === "handoff"
          ? {
              leaderPid: this.pid,
              ...(handoff.standbyPid !== undefined ? { standbyPid: handoff.standbyPid } : {}),
              ...(handoff.leaderHead ? { leaderHead: handoff.leaderHead } : {}),
            }
          : {}),
        // In handoff mode the gateway is checked after the switch even when it
        // didn't answer now; its counters are diffed only when it did.
        ...(handoff.stats || plan.mode === "handoff"
          ? { gatewayStatsUrl: gatewayStatsUrlFor(this.opts.collectorUrl), gatewayLog: gatewayLogPath(this.opts.dataDir) }
          : {}),
        ...(handoff.stats ? { gatewayBefore: handoff.stats } : {}),
        collector: this.opts.collector ?? {
          argv: [process.execPath, "run", "src/index.ts"],
          cwd: collectorCwd(installDir),
        },
        collectorUrl: this.opts.collectorUrl,
        uiUrl,
        uiReachableBefore: ui.status >= 200 && ui.status < 400,
        personaEnabled: !!this.opts.persona,
        headBefore: plan.headBefore,
        ...(branchBefore ? { branchBefore } : {}),
        ...(plan.rollbackHead ? { rollbackHead: plan.rollbackHead } : {}),
        ...(plan.rollbackWithheld ? { rollbackWithheld: plan.rollbackWithheld } : {}),
        supervisorLog: join(dir, `${id}.log`),
        collectorLog: join(dir, `collector-${id}.log`),
        pendingBefore: emptySnapshot(),
        attempts: [],
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(full ? { fullRestartNeeded: true } : {}),
        updatedAt: requestedAt,
      };
      for (const warning of warnings) console.warn(`[restart] ${id}: ${warning}`);
      writeRecord(this.recordPath, record);
      this.rerunPending = false;
      appendRestartHistory(this.opts.dataDir, { id, at: now, headBefore: plan.headBefore, ...(source === "redeploy" ? { source } : {}) });
      this.inFlight = record;
      this.handoff = this.handOff(record);
      return { status: 202, id, record };
    } finally {
      this.busy = false;
      // A redeploy coalesced into a request that was then refused has no
      // restart to wait for: it runs on its own.
      if (this.rerunPending) {
        this.rerunPending = false;
        this.rerun = this.redeploy({ reason: "redeploy (coalesced into a refused restart)" })
          .then(() => {})
          .catch((err) => console.error("[restart] coalesced redeploy failed:", err));
      }
    }
  }

  /** Whether `batchKey` names a held restart_standup card the owner approved. */
  private ownerApproved(batchKey: string | undefined): boolean {
    if (!batchKey?.startsWith("approval:")) return false;
    const approval = getPersonaApproval(this.opts.db, batchKey.slice("approval:".length));
    return !!approval && approval.action === "restart_standup" && (approval.status === "approved" || approval.status === "executed");
  }

  /**
   * Whether an unfinished record is still being carried out: before handoff
   * only by the collector that wrote it (this one, if it is in flight here),
   * after it while its supervisor runs.
   */
  private isActive(record: RestartRecord): boolean {
    if (this.inFlight?.id === record.id) return true;
    if (record.phase === "scheduled" || record.phase === "quiescing") return false;
    const pid = record.supervisorPid ?? (this.inFlight?.id === record.id ? this.supervisorPid : undefined);
    return pid !== undefined && this.opts.exec.isAlive(pid);
  }

  private handOff(record: RestartRecord): Promise<void> {
    let tookOver!: () => void;
    const handedOff = new Promise<void>((resolve) => (tookOver = resolve));
    this.watch = this.carryHandOff(record, tookOver).finally(() => tookOver());
    return handedOff;
  }

  private async carryHandOff(record: RestartRecord, tookOver: () => void): Promise<void> {
    const { exec, persona } = this.opts;
    try {
      if (!writeRecordIfCurrent(this.recordPath, Object.assign(record, { phase: "quiescing" }))) {
        throw new Error(`restart ${record.id}'s record was replaced`);
      }
      // Persona's running turn (the one that asked, usually) settles first, so
      // its items are marked done and its reply is posted; a turn cut off by
      // the stop would replay — and could ask for this restart again.
      const quiet = persona ? await persona.quiesce(this.opts.quiesceTimeoutMs ?? 5 * 60_000) : true;
      if (!quiet) console.warn(`[restart] ${record.id}: Persona's turn did not settle in time; restarting anyway`);
      // The supervisor proves it was started by this collector with a nonce
      // only it knows: passed on stdin (never argv or the environment, which
      // `ps` shows), stored here only as a hash.
      const nonce = randomBytes(32).toString("hex");
      const argv = this.opts.supervisorArgv
        ? this.opts.supervisorArgv(this.recordPath, record.id)
        : [process.execPath, "run", snapshotSupervisor(this.opts.dataDir, record.id), this.recordPath];
      Object.assign(record, { pendingBefore: snapshotPending(this.opts.db, this.opts.owner), phase: "handed_off", nonceHash: hashNonce(nonce) });
      if (!writeRecordIfCurrent(this.recordPath, record)) throw new Error(`restart ${record.id}'s record was replaced`);
      // The supervisor runs from its snapshot, so it learns its install from
      // the environment rather than from where its code sits.
      const pid = exec.spawnDetached(argv, {
        cwd: record.installDir,
        logFile: record.supervisorLog,
        env: { ...process.env, STANDUP_INSTALL_DIR: record.installDir },
        stdin: `${nonce}\n`,
      });
      this.supervisorPid = pid;
      console.log(`[restart] ${record.id}: handed off to supervisor pid ${pid} (log ${record.supervisorLog})`);
      await this.watchHandoff(record, pid, tookOver);
    } catch (err) {
      await this.failHere(record, `could not hand the restart to its supervisor: ${(err as Error).message}`);
    }
  }

  /**
   * Watches the handed-off restart until this collector is stopped. The
   * supervisor takes over by advancing the record past `handed_off`, then
   * stops this collector. While this collector still runs, the restart is
   * failed and reported here (and Persona released) when the supervisor exits
   * — before or after taking over — or doesn't take over in time, or holds
   * Persona longer than holdTimeoutMs after taking over; a record the
   * supervisor finished without stopping this collector is reported as is.
   */
  private async watchHandoff(record: RestartRecord, pid: number, onTakeover: () => void): Promise<void> {
    const { exec } = this.opts;
    const takeoverDeadline = exec.now() + (this.opts.takeoverTimeoutMs ?? 60_000);
    // A handoff supervisor reloads the standby (and on failure rolls back and
    // reloads it again) before it stops this collector.
    const holdMs = (this.opts.holdTimeoutMs ?? 120_000) + (record.mode === "handoff" ? handoffPreflightMs(timingsFromEnv()) : 0);
    let holdDeadline: number | undefined;
    while (!this.stopped) {
      await exec.sleep(this.opts.pollMs ?? 1_000);
      if (this.stopped) return;
      const now = readRecord(this.recordPath);
      if (!now || now.id !== record.id) {
        this.inFlight = null;
        this.opts.persona?.release();
        return;
      }
      if (isFinal(now)) {
        console.warn(`[restart] ${record.id}: finished (${now.outcome}) without stopping this collector`);
        this.inFlight = null;
        this.opts.persona?.release();
        if (!now.delivered) await this.deliver(now, { waitForWaiters: false });
        this.afterReport();
        return;
      }
      const tookOver = now.phase !== "handed_off";
      if (tookOver && holdDeadline === undefined) {
        holdDeadline = exec.now() + holdMs;
        onTakeover();
      }
      if (!exec.isAlive(pid)) {
        await this.failHere(
          record,
          tookOver
            ? `the restart supervisor (pid ${pid}) stopped after taking over (${now.phase}) but before it stopped this collector; see ${record.supervisorLog}`
            : `the restart supervisor (pid ${pid}) exited before it took over; see ${record.supervisorLog}`
        );
        return;
      }
      if (!tookOver && exec.now() >= takeoverDeadline) {
        exec.kill(pid, "SIGTERM");
        // failHere builds on the record as it is now: the supervisor may have
        // taken over just before the signal.
        await this.failHere(record, `the restart supervisor (pid ${pid}) did not take over within the timeout; see ${record.supervisorLog}`);
        return;
      }
      if (holdDeadline !== undefined && exec.now() >= holdDeadline) {
        exec.kill(pid, "SIGTERM");
        await this.failHere(
          record,
          `the restart supervisor (pid ${pid}) took over but had not stopped this collector after ${Math.round(holdMs / 1000)}s; it was stopped and Persona released`
        );
        return;
      }
    }
  }

  /**
   * Ends a restart that never left this collector, and reports it right away.
   * Builds on the record as it is on disk now (a supervisor may have written
   * to it, even just before it was stopped), so nothing it recorded is lost.
   */
  private async failHere(record: RestartRecord, error: string): Promise<void> {
    console.error(`[restart] ${record.id}: ${error}`);
    const disk = readRecord(this.recordPath);
    const base = disk && disk.id === record.id ? disk : record;
    const failed: RestartRecord = { ...base, phase: "done", outcome: "failed", error, finishedAt: new Date(this.opts.exec.now()).toISOString() };
    delete failed.nonceHash;
    if (!writeRecordIfCurrent(this.recordPath, failed)) console.warn(`[restart] ${record.id}: its record was replaced; reporting the failure without recording it`);
    this.inFlight = null;
    this.opts.persona?.release();
    await this.deliver(failed, { waitForWaiters: false });
    this.afterReport();
  }

  /**
   * Boot hook, called once the collector serves. A finished restart not yet
   * reported is delivered to Persona; one still under way (its supervisor is
   * health-checking this very collector) is waited on and then delivered; one
   * whose supervisor is gone is failed and delivered. Outside a restart, the
   * install's commit is recorded as known-good once this collector's own
   * /health and Persona's state answer.
   */
  onCollectorReady(): Promise<void> {
    this.pickingUp = true;
    this.pickup = (async () => {
      let underRestart: boolean;
      let rerun: RestartRecord | null = null;
      try {
        underRestart = await this.pickUpReport();
        // Taken while a redeploy arriving now is still coalesced (pickingUp), so none is lost.
        rerun = this.takeRerun();
      } finally {
        this.pickingUp = false;
      }
      // Before recordOwnHealth: the coalesced redeploy is about a commit
      // merged after this collector loaded its code.
      if (rerun) {
        this.rerun = this.rerunIfMoved(rerun);
        await this.rerun;
      }
      if (!underRestart && !this.inFlight) await this.recordOwnHealth();
      if (!this.inFlight) {
        this.deferred = this.runDeferredRedeploy().catch((err) => console.error("[restart] deferred redeploy failed:", err));
        await this.deferred;
      }
    })().catch((err) => console.error("[restart] report pickup failed:", err));
    return this.pickup;
  }

  /**
   * Logs to redeploy.log the outcome of a full restart standup-redeploy.ts
   * issued but was stopped before it could log (its pid is gone): this
   * collector, healthy, is what came back. Left to the script while it runs.
   */
  private resolveFullRestartPending(loaded: string | undefined): void {
    const { dataDir, exec } = this.opts;
    const pending = readFullRestartPending(dataDir);
    if (!pending || exec.isAlive(pending.pid)) return;
    const on = !!loaded && sameCommit(loaded, pending.head);
    const line = on
      ? `full restart (${pending.why}) issued at ${pending.at}: the collector leader (pid ${this.pid}) came back healthy on ${short(pending.head)}; the redeploy script stopped before it logged this`
      : `full restart (${pending.why}) issued at ${pending.at} to ${short(pending.head)}: the collector leader (pid ${this.pid}) came back healthy on ${short(loaded)}, not ${short(pending.head)}; the redeploy script stopped before it logged an outcome`;
    appendRedeployLog(redeployLogPath(dataDir), line, new Date(exec.now()));
    clearFullRestartPending(dataDir);
    console.log(`[restart] ${line}`);
  }

  /**
   * The report part of onCollectorReady. True when this collector came up
   * inside a restart its supervisor was still carrying out — that supervisor,
   * not this collector, decides what is known-good.
   */
  private async pickUpReport(): Promise<boolean> {
    const record = this.current();
    if (record && !isFinal(record) && this.inFlight?.id !== record.id) {
      const pid = record.supervisorPid;
      if (pid !== undefined && this.opts.exec.isAlive(pid)) {
        await this.awaitSupervisor(record.id, pid);
        return true;
      }
      const error =
        record.phase === "scheduled" || record.phase === "quiescing" || record.phase === "handed_off"
          ? "the collector restarted before the restart supervisor took over"
          : "the restart supervisor stopped before it finished";
      const failed: RestartRecord = { ...record, phase: "done", outcome: "failed", error, finishedAt: new Date(this.opts.exec.now()).toISOString() };
      delete failed.nonceHash;
      if (writeRecordIfCurrent(this.recordPath, failed)) await this.deliver(failed);
    } else if (record && isFinal(record) && !record.delivered) {
      await this.deliver(record);
    }
    return false;
  }

  /**
   * Waits for a supervisor to finish the restart, up to its worst-case
   * timeline. Giving up, it stops the supervisor (when `ps` shows it is one)
   * and reports the restart failed; the supervisor's own save refuses to
   * overwrite that, so the owner never gets two contradictory reports.
   */
  private async awaitSupervisor(id: string, pid: number): Promise<void> {
    const { exec } = this.opts;
    const deadline = exec.now() + (this.opts.pickupTimeoutMs ?? worstCaseMs(timingsFromEnv()) + 60_000);
    while (!this.stopped) {
      await exec.sleep(this.opts.pollMs ?? 2_000);
      const record = readRecord(this.recordPath);
      if (!record || record.id !== id) return;
      if (isFinal(record)) {
        if (!record.delivered) await this.deliver(record);
        return;
      }
      const alive = exec.isAlive(pid);
      if (!alive || exec.now() >= deadline) {
        if (alive && (await isRestartSupervisor(exec, pid, this.recordPath))) exec.kill(pid, "SIGTERM");
        const latest = readRecord(this.recordPath);
        if (latest?.id === id && isFinal(latest)) {
          if (!latest.delivered) await this.deliver(latest);
          return;
        }
        const failed: RestartRecord = {
          ...(latest?.id === id ? latest : record),
          phase: "done",
          outcome: "failed",
          error: alive ? "the restart supervisor did not finish in time and was stopped" : "the restart supervisor stopped before it finished",
          finishedAt: new Date(exec.now()).toISOString(),
        };
        if (writeRecordIfCurrent(this.recordPath, failed)) await this.deliver(failed);
        return;
      }
    }
  }

  /**
   * Records the install's HEAD as known-good once this collector's own
   * /health answers and, when Persona runs here, its state route does too:
   * a commit whose Persona is broken is not a rollback target. Not on a
   * dirty tree (uncommitted or untracked files): HEAD then isn't all that
   * runs, and checking it out again would not bring this back. With the
   * commit it loaded known (`loadedHead`), that is the one recorded, and
   * only while HEAD still is it: a tree moved since boot says nothing about
   * the one this collector loaded. A collector the leader file names with a
   * slot records its commit as one that ran behind the gateway.
   */
  private async recordOwnHealth(): Promise<void> {
    const { exec } = this.opts;
    for (let i = 0; i < 30 && !this.stopped; i++) {
      if ((await this.ownHealthOk()) && (!this.opts.persona || (await this.personaStateOk()))) {
        const leaderNow = readLeaderFile(this.opts.dataDir);
        this.resolveFullRestartPending(this.opts.loadedHead ?? (leaderNow?.pid === this.pid ? leaderNow.head : undefined));
        const dirty = await gitDirtyFiles(exec, this.opts.installDir);
        if (dirty === null || dirty.length > 0) {
          console.log(`[restart] not recording this commit as known-good: ${dirty === null ? "git status failed" : `the install has ${dirty.length} uncommitted or untracked file(s)`}`);
          return;
        }
        const head = await gitHead(exec, this.opts.installDir);
        const leader = readLeaderFile(this.opts.dataDir);
        const ours = leader?.pid === this.pid ? leader : null;
        const loaded = this.opts.loadedHead ?? ours?.head;
        if (loaded && head !== loaded) {
          console.log(`[restart] not recording ${short(loaded)} as known-good: the install moved to ${short(head ?? undefined)} since this collector loaded it`);
          return;
        }
        const gateway = !!ours?.slot;
        if (head) recordGoodHead(this.opts.dataDir, head, new Date(exec.now()).toISOString(), { gateway });
        return;
      }
      await exec.sleep(this.opts.pollMs ?? 1_000);
    }
  }

  private async ownHealthOk(): Promise<boolean> {
    const res = await this.opts.exec.httpGet(`${this.opts.collectorUrl}/health`, { timeoutMs: 3_000 });
    if (res.status !== 200) return false;
    const body = parseObject(res.body);
    return body?.status === "ok" && (body.pid === undefined || body.pid === this.pid);
  }

  private async personaStateOk(): Promise<boolean> {
    const res = await this.opts.exec.httpGet(`${this.opts.collectorUrl}/api/persona/state`, { timeoutMs: 5_000 });
    const runState = res.status === 200 ? parseObject(res.body)?.runState : undefined;
    return typeof runState === "string" && runState !== "disabled";
  }

  /**
   * Waits (up to reattachGraceMs) until every worker ask that was pending
   * before the restart and is still pending has its waiter re-attached, so
   * the report can tell a waiter that came back from one that didn't. Only
   * `ask_human` asks have a waiter (an MCP call, a floor hook, a self-fix
   * confirmation); permission prompts and idle notices have none.
   */
  private async awaitWaiters(before: PendingSnapshot): Promise<void> {
    const { exec } = this.opts;
    const deadline = exec.now() + (this.opts.reattachGraceMs ?? 15_000);
    const waiting = () =>
      (before.asks ?? []).filter((id) => {
        const ask = getAsk(this.opts.db, id);
        return ask?.status === "pending" && ask.kind === "ask_human" && !this.reattached.has(id);
      });
    while (!this.stopped && waiting().length > 0 && exec.now() < deadline) {
      await exec.sleep(Math.min(this.opts.pollMs ?? 500, 500));
    }
  }

  /**
   * Wakes Persona with the outcome in the thread that asked; kept undelivered
   * while Persona is off. After a real restart (`waitForWaiters`), the waiters
   * of pending asks get a grace period to re-attach first.
   */
  private async deliver(record: RestartRecord, opts: { waitForWaiters?: boolean } = {}): Promise<void> {
    this.delivering++;
    try {
      await this.deliverOnce(record, opts);
    } finally {
      this.delivering--;
    }
  }

  private async deliverOnce(record: RestartRecord, opts: { waitForWaiters?: boolean }): Promise<void> {
    const latest = readRecord(this.recordPath);
    if (latest?.id === record.id && latest.delivered) return;
    if (opts.waitForWaiters !== false) await this.awaitWaiters(record.pendingBefore ?? emptySnapshot());
    const again = readRecord(this.recordPath);
    if (again?.id === record.id && again.delivered) return;
    const survival = compareSnapshot(
      this.opts.db,
      this.opts.owner,
      record.pendingBefore ?? emptySnapshot(),
      this.reattached,
      new Set(this.opts.orphanedAsks ?? [])
    );
    // The supervisor may have flagged the record on disk for a rerun; the flag is kept.
    const onDisk = readRecord(this.recordPath);
    const flag = onDisk?.id === record.id && onDisk.rerunRequested ? { rerunRequested: true } : {};
    // A coalesced redeploy that won't run (it needs a full restart) is said in this report.
    const skipped = isFinal(record) && (flag.rerunRequested || this.rerunWanted(record)) ? await this.skippedRerunNote(record) : null;
    if (skipped && !(record.warnings ?? []).includes(skipped)) {
      record = { ...record, fullRestartNeeded: true, warnings: [...(record.warnings ?? []), skipped] };
    }
    const persona = this.opts.persona;
    if (!persona) {
      console.log(`[restart] ${record.id} finished (${record.outcome}); Persona is off, so its report waits`);
      writeRecordIfCurrent(this.recordPath, { ...record, survival, ...flag });
      return;
    }
    const logTail = untrustedDetail(record);
    persona.enqueue(
      "system",
      {
        type: "restart_report",
        restartId: record.id,
        outcome: record.outcome ?? "failed",
        summary: formatRestartReport(record, survival),
        ...(logTail ? { logTail } : {}),
      },
      { threadId: record.threadId, coalesceKey: `restart:${record.id}` }
    );
    writeRecordIfCurrent(this.recordPath, { ...record, survival, delivered: true, ...flag });
  }
}

/**
 * The process-controlled text of a report — git's output from a failed
 * rollback, the files that refused one, the logs' tail of a failed restart —
 * travelling as the report's `logTail`, which Persona's prompt quotes as raw
 * untrusted data, never as part of the summary.
 */
export function untrustedDetail(record: RestartRecord): string | undefined {
  const parts: string[] = [];
  const rollback = record.rollback;
  if (rollback?.output) parts.push(`rollback checkout output: ${rollback.output}`);
  if (rollback?.files && (rollback.files.changed.length > 0 || rollback.files.untracked.length > 0)) {
    const list = (files: string[]) => (files.length > 0 ? files.join(", ") : "none");
    parts.push(`files that refused the rollback: changed: ${list(rollback.files.changed)}; untracked: ${list(rollback.files.untracked)}`);
  }
  if (record.outcome === "failed" && record.logTail) parts.push(record.logTail.split("\n").slice(-15).join("\n"));
  return parts.length > 0 ? parts.join("\n---\n") : undefined;
}

/**
 * Whether `pid` runs this install's restart supervisor: restart/cli.ts on
 * this data dir's record (`recordPath`, the argument every supervisor is
 * started with), so a reused pid running another install's supervisor —
 * or anything else — is never signalled.
 */
async function isRestartSupervisor(exec: RestartExec, pid: number, recordPath: string): Promise<boolean> {
  const info = await processInfo(exec, pid);
  if (!info || !/(?:^|[\s/])restart\/cli\.ts(?:\s|$)/.test(info.args)) return false;
  const args = info.args.split(/\s+/);
  return args.includes(recordPath) || args.some((a) => a.endsWith("current.json") && canonicalPath(a) === canonicalPath(recordPath));
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Pending state ───────────────────────────────────────────────────────────

/**
 * Ids of everything waiting on someone right now: what a restart must not
 * lose. Asks are those with a waiter (`ask_human`: worker questions, floor
 * holds, self-fix confirmations); a permission prompt or idle notice is a
 * notice of the session's state, re-raised from its events, not a wait.
 * Plan review notes are those with text: a rejection without feedback leaves
 * an empty remark only to mark the rejection as owed to a re-sent
 * submit_plan, with no note in it to lose.
 */
export function snapshotPending(db: Database, owner: string): PendingSnapshot {
  return {
    approvals: listPersonaApprovals(db, owner, "pending").map((a) => a.id),
    asks: getPendingAsks(db).filter((a) => a.kind === "ask_human").map((a) => a.id),
    plans: getPendingPlanApprovals(db).map((p) => p.id),
    planRemarks: listUndeliveredPlanReviewRemarks(db).filter((id) => {
      const remark = getPlanReviewRemark(db, id);
      return !!(remark?.feedback?.trim() || remark?.note?.trim());
    }),
    inbox: listPendingPersonaInbox(db, owner).map((i) => i.id),
  };
}

/** How one id stands now: still pending, gone, or settled with its status. */
type Standing = { kind: "pending" } | { kind: "missing" } | { kind: "settled"; status: string };

const PENDING: Standing = { kind: "pending" };
const MISSING: Standing = { kind: "missing" };
const settled = (status: string): Standing => ({ kind: "settled", status });

function standingOf(db: Database, category: PendingCategory, id: string): Standing {
  switch (category) {
    case "approvals": {
      const a = getPersonaApproval(db, id);
      return !a ? MISSING : a.status === "pending" ? PENDING : settled(a.status);
    }
    case "asks": {
      const a = getAsk(db, id);
      return !a ? MISSING : a.status === "pending" ? PENDING : settled(a.status);
    }
    case "plans": {
      const p = getPlanApproval(db, id);
      return !p ? MISSING : p.status === "awaiting_approval" ? PENDING : settled(p.status);
    }
    case "planRemarks": {
      const r = getPlanReviewRemark(db, id);
      return !r ? MISSING : r.delivered ? settled("delivered") : PENDING;
    }
    case "inbox": {
      const i = getPersonaInboxItem(db, id);
      return !i ? MISSING : i.status === "pending" || i.status === "processing" ? PENDING : settled(i.status);
    }
  }
}

/** The categories whose waiters re-attach after a restart. */
const REATTACHING: ReadonlySet<PendingCategory> = new Set<PendingCategory>(["asks", "plans"]);

/**
 * How each id recorded before the restart stands now: still pending (and, for
 * asks and plans, whether its waiter re-attached — `reattached`), settled with
 * the status it ended in, or missing. An ask in `orphaned` (timed out at boot,
 * its waiter unable to re-attach) is settled but counted apart.
 */
export function compareSnapshot(
  db: Database,
  _owner: string,
  before: PendingSnapshot,
  reattached: ReadonlySet<string> = new Set(),
  orphaned: ReadonlySet<string> = new Set()
): SurvivalReport {
  const report = {} as SurvivalReport;
  for (const category of PENDING_CATEGORIES) {
    const ids = before[category] ?? [];
    const entry: SurvivalCategory = { before: ids.length, pending: 0, reattached: [], settled: [], settledBy: {}, missing: [] };
    for (const id of ids) {
      const standing = standingOf(db, category, id);
      if (standing.kind === "pending") {
        entry.pending++;
        if (REATTACHING.has(category) && reattached.has(id)) entry.reattached.push(id);
      } else if (standing.kind === "settled") {
        entry.settled.push(id);
        if (category === "asks" && orphaned.has(id)) (entry.orphaned ??= []).push(id);
        else entry.settledBy[standing.status] = (entry.settledBy[standing.status] ?? 0) + 1;
      } else {
        entry.missing.push(id);
      }
    }
    report[category] = entry;
  }
  return report;
}

const CATEGORY_LABEL: Record<PendingCategory, string> = {
  approvals: "approval cards",
  asks: "worker asks",
  plans: "plans awaiting review",
  planRemarks: "plan review notes",
  inbox: "inbox items",
};

const STATUS_LABEL: Record<string, string> = { timeout: "timed out", awaiting_plan: "sent back for a new plan" };

function seconds(fromIso: string, toIso: string | undefined): string {
  const ms = Date.parse(toIso ?? "") - Date.parse(fromIso);
  return Number.isFinite(ms) ? `${Math.round(ms / 100) / 10}s` : "?";
}

/** The survival part of a report: what was pending before, and how each kind fared. */
export function formatSurvival(survival: SurvivalReport): string {
  const lines: string[] = [];
  for (const category of PENDING_CATEGORIES) {
    const s = survival[category];
    if (!s || s.before === 0) continue;
    const bits = [`${s.pending}/${s.before} still pending`];
    const back = s.reattached?.length ?? 0;
    if (category === "asks" && s.pending > 0) {
      if (back > 0) bits.push(`${back} re-attached by their worker`);
      if (s.pending > back) bits.push(`${s.pending - back} not re-attached (yet)`);
    } else if (category === "plans" && back > 0) {
      bits.push(`${back} re-sent by their worker`);
    }
    const orphaned = s.orphaned?.length ?? 0;
    const ended = Object.entries(s.settledBy ?? {}).map(([status, n]) => `${n} ${STATUS_LABEL[status] ?? status}`);
    if (ended.length > 0) bits.push(`${ended.join(", ")} meanwhile`);
    else if (s.settled.length > orphaned) bits.push(`${s.settled.length - orphaned} settled meanwhile`);
    if (orphaned > 0) {
      bits.push(`${orphaned} timed out at boot (raised without a request id, so their waiter could not re-attach and has to ask again)`);
    }
    if (s.missing.length > 0) bits.push(`${s.missing.length} LOST (${s.missing.slice(0, 5).join(", ")})`);
    lines.push(`${CATEGORY_LABEL[category]} ${bits.join(", ")}`);
  }
  return lines.length > 0 ? `Pending state across the restart: ${lines.join("; ")}.` : "Nothing was pending across the restart.";
}

function secondsOf(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/**
 * What the restart cost the console's users, in a sentence: measured from the
 * gateway's counters when one fronted the collector before and after; else
 * only the gap, during which the UI and API were unreachable. "Users saw no
 * errors" is said only of a restart that ended ok with both counter reads,
 * no failed request, and nothing still held; otherwise only what was counted.
 * Behind a gateway, a gap of at least GAP_WARN_FRACTION of its hold
 * (`holdMs`) is warned about, citing the boot time the new leader's /health
 * reported, if any.
 */
export function formatUserImpact(record: RestartRecord, holdMs: number = gatewayHoldMs()): string | undefined {
  const u: UserImpact | undefined = record.userImpact;
  if (record.leaderUntouched) return "Users were unaffected: the running collector was never stopped.";
  if (!u) return undefined;
  const text = describeUserImpact(record, u);
  const gap = u.gapMs ?? 0;
  const fronted = u.gatewayMeasured || record.mode === "handoff";
  if (!fronted || gap < GAP_WARN_FRACTION * holdMs) return text;
  const boot = u.bootMs !== undefined ? `; the collector that took over reported booting in ${secondsOf(u.bootMs)} (its /health bootMs)` : "";
  const warning =
    `Warning: no collector served for ${secondsOf(gap)}, ${gap >= holdMs ? "longer than" : "close to"} the gateway's ${secondsOf(holdMs)} hold, ` +
    `after which the requests it holds fail${boot}.`;
  return text ? `${text} ${warning}` : warning;
}

/** How long the gateway holds a request while no collector serves, when STANDUP_GATEWAY_HOLD_MS is unset. */
export const DEFAULT_GATEWAY_HOLD_MS = 60_000;

/** A restart gap at least this fraction of the gateway's hold is warned about in its report. */
export const GAP_WARN_FRACTION = 0.8;

/** The gateway's hold: STANDUP_GATEWAY_HOLD_MS, else DEFAULT_GATEWAY_HOLD_MS. */
export function gatewayHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number.parseInt(env.STANDUP_GATEWAY_HOLD_MS ?? "", 10);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_GATEWAY_HOLD_MS;
}

function describeUserImpact(record: RestartRecord, u: UserImpact): string | undefined {
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (u.gatewayMeasured) {
    const held = u.heldRequests ?? 0;
    const stillHeld = u.heldNow ?? 0;
    const failed = u.failedRequests ?? 0;
    const wait = held > 0 ? `requests were held up to ${u.maxHoldIsBound ? "about " : ""}${secondsOf(u.maxHoldMs ?? 0)} (${held} held)` : "no request had to wait";
    const lead =
      failed > 0
        ? `${plural(failed, "request")} failed during the restart; ${wait}.`
        : record.outcome === "ok" && stillHeld === 0
          ? `Users saw no errors; ${wait}.`
          : `The gateway counted no failed request by the end of the restart; ${wait}.`;
    const pending = stillHeld > 0 ? ` ${plural(stillHeld, "request")} ${stillHeld === 1 ? "was" : "were"} still held when it was measured, not yet counted either way.` : "";
    const ws = (u.wsReconnects ?? 0) > 0 ? ` ${plural(u.wsReconnects!, "live connection")} reconnected.` : "";
    const gap = u.gapMs !== undefined && u.gapMs > 0 ? ` No collector served for ${secondsOf(u.gapMs)}.` : "";
    const since = u.gatewayRestarted ? " (The gateway itself restarted meanwhile, so these count only since it did.)" : "";
    return `${lead}${pending}${ws}${gap}${since}`;
  }
  if (record.mode === "handoff" && u.gapMs !== undefined && u.gapMs > 0) {
    return `The gateway's counters could not be read before and after, so what users saw is not measured; no collector served for about ${secondsOf(u.gapMs)}.`;
  }
  if (u.gapMs !== undefined && u.gapMs > 0) {
    return `No gateway fronted the collector, so the UI and API were unreachable for about ${secondsOf(u.gapMs)} while it restarted.`;
  }
  return undefined;
}

/** What a report says of an install a rollback left on a detached HEAD: redeploys are refused until the branch is checked out again. */
function detachedNote(record: RestartRecord): string {
  return (
    `The install is checked out detached at ${short(record.rollback?.head)}, so redeploys are refused until ` +
    (record.branchBefore
      ? `\`git -C ${record.installDir} checkout ${record.branchBefore}\`.`
      : `the install is checked out on its default branch again (\`git -C ${record.installDir} checkout <branch>\`).`)
  );
}

/**
 * The report Persona relays to the owner: how pending state survived first,
 * then the outcome and health checks. Process output (the logs' tail) is not
 * part of it — it travels as the report's separate `logTail`, rendered as
 * untrusted data.
 */
export function formatRestartReport(record: RestartRecord, survival: SurvivalReport): string {
  const parts: string[] = [formatSurvival(survival)];
  const last = record.attempts[record.attempts.length - 1];
  const checks = (attempt: typeof last) =>
    attempt ? attempt.checks.map((c) => `${c.name} ${c.ok ? "ok" : c.required ? "FAILED" : "not ok"} (${c.detail})`).join("; ") : "no health check ran";
  const took = `took ${seconds(record.requestedAt, record.finishedAt)}`;
  const preflightFailed = record.preflight?.ok === false && record.leaderUntouched === true;
  if (record.outcome === "ok") {
    parts.push(`OK — Standup is running ${short(record.headBefore)}${record.branchBefore ? ` (${record.branchBefore})` : ""}, ${record.mode}; ${took}. Health: ${checks(last)}.`);
  } else if (record.outcome === "rolled-back" && preflightFailed) {
    parts.push(
      `ROLLED BACK before the switch — the new code on ${short(record.headBefore)} did not load in the standby collector (${record.preflight!.detail}), so the running collector was never stopped. ` +
        `The install was checked out detached at ${short(record.rollback?.head)}, the commit the running collector runs; ${took}.` +
        ` ${record.branchBefore ?? "The branch"} still points at ${short(record.headBefore)}: fix forward there, then \`git -C ${record.installDir} checkout ${record.branchBefore ?? "<branch>"}\` and restart again.`
    );
  } else if (record.outcome === "rolled-back") {
    const failed = record.attempts[0];
    parts.push(
      `ROLLED BACK — ${short(record.headBefore)} failed its health check (${checks(failed)}), so the install was checked out detached at the last good commit ${short(record.rollback?.head)}, which is healthy (${checks(last)}); ${took}.` +
        ` ${record.branchBefore ?? "The branch"} still points at ${short(record.headBefore)}: fix forward there, then \`git -C ${record.installDir} checkout ${record.branchBefore ?? "<branch>"}\` and restart again.`
    );
    if (record.rollback?.detached) parts.push(detachedNote(record));
  } else if (record.outcome === "failed" && preflightFailed && !record.supersededBy) {
    parts.push(
      `NOT RESTARTED — the new code did not load; nothing was restarted; the standby will keep failing until a fixed commit lands. ` +
        `The new code on ${short(record.headBefore)} did not load in the standby collector (${record.preflight!.detail}), so the running collector` +
        `${record.leaderHead ? ` on ${short(record.leaderHead)}` : ""} was never stopped and keeps serving, and the install was left on ` +
        `${record.branchBefore ? `${record.branchBefore} at ` : ""}${short(record.headBefore)}, not checked out anywhere else; ${took}. ` +
        "Merging a fix redeploys it. Don't restart again on your own: a retry fails the same way. " +
        `Warning: ${short(record.headBefore)} stays checked out, so the next time the running collector exits (a crash, a full restart, a reboot) ` +
        "Standup boots that commit and fails the same way; land a fix soon, or check out a commit that loads."
    );
  } else if (record.supersededBy && record.leaderUntouched) {
    parts.push(
      `SUPERSEDED before the switch — ${short(record.supersededBy)} was checked out while the standby reloaded ${short(record.headBefore)}, so the running collector was never stopped and the install was left on ${short(record.supersededBy)}; ${took}. ` +
        "A redeploy of the newer commit is asked for once this report is out."
    );
  } else if (record.supersededBy) {
    parts.push(
      `SUPERSEDED — ${short(record.supersededBy)} was checked out while ${short(record.headBefore)} was being restarted, and the collector came back on ${short(record.supersededBy)}, so nothing was rolled back and the install was left on it; ${took}. ` +
        `It was not health-checked on ${short(record.supersededBy)}; a redeploy is asked for once this report is out, should HEAD have moved past it.`
    );
  } else {
    parts.push(`FAILED — ${record.error ?? "the restart did not complete"}.`);
    if (record.attempts.length > 0) parts.push(`Last health check: ${checks(last)}.`);
    const quoted = " (named in the report's quoted log section)";
    if (record.rollback?.refused) parts.push(`Rollback refused: ${record.rollback.refused}${record.rollback.files ? quoted : ""}.`);
    else if (record.rollback?.error) parts.push(`Rollback failed: ${record.rollback.error}${record.rollback.output ? "; git's output is in the report's quoted log section" : ""}.`);
    else if (record.rollback?.detached) parts.push(detachedNote(record));
    parts.push("Don't restart again on your own: a retry fails the same way. Tell the owner and leave the next step to them.");
  }
  const impact = formatUserImpact(record);
  if (impact) parts.push(impact);
  if (record.gatewayLog && record.attempts.some((a) => a.checks.some((c) => c.name === "gateway" && !c.ok))) {
    parts.push(`The gateway check failed; the gateway's log is ${record.gatewayLog}.`);
  }
  for (const attempt of record.attempts) {
    for (const note of attempt.notes) parts.push(`Note: ${note}.`);
  }
  for (const warning of record.warnings ?? []) parts.push(`Warning: ${warning}.`);
  parts.push(`Reason given: ${record.reason}`);
  return parts.join(" ");
}
