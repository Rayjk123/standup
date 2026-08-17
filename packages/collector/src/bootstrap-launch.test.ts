import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod, rmdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";

/**
 * POST /api/projects/:id/bootstrap-knowledge (phase-7 Step 3).
 *
 * Per plan/phase-7.md and plan/runbook.md, a *successful* launch is not
 * free — it creates a worktree, runs setup, and starts a real `claude`
 * process that spends tokens. The error paths below are safe to exercise
 * because they fail before anything is created (same guidance the runbook
 * gives for POST /launch), so those are tested directly against the route.
 *
 * The one "success" test fakes out `claude` itself: it puts a no-op script
 * named `claude` at the front of PATH so `launchSession`'s real worktree +
 * tmux plumbing runs for real (proving `kind: "bootstrap"` and the
 * model/effort defaults actually reach the launch row), without ever
 * spawning a real agent or spending a token. Everything it creates —
 * worktree, branch, tmux session — is cleaned up in `afterAll`.
 */

const PROJECT_ID = `bootstrap-launch-test-${randomUUID().slice(0, 8)}`;

function setUpStore(repos: string[] = []): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, {
    id: PROJECT_ID,
    name: "Bootstrap Launch Test",
    branch: "main",
    repos,
  });
  return store;
}

/**
 * Provisioning is now fire-and-forget: the endpoint returns a "starting"
 * launch immediately and the worktree/tmux work finishes in the background.
 * Poll the row until it leaves "starting" so assertions and cleanup run
 * against the completed launch.
 */
async function waitForLaunchStatus(
  store: Store,
  id: string,
  timeoutMs = 20_000
): Promise<string> {
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
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("POST /api/projects/:id/bootstrap-knowledge — validation", () => {
  test("unknown project -> 404", async () => {
    const store = createStore(":memory:");
    const app = createServer(store, () => {});

    const res = await app.request("/api/projects/does-not-exist/bootstrap-knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    store.close();
  });

  test("unknown model -> 400", async () => {
    const store = setUpStore();
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${PROJECT_ID}/bootstrap-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-not-a-claude-model" }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/model/i);
    store.close();
  });

  test("unknown effort -> 400", async () => {
    const store = setUpStore();
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${PROJECT_ID}/bootstrap-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: "extremely-high" }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/effort/i);
    store.close();
  });

  test("no body at all is accepted (model/effort are optional) and still validates the project", async () => {
    const store = createStore(":memory:");
    const app = createServer(store, () => {});

    // No Content-Type/body — exercises the `.catch(() => ({}))` fallback
    // before the 404 check, same shape as line 158's pattern elsewhere in
    // server.ts.
    const res = await app.request("/api/projects/does-not-exist/bootstrap-knowledge", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    store.close();
  });

  test("project with no repos configured -> 400, and nothing is created", async () => {
    // Safe per runbook.md: launchSession throws before any worktree, branch
    // or launch row exists — mirrors the equivalent no-repos case for the
    // normal /launch route.
    const store = setUpStore([]);
    const app = createServer(store, () => {});

    const res = await app.request(`/api/projects/${PROJECT_ID}/bootstrap-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/repos/i);

    // No launch row: findLaunchByCwd would have nothing to find.
    const launches = store.db.query("SELECT * FROM launches WHERE project_id = ?").all(PROJECT_ID);
    expect(launches).toHaveLength(0);

    store.close();
  });
});

describe("POST /api/projects/:id/bootstrap-knowledge — success (fake claude, no live agent)", () => {
  test("creates a running launch with kind 'bootstrap' and the Opus/high defaults", async () => {
    // A throwaway origin repo to check the worktree out from — never the
    // real standup repo, so its worktree list is untouched by this test.
    const originRepo = await mkdtemp(join(tmpdir(), "standup-bootstrap-origin-"));
    cleanupDirs.push(originRepo);
    const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: originRepo });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    await writeFile(join(originRepo, "README.md"), "test\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);

    // A fake `claude` on PATH so tmux has something harmless to run instead
    // of a real agent — the point of this test is proving kind/model/effort
    // reach the launch row through the real worktree+tmux plumbing, not
    // exercising the CLI itself.
    const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-bin-"));
    cleanupDirs.push(fakeBin);
    await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
    await chmod(join(fakeBin, "claude"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;

    const store = setUpStore([originRepo]);
    const app = createServer(store, () => {});

    let worktreePath: string | undefined;
    let tmuxSession: string | undefined;
    try {
      const res = await app.request(`/api/projects/${PROJECT_ID}/bootstrap-knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const json = (await res.json()) as {
        launch?: {
          id: string;
          kind: string;
          status: string;
          model?: string;
          effort?: string;
          worktreePath: string;
          tmuxSession?: string;
        };
        error?: string;
      };

      expect(res.status).toBe(200);
      expect(json.launch?.kind).toBe("bootstrap");
      // Async now: the response is the freshly-created row, still "starting" —
      // the worktree/tmux work runs in the background.
      expect(json.launch?.status).toBe("starting");
      // Defaults from the route, not the CLI's own default — the whole
      // point per phase-7.md Step 3.
      expect(json.launch?.model).toBe("opus");
      expect(json.launch?.effort).toBe("high");

      worktreePath = json.launch?.worktreePath;
      tmuxSession = json.launch?.tmuxSession;

      // Wait for the detached work to finish, then assert it reached running.
      const finalStatus = await waitForLaunchStatus(store, json.launch!.id);
      expect(finalStatus).toBe("running");

      // Round-trips through the store, not just the response payload.
      const row = store.db
        .query("SELECT kind, model, effort FROM launches WHERE id = ?")
        .get(json.launch!.id) as { kind: string; model: string; effort: string };
      expect(row.kind).toBe("bootstrap");
      expect(row.model).toBe("opus");
      expect(row.effort).toBe("high");
    } finally {
      process.env.PATH = originalPath;

      if (tmuxSession) {
        Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession]);
      }
      if (worktreePath) {
        Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], {
          cwd: originRepo,
        });
        // Parent dir (WORKTREE_ROOT/<project-id>/) is otherwise left behind
        // empty — remove it too so the worktree root looks as it did before.
        await rmdir(join(worktreePath, "..")).catch(() => {});
      }
      store.close();
    }
  });
});
