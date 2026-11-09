import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * tmux kill words that only appear as text: in a comment, an echo, a search
 * pattern, a commit message, or a test's expectation or fixture. And the real
 * kills of the same words, on the shared server, which must still hold. A
 * literal in a script file the command runs is read as a command it may run
 * when the code read for the run can run one. The machine is virtual.
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

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test", typecheck: "tsc --noEmit" } });

/** A function body that runs its argument as a command, through names it builds. */
const RUN_BODY = "return process.getBuiltinModule('node:child_' + 'process')['exec' + 'Sync'](c)";
/** `Function` recovered through computed keys in destructuring, then handed a body that runs the command. */
const COMPUTED_KEY = [
  'const c = "tmux kill-server";',
  'const { ["con" + "structor"]: S } = "";',
  'const { ["con" + "structor"]: F } = S;',
  `F("c", "${RUN_BODY}")(c);`,
  "",
].join("\n");
/** A runner reached between two regex literals that each hold a double quote. */
const REGEX_QUOTE = ['const c = "tmux kill-server";', "const a = /\"/.source, r = process.getBuiltinModule(`node:child_` + `process`)[`exec` + `Sync`](c), b = /\"/.source;", ""].join("\n");

/** Entries that run their tmux text through an identifier written with a unicode escape. */
const ESCAPED: Record<string, string> = {
  "plain-eval.ts": 'const c = "tmux kill-server";\neval("process.getBuiltinModule(\'node:child_\' + \'process\')[\'exec\' + \'Sync\'](c)");\n',
  "escaped-eval.ts": 'const c = "tmux kill-server";\n\\u0065val("process.getBuiltinModule(\'node:child_\' + \'process\')[\'exec\' + \'Sync\'](c)");\n',
  "escaped-require.ts": 'const c = "tmux kill-server";\nconst { execSync: x } = \\u0072equire("child" + "_process");\nx(c);\n',
  "escaped-function.ts": 'const c = "tmux kill-server";\nnew \\u0046unction("c", "process.getBuiltinModule(\'node:child_\' + \'process\')[\'exec\' + \'Sync\'](c)")(c);\n',
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  // A script whose comment names a kill.
  [join(ROOT, "scripts", "check.sh")]: "#!/bin/bash\n# never tmux kill-session here\necho ok\n",
  // A script that echoes one.
  [join(ROOT, "scripts", "warn.sh")]: "#!/bin/bash\necho \"don't run tmux kill-server\" >&2\nexit 1\n",
  // A script that runs one.
  [join(ROOT, "scripts", "kill.sh")]: "#!/bin/bash\n# tidy up\ntmux kill-server\n",
  [join(ROOT, "scripts", "kill-session.sh")]: "#!/bin/bash\ntmux kill-session -t x\n",
  [join(ROOT, "scripts", "kill-private.sh")]: "#!/bin/bash\ntmux -L test kill-server\n",
  // Tests that only name kills as text.
  [join(ROOT, "src", "floor.test.ts")]: [
    'import { expect, test } from "bun:test";',
    'import { bash } from "./helpers";',
    'test("holds kill-server", () => {',
    '  expect(bash("tmux kill-server")).toMatchObject({ action: "hold" });',
    '  expect(bash("tmux kill-session -t x")).toMatchObject({ action: "hold" });',
    "});",
    "",
  ].join("\n"),
  [join(ROOT, "src", "fixture.test.ts")]: [
    'import { expect, test } from "bun:test";',
    'const CASES = ["tmux kill-session -t x", "tmux kill-window -t x"];',
    'test("cases", () => { for (const c of CASES) expect(c.startsWith("tmux")).toBe(true); });',
    "",
  ].join("\n"),
  [join(ROOT, "src", "regex.test.ts")]: [
    'import { expect, test } from "bun:test";',
    'test("matches", () => { expect(/tmux kill-server/.exec("x tmux kill-server")).not.toBeNull(); });',
    "",
  ].join("\n"),
  // A module that throws a message naming a kill.
  [join(ROOT, "src", "guard.ts")]: 'export function guard(cmd: string): void {\n  if (cmd.includes("kill-server")) throw new Error("tmux kill-server is held");\n}\nguard(process.argv[2] ?? "");\n',
  // Tests and modules that run one.
  [join(ROOT, "src", "exec.test.ts")]: 'import { execSync } from "child_process";\nimport { test } from "bun:test";\ntest("tidies", () => { execSync("tmux kill-server"); });\n',
  [join(ROOT, "src", "spawn.test.ts")]: 'import { spawn } from "child_process";\nimport { test } from "bun:test";\ntest("tidies", () => { spawn("tmux", ["kill-server"]); });\n',
  [join(ROOT, "src", "exec-session.test.ts")]: 'import { execSync } from "child_process";\nimport { test } from "bun:test";\nconst CMD = "tmux kill-session -t x";\ntest("tidies", () => { execSync(CMD); });\n',
  [join(ROOT, "src", "exec.ts")]: 'import { execSync } from "child_process";\nexecSync("tmux kill-server");\n',
  [join(ROOT, "src", "log.ts")]: 'import { join } from "node:path";\nimport { readFileSync } from "fs";\nconst cfg = readFileSync(join(".", "cfg.json"), "utf8");\nif (!cfg) console.error("tmux kill-session -t x");\n',
  // Modules that reach a runner some way other than a plain call.
  [join(ROOT, "src", "template-exec.ts")]: 'import { execSync } from "child_process";\nthrow new Error(`${execSync("tmux kill-server")}`);\n',
  [join(ROOT, "src", "template-only.ts")]: 'const x = 1;\nconsole.log(`${eval("1")}`, "tmux kill-server");\n',
  [join(ROOT, "src", "bun-spawn.ts")]: 'Bun.spawn(["tmux", "kill-server"]);\n',
  [join(ROOT, "src", "bun-index.ts")]: 'const B = globalThis.Bun;\nB["spawn"](["tmux kill-server"]);\n',
  [join(ROOT, "src", "write-script.ts")]: 'import { writeFileSync } from "fs";\nwriteFileSync("tidy.sh", "tmux kill-server");\n',
  [join(ROOT, "src", "write-async.ts")]: 'import { promises } from "fs";\nawait promises.writeFile("tidy.sh", "tmux kill-server");\n',
  [join(ROOT, "src", "computed-require.ts")]: 'const m = require(process.argv[2]!);\nm.run("tmux kill-server");\n',
  [join(ROOT, "src", "dynamic-import.ts")]: 'const m = await import("./run");\nm.run("tmux kill-server");\n',
  [join(ROOT, "src", "constructor.ts")]: '[].constructor.constructor("return process")().mainModule;\nconst c = "tmux kill-server";\n',
  [join(ROOT, "src", "process-index.ts")]: 'const b = process["bind" + "ing"];\nconst c = "tmux kill-server";\n',
  [join(ROOT, "src", "worker.ts")]: 'import { Worker } from "worker_threads";\nnew Worker("tmux kill-server", { eval: true });\n',
  [join(ROOT, "src", "tagged.ts")]: 'declare const sh: (s: TemplateStringsArray) => void;\nsh`tmux kill-server`;\n',
  [join(ROOT, "src", "run.ts")]: 'import { execSync } from "child_process";\nexport function run(cmd: string): void { execSync(cmd); }\n',
  [join(ROOT, "src", "import-run.ts")]: 'import { run } from "./run";\nrun("tmux kill-server");\n',
  [join(ROOT, "src", "import-run.test.ts")]: 'import { test } from "bun:test";\nimport { run } from "./run";\ntest("tidies", () => { run("tmux kill-server"); });\n',
  [join(ROOT, "src", "bun-shell.ts")]: 'import { $ } from "bun";\nawait $`tmux kill-server`;\n',
  [join(ROOT, "src", "bun-shell.test.ts")]: 'import { test } from "bun:test";\nimport { $ } from "bun";\ntest("tidies", async () => { await $`tmux kill-server`; });\n',
  // A constants module, and a module that runs what it imports from it.
  [join(ROOT, "src", "consts.ts")]: 'export const cmd = "tmux kill-server";\nexport const session = "tmux kill-session -t x";\n',
  [join(ROOT, "src", "run-const.ts")]: 'import { cmd } from "./consts";\nimport { execSync } from "child_process";\nexecSync(cmd);\n',
  [join(ROOT, "src", "run-session.ts")]: 'import { session } from "./consts";\nimport { execSync } from "child_process";\nexecSync(session);\n',
  // Text handed to another thread or loaded some way the scan can't follow.
  [join(ROOT, "src", "post.ts")]: 'const w = new Worker("./spawner.ts");\nw.postMessage("tmux kill-server");\n',
  [join(ROOT, "src", "spawner.ts")]: 'self.onmessage = (e: MessageEvent) => { Bun.spawnSync(String(e.data).split(" ")); };\n',
  [join(ROOT, "src", "blob-worker.ts")]: 'const src = "self.onmessage = (e) => Bun.spawnSync(e.data.split(\\" \\"))";\nconst w = new Worker(URL.createObjectURL(new Blob([src])));\nw.postMessage("tmux kill-server");\n',
  [join(ROOT, "src", "builtin.ts")]: 'const cp = process.getBuiltinModule("node:child" + "_process");\ncp.execSync("tmux kill-server");\n',
  [join(ROOT, "src", "keyed.ts")]: 'const F = []["constructor"]["constructor"];\nF("return process")().mainModule.require("child_process").execSync("tmux kill-server");\n',
  [join(ROOT, "src", "this-handle.js")]: 'const g = (function () { return this; })();\ng.Bun.spawnSync(["tmux", "kill-server"]);\n',
  [join(ROOT, "src", "wasm.ts")]: 'const m = await WebAssembly.instantiate(new Uint8Array([0]));\nconsole.log(m, "tmux kill-server");\n',
  // Code that reaches `Function` through computed keys, or hides a runner between regex literals that hold a quote.
  [join(ROOT, "src", "computed-key.ts")]: COMPUTED_KEY,
  [join(ROOT, "src", "computed-key.mjs")]: COMPUTED_KEY,
  [join(ROOT, "src", "computed-key.cjs")]: COMPUTED_KEY,
  [join(ROOT, "src", "computed-key.tsx")]: COMPUTED_KEY,
  [join(ROOT, "src", "regex-quote.ts")]: REGEX_QUOTE,
  [join(ROOT, "src", "descriptor.ts")]: `const c = "tmux kill-server";\nconst d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "con" + "structor")!;\nd.value("c", "${RUN_BODY}")(c);\n`,
  ...Object.fromEntries(Object.entries(ESCAPED).map(([name, text]) => [join(ROOT, "src", name), text])),
  [join("/", "tmp", "own", ".keep")]: "",
  [join(DATA, "standup.db")]: "",
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

function expectHeld(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
}

describe("tmux kill words that are only text", () => {
  const text = [
    `echo "don't run tmux kill-server"`,
    "echo tmux kill-session -t x",
    "bash -c '# never tmux kill-session here\necho ok'",
    "bash -c 'echo ok # never tmux kill-server'",
    "bash scripts/check.sh",
    "./scripts/check.sh",
    "bash scripts/warn.sh",
    'grep -rn "tmux kill-server" src/',
    "rg 'kill-session'",
    "rg -n 'tmux kill-window' src",
    'git commit -m "floor: hold tmux kill-window"',
    "bun test src/floor.test.ts",
    "bun test src/fixture.test.ts",
    "bun test src/regex.test.ts",
  ];
  test.each(text)("allows %p", (command) => {
    expectAllowed(bash(command));
  });
});

describe("tmux kills on the shared server still hold", () => {
  const kills = [
    "tmux kill-server",
    "tmux kill-session -t x",
    "tmux kill-window -t x",
    "bash -c 'tmux kill-server'",
    "bash -c '# tidy up\ntmux kill-server'",
    "sh -c 'echo bye; tmux kill-session -t x'",
    "eval 'tmux kill-server'",
    'eval "tmux kill-window -t x"',
    "bash scripts/kill.sh",
    "./scripts/kill.sh",
    "bash scripts/kill-session.sh",
    "bun test src/exec.test.ts",
    "bun test src/spawn.test.ts",
    "bun src/exec.ts",
    `node -e 'require("child_process").execSync("tmux kill-server")'`,
    "echo x; tmux kill-server # done",
    "TMUX_TMPDIR=/tmp/x tmux kill-server",
  ];
  test.each(kills)("holds %p", (command) => {
    expectHeld(bash(command));
  });
});

describe("a literal in a script file is a command only where the code read for the run can run one", () => {
  // A thrown message, a log line, a constant or a file's contents, in code that can run no command.
  const text = ["bun src/guard.ts tmux", "bun src/log.ts", "bun src/consts.ts", "bun src/write-script.ts", "bun src/write-async.ts"];
  test.each(text)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  // Code that runs commands, in the entry or a module it loads, or reaches a runner the scan can't follow.
  const held = [
    "bun src/import-run.ts",
    "bun src/bun-shell.ts",
    "bun test src/bun-shell.test.ts",
    "bun src/template-exec.ts",
    "bun src/template-only.ts",
    "bun src/bun-spawn.ts",
    "bun src/bun-index.ts",
    "bun src/write-script.ts && bash tidy.sh",
    "bun src/computed-require.ts",
    "bun src/dynamic-import.ts",
    "bun src/constructor.ts",
    "bun src/process-index.ts",
    "bun src/worker.ts",
    "bun src/tagged.ts",
    "bun src/guard.ts | sh",
    "bash -c \"$(bun src/guard.ts)\"",
  ];
  test.each(held)("holds %p", (command) => {
    expectHeld(bash(command));
  });

  test("code run inline has its literals read only when it can run them", () => {
    expectAllowed(bash(`bun -e 'throw new Error("tmux kill-server is held")'`));
    expectAllowed(bash(`node -e 'console.log("tmux kill-server")'`));
    expectHeld(bash(`node -e 'const c = "tmux kill-server"; require("child_process").execSync(c)'`));
  });
});

describe("a literal in a module that reaches a runner some way the scan can't follow holds", () => {
  const held = [
    "bun src/run-const.ts",
    "bun src/run-session.ts",
    "bun src/consts.ts; bun src/run-const.ts",
    "bun src/post.ts",
    "bun src/blob-worker.ts",
    "bun src/builtin.ts",
    "bun src/keyed.ts",
    "node src/this-handle.js",
    "bun src/wasm.ts",
    "bun src/computed-key.ts",
    "node src/computed-key.mjs",
    "node src/computed-key.cjs",
    "bun src/computed-key.tsx",
    "bun src/regex-quote.ts",
    "bun src/descriptor.ts",
  ];
  test.each(held)("holds %p", (command) => {
    expectHeld(bash(command));
  });
});

describe("a literal run through an identifier written with a unicode escape holds", () => {
  test.each(Object.keys(ESCAPED))("holds bun %p", (name) => {
    expectHeld(bash(`bun src/${name}`));
  });
  test.each(Object.keys(ESCAPED))("holds node %p", (name) => {
    expectHeld(bash(`node src/${name}`));
  });
});

describe("tmux kills on a private server are allowed as before", () => {
  const scoped = [
    "tmux -L test kill-server",
    "tmux -L test kill-session -t x",
    "tmux -S /tmp/standup-test.sock kill-server",
    "tmux -S /tmp/standup-test.sock kill-window -t x",
    "bash -c 'tmux -L test kill-server'",
    "bash scripts/kill-private.sh",
    "env -u TMUX TMUX_TMPDIR=/tmp/own tmux kill-server",
    // A test ends the sessions it starts, by name (TMUX_RUNNER_OWN).
    "bun test src/exec-session.test.ts",
  ];
  test.each(scoped)("allows %p", (command) => {
    expectAllowed(bash(command));
  });
});
