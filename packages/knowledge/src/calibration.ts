import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { getSetting, setSetting } from "@standup/store";
import { EMBEDDING_FINGERPRINT_KEY, generateEmbedding, type EmbeddingConfig, type EmbeddingProvider } from "./embeddings.js";
import { DEFAULT_COSINE_BAND, type CosineBand } from "./relevance.js";
import { chunkEmbedding } from "./vec.js";

/**
 * Per-corpus calibration of the cosine band the relevance's semantic term is
 * read through. Cosine magnitudes depend on the embedding model — another
 * provider's unrelated text can sit 0.2 lower or higher than nomic-embed-text's
 * — so a fixed band would collapse or inflate every relevance. The band is
 * measured on the corpus itself, under the embedding fingerprint it was
 * measured with, and recomputed when the fingerprint, a sample of the stored
 * vectors, or the corpus size moves:
 *
 *  - low: the lowest best-chunk cosine a fixed set of off-domain probe
 *    questions reach (CALIBRATION_LOW_QUANTILE). Text about nothing in the
 *    corpus finds a chunk this close, so a cosine at or below it is no evidence.
 *  - high: the median cosine between a sampled doc's title, embedded as a
 *    query, and that doc's own best chunk — what a query that names a doc's
 *    subject reaches.
 *
 * Until a corpus is calibrated (no embeddings yet, or the provider could not
 * embed) the nomic-embed-text defaults apply and the band reports itself
 * uncalibrated.
 */

/** Settings key holding the calibration, next to EMBEDDING_FINGERPRINT_KEY. */
export const RELEVANCE_CALIBRATION_KEY = "embedding_relevance_calibration";

/** Questions about nothing a software knowledge base covers. */
export const OFF_DOMAIN_PROBES: readonly string[] = [
  "a recipe for lemon cake with buttercream frosting",
  "how to change a flat bicycle tire",
  "the best time of year to visit Lisbon",
  "common symptoms of a seasonal cold",
  "learning to play the violin as an adult",
  "the history of the Roman empire",
  "how to repot a houseplant",
  "when you are allowed to castle in chess",
];

/** How many doc titles the high end is measured from. */
export const CALIBRATION_TITLE_SAMPLE = 48;
/** How many chunk vectors the probes are scored against, sampled by a hash of the chunk id. */
export const CALIBRATION_CHUNK_SAMPLE = 4000;
/**
 * Which quantile of the probes' best-chunk cosines is the band's low end (0 =
 * the farthest probe, 1 = the closest). The farthest: on the eval's dev split
 * every higher quantile cost recall without returning more negatives empty —
 * fixture search recall@5 0.935 at 0 against 0.915 at 0.25, 0.5 and 1.0,
 * fresh-over-stale 0.877 against 0.807, injection recall 0.923 against 0.846 at
 * 1.0 — and the snapshot's negative empty-rate was 0.600 at 0, 0.25 and 0.5.
 */
export const CALIBRATION_LOW_QUANTILE = (() => {
  const parsed = Number(process.env.KNOWLEDGE_CALIBRATION_LOW_QUANTILE);
  return process.env.KNOWLEDGE_CALIBRATION_LOW_QUANTILE !== undefined && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : 0;
})();
/** How many stored vectors the staleness check fingerprints. */
const VECTOR_SAMPLE = 3;
/** The narrowest band accepted; a narrower measurement keeps the defaults. */
const MIN_BAND_WIDTH = 0.05;

export interface RelevanceCalibration {
  /** The embedding fingerprint the band was measured under. */
  fingerprint: string;
  low: number;
  high: number;
  probes: number;
  titles: number;
  chunks: number;
  /** A hash of a few stored vectors: a re-embed under an unchanged fingerprint moves it. */
  vectorSample?: string;
}

export interface CalibrationStatus extends CosineBand {
  /**
   * calibrated: measured on this corpus as it is; stale: measured under another
   * fingerprint, other vectors or a much different corpus size; uncalibrated:
   * never measured.
   */
  status: "calibrated" | "stale" | "uncalibrated";
  fingerprint: string | null;
}

function readSetting(db: Database, key: string): string | null {
  try {
    return getSetting(db, key);
  } catch {
    // A bare knowledge index (no collector settings table) has no fingerprint.
    return null;
  }
}

/**
 * Whether the embedded corpus has grown or shrunk by more than a quarter since
 * the band was measured — a calibration taken mid-backfill is redone once the
 * corpus is embedded.
 */
function corpusMoved(db: Database, measuredChunks: number): boolean {
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM knowledge_chunks").get() as { n: number } | null;
    const now = row?.n ?? 0;
    return Math.abs(now - measuredChunks) > 0.25 * Math.max(measuredChunks, 1);
  } catch {
    return false;
  }
}

/** A hash of the VECTOR_SAMPLE lowest-id chunk vectors, or null when nothing is embedded. */
function vectorSample(db: Database): string | null {
  try {
    const rows = db
      .query(
        `SELECT embedding_blob AS b, embedding_json AS e FROM knowledge_chunks ORDER BY id LIMIT ${VECTOR_SAMPLE}`
      )
      .all() as Array<{ b: Uint8Array | null; e: string }>;
    if (rows.length === 0) return null;
    const h = createHash("sha256");
    for (const r of rows) h.update(r.b && r.b.byteLength > 0 ? r.b : r.e);
    return h.digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** The stored calibration and whether it matches the current fingerprint and corpus. */
export function calibrationStatus(db: Database): CalibrationStatus {
  const fingerprint = readSetting(db, EMBEDDING_FINGERPRINT_KEY);
  const raw = readSetting(db, RELEVANCE_CALIBRATION_KEY);
  let stored: RelevanceCalibration | null = null;
  try {
    stored = raw ? (JSON.parse(raw) as RelevanceCalibration) : null;
  } catch {
    stored = null;
  }
  if (stored && Number.isFinite(stored.low) && Number.isFinite(stored.high)) {
    const current =
      fingerprint !== null &&
      stored.fingerprint === fingerprint &&
      !corpusMoved(db, stored.chunks) &&
      (stored.vectorSample === undefined || stored.vectorSample === vectorSample(db));
    if (current) {
      return { status: "calibrated", low: stored.low, high: stored.high, fingerprint };
    }
    return { status: "stale", ...DEFAULT_COSINE_BAND, fingerprint };
  }
  return { status: "uncalibrated", ...DEFAULT_COSINE_BAND, fingerprint };
}

/** The band search reads cosines through: the corpus's own when calibrated, else the defaults. */
export function cosineBandFor(db: Database): CosineBand & { calibrated: boolean } {
  const s = calibrationStatus(db);
  return { low: s.low, high: s.high, calibrated: s.status === "calibrated" };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** The q-quantile of xs (linear interpolation between order statistics). */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Measures the cosine band on the corpus's stored chunk vectors and stores it
 * under the current embedding fingerprint. Deterministic for a given corpus and
 * model: the probes are fixed and the titles are sampled by a hash of the doc
 * id. Returns null — leaving any stored calibration alone — when there is no
 * fingerprint, no embedded chunk, the provider cannot embed, or the measured
 * band is narrower than MIN_BAND_WIDTH.
 */
export async function calibrateCosineBand(
  db: Database,
  provider: EmbeddingProvider,
  config: EmbeddingConfig = {}
): Promise<RelevanceCalibration | null> {
  const fingerprint = readSetting(db, EMBEDDING_FINGERPRINT_KEY);
  if (fingerprint === null) return null;
  // Ids only first, so the sample is chosen without loading every vector.
  const index = db
    .query(
      `SELECT kc.id AS id, kc.knowledge_id AS doc, k.title AS title
       FROM knowledge_chunks kc JOIN knowledge k ON k.id = kc.knowledge_id`
    )
    .all() as Array<{ id: string; doc: string; title: string }>;
  if (index.length === 0) return null;
  const hashOf = (id: string) => createHash("sha256").update(id).digest("hex");
  const titles = new Map<string, string>();
  for (const r of index) if (r.title.trim().length > 0) titles.set(r.doc, r.title);
  const sampledDocs = [...titles.keys()].sort((a, b) => (hashOf(a) < hashOf(b) ? -1 : 1)).slice(0, CALIBRATION_TITLE_SAMPLE);
  const sampledDocSet = new Set(sampledDocs);
  const probeChunkIds = new Set(
    index
      .map((r) => r.id)
      .sort((a, b) => (hashOf(a) < hashOf(b) ? -1 : 1))
      .slice(0, CALIBRATION_CHUNK_SAMPLE)
  );
  const wanted = index.filter((r) => probeChunkIds.has(r.id) || sampledDocSet.has(r.doc));
  const vectorOf = new Map<string, number[]>();
  const fetch = db.query("SELECT embedding_blob AS b, embedding_json AS e FROM knowledge_chunks WHERE id = ?");
  for (const r of wanted) {
    const row = fetch.get(r.id) as { b: Uint8Array | null; e: string } | null;
    const vector = row ? chunkEmbedding(row.b, row.e) : null;
    if (vector) vectorOf.set(r.id, vector);
  }
  const vectors = [...probeChunkIds].map((id) => vectorOf.get(id)).filter((v): v is number[] => v !== undefined);
  const byDoc = new Map<string, { title: string; vectors: number[][] }>();
  for (const r of wanted) {
    if (!sampledDocSet.has(r.doc)) continue;
    const v = vectorOf.get(r.id);
    if (!v) continue;
    const entry = byDoc.get(r.doc) ?? { title: titles.get(r.doc)!, vectors: [] };
    entry.vectors.push(v);
    byDoc.set(r.doc, entry);
  }

  const probeMaxima: number[] = [];
  for (const probe of OFF_DOMAIN_PROBES) {
    const q = await generateEmbedding(probe, provider, config);
    if (!q) return null;
    let best = -1;
    for (const v of vectors) best = Math.max(best, cosine(q, v));
    probeMaxima.push(best);
  }

  const titleCosines: number[] = [];
  for (const doc of sampledDocs) {
    const d = byDoc.get(doc);
    if (!d) continue;
    const q = await generateEmbedding(d.title, provider, config);
    if (!q) return null;
    let best = -1;
    for (const v of d.vectors) best = Math.max(best, cosine(q, v));
    titleCosines.push(best);
  }
  if (titleCosines.length === 0) return null;

  const low = quantile(probeMaxima, CALIBRATION_LOW_QUANTILE);
  const high = median(titleCosines);
  if (!(high - low >= MIN_BAND_WIDTH)) return null;
  const calibration: RelevanceCalibration = {
    fingerprint,
    low: Math.round(low * 1e4) / 1e4,
    high: Math.round(high * 1e4) / 1e4,
    probes: probeMaxima.length,
    titles: titleCosines.length,
    chunks: index.length,
    ...(vectorSample(db) ? { vectorSample: vectorSample(db)! } : {}),
  };
  try {
    setSetting(db, RELEVANCE_CALIBRATION_KEY, JSON.stringify(calibration));
  } catch {
    // A bare knowledge index has nowhere to keep it; search keeps the defaults.
    return null;
  }
  return calibration;
}

/**
 * Calibrates when the stored band is missing or was measured under another
 * fingerprint. The index-time hook: run once the corpus is embedded.
 */
export async function ensureCosineCalibration(
  db: Database,
  provider: EmbeddingProvider,
  config: EmbeddingConfig = {}
): Promise<CalibrationStatus> {
  const before = calibrationStatus(db);
  if (before.status === "calibrated") return before;
  await calibrateCosineBand(db, provider, config);
  return calibrationStatus(db);
}
