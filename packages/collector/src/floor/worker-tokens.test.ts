import { describe, expect, test } from "bun:test";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorCategory, FloorVerdict } from "./gate.js";
import { buildLaunchFloorConfig } from "./launch.js";

/*
 * Launch review tokens live in `<dataDir>/worker-tokens/<launchId>`, read by
 * each worker's standup MCP server and never by a tool call: the floor holds
 * any worker's reach into that dir, its own file included, and holds `tmux
 * show-environment` (which prints other sessions' environments).
 */

const HOME = "/home/tester";
const DATA = `${HOME}/.local/share/standup`;
const ROOT = `${DATA}/worktrees/standup/feat-1`;
const TOKENS = `${DATA}/worker-tokens`;

const config = buildLaunchFloorConfig(
  { launchId: "launch-1", root: ROOT, workerToken: "x".repeat(64), replyPublicKey: "test" },
  { DB_PATH: `${DATA}/standup.db`, HOME }
);

const FILES: Record<string, string> = {
  [`${TOKENS}/launch-1`]: "a".repeat(64),
  [`${TOKENS}/launch-2`]: "b".repeat(64),
  [`${ROOT}/README.md`]: "hi",
};
const DIRS = new Set<string>(["/", "/tmp", ROOT, TOKENS]);
for (const f of Object.keys(FILES)) {
  for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) DIRS.add(d);
}

const probes: Partial<FloorProbes> = {
  gitBranch: () => "standup/feat-1",
  gitAlias: () => null,
  gitHooksDir: () => null,
  readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
  exists: (p) => p in FILES || DIRS.has(p),
  isDirectory: (p) => DIRS.has(p),
  listDir: (p) => (p === TOKENS ? ["launch-1", "launch-2"] : []),
  realpath: (p) => (p in FILES || DIRS.has(p) ? p : null),
  homeDir: () => HOME,
  shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
  awsAccount: () => null,
  now: () => Date.now(),
};

const bash = (command: string): FloorVerdict =>
  classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes);
const tool = (toolName: string, toolInput: Record<string, unknown>): FloorVerdict =>
  classifyToolCall({ toolName, toolInput, cwd: ROOT }, config, probes);

function expectHold(v: FloorVerdict, category: FloorCategory = "floor-tamper"): void {
  expect(v.action).toBe("hold");
  if (v.action === "hold") expect(v.category).toBe(category);
}

describe("the worker-tokens dir", () => {
  test("is one of the launch's protected paths", () => {
    expect(config.protectedPaths).toContain(TOKENS);
  });

  test("reading another launch's token file is held, by any route", () => {
    for (const command of [
      `cat ${TOKENS}/launch-2`,
      `head -c 64 ~/.local/share/standup/worker-tokens/launch-2`,
      `cp ${TOKENS}/launch-2 /tmp/t`,
      `ls ${TOKENS}`,
      `grep -r . ${DATA}/worker-tokens`,
      `D=${TOKENS}; cat $D/launch-2`,
      `cd ${TOKENS} && cat launch-2`,
      `STANDUP_WORKER_TOKEN_FILE=${TOKENS}/launch-2 bun packages/mcp/src/index.ts`,
    ]) {
      expectHold(bash(command));
    }
    expectHold(tool("Read", { file_path: `${TOKENS}/launch-2` }));
    expectHold(tool("Grep", { pattern: ".", path: TOKENS }));
  });

  test("writing or removing one is held too", () => {
    expectHold(bash(`echo forged > ${TOKENS}/launch-2`));
    expectHold(bash(`rm -f ${TOKENS}/launch-2`));
    expectHold(tool("Write", { file_path: `${TOKENS}/launch-2`, content: "x" }));
  });

  test("ordinary work in the worktree is not", () => {
    expect(bash(`cat ${ROOT}/README.md`).action).toBe("allow");
  });
});

describe("tmux show-environment", () => {
  test("is held under every spelling", () => {
    for (const command of [
      "tmux show-environment",
      "tmux show-environment -g",
      "tmux show-environment -t other STANDUP_WORKER_TOKEN_FILE",
      "tmux showenv -t other",
      "tmux show-env -g",
      "tmux -L default show-e",
      "tmux list-sessions \\; show-environment -g",
    ]) {
      expectHold(bash(command));
    }
  });

  test("other read-only tmux commands still run", () => {
    expect(bash("tmux list-sessions").action).toBe("allow");
    expect(bash("tmux show-options -g").action).toBe("allow");
  });
});
