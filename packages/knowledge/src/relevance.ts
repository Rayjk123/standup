import { deriveConfidence } from "./confidence.js";
import type { DraftVerdict, Layer } from "./types.js";

/**
 * Batch-independent relevance for a retrieved doc, and the confidence floors
 * every agent-facing surface gates on.
 *
 * The ranking score (`SearchResult.score`) is relative to its batch — rank
 * positions, and a `rawScore` whose text term is normalized to the batch's best
 * hit, so the top lexical hit of ANY query scores at least the text weight.
 * `relevance` is built only from per-doc quantities that do not move with
 * whatever else was retrieved:
 *
 *  - `text`: the doc's bm25 as a fraction of the most bm25 the query can award
 *    any doc (bm25Ceiling: each informative phrase's idf × (k1 + 1), the limit
 *    of its term as its frequency grows). Raw bm25 is not comparable across
 *    corpora — idf and the average doc length move with the index, so the same
 *    match scores ~25 on a small corpus and ~3 on a large one — but its share of
 *    the ceiling is: it reads "how much of the query's idf mass this doc
 *    carries, damped by term-frequency saturation and length normalization".
 *  - `semantic`: the best chunk's raw cosine, rescaled from the corpus's
 *    calibrated band [low, high] onto [0, 1] (see calibration.ts; the
 *    nomic-embed-text band COSINE_LOW..COSINE_HIGH until a corpus is calibrated).
 *  - `coverage`: the fraction of the query's informative terms the doc contains
 *    (stemmed, through the FTS index) — of its non-stopword terms when none is
 *    informative. A doc that shares one incidental word with a question covers
 *    a small fraction of it however rare that word is, which is what separates
 *    "retry a failed sourdough rise" from a retry runbook.
 *
 * A term is informative when it appears in under half the indexed docs. FTS5
 * floors the idf of a commoner term at ~0, so bm25 — and the text share — sees
 * only informative terms. A query made only of the corpus's common vocabulary
 * (a focused corpus asked about its own subject: "frost watch" in a
 * frost-watch knowledge base) therefore has no lexical share; its coverage
 * factor is neutral and the semantic term decides (relevanceOf). A query of
 * stopwords only has no terms at all.
 *
 * relevance = (TEXT_WEIGHT·text + SEMANTIC_WEIGHT·semantic) · coverageFactor ·
 * lengthPrior, with coverageFactor = COVERAGE_BASE + (1 − COVERAGE_BASE)·coverage.
 * Without an embedding arm there is no semantic term and the lexical share
 * carries the base alone. Every constant is env-tunable; the defaults were
 * calibrated on the dev split of the knowledge eval (packages/knowledge/eval) —
 * the synthetic fixture tier and a real-corpus snapshot together — against its
 * off-topic and expect-empty negatives (see CONFIDENCE_FLOORS).
 */

function envNumber(name: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** FTS5's bm25 term-frequency saturation constant (k1), fixed by SQLite. */
const FTS5_BM25_K1 = 1.2;

/**
 * The most bm25 one query phrase can contribute to any doc: its idf (FTS5's
 * formula, floored at 1e-6 as FTS5 floors it) times k1 + 1. `indexed` is the
 * FTS row count, `matching` the rows the phrase matches.
 */
export function bm25PhraseCeiling(indexed: number, matching: number): number {
  const idf = Math.log((indexed - matching + 0.5) / (matching + 0.5));
  return (idf > 0 ? idf : 1e-6) * (FTS5_BM25_K1 + 1);
}

/**
 * Whether a phrase carries lexical evidence: its idf is positive, i.e. it
 * matches fewer than half the indexed docs. FTS5 floors any other phrase's idf
 * at 1e-6, so its bm25 contribution is noise.
 */
export function isInformativePhrase(indexed: number, matching: number): boolean {
  return Math.log((indexed - matching + 0.5) / (matching + 0.5)) > 0;
}

/** Multiplier on the bm25 share before it is capped at 1. */
export const TEXT_SCALE = envNumber("KNOWLEDGE_RELEVANCE_TEXT_SCALE", 1, Number.MIN_VALUE);
/**
 * The default cosine band — measured for nomic-embed-text — used until a corpus
 * has its own calibration (calibration.ts): at or below COSINE_LOW a chunk
 * carries no semantic evidence, at or above COSINE_HIGH it is a full match.
 */
export const COSINE_LOW = envNumber("KNOWLEDGE_RELEVANCE_COSINE_LOW", 0.45, -1, 1);
export const COSINE_HIGH = envNumber("KNOWLEDGE_RELEVANCE_COSINE_HIGH", 0.75, -1, 1);

/** A cosine band: [low, high] maps onto [0, 1] semantic evidence. */
export interface CosineBand {
  low: number;
  high: number;
}

export const DEFAULT_COSINE_BAND: CosineBand = { low: COSINE_LOW, high: COSINE_HIGH };
export const RELEVANCE_TEXT_WEIGHT = envNumber("KNOWLEDGE_RELEVANCE_TEXT_WEIGHT", 0.5, 0, 1);
export const RELEVANCE_SEMANTIC_WEIGHT = envNumber("KNOWLEDGE_RELEVANCE_SEMANTIC_WEIGHT", 0.5, 0, 1);
/** The coverage factor's value for a doc matching none of the query's terms. */
export const COVERAGE_BASE = envNumber("KNOWLEDGE_RELEVANCE_COVERAGE_BASE", 0.5, 0, 1);
/**
 * Without an embedding arm, the lexical share a doc earns by containing a query
 * made only of the corpus's common words (relevanceOf): half the weight of a
 * full bm25 share, so it reaches a floor only by covering the whole query.
 */
export const COMMON_TERMS_SHARE = envNumber("KNOWLEDGE_RELEVANCE_COMMON_TERMS_SHARE", 0.5, 0, 1);


/** The per-doc inputs `relevance` is computed from, carried on every result. */
export interface RelevanceSignals {
  /** |bm25| of the doc for the query over the whole index; 0 = no lexical match. */
  bm25: number;
  /** The most bm25 the query can award any doc (Σ phrase idf × (k1 + 1)). */
  bm25Ceiling: number;
  /** min(1, TEXT_SCALE · bm25 / bm25Ceiling). */
  text: number;
  /** The best chunk's raw cosine to the query; null when there is no embedding arm. */
  cosine: number | null;
  /** The cosine rescaled onto [0, 1] through `cosineBand` (0 when there is no embedding arm). */
  semantic: number;
  /** The band the cosine was rescaled through, and whether it was calibrated on this corpus. */
  cosineBand?: CosineBand & { calibrated: boolean };
  /**
   * The fraction of the query's informative terms present in the doc, [0, 1];
   * of its non-stopword terms when none is informative.
   */
  coverage: number;
  /** How many non-stopword terms the query had. */
  queryTerms: number;
  /**
   * How many of them are informative (in under half the indexed docs) — the
   * terms bm25 scores at all. 0 means the query's words are this corpus's
   * common vocabulary and the lexical share carries no evidence.
   */
  informativeTerms: number;
  /** How many chunks the doc is indexed as. */
  chunks: number;
  /** The mega-doc prior for that chunk count (see megaDocPrior), in (0, 1]. */
  lengthPrior: number;
  /** True when the query names this doc (its slug, quoted or qualified, or its full title). */
  named?: boolean;
}

export function scaleCosine(cosine: number, band: CosineBand = DEFAULT_COSINE_BAND): number {
  if (band.high <= band.low) return cosine >= band.high ? 1 : 0;
  return Math.max(0, Math.min(1, (cosine - band.low) / (band.high - band.low)));
}

/** Builds the signal record for a doc from its raw bm25, cosine and coverage. */
export function relevanceSignals(input: {
  bm25: number;
  bm25Ceiling: number;
  cosine: number | null;
  coverage: number;
  queryTerms: number;
  informativeTerms?: number;
  chunks?: number;
  named?: boolean;
  cosineBand?: CosineBand & { calibrated: boolean };
}): RelevanceSignals {
  const chunks = Math.max(0, input.chunks ?? 0);
  const bm25 = Math.max(0, input.bm25);
  const ceiling = Math.max(0, input.bm25Ceiling);
  const band = input.cosineBand ?? { ...DEFAULT_COSINE_BAND, calibrated: false };
  return {
    bm25,
    bm25Ceiling: ceiling,
    text: ceiling > 0 ? Math.min(1, (TEXT_SCALE * bm25) / ceiling) : 0,
    cosine: input.cosine,
    semantic: input.cosine === null ? 0 : scaleCosine(input.cosine, band),
    ...(input.cosine === null ? {} : { cosineBand: band }),
    coverage: Math.max(0, Math.min(1, input.coverage)),
    queryTerms: input.queryTerms,
    informativeTerms: input.informativeTerms ?? input.queryTerms,
    chunks,
    lengthPrior: megaDocPrior(chunks),
    ...(input.named ? { named: true } : {}),
  };
}

/**
 * The absolute relevance in [0, 1] (see the module comment), scaled by the
 * mega-doc prior: a very long doc contains most terms of most questions and has
 * a chunk near many of them, so its coverage and best cosine overstate how much
 * it is about any one question. A named doc is 1.
 */
export function relevanceOf(s: RelevanceSignals): number {
  if (s.named) return 1;
  // Without an embedding arm the lexical share is the only evidence: a doc that
  // merely contains every query term (coverage 1) but carries little of the
  // query's idf mass is not a confident match on coverage alone. When the
  // query's words are all the corpus's common vocabulary (a focused corpus
  // asked about its own subject) bm25 scores nothing, so the term coverage,
  // at COMMON_TERMS_SHARE, stands in for the share.
  const lexical = s.informativeTerms === 0 && s.queryTerms > 0 ? COMMON_TERMS_SHARE * s.coverage : s.text;
  const base =
    s.cosine === null
      ? lexical
      : (RELEVANCE_TEXT_WEIGHT * s.text + RELEVANCE_SEMANTIC_WEIGHT * s.semantic) /
        Math.max(RELEVANCE_TEXT_WEIGHT + RELEVANCE_SEMANTIC_WEIGHT, Number.MIN_VALUE);
  // Coverage scales the base, except when the corpus's common vocabulary is all
  // the query has: then containing it says nothing either way, and the factor is
  // neutral so the semantic term carries the match.
  const coverageFactor =
    s.informativeTerms === 0 && s.queryTerms > 0 && s.cosine !== null
      ? 1
      : COVERAGE_BASE + (1 - COVERAGE_BASE) * s.coverage;
  return Math.max(0, Math.min(1, base * coverageFactor * s.lengthPrior));
}

/** The surfaces that gate on confidence; each may carry its own floor. */
export type ConfidenceSurface = "search" | "inject";

/**
 * Minimum `relevance` for a hit to count as a confident match on each surface.
 * search_knowledge answers "no confident match" below it, and launch injection
 * never injects one. Separate constants so a surface can trade recall against
 * noise on its own. Swept on the eval's dev split with each tier's calibrated
 * band (fixture search recall@5 / negative empty-rate): 0.16 → 0.935 / 0.867,
 * 0.18 → 0.935 / 1.0, 0.20 → 0.915 / 1.0 (a weak labeled answer drops out). So
 * search keeps 0.18; injection, whose recall holds at 0.20 (0.923), takes 0.20
 * for its precision (0.614 → 0.643).
 */
export const CONFIDENCE_FLOORS: Readonly<Record<ConfidenceSurface, number>> = {
  search: envNumber("KNOWLEDGE_CONFIDENCE_FLOOR_SEARCH", 0.18, 0, 1),
  inject: envNumber("KNOWLEDGE_CONFIDENCE_FLOOR_INJECT", 0.2, 0, 1),
};

/**
 * Whether a hit is a confident match for `surface`. A hit with no `relevance`
 * (a backend that only ranks) is not confident: its `rawScore` is relative to
 * its batch, so the best hit of any query would pass, and an unmeasured hit is
 * never presented as a match.
 */
export function isConfident(
  hit: { relevance?: number; relevanceSignals?: RelevanceSignals },
  surface: ConfidenceSurface
): boolean {
  if (hit.relevanceSignals?.named) return true;
  const relevance = hit.relevance;
  if (relevance === undefined || !Number.isFinite(relevance)) return false;
  return relevance >= CONFIDENCE_FLOORS[surface];
}

/**
 * Where a contradicted doc stands against the doc(s) it contradicts:
 * `losing` when a counterpart outranks it (see contradictionKey), `winning`
 * when it outranks every counterpart, `undecided` when a counterpart ties it
 * (or no counterpart is known). Only the losing side is held out of answers; an
 * undecided pair is shown with a conflict marker.
 */
export type ContradictionSide = "losing" | "winning" | "undecided";

export interface ContradictionState {
  side: ContradictionSide;
  /** `project/slug` of each doc this one contradicts. */
  counterparts: string[];
}

/** The facts the contradiction judgment compares between two docs. */
export interface ContradictionParty {
  confidence?: number;
  lastVerifiedAt?: string;
  halfLifeDays?: number;
  /** When the doc's content was last written: generated_at, else updated_at. */
  writtenAt?: string;
  verdict?: DraftVerdict | string;
  /** Who wrote it: an owner-authored doc is affirmed when written; an agent's only when verified. */
  originClass?: string;
}

const DAY_MS = 86_400_000;

function dayOf(iso: string | undefined): number | undefined {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : undefined;
}

/**
 * A contradicted doc's standing as a tuple compared left to right, so the
 * judgment is a total order — three docs can never each lose to the next:
 *
 *  1. not already settled (a superseded or disputed doc has lost);
 *  2. the day it was last affirmed — written or verified, whoever wrote it;
 *  3. its current confidence, in tenths;
 *  4. the day it was written;
 *  5. owner-authored over agent-written, as the last tiebreaker only.
 *
 * Authorship is last because it says little about which side is true: the
 * stale side of most real conflicts is owner-written. A missing field ranks
 * lowest.
 */
export function contradictionKey(p: ContradictionParty, now = new Date()): number[] {
  const settled = p.verdict === "superseded" || p.verdict === "disputed" ? 0 : 1;
  const verified = dayOf(p.lastVerifiedAt);
  const written = dayOf(p.writtenAt);
  const affirmed = Math.max(verified ?? -Infinity, written ?? -Infinity);
  const confidence = deriveConfidence(p, now);
  return [
    settled,
    affirmed,
    confidence === undefined ? -Infinity : Math.floor(confidence * 10 + 1e-9),
    written ?? -Infinity,
    p.originClass === "owner" ? 1 : 0,
  ];
}

/**
 * Compares a contradicted doc with one counterpart by contradictionKey: +1
 * when the doc wins, −1 when it loses, 0 when every component ties or both
 * unsettled sides were last affirmed the same day.
 */
export function compareContradiction(doc: ContradictionParty, other: ContradictionParty, now = new Date()): number {
  const a = contradictionKey(doc, now);
  const b = contradictionKey(other, now);
  // Two unsettled sides affirmed the same day are one moment's disagreement:
  // neither is the later truth, whoever wrote them, so both are shown with a
  // conflict marker. (Turning some pairs into ties keeps the order acyclic:
  // every strict win left is one the key order makes.)
  if (a[0] === 1 && b[0] === 1 && Number.isFinite(a[1]) && a[1] === b[1]) return 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** The side a contradicted doc takes across all its counterparts: losing to any one loses. */
export function contradictionSide(outcomes: readonly number[]): ContradictionSide {
  if (outcomes.some((o) => o < 0)) return "losing";
  if (outcomes.length > 0 && outcomes.every((o) => o > 0)) return "winning";
  return "undecided";
}

/**
 * Ranking multipliers on a contradicted doc: its losing side, and a side that
 * is not losing. Mild on purpose — the doc is also marked wherever it is shown,
 * and on the eval's dev split a harder demotion (×0.5 or ×0.8 on the losing
 * side) cost recall and fresh-over-stale ordering where the losing side is
 * still a doc the question asks about, while ×0.9 / ×0.95 stayed within 0.003
 * MRR@10 of no demotion.
 */
export const CONTRADICTION_LOSING_WEIGHT = envNumber("KNOWLEDGE_CONTRADICTION_LOSING_WEIGHT", 0.9, 0, 1);
export const CONTRADICTION_OPEN_WEIGHT = envNumber("KNOWLEDGE_CONTRADICTION_OPEN_WEIGHT", 0.95, 0, 1);
/**
 * Ranking multiplier on a doc the re-verification pass disputed. It replaces
 * the confidence term (a dispute writes confidence down to DISPUTED_CONFIDENCE,
 * so counting both would demote the doc twice): a clean doc of similar
 * relevance ranks above it, and a disputed doc that matches about a third
 * better than the best clean one still leads, marked. Most disputes the
 * re-verifier raises don't hold on main, so the demotion stays near what the
 * written-down confidence alone used to cost (×0.73) rather than harsher.
 */
export const DISPUTED_RANK_WEIGHT = envNumber("KNOWLEDGE_DISPUTED_RANK_WEIGHT", 0.75, 0, 1);
/**
 * How much a doc's current confidence moves its rank: the multiplier is
 * 1 − CONFIDENCE_RANK_WEIGHT·(1 − confidence), so a doc at full confidence is
 * untouched and one at zero loses CONFIDENCE_RANK_WEIGHT of its score.
 */
export const CONFIDENCE_RANK_WEIGHT = envNumber("KNOWLEDGE_CONFIDENCE_RANK_WEIGHT", 0.3, 0, 1);
/** Half-life of an activity note's rank, in days, when the note carries none of its own. */
export const ACTIVITY_HALF_LIFE_DAYS = envNumber("KNOWLEDGE_ACTIVITY_HALF_LIFE_DAYS", 30, Number.MIN_VALUE);
/** The lowest an activity note's age can take its rank multiplier. */
export const ACTIVITY_DECAY_FLOOR = envNumber("KNOWLEDGE_ACTIVITY_DECAY_FLOOR", 0.25, 0, 1);

/**
 * The trust part of a hit's rank: a disputed doc takes DISPUTED_RANK_WEIGHT in
 * place of its confidence term, a contradicted doc is demoted (the losing side
 * harder), a stored confidence below full lowers it mildly, and an activity
 * note decays with its age over its half-life. 1 for a doc with no such state.
 */
export function trustMultiplier(
  hit: {
    verdict?: DraftVerdict | string;
    contradiction?: ContradictionState;
    confidence?: number;
    lastVerifiedAt?: string;
    halfLifeDays?: number;
    layer?: Layer;
    writtenAt?: string;
  },
  now = new Date()
): number {
  let m = 1;
  if (hit.verdict === "contradicted") {
    m *= hit.contradiction?.side === "losing" ? CONTRADICTION_LOSING_WEIGHT : CONTRADICTION_OPEN_WEIGHT;
  }
  if (hit.verdict === "disputed") {
    m *= DISPUTED_RANK_WEIGHT;
  } else {
    const confidence = deriveConfidence(hit, now);
    if (confidence !== undefined) m *= 1 - CONFIDENCE_RANK_WEIGHT * (1 - confidence);
  }
  if (hit.layer === "activity") {
    const written = Date.parse(hit.writtenAt ?? "");
    if (Number.isFinite(written)) {
      const ageDays = Math.max(0, (now.getTime() - written) / 86_400_000);
      const halfLife = hit.halfLifeDays && hit.halfLifeDays > 0 ? hit.halfLifeDays : ACTIVITY_HALF_LIFE_DAYS;
      m *= Math.max(ACTIVITY_DECAY_FLOOR, Math.pow(0.5, ageDays / halfLife));
    }
  }
  return m;
}

/**
 * Chunk count above which a doc starts paying the mega-doc prior (about 30 KB
 * of prose with the markdown chunker), and the prior's strength (0 disables
 * it). On the eval's dev split 0.5 above 20 chunks, against no prior, lifted
 * the fixture's negative empty-rate 0.898 → 0.939 and citation precision
 * 0.294 → 0.320, and the real-corpus snapshot's recall@5 0.560 → 0.580; a
 * threshold of 8 chunks cost Persona's recall of the owner's CLAUDE.md.
 */
export const MEGA_DOC_CHUNKS = envNumber("KNOWLEDGE_MEGA_DOC_CHUNKS", 20, 1);
export const MEGA_DOC_PRIOR_WEIGHT = envNumber("KNOWLEDGE_MEGA_DOC_PRIOR_WEIGHT", 0.5, 0);

/**
 * Ranking multiplier for a doc indexed as many chunks. A very long doc mentions
 * nearly every term and its best chunk is close to many queries, so it wins
 * rank 0 on questions it only touches; the prior divides by
 * 1 + MEGA_DOC_PRIOR_WEIGHT·ln(chunks / MEGA_DOC_CHUNKS) above the threshold.
 */
export function megaDocPrior(chunks: number): number {
  if (MEGA_DOC_PRIOR_WEIGHT === 0 || chunks <= MEGA_DOC_CHUNKS) return 1;
  return 1 / (1 + MEGA_DOC_PRIOR_WEIGHT * Math.log(chunks / MEGA_DOC_CHUNKS));
}

/**
 * Whether a hit's verification verdict lets it be fed to an agent. A
 * superseded doc (the losing side of a resolved contradiction) never is. A
 * disputed doc is: its rank is demoted (DISPUTED_RANK_WEIGHT) and every surface
 * shows it with its dispute marker. A contradicted doc is held out only on its
 * losing side: the winning side is fed, and both sides of an undecided pair are
 * fed with a conflict marker on every surface. A contradicted doc whose side is
 * unknown is held out.
 */
export function isVerdictAdmissible(
  hit: { verdict?: DraftVerdict | string; contradiction?: ContradictionState },
  // Every surface applies the same rule; the parameter keeps call sites explicit.
  _surface: ConfidenceSurface
): boolean {
  if (hit.verdict === "superseded") return false;
  if (hit.verdict !== "contradicted") return true;
  const side = hit.contradiction?.side;
  if (side === "winning") return true;
  // Both sides of an undecided pair are fed, each with a conflict marker.
  return side === "undecided";
}
