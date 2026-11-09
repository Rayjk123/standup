import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The screenshot and recording helper (scripts/pipeline-screenshot.ts) run
 * from a worktree, or by the install's path with an --out the floor can't
 * place, at a page on a scratch port. The worktree and the install are this
 * checkout's real files, so the helper and what it imports
 * (packages/shared/src/topology.ts, whose default-port table names the
 * collector's ports) are read for real. The machine around them is virtual.
 * A page on a live Standup port, an unknown or remote page, or a helper or
 * module that isn't the install's as shipped still holds.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
const HELPER = join(INSTALL, "scripts", "pipeline-screenshot.ts");
const HELPER_SOURCE = readFileSync(join(REPO, "scripts", "pipeline-screenshot.ts"), "utf8");
const TOPOLOGY_SOURCE = readFileSync(join(REPO, "packages", "shared", "src", "topology.ts"), "utf8");
const MKTEMP = "R=$(mktemp -d -p /tmp rec-XXXX) &&";

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

/** `files` replace or add virtual files over the checkout's own. */
function probes(files: Record<string, string> = {}): Partial<FloorProbes> {
  const VIRTUAL = { ...BASE_VIRTUAL, ...files };
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", SCRATCH]);
  for (const f of [...Object.keys(BASE_VIRTUAL), SCRATCH]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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
      const onDisk = real(p) !== null ? (disk.listDir(real(p)!) ?? []).filter((n) => n !== ".git" && !n.startsWith(".env")) : [];
      return [...new Set([...virtual, ...onDisk])];
    },
    lstat: (p) => (exists(p) ? { symlink: false, file: !isDirectory(p), nlink: 1 } : null),
    realpath: (p) => (exists(p) ? bare(p) : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    env: (name) => WORKER_ENV[name],
    awsAccount: () => null,
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function verdict(command: string, files: Record<string, string> = {}): { command: string; action: string; reason: string } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(files));
  return { command, action: v.action, reason: v.action === "hold" ? v.reason : "" };
}

const allowed = (command: string) => ({ command, action: "allow", reason: "" });

/** The worktree's helper and the install's, by path, with an --out the floor can't place. */
const FORMS: Array<[string, (args: string) => string]> = [
  ["the worktree's helper", (args) => `bun scripts/pipeline-screenshot.ts ${args}`],
  ["the worktree's helper with a computed --out", (args) => `${MKTEMP} bun scripts/pipeline-screenshot.ts ${args.replace(/--out \S+\/(\w+\.\w+)/, "--out $R/$1")}`],
  ["the install's helper with a computed --out", (args) => `${MKTEMP} bun ${HELPER} ${args.replace(/--out \S+\/(\w+\.\w+)/, "--out $R/$1")}`],
  ["the worktree's helper through bun run", (args) => `bun run scripts/pipeline-screenshot.ts ${args}`],
];

describe("the screenshot helper at scratch pages is allowed", () => {
  const ARGS = [
    "--record http://localhost:29780/ --cold --out /tmp/rec-1/x.webm",
    "http://localhost:29780/ --out /tmp/standup-screenshots-1/x.png",
    "http://127.0.0.1:29780/ --out /tmp/standup-screenshots-1/x.png --full-page --width 1440 --wait-for '#app'",
    "http://[::1]:29780/ --out /tmp/standup-screenshots-1/x.png",
    `--record http://localhost:29780/ --cold --login-url http://127.0.0.1:29780/login --preset persona --mark "first row=.row" --until ".ready" --duration-ms 4000 --out /tmp/rec-1/x.webm`,
    "http://localhost:29780/runs/a-1/view.html --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:29780 --out /tmp/standup-screenshots-1/x.png",
    // A data: page the floor reads in full that names no live port: it is the call's own text.
    `"data:text/html,<h1>hi</h1>" --out /tmp/standup-screenshots-1/x.png`,
  ];
  for (const [form, command] of FORMS) {
    test(form, () => {
      for (const args of ARGS) expect(verdict(command(args))).toEqual(allowed(command(args)));
    }, 120_000);
  }
});

describe("the screenshot helper at a page it may not reach still holds", () => {
  const ARGS = [
    // A live port: the public collector and WS ports, a slot port, the console's and vite's.
    "--record http://localhost:7777/ --cold --out /tmp/rec-1/x.webm",
    "http://127.0.0.1:7778/ --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:27777/ --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:5173/ --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:15173/ --out /tmp/standup-screenshots-1/x.png",
    "http://[::1]:17778/ --out /tmp/standup-screenshots-1/x.png",
    // --login-url on a live port beside a scratch page.
    "--record http://localhost:29780/ --login-url http://localhost:7777/login --out /tmp/rec-1/x.webm",
    // A second page on a live port.
    "http://localhost:29780/ http://localhost:7777/ --out /tmp/standup-screenshots-1/x.png",
    // A value naming a live port.
    `--record http://localhost:29780/ --mark "x=http://localhost:7777/" --out /tmp/rec-1/x.webm`,
    // A page the floor can't read, one that doesn't parse, a remote host.
    "$PAGE --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:abc/ --out /tmp/standup-screenshots-1/x.png",
    "http://example.com:29780/ --out /tmp/standup-screenshots-1/x.png",
    // A data: page the floor can't read (base64) or that names a live port, a file: page the floor can't read, and any other scheme: javascript:, https:.
    `"data:text/html;base64,PGgxPmhpPC9oMT4=" --out /tmp/standup-screenshots-1/x.png`,
    `"data:text/html,<img src=http://localhost:7777/api/x>" --out /tmp/standup-screenshots-1/x.png`,
    `"data:text/html,<img src=http://localhost%3a7777/api/x>" --out /tmp/standup-screenshots-1/x.png`,
    "file:///tmp/x.html --out /tmp/standup-screenshots-1/x.png",
    `"javascript:alert(1)" --out /tmp/standup-screenshots-1/x.png`,
    "https://localhost:29780/ --out /tmp/standup-screenshots-1/x.png",
    // A query, fragment, userinfo, percent-escape, a port with a leading zero or none at all.
    `"http://localhost:29780/?next=x" --out /tmp/standup-screenshots-1/x.png`,
    `"http://localhost:29780/#x" --out /tmp/standup-screenshots-1/x.png`,
    "http://u@localhost:29780/ --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:29780/%2e%2e/x --out /tmp/standup-screenshots-1/x.png",
    "http://localhost:029780/ --out /tmp/standup-screenshots-1/x.png",
    "http://localhost/ --out /tmp/standup-screenshots-1/x.png",
    "http://LOCALHOST:29780/ --out /tmp/standup-screenshots-1/x.png",
    // A flag value the floor can't read.
    `--record http://localhost:29780/ --mark "$(cat /tmp/m)" --out /tmp/rec-1/x.webm`,
    `http://localhost:29780/ --wait-for "$(cat /tmp/sel)" --out /tmp/standup-screenshots-1/x.png`,
    // A flag the helper doesn't know.
    "http://localhost:29780/ --login-url http://localhost:29780/ --out /tmp/standup-screenshots-1/x.png",
  ];
  for (const [form, command] of FORMS.filter(([form]) => form.startsWith("the worktree's"))) {
    test(form, () => {
      for (const args of ARGS) expect({ command: command(args), action: verdict(command(args)).action }).toEqual({ command: command(args), action: "hold" });
    }, 120_000);
  }

  test("the install's helper at a collector port", () => {
    const [, command] = FORMS.find(([form]) => form.startsWith("the install's"))!;
    for (const args of ARGS.slice(0, 3)) expect({ command: command(args), action: verdict(command(args)).action }).toEqual({ command: command(args), action: "hold" });
  }, 60_000);

  test("a script other than the helper that imports the same module", () => {
    const copy = join(ROOT, "scripts", "my-shot.ts");
    const command = "bun scripts/my-shot.ts http://localhost:29780/ --out /tmp/standup-screenshots-1/x.png";
    const v = verdict(command, { [copy]: HELPER_SOURCE });
    expect(v.action).toBe("hold");
    expect(v.reason).toContain("topology.ts opens a connection on Standup's collector port");
  }, 60_000);

  test("the worktree's helper changed from the install's", () => {
    const command = "bun scripts/pipeline-screenshot.ts http://localhost:29780/ --out /tmp/standup-screenshots-1/x.png";
    const v = verdict(command, { [join(ROOT, "scripts", "pipeline-screenshot.ts")]: `${HELPER_SOURCE}\n// local change\n` });
    expect(v.action).toBe("hold");
    expect(v.reason).toContain("topology.ts opens a connection on Standup's collector port");
  }, 60_000);

  test("the worktree's topology.ts changed from the install's", () => {
    const command = "bun scripts/pipeline-screenshot.ts http://localhost:29780/ --out /tmp/standup-screenshots-1/x.png";
    const v = verdict(command, { [join(ROOT, "packages", "shared", "src", "topology.ts")]: `${TOPOLOGY_SOURCE}\n// local change\n` });
    expect(v.action).toBe("hold");
    expect(v.reason).toContain("topology.ts opens a connection on Standup's collector port");
  }, 60_000);

  test("the helper's --out into the install", () => {
    for (const command of [
      `bun ${HELPER} --record http://localhost:29780/ --out ${INSTALL}/scripts/x.webm`,
      `bun scripts/pipeline-screenshot.ts --record http://localhost:29780/ --out ${INSTALL}/x.webm`,
    ]) {
      expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
    }
  }, 60_000);
});
