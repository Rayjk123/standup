import { POLICY_RULES, type PolicyPair } from "./policy.js";
import { CONTEXT_SURFACES, type EvalCase, type Hit, type MetricSet, type RelevanceLabel, type RunSurface } from "./types.js";

/** `*` matches any run of characters (including `/`), `?` one character; anchored. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(ref: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(ref));
}

function splitCodeRef(spec: string): { path: string; suffix?: string } {
  const idx = spec.indexOf(":");
  if (idx < 0) return { path: spec };
  return { path: spec.slice(0, idx), suffix: spec.slice(idx + 1) || undefined };
}

/**
 * Whether a hit satisfies a relevance label. A doc label matches its exact
 * `project/slug`. A code label `path[:symbol|line]` matches a code hit on the
 * same path when the label names no symbol, or when the hit's own suffix, its
 * excerpt (symbol text), or its excerpt's line numbers carry it.
 */
export function hitMatchesLabel(hit: Hit, label: RelevanceLabel): boolean {
  if (label.doc !== undefined) return hit.kind === "doc" && hit.ref === label.doc;
  if (label.code === undefined || hit.kind !== "code") return false;
  const want = splitCodeRef(label.code);
  const got = splitCodeRef(hit.ref.replace(/^code:/, ""));
  if (normalizePath(got.path) !== normalizePath(want.path)) return false;
  if (!want.suffix) return true;
  if (got.suffix === want.suffix) return true;
  const excerpt = hit.excerpt ?? "";
  if (/^\d+$/.test(want.suffix)) {
    return excerpt.split("\n").some((line) => line.trim().startsWith(`${want.suffix}:`));
  }
  return excerpt.includes(want.suffix);
}

export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

function positiveLabels(c: EvalCase): RelevanceLabel[] {
  return c.relevant.filter((r) => r.grade > 0);
}

function isRelevantHit(hit: Hit, labels: RelevanceLabel[]): boolean {
  return labels.some((l) => hitMatchesLabel(hit, l));
}

export function recallAtK(hits: Hit[], labels: RelevanceLabel[], k: number): number {
  if (labels.length === 0) return 0;
  const top = hits.slice(0, k);
  const found = labels.filter((l) => top.some((h) => hitMatchesLabel(h, l))).length;
  return found / labels.length;
}

export function mrrAtK(hits: Hit[], labels: RelevanceLabel[], k: number): number {
  const top = hits.slice(0, k);
  const idx = top.findIndex((h) => isRelevantHit(h, labels));
  return idx < 0 ? 0 : 1 / (idx + 1);
}

export function precisionAtK(hits: Hit[], labels: RelevanceLabel[], k: number): number {
  const top = hits.slice(0, k);
  return top.filter((h) => isRelevantHit(h, labels)).length / k;
}

/**
 * Graded nDCG with linear gain (gain = grade) and a log2(rank + 1) discount.
 * Each label is credited once, at the first hit that matches it; a hit matching
 * several uncredited labels takes the highest grade.
 */
export function ndcgAtK(hits: Hit[], labels: RelevanceLabel[], k: number): number {
  if (labels.length === 0) return 0;
  const credited = new Set<number>();
  let dcg = 0;
  hits.slice(0, k).forEach((hit, i) => {
    let best = -1;
    labels.forEach((l, li) => {
      if (credited.has(li) || !hitMatchesLabel(hit, l)) return;
      if (best < 0 || l.grade > labels[best].grade) best = li;
    });
    if (best >= 0) {
      credited.add(best);
      dcg += labels[best].grade / Math.log2(i + 2);
    }
  });
  const ideal = labels
    .map((l) => l.grade)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
}

/** Per-(case, surface) measurements; absent fields mean the case does not qualify for that metric. */
export interface PairMetrics {
  recallAt5?: number;
  mrrAt10?: number;
  ndcgAt10?: number;
  pAt5?: number;
  negativeEmpty?: boolean;
  leaked?: boolean;
  leakedHits?: number;
  leakedRefs?: string[];
  codeHit?: boolean;
  injection?: { relevant: number; total: number };
  offTopicInjected?: boolean;
  stalePairs?: Array<{ fresh: string; stale: string; freshOverStale: boolean; staleFlagged: boolean }>;
  /** Stale docs returned (any rank), and whether one came back unflagged in the top 5. */
  staleDocs?: { returned: string[]; unflaggedTop5: boolean };
  /** Context surfaces: fraction of positive labels present, and whether any is. */
  inContextRecall?: number;
  inContextHit?: boolean;
  /** Context surfaces: fraction of the case's stale docs present, and which. */
  staleInContext?: number;
  staleInContextRefs?: string[];
  /** Metadata-policy violations; attached by the runner, which has the doc metadata. */
  policy?: PolicyPair;
}

function rankOf(hits: Hit[], ref: string): number {
  return hits.findIndex((h) => h.ref === ref);
}

function forbiddenMetrics(c: EvalCase, refs: string[], m: PairMetrics): void {
  const forbidden = c.forbidden ?? [];
  if (forbidden.length === 0) return;
  const leaked = refs.filter((r) => matchesAnyGlob(r, forbidden));
  m.leaked = leaked.length > 0;
  m.leakedHits = leaked.length;
  m.leakedRefs = [...new Set(leaked)].sort();
}

/** Every stale doc a case names: the stale side of each staleOver pair plus staleDocs. */
function staleRefsOf(c: EvalCase): string[] {
  return [...new Set([...(c.staleOver ?? []).map(([, stale]) => stale), ...(c.staleDocs ?? [])])];
}

/**
 * Set metrics for a context surface, where every doc is in context at once and
 * rank carries no meaning: which relevant and stale docs are present, plus
 * label leakage over everything in context.
 */
function computeContextMetrics(c: EvalCase, hits: Hit[], extraRefs: string[]): PairMetrics {
  const labels = positiveLabels(c);
  const m: PairMetrics = {};
  if (labels.length > 0) {
    const present = labels.filter((l) => hits.some((h) => hitMatchesLabel(h, l))).length;
    m.inContextRecall = present / labels.length;
    m.inContextHit = present > 0;
  }
  const staleRefs = staleRefsOf(c);
  if (staleRefs.length > 0) {
    const inContext = new Set([...hits.map((h) => h.ref), ...extraRefs]);
    const present = staleRefs.filter((r) => inContext.has(r)).sort();
    m.staleInContext = present.length / staleRefs.length;
    m.staleInContextRefs = present;
  }
  forbiddenMetrics(c, [...hits.map((h) => h.ref), ...extraRefs], m);
  return m;
}

export function computePairMetrics(
  c: EvalCase,
  surface: RunSurface,
  hits: Hit[],
  extraRefs: string[] = []
): PairMetrics {
  if (CONTEXT_SURFACES.includes(surface)) return computeContextMetrics(c, hits, extraRefs);
  const labels = positiveLabels(c);
  const m: PairMetrics = {};
  if (labels.length > 0) {
    m.recallAt5 = recallAtK(hits, labels, 5);
    m.mrrAt10 = mrrAtK(hits, labels, 10);
    m.ndcgAt10 = ndcgAtK(hits, labels, 10);
    m.pAt5 = precisionAtK(hits, labels, 5);
  }
  if (c.expectEmpty) m.negativeEmpty = hits.length === 0;

  forbiddenMetrics(c, [...hits.map((h) => h.ref), ...extraRefs], m);

  const judged = labels.length > 0 || c.expectEmpty === true;
  if (surface === "inject" && judged) {
    m.injection = {
      relevant: hits.filter((h) => isRelevantHit(h, labels)).length,
      total: hits.length,
    };
  }
  if (surface === "inject" && c.expectEmpty) m.offTopicInjected = hits.length > 0;

  const codeLabels = labels.filter((l) => l.code !== undefined);
  if (codeLabels.length > 0) m.codeHit = hits.some((h) => isRelevantHit(h, codeLabels));

  if ((c.staleOver ?? []).length > 0) {
    m.stalePairs = c.staleOver!.map(([fresh, stale]) => {
      const fr = rankOf(hits, fresh);
      const sr = rankOf(hits, stale);
      const freshOverStale = fr >= 0 && (sr < 0 || fr < sr);
      const staleFlagged = sr < 0 || hits[sr].flags.marked;
      return { fresh, stale, freshOverStale, staleFlagged };
    });
  }
  if ((c.staleDocs ?? []).length > 0) {
    const stale = new Set(c.staleDocs);
    const returned = hits.filter((h) => stale.has(h.ref));
    m.staleDocs = {
      returned: returned.map((h) => h.ref),
      unflaggedTop5: returned.some((h) => h.rank < 5 && !h.flags.marked),
    };
  }
  return m;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((a, b) => a + b, 0) / values.length);
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : round(num / den);
}

/** Fixed 6-decimal rounding so equal runs serialize byte-identically. */
export function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** `value` with every number rounded like `round`, nested objects included. */
export function roundNumbers(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === "number"
        ? round(v)
        : v && typeof v === "object" && !Array.isArray(v)
          ? roundNumbers(v as Record<string, unknown>)
          : v,
    ])
  );
}

export function aggregate(pairs: PairMetrics[]): MetricSet {
  const pick = (f: (p: PairMetrics) => number | undefined) =>
    pairs.map(f).filter((v): v is number => v !== undefined);
  const negatives = pairs.filter((p) => p.negativeEmpty !== undefined);
  const leakage = pairs.filter((p) => p.leaked !== undefined);
  const code = pairs.filter((p) => p.codeHit !== undefined);
  const inject = pairs.filter((p) => p.injection !== undefined);
  const injTotal = inject.reduce((s, p) => s + p.injection!.total, 0);
  const injRelevant = inject.reduce((s, p) => s + p.injection!.relevant, 0);
  const offTopic = pairs.filter((p) => p.offTopicInjected !== undefined);
  const stale = pairs.flatMap((p) => p.stalePairs ?? []);
  const staleDocCases = pairs.filter((p) => p.staleDocs !== undefined);
  const policy = pairs.filter((p) => p.policy !== undefined);
  const byRule: Record<string, number> = {};
  for (const r of POLICY_RULES) byRule[r] = policy.reduce((s, p) => s + p.policy!.byRule[r], 0);
  const recall = pick((p) => p.recallAt5);
  const context = pairs.filter((p) => p.inContextRecall !== undefined);
  const staleContext = pick((p) => p.staleInContext);
  return {
    pairs: pairs.length,
    rankedCases: recall.length,
    recallAt5: mean(recall),
    mrrAt10: mean(pick((p) => p.mrrAt10)),
    ndcgAt10: mean(pick((p) => p.ndcgAt10)),
    pAt5: mean(pick((p) => p.pAt5)),
    negativeCases: negatives.length,
    negativeEmptyRate: ratio(negatives.filter((p) => p.negativeEmpty).length, negatives.length),
    leakageCases: leakage.length,
    leakageRate: ratio(leakage.filter((p) => p.leaked).length, leakage.length),
    leakedHits: leakage.reduce((s, p) => s + (p.leakedHits ?? 0), 0),
    codeCases: code.length,
    codeHitRate: ratio(code.filter((p) => p.codeHit).length, code.length),
    injectedDocs: injTotal,
    injectionPrecision: ratio(injRelevant, injTotal),
    offTopicCases: offTopic.length,
    offTopicInjectionRate: ratio(offTopic.filter((p) => p.offTopicInjected).length, offTopic.length),
    stalePairs: stale.length,
    freshOverStaleRate: ratio(stale.filter((s) => s.freshOverStale).length, stale.length),
    staleFlagRate: ratio(stale.filter((s) => s.staleFlagged).length, stale.length),
    staleDocCases: staleDocCases.length,
    staleHitRate: ratio(staleDocCases.filter((p) => p.staleDocs!.unflaggedTop5).length, staleDocCases.length),
    staleHits: staleDocCases.reduce((s, p) => s + p.staleDocs!.returned.length, 0),
    contextCases: context.length,
    inContextRecall: mean(context.map((p) => p.inContextRecall!)),
    inContextHit: ratio(context.filter((p) => p.inContextHit).length, context.length),
    staleContextCases: staleContext.length,
    staleInContext: mean(staleContext),
    policyLeakage: {
      pairs: policy.length,
      rate: ratio(policy.filter((p) => p.policy!.hits > 0).length, policy.length),
      hits: policy.reduce((s, p) => s + p.policy!.hits, 0),
      byRule,
    },
  };
}
