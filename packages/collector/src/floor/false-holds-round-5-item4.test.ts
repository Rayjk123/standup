import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * sed scripts that only print lines picked by an address (a line, a range, a
 * step, a regex, the last line) read, and the sed steps of the same shape
 * that write, run commands or read Standup's data still hold. The machine
 * is virtual.
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
  [join(ROOT, "src", "app.ts")]: "export const app = 1;\n",
  [join(ROOT, "f")]: "a\nb\n",
  [join("/", "tmp", "other", "notes.txt")]: "a\nb\n",
  [join(INSTALL, "packages", "collector", "src", "index.ts")]: "console.log(1);\n",
  [join(DATA, "standup.db")]: "",
  [join(DATA, "secrets", "token")]: "t",
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

function expectAllowed(v: FloorVerdict): void {
  expect(v).toEqual({ action: "allow" });
}

function expectHeld(v: FloorVerdict, category: string): void {
  expect(v).toMatchObject({ action: "hold", category });
}

/** Line, range, step, regex and last-line addresses printed under -n. */
const reads = [
  "sed -n '120,180p' src/app.ts",
  'sed -n "1,40p" f | head',
  "sed -n '/start/,/end/p' f",
  "sed -n '10p;20p' f",
  "sed -n -e '5,9p' f",
  "sed -n '1,5{p}' f",
  "sed -n '$p' f",
  "sed -n '3,+4p' f",
  "sed -n '0~3p' f",
  "sed -n '1,5p' /tmp/other/notes.txt",
];

/** The same reads in other spellings, options, compound commands and places. */
const moreReads = [
  "sed -n 120,180p src/app.ts",
  "sed -n '120,180 p' src/app.ts",
  "sed -n -- '1,5p' f",
  "sed --quiet '1,5p' f",
  "sed -ne '1,5p' f",
  "sed -En '1,5p' f",
  "sed '1,5p' -n f",
  "sed -n '1,5p;6q' f",
  "sed -n '/^export/,/^}/p' f",
  "sed -n '/a\\/b/,/c/p' f",
  "sed -n '\\|x|,\\|y|p' f",
  "sed -n '/foo/I,+3p' f",
  "sed -n '1~2p' f",
  "sed -n '2,~4p' f",
  "sed -n '0,/re/p' f",
  "sed -n '$=' f",
  "sed -n '1,5{=;p}' f",
  "sed -n -e '1p' -e '$p' f",
  "sed -s -n '1p' f src/app.ts",
  "sed -n '/x/{n;p}' f",
  "sed -n '1,5l' f",
  "sed '1,5!d' f",
  "sed -n '1,5p' src/app.ts | cat -n",
  "cat f | sed -n '1,5p'",
  "sed -n '1,5p' /fake/home/notes.txt",
  "sed -n '1,5p' /fake/install/packages/collector/src/index.ts",
  "sed -n '1,5p' ~/notes.txt",
  "sed -n '1,5p' $HOME/notes.txt",
  'a=3; b=9; sed -n "${a},${b}p" f',
  'a=$(grep -n x f | cut -d: -f1); sed -n "$a,$((a+5))p" f',
  'N=$(grep -c x f); sed -n "1,${N}p" f',
  "sed -n '1,5p' src/*.ts",
  "sed -n '1,5p' f 2>/dev/null",
  "sed -n '1,5p' f; echo ---; sed -n '6,9p' f",
  "for f in src/*.ts; do sed -n '1,3p' \"$f\"; done",
  "sed -n '1,5p' -- \"$F\"",
  "sed -n '/start/,/end/{/start/!{/end/!p}}' f",
  "sed -n '/a/,/b/{p}' f",
  "sed -n '1p\n3p' f",
  "sed -n 'p' f",
  "sed -n '/x/!p' f",
  "sed -n '1,5 !p' f",
  "sed -n '3{p;q}' f",
  "sed -n '/re/=' f",
  "sed -n -l 80 '1,5l' f",
  "sed -z -n '1p' f",
  "sed -n '1,+5p' f",
  "sed -n '10,$p' f",
  "bash -c \"sed -n '1,5p' f\"",
  "sh -c 'sed -n 1,5p f'",
  "timeout 5 sed -n '1,5p' f",
  "find src -name '*.ts' -exec sed -n '1,5p' {} \\;",
  "find src -name '*.ts' -exec sed -n '1,5p' {} +",
  "ls src/*.ts | xargs sed -n '1,5p'",
  "ls src/*.ts | xargs -I{} sed -n '1,5p' {}",
  "x=$(sed -n '1,5p' f); echo \"$x\"",
  "echo \"$(sed -n '1,5p' f)\"",
  "diff <(sed -n '1,5p' f) <(sed -n '1,5p' src/app.ts)",
  "sed -n '1,5p' < f",
  "git show HEAD:src/app.ts | sed -n '1,5p'",
  "nl -ba src/app.ts | sed -n '120,180p'",
  "sed -n '1,5p' /fake/home/.local/share/standup/worktrees/other/feat-2/src/app.ts",
  "sed -n '1,5p' /fake/install/packages/collector/src/floor/classify.ts",
  "sed -n '1,5p' /fake/home/.claude/settings.json",
  "cd /tmp/other && sed -n '1,5p' notes.txt",
  "sed -n '1,5p' f | while read l; do echo \"$l\"; done",
  "# look\nsed -n '1,5p' f",
  "sed -n '1,5p' f\nsed -n '6,9p' f",
  "sed -n $'1,5p' f",
  "sed -n '120,180p;' f",
  "sed -n '1,5 p ; 7 p' f",
  "sed -n '/foo/ , /bar/ p' f",
  "sed -n '1,5p\n' f",
  'sed -n "/x/,\\$p" f',
  'sed -n "1,\\$p" f',
  "sed -n '/<script>/,/<\\/script>/p' f",
  "sed -n '1,5{p;}' f",
  "sed -n '/x/{p;q;}' f",
  "sed -nE '/a|b/p' f",
  "sed -n '/x/,/y/{//!p}' f",
  "sed -n '/\\(a\\)/p' f",
  "sed -n '5,10{s/^/  /;p}' f",
  "sed -n '/x/I p' f",
  "sed -n '1,5 {p}' f",
  "sed --expression=1,5p -n f",
  "sed -n '/^## /{s/^## //;p}' f",
  "sed -n --posix '1,5p' f",
  "sed -n --debug '1,5p' f",
  "sed -n -u '1,5p' f",
  "sed -n --null-data '1p' f",
  "sed -n --separate '1p' f",
  "sed -n --regexp-extended '/a|b/p' f",
  "sed -n --line-length=80 '1l' f",
  "sed -n -s '$p' f src/app.ts",
  "sed -n '1,5p' f src/app.ts",
  "sed -n 'F;1p' f",
  "sed -n '1,5p' 'src/app.ts'",
  "sed -n '2{p;q}' f",
  "sed -n '/a/,/b/ { p }' f",
  "sed -n '1,5p' -s f",
  "sed -n '0~4p' f",
  "sed -n '1,3p' f | sed -n '2p'",
  "sed -n '1,/^$/p' f",
  "sed -n '/x/,$!p' f",
  "sed -n '$!p' f",
  "sed -n '/a/b;p' f",
  "sed -n ':a;N;$!ba;p' f",
  "sed -n '1,5p;5q' f",
  "sed -n 'x' f",
  "sed -n '1,5 l 0' f",
];

describe("sed printing lines an address picks reads", () => {
  test.each(reads)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test.each(reads)("allows %p from outside the worktree", (command) => {
    expectAllowed(bash(command, HOME));
  });

  test.each(moreReads)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("an address GNU sed rejects leaves the script unread, which runs", () => {
    expectAllowed(bash("sed -n 'first~step p' f"));
  });

  // A value from the environment may be any script text (`1p;w ~/.bashrc;1`).
  test.each(['sed -n "${a},${b}p" f', 'sed -n "$a,$((a+5))p" f', 'sed -n "1,${N}p" f'])("holds %p, whose variables aren't known", (command) => {
    expectHeld(bash(command), "unclassified");
  });
});

describe("sed steps after an address that write, run or read protected data still hold", () => {
  const W = join(INSTALL, "x");
  const held: Array<[string, string]> = [
    [`sed -n '1,5w ${W}' f`, "floor-tamper"],
    [`sed -n '1,5W ${W}' f`, "floor-tamper"],
    [`sed -n '/a/,/b/w ${W}' f`, "floor-tamper"],
    [`sed -n '0~3w ${W}' f`, "floor-tamper"],
    [`sed -n '$w ${W}' f`, "floor-tamper"],
    [`sed -n '3,+4w ${W}' f`, "floor-tamper"],
    [`sed -n '1,5{p;w ${W}\n}' f`, "floor-tamper"],
    [`sed -n '1,5s/a/b/w ${W}' f`, "floor-tamper"],
    [`sed -n '1,5w ${join(DATA, "x")}' f`, "floor-tamper"],
    [`sed -i '1,5d' ${join(INSTALL, "packages", "collector", "src", "index.ts")}`, "floor-tamper"],
    ["sed -n '1,5e rm -rf /' f", "floor-tamper"],
    ["sed -n '1,5e git push origin HEAD' f", "outward"],
    ["sed -n '1,5p;e git push origin HEAD' f", "outward"],
    ["sed -n '1,5s/.*/git push origin HEAD/e' f", "outward"],
    ["sed -n '1,5e' f", "unclassified"],
    ["sed -n '1,5s/a/b/e' f", "unclassified"],
    [`sed -n '1,5p' ${join(DATA, "standup.db")}`, "floor-tamper"],
    [`sed -n '1,5p' ${join(DATA, "secrets", "token")}`, "floor-tamper"],
    [`sed -n '1,5r ${join(DATA, "standup.db")}' f`, "floor-tamper"],
  ];
  test.each(held)("holds %p as %p", (command, category) => {
    expectHeld(bash(command), category);
  });

  test("the same steps inside the worktree, and reads of ordinary files, are the worker's own", () => {
    for (const command of ["sed -n '1,5w out.txt' f", "sed -n '1,5s/a/b/w out' f", "sed -i '1,5d' f", "sed -n '1,5R /tmp/other/notes.txt' f"]) expectAllowed(bash(command));
  });
});
