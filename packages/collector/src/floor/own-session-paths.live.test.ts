import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { encodeFloorConfig, type FloorConfig } from "./gate.js";

/*
 * The real hook process, spawned as Claude Code runs it (payload on stdin,
 * config in argv), against the real filesystem: the home, Standup data dir,
 * install and worktree all lie under a fresh /tmp dir. The collector URL is
 * dead, so a held call ends denied without reaching one; an allowed call
 * exits 0 with no output. The session id comes from the payload.
 */

const HOOK = join(import.meta.dir, "hook.ts");
const LAUNCH = "a1a1a1a1-0000-4000-8000-0000000000a1";
const OTHER_LAUNCH = "a2a2a2a2-0000-4000-8000-0000000000a2";
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-2222-4333-8444-555555555555";

let base: string;
let home: string;
let root: string;
let arg: string;
const scratchOf = (launch: string) => join(home, ".cache", "standup-scratch", launch);
const sessionOf = (session: string) => join(home, ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"), session);

beforeAll(() => {
  base = realpathSync(mkdtempSync(join("/tmp", "own-session-live-")));
  home = join(base, "home");
  root = join(base, "data", "worktrees", "standup", "feat-1");
  const data = join(base, "data");
  for (const d of [root, scratchOf(LAUNCH), scratchOf(OTHER_LAUNCH), join(data, "secrets"), join(base, "install", "packages", "collector", "src", "floor")]) mkdirSync(d, { recursive: true });
  for (const s of [SESSION, OTHER_SESSION]) {
    mkdirSync(join(sessionOf(s), "workflows", "scripts"), { recursive: true });
    mkdirSync(join(sessionOf(s), "tool-results"), { recursive: true });
    writeFileSync(join(sessionOf(s), "workflows", "scripts", "w.js"), "x\n");
    writeFileSync(join(sessionOf(s), "tool-results", "r.json"), "{}\n");
  }
  writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(root, ".git"), `gitdir: ${join(base, "repo.git")}\n`);
  const config: FloorConfig = {
    v: 1,
    collectorUrl: "http://127.0.0.1:1",
    launchId: LAUNCH,
    scratchRoot: join(home, ".cache", "standup-scratch"),
    scratchDir: scratchOf(LAUNCH),
    root,
    sharedBranches: ["main"],
    personalAwsAccounts: [],
    waitSeconds: 1,
    standupDataDir: data,
    floorPaths: [join(base, "install", "packages", "collector", "src", "floor")],
    installDir: join(base, "install"),
    protectedPaths: [join(data, "secrets"), join(home, ".cache", "standup-scratch")],
    worktreeRoots: [join(data, "worktrees")],
    tmpDirs: ["/tmp", "/var/tmp"],
    workerToken: "w".repeat(64),
    replyPublicKey: "test",
  };
  arg = encodeFloorConfig(config);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Runs the hook on one call from SESSION: "allow" when it exits 0 with no output, else "hold". */
function hook(toolName: string, toolInput: Record<string, unknown>): "allow" | "hold" {
  const payload = { session_id: SESSION, cwd: root, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: "toolu_1" };
  const r = spawnSync(process.execPath, ["--no-env-file", HOOK, arg], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: scratchOf(LAUNCH), STANDUP_FLOOR_UNREACHABLE_GRACE_MS: "0" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const verdict = r.status === 0 && !r.stdout.trim() ? "allow" : "hold";
  console.log(`[live] ${toolName} -> ${verdict}${r.stdout.trim() ? ` ${r.stdout.trim().slice(0, 240)}` : ""}`);
  return verdict;
}

const brief = (dir: string) => `mkdir -p ${dir}/r && cat > ${dir}/r/brief.md <<'EOF'\n# Review\nSee \`a/../b\` and path.dirname(x)\nEOF\nwc -l ${dir}/r/brief.md`;
const pyReads = (path: string) => `cd ${scratchOf(LAUNCH)} && python3 -c 'import json; d=json.load(open("${path}")); open("out.json","w").write(json.dumps(d))'`;

describe("the hook on a worker's own launch scratch and session dirs", () => {
  const cases: Array<[string, "allow" | "hold", () => [string, Record<string, unknown>]]> = [
    ["own scratch: heredoc then wc", "allow", () => ["Bash", { command: brief(scratchOf(LAUNCH)) }]],
    ["other launch's scratch: heredoc then wc", "hold", () => ["Bash", { command: brief(scratchOf(OTHER_LAUNCH)) }]],
    ["scratch root: Write", "hold", () => ["Write", { file_path: join(home, ".cache", "standup-scratch", "n.txt"), content: "x" }]],
    ["own session: Edit a workflow script", "allow", () => ["Edit", { file_path: join(sessionOf(SESSION), "workflows", "scripts", "w.js"), old_string: "x", new_string: "y" }]],
    ["other session: Edit a workflow script", "hold", () => ["Edit", { file_path: join(sessionOf(OTHER_SESSION), "workflows", "scripts", "w.js"), old_string: "x", new_string: "y" }]],
    ["own session: code reads a tool result", "allow", () => ["Bash", { command: pyReads(join(sessionOf(SESSION), "tool-results", "r.json")) }]],
    ["other session: code reads a tool result", "hold", () => ["Bash", { command: pyReads(join(sessionOf(OTHER_SESSION), "tool-results", "r.json")) }]],
    ["~/.claude/settings.json: Write", "hold", () => ["Write", { file_path: join(home, ".claude", "settings.json"), content: "{}" }]],
  ];
  test.each(cases)("%s: %s", (_name, want, make) => {
    const [tool, input] = make();
    expect(hook(tool, input)).toBe(want);
  });
});
