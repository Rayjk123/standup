import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A scratch collector started from a worktree's collector package with every
 * path Standup's code reads under one /tmp root, the five off-network flags,
 * a cleared env and a private tmux dir. The collector's entry is this
 * checkout's real packages/collector/src/index.ts (and what it imports):
 * its data-dir defaults and tmux calls are read for real, and the run's env
 * moves them under the root. The machine around the worktree is virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const ISO = join("/", "tmp", "standup-iso-1");
const COLLECTOR = join(ROOT, "packages", "collector");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");

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
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  scratchDir: SCRATCH,
  scratchRoot: join(HOME, ".cache", "standup-scratch"),
};

const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** Dirs already made under the scratch root. */
const MADE = [join(ISO, "tmux"), join(ISO, "home")];

/** The worker's env as the hook sees it: in a tmux pane, with its temp dirs in the launch's scratch dir. */
const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

/** The real path a virtual worktree or install path reads through to, or null for the rest of the virtual machine. */
function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", ...MADE]);
  for (const f of [...Object.keys(VIRTUAL), ...MADE]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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
    executable: (p) => (p in VIRTUAL ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    lstat: (p) => (exists(p) ? { symlink: false, file: !isDirectory(p), nlink: 1 } : null),
    realpath: (p) => (exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = COLLECTOR): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

const FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`).join(" ");
const PORTS = "COLLECTOR_PORT=29777 WS_PORT=29778";

/** Every path env var the collector reads, under `r`. */
function paths(r: string): string {
  return [
    `HOME=${r}/home XDG_CONFIG_HOME=${r}/xdg/config XDG_DATA_HOME=${r}/xdg/data XDG_CACHE_HOME=${r}/xdg/cache XDG_STATE_HOME=${r}/xdg/state`,
    `TMPDIR=${r}/tmp TMUX_TMPDIR=${r}/tmux DB_PATH=${r}/db KNOWLEDGE_DIR=${r}/kb STANDUP_INTERNAL_ROOT=${r}/internal STANDUP_PROJECT_DOCS_DIR=${r}/docs`,
    `ICONS_DIR=${r}/icons STANDUP_WRITE_TOKEN_FILE=${r}/token STANDUP_PROJECTS_PATH=${r}/projects.json STANDUP_WORKTREE_ROOT=${r}/wt`,
  ].join(" ");
}

/** The isolated start as a worker types it from the collector package. */
function start(r: string, { env = "env -i PATH=/home/u/.bun/bin:/usr/bin:/bin", entry = "src/index.ts" } = {}): string {
  return `${env} ${paths(r)} ${PORTS} ${FLAGS} bun run ${entry}`;
}

/** The same start with one assignment replaced (or dropped, for an empty `to`). */
function startWith(from: string, to: string, r = ISO): string {
  const text = start(r);
  expect(text).toContain(from);
  return text.replace(from, to).replace(/ {2,}/g, " ");
}

const MKTEMP = "R=$(mktemp -d -p /tmp x-XXXX)";

function verdict(command: string, cwd = COLLECTOR): { command: string; action: string; category: string | null; reason: string } {
  const v = bash(command, cwd);
  return { command, action: v.action, category: v.action === "hold" ? v.category : null, reason: v.action === "hold" ? v.reason : "" };
}

describe("a completely isolated scratch collector with a private tmux dir", () => {
  test("is allowed: literal root, a fresh mktemp root with its dirs made, backgrounded, or run from the worktree root", () => {
    for (const [command, cwd] of [
      [start(ISO), COLLECTOR],
      [`${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R")}`, COLLECTOR],
      [`${MKTEMP} && mkdir -p $R/{home,xdg/config,xdg/data,xdg/cache,xdg/state,tmp,tmux,kb,internal,docs} && ${start("$R")}`, COLLECTOR],
      [`${start(ISO)} > ${ISO}/c.log 2>&1 &`, COLLECTOR],
      [`${start(ISO)} > ${ISO}/c.log 2>&1 & echo $! > ${ISO}/pid`, COLLECTOR],
      [start(ISO, { entry: "packages/collector/src/index.ts" }), ROOT],
    ] as const) {
      expect({ command, verdict: bash(command, cwd) }).toEqual({ command, verdict: { action: "allow" } });
    }
  }, 120_000);

  test("is allowed with $TMUX dropped by env -u in place of env -i", () => {
    const command = start(ISO, { env: `env -u TMUX -u TMUX_PANE TMP=${ISO}/tmp TEMP=${ISO}/tmp STANDUP_SQLITE_PATH=${ISO}/db` });
    expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
  }, 60_000);
});

describe("a collector start whose tmux calls may leave the scratch root", () => {
  const tmuxHold = (command: string) => {
    const v = verdict(command);
    return { command, action: v.action, category: v.category, tmux: /its own tmux calls/.test(v.reason) };
  };

  test("without TMUX_TMPDIR, the collector's bare tmux reaches the shared default socket: held", () => {
    for (const command of [startWith(`TMUX_TMPDIR=${ISO}/tmux `, ""), `${MKTEMP}; mkdir -p $R/home; ${startWith(`TMUX_TMPDIR=$R/tmux `, "", "$R")}`]) {
      expect(tmuxHold(command)).toEqual({ command, action: "hold", category: "destructive", tmux: true });
    }
  }, 60_000);

  test("with a TMUX_TMPDIR that isn't a dir when it starts (tmux falls back to /tmp): held", () => {
    for (const command of [
      startWith(`TMUX_TMPDIR=${ISO}/tmux`, `TMUX_TMPDIR=${ISO}/tmux2`),
      `${MKTEMP}; mkdir -p $R/home; ${start("$R")}`,
    ]) {
      expect(tmuxHold(command)).toEqual({ command, action: "hold", category: "destructive", tmux: true });
    }
    // A delete in the command voids the isolation itself.
    const removed = `${MKTEMP}; mkdir -p $R/home $R/tmux; rm -rf $R/tmux; ${start("$R")}`;
    expect({ command: removed, action: bash(removed).action }).toEqual({ command: removed, action: "hold" });
  }, 60_000);

  test("with a TMUX_TMPDIR outside the root: held", () => {
    for (const to of ["TMUX_TMPDIR=/tmp/other", `TMUX_TMPDIR=${DATA}/tmux`, "TMUX_TMPDIR=/tmp"]) {
      const command = startWith(`TMUX_TMPDIR=${ISO}/tmux`, to);
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  }, 60_000);

  test("with $TMUX inherited from the worker's pane or set by the command: held", () => {
    for (const command of [
      start(ISO, { env: `env -u TMUX_PANE TMP=${ISO}/tmp TEMP=${ISO}/tmp STANDUP_SQLITE_PATH=${ISO}/db` }),
      start(ISO, { env: `env TMP=${ISO}/tmp TEMP=${ISO}/tmp STANDUP_SQLITE_PATH=${ISO}/db` }),
      start(ISO, { env: "env -i PATH=/usr/bin:/bin TMUX=/tmp/tmux-1000/default,1,0" }),
    ]) {
      expect(tmuxHold(command)).toEqual({ command, action: "hold", category: "destructive", tmux: true });
    }
  }, 60_000);
});

describe("other collector starts stay held", () => {
  test("missing an off-network flag is held as outward", () => {
    for (const [name, value] of SCRATCH_COLLECTOR_ENV) {
      const command = startWith(`${name}=${value}`, "");
      const v = verdict(command);
      expect({ command, action: v.action, category: v.category, names: v.reason.includes(`${name}=${value}`) }).toEqual({ command, action: "hold", category: "outward", names: true });
    }
  }, 120_000);

  test("a path env var at the live data dir, or outside the root, is held", () => {
    for (const command of [
      startWith(`ICONS_DIR=${ISO}/icons`, `ICONS_DIR=${DATA}/icons`),
      startWith(`DB_PATH=${ISO}/db`, `DB_PATH=${DATA}/standup.db`),
      startWith(`KNOWLEDGE_DIR=${ISO}/kb`, `KNOWLEDGE_DIR=${DATA}/knowledge`),
      startWith(`STANDUP_INTERNAL_ROOT=${ISO}/internal`, "STANDUP_INTERNAL_ROOT=/tmp/elsewhere/internal"),
      startWith(`STANDUP_WRITE_TOKEN_FILE=${ISO}/token`, `STANDUP_WRITE_TOKEN_FILE=${HOME}/.config/standup/token`),
      startWith(`HOME=${ISO}/home`, `HOME=${HOME}`),
    ]) {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);

  test("on the live collector's or console's ports, it is held", () => {
    for (const [from, to] of [
      [PORTS, "COLLECTOR_PORT=27777 WS_PORT=27778"],
      [PORTS, "COLLECTOR_PORT=17777 WS_PORT=17778"],
      ["COLLECTOR_PORT=29777", "COLLECTOR_PORT=7777"],
      ["WS_PORT=29778", "WS_PORT=7778"],
    ] as const) {
      const command = startWith(from, to);
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);

  test("the install's collector entry is held, isolated or not", () => {
    const command = start(ISO, { entry: `${INSTALL}/packages/collector/src/index.ts` });
    expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
  }, 60_000);

  test("with no isolation, the real entry's scan names the data dir", () => {
    for (const command of [`${FLAGS} ${PORTS} bun run src/index.ts`, `env -i PATH=/usr/bin:/bin ${FLAGS} ${PORTS} bun run src/index.ts`]) {
      const v = verdict(command);
      expect({ command, action: v.action, category: v.category, scan: /code in \S+\/packages\/collector\/src\/index\.ts (?:names Standup's data dir|uses Standup's data-dir helpers)/.test(v.reason) }).toEqual({
        command,
        action: "hold",
        category: "floor-tamper",
        scan: true,
      });
    }
  }, 60_000);

  test("backgrounded alongside a later program that may write into the root, it is held", () => {
    const command = `${start(ISO)} > ${ISO}/c.log 2>&1 & sleep 3; touch ${ISO}/home/.bunfig.toml`;
    expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
  }, 60_000);
});
