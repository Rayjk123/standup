import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import type { KnowledgeDraft } from "./types.js";

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

describe("KnowledgeStore.ensureTables", () => {
  test("a fresh database gets generated_from_sha / generated_at on knowledge", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge");
    expect(cols).toContain("generated_from_sha");
    expect(cols).toContain("generated_at");
  });

  test("an existing database missing those columns converges to the same schema via ALTER", () => {
    const db = new Database(":memory:");
    // Simulate a pre-Phase-7 database: knowledge exists without the new columns.
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        embedding_json TEXT,
        file_path TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );
    `);
    db.run(
      "INSERT INTO knowledge (id, project_id, slug, title, body, file_path) VALUES ('1', 'p', 's', 'T', 'B', '/x')"
    );

    // Constructing the store must not throw against the pre-existing table,
    // and must backfill the columns rather than silently skip them (which is
    // what CREATE TABLE IF NOT EXISTS alone would do).
    new KnowledgeStore(db);

    const cols = columnsOf(db, "knowledge");
    expect(cols).toContain("generated_from_sha");
    expect(cols).toContain("generated_at");

    // Pre-existing rows get NULL, not "", for the backfilled columns.
    const row = db.query("SELECT generated_from_sha FROM knowledge WHERE id = '1'").get() as {
      generated_from_sha: string | null;
    };
    expect(row.generated_from_sha).toBeNull();
  });

  test("constructing KnowledgeStore twice against the same db is a no-op, not an error", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    expect(() => new KnowledgeStore(db)).not.toThrow();
  });

  test("knowledge_drafts has no embedding column and no FTS/chunks path", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge_drafts");
    expect(cols).not.toContain("embedding_json");

    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    // No table references knowledge_drafts as a source for search — asserted
    // directly on the FTS/chunks tables' definitions rather than trusted.
    const ftsSql = (
      db
        .query("SELECT sql FROM sqlite_master WHERE name = 'knowledge_fts'")
        .get() as { sql: string }
    ).sql;
    expect(ftsSql).not.toContain("knowledge_drafts");
    expect(tables).toContain("knowledge_chunks");
  });
});

describe("KnowledgeStore draft CRUD", () => {
  function draft(overrides: Partial<KnowledgeDraft> = {}): KnowledgeDraft {
    return {
      id: "d1",
      projectId: "proj",
      slug: "gotchas",
      title: "Gotchas",
      body: "watch out",
      filePath: "/x/.drafts/gotchas.md",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      ...overrides,
    };
  }

  test("upsertDraft + getDraft round-trips provenance", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(
      draft({ generatedFromSha: "abc123", generatedAt: "2026-08-16T00:00:00Z", generatedByLaunchId: "l1" })
    );

    const got = store.getDraft("proj", "gotchas");
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Gotchas");
    expect(got!.generatedFromSha).toBe("abc123");
    expect(got!.generatedByLaunchId).toBe("l1");
  });

  test("upsertDraft on the same project/slug updates rather than duplicates", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft({ body: "v1" }));
    store.upsertDraft(draft({ body: "v2" }));

    expect(store.getDraftsByProject("proj")).toHaveLength(1);
    expect(store.getDraft("proj", "gotchas")!.body).toBe("v2");
  });

  test("getDraftsByProject only returns rows for that project", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft({ id: "d1", projectId: "proj-a" }));
    store.upsertDraft(draft({ id: "d2", projectId: "proj-b" }));

    expect(store.getDraftsByProject("proj-a")).toHaveLength(1);
    expect(store.getDraftsByProject("proj-b")).toHaveLength(1);
  });

  test("deleteDraft removes the row", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft());
    store.deleteDraft("proj", "gotchas");

    expect(store.getDraft("proj", "gotchas")).toBeNull();
  });
});
