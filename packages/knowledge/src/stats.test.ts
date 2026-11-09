import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { compileGraph } from "./graph.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "projectId" | "slug">): KnowledgeDoc {
  return {
    id: overrides.id ?? `${overrides.projectId}/${overrides.slug}`,
    title: overrides.title ?? overrides.slug,
    body: overrides.body ?? "body text",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: `/x/${overrides.projectId}/${overrides.slug}.md`,
    originClass: "owner",
    ...overrides,
  };
}

describe("KnowledgeStore.getStats", () => {
  function seed(): KnowledgeStore {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // p1: two docs, one embedded (with two chunks), one not; related link a->b.
    // The embedded doc carries no doc-level embedding — the real ingest path
    // writes vectors only into knowledge_chunks, so coverage must derive from
    // chunk presence.
    store.upsertDoc(doc({ projectId: "p1", slug: "a", related: ["b"] }));
    store.upsertDoc(doc({ projectId: "p1", slug: "b" }));
    store.upsertChunk({ id: "c1", knowledgeId: "p1/a", chunkIndex: 0, text: "x", embedding: [1, 2, 3] });
    store.upsertChunk({ id: "c2", knowledgeId: "p1/a", chunkIndex: 1, text: "y", embedding: [4, 5, 6] });
    // p2: one doc, untrusted, no chunks.
    store.upsertDoc(doc({ projectId: "p2", slug: "c", originClass: "untrusted" }));
    compileGraph(store);
    return store;
  }

  test("unscoped counts span the whole corpus", () => {
    const s = seed().getStats();
    expect(s.docs).toBe(3);
    expect(s.chunks).toBe(2);
    expect(s.embeddedDocs).toBe(1);
    expect(s.coveragePct).toBeCloseTo((1 / 3) * 100, 5);
    // One directed related edge a->b.
    expect(s.edges).toBe(1);
    expect(s.edgesPerDoc).toBeCloseTo(1 / 3, 5);
    expect(s.dimensions).toBe(3);
  });

  test("origin_class breakdown counts every doc and sums to docs", () => {
    const s = seed().getStats();
    expect(s.originClassBreakdown).toEqual({ owner: 2, untrusted: 1 });
    const total = Object.values(s.originClassBreakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(s.docs);
  });

  test("perProject breaks the corpus down by project when unscoped", () => {
    const s = seed().getStats();
    const byId = Object.fromEntries(s.perProject.map((p) => [p.projectId, p]));
    expect(byId.p1.docs).toBe(2);
    expect(byId.p1.chunks).toBe(2);
    expect(byId.p2.docs).toBe(1);
    expect(byId.p2.chunks).toBe(0);
    // The a->b edge touches two p1 docs; counted once.
    expect(byId.p1.edges).toBe(1);
    expect(byId.p2.edges).toBe(0);
  });

  test("a projectId scopes the scalars and collapses perProject to that project", () => {
    const s = seed().getStats("p1");
    expect(s.docs).toBe(2);
    expect(s.chunks).toBe(2);
    expect(s.perProject).toHaveLength(1);
    expect(s.perProject[0].projectId).toBe("p1");
  });

  test("an empty corpus reports zeros, not NaN or a divide-by-zero", () => {
    const db = new Database(":memory:");
    const s = new KnowledgeStore(db).getStats();
    expect(s.docs).toBe(0);
    expect(s.coveragePct).toBe(0);
    expect(s.edgesPerDoc).toBe(0);
    expect(s.dimensions).toBeNull();
    expect(s.perProject).toEqual([]);
  });
});

describe("KnowledgeStore.getGraph", () => {
  function seed(): KnowledgeStore {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ projectId: "p1", slug: "arch", title: "Arch", related: ["p2/intent"] }));
    store.upsertDoc(doc({ projectId: "p2", slug: "intent", title: "Intent" }));
    compileGraph(store);
    return store;
  }

  test("unscoped graph carries every node and the cross-project edge", () => {
    const g = seed().getGraph();
    expect(g.nodes.map((n) => n.slug).sort()).toEqual(["arch", "intent"]);
    const arch = g.nodes.find((n) => n.slug === "arch")!;
    expect(arch.projectId).toBe("p1");
    expect(arch.originClass).toBe("owner");

    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].source).toBe("p1/arch");
    expect(g.edges[0].target).toBe("p2/intent");
    expect(g.edges[0].kind).toBe("related");
  });

  test("scoping to one project drops edges whose far end is filtered out", () => {
    const g = seed().getGraph("p1");
    expect(g.nodes.map((n) => n.slug)).toEqual(["arch"]);
    // The only edge points at p2/intent, which is out of scope, so no half-edge
    // into nothing survives.
    expect(g.edges).toEqual([]);
  });

  test("a pair stored in both directions under one kind is one graph edge; different kinds stay separate", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ projectId: "p1", slug: "a" }));
    store.upsertDoc(doc({ projectId: "p1", slug: "b" }));
    store.replaceAllEdges([
      { id: "contradicts:a:b", srcDocId: "p1/a", dstDocId: "p1/b", kind: "contradicts", weight: 1, evidence: "x" },
      { id: "contradicts:b:a", srcDocId: "p1/b", dstDocId: "p1/a", kind: "contradicts", weight: 2, evidence: "x" },
      { id: "related:a:b", srcDocId: "p1/a", dstDocId: "p1/b", kind: "related", weight: 1 },
    ]);

    const g = store.getGraph();
    expect(g.edges.map((e) => e.kind).sort()).toEqual(["contradicts", "related"]);
    expect(g.edges.find((e) => e.kind === "contradicts")!.weight).toBe(2);
  });
});
