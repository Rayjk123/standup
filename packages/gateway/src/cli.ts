#!/usr/bin/env bun
/**
 * The gateway process dev.ts spawns: `bun packages/gateway/src/cli.ts`, with
 * the environment config.ts reads (gatewayConfigFromEnv). The lifecycle
 * (publish gateway.json, refuse another install's gateway, retire this
 * install's previous one, bind, drain on SIGTERM/SIGINT, exit when orphaned
 * or idle) is lifecycle.ts runGateway; this file wires in the real process,
 * files, ports and clock. Lifecycle events and any uncaught error go to
 * gateway/gateway.log.
 *
 * Exit codes: 0 after a drain (signal, orphaned or idle), EXIT_BIND_FAILED
 * when the ports stay in use past the bind retry window, EXIT_FOREIGN_GATEWAY
 * when another install's gateway already serves them.
 */
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cliPathsOf } from "@standup/shared/process-identity";
import {
  GATEWAY_HOST,
  dataDirFromEnv,
  gatewayDir,
  gatewayFilePath,
  gatewayLogPath,
  leaderFilePath,
  readJsonFile,
  writeJsonAtomic,
  type GatewayInfo,
} from "@standup/shared/topology";
import { gatewayConfigFromEnv } from "./config.js";
import { createGateway } from "./gateway.js";
import { runGateway } from "./lifecycle.js";
import { isOwnGatewayPid, isRetirableOwnGateway, recordedDevAlive } from "./retire.js";
import { probeGateway, restartActivity } from "./startup.js";
import { gatewayVersion } from "./version.js";

async function main(): Promise<void> {
  const config = gatewayConfigFromEnv();
  const dataDir = dataDirFromEnv();
  const infoPath = gatewayFilePath(dataDir);
  const logPath = gatewayLogPath(dataDir);
  mkdirSync(gatewayDir(dataDir), { recursive: true, mode: 0o700 });

  const log = (message: string) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} [gateway ${process.pid}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the front door down.
    }
  };

  // A proxy keeps serving through a bug in one request's handling; the log
  // records it and dev.ts watches liveness.
  process.on("uncaughtException", (err) => log(`uncaught exception: ${err.stack ?? String(err)}`));
  process.on("unhandledRejection", (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  });
  // Spawned detached, a gateway outlives the terminal or unit that started it.
  process.on("SIGHUP", () => log("SIGHUP ignored"));

  const cliPaths = cliPathsOf(fileURLToPath(import.meta.url));
  // packages/gateway/src/cli.ts → the install root, whose scripts/dev.ts owns this gateway.
  const installDir = fileURLToPath(new URL("../../..", import.meta.url));
  const own = { dataDir, cliPaths };
  const version = gatewayVersion();
  const startedAt = new Date().toISOString();

  await runGateway({
    pid: process.pid,
    dataDir,
    version,
    startedAt,
    ports: config.ports,
    readInfo: () => readJsonFile<GatewayInfo>(infoPath),
    writeInfo: (info) => writeJsonAtomic(infoPath, info),
    removeInfo: () => rmSync(infoPath, { force: true }),
    probe: () => Promise.all([config.ports.collector, config.ports.ws].map((port) => probeGateway(GATEWAY_HOST, port))),
    ownsStats: (stats) => isRetirableOwnGateway(stats, own),
    isOwnGateway: (pid) => isOwnGatewayPid(pid, own),
    kill: (pid, signal) => process.kill(pid, signal),
    listen: (onIdle) => {
      const gateway = createGateway({
        ports: config.ports,
        vitePort: config.vitePort,
        leaderFile: leaderFilePath(dataDir),
        dataDir,
        holdMs: config.holdMs,
        maxHeld: config.maxHeld,
        idleExitMs: config.idleExitMs,
        onIdle: () => onIdle(`no collector leader for ${config.idleExitMs}ms`),
        version,
        startedAt,
        log,
      });
      log(`proxying web=${gateway.ports.web} to vite:${config.vitePort} holdMs=${config.holdMs} maxHeld=${config.maxHeld}`);
      return gateway;
    },
    devAlive: () => recordedDevAlive(dataDir, { installDir }),
    restartActivity: () => restartActivity(dataDir),
    orphanExitMs: config.orphanExitMs,
    every: (ms, fn) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    onStopSignal: (handler) => {
      process.on("SIGTERM", () => handler("SIGTERM"));
      process.on("SIGINT", () => handler("SIGINT"));
    },
    exit: (code) => process.exit(code),
    log,
    error: (message) => console.error(message),
    now: () => Date.now(),
  });
}

if (import.meta.main) void main();
