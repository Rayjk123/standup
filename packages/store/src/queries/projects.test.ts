import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, symlink, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createStore } from "../store.js";
import {
  upsertProject,
  findProjectByCwd,
  createSession,
  rehomeScratchSessions,
  getProject,
  getKnowledgeDefaultScope,
  KNOWLEDGE_DEFAULT_SCOPE_KEY,
  setSetting,
} from "../index.js";

/**
 * Project matching has to survive symlinked paths: a repo configured as
 * `~/code/foo` can be reported by a session as `/Volumes/.../foo`
 * when `~/code` is a symlink to the volume. A literal prefix compare
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

describe("project harness selection", () => {
  test("harness round-trips; unset reads back as claude (undefined)", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "cx", name: "cx", branch: "main", repos: [], harness: "codex" });
    upsertProject(store.db, { id: "cl", name: "cl", branch: "main", repos: [] });

    expect(getProject(store.db, "cx")?.harness).toBe("codex");
    expect(getProject(store.db, "cl")?.harness).toBeUndefined();
  });
});

describe("project permission bypass", () => {
  test("bypassPermissions round-trips; unset is stored and read back as on", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "off", name: "off", branch: "main", repos: [], bypassPermissions: false });
    upsertProject(store.db, { id: "on", name: "on", branch: "main", repos: [], bypassPermissions: true });
    upsertProject(store.db, { id: "unset", name: "unset", branch: "main", repos: [] });

    expect(getProject(store.db, "off")?.bypassPermissions).toBe(false);
    expect(getProject(store.db, "on")?.bypassPermissions).toBe(true);
    expect(getProject(store.db, "unset")?.bypassPermissions).toBe(true);
    const raw = store.db
      .query("SELECT id, bypass_permissions AS b FROM projects WHERE id IN ('off', 'unset') ORDER BY id")
      .all() as { id: string; b: number }[];
    expect(raw).toEqual([
      { id: "off", b: 0 },
      { id: "unset", b: 1 },
    ]);
  });

  test("a row written without the column (an existing project) defaults to on; an opt-out can be cleared", () => {
    const store = createStore(":memory:");
    store.db.run(
      "INSERT INTO projects (id, name, branch, repos_json) VALUES ('legacy', 'legacy', 'main', '[]')"
    );
    expect(getProject(store.db, "legacy")?.bypassPermissions).toBe(true);

    upsertProject(store.db, { ...getProject(store.db, "legacy")!, bypassPermissions: false });
    expect(getProject(store.db, "legacy")?.bypassPermissions).toBe(false);
    upsertProject(store.db, { ...getProject(store.db, "legacy")!, bypassPermissions: true });
    expect(getProject(store.db, "legacy")?.bypassPermissions).toBe(true);
  });
});

describe("project default knowledge scope", () => {
  test("knowledgeScope round-trips through upsert/select; unset reads undefined", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "g", name: "g", branch: "main", repos: [], knowledgeScope: "global" });
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [], knowledgeScope: "project" });
    upsertProject(store.db, { id: "u", name: "u", branch: "main", repos: [] });

    expect(getProject(store.db, "g")?.knowledgeScope).toBe("global");
    expect(getProject(store.db, "p")?.knowledgeScope).toBe("project");
    expect(getProject(store.db, "u")?.knowledgeScope).toBeUndefined();
  });

  test("an out-of-set stored value reads back as no override", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
    // A legacy/hand-edited row could hold a value outside the project-default set.
    store.db.run("UPDATE projects SET knowledge_scope = 'user' WHERE id = 'p'");
    expect(getProject(store.db, "p")?.knowledgeScope).toBeUndefined();
  });

  test("getKnowledgeDefaultScope precedence: project override > global setting > 'project'", () => {
    const store = createStore(":memory:");
    upsertProject(store.db, { id: "override", name: "o", branch: "main", repos: [], knowledgeScope: "global" });
    upsertProject(store.db, { id: "plain", name: "pl", branch: "main", repos: [] });

    // No project override, no global setting → hard default 'project'.
    expect(getKnowledgeDefaultScope(store.db, "plain")).toBe("project");

    // Global setting applies when the project has no override.
    setSetting(store.db, KNOWLEDGE_DEFAULT_SCOPE_KEY, "global");
    expect(getKnowledgeDefaultScope(store.db, "plain")).toBe("global");

    // The project override wins over the global setting.
    expect(getKnowledgeDefaultScope(store.db, "override")).toBe("global");
    setSetting(store.db, KNOWLEDGE_DEFAULT_SCOPE_KEY, "project");
    expect(getKnowledgeDefaultScope(store.db, "override")).toBe("global");

    // A garbage global setting is ignored in favor of the hard default.
    setSetting(store.db, KNOWLEDGE_DEFAULT_SCOPE_KEY, "nonsense");
    expect(getKnowledgeDefaultScope(store.db, "plain")).toBe("project");

    // An unknown project id can't carry an override → hard default.
    expect(getKnowledgeDefaultScope(store.db, "ghost")).toBe("project");
  });
});
