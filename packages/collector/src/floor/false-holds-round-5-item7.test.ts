import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Scripts run with `bun` and a `--out <file>` flag of their own: the flag is
 * the script's argument, not a write the floor can name, and a script whose
 * name starts with or equals a bun subcommand is still a script bun runs.
 * The machine is virtual.
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

const PACKAGE_JSON = JSON.stringify({ name: "standup", scripts: { test: "bun test" } });
const SAFE = "console.log(process.argv.slice(2).join(' '));\n";
const PUSHING = 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n';

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(ROOT, "scripts", "foo.ts")]: SAFE,
  [join(ROOT, "scripts", "add.ts")]: SAFE,
  [join(ROOT, "scripts", "push.ts")]: PUSHING,
  [join(ROOT, "build.mjs")]: SAFE,
  [join(ROOT, "add-thing.ts")]: SAFE,
  [join(ROOT, "a.ts")]: SAFE,
  [join(ROOT, "x.ts")]: SAFE,
  [join(ROOT, "add.ts")]: SAFE,
  [join(ROOT, "install.js")]: SAFE,
  [join(ROOT, "i.tsx")]: SAFE,
  [join(ROOT, "pm.cjs")]: SAFE,
  [join(ROOT, "test.jsx")]: SAFE,
  [join(ROOT, "run.ts")]: SAFE,
  [join(ROOT, "build.ts")]: SAFE,
  [join(ROOT, "create.ts")]: SAFE,
  [join(ROOT, "remove.ts")]: SAFE,
  [join(ROOT, "add-push.ts")]: PUSHING,
  [join(ROOT, "x-push.ts")]: PUSHING,
  [join(INSTALL, "scripts", "pipeline-screenshot.ts")]: SAFE,
  [join(INSTALL, "scripts", "add.ts")]: SAFE,
  [join(INSTALL, "add-thing.ts")]: SAFE,
  [join(ROOT, "usage.ts")]: 'const USAGE = "usage: bun scripts/usage.ts <url> [--out <file>]";\nconsole.log(USAGE);\n',
  [join(ROOT, "usage2.ts")]: 'console.error("  --out <file>   where to write the capture");\n',
  [join(ROOT, "usage3.ts")]: "console.error(`Usage: bun usage3.ts --out <path> <url>`);\n",
  [join(ROOT, "usage4.ts")]: 'console.error("Usage: bun add-thing.ts <name>");\nconsole.error("then: bun scripts/add.ts --out out.json");\n',
  [join(ROOT, "scripts", "runs-add.ts")]: 'import { execSync } from "child_process";\nexecSync("bun scripts/add.ts");\nexecSync("bun add-thing.ts --out /tmp/x.json");\n',
  [join(ROOT, "scripts", "runs-out.ts")]: 'import { execSync } from "child_process";\nexecSync("bun scripts/foo.ts --out /tmp/x.json");\nexecSync("node build.mjs --out dist/x.js");\n',
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
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
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

describe("a script's own --out flag is its argument, not a write the floor names", () => {
  const allowed = [
    `bun ${INSTALL}/scripts/pipeline-screenshot.ts http://localhost:5173/x --out /tmp/standup-screenshots-1000/a.png`,
    `mkdir -p /tmp/standup-screenshots-1000 && bun ${INSTALL}/scripts/pipeline-screenshot.ts http://localhost:5173/x --out /tmp/standup-screenshots-1000/a.png`,
    "bun scripts/foo.ts --out /tmp/r.json",
    "bun scripts/foo.ts --out=/tmp/r.json",
    "bun scripts/foo.ts -o /tmp/r.json",
    "bun scripts/foo.ts -o/tmp/r.json",
    "bun scripts/foo.ts --output /tmp/r.json",
    "bun scripts/foo.ts --outdir /tmp/o",
    "bun scripts/foo.ts --outfile /tmp/o.js",
    "bun scripts/foo.ts --out /tmp/r.json 2>&1 | tail -5",
    "bun scripts/foo.ts --out /tmp/r.json && cat /tmp/r.json",
    "timeout 60 bun scripts/foo.ts --out /tmp/r.json",
    "bun run scripts/foo.ts --out /tmp/r.json",
    `bun ${ROOT}/scripts/foo.ts --out /tmp/r.json`,
    `cd /tmp && bun ${ROOT}/scripts/foo.ts --out r.json`,
    "mkdir -p /tmp/standup-screenshots-1000 && bun scripts/foo.ts --out /tmp/standup-screenshots-1000/a.png",
    "node build.mjs --out dist/x.js",
    "node --test build.mjs --out /tmp/x",
    "bun build.mjs --out dist/x.js",
    "bun build.mjs --outdir dist",
    "bun build.mjs --outfile dist/x.js",
    "npx tsx scripts/foo.ts --out /tmp/r.json",
    "bunx tsx scripts/foo.ts --out /tmp/r.json",
    "bun x tsx scripts/foo.ts --out /tmp/r.json",
    // Usage text naming `--out <file>` is read as a command that doesn't parse, not as a redirect.
    "bun usage.ts --out /tmp/a.png",
    "bun usage2.ts",
    "bun usage3.ts",
    "bun scripts/runs-out.ts",
  ];
  test.each(allowed)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("a real redirect, a bundler's own output flag, and the helper's --out into owner ground still hold", () => {
    expectHeld(bash(`bun scripts/foo.ts --out /tmp/r.json > ${INSTALL}/x`), "floor-tamper");
    expectHeld(bash(`bun scripts/foo.ts > ${INSTALL}/x`), "floor-tamper");
    expectHeld(bash(`echo hi > ${INSTALL}/x`), "floor-tamper");
    expectHeld(bash(`bun build src/app.ts --outfile ${INSTALL}/x.js`), "floor-tamper");
    expectHeld(bash(`bun build src/app.ts --outdir ${INSTALL}`), "floor-tamper");
    expectHeld(bash(`bun ${INSTALL}/scripts/pipeline-screenshot.ts http://localhost:5173/x --out ${INSTALL}/a.png`), "floor-tamper");
    expectHeld(bash(`bun ${INSTALL}/scripts/pipeline-screenshot.ts http://localhost:5173/x --out ${DATA}/secrets/a.png`), "floor-tamper");
    expectHeld(bash(`bun scripts/foo.ts --out ${DATA}/secrets/a.json`), "floor-tamper");
  });

  test("what the script does still decides, whatever its flags", () => {
    expectHeld(bash("bun scripts/push.ts --out /tmp/r.json"), "outward");
  });
});

describe("a bun script named like a subcommand is a script bun runs", () => {
  const allowed = [
    "bun add-thing.ts",
    "bun scripts/add.ts",
    "bun ./a.ts",
    "bun x.ts",
    "bun add.ts",
    "bun install.js",
    "bun i.tsx",
    "bun pm.cjs",
    "bun test.jsx",
    "bun run.ts",
    "bun build.ts",
    "bun create.ts",
    "bun remove.ts",
    "bun usage4.ts",
    "bun add-missing.ts",
    "bun /tmp/missing/add.ts",
    "bun x.ts add",
    "bun x.ts --out /tmp/a",
    "bun ./add.ts install",
    "bun --bun add.ts",
    "bun --watch scripts/add.ts",
    "bun --hot x.ts",
    "bun -b x.ts",
    "bun --smol add.ts",
    "bun run scripts/add.ts --out /tmp/a",
    "bunx tsx scripts/add.ts --out /tmp/a",
    "bun scripts/runs-add.ts",
  ];
  test.each(allowed)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("the script is read: one that pushes holds, whatever its name", () => {
    for (const command of ["bun scripts/push.ts", "bun add-push.ts", "bun x-push.ts"]) expectHeld(bash(command), "outward");
  });

  test("a script run from inside the install is install code, run as it is from outside; a real subcommand there still holds", () => {
    expectAllowed(bash(`cd ${INSTALL} && bun scripts/add.ts`));
    expectAllowed(bash(`cd ${INSTALL} && bun add-thing.ts`));
    expectAllowed(bash(`bun --cwd ${INSTALL} add-thing.ts`));
    expectHeld(bash(`cd ${INSTALL} && bun add left-pad`), "floor-tamper");
  });

  test("real subcommands keep their classification", () => {
    expectAllowed(bash("bun add left-pad"));
    expectAllowed(bash("bun install"));
    expectAllowed(bash("bun x cowsay hi"));
    expectAllowed(bash("bunx cowsay hi"));
    expectHeld(bash(`cd ${INSTALL} && bun add left-pad`), "floor-tamper");
    expectHeld(bash(`cd ${INSTALL} && bun install`), "floor-tamper");
  });
});
