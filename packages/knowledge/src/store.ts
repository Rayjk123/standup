import type { Database } from "bun:sqlite";
import type { KnowledgeDoc, KnowledgeChunk } from "./types.js";

export class KnowledgeStore {
  constructor(private db: Database) {
    this.ensureTables();
  }

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
    `);
  }

  upsertDoc(doc: KnowledgeDoc): void {
    // Stores the file's real mtime (doc.updatedAt), not "now" — syncProject
    // compares this against a fresh stat() to decide whether to skip
    // re-embedding an unchanged file on every lazy resync.
    this.db.run(
      `INSERT INTO knowledge (id, project_id, slug, title, body, tags_json, embedding_json, file_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, slug) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         tags_json = excluded.tags_json,
         embedding_json = excluded.embedding_json,
         file_path = excluded.file_path,
         updated_at = excluded.updated_at`,
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
}
