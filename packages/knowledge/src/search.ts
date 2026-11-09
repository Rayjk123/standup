import type { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import {
  generateEmbedding,
  resolveEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "./embeddings.js";
import { extractTerms, isStopword } from "./terms.js";
import type {
  DraftVerdict,
  OriginClass,
  SourceKind,
  KnowledgeDoc,
  Layer,
  Scope,
  ScopeAudience,
} from "./types.js";
import {
  DEFAULT_SCOPE,
  DEFAULT_SOURCE_KIND,
  docInAudience,
  layerOf,
  relatedProjectIdsOf,
  scopeAudienceSql,
  ownerFilterSql,
} from "./types.js";
// graph.ts imports cosineSimilarity from this module; both edges are only
// called at query time, never during module evaluation, so the cycle is inert.
import { parseContradictsClaim, type SemanticNeighborIndex } from "./graph.js";
import { cosineBandFor } from "./calibration.js";
import {
  bm25PhraseCeiling,
  isInformativePhrase,
  compareContradiction,
  contradictionSide,
  isConfident,
  megaDocPrior,
  relevanceOf,
  relevanceSignals,
  trustMultiplier,
  type ConfidenceSurface,
  type ContradictionState,
  type RelevanceSignals,
} from "./relevance.js";
import { rerankHead, type RerankOptions } from "./rerank.js";
import { collapseDuplicateHits, type MirrorProjects } from "./duplicate-hits.js";
import { isClosedAt, isValidAt, normalizeInstant } from "./temporal.js";

export interface SearchResult {
  /** Stable doc id — the handle graph_neighbors takes. */
  id: string;
  /** The project this doc lives in; may differ from the searching project. */
  projectId: string;
  slug: string;
  title: string;
  excerpt: string;
  /**
   * The ORDERING score — the number results are sorted by (see orderingScore):
   * `relevance` plus small additive terms for the fused rank of the text and
   * embedding arms and the title match, scaled by the trust multiplier, plus a
   * small bonus for a local hit. Relevance dominates it, but the added terms can
   * lift it past 1 and it is not a confidence bar — gate on `relevance`
   * (isConfident).
   */
  score: number;
  /**
   * The weighted fused score BEFORE the title match, the project preference
   * and the embedding-space normalization, i.e.
   * `normalizedText*textWeight + rawCosine*embeddingWeight`, where the text term
   * is normalized to the best FTS hit in the batch. The distiller's near-dup
   * threshold and the contradiction candidate floor are calibrated on it; it is
   * NOT an absolute relevance (the batch's top lexical hit always scores at
   * least the text weight) — `relevance` is. Optional so a remote
   * KnowledgeBackend that only ranks can omit it.
   */
  rawScore?: number;
  source: "text" | "embedding";
  /**
   * Trust provenance (see OriginClass). Carried on every result so the
   * auto-injection boundary can gate on it — search recalls docs
   * of every class, but only owner|agent may be fed to an agent. Fail-closed:
   * a legacy row with no class reads as `untrusted`.
   */
  originClass: OriginClass;
  /**
   * What KIND of knowledge this is (roadmap r2/r8) — code-derived vs
   * product/spec/decision/runbook. Distinct from `originClass`, which encodes
   * TRUST (who authored it), not source TYPE. Carried on every result so a
   * consumer can tell code knowledge from product/spec knowledge and inject
   * them under different labels — the launch-time product-context injection
   * (see the launcher) filters on exactly this. A legacy row with no kind reads
   * as the default kind ('unclassified').
   */
  sourceKind: SourceKind;
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
  /**
   * Confidence bookkeeping (roadmap r2/r5), carried on every result so the
   * auto-injection boundary can gate on FRESHNESS as well as trust:
   * a doc whose current (decayed) confidence has fallen below the floor, or one
   * the re-verification pass disputed, is still recalled by search but no longer
   * injected. All undefined for a doc that never carried a confidence opinion —
   * such a doc is not gated on freshness (see isConfidenceEligibleForInjection).
   */
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  /**
   * Re-verification verdict (roadmap r5/r7), carried on every result so the
   * auto-injection boundary can gate on COHERENCE as well as trust and freshness:
   * a doc flagged "disputed" (refuted) or "contradicted" (opposes another accepted
   * doc) is still recalled by search but never injected (isVerdictEligibleFor-
   * Injection). Undefined for a doc that has never been re-verified.
   */
  verdict?: DraftVerdict;
  /**
   * The batch-independent relevance in [0, 1] (see relevance.ts): saturated
   * bm25, rescaled best-chunk cosine and query-term coverage, none of which
   * moves with what else was retrieved. The number every confidence floor
   * (isConfident) gates on. Optional so a backend that only ranks can omit it.
   */
  relevance?: number;
  /** The components `relevance` was computed from. */
  relevanceSignals?: RelevanceSignals;
  /** Who the doc is for (global | project | user). */
  scope?: Scope;
  /** The knowledge layer the doc belongs to (see layerOf). */
  layer?: Layer;
  /** When the doc's content was written (generated_at, else updated_at). */
  writtenAt?: string;
  /** How many chunks the doc is indexed as — the mega-doc prior's input. */
  chunkCount?: number;
  /**
   * For a contradicted doc: the docs it contradicts and whether it is the
   * losing side (older or less verified), the winning side, or undecidable.
   */
  contradiction?: ContradictionState;
  /**
   * Set on a hit an `asOf` search returned from the history index: when that
   * version stopped being current, and the `project/slug` that replaced it.
   */
  validTo?: string;
  supersededBy?: string;
}

export interface SearchOptions {
  limit?: number;
  textWeight?: number;
  embeddingWeight?: number;
  /**
   * Which corpus to search. "all" (default) spans every project and favors
   * the current one via a ranking bonus — the cross-project shared memory.
   * "project" restores the hard partition: the current project plus the
   * audience's related projects (ScopeAudience.relatedProjectIds), whose docs
   * go without the bonus as they do under "all".
   */
  corpus?: "project" | "all";
  /**
   * Restrict recall to these `source_kind`s, pushed into the SQL WHERE on BOTH
   * the FTS and embedding candidate windows — so a caller after one kind (e.g.
   * the launcher's product/spec injection) draws its candidates from that
   * kind's OWN pool rather than post-filtering a small mixed top-N that a
   * majority kind can crowd out. Empty/omitted = every kind (the default). A
   * row stored with no kind reads as `unclassified`, so it only survives a
   * filter that names `unclassified`.
   */
  sourceKinds?: readonly SourceKind[];
  /**
   * STRICT scope gate — the injection gate an agent sees. When set, candidates
   * are restricted, in SQL on every arm, to the audience's global ∪ project ∪
   * (resolved user) set (see scopeAudienceSql): a doc is returned IFF
   * scope='global' OR (scope='project' AND its project = the audience project)
   * OR (scope='user' AND owner_user = the audience user). A browse audience
   * (ScopeAudience.browse) gates only the personal layer, to its owner — the
   * human browse/list path. Omitted = no gate at all. Distinct from `owners` below, which
   * is the permissive owner FILTER, not this hard gate; the two are orthogonal
   * and may both be set. The audience's `excludeLayers` narrows the gate on
   * every arm the same way (see ScopeAudience).
   */
  audience?: ScopeAudience;
  /**
   * PERMISSIVE owner filter for the browse/list path: restrict candidates to
   * docs whose `owner_user` is one of these aliases ("my knowledge"). Unlike
   * `audience`, this does NOT apply the injection gate — a browsing human may
   * see any user's user-scoped docs and any project's docs. Empty/omitted = no
   * owner filter. Pushed into SQL on both candidate arms like `sourceKinds`.
   */
  owners?: readonly string[];
  /**
   * The precomputed doc->doc semantic-similarity adjacency the graph-rerank arm
   * walks (see graph.ts's SemanticNeighborIndex). When present AND the rerank is
   * enabled, a THIRD weighted-RRF arm lifts a candidate that is a semantic-graph
   * neighbor of a top fused hit. Omitted = no graph arm. Supplied by a caller
   * that can reach the graph machinery without the search-graph import cycle:
   * built once per corpus via memoizedSemanticNeighborIndex and reused, so the
   * O(N^2) derivation stays off the per-query path. The arm only re-ranks docs
   * already in the (scope/owner-gated) candidate window, so it never admits an
   * out-of-scope doc the base retrieval withheld.
   */
  graphNeighbors?: SemanticNeighborIndex;
  /**
   * Per-call override of the KNOWLEDGE_GRAPH_RERANK flag. Undefined = the env
   * default (GRAPH_RERANK_ENABLED). The graph arm applies only when this
   * resolves true AND `graphNeighbors` is supplied.
   */
  graphRerank?: boolean;
  /**
   * Whether superseded docs (the losing side of a resolved contradiction, a
   * retired copy, a memory tagged `superseded`) are returned, under either
   * corpus. Defaults to false for a gated (`audience`) search and for one
   * gated on a confidence floor (`confidentFor`) — every agent surface sets one
   * or both, and none ever receives a superseded doc — and true for a search
   * with neither, which the curation crons use to see every doc. The browse UI
   * passes true to show superseded docs on request.
   */
  includeSuperseded?: boolean;
  /**
   * Reserved mirror project id → the canonical project it copies (the
   * `standup-self` self-fix copy of `standup`). A mirror is an alias of its
   * canonical project: a hit from the mirror that duplicates a canonical hit
   * collapses to the canonical one (see duplicate-hits.ts), and a search asked
   * from the mirror also admits the canonical project's project-scoped docs.
   * Omitted = no mirrors.
   */
  mirrorProjects?: MirrorProjects;
  /**
   * Whether near-identical hits within one project collapse to one (see
   * duplicate-hits.ts). Defaults to true for a search gated on a confidence
   * floor (`confidentFor`) — the agent surfaces, which get one result per
   * content — and false otherwise: the dedup and contradiction checks search to
   * find exactly those copies. Mirror pairs collapse whenever `mirrorProjects`
   * names them.
   */
  collapseDuplicates?: boolean;
  /**
   * Gate on the confidence floor of this surface (isConfident) BEFORE the
   * result limit is applied, so `limit` counts confident hits and a weak hit the
   * ranking placed high never crowds a confident one out. Omitted = no gate.
   */
  confidentFor?: ConfidenceSurface;
  /**
   * With `confidentFor`: how many hits below the floor to append after the
   * confident ones, best first. Default 0.
   */
  lowConfidenceLimit?: number;
  /**
   * The cross-encoder rerank of the fused head (see rerank.ts). Undefined = the
   * env configuration (RERANK_PROVIDER; off when unset); false = off for this
   * call; an object overrides the provider, model or budget.
   */
  rerank?: false | RerankOptions;
  /**
   * Per-call override of the ordering-score weights (RANK_WEIGHTS); a field left
   * out keeps its resolved default. The retrieval eval sweeps them with this.
   */
  rankWeights?: Partial<RankWeights>;
  /**
   * Search the corpus as it stood at this ISO-8601 instant instead of now:
   * every doc version whose validity interval covers it, closed history
   * versions included (see searchKnowledgeAsOf). Omitted = valid now: a doc
   * whose valid_to has passed is held out with the superseded docs. Only an
   * explicit request sets it; no injection, push or curation path does.
   */
  asOf?: string;
}

// `audience` is deliberately excluded from the Required defaults: undefined is
// its meaningful value (no scope gate), not a sentinel that could be defaulted.
// It is read straight off the caller's options instead. `graphNeighbors`,
// `graphRerank`, `includeSuperseded`, `mirrorProjects`, `collapseDuplicates`,
// `confidentFor`, `lowConfidenceLimit`, `rerank` and `rankWeights` are excluded
// for the same reason — undefined means their default state, so they too are
// read straight off `options`.
export const DEFAULT_OPTIONS: Required<
  Omit<
    SearchOptions,
    | "audience"
    | "graphNeighbors"
    | "graphRerank"
    | "includeSuperseded"
    | "mirrorProjects"
    | "collapseDuplicates"
    | "confidentFor"
    | "lowConfidenceLimit"
    | "rerank"
    | "rankWeights"
    | "asOf"
  >
> = {
  limit: 5,
  textWeight: 0.4,
  embeddingWeight: 0.6,
  corpus: "all",
  sourceKinds: [],
  owners: [],
};

// An env override for a ranking knob is honored only when it parses to a
// finite, strictly-positive number. A bare Number() would let Number("") === 0
// silently zero a weight, and Number("nope") === NaN would poison the
// b.score − a.score comparator and make the ordering nondeterministic. A bad or
// empty override falls back to the literal default instead of quietly breaking
// rank.
export function resolveMultiplier(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined) return fallback;
  const parsed = Number(envVar);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// An env override for an additive ranking weight: like resolveMultiplier, but 0
// is a meaningful value (the term is off), so any finite non-negative number is
// honored and anything else falls back.
export function resolveWeight(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined || envVar.trim() === "") return fallback;
  const parsed = Number(envVar);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Project scope is a ranking signal, not a filter: under corpus:"all" a hit in
// another project still competes on relevance. A caller that wants true
// isolation asks for corpus:"project" (searchText/searchEmbeddings then
// hard-partition on project_id); this preference is the soft counterpart for
// the shared-memory case.
//
// It is the additive bonus a local hit (see localProjectTest) takes in the
// ordering score (see orderingScore), on the scale of `relevance`: a local doc
// wins a near-tie, but a cross-project doc more relevant by more than this
// leads. A multiplier on the whole score made the margin grow with the score, so
// a ×0.8 discount let a 0.51-relevance local doc beat a 0.70 one from another
// project. The three ordering weights were picked on the retrieval eval's tier
// R and U cases (eval:retrieval) from a grid of rrf {0, .05, .1, .2, .3} ×
// title {0, .05, .1, .2} × local {0, .02, .05, .1}: the grid is flat to within
// one query's rank, and rrf 0.3 / local 0.05 with any title weight up to 0.2
// scored best. A title weight of 0.5 recovers one tier-R case whose relevance
// favors the wrong doc, but seats a 0.30-relevance titled doc over a 0.42 one.
export const OTHER_PROJECT_PREFERENCE = resolveWeight(process.env.KNOWLEDGE_OTHER_PROJECT_PREFERENCE, 0.05);

/**
 * The projects a corpus:"project" search spans: the asking project, then the
 * audience's related projects (ScopeAudience.relatedProjectIds).
 */
function corpusProjectIds(projectId: string, audience: ScopeAudience | undefined): string[] {
  return [projectId, ...relatedProjectIdsOf(audience)];
}

/**
 * Whether a hit homed in a project takes the OTHER_PROJECT_PREFERENCE bonus.
 * The asking project's docs do under both corpus modes, and so does everything
 * a corpus:"project" search recalls except a related project's docs: those are
 * recalled beside the asking project's but ranked like any other project's, so
 * they never win a near-tie against the asking project's own.
 */
function localProjectTest(
  projectId: string,
  corpus: "project" | "all",
  audience: ScopeAudience | undefined
): (hitProjectId: string) => boolean {
  const related = new Set(relatedProjectIdsOf(audience));
  return (hitProjectId) => hitProjectId === projectId || (corpus === "project" && !related.has(hitProjectId));
}

/**
 * The audience a search asked from a mirror project runs with: the mirror's
 * canonical project joins its related projects, so the canonical docs the
 * mirror copies are in scope and its copies collapse onto them. Any other
 * audience is returned unchanged.
 */
export function mirrorAliasedAudience(
  audience: ScopeAudience | undefined,
  projectId: string,
  mirrors: MirrorProjects
): ScopeAudience | undefined {
  const canonical = mirrors[projectId];
  if (!audience || audience.browse || !canonical || canonical === projectId) return audience;
  const related = audience.relatedProjectIds ?? [];
  if (related.includes(canonical)) return audience;
  return { ...audience, relatedProjectIds: [...related, canonical] };
}

/**
 * Whether a candidate is out of the current corpus: superseded by verdict,
 * tagged so (a forgotten Persona memory), or no longer valid now (its
 * valid_to has passed). A supersede closes the doc's validity too, so the
 * three agree; valid_to also covers a doc closed in its own front matter.
 */
function isSupersededCandidate(
  hit: Pick<SearchResult, "verdict">,
  facts: CandidateFacts | undefined,
  now: string = new Date().toISOString()
): boolean {
  return hit.verdict === "superseded" || facts?.supersededTag === true || isClosedAt(facts?.validTo, now);
}

// The weight of the fused rank (the weighted RRF of the arms, scaled to [0, 1]
// by its ceiling and by the mega-doc prior) in the ordering score, added to the
// relevance (see orderingScore). Relevance alone discards the arms' rank
// agreement; this term carries it. A hit at rank 1 in both arms gains the full
// weight, one found by a single arm 40–60% of it, so it mainly separates hits
// both arms agree on from single-arm ones. Tuned with the other two weights
// (see OTHER_PROJECT_PREFERENCE).
export const RANK_RRF_SHARE = (() => {
  const w = resolveWeight(process.env.KNOWLEDGE_RANK_RRF_SHARE, 0.3);
  return w <= 1 ? w : 0.3;
})();

// The weight of a title/heading match in the ordering score. A focused doc names
// its subject in its title — the tangential doc that shares only incidental body
// vocabulary does not — so the fraction of the query's discriminating terms
// present in a hit's title is a precision signal for which of two
// topically-adjacent docs a paraphrased question actually wants. Added as
// `weight · ratio`, so a title carrying every query term lifts the hit by
// `weight` on the relevance scale and a title carrying none leaves it untouched;
// it reorders topically-close hits without excluding anything, and cannot lift
// a weak hit past one clearly more relevant. Applied under BOTH corpus modes. It
// is safe to apply because the confidence floors read `relevance` and the
// distiller's near-dup bar reads `rawScore`, neither of which it touches.
// Tuned with the other two weights (see OTHER_PROJECT_PREFERENCE).
export const TITLE_BOOST_WEIGHT = resolveWeight(process.env.KNOWLEDGE_TITLE_BOOST_WEIGHT, 0.1);

/** The additive weights of the ordering score (see orderingScore). */
export interface RankWeights {
  /** Weight of the fused rank (RANK_RRF_SHARE). */
  rrf: number;
  /** Weight of the title-match ratio (TITLE_BOOST_WEIGHT). */
  title: number;
  /** Bonus of a local hit (OTHER_PROJECT_PREFERENCE). */
  local: number;
}

/** The ordering-score weights the environment resolved. */
export const RANK_WEIGHTS: Readonly<RankWeights> = {
  rrf: RANK_RRF_SHARE,
  title: TITLE_BOOST_WEIGHT,
  local: OTHER_PROJECT_PREFERENCE,
};

// The RRF constant k (Cormack et al. 2009). RRF scores a
// doc by 1/(k + rank) summed over the arms that ranked it, so k sets how flat
// that curve is: a large k damps the top hit's edge so a deep hit in one arm and
// a shallow hit in another still combine sensibly, while a small k makes rank 1
// nearly decisive. 60 is the value the original paper found robust across TREC
// corpora and the de-facto default in hybrid retrieval stacks. Env-tunable like
// the file's other ranking knobs; a bad or non-positive override falls back.
export const RRF_K = (() => {
  const parsed = Number(process.env.KNOWLEDGE_RRF_K);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();

// The graph-aware rerank flag (KNOWLEDGE_GRAPH_RERANK). When on, a THIRD
// weighted-RRF arm lifts a candidate that is a semantic-graph neighbor of a top
// fused hit — the admit-only, boost-only lift searchKnowledgeWithGraph pioneered
// (bounded neighbor promotion, MAX over seeds), folded into the default search
// path as one more reciprocal-rank term. Admit-only by construction under RRF: a
// graph-connected doc gains GRAPH_RERANK_WEIGHT/(RRF_K + graphRank); a doc the
// graph does not touch gains 0 and keeps its no-graph score, so a doc is never
// demoted below its base rank — only overtaken by a promoted neighbor.
//
// DEFAULT OFF, decided by the knowledge eval (packages/knowledge/eval, dev
// split, with the confidence floors and relevance blend in place): on vs off,
// fixture recall@5 0.878 / 0.874, MRR@10 0.919 / 0.918, nDCG@10 0.856 / 0.853,
// code hits 0.478 / 0.522; real-corpus snapshot recall@5 0.583 /
// 0.580, MRR@10 0.649 / 0.658, nDCG@10 0.552 / 0.557. That is neutral, and a
// neutral arm stays off: its lift shows only on the synthetic bridge fixtures
// built for it (eval.test.ts), and on a realistic corpus it mostly promotes hub
// docs — long docs whose mean vector sits near everything.
//
// KNOWLEDGE_GRAPH_RERANK is the OPT-IN: a truthy value (1/true/on/yes) turns the
// arm on. When it is off the memoized neighbor index is NEVER built (its caller
// skips the build), so the default pays no all-pairs cosine cost.
export const GRAPH_RERANK_ENABLED = (() => {
  const v = process.env.KNOWLEDGE_GRAPH_RERANK;
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
})();

// The graph arm's RRF weight: its term is GRAPH_RERANK_WEIGHT/(RRF_K + graphRank),
// the same SHAPE as the text/embedding arms but a deliberately SMALLER weight, so
// the graph acts as a subordinate re-ranker, never a co-equal retrieval arm. That
// gap is the fix for the double-count: a semantic edge lends its neighbor a slice
// of the SEED's relevance, so pricing that lift at a full retrieval arm's weight
// (the old 0.6, equal to embeddingWeight) let a weakly-retrieved neighbor of a
// merely-tangential seed outscore — and displace past the limit — a genuinely
// strong single-arm answer. The invariant the smaller weight restores: a neighbor
// promoted at graph-rank-1 gains at most GRAPH_RERANK_WEIGHT/(RRF_K+1), and the
// strongest genuine single-arm hit (the embedding arm's rank-1) already scores
// embeddingWeight/(RRF_K+1); keeping the graph weight below embeddingWeight − the
// weaker arm's weight (0.15 < 0.6 − 0.4) means even a neighbor that is ALSO the
// text arm's rank-1 — the most a "merely promoted" doc can be — stays strictly
// below that top embedding hit: (textWeight + GRAPH_RERANK_WEIGHT)/(RRF_K+1) =
// 0.55/61 < 0.60/61. So the arm still reorders topically-close hits and lifts a
// graph-connected doc over LEXICAL distractors, but cannot overturn a genuinely
// strong SEMANTIC answer. (Stated for the default 0.4/0.6 weights; the knob stays
// tunable — a claim to measure, not assert.) A bad/non-positive override falls back.
export const GRAPH_RERANK_WEIGHT = resolveMultiplier(
  process.env.KNOWLEDGE_GRAPH_RERANK_WEIGHT,
  0.15
);

// Cosine floor a semantic edge must clear to lend its rank-lift — mirrors
// searchKnowledgeWithGraph's minSim so the wired arm and the offline experiment
// admit the same neighbors. A bad or non-positive override falls back.
export const GRAPH_RERANK_MIN_SIM = resolveMultiplier(
  process.env.KNOWLEDGE_GRAPH_RERANK_MIN_SIM,
  0.6
);

// The fraction of the query's discriminating terms that appear as whole words in
// a title. Word-level, not substring: an "agent" query term must not match an
// "agentic" title token — a substring match would boost a merely lexically-close
// tangential doc, the exact miss this signal exists to prevent. Shares the query
// tokenization (extractTerms — stopwords dropped, longest-first) so the title
// signal keys off the same discriminating terms the rest of retrieval anchors on.
function titleMatchRatio(title: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const titleTokens = new Set(
    title.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)
  );
  const hits = queryTerms.filter((t) => titleTokens.has(t)).length;
  return hits / queryTerms.length;
}

export async function searchKnowledge(
  db: Database,
  projectId: string,
  query: string,
  embeddingProvider: EmbeddingProvider | null,
  options: SearchOptions = {},
  embeddingConfig: EmbeddingConfig = {}
): Promise<SearchResult[]> {
  if (options.asOf !== undefined) {
    return searchKnowledgeAsOf(db, projectId, query, embeddingProvider, options, embeddingConfig);
  }
  const mirrors = options.mirrorProjects ?? {};
  const opts = { ...DEFAULT_OPTIONS, ...options, audience: mirrorAliasedAudience(options.audience, projectId, mirrors) };
  const store = new KnowledgeStore(db);
  // Control characters carry nothing to match and can break the FTS query
  // syntax (a NUL ends the MATCH string early).
  query = query.replace(/\p{Cc}+/gu, " ");

  // Text search using FTS5
  const textResults = searchText(
    db,
    projectId,
    query,
    opts.limit * 2,
    opts.corpus,
    opts.sourceKinds,
    opts.audience,
    opts.owners
  );

  // Embedding search if provider available. The query is embedded with the same
  // model/baseUrl/apiKey/region the corpus was indexed with, so index and query
  // land in the same vector space — a divergent config here would embed the
  // query in a different (or wrong-dimension) space and silently zero out every
  // cosine similarity.
  let embeddingArm: EmbeddingArm = { results: [], queryEmbedding: null, bestCosine: new Map() };
  if (embeddingProvider) {
    embeddingArm = await searchEmbeddings(
      store,
      projectId,
      query,
      embeddingProvider,
      opts.limit * 2,
      opts.corpus,
      embeddingConfig,
      opts.sourceKinds,
      opts.audience,
      opts.owners
    );
  }
  const embeddingResults = embeddingArm.results;

  // The optional third RRF arm: the semantic-graph neighbor lift. Active only
  // when the flag resolves on AND a caller handed in a neighbor index — the
  // index is built (and memoized) by the caller because search.ts cannot import
  // the graph machinery without a cycle. Seed depth = limit, so the arm expands
  // from the same top the results are drawn from.
  const graphRerankOn =
    (options.graphRerank ?? GRAPH_RERANK_ENABLED) && options.graphNeighbors !== undefined;

  // Merge and deduplicate the arms' results.
  const isLocal = localProjectTest(projectId, opts.corpus, opts.audience);
  const weights: RankWeights = {
    rrf: options.rankWeights?.rrf ?? RANK_WEIGHTS.rrf,
    title: options.rankWeights?.title ?? RANK_WEIGHTS.title,
    local: options.rankWeights?.local ?? RANK_WEIGHTS.local,
  };
  const merged = mergeResults(
    textResults,
    embeddingResults,
    opts.textWeight,
    opts.embeddingWeight,
    isLocal,
    query,
    graphRerankOn
      ? { neighbors: options.graphNeighbors!, seedDepth: opts.limit }
      : undefined,
    weights
  );

  // A query that names a doc by slug or title (a long canonical doc found by
  // its exact title must not fall behind the docs that merely mention its
  // words). A title-named doc stays named only with semantic support or in the
  // asking project (candidateFacts).
  const named = namedDocHits(db, projectId, query, opts);
  const nameHits = [...named.bySlug, ...named.byTitle];
  const mergedIds = new Set(merged.map((r) => r.id));
  const candidates: FusedHit[] = [
    ...merged,
    ...nameHits.filter((r) => !mergedIds.has(r.id)).map((r) => ({ ...r, rrf: 0, titleMatch: 0 })),
  ];

  // Per-doc facts the absolute relevance and the trust inputs read, fetched
  // once for the whole candidate set.
  const facts = candidateFacts(db, store, candidates, query, embeddingArm, {
    bySlug: new Set(named.bySlug.map((r) => r.id)),
    byTitle: new Set(named.byTitle.map((r) => r.id)),
    projectId,
  });
  const slugHits = nameHits.filter((r) => facts.get(r.id)?.signals.named);
  const namedIds = new Set(slugHits.map((r) => r.id));
  const includeSuperseded =
    options.includeSuperseded ?? (opts.audience === undefined && options.confidentFor === undefined);
  // One result per content: a mirror copy or near-identical duplicate of a
  // higher-trust hit gives up its slot (duplicate-hits.ts). A named doc keeps
  // its own.
  const fused = collapseDuplicateHits(
    db,
    rankCandidates(
      candidates
        .filter((r) => includeSuperseded || !isSupersededCandidate(r, facts.get(r.id)))
        .map((r) => withFacts(r, facts.get(r.id))),
      isLocal,
      opts.textWeight,
      opts.embeddingWeight,
      weights
    ),
    {
      mirrors,
      nearIdentical: options.collapseDuplicates ?? options.confidentFor !== undefined,
      exempt: namedIds,
    }
  );

  // The cross-encoder rerank of the fused head (rerank.ts): off unless a
  // provider is configured, bounded by its budget, and falling back to `fused`
  // on any failure. It reorders and reassigns `score` within the head but never
  // touches `relevance`, so the confidence split below still gates on the
  // fused relevance — a rerank cannot make a below-floor doc confident.
  const ranked = await rerankHead(fused, query, () => store.corpusRevision(), options.rerank);

  // A query that names a doc is asking for that doc: each named doc (already
  // gated by the same project/kind/scope/owner filters as the arms) leads the
  // results, ahead of whatever the ranking put first, in the order the query
  // names them. Its ranking score is lifted to the top score so a consumer
  // normalizing within the batch reads it as the best hit.
  let ordered = ranked;
  if (namedIds.size > 0) {
    const topScore = ranked[0]?.score ?? 0;
    const byId = new Map(ranked.map((r) => [r.id, r] as const));
    const lifted = slugHits
      .map((hit) => byId.get(hit.id))
      .filter((r): r is SearchResult => r !== undefined)
      .map((r) => ({ ...r, score: Math.max(r.score, topScore) }));
    ordered = [...lifted, ...ranked.filter((r) => !namedIds.has(r.id))];
  }
  return splitConfident(ordered, opts.limit, options);
}

/** `limit` results, gated on the caller's confidence floor when it names one (see SearchOptions.confidentFor). */
function splitConfident(
  ordered: SearchResult[],
  limit: number,
  options: Pick<SearchOptions, "confidentFor" | "lowConfidenceLimit">
): SearchResult[] {
  const surface = options.confidentFor;
  if (surface === undefined) return ordered.slice(0, limit);
  const confident = ordered.filter((r) => isConfident(r, surface)).slice(0, limit);
  const low = ordered.filter((r) => !isConfident(r, surface)).slice(0, Math.max(0, options.lowConfidenceLimit ?? 0));
  return [...confident, ...low];
}

/** How many current hits an asOf search ranks per requested result, before the validity filter. */
const AS_OF_OVERFETCH = 4;

/**
 * The search as the corpus stood at `options.asOf`: every version whose
 * validity interval covers that instant. Current docs are ranked by the
 * ordinary pipeline — with superseded docs admitted, since a doc superseded
 * later was current then — and kept when valid at asOf; closed versions from
 * the history index (knowledge_history) that cover it are matched on their own
 * FTS index, under the same corpus, kind, scope and owner gates, and scored by
 * the lexical relevance against that index (they have no embeddings). A
 * history hit carries the history row's id and `validTo`/`supersededBy`.
 */
async function searchKnowledgeAsOf(
  db: Database,
  projectId: string,
  query: string,
  embeddingProvider: EmbeddingProvider | null,
  options: SearchOptions,
  embeddingConfig: EmbeddingConfig
): Promise<SearchResult[]> {
  const asOf = normalizeInstant(options.asOf);
  if (!asOf) throw new Error("asOf must be an ISO-8601 date or timestamp");
  const limit = options.limit ?? DEFAULT_OPTIONS.limit;
  const current = await searchKnowledge(
    db,
    projectId,
    query,
    embeddingProvider,
    {
      ...options,
      asOf: undefined,
      includeSuperseded: true,
      collapseDuplicates: options.collapseDuplicates ?? options.confidentFor !== undefined,
      confidentFor: undefined,
      lowConfidenceLimit: undefined,
      limit: limit * AS_OF_OVERFETCH,
    },
    embeddingConfig
  );
  const validity = new Map<string, { validFrom?: string | null; validTo?: string | null }>();
  if (current.length > 0) {
    const ids = current.map((r) => r.id);
    const rows = db
      .query(`SELECT id, valid_from, valid_to FROM knowledge WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Array<{ id: string; valid_from: string | null; valid_to: string | null }>;
    for (const row of rows) validity.set(row.id, { validFrom: row.valid_from, validTo: row.valid_to });
  }
  const valid = current.filter((r) => isValidAt(validity.get(r.id) ?? {}, asOf));
  const audience = mirrorAliasedAudience(options.audience, projectId, options.mirrorProjects ?? {});
  const history = historyHitsAsOf(db, projectId, query, asOf, limit * AS_OF_OVERFETCH, {
    corpus: options.corpus ?? DEFAULT_OPTIONS.corpus,
    sourceKinds: options.sourceKinds,
    audience,
    owners: options.owners,
  });
  const ordered = [...valid, ...history].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return splitConfident(ordered, limit, options);
}

interface HistoryFtsRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  body: string;
  generated_from_sha: string | null;
  origin_class: string;
  source_kind: string;
  scope: string;
  valid_to: string;
  superseded_by: string | null;
  score: number;
}

/** History versions valid at `asOf` matching the query (see searchKnowledgeAsOf). */
function historyHitsAsOf(
  db: Database,
  projectId: string,
  query: string,
  asOf: string,
  limit: number,
  gate: {
    corpus: "project" | "all";
    sourceKinds?: readonly SourceKind[];
    audience?: ScopeAudience;
    owners?: readonly string[];
  }
): SearchResult[] {
  const where: string[] = ["knowledge_history_fts MATCH ?", "(h.valid_from IS NULL OR h.valid_from <= ?)", "h.valid_to > ?"];
  const params: Array<string | number> = [buildOrQuery(query), asOf, asOf];
  if (gate.corpus === "project") {
    const projects = corpusProjectIds(projectId, gate.audience);
    where.push(`h.project_id IN (${projects.map(() => "?").join(", ")})`);
    params.push(...projects);
  }
  if (gate.sourceKinds && gate.sourceKinds.length > 0) {
    where.push(`h.source_kind IN (${gate.sourceKinds.map(() => "?").join(", ")})`);
    params.push(...gate.sourceKinds);
  }
  const scopeGate = gate.audience ? scopeAudienceSql(gate.audience, "h") : null;
  if (scopeGate) {
    where.push(scopeGate.sql);
    params.push(...scopeGate.params);
  }
  const ownerFilter = gate.owners ? ownerFilterSql(gate.owners, "h") : null;
  if (ownerFilter) {
    where.push(ownerFilter.sql);
    params.push(...ownerFilter.params);
  }
  params.push(limit);
  let rows: HistoryFtsRow[];
  try {
    rows = db
      .query(
        `SELECT h.id, h.project_id, h.slug, h.title, h.body, h.generated_from_sha, h.origin_class, h.source_kind,
                h.scope, h.valid_to, h.superseded_by, bm25(knowledge_history_fts) AS score
         FROM knowledge_history_fts
         JOIN knowledge_history h ON h.id = knowledge_history_fts.id
         WHERE ${where.join(" AND ")}
         ORDER BY score
         LIMIT ?`
      )
      .all(...params) as HistoryFtsRow[];
  } catch (err) {
    console.error("[knowledge] history FTS query failed:", err);
    return [];
  }
  if (rows.length === 0) return [];

  // Lexical relevance against the history index, the same computation the
  // corpus's text arm uses (candidateFacts) with no embedding arm.
  const ids = rows.map((r) => r.id);
  const inIds = `(${ids.map(() => "?").join(", ")})`;
  const indexed = (db.query("SELECT COUNT(*) AS n FROM knowledge_history_fts").get() as { n: number }).n;
  const scored = queryPhrases(query).filter((phrase) => !phrase.every((piece) => isStopword(piece)));
  let ceiling = 0;
  let informative = 0;
  const covered = new Map<string, number>();
  for (const phrase of scored) {
    const match = phraseMatch(phrase);
    const matching =
      ftsRows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM knowledge_history_fts WHERE knowledge_history_fts MATCH ?", [
        match,
      ])[0]?.n ?? 0;
    if (isInformativePhrase(indexed, matching)) {
      informative++;
      ceiling += bm25PhraseCeiling(indexed, matching);
    }
    for (const { id } of ftsRows<{ id: string }>(
      db,
      `SELECT id FROM knowledge_history_fts WHERE knowledge_history_fts MATCH ? AND id IN ${inIds}`,
      [match, ...ids]
    )) {
      covered.set(id, (covered.get(id) ?? 0) + 1);
    }
  }
  return rows.map((row) => {
    const signals = relevanceSignals({
      bm25: Math.abs(row.score),
      bm25Ceiling: ceiling,
      cosine: null,
      coverage: scored.length > 0 ? (covered.get(row.id) ?? 0) / scored.length : 0,
      queryTerms: scored.length,
      informativeTerms: informative,
    });
    const relevance = relevanceOf(signals);
    const scope = (row.scope as Scope) ?? DEFAULT_SCOPE;
    const sourceKind = (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND;
    return {
      id: row.id,
      projectId: row.project_id,
      slug: row.slug,
      title: row.title,
      excerpt: extractExcerpt(row.body, query),
      score: relevance,
      source: "text" as const,
      originClass: (row.origin_class as OriginClass) ?? "untrusted",
      sourceKind,
      generated: !!row.generated_from_sha,
      relevance,
      relevanceSignals: signals,
      scope,
      layer: layerOf({ scope, sourceKind, slug: row.slug }),
      validTo: row.valid_to,
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    };
  });
}

// Strips the punctuation a slug is commonly followed by in prose (brackets,
// trailing sentence punctuation) — quotes and backticks are left for
// quotedSlug to read.
function slugToken(raw: string): string {
  return raw.replace(/^[(<\[{]+|[)>\]},.;:!?]+$/g, "").toLowerCase();
}

// The slug inside a token wrapped in backticks or quotes, or null.
function quotedSlug(token: string): string | null {
  const m = token.match(/^([`'"])(.+)\1$/);
  return m ? m[2] : null;
}

const SLUG_SHAPE = /^[a-z0-9][a-z0-9._-]*$/;

/** A title or query reduced to its lowercase words, for whole-title matching. */
function normalizedTitle(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");
}

/** Fewest words a query needs for a title it begins to name the doc. */
const TITLE_PREFIX_MIN_WORDS = 3;

/**
 * Docs the query explicitly names, in the order the query names them with
 * current-project docs first.
 *
 * By slug: when the whole query is a doc's slug, when it carries a
 * `project/slug` pair, or when it quotes the slug in backticks or quotes. A
 * bare slug-shaped word inside a longer question does not name a doc — it
 * already matches through the FTS slug column — so an ordinary hyphenated word
 * that happens to be some doc's slug cannot hijack the ranking. A bare slug
 * (whole or quoted) resolves within the current project and among shared docs
 * (scope=global, or the reserved global corpus); another project's own doc is
 * named by qualifying it.
 *
 * By title: when the query is a doc's whole title, or the first words of it
 * (at least TITLE_PREFIX_MIN_WORDS), compared case- and punctuation-
 * insensitively in any script. A title match is a weaker claim than a slug —
 * a short common-phrase title can coincide with a question — so the caller
 * keeps it named only with semantic support or in the asking project (see
 * candidateFacts).
 *
 * Both apply the same corpus, source-kind, scope and owner filters as the
 * retrieval arms.
 */
function namedDocHits(
  db: Database,
  projectId: string,
  query: string,
  opts: Required<Pick<SearchOptions, "corpus">> & SearchOptions
): { bySlug: SearchResult[]; byTitle: SearchResult[] } {
  const bare = new Set<string>();
  const qualified: Array<[string, string]> = [];
  const addQualified = (token: string): boolean => {
    const slash = token.indexOf("/");
    if (slash <= 0 || token.indexOf("/", slash + 1) !== -1) return false;
    const [p, slug] = [token.slice(0, slash), token.slice(slash + 1)];
    if (SLUG_SHAPE.test(p) && SLUG_SHAPE.test(slug)) qualified.push([p, slug]);
    return true;
  };
  const whole = slugToken(query.trim());
  const wholeQuoted = quotedSlug(whole) ?? whole;
  if (SLUG_SHAPE.test(wholeQuoted)) bare.add(wholeQuoted);
  for (const raw of query.split(/\s+/)) {
    const token = slugToken(raw);
    const quoted = quotedSlug(token);
    if (addQualified(quoted ?? token)) continue;
    if (quoted !== null && SLUG_SHAPE.test(quoted)) bare.add(quoted);
  }

  // The corpus / kind / scope / owner gate both lookups share.
  const gate: string[] = [];
  const gateParams: string[] = [];
  if (opts.corpus === "project") {
    const projects = corpusProjectIds(projectId, opts.audience);
    gate.push(`k.project_id IN (${projects.map(() => "?").join(", ")})`);
    gateParams.push(...projects);
  }
  if (opts.sourceKinds !== undefined && opts.sourceKinds.length > 0) {
    gate.push(`k.source_kind IN (${opts.sourceKinds.map(() => "?").join(", ")})`);
    gateParams.push(...opts.sourceKinds);
  }
  const scopeGate = opts.audience ? scopeAudienceSql(opts.audience, "k") : null;
  if (scopeGate) {
    gate.push(scopeGate.sql);
    gateParams.push(...scopeGate.params);
  }
  const ownerFilter = opts.owners ? ownerFilterSql(opts.owners, "k") : null;
  if (ownerFilter) {
    gate.push(ownerFilter.sql);
    gateParams.push(...ownerFilter.params);
  }
  const select = (where: string[], params: string[]) =>
    db
      .query(
        `SELECT k.id, k.project_id, k.slug, k.title, k.body, k.generated_from_sha, k.origin_class,
                k.source_kind, k.confidence, k.last_verified_at, k.half_life_days, k.verdict
         FROM knowledge k
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`
      )
      .all(...params) as FtsRow[];

  const position = (slug: string) => {
    const i = query.toLowerCase().indexOf(slug);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const order = (rows: FtsRow[]) =>
    rows
      .sort(
        (a, b) =>
          Number(b.project_id === projectId) - Number(a.project_id === projectId) ||
          position(a.slug) - position(b.slug) ||
          a.id.localeCompare(b.id)
      )
      .map((row) => ftsRowToResult(row, query, 0));

  let bySlug: SearchResult[] = [];
  if (bare.size > 0 || qualified.length > 0) {
    const nameClauses: string[] = [];
    const params: string[] = [];
    if (bare.size > 0) {
      nameClauses.push(
        `((k.project_id = ? OR k.scope = 'global' OR (k.project_id = ? AND k.scope != 'user')) AND k.slug IN (${[...bare]
          .map(() => "?")
          .join(", ")}))`
      );
      params.push(projectId, GLOBAL_PROJECT_ID, ...bare);
    }
    for (const [p, slug] of qualified) {
      nameClauses.push("(k.project_id = ? AND k.slug = ?)");
      params.push(p, slug);
    }
    bySlug = order(select([`(${nameClauses.join(" OR ")})`, ...gate], [...params, ...gateParams]));
  }

  // Titles are compared in JS: SQLite's lower() folds ASCII only.
  const wanted = normalizedTitle(query);
  let byTitle: SearchResult[] = [];
  if (wanted.length > 0) {
    const words = wanted.split(" ").length;
    const slugIds = new Set(bySlug.map((r) => r.id));
    const titles = db
      .query(`SELECT k.id, k.title FROM knowledge k ${gate.length > 0 ? `WHERE ${gate.join(" AND ")}` : ""}`)
      .all(...gateParams) as Array<{ id: string; title: string }>;
    const matches = titles
      .filter((row) => {
        if (slugIds.has(row.id)) return false;
        const title = normalizedTitle(row.title);
        return title === wanted || (words >= TITLE_PREFIX_MIN_WORDS && title.startsWith(`${wanted} `));
      })
      .map((row) => row.id);
    if (matches.length > 0) {
      byTitle = order(select([`k.id IN (${matches.map(() => "?").join(", ")})`], matches));
    }
  }
  return { bySlug, byTitle };
}

/**
 * Tuning for the graph-aware rerank. All bounded so the step can only ADMIT and
 * gently promote — never demote below where the base ranking placed a doc among
 * its unboosted peers.
 */
export interface GraphExpansionOptions {
  /** The doc→semantic-neighbor adjacency (from graph.ts's semantic edges). */
  neighbors: SemanticNeighborIndex;
  /**
   * ALPHA — the hard cap on the additive lift any one doc can receive. The boost
   * a seed offers a neighbor is `alpha × seedNorm × similarity`, taken as the MAX across
   * seeds (not summed), so no doc's score rises by more than alpha. Small by
   * design: the base ranking stays authoritative and the graph only nudges.
   */
  alpha?: number;
  /** Ignore semantic edges below this cosine — a weak edge should not move rank. */
  minSim?: number;
  /** How many of the base top hits act as expansion seeds. Default = limit. */
  seedDepth?: number;
  /** Base candidate window = limit × windowFactor, the pool the rerank works over. */
  windowFactor?: number;
}

export const GRAPH_DEFAULTS = {
  alpha: 0.3,
  minSim: 0.6,
  windowFactor: 4,
};

/** Builds a SearchResult from a doc the base retrieval never surfaced (a pure semantic admit). */
function docToResult(doc: KnowledgeDoc, query: string): SearchResult {
  return {
    id: doc.id,
    projectId: doc.projectId,
    slug: doc.slug,
    title: doc.title,
    excerpt: extractExcerpt(doc.body, query),
    score: 0,
    source: "embedding",
    originClass: doc.originClass ?? "untrusted",
    sourceKind: doc.sourceKind ?? DEFAULT_SOURCE_KIND,
    generated: !!doc.generatedFromSha,
    confidence: doc.confidence,
    lastVerifiedAt: doc.lastVerifiedAt,
    halfLifeDays: doc.halfLifeDays,
    verdict: doc.verdict,
  };
}

/**
 * FLAGGED, opt-in graph-aware retrieval. Runs the EXACT same base retrieval as
 * searchKnowledge (a wider slice of it), then reranks by walking the precomputed
 * SEMANTIC-SIMILARITY graph: each base top hit ("seed") lends its semantically
 * near docs a bounded, non-negative lift. The default search path
 * (searchKnowledge) is untouched — a caller only reaches this by asking for it
 * and handing it a neighbor index.
 *
 * Why this can help where the offline eval can't use embeddings at all: the
 * FTS-only path has no query-side vector, so a low-lexical-overlap answer never
 * surfaces on relevance. But the doc↔doc semantic edge is query-INDEPENDENT —
 * precomputed from the corpus's chunk embeddings — so a lexical hit that IS
 * retrieved can pull its semantic sibling (the real answer) up through the graph.
 *
 * Admit-only + bounded by construction: the base scores are normalized to [0,1]
 * (a monotonic transform — same order), then boosts are ADDED (never subtracted)
 * and capped at +alpha. So an unboosted doc keeps its base rank relative to other
 * unboosted docs, and any doc's rank can only fall by being OVERTAKEN by a
 * boosted neighbor — it is never actively demoted. That is the safety the floor
 * guard leans on.
 */
export async function searchKnowledgeWithGraph(
  db: Database,
  projectId: string,
  query: string,
  embeddingProvider: EmbeddingProvider | null,
  options: SearchOptions = {},
  embeddingConfig: EmbeddingConfig = {},
  graph: GraphExpansionOptions
): Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const k = opts.limit;
  const alpha = graph.alpha ?? GRAPH_DEFAULTS.alpha;
  const minSim = graph.minSim ?? GRAPH_DEFAULTS.minSim;
  const windowFactor = graph.windowFactor ?? GRAPH_DEFAULTS.windowFactor;
  const seedDepth = graph.seedDepth ?? k;

  // The base ranked window — identical retrieval, just a wider slice than k so
  // there is a pool to rerank and so a boosted-up doc has somewhere to come from.
  const base = await searchKnowledge(
    db,
    projectId,
    query,
    embeddingProvider,
    { ...options, limit: k * windowFactor },
    embeddingConfig
  );
  if (base.length === 0) return base;

  // Normalize base scores so the top hit is 1.0; boosts live on that same scale.
  const maxScore = base[0].score || 1;
  const normById = new Map(base.map((r) => [r.id, r.score / maxScore] as const));

  // The bounded, admit-only lift: MAX (not sum) over seeds, capped at +alpha.
  const boost = new Map<string, number>();
  for (const seed of base.slice(0, seedDepth)) {
    const seedNorm = normById.get(seed.id) ?? 0;
    for (const nb of graph.neighbors.get(seed.id) ?? []) {
      if (nb.similarity < minSim) continue;
      const lift = alpha * seedNorm * nb.similarity;
      if (lift > (boost.get(nb.docId) ?? 0)) boost.set(nb.docId, lift);
    }
  }

  // Every base hit at (normalized base + its boost), plus any neighbor the base
  // retrieval never surfaced, admitted fresh at pure boost.
  const store = new KnowledgeStore(db);
  const ranked: Array<SearchResult & { rerankScore: number }> = [];
  const seen = new Set<string>();
  for (const r of base) {
    seen.add(r.id);
    ranked.push({ ...r, rerankScore: (normById.get(r.id) ?? 0) + (boost.get(r.id) ?? 0) });
  }
  // A scoped caller (audience set) must never receive a graph neighbor the base
  // retrieval didn't already surface: getDocById is a raw id lookup with no
  // scope/owner gate, so admitting a fresh neighbor could leak a user- or
  // project-scoped doc the audience excludes. When gated, only the
  // already-audience-filtered base hits are reranked; fresh neighbors are
  // admitted only for an ungated caller (e.g. the offline graph eval) or a
  // browse audience, which checks each one against its personal-layer rule.
  // A fresh neighbor is held to the base search's superseded rule.
  const browse = opts.audience?.browse ? opts.audience : undefined;
  const includeSuperseded =
    options.includeSuperseded ?? (opts.audience === undefined && options.confidentFor === undefined);
  if (!opts.audience || browse) {
    for (const [docId, lift] of boost) {
      if (seen.has(docId)) continue;
      const doc = store.getDocById(docId);
      if (!doc || (browse && !docInAudience(doc, browse))) continue;
      if (
        !includeSuperseded &&
        (doc.verdict === "superseded" ||
          (doc.tags ?? []).includes("superseded") ||
          isClosedAt(doc.validTo, new Date().toISOString()))
      ) {
        continue;
      }
      ranked.push({ ...docToResult(doc, query), rerankScore: lift });
    }
  }

  ranked.sort((a, b) => b.rerankScore - a.rerankScore || a.id.localeCompare(b.id));
  // `score` becomes the number this path actually ranked on, so a consumer reads a
  // coherent ordering; rawScore (absolute relevance) is carried through untouched.
  return ranked.slice(0, k).map(({ rerankScore, ...r }) => ({ ...r, score: rerankScore }));
}

// Union two candidate lists by doc id, first occurrence wins. The scored
// candidate windows below overlap heavily (a current-project hit is usually
// in the global window too), so a plain concat would double-count it in
// mergeResults' normalization; dedup here keeps each doc once.
function unionById(...lists: SearchResult[][]): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const list of lists) {
    for (const r of list) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  return [...byId.values()];
}

// FTS5 treats space-separated terms as an implicit AND, which is far too
// strict for a natural-language question — one word absent from every doc
// (e.g. "business" in "what is the business goal") kills the whole match,
// even when other terms in the same query clearly hit. Quote each term and
// join with OR instead: any term matching is enough to surface a result,
// and bm25() still ranks documents matching more/rarer terms higher.
//
// Each whitespace token becomes one quoted phrase of its alphanumeric pieces
// (letters, digits and combining marks, so a Devanagari or Thai word whose
// vowel signs are marks stays whole, as FTS's tokenizer keeps it),
// so a compound ("search_knowledge", "follow-up") still matches its words adjacently
// — the way FTS tokenizes the doc text. A one-character piece is dropped from a
// longer token (the "s" of "collector's", the "t" of "don't"): left in, the
// phrase "collector s" would miss every doc that says "collector".
//
// Stopwords are dropped next: OR-joined, a "the"/"how" term matches nearly
// every doc and dilutes bm25 toward whichever doc repeats it most. A query made
// only of stopwords keeps them, so it still matches something.
function buildOrQuery(query: string): string {
  const chosen = queryPhrases(query);
  if (chosen.length === 0) return '""';
  return chosen.map(phraseMatch).join(" OR ");
}

/** One query phrase as an FTS5 phrase literal. */
function phraseMatch(phrase: readonly string[]): string {
  return `"${phrase.join(" ")}"`;
}

/**
 * The phrases a query is matched on (see buildOrQuery): each whitespace token's
 * alphanumeric pieces, deduped, stopword-only tokens dropped unless the query
 * has nothing else. Shared with the coverage signal, so "how many of the
 * query's terms does this doc contain" counts exactly the terms retrieval
 * matched on.
 */
export function queryPhrases(query: string): string[][] {
  const phrases: string[][] = [];
  const seen = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const pieces = raw.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
    const kept = pieces.length > 1 ? pieces.filter((p) => p.length > 1) : pieces;
    if (kept.length === 0) continue;
    const key = kept.join(" ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push(kept);
  }
  const discriminating = phrases.filter((p) => !p.every((piece) => isStopword(piece)));
  return discriminating.length > 0 ? discriminating : phrases;
}

// Fetches the top `limit` FTS hits, optionally filtered to a set of projects.
// `undefined` projects drops the WHERE clause and ranks across the whole corpus.
function ftsCandidates(
  db: Database,
  ftsQuery: string,
  query: string,
  limit: number,
  projectIds?: readonly string[],
  sourceKinds?: readonly SourceKind[],
  audience?: ScopeAudience,
  owners?: readonly string[]
): SearchResult[] {
  const scoped = projectIds !== undefined;
  const projectClause = scoped ? ` AND k.project_id IN (${projectIds.map(() => "?").join(", ")})` : "";
  const kindFiltered = sourceKinds !== undefined && sourceKinds.length > 0;
  // Push the kind restriction into SQL so product/spec candidates are drawn
  // from their own pool, not sliced out of a mixed top-N a majority kind fills.
  const kindClause = kindFiltered
    ? ` AND k.source_kind IN (${sourceKinds.map(() => "?").join(", ")})`
    : "";
  // The strict scope gate and the permissive owner filter, both pushed into the
  // candidate WHERE so an out-of-scope/other-owner doc is filtered BEFORE the
  // bm25 ORDER BY + LIMIT — otherwise it could starve an in-scope doc out of the
  // recall window rather than merely being dropped after ranking.
  const scopeGate = audience ? scopeAudienceSql(audience, "k") : null;
  const ownerFilter = owners ? ownerFilterSql(owners, "k") : null;
  const params: (string | number)[] = [ftsQuery];
  if (scoped) params.push(...projectIds);
  if (kindFiltered) params.push(...sourceKinds);
  if (scopeGate) params.push(...scopeGate.params);
  if (ownerFilter) params.push(...ownerFilter.params);
  params.push(limit);
  let rows: Array<FtsRow & { score: number }>;
  try {
    rows = db
      .query(
        `SELECT k.id, k.project_id, k.slug, k.title, k.body, k.generated_from_sha, k.origin_class,
              k.source_kind, k.confidence, k.last_verified_at, k.half_life_days, k.verdict, bm25(knowledge_fts) as score
         FROM knowledge_fts
         JOIN knowledge k ON k.id = knowledge_fts.id
         WHERE knowledge_fts MATCH ?${projectClause}${kindClause}${
           scopeGate ? ` AND ${scopeGate.sql}` : ""
         }${ownerFilter ? ` AND ${ownerFilter.sql}` : ""}
         ORDER BY score
         LIMIT ?`
      )
      .all(...params) as Array<FtsRow & { score: number }>;
  } catch (err) {
    // A MATCH expression FTS5 rejects costs this arm its hits, not the search.
    console.error("[knowledge] FTS query failed:", err);
    return [];
  }

  // BM25 returns negative scores
  return rows.map((row) => ftsRowToResult(row, query, Math.abs(row.score)));
}

interface FtsRow {
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
}

function ftsRowToResult(row: FtsRow, query: string, score: number): SearchResult {
  return {
    id: row.id,
    projectId: row.project_id,
    slug: row.slug,
    title: row.title,
    excerpt: extractExcerpt(row.body, query),
    score,
    source: "text" as const,
    // Fail-closed: a legacy NULL reads as 'untrusted', never trusted.
    originClass: (row.origin_class as OriginClass) ?? "untrusted",
    sourceKind: (row.source_kind as SourceKind) ?? DEFAULT_SOURCE_KIND,
    generated: !!row.generated_from_sha,
    confidence: row.confidence ?? undefined,
    lastVerifiedAt: row.last_verified_at ?? undefined,
    halfLifeDays: row.half_life_days ?? undefined,
    verdict: (row.verdict as DraftVerdict) ?? undefined,
  };
}

function searchText(
  db: Database,
  projectId: string,
  query: string,
  limit: number,
  corpus: "project" | "all",
  sourceKinds?: readonly SourceKind[],
  audience?: ScopeAudience,
  owners?: readonly string[]
): SearchResult[] {
  const ftsQuery = buildOrQuery(query);

  // "project" restores the hard partition — only the current project and its
  // related projects. With related projects the current project keeps its own
  // window too, so their docs cannot starve its own out of the pool.
  if (corpus === "project") {
    const projects = corpusProjectIds(projectId, audience);
    const own = ftsCandidates(db, ftsQuery, query, limit, [projectId], sourceKinds, audience, owners);
    if (projects.length === 1) return own;
    return unionById(ftsCandidates(db, ftsQuery, query, limit, projects, sourceKinds, audience, owners), own);
  }

  // "all": recall spans every project, but the current project's own hits
  // must not be starved out of the candidate pool before the project
  // preference in rankCandidates can favor them. Ranking the global top-N on *raw* score
  // would drop a current-project doc that sits just outside that window even
  // when the boost would have pulled it into the final results — the common
  // "search my own project" case. Fetch the current project's own window too
  // and union, so the boost always has its candidates to act on. The scope
  // gate / owner filter ride into BOTH windows so the union is already
  // in-scope; the global window then spans every project's in-audience docs.
  const global = ftsCandidates(db, ftsQuery, query, limit, undefined, sourceKinds, audience, owners);
  const own = ftsCandidates(db, ftsQuery, query, limit, [projectId], sourceKinds, audience, owners);
  return unionById(global, own);
}

// How many chunks to pull from the vec index per requested doc. The KNN
// returns its best chunks, but the rank merge ranks DOCS (one best chunk each), so the
// candidate window must hold enough chunks to still yield the requested number
// of distinct docs once same-doc chunks collapse — and enough that no doc whose
// best chunk would place it in the top set is missed because a few heavily
// chunked docs filled the window first. A generous multiple makes the KNN pool
// a superset of the docs the brute-force scan would surface, so the two paths
// return the same top-K. Env-tunable; a bad or non-positive value falls back.
export const VEC_OVERFETCH = (() => {
  const parsed = Number(process.env.STANDUP_VEC_OVERFETCH);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 16;
})();

// The vec KNN counterpart of getAllChunksWithEmbeddings: fetch the best chunk
// ids from the index (project / kind / scope / owner filters pushed in), then
// hydrate them into the same ChunkWithEmbedding shape the scan returns. For
// corpus:"all" it fetches BOTH the global window and the current project's own
// window and unions them — the exact pair the scan's topDocs()/topDocs(projectId)
// union relies on, so a current-project doc outside the global window still
// reaches the ranking's project bonus.
//
// A scope gate (`audience`) or owner filter is pushed into the KNN as partition
// pre-filters (vecKnnChunkIds decomposes the disjunctive gate into a union of
// per-partition subqueries), so a gated search uses the index instead of the
// brute-force scan and no in-scope doc is starved by a fixed-top-K post-filter.
// getChunksByIds re-applies the SAME gate against the authoritative `knowledge`
// table during hydration: for a correctly decomposed gate that removes nothing
// (the KNN already returned only in-scope chunks), it stands as a NULL-aware
// belt-and-suspenders that can only drop an out-of-scope row, never starve one.
function knnCandidateChunks(
  store: KnowledgeStore,
  queryEmbedding: number[],
  limit: number,
  projectId: string,
  corpus: "project" | "all",
  sourceKinds?: readonly SourceKind[],
  audience?: ScopeAudience,
  owners?: readonly string[]
): ReturnType<KnowledgeStore["getAllChunksWithEmbeddings"]> {
  const k = limit * VEC_OVERFETCH;
  const ids = new Set<string>();
  const addWindow = (pin?: string) => {
    for (const id of store.vecKnnChunkIds(queryEmbedding, k, pin, sourceKinds, audience, owners)) {
      ids.add(id);
    }
  };
  if (corpus === "project") {
    for (const pin of corpusProjectIds(projectId, audience)) addWindow(pin);
  } else {
    addWindow(undefined);
    addWindow(projectId);
  }
  return store.getChunksByIds([...ids], audience, owners);
}

async function searchEmbeddings(
  store: KnowledgeStore,
  projectId: string,
  query: string,
  provider: EmbeddingProvider,
  limit: number,
  corpus: "project" | "all",
  config: EmbeddingConfig,
  sourceKinds?: readonly SourceKind[],
  audience?: ScopeAudience,
  owners?: readonly string[]
): Promise<EmbeddingArm> {
  const none: EmbeddingArm = { results: [], queryEmbedding: null, bestCosine: new Map() };
  // Vectors that may sit in another embedding space than the query's are never
  // scored against it; text search carries retrieval until they are rebuilt.
  if (store.vectorSearchSuspended()) return none;

  // Get query embedding
  const queryEmbedding = await queryEmbeddingFor(query, provider, config);
  if (!queryEmbedding) return none;

  // Gather the candidate chunk pool. Two interchangeable paths that feed the
  // SAME scoring/dedup below, so the results are identical:
  //   - vec KNN (store.vecReady()): the sqlite-vec index returns the top chunks
  //     by cosine directly, so we never touch a chunk outside the candidate
  //     window — the O(all-chunks) JS scan is gone. The project / kind / scope /
  //     owner filters are pushed into the KNN exactly as the scan pushes them
  //     into SQL, including a scope/owner-gated search: the gate becomes vec0
  //     partition pre-filters (a union of per-partition KNN subqueries), so the
  //     launch-injection + search_knowledge + recall paths (which always
  //     gate) use the index without a fixed-top-K post-filter starving an
  //     in-scope doc. A gated search on a vec-enabled host returns the same set
  //     an FTS-only host does.
  //   - brute-force scan (fallback): load every (filtered) chunk. Used whenever
  //     sqlite-vec can't load on this connection, so behavior is preserved on
  //     any host without the extension. It runs over only the in-scope subset
  //     (the gate filters at the DB before the JS cosine), not all chunks, and
  //     remains the correctness reference the KNN parity harness checks against.
  const projects = corpus === "project" ? corpusProjectIds(projectId, audience) : undefined;
  const chunks = store.vecReady()
    ? knnCandidateChunks(store, queryEmbedding, limit, projectId, corpus, sourceKinds, audience, owners)
    : projects === undefined
      ? store.getAllChunksWithEmbeddings(undefined, sourceKinds, audience, owners)
      : projects.flatMap((p) => store.getAllChunksWithEmbeddings(p, sourceKinds, audience, owners));
  if (chunks.length === 0) return { ...none, queryEmbedding };

  // Compute cosine similarity for each chunk
  const scored = chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Every scored doc's best chunk, beyond the arm's top window: the relevance
  // signal reads it for text-arm hits too.
  const bestCosine = new Map<string, number>();
  for (const chunk of scored) {
    if (!bestCosine.has(chunk.knowledgeId)) bestCosine.set(chunk.knowledgeId, chunk.score);
  }

  // Take the top `limit` documents (dedupe chunks down to their doc), from a
  // pre-sorted list optionally narrowed to one project.
  const topDocs = (project?: string): SearchResult[] => {
    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const chunk of scored) {
      if (project !== undefined && chunk.projectId !== project) continue;
      if (seen.has(chunk.knowledgeId)) continue;
      seen.add(chunk.knowledgeId);

      results.push({
        id: chunk.knowledgeId,
        projectId: chunk.projectId,
        slug: chunk.slug,
        title: chunk.title,
        // The whole matched chunk, not a 200-char slice of it. Chunks are
        // already bounded (see chunkMarkdown), so this stays within the same
        // budget the FTS path caps at; the trailing ellipsis only appears on
        // the rare chunk that exceeds it.
        excerpt:
          chunk.text.length > EXCERPT_MAX_LENGTH
            ? chunk.text.slice(0, EXCERPT_MAX_LENGTH).trimEnd() + "…"
            : chunk.text,
        score: chunk.score,
        source: "embedding",
        originClass: chunk.originClass,
        sourceKind: chunk.sourceKind,
        generated: chunk.generated,
        confidence: chunk.confidence,
        lastVerifiedAt: chunk.lastVerifiedAt,
        halfLifeDays: chunk.halfLifeDays,
        verdict: chunk.verdict as DraftVerdict | undefined,
      });

      if (results.length >= limit) break;
    }
    return results;
  };

  // "project" already loaded only the current (and related) projects' chunks.
  // "all" — and "project" with related projects — must union the wider window
  // with the current project's own window for the same reason searchText does:
  // otherwise a current-project doc outside the wider top-N is dropped before
  // the ranking's project bonus could rescue it.
  const results =
    projects !== undefined && projects.length === 1 ? topDocs() : unionById(topDocs(), topDocs(projectId));
  return { results, queryEmbedding, bestCosine };
}

/** How long a query vector is reused, and how many are kept. */
const QUERY_EMBEDDING_TTL_MS = 60_000;
const QUERY_EMBEDDING_CACHE_SIZE = 64;
type QueryEmbeddingCache = Map<string, { at: number; vector: Promise<number[] | null> }>;
// Keyed by the registered plugin object, so re-registering a provider id never
// serves a vector the previous plugin produced.
const queryEmbeddingCaches = new WeakMap<object, QueryEmbeddingCache>();

/**
 * The query's embedding, shared by searches of the same text under the same
 * provider config within a minute — one request that searches twice (launch
 * injection's code and product/spec retrievals of the same brief) embeds once,
 * even when the searches run concurrently. A failed embedding is not kept.
 */
function queryEmbeddingFor(
  query: string,
  provider: EmbeddingProvider,
  config: EmbeddingConfig
): Promise<number[] | null> {
  const plugin = resolveEmbeddingProvider(provider);
  // A caller's own abort signal must govern only its own request, so a
  // signalled embedding is never shared.
  if (!plugin || config.signal) return generateEmbedding(query, provider, config);
  let queryEmbeddings = queryEmbeddingCaches.get(plugin);
  if (!queryEmbeddings) {
    queryEmbeddings = new Map();
    queryEmbeddingCaches.set(plugin, queryEmbeddings);
  }
  const key = JSON.stringify([
    provider,
    config.model ?? null,
    config.baseUrl ?? null,
    config.region ?? null,
    config.dimensions ?? null,
    query,
  ]);
  const now = Date.now();
  const cached = queryEmbeddings.get(key);
  if (cached && now - cached.at < QUERY_EMBEDDING_TTL_MS) return cached.vector;
  const vector = generateEmbedding(query, provider, config).then((v) => {
    if (!v) queryEmbeddings.delete(key);
    return v;
  });
  queryEmbeddings.set(key, { at: now, vector });
  while (queryEmbeddings.size > QUERY_EMBEDDING_CACHE_SIZE) {
    queryEmbeddings.delete(queryEmbeddings.keys().next().value!);
  }
  return vector;
}

/**
 * The embedding arm's ranked docs, plus what the relevance signal needs from
 * it: the query vector and the best-chunk cosine of every doc it scored.
 */
interface EmbeddingArm {
  results: SearchResult[];
  queryEmbedding: number[] | null;
  bestCosine: Map<string, number>;
}

// Ranks one retrieval arm's hits by its OWN score, best first, as 1-based
// positions — the input the RRF merge keys off. The candidate windows
// arrive only partially ordered (searchText/searchEmbeddings union a global slice
// with a current-project slice), so re-sorting here yields one coherent per-arm
// ranking; bm25 and cosine are each computed over the whole index, so a doc's
// score is comparable across the unioned slices. Ties break on id so equal scores
// can't make the fused order depend on upstream iteration order. A doc absent from
// the arm gets no entry — the merge reads that as a 0 contribution from this arm.
function armRanks(results: SearchResult[]): Map<string, number> {
  const ranks = new Map<string, number>();
  // A FULLY-DEGENERATE arm — every candidate tied at the same non-positive score
  // (an embedding arm whose query embedded to all-zeros zeroes every cosine) —
  // expressed NO preference: sorting it produces a pure id-alphabetical order,
  // which would hand whichever doc sorts first an unearned rank-1 RRF term (and
  // so a false top hit) purely on its name. Treat such an arm as if it returned
  // nothing, so a doc only earns an arm's term from an arm that actually ranked
  // it. The text arm's scores are |bm25| over matches (always positive), so this
  // fires only on the degenerate embedding case, never on a real ranking.
  if (results.length === 0 || results.every((r) => r.score <= 0)) return ranks;
  [...results]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .forEach((r) => {
      if (!ranks.has(r.id)) ranks.set(r.id, ranks.size + 1);
    });
  return ranks;
}

function mergeResults(
  textResults: SearchResult[],
  embeddingResults: SearchResult[],
  textWeight: number,
  embeddingWeight: number,
  isLocal: (projectId: string) => boolean,
  query: string,
  graph: { neighbors: SemanticNeighborIndex; seedDepth: number } | undefined,
  weights: RankWeights
): FusedHit[] {
  // Keyed by doc id, not slug: a cross-project search can turn up two docs
  // that share a slug in different projects, and those must not collapse into
  // one row.
  const byId = new Map<
    string,
    SearchResult & { textScore: number; embeddingScore: number; embeddingScoreRaw: number }
  >();

  // Normalize the text arm to [0,1] with the best FTS hit at 1. BM25 magnitudes
  // and 0–1 cosine live on different scales, so putting the text side on the
  // cosine's [0,1] footing lets rawScore's two terms — normalized text and raw
  // cosine, each times its weight — mean what they say. The distiller's near-dup
  // gate is calibrated on rawScore. (The absolute relevance the confidence floors
  // read is computed separately, in candidateFacts.)
  // (The RRF merge below keys off rank POSITION, not these magnitudes, so this
  // normalization feeds rawScore and the `source` label, not the fused order.)
  const maxTextScore = Math.max(...textResults.map((r) => r.score), 1);
  for (const result of textResults) {
    const normalized = result.score / maxTextScore;
    byId.set(result.id, {
      ...result,
      textScore: normalized,
      embeddingScore: 0,
      embeddingScoreRaw: 0,
    });
  }

  // Add embedding scores, keeping BOTH the raw cosine and a copy normalized to
  // the best embedding hit. The raw cosine feeds rawScore, which the distiller's
  // near-dup bar is calibrated on; the normalized copy puts the embedding arm on the text arm's [0,1] footing for the
  // `source` label's which-arm-liked-it-more comparison. Normalization is guarded
  // so a degenerate window (every cosine ≤ 0) is left on its raw scale rather than
  // divided by a non-positive max, which would flip signs and invert the order.
  const maxEmbeddingScore = Math.max(...embeddingResults.map((r) => r.score), 0);
  for (const result of embeddingResults) {
    const normalized =
      maxEmbeddingScore > 0 ? result.score / maxEmbeddingScore : result.score;
    const existing = byId.get(result.id);
    if (existing) {
      existing.embeddingScore = normalized;
      existing.embeddingScoreRaw = result.score;
    } else {
      byId.set(result.id, {
        ...result,
        textScore: 0,
        embeddingScore: normalized,
        embeddingScoreRaw: result.score,
      });
    }
  }

  const queryTerms = extractTerms(query);

  // Rank each arm INDEPENDENTLY by its own score, so the merge keys off rank
  // POSITION, not raw magnitude. BM25 and cosine live on incompatible per-query
  // scales — a doc found by both arms would carry a raw cosine added to a BM25
  // share that never shared a unit — so a weighted SUM lets whichever arm happens
  // to run hotter dominate. RRF, the reciprocal-rank merge (Cormack 2009), sidesteps that:
  // the two arms are ranked separately and a doc scores weight/(RRF_K + rank) from
  // each arm that returned it, 0 from an arm that did not — only the ORDER each
  // arm produces matters.
  //
  // The per-arm term carries the arm's WEIGHT (weighted RRF). An UNweighted sum
  // would drop the tuned text/embedding balance (0.4/0.6) from the fused ORDERING
  // entirely — it would survive only in rawScore — so two docs at rank 1 in
  // different single arms fused identically. Weighting each arm's reciprocal
  // keeps the arm balance in the fused rank: an embedding-arm rank-1 hit
  // contributes 0.6/(k+1) against a text-arm rank-1 hit's 0.4/(k+1).
  const textRank = armRanks(textResults);
  const embeddingRank = armRanks(embeddingResults);

  // Compute two scores per hit that mean different things.
  //
  // rawScore is the weighted fused score (normalized text + RAW cosine, each
  // times its weight), with no title match and no project preference — the scale
  // the distiller's near-dup threshold is calibrated on. Identical for a given
  // doc under both corpus modes.
  //
  // score is a provisional RANKING score: orderingScore's relevance-independent
  // terms (the fused rank, the title match, the local bonus). It orders the
  // graph arm's seeds; rankCandidates computes the final ordering score, with
  // relevance, from `rrf` and the title match carried alongside it.
  //
  // Per-doc components of the fused ranking, computed once so the graph arm can
  // seed from the pre-graph fused order and then be folded back in. baseRrf is
  // the two-arm (text+embedding) fused score.
  const rrfCeiling = (textWeight + embeddingWeight) / (RRF_K + 1);
  const provisionalScore = (rrf: number, titleMatch: number, local: boolean) =>
    orderingScore({ rrf, rrfCeiling, relevance: 0, chunks: 0, titleMatch, local, trust: 1 }, weights);
  const components = Array.from(byId.values()).map((r) => {
    const rawScore = r.textScore * textWeight + r.embeddingScoreRaw * embeddingWeight;
    const baseRrf =
      (textRank.has(r.id) ? textWeight / (RRF_K + textRank.get(r.id)!) : 0) +
      (embeddingRank.has(r.id) ? embeddingWeight / (RRF_K + embeddingRank.get(r.id)!) : 0);
    const local = isLocal(r.projectId);
    const titleMatch = titleMatchRatio(r.title, queryTerms);
    return { r, rawScore, baseRrf, local, titleMatch };
  });

  // The optional THIRD weighted-RRF arm: the semantic-graph neighbor signal, the
  // admit-only lift searchKnowledgeWithGraph pioneered, expressed as one more
  // reciprocal-rank term. Keyed off the pre-graph fused order (the provisional
  // score of the two-arm base), it lets a top hit lend its semantically-near
  // docs a bounded promotion. Admit/boost-only by construction: a doc the graph
  // touches gains a positive term, every other doc gains 0 and keeps its
  // no-graph score, so no doc is demoted below its base rank — it can only be
  // overtaken by a promoted neighbor. Restricted to docs already in this
  // candidate set (which cleared the scope/owner gate in SQL), so the arm never
  // admits an out-of-scope doc the base retrieval withheld.
  const graphArm = new Map<string, number>();
  if (graph) {
    const graphScore = (c: (typeof components)[number]) => provisionalScore(c.baseRrf, c.titleMatch, c.local);
    const baseSorted = [...components].sort(
      (a, b) =>
        graphScore(b) - graphScore(a) ||
        b.rawScore - a.rawScore ||
        a.r.id.localeCompare(b.r.id)
    );
    // Normalize seed scores to [0,1] (top hit = 1), so a stronger seed lends a
    // stronger lift — exactly as searchKnowledgeWithGraph seeds its boost.
    const topScore = baseSorted.length > 0 ? graphScore(baseSorted[0]) : 0;
    const inSet = new Set(components.map((c) => c.r.id));

    // MAX-over-seeds admit-only lift, minSim-gated. The lift MAGNITUDE only
    // RANKS the admitted neighbors; the RRF reciprocal below is what actually
    // scores them, which is why it needs no alpha cap — RRF already bounds the
    // arm's contribution to at most GRAPH_RERANK_WEIGHT/(RRF_K + 1).
    const lift = new Map<string, number>();
    for (const seed of baseSorted.slice(0, graph.seedDepth)) {
      const seedNorm = topScore > 0 ? graphScore(seed) / topScore : 0;
      for (const nb of graph.neighbors.get(seed.r.id) ?? []) {
        if (nb.similarity < GRAPH_RERANK_MIN_SIM) continue;
        if (!inSet.has(nb.docId)) continue;
        const l = seedNorm * nb.similarity;
        if (l > (lift.get(nb.docId) ?? 0)) lift.set(nb.docId, l);
      }
    }

    // Rank the admitted neighbors by lift (ties by id for determinism) and give
    // each the RRF reciprocal for its graph rank — the third arm's contribution.
    [...lift.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([docId], i) => {
        graphArm.set(docId, GRAPH_RERANK_WEIGHT / (RRF_K + (i + 1)));
      });
  }

  const merged: FusedHit[] = components.map(({ r, rawScore, baseRrf, local, titleMatch }) => {
    // The graph arm ADDS to the fused RRF score, so it is scaled consistently
    // with the text/embedding arms and stays admit-only.
    const rrfScore = baseRrf + (graphArm.get(r.id) ?? 0);
    return {
      id: r.id,
      projectId: r.projectId,
      slug: r.slug,
      title: r.title,
      excerpt: r.excerpt,
      score: provisionalScore(rrfScore, titleMatch, local),
      rrf: rrfScore,
      titleMatch,
      rawScore,
      source: r.textScore > r.embeddingScore ? ("text" as const) : ("embedding" as const),
      // Properties of the document, not of how it was found, so the two halves
      // of a merged hit always agree and there is nothing to reconcile here.
      originClass: r.originClass,
      sourceKind: r.sourceKind,
      generated: r.generated,
      confidence: r.confidence,
      lastVerifiedAt: r.lastVerifiedAt,
      halfLifeDays: r.halfLifeDays,
      verdict: r.verdict,
    };
  });

  // Sort by the fused ranking score. Exact RRF ties are structural, not
  // coincidental: two docs that rank-SWAP across the arms — one is the text arm's
  // rank i and the embedding arm's rank j while the other is text-j and
  // embedding-i — fuse to the identical 1/(k+i)+1/(k+j) (float addition is
  // commutative), so a pure score sort would order them by insertion order.
  // Break that tie by ABSOLUTE relevance (rawScore) so the doc the arms scored
  // higher in raw terms leads — this is where the embedding arm's raw cosine
  // decides a rank-swap the rank positions left even. id breaks any remaining tie
  // so the order is deterministic.
  merged.sort(
    (a, b) =>
      b.score - a.score ||
      (b.rawScore ?? 0) - (a.rawScore ?? 0) ||
      a.id.localeCompare(b.id)
  );

  return merged;
}

/** A fused candidate before final ranking: its RRF score and title-match ratio ride along. */
type FusedHit = SearchResult & { rrf: number; titleMatch: number };

/** What the relevance signal and the trust inputs know about one candidate. */
interface CandidateFacts {
  signals: RelevanceSignals;
  /** Tagged `superseded` (a forgotten Persona memory): left out like a superseded verdict. */
  supersededTag: boolean;
  /** valid_to, when the doc's validity interval has one (see temporal.ts). */
  validTo?: string;
  scope: Scope;
  writtenAt?: string;
  chunkCount: number;
  contradiction?: ContradictionState;
}

interface CandidateFactRow {
  id: string;
  project_id: string;
  scope: string | null;
  generated_at: string | null;
  updated_at: string | null;
  disputes_json: string | null;
  tags_json: string | null;
  valid_to: string | null;
  chunks: number;
}

interface CounterpartRow {
  confidence: number | null;
  last_verified_at: string | null;
  half_life_days: number | null;
  generated_at: string | null;
  updated_at: string | null;
  verdict: string | null;
  origin_class: string | null;
}

/** Whether a doc's tags include `superseded`. */
function hasSupersededTag(tagsJson: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags = JSON.parse(tagsJson) as unknown;
    return Array.isArray(tags) && tags.includes("superseded");
  } catch {
    return false;
  }
}

/** Runs one FTS lookup, treating a MATCH expression FTS5 rejects as no rows. */
function ftsRows<T>(db: Database, sql: string, params: string[]): T[] {
  try {
    return db.query(sql).all(...params) as T[];
  } catch (err) {
    console.error("[knowledge] FTS relevance query failed:", err);
    return [];
  }
}

/** Per-phrase FTS facts: how many docs match the phrase, and which of the candidate ids do. */
export interface PhraseFtsStats {
  /** Rows in the FTS index. */
  indexed: number;
  /** One entry per phrase, in the order given. */
  perPhrase: Array<{ matching: number; hits: Set<string> }>;
}

// SQLite's default ceilings on a compound SELECT's arms and a statement's
// bound parameters, with headroom; past either the per-phrase queries run.
const PHRASE_STATS_MAX_ARMS = 400;
const PHRASE_STATS_MAX_PARAMS = 30_000;

/**
 * The FTS index size, and each phrase's corpus-wide match count and matching
 * candidate ids, in ONE statement (a UNION ALL with a count arm and a hits arm
 * per phrase). When that statement cannot run — FTS5 rejects one phrase's
 * MATCH expression, or the query is too large for one statement — it falls
 * back to one query per fact, where a rejected expression reads as no rows
 * for that phrase alone. Either way the result is the same.
 */
export function phraseFtsStats(db: Database, phrases: readonly string[][], ids: readonly string[]): PhraseFtsStats {
  const inIds = `(${ids.map(() => "?").join(", ")})`;
  const arms = ["SELECT -1 AS p, COUNT(*) AS n, NULL AS id FROM knowledge_fts"];
  const params: string[] = [];
  phrases.forEach((phrase, i) => {
    const match = phraseMatch(phrase);
    arms.push(`SELECT ${i}, COUNT(*), NULL FROM knowledge_fts WHERE knowledge_fts MATCH ?`);
    params.push(match);
    arms.push(`SELECT ${i}, NULL, id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND id IN ${inIds}`);
    params.push(match, ...ids);
  });
  if (arms.length <= PHRASE_STATS_MAX_ARMS && params.length <= PHRASE_STATS_MAX_PARAMS) {
    type StatRow = { p: number; n: number | null; id: string | null };
    let rows: StatRow[] | null = null;
    try {
      rows = db.query(arms.join(" UNION ALL ")).all(...params) as StatRow[];
    } catch {
      rows = null;
    }
    if (rows) {
      let indexed = 0;
      const perPhrase = phrases.map(() => ({ matching: 0, hits: new Set<string>() }));
      for (const row of rows) {
        if (row.p < 0) indexed = row.n ?? 0;
        else if (row.id !== null) perPhrase[row.p]!.hits.add(row.id);
        else perPhrase[row.p]!.matching = row.n ?? 0;
      }
      return { indexed, perPhrase };
    }
  }
  return {
    indexed: ftsRows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM knowledge_fts", [])[0]?.n ?? 0,
    perPhrase: phrases.map((phrase) => ({
      matching:
        ftsRows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM knowledge_fts WHERE knowledge_fts MATCH ?", [
          phraseMatch(phrase),
        ])[0]?.n ?? 0,
      hits: new Set(
        ftsRows<{ id: string }>(db, `SELECT id FROM knowledge_fts WHERE knowledge_fts MATCH ? AND id IN ${inIds}`, [
          phraseMatch(phrase),
          ...ids,
        ]).map((r) => r.id)
      ),
    })),
  };
}

/**
 * The relevance signals (bm25, best-chunk cosine, term coverage) and trust
 * facts (scope, write time, chunk count, contradiction side) for every
 * candidate, in a fixed number of queries over the candidate ids. bm25 and
 * coverage go through the FTS index so they see the same stemmed terms the
 * text arm matched on; a candidate the embedding arm never scored (the
 * text-only half of a KNN window) has its best chunk scored here.
 */
function candidateFacts(
  db: Database,
  store: KnowledgeStore,
  candidates: readonly SearchResult[],
  query: string,
  arm: EmbeddingArm,
  names: { bySlug: ReadonlySet<string>; byTitle: ReadonlySet<string>; projectId: string }
): Map<string, CandidateFacts> {
  const facts = new Map<string, CandidateFacts>();
  if (candidates.length === 0) return facts;
  const ids = [...new Set(candidates.map((c) => c.id))];
  const inIds = `(${ids.map(() => "?").join(", ")})`;

  const phrases = queryPhrases(query);
  const bm25 = new Map<string, number>();
  const covered = new Map<string, number>();
  const coveredCommon = new Map<string, number>();
  let bm25Ceiling = 0;
  // Coverage counts the informative phrases (in under half the docs) — the
  // ones bm25 can score; a commoner phrase is FTS5-floored to no idf. When the
  // query has no informative phrase at all (a focused corpus asked about its
  // own subject), coverage counts its common phrases instead, so containing the
  // subject still registers. A smooth idf weighting of every phrase was
  // measured too: on the eval's dev split it cost search recall@5 0.935 → 0.915
  // (common words a doc lacks dragged down partial matches).
  let terms = 0;
  let informative = 0;
  if (phrases.length > 0) {
    const rows = ftsRows<{ id: string; s: number }>(
      db,
      `SELECT id, bm25(knowledge_fts) AS s FROM knowledge_fts WHERE knowledge_fts MATCH ? AND id IN ${inIds}`,
      [phrases.map(phraseMatch).join(" OR "), ...ids]
    );
    for (const row of rows) bm25.set(row.id, Math.max(bm25.get(row.id) ?? 0, Math.abs(row.s)));
    const scored = phrases.filter((phrase) => !phrase.every((piece) => isStopword(piece)));
    const { indexed, perPhrase } = phraseFtsStats(db, scored, ids);
    for (const { matching, hits } of perPhrase) {
      terms++;
      const counts = isInformativePhrase(indexed, matching);
      if (counts) {
        informative++;
        bm25Ceiling += bm25PhraseCeiling(indexed, matching);
      }
      const into = counts ? covered : coveredCommon;
      for (const id of hits) into.set(id, (into.get(id) ?? 0) + 1);
    }
  }

  const rows = db
    .query(
      `SELECT k.id, k.project_id, k.scope, k.generated_at, k.updated_at, k.disputes_json, k.tags_json, k.valid_to,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.knowledge_id = k.id) AS chunks
       FROM knowledge k WHERE k.id IN ${inIds}`
    )
    .all(...ids) as CandidateFactRow[];
  const rowById = new Map(rows.map((r) => [r.id, r] as const));
  const byId = new Map(candidates.map((c) => [c.id, c] as const));

  const counterpart = db.query(
    `SELECT confidence, last_verified_at, half_life_days, generated_at, updated_at, verdict, origin_class
     FROM knowledge WHERE project_id = ? AND slug = ?`
  );
  const now = new Date();
  const band = arm.queryEmbedding ? cosineBandFor(db) : undefined;

  for (const id of ids) {
    const hit = byId.get(id)!;
    const row = rowById.get(id);
    let cosine: number | null = null;
    if (arm.queryEmbedding) {
      cosine = arm.bestCosine.get(id) ?? bestChunkCosine(store, id, arm.queryEmbedding);
    }
    let writtenAt = row?.generated_at ?? row?.updated_at ?? undefined;
    let contradiction: ContradictionState | undefined;
    if (hit.verdict === "contradicted") {
      // The contradiction judgment reads when the content was written, not the
      // file's mtime (an edit or checkout touches it): see contentWrittenAt.
      writtenAt = contentWrittenAt(db, hit.projectId, hit.slug, row?.generated_at ?? null, row?.updated_at ?? null);
      const others = parseDisputeTargets(row?.disputes_json ?? null);
      const self = {
        confidence: hit.confidence,
        lastVerifiedAt: hit.lastVerifiedAt,
        halfLifeDays: hit.halfLifeDays,
        writtenAt,
        verdict: hit.verdict,
        originClass: hit.originClass,
      };
      const outcomes: number[] = [];
      for (const slug of others) {
        const other = counterpart.get(hit.projectId, slug) as CounterpartRow | null;
        if (!other) continue;
        outcomes.push(
          compareContradiction(
            self,
            {
              confidence: other.confidence ?? undefined,
              lastVerifiedAt: other.last_verified_at ?? undefined,
              halfLifeDays: other.half_life_days ?? undefined,
              writtenAt: contentWrittenAt(db, hit.projectId, slug, other.generated_at, other.updated_at),
              verdict: other.verdict ?? undefined,
              originClass: other.origin_class ?? undefined,
            },
            now
          )
        );
      }
      contradiction = {
        side: contradictionSide(outcomes),
        counterparts: others.map((slug) => `${hit.projectId}/${slug}`),
      };
    }
    const coverage =
      informative > 0
        ? (covered.get(id) ?? 0) / informative
        : terms > 0
          ? (coveredCommon.get(id) ?? 0) / terms
          : 0;
    facts.set(id, {
      signals: relevanceSignals({
        bm25: bm25.get(id) ?? 0,
        bm25Ceiling,
        cosine,
        coverage,
        queryTerms: terms,
        informativeTerms: informative,
        chunks: row?.chunks ?? 0,
        named:
          names.bySlug.has(id) ||
          (names.byTitle.has(id) &&
            (hit.projectId === names.projectId ||
              (cosine !== null && band !== undefined && cosine > band.low))),
        ...(band ? { cosineBand: band } : {}),
      }),
      supersededTag: hasSupersededTag(row?.tags_json ?? null),
      ...(row?.valid_to ? { validTo: row.valid_to } : {}),
      scope: (row?.scope as Scope | null) ?? DEFAULT_SCOPE,
      ...(writtenAt ? { writtenAt } : {}),
      chunkCount: row?.chunks ?? 0,
      ...(contradiction ? { contradiction } : {}),
    });
  }
  return facts;
}

/**
 * When a doc's content was written: the index's content_first_seen where the
 * store records it, else generated_at for an agent-drafted doc, else the first
 * time the knowledge log saw it accepted or reconciled, else the row's
 * updated_at (the file's mtime, the weakest signal — any edit or checkout
 * moves it).
 */
function contentWrittenAt(
  db: Database,
  projectId: string,
  slug: string,
  generatedAt: string | null,
  updatedAt: string | null
): string | undefined {
  try {
    // The index's own first-seen date for this content, where the store keeps one.
    const row = db
      .query("SELECT content_first_seen AS first FROM knowledge WHERE project_id = ? AND slug = ?")
      .get(projectId, slug) as { first: string | null } | null;
    if (row?.first) return row.first;
  } catch {
    // An index without the column.
  }
  if (generatedAt) return generatedAt;
  try {
    const row = db
      .query(
        `SELECT MIN(created_at) AS first FROM knowledge_changes
         WHERE project_id = ? AND slug = ? AND kind IN ('accepted', 'reconciled')`
      )
      .get(projectId, slug) as { first: string | null } | null;
    if (row?.first) return row.first.includes("T") ? row.first : `${row.first.replace(" ", "T")}Z`;
  } catch {
    // A bare knowledge index has no change log.
  }
  return updatedAt ?? undefined;
}

/** The slugs a doc's `Contradicts <slug>` disputes name. */
function parseDisputeTargets(disputesJson: string | null): string[] {
  if (!disputesJson) return [];
  try {
    const disputes = JSON.parse(disputesJson) as Array<{ claim?: unknown }>;
    if (!Array.isArray(disputes)) return [];
    const targets = disputes
      .map((d) => (typeof d?.claim === "string" ? parseContradictsClaim(d.claim) : null))
      .filter((s): s is string => s !== null);
    return [...new Set(targets)];
  } catch {
    return [];
  }
}

/** The best cosine of any of a doc's chunks to the query vector; 0 for an unchunked doc. */
function bestChunkCosine(store: KnowledgeStore, docId: string, queryEmbedding: number[]): number {
  let best = 0;
  for (const chunk of store.getChunks(docId)) {
    const cosine = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (cosine > best) best = cosine;
  }
  return best;
}

/** A candidate with its relevance, layer and trust facts attached. */
function withFacts(hit: FusedHit, facts: CandidateFacts | undefined): FusedHit {
  if (!facts) return hit;
  const layer = layerOf({ scope: facts.scope, sourceKind: hit.sourceKind, slug: hit.slug });
  return {
    ...hit,
    relevance: relevanceOf(facts.signals),
    relevanceSignals: facts.signals,
    scope: facts.scope,
    layer,
    chunkCount: facts.chunkCount,
    ...(facts.writtenAt ? { writtenAt: facts.writtenAt } : {}),
    ...(facts.contradiction ? { contradiction: facts.contradiction } : {}),
  };
}

/**
 * A candidate's ordering score:
 *
 *   trust · (relevance + w.rrf · min(1, rrf/rrfCeiling) · megaDocPrior + w.title · titleMatch)
 *     + w.local · [local]
 *
 * — the absolute relevance (which already carries the mega-doc prior), plus
 * the fused rank scaled to [0, 1] by the most the arms can award (every arm at
 * rank 1) and the title-match ratio, each at a small weight on relevance's
 * scale; all three are the doc's evidence, so the trust multiplier scales them
 * together and a demoted doc cannot climb back on its title or rank alone. A
 * local hit (see localProjectTest) adds the project bonus. Every term is
 * additive, so a boost moves a hit by at most its weight: a doc clearly more
 * relevant than another leads it whatever its title or project.
 */
export function orderingScore(
  parts: {
    rrf: number;
    rrfCeiling: number;
    relevance: number;
    chunks: number;
    titleMatch: number;
    local: boolean;
    trust: number;
  },
  weights: RankWeights = RANK_WEIGHTS
): number {
  const fusedRank = parts.rrfCeiling > 0 ? Math.min(1, parts.rrf / parts.rrfCeiling) : 0;
  const evidence =
    parts.relevance + weights.rrf * fusedRank * megaDocPrior(parts.chunks) + weights.title * parts.titleMatch;
  return parts.trust * evidence + (parts.local ? weights.local : 0);
}

/**
 * The final order: every candidate scored by orderingScore. `score` is set to
 * that number, so the order and the score always agree.
 */
function rankCandidates(
  candidates: FusedHit[],
  isLocal: (projectId: string) => boolean,
  textWeight: number,
  embeddingWeight: number,
  weights: RankWeights
): SearchResult[] {
  const now = new Date();
  const scored = candidates.map(({ rrf, titleMatch, ...hit }) => {
    const score = orderingScore(
      {
        rrf,
        rrfCeiling: (textWeight + embeddingWeight) / (RRF_K + 1),
        relevance: hit.relevance ?? hit.rawScore ?? 0,
        chunks: hit.chunkCount ?? 0,
        titleMatch,
        local: isLocal(hit.projectId),
        trust: trustMultiplier(hit, now),
      },
      weights
    );
    return { ...hit, score };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      (b.rawScore ?? 0) - (a.rawScore ?? 0) ||
      a.id.localeCompare(b.id)
  );
  return scored;
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

// How much matched content a hit carries. The old 200-char window was a
// keyhole: too little to assemble a brief or ground a synthesized answer on,
// so every result was a single truncated sentence around the first matched
// term. This returns the whole enclosing Markdown section (the heading at or
// above the match down to the next heading) up to a generous cap, so a hit is
// a coherent unit of the doc rather than a slice of one. Env-tunable because
// the right budget trades context richness against prompt cost, and that is a
// number to measure, not assert.
export const EXCERPT_MAX_LENGTH = (() => {
  const parsed = Number(process.env.KNOWLEDGE_EXCERPT_MAX_LENGTH);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
})();

// The [start, end) of the Markdown section enclosing `index`: from the heading
// line at or before it to the next heading of any level (or the doc bounds if
// the match sits above the first heading or in the last section). A fresh
// regex per call — a shared /g regex carries lastIndex between calls and would
// return different bounds on the same input.
function enclosingSection(body: string, index: number): [number, number] {
  const headingRe = /^#{1,6}[ \t].*$/gm;
  let start = 0;
  let end = body.length;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(body)) !== null) {
    if (match.index <= index) {
      start = match.index;
    } else {
      end = match.index;
      break;
    }
  }
  return [start, end];
}

export function extractExcerpt(
  body: string,
  query: string,
  maxLength = EXCERPT_MAX_LENGTH
): string {
  const bodyLower = body.toLowerCase();

  // Anchor on the most-discriminating query term present in the body. The
  // candidates are the query's stopword-filtered terms ordered longest-first
  // (extractTerms — the same tokenization the code search anchors on), so a
  // natural-language "How/What/Why …" question anchors on its actual subject
  // rather than on a ubiquitous stopword substring ("how" also matches
  // "however"/"shows"), which enclosingSection would resolve to the wrong
  // section. A hit with no discriminating term in the body at all (an
  // embedding-only match, or an all-stopword query) falls back to the doc's
  // opening.
  let matchIndex = -1;
  for (const term of extractTerms(query)) {
    const idx = bodyLower.indexOf(term);
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }
  if (matchIndex === -1) matchIndex = 0;

  const [secStart, secEnd] = enclosingSection(body, matchIndex);

  let start = secStart;
  let end = secEnd;

  // A section can itself exceed the budget (a long doc has some). Center a
  // window on the match, then snap both edges to line boundaries so the
  // excerpt never begins or ends mid-line.
  if (end - start > maxLength) {
    const half = Math.floor(maxLength / 2);
    start = Math.max(secStart, matchIndex - half);
    end = Math.min(secEnd, start + maxLength);
    start = Math.max(secStart, end - maxLength);

    // Snap to line boundaries, but never across the match itself — a section
    // built from one very long line would otherwise let a snap step past the
    // matched term and drop it from the excerpt entirely.
    if (start > secStart) {
      const nl = body.indexOf("\n", start);
      if (nl !== -1 && nl < matchIndex) start = nl + 1;
    }
    if (end < secEnd) {
      const nl = body.lastIndexOf("\n", end);
      if (nl > matchIndex) end = nl;
    }
  }

  const text = body.slice(start, end).trim();
  const prefix = start > 0 ? "…\n" : "";
  const suffix = end < body.length ? "\n…" : "";
  return prefix + text + suffix;
}
