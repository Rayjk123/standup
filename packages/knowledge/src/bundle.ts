import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createStore, getSetting, setSetting } from "@standup/store";
import { KnowledgeStore } from "./store.js";
import { KnowledgeLoader } from "./loader.js";
import { layerOf, type DraftDispute } from "./types.js";
import { EMBEDDING_FINGERPRINT_KEY } from "./embeddings.js";
import { chunkEmbedding, embeddingToBlob } from "./vec.js";

/**
 * Portable knowledge-base bundle: export the KB from one host and import it on
 * another (e.g. a remote dev machine) preserving everything meaningful, WITHOUT
 * copying the whole ~800MB collector DB (which also holds sessions, transcripts,
 * and telemetry unrelated to knowledge).
 *
 * The bundle is knowledge-SCOPED. Markdown under KNOWLEDGE_DIR stays the source
 * of truth, so it is carried verbatim; the DB carries only what is NOT
 * rebuildable from that markdown:
 *   - DB-only, unrecoverable state keyed by (project_id, slug): doc + draft
 *     verdicts/disputes (cron-owned, deliberately omitted by upsertDoc), the
 *     retrieval-usage telemetry, the contradiction-resolution ledger (incl. the
 *     needs_review queue), the knowledge-changes feed, and projects.knowledge_scope.
 *   - The embedded chunks (+ their vectors) and the embedding-provider
 *     fingerprint, so the target boots search-ready with ZERO embedding calls —
 *     import must work even when no embedding provider is reachable on the target.
 *
 * knowledge_edges / knowledge_fts / knowledge_graph_meta / the vec0 mirror are
 * NOT bundled — they are re-derived on import from the carried markdown + chunks.
 *
 * Export is READ-ONLY: it opens the source DB read-only and never mutates it.
 */

/**
 * Bump when the on-disk bundle layout changes. Version 2 carries the retrieval
 * observability fields (injected, launch, components, algorithm version,
 * placement, drop reason) and the knowledge-change privacy fields; a version-1
 * bundle still imports, with those fields derived from the imported docs.
 */
export const BUNDLE_VERSION = 2;

// The settings key holding the fingerprint the corpus was embedded under —
// restored on import so a later boot on the same provider does not treat the
// carried chunks as stale and wipe them.
export { EMBEDDING_FINGERPRINT_KEY };

const KNOWLEDGE_SUBDIR = "knowledge";
const DB_STATE_FILE = "db-state.json";
const CHUNKS_FILE = "chunks.json";
const MANIFEST_FILE = "manifest.json";

/** A doc- or draft-level verdict + its disputes, keyed by (project_id, slug). */
export interface BundleVerdict {
  projectId: string;
  slug: string;
  verdict: string;
  disputes: DraftDispute[];
}

/** One knowledge_retrievals telemetry row, verbatim (created_at preserved so the
 *  staleness/usage signal survives the move rather than resetting to import time). */
export interface BundleRetrieval {
  docProject: string;
  docSlug: string;
  query: string;
  rank: number;
  score: number | null;
  surface: string;
  sessionId: string | null;
  queryProject: string | null;
  createdAt: string;
  /** The fields below are absent in a version-1 bundle. */
  injected?: boolean | null;
  launchId?: string | null;
  components?: Record<string, unknown> | null;
  algoVersion?: string | null;
  rawScore?: number | null;
  relevance?: number | null;
  layer?: string | null;
  sourceKind?: string | null;
  scope?: string | null;
  docOwner?: string | null;
  dropReason?: string | null;
}

/** One knowledge_resolutions ledger row (the contradiction-resolver record). */
export interface BundleResolution {
  id: string;
  projectId: string;
  winnerSlug: string;
  loserSlug: string;
  type: string;
  status: string;
  autoApplied: boolean;
  rationale: string;
  detail: string | null;
  createdAt: string;
}

/** One knowledge_changes feed row. */
export interface BundleChange {
  id: string;
  projectId: string;
  slug: string;
  kind: string;
  title: string;
  sessionId: string | null;
  contradicted: string[] | null;
  createdAt: string;
  /** Absent in a version-1 bundle. */
  personal?: boolean | null;
  ownerUser?: string | null;
}

/** A per-project authoring default (projects.knowledge_scope). */
export interface BundleKnowledgeScope {
  projectId: string;
  scope: string;
}

/** The §B DB-only rows carried in db-state.json. */
export interface BundleDbState {
  docVerdicts: BundleVerdict[];
  draftVerdicts: BundleVerdict[];
  retrievals: BundleRetrieval[];
  resolutions: BundleResolution[];
  changes: BundleChange[];
  knowledgeScopes: BundleKnowledgeScope[];
}

/** A carried chunk, re-keyed to its doc by (project_id, slug) since the doc id is
 *  a rebuildable UUID the loader re-mints on import. */
export interface BundleChunk {
  id: string;
  projectId: string;
  slug: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  /** The chunker version that produced the chunk; absent or null when unknown. */
  chunkerVersion?: number | null;
}

/** chunks.json payload. */
export interface BundleChunks {
  chunks: BundleChunk[];
}

export interface BundleManifest {
  bundleVersion: number;
  /** MAX(schema_version) of the SOURCE DB, so an older-schema bundle can be
   *  imported and migrated up, and a bundle newer than the importing binary is
   *  refused rather than silently half-restored. */
  sourceSchemaVersion: number;
  /** The embedding fingerprint the chunks were produced under, or null when the
   *  source had no provider configured (text-only corpus). */
  embeddingFingerprint: string | null;
  exportedAt: string;
  counts: {
    docs: number;
    drafts: number;
    chunks: number;
    docVerdicts: number;
    draftVerdicts: number;
    retrievals: number;
    resolutions: number;
    changes: number;
    knowledgeScopes: number;
  };
  /** SHA-256 over the markdown tree + db-state.json + chunks.json, so a corrupted
   *  or tampered payload is caught on import. Excludes manifest.json itself. */
  contentChecksum: string;
}

/** Everything a bundle carries besides its markdown tree, as a source reads it. */
export interface BundleSnapshot {
  sourceSchemaVersion: number;
  embeddingFingerprint: string | null;
  docs: number;
  drafts: number;
  state: BundleDbState;
  chunks: BundleChunk[];
}

/**
 * Where a bundle is read from: the collector DB plus KNOWLEDGE_DIR on this host
 * (dbBundleSource), or a running collector's read API (apiBundleSource in
 * bundle-api.ts). `read` writes the markdown tree into `treeDest` and returns
 * the rest of the payload.
 */
export interface BundleSource {
  read(treeDest: string): Promise<BundleSnapshot>;
}

export type ExportBundleOptions = (
  | {
      /** Source collector DB (opened READ-ONLY). */
      dbPath: string;
      /** Source KNOWLEDGE_DIR (the markdown source of truth). */
      knowledgeDir: string;
    }
  | { source: BundleSource }
) & {
  /** Destination directory for the bundle (created if absent). */
  outDir: string;
  /** ISO timestamp stamped into the manifest; defaults to now. */
  exportedAt?: string;
};

export interface ImportBundleOptions {
  /** The bundle directory produced by exportKnowledgeBundle. */
  bundleDir: string;
  /** Target KNOWLEDGE_DIR the markdown is unpacked into. */
  knowledgeDir: string;
  /** Target collector DB (created + migrated if absent). */
  dbPath: string;
  /** Overwrite matching (project_id, slug) docs in a non-empty target. Without
   *  it a non-empty target is refused, to protect an existing KB. */
  force?: boolean;
}

export interface ImportBundleResult {
  manifest: BundleManifest;
  docs: number;
  drafts: number;
  chunks: number;
  skippedChunks: number;
  docVerdicts: number;
  draftVerdicts: number;
  retrievals: number;
  resolutions: number;
  changes: number;
  knowledgeScopes: number;
  /** Whether the vec0 KNN mirror was rebuilt (only when sqlite-vec is loadable
   *  on the target connection; otherwise search falls back to the brute-force
   *  scan and this is false). */
  vecRebuilt: boolean;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tableExists(db: Database, name: string): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

/** A file in the markdown tree, its path relative to the tree root (normalized to
 *  forward slashes so a bundle checksums identically across platforms). */
interface TreeFile {
  rel: string;
  hash: string;
}

/**
 * Walks a directory tree, returning every file's tree-relative path and content
 * hash, sorted by path. A missing root yields an empty list (an export of a
 * never-populated KNOWLEDGE_DIR is a valid empty bundle).
 */
async function walkTree(root: string): Promise<TreeFile[]> {
  const files: TreeFile[] = [];

  async function walk(relDir: string): Promise<void> {
    const abs = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, rel));
        files.push({ rel, hash: sha256Hex(bytes) });
      }
    }
  }

  await walk("");
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Copies a directory tree verbatim (files + nested dirs) into `dest`. */
async function copyTree(src: string, dest: string): Promise<void> {
  async function walk(relDir: string): Promise<void> {
    const abs = relDir ? join(src, relDir) : src;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await mkdir(relDir ? join(dest, relDir) : dest, { recursive: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(src, rel));
        await writeFile(join(dest, rel), bytes);
      }
    }
  }
  await walk("");
}

/**
 * The bundle's integrity checksum: a stable fold over the markdown tree's
 * per-file hashes plus the hashes of the two data files. Computed identically on
 * export and import; a mismatch means the payload changed and the import is
 * refused. NUL-separated so shifting bytes between fields cannot forge an
 * unchanged input.
 */
function computeContentChecksum(
  tree: TreeFile[],
  dbStateHash: string,
  chunksHash: string
): string {
  const h = createHash("sha256");
  for (const f of tree) {
    h.update(f.rel);
    h.update("\0");
    h.update(f.hash);
    h.update("\n");
  }
  h.update("db-state\0");
  h.update(dbStateHash);
  h.update("\n");
  h.update("chunks\0");
  h.update(chunksHash);
  h.update("\n");
  return h.digest("hex");
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}

/**
 * Reads the §B DB-only rows and the carried chunks from a READ-ONLY source
 * connection. Every table is existence-guarded so a bundle exported from an
 * older schema (before knowledge_resolutions / knowledge_changes existed) simply
 * carries empty arrays for the missing tables rather than throwing.
 */
function readSourceState(db: Database): {
  state: BundleDbState;
  chunks: BundleChunk[];
} {
  const docVerdicts: BundleVerdict[] = tableExists(db, "knowledge")
    ? (
        db
          .query(
            `SELECT project_id, slug, verdict, disputes_json
             FROM knowledge WHERE verdict IS NOT NULL
             ORDER BY project_id, slug`
          )
          .all() as Array<{
          project_id: string;
          slug: string;
          verdict: string;
          disputes_json: string | null;
        }>
      ).map((r) => ({
        projectId: r.project_id,
        slug: r.slug,
        verdict: r.verdict,
        disputes: r.disputes_json ? (JSON.parse(r.disputes_json) as DraftDispute[]) : [],
      }))
    : [];

  // A draft defaults to verdict='unverified' with no disputes, which the loader
  // reproduces on import — so only a non-default verdict (or recorded disputes)
  // is worth carrying.
  const draftVerdicts: BundleVerdict[] = tableExists(db, "knowledge_drafts")
    ? (
        db
          .query(
            `SELECT project_id, slug, verdict, disputes_json
             FROM knowledge_drafts
             WHERE verdict IS NOT NULL AND (verdict != 'unverified' OR disputes_json IS NOT NULL)
             ORDER BY project_id, slug`
          )
          .all() as Array<{
          project_id: string;
          slug: string;
          verdict: string;
          disputes_json: string | null;
        }>
      ).map((r) => ({
        projectId: r.project_id,
        slug: r.slug,
        verdict: r.verdict,
        disputes: r.disputes_json ? (JSON.parse(r.disputes_json) as DraftDispute[]) : [],
      }))
    : [];

  // A source written before a column existed reads NULL for it.
  const columnsOf = (table: string): Set<string> =>
    new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  const retrievalColumns = columnsOf("knowledge_retrievals");
  const retrievalCol = (c: string) => (retrievalColumns.has(c) ? c : `NULL AS ${c}`);
  const retrievals: BundleRetrieval[] = tableExists(db, "knowledge_retrievals")
    ? (
        db
          .query(
            `SELECT doc_project, doc_slug, query, rank, score, surface, session_id, query_project, created_at,
                    ${[
                      "injected",
                      "launch_id",
                      "components_json",
                      "algo_version",
                      "raw_score",
                      "relevance",
                      "layer",
                      "source_kind",
                      "scope",
                      "doc_owner",
                      "drop_reason",
                    ]
                      .map(retrievalCol)
                      .join(", ")}
             FROM knowledge_retrievals ORDER BY id`
          )
          .all() as Array<{
          doc_project: string;
          doc_slug: string;
          query: string;
          rank: number;
          score: number | null;
          surface: string;
          session_id: string | null;
          query_project: string | null;
          created_at: string;
          injected: number | null;
          launch_id: string | null;
          components_json: string | null;
          algo_version: string | null;
          raw_score: number | null;
          relevance: number | null;
          layer: string | null;
          source_kind: string | null;
          scope: string | null;
          doc_owner: string | null;
          drop_reason: string | null;
        }>
      ).map((r) => ({
        docProject: r.doc_project,
        docSlug: r.doc_slug,
        query: r.query,
        rank: r.rank,
        score: r.score,
        surface: r.surface,
        sessionId: r.session_id,
        queryProject: r.query_project,
        createdAt: r.created_at,
        injected: r.injected === null ? null : r.injected === 1,
        launchId: r.launch_id,
        components: r.components_json ? (JSON.parse(r.components_json) as Record<string, unknown>) : null,
        algoVersion: r.algo_version,
        rawScore: r.raw_score,
        relevance: r.relevance,
        layer: r.layer,
        sourceKind: r.source_kind,
        scope: r.scope,
        docOwner: r.doc_owner,
        dropReason: r.drop_reason,
      }))
    : [];

  const resolutions: BundleResolution[] = tableExists(db, "knowledge_resolutions")
    ? (
        db
          .query(
            `SELECT id, project_id, winner_slug, loser_slug, type, status, auto_applied, rationale, detail, created_at
             FROM knowledge_resolutions ORDER BY created_at, id`
          )
          .all() as Array<{
          id: string;
          project_id: string;
          winner_slug: string;
          loser_slug: string;
          type: string;
          status: string;
          auto_applied: number;
          rationale: string;
          detail: string | null;
          created_at: string;
        }>
      ).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        winnerSlug: r.winner_slug,
        loserSlug: r.loser_slug,
        type: r.type,
        status: r.status,
        autoApplied: r.auto_applied === 1,
        rationale: r.rationale,
        detail: r.detail,
        createdAt: r.created_at,
      }))
    : [];

  const changes: BundleChange[] = tableExists(db, "knowledge_changes")
    ? (
        db
          .query(
            `SELECT id, project_id, slug, kind, title, session_id, contradicted, created_at,
                    ${columnsOf("knowledge_changes").has("personal") ? "personal, owner_user" : "NULL AS personal, NULL AS owner_user"}
             FROM knowledge_changes ORDER BY created_at, id`
          )
          .all() as Array<{
          id: string;
          project_id: string;
          slug: string;
          kind: string;
          title: string;
          session_id: string | null;
          contradicted: string | null;
          created_at: string;
          personal: number | null;
          owner_user: string | null;
        }>
      ).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        slug: r.slug,
        kind: r.kind,
        title: r.title,
        sessionId: r.session_id,
        contradicted: r.contradicted ? (JSON.parse(r.contradicted) as string[]) : null,
        createdAt: r.created_at,
        personal: r.personal === null ? null : r.personal === 1,
        ownerUser: r.owner_user,
      }))
    : [];

  const knowledgeScopes: BundleKnowledgeScope[] = tableExists(db, "projects")
    ? (
        db
          .query(
            `SELECT id, knowledge_scope FROM projects
             WHERE knowledge_scope IS NOT NULL ORDER BY id`
          )
          .all() as Array<{ id: string; knowledge_scope: string }>
      ).map((r) => ({ projectId: r.id, scope: r.knowledge_scope }))
    : [];

  // Chunks re-keyed to their doc by (project_id, slug): the doc id is a
  // rebuildable UUID the loader re-mints on import, so carrying it would strand
  // the chunk against a doc that no longer exists under that id.
  // A source written before chunks carried their chunker version has no column.
  // Nor, before chunk vectors were stored as float32 blobs, an embedding_blob.
  const chunkColumns = tableExists(db, "knowledge_chunks")
    ? new Set((db.query("PRAGMA table_info(knowledge_chunks)").all() as Array<{ name: string }>).map((c) => c.name))
    : new Set<string>();
  const chunks: BundleChunk[] = tableExists(db, "knowledge_chunks")
    ? (
        db
          .query(
            `SELECT k.project_id AS project_id, k.slug AS slug, kc.id AS id,
                    kc.chunk_index AS chunk_index, kc.text AS text, kc.embedding_json AS embedding_json,
                    ${chunkColumns.has("embedding_blob") ? "kc.embedding_blob" : "NULL"} AS embedding_blob,
                    ${chunkColumns.has("chunker_version") ? "kc.chunker_version" : "NULL"} AS chunker_version
             FROM knowledge_chunks kc JOIN knowledge k ON k.id = kc.knowledge_id
             ORDER BY k.project_id, k.slug, kc.chunk_index`
          )
          .all() as Array<{
          project_id: string;
          slug: string;
          id: string;
          chunk_index: number;
          text: string;
          embedding_json: string;
          embedding_blob: Uint8Array | null;
          chunker_version: number | null;
        }>
      ).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        slug: r.slug,
        chunkIndex: r.chunk_index,
        text: r.text,
        embedding: chunkEmbedding(r.embedding_blob, r.embedding_json) ?? [],
        chunkerVersion: r.chunker_version,
      }))
    : [];

  return {
    state: { docVerdicts, draftVerdicts, retrievals, resolutions, changes, knowledgeScopes },
    chunks,
  };
}

/**
 * A bundle source over this host's collector DB, opened READ-ONLY (never
 * mutated), and its KNOWLEDGE_DIR, whose markdown tree is copied verbatim.
 */
export function dbBundleSource(options: { dbPath: string; knowledgeDir: string }): BundleSource {
  return {
    async read(treeDest) {
      // Read-only handle: no migrations, no ensureTables — export must never write
      // to the source. (KnowledgeStore's constructor runs DDL, so it is deliberately
      // NOT used here; plain SELECTs read the schema directly.)
      const db = new Database(options.dbPath, { readonly: true });
      try {
        const schemaRow = tableExists(db, "schema_version")
          ? (db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
              v: number | null;
            } | null)
          : null;

        const embeddingFingerprint = tableExists(db, "settings")
          ? getSetting(db, EMBEDDING_FINGERPRINT_KEY)
          : null;

        const docs = tableExists(db, "knowledge")
          ? count(db, "SELECT COUNT(*) AS n FROM knowledge")
          : 0;
        const drafts = tableExists(db, "knowledge_drafts")
          ? count(db, "SELECT COUNT(*) AS n FROM knowledge_drafts")
          : 0;

        const { state, chunks } = readSourceState(db);
        await copyTree(options.knowledgeDir, treeDest);
        return { sourceSchemaVersion: schemaRow?.v ?? 0, embeddingFingerprint, docs, drafts, state, chunks };
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Writes a portable, knowledge-scoped bundle from `options.source`, or from
 * the DB and KNOWLEDGE_DIR named by `dbPath` and `knowledgeDir`.
 */
export async function exportKnowledgeBundle(
  options: ExportBundleOptions
): Promise<BundleManifest> {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const source = "source" in options ? options.source : dbBundleSource(options);

  await mkdir(options.outDir, { recursive: true });
  const treeDest = join(options.outDir, KNOWLEDGE_SUBDIR);
  const { sourceSchemaVersion, embeddingFingerprint, docs, drafts, state, chunks } = await source.read(treeDest);

  // Serialize the two data files first so their exact bytes feed the checksum.
  const dbStateJson = JSON.stringify(state, null, 2);
  const chunksJson = JSON.stringify({ chunks } satisfies BundleChunks, null, 2);

  // Hash the tree from the destination just written, so the checksum reflects
  // exactly what the bundle carries.
  const tree = await walkTree(treeDest);

  await writeFile(join(options.outDir, DB_STATE_FILE), dbStateJson, "utf-8");
  await writeFile(join(options.outDir, CHUNKS_FILE), chunksJson, "utf-8");

  const contentChecksum = computeContentChecksum(
    tree,
    sha256Hex(dbStateJson),
    sha256Hex(chunksJson)
  );

  const manifest: BundleManifest = {
    bundleVersion: BUNDLE_VERSION,
    sourceSchemaVersion,
    embeddingFingerprint,
    exportedAt,
    counts: {
      docs,
      drafts,
      chunks: chunks.length,
      docVerdicts: state.docVerdicts.length,
      draftVerdicts: state.draftVerdicts.length,
      retrievals: state.retrievals.length,
      resolutions: state.resolutions.length,
      changes: state.changes.length,
      knowledgeScopes: state.knowledgeScopes.length,
    },
    contentChecksum,
  };

  await writeFile(
    join(options.outDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  return manifest;
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

/** True when the target already holds a KB — either markdown docs on disk or
 *  knowledge rows in the DB — so an unforced import that would overwrite it is
 *  refused. */
async function targetIsNonEmpty(knowledgeDir: string, dbPath: string): Promise<boolean> {
  if (existsSync(knowledgeDir)) {
    const entries = await readdir(knowledgeDir);
    if (entries.length > 0) return true;
  }
  if (existsSync(dbPath)) {
    // Read-only probe so the emptiness check itself never mutates the target.
    try {
      const probe = new Database(dbPath, { readonly: true });
      try {
        if (tableExists(probe, "knowledge")) {
          const n = count(probe, "SELECT COUNT(*) AS n FROM knowledge");
          if (n > 0) return true;
        }
      } finally {
        probe.close();
      }
    } catch {
      // An unreadable/locked file is treated as present-and-unknown: fail safe
      // by declaring the target non-empty so an unforced import refuses it.
      return true;
    }
  }
  return false;
}

/** Restores projects.knowledge_scope, upserting a minimal projects row when the
 *  target has none for that id so the per-project authoring default survives the
 *  move (the plan's DB-only unrecoverable state). An existing row keeps every
 *  other column; only knowledge_scope is set. */
function restoreKnowledgeScope(db: Database, projectId: string, scope: string): void {
  db.run(
    `INSERT INTO projects (id, name, knowledge_scope) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET knowledge_scope = excluded.knowledge_scope`,
    [projectId, projectId, scope]
  );
}

/**
 * Imports a bundle into a target KNOWLEDGE_DIR + DB. Validates the manifest,
 * refuses a non-empty target unless `force`, unpacks the markdown, migrates a
 * fresh store, restores the embedding fingerprint + carried chunks so NO
 * re-embedding happens (import makes ZERO embedding calls and needs no reachable
 * provider), loads docs/drafts from markdown, replays the §B DB-only rows, and
 * rebuilds the vec0 mirror from the carried vectors (no network). It deliberately
 * does NOT run the project-docs / native-memory ingests — a host lacking the
 * upstream sources must not delete the carried mirror docs.
 */
export async function importKnowledgeBundle(
  options: ImportBundleOptions
): Promise<ImportBundleResult> {
  const manifest = await readJsonFile<BundleManifest>(
    join(options.bundleDir, MANIFEST_FILE)
  );

  if (manifest.bundleVersion > BUNDLE_VERSION) {
    throw new Error(
      `bundle version ${manifest.bundleVersion} is newer than this build supports (${BUNDLE_VERSION})`
    );
  }

  // Integrity: recompute the checksum over the bundle's own payload and compare.
  const treeRoot = join(options.bundleDir, KNOWLEDGE_SUBDIR);
  const tree = await walkTree(treeRoot);
  const dbStateBytes = await readFile(join(options.bundleDir, DB_STATE_FILE));
  const chunksBytes = await readFile(join(options.bundleDir, CHUNKS_FILE));
  const actualChecksum = computeContentChecksum(
    tree,
    sha256Hex(dbStateBytes),
    sha256Hex(chunksBytes)
  );
  if (actualChecksum !== manifest.contentChecksum) {
    throw new Error(
      `bundle content checksum mismatch — expected ${manifest.contentChecksum}, got ${actualChecksum}`
    );
  }

  if (!options.force && (await targetIsNonEmpty(options.knowledgeDir, options.dbPath))) {
    throw new Error(
      "target is not empty (existing knowledge dir or DB) — pass force to overwrite matching docs"
    );
  }

  const state = JSON.parse(dbStateBytes.toString("utf-8")) as BundleDbState;
  const chunkPayload = JSON.parse(chunksBytes.toString("utf-8")) as BundleChunks;

  // 1. Unpack the markdown tree. Matching (project_id, slug) files overwrite;
  //    non-matching target docs are left untouched.
  await copyTree(treeRoot, options.knowledgeDir);

  // 2. Open/create + migrate the target store.
  await mkdir(dirname(options.dbPath), { recursive: true });
  const store = createStore(options.dbPath, { backupBeforeMigrate: true });
  let result: ImportBundleResult;
  try {
    const db = store.db;

    // Newer-than-binary guard AFTER migration: the fresh target is at this
    // binary's latest schema, so a bundle from a higher version can't be safely
    // restored (it may carry columns/tables this build doesn't know).
    const targetSchemaVersion =
      (db.query("SELECT MAX(version) AS v FROM schema_version").get() as {
        v: number | null;
      } | null)?.v ?? 0;
    if (manifest.sourceSchemaVersion > targetSchemaVersion) {
      throw new Error(
        `bundle schema ${manifest.sourceSchemaVersion} is newer than the target's ${targetSchemaVersion} — upgrade the target before importing`
      );
    }

    const knowledgeStore = new KnowledgeStore(db);

    // 3. Restore the embedding fingerprint BEFORE anything else so a later boot
    //    on the same provider recognizes the carried chunks as current and does
    //    not clear them (reindexOnProviderChange).
    if (manifest.embeddingFingerprint !== null) {
      setSetting(db, EMBEDDING_FINGERPRINT_KEY, manifest.embeddingFingerprint);
    }

    // 4. Load docs + drafts from the unpacked markdown WITHOUT embedding. The
    //    loader mints fresh doc ids; upsertDoc writes the row + FTS. No provider
    //    is ever consulted here, so import makes zero embedding calls even when
    //    one would be reachable — the carried chunks are restored below instead.
    const loader = new KnowledgeLoader(options.knowledgeDir);
    const projectIds = existsSync(options.knowledgeDir)
      ? (await readdir(options.knowledgeDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];

    let docs = 0;
    let drafts = 0;
    // Stored doc id per (project_id, slug), from upsertDoc's return — the id the
    // carried chunks below must key on.
    const docIdCache = new Map<string, string | null>();
    const docKey = (projectId: string, slug: string) => `${projectId}\0${slug}`;
    for (const projectId of projectIds) {
      for (const doc of await loader.loadProject(projectId)) {
        docIdCache.set(docKey(projectId, doc.slug), knowledgeStore.upsertDoc(doc));
        docs++;
      }
      for (const draft of await loader.loadDrafts(projectId)) {
        knowledgeStore.upsertDraft(draft);
        drafts++;
      }
    }

    // 5. Restore carried chunks, re-keyed by (project_id, slug) → the freshly
    //    minted doc id. Inserted directly (the FK to knowledge(id) requires the
    //    doc rows above to exist first, which is why chunks are restored AFTER
    //    the load); the vec mirror is built once at the end rather than per-chunk.
    let chunks = 0;
    let skippedChunks = 0;
    const insertChunk = db.prepare(
      `INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json, embedding_blob, chunker_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(knowledge_id, chunk_index) DO UPDATE SET
         text = excluded.text,
         embedding_json = excluded.embedding_json,
         embedding_blob = excluded.embedding_blob,
         chunker_version = excluded.chunker_version`
    );
    // A chunk that carries no version of its own takes the chunker version of
    // the fingerprint the bundle was embedded under; with neither, it is
    // unversioned and the backfill re-chunks it.
    const fingerprintChunker = manifest.embeddingFingerprint?.match(/\|chunker=(\d+)/)?.[1];
    const docIdFor = (projectId: string, slug: string): string | null => {
      const key = docKey(projectId, slug);
      if (!docIdCache.has(key)) {
        docIdCache.set(key, knowledgeStore.getDoc(projectId, slug)?.id ?? null);
      }
      return docIdCache.get(key) ?? null;
    };
    for (const chunk of chunkPayload.chunks) {
      const knowledgeId = docIdFor(chunk.projectId, chunk.slug);
      // A chunk whose doc is gone (slug renamed / file removed since export) has
      // nowhere to land — skip rather than orphan it or trip the FK.
      if (!knowledgeId) {
        skippedChunks++;
        continue;
      }
      insertChunk.run(
        chunk.id,
        knowledgeId,
        chunk.chunkIndex,
        chunk.text,
        JSON.stringify(chunk.embedding),
        embeddingToBlob(chunk.embedding),
        chunk.chunkerVersion ?? (fingerprintChunker !== undefined ? Number(fingerprintChunker) : null)
      );
      chunks++;
    }

    // 6. Replay the §B DB-only rows.
    //    Verdicts are keyed by (project_id, slug) — the store's own writers apply
    //    them onto the loaded rows; a verdict whose doc/draft is absent is a
    //    silent no-op (its slug drifted), which is the correct fail-safe.
    let docVerdicts = 0;
    for (const v of state.docVerdicts) {
      knowledgeStore.setDocVerdict(v.projectId, v.slug, v.verdict, v.disputes);
      docVerdicts++;
    }
    let draftVerdicts = 0;
    for (const v of state.draftVerdicts) {
      knowledgeStore.setDraftVerdict(v.projectId, v.slug, v.verdict, v.disputes);
      draftVerdicts++;
    }

    // The three ledgers are restored with direct inserts (rather than the store's
    // create* helpers) so created_at and stable ids survive verbatim — the
    // retrieval-usage recency and the resolution/change ordering are meaningful
    // signals that would otherwise reset to import time.
    //
    // knowledge_resolutions and knowledge_changes are keyed by a globally-unique
    // TEXT id, so INSERT OR IGNORE on that id makes a forced re-import idempotent.
    // knowledge_retrievals is the exception: its id is a per-DB AUTOINCREMENT
    // integer the export deliberately drops (it is not globally meaningful), and
    // there is no content UNIQUE constraint to dedup on — so a plain replay would
    // re-insert every row on each --force re-import, doubling the usage/recency
    // signal getRetrievalUsage feeds. Instead the carried (doc_project, doc_slug)
    // set is cleared first, then replayed verbatim: created_at survives and the
    // row count is idempotent under repeated force imports. A fresh (unforced)
    // target holds no matching rows, so the delete is a no-op there; on force it
    // replaces a matched doc's retrieval history with the bundle's, matching the
    // "overwrite matching docs" contract force already carries.
    const deleteRetrievalsForDoc = db.prepare(
      `DELETE FROM knowledge_retrievals WHERE doc_project = ? AND doc_slug = ?`
    );
    const clearedRetrievalDocs = new Set<string>();
    for (const r of state.retrievals) {
      const docKey = `${r.docProject} ${r.docSlug}`;
      if (clearedRetrievalDocs.has(docKey)) continue;
      clearedRetrievalDocs.add(docKey);
      deleteRetrievalsForDoc.run(r.docProject, r.docSlug);
    }
    // A row or change a version-1 bundle carried without its placement takes it
    // from the imported doc, so a personal doc's history stays its owner's. When
    // the doc is not in the bundle its placement stays unknown (NULL) rather
    // than guessed, so the readers' own fallbacks (the home-mirror slug rule)
    // still apply.
    const placementOf = (projectId: string, slug: string) =>
      db
        .query("SELECT scope, source_kind, owner_user FROM knowledge WHERE project_id = ? AND slug = ?")
        .get(projectId, slug) as { scope: string | null; source_kind: string | null; owner_user: string | null } | null;
    const derivedPlacement = (projectId: string, slug: string) => {
      const doc = placementOf(projectId, slug);
      if (!doc) return null;
      const layer = layerOf({ scope: doc.scope ?? undefined, sourceKind: doc.source_kind ?? undefined, slug });
      return { doc, layer, owner: layer === "personal" ? doc.owner_user ?? null : null };
    };
    const insertRetrieval = db.prepare(
      `INSERT INTO knowledge_retrievals
         (doc_project, doc_slug, query, rank, score, surface, session_id, query_project, created_at,
          injected, launch_id, components_json, algo_version, raw_score, relevance, layer, source_kind, scope,
          doc_owner, drop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let retrievals = 0;
    for (const r of state.retrievals) {
      const derived = r.layer ? null : derivedPlacement(r.docProject, r.docSlug);
      insertRetrieval.run(
        r.docProject,
        r.docSlug,
        r.query,
        r.rank,
        r.score,
        r.surface,
        r.sessionId,
        r.queryProject,
        r.createdAt,
        r.injected === undefined || r.injected === null ? null : r.injected ? 1 : 0,
        r.launchId ?? null,
        r.components ? JSON.stringify(r.components) : null,
        r.algoVersion ?? null,
        r.rawScore ?? null,
        r.relevance ?? null,
        r.layer ?? derived?.layer ?? null,
        r.sourceKind ?? derived?.doc?.source_kind ?? null,
        r.scope ?? derived?.doc?.scope ?? null,
        r.docOwner ?? derived?.owner ?? null,
        r.dropReason ?? null
      );
      retrievals++;
    }

    const insertResolution = db.prepare(
      `INSERT OR IGNORE INTO knowledge_resolutions
         (id, project_id, winner_slug, loser_slug, type, status, auto_applied, rationale, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let resolutions = 0;
    for (const r of state.resolutions) {
      insertResolution.run(
        r.id,
        r.projectId,
        r.winnerSlug,
        r.loserSlug,
        r.type,
        r.status,
        r.autoApplied ? 1 : 0,
        r.rationale,
        r.detail,
        r.createdAt
      );
      resolutions++;
    }

    const insertChange = db.prepare(
      `INSERT OR IGNORE INTO knowledge_changes
         (id, project_id, slug, kind, title, session_id, contradicted, created_at, personal, owner_user)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let changes = 0;
    for (const c of state.changes) {
      const carried = c.personal !== undefined && c.personal !== null;
      const derived = carried ? null : derivedPlacement(c.projectId, c.slug);
      // Unknown (no flag carried, doc not imported) is stored as NULL.
      const personal = carried ? c.personal === true : derived ? derived.layer === "personal" : null;
      insertChange.run(
        c.id,
        c.projectId,
        c.slug,
        c.kind,
        c.title,
        c.sessionId,
        c.contradicted && c.contradicted.length ? JSON.stringify(c.contradicted) : null,
        c.createdAt,
        personal === null ? null : personal ? 1 : 0,
        personal ? (derived ? derived.owner : c.ownerUser ?? null) : null
      );
      changes++;
    }

    let knowledgeScopes = 0;
    for (const s of state.knowledgeScopes) {
      restoreKnowledgeScope(db, s.projectId, s.scope);
      knowledgeScopes++;
    }

    // 7. Rebuild the vec0 KNN mirror from the carried chunk vectors (no network).
    //    A no-op when sqlite-vec isn't loadable on this connection; search then
    //    runs the brute-force cosine scan over the same restored chunks.
    knowledgeStore.rebuildVecIndex();
    const vecRebuilt = knowledgeStore.vecReady();

    result = {
      manifest,
      docs,
      drafts,
      chunks,
      skippedChunks,
      docVerdicts,
      draftVerdicts,
      retrievals,
      resolutions,
      changes,
      knowledgeScopes,
      vecRebuilt,
    };
  } finally {
    store.close();
  }

  return result;
}
