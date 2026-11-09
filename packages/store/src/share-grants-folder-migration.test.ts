import { describe, expect, test } from "bun:test";
import { ensureShareGrantsFolderType, runMigrations } from "./migrations.js";
import { createStore } from "./store.js";
import { createDoc, createDocFolder, getDocFolderSubtree, isDocFolderWithin } from "./queries/docs.js";
import { findLiveGrantByToken, getLiveGrant, setShare } from "./queries/share-grants.js";

/** share_grants as migration 080 first created it, before a folder could be shared. */
const OLD_SHARE_GRANTS = `CREATE TABLE share_grants (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('review', 'doc')),
  resource_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX idx_share_grants_live ON share_grants(resource_type, resource_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_share_grants_owner ON share_grants(owner, resource_type);`;

describe("migration 085: share_grants takes folders", () => {
  test("a fresh store shares a folder", () => {
    const { db } = createStore(":memory:");
    const grant = setShare(db, "folder", "f1", "alice", true)!;
    expect(findLiveGrantByToken(db, "folder", grant.token)?.resourceId).toBe("f1");
    expect(findLiveGrantByToken(db, "doc", grant.token)).toBeNull();
  });

  test("an old table is widened with every grant kept, and stays one live grant per resource", () => {
    const { db } = createStore(":memory:");
    db.exec("DROP TABLE share_grants");
    db.exec(OLD_SHARE_GRANTS);
    const review = setShare(db, "review", "r1", "alice", true)!;
    setShare(db, "doc", "d1", "alice", true);
    setShare(db, "doc", "d1", "alice", false);
    expect(() => setShare(db, "folder", "f1", "alice", true)).toThrow();

    db.run("DELETE FROM schema_version WHERE version = 85");
    runMigrations(db);

    expect(db.query("SELECT COUNT(*) AS n FROM share_grants").get()).toEqual({ n: 2 });
    expect(findLiveGrantByToken(db, "review", review.token)?.resourceId).toBe("r1");
    expect(getLiveGrant(db, "doc", "d1", "alice")).toBeNull();
    const folder = setShare(db, "folder", "f1", "alice", true)!;
    expect(findLiveGrantByToken(db, "folder", folder.token)?.owner).toBe("alice");
    // The partial unique index came back with the table.
    expect(() =>
      db.run(
        "INSERT INTO share_grants (id, resource_type, resource_id, owner, token, token_sha256, created_at) VALUES ('x', 'folder', 'f1', 'alice', 't', 'h', 'now')"
      )
    ).toThrow();
    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'share_grants'").all() as Array<{ name: string }>).map(
      (r) => r.name
    );
    expect(indexes).toEqual(expect.arrayContaining(["idx_share_grants_live", "idx_share_grants_owner"]));
    // Running it again changes nothing.
    ensureShareGrantsFolderType(db);
    expect(db.query("SELECT COUNT(*) AS n FROM share_grants").get()).toEqual({ n: 3 });
  });
});

describe("a folder's subtree", () => {
  test("isDocFolderWithin follows parent links only, and getDocFolderSubtree lists what is below", () => {
    const { db } = createStore(":memory:");
    const top = createDocFolder(db, { owner: "alice", parentId: null, name: "top" });
    const mid = createDocFolder(db, { owner: "alice", parentId: top.id, name: "mid" });
    const leaf = createDocFolder(db, { owner: "alice", parentId: mid.id, name: "leaf" });
    const other = createDocFolder(db, { owner: "alice", parentId: null, name: "other" });
    const bobs = createDocFolder(db, { owner: "bob", parentId: null, name: "top" });
    expect(isDocFolderWithin(db, leaf.id, top.id, "alice")).toBe(true);
    expect(isDocFolderWithin(db, top.id, top.id, "alice")).toBe(true);
    expect(isDocFolderWithin(db, top.id, mid.id, "alice")).toBe(false);
    expect(isDocFolderWithin(db, other.id, top.id, "alice")).toBe(false);
    expect(isDocFolderWithin(db, null, top.id, "alice")).toBe(false);
    expect(isDocFolderWithin(db, leaf.id, top.id, "bob")).toBe(false);
    expect(isDocFolderWithin(db, bobs.id, top.id, "alice")).toBe(false);

    createDoc(db, { owner: "alice", folderId: leaf.id, name: "deep.md", body: "x" });
    createDoc(db, { owner: "alice", folderId: other.id, name: "out.md", body: "y" });
    const subtree = getDocFolderSubtree(db, mid.id, "alice")!;
    expect(subtree.root.id).toBe(mid.id);
    expect(subtree.folders.map((f) => f.name)).toEqual(["mid", "leaf"]);
    expect(subtree.docs.map((d) => d.name)).toEqual(["deep.md"]);
    expect(getDocFolderSubtree(db, mid.id, "bob")).toBeNull();
  });
});
