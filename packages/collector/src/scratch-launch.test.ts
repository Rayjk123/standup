import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { pauseKillArgv } from "./launcher.js";
import { createServer } from "./server.js";
import { useScratchDataDir } from "./test-support/scratch-data-dir.js";

/**
 * POST /api/projects/:id/launch for a project with no repos and no provision
 * command — a "scratch run". It must NOT be rejected the way a repo-less
 * *bootstrap* is; instead the agent starts in a fresh empty directory. Fakes
 * `claude` on PATH so the real mkdir + tmux plumbing runs without spawning an
 * agent or spending a token.
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

useScratchDataDir("standup-scratch-launch");

const cleanupDirs: string[] = [];
const originalEnv = {
  PATH: process.env.PATH,
  STANDUP_WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
};
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  // Restore mutated process env so test-file ordering can't leak these into
  // other suites (they run in one process).
  process.env.PATH = originalEnv.PATH;
  if (originalEnv.STANDUP_WORKTREE_ROOT === undefined) {
    delete process.env.STANDUP_WORKTREE_ROOT;
  } else {
    process.env.STANDUP_WORKTREE_ROOT = originalEnv.STANDUP_WORKTREE_ROOT;
  }
});

describe("POST /api/projects/:id/launch — scratch run (no repos, no provision)", () => {
  test("creates a running scratch launch in a fresh non-git directory", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-"));
    cleanupDirs.push(fakeBin);
    await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "claude"), 0o755);
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    // Keep scratch dirs out of the real worktree root.
    const worktreeRoot = await mkdtemp(join(tmpdir(), "standup-scratch-root-"));
    cleanupDirs.push(worktreeRoot);
    process.env.STANDUP_WORKTREE_ROOT = worktreeRoot;

    const projectId = `scratch-test-${randomUUID().slice(0, 8)}`;
    const store = createStore(":memory:");
    upsertProject(store.db, { id: projectId, name: "Scratch Test", branch: "main", repos: [] });
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${projectId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "poke around" }),
    });
    const json = (await res.json()) as {
      launch?: { id: string; provisioned?: boolean; branch: string; worktreePath: string };
      error?: string;
    };

    // The key assertion: a repo-less /launch is accepted, not a 400.
    expect(res.status).toBe(200);
    expect(json.launch).toBeDefined();
    expect(json.launch!.provisioned).toBe(false);
    expect(json.launch!.branch).toBe("(scratch — no repo)");

    const finalStatus = await waitForStatus(store, json.launch!.id);
    expect(finalStatus).toBe("running");

    // A fresh directory was made, and it is NOT a git worktree.
    expect(existsSync(json.launch!.worktreePath)).toBe(true);
    expect(existsSync(join(json.launch!.worktreePath, ".git"))).toBe(false);

    const tmux = store.db
      .query("SELECT tmux_session FROM launches WHERE id = ?")
      .get(json.launch!.id) as { tmux_session: string | null };
    if (tmux.tmux_session) {
      // The launch's pane is on the workers' socket; never the shared default server.
      Bun.spawnSync(pauseKillArgv(tmux.tmux_session));
    }
  });

  test("rejects a launch against a reserved project with 403", async () => {
    const projectId = `reserved-test-${randomUUID().slice(0, 8)}`;
    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: projectId,
      name: "Reserved Corpus",
      branch: "main",
      repos: [],
      reserved: true,
    });
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${projectId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "poke around" }),
    });
    const json = (await res.json()) as { launch?: unknown; error?: string };

    expect(res.status).toBe(403);
    expect(json.launch).toBeUndefined();
    expect(json.error).toContain("not launchable");

    // No launch row should have been created for a rejected reserved launch.
    const count = store.db
      .query("SELECT COUNT(*) AS n FROM launches")
      .get() as { n: number };
    expect(count.n).toBe(0);

  });

  test("rejects an empty-string or unknown harness with 400 and never launches", async () => {
    const store = createStore(":memory:");
    const projectId = `harness-test-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id: projectId, name: "H", branch: "main", repos: [] });
    const app = createServer(store, () => {});

    // "" is the edge the composer never sends but a hand-crafted API call can. It
    // must be rejected here — treated as "not provided" it would take the
    // non-Claude path downstream while still spawning a real (untrusted) `claude`.
    for (const harness of ["", "bogus"]) {
      const res = await app.request(`/api/projects/${projectId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "do it", harness }),
      });
      const json = (await res.json()) as { launch?: unknown; error?: string };
      expect(res.status).toBe(400);
      expect(json.launch).toBeUndefined();
      expect(json.error).toContain("Unknown harness");
    }

    // Nothing was launched by either rejected request.
    const count = store.db.query("SELECT COUNT(*) AS n FROM launches").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
