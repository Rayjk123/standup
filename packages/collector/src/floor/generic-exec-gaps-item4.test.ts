import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * The worktree's shipped screenshot helper (scripts/pipeline-screenshot.ts)
 * imports packages/shared/src/topology.ts, whose default-port table names the
 * collector's ports. Run at a file:// page under /tmp or at a loopback page on
 * a port no Standup process binds, in each form a worker uses (flags before or
 * after the page, --record, `bun run`, a subdirectory as the start dir), that
 * mention is the port list the helper refuses and holds nothing. A page on a
 * live port, a file page that names one, a file page this command writes, or
 * a helper or module changed in the worktree still holds. The worktree and
 * the install read through to this checkout's real files; the rest of the
 * machine is virtual, with a worker-shaped PATH.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
const HELPER_SOURCE = readFileSync(join(REPO, "scripts", "pipeline-screenshot.ts"), "utf8");
const TOPOLOGY_SOURCE = readFileSync(join(REPO, "packages", "shared", "src", "topology.ts"), "utf8");
const PAGE = "<!doctype html>\n<html><head><style>body { font: 14px sans-serif; }</style></head><body><h1 class=\"t\">Mock</h1></body></html>\n";

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

const BASE_VIRTUAL: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "owner.token")]: "secret",
  "/tmp/x.html": PAGE,
  [join(SCRATCH, "x.html")]: PAGE,
};

const WORKER_ENV: Record<string, string> = {
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  TMPDIR: SCRATCH,
  TMP: SCRATCH,
  TEMP: SCRATCH,
  HOME,
  PATH: [
    join(ROOT, "node_modules", ".bin"),
    join(INSTALL, "node_modules", ".bin"),
    join(INSTALL, "packages", "node_modules", ".bin"),
    join(INSTALL, "packages", "collector", "node_modules", ".bin"),
    join(HOME, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":"),
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

function verdict(command: string, files: Record<string, string> = {}, cwd: string = ROOT): { command: string; action: string; reason: string } {
  const v: FloorVerdict = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(files));
  return { command, action: v.action, reason: v.action === "hold" ? v.reason : "" };
}

const allowed = (command: string) => ({ command, action: "allow", reason: "" });

describe("the worktree's shipped screenshot helper at a file:// or non-live loopback page is allowed", () => {
  const commands = [
    "bun scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png",
    "bun scripts/pipeline-screenshot.ts --out /tmp/x.png file:///tmp/x.html",
    "bun scripts/pipeline-screenshot.ts http://127.0.0.1:29777/x --out /tmp/x.png",
    "bun scripts/pipeline-screenshot.ts --out /tmp/x.png http://127.0.0.1:29777/x",
    "bun scripts/pipeline-screenshot.ts http://localhost:5174/ --out /tmp/x.png",
    "bun scripts/pipeline-screenshot.ts --record http://127.0.0.1:29777/ --out /tmp/x.webm",
    "bun scripts/pipeline-screenshot.ts --record file:///tmp/x.html --out /tmp/x.webm",
    "bun run scripts/pipeline-screenshot.ts http://127.0.0.1:29777/x --out /tmp/x.png",
    "bun run scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png",
    `bun ${ROOT}/scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png`,
    "cd packages/web && bun ../../scripts/pipeline-screenshot.ts http://127.0.0.1:29777/ --out /tmp/x.png",
    "cd packages/web && bun ../../scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png",
    `bun scripts/pipeline-screenshot.ts file://${SCRATCH}/x.html --out /tmp/x.png`,
    "cat > /tmp/z.html <<'EOF'\n<h1>hi</h1>\nEOF\nbun scripts/pipeline-screenshot.ts file:///tmp/z.html --out /tmp/x.png",
  ];
  for (const command of commands) {
    test(command, () => {
      expect(verdict(command)).toEqual(allowed(command));
    }, 60_000);
  }

  test("from a subdirectory start dir", () => {
    const command = "bun ../../scripts/pipeline-screenshot.ts http://127.0.0.1:29777/ --out /tmp/x.png";
    expect(verdict(command, {}, join(ROOT, "packages", "web"))).toEqual(allowed(command));
    const file = "bun ../../scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png";
    expect(verdict(file, {}, join(ROOT, "packages", "web"))).toEqual(allowed(file));
  }, 60_000);
});

describe("the screenshot helper still holds", () => {
  test("at a live collector or console port", () => {
    for (const command of [
      "bun scripts/pipeline-screenshot.ts http://127.0.0.1:17777/ --out /tmp/x.png",
      "bun scripts/pipeline-screenshot.ts --out /tmp/x.png http://127.0.0.1:17777/",
      "bun scripts/pipeline-screenshot.ts http://localhost:7777/ --out /tmp/x.png",
      "bun scripts/pipeline-screenshot.ts --record http://127.0.0.1:27778/ --out /tmp/x.webm",
      "bun run scripts/pipeline-screenshot.ts http://localhost:5173/ --out /tmp/x.png",
      "cd packages/web && bun ../../scripts/pipeline-screenshot.ts http://127.0.0.1:17777/ --out /tmp/x.png",
    ]) {
      expect({ command, action: verdict(command).action }).toEqual({ command, action: "hold" });
    }
  }, 60_000);

  test("at a file page that names a live port, or one the floor can't read", () => {
    const named = { "/tmp/y.html": '<script>fetch("http://127.0.0.1:17777/api/sessions", { method: "POST" })</script>\n' };
    expect(verdict("bun scripts/pipeline-screenshot.ts file:///tmp/y.html --out /tmp/x.png", named).action).toBe("hold");
    const encoded = { "/tmp/y.html": '<img src="http://localhost%3a5173/api/x">\n' };
    expect(verdict("bun scripts/pipeline-screenshot.ts file:///tmp/y.html --out /tmp/x.png", encoded).action).toBe("hold");
    expect(verdict("bun scripts/pipeline-screenshot.ts file:///tmp/missing.html --out /tmp/x.png").action).toBe("hold");
    expect(verdict("bun scripts/pipeline-screenshot.ts file:///tmp/x.html?a=1 --out /tmp/x.png").action).toBe("hold");
  }, 60_000);

  test("at a file page that can run or load anything, or that lies outside the temp dirs", () => {
    const run = "bun scripts/pipeline-screenshot.ts file:///tmp/y.html --out /tmp/x.png";
    for (const text of [
      '<script>fetch("http://127.0.0.1:" + (17000 + 777) + "/api/x")</script>\n',
      '<h1 onclick="fetch(1)">x</h1>\n',
      '<img src="http://localhost:5173/api/x">\n',
      "<style>body { background: url(http://localhost:5173/api/x); }</style>\n",
      "<style>body { background: image-set(\"http://localhost:5173/api/x\" 1x); }</style>\n",
      "<style>@import \"http://localhost:5173/api/x\";</style>\n",
      "<style>body { background: \\75 rl(http://localhost:5173/api/x); }</style>\n",
      '<meta http-equiv="refresh" content="0;url=http://localhost:5173/">\n',
      "<p>&#104;ttp://localhost:5173/</p>\n",
    ]) {
      expect({ text, action: verdict(run, { "/tmp/y.html": text }).action }).toEqual({ text, action: "hold" });
    }
    const inData = join(DATA, "page.html");
    expect(verdict(`bun scripts/pipeline-screenshot.ts file://${inData} --out /tmp/x.png`, { [inData]: PAGE }).action).toBe("hold");
    expect(verdict("bun scripts/pipeline-screenshot.ts file:///tmp/../fake/home/.local/share/standup/page.html --out /tmp/x.png", { [inData]: PAGE }).action).toBe("hold");
  }, 60_000);

  test("at a file page this command writes", () => {
    for (const command of [
      "cp /tmp/evil.html /tmp/x.html && bun scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png",
      "curl -so /tmp/x.html http://example.com/ ; bun scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png",
    ]) {
      expect({ command, action: verdict(command, { "/tmp/evil.html": '<script>fetch("http://127.0.0.1:17777/")</script>\n' }).action }).toEqual({ command, action: "hold" });
    }
  }, 60_000);

  test("the worktree's helper or topology.ts changed from the install's", () => {
    const command = "bun scripts/pipeline-screenshot.ts file:///tmp/x.html --out /tmp/x.png";
    const helper = verdict(command, { [join(ROOT, "scripts", "pipeline-screenshot.ts")]: `${HELPER_SOURCE}\n// local change\n` });
    expect(helper.action).toBe("hold");
    expect(helper.reason).toContain("topology.ts opens a connection on Standup's collector port");
    const topology = verdict(command, { [join(ROOT, "packages", "shared", "src", "topology.ts")]: `${TOPOLOGY_SOURCE}\n// local change\n` });
    expect(topology.action).toBe("hold");
    expect(topology.reason).toContain("topology.ts opens a connection on Standup's collector port");
  }, 60_000);

  test("a script other than the helper that imports the same module", () => {
    const command = "bun scripts/my-shot.ts file:///tmp/x.html --out /tmp/x.png";
    const v = verdict(command, { [join(ROOT, "scripts", "my-shot.ts")]: HELPER_SOURCE });
    expect(v.action).toBe("hold");
    expect(v.reason).toContain("topology.ts opens a connection on Standup's collector port");
  }, 60_000);
});
