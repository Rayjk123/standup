import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { pauseKillArgv } from "./launcher.js";
import { createServer } from "./server.js";

/**
 * POST /api/launch — the project-less launch route. A launch with no project
 * chosen must be accepted (not a 400) and default to the reserved `scratch`
 * project, exactly like an explicit scratch run. Fakes `claude` on PATH so the
 * real mkdir + tmux plumbing runs without spawning an agent or spending a token.
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

describe("POST /api/launch — project-less launch defaults to scratch", () => {
  test("accepts a launch with no project and routes it to scratch", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-"));
    cleanupDirs.push(fakeBin);
    await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "claude"), 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const worktreeRoot = await mkdtemp(join(tmpdir(), "standup-scratch-root-"));
    cleanupDirs.push(worktreeRoot);
    process.env.STANDUP_WORKTREE_ROOT = worktreeRoot;

    const store = createStore(":memory:");
    // scratch is a real registered project — the reserved home the route falls
    // back to. Normally ensured at bootstrap; register it explicitly here.
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    const app = createServer(store, () => {});

    const res = await app.request("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "poke around, no project" }),
    });
    const json = (await res.json()) as {
      launch?: { id: string; projectId: string; provisioned?: boolean; branch: string };
      error?: string;
    };

    expect(res.status).toBe(200);
    expect(json.launch).toBeDefined();
    expect(json.launch!.projectId).toBe("scratch");
    expect(json.launch!.provisioned).toBe(false);
    expect(json.launch!.branch).toBe("(scratch — no repo)");

    const finalStatus = await waitForStatus(store, json.launch!.id);
    expect(finalStatus).toBe("running");

    const tmux = store.db
      .query("SELECT tmux_session FROM launches WHERE id = ?")
      .get(json.launch!.id) as { tmux_session: string | null };
    if (tmux.tmux_session) {
      Bun.spawnSync(pauseKillArgv(tmux.tmux_session));
    }
    store.close();
  });

  test("rejects a project-less launch with no task", async () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    const app = createServer(store, () => {});

    const res = await app.request("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    expect(res.status).toBe(400);
    store.close();
  });
});
