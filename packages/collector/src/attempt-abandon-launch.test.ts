import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  createStore,
  upsertProject,
  getProject,
  getActiveTaskRunByWorktree,
  updateTaskRunStatus,
  getTaskRun,
} from "@standup/store";
import { launchSession, tmuxSessionExists } from "./launcher.js";

/**
 * A best-of-N loser can be picked-against — its still-`queued` run cancelled on
 * the ledger — while its launch is still provisioning, before its tmux pane has
 * spawned. The pick endpoint's stopLaunch finds no pane to kill, so the launcher
 * itself must not go on to spawn `claude`: otherwise a losing agent runs
 * unsupervised in a superseded worktree that nobody can stop, and the
 * `queued -> running` promotion throws an illegal `cancelled -> running`.
 *
 * This drives the REAL launchSession (through a `provision` command, so there is
 * NO git), cancels the run mid-provision, and asserts the launch is abandoned
 * without ever spawning a pane. `claude` is never invoked (no fake binary needed)
 * because the abort happens before the spawn.
 */

const cleanupDirs: string[] = [];
const originalEnv = {
  STANDUP_WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
  HOME: process.env.HOME,
};
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  if (originalEnv.STANDUP_WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = originalEnv.STANDUP_WORKTREE_ROOT;
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;
});

describe("launchSession — abandons a run cancelled while provisioning", () => {
  test("a run cancelled before its pane spawns is abandoned, not spawned", async () => {
    // A provision command that takes long enough for the cancel to land, then
    // produces the working dir launchSession expects at $STANDUP_WORKDIR.
    const binDir = await mkdtemp(join(tmpdir(), "standup-provision-"));
    cleanupDirs.push(binDir);
    const script = join(binDir, "provision.sh");
    await writeFile(script, '#!/bin/sh\nsleep 0.4\nmkdir -p "$STANDUP_WORKDIR"\n');
    await chmod(script, 0o755);

    const worktreeRoot = await mkdtemp(join(tmpdir(), "standup-abandon-root-"));
    cleanupDirs.push(worktreeRoot);
    process.env.STANDUP_WORKTREE_ROOT = worktreeRoot;
    // Redirect the folder-trust write (~/.claude.json) into a throwaway home.
    const fakeHome = await mkdtemp(join(tmpdir(), "standup-abandon-home-"));
    cleanupDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    const store = createStore(":memory:");
    upsertProject(store.db, {
      id: "p",
      name: "p",
      branch: "main",
      repos: [],
      provision: `sh ${script}`,
    });
    const project = getProject(store.db, "p")!;

    const { launch, done } = await launchSession(store.db, {
      project,
      task: "do the thing",
      label: "attempt 1/2",
      attemptGroup: "grp-abandon",
    });

    // The ledger run exists and is queued the instant launchSession returns
    // (provisioning is still running). Cancel it — the pick-against — before the
    // launcher reaches the spawn. Synchronous, so `done` can't advance first.
    const run = getActiveTaskRunByWorktree(store.db, launch.worktreePath);
    expect(run).not.toBeNull();
    updateTaskRunStatus(store.db, run!.id, "cancelled");

    await done;

    // The launch was abandoned rather than promoted to running, and never spawned
    // a pane — so no losing agent is left running.
    const row = store.db
      .query("SELECT status, error FROM launches WHERE id = ?")
      .get(launch.id) as { status: string; error: string | null };
    expect(row.status).toBe("failed");
    expect(row.error ?? "").toMatch(/abandoning this launch|Superseded/i);
    expect(tmuxSessionExists(launch.tmuxSession ?? "")).toBe(false);

    // The run stays cancelled — the illegal cancelled -> running transition the
    // old code hit never happens.
    expect(getTaskRun(store.db, run!.id)?.status).toBe("cancelled");
  });
});
