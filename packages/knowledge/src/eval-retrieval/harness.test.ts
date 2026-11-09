import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installFixedClock } from "./clock.js";
import { cacheKey, decodeCache, dequantize, encodeCache, EvalEmbeddings, quantize } from "./embedding-cache.js";
import { demoteStale } from "./freshness.js";
import { relatedProjects } from "./surfaces.js";
import { pushMetrics, type PushFiring } from "./metrics.js";
import { summarizePush, type TaskResult } from "./runner.js";
import { PUSH_RELEVANCE_BARS } from "../push.js";

describe("installFixedClock", () => {
  test("pins Date.now and argument-less new Date, leaves explicit dates alone, and restores", () => {
    const pinned = Date.UTC(2026, 9, 10);
    const restore = installFixedClock(pinned);
    try {
      expect(Date.now()).toBe(pinned);
      expect(new Date().getTime()).toBe(pinned);
      expect(new Date("2020-01-02T00:00:00Z").getTime()).toBe(Date.UTC(2020, 0, 2));
      expect(new Date(5).getTime()).toBe(5);
      expect(new Date() instanceof Date).toBe(true);
      expect(Date.parse("2020-01-02T00:00:00Z")).toBe(Date.UTC(2020, 0, 2));
    } finally {
      restore();
    }
    expect(Date.now()).not.toBe(pinned);
  });
});

describe("embedding cache format", () => {
  test("encode and decode round-trip, quantized to the served vector", () => {
    const vector = [0.5, -1, 0.25, 0];
    const key = cacheKey("digest", "hello");
    const bin = encodeCache(new Map([[key, quantize(vector)]]), 4);
    const { dims, entries } = decodeCache(bin);
    expect(dims).toBe(4);
    const served = dequantize(entries.get(key)!);
    served.forEach((v, i) => expect(v).toBeCloseTo(vector[i], 2));
  });

  test("a text in neither cache embeds as null when fetching is off; the base cache wins over the harness cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "retrieval-eval-cache-"));
    try {
      const baseDir = join(root, "base");
      const harnessDir = join(root, "harness");
      mkdirSync(baseDir);
      mkdirSync(harnessDir);
      const index = (dir: string) =>
        writeFileSync(join(dir, "index.json"), JSON.stringify({ modelDigest: "d", dims: 2 }));
      index(baseDir);
      index(harnessDir);
      writeFileSync(join(baseDir, "cache.bin"), encodeCache(new Map([[cacheKey("d", "both"), quantize([1, 0])]]), 2));
      writeFileSync(
        join(harnessDir, "cache.bin"),
        encodeCache(
          new Map([
            [cacheKey("d", "both"), quantize([0, 1])],
            [cacheKey("d", "harness"), quantize([0, -1])],
          ]),
          2
        )
      );
      const source = new EvalEmbeddings({ baseDir, harnessDir, fetchMissing: false });
      const close = (actual: number[] | null, expected: number[]) => {
        expect(actual).not.toBeNull();
        actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
      };
      close(await source.embed("both"), [1, 0]);
      close(await source.embed("harness"), [0, -1]);
      expect(await source.embed("neither")).toBeNull();
      expect(source.stats()).toEqual({ baseHits: 1, harnessHits: 1, fetched: 0, misses: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("demoteStale", () => {
  const item = (projectId: string, name: string, stale = false) => ({ projectId, name, stale });
  const cases: Array<{ name: string; items: ReturnType<typeof item>[]; expected: string[] }> = [
    {
      name: "a stale doc drops below the last fresh doc of its own project",
      items: [item("p", "old", true), item("p", "a"), item("q", "b"), item("p", "c")],
      expected: ["a", "b", "c", "old"],
    },
    {
      name: "a stale doc with no fresh peer below it keeps its place",
      items: [item("p", "old", true), item("q", "a")],
      expected: ["old", "a"],
    },
    { name: "nothing stale is unchanged", items: [item("p", "a"), item("p", "b")], expected: ["a", "b"] },
  ];
  for (const c of cases) {
    test(c.name, () => expect(demoteStale(c.items, (i) => (i.stale ? "2026-01-01" : undefined)).map((i) => i.name)).toEqual(c.expected));
  }
});

describe("relatedProjects", () => {
  const projects = [
    { id: "standup", repo: null },
    { id: "standup-self", repo: null, reserved: true },
    { id: "frost-watch", repo: null, related: ["quillstack"] },
    { id: "frost-watch-map", repo: null },
    { id: "quillstack", repo: null },
    { id: "scratch", repo: null },
    { id: "global", repo: null },
  ];
  const cases: Array<{ project: string; expected: string[] }> = [
    { project: "frost-watch", expected: ["frost-watch-map", "quillstack"] },
    { project: "quillstack", expected: ["frost-watch"] },
    { project: "standup", expected: [] },
    { project: "standup-self", expected: [] },
    { project: "scratch", expected: [] },
    { project: "global", expected: [] },
  ];
  for (const c of cases) {
    test(c.project, () => expect(relatedProjects(c.project, projects)).toEqual(c.expected));
  }
});

describe("summarizePush", () => {
  const task = (helpfulDocs: number, injectHit: boolean, firings: PushFiring[], injected: string[], helpful: string[]): TaskResult =>
    ({
      id: `t${helpfulDocs}`,
      project: "p",
      helpfulDocs,
      inject: { hit: injectHit },
      push: {
        ...pushMetrics(
          firings,
          injected.map((ref) => ({ ref, contentKey: ref })),
          new Set(helpful)
        ),
        log: [],
      },
    }) as unknown as TaskResult;
  const h = (...refs: string[]) => refs.map((ref) => ({ ref, contentKey: ref }));

  test("precision and hit over answerable tasks, noise and per-task over all, with vs without hooks", () => {
    const tasks = [
      // Injection missed; the prompt push found the helpful doc.
      task(1, false, [{ event: "UserPromptSubmit", hits: h("a") }], ["x"], ["a"]),
      // Injection hit; the edit push was noise.
      task(1, true, [{ event: "PreToolUse", hits: h("n") }], ["b"], ["b"]),
      // Nothing in the corpus helps and nothing was pushed: honest.
      task(0, false, [{ event: "SessionStart", hits: [] }], [], []),
    ];
    const s = summarizePush(tasks, 2, 1);
    expect(s.bars).toEqual({ ...PUSH_RELEVANCE_BARS });
    expect(s.microPrecision).toBe(0.5);
    expect(s.hitRate).toBe(0.5);
    expect(s.pushedPerTask).toBeCloseTo(2 / 3);
    expect(s.noiseRate).toBe(0.5);
    expect(s.honestEmptyRate).toBe(1);
    expect(s.withoutHooks).toEqual({ hitRate: 0.5, microPrecision: 0.5 });
    expect(s.withHooks).toEqual({ hitRate: 1, microPrecision: 0.5 });
    expect(s.byEvent.UserPromptSubmit).toEqual({ firings: 1, pushes: 1, pushed: 1, helpfulPushed: 1, precision: 1 });
    expect(s.byEvent.SessionStart).toEqual({ firings: 1, pushes: 0, pushed: 0, helpfulPushed: 0, precision: null });
  });
});
