import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, rmdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, getLaunch, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { useScratchDataDir } from "./test-support/scratch-data-dir.js";
import { gitWorktreeDiff } from "./attempts.js";
import { pauseKillArgv } from "./launcher.js";
import { gitChangedFiles, launchHasOwnChange } from "./pipeline/runners.js";
import { defaultGitRunner, reviewRefs } from "./review/stage.js";
import { createServer } from "./server.js";

/**
 * Launches into repos whose default branch isn't `main`, through the real
 * worktree + tmux plumbing (the bootstrap route runs launchSession), with a
 * no-op `claude` on PATH so no agent starts. Each project keeps the default
 * `branch = "main"` setting, as a project that never set one does.
 */

const scratch = useScratchDataDir("standup-base-branch-launch");

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function makeRepo(branch: string): Promise<{ dir: string; git: (...args: string[]) => string }> {
  const dir = await mkdtemp(join(tmpdir(), "standup-base-branch-origin-"));
  cleanupDirs.push(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe" }).stdout.toString().trim();
  git("init", "-q", "-b", branch);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(dir, "README.md"), "test\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { dir, git };
}

function setUpStore(projectId: string, repo: string): Store {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: projectId, name: projectId, branch: "main", repos: [repo] });
  return store;
}

async function waitForLaunchStatus(store: Store, id: string, timeoutMs = 20_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = store.db.query("SELECT status FROM launches WHERE id = ?").get(id) as { status: string } | null;
    if (row && row.status !== "starting") return row.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "timeout";
}

/** A clone of a `mainline` origin whose local `main` tracks `origin/mainline`: a local default branch named unlike its upstream. */
async function makeRenamedDefaultRepo(): Promise<{ dir: string; git: (...args: string[]) => string }> {
  const origin = await makeRepo("mainline");
  const dir = await mkdtemp(join(tmpdir(), "standup-base-branch-install-"));
  cleanupDirs.push(dir);
  Bun.spawnSync(["git", "clone", "-q", origin.dir, dir], { stdout: "pipe", stderr: "pipe" });
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe" }).stdout.toString().trim();
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("checkout", "-q", "-b", "main", "--track", "origin/mainline");
  git("branch", "-q", "-D", "mainline");
  return { dir, git };
}

/** What a launch's own change reads as, once one commit lands in its worktree: review refs, pipeline files and diffs. */
interface ChangeReads {
  reviewBase?: string;
  reviewFiles: string[];
  pipelineFiles: string[];
  hasOwnChange: boolean;
  worktreeDiffFiles: string[];
}

async function readOwnChange(store: Store, launchId: string): Promise<ChangeReads> {
  const launch = getLaunch(store.db, launchId)!;
  const dir = launch.worktreePath!;
  await writeFile(join(dir, "change.txt"), "change\n");
  for (const args of [["add", "change.txt"], ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "change"]]) {
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  }
  const refs = reviewRefs(dir, defaultGitRunner, launch.baseBranch);
  const diff = await gitWorktreeDiff(dir, launch.baseBranch ?? "");
  return {
    reviewBase: refs.baseSha,
    reviewFiles: refs.changedFiles ?? [],
    pipelineFiles: await gitChangedFiles(dir, launch.baseBranch),
    hasOwnChange: launchHasOwnChange(launch, defaultGitRunner),
    worktreeDiffFiles: [...diff.diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]!),
  };
}

/** Launches into `repo` with a fake claude; returns the launch row's base, the worktree's parent commit and how its change reads. */
async function launchInto(repo: { dir: string; git: (...args: string[]) => string }) {
  const projectId = `base-branch-${randomUUID().slice(0, 8)}`;
  const fakeBin = await mkdtemp(join(tmpdir(), "standup-fake-claude-bin-"));
  cleanupDirs.push(fakeBin);
  await writeFile(join(fakeBin, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(join(fakeBin, "claude"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  const store = setUpStore(projectId, repo.dir);
  const app = createServer(store, () => {});
  let worktreePath: string | undefined;
  let tmuxSession: string | undefined;
  try {
    const res = await app.request(`/api/projects/${projectId}/bootstrap-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const json = (await res.json()) as { launch?: { id: string; worktreePath: string; tmuxSession?: string }; error?: string };
    expect(json.error).toBeUndefined();
    expect(res.status).toBe(200);
    worktreePath = json.launch?.worktreePath;
    tmuxSession = json.launch?.tmuxSession;
    const status = await waitForLaunchStatus(store, json.launch!.id);
    const row = store.db.query("SELECT base_branch, error FROM launches WHERE id = ?").get(json.launch!.id) as {
      base_branch: string;
      error: string | null;
    };
    const parent = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktreePath!, stdout: "pipe" }).stdout.toString().trim();
    const upstream = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: worktreePath!, stdout: "pipe", stderr: "pipe" });
    const change = await readOwnChange(store, json.launch!.id);
    return {
      status,
      baseBranch: row.base_branch,
      error: row.error,
      parent,
      worktreePath: worktreePath!,
      tracks: upstream.exitCode === 0 ? upstream.stdout.toString().trim() : null,
      change,
    };
  } finally {
    process.env.PATH = originalPath;
    if (tmuxSession) Bun.spawnSync(pauseKillArgv(tmuxSession));
    if (worktreePath) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", worktreePath], { cwd: repo.dir });
      await rmdir(join(worktreePath, "..")).catch(() => {});
    }
  }
}

/** The reads of a launch whose only change is one commit adding change.txt on top of `base`. */
function ownChangeOn(base: string): ChangeReads {
  return { reviewBase: base, reviewFiles: ["change.txt"], pipelineFiles: ["change.txt"], hasOwnChange: true, worktreeDiffFiles: ["change.txt"] };
}

describe("worktree launches pick the repo's real base branch", () => {
  test("a repo whose only branch is mainline launches, based on mainline", async () => {
    const repo = await makeRepo("mainline");
    const tip = repo.git("rev-parse", "mainline");
    const out = await launchInto(repo);
    expect(out.error).toBeNull();
    expect(out.status).toBe("running");
    expect(out.baseBranch).toBe("mainline");
    expect(out.parent).toBe(tip);
    expect(out.worktreePath.startsWith(scratch.worktreeRoot)).toBe(true);
    expect(out.change).toEqual(ownChangeOn(tip));
  });

  test("a main repo still launches, based on main", async () => {
    const repo = await makeRepo("main");
    const tip = repo.git("rev-parse", "main");
    const out = await launchInto(repo);
    expect(out.status).toBe("running");
    expect(out.baseBranch).toBe("main");
    expect(out.parent).toBe(tip);
    expect(out.change).toEqual(ownChangeOn(tip));
  });

  test("a clone whose local main tracks origin/mainline launches from main, untracked, read against origin/mainline", async () => {
    const repo = await makeRenamedDefaultRepo();
    const tip = repo.git("rev-parse", "origin/mainline");
    const out = await launchInto(repo);
    expect(out.status).toBe("running");
    expect(out.baseBranch).toBe("main");
    expect(out.parent).toBe(tip);
    expect(out.tracks).toBeNull();
    expect(out.change).toEqual(ownChangeOn(tip));
  });

  test("a clone of a mainline origin with no local default branch launches from origin/mainline, untracked", async () => {
    const repo = await makeRenamedDefaultRepo();
    repo.git("checkout", "-q", "--detach");
    repo.git("branch", "-q", "-D", "main");
    const tip = repo.git("rev-parse", "origin/mainline");
    const out = await launchInto(repo);
    expect(out.status).toBe("running");
    expect(out.baseBranch).toBe("mainline");
    expect(out.parent).toBe(tip);
    expect(out.tracks).toBeNull();
    expect(out.change).toEqual(ownChangeOn(tip));
  });

  test("a detached-HEAD repo with no remote and no conventional branch is refused before any row exists", async () => {
    const repo = await makeRepo("feature");
    repo.git("checkout", "-q", "--detach");
    repo.git("branch", "-D", "feature");
    const projectId = `base-branch-${randomUUID().slice(0, 8)}`;
    const store = setUpStore(projectId, repo.dir);
    const app = createServer(store, () => {});
    const res = await app.request(`/api/projects/${projectId}/bootstrap-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain(`Cannot pick a base branch for ${repo.dir}`);
    expect(json.error).toContain("its HEAD is detached");
    expect(json.error).toContain("it has no origin/HEAD");
    expect(store.db.query("SELECT * FROM launches WHERE project_id = ?").all(projectId)).toHaveLength(0);
  });
});
