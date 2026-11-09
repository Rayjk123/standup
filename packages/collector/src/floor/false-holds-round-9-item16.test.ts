import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A double-quoted sed script that is one `s` command, with `$name` or
 * `${name}` only in its pattern or replacement and no `w`, `W` or `e` flag,
 * reads and prints when every expanded value is known to hold no delimiter,
 * newline or backslash: a literal, a loop word, or digits. A value the floor
 * can't read stays held, since it may close the delimiter and add a flag. So
 * does an expansion in the flags or as the whole script, and `-i`.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
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

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "f")]: "a\nb\nc\n",
  [join(ROOT, "file")]: "a\nb\nc\n",
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

describe("16. a sed s command with expansions in its text", () => {
  test.each([
    `b=foo; sed "s|^|$b: |" file`,
    `b=foo; sed "s|^|\${b}: |" file`,
    `b=foo; c=bar; sed "s|^|$b/\${c}: |" file`,
    `b=foo; sed -n "s|^|$b: |p" file`,
    `b=foo; sed "s|^|$b: |g" file`,
    `b=foo; sed -E "s|^(.)|$b: \\1|" file`,
    `b=foo; sed -e "s|^|$b: |" file`,
    `b=foo; sed "s|$| $b|" file`,
    `p=foo; sed "s|$p|bar|" file`,
    `b=a/b; sed "s|^|$b: |" file`,
    `b=$(grep -c x f); sed "s|^|$b: |" file`,
    `i=3; n=$((i+1)); sed "s/^/$n: /" file`,
    `for b in a c; do sed "s|^|$b: |" file; done`,
    `sed "s|^|x: |" file`,
    // Under --sandbox sed refuses `w`, `W`, `e` and `r`, whatever the value closes.
    `sed --sandbox "s|^|$b: |" file`,
    `b='x|w /fake/home/.bashrc'; sed --sandbox -e "s|^|$b: |" file`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    // A value the floor can't read may close the delimiter: b='x|w /tmp/f' gives `s|^|x|w /tmp/f: |`, which writes.
    `sed "s|^|$b: |" file`,
    `sed "s|^|\${b}: |" file`,
    `b=$(cat payload); sed "s|^|$b: |" file`,
    `sed "s|$p|x|" file`,
    `b=foo; sed "s|^|$b $c|" file`,
    // Arithmetic over an untracked operand isn't known to give digits (zsh: `i='[##36] 32'`).
    `n=$((i+1)); sed "s/^/$n: /" file`,
    // A known value holding the delimiter, a newline or a backslash.
    `b='x|w /tmp/f'; sed "s|^|$b: |" file`,
    `b='x|w /fake/home/.bashrc'; sed "s|^|$b: |" file`,
    `b=$'x\\nw /fake/home/.bashrc'; sed "s|^|$b: |" file`,
    `b='x\\'; sed "s|$b|w /fake/home/.bashrc|" file`,
    `b='a/b'; sed "s/^/$b: /" file`,
    // An expansion in the flags, as the delimiter, or as the whole script.
    `sed "s|a|b|$f" file`,
    `sed "s$d^$dx$d" file`,
    `sed "$x" file`,
    `sed -e "$x" file`,
    // Flags that write or run, and -i.
    `sed "s|a|$b|e" file`,
    `sed "s|a|$b|w /fake/home/.bashrc" file`,
    `b=foo; sed "s|a|$b|w /fake/home/.bashrc" file`,
    `b=$(grep -c x f); sed -i "s|^|$b: |" file`,
    `sed -i "s|^|$b: |" file`,
    // zsh reads a subscript or a modifier after a bare name.
    `sed "s|^|$b[1]: |" file`,
    `sed "s|^|$b:s/x/y/|" file`,
    `sed "s|^|$(cat payload)|" file`,
  ])("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });
});
