import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Bun loads the `preload` modules a bunfig.toml names before the file a plain
 * `bun <file>` or `bun run <file>` runs: the top-level key and the `[run]`
 * table's, from the bunfig.toml where it starts (or the one `--config`
 * names) and the user's global `.bunfig.toml`. Those modules are read like
 * the file itself, so one that writes floor code is held. A bunfig with no
 * preload, a `[test]` preload (only test runs load it), or a preload that
 * only does local work stays allowed.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const XDG = join(HOME, "xdg-config");
const INSTALL_CLASSIFY = join(INSTALL, "packages", "collector", "src", "floor", "classify.ts");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const EVIL = `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(INSTALL_CLASSIFY)}, "export {};\\n");\n`;
const LOCAL = `import { writeFileSync } from "fs";\nwriteFileSync("/tmp/preloaded.txt", "ok\\n");\n`;

const BASE: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "scripts", "ok.ts")]: `console.log("ok");\n`,
  [join(ROOT, "evil.ts")]: EVIL,
  [join(ROOT, "local.ts")]: LOCAL,
  [join(ROOT, "sub", "ok.ts")]: `console.log("ok");\n`,
  [join(ROOT, "package.json")]: JSON.stringify({ name: "x", scripts: { go: "bun scripts/ok.ts" } }),
  [join(OWN_SCRATCH, "evil.ts")]: EVIL,
  [INSTALL_CLASSIFY]: "export const y = 1;\n",
};

function probes(extra: Record<string, string>, env: Record<string, string> = {}): Partial<FloorProbes> {
  const files = { ...BASE, ...extra };
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
    env: (name) => env[name],
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, extra: Record<string, string> = {}, env: Record<string, string> = {}, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(extra, env));
}

const bunfig = (text: string) => ({ [join(ROOT, "bunfig.toml")]: text });

describe("a bunfig preload that writes floor code is read for a plain bun run", () => {
  test("the preload run directly is held (baseline)", () => {
    expect(bash("bun evil.ts")).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test.each([
    ["bun scripts/ok.ts", bunfig(`preload = ["./evil.ts"]\n`)],
    ["bun run scripts/ok.ts", bunfig(`preload = ["./evil.ts"]\n`)],
    ["bun ./scripts/ok.ts", bunfig(`preload = "./evil.ts"\n`)],
    ["bun scripts/ok.ts", bunfig(`telemetry = false\npreload = [\n  "./local.ts",\n  "./evil.ts",\n]\n`)],
    ["bun scripts/ok.ts", bunfig(`[run]\npreload = ["./evil.ts"]\n`)],
    ["bun scripts/ok.ts", bunfig(`run.preload = ["./evil.ts"]\n`)],
    ["bun scripts/ok.ts", bunfig(`preload = ["${join(OWN_SCRATCH, "evil.ts")}"]\n`)],
    ["bun scripts/ok.ts", { [join(ROOT, ".bunfig.toml")]: `preload = ["./evil.ts"]\n` }],
    ["bun scripts/ok.ts", { [join(HOME, ".bunfig.toml")]: `preload = ["${join(ROOT, "evil.ts")}"]\n` }],
    ["bun scripts/ok.ts", { [join(HOME, ".config", ".bunfig.toml")]: `preload = ["${join(ROOT, "evil.ts")}"]\n` }],
    ["bun --cwd sub ok.ts", { [join(ROOT, "sub", "bunfig.toml")]: `preload = ["../evil.ts"]\n` }],
    ["cd sub && bun ok.ts", { [join(ROOT, "sub", "bunfig.toml")]: `preload = ["../evil.ts"]\n` }],
    ["bun --config=./other.toml scripts/ok.ts", { [join(ROOT, "other.toml")]: `preload = ["./evil.ts"]\n` }],
    ["bun run go", bunfig(`preload = ["./evil.ts"]\n`)],
    ["bun -e 'console.log(1)'", bunfig(`preload = ["./evil.ts"]\n`)],
    ["bun run --config=./other.toml scripts/ok.ts", { [join(ROOT, "other.toml")]: `preload = ["./evil.ts"]\n` }],
    ["bun --config ./other.toml scripts/ok.ts", { [join(ROOT, "other.toml")]: `preload = ["./evil.ts"]\n` }],
    ["bun --config ./other.toml scripts/ok.ts", bunfig(`preload = ["./evil.ts"]\n`)],
    ["bun run --preload=./evil.ts scripts/ok.ts", {}],
    ["HOME=/fake/other bun scripts/ok.ts", { [join("/", "fake", "other", ".bunfig.toml")]: `preload = ["${join(ROOT, "evil.ts")}"]\n` }],
    ["bun scripts/ok.ts", { [join(HOME, ".bunfig.toml")]: `preload = ["~/evil.ts"]\n`, [join(HOME, "evil.ts")]: EVIL }],
  ])("%p with %p is held", (command, extra) => {
    expect(bash(command, extra)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test("a global bunfig under XDG_CONFIG_HOME is read", () => {
    const extra = { [join(XDG, ".bunfig.toml")]: `preload = ["${join(ROOT, "evil.ts")}"]\n` };
    expect(bash("bun scripts/ok.ts", extra, { XDG_CONFIG_HOME: XDG })).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test("a bunfig the command itself writes is held", () => {
    expect(bash(`echo 'preload=["./evil.ts"]' > bunfig.toml && bun scripts/ok.ts`)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test("a bunfig the command writes with text the floor can't see is held as a script written that way is", () => {
    expect(bash(`git show HEAD:x.ts > scripts/ok.ts && bun scripts/ok.ts`)).toMatchObject({ action: "hold", category: "unclassified" });
    expect(bash(`git show HEAD:x.toml > bunfig.toml && bun scripts/ok.ts`)).toMatchObject({ action: "hold", category: "unclassified", reason: expect.stringContaining("bunfig this same command writes first") });
  });
});

describe("an env file where the screenshot helper starts that points it at a planted Playwright toolchain", () => {
  const HELPER = join(INSTALL, "scripts", "pipeline-screenshot.ts");
  const PLANTED = { [HELPER]: `console.log("shot");\n`, [join("/tmp", "pw", "node_modules", "playwright", "index.js")]: EVIL };
  const command = `bun ${HELPER} http://localhost:5173/ --out /tmp/a.png`;

  test.each([
    [{ [join(ROOT, ".env")]: "STANDUP_PLAYWRIGHT_DIR=/tmp/pw\n" }],
    [{ [join(ROOT, ".env.local")]: "export PLAYWRIGHT_BROWSERS_PATH='/tmp/pw'\n" }],
    [{ [join(ROOT, ".env")]: "STANDUP_PLAYWRIGHT_DIR=${PW}\n" }],
  ])("%p is held", (extra) => {
    expect(bash(command, { ...PLANTED, ...extra })).toMatchObject({ action: "hold", category: "unclassified", reason: expect.stringContaining("Playwright toolchain") });
  });

  test.each([
    [{}],
    [{ [join(ROOT, ".env")]: "STANDUP_PLAYWRIGHT_DIR=/tmp/nothing-there\n" }],
    [{ [join(ROOT, ".env")]: "OTHER=1\n" }],
  ])("%p is allowed", (extra) => {
    expect(bash(command, { ...PLANTED, ...extra })).toEqual({ action: "allow" });
  });

  test("a variable the run is handed wins over the env file", () => {
    expect(bash(command, { ...PLANTED, [join(ROOT, ".env")]: "STANDUP_PLAYWRIGHT_DIR=/tmp/pw\n" }, { STANDUP_PLAYWRIGHT_DIR: "/tmp/nothing-there" })).toEqual({ action: "allow" });
  });
});

describe("bunfigs that leave a plain bun run local stay allowed", () => {
  test.each([
    ["bun scripts/ok.ts", {}],
    ["bun scripts/ok.ts", bunfig(`telemetry = false\n[install]\nexact = true\n`)],
    ["bun scripts/ok.ts", bunfig(`preload = ["./local.ts"]\n`)],
    ["bun run scripts/ok.ts", bunfig(`[run]\npreload = ["./local.ts"]\n`)],
    ["bun scripts/ok.ts", bunfig(`[test]\npreload = ["./evil.ts"]\n`)],
    ["bun scripts/ok.ts", bunfig(`test.preload = ["./evil.ts"]\n`)],
    ["bun scripts/ok.ts", { [join(HOME, ".bunfig.toml")]: `preload = ["${join(ROOT, "local.ts")}"]\n` }],
    ["bun run go", bunfig(`preload = ["./local.ts"]\n`)],
    ["bun --config=./other.toml scripts/ok.ts", { ...bunfig(`preload = ["./evil.ts"]\n`), [join(ROOT, "other.toml")]: `preload = ["./local.ts"]\n` }],
  ])("%p with %p is allowed", (command, extra) => {
    expect(bash(command, extra)).toEqual({ action: "allow" });
  });
});
