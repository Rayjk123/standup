import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A script that only acts when run directly (`if (import.meta.main) { … }`):
 * imported, `import.meta.main` is false, so the block doesn't run as the
 * module loads, and what only that block reaches is not read as running.
 * Run as the entry, or with `main` reachable some other way, it counts in
 * full. scripts/check-deps.ts is the case: it names the Homebrew binaries
 * in the PATH dirs and writes ~/.zprofile when run.
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

const CHECK_DEPS = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "scripts", "check-deps.ts"), "utf8");

/** A module that plants a program in a PATH dir only when it is the entry, with the given code around the guard. */
function guarded(before: string, guard = "if (import.meta.main) {\n  plant();\n}\n", after = ""): string {
  return `import { writeFileSync } from "fs";\n\nfunction plant(): void {\n  writeFileSync("/usr/local/bin/bun", "#!/bin/sh\\n");\n}\n\n${before}${guard}${after}`;
}

const GUARDED: Record<string, string> = {
  "ok.ts": guarded(""),
  "ok-reads.ts": guarded("const here = import.meta.dir;\nconst url = import.meta.url;\nconsole.log(here, url, import.meta.path);\n"),
  "set-main.ts": guarded("import.meta.main = true;\n"),
  "set-main-paren.ts": guarded("(import.meta.main) = true;\n"),
  "assign-meta.ts": guarded("Object.assign(import.meta, { main: true });\n"),
  "alias-meta.ts": guarded("const m = import.meta;\nm.main = true;\n"),
  "destructure-main.ts": guarded("({ x: import.meta.main } = { x: true });\n"),
  "template-main.ts": guarded("const s = `${(import.meta.main = true)}`;\nconsole.log(s);\n"),
  "index-main.ts": guarded('import.meta["main"] = true;\n'),
  "define-main.ts": guarded('Object.defineProperty(import.meta, "main", { value: true });\n'),
  "negated.ts": guarded("", "if (!import.meta.main) {\n  plant();\n}\n"),
  "or-guard.ts": guarded("", "if (import.meta.main || process.argv.length > 0) {\n  plant();\n}\n"),
  "else-branch.ts": guarded("", "if (import.meta.main) {\n  console.log(1);\n} else {\n  plant();\n}\n"),
  "unbraced.ts": guarded("", "if (import.meta.main) plant();\n"),
  "after-guard.ts": guarded("", "if (import.meta.main) {\n  console.log(1);\n}\n", "plant();\n"),
  "optional-meta.ts": guarded("", "if (import.meta?.main) {\n  plant();\n}\n"),
  // `if (c) /{/` is a regex statement: a brace in it doesn't open a block, so `plant();` sits after the guard.
  "regex-after-paren.ts": guarded("const c = 1;\n", "if (import.meta.main) {\n  if (c) /{/ / 1;\n}\n", "plant();\nif (c) /}/ / 1;\n"),
  "regex-in-template.ts": guarded("const c = 1;\n", "if (import.meta.main) {\n  console.log(`${(c) /{/ / 1}`);\n}\n", "plant();\nconsole.log(`${(c) /}/ / 1}`);\n"),
  // `{} / 2` divides, though a `/` after `}` reads as a regex: the `}` and `{` it hides end the guard and open a plain block around `plant();`.
  "division-after-brace.ts": guarded("", "if (import.meta.main) {\n  const n = {} / 2; } { const m = 1 / 1;\n  plant();\n}\n"),
  "division-after-keyword-property.ts": guarded("", "if (import.meta.main) {\n  const n = Math.default / 2; } { const m = 1 / 1;\n  plant();\n}\n"),
  "division-after-increment.ts": guarded("let i = 0;\n", "if (import.meta.main) {\n  i++ / 2; } { const m = 1 / 1;\n  plant();\n}\n"),
  // A statement ends at the line break after `debugger`, `break` or a type annotation, so the `/` opening the next line starts a regex:
  // the brace in `/{x/` opens no block, and `plant();` sits after the guard.
  "regex-after-debugger.ts": guarded("", "if (import.meta.main) {\n  debugger\n  /{x/\n}\n", "plant();\ndebugger\n/}x/\n"),
  "regex-after-break.ts": guarded("", "if (import.meta.main) {\n  for (;;) { break\n  /{x/; }\n}\n", "plant();\nfor (;;) { break\n/}x/; }\n"),
  "regex-after-type.ts": guarded("", "if (import.meta.main) {\n  let v: number\n  /{x/\n}\n", "plant();\nlet w: number\n/}x/\n"),
  // A non-ASCII or escaped name is a name: the `/` after it divides, though the tokenizer reads a regex hiding the `}` and `{`.
  "division-after-non-ascii-name.ts": guarded("", "if (import.meta.main) {\n  const n = Math.é / 2; } { const m = 1 / 1;\n  plant();\n}\n"),
  "division-after-escaped-name.ts": guarded("", "if (import.meta.main) {\n  const n = Math.\\u0061 / 2; } { const m = 1 / 1;\n  plant();\n}\n"),
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "scripts", "check-deps.ts")]: CHECK_DEPS,
  [join(ROOT, "scripts", "check-deps.test.ts")]: 'import { expect, test } from "bun:test";\nimport { ensureDeps } from "./check-deps.ts";\ntest("exports", () => { expect(typeof ensureDeps).toBe("function"); });\n',
  [join(ROOT, "scripts", "dev.ts")]: 'import { ensureDeps } from "./check-deps.js";\n\nawait ensureDeps();\n',
  [join(ROOT, "g", "side.ts")]: 'import "../scripts/check-deps.ts";\n',
  ...Object.fromEntries(Object.entries(GUARDED).map(([name, text]) => [join(ROOT, "g", name), text])),
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

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string): void {
  expect(v).toMatchObject({ action: "hold", category });
}

/** Held for Persona as code that runs only when the module is the entry, never for the owner. */
function expectEntryOnly(v: FloorVerdict): void {
  const got = v.action === "hold" ? { category: v.category, ownerOnly: v.ownerOnly, entryOnly: v.reason.includes("that runs only as the entry") } : v;
  expect(got).toEqual({ category: "unclassified", ownerOnly: false, entryOnly: true });
}

const TMP_HOME =
  "HOME=/tmp/h XDG_CONFIG_HOME=/tmp/h/.config XDG_DATA_HOME=/tmp/h/.local/share XDG_STATE_HOME=/tmp/h/.local/state XDG_CACHE_HOME=/tmp/h/.cache " +
  "DB_PATH=/tmp/h/standup.db STANDUP_SQLITE_PATH=/tmp/h/standup.db KNOWLEDGE_DIR=/tmp/h/knowledge STANDUP_INTERNAL_ROOT=/tmp/h/internal STANDUP_PROJECT_DOCS_DIR=/tmp/h/docs";

describe("scripts/check-deps.ts read, edited, tested or imported", () => {
  test.each([
    "grep -n brew scripts/check-deps.ts",
    "sed -n '1,60p' scripts/check-deps.ts",
    "cat scripts/check-deps.ts",
    "rg BREW_CANDIDATES scripts",
    "bun test scripts/check-deps.test.ts",
    `${TMP_HOME} bun test scripts/check-deps.test.ts`,
  ])("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  // What its `import.meta.main` block does is read as code this load may not reach: Persona's, not the owner's.
  test.each([
    `bun -e 'import "./scripts/check-deps.ts"'`,
    `bun -e 'import "./scripts/check-deps.js"'`,
    `node --input-type=module -e 'import "./scripts/check-deps.ts"'`,
  ])("holds %p for Persona only", (command) => {
    expectEntryOnly(bash(command));
  });

  test("Read, Grep, Edit and Write of it are allowed", () => {
    const file = join(ROOT, "scripts", "check-deps.ts");
    expectAllowed(tool("Read", { file_path: file }));
    expectAllowed(tool("Grep", { pattern: "brew", path: file }));
    expectAllowed(tool("Edit", { file_path: file, old_string: '"/usr/local/bin/brew"', new_string: '"/usr/local/bin/brew" ' }));
    expectAllowed(tool("Write", { file_path: file, content: CHECK_DEPS }));
  });

  test("a module that only imports it for its side effects is held for Persona only", () => {
    expectEntryOnly(bash(`bun -e 'import "./g/side.ts"'`));
    expectEntryOnly(bash("bun g/side.ts"));
  });
});

describe("scripts/check-deps.ts run, or imported by code that runs it", () => {
  // Under any HOME it installs Homebrew and formulae into /opt/homebrew/bin or /usr/local/bin.
  test.each([
    "bun scripts/check-deps.ts",
    "bun run scripts/check-deps.ts",
    "bun ./scripts/check-deps.ts",
    `${TMP_HOME} bun scripts/check-deps.ts`,
    `${TMP_HOME} bun run scripts/check-deps.ts`,
    "bun scripts/dev.ts",
    `bun -e 'import { ensureDeps } from "./scripts/check-deps.ts"; await ensureDeps()'`,
    `bun -e 'require("./scripts/check-deps.ts").ensureDeps()'`,
    `bun -e 'import { ensureDeps } from "./scripts/check-deps.ts"; console.log(typeof ensureDeps)'`,
    `bun -e 'import "./scripts/check-deps.ts"; import { ensureDeps } from "./scripts/check-deps.ts"; await ensureDeps()'`,
    `bun -e 'import "./g/side.ts"; import { ensureDeps } from "./scripts/check-deps.ts"; await ensureDeps()'`,
    `bun -e 'import { ensureDeps } from "./scripts/check-deps.ts"; import "./g/side.ts"; await ensureDeps()'`,
    `bun -e 'import * as deps from "./scripts/check-deps.ts"; console.log(deps)'`,
  ])("holds %p", (command) => {
    expectHeld(bash(command), "floor-tamper");
  });

  test("writes to the PATH dirs and RC files it touches still hold", () => {
    expectHeld(bash("echo hi > /usr/local/bin/brew"), "floor-tamper");
    expectHeld(bash("echo hi > /opt/homebrew/bin/brew"), "floor-tamper");
    expectHeld(bash(`echo 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> ~/.zprofile`), "floor-tamper");
    expectHeld(tool("Write", { file_path: join(HOME, ".zprofile"), content: 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"\n' }), "floor-tamper");
  });
});

describe("an imported module's `if (import.meta.main) { … }` block", () => {
  test.each(["ok.ts", "ok-reads.ts"])("is read as Persona's when %p is imported", (name) => {
    expectEntryOnly(bash(`bun -e 'import "./g/${name}"'`));
  });

  test("runs when the module is the entry", () => {
    expectHeld(bash("bun g/ok.ts"), "floor-tamper");
    expectHeld(bash("bun run g/ok.ts"), "floor-tamper");
    expectHeld(bash("bun g/side.ts && bun g/ok.ts"), "floor-tamper");
  });

  // A preload isn't the entry either; the floor reads it as one, whole.
  test.each(["bun --preload ./g/ok.ts -e 1", "node --import ./g/ok.ts -e 1"])("%p holds", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([
    "set-main.ts",
    "set-main-paren.ts",
    "assign-meta.ts",
    "alias-meta.ts",
    "destructure-main.ts",
    "template-main.ts",
    "index-main.ts",
    "define-main.ts",
    "negated.ts",
    "or-guard.ts",
    "else-branch.ts",
    "unbraced.ts",
    "after-guard.ts",
    "optional-meta.ts",
    "regex-after-paren.ts",
    "regex-in-template.ts",
    "division-after-brace.ts",
    "division-after-keyword-property.ts",
    "division-after-increment.ts",
    "regex-after-debugger.ts",
    "regex-after-break.ts",
    "regex-after-type.ts",
    "division-after-non-ascii-name.ts",
    "division-after-escaped-name.ts",
  ])("still counts in full when %p is imported", (name) => {
    expectHeld(bash(`bun -e 'import "./g/${name}"'`), "floor-tamper");
  });
});
