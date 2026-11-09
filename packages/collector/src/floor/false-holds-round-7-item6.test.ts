import { describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * tmux words in a comment, an error message, an echoed or grepped string are
 * text: only a shell command whose program is tmux, or code whose exec sink
 * hands tmux its argv, reaches the shared tmux server. Code that can run
 * commands has each of its literals read as one; an error message read so
 * (`tmux kill-session failed`, `tmux kill-server: no server`) is a command
 * tmux refuses: its kill commands take no operand, and no command name ends
 * in punctuation. A literal that is a whole kill command stays held, since
 * the floor can't tell where it flows.
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

const SCRIPTS: Record<string, string> = {
  "comment.ts": '// never run tmux kill-server here\nconsole.log("ok");\n',
  "block-comment.ts": '/* tmux kill-session -t x would end the session */\nconsole.log("ok");\n',
  "throw.ts": 'throw new Error("tmux kill-session failed");\n',
  "console-error.ts": 'console.error("tmux: no server");\nconsole.error("tmux kill-server failed");\n',
  "message.js": 'const msg = "run tmux kill-server to reset";\nconsole.log(msg);\n',
  "comment.py": '# never run tmux kill-server here\nprint("ok")\n',
  "error.py": 'raise RuntimeError("tmux kill-session failed")\n',
  "comment.sh": '#!/bin/bash\n# never run tmux kill-server here\necho ok\n',
  "echo.sh": '#!/bin/bash\necho "tmux kill-server failed" >&2\n',
  "spawn.ts": 'import { spawn } from "child_process";\nspawn("tmux", ["kill-server"]);\n',
  "spawn-shared.ts": 'import { spawnSync } from "child_process";\nspawnSync("tmux", ["-L", "default", "kill-server"]);\n',
  "exec-sync.ts": 'import { execSync } from "child_process";\nexecSync("tmux kill-server");\n',
  "bun-spawn.ts": 'Bun.spawn(["tmux", "kill-server"]);\n',
  "bun-spawn-session.ts": 'Bun.spawnSync(["tmux", "kill-session", "-t", "w1"]);\n',
  "flow.ts": 'import { execSync } from "child_process";\nconst cmd = "tmux kill-server";\nexecSync(cmd);\n',
  "run-sub.py": 'import subprocess\nsubprocess.run(["tmux", "kill-server"])\n',
  "msg-colon.ts": 'import { spawnSync } from "child_process";\nconst r = spawnSync("git", ["status"]);\nif (r.status) console.error("tmux kill-server: no server running");\n',
  "msg-target.ts": 'import { spawnSync } from "child_process";\nconst r = spawnSync("git", ["status"]);\nif (r.status) throw new Error("tmux kill-session -t w1 failed");\n',
  "msg-concat.ts": 'import { spawnSync } from "child_process";\nconst r = spawnSync("git", ["status"]);\nif (r.status) throw new Error("tmux kill-window failed: " + r.stderr);\n',
  "msg-run.js": 'const { execSync } = require("child_process");\nexecSync("git status");\nconsole.log("run tmux kill-server to reset");\n',
  "msg-bare.ts": 'import { spawnSync } from "child_process";\nspawnSync("git", ["status"]);\nconst hint = "tmux kill-server";\nconsole.log(hint);\n',
  "argv-operand.ts": 'import { spawnSync } from "child_process";\nspawnSync("tmux", ["kill-session", "-t", "w1"]);\n',
  "kill.sh": "#!/bin/bash\ntmux kill-server\n",
  "runner.test.ts": 'import { expect, test } from "bun:test";\n// never run tmux kill-server here\ntest("x", () => { expect(() => { throw new Error("tmux kill-session failed"); }).toThrow(); });\n',
  "exec-other.ts": 'import { execSync } from "child_process";\n// never run tmux kill-server here\nexecSync("git status");\n',
  "exec-comment.ts": 'import { execFileSync } from "child_process";\nexecFileSync("git", ["status"]); // tmux kill-server would end every session\nconsole.error("tmux: no server");\n',
  "spawn-msg.ts": 'import { spawnSync } from "child_process";\nconst r = spawnSync("git", ["status"]);\nif (r.status) throw new Error("tmux kill-session failed");\n',
  "sub-comment.py": 'import subprocess\n# never run tmux kill-server here\nsubprocess.run(["git", "status"])\nraise RuntimeError("tmux kill-session failed")\n',
  "mixed.sh": '#!/bin/bash\n# tmux kill-server is never run here\ngit status\necho "tmux kill-session failed" >&2\ngrep -n "tmux kill" notes.md\n',
  "flow-array.ts": 'import { execSync } from "child_process";\nconst parts = ["tmux kill-server", "x"];\nexecSync(parts[0]);\n',
  "private.ts":'import { spawnSync } from "child_process";\nspawnSync("tmux", ["-S", "/tmp/x/sock", "kill-server"]);\n',
};

const FILES: Record<string, string> = {
  [join(ROOT, ".git")]: `gitdir: ${COMMON}/worktrees/feat-1\n`,
  [join(ROOT, "notes.md")]: "tmux kill-server ends every session\n",
  ["/tmp/x/c.ts"]: SCRIPTS["comment.ts"]!,
  ["/tmp/x/c.sh"]: SCRIPTS["mixed.sh"]!,
  ...Object.fromEntries(Object.entries(SCRIPTS).map(([name, text]) => [join(ROOT, "s", name), text])),
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", "/tmp/x", ROOT]);
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

function expectHeld(v: FloorVerdict): void {
  expect(v.action).toBe("hold");
}

describe("tmux words that are text", () => {
  test.each([
    "bun s/comment.ts",
    "bun s/block-comment.ts",
    "bun s/throw.ts",
    "bun s/console-error.ts",
    "node s/message.js",
    "python3 s/comment.py",
    "python3 s/error.py",
    "bash s/comment.sh",
    "bash s/echo.sh",
    "ls # tmux kill-server",
    "echo ok # then tmux kill-server",
    'echo "tmux kill-server"',
    "echo 'tmux kill-session -t w1 failed'",
    'grep -n "tmux kill" notes.md',
    'rg "tmux kill-server" s',
    'printf "%s\\n" "tmux kill-server"',
    `bun -e 'console.error("tmux kill-server failed")'`,
    `bun -e '// tmux kill-server\nconsole.log(1)'`,
    `python3 -c 'print("tmux kill-server")'`,
    "bun test s/runner.test.ts",
    "bun s/exec-other.ts",
    "bun s/exec-comment.ts",
    "bun s/spawn-msg.ts",
    "python3 s/sub-comment.py",
    "bash s/mixed.sh",
    "cp s/comment.ts /tmp/x/c.ts",
    "bun /tmp/x/c.ts",
    "bash /tmp/x/c.sh",
    'git commit -m "never call tmux kill-server from tests"',
    "cat <<'EOF' > /tmp/x/n.txt\ntmux kill-server\nEOF",
    "cat <<'EOF'\nuse tmux kill-session to end it\nEOF",
    "grep -rn 'tmux kill' s | head",
    "ls s | grep tmux",
    'echo "tmux -L default kill-server" > /tmp/x/n.txt',
    "bun s/msg-colon.ts",
    "bun s/msg-target.ts",
    "bun s/msg-concat.ts",
    "node s/msg-run.js",
    "tmux kill-session failed",
    "tmux kill-server now",
    "tmux kill-session -t w1 failed",
    "tmux kill-window -- w1",
    "tmux kill-server: no server running",
  ])("allows %p", (command) => {
    expectAllowed(bash(command));
  });
});

describe("tmux invocations", () => {
  test.each([
    "tmux kill-server",
    "tmux kill-session -t w1",
    "tmux -L default kill-server",
    "timeout 5 tmux kill-server",
    'bash -c "tmux kill-server"',
    "sh -c 'tmux kill-session -t w1'",
    "eval 'tmux kill-server'",
    "echo ok; tmux kill-server",
    "bun s/spawn.ts",
    "bun s/spawn-shared.ts",
    "bun s/exec-sync.ts",
    "bun s/bun-spawn.ts",
    "bun s/bun-spawn-session.ts",
    "bun s/flow.ts",
    "python3 s/run-sub.py",
    "bun s/flow-array.ts",
    "bun s/msg-bare.ts",
    "bun s/argv-operand.ts",
    "tmux kill-session -t w1",
    "tmux kill-ses -a",
    "tmux kill-ser",
    "tmux kill-pane -a -t %3",
    "tmux killw -t w1",
    "tmux kill-session -t",
    'tmux kill-session "$X"',
    "tmux kill-session $X",
    "tmux kill-session -x w1",
    "tmux kill-server \\; ls",
    "tmux kill-session failed \\; kill-server",
    "tmux -L default kill-session -t w1",
    "tmux kill-server:x",
    "tmux respawn-pane -k now",
    "bash s/kill.sh",
    `bun -e 'Bun.spawnSync(["tmux", "kill-server"])'`,
    `bun -e 'require("child_process").execSync("tmux kill-server")'`,
    `python3 -c 'import subprocess; subprocess.run(["tmux", "kill-server"])'`,
    `node -e 'require("child_process").execSync("tmux kill-" + "server")'`,
  ])("holds %p", (command) => {
    expectHeld(bash(command));
  });
});

describe("a private tmux socket", () => {
  test("is allowed as it was", () => {
    expectAllowed(bash("tmux -S /tmp/x/sock kill-server"));
    expectAllowed(bash("bun s/private.ts"));
  });
});
