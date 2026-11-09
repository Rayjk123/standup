import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { EMBEDDING_BLOB_BACKFILL_BATCH, KnowledgeStore } from "./store.js";
import { blobToEmbedding, chunkEmbedding, embeddingToBlob } from "./vec.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * Chunk vectors are stored as little-endian float32 blobs; a row that still
 * carries only its JSON vector reads through the fallback until the backfill
 * converts it.
 */

function doc(id: string): KnowledgeDoc {
  return {
    id,
    projectId: "proj",
    slug: id,
    title: `Title ${id}`,
    body: `body of ${id}`,
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: `/x/${id}.md`,
    originClass: "owner",
  };
}

const f32 = (v: number[]) => Array.from(new Float32Array(v));

function chunkRow(db: Database, id: string) {
  return db
    .query("SELECT embedding_blob AS b, embedding_json AS j FROM knowledge_chunks WHERE id = ?")
    .get(id) as { b: Uint8Array | null; j: string };
}

/** Writes a chunk the way a build without the blob column did: JSON vector, no blob. */
function insertJsonChunk(db: Database, id: string, knowledgeId: string, index: number, json: string): void {
  db.run(
    "INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json) VALUES (?, ?, ?, ?, ?)",
    [id, knowledgeId, index, `chunk ${index}`, json]
  );
}

describe("chunk embedding codec", () => {
  test.each([
    ["unit axis", [1, 0, 0]],
    ["mixed signs", [0.1, -0.25, 3.5, -1e-3]],
    ["single value", [0.5]],
    ["empty", []],
  ])("%s round-trips through the float32 blob", (_name, vector) => {
    expect(blobToEmbedding(embeddingToBlob(vector))).toEqual(f32(vector));
  });

  test("a blob at an unaligned offset decodes the same", () => {
    const blob = embeddingToBlob([0.1, 0.2, 0.3]);
    const padded = new Uint8Array(blob.byteLength + 1);
    padded.set(blob, 1);
    expect(blobToEmbedding(padded.subarray(1))).toEqual(f32([0.1, 0.2, 0.3]));
  });

  test.each([
    ["blob wins over JSON", embeddingToBlob([1, 2]), "[9,9]", [1, 2]],
    ["JSON when no blob", null, "[0.5,0.25]", [0.5, 0.25]],
    ["JSON when the blob is empty", new Uint8Array(0), "[3]", [3]],
    ["nothing readable", null, "", null],
    ["unparseable JSON", null, "not json", null],
    ["JSON that is not a vector", null, '{"a":1}', null],
  ])("chunkEmbedding: %s", (_name, blob, json, expected) => {
    expect(chunkEmbedding(blob as Uint8Array | null, json as string)).toEqual(expected as number[] | null);
  });
});

describe("KnowledgeStore chunk vectors", () => {
  test("upsertChunk writes the blob and parseable JSON; every reader decodes it", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d1"));
    const vector = [0.1, -0.2, 0.3];
    store.upsertChunk({ id: "c1", knowledgeId: "d1", chunkIndex: 0, text: "chunk", embedding: vector });

    const row = chunkRow(db, "c1");
    expect(JSON.parse(row.j)).toEqual(vector);
    expect(row.b!.byteLength).toBe(12);
    expect(store.getChunks("d1")[0]!.embedding).toEqual(f32(vector));
    expect(store.sampleChunks(1)[0]!.embedding).toEqual(f32(vector));
    expect(store.storedChunkDimensions()).toBe(3);
    expect(store.getStats().dimensions).toBe(3);
  });

  test("a chunk with only a JSON vector reads through the fallback", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d1"));
    insertJsonChunk(db, "legacy", "d1", 0, "[0.5,0.25,0.125,1]");

    expect(store.getChunks("d1")[0]!.embedding).toEqual([0.5, 0.25, 0.125, 1]);
    expect(store.sampleChunks(1)[0]!.embedding).toEqual([0.5, 0.25, 0.125, 1]);
    expect(store.storedChunkDimensions()).toBe(4);
  });

  test("re-embedding a JSON-only chunk replaces it with a blob", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d1"));
    insertJsonChunk(db, "legacy", "d1", 0, "[1,0]");
    store.upsertChunk({ id: "fresh", knowledgeId: "d1", chunkIndex: 0, text: "chunk", embedding: [0, 1] });

    const row = chunkRow(db, "legacy");
    expect(JSON.parse(row.j)).toEqual([0, 1]);
    expect(blobToEmbedding(row.b!)).toEqual([0, 1]);
  });
});

describe("KnowledgeStore.backfillEmbeddingBlobs", () => {
  test("converts every JSON row across batches, keeps the vectors, and is idempotent", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const total = EMBEDDING_BLOB_BACKFILL_BATCH * 2 + 7;
    const expected = new Map<string, number[]>();
    db.transaction(() => {
      for (let d = 0; d < total; d++) {
        store.upsertDoc(doc(`d${d}`));
        const vector = [d / total, -0.5, 0.1 * (d % 7)];
        expected.set(`c${d}`, vector);
        insertJsonChunk(db, `c${d}`, `d${d}`, 0, JSON.stringify(vector));
      }
    })();
    const generation = () =>
      (db.query("SELECT chunk_generation AS g FROM knowledge_graph_meta WHERE id = 0").get() as { g: number }).g;
    const before = generation();

    expect(store.backfillEmbeddingBlobs()).toBe(total);
    for (const [id, vector] of expected) {
      const row = chunkRow(db, id);
      // The JSON stays parseable and agrees with the blob, so a reader of
      // embedding_json alone still sees the same vector.
      expect(JSON.parse(row.j)).toEqual(vector);
      expect(f32(JSON.parse(row.j))).toEqual(blobToEmbedding(row.b!));
      expect(blobToEmbedding(row.b!)).toEqual(f32(vector));
    }
    // The vectors did not change, so nothing derived from them is invalidated.
    expect(generation()).toBe(before);

    expect(store.backfillEmbeddingBlobs()).toBe(0);
  });

  test("an unreadable JSON vector is left in place and does not stall the pass", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d1"));
    store.upsertDoc(doc("d2"));
    insertJsonChunk(db, "bad", "d1", 0, "not json");
    insertJsonChunk(db, "good", "d2", 0, "[1,2]");

    expect(store.backfillEmbeddingBlobs()).toBe(1);
    expect(chunkRow(db, "bad")).toEqual({ b: null, j: "not json" });
    expect(blobToEmbedding(chunkRow(db, "good").b!)).toEqual([1, 2]);
    expect(store.backfillEmbeddingBlobs()).toBe(0);
  });

  test("a database whose chunk table predates the blob column gets it and is converted on open", () => {
    const db = new Database(":memory:");
    const first = new KnowledgeStore(db);
    first.upsertDoc(doc("d1"));
    insertJsonChunk(db, "legacy", "d1", 0, "[0.25,0.75]");
    db.exec("ALTER TABLE knowledge_chunks DROP COLUMN embedding_blob");

    const reopened = new KnowledgeStore(db);
    const columns = (db.query("PRAGMA table_info(knowledge_chunks)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(columns).toContain("embedding_blob");
    expect(JSON.parse(chunkRow(db, "legacy").j)).toEqual([0.25, 0.75]);
    expect(blobToEmbedding(chunkRow(db, "legacy").b!)).toEqual([0.25, 0.75]);
    expect(reopened.getChunks("d1")[0]!.embedding).toEqual([0.25, 0.75]);
  });

  test("a blob-only row with emptied JSON gets its JSON vector back from the blob", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc("d1"));
    store.upsertChunk({ id: "c1", knowledgeId: "d1", chunkIndex: 0, text: "chunk", embedding: [0.5, -0.25] });
    db.run("UPDATE knowledge_chunks SET embedding_json = '' WHERE id = 'c1'");

    expect(store.backfillEmbeddingBlobs()).toBe(1);
    const row = chunkRow(db, "c1");
    expect(JSON.parse(row.j)).toEqual(blobToEmbedding(row.b!));
    expect(JSON.parse(row.j)).toEqual([0.5, -0.25]);
    expect(store.backfillEmbeddingBlobs()).toBe(0);
  });
});
