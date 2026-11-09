import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import {
  DEFAULT_SOURCE_KIND,
  extractExcerpt,
  isOriginEligibleForInjection,
  scopeAudienceSql,
  type OriginClass,
  type ScopeAudience,
  type SearchResult,
  type SourceKind,
} from "@standup/knowledge";

/**
 * A doc rendered into a launch's injection block; `namedInTask` marks a doc the
 * task named by slug, and `disputeClaim` is the short claim a disputed doc's
 * re-verification refuted, quoted in its marker. `landed` is the marker of a
 * doc whose not-merged claims have landed (landedClaimMarker).
 */
export type InjectedDoc = SearchResult & { namedInTask?: boolean; disputeClaim?: string; landed?: string };

/** How many docs a task can pin into its injection blocks by naming them. */
export const MAX_NAMED_PINS = 3;

/** Upper bound on the candidate tokens one task contributes to the lookup. */
const MAX_NAMED_TOKENS = 64;

/** A kebab-case word with at least two hyphens, e.g. `billing-platform-overview`. */
const BARE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/;

/** Any slug-shaped word, accepted when the task wraps it in backticks. */
const QUOTED_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

/** Verdicts that hold a named doc out of injection: it has lost to, or conflicts with, another doc. */
const EXCLUDED_VERDICTS = new Set(["contradicted", "superseded"]);

/**
 * The slug-shaped tokens a task names, in the order it first names them: any
 * slug wrapped in backticks, and any bare kebab-case word with at least two
 * hyphens. Only candidates — a token names a doc only when a doc with exactly
 * that slug exists in the caller's scope (see findNamedDocs).
 */
export function namedSlugTokens(text: string): string[] {
  const found: Array<{ slug: string; at: number }> = [];
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const slug = m[1].toLowerCase();
    if (QUOTED_SLUG.test(slug)) found.push({ slug, at: m.index ?? 0 });
  }
  for (const m of text.matchAll(/\S+/g)) {
    const slug = m[0].replace(/^[`'"(<[{]+|[`'")>\]},.;:!?]+$/g, "").toLowerCase();
    if (BARE_SLUG.test(slug)) found.push({ slug, at: m.index ?? 0 });
  }
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const { slug } of found.sort((a, b) => a.at - b.at)) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    tokens.push(slug);
    if (tokens.length >= MAX_NAMED_TOKENS) break;
  }
  return tokens;
}

interface NamedRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  generated_from_sha: string | null;
  origin_class: string | null;
  source_kind: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  verdict: string | null;
  scope: string | null;
  tags_json: string | null;
}

function supersededByTag(tagsJson: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson) as unknown;
    return Array.isArray(tags) && tags.includes("superseded");
  } catch {
    return false;
  }
}

/**
 * The docs a task names by slug (see namedSlugTokens), at most `limit`, in the
 * order the task names them. One query against the knowledge table, gated by
 * `audience` through scopeAudienceSql — the same strict scope gate the ranked
 * retrieval applies — and by nothing else the ranked retrieval applies: no
 * source-kind filter, no corpus partition, no relevance floor. A slug held by
 * several in-scope docs resolves to one, preferring the audience project, then
 * its related projects, then the global corpus.
 *
 * A contradicted or superseded doc is skipped, as is one whose origin may not
 * be auto-injected. A disputed doc is kept; the injection block renders its
 * dispute banner. Never throws: a failed lookup names nothing.
 */
export function findNamedDocs(
  db: Database,
  text: string,
  audience: ScopeAudience,
  limit: number = MAX_NAMED_PINS
): InjectedDoc[] {
  const tokens = namedSlugTokens(text);
  if (tokens.length === 0 || limit <= 0) return [];
  try {
    const gate = scopeAudienceSql(audience, "k");
    const rows = db
      .query(
        `SELECT k.id, k.project_id, k.slug, k.title, k.body, k.generated_from_sha, k.origin_class,
                k.source_kind, k.confidence, k.last_verified_at, k.half_life_days, k.verdict,
                k.scope, k.tags_json
         FROM knowledge k
         WHERE k.slug IN (${tokens.map(() => "?").join(", ")}) AND ${gate.sql}`
      )
      .all(...tokens, ...gate.params) as NamedRow[];
    const related = audience.relatedProjectIds ?? [];
    const homeRank = (projectId: string): number =>
      projectId === audience.projectId ? 0 : related.includes(projectId) ? 1 : projectId === GLOBAL_PROJECT_ID ? 2 : 3;
    const bySlug = new Map<string, NamedRow>();
    for (const row of rows) {
      if (row.verdict && EXCLUDED_VERDICTS.has(row.verdict)) continue;
      if (supersededByTag(row.tags_json)) continue;
      if (!isOriginEligibleForInjection((row.origin_class as OriginClass) ?? "untrusted")) continue;
      const held = bySlug.get(row.slug);
      if (
        !held ||
        homeRank(row.project_id) < homeRank(held.project_id) ||
        (homeRank(row.project_id) === homeRank(held.project_id) && row.id < held.id)
      ) {
        bySlug.set(row.slug, row);
      }
    }
    const docs: InjectedDoc[] = [];
    for (const slug of tokens) {
      const row = bySlug.get(slug);
      if (!row) continue;
      docs.push(namedRowToDoc(row, text));
      if (docs.length >= limit) break;
    }
    return docs;
  } catch {
    return [];
  }
}

function namedRowToDoc(row: NamedRow, text: string): InjectedDoc {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    excerpt: extractExcerpt(row.body, text),
    score: 0,
    source: "text",
    originClass: (row.origin_class as OriginClass) ?? "untrusted",
    sourceKind: (row.source_kind as SourceKind | null) ?? DEFAULT_SOURCE_KIND,
    generated: row.generated_from_sha !== null,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.last_verified_at !== null ? { lastVerifiedAt: row.last_verified_at } : {}),
    ...(row.half_life_days !== null ? { halfLifeDays: row.half_life_days } : {}),
    ...(row.verdict !== null ? { verdict: row.verdict as SearchResult["verdict"] } : {}),
    ...(row.scope !== null ? { scope: row.scope as SearchResult["scope"] } : {}),
    namedInTask: true,
  };
}
