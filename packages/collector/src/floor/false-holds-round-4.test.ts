import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type GitTree, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A third round of safe worker commands the floor held, and the outward
 * steps of the same shape that must still hold: unzip modes that only print,
 * and `env` assignments with expansions; and package scripts after a merge,
 * which stay held. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const SCRATCH = join("/", "tmp", "land-batch");
/** A clone of another repository under the temp dir. */
const OTHER = join("/", "tmp", "other-repo");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");

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

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "tsc --noEmit" } });
const PUSHING_PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "git push origin HEAD" } });
const SAFE_TEST = 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\n';
const PUSHING_TEST = 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("publishes", () => { execSync("git push origin HEAD"); });\n';

const BLOBS: Record<string, string> = {
  "o-pkg": PACKAGE_JSON,
  "o-pkg-push": PUSHING_PACKAGE_JSON,
  "o-app-base": "export const app = 0;\n",
  "o-app-head": "export const app = 1;\n",
  "o-app-other": "export const app = 2;\n",
  "o-test": SAFE_TEST,
  "o-test-push": PUSHING_TEST,
  "o-extra": "export const extra = 1;\n",
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const F = "f".repeat(40);
const G = "1".repeat(40);

function tree(entries: Record<string, string>, commit: string): GitTree {
  return { commit, entries: new Map(Object.entries(entries).map(([path, oid]) => [path, { mode: "100644", oid }])) };
}

const BASE = { "package.json": "o-pkg", "src/app.ts": "o-app-base", "src/app.test.ts": "o-test" };
const HEAD = { ...BASE, "src/app.ts": "o-app-head" };

/** The land branch at HEAD and the branches merged into it, all forked from BASE (commit B). */
const REVS: Record<string, GitTree> = {
  HEAD: tree(HEAD, A),
  "land/batch": tree(HEAD, A),
  // Adds a file only it changes: a clean merge.
  "feat-extra": tree({ ...BASE, "src/extra.ts": "o-extra" }, C),
  // Changes the file HEAD changed too: a content merge.
  "feat-clash": tree({ ...BASE, "src/app.ts": "o-app-other" }, D),
  // Changes the package script to an outward step.
  "feat-push": tree({ ...BASE, "package.json": "o-pkg-push" }, E),
  // Adds a test that pushes.
  "feat-push-test": tree({ ...BASE, "src/push.test.ts": "o-test-push" }, F),
  // Already contains HEAD: a fast-forward.
  "feat-ahead": tree({ ...HEAD, "src/extra.ts": "o-extra" }, G),
  [B]: tree(BASE, B),
};

/** `<commit> in <commit>`: ancestry that holds. */
const CONTAINS = [`${B} in ${A}`, `${B} in ${C}`, `${B} in ${D}`, `${B} in ${E}`, `${B} in ${F}`, `${A} in ${G}`, `${B} in ${G}`];

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(SCRATCH, ".git")]: `gitdir: ${COMMON}/worktrees/land-batch\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(SCRATCH, "package.json")]: PACKAGE_JSON,
  [join(OTHER, ".git", "HEAD")]: "ref: refs/heads/main\n",
  [join(OTHER, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "src", "app.ts")]: BLOBS["o-app-head"]!,
  [join(SCRATCH, "src", "app.ts")]: BLOBS["o-app-head"]!,
  [join(ROOT, "src", "app.test.ts")]: SAFE_TEST,
  [join(SCRATCH, "src", "app.test.ts")]: SAFE_TEST,
  [join(ROOT, "src", "index.ts")]: "console.log(1);\n",
  [join(ROOT, "build", "app.jar")]: "PK",
  [join(ROOT, "x.zip")]: "PK",
  [join(DATA, "standup.db")]: "",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, SCRATCH]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  dirs.delete(join(SCRATCH, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  // The other repository holds the same revisions, but is not this repository.
  const repos = new Set([ROOT, SCRATCH, OTHER]);
  return {
    gitBranch: (dir) => (dir === SCRATCH ? "land/batch" : "standup/feat-1"),
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === OTHER ? join(OTHER, ".git") : repos.has(dir) ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: (dir, rev) => (repos.has(dir) ? (REVS[rev] ?? null) : null),
    gitAncestor: (dir, commit, of) => (repos.has(dir) ? commit === of || CONTAINS.includes(`${commit} in ${of}`) : null),
    gitBlob: (_dir, oid) => (oid in BLOBS ? { ok: true, text: BLOBS[oid]! } : { ok: false, reason: "missing" }),
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

describe("1. unzip that only prints, lists or tests writes nothing", () => {
  const reads = [
    "unzip -p build/app.jar META-INF/MANIFEST.MF",
    "unzip -p build/app.jar META-INF/MANIFEST.MF | head -20",
    "unzip -qp build/app.jar a/b.properties",
    "unzip -c x.zip readme.txt",
    "unzip -l x.zip",
    "unzip -lv x.zip",
    "unzip -t x.zip",
    "unzip -v x.zip",
    "unzip -Z x.zip",
    "unzip -Z1 x.zip",
    "unzip -z x.zip",
  ];
  test.each(reads)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test.each(reads)("allows %p outside the worktree too", (command) => {
    expectAllowed(bash(command.replace(/ (build\/app\.jar|x\.zip)/, ` ${ROOT}/$1`), HOME));
  });

  test("a real extraction outside the worktree is classified as before", () => {
    // The home dir holds Claude Code's settings, so extracting there is floor-tamper.
    const zip = join(ROOT, "x.zip");
    for (const command of [`unzip ${zip}`, `unzip -o ${zip}`, `unzip -qo ${zip}`, `unzip -p ${zip} -d .`, `unzip -x ${zip} -d .`]) expectHeld(bash(command, HOME), "floor-tamper");
    expectHeld(bash(`unzip -q ${zip} -d ${join("/", "srv", "out")}`), "destructive");
  });
});

describe("2. env skips NAME=VALUE operands whose value it can't read", () => {
  test("the program is the first word that isn't an assignment", () => {
    expectAllowed(bash("env -i PATH=/usr/bin:/bin USER=$USER LANG=C.UTF-8 bun run src/index.ts"));
    expectAllowed(bash('env -i HOME="$HOME" USER="$USER" TERM=$TERM bun --version'));
    expectAllowed(bash("env FOO=\"${BAR:-x}\" node -e 'console.log(1)'"));
  });

  test("what the program does, and an env hook set to an unreadable value, still hold", () => {
    expectHeld(bash("env -i USER=$USER git push origin HEAD"), "outward");
    expectHeld(bash("env -i BASH_ENV=$F bash -c 'echo hi'"), "unclassified");
    expectHeld(bash("env PATH=$P:/usr/bin bun run src/index.ts"), "unclassified");
  });

  test("a word whose name is computed is still the program", () => {
    expect(bash("env $NAME=1 bun --version").action).toBe("hold");
  });

  test("an unquoted value that isn't the session's own variable may split into the program, so it holds", () => {
    expect(bash("env FOO=$X true").action).toBe("hold");
    expect(bash("env -i FOO=$X LANG=C bun --version").action).toBe("hold");
  });
});

describe("3. package scripts after a git merge stay unread, which runs", () => {
  // The floor doesn't compute a merge's result, so what a later script or test run executes is unread:
  // it comes from the repository's own history, and runs unless the call names a denylist target.
  const unread = [
    "git merge feat-extra; bun run typecheck; bun test",
    "git merge --no-ff --no-edit feat-extra && bun run typecheck && bun test",
    'git merge -m "land feat-extra" feat-extra && bun test',
    "git merge feat-ahead && bun run typecheck",
    "git merge feat-clash && bun run typecheck",
    "git merge feat-push && bun run typecheck",
  ];
  test.each(unread)("allows %p in a scratch worktree of the same repo", (command) => {
    expectAllowed(bash(command, SCRATCH));
  });

  test.each(unread)("allows %p in the worker's own worktree", (command) => {
    expectAllowed(bash(command));
  });

  test("allows after a cd into the scratch worktree, and in another repo", () => {
    expectAllowed(bash(`cd ${SCRATCH} && git merge feat-extra && bun run typecheck && bun test`));
    expectAllowed(bash("git merge feat-extra && bun run typecheck", OTHER));
  });

  test("holds a merge followed by a run and a push", () => {
    expectHeld(bash("git merge feat-extra && bun run typecheck && git push origin HEAD:main"), "outward");
  });

  test("a merge with no package script after it runs", () => {
    expectAllowed(bash("git merge --no-edit feat-extra"));
    expectAllowed(bash("git merge feat-extra && git log --oneline -3"));
  });
});
