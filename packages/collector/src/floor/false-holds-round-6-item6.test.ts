import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A print-only sed script under -n: line, `$` and regex addresses, ranges
 * (`A,B`, `A,+N`, `A,~N`, `first~step`), negation and `{…}` blocks, with
 * commands that only print or move through the input. sed reads its file
 * operands and writes stdout; a `w`/`W` command, the `w` and `e` flags of
 * `s`, the `e` command, `-i`, and script text whose value isn't known still
 * hold. A script file or file operand the floor can't read is unread, and
 * runs.
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

const CLASSIFY = join(ROOT, "packages", "collector", "src", "floor", "classify.ts");

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [CLASSIFY]: "export function f() {\n  return 1;\n}\n",
  [join(ROOT, "f")]: "a\nb\nc\n",
  [join(ROOT, "g")]: "a\nb\nc\n",
  [join(ROOT, "print.sed")]: "1,5p\n",
  [join(ROOT, "vars.sh")]: "n='1e git push origin HEAD #'\n",
  [join(ROOT, "write.sed")]: "1,5p\nw /fake/home/.bashrc\n",
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

describe("6. a print-only sed range", () => {
  const safe = [
    `sed -n '120,180p' packages/collector/src/floor/classify.ts`,
    `sed -n '120,180p' packages/collector/src/floor/classify.ts | head -20`,
    `sed -n '1,40p;100,120p' f`,
    `sed -n '1,40p; 100,120p' f g`,
    `sed -n '/^export/,/^}/p' f`,
    `sed -n '\\%^export%,\\%^}%p' f`,
    `sed -n 10,20p f`,
    `sed -n '5,+10p' f`,
    `sed -n '5,~4p' f`,
    `sed -n '0~3p' f`,
    `sed -n '1~2p' f`,
    `sed -n '$p' f`,
    `sed -n '10,$p' f`,
    `sed -n '1,5!p' f`,
    `sed -n '1,5{p;=}' f`,
    `sed -n '/a/{n;p}' f`,
    `sed -n '1,5l' f`,
    `sed -n '20q;10,20p' f`,
    `sed -n '$=' f`,
    `sed -n '1,3{N;P;D}' f`,
    `sed -n -e '1,2p' -e '5,6p' f`,
    `sed -ne '1,2p' f`,
    `sed --quiet '1,2p' f`,
    `sed -n -s '1,2p' f g`,
    `sed -nE '/^(a|b)/,/c/p' f`,
    `sed -n '1,5p\n10,12p' f`,
    `a=10; b=20; sed -n "\${a},\${b}p" f`,
    `a=10; b=20; sed -n "$a,\${b}p" f`,
    `a=10 b=20; sed -n "\${a},\${b}p" f`,
    `a=10; sed -n "\${a},+5p" f`,
    `a=10; sed -n "\${a},\\$p" f`,
    `if [ -n "$x" ]; then a=$(grep -n x f | cut -d: -f1); else a=$(grep -c y f); fi; sed -n "\${a}p" f`,
    `for x in a b; do n=$(grep -n "$x" f | cut -d: -f1); sed -n "\${n},+2p" f; done`,
    `f() { sed -n "\${n},+2p" f; }; n=$(grep -n x f | cut -d: -f1); f`,
    `n=$(grep -n x f | cut -d: -f1); (sed -n "\${n},+2p" f)`,
    `n=$(grep -n x f | cut -d: -f1); bash -c 'sed -n 1,5p f'`,
    `n=$(grep -n foo f | cut -d: -f1); sed -n "\${n},$((n+20))p" f`,
    `n=$(grep -n foo f | cut -d: -f1); sed -n "$((n-5)),$((n+5))p" f`,
    `n=$(grep -n foo f | head -1 | cut -d: -f1); sed -n "\${n},+20p" f`,
    `n=$(grep -n foo f | cut -d: -f1 | head -1); sed -n "\${n},+20p" f`,
    `n="$(grep -c foo f)"; sed -n "1,\${n}p" f`,
    `s=$(grep -n start f | cut -d: -f1); e=$(grep -n end f | cut -d: -f1); sed -n "\${s},\${e}p" f`,
    `s=$(grep -n start f | cut -d: -f1); e=$(grep -n end f | cut -d: -f1); sed -n "\${s}p;\${e}p" f`,
    `s=$(grep -n start f | cut -d: -f1); sed -n -e "\${s},+3p" f`,
    `n=$(( $(grep -c foo f) + 1 )); sed -n "\${n},\\$p" f`,
    `sed -n "$(grep -n foo f | cut -d: -f1),+20p" f`,
    `n=$(grep -ch foo f g | head -1); sed -n "1,\${n}p" f`,
    `n=$(grep -c 'a*' 'f*'); sed -n "1,\${n}p" f`,
    `sed -n "1,20p" f`,
    `cat f | sed -n '2,3p'`,
    `sed -n '1,2p' f 2>/dev/null | head`,
  ];
  test.each(safe)("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  // Writes outside the worktree, commands sed runs, and in-place edits of files the worker doesn't own.
  const risky = [
    `sed -n '1,5p;w /fake/home/.bashrc' f`,
    `sed -n -e '1,5{p;e git push origin HEAD' -e '}' f`,
    `sed -n -e '1,5{p' -e 'e git push origin HEAD' -e '}' f`,
    `sed -n '1,5p' -i /fake/home/.bashrc`,
    `sed -n -e '1,2p' -e 'w /fake/home/.zshrc' f`,
    "sed -n '1,5p\nw /fake/home/.zshrc' f",
    `sed -n '1,5p' --in-place=.bak /fake/home/.bashrc`,
    `sed -n '1,5W /fake/home/.bashrc' f`,
    `sed -n 's/a/b/w /fake/home/.bashrc' f`,
    `sed -n '1,5s/.*/git push origin HEAD/ep' f`,
    `sed -n '1,5s/x/y/ep' f`,
    `sed -n '1e git push origin HEAD' f`,
    `sed -n '1,5p' ${join(DATA, "secrets", "token")}`,
    `sed -n '/x/,/y/p' ${join(DATA, "standup.db")}`,
    `sed -n -f write.sed f`,
  ];
  test.each(risky)("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // A script file the floor can't read is unread.
  test("allows \"sed -n -f payload f\"", () => {
    expect(bash(`sed -n -f payload f`)).toEqual({ action: "allow" });
  });

  // A variable whose value isn't known may carry `1p;w ~/.bashrc;1` or `1e cmd` into the script.
  const unknown = [
    `sed -n "$a,\${b}p" f`,
    `sed -n "\${a},\${b}p" f`,
    `sed -n "1,\${N}p" f`,
    `sed -n "$a,$((a+5))p" f`,
    `f() { sed -n "\${1},+5p" f; }; f "$(cat payload)"`,
    `a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(cat payload); sed -n -e "\${a}p" f`,
    `read a < payload; sed -n "\${a},5p" f`,
    `for a in $(cat payload); do sed -n "\${a}p" f; done`,
    `[ -n "$x" ] && a=10 || a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); a+=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); b=$a; sed -n "\${b}p" f`,
    `a=$(grep -n x f | cut -d: -f1); read a < payload; sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); export a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); declare a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); for a in $(cat payload); do sed -n "\${a}p" f; done`,
    `a=$(grep -n x f | cut -d: -f1); [ -n "$x" ] && a=$(cat payload); sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); while read a; do sed -n "\${a}p" f; done < payload`,
    `a=$(grep -n x f | cut -d: -f1); printf -v a %s "$(cat payload)"; sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); eval "a=$(cat payload)"; sed -n "\${a}p" f`,
    `a=$(grep -n x f); sed -n "\${a}p" f`,
    `a=$(grep -n -o x f | cut -d: -f1 | tail -1); sed -n "\${a}p" f`,
    `a=$(grep x f | cut -d: -f1); sed -n "\${a}p" f`,
    `a=$(grep -n x f g | cut -d: -f1); sed -n "\${a}p" f`,
    // grep over a glob, a variable or several files prints file names (`1w /fake/home/.bashrc:3`).
    `a=$(grep -c x *.txt); sed -n "\${a}p" f`,
    `a=$(grep -n x src/*.ts | cut -d: -f1); sed -n "\${a}p" f`,
    `a=$(grep -c x $f); sed -n "\${a}p" f`,
    `a=$(grep -c x "$f"); sed -n "\${a}p" f`,
    `a=$(grep -c $p f); sed -n "\${a}p" f`,
    `a=$(grep -c x f g); sed -n "\${a}p" f`,
    `sed -n "$(grep -c x {f,g}),+2p" f`,
    `a=$(cat payload); sed -n "\${a}p" -i f`,
    `a=$(grep -n x f | cut -d: -f1); sed "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); sed -n "\${a}w /fake/home/.bashrc" f`,
    `a=$(grep -n x f | cut -d: -f1); sed -n "\${a}e git push origin HEAD" f`,
    `a=$(grep -n x f | cut -d: -f1); sed -n "\${a:-1p;w /fake/home/.bashrc}p" f`,
    `a=$(grep -n x f | cut -d: -f1); f() { a=$(cat payload); }; f; sed -n "\${a}p" f`,
    `a=$(grep -n x f | cut -d: -f1); (a=$(cat payload); sed -n "\${a}p" f)`,
  ];
  test.each(unknown)("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });

  // With an -e script, the first other operand is a file to read, not a script: sed runs only `}` and refuses it.
  test("an operand beside an -e script is a file", () => {
    expect(bash(`sed -n '1,5{p;e git push origin HEAD' -e '}' f`)).toEqual({ action: "allow" });
  });

  test("a script file of prints alone is read", () => {
    expect(bash(`sed -n -f print.sed f`)).toEqual({ action: "allow" });
  });
});

describe("6. where a digits-only value comes from", () => {
  const EVIL = `'1e git push origin HEAD #'`;
  test.each([
    // A function, alias or changed PATH stands in for a program of the pipeline.
    `grep() { echo ${EVIL}; }; n=$(grep -c x f); sed -n "\${n}p" f`,
    `grep() { echo ${EVIL}; }; sed -n "$(grep -c x f)p" f`,
    `cut() { echo ${EVIL}; }; sed -n "$(grep -n x f | cut -d: -f1)p" f`,
    `head() { echo ${EVIL}; }; n=$(grep -c x f | head -1); sed -n "\${n}p" f`,
    `tail() { echo ${EVIL}; }; sed -n "$(grep -n x f | cut -d: -f1 | tail -1)p" f`,
    `shopt -s expand_aliases; alias grep="echo 1w /fake/home/.bashrc #"; n=$(grep -c x f); sed -n "\${n}p" f`,
    `PATH=/tmp/evil:$PATH; n=$(grep -c x f); sed -n "\${n}p" f`,
    `PATH=/tmp/evil:$PATH; sed -n "$(grep -c x f)p" f`,
    `export PATH=/tmp/evil:$PATH; sed -n "$(grep -c x f)p" f`,
    `unset PATH; sed -n "$(grep -c x f)p" f`,
    `/tmp/evil/grep -c x f > /dev/null; sed -n "$(/tmp/evil/grep -c x f)p" f`,
    // A trap that fires around later steps, or a sourced file, may assign the name after it was digits.
    `n=$(grep -c x f); trap "n=${EVIL}" DEBUG; sed -n "\${n}p" f`,
    `n=$(grep -c x f); trap "n=${EVIL}" RETURN; g() { :; }; g; sed -n "\${n}p" f`,
    `n=$(grep -c x f); trap "n=${EVIL}" ERR; false; sed -n "\${n}p" f`,
    `n=$(grep -c x f); source ./vars.sh; sed -n "\${n}p" f`,
    `n=$(grep -c x f); . ./vars.sh; sed -n "\${n}p" f`,
    `n=$(grep -c x f); . <(git log -1 --format=%s); sed -n "\${n}p" f`,
    `n=$(grep -c x f); git log -1 --format=%s | source /dev/stdin; sed -n "\${n}p" f`,
    `n=$(grep -c x f); eval "$(git log -1 --format=%s)"; sed -n "\${n}p" f`,
    // A pattern or option value that may start with `-` may be an option (`-H` prints the file name).
    `n=$(grep -c "$p" f); sed -n "\${n}p" f`,
    `sed -n "$(grep -n "$p" f | cut -d: -f1)p" f`,
    `sed -n "$(grep -n "\${p}x" f | cut -d: -f1)p" f`,
    `n=$(grep -c -m "$m" x f); sed -n "\${n}p" f`,
    `p=-H; n=$(grep -c $p x f); sed -n "\${n}p" f`,
  ])("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });

  test.each([
    `n=$(grep -c -e "$p" f); sed -n "1,\${n}p" f`,
    `n=$(grep -c -- "$p" f); sed -n "1,\${n}p" f`,
    `n=$(grep -c "x$p" f); sed -n "1,\${n}p" f`,
    `p=abc; n=$(grep -c "$p" f); sed -n "1,\${n}p" f`,
    `n=$(grep -c -m 5 x f); sed -n "1,\${n}p" f`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  // The worker's shell snapshot: an alias that only sets the color prints the same text into a pipe.
  function withSnapshot(snapshot: string, command: string): FloorVerdict {
    const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
    parseShellSnapshot(snapshot, defs);
    return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, { ...probes(), shellDefinitions: () => defs });
  }
  const COUNT = `sed -n "1,$(grep -c x f)p" f`;
  test("an alias that only sets grep's color is still grep", () => {
    expect(withSnapshot(`alias grep='grep --color=auto'\n`, COUNT)).toEqual({ action: "allow" });
  });
  test.each([`alias grep='grep -H'\n`, `alias grep='grep --color=always'\n`, `alias grep='echo 1w /fake/home/.bashrc #'\n`, `grep () {\n  echo '1e git push origin HEAD'\n}\n`])(
    "holds under the snapshot %p",
    (snapshot) => {
      expect(withSnapshot(snapshot, COUNT)).toMatchObject({ action: "hold" });
    },
  );

  // A Claude Code shim of grep's name runs another program (ripgrep), whose output the floor doesn't know is digits.
  test.each([`grep () {\n  _cc_run_rg "$@"\n}\n`, `grep () {\n  "$CLAUDE_CODE_EXECPATH" --ripgrep "$@"\n}\n`, `grep () {\n  _cc_run_rg "$@"\n}\nalias grep='grep --color=auto'\n`])(
    "holds under the snapshot shim %p",
    (snapshot) => {
      expect(withSnapshot(snapshot, COUNT)).toMatchObject({ action: "hold" });
    },
  );

  // GREP_OPTIONS adds options (`-H`, `-o`) to every grep an older grep runs, so the count may come with a file name.
  test.each([
    `GREP_OPTIONS=-H; n=$(grep -c x f); sed -n "1,\${n}p" f`,
    `export GREP_OPTIONS=-H; n=$(grep -c x f); sed -n "1,\${n}p" f`,
    `export GREP_OPTIONS=-o; sed -n "$(grep -n x f | cut -d: -f1)p" f`,
    `GREP_OPTIONS=-H sh -c 'n=$(grep -c x f); sed -n "1,\${n}p" f'`,
  ])("holds %p, where GREP_OPTIONS is set", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });

  test("holds a count when GREP_OPTIONS is inherited", () => {
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: COUNT }, cwd: ROOT }, config, {
      ...probes(),
      env: (name) => (name === "GREP_OPTIONS" ? "-H" : undefined),
    });
    expect(v).toMatchObject({ action: "hold" });
  });

  test("unset GREP_OPTIONS leaves the count digits", () => {
    expect(bash(`unset GREP_OPTIONS; ${COUNT}`)).toEqual({ action: "allow" });
  });
});

describe("6. a default assignment may replace a digits-only value", () => {
  // `${n:=…}` and `${n=…}` assign when n is empty or unset, which a failed substitution leaves it.
  test.each([
    `n=$(grep -c x f); : "\${n:=1p;w /fake/home/.bashrc;1}"; sed -n "\${n}p" f`,
    `n=$(grep -c x f); : "\${n=1e git push origin HEAD #}"; sed -n "\${n}p" f`,
    `n=$(grep -n x f | cut -d: -f1); echo "\${n:=$(cat payload)}" > /dev/null; sed -n "\${n},+2p" f`,
    `n=$(grep -c x f); [ -n "$x" ] && : "\${n:=1w /fake/home/.bashrc}"; sed -n "\${n}p" f`,
    // An indirect `${!r:=…}` assigns the variable r names, known or not.
    `n=$(grep -c x f); r=n; : "\${!r:=1w /fake/home/.bashrc}"; sed -n "\${n}p" f`,
    `n=$(grep -c x f); r=$(cat payload); : "\${!r:=1w /fake/home/.bashrc}"; sed -n "\${n}p" f`,
  ])("holds %p", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold" });
  });

  test("a default that only reads the value keeps it digits", () => {
    expect(bash(`n=$(grep -c x f); : "\${n:-1}"; sed -n "1,\${n}p" f`)).toEqual({ action: "allow" });
  });
});

describe("6. a file operand whose value isn't known", () => {
  // getopt permutes: `"$f"` may be `-i`, `-ee CMD` or `-fFILE` anywhere among the words, which leaves the call unread.
  test.each([
    `while read f; do sed -n 1,5p "$f"; done < payload`,
    `while read f; do sed -n '1,5p' f "$f"; done < payload`,
    `for f in $(cat payload); do sed -n -e 1,5p "$f"; done`,
    `n=$(grep -c x f); while read g; do sed -n "1,\${n}p" "$g"; done < payload`,
    `while read g; do sed -n "$(grep -c x f)p" "$g"; done < payload`,
    `while read g; do sed -n -e "$(grep -c x f)p" "$g"; done < payload`,
    `while read f; do sed -n 1,5p "\${f}"; done < payload`,
    `while read f; do sed -n 1,5p "$f".txt; done < payload`,
    `while read f; do sed -n 1,5p *"$f"; done < payload`,
    `while read f; do sed -n 1,5p x$f; done < payload`,
  ])("allows %p, which the floor can't read", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    `while read f; do sed -n 1,5p -- "$f"; done < payload`,
    `while read f; do sed -n 1,5p "./$f"; done < payload`,
    `while read f; do sed -n 1,5p f"$f"; done < payload`,
    `d=src; while read f; do sed -n 1,5p "$d/$f"; done < payload`,
  ])("allows %p, which getopt can't read as an option", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });
});
