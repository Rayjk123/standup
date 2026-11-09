import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { branchLanded } from "./pipeline/runners.js";
import { defaultGitRunner, reviewRefs } from "./review/stage.js";
import { localTargetBranch, resolveTargetBranch } from "./target-branch.js";

const root = mkdtempSync(join(tmpdir(), "target-branch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;

function git(dir: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function commit(dir: string, name: string): string {
  writeFileSync(join(dir, name), name);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", name);
  return git(dir, "rev-parse", "HEAD");
}

/** A bare upstream whose default branch is `upstreamBranch`, holding one commit, and a clone of it. */
function clonedRepo(upstreamBranch: string): { upstream: string; clone: string } {
  const id = `${++seq}`;
  const seed = join(root, `seed-${id}`);
  const upstream = join(root, `upstream-${id}.git`);
  const clone = join(root, `clone-${id}`);
  git(root, "init", "-q", "-b", upstreamBranch, seed);
  commit(seed, "README");
  git(root, "clone", "-q", "--bare", seed, upstream);
  git(root, "clone", "-q", upstream, clone);
  return { upstream, clone };
}

/** A clone of a `mainline` upstream whose local `main` tracks `origin/mainline`: a local default branch named unlike its upstream. */
function renamedDefaultRepo(): string {
  const { clone } = clonedRepo("mainline");
  git(clone, "checkout", "-q", "-b", "main", "--track", "origin/mainline");
  return clone;
}

describe("resolveTargetBranch", () => {
  const cases: Array<{ name: string; repo: () => string; configured?: string; local: string; remote: string }> = [
    { name: "plain main tracking origin/main", repo: () => clonedRepo("main").clone, configured: "main", local: "main", remote: "origin/main" },
    { name: "plain main, nothing configured", repo: () => clonedRepo("main").clone, local: "main", remote: "origin/main" },
    { name: "local main tracking origin/mainline", repo: renamedDefaultRepo, configured: "main", local: "main", remote: "origin/mainline" },
    { name: "local main tracking origin/mainline, nothing configured", repo: renamedDefaultRepo, local: "main", remote: "origin/mainline" },
    {
      name: "upstream wins over a stale origin/main",
      repo: () => {
        const dir = renamedDefaultRepo();
        git(dir, "push", "-q", "origin", "main:main");
        git(dir, "branch", "-q", "--set-upstream-to", "origin/mainline", "main");
        return dir;
      },
      configured: "main",
      local: "main",
      remote: "origin/mainline",
    },
    { name: "a mainline clone with no local main", repo: () => clonedRepo("mainline").clone, local: "mainline", remote: "origin/mainline" },
    {
      name: "local main with no upstream falls back to origin/HEAD",
      repo: () => {
        const dir = clonedRepo("mainline").clone;
        git(dir, "checkout", "-q", "--no-track", "-b", "main", "origin/mainline");
        return dir;
      },
      configured: "main",
      local: "main",
      remote: "origin/mainline",
    },
    {
      name: "a local-only branch other than main never falls back to origin/HEAD",
      repo: () => {
        const dir = clonedRepo("mainline").clone;
        git(dir, "checkout", "-q", "--no-track", "-b", "develop", "origin/mainline");
        return dir;
      },
      configured: "develop",
      local: "develop",
      remote: "origin/develop",
    },
    {
      name: "an upstream on another remote is not taken as the target's remote",
      repo: () => {
        const { upstream, clone } = clonedRepo("main");
        git(clone, "remote", "add", "fork", upstream);
        git(clone, "fetch", "-q", "fork");
        git(clone, "branch", "-q", "--set-upstream-to", "fork/main", "main");
        return clone;
      },
      configured: "main",
      local: "main",
      remote: "origin/main",
    },
    {
      name: "origin/HEAD naming a deleted branch is not used",
      repo: () => {
        const dir = clonedRepo("mainline").clone;
        git(dir, "checkout", "-q", "--no-track", "-b", "main", "origin/mainline");
        git(dir, "update-ref", "-d", "refs/remotes/origin/mainline");
        return dir;
      },
      configured: "main",
      local: "main",
      remote: "origin/main",
    },
    {
      name: "a repo with no remote",
      repo: () => {
        const dir = join(root, `local-${++seq}`);
        git(root, "init", "-q", "-b", "main", dir);
        commit(dir, "README");
        return dir;
      },
      local: "main",
      remote: "origin/main",
    },
    { name: "a configured name starting with a dash is not handed to git", repo: renamedDefaultRepo, configured: "-x", local: "-x", remote: "origin/-x" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(resolveTargetBranch(c.repo(), c.configured, defaultGitRunner)).toEqual({ local: c.local, remote: c.remote });
    });
  }

  test("an unreadable or missing checkout keeps the configured or fallback name", () => {
    expect(resolveTargetBranch(undefined, undefined, defaultGitRunner)).toEqual({ local: "main", remote: "origin/main" });
    expect(resolveTargetBranch(join(root, "missing"), "mainline", defaultGitRunner)).toEqual({ local: "mainline", remote: "origin/mainline" });
    expect(localTargetBranch(join(root, "missing"), " ", defaultGitRunner)).toBe("main");
  });
});

describe("landing against the resolved remote", () => {
  test("a branch merged into origin/mainline has landed in a main that tracks it", () => {
    const dir = renamedDefaultRepo();
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "feature.txt");
    expect(branchLanded(dir, "feature", "main", { remoteOnly: true }, defaultGitRunner)).toBe(false);
    git(dir, "push", "-q", "origin", "feature:mainline");
    expect(branchLanded(dir, "feature", "main", { remoteOnly: true }, defaultGitRunner)).toBe(true);
  });

  test("a branch merged into origin/main has landed in a plain main", () => {
    const dir = clonedRepo("main").clone;
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "feature.txt");
    expect(branchLanded(dir, "feature", "main", { remoteOnly: true }, defaultGitRunner)).toBe(false);
    git(dir, "push", "-q", "origin", "feature:main");
    expect(branchLanded(dir, "feature", "main", { remoteOnly: true }, defaultGitRunner)).toBe(true);
  });

  test("reviewRefs bases a change on origin/mainline when it is newer than the local main", () => {
    const dir = renamedDefaultRepo();
    git(dir, "checkout", "-q", "-b", "other");
    const upstreamTip = commit(dir, "upstream.txt");
    git(dir, "push", "-q", "origin", "other:mainline");
    git(dir, "checkout", "-q", "-b", "feature", "origin/mainline");
    commit(dir, "feature.txt");
    const refs = reviewRefs(dir, defaultGitRunner, "main");
    expect(refs.baseSha).toBe(upstreamTip);
    expect(refs.changedFiles).toEqual(["feature.txt"]);
  });
});
