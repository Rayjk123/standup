import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A scratch collector whose root is a variable the same command sets from
 * `mktemp -d` anchored under /tmp (`-p /tmp`, `--tmpdir=/tmp`, a template
 * starting with /tmp/, or a bare one with no TMPDIR) counts as isolated: the
 * dir is new, so nothing the run is pointed at was placed there before. A
 * failure check on it (`|| exit 1`, `set -e`) changes nothing: `exit` and
 * `set` write nothing. The collector's entry is this checkout's real
 * packages/collector/src/index.ts, as in the round 7 item 11 tests; the
 * machine around the worktree is virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
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

function probes(env: Record<string, string> = WORKER_ENV): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", SCRATCH]);
  for (const f of [...Object.keys(VIRTUAL), SCRATCH]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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
    env: (name) => env[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/**
 * Classifies `command` with the hook's own TMPDIR set to the worker's: the
 * hook shares the worker's environment, and the floor reads a bare
 * `mktemp -d`'s dir from it.
 */
function bash(command: string, env: Record<string, string> = WORKER_ENV): FloorVerdict {
  const saved = process.env.TMPDIR;
  if (env.TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = env.TMPDIR;
  try {
    return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: COLLECTOR }, config, probes(env));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
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

/** The isolated start under `$X`, its home and tmux dirs made first. */
const START = `mkdir -p $X/home $X/tmux; env -i PATH=/home/u/.bun/bin:/usr/bin:/bin ${paths("$X")} ${PORTS} ${FLAGS} bun run src/index.ts`;

function verdict(command: string, env?: Record<string, string>): { command: string; action: string; category: string | null; reason: string } {
  const v = bash(command, env);
  return { command, action: v.action, category: v.action === "hold" ? v.category : null, reason: v.action === "hold" ? v.reason : "" };
}

describe("a scratch root a fresh mktemp dir under /tmp holds", () => {
  test.each([
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXX)",
    "X=$(mktemp -dp /tmp floor-iso-XXXXXX)",
    "X=$(mktemp -p /tmp -d floor-iso-XXXXXX)",
    "X=$(mktemp -d -p /tmp/ floor-iso-XXXXXX)",
    "X=$(mktemp -d -p /tmp)",
    "X=$(mktemp -d /tmp/floor-iso.XXXXXX)",
    "X=$(mktemp -d --tmpdir=/tmp floor-iso-XXXXXX)",
    "X=$(mktemp --directory --tmpdir=/tmp floor-iso-XXXXXX)",
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXXXX --suffix=.d)",
    'X="$(mktemp -d -p /tmp floor-iso-XXXXXX)"',
    "X=`mktemp -d -p /tmp floor-iso-XXXXXX`",
    "export X=$(mktemp -d -p /tmp floor-iso-XXXXXX)",
    // A failure check: `exit` and `set` write nothing (a failed mktemp leaves X empty, its paths at `/home` and the like, either way).
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || exit 1",
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || exit",
    'X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || { echo "no temp dir" >&2; exit 1; }',
    "set -e; X=$(mktemp -d -p /tmp floor-iso-XXXXXX)",
    "set -euo pipefail; X=$(mktemp -d -p /tmp floor-iso-XXXXXX)",
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || echo failed",
  ])("is allowed: %s", (head) => {
    for (const sep of ["; ", " && ", "\n"]) {
      const command = `${head}${sep}${START}`;
      expect(verdict(command)).toEqual({ command, action: "allow", category: null, reason: "" });
    }
  }, 120_000);

  // GNU mktemp's bare and -t forms make the dir under TMPDIR (-t over -p), else /tmp.
  test.each(["X=$(mktemp -d)", "X=$(mktemp -d -t floor-iso-XXXXXX)", "X=$(mktemp -d -p /tmp -t floor-iso-XXXXXX)"])("is allowed with no TMPDIR: %s", (head) => {
    const { TMPDIR: _, TMP: _t, TEMP: _e, ...noTemp } = WORKER_ENV;
    const command = `${head}; ${START}`;
    expect(verdict(command, noTemp)).toEqual({ command, action: "allow", category: null, reason: "" });
  }, 120_000);

  // Under the worker's TMPDIR, the launch's scratch dir, the root lies in the real home dir: code that reads its env and climbs
  // a path (the collector does) can reach the live data from there, so only a root under /tmp isolates it.
  test.each(["X=$(mktemp -d)", "X=$(mktemp -d -t floor-iso-XXXXXX)", "X=$(mktemp -d -p /tmp -t floor-iso-XXXXXX)"])("is held for the collector under the scratch TMPDIR: %s", (head) => {
    const command = `${head}; ${START}`;
    expect(verdict(command).action).toBe("hold");
  }, 120_000);
});

describe("a mktemp root the floor can't pin under /tmp or the scratch dir stays held", () => {
  test.each([
    // A dir in the live data dir, spelled or through $HOME.
    `X=$(mktemp -d -p ${DATA} floor-iso-XXXXXX)`,
    "X=$(mktemp -d -p $HOME/.local/share/standup floor-iso-XXXXXX)",
    `X=$(mktemp -d ${DATA}/floor-iso.XXXXXX)`,
    // A template that climbs out of /tmp.
    "X=$(mktemp -d /tmp/../fake/home/.local/share/standup/floor-iso.XXXXXX)",
    // Reassigned after mktemp.
    `X=$(mktemp -d -p /tmp floor-iso-XXXXXX); X=${DATA}`,
    `X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || exit 1; X=${DATA}`,
    // A fallback after `||` that isn't an exit: X may be either value.
    `X=$(mktemp -d -p /tmp floor-iso-XXXXXX) || X=${DATA}`,
    // A cd that goes on only where it worked: still into the live data dir.
    `cd ${DATA} || exit 1; X=$(mktemp -d -p . floor-iso-XXXXXX)`,
  ])("held: %s", (head) => {
    const command = `${head}; ${START}`;
    expect(verdict(command).action).toBe("hold");
  }, 120_000);

  test.each([
    // `--tmpdir` takes its value only after `=`: `/tmp` here is the template, and the floor isn't sure of the name.
    "X=$(mktemp -d --tmpdir /tmp floor-iso-XXXXXX)",
    // A template with `..` lands outside the dir it names.
    "X=$(mktemp -d -p /tmp ../floor-iso-XXXXXX)",
    // Set in a subshell, or only for one other command: the outer X is unset.
    "(X=$(mktemp -d -p /tmp floor-iso-XXXXXX))",
    "X=$(mktemp -d -p /tmp floor-iso-XXXXXX) true",
    // A mktemp the floor doesn't take for the installed one.
    "X=$(/usr/bin/mktemp -d -p /tmp floor-iso-XXXXXX)",
    // A function that sets X runs only where it is called: not here.
    "f() { X=$(mktemp -d -p /tmp floor-iso-XXXXXX); }",
    // A value from somewhere the floor can't read.
    "X=$(cat /tmp/root)",
    // No dir: `-u` makes nothing, and without `-d` it is a file.
    "X=$(mktemp -u -d -p /tmp floor-iso-XXXXXX)",
    // A name with a space splits into two words under bash's reading of the unquoted `$X/home`.
    'X=$(mktemp -d -p /tmp "floor iso-XXXXXX")',
    // An `exit` function that writes where the floor doesn't record, before the run.
    "exit() { cp -a /tmp/src/. $X; }; X=$(mktemp -d -p /tmp floor-iso-XXXXXX); exit 1",
  ])("held: %s", (head) => {
    const command = `${head}; ${START}`;
    expect(verdict(command).action).toBe("hold");
  }, 120_000);

  test("held: X inherited from the worker's env, not set by the command", () => {
    const command = START;
    expect(verdict(command, { ...WORKER_ENV, X: "/tmp/floor-iso-abc" }).action).toBe("hold");
    expect(verdict(`export X; ${command}`, { ...WORKER_ENV, X: "/tmp/floor-iso-abc" }).action).toBe("hold");
  }, 120_000);

  test("held: a bare mktemp -d when the worker's TMPDIR points into the live data dir", () => {
    const command = `X=$(mktemp -d); ${START}`;
    expect(verdict(command, { ...WORKER_ENV, TMPDIR: join(DATA, "tmp") }).action).toBe("hold");
  }, 120_000);

  test("held: an isolated start that also writes elsewhere", () => {
    const command = `X=$(mktemp -d -p /tmp floor-iso-XXXXXX); ${START} && git push origin HEAD`;
    expect(verdict(command).action).toBe("hold");
  }, 120_000);
});
