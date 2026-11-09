import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import { writeKnowledgeFile } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * Retrieval-usage telemetry (roadmap r3): a search over the real route records
 * a row per surfaced doc, and the usage read path returns it. Exercises the
 * HTTP handlers end-to-end (search records, usage reads) rather than the store
 * query in isolation, so the wiring — result → RetrievalRecord → GET — is
 * covered too. FTS-only (no embedding provider), which is what search runs on
 * in that configuration.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

describe("retrieval-usage telemetry routes", () => {
  test("a search records a retrieval row that the usage read returns", async () => {
    const store = createStore(":memory:");
    const projectId = `retr-test-${randomUUID().slice(0, 8)}`;
    upsertProject(store.db, { id: projectId, name: "Retr Test", branch: "main", repos: [] });

    const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-retr-"));
    cleanupDirs.push(knowledgeDir);

    // An accepted doc on disk whose body matches the query, so FTS recalls it.
    await writeKnowledgeFile(knowledgeDir, projectId, {
      slug: "widget-pipeline",
      title: "Widget Pipeline",
      body: "The widget pipeline flushes batches through the collector on a timer.",
    });

    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);
    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const searchRes = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/none", query: "widget pipeline", project: projectId }),
    });
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as { results: Array<{ slug: string }> };
    expect(searchJson.results.some((r) => r.slug === "widget-pipeline")).toBe(true);

    const usageRes = await app.request(`/api/knowledge/usage?projectId=${projectId}`);
    expect(usageRes.status).toBe(200);
    const usageJson = (await usageRes.json()) as {
      usage: Array<{ docProject: string; docSlug: string; retrievals: number; lastRetrievedAt: string }>;
    };
    const row = usageJson.usage.find((u) => u.docSlug === "widget-pipeline");
    expect(row).toBeDefined();
    expect(row!.docProject).toBe(projectId);
    expect(row!.retrievals).toBeGreaterThanOrEqual(1);
    expect(row!.lastRetrievedAt).toBeTruthy();

    // And the same usage is folded into the stats read path.
    const statsRes = await app.request(`/api/knowledge/stats?projectId=${projectId}`);
    const statsJson = (await statsRes.json()) as {
      retrievalUsage: Array<{ docSlug: string }>;
    };
    expect(statsJson.retrievalUsage.some((u) => u.docSlug === "widget-pipeline")).toBe(true);

    store.close();
  });
});
