import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "../../../..");

/** A test file that builds test-world fixtures (worlds, screenshots, plain repos). */
const IMPORTS_TEST_WORLD = /from "(?:\.\.?\/)+(?:pipeline\/)?test-world\.js"/;

/**
 * Suites whose fixtures make temp dirs: the Slack bridge's state files, every
 * test-world suite and the review-tunnel harness's worktrees. The bridge runs
 * first so a store save debounced past its `afterAll` still fires while the
 * later suites run, and shows up as a leftover dir.
 */
function fixtureSuites(): string[] {
  const worlds = [...new Bun.Glob("packages/collector/src/**/*.test.ts").scanSync(REPO)].filter((f) =>
    IMPORTS_TEST_WORLD.test(readFileSync(join(REPO, f), "utf8"))
  );
  return ["packages/slack/src/persona-bridge.test.ts", ...worlds.sort(), "packages/collector/src/review-tunnel/manager.test.ts"];
}

/** tmux's socket-path ceiling, which scratchDataDirBase keeps the child's data dir under. */
const SUN_PATH_MAX = 103;

/**
 * The child run's temp dir: short enough that the child's preload puts its
 * scratch data dir (`standup-test-data-XXXXXX/tmux/workers`) inside it rather
 * than falling back to /tmp, where a leak would go unseen.
 */
function runTempDir(): string {
  const base = join(tmpdir(), "standup-lg-XXXXXX", "standup-test-data-XXXXXX", "tmux", "workers").length <= SUN_PATH_MAX ? tmpdir() : "/tmp";
  return mkdtempSync(join(base, "standup-lg-"));
}

/**
 * Entries host tools write into whatever TMPDIR a process inherits, not made
 * by any fixture: the MCS session client's telemetry logs and the Go Snowflake
 * driver's cgo dirs, from host binaries the suites' child processes run.
 */
const HOST_TOOL_ENTRIES = [/^mcs-telemetry-.*\.log$/, /^gosnowflake-cgo/];

/** What is left in `dir` that a fixture could have made. */
function fixtureLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => !HOST_TOOL_ENTRIES.some((re) => re.test(name)));
}

describe("the fixture suites, in a fresh temp dir", () => {
  const runTmp = runTempDir();
  afterAll(() => rmSync(runTmp, { recursive: true, force: true }));

  test(
    "pass and leave nothing of theirs in the temp dir",
    () => {
      const suites = fixtureSuites();
      expect(suites.length).toBeGreaterThan(10);
      // Without an inherited scratch root the child's preload makes its own in runTmp, so a leak there counts too.
      const { STANDUP_SCRATCH_ROOT: _inherited, ...env } = process.env;
      const proc = Bun.spawnSync([process.execPath, "test", ...suites.map((s) => `./${s}`)], {
        cwd: REPO,
        env: { ...env, TMPDIR: runTmp, TMP: runTmp, TEMP: runTmp },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 540_000,
      });
      expect({ exitCode: proc.exitCode, tail: proc.stderr.toString().slice(-2000) }).toMatchObject({ exitCode: 0 });
      expect(fixtureLeftovers(runTmp)).toEqual([]);
    },
    600_000
  );
});
