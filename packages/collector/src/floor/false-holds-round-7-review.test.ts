import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { ownerApproved, ruleCheck, type AllowCheckInput } from "../persona/allow-check.js";
import { ownerProhibits, ownerYes } from "../persona/policy.js";
import { classifyToolCall, defaultProbes, type FloorProbes } from "./classify.js";
import { FLOOR_HIGH_RISK_LABEL, FLOOR_OWNER_GATE, type FloorConfig } from "./gate.js";

/*
 * Inputs next to this round's allowances that the classifier, or Persona's
 * owner-approval reading, holds: each sits just outside what an allowance
 * credits. Every case is pure: virtual files, fake paths, no process, no network.
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

function verdict(command: string, files: Record<string, string> = {}, cwd: string = COLLECTOR): { command: string; action: string; category: string | null } {
  const v = classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(files));
  return { command, action: v.action, category: v.action === "hold" ? v.category : null };
}

/** A test file that loads only child_process and bun:test, with `lead` import lines and `body` as its one test. */
function sinkFile(lead: string[], body: string): string {
  return ['import { test } from "bun:test";', 'import { execSync, spawnSync } from "child_process";', ...lead, `test("x", () => { ${body} });`, ""].join("\n");
}

const SINK_FILE = join(COLLECTOR, "src", "probe-sink.test.ts");
const SINK_RUN = "bun test src/probe-sink.test.ts";

describe("control", () => {
  test("a test run's rm of an env-named dir plus a bare slash holds", () => {
    const source = sinkFile([], 'const d = process.env.SCRATCH; execSync("rm -rf " + d + "/");');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);
});

/*
 * A path literal added to a computed value in a test's exec call is read under
 * that value only when every binding of it is a fresh temp dir (sinkArgTexts).
 * A delete built on any other value (the environment, a destructured or renamed
 * home dir) is one the floor can't place, and holds.
 */
describe("a path literal added to a value the floor does not place, in a test run's rm", () => {
  test("S1: process.env.STANDUP_DATA_DIR + a subdir of the live data dir", () => {
    const source = sinkFile([], 'const d = process.env.STANDUP_DATA_DIR; execSync("rm -rf " + d + "/worktrees");');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);

  test("S1b: process.env.STANDUP_DATA_DIR plus a dir under it, in an argv", () => {
    const source = sinkFile([], 'const d = process.env.STANDUP_DATA_DIR; spawnSync("rm", ["-rf", d + "/projects"]);');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);

  test("S2: HOME destructured from process.env, plus a directory under it", () => {
    const source = sinkFile([], 'const { HOME } = process.env; execSync("rm -rf " + HOME + "/Documents");');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);

  test("S3: os.homedir imported under another name and called inline", () => {
    const source = sinkFile(['import { homedir as hd } from "os";'], 'execSync("rm -rf " + hd() + "/Documents");');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);

  test("S4: process.env.USERPROFILE plus a directory under it", () => {
    const source = sinkFile([], 'execSync("rm -rf " + process.env.USERPROFILE + "/Documents");');
    expect(verdict(SINK_RUN, { [SINK_FILE]: source })).toMatchObject({ command: SINK_RUN, action: "hold" });
  }, 240_000);
});

/*
 * A test file that calls a floor module's writing exports with paths of its own
 * (gate.ts floorConfigArg writes <standupDataDir>/floor-configs/<launchId>.b64
 * for an oversized config; worktree-hooks.ts runs `git -C <path> config` and
 * makes dirs) loads more than the classifier, so runnerLoadsOnlyFloor doesn't
 * apply. The writes themselves are local steps, which test-run reads don't
 * hold (Mode.runner reads only outward steps): a gap tracked separately.
 */
describe("a test file that calls a floor module's writing exports", () => {
  const file = join(FLOOR, "writer.test.ts");
  const run = "bun test src/floor/writer.test.ts";
  const writer = (lead: string, call: string) => ['import { test } from "bun:test";', 'import { join } from "path";', lead, `test("x", () => { ${call} });`, ""].join("\n");
  const held = (source: string) => expect(verdict(run, { [file]: source })).toMatchObject({ command: run, action: "hold" });
  test.todo("holds isolateWorktreeHooks pointed at the install's checkout", () =>
    held(writer('import { isolateWorktreeHooks } from "./worktree-hooks.js";', 'isolateWorktreeHooks(join("/", "fake", "install"), join("/", "fake", "hooks"));'))
  );
  test.todo("holds floorConfigArg writing an oversized config under the data dir it names", () =>
    held(writer('import { floorConfigArg } from "./gate.js";', 'floorConfigArg({ standupDataDir: join("/", "fake", "data"), launchId: "l", sharedBranches: Array.from({ length: 5000 }, (_, i) => "b" + i) } as never);'))
  );
  test.todo("holds ensureEmptyHooksDir making a dir outside the worktree", () =>
    held(writer('import { ensureEmptyHooksDir } from "./worktree-hooks.js";', 'ensureEmptyHooksDir(join("/", "fake", "home", "Documents", "x"));'))
  );
});

/*
 * A getattr on a module that loads modules (pydoc, importlib, pkgutil, …), or a
 * direct pydoc.locate, loads the SDK by a name, whatever attribute it names
 * (pythonLoadsByName).
 */
describe("an SDK loaded through a module loader", () => {
  test("Y1: getattr(pydoc, 'locate')('boto3') then delete_bucket", () => {
    const command = `python3 -c 'import pydoc; c = getattr(pydoc, "locate")("boto3").client("s3"); c.delete_bucket(Bucket="b")'`;
    expect(verdict(command)).toMatchObject({ command, action: "hold" });
  }, 60_000);

  test("Y2: pydoc.locate('boto3') directly", () => {
    const command = `python3 -c 'import pydoc; c = pydoc.locate("boto3").client("s3"); c.delete_bucket(Bucket="b")'`;
    expect(verdict(command)).toMatchObject({ command, action: "hold" });
  }, 60_000);
});

/*
 * `bun pm cache rm` in the install clears the Bun package cache its installs
 * read: an install write (bunPmWrites).
 */
describe("bun pm in the install", () => {
  test("B1: bun pm cache rm clears the shared package cache", () => {
    const command = "bun pm cache rm";
    expect(verdict(command, {}, INSTALL)).toMatchObject({ command, action: "hold" });
  }, 60_000);
});

/*
 * Persona's owner approval: a yes with a condition, deferral or exception
 * attached is no yes (ownerYes), a prohibition in other words (avoid, skip,
 * refrain, off limits, rather you not) forbids the step (ownerProhibits), and a
 * bare yes to a question naming two steps approves neither (asksOneStep).
 */
const SCRATCH_START =
  "env -i PATH=/usr/bin:/bin HOME=/tmp/r/home DB_PATH=/tmp/r/data/standup.db COLLECTOR_PORT=29777 WS_PORT=29778 STANDUP_BIND_HOST=127.0.0.1 STANDUP_GATEWAY=0 STANDUP_PERSONA=0 STANDUP_REVIEW_TUNNELS=0 STANDUP_DIGEST=0 bun run src/index.ts > /tmp/r/c.log 2>&1 & sleep 3; curl -s http://127.0.0.1:29777/health";

function input(over: Partial<AllowCheckInput> = {}): AllowCheckInput {
  return {
    owner: "alice",
    selfAliases: ["alice"],
    gate: FLOOR_OWNER_GATE,
    category: "floor-tamper",
    floorReason: `${FLOOR_HIGH_RISK_LABEL}code in src/index.ts names Standup's data dir`,
    toolName: "Bash",
    call: SCRATCH_START,
    personaReason: "the worker checks its change on a scratch collector",
    job: { title: "floor route", goal: "fix the floor route" },
    brief: "Fix the floor route and its tests.",
    ownerMessages: ["fix the floor route"],
    preferences: [],
    worktreeRoot: "/srv/ws/wt",
    ...over,
  };
}

describe("Persona: a conditional yes is no unconditional yes", () => {
  test.each([
    "Yes, run the scratch collector once I have reviewed the plan.",
    "Yes, run the scratch collector after the tests pass.",
    "Yes, start the scratch collector when I am back at my desk.",
    "Yes, run the scratch collector, assuming it stays under /tmp.",
    "Yes, start the scratch collector provided the diff is small.",
    "Yes, run the scratch collector as long as nothing else is running.",
    "Yes, run the scratch collector tomorrow morning.",
    "Yes, run the scratch collector except for the digest part.",
  ])("P1: ownerYes reads %p as no yes", (text) => {
    expect({ text, yes: ownerYes(text).yes }).toEqual({ text, yes: false });
  });

  test.each([
    "Yes, run the scratch collector once I have reviewed the plan.",
    "Yes, start the scratch collector when I am back at my desk.",
    "Yes, run the scratch collector, assuming it stays under /tmp.",
  ])("P1b: the rules check does not place the step on %p", (text) => {
    expect({ text, verdict: ruleCheck(input({ ownerApprovals: [{ text }] })).verdict }).toEqual({ text, verdict: "flag" });
  });
});

describe("Persona: a prohibition in words other than never/don't/no/stop forbids the step", () => {
  test.each([
    "Avoid starting scratch collectors in this job.",
    "Skip the scratch collector, I will check it myself.",
    "Please refrain from running a scratch collector.",
    "Scratch collectors are off limits for this job.",
    "I would rather you not start an isolated collector.",
  ])("P2: ownerProhibits sees a clause in %p", (text) => {
    expect({ text, clauses: ownerProhibits(text).clauses.length > 0 }).toEqual({ text, clauses: true });
  });

  test("P2b: an earlier 'avoid' beside a later yes still forbids the scratch run", () => {
    const asked = input({ ownerMessages: ["fix the floor route", "Avoid starting scratch collectors in this job."], ownerApprovals: [{ text: "Yes, run the scratch collector." }] });
    expect(ownerApproved(asked, asked.call)).toBe(false);
    const preferred = input({ preferences: ["Skip scratch collectors."], ownerApprovals: [{ text: "Yes, run the scratch collector." }] });
    expect(ownerApproved(preferred, preferred.call)).toBe(false);
  });
});

describe("Persona: a bare yes to one question about two steps", () => {
  test("P3: 'yes' to a question naming a scratch run and a push approves neither", () => {
    const prompt = "The floor route worker wants to start a scratch copy of the collector under /tmp and then push HEAD to origin/main. Should it?";
    const held = input({ category: "outward", floorReason: "pushes a branch", call: "git push origin HEAD:main", personaReason: "the branch is ready", ownerApprovals: [{ text: "yes", prompt }] });
    expect(ownerApproved(held, held.call)).toBe(false);
  });
});
