import { createHash } from "crypto";
import {
  ACTIVITY_DECAY_FLOOR,
  ACTIVITY_HALF_LIFE_DAYS,
  ACTIVITY_INJECT_MAX_AGE_DAYS,
  ACTIVITY_INJECT_MIN_RELEVANCE,
  CALIBRATION_CHUNK_SAMPLE,
  CALIBRATION_LOW_QUANTILE,
  CALIBRATION_TITLE_SAMPLE,
  COMMON_TERMS_SHARE,
  CONFIDENCE_FLOORS,
  CONFIDENCE_RANK_WEIGHT,
  CONTRADICTION_LOSING_WEIGHT,
  CONTRADICTION_OPEN_WEIGHT,
  COVERAGE_BASE,
  DEFAULT_COSINE_BAND,
  DEFAULT_HALF_LIFE_DAYS,
  DISPUTED_CONFIDENCE,
  DISPUTED_RANK_WEIGHT,
  FOREIGN_INTENT_INJECT_MIN_RELEVANCE,
  GRAPH_DEFAULTS,
  GRAPH_RERANK_ENABLED,
  GRAPH_RERANK_MIN_SIM,
  GRAPH_RERANK_WEIGHT,
  INJECTION_RRF_K,
  MAX_INJECTION_QUERIES,
  MEGA_DOC_CHUNKS,
  MEGA_DOC_PRIOR_WEIGHT,
  MIN_INJECTION_CONFIDENCE,
  MIRROR_NEAR_DUP_CONTAINMENT,
  MIRROR_NEAR_DUP_JACCARD,
  NEAR_IDENTICAL_JACCARD,
  OFF_DOMAIN_PROBES,
  OTHER_PROJECT_PREFERENCE,
  PUSH_MAX_CHARS,
  PUSH_MAX_DOCS,
  PUSH_RELEVANCE_BARS,
  PUSH_SEARCH_LIMIT,
  RANK_RRF_SHARE,
  RANK_WEIGHTS,
  RELEVANCE_SEMANTIC_WEIGHT,
  RELEVANCE_TEXT_WEIGHT,
  RERANK_TOP_N,
  RRF_K,
  SEARCH_DEFAULT_OPTIONS,
  STATUS_HALF_LIFE_DAYS,
  TEXT_SCALE,
  TITLE_BOOST_WEIGHT,
  VEC_OVERFETCH,
} from "@standup/knowledge";
import { MISSING_MENTION_DEMOTION } from "./knowledge-code-mentions.js";
import {
  ACTIVITY_PASS_LIMIT,
  CODE_INJECT_CHAR_BUDGET,
  MAX_CODE_DOCS,
  MAX_PRODUCT_DOCS,
  PRODUCT_INJECT_CHAR_BUDGET,
} from "./launcher.js";
import { GATED_CANDIDATES_PER_QUERY } from "./retrieval-telemetry.js";

/**
 * A short hash over every constant that moves a retrieval score's scale or a
 * hit's admission, as this process resolved them. Run with no RANKING_ENV_VARS
 * set, it fingerprints the built-in values ALGO_VERSION names; the algo-version
 * test runs this file in such a process (`bun algo-fingerprint.ts` prints it).
 */
export function rankingFingerprint(): string {
  const constants = {
    search: {
      textWeight: SEARCH_DEFAULT_OPTIONS.textWeight,
      embeddingWeight: SEARCH_DEFAULT_OPTIONS.embeddingWeight,
      limit: SEARCH_DEFAULT_OPTIONS.limit,
      rrfK: RRF_K,
      rankRrfShare: RANK_RRF_SHARE,
      otherProjectPreference: OTHER_PROJECT_PREFERENCE,
      titleBoostWeight: TITLE_BOOST_WEIGHT,
      graphRerankEnabled: GRAPH_RERANK_ENABLED,
      graphRerankWeight: GRAPH_RERANK_WEIGHT,
      graphRerankMinSim: GRAPH_RERANK_MIN_SIM,
      graphDefaults: GRAPH_DEFAULTS,
      vecOverfetch: VEC_OVERFETCH,
      confidenceRankWeight: CONFIDENCE_RANK_WEIGHT,
      contradictionLosingWeight: CONTRADICTION_LOSING_WEIGHT,
      contradictionOpenWeight: CONTRADICTION_OPEN_WEIGHT,
      disputedRankWeight: DISPUTED_RANK_WEIGHT,
      activityHalfLifeDays: ACTIVITY_HALF_LIFE_DAYS,
      activityDecayFloor: ACTIVITY_DECAY_FLOOR,
      megaDocChunks: MEGA_DOC_CHUNKS,
      megaDocPriorWeight: MEGA_DOC_PRIOR_WEIGHT,
      rankWeights: RANK_WEIGHTS,
      rerankTopN: RERANK_TOP_N,
      missingMentionDemotion: MISSING_MENTION_DEMOTION,
      nearIdenticalJaccard: NEAR_IDENTICAL_JACCARD,
      mirrorNearDupJaccard: MIRROR_NEAR_DUP_JACCARD,
      mirrorNearDupContainment: MIRROR_NEAR_DUP_CONTAINMENT,
    },
    relevance: {
      textScale: TEXT_SCALE,
      defaultCosineBand: DEFAULT_COSINE_BAND,
      textWeight: RELEVANCE_TEXT_WEIGHT,
      semanticWeight: RELEVANCE_SEMANTIC_WEIGHT,
      coverageBase: COVERAGE_BASE,
      commonTermsShare: COMMON_TERMS_SHARE,
      calibrationLowQuantile: CALIBRATION_LOW_QUANTILE,
      calibrationTitleSample: CALIBRATION_TITLE_SAMPLE,
      calibrationChunkSample: CALIBRATION_CHUNK_SAMPLE,
      offDomainProbes: OFF_DOMAIN_PROBES,
    },
    gates: {
      minInjectionConfidence: MIN_INJECTION_CONFIDENCE,
      disputedConfidence: DISPUTED_CONFIDENCE,
      defaultHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      statusHalfLifeDays: STATUS_HALF_LIFE_DAYS,
      confidenceFloors: CONFIDENCE_FLOORS,
    },
    injection: {
      maxCodeDocs: MAX_CODE_DOCS,
      maxProductDocs: MAX_PRODUCT_DOCS,
      codeCharBudget: CODE_INJECT_CHAR_BUDGET,
      productCharBudget: PRODUCT_INJECT_CHAR_BUDGET,
      injectionRrfK: INJECTION_RRF_K,
      maxInjectionQueries: MAX_INJECTION_QUERIES,
      activityPassLimit: ACTIVITY_PASS_LIMIT,
      activityMinRelevance: ACTIVITY_INJECT_MIN_RELEVANCE,
      activityMaxAgeDays: ACTIVITY_INJECT_MAX_AGE_DAYS,
      foreignIntentMinRelevance: FOREIGN_INTENT_INJECT_MIN_RELEVANCE,
    },
    push: {
      relevanceBars: PUSH_RELEVANCE_BARS,
      maxDocs: PUSH_MAX_DOCS,
      maxChars: PUSH_MAX_CHARS,
      searchLimit: PUSH_SEARCH_LIMIT,
    },
    telemetry: { gatedPerQuery: GATED_CANDIDATES_PER_QUERY },
  };
  return createHash("sha256").update(JSON.stringify(constants)).digest("hex").slice(0, 16);
}

if (import.meta.main) {
  process.stdout.write(rankingFingerprint());
}
