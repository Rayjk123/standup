import type { Database } from "bun:sqlite";
import { chunkMarkdown, VEC_TABLE, isVecAvailable, EMBEDDING_FINGERPRINT_KEY } from "@standup/knowledge";
import { getSetting } from "@standup/store";
import type { IntegrityReport } from "./types.js";

function tableExists(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE name = ? LIMIT 1").get(name) !== null
  );
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}

/**
 * Index-integrity counts over a loaded knowledge DB: the FTS mirror against the
 * current doc rows, chunk rows against the production chunker's expected count
 * for each current body, the vec mirror against chunks, and whether the
 * recorded embedding fingerprint pins a model digest.
 */
export function checkIntegrity(db: Database, knownDigest?: string | null): IntegrityReport {
  const docs = db
    .query("SELECT id, project_id, slug, title, body FROM knowledge ORDER BY project_id, slug")
    .all() as Array<{ id: string; project_id: string; slug: string; title: string; body: string }>;
  const fts = db.query("SELECT id, title, body FROM knowledge_fts").all() as Array<{
    id: string;
    title: string;
    body: string;
  }>;
  const ftsById = new Map<string, Array<{ title: string; body: string }>>();
  for (const row of fts) {
    const list = ftsById.get(row.id) ?? [];
    list.push(row);
    ftsById.set(row.id, list);
  }
  const docIds = new Set(docs.map((d) => d.id));

  let docsMissingFts = 0;
  let docsDuplicateFts = 0;
  const staleFtsRefs: string[] = [];
  const chunkCounts = new Map<string, number>();
  for (const row of db
    .query("SELECT knowledge_id, chunk_index FROM knowledge_chunks")
    .all() as Array<{ knowledge_id: string; chunk_index: number }>) {
    chunkCounts.set(row.knowledge_id, (chunkCounts.get(row.knowledge_id) ?? 0) + 1);
  }
  const tailChunkRefs: string[] = [];
  let tailChunks = 0;
  let docsWithoutChunks = 0;
  const tailStmt = db.query(
    "SELECT COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_id = ? AND chunk_index >= ?"
  );

  for (const d of docs) {
    const ref = `${d.project_id}/${d.slug}`;
    const rows = ftsById.get(d.id) ?? [];
    if (rows.length === 0) docsMissingFts++;
    if (rows.length > 1) docsDuplicateFts++;
    if (rows.length > 0 && rows.some((r) => r.title !== d.title || r.body !== d.body)) {
      staleFtsRefs.push(ref);
    }
    const expected = chunkMarkdown(d.title, d.body).length;
    const tail = (tailStmt.get(d.id, expected) as { n: number }).n;
    if (tail > 0) {
      tailChunks += tail;
      tailChunkRefs.push(ref);
    }
    if ((chunkCounts.get(d.id) ?? 0) === 0) docsWithoutChunks++;
  }

  const orphanFtsRows = fts.filter((r) => !docIds.has(r.id)).length;
  const chunks = count(db, "SELECT COUNT(*) AS n FROM knowledge_chunks");
  const orphanChunks = count(
    db,
    "SELECT COUNT(*) AS n FROM knowledge_chunks c LEFT JOIN knowledge k ON k.id = c.knowledge_id WHERE k.id IS NULL"
  );

  const vecEnabled = isVecAvailable(db) && tableExists(db, VEC_TABLE);
  let vecRows: number | null = null;
  let vecChunkMismatch: number | null = null;
  if (vecEnabled) {
    vecRows = count(db, `SELECT COUNT(*) AS n FROM ${VEC_TABLE}`);
    const missing = count(
      db,
      `SELECT COUNT(*) AS n FROM knowledge_chunks c WHERE c.rowid NOT IN (SELECT rowid FROM ${VEC_TABLE})`
    );
    const extra = count(
      db,
      `SELECT COUNT(*) AS n FROM ${VEC_TABLE} v WHERE v.rowid NOT IN (SELECT rowid FROM knowledge_chunks)`
    );
    vecChunkMismatch = missing + extra;
  }

  const fingerprint = getSetting(db, EMBEDDING_FINGERPRINT_KEY);
  const fingerprintHasModelDigest =
    fingerprint !== null &&
    (/[0-9a-f]{12,}/.test(fingerprint) ||
      (!!knownDigest && fingerprint.includes(knownDigest.slice(0, 12))));

  return {
    docs: docs.length,
    ftsRows: fts.length,
    orphanFtsRows,
    docsMissingFts,
    docsDuplicateFts,
    docsStaleFts: staleFtsRefs.length,
    staleFtsRefs,
    chunks,
    orphanChunks,
    tailChunks,
    tailChunkRefs,
    docsWithoutChunks,
    vecEnabled,
    vecRows,
    vecChunkMismatch,
    embeddingFingerprint: fingerprint,
    fingerprintHasModelDigest,
  };
}
