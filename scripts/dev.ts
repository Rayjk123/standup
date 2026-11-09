#!/usr/bin/env bun
/**
 * Development script that runs all services concurrently.
 *
 * Usage: bun run dev
 */

import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_RESPAWN_SIGNAL,
  devFilePath,
  gatewayEnabled,
  gatewayFilePath,
  gatewayLogPath,
  publicPorts,
  readJsonFile,
  slotPorts,
  vitePortFromEnv,
  writeJsonAtomic,
  type DevInfo,
  type GatewayInfo,
} from "../packages/shared/src/topology.js";
import { ensureDeps } from "./check-deps.js";
import {
  appendLogLine,
  createGatewayWatchdog,
  CrashLoopBreaker,
  devOwnershipConflict,
  ensureGateway,
  fetchGatewayStats,
  GATEWAY_WATCH_INTERVAL_MS,
  gatewayCliPath,
  gatewayCliPaths,
  gatewayStatsUrl,
  gitHead,
  isInstallGateway,
  loadGatewayVersion,
  planServices,
  publicPortsFree,
  resolveDbPath,
  respawnGivenUp,
  serviceEnv,
  spawnDetached,
  stopGatewayForClassic,
  type GatewayDeps,
  type GatewayWatchdog,
  type ServicePlan,
  type SupervisedService,
} from "./dev-topology.js";

// The commit this dev.ts's code was loaded from, read before anything awaits
// (dependency installs, ollama) so a checkout landing meanwhile can't be
// recorded in dev.json as the code that runs.
const loadedHead = gitHead(fileURLToPath(new URL("..", import.meta.url)));

const root = new URL("..", import.meta.url).pathname;
const installDir = resolve(root);

// Every child (the gateway, both slots, vite) inherits one absolute DB_PATH,
// so all of them derive the same data dir whatever their cwd.
process.env.DB_PATH = resolveDbPath(process.env, root);
const dataDir = dirname(process.env.DB_PATH);

// One install owns a data dir at a time: a live dev.ts of another install
// recorded in dev.json means this one must not start beside it.
const ownershipConflict = devOwnershipConflict(readJsonFile<Partial<DevInfo>>(devFilePath(dataDir)), {
  pid: process.pid,
  installDir,
  dataDir,
});
if (ownershipConflict) {
  console.error(ownershipConflict);
  process.exit(1);
}

// Written before anything slow (dependency installs, ollama) so a gateway
// watching dev.json sees its new dev.ts within about a second of a restart.
// `gateway` is rewritten below if the gateway sources turn out to be missing.
const devInfo: DevInfo = {
  pid: process.pid,
  head: loadedHead,
  startedAt: new Date().toISOString(),
  installDir,
  gateway: gatewayEnabled(process.env),
};
function writeDevInfo(): void {
  try {
    writeJsonAtomic(devFilePath(dataDir), devInfo);
  } catch (err) {
    console.error(`[dev] Could not write ${devFilePath(dataDir)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
writeDevInfo();

const processes: Subprocess[] = [];
const supervised: SupervisedService[] = [];
let shuttingDown = false;

// A crashed service (e.g. the collector OOM-killed under a memory spike) is
// restarted rather than left dead — otherwise the console silently goes down
// until the next manual `bun run dev`. A crash-loop breaker gives up after too
// many restarts in a short window so a genuinely broken build doesn't spin
// forever; DEV_RESPAWN_SIGNAL resets it.
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;

function runProcess(service: ServicePlan): void {
  const { name, cmd, cwd } = service;
  const entry: SupervisedService = {
    name,
    breaker: new CrashLoopBreaker(RESTART_WINDOW_MS, MAX_RESTARTS_PER_WINDOW),
    gaveUp: false,
    start: () => {
      start();
    },
  };

  const start = (): Subprocess => {
    console.log(`[dev] Starting ${name}...`);

    const proc = spawn(cmd, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: serviceEnv(process.env, service, { FORCE_COLOR: "1" }),
    });

    processes.push(proc);

    void proc.exited.then((code) => {
      // Drop the reaped handle so shutdown never kills a dead pid.
      const i = processes.indexOf(proc);
      if (i !== -1) processes.splice(i, 1);
      if (shuttingDown) return;

      if (!entry.breaker.recordExit()) {
        entry.gaveUp = true;
        console.error(
          `[dev] ${name} exited (code ${code}) and has crashed ${entry.breaker.recent}× in ${RESTART_WINDOW_MS / 1000}s — not restarting. Fix it and send ${DEV_RESPAWN_SIGNAL} to dev.ts (pid ${process.pid}) or rerun \`bun run dev\`.`
        );
        return;
      }
      console.error(`[dev] ${name} exited (code ${code}) — restarting in 1s…`);
      setTimeout(() => {
        if (!shuttingDown) start();
      }, 1000);
    });

    return proc;
  };

  supervised.push(entry);
  start();
}

// Cleanup on exit. Only the supervised services in `processes` are stopped: the
// gateway is spawned detached and never tracked there, so it keeps the public
// ports open across a dev.ts restart.
let gatewayWatchTimer: ReturnType<typeof setInterval> | undefined;
let gatewayWatchdog: GatewayWatchdog | undefined;

// Resets every crash-loop breaker (the services' and the gateway watchdog's)
// and restarts the services dev.ts gave up on, e.g. once a rollback has put
// working code back on disk.
process.on(DEV_RESPAWN_SIGNAL, () => {
  if (shuttingDown) return;
  gatewayWatchdog?.reset();
  const started = respawnGivenUp(supervised);
  console.log(
    `[dev] ${DEV_RESPAWN_SIGNAL}: crash-loop breakers reset; ${started.length > 0 ? `respawning ${started.join(", ")}` : "no service needed respawning"}`
  );
});

process.on("SIGINT", () => {
  shuttingDown = true;
  clearInterval(gatewayWatchTimer);
  console.log("\n[dev] Shutting down...");
  for (const proc of processes) {
    proc.kill();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  shuttingDown = true;
  clearInterval(gatewayWatchTimer);
  for (const proc of processes) {
    proc.kill();
  }
  process.exit(0);
});

// Best-effort: ensure a local ollama is up so the collector's boot probe
// (detectOllama in packages/collector/src/index.ts) finds it and turns on vector
// embeddings (nomic-embed-text) with zero config. If ollama isn't installed we
// skip with a hint — knowledge search still works text-only. Never blocks or
// fails dev startup on ollama issues.
const OLLAMA_URL = "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

// Pull the embed model if absent (first run downloads ~275MB). Non-blocking:
// the collector detects ollama regardless; embeddings turn on once the model is
// ready and the next sync runs.
function ensureEmbedModel(): void {
  void (async () => {
    try {
      const list = spawn(["ollama", "list"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(list.stdout).text();
      if (out.includes(EMBED_MODEL)) return;
      console.log(`[dev] Pulling ${EMBED_MODEL} (first run, ~275MB; embeddings turn on once it's ready)…`);
      spawn(["ollama", "pull", EMBED_MODEL], { stdout: "ignore", stderr: "ignore" });
    } catch {
      // best-effort — a failed pull just leaves search text-only
    }
  })();
}

async function ensureOllama(): Promise<void> {
  if (await ollamaReachable()) {
    console.log("[dev] ollama already running — collector will enable embeddings");
    ensureEmbedModel();
    return;
  }
  if (!Bun.which("ollama")) {
    console.log(
      "[dev] ollama not installed — knowledge search runs text-only. `brew install ollama` for local vector embeddings."
    );
    return;
  }
  console.log("[dev] Starting ollama (serve)…");
  // Managed like the other dev services: we started it, so Ctrl+C stops it.
  // (When ollama was already running above we return early and never touch it.)
  const proc = spawn(["ollama", "serve"], { stdout: "ignore", stderr: "ignore", env: { ...process.env } });
  processes.push(proc);
  for (let i = 0; i < 20 && !(await ollamaReachable()); i++) await Bun.sleep(250);
  ensureEmbedModel();
}

// Must complete (and update process.env.PATH if it installs anything)
// before spawning collector below — runProcess snapshots process.env at
// call time, so ripgrep needs to be resolvable on PATH before that happens.
await ensureDeps();
// Start ollama before the collector so its boot-time detectOllama probe succeeds.
await ensureOllama();

// Gateway mode (the default on a loopback bind host): a detached gateway owns
// the public ports and proxies to vite and to whichever collector slot holds
// the leader lock, so restarting a collector or dev.ts itself never drops a
// connection. It needs the gateway sources; without them dev.ts runs classic.
let gatewayVersion: (() => string) | undefined;
if (gatewayEnabled(process.env)) {
  gatewayVersion = await loadGatewayVersion(root);
  if (!gatewayVersion) {
    console.error("[dev] Gateway mode is on but packages/gateway is missing — running the classic topology (vite on the web port, one collector).");
  }
}

// Start the Slack adapter only when it's been configured — its tokens live in
// packages/slack/.env, which `bun run dev` (cwd = that package) auto-loads.
// Skipped-but-logged otherwise, so `bun run dev` works with or without Slack.
const slackConfigured = existsSync(`${root}/packages/slack/.env`);
const ports = publicPorts(process.env);
// Vite's own port in gateway mode: STANDUP_VITE_PORT, else vitePortFor the public web port (5173 → 15173).
const vitePort = vitePortFromEnv(process.env);
const plan = planServices(process.env, { root, slackConfigured, gateway: gatewayVersion !== undefined, ports, vitePort });

if (devInfo.gateway !== (plan.mode === "gateway")) {
  devInfo.gateway = plan.mode === "gateway";
  writeDevInfo();
}

const logPath = gatewayLogPath(dataDir);
const cliPath = gatewayCliPath(root);
const cliPaths = gatewayCliPaths(root);
// Exit codes of the gateways this dev.ts spawned, by pid.
const gatewayExits = new Map<number, number | null>();
const gatewayDeps: GatewayDeps = {
  readInfo: () => readJsonFile<GatewayInfo>(gatewayFilePath(dataDir)),
  isGateway: (pid) => isInstallGateway(pid, cliPaths),
  version: gatewayVersion ?? (() => ""),
  config: { ports, vitePort, dataDir },
  // Snapshotted at spawn time, after ensureDeps may have extended PATH; the
  // gateway learns where vite listens from STANDUP_VITE_PORT.
  spawnDetached: () =>
    spawnDetached([process.execPath, "run", cliPath], {
      cwd: root,
      env: { ...process.env, STANDUP_VITE_PORT: String(vitePort) },
      logPath,
      onExit: (pid, code) => gatewayExits.set(pid, code),
    }),
  exitCode: (pid) => gatewayExits.get(pid) ?? undefined,
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  },
  fetchStats: () => fetchGatewayStats(gatewayStatsUrl(ports.collector)),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  log: (message) => console.log(message),
  appendLog: (message) => appendLogLine(logPath, message),
};

if (plan.mode === "gateway") {
  // Not awaited: a gateway waiting out a busy port can take ~30s to serve, and
  // the slots and vite don't need it to start. The watchdog only starts once
  // the ensure settles, so it never spawns beside a gateway still booting.
  void ensureGateway(gatewayDeps).then((ensured) => {
    const watchdog = createGatewayWatchdog(gatewayDeps, ensured.action === "failed" ? undefined : ensured.pid, {
      foreign: ensured.action === "foreign",
    });
    gatewayWatchdog = watchdog;
    if (shuttingDown) return;
    // Also runs while `foreign`: the watchdog then only re-probes for the
    // other gateway, and respawns once it is gone.
    gatewayWatchTimer = setInterval(() => {
      if (shuttingDown || watchdog.gaveUp) return;
      void watchdog.check();
    }, GATEWAY_WATCH_INTERVAL_MS);
  });
} else {
  // A gateway left by an earlier gateway-mode run would keep the public ports
  // the classic services are about to bind.
  await stopGatewayForClassic({ ...gatewayDeps, portsFree: publicPortsFree }, ports);
}

// Start the collector(s) (HTTP + WebSocket server), web frontend and Slack.
// Collectors are not under `bun --watch` by default: a watched collector
// reloads on every change in the install — a merge, a checkout — at once, with
// none of restart_standup's quiesce, health check or rollback.
// STANDUP_COLLECTOR_WATCH=1 runs it watched (`bun run dev`) for working on the
// collector itself; in gateway mode both slots then reload together.
const collectorWatch = process.env.STANDUP_COLLECTOR_WATCH === "1";
for (const service of plan.services) {
  runProcess(service);
  if (service.name === "collector" && !collectorWatch) {
    console.log("[dev] Collector runs without --watch: restart it with Persona's restart_standup or by rerunning `bun run dev` (STANDUP_COLLECTOR_WATCH=1 reloads it on every change).");
  }
  if (service.name === "collector:b" && !collectorWatch) {
    console.log("[dev] Collector slots run without --watch: restart_standup hands off between them (STANDUP_COLLECTOR_WATCH=1 reloads both on every change).");
  }
}
if (!slackConfigured) {
  console.log(
    "[dev] Slack adapter not configured (no packages/slack/.env) — skipping. See packages/slack/README.md."
  );
}

if (plan.mode === "gateway") {
  const a = slotPorts(ports.collector, ports.ws, "a");
  const b = slotPorts(ports.collector, ports.ws, "b");
  console.log(`
[dev] Services starting (gateway mode):
  - Gateway:   http://localhost:${ports.web} (web), http://localhost:${ports.collector} (collector), ws://localhost:${ports.ws} (ws) — detached, survives dev.ts restarts
  - Vite:      http://localhost:${vitePort} (behind the gateway)
  - Collector: slot a on ${a.http}/${a.ws}, slot b on ${b.http}/${b.ws} (one leads, the other stands by)${slackConfigured ? "\n  - Slack:     Socket Mode adapter (packages/slack)" : ""}
  - Gateway log: ${logPath}

Press Ctrl+C to stop all services (the gateway stays up and exits on its own once no collector leads). STANDUP_GATEWAY=0 runs the classic topology.
`);
} else {
  console.log(`
[dev] Services starting:
  - Collector: http://localhost:${ports.collector}
  - WebSocket: ws://localhost:${ports.ws}
  - Web UI:    http://localhost:${ports.web}${slackConfigured ? "\n  - Slack:     Socket Mode adapter (packages/slack)" : ""}

Press Ctrl+C to stop all services.
`);
}

// Keep the script running
await new Promise(() => {});
