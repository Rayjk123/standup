import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * DB_PATH set by the command to a path in /tmp — canonical, no `..`, no link
 * on the way, not the live data dir — is a scratch DB: Standup's data-dir
 * helpers (`defaultDbPath()`, `standupDataDir()`) and a
 * `process.env.DB_PATH ?? join(homedir(), ".local", …)` fallback resolve
 * there whatever HOME is, so a script that opens its DB that way runs. A DB
 * path that leads to the live DB, an unset or unknown DB_PATH, code that
 * moves DB_PATH or finds the real home another way, and a direct read of the
 * live DB stay held as a DB read (HIGH RISK).
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const LIVE_DB = join(DATA, "standup.db");

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

const SRC = join(ROOT, "packages", "collector", "src");
const DB_IMPORT = 'import { Database } from "bun:sqlite";\n';
const HOME_IMPORTS = 'import { homedir } from "os";\nimport { join } from "path";\n';
const FALLBACK = 'process.env.DB_PATH ?? join(homedir(), ".local", "share", "standup", "standup.db")';

const COMPUTED = 'const k = "DB_" + "PATH";\n';
const WITH_FALLBACK = (body: string) => `${DB_IMPORT}${HOME_IMPORTS}${COMPUTED}${body}\nconst db = new Database(${FALLBACK}, { readonly: true });\nconsole.log(db.query("select 1").all());\n`;
const WITH_HELPER = (body: string) => `import { readdirSync } from "fs";\nimport { standupDataDir } from "./data-dir.js";\n${COMPUTED}${body}\nconsole.log(readdirSync(standupDataDir()));\n`;

/** Code that changes DB_PATH by a name the scan can't read, through an alias of the env, or wholesale: held. */
const MOVES_DB_PATH: Record<string, string> = {
  "alias-delete.ts": WITH_FALLBACK("const e = process.env; delete e[k];"),
  "alias-assign.ts": WITH_FALLBACK("const e = process.env; e[k] = undefined;"),
  "alias-delete-helper.ts": WITH_HELPER("const e = process.env; delete e[k];"),
  "alias-assign-helper.ts": WITH_HELPER("const e = process.env; e[k] = undefined;"),
  "destructure-env.ts": WITH_FALLBACK("const { env } = process; delete env[k];"),
  "destructure-rest.ts": WITH_FALLBACK("const { ...all } = process.env; console.log(all);"),
  "env-argument.ts": WITH_FALLBACK('import { unset } from "./unset.js";\nunset(process.env, k);'),
  "env-argument-helper.ts": WITH_HELPER('import { unset } from "./unset.js";\nunset(process.env, k);'),
  "object-assign-alias.ts": WITH_FALLBACK("const e = process.env; Object.assign(e, { [k]: undefined });"),
  "reflect-alias.ts": WITH_FALLBACK("const e = Bun.env; Reflect.deleteProperty(e, k);"),
  "define-property.ts": WITH_FALLBACK('Object.defineProperty(import.meta.env, k, { value: "" });'),
  "with-env.ts": WITH_FALLBACK("with (process.env) { console.log(k); }"),
  "env-reassign.ts": WITH_FALLBACK('process.env = { PATH: "/usr/bin" };'),
  "clear-all.ts": WITH_FALLBACK("Object.keys(process.env).forEach((n) => delete process.env[n]);"),
  "bun-env-computed.ts": WITH_FALLBACK("delete Bun.env[k];"),
  "import-meta-computed.ts": WITH_FALLBACK('import.meta.env[k] = "";'),
  "process-module.ts": WITH_FALLBACK('import { env } from "node:process";\nReflect.set(env, k, "");'),
  "process-alias.ts": WITH_FALLBACK("const p = process; p.env[k] = undefined;"),
  "global-computed.ts": WITH_FALLBACK('const g: any = globalThis; g["pro" + "cess"].env[k] = undefined;'),
  "nested-computed.ts": WITH_FALLBACK("const o = { p: process.env }; delete o.p[k];"),
  "any-computed-write.ts": WITH_FALLBACK("const o: Record<string, unknown> = {}; o[k] = 1;"),
  "any-computed-delete.ts": WITH_FALLBACK("const o: Record<string, unknown> = {}; delete o[k];"),
  "eval-env.ts": WITH_FALLBACK('eval("delete process.env." + k);'),
};

/** The same in Python, around a fallback to the home dir. */
const PY_MOVES_DB_PATH: Record<string, string> = {
  "py-pop.py": "os.environ.pop(k, None)",
  "py-del.py": "del os.environ[k]",
  "py-clear.py": "os.environ.clear()",
  "py-unsetenv.py": "os.unsetenv(k)",
  "py-putenv.py": 'os.putenv(k, "")',
  "py-alias-del.py": "e = os.environ\ndel e[k]",
  "py-from-import.py": "from os import environ\nenviron.pop(k)",
  "py-setattr.py": 'setattr(os, "environ", {})',
};

const SCRIPTS: Record<string, string> = {
  "some-script.ts": `${DB_IMPORT}const db = new Database(process.env.DB_PATH!);\nconsole.log(db.query("select 1").all());\n`,
  "helper-script.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\nconst db = new Database(defaultDbPath());\nconsole.log(db.query("select 1").all());\n`,
  "data-dir-script.ts": `${DB_IMPORT}import { join } from "path";\nimport { standupDataDir } from "./data-dir.js";\nconst db = new Database(join(standupDataDir(process.env), "standup.db"));\n`,
  "fallback-script.ts": `${DB_IMPORT}${HOME_IMPORTS}const db = new Database(${FALLBACK});\nconsole.log(db.query("select 1").all());\n`,
  "bracket-fallback.ts": `${DB_IMPORT}${HOME_IMPORTS}const p = process.env["DB_PATH"] || join(homedir(), ".local/share/standup/standup.db");\nnew Database(p);\n`,
  // Held: what each does reaches past DB_PATH.
  "fallback-and-secrets.ts": `${DB_IMPORT}${HOME_IMPORTS}new Database(${FALLBACK});\nconsole.log(join(homedir(), ".local", "share", "standup", "secrets"));\n`,
  "fallback-escaped.ts": `${DB_IMPORT}${HOME_IMPORTS}new Database(${FALLBACK});\nconst x = join(homedir(), "\\x2elocal/share/standup/knowledge");\n`,
  "fallback-string-paren.ts": `${DB_IMPORT}${HOME_IMPORTS}const a = process.env.DB_PATH ?? "("; const b = join(homedir(), ".local/share/standup/standup.db"); new Database(a); new Database(b);\n`,
  "fallback-chain.ts": `${DB_IMPORT}${HOME_IMPORTS}new Database(process.env.DB_PATH ?? process.env.OTHER ?? join(homedir(), ".local/share/standup/standup.db"));\n`,
  "real-home.ts": `${DB_IMPORT}import { userInfo } from "os";\nimport { join } from "path";\nnew Database(process.env.DB_PATH ?? join(userInfo().homedir, ".local/share/standup/standup.db"));\n`,
  "real-home-literal.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\nnew Database(defaultDbPath());\nconsole.log("/fake/home/notes");\n`,
  "deletes-db-path.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\ndelete process.env.DB_PATH;\nnew Database(defaultDbPath());\n`,
  "assigns-db-path.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\nprocess.env.DB_PATH = undefined as any;\nnew Database(defaultDbPath());\n`,
  "child-env.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\nnew Database(defaultDbPath());\nBun.spawnSync(["bun", "x.ts"], { env: { PATH: "/usr/bin" } });\n`,
  "helper-other-env.ts": `${DB_IMPORT}import { join } from "path";\nimport { standupDataDir } from "./data-dir.js";\nnew Database(join(standupDataDir({}), "standup.db"));\n`,
  "helper-aliased.ts": `${DB_IMPORT}import { defaultDbPath as where } from "./db-path.js";\nnew Database(where());\n`,
  "helper-passed.ts": `${DB_IMPORT}import { defaultDbPath } from "./db-path.js";\nconst f = defaultDbPath;\nnew Database(f());\n`,
  ...MOVES_DB_PATH,
  ...Object.fromEntries(Object.entries(PY_MOVES_DB_PATH).map(([name, body]) => [name, `import os, sqlite3\nk = "DB_" + "PATH"\n${body}\nsqlite3.connect(os.environ.get("DB_PATH") or os.path.expanduser("~/.local/share/standup/standup.db"))\n`])),
  "computed-read.ts": `${DB_IMPORT}${HOME_IMPORTS}console.log(process.env["DB" + "_PATH"], process.env[String(1)]);\nconst db = new Database(${FALLBACK});\n`,
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(SRC, "db-path.ts")]: `${HOME_IMPORTS}export function defaultDbPath(): string {\n  return ${FALLBACK};\n}\n`,
  [join(SRC, "data-dir.ts")]: `export { standupDataDir } from "@standup/shared";\n`,
  [join(ROOT, "packages", "store", "src", "x.test.ts")]: `${DB_IMPORT}import { test } from "bun:test";\ntest("x", () => { new Database(process.env.DB_PATH!); });\n`,
  ...Object.fromEntries(Object.entries(SCRIPTS).map(([name, text]) => [join(SRC, name), text])),
};

/** Links in /tmp: the scratch-looking path leads to the live data. */
const LINKS: Record<string, string> = {
  "/tmp/evil": DATA,
  "/tmp/r2/standup.db": LIVE_DB,
};

/** A file in /tmp with another hard link (the live DB's). */
const HARD_LINKED = "/tmp/r3/standup.db";

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, "/tmp/r2", "/tmp/r3", DATA]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const resolve = (p: string): string | null => {
    for (const [link, target] of Object.entries(LINKS)) {
      if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length);
    }
    return p in FILES || dirs.has(p) || p === LIVE_DB || p === HARD_LINKED ? p : null;
  };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p) || p in LINKS || p === LIVE_DB || p === HARD_LINKED,
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: resolve,
    lstat: (p) => {
      if (p in LINKS) return { symlink: true, file: false, nlink: 1 };
      if (p === HARD_LINKED || p === LIVE_DB) return { symlink: false, file: true, nlink: p === HARD_LINKED ? 2 : 1 };
      if (dirs.has(p)) return { symlink: false, file: false, nlink: 2 };
      return p in FILES ? { symlink: false, file: true, nlink: 1 } : null;
    },
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: () => undefined,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(command: string): void {
  expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
}

/** Held as a read of Standup's DB: floor-tamper, HIGH RISK. */
function expectDbRead(command: string): void {
  const v = bash(command);
  expect({ command, verdict: v }).toMatchObject({ command, verdict: { action: "hold", category: "floor-tamper", ownerReserved: true } });
  expect(v.action === "hold" && /Standup's (?:database|data dir)|data-dir helpers|standup\.db/.test(v.reason)).toBe(true);
}

const PATHS = "PATH=/home/u/.bun/bin:/usr/bin:/bin";
const run = (script: string) => `bun packages/collector/src/${script}`;

describe("a DB_PATH in /tmp is a scratch DB", () => {
  test.each([
    `R=$(mktemp -d -p /tmp x-XXXXXX) && env -i ${PATHS} HOME=$R/home DB_PATH=$R/data/standup.db ${run("some-script.ts")}`,
    "env -i HOME=/tmp/r1/home DB_PATH=/tmp/r1/standup.db STANDUP_SQLITE_PATH=/tmp/r1/standup.db sqlite3 /tmp/r1/standup.db '.tables'",
    `R=$(mktemp -d -p /tmp x-XXXXXX) && env -i ${PATHS} HOME=$R/home DB_PATH=$R/standup.db bun test packages/store/src/x.test.ts`,
    "R=$(mktemp -d -p /tmp x-XXXXXX) && sqlite3 $R/standup.db 'select 1'",
    `R=$(mktemp -d -p /tmp x-XXXXXX) && env -i ${PATHS} HOME=$R/home DB_PATH=$R/standup.db bun -e 'import { Database } from "bun:sqlite"; new Database(process.env.DB_PATH).query("select 1").all()'`,
    "R=$(mktemp -d -p /tmp floor-x-XXXXXX) && mkdir -p $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/data $R/knowledge $R/internal && env -i PATH=/home/u/.bun/bin:/usr/bin:/bin HOME=$R/home XDG_CONFIG_HOME=$R/xdg/config XDG_DATA_HOME=$R/xdg/data XDG_CACHE_HOME=$R/xdg/cache XDG_STATE_HOME=$R/xdg/state TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/data/standup.db STANDUP_SQLITE_PATH=$R/data/standup.sqlite KNOWLEDGE_DIR=$R/knowledge STANDUP_INTERNAL_ROOT=$R/internal bun packages/collector/src/helper-script.ts",
    "DB_PATH=/tmp/r1/standup.db bun -e 'import { Database } from \"bun:sqlite\"; new Database(process.env.DB_PATH).query(\"select 1\").all()'",
    "DB_PATH=/tmp/r1/standup.db bun test packages/store/src/x.test.ts",
    `DB_PATH=/tmp/a-scr-1/standup.db ${run("computed-read.ts")}`,
    ...["helper-script.ts", "data-dir-script.ts", "fallback-script.ts", "bracket-fallback.ts", "some-script.ts"].flatMap((s) => [
      `DB_PATH=/tmp/r1/standup.db ${run(s)}`,
      `env -i ${PATHS} DB_PATH=/tmp/r1/standup.db ${run(s)}`,
      `R=$(mktemp -d -p /tmp x-XXXXXX) && env -i ${PATHS} DB_PATH=$R/data/standup.db ${run(s)}`,
      `export DB_PATH=/tmp/scratch-db/standup.db; ${run(s)}`,
      `env -i ${PATHS} HOME=/tmp/r1/home DB_PATH=/tmp/r1/standup.db STANDUP_SQLITE_PATH=/tmp/r1/standup.db ${run(s)}`,
    ]),
  ])("allows %p", (command) => {
    expectAllowed(command);
  });
});

describe("DB paths and code that reach the live DB stay a HIGH RISK DB read", () => {
  test.each([
    // The DB path itself leads to the live DB, or isn't known.
    `DB_PATH=${LIVE_DB} ${run("helper-script.ts")}`,
    `DB_PATH=~/.local/share/standup/standup.db ${run("helper-script.ts")}`,
    `DB_PATH=$HOME/.local/share/standup/standup.db ${run("helper-script.ts")}`,
    `DB_PATH=/tmp/../fake/home/.local/share/standup/standup.db ${run("helper-script.ts")}`,
    `DB_PATH=/tmp/evil/standup.db ${run("helper-script.ts")}`,
    `DB_PATH=/tmp/r2/standup.db ${run("helper-script.ts")}`,
    `DB_PATH=${HARD_LINKED} ${run("helper-script.ts")}`,
    `DB_PATH=$DB_PATH ${run("helper-script.ts")}`,
    `DB_PATH=$X ${run("helper-script.ts")}`,
    `DB_PATH=$(cat /tmp/p) ${run("helper-script.ts")}`,
    `DB_PATH=/tmp/r1/standup.db; ${run("helper-script.ts")}`,
    run("helper-script.ts"),
    `env -i ${PATHS} ${run("helper-script.ts")}`,
    run("fallback-script.ts"),
    `DB_PATH= ${run("fallback-script.ts")}`,
    `DB_PATH=${OWN_SCRATCH}/x.db ${run("helper-script.ts")}`,
    `ln -sf ${LIVE_DB} /tmp/r1/standup.db && DB_PATH=/tmp/r1/standup.db ${run("helper-script.ts")}`,
    // The code reaches past DB_PATH.
    ...[
      "fallback-and-secrets.ts", "fallback-escaped.ts", "fallback-string-paren.ts", "fallback-chain.ts", "real-home.ts", "real-home-literal.ts",
      "deletes-db-path.ts", "assigns-db-path.ts", "child-env.ts", "helper-other-env.ts", "helper-aliased.ts", "helper-passed.ts",
    ].map((s) => `DB_PATH=/tmp/r1/standup.db ${run(s)}`),
    // The code changes DB_PATH by a computed name, through an alias of the env, or wholesale.
    ...Object.keys(MOVES_DB_PATH).flatMap((s) => [
      `DB_PATH=/tmp/a-scr-1/standup.db ${run(s)}`,
      `env -i ${PATHS} DB_PATH=/tmp/a-scr-1/standup.db ${run(s)}`,
    ]),
    ...Object.keys(PY_MOVES_DB_PATH).map((s) => `DB_PATH=/tmp/a-scr-1/standup.db python3 packages/collector/src/${s}`),
    // A direct read of the live DB.
    `DB_PATH=/tmp/r1/standup.db sqlite3 ${LIVE_DB} .tables`,
    "env -i DB_PATH=/tmp/r1/standup.db sqlite3 ~/.local/share/standup/standup.db 'select 1'",
  ])("holds %p", (command) => {
    expectDbRead(command);
  });

  test("a collector start keeps its own scratch-collector rules", () => {
    const v = bash("DB_PATH=/tmp/scratch-db/standup.db bun run packages/collector/src/index.ts --help");
    expect(v).toMatchObject({ action: "hold", category: "outward" });
  });
});
