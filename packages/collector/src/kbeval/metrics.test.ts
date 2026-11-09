import { describe, expect, test } from "bun:test";
import {
  aggregate,
  computePairMetrics,
  globToRegExp,
  hitMatchesLabel,
  mrrAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
} from "./metrics.js";
import type { EvalCase, Hit } from "./types.js";

function doc(ref: string, rank: number, marked = false): Hit {
  return { ref, rank, kind: "doc", flags: { marked } };
}

function code(path: string, rank: number, excerpt = ""): Hit {
  return { ref: `code:${path}`, rank, kind: "code", excerpt, flags: { marked: false } };
}

function kase(overrides: Partial<EvalCase>): EvalCase {
  return {
    id: "c",
    category: "docs",
    surface: ["search"],
    audience: { projectId: "p", user: "u" },
    query: "q",
    relevant: [],
    forbidden: [],
    expectEmpty: false,
    staleOver: [],
    staleDocs: [],
    ...overrides,
  };
}

describe("ranked metrics", () => {
  // Hits: x, a, y, b, z — relevant a (grade 2) at rank 2, b (grade 1) at rank 4, c (grade 1) absent.
  const hits = ["p/x", "p/a", "p/y", "p/b", "p/z"].map((r, i) => doc(r, i));
  const labels = [
    { doc: "p/a", grade: 2 },
    { doc: "p/b", grade: 1 },
    { doc: "p/c", grade: 1 },
  ];

  test("recall@5 counts labels found in the top 5", () => {
    expect(recallAtK(hits, labels, 5)).toBeCloseTo(2 / 3, 10);
    expect(recallAtK(hits, labels, 2)).toBeCloseTo(1 / 3, 10);
  });

  test("MRR is the reciprocal rank of the first relevant hit", () => {
    expect(mrrAtK(hits, labels, 10)).toBe(0.5);
    expect(mrrAtK(hits, labels, 1)).toBe(0);
  });

  test("P@5 divides relevant top-5 hits by 5", () => {
    expect(precisionAtK(hits, labels, 5)).toBeCloseTo(0.4, 10);
  });

  test("nDCG uses linear gain and a log2(rank+1) discount", () => {
    // DCG = 2/log2(3) + 1/log2(5); IDCG = 2/log2(2) + 1/log2(3) + 1/log2(4).
    const dcg = 2 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 2 + 1 / Math.log2(3) + 1 / 2;
    expect(ndcgAtK(hits, labels, 10)).toBeCloseTo(dcg / idcg, 10);
  });

  test("a label is credited once even when repeated hits match it", () => {
    const dup = [doc("p/a", 0), doc("p/a", 1)];
    expect(ndcgAtK(dup, [{ doc: "p/a", grade: 1 }], 10)).toBe(1);
  });
});

describe("code labels", () => {
  test("a path-only label matches any hit on the path", () => {
    expect(hitMatchesLabel(code("src/search.ts", 0), { code: "src/search.ts", grade: 1 })).toBe(true);
    expect(hitMatchesLabel(code("./src/search.ts", 0), { code: "src/search.ts", grade: 1 })).toBe(true);
  });

  test("a symbol label needs the symbol in the excerpt", () => {
    const hit = code("src/search.ts", 0, "12: export function fuseRrf(a, b) {");
    expect(hitMatchesLabel(hit, { code: "src/search.ts:fuseRrf", grade: 1 })).toBe(true);
    expect(hitMatchesLabel(hit, { code: "src/search.ts:otherFn", grade: 1 })).toBe(false);
  });

  test("a line label needs that line among the excerpt's numbered lines", () => {
    const hit = code("src/search.ts", 0, "12: a\n40: b");
    expect(hitMatchesLabel(hit, { code: "src/search.ts:40", grade: 1 })).toBe(true);
    expect(hitMatchesLabel(hit, { code: "src/search.ts:41", grade: 1 })).toBe(false);
  });

  test("a doc hit never matches a code label", () => {
    expect(hitMatchesLabel(doc("src/search.ts", 0), { code: "src/search.ts", grade: 1 })).toBe(false);
  });
});

describe("globs", () => {
  test("* spans slashes and the pattern is anchored", () => {
    expect(globToRegExp("catalog-core/*").test("catalog-core/a/b")).toBe(true);
    expect(globToRegExp("global/native-mem-*").test("global/native-mem-home")).toBe(true);
    expect(globToRegExp("global/native-mem-*").test("x/global/native-mem-home")).toBe(false);
  });
});

describe("pair metrics and aggregation", () => {
  test("leakage, negatives and staleness", () => {
    const leak = kase({
      id: "leak",
      surface: ["search"],
      relevant: [{ doc: "p/a", grade: 1 }],
      forbidden: ["secret/*"],
      staleOver: [["p/a", "p/old"]],
      staleDocs: ["p/old"],
    });
    const leakHits = [doc("p/old", 0), doc("p/a", 1), doc("secret/x", 2)];
    const m1 = computePairMetrics(leak, "search", leakHits, ["secret/y"]);
    expect(m1.leaked).toBe(true);
    expect(m1.leakedHits).toBe(2);
    expect(m1.stalePairs).toEqual([{ fresh: "p/a", stale: "p/old", freshOverStale: false, staleFlagged: false }]);
    expect(m1.staleDocs).toEqual({ returned: ["p/old"], unflaggedTop5: true });

    const neg = kase({ id: "neg", surface: ["search"], expectEmpty: true, forbidden: ["secret/*"] });
    const m2 = computePairMetrics(neg, "search", [doc("p/z", 0)]);
    expect(m2.negativeEmpty).toBe(false);
    expect(m2.leaked).toBe(false);

    const empty = computePairMetrics(neg, "search", []);
    expect(empty.negativeEmpty).toBe(true);

    const agg = aggregate([m1, m2, empty]);
    expect(agg.leakageRate).toBeCloseTo(1 / 3, 6);
    expect(agg.leakedHits).toBe(2);
    expect(agg.negativeEmptyRate).toBe(0.5);
    expect(agg.freshOverStaleRate).toBe(0);
    expect(agg.staleFlagRate).toBe(0);
    expect(agg.staleHitRate).toBe(1);
    expect(agg.recallAt5).toBe(1);
    expect(agg.mrrAt10).toBe(0.5);
  });

  test("a stale doc that is absent or flagged counts as flagged; fresh above stale passes", () => {
    const c = kase({ staleOver: [["p/new", "p/old"]], staleDocs: ["p/old"] });
    const absent = computePairMetrics(c, "search", [doc("p/new", 0)]);
    expect(absent.stalePairs![0]).toMatchObject({ freshOverStale: true, staleFlagged: true });
    const flagged = computePairMetrics(c, "search", [doc("p/new", 0), doc("p/old", 1, true)]);
    expect(flagged.stalePairs![0]).toMatchObject({ freshOverStale: true, staleFlagged: true });
    expect(flagged.staleDocs!.unflaggedTop5).toBe(false);
    const bothAbsent = computePairMetrics(c, "search", []);
    expect(bothAbsent.stalePairs![0].freshOverStale).toBe(false);
  });

  test("injection precision and off-topic injection", () => {
    const onTopic = kase({ surface: ["inject"], relevant: [{ doc: "p/a", grade: 1 }] });
    const offTopic = kase({ surface: ["inject"], expectEmpty: true });
    const a = computePairMetrics(onTopic, "inject", [doc("p/a", 0), doc("p/b", 1)]);
    const b = computePairMetrics(offTopic, "inject", [doc("p/c", 0)]);
    const agg = aggregate([a, b]);
    expect(agg.injectionPrecision).toBeCloseTo(1 / 3, 6);
    expect(agg.offTopicInjectionRate).toBe(1);
  });

  test("code-hit rate over cases with a code label", () => {
    const c = kase({ category: "code", relevant: [{ code: "src/a.ts:fn", grade: 1 }] });
    expect(computePairMetrics(c, "code", [code("src/a.ts", 0, "3: fn()")]).codeHit).toBe(true);
    expect(computePairMetrics(c, "search", [doc("p/a", 0)]).codeHit).toBe(false);
  });

  test("an empty group reports null rates", () => {
    const agg = aggregate([]);
    expect(agg.recallAt5).toBeNull();
    expect(agg.leakageRate).toBeNull();
    expect(agg.inContextRecall).toBeNull();
    expect(agg.staleInContext).toBeNull();
    expect(agg.pairs).toBe(0);
  });
});

describe("context surface set metrics", () => {
  const c = kase({
    surface: ["persona"],
    relevant: [
      { doc: "global/a", grade: 2 },
      { doc: "global/b", grade: 1 },
    ],
    forbidden: ["global/secret-*"],
    staleOver: [["global/a", "global/old-a"]],
    staleDocs: ["global/old-b"],
  });

  test("persona context measures presence, not rank, and carries no ranked metrics", () => {
    // The relevant doc sits past rank 5; presence is all that counts.
    const hits = ["x/1", "x/2", "x/3", "x/4", "x/5", "x/6", "global/b", "global/old-a", "global/secret-1"].map((ref, i) =>
      doc(ref, i)
    );
    const m = computePairMetrics(c, "persona", hits);
    expect(m.inContextRecall).toBe(0.5);
    expect(m.inContextHit).toBe(true);
    expect(m.staleInContext).toBe(0.5);
    expect(m.staleInContextRefs).toEqual(["global/old-a"]);
    expect(m.leaked).toBe(true);
    expect(m.recallAt5).toBeUndefined();
    expect(m.mrrAt10).toBeUndefined();
    expect(m.stalePairs).toBeUndefined();
    expect(m.staleDocs).toBeUndefined();
  });

  test("persona-recall is ranked like any surface", () => {
    const m = computePairMetrics(c, "persona-recall", [doc("global/a", 0), doc("global/old-b", 1)]);
    expect(m.recallAt5).toBe(0.5);
    expect(m.mrrAt10).toBe(1);
    expect(m.inContextRecall).toBeUndefined();
    expect(m.staleDocs?.unflaggedTop5).toBe(true);
  });

  test("context pairs stay out of the ranked aggregates", () => {
    const context = computePairMetrics(c, "persona", []);
    const ranked = computePairMetrics(c, "persona-recall", [doc("global/a", 0), doc("global/b", 1)]);
    const agg = aggregate([context, ranked]);
    expect(agg.rankedCases).toBe(1);
    expect(agg.recallAt5).toBe(1);
    expect(agg.contextCases).toBe(1);
    expect(agg.inContextRecall).toBe(0);
    expect(agg.inContextHit).toBe(0);
    expect(agg.staleContextCases).toBe(1);
    expect(agg.staleInContext).toBe(0);
  });
});
