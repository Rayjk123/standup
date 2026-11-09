import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig } from "./gate.js";

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
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

const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: "/usr/bin:/bin",
};

function real(p: string): string | null {
  for (const base of [ROOT, INSTALL]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp"]);
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

function verdict(command: string, cwd = ROOT): { command: string; action: string; reason: string } {
  const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
  return { command, action: v.action, reason: v.action === "hold" ? v.reason : "" };
}

/*
 * A pane-creating tmux command with no `-c` starts its shell command in the
 * client's cwd: the floor reads the inner command as run in the command's
 * own cwd. A shell command operand the floor can only partly resolve (a
 * `$(…)` or a variable it can't place, inside the double quotes) ends the
 * options like any other operand: what holds then is the command itself,
 * whose expanded text the pane's shell parses again as code, not the
 * directory it starts in.
 */

const MKTEMP = "R=$(mktemp -d -p /tmp) && mkdir -p $R/home";
const ENV_I = "env -i PATH=/usr/bin:/bin HOME=$R/home";
const start = (inner: string, flags = "") => `${MKTEMP} && tmux -S $R/tmux.sock new-session -d -s live ${flags}"${inner}"`;

const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  [start(`${ENV_I} DB_PATH=$R/standup.db bun --version $R 47123`), ROOT],
  // Expansions the floor resolves, inside the double quotes.
  [start(`${ENV_I} X=$PWD DB_PATH=$R/standup.db sleep 60`), ROOT],
  [start(`${ENV_I} X=$(pwd) DB_PATH=$R/standup.db sleep 60`), ROOT],
  [start(`${ENV_I} X=\\"$R\\" DB_PATH=$R/standup.db sleep 60`), ROOT],
  [start(`${ENV_I} BUN=$(command -v bun) DB_PATH=$R/standup.db sleep 60`), ROOT],
  // A relative path, read in the command's cwd: the worktree's file.
  [start("cat standup.db"), ROOT],
  // A literal -c dir.
  [start("cat standup.db", `-c ${ROOT}/packages `), ROOT],
];

/** Commands whose operand the floor can't fully read: held as unread code, never as an unread start dir. */
const COMPUTED: readonly string[] = [
  start(`${ENV_I} TOKEN=$(cat $R/t) DB_PATH=$R/standup.db sleep 60`),
  start(`${ENV_I} X=$UNSET_THING sleep 60`),
  start(`${ENV_I} X=$(date +%s) sleep 60`),
  `${MKTEMP} && tmux -S $R/tmux.sock new -ds live "${ENV_I} TOKEN=$(cat $R/t) sleep 60"`,
  start(`${ENV_I} TOKEN=$(cat $R/t) sleep 60`, "-- "),
  start(`${ENV_I} TOKEN=$(cat $R/t) sleep 60`, `-c ${ROOT}/packages `),
];

const HELD: ReadonlyArray<readonly [string, string]> = [
  // The same file name, read in the live data dir the command runs from, or the -c dir it names.
  [start("cat standup.db"), DATA],
  [start("cat standup.db", `-c ${DATA} `), ROOT],
  // A dangerous inner command keeps its own hold.
  [start(`${ENV_I} git push origin HEAD:main`), ROOT],
  // A computed -c dir, or a word that may expand to an option.
  [start(`${ENV_I} sleep 60`, "-c $DIR "), ROOT],
  [start(`${ENV_I} sleep 60`, "$OPTS "), ROOT],
  [`${MKTEMP} && tmux -S $R/tmux.sock new-session -d -s live "$CMD"`, ROOT],
  // The shared default server, by no socket, by its own path, or by a label: a new pane there is
  // allowed, but its command keeps its own hold, and a computed one stays unread.
  [`${MKTEMP} && tmux new-session -d -s live "${ENV_I} git push origin HEAD:main"`, ROOT],
  [`${MKTEMP} && tmux -S /tmp/tmux-1000/default new-session -d -s live "${ENV_I} git push origin HEAD:main"`, ROOT],
  [`${MKTEMP} && tmux -L default new-session -d -s live "${ENV_I} git push origin HEAD:main"`, ROOT],
  [`${MKTEMP} && tmux new-session -d -s live "${ENV_I} TOKEN=$(cat $R/t) sleep 60"`, ROOT],
  // Typing into, or ending, sessions on the shared server.
  [`tmux send-keys -t live "echo hi" Enter`, ROOT],
  [`tmux kill-server`, ROOT],
];

describe("tmux new-session on a private socket under a fresh /tmp root, no -c", () => {
  test("reads the inner command in the command's cwd", () => {
    const out = ALLOWED.map(([c, cwd]) => verdict(c, cwd));
    expect(out).toEqual(ALLOWED.map(([command]) => ({ command, action: "allow", reason: "" })));
  }, 300_000);

  test("a partly computed inner command holds as unread code, not as an unread start dir", () => {
    const out = COMPUTED.map((c) => {
      const v = verdict(c);
      return { command: c, action: v.action, command_unread: v.reason.includes("can't read the command `tmux new"), start_dir: v.reason.includes("starts its command in") };
    });
    expect(out).toEqual(COMPUTED.map((command) => ({ command, action: "hold", command_unread: true, start_dir: false })));
  }, 300_000);

  test("a wholly computed operand with no -c written out is named as the command, a computed -c as the dir", () => {
    const rows: ReadonlyArray<readonly [string, string]> = [
      [`tmux new-window "$(cat /tmp/t)"`, "can't read the command `tmux new-window` runs"],
      [`tmux new-window $CMD`, "can't read the command `tmux new-window` runs"],
      [`tmux new-window -c $DIR "sleep 60"`, "can't read the directory `tmux new-window` starts its command in"],
      [`tmux new-window -dc $DIR "sleep 60"`, "can't read the directory `tmux new-window` starts its command in"],
    ];
    const out = rows.map(([command, want]) => {
      const v = verdict(command);
      return { command, action: v.action, reason: v.reason.includes(want) ? want : v.reason };
    });
    expect(out).toEqual(rows.map(([command, reason]) => ({ command, action: "hold", reason })));
  }, 300_000);

  test("stays held where it was", () => {
    const out = HELD.map(([c, cwd]) => ({ command: c, action: verdict(c, cwd).action }));
    expect(out).toEqual(HELD.map(([command]) => ({ command, action: "hold" })));
  }, 300_000);
});
