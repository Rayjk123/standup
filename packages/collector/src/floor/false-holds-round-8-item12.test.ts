import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

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
const HELPER = join(ROOT, "src", "launcher.ts");

function probes(source: string, helper: string): Partial<FloorProbes> {
  const files: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
    [join(ROOT, "package.json")]: JSON.stringify({ scripts: { test: "bun test" } }),
    [TEST_FILE]: source,
    [HELPER]: helper,
  };
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

const R = "/tmp/floor-x";
const ISOLATED = [
  `HOME=${R}/home`,
  `XDG_CONFIG_HOME=${R}/xdg/config`,
  `XDG_DATA_HOME=${R}/xdg/data`,
  `XDG_CACHE_HOME=${R}/xdg/cache`,
  `XDG_STATE_HOME=${R}/xdg/state`,
  `TMPDIR=${R}/tmp`,
  `TMP=${R}/tmp`,
  `TEMP=${R}/tmp`,
  `DB_PATH=${R}/data/standup.db`,
  `STANDUP_SQLITE_PATH=${R}/data/standup.sqlite`,
  `KNOWLEDGE_DIR=${R}/knowledge`,
  `STANDUP_INTERNAL_ROOT=${R}/internal`,
].join(" ");
const ISOLATED_RUN = `env -i PATH=/home/alice/.bun/bin:/usr/local/bin:/usr/bin:/bin ${ISOLATED} bun test src/x.test.ts`;

function bash(command: string, source: string, helper: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(source, helper));
}

/** A test file importing `names` from ./launcher whose test body is `body`. */
const testFile = (names: string, body: string, extra: string[] = []) =>
  ['import { test } from "bun:test";', `import { ${names} } from "./launcher";`, ...extra, `test("x", async () => { ${body} });`, ""].join("\n");

/** The shape of launcher.ts's teardown: a command runner handed `/` as its cwd, called through a deps override. */
const TEARDOWN = [
  'import { spawnSync } from "child_process";',
  "async function run(cmd: string[], cwd: string, log: string[]) {",
  "  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd });",
  "  log.push(String(r.stdout));",
  "  return { ok: r.status === 0 };",
  "}",
  "async function tearDown(target: string, session: string, deps: { run?: typeof run }) {",
  "  const log: string[] = [];",
  "  const exec = deps.run ?? run;",
  '  await exec(["tmux", "-L", "standup", "kill-session", "-t", `=${session}`], "/", log);',
  '  await exec(["rm", "-rf", target], "/", log);',
  "  return log;",
  "}",
  "export async function cleanupLaunch(target: string, session: string, deps = {}) { return tearDown(target, session, deps); }",
  "export function other() { return 1; }",
  "",
].join("\n");

/** A helper whose exported cleanup deletes a path built on an env var that may be unset, collapsing to `/`. */
const ENV_CLEANUP = [
  'import { rmSync } from "fs";',
  'import { execSync } from "child_process";',
  'export function cleanup() { execSync("rm -rf " + (process.env.TMUX_TMPDIR ?? "") + "/"); }',
  'export function cleanupSync() { rmSync((process.env.TMUX_TMPDIR ?? "") + "/", { recursive: true, force: true }); }',
  "export function other() { return 1; }",
  "",
].join("\n");

/** A helper whose `go` runs `argv` through a command runner handed `/` as its cwd. */
const runner = (argv: string, extra = "") =>
  [
    'import { spawnSync } from "child_process";',
    "function run(cmd: string[], cwd: string, log: string[]) { const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd }); log.push(String(r.stdout)); return r.status === 0; }",
    `export function go(target: string, log: string[] = []) { const exec = run; return exec(${argv}, "/", log)${extra}; }`,
    "",
  ].join("\n");

/** The same runs written in a test file the run executes itself. */
const direct = (call: string) => ['import { test } from "bun:test";', 'import { spawnSync, execSync } from "child_process";', `test("x", () => { const target = process.env.T!; ${call}; });`, ""].join("\n");

const RUNS = [ISOLATED_RUN, "bun test src/x.test.ts"];

describe("8. a command runner handed an argv list and then a cwd", () => {
  test.each([
    ["the teardown shape, called from a test", testFile("cleanupLaunch", 'await cleanupLaunch("/tmp/x", "s", { run: async () => ({ ok: true }) });'), TEARDOWN],
    ["the teardown shape, imported and not called", testFile("cleanupLaunch, other", "other();"), TEARDOWN],
    ["an env-built cleanup, imported and not called", testFile("cleanup, other", "other();"), ENV_CLEANUP],
    ["an env-built rmSync cleanup, called from a test", testFile("cleanupSync", "cleanupSync();"), ENV_CLEANUP],
    ["a runner deleting a computed path with `/` as cwd", testFile("go", 'go("/tmp/x");'), runner('["rm", "-rf", target]')],
    ["a runner deleting a computed path with `/` in its options", testFile("go", 'go("/tmp/x");'), runner('["rm", "-rf", target], { cwd: "/" }').replace('"/", log)', "log)")],
  ])("allows %s", (_, source, helper) => {
    for (const command of RUNS) expect({ command, v: bash(command, source, helper) }).toEqual({ command, v: { action: "allow" } });
  });

  test("a test file spawning an argv list with `/` as its cwd is allowed", () => {
    for (const command of RUNS) expect({ command, v: bash(command, direct('spawnSync(["rm", "-rf", target], "/")'), "") }).toEqual({ command, v: { action: "allow" } });
  });

  test.each([
    ["an env-built cleanup, called from a test", testFile("cleanup", "cleanup();"), ENV_CLEANUP, "rm deletes /"],
    ["`/` inside the argv list", testFile("go", 'go("/tmp/x");'), runner('["rm", "-rf", "/"]'), "rm deletes /"],
    ["`/` added to the argv list", testFile("go", 'go("/tmp/x");'), runner('["rm", "-rf"].concat(["/"])'), "rm deletes /"],
    ["the install dir inside the argv list", testFile("go", 'go("/tmp/x");'), runner(`["rm", "-rf", "${INSTALL}"]`), INSTALL],
    ["the data dir inside the argv list", testFile("go", 'go("/tmp/x");'), runner(`["rm", "-rf", "${DATA}"]`), DATA],
    ["a push in a later argument", testFile("go", 'go("/tmp/x");'), runner('["true"], "git push origin main"').replace('"/", log)', "log)"), "git push"],
  ])("holds %s", (_, source, helper, reason) => {
    for (const command of RUNS) {
      const v = bash(command, source, helper);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
      if (v.action === "hold") expect(v.reason).toContain(reason);
    }
  });

  test("a delete of the floor inside the argv list keeps its high risk", () => {
    const floor = join(INSTALL, "packages", "collector", "src", "floor");
    for (const command of RUNS) {
      const v = bash(command, direct(`spawnSync(["rm", "-rf", "${floor}"], "/")`), "");
      expect({ command, action: v.action, category: v.action === "hold" ? v.category : null, high: v.action === "hold" ? v.ownerReserved === true : null }).toEqual({ command, action: "hold", category: "floor-tamper", high: true });
    }
  });

  test("a test file spawning `/` itself as the argv list's word is held", () => {
    for (const command of RUNS) {
      const v = bash(command, direct('spawnSync(["rm", "-rf", "/"], "/")'), "");
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
      if (v.action === "hold") expect(v.reason).toContain("rm deletes /");
    }
  });

  test("a preload calling a runner that deletes `/` is held", () => {
    const helper = runner('["rm", "-rf", "/"]');
    const preload = 'import { go } from "./launcher";\ngo("/tmp/x");\n';
    const command = `${ISOLATED_RUN.replace("bun test", "bun test --preload ./src/pre.ts")}`;
    const p = probes(testFile("other", ""), `${helper}export function other() { return 1; }\n`);
    const files: Record<string, string> = { [join(ROOT, "src", "pre.ts")]: preload };
    const read = p.readFile!;
    const exists = p.exists!;
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, {
      ...p,
      readFile: (f, max) => (f in files ? { ok: true, text: files[f]! } : read(f, max)),
      exists: (f) => f in files || exists(f),
      realpath: (f) => (f in files ? f : p.realpath!(f)),
      lstat: (f) => (f in files ? { symlink: false, file: true, nlink: 1 } : p.lstat!(f)),
    });
    expect({ v: v.action }).toEqual({ v: "hold" });
  });

  test("outside a test run, the same code is read as before", () => {
    for (const command of [
      `node -e 'require("child_process").spawnSync(["rm", "-rf", "/"], "/")'`,
      `node -e 'require("child_process").spawnSync(["rm", "-rf", "${INSTALL}"], "/")'`,
    ]) expect({ command, action: bash(command, "", "").action }).toEqual({ command, action: "hold" });
  });
});
