import { join } from "path";
import { collectorCwd } from "./exec.js";
import type { RestartRecord } from "./state.js";
import {
  RESTART_SCHEMA_VERSION,
  RestartPreempted,
  canonicalPath,
  isCurrentRecordPath,
  nonceMatches,
  readRecord,
  restartDir,
  writeRecord,
} from "./state.js";
import { GATEWAY_STATS_PATH, gatewayLogPath } from "./topology-files.js";

/** What a supervisor knows about itself, independently of any record. */
export interface SupervisorContext {
  /** The record path it was started with (argv). */
  recordPath: string;
  /** The nonce it read from stdin. */
  nonce: string;
  /** The collector's data dir, resolved the way the collector resolves it. */
  dataDir: string;
  /** The install this supervisor's own code sits in. */
  installDir: string;
  /** The runtime that starts a standalone collector (process.execPath). */
  execPath: string;
  /** The collector's own bind address (STANDUP_BIND_HOST), accepted beside the loopback names. */
  bindHost?: string;
  /** The web UI the install is configured with (STANDUP_WEB_URL), accepted beside a loopback UI. */
  webUrl?: string;
}

export type Authorization = { ok: true; record: RestartRecord } | { ok: false; error: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isCollectorUrl(url: string, bindHost: string | undefined): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (LOOPBACK_HOSTS.has(u.hostname) || (!!bindHost && u.hostname === bindHost));
  } catch {
    return false;
  }
}

/**
 * Whether `url` is a UI a restart may probe: an http(s) URL on a loopback
 * name, or exactly the configured web UI (`webUrl`, STANDUP_WEB_URL). Any
 * other host would let a restart request point the supervisor's probes at an
 * arbitrary server.
 */
export function isAllowedUiUrl(url: string, webUrl: string | undefined): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (LOOPBACK_HOSTS.has(u.hostname)) return true;
  if (!webUrl?.trim()) return false;
  try {
    return new URL(webUrl.trim()).href === u.href;
  } catch {
    return false;
  }
}

/**
 * Decides whether a supervisor may carry out the record it was pointed at.
 * The record must be the data dir's current record (no other path), be
 * waiting for a supervisor (`handed_off`, none recorded yet), name this
 * supervisor's own install and data dir, and carry the hash of the one-time
 * nonce the collector passed on stdin — which only the collector that wrote
 * the record knows. The collector's command line and cwd are not taken from
 * the record but derived from the install, and its logs from the data dir;
 * the URLs it probes must be the collector on a loopback name (or its own
 * bind address) and a loopback or configured UI (isAllowedUiUrl). A record
 * of another RESTART_SCHEMA_VERSION is refused. The authorized record drops
 * the nonce hash, so the nonce can't be used twice.
 */
export function authorizeSupervisor(ctx: SupervisorContext): Authorization {
  if (!isCurrentRecordPath(ctx.recordPath, ctx.dataDir)) {
    return { ok: false, error: `${ctx.recordPath} is not the current restart record of ${ctx.dataDir}` };
  }
  const record = readRecord(ctx.recordPath);
  if (!record) return { ok: false, error: `no readable restart record at ${ctx.recordPath}` };
  if (record.phase !== "handed_off" || record.supervisorPid !== undefined) {
    return { ok: false, error: `restart ${record.id} is not waiting for a supervisor (phase ${record.phase}${record.supervisorPid !== undefined ? `, supervisor ${record.supervisorPid}` : ""})` };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) return { ok: false, error: "the restart record's id is malformed" };
  if (record.schemaVersion !== RESTART_SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `restart ${record.id} was written as record schema ${record.schemaVersion ?? "(unversioned)"}, but this supervisor reads schema ${RESTART_SCHEMA_VERSION}; ` +
        "the collector that asked for it and this supervisor are different versions of Standup, so it was not carried out",
    };
  }
  if (!nonceMatches(ctx.nonce, record.nonceHash)) {
    return { ok: false, error: `restart ${record.id}: the nonce on stdin does not match the record` };
  }
  if (canonicalPath(record.dataDir) !== canonicalPath(ctx.dataDir)) {
    return { ok: false, error: `restart ${record.id} names data dir ${record.dataDir}, not ${ctx.dataDir}` };
  }
  if (canonicalPath(record.installDir) !== canonicalPath(ctx.installDir)) {
    return { ok: false, error: `restart ${record.id} names install ${record.installDir}, not this supervisor's ${ctx.installDir}` };
  }
  if (!isCollectorUrl(record.collectorUrl, ctx.bindHost?.trim() || undefined)) {
    return { ok: false, error: `restart ${record.id}: collector URL ${record.collectorUrl} is not this machine's collector` };
  }
  if (!isAllowedUiUrl(record.uiUrl, ctx.webUrl)) {
    return { ok: false, error: `restart ${record.id}: UI URL ${record.uiUrl} is neither a loopback URL nor the configured STANDUP_WEB_URL` };
  }
  if (!Number.isInteger(record.collectorPid) || record.collectorPid <= 1) {
    return { ok: false, error: `restart ${record.id}: collector pid ${record.collectorPid} is not a process to stop` };
  }
  const authorized: RestartRecord = {
    ...record,
    installDir: ctx.installDir,
    dataDir: ctx.dataDir,
    collector: { argv: [ctx.execPath, "run", "src/index.ts"], cwd: collectorCwd(ctx.installDir) },
    supervisorLog: join(restartDir(ctx.dataDir), `${record.id}.log`),
    collectorLog: join(restartDir(ctx.dataDir), `collector-${record.id}.log`),
    // The gateway is probed on the (already vetted) collector URL's origin, and its log named from the data dir.
    ...(record.gatewayStatsUrl !== undefined ? { gatewayStatsUrl: gatewayStatsUrlFor(record.collectorUrl) } : {}),
    gatewayLog: gatewayLogPath(ctx.dataDir),
  };
  delete authorized.nonceHash;
  return { ok: true, record: authorized };
}

/** The gateway's stats endpoint on the origin of `collectorUrl`, which the gateway fronts. */
export function gatewayStatsUrlFor(collectorUrl: string): string {
  return new URL(GATEWAY_STATS_PATH, collectorUrl).href;
}

/**
 * The supervisor's save: writes the record only while the one on disk is
 * still this run's — the same restart, not finished, and either still waiting
 * for a supervisor (the first save, which claims it) or claimed by `pid`.
 * Anything else means a collector gave up on this run (and reported it) or
 * another run took it, so the save throws RestartPreempted instead of
 * overwriting that outcome. A redeploy the collector coalesced into this
 * restart (`rerunRequested`, set on disk) is kept.
 */
export function guardedSave(recordPath: string, pid: number): (record: RestartRecord) => void {
  return (record) => {
    const disk = readRecord(recordPath);
    if (!disk || disk.id !== record.id) throw new RestartPreempted(`restart ${record.id}'s record was replaced`);
    if (disk.phase === "done") throw new RestartPreempted(`restart ${record.id} was already finished (${disk.outcome ?? "?"}) by another process`);
    const claimed = disk.supervisorPid;
    if (claimed === undefined ? disk.phase !== "handed_off" : claimed !== pid) {
      throw new RestartPreempted(`restart ${record.id} belongs to supervisor ${claimed ?? "?"} (phase ${disk.phase})`);
    }
    writeRecord(recordPath, disk.rerunRequested ? { ...record, rerunRequested: true } : record);
  };
}
