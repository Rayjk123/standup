import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { argvGatedView } from "./argv-gate.js";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `bun run setup:steering` runs scripts/setup-hooks.ts with --steering-only,
 * which skips the hooks, MCP and Codex writers that name the collector's
 * address and the git-hook installer that names a `systemctl --user restart`.
 * What its own flag tests skip is read as code this run may not reach:
 * Persona's to weigh, not the owner's. A full `bun run setup` and a flag the
 * script doesn't gate on still hold for the owner, and a script the command
 * changes first stays held as unread; a package.json the command changes
 * first leaves its script unread, and it runs.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const FIXTURES = join(import.meta.dir, "fixtures", "false-holds");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

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

const PACKAGE_JSON = fixture("root-package.json.txt");
const SETUP_HOOKS = fixture("setup-hooks.ts.txt");
const SETUP = join(ROOT, "scripts", "setup-hooks.ts");

const BASE_FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "bunfig.toml")]: '[test]\npreload = ["./test-guard.ts"]\n',
  [join(ROOT, "test-guard.ts")]: "export {};\n",
  [SETUP]: SETUP_HOOKS,
  [join(COMMON, "HEAD")]: "ref: refs/heads/main\n",
};

function probes(files: Record<string, string>, env: Record<string, string> = {}): Partial<FloorProbes> {
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
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
    env: (name) => (Object.hasOwn(env, name) ? env[name] : process.env[name]),
  };
}

function bash(command: string, files: Record<string, string> = {}, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes({ ...BASE_FILES, ...files }, env));
}

const PRELOADING_BUNFIG = 'preload = ["./test-guard.ts"]\n';

/** The script with `from` replaced by `to`, failing loudly when `from` isn't in it. */
function edited(from: string, to: string): string {
  if (!SETUP_HOOKS.includes(from)) throw new Error(`setup-hooks fixture lacks ${JSON.stringify(from)}`);
  return SETUP_HOOKS.replace(from, to);
}

function expectNotOwnerHeld(v: FloorVerdict): void {
  if (v.action === "hold") expect({ category: v.category, ownerOnly: v.ownerOnly, reason: v.reason }).toMatchObject({ ownerOnly: false });
}

function expectOwnerHeld(v: FloorVerdict, category: string): void {
  const got: unknown = v.action === "hold" ? { category: v.category, ownerOnly: v.ownerOnly } : v;
  expect(got).toEqual({ category, ownerOnly: true });
}

describe("11. the steering-only setup, read for the code its flag runs", () => {
  test("the fixture is the repository's setup script", () => {
    expect(SETUP_HOOKS).toContain('const steeringOnly = args.includes("--steering-only");');
    expect(PACKAGE_JSON).toContain('"setup:steering": "bun run scripts/setup-hooks.ts --steering-only"');
  });

  for (const command of [
    "bun run setup:steering",
    `cd ${ROOT} && bun run setup:steering`,
    "bun run setup -- --steering-only",
    "bun run setup --steering-only",
    "bun run scripts/setup-hooks.ts --steering-only",
    "bun scripts/setup-hooks.ts --steering-only",
  ]) {
    test(`${command}: what --steering-only skips is Persona's`, () => {
      const v = bash(command);
      expectNotOwnerHeld(v);
      // The collector address the hook and MCP writers name is still reported, as code this run skips.
      expect(v.action === "hold" ? v.reason : "").toContain("calls Standup's own collector API (in code of");
      expect(v.action === "hold" ? v.reason : "").toContain("that this run's arguments skip)");
    });
  }

  const ownerHeld: Array<[string, string, Record<string, string>?]> = [
    ["the full setup", "bun run setup"],
    ["the script without the flag", "bun scripts/setup-hooks.ts"],
    ["steering with Codex wired too", "bun run setup:steering --codex"],
    ["the Codex setup", "bun run setup:codex"],
    ["a flag the script doesn't read", "bun scripts/setup-hooks.ts --steering"],
    ["a flag the shell computes", 'bun scripts/setup-hooks.ts "$FLAG"'],
    ["a preload ahead of the script", "bun --preload ./test-guard.ts scripts/setup-hooks.ts --steering-only"],
    ["a preload in the environment", "BUN_OPTIONS=--preload=./test-guard.ts bun run setup:steering"],
    ["a script copied over it first", "cp /tmp/other.ts scripts/setup-hooks.ts && bun run setup:steering", { "/tmp/other.ts": 'fetch("http://127.0.0.1:17777/api/asks", { method: "POST" });\n' }],
    ["package.json whose script doesn't pass the flag", "bun run setup:steering", { [join(ROOT, "package.json")]: PACKAGE_JSON.replace('scripts/setup-hooks.ts --steering-only"', 'scripts/setup-hooks.ts"') }],
    ["a bunfig that preloads code", "bun run setup:steering", { [join(ROOT, "bunfig.toml")]: 'preload = ["./test-guard.ts"]\n' }],
    ["writers called whatever the flag says", "bun run setup:steering", { [SETUP]: edited("    if (options.hooks !== false) setupHooks(paths);", "    setupHooks(paths);") }],
    ["a guard that runs without returning", "bun run setup:steering", { [SETUP]: edited("if (removeSteeringFlag || removeCodexFlag) {", "if (steeringOnly || removeSteeringFlag || removeCodexFlag) {").replace("    return;\n  }\n\n  runSetup({", "  }\n\n  runSetup({") }],
    ["an else branch on the flag", "bun run setup:steering", { [SETUP]: edited("  if (!options.codexOnly) {\n    if (options.hooks !== false) setupHooks(paths);", "  if (!options.codexOnly) {\n    if (options.hooks === false) {} else setupHooks(paths);") }],
    ["argv changed before the check", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", 'process.argv.push("--codex");\nfunction main(): void {\n') }],
    ["argv changed in the flag function", "bun run setup:steering", { [SETUP]: edited("  const args = process.argv.slice(2);\n", '  const args = process.argv.slice(2);\n  args.splice(0, args.length, "--codex");\n') }],
    ["argv read through process by another name", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", 'const p = process;\np["ar" + "gv"].splice(2);\nfunction main(): void {\n') }],
    ["a builtin replaced", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", "Array.prototype.includes = () => false;\nfunction main(): void {\n") }],
    ["a builtin replaced through computed names", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", 'const P = [][`__pro` + `to__`];\nP["incl" + "udes"] = () => false;\nfunction main(): void {\n') }],
    ["a builtin replaced inside a template", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", "console.log(`${(Object.getPrototypeOf([]).includes = () => false)}`);\nfunction main(): void {\n") }],
    ["a flag shadowed in a block", "bun run setup:steering", { [SETUP]: edited("  runSetup({\n    hooks: !steeringOnly,", "  {\n    const steeringOnly = false;\n    void steeringOnly;\n  }\n  runSetup({\n    hooks: !steeringOnly,") }],
    ["the options object written to", "bun run setup:steering", { [SETUP]: edited("  const paths = resolvePaths(options.home);\n", "  const paths = resolvePaths(options.home);\n  options.hooks = true;\n") }],
    ["the options function called twice", "bun run setup:steering", { [SETUP]: edited("  if (!codexOnly) {\n    console.log(`\\nStandup is wired up", "  runSetup({ hooks: true });\n  if (!codexOnly) {\n    console.log(`\\nStandup is wired up") }],
    ["a relative module the script imports", "bun run setup:steering", { [SETUP]: edited('import { homedir } from "os";\n', 'import { homedir } from "os";\nimport "./prelude.ts";\n'), [join(ROOT, "scripts", "prelude.ts")]: 'process.argv.push("--codex");\n' }],
    ["vm imported", "bun run setup:steering", { [SETUP]: edited('import { homedir } from "os";\n', 'import { homedir } from "os";\nimport vm from "vm";\nvm.runInThisContext("process.argv.push(\'--codex\')");\n') }],
    ["an identifier escape", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", "process.\\u0061rgv.push('--codex');\nfunction main(): void {\n") }],
  ];
  // The options function called again where the reading's identifier count doesn't look.
  ownerHeld.push(
    ["the options function called again inside a template", "bun run setup:steering", { [SETUP]: edited("  if (!codexOnly) {\n    console.log(`\\nStandup is wired up", "  console.log(`${runSetup({ hooks: true })}`);\n  if (!codexOnly) {\n    console.log(`\\nStandup is wired up") }],
    ["the options function called again inside a nested template", "bun run setup:steering", { [SETUP]: edited("  if (!codexOnly) {\n    console.log(`\\nStandup is wired up", "  console.log(`${`${runSetup({ hooks: true })}`}`);\n  if (!codexOnly) {\n    console.log(`\\nStandup is wired up") }],
  );
  // Bun reads a global bunfig from $HOME and $XDG_CONFIG_HOME, which the command itself may point elsewhere.
  ownerHeld.push(
    ["HOME exported to a dir whose bunfig preloads", "export HOME=/tmp/h && bun run setup:steering", { "/tmp/h/.bunfig.toml": PRELOADING_BUNFIG }],
    ["HOME assigned in the shell", "HOME=/tmp/h; bun run setup:steering", { "/tmp/h/.bunfig.toml": PRELOADING_BUNFIG }],
    ["HOME set for the script", "HOME=/tmp/h bun run setup:steering", { "/tmp/h/.bunfig.toml": PRELOADING_BUNFIG }],
    ["XDG_CONFIG_HOME exported", "export XDG_CONFIG_HOME=/tmp/x && bun run setup:steering", { "/tmp/x/.bunfig.toml": PRELOADING_BUNFIG }],
    ["XDG_CONFIG_HOME set for the script", "XDG_CONFIG_HOME=/tmp/x bun run setup:steering", { "/tmp/x/.bunfig.toml": PRELOADING_BUNFIG }],
    ["XDG_CONFIG_HOME set for the script run directly", "XDG_CONFIG_HOME=/tmp/x bun scripts/setup-hooks.ts --steering-only", { "/tmp/x/.bunfig.toml": PRELOADING_BUNFIG }],
    ["HOME unset", "unset HOME; bun run setup:steering"],
  );
  // `{} / 2` divides, though the tokenizer reads a `/` after `}` as a regex: the `}` and `{` it hides close the flag's block and open a plain one around `second()`.
  ownerHeld.push(
    ["a division after `}` that hides where the flag's block ends", "bun scripts/setup-hooks.ts", { [SETUP]: 'function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    const n = {} / 2; } { const m = 1 / 1;\n    second();\n  }\n}\nfunction second() { fetch("http://127.0.0.1:17777/api/asks", { method: "POST" }); }\nmain();\n' }],
    ["the global object reached through a sloppy-mode `this`", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", "function glob() { return this; }\nglob().console = console;\nfunction main(): void {\n") }],
    ["a property descriptor read", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", 'console.log(Object.getOwnPropertyDescriptor(Array, "from"));\nfunction main(): void {\n') }],
    ["property descriptors read", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", "console.log(Object.getOwnPropertyDescriptors(Array));\nfunction main(): void {\n") }],
    ["a builtin replaced through the legacy accessors", "bun run setup:steering", { [SETUP]: edited("function main(): void {\n", 'const AP = [].__lookupGetter__("__pr" + "oto__").call([]);\nAP.__defineGetter__("incl" + "udes", function () { return function () { return false; }; });\nfunction main(): void {\n') }],
  );
  // A `/` after `debugger` and a line break starts a regex, and one after a non-ASCII name divides: read the other way, the braces hide where the flag's block ends.
  const collectorWriter = 'function second() { fetch("http://127.0.0.1:17777/api/asks", { method: "POST" }); }\nmain();\n';
  ownerHeld.push(
    ["a regex after `debugger` that hides where the flag's block ends", "bun scripts/setup-hooks.ts", { [SETUP]: `function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    debugger\n    /{x/\n  }\n  second();\n  debugger\n  /}x/\n}\n${collectorWriter}` }],
    ["a division after a non-ASCII name that hides where the flag's block ends", "bun scripts/setup-hooks.ts", { [SETUP]: `function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    const n = Math.é / 2; } { const m = 1 / 1;\n    second();\n  }\n}\n${collectorWriter}` }],
  );
  // The script's shell starts with an env the floor doesn't know: a preload or a bunfig dir may be in it.
  ownerHeld.push(
    ["an export of a name the floor can't read", 'export "$(cat /tmp/n)=x" && bun run setup:steering'],
    ["an export of a name the floor can't read, then the setup script given the flag",'export "$(cat /tmp/n)=x"; bun run setup -- --steering-only'],
  );
  // An unquoted glob expands against the cwd, here holding a file named `--codex`: the script starts with that flag.
  const flagFile = { [join(ROOT, "--codex")]: "" };
  ownerHeld.push(
    ["a `*` the shell expands to a flag", "bun scripts/setup-hooks.ts --steering-only *", flagFile],
    ["a `?` the shell expands to a flag", "bun scripts/setup-hooks.ts --steering-only --c?dex", flagFile],
    ["a bracket class the shell expands to a flag", "bun scripts/setup-hooks.ts --steering-only --cod[e]x", flagFile],
    ["a glob in a partly quoted word", 'bun scripts/setup-hooks.ts --steering-only "--co"*', flagFile],
    ["zsh's `^` negation the shell expands to a flag", "bun scripts/setup-hooks.ts --steering-only ^x", flagFile],
    ["zsh's `~` exclusion the shell expands to a flag", "bun run scripts/setup-hooks.ts --steering-only --codex~x", flagFile],
    ["zsh's `#` repetition the shell expands to a flag", "bun scripts/setup-hooks.ts --steering-only --co#dex", flagFile],
  );
  // Code that runs may start the entry again with a flag the reading took as absent.
  const MAIN = "function main(): void {\n";
  const selfRun = (code: string, imports = "") => ({ [SETUP]: edited('import { homedir } from "os";\n', `import { homedir } from "os";\n${imports}`).replace(MAIN, `${code}\n${MAIN}`) });
  const CP = 'import { spawnSync, execSync, execFileSync, fork } from "child_process";\n';
  ownerHeld.push(
    ["the entry run again through import.meta.path", "bun run setup:steering", selfRun('Bun.spawnSync(["bun", import.meta.path, "--codex"]);')],
    ["the entry run again by its own path", "bun run setup:steering", selfRun('Bun.spawnSync([import.meta.path, "--codex"]);')],
    ["the entry run again through import.meta.url", "bun run setup:steering", selfRun('Bun.spawnSync(["bun", new URL(import.meta.url).pathname, "--codex"]);')],
    ["the entry run again through import.meta.filename", "bun run setup:steering", selfRun('execFileSync("node", [import.meta.filename, "--codex"]);', CP)],
    ["the entry run again through Bun.main", "bun run setup:steering", selfRun('spawnSync("bun", [Bun.main, "--codex"]);', CP)],
    ["the entry run again in a shell line", "bun run setup:steering", selfRun("execSync(`bun ${import.meta.path} --codex`);", CP)],
    ["the entry run again through Bun's shell", "bun run setup:steering", selfRun("Bun.$`bun ${import.meta.path} --codex`;")],
    ["the entry run again through a name holding its path", "bun run setup:steering", selfRun('const self = import.meta.path;\nBun.spawnSync(["bun", self, "--codex"]);')],
    ["a shell run on a computed line", "bun run setup:steering", selfRun('const line = ["bun", "scripts/setup-hooks.ts", "--codex"].join(" ");\nBun.spawnSync(["sh", "-c", line]);')],
    ["the entry forked", "bun run setup:steering", selfRun('fork("scripts/setup-hooks.ts", ["--codex"]);', CP)],
    ["a process call renamed", "bun run setup:steering", selfRun('run("bun", [import.meta.path, "--codex"]);', 'import { spawnSync as run } from "child_process";\n')],
  );
  for (const [what, command, files] of ownerHeld) {
    test(`${what} still holds for the owner: ${command}`, () => {
      expectOwnerHeld(bash(command, files), "collector-api");
    });
  }

  test("a quoted glob character is the text written, so the steering run stays Persona's", () => {
    for (const command of ["bun scripts/setup-hooks.ts --steering-only '--co*'", 'bun scripts/setup-hooks.ts --steering-only "--c?dex"']) expectNotOwnerHeld(bash(command, flagFile));
  });

  test("an inherited XDG_CONFIG_HOME whose bunfig preloads still holds for the owner", () => {
    expectOwnerHeld(bash("bun run setup:steering", { "/fake/xdg/.bunfig.toml": PRELOADING_BUNFIG }, { XDG_CONFIG_HOME: "/fake/xdg" }), "collector-api");
  });
  test("an inherited relative XDG_CONFIG_HOME still holds for the owner", () => {
    expectOwnerHeld(bash("bun run setup:steering", {}, { XDG_CONFIG_HOME: "cfg" }), "collector-api");
  });
  test("an inherited XDG_CONFIG_HOME with no bunfig keeps the steering run Persona's", () => {
    expectNotOwnerHeld(bash("bun run setup:steering", {}, { XDG_CONFIG_HOME: "/fake/xdg" }));
    expectNotOwnerHeld(bash("bun run setup:steering", { "/fake/xdg/.bunfig.toml": "[test]\npreload = []\n" }, { XDG_CONFIG_HOME: "/fake/xdg" }));
  });

  // A script the command rewrites first in a way the floor can't read is held as it was: what runs isn't known.
  for (const [command, reason] of [
    ["sed -i 's/steeringOnly/x/' scripts/setup-hooks.ts && bun run setup:steering", `runs ${SETUP}, which this same command writes first`],
    ["echo 'process.argv.push(1)' >> scripts/setup-hooks.ts && bun run setup:steering", `runs ${SETUP}, which this same command writes first`],
  ]) {
    test(`unread first, held as unread: ${command}`, () => {
      const v = bash(command);
      expect(v.action === "hold" ? { category: v.category, reason: v.reason } : v).toEqual({ category: "unclassified", reason });
    });
  }

  // A package.json the command rewrites first leaves the script it names unread, which runs.
  test("unread first, allowed: sed -i 's/ --steering-only//' package.json && bun run setup:steering", () => {
    expect(bash("sed -i 's/ --steering-only//' package.json && bun run setup:steering")).toEqual({ action: "allow" });
  });

  test("the full setup's own collector writers count in full", () => {
    const v = bash("bun run setup");
    expect(v.action === "hold" ? v.reason : "").not.toContain("arguments skip");
  });
});

describe("11. the flag reading itself", () => {
  const view = (text: string, argv: string[]) => argvGatedView(text, argv)?.text ?? null;
  test("with --steering-only, the hook and MCP writers and the collector address are left out", () => {
    const text = view(SETUP_HOOKS, ["--steering-only"])!;
    expect(text).toContain("setupSteering(paths)");
    for (const gone of ["setupHooks(paths)", "setupMcp(paths)", "setupCodexMcp(paths)", "localhost:7777", "installGitHooks(join("]) expect(text).not.toContain(gone);
  });
  test("without it, the hook and MCP writers run", () => {
    // Nothing is skipped that the floor can follow, so the whole script is read as before.
    expect(view(SETUP_HOOKS, [])).toBeNull();
  });
  for (const [what, text] of [
    ["no flag function", 'const args = process.argv.slice(2);\nif (!args.includes("--x")) run();\nfunction run() {}\n'],
    ["args read another way", 'function main() {\n  const args = process.argv.slice(2);\n  if (args[0] === "--x") return;\n  run();\n}\nfunction run() {}\nmain();\n'],
    ["args handed on", 'function main() {\n  const args = process.argv.slice(2);\n  if (args.includes("--x")) {\n    return;\n  }\n  run(args);\n}\nfunction run(a) {}\nmain();\n'],
    ["an arrow in the flag function", 'function main() {\n  const args = process.argv.slice(2);\n  const f = () => run();\n  if (args.includes("--x")) {\n    return;\n  }\n  f();\n}\nfunction run() {}\nmain();\n'],
    ["a statement on the line after an unbraced if", 'function main() {\n  const args = process.argv.slice(2);\n  if (args.includes("--x")) run()\n  other();\n}\nfunction run() {}\nfunction other() {}\nmain();\n'],
    ["a line separator in the text", `function main() {\n  const args = process.argv.slice(2);\n  if (args.includes("--x")) {\n    return;\n  }${String.fromCharCode(0x2028)}run();\n}\nfunction run() {}\nmain();\n`],
  ] as const) {
    test(`${what}: not read`, () => {
      expect(view(text, [])).toBeNull();
    });
  }
  test("an inherited property or a comparison with `undefined` decides nothing", () => {
    const text = [
      "function main() {",
      "  const args = process.argv.slice(2);",
      '  const a = args.includes("--a");',
      "  if (a) {",
      "    first();",
      "  }",
      "  run({ a });",
      "}",
      "function run(o) {",
      "  if (o.toString) second();",
      "  if (o.missing === undefined) third();",
      "  if (o.a) fourth();",
      "}",
      "const undefined = 1;",
      "function first() {}",
      "function second() {}",
      "function third() {}",
      "function fourth() {}",
      "main();",
      "",
    ].join("\n");
    const read = view(text, [])!;
    expect(read).not.toContain("first()");
    expect(read).not.toContain("fourth()");
    expect(read).toContain("second()");
    expect(read).toContain("third()");
  });

  // `if (a) /{/` is a regex statement: its brace opens no block, so `second()` sits after the pruned `if` and runs.
  test("a regex after a `)` stretches no pruned block over code that runs", () => {
    const text = 'function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    if (a) /{/ / 1;\n  }\n  second();\n  if (a) /}/ / 1 / 1;\n}\nfunction second() { fetch("http://x"); }\nmain();\n';
    const read = view(text, []);
    if (read !== null) expect(read).toContain("second()");
  });
  test("a regex after a `)` in a template part stretches no pruned block either", () => {
    const text = 'function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    console.log(`${(a) /{/ / 1}`);\n  }\n  second();\n  console.log(`${(a) /}/ / 1}`);\n}\nfunction second() { fetch("http://x"); }\nmain();\n';
    const read = view(text, []);
    if (read !== null) expect(read).toContain("second()");
  });

  // Each `/` divides, but the tokenizer may read it as a regex that hides the `}` closing the flag's block and a `{` opening a plain one.
  for (const [what, line] of [
    ["after `}`", "const n = {} / 2; } { const m = 1 / 1;"],
    ["after a keyword used as a property name", "const n = Math.default / 2; } { const m = 1 / 1;"],
    ["after `?.` and a keyword", "const n = Math?.in / 2; } { const m = 1 / 1;"],
    ["after a postfix `++`", "let i = 0; i++ / 2; } { const m = 1 / 1;"],
    ["after a non-null `!`", "const n = Math.PI! / 2; } { const m = 1 / 1;"],
    ["after `of` used as a name", "const of = 4; of / 2; } { const m = 1 / 1;"],
    ["after a non-ASCII name", "const n = Math.é / 2; } { const m = 1 / 1;"],
  ] as const) {
    test(`a division ${what} stretches no pruned block over code that runs`, () => {
      const text = `function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    ${line}\n    second();\n  }\n}\nfunction second() { fetch("http://x"); }\nmain();\n`;
      const read = view(text, []);
      if (read !== null) expect(read).toContain("second()");
    });
  }

  // A statement ends at the line break after `debugger`, `break` or a type annotation: the `/` opening the next line starts a regex,
  // whose braces the tokenizer would count as real ones stretching the flag's block over `second()`.
  for (const [what, open, close] of [
    ["`debugger`", "debugger\n    /{x/", "debugger\n  /}x/"],
    ["`break`", "for (;;) { break\n    /{x/; }", "for (;;) { break\n  /}x/; }"],
    ["a type annotation", "let v: number\n    /{x/", "let w: number\n  /}x/"],
  ] as const) {
    test(`a regex after ${what} and a line break stretches no pruned block over code that runs`, () => {
      const text = `function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (a) {\n    ${open}\n  }\n  second();\n  ${close}\n}\nfunction second() { fetch("http://x"); }\nmain();\n`;
      const read = view(text, []);
      if (read !== null) expect(read).toContain("second()");
    });
  }

  for (const [what, line] of [
    ["a legacy accessor reaching a prototype", 'const AP = [].__lookupGetter__("__pr" + "oto__").call([]);\nAP.__defineGetter__("incl" + "udes", function () { return function () { return true; }; });'],
    ["a sloppy-mode `this`", "function glob() { return this; }\nglob();"],
    ["getOwnPropertyDescriptor", 'console.log(Object.getOwnPropertyDescriptor(Array, "from"));'],
    ["getOwnPropertyDescriptors", "console.log(Object.getOwnPropertyDescriptors(Array));"],
  ] as const) {
    test(`${what} in code that runs: not read`, () => {
      const text = `${line}\nfunction main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (!a) {\n    first();\n    return;\n  }\n  second();\n}\nfunction first() {}\nfunction second() { fetch("http://x"); }\nmain();\n`;
      expect(view(text, [])).toBeNull();
    });
  }

  // A template or `+` over a name calls that value's `toString` or `valueOf`: only constants built from literals and env reads are left out.
  test("a constant converting a value that may be an object is kept", () => {
    const text = [
      'import o from "some-package";',
      "const s = `${o}`;",
      'const t = "" + o;',
      'const BASE = process.env.BASE_URL ?? "http://localhost:1";',
      "const URL = `${BASE}/hook`;",
      'const SUM = "a" + BASE + 1;',
      "function main() {",
      "  const args = process.argv.slice(2);",
      '  const a = args.includes("--a");',
      "  if (!a) {",
      "    first();",
      "    return;",
      "  }",
      "  second();",
      "}",
      "function first() {}",
      'function second() { fetch("http://x"); }',
      "main();",
      "",
    ].join("\n");
    const read = view(text, [])!;
    expect(read).toContain("const s = `${o}`;");
    expect(read).toContain('const t = "" + o;');
    for (const gone of ["BASE", "URL", "SUM", "localhost:1"]) expect(read).not.toContain(gone);
  });

  test("a false test is skipped, a true one that returns ends the function", () => {
    const text = 'function main() {\n  const args = process.argv.slice(2);\n  const a = args.includes("--a");\n  if (!a) {\n    first();\n    return;\n  }\n  second();\n}\nfunction first() {}\nfunction second() { fetch("http://x"); }\nmain();\n';
    const skipped = view(text, [])!;
    expect(skipped).toContain("first()");
    expect(skipped).not.toContain("second()");
    const other = view(text, ["--a"])!;
    expect(other).not.toContain("first()");
    expect(other).toContain("second()");
  });
});
