import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Commits, ref renames and resets on a branch named like a shared one, in a
 * repository under a temp dir that has its own `.git` dir and no remote: it
 * can't publish them, so they aren't outward. The same steps in the worker's
 * worktree, the install, a temp-dir worktree of a shared repository, or a
 * temp-dir repository with a remote (or config the floor can't read) still
 * hold, as does every push. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join(INSTALL, ".git");

/** A freshly initialized repository under the temp dir: its own `.git` dir, branch master, no remote. */
const BARE_TMP = join("/", "tmp", "base-claude");
/** The same, nested below other dirs, and a dir inside it. */
const NESTED = join("/", "tmp", "wsb-claude", "src", "Pkg");
const NESTED_SUB = join(NESTED, "lib");
/** A copy of the Standup repo under the temp dir with a fresh `.git` dir, branch master, no remote. */
const COPY = join("/", "tmp", "r5-item7");
/** The same, with a test that pushes. */
const PUSH_COPY = join("/", "tmp", "r5-push-copy");
/** A temp-dir repository with a remote. */
const REMOTED = join("/", "tmp", "remoted");
/** A temp-dir repository whose config includes a file the floor can't read. */
const INCLUDED = join("/", "tmp", "included");
/** A temp-dir repository whose config rewrites URLs or names a push URL outside a remote section. */
const REWRITES = join("/", "tmp", "rewrites");
/** A temp-dir repository whose config can't be read. */
const UNREADABLE = join("/", "tmp", "unreadable");
/** A temp-dir repository with a legacy `remotes/` file. */
const LEGACY = join("/", "tmp", "legacy");
/** A worktree under the temp dir of the install repository. */
const TMP_WT = join("/", "tmp", "wt-of-install");
/** A worktree under the temp dir of BARE_TMP (a gitfile, not its own `.git` dir). */
const TMP_WT_OF_BARE = join("/", "tmp", "wt-of-bare");
/** A temp-dir checkout whose `.git` is a gitfile naming a separate git dir under the temp dir. */
const SEPARATE = join("/", "tmp", "separate");
const SEPARATE_GIT = join("/", "tmp", "separate-git");
/** A repository outside the temp dirs with its own `.git` dir and no remote. */
const ELSEWHERE = join("/", "srv", "repo");
/** A temp-dir repository of its own `.git` dir and no remote, whose entries a test may link into the install's git dir (`links`). */
const LINKED = join("/", "tmp", "linked");
/** A temp-dir repository with no remote whose hooks dir holds a hook that pushes. */
const HOOKED = join("/", "tmp", "hooked");
/** A copy of the Standup repo under the temp dir whose collector tests commit and whose web tests run no git, with no remote; and the same with one. */
const WEB_COPY = join("/", "tmp", "r5-web-copy");
const WEB_REMOTED = join("/", "tmp", "r5-web-remoted");

const LOCAL_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";
/** Temp-dir repositories whose config git reads as more than the floor would by its lines' first `[`, or with keys that run a command: label → config. */
const TRICKS: Record<string, string> = {
  "a section after another on one line": `${LOCAL_CONFIG}[core] [remote "origin"]\n\turl = https://example.com/x.git\n`,
  "a key after a section on one line": `${LOCAL_CONFIG}[core] editor = sh /tmp/evil.sh\n`,
  "a carriage return between sections": `${LOCAL_CONFIG}[core]\r[remote "origin"]\n\turl = https://example.com/x.git\n`,
  "a carriage return before a key": `${LOCAL_CONFIG}[core]\r\teditor = sh /tmp/evil.sh\n`,
  "a continued value": `${LOCAL_CONFIG}[user]\n\tname = a \\\n\tb\n`,
  "an old-style subsection": `${LOCAL_CONFIG}[remote.origin]\n\turl = https://example.com/x.git\n`,
  "a spaced header": `${LOCAL_CONFIG}[ remote "origin" ]\n\turl = https://example.com/x.git\n`,
  "a capitalized include": `${LOCAL_CONFIG}[Include]\n\tpath = /tmp/inc\n`,
  "a subsection of an allowed section": `${LOCAL_CONFIG}[diff "x"]\n\ttextconv = sh /tmp/evil.sh\n`,
  "a header with trailing text": `${LOCAL_CONFIG}[core]x\n`,
  "a key before any section": `editor = sh /tmp/evil.sh\n${LOCAL_CONFIG}`,
  "core.editor": `${LOCAL_CONFIG}\teditor = sh /tmp/evil.sh\n`,
  "core.fsmonitor": `${LOCAL_CONFIG}\tfsmonitor = /tmp/evil.sh\n`,
  "core.hooksPath": `${LOCAL_CONFIG}\thooksPath = /tmp/hk\n`,
  "core.sshCommand": `${LOCAL_CONFIG}\tsshCommand = sh /tmp/evil.sh\n`,
  "core.pager": `${LOCAL_CONFIG}\tpager = sh /tmp/evil.sh\n`,
  "core.askPass": `${LOCAL_CONFIG}\taskPass = /tmp/evil.sh\n`,
  "core.gitProxy": `${LOCAL_CONFIG}\tgitProxy = /tmp/evil.sh\n`,
  "core.worktree": `${LOCAL_CONFIG}\tworktree = /tmp/elsewhere\n`,
  "core.attributesFile": `${LOCAL_CONFIG}\tattributesFile = /tmp/attrs\n`,
  "core.excludesFile": `${LOCAL_CONFIG}\texcludesFile = /tmp/excludes\n`,
  "diff.external": `${LOCAL_CONFIG}[diff]\n\texternal = /tmp/evil.sh\n`,
  "commit.gpgSign": `${LOCAL_CONFIG}[commit]\n\tgpgSign = true\n`,
  "log.showSignature": `${LOCAL_CONFIG}[log]\n\tshowSignature = true\n`,
};
const trickTop = (label: string) => join("/", "tmp", `trick-${label.replace(/\W+/g, "-")}`);
/** A temp-dir repository whose config holds the user's name and email, the default branch, comments and blank lines. */
const DRESSED = join("/", "tmp", "dressed");
const DRESSED_CONFIG = `${LOCAL_CONFIG}\n# [remote "origin"] is set up later\n[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main ; the default\n[advice]\n\tdetachedHead = false\n`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test" } });
const COMMITTING_TEST = 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("commits", () => { execSync("git commit -qm fixture"); });\n';
const RENAMING_TEST = 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("renames", () => { execSync("git branch -m baseline"); });\n';
const PUSHING_TEST = 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("publishes", () => { execSync("git push origin HEAD"); });\n';
const WEB_TEST = 'import { expect, test } from "bun:test";\ntest("renders", () => { expect(["a", "b"].join("")).toBe("ab"); });\n';
const PUSHING_HOOK = "#!/bin/sh\ngit push https://example.com/x.git main\n";

/** Each repository: its top dir, the `.git` entry there (a dir, or a gitfile's text), its common dir, branch and config. */
interface Repo {
  top: string;
  gitfile?: string;
  common: string;
  branch: string;
  config: string | null;
}

const REPOS: Repo[] = [
  { top: ROOT, gitfile: `gitdir: ${COMMON}/worktrees/feat-1\n`, common: COMMON, branch: "main", config: null },
  { top: INSTALL, common: COMMON, branch: "main", config: null },
  { top: BARE_TMP, common: join(BARE_TMP, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: NESTED, common: join(NESTED, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: COPY, common: join(COPY, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: PUSH_COPY, common: join(PUSH_COPY, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: REMOTED, common: join(REMOTED, ".git"), branch: "master", config: `${LOCAL_CONFIG}[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` },
  { top: INCLUDED, common: join(INCLUDED, ".git"), branch: "master", config: `${LOCAL_CONFIG}[include]\n\tpath = ../../shared.gitconfig\n` },
  { top: REWRITES, common: join(REWRITES, ".git"), branch: "main", config: `${LOCAL_CONFIG}[url "https://example.com/"]\n\tpushInsteadOf = x:\n` },
  { top: UNREADABLE, common: join(UNREADABLE, ".git"), branch: "main", config: null },
  { top: LEGACY, common: join(LEGACY, ".git"), branch: "main", config: LOCAL_CONFIG },
  { top: TMP_WT, gitfile: `gitdir: ${COMMON}/worktrees/wt-of-install\n`, common: COMMON, branch: "main", config: null },
  { top: TMP_WT_OF_BARE, gitfile: `gitdir: ${BARE_TMP}/.git/worktrees/wt-of-bare\n`, common: join(BARE_TMP, ".git"), branch: "main", config: LOCAL_CONFIG },
  { top: SEPARATE, gitfile: `gitdir: ${SEPARATE_GIT}\n`, common: SEPARATE_GIT, branch: "master", config: LOCAL_CONFIG },
  { top: ELSEWHERE, common: join(ELSEWHERE, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: DRESSED, common: join(DRESSED, ".git"), branch: "master", config: DRESSED_CONFIG },
  { top: LINKED, common: join(LINKED, ".git"), branch: "main", config: LOCAL_CONFIG },
  { top: HOOKED, common: join(HOOKED, ".git"), branch: "main", config: LOCAL_CONFIG },
  { top: WEB_COPY, common: join(WEB_COPY, ".git"), branch: "master", config: LOCAL_CONFIG },
  { top: WEB_REMOTED, common: join(WEB_REMOTED, ".git"), branch: "master", config: `${LOCAL_CONFIG}[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` },
  ...Object.entries(TRICKS).map(([label, text]) => ({ top: trickTop(label), common: join(trickTop(label), ".git"), branch: "master", config: text })),
];

const FILES: Record<string, string> = {
  [join(INSTALL, ".git", "config")]: `${LOCAL_CONFIG}[remote "origin"]\n\turl = ssh://git.example.com/standup\n`,
  [join(LEGACY, ".git", "remotes", "origin")]: "URL: https://example.com/x.git\nPush: refs/heads/main\n",
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(COPY, "package.json")]: PACKAGE_JSON,
  [join(COPY, "src", "commit.test.ts")]: COMMITTING_TEST,
  [join(COPY, "lib", "rename.test.ts")]: RENAMING_TEST,
  [join(COPY, "packages", "collector", "src", "floor", "commit.test.ts")]: COMMITTING_TEST,
  [join(COPY, "packages", "collector", "src", "floor", "rename.test.ts")]: RENAMING_TEST,
  [join(PUSH_COPY, "package.json")]: PACKAGE_JSON,
  [join(PUSH_COPY, "src", "commit.test.ts")]: COMMITTING_TEST,
  [join(PUSH_COPY, "pub", "push.test.ts")]: PUSHING_TEST,
  [join(REMOTED, "package.json")]: PACKAGE_JSON,
  [join(REMOTED, "src", "commit.test.ts")]: COMMITTING_TEST,
  [join(TMP_WT, "package.json")]: PACKAGE_JSON,
  [join(TMP_WT, "src", "commit.test.ts")]: COMMITTING_TEST,
  [join(ROOT, "src", "commit.test.ts")]: COMMITTING_TEST,
  [join(COMMON, "HEAD")]: "ref: refs/heads/main\n",
  [join(COMMON, "refs", "heads", "main")]: `${"a".repeat(40)}\n`,
  [join(COMMON, "logs", "refs", "heads", "main")]: "",
  [join(COMMON, "packed-refs")]: "",
  [join(LINKED, ".git", "refs", "heads", "main")]: `${"b".repeat(40)}\n`,
  [join(LINKED, ".git", "logs", "refs", "heads", "main")]: "",
  [join(LINKED, ".git", "objects", "info", "packs")]: "",
  [join(HOOKED, ".git", "hooks", "reference-transaction")]: PUSHING_HOOK,
  [join(HOOKED, ".git", "hooks", "post-commit")]: PUSHING_HOOK,
};
for (const top of [WEB_COPY, WEB_REMOTED]) {
  FILES[join(top, "package.json")] = PACKAGE_JSON;
  FILES[join(top, "packages", "collector", "src", "floor", "commit.test.ts")] = COMMITTING_TEST;
  FILES[join(top, "packages", "collector", "src", "floor", "rename.test.ts")] = RENAMING_TEST;
  FILES[join(top, "packages", "web", "src", "app.test.ts")] = WEB_TEST;
  FILES[join(top, "packages", "web", "src", "lib", "format.test.ts")] = WEB_TEST;
}

/** Symlinks in the virtual machine, link → target; each test starts with none. */
let links: Record<string, string> = {};
/** Repositories whose hooks dir the floor finds; each test starts with none. */
let hooked = new Set<string>();
beforeEach(() => {
  links = {};
  hooked = new Set();
});

/** `p` with every link it passes through followed. */
function resolveLinks(p: string): string {
  for (const [l, t] of Object.entries(links)) if (p === l || p.startsWith(`${l}/`)) return resolveLinks(t + p.slice(l.length));
  return p;
}
for (const r of REPOS) {
  if (r.gitfile) FILES[join(r.top, ".git")] = r.gitfile;
  if (r.config !== null && !FILES[join(r.common, "config")]) FILES[join(r.common, "config")] = r.config;
  FILES[join(r.common, "HEAD")] = `ref: refs/heads/${r.branch}\n`;
}

function repoOf(dir: string): Repo | null {
  let best: Repo | null = null;
  for (const r of REPOS) if ((dir === r.top || dir.startsWith(`${r.top}/`)) && (!best || r.top.length > best.top.length)) best = r;
  return best;
}

function probes(): Partial<FloorProbes> {
  // `/tmp/x` is an empty dir that isn't a repository.
  const dirs = new Set<string>(["/", "/tmp", join("/", "tmp", "x"), NESTED_SUB, join(LEGACY, ".git", "remotes")]);
  for (const r of REPOS) {
    dirs.add(r.top);
    if (!r.gitfile) dirs.add(r.common);
  }
  dirs.add(SEPARATE_GIT);
  for (const f of [...Object.keys(FILES), ...dirs]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  for (const r of REPOS) if (r.gitfile) dirs.delete(join(r.top, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const present = (p: string) => p in FILES || dirs.has(p);
  const parentResolved = (p: string) => join(resolveLinks(p.slice(0, p.lastIndexOf("/")) || "/"), p.slice(p.lastIndexOf("/") + 1));
  return {
    gitBranch: (dir) => repoOf(dir)?.branch ?? null,
    gitAlias: () => null,
    gitHooksDir: (dir) => {
      const r = repoOf(dir);
      return r && hooked.has(r.top) ? join(r.common, "hooks") : null;
    },
    gitCommonDir: (dir) => repoOf(dir)?.common ?? null,
    readFile: (p) => {
      const r = resolveLinks(p);
      return r in FILES ? { ok: true, text: FILES[r]! } : r === join(UNREADABLE, ".git", "config") ? { ok: false, reason: "unreadable" } : { ok: false, reason: "missing" };
    },
    exists: (p) => present(resolveLinks(p)),
    isDirectory: (p) => dirs.has(resolveLinks(p)),
    listDir: (p) => {
      const r = resolveLinks(p);
      if (!dirs.has(r)) return null;
      const names = [...Object.keys(FILES), ...dirs, ...Object.keys(links)].filter((f) => f.startsWith(`${r === "/" ? "" : r}/`)).map((f) => f.slice(r.length + 1).split("/")[0]!);
      return [...new Set(names)];
    },
    realpath: (p) => {
      const r = resolveLinks(p);
      return present(r) ? r : null;
    },
    lstat: (p) => {
      const at = parentResolved(p);
      if (at in links) return { symlink: true, file: false, nlink: 1 };
      return at in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(at) ? { symlink: false, file: false, nlink: 2 } : null;
    },
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    env: () => undefined,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string): void {
  expect(v).toMatchObject({ action: "hold", category });
}

/** Held as outward, or as something stronger that names the outward step too (the install is floor-tamper first). */
function expectOutward(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
  const held = v as { category: string; reason: string };
  expect(held.category === "outward" || held.reason.includes("outward:")).toBe(true);
}

describe("ref writes on a shared-named branch of a temp-dir repository with no remote", () => {
  const local = [
    `git -C ${BARE_TMP} commit -qm baseline`,
    `git -C ${BARE_TMP} branch -m baseline`,
    `git -C ${BARE_TMP} commit --amend --no-edit`,
    `git -C ${BARE_TMP} reset --hard HEAD~1`,
    `git -C ${BARE_TMP} merge feat`,
    `git -C ${BARE_TMP} branch -D master`,
    `git -C ${BARE_TMP} branch -f main HEAD~1`,
    `git -C ${NESTED} branch -m baseline`,
    `git -C ${NESTED_SUB} commit -qm baseline`,
    `cd ${BARE_TMP} && git add -A && git commit -qm base`,
    `cd ${NESTED_SUB} && git commit -qm base && git branch -m baseline`,
  ];
  test.each(local)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("allows the same from the repository itself", () => {
    expectAllowed(bash("git commit -qm baseline", BARE_TMP));
    expectAllowed(bash("git branch -m baseline", NESTED));
  });

  test.each([
    "cd /tmp/x && git init -q && git add -A && git commit -qm base",
    "mkdir -p /tmp/y && cd /tmp/y && git init -q -b main && git commit -q --allow-empty -m base && git branch -m baseline",
    "git init -q /tmp/z && git -C /tmp/z commit -q --allow-empty -m base && git -C /tmp/z branch -m baseline",
    "git init -q /tmp/z && git -C /tmp/z checkout -q -b main && git -C /tmp/z commit -q --allow-empty -m base",
    "cd /tmp/x && git init -q && git checkout -b master && git add -A && git commit -qm base && git branch -m baseline",
  ])("allows %p in a temp dir that isn't a repository yet", (command) => {
    expectAllowed(bash(command));
  });
});

describe("a test run in a temp-dir repository with no remote", () => {
  test("a test that commits or renames the branch in the run's cwd still holds", () => {
    // The test code runs before its git step and may rewrite the repository the floor read, so a git step found in code is not trusted to stay local.
    expectHeld(bash(`cd ${COPY} && bun test src/commit.test.ts`), "outward");
    expectHeld(bash("bun test src/commit.test.ts", COPY), "outward");
    expectHeld(bash("bun test lib/rename.test.ts", COPY), "outward");
    expectHeld(bash(`cd ${COPY} && timeout 600 bun test packages/collector/src/floor > /tmp/r5-item7-suite.log 2>&1`), "outward");
  });

  test("a test that pushes still holds", () => {
    expectHeld(bash("bun test pub/push.test.ts", PUSH_COPY), "outward");
    expectHeld(bash(`cd ${PUSH_COPY} && bun test`), "outward");
    expectHeld(bash(`cd ${PUSH_COPY} && bun test src`), "outward");
  });

  test("the same commit test holds where the repository can publish", () => {
    expectHeld(bash("bun test src/commit.test.ts", REMOTED), "outward");
    expectHeld(bash("bun test src/commit.test.ts", TMP_WT), "outward");
    expectHeld(bash("bun test src/commit.test.ts"), "outward");
  });
});

describe("shared-branch writes that still hold", () => {
  const writes = ["commit -qm x", "merge feat", "branch -m baseline", "branch -D master", "reset --hard HEAD~1", "branch -f main HEAD~1"];
  const where: Array<[string, string]> = [
    ["the worker's worktree", ROOT],
    ["the install", INSTALL],
    ["a temp-dir repository with a remote", REMOTED],
    ["a temp-dir repository including config the floor can't read", INCLUDED],
    ["a temp-dir repository rewriting push URLs", REWRITES],
    ["a temp-dir repository whose config can't be read", UNREADABLE],
    ["a temp-dir repository with a legacy remotes file", LEGACY],
    ["a temp-dir worktree of the install", TMP_WT],
    ["a temp-dir worktree of a temp-dir repository", TMP_WT_OF_BARE],
    ["a temp-dir checkout with a separate git dir", SEPARATE],
    ["a repository outside the temp dirs", ELSEWHERE],
  ];
  for (const [label, dir] of where) {
    test.each(writes)(`holds %p in ${label}`, (w) => {
      // The branch the step names, or the one checked out there, is shared.
      expectOutward(bash(`git -C ${dir} ${w}`));
    });
  }

  const relinked = [
    `cd ${BARE_TMP} && git remote add origin https://example.com/x.git && git commit -qm x`,
    `cd ${BARE_TMP} && git remote add fork https://example.com/x.git && git commit -qm x`,
    `cd ${BARE_TMP} && git config remote.fork.url https://example.com/x.git && git commit -qm x`,
    `git -C ${BARE_TMP} config --add remote.fork.url https://example.com/x.git; git -C ${BARE_TMP} branch -m baseline`,
    `cd ${BARE_TMP} && echo '[remote "o"]' >> .git/config && git commit -qm x`,
    `cd ${BARE_TMP} && printf 'gitdir: ${COMMON}/worktrees/x\\n' > .git && git commit -qm x`,
    `rm -rf ${BARE_TMP}/.git && ln -s ${COMMON} ${BARE_TMP}/.git && git -C ${BARE_TMP} commit -qm x`,
    `rm -rf ${BARE_TMP} && git worktree add ${BARE_TMP} && git -C ${BARE_TMP} commit -qm x`,
    `mv ${BARE_TMP} /tmp/old && mv ${TMP_WT} ${BARE_TMP} && git -C ${BARE_TMP} commit -qm x`,
    `cp -r ${INSTALL}/.git ${BARE_TMP}/ && git -C ${BARE_TMP} commit -qm x`,
    `git clone ${INSTALL} ${NESTED_SUB} && git -C ${NESTED_SUB} commit -qm x`,
    `git -C ${BARE_TMP} init -q --separate-git-dir=/tmp/elsewhere && git -C ${BARE_TMP} commit -qm x`,
    `git -C ${BARE_TMP} -c remote.origin.url=https://example.com/x.git commit -qm x`,
    `git --git-dir=${BARE_TMP}/.git commit -qm x`,
    `git --work-tree=${BARE_TMP} -C ${BARE_TMP} commit -qm x`,
    `GIT_DIR=${COMMON} git -C ${BARE_TMP} commit -qm x`,
    `cd ${BARE_TMP} && export GIT_DIR=${COMMON} && git commit -qm x`,
    `GIT_CONFIG_PARAMETERS="'remote.origin.url'='https://example.com/x.git'" git -C ${BARE_TMP} commit -qm x`,
    `git clone -q ${INSTALL} /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`,
    `git init -q /tmp/z && git -C /tmp/z remote add fork https://example.com/x.git && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`,
    `git init -q --template=/tmp/t /tmp/z && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`,
    `git init -q /tmp/z && printf 'gitdir: ${COMMON}\\n' > /tmp/z/.git && git -C /tmp/z checkout -b main && git -C /tmp/z commit -qm x`,
  ];
  test.each(relinked)("holds %p: the repository isn't what the floor read", (command) => {
    expectOutward(bash(command));
  });

  const raced = [
    `git -C ${BARE_TMP} commit -qm x & printf 'gitdir: ${COMMON}/worktrees/x\\n' > ${BARE_TMP}/.git; wait`,
    `(sleep 1; git -C ${BARE_TMP} commit -qm x) & rm -rf ${BARE_TMP}/.git && ln -s ${COMMON} ${BARE_TMP}/.git; wait`,
    `git -C ${BARE_TMP} branch -m baseline | mv ${TMP_WT}/.git ${BARE_TMP}/`,
  ];
  test.each(raced)("holds %p: a step alongside it may relink the repository", (command) => {
    const v = bash(command);
    expectOutward(v);
    expect((v as { reason: string }).reason).toContain("a step run alongside it may change");
  });

  test("every push from a temp-dir repository with no remote to somewhere it can reach still holds", () => {
    // With no remote anywhere, a push with no destination has nowhere to go.
    expectAllowed(bash(`git -C ${BARE_TMP} push`));
    expectHeld(bash(`git -C ${BARE_TMP} push origin`), "outward");
    expectHeld(bash(`git -C ${BARE_TMP} push https://example.com/x.git master`), "outward");
    expectHeld(bash(`cd ${BARE_TMP} && git remote add origin https://example.com/x.git && git push -u origin master`), "outward");
    expectHeld(bash(`git -C ${BARE_TMP} -c remote.origin.url=https://example.com/x.git push origin master`), "outward");
    expectHeld(bash(`cd ${BARE_TMP} && git commit -qm x && git push https://example.com/x.git master`), "outward");
  });

  test("a temp dir that was a repository with a remote before git init keeps it", () => {
    expectHeld(bash(`cd ${REMOTED} && git init -q && git commit -qm x`), "outward");
  });
});

describe("a temp-dir repository's config is read as git reads it", () => {
  test.each(Object.keys(TRICKS))("holds a shared-branch commit where the config has %s", (label) => {
    expectOutward(bash(`git -C ${trickTop(label)} commit -qm x`));
    expectOutward(bash("git branch -m baseline", trickTop(label)));
  });

  test("a config of known keys, comments and blank lines leaves the repository unpublishable", () => {
    expectAllowed(bash(`git -C ${DRESSED} commit -qm x`));
    expectAllowed(bash("git branch -m baseline", DRESSED));
  });
});

describe("steps alongside a shared-named branch write that leave the repository alone", () => {
  test.each([
    `git -C ${BARE_TMP} commit -qm x 2>&1 | tail -5`,
    `git -C ${BARE_TMP} commit -qm x & echo started > /tmp/r5-log; wait`,
  ])("allows %p", (command) => {
    expectAllowed(bash(command));
  });
});

describe("a temp-dir repository whose git dir links into another repository's", () => {
  const writes = [
    `git -C ${LINKED} commit -qm x`,
    `git -C ${LINKED} branch -m main gone`,
    `git -C ${LINKED} branch -D main`,
    `git -C ${LINKED} branch -f main HEAD~1`,
    `git -C ${LINKED} reset --hard HEAD~1`,
    `git -C ${LINKED} update-ref refs/heads/main ${"f".repeat(40)}`,
    `git -C ${LINKED} update-ref -d refs/heads/main`,
  ];

  test.each(writes)("allows %p where every entry is its own", (command) => {
    expectAllowed(bash(command));
  });

  const linked: Array<[string, string]> = [
    ["refs", join(COMMON, "refs")],
    ["refs/heads", join(COMMON, "refs", "heads")],
    ["refs/heads/main", join(COMMON, "refs", "heads", "main")],
    ["objects", join(COMMON, "objects")],
    ["packed-refs", join(COMMON, "packed-refs")],
    ["HEAD", join(COMMON, "HEAD")],
    ["logs", join(COMMON, "logs")],
    ["logs/refs/heads/main", join(COMMON, "logs", "refs", "heads", "main")],
    ["config", join(COMMON, "config")],
    ["hooks", join(COMMON, "hooks")],
  ];
  for (const [entry, target] of linked) {
    test.each(writes)(`holds %p where .git/${entry} links into the install's git dir`, (command) => {
      links[join(LINKED, ".git", entry)] = target;
      expectOutward(bash(command));
    });
  }

  test("a commondir file sends the refs to another repository", () => {
    FILES[join(LINKED, ".git", "commondir")] = `${COMMON}\n`;
    try {
      for (const command of writes) expectOutward(bash(command));
    } finally {
      delete FILES[join(LINKED, ".git", "commondir")];
    }
  });

  test.each([
    `cd ${LINKED} && rm -rf .git/refs && ln -s ${COMMON}/refs .git/refs && git commit -qm x`,
    `ln -sfn ${COMMON}/refs ${LINKED}/.git/refs && git -C ${LINKED} branch -f main HEAD~1`,
    `mv ${LINKED}/.git/refs /tmp/old-refs && ln -s ${COMMON}/refs ${LINKED}/.git/refs && git -C ${LINKED} update-ref -d refs/heads/main`,
    `mkdir -p /tmp/z && cd /tmp/z && git init -q && rm -rf .git/refs && ln -s ${COMMON}/refs .git/refs && git checkout -q -b main && git commit -q --allow-empty -m x`,
    `rm -rf ${LINKED}/.git/packed-refs && git -C ${LINKED} branch -D main`,
  ])("holds %p, which links the git dir out in the same command", (command) => {
    expectOutward(bash(command));
  });

  test("a reference-transaction or post-commit hook that pushes is read", () => {
    hooked.add(HOOKED);
    for (const command of [`git -C ${HOOKED} commit -qm x`, `git -C ${HOOKED} branch -f main HEAD~1`, `git -C ${HOOKED} update-ref -d refs/heads/main`, `git -C ${HOOKED} reset --hard HEAD~1`]) {
      expectHeld(bash(command), "outward");
    }
  });
});

describe("options before the git subcommand that change which repository it writes leave a temp-dir repository unread", () => {
  const F = "f".repeat(40);
  test.each([
    `git -C ${BARE_TMP} --bare update-ref refs/heads/main ${F}`,
    `git -C ${BARE_TMP} --bare branch -f main ${F}`,
    `cd ${BARE_TMP} && git --bare branch -D master`,
    `cd ${BARE_TMP} && git --bare commit -qm x`,
    `git --bare -C ${BARE_TMP} branch -m baseline`,
    `git -C ${BARE_TMP} --namespace=x update-ref refs/heads/main ${F}`,
    `git -C ${BARE_TMP} --super-prefix=x/ branch -f main ${F}`,
    `git -C ${BARE_TMP} --literal-pathspecs commit -qm x`,
    `git -C ${BARE_TMP} --icase-pathspecs commit -qm x`,
    `git -C ${BARE_TMP} --attr-source=HEAD commit -qm x`,
    `git -C ${BARE_TMP} --no-replace-objects commit -qm x`,
    `git -C ${BARE_TMP} --config-env=user.name=U commit -qm x`,
    `GIT_NAMESPACE=x git -C ${BARE_TMP} update-ref refs/heads/main ${F}`,
    `GIT_OBJECT_DIRECTORY=/tmp/o git -C ${BARE_TMP} commit -qm x`,
    `git --work-tree=w -C ${BARE_TMP} commit -qm x`,
    `git --git-dir=.git -C ${BARE_TMP} commit -qm x`,
    "git --bare init -q /tmp/z && git -C /tmp/z checkout -q -b main && git -C /tmp/z commit -q --allow-empty -m x",
  ])("holds %p", (command) => {
    expectOutward(bash(command));
  });

  test.each([
    `git -C ${BARE_TMP} update-ref refs/heads/main ${F}`,
    `git -C ${BARE_TMP} branch -f main ${F}`,
    `git -C ${BARE_TMP} --no-pager commit -qm baseline`,
    `git -P -C ${BARE_TMP} branch -m baseline`,
    `git -C ${BARE_TMP} --no-optional-locks commit -qm baseline`,
  ])("allows %p, whose options before the subcommand leave the repository as it is", (command) => {
    expectAllowed(bash(command));
  });
});

describe("a test run of the web package in a temp-dir copy of the Standup repo", () => {
  // `bun test <dir>` is a substring filter: the floor reads the test files whose path holds it, and a git step in test code is not trusted to stay in a repository without a remote, so a run that selects the collector tests holds on a shared-named branch.
  test("a web run on the copy's master selects only the web tests, which run no git", () => {
    expectAllowed(bash(`cd ${WEB_COPY} && bun test packages/web`));
    expectAllowed(bash("bun test packages/web", WEB_COPY));
  });

  test("the collector tests, which commit, hold on the copy's master", () => {
    expectHeld(bash("bun test packages/collector", WEB_COPY), "outward");
    expectHeld(bash("bun test", WEB_COPY), "outward");
  });

  test("with a remote the web run, which runs no git, is allowed", () => {
    expectAllowed(bash("bun test packages/web", WEB_REMOTED));
  });

  test("a filter that also matches the collector tests' path holds for their commits", () => {
    expectHeld(bash("bun test packages/", WEB_COPY), "outward");
    expectHeld(bash("bun test src/", WEB_REMOTED), "outward");
  });

  test("with a remote the collector tests' commits hold", () => {
    expectHeld(bash("bun test packages/collector", WEB_REMOTED), "outward");
    expectHeld(bash("bun test", WEB_REMOTED), "outward");
  });
});

describe("a git mv or rm earlier in the command leaves a temp-dir repository unread", () => {
  test.each([
    `git -C ${BARE_TMP} mv a .git/x; git -C ${BARE_TMP} commit -qm x`,
    `git -C ${BARE_TMP} mv a .git/config; git -C ${BARE_TMP} commit -qm x`,
    `git -C ${BARE_TMP} rm -q .git/config; git -C ${BARE_TMP} commit -qm x`,
  ])("holds %p", (command) => {
    expectOutward(bash(command));
  });
});

describe("the user's and the system's git config apply to a temp-dir repository too", () => {
  const writes = [`git -C ${BARE_TMP} commit -qm x`, `git -C ${BARE_TMP} branch -m baseline`, `git -C ${BARE_TMP} reset --hard HEAD~1`];
  const globals: [string, string][] = [
    [join(HOME, ".gitconfig"), '[remote "origin"]\n\turl = https://example.com/x.git\n[branch "master"]\n\tremote = origin\n'],
    [join(HOME, ".gitconfig"), '[url "https://example.com/"]\n\tinsteadOf = gh:\n'],
    [join(HOME, ".gitconfig"), "[include]\n\tpath = /tmp/more.cfg\n"],
    [join(HOME, ".config", "git", "config"), '[remote "origin"]\n\turl = https://example.com/x.git\n'],
    [join("/", "etc", "gitconfig"), '[remote "origin"]\n\turl = https://example.com/x.git\n'],
  ];
  test.each(globals)("a remote, rewrite or include in %p holds a shared-named branch write", (file, text) => {
    FILES[file] = text;
    try {
      for (const command of writes) expectOutward(bash(command));
    } finally {
      delete FILES[file];
    }
  });

  test("a user config with only identity and filters leaves it allowed", () => {
    FILES[join(HOME, ".gitconfig")] = "[user]\n\tname = t\n\temail = t@example.com\n";
    FILES[join("/", "etc", "gitconfig")] = '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n';
    try {
      for (const command of writes) expectAllowed(bash(command));
    } finally {
      delete FILES[join(HOME, ".gitconfig")];
      delete FILES[join("/", "etc", "gitconfig")];
    }
  });
});
