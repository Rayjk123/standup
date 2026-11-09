import type { Database } from "bun:sqlite";

/** The sqlite-vec vec0 virtual table holding one vector per chunk. */
export const VEC_TABLE = "knowledge_vec";

/**
 * KNN asks vec0 for k * KNN_OVERFETCH neighbours so the scope filter applied
 * during hydration still leaves k candidates.
 */
export const KNN_OVERFETCH = 4;

export interface KnnRow {
  chunkId: number;
  docId: string;
  distance: number;
}

/**
 * Nearest-neighbour search over knowledge_vec using vec0's MATCH operator.
 * Replaced the linear JavaScript cosine scan over every chunk.
 */
export function knnSearch(
  db: Database,
  query: Float32Array,
  k: number,
  scopeSql: string,
  scopeParams: string[]
): KnnRow[] {
  const rows = db
    .query(
      `SELECT v.chunk_id AS chunkId, c.doc_id AS docId, v.distance AS distance
         FROM ${VEC_TABLE} v
         JOIN knowledge_chunks c ON c.id = v.chunk_id
         JOIN knowledge k ON k.id = c.doc_id
        WHERE v.embedding MATCH ? AND v.k = ?
          AND ${scopeSql}
        ORDER BY v.distance`
    )
    .all(new Uint8Array(query.buffer), k * KNN_OVERFETCH, ...scopeParams) as KnnRow[];
  return rows.slice(0, k);
}
