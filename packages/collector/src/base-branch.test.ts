import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recordedBaseBranch, resolveBaseBranch } from "./base-branch.js";
import { defaultGitRunner } from "./review/stage.js";
import { createSystemExec, gitDefaultBranch } from "./restart/exec.js";
import { resolveTargetBranch } from "./target-branch.js";

/** Base-branch resolution against real temp git repos. */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function repo(initialBranch: string) {
  const dir = mkdtempSync(join(tmpdir(), "standup-base-branch-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString().trim();
  };
  git("init", "-q", "-b", initialBranch);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { dir, git };
}

/** A clone of `source`, so it has an origin and origin/HEAD. */
function cloneOf(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "standup-base-branch-clone-"));
  dirs.push(dir);
  const git = (...args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "clone", "-q", source, dir], { stdout: "pipe", stderr: "pipe" });
  return { dir, git };
}

describe("resolveBaseBranch", () => {
  test("a repo whose only branch is mainline resolves to mainline under the default `main` setting", () => {
    const r = repo("mainline");
    const base = resolveBaseBranch(r.dir, "main", defaultGitRunner, "standup");
    expect(base).toMatchObject({ branch: "mainline", ref: "mainline", source: "fallback" });
    expect(base.note).toContain('configured branch "main" does not exist');
  });

  test("a checkout on its owner's topic branch doesn't hand that branch to new launches", () => {
    const r = repo("mainline");
    r.git("checkout", "-q", "-b", "feature/wip");
    expect(resolveBaseBranch(r.dir, "main", defaultGitRunner)).toMatchObject({ branch: "mainline", source: "fallback" });
    const src = repo("mainline");
    const clone = cloneOf(src.dir);
    clone.git("checkout", "-q", "-b", "feature/wip");
    expect(resolveBaseBranch(clone.dir, "main", defaultGitRunner)).toMatchObject({ branch: "mainline", source: "origin-head" });
  });

  test("a configured `origin/<name>`, tag or other commit-ish is honored", () => {
    const r = repo("mainline");
    r.git("tag", "v1");
    expect(resolveBaseBranch(r.dir, "v1", defaultGitRunner)).toEqual({ branch: "v1", ref: "v1", source: "configured" });
    const clone = cloneOf(r.dir);
    expect(resolveBaseBranch(clone.dir, "origin/mainline", defaultGitRunner)).toEqual({
      branch: "mainline",
      ref: "mainline",
      source: "configured",
    });
  });

  test("a configured branch the repo has wins, with no note", () => {
    const r = repo("main");
    r.git("branch", "mainline");
    expect(resolveBaseBranch(r.dir, "main", defaultGitRunner)).toEqual({ branch: "main", ref: "main", source: "configured" });
    expect(resolveBaseBranch(r.dir, "mainline", defaultGitRunner)).toEqual({ branch: "mainline", ref: "mainline", source: "configured" });
  });

  test("a local `main` tracking origin/mainline stays `main`, and resolves to origin/mainline upstream", () => {
    const src = repo("mainline");
    const clone = cloneOf(src.dir);
    clone.git("checkout", "-q", "-b", "main", "--track", "origin/mainline");
    const base = resolveBaseBranch(clone.dir, "main", defaultGitRunner);
    expect(base).toEqual({ branch: "main", ref: "main", source: "configured" });
    expect(resolveTargetBranch(clone.dir, base.branch, defaultGitRunner)).toEqual({ local: "main", remote: "origin/mainline" });
  });

  test("a configured branch only on origin is used through its remote copy", () => {
    const src = repo("mainline");
    const clone = cloneOf(src.dir);
    clone.git("checkout", "-q", "-b", "feature");
    clone.git("branch", "-D", "mainline");
    expect(resolveBaseBranch(clone.dir, "mainline", defaultGitRunner)).toEqual({
      branch: "mainline",
      ref: "origin/mainline",
      source: "configured",
    });
  });

  test("with no configured, origin or conventional branch, the checked-out branch is the last resort", () => {
    const r = repo("trunk");
    expect(resolveBaseBranch(r.dir, undefined, defaultGitRunner)).toEqual({ branch: "trunk", ref: "trunk", source: "current" });
  });

  test("a detached HEAD falls to origin/HEAD's branch", () => {
    const src = repo("mainline");
    const clone = cloneOf(src.dir);
    clone.git("checkout", "-q", "--detach");
    clone.git("branch", "-D", "mainline");
    expect(resolveBaseBranch(clone.dir, "main", defaultGitRunner)).toMatchObject({
      branch: "mainline",
      ref: "origin/mainline",
      source: "origin-head",
    });
  });

  test("a detached HEAD with no remote falls to the first conventional branch that exists", () => {
    const r = repo("master");
    r.git("checkout", "-q", "--detach");
    expect(resolveBaseBranch(r.dir, "main", defaultGitRunner)).toMatchObject({ branch: "master", ref: "master", source: "fallback" });
  });

  test("a detached HEAD with no remote and no conventional branch is refused with a clear error", () => {
    const r = repo("feature");
    r.git("checkout", "-q", "--detach");
    r.git("branch", "-D", "feature");
    let message = "";
    try {
      resolveBaseBranch(r.dir, "main", defaultGitRunner, "demo");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`Cannot pick a base branch for ${r.dir}`);
    expect(message).toContain('the configured branch "main" does not exist');
    expect(message).toContain("its HEAD is detached");
    expect(message).toContain("it has no origin/HEAD");
    expect(message).toContain("none of main, mainline, master exist");
    expect(message).toContain('project "demo"\'s branch');
  });

  test("a directory that is not a git repository is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "standup-base-branch-plain-"));
    dirs.push(dir);
    expect(() => resolveBaseBranch(dir, "main", defaultGitRunner)).toThrow(`Not a git repository: ${dir}`);
  });
});

describe("recordedBaseBranch", () => {
  test("recordedBaseBranch (in-place, reused and provisioned launches) reads the repo and never throws", () => {
    const r = repo("mainline");
    expect(recordedBaseBranch(r.dir, "main", defaultGitRunner)).toBe("mainline");
    const bare = repo("feature");
    bare.git("checkout", "-q", "--detach");
    bare.git("branch", "-D", "feature");
    expect(recordedBaseBranch(bare.dir, "main", defaultGitRunner)).toBe("main");
    expect(recordedBaseBranch(join(r.dir, "gone"), "main", defaultGitRunner)).toBe("main");
  });
});

describe("gitDefaultBranch (restart follow branch)", () => {
  const exec = createSystemExec();

  test("an install on mainline follows mainline, even checked out elsewhere", async () => {
    const r = repo("mainline");
    r.git("checkout", "-q", "-b", "local-experiment");
    expect(await gitDefaultBranch(exec, r.dir)).toBe("mainline");
  });

  test("an install on main still follows main", async () => {
    const r = repo("main");
    expect(await gitDefaultBranch(exec, r.dir)).toBe("main");
  });

  test("origin/HEAD's branch wins over the conventional names", async () => {
    const src = repo("develop");
    src.git("branch", "main");
    const clone = cloneOf(src.dir);
    clone.git("branch", "main", "origin/main");
    expect(await gitDefaultBranch(exec, clone.dir)).toBe("develop");
  });

  test("none found is undefined", async () => {
    const r = repo("feature");
    expect(await gitDefaultBranch(exec, r.dir)).toBeUndefined();
  });
});
