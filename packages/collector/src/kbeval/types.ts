/**
 * Shared shapes for the knowledge eval (see packages/knowledge/eval/FORMAT.md
 * for the on-disk data contract these mirror).
 */

export const SURFACES = ["search", "code", "inject", "persona"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * What a case's surfaces expand to when run. A `persona` case is measured
 * twice: `persona` is the set of docs in Persona's context (system prompt plus
 * worker-brief preferences), and `persona-recall` is its ranked `recall` tool.
 */
export const RUN_SURFACES = ["search", "code", "inject", "persona", "persona-recall"] as const;
export type RunSurface = (typeof RUN_SURFACES)[number];

/** Run surfaces measured as an unranked set of docs in context; they carry no ranked metrics. */
export const CONTEXT_SURFACES: readonly RunSurface[] = ["persona"];

export function runSurfacesFor(surface: Surface): RunSurface[] {
  return surface === "persona" ? ["persona", "persona-recall"] : [surface];
}

export const CATEGORIES = [
  "docs",
  "code",
  "personal",
  "leakage",
  "offtopic",
  "staleness",
  "inject",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Split = "dev" | "holdout";

/** One graded relevance label: a knowledge doc (`project/slug`) or a code location (`path[:symbol|line]`). */
export interface RelevanceLabel {
  doc?: string;
  code?: string;
  grade: number;
}

export interface EvalCase {
  id: string;
  category: Category;
  surface: Surface[];
  audience: { projectId: string; user?: string };
  query: string;
  relevant: RelevanceLabel[];
  forbidden?: string[];
  expectEmpty?: boolean;
  staleOver?: Array<[string, string]>;
  /** Docs whose claims are false today; returning one unflagged is a stale hit. */
  staleDocs?: string[];
  /** Agent-labeled, not human-verified; metrics are also reported gold vs silver. */
  silver?: boolean;
  source?: string;
  note?: string;
}

/** Markers a surface exposes on a hit, as the consumer of that surface sees them. */
export interface HitFlags {
  /** Re-verification / coherence verdict carried on the hit, when the surface returns it. */
  verdict?: string;
  /** The search route's trust+freshness flag, when the surface returns it. */
  injectionEligible?: boolean;
  /** Current (decayed) confidence, when the surface returns it. */
  currentConfidence?: number;
  /**
   * True when the surface shows the consumer a stale/disputed/low-confidence
   * marker for this hit (e.g. the search_knowledge formatter's ⚠ lines).
   */
  marked: boolean;
}

/**
 * One ranked hit. `ref` is `project/slug` for a knowledge doc and
 * `code:path` for a code passage (`excerpt` then holds the matched lines).
 */
export interface Hit {
  ref: string;
  rank: number;
  score?: number;
  rawScore?: number;
  /** The batch-independent relevance the surface's confidence floor read, when it reports one. */
  relevance?: number;
  kind: "doc" | "code";
  excerpt?: string;
  flags: HitFlags;
  /** Why the hit ranked where it did, when the surface reports it. */
  why?: HitWhy;
}

/**
 * The score breakdown behind a hit — every score field the surface's hit
 * carried (see scoreComponents in retrieval-telemetry.ts) — so a results diff
 * shows which signal moved a hit. Diagnostic only; no metric reads it.
 */
export interface HitWhy {
  components: Record<string, unknown>;
}

/** A candidate a surface's gates held back, as recorded in a run's detail. */
export interface GatedHit {
  ref: string;
  /** The gate that dropped it (RetrievalDropReason). */
  reason: string;
  components?: Record<string, unknown>;
}

export interface SurfaceRun {
  /** Ordered hits the consumer sees (code: ranked files; inject: included docs). */
  hits: Hit[];
  /** Additional doc refs the consumer was fed but not shown as hits. */
  extraRefs?: string[];
  /** Surface-specific details recorded verbatim for diagnosis. */
  detail?: Record<string, unknown>;
}

/** Aggregate metrics for one group of (case, surface) pairs. Null = no case in the group qualifies. */
export interface MetricSet {
  pairs: number;
  rankedCases: number;
  recallAt5: number | null;
  mrrAt10: number | null;
  ndcgAt10: number | null;
  pAt5: number | null;
  negativeCases: number;
  negativeEmptyRate: number | null;
  leakageCases: number;
  leakageRate: number | null;
  leakedHits: number;
  codeCases: number;
  codeHitRate: number | null;
  injectedDocs: number;
  injectionPrecision: number | null;
  offTopicCases: number;
  offTopicInjectionRate: number | null;
  stalePairs: number;
  freshOverStaleRate: number | null;
  staleFlagRate: number | null;
  staleDocCases: number;
  /** Fraction of staleDocs cases where a stale doc is returned UNFLAGGED in the top 5. */
  staleHitRate: number | null;
  /** Total stale docs returned (any rank, flagged or not). */
  staleHits: number;
  /** Context-surface pairs with ≥1 positive label. */
  contextCases: number;
  /** Mean fraction of a context pair's positive labels present in context. */
  inContextRecall: number | null;
  /** Fraction of context pairs with ≥1 positive label present in context. */
  inContextHit: number | null;
  /** Context-surface pairs labeled with stale docs (staleOver stale side or staleDocs). */
  staleContextCases: number;
  /** Mean fraction of a context pair's stale docs present in context. */
  staleInContext: number | null;
  /** Metadata-policy leakage over every pair (see policy.ts), independent of per-case labels. */
  policyLeakage: {
    pairs: number;
    rate: number | null;
    hits: number;
    byRule: Record<string, number>;
  };
}

export interface IntegrityReport {
  docs: number;
  ftsRows: number;
  orphanFtsRows: number;
  docsMissingFts: number;
  docsDuplicateFts: number;
  docsStaleFts: number;
  staleFtsRefs: string[];
  chunks: number;
  orphanChunks: number;
  tailChunks: number;
  tailChunkRefs: string[];
  docsWithoutChunks: number;
  vecEnabled: boolean;
  vecRows: number | null;
  vecChunkMismatch: number | null;
  embeddingFingerprint: string | null;
  fingerprintHasModelDigest: boolean;
}

/**
 * How code search fared across a run's `code`-surface cases: one count per
 * status and per backend (`none` when no search was attempted), and every case
 * whose search did not run as ok/degraded. A run whose code search silently
 * stops searching shows up here even when no metric moves.
 */
export interface CodeSearchSummary {
  cases: number;
  byStatus: Record<string, number>;
  byBackend: Record<string, number>;
  /** `<case id>: <status> (<error>)` for each case not ok/degraded. */
  failing: string[];
}

/** The integrity counts the gate treats as violations (higher is worse). */
export const INTEGRITY_VIOLATION_KEYS = [
  "orphanFtsRows",
  "docsMissingFts",
  "docsDuplicateFts",
  "docsStaleFts",
  "orphanChunks",
  "tailChunks",
  "vecChunkMismatch",
] as const;
