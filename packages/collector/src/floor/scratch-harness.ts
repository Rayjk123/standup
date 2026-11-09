import { expect } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes, type GitTree } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A worker's isolated scratch Standup instance, as the scratch-instance
 * tests read it: a run under `env -i` with every dir Standup's code finds its
 * home, data, DB and owner token by under one fresh /tmp root. The worktree
 * sits under a fake data dir and reads through to this checkout, so the code
 * these runs load is the repository's real source (console-login.ts,
 * vite.scratch.config.ts, the collector, pipeline-screenshot.ts and the
 * topology module it imports). The worker's own env is the one a real worker
 * has: a PATH holding the install's node_modules/.bin dirs, and a TMPDIR in
 * the launch's scratch dir.
 */

export const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
export const HOME = join("/", "fake", "home");
export const DATA = join(HOME, ".local", "share", "standup");
export const ROOT = join(DATA, "worktrees", "standup", "feat-1");
export const COLLECTOR = join(ROOT, "packages", "collector");
export const WEB = join(ROOT, "packages", "web");
export const INSTALL = join("/", "fake", "install");
export const R = join("/", "tmp", "tmp.JTs4g6N8Y9");

export const config: FloorConfig = {
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
};

/** Files only the fake filesystem holds, by path (a test may add one and remove it after). */
export const VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
};

/** Dirs the scratch root holds before the run starts. */
export const SCRATCH_DIRS = ["home", "data", "config", "cache", "state", "tmp", "tmux", "knowledge", "internal", "data/secrets"].map((d) => join(R, d));

/** The install's node_modules/.bin dirs, each entry a link to an installed package's file. */
export const TOOL_BINS: Record<string, Record<string, string>> = {
  [join(INSTALL, "node_modules", ".bin")]: { tsc: join(INSTALL, "node_modules", "typescript", "bin", "tsc") },
  [join(INSTALL, "packages", "collector", "node_modules", ".bin")]: { tsc: join(INSTALL, "node_modules", "typescript", "bin", "tsc") },
};

/** Paths that are links, to where they lead (a test sets them, and clears them after each test). */
export const LINKS = new Map<string, string>();

/** Other worktrees under the fake data dir that read through to this checkout too (a test adds one and clears them after). */
export const MIRRORS = new Set<string>();

/** Dirs of the fake worktree whose files on disk the fake filesystem leaves out, so only VIRTUAL files show there (a test adds one and clears it after). */
export const SHADOWED = new Set<string>();

function real(p: string): string | null {
  for (const dir of SHADOWED) if (p.startsWith(`${dir}/`)) return null;
  for (const base of [ROOT, INSTALL, ...MIRRORS]) {
    if (p === base) return REPO;
    if (p.startsWith(`${base}/`)) return join(REPO, p.slice(base.length + 1));
  }
  return null;
}

let merged: GitTree | null = null;

/** `main` as though this checkout's tracked files, as they are on disk, were merged. */
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

/**
 * The PATH of a worker's own process, in the shape a real one has: bun puts
 * every ancestor's node_modules/.bin of the dir it runs a script from ahead
 * of the PATH it was started with, once for each `bun run` in the chain, so
 * it names dirs that don't exist (the install's packages/node_modules/.bin,
 * the install's parent's), and each install dir more than once.
 */
const ANCESTOR_BINS = [
  join(INSTALL, "packages", "collector", "node_modules", ".bin"),
  join(INSTALL, "packages", "collector", "node_modules", ".bin"),
  join(INSTALL, "packages", "node_modules", ".bin"),
  join(INSTALL, "node_modules", ".bin"),
  join("/", "fake", "node_modules", ".bin"),
  "/node_modules/.bin",
];
const ROOT_BINS = [join(INSTALL, "node_modules", ".bin"), join(INSTALL, "node_modules", ".bin"), join("/", "fake", "node_modules", ".bin"), "/node_modules/.bin"];
export const LIVE_PATH = [
  join(HOME, ".local", "bin"),
  ...ANCESTOR_BINS,
  ...ANCESTOR_BINS,
  ...ROOT_BINS,
  ...ROOT_BINS,
  join(HOME, ".bun", "bin"),
  join(HOME, ".local", "share", "mise", "installs", "node", "24.20.0", "bin"),
  join(HOME, ".local", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");
export const WORKER_ENV: Record<string, string> = { PATH: LIVE_PATH, HOME, TMPDIR: join(HOME, ".cache", "standup-scratch", "launch-1"), TMUX: "/tmp/tmux-1000/default,1,0" };

export function probes(): Partial<FloorProbes> {
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", R, ...SCRATCH_DIRS]);
  for (const f of Object.keys(VIRTUAL)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  for (const m of MIRRORS) dirs.delete(join(m, ".git"));
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const toolLinks = new Map<string, string>();
  for (const [dir, entries] of Object.entries(TOOL_BINS)) {
    dirs.add(dir);
    for (const [name, target] of Object.entries(entries)) toolLinks.set(join(dir, name), target);
  }
  const links = new Map([...toolLinks, ...LINKS]);
  const targets = new Set(links.values());
  const exists = (p: string) => p in VIRTUAL || dirs.has(bare(p)) || links.has(bare(p)) || targets.has(bare(p)) || (real(p) !== null && disk.exists(real(p)!));
  const isDirectory = (p: string) => !(p in VIRTUAL) && !links.has(bare(p)) && (dirs.has(bare(p)) || (real(p) !== null && disk.isDirectory(real(p)!)));
  const linked = (p: string): string | null => {
    for (const [from, to] of links) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
    return null;
  };
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
      if (p in TOOL_BINS) return Object.keys(TOOL_BINS[p]!);
      const virtual = Object.keys(VIRTUAL).concat([...dirs]).filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!);
      const onDisk = real(p) !== null && !SHADOWED.has(p) ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git") : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    realpath: (p) => linked(bare(p)) ?? (exists(p) ? bare(p) : null),
    lstat: (p) => {
      if (links.has(bare(p))) return { symlink: true, file: false, nlink: 1 };
      if (targets.has(bare(p))) return { symlink: false, file: true, nlink: 1 };
      if (p in VIRTUAL) return { symlink: false, file: true, nlink: 1 };
      if (dirs.has(bare(p))) return { symlink: false, file: false, nlink: 1 };
      return real(p) !== null ? disk.lstat(real(p)!) : null;
    },
    homeDir: () => HOME,
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: (dir, rev) => (dir === ROOT && rev === "main" ? mergedTree() : null),
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

export function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

/** The verdict, reduced to what a test asserts on. */
export function shape(v: FloorVerdict): { action: string; category?: string; reserved?: boolean; reason?: string } {
  return v.action === "allow" ? { action: "allow" } : { action: "hold", category: v.category, reserved: !!v.ownerReserved, reason: v.reason };
}

/** A hold of `command`: its category, whether it is owner-reserved (HIGH RISK), its reason and its scratch-instance marker. */
export function held(command: string, cwd = ROOT): { category: string; reserved: boolean; reason: string; scratch: unknown } {
  const v = bash(command, cwd);
  expect({ command, action: v.action }).toEqual({ command, action: "hold" });
  if (v.action !== "hold") throw new Error("unreachable");
  return { category: v.category, reserved: !!v.ownerReserved, reason: v.reason, scratch: v.scratch };
}

/** The scratch env a worker writes: `env -i` with every dir Standup's code reads under the root, and the worker's own PATH. */
export function scratchEnv(root = R, path = LIVE_PATH): string {
  return [
    `env -i PATH=${path}`,
    `HOME=${root}/home`,
    `XDG_DATA_HOME=${root}/data`,
    `XDG_CONFIG_HOME=${root}/config`,
    `XDG_CACHE_HOME=${root}/cache`,
    `XDG_STATE_HOME=${root}/state`,
    `TMPDIR=${root}/tmp`,
    `TMP=${root}/tmp`,
    `TEMP=${root}/tmp`,
    `DB_PATH=${root}/standup.db`,
    `STANDUP_SQLITE_PATH=${root}/standup.db`,
    `KNOWLEDGE_DIR=${root}/knowledge`,
    `STANDUP_INTERNAL_ROOT=${root}/internal`,
  ].join(" ");
}

export const ENV = scratchEnv();
export const TOKEN = `STANDUP_OWNER_TOKEN_FILE=${R}/data/secrets/owner.token`;
export const LOGIN = `${ENV} ${TOKEN} STANDUP_CONSOLE_ORIGIN=http://127.0.0.1:30743 bun scripts/console-login.ts`;
export const VITE = `${ENV} ${TOKEN} SCRATCH_API_PORT=30741 SCRATCH_WS_PORT=30742 SCRATCH_WEB_PORT=30743 bunx vite --config e2e/vite.scratch.config.ts`;
export const OFF_NET = "STANDUP_BIND_HOST=127.0.0.1 STANDUP_GATEWAY=0 STANDUP_PERSONA=0 STANDUP_REVIEW_TUNNELS=0 STANDUP_DIGEST=0";
export const COLLECTOR_RUN = (extra = `TMUX_TMPDIR=${R}/tmux`) => `${ENV} ${TOKEN} ${extra} COLLECTOR_PORT=30741 WS_PORT=30742 ${OFF_NET} bun run src/index.ts`;
export const TMUX_COLLECTOR = (extra?: string, socket = `-S ${R}/tmux.sock`) => `tmux ${socket} new-session -d -s scratch "${COLLECTOR_RUN(extra)}"`;
