import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CachedEmbeddingSource,
  EmbeddingCache,
  cacheKey,
  decodeCache,
  dequantize,
  encodeCache,
  quantize,
} from "./embedding-cache.js";
import { sha256Hex } from "./cases.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function vector(seed: number, dims = 8): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed * 7 + i) * (i % 3 === 0 ? 0.9 : 0.2));
}

describe("embedding cache format", () => {
  test("the key is sha256(digest + newline + text)", () => {
    expect(cacheKey("abc", "hello")).toBe(sha256Hex("abc\nhello"));
  });

  test("int8 quantization stays within one step of the original", () => {
    const v = vector(3);
    const entry = quantize(v);
    const back = dequantize(entry);
    for (let i = 0; i < v.length; i++) expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(entry.scale);
    expect(Math.max(...[...entry.q].map(Math.abs))).toBe(127);
  });

  test("a zero vector round-trips", () => {
    expect(dequantize(quantize([0, 0, 0]))).toEqual([0, 0, 0]);
  });

  test("encode/decode round-trips and is order-independent", () => {
    const a = new Map([
      [cacheKey("d", "one"), quantize(vector(1))],
      [cacheKey("d", "two"), quantize(vector(2))],
    ]);
    const b = new Map([...a.entries()].reverse());
    const bin = encodeCache(a, 8);
    expect(Buffer.from(encodeCache(b, 8)).equals(Buffer.from(bin))).toBe(true);
    expect(bin.byteLength).toBe(16 + 2 * (32 + 4 + 8));
    const decoded = decodeCache(bin);
    expect(decoded.dims).toBe(8);
    for (const [k, e] of a) {
      expect(decoded.entries.get(k)!.scale).toBe(e.scale);
      expect([...decoded.entries.get(k)!.q]).toEqual([...e.q]);
    }
  });

  test("decode rejects a corrupt file", () => {
    const bin = encodeCache(new Map([[cacheKey("d", "x"), quantize(vector(1))]]), 8);
    expect(() => decodeCache(bin.subarray(0, bin.byteLength - 1))).toThrow();
    const bad = new Uint8Array(bin);
    bad[0] = 0;
    expect(() => decodeCache(bad)).toThrow("bad magic");
  });

  test("save/load through a directory, with prune dropping unused entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-cache-"));
    dirs.push(dir);
    const cache = new EmbeddingCache(dir);
    cache.dims = 8;
    cache.modelDigest = "digest";
    const stored = cache.put("alpha", "digest", vector(1));
    cache.put("beta", "digest", vector(2));
    cache.save();
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf-8"));
    expect(index).toMatchObject({ model: "nomic-embed-text", modelDigest: "digest", dims: 8, count: 2 });
    expect(index.binSha256).toBe(sha256Hex(readFileSync(join(dir, "cache.bin"))));

    const reloaded = new EmbeddingCache(dir);
    expect(reloaded.modelDigest).toBe("digest");
    expect(reloaded.get("alpha", "digest")).toEqual(stored);
    expect(reloaded.get("alpha", "other-digest")).toBeUndefined();
    expect(reloaded.prune()).toBe(1);
    reloaded.save();
    expect(new EmbeddingCache(dir).size).toBe(1);
  });

  test("a miss without refresh is recorded and returns null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kbeval-cache-"));
    dirs.push(dir);
    const cache = new EmbeddingCache(dir);
    cache.dims = 8;
    cache.put("known", "d", vector(4));
    const source = new CachedEmbeddingSource(cache, "d", false);
    expect(await source.embed("known")).not.toBeNull();
    expect(await source.embed("unknown")).toBeNull();
    expect(await source.embed("unknown")).toBeNull();
    const stats = source.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.missKeys).toEqual([cacheKey("d", "unknown")]);
  });
});
