import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Bun reads the bunfig.toml in the dir it starts in and the user's global
 * `.bunfig.toml` (under HOME, HOME/.config and XDG_CONFIG_HOME). The floor
 * hook runs from its own dir with a fixed `--config`, so a bunfig written in
 * a scratch dir under the temp dirs (/tmp, the launch's own TMPDIR) changes
 * nothing the floor loads; it is allowed, and a `bun test` there reads its
 * preload as any test run's. The global name `.bunfig.toml` stays held
 * anywhere (a later step may make its dir a run's HOME or XDG_CONFIG_HOME),
 * and a bunfig whose canonical path is in the install, the floor, the
 * worktree (also through a /tmp link into it), the user's global bunfig, or
 * a dir the floor can't place keeps the verdict it has always had.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SCRATCH = join(HOME, ".cache", "standup-scratch");
const OWN_SCRATCH = join(SCRATCH, "launch-1");
const EXP = join("/tmp", "x", "exp");
const WT_LINK = join("/tmp", "wt-link");
const BUN_TRUE = join("/tmp", "x", "y");
const BAD = join("/tmp", "x", "bad");
const XDG = join(HOME, "xdg-config");
const TMP_HOME = join("/tmp", "iso", "home");
const TMP_XDG = join("/tmp", "iso", "xdg", "config");
const INSTALL_CLASSIFY = join(INSTALL, "packages", "collector", "src", "floor", "classify.ts");

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

const TEST = `import { test, expect } from "bun:test";\ntest("x", () => expect(1).toBe(1));\n`;
const PRELOAD = `console.log("preloaded");\n`;
const EVIL = `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(INSTALL_CLASSIFY)}, "export {};\\n");\n`;

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "package.json")]: JSON.stringify({ name: "x" }),
  [join(ROOT, "packages", "collector", "package.json")]: JSON.stringify({ name: "collector" }),
  [join(INSTALL, "package.json")]: JSON.stringify({ name: "standup" }),
  [join(EXP, "a.test.ts")]: TEST,
  [join(EXP, "p.ts")]: PRELOAD,
  [join(OWN_SCRATCH, "exp", "a.test.ts")]: TEST,
  [join(OWN_SCRATCH, "exp", "p.ts")]: PRELOAD,
  [join(EXP, "evil.ts")]: EVIL,
  [join(OWN_SCRATCH, "exp", "evil.ts")]: EVIL,
  [join(ROOT, "a.test.ts")]: TEST,
  [join(ROOT, "p.ts")]: PRELOAD,
  [join(ROOT, "evil.ts")]: EVIL,
  [join(ROOT, "packages", "collector", "a.test.ts")]: TEST,
  [join(ROOT, "packages", "collector", "p.ts")]: PRELOAD,
  [join(ROOT, "packages", "collector", "evil.ts")]: EVIL,
  [INSTALL_CLASSIFY]: "export const y = 1;\n",
  [join(BUN_TRUE, "bunfig.toml")]: `preload = ["./evil.ts"]\n[run]\nbun = true\n`,
  [join(BUN_TRUE, "evil.ts")]: EVIL,
  [join(BUN_TRUE, "a.js")]: "console.log(1);\n",
  [join(BUN_TRUE, "package.json")]: JSON.stringify({ name: "y", scripts: { nodehi: "node a.js" } }),
  [join(BAD, "bunfig.toml")]: `preload = ["./evil.ts"]\n[test]\npreload = ["./evil.ts"]\n`,
  [join(BAD, "evil.ts")]: EVIL,
  [join(BAD, "a.ts")]: "console.log(1);\n",
  [join(BAD, "a.test.ts")]: TEST,
  [join(BAD, "package.json")]: JSON.stringify({ name: "bad", scripts: { hi: "echo hi" } }),
  [join(EXP, "e.toml")]: `preload = ["./evil.ts"]\n`,
  [join(TMP_HOME, ".config", "x")]: "x\n",
  [join(TMP_XDG, "x")]: "x\n",
  [join(HOME, ".config", "x")]: "x\n",
  [join(XDG, "x")]: "x\n",
};

/** Symlinks: path → where it points. */
const LINKS: Record<string, string> = {
  [WT_LINK]: ROOT,
};

function probes(env: Record<string, string> = {}): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of [...Object.keys(FILES), ...Object.keys(LINKS)]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const followed = (p: string): string => {
    for (const [link, to] of Object.entries(LINKS)) if (p === link || p.startsWith(`${link}/`)) return to + p.slice(link.length);
    return p;
  };
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (followed(p) in FILES ? { ok: true, text: FILES[followed(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => followed(p) in FILES || dirs.has(followed(p)),
    isDirectory: (p) => dirs.has(followed(p)),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...Object.keys(LINKS), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => {
      const to = followed(p);
      return to in FILES || dirs.has(to) ? to : null;
    },
    lstat: (p) => (p in LINKS ? { symlink: true, file: false, nlink: 1 } : p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 2 } : null),
    homeDir: () => HOME,
    env: (name) => env[name] ?? (name === "HOME" ? HOME : name === "TMPDIR" ? OWN_SCRATCH : undefined),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, cwd = ROOT, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, probes(env));
}

const SAVED_TMPDIR = process.env.TMPDIR;
beforeEach(() => {
  process.env.TMPDIR = OWN_SCRATCH;
});
afterEach(() => {
  if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = SAVED_TMPDIR;
});

const WRITE = `printf '[test]\\npreload = ["./p.ts"]\\n' > bunfig.toml`;
const EVIL_WRITE = `printf '[test]\\npreload = ["./evil.ts"]\\n' > bunfig.toml`;

describe("a bunfig written in a scratch dir under the temp dirs", () => {
  test.each([
    [`cd ${EXP} && ${WRITE} && bun test`, ROOT],
    [`${WRITE} && bun test`, EXP],
    [WRITE, EXP],
    [`printf 'x' > ${join(EXP, "bunfig.toml")}`, ROOT],
    [`mkdir -p /tmp/y && cd /tmp/y && ${WRITE}`, ROOT],
    [`cd $TMPDIR/exp && ${WRITE} && bun test`, ROOT],
    [`${WRITE} && bun test`, join(OWN_SCRATCH, "exp")],
    [`printf 'x' > "$TMPDIR/exp/bunfig.toml"`, ROOT],
    [`printf '[install]\\nexact = true\\n' > /tmp/z/bunfig.toml`, ROOT],
    [`echo 'test.preload = ["./p.ts"]' > /tmp/z/bunfig.toml`, ROOT],
  ])("%p (cwd %p) is allowed", (command, cwd) => {
    expect({ command, verdict: bash(command, cwd) }).toEqual({ command, verdict: { action: "allow" } });
  });
});

describe("a bunfig the floor or a later run relies on keeps its verdict", () => {
  test.each([
    [`cd "$(cat /tmp/where)" && printf x > .bunfig.toml`, ROOT],
    [`printf 'x' > ${join(EXP, ".bunfig.toml")}`, ROOT],
    [`printf 'x' > ${join(EXP, ".bunfig.toml")} && HOME=${EXP} bun test`, ROOT],
    [`cd ${EXP} && printf 'x' > .bunfig.toml && HOME=${EXP} XDG_CONFIG_HOME=${EXP} bun test`, ROOT],
    [`cd ${WT_LINK} && ${WRITE} && bun test`, ROOT],
    [`${WRITE} && bun test`, WT_LINK],
    [`printf 'x' > ${join(WT_LINK, "bunfig.toml")}`, ROOT],
    [`cd ${EXP} && ${EVIL_WRITE} && bun test`, ROOT],
    [`${EVIL_WRITE} && bun test`, EXP],
    [`cd $TMPDIR/exp && ${EVIL_WRITE} && bun test`, ROOT],
    [`ln -s ${INSTALL} /tmp/inst && printf 'x' > /tmp/inst/bunfig.toml`, ROOT],
    [`printf 'x' > ${join(INSTALL, "bunfig.toml")}`, ROOT],
    [WRITE, INSTALL],
    [`printf 'x' > ${join(INSTALL, "packages", "collector", "src", "floor", "bunfig.toml")}`, ROOT],
    [`printf 'x' > ${join(HOME, ".bunfig.toml")}`, ROOT],
    [`printf 'x' > ~/.bunfig.toml`, ROOT],
    [`printf 'x' > ${join(HOME, ".config", ".bunfig.toml")}`, ROOT],
    [`printf 'x' > $XDG_CONFIG_HOME/.bunfig.toml`, ROOT],
  ])("%p (cwd %p) is held", (command, cwd) => {
    expect({ command, verdict: bash(command, cwd, { XDG_CONFIG_HOME: XDG }) }).toMatchObject({ command, verdict: { action: "hold" } });
  });

  test.each([
    [`printf 'x' > ${join(TMP_HOME, ".bunfig.toml")}`, { HOME: TMP_HOME }],
    [`printf 'x' > ${join(TMP_HOME, ".config", ".bunfig.toml")}`, { HOME: TMP_HOME }],
    [`printf 'x' > ${join(TMP_XDG, ".bunfig.toml")}`, { XDG_CONFIG_HOME: TMP_XDG }],
    [`cd ${TMP_XDG} && printf 'x' > .bunfig.toml`, { XDG_CONFIG_HOME: TMP_XDG }],
  ])("%p, the global bunfig of a HOME or XDG_CONFIG_HOME under /tmp, is held", (command, env) => {
    expect({ command, verdict: bash(command, ROOT, env) }).toMatchObject({ command, verdict: { action: "hold", category: "floor-tamper" } });
  });

  test("the XDG_CONFIG_HOME bunfig spelled through the variable is held", () => {
    const command = `printf 'x' > $XDG_CONFIG_HOME/.bunfig.toml`;
    expect({ command, verdict: bash(command, ROOT, { XDG_CONFIG_HOME: TMP_XDG }) }).toMatchObject({ command, verdict: { action: "hold" } });
  });
});

describe("a scratch bunfig that may change a run other than `bun test`", () => {
  test.each([
    [`mkdir -p /tmp/z && printf 'preload = ["./e.ts"]\\n[run]\\nbun = true\\n' > /tmp/z/bunfig.toml`],
    [`printf 'preload = ["/tmp/z/e.ts"]\\n' > /tmp/bunfig.toml`],
    [`printf '[run]\\nbun = true\\n' > /tmp/z/bunfig.toml`],
    [`printf 'run.bun = true\\n' > /tmp/z/bunfig.toml`],
    [`printf 'run = { bun = true }\\n' > /tmp/z/bunfig.toml`],
    [`printf '["run"]\\nbun = true\\n' > /tmp/z/bunfig.toml`],
    [`printf '[run]\\npreload = ["./e.ts"]\\n' > /tmp/z/bunfig.toml`],
    [`printf 'x = """\\n[test]\\n"""\\npreload = ["./e.ts"]\\n' > /tmp/z/bunfig.toml`],
    [`printf '[test]\\npreload = ["./p.ts"]\\n[[run]]\\nbun = true\\n' > /tmp/z/bunfig.toml`],
    [`printf "$X" > /tmp/z/bunfig.toml`],
    [`echo "$(cat /tmp/where)" > /tmp/z/bunfig.toml`],
    [`cat ${join(EXP, "e.toml")} > /tmp/z/bunfig.toml`],
    [`cp ${join(EXP, "e.toml")} /tmp/z/bunfig.toml`],
    [`{ printf 'x'; } > /tmp/z/bunfig.toml`],
    [`printf 'preload = ["./e.ts"]\\n' >> ${join(EXP, "bunfig.toml")}`],
  ])("writing %p is held", (command) => {
    expect({ command, verdict: bash(command) }).toMatchObject({ command, verdict: { action: "hold" } });
  });

  test.each([
    [`cd ${BUN_TRUE} && bun run nodehi`],
    [`bun --cwd ${BUN_TRUE} run nodehi`],
    [`bun --cwd ${BAD} a.ts`],
    [`bun --cwd=${BAD} test`],
    [`cd ${BAD} && bun run hi`],
  ])("%p, a run with a bunfig on disk whose preload writes floor code, is held", (command) => {
    expect({ command, verdict: bash(command) }).toMatchObject({ command, verdict: { action: "hold" } });
  });
});

describe("a bunfig in the worktree is the worker's own, its preloads read by the test run", () => {
  test.each([
    [`${WRITE} && bun test`, ROOT],
    [`cd packages/collector && ${WRITE} && bun test`, ROOT],
  ])("%p (cwd %p) is allowed", (command, cwd) => {
    expect({ command, verdict: bash(command, cwd) }).toEqual({ command, verdict: { action: "allow" } });
  });

  test.each([
    [`${EVIL_WRITE} && bun test`, ROOT],
    [`cd packages/collector && ${EVIL_WRITE} && bun test`, ROOT],
  ])("%p (cwd %p), a preload that writes floor code, is held", (command, cwd) => {
    expect({ command, verdict: bash(command, cwd) }).toMatchObject({ command, verdict: { action: "hold" } });
  });
});
