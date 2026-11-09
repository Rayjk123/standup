import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A string literal in code that doesn't parse as shell is read a second
 * time with its quotes and brackets as spaces. In that reading, a redirect
 * operator followed by a bracket, brace or paren writes nothing the literal
 * names: the word after the bracket is a target only the loosening made
 * (`-->[\s\S]*?` read as `--> s S`). A target the literal spells out after
 * the operator is still written, and every command the literal names is
 * still read. Persona's playbook and preference-block modules build RegExps
 * from sources with `-->[\s\S]*?` and `-->[ \t]*` in them, read as text.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const HOME = "/fake/home";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const INSTALL = "/fake/install";

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: "launch-1",
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [`${INSTALL}/packages/collector/src/floor`],
  installDir: INSTALL,
  protectedPaths: [`${DATA}/secrets`],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const all: Record<string, string> = {
    [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
    [`${ROOT}/package.json`]: JSON.stringify({ name: "probe", scripts: { test: "bun test" } }),
    ["/fake/repo/.git/HEAD"]: "ref: refs/heads/main\n",
    ...files,
  };
  const dirs = new Set<string>(["/", "/tmp", ROOT, INSTALL]);
  for (const f of Object.keys(all)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in all ? { ok: true, text: all[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in all || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: () => null,
    realpath: (p) => (p in all || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    env: (name) => (name.startsWith("GIT_") ? undefined : process.env[name]),
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** `bun probe.ts` run in `cwd`, with `text` as the script. */
function run(text: string, cwd: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command: "bun probe.ts" }, cwd }, config, probes({ [`${cwd}/probe.ts`]: text }));
}

const summary = (v: FloorVerdict) => (v.action === "allow" ? "allow" : v.category);

const MODULES = ["packages/collector/src/persona/playbook.ts", "packages/collector/src/persona/preferences-block.ts"];

describe("Persona's pattern-table modules, their RegExp sources read as text", () => {
  test.each(MODULES.flatMap((m) => [[m, "the worktree", ROOT], [m, "the install", INSTALL]]))("%s run from %s is allowed", (module, _where, cwd) => {
    expect(run(readFileSync(join(REPO, module), "utf8"), cwd)).toEqual({ action: "allow" });
  });
});

describe("a redirect in the loose reading of a literal that isn't shell", () => {
  // Code that runs a command, so the literal beside it is read as one it may run.
  const literal = (s: string) => `import { execSync } from "child_process";\nexport const TEXT = ${JSON.stringify(s)};\nexecSync("git status");\n`;
  test.each([
    // A bracket, brace or paren right after the operator: the word after it is no target the literal names.
    ["`-->[\\s\\S]*?` in a pattern", "[ \\t]*<!-- begin ([0-9a-f]{6,64}) -->[\\s\\S]*?(?:<!-- end \\1 -->[ \\t]*|$)", "allow"],
    ["`>> (` after a word", "note (x) >> (y)", "allow"],
    ["`> {` after a word", "note (x) > {y}", "allow"],
    ["`<(` after a word", "note (x) <(y)", "allow"],
    // A target the literal spells out after the operator is written.
    ["a relative target", "echo (x) > notes.txt", "floor-tamper"],
    ["an appended relative target", "echo (x) >> notes.txt", "floor-tamper"],
    ["a quoted target", "echo (x) > 'notes.txt'", "floor-tamper"],
    ["a target cut by a bracket after its name", "echo (x) >notes[1]", "floor-tamper"],
    ["a target after another operator's bracket", "echo (x) >[y] ; echo z > notes.txt", "floor-tamper"],
    // The commands the literal names are read whatever the redirect.
    ["a push before the operator", "git push origin HEAD (x) >[y]", "outward"],
    ["a push after the operator", "echo (x) >[y] ; git push origin HEAD", "outward"],
  ])("%s, run from the install", (_what, text, expected) => {
    expect({ text, verdict: summary(run(literal(text), INSTALL)) }).toEqual({ text, verdict: expected });
  });
});
