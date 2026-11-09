import { expect, test, describe } from "bun:test";
import { createStore, setSetting } from "@standup/store";
import { KnowledgeStore } from "./store.js";
import { EMBEDDING_FINGERPRINT_KEY, registerEmbeddingProvider } from "./embeddings.js";
import { calibrateCosineBand, calibrationStatus, cosineBandFor, ensureCosineCalibration, OFF_DOMAIN_PROBES } from "./calibration.js";
import { searchKnowledge } from "./search.js";
import { CONFIDENCE_FLOORS, DEFAULT_COSINE_BAND } from "./relevance.js";
import type { KnowledgeDoc } from "./types.js";
import { chunkEmbedding, embeddingToBlob } from "./vec.js";

/**
 * A toy embedding space: a text sits at an azimuth on the unit sphere's
 * equator — or, for an off-domain probe, lifted toward the pole — and every
 * angle is multiplied by `spread`. A larger spread is a model whose cosines run
 * lower for the same relatedness: the provider shift a fixed band misreads.
 */
const AZIMUTH: Record<string, number> = {
  "Retry policy": 0,
  "Deploy runbook": 1.2,
  "Scope gate": 2.4,
  "Embedding provider": 3.6,
  "Graph edges": 4.8,
  // Related to the retry doc, but not a restatement of it.
  "how does the retry policy back off": 0.9,
};
function place(text: string): { azimuth: number; elevation: number } {
  if (text in AZIMUTH) return { azimuth: AZIMUTH[text], elevation: 0 };
  const i = OFF_DOMAIN_PROBES.indexOf(text);
  return { azimuth: i >= 0 ? 1.2 * (i % 5) : 5.5, elevation: 1.2 };
}
const vec = (text: string, spread: number, offset = 0) => {
  const { azimuth, elevation } = place(text);
  const a = (azimuth + offset) * spread;
  const e = elevation * spread;
  return [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)];
};

function corpus(spread: number) {
  const store = createStore(":memory:");
  const k = new KnowledgeStore(store.db);
  const titles = ["Retry policy", "Deploy runbook", "Scope gate", "Embedding provider", "Graph edges"];
  titles.forEach((title, i) => {
    const doc: KnowledgeDoc = {
      id: `d${i}`,
      projectId: "proj",
      slug: `d${i}`,
      title,
      body: `${title.toLowerCase()} notes`,
      updatedAt: new Date("2026-08-16T00:00:00Z"),
      filePath: "/x",
      originClass: "owner",
    };
    k.upsertDoc(doc);
    // The doc's chunk sits close to its own title.
    k.upsertChunk({ id: `c${i}`, knowledgeId: `d${i}`, chunkIndex: 0, text: title, embedding: vec(title, spread, 0.1) });
  });
  setSetting(store.db, EMBEDDING_FINGERPRINT_KEY, `toy:spread=${spread}`);
  const id = `toy-${spread}`;
  registerEmbeddingProvider({ id, defaultModel: "m", embed: async (text: string) => vec(text, spread) });
  return { store, provider: id };
}

describe("relevance cosine calibration", () => {
  test("an uncalibrated corpus reads cosines through the default band and says so", () => {
    const { store } = corpus(1);
    expect(calibrationStatus(store.db).status).toBe("uncalibrated");
    expect(cosineBandFor(store.db)).toEqual({ ...DEFAULT_COSINE_BAND, calibrated: false });
  });

  test("the band is measured from the corpus and stored under the embedding fingerprint", async () => {
    const { store, provider } = corpus(1);
    const calibration = await calibrateCosineBand(store.db, provider);
    expect(calibration).not.toBeNull();
    expect(calibration!.fingerprint).toBe("toy:spread=1");
    expect(calibration!.high).toBeGreaterThan(calibration!.low);
    const status = calibrationStatus(store.db);
    expect(status.status).toBe("calibrated");
    expect(status.low).toBeCloseTo(calibration!.low, 4);
    // A new fingerprint (a reindex under another model) makes it stale until recalibrated.
    setSetting(store.db, EMBEDDING_FINGERPRINT_KEY, "toy:other");
    expect(calibrationStatus(store.db).status).toBe("stale");
    expect(cosineBandFor(store.db).calibrated).toBe(false);
  });

  test("a lower-cosine model gets a lower band, so the relevant doc stays confident", async () => {
    const q = "how does the retry policy back off";
    const results: Record<string, { uncalibrated: number; calibrated: number; band: number[] }> = {};
    for (const spread of [1, 1.4]) {
      const { store, provider } = corpus(spread);
      const before = await searchKnowledge(store.db, "proj", q, provider, { limit: 5 });
      const status = await ensureCosineCalibration(store.db, provider);
      const after = await searchKnowledge(store.db, "proj", q, provider, { limit: 5 });
      const rel = (rs: typeof before) => rs.find((r) => r.id === "d0")!.relevance!;
      results[spread] = { uncalibrated: rel(before), calibrated: rel(after), band: [status.low, status.high] };
      expect(after.find((r) => r.id === "d0")!.relevanceSignals!.cosineBand!.calibrated).toBe(true);
    }
    // The wider-spread model's band sits lower.
    expect(results[1.4].band[0]).toBeLessThan(results[1].band[0]);
    expect(results[1.4].band[1]).toBeLessThan(results[1].band[1]);
    // Calibrated, the relevant doc reads about the same under both models and
    // clears the floor; through the fixed band the shifted model loses it.
    expect(Math.abs(results[1.4].calibrated - results[1].calibrated)).toBeLessThan(0.1);
    expect(results[1.4].calibrated).toBeGreaterThan(results[1.4].uncalibrated);
    expect(results[1.4].calibrated).toBeGreaterThanOrEqual(CONFIDENCE_FLOORS.search);
  });

  test("no fingerprint or no embedded chunk leaves the corpus uncalibrated", async () => {
    const store = createStore(":memory:");
    new KnowledgeStore(store.db);
    registerEmbeddingProvider({ id: "toy-empty", defaultModel: "m", embed: async () => [1, 0] });
    expect(await calibrateCosineBand(store.db, "toy-empty")).toBeNull();
    setSetting(store.db, EMBEDDING_FINGERPRINT_KEY, "toy:empty");
    expect(await calibrateCosineBand(store.db, "toy-empty")).toBeNull();
    expect(calibrationStatus(store.db).status).toBe("uncalibrated");
  });
});

describe("calibration details", () => {
  test("the low end is the lowest best-chunk cosine an off-domain probe reaches", async () => {
    const { store, provider } = corpus(1);
    const calibration = (await calibrateCosineBand(store.db, provider))!;
    const vectors = (
      store.db.query("SELECT embedding_blob AS b, embedding_json AS e FROM knowledge_chunks").all() as Array<{
        b: Uint8Array | null;
        e: string;
      }>
    ).map((r) => chunkEmbedding(r.b, r.e)!);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    const maxima = OFF_DOMAIN_PROBES.map((p) => Math.max(...vectors.map((v) => dot(vec(p, 1), v))));
    expect(calibration.low).toBeCloseTo(Math.min(...maxima), 3);
  });

  test("re-embedded vectors under an unchanged fingerprint make the band stale", async () => {
    const { store, provider } = corpus(1);
    await calibrateCosineBand(store.db, provider);
    expect(calibrationStatus(store.db).status).toBe("calibrated");
    store.db.run("UPDATE knowledge_chunks SET embedding_blob = ? WHERE id = 'c0'", [embeddingToBlob([0, 1, 0])]);
    expect(calibrationStatus(store.db).status).toBe("stale");
  });

  test("a chunk still holding a JSON vector is read through the fallback", async () => {
    const { store, provider } = corpus(1);
    const blobBand = (await calibrateCosineBand(store.db, provider))!;
    const c0 = store.db.query("SELECT embedding_blob AS b FROM knowledge_chunks WHERE id = 'c0'").get() as {
      b: Uint8Array;
    };
    store.db.run("UPDATE knowledge_chunks SET embedding_blob = NULL, embedding_json = ? WHERE id = 'c0'", [
      JSON.stringify(chunkEmbedding(c0.b, null)),
    ]);
    const jsonBand = (await calibrateCosineBand(store.db, provider))!;
    expect(jsonBand.low).toBeCloseTo(blobBand.low, 6);
    expect(jsonBand.high).toBeCloseTo(blobBand.high, 6);
  });
});
