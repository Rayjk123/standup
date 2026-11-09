import { expect, test, describe } from "bun:test";
import {
  bm25PhraseCeiling,
  compareContradiction,
  contradictionSide,
  isConfident,
  isVerdictAdmissible,
  megaDocPrior,
  relevanceOf,
  relevanceSignals,
  trustMultiplier,
  CONFIDENCE_FLOORS,
  CONTRADICTION_LOSING_WEIGHT,
  CONTRADICTION_OPEN_WEIGHT,
  DISPUTED_RANK_WEIGHT,
  ACTIVITY_DECAY_FLOOR,
  MEGA_DOC_CHUNKS,
} from "./relevance.js";
import { DISPUTED_CONFIDENCE } from "./confidence.js";

const signals = (over: Partial<Parameters<typeof relevanceSignals>[0]> = {}) =>
  relevanceSignals({ bm25: 4, bm25Ceiling: 8, cosine: 0.7, coverage: 1, queryTerms: 3, chunks: 2, ...over });

describe("relevance signals", () => {
  test("the text term is bm25's share of the most the query can award, capped at 1", () => {
    expect(signals({ bm25: 4, bm25Ceiling: 8 }).text).toBeCloseTo(0.5, 10);
    expect(signals({ bm25: 20, bm25Ceiling: 8 }).text).toBe(1);
    expect(signals({ bm25: 4, bm25Ceiling: 0 }).text).toBe(0);
  });

  test("the bm25 ceiling follows FTS5's idf, floored where FTS5 floors it", () => {
    // A phrase in 1 of 100 docs: idf = ln(99.5 / 1.5), times k1 + 1 = 2.2.
    expect(bm25PhraseCeiling(100, 1)).toBeCloseTo(Math.log(99.5 / 1.5) * 2.2, 10);
    // A phrase in most docs has a non-positive idf, which FTS5 floors at 1e-6.
    expect(bm25PhraseCeiling(100, 80)).toBeCloseTo(1e-6 * 2.2, 15);
  });

  test("the same text share means the same relevance whatever the corpus's bm25 magnitude", () => {
    // A small corpus scores a match ~25, a large one ~3; the share is what carries.
    expect(relevanceOf(signals({ bm25: 25, bm25Ceiling: 50 }))).toBeCloseTo(
      relevanceOf(signals({ bm25: 3, bm25Ceiling: 6 })),
      10
    );
  });

  test("relevance rises with each signal and stays within [0, 1]", () => {
    const base = relevanceOf(signals());
    expect(relevanceOf(signals({ bm25: 6 }))).toBeGreaterThan(base);
    expect(relevanceOf(signals({ cosine: 0.8 }))).toBeGreaterThan(base);
    expect(relevanceOf(signals({ coverage: 0.3 }))).toBeLessThan(base);
    expect(relevanceOf(signals({ bm25: 99, cosine: 1, coverage: 1 }))).toBeLessThanOrEqual(1);
    expect(relevanceOf(signals({ bm25: 0, cosine: 0.1, coverage: 0 }))).toBe(0);
  });

  test("a doc the query names is fully relevant", () => {
    expect(relevanceOf(signals({ bm25: 0, cosine: 0.2, coverage: 0, named: true }))).toBe(1);
  });

  test("without an embedding arm, the lexical share carries the base — coverage alone is not evidence", () => {
    // A doc containing every query term but little of the query's idf mass.
    expect(relevanceOf(signals({ cosine: null, coverage: 1, bm25: 0.4, bm25Ceiling: 8 }))).toBeLessThan(0.1);
    expect(relevanceOf(signals({ cosine: null, coverage: 1, bm25: 4, bm25Ceiling: 8 }))).toBeCloseTo(0.5, 10);
  });

  test("the cosine is read through the corpus's calibrated band", () => {
    const nomic = signals({ cosine: 0.6 });
    // A provider whose cosines sit 0.2 lower, calibrated: the same evidence.
    const shifted = signals({ cosine: 0.4, cosineBand: { low: 0.25, high: 0.55, calibrated: true } });
    expect(shifted.semantic).toBeCloseTo(nomic.semantic, 10);
    expect(relevanceOf(shifted)).toBeCloseTo(relevanceOf(nomic), 10);
    expect(shifted.cosineBand?.calibrated).toBe(true);
    expect(nomic.cosineBand?.calibrated).toBe(false);
  });

  test("a mega-doc pays a gentle length prior on its relevance", () => {
    expect(megaDocPrior(MEGA_DOC_CHUNKS)).toBe(1);
    expect(megaDocPrior(MEGA_DOC_CHUNKS * 3)).toBeLessThan(1);
    expect(megaDocPrior(MEGA_DOC_CHUNKS * 3)).toBeGreaterThan(0.5);
    expect(relevanceOf(signals({ chunks: MEGA_DOC_CHUNKS * 3 }))).toBeLessThan(relevanceOf(signals({ chunks: 2 })));
  });
});

describe("isConfident", () => {
  test("gates on relevance against the surface's floor", () => {
    for (const surface of ["search", "inject"] as const) {
      const floor = CONFIDENCE_FLOORS[surface];
      expect(isConfident({ relevance: floor }, surface)).toBe(true);
      expect(isConfident({ relevance: floor - 0.01 }, surface)).toBe(false);
    }
  });

  test("a hit without relevance is never confident, whatever its batch-relative rawScore", () => {
    expect(isConfident({ rawScore: 0.9 } as { relevance?: number }, "inject")).toBe(false);
    expect(isConfident({}, "inject")).toBe(false);
    expect(isConfident({ relevance: Number.NaN }, "inject")).toBe(false);
  });

  test("a named doc is confident whatever its relevance", () => {
    expect(isConfident({ relevance: 0, relevanceSignals: signals({ named: true }) }, "search")).toBe(true);
  });
});

describe("contradiction sides", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  test("a superseded or disputed counterpart has already lost", () => {
    expect(compareContradiction({}, { verdict: "superseded" }, now)).toBe(1);
    expect(compareContradiction({ verdict: "disputed" }, {}, now)).toBe(-1);
  });

  test("the later affirmed side wins, whoever wrote it", () => {
    const owner = (writtenAt: string) => ({ originClass: "owner", writtenAt });
    expect(compareContradiction(owner("2026-09-29T00:00:00Z"), owner("2026-10-04T00:00:00Z"), now)).toBe(-1);
    // A later agent doc beats an older owner doc: authorship does not decide.
    const agentDoc = {
      originClass: "agent",
      confidence: 1,
      writtenAt: "2026-09-09T01:26:00Z",
      lastVerifiedAt: "2026-09-09T01:26:00Z",
    };
    expect(compareContradiction(owner("2026-08-18T22:35:00Z"), agentDoc, now)).toBe(-1);
    // A later verification counts as affirmation.
    expect(
      compareContradiction(owner("2026-09-12T00:00:00Z"), { ...agentDoc, lastVerifiedAt: "2026-09-20T00:00:00Z" }, now)
    ).toBe(-1);
    // Without dates, confidence (in tenths) decides.
    expect(compareContradiction({ confidence: 0.9 }, { confidence: 0.5 }, now)).toBe(1);
  });

  test("the judgment is a total order: three mutually contradicting docs never all lose", () => {
    const docs = [
      { originClass: "agent", confidence: 0.85, writtenAt: "2026-09-01T00:00:00Z" },
      { originClass: "agent", confidence: 0.8, writtenAt: "2026-09-10T00:00:00Z" },
      { originClass: "agent", confidence: 0.75, writtenAt: "2026-09-20T00:00:00Z" },
    ];
    const sides = docs.map((d, i) =>
      contradictionSide(docs.filter((_, j) => j !== i).map((o) => compareContradiction(d, o, now)))
    );
    expect(sides).not.toEqual(["losing", "losing", "losing"]);
    expect(sides.filter((s) => s === "winning")).toHaveLength(1);
  });

  test("two sides written the same day with the same confidence are undecidable", () => {
    expect(
      compareContradiction(
        { writtenAt: "2026-09-29T08:00:00Z" },
        { writtenAt: "2026-09-29T20:00:00Z" },
        now
      )
    ).toBe(0);
    expect(compareContradiction({}, {}, now)).toBe(0);
  });

  test("losing to any counterpart loses; winning needs every one", () => {
    expect(contradictionSide([1, -1])).toBe("losing");
    expect(contradictionSide([1, 1])).toBe("winning");
    expect(contradictionSide([1, 0])).toBe("undecided");
    expect(contradictionSide([])).toBe("undecided");
  });

  test("only the losing side is held out; an undecided pair reaches every surface", () => {
    const side = (s: "losing" | "winning" | "undecided") => ({
      verdict: "contradicted",
      contradiction: { side: s, counterparts: ["p/x"] },
    });
    expect(isVerdictAdmissible(side("winning"), "inject")).toBe(true);
    expect(isVerdictAdmissible(side("losing"), "search")).toBe(false);
    expect(isVerdictAdmissible(side("undecided"), "search")).toBe(true);
    expect(isVerdictAdmissible(side("undecided"), "inject")).toBe(true);
    expect(isVerdictAdmissible({ verdict: "contradicted" }, "search")).toBe(false);
    expect(isVerdictAdmissible({ verdict: "superseded" }, "search")).toBe(false);
    expect(isVerdictAdmissible({ verdict: "superseded" }, "inject")).toBe(false);
    expect(isVerdictAdmissible({ verdict: "clean" }, "inject")).toBe(true);
  });

  test("a disputed doc is admitted on every surface: demoted in rank and marked, not dropped", () => {
    expect(isVerdictAdmissible({ verdict: "disputed" }, "search")).toBe(true);
    expect(isVerdictAdmissible({ verdict: "disputed" }, "inject")).toBe(true);
  });
});

describe("trustMultiplier", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  test("a contradicted doc is demoted, its losing side harder", () => {
    const losing = trustMultiplier({ verdict: "contradicted", contradiction: { side: "losing", counterparts: [] } }, now);
    const open = trustMultiplier({ verdict: "contradicted", contradiction: { side: "winning", counterparts: [] } }, now);
    expect(losing).toBeCloseTo(CONTRADICTION_LOSING_WEIGHT, 10);
    expect(open).toBeCloseTo(CONTRADICTION_OPEN_WEIGHT, 10);
    expect(losing).toBeLessThan(open);
    expect(trustMultiplier({}, now)).toBe(1);
  });

  test("a disputed doc takes the disputed weight in place of its written-down confidence", () => {
    const disputed = { verdict: "disputed", confidence: DISPUTED_CONFIDENCE, lastVerifiedAt: "2026-09-30T00:00:00Z" };
    expect(trustMultiplier(disputed, now)).toBeCloseTo(DISPUTED_RANK_WEIGHT, 10);
    expect(trustMultiplier({ verdict: "disputed" }, now)).toBeCloseTo(DISPUTED_RANK_WEIGHT, 10);
    // Harder than a contradiction's losing side, softer than dropping the doc.
    expect(DISPUTED_RANK_WEIGHT).toBeLessThan(CONTRADICTION_LOSING_WEIGHT);
    expect(DISPUTED_RANK_WEIGHT).toBeGreaterThan(0);
  });

  test.each([
    // [disputed evidence, clean evidence, disputed ranks first]
    [0.6, 0.55, false],
    [0.6, 0.47, false],
    [0.6, 0.4, true],
    [0.8, 0.3, true],
    [0.9, 0.2, true],
  ] as const)(
    "trust-scaled evidence: disputed %p vs clean %p → disputed first is %p",
    (disputedEvidence, cleanEvidence, disputedFirst) => {
      const disputed = trustMultiplier({ verdict: "disputed", confidence: DISPUTED_CONFIDENCE }, now) * disputedEvidence;
      const clean = trustMultiplier({ verdict: "clean", confidence: 1 }, now) * cleanEvidence;
      expect(disputed > clean).toBe(disputedFirst);
    }
  );

  test("a lower stored confidence lowers rank mildly", () => {
    const low = trustMultiplier({ confidence: 0.5 }, now);
    expect(low).toBeLessThan(1);
    expect(low).toBeGreaterThan(0.8);
  });

  test("an activity note decays with its age, down to a floor", () => {
    const fresh = trustMultiplier({ layer: "activity", writtenAt: "2026-09-30T00:00:00Z" }, now);
    const month = trustMultiplier({ layer: "activity", writtenAt: "2026-09-01T00:00:00Z" }, now);
    const ancient = trustMultiplier({ layer: "activity", writtenAt: "2025-01-01T00:00:00Z" }, now);
    expect(fresh).toBeGreaterThan(month);
    expect(month).toBeCloseTo(0.5, 1);
    expect(ancient).toBeCloseTo(ACTIVITY_DECAY_FLOOR, 10);
    // A note's own half-life wins over the default.
    expect(trustMultiplier({ layer: "activity", writtenAt: "2026-09-01T00:00:00Z", halfLifeDays: 300 }, now)).toBeGreaterThan(
      month
    );
    // Only the activity layer ages this way.
    expect(trustMultiplier({ layer: "docs", writtenAt: "2025-01-01T00:00:00Z" }, now)).toBe(1);
  });
});

describe("same-day contradictions", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  test("an owner doc and an agent doc affirmed the same day are undecided — authorship never overrides it", () => {
    const ownerPlan = { originClass: "owner", writtenAt: "2026-10-04T22:09:43Z" };
    const agentArch = {
      originClass: "agent",
      confidence: 1,
      writtenAt: "2026-10-04T22:11:03Z",
      lastVerifiedAt: "2026-10-04T22:11:03Z",
    };
    expect(compareContradiction(ownerPlan, agentArch, now)).toBe(0);
    expect(compareContradiction(agentArch, ownerPlan, now)).toBe(0);
  });

  test("two owner docs written the same day are undecided; a settled side still loses", () => {
    const a = { originClass: "owner", writtenAt: "2026-10-04T08:00:00Z" };
    const b = { originClass: "owner", writtenAt: "2026-10-04T20:00:00Z" };
    expect(compareContradiction(a, b, now)).toBe(0);
    expect(compareContradiction({ ...a, verdict: "superseded" }, b, now)).toBe(-1);
  });

  test("authorship breaks a tie only when every other component is equal", () => {
    // No dates at all: nothing to tie on, so owner over agent decides.
    expect(compareContradiction({ originClass: "owner" }, { originClass: "agent" }, now)).toBe(1);
  });

  test("injection feeds both sides of an undecided pair", () => {
    const undecided = { verdict: "contradicted", contradiction: { side: "undecided" as const, counterparts: ["p/x"] } };
    expect(isVerdictAdmissible(undecided, "inject")).toBe(true);
    expect(isVerdictAdmissible(undecided, "search")).toBe(true);
  });
});
