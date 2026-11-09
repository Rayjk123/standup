import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A script the floor runs directly (not a file a test runner executes) that
 * removes a tree at a path climbing out of where it starts: the script's own
 * dir, the cwd or the temp dir, by `..` or a dirname of a dir
 * (`rmSync(join(import.meta.dir, ".."), { recursive: true })`,
 * `shutil.rmtree(os.path.dirname(os.path.dirname(__file__)))`). Run from
 * the launch's scratch dir that is the scratch root with every launch's dir
 * in it; from the worktree, its parent. The climbed-to path is read where
 * the floor can place it (the worktree's own `scripts/../dist` stays the
 * worker's) and held as a delete the floor can't place where it can't.
 * Deletes under the script's dir, the temp dir or a fresh temp dir, and
 * single-file unlinks, stay allowed.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  worktreeRoots: [join(DATA, "worktrees")],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), SCRATCH],
  tmpDirs: ["/tmp", OWN_SCRATCH],
  scratchRoot: SCRATCH,
  scratchDir: OWN_SCRATCH,
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: "{}\n",
  [join(ROOT, "dist", "a.js")]: "x\n",
  [join(ROOT, "scripts", "out", "a.json")]: "{}\n",
  [join(OWN_SCRATCH, "notes.md")]: "# notes\n",
  [join(SCRATCH, "launch-2", "prompt.md")]: "# other launch\n",
  ["/tmp/x/a"]: "a\n",
};

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** Runs `command` from `cwd` with `source` written at `path`. */
function run(command: string, path: string, source: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes({ ...FILES, [path]: source }));
}

const TS = 'import { rmSync, unlinkSync, mkdtempSync, rmdirSync } from "fs";\nimport { join, resolve, dirname } from "path";\nimport { tmpdir } from "os";\n';
const CJS = 'const fs = require("fs");\nconst path = require("path");\n';
const PY = "import os, shutil\nfrom pathlib import Path\n";

/** A TS script at `path`, run with bun. */
function ts(body: string, path = join(ROOT, "x.ts"), cwd = ROOT): FloorVerdict {
  return run(`bun ${path}`, path, `${TS}${body}\n`, cwd);
}

function js(body: string, path = join(ROOT, "x.js")): FloorVerdict {
  return run(`node ${path}`, path, `${CJS}${body}\n`);
}

function py(body: string, path = join(ROOT, "x.py")): FloorVerdict {
  return run(`python3 ${path}`, path, `${PY}${body}\n`);
}

const OWN = join(OWN_SCRATCH, "x.ts");

/*
 * Where the floor knows where the path starts, the delete is read as the one
 * it lands on, as `rm -rf` of that path is: the scratch root holds every
 * launch's dir and the workers' tmux sockets (floor-tamper), and this
 * fixture's worktrees sit under Standup's data dir (standup-ops). Where it
 * doesn't (the temp dir the run inherits, a template), it is a delete of a
 * path the floor can't place (destructive).
 */
const SCRATCH_ROOT = "floor-tamper";
const WORKTREES = "standup-ops";
const UNPLACED = "destructive";

describe("a script that removes a tree above where it starts", () => {
  test.each([
    ['rmSync(join(import.meta.dir, ".."), { recursive: true, force: true });', OWN, SCRATCH_ROOT],
    ['rmSync(join(import.meta.dir, ".."), { recursive: true, force: true });', join(ROOT, "x.ts"), WORKTREES],
    ['rmSync(join(import.meta.dir, "../.."), { recursive: true });', join(ROOT, "scripts", "x.ts"), WORKTREES],
    ['rmSync(join(import.meta.dir, "x", "..", ".."), { recursive: true });', OWN, SCRATCH_ROOT],
    ['rmSync(resolve(import.meta.dir, ".."), { recursive: true });', OWN, SCRATCH_ROOT],
    ['rmSync(import.meta.dir + "/..", { recursive: true });', OWN, SCRATCH_ROOT],
    ['rmSync(`${import.meta.dir}/..`, { recursive: true });', OWN, UNPLACED],
    ['rmSync(dirname(import.meta.dir), { recursive: true, force: true });', OWN, SCRATCH_ROOT],
    ['rmSync(dirname(dirname(import.meta.path)), { recursive: true });', OWN, SCRATCH_ROOT],
    ['const root = join(import.meta.dir, "..");\nrmSync(root, { recursive: true, force: true });', OWN, SCRATCH_ROOT],
    ['const up = dirname(import.meta.dir);\nconst dir = up;\nrmSync(dir, { recursive: true });', OWN, SCRATCH_ROOT],
    ['rmSync(process.env.TMPDIR + "/..", { recursive: true });', OWN, UNPLACED],
    ['rmSync(join(process.env.TMPDIR!, ".."), { recursive: true, force: true });', OWN, UNPLACED],
    ['rmSync(join(tmpdir(), ".."), { recursive: true });', OWN, UNPLACED],
    ['rmSync(dirname(tmpdir()), { recursive: true });', OWN, UNPLACED],
    ['rmSync(join(process.cwd(), ".."), { recursive: true });', OWN, WORKTREES],
    ['rmSync(resolve(".."), { recursive: true });', OWN, WORKTREES],
    ['rmSync("..", { recursive: true });', OWN, WORKTREES],
    ['rmdirSync(join(import.meta.dir, ".."), { recursive: true });', OWN, SCRATCH_ROOT],
    ['rmSync(join(someDir(), ".."), { recursive: true });', OWN, UNPLACED],
    ['rmSync(`${tmpdir()}/..`, { recursive: true });', OWN, UNPLACED],
    ['const up = `${import.meta.dir}/..`;\nrmSync(up, { recursive: true });', OWN, UNPLACED],
    ['const opts = { recursive: true };\nrmSync(join(import.meta.dir, ".."), opts);', OWN, SCRATCH_ROOT],
    ['rmSync(import.meta.dir + "-old", { recursive: true });', join(ROOT, "x.ts"), WORKTREES],
  ])("%p in %p holds as %p", (body, path, category) => {
    expect(ts(body, path)).toMatchObject({ action: "hold", category });
  });

  test("the temp dir the run sets is where the climb starts", () => {
    const path = join(ROOT, "x.ts");
    const source = `${TS}rmSync(join(process.env.TMPDIR!, ".."), { recursive: true, force: true });\n`;
    expect(run(`TMPDIR=${OWN_SCRATCH} bun ${path}`, path, source)).toMatchObject({ action: "hold", category: SCRATCH_ROOT });
  });

  test.each([
    ['fs.rm(path.dirname(__dirname), { recursive: true }, () => {});', SCRATCH_ROOT],
    ['fs.rmSync(path.join(__dirname, ".."), { recursive: true, force: true });', SCRATCH_ROOT],
    ['fs.rmSync(path.resolve(__dirname, "..", ".."), { recursive: true });', SCRATCH_ROOT],
    ['const p = path.dirname(path.dirname(__filename));\nfs.rmSync(p, { recursive: true });', SCRATCH_ROOT],
    ['fs.promises.rm(path.join(process.env.TMPDIR, ".."), { recursive: true });', UNPLACED],
    ['require("fs").rmSync(require("path").join(__dirname, ".."), { recursive: true });', SCRATCH_ROOT],
  ])("node %p holds as %p", (body, category) => {
    expect(js(body, join(OWN_SCRATCH, "x.js"))).toMatchObject({ action: "hold", category });
  });

  test.each([
    ["shutil.rmtree(os.path.dirname(os.path.dirname(__file__)))", SCRATCH_ROOT],
    ["shutil.rmtree(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))", SCRATCH_ROOT],
    ['shutil.rmtree(os.path.join(os.path.dirname(__file__), ".."))', SCRATCH_ROOT],
    ["shutil.rmtree(Path(__file__).resolve().parent.parent)", SCRATCH_ROOT],
    ["shutil.rmtree(Path(__file__).parent.parent, ignore_errors=True)", SCRATCH_ROOT],
    ['shutil.rmtree(Path(__file__).parent / "..")', SCRATCH_ROOT],
    ['shutil.rmtree(os.path.join(os.environ["TMPDIR"], ".."))', UNPLACED],
    ['shutil.rmtree(os.path.join(os.getenv("TMPDIR"), ".."))', UNPLACED],
    ["root = os.path.dirname(os.path.dirname(__file__))\nshutil.rmtree(root)", SCRATCH_ROOT],
    ['shutil.rmtree(Path(__file__).parent.joinpath(".."))', SCRATCH_ROOT],
    ['shutil.rmtree(os.path.join(tempfile.gettempdir(), ".."))', UNPLACED],
  ])("python %p holds as %p", (body, category) => {
    expect(py(body, join(OWN_SCRATCH, "x.py"))).toMatchObject({ action: "hold", category });
  });

  test("inline code, whose own dir the floor doesn't place", () => {
    expect(run(`node -e 'require("fs").rmSync(require("path").join(__dirname, ".."), { recursive: true })'`, join(ROOT, "unused"), "")).toMatchObject({ action: "hold" });
  });
});

describe("deletes that stay where the script starts", () => {
  test.each([
    ['rmSync(join(import.meta.dir, "out"), { recursive: true });', join(ROOT, "scripts", "x.ts")],
    ['rmSync(join(import.meta.dir, "out"), { recursive: true, force: true });', OWN],
    ['rmSync(join(process.env.TMPDIR!, "x"), { recursive: true, force: true });', OWN],
    ['rmSync(join(process.env.TMPDIR!, "x"), { recursive: true, force: true });', join(ROOT, "x.ts")],
    ['rmSync(mkdtempSync(join(tmpdir(), "x-")), { recursive: true });', OWN],
    ['const d = mkdtempSync(join(tmpdir(), "x-"));\nrmSync(d, { recursive: true, force: true });', join(ROOT, "x.ts")],
    ['rmSync("/tmp/x", { recursive: true, force: true });', join(ROOT, "x.ts")],
    [`rmSync("${ROOT}/dist", { recursive: true, force: true });`, join(ROOT, "x.ts")],
    ['rmSync("dist", { recursive: true, force: true });', join(ROOT, "x.ts")],
    ['unlinkSync(join(import.meta.dir, "out.json"));', join(ROOT, "x.ts")],
    ['unlinkSync(join(import.meta.dir, "..", "out.json"));', join(ROOT, "scripts", "x.ts")],
    ['rmSync(join(import.meta.dir, "..", "out.json"), { force: true });', join(ROOT, "scripts", "x.ts")],
    ['rmSync(join(import.meta.dir, "..", "dist"), { recursive: true, force: true });', join(ROOT, "scripts", "x.ts")],
    ['rmSync(resolve(import.meta.dir, "../dist"), { recursive: true });', join(ROOT, "scripts", "x.ts")],
    ['const root = join(import.meta.dir, "..");\nrmSync(join(root, "dist"), { recursive: true, force: true });', join(ROOT, "scripts", "x.ts")],
    ['rmSync(join(dirname(import.meta.path), "out"), { recursive: true });', OWN],
    ['const out = join(import.meta.dir, "out");\nrmSync(out, { recursive: true, force: true });', OWN],
    ['function clean(dir: string) { rmSync(dir, { recursive: true, force: true }); }\nclean(join(import.meta.dir, "out"));', OWN],
    ['const [a, b] = ["x", ".."];\nconsole.log(join(a, b));\nrmSync(join(import.meta.dir, "out"), { recursive: true });', OWN],
  ])("%p in %p is allowed", (body, path) => {
    expect(ts(body, path)).toEqual({ action: "allow" });
  });

  test("a climb that comes back down under the temp dir the run sets", () => {
    const path = join(ROOT, "x.ts");
    const source = `${TS}rmSync(join(process.env.TMPDIR!, "..", "x"), { recursive: true, force: true });\n`;
    expect(run(`TMPDIR=/tmp/x/t bun ${path}`, path, source)).toEqual({ action: "allow" });
  });

  test.each([
    'rmSync(join(import.meta.dir, "x", ".."), { recursive: true });',
    'rmSync(join(someDir(), "out"), { recursive: true });',
    'rmSync(join(someDir(), "x", ".."), { recursive: true });',
    'const files = ["a", "b"];\nfiles.forEach((f) => rmSync(join(import.meta.dir, "out", f), { recursive: true }));',
    'rmSync(join(import.meta.dir, ".."), { force: true });',
    'const job = { parent: join(import.meta.dir, "out") };\nrmSync(job.parent, { recursive: true });',
    'rmSync(`${tmpdir()}/x-out`, { recursive: true, force: true });',
  ])("%p in the scratch dir is allowed", (body) => {
    expect(ts(body, OWN)).toEqual({ action: "allow" });
  });

  test.each([
    'fs.rmSync(path.join(__dirname, "out"), { recursive: true, force: true });',
    'fs.rmSync(path.join(path.dirname(__filename), "out"), { recursive: true });',
    'fs.rmSync(path.join(__dirname, "..", "dist"), { recursive: true, force: true });',
  ])("node %p in the worktree's scripts dir is allowed", (body) => {
    expect(js(body, join(ROOT, "scripts", "x.js"))).toEqual({ action: "allow" });
  });

  test.each([
    'shutil.rmtree(os.path.join(os.path.dirname(__file__), "out"))',
    'shutil.rmtree(os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"), ignore_errors=True)',
    'shutil.rmtree(Path(__file__).parent / "out")',
    'shutil.rmtree(Path(__file__).resolve().parent.parent / "dist")',
    'shutil.rmtree(os.path.join(os.path.dirname(os.path.dirname(__file__)), "dist"))',
  ])("python %p in the worktree's scripts dir is allowed", (body) => {
    expect(py(body, join(ROOT, "scripts", "x.py"))).toEqual({ action: "allow" });
  });
});
