import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore, vecMirrorRebuildReason } from "./store.js";
import { VEC_TABLE, buildVecTableDDL, isVecAvailable } from "./vec.js";
import { resolveAuthoredScope } from "./types.js";
import type { KnowledgeDoc, KnowledgeDraft } from "./types.js";

function columnsOf(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

describe("vecMirrorRebuildReason — the startup rebuild decision", () => {
  const current = {
    exists: true,
    createSql: buildVecTableDDL(3),
    storedDimensions: 3,
    chunkRows: 4,
    chunkRowidSum: 10,
    vecRows: 4,
    vecRowidSum: 10,
  };

  test("a mirror on the current schema and width holding the chunks' rows is kept", () => {
    expect(vecMirrorRebuildReason(current)).toBeNull();
    expect(vecMirrorRebuildReason({ ...current, exists: false, createSql: null, storedDimensions: null, chunkRows: 0, chunkRowidSum: 0 })).toBeNull();
  });

  test("a missing, old-schema, other-width or out-of-step mirror is rebuilt", () => {
    expect(vecMirrorRebuildReason({ ...current, exists: false, createSql: null })).toBe("the mirror is missing");
    const oldDdl = `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(project_id text partition key, +chunk_id text, embedding float[3])`;
    expect(vecMirrorRebuildReason({ ...current, createSql: oldDdl })).toContain("predates the scope/owner partition keys");
    expect(vecMirrorRebuildReason({ ...current, storedDimensions: 384 })).toBe("the mirror is 3 wide, the stored embeddings 384");
    expect(vecMirrorRebuildReason({ ...current, vecRows: 3 })).toBe("the mirror holds 3 rows for 4 chunks");
    expect(vecMirrorRebuildReason({ ...current, vecRowidSum: 11 })).toBe("the mirror's rows are not the chunks' rows");
    expect(vecMirrorRebuildReason({ ...current, chunkGeneration: 7, vecGeneration: 6 })).toBe("chunks were written without the mirror");
    expect(vecMirrorRebuildReason({ ...current, chunkGeneration: 7, vecGeneration: 7 })).toBeNull();
  });

  test("a chunk write without sqlite-vec advances chunk_generation alone, and the mirror never catches up on its own", () => {
    const generations = (db: Database) =>
      db.query("SELECT chunk_generation AS c, vec_generation AS v FROM knowledge_graph_meta WHERE id = 0").get() as {
        c: number;
        v: number;
      };
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const vecHere = isVecAvailable(db);
    store.upsertDoc({ id: "d", projectId: "p", slug: "d", title: "D", body: "b", updatedAt: new Date(0), filePath: "/d.md" });
    store.upsertChunk({ id: "c0", knowledgeId: "d", chunkIndex: 0, text: "t", embedding: [1, 0, 0] });
    expect(generations(db)).toEqual(vecHere ? { c: 1, v: 1 } : { c: 1, v: 0 });

    const prev = process.env.STANDUP_DISABLE_VEC;
    process.env.STANDUP_DISABLE_VEC = "1";
    try {
      store.upsertChunk({ id: "c0", knowledgeId: "d", chunkIndex: 0, text: "t2", embedding: [0, 1, 0] });
    } finally {
      if (prev === undefined) delete process.env.STANDUP_DISABLE_VEC;
      else process.env.STANDUP_DISABLE_VEC = prev;
    }
    const behind = generations(db);
    expect(behind.c).toBe(2);
    expect(behind.v).toBe(vecHere ? 1 : 0);
    // A later in-step write does not paper over the one the mirror missed.
    store.upsertChunk({ id: "c1", knowledgeId: "d", chunkIndex: 1, text: "t3", embedding: [0, 0, 1] });
    expect(generations(db).c).toBe(3);
    expect(generations(db).v).toBe(behind.v);
  });

  describe("with sqlite-vec", () => {
    const vecHere = isVecAvailable(new Database(":memory:"));
    const seeded = () => {
      const db = new Database(":memory:");
      const store = new KnowledgeStore(db);
      store.upsertDoc({ id: "d", projectId: "p", slug: "d", title: "D", body: "b", updatedAt: new Date(0), filePath: "/d.md" });
      for (let i = 0; i < 3; i++) {
        store.upsertChunk({ id: `c${i}`, knowledgeId: "d", chunkIndex: i, text: `t${i}`, embedding: [1, i, 0] });
      }
      return { db, store };
    };
    const withoutVec = (fn: () => void) => {
      const prev = process.env.STANDUP_DISABLE_VEC;
      process.env.STANDUP_DISABLE_VEC = "1";
      try {
        fn();
      } finally {
        if (prev === undefined) delete process.env.STANDUP_DISABLE_VEC;
        else process.env.STANDUP_DISABLE_VEC = prev;
      }
    };
    const mirrored = (db: Database) =>
      (db.query(`SELECT chunk_id, embedding FROM ${VEC_TABLE} ORDER BY rowid`).all() as Array<{ chunk_id: string; embedding: Uint8Array }>).map(
        (r) => ({ chunkId: r.chunk_id, embedding: [...new Float32Array(new Uint8Array(r.embedding).buffer)] })
      );

    test.skipIf(!vecHere)("an unchanged mirror is kept", () => {
      const { store } = seeded();
      expect(store.ensureVecIndex()).toEqual({ action: "current" });
      expect(store.ensureVecIndex()).toEqual({ action: "current" });
    });

    test.skipIf(!vecHere)("chunks re-embedded in place while sqlite-vec was off are rebuilt into the mirror once it is back", () => {
      const { db, store } = seeded();
      withoutVec(() => store.upsertChunk({ id: "x", knowledgeId: "d", chunkIndex: 1, text: "edited", embedding: [0, 0, 1] }));
      expect(store.ensureVecIndex()).toEqual({ action: "rebuilt", reason: "chunks were written without the mirror" });
      expect(mirrored(db)[1]!.embedding).toEqual([0, 0, 1]);
      expect(store.ensureVecIndex()).toEqual({ action: "current" });
    });

    test.skipIf(!vecHere)("a same-width model change re-embedded without sqlite-vec reuses the rowids, and still rebuilds", () => {
      const { db, store } = seeded();
      const before = mirrored(db);
      withoutVec(() => {
        store.clearAllChunks();
        for (let i = 0; i < 3; i++) {
          store.upsertChunk({ id: `n${i}`, knowledgeId: "d", chunkIndex: i, text: `t${i}`, embedding: [0, 1, i] });
        }
      });
      // Count and rowid sum still match the stale mirror.
      expect(mirrored(db)).toEqual(before);
      expect(store.ensureVecIndex()).toEqual({ action: "rebuilt", reason: "chunks were written without the mirror" });
      expect(mirrored(db).map((r) => r.chunkId)).toEqual(["n0", "n1", "n2"]);
      expect(mirrored(db)[2]!.embedding).toEqual([0, 1, 2]);
    });

    test.skipIf(!vecHere)("a doc's partition keys changed without sqlite-vec rebuild the mirror", () => {
      const { store } = seeded();
      withoutVec(() => store.reconcileFileColumns("p", "d", "owner", "spec", "global", undefined));
      expect(store.ensureVecIndex().action).toBe("rebuilt");
      expect(store.ensureVecIndex()).toEqual({ action: "current" });
    });
  });

  test("ensureVecIndex is inert without sqlite-vec", () => {
    const prev = process.env.STANDUP_DISABLE_VEC;
    process.env.STANDUP_DISABLE_VEC = "1";
    try {
      const store = new KnowledgeStore(new Database(":memory:"));
      expect(store.ensureVecIndex()).toEqual({ action: "unavailable" });
      expect(store.vecReady()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.STANDUP_DISABLE_VEC;
      else process.env.STANDUP_DISABLE_VEC = prev;
    }
  });
});

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

  test("a fresh database gets the graph + provenance columns and knowledge_edges", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge");
    expect(cols).toContain("origin_class");
    expect(cols).toContain("source_session_id");
    expect(cols).toContain("related_json");

    const tables = (
      db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toContain("knowledge_edges");
  });

  test("a legacy knowledge table backfills origin_class to 'owner' (trusted, not NULL)", () => {
    const db = new Database(":memory:");
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

    new KnowledgeStore(db);

    const row = db.query("SELECT origin_class FROM knowledge WHERE id = '1'").get() as {
      origin_class: string | null;
    };
    // A pre-provenance row is a local, human-authored/accepted doc inside the
    // trust boundary — the same class the loader stamps an unasserted doc. It
    // backfills to 'owner' (never NULL, never the fail-closed 'untrusted') so
    // existing knowledge still clears the injection gate once the upgrade adds the
    // column; the mtime-skip resync would otherwise never re-stamp it. The
    // fail-closed default still governs new programmatic upserts (see the
    // upsertDoc test below).
    expect(row.origin_class).toBe("owner");
  });

  test("a fresh database gets the r2 confidence + source_kind columns", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge");
    expect(cols).toContain("source_kind");
    expect(cols).toContain("confidence");
    expect(cols).toContain("last_verified_at");
    expect(cols).toContain("half_life_days");
  });

  test("a legacy knowledge table backfills source_kind to 'unclassified' and leaves confidence NULL", () => {
    const db = new Database(":memory:");
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

    new KnowledgeStore(db);

    // source_kind is NOT NULL DEFAULT 'unclassified', so the ALTER backfills
    // every pre-existing row to the kind an unasserted file loads as. The confidence fields carry no default: a legacy doc
    // asserts no opinion, so they stay NULL rather than being fabricated.
    const row = db
      .query(
        "SELECT source_kind, confidence, last_verified_at, half_life_days FROM knowledge WHERE id = '1'"
      )
      .get() as {
      source_kind: string;
      confidence: number | null;
      last_verified_at: string | null;
      half_life_days: number | null;
    };
    expect(row.source_kind).toBe("unclassified");
    expect(row.confidence).toBeNull();
    expect(row.last_verified_at).toBeNull();
    expect(row.half_life_days).toBeNull();
  });

  test("a fresh database gets the scope + owner_user columns (per-user knowledge)", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge");
    expect(cols).toContain("scope");
    expect(cols).toContain("owner_user");
  });

  test("a legacy knowledge table backfills scope to 'project' and leaves owner_user NULL", () => {
    const db = new Database(":memory:");
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

    new KnowledgeStore(db);

    // scope is NOT NULL DEFAULT 'project', so the ALTER backfills every
    // pre-existing row to 'project' — a doc belonged to its project before this
    // dimension existed, so its behavior is unchanged. owner_user carries no
    // default: a doc has no owning user unless it is user-scoped, so it stays
    // NULL rather than being fabricated.
    const row = db
      .query("SELECT scope, owner_user FROM knowledge WHERE id = '1'")
      .get() as { scope: string; owner_user: string | null };
    expect(row.scope).toBe("project");
    expect(row.owner_user).toBeNull();
  });

  test("a legacy knowledge table backfills reserved GLOBAL-corpus rows to scope='global' while ordinary rows stay 'project'", () => {
    const db = new Database(":memory:");
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
    // A pre-existing best-practice doc homed in the reserved GLOBAL corpus, and
    // an ordinary project doc — the exact upgrade shape (the scope column is
    // added on this boot, backfilling every row to 'project' by default).
    db.run(
      "INSERT INTO knowledge (id, project_id, slug, title, body, file_path) VALUES ('g', ?, 'review-workflow', 'T', 'B', '/x')",
      [GLOBAL_PROJECT_ID]
    );
    db.run(
      "INSERT INTO knowledge (id, project_id, slug, title, body, file_path) VALUES ('p', 'alpha', 's', 'T', 'B', '/x')"
    );

    new KnowledgeStore(db);

    // The GLOBAL-corpus row must land on 'global' (docs there exist to reach every
    // session; leaving them 'project' drops the whole global KB out of the scope
    // gate, since their project_id is 'global', not any asking project). The
    // ordinary row keeps the correct 'project' default. This mirrors the
    // origin_class backfill, not the plain source_kind constant default.
    const rows = db
      .query("SELECT id, scope FROM knowledge ORDER BY id")
      .all() as Array<{ id: string; scope: string }>;
    expect(rows.find((r) => r.id === "g")!.scope).toBe("global");
    expect(rows.find((r) => r.id === "p")!.scope).toBe("project");
  });

  test("ensureColumns is idempotent against a table that already holds data (per-user knowledge)", () => {
    const db = new Database(":memory:");
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

    // Two constructions = ensureColumns run twice against a populated table:
    // the second ADD COLUMN must be skipped (PRAGMA-checked), the row must
    // survive, and its backfilled scope must stay 'project' — not reset or
    // duplicated. This is the watch-restart case (migrations re-run on every
    // source edit against a DB that already holds rows).
    new KnowledgeStore(db);
    new KnowledgeStore(db);

    const cols = columnsOf(db, "knowledge");
    expect(cols.filter((c) => c === "scope")).toHaveLength(1);
    expect(cols.filter((c) => c === "owner_user")).toHaveLength(1);
    const row = db
      .query("SELECT scope, owner_user FROM knowledge WHERE id = '1'")
      .get() as { scope: string; owner_user: string | null };
    expect(row.scope).toBe("project");
    expect(row.owner_user).toBeNull();
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

  test("a fresh knowledge_drafts table gets the scope + owner_user columns (per-user knowledge)", () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const cols = columnsOf(db, "knowledge_drafts");
    expect(cols).toContain("scope");
    expect(cols).toContain("owner_user");
  });

  test("a legacy knowledge_drafts table has scope/owner_user added, leaving them NULL (no 'project' default)", () => {
    const db = new Database(":memory:");
    // A drafts table predating per-user knowledge — no scope/owner_user.
    db.exec(`
      CREATE TABLE knowledge_drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );
    `);
    db.run(
      "INSERT INTO knowledge_drafts (id, project_id, slug, title, body, file_path) VALUES ('1', 'p', 's', 'T', 'B', '/x')"
    );

    // Run ensureColumns twice (the watch-restart case) — the ADD COLUMN is
    // PRAGMA-guarded, so it is skipped the second time and the row survives.
    new KnowledgeStore(db);
    new KnowledgeStore(db);

    const cols = columnsOf(db, "knowledge_drafts");
    expect(cols.filter((c) => c === "scope")).toHaveLength(1);
    expect(cols.filter((c) => c === "owner_user")).toHaveLength(1);
    // Unlike the accepted `knowledge` table, a draft's scope is RAW/nullable with
    // no 'project' backfill — a draft round-trips exactly what it asserted.
    const row = db
      .query("SELECT scope, owner_user FROM knowledge_drafts WHERE id = '1'")
      .get() as { scope: string | null; owner_user: string | null };
    expect(row.scope).toBeNull();
    expect(row.owner_user).toBeNull();
  });
});

describe("KnowledgeStore doc provenance", () => {
  function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
    return {
      id: "d1",
      projectId: "proj",
      slug: "arch",
      title: "Arch",
      body: "body",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x/arch.md",
      ...overrides,
    };
  }

  test("a doc upserted with no origin_class reads back fail-closed as 'untrusted'", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());

    expect(store.getDoc("proj", "arch")!.originClass).toBe("untrusted");
  });

  test("an asserted origin_class + source_session_id round-trips", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ originClass: "agent", sourceSessionId: "sess-1" }));

    const got = store.getDoc("proj", "arch")!;
    expect(got.originClass).toBe("agent");
    expect(got.sourceSessionId).toBe("sess-1");
  });

  test("getAllDocs spans every project", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "a" }));
    store.upsertDoc(doc({ id: "b", projectId: "p2", slug: "b" }));

    expect(store.getAllDocs().map((d) => d.projectId).sort()).toEqual(["p1", "p2"]);
  });

  test("a fresh doc has no re-verification verdict (roadmap r5)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());

    const got = store.getDoc("proj", "arch")!;
    expect(got.verdict).toBeUndefined();
    expect(got.disputes).toBeUndefined();
  });

  test("setDocVerdict round-trips a disputed verdict with its disputes (roadmap r5)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());
    store.setDocVerdict("proj", "arch", "disputed", [
      { claim: "does X", finding: "does not", evidence: "rg X" },
    ]);

    const got = store.getDoc("proj", "arch")!;
    expect(got.verdict).toBe("disputed");
    expect(got.disputes).toEqual([{ claim: "does X", finding: "does not", evidence: "rg X" }]);
  });

  test("re-syncing an accepted doc (upsertDoc again) does not clobber a recorded verdict (roadmap r5)", () => {
    // The re-verification cron writes confidence to the file and resyncs; the
    // resync's upsertDoc must preserve the verdict it recorded separately,
    // exactly as upsertDraft preserves a draft's verdict.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());
    store.setDocVerdict("proj", "arch", "disputed", [{ claim: "c", finding: "f", evidence: "e" }]);
    store.upsertDoc(doc({ confidence: 0.1, lastVerifiedAt: "2026-09-01T00:00:00.000Z" }));

    const got = store.getDoc("proj", "arch")!;
    expect(got.verdict).toBe("disputed");
    expect(got.confidence).toBe(0.1);
  });

  test("a writer stamp survives only a rewrite of the content it was given for", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    expect(store.stampWriter("proj", "arch", "persona")).toBe(false);
    store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o" }));
    expect(store.writerOf("proj", "arch")).toBeNull();
    expect(store.stampWriter("proj", "arch", "persona")).toBe(true);
    expect(store.writerOf("proj", "arch")).toBe("persona");
    // The same content re-synced (a newer mtime, a later confidence stamp) keeps it.
    store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o", updatedAt: new Date("2026-09-01T00:00:00Z"), confidence: 0.5 }));
    expect(store.writerOf("proj", "arch")).toBe("persona");
    // Any change to what a reader trusts the writer for drops it.
    for (const change of [{ body: "other" }, { title: "Other" }, { tags: ["b"] }, { originClass: "owner" as const }, { sourceSessionId: "s" }, { generatedAt: "2026-09-02T00:00:00Z" }]) {
      store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o" }));
      store.stampWriter("proj", "arch", "persona");
      store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o", ...change }));
      expect(store.writerOf("proj", "arch")).toBeNull();
      expect((db.query("SELECT writer_stamp FROM knowledge").get() as { writer_stamp: string | null }).writer_stamp).toBeNull();
    }
    // A file-column reconcile (scope, owner) that changes the row drops it too.
    store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o" }));
    store.stampWriter("proj", "arch", "persona");
    store.reconcileFileColumns("proj", "arch", "untrusted", "unclassified", "project", undefined);
    expect((db.query("SELECT writer_stamp FROM knowledge").get() as { writer_stamp: string | null }).writer_stamp).toBeNull();
    // A raw rewrite that goes around upsertDoc leaves a stamp that no longer verifies.
    store.upsertDoc(doc({ tags: ["a"], scope: "user", ownerUser: "o" }));
    store.stampWriter("proj", "arch", "persona");
    db.run("UPDATE knowledge SET body = 'rewritten'");
    expect(store.writerOf("proj", "arch")).toBeNull();
  });

  test("a doc upserted with no source_kind reads back as 'unclassified' (roadmap r2)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());

    const got = store.getDoc("proj", "arch")!;
    expect(got.sourceKind).toBe("unclassified");
    expect(got.confidence).toBeUndefined();
  });

  test("asserted source_kind + confidence bookkeeping round-trips through the store", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(
      doc({
        sourceKind: "product",
        confidence: 0.8,
        lastVerifiedAt: "2026-08-16T00:00:00.000Z",
        halfLifeDays: 45,
      })
    );

    const got = store.getDoc("proj", "arch")!;
    expect(got.sourceKind).toBe("product");
    expect(got.confidence).toBe(0.8);
    expect(got.lastVerifiedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(got.halfLifeDays).toBe(45);
  });

  test("a doc upserted with no scope reads back as 'project' with no owner (per-user knowledge)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc());

    const got = store.getDoc("proj", "arch")!;
    expect(got.scope).toBe("project");
    expect(got.ownerUser).toBeUndefined();
  });

  test("a doc stored with scope='global' round-trips through the store", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ scope: "global" }));

    const got = store.getDoc("proj", "arch")!;
    expect(got.scope).toBe("global");
    // A global doc has no single owning user.
    expect(got.ownerUser).toBeUndefined();
  });

  test("a doc stored with scope='user' + owner_user round-trips through the store", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ scope: "user", ownerUser: "alice" }));

    const got = store.getDoc("proj", "arch")!;
    expect(got.scope).toBe("user");
    expect(got.ownerUser).toBe("alice");
  });
});

describe("resolveAuthoredScope — authoring defaults (per-user knowledge)", () => {
  test("defaults to 'project' with no owner when the author asserts no scope", () => {
    expect(resolveAuthoredScope(undefined, "alice")).toEqual({
      scope: "project",
      ownerUser: undefined,
    });
  });

  test("an explicit 'global' promotion carries no owning user", () => {
    expect(resolveAuthoredScope("global", "alice")).toEqual({
      scope: "global",
      ownerUser: undefined,
    });
  });

  test("a 'user' scope stamps the owning user from the authoring actor", () => {
    expect(resolveAuthoredScope("user", "alice")).toEqual({
      scope: "user",
      ownerUser: "alice",
    });
  });

  test("a 'user' scope with no resolvable actor falls back to 'project' — an owner-less user doc is in no retrieval window", () => {
    expect(resolveAuthoredScope("user", "   ")).toEqual({
      scope: "project",
      ownerUser: undefined,
    });
    expect(resolveAuthoredScope("user", undefined)).toEqual({
      scope: "project",
      ownerUser: undefined,
    });
  });
});

describe("KnowledgeStore.getStats — sourceKindBreakdown", () => {
  function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
    return {
      id: "d1",
      projectId: "proj",
      slug: "arch",
      title: "Arch",
      body: "body",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x/arch.md",
      ...overrides,
    };
  }

  test("breaks docs down by source_kind and sums to the doc count", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "a", slug: "a", sourceKind: "code" }));
    store.upsertDoc(doc({ id: "b", slug: "b", sourceKind: "code" }));
    store.upsertDoc(doc({ id: "c", slug: "c", sourceKind: "product" }));
    // No source_kind asserted — the store defaults it to 'unclassified'.
    store.upsertDoc(doc({ id: "d", slug: "d" }));

    const stats = store.getStats();
    expect(stats.sourceKindBreakdown).toEqual({ code: 2, product: 1, unclassified: 1 });
    const total = Object.values(stats.sourceKindBreakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(stats.docs);
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
      verdict: "unverified",
      disputes: [],
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

  test("upsertDraft + getDraft round-trips source_kind + confidence bookkeeping (roadmap r2)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(
      draft({
        sourceKind: "spec",
        confidence: 1,
        lastVerifiedAt: "2026-08-16T00:00:00.000Z",
        halfLifeDays: 90,
      })
    );

    const got = store.getDraft("proj", "gotchas")!;
    expect(got.sourceKind).toBe("spec");
    expect(got.confidence).toBe(1);
    expect(got.lastVerifiedAt).toBe("2026-08-16T00:00:00.000Z");
    expect(got.halfLifeDays).toBe(90);
  });

  test("upsertDraft + getDraft round-trips scope + owner_user (per-user knowledge)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    // A user-scoped draft carries its owner; the round-trip is what lets a body
    // edit preserve the authored audience instead of dropping it on accept.
    store.upsertDraft(draft({ scope: "user", ownerUser: "alice" }));
    const userDraft = store.getDraft("proj", "gotchas")!;
    expect(userDraft.scope).toBe("user");
    expect(userDraft.ownerUser).toBe("alice");

    // A scope-less draft stays scope-less (undefined, NOT a 'project' default) so
    // the edit round-trip never fabricates an audience the draft never asserted.
    store.upsertDraft(draft({ slug: "plain", id: "d2" }));
    const plain = store.getDraft("proj", "plain")!;
    expect(plain.scope).toBeUndefined();
    expect(plain.ownerUser).toBeUndefined();
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

  test("a fresh draft defaults to 'unverified' with no disputes, not 'clean'", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft());

    const got = store.getDraft("proj", "gotchas");
    expect(got!.verdict).toBe("unverified");
    expect(got!.disputes).toEqual([]);
  });

  test("setDraftVerdict round-trips a disputed verdict with its disputes", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft());
    store.setDraftVerdict("proj", "gotchas", "disputed", [
      { claim: "235 errors", finding: "actually 32", evidence: "bun run typecheck" },
    ]);

    const got = store.getDraft("proj", "gotchas");
    expect(got!.verdict).toBe("disputed");
    expect(got!.disputes).toEqual([
      { claim: "235 errors", finding: "actually 32", evidence: "bun run typecheck" },
    ]);
  });

  test("re-syncing a draft from disk (upsertDraft again) does not clobber a recorded verdict", () => {
    // The loader has no way to know the verdict — it only reads the file —
    // so a resync must not silently downgrade a 'disputed' draft back to
    // 'unverified' just because the file was re-read unchanged.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDraft(draft());
    store.setDraftVerdict("proj", "gotchas", "clean", []);
    store.upsertDraft(draft({ body: "watch out (unchanged content, re-synced)" }));

    expect(store.getDraft("proj", "gotchas")!.verdict).toBe("clean");
  });
});

describe("KnowledgeStore.getNeighbors trust/verdict", () => {
  function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
    return {
      id: "src",
      projectId: "proj",
      slug: "src",
      title: "Src",
      body: "body",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x/src.md",
      ...overrides,
    };
  }

  test("carries the neighbor's originClass and verdict alongside the edge", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "src", slug: "src" }));
    store.upsertDoc(
      doc({ id: "nbr", slug: "nbr", originClass: "untrusted", sourceKind: "spec" })
    );
    store.setDocVerdict("proj", "nbr", "contradicted", [
      { claim: "Contradicts src", finding: "opposes", evidence: "coherence" },
    ]);
    store.replaceAllEdges([
      {
        id: "e1",
        srcDocId: "src",
        dstDocId: "nbr",
        kind: "related",
        weight: 2,
        confidence: 1,
        evidence: "frontmatter related: nbr",
      },
    ]);

    const neighbors = store.getNeighbors("src");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].docId).toBe("nbr");
    expect(neighbors[0].originClass).toBe("untrusted");
    expect(neighbors[0].verdict).toBe("contradicted");
    expect(neighbors[0].sourceKind).toBe("spec");
    // The edge's own signal rides through to the pivot — WHY they're linked,
    // and the confidence the edge asserted.
    expect(neighbors[0].evidence).toBe("frontmatter related: nbr");
    expect(neighbors[0].confidence).toBe(1);
  });

  test("a neighbor with no asserted origin reads back fail-closed as 'untrusted' with no verdict", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "src", slug: "src" }));
    store.upsertDoc(doc({ id: "nbr", slug: "nbr" }));
    store.replaceAllEdges([
      { id: "e1", srcDocId: "nbr", dstDocId: "src", kind: "co-citation", weight: 1 },
    ]);

    const [n] = store.getNeighbors("src");
    expect(n.originClass).toBe("untrusted");
    expect(n.verdict).toBeUndefined();
  });

  test("the duplicate-(doc,kind) collapse still keeps the highest-weight row", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "src", slug: "src" }));
    store.upsertDoc(doc({ id: "nbr", slug: "nbr", originClass: "owner" }));
    // A `related` link authored on both docs stores two directed edges; walking
    // both directions must still surface the neighbor once under that kind.
    store.replaceAllEdges([
      { id: "e1", srcDocId: "src", dstDocId: "nbr", kind: "related", weight: 3 },
      { id: "e2", srcDocId: "nbr", dstDocId: "src", kind: "related", weight: 1 },
    ]);

    const neighbors = store.getNeighbors("src");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].weight).toBe(3);
    expect(neighbors[0].originClass).toBe("owner");
  });
});

describe("KnowledgeStore.getNeighbors scope gate", () => {
  function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
    return {
      id: "src",
      projectId: "alpha",
      slug: "src",
      title: "Src",
      body: "body",
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x/src.md",
      ...overrides,
    };
  }

  // A doc the caller CAN see (global) linked to docs at other scopes, so the
  // gate has something to keep AND something to drop.
  function seed(store: KnowledgeStore): void {
    store.upsertDoc(doc({ id: "gd", slug: "global-doc", scope: "global", originClass: "owner" }));
    // Alice's private user-scoped doc, homed in a project.
    store.upsertDoc(
      doc({ id: "au", slug: "alice-doc", scope: "user", ownerUser: "alice", originClass: "owner" })
    );
    // A user-scoped doc homed in the reserved GLOBAL corpus — the exact
    // gu/alice-secret case the scope gate closes on every retrieval path.
    store.upsertDoc(
      doc({
        id: "gu",
        projectId: GLOBAL_PROJECT_ID,
        slug: "alice-global-secret",
        scope: "user",
        ownerUser: "alice",
        originClass: "owner",
      })
    );
    // A project-scoped doc in a DIFFERENT project than the caller's.
    store.upsertDoc(
      doc({ id: "beta", projectId: "beta", slug: "beta-doc", scope: "project", originClass: "owner" })
    );
    // A project-scoped doc in the caller's own project.
    store.upsertDoc(
      doc({ id: "ap", projectId: "alpha", slug: "alpha-doc", scope: "project", originClass: "owner" })
    );
    store.replaceAllEdges([
      { id: "e-au", srcDocId: "gd", dstDocId: "au", kind: "co-citation", weight: 4 },
      { id: "e-gu", srcDocId: "gd", dstDocId: "gu", kind: "co-citation", weight: 3 },
      { id: "e-beta", srcDocId: "gd", dstDocId: "beta", kind: "co-citation", weight: 2 },
      { id: "e-ap", srcDocId: "gd", dstDocId: "ap", kind: "co-citation", weight: 1 },
    ]);
  }

  test("no audience (browse path) returns every neighbor unfiltered", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    seed(store);

    const slugs = store.getNeighbors("gd").map((n) => n.slug);
    expect(slugs).toContain("alice-doc");
    expect(slugs).toContain("alice-global-secret");
    expect(slugs).toContain("beta-doc");
    expect(slugs).toContain("alpha-doc");
  });

  test("a non-owner audience drops another user's user-scoped neighbors AND foreign-project ones", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    seed(store);

    const slugs = store.getNeighbors("gd", { projectId: "alpha", user: "bob" }).map((n) => n.slug);
    // Bob never sees Alice's private docs by any path — including the
    // user-scoped-in-global one the reserved-home shortcut must NOT swallow.
    expect(slugs).not.toContain("alice-doc");
    expect(slugs).not.toContain("alice-global-secret");
    // A project doc from a project that is not the caller's is out of scope too.
    expect(slugs).not.toContain("beta-doc");
    // Bob still gets his own project's docs.
    expect(slugs).toContain("alpha-doc");
  });

  test("the owning user's audience keeps that user's own user-scoped neighbors", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    seed(store);

    const slugs = store.getNeighbors("gd", { projectId: "alpha", user: "alice" }).map((n) => n.slug);
    expect(slugs).toContain("alice-doc");
    expect(slugs).toContain("alice-global-secret");
    expect(slugs).toContain("alpha-doc");
    // Even Alice doesn't get another project's project-scoped doc.
    expect(slugs).not.toContain("beta-doc");
  });
});
