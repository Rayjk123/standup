import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  registerEmbeddingProvider,
  resolveEmbeddingProvider,
  type EmbeddingProviderPlugin,
} from "../embeddings.js";

/**
 * Embeddings for the retrieval eval, served from committed int8 caches so a
 * run is deterministic and normally needs no network.
 *
 * Two caches share one on-disk format (the knowledge eval's `cache.bin`):
 *   header (16 bytes): magic "KBEC", u32 version (1), u32 dims, u32 count
 *   count records sorted by key, each (36 + dims) bytes:
 *     32 bytes  key = sha256(modelDigest + "\n" + text)
 *     f32       scale
 *     dims × i8 components; component i = q[i] * scale
 * The knowledge eval's cache (`packages/knowledge/eval/embeddings`) is read
 * only. Texts it lacks — this harness's own queries and corpus additions — are
 * fetched once from a local Ollama `nomic-embed-text` and kept in the harness's
 * own cache (`packages/knowledge/eval/retrieval/embeddings`). Every vector is
 * served dequantized, so a freshly fetched text embeds exactly as it will when
 * read back from the cache on the next run.
 */

const MAGIC = "KBEC";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;
const KEY_BYTES = 32;

export const EVAL_EMBED_PROVIDER_ID = "ollama";
export const EVAL_EMBED_MODEL = "nomic-embed-text";
export const EVAL_EMBED_DIMS = 768;
export const OLLAMA_URL = "http://localhost:11434";

export interface CacheEntry {
  scale: number;
  q: Int8Array;
}

export function cacheKey(modelDigest: string, text: string): string {
  return createHash("sha256").update(`${modelDigest}\n${text}`).digest("hex");
}

export function quantize(vector: ArrayLike<number>): CacheEntry {
  let max = 0;
  for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]));
  const scale = Math.fround(max / 127);
  const q = new Int8Array(vector.length);
  if (scale > 0) {
    for (let i = 0; i < vector.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(vector[i] / scale)));
  }
  return { scale, q };
}

export function dequantize(entry: CacheEntry): number[] {
  const out = new Array<number>(entry.q.length);
  for (let i = 0; i < entry.q.length; i++) out[i] = entry.q[i] * entry.scale;
  return out;
}

export function encodeCache(entries: ReadonlyMap<string, CacheEntry>, dims: number): Uint8Array {
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
    if (entry.q.length !== dims) throw new Error(`embedding cache: vector width ${entry.q.length} != ${dims}`);
    buf.set(Buffer.from(key, "hex"), offset);
    view.setFloat32(offset + KEY_BYTES, entry.scale, true);
    buf.set(new Uint8Array(entry.q.buffer, entry.q.byteOffset, dims), offset + KEY_BYTES + 4);
    offset += recordBytes;
  }
  return buf;
}

export function decodeCache(buf: Uint8Array): { dims: number; entries: Map<string, CacheEntry> } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== MAGIC) throw new Error("embedding cache: bad magic");
  const version = view.getUint32(4, true);
  if (version !== FORMAT_VERSION) throw new Error(`embedding cache: unsupported version ${version}`);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const recordBytes = KEY_BYTES + 4 + dims;
  if (buf.byteLength !== HEADER_BYTES + count * recordBytes) throw new Error("embedding cache: truncated or oversized cache.bin");
  const entries = new Map<string, CacheEntry>();
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

interface CacheFiles {
  modelDigest: string | null;
  dims: number;
  entries: Map<string, CacheEntry>;
}

function readCacheDir(dir: string): CacheFiles {
  const indexPath = join(dir, "index.json");
  const binPath = join(dir, "cache.bin");
  let modelDigest: string | null = null;
  let dims = EVAL_EMBED_DIMS;
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as { modelDigest?: string | null; dims?: number };
    modelDigest = index.modelDigest ?? null;
    dims = index.dims ?? dims;
  }
  let entries = new Map<string, CacheEntry>();
  if (existsSync(binPath)) {
    const decoded = decodeCache(new Uint8Array(readFileSync(binPath)));
    entries = decoded.entries;
    dims = decoded.dims;
  }
  return { modelDigest, dims, entries };
}

async function fetchOllamaEmbedding(text: string, baseUrl: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EVAL_EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/embeddings returned ${res.status}`);
  const body = (await res.json()) as { embedding?: number[] };
  if (!Array.isArray(body.embedding)) throw new Error("Ollama /api/embeddings returned no embedding");
  return body.embedding;
}

export interface EmbeddingUsage {
  /** Served from the knowledge eval's cache. */
  baseHits: number;
  /** Served from the harness's own cache. */
  harnessHits: number;
  /** Fetched from Ollama this run and added to the harness cache. */
  fetched: number;
  /** Neither cached nor fetchable: embedded as null, as production does when the provider fails. */
  misses: number;
  lastError?: string;
}

export interface EvalEmbeddingsOptions {
  /** The knowledge eval's committed cache directory (read only). */
  baseDir: string;
  /** The harness's own cache directory (read, and written on save). */
  harnessDir: string;
  /** Fetch a missing text from local Ollama. Off = a miss embeds as null. */
  fetchMissing: boolean;
  ollamaUrl?: string;
}

/** Text → vector for the eval: the base cache, then the harness cache, then (optionally) Ollama. */
export class EvalEmbeddings {
  private base: CacheFiles;
  private harness: CacheFiles;
  private dirty = false;
  readonly digest: string;
  private usage: EmbeddingUsage = { baseHits: 0, harnessHits: 0, fetched: 0, misses: 0 };

  constructor(private opts: EvalEmbeddingsOptions) {
    this.base = readCacheDir(opts.baseDir);
    this.harness = readCacheDir(opts.harnessDir);
    const digest = this.base.modelDigest ?? this.harness.modelDigest;
    if (!digest) throw new Error(`no model digest recorded in ${opts.baseDir}/index.json`);
    this.digest = digest;
  }

  async embed(text: string): Promise<number[] | null> {
    const key = cacheKey(this.digest, text);
    const fromBase = this.base.entries.get(key);
    if (fromBase) {
      this.usage.baseHits++;
      return dequantize(fromBase);
    }
    const fromHarness = this.harness.entries.get(key);
    if (fromHarness) {
      this.usage.harnessHits++;
      return dequantize(fromHarness);
    }
    if (this.opts.fetchMissing) {
      try {
        const vector = await fetchOllamaEmbedding(text, this.opts.ollamaUrl ?? OLLAMA_URL);
        const entry = quantize(vector);
        this.harness.entries.set(key, entry);
        this.dirty = true;
        this.usage.fetched++;
        return dequantize(entry);
      } catch (err) {
        this.usage.lastError = String(err);
      }
    }
    this.usage.misses++;
    return null;
  }

  stats(): EmbeddingUsage {
    return { ...this.usage };
  }

  /** Writes the harness cache when this run added to it. */
  save(): void {
    if (!this.dirty) return;
    mkdirSync(this.opts.harnessDir, { recursive: true });
    const bin = encodeCache(this.harness.entries, this.base.dims);
    writeFileSync(join(this.opts.harnessDir, "cache.bin"), bin);
    const index = {
      format: "retrieval-eval-embedding-cache",
      version: FORMAT_VERSION,
      provider: EVAL_EMBED_PROVIDER_ID,
      model: EVAL_EMBED_MODEL,
      modelDigest: this.digest,
      dims: this.base.dims,
      count: this.harness.entries.size,
      quantization: "int8-symmetric-per-vector",
      binSha256: createHash("sha256").update(bin).digest("hex"),
    };
    writeFileSync(join(this.opts.harnessDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
    this.dirty = false;
  }
}

/**
 * Installs `source` as the `ollama` embedding provider (production's model and
 * width), so indexing and every query path embed through it. Returns a restore
 * function.
 */
export function installEvalEmbeddingProvider(source: EvalEmbeddings): () => void {
  const previous = resolveEmbeddingProvider(EVAL_EMBED_PROVIDER_ID);
  const plugin: EmbeddingProviderPlugin = {
    id: EVAL_EMBED_PROVIDER_ID,
    defaultModel: EVAL_EMBED_MODEL,
    dimensions: EVAL_EMBED_DIMS,
    embed: (text) => source.embed(text),
    modelDigest: async () => source.digest,
  };
  registerEmbeddingProvider(plugin);
  return () => {
    if (previous) registerEmbeddingProvider(previous);
  };
}
