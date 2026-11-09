import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    ...overrides,
  };
}

function ftsRows(db: Database): Array<{ id: string; body: string }> {
  return db.query("SELECT id, body FROM knowledge_fts").all() as Array<{ id: string; body: string }>;
}

describe("KnowledgeStore.upsertDoc keeps FTS on the stored id", () => {
  test("re-upserting a slug under a fresh id returns the stored id and replaces its FTS row", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const first = store.upsertDoc(
      doc({ id: "first", slug: "retry", title: "Retry", body: "Retry three attempts." })
    );
    expect(first).toBe("first");

    // The loader mints a new id on every load; the stored row keeps its own.
    const second = store.upsertDoc(
      doc({ id: "second", slug: "retry", title: "Retry", body: "Retry FIVE attempts with jitter." })
    );
    expect(second).toBe("first");
    expect(ftsRows(db)).toEqual([{ id: "first", body: "Retry FIVE attempts with jitter." }]);

    expect((await searchKnowledge(db, "proj", "jitter", null)).map((r) => r.id)).toEqual(["first"]);
    expect(await searchKnowledge(db, "proj", "three", null)).toEqual([]);
  });

  test("deleteDoc removes every FTS row and chunk of the doc", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const id = store.upsertDoc(doc({ slug: "gone", body: "short lived" }));
    db.run("INSERT INTO knowledge_fts (id, slug, title, body, tags) VALUES (?, 'gone', 'x', 'dup', '')", [id]);
    store.upsertChunk({ id: "c0", knowledgeId: id, chunkIndex: 0, text: "short lived", embedding: [1, 0] });

    store.deleteDoc("proj", "gone");

    expect(ftsRows(db)).toEqual([]);
    expect((db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number }).n).toBe(0);
  });
});

describe("KnowledgeStore chunk exactness", () => {
  test("truncateChunks and deleteChunks remove chunk rows and their vec rows", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const id = store.upsertDoc(doc({ slug: "steps" }));
    for (let i = 0; i < 4; i++) {
      store.upsertChunk({ id: `c${i}`, knowledgeId: id, chunkIndex: i, text: `step ${i}`, embedding: [1, i, 0] });
    }
    store.truncateChunks(id, 2);
    expect(store.chunkIndexes(id)).toEqual([0, 1]);
    store.deleteChunks(id, [1]);
    expect(store.chunkIndexes(id)).toEqual([0]);
    if (store.vecReady()) {
      expect(store.checkIndexIntegrity().vecChunkMismatch).toBe(0);
      expect(store.checkIndexIntegrity().vecRows).toBe(1);
    }
  });
});

describe("FTS schema and self-heal", () => {
  // The FTS declaration and row layout of a database written by the original
  // schema: no slug column, default tokenizer.
  function legacyDb(): Database {
    const db = new Database(":memory:");
    new KnowledgeStore(db).upsertDoc(
      doc({ id: "k1", slug: "acme-pr-workflow", title: "PR workflow", body: "Open PRs with gh pr create." })
    );
    db.exec("DROP TABLE knowledge_fts");
    db.exec("CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, title, body, tags)");
    db.run("INSERT INTO knowledge_fts (id, title, body, tags) VALUES ('k1', 'PR workflow', 'old text', '')");
    db.run("INSERT INTO knowledge_fts (id, title, body, tags) VALUES ('orphan', 'Gone', 'gone text', '')");
    return db;
  }

  test("an old-schema FTS table is rebuilt from the knowledge table on construction", async () => {
    const db = legacyDb();
    new KnowledgeStore(db);

    const sql = (
      db.query("SELECT sql FROM sqlite_master WHERE name = 'knowledge_fts'").get() as { sql: string }
    ).sql;
    expect(sql).toContain("porter");
    expect(sql).toContain("slug");
    expect(ftsRows(db)).toEqual([{ id: "k1", body: "Open PRs with gh pr create." }]);

    // Stemming: "workflows" matches "workflow"; the slug is searchable by its words.
    expect((await searchKnowledge(db, "proj", "workflows", null)).map((r) => r.id)).toEqual(["k1"]);
    expect((await searchKnowledge(db, "proj", "acme", null)).map((r) => r.id)).toEqual(["k1"]);

    // Idempotent: a second construction finds the schema current and changes nothing.
    new KnowledgeStore(db);
    expect(ftsRows(db)).toEqual([{ id: "k1", body: "Open PRs with gh pr create." }]);
  });

  test("orphan, stale and missing FTS rows and orphan chunks are repaired on a connection's first construction", async () => {
    const path = join(tmpdir(), `kb-heal-${crypto.randomUUID()}.db`);
    const db = new Database(path);
    const store = new KnowledgeStore(db);
    const a = store.upsertDoc(doc({ id: "a", slug: "a", body: "alpha current" }));
    store.upsertDoc(doc({ id: "b", slug: "b", body: "beta current" }));
    store.upsertChunk({ id: "ca", knowledgeId: a, chunkIndex: 0, text: "alpha current", embedding: [1, 0] });
    db.run("UPDATE knowledge_fts SET body = 'alpha stale' WHERE id = 'a'");
    db.run("DELETE FROM knowledge_fts WHERE id = 'b'");
    db.run("INSERT INTO knowledge_fts (id, slug, title, body, tags) VALUES ('ghost', 'g', 'g', 'ghost', '')");
    db.run(
      "INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json) VALUES ('cx', 'nobody', 0, 'x', '[1,0]')"
    );
    expect(store.checkIndexIntegrity()).toMatchObject({
      orphanFts: 1,
      staleFts: 1,
      missingFts: 1,
      orphanChunks: 1,
    });
    db.close();

    const reopened = new Database(path);
    try {
      const healed = new KnowledgeStore(reopened).checkIndexIntegrity();
      expect(healed).toMatchObject({
        docs: 2,
        ftsRows: 2,
        orphanFts: 0,
        missingFts: 0,
        duplicateFts: 0,
        staleFts: 0,
        chunks: 1,
        orphanChunks: 0,
        tailChunks: 0,
      });
      expect((await searchKnowledge(reopened, "proj", "stale", null)).length).toBe(0);
      expect((await searchKnowledge(reopened, "proj", "beta", null)).map((r) => r.id)).toEqual(["b"]);
    } finally {
      reopened.close();
      await Bun.file(path).delete();
    }
  });
});

describe("index integrity and self-heal bookkeeping", () => {
  test("integrity is reused until the corpus revision moves, and `fresh` rescans", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", slug: "a", body: "alpha" }));
    const first = store.checkIndexIntegrity();
    expect(first.staleFts).toBe(0);
    // Drift written around the store's write paths leaves the revision alone.
    db.run("UPDATE knowledge_fts SET body = 'drifted' WHERE id = 'a'");
    expect(store.checkIndexIntegrity()).toBe(first);
    expect(store.checkIndexIntegrity({ fresh: true }).staleFts).toBe(1);
    store.upsertDoc(doc({ id: "b", slug: "b", body: "beta" }));
    expect(store.checkIndexIntegrity().docs).toBe(2);
  });

  test("tag drift in the FTS mirror is detected and repaired", async () => {
    const path = join(tmpdir(), `kb-heal-tags-${crypto.randomUUID()}.db`);
    const db = new Database(path);
    new KnowledgeStore(db).upsertDoc(doc({ id: "t", slug: "t", body: "body", tags: ["deploy", "canary"] }));
    db.run("UPDATE knowledge_fts SET tags = 'stale' WHERE id = 't'");
    expect(new KnowledgeStore(db).checkIndexIntegrity({ fresh: true }).staleFts).toBe(1);
    db.close();
    const reopened = new Database(path);
    try {
      expect(new KnowledgeStore(reopened).checkIndexIntegrity().staleFts).toBe(0);
      expect((await searchKnowledge(reopened, "proj", "canary", null)).map((r) => r.id)).toEqual(["t"]);
    } finally {
      reopened.close();
      await Bun.file(path).delete();
    }
  });

  test("a self-heal that throws is retried by the next store on the connection", async () => {
    const path = join(tmpdir(), `kb-heal-retry-${crypto.randomUUID()}.db`);
    const db = new Database(path);
    new KnowledgeStore(db).upsertDoc(doc({ id: "y", slug: "y", body: "yankee" }));
    db.run("DELETE FROM knowledge_fts");
    db.close();

    const proto = KnowledgeStore.prototype as unknown as { rebuildFts: () => void };
    const original = proto.rebuildFts;
    let calls = 0;
    proto.rebuildFts = function (this: KnowledgeStore) {
      calls++;
      if (calls === 1) throw new Error("database is locked");
      return original.call(this);
    };
    const reopened = new Database(path);
    try {
      expect(() => new KnowledgeStore(reopened)).not.toThrow();
      expect(new KnowledgeStore(reopened).checkIndexIntegrity().missingFts).toBe(0);
      expect(calls).toBe(2);
      new KnowledgeStore(reopened);
      expect(calls).toBe(2);
    } finally {
      proto.rebuildFts = original;
      reopened.close();
      await Bun.file(path).delete();
    }
  });
});

describe("FTS query building", () => {
  test("stopwords do not match on their own", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "noise", slug: "noise", title: "Noise", body: "how the what is the of the to the" }));
    store.upsertDoc(doc({ id: "hit", slug: "hit", title: "Bun timeout", body: "Bun fetch has a 360s default timeout." }));

    const results = await searchKnowledge(db, "proj", "what is the bun timeout", null);
    expect(results.map((r) => r.id)).toEqual(["hit"]);
  });

  test("an all-stopword query falls back to its raw words", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db).upsertDoc(doc({ id: "w", slug: "w", title: "W", body: "how it works" }));
    expect((await searchKnowledge(db, "proj", "how", null)).map((r) => r.id)).toEqual(["w"]);
  });

  test("possessives and contractions match the bare word", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db).upsertDoc(
      doc({ id: "c", slug: "c", title: "Collector", body: "The collector restarts on deploy." })
    );
    expect((await searchKnowledge(db, "proj", "collector's restart", null)).map((r) => r.id)).toEqual(["c"]);
    expect((await searchKnowledge(db, "proj", "why doesn't it restart", null)).map((r) => r.id)).toEqual(["c"]);
  });

  test("control characters in the query are ignored rather than thrown", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db).upsertDoc(doc({ id: "n", slug: "n", title: "N", body: "null byte handling" }));
    expect((await searchKnowledge(db, "proj", "null\u0000byte", null)).map((r) => r.id)).toEqual(["n"]);
    expect(await searchKnowledge(db, "proj", "\u0000\u0001", null)).toEqual([]);
  });

  test("quotes in the query are escaped, not parsed", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db).upsertDoc(doc({ id: "q", slug: "q", title: "Q", body: 'say "hello" twice' }));
    expect((await searchKnowledge(db, "proj", 'the "hello', null)).map((r) => r.id)).toEqual(["q"]);
  });
});

describe("exact-slug short-circuit", () => {
  function seed(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // A doc that out-scores the named one on the query's words.
    store.upsertDoc(
      doc({
        id: "loud",
        slug: "deploy-notes",
        title: "Deploy pipeline pipeline",
        body: "pipeline pipeline pipeline deploy deploy deploy",
      })
    );
    store.upsertDoc(
      doc({ id: "named", slug: "pipeline-runbook", title: "Runbook", body: "Steps for the release." })
    );
    store.upsertDoc(
      doc({
        id: "private",
        projectId: "other",
        slug: "secret-runbook",
        title: "Secret",
        body: "pipeline",
        scope: "user",
        ownerUser: "bob",
      })
    );
    return db;
  }

  test("a query quoting a slug ranks that doc first without inflating its rawScore", async () => {
    const db = seed();
    const results = await searchKnowledge(db, "proj", "pipeline deploy `pipeline-runbook`", null);
    expect(results[0].id).toBe("named");
    expect(results.map((r) => r.id)).toContain("loud");
    const fused = (await searchKnowledge(db, "proj", "pipeline deploy pipeline-runbook", null)).find(
      (r) => r.id === "named"
    );
    expect(results[0].rawScore).toBe(fused?.rawScore);
  });

  test("a bare slug-shaped word inside a question does not name a doc", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "slugged", slug: "follow-up", title: "Follow-ups", body: "Ping the reviewer." }));
    store.upsertDoc(
      doc({ id: "relevant", slug: "retry-policy", title: "Retry policy", body: "Retry with jitter and backoff." })
    );
    const results = await searchKnowledge(db, "proj", "how do I follow-up on the retry policy jitter", null);
    expect(results[0].id).toBe("relevant");
  });

  test("a bare slug names a doc of the current project only; another project's is named by qualifying it", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "mine", slug: "notes", title: "Notes", body: "retry jitter guidance" }));
    store.upsertDoc(
      doc({ id: "theirs", projectId: "other", slug: "getting-started", title: "Getting started", body: "setup" })
    );
    const bare = await searchKnowledge(db, "proj", "`getting-started` retry jitter", null, { limit: 1 });
    expect(bare.map((r) => r.id)).toEqual(["mine"]);
    const qualified = await searchKnowledge(db, "proj", "other/getting-started retry jitter", null, { limit: 1 });
    expect(qualified.map((r) => r.id)).toEqual(["theirs"]);
  });

  test("the whole query being a slug, and a project/slug pair, both count", async () => {
    const db = seed();
    expect((await searchKnowledge(db, "proj", "pipeline-runbook", null))[0].id).toBe("named");
    expect((await searchKnowledge(db, "proj", "see `proj/pipeline-runbook`.", null))[0].id).toBe("named");
  });

  test("the short-circuit respects the scope gate and the corpus filter", async () => {
    const db = seed();
    const gated = await searchKnowledge(db, "proj", "secret-runbook", null, {
      audience: { projectId: "proj", user: "alice" },
    });
    expect(gated.map((r) => r.id)).not.toContain("private");
    const projectOnly = await searchKnowledge(db, "proj", "secret-runbook", null, { corpus: "project" });
    expect(projectOnly.map((r) => r.id)).not.toContain("private");
    const owner = await searchKnowledge(db, "proj", "other/secret-runbook", null, {
      audience: { projectId: "other", user: "bob" },
    });
    expect(owner[0].id).toBe("private");
  });

  test("a single ordinary word that happens to be a slug does not short-circuit", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "word", slug: "timeout", title: "Misc", body: "unrelated words" }));
    store.upsertDoc(doc({ id: "real", slug: "bun-fetch", title: "Bun fetch timeout", body: "the timeout is 360s" }));
    const results = await searchKnowledge(db, "proj", "what is the bun timeout", null);
    expect(results[0].id).toBe("real");
  });
});
