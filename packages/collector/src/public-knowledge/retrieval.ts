import type { Database } from "bun:sqlite";
import {
  DEFAULT_COSINE_BAND,
  EXCERPT_MAX_LENGTH,
  bm25PhraseCeiling,
  compareContradiction,
  contradictionSide,
  cosineSimilarity,
  docInAudience,
  extractExcerpt,
  isConfident,
  isInformativePhrase,
  isStopword,
  layerOf,
  parseContradictsClaim,
  queryPhrases,
  relevanceOf,
  relevanceSignals,
  trustMultiplier,
  type ConfidenceSurface,
  type ContradictionState,
  type DraftVerdict,
  type KnowledgeStore,
  type OriginClass,
  type Scope,
  type ScopeAudience,
  type SearchResult,
  type SourceKind,
} from "@standup/knowledge";

/**
 * Retrieval for the public knowledge API, whose every observable output — which
 * docs match, their order, their scores, and whether /ask answers — is a
 * function of the served corpus and the query alone.
 *
 * The backend's own search can't give that: FTS5's bm25 takes its idf and
 * average length over the whole index, withheld projects and personal docs
 * included, and the candidate windows are cut by that score, so a private doc
 * containing a query word moves a shareable doc's score, its rank and whether
 * it clears the relevance floor. Here:
 *
 * - Membership is boolean. Each query phrase is matched through FTS5 with no
 *   ranking and no LIMIT, and the matching ids are intersected with the served
 *   corpus in memory, so a withheld doc never takes a candidate slot. Past
 *   PUBLIC_CANDIDATE_CAP matches, the most recently updated are kept — an order
 *   no statistic decides.
 * - Scoring is BM25 whose N, document frequencies and average length are
 *   counted over the served corpus only; term frequency and length come from
 *   the doc's own text. The relevance the confidence floors read is the shared
 *   relevance formula (relevanceOf) over those numbers.
 * - The semantic arm, when the host embeds, scores every chunk of every served
 *   doc by cosine — a number with no corpus statistics — against the fixed
 *   default cosine band, not a band calibrated over the whole index.
 */

/** The most matching docs scored per arm and query; past it, the most recently updated (lexical) or nearest (semantic) are kept. */
export const PUBLIC_CANDIDATE_CAP = 500;

/** The most query phrases a public query is matched on; the rest of a longer query is ignored. */
const MAX_PHRASES = 24;

/** FTS5's bm25 constants, so a public score reads on the scale the relevance formula was calibrated on. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** A doc's fields a served-corpus check reads. */
export interface ServedCandidate {
  projectId: string;
  slug: string;
  scope?: string;
  sourceKind?: string;
  originClass?: OriginClass;
  verdict?: string;
}

/** What public retrieval reads from. */
export interface PublicRetrievalDeps {
  db: Database;
  knowledgeStore: KnowledgeStore;
  /** Embeds a query for the semantic arm; omitted, or answering null, retrieval is lexical only. */
  embedQuery?: (text: string) => Promise<number[] | null>;
}

/** One public retrieval. */
export interface PublicSearchRequest {
  query: string;
  /** The docs a public read may return and the only docs statistics are counted over. */
  served: (doc: ServedCandidate) => boolean;
  /** Narrows candidates (not statistics) to an audience: a named project plus the global set. */
  audience?: ScopeAudience;
  /** Narrows candidates (not statistics) to one project's own docs. */
  onlyProject?: string;
  limit: number;
  /** Puts the hits confident for this surface first, `limit` of them, then `lowConfidenceLimit` below it. */
  confidentFor?: ConfidenceSurface;
  lowConfidenceLimit?: number;
  /** What every returned text goes through. */
  redact: (text: string) => string;
  now?: Date;
}

interface CorpusRow {
  id: string;
  project_id: string;
  slug: string;
  scope: string | null;
  source_kind: string | null;
  origin_class: string | null;
  verdict: string | null;
  owner_user: string | null;
  updated_at: string | null;
  generated_at: string | null;
  generated_from_sha: string | null;
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  disputes_json: string | null;
  len: number;
}

interface TextRow {
  id: string;
  title: string;
  body: string;
  tags_json: string | null;
}

const asCandidate = (row: CorpusRow): ServedCandidate & { ownerUser?: string } => ({
  projectId: row.project_id,
  slug: row.slug,
  scope: row.scope ?? "project",
  ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
  originClass: (row.origin_class as OriginClass | null) ?? "untrusted",
  ...(row.verdict ? { verdict: row.verdict } : {}),
  ...(row.owner_user ? { ownerUser: row.owner_user } : {}),
});

/** The ids FTS5 matches for one phrase, unranked and uncapped; a phrase FTS5 rejects matches nothing. */
function phraseMatches(db: Database, phrase: readonly string[]): string[] {
  try {
    return (db.query("SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ?").all(`"${phrase.join(" ")}"`) as Array<{ id: string }>).map((r) => r.id);
  } catch (err) {
    console.error("[public-kb] FTS phrase match failed:", err);
    return [];
  }
}

/** A text's words, lowercased, split as the FTS tokenizer splits them. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/**
 * How often a phrase occurs in a doc's words: a word matches a phrase piece
 * equal to it or extending it (`checklists` for `checklist`). A doc FTS5
 * matched counts at least once, since its stemmer may have matched a form this
 * doesn't.
 */
function phraseFrequency(tokens: readonly string[], phrase: readonly string[]): number {
  const pieces = phrase.map((p) => p.toLowerCase());
  let count = 0;
  for (let i = 0; i + pieces.length <= tokens.length; i++) {
    if (pieces.every((p, j) => tokens[i + j]!.startsWith(p))) count++;
  }
  return Math.max(1, count);
}

function rowsByIds<T>(db: Database, sql: (inIds: string) => string, ids: readonly string[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    out.push(...(db.query(sql(`(${batch.map(() => "?").join(", ")})`)).all(...batch) as T[]));
  }
  return out;
}

/** The slugs a doc's `Contradicts <slug>` disputes name. */
function disputeTargets(disputesJson: string | null): string[] {
  if (!disputesJson) return [];
  try {
    const disputes = JSON.parse(disputesJson) as Array<{ claim?: unknown }>;
    if (!Array.isArray(disputes)) return [];
    return [...new Set(disputes.map((d) => (typeof d?.claim === "string" ? parseContradictsClaim(d.claim) : null)).filter((s): s is string => s !== null))];
  } catch {
    return [];
  }
}

const writtenAtOf = (row: CorpusRow): string | undefined => row.generated_at ?? row.updated_at ?? undefined;

/**
 * Where a contradicted doc stands against the served docs it contradicts; a
 * counterpart outside the served corpus neither counts nor is named.
 */
function contradictionOf(row: CorpusRow, corpusBySlug: ReadonlyMap<string, CorpusRow>, now: Date): ContradictionState {
  const party = (r: CorpusRow) => ({
    confidence: r.confidence ?? undefined,
    lastVerifiedAt: r.last_verified_at ?? undefined,
    halfLifeDays: r.half_life_days ?? undefined,
    writtenAt: writtenAtOf(r),
    verdict: r.verdict ?? undefined,
    originClass: r.origin_class ?? undefined,
  });
  const counterparts: string[] = [];
  const outcomes: number[] = [];
  for (const slug of disputeTargets(row.disputes_json)) {
    const other = corpusBySlug.get(`${row.project_id}/${slug}`);
    if (!other) continue;
    counterparts.push(`${row.project_id}/${slug}`);
    outcomes.push(compareContradiction(party(row), party(other), now));
  }
  return { side: contradictionSide(outcomes), counterparts };
}

/**
 * The excerpt of an embedding match: the lines of the redacted body its
 * matched chunk spans. The chunk is placed by its first line the redaction
 * leaves unchanged (an anchor), and spans as many lines as the chunk has; the
 * cut is made in the already-redacted body at line boundaries, so no fragment
 * of a secret straddling the chunk's edge survives. Null when the chunk can't
 * be placed.
 */
export function chunkExcerpt(body: string, chunk: string, redact: (text: string) => string, maxLength = EXCERPT_MAX_LENGTH): string | null {
  const chunkLines = chunk.trim().split("\n");
  const anchorLine = chunkLines.findIndex((l) => l.trim().length >= 8 && redact(l) === l);
  if (anchorLine === -1) return null;
  const anchor = chunkLines[anchorLine]!;
  const lines = redact(body).split("\n");
  // The chunk's own occurrence of its anchor: as many earlier occurrences are skipped as precede the chunk in the raw body.
  const rawAt = body.indexOf(chunk.trim());
  const rawLine = rawAt === -1 ? -1 : body.slice(0, rawAt).split("\n").length - 1 + anchorLine;
  const rawLines = body.split("\n");
  let skip = 0;
  for (let i = 0; i < rawLine; i++) if (rawLines[i]!.includes(anchor)) skip++;
  let at = -1;
  for (let i = 0, seen = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(anchor)) continue;
    if (at === -1) at = i;
    if (seen++ === skip) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const start = Math.max(0, at - anchorLine);
  const end = Math.min(lines.length, start + chunkLines.length);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines.slice(start, end)) {
    if (kept.length > 0 && length + line.length + 1 > maxLength) break;
    kept.push(line);
    length += line.length + 1;
  }
  const text = kept.join("\n").trim();
  return (start > 0 ? "…\n" : "") + text + (start + kept.length < lines.length ? "\n…" : "");
}

/** Public retrieval over a knowledge index (see the module comment). */
export function publicRetrieval(deps: PublicRetrievalDeps) {
  const { db, knowledgeStore } = deps;

  return async function publicSearch(req: PublicSearchRequest): Promise<SearchResult[]> {
    const now = req.now ?? new Date();
    // The served corpus: every statistic below is counted over it alone.
    const corpus = new Map<string, CorpusRow>();
    for (const row of db
      .query(
        `SELECT id, project_id, slug, scope, source_kind, origin_class, verdict, owner_user, updated_at, generated_at,
                generated_from_sha, confidence, last_verified_at, half_life_days, disputes_json,
                length(title) + length(body) AS len
         FROM knowledge`
      )
      .all() as CorpusRow[]) {
      if (req.served(asCandidate(row))) corpus.set(row.id, row);
    }
    if (corpus.size === 0) return [];
    const corpusBySlug = new Map([...corpus.values()].map((r) => [`${r.project_id}/${r.slug}`, r] as const));
    let total = 0;
    for (const r of corpus.values()) total += r.len;
    const avgLength = Math.max(1, total / corpus.size);

    // Which docs a request may return: the served corpus, narrowed by audience and project.
    const eligible = (row: CorpusRow) =>
      (req.onlyProject === undefined || row.project_id === req.onlyProject) && (req.audience === undefined || docInAudience(asCandidate(row), req.audience));

    // Lexical membership and document frequencies, per phrase.
    const phrases = queryPhrases(req.query).slice(0, MAX_PHRASES);
    const matchedBy = new Map<string, Set<number>>();
    const df: number[] = [];
    phrases.forEach((phrase, i) => {
      let n = 0;
      for (const id of new Set(phraseMatches(db, phrase))) {
        const row = corpus.get(id);
        if (!row) continue;
        n++;
        if (!eligible(row)) continue;
        let set = matchedBy.get(id);
        if (!set) matchedBy.set(id, (set = new Set()));
        set.add(i);
      }
      df.push(n);
    });
    const lexical = [...matchedBy.keys()]
      .sort((a, b) => (corpus.get(b)!.updated_at ?? "").localeCompare(corpus.get(a)!.updated_at ?? "") || a.localeCompare(b))
      .slice(0, PUBLIC_CANDIDATE_CAP);

    // The semantic arm: every chunk of every eligible served doc, scored by cosine.
    const best = new Map<string, { cosine: number; text: string }>();
    let semanticOn = false;
    if (deps.embedQuery && !knowledgeStore.vectorSearchSuspended()) {
      const vector = await deps.embedQuery(req.query);
      if (vector) {
        semanticOn = true;
        for (const chunk of knowledgeStore.getAllChunksWithEmbeddings()) {
          const row = corpus.get(chunk.knowledgeId);
          if (!row || !eligible(row)) continue;
          const cosine = cosineSimilarity(vector, chunk.embedding);
          const prior = best.get(chunk.knowledgeId);
          if (!prior || cosine > prior.cosine) best.set(chunk.knowledgeId, { cosine, text: chunk.text });
        }
      }
    }
    const lexicalSet = new Set(lexical);
    const semantic = [...best.entries()]
      .filter(([id, b]) => !lexicalSet.has(id) && b.cosine > DEFAULT_COSINE_BAND.low)
      .sort((a, b) => b[1].cosine - a[1].cosine || a[0].localeCompare(b[0]))
      .slice(0, PUBLIC_CANDIDATE_CAP)
      .map(([id]) => id);
    const ids = [...lexical, ...semantic];
    if (ids.length === 0) return [];

    const texts = new Map(
      rowsByIds<TextRow>(db, (inIds) => `SELECT id, title, body, tags_json FROM knowledge WHERE id IN ${inIds}`, ids).map((r) => [r.id, r] as const)
    );
    const chunkCounts = new Map(
      rowsByIds<{ id: string; n: number }>(
        db,
        (inIds) => `SELECT knowledge_id AS id, COUNT(*) AS n FROM knowledge_chunks WHERE knowledge_id IN ${inIds} GROUP BY knowledge_id`,
        ids
      ).map((r) => [r.id, r.n] as const)
    );

    // Query-level numbers, from the served corpus: which phrases carry idf, and the most bm25 the query can award.
    const N = corpus.size;
    const scored = phrases.map((phrase, i) => ({ i, common: phrase.every((p) => isStopword(p)) })).filter((p) => !p.common);
    const informative = scored.filter((p) => isInformativePhrase(N, df[p.i]!));
    const informativeSet = new Set(informative.map((p) => p.i));
    const scoredSet = new Set(scored.map((p) => p.i));
    const ceiling = informative.reduce((sum, p) => sum + bm25PhraseCeiling(N, df[p.i]!), 0);
    const idf = df.map((n) => {
      const v = Math.log((N - n + 0.5) / (n + 0.5));
      return v > 0 ? v : 1e-6;
    });

    const hits: SearchResult[] = [];
    for (const id of ids) {
      const row = corpus.get(id)!;
      const text = texts.get(id);
      if (!text) continue;
      const matched = matchedBy.get(id) ?? new Set<number>();
      let bm25 = 0;
      if (matched.size > 0) {
        let tags = "";
        try {
          const parsed = text.tags_json ? (JSON.parse(text.tags_json) as unknown) : [];
          tags = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string").join(" ") : "";
        } catch {
          tags = "";
        }
        const tokens = words(`${row.slug} ${text.title} ${text.body} ${tags}`);
        const norm = 1 - BM25_B + (BM25_B * row.len) / avgLength;
        for (const i of matched) {
          const tf = phraseFrequency(tokens, phrases[i]!);
          bm25 += idf[i]! * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
        }
      }
      const coveredInformative = [...matched].filter((i) => informativeSet.has(i)).length;
      const coveredScored = [...matched].filter((i) => scoredSet.has(i)).length;
      const coverage = informative.length > 0 ? coveredInformative / informative.length : scored.length > 0 ? coveredScored / scored.length : 0;
      const chunks = chunkCounts.get(id) ?? 0;
      const signals = relevanceSignals({
        bm25,
        bm25Ceiling: ceiling,
        cosine: semanticOn ? (best.get(id)?.cosine ?? 0) : null,
        coverage,
        queryTerms: scored.length,
        informativeTerms: informative.length,
        chunks,
        ...(semanticOn ? { cosineBand: { ...DEFAULT_COSINE_BAND, calibrated: false } } : {}),
      });
      const relevance = relevanceOf(signals);
      const scope = (row.scope ?? "project") as Scope;
      const sourceKind = (row.source_kind ?? "unclassified") as SourceKind;
      const layer = layerOf({ scope, sourceKind, slug: row.slug });
      const verdict = (row.verdict as DraftVerdict | null) ?? undefined;
      const contradiction = verdict === "contradicted" ? contradictionOf(row, corpusBySlug, now) : undefined;
      const writtenAt = writtenAtOf(row);
      const trust = {
        verdict,
        contradiction,
        confidence: row.confidence ?? undefined,
        lastVerifiedAt: row.last_verified_at ?? undefined,
        halfLifeDays: row.half_life_days ?? undefined,
        layer,
        writtenAt,
      };
      const lexicalHit = matched.size > 0;
      const chunk = best.get(id);
      const excerpt =
        (!lexicalHit && chunk ? chunkExcerpt(text.body, chunk.text, req.redact) : null) ?? extractExcerpt(req.redact(text.body), req.query);
      hits.push({
        id,
        projectId: row.project_id,
        slug: row.slug,
        title: req.redact(text.title),
        excerpt,
        score: relevance * trustMultiplier(trust, now),
        rawScore: relevance,
        source: lexicalHit ? "text" : "embedding",
        originClass: (row.origin_class as OriginClass | null) ?? "untrusted",
        sourceKind,
        generated: !!row.generated_from_sha,
        ...(row.confidence !== null ? { confidence: row.confidence } : {}),
        ...(row.last_verified_at ? { lastVerifiedAt: row.last_verified_at } : {}),
        ...(row.half_life_days !== null ? { halfLifeDays: row.half_life_days } : {}),
        ...(verdict ? { verdict } : {}),
        relevance,
        relevanceSignals: signals,
        scope,
        layer,
        ...(writtenAt ? { writtenAt } : {}),
        chunkCount: chunks,
        ...(contradiction ? { contradiction } : {}),
      });
    }

    hits.sort((a, b) => b.score - a.score || (b.relevance ?? 0) - (a.relevance ?? 0) || a.id.localeCompare(b.id));
    if (!req.confidentFor) return hits.slice(0, req.limit);
    const surface = req.confidentFor;
    const confident = hits.filter((h) => isConfident(h, surface));
    const below = hits.filter((h) => !isConfident(h, surface));
    return [...confident.slice(0, req.limit), ...below.slice(0, req.lowConfidenceLimit ?? 0)];
  };
}

export type PublicSearch = ReturnType<typeof publicRetrieval>;
