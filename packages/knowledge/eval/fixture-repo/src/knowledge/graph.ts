import type { Database } from "bun:sqlite";
import type { KnowledgeDoc, SearchHit } from "./types.js";

/** Minimum cosine between two docs' mean vectors for a similarity edge. */
export const SIMILARITY_EDGE_GATE = 0.6;

/** How much a neighbour's fused score is lent to a hit during rerank. */
const NEIGHBOUR_WEIGHT = 0.15;

export type EdgeKind = "tag" | "session" | "contradiction" | "similarity" | "related";

export interface Edge {
  src: string;
  dst: string;
  kind: EdgeKind;
  weight: number;
}

/**
 * Builds doc-to-doc edges: shared tags (co-citation), same authoring session,
 * contradiction verdicts, semantic similarity above SIMILARITY_EDGE_GATE, and
 * explicit `related:` front matter. Bodies are not parsed for links.
 */
export function buildEdges(
  docs: KnowledgeDoc[],
  sessions: Map<string, string>,
  related: Map<string, string[]>,
  similarity: (a: string, b: string) => number
): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i];
      const b = docs[j];
      const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
      if (shared.length > 0) edges.push({ src: a.id, dst: b.id, kind: "tag", weight: shared.length });
      if (sessions.get(a.id) && sessions.get(a.id) === sessions.get(b.id)) {
        edges.push({ src: a.id, dst: b.id, kind: "session", weight: 1 });
      }
      if (a.verdict === "contradicted" && b.verdict === "contradicted") {
        edges.push({ src: a.id, dst: b.id, kind: "contradiction", weight: 1 });
      }
      const score = similarity(a.id, b.id);
      if (score >= SIMILARITY_EDGE_GATE) edges.push({ src: a.id, dst: b.id, kind: "similarity", weight: score });
    }
  }
  for (const [src, slugs] of related) {
    for (const dst of slugs) edges.push({ src, dst, kind: "related", weight: 1 });
  }
  return edges;
}

/** Adds a share of each neighbour's score to a hit, then re-sorts. */
export function graphRerank(db: Database, hits: SearchHit[]): SearchHit[] {
  const byId = new Map(hits.map((h) => [h.doc.id, h]));
  const boosted = hits.map((h) => {
    const neighbours = db
      .query(`SELECT dst_id AS id, weight FROM knowledge_edges WHERE src_id = ?
              UNION ALL SELECT src_id AS id, weight FROM knowledge_edges WHERE dst_id = ?`)
      .all(h.doc.id, h.doc.id) as { id: string; weight: number }[];
    const lent = neighbours.reduce((sum, n) => sum + (byId.get(n.id)?.score ?? 0) * NEIGHBOUR_WEIGHT, 0);
    return { ...h, score: h.score + lent };
  });
  return boosted.sort((a, b) => b.score - a.score);
}
