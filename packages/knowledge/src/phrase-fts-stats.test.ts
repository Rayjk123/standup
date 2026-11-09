import { expect, test, describe, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { phraseFtsStats, queryPhrases, type PhraseFtsStats } from "./search.js";
import { isStopword } from "./terms.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * phraseFtsStats answers candidateFacts' per-phrase FTS questions in one
 * statement. The oracle below is the one-query-per-fact form it replaces
 * (each query run on its own, a rejected MATCH reading as no rows); the batched
 * form must return exactly what the oracle does.
 */

function oraclePhraseFtsStats(db: Database, phrases: readonly string[][], ids: readonly string[]): PhraseFtsStats {
  const inIds = `(${ids.map(() => "?").join(", ")})`;
  const match = (phrase: readonly string[]) => `"${phrase.join(" ")}"`;
  const rows = <T>(sql: string, params: string[]): T[] => {
    try {
      return db.query(sql).all(...params) as T[];
    } catch {
      return [];
    }
  };
  const indexed = rows<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_fts", [])[0]?.n ?? 0;
  return {
    indexed,
    perPhrase: phrases.map((phrase) => ({
      matching:
        rows<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_fts WHERE knowledge_fts MATCH ?", [match(phrase)])[0]
          ?.n ?? 0,
      hits: new Set(
        rows<{ id: string }>(`SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND id IN ${inIds}`, [
          match(phrase),
          ...ids,
        ]).map((r) => r.id)
      ),
    })),
  };
}

const CORPUS: Array<[id: string, title: string, body: string, tags?: string[]]> = [
  ["retry", "Retry policy", "Requests retry with exponential backoff and jitter up to five attempts."],
  ["deploy", "Deploy runbook", "Deploy through the pipeline; roll back with the previous artifact.", ["ops"]],
  ["scope", "Scope gate", "The scope gate filters user-scoped docs out of other users' searches."],
  ["embed", "Embedding provider", "The embedding provider is configured with EMBEDDING_PROVIDER; ollama or bedrock."],
  ["graph", "Graph edges", "Related edges come from frontmatter and wikilinks; the compile pass derives them."],
  ["backoff", "Backoff tuning", "Backoff jitter keeps retry storms from synchronizing across workers."],
  ["fts", "Full-text index", "knowledge_fts is an FTS5 table with porter stemming over title, body and tags."],
  ["vec", "sqlite-vec mirror", "The vec0 mirror stores float32 embeddings keyed by chunk rowid.", ["vector"]],
];

function fixture(): { db: Database; ids: string[] } {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  for (const [id, title, body, tags] of CORPUS) {
    const doc: KnowledgeDoc = {
      id,
      projectId: "proj",
      slug: id,
      title,
      body,
      tags,
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: `/x/${id}.md`,
      originClass: "owner",
    };
    store.upsertDoc(doc);
  }
  return { db, ids: CORPUS.map(([id]) => id) };
}

/** The phrases candidateFacts scores for a query: queryPhrases minus stopword-only ones. */
const scoredPhrases = (query: string) =>
  queryPhrases(query).filter((phrase) => !phrase.every((piece) => isStopword(piece)));

describe("phraseFtsStats matches the per-phrase queries", () => {
  const queries = [
    "retry backoff jitter",
    "how do I deploy and roll back",
    "scope gate user docs",
    "EMBEDDING_PROVIDER ollama",
    "sqlite-vec float32 rowid",
    "wikilinks frontmatter compile",
    "retries backing off",
    "nothing in this corpus matches zebra",
    "the and of",
    "fts5 porter stemming title body tags vector ops",
    "retry",
  ];
  const { db, ids } = fixture();

  test.each(queries)("%s", (query) => {
    const phrases = scoredPhrases(query);
    for (const candidateIds of [ids, ids.slice(0, 3), ["retry", "backoff"], ["missing-id"]]) {
      expect(phraseFtsStats(db, phrases, candidateIds)).toEqual(oraclePhraseFtsStats(db, phrases, candidateIds));
    }
  });

  test("no phrases still reports the index size", () => {
    expect(phraseFtsStats(db, [], ids)).toEqual({ indexed: CORPUS.length, perPhrase: [] });
  });

  test("runs one statement however many phrases the query has", () => {
    const phrases = scoredPhrases("retry backoff jitter deploy pipeline scope gate embedding graph");
    const query = spyOn(db, "query");
    try {
      phraseFtsStats(db, phrases, ids);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
  });

  test("a phrase FTS5 rejects reads as no rows for that phrase alone", () => {
    const phrases = [["retry"], ['bad"quote'], ["backoff"]];
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const batched = phraseFtsStats(db, phrases, ids);
      expect(batched).toEqual(oraclePhraseFtsStats(db, phrases, ids));
      expect(batched.perPhrase[1]).toEqual({ matching: 0, hits: new Set() });
      expect(batched.perPhrase[0]!.matching).toBeGreaterThan(0);
    } finally {
      error.mockRestore();
    }
  });
});
