import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A sed script with a variable the floor can't resolve, such as a branch name
 * from a loop over `git branch`, spliced into an `s` replacement.
 *
 * The value can close the replacement early: GNU sed reads `s|^|$b: |` with
 * b='x|;etouch${IFS}/tmp/f;#' as `s|^|x|` then `e touch${IFS}/tmp/f;#: |`
 * (the `e` command takes the rest of the line, so no fixed suffix after the
 * variable can turn the breakout into a parse error), and b='x|e;#' as
 * `s|^|x|e`. Both are valid branch names (`|`, `;`, `$`, `{`, `}`, `#` are
 * all allowed in refnames), so such a script stays held.
 *
 * Under `--sandbox` GNU sed refuses every `e`, `r`, `w` command and flag
 * while it parses the script, before reading any input, so a script it can't
 * read runs nothing and writes nothing there.
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
  [join(ROOT, "notes.txt")]: "a\nb\n",
  [join(ROOT, "evil.sed")]: "e git push origin HEAD\n",
  [join(ROOT, "p.sed")]: "e git push origin HEAD\n",
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

const FOR = `for b in $(git branch --format='%(refname:short)'); do`;
const WHILE = `git branch --format='%(refname:short)' | while read b; do`;

describe("8. a variable sed can't be told spliced into an s replacement", () => {
  test.each([
    // The value is known, so the script is read as written.
    `b=main; git log -1 --oneline "$b" | sed "s|^|$b: |"`,
    `b=feat/x-1; git log -3 --format=%s "$b" | sed "s|^|$b: |"`,
    // Under --sandbox sed refuses e/r/w while parsing, whatever the value closes.
    `${FOR} git log -1 --oneline "$b" | sed --sandbox "s|^|$b: |"; done`,
    `${WHILE} git log -3 --format=%s "$b" | sed --sandbox "s|^|$b: |"; done`,
    `${FOR} git log -1 --oneline "$b" | sed --sandbox -e "s|^|$b: |"; done`,
    `${FOR} git log -1 --oneline "$b" | sed -e "s|^|$b: |" --sandbox; done`,
    `${FOR} git log -1 --oneline "$b" | sed --sandbox -n "s|^|$b: |p"; done`,
    `${FOR} sed --sandbox "s|^|$b: |" notes.txt; done`,
    `${FOR} git log -1 --oneline "$b" | sed --sandbox -E -e 's/^/> /' -e "s|^|$b: |"; done`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    // The loop value is unknown and can close the replacement (b='x|e;#', b='x|;eCMD;#').
    `${FOR} git log -1 --oneline "$b" | sed "s|^|$b: |"; done`,
    `${WHILE} git log -3 --format=%s "$b" | sed "s|^|$b: |"; done`,
    `${FOR} git log -1 --oneline "$b" | sed "s/^/$b: /"; done`,
    `${FOR} git log -1 --oneline "$b" | sed -e "s|^|$b: |"; done`,
    `${FOR} git log -1 --oneline "$b" | sed "s|^|$b|e"; done`,
    `${FOR} git log -1 --oneline "$b" | sed "s|^|$b|w /tmp/x"; done`,
    `${FOR} git log -1 --oneline "$b" | sed "s|^|$b: |;w ~/.zshrc"; done`,
    `${FOR} git log -1 --oneline "$b" | sed -e "s|^|$b: |" -e 'e git push origin HEAD'; done`,
    `${FOR} sed "s|^|$b: |" -i notes.txt; done`,
    `${FOR} git log -1 --oneline | sed "s|a|b|$b"; done`,
    `sed "s|a|b|$f" notes.txt`,
    // Known values that close the replacement are read as the script they make.
    `b='x|e'; echo hi | sed "s|^|$b|"`,
    `b='x|e;#'; echo hi | sed "s|^|$b: |"`,
    `b='x|;e git push origin HEAD;#'; echo hi | sed "s|^|$b: |"`,
    `b=$'x|w /fake/home/.bashrc\\n#'; echo hi | sed "s|^|$b|"`,
    `b=$'x|;w /fake/home/.bashrc\\n'; echo hi | sed "s|^|$b|"`,
    `echo hi | sed 'w /fake/home/.bashrc'`,
    `b=$'x|\\ne git push origin HEAD\\n#'; echo hi | sed "s|^|$b: |"`,
    // --sandbox doesn't stop an in-place edit of a file sed is handed.
    `${FOR} sed --sandbox -i "s|^|$b: |" ${join(HOME, ".bashrc")}; done`,
    // The sandbox flag must be sed's own: a value or another word doesn't count.
    `${FOR} git log -1 --oneline "$b" | sed "s|^|$b: |" -- --sandbox; done`,
    `${FOR} git log -1 --oneline "$b" | sed $o "s|^|$b: |"; done`,
    `${FOR} git log -1 --oneline "$b" | sed --sandbo "s|^|$b: |"; done`,
    `s=--sandbox; ${FOR} git log -1 --oneline "$b" | sed "$s$b"; done`,
    // A script file sed is handed outside the sandbox is still read.
    `sed -f evil.sed notes.txt`,
    // An unquoted unknown script may split into more words, one of them `-i`.
    `${FOR} sed --sandbox s/^/$b/ notes.txt; done`,
    `${FOR} sed --sandbox -e s/^/$b/ notes.txt; done`,
    `${FOR} sed --sandbox "s|^|"$b": |" notes.txt; done`,
    // What a command substitution in the script runs is still read.
    `sed --sandbox "$(git push origin HEAD)" notes.txt`,
    // An unknown word that may start with `-` may be `-i`: the next word is then the script and the file is edited in place.
    `${FOR} sed --sandbox "$b" 's/^/x/' ${join(HOME, ".bashrc")}; done`,
    `${FOR} sed --sandbox "\${b}p" 's/^/x/' ${join(HOME, ".bashrc")}; done`,
    `${FOR} sed --sandbox "-$b" 's/^/x/' ${join(HOME, ".bashrc")}; done`,
    // A quoted list expands to a word per element, one of which may be `-i`.
    `set -- $(git log -1 --format=%s); sed --sandbox -e "$@" ${join(HOME, ".bashrc")}`,
    `a=($(git log -1 --format=%s)); sed --sandbox -e "\${a[@]}" ${join(HOME, ".bashrc")}`,
    `sed --sandbox -e "\${!B@}" ${join(HOME, ".bashrc")}`,
    // As the argument of `-l` it isn't the script: the next word is.
    `${FOR} sed --sandbox -nl 5 "s|^|$b: |" -i ${join(HOME, ".bashrc")}; done`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // An unknown file operand may be `-i` too, which leaves the call unread.
  test.each([`${FOR} sed --sandbox "s|^|$b: |" $f; done`, `${FOR} sed --sandbox -e "s|^|$b: |" $f; done`])("allows %p, whose file operand the floor can't read", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  // GNU sed takes `--sandbox` as a file after `--` or after an operand under POSIXLY_CORRECT, and as the
  // argument of `-l` in `-nl --sandbox` or `--line --sandbox`: the `e` flag then runs.
  test.each([
    `sed 's/.*/git push origin HEAD/e' notes.txt -- --sandbox`,
    `sed -- 's/.*/git push origin HEAD/e' --sandbox notes.txt`,
    `POSIXLY_CORRECT=1 sed 's/.*/git push origin HEAD/e' notes.txt --sandbox`,
    `sed -nl --sandbox 's/.*/git push origin HEAD/ep' notes.txt`,
    `sed --line --sandbox 's/.*/git push origin HEAD/e' notes.txt`,
    `sed --l --sandbox 's/.*/git push origin HEAD/e' notes.txt`,
    `sed $o --sandbox 's/.*/git push origin HEAD/e' notes.txt`,
  ])("holds %p, where --sandbox isn't sed's option", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([
    `sed --sandbox 's/.*/git push origin HEAD/e' notes.txt`,
    `sed -n --posix --sandbox 's/.*/git push origin HEAD/ep' notes.txt`,
    `sed -l 80 --sandbox 's/.*/git push origin HEAD/e' notes.txt`,
    `sed -e 's/a/b/' --sandbox -e 's/.*/git push origin HEAD/e' notes.txt`,
  ])("allows %p, which sed refuses while parsing", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  // GNU sed's getopt reads `i` after any no-argument letters (`-b`, `-c`, `-s`), with any rest as the
  // backup suffix, and any unambiguous prefix of `--in-place`; `e`/`f` the same way.
  test.each([
    `sed -bi 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed -ci.bak 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed -sbi 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed --in 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed --in-pl=.bak 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed --i=.bak 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed --sandbox -ci 's/^/x/' ${join(HOME, ".bashrc")}`,
    `sed -bf p.sed notes.txt`,
    `sed -cf p.sed notes.txt`,
    `sed -s -bfp.sed notes.txt`,
    `sed -be 's/.*/git push origin HEAD/e' notes.txt`,
  ])("holds %p, an option spelling sed reads", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test.each([`sed -bn '1,2p' notes.txt`, `sed --line=80 -n '1p' notes.txt`, `sed -n -l 80 '1p' notes.txt`])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test("the hold names the sed script", () => {
    expect(bash(`${FOR} git log -1 --oneline "$b" | sed "s|^|$b: |"; done`)).toMatchObject({ action: "hold", category: "unclassified" });
  });
});

describe("8. where sed's options end", () => {
  // After `--`, and after the first operand under POSIXLY_CORRECT, `-e p` is two operands: the first operand is the script.
  test.each([
    `sed -- 'w ${join(HOME, ".bashrc")}' -e p notes.txt`,
    `sed -- '1e git push origin HEAD' -e p notes.txt`,
    `sed -n -- 'w ${join(HOME, ".bashrc")}' --expression=p notes.txt`,
    `POSIXLY_CORRECT=1 sed 'w ${join(HOME, ".bashrc")}' -e p notes.txt`,
    `POSIXLY_CORRECT= sed '1e git push origin HEAD' -f p.sed notes.txt`,
    `export POSIXLY_CORRECT=1; sed 'w ${join(HOME, ".bashrc")}' -e p notes.txt`,
    `env POSIXLY_CORRECT=1 sed 'w ${join(HOME, ".bashrc")}' -e p notes.txt`,
    // Set but maybe not exported: either reading may be sed's.
    `POSIXLY_CORRECT=1; sed 'w ${join(HOME, ".bashrc")}' -e p notes.txt`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  test("holds the first operand as the script when POSIXLY_CORRECT is inherited", () => {
    const v = classifyToolCall({ toolName: "Bash", toolInput: { command: `sed 'w ${join(HOME, ".bashrc")}' -e p notes.txt` }, cwd: ROOT }, config, {
      ...probes(),
      env: (name) => (name === "POSIXLY_CORRECT" ? "1" : undefined),
    });
    expect(v.action).toBe("hold");
  });

  test.each([`sed -n -- '1,2p' notes.txt`, `sed -n '1,2p' -- notes.txt`, `POSIXLY_CORRECT=1 sed -n '1,2p' notes.txt`])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });
});

describe("8. zsh's flagged expansions and subscripts", () => {
  // `$=b`, `$~b`, `$^b` and `$+b` expand b in zsh; the floor can't read them as the text bash would.
  test.each([
    `b='x|e'; echo hi | sed "s|^|$=b|"`,
    `b='x|e'; echo hi | sed "s|^|$~b|"`,
    `b='x|e'; echo hi | sed "s|^|$^b|"`,
    `b='x|e'; echo hi | sed "s|^|$+b|"`,
    `echo hi | sed "s|^|$=b|" notes.txt`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // zsh's `"x$a[@]"` gives a word per element, one of which may be `-i`.
  test.each([
    `a=($(git log -1 --format=%s)); sed --sandbox -e "x$a[@]" ${join(HOME, ".bashrc")}`,
    `a=($(git log -1 --format=%s)); sed --sandbox "x$a[@]" ${join(HOME, ".bashrc")}`,
    `a=($(git log -1 --format=%s)); sed --sandbox -e "s/x/$a[*]/" ${join(HOME, ".bashrc")}`,
  ])("holds %p", (command) => {
    expect(bash(command).action).toBe("hold");
  });

  // Brackets after `$x` that aren't a plain subscript are the commands, operators and substitutions they hold.
  const RC = join(HOME, ".bashrc");
  test.each([
    `echo $x[a; echo x > ${RC}; b]`,
    `echo $x[a && echo x > ${RC} ]`,
    `echo $x[$(echo x > ${RC})]`,
    `echo $x[\`echo x > ${RC}\`]`,
    `echo $x[\${y:-$(echo x > ${RC})}]`,
    `echo "$x[a; $(echo x > ${RC})]"`,
    `echo "$x[$(echo x > ${RC})]"`,
    `echo "$x[\`echo x > ${RC}\`]"`,
    `cat <<EOF\n$x[a; $(echo x > ${RC})]\nEOF`,
    `cat <<EOF\n$x[\`echo x > ${RC}\`]\nEOF`,
  ])("holds %p, owner-only", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  // A flag before `$(` is no parameter: the substitution is still read.
  test.each([`echo "$=$(echo x > ${RC})"`, `echo $~$(echo x > ${RC})`, `echo "$^$(echo x > ${RC})"`, `cat <<EOF\n$+$(echo x > ${RC})\nEOF`])("holds %p, owner-only", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });
});
