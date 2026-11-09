import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import * as sqliteVec from "sqlite-vec";

/**
 * The vec0 virtual table that mirrors knowledge_chunks' embeddings for KNN
 * search. It is a pure projection of knowledge_chunks (which keeps each
 * embedding as the authoritative rebuild source), so it is always
 * rebuildable and never the source of truth — dropped and repopulated on a
 * dimension-switch reindex, maintained incrementally on chunk upsert/delete.
 * Each row's rowid is the mirrored knowledge_chunks.rowid, so a chunk's vector
 * can be re-pointed or removed by that stable integer.
 */
export const VEC_TABLE = "knowledge_chunks_vec";

/**
 * The value stored in the vec0 mirror's `owner_user` partition key for a doc
 * that has no owning user (every 'global'/'project'-scoped doc). vec0 partition
 * keys are indexed columns, so a NON-NULL sentinel is stored rather than NULL —
 * the owner-unconstrained specs never filter on it (so the sentinel rows are
 * still returned), and an owner-scoped spec filters `owner_user = '<alias>'`,
 * which a trimmed alias can never equal. The authoritative gate re-check runs
 * against the `knowledge` table (NULL-aware) during hydration, so the sentinel
 * is a mirror-only encoding detail, never a value any query supplies.
 */
export const VEC_OWNER_NONE = "";

/**
 * The DDL for the vec0 mirror at a fixed embedding width. Its scope/owner
 * PARTITION KEYS (alongside project_id) are what let a scope/owner-gated KNN
 * pre-filter during the scan, so gated searches use the index instead of the
 * brute-force cosine scan. cosine distance is declared so `ORDER BY distance`
 * ascending is cosine-similarity descending — the exact ordering the brute-force
 * scan produces. `+chunk_id` is an auxiliary (unindexed) column; `source_kind`
 * is a metadata column filterable with `IN`. The width is fixed at creation, so
 * a provider/model switch that changes it must drop the table first
 * (clearAllChunks does).
 */
export function buildVecTableDDL(dimensions: number): string {
  return `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
         project_id text partition key,
         scope text partition key,
         owner_user text partition key,
         source_kind text,
         +chunk_id text,
         embedding float[${dimensions}] distance_metric=cosine
       )`;
}

/**
 * Whether an existing vec0 mirror's stored CREATE statement already declares the
 * scope/owner partition keys — the schema check that decides whether a mirror
 * from an older build (partitioned only by project_id) must be rebuilt once onto
 * the current schema. A missing/empty statement reads false (nothing to keep).
 */
export function vecTableDeclaresPartitionKeys(
  createSql: string | null | undefined
): boolean {
  if (!createSql) return false;
  return /\bscope\b/.test(createSql) && /\bowner_user\b/.test(createSql);
}

function envTrue(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/**
 * The operational escape hatch and the lever the brute-force/KNN parity test
 * pulls: with STANDUP_DISABLE_VEC set, every capability probe reports the
 * extension unavailable, so search takes the linear JS cosine path even on a
 * host where sqlite-vec would load. Lets the same corpus be queried both ways
 * to prove the two agree, and gives an instant rollback if the index ever
 * misbehaves.
 */
export function vecExplicitlyDisabled(): boolean {
  return envTrue(process.env.STANDUP_DISABLE_VEC);
}

// Per-connection capability, resolved once. bun:sqlite's macOS build cannot
// load extensions ("does not support dynamic extension loading"), so there this
// is false unless the process opened its databases against an extension-capable
// SQLite (see enableSqliteVecExtension); bun's Linux build loads extensions
// natively. Where it is false, search falls back to the brute-force scan. A WeakMap so a closed/GC'd db drops
// out without leaking, and so the throwing probe runs at most once per handle.
const capability = new WeakMap<Database, boolean>();

/**
 * Whether sqlite-vec can run on this connection. Attempts to load the extension
 * once and probes vec_version(); any failure (extension loading disabled, the
 * shared library absent, a version mismatch) resolves to false and is cached,
 * so the caller silently falls back to the linear scan rather than throwing.
 */
export function isVecAvailable(db: Database): boolean {
  if (vecExplicitlyDisabled()) return false;
  const cached = capability.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    sqliteVec.load(db);
    db.query("SELECT vec_version()").get();
    ok = true;
  } catch {
    ok = false;
  }
  capability.set(db, ok);
  return ok;
}

/** A chunk embedding as the little-endian float32 blob vec0 stores and matches. */
export function embeddingToBlob(embedding: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(embedding).buffer);
}

/** The vector a little-endian float32 blob (embeddingToBlob) encodes. */
export function blobToEmbedding(blob: Uint8Array): number[] {
  // A Float32Array view needs a 4-byte-aligned offset; a blob sliced out of a
  // larger buffer at an odd offset is copied first.
  const bytes = blob.byteOffset % 4 === 0 ? blob : blob.slice();
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
}

/**
 * A knowledge_chunks row's vector: the float32 `embedding_blob` when the row
 * has one, else the `embedding_json` text a row written before the blob
 * column existed still carries. Null when neither holds a readable vector.
 */
export function chunkEmbedding(
  blob: Uint8Array | null | undefined,
  json: string | null | undefined
): number[] | null {
  if (blob && blob.byteLength > 0) return blobToEmbedding(blob);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}

/** The width of a chunk row's vector, read without decoding a blob. */
export function chunkEmbeddingWidth(
  blob: Uint8Array | null | undefined,
  json: string | null | undefined
): number | null {
  if (blob && blob.byteLength > 0) return Math.floor(blob.byteLength / 4);
  return chunkEmbedding(null, json)?.length ?? null;
}

/**
 * The vec-probe.ts argument that probes bun's own SQLite (no swap) instead of a
 * candidate library path.
 */
export const VEC_PROBE_BUNDLED = "--bundled";

/**
 * The extension-capable SQLite libraries to try, in preference order:
 * STANDUP_SQLITE_PATH when the operator set it, otherwise the common Homebrew
 * locations. Where bun's bundled SQLite has no dynamic extension loading (macOS),
 * one of these must back the process for sqlite-vec to load.
 */
function sqliteVecCandidates(): string[] {
  const explicit = process.env.STANDUP_SQLITE_PATH;
  return explicit
    ? [explicit]
    : [
        "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
        "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      ];
}

/** The outcome of enableSqliteVecExtension. */
export interface SqliteVecEnablement {
  /** Whether connections this process opens can run sqlite-vec. */
  enabled: boolean;
  /**
   * The custom SQLite library installed via setCustomSQLite, or null when none
   * was (bun's bundled SQLite serves the process, capable or not).
   */
  library: string | null;
  /** Candidates that exist on disk but failed the probe and were never applied. */
  rejected: string[];
}

/** Runs vec-probe.ts on `arg` in a throwaway child; true when it exits 0. */
function runVecProbe(arg: string): boolean {
  const probeScript = join(import.meta.dir, "vec-probe.ts");
  const probe = Bun.spawnSync([process.execPath, "run", probeScript, arg], {
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  return probe.exitCode === 0;
}

/**
 * Makes sqlite-vec loadable for every connection this process opens — the one
 * prerequisite for the KNN path. MUST run before any Database is opened
 * (setCustomSQLite is a process-global that may be called only once, before the
 * first connection), so the collector calls it at the very top of startup.
 *
 * Whether a swap is needed depends on bun's build for the platform. On macOS
 * bun's bundled SQLite has no dynamic extension loading, so an extension-capable
 * library (STANDUP_SQLITE_PATH or Homebrew's) must be installed with
 * setCustomSQLite. On Linux bun statically links a SQLite that already loads
 * extensions and setCustomSQLite is a silent no-op, so no candidate can ever be
 * installed there and the bundled SQLite is what runs sqlite-vec.
 *
 * Auto-on when available: on a capable host the KNN path turns on with no
 * configuration; elsewhere it is a clean no-op and search stays on the
 * brute-force cosine scan. STANDUP_DISABLE_VEC is the explicit opt-out, checked
 * first. The legacy STANDUP_SQLITE_VEC flag is accepted but does not gate.
 *
 * Fully guarded, because setCustomSQLite is unforgiving: on macOS, pointing it
 * at a path that is missing, not a Mach-O, or not an extension-capable SQLite
 * THROWS and still leaves the process unable to open ANY database, with no reset
 * back to the bundled SQLite — so a naive in-process "try and catch" would strand
 * every DB open in the process, not just the knowledge index. Instead each
 * candidate that exists on disk is validated in a THROWAWAY CHILD process
 * (vec-probe.ts), which confirms the file is a real SQLite library, that it is
 * the build actually serving connections once applied, and that the full load +
 * vec_version + knowledge_chunks_vec vec0 create/query works on it; only a
 * candidate the child proves good is applied here, in the parent. When none
 * passes, a second child checks whether the bundled SQLite runs sqlite-vec on its
 * own. Neither probe opens a connection in the parent, so a later swap is never
 * foreclosed and a rejected candidate never touches the parent's SQLite.
 */
export function enableSqliteVecExtension(): SqliteVecEnablement {
  const rejected: string[] = [];
  if (vecExplicitlyDisabled()) return { enabled: false, library: null, rejected };

  for (const candidate of sqliteVecCandidates()) {
    // A missing file can't be probed and would poison an in-process attempt, so
    // skip it outright — a host without Homebrew's SQLite does no work for it.
    if (!existsSync(candidate)) continue;
    if (!runVecProbe(candidate)) {
      rejected.push(candidate);
      continue;
    }
    try {
      // The child just proved this exact path good on this host, so the swap is
      // safe: it will not throw and cannot leave the process on a broken SQLite.
      Database.setCustomSQLite(candidate);
      return { enabled: true, library: candidate, rejected };
    } catch {
      // Unreachable in practice (the child validated the same path); if the swap
      // somehow fails, leave the process on its pristine bundled SQLite.
      return { enabled: false, library: null, rejected };
    }
  }
  return { enabled: runVecProbe(VEC_PROBE_BUNDLED), library: null, rejected };
}

/**
 * enableSqliteVecExtension reduced to its verdict: whether connections this
 * process opens can run sqlite-vec, through an installed custom SQLite or the
 * bundled one.
 */
export function tryEnableSqliteVecExtension(): boolean {
  return enableSqliteVecExtension().enabled;
}
