import type { Database } from "bun:sqlite";
import type { KnowledgeDoc, KnowledgeChunk, KnowledgeDraft } from "./types.js";

export class KnowledgeStore {
  constructor(private db: Database) {
    this.ensureTables();
  }

  // Knowledge schema lives entirely here rather than in packages/store's
  // migrations.ts. runMigrations runs inside createStore, which the collector
  // calls before KnowledgeSync ever constructs a KnowledgeStore — a migration
  // that ALTERed `knowledge` would run against a database that doesn't have
  // the table yet on a fresh install and throw. ensureTables runs lazily, the
  // first time a KnowledgeStore is constructed, by which point the table (if
  // any) already exists.
  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        embedding_json TEXT,
        file_path TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        generated_from_sha TEXT,
        generated_at TEXT,
        UNIQUE(project_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);

      -- Standalone FTS5 table (not external-content) so upserts are a plain
      -- delete+insert keyed on the UNINDEXED id column, with no dependency on
      -- rowid conflict resolution for virtual tables.
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        id UNINDEXED, title, body, tags
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        UNIQUE(knowledge_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_knowledge ON knowledge_chunks(knowledge_id);

      -- A draft is listed for review, never retrieved semantically — no
      -- embedding_json column, no FTS table, no chunks relation. That
      -- absence is structural, not an oversight: searchText queries
      -- knowledge_fts and searchEmbeddings queries knowledge_chunks, and
      -- neither has any path to this table, so a draft cannot leak into an
      -- agent's context even if a future call site forgets this constraint
      -- exists.
      CREATE TABLE IF NOT EXISTS knowledge_drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        file_path TEXT NOT NULL,

        -- Provenance, stamped by the collector rather than the agent.
        generated_from_sha TEXT,
        generated_at TEXT,
        generated_by_launch_id TEXT,

        -- Review state. 'pending' is the only state a row lives in for long:
        -- accept moves the file and deletes the row, discard deletes both.
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'discarded')),

        -- Set on regenerate: the accepted doc this draft would overwrite.
        -- NULL on a first bootstrap, which is why review shows a preview
        -- then and a diff only on regeneration.
        replaces_slug TEXT,

        reviewed_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_drafts_project
        ON knowledge_drafts(project_id);
    `);

    this.ensureColumns();
  }

  // CREATE TABLE IF NOT EXISTS silently does nothing when the table is
  // already there, so a database that predates generated_from_sha/
  // generated_at needs those columns added explicitly. PRAGMA-checked
  // because SQLite has no ADD COLUMN IF NOT EXISTS. Idempotent, so it's safe
  // to run unconditionally on every startup, fresh database or not.
  private ensureColumns(): void {
    const existing = new Set(
      (this.db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>)
        .map((c) => c.name)
    );
    for (const col of ["generated_from_sha", "generated_at"]) {
      if (!existing.has(col)) {
        this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} TEXT`);
      }
    }
  }

  upsertDoc(doc: KnowledgeDoc): void {
    // Stores the file's real mtime (doc.updatedAt), not "now" — syncProject
    // compares this against a fresh stat() to decide whether to skip
    // re-embedding an unchanged file on every lazy resync.
    this.db.run(
      `INSERT INTO knowledge (id, project_id, slug, title, body, tags_json, embedding_json, file_path, updated_at, generated_from_sha, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, slug) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         tags_json = excluded.tags_json,
         embedding_json = excluded.embedding_json,
         file_path = excluded.file_path,
         updated_at = excluded.updated_at,
         generated_from_sha = excluded.generated_from_sha,
         generated_at = excluded.generated_at`,
      [
        doc.id,
        doc.projectId,
        doc.slug,
        doc.title,
        doc.body,
        doc.tags ? JSON.stringify(doc.tags) : null,
        doc.embedding ? JSON.stringify(doc.embedding) : null,
        doc.filePath,
        doc.updatedAt.toISOString(),
        doc.generatedFromSha ?? null,
        doc.generatedAt ?? null,
      ]
    );

    // Update FTS index — delete+insert since fts5 tables don't support
    // ON CONFLICT upserts the way regular tables do.
    this.db.run("DELETE FROM knowledge_fts WHERE id = ?", [doc.id]);
    this.db.run(
      `INSERT INTO knowledge_fts (id, title, body, tags) VALUES (?, ?, ?, ?)`,
      [doc.id, doc.title, doc.body, doc.tags?.join(" ") ?? ""]
    );
  }

  upsertChunk(chunk: KnowledgeChunk): void {
    this.db.run(
      `INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(knowledge_id, chunk_index) DO UPDATE SET
         text = excluded.text,
         embedding_json = excluded.embedding_json`,
      [
        chunk.id,
        chunk.knowledgeId,
        chunk.chunkIndex,
        chunk.text,
        JSON.stringify(chunk.embedding),
      ]
    );
  }

  getDocsByProject(projectId: string): KnowledgeDoc[] {
    const rows = this.db
      .query("SELECT * FROM knowledge WHERE project_id = ? ORDER BY slug")
      .all(projectId) as Array<{
      id: string;
      project_id: string;
      slug: string;
      title: string;
      body: string;
      tags_json: string | null;
      embedding_json: string | null;
      file_path: string;
      updated_at: string;
      generated_from_sha: string | null;
      generated_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      slug: row.slug,
      title: row.title,
      body: row.body,
      tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
      embedding: row.embedding_json ? JSON.parse(row.embedding_json) : undefined,
      filePath: row.file_path,
      updatedAt: new Date(row.updated_at),
      generatedFromSha: row.generated_from_sha ?? undefined,
      generatedAt: row.generated_at ?? undefined,
    }));
  }

  getDoc(projectId: string, slug: string): KnowledgeDoc | null {
    const row = this.db
      .query("SELECT * FROM knowledge WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as {
      id: string;
      project_id: string;
      slug: string;
      title: string;
      body: string;
      tags_json: string | null;
      embedding_json: string | null;
      file_path: string;
      updated_at: string;
      generated_from_sha: string | null;
      generated_at: string | null;
    } | null;

    if (!row) return null;

    return {
      id: row.id,
      projectId: row.project_id,
      slug: row.slug,
      title: row.title,
      body: row.body,
      tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
      embedding: row.embedding_json ? JSON.parse(row.embedding_json) : undefined,
      filePath: row.file_path,
      updatedAt: new Date(row.updated_at),
      generatedFromSha: row.generated_from_sha ?? undefined,
      generatedAt: row.generated_at ?? undefined,
    };
  }

  deleteDoc(projectId: string, slug: string): void {
    const doc = this.getDoc(projectId, slug);
    this.db.run(
      "DELETE FROM knowledge WHERE project_id = ? AND slug = ?",
      [projectId, slug]
    );
    if (doc) {
      this.db.run("DELETE FROM knowledge_fts WHERE id = ?", [doc.id]);
    }
  }

  getChunks(knowledgeId: string): KnowledgeChunk[] {
    const rows = this.db
      .query(
        "SELECT * FROM knowledge_chunks WHERE knowledge_id = ? ORDER BY chunk_index"
      )
      .all(knowledgeId) as Array<{
      id: string;
      knowledge_id: string;
      chunk_index: number;
      text: string;
      embedding_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      knowledgeId: row.knowledge_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: JSON.parse(row.embedding_json),
    }));
  }

  getAllChunksWithEmbeddings(projectId: string): Array<{
    chunkId: string;
    knowledgeId: string;
    slug: string;
    title: string;
    text: string;
    embedding: number[];
  }> {
    const rows = this.db
      .query(
        `SELECT kc.id as chunk_id, kc.knowledge_id, k.slug, k.title, kc.text, kc.embedding_json
         FROM knowledge_chunks kc
         JOIN knowledge k ON k.id = kc.knowledge_id
         WHERE k.project_id = ?`
      )
      .all(projectId) as Array<{
      chunk_id: string;
      knowledge_id: string;
      slug: string;
      title: string;
      text: string;
      embedding_json: string;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      knowledgeId: row.knowledge_id,
      slug: row.slug,
      title: row.title,
      text: row.text,
      embedding: JSON.parse(row.embedding_json),
    }));
  }

  // Draft rows are always upserted as 'pending' — a row that has moved to
  // 'accepted' or 'discarded' is deleted immediately by the caller (see the
  // status column's comment in ensureTables), so there is no accepted/
  // discarded state for an upsert to preserve or clobber.
  upsertDraft(draft: KnowledgeDraft): void {
    this.db.run(
      `INSERT INTO knowledge_drafts
         (id, project_id, slug, title, body, tags_json, file_path,
          generated_from_sha, generated_at, generated_by_launch_id,
          replaces_slug, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, slug) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         tags_json = excluded.tags_json,
         file_path = excluded.file_path,
         generated_from_sha = excluded.generated_from_sha,
         generated_at = excluded.generated_at,
         generated_by_launch_id = excluded.generated_by_launch_id,
         replaces_slug = excluded.replaces_slug,
         updated_at = excluded.updated_at`,
      [
        draft.id,
        draft.projectId,
        draft.slug,
        draft.title,
        draft.body,
        draft.tags ? JSON.stringify(draft.tags) : null,
        draft.filePath,
        draft.generatedFromSha ?? null,
        draft.generatedAt ?? null,
        draft.generatedByLaunchId ?? null,
        draft.replacesSlug ?? null,
        draft.updatedAt.toISOString(),
      ]
    );
  }

  getDraftsByProject(projectId: string): KnowledgeDraft[] {
    const rows = this.db
      .query(
        "SELECT * FROM knowledge_drafts WHERE project_id = ? AND status = 'pending' ORDER BY slug"
      )
      .all(projectId) as DraftRow[];

    return rows.map(rowToDraft);
  }

  getDraft(projectId: string, slug: string): KnowledgeDraft | null {
    const row = this.db
      .query("SELECT * FROM knowledge_drafts WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as DraftRow | null;

    return row ? rowToDraft(row) : null;
  }

  deleteDraft(projectId: string, slug: string): void {
    this.db.run(
      "DELETE FROM knowledge_drafts WHERE project_id = ? AND slug = ?",
      [projectId, slug]
    );
  }
}

interface DraftRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  tags_json: string | null;
  file_path: string;
  generated_from_sha: string | null;
  generated_at: string | null;
  generated_by_launch_id: string | null;
  replaces_slug: string | null;
  updated_at: string;
}

function rowToDraft(row: DraftRow): KnowledgeDraft {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
    filePath: row.file_path,
    generatedFromSha: row.generated_from_sha ?? undefined,
    generatedAt: row.generated_at ?? undefined,
    generatedByLaunchId: row.generated_by_launch_id ?? undefined,
    replacesSlug: row.replaces_slug ?? undefined,
    updatedAt: new Date(row.updated_at),
  };
}
