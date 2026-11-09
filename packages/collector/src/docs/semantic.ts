/**
 * The Docs tab's semantic index: each doc's body chunked and embedded by the
 * knowledge base's own embedder (the same provider, model and chunker), stored
 * in doc_chunks apart from the knowledge tables, so a doc reaches only its
 * owner's docs search and never knowledge search.
 *
 * The index catches up in the background: `poke()` starts a pass (or queues
 * one after the pass running) that embeds every doc whose chunks are missing
 * or stale (another revision or another embedder), so a doc write never waits
 * on the embedder. Every doc change the docs routes announce pokes, and so
 * does every search, which also picks up docs written any other way. A doc's
 * chunks go with it (ON DELETE CASCADE).
 *
 * A doc the embedder fails on is left alone for DOC_EMBEDDER_REST_MS, and a
 * pass carries on with the docs behind it; a few failures in a row mean the
 * embedder is down, which ends the pass and schedules the next one for when
 * the failed docs are due again. A query the embedder fails on rests search's
 * meaning lookups for DOC_EMBEDDER_REST_MS, so search answers from keywords
 * alone without waiting on it; only that timer's end lifts the rest.
 */
import type { Database } from "bun:sqlite";
import type { DocSearchHit } from "@standup/shared";
import {
  DOC_SEARCH_LIMIT,
  docChunksMark,
  docChunksOf,
  docsToEmbed,
  replaceDocChunks,
  snippetOf,
} from "@standup/store";
import {
  CHUNKER_VERSION,
  blobToEmbedding,
  chunkMarkdown,
  cosineBandFor,
  cosineSimilarity,
  defaultModelFor,
  embeddingToBlob,
  fuseRankedLists,
  generateEmbedding,
  resolveEmbeddingProvider,
} from "@standup/knowledge";
import type { CosineBand, EmbeddingConfig, EmbeddingProvider } from "@standup/knowledge";

/** The most docs a meaning search returns. */
export const DOC_MEANING_LIMIT = 10;
/** How long a search waits on the query's embedding before answering from keywords alone. */
export const DOC_QUERY_EMBED_TIMEOUT_MS = 3000;
/** How long search skips meaning lookups after the embedder failed. */
export const DOC_EMBEDDER_REST_MS = 30_000;
/** How many docs in a row the embedder may fail on before a pass takes it as down. */
const FAILURES_BEFORE_REST = 3;
/** How many docs a pass reads at a time. */
const EMBED_BATCH = 8;
/** How many owners' decoded vectors are kept between searches. */
const CACHED_OWNERS = 4;
/** How long the knowledge base's cosine band is reused before it is read again. */
const BAND_TTL_MS = 5 * 60_000;

/** A doc the meaning search found: its best chunk's cosine and that chunk's text. */
export interface DocMeaningHit {
  id: string;
  cosine: number;
  text: string;
}

/**
 * The cosines a meaning hit must reach, read through the knowledge base's
 * cosine band for this embedder (calibrated on its corpus, else the measured
 * defaults): a sixth of the band above its low end, where off-topic text
 * sits, and within a sixth of the band of the best hit, so a query with a
 * clear match doesn't trail weak ones. On nomic-embed-text's default band
 * (0.45–0.75) that is 0.50: a paraphrase of a doc lands around 0.51–0.65,
 * an unrelated query's best doc below 0.48.
 */
export function meaningFloor(band: CosineBand, best: number): number {
  const sixth = (band.high - band.low) / 6;
  return Math.max(band.low + sixth, best - sixth);
}

/** A chunk's opening for a snippet: its first lines that are neither headings nor code fences. */
function passageOf(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim() && !/^\s*(#|```|~~~)/.test(l))
    .join("\n");
}

export class DocsSemanticIndex {
  private running: Promise<void> | null = null;
  private again = false;
  private restUntil = 0;
  /** When each doc the embedder failed on (by id@revision) is due to be tried again. */
  private readonly failedUntil = new Map<string, number>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private band: { at: number; band: CosineBand } | null = null;
  private readonly vectors = new Map<string, { mark: string; chunks: Array<{ docId: string; text: string; vector: number[] }> }>();

  constructor(
    private readonly db: Database,
    private readonly provider: EmbeddingProvider | null,
    private readonly config: EmbeddingConfig = {},
    private readonly now: () => number = Date.now
  ) {}

  /** Whether an embedder is configured; without one, docs search is keywords only. */
  get enabled(): boolean {
    return !!this.provider && !!resolveEmbeddingProvider(this.provider);
  }

  /** Whether search is resting the embedder after it failed. */
  get resting(): boolean {
    return this.now() < this.restUntil;
  }

  /**
   * What doc_chunks rows are embedded by: the provider, model, output width
   * and chunker version. Rows under any other key are stale.
   */
  get embedder(): string {
    const provider = this.provider ?? "none";
    const model = this.config.model ?? defaultModelFor(provider);
    const width = this.config.dimensions ?? resolveEmbeddingProvider(provider)?.dimensions ?? "native";
    return `${provider}:${model}:${width}|chunker=${CHUNKER_VERSION}`;
  }

  /** Starts a background pass over the stale docs, or queues one after the pass running. */
  poke(): void {
    if (!this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.catchUp();
        } catch (err) {
          console.error("[docs] semantic index pass failed:", err);
        }
      } while (this.again);
      this.running = null;
    })();
  }

  /** Resolves once no pass is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** A doc's chunks embedded, or null at the first chunk the embedder fails on. */
  private async embedDoc(name: string, body: string): Promise<Array<{ text: string; embedding: Uint8Array }> | null> {
    const title = name.replace(/\.md$/i, "") || name;
    const chunks = chunkMarkdown(title, body);
    if (chunks.length === 0) chunks.push({ text: "", embedText: title });
    const embedded: Array<{ text: string; embedding: Uint8Array }> = [];
    for (const chunk of chunks) {
      const vector = await generateEmbedding(chunk.embedText, this.provider!, this.config);
      if (!vector) return null;
      embedded.push({ text: chunk.text, embedding: embeddingToBlob(vector) });
    }
    return embedded;
  }

  /**
   * Embeds stale docs until none is left or the embedder is taken as down;
   * how many docs it indexed. A doc saved again while it was embedded is left
   * for the next pass; one it fails on, until it is due again.
   */
  async catchUp(): Promise<number> {
    let indexed = 0;
    let failuresInRow = 0;
    const embedder = this.embedder;
    const now = this.now();
    for (const [key, until] of this.failedUntil) if (until <= now) this.failedUntil.delete(key);
    const passed = new Set<string>();
    const key = (d: { id: string; revision: number }) => `${d.id}@${d.revision}`;
    const skip = (d: { id: string; revision: number }) => passed.has(key(d)) || this.failedUntil.has(key(d));
    try {
      for (;;) {
        const docs = docsToEmbed(this.db, embedder, EMBED_BATCH + passed.size + this.failedUntil.size).filter((d) => !skip(d));
        if (docs.length === 0) return indexed;
        for (const doc of docs) {
          passed.add(key(doc));
          const chunks = await this.embedDoc(doc.name, doc.body);
          if (!chunks) {
            this.failedUntil.set(key(doc), this.now() + DOC_EMBEDDER_REST_MS);
            if (++failuresInRow >= FAILURES_BEFORE_REST) return indexed;
            continue;
          }
          failuresInRow = 0;
          if (replaceDocChunks(this.db, { docId: doc.id, revision: doc.revision, embedder, chunks })) indexed++;
        }
      }
    } finally {
      this.retryWhenDue();
    }
  }

  /** Schedules a pass for when the earliest failed doc is due again. */
  private retryWhenDue(): void {
    if (this.retry || this.failedUntil.size === 0) return;
    const due = Math.min(...this.failedUntil.values());
    this.retry = setTimeout(() => {
      this.retry = null;
      this.poke();
    }, Math.max(0, due - this.now()));
    this.retry.unref?.();
  }

  /** The owner's current chunks with their vectors decoded, reused while their rows are unchanged. */
  private chunksOf(owner: string): Array<{ docId: string; text: string; vector: number[] }> {
    const mark = docChunksMark(this.db, owner, this.embedder);
    const held = this.vectors.get(owner);
    if (held?.mark === mark) return held.chunks;
    const chunks = docChunksOf(this.db, owner, this.embedder).map((c) => ({
      docId: c.docId,
      text: c.text,
      vector: blobToEmbedding(c.embedding),
    }));
    this.vectors.delete(owner);
    this.vectors.set(owner, { mark, chunks });
    while (this.vectors.size > CACHED_OWNERS) this.vectors.delete(this.vectors.keys().next().value!);
    return chunks;
  }

  private cosineBand(): CosineBand {
    if (!this.band || this.now() - this.band.at > BAND_TTL_MS) this.band = { at: this.now(), band: cosineBandFor(this.db) };
    return this.band.band;
  }

  /**
   * The owner's docs closest in meaning to `query`, best first: each doc's
   * best chunk by cosine, above meaningFloor, up to DOC_MEANING_LIMIT. Empty
   * when there is no embedder, it is resting, or the query can't be embedded
   * in time.
   */
  async search(owner: string, query: string): Promise<DocMeaningHit[]> {
    if (!this.enabled || !query.trim() || this.resting) return [];
    this.poke();
    const chunks = this.chunksOf(owner);
    if (chunks.length === 0) return [];
    const vector = await generateEmbedding(query, this.provider!, {
      ...this.config,
      signal: AbortSignal.timeout(DOC_QUERY_EMBED_TIMEOUT_MS),
    });
    if (!vector) {
      this.restUntil = this.now() + DOC_EMBEDDER_REST_MS;
      return [];
    }
    const best = new Map<string, DocMeaningHit>();
    for (const chunk of chunks) {
      const cosine = cosineSimilarity(vector, chunk.vector);
      const held = best.get(chunk.docId);
      if (!held || cosine > held.cosine) best.set(chunk.docId, { id: chunk.docId, cosine, text: chunk.text });
    }
    const ranked = [...best.values()].sort((a, b) => b.cosine - a.cosine || a.id.localeCompare(b.id));
    const floor = meaningFloor(this.cosineBand(), ranked[0]?.cosine ?? 0);
    return ranked.filter((h) => h.cosine >= floor).slice(0, DOC_MEANING_LIMIT);
  }
}

/**
 * One list of docs search hits from the keyword hits (searchDocs) and the
 * meaning hits: name and path matches first, in their keyword order; then the
 * body matches, merged with the meaning ranking by reciprocal rank (RRF);
 * then the docs found only by meaning, best first. One hit per doc: a doc both
 * found keeps its keyword hit and snippet, and a meaning-only doc carries its
 * closest passage under its path in `pathOf` (a doc missing from it is left
 * out). Up to DOC_SEARCH_LIMIT hits, keyword hits before any meaning-only one.
 */
export function fuseDocHits(
  keyword: readonly DocSearchHit[],
  meaning: readonly DocMeaningHit[],
  pathOf: ReadonlyMap<string, string>
): DocSearchHit[] {
  const named = keyword.filter((h) => h.match === "path");
  const taken = new Set(named.map((h) => h.id));
  const byMeaning: DocSearchHit[] = meaning
    .filter((m) => !taken.has(m.id) && pathOf.has(m.id))
    .map((m) => {
      const passage = passageOf(m.text);
      return { id: m.id, path: pathOf.get(m.id)!, match: "meaning", ...(passage ? { snippet: snippetOf(passage, []) } : {}) };
    });
  const byBody = keyword.filter((h) => h.match === "body");
  const fused = fuseRankedLists([byBody, byMeaning], (h) => h.id);
  return [...named, ...fused.filter((h) => h.match === "body"), ...fused.filter((h) => h.match === "meaning")].slice(0, DOC_SEARCH_LIMIT);
}
