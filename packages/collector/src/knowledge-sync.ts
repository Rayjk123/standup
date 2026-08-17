import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  KnowledgeStore,
  KnowledgeLoader,
  chunkText,
  embedChunks,
  type EmbeddingProvider,
} from "@standup/knowledge";
import { getProjects } from "@standup/store";

const SCRATCH_PROJECT_ID = "scratch";

export class KnowledgeSync {
  private store: KnowledgeStore;
  private loader: KnowledgeLoader;

  constructor(
    private db: Database,
    knowledgeDir: string,
    private embeddingProvider: EmbeddingProvider | null
  ) {
    this.store = new KnowledgeStore(db);
    this.loader = new KnowledgeLoader(knowledgeDir);
  }

  private knownProjectIds(): string[] {
    const ids = getProjects(this.db).map((p) => p.id);
    return ids.includes(SCRATCH_PROJECT_ID) ? ids : [...ids, SCRATCH_PROJECT_ID];
  }

  /**
   * Re-reads a project's knowledge directory from disk and reconciles it
   * against the store. Cheap to call on every search — unchanged files are
   * skipped after a stat() comparison (no re-read, no re-embed), and this
   * is what lets new/edited/deleted knowledge docs show up without a
   * collector restart, unlike the fs.watch-based path (which can't attach
   * to a directory that doesn't exist yet, e.g. a project's first doc).
   */
  async syncProject(projectId: string): Promise<void> {
    const docs = await this.loader.loadProject(projectId);
    const seenSlugs = new Set<string>();

    for (const doc of docs) {
      seenSlugs.add(doc.slug);

      const existing = this.store.getDoc(projectId, doc.slug);
      if (existing && existing.updatedAt.getTime() >= doc.updatedAt.getTime()) {
        continue; // file unchanged since last sync
      }

      this.store.upsertDoc(doc);

      // Best-effort embedding — skip silently if no provider or the call fails.
      if (!this.embeddingProvider) continue;

      const knowledgeId = existing?.id ?? doc.id;
      const chunks = chunkText(doc.body);
      const embeddings = await embedChunks(chunks, this.embeddingProvider);

      chunks.forEach((text, i) => {
        const embedding = embeddings[i];
        if (!embedding) return;

        this.store.upsertChunk({
          id: randomUUID(),
          knowledgeId,
          chunkIndex: i,
          text,
          embedding,
        });
      });
    }

    // Remove docs whose file no longer exists, so deletions show up too.
    for (const stored of this.store.getDocsByProject(projectId)) {
      if (!seenSlugs.has(stored.slug)) {
        this.store.deleteDoc(projectId, stored.slug);
      }
    }
  }

  /**
   * Reconciles `.drafts/` against knowledge_drafts, the same shape as
   * syncProject but deliberately does not chunk or embed. That's not a TODO —
   * a draft is listed for review, never retrieved, so spending an embedding
   * call on text that might be deleted or rewritten before anyone reads it
   * would be pure waste, and skipping it is what keeps bootstrap cheap to
   * re-run.
   */
  async syncDrafts(projectId: string): Promise<void> {
    const drafts = await this.loader.loadDrafts(projectId);
    const seenSlugs = new Set<string>();

    for (const draft of drafts) {
      seenSlugs.add(draft.slug);
      this.store.upsertDraft(draft);
    }

    for (const stored of this.store.getDraftsByProject(projectId)) {
      if (!seenSlugs.has(stored.slug)) {
        this.store.deleteDraft(projectId, stored.slug);
      }
    }
  }

  async syncAll(): Promise<void> {
    for (const projectId of this.knownProjectIds()) {
      await this.syncProject(projectId);
    }
  }

  startWatching(onDocsChanged?: (projectId: string) => void): void {
    this.loader.startWatching(this.knownProjectIds(), async (projectId) => {
      await this.syncProject(projectId);
      onDocsChanged?.(projectId);
    });
  }

  stopWatching(): void {
    this.loader.stopWatching();
  }
}
