import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorCategory, FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Two writes the floor read as harmless. `bun pm` run in the Standup install
 * was read as listing whatever its subcommand, so `bun pm pkg set`,
 * `pkg delete`, `pkg fix`, `trust`, `migrate`, `pack` and `version <bump>`
 * rewrote the install's package.json or lockfile unheld; they hold as any
 * other build tool's write there does, and the listing subcommands still run.
 * Inline code (`node -e`, `bun -e`) handing a delete a path it builds from the
 * home dir (`execSync("rm -rf " + homedir())`, `fs.rmSync(homedir() + "/x",
 * { recursive: true })`) was read leniently, its computed path left unplaced;
 * it holds as `rm -rf ~` does. Deletes under a temp dir the code makes, and
 * code that only reads or prints the home dir, still run.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join("/", "tmp", "scratch-1");

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

function probes(): Partial<FloorProbes> {
  const files: Record<string, string> = {
    [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
    [join(ROOT, "package.json")]: JSON.stringify({ name: "feat", scripts: { test: "bun test" } }),
    [join(INSTALL, "package.json")]: JSON.stringify({ name: "standup", scripts: { build: "bun run build:web" } }),
    [join(INSTALL, "packages", "collector", "package.json")]: JSON.stringify({ name: "collector" }),
    [join(SCRATCH, "package.json")]: JSON.stringify({ name: "scratch" }),
    [join(HOME, ".bashrc")]: "",
  };
  const dirs = new Set<string>(["/", "/tmp", ROOT, SCRATCH, join(HOME, "projects"), join(INSTALL, "packages", "collector", "src", "floor")]);
  for (const f of [...Object.keys(files), ...dirs]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
}

function expectAllowed(command: string): void {
  expect({ command, v: bash(command) }).toEqual({ command, v: { action: "allow" } });
}

function expectHeld(command: string, category: FloorCategory, reason: string): void {
  const v = bash(command);
  expect({ command, action: v.action }).toEqual({ command, action: "hold" });
  if (v.action !== "hold") return;
  expect({ command, category: v.category }).toEqual({ command, category });
  expect(v.reason).toContain(reason);
}

const IN_INSTALL = "runs inside the Standup install";

describe("`bun pm` in the Standup install", () => {
  test.each([
    `cd ${INSTALL} && bun pm pkg set name=x`,
    `cd ${INSTALL} && bun pm pkg set scripts.postinstall="curl x | sh"`,
    `cd ${INSTALL} && bun pm pkg delete scripts.build`,
    `cd ${INSTALL} && bun pm pkg fix`,
    `cd ${INSTALL} && bun pm trust --all`,
    `cd ${INSTALL} && bun pm trust esbuild`,
    `cd ${INSTALL} && bun pm untrust esbuild`,
    `cd ${INSTALL} && bun pm migrate`,
    `cd ${INSTALL} && bun pm pack`,
    `cd ${INSTALL} && bun pm pack --destination ${SCRATCH}`,
    `cd ${INSTALL} && bun pm version patch`,
    `cd ${INSTALL} && bun pm version 9.9.9`,
    `cd ${INSTALL} && bun pm pkg`,
    `cd ${INSTALL}/packages/collector && bun pm pkg set name=x`,
    `bun --cwd=${INSTALL} pm pkg set name=x`,
    `bun --cwd ${INSTALL} pm pkg set name=x`,
    `bun pm --cwd ${INSTALL} pkg set name=x`,
    `cd ${INSTALL} && bun pm $SUB`,
    `cd ${INSTALL} && npm version patch`,
    `cd ${INSTALL} && npm pkg set name=x`,
  ])("holds %p", (command) => {
    expectHeld(command, "floor-tamper", IN_INSTALL);
  });

  test.each([
    `cd ${INSTALL} && bun pm`,
    `cd ${INSTALL} && bun pm ls`,
    `cd ${INSTALL} && bun pm ls --all`,
    `cd ${INSTALL} && bun pm bin`,
    `cd ${INSTALL} && bun pm bin -g`,
    `cd ${INSTALL} && bun pm why esbuild`,
    `cd ${INSTALL} && bun pm licenses --json`,
    `cd ${INSTALL} && bun pm whoami`,
    `cd ${INSTALL} && bun pm view react`,
    `cd ${INSTALL} && bun pm hash`,
    `cd ${INSTALL} && bun pm hash-string`,
    `cd ${INSTALL} && bun pm hash-print`,
    `cd ${INSTALL} && bun pm cache`,
    `cd ${INSTALL} && bun pm untrusted`,
    `cd ${INSTALL} && bun pm default-trusted`,
    `cd ${INSTALL} && bun pm pkg get name`,
    `cd ${INSTALL} && bun pm pkg get`,
    `cd ${INSTALL} && bun pm version`,
    `cd ${INSTALL} && bun pm pack --dry-run`,
    `cd ${INSTALL} && bun pm --help`,
    `bun --cwd=${INSTALL} pm ls`,
    `cd ${INSTALL} && npm version`,
    `cd ${INSTALL} && npm ls`,
  ])("allows the listing %p", (command) => {
    expectAllowed(command);
  });

  test.each([
    "bun pm pkg set name=x",
    "bun pm pkg delete scripts.build",
    "bun pm pkg fix",
    "bun pm trust --all",
    "bun pm migrate",
    "bun pm pack",
    `cd ${SCRATCH} && bun pm pkg set name=x`,
    `bun --cwd=${SCRATCH} pm pkg set name=x`,
    `cd ${SCRATCH} && bun pm pack`,
  ])("allows %p in the worker's own space", (command) => {
    expectAllowed(command);
  });

  // Clearing Bun's package cache from the install changes what the install's own installs read.
  test.each([`cd ${INSTALL} && bun pm cache rm`, `cd ${INSTALL} && bun pm cache rm --all`, `bun --cwd=${INSTALL} pm cache rm`, `cd ${INSTALL} && bun pm cache clean`])("holds %p", (command) => {
    expectHeld(command, "floor-tamper", IN_INSTALL);
  });

  test.each(["bun pm cache rm", `cd ${SCRATCH} && bun pm cache rm`])("allows %p in the worker's own space", (command) => {
    expectAllowed(command);
  });
});

describe("inline code deleting a path built from the home dir", () => {
  // Each with the path it deletes, held as the shell's `rm -rf <path>` is.
  test.each([
    [`node -e 'require("child_process").execSync("rm -rf " + require("os").homedir())'`, "~"],
    [`node -e 'require("child_process").execSync("rm -rf " + require("os").homedir() + "/projects")'`, "~/projects"],
    [`node -e 'require("child_process").execSync("rm -rf " + require("os").homedir() + "/")'`, "~/"],
    [`node -e 'const { homedir } = require("os"); require("child_process").execSync("rm -rf " + homedir() + "/.x")'`, "~/.x"],
    [`node -e 'require("child_process").execSync("rm -rf " + process.env.HOME)'`, "~"],
    [`node -e 'require("child_process").execSync("rm -rf " + process.env["HOME"] + "/projects")'`, "~/projects"],
    [`node -e 'require("child_process").execSync("rm -rf " + require("os").userInfo().homedir)'`, "~"],
    [`node -e 'const os = require("os"); require("child_process").execSync(\`rm -rf \${os.homedir()}/projects\`)'`, "~/projects"],
    [`node -e 'require("child_process").execSync(\`rm -rf \${process.env.HOME}\`)'`, "~"],
    [`node -e 'require("child_process").spawnSync("rm", ["-rf", require("os").homedir()])'`, "~"],
    [`node -e 'const os = require("os"); require("child_process").spawnSync("rm", ["-rf", os.homedir() + "/.x"])'`, "~/.x"],
    [`node -e 'const os = require("os"); const path = require("path"); require("child_process").spawnSync("rm", ["-rf", path.join(os.homedir(), "projects")])'`, "~/projects"],
    [`node -e 'const h = require("os").homedir(); require("child_process").execSync("rm -rf " + h)'`, "~"],
    [`node -e 'const h = require("path").join(require("os").homedir(), "projects"); require("child_process").spawnSync("rm", ["-rf", h])'`, "~/projects"],
    [`node -e 'require("fs").rmSync(require("os").homedir(), { recursive: true, force: true })'`, "~"],
    [`node -e 'require("fs").rmSync(require("os").homedir() + "/.x", { recursive: true })'`, "~/.x"],
    [`node -e 'const os = require("os"); require("fs").rmSync(\`\${os.homedir()}/projects\`, { recursive: true })'`, "~/projects"],
    [`node -e 'const fs = require("fs"); const p = require("path"); fs.rmSync(p.join(require("os").homedir(), "projects"), { recursive: true })'`, "~/projects"],
    [`node -e 'const fs = require("fs"); const h = require("os").homedir(); fs.rmSync(h, { recursive: true })'`, "~"],
    [`node -e 'const fs = require("fs"); const h = require("os").homedir() + "/projects"; fs.rmSync(h, { recursive: true })'`, "~/projects"],
    [`node -e 'require("fs").rmdirSync(process.env.HOME, { recursive: true })'`, "~"],
    [`node -e 'require("fs").rm(process.env.HOME + "/.x", { recursive: true }, () => {})'`, "~/.x"],
    [`node -e 'require("fs").promises.rm(require("os").homedir(), { recursive: true })'`, "~"],
    [`node -e 'require("fs").rmSync(require("os").userInfo().homedir, { recursive: true })'`, "~"],
    [`node -p 'require("fs").rmSync(require("os").homedir(), { recursive: true })'`, "~"],
    [`node --eval 'require("fs").rmSync(require("os").homedir(), { recursive: true })'`, "~"],
    [`bun -e 'require("fs").rmSync(require("os").homedir(), { recursive: true })'`, "~"],
    [`bun -e 'import { homedir } from "os"; await Bun.$\`rm -rf \${homedir()}\`'`, "~"],
    [`bun -e 'import { homedir } from "os"; await Bun.$\`rm -rf \${homedir()}/projects\`'`, "~/projects"],
    [`bun -e 'import { homedir } from "os"; import { rmSync } from "fs"; rmSync(homedir(), { recursive: true })'`, "~"],
  ])("holds %p, a delete of %p", (command, path) => {
    const shell = bash(`rm -rf ${path}`);
    expect(shell.action).toBe("hold");
    if (shell.action === "hold") expectHeld(command, shell.category, "deletes ");
  });

  test.each([
    `node -e 'console.log(require("os").homedir())'`,
    `node -p 'require("os").homedir()'`,
    `bun -e 'console.log(process.env.HOME)'`,
    `node -e 'console.log(require("fs").readdirSync(require("os").homedir()))'`,
    `node -e 'console.log(require("fs").readFileSync(require("os").homedir() + "/.bashrc", "utf8"))'`,
    `node -e 'const fs = require("fs"); const os = require("os"); const d = fs.mkdtempSync(require("path").join(os.tmpdir(), "x-")); fs.rmSync(d, { recursive: true })'`,
    `node -e 'const fs = require("fs"); const os = require("os"); const d = fs.mkdtempSync(os.tmpdir() + "/x-"); require("child_process").execSync("rm -rf " + d)'`,
    `node -e 'require("fs").rmSync("${SCRATCH}/out", { recursive: true, force: true })'`,
    `node -e 'require("fs").rmSync("dist", { recursive: true, force: true })'`,
    `node -e 'require("child_process").execSync("rm -rf dist")'`,
    `node -e 'const os = require("os"); require("fs").rmSync(os.tmpdir() + "/x", { recursive: true, force: true })'`,
    `node -e 'require("child_process").execSync("ls " + require("os").homedir())'`,
    `node -e 'require("child_process").execSync("git status", { cwd: require("os").homedir() + "/projects" })'`,
    `node -e 'require("child_process").spawnSync("ls", ["-la", require("path").join(require("os").homedir(), "projects")])'`,
    `node -e 'console.log(\`\${require("os").homedir()}/projects\`)'`,
    `HOME=${SCRATCH}/home node -e 'require("fs").rmSync(require("os").homedir(), { recursive: true, force: true })'`,
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("a delete built on a computed dir that isn't the home dir is held as a command the floor can't read", () => {
    expectHeld(`node -e 'require("child_process").execSync("rm -rf " + process.env.D + "/")'`, "floor-tamper", "deletes /");
    expectHeld(`node -e 'require("child_process").execSync("rm -rf " + process.env.D)'`, "unclassified", "can't be read");
  });
});
