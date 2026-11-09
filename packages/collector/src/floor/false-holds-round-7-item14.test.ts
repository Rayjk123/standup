import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import type { FloorConfig } from "./gate.js";

/*
 * A test run whose test file feeds command strings to the floor's own
 * classifier. Its strings and the classifier's command tables are literals
 * the floor reads as data, so the run is no push; a test file that runs a
 * push itself, or loads a module that does, still holds. The worktree and the
 * install both read through to this checkout.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COLLECTOR = join(ROOT, "packages", "collector");
const FLOOR = join(COLLECTOR, "src", "floor");
const SCRATCH = join(HOME, ".cache", "standup-scratch", "11111111-2222-3333-4444-555555555555");
const ISO = join("/", "tmp", "floor-iso-1");

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
  protectedPaths: [join(DATA, "secrets")],
  worktreeRoots: [join(DATA, "worktrees")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
  scratchDir: SCRATCH,
  scratchRoot: join(HOME, ".cache", "standup-scratch"),
};

const WORKER_ENV: Record<string, string> = { TMPDIR: SCRATCH, TMP: SCRATCH, TEMP: SCRATCH, HOME, PATH: "/usr/bin:/bin" };

const MADE = ["home", "xdg/config", "xdg/data", "xdg/cache", "xdg/state", "tmp", "kb", "internal", "docs"].map((d) => join(ISO, d));

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
  const virtual: Record<string, string> = { [join(ROOT, ".git")]: "gitdir: /fake/install/.git/worktrees/feat-1\n", [join(DATA, "standup.db")]: "", ...files };
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

function verdict(command: string, files: Record<string, string>): { command: string; action: string; category: string | null } {
  const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: COLLECTOR }, config, probes(files));
  return { command, action: v.action, category: v.action === "hold" ? v.category : null };
}

/** A test file feeding command strings to the classifier, with `lead` import lines and `body` statements of its own. */
function testFile(lead: string[] = [], body: string[] = []): string {
  return [
    'import { describe, expect, test } from "bun:test";',
    'import { join } from "path";',
    'import { classifyToolCall } from "./classify.js";',
    'import type { FloorConfig } from "./gate.js";',
    ...lead,
    "const config = { root: join(\"/\", \"w\") } as unknown as FloorConfig;",
    'describe("outward steps", () => {',
    '  test.each(["git push origin HEAD:main", "docker push img", "npm publish", "gh pr create"])("holds %p", (command) => {',
    '    expect(classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: "/w" }, config).action).toBe("hold");',
    "  });",
    "});",
    ...body,
    "",
  ].join("\n");
}

const FILE = join(FLOOR, "strings.test.ts");
const RUN = "bun test src/floor/strings.test.ts";
const ISOLATED = `env -i PATH=/usr/bin:/bin HOME=${ISO}/home XDG_CONFIG_HOME=${ISO}/xdg/config XDG_DATA_HOME=${ISO}/xdg/data XDG_CACHE_HOME=${ISO}/xdg/cache XDG_STATE_HOME=${ISO}/xdg/state TMPDIR=${ISO}/tmp TMP=${ISO}/tmp TEMP=${ISO}/tmp TMUX_TMPDIR=${ISO}/tmp DB_PATH=${ISO}/standup.db STANDUP_SQLITE_PATH=${ISO}/standup.db KNOWLEDGE_DIR=${ISO}/kb STANDUP_INTERNAL_ROOT=${ISO}/internal STANDUP_PROJECT_DOCS_DIR=${ISO}/docs ${RUN}`;

describe("a test file that only feeds command strings to the floor's classifier", () => {
  test("is not an outward step", () => {
    expect(verdict(RUN, { [FILE]: testFile() })).toEqual({ command: RUN, action: "allow", category: null });
  }, 240_000);

  test("is not an outward step under a full env -i isolation either", () => {
    expect(verdict(ISOLATED, { [FILE]: testFile() })).toEqual({ command: ISOLATED, action: "allow", category: null });
  }, 240_000);
});

describe("test runs that still hold as outward", () => {
  test("a test file that imports child_process and runs a push", () => {
    const file = testFile(['import { execSync } from "child_process";'], ['execSync("git push origin HEAD:main");']);
    expect(verdict(RUN, { [FILE]: file })).toMatchObject({ command: RUN, action: "hold", category: "outward" });
  }, 240_000);

  test("a test file that loads only the floor but runs a push through Bun itself", () => {
    const file = testFile([], ['Bun.spawnSync(["git", "push", "origin", "HEAD:main"]);']);
    expect(verdict(RUN, { [FILE]: file })).toMatchObject({ command: RUN, action: "hold", category: "outward" });
  }, 240_000);

  test("a test file that also loads a module of the worktree's own that pushes", () => {
    const file = testFile(['import "./helper.js";']);
    const helper = 'import { execSync } from "child_process";\nexecSync("git push origin HEAD:main");\n';
    expect(verdict(RUN, { [FILE]: file, [join(FLOOR, "helper.ts")]: helper })).toMatchObject({ command: RUN, action: "hold", category: "outward" });
  }, 240_000);

  test("a floor module the worktree changed from the install's is read as any other code", () => {
    const gate = `${readFileSync(join(REPO, "packages", "collector", "src", "floor", "gate.ts"), "utf8")}\nimport { execSync } from "child_process";\nexecSync("git push origin HEAD:main");\n`;
    expect(verdict(RUN, { [FILE]: testFile(), [join(FLOOR, "gate.ts")]: gate })).toMatchObject({ command: RUN, action: "hold", category: "outward" });
  }, 240_000);
});
