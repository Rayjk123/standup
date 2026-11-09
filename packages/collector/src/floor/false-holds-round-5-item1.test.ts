import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A script under the temp dir that names "/package.json" in a string and
 * writes no files only reads it; one that writes files and names it, into
 * whatever dir, holds, as does one that writes the install's package.json,
 * the floor or Claude's settings. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const T = join("/", "tmp", "x");

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

const READS: Record<string, string> = {
  "join.test.ts": [
    'import { test, expect } from "bun:test";',
    'import { readFileSync } from "fs";',
    'import { join } from "path";',
    "const dir = import.meta.dir;",
    'test("reads the manifest", () => { expect(JSON.parse(readFileSync(join(dir, "/package.json"), "utf8")).name).toBeDefined(); });',
    "",
  ].join("\n"),
  "check.ts": [
    'import { existsSync, readFileSync } from "fs";',
    "const root = process.cwd();",
    'if (existsSync(root + "/package.json")) console.log(readFileSync(root + "/package.json", "utf8"));',
    "",
  ].join("\n"),
  "check.mjs": [
    'import { existsSync } from "node:fs";',
    'const root = process.argv[2] ?? ".";',
    'console.log(existsSync(root + "/package.json"));',
    "",
  ].join("\n"),
  "plain.ts": 'const name = "/package.json";\nconsole.log(name.length);\n',
  "fixture.test.ts": [
    'import { test, expect } from "bun:test";',
    'import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";',
    'import { tmpdir } from "os";',
    'import { join } from "path";',
    'const dir = mkdtempSync(join(tmpdir(), "pkg-"));',
    'test("writes and reads its own manifest", () => {',
    '  writeFileSync(join(dir, "/package.json"), JSON.stringify({ name: "x" }));',
    '  expect(existsSync(dir + "/package.json")).toBe(true);',
    '  expect(readFileSync(join(dir, "/package.json"), "utf8")).toContain("x");',
    "});",
    "",
  ].join("\n"),
  "copy.ts": [
    'import { copyFileSync, mkdtempSync } from "fs";',
    'import { tmpdir } from "os";',
    'import { join } from "path";',
    'const out = mkdtempSync(join(tmpdir(), "out-"));',
    'copyFileSync(process.cwd() + "/package.json", join(out, "/package.json"));',
    "",
  ].join("\n"),
};

const IMPORTS = 'import { writeFileSync, readFileSync, mkdtempSync, symlinkSync } from "fs";\nimport { tmpdir, homedir } from "os";\nimport { join, relative } from "path";\n';

/** Tails written to a dir the code computes, a fresh temp dir among them, or by a call named like a read. */
const MOVED_TAILS: Record<string, string> = {
  "tmpdir-env.ts": `${IMPORTS}process.env.TMPDIR = homedir();\nwriteFileSync(join(tmpdir(), "/package.json"), "{}");\n`,
  "tmpdir-plain.ts": `${IMPORTS}writeFileSync(join(tmpdir(), "/package.json"), "{}");\n`,
  "join-middle-var.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\nconst up = relative(dir, homedir());\nwriteFileSync(join(dir, up, "/package.json"), "{}");\n`,
  "join-middle-literal.ts": `${IMPORTS}const d = "/tmp/x/out";\nwriteFileSync(join(d, "../../..", "/package.json"), "{}");\n`,
  "join-tmpdir-dotdot.ts": `${IMPORTS}writeFileSync(join(tmpdir(), "..", "/package.json"), "{}");\n`,
  "join-symlink.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\nsymlinkSync(homedir(), join(dir, "h"));\nwriteFileSync(join(dir, "h", "/package.json"), "{}");\n`,
  "literal-array-reassign.ts": `${IMPORTS}let d = "/tmp/x/out";\n[d] = [homedir()];\nwriteFileSync(d + "/package.json", "{}");\n`,
  "literal-for-reassign.ts": `${IMPORTS}let d = "/tmp/x/out";\nfor (d of [homedir()]) writeFileSync(d + "/package.json", "{}");\n`,
  // A fresh temp dir, then a link at the tail's own path, or a temp root the code moves first.
  "fresh-symlink.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\nsymlinkSync(join(homedir(), "package.json"), join(dir, "/package.json"));\nwriteFileSync(join(dir, "/package.json"), "{}");\n`,
  "fresh-tmpdir-env.ts": `${IMPORTS}process.env.TMPDIR = homedir();\nconst dir = mkdtempSync(join(tmpdir(), "x-"));\nwriteFileSync(join(dir, "/package.json"), "{}");\n`,
  "fresh-env-key.ts": `${IMPORTS}const k = "TMP" + "DIR";\nprocess.env[k] = homedir();\nconst dir = mkdtempSync(join(tmpdir(), "x-"));\nwriteFileSync(dir + "/package.json", "{}");\n`,
  // The name shadowed in another scope, declared again in a list, or the dir's prefix climbing out.
  "fresh-shadow.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\n{ let a, dir; writeFileSync(dir + "/package.json", "{}"); }\n`,
  "fresh-param.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\nconst save = (dir: string) => writeFileSync(join(dir, "/package.json"), "{}");\nsave(homedir());\n`,
  "fresh-dotdot.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "../x-"));\nwriteFileSync(join(dir, "/package.json"), "{}");\n`,
  "fresh-concat-after.ts": `${IMPORTS}const dir = mkdtempSync(join(tmpdir(), "x-"));\nwriteFileSync(dir + "/package.json" + "", "{}");\n`,
  // A read named for a function another binding replaces.
  "read-function.ts": 'import { writeFileSync } from "fs";\nimport { homedir } from "os";\n{ function readFileSync(p: string, d: string) { writeFileSync(p, d); } readFileSync(homedir() + "/package.json", "{}"); }\n',
};

/** Writes made only through another binding of a write function, which no call names as one. */
const UNCALLED_WRITERS: Record<string, string> = {
  "shadow-array.ts": `${IMPORTS}{ const [readFileSync] = [writeFileSync]; readFileSync(homedir() + "/package.json", "{}"); }\n`,
  "shadow-for-of.ts": `${IMPORTS}for (const readFileSync of [writeFileSync]) readFileSync(homedir() + "/package.json", "{}");\n`,
  "read-renamed.ts": 'import { writeFileSync as readFileSync } from "fs";\nimport { homedir } from "os";\nreadFileSync(homedir() + "/package.json", "{}");\n',
  "read-in-template.ts": 'import { readFileSync, writeFileSync } from "fs";\nimport { homedir } from "os";\nlet r = readFileSync;\nconsole.log(`${(r = writeFileSync as any)}`);\nr(homedir() + "/package.json", "{}");\nreadFileSync(homedir() + "/package.json", "{}");\n',
};

const WRITES: Record<string, string> = {
  "write-install.ts": `import { writeFileSync } from "fs";\nwriteFileSync("${INSTALL}/package.json", "{}");\n`,
  "write-install-join.ts": `import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join("${INSTALL}", "/package.json"), "{}");\n`,
  "write-floor.ts": `import { writeFileSync } from "fs";\nwriteFileSync("${INSTALL}/packages/collector/src/floor/gate.ts", "");\n`,
  "write-settings.ts": `import { writeFileSync } from "fs";\nwriteFileSync("${HOME}/.claude/settings.json", "{}");\n`,
  "write-db.ts": `import { writeFileSync } from "fs";\nwriteFileSync("${DATA}/standup.db", "");\n`,
  "rm-data.ts": `import { rmSync } from "fs";\nrmSync("${DATA}", { recursive: true });\n`,
  "write-install-const.ts": `import { writeFileSync } from "fs";\nconst INSTALL = "${INSTALL}";\nwriteFileSync(INSTALL + "/package.json", "{}");\n`,
};

/** Root-level module-resolution files, written in ways that name the root itself. */
const ROOT_WRITES: Record<string, string> = {
  "root-literal.ts": 'import { writeFileSync } from "fs";\nwriteFileSync("/package.json", "{}");\n',
  "root-const.ts": 'import { writeFileSync } from "fs";\nconst p = "/package.json";\nwriteFileSync(p, "{}");\n',
  "root-also.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join(process.cwd(), "/package.json"), "{}");\nwriteFileSync("/package.json", "{}");\n',
  "root-resolve.ts": 'import { writeFileSync } from "fs";\nimport { resolve } from "path";\nwriteFileSync(resolve(process.cwd(), "/package.json"), "{}");\n',
  "root-own-join.ts": 'import { writeFileSync } from "fs";\nconst join = (_a: string, b: string) => b;\nwriteFileSync(join(process.cwd(), "/package.json"), "{}");\n',
  "root-renamed-join.ts": 'import { writeFileSync } from "fs";\nimport { resolve as join } from "path";\nwriteFileSync(join(process.cwd(), "/package.json"), "{}");\n',
  "root-destructured-join.ts": 'const { writeFileSync } = require("fs");\nconst { resolve: join } = require("path");\nwriteFileSync(join(process.cwd(), "/package.json"), "{}");\n',
  "root-pieces.ts": 'import { writeFileSync } from "fs";\nwriteFileSync("/package" + ".json", "{}");\n',
  "root-python.py": 'import os\nwith open(os.path.join(os.getcwd(), "/package.json"), "w") as f:\n    f.write("{}")\n',
};

/** Tails whose own name is a settings or hook-config file, in whatever dir. */
const NAMED_WRITES: Record<string, string> = {
  "claude-json.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nimport { homedir } from "os";\nwriteFileSync(join(homedir(), "/.claude.json"), "{}");\n',
  "mcp-json.ts": 'import { writeFileSync } from "fs";\nwriteFileSync(process.cwd() + "/.mcp.json", "{}");\n',
  "claude-dir.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join(process.cwd(), "/.claude"), "");\n',
  "bunfig.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join(process.env.HOME!, "/bunfig.toml"), "");\n',
};

/** An install under the home dir, so the home dir and the root are both dirs above it. */
const HOME_INSTALL = join(HOME, "standup");
const homeInstallConfig: FloorConfig = { ...config, installDir: HOME_INSTALL, floorPaths: [join(HOME_INSTALL, "packages", "collector", "src", "floor")] };

/** Module-resolution files appended to a dir the code computes that may be one above the install. */
const ANCESTOR_WRITES: Record<string, string> = {
  "home-join.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nimport { homedir } from "os";\nwriteFileSync(join(homedir(), "/package.json"), "{}");\n',
  "home-tsconfig.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nimport { homedir } from "os";\nwriteFileSync(join(homedir(), "/tsconfig.json"), "{}");\n',
  "home-plus.ts": 'import { writeFileSync } from "fs";\nimport { homedir } from "os";\nwriteFileSync(homedir() + "/package.json", "{}");\n',
  "env-plus.ts": 'import { writeFileSync } from "fs";\nwriteFileSync(process.env.HOME + "/package.json", "{}");\n',
  "posix-join.ts": 'import { writeFileSync } from "fs";\nimport path from "path";\nimport { homedir } from "os";\nwriteFileSync(path.posix.join(homedir(), "/package.json"), "{}");\n',
  "cwd-join.ts": 'import { writeFileSync } from "fs";\nimport { join } from "path";\nwriteFileSync(join(process.cwd(), "/package.json"), "{}");\n',
  "param-plus.ts": 'import { writeFileSync } from "fs";\nexport function save(dir: string): void { writeFileSync(dir + "/package.json", "{}"); }\nsave(process.argv[2]!);\n',
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: PACKAGE_JSON,
  [join(INSTALL, "package.json")]: PACKAGE_JSON,
  [join(HOME_INSTALL, "package.json")]: PACKAGE_JSON,
  [join(DATA, "standup.db")]: "",
  ...Object.fromEntries(Object.entries({ ...READS, ...WRITES, ...ROOT_WRITES, ...NAMED_WRITES, ...ANCESTOR_WRITES, ...MOVED_TAILS, ...UNCALLED_WRITERS }).map(([name, text]) => [join(T, name), text])),
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, T]);
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

function bash(command: string, cwd = ROOT, floor: FloorConfig = config): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, floor, probes());
}

describe("a temp-dir script that names /package.json only reads it", () => {
  const runs = [
    `bun test ${T}/join.test.ts`,
    `bun ${T}/check.ts`,
    `bun run ${T}/check.ts`,
    `node ${T}/check.mjs`,
    `node ${T}/check.mjs ${ROOT}`,
    `bun ${T}/plain.ts`,
    // A test runner's files are read for outward steps only.
    `bun test ${T}/fixture.test.ts`,
    `bun -e 'console.log(require("fs").existsSync(process.cwd() + "/package.json"))'`,
    `node -e 'const p = require("path"); console.log(require("fs").readFileSync(p.join(process.cwd(), "/package.json"), "utf8"))'`,
  ];
  test.each(runs)("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each(runs)("allows %p from the temp dir", (command) => {
    expect(bash(command, T)).toEqual({ action: "allow" });
  });

  // Code that writes files and names "/package.json" is read as writing the root's, whatever dir it joins the name to.
  const writers = [`bun ${T}/fixture.test.ts`, `bun ${T}/copy.ts`];
  test.each(writers)("holds %p, which writes files and names /package.json", (command) => {
    expect(bash(command).action).toBe("hold");
    expect(bash(command, T).action).toBe("hold");
  });
});

describe("a temp-dir script that writes a guarded path still holds", () => {
  test.each(Object.keys(WRITES))("holds bun %p", (name) => {
    expect(bash(`bun ${T}/${name}`).action).toBe("hold");
  });

  test.each(Object.keys(WRITES))("holds node %p", (name) => {
    expect(bash(`node ${T}/${name}`).action).toBe("hold");
  });

  test("writes of the install's package.json, the floor and Claude's settings are floor-tamper", () => {
    for (const name of ["write-install.ts", "write-install-join.ts", "write-install-const.ts", "write-floor.ts", "write-settings.ts", "write-db.ts"]) {
      expect(bash(`bun ${T}/${name}`)).toMatchObject({ action: "hold", category: "floor-tamper" });
    }
  });
});

describe("a package.json at the root is still named as one", () => {
  test.each(Object.keys(ROOT_WRITES))("holds %p", (name) => {
    const run = name.endsWith(".py") ? "python3" : "bun";
    expect(bash(`${run} ${T}/${name}`)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test("an inline script that writes it holds too", () => {
    expect(bash(`bun -e 'require("fs").writeFileSync("/package.json", "{}")'`)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });
});

describe("a tail whose own name is a settings or hook-config file still holds", () => {
  test.each(Object.keys(NAMED_WRITES))("holds %p", (name) => {
    expect(bash(`bun ${T}/${name}`)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });
});

describe("a tail appended to a dir that may be above the install still holds", () => {
  test.each(Object.keys(ANCESTOR_WRITES))("holds %p with the install under the home dir", (name) => {
    expect(bash(`bun ${T}/${name}`, ROOT, homeInstallConfig)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test("a read and a test run are still allowed there; a script writing into a temp dir the code makes holds", () => {
    expect(bash(`bun ${T}/check.ts`, ROOT, homeInstallConfig)).toEqual({ action: "allow" });
    expect(bash(`bun test ${T}/fixture.test.ts`, ROOT, homeInstallConfig)).toEqual({ action: "allow" });
    // The dir a name is joined to isn't followed, so a fresh temp dir's /package.json reads as the root's.
    for (const command of [`bun ${T}/fixture.test.ts`, `bun ${T}/copy.ts`]) {
      expect(bash(command, ROOT, homeInstallConfig).action).toBe("hold");
    }
  });
});

describe("a tail written to a dir the code computes is checked as a path from the root", () => {
  test.each(Object.keys(MOVED_TAILS))("holds bun %p (home install)", (name) => {
    expect(bash(`bun ${T}/${name}`, ROOT, homeInstallConfig).action).toBe("hold");
  });
  test.each(Object.keys(MOVED_TAILS))("holds bun %p (default install)", (name) => {
    expect(bash(`bun ${T}/${name}`).action).toBe("hold");
  });
  test.each([`TMPDIR=${HOME}`, "TMPDIR=/", "TMP=/", `export TMPDIR=${HOME};`])("holds a fresh temp dir's tail run with %p", (prefix) => {
    expect(bash(`${prefix} bun ${T}/tmpdir-plain.ts`, ROOT, homeInstallConfig).action).toBe("hold");
    expect(bash(`${prefix} bun ${T}/fixture.test.ts`, ROOT, homeInstallConfig).action).toBe("hold");
  });
});

describe("a write function reached only through another binding", () => {
  // Writes are found by a write function's call under its own name, so these write `~/package.json` unseen.
  for (const name of Object.keys(UNCALLED_WRITERS)) test.todo(`holds bun ${name}`, () => expect(bash(`bun ${T}/${name}`).action).toBe("hold"));
});
