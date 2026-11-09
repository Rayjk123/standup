import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorConfig } from "./gate.js";
import { isolateWorktreeHooks, workerHooksDir } from "./worktree-hooks.js";

/*
 * A real repository with a hook in its shared `.git/hooks`, a worker worktree
 * isolated the way the launcher does it, and one left sharing the hooks.
 */

let tmp: string;
let repo: string;
let data: string;
let isolated: string;
let shared: string;
let fired: string;
let systemctlLog: string;
let stubSystemctl: string;

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      STANDUP_TEST: "1",
      STANDUP_TEST_SYSTEMCTL: stubSystemctl,
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function firedLines(): string[] {
  return lines(fired);
}

function floorConfig(root: string): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://localhost:7777",
    launchId: "launch-1",
    root,
    sharedBranches: ["main"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: data,
    floorPaths: [],
    installDir: join(tmp, "install"),
    protectedPaths: [join(data, "secrets")],
    tmpDirs: [],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

function bash(command: string, cwd: string) {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, floorConfig(cwd));
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "standup-hooks-")));
  repo = join(tmp, "repo");
  data = join(tmp, "data");
  isolated = join(tmp, "wt-isolated");
  shared = join(tmp, "wt-shared");
  fired = join(tmp, "fired.log");
  systemctlLog = join(tmp, "systemctl.log");
  // The hooks' systemctl is this stub, first on their PATH and named by
  // STANDUP_TEST_SYSTEMCTL, so the restart they simulate is recorded and never
  // reaches the real service manager.
  const stubBin = join(tmp, "bin");
  mkdirSync(stubBin);
  stubSystemctl = join(stubBin, "systemctl");
  writeFileSync(stubSystemctl, `#!/bin/sh\necho "$*" >> "${systemctlLog}"\n`);
  chmodSync(stubSystemctl, 0o755);
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  // The owner's hooks: each records that it ran and restarts a service, which
  // the floor holds. Under a test run (STANDUP_TEST=1, or NODE_ENV/BUN_ENV
  // "test") the hook calls only the stub named by STANDUP_TEST_SYSTEMCTL, and
  // skips the restart when none is named.
  for (const name of ["pre-commit", "post-checkout"]) {
    const hook = join(repo, ".git", "hooks", name);
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        `PATH="${stubBin}:$PATH"`,
        "export PATH",
        `echo "${name} $PWD" >> "${fired}"`,
        'if [ "$STANDUP_TEST" = 1 ] || [ "$NODE_ENV" = test ] || [ "$BUN_ENV" = test ]; then',
        '  if [ -n "$STANDUP_TEST_SYSTEMCTL" ]; then "$STANDUP_TEST_SYSTEMCTL" --user restart --no-block standup.service || true; fi',
        "else",
        "  systemctl --user restart --no-block standup.service || true",
        "fi",
        "",
      ].join("\n")
    );
    chmodSync(hook, 0o755);
  }
  git(repo, "worktree", "add", "-q", "-b", "isolated", isolated, "main");
  git(repo, "worktree", "add", "-q", "-b", "shared", shared, "main");
  const result = isolateWorktreeHooks(isolated, workerHooksDir(data));
  expect(result).toEqual({ ok: true });
  rmSync(fired, { force: true });
  rmSync(systemctlLog, { force: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("per-worktree hooks isolation", () => {
  test("the worktree's config points at the empty worker hooks dir; the main checkout keeps its hooks", () => {
    expect(git(isolated, "config", "--worktree", "--get", "core.hooksPath")).toBe(workerHooksDir(data));
    expect(git(isolated, "rev-parse", "--path-format=absolute", "--git-path", "hooks")).toBe(workerHooksDir(data));
    expect(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks")).toBe(join(repo, ".git", "hooks"));
    expect(git(shared, "rev-parse", "--path-format=absolute", "--git-path", "hooks")).toBe(join(repo, ".git", "hooks"));
  });

  test("a main-repo hook does not fire in the isolated worktree", () => {
    writeFileSync(join(isolated, "b.txt"), "b\n");
    git(isolated, "add", "b.txt");
    git(isolated, "commit", "-q", "-m", "b");
    git(isolated, "checkout", "-q", "-b", "isolated-2");
    expect(firedLines()).toEqual([]);
    expect(lines(systemctlLog)).toEqual([]);
  });

  test("the same hook still fires in the main checkout and in a worktree left sharing it", () => {
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "c");
    writeFileSync(join(shared, "d.txt"), "d\n");
    git(shared, "add", "d.txt");
    git(shared, "commit", "-q", "-m", "d");
    expect(firedLines()).toEqual([`pre-commit ${repo}`, `pre-commit ${shared}`]);
    expect(lines(systemctlLog)).toEqual([
      "--user restart --no-block standup.service",
      "--user restart --no-block standup.service",
    ]);
  });

  test("the floor lets the isolated worktree commit and check out, and holds the shared one", () => {
    expect(bash("git commit -m x", isolated)).toEqual({ action: "allow" });
    expect(bash("git checkout -b other", isolated)).toEqual({ action: "allow" });
    expect(bash("git commit -m x", shared).action).toBe("hold");
  });

  test("the floor allows the launcher's hooksPath setup, and other hooks paths unless they name a denylist target", () => {
    expect(bash(`git config --worktree core.hooksPath ${workerHooksDir(data)}`, isolated)).toEqual({ action: "allow" });
    expect(bash("git config extensions.worktreeConfig true", isolated)).toEqual({ action: "allow" });
    for (const command of ["git config --worktree core.hooksPath ./my-hooks", `git config --worktree core.hooksPath ${join(repo, ".git", "hooks")}`]) {
      expect({ command, action: bash(command, isolated).action }).toEqual({ command, action: "allow" });
    }
    // Any other setting that names Standup's data dir, or the Claude config, holds.
    for (const command of [`git config core.hooksPath ${workerHooksDir(data)}`, `git config --worktree --add core.hooksPath ${workerHooksDir(data)}`, "git config --worktree core.hooksPath ~/.claude/hooks"]) {
      expect({ command, action: bash(command, isolated).action }).toEqual({ command, action: "hold" });
    }
  });

  test("a hooks dir that is not empty is refused by the launcher; the floor reads it as any hooks path", () => {
    const dir = join(tmp, "full-hooks");
    expect(isolateWorktreeHooks(isolated, dir).ok).toBe(true);
    writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\n");
    expect(isolateWorktreeHooks(isolated, dir).ok).toBe(false);
    expect(bash(`git config --worktree core.hooksPath ${dir}`, isolated).action).toBe("allow");
  });
});
