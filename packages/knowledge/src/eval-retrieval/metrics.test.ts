import { describe, expect, test } from "bun:test";
import {
  duplicateSlots,
  hitAtK,
  injectMetrics,
  mean,
  precisionAt1,
  pushMetrics,
  rate,
  realQueryMetrics,
  recallAtK,
  reciprocalRank,
  staleRankedFirst,
  summarizeReal,
  summarizeTaskPull,
  taskQueryMetrics,
} from "./metrics.js";
import type { Hit } from "./types.js";

/** Hits whose content key is the ref itself, except `ref=key` pairs that name a shared key. */
function hits(...specs: string[]): Hit[] {
  return specs.map((s) => {
    const [ref, key] = s.split("=");
    return { ref, contentKey: key ?? ref };
  });
}
const set = (...keys: string[]) => new Set(keys);

describe("rank metrics", () => {
  const cases: Array<{
    name: string;
    hits: Hit[];
    relevant: Set<string>;
    p1: number;
    r5: number;
    rr10: number;
    hit5: boolean;
  }> = [
    { name: "relevant first", hits: hits("a", "b"), relevant: set("a"), p1: 1, r5: 1, rr10: 1, hit5: true },
    { name: "relevant third", hits: hits("x", "y", "a"), relevant: set("a"), p1: 0, r5: 1, rr10: 1 / 3, hit5: true },
    { name: "half the answer set", hits: hits("a", "x"), relevant: set("a", "b"), p1: 1, r5: 0.5, rr10: 1, hit5: true },
    { name: "relevant past five", hits: hits("q", "r", "s", "t", "u", "a"), relevant: set("a"), p1: 0, r5: 0, rr10: 1 / 6, hit5: false },
    { name: "relevant past ten", hits: hits(..."bcdefghijk".split(""), "a"), relevant: set("a"), p1: 0, r5: 0, rr10: 0, hit5: false },
    { name: "empty result", hits: [], relevant: set("a"), p1: 0, r5: 0, rr10: 0, hit5: false },
    { name: "nothing relevant", hits: hits("a"), relevant: set(), p1: 0, r5: 0, rr10: 0, hit5: false },
    {
      name: "a mirror copy answers and counts once",
      hits: hits("standup-self/x=k", "standup/x=k"),
      relevant: set("k"),
      p1: 1,
      r5: 1,
      rr10: 1,
      hit5: true,
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(precisionAt1(c.hits, c.relevant)).toBe(c.p1);
      expect(recallAtK(c.hits, c.relevant, 5)).toBeCloseTo(c.r5, 10);
      expect(reciprocalRank(c.hits, c.relevant, 10)).toBeCloseTo(c.rr10, 10);
      expect(hitAtK(c.hits, c.relevant, 5)).toBe(c.hit5);
    });
  }
});

describe("duplicateSlots", () => {
  const cases: Array<{ name: string; hits: Hit[]; slots: number; duplicates: number }> = [
    { name: "distinct", hits: hits("a", "b", "c"), slots: 3, duplicates: 0 },
    { name: "one mirror copy", hits: hits("standup/a=k", "standup-self/a=k", "b"), slots: 3, duplicates: 1 },
    { name: "three copies", hits: hits("p/a=k", "q/a=k", "r/a=k"), slots: 3, duplicates: 2 },
    { name: "copy past the window is not counted", hits: hits("a=k", "b", "c", "d", "e", "f=k"), slots: 5, duplicates: 0 },
    { name: "empty", hits: [], slots: 0, duplicates: 0 },
  ];
  for (const c of cases) {
    test(c.name, () => expect(duplicateSlots(c.hits, 5)).toEqual({ slots: c.slots, duplicates: c.duplicates }));
  }
});

describe("staleRankedFirst", () => {
  const cases: Array<{ name: string; hits: Hit[]; expected: boolean }> = [
    { name: "fresh above stale", hits: hits("fresh", "old"), expected: false },
    { name: "stale above fresh", hits: hits("old", "fresh"), expected: true },
    { name: "stale with no fresh", hits: hits("x", "old"), expected: true },
    { name: "neither returned", hits: hits("x"), expected: false },
    { name: "only fresh", hits: hits("fresh"), expected: false },
  ];
  for (const c of cases) {
    test(c.name, () => expect(staleRankedFirst(c.hits, set("fresh"), set("old"))).toBe(c.expected));
  }
});

describe("mean and rate", () => {
  test("empty inputs are null, not zero", () => {
    expect(mean([])).toBeNull();
    expect(rate([])).toBeNull();
  });
  test("values average", () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5, 10);
    expect(rate([true, false, false, true])).toBe(0.5);
  });
});

describe("summarizeReal", () => {
  test("answerable metrics skip unanswerable rows, which feed correct-empty", () => {
    const rows = [
      realQueryMetrics(hits("a"), set("a")),
      realQueryMetrics([], set("b")),
      realQueryMetrics([], set(), { expectEmpty: true }),
      realQueryMetrics(hits("noise"), set(), { expectEmpty: true }),
      realQueryMetrics(hits("old", "fresh", "fresh-copy=fresh"), set("fresh"), { fresh: set("fresh"), stale: set("old") }),
    ];
    const s = summarizeReal(rows);
    expect(s.n).toBe(5);
    expect(s.answerable).toBe(3);
    expect(s.p1).toBeCloseTo(1 / 3, 10);
    expect(s.r5).toBeCloseTo(2 / 3, 10);
    expect(s.mrr10).toBeCloseTo((1 + 0 + 0.5) / 3, 10);
    expect(s.falseNegativeRate).toBeCloseTo(1 / 3, 10);
    expect(s.miss5Rate).toBeCloseTo(1 / 3, 10);
    expect(s.correctEmptyRate).toBe(0.5);
    // 1 + 0 + 0 + 1 + 3 slots filled; the third hit of the stale case repeats `fresh`.
    expect(s.duplicateSlotRate).toBeCloseTo(1 / 5, 10);
    expect(s.staleRankedFirstRate).toBe(1);
  });
  test("an expectEmpty case with labels is still unanswerable", () => {
    expect(realQueryMetrics([], set("a"), { expectEmpty: true }).answerable).toBe(false);
  });
});

describe("task metrics", () => {
  test("noise is a confident answer with nothing helpful", () => {
    expect(taskQueryMetrics(hits("x"), set("h")).noise).toBe(true);
    expect(taskQueryMetrics(hits("x", "h"), set("h")).noise).toBe(false);
    expect(taskQueryMetrics([], set("h")).noise).toBe(false);
    expect(taskQueryMetrics([{ ref: "x", contentKey: "x", confident: false }], set("h")).noise).toBe(false);
  });
  test("pull summary: hit@5, helpful recall, MRR, noise and empty", () => {
    const rows = [
      taskQueryMetrics(hits("h1", "x"), set("h1", "h2")),
      taskQueryMetrics(hits("x", "y"), set("h1")),
      taskQueryMetrics([], set("h1")),
    ];
    const s = summarizeTaskPull(rows, true);
    expect(s.queries).toBe(3);
    expect(s.pullHit5).toBeCloseTo(1 / 3, 10);
    expect(s.helpfulRecall5).toBeCloseTo(0.5 / 3, 10);
    expect(s.mrr10).toBeCloseTo(1 / 3, 10);
    expect(s.noiseRate).toBeCloseTo(1 / 3, 10);
    expect(s.emptyRate).toBeCloseTo(1 / 3, 10);
  });
  test("a task with no helpful doc reports no pull hit rate, only noise and empty", () => {
    const s = summarizeTaskPull([taskQueryMetrics([], set()), taskQueryMetrics(hits("x"), set())], false);
    expect(s.pullHit5).toBeNull();
    expect(s.helpfulRecall5).toBeNull();
    expect(s.mrr10).toBeNull();
    expect(s.noiseRate).toBe(0.5);
    expect(s.emptyRate).toBe(0.5);
  });
  test("inject precision is over distinct injected content", () => {
    expect(injectMetrics(hits("h", "x", "y"), set("h"))).toEqual({ injected: 3, helpfulInjected: 1, precision: 1 / 3, hit: true });
    expect(injectMetrics(hits("a=h", "b=h"), set("h"))).toEqual({ injected: 1, helpfulInjected: 1, precision: 1, hit: true });
    expect(injectMetrics([], set("h"))).toEqual({ injected: 0, helpfulInjected: 0, precision: null, hit: false });
  });
});

describe("pushMetrics", () => {
  test("precision, hit, noisy pushes, per event, and the union with the injection", () => {
    const m = pushMetrics(
      [
        { event: "SessionStart", hits: hits("h1", "x") },
        { event: "UserPromptSubmit", hits: [] },
        { event: "UserPromptSubmit", hits: hits("y") },
        { event: "PreToolUse", hits: hits("copy=h1") },
      ],
      hits("i", "h2"),
      set("h1", "h2")
    );
    expect(m).toMatchObject({ firings: 4, pushes: 3, pushed: 3, helpfulPushed: 1, precision: 1 / 3, hit: true, noisyPushes: 1 });
    expect(m.byEvent).toEqual({
      SessionStart: { firings: 1, pushes: 1, pushed: 2, helpfulPushed: 1 },
      UserPromptSubmit: { firings: 2, pushes: 1, pushed: 1, helpfulPushed: 0 },
      PreToolUse: { firings: 1, pushes: 1, pushed: 1, helpfulPushed: 1 },
    });
    // Injected i, h2 plus pushed h1, x, y: five distinct docs, two helpful.
    expect(m.withHooks).toEqual({ docs: 5, helpful: 2, precision: 2 / 5, hit: true });
  });

  test("nothing pushed: null precision, no hit, the union is the injection", () => {
    const m = pushMetrics([{ event: "SessionStart", hits: [] }], hits("h"), set("h"));
    expect(m).toMatchObject({ pushes: 0, pushed: 0, precision: null, hit: false, noisyPushes: 0 });
    expect(m.withHooks).toEqual({ docs: 1, helpful: 1, precision: 1, hit: true });
  });
});
