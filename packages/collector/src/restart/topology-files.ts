import { readFileSync } from "fs";
import { join } from "path";

/*
 * The parts of @standup/shared/topology the restart supervisor uses at
 * runtime. The supervisor runs from a copy of its own files (snapshot.ts),
 * which can't carry a package, so these live here; topology-files.test.ts
 * pins them to the shared module.
 */

/** Path of the gateway's stats endpoint, served on every gateway listener. */
export const GATEWAY_STATS_PATH = "/__gateway/stats";

export const leaderFilePath = (dataDir: string): string => join(dataDir, "collector-leader.json");
export const standbyFilePath = (dataDir: string): string => join(dataDir, "collector-standby.json");
/** Per-pid standby markers, `<pid>.json` for each collector of the data dir waiting on the lock. */
export const standbyDirPath = (dataDir: string): string => join(dataDir, "standby");
export const gatewayFilePath = (dataDir: string): string => join(dataDir, "gateway", "gateway.json");
export const gatewayLogPath = (dataDir: string): string => join(dataDir, "gateway", "gateway.log");
export const devFilePath = (dataDir: string): string => join(dataDir, "dev.json");

/** Signal dev.ts handles by resetting its crash-loop breakers and respawning the services it gave up on. */
export const DEV_RESPAWN_SIGNAL = "SIGUSR2";

/** The ports a collector slot binds: slot a at public+10000, slot b at public+20000. */
export function slotPorts(publicHttp: number, publicWs: number, slot: "a" | "b"): { http: number; ws: number } {
  const offset = slot === "a" ? 10_000 : 20_000;
  return { http: publicHttp + offset, ws: publicWs + offset };
}

/** Parsed JSON at `path`, or undefined when missing or unreadable. */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
