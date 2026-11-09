import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { COLLECTOR, DATA, LINKS, LIVE_PATH, MIRRORS, ROOT, VIRTUAL, bash, held } from "./scratch-harness.js";

/*
 * A test run under `env -i` with every dir it is handed under one /tmp root
 * named by a shell variable, and the worker's own PATH handed on as
 * `PATH="$PATH"`, run from a worker's worktree with the fake install swapped
 * in. The worker's PATH has the real shape (scratch-harness's
 * LIVE_PATH): the install's node_modules/.bin dirs, and the install's
 * packages/node_modules/.bin, which doesn't exist. `"$PATH"` expands to the
 * classifying process's own PATH, so the tests hand it that one.
 */

setDefaultTimeout(120_000);

const VARS =
  "HOME=$R/home XDG_CONFIG_HOME=$R/cfg XDG_DATA_HOME=$R/data XDG_CACHE_HOME=$R/cache XDG_STATE_HOME=$R/state XDG_RUNTIME_DIR=$R/run TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/db.sqlite STANDUP_SQLITE_PATH=$R/db.sqlite KNOWLEDGE_DIR=$R/kn STANDUP_INTERNAL_ROOT=$R/int";
const RAM_TEST = join(COLLECTOR, "src", "persona", "commands", "ram.test.ts");
/** Another worktree under the fake data dir, the cwd of the runs from the worktree root. */
const RAM_ROOT = join(DATA, "worktrees", "standup", "ram-command-6f71e1");

/** The test run from packages/collector, with the root assigned as `assign` says. */
const fromPackage = (assign: string) =>
  `cd ${COLLECTOR} && ${assign} && env -i USER=$USER PATH="$PATH" ${VARS} bun test src/persona/commands/ram.test.ts 2>&1 | tail -8`;

let path: string | undefined;
beforeEach(() => {
  path = process.env.PATH;
  process.env.PATH = LIVE_PATH;
  const ram = `import { expect, test } from "bun:test";\ntest("ram", () => { expect(1 + 1).toBe(2); });\n`;
  VIRTUAL[RAM_TEST] = ram;
  MIRRORS.add(RAM_ROOT);
  VIRTUAL[join(RAM_ROOT, ".git")] = "gitdir: /fake/install/.git/worktrees/ram-command-6f71e1\n";
  VIRTUAL[join(RAM_ROOT, RAM_TEST.slice(ROOT.length + 1))] = ram;
});
afterEach(() => {
  process.env.PATH = path;
  delete VIRTUAL[RAM_TEST];
  delete VIRTUAL[join(RAM_ROOT, ".git")];
  delete VIRTUAL[join(RAM_ROOT, RAM_TEST.slice(ROOT.length + 1))];
  MIRRORS.clear();
  LINKS.clear();
});

describe("an isolated test run whose root is a shell variable, with the worker's own PATH", () => {
  test("from packages/collector, the root a literal mktemp name: no hold", () => {
    expect(bash(fromPackage("R=/tmp/tmp.DG0f5zRSqi"), ROOT)).toEqual({ action: "allow" });
  });

  test("from the worktree root, a root of another name, a grep after it: no hold", () => {
    const command = `R=/tmp/ram-test.3Wjcdx && env -i USER=alice PATH="$PATH" ${VARS} bun test packages/collector/src/persona/commands/ram.test.ts 2>&1 | grep -E "pass|fail"`;
    expect(bash(command, ROOT)).toEqual({ action: "allow" });
  });

  test("the root made by mktemp under an explicit /tmp: no hold", () => {
    for (const assign of ["R=$(mktemp -d -p /tmp)", "R=$(mktemp -d /tmp/x.XXXXXX)"]) {
      expect({ assign, verdict: bash(fromPackage(assign), ROOT) }).toEqual({ assign, verdict: { action: "allow" } });
    }
  });

  test("a root of /tmp itself, or one the floor can't read: held", () => {
    for (const assign of ["R=/tmp", "R=$(cat /tmp/where)", "R=/tmp/tmp.A1 && R=$(cat /tmp/where)"]) {
      const h = held(fromPackage(assign), ROOT);
      expect({ assign, category: h.category }).toEqual({ assign, category: "unclassified" });
    }
  });

  test("a root reassigned into the live data dir, or one that links there: held", () => {
    const h = held(fromPackage(`R=/tmp/tmp.A1 && R=${join(DATA, "x")}`), ROOT);
    expect(h.category).toBe("standup-ops");
    LINKS.set("/tmp/tmp.DG0f5zRSqi", join(DATA, "scratch-link"));
    expect(held(fromPackage("R=/tmp/tmp.DG0f5zRSqi"), ROOT).category).toBe("standup-ops");
  });

  test("ask from ram-command: a floor test file run with -t, a grep after it: no hold; HOME=/home/alice: held", () => {
    const command = `R=/tmp/ram-test.3Wjcdx && env -i USER=alice PATH="$PATH" ${VARS} bun test packages/collector/src/floor/false-holds-round-7-item10.test.ts -t "inline after a full isolation" 2>&1 | grep -E "^ *[0-9]+ (pass|fail)"`;
    expect(bash(command, RAM_ROOT)).toEqual({ action: "allow" });
    expect(held(command.replace("HOME=$R/home", "HOME=/home/alice"), RAM_ROOT).category).toBe("unclassified");
  });

  test("ask from ram-command: the root made by mktemp -p /tmp with a template, `;` between steps, brace-expanded mkdir: no hold", () => {
    const command = `R=$(mktemp -d -p /tmp imp.XXXX); mkdir -p $R/{home,cfg,data,cache,state,run,tmp,kn,int}; env -i PATH="$PATH" HOME=$R/home USER=$USER ${VARS.replace("HOME=$R/home ", "")} bun test packages/collector/src/persona/commands/ram.test.ts`;
    expect(command).toBe(
      'R=$(mktemp -d -p /tmp imp.XXXX); mkdir -p $R/{home,cfg,data,cache,state,run,tmp,kn,int}; env -i PATH="$PATH" HOME=$R/home USER=$USER XDG_CONFIG_HOME=$R/cfg XDG_DATA_HOME=$R/data XDG_CACHE_HOME=$R/cache XDG_STATE_HOME=$R/state XDG_RUNTIME_DIR=$R/run TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/db.sqlite STANDUP_SQLITE_PATH=$R/db.sqlite KNOWLEDGE_DIR=$R/kn STANDUP_INTERNAL_ROOT=$R/int bun test packages/collector/src/persona/commands/ram.test.ts',
    );
    expect(bash(command, RAM_ROOT)).toEqual({ action: "allow" });
    for (const variant of [command.replace("HOME=$R/home", "HOME=/home/alice"), command.replace("-p /tmp", "-p /home/alice")]) {
      expect({ variant, category: held(variant, RAM_ROOT).category }).toEqual({ variant, category: "unclassified" });
    }
  });

  test("the same run from the install: HIGH RISK", () => {
    const h = held(fromPackage("R=/tmp/tmp.DG0f5zRSqi").replace(`cd ${COLLECTOR}`, "cd /fake/install/packages/collector"), ROOT);
    expect({ category: h.category, reserved: h.reserved }).toEqual({ category: "floor-tamper", reserved: true });
  });
});
