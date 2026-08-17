import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../store.js";
import { upsertProject, findProjectByCwd, createSession, rehomeScratchSessions } from "../index.js";

/**
 * Project matching has to survive symlinked paths: a repo configured as
 * `~/ax-workplace/foo` can be reported by a session as `/Volumes/.../foo`
 * when `~/ax-workplace` is a symlink to the volume. A literal prefix compare
 * treats those as different trees and drops the session into scratch — the
 * bug these tests pin down.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function symlinkedRepo() {
  const base = await mkdtemp(join(tmpdir(), "standup-proj-"));
  dirs.push(base);
  const real = join(base, "real");
  await mkdir(join(real, "repo"), { recursive: true });
  const link = join(base, "link");
  await symlink(real, link);
  // `real/repo` reached two ways: canonical, and via the symlinked parent.
  return { canonical: join(real, "repo"), viaLink: join(link, "repo") };
}

describe("findProjectByCwd across a symlinked path", () => {
  test("matches when the repo is configured via a symlink and the cwd is canonical", async () => {
    const { canonical, viaLink } = await symlinkedRepo();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [viaLink] });

    expect(findProjectByCwd(store.db, canonical)?.id).toBe("p");
  });

  test("matches when the repo is canonical and the cwd comes in via the symlink", async () => {
    const { canonical, viaLink } = await symlinkedRepo();
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [canonical] });

    expect(findProjectByCwd(store.db, viaLink)?.id).toBe("p");
  });

  test("matches a nested subdirectory of the repo, not a sibling with a shared prefix", async () => {
    const { canonical } = await symlinkedRepo();
    // Both dirs exist on disk, the way a real session's cwd always does.
    await mkdir(join(canonical, "src"), { recursive: true });
    const sibling = `${canonical}-other`;
    await mkdir(sibling, { recursive: true });

    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [canonical] });

    // Inside the repo → match. The sibling shares a string prefix but is a
    // different directory → no match (segment-aware).
    expect(findProjectByCwd(store.db, join(canonical, "src"))?.id).toBe("p");
    expect(findProjectByCwd(store.db, sibling)).toBeNull();
  });

  test("rehomeScratchSessions moves a symlink-aliased scratch session into the project", async () => {
    const { canonical, viaLink } = await symlinkedRepo();
    const store = createStore(":memory:");
    // scratch must exist first — sessions.project_id is a real FK.
    upsertProject(store.db, { id: "scratch", name: "scratch", branch: "main", repos: [] });
    const project = { id: "p", name: "p", branch: "main", repos: [viaLink] };
    upsertProject(store.db, project);

    createSession(store.db, {
      id: "s1",
      projectId: "scratch",
      title: "",
      cwd: canonical,
      status: "running",
    });

    const moved = rehomeScratchSessions(store.db, project);
    expect(moved).toEqual(["s1"]);
  });
});
