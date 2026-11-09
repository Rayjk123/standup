import { expect, test, describe, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, readFile } from "fs/promises";
import { writeKnowledgeFile } from "./writer.js";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeStore } from "./store.js";
import { LocalMarkdownBackend } from "./backend.js";
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

// The MCP graph_neighbors tool proxies POST /api/knowledge/neighbors, which
// calls backend.compile() then backend.neighbors(docId). These exercise that
// exact seam — the interface the collector talks to — rather than the store
// method underneath it (covered in graph.test.ts).
describe("LocalMarkdownBackend graph neighbors", () => {
  // A pair joined by more than one edge is where naive both-directions
  // traversal double-counts: authors who name each other in `related` store
  // two directed edges (A->B and B->A), and a shared tag adds a co-citation —
  // three edges all touching the pair. Walking both ends of each edge without
  // dedup surfaces the far doc three times (twice as an identical `related`
  // row). Exercised through compile()+neighbors() — the exact seam the
  // collector's POST /api/knowledge/neighbors talks to.
  test("collapses a multi-edge pair to one neighbor per kind, across projects", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "a", projectId: "p1", slug: "arch", related: ["p2/intent"], tags: ["auth"] })
    );
    store.upsertDoc(
      doc({ id: "b", projectId: "p2", slug: "intent", title: "Intent", related: ["p1/arch"], tags: ["auth"] })
    );

    const backend = new LocalMarkdownBackend(db);
    backend.compile();

    const neighbors = backend.neighbors("a");
    // Every row is the far doc in the other project — no self, no ghosts.
    expect(neighbors.every((n) => n.docId === "b" && n.projectId === "p2")).toBe(true);
    // The reciprocal `related` edges collapse to a single `related` row; the
    // shared tag stays a distinct `co-citation` row. Two rows, not three.
    expect(neighbors).toHaveLength(2);
    expect(neighbors.filter((n) => n.kind === "related")).toHaveLength(1);
    expect(neighbors.filter((n) => n.kind === "co-citation")).toHaveLength(1);
  });

  test("a shared tag surfaces as a co-citation neighbor with its overlap weight", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "a", tags: ["auth", "retry"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p2", slug: "b", tags: ["auth", "retry"] }));

    const backend = new LocalMarkdownBackend(db);
    backend.compile();

    const neighbors = backend.neighbors("a");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].docId).toBe("b");
    expect(neighbors[0].kind).toBe("co-citation");
    expect(neighbors[0].weight).toBe(2);
  });

  test("a doc with no edges has no neighbors", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "lonely", projectId: "p1", slug: "lonely" }));

    const backend = new LocalMarkdownBackend(db);
    backend.compile();

    expect(backend.neighbors("lonely")).toEqual([]);
  });
});

// The WRITE side of the seam. Both /api/knowledge/propose and the draft-edit
// route now call backend.writeDraft rather than writeDraftFile directly, so an
// auto-ingester or a future gateway backend captures proposals through the same
// interface it serves reads from. These exercise that method on the concrete
// local backend.
describe("LocalMarkdownBackend writeDraft", () => {
  const cleanupDirs: string[] = [];
  afterAll(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  });

  test("writes a proposal as a draft that stays invisible to the read seam", async () => {
    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-backend-writedraft-"));
    cleanupDirs.push(knowledgeDir);
    const db = new Database(":memory:");
    // The store must exist for the read-seam methods to have their tables.
    new KnowledgeStore(db);
    const backend = new LocalMarkdownBackend(db, null, {}, knowledgeDir);

    await backend.writeDraft("proj", {
      slug: "learned",
      title: "Learned",
      body: "A proposal captured through the backend seam.",
      originClass: "agent",
      sourceSessionId: "sess-1",
    });

    // The draft landed under .drafts/ with its provenance, carried by the seam.
    const raw = await readFile(join(knowledgeDir, "proj", ".drafts", "learned.md"), "utf-8");
    expect(raw).toContain("captured through the backend seam");
    expect(raw).toMatch(/origin_class: ?["']?agent/);
    expect(raw).toMatch(/source_session_id: ?["']?sess-1/);

    // A proposal only ever creates a draft: the read side of the same seam does
    // not surface it until a human accepts it.
    expect(backend.getDoc("proj", "learned")).toBeNull();
    const results = await backend.search("proj", "learned proposal seam");
    expect(results.find((r) => r.slug === "learned")).toBeUndefined();

    db.close();
  });

  test("rejects an invalid slug the same as writeDraftFile", async () => {
    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-backend-writedraft-"));
    cleanupDirs.push(knowledgeDir);
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const backend = new LocalMarkdownBackend(db, null, {}, knowledgeDir);

    await expect(
      backend.writeDraft("proj", { slug: "not a slug!", title: "x", body: "x" })
    ).rejects.toThrow(/slug/i);

    db.close();
  });
});

// readAcceptedDoc is the seam's AUTHORITATIVE read — the ground-truth source,
// not the rebuildable SQLite index that getDoc reads. The propose path's
// replaces-slug data-loss guard depends on that distinction, so these pin the
// two apart: an accepted doc present on disk but absent from the index must
// still be seen by readAcceptedDoc (or a stale index would drop the guard and
// let a proposal silently overwrite a human-authored doc on accept).
describe("LocalMarkdownBackend readAcceptedDoc", () => {
  const cleanupDirs: string[] = [];
  afterAll(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
  });

  test("reads an accepted doc from disk even when the index is empty", async () => {
    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-backend-readaccepted-"));
    cleanupDirs.push(knowledgeDir);
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const backend = new LocalMarkdownBackend(db, null, {}, knowledgeDir);

    // The doc is on disk (ground truth) but never indexed, the exact staleness
    // the guard has to survive: a post-boot / externally-created accepted doc.
    await writeKnowledgeFile(knowledgeDir, "proj", {
      slug: "arch",
      title: "Architecture",
      body: "The authoritative accepted doc, present on disk only.",
    });

    // getDoc consults the index and misses it — the failure mode the pre-fix
    // getDoc-based check had.
    expect(backend.getDoc("proj", "arch")).toBeNull();

    // readAcceptedDoc reads the source of truth and finds it.
    const accepted = await backend.readAcceptedDoc("proj", "arch");
    expect(accepted?.slug).toBe("arch");
    expect(accepted?.body).toContain("present on disk only");

    db.close();
  });

  test("returns null when no accepted doc exists for the slug", async () => {
    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-backend-readaccepted-"));
    cleanupDirs.push(knowledgeDir);
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const backend = new LocalMarkdownBackend(db, null, {}, knowledgeDir);

    expect(await backend.readAcceptedDoc("proj", "missing")).toBeNull();

    db.close();
  });
});
