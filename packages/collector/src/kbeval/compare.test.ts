import { describe, expect, test } from "bun:test";
import { compareResults, parseException, type Comparable, type GateException } from "./compare.js";
import { acceptedExceptions, gateViolations, parseFlags } from "./cli.js";
import { aggregate, type PairMetrics } from "./metrics.js";
import { summarizeCodeSearch, type CaseResult, type EvalResults } from "./runner.js";
import type { CodeSearchSummary, IntegrityReport, MetricSet } from "./types.js";

function integrity(overrides: Partial<IntegrityReport> = {}): IntegrityReport {
  return {
    docs: 10,
    ftsRows: 10,
    orphanFtsRows: 0,
    docsMissingFts: 0,
    docsDuplicateFts: 0,
    docsStaleFts: 0,
    staleFtsRefs: [],
    chunks: 20,
    orphanChunks: 0,
    tailChunks: 0,
    tailChunkRefs: [],
    docsWithoutChunks: 0,
    vecEnabled: false,
    vecRows: null,
    vecChunkMismatch: null,
    embeddingFingerprint: "ollama:nomic-embed-text",
    fingerprintHasModelDigest: false,
    ...overrides,
  };
}

function metrics(overrides: Partial<MetricSet> = {}): MetricSet {
  return {
    ...aggregate([]),
    pairs: 10,
    recallAt5: 0.8,
    mrrAt10: 0.7,
    ndcgAt10: 0.6,
    pAt5: 0.3,
    negativeEmptyRate: 0.5,
    leakageRate: 0.2,
    leakedHits: 4,
    ...overrides,
  };
}

function codeSearch(overrides: Partial<CodeSearchSummary> = {}): CodeSearchSummary {
  return { cases: 3, byStatus: { degraded: 3 }, byBackend: { "git-grep": 3 }, failing: [], ...overrides };
}

function run(overall: Partial<MetricSet> = {}, search: Partial<MetricSet> = {}, extra: Partial<Comparable> = {}): Comparable {
  return {
    provenance: { casesLockHash: "lock" },
    config: { codeSearchBackend: "git-grep", vec: false },
    metrics: { overall: metrics(overall), bySurface: { search: metrics(search) } },
    integrity: integrity(),
    codeSearch: codeSearch(),
    ...extra,
  };
}

describe("gate comparison", () => {
  test("identical runs pass", () => {
    expect(compareResults(run(), run())).toEqual([]);
  });

  test("ranked metrics may drop up to 0.02 absolute", () => {
    expect(compareResults(run({ recallAt5: 0.781 }), run())).toEqual([]);
    const v = compareResults(run({ recallAt5: 0.77 }), run());
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("overall.recallAt5 dropped 0.8 → 0.77");
  });

  test("a per-surface drop fails even when overall holds", () => {
    const v = compareResults(run({}, { mrrAt10: 0.6 }), run());
    expect(v.some((x) => x.startsWith("search.mrrAt10 dropped"))).toBe(true);
  });

  test("negative empty-rate tolerates 0.03", () => {
    expect(compareResults(run({ negativeEmptyRate: 0.475 }), run())).toEqual([]);
    expect(compareResults(run({ negativeEmptyRate: 0.46 }), run())[0]).toContain("negativeEmptyRate");
  });

  test("any leakage increase fails", () => {
    expect(compareResults(run({ leakageRate: 0.2000001 }), run())[0]).toContain("leakageRate increased");
    expect(compareResults(run({ leakedHits: 5 }), run())[0]).toContain("leakedHits increased 4 → 5");
    expect(compareResults(run({ leakageRate: 0.1, leakedHits: 1 }), run())).toEqual([]);
  });

  test("improvements pass", () => {
    expect(compareResults(run({ recallAt5: 0.95, negativeEmptyRate: 1 }), run())).toEqual([]);
  });

  test("any policy-leakage increase fails, overall or by rule", () => {
    const base = metrics({ policyLeakage: { pairs: 10, rate: 0.2, hits: 3, byRule: { ownerMirror: 3, otherUser: 0 } } });
    const ref = run(base, base);
    const worse = run(
      { policyLeakage: { pairs: 10, rate: 0.2, hits: 3, byRule: { ownerMirror: 2, otherUser: 1 } } },
      base
    );
    expect(compareResults(worse, ref)).toEqual(["overall.policyLeakage.byRule.otherUser increased 0 → 1"]);
    const more = run({ policyLeakage: { pairs: 10, rate: 0.3, hits: 4, byRule: { ownerMirror: 4, otherUser: 0 } } }, base);
    expect(compareResults(more, ref)).toHaveLength(3);
    expect(compareResults(ref, ref)).toEqual([]);
  });

  test("the persona context surface is gated on its set metrics with a 0.02 tolerance", () => {
    const persona = metrics({
      recallAt5: null,
      mrrAt10: null,
      ndcgAt10: null,
      pAt5: null,
      inContextRecall: 0.5,
      inContextHit: 0.6,
      staleInContext: 0.1,
    });
    const withPersona = (p: MetricSet): Comparable => {
      const r = run();
      r.metrics.bySurface.persona = p;
      return r;
    };
    const ref = withPersona(persona);
    expect(compareResults(ref, ref)).toEqual([]);
    expect(compareResults(withPersona({ ...persona, inContextRecall: 0.49, staleInContext: 0.115 }), ref)).toEqual([]);
    expect(compareResults(withPersona({ ...persona, inContextRecall: 0.4 }), ref)).toEqual([
      "persona.inContextRecall dropped 0.5 → 0.4 (tolerance 0.02)",
    ]);
    expect(compareResults(withPersona({ ...persona, inContextHit: 0.5 }), ref)[0]).toContain("persona.inContextHit dropped");
    expect(compareResults(withPersona({ ...persona, staleInContext: 0.2 }), ref)).toEqual([
      "persona.staleInContext increased 0.1 → 0.2 (tolerance 0.02)",
    ]);
    expect(compareResults(withPersona({ ...persona, inContextHit: null }), ref)[0]).toContain("now not measured");
    expect(compareResults(withPersona({ ...persona, leakedHits: 5 }), ref)[0]).toContain("persona.leakedHits increased");
    // An improvement and a reference without the persona surface both pass.
    expect(compareResults(withPersona({ ...persona, inContextRecall: 1, staleInContext: 0 }), ref)).toEqual([]);
    expect(compareResults(withPersona(persona), run())).toEqual([]);
  });

  test("integrity counts may only go down", () => {
    const worse = run({}, {}, { integrity: integrity({ orphanFtsRows: 3, tailChunks: 1 }) });
    const v = compareResults(worse, run());
    expect(v).toEqual(["integrity.orphanFtsRows increased 0 → 3", "integrity.tailChunks increased 0 → 1"]);
    const better = run({}, {}, { integrity: integrity({ fingerprintHasModelDigest: true }) });
    expect(compareResults(better, run())).toEqual([]);
  });

  test("a different cases.lock or code-search environment fails", () => {
    const v = compareResults(run({}, {}, { provenance: { casesLockHash: "other" } }), run());
    expect(v[0]).toContain("cases.lock differs");
    const backend = compareResults(
      run({}, {}, { config: { codeSearchBackend: "rg", vec: false } }),
      run()
    );
    expect(backend[0]).toContain("code-search backend differs");
  });

  test("a code case whose search did not run fails, whatever the reference holds", () => {
    const failing = codeSearch({
      byStatus: { degraded: 2, unavailable: 1 },
      byBackend: { "git-grep": 2, none: 1 },
      failing: ["code-where: unavailable (no repo path to search)"],
    });
    const v = compareResults(run({}, {}, { codeSearch: failing }), run());
    expect(v).toContain("code search did not run for code-where: unavailable (no repo path to search)");

    // A reference recorded without per-case outcomes does not skip the check.
    const legacy = run();
    delete legacy.codeSearch;
    const vs = compareResults(run({}, {}, { codeSearch: failing }), legacy);
    expect(vs).toEqual(["code search did not run for code-where: unavailable (no repo path to search)"]);
    expect(compareResults(run(), legacy)).toEqual([]);
  });

  test("a run that recorded no code-search outcomes fails", () => {
    const cur = run();
    delete cur.codeSearch;
    expect(compareResults(cur, run())[0]).toContain("code-search outcomes were not recorded");
  });

  test("summarizeCodeSearch tallies each code case and lists the ones that did not search", () => {
    const codeCase = (id: string, codeSearch: unknown) =>
      ({
        id,
        surfaces: { code: { hitCount: 0, hits: [], metrics: {}, detail: { codeSearch } } },
      }) as unknown as CaseResult;
    const summary = summarizeCodeSearch([
      codeCase("a", { status: "degraded", backend: "git-grep" }),
      codeCase("b", { status: "unavailable", backend: null, error: "no repo path to search" }),
      codeCase("c", null),
      // A dead walker reported degraded-with-error still counts as not searched.
      codeCase("e", { status: "degraded", backend: "js", error: "search worker could not start: x" }),
      { id: "d", surfaces: { search: {} } } as unknown as CaseResult,
    ]);
    expect(summary).toEqual({
      cases: 4,
      byStatus: { degraded: 2, unavailable: 1, missing: 1 },
      byBackend: { "git-grep": 1, js: 1, none: 2 },
      failing: [
        "b: unavailable (no repo path to search)",
        "c: missing",
        "e: degraded (search worker could not start: x)",
      ],
    });
  });

  test("a per-case backend mix different from the reference fails", () => {
    const mixed = codeSearch({ byBackend: { "git-grep": 2, js: 1 } });
    const v = compareResults(run({}, {}, { codeSearch: mixed }), run());
    expect(v).toEqual([
      "code-search backend mix differs from the reference (git-grep=3, js=0 → git-grep=2, js=1)",
    ]);
  });

  test("a surface missing from the current run fails", () => {
    const cur = run();
    cur.metrics.bySurface = {};
    expect(compareResults(cur, run())[0]).toContain("surface search is in the reference but was not run");
  });

  test("gateViolations adds lock problems, cache misses, surface errors and a missing reference", () => {
    const current = {
      ...run(),
      tier: "fixture",
      provenance: { casesLockHash: "lock", casesLockProblems: ["case file a.json changed since cases.lock was written"] },
      embeddings: { misses: 2 },
      errors: ["c1/search: boom"],
    } as unknown as EvalResults;
    const v = gateViolations(current, null, "baseline.json");
    expect(v[0]).toContain("a.json changed");
    expect(v[1]).toContain("bun run eval:kb --refresh-embeddings");
    expect(v[2]).toContain("surface error");
    expect(v[3]).toContain("no baseline.json");
  });
});

describe("gate exceptions", () => {
  /** A run built from per-case recall@5 on persona-recall, with its metrics aggregated from those cases. */
  function caseRun(recalls: Record<string, number>, exceptions?: GateException[]): Comparable {
    const cases = Object.entries(recalls).map(([id, recallAt5]) => ({
      id,
      surfaces: { "persona-recall": { metrics: { recallAt5 } as PairMetrics } },
    }));
    const pairs = cases.map((c) => c.surfaces["persona-recall"].metrics);
    return {
      provenance: { casesLockHash: "lock" },
      config: { codeSearchBackend: "git-grep", vec: false },
      metrics: { overall: aggregate(pairs), bySurface: { "persona-recall": aggregate(pairs) } },
      integrity: integrity(),
      codeSearch: codeSearch(),
      cases,
      ...(exceptions ? { exceptions } : {}),
    };
  }

  const exception = (recordedValue: number): GateException => ({
    surface: "persona-recall",
    metric: "recallAt5",
    caseId: "overnight",
    reason: "label expects a doc below the floor",
    approvedBy: "orchestrator",
    recordedValue,
  });

  test("without an exception, one case's drop fails the surface", () => {
    const v = compareResults(caseRun({ a: 1, b: 1, overnight: 0.5 }), caseRun({ a: 1, b: 1, overnight: 1 }));
    expect(v.some((x) => x.startsWith("persona-recall.recallAt5 dropped"))).toBe(true);
  });

  test("a drop fully explained by the excepted case is ignored, on the surface and overall", () => {
    const v = compareResults(
      caseRun({ a: 1, b: 1, overnight: 0.5 }),
      caseRun({ a: 1, b: 1, overnight: 1 }, [exception(0.5)])
    );
    expect(v).toEqual([]);
  });

  test("a drop another case shares is not explained", () => {
    const v = compareResults(
      caseRun({ a: 0.5, b: 1, overnight: 0.5 }),
      caseRun({ a: 1, b: 1, overnight: 1 }, [exception(0.5)])
    );
    expect(v.some((x) => x.startsWith("persona-recall.recallAt5 dropped"))).toBe(true);
  });

  test("the excepted case falling below its recorded value fails", () => {
    const v = compareResults(
      caseRun({ a: 1, b: 1, overnight: 0 }),
      caseRun({ a: 1, b: 1, overnight: 1 }, [exception(0.5)])
    );
    expect(v).toEqual(["exception persona-recall.recallAt5 for case overnight got worse: 0.5 → 0"]);
  });

  test("an excepted case that is no longer measured fails", () => {
    const v = compareResults(caseRun({ a: 1, b: 1 }), caseRun({ a: 1, b: 1, overnight: 1 }, [exception(0.5)]));
    expect(v.some((x) => x.includes("the case was not measured"))).toBe(true);
  });

  test("parseException records the case's current value as its floor", () => {
    const e = parseException("persona-recall:recallAt5:overnight:label expects x (0.17 < floor)", "orchestrator", caseRun({ a: 1, overnight: 0.5 }));
    expect(e).toEqual({
      surface: "persona-recall",
      metric: "recallAt5",
      caseId: "overnight",
      reason: "label expects x (0.17 < floor)",
      approvedBy: "orchestrator",
      recordedValue: 0.5,
    });
    expect(() => parseException("persona-recall:recallAt5:overnight", "o", caseRun({ overnight: 1 }))).toThrow();
    expect(() => parseException("persona-recall:leakageRate:overnight:r", "o", caseRun({ overnight: 1 }))).toThrow();
    expect(() => parseException("persona-recall:recallAt5:missing:r", "o", caseRun({ overnight: 1 }))).toThrow();
  });

  test("an accept keeps the previous exceptions and replaces one recorded again", () => {
    const previous = [exception(1), { ...exception(1), caseId: "other" }];
    const kept = acceptedExceptions(
      previous,
      { exceptions: ["persona-recall:recallAt5:overnight:relabel pending"], approvedBy: "orchestrator" },
      caseRun({ overnight: 0.5, other: 1 })
    );
    expect(kept.map((e) => [e.caseId, e.recordedValue, e.reason])).toEqual([
      ["other", 1, "label expects a doc below the floor"],
      ["overnight", 0.5, "relabel pending"],
    ]);
  });

  test("--exception needs --accept and --approved-by", () => {
    expect(() => parseFlags(["--exception", "s:recallAt5:c:r"], "/tmp")).toThrow("--accept");
    expect(() => parseFlags(["--accept", "--exception", "s:recallAt5:c:r"], "/tmp")).toThrow("--approved-by");
    expect(parseFlags(["--accept", "--exception", "s:recallAt5:c:r", "--approved-by", "me"], "/tmp").exceptions).toEqual([
      "s:recallAt5:c:r",
    ]);
  });
});
