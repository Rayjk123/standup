import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_IDENTITY_HEADER } from "@standup/shared";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer } from "./server.js";
import { activeOwnerSecrets } from "./owner-secret.js";
import { STANDUP_PROJECT_ID, STANDUP_SELF_PROJECT_ID } from "./projects-registry.js";
import { resetSessionProjectCaches } from "./session-project.js";

/**
 * POST /api/knowledge/search reads the reserved `standup-self` copy project as
 * an alias of `standup` (one result per content), and never hands an agent a
 * superseded doc; the browse path shows one only when asked.
 */

const QUERY = "mirrormarker chunking overlap";
const BODY = "The mirrormarker chunker splits a body into 512 character pieces with a ten word chunking overlap.";

const signedIn = (alias: string): Record<string, string> => ({
  [DEFAULT_IDENTITY_HEADER]: alias,
  [USER_CHANNEL_HEADER]: userChannelToken(activeOwnerSecrets().ownerToken, alias),
});

function doc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: STANDUP_PROJECT_ID,
    slug: "doc",
    title: "Chunking",
    body: BODY,
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    sourceKind: "decision",
    originClass: "owner",
    scope: "global",
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  resetSessionProjectCaches();
});

function setUp(): { store: Store; app: ReturnType<typeof createServer>; knowledge: KnowledgeStore } {
  const store = createStore(":memory:");
  cleanups.push(() => store.close());
  upsertProject(store.db, { id: STANDUP_PROJECT_ID, name: "Standup", branch: "main", repos: [] });
  upsertProject(store.db, { id: STANDUP_SELF_PROJECT_ID, name: "Standup (self-fix)", branch: "main", repos: [], reserved: true });
  upsertProject(store.db, { id: "other", name: "Other", branch: "main", repos: [] });
  const knowledge = new KnowledgeStore(store.db);
  knowledge.upsertDoc(doc({ slug: "chunking-strategy" }));
  knowledge.upsertDoc(doc({ projectId: STANDUP_SELF_PROJECT_ID, slug: "chunking-strategy" }));
  knowledge.upsertDoc(
    doc({ projectId: "other", slug: "old-chunking", title: "Old chunking", body: `${BODY} Superseded wording.` })
  );
  knowledge.setDocVerdict("other", "old-chunking", "superseded", [
    { claim: "Superseded by standup/chunking-strategy", finding: "", evidence: "" },
  ]);
  for (let i = 0; i < 4; i++) {
    knowledge.upsertDoc(doc({ projectId: "other", slug: `filler-${i}`, title: `Filler ${i}`, body: `unrelated note ${i}` }));
  }
  return { store, app: createServer(store, () => {}, null), knowledge };
}

async function search(
  app: ReturnType<typeof createServer>,
  body: Record<string, unknown>
): Promise<Array<{ slug: string; projectId: string; verdict?: string }>> {
  const res = await app.request("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedIn("alice") },
    body: JSON.stringify({ cwd: "/tmp/kb-search-mirror-none", query: QUERY, project: STANDUP_PROJECT_ID, ...body }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: Array<{ slug: string; projectId: string; verdict?: string }> }).results;
}

describe("POST /api/knowledge/search — mirrors and superseded docs", () => {
  test("an agent search returns the mirrored doc once, from the canonical project", async () => {
    const { app } = setUp();
    const results = await search(app, { scoped: true });
    expect(results.filter((r) => r.slug === "chunking-strategy").map((r) => r.projectId)).toEqual([STANDUP_PROJECT_ID]);
  });

  test("the browse search collapses the mirror too", async () => {
    const { app } = setUp();
    const results = await search(app, {});
    expect(results.filter((r) => r.slug === "chunking-strategy").map((r) => r.projectId)).toEqual([STANDUP_PROJECT_ID]);
  });

  test("a superseded doc never reaches an agent, even when asked for", async () => {
    const { app } = setUp();
    for (const corpus of ["all", "project"]) {
      const results = await search(app, { scoped: true, corpus, includeSuperseded: true });
      expect(results.some((r) => r.slug === "old-chunking")).toBe(false);
    }
  });

  test("a project search from the mirror counts its canonical project's docs as its corpus, and does not widen", async () => {
    const store = createStore(":memory:");
    cleanups.push(() => store.close());
    upsertProject(store.db, { id: STANDUP_PROJECT_ID, name: "Standup", branch: "main", repos: [] });
    upsertProject(store.db, { id: STANDUP_SELF_PROJECT_ID, name: "Standup (self-fix)", branch: "main", repos: [], reserved: true });
    upsertProject(store.db, { id: "other", name: "Other", branch: "main", repos: [] });
    const knowledge = new KnowledgeStore(store.db);
    knowledge.upsertDoc(doc({ slug: "chunking-strategy", scope: "project" }));
    knowledge.upsertDoc(doc({ projectId: "other", slug: "other-chunking", scope: "project" }));
    const app = createServer(store, () => {}, null);
    const res = await app.request("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn("alice") },
      body: JSON.stringify({
        cwd: "/tmp/kb-search-mirror-none",
        query: QUERY,
        project: STANDUP_SELF_PROJECT_ID,
        corpus: "project",
        scoped: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      corpus?: string;
      corpusFallback?: string;
      results: Array<{ slug: string; projectId: string }>;
    };
    expect(body.corpusFallback).toBeUndefined();
    expect(body.corpus).toBe("project");
    expect(body.results.map((r) => `${r.projectId}/${r.slug}`)).toEqual([`${STANDUP_PROJECT_ID}/chunking-strategy`]);
  });

  test("the browse search shows a superseded doc only on request, marked by its verdict", async () => {
    const { app } = setUp();
    expect((await search(app, {})).some((r) => r.slug === "old-chunking")).toBe(false);
    const shown = (await search(app, { includeSuperseded: true })).find((r) => r.slug === "old-chunking");
    expect(shown?.verdict).toBe("superseded");
  });
});
