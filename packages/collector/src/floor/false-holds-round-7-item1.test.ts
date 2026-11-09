import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * `sed -n` printing lines or ranges of a file (`'120,180p'`, `'5p'`,
 * `'/re/,+3p'`, `'$p'`, several `-e`) only reads: it is allowed for files in
 * the worktree, in /tmp and in the launch's own scratch dir, and held where a
 * plain read is (owner secrets, another launch's scratch dir). What a script
 * writes (`w`, `W`, `s///w`, `-i`) or runs (`e`, `s///e`) is read as that
 * write or command, and a script the floor can't read stays held.
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

const CLASSIFY = join(ROOT, "packages", "collector", "src", "floor", "classify.ts");

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [CLASSIFY]: "export const x = 1;\n",
  [join(ROOT, "notes.txt")]: "a\nb\nc\n",
  ["/tmp/out.log"]: "line\n",
  [join(OWN_SCRATCH, "notes.md")]: "# notes\n",
  [join(SCRATCH, "launch-2", "prompt.md")]: "# other launch\n",
  [join(DATA, "secrets", "token")]: "s3cret\n",
  [join(INSTALL, "packages", "collector", "src", "floor", "classify.ts")]: "export const y = 1;\n",
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

describe("sed printing lines of a file", () => {
  test.each([
    "sed -n '120,180p' packages/collector/src/floor/classify.ts",
    `sed -n '120,180p' ${CLASSIFY}`,
    "sed -n '5p' notes.txt",
    "sed -n '/re/,+3p' notes.txt",
    "sed -n '$p' notes.txt",
    "sed -n '1,$p' notes.txt",
    "sed -n '$!p' notes.txt",
    "sed -n '2~3p' notes.txt",
    "sed -n '0,/re/p' notes.txt",
    "sed -n '/a/,/c/p' notes.txt",
    "sed -n '/^function parseSedScript/,/^}/p' notes.txt",
    "sed -n '/x/I,/y/Ip' notes.txt",
    "sed -n '\\|a|p' notes.txt",
    "sed -n '/[/]/p' notes.txt",
    "sed -n '/^[^/]*$/,+2p' notes.txt",
    "sed -n '/[[:space:]/]x/,/[]]/p' notes.txt",
    "sed -n 's/[/]/x/p' notes.txt",
    "sed -n '1,5!p' notes.txt",
    "sed -n '1,5p;8p' notes.txt",
    "sed -n '1,5{p;}' notes.txt",
    "sed -n '120,180p;180q' notes.txt",
    "sed -n '1,5p\n8p' notes.txt",
    "sed -n '# show\n1,5p' notes.txt",
    "sed -n '$=' notes.txt",
    "sed -n '1,3l' notes.txt",
    "sed -n 120,180p notes.txt",
    'sed -n "120,180p" notes.txt',
    'sed -n "1,\\$p" notes.txt',
    "sed -n -e '1p' -e '3p' notes.txt",
    "sed -n -e '1,5{' -e 'p' -e '}' notes.txt",
    "sed -ne '1p' notes.txt",
    "sed --quiet '1p' notes.txt",
    "sed --silent --expression='1,5p' notes.txt",
    "sed -nE '/a|b/p' notes.txt",
    "sed -n -- '1p' notes.txt",
    "sed -n '1,5p' -- notes.txt",
    "sed -s -n '1p' notes.txt /tmp/out.log",
    "sed '5q' notes.txt",
    "sed -n '5,+3p' /tmp/out.log",
    "sed -n '1,5p' /tmp/out.log",
    `sed -n '1,5p' ${join(OWN_SCRATCH, "notes.md")}`,
    "sed -n '1,20p' /fake/install/packages/collector/src/floor/classify.ts",
    "sed -n '1,5w /dev/stdout' notes.txt",
    "sed -n '1,5w /tmp/lines.txt' notes.txt",
    "N=5; sed -n \"${N}p\" notes.txt",
    'N=$(grep -n b notes.txt | head -1 | cut -d: -f1); sed -n "$((N-1)),$((N+1))p" notes.txt',
    "for f in notes.txt /tmp/out.log; do echo \"== $f\"; sed -n '1,3p' \"$f\"; done",
    "sed -n '120,180p' packages/collector/src/floor/classify.ts | head -40",
    "nl -ba notes.txt | sed -n '120,180p'",
    "git show HEAD:notes.txt | sed -n '1,5p'",
    "sed -n '120,180p' notes.txt 2>&1",
    "sed -n '1p' notes.txt > /tmp/x.txt",
  ])("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test("from a subdirectory of the worktree", () => {
    expectAllowed(bash("sed -n '120,180p' src/floor/classify.ts", join(ROOT, "packages", "collector")));
    expectAllowed(bash("cd packages/collector && sed -n '120,180p' src/floor/classify.ts"));
  });
});

describe("sed reads of protected files, and scripts that write, run or can't be read", () => {
  test.each([
    `sed -n '1p' ${join(DATA, "secrets", "token")}`,
    `sed -n '1,5p' ${join(SCRATCH, "launch-2", "prompt.md")}`,
  ])("%p is held as a read of owner-side secrets", (command) => {
    expectHeld(bash(command), "floor-tamper");
  });

  test.each([
    `sed -n '1,5w ${join(INSTALL, "x.ts")}' notes.txt`,
    `sed -n '1,5W ${join(HOME, ".zprofile")}' notes.txt`,
    `sed -n 's/a/b/w ${join(INSTALL, "x.ts")}' notes.txt`,
    `sed -n 's/[/]/b/w ${join(INSTALL, "x.ts")}' notes.txt`,
    `sed -n '/[/]/w ${join(INSTALL, "x.ts")}' notes.txt`,
    `sed -i '1,5d' ${join(INSTALL, "packages", "collector", "src", "floor", "classify.ts")}`,
    `sed -n -i '1,5p' ${join(HOME, ".zshrc")}`,
  ])("%p is held as the write it makes", (command) => {
    expectHeld(bash(command), "floor-tamper");
  });

  test.each([
    "sed -n '1e git push origin main' notes.txt",
    "sed -n 's/.*/git push origin main/e' notes.txt",
    "sed -n '/[/]/e git push origin main' notes.txt",
    "sed -n '/[/]/,/x/e git push origin main' notes.txt",
    "sed -n 's/[/]/x/;1e git push origin main' notes.txt",
    "sed -n '\\,[,],e git push origin main' notes.txt",
    "sed -n '/[]/]/e git push origin main' notes.txt",
    "sed -n '/[^]/]/e git push origin main' notes.txt",
    "sed -n '/[[:alpha:]/]/e git push origin main' notes.txt",
    "sed -n '/[[=/=]/]/e git push origin main' notes.txt",
    "sed -n '/[a\\]/,/x/e git push origin main' notes.txt",
    "sed -n 's|[|]|x|;1e git push origin main' notes.txt",
    "sed -n 's/a/[/;1e git push origin main' notes.txt",
    "sed -n 'y/[/x/;1e git push origin main' notes.txt",
    "sed -n 's[a[b[;1e git push origin main' notes.txt",
  ])("%p is held as the command it runs", (command) => {
    expectHeld(bash(command), "outward");
  });

  test.each([
    "sed -n '1,5e' notes.txt",
    "sed 's/x/&/e' notes.txt",
    'sed -n "${N}p" notes.txt',
    'sed -n "$A,$Bp" notes.txt',
    // An operand whose value is unknown may be `-i`: with a guarded file beside it, that is an edit of it.
    `sed -n '1,5p' "$(cat /tmp/name)" ${join(INSTALL, "x.ts")}`,
  ])("%p stays held", (command) => {
    expectHeld(bash(command), "unclassified");
  });
});
