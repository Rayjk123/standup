import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A worker's own Playwright script naming a browser under
 * `~/.cache/ms-playwright` as the `executablePath` of a launch runs that
 * binary: it writes nothing there. That holds when the path is built from the
 * home dir (`join(homedir(), …)`, `process.env.HOME + …`, a template), bound
 * to a `const` the launch alone uses, or found by listing the dir; a script
 * that also writes screenshots and JSON to /tmp is still only launching. A
 * script that writes at the browser's path, or into the floor's own code, or
 * hands the const holding the path to any other call stays held.
 */

const HOME = join("/", "home", "alice");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "opt", "standup");
const FLOOR = join(INSTALL, "packages", "collector", "src", "floor");
const COMMON = join("/", "srv", "standup", ".git");
const MS = join(HOME, ".cache", "ms-playwright");
const CHROME = join(MS, "chromium-1187", "chrome-linux", "chrome");

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
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const tail = `const browser = await chromium.launch({ headless: true, executablePath: exe });\nconst page = await browser.newPage();\nawait page.goto("http://127.0.0.1:5173/");\nawait page.screenshot({ path: "/tmp/shot.png" });\nwriteFileSync("/tmp/shot.json", JSON.stringify({ title: await page.title() }));\nawait browser.close();\n`;
const BS = String.fromCharCode(92);
const head = `import { chromium } from "playwright";\nimport { writeFileSync, readdirSync } from "fs";\nimport { homedir } from "os";\nimport { join } from "path";\n`;

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [CHROME]: "bin\n",
  [join(FLOOR, "hook.ts")]: "export {};\n",
  // The browser's literal path bound to a name, then handed to the launch.
  [join(ROOT, "lit-bound.ts")]: `${head}const exe = "${CHROME}";\n${tail}`,
  [join(ROOT, "lit-shorthand.ts")]: `${head}const executablePath = "${CHROME}";\nconst browser = await chromium.launch({ headless: true, executablePath });\nconst page = await browser.newPage();\nawait page.screenshot({ path: "/tmp/shot.png" });\nawait browser.close();\n`,
  [join(ROOT, "lit-exists.ts")]: `${head}import { existsSync } from "fs";\nconst exe = "${CHROME}";\nif (!existsSync(exe)) throw new Error("no chrome");\n${tail}`,
  [join(ROOT, "lit-logged.mjs")]: `import { chromium } from "playwright";\nimport { writeFileSync } from "fs";\nconst exe = "${CHROME}";\nconsole.log("using", exe);\n${tail}`,
  [join(ROOT, "lit-inline.ts")]: `${head}const browser = await chromium.launch({ headless: true, executablePath: "${CHROME}" });\nconst page = await browser.newPage();\nawait page.screenshot({ path: "/tmp/shot.png" });\nwriteFileSync("/tmp/shot.json", "{}");\nawait browser.close();\n`,
  // Built from the home dir.
  [join(ROOT, "homedir-join.ts")]: `${head}const exe = join(homedir(), ".cache", "ms-playwright", "chromium-1187", "chrome-linux", "chrome");\n${tail}`,
  [join(ROOT, "homedir-inline.ts")]: `${head}const browser = await chromium.launch({ headless: true, executablePath: join(homedir(), ".cache/ms-playwright/chromium-1187/chrome-linux/chrome") });\nconst page = await browser.newPage();\nawait page.screenshot({ path: "/tmp/shot.png" });\nawait browser.close();\n`,
  [join(ROOT, "env-home.ts")]: `${head}const exe = process.env.HOME + "/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";\n${tail}`,
  [join(ROOT, "template-home.ts")]: `${head}const exe = \`\${homedir()}/.cache/ms-playwright/chromium-1187/chrome-linux/chrome\`;\n${tail}`,
  // Found by listing the browsers dir.
  [join(ROOT, "readdir.ts")]: `${head}const ms = join(homedir(), ".cache", "ms-playwright");\nconst dir = readdirSync(ms).filter((d) => d.startsWith("chromium-")).sort().pop();\nconst exe = join(ms, dir, "chrome-linux", "chrome");\n${tail}`,
  // Negatives: a write at the browser's path, or into the floor's own code.
  [join(ROOT, "homedir-plant.ts")]: `${head}const exe = join(homedir(), ".cache", "ms-playwright", "chromium-1187", "chrome-linux", "chrome");\nawait chromium.launch({ executablePath: exe });\nwriteFileSync(exe, "#!/bin/sh\\n");\n`,
  [join(ROOT, "lit-plant.ts")]: `${head}const exe = "${CHROME}";\nawait chromium.launch({ executablePath: exe });\nwriteFileSync(exe, "#!/bin/sh\\n");\n`,
  [join(ROOT, "lit-copy.ts")]: `${head}import { copyFileSync } from "fs";\nconst exe = "${CHROME}";\nawait chromium.launch({ executablePath: exe });\ncopyFileSync("/tmp/evil", exe);\n`,
  [join(ROOT, "lit-opts.ts")]: `${head}const exe = "${CHROME}";\nconst opts = { executablePath: exe };\nawait chromium.launch(opts);\nwriteFileSync(opts.executablePath, "x");\n`,
  [join(ROOT, "lit-helper.ts")]: `${head}import { install } from "./pw-lib";\nconst exe = "${CHROME}";\nawait chromium.launch({ executablePath: exe });\ninstall(exe);\nwriteFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "lit-shadow.ts")]: `${head}import { install } from "./pw-lib";\nconst exe = "${CHROME}";\nawait chromium.launch({ executablePath: exe });\n{\n  const exe = "/tmp/x";\n  install(exe);\n}\nwriteFileSync("/tmp/x", "y");\n`,
  [join(ROOT, "pw-lib.ts")]: `import { writeFileSync } from "fs";\nexport function install(p: string) { writeFileSync(p, "#!/bin/sh\\n"); }\n`,
  [join(ROOT, "env-plant.ts")]: `${head}const exe = process.env.HOME + "/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";\nwriteFileSync(exe, "#!/bin/sh\\n");\n`,
  [join(ROOT, "readdir-rm.ts")]: `import { rmSync, readdirSync } from "fs";\nimport { homedir } from "os";\nimport { join } from "path";\nconst ms = join(homedir(), ".cache", "ms-playwright");\nfor (const d of readdirSync(ms)) rmSync(join(ms, d), { recursive: true, force: true });\n`,
  // A use of the const, and the writer's name, spelled with unicode escapes that a plain count of its name misses.
  [join(ROOT, "lit-escaped.ts")]: `${head}const exe = "${CHROME}";\nfunction unused() { return chromium.launch({ executablePath: exe }); }\nwriteFileSync("/tmp/x", "y");\n${BS}u0077rit${BS}u0065Fil${BS}u0065Sync(${BS}u0065xe, "#!/bin/sh${BS}n");\n`,
  // A write the scan can't see past a regex literal's quote, and the const spread into a path a deleter takes.
  [join(ROOT, "lit-regex-quote.ts")]: `${head}const exe = "${CHROME}";\nconst browser = await chromium.launch({ headless: true, executablePath: exe });\nconst q = /'/; writeFileSync(exe, "#!/bin/sh"); const r = /'/;\nwriteFileSync("/tmp/shot.json", "{}");\nawait browser.close();\n`,
  [join(ROOT, "lit-spread.ts")]: `${head}import { rimrafSync } from "rimraf";\nimport { format } from "util";\nconst exe = "${CHROME}";\nconst browser = await chromium.launch({ headless: true, executablePath: exe });\nrimrafSync(format("${"%s".repeat(CHROME.length)}", ...exe));\nwriteFileSync("/tmp/shot.json", "{}");\nawait browser.close();\n`,
  [join(ROOT, "floor-write.ts")]: `${head}const exe = join(homedir(), ".cache", "ms-playwright", "chromium-1187", "chrome-linux", "chrome");\nawait chromium.launch({ executablePath: exe });\nwriteFileSync("${join(FLOOR, "hook.ts")}", "process.exit(0);\\n");\n`,
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
    lstat: (p) => (p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => HOME,
    env: (name) => (name === "HOME" ? HOME : undefined),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes());
}

describe("a script launching a Playwright browser by a path under ~/.cache/ms-playwright", () => {
  test.each([
    "bun lit-bound.ts",
    "bun lit-shorthand.ts",
    "bun lit-inline.ts",
    `bun -e 'import { chromium } from "playwright"; const exe = "${CHROME}"; const b = await chromium.launch({ executablePath: exe }); const p = await b.newPage(); await p.screenshot({ path: "/tmp/s.png" }); await b.close();'`,
    `node -e 'const { chromium } = require("playwright"); const exe = require("os").homedir() + "/.cache/ms-playwright/chromium-1187/chrome-linux/chrome"; chromium.launch({ executablePath: exe }).then((b) => b.close());'`,
    "bun homedir-join.ts",
    "bun homedir-inline.ts",
    "bun env-home.ts",
    "bun template-home.ts",
    "bun readdir.ts",
  ])("allows %p", (command) => {
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  });
});

describe("a script writing at the browser's path or into the floor, or handing the browser's path on, stays held", () => {
  test.each([
    "bun homedir-plant.ts",
    "bun env-plant.ts",
    "bun lit-plant.ts",
    "bun lit-copy.ts",
    "bun lit-opts.ts",
    "bun lit-helper.ts",
    "bun lit-shadow.ts",
    // The const handed to any call besides the launch, even one that only reads or logs it, is not read through.
    "bun lit-exists.ts",
    "node lit-logged.mjs",
    "bun lit-escaped.ts",
    "bun lit-regex-quote.ts",
    "bun lit-spread.ts",
    "bun floor-write.ts",
  ])("%p", (command) => {
    const v = bash(command);
    expect({ command, v }).toMatchObject({ command, v: { action: "hold", category: "floor-tamper" } });
    expect({ command, ownerReserved: v.action === "hold" && v.ownerReserved === true }).toEqual({ command, ownerReserved: true });
  });
});
