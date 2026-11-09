import type { Hit } from "./types.js";

/**
 * Pure metric functions of the retrieval eval. Relevance is judged on content
 * keys, not refs: a byte-identical copy of a relevant doc homed in another
 * project (a `standup-self` mirror) answers the query as well as the original,
 * and counts once.
 */

/** Distinct content keys among the first `k` hits, in rank order. */
function topKeys(hits: readonly Hit[], k: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits.slice(0, k)) {
    if (seen.has(hit.contentKey)) continue;
    seen.add(hit.contentKey);
    out.push(hit.contentKey);
  }
  return out;
}

/** 1 when the top hit is relevant, else 0. */
export function precisionAt1(hits: readonly Hit[], relevant: ReadonlySet<string>): number {
  return hits.length > 0 && relevant.has(hits[0].contentKey) ? 1 : 0;
}

/** Share of the relevant content keys found in the first `k` hits; 0 when nothing is relevant. */
export function recallAtK(hits: readonly Hit[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const found = topKeys(hits, k).filter((key) => relevant.has(key)).length;
  return found / relevant.size;
}

/** Whether any of the first `k` hits is relevant. */
export function hitAtK(hits: readonly Hit[], relevant: ReadonlySet<string>, k: number): boolean {
  return hits.slice(0, k).some((hit) => relevant.has(hit.contentKey));
}

/** 1 / rank of the first relevant hit within the first `k`, else 0. */
export function reciprocalRank(hits: readonly Hit[], relevant: ReadonlySet<string>, k: number): number {
  const index = hits.slice(0, k).findIndex((hit) => relevant.has(hit.contentKey));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * How many of the first `k` slots hold a further copy of content an earlier
 * slot already showed, out of how many slots were filled.
 */
export function duplicateSlots(hits: readonly Hit[], k: number): { slots: number; duplicates: number } {
  const window = hits.slice(0, k);
  const seen = new Set<string>();
  let duplicates = 0;
  for (const hit of window) {
    if (seen.has(hit.contentKey)) duplicates++;
    else seen.add(hit.contentKey);
  }
  return { slots: window.length, duplicates };
}

/**
 * Whether an outdated doc outranks every current one: true when some stale doc
 * is returned and no fresh doc is returned above it. Returning neither is not
 * stale-first (it is a miss, which recall reports).
 */
export function staleRankedFirst(
  hits: readonly Hit[],
  fresh: ReadonlySet<string>,
  stale: ReadonlySet<string>
): boolean {
  for (const hit of hits) {
    if (fresh.has(hit.contentKey)) return false;
    if (stale.has(hit.contentKey)) return true;
  }
  return false;
}

/** Arithmetic mean, or null for no values. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Share of `flags` that are true, or null for none. */
export function rate(flags: readonly boolean[]): number | null {
  return mean(flags.map((f) => (f ? 1 : 0)));
}

/** The metrics of one tier-R query on one surface. */
export interface RealQueryMetrics {
  answerable: boolean;
  returned: number;
  p1: number;
  r5: number;
  rr10: number;
  /** Answerable but nothing came back. */
  emptyAnswerable: boolean;
  /** Answerable and no relevant doc in the first 5. */
  miss5: boolean;
  /** Unanswerable and nothing came back. */
  correctEmpty: boolean;
  dupSlots: number;
  dupTotal: number;
  /** Null for a case with no stale label. */
  staleFirst: boolean | null;
}

export function realQueryMetrics(
  hits: readonly Hit[],
  relevant: ReadonlySet<string>,
  opts: { expectEmpty?: boolean; fresh?: ReadonlySet<string>; stale?: ReadonlySet<string> } = {}
): RealQueryMetrics {
  const answerable = !opts.expectEmpty && relevant.size > 0;
  const dup = duplicateSlots(hits, 5);
  return {
    answerable,
    returned: hits.length,
    p1: precisionAt1(hits, relevant),
    r5: recallAtK(hits, relevant, 5),
    rr10: reciprocalRank(hits, relevant, 10),
    emptyAnswerable: answerable && hits.length === 0,
    miss5: answerable && !hitAtK(hits, relevant, 5),
    correctEmpty: !answerable && hits.length === 0,
    dupSlots: dup.duplicates,
    dupTotal: dup.slots,
    staleFirst: opts.fresh && opts.stale ? staleRankedFirst(hits, opts.fresh, opts.stale) : null,
  };
}

/** Aggregated tier-R metrics over a group of queries. Answerable-only metrics average answerable queries. */
export interface RealSummary {
  n: number;
  answerable: number;
  p1: number | null;
  r5: number | null;
  mrr10: number | null;
  falseNegativeRate: number | null;
  miss5Rate: number | null;
  correctEmptyRate: number | null;
  duplicateSlotRate: number | null;
  staleRankedFirstRate: number | null;
}

export function summarizeReal(rows: readonly RealQueryMetrics[]): RealSummary {
  const answerable = rows.filter((r) => r.answerable);
  const unanswerable = rows.filter((r) => !r.answerable);
  const slots = rows.reduce((s, r) => s + r.dupTotal, 0);
  const dups = rows.reduce((s, r) => s + r.dupSlots, 0);
  const staleRows = rows.filter((r) => r.staleFirst !== null);
  return {
    n: rows.length,
    answerable: answerable.length,
    p1: mean(answerable.map((r) => r.p1)),
    r5: mean(answerable.map((r) => r.r5)),
    mrr10: mean(answerable.map((r) => r.rr10)),
    falseNegativeRate: rate(answerable.map((r) => r.emptyAnswerable)),
    miss5Rate: rate(answerable.map((r) => r.miss5)),
    correctEmptyRate: rate(unanswerable.map((r) => r.correctEmpty)),
    duplicateSlotRate: slots > 0 ? dups / slots : null,
    staleRankedFirstRate: rate(staleRows.map((r) => r.staleFirst === true)),
  };
}

/** The metrics of one tier-U query on one pull surface. */
export interface TaskQueryMetrics {
  returned: number;
  hit5: boolean;
  helpfulRecall5: number;
  rr10: number;
  /** Something came back as a confident answer and none of it helps. */
  noise: boolean;
  empty: boolean;
}

export function taskQueryMetrics(hits: readonly Hit[], helpful: ReadonlySet<string>): TaskQueryMetrics {
  const confident = hits.filter((h) => h.confident !== false);
  return {
    returned: hits.length,
    hit5: hitAtK(hits, helpful, 5),
    helpfulRecall5: recallAtK(hits, helpful, 5),
    rr10: reciprocalRank(hits, helpful, 10),
    noise: confident.length > 0 && !confident.some((h) => helpful.has(h.contentKey)),
    empty: hits.length === 0,
  };
}

/** Launch-injection usefulness for one task. */
export interface InjectMetrics {
  injected: number;
  helpfulInjected: number;
  /** Helpful share of the injected docs; null when nothing was injected. */
  precision: number | null;
  /** At least one injected doc helps. */
  hit: boolean;
}

export function injectMetrics(injected: readonly Hit[], helpful: ReadonlySet<string>): InjectMetrics {
  const keys = topKeys(injected, injected.length);
  const helpfulInjected = keys.filter((k) => helpful.has(k)).length;
  return {
    injected: keys.length,
    helpfulInjected,
    precision: keys.length > 0 ? helpfulInjected / keys.length : null,
    hit: helpfulInjected > 0,
  };
}

/** One hook firing's pushes, as the push metrics see them. */
export interface PushFiring {
  event: string;
  hits: readonly Hit[];
}

/** Push counts of one hook event within a task. */
export interface PushEventCounts {
  firings: number;
  /** Firings that pushed at least one doc. */
  pushes: number;
  pushed: number;
  helpfulPushed: number;
}

/** Hook-push usefulness for one task, and the launch injection with and without it. */
export interface PushMetrics extends PushEventCounts {
  /** Helpful share of the pushed docs; null when nothing was pushed. */
  precision: number | null;
  /** At least one pushed doc helps. */
  hit: boolean;
  /** Pushes (firings that pushed) carrying no helpful doc. */
  noisyPushes: number;
  byEvent: Record<string, PushEventCounts>;
  /** Injection and pushes together: the docs the session was handed unasked. */
  withHooks: { docs: number; helpful: number; precision: number | null; hit: boolean };
}

export function pushMetrics(
  firings: readonly PushFiring[],
  injected: readonly Hit[],
  helpful: ReadonlySet<string>
): PushMetrics {
  const byEvent: Record<string, PushEventCounts> = {};
  const pushedKeys = new Set<string>();
  let pushes = 0;
  let noisyPushes = 0;
  for (const f of firings) {
    const counts = (byEvent[f.event] ??= { firings: 0, pushes: 0, pushed: 0, helpfulPushed: 0 });
    counts.firings++;
    const keys = topKeys(f.hits, f.hits.length);
    if (keys.length === 0) continue;
    counts.pushes++;
    pushes++;
    const helpfulHere = keys.filter((k) => helpful.has(k)).length;
    counts.pushed += keys.length;
    counts.helpfulPushed += helpfulHere;
    if (helpfulHere === 0) noisyPushes++;
    for (const k of keys) pushedKeys.add(k);
  }
  const pushed = pushedKeys.size;
  const helpfulPushed = [...pushedKeys].filter((k) => helpful.has(k)).length;
  const union = new Set([...topKeys(injected, injected.length), ...pushedKeys]);
  const unionHelpful = [...union].filter((k) => helpful.has(k)).length;
  return {
    firings: firings.length,
    pushes,
    pushed,
    helpfulPushed,
    precision: pushed > 0 ? helpfulPushed / pushed : null,
    hit: helpfulPushed > 0,
    noisyPushes,
    byEvent,
    withHooks: {
      docs: union.size,
      helpful: unionHelpful,
      precision: union.size > 0 ? unionHelpful / union.size : null,
      hit: unionHelpful > 0,
    },
  };
}

/** Aggregated pull metrics of one task (or of every task) on one surface. */
export interface TaskPullSummary {
  queries: number;
  pullHit5: number | null;
  helpfulRecall5: number | null;
  mrr10: number | null;
  noiseRate: number | null;
  /** Share of queries that came back empty — the honest answer when the corpus holds nothing helpful. */
  emptyRate: number | null;
}

export function summarizeTaskPull(rows: readonly TaskQueryMetrics[], hasHelpful: boolean): TaskPullSummary {
  return {
    queries: rows.length,
    pullHit5: hasHelpful ? rate(rows.map((r) => r.hit5)) : null,
    helpfulRecall5: hasHelpful ? mean(rows.map((r) => r.helpfulRecall5)) : null,
    mrr10: hasHelpful ? mean(rows.map((r) => r.rr10)) : null,
    noiseRate: rate(rows.map((r) => r.noise)),
    emptyRate: rate(rows.map((r) => r.empty)),
  };
}
