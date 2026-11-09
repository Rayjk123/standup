import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import {
  VEC_TABLE,
  VEC_OWNER_NONE,
  isVecAvailable,
  embeddingToBlob,
  blobToEmbedding,
  chunkEmbedding,
  chunkEmbeddingWidth,
  buildVecTableDDL,
  vecTableDeclaresPartitionKeys,
} from "./vec.js";
import {
  WRITER_STAMP_COLUMNS,
  stampedWriter,
  writerStampDigest,
  writerStampFor,
  type WriterStampRow,
} from "./writer-stamp.js";
import type {
  KnowledgeDoc,
  KnowledgeChunk,
  KnowledgeDraft,
  KnowledgeEdge,
  KnowledgeHistoryVersion,
  KnowledgeNeighbor,
  OriginClass,
  Scope,
  ScopeAudience,
  SourceKind,
  DraftVerdict,
  Layer,
} from "./types.js";
import {
  layerOf,
  scopeAudienceSql,
  ownerFilterSql,
  partitionSpecsForGate,
  DEFAULT_SCOPE,
  DEFAULT_SOURCE_KIND,
  type VecPartitionSpec,
} from "./types.js";
// Type-only: the runtime edge is graph.ts → store.ts (graph functions take a
// store), so importing this shape back is erased at build time and adds no cycle
// — the same discipline search.ts follows for the reverse direction.
import type { SemanticNeighborIndex } from "./graph.js";
import { chunkMarkdown, CHUNKER_VERSION } from "./embeddings.js";
import { SUPERSEDED_BY_PREFIX, SUPERSEDED_TAG, normalizeInstant, supersededByFromDisputes } from "./temporal.js";
import { redactOptionsFor, redactSecrets, stricterRedactOptions } from "./redact.js";
import { GLOBAL_PROJECT_ID } from "@standup/shared";

// Standalone FTS5 table (not external-content) so upserts are a plain
// delete+insert keyed on the UNINDEXED id column, with no dependency on rowid
// conflict resolution for virtual tables. The slug is indexed so a query naming
// a doc's slug matches it (unicode61 splits it on hyphens), and the porter
// stemmer folds inflections ("reviews" matches "review", "retries" matches "retry").
const FTS_TABLE_DDL = `CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  id UNINDEXED, slug, title, body, tags, tokenize='porter unicode61'
)`;

// Whether an existing knowledge_fts declaration matches FTS_TABLE_DDL's schema:
// a slug column and the porter tokenizer.
function ftsSchemaCurrent(sql: string | null): boolean {
  if (!sql) return false;
  const normalized = sql.toLowerCase();
  return /\bslug\b/.test(normalized) && normalized.includes("porter");
}

// The FTS tags column for the knowledge row named `table`: its tags
// space-joined, the same text upsertDoc writes.
function ftsTagsSql(table: string): string {
  return `COALESCE((SELECT group_concat(value, ' ') FROM json_each(${table}.tags_json)), '')`;
}

// Connections whose derived indexes have already been checked (and repaired if
// needed) this process. KnowledgeStore is constructed per request, so the full
// consistency scan runs once per connection rather than on every search.
const healedConnections = new WeakSet<Database>();

/** Chunk rows converted per transaction by backfillEmbeddingBlobs. */
export const EMBEDDING_BLOB_BACKFILL_BATCH = 500;

/** Consistency counts between the knowledge table and its derived indexes. */
export interface IndexIntegrity {
  docs: number;
  ftsRows: number;
  /** FTS rows whose id matches no doc. */
  orphanFts: number;
  /** Docs with no FTS row. */
  missingFts: number;
  /** Docs with more than one FTS row. */
  duplicateFts: number;
  /** Docs whose FTS row carries a title/body/slug/tags other than the stored ones. */
  staleFts: number;
  chunks: number;
  /** Chunk rows whose doc no longer exists. */
  orphanChunks: number;
  /** Chunk rows at an index past the chunker's count for the doc's current body. */
  tailChunks: number;
  vecRows: number | null;
  /** Chunk rows missing from the vec mirror plus vec rows with no chunk row. */
  vecChunkMismatch: number | null;
}

/** Per-project slice of the corpus counts (the breakdown in KnowledgeStoreStats). */
export interface PerProjectStats {
  projectId: string;
  docs: number;
  chunks: number;
  coveragePct: number;
  edges: number;
}

/**
 * DB-derived corpus counts. The store owns everything derivable from the
 * schema; provider/model are stamped by the caller (see server.ts) since the
 * store can't know the active EmbeddingProvider.
 */
export interface KnowledgeStoreStats {
  docs: number;
  chunks: number;
  embeddedDocs: number;
  /** embeddedDocs / docs as a percentage; 0 on an empty corpus. */
  coveragePct: number;
  edges: number;
  /** edges / docs; 0 on an empty corpus. */
  edgesPerDoc: number;
  /** Dimension of a stored embedding, or null when nothing is embedded. */
  dimensions: number | null;
  originClassBreakdown: Record<string, number>;
  /** Doc counts per source_kind (roadmap r2) — sibling of originClassBreakdown. */
  sourceKindBreakdown: Record<string, number>;
  perProject: PerProjectStats[];
}

/** A node in the cross-project knowledge graph — one doc. */
export interface KnowledgeGraphNode {
  id: string;
  slug: string;
  title: string;
  projectId: string;
  originClass: OriginClass;
  // Re-verification verdict, carried so the graph and its detail rail can flag
  // a contradicted/disputed node the way search flags one. Undefined for a doc
  // that has never been re-verified.
  verdict?: DraftVerdict;
  // Who the doc is for and what kind of source it captures, plus the layer the
  // two place it in (layerOf), so the graph can filter by layer.
  scope: Scope;
  sourceKind: SourceKind;
  layer: Layer;
  // When the indexed row was last written (SQLite datetime, UTC), for sizing
  // or fading nodes by recency.
  updatedAt?: string;
  // Current derived confidence and whether decay has taken the doc below the
  // injection floor with no recovery path. Not set by getGraph; the collector's
  // /api/knowledge/graph route fills them from its freshness gate.
  confidence?: number;
  stale?: boolean;
}

/** A directed edge in the graph, keyed by doc id (source/target). */
export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  kind: KnowledgeEdge["kind"];
  weight: number;
  // The derivation's own signal, carried to the visualization so hovering an
  // edge shows WHY the two docs are linked — the named shared tags, the dispute
  // finding — rather than only its colored kind. Undefined for an edge that
  // recorded none; `confidence` rides along where the edge asserted one.
  evidence?: string;
  confidence?: number;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned 32-bit integer. Not a
 * cryptographic hash — a cheap, value-sensitive fingerprint that changes when
 * any byte of the input does. corpusRevision folds it over each doc's identity
 * (id, slug), its contradiction state (verdict, disputes), and the small text
 * metadata the graph reads (title, tags, related, source_session_id), so a slug
 * rename, a same-length verdict/disputes re-target, or a same-length edit to a
 * doc's tags/related/title/source all move the revision even when every
 * counted/summed column stays byte-identical.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime (16777619) multiply expressed as shifts/adds so it stays
    // within Number's safe integer range before the >>> 0 truncation.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** What the startup check reads of the vec0 mirror and the chunk table (see KnowledgeStore.ensureVecIndex). */
export interface VecMirrorState {
  /** The mirror table exists. */
  exists: boolean;
  /** Its stored CREATE statement. */
  createSql: string | null;
  /** The width of the stored chunk embeddings; null with no chunks. */
  storedDimensions: number | null;
  chunkRows: number;
  chunkRowidSum: number;
  /** Read only from a mirror on the current schema. */
  vecRows?: number;
  vecRowidSum?: number;
  /** knowledge_graph_meta's chunk_generation and vec_generation; equal when omitted. */
  chunkGeneration?: number;
  vecGeneration?: number;
}

/**
 * Why the vec0 mirror must be rebuilt from knowledge_chunks, or null when it
 * serves as it stands: missing while chunks exist, on an older schema (no
 * scope/owner partition keys), at another width than the stored embeddings,
 * holding other rows than knowledge_chunks (count or rowid sum differ), or
 * behind a chunk write made without it (vec_generation short of
 * chunk_generation): upsertChunk keeps a chunk's rowid and clearAllChunks lets
 * rowids be reused, so a mirror can match on count and rowid sum while its
 * vectors or chunk ids are stale. No mirror and no chunks is current: the first
 * chunk write creates it.
 */
export function vecMirrorRebuildReason(state: VecMirrorState): string | null {
  if (!state.exists) return state.chunkRows > 0 ? "the mirror is missing" : null;
  if (!vecTableDeclaresPartitionKeys(state.createSql)) return "the mirror predates the scope/owner partition keys";
  const width = /float\[(\d+)\]/.exec(state.createSql ?? "")?.[1];
  if (state.storedDimensions !== null && width !== undefined && Number(width) !== state.storedDimensions) {
    return `the mirror is ${width} wide, the stored embeddings ${state.storedDimensions}`;
  }
  if (state.vecRows !== state.chunkRows) return `the mirror holds ${state.vecRows ?? "?"} rows for ${state.chunkRows} chunks`;
  if (state.vecRowidSum !== state.chunkRowidSum) return "the mirror's rows are not the chunks' rows";
  if (state.vecGeneration !== state.chunkGeneration) return "chunks were written without the mirror";
  return null;
}

export class KnowledgeStore {
  // Memo of the most recent compileGraph result, keyed by corpusRevision(). The
  // compiled edge set is a pure function of the corpus, so a burst of graph /
  // stats / neighbors reads — each of which recompiles the graph on read — can
  // reuse it until the corpus actually changes, keeping the de-float pass's
  // full chunk-embedding scan + O(F·N) cosine off the request path entirely
  // (see corpusRevision and compileGraph). Null until the first compile; held
  // on the store because the store outlives a request and is the natural
  // per-corpus scope.
  private graphCache: { revision: string; edges: KnowledgeEdge[] } | null = null;

  // Memo of the semantic neighbor index (the doc→doc similarity adjacency the
  // graph-aware retrieval rerank walks), keyed by corpusRevision() exactly like
  // graphCache. The index is a pure function of the corpus's chunk embeddings,
  // so once the graph-rerank arm is enabled a burst of searches reuses one
  // all-pairs cosine build until the corpus changes — keeping that O(N^2)
  // derivation off the per-query path. Null until the first build; only ever
  // populated when the rerank flag is on (its sole caller builds it lazily), so
  // a corpus that never enables the arm pays nothing.
  private semanticIndexCache: { revision: string; index: SemanticNeighborIndex } | null = null;

  // Memo of the most recent checkIndexIntegrity scan, keyed by corpusRevision().
  private integrityCache: { revision: string; integrity: IndexIntegrity } | null = null;

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
        related_json TEXT,
        -- Provenance. Fail-closed: a row of unknown origin is 'untrusted', so
        -- nothing launders into an agent's context by omission. Trusted write
        -- paths stamp a higher class explicitly.
        origin_class TEXT NOT NULL DEFAULT 'untrusted',
        source_session_id TEXT,
        -- Source-kind dimension (roadmap r2), orthogonal to origin_class's
        -- trust. NOT NULL DEFAULT 'unclassified': a row that asserts no kind is
        -- never presumed to be a code fact.
        source_kind TEXT NOT NULL DEFAULT 'unclassified',
        -- Scope + owning user (per-user knowledge). scope answers WHO a doc is
        -- for — 'project' (default, every legacy doc's behavior), 'global'
        -- (promoted to the whole corpus), or 'user' (owned by one user). NOT
        -- NULL DEFAULT 'project' so an unclassified or backfilled row reads
        -- project-scoped, exactly as it behaved before this dimension existed.
        -- owner_user names the owning user of a 'user'-scoped doc; nullable and
        -- NOT hard-FK'd (it keys to a user alias resolved at retrieval time).
        scope TEXT NOT NULL DEFAULT 'project',
        owner_user TEXT,
        -- Confidence bookkeeping (roadmap r2). Nullable: a legacy doc asserts
        -- no opinion, and current confidence is DERIVED from these, never
        -- stored (see confidence.ts).
        confidence REAL,
        last_verified_at TEXT,
        half_life_days REAL,
        -- Re-verification result (roadmap r5). Written by the re-verification
        -- cron (setDocVerdict), never by upsertDoc — so a resync preserves the
        -- flag. Nullable: a doc that has never been re-verified has no verdict.
        verdict TEXT,
        disputes_json TEXT,
        -- Which trusted in-process writer last wrote the row, bound to the
        -- content it wrote (writer-stamp.ts). DB-only: set by stampWriter,
        -- dropped by upsertDoc whenever the content it writes differs.
        writer_stamp TEXT,
        UNIQUE(project_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);

      -- Cross-project knowledge graph. Edges are NOT scoped to a projectId —
      -- spanning projects is the whole point. Rebuildable from markdown +
      -- provenance by the compile pass, so this is an index, never the source
      -- of truth. UNIQUE(src,dst,kind) lets the compiler upsert idempotently.
      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id TEXT PRIMARY KEY,
        src_doc_id TEXT NOT NULL,
        dst_doc_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        weight REAL,
        confidence REAL,
        evidence TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(src_doc_id, dst_doc_id, kind)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_src ON knowledge_edges(src_doc_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_dst ON knowledge_edges(dst_doc_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        -- The vector as JSON, written alongside embedding_blob so a build
        -- that reads only this column still parses it. Readers go through
        -- chunkEmbedding, which prefers the blob.
        embedding_json TEXT NOT NULL,
        -- The CHUNKER_VERSION that produced this chunk's text and embedded
        -- text. NULL on a chunk written before the column existed. A chunk at
        -- another version is stale even when the doc's chunk count still
        -- matches, so the background backfill re-chunks it.
        chunker_version INTEGER,
        -- The vector as little-endian float32 (embeddingToBlob), the same
        -- encoding the vec0 mirror stores: read without a JSON parse.
        embedding_blob BLOB,
        UNIQUE(knowledge_id, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_knowledge ON knowledge_chunks(knowledge_id);

      -- Monotonic generation counter, bumped by every chunk write (upsertChunk /
      -- clearAllChunks). corpusRevision folds it in so a re-embed that leaves the
      -- chunk COUNT and the sampled embedding width byte-identical — a provider
      -- swap to an EQUAL-dimension model rewrites every vector without bumping any
      -- doc's updated_at, its chunk count, or its width — still moves the revision
      -- and invalidates the graph memo. Lives in the shared DB, not memory,
      -- because writes and the graph cache sit on DIFFERENT KnowledgeStore
      -- instances over the same database; an in-memory counter on the writer would
      -- be invisible to the reader's cache. One fixed row (id = 0) holds it.
      CREATE TABLE IF NOT EXISTS knowledge_graph_meta (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        chunk_generation INTEGER NOT NULL DEFAULT 0,
        -- 1 while the stored vectors may belong to another embedding space than
        -- the one queries are embedded in (an embedding change the provider
        -- could not yet re-embed for): vector search is skipped and retrieval
        -- runs on FTS alone until the index is rebuilt or the change reverted.
        vector_search_suspended INTEGER NOT NULL DEFAULT 0,
        -- The chunk_generation the vec0 mirror is known to reflect. A chunk
        -- write that keeps the mirror in step advances it along with
        -- chunk_generation (only while the two are equal); one made without
        -- sqlite-vec advances chunk_generation alone. The two differing means
        -- the mirror may hold stale vectors or chunk ids under rowids that
        -- still match, so ensureVecIndex rebuilds it.
        vec_generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO knowledge_graph_meta (id, chunk_generation) VALUES (0, 0);

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

        -- Source kind + confidence bookkeeping (roadmap r2), stamped at propose
        -- time. Held on the row so a draft edit round-trips them; the accepted
        -- doc gets them from the draft file's frontmatter on accept.
        source_kind TEXT,
        confidence REAL,
        last_verified_at TEXT,
        half_life_days REAL,

        -- Scope + owning user the propose path stamped on the draft (per-user
        -- knowledge). Held on the row — RAW, nullable, no 'project' default,
        -- unlike the accepted knowledge table — so a body edit round-trips the
        -- draft's authored audience instead of dropping it and letting a fresh
        -- accept default the scopeless file to 'project'. Carried into the
        -- accepted doc from the draft file's frontmatter on accept.
        scope TEXT,
        owner_user TEXT,

        reviewed_at TEXT,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(project_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_drafts_project
        ON knowledge_drafts(project_id);

      -- Contradiction-judge outcomes. One row per judged pair (subject, candidate):
      -- 'contradicts', 'supersedes', 'complementary' or 'consistent' when the judge
      -- answered, 'judge_error' when it could not (a failed spawn, an auth error, a
      -- timeout, an unreadable reply) — never read as "no contradiction" — and
      -- 'queued' for a doc whose verdict must be re-judged (candidate_slug NULL).
      -- Rewritten in place per pair, so the table holds each pair's latest outcome.
      CREATE TABLE IF NOT EXISTS knowledge_judgments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        subject_slug TEXT NOT NULL,
        candidate_project_id TEXT,
        candidate_slug TEXT,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('contradicts', 'supersedes', 'complementary', 'consistent', 'judge_error', 'queued')),
        method TEXT,
        reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        judged_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_judgments_subject
        ON knowledge_judgments(project_id, subject_slug);

      -- The publish fact-check of an agent doc published unverified: how many
      -- attempts the doc's CURRENT body (body_hash) has had, the checkout it
      -- was written against, and the last outcome. Reset when the body changes;
      -- removed with the doc.
      CREATE TABLE IF NOT EXISTS knowledge_verifications (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        repo_path TEXT,
        last_outcome TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Exported/top-level symbols and file paths of a project's repo at one
      -- commit, so "where is X defined" is answerable by name lookup instead of
      -- a full-text scan of the tree. Keyed by the sha the row was extracted at:
      -- an incremental re-index stamps the new HEAD on the files that changed
      -- and leaves the rest, so a row's sha is the last commit at which its file
      -- was read, not necessarily the indexed HEAD (the indexer tracks that
      -- separately). Derived data, rebuilt from git at any time — never a
      -- knowledge source, so it carries no scope, confidence or provenance.
      CREATE TABLE IF NOT EXISTS code_symbols (
        project_id TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        sha TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file
        ON code_symbols(project_id, repo_path, file);

      -- Doc→code mentions: the files and symbols a doc names that resolved
      -- against code_symbols (see code-mentions.ts). mention is the name as
      -- written, target the indexed file path or symbol name it resolved to,
      -- file/line where, and name_key the code_symbols.name the existence
      -- check looks up (a file's basename, a symbol's name). Derived
      -- from doc bodies + the code index; rebuilt at any time.
      CREATE TABLE IF NOT EXISTS knowledge_code_mentions (
        doc_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        mention TEXT NOT NULL,
        target TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER,
        name_key TEXT NOT NULL,
        PRIMARY KEY (doc_id, kind, mention)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_code_mentions_file
        ON knowledge_code_mentions(project_id, file);

      -- What each doc's mentions were last extracted from: its content hash
      -- and the code index revision, so a refresh re-reads only what changed.
      CREATE TABLE IF NOT EXISTS knowledge_code_mention_state (
        doc_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL
      );
    `);

    this.ensureColumns();
    this.ensureTemporal();
    this.ensureFtsTable();
    if (!healedConnections.has(this.db)) {
      // Marked healed only once the repair has gone through, so a heal that
      // throws (a busy database) is retried by the next construction instead of
      // leaving the connection unrepaired for the rest of the process.
      try {
        this.healIndex();
        healedConnections.add(this.db);
      } catch (err) {
        console.error("[knowledge] index self-heal failed; retrying on the next store:", err);
      }
    }
  }

  // Creates the FTS table on the current schema, or replaces one created under
  // an older schema (no slug column, no stemming tokenizer) and repopulates it
  // from the knowledge table. FTS is a pure index over knowledge rows, so the
  // drop-and-rebuild loses nothing and re-running it is a no-op.
  private ensureFtsTable(): void {
    const row = this.db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_fts'")
      .get() as { sql: string | null } | null;
    if (row && ftsSchemaCurrent(row.sql)) return;
    this.db.transaction(() => {
      if (row) this.db.exec("DROP TABLE knowledge_fts");
      this.db.exec(FTS_TABLE_DDL);
      this.populateFts();
    })();
  }

  private populateFts(): void {
    this.db.run(
      `INSERT INTO knowledge_fts (id, slug, title, body, tags)
       SELECT id, slug, title, body, ${ftsTagsSql("knowledge")}
       FROM knowledge`
    );
  }

  /**
   * Rebuilds the FTS index from the knowledge table: one row per doc, keyed by
   * the doc's stored id, carrying its current title/slug/body/tags.
   */
  rebuildFts(): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM knowledge_fts");
      this.populateFts();
    })();
  }

  // Repairs the derived indexes when they disagree with the knowledge table:
  // FTS rows under ids no doc carries, docs with zero or several FTS rows, or
  // FTS text that differs from the stored doc trigger a full FTS rebuild, and
  // chunk rows (plus their vec rows) whose doc no longer exists are dropped.
  // Runs once per connection, at the first KnowledgeStore construction, since
  // the write paths keep the indexes consistent from then on.
  private healIndex(): void {
    const fts = this.ftsIntegrity();
    if (fts.orphanFts + fts.missingFts + fts.duplicateFts + fts.staleFts > 0) {
      this.rebuildFts();
    }
    this.deleteOrphanChunks();
  }

  private ftsIntegrity(): {
    ftsRows: number;
    orphanFts: number;
    missingFts: number;
    duplicateFts: number;
    staleFts: number;
  } {
    const n = (sql: string): number => (this.db.query(sql).get() as { n: number }).n;
    return {
      ftsRows: n("SELECT COUNT(*) AS n FROM knowledge_fts"),
      orphanFts: n(
        "SELECT COUNT(*) AS n FROM knowledge_fts WHERE id NOT IN (SELECT id FROM knowledge)"
      ),
      missingFts: n(
        "SELECT COUNT(*) AS n FROM knowledge WHERE id NOT IN (SELECT id FROM knowledge_fts)"
      ),
      duplicateFts: n(
        `SELECT COUNT(*) AS n FROM (
           SELECT id FROM knowledge_fts GROUP BY id HAVING COUNT(*) > 1)`
      ),
      staleFts: n(
        `SELECT COUNT(DISTINCT k.id) AS n FROM knowledge k
         JOIN knowledge_fts f ON f.id = k.id
         WHERE f.title IS NOT k.title OR f.body IS NOT k.body OR f.slug IS NOT k.slug
            OR f.tags IS NOT ${ftsTagsSql("k")}`
      ),
    };
  }

  // Chunk rows whose doc is gone. The ON DELETE CASCADE on knowledge_chunks only
  // fires on connections with foreign_keys enabled, so a doc deleted elsewhere
  // can leave its chunks behind; they never join back to a doc, so they are dead
  // weight in the vec mirror and skew nothing but the counts.
  private deleteOrphanChunks(): number {
    const orphanWhere = "knowledge_id NOT IN (SELECT id FROM knowledge)";
    const n = (
      this.db.query(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE ${orphanWhere}`).get() as {
        n: number;
      }
    ).n;
    if (n === 0) return 0;
    this.db.transaction(() => {
      if (isVecAvailable(this.db) && this.vecTableExists()) {
        this.db.run(
          `DELETE FROM ${VEC_TABLE}
           WHERE rowid IN (SELECT rowid FROM knowledge_chunks WHERE ${orphanWhere})`
        );
      }
      this.db.run(`DELETE FROM knowledge_chunks WHERE ${orphanWhere}`);
    })();
    this.bumpChunkGeneration(isVecAvailable(this.db));
    return n;
  }

  /**
   * Consistency counts between the knowledge table and its derived indexes —
   * the FTS mirror, the chunk table (against the production chunker's expected
   * count per current body), and the vec mirror. Every count except `docs`,
   * `ftsRows`, `chunks` and `vecRows` is a defect count that is 0 on a healthy
   * index. `vecRows`/`vecChunkMismatch` are null when the vec mirror is absent.
   */
  checkIndexIntegrity(options: { fresh?: boolean } = {}): IndexIntegrity {
    // The scan re-chunks every doc, so a result is reused until the corpus
    // revision moves; `fresh` forces a rescan (drift written around the store's
    // write paths does not move the revision).
    const revision = this.corpusRevision();
    if (!options.fresh && this.integrityCache?.revision === revision) {
      return this.integrityCache.integrity;
    }
    const integrity = this.scanIndexIntegrity();
    this.integrityCache = { revision, integrity };
    return integrity;
  }

  private scanIndexIntegrity(): IndexIntegrity {
    const n = (sql: string): number => (this.db.query(sql).get() as { n: number }).n;
    const fts = this.ftsIntegrity();

    const docs = this.db
      .query("SELECT id, title, body FROM knowledge")
      .all() as Array<{ id: string; title: string; body: string }>;
    const tailStmt = this.db.query(
      "SELECT COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_id = ? AND chunk_index >= ?"
    );
    let tailChunks = 0;
    for (const d of docs) {
      const expected = chunkMarkdown(d.title, d.body).length;
      tailChunks += (tailStmt.get(d.id, expected) as { n: number }).n;
    }

    const vec = isVecAvailable(this.db) && this.vecTableExists();
    return {
      docs: docs.length,
      ...fts,
      chunks: n("SELECT COUNT(*) AS n FROM knowledge_chunks"),
      orphanChunks: n(
        "SELECT COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_id NOT IN (SELECT id FROM knowledge)"
      ),
      tailChunks,
      vecRows: vec ? n(`SELECT COUNT(*) AS n FROM ${VEC_TABLE}`) : null,
      vecChunkMismatch: vec
        ? n(
            `SELECT COUNT(*) AS n FROM knowledge_chunks
             WHERE rowid NOT IN (SELECT rowid FROM ${VEC_TABLE})`
          ) +
          n(
            `SELECT COUNT(*) AS n FROM ${VEC_TABLE}
             WHERE rowid NOT IN (SELECT rowid FROM knowledge_chunks)`
          )
        : null,
    };
  }

  // CREATE TABLE IF NOT EXISTS silently does nothing when the table is
  // already there, so a database that predates generated_from_sha/
  // generated_at needs those columns added explicitly. PRAGMA-checked
  // because SQLite has no ADD COLUMN IF NOT EXISTS. Idempotent, so it's safe
  // to run unconditionally on every startup, fresh database or not.
  private ensureColumns(): void {
    const columnsOf = (table: string) =>
      new Set(
        (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((c) => c.name)
      );

    const knowledge = columnsOf("knowledge");
    for (const col of [
      "generated_from_sha",
      "generated_at",
      "related_json",
      "source_session_id",
      "last_verified_at",
    ]) {
      if (!knowledge.has(col)) {
        this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} TEXT`);
      }
    }
    for (const col of ["confidence", "half_life_days"]) {
      if (!knowledge.has(col)) {
        this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} REAL`);
      }
    }
    // Re-verification result (roadmap r5), mirroring the draft verdict columns.
    // Nullable — a doc that predates re-verification simply has no verdict; the
    // re-verification cron is the only writer.
    if (!knowledge.has("verdict")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN verdict TEXT");
    }
    // The content clock (confidence.ts withConfidenceDefaults): a hash of the
    // body and when the index first saw that body. A rewrite that keeps the body
    // (a frontmatter edit, a copy, a restore) leaves the clock alone. A row that
    // predates the columns starts its clock at its generated_at, else its file
    // time — the best date it has.
    if (!knowledge.has("content_hash")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN content_hash TEXT");
    }
    if (!knowledge.has("content_first_seen")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN content_first_seen TEXT");
      this.db.exec("UPDATE knowledge SET content_first_seen = COALESCE(generated_at, updated_at)");
    }
    if (!knowledge.has("disputes_json")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN disputes_json TEXT");
    }
    // The checkout the current verdict was produced against (setDocVerdict);
    // the store's migration 060 adds it to a table that already exists.
    if (!knowledge.has("verdict_repo_path")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN verdict_repo_path TEXT");
    }
    // Nullable and never backfilled: a row written before writer stamps
    // existed has no trusted writer on record.
    if (!knowledge.has("writer_stamp")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN writer_stamp TEXT");
    }
    // source_kind carries NOT NULL DEFAULT 'unclassified' — the ALTER's default
    // backfills every pre-existing row to the kind an unasserted file loads as,
    // and the sync's file-column reconcile then sets each row from its file.
    if (!knowledge.has("source_kind")) {
      this.db.exec(
        "ALTER TABLE knowledge ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'unclassified'"
      );
    }
    // scope carries NOT NULL DEFAULT 'project' — the ALTER's default backfills
    // every pre-existing row to 'project', which is correct for an ordinary
    // project: a doc belonged to its project before this dimension existed, so
    // its behavior is unchanged. The one place that constant default is WRONG is
    // the reserved GLOBAL corpus: docs homed there (project_id = GLOBAL_PROJECT_ID)
    // exist to reach every session, so they must read scope='global'. The loader
    // now infers that on load, but the mtime-skip resync never re-stamps an
    // unchanged file, so the freshly-backfilled 'project' would silently drop the
    // whole global KB from the strict scope gate. Backfill those rows to 'global'
    // to match the loader — the origin_class pattern, not the pure source_kind one.
    // (Fresh installs never reach here — CREATE TABLE already governs the column.)
    if (!knowledge.has("scope")) {
      this.db.exec(
        "ALTER TABLE knowledge ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'"
      );
      this.db.run("UPDATE knowledge SET scope = 'global' WHERE project_id = ?", [
        GLOBAL_PROJECT_ID,
      ]);
    }
    // owner_user is nullable — a doc has no owning user unless it is
    // 'user'-scoped, and it is NOT hard-FK'd (it keys to a user alias resolved
    // at retrieval time). A backfilled row keeps NULL.
    if (!knowledge.has("owner_user")) {
      this.db.exec("ALTER TABLE knowledge ADD COLUMN owner_user TEXT");
    }
    // origin_class carries a NOT NULL DEFAULT so a row of unknown provenance
    // reads 'untrusted' rather than NULL — fail-closed for any future
    // programmatic upsert that goes around the loader. The backfill of
    // pre-existing rows is the one place that default is wrong, though: every
    // row that exists the instant this column is first added predates
    // provenance and was loaded from the user's own knowledge directory, which
    // is inside the trust boundary — the loader stamps such an unasserted doc
    // 'owner' for exactly this reason. Leaving the ALTER's fail-closed
    // 'untrusted' backfill in place would drop all pre-existing human-authored
    // docs out of ask_expert's auto-injection gate on upgrade, and the
    // mtime-skip resync never re-stamps an unchanged file, so grounding would
    // silently vanish. Backfill those legacy rows to 'owner' to match the
    // loader. (Fresh installs never reach here — CREATE TABLE already defines
    // the column, so the fail-closed default governs every new row.)
    if (!knowledge.has("origin_class")) {
      this.db.exec(
        "ALTER TABLE knowledge ADD COLUMN origin_class TEXT NOT NULL DEFAULT 'untrusted'"
      );
      this.db.exec("UPDATE knowledge SET origin_class = 'owner'");
    }

    if (!columnsOf("knowledge_chunks").has("chunker_version")) {
      this.db.exec("ALTER TABLE knowledge_chunks ADD COLUMN chunker_version INTEGER");
    }
    // Rows that predate the column keep their JSON vector, which every reader
    // falls back to, until the conversion below (resumed at boot by
    // backfillEmbeddingBlobs if interrupted) rewrites them as blobs.
    if (!columnsOf("knowledge_chunks").has("embedding_blob")) {
      this.db.exec("ALTER TABLE knowledge_chunks ADD COLUMN embedding_blob BLOB");
      this.backfillEmbeddingBlobs();
    }
    if (!columnsOf("knowledge_graph_meta").has("vector_search_suspended")) {
      this.db.exec(
        "ALTER TABLE knowledge_graph_meta ADD COLUMN vector_search_suspended INTEGER NOT NULL DEFAULT 0"
      );
    }
    // Added at 0 while chunk_generation may already be past it: a mirror whose
    // writes were never tracked is rebuilt once at the next ensureVecIndex.
    if (!columnsOf("knowledge_graph_meta").has("vec_generation")) {
      this.db.exec("ALTER TABLE knowledge_graph_meta ADD COLUMN vec_generation INTEGER NOT NULL DEFAULT 0");
    }

    // Adversarial verification results. `verdict` defaults to 'unverified'
    // rather than 'clean' so an unchecked draft is never mistaken for a
    // checked one — the two look identical in review otherwise, and the
    // whole value of the pass is knowing which it is.
    const drafts = columnsOf("knowledge_drafts");
    if (!drafts.has("verdict")) {
      this.db.exec(
        "ALTER TABLE knowledge_drafts ADD COLUMN verdict TEXT NOT NULL DEFAULT 'unverified'"
      );
    }
    if (!drafts.has("disputes_json")) {
      this.db.exec("ALTER TABLE knowledge_drafts ADD COLUMN disputes_json TEXT");
    }
    // Source kind + confidence bookkeeping (roadmap r2). All nullable — a draft
    // that asserts no opinion keeps NULL, and the accepted doc picks them up
    // from the draft file's frontmatter on accept regardless.
    if (!drafts.has("source_kind")) {
      this.db.exec("ALTER TABLE knowledge_drafts ADD COLUMN source_kind TEXT");
    }
    if (!drafts.has("last_verified_at")) {
      this.db.exec("ALTER TABLE knowledge_drafts ADD COLUMN last_verified_at TEXT");
    }
    for (const col of ["confidence", "half_life_days"]) {
      if (!drafts.has(col)) {
        this.db.exec(`ALTER TABLE knowledge_drafts ADD COLUMN ${col} REAL`);
      }
    }
    // Scope + owning user (per-user knowledge). Nullable and NO 'project'
    // default — unlike the accepted `knowledge` table, a draft round-trips its
    // scope RAW so a body edit preserves the authored audience rather than
    // dropping it; a draft that asserts none keeps NULL and the accepted doc
    // picks the scope up from the draft frontmatter (or the loader default) on
    // accept.
    for (const col of ["scope", "owner_user"]) {
      if (!drafts.has(col)) {
        this.db.exec(`ALTER TABLE knowledge_drafts ADD COLUMN ${col} TEXT`);
      }
    }
    // One user's personal layer (scope='user' AND owner_user = ?), which the
    // Persona owner profile reads every turn. Created here, after the ALTERs
    // above, because an older table gains owner_user only there.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_knowledge_scope_owner ON knowledge(scope, owner_user)"
    );
  }

  // Validity intervals (temporal.ts): the knowledge row's valid_from / valid_to
  // / superseded_by, the triggers that close and reopen a row with its
  // "superseded" verdict, and the history index of closed versions.
  private ensureTemporal(): void {
    const knowledge = new Set(
      (this.db.query("PRAGMA table_info(knowledge)").all() as Array<{ name: string }>).map((c) => c.name)
    );
    const added = !knowledge.has("valid_to");
    for (const col of ["valid_from", "valid_to", "superseded_by"]) {
      if (!knowledge.has(col)) this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col} TEXT`);
    }
    if (added) this.backfillValidity();

    // A verdict turning "superseded" closes the row at that moment and names the
    // winner its tombstone dispute names. Every supersede writer (the
    // contradiction resolver, the coherence pass, the mirror collapse, a
    // retired Persona memory) sets that verdict, so the close needs no call of
    // its own; a valid_to the file already declares is kept.
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS knowledge_supersede_validity
      AFTER UPDATE OF verdict ON knowledge
      WHEN NEW.verdict = 'superseded' AND OLD.verdict IS NOT 'superseded'
      BEGIN
        UPDATE knowledge SET
          valid_to = COALESCE(NEW.valid_to, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          superseded_by = COALESCE(
            (SELECT CASE WHEN instr(ref, '/') > 0 THEN ref ELSE NEW.project_id || '/' || ref END
             FROM (SELECT trim(substr(json_extract(j.value, '$.claim'), ${SUPERSEDED_BY_PREFIX.length + 1})) AS ref
                   FROM json_each(CASE WHEN json_valid(NEW.disputes_json) THEN NEW.disputes_json ELSE '[]' END) j
                   WHERE json_type(j.value, '$.claim') = 'text'
                     AND substr(json_extract(j.value, '$.claim'), 1, ${SUPERSEDED_BY_PREFIX.length}) = '${SUPERSEDED_BY_PREFIX}'
                   LIMIT 1)
             WHERE ref != ''),
            NEW.superseded_by)
        WHERE id = NEW.id;
      END;

      -- Reviving a superseded doc (its verdict cleared or replaced) reopens it,
      -- unless it is still tagged superseded.
      CREATE TRIGGER IF NOT EXISTS knowledge_revive_validity
      AFTER UPDATE OF verdict ON knowledge
      WHEN OLD.verdict = 'superseded' AND NEW.verdict IS NOT 'superseded'
      BEGIN
        UPDATE knowledge SET valid_to = NULL, superseded_by = NULL
        WHERE id = NEW.id AND COALESCE(NEW.tags_json, '') NOT LIKE '%"${SUPERSEDED_TAG}"%';
      END;

      -- Closed versions kept under <project>/.history/ (archiveDocVersion). Its
      -- own table and FTS index, with no chunks and no path from any corpus
      -- query, so a closed version reaches only an asOf search.
      CREATE TABLE IF NOT EXISTS knowledge_history (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT,
        file_path TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT NOT NULL,
        superseded_by TEXT,
        origin_class TEXT NOT NULL DEFAULT 'untrusted',
        source_kind TEXT NOT NULL DEFAULT 'unclassified',
        scope TEXT NOT NULL DEFAULT 'project',
        owner_user TEXT,
        generated_from_sha TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_history_slug ON knowledge_history(project_id, slug);
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_history_fts USING fts5(
        id UNINDEXED, slug, title, body, tags, tokenize='porter unicode61'
      );
    `);
  }

  // The one-time fill of the validity columns on a table that predates them:
  // valid_from from the doc's generated_at, else the time the index first saw
  // its body, else its file time; a superseded doc (verdict or tag) closed now,
  // the earliest instant known to postdate its supersede, and superseded_by
  // read off its tombstone.
  private backfillValidity(): void {
    const rows = this.db
      .query(
        "SELECT id, project_id, generated_at, content_first_seen, updated_at, verdict, disputes_json, tags_json FROM knowledge"
      )
      .all() as Array<{
      id: string;
      project_id: string;
      generated_at: string | null;
      content_first_seen: string | null;
      updated_at: string | null;
      verdict: string | null;
      disputes_json: string | null;
      tags_json: string | null;
    }>;
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    const update = this.db.prepare(
      "UPDATE knowledge SET valid_from = ?, valid_to = ?, superseded_by = ? WHERE id = ?"
    );
    this.db.transaction(() => {
      for (const row of rows) {
        const validFrom =
          normalizeInstant(row.generated_at) ??
          normalizeInstant(row.content_first_seen) ??
          normalizeInstant(row.updated_at) ??
          null;
        const superseded = row.verdict === "superseded" || parsedTags(row.tags_json).includes(SUPERSEDED_TAG);
        const supersededBy = superseded
          ? supersededByFromDisputes(row.project_id, parsedDisputes(row.disputes_json)) ?? null
          : null;
        update.run(validFrom, superseded ? now : null, supersededBy, row.id);
      }
    })();
  }

  /**
   * Writes a just-upserted doc's validity columns from its file. valid_from is
   * the file's, else the one already stored, else (the first index) the doc's
   * generated_at or its file time — a file existed at least since it was last
   * written, which a rebuilt index would otherwise date to the rebuild.
   * valid_to / superseded_by follow the file, except
   * that a doc held superseded (by its verdict or its tag) keeps the close it
   * already has when the file declares none — the verdict lives in the
   * database, not the file, and an unrelated frontmatter write must not reopen
   * it.
   */
  private applyFileValidity(id: string, doc: KnowledgeDoc): void {
    const tagged = (doc.tags ?? []).includes(SUPERSEDED_TAG) ? 1 : 0;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE knowledge SET
         valid_from = COALESCE(?, valid_from, ?),
         valid_to = CASE WHEN verdict = 'superseded' OR ? = 1 THEN COALESCE(?, valid_to, ?) ELSE ? END,
         superseded_by = CASE WHEN verdict = 'superseded' OR ? = 1 THEN COALESCE(?, superseded_by) ELSE ? END
       WHERE id = ?`,
      [
        normalizeInstant(doc.validFrom) ?? null,
        normalizeInstant(doc.generatedAt) ?? doc.updatedAt.toISOString(),
        tagged,
        normalizeInstant(doc.validTo) ?? null,
        now,
        normalizeInstant(doc.validTo) ?? null,
        tagged,
        doc.supersededBy ?? null,
        doc.supersededBy ?? null,
        id,
      ]
    );
  }

  /**
   * Makes the history index of one project match its `.history/` files:
   * versions whose file is new or changed are (re)written, rows whose file is
   * gone are dropped. Unchanged files cost one read of the stored paths. A
   * version's title and body are indexed redacted under the stricter of its
   * own placement and the current doc's (redactOptionsFor), so a history file
   * written unredacted or under a narrower placement never reaches the index
   * carrying what the doc itself would not.
   */
  syncHistory(projectId: string, versions: readonly KnowledgeHistoryVersion[]): void {
    const stored = new Map(
      (
        this.db
          .query("SELECT id, file_path, updated_at FROM knowledge_history WHERE project_id = ?")
          .all(projectId) as Array<{ id: string; file_path: string; updated_at: string }>
      ).map((r) => [r.file_path, r] as const)
    );
    const seen = new Set<string>();
    const changed = versions.filter((v) => {
      seen.add(v.filePath);
      const row = stored.get(v.filePath);
      return !row || row.updated_at !== v.updatedAt.toISOString();
    });
    const gone = [...stored.values()].filter((r) => !seen.has(r.file_path));
    if (changed.length === 0 && gone.length === 0) return;
    const currentPlacement = this.db.prepare(
      "SELECT scope, source_kind FROM knowledge WHERE project_id = ? AND slug = ?"
    );
    this.db.transaction(() => {
      for (const row of gone) {
        this.db.run("DELETE FROM knowledge_history WHERE id = ?", [row.id]);
        this.db.run("DELETE FROM knowledge_history_fts WHERE id = ?", [row.id]);
      }
      for (const version of changed) {
        const current = currentPlacement.get(projectId, version.slug) as {
          scope: string | null;
          source_kind: string | null;
        } | null;
        let opts = redactOptionsFor({
          projectId,
          slug: version.slug,
          scope: version.scope,
          sourceKind: version.sourceKind,
        });
        if (current) {
          opts = stricterRedactOptions(
            opts,
            redactOptionsFor({
              projectId,
              slug: version.slug,
              scope: current.scope ?? undefined,
              sourceKind: current.source_kind ?? undefined,
            })
          );
        }
        const v = { ...version, title: redactSecrets(version.title, opts), body: redactSecrets(version.body, opts) };
        const id = stored.get(v.filePath)?.id ?? v.id;
        this.db.run(
          `INSERT INTO knowledge_history (id, project_id, slug, title, body, tags_json, file_path, updated_at,
             valid_from, valid_to, superseded_by, origin_class, source_kind, scope, owner_user, generated_from_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET
             slug = excluded.slug, title = excluded.title, body = excluded.body, tags_json = excluded.tags_json,
             updated_at = excluded.updated_at, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
             superseded_by = excluded.superseded_by, origin_class = excluded.origin_class,
             source_kind = excluded.source_kind, scope = excluded.scope, owner_user = excluded.owner_user,
             generated_from_sha = excluded.generated_from_sha`,
          [
            id,
            projectId,
            v.slug,
            v.title,
            v.body,
            v.tags ? JSON.stringify(v.tags) : null,
            v.filePath,
            v.updatedAt.toISOString(),
            v.validFrom ?? null,
            v.validTo,
            v.supersededBy ?? null,
            v.originClass,
            v.sourceKind,
            v.scope,
            v.ownerUser ?? null,
            v.generatedFromSha ?? null,
          ]
        );
        this.db.run("DELETE FROM knowledge_history_fts WHERE id = ?", [id]);
        this.db.run("INSERT INTO knowledge_history_fts (id, slug, title, body, tags) VALUES (?, ?, ?, ?, ?)", [
          id,
          v.slug,
          v.title,
          v.body,
          v.tags?.join(" ") ?? "",
        ]);
      }
    })();
  }

  /** The closed versions of one doc, oldest first. */
  getHistory(projectId: string, slug: string): KnowledgeHistoryVersion[] {
    const rows = this.db
      .query(
        "SELECT * FROM knowledge_history WHERE project_id = ? AND slug = ? ORDER BY COALESCE(valid_from, ''), valid_to"
      )
      .all(projectId, slug) as HistoryRow[];
    return rows.map(rowToHistory);
  }

  /**
   * Records a re-verification pass over an ACCEPTED doc (roadmap r5). The
   * sibling of setDraftVerdict for the accepted-doc table: the verdict lives in
   * the DB, not the markdown file, and upsertDoc omits these columns so a
   * resync of the (unchanged-body) file preserves the flag rather than clearing
   * it. Confidence + last_verified_at ARE written to the file frontmatter by
   * the cron (they drive decay and must survive a DB rebuild); the verdict and
   * its disputes are ephemeral verification state, so they stay DB-only.
   *
   * `repoPath` is the checkout a fact-check verdict was produced against,
   * recorded as verdict_repo_path. Omitted, the recorded path is kept (a
   * contradiction folded onto a fact-check verdict); null clears it.
   */
  setDocVerdict(
    projectId: string,
    slug: string,
    verdict: string,
    disputes: unknown[],
    repoPath?: string | null
  ): void {
    if (repoPath === undefined) {
      this.db.run(
        `UPDATE knowledge SET verdict = ?, disputes_json = ?
         WHERE project_id = ? AND slug = ?`,
        [verdict, JSON.stringify(disputes), projectId, slug]
      );
      return;
    }
    this.db.run(
      `UPDATE knowledge SET verdict = ?, disputes_json = ?, verdict_repo_path = ?
       WHERE project_id = ? AND slug = ?`,
      [verdict, JSON.stringify(disputes), repoPath, projectId, slug]
    );
  }

  /** The checkout the doc's current verdict was produced against, if recorded. */
  getDocVerdictRepo(projectId: string, slug: string): string | null {
    const row = this.db
      .query("SELECT verdict_repo_path FROM knowledge WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as { verdict_repo_path: string | null } | null;
    return row?.verdict_repo_path ?? null;
  }

  /**
   * Clears any re-verification verdict + disputes on an accepted doc (roadmap r5
   * review), returning the row to its never-re-verified state (verdict NULL). A
   * human accepting or editing a doc is asserting its current body; a verdict the
   * cron recorded against a PRIOR body must not keep marking the new text
   * disputed. Called after the write's resync — upsertDoc omits these columns, so
   * without this the stale verdict would survive every future resync and, for a
   * doc the accept dropped below the cron's candidate filter (no provenance),
   * could never be reset by a clean pass either. The cron re-checks the doc later
   * and sets a fresh verdict if it still has provenance.
   */
  clearDocVerdict(projectId: string, slug: string): void {
    this.db.run(
      `UPDATE knowledge SET verdict = NULL, disputes_json = NULL, verdict_repo_path = NULL
       WHERE project_id = ? AND slug = ?`,
      [projectId, slug]
    );
  }

  /** Records an adversarial verification pass over a draft. */
  setDraftVerdict(
    projectId: string,
    slug: string,
    verdict: string,
    disputes: unknown[]
  ): void {
    this.db.run(
      `UPDATE knowledge_drafts SET verdict = ?, disputes_json = ?
       WHERE project_id = ? AND slug = ?`,
      [verdict, JSON.stringify(disputes), projectId, slug]
    );
  }

  /**
   * Reconciles a doc's FILE-AUTHORITATIVE columns (origin_class, source_kind,
   * scope, owner_user) against what the loader now derives from the file, WITHOUT
   * rewriting the body or re-embedding. syncProject skips a full upsert when a
   * file's mtime hasn't advanced, so a row first written under an older default
   * — e.g. before the loader defaulted an unasserted origin_class to `owner`, or
   * before it inferred scope='global' for the reserved GLOBAL corpus — keeps its
   * stale value forever on an unedited file: a genuinely trusted hand-authored
   * doc stays wrongly gated out of auto-injection, and a global best-practice doc
   * stamped scope='project' silently falls out of the strict scope gate (its
   * project_id isn't the asking project, and it isn't 'global').
   *
   * Safe on the mtime-skip path because these columns reach the DB ONLY from the
   * file (upsertDoc) or the one-time backfill migration — never mutated at runtime
   * independent of the file, unlike verdict/disputes (DB-only, cron-owned) or
   * confidence/last_verified_at (which the re-verify cron edits IN the file, so
   * they ride a normal mtime-bumped resync). The file is thus the sole source of
   * truth here: reconciling toward it can only correct drift, never clobber
   * runtime state, and it honors an explicit `origin_class:`/`source_kind:`/
   * `scope:`/`owner_user:` in frontmatter both ways (the loader already resolved
   * those). None of these columns is FTS-indexed, so no FTS rewrite is needed.
   */
  reconcileFileColumns(
    projectId: string,
    slug: string,
    originClass: OriginClass,
    sourceKind: SourceKind,
    scope: Scope,
    ownerUser: string | undefined
  ): void {
    this.db.run(
      `UPDATE knowledge SET origin_class = ?, source_kind = ?, scope = ?, owner_user = ?
       WHERE project_id = ? AND slug = ?`,
      [originClass, sourceKind, scope, ownerUser ?? null, projectId, slug]
    );
    this.dropStaleWriterStamp(projectId, slug);
    this.refreshDocVectors(projectId, slug);
  }

  /**
   * Records that `writer` wrote the doc as it now stands (writer-stamp.ts).
   * Only a caller that has itself established who is writing may call this,
   * right after its own write is synced; returns false when there is no such
   * doc.
   */
  stampWriter(projectId: string, slug: string, writer: string): boolean {
    const row = this.db
      .query(`SELECT ${WRITER_STAMP_COLUMNS} FROM knowledge WHERE project_id = ? AND slug = ?`)
      .get(projectId, slug) as (WriterStampRow & { writer_stamp: string | null }) | null;
    if (!row) return false;
    this.db.run("UPDATE knowledge SET writer_stamp = ? WHERE project_id = ? AND slug = ?", [
      writerStampFor(writer, row),
      projectId,
      slug,
    ]);
    return true;
  }

  /** The writer that wrote the doc as it now stands, or null (see stampedWriter). */
  writerOf(projectId: string, slug: string): string | null {
    const row = this.db
      .query(`SELECT ${WRITER_STAMP_COLUMNS} FROM knowledge WHERE project_id = ? AND slug = ?`)
      .get(projectId, slug) as (WriterStampRow & { writer_stamp: string | null }) | null;
    return row ? stampedWriter(row) : null;
  }

  /** Clears the doc's writer stamp when its content no longer matches it. */
  private dropStaleWriterStamp(projectId: string, slug: string): void {
    const row = this.db
      .query(`SELECT ${WRITER_STAMP_COLUMNS} FROM knowledge WHERE project_id = ? AND slug = ?`)
      .get(projectId, slug) as (WriterStampRow & { writer_stamp: string | null }) | null;
    if (row?.writer_stamp && stampedWriter(row) === null) {
      this.db.run("UPDATE knowledge SET writer_stamp = NULL WHERE project_id = ? AND slug = ?", [projectId, slug]);
    }
  }

  /**
   * Re-writes a doc's vec mirror rows from its stored chunk embeddings, so the
   * mirror's partition keys (project_id, scope, owner_user) and source_kind
   * follow a change to the doc's columns — a KNN pre-filter reads them, not the
   * `knowledge` row. No re-embed; a no-op without a mirror. Without sqlite-vec
   * the mirror can't be written, so a doc with chunks marks it stale for
   * ensureVecIndex instead.
   */
  refreshDocVectors(projectId: string, slug: string): void {
    if (!this.vecTableExists()) return;
    const doc = this.getDoc(projectId, slug);
    if (!doc) return;
    if (!isVecAvailable(this.db)) {
      if (this.db.query("SELECT 1 FROM knowledge_chunks WHERE knowledge_id = ? LIMIT 1").get(doc.id)) {
        this.markVecMirrorStale();
      }
      return;
    }
    for (const chunk of this.getChunks(doc.id)) this.indexChunkVector(chunk);
  }

  /**
   * Writes a doc and its FTS row, returning the doc's STORED id. On a conflict
   * with an existing (project_id, slug) the row keeps the id it already has —
   * edges, chunks and FTS are keyed on it — so the id `doc` carries (the loader
   * mints a fresh one per load) is only used for a first insert. Callers key any
   * dependent write (chunks) on the returned id.
   */
  upsertDoc(doc: KnowledgeDoc): string {
    // Stores the file's real mtime (doc.updatedAt), not "now" — syncProject
    // compares this against a fresh stat() to decide whether to skip
    // re-embedding an unchanged file on every lazy resync.
    const columns: WriterStampRow = {
      project_id: doc.projectId,
      slug: doc.slug,
      title: doc.title,
      body: doc.body,
      tags_json: doc.tags ? JSON.stringify(doc.tags) : null,
      // Fail-closed: an unasserted class is 'untrusted', not trusted by
      // omission.
      origin_class: doc.originClass ?? "untrusted",
      source_session_id: doc.sourceSessionId ?? null,
      // Source kind defaults to unclassified (roadmap r2).
      source_kind: doc.sourceKind ?? DEFAULT_SOURCE_KIND,
      // Scope defaults to project-scoped (a doc belongs to its project unless
      // promoted); owner_user stays NULL unless the doc names an owning user.
      scope: doc.scope ?? "project",
      owner_user: doc.ownerUser ?? null,
      generated_at: doc.generatedAt ?? null,
    };
    const stored = this.db
      .query(
        `INSERT INTO knowledge (id, project_id, slug, title, body, tags_json, embedding_json, file_path, updated_at, generated_from_sha, generated_at, related_json, origin_class, source_session_id, source_kind, confidence, last_verified_at, half_life_days, scope, owner_user, content_hash, content_first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, slug) DO UPDATE SET
           content_first_seen = CASE
             WHEN knowledge.content_first_seen IS NOT NULL
               AND (knowledge.content_hash = excluded.content_hash
                    OR (knowledge.content_hash IS NULL AND knowledge.body = excluded.body))
             THEN knowledge.content_first_seen
             ELSE ?
           END,
           content_hash = excluded.content_hash,
           title = excluded.title,
           body = excluded.body,
           tags_json = excluded.tags_json,
           embedding_json = excluded.embedding_json,
           file_path = excluded.file_path,
           updated_at = excluded.updated_at,
           generated_from_sha = excluded.generated_from_sha,
           generated_at = excluded.generated_at,
           related_json = excluded.related_json,
           origin_class = excluded.origin_class,
           source_session_id = excluded.source_session_id,
           source_kind = excluded.source_kind,
           confidence = excluded.confidence,
           last_verified_at = excluded.last_verified_at,
           half_life_days = excluded.half_life_days,
           scope = excluded.scope,
           owner_user = excluded.owner_user,
           -- A writer stamp survives only a rewrite of the very content it was
           -- given for (a re-sync of an unchanged file); any other write is
           -- not that writer's, so the row loses it.
           writer_stamp = CASE
             WHEN substr(knowledge.writer_stamp, -64) = ? THEN knowledge.writer_stamp
             ELSE NULL
           END
         RETURNING id`
      )
      .get(
        doc.id,
        columns.project_id,
        columns.slug,
        columns.title,
        columns.body,
        columns.tags_json,
        doc.embedding ? JSON.stringify(doc.embedding) : null,
        doc.filePath,
        doc.updatedAt.toISOString(),
        doc.generatedFromSha ?? null,
        columns.generated_at,
        doc.related ? JSON.stringify(doc.related) : null,
        columns.origin_class,
        columns.source_session_id,
        columns.source_kind,
        // Confidence fields stay NULL for a doc that asserts no opinion
        // (roadmap r2).
        doc.confidence ?? null,
        doc.lastVerifiedAt ?? null,
        doc.halfLifeDays ?? null,
        columns.scope,
        columns.owner_user,
        // The body's content clock. A new row starts it at the doc's own
        // generation date where it carries one, else the file time — the rule
        // the column's backfill applies to existing rows. A changed body
        // restarts it at the file time of the sync that read it; an unchanged
        // body keeps its clock (the CASE above).
        contentHash(doc.body),
        isoTimestamp(doc.generatedAt) ?? doc.updatedAt.toISOString(),
        doc.updatedAt.toISOString(),
        writerStampDigest(columns)
      ) as { id: string };
    const id = stored.id;

    // Update FTS index — delete+insert since fts5 tables don't support
    // ON CONFLICT upserts the way regular tables do.
    this.db.run("DELETE FROM knowledge_fts WHERE id = ?", [id]);
    this.db.run(
      `INSERT INTO knowledge_fts (id, slug, title, body, tags) VALUES (?, ?, ?, ?, ?)`,
      [id, doc.slug, doc.title, doc.body, doc.tags?.join(" ") ?? ""]
    );
    this.applyFileValidity(id, doc);
    return id;
  }

  upsertChunk(chunk: KnowledgeChunk): void {
    this.db.run(
      `INSERT INTO knowledge_chunks (id, knowledge_id, chunk_index, text, embedding_json, chunker_version, embedding_blob)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(knowledge_id, chunk_index) DO UPDATE SET
         text = excluded.text,
         embedding_json = excluded.embedding_json,
         chunker_version = excluded.chunker_version,
         embedding_blob = excluded.embedding_blob`,
      [
        chunk.id,
        chunk.knowledgeId,
        chunk.chunkIndex,
        chunk.text,
        JSON.stringify(chunk.embedding),
        chunk.chunkerVersion ?? CHUNKER_VERSION,
        embeddingToBlob(chunk.embedding),
      ]
    );

    this.indexChunkVector(chunk);
    this.bumpChunkGeneration(isVecAvailable(this.db));
  }

  /**
   * Brings every chunk to holding its vector in both columns,
   * EMBEDDING_BLOB_BACKFILL_BATCH rows per transaction, and returns how many
   * rows it rewrote. A row with only a JSON vector gains the embedding_blob; a
   * row with only a blob gains the JSON text again, so a build that reads only
   * embedding_json keeps working on the same database. Existing JSON is never
   * cleared. Idempotent: a row holding both is never selected again, so a
   * second call rewrites nothing. An unreadable JSON vector is left as it is.
   * The vector itself is unchanged (the vec0 mirror already holds it as
   * float32), so neither the mirror nor the chunk generation moves.
   */
  backfillEmbeddingBlobs(): number {
    const select = this.db.query(
      `SELECT rowid AS rid, embedding_json AS json, embedding_blob AS blob FROM knowledge_chunks
       WHERE ((embedding_blob IS NULL AND embedding_json != '')
           OR (embedding_blob IS NOT NULL AND LENGTH(embedding_blob) > 0 AND embedding_json = ''))
         AND rowid > ?
       ORDER BY rowid LIMIT ${EMBEDDING_BLOB_BACKFILL_BATCH}`
    );
    const setBlob = this.db.prepare("UPDATE knowledge_chunks SET embedding_blob = ? WHERE rowid = ?");
    const setJson = this.db.prepare("UPDATE knowledge_chunks SET embedding_json = ? WHERE rowid = ?");
    let converted = 0;
    let after = 0;
    for (;;) {
      const rows = select.all(after) as Array<{ rid: number; json: string; blob: Uint8Array | null }>;
      if (rows.length === 0) return converted;
      this.db.transaction(() => {
        for (const row of rows) {
          if (row.blob && row.blob.byteLength > 0) {
            setJson.run(JSON.stringify(blobToEmbedding(row.blob)), row.rid);
            converted++;
            continue;
          }
          const embedding = chunkEmbedding(null, row.json);
          if (!embedding) continue;
          setBlob.run(embeddingToBlob(embedding), row.rid);
          converted++;
        }
      })();
      after = rows[rows.length - 1]!.rid;
    }
  }

  /** The chunk indexes a doc currently has stored, ascending. */
  chunkIndexes(knowledgeId: string): number[] {
    return (
      this.db
        .query(
          "SELECT chunk_index FROM knowledge_chunks WHERE knowledge_id = ? ORDER BY chunk_index"
        )
        .all(knowledgeId) as Array<{ chunk_index: number }>
    ).map((r) => r.chunk_index);
  }

  /**
   * A doc's stored chunks without their vectors — index, text and the chunker
   * version that produced them, ascending by index. What the backfill compares
   * against the production chunker's output to find stale or missing chunks.
   */
  chunkStates(
    knowledgeId: string
  ): Array<{ chunkIndex: number; text: string; chunkerVersion: number | null }> {
    return (
      this.db
        .query(
          `SELECT chunk_index, text, chunker_version FROM knowledge_chunks
           WHERE knowledge_id = ? ORDER BY chunk_index`
        )
        .all(knowledgeId) as Array<{
        chunk_index: number;
        text: string;
        chunker_version: number | null;
      }>
    ).map((r) => ({ chunkIndex: r.chunk_index, text: r.text, chunkerVersion: r.chunker_version }));
  }

  /** Whether vector search is suspended (see setVectorSearchSuspended). */
  vectorSearchSuspended(): boolean {
    const row = this.db
      .query("SELECT vector_search_suspended AS s FROM knowledge_graph_meta WHERE id = 0")
      .get() as { s: number } | null;
    return (row?.s ?? 0) !== 0;
  }

  /**
   * Suspends (or resumes) vector search corpus-wide. Set while the stored
   * vectors may sit in a different embedding space from the one queries are
   * embedded in, so a query vector is never scored against them; text search
   * keeps serving meanwhile. Shared through the DB, since searches run on
   * other KnowledgeStore instances than the one the indexer holds.
   */
  setVectorSearchSuspended(suspended: boolean): void {
    this.db.run("UPDATE knowledge_graph_meta SET vector_search_suspended = ? WHERE id = 0", [
      suspended ? 1 : 0,
    ]);
  }

  /**
   * Removes a doc's chunks (and their vec rows) at the given indexes. Used for a
   * chunk whose re-embed failed: its previous vector embedded different text, so
   * the chunk is dropped rather than left pointing at a stale vector; the doc
   * stays reachable through FTS and its other chunks until a later sync fills it.
   */
  deleteChunks(knowledgeId: string, chunkIndexes: readonly number[]): void {
    if (chunkIndexes.length === 0) return;
    const placeholders = chunkIndexes.map(() => "?").join(", ");
    this.deleteChunksWhere(`knowledge_id = ? AND chunk_index IN (${placeholders})`, [
      knowledgeId,
      ...chunkIndexes,
    ]);
  }

  /**
   * Removes a doc's chunks (and their vec rows) at index `count` and above, so a
   * re-chunk that produced fewer chunks than before leaves no tail of chunks
   * embedding text the doc no longer has.
   */
  truncateChunks(knowledgeId: string, count: number): void {
    this.deleteChunksWhere("knowledge_id = ? AND chunk_index >= ?", [knowledgeId, count]);
  }

  private deleteChunksWhere(where: string, params: (string | number)[]): void {
    const n = (
      this.db.query(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    if (n === 0) return;
    this.db.transaction(() => {
      if (isVecAvailable(this.db) && this.vecTableExists()) {
        this.db.run(
          `DELETE FROM ${VEC_TABLE}
           WHERE rowid IN (SELECT rowid FROM knowledge_chunks WHERE ${where})`,
          params
        );
      }
      this.db.run(`DELETE FROM knowledge_chunks WHERE ${where}`, params);
    })();
    this.bumpChunkGeneration(isVecAvailable(this.db));
  }

  /**
   * Up to `n` stored chunks spread evenly across the chunk table (by rowid), each
   * with its doc's current title and body so the caller can re-derive the exact
   * text that was embedded. The embedding canary re-embeds these to detect a
   * provider whose output drifted under an unchanged fingerprint.
   */
  sampleChunks(n: number): Array<{
    knowledgeId: string;
    chunkIndex: number;
    text: string;
    embedding: number[];
    chunkerVersion: number | null;
    title: string;
    body: string;
  }> {
    const total = (this.db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number })
      .n;
    if (total === 0 || n <= 0) return [];
    const take = Math.min(n, total);
    const offsets = new Set<number>();
    for (let i = 0; i < take; i++) {
      offsets.add(take === 1 ? 0 : Math.round((i * (total - 1)) / (take - 1)));
    }
    const stmt = this.db.query(
      `SELECT kc.knowledge_id, kc.chunk_index, kc.text, kc.embedding_blob, kc.embedding_json, kc.chunker_version,
              k.title, k.body
       FROM knowledge_chunks kc JOIN knowledge k ON k.id = kc.knowledge_id
       ORDER BY kc.rowid LIMIT 1 OFFSET ?`
    );
    const out: ReturnType<KnowledgeStore["sampleChunks"]> = [];
    for (const offset of offsets) {
      const row = stmt.get(offset) as {
        knowledge_id: string;
        chunk_index: number;
        text: string;
        embedding_blob: Uint8Array | null;
        embedding_json: string;
        chunker_version: number | null;
        title: string;
        body: string;
      } | null;
      if (!row) continue;
      out.push({
        knowledgeId: row.knowledge_id,
        chunkIndex: row.chunk_index,
        text: row.text,
        embedding: chunkEmbedding(row.embedding_blob, row.embedding_json) ?? [],
        chunkerVersion: row.chunker_version,
        title: row.title,
        body: row.body,
      });
    }
    return out;
  }

  // Advances the shared chunk-generation counter corpusRevision folds in, so any
  // chunk write moves the graph memo's key even when the write leaves the chunk
  // COUNT and the sampled embedding width unchanged (a same-width re-embed). See
  // the knowledge_graph_meta table comment for why this is DB-backed, not a field.
  // `vecInStep` says the write kept the vec0 mirror in step (sqlite-vec was
  // loaded): vec_generation then advances with it, but only from an in-step
  // mirror, so a write some other connection made without sqlite-vec is never
  // masked. One statement, so the comparison and both bumps are atomic.
  private bumpChunkGeneration(vecInStep: boolean): void {
    this.db.run(
      vecInStep
        ? `UPDATE knowledge_graph_meta SET
             vec_generation = CASE WHEN vec_generation = chunk_generation THEN chunk_generation + 1 ELSE vec_generation END,
             chunk_generation = chunk_generation + 1
           WHERE id = 0`
        : "UPDATE knowledge_graph_meta SET chunk_generation = chunk_generation + 1 WHERE id = 0"
    );
  }

  // Records that the vec0 mirror missed a write it reflects (a doc's partition
  // keys changed without sqlite-vec), so ensureVecIndex rebuilds it; leaves
  // chunk_generation, and so corpusRevision, alone.
  private markVecMirrorStale(): void {
    this.db.run("UPDATE knowledge_graph_meta SET vec_generation = chunk_generation - 1 WHERE id = 0");
  }

  private generations(): { chunk: number; vec: number } {
    const row = this.db
      .query("SELECT chunk_generation AS c, vec_generation AS v FROM knowledge_graph_meta WHERE id = 0")
      .get() as { c: number; v: number } | null;
    return { chunk: row?.c ?? 0, vec: row?.v ?? 0 };
  }

  // Mirrors the just-written chunk into the vec0 KNN index, keyed by the
  // chunk's stable knowledge_chunks.rowid so an update to an existing chunk
  // re-points its one vector rather than accumulating duplicates. A no-op when
  // sqlite-vec isn't loadable on this connection — the vec table then never
  // exists and search runs the brute-force scan instead. The vec row carries
  // the doc's project_id / scope / owner_user (partition keys) and source_kind
  // (a metadata column) so the same scope/owner/kind filters the brute-force SQL
  // applies can be pushed into the KNN query.
  //
  // chunk_id is read back from knowledge_chunks (kc.id), NOT taken from the
  // incoming chunk: upsertChunk's ON CONFLICT(knowledge_id, chunk_index) never
  // updates the id column, so a re-embed that passes a fresh id (embedDoc mints
  // one per call) leaves the stored id unchanged. Indexing the incoming id
  // would point the vec row at an id no knowledge_chunks row carries, and
  // getChunksByIds (WHERE kc.id IN (...)) would then drop the re-embedded chunk
  // from the KNN candidate set. Selecting the stored id keeps the mirror
  // consistent with rebuildVecIndex, which indexes kc.id too.
  private indexChunkVector(chunk: KnowledgeChunk): void {
    if (!isVecAvailable(this.db)) return;

    // A mirror from an older build carries no scope/owner partition keys, so a
    // row with them would not match its columns. Rebuild the whole mirror once
    // onto the current schema from the stored embeddings (no re-embed) — the
    // chunk being indexed is already persisted in knowledge_chunks, so the
    // rebuild includes it and the per-chunk write below is redundant.
    if (this.vecTableExists() && !this.vecTableSchemaCurrent()) {
      this.rebuildVecIndex();
      return;
    }

    const meta = this.db
      .query(
        `SELECT kc.rowid AS rid, kc.id AS chunk_id, k.project_id AS project_id,
                k.scope AS scope, k.owner_user AS owner_user, k.source_kind AS source_kind
         FROM knowledge_chunks kc JOIN knowledge k ON k.id = kc.knowledge_id
         WHERE kc.knowledge_id = ? AND kc.chunk_index = ?`
      )
      .get(chunk.knowledgeId, chunk.chunkIndex) as {
      rid: number;
      chunk_id: string;
      project_id: string;
      scope: string | null;
      owner_user: string | null;
      source_kind: string | null;
    } | null;
    if (!meta) return;

    this.ensureVecTable(chunk.embedding.length);
    this.db.run(`DELETE FROM ${VEC_TABLE} WHERE rowid = ?`, [meta.rid]);
    this.db.run(
      `INSERT INTO ${VEC_TABLE} (rowid, project_id, scope, owner_user, source_kind, chunk_id, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        meta.rid,
        meta.project_id,
        meta.scope ?? DEFAULT_SCOPE,
        meta.owner_user ?? VEC_OWNER_NONE,
        meta.source_kind ?? DEFAULT_SOURCE_KIND,
        meta.chunk_id,
        embeddingToBlob(chunk.embedding),
      ]
    );
  }

  private vecTableExists(): boolean {
    return !!this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(VEC_TABLE);
  }

  // Whether the existing vec0 mirror already declares the scope/owner partition
  // keys. False for a mirror created by an older build (partitioned only by
  // project_id), which must be rebuilt once onto the current schema.
  private vecTableSchemaCurrent(): boolean {
    const row = this.db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(VEC_TABLE) as { sql: string | null } | null;
    return vecTableDeclaresPartitionKeys(row?.sql);
  }

  // Creates the vec0 mirror at a fixed embedding width the first time a vector
  // is indexed (see buildVecTableDDL for the schema and its rationale). Callers
  // that reach here after rebuildVecIndex's DROP find no table and create fresh;
  // the incremental path guards a stale-schema mirror before calling here.
  private ensureVecTable(dimensions: number): void {
    if (this.vecTableExists()) return;
    this.db.exec(buildVecTableDDL(dimensions));
  }

  /**
   * Rebuilds the vec0 index from scratch out of knowledge_chunks. Needed at
   * startup so a corpus embedded on an earlier boot (or before sqlite-vec was
   * enabled) gets an index without waiting for each doc to be re-embedded, and
   * as a repair after any drift. A no-op when sqlite-vec isn't available or the
   * chunk table is empty; otherwise it drops the mirror and repopulates every
   * chunk's vector in one transaction, keyed by the chunk rowid. Because it drops
   * and recreates via buildVecTableDDL, the startup rebuild also migrates a
   * mirror from an older build onto the current partition-key schema in one pass
   * — reading the stored embeddings, never re-embedding.
   */
  rebuildVecIndex(): void {
    if (!isVecAvailable(this.db)) return;
    // Read before the chunks: a write another connection makes mid-rebuild
    // moves chunk_generation past it, and the next ensureVecIndex rebuilds.
    const generation = this.generations().chunk;
    const reflects = () =>
      this.db.run("UPDATE knowledge_graph_meta SET vec_generation = ? WHERE id = 0", [generation]);
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);

    const dimensions = this.storedChunkDimensions();
    if (dimensions === null) {
      reflects();
      return;
    }
    this.ensureVecTable(dimensions);

    const rows = this.db
      .query(
        `SELECT kc.rowid AS rid, kc.id AS chunk_id, kc.embedding_blob AS embedding_blob,
                kc.embedding_json AS embedding_json,
                k.project_id AS project_id, k.scope AS scope, k.owner_user AS owner_user,
                k.source_kind AS source_kind
         FROM knowledge_chunks kc JOIN knowledge k ON k.id = kc.knowledge_id`
      )
      .all() as Array<{
      rid: number;
      chunk_id: string;
      embedding_blob: Uint8Array | null;
      embedding_json: string;
      project_id: string;
      scope: string | null;
      owner_user: string | null;
      source_kind: string | null;
    }>;

    const insert = this.db.prepare(
      `INSERT INTO ${VEC_TABLE} (rowid, project_id, scope, owner_user, source_kind, chunk_id, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const write = this.db.transaction(() => {
      for (const row of rows) {
        // A stray other-width vector can only exist mid-reindex; skip it rather
        // than fail the whole rebuild — the matching-width re-embed will index it.
        if (chunkEmbeddingWidth(row.embedding_blob, row.embedding_json) !== dimensions) continue;
        // A blob is already the encoding vec0 stores, so it is copied as is.
        const blob =
          row.embedding_blob && row.embedding_blob.byteLength > 0
            ? row.embedding_blob
            : embeddingToBlob(chunkEmbedding(null, row.embedding_json)!);
        insert.run(
          row.rid,
          row.project_id,
          row.scope ?? DEFAULT_SCOPE,
          row.owner_user ?? VEC_OWNER_NONE,
          row.source_kind ?? DEFAULT_SOURCE_KIND,
          row.chunk_id,
          blob
        );
      }
      reflects();
    });
    write();
  }

  /**
   * Brings the vec0 mirror up at startup, rebuilding it (rebuildVecIndex)
   * only when it can't serve as it stands: missing while chunks exist, on an
   * older schema, at another width than the stored embeddings, or out of step
   * with knowledge_chunks (row count or rowid sum differ, or vec_generation
   * short of chunk_generation — a write made on a connection without
   * sqlite-vec, say). The mirror persists in the DB and
   * every chunk write keeps it current (upsertChunk, the chunk deletes,
   * refreshDocVectors), so a boot normally finds it current and only counts.
   * Returns what it did; `unavailable` without sqlite-vec.
   */
  ensureVecIndex(): { action: "unavailable" | "current" | "rebuilt"; reason?: string } {
    if (!isVecAvailable(this.db)) return { action: "unavailable" };
    const reason = this.vecIndexRebuildReason();
    if (reason === null) return { action: "current" };
    this.rebuildVecIndex();
    return { action: "rebuilt", reason };
  }

  /** Why the vec0 mirror needs a rebuild (see ensureVecIndex), or null when it is current. */
  vecIndexRebuildReason(): string | null {
    const exists = this.vecTableExists();
    const generations = this.generations();
    const stats = (table: string) =>
      this.db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(rowid), 0) AS s FROM ${table}`).get() as { n: number; s: number };
    const chunks = stats("knowledge_chunks");
    const createSql = exists
      ? ((this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(VEC_TABLE) as { sql: string | null } | null)?.sql ?? null)
      : null;
    const vec = exists && vecTableDeclaresPartitionKeys(createSql) ? stats(VEC_TABLE) : null;
    return vecMirrorRebuildReason({
      exists,
      createSql,
      storedDimensions: this.storedChunkDimensions(),
      chunkRows: chunks.n,
      chunkRowidSum: chunks.s,
      ...(vec ? { vecRows: vec.n, vecRowidSum: vec.s } : {}),
      chunkGeneration: generations.chunk,
      vecGeneration: generations.vec,
    });
  }

  /** True once sqlite-vec is loadable AND the mirror table has been built —
   *  i.e. the KNN path can serve this search. Search falls back to the
   *  brute-force scan whenever this is false. */
  vecReady(): boolean {
    return isVecAvailable(this.db) && this.vecTableExists();
  }

  /**
   * The best-matching chunk ids for `queryEmbedding` under the SAME filters
   * getAllChunksWithEmbeddings pushes into its SQL — an optional project pin, a
   * source-kind restriction, the strict scope gate (`audience`), and the
   * permissive owner filter (`owners`) — so the KNN candidate pool equals the
   * brute-force pool. The scope gate and owner filter are disjunctive, and a
   * vec0 partition key admits only equality, so they are decomposed into a UNION
   * of per-partition KNN subqueries (partitionSpecsForGate): each subquery
   * pre-filters DURING the scan, returning its own top-`limit` from within its
   * partition, so no in-scope doc is starved by out-of-scope docs the way a
   * fixed-top-K post-filter would. Returns [] when the KNN path isn't ready.
   */
  vecKnnChunkIds(
    queryEmbedding: number[],
    limit: number,
    projectId?: string,
    sourceKinds?: readonly SourceKind[],
    audience?: ScopeAudience,
    owners?: readonly string[]
  ): string[] {
    if (!this.vecReady()) return [];
    const ids = new Set<string>();
    for (const spec of partitionSpecsForGate(projectId, audience, owners)) {
      for (const id of this.vecKnnForSpec(queryEmbedding, limit, spec, sourceKinds)) {
        ids.add(id);
      }
    }
    return [...ids];
  }

  // One partition's KNN: the `limit` nearest chunk ids whose partition-key
  // columns equal `spec`'s set fields (an unset field is unconstrained) and
  // whose source_kind is in `sourceKinds`. project_id / scope / owner_user are
  // partition keys and source_kind is a metadata column, so every constraint is
  // pushed into the vec0 scan rather than applied after it.
  private vecKnnForSpec(
    queryEmbedding: number[],
    limit: number,
    spec: VecPartitionSpec,
    sourceKinds?: readonly SourceKind[]
  ): string[] {
    const clauses = ["embedding MATCH ?", "k = ?"];
    const params: (string | number | Uint8Array)[] = [
      embeddingToBlob(queryEmbedding),
      Math.max(1, Math.floor(limit)),
    ];
    if (spec.projectId !== undefined) {
      clauses.push("project_id = ?");
      params.push(spec.projectId);
    }
    if (spec.scope !== undefined) {
      clauses.push("scope = ?");
      params.push(spec.scope);
    }
    if (spec.ownerUser !== undefined) {
      clauses.push("owner_user = ?");
      params.push(spec.ownerUser);
    }
    if (sourceKinds !== undefined && sourceKinds.length > 0) {
      clauses.push(`source_kind IN (${sourceKinds.map(() => "?").join(", ")})`);
      params.push(...sourceKinds);
    }

    const rows = this.db
      .query(
        `SELECT chunk_id FROM ${VEC_TABLE}
         WHERE ${clauses.join(" AND ")}
         ORDER BY distance`
      )
      .all(...params) as Array<{ chunk_id: string }>;
    return rows.map((r) => r.chunk_id);
  }

  /**
   * Corpus counts derived by simple aggregates over the existing schema — no
   * schema change, all COUNTs. Powers /api/knowledge/stats and the Health
   * panel. `projectId` scopes the top-level scalars to one project; `edges` is
   * cross-project by nature, so a scoped count is edges *touching* a doc in
   * that project rather than edges "owned" by it (the graph has no owner).
   * `perProject` is the cross-project breakdown when unscoped, and the single
   * project when scoped, so a caller always gets a self-consistent view.
   * `dimensions` is read from an actually-stored chunk embedding, not the
   * provider's advertised default, so it reflects what retrieval really runs on
   * (null when nothing is embedded yet). Provider/model are runtime facts the
   * store can't know; the caller stamps those.
   */
  getStats(projectId?: string): KnowledgeStoreStats {
    const scoped = projectId !== undefined;
    const scalars = this.projectScalars(projectId);

    const originRows = this.db
      .query(
        `SELECT origin_class, COUNT(*) AS n FROM knowledge
         ${scoped ? "WHERE project_id = ?" : ""}
         GROUP BY origin_class`
      )
      .all(...(scoped ? [projectId] : [])) as Array<{
      origin_class: string | null;
      n: number;
    }>;
    const originClassBreakdown: Record<string, number> = {};
    for (const row of originRows) {
      // Fail-closed read: a legacy NULL class counts as 'untrusted', the same
      // class every read path treats it as, so the breakdown sums to `docs`.
      const cls = (row.origin_class as OriginClass) ?? "untrusted";
      originClassBreakdown[cls] = (originClassBreakdown[cls] ?? 0) + row.n;
    }

    const sourceKindRows = this.db
      .query(
        `SELECT source_kind, COUNT(*) AS n FROM knowledge
         ${scoped ? "WHERE project_id = ?" : ""}
         GROUP BY source_kind`
      )
      .all(...(scoped ? [projectId] : [])) as Array<{
      source_kind: string | null;
      n: number;
    }>;
    const sourceKindBreakdown: Record<string, number> = {};
    for (const row of sourceKindRows) {
      // A legacy NULL counts as the default kind every read path applies, so
      // the breakdown sums to `docs`.
      const kind = (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND;
      sourceKindBreakdown[kind] = (sourceKindBreakdown[kind] ?? 0) + row.n;
    }

    const dimsRow = this.db
      .query(
        `SELECT kc.embedding_blob, kc.embedding_json FROM knowledge_chunks kc
         ${scoped ? "JOIN knowledge k ON k.id = kc.knowledge_id WHERE k.project_id = ?" : ""}
         LIMIT 1`
      )
      .get(...(scoped ? [projectId] : [])) as {
      embedding_blob: Uint8Array | null;
      embedding_json: string;
    } | null;
    const dimensions = dimsRow ? chunkEmbeddingWidth(dimsRow.embedding_blob, dimsRow.embedding_json) : null;

    const projectIds = scoped
      ? [projectId!]
      : (
          this.db
            .query("SELECT DISTINCT project_id FROM knowledge ORDER BY project_id")
            .all() as Array<{ project_id: string }>
        ).map((r) => r.project_id);
    const perProject: PerProjectStats[] = projectIds.map((id) => {
      const s = this.projectScalars(id);
      return {
        projectId: id,
        docs: s.docs,
        chunks: s.chunks,
        coveragePct: s.coveragePct,
        edges: s.edges,
      };
    });

    return {
      docs: scalars.docs,
      chunks: scalars.chunks,
      embeddedDocs: scalars.embeddedDocs,
      coveragePct: scalars.coveragePct,
      edges: scalars.edges,
      edgesPerDoc: scalars.docs === 0 ? 0 : scalars.edges / scalars.docs,
      dimensions,
      originClassBreakdown,
      sourceKindBreakdown,
      perProject,
    };
  }

  // The scoped counts getStats folds over, factored out because perProject
  // needs the exact same aggregates per project. An undefined projectId counts
  // the whole corpus.
  private projectScalars(projectId?: string): {
    docs: number;
    chunks: number;
    embeddedDocs: number;
    coveragePct: number;
    edges: number;
  } {
    const scoped = projectId !== undefined;
    const args = scoped ? [projectId] : [];

    const count = (sql: string): number =>
      (this.db.query(sql).get(...args) as { n: number }).n;

    const docs = count(
      `SELECT COUNT(*) AS n FROM knowledge ${scoped ? "WHERE project_id = ?" : ""}`
    );
    // A doc is "embedded" when it has at least one row in knowledge_chunks —
    // that is where the ingest pipeline actually writes vectors. The doc-level
    // knowledge.embedding_json column is not populated by any ingest path, so
    // counting it would report 0% coverage on a fully-embedded corpus.
    const embeddedDocs = count(
      `SELECT COUNT(*) AS n FROM knowledge k
       WHERE EXISTS (SELECT 1 FROM knowledge_chunks kc WHERE kc.knowledge_id = k.id)
       ${scoped ? "AND k.project_id = ?" : ""}`
    );
    const chunks = count(
      `SELECT COUNT(*) AS n FROM knowledge_chunks kc
       ${scoped ? "JOIN knowledge k ON k.id = kc.knowledge_id WHERE k.project_id = ?" : ""}`
    );
    // DISTINCT so an edge whose src AND dst both sit in the project is counted
    // once, not twice, by the OR-join.
    const edges = scoped
      ? count(
          `SELECT COUNT(DISTINCT e.id) AS n FROM knowledge_edges e
           JOIN knowledge k ON k.id = e.src_doc_id OR k.id = e.dst_doc_id
           WHERE k.project_id = ?`
        )
      : count("SELECT COUNT(*) AS n FROM knowledge_edges");

    return {
      docs,
      chunks,
      embeddedDocs,
      coveragePct: docs === 0 ? 0 : (embeddedDocs / docs) * 100,
      edges,
    };
  }

  /**
   * Every node + edge of the cross-project graph, the shape the Graph
   * visualization consumes. Nodes are docs (optionally scoped to one project);
   * edges are read straight from `knowledge_edges`. When scoped, only edges
   * whose BOTH endpoints are in-scope survive — a dangling half-edge to a
   * filtered-out doc would render as an arrow into nothing.
   *
   * Known, deferred limitation: de-float (compileGraph) detects floaters
   * GLOBALLY, so a doc whose only de-float edge lands on a cross-project
   * neighbor still appears floating in a single-project scoped view, because
   * this both-endpoints filter drops that cross-boundary edge. This scoped view
   * does not backfill such docs with their 1-hop cross-project neighbors.
   *
   * With an `audience` only its docs are nodes (a browse audience: every doc
   * but other users' personal layer), and the same both-endpoints rule drops
   * every edge to a doc it excludes.
   */
  getGraph(projectId?: string, audience?: ScopeAudience): KnowledgeGraph {
    const clauses: string[] = [];
    const params: string[] = [];
    if (projectId !== undefined) {
      clauses.push("k.project_id = ?");
      params.push(projectId);
    }
    if (audience) {
      const gate = scopeAudienceSql(audience, "k");
      clauses.push(gate.sql);
      params.push(...gate.params);
    }
    const nodeRows = this.db
      .query(
        `SELECT k.id, k.project_id, k.slug, k.title, k.origin_class, k.verdict,
                k.scope, k.source_kind, k.updated_at FROM knowledge k
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY k.project_id, k.slug`
      )
      .all(...params) as Array<{
      id: string;
      project_id: string;
      slug: string;
      title: string;
      origin_class: string | null;
      verdict: string | null;
      scope: string | null;
      source_kind: string | null;
      updated_at: string | null;
    }>;

    const nodes: KnowledgeGraphNode[] = nodeRows.map((row) => {
      const scope = (row.scope as Scope) ?? DEFAULT_SCOPE;
      const sourceKind = (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND;
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        projectId: row.project_id,
        originClass: (row.origin_class as OriginClass) ?? "untrusted",
        verdict: (row.verdict as DraftVerdict) ?? undefined,
        scope,
        sourceKind,
        layer: layerOf({ scope, sourceKind, slug: row.slug }),
        updatedAt: row.updated_at ?? undefined,
      };
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeRows = this.db
      .query(
        "SELECT src_doc_id, dst_doc_id, kind, weight, evidence, confidence FROM knowledge_edges"
      )
      .all() as Array<{
      src_doc_id: string;
      dst_doc_id: string;
      kind: string;
      weight: number | null;
      evidence: string | null;
      confidence: number | null;
    }>;

    // The graph draws undirected lines, so a pair stored in both directions
    // under one kind (a contradiction, a mutual `related` link, two docs that
    // are each other's semantic neighbor) is ONE line: keep the first row and
    // the larger weight, so degree counts the neighbor once.
    const byPair = new Map<string, KnowledgeGraphEdge>();
    for (const e of edgeRows) {
      if (!nodeIds.has(e.src_doc_id) || !nodeIds.has(e.dst_doc_id)) continue;
      const [a, b] =
        e.src_doc_id < e.dst_doc_id ? [e.src_doc_id, e.dst_doc_id] : [e.dst_doc_id, e.src_doc_id];
      const key = `${e.kind}|${a}|${b}`;
      const weight = e.weight ?? 0;
      const cur = byPair.get(key);
      if (cur) {
        cur.weight = Math.max(cur.weight, weight);
        continue;
      }
      byPair.set(key, {
        source: e.src_doc_id,
        target: e.dst_doc_id,
        kind: e.kind as KnowledgeEdge["kind"],
        weight,
        evidence: e.evidence ?? undefined,
        confidence: e.confidence ?? undefined,
      });
    }

    return { nodes, edges: [...byPair.values()] };
  }

  getDocsByProject(projectId: string): KnowledgeDoc[] {
    const rows = this.db
      .query("SELECT * FROM knowledge WHERE project_id = ? ORDER BY slug")
      .all(projectId) as DocRow[];

    return rows.map(rowToDoc);
  }

  /**
   * Every doc across every project — the input the graph compile pass folds
   * over. Deliberately unscoped: co-citation and provenance edges are only
   * interesting across the project boundary a per-project read would hide.
   */
  getAllDocs(): KnowledgeDoc[] {
    const rows = this.db
      .query("SELECT * FROM knowledge ORDER BY project_id, slug")
      .all() as DocRow[];

    return rows.map(rowToDoc);
  }

  getDoc(projectId: string, slug: string): KnowledgeDoc | null {
    const row = this.db
      .query("SELECT * FROM knowledge WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as DocRow | null;

    return row ? rowToDoc(row) : null;
  }

  /**
   * A doc by its stable id — the handle an edge's endpoint carries. Lets a
   * graph pivot materialize a neighbor doc it reached by id alone, without the
   * projectId/slug pair getDoc needs.
   */
  getDocById(id: string): KnowledgeDoc | null {
    const row = this.db
      .query("SELECT * FROM knowledge WHERE id = ?")
      .get(id) as DocRow | null;

    return row ? rowToDoc(row) : null;
  }

  deleteDoc(projectId: string, slug: string): void {
    const doc = this.getDoc(projectId, slug);
    // Remove the doc's chunks explicitly, vec vectors first while the chunk rows
    // (and their rowids) still exist: the vec0 mirror has no foreign key to
    // cascade through, and knowledge_chunks' ON DELETE CASCADE only fires on a
    // connection with foreign_keys enabled.
    if (doc) this.truncateChunks(doc.id, 0);
    this.db.run(
      "DELETE FROM knowledge WHERE project_id = ? AND slug = ?",
      [projectId, slug]
    );
    if (doc) {
      this.db.run("DELETE FROM knowledge_fts WHERE id = ?", [doc.id]);
    }
    this.db.run("DELETE FROM knowledge_verifications WHERE id = ?", [`${projectId}/${slug}`]);
    // The doc's closed versions go with it; syncHistory re-indexes any whose
    // `.history/` file is still on disk.
    this.db.run(
      "DELETE FROM knowledge_history_fts WHERE id IN (SELECT id FROM knowledge_history WHERE project_id = ? AND slug = ?)",
      [projectId, slug]
    );
    this.db.run("DELETE FROM knowledge_history WHERE project_id = ? AND slug = ?", [projectId, slug]);
  }

  /**
   * The dimensionality of a stored chunk embedding, or null when the chunk
   * table is empty. Every chunk shares one width by construction, so one row
   * settles it — the caller compares this against the active provider to catch
   * a provider/model switch that would otherwise leave the index mixed.
   */
  storedChunkDimensions(): number | null {
    const row = this.db
      .query("SELECT embedding_blob, embedding_json FROM knowledge_chunks LIMIT 1")
      .get() as { embedding_blob: Uint8Array | null; embedding_json: string } | null;
    if (!row) return null;
    return chunkEmbeddingWidth(row.embedding_blob, row.embedding_json);
  }

  /**
   * Drops every chunk embedding. Used when the active provider/model no longer
   * matches what the corpus was embedded under: knowledge_chunks holds exactly
   * one vector width, so the corpus is re-embedded wholesale rather than mixed.
   * Docs and FTS are untouched — the embedding backfill re-chunks and
   * re-embeds each doc from its still-present body.
   */
  clearAllChunks(): void {
    this.db.run("DELETE FROM knowledge_chunks");
    // Drop the vec mirror rather than empty it: the next re-embed may run at a
    // different width, and the vec0 table's width is fixed at creation, so the
    // clean slate lets ensureVecTable recreate it at the active provider's
    // width. A no-op when sqlite-vec isn't loadable (the table never existed).
    if (isVecAvailable(this.db)) {
      this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    }
    // A wholesale clear is an embedding mutation — the semantic de-float edges
    // are derived from these vectors, so move the memo's key even though a
    // re-embed at the same width would otherwise look identical to corpusRevision.
    // With the mirror dropped alongside the chunks, the two are in step again
    // whatever the mirror missed before.
    if (isVecAvailable(this.db)) {
      this.db.run(
        `UPDATE knowledge_graph_meta SET chunk_generation = chunk_generation + 1, vec_generation = chunk_generation + 1
         WHERE id = 0`
      );
    } else {
      this.bumpChunkGeneration(false);
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
      embedding_blob: Uint8Array | null;
      embedding_json: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      knowledgeId: row.knowledge_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: chunkEmbedding(row.embedding_blob, row.embedding_json) ?? [],
    }));
  }

  // projectId is optional so semantic search can span every project (the
  // cross-project corpus) and still recover which project each hit belongs to
  // for the ranking multiplier — passing undefined drops the WHERE filter.
  getAllChunksWithEmbeddings(
    projectId?: string,
    sourceKinds?: readonly SourceKind[],
    audience?: ScopeAudience,
    owners?: readonly string[]
  ): ChunkWithEmbedding[] {
    // Build the WHERE from the optional project scope AND the optional
    // source_kind restriction, so a kind-filtered embedding search draws its
    // candidates from that kind's own pool rather than the whole corpus. The
    // strict scope gate and permissive owner filter ride the same WHERE, so the
    // brute-force scan enforces them before the caller's cosine ranking.
    const clauses: string[] = [];
    const params: string[] = [];
    if (projectId !== undefined) {
      clauses.push("k.project_id = ?");
      params.push(projectId);
    }
    if (sourceKinds !== undefined && sourceKinds.length > 0) {
      clauses.push(`k.source_kind IN (${sourceKinds.map(() => "?").join(", ")})`);
      params.push(...sourceKinds);
    }
    const scopeGate = audience ? scopeAudienceSql(audience, "k") : null;
    if (scopeGate) {
      clauses.push(scopeGate.sql);
      params.push(...scopeGate.params);
    }
    const ownerFilter = owners ? ownerFilterSql(owners, "k") : null;
    if (ownerFilter) {
      clauses.push(ownerFilter.sql);
      params.push(...ownerFilter.params);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`${CHUNK_EMBEDDING_SELECT}\n         ${where}`)
      .all(...params) as ChunkEmbeddingRow[];

    return rows.map(rowToChunkWithEmbedding);
  }

  /**
   * Hydrates a specific set of chunk ids into the same shape
   * getAllChunksWithEmbeddings returns — the bridge from a vec KNN result (a
   * list of chunk ids) back to the fully-joined chunk objects the hybrid merge
   * scores. Order is not guaranteed and does not matter: searchEmbeddings
   * recomputes cosine and re-sorts, so this only has to return the right rows.
   * Empty in → empty out (no `IN ()`).
   */
  getChunksByIds(
    chunkIds: readonly string[],
    audience?: ScopeAudience,
    owners?: readonly string[]
  ): ChunkWithEmbedding[] {
    if (chunkIds.length === 0) return [];
    const placeholders = chunkIds.map(() => "?").join(", ");
    // The vec KNN returns ids without a scope/owner filter (its metadata columns
    // hold neither), so the gate is enforced here in the hydration WHERE. Still a
    // candidate-query filter — it runs before searchEmbeddings recomputes cosine
    // and re-sorts — so an out-of-scope chunk is dropped, not merely deranked.
    const clauses = [`kc.id IN (${placeholders})`];
    const params: string[] = [...chunkIds];
    const scopeGate = audience ? scopeAudienceSql(audience, "k") : null;
    if (scopeGate) {
      clauses.push(scopeGate.sql);
      params.push(...scopeGate.params);
    }
    const ownerFilter = owners ? ownerFilterSql(owners, "k") : null;
    if (ownerFilter) {
      clauses.push(ownerFilter.sql);
      params.push(...ownerFilter.params);
    }
    const rows = this.db
      .query(`${CHUNK_EMBEDDING_SELECT}\n         WHERE ${clauses.join(" AND ")}`)
      .all(...params) as ChunkEmbeddingRow[];
    return rows.map(rowToChunkWithEmbedding);
  }

  /**
   * A cheap fingerprint of every input compileGraph folds over — doc metadata,
   * contradiction verdicts/disputes, and chunk embeddings — that changes
   * whenever any of them do WITHOUT reading or JSON.parsing a single embedding
   * blob. compileGraph memoizes its (embedding-scanning, O(F·N)-cosine) de-float
   * pass on this, so a burst of graph/stats/neighbors reads over an unchanged
   * corpus recompiles at most once instead of on every request.
   *
   * Coverage of the realistic mutation paths, each independent of the others so
   * a signal that happens to be preserved by one path is still caught by another:
   *  - doc add/remove/edit: COUNT plus MAX(updated_at) plus the per-row VALUE fold
   *    (below) over the small text columns the graph actually reads (title, tags,
   *    related, source_session_id). Folding their VALUES — not merely their summed
   *    lengths — is what covers these columns: a same-length out-of-band edit (e.g.
   *    an mtime-preserving FTS-only sync that rewrites one tag to another of equal
   *    length without bumping updated_at) leaves COUNT and every length aggregate
   *    byte-identical, so only the value fold moves the revision. Body is
   *    deliberately excluded — the graph never folds over it, and a body edit
   *    re-chunks/re-embeds (caught by the chunk signal) and bumps updated_at anyway.
   *  - doc identity (id/slug), contradiction content (verdict/disputes), AND the
   *    small text metadata above (title, tags_json, related_json, source_session_id):
   *    a single order-independent fold of every doc's VALUES for (id, slug, verdict,
   *    disputes_json, title, tags_json, related_json, source_session_id). Several
   *    facets ride the same per-row hash:
   *      · Edge ids key on doc id, so a change to the id/slug SET must recompile
   *        the graph — yet a mtime-preserving slug rename (`mv`/`rsync -a`/`git mv`)
   *        deletes the old (id, slug) row and inserts a new one with a fresh UUID
   *        while leaving COUNT, MAX(updated_at) and every text-length sum
   *        byte-identical (the length aggregates above cannot see it, since even a
   *        same-length rename keeps them constant). Folding the id/slug VALUES —
   *        not their lengths — is the only term that moves on such a rename.
   *      · verdict/disputes are cron-owned (setDocVerdict/clearDocVerdict), written
   *        WITHOUT bumping updated_at, yet they drive the contradicts edges. The
   *        reverify/resolve cron can re-TARGET a contradiction — same verdict
   *        string, a disputes_json of identical length naming a different slug —
   *        which leaves a COUNT/length fingerprint unmoved. Folding the verdict and
   *        disputes VALUES makes any contradiction content change move the hash.
   *      · title/tags_json/related_json/source_session_id drive the co-citation,
   *        related and provenance edges. An out-of-band sync (FTS-only,
   *        mtime-preserving) can rewrite one to a SAME-LENGTH value without bumping
   *        updated_at — leaving COUNT and every length aggregate constant. Folding
   *        these VALUES is what moves the revision so those edges are never served
   *        stale (e.g. a tag rewritten `auth` → `pass` drops the stale co-citation
   *        edge on the next compile).
   *    The folded columns are all stable across a no-op resync (upsertDoc's ON
   *    CONFLICT preserves id and rewrites identical values), so this never
   *    invalidates the memo for an unchanged corpus.
   *  - chunk embeddings: COUNT plus one sampled embedding width plus a monotonic
   *    generation counter bumped on every chunk write (see knowledge_graph_meta).
   *    A re-embed at the SAME width and SAME chunk count — a provider swap to an
   *    equal-dimension model — rewrites every vector while leaving COUNT and the
   *    sampled width byte-identical and bumping no updated_at; the generation
   *    counter is the only term that moves then, so the semantic de-float edges
   *    are never served stale after such a swap. (This trades a possibly-needless
   *    recompile on a same-model re-embed — which reproduces identical vectors —
   *    for never serving a stale graph, the correct side to err on.)
   * Reads only small text columns, a handful of aggregates, and one integer
   * generation counter — never an embedding blob — so it stays the cheap
   * freshness check the per-request recompile was missing.
   */
  corpusRevision(): string {
    const d = this.db
      .query(
        `SELECT COUNT(*) AS n,
                COALESCE(MAX(updated_at), '') AS updated
         FROM knowledge`
      )
      .get() as {
      n: number;
      updated: string;
    };
    const c = this.db
      .query(
        `SELECT COUNT(*) AS n,
                COALESCE((SELECT COALESCE(LENGTH(embedding_blob), LENGTH(embedding_json)) FROM knowledge_chunks LIMIT 1), 0) AS width
         FROM knowledge_chunks`
      )
      .get() as { n: number; width: number };
    const gen =
      (this.db
        .query("SELECT chunk_generation AS g FROM knowledge_graph_meta WHERE id = 0")
        .get() as { g: number } | null)?.g ?? 0;
    // Per-row fold over every small text column the graph reads
    // (id, slug, verdict, disputes_json, title, tags_json, related_json,
    // source_session_id): two commutative (row-order-independent) accumulators of a
    // per-row hash. Summing AND XOR-ing makes a coincidental per-row hash collision
    // cancel in one accumulator but not the other, so any change to a doc's identity,
    // its contradiction content, or its co-citation/related/provenance metadata moves
    // the combined revision — even a same-length edit that leaves COUNT, MAX(updated_at)
    // and every length aggregate byte-identical. NUL-separated so shifting bytes between
    // columns can't forge an unchanged input; a NULL column folds as the empty string.
    const rows = this.db
      .query(
        `SELECT id, slug, verdict, disputes_json, title, tags_json, related_json, source_session_id
         FROM knowledge`
      )
      .all() as Array<{
      id: string;
      slug: string;
      verdict: string | null;
      disputes_json: string | null;
      title: string | null;
      tags_json: string | null;
      related_json: string | null;
      source_session_id: string | null;
    }>;
    let rowSum = 0;
    let rowXor = 0;
    for (const r of rows) {
      const h = fnv1a32(
        `${r.id}\u0000${r.slug}\u0000${r.verdict ?? ""}\u0000${r.disputes_json ?? ""}\u0000${r.title ?? ""}\u0000${r.tags_json ?? ""}\u0000${r.related_json ?? ""}\u0000${r.source_session_id ?? ""}`
      );
      rowSum = (rowSum + h) >>> 0;
      rowXor = (rowXor ^ h) >>> 0;
    }
    return [
      d.n,
      d.updated,
      c.n,
      c.width,
      gen,
      rowSum.toString(36),
      rowXor.toString(36),
    ].join("|");
  }

  /**
   * The memoized compiled edge set when the corpus is byte-for-byte unchanged
   * since it was compiled (per corpusRevision), or null on a miss. On a hit the
   * caller can skip both the chunk-embedding scan and re-persisting edges — the
   * knowledge_edges rows the matching compile wrote are still current, since
   * compileGraph is their only writer.
   */
  getCachedGraphEdges(revision: string): KnowledgeEdge[] | null {
    return this.graphCache && this.graphCache.revision === revision
      ? this.graphCache.edges
      : null;
  }

  /** Records a freshly compiled edge set against the corpus revision it was compiled from. */
  cacheGraphEdges(revision: string, edges: KnowledgeEdge[]): void {
    this.graphCache = { revision, edges };
  }

  /**
   * The memoized semantic neighbor index when the corpus is unchanged since it
   * was built (per corpusRevision), or null on a miss. Mirrors
   * getCachedGraphEdges: the index is a pure function of the corpus's chunk
   * embeddings, so a hit lets the graph-rerank arm skip the all-pairs cosine
   * rebuild.
   */
  getCachedSemanticIndex(revision: string): SemanticNeighborIndex | null {
    return this.semanticIndexCache && this.semanticIndexCache.revision === revision
      ? this.semanticIndexCache.index
      : null;
  }

  /** Records a freshly built semantic neighbor index against its corpus revision. */
  cacheSemanticIndex(revision: string, index: SemanticNeighborIndex): void {
    this.semanticIndexCache = { revision, index };
  }

  /**
   * Rebuilds the whole edge set in one transaction. The graph is a projection
   * of markdown + provenance, so a clean replace (rather than a merge) is the
   * honest model: an edge whose source `related:` line was deleted must not
   * linger. Cheap — edges are bounded by doc count × fanout cap.
   */
  replaceAllEdges(edges: KnowledgeEdge[]): void {
    // Dedup by id (which is 1:1 with the src/dst/kind triple) so a doc that
    // names the same `related` target twice can't collide on the PK inside the
    // batch — the table is emptied first, so the only possible conflict is an
    // in-batch one.
    const unique = new Map<string, KnowledgeEdge>();
    for (const e of edges) unique.set(e.id, e);

    const write = this.db.transaction((rows: KnowledgeEdge[]) => {
      this.db.run("DELETE FROM knowledge_edges");
      for (const e of rows) {
        this.db.run(
          `INSERT INTO knowledge_edges (id, src_doc_id, dst_doc_id, kind, weight, confidence, evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [e.id, e.srcDocId, e.dstDocId, e.kind, e.weight ?? null, e.confidence ?? null, e.evidence ?? null]
        );
      }
    });
    write([...unique.values()]);
  }

  /**
   * Resolved neighbors of a doc — both directions of every edge touching it,
   * joined to the far-end doc so callers get slug/title/project without a
   * second query. An edge whose far end no longer exists (a dangling id after
   * a rebuild race) is dropped by the JOIN rather than surfaced as a ghost.
   *
   * A doc pair can be joined by more than one edge — a `related` link an author
   * writes on both docs is stored as two directed edges (A->B and B->A), and
   * walking both directions of every edge would then surface the far doc twice
   * under the same kind. Collapse by (doc, kind), keeping the first row — which
   * is the highest-weight one, per the ORDER BY — so each distinct relationship
   * shows once while a genuinely different kind (e.g. co-citation) still gets
   * its own row rather than being folded into the `related` one.
   *
   * When an `audience` is supplied (the agent/MCP path), the far-end doc `k` is
   * filtered through scopeAudienceSql so a neighbor OUTSIDE the caller's global ∪
   * project ∪ user set is dropped rather than surfaced. Edges are derived over
   * every doc regardless of scope (see graph.ts), so without this a user-scoped
   * doc that shares a tag, session, or `related` link with a doc the caller can
   * see would leak its slug/title/project across the scope boundary. Omitting the
   * audience (the permissive web-browse path) preserves the unfiltered behavior.
   */
  getNeighbors(docId: string, audience?: ScopeAudience): KnowledgeNeighbor[] {
    // The far-end doc is aliased `k`, so the same scope gate the retrieval scan
    // and KNN hydration push into their WHERE applies here too. docId is bound
    // positionally three times (JOIN CASE + both WHERE disjuncts), then the gate
    // params follow — so the numbered-vs-anonymous placeholder mix that would
    // arise from ?1 plus appended ? is avoided.
    const scopeGate = audience ? scopeAudienceSql(audience, "k") : null;
    const scopeClause = scopeGate ? ` AND ${scopeGate.sql}` : "";
    const params: string[] = [docId, docId, docId];
    if (scopeGate) params.push(...scopeGate.params);
    const rows = this.db
      .query(
        `SELECT k.id AS doc_id, k.project_id, k.slug, k.title,
                k.origin_class, k.verdict, k.source_kind, e.kind, e.weight,
                e.evidence, e.confidence
         FROM knowledge_edges e
         JOIN knowledge k
           ON k.id = CASE WHEN e.src_doc_id = ? THEN e.dst_doc_id ELSE e.src_doc_id END
         WHERE (e.src_doc_id = ? OR e.dst_doc_id = ?)${scopeClause}
         ORDER BY e.weight DESC, k.slug`
      )
      .all(...params) as Array<{
      doc_id: string;
      project_id: string;
      slug: string;
      title: string;
      origin_class: string | null;
      verdict: string | null;
      source_kind: string | null;
      kind: string;
      weight: number | null;
      evidence: string | null;
      confidence: number | null;
    }>;

    const seen = new Set<string>();
    const neighbors: KnowledgeNeighbor[] = [];
    for (const row of rows) {
      const key = `${row.doc_id} ${row.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      neighbors.push({
        docId: row.doc_id,
        projectId: row.project_id,
        slug: row.slug,
        title: row.title,
        kind: row.kind as KnowledgeNeighbor["kind"],
        weight: row.weight ?? 0,
        evidence: row.evidence ?? undefined,
        confidence: row.confidence ?? undefined,
        originClass: (row.origin_class as OriginClass) ?? "untrusted",
        verdict: (row.verdict as DraftVerdict) ?? undefined,
        sourceKind: (row.source_kind as SourceKind) ?? undefined,
      });
    }
    return neighbors;
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
          replaces_slug, source_kind, confidence, last_verified_at,
          half_life_days, scope, owner_user, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, slug) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         tags_json = excluded.tags_json,
         file_path = excluded.file_path,
         generated_from_sha = excluded.generated_from_sha,
         generated_at = excluded.generated_at,
         generated_by_launch_id = excluded.generated_by_launch_id,
         replaces_slug = excluded.replaces_slug,
         source_kind = excluded.source_kind,
         confidence = excluded.confidence,
         last_verified_at = excluded.last_verified_at,
         half_life_days = excluded.half_life_days,
         scope = excluded.scope,
         owner_user = excluded.owner_user,
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
        draft.sourceKind ?? null,
        draft.confidence ?? null,
        draft.lastVerifiedAt ?? null,
        draft.halfLifeDays ?? null,
        draft.scope ?? null,
        draft.ownerUser ?? null,
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

  /**
   * Replaces the symbol rows of specific files, in one transaction so a lookup
   * never sees a file half-indexed. Both the full index (every file of a repo)
   * and an incremental pass (the files a commit range touched) go through here;
   * a file listed with no symbols just loses its old rows.
   */
  replaceCodeSymbols(
    projectId: string,
    repoPath: string,
    sha: string,
    files: readonly string[],
    symbols: readonly CodeSymbolRow[]
  ): void {
    const del = this.db.query(
      "DELETE FROM code_symbols WHERE project_id = ? AND repo_path = ? AND file = ?"
    );
    const ins = this.db.query(
      `INSERT INTO code_symbols (project_id, repo_path, sha, file, line, name, kind, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      for (const file of files) del.run(projectId, repoPath, file);
      for (const s of symbols) {
        ins.run(projectId, repoPath, sha, s.file, s.line, s.name, s.kind, s.signature ?? null);
      }
    })();
  }

  /** Drops every symbol row of a repo — a full re-index starts from here. */
  clearCodeSymbols(projectId: string, repoPath: string): void {
    this.db.run("DELETE FROM code_symbols WHERE project_id = ? AND repo_path = ?", [
      projectId,
      repoPath,
    ]);
  }

  /**
   * Symbols of a project whose name matches `name` exactly, then by prefix.
   * Exact matches come first because a lookup of a name that exists wants that
   * definition, not the twenty names that happen to start with it; the prefix
   * tail is what makes a partial name (an agent recalling `resolveAgent…`)
   * resolvable.
   */
  lookupSymbols(
    projectId: string,
    name: string,
    opts: { limit?: number } = {}
  ): CodeSymbolRow[] {
    const limit = opts.limit ?? 20;
    if (name.length === 0) return [];
    const rows = this.db
      .query(
        `SELECT file, line, name, kind, signature FROM code_symbols
         WHERE project_id = ? AND kind != 'file' AND (name = ? OR name LIKE ? ESCAPE '\\')
         ORDER BY (name = ?) DESC, LENGTH(name), name, file, line
         LIMIT ?`
      )
      .all(projectId, name, `${escapeLike(name)}%`, name, limit) as Array<{
      file: string;
      line: number;
      name: string;
      kind: string;
      signature: string | null;
    }>;
    return rows.map((r) => ({ ...r, signature: r.signature ?? undefined }));
  }

  /**
   * Indexed file paths of a project containing `fragment` — the path half of the
   * index, which is why every indexed file gets a `kind: 'file'` row even when it
   * exports nothing.
   */
  lookupPaths(projectId: string, fragment: string, opts: { limit?: number } = {}): string[] {
    const limit = opts.limit ?? 20;
    if (fragment.length === 0) return [];
    const rows = this.db
      .query(
        `SELECT DISTINCT file FROM code_symbols
         WHERE project_id = ? AND file LIKE ? ESCAPE '\\'
         ORDER BY LENGTH(file), file
         LIMIT ?`
      )
      .all(projectId, `%${escapeLike(fragment)}%`, limit) as Array<{ file: string }>;
    return rows.map((r) => r.file);
  }

  /** Indexed symbol/file counts, for a project (and one of its repos) or overall. */
  codeSymbolStats(projectId?: string, repoPath?: string): { symbols: number; files: number } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (projectId !== undefined) {
      clauses.push("project_id = ?");
      params.push(projectId);
    }
    if (repoPath !== undefined) {
      clauses.push("repo_path = ?");
      params.push(repoPath);
    }
    const row = this.db
      .query(
        `SELECT COUNT(*) AS symbols, COUNT(DISTINCT file) AS files FROM code_symbols
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}`
      )
      .get(...params) as { symbols: number; files: number };
    return row;
  }

  /**
   * Drops every symbol row whose (project, repo) pair is not in `keep` — the
   * repos currently configured — so a removed project, or a project whose
   * primary repo changed, stops serving symbols from the old checkout.
   */
  pruneCodeSymbols(keep: ReadonlyArray<{ projectId: string; repoPath: string }>): void {
    const kept = new Set(keep.map((k) => `${k.projectId}\0${k.repoPath}`));
    const pairs = this.db
      .query("SELECT DISTINCT project_id, repo_path FROM code_symbols")
      .all() as Array<{ project_id: string; repo_path: string }>;
    for (const pair of pairs) {
      if (!kept.has(`${pair.project_id}\0${pair.repo_path}`)) {
        this.clearCodeSymbols(pair.project_id, pair.repo_path);
      }
    }
  }

  // ---- Doc→code mentions (knowledge_code_mentions; see code-mentions.ts) ----

  /**
   * A revision of the whole symbol index that moves whenever rows are written:
   * the highest rowid. Every re-index inserts fresh rows, so it changes on any
   * pass that indexed something; O(1) on the rowid b-tree.
   */
  codeSymbolRevision(): number {
    const row = this.db.query("SELECT MAX(rowid) AS rev FROM code_symbols").get() as { rev: number | null };
    return row.rev ?? 0;
  }

  /** Indexed files of a project whose basename is exactly `fileName` (name-indexed). */
  codeFilesNamed(projectId: string, fileName: string): string[] {
    if (fileName.length === 0) return [];
    const rows = this.db
      .query(
        `SELECT DISTINCT file FROM code_symbols
         WHERE project_id = ? AND name = ? AND kind = 'file'
         ORDER BY LENGTH(file), file`
      )
      .all(projectId, fileName) as Array<{ file: string }>;
    return rows.map((r) => r.file);
  }

  /**
   * Definitions of exactly `name` (no prefix tail, unlike lookupSymbols), on the
   * name index — the per-mention lookup a mention refresh makes many of.
   */
  symbolDefinitions(projectId: string, name: string): CodeSymbolRow[] {
    if (name.length === 0) return [];
    const rows = this.db
      .query(
        `SELECT file, line, name, kind, signature FROM code_symbols
         WHERE project_id = ? AND name = ? AND kind != 'file'
         ORDER BY file, line`
      )
      .all(projectId, name) as Array<{ file: string; line: number; name: string; kind: string; signature: string | null }>;
    return rows.map((r) => ({ ...r, signature: r.signature ?? undefined }));
  }

  /**
   * Docs of a project whose mentions were last extracted from another body or
   * another code index revision (or never), with the fingerprint a refresh
   * stamps once it has re-extracted them.
   */
  docsNeedingCodeMentions(
    projectId: string,
    revision: number
  ): Array<{ id: string; body: string; fingerprint: string }> {
    return this.db
      .query(
        `SELECT k.id AS id, k.body AS body, f.fingerprint AS fingerprint
         FROM (SELECT id, COALESCE(content_hash, updated_at, '') || ':' || ? AS fingerprint
               FROM knowledge WHERE project_id = ?) f
         JOIN knowledge k ON k.id = f.id
         LEFT JOIN knowledge_code_mention_state s ON s.doc_id = f.id
         WHERE s.fingerprint IS NULL OR s.fingerprint != f.fingerprint`
      )
      .all(String(revision), projectId) as Array<{ id: string; body: string; fingerprint: string }>;
  }

  /** The recorded mentions of one doc. */
  getCodeMentions(docId: string): CodeMentionRow[] {
    const rows = this.db
      .query(
        `SELECT doc_id, project_id, kind, mention, target, file, line, name_key
         FROM knowledge_code_mentions WHERE doc_id = ? ORDER BY kind, mention`
      )
      .all(docId) as CodeMentionDbRow[];
    return rows.map(toCodeMentionRow);
  }

  /** Replaces one doc's mentions and stamps what they were extracted from, atomically. */
  replaceCodeMentions(docId: string, projectId: string, rows: readonly CodeMentionRow[], fingerprint: string): void {
    const ins = this.db.query(
      `INSERT OR REPLACE INTO knowledge_code_mentions
         (doc_id, project_id, kind, mention, target, file, line, name_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.transaction(() => {
      this.db.run("DELETE FROM knowledge_code_mentions WHERE doc_id = ?", [docId]);
      for (const r of rows) ins.run(docId, projectId, r.kind, r.mention, r.target, r.file, r.line, r.nameKey);
      this.db.run(
        `INSERT INTO knowledge_code_mention_state (doc_id, project_id, fingerprint) VALUES (?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET project_id = excluded.project_id, fingerprint = excluded.fingerprint`,
        [docId, projectId, fingerprint]
      );
    })();
  }

  /** Drops the mentions and state of a project's docs that no longer exist. */
  pruneCodeMentions(projectId: string): void {
    this.db.transaction(() => {
      for (const table of ["knowledge_code_mentions", "knowledge_code_mention_state"]) {
        this.db.run(
          `DELETE FROM ${table} WHERE project_id = ?
             AND doc_id NOT IN (SELECT id FROM knowledge WHERE project_id = ?)`,
          [projectId, projectId]
        );
      }
    })();
  }

  /**
   * Per doc, the recorded mentions no longer present in the code index: a file
   * with no `kind: 'file'` row at its path, a symbol with no definition of its
   * name anywhere in the project. A project with no indexed code at all reports
   * nothing — an index that is empty (never built, or mid full re-index) says
   * nothing about whether the code exists. Docs with nothing missing are absent.
   */
  missingCodeMentions(docIds: readonly string[]): Map<string, Array<{ kind: "file" | "symbol"; target: string }>> {
    const out = new Map<string, Array<{ kind: "file" | "symbol"; target: string }>>();
    if (docIds.length === 0) return out;
    const rows = this.db
      .query(
        `SELECT m.doc_id AS doc_id, m.kind AS kind, m.target AS target
         FROM knowledge_code_mentions m
         WHERE m.doc_id IN (${docIds.map(() => "?").join(", ")})
           AND EXISTS (SELECT 1 FROM code_symbols any_row WHERE any_row.project_id = m.project_id)
           AND NOT EXISTS (
             SELECT 1 FROM code_symbols c
             WHERE c.project_id = m.project_id AND c.name = m.name_key
               AND ((m.kind = 'file' AND c.kind = 'file' AND c.file = m.file)
                 OR (m.kind = 'symbol' AND c.kind != 'file'))
           )
         ORDER BY m.doc_id, m.kind, m.target`
      )
      .all(...docIds) as Array<{ doc_id: string; kind: "file" | "symbol"; target: string }>;
    for (const r of rows) {
      const list = out.get(r.doc_id) ?? [];
      if (!list.some((x) => x.kind === r.kind && x.target === r.target)) list.push({ kind: r.kind, target: r.target });
      out.set(r.doc_id, list);
    }
    return out;
  }

  /**
   * Docs of a project that name `path` — the file itself or a symbol defined in
   * it — and, after those, docs naming a file in the same directory. Each doc
   * appears once, at its closest match, with the mentions that matched; within
   * a match class, docs naming more of it come first.
   */
  docsMentioningPath(
    projectId: string,
    path: string,
    opts: { limit?: number } = {}
  ): Array<{ docId: string; match: "file" | "directory"; mentions: CodeMentionRow[] }> {
    const limit = opts.limit ?? 10;
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const exact = this.db
      .query(
        `SELECT doc_id, project_id, kind, mention, target, file, line, name_key
         FROM knowledge_code_mentions WHERE project_id = ? AND file = ?
         ORDER BY kind, mention`
      )
      .all(projectId, path) as CodeMentionDbRow[];
    const sameDir = this.db
      .query(
        `SELECT doc_id, project_id, kind, mention, target, file, line, name_key
         FROM knowledge_code_mentions
         WHERE project_id = ? AND file != ? AND file LIKE ? ESCAPE '\\' AND file NOT LIKE ? ESCAPE '\\'
         ORDER BY kind, mention`
      )
      .all(projectId, path, `${escapeLike(dir)}%`, `${escapeLike(dir)}%/%`) as CodeMentionDbRow[];
    const group = (rows: CodeMentionDbRow[], match: "file" | "directory") => {
      const byDoc = new Map<string, CodeMentionRow[]>();
      for (const r of rows) byDoc.set(r.doc_id, [...(byDoc.get(r.doc_id) ?? []), toCodeMentionRow(r)]);
      return [...byDoc.entries()]
        .map(([docId, mentions]) => ({ docId, match, mentions }))
        .sort((a, b) => b.mentions.length - a.mentions.length || a.docId.localeCompare(b.docId));
    };
    const fileHits = group(exact, "file");
    const seen = new Set(fileHits.map((h) => h.docId));
    const dirHits = group(sameDir, "directory").filter((h) => !seen.has(h.docId));
    return [...fileHits, ...dirHits].slice(0, limit);
  }
}

/** One recorded doc→code mention (see knowledge_code_mentions). */
export interface CodeMentionRow {
  docId: string;
  projectId: string;
  kind: "file" | "symbol";
  /** The path or symbol as the doc wrote it. */
  mention: string;
  /** The indexed file path or symbol name it resolved to. */
  target: string;
  /** The file it resolved to (a symbol's defining file). */
  file: string;
  /** A symbol's definition line; null for a file. */
  line: number | null;
  /** The code_symbols.name the existence check looks up. */
  nameKey: string;
}

interface CodeMentionDbRow {
  doc_id: string;
  project_id: string;
  kind: "file" | "symbol";
  mention: string;
  target: string;
  file: string;
  line: number | null;
  name_key: string;
}

function toCodeMentionRow(r: CodeMentionDbRow): CodeMentionRow {
  return {
    docId: r.doc_id,
    projectId: r.project_id,
    kind: r.kind,
    mention: r.mention,
    target: r.target,
    file: r.file,
    line: r.line,
    nameKey: r.name_key,
  };
}

/** One row of the HEAD-keyed symbol index. */
export interface CodeSymbolRow {
  file: string;
  line: number;
  name: string;
  kind: string;
  signature?: string;
}

/** Escapes the LIKE wildcards so a name containing `_` or `%` matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** A chunk joined to its doc's retrieval-relevant columns — the row shape both
 *  the brute-force scan and the vec KNN hydration feed into the hybrid merge. */
export interface ChunkWithEmbedding {
  chunkId: string;
  knowledgeId: string;
  projectId: string;
  slug: string;
  title: string;
  text: string;
  embedding: number[];
  originClass: OriginClass;
  sourceKind: SourceKind;
  generated: boolean;
  confidence: number | undefined;
  lastVerifiedAt: string | undefined;
  halfLifeDays: number | undefined;
  verdict: string | undefined;
}

// The single chunk⋈doc projection both getAllChunksWithEmbeddings (scan) and
// getChunksByIds (KNN hydration) select, so the two paths carry identical
// columns into the hybrid merge. The caller appends its own WHERE.
const CHUNK_EMBEDDING_SELECT = `SELECT kc.id as chunk_id, kc.knowledge_id, k.project_id, k.slug, k.title, kc.text, kc.embedding_blob, kc.embedding_json,
                k.generated_from_sha, k.origin_class, k.source_kind, k.confidence, k.last_verified_at, k.half_life_days, k.verdict
         FROM knowledge_chunks kc
         JOIN knowledge k ON k.id = kc.knowledge_id`;

interface ChunkEmbeddingRow {
  chunk_id: string;
  knowledge_id: string;
  project_id: string;
  slug: string;
  title: string;
  text: string;
  embedding_blob: Uint8Array | null;
  embedding_json: string;
  generated_from_sha: string | null;
  origin_class: string | null;
  source_kind: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  verdict: string | null;
}

function rowToChunkWithEmbedding(row: ChunkEmbeddingRow): ChunkWithEmbedding {
  return {
    chunkId: row.chunk_id,
    knowledgeId: row.knowledge_id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    text: row.text,
    embedding: chunkEmbedding(row.embedding_blob, row.embedding_json) ?? [],
    // Fail-closed: a legacy NULL reads as 'untrusted' so an embedding hit
    // gates the same as an FTS hit.
    originClass: (row.origin_class as OriginClass) ?? "untrusted",
    // Source TYPE (code vs product/spec/…), distinct from the trust class
    // above; a legacy NULL reads as the default kind. Carried so an
    // embedding hit is distinguishable by kind exactly like an FTS hit.
    sourceKind: (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND,
    // A sha means an agent wrote this and a human accepted it. Absent means
    // a human wrote it from nothing. Retrieval is allowed to care about the
    // difference; see the provenance weight in expert.ts.
    generated: !!row.generated_from_sha,
    // Confidence bookkeeping (roadmap r2/r5) so an embedding hit carries the
    // same freshness signal the FTS path does, and the injection gate in
    // expert.ts can derive current confidence uniformly across both sources.
    confidence: row.confidence ?? undefined,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    halfLifeDays: row.half_life_days ?? undefined,
    // Re-verification verdict (roadmap r5/r7) so an embedding hit gates on
    // coherence exactly like an FTS hit — a disputed/contradicted doc is held
    // out of injection regardless of which search arm surfaced it.
    verdict: row.verdict ?? undefined,
  };
}

interface DocRow {
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
  related_json: string | null;
  origin_class: string | null;
  source_session_id: string | null;
  source_kind: string | null;
  scope: string | null;
  owner_user: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  verdict: string | null;
  disputes_json: string | null;
  content_first_seen?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  superseded_by?: string | null;
}

interface HistoryRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  tags_json: string | null;
  file_path: string;
  updated_at: string;
  valid_from: string | null;
  valid_to: string;
  superseded_by: string | null;
  origin_class: string;
  source_kind: string;
  scope: string;
  owner_user: string | null;
  generated_from_sha: string | null;
}

function rowToHistory(row: HistoryRow): KnowledgeHistoryVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    body: row.body,
    tags: row.tags_json ? JSON.parse(row.tags_json) : undefined,
    filePath: row.file_path,
    updatedAt: new Date(row.updated_at),
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to,
    supersededBy: row.superseded_by ?? undefined,
    originClass: row.origin_class as OriginClass,
    sourceKind: row.source_kind as SourceKind,
    scope: row.scope as Scope,
    ownerUser: row.owner_user ?? undefined,
    generatedFromSha: row.generated_from_sha ?? undefined,
  };
}

function parsedTags(json: string | null): string[] {
  try {
    const tags = json ? JSON.parse(json) : [];
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function parsedDisputes(json: string | null): Array<{ claim?: unknown }> {
  try {
    const disputes = json ? JSON.parse(json) : [];
    return Array.isArray(disputes) ? disputes : [];
  } catch {
    return [];
  }
}

/** The hash a body's content clock is keyed on. */
export function contentHash(body: string): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** An ISO timestamp for a date string, or undefined when absent or unparseable. */
function isoTimestamp(value: string | undefined): string | undefined {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function rowToDoc(row: DocRow): KnowledgeDoc {
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
    contentFirstSeen: row.content_first_seen ?? undefined,
    related: row.related_json ? JSON.parse(row.related_json) : undefined,
    // Fail-closed read too: a NULL (legacy row before the column existed)
    // reads as 'untrusted', never as a trusted class.
    originClass: (row.origin_class as OriginClass) ?? "untrusted",
    sourceSessionId: row.source_session_id ?? undefined,
    // The default kind for a NULL (a row that predates the column) — never
    // NULL, matching the loader's default (roadmap r2).
    sourceKind: (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND,
    // 'project' for a NULL (a row predating the column) — a doc belongs to its
    // project unless promoted, matching the loader's default. owner_user stays
    // undefined unless the row names an owning user.
    scope: (row.scope as Scope) ?? "project",
    ownerUser: row.owner_user ?? undefined,
    confidence: row.confidence ?? undefined,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    halfLifeDays: row.half_life_days ?? undefined,
    verdict: (row.verdict as KnowledgeDoc["verdict"]) ?? undefined,
    disputes: row.disputes_json ? JSON.parse(row.disputes_json) : undefined,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
  };
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
  source_kind: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  scope: string | null;
  owner_user: string | null;
  updated_at: string;
  verdict: string;
  disputes_json: string | null;
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
    sourceKind: (row.source_kind as SourceKind) ?? undefined,
    confidence: row.confidence ?? undefined,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    halfLifeDays: row.half_life_days ?? undefined,
    scope: (row.scope as Scope) ?? undefined,
    ownerUser: row.owner_user ?? undefined,
    updatedAt: new Date(row.updated_at),
    verdict: (row.verdict as KnowledgeDraft["verdict"]) ?? "unverified",
    disputes: row.disputes_json ? JSON.parse(row.disputes_json) : [],
  };
}
