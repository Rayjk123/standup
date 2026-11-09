import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The install's screenshot and recording helper (scripts/pipeline-screenshot.ts)
 * run the way the worker instructions spell it: by the install's absolute
 * path (or from the install, or the worktree's own copy), at a local page,
 * with the capture going to the helper's per-user dir under /tmp (which may
 * not exist yet), elsewhere in /tmp, the launch's own scratch dir or the
 * worktree, or the launch's review scratch dir. The worktree and the install
 * read through to this checkout's real files; the rest of the machine is
 * virtual. Captures aimed at the install, the data dir, the Playwright
 * toolchain, another launch's scratch dir or a glob, a helper replaced
 * before it runs, and a toolchain redirected through the environment still
 * hold.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const LAUNCH = "11111111-2222-3333-4444-555555555555";
const SCRATCH = join(SCRATCH_ROOT, LAUNCH);
const OTHER_SCRATCH = join(SCRATCH_ROOT, "99999999-2222-3333-4444-555555555555");
const HELPER = join(INSTALL, "scripts", "pipeline-screenshot.ts");
const UID = typeof process.getuid === "function" ? process.getuid() : -1;
const SHOTS = `/tmp/standup-screenshots-${UID}`;

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:7777",
  launchId: LAUNCH,
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "worker-tokens"), join(DATA, "review-media"), join(DATA, "review-scratch"), SCRATCH_ROOT],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp", "/var/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  scratchDir: SCRATCH,
  scratchRoot: SCRATCH_ROOT,
};

const BASE_VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
  [join(OTHER_SCRATCH, "prompt.md")]: "# other launch\n",
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

/** `files` replace or add virtual files over the checkout's own; `dirs` add virtual dirs. */
function probes(files: Record<string, string> = {}, extraDirs: string[] = []): Partial<FloorProbes> {
  const VIRTUAL = { ...BASE_VIRTUAL, ...files };
  const disk = defaultProbes();
  const dirs = new Set<string>(["/", "/tmp", SCRATCH, ...extraDirs]);
  for (const f of [...Object.keys(VIRTUAL), SCRATCH, ...extraDirs]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
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

function verdict(command: string, files: Record<string, string> = {}, dirs: string[] = []): { command: string; action: string; reason: string } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(files, dirs));
  return { command, action: v.action, reason: v.action === "hold" ? v.reason : "" };
}

const allowed = (command: string) => ({ command, action: "allow", reason: "" });

const PAGE = "http://localhost:29780/";
/** Code that rewrites the floor in the install, planted where Bun or the helper would load it. */
const EVIL = `import { writeFileSync } from "fs";\nwriteFileSync("${INSTALL}/packages/collector/src/floor/classify.ts", "");\n`;
const RECORD = `--record ${PAGE} --cold --login-url ${PAGE}login --preset persona --mark "first row=.row"`;

describe("the install's screenshot helper as the worker instructions spell it is allowed", () => {
  const COMMANDS = [
    // Into the per-user dir, which doesn't exist yet.
    `bun ${HELPER} ${PAGE} --out ${SHOTS}/home.png`,
    `bun ${HELPER} ${PAGE}`,
    `bun ${HELPER} --record ${PAGE}`,
    `mkdir -p ${SHOTS} && bun ${HELPER} ${PAGE} --out ${SHOTS}/home.png`,
    `mkdir -p ${SHOTS}/run-1 && bun ${HELPER} ${PAGE} --out ${SHOTS}/run-1/home.png`,
    // Elsewhere in /tmp, the launch's scratch dir, the worktree.
    `bun ${HELPER} ${PAGE} --out /tmp/x.png`,
    `bun ${HELPER} ${PAGE} --out /tmp/shots/x.png`,
    `bun ${HELPER} ${PAGE} --out ${SCRATCH}/x.png`,
    `bun ${HELPER} ${RECORD} --out ${SCRATCH}/review/demo.webm`,
    `bun ${HELPER} ${RECORD} --out ${ROOT}/demo.webm`,
    `bun ${HELPER} --record ${PAGE} --cold --preset persona --out ${SCRATCH}/demo.webm`,
    `bun ${HELPER} --record ${PAGE} --cold --out ${SCRATCH}/demo.webm`,
    // Through $TMPDIR, the launch's scratch dir.
    `bun ${HELPER} ${PAGE} --out $TMPDIR/x.png`,
    `bun ${HELPER} ${PAGE} --out "$TMPDIR/x.png"`,
    `bun ${HELPER} ${RECORD} --out "\${TMPDIR}/demo.webm"`,
    // From the worktree, from the install.
    `cd ${ROOT} && bun ${HELPER} http://localhost:29780/ --out /tmp/x.png`,
    `cd ${INSTALL} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/x.png`,
    // Other local pages, with queries and hashes, and the helper's sizing flags.
    `bun ${HELPER} http://127.0.0.1:29780/runs/a-1 --out ${SHOTS}/a.png`,
    `bun ${HELPER} "http://127.0.0.1:29780/?tab=docs#top" --out ${SHOTS}/a.png`,
    `bun ${HELPER} 'http://localhost:29780/view?id=3&x=1' --out /tmp/a.png`,
    `bun ${HELPER} http://[::1]:29780/ --out /tmp/a.png`,
    `bun ${HELPER} "data:text/html,<h1>hi</h1>" --out ${SHOTS}/a.png`,
    `bun ${HELPER} ${PAGE} --width 1440 --height 900 --full-page --wait-for "#app" --wait-ms 500 --out ${SHOTS}/a.png`,
  ];
  for (const command of COMMANDS) test(command, () => expect(verdict(command)).toEqual(allowed(command)), 60_000);
});

describe("the helper over an earlier capture, into the review scratch dir, beside readers, and from other dirs is allowed", () => {
  const COMMANDS: Array<[string, Record<string, string>?, string[]?]> = [
    // The launch's review scratch dir, made by the collector or not yet.
    [`bun ${HELPER} ${RECORD} --out ${DATA}/review-scratch/${LAUNCH}/demo.webm`, {}, [`${DATA}/review-scratch/${LAUNCH}`]],
    [`bun ${HELPER} ${RECORD} --out ${DATA}/review-scratch/${LAUNCH}/demo.webm`],
    [`bun ${HELPER} ${RECORD} --out ${DATA}/review-scratch/${LAUNCH}/demo.webm`, { [`${DATA}/review-scratch/${LAUNCH}/demo.webm`]: "x" }],
    [`bun ${HELPER} ${PAGE} --out ${DATA}/review-scratch/${LAUNCH}/a.png`, {}, [`${DATA}/review-scratch/${LAUNCH}`]],
    [`mkdir -p ${DATA}/review-scratch/${LAUNCH} && bun ${HELPER} ${RECORD} --out ${DATA}/review-scratch/${LAUNCH}/demo.webm`],
    [`bun scripts/pipeline-screenshot.ts ${RECORD} --out ${DATA}/review-scratch/${LAUNCH}/demo.webm`, {}, [`${DATA}/review-scratch/${LAUNCH}`]],
    [`cd /tmp && bun ${HELPER} ${PAGE} --out /tmp/x.png`],
    [`cd ${SCRATCH} && bun ${HELPER} ${PAGE} --out /tmp/x.png`],
    // Over a capture an earlier run left.
    [`bun ${HELPER} ${PAGE} --out ${SHOTS}/home.png`, { [`${SHOTS}/home.png`]: "png" }],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png`, { ["/tmp/x.png"]: "png" }],
    [`bun ${HELPER} ${PAGE}`, { [`${SHOTS}/screenshot.png`]: "png" }],
    [`bun ${HELPER} ${PAGE} --out ${SCRATCH}/x.png`, { [`${SCRATCH}/x.png`]: "png" }],
    [`bun ${HELPER} ${PAGE} --out $TMPDIR/x.png`, { [`${SCRATCH}/x.png`]: "png" }],
    // The console's vite port; the helper refuses the collector's own ports itself.
    [`bun ${HELPER} http://localhost:5173/ --out /tmp/x.png`],
    [`cd ${ROOT} && bun ${HELPER} http://localhost:5173/ --out /tmp/x.png`],
    [`bun ${HELPER} http://localhost:5173/docs?x=1#y --out /tmp/x.png`],
    [`bun ${HELPER} http://127.0.0.1:5173/ --out /tmp/x.png`],
    [`bun ${HELPER} --record http://localhost:5173/ --cold --login-url http://localhost:5173/login --preset persona --out ${SCRATCH}/x.webm`],
    // Readers and timeouts around it, flags in another order, the out in a variable or made by mktemp.
    [`timeout 60 bun ${HELPER} ${PAGE} --out /tmp/x.png`],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png 2>&1 | tail -5`],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png && ls -la /tmp/x.png`],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png; echo done`],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png > /tmp/shot.log 2>&1`],
    [`bun ${HELPER} ${PAGE} --out /tmp/x.png 2>&1`],
    [`bun ${HELPER} --out /tmp/x.png ${PAGE}`],
    [`bun run ${HELPER} ${PAGE} --out /tmp/x.png`],
    [`OUT=/tmp/x.png; bun ${HELPER} ${PAGE} --out $OUT`],
    [`D=$(mktemp -d) && bun ${HELPER} ${PAGE} --out $D/x.png`],
    [`mkdir -p /tmp/standup-screenshots-$(id -u) && bun ${HELPER} ${PAGE} --out /tmp/standup-screenshots-$(id -u)/x.png`],
  ];
  for (const [command, files, dirs] of COMMANDS) test(command, () => expect(verdict(command, files, dirs)).toEqual(allowed(command)), 60_000);
});

describe("the worktree's own copy of the helper, as shipped, at a scratch page", () => {
  const COMMANDS = [
    `cd ${ROOT} && bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/x.png`,
    `bun ${ROOT}/scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/x.png`,
    `bun scripts/pipeline-screenshot.ts ${PAGE}`,
    `bun scripts/pipeline-screenshot.ts ${PAGE} --out $TMPDIR/x.png`,
    `bun scripts/pipeline-screenshot.ts ${PAGE} --out /tmp/x.png`,
    `bun scripts/pipeline-screenshot.ts ${PAGE} --out ${SHOTS}/x.png`,
    `mkdir -p ${SHOTS} && bun scripts/pipeline-screenshot.ts ${PAGE} --out ${SHOTS}/x.png`,
    `bun scripts/pipeline-screenshot.ts ${PAGE} --out ${SCRATCH}/x.png`,
    `bun scripts/pipeline-screenshot.ts ${RECORD} --out ${SCRATCH}/demo.webm`,
  ];
  for (const command of COMMANDS) test(command, () => expect(verdict(command)).toEqual(allowed(command)), 60_000);
});

describe("the helper aimed at protected ground still holds", () => {
  const COMMANDS = [
    `bun ${HELPER} ${PAGE} --out ${INSTALL}/x.png`,
    `bun ${HELPER} ${PAGE} --out ${INSTALL}/scripts/x.png`,
    `bun ${HELPER} ${PAGE} --out ${DATA}/x.png`,
    `bun ${HELPER} ${PAGE} --out ${DATA}/secrets/x.png`,
    `bun ${HELPER} ${PAGE} --out ${HOME}/.cache/ms-playwright/x.png`,
    `bun ${HELPER} ${PAGE} --out ${HOME}/.cache/standup/playwright/x.png`,
    `bun ${HELPER} ${PAGE} --out ${OTHER_SCRATCH}/x.png`,
    `bun ${HELPER} ${PAGE} --out ${INSTALL}/scripts/*.png`,
    `mkdir -p ${SHOTS} && bun ${HELPER} ${PAGE} --out ${INSTALL}/x.png`,
    `cd ${INSTALL} && bun ${HELPER} ${PAGE} --out x.png`,
  ];
  for (const command of COMMANDS) test(command, () => expect(verdict(command).action).toBe("hold"), 60_000);
});

describe("the helper replaced before it runs, or pointed at a planted toolchain, still holds", () => {
  const COMMANDS: Array<[string, Record<string, string>?]> = [
    [`cp /tmp/evil.ts ${INSTALL}/scripts/pipeline-screenshot.ts && bun ${HELPER} ${PAGE} --out /tmp/x.png`],
    [`STANDUP_PLAYWRIGHT_DIR=/tmp/pw bun ${HELPER} ${PAGE} --out /tmp/x.png`, { [join("/tmp", "pw", "node_modules", "playwright", "index.js")]: EVIL }],
  ];
  for (const [command, files] of COMMANDS) test(command, () => expect(verdict(command, files).action).toBe("hold"), 60_000);
});
