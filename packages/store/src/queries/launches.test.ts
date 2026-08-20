import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../store.js";
import {
  upsertProject,
  createLaunch,
  findLaunchByCwd,
  getLaunch,
  setLaunchPhase,
  appendLaunchLog,
  updateLaunchStatus,
} from "../index.js";

/**
 * Launch attachment has to survive symlinked worktree roots the same way
 * project matching does: a launch's worktree_path is stored from the
 * configured root (e.g. `~/workplace/...`) while the SessionStart hook reports
 * the OS-resolved realpath (e.g. `/Volumes/workplace/...` when that root is a
 * symlinked mount). A literal prefix compare treats those as different trees,
 * so the session never attaches and the launch is stranded sessionless,
 * rendering forever as "provisioning workspace…" — the bug these tests pin.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function symlinkedWorktree() {
  const base = await mkdtemp(join(tmpdir(), "standup-launch-"));
  dirs.push(base);
  const real = join(base, "real");
  await mkdir(join(real, "wt", "src", "Pkg"), { recursive: true });
  const link = join(base, "link");
  await symlink(real, link);
  // real/wt reached two ways: canonical, and via the symlinked parent.
  return {
    canonicalWt: join(real, "wt"),
    viaLinkWt: join(link, "wt"),
    canonicalSubdir: join(real, "wt", "src", "Pkg"),
  };
}

function launch(id: string, worktreePath: string) {
  return {
    id,
    projectId: "p",
    task: "t",
    worktreePath,
    branch: "main",
  };
}

describe("findLaunchByCwd across a symlinked worktree root", () => {
  test("matches when worktree_path is stored via a symlink and the cwd is canonical", async () => {
    const { canonicalWt, viaLinkWt } = await symlinkedWorktree();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, launch("L1", viaLinkWt));

    expect(findLaunchByCwd(store.db, canonicalWt)?.id).toBe("L1");
  });

  test("matches a launchSubdir cwd reported under the resolved realpath", async () => {
    const { viaLinkWt, canonicalSubdir } = await symlinkedWorktree();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // Stored via symlink; hook reports the deep realpath (worktree + subdir).
    createLaunch(store.db, launch("L1", viaLinkWt));

    expect(findLaunchByCwd(store.db, canonicalSubdir)?.id).toBe("L1");
  });

  test("does not match a sibling worktree sharing a string prefix", async () => {
    const { canonicalWt } = await symlinkedWorktree();
    const sibling = `${canonicalWt}-other`;
    await mkdir(sibling, { recursive: true });
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, launch("L1", canonicalWt));

    expect(findLaunchByCwd(store.db, sibling)).toBeNull();
  });
});

describe("launch provisioning progress", () => {
  function seed() {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    createLaunch(store.db, {
      id: "L1",
      projectId: "p",
      task: "t",
      worktreePath: "/tmp/L1",
      branch: "main",
      provisioned: true,
    });
    return store;
  }

  test("setLaunchPhase records the current phase", () => {
    const store = seed();
    setLaunchPhase(store.db, "L1", "building");
    expect(getLaunch(store.db, "L1")?.phase).toBe("building");
  });

  test("appendLaunchLog accumulates streamed output", () => {
    const store = seed();
    appendLaunchLog(store.db, "L1", "line one\n");
    appendLaunchLog(store.db, "L1", "line two\n");
    expect(getLaunch(store.db, "L1")?.log).toBe("line one\nline two\n");
  });

  test("a terminal status clears the phase", () => {
    const store = seed();
    setLaunchPhase(store.db, "L1", "starting");
    updateLaunchStatus(store.db, "L1", "running");
    expect(getLaunch(store.db, "L1")?.phase).toBeUndefined();
    expect(getLaunch(store.db, "L1")?.status).toBe("running");
  });
});
