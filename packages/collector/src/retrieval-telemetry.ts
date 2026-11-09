import type { Database } from "bun:sqlite";
import { effectiveAlgoVersion, layerOf, NATIVE_MEMORY_HOME_SLUG_PREFIX } from "@standup/knowledge";
import { recordRetrievals, type RetrievalRecord } from "@standup/store";

/**
 * Why a retrieved candidate did not reach the consumer, as recorded in
 * knowledge_retrievals.drop_reason:
 *  - `floor`: its batch-independent relevance is below the surface's
 *    confidence floor (isConfident).
 *  - `verdict`: superseded, the losing (or unknown) side of a contradiction,
 *    or disputed on a surface that holds disputed docs out. Both sides of an
 *    undecided pair are fed with a conflict marker, so an undecided doc is
 *    never dropped for its verdict; launch injection feeds a disputed doc at
 *    its demoted rank with a dispute marker, so there a disputed doc is only
 *    ever dropped as `cutoff` or by another gate.
 *  - `freshness`: the freshness gate holds it out — refuted below the
 *    confidence floor, or decayed below it where a re-verification will lift
 *    it back. A stale doc with no recovery path is demoted and marked, not
 *    dropped.
 *  - `origin`: its trust provenance is not eligible for injection.
 *  - `foreign-intent`: another project's product/spec doc.
 *  - `personal`: a personal-layer doc the surface does not deliver.
 *  - `native-memory`: a native-memory mirror a restricted surface leaves out.
 *  - `forbidden`: a runbook about an action the launch brief forbids.
 *  - `activity`: an activity note below the injection's relevance or age bar.
 *  - `cutoff`: passed every gate but ranked below the surface's top-K.
 *  - `budget`: a returned result squeezed out of a launch prompt by its char
 *    budget (BUDGET_DROP_REASON — the one reason that marks a returned hit).
 */
export type RetrievalDropReason =
  | "floor"
  | "verdict"
  | "freshness"
  | "origin"
  | "foreign-intent"
  | "personal"
  | "native-memory"
  | "forbidden"
  | "activity"
  | "cutoff"
  | "budget";

/** A candidate a gate held back, with the gate that did. */
export interface GatedCandidate<T = RetrievalHit> {
  hit: T;
  reason: RetrievalDropReason;
}

/**
 * Gated candidates recorded per query. Telemetry, not an audit log: the top of
 * the gated list is what explains a missing hit, and a bound keeps one broad
 * query from writing hundreds of rows.
 */
export const GATED_CANDIDATES_PER_QUERY = 10;

/** The fields a retrieval hit may carry that telemetry reads; every one optional. */
export interface RetrievalHit {
  projectId: string;
  slug: string;
  score?: number;
  rawScore?: number;
  sourceKind?: string;
  scope?: string;
  ownerUser?: string;
  layer?: string;
}

/** A doc's placement as stored, for a hit that does not carry it. */
export interface DocPlacement {
  scope?: string;
  sourceKind?: string;
  ownerUser?: string;
}

/** A numeric field name that is a score (not a confidence, a count or a date). */
const SCORE_FIELD = /(score|relevance|similarity|cosine|boost|multiplier)$/i;
/** Object fields holding a per-signal breakdown of a hit's score. */
const COMPONENT_OBJECTS = new Set(["signals", "components", "relevanceSignals"]);

/** The finite-number leaves of `value`, nested objects kept, everything else dropped. */
function numericLeaves(value: object, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) {
      const nested = numericLeaves(v, depth + 1);
      if (Object.keys(nested).length > 0) out[k] = nested;
    }
  }
  return out;
}

/**
 * Every score field a hit carries, whatever the ranking that produced it put
 * there: top-level numeric fields named like a score (score, rawScore,
 * relevance, …) and the numeric leaves of a `signals` / `components` /
 * `relevanceSignals`
 * breakdown. Generic so a ranking change that adds a signal is recorded
 * without touching the recorder.
 */
export function scoreComponents(hit: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hit)) {
    if (typeof v === "number" && Number.isFinite(v) && SCORE_FIELD.test(k)) out[k] = v;
    else if (COMPONENT_OBJECTS.has(k) && v && typeof v === "object" && !Array.isArray(v)) {
      const leaves = numericLeaves(v);
      if (Object.keys(leaves).length > 0) out[k] = leaves;
    }
  }
  return out;
}

/**
 * The placement and score columns of a retrieval row for `hit`. Placement comes
 * from the hit when it carries it, else from `stored`. A personal-layer doc's
 * owner is recorded so its row is shown only to that owner; a home CLAUDE.md /
 * rules mirror with no owner stamp belongs to `hostUser`.
 */
export function hitRecordFields(
  hit: RetrievalHit,
  stored?: DocPlacement | null,
  hostUser?: string
): Pick<
  RetrievalRecord,
  "score" | "rawScore" | "relevance" | "components" | "layer" | "sourceKind" | "scope" | "docOwner"
> {
  const scope = hit.scope ?? stored?.scope;
  const sourceKind = hit.sourceKind ?? stored?.sourceKind;
  const layer = hit.layer ?? layerOf({ scope, sourceKind, slug: hit.slug });
  const owner = hit.ownerUser ?? stored?.ownerUser;
  const docOwner =
    layer !== "personal"
      ? undefined
      : owner ?? (hit.slug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX) ? hostUser : undefined);
  const relevance = (hit as { relevance?: unknown }).relevance;
  return {
    score: hit.score,
    rawScore: hit.rawScore,
    relevance: typeof relevance === "number" ? relevance : hit.rawScore,
    components: scoreComponents(hit),
    layer,
    ...(sourceKind ? { sourceKind } : {}),
    ...(scope ? { scope } : {}),
    ...(docOwner ? { docOwner } : {}),
  };
}

/** Refs per placement query, well under SQLite's bound-parameter limit. */
const PLACEMENT_BATCH = 200;

/**
 * The stored placement (scope, kind, owner) of every doc in `refs`, read from
 * the `knowledge` table in one query per batch rather than a doc fetch per
 * hit, as a lookup. A doc not in the index — or a database with no index —
 * reads as null.
 */
export function placementsFor(
  db: Database,
  refs: ReadonlyArray<{ projectId: string; slug: string }>
): (projectId: string, slug: string) => DocPlacement | null {
  const key = (projectId: string, slug: string) => `${projectId}\u0000${slug}`;
  const found = new Map<string, DocPlacement>();
  const unique = [...new Map(refs.map((r) => [key(r.projectId, r.slug), r])).values()];
  try {
    for (let i = 0; i < unique.length; i += PLACEMENT_BATCH) {
      const batch = unique.slice(i, i + PLACEMENT_BATCH);
      const rows = db
        .query(
          `SELECT project_id, slug, scope, source_kind, owner_user FROM knowledge
            WHERE (project_id, slug) IN (VALUES ${batch.map(() => "(?, ?)").join(", ")})`
        )
        .all(...batch.flatMap((r) => [r.projectId, r.slug])) as Array<{
        project_id: string;
        slug: string;
        scope: string | null;
        source_kind: string | null;
        owner_user: string | null;
      }>;
      for (const row of rows) {
        found.set(key(row.project_id, row.slug), {
          ...(row.scope ? { scope: row.scope } : {}),
          ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
          ...(row.owner_user ? { ownerUser: row.owner_user } : {}),
        });
      }
    }
  } catch {
    // No knowledge index in this database: every placement reads as unknown.
  }
  return (projectId, slug) => found.get(key(projectId, slug)) ?? null;
}

/**
 * Rows for the candidates a surface's gates held back: the first
 * GATED_CANDIDATES_PER_QUERY of them, in candidate order, each ranked by its
 * position among the gated candidates and carrying its drop reason.
 */
export function gatedRecords<T extends RetrievalHit>(
  gated: ReadonlyArray<GatedCandidate<T>>,
  base: Omit<RetrievalRecord, "docProject" | "docSlug" | "rank">,
  placementOf: (hit: T) => DocPlacement | null | undefined,
  hostUser?: string
): RetrievalRecord[] {
  return gated.slice(0, GATED_CANDIDATES_PER_QUERY).map(({ hit, reason }, rank) => ({
    ...base,
    docProject: hit.projectId,
    docSlug: hit.slug,
    rank,
    ...hitRecordFields(hit, placementOf(hit), hostUser),
    dropReason: reason,
  }));
}

/**
 * Persists retrieval rows stamped with the running algorithm's version —
 * ALGO_VERSION, or `<ALGO_VERSION>+env` while a ranking override is set
 * (effectiveAlgoVersion). A personal-layer row is kept only when its owner is
 * `requester` — the user the retrieval ran for — so another user's personal
 * doc never lands in the log under someone else's query. Throws on a write
 * failure; callers treat telemetry as best-effort and catch.
 */
export function recordKnowledgeRetrievals(
  db: Database,
  records: RetrievalRecord[],
  requester: string | undefined
): void {
  const kept = records.filter(
    (r) => r.layer !== "personal" || (r.docOwner !== undefined && r.docOwner === requester)
  );
  const algoVersion = effectiveAlgoVersion();
  recordRetrievals(
    db,
    kept.map((r) => ({ ...r, algoVersion }))
  );
}
