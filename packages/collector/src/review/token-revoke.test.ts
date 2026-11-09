import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLaunch, createStore, getLaunch, getLaunchReviewTokenHash, upsertProject } from "@standup/store";
import { cleanupLaunch } from "../launcher.js";
import { FakeProcessSystem } from "../process-registry-fake.js";
import { issueReviewToken } from "./token-file.js";

/*
 * Cleaning up a launch revokes its review token: the hash on its row is
 * forgotten and the token file is removed from the data dir it was issued
 * under, not the process default.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("cleaning up a launch", () => {
  test("forgets its review token hash and removes its token file from the data dir it was issued under", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "review-revoke-"));
    dirs.push(dataDir);
    const { db } = createStore(":memory:");
    upsertProject(db, { id: "p", name: "P", branch: "main", repos: [] });
    createLaunch(db, { id: "L1", kind: "adopted", projectId: "p", task: "t", worktreePath: dataDir, branch: "b", status: "running" });
    const file = issueReviewToken(db, dataDir, "L1");
    expect(existsSync(file)).toBe(true);
    expect(getLaunchReviewTokenHash(db, "L1")).not.toBeNull();

    const launch = getLaunch(db, "L1")!;
    const ran: string[][] = [];
    await cleanupLaunch(db, launch, { id: "p", name: "P", branch: "main", repos: [] } as never, {
      dataDir,
      processSystem: new FakeProcessSystem(),
      scratchRoot: join(dataDir, "standup-scratch"),
      run: async (cmd) => {
        ran.push(cmd);
        return { ok: true, output: "" };
      },
    });

    expect(getLaunchReviewTokenHash(db, "L1")).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(getLaunch(db, "L1")!.status).toBe("cleaned");
  });
});
