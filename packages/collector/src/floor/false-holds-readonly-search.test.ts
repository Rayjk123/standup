import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A read-only tool (rg, grep, sed -n, cat, head, tail, less, find without an
 * action that writes or runs, ls, wc, jq) that names a Claude Code hook
 * setting or a Claude settings file in its pattern or its file arguments
 * reads text; it changes nothing. A write, move, delete or in-place edit of
 * that settings file is still floor-tamper.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const COMMON = join("/", "fake", "repo", ".git");
const SETTINGS = join(HOME, ".claude", "settings.json");

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
  [join(ROOT, "packages", "a.ts")]: "a\n",
  [join(ROOT, "new.json")]: "{}\n",
  [SETTINGS]: "{}\n",
  [join(HOME, ".claude", "settings.local.json")]: "{}\n",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT, join(HOME, ".claude"), join(HOME, ".claude", "hooks"), join(HOME, ".claude", "agents")]);
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

function tool(toolName: string, toolInput: Record<string, unknown>): FloorVerdict {
  return classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes());
}

describe("a read-only search or read naming Claude hook settings", () => {
  test.each([
    `rg -n 'disableAllHooks|settings.json' packages/`,
    `rg -n "disableAllHooks" packages/`,
    `rg -n disableAllHooks packages/`,
    `rg -n -e disableAllHooks -e allowManagedHooksOnly packages/`,
    `grep -rn disableAllHooks packages/`,
    `grep -rn 'disableAllHooks' ~/.claude/settings.json`,
    `grep -rn settings.json ~/.claude/hooks/ ~/.claude/agents/`,
    `grep -rn disableAllHooks ~/.claude/hooks/`,
    `grep -n hooks ~/.claude/settings.json`,
    `grep -c disableAllHooks ~/.claude/settings.json ~/.claude/settings.local.json`,
    `sed -n '1,40p' ~/.claude/settings.json`,
    `sed -n '/disableAllHooks/p' packages/a.ts`,
    `cat ~/.claude/settings.json`,
    `head -n 20 ~/.claude/settings.json`,
    `tail -n 20 ~/.claude/settings.json`,
    `less ~/.claude/settings.json`,
    `wc -l ~/.claude/settings.json`,
    `ls -la ~/.claude/ ~/.claude/hooks ~/.claude/agents`,
    `find ~/.claude -name settings.json`,
    `find ~/.claude/hooks -type f`,
    `jq '.hooks' ~/.claude/settings.json`,
    `jq -r '.disableAllHooks // empty' ~/.claude/settings.json`,
    `jq '.disableAllHooks == true' ~/.claude/settings.json`,
    `jq 'select(.disableAllHooks != null)' ~/.claude/settings.json`,
    `cat ~/.claude/settings.json | jq .hooks`,
    `rg -n disableAllHooks packages/ | head -20`,
    `rg -n disableAllHooks packages/ | cut -d: -f1 | tr a-z A-Z | wc -l`,
    `rg -n disableAllHooks packages/ 2>/dev/null`,
    `rg -n disableAllHooks packages/ 2>&1 | head -20`,
    `grep -rn disableAllHooks packages/ 2>/dev/null | head -20 2>/dev/null`,
    `sed -n ':a;$!N;/disableAllHooks/p;$!ba' packages/a.ts`,
    `grep -n disableAllHooks ~/.claude/settings.json | wc -l`,
    `sed -n -e '/disableAllHooks/p' -e '/allowManagedHooksOnly/p' packages/a.ts`,
    `sed -n '/"hooks"/,/^  }/p' ~/.claude/settings.json`,
    `sed 's/disableAllHooks/x/' packages/a.ts`,
  ])("allows %p", (command) => {
    expect(bash(command)).toEqual({ action: "allow" });
  });

  test.each([
    { toolName: "Read", toolInput: { file_path: SETTINGS } },
    { toolName: "Grep", toolInput: { pattern: "disableAllHooks", path: SETTINGS } },
    { toolName: "Grep", toolInput: { pattern: "disableAllHooks|allowManagedHooksOnly", path: join(ROOT, "packages") } },
  ])("allows the $toolName tool", ({ toolName, toolInput }) => {
    expect(tool(toolName, toolInput)).toEqual({ action: "allow" });
  });
});

describe("a write, move, delete or edit of a Claude settings file", () => {
  test.each([
    `echo '{"disableAllHooks": true}' > ~/.claude/settings.json`,
    `echo '{}' > ~/.claude/settings.json`,
    `echo '{}' >> ~/.claude/settings.json`,
    `echo '{}' | tee ~/.claude/settings.json`,
    `echo '{}' | tee -a ~/.claude/settings.json`,
    `sed -i 's/"hooks"/"x"/' ~/.claude/settings.json`,
    `sed -n -i 's/"hooks"/"x"/p' ~/.claude/settings.json`,
    `sed -n 's/a/b/w ${SETTINGS}' packages/a.ts`,
    `cp new.json ~/.claude/settings.json`,
    `mv new.json ~/.claude/settings.json`,
    `mv ~/.claude/settings.json /tmp/s.json`,
    `rm ~/.claude/settings.json`,
    `find ~/.claude -name settings.json -delete`,
    `find ~/.claude -name settings.json -exec rm {} +`,
    `jq '.disableAllHooks = true' ~/.claude/settings.json > /tmp/s && mv /tmp/s ~/.claude/settings.json`,
    `rg -n disableAllHooks packages/ > ~/.claude/settings.json`,
    `grep -rn hooks packages/ | tee ~/.claude/settings.json`,
    `echo '{}' > ~/.claude/hooks/pre.sh`,
    `cp new.json ~/.claude/agents/a.md`,
  ])("holds %p as floor-tamper", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  // The setting's name is still held where a reader's output or words go on to a program that may act on them.
  test.each([
    `jq -n '{disableAllHooks: true}' | uniq - ~/.claude/settings.json`,
    `jq -n '{disableAllHooks: true}' | shuf -o ~/.claude/settings.json`,
    `jq -n '{disableAllHooks: true}' | less -o ~/.claude/settings.json`,
    `jq -n '{disableAllHooks: true}' | sort -o .claude/settings.local.json`,
    `jq -rn '"!echo disableAllHooks"' | dc`,
    `echo x | sed 'c {"disableAllHooks": true}' | uniq - .claude/settings.local.json`,
    `rg -n disableAllHooks packages/ 2>/tmp/err`,
    `rg -n disableAllHooks packages/ > /tmp/out`,
    `exec > /tmp/s.json; jq -n '{disableAllHooks: true}'`,
    `exec 2>&1 >/tmp/s.json; grep -h disableAllHooks packages/a.ts`,
    // GNU sed ends a label at a blank: the rest of the line is a command.
    `echo x | sed -n 's/.*/{"disableAllHooks":true}/;:a w ${SETTINGS}'`,
    `echo x | sed -n 's/.*/{"disableAllHooks":true}/;bz w ${SETTINGS}\n:z'`,
    `echo x | sed -n 's/.*/{"disableAllHooks":true}/;tz w ${SETTINGS}\n:z'`,
    `sed -n '/disableAllHooks/p;:a e touch /tmp/pwn' packages/a.ts`,
  ])("holds %p by its hook setting", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", reason: expect.stringContaining("disables hooks") });
  });

  // Without the setting's name, the walk reads the label's command too.
  test.each([
    `echo x | sed -n ':a w ${join(HOME, ".claude", "hooks", "pre.sh")}'`,
    `echo x | sed -n ':a e touch ~/.claude/hooks/pre.sh'`,
    `echo x | sed -n 'bz w ${SETTINGS}\n:z'`,
  ])("holds %p as floor-tamper", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test.each([
    `rg -n disableAllHooks packages/ | sh`,
    `rg -n disableAllHooks packages/ | xargs echo`,
    `grep -o disableAllHooks packages/a.ts | head`,
    `sed -n '/disableAllHooks/w /tmp/out' packages/a.ts`,
    `sed -n 's/x/disableAllHooks/e' packages/a.ts`,
    `sed -i 's/x/disableAllHooks/' packages/a.ts`,
    `sed -n -f /tmp/script '/disableAllHooks/p' packages/a.ts`,
    `jq '.disableAllHooks = true' ~/.claude/settings.json`,
    `jq '.disableAllHooks |= true' packages/a.ts`,
    `jq --arg v x '.disableAllHooks += $v' packages/a.ts`,
    `jq -n '{disableAllHooks: true}' > .claude/settings.local.json`,
    `jq -n '{disableAllHooks: true}' | tee .claude/settings.local.json`,
    `claude --settings '{"disableAllHooks": true}'`,
    `grep -n disableAllHooks packages/a.ts; claude --settings '{"disableAllHooks": true}'`,
  ])("holds %p by its hook setting too", (command) => {
    expect(bash(command)).toMatchObject({ action: "hold", reason: expect.stringContaining("disables hooks") });
  });

  // A recursive read of ~/.claude also reads its credentials file.
  test("holds a recursive search of all of ~/.claude", () => {
    expect(bash(`grep -rn settings.json ~/.claude/`)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });

  test.each([
    { toolName: "Write", toolInput: { file_path: SETTINGS, content: "{}" } },
    { toolName: "Edit", toolInput: { file_path: SETTINGS, old_string: "{}", new_string: '{"disableAllHooks":true}' } },
    { toolName: "Write", toolInput: { file_path: join(HOME, ".claude", "hooks", "pre.sh"), content: "x" } },
  ])("holds the $toolName tool as floor-tamper", ({ toolName, toolInput }) => {
    expect(tool(toolName, toolInput)).toMatchObject({ action: "hold", category: "floor-tamper" });
  });
});
