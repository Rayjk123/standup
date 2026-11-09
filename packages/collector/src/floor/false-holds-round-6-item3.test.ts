import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A `.claude/` dir under a scratch HOME the worker made configures no Claude
 * Code the worker runs: Claude Code reads the worker's own ~/.claude (or
 * CLAUDE_CONFIG_DIR) and the `.claude/` dirs of its working dir and that
 * dir's ancestors. Writing CLAUDE.md, agents or skills there is the worker's
 * own scratch, and so are its `settings.json` and `.claude.json`: a nested
 * agent run with that HOME is unread, and runs, while one pointed at a
 * CLAUDE_CONFIG_DIR holds. The scratch HOME must be a dir the command's own
 * `$(mktemp -d)` makes, or one under the launch's own scratch dir: a fixed
 * name in the shared temp dir (`/tmp/h`) may be another session's scratch
 * HOME, or a link swapped in, so it holds. Any path that reaches the real
 * config (a symlink, a dangling symlink at the target, `..`), the worktree's
 * `.claude/` or one above it, the shared temp dir's, a temp HOME the worker
 * runs with or CLAUDE_CONFIG_DIR stays held.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
/** A worktree under the temp dir, for the cases where the scratch `.claude/` is its own or an ancestor's. */
const TMP_ROOT = join("/", "tmp", "wt", "feat-2");
/** The launch's own scratch dir, under the home dir. */
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH_ROOT, "launch-1");

function configFor(root: string): FloorConfig {
  return {
    v: 1,
    collectorUrl: "http://127.0.0.1:17777",
    launchId: "launch-1",
    scratchRoot: SCRATCH_ROOT,
    scratchDir: S,
    root,
    sharedBranches: ["main", "mainline"],
    personalAwsAccounts: [],
    waitSeconds: 60,
    standupDataDir: DATA,
    floorPaths: [join(INSTALL, "packages", "collector", "src", "floor")],
    installDir: INSTALL,
    protectedPaths: [join(DATA, "secrets")],
    tmpDirs: ["/tmp"],
    workerToken: "x".repeat(64),
    replyPublicKey: "test",
  };
}

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(HOME, ".claude", "settings.json")]: "{}\n",
  [join("/", "tmp", "r6-home", ".claude", "CLAUDE.md")]: "# old\n",
  [join(S, "r6-home", ".claude", "CLAUDE.md")]: "# old\n",
  [join("/", "tmp", "realc", "cj.json")]: "{}\n",
  [join("/", "tmp", "hl", ".claude", "settings.json")]: "{}\n",
  [join("/", "tmp", "hl", ".claude", "CLAUDE.md")]: "# old\n",
  [join("/", "tmp", "hl", ".claude.json")]: "{}\n",
};
/** Files under a scratch HOME with a second hard link, which may be the real config's. */
const HARD_LINKED = new Set([join("/", "tmp", "hl", ".claude", "settings.json"), join("/", "tmp", "hl", ".claude", "CLAUDE.md"), join("/", "tmp", "hl", ".claude.json")]);
/** A home whose `.claude` and `.claude.json` are symlinks into the temp dir. */
const LINKED_HOME = join("/", "fake", "home2");
const DIRS = [
  "/",
  "/tmp",
  ROOT,
  TMP_ROOT,
  join(HOME, ".claude"),
  join("/", "tmp", "h"),
  join(S, "h"),
  join(S, "r6-home", ".claude"),
  join("/", "tmp", "r6-home", ".claude"),
  join("/", "tmp", "dl", ".claude"),
  join("/", "tmp", "dd"),
  join("/", "tmp", "cfg"),
  join("/", "tmp", "wh", ".claude"),
  join("/", "tmp", "realc", ".claude"),
  LINKED_HOME,
];
/** Symlinks: the real ~/.claude, a scratch HOME whose `.claude` is the real one, dangling links into ~/.claude, a temp-to-temp link, the worktree. */
const LINKS: Record<string, string> = {
  [join("/", "tmp", "lc")]: join(HOME, ".claude"),
  [join("/", "tmp", "lh")]: HOME,
  [join("/", "tmp", "h2", ".claude")]: join(HOME, ".claude"),
  [join("/", "tmp", "dl", ".claude", "CLAUDE.md")]: join(HOME, ".claude", "CLAUDE.md"),
  [join("/", "tmp", "dl", ".claude", "agents")]: join(HOME, ".claude", "agents"),
  [join("/", "tmp", "dl", ".claude", "settings.json")]: join(HOME, ".claude", "settings.local.json"),
  [join("/", "tmp", "dl", ".claude.json")]: join(HOME, ".claude.json"),
  [join("/", "tmp", "dd", ".claude")]: join(HOME, ".claude", "skills"),
  [join("/", "tmp", "tt")]: join("/", "tmp", "h"),
  [join("/", "tmp", "wl")]: ROOT,
  [join(LINKED_HOME, ".claude")]: join("/", "tmp", "realc", ".claude"),
  [join(LINKED_HOME, ".claude.json")]: join("/", "tmp", "realc", "cj.json"),
};

function probes(env: Record<string, string> = {}, home = HOME): Partial<FloorProbes> {
  const dirs = new Set<string>(DIRS);
  for (const f of [...Object.keys(FILES), ...DIRS]) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const real = (p: string): string => {
    for (const [from, to] of Object.entries(LINKS)) if (p === from || p.startsWith(`${from}/`)) return real(to + p.slice(from.length));
    return p;
  };
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (real(p) in FILES ? { ok: true, text: FILES[real(p)]! } : { ok: false, reason: "missing" }),
    exists: (p) => real(p) in FILES || dirs.has(real(p)),
    executable: () => false,
    isDirectory: (p) => dirs.has(real(p)),
    listDir: (p) => {
      const d = real(p);
      return dirs.has(d) ? [...new Set([...Object.keys(FILES), ...Object.keys(LINKS), ...dirs].filter((f) => f.startsWith(`${d === "/" ? "" : d}/`)).map((f) => f.slice(d.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (real(p) in FILES || dirs.has(real(p)) ? real(p) : null),
    lstat: (p) => (p in LINKS ? { symlink: true, file: false, nlink: 1 } : p in FILES ? { symlink: false, file: true, nlink: HARD_LINKED.has(p) ? 2 : 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => home,
    env: (name) => env[name],
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

interface Opts {
  cwd?: string;
  root?: string;
  env?: Record<string, string>;
  home?: string;
}

function bash(command: string, o: Opts = {}): FloorVerdict {
  const root = o.root ?? ROOT;
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: o.cwd ?? root }, configFor(root), probes(o.env, o.home));
}

function write(file_path: string, o: Opts = {}): FloorVerdict {
  const root = o.root ?? ROOT;
  return classifyToolCall({ toolName: "Write", toolInput: { file_path, content: "# scratch\n" }, cwd: o.cwd ?? root }, configFor(root), probes(o.env, o.home));
}

function edit(file_path: string, o: Opts = {}): FloorVerdict {
  const root = o.root ?? ROOT;
  return classifyToolCall({ toolName: "Edit", toolInput: { file_path, old_string: "old", new_string: "new" }, cwd: o.cwd ?? root }, configFor(root), probes(o.env, o.home));
}

function expectAllowed(label: string, v: FloorVerdict): void {
  expect({ label, v }).toEqual({ label, v: { action: "allow" } });
}

function expectHeld(label: string, v: FloorVerdict, category: string): void {
  expect({ label, v }).toMatchObject({ label, v: { action: "hold", category } });
}

describe("a `.claude/` dir under a scratch HOME the worker made", () => {
  test.each([
    `${S}/r6-home/.claude/CLAUDE.md`,
    `${S}/h/.claude/CLAUDE.md`,
    `${S}/h/.claude/agents/reviewer.md`,
    `${S}/h/.claude/skills/x/SKILL.md`,
    `${S}/h/.claude/projects/p/memory/MEMORY.md`,
    `${S}/h/./.claude/CLAUDE.md`,
    `${S}/a/../h/.claude/CLAUDE.md`,
  ])("Write to %p is allowed", (path) => {
    expectAllowed(path, write(path));
  });

  test("Edit of an existing scratch CLAUDE.md is allowed", () => {
    expectAllowed("edit", edit(`${S}/r6-home/.claude/CLAUDE.md`));
  });

  test.each([
    `mkdir -p ${S}/h/.claude && printf x > ${S}/h/.claude/CLAUDE.md`,
    `mkdir -p ${S}/h/.claude; echo '# rules' >> ${S}/h/.claude/CLAUDE.md`,
    "H=$(mktemp -d); mkdir -p $H/.claude; cat > \"$H/.claude/CLAUDE.md\" <<'EOF'\n# scratch rules\nEOF",
    "H=$(mktemp -d /tmp/r6.XXXXXX) && mkdir -p \"$H/.claude/agents\" && printf '%s\\n' x > \"$H/.claude/agents/a.md\"",
    `cp /tmp/r6-home/.claude/CLAUDE.md ${S}/h/.claude/CLAUDE.md`,
    `cat /tmp/r6-home/.claude/CLAUDE.md | tee ${S}/h/.claude/CLAUDE.md`,
    `rm -rf ${S}/h/.claude`,
    `rm -f ${S}/r6-home/.claude/CLAUDE.md`,
    `cd ${S}/h && mkdir -p .claude && printf x > .claude/CLAUDE.md`,
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("a `.claude/` dir under a fixed name in the shared temp dir", () => {
  test.each([
    "/tmp/r6-home/.claude/CLAUDE.md",
    "/tmp/h/.claude/CLAUDE.md",
    "/tmp/h/.claude/agents/reviewer.md",
    "/tmp/h/.claude/projects/p/memory/MEMORY.md",
    "/tmp/tt/.claude/CLAUDE.md",
    "/tmp/a/../h/.claude/CLAUDE.md",
  ])("Write to %p holds", (path) => {
    expectHeld(path, write(path), "floor-tamper");
  });

  test("Edit of an existing CLAUDE.md there holds", () => {
    expectHeld("edit", edit("/tmp/r6-home/.claude/CLAUDE.md"), "floor-tamper");
  });

  test.each([
    "mkdir -p /tmp/h/.claude && printf x > /tmp/h/.claude/CLAUDE.md",
    "cp /tmp/r6-home/.claude/CLAUDE.md /tmp/h/.claude/CLAUDE.md",
    "cat /tmp/r6-home/.claude/CLAUDE.md | tee /tmp/h/.claude/CLAUDE.md",
    "cd /tmp/h && mkdir -p .claude && printf x > .claude/CLAUDE.md",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });
});

describe("the real Claude config stays floor-tamper", () => {
  test.each([
    "/fake/home/.claude/CLAUDE.md",
    "/fake/home/.claude/agents/x.md",
    // A temp path that is a symlink into the real ~/.claude, or to the real HOME.
    "/tmp/lc/CLAUDE.md",
    "/tmp/lh/.claude/CLAUDE.md",
    // A scratch HOME whose `.claude` is a symlink to the real one.
    "/tmp/h2/.claude/CLAUDE.md",
    // A dangling symlink at the write target: writing through it creates ~/.claude/CLAUDE.md.
    "/tmp/dl/.claude/CLAUDE.md",
    "/tmp/dl/.claude/agents/x.md",
    // A dangling symlink as the `.claude` dir itself.
    "/tmp/dd/.claude/x/SKILL.md",
    // `..` back to the real home.
    "/tmp/h/../../fake/home/.claude/CLAUDE.md",
    "/tmp/h/.claude/../../../fake/home/.claude/CLAUDE.md",
  ])("Write to %p holds", (path) => {
    expectHeld(path, write(path), "floor-tamper");
  });

  test.each([
    "printf x > ~/.claude/CLAUDE.md",
    "printf x > $HOME/.claude/CLAUDE.md",
    "printf x > \"${HOME}/.claude/CLAUDE.md\"",
    "printf x > /tmp/lc/CLAUDE.md",
    "printf x > /tmp/dl/.claude/CLAUDE.md",
    "printf x > /tmp/h/../../fake/home/.claude/CLAUDE.md",
    "ln -s ~/.claude /tmp/x && printf x > /tmp/x/CLAUDE.md",
    "ln -sf ~/.claude/CLAUDE.md /tmp/h/.claude/CLAUDE.md && printf x > /tmp/h/.claude/CLAUDE.md",
    // A failed mktemp leaves only the literal after it: the floor reads the path as if it had been spelled without the temp part.
    "printf x > \"$(mktemp -d)$HOME/.claude/CLAUDE.md\"",
    "printf x > \"$(mktemp -d)/fake/home/.claude/CLAUDE.md\"",
    "printf x > /tmp/h/fake/home/.claude/CLAUDE.md",
    "mkdir -p /tmp/h/.claude && mv /tmp/h/.claude ~/.claude",
    "cp -r /tmp/h/.claude ~/",
    "printf x > /tmp/h/.claude/CLAUDE.md && ln -sfn /tmp/h/.claude ~/.claude",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test("CLAUDE_CONFIG_DIR under the temp dir is the worker's config dir", () => {
    const env = { CLAUDE_CONFIG_DIR: "/tmp/cfg" };
    expectHeld("write", write("/tmp/cfg/CLAUDE.md", { env }), "floor-tamper");
    expectHeld("write agents", write("/tmp/cfg/agents/x.md", { env }), "floor-tamper");
    expectHeld("bash", bash("printf x > /tmp/cfg/CLAUDE.md", { env }), "floor-tamper");
    // A config dir named `.claude` under the temp dir.
    const dotted = { CLAUDE_CONFIG_DIR: "/tmp/cfg/.claude" };
    expectHeld("dotted", write("/tmp/cfg/.claude/CLAUDE.md", { env: dotted }), "floor-tamper");
    // A relative CLAUDE_CONFIG_DIR the floor can't place keeps every `.claude/` dir held.
    expectHeld("relative", write("/tmp/h/.claude/CLAUDE.md", { env: { CLAUDE_CONFIG_DIR: "cfg/.claude" } }), "floor-tamper");
    // A `.claude` dir under the launch's scratch dir is still scratch.
    expectAllowed("other", write(`${S}/h/.claude/CLAUDE.md`, { env }));
  });

  test("a worker whose own HOME is under the temp dir", () => {
    const o = { home: "/tmp/wh" };
    expectHeld("write", write("/tmp/wh/.claude/CLAUDE.md", o), "floor-tamper");
    expectHeld("bash", bash("printf x > ~/.claude/CLAUDE.md", o), "floor-tamper");
  });

  test("settings files that reach the real config, the worktree or the shared temp dir hold", () => {
    expectHeld("real settings", write("/fake/home/.claude/settings.json"), "floor-tamper");
    expectHeld("real settings.local", write("/fake/home/.claude/settings.local.json"), "floor-tamper");
    expectHeld("real claude.json", write("/fake/home/.claude.json"), "floor-tamper");
    expectHeld("bash real", bash("echo '{}' > ~/.claude/settings.json"), "floor-tamper");
    expectHeld("bash real claude.json", bash("echo '{}' > $HOME/.claude.json"), "floor-tamper");
    expectHeld("link to ~/.claude", write("/tmp/lc/settings.json"), "floor-tamper");
    expectHeld("link to HOME", write("/tmp/lh/.claude.json"), "floor-tamper");
    expectHeld("link to HOME settings", write("/tmp/lh/.claude/settings.json"), "floor-tamper");
    expectHeld("scratch .claude linked to the real one", write("/tmp/h2/.claude/settings.json"), "floor-tamper");
    expectHeld("dangling .claude", write("/tmp/dd/.claude/settings.json"), "floor-tamper");
    expectHeld("dangling settings", write("/tmp/dl/.claude/settings.json"), "floor-tamper");
    expectHeld("dangling claude.json", write("/tmp/dl/.claude.json"), "floor-tamper");
    expectHeld("dotdot", write("/tmp/h/../../fake/home/.claude/settings.json"), "floor-tamper");
    expectHeld("dotdot claude.json", write("/tmp/h/../../fake/home/.claude.json"), "floor-tamper");
    expectHeld("mktemp tail", bash("printf '{}' > \"$(mktemp -d)$HOME/.claude/settings.json\""), "floor-tamper");
    expectHeld("mktemp tail claude.json", bash("printf '{}' > \"$(mktemp -d)$HOME/.claude.json\""), "floor-tamper");
    expect(bash("D=$(mktemp -d); printf '{}' > \"${D:-$HOME}/.claude/settings.json\"").action).toBe("hold");
    expectHeld("shared temp dir", write("/tmp/.claude/settings.json"), "floor-tamper");
    expectHeld("shared temp claude.json", write("/tmp/.claude.json"), "floor-tamper");
    expectHeld("worktree", write(join(ROOT, ".claude", "settings.json")), "floor-tamper");
    expectHeld("worktree local", write(join(ROOT, ".claude", "settings.local.json")), "floor-tamper");
    expectHeld("worktree claude.json", write(join(ROOT, ".claude.json")), "floor-tamper");
    expectHeld("temp link to worktree", write("/tmp/wl/.claude/settings.json"), "floor-tamper");
    expectHeld("managed settings", write("/tmp/h/managed-settings.json"), "floor-tamper");
    expectHeld("managed mcp", write("/tmp/h/.claude/managed-mcp.json"), "floor-tamper");
  });

  test("settings files under a temp worktree or above it, a temp HOME or CLAUDE_CONFIG_DIR hold", () => {
    const o = { root: TMP_ROOT };
    expectHeld("temp worktree", write(join(TMP_ROOT, ".claude", "settings.json"), o), "floor-tamper");
    expectHeld("temp worktree nested", write(join(TMP_ROOT, "pkg", ".claude", "settings.json"), o), "floor-tamper");
    expectHeld("temp worktree claude.json", write(join(TMP_ROOT, ".claude.json"), o), "floor-tamper");
    expectHeld("above temp worktree", write("/tmp/wt/.claude/settings.json", o), "floor-tamper");
    expectHeld("above temp worktree local", bash("printf '{}' > /tmp/wt/.claude/settings.local.json", o), "floor-tamper");
    expectHeld("above temp worktree claude.json", write("/tmp/wt/.claude.json", o), "floor-tamper");
    const home = { home: "/tmp/wh" };
    expectHeld("temp HOME", write("/tmp/wh/.claude/settings.json", home), "floor-tamper");
    expectHeld("temp HOME claude.json", write("/tmp/wh/.claude.json", home), "floor-tamper");
    expectHeld("temp HOME bash", bash("printf '{}' > ~/.claude.json", home), "floor-tamper");
    const env = { CLAUDE_CONFIG_DIR: "/tmp/cfg" };
    expectHeld("config dir settings", write("/tmp/cfg/settings.json", { env }), "floor-tamper");
    expectHeld("config dir claude.json", write("/tmp/cfg/.claude.json", { env }), "floor-tamper");
    expectHeld("config dir dotted", write("/tmp/cfg/.claude/settings.json", { env: { CLAUDE_CONFIG_DIR: "/tmp/cfg/.claude" } }), "floor-tamper");
    expectHeld("relative config dir", write("/tmp/h/.claude/settings.json", { env: { CLAUDE_CONFIG_DIR: "cfg" } }), "floor-tamper");
    expectHeld("relative config dir claude.json", write("/tmp/h/.claude.json", { env: { CLAUDE_CONFIG_DIR: "cfg" } }), "floor-tamper");
  });

  test("a nested agent that would read a scratch HOME's settings holds on its own; one in the worktree runs", () => {
    for (const command of ["HOME=/tmp/h claude -p hi", "cd /tmp/h && claude -p hi"]) {
      const v = bash(command);
      expect({ command, category: v.action === "hold" && v.category }).toEqual({ command, category: "unseen-code" });
    }
    expect(bash("claude -p hi")).toEqual({ action: "allow" });
  });

  test("a nested agent pointed at another config dir holds", () => {
    expect(bash("CLAUDE_CONFIG_DIR=/tmp/h/.claude claude -p hi")).toMatchObject({ action: "hold", category: "floor-tamper" });
  });
});

describe("settings under a scratch HOME the worker made", () => {
  test.each([
    `${S}/rp5-home/.claude/settings.json`,
    `${S}/rp5-home/.claude/settings.local.json`,
    `${S}/rp5-home/.claude.json`,
    `${S}/h/.claude/settings.json`,
    `${S}/h/.claude.json`,
    `${S}/a/../h/.claude/settings.json`,
  ])("Write to %p is allowed", (path) => {
    expectAllowed(path, write(path));
  });

  test.each([
    `mkdir -p ${S}/rp5-home/.claude`,
    `> ${S}/rp5-home/.claude/settings.json`,
    `mkdir -p ${S}/rp5-home/.claude && > ${S}/rp5-home/.claude/settings.json`,
    `mkdir -p ${S}/h/.claude && echo '{}' > ${S}/h/.claude/settings.json`,
    `printf '{"hooks":{}}' > ${S}/h/.claude/settings.local.json`,
    `echo '{}' > ${S}/h/.claude.json`,
    "H=$(mktemp -d); mkdir -p \"$H/.claude\"; cat > \"$H/.claude/settings.json\" <<'EOF'\n{\"permissions\":{}}\nEOF",
    "H=$(mktemp -d); echo '{}' > \"$H/.claude.json\"",
    `cd ${S}/h && mkdir -p .claude && echo '{}' > .claude/settings.json`,
    `cp /tmp/r6-home/.claude/CLAUDE.md ${S}/h/.claude/settings.json`,
    `rm -f ${S}/h/.claude/settings.json ${S}/h/.claude.json`,
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });

  test("with an absolute CLAUDE_CONFIG_DIR elsewhere", () => {
    const env = { CLAUDE_CONFIG_DIR: "/tmp/cfg" };
    expectAllowed("settings", write(`${S}/h/.claude/settings.json`, { env }));
    expectAllowed("claude.json", write(`${S}/h/.claude.json`, { env }));
  });

  test("beside a temp worktree", () => {
    expectAllowed("sibling", write(`${S}/h/.claude/settings.json`, { root: TMP_ROOT }));
  });
});

describe("settings under a fixed name in the shared temp dir", () => {
  test.each(["/tmp/rp5-home/.claude/settings.json", "/tmp/rp5-home/.claude.json", "/tmp/h/.claude/settings.json", "/tmp/h/.claude.json", "/tmp/tt/.claude/settings.json"])(
    "Write to %p holds",
    (path) => {
      expectHeld(path, write(path), "floor-tamper");
    }
  );

  test.each([
    "> /tmp/rp5-home/.claude/settings.json",
    "mkdir -p /tmp/h/.claude && echo '{}' > /tmp/h/.claude/settings.json",
    "printf '{\"hooks\":{}}' > /tmp/h/.claude/settings.local.json",
    "echo '{}' > /tmp/h/.claude.json",
    "cd /tmp/h && mkdir -p .claude && echo '{}' > .claude/settings.json",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });
});

describe("a scratch `.claude` file with another hard link", () => {
  test.each(["/tmp/hl/.claude/settings.json", "/tmp/hl/.claude/CLAUDE.md", "/tmp/hl/.claude.json"])("Write and Edit of %p hold", (path) => {
    expectHeld(`write ${path}`, write(path), "floor-tamper");
    expectHeld(`edit ${path}`, edit(path), "floor-tamper");
  });

  test.each(["echo '{}' > /tmp/hl/.claude/settings.json", "printf x >> /tmp/hl/.claude/CLAUDE.md", "echo '{}' > /tmp/hl/.claude.json"])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test("a file with one link under the launch's scratch dir is still scratch", () => {
    expectAllowed("write", write(`${S}/hl/.claude/agents/a.md`));
    expectAllowed("edit", edit(`${S}/r6-home/.claude/CLAUDE.md`));
  });
});

describe("the worktree's own `.claude/` keeps today's behavior", () => {
  test("in the worktree", () => {
    expectHeld("settings", write(join(ROOT, ".claude", "settings.json")), "floor-tamper");
    expectHeld("CLAUDE.md", write(join(ROOT, ".claude", "CLAUDE.md")), "floor-tamper");
    expectHeld("agents", write(join(ROOT, ".claude", "agents", "x.md")), "floor-tamper");
    expectHeld("temp link to the worktree", write("/tmp/wl/.claude/CLAUDE.md"), "floor-tamper");
  });

  test("a worktree under the temp dir, and the dirs above it", () => {
    const o = { root: TMP_ROOT };
    expectHeld("own", write(join(TMP_ROOT, ".claude", "CLAUDE.md"), o), "floor-tamper");
    expectHeld("nested", write(join(TMP_ROOT, "pkg", ".claude", "CLAUDE.md"), o), "floor-tamper");
    // Claude Code reads the `.claude/` dirs of its working dir's ancestors.
    expectHeld("parent", write("/tmp/wt/.claude/CLAUDE.md", o), "floor-tamper");
    expectHeld("temp root", write("/tmp/.claude/CLAUDE.md", o), "floor-tamper");
    expectHeld("bash parent", bash("printf x > /tmp/wt/.claude/CLAUDE.md", o), "floor-tamper");
    expectAllowed("sibling", write(`${S}/h/.claude/CLAUDE.md`, o));
  });

  test("the temp dir's own `.claude/`", () => {
    expectHeld("write", write("/tmp/.claude/CLAUDE.md"), "floor-tamper");
  });
});

describe("a failed mktemp leaves its variable empty", () => {
  // The floor models `$(mktemp -d)` as printing a fresh temp name; at run time it may print nothing, and then `:-` takes the default.
  test.each([
    "D=$(mktemp -d); printf x > \"${D:-$HOME}/.claude/CLAUDE.md\"",
    "D=$(mktemp -d); printf x > \"${D:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); printf x > \"${D:=$HOME}/.bashrc\"",
    "D=`mktemp -d`; printf x > \"${D:-$HOME}/.claude/CLAUDE.md\"",
    "D=\"$(mktemp -d)\"; mkdir -p \"${D:-~}/.claude\"",
    "export D=$(mktemp -d); printf x > \"${D:-$HOME}/.bashrc\"",
    "declare D=$(mktemp -d); printf x > \"${D:-$HOME}/.bashrc\"",
    "f() { local D=$(mktemp -d); printf x > \"${D:-$HOME}/.bashrc\"; }; f",
    "readonly D=$(mktemp -d); printf x > \"${D:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); cd \"$D\" && mkdir -p .claude && printf x > .claude/CLAUDE.md",
    "D=$(mktemp -d) || D=$HOME; printf x > \"$D/.claude/CLAUDE.md\"",
    "cd ~ && D=$(mktemp -d); printf x > \"${D:+$D/}.claude/CLAUDE.md\"",
    "cd ~ && D=$(mktemp -d); cd \"$D\"; printf x > .claude/CLAUDE.md",
    // A copy of a substituted value may be just as empty.
    "D=$(mktemp -d); E=$D; printf x > \"${E:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); D=$D; printf x > \"${D:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); E=\"${D}\"; printf x > \"${E:-$HOME}/.claude/CLAUDE.md\"",
    "D=$(mktemp -d); E=${D%/}; printf x > \"${E:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); export E=$D; printf x > \"${E:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); declare E=\"$D\"; printf x > \"${E:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); D+=''; printf x > \"${D:-$HOME}/.bashrc\"",
    // A branch that may run, and the paths an if or case merges.
    "D=$(mktemp -d); if [ -n \"$X\" ]; then D=$D; fi; printf x > \"${D:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); [ -n \"$X\" ] && D=$D; printf x > \"${D:-$HOME}/.bashrc\"",
    "D=$(mktemp -d); case $X in a) D=$D ;; esac; printf x > \"${D:-$HOME}/.bashrc\"",
  ])("holds %p", (command) => {
    expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
  });

  test.each([
    // An empty `$D` makes the path `/.claude/…`, which no Claude Code reads.
    "D=$(mktemp -d); mkdir -p \"$D/.claude\" && printf x > \"$D/.claude/CLAUDE.md\"",
    // `-` without the colon keeps an empty value.
    "D=$(mktemp -d); printf x > \"${D-$HOME}/.claude/CLAUDE.md\"",
    // A literal value is never empty.
    `D=${S}/h; printf x > "\${D:-$HOME}/.claude/CLAUDE.md"`,
    // A later literal assignment replaces the substituted one.
    `D=$(mktemp -d); D=${S}/h; printf x > "\${D:-$HOME}/.claude/CLAUDE.md"`,
    // A hook written into the worktree's repository is unread.
    "D=$(mktemp -d); cd \"$D\" && printf x > .git/hooks/pre-commit",
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("a scratch HOME set through HOME stays Persona's to decide", () => {
  test.each([
    `HOME=${S}/h; mkdir -p $HOME/.claude && printf x > $HOME/.claude/CLAUDE.md`,
    `export HOME=${S}/h && mkdir -p "$HOME/.claude" && printf x > "$HOME/.claude/CLAUDE.md"`,
  ])("%p holds unclassified, not floor-tamper", (command) => {
    expectHeld(command, bash(command), "unclassified");
  });

  test.each([
    "HOME=/tmp/h; mkdir -p $HOME/.claude && printf x > $HOME/.claude/CLAUDE.md",
    "export HOME=/tmp/h && mkdir -p \"$HOME/.claude\" && printf x > \"$HOME/.claude/CLAUDE.md\"",
  ])("%p, at a fixed name in the shared temp dir, holds", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });
});

describe("a program run earlier in the command may have linked the scratch HOME to the real config", () => {
  test.each([
    "cp -a /tmp/evil/. /tmp/h/ && printf '{}' > /tmp/h/.claude/settings.json",
    "cp -r /tmp/evil/.claude /tmp/h/; printf x > /tmp/h/.claude/CLAUDE.md",
    "cp /tmp/evil/x /tmp/h/y && echo '{}' > /tmp/h/.claude.json",
    "mv /tmp/evil /tmp/h/.claude; printf x > /tmp/h/.claude/CLAUDE.md",
    "rsync -a /tmp/evil/ /tmp/h/ && printf '{}' > /tmp/h/.claude/settings.local.json",
    "tar -xf /tmp/a.tar -C /tmp/h && printf x > /tmp/h/.claude/agents/a.md",
    "unzip -o /tmp/a.zip -d /tmp/h && printf x > /tmp/h/.claude/CLAUDE.md",
    "git clone /tmp/repo /tmp/h/r && printf x > /tmp/h/r/.claude/CLAUDE.md",
    "git -C /tmp/h checkout x -- .claude && printf x > /tmp/h/.claude/CLAUDE.md",
    "git -C /tmp/h restore .claude && printf '{}' > /tmp/h/.claude/settings.json",
    "git worktree add /tmp/h/w && printf x > /tmp/h/w/.claude/CLAUDE.md",
    "ln -s ~/.claude /tmp/h/.c && printf x > /tmp/h/.claude/CLAUDE.md",
    "mytool /tmp/h && printf x > /tmp/h/.claude/CLAUDE.md",
    "sh -c 'cp -a /tmp/evil/. /tmp/h/; printf x > /tmp/h/.claude/CLAUDE.md'",
    "f() { cp -a /tmp/evil/. /tmp/h/; }; f; printf x > /tmp/h/.claude/CLAUDE.md",
    "H=$(cp -a /tmp/evil/. /tmp/h/) printf x > /tmp/h/.claude/CLAUDE.md",
    // The program that may place the link writes the scratch `.claude/` itself.
    "cp -a /tmp/lc /tmp/q/.claude",
    "cp -R /tmp/lc /tmp/q/.claude",
    "cp --no-dereference /tmp/lc /tmp/q/.claude",
    "mv /tmp/lc /tmp/q/.claude",
    "rsync -a /tmp/lc /tmp/q/.claude",
    "ln -s ~/.claude/settings.json /tmp/h/.claude/settings.json",
    // Alongside: a pipeline or a background step.
    "printf '{}' > /tmp/h/.claude/settings.json | cp -a /tmp/evil/. /tmp/h/",
    "printf x > /tmp/h/.claude/CLAUDE.md & tar -xf /tmp/a.tar -C /tmp/h",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test.each([
    `mkdir -p ${S}/h/.claude && touch ${S}/h/.claude/x && printf x > ${S}/h/.claude/CLAUDE.md`,
    `export X=1; cd ${S}/h && mkdir -p .claude && printf '{}' > .claude/settings.json`,
    `rm -rf ${S}/h/.claude && mkdir -p ${S}/h/.claude && echo '{}' > ${S}/h/.claude/settings.json`,
    `printf x > ${S}/h/.claude/CLAUDE.md && cp -a /tmp/evil/. /tmp/elsewhere/`,
    `cp -p /tmp/r6-home/.claude/CLAUDE.md ${S}/h/.claude/CLAUDE.md`,
    `cp -fL /tmp/r6-home/.claude/CLAUDE.md ${S}/h/.claude/settings.json`,
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("a brace-expanded field starting with `~` is tilde-expanded", () => {
  test.each([
    "tee {~,/tmp/h}/.claude/CLAUDE.md < /dev/null",
    "printf '{}' | tee {/tmp/h,~}/.claude/settings.json",
    "printf '{}' | tee {/tmp/h,~}/.claude.json",
    "touch {/tmp/h,~}/.claude/settings.json",
    "mkdir -p {/tmp/h,~}/.claude/agents",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test("a quoted `~` in braces stays literal", () => {
    expectAllowed("quoted", bash(`mkdir -p ${S}/h/.claude && touch {${S}/h,${S}/h/'~'}/.claude/x.md`));
  });
});

describe("`${V:+word}` on a substituted V is unresolvable", () => {
  test.each([
    "cd ~; D=$(mktemp -d); printf x > \"${D:+$D/}.claude/CLAUDE.md\"",
    "cd ~ && D=$(mktemp -d); printf '{}' > \"${D:+$D/}.claude/settings.json\"",
    "cd ~; D=$(mktemp -d); E=$D; printf x > \"${E:+$E/}.claude.json\"",
    // Whatever mktemp the shell finds: a function or PATH entry may make it print nothing, or anything.
    "mktemp() { :; }; cd ~; D=$(mktemp -d); printf x > \"${D:+$D/}.claude/CLAUDE.md\"",
    "mktemp() { echo ~; }; D=$(mktemp -d); printf '{}' > \"$D/.claude/settings.json\"",
    "PATH=/tmp/nobin; D=$(mktemp -d); printf x > \"${D:-$HOME}/.claude/settings.json\"",
    "PATH=/tmp/nobin; cd ~; D=$(mktemp -d); printf x > \"${D:+$D/}.claude/settings.json\"",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test("`+` without the colon still takes the word for an empty value", () => {
    expectAllowed("plus", bash("D=$(mktemp -d); mkdir -p \"${D+$D/}.claude\""));
  });
});

describe("other words a substitution's value reaches stay unresolvable under `:-`", () => {
  test.each([
    "for D in \"$(mktemp -d)\"; do printf x > \"${D:-$HOME}/.claude/settings.json\"; done",
    "for D in $(mktemp -d); do printf x > \"${D:-$HOME}/.claude/CLAUDE.md\"; done",
    "set -- \"$(mktemp -d)\"; printf x > \"${1:-$HOME}/.claude/settings.json\"",
    "D=$(mktemp -d); set -- \"$D\"; printf x > \"${1:-$HOME}/.claude/settings.json\"",
    "set -- x \"$(mktemp -d)\"; shift; printf x > \"${1:-$HOME}/.claude/settings.json\"",
    "f() { printf x > \"${1:-$HOME}/.claude/settings.json\"; }; f \"$(mktemp -d)\"",
    "f() { D=$1; printf x > \"${D:-$HOME}/.claude/settings.json\"; }; f \"$(mktemp -d)\"",
    "cd ~; f() { printf x > \"${1:+$1/}.claude/settings.json\"; }; f \"$(mktemp -d)\"",
    ": \"${D:=$(mktemp -d)}\"; printf x > \"${D:-$HOME}/.claude/settings.json\"",
    ": \"${D=$(mktemp -d)}\"; printf x > \"${D:-$HOME}/.claude/settings.json\"",
    "eval \"D=$(mktemp -d)\"; printf x > \"${D:-$HOME}/.claude/settings.json\"",
    "eval 'D=$(mktemp -d)'; printf x > \"${D:-$HOME}/.claude/settings.json\"",
    // A nested shell holds on its own, exported or passed the value.
    "D=$(mktemp -d); export D; bash -c 'printf x > \"${D:-$HOME}/.claude/settings.json\"'",
    "export D=$(mktemp -d); sh -c 'printf x > \"${D:+$D/}.claude/settings.json\"'",
    "bash -c 'printf x > \"${1:-$HOME}/.claude/settings.json\"' _ \"$(mktemp -d)\"",
    "D=$(mktemp -d) bash -c 'printf x > \"${D:-$HOME}/.claude/settings.json\"'",
    "D=$(mktemp -d); env D=$D sh -c 'printf x > \"${D:-$HOME}/.claude/settings.json\"'",
    "env D=\"$(mktemp -d)\" sh -c 'printf x > \"${D:+$D/}.claude/settings.json\"'",
    "D=$(mktemp -d) env sh -c 'printf x > \"${D:-$HOME}/.claude/settings.json\"'",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test.each([
    `for D in ${S}/h; do printf x > "\${D:-$HOME}/.claude/settings.json"; done`,
    `set -- ${S}/h; printf x > "\${1:-$HOME}/.claude/settings.json"`,
    `f() { printf x > "\${1:-$HOME}/.claude/settings.json"; }; f ${S}/h`,
    `: "\${D:=${S}/h}"; printf x > "\${D:-$HOME}/.claude/settings.json"`,
    `eval "D=${S}/h"; printf x > "\${D:-$HOME}/.claude/settings.json"`,
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("the real config is a symlink into the temp dir", () => {
  const o = { home: LINKED_HOME };
  test.each([
    "/tmp/realc/.claude/settings.json",
    "/tmp/realc/.claude/settings.local.json",
    "/tmp/realc/.claude/CLAUDE.md",
    "/tmp/realc/.claude/agents/x.md",
    "/tmp/realc/cj.json",
    "/fake/home2/.claude/settings.json",
    "/fake/home2/.claude/CLAUDE.md",
    "/fake/home2/.claude.json",
  ])("Write to %p holds", (path) => {
    expectHeld(path, write(path, o), "floor-tamper");
  });

  test.each([
    "printf '{}' > /tmp/realc/.claude/settings.json",
    "printf x > /tmp/realc/.claude/CLAUDE.md",
    "echo '{}' > /tmp/realc/cj.json",
    "printf '{}' > ~/.claude/settings.json",
    "rm -rf /tmp/realc",
    "rm -f /tmp/realc/cj.json",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command, o), "floor-tamper");
  });

  test("the worker's own memory there is still scratch", () => {
    expectAllowed("memory", write("/fake/home2/.claude/projects/p/memory/MEMORY.md", o));
    expectAllowed("memory canonical", write("/tmp/realc/.claude/projects/p/memory/MEMORY.md", o));
    expectAllowed("other scratch", write(`${S}/h/.claude/settings.json`, o));
  });
});

describe("mktemp options", () => {
  test.each([
    // Clustered and attached -p: the dir is the real config, not the temp dir.
    "D=$(mktemp -dp \"$HOME/.claude\"); printf x > \"$D/x.md\"",
    "D=$(mktemp -dp \"$HOME/.claude\" tmp.XXXXXX); printf x > \"$D/x.md\"",
    "D=$(mktemp -d -p\"$HOME/.claude\"); printf x > \"$D/x.md\"",
    "D=$(mktemp -dp\"$HOME/.claude\"); printf x > \"$D/x.md\"",
    "D=$(mktemp -d --tmpdir=\"$HOME/.claude\"); printf x > \"$D/x.md\"",
    // A template without -p is relative to the cwd.
    "cd ~/.claude && D=$(mktemp -d tmp.XXXXXX) && printf x > \"$D/x.md\"",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test.each([
    // Options and templates the floor isn't sure of leave the name unknown.
    "D=$(mktemp -dz); printf x > \"$D/.claude/x.md\"",
    "D=$(mktemp --dir); printf x > \"$D/.claude/x.md\"",
    "D=$(mktemp -d /tmp/noxs); printf x > \"$D/.claude/x.md\"",
    "D=$(mktemp -d --tmpdir /tmp/abs.XXXXXX); printf x > \"$D/.claude/x.md\"",
    "D=$(mktemp -dt a/b.XXXXXX); printf x > \"$D/.claude/x.md\"",
  ])("leaves %p unresolved", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test.each([
    "H=$(mktemp -dp /tmp); mkdir -p \"$H/.claude\"; printf x > \"$H/.claude/CLAUDE.md\"",
    "H=$(mktemp -d -p/tmp r6.XXXXXX); mkdir -p \"$H/.claude\"; printf x > \"$H/.claude/CLAUDE.md\"",
    "H=$(mktemp -qdt r6.XXXXXX); mkdir -p \"$H/.claude\"; printf x > \"$H/.claude/CLAUDE.md\"",
    "H=$(mktemp -d --suffix=.d /tmp/r6.XXXXXX); mkdir -p \"$H/.claude\"; printf x > \"$H/.claude/CLAUDE.md\"",
  ])("allows %p", (command) => {
    expectAllowed(command, bash(command));
  });
});

describe("a glob write target is checked against what it matches", () => {
  test.each([
    // /tmp/lc links to ~/.claude, /tmp/lh to the home dir, /tmp/h2/.claude to ~/.claude.
    "printf '{}' > /tmp/l?/settings.json",
    "printf x > /tmp/l[c]/CLAUDE.md",
    "echo '{}' > /tmp/l*/.claude.json",
    "printf '{}' > /tmp/h[2]/.claude/settings.json",
    "printf x > /tmp/h?/.claude/CLAUDE.md",
    "rm -f /tmp/l?/settings.json",
    "ln -s ~/.claude /tmp/zz1 ; printf '{}' > /tmp/zz?/settings.json",
  ])("holds %p", (command) => {
    expectHeld(command, bash(command), "floor-tamper");
  });

  test("a glob matching only scratch dirs is checked like them", () => {
    expectAllowed("scratch", bash("printf x > /tmp/r6-hom[e]/x.md"));
  });
});
