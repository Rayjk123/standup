import { describe, expect, test } from "bun:test";
import { dirname, join } from "path";
import { classifyToolCall, type FloorProbes } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A variable a command assigns a literal and then uses: as an operand, a
 * script path, a redirect target, the program word. The value counts only
 * when it is certain at the use, and an unquoted value splits as the shell
 * would. The machine is virtual.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const REPORT = join(HOME, ".claude", "skills", "tools", "scripts", "report.py");
const PUSH = join(HOME, "tools", "push.sh");

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
  [join(ROOT, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
  [join(ROOT, "package.json")]: JSON.stringify({ name: "standup", scripts: { test: "bun test" } }),
  [join(ROOT, "src", "app.test.ts")]: 'import { test, expect } from "bun:test";\ntest("adds", () => expect(1 + 1).toBe(2));\n',
  [join(ROOT, "shot.png")]: "PNG",
  [join(ROOT, "f")]: "/fake/home/.local/share/standup\n",
  [REPORT]: "#!/usr/bin/env python3\nimport sys\nprint('summary of', ', '.join(sys.argv[1:]))\n",
  [PUSH]: "#!/bin/sh\ngit push origin HEAD\n",
  [join(DATA, "standup.db")]: "",
};

function probes(): Partial<FloorProbes> {
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(FILES)) for (let d = dirname(f); d !== "/"; d = dirname(d)) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    gitCommonDir: (dir) => (dir === ROOT ? "/fake/repo/.git" : null),
    readFile: (p) => (p in FILES ? { ok: true, text: FILES[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in FILES || dirs.has(p),
    isDirectory: (p) => dirs.has(p),
    listDir: (p) => (dirs.has(p) ? [...new Set([...Object.keys(FILES), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null),
    realpath: (p) => (p in FILES || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => ({ aliases: new Map(), functions: new Map() }),
    awsAccount: () => null,
    now: () => Date.now(),
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

describe("a variable assigned a literal earlier in the command is its value", () => {
  const allowed = [
    "D=/tmp/x; mkdir $D",
    "D=/tmp/x && mkdir -p $D",
    'D="/tmp/x y"; mkdir "$D"',
    "OUT=/tmp/r.log; bun test > $OUT",
    "OUT=/tmp/r.log; bun test > $OUT 2>&1; tail -5 $OUT",
    "D=/tmp/x\nmkdir -p $D\nbun test > $D/out.log 2>&1",
    "export D=/tmp/x; mkdir $D/a ${D}/b",
    "A=/tmp B=x; mkdir $A/$B",
    "D=/tmp/x; test -d $D || mkdir $D",
    "D=/tmp/x; mkdir $D; ls $D; rm -rf $D",
    // A value with spaces, unquoted, is two operands, both under the temp dir.
    'D="/tmp/x /tmp/y"; mkdir $D',
    "M=mkdir; $M /tmp/x",
  ];
  test.each(allowed)("allows %p", (command) => {
    expectAllowed(bash(command));
  });

  test.each(allowed)("allows %p from the temp dir too", (command) => {
    expectAllowed(bash(command, "/tmp"));
  });

  test("a script named through a variable is the script it names", () => {
    expectHeld(bash(`S=${PUSH}; sh $S`), "outward");
    expectHeld(bash(`S=${PUSH}; sh "$S"`), "outward");
    expectHeld(bash("S=~/tools/push.sh && sh $S"), "outward");
    expectAllowed(bash(`S=${REPORT}; python3 -I $S shot.png`));
    expectAllowed(bash("S=~/.claude/skills/tools/scripts/report.py && python3 -I $S shot.png"));
    // The script is read as code, as when it is named directly.
    expect(bash(`S=${REPORT}; python3 -I $S`)).toEqual(bash(`python3 -I ${REPORT}`));
  });
});

describe("a value that isn't certain, or splits into more, still holds", () => {
  test("the value names a protected place", () => {
    expectHeld(bash("D=~/.local/share/standup; rm -rf $D"), "floor-tamper");
    expectHeld(bash(`D=${DATA}/standup.db; rm -f "$D"`), "floor-tamper");
    expectHeld(bash("R=origin; git push $R HEAD"), "outward");
    expectHeld(bash("P=git; $P push origin HEAD"), "outward");
  });

  test("an unquoted value with spaces splits into each operand", () => {
    expectHeld(bash(`D="/tmp/x ${DATA}"; rm -rf $D`), "floor-tamper");
    expectHeld(bash('P="git push"; $P origin HEAD'), "outward");
    // Quoted, it is one path under the temp dir.
    expectAllowed(bash(`D="/tmp/x ${DATA}"; rm -rf "$D"`));
  });

  test("an unquoted value with glob characters is a pattern", () => {
    expect(bash(`D=${HOME}/.local/share/standu?; rm -rf $D`).action).toBe("hold");
    expect(bash(`D='${HOME}/.local/share/*'; rm -rf $D`).action).toBe("hold");
    expect(bash("D='/[a-z]*'; rm -rf $D", "/tmp").action).toBe("hold");
    expect(bash("D='*'; rm -rf $D", HOME).action).toBe("hold");
  });

  test("a value the floor can't read stays unknown", () => {
    // A dir made at a path the floor can't place is a write, not a delete: it runs unless the call names a held target.
    expect(bash("X=$(curl -s https://example.com/dir); mkdir $X").action).toBe("allow");
    expect(bash("X=$(date +%s); rm -rf $X").action).toBe("hold");
  });

  test("a value assigned on only some paths stays unknown", () => {
    expect(bash("true || D=/tmp/x; rm -rf $D").action).toBe("hold");
    expect(bash("cd /tmp && D=x; mkdir $D").action).toBe("allow");
    expect(bash("cd /tmp || D=x; rm -rf $D").action).toBe("hold");
    expect(bash("[ -n \"$Z\" ] || D=/tmp/x; rm -rf $D").action).toBe("hold");
    expect(bash("{ [ -n \"$Z\" ] && D=/tmp/x; }; rm -rf $D").action).toBe("hold");
    // A top-level `P && D=x` is read both ways: from where D=x ran, and from where D stayed unset (`rm -rf` of nothing).
    expect(bash("cd /tmp && D=x; rm -rf $D").action).toBe("allow");
    expect(bash("[ -n \"$Z\" ] && D=/tmp/x; rm -rf $D").action).toBe("allow");
    expect(bash("[ -n \"$Z\" ] && D=/; rm -rf $D").action).toBe("hold");
    expect(bash("for i in 1; do D=/tmp/x; done; rm -rf $D").action).not.toBe("allow");
    expect(bash("D=/tmp/x; echo hi | D=/ cat; rm -rf $D").action).toBe("allow");
  });

  test("a later assignment the floor follows replaces the value", () => {
    expectHeld(bash("D=/tmp/x; f() { D=/; }; f; rm -rf $D"), "floor-tamper");
    expectHeld(bash(`D=/tmp/x; D=${DATA}; rm -rf $D`), "floor-tamper");
    expect(bash("D=/tmp/x; read D; rm -rf $D").action).toBe("hold");
    expect(bash("D=/tmp/x; eval \"$CMD\"; rm -rf $D").action).toBe("hold");
  });

  test("a custom IFS splits on characters the floor doesn't model", () => {
    expect(bash("IFS=:; D=/tmp/x:/; rm -rf $D").action).toBe("hold");
  });

  test("a prefix assignment isn't seen by the command's own words", () => {
    expect(bash("D=/tmp/x rm -rf $D").action).toBe("hold");
  });
});
