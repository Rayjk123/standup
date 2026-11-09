import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStore, upsertProject } from "@standup/store";
import { DEFAULT_BASE_CONFIDENCE, KnowledgeStore, type KnowledgeDoc } from "@standup/knowledge";
import { retrieveCodeKnowledge } from "./launcher.js";
import { freshnessGate, replaceProjectFreshness } from "./knowledge-freshness.js";

/**
 * The freshness gate end to end through launch retrieval. A doc
 * on the default base decays; it leaves injection only where a re-verification
 * will lift it back (model pass on for its project, the doc about the repo).
 * Anywhere else it stays, ranked after fresher docs of its project and marked
 * stale since the day it crossed the floor.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const OLD = "2026-01-01T00:00:00.000Z";
const FRESH = new Date().toISOString();

function ownerDoc(overrides: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: crypto.randomUUID(),
    projectId: "with-repo",
    slug: "doc",
    title: "Doc",
    body: "freshterm content",
    updatedAt: new Date(OLD),
    filePath: "/x/doc.md",
    originClass: "owner",
    sourceKind: "code",
    scope: "project",
    ...overrides,
  };
}

function seed(modelPass: boolean) {
  const repo = tempDir("freshness-repo-");
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "with-repo", name: "With", branch: "main", repos: [repo], dailyReviewActive: modelPass });
  const k = new KnowledgeStore(store.db);
  k.upsertDoc(
    ownerDoc({ slug: "old-owner", title: "Old freshterm freshterm", body: "freshterm content from the old build", generatedAt: OLD })
  );
  k.upsertDoc(
    ownerDoc({ slug: "fresh-owner", title: "Fresh freshterm", body: "freshterm content after the rewrite", generatedAt: FRESH })
  );
  for (let i = 0; i < 6; i++) {
    k.upsertDoc(ownerDoc({ slug: `filler-${i}`, title: `Filler ${i}`, body: `unrelated prose ${i} about caching`, generatedAt: FRESH }));
  }
  replaceProjectFreshness(store.db, "with-repo", [{ slug: "old-owner", findings: [], aboutRepo: true }], FRESH);
  return store;
}

describe("freshness gate — gate only with a recovery path, otherwise demote and mark", () => {
  test("an unasserted owner doc is judged on the default base, derived rather than stored", () => {
    const store = seed(false);
    expect(new KnowledgeStore(store.db).getDoc("with-repo", "old-owner")?.confidence).toBeUndefined();
    expect(freshnessGate(store.db).inputs({ projectId: "with-repo", slug: "old-owner" }).confidence).toBe(DEFAULT_BASE_CONFIDENCE);
    store.close();
  });

  test("with the model pass on, launch drops the decayed doc", async () => {
    const store = seed(true);
    const injected = await retrieveCodeKnowledge(store.db, "with-repo", "freshterm", null, {}, { projectId: "with-repo" });
    expect(injected.map((r) => r.slug)).not.toContain("old-owner");
    expect(injected.map((r) => r.slug)).toContain("fresh-owner");
    store.close();
  });

  test("with no recovery path, launch keeps the decayed doc after the fresh one, titled stale since", async () => {
    const store = seed(false);
    const injected = await retrieveCodeKnowledge(store.db, "with-repo", "freshterm", null, {}, { projectId: "with-repo" });
    const slugs = injected.map((r) => r.slug);
    expect(slugs.indexOf("fresh-owner")).toBeLessThan(slugs.indexOf("old-owner"));
    expect(injected.find((r) => r.slug === "old-owner")?.title).toMatch(/\(stale since 2026-06-\d\d\)$/);
    store.close();
  });
});
