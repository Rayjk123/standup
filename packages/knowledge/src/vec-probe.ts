/**
 * Standalone extension-capability probe for tryEnableSqliteVecExtension.
 *
 * Runs in its OWN process because Database.setCustomSQLite is a one-shot process
 * global: on macOS, pointing it at a path that is missing, not a Mach-O, or not
 * an extension-capable SQLite throws AND leaves the process unable to open ANY
 * database (there is no reset back to bun's bundled SQLite). Validating a
 * candidate here — in a throwaway child — means the PARENT only ever applies a
 * path this probe already proved good, so the collector's own database opens are
 * never put at risk by a bad candidate.
 *
 * Two modes, selected by argv[2]:
 *   <path>     — the candidate SQLite library. Exit 0 means the file is a real
 *                SQLite shared library, that exact library is the SQLite serving
 *                this process's connections once applied, AND sqlite-vec loads
 *                AND a knowledge_chunks_vec vec0 table can be created, written,
 *                and KNN-queried on it. Where setCustomSQLite does not replace
 *                the SQLite bun links in (Linux, where it is a silent no-op), the
 *                candidate never serves a connection, so it is rejected there no
 *                matter what the bundled SQLite can do.
 *   --bundled  — no swap: whether bun's own SQLite already runs sqlite-vec, the
 *                case where no candidate is needed at all.
 * A missing argument, or any failure, exits non-zero. Only the exit code is
 * read — there is no stdout contract.
 */
import { Database } from "bun:sqlite";
import { dlopen, FFIType } from "bun:ffi";
import * as sqliteVec from "sqlite-vec";
import { VEC_TABLE, VEC_PROBE_BUNDLED, buildVecTableDDL, embeddingToBlob } from "./vec.js";

/**
 * The build identity (sqlite3_sourceid: release timestamp + check-in hash) of the
 * SQLite library at `path`, read by dlopen-ing it directly. Throws when the file
 * is missing, is not a loadable shared library, or does not export the sqlite3
 * API — which is what rejects an arbitrary file on every platform.
 */
function librarySourceId(path: string): string {
  const lib = dlopen(path, {
    sqlite3_sourceid: { args: [], returns: FFIType.cstring },
  });
  try {
    const id = String(lib.symbols.sqlite3_sourceid());
    if (!id) throw new Error("sqlite3_sourceid returned nothing");
    return id;
  } finally {
    lib.close();
  }
}

/**
 * Loads sqlite-vec on a fresh connection and exercises vec0 exactly as search
 * does: the real mirror DDL (at a token width), one written row, and the KNN
 * MATCH the search path issues. Returns the connection's sqlite_source_id() so a
 * caller can confirm which SQLite build actually ran it.
 */
function exerciseVec(): string {
  const db = new Database(":memory:");
  try {
    const { id } = db.query("SELECT sqlite_source_id() AS id").get() as { id: string };
    sqliteVec.load(db);
    db.query("SELECT vec_version()").get();
    db.run(buildVecTableDDL(3));
    const blob = embeddingToBlob([1, 0, 0]);
    db.run(
      `INSERT INTO ${VEC_TABLE}(rowid, project_id, scope, owner_user, source_kind, chunk_id, embedding)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      ["p", "global", "", "code", "c", blob]
    );
    db.query(
      `SELECT rowid FROM ${VEC_TABLE} WHERE embedding MATCH ? AND k = 1 ORDER BY distance`
    ).all(blob);
    return id;
  } finally {
    db.close();
  }
}

function probe(arg: string | undefined): boolean {
  if (!arg) return false;
  try {
    if (arg === VEC_PROBE_BUNDLED) {
      exerciseVec();
      return true;
    }
    const expected = librarySourceId(arg);
    Database.setCustomSQLite(arg);
    // setCustomSQLite can return without effect (bun statically links SQLite on
    // Linux), so the candidate counts only if it is the build that served the
    // connection — otherwise a pass would be the bundled SQLite's, not its own.
    return exerciseVec() === expected;
  } catch {
    return false;
  }
}

process.exit(probe(process.argv[2]) ? 0 : 1);
