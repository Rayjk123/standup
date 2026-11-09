import type { Database } from "bun:sqlite";
import type { KnowledgeDoc, SearchHit, SearchOptions } from "./types.js";
import { buildFtsQuery } from "./fts.js";
import { embedTexts, cosine } from "./embeddings.js";
import { knnSearch } from "../store/vec.js";
import { scopeAudienceSql } from "./scope.js";
import { graphRerank } from "./graph.js";

/** RRF constant. Overridable for experiments. */
export const RRF_K = Number(process.env.KNOWLEDGE_RRF_K ?? 60);

/** Per-arm weights inside the fused score and the rawScore relevance. */
export const TEXT_WEIGHT = 0.4;
export const EMBEDDING_WEIGHT = 0.6;

/** Multiplier for docs homed in the asking project. */
export const CURRENT_PROJECT_BOOST = 1.5;
/** Multiplier for docs homed in any other project (scope=global docs). */
export const OTHER_PROJECT_FACTOR = 0.75;
/** Multiplier when every query word appears in the title. */
export const TITLE_BOOST = 1.2;

/** Graph rerank runs unless a caller opts out. */
export const GRAPH_RERANK_DEFAULT = true;

const RECALL_K = 40;

interface ArmHit {
  docId: string;
  rank: number;
  score: number;
}

/**
 * Weighted RRF over the text and embedding arms:
 *   TEXT_WEIGHT / (RRF_K + textRank) + EMBEDDING_WEIGHT / (RRF_K + vecRank)
 * A doc missing from an arm contributes nothing for that arm.
 */
export function fuseRrf(textHits: ArmHit[], vecHits: ArmHit[]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const h of textHits) {
    fused.set(h.docId, (fused.get(h.docId) ?? 0) + TEXT_WEIGHT / (RRF_K + h.rank));
  }
  for (const h of vecHits) {
    fused.set(h.docId, (fused.get(h.docId) ?? 0) + EMBEDDING_WEIGHT / (RRF_K + h.rank));
  }
  return fused;
}

/**
 * The relevance shown to agents: 0.4 x text score normalized to the batch's
 * best text hit, plus 0.6 x cosine. Because of the batch normalization the best
 * lexical hit in any batch scores at least 0.4.
 */
export function rawScore(textScore: number, bestTextScore: number, cos: number): number {
  const textNorm = bestTextScore > 0 ? textScore / bestTextScore : 0;
  return TEXT_WEIGHT * textNorm + EMBEDDING_WEIGHT * cos;
}

export async function searchKnowledge(db: Database, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const limit = opts.limit ?? 8;
  const scope = scopeAudienceSql(opts.audience, "k");
  const kindSql = opts.kinds?.length ? `AND k.source_kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
  const projectSql = opts.corpus === "project" ? "AND k.project_id = ?" : "";
  const extra = [...(opts.kinds ?? []), ...(opts.corpus === "project" ? [opts.audience.projectId] : [])];

  const fts = buildFtsQuery(query);
  const textRows = fts
    ? (db
        .query(
          `SELECT f.id AS docId, -bm25(knowledge_fts) AS score
             FROM knowledge_fts f JOIN knowledge k ON k.id = f.id
            WHERE knowledge_fts MATCH ? AND ${scope.sql} ${kindSql} ${projectSql}
            ORDER BY score DESC LIMIT ?`
        )
        .all(fts, ...scope.params, ...extra, RECALL_K) as { docId: string; score: number }[])
    : [];
  const textHits: ArmHit[] = textRows.map((r, i) => ({ docId: r.docId, rank: i + 1, score: r.score }));

  const [qv] = await embedTexts([query]);
  const knn = knnSearch(db, qv, RECALL_K, scope.sql, scope.params);
  const bestByDoc = new Map<string, number>();
  for (const row of knn) {
    const cos = 1 - row.distance;
    if (cos > (bestByDoc.get(row.docId) ?? -1)) bestByDoc.set(row.docId, cos);
  }
  const vecHits: ArmHit[] = [...bestByDoc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([docId, score], i) => ({ docId, rank: i + 1, score }));

  const fused = fuseRrf(textHits, vecHits);
  const bestText = textHits[0]?.score ?? 0;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  const hits: SearchHit[] = [];
  for (const [docId, base] of fused) {
    const doc = loadDoc(db, docId);
    if (!doc) continue;
    let score = base;
    score *= doc.projectId === opts.audience.projectId ? CURRENT_PROJECT_BOOST : OTHER_PROJECT_FACTOR;
    if (words.every((w) => doc.title.toLowerCase().includes(w))) score *= TITLE_BOOST;
    const textScore = textHits.find((h) => h.docId === docId)?.score ?? 0;
    hits.push({
      doc,
      score,
      rawScore: rawScore(textScore, bestText, bestByDoc.get(docId) ?? 0),
      excerpt: doc.body.slice(0, 240),
    });
  }
  hits.sort((a, b) => b.score - a.score);

  const reranked = (opts.graphRerank ?? GRAPH_RERANK_DEFAULT) ? graphRerank(db, hits) : hits;
  return reranked.slice(0, limit);
}

function loadDoc(db: Database, id: string): KnowledgeDoc | undefined {
  const row = db.query(`SELECT * FROM knowledge WHERE id = ?`).get(id) as Record<string, unknown> | null;
  if (!row) return undefined;
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    slug: row.slug as string,
    title: row.title as string,
    body: row.body as string,
    tags: row.tags_json ? JSON.parse(row.tags_json as string) : undefined,
    sourceKind: row.source_kind as KnowledgeDoc["sourceKind"],
    scope: row.scope as KnowledgeDoc["scope"],
    ownerUser: (row.owner_user as string | null) ?? undefined,
    originClass: row.origin_class as KnowledgeDoc["originClass"],
    confidence: (row.confidence as number | null) ?? undefined,
    lastVerifiedAt: (row.last_verified_at as string | null) ?? undefined,
    halfLifeDays: (row.half_life_days as number | null) ?? undefined,
    verdict: row.verdict as KnowledgeDoc["verdict"],
    updatedAt: new Date(row.updated_at as string),
  };
}

export { cosine };
