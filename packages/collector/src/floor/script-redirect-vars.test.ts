import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * A redirect inside a script the command runs, whose target is a variable the
 * script assigns itself. The machine is virtual, and its paths are built piece
 * by piece so this file carries no literal Standup path of its own.
 */

const HOME = join("/", "fake", "home");
const DATA = join(HOME, ".local", "share", "standup");
const LAUNCH = "a3a3a3a3-0000-4000-8000-0000000000a3";
const ROOT = join(DATA, "worktrees", "standup", "feat-1");
const INSTALL = join("/", "fake", "install");
const FLOOR = join(INSTALL, "packages", "collector", "src", "floor");
const SCRIPT = join(ROOT, "scripts", "report.test.sh");

const config: FloorConfig = {
  v: 1,
  collectorUrl: "http://127.0.0.1:17777",
  launchId: LAUNCH,
  root: ROOT,
  sharedBranches: ["main", "mainline"],
  personalAwsAccounts: [],
  waitSeconds: 60,
  standupDataDir: DATA,
  floorPaths: [FLOOR],
  installDir: INSTALL,
  protectedPaths: [join(DATA, "secrets"), join(DATA, "review-scratch"), join(DATA, "review-media")],
  tmpDirs: ["/tmp"],
  workerToken: "x".repeat(64),
  replyPublicKey: "test",
};

function probes(files: Record<string, string>): Partial<FloorProbes> {
  const all: Record<string, string> = {
    [join(ROOT, ".git")]: "gitdir: /fake/repo/.git/worktrees/feat-1\n",
    [join(ROOT, "package.json")]: "{}",
    [join(DATA, "standup.db")]: "",
    [join(DATA, "secrets", "owner.token")]: "secret",
    [join(FLOOR, "hook.ts")]: "export {};\n",
    [join(ROOT, "scripts", "lib.sh")]: "declare -r LIB_VERSION=1\nOUT=/tmp/a\n",
    [join(ROOT, "scripts", "guard.sh")]: '[ -n "${FLOOR_TEST_UNSET_GUARD:-}" ] && return\nFLOOR_TEST_UNSET_GUARD=1\nOUT=/tmp/a\n',
    ...files,
  };
  const dirs = new Set<string>(["/", "/tmp", ROOT]);
  for (const f of Object.keys(all)) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  dirs.delete(join(ROOT, ".git"));
  const defs: ShellDefinitions = { aliases: new Map(), functions: new Map() };
  parseShellSnapshot("", defs);
  const bare = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return {
    gitBranch: () => "standup/feat-1",
    gitAlias: () => null,
    gitHooksDir: () => null,
    readFile: (p) => (p in all ? { ok: true, text: all[p]! } : { ok: false, reason: "missing" }),
    exists: (p) => p in all || dirs.has(bare(p)),
    isDirectory: (p) => dirs.has(bare(p)),
    listDir: (raw) => {
      const p = bare(raw);
      return dirs.has(p) ? [...new Set([...Object.keys(all), ...dirs].filter((f) => f.startsWith(`${p === "/" ? "" : p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]!))] : null;
    },
    realpath: (p) => (p in all || dirs.has(p) ? p : null),
    homeDir: () => HOME,
    shellDefinitions: () => defs,
    awsAccount: () => null,
    now: () => Date.now(),
    gitTree: () => null,
    gitAncestor: () => null,
    gitBlob: () => ({ ok: false, reason: "missing" }),
  };
}

/** Runs `script` as scripts/report.test.sh through `command`. */
function run(script: string, command = "bash scripts/report.test.sh", files: Record<string, string> = {}): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd: ROOT }, config, probes({ [SCRIPT]: script, ...files }));
}

const RUNNERS = ["bash scripts/report.test.sh", "./scripts/report.test.sh", "sh scripts/report.test.sh", "bash ./scripts/report.test.sh arg"];

/** One line per script and runner: the script's last assignment lines, the runner, and "allow" or the hold's category. */
function outcomes(scripts: string[], runners: string[], detail: boolean): string[] {
  return scripts.flatMap((script) => runners.map((command) => {
    const v = run(script, command);
    const body = script.slice(HEADER.length).split("\n").slice(0, 2).join(" ; ");
    return `${body} | ${command} | ${v.action === "hold" ? (detail ? `${v.category}: ${v.reason}` : v.category) : v.action}`;
  }));
}

function allowed(...scripts: string[]): void {
  expect(outcomes(scripts, RUNNERS, true)).toEqual(outcomes(scripts, RUNNERS, true).map((l) => l.replace(/[^|]*$/, " allow")));
}

function held(category: string, scripts: string[], runners = RUNNERS): void {
  expect(outcomes(scripts, runners, false)).toEqual(outcomes(scripts, runners, false).map((l) => l.replace(/[^|]*$/, ` ${category}`)));
}

/** Every runner of every script is held, and the hold names a step matching `step` (by default a redirect). */
function heldAny(scripts: string[], files: Record<string, string> = {}, step: RegExp = /redirect/): void {
  const lines = scripts.flatMap((script) =>
    RUNNERS.map((command) => {
      const v = run(script, command, files);
      return `${script.slice(HEADER.length).replace(/\n/g, " ; ")} | ${command} | ${v.action === "hold" && step.test(v.reason) ? "hold" : `${v.action}: ${v.action === "hold" ? v.reason : ""}`}`;
    })
  );
  expect(lines).toEqual(lines.map((l) => l.replace(/[^|]*$/, " hold")));
}

const HEADER = "#!/usr/bin/env bash\nset -euo pipefail\n";

/** The hook reads TMPDIR from the environment it shares with the worker. */
const savedTmpdir = process.env.TMPDIR;
beforeEach(() => {
  process.env.TMPDIR = "/tmp";
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});

describe("a redirect to a variable the script assigns itself", () => {
  test("is allowed when the variable is a literal, temp or worktree path, or a mktemp", () => {
    const targets = [
      'REPORT_FILE=/tmp/report.txt',
      'REPORT_FILE="/tmp/report-$$.txt"',
      'REPORT_FILE=out/report.txt',
      'REPORT_FILE="./report.txt"',
      'REPORT_FILE="$(mktemp)"',
      "REPORT_FILE=$(mktemp -t report.XXXXXX)",
      'REPORT_FILE="$(mktemp /tmp/report.XXXXXX)"',
      'REPORT_FILE="${TMPDIR:-/tmp}/report.txt"',
      'REPORT_FILE="$TMPDIR/report.txt"',
      'REPORT_FILE="$(dirname "$0")/report.txt"',
      'REPORT_FILE="$(cd "$(dirname "$0")" && pwd)/report.txt"',
      'TMP_DIR="$(mktemp -d)"\nREPORT_FILE="$TMP_DIR/report.txt"',
      'readonly REPORT_FILE=/tmp/report.txt',
      'local_dir=/tmp\nREPORT_FILE="${local_dir}/r.txt"',
    ];
    allowed(...targets.map((assign) => `${HEADER}${assign}\ntrap 'rm -f "$REPORT_FILE"' EXIT\necho start > "$REPORT_FILE"\necho more >> "$REPORT_FILE"\ncat "$REPORT_FILE"\n`));
  });

  test("is allowed after a mktemp inside a function or a test helper", () => {
    allowed(
      `${HEADER}REPORT_FILE="$(mktemp)"\nrun_case() {\n  echo "$1" > "$REPORT_FILE"\n}\nrun_case one\nrun_case two\n`,
      `${HEADER}setup() { WORK="$(mktemp -d)"; }\nsetup\necho x > "$WORK/out.txt"\n`,
    );
  });

  test("from the environment or the arguments is a write the floor can't place: it runs unless the script names a guarded file", () => {
    allowed(
      `${HEADER}echo x > "$FLOOR_TEST_UNSET_REPORT"\n`,
      `${HEADER}REPORT_FILE="$FLOOR_TEST_UNSET_DIR/r.txt"\necho x > "$REPORT_FILE"\n`,
      `${HEADER}REPORT_FILE="$FLOOR_TEST_UNSET_REPORT"\n: "\${REPORT_FILE:=/tmp/r.txt}"\necho x > "$REPORT_FILE"\n`,
    );
    held("floor-tamper", [`${HEADER}echo x > "\${FLOOR_TEST_UNSET_REPORT:-$HOME/.bashrc}"\n`]);
    held("destructive", [`${HEADER}REPORT_FILE="$FLOOR_TEST_UNSET_DIR/.zshrc"\necho x > "$REPORT_FILE"\n`]);
    // An argument the floor can't resolve.
    const unresolved = ['bash scripts/report.test.sh "$FLOOR_TEST_UNSET_ARG"', 'sh scripts/report.test.sh "$(some-tool)"', './scripts/report.test.sh "$FLOOR_TEST_UNSET_ARG"'];
    const fromArg = [`${HEADER}REPORT_FILE="$1"\necho x > "$REPORT_FILE"\n`, `${HEADER}REPORT_FILE="\${1:-/tmp/r.txt}"\necho x > "$REPORT_FILE"\n`, `${HEADER}echo x > "$1"\n`];
    expect(outcomes(fromArg, unresolved, true)).toEqual(outcomes(fromArg, unresolved, true).map((l) => l.replace(/[^|]*$/, " allow")));
    held("destructive", [`${HEADER}echo x > "$1/.bashrc"\n`], unresolved);
  });

  test("reassigned from a substitution the floor can't classify is a write it can't place", () => {
    allowed(
      `${HEADER}REPORT_FILE="$(mktemp)"\nREPORT_FILE="$(python3 -c 'print(1)')"\necho x > "$REPORT_FILE"\n`,
      `${HEADER}REPORT_FILE=/tmp/r.txt\nREPORT_FILE="$(some-tool --where)"\necho x > "$REPORT_FILE"\n`,
    );
    held("destructive", [`${HEADER}REPORT_FILE=${RC}\nREPORT_FILE="$(some-tool --where)"\necho x > "$REPORT_FILE"\n`]);
  });

  test("is held when the variable resolves to a protected path", () => {
    const cases: Array<[string, string]> = [
      [`REPORT_FILE=${join(DATA, "secrets", "owner.token")}`, "floor-tamper"],
      [`REPORT_FILE=${join(DATA, "standup.db")}`, "floor-tamper"],
      [`REPORT_FILE=${join(FLOOR, "hook.ts")}`, "floor-tamper"],
      [`REPORT_FILE=${join(INSTALL, "package.json")}`, "floor-tamper"],
      ['REPORT_FILE="$HOME/.claude/settings.json"', "floor-tamper"],
      ['REPORT_FILE=~/.bashrc', "floor-tamper"],
      ['REPORT_FILE=/etc/passwd', "destructive"],
    ];
    for (const [assign, category] of cases) {
      const v = run(`${HEADER}${assign}\necho x > "$REPORT_FILE"\n`, "bash scripts/report.test.sh", { "/etc/passwd": "root" });
      expect({ assign, action: v.action }).toEqual({ assign, action: "hold" });
      if (v.action === "hold") expect({ assign, category: String(v.category) }).toEqual({ assign, category });
    }
    // The repository's own hooks are off the denylist: a write there is allowed.
    const hook = `REPORT_FILE=${join(ROOT, ".git", "hooks", "pre-commit")}`;
    expect(run(`${HEADER}${hook}\necho x > "$REPORT_FILE"\n`, "bash scripts/report.test.sh", {}).action).toBe("allow");
    // A TMPDIR that points at a protected dir is judged by where it points.
    process.env.TMPDIR = join(HOME, ".claude");
    held("floor-tamper", [`${HEADER}REPORT_FILE="$TMPDIR/settings.json"\necho x > "$REPORT_FILE"\n`, `${HEADER}REPORT_FILE="\${TMPDIR:-/tmp}/settings.json"\necho x > "$REPORT_FILE"\n`]);
  });
});

const RC = '"$HOME/.bashrc"';

describe("a variable the floor would read as safe, but the shell may hold a protected path in", () => {
  test("reassigned after the first assignment, through eval, or appended to", () => {
    heldAny([
      `${HEADER}R="$(mktemp)"\nR=${RC}\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\neval 'R="$HOME/.bashrc"'\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\neval "R=$HOME/.bashrc"\necho x > "$R"\n`,
      `${HEADER}R="$HOME/.bash"\nR+=rc\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nR[0]=${RC}\necho x > "$R"\n`,
      `${HEADER}: "\${R:=$HOME/.bashrc}"\necho x > "\${R:-/tmp/a}"\n`,
    ]);
  });

  test("assigned in a function, a branch, a list or a case arm that may or may not run", () => {
    heldAny([
      `${HEADER}R="$(mktemp)"\nset_r() { R=${RC}; }\nset_r\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\nset_r() { R=${RC}; [ -n "\${1:-}" ] && return; R=/tmp/ok; }\nset_r x\necho x > "$R"\n`,
      `${HEADER}go() { cd "$HOME/.claude"; }\ngo\necho x > settings.json\n`,
      `${HEADER}R=${RC}\nif [ -n "$(some-tool)" ]; then R="$(mktemp)"; fi\necho x > "$R"\n`,
      `${HEADER}R=${RC}\nif [ -n "$(some-tool)" ]; then R=/tmp/a; else echo x > "$R"; fi\n`,
      `${HEADER}R=${RC}\nif [ -n "$(some-tool)" ]; then R=/tmp/a; elif echo x > "$R"; then :; fi\n`,
      `${HEADER}R=${RC}\ntrue || R=/tmp/a\necho x > "$R"\n`,
      `${HEADER}R=${RC}\ntrue || R=/tmp/a && echo x > "$R"\n`,
      `${HEADER}R=${RC}\ncase "\${1:-}" in a) R=/tmp/a ;; esac\necho x > "$R"\n`,
      `${HEADER}R=${RC}\ncase "\${1:-}" in a) R=/tmp/a ;; *) echo x > "$R" ;; esac\n`,
    ]);
  });

  test("assigned in a loop body that runs no times, again, or stops partway", () => {
    heldAny([
      `${HEADER}R=/tmp/a\nfor i in 1 2; do echo x > "$R"; R=${RC}; done\n`,
      `${HEADER}R=/tmp/a\nfor i in 1 2; do echo x > "$R"; R=${RC}; [ "$i" = 1 ] && continue; R=/tmp/a; done\n`,
      `${HEADER}R=/tmp/a\nwhile read -r l; do echo "$l" > "$R"; R=${RC}; done < /tmp/in\n`,
      `${HEADER}R=${RC}\nwhile false; do R=/tmp/a; done\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nfor f in $(ls); do echo x > "$R"; R=${RC}; done\n`,
      `${HEADER}R=${RC}\nwhile getopts o: opt; do R="$OPTARG"; done\necho x > "$R"\n`,
    ]);
    // Set only from an option the floor can't read, the path is one it can't place, which runs.
    allowed(`${HEADER}while getopts o: opt; do R="$OPTARG"; done\necho x > "$R"\n`);
  });

  test("set by a builtin the floor doesn't take a value from", () => {
    heldAny([
      `${HEADER}R="$(mktemp)"\nprintf -v R '%s' ${RC}\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\nprintf -vR '%s' ${RC}\necho x > "$R"\n`,
      `${HEADER}R=/tmp/x/.bashrc\nread -r R < /tmp/in\necho x > "$R"\n`,
      `${HEADER}read -r < /tmp/in\necho x > "\${REPLY:-/tmp/x/.bashrc}"\n`,
      `${HEADER}R=/tmp/a\necho ${RC} | read -r R\necho x > "$R"\n`,
      `${HEADER}[[ "$HOME/.bashrc" =~ .* ]]\necho x > "\${BASH_REMATCH:-/tmp/a}"\n`,
      `${HEADER}T=${RC}\ndeclare -n R=T\necho x > "$R"\n`,
      `${HEADER}X=/tmp/a\ndeclare -n R=X\nR=${RC}\necho x > "$X"\n`,
      `${HEADER}X=/tmp/a\nlocal -n R=X 2>/dev/null || typeset -n R=X\nR=${RC}\necho x > "$X"\n`,
      `${HEADER}n="$(some-tool)"\nR=/tmp/a\ndeclare "$n=$HOME/.bashrc"\necho x > "$R"\n`,
      `${HEADER}R=/tmp/x/.bashrc\n(( R = 1 ))\necho x > "$R"\n`,
    ]);
    // What such a builtin leaves is a path the floor can't place: with no guarded file named, the write runs.
    allowed(`${HEADER}R="$(mktemp)"\nread -r R < /tmp/in\necho x > "$R"\n`, `${HEADER}R=/tmp/a\n(( R = 1 ))\necho x > "$R"\n`);
  });

  test("exported from a sourced file, or handed in from the command that runs the script", () => {
    const env = { [join(ROOT, "scripts", "env.sh")]: `export R=${RC}\n`, [join(ROOT, "scripts", "maybe.sh")]: `R=${RC}\n[ -n "$(some-tool)" ] && return\nR=/tmp/ok\n` };
    heldAny([
      `${HEADER}R="$(mktemp)"\nsource "$(dirname "$0")/env.sh"\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\n. ./scripts/env.sh\necho x > "$R"\n`,
      `${HEADER}R="$(mktemp)"\n. ./scripts/maybe.sh\necho x > "$R"\n`,
    ], env);
    const script = `${HEADER}echo x > "\${R:-/tmp/a}"\n`;
    for (const command of [`R=${RC} bash scripts/report.test.sh`, `export R=${RC}; bash scripts/report.test.sh`, `env R=${RC} sh scripts/report.test.sh`]) {
      expect({ command, action: run(script, command).action }).toEqual({ command, action: "hold" });
    }
    // Handed a value the floor can't read, the script writes a path it can't place, which runs.
    expect(run(script, `R="$(some-tool)" ./scripts/report.test.sh`).action).toBe("allow");
  });

  test("set by a function redefined in a branch, or by code sourced from stdin", () => {
    heldAny([
      `${HEADER}set_r() { R=${RC}; }\nif [ -n "$(some-tool)" ]; then set_r() { R=/tmp/a; }; fi\nset_r\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nsource /dev/stdin <<< 'R="$HOME/.bashrc"'\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\n. <(echo 'R="$HOME/.bashrc"')\necho x > "$R"\n`,
    ]);
  });

  test("assigned in an if clause the floor decides from strings it can resolve", () => {
    // Only the clause that runs assigns; the others are still read.
    allowed(
      `${HEADER}R=${RC}\nif [ -n "x" ]; then R=/tmp/a; fi\necho x > "$R"\n`,
      `${HEADER}if [ -z "" ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ "\${FLOOR_TEST_UNSET_MODE:-local}" = ci ]; then R=${RC}; elif test "\${FLOOR_TEST_UNSET_MODE:-local}" != ci; then R="$(mktemp)"; fi\necho x > "$R"\n`,
      `${HEADER}R=${RC}\n[ -n "\${FLOOR_TEST_UNSET_LOADED:-}" ] || R=/tmp/a\necho x > "$R"\n`,
    );
    heldAny([
      `${HEADER}R=/tmp/a\nif [ -n "x" ]; then R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nif ! [ -z "x" ]; then R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ -n "x" ]; then R=/tmp/a; else :; fi\nif [ -n "x" ]; then echo x > ${RC}; fi\n`,
      `${HEADER}R=/tmp/a\nif [ "$(some-tool)" = x ]; then R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nif [ -n "x" -a -n "" ]; then :; else R=${RC}; fi\necho x > "$R"\n`,
    ]);
  });

  test("read by a trap that runs when the script exits, after a later assignment", () => {
    heldAny([
      `${HEADER}R="$(mktemp)"\ntrap 'echo x > "$R"' EXIT\nR=${RC}\n`,
      `${HEADER}R="$(mktemp)"\ntrap 'echo x > "$R"' EXIT\nR=${RC}\n[ -n "$(some-tool)" ] && exit 1\nR=/tmp/a\n`,
    ]);
    allowed(`${HEADER}R="$(mktemp)"\ntrap 'rm -f "$R"' EXIT\necho x > "$R"\n`);
  });
});

const BIN_LS = { [join(ROOT, "bin", "ls")]: `#!/bin/sh\necho x > "$HOME/.bashrc"\n` };

describe("cases from the correctness review", () => {
  test("an if is decided only on exact strings, by the builtin test, with operators every shell reads alike", () => {
    heldAny([
      `${HEADER}if [ -z "$(command -v floor-test-missing)" ]; then R=${RC}; else R=/tmp/a; fi\necho x > "$R"\n`,
      `${HEADER}if [ "$$" = 4194304 ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ $(( $$ % 2 )) = 0 ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ -z "$(find . -name floor-none)" ]; then R=${RC}; else R=/tmp/a; fi\necho x > "$R"\n`,
      `${HEADER}T="$(mktemp)"\nif [ "$T" = /tmp/tmp.floor ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ a == a ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [[ -n x ]]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}test() { return 1; }\nif test -n x; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [[ -n x ]] < /floor-none; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
    ]);
    heldAny([`${HEADER}rm -f flag.txt\nif [ -n "$(cat flag.txt)" ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`], { [join(ROOT, "flag.txt")]: "x" });
  });

  test("code sourced from stdin keeps return, cd and the args in the sourcing shell", () => {
    heldAny([
      `${HEADER}R=${RC}\nsource /dev/stdin <<< '[ -n "$(some-tool)" ] && return; R=/tmp/a'\necho x > "$R"\n`,
      `${HEADER}source /dev/stdin <<< 'cd "$HOME/.claude"'\necho x > settings.json\n`,
    ]);
  });

  test("a trap that may never fire assigns nothing, and fires with the shell's state as it exits", () => {
    heldAny([
      `${HEADER}trap 'R=/tmp/a' USR1\necho x > "\${R:-$HOME/.bashrc}"\n`,
      `${HEADER}trap ': "\${R:=/tmp/a}"' USR1\necho x > "\${R:-$HOME/.bashrc}"\n`,
      `${HEADER}f() { trap 'echo x > settings.json' EXIT; }\nf\ncd "$HOME/.claude"\n`,
    ]);
  });

  test("a loop with its own redirect, and a function, run in the shell itself", () => {
    heldAny([
      `${HEADER}while read -r l; do cd "$HOME/.claude"; break; done < /tmp/in\necho x > settings.json\n`,
      `${HEADER}X=/tmp/x/.bashrc\nwhile read -r l; do printf -v X '%s' "$l"; break; done < /tmp/in\necho x > "$X"\n`,
    ]);
    heldAny([`${HEADER}p() { PATH="$PWD/bin:$PATH"; }\np\nls\n`], BIN_LS, /\.bashrc|PATH/);
  });

  test("assignments that don't reach the shell, or reach it before the floor read them", () => {
    heldAny([
      `${HEADER}R=${RC}\nR=/tmp/a &\nwait\necho x > "$R"\n`,
      `${HEADER}R=${RC}\nR=/tmp/a > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { echo x > "$R"; }\nR=${RC} f\n`,
      `${HEADER}R=/tmp/a\nR=${RC} :\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nunset R\necho x > "\${R-$HOME/.bashrc}"\n`,
      `${HEADER}R=/tmp/a\nprintf -v 'R[0]' '%s' ${RC}\necho x > "$R"\n`,
      `${HEADER}R=/tmp/x/.bashrc\nread -r 'R[0]' < /tmp/in\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\ndeclare "R[0]=$HOME/.bashrc"\necho x > "$R"\n`,
      `${HEADER}declare -l R\nR="$PWD/.GIT/hooks/pre-commit"\necho x > "$R"\n`,
      `${HEADER}R="\${BASH_VERSION:+$HOME/.bashrc}"\necho x > "\${R:-/tmp/a}"\n`,
      `${HEADER}select R in /tmp/a; do echo x > "\${R:-$HOME/.bashrc}"; break; done <<< 9\n`,
      `${HEADER}U="$(some-tool)"\n: "\${U:+\${R:=$HOME/.bashrc}}"\necho x > "\${R:-/tmp/a}"\n`,
      `${HEADER}R=${RC}\ncoproc R=/tmp/a\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { local R=/tmp/b; }\nf\nunset R\necho x > "\${R:-$HOME/.bashrc}"\n`,
    ]);
    heldAny([`${HEADER}for PATH in "$PWD/bin:/usr/bin"; do ls; done\n`, `${HEADER}printf -v PATH '%s' "$PWD/bin:$PATH"\nls\n`], BIN_LS, /PATH|\.bashrc/);
  });

  test("a new process gets the command's env, not the caller's functions or the hook's env after env -i", () => {
    expect(run(`${HEADER}git push --force origin main\n`, "git() { :; }; bash scripts/report.test.sh").action).toBe("hold");
    expect(run(HEADER, `R=${RC} bash -c 'echo x > "\${R:-/tmp/a}"'`).action).toBe("hold");
    expect(run(`${HEADER}echo x > "$TMPDIR"/fake/home/.bashrc\n`, "env -i bash scripts/report.test.sh").action).toBe("hold");
    expect(run(`${HEADER}eval "$(mise env)"\necho x > "\${R:-$HOME/.bashrc}"\n`).action).toBe("hold");
  });

  test("kill of arithmetic on the shell's own pid still can't be identified; its own pid is its own", () => {
    heldAny([`${HEADER}kill $(( $$ - 1 ))\n`], {}, /kill/);
    allowed(`${HEADER}kill $$\n`);
  });

  test("safe scripts the stricter reading must still allow", () => {
    allowed(
      `${HEADER}if [ -n "$(some-tool)" ]; then OUT=/tmp/a; else OUT=/tmp/a; fi\necho x > "$OUT"\n`,
      `${HEADER}case "\${1:-}" in a) OUT=/tmp/a ;; *) OUT=/tmp/a ;; esac\necho x > "$OUT"\n`,
      `${HEADER}. ./scripts/lib.sh\necho x > "$OUT"\n`,
      `${HEADER}. ./scripts/guard.sh\necho x > "$OUT"\n`,
      `${HEADER}OUT="$(mktemp)"\nhelper() { local name="$1"; echo "$name" >> "$OUT"; }\nhelper a\nhelper b\necho x > "$OUT"\n`,
      `${HEADER}n=0\n(( n++ ))\nlet n+=1\nprintf "%s\\n" "$(some-tool)"\nOUT=/tmp/out-$n\necho x > "$OUT"\n`,
      `${HEADER}OUT="$(mktemp)"\nwhile read -r line; do echo "$line" >> "$OUT"; done < /tmp/in\necho x > "$OUT"\n`,
    );
  });
});
