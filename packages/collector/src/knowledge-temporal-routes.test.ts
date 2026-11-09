import { expect, test, describe, afterAll } from "bun:test";
import { mkdtemp, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createStore, upsertProject } from "@standup/store";
import type { Store } from "@standup/store";
import {
  writeDraftFile,
  writeKnowledgeFile,
  readKnowledgeFile,
  HISTORY_SUBDIR,
  KnowledgeLoader,
  KnowledgeStore,
} from "@standup/knowledge";
import { createServer } from "./server.js";
import { KnowledgeSync } from "./knowledge-sync.js";

/**
 * Validity over the accept and search routes: a replacing accept (replace or a
 * body-changing merge) closes the prior version into .history/ instead of
 * overwriting it, and /api/knowledge/search's `as_of` reaches that version.
 */

const cleanupDirs: string[] = [];
afterAll(async () => {
  for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
});

async function setUp(): Promise<{ id: string; store: Store; knowledgeDir: string; sync: KnowledgeSync }> {
  const id = `temporal-routes-${randomUUID().slice(0, 8)}`;
  const store = createStore(":memory:");
  upsertProject(store.db, { id, name: "Temporal Routes Test", branch: "main", repos: [] });
  const knowledgeDir = await mkdtemp(join(tmpdir(), "standup-temporal-routes-"));
  cleanupDirs.push(knowledgeDir);
  const sync = new KnowledgeSync(store.db, knowledgeDir, null);
  await writeKnowledgeFile(knowledgeDir, id, {
    slug: "gotchas",
    title: "Gotchas",
    body: "The deploy script needs the legacy flag.",
    validFrom: "2026-01-01T00:00:00.000Z",
  });
  await writeDraftFile(knowledgeDir, id, {
    slug: "gotchas",
    title: "Gotchas",
    body: "The deploy script no longer needs any flag.",
    replacesSlug: "gotchas",
  });
  await sync.syncProject(id);
  await sync.syncDrafts(id);
  return { id, store, knowledgeDir, sync };
}

async function search(app: ReturnType<typeof createServer>, id: string, body: Record<string, unknown>) {
  return app.request("/api/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp/none", project: id, corpus: "project", ...body }),
  });
}

describe("replacing accepts keep the prior version", () => {
  test.each([
    ["replace", { mode: "replace" }, "The deploy script no longer needs any flag."],
    ["merge", { body: "The deploy script needs no flag since the rewrite." }, "The deploy script needs no flag since the rewrite."],
  ])("%s closes the old body into .history/ and as_of finds it", async (_mode, acceptBody, newBody) => {
    const { id, store, knowledgeDir, sync } = await setUp();
    const app = createServer(store, () => {}, null, sync, undefined, knowledgeDir);
    const before = new Date().toISOString();
    const res = await app.request(`/api/projects/${id}/knowledge/drafts/gotchas/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acceptBody),
    });
    expect(res.status).toBe(200);
    expect((await readKnowledgeFile(knowledgeDir, id, "gotchas"))?.body).toBe(newBody);

    expect(await readdir(join(knowledgeDir, id, HISTORY_SUBDIR))).toHaveLength(1);
    const [old] = await new KnowledgeLoader(knowledgeDir).loadHistory(id);
    expect(old.body).toBe("The deploy script needs the legacy flag.");
    expect(old.validFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(old.validTo >= before).toBe(true);
    expect(old.supersededBy).toBe(`${id}/gotchas`);

    const current = new KnowledgeStore(store.db).getDoc(id, "gotchas")!;
    expect(current.validFrom! >= before).toBe(true);
    expect(current.validTo).toBeUndefined();

    const now = (await (await search(app, id, { query: "deploy script legacy flag" })).json()) as {
      results: Array<{ id: string; slug: string; excerpt: string; injectionEligible?: boolean }>;
    };
    expect(now.results.filter((r) => r.slug === "gotchas").map((r) => r.id)).toEqual([current.id]);
    expect(now.results.find((r) => r.slug === "gotchas")?.injectionEligible).toBe(true);

    const then = (await (await search(app, id, { query: "deploy script legacy flag", as_of: "2026-02-01" })).json()) as {
      results: Array<{
        id: string;
        slug: string;
        excerpt: string;
        validTo?: string;
        supersededBy?: string;
        injectionEligible?: boolean;
      }>;
    };
    const hit = then.results.find((r) => r.slug === "gotchas")!;
    expect(hit.id).not.toBe(current.id);
    expect(hit.excerpt).toContain("legacy flag");
    expect(hit.validTo).toBe(old.validTo);
    expect(hit.supersededBy).toBe(`${id}/gotchas`);
    // A closed version is never offered for injection, whatever its trust and freshness.
    expect(hit.injectionEligible).toBe(false);

    store.close();
  });

  test("a malformed as_of is refused", async () => {
    const { id, store, knowledgeDir, sync } = await setUp();
    const app = createServer(store, () => {}, null, sync, undefined, knowledgeDir);
    const res = await search(app, id, { query: "deploy", as_of: "last tuesday" });
    expect(res.status).toBe(400);
    store.close();
  });
});
