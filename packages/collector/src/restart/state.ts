import { createHash, timingSafeEqual } from "crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import type { GatewayStats } from "@standup/shared/topology";

/*
 * The restart record and the known-good commit history live as JSON files in
 * `<data dir>/restart/` (the directory of the collector's SQLite file), not in
 * the database: the restart supervisor reads and writes them while no
 * collector is running, and must not contend with one booting on the same DB.
 *
 *   current.json    the latest restart, written by the collector that asked
 *                   for it, then by the supervisor, then by the collector that
 *                   delivers its report
 *   last-good.json  commits the install booted and passed health on, newest first
 *   history.json    when recent restarts were asked for and on which commit,
 *                   newest first (the restart rate limit reads it)
 *   refusals.json   refused redeploys, newest first, and when each kind of
 *                   refusal was last told to Persona
 *   rerun.json      a redeploy coalesced into the restart it names, written
 *                   by the collector and consumed by the one that reports it
 *   deferred-redeploy.json  a redeploy the hourly cap refused, run once the
 *                   window frees
 *   full-restart-pending.json  a full restart standup-redeploy.ts issued and
 *                   has not logged the outcome of yet
 *   redeploy.log    every redeploy outcome, one timestamped line each
 *   <id>.log        the supervisor's own log
 *   collector-<id>.log  output of a collector the supervisor started itself
 *   bin/<id>/       the copy of the supervisor's code a restart runs (see snapshot.ts)
 */

/**
 * The shape of RestartRecord this code reads and writes. A supervisor refuses
 * a record of another version: it was written by a collector whose idea of the
 * record differs from the supervisor's own.
 */
export const RESTART_SCHEMA_VERSION = 3;

/**
 * `supervised`: dev.ts brings a stopped collector back; `standalone`: the
 * supervisor starts it; `handoff`: dev.ts runs two collector slots behind the
 * gateway, and the warm standby takes over from the leader (exercised end to
 * end by scripts/zero-downtime-check.ts).
 */
export type RestartMode = "supervised" | "standalone" | "handoff";

/** Who asked for a restart: Persona (restart_standup), or the post-merge redeploy hook. */
export type RestartSource = "persona" | "redeploy";

/**
 * Where a restart stands. `scheduled` → `quiescing` (Persona finishes its turn)
 * → `handed_off` (the supervisor is spawned) → (`preflight`, handoff mode: the
 * standby reloads the new code) → `stopping` → `starting` → `checking` →
 * (`rolling_back` → `starting` → `checking`) → `done`.
 */
export type RestartPhase =
  | "scheduled"
  | "quiescing"
  | "handed_off"
  | "preflight"
  | "stopping"
  | "starting"
  | "checking"
  | "rolling_back"
  | "done";

/** `ok`: the new code is up; `rolled-back`: the previous good commit is up; `failed`: neither. */
export type RestartOutcome = "ok" | "rolled-back" | "failed";

/** Ids of what was waiting when the collector stopped, compared after it is back. */
export interface PendingSnapshot {
  approvals: string[];
  asks: string[];
  plans: string[];
  planRemarks: string[];
  inbox: string[];
}

export type PendingCategory = keyof PendingSnapshot;

export const PENDING_CATEGORIES: readonly PendingCategory[] = ["approvals", "asks", "plans", "planRemarks", "inbox"];

/** One health probe of a restart attempt. */
export interface HealthCheck {
  /** `preflight`: a standby loaded the code (handoff mode); `gateway`: the gateway's stats answer. */
  name: "preflight" | "collector" | "persona" | "ui" | "gateway";
  ok: boolean;
  /** A failed required check fails the attempt; an optional one is only reported. */
  required: boolean;
  detail: string;
  ms: number;
}

/** One bring-up of the collector on one commit. */
export interface RestartAttempt {
  head: string;
  mode: RestartMode;
  startedAt: string;
  finishedAt?: string;
  /** The collector that answered /health, or the one the supervisor started. */
  collectorPid?: number;
  checks: HealthCheck[];
  ok: boolean;
  notes: string[];
}

/** How each category of pending state fared across the restart. */
export interface SurvivalCategory {
  before: number;
  /** Still pending after the restart. */
  pending: number;
  /** Still pending, and the waiter that raised it is attached again (asks and plans). */
  reattached: string[];
  /** Settled meanwhile (answered, decided, delivered) — present, no longer pending. */
  settled: string[];
  /** How the settled ones ended, by their status (`answered`, `timeout`, `cancelled`, …). */
  settledBy: Record<string, number>;
  /** Gone entirely: these did not survive. */
  missing: string[];
  /**
   * Timed out when the collector booted, because their waiter could not
   * re-attach (asks raised without a request id); also in `settled`, not in
   * `settledBy`.
   */
  orphaned?: string[];
}

export type SurvivalReport = Record<PendingCategory, SurvivalCategory>;

/**
 * What the restart cost the console's users. Gateway counters are cumulative,
 * so the held, failed and reconnect counts are the difference between the
 * stats taken when the restart was asked for and when it finished.
 */
export interface UserImpact {
  /** From the collector's (the leader's) SIGTERM until a new collector answered /health. */
  gapMs?: number;
  /** Requests the gateway held while no collector served. */
  heldRequests?: number;
  /**
   * The longest hold. The gateway keeps only its all-time longest, so when
   * that grew during the restart it is the restart's; otherwise no hold of
   * the restart's outlasted the previous all-time longest or the gap, and the
   * smaller of those is reported with `maxHoldIsBound`.
   */
  maxHoldMs?: number;
  /** maxHoldMs is an upper bound, not a measured hold. */
  maxHoldIsBound?: boolean;
  /** Requests the gateway failed (hold timeout, held-request cap, upstream reset). */
  failedRequests?: number;
  /** WebSocket connections the collector closed, which clients reconnected. */
  wsReconnects?: number;
  /** A gateway answered before and after, so the counts above are measured. */
  gatewayMeasured: boolean;
  /** The gateway itself restarted meanwhile: the counts are since it started. */
  gatewayRestarted?: boolean;
  /** Requests the gateway was still holding when the counters were read after the restart. */
  heldNow?: number;
  /** How long the collector that ended the gap took to boot, as its /health reported (`bootMs`). */
  bootMs?: number;
}

/** The standby's reload of the new code (handoff mode), before the leader is touched. */
export interface PreflightResult {
  ok: boolean;
  /** The standby that loaded the code, when one did. */
  standbyPid?: number;
  detail: string;
  ms: number;
}

export interface RestartRecord {
  id: string;
  /** RESTART_SCHEMA_VERSION of the collector that wrote it; absent on records older than versioning. */
  schemaVersion?: number;
  requestedAt: string;
  requestedBy: string;
  reason: string;
  /** The Persona thread the report goes to; the console thread when absent. */
  threadId?: string;
  /** The Persona turn batch that asked for it; the same batch asking again is the same restart. */
  batchKey?: string;
  /** Absent on records from before redeploys: Persona. */
  source?: RestartSource;
  /**
   * One more redeploy runs once this restart is done and reported, if HEAD
   * moved past what it deployed: set by the supervisor (a merge superseded
   * it) or when the record was written. A redeploy coalesced later is
   * recorded in rerun.json instead (requestRerun).
   */
  rerunRequested?: boolean;
  /**
   * dev.ts, the gateway or their shared topology (FULL_RESTART_PATHS)
   * changed since dev.ts started (dev.json `head`): this restart doesn't load
   * them, and a redeploy coalesced into it is not run, since only a full
   * restart would. A warning on the record says so.
   */
  fullRestartNeeded?: boolean;
  phase: RestartPhase;
  outcome?: RestartOutcome;
  installDir: string;
  dataDir: string;
  mode: RestartMode;
  /** `scripts/dev.ts`, when it supervises the collector. */
  devPid?: number;
  /** A process between dev.ts and the collector (`bun run dev`), which exits with it. */
  wrapperPid?: number;
  /** The collector being restarted (in handoff mode, the leader). */
  collectorPid: number;
  /** Handoff mode: the leader in collector-leader.json, which is collectorPid. */
  leaderPid?: number;
  /** Handoff mode: the commit the leader booted on (collector-leader.json `head`). */
  leaderHead?: string;
  /** Handoff mode: the warm standby in collector-standby.json when the restart was asked for. */
  standbyPid?: number;
  /** The gateway's stats endpoint, on the collector URL's origin; set when a gateway answered. */
  gatewayStatsUrl?: string;
  /** The gateway's counters when the restart was asked for. */
  gatewayBefore?: GatewayStats;
  /** The gateway's counters when the restart finished. */
  gatewayAfter?: GatewayStats;
  /** The gateway's lifecycle log, cited when its check fails. */
  gatewayLog?: string;
  /** Handoff mode: the standby's reload of the new code. */
  preflight?: PreflightResult;
  /** Handoff mode: the restart ended without signalling the leader, which served throughout. */
  leaderUntouched?: boolean;
  userImpact?: UserImpact;
  /** How to start the collector when no supervisor brings it back. */
  collector: { argv: string[]; cwd: string };
  collectorUrl: string;
  uiUrl: string;
  /** The UI answered before the restart; only then does its check gate the outcome. */
  uiReachableBefore: boolean;
  /** Persona ran before the restart, so it must run after. */
  personaEnabled: boolean;
  headBefore: string;
  branchBefore?: string;
  /** The newest known-good commit other than headBefore: the rollback target. */
  rollbackHead?: string;
  /** Why no rollback target was chosen although known-good commits exist (e.g. none ran behind the gateway). */
  rollbackWithheld?: string;
  /**
   * Handoff mode: the install moved to this commit while the standby was
   * reloading (a merge landed mid-restart), so the standby loaded it rather
   * than headBefore and the restart stopped before the switch.
   */
  supersededBy?: string;
  supervisorPid?: number;
  /**
   * SHA-256 (hex) of the one-time nonce the collector hands its supervisor on
   * stdin; the supervisor refuses a record whose hash its nonce doesn't match,
   * and drops the hash when it takes over.
   */
  nonceHash?: string;
  supervisorLog: string;
  collectorLog: string;
  pendingBefore: PendingSnapshot;
  attempts: RestartAttempt[];
  /**
   * `refused` and `error` describe why a rollback did not happen; the
   * process-controlled parts — git's output, the files git status listed —
   * are kept apart in `output` and `files`, which a report quotes as
   * untrusted text only.
   */
  rollback?: {
    refused?: string;
    head?: string;
    error?: string;
    detached?: boolean;
    /** What git printed when the checkout failed. */
    output?: string;
    /** The files that made the rollback refuse: changed (tracked) and untracked. */
    files?: { changed: string[]; untracked: string[] };
  };
  /** Caveats about how the install runs, found when the restart was asked for (e.g. a collector under --watch). */
  warnings?: string[];
  logTail?: string;
  error?: string;
  finishedAt?: string;
  survival?: SurvivalReport;
  delivered?: boolean;
  updatedAt: string;
}

export interface GoodHead {
  head: string;
  at: string;
  /**
   * The commit passed health as a collector slot behind the gateway (handoff
   * topology). A handoff restart rolls back only to such a commit: an older
   * one may predate the slots and the gateway and could not take the leader lock.
   */
  gateway?: boolean;
}

const MAX_GOOD_HEADS = 10;

/**
 * The Standup install the running collector was started from:
 * `STANDUP_INSTALL_DIR`, else the repository root this file sits in
 * (packages/collector/src/restart → four levels up).
 */
export function resolveInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STANDUP_INSTALL_DIR?.trim();
  return override ? resolve(override) : resolve(import.meta.dir, "..", "..", "..", "..");
}

export function restartDir(dataDir: string): string {
  return join(dataDir, "restart");
}

export function currentRecordPath(dataDir: string): string {
  return join(restartDir(dataDir), "current.json");
}

export function lastGoodPath(dataDir: string): string {
  return join(restartDir(dataDir), "last-good.json");
}

export function historyPath(dataDir: string): string {
  return join(restartDir(dataDir), "history.json");
}

/** `path` with symlinks resolved when it exists, else just made absolute. */
export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Whether `path` is the data dir's current-record path, after resolving symlinks. */
export function isCurrentRecordPath(path: string, dataDir: string): boolean {
  return canonicalPath(path) === canonicalPath(currentRecordPath(dataDir));
}

/** The hex SHA-256 of a supervisor nonce, as stored in RestartRecord.nonceHash. */
export function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/** Whether `nonce` hashes to `hash`, compared in constant time. */
export function nonceMatches(nonce: string, hash: string | undefined): boolean {
  if (!nonce || !hash) return false;
  const a = Buffer.from(hashNonce(nonce), "utf8");
  const b = Buffer.from(hash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Thrown by a supervisor's save when the record on disk is no longer the one
 * it carries out — finished, replaced, or taken by another supervisor — so it
 * stops instead of overwriting an outcome someone else already reported.
 */
export class RestartPreempted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestartPreempted";
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Writes JSON through a temp file and a rename, so a reader never sees half a file. */
function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readRecord(path: string): RestartRecord | null {
  const record = readJson<RestartRecord>(path);
  return record && typeof record.id === "string" ? record : null;
}

export function writeRecord(path: string, record: RestartRecord): void {
  writeJsonAtomic(path, { ...record, updatedAt: new Date().toISOString() });
}

/**
 * Writes `record` only while the record on disk is still the same restart
 * (same id), so a collector reporting or giving up on one restart never
 * overwrites the record of another that replaced it. Returns whether it wrote.
 */
export function writeRecordIfCurrent(path: string, record: RestartRecord): boolean {
  const disk = readRecord(path);
  if (!disk || disk.id !== record.id) return false;
  writeRecord(path, record);
  return true;
}

/** Whether the restart has reached its outcome. */
export function isFinal(record: RestartRecord): boolean {
  return record.phase === "done";
}

/** Known-good commits, newest first. */
export function readGoodHeads(dataDir: string): GoodHead[] {
  const stored = readJson<{ heads?: GoodHead[] }>(lastGoodPath(dataDir));
  return Array.isArray(stored?.heads) ? stored!.heads.filter((h) => typeof h?.head === "string" && h.head) : [];
}

/**
 * Records `head` as the newest known-good commit (moving it to the front if
 * already listed), tagged `gateway` when it ran as a slot behind the gateway.
 */
export function recordGoodHead(dataDir: string, head: string, at = new Date().toISOString(), opts: { gateway?: boolean } = {}): GoodHead[] {
  const entry: GoodHead = { head, at, ...(opts.gateway ? { gateway: true } : {}) };
  const heads = [entry, ...readGoodHeads(dataDir).filter((h) => h.head !== head)].slice(0, MAX_GOOD_HEADS);
  writeJsonAtomic(lastGoodPath(dataDir), { heads });
  return heads;
}

/** One restart that was asked for. */
export interface RestartHistoryEntry {
  id: string;
  /** Epoch ms of the request. */
  at: number;
  headBefore: string;
  /** Absent: Persona. Redeploys don't count toward the hourly cap. */
  source?: RestartSource;
  /**
   * A refused request with this error, as some history files hold: nothing
   * ran, so it counts toward no cap or cooldown. Refusals are recorded in
   * refusals.json (recordRefusal), never here.
   */
  refused?: string;
}

const MAX_HISTORY = 50;

/** Recent restart requests, newest first. */
export function readRestartHistory(dataDir: string): RestartHistoryEntry[] {
  const stored = readJson<{ restarts?: RestartHistoryEntry[] }>(historyPath(dataDir));
  return Array.isArray(stored?.restarts)
    ? stored!.restarts.filter((r) => typeof r?.id === "string" && typeof r.at === "number" && typeof r.headBefore === "string")
    : [];
}

/** Records a restart request at the front of the history. */
export function appendRestartHistory(dataDir: string, entry: RestartHistoryEntry): RestartHistoryEntry[] {
  const restarts = [entry, ...readRestartHistory(dataDir).filter((r) => r.id !== entry.id)].slice(0, MAX_HISTORY);
  writeJsonAtomic(historyPath(dataDir), { restarts });
  return restarts;
}

/**
 * A refused redeploy. Recorded in refusals.json, apart from history.json, so
 * a run of refusals never crowds real restarts out of the window the rate
 * limits read.
 */
export interface RedeployRefusal {
  id: string;
  /** Epoch ms of the refusal. */
  at: number;
  headBefore: string;
  status: number;
  /** The refusal's class (status and reason, e.g. `409:detached`): what Persona's reports are keyed and rate-limited by. */
  kind: string;
  error: string;
}

/** refusals.json: the latest refusals, newest first, and when each kind was last told to Persona (epoch ms). */
export interface RefusalLog {
  refusals: RedeployRefusal[];
  reported: Record<string, number>;
}

const MAX_REFUSALS = 50;

export function refusalsPath(dataDir: string): string {
  return join(restartDir(dataDir), "refusals.json");
}

export function readRefusals(dataDir: string): RefusalLog {
  const stored = readJson<Partial<RefusalLog>>(refusalsPath(dataDir));
  const refusals = Array.isArray(stored?.refusals)
    ? stored!.refusals.filter((r) => typeof r?.id === "string" && typeof r.at === "number" && typeof r.kind === "string")
    : [];
  const reported: Record<string, number> = {};
  if (stored?.reported && typeof stored.reported === "object") {
    for (const [kind, at] of Object.entries(stored.reported)) if (typeof at === "number") reported[kind] = at;
  }
  return { refusals, reported };
}

/**
 * Records a refused redeploy at the front of refusals.json, and decides
 * whether it is told to Persona: only when its kind was not told within
 * `reportEveryMs` (and `reportable`); then that kind's report time is
 * moved to the refusal's.
 */
export function recordRefusal(
  dataDir: string,
  entry: RedeployRefusal,
  opts: { reportEveryMs: number; reportable: boolean }
): { report: boolean } {
  const log = readRefusals(dataDir);
  const last = log.reported[entry.kind];
  const report = opts.reportable && (last === undefined || entry.at - last >= opts.reportEveryMs || entry.at < last);
  const refusals = [entry, ...log.refusals.filter((r) => r.id !== entry.id)].slice(0, MAX_REFUSALS);
  const reported = report ? { ...log.reported, [entry.kind]: entry.at } : log.reported;
  writeJsonAtomic(refusalsPath(dataDir), { refusals, reported } satisfies RefusalLog);
  return { report };
}

/**
 * A redeploy the hourly redeploy cap refused, to run once the window frees
 * (`at`, epoch ms) if HEAD still differs from what the leader runs. One at
 * a time: a later refusal replaces it.
 */
export interface DeferredRedeploy {
  at: number;
  head: string;
  /** Epoch ms of the refusal that deferred it. */
  deferredAt: number;
}

export function deferredRedeployPath(dataDir: string): string {
  return join(restartDir(dataDir), "deferred-redeploy.json");
}

export function readDeferredRedeploy(dataDir: string): DeferredRedeploy | null {
  const d = readJson<DeferredRedeploy>(deferredRedeployPath(dataDir));
  return d && typeof d.at === "number" && typeof d.head === "string" ? d : null;
}

export function writeDeferredRedeploy(dataDir: string, deferred: DeferredRedeploy): void {
  writeJsonAtomic(deferredRedeployPath(dataDir), deferred);
}

export function clearDeferredRedeploy(dataDir: string): void {
  rmSync(deferredRedeployPath(dataDir), { force: true });
}

/**
 * A full restart (systemctl) standup-redeploy.ts issued and is waiting on.
 * The script removes it once it logs the outcome; when it was stopped first,
 * the collector that boots healthy (once `pid` is gone) or the next redeploy
 * logs the outcome instead.
 */
export interface FullRestartPending {
  /** The redeploy script that issued it. */
  pid: number;
  /** ISO time it was issued. */
  at: string;
  /** The commit it restarts onto. */
  head: string;
  why: string;
}

export function fullRestartPendingPath(dataDir: string): string {
  return join(restartDir(dataDir), "full-restart-pending.json");
}

export function readFullRestartPending(dataDir: string): FullRestartPending | null {
  const p = readJson<FullRestartPending>(fullRestartPendingPath(dataDir));
  return p && typeof p.pid === "number" && typeof p.head === "string" && typeof p.at === "string" ? p : null;
}

export function writeFullRestartPending(dataDir: string, pending: FullRestartPending): void {
  writeJsonAtomic(fullRestartPendingPath(dataDir), pending);
}

export function clearFullRestartPending(dataDir: string): void {
  rmSync(fullRestartPendingPath(dataDir), { force: true });
}

/** Whether two commit ids name the same commit, either possibly abbreviated (at least 7 hex digits). */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/** Where every redeploy outcome is recorded: `<dataDir>/restart/redeploy.log`. */
export function redeployLogPath(dataDir: string): string {
  return join(restartDir(dataDir), "redeploy.log");
}

/** Appends `line` to the redeploy log at `path`, timestamped; a log that can't be written is reported on stderr only. */
export function appendRedeployLog(path: string, line: string, now: Date = new Date()): void {
  try {
    ensureDir(dirname(path));
    appendFileSync(path, `${now.toISOString()} ${line.replace(/\n/g, " ")}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(`standup-redeploy: could not append to ${path}: ${(err as Error).message}`);
  }
}

/**
 * The newest known-good commit other than `current`: what a failed restart
 * rolls back to. With `gatewayOnly` (a handoff restart), only a commit that
 * passed health behind the gateway.
 */
export function rollbackTarget(heads: readonly GoodHead[], current: string, opts: { gatewayOnly?: boolean } = {}): string | undefined {
  return heads.find((h) => h.head !== current && (!opts.gatewayOnly || h.gateway === true))?.head;
}

/**
 * A redeploy coalesced into restart `id`: once that restart is done and
 * reported, the collector that reports it runs one more redeploy if HEAD
 * moved. Kept in its own file so the collector side never rewrites
 * current.json while a supervisor owns it.
 */
export interface RerunRequest {
  id: string;
  at: string;
}

export function rerunPath(dataDir: string): string {
  return join(restartDir(dataDir), "rerun.json");
}

/** Records that a redeploy was coalesced into restart `id`. */
export function requestRerun(dataDir: string, id: string, at = new Date().toISOString()): void {
  writeJsonAtomic(rerunPath(dataDir), { id, at } satisfies RerunRequest);
}

/** The pending rerun request, if any. */
export function readRerun(dataDir: string): RerunRequest | null {
  const r = readJson<RerunRequest>(rerunPath(dataDir));
  return r && typeof r.id === "string" ? r : null;
}

/** Removes the rerun request when it is for restart `id`; whether it was. */
export function clearRerun(dataDir: string, id: string): boolean {
  if (readRerun(dataDir)?.id !== id) return false;
  rmSync(rerunPath(dataDir), { force: true });
  return true;
}

/**
 * Files only a full restart (systemctl) loads: dev.ts's own code, the
 * gateway's, and the topology both share. A collector restart or handoff
 * leaves dev.ts and the gateway on the code they started with.
 */
export const FULL_RESTART_PATHS: readonly RegExp[] = [
  /^scripts\/dev\.ts$/,
  /^scripts\/dev-topology\.ts$/,
  /^packages\/gateway\//,
  /^packages\/shared\/src\/topology\.ts$/,
  /^packages\/shared\/src\/process-identity\.ts$/,
];

/** Those of `changed` (repository-relative paths) only a full restart loads. */
export function needsFullRestart(changed: readonly string[]): string[] {
  return changed.filter((path) => FULL_RESTART_PATHS.some((re) => re.test(path)));
}

/** The command that restarts dev.ts, the gateway and the collectors together. */
export const FULL_RESTART_COMMAND = "systemctl --user restart standup.service";

/**
 * The warning a restart carries when `files` (full-restart-only, see
 * FULL_RESTART_PATHS) changed `since` some commit (e.g. "dev.ts started on
 * 0123abcd"): only a full restart loads them.
 */
export function fullRestartWarning(files: readonly string[], since: string): string {
  const list = `${files.slice(0, 3).join(", ")}${files.length > 3 ? `, and ${files.length - 3} more` : ""}`;
  return (
    `${list} changed since ${since}; a collector restart doesn't load dev.ts or the gateway, ` +
    `so a full restart (\`${FULL_RESTART_COMMAND}\`) is needed to run them`
  );
}

export function emptySnapshot(): PendingSnapshot {
  return { approvals: [], asks: [], plans: [], planRemarks: [], inbox: [] };
}
