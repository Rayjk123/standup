import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CO_CITATION_AMBIGUOUS_TAGS,
  PROVENANCE_MAX_FANOUT,
  compileGraph,
  deriveEdges,
  docVectorsFromStore,
} from "../graph.js";
import { KnowledgeStore } from "../store.js";
import { EVAL_EMBED_PROVIDER_ID, EvalEmbeddings, installEvalEmbeddingProvider } from "./embedding-cache.js";
import { buildRetrievalFixture } from "./fixture.js";

const EVAL_DIR = join(import.meta.dir, "..", "..", "eval");
const CACHE_COMMITTED = existsSync(join(EVAL_DIR, "embeddings", "cache.bin"));

/**
 * The compiled graph over the retrieval fixture corpus, embedded from the
 * committed caches only (no fetch), so the per-kind edge counts are a fixed
 * property of the corpus and the graph derivation. Without a committed cache
 * the graph is built from tags and provenance alone, and the test says so.
 */
describe("fixture corpus graph", () => {
  test("edge counts by kind", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "kb-graph-fixture-"));
    const embeddings = new EvalEmbeddings({
      baseDir: join(EVAL_DIR, "embeddings"),
      harnessDir: join(EVAL_DIR, "retrieval", "embeddings"),
      fetchMissing: false,
    });
    const restoreProvider = installEvalEmbeddingProvider(embeddings);
    const env = await buildRetrievalFixture({
      corpusDir: join(EVAL_DIR, "corpus"),
      fixtureRepoDir: join(EVAL_DIR, "fixture-repo"),
      workDir,
      embeddingProvider: EVAL_EMBED_PROVIDER_ID,
    });
    try {
      const store = new KnowledgeStore(env.db);
      const edges = compileGraph(store);
      const byKind: Record<string, number> = {};
      for (const e of edges) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      console.log(`fixture graph edges by kind: ${JSON.stringify(byKind)}`);

      // The co-citation pairs the ambiguous-tag stoplist and the per-tag cosine
      // floor remove, against the global floor alone.
      const docs = store.getAllDocs();
      const slugOf = new Map(docs.map((d) => [d.id, `${d.projectId}/${d.slug}`]));
      const docVectors = docVectorsFromStore(store);
      console.log(`fixture docs with a vector: ${docVectors.size} of ${docs.length}`);
      if (CACHE_COMMITTED) {
        // With the caches committed, the docs are embedded, so the cosine floors
        // and the semantic edges are part of what this test measures.
        expect(docVectors.size).toBeGreaterThan(0);
      } else {
        console.warn(
          "[graph-edges] eval/embeddings/cache.bin is not committed: the graph is built without vectors, " +
            "so the co-citation cosine floor and semantic edges go unmeasured (see eval/FORMAT.md, re-recording the references)"
        );
      }
      const kept = new Set(edges.filter((e) => e.kind === "co-citation").map((e) => e.id));
      const unpruned = deriveEdges(docs, {
        docVectors,
        coCitationAmbiguousTags: new Set(),
      }).filter((e) => e.kind === "co-citation");
      for (const e of unpruned) {
        if (!kept.has(e.id)) console.log(`  stoplist-pruned: ${slugOf.get(e.srcDocId)} ~ ${slugOf.get(e.dstDocId)} (${e.evidence})`);
      }

      expect(byKind["co-citation"]).toBeGreaterThan(0);
      expect(byKind["provenance"]).toBeGreaterThan(0);
      for (const e of edges.filter((x) => x.kind === "co-citation")) {
        const tags = e.evidence!.replace("shared tags: ", "").split(", ");
        expect(tags.every((t) => CO_CITATION_AMBIGUOUS_TAGS.has(t))).toBe(false);
      }
      const provDegree = new Map<string, number>();
      for (const e of edges.filter((x) => x.kind === "provenance")) {
        provDegree.set(e.srcDocId, (provDegree.get(e.srcDocId) ?? 0) + 1);
        provDegree.set(e.dstDocId, (provDegree.get(e.dstDocId) ?? 0) + 1);
      }
      expect(Math.max(...provDegree.values())).toBeLessThanOrEqual(PROVENANCE_MAX_FANOUT);
    } finally {
      env.close();
      restoreProvider();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
