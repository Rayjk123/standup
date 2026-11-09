import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A worker starts a throwaway collector from its own worktree with `env -i`
 * and every dir variable under a fresh /tmp root, seeding that root with its
 * own owner token first (`printf tok > $R/data/secrets/owner.token`, then
 * `chmod 600` on it). The token is a file the command just made under the
 * new root, not Standup's secret, and the worktree path under the data dir's
 * worktrees dir is not the data dir: such a run is classified as the same
 * run without the seeding is, never HIGH RISK. The real owner token, the
 * live DB, a token path outside the root, a root the floor can't place under
 * /tmp and the live ports stay as strict. The collector's entry is this
 * checkout's real packages/collector/src/index.ts; the machine around the
 * worktree is virtual.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
const TOKEN = join(DATA, "secrets", "owner.token");

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
  [TOKEN]: "secret",
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

function probes(env: Record<string, string>): Partial<FloorProbes> {
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

/** Classifies `command` from the worktree root with the hook's own TMPDIR set to the worker's. */
function bash(command: string, env: Record<string, string> = WORKER_ENV): FloorVerdict {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = env.TMPDIR;
  try {
    return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(env));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

const FLAGS = SCRATCH_COLLECTOR_ENV.map(([k, v]) => `${k}=${v}`).join(" ");
const PORTS = "PORT=47123 COLLECTOR_PORT=47123 WS_PORT=47124";

/** Every dir variable Standup's code finds its dirs by, under `r`. */
function paths(r: string): string {
  return [
    `HOME=${r}/home XDG_CONFIG_HOME=${r}/xdg/config XDG_DATA_HOME=${r}/xdg/data XDG_STATE_HOME=${r}/xdg/state XDG_CACHE_HOME=${r}/xdg/cache`,
    `TMPDIR=${r}/tmp TMP=${r}/tmp TEMP=${r}/tmp TMUX_TMPDIR=${r}/tmux DB_PATH=${r}/data/standup.db STANDUP_SQLITE_PATH=${r}/data/standup.db`,
    `KNOWLEDGE_DIR=${r}/kb STANDUP_INTERNAL_ROOT=${r}/internal STANDUP_PROJECT_DOCS_DIR=${r}/docs`,
  ].join(" ");
}

const ENTRY = "packages/collector/src/index.ts";
const ABS_ENTRY = join(ROOT, ENTRY);
const BUN_PATH = "PATH=/usr/bin:/bin:$HOME/.bun/bin";

/** The isolated start under `r`, its dirs made first; `seed` writes and chmods the root's own owner token. */
function start(r: string, opts: { seed?: boolean; flags?: boolean; entry?: string; token?: string; ports?: string } = {}): string {
  const mk = opts.seed ? `mkdir -p ${r}/home ${r}/tmux ${r}/data/secrets && printf tok > ${r}/data/secrets/owner.token && chmod 600 ${r}/data/secrets/owner.token` : `mkdir -p ${r}/home ${r}/tmux ${r}/data`;
  const token = opts.token ?? (opts.seed ? `STANDUP_OWNER_TOKEN_FILE=${r}/data/secrets/owner.token` : "");
  const flags = opts.flags === false ? "" : FLAGS;
  return `${mk} && env -i ${BUN_PATH} ${paths(r)} ${token} ${opts.ports ?? PORTS} ${flags} bun run ${opts.entry ?? ENTRY}`;
}

const MK = "R=$(mktemp -d -p /tmp)";
const LIT = "/tmp/tmp.AbC123";

function shape(command: string, env?: Record<string, string>): { action: string; category: string | null; reserved: boolean; reason: string } {
  const v = bash(command, env);
  return v.action === "hold" ? { action: v.action, category: v.category, reserved: v.ownerReserved === true, reason: v.reason } : { action: v.action, category: null, reserved: false, reason: "" };
}

/** The verdict without its reason text. */
function bare(command: string): { action: string; category: string | null; reserved: boolean } {
  const { reason: _, ...rest } = shape(command);
  return rest;
}

describe("an isolated scratch collector that seeds its own owner token is classified as the run without it", () => {
  test.each([
    ["mktemp root, relative entry", `${MK} && ${start("$R", { seed: true })}`, `${MK} && ${start("$R")}`],
    ["mktemp root, absolute entry", `${MK} && ${start("$R", { seed: true, entry: ABS_ENTRY })}`, `${MK} && ${start("$R", { entry: ABS_ENTRY })}`],
    ["mktemp root, no scratch flags", `${MK} && ${start("$R", { seed: true, flags: false })}`, `${MK} && ${start("$R", { flags: false })}`],
    ["mktemp root, absolute entry, no scratch flags", `${MK} && ${start("$R", { seed: true, flags: false, entry: ABS_ENTRY })}`, `${MK} && ${start("$R", { flags: false, entry: ABS_ENTRY })}`],
    ["mktemp root, from the collector's package dir", `${MK} && cd packages/collector && ${start("$R", { seed: true, entry: "src/index.ts" })}`, `${MK} && cd packages/collector && ${start("$R", { entry: "src/index.ts" })}`],
    ["literal root, relative entry", start(LIT, { seed: true }), start(LIT)],
    ["literal root, absolute entry", start(LIT, { seed: true, entry: ABS_ENTRY }), start(LIT, { entry: ABS_ENTRY })],
    ["literal root, no scratch flags", start(LIT, { seed: true, flags: false }), start(LIT, { flags: false })],
    ["literal root, absolute entry, no scratch flags", start(LIT, { seed: true, flags: false, entry: ABS_ENTRY }), start(LIT, { flags: false, entry: ABS_ENTRY })],
  ])("%s", (_name, seeded, plain) => {
    const v = shape(seeded);
    expect({ seeded, reserved: v.reserved, reason: v.reason }).toEqual({ seeded, reserved: false, reason: expect.not.stringMatching(/owner secrets|names Standup's data dir/) });
    expect({ seeded, verdict: bare(seeded) }).toEqual({ seeded, verdict: bare(plain) });
  }, 120_000);

  test.each([
    ["mktemp root", `${MK} && ${start("$R")}`],
    ["mktemp root, absolute entry", `${MK} && ${start("$R", { entry: ABS_ENTRY })}`],
    ["literal root", start(LIT)],
    ["literal root, absolute entry", start(LIT, { entry: ABS_ENTRY })],
  ])("the unseeded run with the scratch flags is allowed: %s", (_name, command) => {
    expect(shape(command)).toEqual({ action: "allow", category: null, reserved: false, reason: "" });
  }, 120_000);

  test("without the scratch flags, the seeded run is Persona's to decide: it may bind past loopback", () => {
    const command = `${MK} && ${start("$R", { seed: true, flags: false })}`;
    expect(shape(command)).toMatchObject({ action: "hold", category: "outward", reserved: false, reason: expect.stringContaining("without STANDUP_BIND_HOST=127.0.0.1") });
  }, 120_000);
});

describe("a token file the command fills from elsewhere, or doesn't fill itself, keeps the isolation spoiled", () => {
  const run = (r: string) => `env -i ${BUN_PATH} ${paths(r)} STANDUP_OWNER_TOKEN_FILE=${r}/data/secrets/owner.token ${PORTS} ${FLAGS} bun run ${ENTRY}`;
  test.each([
    ["a link to the real owner token", `${MK} && mkdir -p $R/home $R/tmux $R/data/secrets && ln -s ${TOKEN} $R/data/secrets/owner.token && ${run("$R")}`],
    ["a copy of the real owner token", `${MK} && mkdir -p $R/home $R/tmux $R/data/secrets && cp ${TOKEN} $R/data/secrets/owner.token && ${run("$R")}`],
    ["the real owner token's text", `${MK} && mkdir -p $R/home $R/tmux $R/data/secrets && cat ${TOKEN} > $R/data/secrets/owner.token && ${run("$R")}`],
  ])("%s is HIGH RISK", (_name, command) => {
    expect({ command, ...shape(command) }).toMatchObject({ command, action: "hold", reserved: true });
  }, 120_000);

  test("a token file written with text the floor can't read is held", () => {
    const command = `${MK} && mkdir -p $R/home $R/tmux $R/data/secrets && printf "$(cat /tmp/elsewhere)" > $R/data/secrets/owner.token && ${run("$R")}`;
    expect({ command, action: shape(command).action }).toEqual({ command, action: "hold" });
  }, 120_000);

  test("text the command writes to a file other than the token file, in a dir an isolation var names, still lapses the isolation", () => {
    const command = `${MK} && mkdir -p $R/home $R/tmux $R/data/secrets && printf x > $R/home/.profile && ${run("$R")}`;
    expect({ command, action: shape(command).action }).toEqual({ command, action: "hold" });
  }, 120_000);
});

describe("the owner's real secrets, the live DB and an unplaced root stay HIGH RISK", () => {
  test.each([
    ["the real owner token as the token file", `${MK} && ${start("$R", { token: `STANDUP_OWNER_TOKEN_FILE=${TOKEN}` })}`],
    ["the real owner token through $HOME", `${MK} && ${start("$R", { token: "STANDUP_OWNER_TOKEN_FILE=$HOME/.local/share/standup/secrets/owner.token" })}`],
    ["a chmod of the real owner token", `${MK} && chmod 600 ${TOKEN} && ${start("$R")}`],
    ["a write of the real owner token", `${MK} && printf tok > ${TOKEN} && ${start("$R")}`],
    ["a read of the real owner token", `${MK} && cp ${TOKEN} $R/tok && ${start("$R")}`],
    ["a token path that climbs from the worktree into the data dir", `${MK} && chmod 600 ../../../secrets/owner.token && ${start("$R")}`],
    ["the live DB as the DB path", `${MK} && ${start("$R", { seed: true }).replace("DB_PATH=$R/data/standup.db", `DB_PATH=${join(DATA, "standup.db")}`)}`],
  ])("%s", (_name, command) => {
    expect({ command, ...shape(command) }).toMatchObject({ command, action: "hold", reserved: true });
  }, 120_000);

  test.each([
    ["a root the command doesn't set", start("$R", { seed: true }), { ...WORKER_ENV, R: "/tmp/tmp.AbC123" }],
    ["a root in the data dir", `R=$(mktemp -d -p ${DATA}) && ${start("$R", { seed: true })}`, WORKER_ENV],
    ["the live ports", `${MK} && ${start("$R", { seed: true, ports: "PORT=7777 COLLECTOR_PORT=7777 WS_PORT=7778" })}`, WORKER_ENV],
  ])("%s is held", (_name, command, env) => {
    expect({ command, action: shape(command, env).action }).toEqual({ command, action: "hold" });
  }, 120_000);
});
