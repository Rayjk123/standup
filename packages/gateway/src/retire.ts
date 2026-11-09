/**
 * Identifying the gateways a new gateway may retire (the one gateway.json
 * names, and this install's own gateway found on the ports) and the dev.ts
 * that owns its data dir. A gateway only ever signals a live process whose
 * command line runs this install's gateway CLI: never another install's
 * gateway, and never a process that recycled a recorded pid.
 */
import { resolve } from "node:path";
import {
  commandLineOf,
  cwdOf,
  pidAlive,
  runsCliPath,
  runsDevScript,
  runsInstallDevScript,
  validPid,
} from "@standup/shared/process-identity";
import { devFilePath, readJsonFile, type DevInfo, type GatewayStats } from "@standup/shared/topology";

export interface OwnGatewayCheck {
  /** This gateway's data dir. */
  dataDir: string;
  /** This install's gateway CLI path(s), from cliPathsOf. */
  cliPaths: readonly string[];
  /** This process's pid; never retired. Default process.pid. */
  selfPid?: number;
  commandLine?: (pid: number) => string | undefined;
  alive?: (pid: number) => boolean;
  /** The dev.ts pid recorded in `dataDir`'s dev.json, if any. */
  devPidOf?: (dataDir: string) => number | undefined;
}

/** Whether `pid` is a live process other than this one running this install's gateway CLI. */
export function isOwnGatewayPid(pid: number, check: Pick<OwnGatewayCheck, "cliPaths" | "selfPid" | "commandLine" | "alive">): boolean {
  const alive = check.alive ?? pidAlive;
  if (!validPid(pid) || pid === (check.selfPid ?? process.pid) || !alive(pid)) return false;
  const cmdline = (check.commandLine ?? commandLineOf)(pid);
  return cmdline !== undefined && runsCliPath(cmdline, check.cliPaths);
}

/**
 * Whether a gateway found serving the ports is this install's own and so is
 * retired, not refused. One serving a different data dir is only retired
 * while no live dev.ts is recorded for that data dir: otherwise a second
 * dev.ts of this install still runs on it, and each would keep retiring the
 * other's gateway.
 */
export function isRetirableOwnGateway(stats: Pick<GatewayStats, "pid" | "dataDir">, check: OwnGatewayCheck): boolean {
  if (!isOwnGatewayPid(stats.pid, check)) return false;
  if (stats.dataDir === undefined || resolve(stats.dataDir) === resolve(check.dataDir)) return true;
  const alive = check.alive ?? pidAlive;
  const devPid = (check.devPidOf ?? recordedDevPid)(stats.dataDir);
  return devPid === undefined || !alive(devPid);
}

/** The dev.ts pid `dataDir`'s dev.json records, if any. */
export function recordedDevPid(dataDir: string): number | undefined {
  const pid = readJsonFile<Partial<DevInfo>>(devFilePath(dataDir))?.pid;
  return validPid(pid) ? pid : undefined;
}

/**
 * Whether the dev.ts `dataDir`'s dev.json records is running: a live pid
 * whose command line runs dev.ts, and with `installDir`, the dev.ts of that
 * install (process-identity runsInstallDevScript). A command line or working
 * directory that can't be read is given the benefit of the doubt, since a
 * false "gone" could take the ports down.
 */
export function recordedDevAlive(
  dataDir: string,
  deps: {
    installDir?: string;
    devPidOf?: (dataDir: string) => number | undefined;
    alive?: (pid: number) => boolean;
    commandLine?: (pid: number) => string | undefined;
    cwd?: (pid: number) => string | undefined;
  } = {},
): boolean {
  const pid = (deps.devPidOf ?? recordedDevPid)(dataDir);
  if (pid === undefined || !(deps.alive ?? pidAlive)(pid)) return false;
  const cmdline = (deps.commandLine ?? commandLineOf)(pid);
  if (cmdline === undefined) return true;
  if (deps.installDir === undefined) return runsDevScript(cmdline);
  return runsInstallDevScript(cmdline, deps.installDir, () => (deps.cwd ?? cwdOf)(pid)) !== false;
}
