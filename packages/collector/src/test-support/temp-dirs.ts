import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Temp dirs made for a whole test run, by a shared fixture whose callers get
 * no teardown (a world built per test and dropped), or by a test with no
 * teardown of its own. test-guard.ts, preloaded into every `bun test` run,
 * removes them all in a run-wide `afterAll`, so none outlives the run.
 */
const made: string[] = [];

/** A fresh `<prefix>XXXXXX` dir under `parent` (the temp dir by default), removed when the test run ends. */
export function testTempDir(prefix: string, parent: string = tmpdir()): string {
  const dir = mkdtempSync(join(parent, prefix));
  made.push(dir);
  return dir;
}

/** Removes every dir testTempDir made. */
export function removeTestTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
