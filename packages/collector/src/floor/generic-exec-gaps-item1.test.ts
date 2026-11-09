import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { classifyToolCall, defaultProbes, type GitTree } from "./classify.js";
import type { FloorVerdict } from "./gate.js";
import { DATA, INSTALL, LINKS, LIVE_PATH, REPO, ROOT, WORKER_ENV, config, probes, shape } from "./scratch-harness.js";

/*
 * A worker's whole-suite test run under `env -i`, every dir it is handed
 * under one /tmp root: the root made by `mktemp -d -p /tmp` and named `R`, or
 * written out literally, with STANDUP_INTERNAL_ROOT the root itself, the XDG
 * dirs one level down under `$R/xdg`, and the test files a `git ls-files`
 * listing. `PATH="$PATH"` expands to the classifying process's own PATH, so
 * the tests hand it a worker-shaped one (scratch-harness's LIVE_PATH, which
 * names the install's missing packages/node_modules/.bin).
 */

setDefaultTimeout(600_000);

const MKDIRS = "mkdir -p $R/home $R/xdg/config $R/xdg/data $R/xdg/cache $R/xdg/state $R/tmp $R/kb";
const VARS =
  "HOME=$R/home XDG_CONFIG_HOME=$R/xdg/config XDG_DATA_HOME=$R/xdg/data XDG_CACHE_HOME=$R/xdg/cache XDG_STATE_HOME=$R/xdg/state TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/standup.db STANDUP_SQLITE_PATH=$R/standup.db KNOWLEDGE_DIR=$R/kb STANDUP_INTERNAL_ROOT=$R";
const SUITE = "$(git ls-files '*.test.ts' | grep -v e2e)";
const ONE = "packages/collector/src/floor/tree-deletes.test.ts";

/** The held command: `assign` sets R, `sep` joins the steps, `tests` names what bun runs. */
const run = (assign: string, sep = ";", tests = SUITE, vars = VARS) => `${assign}${sep} ${MKDIRS}${sep} env -i PATH="$PATH" ${vars} bun test ${tests}`;

/** The same run with every `$R` written out as `root`, no assignment. */
const literal = (root: string, sep = ";", tests = SUITE) => `${MKDIRS.replaceAll("$R", root)}${sep} env -i PATH="$PATH" ${VARS.replaceAll("$R", root)} bun test ${tests}`;

const MKTEMP = "R=$(mktemp -d -p /tmp land-XXXXXX)";

/** This checkout's own index, read as the fake worktree's. */
const REAL_INDEX = defaultProbes().gitIndex(REPO);

/** The index the fake worktree's repository has: this checkout's, with `extra` paths tracked too; null for none. */
let index: GitTree | null = REAL_INDEX;
const withPaths = (...extra: string[]): GitTree => ({ commit: "", entries: new Map([...REAL_INDEX!.entries, ...extra.map((p) => [p, { mode: "100644", oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" }] as const)]) });

/** `command` classified from `cwd`, the worktree's repository index as `index` holds it. */
function bash(command: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, { ...probes(), gitIndex: (dir) => (dir === ROOT ? index : null) });
}

/** A hold of `command`: its category and whether it is owner-reserved. */
function held(command: string, cwd = ROOT): { category: string; reserved: boolean } {
  const v = bash(command, cwd);
  expect({ command, action: v.action }).toEqual({ command, action: "hold" });
  if (v.action !== "hold") throw new Error("unreachable");
  return { category: v.category, reserved: !!v.ownerReserved };
}

/** Sets `name` in the classifying process's env, or removes it for undefined. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// mktemp's default dir comes from the classifying process's own TMPDIR, so the tests hand it the worker's.
let saved: Array<[string, string | undefined]> = [];
beforeEach(() => {
  saved = ["PATH", "TMPDIR"].map((n) => [n, process.env[n]]);
  process.env.PATH = LIVE_PATH;
  process.env.TMPDIR = WORKER_ENV.TMPDIR;
});
afterEach(() => {
  for (const [n, v] of saved) setEnv(n, v);
  LINKS.clear();
  index = REAL_INDEX;
});

describe("a whole-suite test run isolated under one /tmp root, from the worktree", () => {
  for (const sep of [";", " &&"]) {
    test(`the root from \`mktemp -d -p /tmp\`, \`${sep.trim()}\` between steps, one test file: no hold`, () => {
      expect(shape(bash(run(MKTEMP, sep, ONE), ROOT))).toEqual({ action: "allow" });
    });

    test(`the root from \`mktemp -d -p /tmp\`, \`${sep.trim()}\` between steps, a \`git ls-files\` listing: no hold`, () => {
      expect(shape(bash(run(MKTEMP, sep), ROOT))).toEqual({ action: "allow" });
    });

    test(`the root a literal /tmp dir named by R, \`${sep.trim()}\` between steps: no hold`, () => {
      expect(shape(bash(run("R=/tmp/land-abc123", sep, ONE), ROOT))).toEqual({ action: "allow" });
      expect(shape(bash(run("R=/tmp/land-abc123", sep), ROOT))).toEqual({ action: "allow" });
    });

    test(`every value written out under a literal /tmp dir, \`${sep.trim()}\` between steps: no hold`, () => {
      expect(shape(bash(literal("/tmp/land-abc123", sep, ONE), ROOT))).toEqual({ action: "allow" });
      expect(shape(bash(literal("/tmp/land-abc123", sep), ROOT))).toEqual({ action: "allow" });
    });
  }

  test("a listing cut short: no hold", () => {
    expect(shape(bash(run(MKTEMP, ";", "$(git ls-files '*.test.ts' | grep -v e2e | head -n 50)"), ROOT))).toEqual({ action: "allow" });
  });

  test("a git step that changes no files or refs before the run: no hold", () => {
    for (const step of ["git status --short", "git ls-files >/dev/null", "git rev-parse HEAD", "T=$(git ls-files '*.test.ts')"]) {
      expect({ step, verdict: shape(bash(run(`${MKTEMP}; ${step}`, ";", ONE), ROOT)) }).toEqual({ step, verdict: { action: "allow" } });
    }
  });

  test("`HOME=$R/home` after `R=$(mktemp -d -p /tmp …)` is read as the /tmp dir, not an unknown env value", () => {
    const reason = shape(bash(run(MKTEMP, ";", ONE), ROOT)).reason ?? "";
    expect(reason).not.toContain("hands `env`");
    expect(reason).not.toContain("so tools read their configuration from");
  });

  test("a mktemp template with a suffix after its X's, as GNU mktemp takes it, names a /tmp dir: no hold", () => {
    expect(shape(bash(run("R=$(mktemp -d -p /tmp land-XXXXXX.d)", ";", ONE), ROOT))).toEqual({ action: "allow" });
  });
});

describe("near the isolated run, the holds that stay", () => {
  test("mktemp -p a dir outside /tmp: held", () => {
    for (const assign of ["R=$(mktemp -d -p /fake/home land-XXXXXX)", `R=$(mktemp -d -p ${join(DATA, "x")} land-XXXXXX)`]) {
      expect({ assign, action: bash(run(assign, ";", ONE), ROOT).action }).toEqual({ assign, action: "hold" });
    }
  });

  test("mktemp -d without -p, under the worker's own TMPDIR in the real home: held", () => {
    expect(bash(run("R=$(mktemp -d)", ";", ONE), ROOT).action).toBe("hold");
  });

  test("R reassigned to the live data dir before the run: held", () => {
    const h = held(run(`${MKTEMP}; R=${join(DATA, "scratch")}`, ";", ONE), ROOT);
    expect(h.category).not.toBe("safe");
    const l = held(run(`R=/tmp/land-abc123 && R=${DATA}`, " &&", ONE), ROOT);
    expect(l.category).not.toBe("safe");
  });

  test("`cd $R` then relative values: held", () => {
    const vars = VARS.replaceAll("$R/", "./").replace("STANDUP_INTERNAL_ROOT=$R", "STANDUP_INTERNAL_ROOT=.");
    const command = `${MKTEMP}; ${MKDIRS}; cd $R; env -i PATH="$PATH" ${vars} bun test ${join(ROOT, ONE)}`;
    expect(bash(command, ROOT).action).toBe("hold");
  });

  test("a root under the live data dir (not a worktree): held", () => {
    const root = join(DATA, "land-abc123");
    expect(bash(run(`R=${root}`, ";", ONE), ROOT).action).toBe("hold");
    expect(bash(literal(root, ";", ONE), ROOT).action).toBe("hold");
  });

  test("a /tmp root that links into the live data dir: held", () => {
    LINKS.set("/tmp/land-abc123", join(DATA, "scratch-link"));
    expect(bash(run("R=/tmp/land-abc123", ";", ONE), ROOT).action).toBe("hold");
  });

  test("the same run from the install dir: held HIGH RISK", () => {
    const h = held(run(MKTEMP, ";", ONE), INSTALL);
    expect(h.reserved).toBe(true);
  });

  test("a git step that may write, or runs another program, before the run: held", () => {
    for (const step of [
      "git checkout -- README.md",
      "git -c core.fsmonitor='ln -s /tmp/elsewhere /tmp/land-floor/home' status",
      "git -c alias.ls='!ln -s /tmp/elsewhere /tmp/land-floor/home' ls",
      "git() { command git \"$@\"; }; git status",
      "date",
    ]) {
      expect({ step, action: bash(run(`${MKTEMP}; ${step}`, ";", ONE), ROOT).action }).toEqual({ step, action: "hold" });
    }
  });

  test("a mktemp template whose last X's are too few, or a suffix with --suffix as well: held", () => {
    for (const assign of ["R=$(mktemp -d -p /tmp land-XXXXXX.dX)", "R=$(mktemp -d -p /tmp --suffix=.e land-XXXXXX.d)", "R=$(mktemp -d -p /tmp land-XXXXXX/x)"]) {
      expect({ assign, action: bash(run(assign, ";", ONE), ROOT).action }).toEqual({ assign, action: "hold" });
    }
  });

  test("a root assigned only if a `cd` before it succeeds, then `;`: held (R may be empty)", () => {
    expect(bash(run(`cd ${ROOT} && ${MKTEMP}`, ";", ONE), ROOT).action).toBe("hold");
  });

  test("a listing whose index tracks a path bun or the shell may read as an option or a glob: held", () => {
    for (const path of ["--preload=./x.test.ts", "-r.test.ts", "packages/--env-file=.env.test.ts", "packages/a b.test.ts", "packages/*.test.ts", "packages/[a].test.ts"]) {
      index = withPaths(path);
      expect({ path, action: bash(run(MKTEMP), ROOT).action }).toEqual({ path, action: "hold" });
    }
  });

  test("a listing when the repository's index can't be read: held", () => {
    index = null;
    expect(bash(run(MKTEMP), ROOT).action).toBe("hold");
  });

  test("test files named by a substitution other than an index listing filtered by grep or head: held", () => {
    for (const tests of [
      "$(cat list)",
      "$(git ls-files '*.test.ts' | sed s/x/y/)",
      "$(git ls-files '*.test.ts' | xargs echo)",
      "$(git ls-files --others '*.test.ts' | grep -v e2e)",
      "$(git ls-files '*.test.ts' | grep -o test)",
      "$(git ls-files '*.test.ts' | grep -v e2e list)",
      "$(git ls-files '*.test.ts'; echo --preload=./x.ts)",
      "$(GIT_INDEX_FILE=/tmp/i git ls-files '*.test.ts')",
    ]) {
      expect({ tests, action: bash(run(MKTEMP, ";", tests), ROOT).action }).toEqual({ tests, action: "hold" });
    }
  });

  test("a listing after IFS or GIT_DIR is set, or with git a function: held", () => {
    for (const assign of [`${MKTEMP}; IFS=/`, `${MKTEMP}; export GIT_DIR=/tmp/g`, `git() { echo --preload=./x.ts; }; ${MKTEMP}`]) {
      expect({ assign, action: bash(run(assign), ROOT).action }).toEqual({ assign, action: "hold" });
    }
  });

  test("HOME the real home dir: held", () => {
    expect(bash(run(MKTEMP, ";", ONE, VARS.replace("HOME=$R/home", "HOME=/fake/home")), ROOT).action).toBe("hold");
  });
});
