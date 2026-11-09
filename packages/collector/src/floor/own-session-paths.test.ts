import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * What belongs to the calling worker besides its worktree: its launch's own
 * scratch dir, and its own Claude Code session's workflow scripts and tool
 * results under `~/.claude/projects/<worktree slug>/<session id>/`. The
 * session id is the hook payload's. A heredoc `cat` writes into the own
 * scratch dir doesn't count toward the climb check when the rest of the
 * call only reads content (wc, grep, diff). The same paths for another
 * launch, another session or another worktree's slug still hold, as do the
 * scratch root, the Claude settings, hooks and agents, and Standup's data dir.
 */

const HOME = join("/", "local", "home", "u");
const ROOT = join(HOME, ".local", "share", "standup", "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const ID = "a1a1a1a1-0000-4000-8000-0000000000a1";
const OTHER = "a2a2a2a2-0000-4000-8000-0000000000a2";
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-2222-4333-8444-555555555555";
const SLUG = "-local-home-u--local-share-standup-worktrees-standup-feat-1";
const OTHER_SLUG = "-local-home-u--local-share-standup-worktrees-standup-feat-2";
const DATA = join(HOME, ".local", "share", "standup");
const SCRATCH_ROOT = join(HOME, ".cache", "standup-scratch");
const S = join(SCRATCH_ROOT, ID);
const O = join(SCRATCH_ROOT, OTHER);
const CLAUDE = join(HOME, ".claude");
const sessionDir = (slug: string, session: string) => join(CLAUDE, "projects", slug, session);
const scriptOf = (slug: string, session: string) => join(sessionDir(slug, session), "workflows", "scripts", "w.js");
const resultOf = (slug: string, session: string) => join(sessionDir(slug, session), "tool-results", "r.json");

const CONFIG: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: ID,
  scratchRoot: SCRATCH_ROOT,
  scratchDir: S,
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
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(S, "a.txt")]: "x\n",
  [join(O, "a.txt")]: "x\n",
  [join(CLAUDE, "settings.json")]: "{}\n",
  [join(CLAUDE, "settings.local.json")]: "{}\n",
  [join(HOME, ".claude.json")]: "{}\n",
  [join(CLAUDE, "hooks", "h.sh")]: "x\n",
  [join(CLAUDE, "agents", "a.md")]: "x\n",
  [join(sessionDir(SLUG, SESSION), "settings.json")]: "{}\n",
  [join(DATA, "standup.db")]: "x\n",
};
for (const slug of [SLUG, OTHER_SLUG]) {
  for (const session of [SESSION, OTHER_SESSION]) {
    FILES[scriptOf(slug, session)] = "x\n";
    FILES[resultOf(slug, session)] = "{}\n";
  }
}

/** Probes over FILES, with the shell snapshot `snapshot`, `links` as dangling symlinks and `env` on top of HOME and TMPDIR. */
function probes(snapshot = "", links: ReadonlySet<string> = new Set(), env: Record<string, string> = {}): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot(snapshot, defs);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? COMMON : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    executable: () => false,
    isDirectory: (p) => dirs.has(p),
    listDir: () => null,
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    lstat: (p) => (links.has(p) ? { symlink: true, file: false, nlink: 1 } : p in FILES ? { symlink: false, file: true, nlink: 1 } : dirs.has(p) ? { symlink: false, file: false, nlink: 1 } : null),
    homeDir: () => HOME,
    env: (name) => ({ HOME, TMPDIR: S, ...env })[name],
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

let savedTmp: string | undefined;
beforeEach(() => {
  savedTmp = process.env.TMPDIR;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
});

type Case = [string, Record<string, unknown>];
/** A call from session `sessionId`; null for a payload that names none. */
const call = (toolName: string, toolInput: Record<string, unknown>, sessionId: string | null = SESSION, p: Partial<FloorProbes> = probes()): FloorVerdict => {
  process.env.TMPDIR = S;
  return classifyToolCall({ toolName, toolInput, cwd: ROOT, ...(sessionId === null ? {} : { sessionId }) }, CONFIG, p);
};

/** A brief with a climb in it, as a review brief or design note spells one. */
const BRIEF = "# Review\nSee `a/../b` and path.dirname(x)\n";
const writeBrief = (dir: string, then: string) => `mkdir -p ${dir}/r && cat > ${dir}/r/brief.md <<'EOF'\n${BRIEF}EOF\n${then}`;
/** Python that writes a file and names `path`: what a named path's write may land on isn't known. */
const pyReads = (path: string) => `cd ${S} && python3 -c 'import json; d=json.load(open("${path}")); open("out.json","w").write(json.dumps(d))'`;

describe("the launch's own scratch dir", () => {
  test.each<Case>([
    ["Bash", { command: writeBrief(S, `wc -l ${S}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `grep -n Review ${S}/r/brief.md | head -3`) }],
    ["Bash", { command: writeBrief(S, `diff ${S}/r/brief.md ${S}/a.txt; ls ${S}/r`) }],
    ["Write", { file_path: `${S}/n.txt`, content: BRIEF }],
  ])("%s %p is allowed", (tool, input) => {
    expect(call(tool, input)).toEqual({ action: "allow" });
  });

  test.each<Case>([
    ["Bash", { command: writeBrief(O, `wc -l ${O}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `wc -l ${O}/a.txt`) }],
    ["Bash", { command: writeBrief(S, `wc --files0-from=${S}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `wc --files ${S}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `sort --compress-program=sh ${S}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `uniq ${S}/r/brief.md ${S}/r/out.md`) }],
    ["Bash", { command: `grep() { rg "$@"; }\n${writeBrief(S, `grep --pre sh . ${S}/r/brief.md`)}` }],
    ["Bash", { command: writeBrief(S, `python3 ${S}/r/brief.md`) }],
    ["Bash", { command: writeBrief(S, `grep -n x "$(dirname ${S})"`) }],
    ["Bash", { command: `ls ${SCRATCH_ROOT}` }],
    ["Write", { file_path: `${SCRATCH_ROOT}/n.txt`, content: "x" }],
    ["Write", { file_path: `${O}/n.txt`, content: "x" }],
  ])("%s %p holds", (tool, input) => {
    expect(call(tool, input).action).toBe("hold");
  });

  const b64 = (s: string) => Buffer.from(s).toString("base64");
  test.each([
    "alias grep='rg'",
    "alias -- grep='rg --pre sh'",
    'grep () {\n  rg "$@"\n}',
    'grep () \n{ \n    rg "$@"\n}',
    'grep() { rg "$@"; }',
    `eval "$(echo '${b64('grep () {\n  rg "$@"\n}\n')}' | base64 -d)" > /dev/null 2>&1`,
    `eval "$(printf %s x)"`,
    "source /tmp/defs.sh",
  ])("a reader the shell snapshot redefines, or may (%p), holds", (snapshot) => {
    expect(call("Bash", { command: writeBrief(S, `grep --pre sh . ${S}/r/brief.md`) }, SESSION, probes(snapshot)).action).toBe("hold");
  });

  test.each([
    "",
    "alias -- grep='grep --color=auto'\nalias -- ls='ls --color=tty'",
    `eval "$(echo '${b64('ll () {\n  ls -l "$@"\n}\n')}' | base64 -d)" > /dev/null 2>&1`,
  ])("a snapshot that leaves the reader the program itself (%p) still allows", (snapshot) => {
    expect(call("Bash", { command: writeBrief(S, `grep -n Review ${S}/r/brief.md`) }, SESSION, probes(snapshot))).toEqual({ action: "allow" });
    expect(call("Bash", { command: writeBrief(S, `grep --pre sh . ${S}/r/brief.md`) }, SESSION, probes(snapshot))).toEqual({ action: "allow" });
  });
});

describe("the calling session's own workflow scripts", () => {
  const own = scriptOf(SLUG, SESSION);
  test.each<Case>([
    ["Edit", { file_path: own, old_string: "x", new_string: "y" }],
    ["Write", { file_path: own, content: "y" }],
    ["Write", { file_path: join(sessionDir(SLUG, SESSION), "workflows", "scripts", "new.js"), content: "y" }],
    ["Bash", { command: `echo y > ${own}` }],
  ])("%s %p is allowed", (tool, input) => {
    expect(call(tool, input)).toEqual({ action: "allow" });
  });

  test.each<Case>([
    ["Edit", { file_path: scriptOf(SLUG, OTHER_SESSION), old_string: "x", new_string: "y" }],
    ["Edit", { file_path: scriptOf(OTHER_SLUG, SESSION), old_string: "x", new_string: "y" }],
    ["Write", { file_path: join(sessionDir(SLUG, SESSION), "workflows", "w.js"), content: "y" }],
    ["Write", { file_path: join(sessionDir(SLUG, SESSION), "settings.json"), content: "{}" }],
    ["Bash", { command: `echo y > ${scriptOf(SLUG, OTHER_SESSION)}` }],
  ])("%s %p holds", (tool, input) => {
    expect(call(tool, input).action).toBe("hold");
  });

  test("without a session id in the payload, or one that isn't a plain name, it holds", () => {
    expect(call("Edit", { file_path: own, old_string: "x", new_string: "y" }, null).action).toBe("hold");
    expect(call("Edit", { file_path: scriptOf(SLUG, ".."), old_string: "x", new_string: "y" }, "..").action).toBe("hold");
  });

  test("the session's project dir (CLAUDE_PROJECT_DIR) names a slug of its own; unset or relative, it names none", () => {
    const project = join(ROOT, "src", "Pkg");
    const script = scriptOf(project.replace(/[^A-Za-z0-9]/g, "-"), SESSION);
    const edit = { file_path: script, old_string: "x", new_string: "y" };
    expect(call("Edit", edit, SESSION, probes("", new Set(), { CLAUDE_PROJECT_DIR: project }))).toEqual({ action: "allow" });
    expect(call("Edit", edit, SESSION, probes()).action).toBe("hold");
    expect(call("Edit", edit, SESSION, probes("", new Set(), { CLAUDE_PROJECT_DIR: "src/Pkg" })).action).toBe("hold");
    expect(call("Edit", edit, OTHER_SESSION, probes("", new Set(), { CLAUDE_PROJECT_DIR: project })).action).toBe("hold");
  });

  test("a dangling link in the own session's path, which a write follows, holds", () => {
    const scripts = join(sessionDir(SLUG, SESSION), "workflows", "scripts");
    for (const link of [join(scripts, "dl.js"), scripts, sessionDir(SLUG, SESSION), join(CLAUDE, "projects", SLUG)]) {
      const p = probes("", new Set([link]));
      expect(call("Write", { file_path: join(scripts, "dl.js"), content: "{}" }, SESSION, p).action).toBe("hold");
      expect(call("Bash", { command: `echo x > ${join(scripts, "dl.js")}` }, SESSION, p).action).toBe("hold");
    }
  });
});

describe("the calling session's own tool results", () => {
  test.each<Case>([
    ["Read", { file_path: resultOf(SLUG, SESSION) }],
    ["Bash", { command: `jq . ${resultOf(SLUG, SESSION)} | head` }],
    ["Bash", { command: pyReads(resultOf(SLUG, SESSION)) }],
  ])("%s %p is allowed", (tool, input) => {
    expect(call(tool, input)).toEqual({ action: "allow" });
  });

  test.each<Case>([
    ["Bash", { command: pyReads(resultOf(SLUG, OTHER_SESSION)) }],
    ["Bash", { command: pyReads(resultOf(OTHER_SLUG, SESSION)) }],
  ])("%s %p holds", (tool, input) => {
    expect(call(tool, input).action).toBe("hold");
  });

  test("without a session id in the payload it holds", () => {
    expect(call("Bash", { command: pyReads(resultOf(SLUG, SESSION)) }, null).action).toBe("hold");
  });
});

describe("the Claude config and Standup's data dir stay held for the session", () => {
  test.each<Case>([
    ["Write", { file_path: join(CLAUDE, "settings.json"), content: "{}" }],
    ["Edit", { file_path: join(CLAUDE, "settings.local.json"), old_string: "{}", new_string: "[]" }],
    ["Write", { file_path: join(HOME, ".claude.json"), content: "{}" }],
    ["Write", { file_path: join(CLAUDE, "hooks", "h.sh"), content: "x" }],
    ["Write", { file_path: join(CLAUDE, "agents", "a.md"), content: "x" }],
    ["Write", { file_path: join(sessionDir(SLUG, OTHER_SESSION), "x.js"), content: "x" }],
    ["Write", { file_path: join(DATA, "standup.db"), content: "x" }],
    ["Bash", { command: pyReads(join(CLAUDE, "settings.json")) }],
    ["Bash", { command: pyReads(join(DATA, "standup.db")) }],
  ])("%s %p holds", (tool, input) => {
    expect(call(tool, input).action).toBe("hold");
  });
});
