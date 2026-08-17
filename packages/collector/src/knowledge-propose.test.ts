import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, createSession, createLaunch, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { searchKnowledge } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * propose_knowledge's collector-side gate is the security-relevant part of
 * Phase 7 Step 2: without it, any session anywhere could write into a
 * project's knowledge base. These exercise POST /api/knowledge/propose
 * directly (not through the MCP tool, which packages/mcp does not
 * hot-reload — see runbook.md) to confirm the gate actually rejects
 * everything but a running bootstrap launch, and that a legitimate call
 * writes a draft a human hasn't reviewed yet, never something searchable.
 */

const PROJECT_ID = `propose-test-${randomUUID().slice(0, 8)}`;

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-propose-"));
}

/** A real git repo with one commit, so `git rev-parse HEAD` in the handler
 * has something to resolve — findLaunchByCwd matches on worktree_path, so
 * this same directory is used as both the launch's worktree and the
 * request's cwd. */
async function tempGitWorktree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-bootstrap-worktree-"));
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await Bun.write(join(dir, "README.md"), "test\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
  return dir;
}

function setUpStore(): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, {
    id: PROJECT_ID,
    name: "Propose Test",
    branch: "main",
    repos: [],
  });
  return store;
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("POST /api/knowledge/propose", () => {
  test("rejects a caller with no launch at all", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    const sessionId = randomUUID();
    const cwd = "/tmp/not-a-launch";
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd,
      status: "running",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd,
        slug: "sneaky",
        title: "Sneaky",
        body: "Should never land.",
      }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/bootstrap/i);

    // Nothing should have been written to disk at all.
    await expect(readdir(join(knowledgeDir, PROJECT_ID, ".drafts"))).rejects.toThrow();

    store.close();
  });

  test("rejects a session running inside a plain (non-bootstrap) launch", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    const launch = createLaunch(store.db, {
      id: randomUUID(),
      kind: "worktree",
      projectId: PROJECT_ID,
      task: "ordinary work",
      worktreePath: worktree,
      branch: "standup/ordinary",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "sneaky-2",
        title: "Sneaky 2",
        body: "An ordinary launch should not be able to do this either.",
      }),
    });

    expect(res.status).toBe(403);
    expect(launch.kind).toBe("worktree"); // sanity: fixture is what it claims

    store.close();
  });

  test("accepts a session inside a running bootstrap launch and writes a draft", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "bootstrap",
      projectId: PROJECT_ID,
      task: "bootstrap knowledge",
      worktreePath: worktree,
      branch: "standup/bootstrap",
      status: "running",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    let broadcasted: unknown;
    const app = createServer(
      store,
      (msg) => {
        broadcasted = msg;
      },
      null,
      knowledgeSync,
      undefined,
      knowledgeDir
    );

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "toolchain",
        title: "Toolchain",
        body: "Run `bun test` to run the whole suite.",
        tags: ["setup"],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; slug: string };
    expect(json).toEqual({ ok: true, slug: "toolchain" });

    // The file landed in .drafts/, not as an accepted doc.
    const draftPath = join(knowledgeDir, PROJECT_ID, ".drafts", "toolchain.md");
    const raw = await readFile(draftPath, "utf-8");
    expect(raw).toContain("Run `bun test`");
    expect(raw).toMatch(/generated_from_sha:/);
    expect(raw).toMatch(/generated_by_launch_id: ?["']?/);

    // The collector stamped a real sha from the worktree, not something the
    // (nonexistent, in this test) agent supplied.
    const headSha = (
      await new Response(
        Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: worktree, stdout: "pipe" }).stdout
      ).text()
    ).trim();
    expect(raw).toContain(headSha);

    // The row is indexed as a pending draft.
    expect(broadcasted).toMatchObject({ type: "knowledge:draft" });

    // Never reachable through search_knowledge — knowledge_drafts has no FTS
    // table and searchKnowledge never queries it (see store.ts's
    // ensureTables comment), but assert it rather than trust the absence of
    // a code path, per phase-7.md's instruction to test this, not reason
    // about it.
    const results = await searchKnowledge(store.db, PROJECT_ID, "toolchain bun test", null);
    expect(results.find((r) => r.slug === "toolchain")).toBeUndefined();

    store.close();
  });

  test("rejects a bootstrap launch that has already finished (status != running)", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const worktree = await tempGitWorktree();
    cleanupDirs.push(worktree);

    createLaunch(store.db, {
      id: randomUUID(),
      kind: "bootstrap",
      projectId: PROJECT_ID,
      task: "bootstrap knowledge",
      worktreePath: worktree,
      branch: "standup/bootstrap",
      status: "cleaned",
    });

    const sessionId = randomUUID();
    createSession(store.db, {
      id: sessionId,
      projectId: PROJECT_ID,
      title: "",
      cwd: worktree,
      status: "running",
    });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        cwd: worktree,
        slug: "late",
        title: "Late",
        body: "Should not land after cleanup.",
      }),
    });

    // findLaunchByCwd excludes status = 'cleaned' outright, so this reads as
    // "no launch found" the same as the no-launch case above.
    expect(res.status).toBe(403);

    store.close();
  });
});
