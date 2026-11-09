/**
 * The knowledge tables of a standup.db as data: a snapshot a migration run can
 * diff (to report exactly what a step changed, and to prove an apply changed
 * nothing it did not plan), restore from a backup copy, and the processes that
 * hold a DB file open.
 *
 * The knowledge tables are the ones KnowledgeStore owns — `knowledge`, its FTS
 * index, chunks and their sqlite-vec mirror, edges, graph meta, drafts, the
 * contradiction-judgment ledger, the publish fact-check's per-doc state, the
 * evidence pass's freshness findings, the model pass's re-verify attempts and
 * code symbols — plus knowledge_changes, the change feed's log, whose
 * personal/owner classification a migration backfills. Every other table in standup.db (sessions, launches, persona state…)
 * is collector data no knowledge migration reads or writes, so neither the
 * snapshot nor a restore touches it.
 *
 * A standup.db runs to gigabytes, nearly all of it transcript events, so every
 * copy and restore here streams through SQLite page by page: a copy is a
 * `VACUUM INTO`, a restore an `INSERT … SELECT` from the attached backup, and a
 * snapshot iterates the knowledge tables a row at a time. Nothing reads a DB
 * file or a non-knowledge table into memory.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "fs";
import { VEC_TABLE, isVecAvailable } from "@standup/knowledge";
import type { Change } from "./runner.ts";

/** The tables a knowledge migration may change, in restore order (chunks before their vec mirror). */
export const KNOWLEDGE_TABLES = [
  "knowledge",
  "knowledge_fts",
  "knowledge_chunks",
  VEC_TABLE,
  "knowledge_edges",
  "knowledge_graph_meta",
  "knowledge_drafts",
  "knowledge_judgments",
  "knowledge_verifications",
  "knowledge_freshness",
  "knowledge_reverify_attempts",
  "code_symbols",
  "knowledge_changes",
] as const;

/**
 * Columns whose values a change report prints (`before → after`). Every other
 * column — titles, bodies, chunk text, tags, embeddings — is reported as
 * rewritten without its value, so a report never carries a secret.
 */
const PRINTABLE_COLUMNS = new Set([
  "id",
  "knowledge_id",
  "chunk_id",
  "src_doc_id",
  "dst_doc_id",
  "project_id",
  "slug",
  "scope",
  "owner_user",
  "source_kind",
  "origin_class",
  "chunk_index",
  "chunker_version",
  "chunk_generation",
  "vector_search_suspended",
  "verdict",
  "confidence",
  "half_life_days",
  "kind",
  "weight",
  "status",
  "outcome",
  "subject_slug",
  "candidate_project_id",
  "candidate_slug",
  "method",
  "attempts",
  "content_first_seen",
  "anchor_at",
  "cap",
  "about_repo",
  "checked_at",
  "last_outcome",
  "last_attempt_at",
  "personal",
]);

interface TableState {
  /** The table's CREATE statement, or null when it does not exist. */
  ddl: string | null;
  columns: string[];
  /** Row key → column → value (printable columns) or a hash of it. */
  rows: Map<string, Record<string, string | number | null>>;
}

/** A snapshot of the knowledge tables: their DDL, columns and rows, plus the doc each row belongs to. */
export interface KnowledgeState {
  tables: Map<string, TableState>;
  /** knowledge id → `<projectId>/<slug>`. */
  docRefs: Map<string, string>;
  /** chunk id → `<projectId>/<slug>#<chunk id>`; chunk rowid → chunk id. */
  chunkRefs: Map<string, string>;
  chunkIdsByRowid: Map<number, string>;
}

function hashValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return `#${Bun.hash(value).toString(16)}`;
  return `#${Bun.hash(String(value)).toString(16)}`;
}

function tableDdl(db: Database, table: string, schema = "main"): string | null {
  const row = db
    .query(`SELECT sql FROM "${schema}".sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | null;
  return row ? (row.sql ?? "") : null;
}

/** Whether `table` can be read on this connection: it exists, and a vec mirror needs sqlite-vec loaded. */
function readable(db: Database, table: string, ddl: string | null): boolean {
  if (ddl === null) return false;
  return table !== VEC_TABLE || isVecAvailable(db);
}

function columnsOf(db: Database, table: string, schema = "main"): string[] {
  return (db.query(`PRAGMA "${schema}".table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

/**
 * Whether a table keeps a rowid that `SELECT *` does not return — a rowid table
 * without an INTEGER PRIMARY KEY alias — so a copy must carry it explicitly to
 * keep rowids (the vec mirror's link to its chunks) intact.
 */
function hiddenRowid(db: Database, table: string, ddl: string): boolean {
  if (/WITHOUT\s+ROWID/i.test(ddl)) return false;
  const pk = (db.query(`PRAGMA backup.table_info("${table}")`).all() as Array<{ type: string; pk: number }>).filter((c) => c.pk > 0);
  return !(pk.length === 1 && pk[0].type.toUpperCase() === "INTEGER");
}

/** The key a row is matched on between two snapshots. */
function rowKey(table: string, row: Record<string, unknown>, seen: Map<string, number>): string {
  let base: string;
  if (table === "knowledge_fts") base = String(row.id);
  else if (table === VEC_TABLE || table === "knowledge_graph_meta") base = String(row.rowid ?? row.id);
  else if (table === "knowledge_freshness" || table === "knowledge_reverify_attempts") base = [row.project_id, row.slug].join("\u0000");
  else if (table === "code_symbols") base = [row.project_id, row.repo_path, row.file, row.line, row.name, row.kind].join("\u0000");
  else base = String(row.id ?? row.rowid);
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}~${n}`;
}

/** Reads the knowledge tables of `db` into a KnowledgeState. */
export function snapshotKnowledge(db: Database): KnowledgeState {
  const tables = new Map<string, TableState>();
  const docRefs = new Map<string, string>();
  const chunkRefs = new Map<string, string>();
  const chunkIdsByRowid = new Map<number, string>();
  for (const table of KNOWLEDGE_TABLES) {
    const ddl = tableDdl(db, table);
    const state: TableState = { ddl, columns: [], rows: new Map() };
    tables.set(table, state);
    if (!readable(db, table, ddl)) continue;
    state.columns = columnsOf(db, table);
    const withRowid = table === "knowledge_chunks" || table === VEC_TABLE || table === "knowledge_fts";
    const sql = `SELECT ${withRowid ? "rowid AS rowid, " : ""}* FROM "${table}"`;
    const seen = new Map<string, number>();
    for (const row of db.query(sql).iterate() as Iterable<Record<string, unknown>>) {
      if (table === "knowledge") docRefs.set(String(row.id), `${row.project_id}/${row.slug}`);
      if (table === "knowledge_chunks") chunkIdsByRowid.set(Number(row.rowid), String(row.id));
      const values: Record<string, string | number | null> = {};
      for (const [col, value] of Object.entries(row)) {
        if (table === "knowledge_fts" && col === "rowid") continue;
        values[col] = PRINTABLE_COLUMNS.has(col) || col === "rowid" ? ((value as string | number | null) ?? null) : hashValue(value);
      }
      if (table === "knowledge_chunks") values.__doc = String(row.knowledge_id);
      state.rows.set(rowKey(table, row, seen), values);
    }
  }
  for (const [key, values] of tables.get("knowledge_chunks")?.rows ?? []) {
    chunkRefs.set(String(values.id ?? key), `${docRefs.get(String(values.__doc)) ?? `?${values.__doc}`}#${values.id ?? key}`);
  }
  return { tables, docRefs, chunkRefs, chunkIdsByRowid };
}

/** The doc ref a row of `table` reports under, resolved against either snapshot. */
function refOf(table: string, key: string, row: Record<string, string | number | null>, states: KnowledgeState[]): string {
  const doc = (id: string) => states.map((s) => s.docRefs.get(id)).find(Boolean);
  const chunk = (id: string) => states.map((s) => s.chunkRefs.get(id)).find(Boolean);
  switch (table) {
    case "knowledge":
      return doc(String(row.id)) ?? `?${row.id}`;
    case "knowledge_fts":
      return doc(key.split("~")[0]) ?? `fts?${key}`;
    case "knowledge_chunks":
      return chunk(String(row.id)) ?? `?#${row.id}`;
    case VEC_TABLE: {
      const chunkId =
        (typeof row.chunk_id === "string" ? row.chunk_id : undefined) ??
        states.map((s) => s.chunkIdsByRowid.get(Number(row.rowid))).find(Boolean);
      return (chunkId && chunk(chunkId)) || `vec?${row.rowid}`;
    }
    case "knowledge_judgments":
      return `${row.project_id}/${row.subject_slug}`;
    case "knowledge_freshness":
    case "knowledge_reverify_attempts":
    case "knowledge_verifications":
      return `${row.project_id}/${row.slug}`;
    case "knowledge_changes":
      return `${row.project_id}/${row.slug}#change:${row.id}`;
    default:
      return `${table}:${key.replace(/\u0000/g, "/")}`;
  }
}

/** The field a column of `table` reports as: a `knowledge` column by name, others prefixed by their table. */
function fieldOf(table: string, column?: string): string {
  const prefix =
    table === "knowledge"
      ? ""
      : table === "knowledge_fts"
        ? "fts"
        : table === "knowledge_chunks"
          ? "chunk"
          : table === VEC_TABLE
            ? "vec"
            : table === "knowledge_changes"
              ? "change"
              : table;
  if (column === undefined) return prefix || "row";
  return prefix ? `${prefix}.${column}` : column;
}

/**
 * Every difference between two snapshots, as Changes: a table created,
 * dropped or redefined (`schema:<table>`), a row inserted or deleted, and each
 * column whose value changed — `set` with before→after for printable columns,
 * `rewrite` (no values) for text. A column only one side has is reported once,
 * as the schema change, not per row.
 */
export function diffKnowledge(before: KnowledgeState, after: KnowledgeState): Change[] {
  const changes: Change[] = [];
  const states = [before, after];
  for (const table of KNOWLEDGE_TABLES) {
    const a = before.tables.get(table)!;
    const b = after.tables.get(table)!;
    const schemaRef = `schema:${table}`;
    if (a.ddl === null && b.ddl !== null) changes.push({ ref: schemaRef, target: "db", field: "table", action: "insert" });
    else if (a.ddl !== null && b.ddl === null) changes.push({ ref: schemaRef, target: "db", field: "table", action: "delete" });
    else if (a.ddl !== b.ddl) {
      const before = a.columns.join(",");
      const after = b.columns.join(",");
      changes.push(
        before === after
          ? { ref: schemaRef, target: "db", field: "ddl", action: "rewrite" }
          : { ref: schemaRef, target: "db", field: "columns", action: "set", before, after }
      );
    }
    const shared = a.columns.filter((c) => b.columns.includes(c));
    for (const [key, row] of a.rows) {
      const next = b.rows.get(key);
      const ref = refOf(table, key, row, states);
      if (!next) {
        changes.push({ ref, target: "db", field: fieldOf(table), action: "delete" });
        continue;
      }
      for (const col of shared) {
        if (row[col] === next[col]) continue;
        changes.push(
          PRINTABLE_COLUMNS.has(col)
            ? { ref, target: "db", field: fieldOf(table, col), action: "set", before: fmt(row[col]), after: fmt(next[col]) }
            : { ref, target: "db", field: fieldOf(table, col), action: "rewrite" }
        );
      }
    }
    for (const [key, row] of b.rows) {
      if (!a.rows.has(key)) changes.push({ ref: refOf(table, key, row, states), target: "db", field: fieldOf(table), action: "insert" });
    }
  }
  return changes;
}

const fmt = (value: string | number | null | undefined) => (value === null || value === undefined ? null : String(value));

/**
 * Writes a consistent copy of `db` to `target`, a path that must not exist yet,
 * with SQLite's `VACUUM INTO`: page by page through SQLite's cache, so memory
 * stays flat however large the DB is. A file-backed DB is copied through a
 * read-only connection of its own, which cannot write the source.
 */
export function copyDatabase(db: Database, target: string): void {
  const fileBacked = db.filename !== "" && db.filename !== ":memory:";
  const source = fileBacked ? new Database(db.filename, { readonly: true }) : db;
  try {
    source.run("VACUUM INTO ?", [target]);
  } finally {
    if (source !== db) source.close();
  }
}

/**
 * Replaces the knowledge tables of `db` with those of the backup DB at
 * `backupPath` — schema, indexes and rows (rowids kept, so the vec mirror still
 * points at its chunks) — in one transaction, leaving every other table as it
 * is. A knowledge table the backup lacks is dropped.
 */
export function restoreKnowledgeTables(db: Database, backupPath: string): void {
  const vec = isVecAvailable(db);
  const foreignKeys = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  db.run("PRAGMA foreign_keys = OFF");
  db.run("ATTACH DATABASE ? AS backup", [backupPath]);
  try {
    if (!vec && (tableDdl(db, VEC_TABLE) !== null || tableDdl(db, VEC_TABLE, "backup") !== null)) {
      throw new Error(`restoring ${VEC_TABLE} needs sqlite-vec, which this process cannot load`);
    }
    db.transaction(() => {
      for (const table of [...KNOWLEDGE_TABLES].reverse()) {
        if (tableDdl(db, table) !== null) db.run(`DROP TABLE main."${table}"`);
      }
      for (const table of KNOWLEDGE_TABLES) {
        const ddl = tableDdl(db, table, "backup");
        if (ddl === null) continue;
        db.run(ddl);
        const virtual = /^CREATE VIRTUAL/i.test(ddl);
        const columns = columnsOf(db, table, "backup")
          .filter((c) => c !== "rowid")
          .map((c) => `"${c}"`)
          .join(", ");
        const rowid = virtual || hiddenRowid(db, table, ddl) ? "rowid, " : "";
        db.run(`INSERT INTO main."${table}" (${rowid}${columns}) SELECT ${rowid}${columns} FROM backup."${table}"`);
        if (virtual) continue;
        const indexes = db
          .query(`SELECT sql FROM backup.sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL`)
          .all(table) as Array<{ sql: string }>;
        for (const { sql } of indexes) db.run(sql);
      }
    })();
  } finally {
    db.run("DETACH DATABASE backup");
    db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}

/**
 * The ids of other processes holding `path` (or its -wal/-shm) open, read from
 * /proc on Linux. Empty where /proc is unavailable; the caller then relies on
 * the DB's own locking.
 */
export function processesHolding(path: string): number[] {
  if (!existsSync("/proc/self/fd")) return [];
  const targets = new Set(["", "-wal", "-shm"].map((suffix) => `${realpathSafe(path)}${suffix}`));
  const holders: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (targets.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
          holders.push(pid);
          break;
        }
      } catch {
        // The fd closed while it was being read.
      }
    }
  }
  return holders;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
