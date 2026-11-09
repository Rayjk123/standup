import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge } from "./search.js";
import { isConfident } from "./relevance.js";
import { bedrockRerankProvider, setBedrockInvoker, BEDROCK_RERANK_DEFAULT_MODEL } from "./bedrock.js";
import {
  getRerankProvider,
  registerRerankProvider,
  rerankHead,
  rerankStats,
  resetRerankState,
  resolveRerankProvider,
  scoresFromIndexed,
  unregisterRerankProvider,
  RERANK_DEFAULT_TIMEOUT_MS,
  RERANK_TOP_N,
  type RerankCandidate,
  type RerankProviderPlugin,
} from "./rerank.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * The rerank seam with stub providers registered in-test (no network): the
 * head reorder and score reassignment, the untouched tail, the budget and error
 * fallbacks, the (query, corpus revision, provider, model) cache, and — through
 * searchKnowledge — that the default is a no-op and a rerank never lifts a doc
 * over the confidence floor.
 */

const STUB = "stub-rerank";

type StubBehavior = (query: string, docs: readonly string[], signal?: AbortSignal) => Promise<number[]>;

// A provider whose scoring is swapped per test, counting its calls.
function stubProvider(behavior: StubBehavior): { plugin: RerankProviderPlugin; calls: string[][] } {
  const calls: string[][] = [];
  const plugin: RerankProviderPlugin = {
    id: STUB,
    defaultModel: "stub-model",
    rerank(query, docs, config) {
      calls.push([...docs]);
      return behavior(query, docs, config.signal);
    },
  };
  registerRerankProvider(plugin);
  return { plugin, calls };
}

// Scores each doc by its position, reversed: the last fused doc scores highest.
const reverse: StubBehavior = async (_q, docs) => docs.map((_, i) => i);

function candidates(n: number): RerankCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${i}`,
    title: `Doc ${i}`,
    excerpt: `body ${i}`,
    score: 1 - i / 100,
  }));
}

beforeEach(() => resetRerankState());
afterEach(() => {
  unregisterRerankProvider(STUB);
  setBedrockInvoker();
});

describe("resolveRerankProvider", () => {
  test("no RERANK_PROVIDER, or an unregistered one, resolves to none", () => {
    expect(resolveRerankProvider(undefined, {})).toBeNull();
    expect(resolveRerankProvider(undefined, { RERANK_PROVIDER: "nope" })).toBeNull();
  });

  test("env selects provider, model, url and budget; a bad budget falls back", () => {
    stubProvider(reverse);
    const s = resolveRerankProvider(undefined, {
      RERANK_PROVIDER: STUB,
      RERANK_MODEL: "m2",
      RERANK_URL: "http://127.0.0.1:9/x",
      RERANK_TIMEOUT_MS: "50",
    })!;
    expect([s.provider.id, s.model, s.baseUrl, s.timeoutMs]).toEqual([STUB, "m2", "http://127.0.0.1:9/x", 50]);
    const d = resolveRerankProvider(undefined, { RERANK_PROVIDER: STUB, RERANK_TIMEOUT_MS: "-3" })!;
    expect([d.model, d.timeoutMs]).toEqual(["stub-model", RERANK_DEFAULT_TIMEOUT_MS]);
  });

  test("the per-call override wins over the env", () => {
    stubProvider(reverse);
    const s = resolveRerankProvider({ provider: STUB, model: "o", timeoutMs: 7 }, { RERANK_PROVIDER: "nope" })!;
    expect([s.provider.id, s.model, s.timeoutMs]).toEqual([STUB, "o", 7]);
  });

  test("bedrock and http register on the seam", () => {
    expect(getRerankProvider("bedrock")?.defaultModel).toBe(BEDROCK_RERANK_DEFAULT_MODEL);
    expect(getRerankProvider("http")).toBeDefined();
  });
});

describe("rerankHead", () => {
  test("reorders the top N by reranker score and keeps the scores monotone with the new order", async () => {
    const { calls } = stubProvider(reverse);
    const ranked = candidates(5);
    const out = await rerankHead(ranked, "q", () => "rev1", { provider: STUB });
    expect(out.map((r) => r.id)).toEqual(["d4", "d3", "d2", "d1", "d0"]);
    expect(out.map((r) => r.score)).toEqual(ranked.map((r) => r.score));
    expect(calls[0][0]).toBe("Doc 0\n\nbody 0");
    expect(rerankStats().applied).toBe(1);
  });

  test("leaves the tail beyond N untouched and sends only the head to the provider", async () => {
    const { calls } = stubProvider(reverse);
    const ranked = candidates(RERANK_TOP_N + 5);
    const out = await rerankHead(ranked, "q", () => "rev1", { provider: STUB });
    expect(calls[0].length).toBe(RERANK_TOP_N);
    expect(out[0].id).toBe(`d${RERANK_TOP_N - 1}`);
    expect(out.slice(RERANK_TOP_N)).toEqual(ranked.slice(RERANK_TOP_N));
  });

  test("a provider over budget falls back to the fused order and is aborted", async () => {
    let aborted = false;
    stubProvider(
      (_q, docs, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => (aborted = true));
          setTimeout(() => resolve(docs.map((_, i) => i)), 200);
        })
    );
    const ranked = candidates(4);
    const out = await rerankHead(ranked, "q", () => "rev1", { provider: STUB, timeoutMs: 10 });
    expect(out).toEqual(ranked);
    expect(aborted).toBe(true);
    expect(rerankStats()).toMatchObject({ timeouts: 1, applied: 0 });
  });

  test.each([
    ["throws", (async () => { throw new Error("boom"); }) as StubBehavior],
    ["answers too few scores", (async () => [1]) as StubBehavior],
    ["answers a non-finite score", (async (_q, docs) => docs.map(() => Number.NaN)) as StubBehavior],
  ])("a provider that %s falls back to the fused order", async (_name, behavior) => {
    stubProvider(behavior);
    const ranked = candidates(4);
    expect(await rerankHead(ranked, "q", () => "rev1", { provider: STUB })).toEqual(ranked);
    expect(rerankStats()).toMatchObject({ errors: 1, applied: 0 });
  });

  test("a cache hit avoids a second provider call", async () => {
    const { calls } = stubProvider(reverse);
    const ranked = candidates(4);
    const first = await rerankHead(ranked, "q", () => "rev1", { provider: STUB });
    const second = await rerankHead(ranked, "q", () => "rev1", { provider: STUB });
    expect(second).toEqual(first);
    expect(calls.length).toBe(1);
    expect(rerankStats().cacheHits).toBe(1);
  });

  test("a corpus revision change, another query or another model misses the cache", async () => {
    const { calls } = stubProvider(reverse);
    const ranked = candidates(4);
    await rerankHead(ranked, "q", () => "rev1", { provider: STUB });
    await rerankHead(ranked, "q", () => "rev2", { provider: STUB });
    await rerankHead(ranked, "other", () => "rev2", { provider: STUB });
    await rerankHead(ranked, "other", () => "rev2", { provider: STUB, model: "m2" });
    expect(calls.length).toBe(4);
  });

  test("only docs the cache has not scored are sent to the provider", async () => {
    const { calls } = stubProvider(reverse);
    await rerankHead(candidates(3), "q", () => "rev1", { provider: STUB });
    await rerankHead(candidates(5), "q", () => "rev1", { provider: STUB });
    expect(calls[1]).toEqual(["Doc 3\n\nbody 3", "Doc 4\n\nbody 4"]);
  });

  test("off: false, or no provider, returns the fused order without reading the revision", async () => {
    const { calls } = stubProvider(reverse);
    const ranked = candidates(4);
    const revision = () => {
      throw new Error("revision read");
    };
    expect(await rerankHead(ranked, "q", revision, false)).toEqual(ranked);
    expect(await rerankHead(ranked, "q", revision, { provider: "unregistered" })).toEqual(ranked);
    expect(calls.length).toBe(0);
  });
});

describe("providers", () => {
  test("scoresFromIndexed maps both response shapes and rejects a partial answer", () => {
    expect(scoresFromIndexed([{ index: 1, score: 0.2 }, { index: 0, score: 0.9 }], 2)).toEqual([0.9, 0.2]);
    expect(scoresFromIndexed([{ index: 0, relevance_score: 0.5 }], 1)).toEqual([0.5]);
    expect(() => scoresFromIndexed([{ index: 0, score: 1 }], 2)).toThrow();
    expect(() => scoresFromIndexed({}, 1)).toThrow();
  });

  test("bedrock sends the Cohere rerank body and maps relevance_score by index", async () => {
    const calls: Array<{ modelId: string; body: unknown }> = [];
    setBedrockInvoker(async (modelId, body) => {
      calls.push({ modelId, body });
      return { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.1 }] };
    });
    const scores = await bedrockRerankProvider.rerank("q", ["a", "b"], {});
    expect(scores).toEqual([0.1, 0.8]);
    expect(calls[0]).toEqual({
      modelId: BEDROCK_RERANK_DEFAULT_MODEL,
      body: { query: "q", documents: ["a", "b"], top_n: 2, api_version: 2 },
    });
  });
});

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: overrides.id ?? "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

// Docs sharing the query's words to varying degrees, so the fused ranking has
// both confident and weak hits.
function corpus(): { db: Database; store: KnowledgeStore } {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  const topics = [
    ["retry", "Slack mirror retry policy", "The Slack mirror retries a failed post three times with jittered exponential backoff."],
    ["mirror", "Slack mirror threading", "The Slack mirror posts each session update into its own thread."],
    ["backoff", "Backoff jitter", "Exponential backoff with jitter spreads retries."],
    ["post", "Posting cadence", "A failed post is dropped after an hour."],
    ["deploy", "Collector deploy runbook", "Deploy the collector by building, migrating the database, then restarting the service."],
    ["persona", "Persona architecture", "Persona is the always-on orchestrator that briefs workers and keeps a handoff note."],
  ];
  for (const [id, title, body] of topics) store.upsertDoc(doc({ id, slug: id, title, body }));
  return { db, store };
}

const QUERY = "slack mirror retry failed post exponential backoff jitter";

describe("searchKnowledge with a reranker", () => {
  test("no provider configured: identical to rerank:false", async () => {
    const { db } = corpus();
    const baseline = await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: false });
    expect(await searchKnowledge(db, "proj", QUERY, null, { limit: 8 })).toEqual(baseline);
    expect(rerankStats()).toMatchObject({ calls: 0, applied: 0 });
  });

  test("reorders the results but carries each doc's relevance unchanged", async () => {
    stubProvider(reverse);
    const { db } = corpus();
    const baseline = await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: false });
    const reranked = await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: { provider: STUB } });
    expect(baseline.length).toBeGreaterThan(2);
    expect(reranked.map((r) => r.id)).toEqual(baseline.map((r) => r.id).reverse());
    for (const r of reranked) {
      const b = baseline.find((x) => x.id === r.id)!;
      expect(r.relevance).toBe(b.relevance!);
      expect(r.relevanceSignals).toEqual(b.relevanceSignals);
    }
  });

  test("a weak doc reranked to the top is not made confident", async () => {
    stubProvider(reverse);
    const { db } = corpus();
    const baseline = await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: false });
    const weak = baseline.filter((r) => !isConfident(r, "search"));
    expect(weak.length).toBeGreaterThan(0);
    const gated = await searchKnowledge(db, "proj", QUERY, null, {
      limit: 8,
      confidentFor: "search",
      rerank: { provider: STUB },
    });
    const confidentIds = new Set(baseline.filter((r) => isConfident(r, "search")).map((r) => r.id));
    expect(new Set(gated.map((r) => r.id))).toEqual(confidentIds);
  });

  test("a doc write changes the corpus revision, so the next search re-scores", async () => {
    const { calls } = stubProvider(reverse);
    const { db, store } = corpus();
    await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: { provider: STUB } });
    await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: { provider: STUB } });
    expect(calls.length).toBe(1);
    store.upsertDoc(doc({ id: "retry2", slug: "retry2", title: "Retry budget", body: "Retries stop after a failed post budget.", updatedAt: new Date("2026-09-01T00:00:00Z") }));
    await searchKnowledge(db, "proj", QUERY, null, { limit: 8, rerank: { provider: STUB } });
    expect(calls.length).toBe(2);
  });
});
