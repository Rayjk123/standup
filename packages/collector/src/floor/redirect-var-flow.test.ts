import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, parseShellSnapshot, type FloorProbes, type ShellDefinitions } from "./classify.js";
import type { FloorConfig, FloorVerdict } from "./gate.js";

/*
 * How a script's control flow, scopes and child processes carry the values a
 * redirect target is built from: the working directory, the positional args
 * and variables that builtins, traps and sourced files may change. Each case
 * is one the shell can run into a protected file, so every runner holds it.
 * The machine is virtual, and its paths are built piece by piece so this file
 * carries no literal Standup path of its own.
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
    [join(ROOT, "scripts", "lib.sh")]: "OUT=/tmp/a\n",
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
const HEADER = "#!/usr/bin/env bash\nset -euo pipefail\n";
const RC = '"$HOME/.bashrc"';
const CL = '"$HOME/.claude"';

function line(script: string, command: string, v: FloorVerdict, step: RegExp): string {
  const ok = v.action === "hold" && step.test(v.reason);
  return `${script.replace(/\n/g, " ; ")} | ${command} | ${ok ? "hold" : `${v.action}: ${v.action === "hold" ? v.reason : ""}`}`;
}

/** Every runner of every script is held, and the hold names a step matching `step` (by default a redirect). */
function heldAny(scripts: string[], files: Record<string, string> = {}, step: RegExp = /redirect/, runners = RUNNERS): void {
  const lines = scripts.flatMap((script) => runners.map((command) => line(script, command, run(script, command, files), step)));
  expect(lines).toEqual(lines.map((l) => l.replace(/[^|]*$/, " hold")));
}

/** Every runner of every script is allowed. */
function allowed(scripts: string[], files: Record<string, string> = {}): void {
  const lines = scripts.flatMap((script) =>
    RUNNERS.map((command) => {
      const v = run(script, command, files);
      return `${script.replace(/\n/g, " ; ")} | ${command} | ${v.action === "hold" ? `hold: ${v.reason}` : v.action}`;
    })
  );
  expect(lines).toEqual(lines.map((l) => l.replace(/[^|]*$/, " allow")));
}

/** The hook reads TMPDIR from the environment it shares with the worker. */
const savedTmpdir = process.env.TMPDIR;
beforeEach(() => {
  process.env.TMPDIR = "/tmp";
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
});

describe("the working directory where paths that reach a point disagree on it", () => {
  test("is unknown after an if, a case, an and-or list or a loop that may change it", () => {
    heldAny([
      `${HEADER}if [ -n "$(some-tool)" ]; then cd ${CL}; else cd /tmp; fi\necho x > settings.json\n`,
      `${HEADER}case "$(some-tool)" in a) cd ${CL} ;; *) cd /tmp ;; esac\necho x > settings.json\n`,
      `${HEADER}cd ${CL} || cd /tmp\necho x > settings.json\n`,
      `${HEADER}cd ${CL} && [ -n "$(some-tool)" ] && cd /tmp\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\nwhile true; do break; cd /tmp; done\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\nwhile [ -n "$(some-tool)" ]; do cd /tmp; done\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\nwhile read -r l; do cd /tmp; done < /tmp/in\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\nfor d in a b; do cd /tmp; done\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\nif [ -n "$(some-tool)" ]; then pushd /tmp; fi\necho x > settings.json\n`,
    ]);
  });

  test("is read again on a loop's second pass when the body changes it", () => {
    heldAny([`${HEADER}while [ -n "$(some-tool)" ]; do echo x > settings.json; cd ${CL}; done\n`]);
  });

  test("is unknown after a function or a sourced file that may return before its cd", () => {
    heldAny(
      [
        `${HEADER}cd ${CL}\nf() { [ -n "$(some-tool)" ] && return; cd /tmp; }\nf\necho x > settings.json\n`,
        `${HEADER}cd ${CL}\n. ./scripts/lib-cd.sh\necho x > settings.json\n`,
      ],
      { [join(ROOT, "scripts", "lib-cd.sh")]: '[ -n "$(some-tool)" ] && return\ncd /tmp\n' }
    );
  });

  test("is unknown after a pipeline whose last stage may run in this shell", () => {
    heldAny([`${HEADER}shopt -s lastpipe\necho | cd ${CL}\necho x > settings.json\n`]);
  });

  test("`cd --` takes the dir after it, and a cd that may fail may leave the shell where it was", () => {
    heldAny([
      `${HEADER}cd -- ${CL}\necho x > settings.json\n`,
      `${HEADER}cd -P -- ${CL}\necho x > settings.json\n`,
      `#!/usr/bin/env bash\ncd ${CL}\ncd /tmp/floor-none\necho x > settings.json\n`,
      `${HEADER}cd ${CL}\ncd /tmp/floor-none || true\necho x > settings.json\n`,
    ]);
    allowed([`${HEADER}mkdir -p out && cd out\necho x > log.txt\n`, `${HEADER}cd -- /tmp\necho x > out.txt\n`]);
  });

  test("`builtin cd` and `command cd` change it even when a function named cd exists", () => {
    heldAny([`${HEADER}cd() { :; }\nbuiltin cd ${CL}\necho x > settings.json\n`, `${HEADER}cd() { :; }\ncommand cd ${CL}\necho x > settings.json\n`]);
  });
});

describe("a trap fires with the state of wherever the shell stops", () => {
  test("its cwd and args are unknown when they change after it is set", () => {
    heldAny([
      `${HEADER}trap 'echo x > settings.json' ERR\ncd ${CL}\nfalse\ncd /tmp\n`,
      `${HEADER}trap 'echo x > settings.json' EXIT\ncd ${CL}\n[ -n "$(some-tool)" ] && exit 0\ncd /tmp\n`,
      `${HEADER}trap 'echo x > settings.json' EXIT\ncd ${CL}\nfalse\ncd /tmp\n`,
      `${HEADER}trap 'echo x > "$1"' ERR\nset -- ${RC}\nfalse\nset -- /tmp/a\n`,
    ]);
  });

  test("a DEBUG, RETURN or ERR trap may fire before any later step", () => {
    heldAny([
      `${HEADER}R=/tmp/a\ntrap 'R="$HOME/.bashrc"' DEBUG\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\ng() { trap 'R="$HOME/.bashrc"' RETURN; :; }\ng\necho x > "$R"\n`,
      `#!/usr/bin/env bash\nR=/tmp/a\ntrap 'R="$HOME/.bashrc"' ERR\nfalse\necho x > "$R"\n`,
    ]);
    heldAny([`${HEADER}trap 'cd ${CL}' DEBUG\necho x > settings.json\n`], {}, /trap/);
  });
});

describe("a condition the floor decides", () => {
  test("trusts no value the floor computed, no shell-set variable and no unquoted glob", () => {
    heldAny([
      `${HEADER}cd /floor-none || true\nif [ "$PWD" = /floor-none ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ -n "$(some-tool)" ]; then cd /tmp; fi\nif [ "$PWD" = /tmp ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `#!/bin/sh\nif [ -n "$BASH_SOURCE" ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ * = * ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`,
      `${HEADER}if [ -z "\${BASH_ARGV0:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
      `${HEADER}if [ -z "\${NULLCMD:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
      `${HEADER}if [ -z "\${HOST:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
    ]);
  });

  test("sees what an arithmetic expansion, an fd redirect or `wait -p` assigned", () => {
    heldAny([
      `${HEADER}: $((FLOOR_ADV_SKIP=1))\nif [ -z "\${FLOOR_ADV_SKIP:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
      `${HEADER}echo "$((FLOOR_ADV_SKIP++))" > /dev/null\nif [ -z "\${FLOOR_ADV_SKIP:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
      `${HEADER}exec {FLOOR_ADV_FD}>/tmp/fd\nif [ -z "\${FLOOR_ADV_FD:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
      `${HEADER}sleep 0 &\nwait -n -p FLOOR_ADV_PID\nif [ -z "\${FLOOR_ADV_PID:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`,
    ]);
  });

  test("decides nothing about a recursive call, or a `test` a child inherits through export -f", () => {
    heldAny([
      `${HEADER}f() { if [ -z "\${FLOOR_ADV_DEPTH:-}" ]; then FLOOR_ADV_DEPTH=1; f; else OUT=${RC}; fi; }\nOUT=/tmp/a\nf\necho x > "$OUT"\n`,
      `${HEADER}test() { return 1; }\nexport -f test\nbash -c 'if test -z ""; then OUT=/tmp/a; else OUT="$HOME/.bashrc"; fi; echo x > "$OUT"'\n`,
    ]);
  });
});

describe("locals, returns and sourced files leave the caller's state as the shell would", () => {
  test("a local declared after a return, or in a step that may not run", () => {
    heldAny([
      `${HEADER}R=${RC}\nf() { [ -n "$(some-tool)" ] && return; R=/tmp/a; local R=/tmp/b; }\nf\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { if [ -n "" ]; then local R; fi; R=${RC}; }\nf\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { [ -n "$(some-tool)" ] && local R; R=${RC}; }\nf\necho x > "$R"\n`,
    ]);
  });

  test("a sourced file's set -- or shift after a return", () => {
    heldAny(
      [`${HEADER}set -- ${RC}\n. ./scripts/lib2.sh\necho x > "$1"\n`, `${HEADER}set -- ${RC} /tmp/a\n. ./scripts/lib3.sh\necho x > "$1"\n`],
      {
        [join(ROOT, "scripts", "lib2.sh")]: '[ -n "$(some-tool)" ] && return\nset -- /tmp/a\n',
        [join(ROOT, "scripts", "lib3.sh")]: '[ -n "$(some-tool)" ] && return\nshift\n',
      }
    );
  });

  test("a local's restore keeps the caller's unset and export state", () => {
    heldAny([
      `${HEADER}R=${RC}\nunset R\nf() { local R=x; }\nf\necho x > "\${R-$HOME/.bashrc}"\n`,
      `${HEADER}R=/tmp/a\nf() { declare -x R=/tmp/b; }\nf\nbash -c 'echo x > "\${R:-$HOME/.bashrc}"'\n`,
    ]);
  });

  test("declare -g behind a local, and unset in a callee, reach the global", () => {
    heldAny([
      `${HEADER}R=/tmp/a\nf() { local R=/tmp/b; declare -g R=${RC}; }\nf\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { local R=/tmp/b; typeset -g R=${RC}; }\nf\necho x > "$R"\n`,
      `${HEADER}R=/tmp/a\nf() { local R; declare -gx R=${RC}; }\nf\necho x > "$R"\n`,
      `${HEADER}R=${RC}\ng() { unset R; }\nf() { local R=/tmp/a; g; echo x > "\${R:-/tmp/b}"; }\nf\n`,
    ]);
  });
});

describe("builtins that may assign a name, or unexport one", () => {
  test("printf with an unresolved first word, unset -f, and an element default", () => {
    heldAny([
      `${HEADER}o="$(some-tool)"\nR=/tmp/a\nprintf "$o" '%s' "$HOME/.bashrc"\necho x > "$R"\n`,
      `${HEADER}R=${RC}\nunset -f R\necho x > "\${R:-/tmp/a}"\n`,
      `${HEADER}: "\${R[0]:=$HOME/.bashrc}"\necho x > "\${R:-/tmp/a}"\n`,
    ]);
  });

  test("export -n and +x take a name out of a child's environment", () => {
    heldAny([
      `${HEADER}export R=/tmp/a\nexport -n R\nbash -c 'echo x > "\${R:-$HOME/.bashrc}"'\n`,
      `${HEADER}export R=/tmp/a\ndeclare +x R\nbash -c 'echo x > "\${R:-$HOME/.bashrc}"'\n`,
      `${HEADER}export R=/tmp/a\ntypeset +x R\nsh -c 'echo x > "\${R:-$HOME/.bashrc}"'\n`,
    ]);
  });

  test("a name unset before a child starts is unset in it", () => {
    expect(run(`${HEADER}echo x > "\${TMPDIR:-$HOME/.claude}/settings.json"\n`, "unset TMPDIR; bash scripts/report.test.sh").action).toBe("hold");
  });

  test("mapfile -C runs its callback", () => {
    heldAny([`${HEADER}f() { R=${RC}; }\nR=/tmp/a\nmapfile -C f -c 1 A < /tmp/in\necho x > "$R"\n`, `${HEADER}f() { echo x > ${RC}; }\nmapfile -C f -c 1 A < /tmp/in\n`]);
  });

  test("zsh's read 'NAME?prompt' assigns NAME", () => {
    // A write to a path the floor can't place holds only where the script names a guarded file: read as unchanged, R is a scratch file.
    const v = run(`${HEADER}R=/tmp/x/.bashrc\nread 'R?path: ' < /tmp/in\necho x > "$R"\n`, "zsh scripts/report.test.sh");
    expect(line("zsh read", "zsh", v, /redirect/)).toBe("zsh read | zsh | hold");
  });
});

describe("what a new shell or a sourced file starts with", () => {
  test('quoted "$*" joins with the first character of IFS', () => {
    heldAny([
      `${HEADER}set -- "$HOME" .bashrc\nIFS=/\nR="$*"\necho x > "$R"\n`,
      `${HEADER}j() { local IFS=/; R="$*"; }\nj "$HOME" .bashrc\necho x > "$R"\n`,
      `${HEADER}set -- "$HOME" .bashrc\nprintf -v IFS '%s' /\nR="$*"\necho x > "$R"\n`,
    ]);
  });

  test("mktemp makes its name under the TMPDIR the script or the command sets", () => {
    heldAny([
      `${HEADER}export TMPDIR="$HOME/.claude"\nD="$(mktemp -d)"\necho x > "$D/../settings.json"\n`,
      `${HEADER}TMPDIR="$HOME"; export TMPDIR; D=$(mktemp -d -t d.XXXXXX); echo x > "$D/../.bashrc"\n`,
      `${HEADER}export TMPDIR="$HOME/.claude"\nD="$(mktemp -d -p '')"\necho x > "$D/../settings.json"\n`,
      `${HEADER}export TMPDIR="$HOME/.claude"\nbash -c 'D=$(mktemp -d); echo x > "$D/../settings.json"'\n`,
    ]);
    const v = run(`${HEADER}D="$(mktemp -d)"\necho x > "$D/../settings.json"\n`, `TMPDIR="$HOME/.claude" bash scripts/report.test.sh`);
    expect(v.action).toBe("hold");
  });

  test("source FILE ARGS binds the args, and bash -s ARGS passes them to stdin's code", () => {
    heldAny(
      [
        `${HEADER}. ./scripts/w.sh "$HOME/.bashrc"\n`,
        `${HEADER}set -- /tmp/a\nsource ./scripts/w.sh ${RC}\n`,
        `${HEADER}builtin source ./scripts/w2.sh ${RC}\n`,
        `${HEADER}set -- /tmp/a\nbash -s "$HOME/.bashrc" <<< 'echo x > "\${1:-/tmp/a}"'\n`,
        `${HEADER}sh -s -- ${RC} <<< 'echo x > "\${1:-/tmp/a}"'\n`,
      ],
      { [join(ROOT, "scripts", "w.sh")]: 'echo x > "$1"\n', [join(ROOT, "scripts", "w2.sh")]: 'echo x > "${1:-/tmp/a}"\n' }
    );
  });

  test("`bash - FILE` runs FILE, not stdin", () => {
    const files = { [join(ROOT, "scripts", "w3.sh")]: 'echo x > "$HOME/.bashrc"\n' };
    heldAny([`${HEADER}bash - ./scripts/w3.sh <<< ':'\n`], files);
    expect(run(":\n", "bash - ./scripts/w3.sh <<< ':'", files).action).toBe("hold");
  });
});

describe("code that runs without the floor reading it there", () => {
  test("command_not_found_handle and set -k are held", () => {
    heldAny([`${HEADER}command_not_found_handle() { echo x > ${RC}; }\nfloor-test-missing-cmd\n`]);
    heldAny([`${HEADER}set -k\nbash -c 'echo x > "\${R:-/tmp/a}"' R=${RC}\n`], {}, /set -k|keyword/);
  });
});

describe("forms main holds, where the floor reads the variable as unknown", () => {
  test("A11", () => heldAny([`#!/bin/sh\nX=${RC}\nf() { local X; echo x > "\${X:-/tmp/a}"; }\nf\n`]));

  /** A condition on FLOORX, a variable in the hook's environment, choosing the redirect target. */
  const ON_ENV = `${HEADER}if [ -n "\${FLOORX:-}" ]; then R=/tmp/a; else R=${RC}; fi\necho x > "$R"\n`;
  const fromEnv = (command: string) => {
    process.env.FLOORX = "1";
    try {
      return run(ON_ENV, command).action;
    } finally {
      delete process.env.FLOORX;
    }
  };

  test("A7", () => {
    expect(fromEnv("export -n FLOORX; bash scripts/report.test.sh")).toBe("hold");
    expect(fromEnv("declare +x FLOORX; bash scripts/report.test.sh")).toBe("hold");
  });

  test("A12", () => {
    const decide = `if [ -z "\${FLOORZ:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`;
    heldAny(
      [
        `: $[FLOORZ=1]`,
        `[[ 1 -eq FLOORZ=1 ]]`,
        `S=abc; : "\${S:FLOORZ=1}"`,
        `A=(a b); : "\${A[FLOORZ=1]}"`,
        `for ((FLOORZ=1;0;)); do :; done`,
        `declare -i V; V='FLOORZ=1'`,
        `N=FLOORZ; : $(( $N = 1 ))`,
        `E='FLOORZ=1'; : $((E))`,
      ].map((pre) => `${HEADER}${pre}\n${decide}`)
    );
  });

  test("R2A-5", () => heldAny([`${HEADER}R=/tmp/a\ntrap 'R="$HOME/.bashrc"' CHLD\nsleep 0 &\nwait\necho x > "$R"\n`, `${HEADER}R=/tmp/a\ntrap 'R="$HOME/.bashrc"' USR1 INT\necho x > "$R"\n`]));

  test("R2A-6", () => heldAny([`#!/usr/bin/env bash\n[ -n "$(some-tool)" ] && set -e\ntrap 'cd ${CL}' ERR\nfalse\necho x > settings.json\n`], {}, /trap/));

  test("R2A-11", () => heldAny([`${HEADER}coproc { :; }\nif [ -z "\${COPROC_PID:-}" ]; then OUT=/tmp/a; else OUT=${RC}; fi\necho x > "$OUT"\n`]));

  test("A9", () => heldAny([`${HEADER}set -a\nf() { echo x > ${RC}; }\nbash -c f\n`, `${HEADER}set -o allexport\nf() { echo x > ${RC}; }\nbash -c f\n`]));

  test("A8", () => {
    for (const env of ["env -uFLOORX", "env --unset=FLOORX", "env -u FLOORX"]) expect(fromEnv(`${env} bash scripts/report.test.sh`)).toBe("hold");
  });
});

describe("round-2 false holds", () => {
  test("R2B-H1", () => {
    allowed([
      `${HEADER}cmake -S . -B build\ncd build\nmake\ncd ..\necho x > out.log\n`,
      `${HEADER}mkdir -p out\ncd out\ncd ..\nmkdir -p out2\n`,
      `#!/usr/bin/env bash\nmkdir -p out\ncd out\ncd ..\necho x > out.log\n`,
    ]);
  });

  test("R2B-M1", () => {
    allowed([
      `#!/usr/bin/env bash\non_err() { echo failed >&2; }\ntrap 'on_err $LINENO' ERR\nset -euo pipefail\necho x > /tmp/a\n`,
      `#!/bin/bash -e\non_err() { echo failed >&2; }\ntrap on_err ERR\necho x > /tmp/a\n`,
      `#!/usr/bin/env bash\ntmp=$(mktemp -d)\ntrap 'rm -rf "$tmp"' ERR EXIT\necho x > "$tmp/out"\n`,
      `#!/usr/bin/env bash\ntmp=$(mktemp -d)\ncleanup() { rm -rf "$tmp"; }\ntrap cleanup ERR EXIT\necho x > "$tmp/out"\n`,
    ]);
  });

  test("R2B-H2", () => {
    const pkg = '{"scripts":{"test":"echo ok"}}';
    const files = Object.fromEntries(["a", "b", "c"].map((p) => [join(ROOT, "packages", p, "package.json"), pkg]));
    allowed(
      [
        `${HEADER}for p in a b c; do pushd "packages/$p" > /dev/null; npm test; popd > /dev/null; done\necho x > done.txt\n`,
        `${HEADER}for p in a b c; do cd "packages/$p"; npm test; cd -; done\necho x > done.txt\n`,
        `${HEADER}for p in a b c; do cd "packages/$p"; npm test; cd ../..; done\necho x > done.txt\n`,
        `${HEADER}mkdir -p x && cd x && cd ..\nmkdir -p y && cd y && cd ..\nmkdir -p z && cd z && cd ..\necho x > done.txt\n`,
      ],
      files
    );
  });
});

describe("known gaps, skipped", () => {
  test.skip("A3", () => heldAny([`${HEADER}cd ${CL}\npushd /tmp\npushd\necho x > settings.json\n`]));
  test.skip("A4", () => heldAny([`${HEADER}shopt -s cdable_vars\nD="$HOME/.claude"\ncd D\necho x > settings.json\n`]));
  test.skip("A5", () => heldAny([`${HEADER}trap g EXIT\ng() { echo x > ${RC}; }\nsome-tool\ng() { :; }\n`]));
  test.skip("R2A-1", () => heldAny([`${HEADER}P=/tmp\nQ=/tmp\nf() { echo x > "$P/settings.json"; P="$Q"; Q="$HOME/.claude"; [ -n "$(some-tool)" ] && f; }\nf\n`]));
  test.skip("R2A-2", () => heldAny([`${HEADER}cd ${CL}\ncd /tmp\ncd /tmp/floor-none\ncd -\necho x > settings.json\n`]));
  test.skip("R2A-7", () => heldAny([`${HEADER}set -E\ntrap 'echo x > settings.json' ERR\n( cd ${CL}; false )\n`]));
  test.skip("R2A-8", () => heldAny([`${HEADER}cd ${CL}\nrm -rf /tmp/floorx\ncd /tmp/floorx\necho x > settings.json\n`], { "/tmp/floorx/f": "" }));
  test.skip("R2A-9", () => heldAny([`${HEADER}cd ${CL}\npushd /tmp\npushd /tmp/floor-none\npopd\necho x > settings.json\n`]));
  test.skip("R2A-12", () => heldAny([`${HEADER}shopt -s expand_aliases\ntrap 'echo' DEBUG\nalias echo='cd ${CL}'\n:\nprintf x > settings.json\n`]));
  test.skip("A-low", () => heldAny([`${HEADER}export TMPDIR="$HOME/.claude"\nD=$(mktemp -d -t -p /tmp x.XXXX)\necho x > "$D/../settings.json"\n`]));
});

describe("ordinary scripts stay allowed", () => {
  test("cwd, traps, locals, sourced files and child shells used the usual way", () => {
    allowed([
      `${HEADER}for d in a b; do (cd "$d" && echo hi); done\necho x > out.txt\n`,
      `${HEADER}T="$(mktemp)"\ntrap 'rm -f "$T"' EXIT\necho x > "$T"\n`,
      `${HEADER}trap 'echo failed >&2' ERR\nOUT=/tmp/a\necho x > "$OUT"\n`,
      `${HEADER}trap 'echo done' EXIT\ncd /tmp\necho x > out.txt\n`,
      `${HEADER}cd /tmp\necho x > out.txt\n`,
      `${HEADER}pushd /tmp > /dev/null\npopd > /dev/null\necho x > out.txt\n`,
      `${HEADER}f() { local x=/tmp/a; echo hi > "$x"; }\nf\necho x > /tmp/b\n`,
      `${HEADER}. ./scripts/lib.sh arg\necho x > "$OUT"\n`,
      `${HEADER}set -- a b\nIFS=,\nR="/tmp/$*"\necho x > "$R"\n`,
      `${HEADER}D="$(mktemp -d)"\necho x > "$D/out"\n`,
      `${HEADER}export TMPDIR=/tmp\nD="$(mktemp -d)"\necho x > "$D/out"\n`,
      `${HEADER}bash -s <<< 'echo x > /tmp/a'\n`,
      `${HEADER}echo a | while read -r l; do echo "$l"; done\necho x > out.txt\n`,
      `${HEADER}while read -r l; do echo "$l" > /tmp/a; done < /tmp/in\necho x > out.txt\n`,
      `${HEADER}mapfile -t A < /tmp/in\necho x > /tmp/a\n`,
      `${HEADER}export FOO=1\nexport -n FOO\necho x > /tmp/a\n`,
      `${HEADER}R=/tmp/a\nf() { local R=/tmp/b; echo x > "$R"; }\nf\necho x > "$R"\n`,
      `${HEADER}T="$(mktemp)"\ntrap 'rm -f "$T"' EXIT\ngit() { echo "git $*" >> "$T"; }\ngit push --force origin main\n`,
    ]);
  });

  test("a cd that may not run, or a loop that moves and comes back, leaves the shell in one of the dirs it may be in", () => {
    const files = { [join(ROOT, "pkg", "a", "Makefile")]: "all:\n", [join(ROOT, "pkg", "b", "Makefile")]: "all:\n", [join(ROOT, "build", "Makefile")]: "all:\n" };
    allowed(
      [
        `${HEADER}mkdir -p build && cd build\nmake\n`,
        `${HEADER}mkdir -p build && cd build\necho x > out.log\n`,
        `${HEADER}cd build && make && cd ..\necho x > out.log\n`,
        `${HEADER}if [ -d build ]; then cd build; fi\necho x > out.log\n`,
        `${HEADER}[ -d build ] && cd build\necho x > out.log\n`,
        `${HEADER}for d in pkg/a pkg/b; do pushd "$d" > /dev/null; echo x > out.log; popd > /dev/null; done\n`,
        `${HEADER}for d in pkg/a pkg/b; do cd "$d"; echo x > out.log; cd ../..; done\n`,
        `${HEADER}build() { pushd "$1" > /dev/null; make; popd > /dev/null; }\nfor d in pkg/a pkg/b; do build "$d"; done\necho x > out.log\n`,
        `${HEADER}trap 'rm -f out.tmp' EXIT\ncd build\necho x > out.tmp\n`,
      ],
      files
    );
  });

  test("a printf format, a wrapper function and recursion don't make every variable unknown", () => {
    allowed([
      `${HEADER}RED=$(tput setaf 1 || true)\nNC=$(tput sgr0 || true)\nd=$(mktemp -d)\nprintf "\${RED}%s\${NC}\\n" msg\necho x > "$d/out"\n`,
      `${HEADER}OUT=/tmp/o\nmsg=$(date)\nprintf "$msg %s\\n" a\necho x > "$OUT"\n`,
      `${HEADER}OUT=/tmp/o\nkubectl() { env KUBECONFIG=/tmp/kc kubectl "$@"; }\nkubectl get pods\necho x > "$OUT"\n`,
      `${HEADER}OUT=/tmp/o\ncurl() { timeout 30 curl "$@"; }\ncurl -s https://example.com\necho x > "$OUT"\n`,
      `${HEADER}OUT=/tmp/o\nretry() { [ "$1" -gt 0 ] || return 0; retry $(($1 - 1)); }\nretry 3\necho x > "$OUT"\n`,
    ]);
  });

  test("a TMPDIR guard, an ERR cleanup trap under set -e, and mapfile options", () => {
    allowed([
      `${HEADER}[ -n "\${TMPDIR:-}" ] || TMPDIR=/tmp\necho x > "$TMPDIR/out"\n`,
      `${HEADER}if [ -z "\${TMPDIR:-}" ]; then export TMPDIR=/tmp; fi\nd=$(mktemp -d)\necho x > "$d/out"\n`,
      `${HEADER}tmp=$(mktemp -d)\ncleanup() { cd /tmp; rm -rf "$tmp"; }\ntrap cleanup EXIT INT TERM ERR\necho x > "$tmp/out"\n`,
      `${HEADER}sep=$(some-tool)\nmapfile -t -d "$sep" arr < /tmp/in\necho x > /tmp/a\n`,
    ]);
  });
});
