import { expect, test, describe, afterAll } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { mkdtemp, rm, writeFile, chmod, rmdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import {
  createStore,
  upsertProject,
  createTicket,
  getActiveTaskRunByWorktree,
} from "@standup/store";
import type { Store } from "@standup/store";
import { pauseKillArgv } from "./launcher.js";
import { createServer } from "./server.js";
import { useScratchDataDir } from "./test-support/scratch-data-dir.js";

/**
 * POST /api/tickets/:id/approve must attribute the implementation launch to the
 * APPROVING user, exactly like the sibling /dispatch and /launch paths — so the
 * session's created_actor is the approver (spec E "started by" + spec G "Mine"),
 * their profile / review rigor is injected (spec A/B), and nothing falls back to
 * the collector host. The requester rides the launch row AND the ledger task-run
 * (the only place a dispatching teammate's alias survives to the local
 * SessionStart hook, where ensureSession stamps created_actor from it).
 *
 * Like bootstrap-launch's success test, this fakes out `claude` (a no-op script
 * at the front of PATH) so the real worktree + tmux plumbing runs without ever
 * spawning a live agent, and cleans up the worktree/tmux/branch in afterAll.
 */

const PROJECT_ID = `ticket-approve-attr-${randomUUID().slice(0, 8)}`;

async function waitForLaunchStatus(store: Store, id: string, timeoutMs = 20_000): Promise<string> {
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

useScratchDataDir("standup-approve-attr");

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("POST /api/tickets/:id/approve — attribution", () => {
  test("attributes the launch (row + ledger) to the approving tunnel user, not the host", async () => {
    const originRepo = await mkdtemp(join(tmpdir(), "standup-approve-attr-origin-"));
    cleanupDirs.push(originRepo);
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: originRepo });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(originRepo, "README.md"), "test\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);

    const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-bin-"));
    cleanupDirs.push(fakeBin);
    await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "claude"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;

    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: PROJECT_ID,
      name: "Approve Attribution Test",
      branch: "main",
      repos: [originRepo],
    });
    const app = createServer(store, () => {}, null);

    // A proposed ticket (createTicket starts at 'proposed') is what /approve
    // consumes.
    const ticket = createTicket(store.db, {
      projectId: PROJECT_ID,
      lens: "bugs",
      title: "Fix the thing",
      body: "Details.",
    });

    let worktreePath: string | undefined;
    let tmuxSession: string | undefined;
    try {
      // approve is decoupled from dispatch by default; opt into the
      // implementation launch with ?dispatch=true (this test is about the
      // launch's attribution, which only exists when a launch is fired).
      const res = await app.request(`/api/tickets/${ticket.id}/approve?dispatch=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [DEFAULT_IDENTITY_HEADER]: "alice" },
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        launch?: { id: string; requester?: string; worktreePath: string; tmuxSession?: string };
        ticket?: { status: string };
        error?: string;
      };

      expect(res.status).toBe(200);
      // The synchronously-created launch row carries the approver as requester.
      expect(json.launch?.requester).toBe("alice");
      expect(json.ticket?.status).toBe("approved");

      worktreePath = json.launch?.worktreePath;
      tmuxSession = json.launch?.tmuxSession;

      // The ledger task-run — what ensureSession reads to stamp created_actor —
      // is attributed to the approver too, not resolveUserAlias(undefined).
      expect(getActiveTaskRunByWorktree(store.db, worktreePath!)?.requester).toBe("alice");

      const finalStatus = await waitForLaunchStatus(store, json.launch!.id);
      expect(finalStatus).toBe("running");
      // Survives the round-trip through the store.
      const row = store.db
        .query("SELECT requester FROM launches WHERE id = ?")
        .get(json.launch!.id) as { requester: string };
      expect(row.requester).toBe("alice");
    } finally {
      process.env.PATH = originalPath;
      if (tmuxSession) Bun.spawnSync(pauseKillArgv(tmuxSession));
      if (worktreePath) {
        Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], { cwd: originRepo });
        await rmdir(join(worktreePath, "..")).catch(() => {});
      }
    }
  });
});
