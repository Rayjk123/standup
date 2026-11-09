import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `sed -n` with a script that is only a line range (or one line) followed by
 * `p`, its addresses built from variables, `${…}` or `$((…))`
 * (`sed -n "$n,${e}p" $f`, `sed -n "$((e-6)),$((e+1))p" $f`), reads like
 * `sed -n '10,20p' $f` when every variable in it holds only digits or is
 * unset: unset outside arithmetic it expands to nothing, and what is left is
 * address characters and `p`, which sed prints or refuses. A loop variable
 * bound to items that expand to digits only (`for e in $(grep -n re f | cut
 * -d: -f1)`) holds digits in the body. A value the floor can't place may
 * carry a newline and a `w` or `e` command (`n=$'1w /x\n1'`), so it stays
 * held, as do `-i`, a missing `-n`, other commands and command substitutions
 * that may print anything.
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
  [join(ROOT, "notes.txt")]: "a\nb\nc\n",
  [join(ROOT, "x")]: `1w ${join(HOME, ".bashrc")}\n1\n`,
  [join(ROOT, "set-x.sh")]: "x=$(git log -1 --format=%s)\n",
};

function probes(env: Record<string, string>): Partial<FloorProbes> {
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
    env: (name) => env[name],
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, env: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(env));
}

const F = "f=notes.txt; ";
const GREP = "$(grep -n b $f | cut -d: -f1)";
// A value the floor can't place.
const V = "$(git log -1 --format=%s)";

describe("sed -n printing a line range built from variables", () => {
  test.each([
    `${F}sed -n "$((e-6)),$((e+1))p" $f`,
    `${F}n=10; e=20; sed -n "$n,\${e}p" $f`,
    `${F}e=20; sed -n "$((e-6)),$((e+1))p" $f`,
    `${F}for n in 10 40; do e=$((n+5)); sed -n "$n,\${e}p" $f; done`,
    `${F}for e in ${GREP}; do sed -n "$((e-6)),$((e+1))p" $f; done`,
    `${F}for n in ${GREP}; do e=$((n+5)); sed -n "$n,\${e}p" $f; done`,
    `${F}for n in ${GREP}; do sed -n "\${n}p" $f; done`,
    `${F}for n in 3 ${GREP}; do sed -n "$n,$((n+2))p" $f; done`,
    `${F}n=$(grep -n b $f | head -1 | cut -d: -f1); e=$((n+20)); sed -n "$n,\${e}p" $f`,
    // The unknown value below is held for the sed script alone.
    `${F}n=$(git log -1 --format=%s); sed -n '1,5p' $f`,
  ])("allowed: %s", (cmd) => {
    expect(bash(cmd)).toEqual({ action: "allow" });
  });
});

describe("sed scripts from variables that may write or run stay held", () => {
  test.each([
    // A value the floor can't place may carry `w`/`e` on a line of its own.
    `${F}n=$(cat x); sed -n "$n,5p" $f`,
    `${F}n=$(git log -1 --format=%s); sed -n "$n,5p" $f`,
    `${F}n=$(git log -1 --format=%s); e=$((n+5)); sed -n "$n,\${e}p" $f`,
    `${F}for n in $(git log --format=%s); do sed -n "\${n}p" $f; done`,
    `${F}for n in ${GREP}; do n=$(git log -1 --format=%s); sed -n "\${n}p" $f; done`,
    // A loop that runs no pass leaves the variable as it was.
    `${F}n=$(git log -1 --format=%s); for n in ${GREP}; do :; done; sed -n "\${n}p" $f`,
    `${F}for n in ${GREP}; do :; done; sed -n "\${n}p" $f`,
    // Not only a printed range.
    `${F}sed -i -n "$n,\${e}p" $f`,
    `${F}sed -n "$n,\${e}p" -i $f`,
    `${F}sed -n "$a,\${b}p" -i $f`,
    `${F}sed -n "$s" $f`,
    `${F}sed -n "\${n}w out" $f`,
    `${F}sed -n "$n,\${e}p;w x" $f`,
    `${F}sed -n "$(cat x)p" $f`,
    `${F}sed -n "$(git log -1 --format=%s)p" $f`,
    `${F}sed -n "$n"e $f`,
    `${F}sed -n "\${n}\${cmd}" $f`,
    `${F}cmd=$(git log -1 --format=%s); sed -n "\${n}\${cmd}p" $f`,
  ])("held: %s", (cmd) => {
    expect(bash(cmd).action).toBe("hold");
  });

  // Outside `$((…))` a name nothing in the command sets still stays held, as on base: the shell has too many ways
  // (traps, globbed names, zsh's maps, autoload) to set one out of the floor's sight.
  test.each([
    `${F}sed -n "$n,\${e}p" $f`,
    `${F}sed -n "\${n}p" $f`,
    `${F}sed -n -e "$n,\${e}p" $f`,
    `${F}sed -n "$n,+\${e}p" $f`,
    `sed -n "$n,\${e}p" notes.txt | head -5`,
    `sed -n $n,\${e}p notes.txt`,
    `sed -n "1,\${N}p" notes.txt`,
    `printf -v ? '%s' '1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `read -r ? <<< '1e rm -rf ~/.ssh'; sed -n "$x,5p" notes.txt`,
    `functions[f]="$(cat /tmp/t)"; f; sed -n "\${x}p" notes.txt`,
  ])("held: %s", (cmd) => {
    expect(bash(cmd).action).toBe("hold");
  });

  test.each([
    `: "\${x:=${V}}"; sed -n "\${x}p" notes.txt`,
    `: "\${x=${V}}"; sed -n "\${x}p" notes.txt`,
    `: \${x:=${V}}; sed -n "\${x}p" notes.txt`,
    `echo "\${x:=${V}}" "\${x=1}"; sed -n "\${x}p" notes.txt`,
    `f() { x=${V}; }; f; sed -n "\${x}p" notes.txt`,
    `f() { x=${V}; }; sed -n "\${x}p" notes.txt; f; sed -n "\${x}p" notes.txt`,
    `f() { sed -n "\${x}p" notes.txt; }; x=${V} f`,
    `for i in 1 2; do sed -n "\${x}p" notes.txt; x=${V}; done`,
    `while :; do sed -n "\${x}p" notes.txt; x=${V}; done`,
    `for i in 1 2; do sed -n "\${x}p" notes.txt; . ./env.sh; done`,
    `trap 'x=${V}' DEBUG; sed -n "\${x}p" notes.txt`,
    `declare -n x=y; y=${V}; sed -n "\${x}p" notes.txt`,
    `x[0]=${V}; sed -n "\${x}p" notes.txt`,
    `x=1 . ./env.sh; sed -n "\${x}p" notes.txt`,
    `command . ./env.sh; sed -n "\${x}p" notes.txt`,
    `builtin source ./env.sh; sed -n "\${x}p" notes.txt`,
    `builtin eval "x=${V}"; sed -n "\${x}p" notes.txt`,
    `source ./set-x.sh; sed -n "\${x}p" notes.txt`,
    `. ./set-x.sh; sed -n "$x,5p" notes.txt`,
    `function f { x=${V}; }; f; sed -n "\${x}p" notes.txt`,
    `f() { x=${V}; }; f; sed -n "$x,5p" notes.txt`,
    `f() { x=${V}; }; f; sed -n "$x,\${e}p" notes.txt`,
    `source ./env.sh; sed -n "\${x}p" notes.txt`,
    `. ./env.sh; sed -n "\${x}p" notes.txt`,
    `source ./env.sh; sed -n "$x,\${e}p" notes.txt`,
    `eval "x=${V}"; sed -n "\${x}p" notes.txt`,
    `eval 'x=${V}'; sed -n "\${x}p" notes.txt`,
    `declare x=${V}; sed -n "\${x}p" notes.txt`,
    `typeset x=${V}; sed -n "\${x}p" notes.txt`,
    `local x=${V}; sed -n "\${x}p" notes.txt`,
    `export x=${V}; sed -n "\${x}p" notes.txt`,
    `read x; sed -n "\${x}p" notes.txt`,
    `read -r x; sed -n "$x,5p" notes.txt`,
    `mapfile x; sed -n "\${x}p" notes.txt`,
    `readarray x; sed -n "\${x}p" notes.txt`,
    `printf -v x '%s' "${V}"; sed -n "\${x}p" notes.txt`,
    `x+=${V}; sed -n "\${x}p" notes.txt`,
    `x=${V}; sed -n "\${x}p" notes.txt`,
  ])("held: %s", (cmd) => {
    expect(bash(cmd).action).toBe("hold");
  });

  // Builtins that set a name handed to them as a plain word, and a builtin loaded from a library: the script stays unread.
  test.each([
    `print -v x '1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `set -A x '1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `zstyle -s :a b x; sed -n "\${x}p" notes.txt`,
    `strftime -s x '1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `typeset -T FOO x; FOO='1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `vared x; sed -n "\${x}p" notes.txt`,
    `zparseopts -A x a:; sed -n "\${x}p" notes.txt`,
    `enable -f /tmp/x.so foo; foo; sed -n "\${x}p" notes.txt`,
    `enable -f /tmp/y.so foo; foo; sed -n "\${x}p" notes.txt`,
    `printf -vx '%s' '1e rm -rf ~/.ssh'; sed -n "\${x}p" notes.txt`,
    `read -ax; sed -n "\${x}p" notes.txt`,
    `print -v x '1e rm -rf ~/.ssh'; sed -n "$x,5p" notes.txt`,
  ])("held as unread: %s", (cmd) => {
    const v = bash(cmd);
    expect({ cmd, action: v.action, category: v.action === "hold" ? v.category : "" }).toEqual({ cmd, action: "hold", category: "unclassified" });
  });

  test("a variable the environment sets is not taken for unset", () => {
    expect(bash(`${F}sed -n "$n,5p" $f`, { n: "1w /tmp/out\n1" }).action).toBe("hold");
  });

  test("without -n it stays as it was", () => {
    expect(bash(`${F}sed "$n,\${e}p" $f`).action).toBe("hold");
  });
});
