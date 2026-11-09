import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VITE_PORT, devFilePath, publicPorts } from "@standup/shared/topology";
import { DEFAULT_HOLD_MS, DEFAULT_IDLE_EXIT_MS, DEFAULT_MAX_HELD, DEFAULT_ORPHAN_EXIT_MS, gatewayConfigFromEnv } from "./config.js";
import { isOwnGatewayPid, isRetirableOwnGateway, recordedDevAlive, recordedDevPid } from "./retire.js";
import { gatewaySourceFiles, gatewayVersion } from "./version.js";

describe("gatewayConfigFromEnv", () => {
  test("defaults", () => {
    expect(gatewayConfigFromEnv({})).toEqual({
      ports: publicPorts({}),
      vitePort: DEFAULT_VITE_PORT,
      holdMs: DEFAULT_HOLD_MS,
      maxHeld: DEFAULT_MAX_HELD,
      idleExitMs: DEFAULT_IDLE_EXIT_MS,
      orphanExitMs: DEFAULT_ORPHAN_EXIT_MS,
    });
    expect(DEFAULT_ORPHAN_EXIT_MS).toBe(8_000);
  });

  test("reads every setting and ignores junk", () => {
    const env = {
      STANDUP_WEB_PORT: "41001",
      COLLECTOR_PORT: "41002",
      WS_PORT: "41003",
      STANDUP_VITE_PORT: "41004",
      STANDUP_GATEWAY_HOLD_MS: "2500",
      STANDUP_GATEWAY_MAX_HELD: "7",
      STANDUP_GATEWAY_IDLE_EXIT_MS: "nope",
      STANDUP_GATEWAY_ORPHAN_EXIT_MS: "1500",
    };
    expect(gatewayConfigFromEnv(env)).toEqual({
      ports: { web: 41001, collector: 41002, ws: 41003 },
      vitePort: 41004,
      holdMs: 2500,
      maxHeld: 7,
      idleExitMs: DEFAULT_IDLE_EXIT_MS,
      orphanExitMs: 1500,
    });
  });

  test("without STANDUP_VITE_PORT, vite's port follows the public web port", () => {
    expect(gatewayConfigFromEnv({ STANDUP_WEB_PORT: "41010" }).vitePort).toBe(51010);
  });
});

describe("gatewayVersion", () => {
  test("covers the gateway sources and the topology contract, not tests", () => {
    const files = gatewaySourceFiles();
    expect(files.some((f) => f.endsWith("/gateway.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/cli.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("topology.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("process-identity.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/lifecycle.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(gatewayVersion()).toMatch(/^[0-9a-f]{64}$/);
    expect(gatewayVersion()).toBe(gatewayVersion());
  });

  test("changes when a source file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gateway-version-"));
    writeFileSync(join(dir, "a.ts"), "one");
    writeFileSync(join(dir, "a.test.ts"), "ignored");
    const before = gatewayVersion(dir);
    writeFileSync(join(dir, "a.test.ts"), "still ignored");
    expect(gatewayVersion(dir)).toBe(before);
    writeFileSync(join(dir, "a.ts"), "two");
    expect(gatewayVersion(dir)).not.toBe(before);
  });
});

describe("retiring a prior gateway", () => {
  describe("isOwnGatewayPid", () => {
    const CLI = "/opt/standup/packages/gateway/src/cli.ts";
    const PID = 2 ** 22 + 3;
    const own = (cmdline: string | undefined, alive = true) => ({
      cliPaths: [CLI],
      selfPid: 1,
      commandLine: () => cmdline,
      alive: () => alive,
    });

    test("only a live process running this install's CLI path", () => {
      expect(isOwnGatewayPid(PID, own(`/home/u/.bun/bin/bun run ${CLI}`))).toBe(true);
      // Another install's gateway, even with the same relative layout.
      expect(isOwnGatewayPid(PID, own("bun run /other/standup/packages/gateway/src/cli.ts"))).toBe(false);
      expect(isOwnGatewayPid(PID, own("bun run packages/gateway/src/cli.ts"))).toBe(false);
      expect(isOwnGatewayPid(PID, own(undefined))).toBe(false);
      expect(isOwnGatewayPid(PID, own(`bun run ${CLI}`, false))).toBe(false);
      expect(isOwnGatewayPid(1, own(`bun run ${CLI}`))).toBe(false);
      expect(isOwnGatewayPid(0, own(`bun run ${CLI}`))).toBe(false);
    });

    test("never targets this process or a real non-gateway process", () => {
      const cliPaths = [join(import.meta.dir, "cli.ts")];
      expect(isOwnGatewayPid(process.pid, { cliPaths })).toBe(false);
      // The test runner's parent is alive but is not a gateway.
      expect(isOwnGatewayPid(process.ppid, { cliPaths })).toBe(false);
      expect(isOwnGatewayPid(2 ** 22 + 12345, { cliPaths })).toBe(false);
    });
  });

  describe("recordedDevAlive", () => {
    test("a live pid running dev.ts; a dead, unrecorded or recycled pid is gone", () => {
      const deps = (cmdline: string | undefined, alive = true, recorded = true) => ({
        devPidOf: () => (recorded ? 42 : undefined),
        alive: () => alive,
        commandLine: () => cmdline,
      });
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts"))).toBe(true);
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts", false))).toBe(false);
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts", true, false))).toBe(false);
      expect(recordedDevAlive("/data", deps("vim notes.txt"))).toBe(false);
      // An unreadable command line keeps a live pid counted as dev.ts.
      expect(recordedDevAlive("/data", deps(undefined))).toBe(true);
    });

    test("with installDir, only that install's dev.ts counts", () => {
      const deps = (cmdline: string | undefined, cwd: string | undefined) => ({
        installDir: "/opt/standup",
        devPidOf: () => 42,
        alive: () => true,
        commandLine: () => cmdline,
        cwd: () => cwd,
      });
      expect(recordedDevAlive("/data", deps("bun /opt/standup/scripts/dev.ts", undefined))).toBe(true);
      expect(recordedDevAlive("/data", deps("bun /opt/other/scripts/dev.ts", "/opt/standup"))).toBe(false);
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts", "/opt/standup"))).toBe(true);
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts", "/opt/other"))).toBe(false);
      // What can't be read is given the benefit of the doubt.
      expect(recordedDevAlive("/data", deps("bun run scripts/dev.ts", undefined))).toBe(true);
      expect(recordedDevAlive("/data", deps(undefined, undefined))).toBe(true);
      expect(recordedDevAlive("/data", deps("vim notes.txt", "/opt/standup"))).toBe(false);
    });

    test("reads the pid from the data dir's dev.json", () => {
      const dir = mkdtempSync(join(tmpdir(), "gateway-dev-"));
      try {
        expect(recordedDevPid(dir)).toBeUndefined();
        writeFileSync(devFilePath(dir), JSON.stringify({ pid: 4242, installDir: "/i", startedAt: "t", gateway: true }));
        expect(recordedDevPid(dir)).toBe(4242);
        writeFileSync(devFilePath(dir), JSON.stringify({ pid: "4242" }));
        expect(recordedDevPid(dir)).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("isRetirableOwnGateway", () => {
    const CLI = "/opt/standup/packages/gateway/src/cli.ts";
    const OTHER_PID = 2 ** 22 + 1;
    const DEV_PID = 2 ** 22 + 2;
    const check = (opts: { cmdline?: string; alive?: number[]; devPid?: number } = {}) => ({
      dataDir: "/data/a",
      cliPaths: [CLI],
      commandLine: () => opts.cmdline ?? `bun run ${CLI}`,
      alive: (pid: number) => (opts.alive ?? [OTHER_PID]).includes(pid),
      devPidOf: () => opts.devPid,
    });

    test("this install's CLI is ours on the same, an unreported, or an abandoned data dir", () => {
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/a/" }, check())).toBe(true);
      expect(isRetirableOwnGateway({ pid: OTHER_PID }, check())).toBe(true);
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/old" }, check())).toBe(true);
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/old" }, check({ devPid: DEV_PID }))).toBe(true);
    });

    test("a data dir another live dev.ts still runs on stays foreign", () => {
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/old" }, check({ devPid: DEV_PID, alive: [OTHER_PID, DEV_PID] }))).toBe(false);
    });

    test("another install's CLI, a dead pid, or this process is never ours", () => {
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/a" }, check({ cmdline: "bun run /else/packages/gateway/src/cli.ts" }))).toBe(false);
      expect(isRetirableOwnGateway({ pid: OTHER_PID, dataDir: "/data/a" }, check({ alive: [] }))).toBe(false);
      expect(isRetirableOwnGateway({ pid: process.pid, dataDir: "/data/a" }, check({ alive: [process.pid] }))).toBe(false);
    });
  });
});
