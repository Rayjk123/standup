/**
 * The revision of the retrieval algorithm — ranking, rank merging, boosts, floors and
 * the injection gates — stamped on every knowledge_retrievals row, so recorded
 * scores are only ever compared with scores produced by the same algorithm.
 *
 * Bump it in the same change as anything that moves a score's scale or a hit's
 * admission: the search rank merge or arm weights, the ordering-score weights, the
 * graph rerank, a relevance floor, an injection gate, or the candidate windows.
 * Format: `<YYYY-MM-DD>.<n>` — the date of the change and a same-day counter.
 * A change that only reorders ties, or touches no score, leaves it alone. The
 * collector's algo-version test pins this to the built-in values of those
 * constants and fails until it is bumped.
 */
export const ALGO_VERSION = "2026-10-10.3";

/**
 * Environment variables that override a ranking or gating constant at runtime.
 * With any of them set, the running algorithm is not the one ALGO_VERSION
 * names, so rows are stamped `<ALGO_VERSION>+env` (effectiveAlgoVersion).
 */
export const RANKING_ENV_VARS: readonly string[] = [
  "KNOWLEDGE_OTHER_PROJECT_PREFERENCE",
  "KNOWLEDGE_RANK_RRF_SHARE",
  "KNOWLEDGE_TITLE_BOOST_WEIGHT",
  "KNOWLEDGE_RRF_K",
  "KNOWLEDGE_GRAPH_RERANK",
  "KNOWLEDGE_GRAPH_RERANK_WEIGHT",
  "KNOWLEDGE_GRAPH_RERANK_MIN_SIM",
  "KNOWLEDGE_MIN_INJECTION_CONFIDENCE",
  "KNOWLEDGE_STATUS_HALF_LIFE_DAYS",
  "KNOWLEDGE_CONFIDENCE_FLOOR_SEARCH",
  "KNOWLEDGE_CONFIDENCE_FLOOR_INJECT",
  "KNOWLEDGE_RELEVANCE_TEXT_SCALE",
  "KNOWLEDGE_RELEVANCE_COSINE_LOW",
  "KNOWLEDGE_RELEVANCE_COSINE_HIGH",
  "KNOWLEDGE_RELEVANCE_TEXT_WEIGHT",
  "KNOWLEDGE_RELEVANCE_SEMANTIC_WEIGHT",
  "KNOWLEDGE_RELEVANCE_COVERAGE_BASE",
  "KNOWLEDGE_RELEVANCE_COMMON_TERMS_SHARE",
  "KNOWLEDGE_CALIBRATION_LOW_QUANTILE",
  "KNOWLEDGE_CONTRADICTION_LOSING_WEIGHT",
  "KNOWLEDGE_CONTRADICTION_OPEN_WEIGHT",
  "KNOWLEDGE_DISPUTED_RANK_WEIGHT",
  "KNOWLEDGE_CONFIDENCE_RANK_WEIGHT",
  "KNOWLEDGE_ACTIVITY_HALF_LIFE_DAYS",
  "KNOWLEDGE_ACTIVITY_DECAY_FLOOR",
  "KNOWLEDGE_MEGA_DOC_CHUNKS",
  "KNOWLEDGE_MEGA_DOC_PRIOR_WEIGHT",
  "STANDUP_VEC_OVERFETCH",
  "GENERATED_PROVENANCE_WEIGHT",
  "STANDUP_PRODUCT_INJECT_MAX_DOCS",
  "STANDUP_PRODUCT_INJECT_CHAR_BUDGET",
  "STANDUP_CODE_INJECT_MAX_DOCS",
  "STANDUP_CODE_INJECT_CHAR_BUDGET",
];

/** ALGO_VERSION, suffixed `+env` when any RANKING_ENV_VARS override is set in `env`. */
export function effectiveAlgoVersion(env: Record<string, string | undefined> = process.env): string {
  return RANKING_ENV_VARS.some((name) => (env[name] ?? "").trim() !== "") ? `${ALGO_VERSION}+env` : ALGO_VERSION;
}
