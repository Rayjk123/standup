import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeStore } from "@standup/knowledge";
import { KnowledgeSync } from "./knowledge-sync.js";

async function tempKnowledgeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "standup-knowledge-sync-"));
}

describe("KnowledgeSync.syncDrafts", () => {
  test("reconciles .drafts/ into knowledge_drafts without touching search tables", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(
        join(projectDir, ".drafts", "toolchain.md"),
        "---\ntitle: Toolchain\ngenerated_from_sha: abc123\n---\nrun bun test"
      );

      const db = new Database(":memory:");
      // "ollama" so that if syncDrafts ever accidentally started embedding,
      // it would be reaching for a real provider rather than silently no-op
      // via a null provider.
      const sync = new KnowledgeSync(db, dir, "ollama");
      await sync.syncDrafts("proj");

      const store = new KnowledgeStore(db);
      const drafts = store.getDraftsByProject("proj");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].slug).toBe("toolchain");
      expect(drafts[0].generatedFromSha).toBe("abc123");

      // Not chunked, not embedded, not in the accepted table at all.
      const chunkCount = (
        db.query("SELECT COUNT(*) as n FROM knowledge_chunks").get() as { n: number }
      ).n;
      expect(chunkCount).toBe(0);
      expect(store.getDocsByProject("proj")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes rows whose draft file was deleted from disk", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      const filePath = join(projectDir, ".drafts", "gone.md");
      await writeFile(filePath, "---\ntitle: Gone\n---\nbody");

      const db = new Database(":memory:");
      const sync = new KnowledgeSync(db, dir, null);
      await sync.syncDrafts("proj");

      const store = new KnowledgeStore(db);
      expect(store.getDraftsByProject("proj")).toHaveLength(1);

      await rm(filePath);
      await sync.syncDrafts("proj");

      expect(store.getDraftsByProject("proj")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drafts never surface from searchText/searchEmbeddings — write a draft and an accepted doc with the same term, only the accepted one is findable", async () => {
    const dir = await tempKnowledgeDir();
    try {
      const projectDir = join(dir, "proj");
      await mkdir(join(projectDir, ".drafts"), { recursive: true });
      await writeFile(
        join(projectDir, ".drafts", "draft-doc.md"),
        "---\ntitle: Draft Doc\n---\nunobtainium is the load-bearing term"
      );
      await writeFile(
        join(projectDir, "real-doc.md"),
        "---\ntitle: Real Doc\n---\nunobtainium is the load-bearing term"
      );

      const db = new Database(":memory:");
      const sync = new KnowledgeSync(db, dir, null);
      await sync.syncProject("proj");
      await sync.syncDrafts("proj");

      const { searchKnowledge } = await import("@standup/knowledge");
      const results = await searchKnowledge(db, "proj", "unobtainium", null);

      expect(results.map((r) => r.slug)).toEqual(["real-doc"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
