import type { Database } from "bun:sqlite";
import type { KnowledgeDoc } from "../knowledge/types.js";
import { chunkText } from "../knowledge/chunker.js";
import { embedTexts } from "../knowledge/embeddings.js";
import { VEC_TABLE } from "./vec.js";

/**
 * Inserts or updates a doc by (project_id, slug), then rewrites its FTS row and
 * its chunks. The loader mints a fresh id on every load; ON CONFLICT keeps the
 * row's original id, but the FTS delete/insert below use `doc.id` (the fresh
 * one), so an edited doc's old FTS row is never deleted.
 */
export async function upsertDoc(db: Database, doc: KnowledgeDoc): Promise<void> {
  db.query(
    `INSERT INTO knowledge (id, project_id, slug, title, body, tags_json, source_kind, scope,
                            owner_user, origin_class, confidence, last_verified_at,
                            half_life_days, verdict, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, slug) DO UPDATE SET
       title = excluded.title, body = excluded.body, tags_json = excluded.tags_json,
       source_kind = excluded.source_kind, scope = excluded.scope,
       owner_user = excluded.owner_user, origin_class = excluded.origin_class,
       confidence = excluded.confidence, last_verified_at = excluded.last_verified_at,
       half_life_days = excluded.half_life_days, updated_at = excluded.updated_at`
  ).run(
    doc.id, doc.projectId, doc.slug, doc.title, doc.body,
    doc.tags ? JSON.stringify(doc.tags) : null, doc.sourceKind, doc.scope,
    doc.ownerUser ?? null, doc.originClass, doc.confidence ?? null,
    doc.lastVerifiedAt ?? null, doc.halfLifeDays ?? null, doc.verdict,
    doc.updatedAt.toISOString()
  );

  db.query(`DELETE FROM knowledge_fts WHERE id = ?`).run(doc.id);
  db.query(`INSERT INTO knowledge_fts (id, title, body) VALUES (?, ?, ?)`).run(doc.id, doc.title, doc.body);

  const storedId = (db.query(`SELECT id FROM knowledge WHERE project_id = ? AND slug = ?`).get(
    doc.projectId,
    doc.slug
  ) as { id: string }).id;

  const chunks = chunkText(doc.body);
  const vectors = await embedTexts(chunks);
  chunks.forEach((text, ordinal) => {
    const row = db
      .query(
        `INSERT INTO knowledge_chunks (doc_id, ordinal, text) VALUES (?, ?, ?)
         ON CONFLICT (doc_id, ordinal) DO UPDATE SET text = excluded.text
         RETURNING id`
      )
      .get(storedId, ordinal, text) as { id: number };
    db.query(`INSERT OR REPLACE INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`).run(
      row.id,
      new Uint8Array(vectors[ordinal].buffer)
    );
  });
  // Chunks past the new count are left in place when a doc shrinks.
}

export function deleteDoc(db: Database, projectId: string, slug: string): void {
  db.query(`DELETE FROM knowledge WHERE project_id = ? AND slug = ?`).run(projectId, slug);
}
