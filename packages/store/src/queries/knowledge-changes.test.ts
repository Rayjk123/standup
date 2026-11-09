import { expect, test, describe } from "bun:test";
import { createStore } from "../store.js";
import { createKnowledgeChange, getRecentKnowledgeChanges } from "./knowledge-changes.js";

function change(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "p",
    slug: id,
    kind: "accepted" as const,
    title: `Title ${id}`,
    createdAt: `2026-10-0${id.length}T00:00:00Z`,
    ...extra,
  };
}

describe("knowledge_changes personal-layer visibility", () => {
  test("a personal change is listed only for its owner", () => {
    const store = createStore(":memory:");
    createKnowledgeChange(store.db, change("team"));
    createKnowledgeChange(store.db, change("alice-pref", { personal: true, ownerUser: "alice" }));
    createKnowledgeChange(store.db, change("ownerless", { personal: true }));

    const ids = (viewer: string | null) => getRecentKnowledgeChanges(store.db, 50, viewer).map((c) => c.id).sort();
    expect(ids("alice")).toEqual(["alice-pref", "team"]);
    expect(ids("bob")).toEqual(["team"]);
    expect(ids(null)).toEqual(["team"]);
    // The default read is the shared view.
    expect(getRecentKnowledgeChanges(store.db).map((c) => c.id)).toEqual(["team"]);

    const [alicePref] = getRecentKnowledgeChanges(store.db, 50, "alice").filter((c) => c.id === "alice-pref");
    expect(alicePref).toMatchObject({ personal: true, ownerUser: "alice" });
    store.close();
  });

  test("a home-mirror change whose doc is gone is personal whatever its flag says", () => {
    const store = createStore(":memory:");
    store.db.run(
      `INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at, personal)
       VALUES ('old-team', 'p', 'team-doc', 'accepted', 'Team', '2026-01-01', NULL),
              ('old-home', 'global', 'native-mem-home-claude-md', 'accepted', 'Home', '2026-01-02', NULL),
              ('imported-home', 'global', 'native-mem-home-rules', 'accepted', 'Home rules', '2026-01-03', 0)`
    );
    expect(getRecentKnowledgeChanges(store.db, 50, "alice").map((c) => c.id)).toEqual(["old-team"]);
    store.close();
  });

  test("a change is personal by its doc's current placement, whatever its flag says", () => {
    const store = createStore(":memory:");
    store.db.exec(
      "CREATE TABLE knowledge (id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, scope TEXT, source_kind TEXT, owner_user TEXT)"
    );
    store.db.run(
      `INSERT INTO knowledge (id, project_id, slug, scope, source_kind, owner_user)
       VALUES ('1', 'p', 'alice-legal', 'user', 'decision', 'alice'), ('2', 'p', 'team-doc', 'project', 'decision', NULL)`
    );
    store.db.run(
      `INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at, personal)
       VALUES ('legacy', 'p', 'alice-legal', 'accepted', 'Alice divorce lawyer notes', '2026-01-01', NULL),
              ('stale-flag', 'p', 'alice-legal', 'reconciled', 'Alice divorce lawyer notes', '2026-01-02', 0),
              ('team', 'p', 'team-doc', 'accepted', 'Team doc', '2026-01-03', NULL)`
    );
    const ids = (viewer: string | null) => getRecentKnowledgeChanges(store.db, 50, viewer).map((c) => c.id).sort();
    expect(ids(null)).toEqual(["team"]);
    expect(ids("bob")).toEqual(["team"]);
    expect(ids("alice")).toEqual(["legacy", "stale-flag", "team"]);
    const legacy = getRecentKnowledgeChanges(store.db, 50, "alice").find((c) => c.id === "legacy");
    expect(legacy).toMatchObject({ personal: true, ownerUser: "alice" });
    store.close();
  });
});
