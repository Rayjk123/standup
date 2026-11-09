import { beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type GitTree, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Test runs after a git step that writes files back from a tree the floor can
 * read (`git stash`, `git checkout -- <path>`, `git restore <path>`), and
 * after git steps that change no file. A step whose result the floor can't
 * read (partial stashes, filters, unread options, local history rewrites)
 * leaves the run unread, which runs unless the command names something held.
 * What still holds: a test run whose restored files push, a rewrite from a
 * patch or a remote, and any of these followed by a push.
 */

// ── This repository, with the real probes ───────────────────────────────────

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const REAL_HOME = join("/", "fake", "home");
const REAL_DATA = join(REAL_HOME, ".local", "share", "standup");

const realConfig: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: REPO,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: REAL_DATA,
  floorPaths: [join(REAL_DATA, "floor")],
  installDir: join(REAL_DATA, "install"),
  protectedPaths: [join(REAL_DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

function real(command: string, cwd = REPO): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, realConfig, { gitBranch: () => "standup/feat-1", homeDir: () => REAL_HOME });
}

describe("this repository's own test runs, after git steps", () => {
  const COLLECTOR = join(REPO, "packages", "collector");
  const runs: Array<[string, string]> = [
    ["bun test", REPO],
    ["bun test packages/collector/src/floor", REPO],
    // A suite that adds git remotes to fixture repos it makes with an imported helper.
    ["bun test packages/collector/src/pipeline/pipeline-closeout.test.ts", REPO],
    ["bun run typecheck", REPO],
    ["cd packages/collector && bun test src/floor/shell.test.ts", REPO],
    ["cd packages/collector && bun run typecheck", REPO],
    ["bun test src/floor/shell.test.ts", COLLECTOR],
    ["bun run typecheck", COLLECTOR],
    ["git status && bun test", REPO],
    ["git add -A && git commit -m wip && bun test", REPO],
    ["git stash list && bun test", REPO],
    ["git diff && bun run typecheck", REPO],
    ["git fetch origin && bun test", REPO],
    ["git log --oneline -3 && cd packages/collector && bun run typecheck", REPO],
    ["git show HEAD --stat && bun test packages/collector/src/floor", REPO],
    ["git stash && bun test", REPO],
    ["git stash push -m wip && bun test && git stash pop", REPO],
    ["git stash -u && bun run typecheck", REPO],
    ["git checkout -- packages/collector/src/floor/shell.ts && bun test", REPO],
    ["git checkout HEAD -- packages/collector/src/floor && bun test packages/collector/src/floor", REPO],
    ["git restore packages/collector/src/floor/shell.ts && bun test", REPO],
    ["git restore --staged --worktree packages/collector && bun test", REPO],
    ["git restore src/floor/shell.ts && bun test src/floor/shell.test.ts", COLLECTOR],
    ["git restore -h", REPO],
    ["git stash push -h", REPO],
    ["git commit --help", REPO],
  ];
  // A step that writes files back is classified twice (as done and as failed), each pass within the classifier's 8s budget,
  // past which it holds; under a loaded machine the whole repository's test run may take seconds per pass.
  test.each(runs)(
    "allows %p in %p",
    (command, cwd) => {
      const started = Date.now();
      expect({ command, verdict: real(command, cwd) }).toEqual({ command, verdict: { action: "allow" } });
      expect(Date.now() - started).toBeLessThan(2 * 8000);
    },
    60_000,
  );
});

// ── A virtual worktree ───────────────────────────────────────────────────────

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const OTHER = join("/", "tmp", "other-repo");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
/** A dir outside the worktree and the temp dirs. */
const ELSEWHERE = join("/", "srv", "repo");

const config: FloorConfig = {
  ...realConfig,
  launchId: "launch-1",
  root: ROOT,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
};

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "tsc --noEmit" } });
const PUSHING_PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "git push origin HEAD" } });
const SAFE_TEST = 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\n';
const EDITED_TEST = 'import { test, expect } from "bun:test";\ntest("adds", () => expect(2 + 2).toBe(4));\n';
const PUSHING_TEST = 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("publishes", () => { execSync("git push origin HEAD"); });\n';

const BLOBS: Record<string, string> = {
  "o-pkg": PACKAGE_JSON,
  "o-pkg-push": PUSHING_PACKAGE_JSON,
  "o-app": "export const app = 1;\n",
  "o-test": SAFE_TEST,
  "o-test-push": PUSHING_TEST,
  "o-attr-filter": "*.ts filter=lfs\n",
  "o-attr-plain": "*.png binary\n",
  "o-test-imports": 'import { test, expect } from "bun:test";\nimport { h } from "./helper";\ntest("h", () => expect(h).toBe(1));\n',
};

const A = "a".repeat(40);
const F = "f".repeat(40);

function tree(entries: Record<string, string>, commit: string): GitTree {
  return { commit, entries: new Map(Object.entries(entries).map(([path, oid]) => [path, { mode: "100644", oid }])) };
}

const HEAD = { "package.json": "o-pkg", "src/app.ts": "o-app", "src/app.test.ts": "o-test" };

/** What HEAD, the index and a pushing branch hold, the untracked files, files beyond FILES and the floor's own environment; each test starts from a clean tree. */
let head: GitTree;
let index: GitTree | null;
let revs: Record<string, GitTree>;
let untracked: string[] | null;
let extra: Record<string, string>;
let envs: Record<string, string>;

beforeEach(() => {
  head = tree(HEAD, A);
  index = tree(HEAD, "");
  revs = { "feat-push-test": tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, F) };
  untracked = [];
  extra = {};
  envs = {};
});

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "src", "app.ts")]: BLOBS["o-app"]!,
  // The worker's own uncommitted edit.
  [join(ROOT, "src", "app.test.ts")]: EDITED_TEST,
  [join(OTHER, ".git", "HEAD")]: "ref: refs/heads/main\n",
  [join(OTHER, "package.json")]: PACKAGE_JSON,
  [join(OTHER, "src", "app.test.ts")]: SAFE_TEST,
};

function probes(): Partial<FloorProbes> {
  const files = { ...FILES, ...extra };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const repos = new Set([ROOT, OTHER]);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === OTHER ? join(OTHER, ".git") : repos.has(dir) ? COMMON : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    // `lnk` is an untracked symlink to `src`.
    realpath: (p) => (p === join(ROOT, "lnk") ? join(ROOT, "src") : p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    env: (name) => envs[name],
    gitTree: (dir, rev) => (repos.has(dir) ? (rev === "HEAD" ? head : (revs[rev] ?? null)) : null),
    gitAncestor: () => null,
    gitBlob: (_dir, oid) => (oid in BLOBS ? { ok: true, text: BLOBS[oid]! } : { ok: false, reason: "missing" }),
    gitIndex: (dir) => (repos.has(dir) ? index : null),
    gitUntracked: (dir) => (repos.has(dir) ? untracked : null),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(command: string, cwd = ROOT): void {
  expect({ command, verdict: bash(command, cwd) }).toEqual({ command, verdict: { action: "allow" } });
}

function expectHeld(command: string, category: string, cwd = ROOT): void {
  expect({ command, verdict: bash(command, cwd) }).toMatchObject({ command, verdict: { action: "hold", category } });
}

describe("1. git steps that change no file leave the test run readable", () => {
  test.each([
    "bun test",
    "bun run typecheck",
    "git status && bun test",
    "git diff --stat && bun run typecheck && bun test",
    "git add -A && git commit -m wip && bun test",
    "git commit -am wip && bun run typecheck",
    "git log --oneline -3 && bun test",
    "git show HEAD && bun test",
    "git fetch origin && bun test",
    "git stash list && bun test",
    "git stash show -p && bun test",
    "git restore --staged src/app.test.ts && bun test",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });
});

describe("2. a stash puts every tracked file back to HEAD, which the floor reads", () => {
  test.each([
    "git stash && bun test",
    "git stash -u && bun test",
    "git stash push -m wip && bun run typecheck && bun test && git stash pop",
    'git stash push --include-untracked --message="wip" && bun test',
    "git stash save wip && bun test",
    "git stash -q; bun test",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("a test file HEAD holds that pushes holds, though the edit on disk doesn't", () => {
    head = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, A);
    expectHeld("git stash && bun test", "outward");
  });

  test("a package script HEAD holds that pushes holds", () => {
    head = tree({ ...HEAD, "package.json": "o-pkg-push" }, A);
    expectHeld("git stash && bun run typecheck", "outward");
  });

  test("a test file HEAD holds that was deleted on disk is read from HEAD", () => {
    head = tree({ ...HEAD, "src/push.test.ts": "o-test-push" }, A);
    expectHeld("git stash && bun test", "outward");
  });

  test.each([
    "git stash -k && bun test",
    "git stash --keep-index && bun test",
    "git stash --staged && bun test",
    "git stash -p && bun test",
    "git stash push -- src/app.ts && bun test",
    "git stash push src/app.ts && bun test",
    "git stash pop && bun test",
    "git stash apply && bun test",
    "git stash branch tmp && bun test",
    "git add -A && git stash && bun test",
    "git -c core.autocrlf=true stash && bun test",
    "GIT_INDEX_FILE=/tmp/i git stash && bun test",
  ])("allows %p, whose result the floor doesn't read but whose text names nothing held", (command) => {
    expectAllowed(command);
  });

  test("a stash followed by a merge of a local branch leaves the test run unread, and it runs", () => {
    expectAllowed("git stash && git merge feat-push-test && bun test");
    expectHeld("git stash && git merge feat-push-test && bun test && git push origin main", "outward");
  });

  test("a stash whose result the floor doesn't read, followed by a push, holds", () => {
    expectHeld("git stash -p && bun test && git push origin main", "outward");
  });

  test("an index entry git skips leaves its file as it is, and the stash runs", () => {
    index = null;
    expectAllowed("git stash && bun test");
  });

  test("a stash in another repository runs", () => {
    expectAllowed("git stash && bun test", OTHER);
  });

  test("filters in a .gitattributes HEAD holds leave the stash unread, and it runs", () => {
    head = tree({ ...HEAD, ".gitattributes": "o-attr-filter" }, A);
    expectAllowed("git stash && bun test");
  });

  test("a symlink HEAD holds leaves the stash unread, and it runs", () => {
    head = { commit: A, entries: new Map([...tree(HEAD, A).entries, ["src/link.ts", { mode: "120000", oid: "o-app" }]]) };
    expectAllowed("git stash && bun test");
  });
});

describe("3. checkout -- and restore write the named paths from the index or a revision", () => {
  test.each([
    "git checkout -- src/app.test.ts && bun test",
    "git checkout -- . && bun test",
    "git checkout -q -- src && bun run typecheck",
    "git checkout HEAD -- src/app.test.ts && bun test",
    "git restore src/app.test.ts && bun test",
    "git restore -- src/app.test.ts && bun test",
    "git restore --worktree src && bun test",
    "git restore -SW src/app.test.ts; git status",
    "git restore --staged --worktree src/app.test.ts && bun test",
    "git restore -s HEAD src/app.test.ts && bun test",
    "git restore --source=HEAD . && bun test",
    "cd src && git restore app.test.ts && bun test",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("a test file the index holds that pushes holds", () => {
    index = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, "");
    for (const command of ["git checkout -- src/app.test.ts && bun test", "git restore src/app.test.ts && bun test", "git restore src && bun test", "git checkout -- . && bun test"]) expectHeld(command, "outward");
  });

  test("a restore from HEAD reads HEAD, not the index", () => {
    index = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, "");
    expectAllowed("git checkout HEAD -- src/app.test.ts && bun test");
    expectAllowed("git restore -S -W src/app.test.ts && bun test");
    head = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, A);
    index = tree(HEAD, "");
    expectHeld("git checkout HEAD -- src/app.test.ts && bun test", "outward");
    expectHeld("git restore -S -W src/app.test.ts && bun test", "outward");
  });

  test("a restore from another branch reads that branch", () => {
    expectHeld("git checkout feat-push-test -- src/app.test.ts && bun test", "outward");
    expectHeld("git restore --source=feat-push-test src/app.test.ts && bun test", "outward");
    expectHeld("git restore -s feat-push-test src && bun test", "outward");
  });

  test("a path the restore doesn't name stays as it is on disk", () => {
    index = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, "");
    expectAllowed("git restore src/app.ts && bun test");
  });

  test.each([
    "git checkout main -- && bun test",
    "git checkout -- 'src/*.ts' && bun test",
    "git checkout -- ':(glob)src/**' && bun test",
    "git checkout -- ../outside.ts && bun test",
    "git checkout -- lnk/app.test.ts && bun test",
    "git restore lnk && bun test",
    "git checkout -f -- src/app.test.ts && bun test",
    "git checkout --ours -- src/app.test.ts && bun test",
    "git checkout $REV -- src/app.test.ts && bun test",
    "git checkout a b -- src/app.test.ts && bun test",
    "git checkout unknown-branch -- src/app.test.ts && bun test",
    "git checkout -- $F && bun test",
    "git restore && bun test",
    "git restore -p src/app.test.ts && bun test",
    "git restore --ours src/app.test.ts && bun test",
    "git restore -s $REV src/app.test.ts && bun test",
    "git restore -s unknown-branch src/app.test.ts && bun test",
    "git restore --pathspec-from-file=list && bun test",
    "git restore 'src/*' && bun test",
    "git add -A && git restore src/app.test.ts && bun test",
    "git restore src/app.ts && git checkout -- src/app.test.ts && bun test",
    "git -c core.autocrlf=true restore src/app.test.ts && bun test",
  ])("allows %p, whose result the floor doesn't read but whose text names nothing held", (command) => {
    expectAllowed(command);
  });

  test("an index the floor can't read leaves the restore unread, and it runs", () => {
    index = null;
    expectAllowed("git checkout -- src/app.test.ts && bun test");
    expectAllowed("git restore src/app.test.ts && bun test");
  });

  test("a restore whose result the floor doesn't read still holds when the command pushes", () => {
    expectHeld("git restore -p src/app.test.ts && bun test && git push origin main", "outward");
    expectHeld("git checkout -f -- src/app.test.ts && git push origin main", "outward");
  });
});

/** The shared config of a repository whose linked worktrees each have their own config.worktree, as Standup's worktrees do. */
const WORKTREE_SHARED_CONFIG =
  '[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = false\n[extensions]\n\tworktreeConfig = true\n[remote "origin"]\n\turl = ssh://git.example.com/standup\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n';

describe("5. attributes from anywhere git reads them leave a restore unread, which runs unless the command names something held", () => {
  const FILTER = "*.ts filter=lfs\n";
  const restores = [
    "git checkout -- src/app.test.ts && bun test",
    "git checkout HEAD -- src/app.test.ts && bun test",
    "git restore src/app.test.ts && bun test",
    "git restore --source=HEAD src/app.test.ts && bun test",
    "git restore -s HEAD src/app.test.ts && bun test",
    "git stash && bun test",
  ];

  test.each(restores)("filters in a .gitattributes only the index holds allow %p", (command) => {
    index = tree({ ...HEAD, ".gitattributes": "o-attr-filter" }, "");
    expectAllowed(command);
  });

  test.each(restores)("filters in a .gitattributes only the index holds, with a push after %p, hold", (command) => {
    index = tree({ ...HEAD, ".gitattributes": "o-attr-filter" }, "");
    expectHeld(`${command} && git push origin main`, "outward");
  });

  const sources: Array<[string, () => void]> = [
    ["the common dir's info/attributes", () => (extra[join(COMMON, "info", "attributes")] = FILTER)],
    ["a macro in the common dir's info/attributes", () => (extra[join(COMMON, "info", "attributes")] = "[attr]generated -diff\n")],
    ["/etc/gitattributes", () => (extra[join("/", "etc", "gitattributes")] = FILTER)],
    [
      "XDG_CONFIG_HOME's git/attributes",
      () => {
        envs.XDG_CONFIG_HOME = join("/", "fake", "xdg");
        extra[join("/", "fake", "xdg", "git", "attributes")] = FILTER;
      },
    ],
    ["a relative XDG_CONFIG_HOME", () => (envs.XDG_CONFIG_HOME = "xdg")],
    ["core.attributesFile in ~/.gitconfig", () => (extra[join(HOME, ".gitconfig")] = "[core]\n\tattributesFile = /fake/attrs\n")],
    ["core.attributesFile in the repository's config", () => (extra[join(COMMON, "config")] = "[core]\n\tattributesFile = /fake/attrs\n")],
    [
      "core.attributesFile in XDG_CONFIG_HOME's git/config",
      () => {
        envs.XDG_CONFIG_HOME = join("/", "fake", "xdg");
        extra[join("/", "fake", "xdg", "git", "config")] = "[core]\n\tattributesFile = /fake/attrs\n";
      },
    ],
    ["core.attributesFile in /etc/gitconfig", () => (extra[join("/", "etc", "gitconfig")] = "[core] attributesfile = /fake/attrs\n")],
    ["an include in ~/.gitconfig", () => (extra[join(HOME, ".gitconfig")] = "[include]\n\tpath = ~/.gitconfig.local\n")],
    [
      "core.attributesFile in the worktree's config.worktree",
      () => {
        extra[join(COMMON, "config")] = WORKTREE_SHARED_CONFIG;
        extra[join(COMMON, "worktrees", "feat-1", "config.worktree")] = "[core]\n\thookspath = /fake/hooks\n\tattributesFile = /fake/attrs\n";
      },
    ],
    [
      "an include in the worktree's config.worktree",
      () => {
        extra[join(COMMON, "config")] = WORKTREE_SHARED_CONFIG;
        extra[join(COMMON, "worktrees", "feat-1", "config.worktree")] = "[include]\n\tpath = /fake/more\n";
      },
    ],
    ["GIT_ATTR_SOURCE in the floor's environment", () => (envs.GIT_ATTR_SOURCE = "HEAD")],
    ["GIT_CONFIG_GLOBAL in the floor's environment", () => (envs.GIT_CONFIG_GLOBAL = "/fake/gitconfig")],
  ];
  for (const [label, arrange] of sources) {
    test.each(restores)(`${label} allows %p`, (command) => {
      arrange();
      expectAllowed(command);
    });
  }

  test.each(restores)("config and attributes that name no attributes file leave %p readable", (command) => {
    extra[join(HOME, ".gitconfig")] = "[user]\n\tname = Test User\n\temail = test@example.com\n";
    extra[join("/", "etc", "gitconfig")] = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\trequired = true\n';
    extra[join(COMMON, "config")] = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n";
    extra[join(COMMON, "info", "exclude")] = "*.log\n";
    envs.XDG_CONFIG_HOME = join("/", "fake", "xdg");
    index = tree({ ...HEAD, ".gitattributes": "o-attr-plain" }, "");
    expectAllowed(command);
  });

  test.each(restores)("a linked worktree whose own config.worktree only isolates its hooks leaves %p readable", (command) => {
    extra[join(COMMON, "config")] = WORKTREE_SHARED_CONFIG;
    extra[join(COMMON, "worktrees", "feat-1", "config.worktree")] = "[core]\n\thookspath = /fake/home/.local/share/standup/hooks/empty\n";
    envs.GIT_EDITOR = "true";
    expectAllowed(command);
  });

  test("a config.worktree the floor can't find leaves the stash unread, and it runs", () => {
    extra[join(COMMON, "config")] = WORKTREE_SHARED_CONFIG;
    extra[join(ROOT, ".git")] = "not a gitfile\n";
    expectAllowed("git stash && bun test");
  });
});

describe("6. git restore's options are read as git reads them", () => {
  beforeEach(() => {
    head = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, A);
  });

  test.each([
    "git restore --staged --wor src/app.test.ts && bun test",
    "git restore -S --work src/app.test.ts && bun test",
    "git restore --st --w src/app.test.ts && bun test",
    "git restore -S -qW src/app.test.ts && bun test",
    "git restore -SW src/app.test.ts && bun test",
    "git restore -Ws HEAD src/app.test.ts && bun test",
    "git restore -WsHEAD src/app.test.ts && bun test",
    "git restore --sou=HEAD src/app.test.ts && bun test",
    "git restore --sour HEAD src/app.test.ts && bun test",
    "git restore --staged --worktree src/app.test.ts && bun test",
  ])("reads %p as a restore from HEAD, whose test pushes", (command) => {
    expectHeld(command, "outward");
  });

  test.each([
    "git restore --s HEAD src/app.test.ts && bun test",
    "git restore --staged --bogus src/app.test.ts && bun test",
    "git restore -S -x src/app.test.ts && bun test",
    "git restore --staged --no-wor src/app.test.ts && bun test",
    "git restore --staged --no-staged src/app.test.ts && bun test",
    "git restore --worktree --no-worktree --staged src/app.test.ts && bun test",
    "git restore --wor=x src/app.test.ts && bun test",
    "git restore --source && bun test",
    "git restore --staged $W src/app.test.ts && bun test",
  ])("allows %p, whose options the floor doesn't read as one restore", (command) => {
    expectAllowed(command);
  });

  test.each(["git restore --sta src/app.test.ts && bun test", "git restore -S src/app.test.ts && bun test", "git restore -qS src/app.test.ts && bun test"])("allows %p, which restores only the index", (command) => {
    expectAllowed(command);
  });
});

describe("7. a stash of ignored files too deletes them, which leaves the test run unread", () => {
  test.each(["git stash -a && bun test", "git stash --all && bun run typecheck", "git stash push --all -m wip && bun test"])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("a stash of ignored files followed by a push holds", () => {
    expectHeld("git stash -a && bun test && git push origin main", "outward");
  });

  test("a stash of untracked files is still read", () => {
    expectAllowed("git stash -u && bun test");
  });
});

describe("8. a git built-in's usage text changes nothing", () => {
  test.each(["git restore -h", "git restore --help", "git stash push -h", "git stash -h", "git commit --help", "git commit -h", "git worktree add -h", "git remote add --help", "git push -h"])("allows %p, even in a repository outside the worktree", (command) => {
    expectAllowed(command);
    expectAllowed(command.replace(/^git /, `git -C ${ELSEWHERE} `));
  });

  test("a restore after the usage text still holds", () => {
    expectHeld(`cd ${ELSEWHERE} && git restore -h; git restore .`, "destructive");
    expectHeld(`git -C ${ELSEWHERE} restore -h && git -C ${ELSEWHERE} restore . && bun test`, "destructive");
  });

  test("a -h that is another option's value, or comes after other arguments, is read as the step", () => {
    expectHeld(`git -C ${ELSEWHERE} commit -m -h`, "destructive");
    expectHeld(`git -C ${ELSEWHERE} restore . -h`, "destructive");
    expectHeld(`git -C ${ELSEWHERE} stash pop --index -h`, "destructive");
  });

  test("git grep -h is grep's own option", () => {
    expectHeld("git grep -h \"-Ogit push origin HEAD\" foo", "outward");
  });

  test("an inline alias named like the built-in is read as the alias", () => {
    expectHeld("git -c alias.restore='!git push origin HEAD' restore -h", "outward");
  });

  test("-h with more words after it is read as the step", () => {
    // `git merge-index -h -a` runs `-h` as the merge program for every path.
    expect(bash(`git -C ${ELSEWHERE} merge-index -h -a`).action).toBe("hold");
    expectHeld(`git -C ${ELSEWHERE} restore -h .`, "destructive");
    expectHeld(`git -C ${ELSEWHERE} stash push -h -u`, "destructive");
  });

  test("an environment the command sets for the viewer or the repository is read as the step", () => {
    for (const env of ["PATH=/tmp/evil:$PATH", "GIT_DIR=/tmp/other/.git", "MANPAGER=/tmp/evil.sh", "export PAGER=/tmp/evil.sh;"]) {
      expect(bash(`${env} git push --help`).action).toBe("hold");
    }
  });
});

describe("10. config of the command's own that picks the viewer --help runs is read as the step", () => {
  test.each([
    "git -c man.viewer=evil -c 'man.evil.cmd=git push origin HEAD;' push --help",
    "git -c man.man.path=/tmp/evil.sh push --help",
    "git -c help.format=html -c help.browser=/tmp/evil.sh push --help",
    "git -c help.format=web -c web.browser=evil -c 'browser.evil.cmd=git push origin HEAD;' push --help",
    "git -c man.viewer=evil -c 'man.evil.cmd=git push origin HEAD;' help push",
    `git -C ${ELSEWHERE} -c man.viewer=evil -c 'man.evil.cmd=git push origin HEAD;' commit --help`,
    "git -c 'man.evil.cmd=git push origin HEAD;' restore -h",
  ])("holds %p", (command) => {
    expect({ command, verdict: bash(command) }).toMatchObject({ command, verdict: { action: "hold" } });
  });

  test("an environment-set viewer that names no held program allows the usage text", () => {
    expectAllowed("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=man.viewer GIT_CONFIG_VALUE_0=evil git commit --help");
  });

  test("a config step that installs a viewer command that pushes holds", () => {
    expectHeld("git config man.evil.cmd 'git push origin HEAD;'", "unseen-code");
  });

  test.each(["git config man.viewer evil", "git config help.browser /tmp/evil.sh", "git config browser.evil.path /tmp/evil.sh", "git config web.browser evil"])(
    "allows %p, a repository config change that names no held program",
    (command) => {
      expectAllowed(command);
    },
  );

  test("a help format alone names no program", () => {
    expectAllowed("git -c help.format=man status");
  });
});

describe("9. the files a stash or a restore from a revision deletes are read as missing", () => {
  // HEAD's root package.json has a `typecheck` that pushes; sub/ has its own, which a deletion leaves bun to find above it.
  const ROOT_PUSHING = { ...HEAD, "package.json": "o-pkg-push" };
  beforeEach(() => {
    head = tree(ROOT_PUSHING, A);
    index = tree(ROOT_PUSHING, "");
    extra[join(ROOT, "package.json")] = PUSHING_PACKAGE_JSON;
    extra[join(ROOT, "sub", "package.json")] = PACKAGE_JSON;
  });

  test("sub's own package.json is read where nothing deletes it", () => {
    expectAllowed("cd sub && bun run typecheck");
    expectAllowed("git stash && cd sub && bun run typecheck");
    expectAllowed("git stash -u && cd sub && bun run typecheck");
  });

  test("a stash deletes a file only the index holds", () => {
    index = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, "");
    expectHeld("git stash && cd sub && bun run typecheck", "outward");
    expectHeld("git stash push -m wip && cd sub && bun run typecheck", "outward");
  });

  test("a stash of untracked files deletes them", () => {
    untracked = ["sub/package.json"];
    expectHeld("git stash -u && cd sub && bun run typecheck", "outward");
    expectHeld("git stash push --include-untracked && cd sub && bun run typecheck", "outward");
    expectAllowed("git stash && cd sub && bun run typecheck");
  });

  test("a stash of untracked files the floor can't list runs unread", () => {
    untracked = null;
    expectAllowed("git stash -u && bun test");
    expectAllowed("git stash && bun test");
  });

  test("a restore from HEAD deletes a file only the index holds", () => {
    index = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, "");
    expectHeld("git restore -SW . && cd sub && bun run typecheck", "outward");
    expectHeld("git restore --staged --worktree sub && cd sub && bun run typecheck", "outward");
    expectHeld("git restore --source=HEAD . && cd sub && bun run typecheck", "outward");
  });

  test("a restore from a revision deletes a tracked file the revision lacks", () => {
    index = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, "");
    head = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, A);
    revs = { "feat-nosub": tree(ROOT_PUSHING, F) };
    expectHeld("git restore --source=feat-nosub . && cd sub && bun run typecheck", "outward");
    expectHeld("git restore -s feat-nosub sub && cd sub && bun run typecheck", "outward");
  });

  test("a restore that names other paths, or writes from the index, deletes nothing there", () => {
    index = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, "");
    expectAllowed("git restore -SW src && cd sub && bun run typecheck");
    expectAllowed("git restore . && cd sub && bun run typecheck");
  });

  test("a checkout of paths overlays them and deletes nothing", () => {
    index = tree({ ...ROOT_PUSHING, "sub/package.json": "o-pkg" }, "");
    expectAllowed("git checkout HEAD -- . && cd sub && bun run typecheck");
    expectAllowed("git checkout -- . && cd sub && bun run typecheck");
  });
});

describe("11. a stash's message is no option, whatever it looks like", () => {
  // HEAD's test imports ./helper, the edit on disk doesn't; the untracked src/helper.ts pushes when imported.
  beforeEach(() => {
    head = tree({ ...HEAD, "src/app.test.ts": "o-test-imports" }, A);
    index = tree({ ...HEAD, "src/app.test.ts": "o-test-imports" }, "");
    untracked = ["src/helper.ts"];
    extra[join(ROOT, "src", "helper.ts")] = 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\nexport const h = 1;\n';
  });

  test.each(["git stash push -m -u && bun test", "git stash --message -u && bun test", "git stash -m -u && bun test", "git stash push -m -m -q && bun test", "git stash && bun test"])(
    "holds %p, which leaves the untracked helper HEAD's test imports",
    (command) => {
      expectHeld(command, "outward");
    },
  );

  test.each(["git stash -u && bun test", "git stash push -m wip -u && bun test", "git stash push -m -m -u && bun test", "git stash --message=-u -u && bun test"])("allows %p, which deletes the untracked helper", (command) => {
    expectAllowed(command);
  });

  test("a message the floor can't read leaves the stash unread, and it runs", () => {
    expectAllowed("git stash push -m $MSG && bun test");
  });
});

describe("12. options before the git subcommand that change what it does leave the step unread, which runs unless the command names something held", () => {
  beforeEach(() => {
    head = tree({ ...HEAD, "src/app.test.ts": "o-test-push" }, A);
  });

  test.each([
    "git --icase-pathspecs restore -s HEAD SRC && bun test",
    "git --icase-pathspecs checkout HEAD -- SRC && bun test",
    "GIT_ICASE_PATHSPECS=1 git restore -s HEAD SRC && bun test",
    "export GIT_ICASE_PATHSPECS=1; git restore -s HEAD SRC && bun test",
    "git --literal-pathspecs restore -s HEAD src && bun test",
    "git --glob-pathspecs restore -s HEAD src && bun test",
    "git --noglob-pathspecs restore -s HEAD src && bun test",
    "git --bare restore -s HEAD src && bun test",
    "git --namespace=x restore -s HEAD src && bun test",
    "git --no-replace-objects restore -s HEAD src && bun test",
    "git -p restore -s HEAD src && bun test",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("an option before the subcommand the floor doesn't read, with a push after, holds", () => {
    expectHeld("git --bare restore -s HEAD src && bun test && git push origin main", "outward");
  });

  test.each(["GIT_ICASE_PATHSPECS", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])("%s in the floor's environment leaves a restore unread, and it runs", (name) => {
    envs[name] = "1";
    expectAllowed("git restore -s HEAD SRC && bun test");
    expectAllowed("git restore -s HEAD src && bun test");
  });

  test.each(["git --attr-source=attrs stash && bun test", "git --attr-source attrs restore src/app.test.ts && bun test", "git --attr-source=attrs checkout -- src/app.test.ts && bun test"])(
    "allows %p, whose attributes come from a tree the floor doesn't read",
    (command) => {
      head = tree(HEAD, A);
      revs.attrs = tree({ ...HEAD, ".gitattributes": "o-attr-filter" }, F);
      expectAllowed(command);
    },
  );

  test.each(["git --no-pager restore -s HEAD src && bun test", "git -P restore -s HEAD src && bun test", "git --no-optional-locks restore -s HEAD src && bun test", "git -C . restore -s HEAD src && bun test"])("reads %p as the restore, whose test pushes", (command) => {
    expectHeld(command, "outward");
  });

  test.each(["git --no-pager stash && bun test", "git -C . restore src/app.test.ts && bun test"])("allows %p", (command) => {
    head = tree(HEAD, A);
    expectAllowed(command);
  });

  test.each([`git -C ${ELSEWHERE} --bare restore -h`, `git -C ${ELSEWHERE} --exec-path=/tmp/x commit --help`, `git -C ${ELSEWHERE} --namespace=x stash -h`, `git -C ${ELSEWHERE} --icase-pathspecs restore --help`])(
    "holds %p, whose options before the subcommand the floor doesn't read as usage text",
    (command) => {
      expect({ command, verdict: bash(command) }).toMatchObject({ command, verdict: { action: "hold" } });
    },
  );

  test.each([`git -C ${ELSEWHERE} --no-pager restore -h`, `git -P -C ${ELSEWHERE} commit --help`])("allows %p, whose options before the subcommand leave the usage text alone", (command) => {
    expectAllowed(command);
  });
});

describe("4. git steps that rewrite the tree from local history run unread; from a patch or a remote they hold", () => {
  test.each(["git rebase feat-push-test && bun run typecheck", "git reset --hard HEAD~1 && bun test", "git cherry-pick feat-push-test && bun test", "git stash pop; bun test", "git merge feat-push-test && bun test"])("allows %p", (command) => {
    expectAllowed(command);
  });

  test.each(["git pull && bun test", "git apply x.patch && bun test"])("holds %p", (command) => {
    expectHeld(command, "unclassified");
  });

  test("a local rewrite followed by a push holds", () => {
    expectHeld("git reset --hard HEAD~1 && bun test && git push origin main", "outward");
  });
});
