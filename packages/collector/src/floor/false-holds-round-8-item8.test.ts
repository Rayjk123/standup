import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";
import { parseShell } from "./shell.js";

/*
 * zsh's split flag `${=name}` / `$=name` splits the value into words on IFS
 * even inside double quotes (and doesn't glob them). The floor reads it as an
 * unquoted bash `$name`: a known value gives the words it splits into, which
 * are classified as any argv is; an unknown value is an unknown unquoted
 * expansion. Splitting never re-reads the value as shell syntax, so `;` or
 * `$(…)` in it are plain text, never a command and never a safe program name.
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
  [join(ROOT, "a.ts")]: "export const a = 1;\n",
  [join(ROOT, "b.ts")]: "export const b = 1;\n",
  [join(ROOT, "notes.txt")]: "a\nb\nc\n",
  [join(ROOT, "src", "x.ts")]: "export const x = 1;\n",
  [join(DATA, "secrets", "token")]: "s3cret\n",
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

/** The parts of a verdict that don't quote the command back. */
function shape(v: FloorVerdict): unknown {
  return v.action === "hold" ? { action: v.action, category: v.category, highRisk: (v as { highRisk?: boolean }).highRisk } : v;
}

describe("zsh split flag ${=name}", () => {
  test.each([
    'files="a.ts b.ts"; bun test ${=files}',
    'files="a.ts b.ts"; bun test $=files',
    'files="a.ts b.ts"; bun test "${=files}"',
    "for f in ${=list}; do echo $f; done",
    'list="a.ts b.ts"; for f in ${=list}; do echo $f; done',
    'args="-n 5"; head ${=args} notes.txt',
    "ls ${=dirs}",
    'dirs="src /tmp"; ls ${=dirs}',
    'v="a b"; echo "${=v}"',
    "echo $=v",
    'echo "$=v"',
    "echo ${=v:-x}",
    'echo ${=v:-"a.ts b.ts"}',
    'v="a b"; printf "[%s]\\n" ${=v}x',
    "v='; rm -rf /'; echo ${=v}",
    "v='$(rm -rf /)'; echo ${=v}",
    'cmd="git status"; ${=cmd}',
    'cmd="ls -la src"; $=cmd',
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    // A known value is classified as the words it splits into.
    ['cmd="git push origin main"; ${=cmd}', "git push origin main"],
    ['cmd="git push origin main"; $=cmd', "git push origin main"],
    ['cmd="git push origin main"; "${=cmd}"', "git push origin main"],
    ['cmd="git push"; ${=cmd} origin main', "git push origin main"],
    [`x="${join(DATA, "secrets", "token")} /etc/passwd"; rm \${=x}`, `rm ${join(DATA, "secrets", "token")} /etc/passwd`],
    [`x="${join(DATA, "secrets", "token")}"; cat \${=x}`, `cat ${join(DATA, "secrets", "token")}`],
    // An unknown value is an unknown unquoted expansion.
    ["${=cmd}", "$cmd"],
    ["$=cmd", "$cmd"],
    ['"${=cmd}" origin main', "$cmd origin main"],
    ["rm -rf ${=x}", "rm -rf $x"],
    ["rm -rf $=x", "rm -rf $x"],
    ["${=cmd:-git} push origin main", "${cmd:-git} push origin main"],
    ["v='rm -rf /'; ${=v}", "rm -rf /"],
    ["v='/bin/rm -rf /'; ${=v}", "/bin/rm -rf /"],
  ])("holds %p as %p", (command, equivalent) => {
    const v = bash(command);
    expect(v.action).toBe("hold");
    expect(shape(v)).toEqual(shape(bash(equivalent)));
  });

  test.each([
    // A value from a command substitution is tracked through the split as through `$name`.
    ["D=$(mktemp -d); rm -rf ${=D}", "D=$(mktemp -d); rm -rf $D"],
    ["D=$(mktemp -d); rm -rf ${=D:-/tmp/x}/y", "D=$(mktemp -d); rm -rf ${D:-/tmp/x}/y"],
    ['D=$(cat notes.txt); export X="${=D}"', "D=$(cat notes.txt); export X=$D"],
    // `;` and `$(…)` in the value are text after splitting: the words run as the program literally named by
    // the first, never as a command list or a substitution.
    ["v='; rm -rf /'; ${=v}", "';' rm -rf /"],
    ["v='$(rm -rf /)'; ${=v}", "'$(rm' -rf '/)'"],
    ["v='; rm -rf /'; ${=v}", "v='; rm -rf /'; $v"],
    ["v='$(rm -rf /)'; ${=v}", "v='$(rm -rf /)'; $v"],
    ["v='x; git push origin main'; echo ${=v}", "echo 'x;' git push origin main"],
    // The public knowledge socket variable is read through the split too.
    ["echo ${=STANDUP_PUBLIC_KB_SOCKET}", "echo $STANDUP_PUBLIC_KB_SOCKET"],
    ["echo $=STANDUP_PUBLIC_KB_SOCKET", "echo $STANDUP_PUBLIC_KB_SOCKET"],
    // A split double-quoted sed script is not one word.
    ['x="1p w /etc/x"; sed -n "${=x}" notes.txt', "x='1p w /etc/x'; sed -n $x notes.txt"],
    ["sed -n \"${=x}\" notes.txt", "sed -n $x notes.txt"],
  ])("reads %p as %p", (command, equivalent) => {
    expect(shape(bash(command))).toEqual(shape(bash(equivalent)));
  });

  test.each([
    // zsh flags the floor doesn't model stay unread.
    "echo ${(s: :)v}",
    "echo ${==v}",
    "echo ${=~v}",
  ])("leaves %p unparsed", (command) => {
    expect(parseShell(command).ok).toBe(false);
  });

  test("reads ${=name} as an unquoted $name, inside double quotes too", () => {
    for (const command of ['echo "${=v}"', "echo ${=v}", 'echo "$=v"', "echo $=v"]) {
      const r = parseShell(command);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const c = r.script.items[0]!.node.first.commands[0]!;
      if (c.kind !== "simple") throw new Error("not simple");
      expect(c.words[1]!.segments).toMatchObject([{ kind: "param", name: "v", quoted: false }]);
    }
  });
});
