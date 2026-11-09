import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `sed -n "$n,$((n+40))p" f` only prints when every computed part of the
 * script is a number: an arithmetic expansion over literals and names that
 * hold digits (no `[`, `#` or `.`, which zsh turns into `W` or a float), or
 * a variable the floor knows holds digits. Besides a literal, such a `$((…))` or a digits-only pipeline, that
 * is a name `let`, `((…))` or a `for ((…))` header assigns where the
 * arithmetic can't fail or skip the assignment, and a name that is a number
 * on every path into a loop or branch. A variable the floor can't read stays
 * held: its value may close the address and add `w FILE` or `e CMD`.
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

describe("10. a sed -n range print with computed bounds", () => {
  test.each([
    `i=4; sed -n "$((i*10)),+5p" f`,
    `i=$(grep -c x f); sed -n "$((i*10)),+5p" f`,
    // A name neither the command nor the env it starts with sets reads as 0 in arithmetic.
    `sed -n "$((i*10)),+5p" f`,
    `sed -n "$((4*10)),+5p" f`,
    `n=40; sed -n "$n,$((n+40))p" file`,
    `a=1; b=9; sed -n "\${a},\${b}p" f`,
    `n=3; m=9; sed -n $n,\${m}p f`,
    `i=4; n=$((i*10)); sed -n "$n,$((n+40))p" file`,
    `i=$(grep -c x f); n=$((i*10)); sed -n "$((n*2)),+5p" file`,
    `n=$(( $(grep -c x f) + 1 )); sed -n "\${n},\\$p" file`,
    `n=$(grep -c x f); n=$((n+40)); sed -n "\${n}p" file`,
    `for n in 1 41 81; do sed -n "$n,$((n+40))p" file; done`,
    `for n in $(seq 1 40 200); do sed -n "$n,$((n+40))p" file; done`,
    `for ((n=1; n<200; n+=40)); do sed -n "$n,$((n+40))p" file; done`,
    `for ((n=1; n<200; n+=40)); do sed -n "\${n},+39p" file; done; sed -n "\${n}p" file`,
    `n=1; while [ $n -lt 200 ]; do sed -n "$n,$((n+40))p" file; n=$((n+40)); done`,
    `n=1; while [ $n -lt 200 ]; do sed -n "$n,$((n+40))p" file; ((n+=40)); done`,
    `n=1; sed -n -E "$n,$((n+40))p" file`,
    `n=1; sed -n --posix "$n,$((n+40))p" file`,
    `n=1; sed -n -s -u -z "$n,$((n+40))p" file`,
    `n=1; sed -n "$n,$((n+40))p" -- file`,
    `n=1; sed -nE "\${n}p" file`,
    `let n=5; sed -n "$n,+5p" file`,
    `let n=5 m=n+40; sed -n "$n,\${m}p" file`,
    `((n=5)); sed -n "$n,+5p" file`,
    `((n = 5)); ((m = n * 8)); sed -n "$n,\${m}p" file`,
    // A name assigned a constant holds it whatever it held before.
    `n=$(cat payload); ((n=5)); sed -n "$n,+5p" file`,
    `declare -i n=5; sed -n "$n,+5p" file`,
    `n=5; ((n++)); sed -n "$n,+5p" file`,
    `n=5; let n+=3; sed -n "$n,+5p" file`,
    `n=$(grep -c x f); ((n=n+1)); sed -n "\${n}p" file`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    // A value the floor doesn't know may close the address and add a command: n='1p;w /fake/home/.bashrc;#'.
    `sed -n "$n,$((n+40))p" file`,
    `sed -n "\${a},\${b}p" f`,
    `sed -n $n,\${m}p f`,
    `sed -n "$((n+1)),\${m}p" f`,
    `n=$(cat payload); sed -n "$n,$((n+40))p" file`,
    `n='1p;w /fake/home/.bashrc;#'; sed -n "$n,$((n+40))p" file`,
    `n='1e git push origin HEAD #'; sed -n "$n,$((n+40))p" file`,
    // Writes, commands sed runs, and no -n.
    `sed -n "1,\${x}w out" f`,
    `x=5; sed -n "1,\${x}w /fake/home/.bashrc" f`,
    `n=1; m=5; sed -n "$n,\${m}p;w /fake/home/.bashrc" f`,
    `n=1; sed -n "\${n}e git push origin HEAD" f`,
    `n=1; sed "$n,\${m}p" f`,
    `n=1; sed -n -i "$n,$((n+40))p" /fake/home/.bashrc`,
    // Arithmetic that may fail or skip the assignment leaves the value it had.
    `n=$(cat payload); ((n=1/0)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=5%k)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=2**k)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((x && (n=5))); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=x ? 1 : 2)); sed -n "\${n}p" f`,
    `n=$(cat payload); let n=x; sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=08)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=0x10)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n=2#1)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n = $m)); sed -n "\${n}p" f`,
    `n=$(cat payload); ((n[1]=5)); sed -n "\${n}p" f`,
    `n=$(cat payload); let "n=5"x; sed -n "\${n}p" f`,
    `REPLY=$(cat payload); ((REPLY=5)); read; sed -n "\${REPLY}p" f`,
    // The body sets the name again, before the next pass or after the loop.
    `for ((n=1; n<9; n+=4)); do sed -n "\${n}p" f; n=$(cat payload); done`,
    `for ((n=1; n<9; n+=4)); do n=$(cat payload); done; sed -n "\${n}p" f`,
    `n=1; while [ $n -lt 9 ]; do sed -n "\${n}p" f; n=$(cat payload); done`,
    `if [ -n "$x" ]; then n=1; else n=$(cat payload); fi; sed -n "\${n}p" f`,
    // A subscript in the arithmetic runs its substitution.
    `sed -n "$((a[$(git push origin HEAD)])),+5p" f`,
    `n='a[$(git push origin HEAD)]'; sed -n "$((n+1)),+5p" f`,
    // A number read from a pipe isn't tracked.
    `seq 1 40 200 | while read n; do sed -n "$n,$((n+40))p" file; done`,
    // An untracked operand is evaluated as arithmetic itself: under zsh `i='[##36] 32'` gives `W`, and `a[$(cmd)]` runs cmd.
    `i=$(cat payload); sed -n "$((i*10)),+5p" f`,
    `n=$((i*10)); sed -n "$n,$((n+40))p" file`,
    `n=$(grep -c x f); ((n=n/k)); sed -n "\${n}p" file`,
    `sed -n "$((x\${n})),+5p" f`,
    `sed -n "$((1.5)),+5p" f`,
    `sed -n "$((Inf)),+5p" f`,
    `sed -n "$((1e5)),+5p" f`,
    `n=$((16#ff)); sed -n "\${n}p" f`,
    `((n = 1.5)); sed -n "\${n}p" f`,
    `((n = NaN)); sed -n "\${n}p" f`,
  ])("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });
});

describe("10. zsh arithmetic output base in a computed sed print", () => {
  // zsh prints `$(( [##36] 32 ))` as `W`, and `(( n = [##36] 32 ))` stores it: `Wp` writes a file.
  test.each([
    ["inline", `sed -n "$(( [##36] 32 ))p" f`],
    ["assigned from $((…))", `n=$(( [##36] 32 )); sed -n "\${n}p" f`],
    ["((…)) over a name that held digits", `n=5; (( n = [##36] 32 )); sed -n "\${n}p" f`],
    ["((…)) from an untracked operand", `n=5; m=$(git log -1 --format=%s); (( n = m )); sed -n "\${n}p" f`],
    ["for ((…)) init over a digits name", `n=1; for (( n = [##36] 32; n < 0; )); do :; done; sed -n "\${n}p" f`],
  ])("%s is held", (_what, command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });
});
