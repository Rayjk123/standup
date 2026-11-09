import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "path";
import { classifyToolCall } from "./classify.js";
import type { FloorVerdict } from "./gate.js";
import { COLLECTOR, LIVE_PATH, ROOT, VIRTUAL, config, probes, shape } from "./scratch-harness.js";

/*
 * A test run under `env -i` with every dir it is handed under one /tmp root,
 * the worker's own PATH handed on as `PATH="$PATH"`. The floor reads the test
 * files the runner executes; a `git commit` one of them runs in a directory
 * the floor can't follow to a temp dir is read as running where the runner
 * starts, so the checkout's branch decides it. The hold reason
 * "`git commit` changes the shared branch mainline" (step `git commit -q -m`)
 * is knowledge-staleness.test.ts's `commit(repo, …)` helper, read so on a
 * checkout on mainline; a plan-gate-floor.test.ts criterion test classifies
 * that suite against the real checkout and prints it there.
 */

setDefaultTimeout(120_000);

const VARS =
  "HOME=$R/home XDG_CONFIG_HOME=$R/cfg XDG_DATA_HOME=$R/data XDG_CACHE_HOME=$R/cache XDG_STATE_HOME=$R/state XDG_RUNTIME_DIR=$R/run TMPDIR=$R/tmp TMP=$R/tmp TEMP=$R/tmp DB_PATH=$R/db.sqlite STANDUP_SQLITE_PATH=$R/db.sqlite KNOWLEDGE_DIR=$R/kn STANDUP_INTERNAL_ROOT=$R/int";

/** `file` run by `bun test` under `env -i`, every dir under a fresh /tmp root. */
const isolated = (file: string) => `R=$(mktemp -d -p /tmp) && env -i USER=$USER PATH="$PATH" ${VARS} bun test ${file} 2>&1 | tail -8`;

/** `command` classified from the worktree root, with every repository read as on `branch`. */
function onBranch(command: string, branch: string, cwd = ROOT): FloorVerdict {
  return classifyToolCall({ toolName: "Bash", toolInput: { command }, cwd }, config, { ...probes(), gitBranch: () => branch });
}

/** A test file whose commit helper is handed the directory the runner starts in, not a temp dir. */
const ROOT_COMMIT_TEST = join(COLLECTOR, "src", "item3-root-commit.test.ts");
const ROOT_COMMIT = `import { test } from "bun:test";
function commit(repo: string, file: string): void {
  Bun.spawnSync(["git", "add", "."], { cwd: repo });
  Bun.spawnSync(["git", "commit", "-q", "-m", \`update \${file}\`], { cwd: repo });
}
test("commits", () => {
  commit(process.cwd(), "a.txt");
});
`;

let path: string | undefined;
beforeEach(() => {
  path = process.env.PATH;
  process.env.PATH = LIVE_PATH;
  VIRTUAL[ROOT_COMMIT_TEST] = ROOT_COMMIT;
});
afterEach(() => {
  process.env.PATH = path;
  delete VIRTUAL[ROOT_COMMIT_TEST];
});

describe("an isolated test run is labeled from its own command, not from an acceptance criterion", () => {
  test("the recorded criterion's own test file, run isolated from a feature-branch worktree: no hold", () => {
    expect(onBranch(isolated("packages/collector/src/plan-gate-floor.test.ts"), "standup/feat-1")).toEqual({ action: "allow" });
  });

  test("knowledge-staleness.test.ts, run isolated from a feature-branch worktree: no hold", () => {
    expect(onBranch(isolated("packages/collector/src/knowledge-staleness.test.ts"), "standup/feat-1")).toEqual({ action: "allow" });
  });

  test("knowledge-staleness.test.ts, run isolated from a checkout on mainline: its fixture repo's commit is no commit to mainline", () => {
    expect(shape(onBranch(isolated("packages/collector/src/knowledge-staleness.test.ts"), "mainline"))).toEqual({ action: "allow" });
  });
});

describe("a commit that does land on a shared branch stays held", () => {
  test("`git commit` on a checkout on mainline: held outward, labeled so", () => {
    expect(shape(onBranch("git commit -am x", "mainline"))).toEqual({
      action: "hold",
      category: "outward",
      reserved: false,
      reason: "`git commit` changes the shared branch mainline",
    });
  });

  test("`git commit` under `env -i` with a /tmp root, on a checkout on mainline: held outward", () => {
    const v = shape(onBranch(`R=$(mktemp -d -p /tmp) && env -i PATH="$PATH" ${VARS} git commit -am x`, "mainline"));
    expect({ action: v.action, category: v.category, reason: v.reason }).toEqual({
      action: "hold",
      category: "outward",
      reason: "`git commit` changes the shared branch mainline",
    });
  });

  test("an isolated run of a test file whose commit helper is handed the runner's own dir, on a checkout on mainline: held outward", () => {
    const v = shape(onBranch(isolated("packages/collector/src/item3-root-commit.test.ts"), "mainline"));
    expect({ action: v.action, category: v.category, reason: v.reason }).toEqual({
      action: "hold",
      category: "outward",
      reason: "`git commit` changes the shared branch mainline",
    });
  });

  test("the same test file from a feature-branch worktree: no hold", () => {
    expect(onBranch(isolated("packages/collector/src/item3-root-commit.test.ts"), "standup/feat-1")).toEqual({ action: "allow" });
  });
});
