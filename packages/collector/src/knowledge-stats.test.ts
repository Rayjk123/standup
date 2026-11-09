import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * GET /api/knowledge/stats, /graph and /eval, driven over the real HTTP handler
 * against markdown on disk. These endpoints reconcile disk (syncAll) and
 * recompile edges on read, so a small seeded corpus exercises the full path the
 * Knowledge tab's Health/Graph panels consume.
 */

const P1 = `stats-p1-${randomUUID().slice(0, 8)}`;
const P2 = `stats-p2-${randomUUID().slice(0, 8)}`;

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

// Two projects, a cross-project `related` link p1/arch -> p2/intent, plus a
// second p1 doc so per-project doc counts differ.
async function tempKnowledgeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "standup-knowledge-stats-"));
  cleanupDirs.push(dir);
  await mkdir(join(dir, P1), { recursive: true });
  await mkdir(join(dir, P2), { recursive: true });
  await writeFile(
    join(dir, P1, "arch.md"),
    `---\ntitle: Architecture\norigin_class: owner\nrelated:\n  - ${P2}/intent\n---\n\nArchitecture notes about the async engine.\n`
  );
  await writeFile(
    join(dir, P1, "practices.md"),
    `---\ntitle: Practices\norigin_class: owner\n---\n\nCoding practices for this project.\n`
  );
  await writeFile(
    join(dir, P2, "intent.md"),
    `---\ntitle: Intent\norigin_class: owner\n---\n\nWhy this project exists.\n`
  );
  return dir;
}

function setUpStore(): Store {
  const store = createStore(":memory:");
  for (const [id, name] of [
    [P1, "Stats P1"],
    [P2, "Stats P2"],
  ]) {
    upsertProject(store.db, { id, name, branch: "main", repos: [] });
  }
  return store;
}

describe("GET /api/knowledge/stats", () => {
  test("returns the documented shape with corpus counts over the live store", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/stats");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      docs: number;
      chunks: number;
      embeddedDocs: number;
      coveragePct: number;
      edges: number;
      edgesPerDoc: number;
      provider: string | null;
      model: string | null;
      dimensions: number | null;
      originClassBreakdown: Record<string, number>;
      perProject: Array<{ projectId: string; docs: number; chunks: number; coveragePct: number; edges: number }>;
    };

    expect(json.docs).toBe(3);
    // No embedding provider in this test — text-only, so no chunks/embeddings.
    expect(json.embeddedDocs).toBe(0);
    expect(json.chunks).toBe(0);
    // Two directed related edges (p1/arch -> p2/intent both directions once the
    // frontmatter link is compiled); at least the one authored link is present.
    expect(json.edges).toBeGreaterThanOrEqual(1);
    expect(json.provider).toBeNull();
    expect(json.model).toBeNull();
    expect(json.dimensions).toBeNull();
    // Every doc is owner-authored in the fixtures.
    expect(json.originClassBreakdown.owner).toBe(3);

    const byId = Object.fromEntries(json.perProject.map((p) => [p.projectId, p]));
    expect(byId[P1].docs).toBe(2);
    expect(byId[P2].docs).toBe(1);

    store.close();
  });

  test("projectId scopes the counts to one project", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/knowledge/stats?projectId=${P1}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      docs: number;
      perProject: Array<{ projectId: string }>;
    };
    expect(json.docs).toBe(2);
    expect(json.perProject).toHaveLength(1);
    expect(json.perProject[0].projectId).toBe(P1);

    store.close();
  });
});

describe("GET /api/knowledge/graph", () => {
  test("returns nodes and the cross-project edge in the documented shape", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/graph");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      nodes: Array<{
        id: string;
        slug: string;
        title: string;
        projectId: string;
        originClass: string;
        layer: string;
        confidence?: number;
        stale: boolean;
      }>;
      edges: Array<{ source: string; target: string; kind: string; weight: number }>;
    };

    expect(json.nodes).toHaveLength(3);
    const arch = json.nodes.find((n) => n.slug === "arch")!;
    expect(arch.projectId).toBe(P1);
    expect(arch.originClass).toBe("owner");
    // Each node carries its layer and the freshness gate's current judgment.
    expect(arch.layer).toBeString();
    expect(arch.confidence).toBeNumber();
    expect(arch.confidence!).toBeGreaterThan(0);
    expect(arch.stale).toBe(false);

    const relatedEdge = json.edges.find((e) => e.kind === "related")!;
    expect(relatedEdge).toBeDefined();
    // Endpoints are doc ids that resolve to nodes in the graph.
    const ids = new Set(json.nodes.map((n) => n.id));
    expect(ids.has(relatedEdge.source)).toBe(true);
    expect(ids.has(relatedEdge.target)).toBe(true);

    store.close();
  });

  test("projectId scopes nodes and drops half-edges to filtered-out docs", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request(`/api/knowledge/graph?projectId=${P1}`);
    const json = (await res.json()) as {
      nodes: Array<{ projectId: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(json.nodes.every((n) => n.projectId === P1)).toBe(true);
    // The only authored edge points at P2/intent, out of scope — no dangling edge.
    expect(json.edges).toEqual([]);

    store.close();
  });
});

describe("GET /api/knowledge/eval", () => {
  test("runs the fixtures through the real search path and returns recall/top-1", async () => {
    const store = setUpStore();
    const knowledgeDir = await tempKnowledgeDir();
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const res = await app.request("/api/knowledge/eval");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      k: number;
      total: number;
      recallAtK: number;
      top1: number;
      perFixture: Array<{ query: string; hitAtK: boolean }>;
    };

    expect(json.k).toBe(5);
    expect(json.total).toBeGreaterThan(0);
    expect(json.perFixture).toHaveLength(json.total);
    // The recall metrics are in [0, 1]. This corpus doesn't contain the fixture
    // docs, so the scores are honestly low — the shape and range are what the
    // endpoint contract guarantees.
    expect(json.recallAtK).toBeGreaterThanOrEqual(0);
    expect(json.recallAtK).toBeLessThanOrEqual(1);
    expect(json.top1).toBeGreaterThanOrEqual(0);
    expect(json.top1).toBeLessThanOrEqual(1);

    store.close();
  });
});
