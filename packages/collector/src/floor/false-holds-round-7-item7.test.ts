import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A file a test run executes, whose call that runs a command is handed a
 * path built by adding literals to a value the code computes:
 * `execSync("rm -rf " + dir + "/")`, `spawnSync("rm", ["-rf", dir + "/"])`.
 * The floor reads such a call's literals joined as its command text, so the
 * `/` that continues `dir`'s word read as a path of its own, `rm -rf /`, and
 * the run was held as deleting the root. A path literal one step below a
 * name the file binds only to a temp dir it makes fresh (`mkdtemp` under
 * `tmpdir()`, or a path below one) is read under that name. Added to any
 * other value (the environment, the home dir, a call, `import.meta.dir`),
 * it is read as written, and a delete built on it holds. Literals deleting
 * `/` themselves and the same code outside a test run are held as before.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
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

const TEST_FILE = join(ROOT, "src", "x.test.ts");
const FS_UTILS = join(ROOT, "src", "fs-utils.ts");

/** A test file importing `imports` (one `import` line each) whose test body is `body`. */
const testFile = (imports: string[], body: string) => ['import { test } from "bun:test";', ...imports, `test("x", async () => { ${body} });`, ""].join("\n");

const CP = 'import { execSync, spawnSync } from "child_process";';
const MKDTEMP = ['import { mkdtempSync } from "fs";', 'import { tmpdir } from "os";', 'import { join } from "path";', 'const dir = mkdtempSync(join(tmpdir(), "x-"));'];

function probes(source: string, utils?: string): Partial<FloorProbes> {
  const files: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
    [join(ROOT, "package.json")]: JSON.stringify({ scripts: { test: "bun test" } }),
    [TEST_FILE]: source,
  };
  if (utils !== undefined) files[FS_UTILS] = utils;
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    lstat: (p) => (p in files ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
    env: () => undefined,
  };
}

const R = "/tmp/x";
const ISOLATED = [
  `HOME=${R}/home`,
  `XDG_CONFIG_HOME=${R}/xdg/config`,
  `XDG_DATA_HOME=${R}/xdg/data`,
  `XDG_CACHE_HOME=${R}/xdg/cache`,
  `XDG_STATE_HOME=${R}/xdg/state`,
  `TMPDIR=${R}/tmp`,
  `DB_PATH=${R}/standup.db`,
  `STANDUP_SQLITE_PATH=${R}/standup.db`,
  `KNOWLEDGE_DIR=${R}/kb`,
  `STANDUP_INTERNAL_ROOT=${R}/internal`,
  `STANDUP_PROJECT_DOCS_DIR=${R}/docs`,
].join(" ");
/** The isolated run, the prefix form, and a plain run of the test file. */
const RUNS = [`env -i PATH=/usr/bin:/bin ${ISOLATED} bun test src/x.test.ts`, `${ISOLATED} bun test src/x.test.ts`, "bun test src/x.test.ts"];

function bash(command: string, source: string, utils?: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(source, utils));
}

function expectRunsAllowed(source: string, utils?: string): void {
  for (const command of RUNS) expect({ command, source, v: bash(command, source, utils) }).toEqual({ command, source, v: { action: "allow" } });
}

function expectRunsHeld(source: string, reason?: string): void {
  for (const command of RUNS) {
    const v = bash(command, source);
    expect({ command, source, action: v.action }).toEqual({ command, source, action: "hold" });
    if (reason !== undefined && v.action === "hold") expect(v.reason).toContain(reason);
  }
}

describe("7. a path literal added to a computed value in a test run", () => {
  test.each([
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/");'),
    testFile([CP, ...MKDTEMP], 'spawnSync("rm", ["-rf", dir + "/"]);'),
    testFile([CP, ...MKDTEMP], 'execSync(["rm", "-rf", dir + "/"].join(" "));'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/sub");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/*");'),
    testFile([CP, ...MKDTEMP, 'const sub = join(dir, "a");'], 'execSync("rm -rf " + sub + "/");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + `${dir}` + "/");'),
    testFile([CP, 'import { mkdtempSync } from "fs";', 'import { tmpdir } from "os";', 'import { join } from "path";', "let dir: string;", 'dir = mkdtempSync(join(tmpdir(), "x-"));'], 'execSync("rm -rf " + dir + "/");'),
  ])("allows a run of %p", (source) => {
    expectRunsAllowed(source);
  });

  // A value the floor can't place as a temp dir the file made fresh (the environment, a call, `import.meta.dir`, a name
  // bound some other way too), or a path deeper below one, is read as written; a delete built on it holds.
  test.each([
    testFile([CP], 'execSync("rm -rf " + import.meta.dir + "/fixtures/tmp");'),
    testFile([CP], 'const d = process.env.SCRATCH; execSync("rm -rf " + d + "/");'),
    testFile([CP], 'const d = process.env.SCRATCH; spawnSync("rm", ["-rf", d + "/sub"]);'),
    testFile([CP], 'execSync("rm -rf " + (process.env.SCRATCH ?? "/tmp/s") + "/");'),
    testFile([CP], 'execSync("rm -rf " + process.env.STANDUP_DATA_DIR + "/worktrees");'),
    testFile([CP, 'import { homedir as hd } from "os";'], 'execSync("rm -rf " + hd() + "/Documents");'),
    testFile([CP, 'import { join } from "path";', 'import { homedir } from "os";'], 'execSync("rm -rf " + join(homedir(), "Documents"));'),
    testFile([CP, 'import { rmRf } from "./fs-utils";'], 'execSync("rm -rf " + dir() + "/"); rmRf("/tmp/zz");'),
    testFile([CP], 'execSync("rm -rf " + unbound + "/");'),
    testFile([CP, ...MKDTEMP, 'let other = dir;', 'other = process.env.HOME;'], 'execSync("rm -rf " + other + "/");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/a/");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/a/b");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/..");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + "/" + process.env.SUB);'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf /fake/home/" + dir + "/");'),
    testFile([CP, ...MKDTEMP, 'import { symlinkSync } from "fs";'], 'symlinkSync("/fake/home", dir + "-l"); execSync("rm -rf " + dir + "/");'),
    testFile([CP, ...MKDTEMP], 'execSync("rm -rf " + dir + " && ln -s /fake/home " + dir); execSync("rm -rf " + dir + "/");'),
    testFile([CP, ...MKDTEMP, 'import { mock } from "bun:test";', 'mock.module("os", () => ({ tmpdir: () => "/fake/home" }));'], 'execSync("rm -rf " + dir + "/");'),
  ])("holds a run of %p", (source) => {
    expectRunsHeld(source);
  });

  test("an imported delete helper's name and module path alone delete nothing", () => {
    expectRunsAllowed(testFile(['import { rmRf, removeAll, deleteTree } from "./fs-utils";', 'import { rmSync } from "fs";', 'import { rm } from "fs/promises";', ...MKDTEMP], "rmRf(dir); removeAll(dir); deleteTree(dir); rmSync(dir, { recursive: true }); await rm(dir, { recursive: true });"), 'export const rmRf = (p: string) => p;\nexport const removeAll = rmRf;\nexport const deleteTree = rmRf;\n');
  });

  test("a delete of `/` written as literals is still held", () => {
    for (const body of [
      'execSync("rm -rf /");',
      'execSync("rm -rf " + "/");',
      'execSync(("rm -rf " + "") + "/");',
      'spawnSync("rm", ["-rf", "/"]);',
      'const d = process.env.D; execSync("rm -rf " + d + " /");',
    ]) expectRunsHeld(testFile([CP], body), "rm deletes /");
  });

  test("a delete built on the home dir is held as a delete of the home dir", () => {
    for (const [body, imports] of [
      ['execSync("rm -rf " + homedir() + "/");', ['import { homedir } from "os";']],
      ['spawnSync("rm", ["-rf", os.homedir() + "/.ssh"]);', ['import os from "os";']],
      ['execSync("rm -rf " + process.env.HOME + "/");', []],
      ['execSync("rm -rf " + process.env["HOME"] + "/.local/share/standup");', []],
      ['execSync("rm -rf " + os.userInfo().homedir + "/");', ['import os from "os";']],
    ] as const) expectRunsHeld(testFile([CP, ...imports], body), "rm deletes ~");
  });

  test("a program spelled after a computed prefix is still read", () => {
    expectRunsHeld(testFile([CP], 'const p = process.env.P; execSync(p + "/bin/git push origin HEAD");'), "`git push` publishes");
    expectRunsHeld(testFile([CP], 'const p = process.env.P; spawnSync(p + "/git", ["push", "origin"]);'), "`git push` publishes");
    expectRunsHeld(testFile([CP], 'const r = process.env.R; execSync("git push " + r + "/x");'), "`git push` publishes");
  });

  test("outside a test run, the same code is read as before", () => {
    for (const command of [
      `node -e 'require("child_process").execSync("rm -rf /")'`,
      `node -e 'require("child_process").execSync("rm -rf " + process.env.D + "/")'`,
      `node -e 'require("child_process").execSync("rm -rf " + require("os").homedir() + "/")'`,
      'rm -rf "$UNSET/"',
      "rm -rf /",
      `rm -rf ${HOME}`,
      `rm -rf ${DATA}`,
    ]) expect({ command, action: bash(command, "").action }).toEqual({ command, action: "hold" });
  });
});
