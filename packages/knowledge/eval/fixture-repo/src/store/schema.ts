import { EMBEDDING_DIM } from "../knowledge/embeddings.js";

/**
 * Knowledge schema. One `knowledge` row per doc; chunks and their vectors hang
 * off it. knowledge_fts is keyed by the doc id, knowledge_vec by the chunk id.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT,
  source_kind TEXT NOT NULL DEFAULT 'code',
  scope TEXT NOT NULL DEFAULT 'project',
  owner_user TEXT,
  origin_class TEXT NOT NULL DEFAULT 'untrusted',
  confidence REAL,
  last_verified_at TEXT,
  half_life_days REAL,
  verdict TEXT NOT NULL DEFAULT 'unverified',
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (doc_id, ordinal)
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${EMBEDDING_DIM}]
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (src_id, dst_id, kind)
);

CREATE TABLE IF NOT EXISTS knowledge_retrievals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  session_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL
);
`;
