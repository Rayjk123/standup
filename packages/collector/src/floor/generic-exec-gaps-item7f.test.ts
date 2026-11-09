import { describe, expect, test } from "bun:test";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * tmux words in a comment, an error message or a printed string name no tmux
 * call: a command or script that only says them is allowed. A real tmux
 * invocation on the shared server, from the shell, a nested shell string,
 * eval, or an exec sink in code, still holds. The machine is virtual.
 */

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

/** A worker's PATH: the install's and worktree's node_modules/.bin dirs before the system ones. */
const WORKER_PATH = [
  `${ROOT}/node_modules/.bin`,
  `${INSTALL}/packages/node_modules/.bin`,
  `${INSTALL}/node_modules/.bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const BASE_FILES: Record<string, string> = {
  [`${ROOT}/.git`]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [`${HOME}/.claude/settings.json`]: "{}\n",
  [`${ROOT}/scripts/comment.ts`]: [
    "// tmux kill-session -t foo is not safe",
    "export function sum(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "console.log(sum(1, 2));",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/error.ts`]: [
    "export function refuse(): never {",
    '  throw new Error("tmux send-keys to the shared server is refused");',
    "}",
    "if (process.argv[2] === \"x\") refuse();",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/comment.js`]: [
    "// tmux kill-server would end every session",
    "console.error(\"tmux attach -t other is not used here\");",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/comment.sh`]: [
    "#!/bin/bash",
    "# don't use tmux kill-server here",
    'echo "tmux send-keys failed" >&2',
    "exit 0",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/error-kill.ts`]: [
    "export function refuse(): never {",
    '  throw new Error("tmux kill-server would end every session; refused");',
    "}",
    "if (process.argv[2] === \"x\") refuse();",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/unplaced.sh`]: [
    "#!/bin/bash",
    "# don't use tmux kill-server here",
    'echo ok > "$OUT"',
    "",
  ].join("\n"),
  [`${ROOT}/scripts/spawn.ts`]: [
    'import { spawnSync } from "child_process";',
    'spawnSync("tmux", ["kill-server"]);',
    "",
  ].join("\n"),
  [`${ROOT}/scripts/dollar.ts`]: [
    'import { $ } from "bun";',
    "await $`tmux kill-server`;",
    "",
  ].join("\n"),
  [`${ROOT}/scripts/sendkeys.ts`]: [
    'import { spawnSync } from "child_process";',
    'spawnSync("tmux", ["send-keys", "-t", "other", "ls", "Enter"]);',
    "",
  ].join("\n"),
};

function probes(files: Record<string, string>, env: Record<string, string>): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(`${ROOT}/.git`);
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    env: (name) => env[name],
    now: () => Date.now(),
  };
}

function bash(command: string): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(BASE_FILES, { HOME, PATH: WORKER_PATH }));
}

describe("tmux words that name no tmux call", () => {
  for (const command of [
    "# don't use tmux kill-server here\necho ok",
    "echo ok # don't use tmux kill-server here",
    'echo "tmux send-keys failed" >&2',
    "echo 'tmux kill-server failed' >&2",
    "printf 'tmux attach -t x\\n'",
    "printf '%s\\n' 'tmux kill-session -t foo'",
    "bun scripts/comment.ts",
    "bun scripts/error.ts",
    "node scripts/comment.js",
    "bash scripts/comment.sh",
  ]) {
    test(`allowed: ${JSON.stringify(command)}`, () => {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

describe("tmux words beside a step the floor can't place", () => {
  for (const command of [
    'echo ok > "$OUT"',
    '# don\'t use tmux kill-server here\necho ok > "$OUT"',
    'echo ok > "$OUT" # tmux kill-session -t foo is not safe',
    "# tmux kill-server\n# tmux kill-session -t x\necho ok > \"$OUT\" # tmux kill-server",
    'bun scripts/comment.ts > "$OUT"',
    'bun scripts/error-kill.ts > "$OUT"',
    "bash scripts/unplaced.sh",
  ]) {
    test(`allowed: ${JSON.stringify(command)}`, () => {
      expect({ command, verdict: bash(command) }).toEqual({ command, verdict: { action: "allow" } });
    });
  }
});

describe("tmux words handed to a program beside a step the floor can't place still hold", () => {
  for (const command of [
    // Words a program is handed, quoted or not, may be run by it.
    'echo "tmux kill-server failed" > "$OUT"',
    "printf 'tmux kill-session -t x\\n' > \"$OUT\"",
    "echo ok > \"$OUT\" '# tmux kill-server'",
    'echo ok > "$OUT" "# tmux kill-server"',
    // A `#` inside a word starts no comment.
    'echo ok > "$OUT" a#tmux kill-server',
    // A here-doc body is data handed to the program.
    'cat > "$OUT" <<EOF\n# tmux kill-server\nEOF',
    // A comment inside a nested shell string is still the outer command's quoted text.
    "bash -c 'echo ok > \"$OUT\" # tmux kill-server'",
    'echo ok > "$OUT"\ntmux kill-server',
  ]) {
    test(`held: ${JSON.stringify(command)}`, () => {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    });
  }
});

describe("real tmux calls on the shared server still hold", () => {
  for (const command of [
    "tmux send-keys -t other 'ls' Enter",
    "tmux kill-server",
    "tmux kill-session -t other",
    'bash -c "tmux kill-server"',
    'sh -c "tmux send-keys -t other ls Enter"',
    'eval "tmux kill-server"',
    "echo ok; tmux kill-server",
    "# a comment\ntmux kill-server",
    "bun scripts/spawn.ts",
    "bun scripts/dollar.ts",
    "bun scripts/sendkeys.ts",
    'bun -e \'require("child_process").spawnSync("tmux", ["kill-server"])\'',
    "pkill -f collector",
  ]) {
    test(`held: ${JSON.stringify(command)}`, () => {
      expect({ command, action: bash(command).action }).toEqual({ command, action: "hold" });
    });
  }
});
