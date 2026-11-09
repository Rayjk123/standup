import { createHash } from "crypto";

/**
 * The pluggable cross-encoder rerank seam, mirroring the embedding-provider seam
 * (embeddings.ts). After the RRF merge, searchKnowledge hands the head of the fused
 * ranking (RERANK_TOP_N docs) to a reranker that scores each (query, doc) pair
 * jointly — a precision signal the bi-encoder cosine and bm25 arms cannot give,
 * strongest on paraphrased questions whose words differ from the doc's.
 *
 * OFF unless a provider is configured: with no RERANK_PROVIDER (and no per-call
 * `rerank` option) the fused order is returned untouched, nothing touches the
 * network, and the corpus revision is never computed.
 *
 * What a rerank changes, and what it does not: it REORDERS the head only. The
 * head's ordering scores are reassigned in the new order (the best reranked doc
 * takes the head's best score, and so on), so `score` stays monotone with the
 * returned order and keeps its scale for a consumer normalizing within the
 * batch. `relevance` — the number every confidence floor gates on — is never
 * touched, so a reranker can lift a below-floor doc above a confident one in the
 * ordering but can never make it confident. The tail beyond the head keeps its
 * fused order and scores.
 *
 * Bounded: one provider call per search, raced against a budget
 * (RERANK_TIMEOUT_MS, default 200 ms). A timeout, a provider error or a
 * malformed response returns the fused order unchanged; the outcome is counted
 * in rerankStats rather than logged, because a slow reranker must not spam the
 * search path.
 */

/** Per-call configuration handed to a rerank plugin. */
export interface RerankConfig {
  model?: string;
  /** Endpoint for an HTTP provider (e.g. a local text-embeddings-inference server). */
  baseUrl?: string;
  region?: string;
  /** Aborted when the rerank budget runs out; a plugin should pass it to its request. */
  signal?: AbortSignal;
}

/**
 * One reranker. `rerank` returns one score per document, aligned with `docs`;
 * higher is more relevant. Scores need only be comparable within one query —
 * they never leave the reorder. A plugin may throw; rerankHead turns any failure
 * into the fused order.
 */
export interface RerankProviderPlugin {
  id: string;
  defaultModel: string;
  rerank(query: string, docs: readonly string[], config: RerankConfig): Promise<number[]>;
}

/** The per-call rerank override on SearchOptions; every field falls back to the env. */
export interface RerankOptions {
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

/** How many of the fused head a rerank reorders. */
export const RERANK_TOP_N = 20;

/** The default rerank budget, in ms. */
export const RERANK_DEFAULT_TIMEOUT_MS = 200;

/** Upper bound on cached (query, corpus revision, provider, model) entries. */
export const RERANK_CACHE_MAX_ENTRIES = 256;

const PROVIDERS = new Map<string, RerankProviderPlugin>();

/** Adds (or replaces) a rerank provider on the seam, keyed by its id. */
export function registerRerankProvider(plugin: RerankProviderPlugin): void {
  PROVIDERS.set(plugin.id, plugin);
}

/** Removes a rerank provider from the seam. */
export function unregisterRerankProvider(id: string): void {
  PROVIDERS.delete(id);
}

/** The rerank plugin registered under `id`, or undefined if none is. */
export function getRerankProvider(id: string): RerankProviderPlugin | undefined {
  return PROVIDERS.get(id);
}

/** A resolved, ready-to-call rerank configuration. */
export interface RerankSettings {
  provider: RerankProviderPlugin;
  model: string;
  baseUrl?: string;
  region?: string;
  timeoutMs: number;
}

type Env = Record<string, string | undefined>;

function positiveInt(raw: string | number | undefined): number | undefined {
  const parsed = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/**
 * The reranker a search should use, or null for none. A per-call override wins
 * over the env: RERANK_PROVIDER (a registered provider id), RERANK_MODEL,
 * RERANK_URL, RERANK_REGION and RERANK_TIMEOUT_MS. An unset or unregistered
 * provider resolves to null — reranking off.
 */
export function resolveRerankProvider(
  override?: RerankOptions,
  env: Env = process.env
): RerankSettings | null {
  const id = override?.provider ?? (env.RERANK_PROVIDER?.trim() || undefined);
  if (!id) return null;
  const provider = PROVIDERS.get(id);
  if (!provider) return null;
  return {
    provider,
    model: override?.model ?? (env.RERANK_MODEL?.trim() || provider.defaultModel),
    baseUrl: env.RERANK_URL?.trim() || undefined,
    region: env.RERANK_REGION?.trim() || undefined,
    timeoutMs: positiveInt(override?.timeoutMs) ?? positiveInt(env.RERANK_TIMEOUT_MS) ?? RERANK_DEFAULT_TIMEOUT_MS,
  };
}

/** Counters for the rerank outcomes, the seam's only telemetry. */
export interface RerankStats {
  /** Searches whose head was reordered by reranker scores. */
  applied: number;
  /** Provider calls made. */
  calls: number;
  /** Searches whose every head doc was already scored in the cache. */
  cacheHits: number;
  /** Searches that fell back to the fused order because the budget ran out. */
  timeouts: number;
  /** Searches that fell back because the provider threw or answered malformed. */
  errors: number;
}

const stats: RerankStats = { applied: 0, calls: 0, cacheHits: 0, timeouts: 0, errors: 0 };

/** A snapshot of the rerank outcome counters. */
export function rerankStats(): RerankStats {
  return { ...stats };
}

// (query hash, corpus revision, provider, model) -> per-doc reranker score. A
// Map iterates in insertion order, so re-inserting on access and evicting the
// first key makes it an LRU.
const cache = new Map<string, Map<string, number>>();

/** Clears the rerank cache and zeroes the counters. */
export function resetRerankState(): void {
  cache.clear();
  for (const k of Object.keys(stats) as Array<keyof RerankStats>) stats[k] = 0;
}

function cacheKey(query: string, revision: string, settings: RerankSettings): string {
  const q = createHash("sha256").update(query).digest("hex");
  return [q, revision, settings.provider.id, settings.model].join("\u0000");
}

function cacheEntry(key: string): Map<string, number> {
  let entry = cache.get(key);
  if (entry) {
    cache.delete(key);
  } else {
    entry = new Map();
  }
  cache.set(key, entry);
  while (cache.size > RERANK_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

class RerankTimeout extends Error {}

// Runs the provider against the budget. The provider sees the abort signal so a
// well-behaved one cancels its request; the race returns on time regardless.
async function scoreWithin(
  settings: RerankSettings,
  query: string,
  docs: string[]
): Promise<number[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RerankTimeout());
    }, settings.timeoutMs);
  });
  const call = settings.provider.rerank(query, docs, {
    model: settings.model,
    baseUrl: settings.baseUrl,
    region: settings.region,
    signal: controller.signal,
  });
  // A provider that rejects after the budget won must not surface as unhandled.
  call.catch(() => {});
  try {
    const scores = await Promise.race([call, timeout]);
    if (!Array.isArray(scores) || scores.length !== docs.length || !scores.every((s) => Number.isFinite(s))) {
      throw new Error("reranker returned a malformed score list");
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

/** The fields of a ranked result a rerank reads and rewrites. */
export interface RerankCandidate {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

/**
 * Reorders the first RERANK_TOP_N of a fused ranking by reranker score (see the
 * module comment for what is and is not changed). `revision` is read only when a
 * provider resolves, so the default path never computes it. Never throws.
 */
export async function rerankHead<T extends RerankCandidate>(
  ranked: readonly T[],
  query: string,
  revision: () => string,
  override?: RerankOptions | false
): Promise<T[]> {
  if (override === false || ranked.length < 2) return [...ranked];
  const settings = resolveRerankProvider(override);
  if (!settings) return [...ranked];

  const head = ranked.slice(0, RERANK_TOP_N);
  const tail = ranked.slice(RERANK_TOP_N);
  let entry: Map<string, number>;
  try {
    entry = cacheEntry(cacheKey(query, revision(), settings));
  } catch {
    stats.errors++;
    return [...ranked];
  }

  const missing = head.filter((r) => !entry.has(r.id));
  if (missing.length === 0) {
    stats.cacheHits++;
  } else {
    stats.calls++;
    try {
      const scores = await scoreWithin(
        settings,
        query,
        missing.map((r) => `${r.title}\n\n${r.excerpt}`)
      );
      missing.forEach((r, i) => entry.set(r.id, scores[i]));
    } catch (err) {
      if (err instanceof RerankTimeout) stats.timeouts++;
      else stats.errors++;
      return [...ranked];
    }
  }

  const position = new Map(head.map((r, i) => [r.id, i] as const));
  const reordered = [...head].sort(
    (a, b) => entry.get(b.id)! - entry.get(a.id)! || position.get(a.id)! - position.get(b.id)!
  );
  const scores = head.map((r) => r.score).sort((a, b) => b - a);
  stats.applied++;
  return [...reordered.map((r, i) => ({ ...r, score: scores[i] })), ...tail];
}

/**
 * Maps an `[{ index, score }]`-shaped rerank response onto one score per input
 * document. Accepts the text-embeddings-inference shape (`score`) and the
 * Cohere/Bedrock shape (`relevance_score`); throws when any document is left
 * unscored, so a partial answer falls back to the fused order.
 */
export function scoresFromIndexed(items: unknown, count: number): number[] {
  if (!Array.isArray(items)) throw new Error("rerank response is not a list");
  const scores: Array<number | undefined> = new Array(count).fill(undefined);
  for (const item of items as Array<{ index?: unknown; score?: unknown; relevance_score?: unknown }>) {
    const index = item?.index;
    const score = item?.relevance_score ?? item?.score;
    if (typeof index !== "number" || typeof score !== "number") continue;
    if (index >= 0 && index < count) scores[index] = score;
  }
  if (scores.some((s) => s === undefined)) throw new Error("rerank response left documents unscored");
  return scores as number[];
}

/**
 * A cross-encoder behind an HTTP `/rerank` endpoint — the
 * text-embeddings-inference API that serves bge-reranker and similar models
 * (`POST {query, texts}` → `[{index, score}]`), or any server answering with
 * the Cohere-style `{results: [{index, relevance_score}]}`. RERANK_URL is the
 * server's base URL (or the full `/rerank` URL); the model id only keys the
 * cache, since the server serves one model.
 */
export const httpRerankProvider: RerankProviderPlugin = {
  id: "http",
  defaultModel: "bge-reranker",
  async rerank(query, docs, config) {
    const base = (config.baseUrl ?? "http://localhost:8080").replace(/\/+$/, "");
    const url = base.endsWith("/rerank") ? base : `${base}/rerank`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, texts: docs, truncate: true }),
      signal: config.signal,
    });
    if (!response.ok) throw new Error(`rerank endpoint error: ${response.status}`);
    const payload = (await response.json()) as unknown;
    const items = Array.isArray(payload) ? payload : (payload as { results?: unknown })?.results;
    return scoresFromIndexed(items, docs.length);
  },
};

registerRerankProvider(httpRerankProvider);
