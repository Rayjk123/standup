import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, SCRATCH_COLLECTOR_ENV, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A completely isolated scratch collector started in the background, with the
 * steps a worker runs around it: a wait, a health check on the run's own
 * loopback port, a read of its log and a kill of `$!`. The collector's entry
 * is this checkout's real packages/collector/src/index.ts (and what it
 * imports), read as in false-holds-round-7-item11.test.ts; the machine
 * around the worktree is virtual.
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

const BASE_VIRTUAL: Record<string, string> = {
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

function probes(extra: Record<string, string> = {}, env: Record<string, string> = WORKER_ENV): Partial<FloorProbes> {
  const VIRTUAL: Record<string, string> = { ...BASE_VIRTUAL, ...extra };
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
    env: (name) => env[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = COLLECTOR, extra: Record<string, string> = {}, env: Record<string, string> = WORKER_ENV): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(extra, env));
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

/** The isolated start, backgrounded with its log under the root. */
function start(r = ISO, ports = PORTS): string {
  return `env -i PATH=/home/u/.bun/bin:/usr/bin:/bin ${paths(r)} ${ports} ${FLAGS} bun run src/index.ts > ${r}/c.log 2>&1 &`;
}

const MKTEMP = "R=$(mktemp -d -p /tmp x-XXXX)";

function verdict(command: string): { command: string; action: string; category: string | null; highRisk: boolean } {
  const v = bash(command);
  return { command, action: v.action, category: v.action === "hold" ? v.category : null, highRisk: v.action === "hold" && v.ownerReserved === true };
}

const allowed = (command: string) => ({ command, action: "allow", category: null, highRisk: false });

describe("a backgrounded isolated scratch collector with its own health check, log read and stop", () => {
  test("is allowed: curl on its own collector or ws port, sleep, cat or tail of its log, kill $!", () => {
    for (const command of [
      `${start()} sleep 3; curl -s http://127.0.0.1:29777/health`,
      `${start()} sleep 3; curl -sf http://localhost:29777/api/health; tail -n 50 ${ISO}/c.log; kill $!`,
      `${start()} sleep 2 && curl -fsS http://127.0.0.1:29777/health && cat ${ISO}/c.log`,
      `${start()} sleep 2; curl -f -s -S http://127.0.0.1:29778/; kill -TERM $!`,
      `${start()} sleep 2; curl -q -s http://[::1]:29777/health; kill %1`,
      `${MKTEMP}; mkdir -p $R/home $R/tmux; ${start("$R")} sleep 3; curl -s http://127.0.0.1:29777/health; cat $R/c.log; kill $!`,
    ]) {
      expect(verdict(command)).toEqual(allowed(command));
    }
  }, 240_000);
});

describe("steps beside an isolated scratch collector that still hold", () => {
  test("a curl to a live Standup port, another port or another host is held", () => {
    for (const url of ["http://127.0.0.1:7777/api/asks", "http://127.0.0.1:27777/health", "http://127.0.0.1:29999/health", "https://example.com/"]) {
      const command = `${start()} sleep 3; curl -s ${url}`;
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
  }, 240_000);

  test("a curl that writes, sends a body, reads a config or uses a socket spoils the isolation: held", () => {
    for (const curl of [
      `curl -s -o ${ISO}/home/.bunfig.toml http://127.0.0.1:29777/health`,
      `curl -s -d x=1 http://127.0.0.1:29777/api/x`,
      `curl -s -X POST http://127.0.0.1:29777/api/x`,
      `curl -s -K ${ISO}/curlrc http://127.0.0.1:29777/health`,
      `curl -s --unix-socket ${ISO}/s http://127.0.0.1:29777/health`,
      `curl -sO http://127.0.0.1:29777/health`,
      `curl -sL http://127.0.0.1:29777/health`,
      `CURL_HOME=${ISO} curl -s http://127.0.0.1:29777/health`,
      // Any option beyond the s/S/f bundles, or an operand beyond a plain path, is not a tending step.
      `curl -sf --max-time 5 http://localhost:29777/api/health`,
      `curl -fsS -o /dev/null http://127.0.0.1:29777/health`,
      `curl -s -w '%{http_code}' http://127.0.0.1:29777/health`,
      `curl -s -X GET http://127.0.0.1:29777/health`,
      `curl -s -H 'accept: application/json' http://127.0.0.1:29778/`,
      `curl -s -D ${ISO}/h http://127.0.0.1:29777/health`,
      `curl -s -c ${ISO}/j http://127.0.0.1:29777/health`,
      `curl -s --config ${ISO}/curlrc http://127.0.0.1:29777/health`,
      `curl -s --connect-timeout 2 http://[::1]:29777/health`,
      `curl -s --silent http://127.0.0.1:29777/health`,
      `curl -si http://127.0.0.1:29777/health`,
      `curl -fS http://127.0.0.1:29777/health`,
      `curl http://127.0.0.1:29777/health`,
      `curl -s http://127.0.0.1:29777/health?x=1`,
      `curl -s http://127.0.0.1:29777/h{a,b}`,
      `curl -s http://127.0.0.1:29777/health http://127.0.0.1:29777/x`,
      `curl -s -q http://127.0.0.1:29777/health`,
    ]) {
      const command = `${start()} sleep 3; ${curl}`;
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    }
    // An output written into the root may be configuration the run reads: what the isolation licensed holds as recorded.
    const written = `${start()} sleep 3; curl -s -o ${ISO}/home/.bunfig.toml http://127.0.0.1:29777/health`;
    expect(verdict(written)).toMatchObject({ command: written, action: "hold", highRisk: true });
  }, 240_000);

  test("a kill of a pid, a program that writes into the root, or code that links it to the live data is held", () => {
    const killed = `${start()} sleep 3; kill 4242`;
    expect({ command: killed, action: bash(killed).action }).toEqual({ command: killed, action: "hold" });
    for (const step of [`touch ${ISO}/home/.bunfig.toml`, `ln -s ${DATA} ${ISO}/xdg/data`]) {
      const command = `${start()} sleep 3; ${step}`;
      expect(verdict(command)).toMatchObject({ command, action: "hold", highRisk: true });
    }
    const linked = `${start()} sleep 1; python3 -c "import os; os.symlink('${DATA}', '${ISO}/xdg/data')"`;
    expect(verdict(linked)).toMatchObject({ command: linked, action: "hold", highRisk: true });
  }, 240_000);

  test("a start missing an off-network flag, on a live port or at the live data dir stays held beside a health check", () => {
    const curl = "sleep 3; curl -s http://127.0.0.1:29777/health";
    const flagless = `${start().replace("STANDUP_GATEWAY=0 ", "")} ${curl}`;
    expect(verdict(flagless)).toMatchObject({ command: flagless, action: "hold", category: "outward" });
    const live = `${start(ISO, "COLLECTOR_PORT=27777 WS_PORT=27778")} sleep 3; curl -s http://127.0.0.1:27777/health`;
    expect({ command: live, action: bash(live).action }).toEqual({ command: live, action: "hold" });
    const data = `${start().replace(`DB_PATH=${ISO}/db`, `DB_PATH=${DATA}/standup.db`)} ${curl}`;
    expect(verdict(data)).toMatchObject({ command: data, action: "hold", highRisk: true });
    const tmux = `${start().replace(`TMUX_TMPDIR=${ISO}/tmux `, "")} ${curl}`;
    expect(verdict(tmux)).toMatchObject({ command: tmux, action: "hold", category: "destructive" });
  }, 240_000);
});

describe("a health check beside an isolated scratch collector where curl may read a config file", () => {
  const curl = "sleep 3; curl -s http://127.0.0.1:29777/health";
  const xdg = join(HOME, "xdg");
  test("a .curlrc or curlrc in HOME, HOME/.config or XDG_CONFIG_HOME, or a CURL_HOME in the env, holds", () => {
    const cases: Array<[Record<string, string>, Record<string, string>]> = [
      [{ [join(HOME, ".curlrc")]: "output = x" }, WORKER_ENV],
      [{ [join(HOME, ".config", "curlrc")]: "output = x" }, WORKER_ENV],
      [{ [join(xdg, "curlrc")]: "output = x" }, { ...WORKER_ENV, XDG_CONFIG_HOME: xdg }],
      [{ [join(xdg, ".curlrc")]: "output = x" }, { ...WORKER_ENV, XDG_CONFIG_HOME: xdg }],
      [{}, { ...WORKER_ENV, CURL_HOME: join(HOME, "c") }],
    ];
    for (const [extra, env] of cases) {
      const command = `${start()} ${curl}`;
      const label = JSON.stringify({ extra, env: env.XDG_CONFIG_HOME ?? env.CURL_HOME ?? null });
      expect({ label, action: bash(command, COLLECTOR, extra, env).action }).toEqual({ label, action: "hold" });
    }
  }, 240_000);

  test("with -q first the config is not read: allowed", () => {
    const command = `${start()} sleep 3; curl -q -fsS http://127.0.0.1:29777/health`;
    expect({ command, action: bash(command, COLLECTOR, { [join(HOME, ".curlrc")]: "output = x" }).action }).toEqual({ command, action: "allow" });
  }, 120_000);
});

describe("an isolated scratch collector held for a program beside it", () => {
  test("is not high-risk floor-tamper when the floor read a complete isolation and nothing beside it writes", () => {
    const command = `${start()} sleep 3; curl -s http://127.0.0.1:29777/health | jq .ok`;
    const v = verdict(command);
    expect(v).toMatchObject({ command, action: "hold", highRisk: false });
    expect(v.category).not.toBe("floor-tamper");
  }, 120_000);
});
