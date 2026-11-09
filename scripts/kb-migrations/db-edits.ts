/**
 * DB edits the migrations share, each planned as the exact rows it touches:
 * deleting a doc with every row that hangs off it, and rewriting a doc's
 * sqlite-vec mirror rows when its partition keys change. Applied with raw SQL
 * inside the migration's transaction, so an apply writes what its plan listed
 * and nothing else.
 */

import type { Database } from "bun:sqlite";
import { DEFAULT_SCOPE, DEFAULT_SOURCE_KIND, VEC_OWNER_NONE, VEC_TABLE, isVecAvailable } from "@standup/knowledge";
import type { Change } from "./runner.ts";

/** The vec mirror's columns, or null when there is none this connection can read. */
function vecColumns(db: Database): string[] | null {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(VEC_TABLE);
  if (!exists || !isVecAvailable(db)) return null;
  return (db.query(`PRAGMA table_info("${VEC_TABLE}")`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => c !== "rowid");
}

/** Whether `db` has a vec mirror this process cannot load sqlite-vec for, so its rows cannot be planned. */
export function vecMirrorUnreadable(db: Database): boolean {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(VEC_TABLE);
  return !!exists && !isVecAvailable(db);
}

function chunksOf(db: Database, docId: string): Array<{ rowid: number; id: string }> {
  return db
    .query("SELECT rowid, id FROM knowledge_chunks WHERE knowledge_id = ? ORDER BY rowid")
    .all(docId) as Array<{ rowid: number; id: string }>;
}

/** A doc delete, planned: the doc row, its FTS rows, its chunks and their vec rows. */
export interface DocDelete {
  docId: string;
  chunkRowids: number[];
  vecRowids: number[];
}

/** Plans deleting doc `docId` (`docRef`), listing every row it removes in `changes`. */
export function planDocDelete(db: Database, docId: string, docRef: string, changes: Change[]): DocDelete {
  const vec = vecColumns(db) !== null;
  const chunks = chunksOf(db, docId);
  const vecRowids: number[] = [];
  for (const chunk of chunks) {
    const ref = `${docRef}#${chunk.id}`;
    if (vec && db.query(`SELECT 1 FROM ${VEC_TABLE} WHERE rowid = ?`).get(chunk.rowid)) {
      changes.push({ ref, target: "db", field: "vec", action: "delete" });
      vecRowids.push(chunk.rowid);
    }
    changes.push({ ref, target: "db", field: "chunk", action: "delete" });
  }
  const ftsRows = (db.query("SELECT COUNT(*) AS n FROM knowledge_fts WHERE id = ?").get(docId) as { n: number }).n;
  for (let i = 0; i < ftsRows; i++) changes.push({ ref: docRef, target: "db", field: "fts", action: "delete" });
  changes.push({ ref: docRef, target: "db", field: "row", action: "delete" });
  return { docId, chunkRowids: chunks.map((c) => c.rowid), vecRowids };
}

export function applyDocDelete(db: Database, d: DocDelete): void {
  for (const rowid of d.vecRowids) db.run(`DELETE FROM ${VEC_TABLE} WHERE rowid = ?`, [rowid]);
  db.run("DELETE FROM knowledge_chunks WHERE knowledge_id = ?", [d.docId]);
  db.run("DELETE FROM knowledge_fts WHERE id = ?", [d.docId]);
  db.run("DELETE FROM knowledge WHERE id = ?", [d.docId]);
}

/** A doc's placement as its vec mirror rows carry it. */
export interface DocPlacement {
  project_id: string;
  scope: string | null;
  owner_user: string | null;
  source_kind: string | null;
}

/** One vec row rewritten under new partition keys (the vector itself is kept). */
export interface VecEdit {
  rowid: number;
  values: Record<string, string>;
}

/**
 * Plans rewriting the vec rows of doc `docId` (`docRef`) to carry `next`,
 * listing each column that changes in `changes`. A mirror from an older build
 * that lacks a column has nothing to rewrite for it.
 */
export function planVecRefresh(
  db: Database,
  docId: string,
  docRef: string,
  next: DocPlacement,
  changes: Change[]
): VecEdit[] {
  const columns = vecColumns(db);
  if (!columns) return [];
  const want: Record<string, string> = {
    project_id: next.project_id,
    scope: next.scope ?? DEFAULT_SCOPE,
    owner_user: next.owner_user ?? VEC_OWNER_NONE,
    source_kind: next.source_kind ?? DEFAULT_SOURCE_KIND,
  };
  const edits: VecEdit[] = [];
  for (const chunk of chunksOf(db, docId)) {
    const row = db.query(`SELECT * FROM ${VEC_TABLE} WHERE rowid = ?`).get(chunk.rowid) as Record<string, unknown> | null;
    if (!row) continue;
    const values: Record<string, string> = {};
    for (const [col, value] of Object.entries(want)) {
      if (!columns.includes(col) || row[col] === value) continue;
      changes.push({
        ref: `${docRef}#${chunk.id}`,
        target: "db",
        field: `vec.${col}`,
        action: "set",
        before: row[col] === null || row[col] === undefined ? null : String(row[col]),
        after: value,
      });
      values[col] = value;
    }
    if (Object.keys(values).length > 0) edits.push({ rowid: chunk.rowid, values });
  }
  return edits;
}

/** Rewrites each vec row with its new partition keys and its stored vector (vec0 cannot update a partition key in place). */
export function applyVecRefresh(db: Database, edits: readonly VecEdit[]): void {
  for (const edit of edits) {
    const row = db.query(`SELECT * FROM ${VEC_TABLE} WHERE rowid = ?`).get(edit.rowid) as Record<string, unknown> | null;
    if (!row) continue;
    const next = { ...row, ...edit.values };
    delete next.rowid;
    const columns = Object.keys(next);
    db.run(`DELETE FROM ${VEC_TABLE} WHERE rowid = ?`, [edit.rowid]);
    db.run(
      `INSERT INTO ${VEC_TABLE} (rowid, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`,
      [edit.rowid, ...columns.map((c) => next[c] as string | Uint8Array | null)]
    );
  }
}
