import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, getPlanApprovalByLaunch } from "@standup/store";
import type { Store } from "@standup/store";
import { useScratchDataDir } from "./test-support/scratch-data-dir.js";
import { pauseKillArgv } from "./launcher.js";
import { createServer } from "./server.js";

/**
 * A plan-gated project whose launchArgs strip the standup MCP server
 * (--strict-mcp-config) must NOT open a plan-approval gate: submit_plan would
 * be unreachable, so the gate could never be satisfied and would strand the
 * launch (and its ticket) forever. The launch proceeds ungated with a warning.
 * Uses a repo-less "scratch" project so no git plumbing is needed; fakes
 * `claude` on PATH so the real tmux path runs without spawning an agent.
 */

async function waitForStatus(store: Store, id: string, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = store.db
      .query("SELECT status FROM launches WHERE id = ?")
      .get(id) as { status: string } | null;
    if (row && row.status !== "starting") return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "timeout";
}

useScratchDataDir("standup-plan-gate-launch");

const cleanupDirs: string[] = [];
const originalEnv = {
  PATH: process.env.PATH,
  STANDUP_WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
};
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  process.env.PATH = originalEnv.PATH;
  if (originalEnv.STANDUP_WORKTREE_ROOT === undefined) {
    delete process.env.STANDUP_WORKTREE_ROOT;
  } else {
    process.env.STANDUP_WORKTREE_ROOT = originalEnv.STANDUP_WORKTREE_ROOT;
  }
});

async function fakeClaudeOnPath() {
  const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-"));
  cleanupDirs.push(fakeBin);
  await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "claude"), 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  const worktreeRoot = await mkdtemp(join(tmpdir(), "standup-plan-gate-root-"));
  cleanupDirs.push(worktreeRoot);
  process.env.STANDUP_WORKTREE_ROOT = worktreeRoot;
}

function killTmux(store: Store, launchId: string) {
  const tmux = store.db
    .query("SELECT tmux_session FROM launches WHERE id = ?")
    .get(launchId) as { tmux_session: string | null };
  if (tmux?.tmux_session) {
    Bun.spawnSync(pauseKillArgv(tmux.tmux_session));
  }
}

describe("plan gate + --strict-mcp-config launch", () => {
  test("a gated project whose launchArgs strip the standup MCP opens no gate and warns", async () => {
    await fakeClaudeOnPath();
    const projectId = `plan-gate-strict-${randomUUID().slice(0, 8)}`;
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: projectId,
      name: "Gated + strict",
      branch: "main",
      repos: [],
      planGate: true,
      launchArgs: "--strict-mcp-config",
    });
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${projectId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "do a thing" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { launch: { id: string } };

    expect(await waitForStatus(store, json.launch.id)).toBe("running");

    // The core assertion: no unsatisfiable gate was opened for this launch.
    expect(getPlanApprovalByLaunch(store.db, json.launch.id)).toBeNull();

    // And the reason is surfaced in the launch log, not silently dropped.
    const row = store.db
      .query("SELECT log FROM launches WHERE id = ?")
      .get(json.launch.id) as { log: string | null };
    expect(row.log ?? "").toContain("plan-approval gate skipped");

    killTmux(store, json.launch.id);
  });

  test("a gated project WITHOUT --strict-mcp-config still opens the gate", async () => {
    await fakeClaudeOnPath();
    const projectId = `plan-gate-open-${randomUUID().slice(0, 8)}`;
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: projectId,
      name: "Gated",
      branch: "main",
      repos: [],
      planGate: true,
    });
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${projectId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "do a thing" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { launch: { id: string } };

    expect(await waitForStatus(store, json.launch.id)).toBe("running");

    const gate = getPlanApprovalByLaunch(store.db, json.launch.id);
    expect(gate).not.toBeNull();
    expect(gate!.status).toBe("awaiting_plan");

    killTmux(store, json.launch.id);
  });
});
