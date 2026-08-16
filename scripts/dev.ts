#!/usr/bin/env bun
/**
 * Development script that runs all services concurrently.
 *
 * Usage: bun run dev
 */

import { spawn, type Subprocess } from "bun";
import { ensureDeps } from "./check-deps.js";

const processes: Subprocess[] = [];

function runProcess(name: string, cmd: string[], cwd: string) {
  console.log(`[dev] Starting ${name}...`);

  const proc = spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
  });

  processes.push(proc);
  return proc;
}

// Cleanup on exit
process.on("SIGINT", () => {
  console.log("\n[dev] Shutting down...");
  for (const proc of processes) {
    proc.kill();
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const proc of processes) {
    proc.kill();
  }
  process.exit(0);
});

// Must complete (and update process.env.PATH if it installs anything)
// before spawning collector below — runProcess snapshots process.env at
// call time, so ripgrep needs to be resolvable on PATH before that happens.
await ensureDeps();

const root = new URL("..", import.meta.url).pathname;

// Start collector (HTTP + WebSocket server)
runProcess("collector", ["bun", "run", "dev"], `${root}/packages/collector`);

// Start web frontend
runProcess("web", ["bun", "run", "dev"], `${root}/packages/web`);

console.log(`
[dev] Services starting:
  - Collector: http://localhost:7777
  - WebSocket: ws://localhost:7778
  - Web UI:    http://localhost:5173

Press Ctrl+C to stop all services.
`);

// Keep the script running
await new Promise(() => {});
