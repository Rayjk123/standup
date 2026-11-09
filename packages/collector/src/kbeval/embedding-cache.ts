import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  registerEmbeddingProvider,
  resolveEmbeddingProvider,
  type EmbeddingProviderPlugin,
} from "@standup/knowledge";
import { sha256Hex } from "./cases.js";

/**
 * The committed embedding cache: real vectors for every chunk and query text,
 * so a run is deterministic and needs no network.
 *
 * `cache.bin` layout (little-endian):
 *   header (16 bytes): magic "KBEC", u32 version (1), u32 dims, u32 count
 *   count records, sorted ascending by key bytes, each (36 + dims) bytes:
 *     32 bytes  key = sha256(modelDigest + "\n" + text), raw digest bytes
 *     f32       scale
 *     dims × i8 quantized components; component i = q[i] * scale
 * Quantization is symmetric per vector: scale = max|v| / 127, q = round(v / scale).
 * `index.json` carries the metadata (model, digest, dims, count, sha256 of cache.bin).
 */

const MAGIC = "KBEC";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const KEY_BYTES = 32;

export const EMBED_PROVIDER_ID = "ollama";
export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_DIMS = 768;
export const OLLAMA_URL = "http://localhost:11434";

export interface CacheIndex {
  format: "kbeval-embedding-cache";
  version: number;
  provider: string;
  model: string;
  modelDigest: string | null;
  dims: number;
  count: number;
  quantization: "int8-symmetric-per-vector";
  binSha256: string;
}

interface Entry {
  scale: number;
  q: Int8Array;
}

export function cacheKey(modelDigest: string, text: string): string {
  return sha256Hex(`${modelDigest}\n${text}`);
}

export function quantize(vector: ArrayLike<number>): Entry {
  let max = 0;
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]));
  const scale = Math.fround(max / 127);
  const q = new Int8Array(vector.length);
  if (scale > 0) {
    for (let i = 0; i < vector.length; i++) {
      q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)));
    }
  }
  return { scale, q };
}

export function dequantize(entry: Entry): number[] {
  const out = new Array<number>(entry.q.length);
  for (let i = 0; i < entry.q.length; i++) out[i] = entry.q[i] * entry.scale;
  return out;
}

export function encodeCache(entries: Map<string, Entry>, dims: number): Uint8Array {
  const keys = [...entries.keys()].sort();
  const recordBytes = KEY_BYTES + 4 + dims;
  const buf = new Uint8Array(HEADER_BYTES + keys.length * recordBytes);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 4; i++) buf[i] = MAGIC.charCodeAt(i);
  view.setUint32(4, FORMAT_VERSION, true);
  view.setUint32(8, dims, true);
  view.setUint32(12, keys.length, true);
  let offset = HEADER_BYTES;
  for (const key of keys) {
    const entry = entries.get(key)!;
    if (entry.q.length !== dims) {
      throw new Error(`embedding cache: vector width ${entry.q.length} != ${dims}`);
    }
    buf.set(Buffer.from(key, "hex"), offset);
    view.setFloat32(offset + KEY_BYTES, entry.scale, true);
    buf.set(new Uint8Array(entry.q.buffer, entry.q.byteOffset, dims), offset + KEY_BYTES + 4);
    offset += recordBytes;
  }
  return buf;
}

export function decodeCache(buf: Uint8Array): { dims: number; entries: Map<string, Entry> } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== MAGIC) throw new Error("embedding cache: bad magic");
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) throw new Error(`embedding cache: unsupported version ${version}`);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const recordBytes = KEY_BYTES + 4 + dims;
  if (buf.byteLength !== HEADER_BYTES + count * recordBytes) {
    throw new Error("embedding cache: truncated or oversized cache.bin");
  }
  const entries = new Map<string, Entry>();
  let offset = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const key = Buffer.from(buf.subarray(offset, offset + KEY_BYTES)).toString("hex");
    const scale = view.getFloat32(offset + KEY_BYTES, true);
    const q = new Int8Array(dims);
    q.set(new Int8Array(buf.buffer, buf.byteOffset + offset + KEY_BYTES + 4, dims));
    entries.set(key, { scale, q });
    offset += recordBytes;
  }
  return { dims, entries };
}

/** A loaded cache directory plus per-run usage bookkeeping. */
export class EmbeddingCache {
  private entries = new Map<string, Entry>();
  private used = new Set<string>();
  private dirty = false;
  modelDigest: string | null = null;
  dims = EMBED_DIMS;

  constructor(readonly dir: string) {
    const indexPath = join(dir, "index.json");
    const binPath = join(dir, "cache.bin");
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, "utf-8")) as CacheIndex;
      this.modelDigest = index.modelDigest;
      this.dims = index.dims;
    }
    if (existsSync(binPath)) {
      const decoded = decodeCache(new Uint8Array(readFileSync(binPath)));
      this.entries = decoded.entries;
      this.dims = decoded.dims;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(text: string, digest: string): number[] | undefined {
    const key = cacheKey(digest, text);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.used.add(key);
    return dequantize(entry);
  }

  /** Stores a vector and returns its dequantized form, so a fresh fetch and a cache hit embed identically. */
  put(text: string, digest: string, vector: number[]): number[] {
    const key = cacheKey(digest, text);
    const entry = quantize(vector);
    this.entries.set(key, entry);
    this.used.add(key);
    this.dirty = true;
    return dequantize(entry);
  }

  /** Drops every entry not read or written this run; returns how many were removed. */
  prune(): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (!this.used.has(key)) {
        this.entries.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  save(force = false): void {
    if (!this.dirty && !force) return;
    mkdirSync(this.dir, { recursive: true });
    const bin = encodeCache(this.entries, this.dims);
    writeFileSync(join(this.dir, "cache.bin"), bin);
    const index: CacheIndex = {
      format: "kbeval-embedding-cache",
      version: FORMAT_VERSION,
      provider: EMBED_PROVIDER_ID,
      model: EMBED_MODEL,
      modelDigest: this.modelDigest,
      dims: this.dims,
      count: this.entries.size,
      quantization: "int8-symmetric-per-vector",
      binSha256: sha256Hex(bin),
    };
    writeFileSync(join(this.dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
    this.dirty = false;
  }
}

/** Reads the installed model's digest from a local Ollama's /api/tags. */
export async function fetchOllamaDigest(model = EMBED_MODEL, baseUrl = OLLAMA_URL): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const body = (await res.json()) as { models?: Array<{ name: string; model?: string; digest: string }> };
  const match = (body.models ?? []).find(
    (m) => m.name === model || m.name === `${model}:latest` || m.model === `${model}:latest`
  );
  if (!match) throw new Error(`Ollama has no ${model} model — run \`ollama pull ${model}\``);
  return match.digest;
}

async function fetchOllamaEmbedding(text: string, model: string, baseUrl: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/embeddings returned ${res.status}`);
  const body = (await res.json()) as { embedding: number[] };
  return body.embedding;
}

export interface EmbeddingStats {
  hits: number;
  misses: number;
  fetched: number;
  /** Cache keys of the texts that missed (sorted, deduplicated) — stable across runs. */
  missKeys: string[];
  /** The last provider error seen while refreshing, if any. */
  lastError?: string;
}

/** Anything that turns text into a vector for the eval (the cache, or a test fake). */
export interface EmbeddingSource {
  embed(text: string): Promise<number[] | null>;
  stats(): EmbeddingStats;
}

/**
 * Serves embeddings from the cache. On a miss it fetches from local Ollama when
 * `refresh` is set; otherwise the miss is recorded and null returned — the same
 * thing production does when the provider fails, so the chunk is skipped.
 */
export class CachedEmbeddingSource implements EmbeddingSource {
  private hits = 0;
  private fetched = 0;
  private missKeys = new Set<string>();
  private missCount = 0;
  lastError: string | null = null;

  constructor(
    private cache: EmbeddingCache,
    private digest: string,
    private refresh: boolean,
    private baseUrl = OLLAMA_URL
  ) {}

  async embed(text: string): Promise<number[] | null> {
    const cached = this.cache.get(text, this.digest);
    if (cached) {
      this.hits++;
      return cached;
    }
    if (this.refresh) {
      try {
        const vector = await fetchOllamaEmbedding(text, EMBED_MODEL, this.baseUrl);
        this.fetched++;
        return this.cache.put(text, this.digest, vector);
      } catch (err) {
        // generateEmbedding would swallow this into a null; keep it visible.
        this.lastError = String(err);
      }
    }
    this.missCount++;
    this.missKeys.add(cacheKey(this.digest, text));
    return null;
  }

  stats(): EmbeddingStats {
    return {
      hits: this.hits,
      misses: this.missCount,
      fetched: this.fetched,
      missKeys: [...this.missKeys].sort(),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

/**
 * Installs `source` as the `ollama` embedding provider with the production
 * plugin's model and width, and `modelDigest` as the digest it reports (the
 * cache's recorded digest), so the corpus fingerprint and every query path read
 * exactly as a live Ollama install of that model. Returns a restore function.
 */
export function installEmbeddingProvider(
  source: EmbeddingSource,
  modelDigest: string | null = null
): () => void {
  const previous = resolveEmbeddingProvider(EMBED_PROVIDER_ID);
  const plugin: EmbeddingProviderPlugin = {
    id: EMBED_PROVIDER_ID,
    defaultModel: EMBED_MODEL,
    dimensions: EMBED_DIMS,
    embed: (text) => source.embed(text),
    modelDigest: async () => modelDigest,
  };
  registerEmbeddingProvider(plugin);
  return () => {
    if (previous) registerEmbeddingProvider(previous);
  };
}
