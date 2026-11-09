import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Bun takes its command from its first word that doesn't start with `-`,
 * an option's value included, and matches it against its own command names
 * before it looks for a file or package script of that name: `bun add`
 * adds a package even beside a file named `add`, `bun ./add` runs that file,
 * `bun --title x pkg` runs `bun x pkg`, and `bun --cwd pkg add` adds nothing.
 * `-c`/`--config` and `--inspect*` take a value only as `=…`: `bun -c x.ts`
 * runs x.ts. A script Bun runs, and the words after it, are not read as one
 * of Bun's commands; Bun's own commands still hold where they do.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const INSTALL_INDEX = join(INSTALL, "packages", "collector", "src", "index.ts");

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

const SCRIPT = 'console.log("hi");\n';
const PLANT = `import { writeFileSync } from "fs";\n\nwriteFileSync(${JSON.stringify(INSTALL_INDEX)}, "export {};\\n");\n`;
const SCRIPTS = ["x.ts", "scripts/foo.ts", "scripts/add-thing.ts", "scripts/install.ts", "pkg/x.ts", "add"];

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: '{"name":"x","scripts":{"build":"tsc"}}\n',
  [join(ROOT, "plant.ts")]: PLANT,
  [INSTALL_INDEX]: "export {};\n",
  ...Object.fromEntries(SCRIPTS.flatMap((f) => [[join(ROOT, f), SCRIPT], [join(INSTALL, f), SCRIPT]])),
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    lstat: (p) => (dirs.has(p) || p in FILES ? { symlink: false, file: p in FILES, nlink: 1 } : null),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
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

/** Scripts run with words that name Bun's commands, or after options whose values Bun takes. */
const SCRIPT_RUNS = [
  "bun scripts/foo.ts",
  "bun ./x.ts arg",
  "bun run x.ts",
  "bun scripts/add-thing.ts",
  "bun scripts/install.ts",
  "bun x.ts add",
  "bun x.ts install foo",
  "bun run x.ts add",
  "bun --silent x.ts add",
  "bun --silent run x.ts install",
  "bun --cwd=pkg x.ts",
  "bun --cwd pkg x.ts add",
  "bun --inspect x.ts add",
  "bun --inspect-brk x.ts install",
  "bun --inspect-wait x.ts i",
  "bun -c x.ts add",
  "bun --config x.ts add",
  "bun --title t x.ts add",
  "bun --env-file .env x.ts add",
  "bun --install fallback x.ts",
  "bun --port 3000 x.ts",
  "bun --define a:1 x.ts add",
  "bun -d a:1 x.ts add",
  "bun --console-depth 3 x.ts a",
  "bun --hot scripts/add-thing.ts",
  "bun --watch x.ts add",
  "bun --smol x.ts i",
];

describe("a script bun runs is not read as one of bun's commands", () => {
  test.each(SCRIPT_RUNS)("allows %p in the worktree", (command) => {
    expectAllowed(bash(command));
  });

  test.each(SCRIPT_RUNS)("allows %p in the Standup install, whose script is read on its own", (command) => {
    expectAllowed(bash(command, INSTALL));
  });
});

describe("bun's own commands still hold", () => {
  // In the install they write dependencies (or run a fetched package) the collector loads.
  test.each([
    "bun add pkg",
    "bun a pkg",
    "bun install",
    "bun i",
    "bun add",
    "bun x cowsay",
    "bunx cowsay",
    "bun --cwd=pkg add left-pad",
    "bun --silent add x",
    "bun -- add x",
    "bun --print add",
    "bun --eval add",
    "bun --cwd add pkg",
    "bun --cwd add x.ts",
    "bun --title add pkg",
    "bun --title x cowsay",
    "bun --title i",
    "bun --env-file update x.ts",
    "bun -c add x.ts",
  ])("holds %p in the Standup install", (command) => {
    expectHeld(bash(command, INSTALL), "floor-tamper");
  });

  test.each([
    "bun publish",
    "bun --silent publish",
    "bun --cwd=pkg publish",
    "bun --cwd publish",
    "bun --title publish x.ts",
    "bun -- publish",
  ])("holds %p anywhere", (command) => {
    expectHeld(bash(command), "outward");
    expectHeld(bash(command, "/tmp"), "outward");
  });

  // `-c`/`--config` and `--inspect` take no separate value: the word after them is the script Bun runs.
  test.each([
    "bun -c plant.ts x.ts",
    "bun --config plant.ts x.ts",
    "bun --inspect plant.ts",
    "bun --title t plant.ts add",
  ])("reads the script %p runs", (command) => {
    expectHeld(bash(command), "floor-tamper");
  });

  test("a script that spawns bun with a computed script after `-c` can't be read", () => {
    const v = bash(`bun -e 'Bun.spawnSync(["bun", "-c", process.argv[1], "x.ts"])'`);
    expect(v.action).toBe("hold");
  });
});
