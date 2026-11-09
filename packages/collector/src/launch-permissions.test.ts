import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject, getLaunch } from "@standup/store";
import type { HarnessId, Project } from "@standup/shared";
import {
  launchSession,
  LaunchPermissionError,
  type SpawnArgvSpec,
} from "./launcher.js";
import { DEFAULT_SHARED_BRANCHES } from "./floor/gate.js";

/**
 * launchSession resolves each Claude launch's permission posture (bypass behind
 * the safety floor by default; the project or the launch may opt out) and threads
 * it to the spawn seam, recording the posture in the launch log. The spawn seam
 * is stubbed, so no agent is spawned; the floor's installability check is
 * injected so the real box's Claude settings don't decide the outcome.
 */

const dirs: string[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  WORKTREE_ROOT: process.env.STANDUP_WORKTREE_ROOT,
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  if (savedEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = savedEnv.HOME;
  if (savedEnv.WORKTREE_ROOT === undefined) delete process.env.STANDUP_WORKTREE_ROOT;
  else process.env.STANDUP_WORKTREE_ROOT = savedEnv.WORKTREE_ROOT;
});

async function scratchStore(overrides: Partial<Project> = {}) {
  const root = await mkdtemp(join(tmpdir(), "standup-perm-root-"));
  dirs.push(root);
  process.env.STANDUP_WORKTREE_ROOT = root;
  const home = await mkdtemp(join(tmpdir(), "standup-perm-home-"));
  dirs.push(home);
  process.env.HOME = home;

  const store = createStore(":memory:");
  const project: Project = {
    id: `perm-${randomUUID().slice(0, 8)}`,
    name: "P",
    branch: "trunk-of-p",
    repos: [],
    ...overrides,
  };
  upsertProject(store.db, project);
  return { store, project };
}

function seam(floorUnavailable?: string) {
  const calls: { harness: HarnessId; spec: SpawnArgvSpec }[] = [];
  return {
    calls,
    deps: {
      buildSpawnArgv: (harness: HarnessId, spec: SpawnArgvSpec): string[] => {
        calls.push({ harness, spec });
        return ["true"];
      },
      deliverPrompt: async () => {},
      floorUnavailable: () => floorUnavailable,
    },
  };
}

/** The launch row's log text. */
function launchLog(store: ReturnType<typeof createStore>, id: string): string {
  return getLaunch(store.db, id)?.log ?? "";
}

describe("launchSession — permission posture", () => {
  test("a default launch bypasses behind a floor configured for its worktree", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = seam();
    const result = await launchSession(store.db, { project, task: "do it" }, undefined, undefined, deps);
    await result.done;

    const permissions = calls[0].spec.permissions!;
    expect(permissions.bypassPermissions).toBe(true);
    expect(permissions.source).toBe("default");
    expect(permissions.floorUnavailable).toBeUndefined();
    expect(permissions.floor?.launchId).toBe(result.launch.id);
    expect(permissions.floor?.root).toBe(realpathSync(result.launch.worktreePath));
    expect(permissions.floor?.sharedBranches).toEqual([...DEFAULT_SHARED_BRANCHES, "trunk-of-p"]);
    expect(launchLog(store, result.launch.id)).toContain("permissions: bypassed (safety floor on)");
    expect(getLaunch(store.db, result.launch.id)?.status).toBe("running");
    store.close();
  });

  test("a project that opted out runs auto, and the log says so", async () => {
    const { store, project } = await scratchStore({ bypassPermissions: false });
    const { calls, deps } = seam();
    const result = await launchSession(store.db, { project, task: "do it" }, undefined, undefined, deps);
    await result.done;

    expect(calls[0].spec.permissions?.bypassPermissions).toBe(false);
    expect(launchLog(store, result.launch.id)).toContain("permissions: auto (project opted out)");
    store.close();
  });

  test("the per-launch override wins both ways", async () => {
    const off = await scratchStore();
    const offSeam = seam();
    const r1 = await launchSession(
      off.store.db,
      { project: off.project, task: "do it", bypassPermissions: false },
      undefined,
      undefined,
      offSeam.deps
    );
    await r1.done;
    expect(offSeam.calls[0].spec.permissions?.bypassPermissions).toBe(false);
    expect(launchLog(off.store, r1.launch.id)).toContain("permissions: auto (this launch opted out)");
    off.store.close();

    const on = await scratchStore({ bypassPermissions: false });
    const onSeam = seam();
    const r2 = await launchSession(
      on.store.db,
      { project: on.project, task: "do it", bypassPermissions: true },
      undefined,
      undefined,
      onSeam.deps
    );
    await r2.done;
    expect(onSeam.calls[0].spec.permissions?.bypassPermissions).toBe(true);
    expect(onSeam.calls[0].spec.permissions?.source).toBe("launch");
    on.store.close();
  });

  test("a floor that can't be installed falls back to auto and logs why", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = seam("~/.claude/settings.json sets disableAllHooks: true");
    const result = await launchSession(store.db, { project, task: "do it" }, undefined, undefined, deps);
    await result.done;

    expect(calls[0].spec.permissions?.floorUnavailable).toContain("disableAllHooks");
    const log = launchLog(store, result.launch.id);
    expect(log).toContain("[warn] permissions: auto");
    expect(log).toContain("disableAllHooks");
    expect(getLaunch(store.db, result.launch.id)?.status).toBe("running");
    store.close();
  });

  test("a launchArgs bypass the floor can't guard fails the launch", async () => {
    const { store, project } = await scratchStore({ launchArgs: "--dangerously-skip-permissions" });
    const { calls, deps } = seam("hook missing");
    const result = await launchSession(store.db, { project, task: "do it" }, undefined, undefined, deps);
    await result.done;

    expect(calls).toHaveLength(0);
    const row = getLaunch(store.db, result.launch.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Refusing to launch");
    store.close();
  });

  test("launchArgs that bypass and pass --settings are refused before any launch row exists", async () => {
    const { store, project } = await scratchStore({
      launchArgs: "--permission-mode bypassPermissions --settings /tmp/mine.json",
    });
    const { calls, deps } = seam();
    await expect(launchSession(store.db, { project, task: "do it" }, undefined, undefined, deps)).rejects.toBeInstanceOf(
      LaunchPermissionError
    );
    expect(calls).toHaveLength(0);
    store.close();
  });

  test("a codex launch takes no Claude permission posture", async () => {
    const { store, project } = await scratchStore();
    const { calls, deps } = seam();
    const result = await launchSession(
      store.db,
      { project, task: "do it", harness: "codex" },
      undefined,
      undefined,
      deps
    );
    await result.done;

    expect(calls[0].harness).toBe("codex");
    expect(calls[0].spec.permissions).toBeUndefined();
    expect(launchLog(store, result.launch.id)).not.toContain("permissions:");
    store.close();
  });
});
