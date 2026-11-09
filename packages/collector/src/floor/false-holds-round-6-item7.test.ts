import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Standup's own collector code that names its data dir (`join(homedir(),
 * ".local", "share", "standup")`, the data-dir helpers), run from a worktree
 * with HOME, the XDG dirs, DB_PATH, STANDUP_SQLITE_PATH and the knowledge,
 * internal and project-docs dirs all under /tmp. The data dir it builds from
 * the home dir lands in scratch, so the run is allowed as Standup's own code,
 * not held for the owner as a read of the live DB; `bun -e` text importing it
 * stays Persona's to decide. Code that also canonicalizes a path it was handed
 * (`realpathSync(abs)`) is read the same way. Code that reads its own location or the cwd and climbs from there, a
 * full spelling of the live data dir, a lookup of the real home, and runs that
 * leave any of that env unmoved still hold for the owner. The worktree reads
 * through to this checkout; the machine around it is virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
/** A temp path that is a symlink to Standup's data dir. */
const LINKED_DATA = join("/", "tmp", "linked-data");
/** A temp path that is a symlink to the real home. */
const LINKED_HOME = join("/", "tmp", "linked-home");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:7777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: readFileSync(join(REPO, "package.json"), "utf8"),
  [join(DATA, "standup.db")]: "",
};

/** The env the worker's shell started with. */
const WORKER_ENV: Record<string, string> = {};

/** Runs `body` with `env` as the worker's starting env. */
function withWorkerEnv(env: Record<string, string>, body: () => void): void {
  Object.assign(WORKER_ENV, env);
  try {
    body();
  } finally {
    for (const k of Object.keys(env)) delete WORKER_ENV[k];
  }
}

const LINKS: Record<string, string> ={ [LINKED_DATA]: DATA, [LINKED_HOME]: HOME };

/** The real path a virtual worktree or install path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

/** `p` with any virtual link along it followed. */
function unlink(p: string): string {
  for (const [from, to] of Object.entries(LINKS)) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp"]);
  for (const f of Object.keys(VIRTUAL)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (raw: string) => {
    const p = unlink(raw);
    return p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  };
  const isDirectory = (raw: string) => {
    const p = unlink(raw);
    return !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (raw, max) => {
      const p = unlink(raw);
      return p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" };
    },
    exists,
    isDirectory,
    executable: (p) => (p in VIRTUAL ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(unlink(raw));
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    realpath: (p) => (exists(p) ? bare(unlink(p)) : null),
    lstat: (p) => (p in LINKS ? { symlink: true, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    // The worker's env as the classifying process sees it: WORKER_ENV only, so no verdict depends on the machine's.
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

/** The env of a fully isolated run under `t`, with `over` replacing (or, as null, dropping) single variables. */
function isolation(t: string, over: Record<string, string | null> = {}): string {
  const env: Record<string, string | null> = {
    HOME: t,
    XDG_CONFIG_HOME: `${t}/.config`,
    XDG_DATA_HOME: `${t}/.local/share`,
    XDG_STATE_HOME: `${t}/.local/state`,
    XDG_CACHE_HOME: `${t}/.cache`,
    DB_PATH: `${t}/standup.db`,
    STANDUP_SQLITE_PATH: `${t}/standup.db`,
    KNOWLEDGE_DIR: `${t}/k`,
    STANDUP_INTERNAL_ROOT: `${t}/i`,
    STANDUP_PROJECT_DOCS_DIR: `${t}/d`,
    ...over,
  };
  return Object.entries(env)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

const FULL = isolation("/tmp/r6");

type Outcome = "allow" | "persona" | "owner";

function outcome(command: string): { command: string; outcome: Outcome; category?: string } {
  const v = bash(command);  if (v.action === "allow") return { command, outcome: "allow" };
  return { command, outcome: v.ownerOnly ? "owner" : "persona", category: v.category };
}

function expectAllowed(command: string): void {
  expect(outcome(command)).toEqual({ command, outcome: "allow" });
}

function expectOwner(command: string, category = "floor-tamper"): void {
  expect(outcome(command)).toEqual({ command, outcome: "owner", category });
}

/** Writes a worktree script and returns the path a command runs it by. */
function script(name: string, text: string): string {
  VIRTUAL[join(ROOT, "scripts", "r6", name)] = text;
  return `scripts/r6/${name}`;
}

const HOME_DATA = 'import { homedir } from "os";\nimport { join } from "path";\nconst data = join(homedir(), ".local", "share", "standup");\n';

describe("7. collector code naming the data dir, run with full /tmp isolation", () => {
  test.each([
    "packages/collector/src/internal-cwd.test.ts",
    "packages/collector/src/knowledge-isolation.test.ts",
    "packages/collector/src/worktree-root.test.ts",
    "packages/collector/src/bootstrap-launch.test.ts",
  ])("`bun test %s` is allowed", (file) => {
    expect(outcome(`${FULL} bun test ${file}`)).toEqual({ command: `${FULL} bun test ${file}`, outcome: "allow" });
  });

  test.each([
    `${FULL} bun packages/collector/src/internal-cwd.ts`,
    `${FULL} bun run packages/collector/src/internal-cwd.ts`,
    `${FULL} bun packages/collector/src/db-path.ts`,
  ])("%p is allowed, as running Standup's own code with isolation", (command) => {
    expectAllowed(command);
  });

  test.each([
    `${FULL} bun -e 'import {defaultDbPath} from "./packages/collector/src/db-path.ts"; console.log(defaultDbPath())'`,
    `${FULL} bun -e 'import {internalRoot} from "./packages/collector/src/internal-cwd.ts"; console.log(internalRoot())'`,
    `${FULL} bun -e 'import {isInternalCwd} from "./packages/collector/src/internal-cwd.ts"; console.log(isInternalCwd("/tmp/r6/i"))'`,
  ])("%p is allowed: the helpers it imports resolve under the isolation, whether or not it calls them", (command) => {
    expectAllowed(command);
  });

  test("code that canonicalizes a path it built from the home dir is allowed", () => {
    const cases = {
      "realpath-name.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst r = realpathSync(data);\nconsole.log(r.split("/").length);\n`,
      "realpath-call.ts": `${HOME_DATA}import { mkdirSync, realpathSync } from "fs";\nfunction ensure(d: string): string { mkdirSync(d, { recursive: true }); return d; }\nconsole.log(realpathSync(ensure(data)).split("/"));\n`,
      "realpath-member.ts": `${HOME_DATA}const { realpathSync } = require("fs");\nconst o = { dir: data };\nconsole.log(realpathSync(o.dir).slice(1));\n`,
    };
    for (const [name, text] of Object.entries(cases)) expectAllowed(`${FULL} bun ${script(name, text)}`);
  });
});

describe("7. the same code still holds for the owner where the isolation doesn't cover it", () => {
  const DB_PATH_FILE = "packages/collector/src/db-path.ts";
  // db-path.ts names the data dir only behind the run's DB_PATH (`process.env.DB_PATH ?? …`): a scratch DB_PATH in /tmp
  // is all it reaches, so of these runs only those that leave DB_PATH at the live DB hold it.
  const RUNS = ["packages/collector/src/internal-cwd.ts"];

  test.each([...RUNS, DB_PATH_FILE])("`bun %s` with no isolation", (file) => {
    expectOwner(`bun ${file}`);
    if (file === DB_PATH_FILE) expectAllowed(`DB_PATH=/tmp/r6/standup.db bun ${file}`);
    else expectOwner(`DB_PATH=/tmp/r6/standup.db bun ${file}`);
  });

  test("db-path.ts with DB_PATH at the live DB, or under a partial isolation that leaves DB_PATH there", () => {
    expectOwner(`DB_PATH=${join(DATA, "standup.db")} bun ${DB_PATH_FILE}`);
    expectOwner(`${isolation("/tmp/r6", { DB_PATH: join(DATA, "standup.db") })} bun ${DB_PATH_FILE}`);
    expectOwner(`${isolation("/tmp/r6", { DB_PATH: join(LINKED_DATA, "standup.db") })} bun ${DB_PATH_FILE}`);
    expectOwner(`${isolation("/tmp/r6", { DB_PATH: null })} bun ${DB_PATH_FILE}`);
    expectAllowed(`${isolation("/tmp/r6", { HOME })} bun ${DB_PATH_FILE}`);
  });

  const partial: Array<[string, Record<string, string | null>]> = [
    ["DB_PATH at the live DB", { DB_PATH: join(DATA, "standup.db") }],
    ["XDG_DATA_HOME left unset", { XDG_DATA_HOME: null }],
    ["XDG_STATE_HOME left unset", { XDG_STATE_HOME: null }],
    ["STANDUP_SQLITE_PATH left unset", { STANDUP_SQLITE_PATH: null }],
    ["HOME left unset", { HOME: null }],
    ["HOME the real home", { HOME }],
    ["HOME climbing out of /tmp", { HOME: "/tmp/../fake/home" }],
    ["HOME a link to the real home", { HOME: LINKED_HOME }],
    ["XDG_DATA_HOME a link to the live data dir's parent", { XDG_DATA_HOME: join(LINKED_DATA, "..") }],
    ["HOME relative", { HOME: "tmp/r6" }],
    ["HOME computed", { HOME: "$X" }],
    ["STANDUP_INTERNAL_ROOT at the live internal dir", { STANDUP_INTERNAL_ROOT: join(DATA, "internal") }],
    ["STANDUP_INTERNAL_ROOT climbing from the worktree", { STANDUP_INTERNAL_ROOT: "../../../internal" }],
    ["STANDUP_INTERNAL_ROOT a link into the live data dir", { STANDUP_INTERNAL_ROOT: join(LINKED_DATA, "internal") }],
    ["STANDUP_INTERNAL_ROOT computed", { STANDUP_INTERNAL_ROOT: "$X" }],
    ["KNOWLEDGE_DIR at the live data dir", { KNOWLEDGE_DIR: join(DATA, "knowledge") }],
  ];
  test.each(partial)("with %s", (_why, over) => {
    for (const file of RUNS) {
      const command = `${isolation("/tmp/r6", over)} bun ${file}`;
      expect({ command, outcome: outcome(command).outcome }).toEqual({ command, outcome: "owner" });
    }
  });

  test("a relocating dir the worker's env or shell already points at the live data dir", () => {
    const BASE = isolation("/tmp/r6", { STANDUP_INTERNAL_ROOT: null });
    const live = join(DATA, "internal");
    withWorkerEnv({ STANDUP_INTERNAL_ROOT: live }, () => {
      for (const file of RUNS) {
        for (const command of [`${BASE} bun ${file}`, `STANDUP_INTERNAL_ROOT=/tmp/r6/i; ${BASE} bun ${file}`]) {
          expect({ command, outcome: outcome(command).outcome }).toEqual({ command, outcome: "owner" });
        }
        // Its own assignment, or an export, replaces what the worker started with.
        expectAllowed(`${BASE} STANDUP_INTERNAL_ROOT=/tmp/r6/i bun ${file}`);
        expectAllowed(`export STANDUP_INTERNAL_ROOT=/tmp/r6/i; ${BASE} bun ${file}`);
        expectAllowed(`unset STANDUP_INTERNAL_ROOT; ${BASE} bun ${file}`);
      }
    });
    withWorkerEnv({ STANDUP_WORKTREE_ROOT: join(DATA, "worktrees") }, () => {
      for (const file of RUNS) expectOwner(`${FULL} bun ${file}`);
    });
    // A variable the isolation needs set is the command's to set, even to the scratch dir the worker's env already names.
    withWorkerEnv({ STANDUP_INTERNAL_ROOT: "/tmp/r6/i" }, () => {
      for (const file of RUNS) expectOwner(`${BASE} bun ${file}`);
    });
    for (const file of RUNS) {
      for (const command of [`export STANDUP_INTERNAL_ROOT=${live}; ${BASE} bun ${file}`, `export STANDUP_INTERNAL_ROOT=$X; ${BASE} bun ${file}`, `STANDUP_INTERNAL_ROOT=${live}; ${BASE} bun ${file}`]) {
        expect({ command, outcome: outcome(command).outcome }).toEqual({ command, outcome: "owner" });
      }
    }
  });

  test("the live data dir spelled in full, or the home dir found without $HOME", () => {
    const cases = {
      "abs.ts": `import { Database } from "bun:sqlite";\nimport { realpathSync } from "fs";\nnew Database(realpathSync(${JSON.stringify(join(DATA, "standup.db"))}));\n`,
      "abs-dir.ts": `import { join } from "path";\nimport { realpathSync } from "fs";\nconst d = ${JSON.stringify(DATA)};\nconsole.log(realpathSync(d), join(d, "standup.db"));\n`,
      "user-home.ts": 'import { userInfo } from "os";\nimport { join } from "path";\nimport { realpathSync } from "fs";\nconst d = join(userInfo().homedir, ".local", "share", "standup");\nconsole.log(realpathSync(d));\n',
      "passwd.ts": `${HOME_DATA}import { readFileSync, realpathSync } from "fs";\nconsole.log(readFileSync("/etc/passwd", "utf8"), realpathSync(data));\n`,
    };
    for (const [name, text] of Object.entries(cases)) expectOwner(`${FULL} bun ${script(name, text)}`);
  });
});

describe("7. code that reads its own location or the cwd and climbs still holds for the owner", () => {
  // Every worktree sits inside the live data dir, so a path from the cwd or the script's own location climbs into it.
  const cases: Record<string, string> = {
    "dot.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync(".").split("/").slice(0, -3).join("/"), data);\n`,
    "dot-slash.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync("./").split("/"), data);\n`,
    "empty.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync("").split("/"), data);\n`,
    "no-arg.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log((realpathSync as any)().split("/"), data);\n`,
    "template.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync(\`.\`).split("/"), data);\n`,
    "dot-var.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst here = ".";\nconsole.log(realpathSync(here).split("/"), data);\n`,
    "dotdot-var.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst up = "..";\nconsole.log(realpathSync(up).split("/"), data);\n`,
    "empty-var.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst none = '';\nconsole.log(realpathSync(none).split("/"), data);\n`,
    "dot-dot-slash.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst here = "./.";\nconsole.log(realpathSync(here).split("/"), data);\n`,
    "cancelled.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst here = "a/..";\nconsole.log(realpathSync(here).split("/"), data);\n`,
    "escaped-dot.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst here = "\\x2e";\nconsole.log(realpathSync(here).split("/"), data);\n`,
    "string-call.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync(String(1)).split("/"), data);\n`,
    "dirname.ts": `${HOME_DATA}import { realpathSync } from "fs";\nimport { dirname } from "path";\nconst f = "x";\nconsole.log(realpathSync(dirname(f)).split("/"), data);\n`,
    "path-join.ts": `${HOME_DATA}import { realpathSync } from "fs";\nimport path from "path";\nconst f = "x";\nconsole.log(realpathSync(path.join(f)).split("/"), data);\n`,
    "alias.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst r = realpathSync;\nconsole.log(r(data).split("/"));\n`,
    "renamed-import.ts": `${HOME_DATA}import { realpathSync as r } from "fs";\nconsole.log(r(data).split("/"));\n`,
    "renamed-require.ts": `${HOME_DATA}const { realpathSync: r } = require("fs");\nconsole.log(r(data).split("/"));\n`,
    "object.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst o = { realpathSync };\nconsole.log(Object.values(o)[0](data).split("/"));\n`,
    "member.ts": `${HOME_DATA}import fs from "fs";\nconsole.log(fs.realpathSync(data).split("/"));\n`,
    "native.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync.native(data).split("/"));\n`,
    "async.ts": `${HOME_DATA}import { realpath } from "fs/promises";\nconsole.log((await realpath(data)).split("/"));\n`,
    "bracket.ts": `${HOME_DATA}import * as fs from "fs";\nconsole.log(fs["realpathSync"](data).split("/"));\n`,
    "cwd.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync(process.cwd()).split("/"), data);\n`,
    "dirname-self.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconsole.log(realpathSync(__dirname).split("/"), data);\n`,
    "meta.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst here = import.meta.dir;\nconsole.log(realpathSync(here).split("/"), data);\n`,
    "argv.ts": `${HOME_DATA}import { realpathSync } from "fs";\nconst me = process.argv[1]!;\nconsole.log(realpathSync(me).split("/"), data);\n`,
    "python.py": 'import os\ndata = os.path.join(os.path.expanduser("~"), ".local", "share", "standup")\nprint(os.path.realpath(__file__).split("/"), data)\n',
  };
  test.each(Object.keys(cases))("%s", (name) => {
    const run = name.endsWith(".py") ? `python3 ${script(name, cases[name]!)}` : `bun ${script(name, cases[name]!)}`;
    const command = `${FULL} ${run}`;
    expect({ command, outcome: outcome(command).outcome }).toEqual({ command, outcome: "owner" });
  });

  test("scripts on main that read their location or argv and climb", () => {
    for (const file of ["scripts/kb-import.ts", "scripts/kb-migrations/runner.ts", "packages/collector/src/code-search.ts"]) expectOwner(`${FULL} bun ${file}`);
  });
});

describe("7. code past the data dir keeps its own hold", () => {
  test("a nested agent with permissions bypassed, beside internal-cwd", () => {
    expectOwner(`${FULL} bun packages/collector/src/kbeval/env.ts`);
  });

  test("code that reads the git dir it shares with the install leaves the data-dir name resolved under the isolation", () => {
    const text = `${HOME_DATA}import { execSync } from "child_process";\nimport { realpathSync } from "fs";\nconsole.log(execSync("git rev-parse --git-common-dir").toString(), realpathSync(data));\n`;
    expectAllowed(`${FULL} bun ${script("common-dir.ts", text)}`);
  });
});
