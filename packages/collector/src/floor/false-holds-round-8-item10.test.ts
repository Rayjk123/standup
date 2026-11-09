import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { exampleCorpProfile } from "../org-profile/fixtures/example-corp.js";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * In a worker, $TMPDIR is the launch's own scratch dir (FloorConfig.scratchDir):
 * a redirect to `$TMPDIR/…`, `${TMPDIR}/…`, `"$TMPDIR"/…` or `${TMPDIR:-/tmp}/…`
 * writes there when the command leaves TMPDIR as the launch set it. A command
 * that holds for another reason (the org's `corp-review` cuts a review) holds the same with or
 * without such a redirect. A TMPDIR the command sets, one the hook's
 * environment shows naming another dir, and a path climbing out of the scratch
 * dir stay held.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const OTHER_SCRATCH = join(SCRATCH, "launch-2");

const config: FloorConfig = {
  v: 1,
  orgProfile: exampleCorpProfile(),
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
  [join(ROOT, "d.md")]: "## Intent\n",
  [join(OWN_SCRATCH, "notes.md")]: "# notes\n",
  [join(OTHER_SCRATCH, "prompt.md")]: "# other launch\n",
  [join(HOME, ".ssh", "id_rsa")]: "key\n",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes());
}

function withTmpdir(value: string | undefined, body: () => void): void {
  const saved = process.env.TMPDIR;
  beforeAll(() => {
    if (value === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = value;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  });
  body();
}

const REVIEW_PAIRS: [string, string][] = [
  ["corp-review --draft --issue X --description d.md > $TMPDIR/review.log 2>&1", "corp-review --draft --issue X --description d.md"],
  ["corp-review --revise R-123 > $TMPDIR/review.log", "corp-review --revise R-123"],
  ['corp-review --revise R-123 > "$TMPDIR/review.log" 2>&1', "corp-review --revise R-123"],
  ["corp-review --revise R-123 > ${TMPDIR}/review.log", "corp-review --revise R-123"],
  ["corp-review --revise R-123 > ${TMPDIR:-/tmp}/review.log", "corp-review --revise R-123"],
];

const ALLOWED = [
  "echo x > $TMPDIR/out.log",
  "bun test > $TMPDIR/t.log 2>&1",
  'git status > "${TMPDIR}/s.txt"',
  'echo x > "$TMPDIR"/out.log',
  "echo x > ${TMPDIR:-/tmp}/out.log",
  "echo x >> $TMPDIR/out.log",
  "cat $TMPDIR/notes.md",
];

const HELD_ANYWHERE: [string, string][] = [
  ["TMPDIR=/fake/home/.ssh; echo x > $TMPDIR/k", "floor-tamper"],
  ["export TMPDIR=/fake/home/.ssh; echo x > $TMPDIR/k", "floor-tamper"],
  ["TMPDIR=/fake/home/.ssh; corp-review --revise R-123 > $TMPDIR/review.log", "floor-tamper"],
  ["corp-review --revise R-123 > $TMPDIR/../launch-2/review.log", "floor-tamper"],
  [`export TMPDIR=${OTHER_SCRATCH}; echo x > $TMPDIR/k`, "floor-tamper"],
  ["echo x > $TMPDIR/../launch-2/x", "floor-tamper"],
  ["cat $TMPDIR/../launch-2/prompt.md", "floor-tamper"],
];

/** The parts of a verdict that say what holds it and why. */
function shape(v: FloorVerdict): unknown {
  if (v.action !== "hold") return v;
  const { action, category, reason } = v as { action: string; category: string; reason: string };
  return { action, category, reason };
}

describe("$TMPDIR in a redirect, with the hook's TMPDIR the launch's scratch dir", () => {
  withTmpdir(OWN_SCRATCH, () => {
    test.each(REVIEW_PAIRS)("%p holds as %p does", (withRedirect, bare) => {
      const base = bash(bare);
      expect(base).toMatchObject({ action: "hold" });
      expect(shape(bash(withRedirect))).toEqual(shape(base));
    });
    test.each(ALLOWED)("allows %p", (command) => {
      expect(bash(command)).toEqual({ action: "allow" });
    });
    test.each(HELD_ANYWHERE)("holds %p", (command, category) => {
      expect(bash(command)).toMatchObject({ action: "hold", category });
    });
  });
});

describe("$TMPDIR in a redirect, with no TMPDIR in the hook's environment", () => {
  withTmpdir(undefined, () => {
    test.each(REVIEW_PAIRS)("%p holds as %p does", (withRedirect, bare) => {
      const base = bash(bare);
      expect(base).toMatchObject({ action: "hold" });
      expect(shape(bash(withRedirect))).toEqual(shape(base));
    });
    test.each(ALLOWED)("allows %p", (command) => {
      expect(bash(command)).toEqual({ action: "allow" });
    });
    test.each(HELD_ANYWHERE)("holds %p", (command, category) => {
      expect(bash(command)).toMatchObject({ action: "hold", category });
    });
  });
});

describe("$TMPDIR in a redirect, with the hook's TMPDIR another launch's scratch dir", () => {
  withTmpdir(OTHER_SCRATCH, () => {
    test.each(["echo x > $TMPDIR/out.log", "cat $TMPDIR/prompt.md", "corp-review --revise R-123 > $TMPDIR/review.log"])("holds %p", (command) => {
      expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
    });
  });
});

describe("$TMPDIR in a redirect, with the hook's TMPDIR a secrets dir", () => {
  withTmpdir(join(HOME, ".ssh"), () => {
    test.each(["echo x > $TMPDIR/k", "cat $TMPDIR/id_rsa", "corp-review --revise R-123 > $TMPDIR/review.log"])("holds %p", (command) => {
      expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
    });
  });
});

describe("$TMPDIR the command empties or unsets, with no TMPDIR in the hook's environment", () => {
  withTmpdir(undefined, () => {
    test.each([
      ["unset TMPDIR; echo x > $TMPDIR/review.log", "echo x > /review.log"],
      ["TMPDIR=; echo x > $TMPDIR/review.log", "echo x > /review.log"],
      ["unset TMPDIR; corp-review --revise R-123 > $TMPDIR/review.log", "corp-review --revise R-123 > /review.log"],
    ])("%p is read as %p, not as a write to the scratch dir", (command, same) => {
      const v = bash(command);
      expect(shape(v)).toEqual(shape(bash(same)));
      if (command.startsWith("unset TMPDIR; corp-review")) expect(v).toMatchObject({ action: "hold" });
    });
  });
});

describe("$TMPDIR with the hook's TMPDIR set but empty", () => {
  withTmpdir("", () => {
    test("names the root, not the scratch dir", () => {
      expect(shape(bash("corp-review --revise R-123 > $TMPDIR/review.log"))).toEqual(shape(bash("corp-review --revise R-123 > /review.log")));
    });
  });
});
