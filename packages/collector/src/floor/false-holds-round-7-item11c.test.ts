import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A script under /tmp that starts an isolated scratch collector in a tmux
 * session on a private -S socket. The env the collector starts with is an
 * array the script shell-quotes word by word with a `printf '%q '` helper and
 * splices into the command tmux runs, started in the collector package by
 * `-c`. The script's root is its first argument, checked by a `case` guard.
 * The collector's entry is this checkout's real packages/collector/src/index.ts.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const COLLECTOR = join(ROOT, "packages", "collector");
const INSTALL = join("/", "fake", "install");
const ISO = join("/", "tmp", "wslive.x");
const ONE_LINE = join("/", "tmp", "r");
const SCRIPT = join("/", "tmp", "floor-iso-AAAA", "tmp", "start3.sh");
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

const FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`);

/** The env array the script hands the collector, every path under "$ROOT". */
const ENVV = [
  'HOME="$ROOT/home"',
  'XDG_CONFIG_HOME="$ROOT/xdg/config"',
  'XDG_DATA_HOME="$ROOT/xdg/data"',
  'XDG_CACHE_HOME="$ROOT/xdg/cache"',
  'XDG_STATE_HOME="$ROOT/xdg/state"',
  'TMPDIR="$ROOT/tmp"',
  'DB_PATH="$ROOT/db"',
  'KNOWLEDGE_DIR="$ROOT/kb"',
  'STANDUP_INTERNAL_ROOT="$ROOT/internal"',
  'STANDUP_PROJECT_DOCS_DIR="$ROOT/docs"',
  'ICONS_DIR="$ROOT/icons"',
  'STANDUP_WRITE_TOKEN_FILE="$ROOT/token"',
  'STANDUP_PROJECTS_PATH="$ROOT/projects.json"',
  'STANDUP_WORKTREE_ROOT="$ROOT/wt"',
  'TMUX_TMPDIR="$ROOT/tmux"',
  "COLLECTOR_PORT=29777",
  "WS_PORT=29778",
  ...FLAGS,
  "PATH=/usr/bin:/bin",
];

const GUARD = 'case "$ROOT" in /tmp/*) ;; *) echo "root must be under /tmp" >&2; exit 1;; esac';
const Q = "q() { printf '%q ' \"$@\"; }";
const INNER = 'exec env -i $(q "${ENVV[@]}") bun run src/index.ts';

type ScriptOptions = { envv?: string[]; q?: string; inner?: string; socket?: string; guard?: string; before?: string[]; dir?: string };

/** The start script, with any of its pieces replaced; `before` lines run just before the tmux call. */
function script({ envv = ENVV, q = Q, inner = INNER, socket = '-S "$ROOT/tmux.sock"', guard = GUARD, before = [], dir = '-c "$PWD/packages/collector"' }: ScriptOptions = {}): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'ROOT="$1"',
    guard,
    q,
    `ENVV=(${envv.join(" ")})`,
    ...before,
    `tmux ${socket} new-session -d -s c ${dir} "${inner}"`,
    "",
  ].join("\n");
}

/** Dirs already made under the scratch roots. */
const MADE = [join(ISO, "tmux"), join(ISO, "home"), join(ONE_LINE, "tmux"), join(ONE_LINE, "home"), join(HOME, "x", "tmux")];

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

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const disk = defaultProbes();
  const virtual: Record<string, string> = {
    [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
    [join(DATA, "standup.db")]: "",
    [join(DATA, "secrets", "owner.token")]: "secret",
    ...files,
  };
  const dirs = new Set<string>(["/", "/tmp", ...MADE]);
  for (const f of [...Object.keys(virtual), ...MADE]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const exists = (p: string) => p in virtual || dirs.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in virtual) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: () => null,
    readFile: (p, max) => (p in virtual ? { ok: true, text: virtual[p]! } : real(p) !== null ? disk.readFile(real(p)!, max) : { ok: false, reason: "missing" }),
    exists,
    isDirectory,
    executable: (p) => (p in virtual ? false : real(p) !== null ? disk.executable(real(p)!) : null),
    listDir: (raw) => {
      const p = bare(raw);
      if (!isDirectory(p)) return null;
      const names = Object.keys(virtual).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...names, ...onDisk])];
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

function verdict(command: string, files: Record<string, string> = {}, cwd = ROOT): { command: string; action: string; category: string | null; reason: string } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(files));
  return { command, action: v.action, category: v.action === "hold" ? v.category : null, reason: v.action === "hold" ? v.reason : "" };
}

/** Runs the start script with `shell`, with `options` replacing its pieces, on root `arg`; the verdict names the case. */
function run(name: string, options: ScriptOptions = {}, arg = ISO, shell = "bash"): { name: string; action: string; category: string | null; reason: string } {
  const { action, category, reason } = verdict(`${shell} ${SCRIPT} ${arg}`, { [SCRIPT]: script(options) });
  return { name, action, category, reason };
}

/** The isolated start as one line, every value written out under `r`. */
function startLine(r: string): string {
  return `env -i ${ENVV.map((w) => w.replace(/"\$ROOT([^"]*)"/, `${r}$1`)).join(" ")} bun run src/index.ts`;
}

const ALLOWED = { action: "allow", category: null, reason: "" };

describe("a start script that runs an isolated collector in a tmux session on a private socket", () => {
  test("is allowed: the printf %q helper over the env array, the -c dir as the collector's cwd", () => {
    expect(run("script")).toEqual({ name: "script", ...ALLOWED });
  }, 120_000);

  test("the direct one-liner is allowed, from the package or with -c from the worktree root", () => {
    for (const [command, cwd] of [
      [`tmux -S ${ONE_LINE}/tmux.sock new-session -d "exec ${startLine(ONE_LINE)}"`, COLLECTOR],
      [`tmux -S ${ONE_LINE}/tmux.sock new-session -d -s c -c ${COLLECTOR} "exec ${startLine(ONE_LINE)}"`, ROOT],
      [`tmux -S ${ONE_LINE}/tmux.sock new-window -d -n c -c packages/collector "exec ${startLine(ONE_LINE)}"`, ROOT],
    ] as const) {
      expect(verdict(command, {}, cwd)).toEqual({ command, ...ALLOWED });
    }
  }, 120_000);
});

describe("start scripts and one-liners that stay held", () => {
  test("an off-network flag missing from the env array is held as outward", () => {
    for (const flag of FLAGS) {
      const v = run(flag, { envv: ENVV.filter((w) => w !== flag) });
      expect({ name: v.name, action: v.action, category: v.category, names: v.reason.includes(flag) }).toEqual({ name: flag, action: "hold", category: "outward", names: true });
    }
  }, 120_000);

  test("on a socket that isn't private (none, the shared default, outside a temp dir) it is held", () => {
    for (const [name, socket] of [
      ["no -S", ""],
      ["-L default", "-L default"],
      ["shared default socket", "-S /tmp/tmux-1000/default"],
      ["home socket", `-S ${HOME}/x/tmux.sock`],
    ] as const) {
      const v = run(name, { socket });
      expect({ name, action: v.action }).toEqual({ name, action: "hold" });
    }
  }, 120_000);

  test("with the root outside /tmp it is held", () => {
    // Without the guard, a root under the home dir reaches tmux and the collector.
    expect(run("unguarded home root", { guard: ":" }, join(HOME, "x")).action).toBe("hold");
    expect(run("guarded home root", {}, join(HOME, "x")).action).toBe("hold");
    // `..` passes the `/tmp/*` pattern and climbs out of it.
    expect(run("dotdot root", {}, "/tmp/../fake/home/x").action).toBe("hold");
    expect(run("unguarded unknown root", { guard: ":" }, '"$(cat /tmp/root.txt)"').action).toBe("hold");
  }, 120_000);

  test("an env array element the floor can't read is held", () => {
    const cases: Array<[string, ScriptOptions]> = [
      ["element from read", { q: `${Q}\nread -r EXTRA < "$ROOT/extra"`, envv: [...ENVV, '"$EXTRA"'] }],
      ["unquoted element", { envv: ENVV.map((w) => (w === 'HOME="$ROOT/home"' ? "HOME=$ROOT/home" : w)) }],
      ["element from a substitution", { envv: [...ENVV, '"X=$(cat /tmp/x)"'] }],
      ["root from a substitution", { q: `${Q}\nROOT="$(cat "$ROOT/root.txt")"` }],
      ["element reassigned", { before: ["ENVV[0]=HOME=/fake/home"] }],
      ["array appended", { before: ['read -r EXTRA < "$ROOT/extra"', 'ENVV+=("$EXTRA")'] }],
      ["array spliced unquoted", { inner: "exec env -i ${ENVV[*]} bun run src/index.ts" }],
    ];
    for (const [name, options] of cases) {
      const v = run(name, options);
      expect({ name: v.name, action: v.action }).toEqual({ name, action: "hold" });
    }
  }, 120_000);

  test("an inner command that pushes is held as outward", () => {
    const v = run("git push", { inner: "exec git push origin HEAD:main" });
    expect({ action: v.action, category: v.category }).toEqual({ action: "hold", category: "outward" });
  }, 60_000);

  test("a helper that isn't only printf, or a printf the script redefines, is held", () => {
    for (const [name, q] of [
      ["eval helper", 'q() { eval "$@"; }'],
      ["printf then more", "q() { printf '%q ' \"$@\"; rm -rf \"$HOME\"; }"],
      ["printf with a redirect", "q() { printf '%q ' \"$@\" > /fake/home/.bashrc; }"],
      ["printf redefined", `printf() { eval "$@"; }; ${Q}`],
      ["printf -v", "q() { printf -v OUT '%q ' \"$@\"; }"],
      ["helper defined on one path only", `${Q}; if [ -n "\${2:-}" ]; then q() { eval "$@"; }; fi`],
    ] as const) {
      const v = run(name, { q });
      expect({ name, action: v.action }).toEqual({ name, action: "hold" });
    }
  }, 120_000);

  test("the one-liner with a flag missing, at the install's entry, or running a push is held", () => {
    for (const command of [
      `tmux -S ${ONE_LINE}/tmux.sock new-session -d "exec ${startLine(ONE_LINE).replace(`${FLAGS[0]} `, "")}"`,
      `tmux -S ${ONE_LINE}/tmux.sock new-session -d -c ${INSTALL}/packages/collector "exec ${startLine(ONE_LINE)}"`,
      `tmux -S ${ONE_LINE}/tmux.sock new-session -d "exec git push origin HEAD:main"`,
    ]) {
      expect({ command, action: verdict(command, {}, COLLECTOR).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);

  test("the env array is read only in a script an explicit bash runs: in zsh, sh or the tool's own shell it is held", () => {
    for (const shell of ["zsh", "sh"]) {
      const v = run(`${shell} script`, {}, ISO, shell);
      expect({ shell, action: v.action }).toEqual({ shell, action: "hold" });
    }
    const inline = [`ROOT=${ISO}`, Q, `ENVV=(${ENVV.join(" ")})`, `tmux -S "$ROOT/tmux.sock" new-session -d -s c -c "$PWD/packages/collector" "${INNER}"`].join("; ");
    expect({ command: inline, action: verdict(inline).action }).toEqual({ command: inline, action: "hold" });
  }, 120_000);

  test("a -c dir the floor can't resolve leaves the collector's cwd unknown: held", () => {
    for (const [name, dir] of [
      ["format", '-c "#{pane_current_path}"'],
      ["format inside", '-c "$PWD/#{session_name}"'],
      ["unknown variable", '-c "$UNKNOWN_DIR"'],
      ["tilde tmux expands", "-c '~/x'"],
      ["empty", '-c ""'],
    ] as const) {
      const v = run(name, { dir });
      expect({ name, action: v.action }).toEqual({ name, action: "hold" });
    }
    for (const dir of ['"#{pane_current_path}"', '"$UNKNOWN_DIR"', "'~/x'"]) {
      const command = `tmux -S ${ONE_LINE}/tmux.sock new-session -d -c ${dir} "exec ${startLine(ONE_LINE)}"`;
      expect({ command, action: verdict(command, {}, COLLECTOR).action }).toEqual({ command, action: "hold" });
    }
  }, 120_000);
});
