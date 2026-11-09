/**
 * Preloaded into every `bun test` run (see the bunfig.toml files). Tests run
 * as the owner's Unix user on the machine that hosts the live Standup service,
 * so anything a test spawns — a git hook, a script, a restart path — could
 * reach the real service manager. This marks the process as a test run
 * (STANDUP_TEST=1) and puts a `systemctl` that always refuses first on PATH,
 * which every child process inherits. A test that needs to observe a
 * systemctl call puts its own stub ahead of this one.
 *
 * Every dir made here or by a fixture's testTempDir is removed when the run
 * ends, so a run leaves nothing behind in the temp dir.
 */

import { afterAll } from "bun:test";
import { chmodSync, writeFileSync } from "fs";
import { delimiter, join, resolve } from "path";
import { INHERITED_DB_PATH_ENV, scratchDataDirBase, sqliteFilePath } from "./packages/store/src/live-db-guard.ts";
import { removeTestTempDirs, testTempDir } from "./packages/collector/src/test-support/temp-dirs.ts";

process.env.STANDUP_TEST = "1";

// In a preload, afterAll runs once, after every test file.
afterAll(removeTestTempDirs);

const guardBin = testTempDir("standup-test-guard-");
const guard = join(guardBin, "systemctl");
writeFileSync(guard, `#!/bin/sh\necho "systemctl $* refused: tests must not reach the real service manager (STANDUP_TEST=1)" >&2\nexit 1\n`);
chmodSync(guard, 0o755);
process.env.PATH = `${guardBin}${delimiter}${process.env.PATH ?? ""}`;

// The data dir (dirname of DB_PATH) is always a scratch one, so what a test's
// launch writes under it (its review token file, say) never lands in the
// owner's. A DB_PATH inherited from a worker's env names the live DB wherever
// the owner keeps it, so it is recorded (absolute, and only by the outermost
// run, since a nested `bun test` inherits a scratch one) for createStore to
// refuse as well.
if (process.env.DB_PATH && !process.env[INHERITED_DB_PATH_ENV]) {
  const file = sqliteFilePath(process.env.DB_PATH);
  if (file) process.env[INHERITED_DB_PATH_ENV] = resolve(file);
}
process.env.DB_PATH = join(testTempDir("standup-test-data-", scratchDataDirBase("standup-test-data-")), "standup.db");

// Launch scratch dirs (each worker's TMPDIR) a test's launch makes go to a
// scratch root too, never the owner's ~/.cache/standup-scratch. Its name
// starts with `standup-scratch`, which scratchRoot requires of an override.
if (!process.env.STANDUP_SCRATCH_ROOT) process.env.STANDUP_SCRATCH_ROOT = testTempDir("standup-scratch-test-");
