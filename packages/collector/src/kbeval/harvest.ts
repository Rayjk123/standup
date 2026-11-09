import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { sha256Hex, splitFor } from "./cases.js";
import { assertSafeDbCopy } from "./env.js";
import type { Category, Surface } from "./types.js";

export interface HarvestCandidate {
  id: string;
  category: Category;
  surface: Surface[];
  audience: { projectId: string };
  query: string;
  relevant: [];
  forbidden: [];
  expectEmpty: false;
  source: string;
  split: string;
  hints: { occurrences: number; topHits: string[] };
}

/** A first guess at a logged query's category, for a human to confirm while labeling. */
export function guessCategory(query: string, surface: string): Category {
  if (surface === "inject") return "inject";
  const q = query.toLowerCase();
  if (/\b(i|my|me)\b.*\b(prefer|like|want|usually|always)\b|\bmy (preference|style|workflow)\b/.test(q)) {
    return "personal";
  }
  if (/\.(ts|tsx|js|py|java|kt|go|rs)\b|\b[a-z]+[A-Z][A-Za-z]+\b|\bfunction\b|\bwhere is\b|\bwhich file\b/.test(query)) {
    return "code";
  }
  if (/\b(still|currently|now|latest|status|implemented|shipped)\b/.test(q)) return "staleness";
  return "docs";
}

interface Group {
  query: string;
  surface: string;
  project: string;
  occurrences: number;
  hits: Map<string, number>;
  source: string;
}

/**
 * Reads distinct logged queries from a DB copy (knowledge_retrievals with the
 * logged top hits) and writes them as unlabeled candidate cases, each on the
 * inject surface when it was logged there and on search otherwise. The source
 * DB is opened read-only.
 */
export function harvestCandidates(dbPath: string, outPath: string): HarvestCandidate[] {
  const db = new Database(assertSafeDbCopy(dbPath), { readonly: true });
  const groups = new Map<string, Group>();
  const groupFor = (query: string, surface: string, project: string, source: string) => {
    const key = `${surface}\u0000${project}\u0000${query}`;
    let g = groups.get(key);
    if (!g) {
      g = { query, surface, project, occurrences: 0, hits: new Map(), source };
      groups.set(key, g);
    }
    return g;
  };
  // The copy is read as-is (never migrated), so columns a later schema added
  // are read only when present.
  const hasColumn = (table: string, column: string) =>
    (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
  try {
    // A returned hit only: a gated candidate or a full-body fetch is not a
    // logged hit for its query.
    const returnedOnly = hasColumn("knowledge_retrievals", "drop_reason")
      ? "WHERE surface != 'doc_get' AND (drop_reason IS NULL OR drop_reason = 'budget')"
      : "";
    const retrievals = db
      .query(
        `SELECT query, surface, COALESCE(query_project, 'scratch') AS project, doc_project, doc_slug, rank,
                COALESCE(session_id, '') || '|' || COALESCE(launch_id, '') || '|' || created_at AS occurrence
         FROM knowledge_retrievals ${returnedOnly} ORDER BY id`
      )
      .all() as Array<{
      query: string;
      surface: string;
      project: string;
      doc_project: string;
      doc_slug: string;
      rank: number;
      occurrence: string;
    }>;
    const seenOccurrence = new Set<string>();
    for (const r of retrievals) {
      const g = groupFor(r.query, r.surface, r.project, "logged:knowledge_retrievals");
      const occ = `${r.surface}\u0000${r.project}\u0000${r.query}\u0000${r.occurrence}`;
      if (!seenOccurrence.has(occ)) {
        seenOccurrence.add(occ);
        g.occurrences++;
      }
      const ref = `${r.doc_project}/${r.doc_slug}`;
      g.hits.set(ref, Math.min(g.hits.get(ref) ?? Infinity, r.rank));
    }
  } finally {
    db.close();
  }

  const candidates: HarvestCandidate[] = [...groups.values()]
    .map((g) => {
      const id = `harvest-${sha256Hex(`${g.surface}\n${g.project}\n${g.query}`).slice(0, 12)}`;
      const surface: Surface = g.surface === "inject" ? "inject" : "search";
      return {
        id,
        category: guessCategory(g.query, g.surface),
        surface: [surface],
        audience: { projectId: g.project },
        query: g.query,
        relevant: [] as [],
        forbidden: [] as [],
        expectEmpty: false as const,
        source: g.source,
        split: splitFor(id),
        hints: {
          occurrences: g.occurrences,
          topHits: [...g.hits.entries()]
            .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
            .slice(0, 10)
            .map(([ref]) => ref),
        },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(outPath, JSON.stringify(candidates, null, 2) + "\n");
  return candidates;
}
