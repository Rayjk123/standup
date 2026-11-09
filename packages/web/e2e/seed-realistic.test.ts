import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { realUnderTmp, refuseLiveInstall, refuseSymlink, requireOwnedDir, seedRealistic, NO_VOLUMES } from "./seed-realistic";

// Everything here lives in one temp dir under /tmp: a stand-in "live" data dir
// and a scratch dir beside it, linked to each other the ways a planted or
// leftover symlink could.
const root = mkdtempSync("/tmp/standup-seed-guard-");
const live = join(root, "live-home/.local/share/standup");
const scratch = join(root, "scratch");
mkdirSync(live, { recursive: true });
mkdirSync(join(scratch, "data"), { recursive: true });
writeFileSync(join(live, "standup.db"), "the live database");
const outside = mkdtempSync("/tmp/standup-seed-guard-outside-");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("the harness's path guards", () => {
  test("a path that resolves into the live data dir is refused, directly or through a symlink", () => {
    expect(() => refuseLiveInstall(join(live, "standup.db"), live)).toThrow(/live install/);
    expect(() => refuseLiveInstall(live, live)).toThrow(/live install/);
    // A HOME that holds the live data dir is refused too.
    expect(() => refuseLiveInstall(join(root, "live-home"), live)).toThrow(/live install/);
    symlinkSync(live, join(scratch, "linked-data"));
    expect(() => refuseLiveInstall(join(scratch, "linked-data/standup.db"), live)).toThrow(/live install/);
    expect(() => refuseLiveInstall(join(scratch, "data/standup.db"), live)).not.toThrow();
  });

  test("a scratch path is taken by its real location: a symlink out of /tmp is refused", () => {
    expect(realUnderTmp(join(scratch, "data/not-yet/made"))).toEndWith("/scratch/data/not-yet/made");
    symlinkSync("/", join(scratch, "to-root"));
    expect(() => realUnderTmp(join(scratch, "to-root/etc"))).toThrow(/outside/);
  });

  test("a symlink is refused where a file or directory of the run's own must be", () => {
    symlinkSync(outside, join(scratch, "linked-dir"));
    expect(() => refuseSymlink(join(scratch, "linked-dir"))).toThrow(/symlink/);
    expect(() => requireOwnedDir(join(scratch, "linked-dir"))).toThrow(/symlink/);
    expect(() => refuseSymlink(join(scratch, "nothing-here"))).not.toThrow();
    expect(() => requireOwnedDir(join(scratch, "data"))).not.toThrow();
  });

  test("the seeder refuses a database whose directory leads elsewhere, and deletes nothing there", () => {
    const db = join(outside, "standup.db");
    writeFileSync(db, "not the seeder's");
    symlinkSync(join(outside), join(scratch, "data-elsewhere"));
    expect(() => seedRealistic(join(scratch, "data-elsewhere/standup.db"), "me", NO_VOLUMES)).toThrow(/leads elsewhere/);
    expect(Bun.file(db).size).toBeGreaterThan(0);
  });
});
