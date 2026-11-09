import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * Commands that end terminal sessions and processes outside the worker's own
 * scope. Inside a tmux pane `$TMUX` picks the server for any tmux command
 * without -L or -S, whatever TMUX_TMPDIR says, so `TMUX_TMPDIR=… tmux
 * kill-server` there kills that pane's whole server. Workers run on their own
 * server (its socket in Standup's data dir) with `$TMUX` removed, but the
 * floor doesn't count on what the pane's environment holds. The machine is virtual, and its paths are built
 * piece by piece so this file carries no literal Standup path of its own.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const LAUNCH = "a3a3a3a3-0000-4000-8000-0000000000a3";
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const CODE = join("/", "fake", "code");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: LAUNCH,
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

/** The memory load-test script whose teardown ended every worker; only its code path is changed. */
const MEMLOAD = [
  "#!/usr/bin/env bash",
  "set -u",
  'LABEL="${1:?label}"',
  `CODE="\${2:-${CODE}}"`,
  "R=/tmp/memload",
  'RUN="$R/runs/$LABEL"',
  "PORT=7941",
  "WSPORT=7942",
  'rm -rf "$RUN"',
  'mkdir -p "$RUN/state" "$R/home" "$R/tmux" "$R/load"',
  'PID=""',
  'UNIT=""',
  'GUARD=""',
  "start_collector() {",
  '  UNIT="memload-$LABEL-$1"',
  '  systemd-run --user --scope --quiet --unit="$UNIT" -p MemoryMax=24G -p MemorySwapMax=0 \\',
  '    env -i HOME="$R/home" PATH="$PATH" TMUX_TMPDIR="$R/tmux" COLLECTOR_PORT=$PORT WS_PORT=$WSPORT \\',
  '      bun run "$CODE/app.ts" >> "$RUN/collector.log" 2>&1 &',
  "  PID=$!",
  "}",
  "stop_collector() {",
  '  [ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null',
  '  [ -n "$UNIT" ] && systemctl --user stop "$UNIT.scope" 2>/dev/null',
  '  PID=""',
  "}",
  "teardown() {",
  '  [ -n "$GUARD" ] && kill "$GUARD" 2>/dev/null',
  '  pkill -f "collector-memory-load.ts --port $PORT" 2>/dev/null',
  "  stop_collector",
  '  TMUX_TMPDIR="$R/tmux" tmux kill-server 2>/dev/null',
  "}",
  "trap teardown EXIT",
  "start_collector 1 || exit 1",
  "stop_collector",
].join("\n");

const BASE_FILES: Record<string, string> = {
  [join(ROOT, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: JSON.stringify({ name: "x", scripts: { test: "bun test" } }),
  [join(CODE, "app.ts")]: "export const app = 1;\n",
  ["/tmp/memload/run.sh"]: MEMLOAD,
};

/** The shared server's socket, and a link to it a worker left under a private-looking name. */
const SHARED_SOCKET = "/tmp/tmux-1000/default";
const LINKS: Record<string, string> = { "/tmp/tmux-1000/evil": SHARED_SOCKET, "/tmp/lnk/tmux-1000": "/tmp/tmux-1000" };

function probes(extra: Record<string, string> = {}): Partial<FloorProbes> {
  const files: Record<string, string> = { ...BASE_FILES, [SHARED_SOCKET]: "", "/tmp/lnk/tmux-1000/.keep": "", ...extra };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(files)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in files ? { ok: true, text: files[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in files || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(files), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => LINKS[p] ?? (p in files || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

function bash(command: string, files?: Record<string, string>): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes(files));
}

function held(command: string, files?: Record<string, string>): { category: string; reason: string } {
  const v = bash(command, files);
  expect({ command, action: v.action }).toEqual({ command, action: "hold" });
  return v.action === "hold" ? { category: String(v.category), reason: v.reason } : { category: "", reason: "" };
}

function allowed(command: string, files?: Record<string, string>): void {
  expect({ command, verdict: bash(command, files) }).toEqual({ command, verdict: { action: "allow" } });
}

describe("tmux commands that end sessions", () => {
  test("the teardown line from the load-test script is held, naming $TMUX and every worker", () => {
    const { category, reason } = held('R=/tmp/memload; TMUX_TMPDIR="$R/tmux" tmux kill-server 2>/dev/null');
    expect(category).toBe("destructive");
    expect(reason).toContain("tmux kill-server");
    expect(reason).toContain("$TMUX");
    expect(reason).toContain("every worker");
  });

  test("kill-server, kill-session and kill-window without a private socket are held", () => {
    for (const command of [
      "tmux kill-server",
      "TMUX_TMPDIR=/tmp/x tmux kill-server",
      "env TMUX_TMPDIR=/tmp/x tmux kill-server",
      "env -u TMUX tmux kill-server",
      "tmux kill-session -t other",
      "tmux kill-ses -t other",
      "tmux kill-window -t other:1",
      "tmux killw -t other:1",
      "tmux kill-pane -t other:1.0",
      "tmux -L default kill-server",
      "tmux -Ldefault kill-server",
      "tmux -S /tmp/tmux-1000/default kill-server",
      "tmux -S /home/me/sock kill-server",
      'tmux -L "$NAME" kill-server',
      "tmux -uL default kill-server",
      "tmux -L '' kill-server",
      "tmux -S /tmp/tmux-1000/../tmux-1000/default kill-ser",
      "tmux respawn-pane -k -t other:0.0",
      "tmux source-file /tmp/x.conf",
      "tmux if-shell true 'kill-server'",
      "tmux new-session -d -s x \\; kill-server",
      "tmux -L private run-shell 'tmux kill-server'",
    ]) {
      const { category, reason } = held(command);
      expect({ command, category }).toEqual({ command, category: "destructive" });
      expect({ command, mentions: reason.includes("tmux") }).toEqual({ command, mentions: true });
    }
  });

  test("the same commands on the worker's own -L name or -S socket under /tmp are allowed", () => {
    for (const command of [
      "tmux -L private kill-server",
      "tmux -Lprivate kill-server",
      "env -u TMUX tmux -L private kill-server",
      "tmux -L private kill-session -t s1",
      "tmux -L private kill-window -t s1:0",
      "tmux -L private kill-pane -t s1:0.1",
      "tmux -S /tmp/memload/tmux.sock kill-server",
      "tmux -S/tmp/memload/tmux.sock kill-session -t s1",
      "tmux -f /dev/null -L private kill-server",
      "tmux -L private kill-server 2>/dev/null || true",
      "tmux -L private new-session -d -s s1 'sleep 1' \\; kill-session -t s1",
      "tmux -L private if-shell true 'kill-server'",
      "tmux -uL private kill-server",
      "tmux -L private respawn-pane -k -t s1:0.0",
      "tmux ls",
      "tmux has-session -t s1",
    ]) {
      allowed(command);
    }
  });

  test("a -S socket outside /tmp, or that climbs out of it, is not private", () => {
    held("tmux -S /tmp/../home/me/sock kill-server");
    held("tmux -S ./sock kill-server");
  });
});

describe("process and unit kills that can reach other sessions", () => {
  test("pkill and killall by a name or pattern are held", () => {
    for (const command of ['pkill -f "collector-memory-load.ts --port 7941"', "pkill claude", "pkill -f bun", "killall tmux", "killall -9 bun", "pkill -u $USER"]) {
      const { category, reason } = held(command);
      expect({ command, category }).toEqual({ command, category: "destructive" });
      expect(reason).toMatch(/other sessions|every worker's session/);
    }
  });

  test("pkill limited to the shell's own children is allowed", () => {
    allowed("pkill -P $$");
  });

  test("systemctl --user stop or kill of a unit not made in the same command is held", () => {
    for (const command of ['systemctl --user stop "memload-x-1.scope"', "systemctl --user stop app.scope", "systemctl --user kill app.service", 'UNIT=x; systemctl --user stop "$UNIT.scope"']) {
      const { category } = held(command);
      expect({ command, category }).toEqual({ command, category: "destructive" });
    }
  });

  test("kill of a pid found by name, or of every process, is held; one the command holds is its own", () => {
    allowed('kill -TERM "$PID"');
    held("kill $(pgrep -f node)");
    held("kill -9 -1");
  });
});

describe("the same commands inside a script the floor reads", () => {
  test("running the load-test script is held, and the reason names its tmux kill-server first", () => {
    for (const command of ["bash /tmp/memload/run.sh before > /tmp/memload/before.out 2>&1", "bash /tmp/memload/run.sh before", "sh /tmp/memload/run.sh x", "source /tmp/memload/run.sh x"]) {
      const { category, reason } = held(command);
      expect({ command, category }).toEqual({ command, category: "destructive" });
      expect({ command, first: reason.startsWith("Ends sessions outside this worker: `tmux kill-server`") }).toEqual({ command, first: true });
    }
  });

  test("a session-wide kill is named in the reason even when a graver finding leads", () => {
    const script = ["#!/bin/sh", "git push origin HEAD", "rm -rf /home/other", "pkill -f x", "systemctl --user stop a.scope", "kill -9 -1", "tmux kill-server"].join("\n");
    const { category, reason } = held("bash /tmp/memload/push.sh", { "/tmp/memload/push.sh": script });
    expect(category).toBe("outward");
    expect(reason).toContain("tmux kill-server");
  });

  test("each dangerous teardown form is held from a script on its own", () => {
    for (const line of ['TMUX_TMPDIR="/tmp/x" tmux kill-server', "tmux kill-session -t other", 'pkill -f "load.ts --port 7941"', 'systemctl --user stop "x.scope"']) {
      const { category } = held("bash /tmp/memload/one.sh", { "/tmp/memload/one.sh": `#!/bin/sh\n${line}\n` });
      expect({ line, category }).toEqual({ line, category: "destructive" });
    }
  });

  test("a script that tears down only its own private tmux server is allowed", () => {
    const script = ["#!/bin/sh", "tmux -L memload new-session -d -s s1 'sleep 60'", "tmux -L memload kill-server", "env -u TMUX tmux -S /tmp/memload/sock kill-server"].join("\n");
    allowed("bash /tmp/memload/ok.sh", { "/tmp/memload/ok.sh": script });
  });

  test("a test file that kills the shared tmux server is held; one on a private socket is not", () => {
    const fleet = 'import { test } from "bun:test";\ntest("x", () => { Bun.spawnSync(["tmux", "kill-server"]); });\n';
    const own = 'import { test } from "bun:test";\ntest("x", () => { Bun.spawnSync(["tmux", "-L", "t1", "kill-server"]); });\n';
    const { category, reason } = held("bun test", { [join(ROOT, "src", "fleet.test.ts")]: fleet });
    expect(category).toBe("destructive");
    expect(reason).toContain("tmux kill-server");
    allowed("bun test", { [join(ROOT, "src", "own.test.ts")]: own });
  });
});

/** Each row: a command and the verdict it must get, with the text its reason must carry when held. */
type Row = [command: string, expect: "allow" | { reach: string }];

function check(rows: readonly Row[], files?: Record<string, string>): void {
  for (const [command, want] of rows) {
    const v = bash(command, files);
    if (want === "allow") expect({ command, verdict: v }).toEqual({ command, verdict: { action: "allow" } });
    else {
      expect({ command, action: v.action }).toEqual({ command, action: "hold" });
      if (v.action === "hold") expect({ command, names: v.reason.includes(want.reach) }).toEqual({ command, names: true });
    }
  }
}

describe("adversarial review, round 1: the shared server allows only read-only and pane-creating tmux commands", () => {
  test("a word ending in `;` and a nested command string chain commands", () => {
    check([
      ["tmux ls\\; kill-server", { reach: "kill-server" }],
      ["tmux 'kill-server;' ls", { reach: "kill-server" }],
      ["tmux 'ls;' kill-server", { reach: "kill-server" }],
      ["tmux new -d -s x\\; kill-server", { reach: "kill-server" }],
      ["tmux ls\\; kill-ses -t other", { reach: "kill-ses" }],
      ["tmux ls \\; ls", "allow"],
      ["tmux ls \\; set -g mouse on", { reach: "chains" }],
      ["tmux if-shell true 'ls; kill-server'", { reach: "if-shell" }],
      ["tmux -L private if-shell true 'ls;kill-server'", "allow"],
      ["tmux -L private if-shell true 'ls; display hi'", "allow"],
    ]);
  });

  test("commands that run tmux or shell commands later, or reprogram the server, are held", () => {
    check([
      ["tmux run-shell -C kill-server", { reach: "run-shell" }],
      ["tmux run -C 'kill-server'", { reach: "run" }],
      ["tmux set-hook -g after-has-session kill-server", { reach: "set-hook" }],
      ["tmux set -s command-alias[100] has-session=kill-server", { reach: "`tmux set`" }],
      ["tmux set -as command-alias ls=kill-server", { reach: "`tmux set`" }],
      ["tmux set -s exit-unattached on", { reach: "`tmux set`" }],
      ["tmux set-option -s exit-unattached on", { reach: "set-option" }],
      ["tmux set -g destroy-unattached on", { reach: "`tmux set`" }],
      ["tmux set -g lock-command 'pkill claude'", { reach: "`tmux set`" }],
      ["tmux bind -n a kill-server", { reach: "bind" }],
      ["tmux confirm-before -y kill-server", { reach: "confirm-before" }],
      ["tmux command-prompt -I kill-server", { reach: "command-prompt" }],
      ["tmux display-menu -T x kill-server k kill-server", { reach: "display-menu" }],
      ["tmux source-file /tmp/x.conf", { reach: "source-file" }],
      ["tmux respawn-pane -k -t other:0.0", { reach: "respawn-pane" }],
      ["tmux new-window -k -t other:0", { reach: "new-window" }],
      ["tmux move-window -k -s mine:1 -t other:0", { reach: "move-window" }],
      ["tmux link-window -k -s mine:1 -t other:0", { reach: "link-window" }],
      ["tmux detach-client -a -P", { reach: "detach-client" }],
      ["tmux kill-session -a", { reach: "kill-session" }],
      ["tmux kill-pane -a", { reach: "kill-pane" }],
      ["tmux lock-server", { reach: "lock-server" }],
      ["tmux kill-sess -t other", { reach: "kill-sess" }],
      ["tmux zz", { reach: "`tmux zz`" }],
    ]);
  });

  test("a `#(…)` format runs its shell command, read like any other", () => {
    check([
      ["tmux display -p '#(tmux kill-server)'", { reach: "kill-server" }],
      ["tmux display -p '#(git push origin HEAD)'", { reach: "git push" }],
      ["tmux display -p '#{session_name}'", "allow"],
    ]);
  });

  test("control mode reads commands from its input", () => {
    check([
      ["echo kill-server | tmux -C attach", { reach: "tmux -C" }],
      ["tmux -CC attach < /tmp/cmds", { reach: "tmux -C" }],
      ["tmux -uC new-session", { reach: "tmux -C" }],
      ["tmux -L private -C attach < /tmp/cmds", "allow"],
    ]);
  });

  test("a -L label that is a path, empty, `default`, or a link to the shared socket is not private", () => {
    check([
      ["tmux -L ./default kill-server", { reach: "kill-server" }],
      ["tmux -L /default kill-server", { reach: "kill-server" }],
      ["tmux -L ../tmux-1000/default kill-server", { reach: "kill-server" }],
      ["tmux -L ./default kill-session -t other", { reach: "kill-session" }],
      ["tmux -L evil kill-server", { reach: "kill-server" }],
      ["tmux -L default kill-server", { reach: "names" }],
      ["tmux -S /tmp/tmux-1000/default kill-server", { reach: "names" }],
      ["tmux -S /tmp/tmux-1000/evil kill-server", { reach: "names" }],
      ["tmux -S /tmp/memload/default kill-server", "allow"],
      ["tmux -L mem.load-1 kill-server", "allow"],
    ]);
  });

  test("env -u TMUX makes TMUX_TMPDIR choose the server, and only a temp dir is private", () => {
    check(
      [
        ["env -u TMUX TMUX_TMPDIR=/tmp/memload/tmux tmux kill-server", "allow"],
        ["TMUX= TMUX_TMPDIR=/tmp/memload/tmux tmux kill-server", "allow"],
        ["env -u TMUX tmux kill-server", { reach: "kill-server" }],
        ["env -u TMUX TMUX_TMPDIR=/home/me tmux kill-server", { reach: "kill-server" }],
        ["TMUX_TMPDIR=/tmp/memload/tmux tmux kill-server", { reach: "TMUX_TMPDIR alone" }],
      ],
      { "/tmp/memload/tmux/.keep": "" }
    );
  });

  test("the shared socket can't be linked to, moved or deleted", () => {
    check([
      ["ln /tmp/tmux-1000/default /tmp/zz", { reach: "socket" }],
      ["ln -s /tmp/tmux-1000/default /tmp/tmux-1000/evil2 && tmux -L evil2 kill-server", { reach: "socket" }],
      ["rm /tmp/tmux-1000/default", { reach: "socket" }],
      ["rm -rf /tmp/tmux-1000", { reach: "socket" }],
      ["mv /tmp/tmux-1000/default /tmp/x", { reach: "socket" }],
      ["rm -rf /tmp/*", { reach: "socket" }],
      ["rm -rf /tmp/memload/tmux", "allow"],
    ]);
  });

  test("read-only and pane-creating commands on the shared server stay allowed", () => {
    check([
      ["tmux ls", "allow"],
      ["tmux list-panes -a -F '#{pane_id}'", "allow"],
      ["tmux has-session -t s1", "allow"],
      ["tmux display -p '#{pane_id}'", "allow"],
      ["tmux capture-pane -p -t s1", "allow"],
      ["tmux new-session -d -s s1 'sleep 60'", "allow"],
      ["tmux split-window -d -t s1 'sleep 60'", "allow"],
      ["tmux -V", "allow"],
      ["tmux -L private send-keys -t s1 'echo hi' Enter", "allow"],
    ]);
  });
});

describe("adversarial review, round 1: session-ending steps outside tmux, and how the reason names them", () => {
  test("machine, login-session and user-manager stops are held with every worker named", () => {
    check([
      ["shutdown -h now", { reach: "every worker" }],
      ["systemctl poweroff", { reach: "every worker" }],
      ["systemctl --user exit", { reach: "every worker" }],
      ["loginctl terminate-user me", { reach: "every worker" }],
      ["loginctl kill-user me", { reach: "every worker" }],
      ["loginctl terminate-session self", { reach: "every worker" }],
      ["loginctl list-sessions", "allow"],
      ["killall5 -9", { reach: "every worker" }],
      ["pkill -u me", { reach: "every worker" }],
    ]);
  });

  test("kills by lookup are held as reaching other sessions; the shell's own children are not", () => {
    check([
      ["kill $(pgrep -f claude)", { reach: "another session" }],
      ["pgrep -f claude | xargs kill -9", { reach: "session" }],
      ["kill -9 $(pidof tmux)", { reach: "another session" }],
      ["pkill --parent $$", "allow"],
      ["pkill -P $$", "allow"],
    ]);
  });

  test("systemctl --user kill of Standup's own service is standup-ops", () => {
    const v = bash("systemctl --user kill standup");
    expect(v.action === "hold" ? v.category : null).toBe("standup-ops");
  });

  test("a long top reason, and many findings, don't push a session-ending step out of the reason", () => {
    const host = `host-${"b".repeat(600)}`;
    const long = bash(`ssh ${host} true; tmux kill-server`);
    expect(long.action === "hold" && long.reason.includes("`tmux kill-server` runs")).toBe(true);
    const many = [
      "#!/bin/sh", "git push origin HEAD", "aws s3 rm s3://b/k", "rm -rf /home/other", "kill $(pgrep -f claude)", "shutdown -h now",
      "pkill -f x", "fuser -k 80/tcp", "systemctl --user stop a.scope", "kill -9 -1", "tmux kill-session -t o", "tmux respawn-pane -k -t o",
      "tmux source-file /tmp/x", "loginctl terminate-user me", "tmux kill-server",
    ].join("\n");
    const v = bash("bash /tmp/memload/many.sh", { "/tmp/memload/many.sh": many });
    expect(v.action).toBe("hold");
    if (v.action === "hold") {
      for (const named of ["`tmux kill-server`", "shutdown", "loginctl", "`kill` signals", "pkill", "fuser", "systemctl stop", "kill-session", "respawn-pane", "source-file", "pgrep"]) {
        expect({ named, in: v.reason.includes(named) }).toEqual({ named, in: true });
      }
    }
  });

  test("a test file that names kill-server through a computed program name is held; one with its own socket is not", () => {
    const computed = 'import { test } from "bun:test";\nconst T = "tmux";\ntest("x", () => { Bun.spawnSync([T, "kill-server"]); });\n';
    const own = 'import { test } from "bun:test";\nconst T = "tmux";\ntest("x", () => { Bun.spawnSync([T, "-L", "t1", "kill-server"]); });\n';
    check([["bun test", { reach: "kill-server" }]], { [join(ROOT, "src", "computed.test.ts")]: computed });
    check([["bun test", "allow"]], { [join(ROOT, "src", "own.test.ts")]: own });
  });

  test("in a test file, shell wrappers and session-wide tmux forms are held; a socket the test computes is its own", () => {
    const wrap = (argv: string) => `import { test } from "bun:test";\ntest("x", () => { Bun.spawnSync(${argv}); });\n`;
    const rows: Array<[string, "allow" | { reach: string }]> = [
      ['["sh", "-c", "tmux kill-server"]', { reach: "kill-server" }],
      ['["bash", "-lc", "tmux kill-server"]', { reach: "kill-server" }],
      ['["timeout", "5", "tmux", "kill-server"]', { reach: "kill-server" }],
      ['["tmux", "kill-session", "-a"]', { reach: "kill-session" }],
      ['["tmux", "set", "-s", "exit-unattached", "on"]', { reach: "set" }],
      ['["tmux", "kill-session", "-t", "mine"]', "allow"],
      ['["tmux", "-L", name, "kill-server"]', "allow"],
    ];
    for (const [argv, want] of rows) {
      const v = bash("bun test", { [join(ROOT, "src", "w.test.ts")]: wrap(argv) });
      const got = v.action === "allow" ? "allow" : want !== "allow" && v.reason.includes(want.reach) ? want : v.reason;
      expect({ argv, got }).toEqual({ argv, got: want });
    }
  });
});

/** Each row: a file's code, the command that runs it, and the verdict it must get. */
type FileRow = [code: string, command: string, expect: "allow" | { reach: string }];

function checkFiles(rows: readonly FileRow[], path: string): void {
  for (const [code, command, want] of rows) {
    const v = bash(command, { [path]: code });
    const got = v.action === "allow" ? "allow" : want !== "allow" && v.reason.includes(want.reach) ? want : v.reason;
    expect({ code, got }).toEqual({ code, got: want });
  }
}

describe("adversarial review, round 2", () => {
  test("boolean flags of new-window and new-session don't swallow the shell command", () => {
    check([
      ["tmux new-window -S 'tmux kill-server'", { reach: "kill-server" }],
      ["tmux neww -d -S 'git push origin HEAD'", { reach: "git push" }],
      ["tmux new-session -d -X 'tmux kill-server'", { reach: "kill-server" }],
      ["tmux new-session -d -s s1 -x 80 -y 24 'sleep 1'", "allow"],
    ]);
  });

  test("new-session -A with -D or -X attaches, and is held on the shared server", () => {
    check([
      ["tmux new-session -A -D -X -s other", { reach: "new-session" }],
      ["tmux new -AD -s other", { reach: "`tmux new`" }],
      ["tmux new-session -A -s mine -d", "allow"],
    ]);
  });

  test("env -i, a set $TMUX, and a TMUX_TMPDIR that links to the shared socket decide the server", () => {
    check(
      [
        ["env -i TMUX_TMPDIR=/tmp/memload/tmux tmux kill-server", "allow"],
        ["TMUX=/tmp/memload/sock,1,0 tmux kill-server", { reach: "kill-server" }],
        ["TMUX=/tmp/tmux-1000/default,1,0 tmux kill-server", { reach: "kill-server" }],
        ["env -u TMUX TMUX_TMPDIR=/tmp/lnk tmux kill-server", { reach: "kill-server" }],
      ],
      { "/tmp/memload/tmux/.keep": "" }
    );
  });

  test("machine stops through init and systemd targets, and user-manager stops, are held as ending every worker", () => {
    check([
      ["sudo init 0", { reach: "every worker" }],
      ["sudo telinit 6", { reach: "every worker" }],
      ["init q", "allow"],
      ["systemctl --user start exit.target", { reach: "every worker" }],
      ["systemctl isolate rescue.target", { reach: "every worker" }],
      ["systemctl stop user@1000.service", { reach: "every worker" }],
      ["systemctl --user disable --now a.service", { reach: "another session" }],
      ["systemctl --user status a.service", "allow"],
      ["systemctl --user list-units", "allow"],
    ]);
  });

  test("fuser --kill, pkill by a user with the value attached, and the shell's own children", () => {
    check([
      ["fuser --kill 80/tcp", { reach: "fuser" }],
      ["fuser -n tcp --kill 80", { reach: "fuser" }],
      ["pkill -U1000", { reach: "every worker" }],
      ["pkill -ume", { reach: "every worker" }],
      ["pkill -HUP nginx", { reach: "other sessions" }],
      ["pkill --parent=$$", "allow"],
      ["pkill -P$$", "allow"],
    ]);
  });

  test("a glob delete in /tmp names the shared socket only when it can match it; a private socket isn't the shared one", () => {
    const why = (command: string) => {
      const v = bash(command);
      return v.action === "hold" ? v.reason.includes("tmux server's socket") : false;
    };
    expect(why("rm -rf /tmp/*")).toBe(true);
    expect(why("rm -rf /tmp/tmux-*")).toBe(true);
    expect(why("rm -f /tmp/memload-*.log")).toBe(false);
    expect(why("rm -rf /tmp/standup-test-*")).toBe(false);
    check([["rm -f /tmp/tmux-1000/mysock", "allow"]]);
  });

  test("every step that ends other sessions is named in the first 500 characters", () => {
    const host = `host-${"b".repeat(600)}`;
    for (const command of [`ssh ${host} true; tmux kill-server; shutdown -h now`, `ssh ${host} true; tmux -L default kill-server; loginctl kill-user me`, "pkill -f x; fuser -k 80/tcp; tmux kill-server; kill -9 -1"]) {
      const v = bash(command);
      expect(v.action).toBe("hold");
      const head = v.action === "hold" ? v.reason.slice(0, 500) : "";
      for (const named of ["tmux kill-server", "shutdown", "loginctl", "pkill", "fuser", "kill"].filter((n) => command.includes(n.split(" ").pop()!))) {
        expect({ command: command.slice(-60), named, in: head.includes(named) }).toEqual({ command: command.slice(-60), named, in: true });
      }
    }
  });

  test("code: computed and wrapped tmux programs, computed sockets, and signals to every process", () => {
    const script = join("/tmp", "memload", "s.ts");
    checkFiles(
      [
        ['const sock = "/tmp/tmux-1000/default";\nBun.spawnSync(["tmux", "-S", sock, "kill-server"]);\n', "bun /tmp/memload/s.ts", { reach: "kill-server" }],
        ['const n = "default";\nBun.spawnSync(["tmux", "-L", n, "kill-server"]);\n', "bun /tmp/memload/s.ts", { reach: "kill-server" }],
        ['Bun.spawnSync(["tmux", "ls;", "kill-session", "-a"]);\n', "bun /tmp/memload/s.ts", { reach: "kill-session" }],
        ['const T = "tmux";\nBun.spawnSync(["ls", "-L", "/tmp"]);\nBun.spawnSync([T, "kill-server"]);\n', "bun /tmp/memload/s.ts", { reach: "kill-server" }],
        ['import { spawnSync } from "child_process";\nconst bin = process.argv[2];\nspawnSync(bin, ["kill-session", "-a"]);\n', "bun /tmp/memload/s.ts", { reach: "kill-session" }],
        ['process.kill(-1, "SIGKILL");\n', "bun /tmp/memload/s.ts", { reach: "every process" }],
        ['import { symlinkSync } from "fs";\nsymlinkSync("/tmp/tmux-1000/default", "/tmp/tmux-1000/zz");\n', "bun /tmp/memload/s.ts", { reach: "socket" }],
        ['Bun.spawnSync(["git", "commit", "-m", "docs: stop; rm -rf /"]);\n', "bun /tmp/memload/s.ts", "allow"],
        ['Bun.spawnSync(["grep", "-rn", "kill-server", "src"]);\n', "bun /tmp/memload/s.ts", "allow"],
        ['process.kill(child.pid, "SIGTERM");\n', "bun /tmp/memload/s.ts", "allow"],
      ],
      script,
    );
    checkFiles([["import os\nos.kill(-1, 9)\n", "python3 /tmp/memload/k.py", { reach: "every process" }]], join("/tmp", "memload", "k.py"));
  });

  test("code in a test file: session-wide kills are held, and a test that only mentions kill-server is not", () => {
    const path = join(ROOT, "src", "t.test.ts");
    const wrap = (body: string) => `import { test, expect } from "bun:test";\ntest("x", () => { ${body} });\n`;
    checkFiles(
      [
        [wrap('Bun.spawnSync(["kill", "-9", "-1"]);'), "bun test", { reach: "every process" }],
        [wrap('Bun.spawnSync(["loginctl", "terminate-user", "me"]);'), "bun test", { reach: "loginctl" }],
        [wrap('Bun.spawnSync(["pkill", "-f", "node x"]);'), "bun test", { reach: "pkill" }],
        [wrap('Bun.spawnSync(["rm", "-rf", "/tmp/tmux-1000"]);'), "bun test", { reach: "socket" }],
        [wrap('Bun.spawnSync(["tmux", "ls;", "kill-session", "-a"]);'), "bun test", { reach: "kill-session" }],
        [wrap('const out = Bun.spawnSync(["echo", "x"]); expect(String(out.stdout)).not.toContain("kill-server");'), "bun test", "allow"],
      ],
      path,
    );
  });
});

describe("adversarial review, round 3", () => {
  const script = join("/tmp", "memload", "s.ts");
  const run = "bun /tmp/memload/s.ts";
  const testFile = join(ROOT, "src", "t.test.ts");
  const inTest = (body: string) => `import { test, expect } from "bun:test";\ntest("x", () => { ${body} });\n`;

  test("an argv followed by a callback, `as`, or a call is still read word by word", () => {
    checkFiles(
      [
        [inTest('execFile("sh", ["-c", "tmux kill-server"], (e) => {});'), "bun test", { reach: "kill-server" }],
        [inTest('execFile("sh", ["-c", "tmux kill-server"], opts as any);'), "bun test", { reach: "kill-server" }],
        [inTest('execFile("bash", ["-lc", "tmux kill-server"], makeOpts());'), "bun test", { reach: "kill-server" }],
      ],
      testFile,
    );
  });

  test("a constant a binding may shadow, and a template with an interpolation, don't prove the program or the socket", () => {
    checkFiles(
      [
        ['const T = "echo";\nconst go = (T: string) => Bun.spawnSync([T, "kill-server"]);\ngo("tmux");\n', run, { reach: "kill-server" }],
        ['function f() { const T = "tmux"; Bun.spawnSync([T, "kill-server"]); }\nconst T = "echo";\n', run, { reach: "kill-server" }],
        ["Bun.spawnSync([`${bin}`, \"kill-server\"]);\n", run, { reach: "kill-server" }],
        ['Bun.spawnSync([bin, "-L", "default", "kill-server"]);\n', run, { reach: "kill-server" }],
        ['const n = "mine";\nfunction g(n) { Bun.spawnSync(["tmux", "-L", n, "kill-server"]); }\ng("default");\n', run, { reach: "kill-server" }],
        ['Bun.spawnSync([bin, "-L", "mine", "kill-server"]);\n', run, "allow"],
      ],
      script,
    );
  });

  test("a literal is dropped only at the argv position it fills, not wherever its text recurs", () => {
    checkFiles(
      [
        ['import { spawnSync, execSync } from "child_process";\nspawnSync("echo", ["tmux kill-server"]);\nexecSync("tmux kill-server");\n', run, { reach: "kill-server" }],
        ['import { spawnSync, execSync } from "child_process";\nspawnSync("logger", ["git push origin HEAD"]);\nexecSync("git push origin HEAD");\n', run, { reach: "git push" }],
      ],
      script,
    );
  });

  test("a shell variable named TMUX is not tmux's environment", () => {
    check([
      ["unset TMUX; TMUX=/tmp/memload/sock,1,0; tmux kill-server", { reach: "kill-server" }],
      ["env -i bash -c 'TMUX=/tmp/memload/sock,1,0; tmux kill-server'", { reach: "kill-server" }],
      ["env TMUX=/tmp/memload/sock,1,0 tmux kill-server", { reach: "kill-server" }],
      ["TMUX=/tmp/memload/s,1,0 sudo -u me tmux kill-server", { reach: "kill-server" }],
    ]);
  });

  test("round 4: a TMUX_TMPDIR that is only a shell variable doesn't choose the server", () => {
    check([
      ["unset TMUX; TMUX_TMPDIR=/tmp/memload; tmux kill-server", { reach: "kill-server" }],
      ["TMUX_TMPDIR=/tmp/memload; env -u TMUX tmux kill-server", { reach: "kill-server" }],
      ["env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server", "allow"],
    ]);
  });

  test("round 4: a computed value after a long option still reads as that option's value", () => {
    checkFiles([['Bun.spawnSync(["git", "--git-dir", dir, "push"]);\n', run, { reach: "git push" }]], script);
  });

  test("round 4: files a test checks out from local history leave the later step that runs them unread, which is allowed", () => {
    const body = 'import { execSync } from "child_process";\nexecSync("git -C /tmp/memload checkout other");';
    checkFiles([[inTest(body), "bun test && bun /tmp/memload/gen.ts", "allow"]], testFile);
    checkFiles([[inTest(body), "bun test && bun /tmp/memload/gen.ts && git push origin main", { reach: "git push" }]], testFile);
  });

  test("log lines that name a session-ending program aren't commands; the programs are, when a call runs them", () => {
    checkFiles(
      [
        ['Bun.spawnSync(["git", "status"]);\nconsole.log("shutdown complete");\n', run, "allow"],
        ['Bun.spawnSync(["git", "status"]);\nthrow new Error("skill not found");\n', run, "allow"],
        ['console.log("poweroff the vm when done");\n', run, "allow"],
        ['Bun.spawnSync(["sudo", "init", "0"]);\n', run, { reach: "every worker" }],
        ['Bun.spawnSync(["sh", "-c", "init 0"]);\n', run, { reach: "every worker" }],
        ['import { execSync } from "child_process";\nexecSync("halt -p");\n', run, { reach: "every worker" }],
      ],
      script,
    );
    checkFiles([['import os\nos.system("init 0")\n', "python3 /tmp/memload/k.py", { reach: "every worker" }]], join("/tmp", "memload", "k.py"));
    checkFiles([[inTest('Bun.spawnSync(["sudo", "init", "0"]);'), "bun test", { reach: "every worker" }]], testFile);
  });

  test("code that deletes or overwrites the shared socket, by any common call, is held; a liveness check is not", () => {
    checkFiles(
      [
        ['import { writeFileSync } from "fs";\nwriteFileSync("/tmp/tmux-1000/default", "");\n', run, { reach: "socket" }],
        ['Bun.file("/tmp/tmux-1000/default").delete();\n', run, { reach: "socket" }],
        ['import { unlinkSync } from "fs";\nunlinkSync(`/tmp/tmux-${process.getuid()}/default`);\n', run, { reach: "socket" }],
        ['const p = Bun.spawn(["sleep", "5"]);\np.kill(0);\n', run, "allow"],
        ['const SOCK = "/tmp/tmux-1000/default";\nimport { existsSync } from "fs";\nexistsSync(SOCK);\nrequire("os").cpus();\n', run, "allow"],
      ],
      script,
    );
    const py = join("/tmp", "memload", "k.py");
    checkFiles(
      [
        ["import os\nos.remove('/tmp/tmux-1000/default')\n", "python3 /tmp/memload/k.py", { reach: "socket" }],
        ["import shutil\nshutil.move('/tmp/tmux-1000', '/tmp/x')\n", "python3 /tmp/memload/k.py", { reach: "socket" }],
        ["open('/tmp/tmux-1000/default', 'w')\n", "python3 /tmp/memload/k.py", { reach: "socket" }],
        ["open('/tmp/tmux-1000/default')\n", "python3 /tmp/memload/k.py", "allow"],
      ],
      py,
    );
  });

  test("a socket dir named with a computed uid is the shared one, from the shell and from a test", () => {
    check([["rm -rf /tmp/tmux-$(id -u)", { reach: "socket" }], ["rm -rf /tmp/tmux-`id -u`; true", { reach: "socket" }]]);
    checkFiles([[inTest('import { execSync } from "child_process"; execSync("rm -rf /tmp/tmux-$(id -u)");'), "bun test", { reach: "socket" }]], testFile);
  });

  test("machine stops through more targets and units, kexec and D-Bus; init's own options", () => {
    check([
      ["systemctl start runlevel0.target", { reach: "every worker" }],
      ["systemctl start ctrl-alt-del.target", { reach: "every worker" }],
      ["systemctl stop user-1000.slice", { reach: "every worker" }],
      ["systemctl --user start systemd-exit.service", { reach: "every worker" }],
      ["sudo kexec -e", { reach: "every worker" }],
      ["busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager PowerOff b false", { reach: "every worker" }],
      ["telinit -t 5 0", { reach: "`telinit 0`" }],
      ["init -t 0 3", "allow"],
      ["busctl list", "allow"],
    ]);
  });

  test("a code-level step is named by its own label in the first 500 characters", () => {
    const long = join(ROOT, "scripts", "a-really-long-script-name-for-teardown-of-load.ts");
    const v = bash(`ssh host-${"b".repeat(600)} true; bun ${long}`, { [long]: 'process.kill(-1, "SIGKILL");\n' });
    expect(v.action === "hold" && v.reason.slice(0, 500).includes("kill(-1)")).toBe(true);
    const w = bash(run, { [script]: 'Bun.spawnSync(["timeout", "5", "tmux", "kill-server"]);\n' });
    expect(w.action === "hold" && (w.reason.match(/tmux kill-server`/g) ?? []).length).toBeGreaterThan(0);
    expect(w.action === "hold" && w.reason.startsWith("Ends sessions outside this worker: `tmux kill-server`, `tmux kill-server`")).toBe(false);
  });

  test("in a test file, a wrapped or computed tmux kill of the test's own session by name is the test's", () => {
    checkFiles(
      [
        [inTest('Bun.spawnSync(["timeout", "5", "tmux", "kill-session", "-t", "mine"]);'), "bun test", "allow"],
        [inTest('const T = process.env.TMUX_BIN!; Bun.spawnSync([T, "kill-session", "-t", "mine"]);'), "bun test", "allow"],
      ],
      testFile,
    );
  });
});

describe("the workers' own tmux server, and a TMUX_TMPDIR tmux skips", () => {
  const WORKERS = "hosts every Standup worker's pane";
  const testFile = join(ROOT, "src", "w.test.ts");
  const inTest = (body: string) => `import { test } from "bun:test";\ntest("x", () => { ${body} });\n`;

  const SOCK = join(DATA, "tmux", "workers");

  test("any tmux command naming the workers' socket in Standup's data, by -S or $TMUX, is held, read-only or not", () => {
    check([
      [`tmux -S ${SOCK} kill-server`, { reach: WORKERS }],
      [`tmux -S ${SOCK} ls`, { reach: WORKERS }],
      [`tmux -S${SOCK} kill-session -t standup-x`, { reach: WORKERS }],
      [`S=${SOCK}; tmux -S "$S" kill-server`, { reach: WORKERS }],
      [`tmux -S ~/.local/share/standup/tmux/workers kill-server`, { reach: WORKERS }],
      [`TMUX=${SOCK},1,0 tmux kill-server`, { reach: WORKERS }],
      // A label resolves under /tmp or TMUX_TMPDIR, never in Standup's data.
      ["tmux -L standup-workers kill-server", "allow"],
      ["tmux -L mine kill-server", "allow"],
    ]);
  });

  test("links to, moves of and code naming the workers' socket hit the hold on Standup's data", () => {
    check([
      [`ln -s ${SOCK} /tmp/memload/s`, { reach: "Standup's own data" }],
      [`ln ${SOCK} /tmp/memload/s`, { reach: "Standup's own data" }],
      [`S=${SOCK}; ln -s "$S" /tmp/memload/s`, { reach: "Standup's own data" }],
      [`mv ${SOCK} /tmp/memload/s`, { reach: "Standup's own data" }],
      [`rm -rf ${join(DATA, "tmux")}`, { reach: "Standup's own data" }],
      [`python3 -c 'import os; os.symlink("${SOCK}", "/tmp/memload/s")'`, { reach: "data dir" }],
    ]);
  });

  test("a test that names the workers' socket is held; its own -L or -S socket is not", () => {
    checkFiles(
      [
        [inTest('Bun.spawnSync(["tmux", "-S", "' + SOCK + '", "kill-server"]);'), "bun test", { reach: "kill-server" }],
        [inTest('Bun.spawnSync(["tmux", "-L", "t1", "kill-server"]);'), "bun test", "allow"],
      ],
      testFile,
    );
  });

  test("a test that kills tmux through a -S socket it computes is held; a computed -L label or a read-only call is not", () => {
    checkFiles(
      [
        [inTest('const s = "/tmp/tmux-" + process.getuid() + "/default"; Bun.spawnSync(["tmux", "-S", s, "kill-server"]);'), "bun test", { reach: "kill-server" }],
        [inTest('Bun.spawnSync(["tmux", "-S", sockFor("w1"), "kill-server"]);'), "bun test", { reach: "kill-server" }],
        [inTest('const s = sockFor("w1"); Bun.spawnSync(["tmux", "-S", s, "kill-session", "-t", "w1"]);'), "bun test", { reach: "kill-session" }],
        [inTest('Bun.spawnSync(["tmux", "-S", sockFor("w1"), "has-session", "-t", "w1"]);'), "bun test", "allow"],
        [inTest('Bun.spawnSync(["tmux", "-L", labelFor("w1"), "kill-server"]);'), "bun test", "allow"],
      ],
      testFile,
    );
  });

  test("the opt-in real-tmux test is held when run on purpose, and a full suite run doesn't read it", () => {
    const code = readFileSync(join(import.meta.dir, "..", "worker-tmux-isolation.tmux-test.ts"), "utf8");
    const path = join(ROOT, "src", "worker-tmux-isolation.tmux-test.ts");
    const v = bash("env -u TMUX -u TMUX_PANE bun test ./src/worker-tmux-isolation.tmux-test.ts", { [path]: code });
    expect(v.action === "hold" && v.reason.includes("kill-server")).toBe(true);
    allowed("bun test", { [path]: code });
  });

  test("the memload script with its teardown in an EXIT trap and a later rm of $R is held", () => {
    const script = ["#!/bin/sh", "R=/tmp/memload", 'teardown() { env -u TMUX TMUX_TMPDIR="$R/tmux" tmux kill-server; }', "trap teardown EXIT", 'rm -rf "$R"'].join("\n");
    const { reason } = held("bash /tmp/memload/trap.sh", { "/tmp/memload/trap.sh": script, "/tmp/memload/tmux/.keep": "" });
    expect(reason).toContain("kill-server");
  });

  test("a TMUX_TMPDIR that isn't a directory, or that the command deletes first, is the default server in /tmp", () => {
    check([
      ["env -u TMUX TMUX_TMPDIR=/tmp/memload/missing tmux kill-server", { reach: "isn't a directory" }],
      ["env -i TMUX_TMPDIR=/tmp/nope tmux kill-session -t x", { reach: "isn't a directory" }],
      ["TMUX= TMUX_TMPDIR=/tmp/memload/run.sh tmux kill-server", { reach: "isn't a directory" }],
      ["rm -rf /tmp/memload; env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server", { reach: "may delete" }],
      ["rm -rf /tmp/mem*; env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server", { reach: "may delete" }],
      ["rm -rf /tmp/other; env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server", "allow"],
      [`trap 'env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server' EXIT; rm -rf /tmp/memload`, { reach: "trap fires" }],
      [`teardown() { env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server; }; trap teardown EXIT; true`, { reach: "trap fires" }],
      ["env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server & rm -rf /tmp/memload", { reach: "alongside" }],
      ["env -u TMUX TMUX_TMPDIR=/tmp/memload tmux kill-server", "allow"],
      ["env -u TMUX TMUX_TMPDIR=/tmp/memload/missing tmux ls", "allow"],
    ]);
  });
});
