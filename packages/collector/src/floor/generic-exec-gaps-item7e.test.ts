import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `bun <file>` runs that file: a word with a slash or a script extension,
 * or one naming a file, is a script Bun runs, read like the file itself, and
 * a word inside its path or among its arguments that is also a command of
 * Bun's (`add`, `install`, `i`, `update`, `x`) does not make it that
 * command. Bun's own commands (`bun add`, `bun install`, `bun i`, `bun
 * update`, `bun x`, `bunx`, `bun pm …`) are read as before: allowed in the
 * worktree, held in the install. A script whose text writes the data dir,
 * a collector start, secrets, the database, `bun publish` and `pkill` hold.
 * The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const PATHS = [
  "/fake/home/.bun/bin",
  `${INSTALL}/node_modules/.bin`,
  `${INSTALL}/packages/node_modules/.bin`,
  `${INSTALL}/packages/collector/node_modules/.bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const SCRIPT = "console.log(1);\n";

const FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [`${ROOT}/package.json`]: '{ "name": "standup", "private": true, "scripts": { "build": "bun scripts/build.ts install", "add": "bun scripts/add-user.ts", "i": "bun scripts/foo.ts i" } }\n',
  [`${ROOT}/scripts/run.sh`]: "#!/bin/sh\nbun scripts/build.ts install\nbun scripts/add-user.ts update\n",
  [`${ROOT}/scripts/foo.ts`]: SCRIPT,
  [`${ROOT}/scripts/add-user.ts`]: SCRIPT,
  [`${ROOT}/scripts/build.ts`]: SCRIPT,
  [`${ROOT}/scripts/install.ts`]: SCRIPT,
  [`${ROOT}/x.ts`]: SCRIPT,
  [`${ROOT}/x.mjs`]: SCRIPT,
  [`${ROOT}/packages/collector/src/index.ts`]: SCRIPT,
  ["/tmp/x/a.ts"]: SCRIPT,
  [`${ROOT}/scripts/add-wipe.ts`]: `import { rmSync } from "fs";\nrmSync("${DATA}", { recursive: true, force: true });\n`,
  [`${INSTALL}/scripts/foo.ts`]: SCRIPT,
  [`${DATA}/secrets/owner.key`]: "k\n",
  [`${DATA}/standup.db`]: "db\n",
};

function probes(env: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in FILES || dirs.has(bare(p)) ? bare(p) : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: (name) => env[name],
    now: () => Date.now(),
  };
}

const ENV = { PATH: PATHS, HOME };

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(ENV));
}

function shape(v: FloorVerdict): { action: string; category?: string; reason?: string } {
  return v.action === "hold" ? { action: v.action, category: v.category, reason: v.reason } : { action: v.action };
}

describe("bun running a script file", () => {
  test("a script path, with or without `run`, is a run of that file, not a command of Bun's", () => {
    for (const command of [
      "bun scripts/foo.ts",
      "bun ./x.ts",
      "bun run scripts/foo.ts",
      "bun /tmp/x/a.ts",
      "bun x.mjs --flag",
      "bun x.ts",
      "bun scripts/add-user.ts",
      "bun scripts/install.ts",
      "bun scripts/build.ts install",
      "bun scripts/foo.ts add x",
      "bun scripts/foo.ts i",
      "bun scripts/foo.ts update",
      "bun scripts/foo.ts x pkg",
      "bun run scripts/build.ts install",
      `cd ${ROOT} && bun scripts/foo.ts install`,
      "cd /tmp/x && bun a.ts install",
      "bun scripts/foo install",
      "bun scripts/missing.ts install",
      "bun scripts/foo.ts --install",
      "bun -- scripts/foo.ts",
      "bun --watch scripts/foo.ts",
      "bun --hot scripts/foo.ts i",
      "bun --bun scripts/foo.ts install",
      "bun scripts/foo.ts 2>&1 | tail -5",
      "bash -c 'bun scripts/build.ts install'",
      'sh -c "bun scripts/add-user.ts"',
      "timeout 60 bun scripts/foo.ts install",
      "nohup bun scripts/foo.ts add x",
      "env FOO=1 bun scripts/foo.ts update",
      "bun scripts/run.sh",
      "bun run build",
      "bun run add",
      "bun run i",
      "echo 'bun add x'",
    ]) {
      expect({ command, verdict: shape(bash(command)) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });
});

describe("bun's own commands are read as before", () => {
  test("installs, updates, package runs and `bun pm` in the worktree are allowed as before", () => {
    for (const command of [
      "bun add left-pad",
      "bun add x",
      "bun add ./x.ts",
      "bun a left-pad",
      "bun install",
      "bun install ./x.ts",
      "bun i",
      "bun update",
      "bun x cowsay hi",
      "bun x ./x.ts",
      "bunx cowsay hi",
      "bun pm trust left-pad",
      "bun add-user",
      "bun install-thing",
    ]) {
      expect({ command, verdict: shape(bash(command)) }).toEqual({ command, verdict: { action: "allow" } });
    }
  });

  test("the same commands run in the install hold as floor-tamper", () => {
    for (const command of [
      `cd ${INSTALL} && bun install`,
      `cd ${INSTALL} && bun add x`,
      `cd ${INSTALL} && bun update`,
      `cd ${INSTALL} && bun x pkg`,
      `bun --cwd ${INSTALL} install`,
    ]) {
      expect({ command, verdict: shape(bash(command)) }).toMatchObject({ command, verdict: { action: "hold", category: "floor-tamper", reason: expect.stringContaining("runs inside the Standup install") } });
    }
  });

  test("publish, a collector start, a script that wipes the data dir, secrets, the database and pkill hold", () => {
    const cases: Array<[string, string, string]> = [
      ["bun publish", "outward", "`bun publish` publishes a package to the registry"],
      ["bun packages/collector/src/index.ts", "outward", "starts a Standup collector"],
      ["bun --cwd packages/collector src/index.ts", "outward", "starts a Standup collector"],
      ["bun scripts/add-wipe.ts install", "floor-tamper", DATA],
      [`bun ${DATA}/secrets/owner.key`, "floor-tamper", "owner-side secrets"],
      [`bun ${DATA}/standup.db`, "floor-tamper", "Standup's database"],
      ["pkill bun", "destructive", "`pkill` kills processes"],
    ];
    for (const [command, category, reason] of cases) {
      expect({ command, verdict: shape(bash(command)) }).toMatchObject({ command, verdict: { action: "hold", category, reason: expect.stringContaining(reason) } });
    }
  });

});
