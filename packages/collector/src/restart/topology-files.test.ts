import { describe, expect, test } from "bun:test";
import * as shared from "@standup/shared/topology";
import {
  DEV_RESPAWN_SIGNAL,
  GATEWAY_STATS_PATH,
  devFilePath,
  gatewayFilePath,
  gatewayLogPath,
  leaderFilePath,
  slotPorts,
  standbyDirPath,
  standbyFilePath,
} from "./topology-files.js";

describe("the supervisor's topology files", () => {
  test("are the shared topology's paths", () => {
    expect(GATEWAY_STATS_PATH).toBe(shared.GATEWAY_STATS_PATH);
    expect(leaderFilePath("/d")).toBe(shared.leaderFilePath("/d"));
    expect(standbyFilePath("/d")).toBe(shared.standbyFilePath("/d"));
    expect(standbyDirPath("/d")).toBe(shared.standbyDirPath("/d"));
    expect(gatewayLogPath("/d")).toBe(shared.gatewayLogPath("/d"));
    expect(gatewayFilePath("/d")).toBe(shared.gatewayFilePath("/d"));
    expect(devFilePath("/d")).toBe(shared.devFilePath("/d"));
    expect(DEV_RESPAWN_SIGNAL).toBe(shared.DEV_RESPAWN_SIGNAL);
    for (const slot of shared.COLLECTOR_SLOTS) expect(slotPorts(7777, 7778, slot)).toEqual(shared.slotPorts(7777, 7778, slot));
  });
});
