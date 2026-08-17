import type { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { generateEmbedding, type EmbeddingProvider } from "./embeddings.js";

export interface SearchResult {
  slug: string;
  title: string;
  excerpt: string;
  score: number;
  source: "text" | "embedding";
  /**
   * True when an agent drafted this doc and a human accepted it, false when a
   * human wrote it from nothing. Keyed off `generated_from_sha` being present,
   * which means it tracks the same line staleness does: a doc accepted by
   * merging counts as the human's, a doc they merely edited afterwards stays
   * generated. See writeKnowledgeFile for why those two go different ways.
   *
   * Exposed because whether provenance should change ranking is a question
   * worth answering with numbers rather than assuming — the weight that
   * consumes this lives in the caller, not here.
   */
  generated: boolean;
}

export interface SearchOptions {
  limit?: number;
  textWeight?: number;
  embeddingWeight?: number;
}

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  limit: 5,
  textWeight: 0.4,
  embeddingWeight: 0.6,
};

export async function searchKnowledge(
  db: Database,
  projectId: string,
  query: string,
  embeddingProvider: EmbeddingProvider | null,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const store = new KnowledgeStore(db);

  // Text search using FTS5
  const textResults = searchText(db, projectId, query, opts.limit * 2);

  // Embedding search if provider available
  let embeddingResults: SearchResult[] = [];
  if (embeddingProvider) {
    embeddingResults = await searchEmbeddings(
      store,
      projectId,
      query,
      embeddingProvider,
      opts.limit * 2
    );
  }

  // Merge and deduplicate results
  const merged = mergeResults(
    textResults,
    embeddingResults,
    opts.textWeight,
    opts.embeddingWeight
  );

  return merged.slice(0, opts.limit);
}

// FTS5 treats space-separated terms as an implicit AND, which is far too
// strict for a natural-language question — one word absent from every doc
// (e.g. "business" in "what is the business goal") kills the whole match,
// even when other terms in the same query clearly hit. Quote each term and
// join with OR instead: any term matching is enough to surface a result,
// and bm25() still ranks documents matching more/rarer terms higher.
function buildOrQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""').trim())
    .filter(Boolean);

  if (terms.length === 0) return '""';

  return terms.map((t) => `"${t}"`).join(" OR ");
}

function searchText(
  db: Database,
  projectId: string,
  query: string,
  limit: number
): SearchResult[] {
  const ftsQuery = buildOrQuery(query);

  const rows = db
    .query(
      `SELECT k.slug, k.title, k.body, k.generated_from_sha, bm25(knowledge_fts) as score
       FROM knowledge_fts
       JOIN knowledge k ON k.id = knowledge_fts.id
       WHERE knowledge_fts MATCH ? AND k.project_id = ?
       ORDER BY score
       LIMIT ?`
    )
    .all(ftsQuery, projectId, limit) as Array<{
    slug: string;
    title: string;
    body: string;
    generated_from_sha: string | null;
    score: number;
  }>;

  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    excerpt: extractExcerpt(row.body, query),
    score: Math.abs(row.score), // BM25 returns negative scores
    source: "text" as const,
    generated: !!row.generated_from_sha,
  }));
}

async function searchEmbeddings(
  store: KnowledgeStore,
  projectId: string,
  query: string,
  provider: EmbeddingProvider,
  limit: number
): Promise<SearchResult[]> {
  // Get query embedding
  const queryEmbedding = await generateEmbedding(query, provider);
  if (!queryEmbedding) return [];

  // Get all chunks with embeddings
  const chunks = store.getAllChunksWithEmbeddings(projectId);
  if (chunks.length === 0) return [];

  // Compute cosine similarity for each chunk
  const scored = chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top results and dedupe by document
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const chunk of scored) {
    if (seen.has(chunk.knowledgeId)) continue;
    seen.add(chunk.knowledgeId);

    results.push({
      slug: chunk.slug,
      title: chunk.title,
      excerpt: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? "..." : ""),
      score: chunk.score,
      source: "embedding",
      generated: chunk.generated,
    });

    if (results.length >= limit) break;
  }

  return results;
}

function mergeResults(
  textResults: SearchResult[],
  embeddingResults: SearchResult[],
  textWeight: number,
  embeddingWeight: number
): SearchResult[] {
  const bySlug = new Map<string, SearchResult & { textScore: number; embeddingScore: number }>();

  // Normalize text scores (BM25 scores vary widely)
  const maxTextScore = Math.max(...textResults.map((r) => r.score), 1);
  for (const result of textResults) {
    const normalized = result.score / maxTextScore;
    bySlug.set(result.slug, {
      ...result,
      textScore: normalized,
      embeddingScore: 0,
    });
  }

  // Add embedding scores
  for (const result of embeddingResults) {
    const existing = bySlug.get(result.slug);
    if (existing) {
      existing.embeddingScore = result.score;
    } else {
      bySlug.set(result.slug, {
        ...result,
        textScore: 0,
        embeddingScore: result.score,
      });
    }
  }

  // Compute final scores
  const merged = Array.from(bySlug.values()).map((r) => ({
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    score: r.textScore * textWeight + r.embeddingScore * embeddingWeight,
    source: r.textScore > r.embeddingScore ? ("text" as const) : ("embedding" as const),
    // A property of the document, not of how it was found, so the two halves
    // of a merged hit always agree and there is nothing to reconcile here.
    generated: r.generated,
  }));

  // Sort by final score
  merged.sort((a, b) => b.score - a.score);

  return merged;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function extractExcerpt(body: string, query: string, maxLength = 200): string {
  const queryLower = query.toLowerCase();
  const bodyLower = body.toLowerCase();

  // Find first occurrence of any query word
  const words = queryLower.split(/\s+/);
  let bestIndex = 0;

  for (const word of words) {
    const idx = bodyLower.indexOf(word);
    if (idx !== -1) {
      bestIndex = Math.max(0, idx - 50);
      break;
    }
  }

  const excerpt = body.slice(bestIndex, bestIndex + maxLength);
  const prefix = bestIndex > 0 ? "..." : "";
  const suffix = bestIndex + maxLength < body.length ? "..." : "";

  return prefix + excerpt.trim() + suffix;
}
