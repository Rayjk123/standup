import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The browsers Playwright launches (`~/.cache/ms-playwright/**`) are part of
 * what the screenshot helper runs, so a write there stays the owner's call.
 * Launching one (`executablePath` in a worker's own script, the binary run
 * directly) or reading it only reads, and is allowed. `playwright install`
 * with PLAYWRIGHT_BROWSERS_PATH in the worker's own ground (its worktree, its
 * launch's scratch dir, /tmp) writes only there and is allowed; aimed at the
 * default dir, another launch's scratch dir or a path the floor can't place
 * it stays held.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const MS = join(HOME, ".cache", "ms-playwright");
const CHROME = join(MS, "chromium-1187", "chrome-linux", "chrome");
const SHELL = join(MS, "chromium_headless_shell-1187", "chrome-linux", "headless_shell");
const SHELL64 = join(MS, "chromium_headless_shell-1187", "chrome-headless-shell-linux64", "chrome-headless-shell");
const LIVE = join("/tmp", "r8-live-CcJPf5");
const LIVE_HOME = join(LIVE, "home");
const LIVE_CHROME = join(LIVE_HOME, ".cache", "ms-playwright", "chromium-1248", "chrome-linux64", "chrome");
const LIVE_ENV: Record<string, string> = {
  HOME: LIVE_HOME,
  XDG_CACHE_HOME: join(LIVE, "xdg", "cache"),
  XDG_CONFIG_HOME: join(LIVE, "xdg", "config"),
  XDG_DATA_HOME: join(LIVE, "xdg", "data"),
  XDG_STATE_HOME: join(LIVE, "xdg", "state"),
  TMPDIR: join(LIVE, "tmp"),
};

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

const launch = (exe: string) =>
  `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst browser = await chromium.launch({ headless: true, executablePath: "${exe}" });\nconst page = await browser.newPage();\nawait page.goto("http://127.0.0.1:5173/");\nawait page.screenshot({ path: "/tmp/shot.png" });\nwriteFileSync("/tmp/shot.json", JSON.stringify({ title: await page.title() }));\nawait browser.close();\n`;
const persistent = (exe: string) =>
  `const { chromium } = require("playwright");\nconst fs = require("fs");\n(async () => {\n  const ctx = await chromium.launchPersistentContext("/tmp/pw-profile", { executablePath: "${exe}", args: ["--no-sandbox"] });\n  fs.writeFileSync("/tmp/out.txt", "ok");\n  await ctx.close();\n})();\n`;
/** The browser path also handed to a write: held as the write it may be. */
const launchAndWrite = (exe: string) =>
  `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst exe = "${exe}";\nconst browser = await chromium.launch({ executablePath: exe });\nwriteFileSync(exe, "#!/bin/sh\\n");\n`;
const optionsReused = (exe: string) =>
  `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst opts = { executablePath: "${exe}" };\nawait chromium.launch(opts);\nwriteFileSync(opts.executablePath, "#!/bin/sh\\n");\n`;
const sameLiteralTwice = (exe: string) =>
  `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nawait chromium.launch({ executablePath: "${exe}" });\nwriteFileSync("${exe}", "#!/bin/sh\\n");\n`;

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "shot.ts")]: launch(CHROME),
  [join(ROOT, "shot.mjs")]: launch(SHELL).replace('import { chromium } from "playwright";', 'import { chromium } from "playwright-core";'),
  [join(ROOT, "shot64.ts")]: launch(SHELL64),
  [join(OWN_SCRATCH, "shot.ts")]: launch(SHELL),
  [join(ROOT, "persist.cjs")]: persistent(SHELL),
  [join(ROOT, "launch-write.ts")]: launchAndWrite(CHROME),
  [join(ROOT, "opts-reused.ts")]: optionsReused(CHROME),
  [join(ROOT, "twice.ts")]: sameLiteralTwice(CHROME),
  [join(ROOT, "own-launcher.ts")]: `import { writeFileSync } from "fs";\nconst chromium = { launch(o) { writeFileSync(o.executablePath, "x"); } };\nchromium.launch({ executablePath: "${CHROME}" });\n`,
  [join(ROOT, "other-module.ts")]: `import { chromium } from "./my-pw";\nimport { writeFileSync } from "fs";\nawait chromium.launch({ executablePath: "${CHROME}" });\nwriteFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "renamed.ts")]: `import { chromium as c } from "playwright";\nimport { writeFileSync } from "fs";\nlet chromium = { launch: (o) => writeFileSync(o.executablePath, "x") };\nawait chromium.launch({ executablePath: "${CHROME}" });\n`,
  [join(ROOT, "param.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nfunction go(chromium) { return chromium.launch({ executablePath: "${CHROME}" }); }\ngo({ launch: (o) => writeFileSync(o.executablePath, "x") });\n`,
  [join(ROOT, "reassigned.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nchromium.launch = (o) => writeFileSync(o.executablePath, "x");\nawait chromium.launch({ executablePath: "${CHROME}" });\n`,
  [join(ROOT, "plant.ts")]:`import { writeFileSync } from "fs";\nwriteFileSync("${CHROME}", "#!/bin/sh\\n");\n`,
  // The literal recovered from the code's own text and written.
  [join(ROOT, "fn-source.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst go = () => chromium.launch({ executablePath: "${CHROME}" });\nwriteFileSync(go.toString().split(String.fromCharCode(34))[1], "#!/bin/sh\\n");\n`,
  [join(ROOT, "fn-template.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst go = () => chromium.launch({ executablePath: "${CHROME}" });\nconst s = \`\${go}\`;\nwriteFileSync(s.slice(s.indexOf("/"), s.lastIndexOf("chrome") + 6), "x");\n`,
  [join(ROOT, "fn-concat.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst go = () => chromium.launch({ executablePath: "${CHROME}" });\nconst s = go + "";\nwriteFileSync(s.slice(s.indexOf("/"), s.lastIndexOf("chrome") + 6), "x");\n`,
  [join(ROOT, "self-read.ts")]: `import { chromium } from "playwright";\nimport { readFileSync, writeFileSync } from "fs";\nawait chromium.launch({executablePath: "${CHROME}"});\nconst t = readFileSync(import.meta.path, "utf8");\nwriteFileSync(t.slice(t.indexOf("/fake"), t.indexOf("chrome\\"")), "#!/bin/sh\\n");\n`,
  [join(ROOT, "self-read-argv.cjs")]: `const { chromium } = require("playwright");\nconst fs = require("fs");\nchromium.launch({ executablePath: "${CHROME}" });\nconst t = fs.readFileSync(process.argv[1], "utf8");\nfs.writeFileSync(t.split("executablePath: ")[1].slice(1, 60), "x");\n`,
  [join(ROOT, "computed-write.ts")]: `import { chromium } from "playwright";\nimport { readFileSync, writeFileSync } from "fs";\nawait chromium.launch({ executablePath: "${CHROME}" });\nconst p = readFileSync("/tmp/where", "utf8");\nwriteFileSync(p, "x");\n`,
  [join(ROOT, "aliased-writer.ts")]: `import { chromium } from "playwright";\nimport * as fs from "fs";\nawait chromium.launch({ executablePath: "${CHROME}" });\nconst w = fs.writeFileSync;\nw(process.env.WHERE, "x");\nfs.writeFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "screenshot-computed.ts")]: `import { chromium } from "playwright";\nimport { readFileSync, writeFileSync } from "fs";\nconst browser = await chromium.launch({ executablePath: "${CHROME}" });\nconst page = await browser.newPage();\nconst where = readFileSync("/tmp/where", "utf8");\nawait page.screenshot({ path: where });\nwriteFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "user-data-dir.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nawait chromium.launch({ executablePath: "${CHROME}", args: ["--user-data-dir=${join(MS, "chromium-1187")}"] });\nwriteFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "persist-ms.ts")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nawait chromium.launchPersistentContext("${join(MS, "chromium-1187")}", { executablePath: "${CHROME}" });\nwriteFileSync("/tmp/x", "y");\n`,
  // A playwright package of the worker's own, which the bare import loads.
  [join(ROOT, "w", "node_modules", "playwright", "index.js")]: `const fs = require("fs");\nexports.chromium = { launch(o) { fs.writeFileSync(o.executablePath, "#!/bin/sh\\n"); } };\n`,
  [join(ROOT, "w", "fakepw.ts")]: launch(CHROME),
  [join(ROOT, "w", "sub", "fakepw.ts")]: launch(CHROME),
  [join("/tmp", "np", "playwright", "index.js")]: `exports.chromium = {};\n`,
  [join(ROOT, "t", "tsconfig.json")]: `{ "compilerOptions": { "paths": { "playwright": ["./pw.ts"] } } }\n`,
  [join(ROOT, "t", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tstar", "tsconfig.json")]: `{ "compilerOptions": { "paths": { "@app/*": ["./src/*"], "*": ["./vendor/*"] } } }\n`,
  [join(ROOT, "tstar", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tsub", "jsconfig.json")]: `{ "compilerOptions": { "paths": { "playwright-core/*": ["./pw/*"] } } }\n`,
  [join(ROOT, "tsub", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tscope", "tsconfig.json")]: `{ "compilerOptions": { "paths": { "@playwright/*": ["./pw/*"] } } }\n`,
  [join(ROOT, "tscope", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tjsonc", "tsconfig.json")]: `{\n  // comments make it JSONC\n  "compilerOptions": { "paths": { "@app/x": ["./x"] } }\n}\n`,
  [join(ROOT, "tjsonc", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tbase", "tsconfig.json")]: `{ "compilerOptions": { "baseUrl": "." } }\n`,
  [join(ROOT, "tbase", "shot.ts")]: launch(CHROME),
  [join(ROOT, "text", "tsconfig.json")]: `{ "extends": "./base.json" }\n`,
  [join(ROOT, "text", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tdup", "tsconfig.json")]: `{ "compilerOptions": { "paths": { "@app/x": ["./x"] }, "paths": { "playwright": ["./pw.ts"] } } }\n`,
  [join(ROOT, "tdup", "shot.ts")]: launch(CHROME),
  [join(ROOT, "tok", "tsconfig.json")]: `{ "compilerOptions": { "paths": { "@app/*": ["./src/*"], "playwrightish": ["./x"], "puppet/*": ["./p/*"] } } }\n`,
  [join(ROOT, "tok", "shot.ts")]: launch(CHROME),
  [join("/tmp", "pwin", "x")]: "x\n",
  [join("/tmp", "pwok", "chromium-1187", "x")]: "x\n",
  [CHROME]: "bin\n",
  [SHELL]: "bin\n",
  [SHELL64]: "bin\n",
  [join(SCRATCH, "launch-2", "pw", "x")]: "x\n",
  // The worktree's own tsconfig, mapping only its workspace packages.
  [join(ROOT, "tsconfig.json")]: `{\n  "compilerOptions": {\n    "moduleResolution": "bundler",\n    "paths": {\n      "@standup/shared": ["./packages/shared/src"],\n      "@standup/shared/steering": ["./packages/shared/src/steering.ts"]\n    }\n  },\n  "exclude": ["node_modules", "dist"]\n}\n`,
  // A run under an isolated HOME and XDG_CACHE_HOME, its script outside the worktree.
  [join(LIVE, "scripts", "shot.ts")]: launch(LIVE_CHROME).replace('"/tmp/shot.png"', `"${join(LIVE, "tmp", "shot.png")}"`).replace('"/tmp/shot.json"', `"${join(LIVE, "tmp", "shot.json")}"`),
  [LIVE_CHROME]: "bin\n",
  [join(LIVE, "xdg", "cache", "ms-playwright", "chromium-1248", "chrome-linux64", "chrome")]: "bin\n",
  [join(LIVE, "scripts", "xdg-shot.ts")]: launch(join(LIVE, "xdg", "cache", "ms-playwright", "chromium-1248", "chrome-linux64", "chrome")),
  [join(LIVE, "home2", ".node_modules", "playwright", "index.js")]: `exports.chromium = {};\n`,
  [join(LIVE, "home2", ".cache", "ms-playwright", "chromium-1248", "chrome-linux64", "chrome")]: "bin\n",
};

/** Symlinks: path → where it points. */
const LINKS: Record<string, string> = {
  [join("/tmp", "pwin", "chromium-1187")]: join(MS, "chromium-1187"),
  [join("/tmp", "pwok", "latest")]: join("/tmp", "pwok", "chromium-1187"),
};

function probes(env: Record<string, string> = {}): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, join(ROOT, "node_modules", ".bin")]);
  for (const f of [...Object.keys(FILES), ...Object.keys(LINKS)]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const followed = (p: string): string => {
    for (const [link, to] of Object.entries(LINKS)) if (p === link || p.startsWith(`${link}/`)) return to + p.slice(link.length);
    return p;
  };
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
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...Object.keys(LINKS), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in LINKS ? followed(p) : p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (p in LINKS ? { symlink: true, file: false, nlink: 1 } : p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => env.HOME ?? HOME,
    env: (name) => env[name] ?? (name === "HOME" ? HOME : name === "TMPDIR" ? OWN_SCRATCH : undefined),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(env));
}

function expectAllowed(command: string, env: Record<string, string> = {}): void {
  expect({ command, verdict: bash(command, env) }).toEqual({ command, verdict: { action: "allow" } });
}

function expectHeld(command: string, category: string, highRisk = true, env: Record<string, string> = {}): void {
  const v = bash(command, env);
  expect({ command, v }).toMatchObject({ command, v: { action: "hold", category } });
  if (highRisk) expect({ command, ownerReserved: v.action === "hold" && v.ownerReserved === true }).toEqual({ command, ownerReserved: true });
}

describe("launching or reading a Playwright browser", () => {
  test.each([
    "bun shot.ts",
    "bun run shot.ts",
    "node shot.mjs",
    "bun shot64.ts",
    "node persist.cjs",
    `bun ${join(OWN_SCRATCH, "shot.ts")}`,
    `cd ${OWN_SCRATCH} && bun shot.ts`,
    `${SHELL} --version`,
    `${CHROME} --headless --dump-dom http://127.0.0.1:5173/`,
    `~/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell --version`,
    `$HOME/.cache/ms-playwright/chromium-1187/chrome-linux/chrome --version`,
    `ls ${MS}`,
    `ls -la ${join(MS, "chromium-1187", "chrome-linux")}`,
    `ls ~/.cache/ms-playwright/`,
    `cat ${join(MS, "chromium-1187", "chrome-linux", "chrome")} | head -c 4`,
    `file ${SHELL}`,
    `find ${MS} -maxdepth 2 -name 'chrom*'`,
    `cp ${SHELL} /tmp/headless_shell`,
  ])("allows %p", (command) => {
    expectAllowed(command);
  });
});

describe("a launch under an isolated HOME and XDG_CACHE_HOME, its script outside the worktree", () => {
  test("is allowed with the worktree's tsconfig mapping only its own packages", () => {
    expectAllowed(`bun ${join(LIVE, "scripts", "shot.ts")}`, LIVE_ENV);
  });

  test("its browser under XDG_CACHE_HOME is allowed too", () => {
    expectAllowed(`bun ${join(LIVE, "scripts", "xdg-shot.ts")}`, LIVE_ENV);
  });

  test("a tsconfig whose paths map only names near a launcher's is allowed", () => {
    expectAllowed("cd tok && bun shot.ts");
  });

  test("the isolated HOME holding a .node_modules playwright stays held", () => {
    expectHeld(`bun ${join(LIVE, "scripts", "xdg-shot.ts")}`, "floor-tamper", true, { ...LIVE_ENV, HOME: join(LIVE, "home2") });
  });

  test("run from a dir whose tsconfig maps playwright stays held", () => {
    expectHeld(`cd t && bun ${join(LIVE, "scripts", "shot.ts")}`, "floor-tamper", true, LIVE_ENV);
  });
});

describe("writes into the browsers Playwright launches stay held", () => {
  test.each([
    `cp /tmp/chrome ${CHROME}`,
    `mv /tmp/chrome ${SHELL}`,
    `rm -rf ${join(MS, "chromium-1187")}`,
    `echo x > ${CHROME}`,
    `echo x | tee ${SHELL64}`,
    `chmod 777 ${CHROME}`,
    `ln -sf /tmp/chrome ${CHROME}`,
    "bun plant.ts",
    "bun launch-write.ts",
    "bun opts-reused.ts",
    "bun twice.ts",
    "bun own-launcher.ts",
    "bun other-module.ts",
    "bun renamed.ts",
    "bun param.ts",
    "bun reassigned.ts",
    `${CHROME} --screenshot=${join(MS, "x.png")} http://127.0.0.1:5173/`,
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });
});

describe("a launch in code that may recover the browser path and write there stays held", () => {
  test.each([
    "bun fn-source.ts",
    "bun fn-template.ts",
    "bun fn-concat.ts",
    "bun self-read.ts",
    "node self-read-argv.cjs",
    "bun computed-write.ts",
    "bun aliased-writer.ts",
    "bun screenshot-computed.ts",
    "bun user-data-dir.ts",
    "bun persist-ms.ts",
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });
});

describe("a launch whose bare import may load a package other than Playwright's stays held", () => {
  test.each([
    "cd w && bun fakepw.ts",
    "bun w/fakepw.ts",
    `bun ${join(ROOT, "w", "sub", "fakepw.ts")}`,
    "cd t && bun shot.ts",
    "cd tstar && bun shot.ts",
    "cd tsub && bun shot.ts",
    "cd tscope && bun shot.ts",
    "cd tjsonc && bun shot.ts",
    "cd tbase && bun shot.ts",
    "cd text && bun shot.ts",
    "cd tdup && bun shot.ts",
    "NODE_PATH=/tmp/np bun shot.ts",
    "NODE_PATH=$WHERE bun shot.ts",
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });

  test("a NODE_PATH in the worker's environment holding one", () => {
    expectHeld("bun shot.ts", "floor-tamper", true, { NODE_PATH: "/tmp/np" });
  });
});

describe("playwright install into an own dir holding a link out of it stays held", () => {
  test("a link to the helper's browsers inside the dir", () => {
    expectHeld("PLAYWRIGHT_BROWSERS_PATH=/tmp/pwin npx playwright install --force chromium", "floor-tamper");
  });

  test("a link within the dir is allowed", () => {
    expectAllowed("PLAYWRIGHT_BROWSERS_PATH=/tmp/pwok npx playwright install --force chromium");
  });
});

describe("playwright install into the worker's own ground", () => {
  test.each([
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw-browsers npx playwright install chromium-headless-shell",
    `PLAYWRIGHT_BROWSERS_PATH=${OWN_SCRATCH}/pw-browsers npx playwright install chromium-headless-shell`,
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw-browsers bunx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=${ROOT}/.pw npx playwright install chromium`,
    "PLAYWRIGHT_BROWSERS_PATH=./.pw npx playwright install chromium",
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw-browsers; npx playwright install chromium-headless-shell",
    "export PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw-browsers && npx playwright install chromium-headless-shell",
    'export PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/pw-browsers"; bunx playwright install chromium',
    "PLAYWRIGHT_BROWSERS_PATH=$TMPDIR/pw-browsers npx playwright@1.55 install chromium-headless-shell",
    "env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw npx playwright install chromium",
  ])("allows %p", (command) => {
    expectAllowed(command);
  });

  test("with PLAYWRIGHT_BROWSERS_PATH in the worker's environment, a dir the command sets wins", () => {
    expectAllowed("PLAYWRIGHT_BROWSERS_PATH=/tmp/pw npx playwright install chromium", { PLAYWRIGHT_BROWSERS_PATH: MS });
    expectAllowed("export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw; npx playwright install chromium", { PLAYWRIGHT_BROWSERS_PATH: MS });
  });
});

describe("playwright install into the browsers the helper launches stays held", () => {
  test.each([
    "npx playwright install chromium-headless-shell",
    "bunx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=${MS} npx playwright install chromium`,
    "PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=${join(SCRATCH, "launch-2", "pw")} npx playwright install chromium`,
    "PLAYWRIGHT_BROWSERS_PATH=$UNKNOWN_DIR npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=$(cat /tmp/where) npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH= npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium",
    `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw; npx playwright install chromium`,
    `export PLAYWRIGHT_BROWSERS_PATH=/tmp/pw; unset PLAYWRIGHT_BROWSERS_PATH; npx playwright install chromium`,
    `XDG_CACHE_HOME=/tmp/c npx playwright install chromium`,
    `HOME=/tmp/h npx playwright install chromium`,
    `PLAYWRIGHT_BROWSERS_PATH=/tmp/../fake/home/.cache/ms-playwright npx playwright install chromium`,
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });

  test("with PLAYWRIGHT_BROWSERS_PATH in the worker's environment: the dir the helper launches from", () => {
    expectHeld("npx playwright install chromium", "floor-tamper", true, { PLAYWRIGHT_BROWSERS_PATH: MS });
    // The helper, started from the same environment, launches the browsers there too.
    expectHeld("npx playwright install chromium", "floor-tamper", true, { PLAYWRIGHT_BROWSERS_PATH: join(OWN_SCRATCH, "pw") });
  });

  test.each([
    "env -u PLAYWRIGHT_BROWSERS_PATH npx playwright install chromium",
    "env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw npx playwright install-deps chromium",
    "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw npx playwright install-deps",
    "PLAYWRIGHT_BROWSERS_PATH=/tmp npx playwright install chromium",
    "PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/* npx playwright install chromium",
  ])("%p", (command) => {
    expectHeld(command, "floor-tamper");
  });
});
