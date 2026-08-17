import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import { writeDraftFile, writeKnowledgeFile, readKnowledgeFile } from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * The Step 5 review-UI routes (phase-7.md): GET/PUT/accept/discard/accept-all
 * over knowledge_drafts. Exercises them directly against the running app,
 * not just the pure decision helpers in draft-accept.test.ts — a green
 * unit test for resolveAcceptMode proves nothing about whether the route
 * actually wires it up correctly.
 */

function projectId(): string {
  return `draft-routes-test-${randomUUID().slice(0, 8)}`;
}

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-draft-routes-"));
}

function setUp(id: string): { store: Store } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id, name: "Draft Routes Test", branch: "main", repos: [] });
  return { store };
}

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("route ordering: GET .../knowledge/drafts is not swallowed by the :slug route", () => {
  test("returns the drafts array, not a 404 for a doc literally named 'drafts'", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts`);

    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ slug: string }>;
    expect(Array.isArray(json)).toBe(true);
    expect(json.find((d) => d.slug === "gotchas")).toBeTruthy();

    store.close();
  });
});

describe("PUT .../knowledge/drafts/:slug", () => {
  test("edit resets a disputed verdict back to unverified with no disputes", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "v1" });
    await knowledgeSync.syncDrafts(id);
    knowledgeSync.recordDraftVerdict(id, "gotchas", "disputed", [
      { claim: "v1 has 200 errors", finding: "no such count exists", evidence: "bun run typecheck" },
    ]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    const before = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; verdict: string }>;
    expect(before.find((d) => d.slug === "gotchas")?.verdict).toBe("disputed");

    const putRes = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Gotchas", body: "v2 — corrected" }),
    });
    expect(putRes.status).toBe(200);

    const after = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; body: string; verdict: string; disputes: unknown[] }>;
    const gotchas = after.find((d) => d.slug === "gotchas")!;
    expect(gotchas.body).toBe("v2 — corrected");
    expect(gotchas.verdict).toBe("unverified");
    expect(gotchas.disputes).toEqual([]);

    store.close();
  });

  test("preserves provenance frontmatter across an edit rather than dropping it", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, {
      slug: "toolchain",
      title: "Toolchain",
      body: "v1",
      generatedFromSha: "abc123",
      generatedByLaunchId: "launch-1",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    await app.request(`/api/projects/${id}/knowledge/drafts/toolchain`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Toolchain", body: "v2" }),
    });

    const after = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string; generatedFromSha?: string; generatedByLaunchId?: string }>;
    const toolchain = after.find((d) => d.slug === "toolchain")!;
    expect(toolchain.generatedFromSha).toBe("abc123");
    expect(toolchain.generatedByLaunchId).toBe("launch-1");

    store.close();
  });
});

describe("POST .../knowledge/drafts/:slug/accept", () => {
  test("a first-bootstrap draft (no replaces_slug) moves the file and deletes the row", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    // The draft file is gone from .drafts/...
    await expect(
      readdir(join(knowledgeDir, id, ".drafts")).then((files) => {
        if (files.includes("gotchas.md")) throw new Error("draft file still present");
      })
    ).resolves.toBeUndefined();

    // ...and it's now the accepted doc.
    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("watch out");

    // The row is gone too — accept-all should not see it as pending.
    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("a regenerated draft (replaces_slug set) requires a merge body by default — no silent overwrite", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);

    // No mode, no body — must not silently replace the human's doc.
    const noBody = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
    });
    expect(noBody.status).toBe(400);
    const stillOriginal = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(stillOriginal?.body).toBe("human-written original");

    // Supplying merged text accepts it as the new combined doc.
    const merged = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "combined: original + regenerated" }),
    });
    expect(merged.status).toBe(200);
    const mergedDoc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(mergedDoc?.body).toBe("combined: original + regenerated");

    // The draft is gone either way it lands.
    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("mode: replace overwrites the accepted doc with the draft's own text", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "human-written original",
    });
    await writeDraftFile(knowledgeDir, id, {
      slug: "gotchas",
      title: "Gotchas",
      body: "regenerated version",
      replacesSlug: "gotchas",
    });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "replace" }),
    });
    expect(res.status).toBe(200);

    const doc = await readKnowledgeFile(knowledgeDir, id, "gotchas");
    expect(doc?.body).toBe("regenerated version");

    store.close();
  });
});

describe("POST .../knowledge/drafts/:slug/discard", () => {
  test("removes both the file and the row", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "watch out" });
    await knowledgeSync.syncDrafts(id);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/discard`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    await expect(
      readdir(join(knowledgeDir, id, ".drafts")).then((files) => {
        if (files.includes("gotchas.md")) throw new Error("draft file still present");
      })
    ).resolves.toBeUndefined();

    const drafts = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(drafts.find((d) => d.slug === "gotchas")).toBeUndefined();

    store.close();
  });

  test("discarding a slug with no draft is a 404", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const app = createServer(store, () => {}, null, new KnowledgeSync(store.db, knowledgeDir, null), undefined, knowledgeDir);

    const res = await app.request(`/api/projects/${id}/knowledge/drafts/nope/discard`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    store.close();
  });
});

describe("POST .../knowledge/drafts/accept-all", () => {
  test("accepts only plain drafts — leaves replacing and disputed drafts pending, and says why", async () => {
    const id = projectId();
    const { store } = setUp(id);
    const knowledgeDir = await tempKnowledgeDir();
    cleanupDirs.push(knowledgeDir);
    const knowledgeSync = new KnowledgeSync(store.db, knowledgeDir, null);

    await writeKnowledgeFile(knowledgeDir, id, { slug: "practices", title: "Practices", body: "existing" });

    await writeDraftFile(knowledgeDir, id, { slug: "overview", title: "Overview", body: "new doc" });
    await writeDraftFile(knowledgeDir, id, {
      slug: "practices",
      title: "Practices",
      body: "regenerated",
      replacesSlug: "practices",
    });
    await writeDraftFile(knowledgeDir, id, { slug: "gotchas", title: "Gotchas", body: "disputed one" });
    await knowledgeSync.syncDrafts(id);
    knowledgeSync.recordDraftVerdict(id, "gotchas", "disputed", [
      { claim: "x", finding: "y", evidence: "z" },
    ]);

    const app = createServer(store, () => {}, null, knowledgeSync, undefined, knowledgeDir);
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/accept-all`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      accepted: string[];
      skipped: Array<{ slug: string; reason: string }>;
    };

    expect(json.accepted).toEqual(["overview"]);
    expect(json.skipped).toEqual(
      expect.arrayContaining([
        { slug: "practices", reason: "replaces" },
        { slug: "gotchas", reason: "disputed" },
      ])
    );

    // overview landed as an accepted doc...
    expect((await readKnowledgeFile(knowledgeDir, id, "overview"))?.body).toBe("new doc");
    // ...practices was NOT overwritten...
    expect((await readKnowledgeFile(knowledgeDir, id, "practices"))?.body).toBe("existing");

    // ...and both practices and gotchas are still pending drafts.
    const remaining = (await (
      await app.request(`/api/projects/${id}/knowledge/drafts`)
    ).json()) as Array<{ slug: string }>;
    expect(remaining.map((d) => d.slug).sort()).toEqual(["gotchas", "practices"]);

    store.close();
  });
});
