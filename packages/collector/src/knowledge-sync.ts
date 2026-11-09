import type { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  KnowledgeStore,
  KnowledgeLoader,
  chunkMarkdown,
  cosineSimilarity,
  embedChunks,
  defaultModelFor,
  resolveEmbeddingProvider,
  ensureCosineCalibration,
  resolveModelDigest,
  CHUNKER_VERSION,
  EMBEDDING_FINGERPRINT_KEY,
  DEFAULT_SOURCE_KIND,
  type EmbeddingProvider,
  type EmbeddingConfig,
  type KnowledgeDoc,
  type KnowledgeDraft,
} from "@standup/knowledge";
import { getProjects, getSetting, setSetting } from "@standup/store";

const SCRATCH_PROJECT_ID = "scratch";

/** How many stored chunks the boot canary re-embeds. */
export const EMBEDDING_CANARY_SAMPLES = 3;
/**
 * Mean cosine between a canary chunk's stored vector and a fresh embedding of
 * the same text below which the stored vectors are treated as drifted. A
 * deterministic provider reproduces its own vectors at 1.0; a re-pulled or
 * otherwise changed model lands well below.
 */
export const EMBEDDING_CANARY_MIN_COSINE = 0.99;
/** First delay before the background indexer retries after the provider failed. */
export const EMBEDDING_RETRY_INITIAL_MS = 60_000;
/** Ceiling the retry delay doubles up to. */
export const EMBEDDING_RETRY_MAX_MS = 15 * 60_000;
/** Delay before a backfill requested by a request-path sync runs. */
export const EMBEDDING_BACKFILL_DELAY_MS = 30_000;
/**
 * The longest syncDirty trusts the watcher alone: past this since the last
 * full sync, the next syncDirty re-reads every project (catching an event the
 * watcher dropped, e.g. on an inotify queue overflow).
 */
export const KNOWLEDGE_FULL_SYNC_INTERVAL_MS = 10 * 60_000;
/**
 * How long watcher events gather before the background flush syncs the
 * projects they marked dirty: a burst of saves costs one sync per project. A
 * request that syncs (syncDirty) does not wait for it.
 */
export const KNOWLEDGE_WATCH_COALESCE_MS = 5_000;
/**
 * How long syncDirty waits for the watcher to confirm it has reported every
 * earlier change (KnowledgeLoader.flushWatchEvents) before it re-reads as if
 * there were no watcher.
 */
export const KNOWLEDGE_WATCH_FENCE_TIMEOUT_MS = 100;
// Docs the backfill checks between yields to the event loop, so a pass over a
// large corpus whose docs are mostly current never holds the server for long.
const BACKFILL_YIELD_EVERY = 25;
// The text embedded to prove the provider can embed before the index is
// rebuilt for it.
const EMBEDDING_PROBE_TEXT = "embedding provider probe";

/** The parsed parts of an embedding fingerprint (see KnowledgeSync.providerFingerprint). */
interface ParsedFingerprint {
  /** The embedding space: `<provider>:<model>:<width>`, or a legacy `<provider>:<model>[:<dims>]`. */
  space: string;
  /** The model digest, or null when it was unknown when recorded. */
  digest: string | null;
  /** The chunker version, or null when the fingerprint predates chunker versioning. */
  chunker: number | null;
  /** A fingerprint recorded before the digest and chunker parts existed. */
  legacy: boolean;
}

const UNKNOWN_DIGEST = "unknown";

function parseFingerprint(fingerprint: string): ParsedFingerprint {
  const [space, ...parts] = fingerprint.split("|");
  const digestPart = parts.find((p) => p.startsWith("digest="));
  const digest = digestPart ? digestPart.slice("digest=".length) : null;
  const chunkerPart = parts.find((p) => p.startsWith("chunker="));
  const chunker = chunkerPart ? Number(chunkerPart.slice("chunker=".length)) : NaN;
  return {
    space,
    digest: digest === null || digest === UNKNOWN_DIGEST ? null : digest,
    chunker: Number.isFinite(chunker) ? chunker : null,
    legacy: parts.length === 0,
  };
}

/**
 * How the stored chunk index relates to the active embedding config:
 *
 *  - `none`: same embedding space and chunker (at most a digest that was or
 *    became unknown) — nothing to rebuild.
 *  - `chunker`: same embedding space, different chunker — the stored vectors
 *    still answer queries correctly, so they keep serving while the backfill
 *    re-chunks each doc.
 *  - `space`: the vectors belong to another embedding space (provider, model,
 *    width or known model digest changed, chunks of unknown origin, or the
 *    canary drifted) — they must not be scored against a query embedded now.
 */
type IndexChange =
  | { kind: "none" }
  | { kind: "chunker"; reason: string }
  | { kind: "space"; reason: string };

/**
 * The outcome of KnowledgeSync.reindexOnProviderChange:
 *
 *  - `inactive`: no usable provider; nothing was checked.
 *  - `current`: the index already matches the active config.
 *  - `rechunk`: the chunker changed; the fingerprint is recorded and the
 *    existing vectors keep serving until the backfill re-chunks them.
 *  - `respace`: the embedding space changed; every chunk was cleared and the
 *    fingerprint recorded, so the backfill re-embeds the corpus.
 *  - `pending`: a change was found but the provider could not embed; the index
 *    and the recorded fingerprint are untouched and the check must be retried.
 */
export type IndexCheckOutcome = "inactive" | "current" | "rechunk" | "respace" | "pending";

/** What one backfill pass did. */
export interface BackfillResult {
  /** Docs examined. */
  docs: number;
  /** Docs that had at least one chunk (re-)embedded. */
  embedded: number;
  /** Docs where every embedding attempted failed. */
  failed: number;
  /** The pass stopped early: the provider could not embed, or indexing was stopped. */
  aborted: boolean;
}

type DocBackfill = "current" | "embedded" | "failed" | "skipped";

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fingerprint of what a doc file says — the fields the index copies from it. */
function fileContentHash(doc: KnowledgeDoc): string {
  return Bun.hash(
    JSON.stringify([
      doc.title,
      doc.body,
      doc.tags ?? [],
      doc.confidence ?? null,
      doc.lastVerifiedAt ?? null,
      doc.halfLifeDays ?? null,
      doc.generatedFromSha ?? null,
      doc.generatedAt ?? null,
      doc.sourceSessionId ?? null,
    ])
  ).toString(16);
}

/** The embedded share of docs at which the relevance cosine band is measured. */
const CALIBRATION_MIN_EMBEDDED_SHARE = 0.95;

export class KnowledgeSync {
  private store: KnowledgeStore;
  private loader: KnowledgeLoader;
  /** project/slug → fileContentHash of the file as this process last synced it. */
  private syncedContent = new Map<string, string>();

  constructor(
    private db: Database,
    knowledgeDir: string,
    private embeddingProvider: EmbeddingProvider | null,
    private embeddingConfig: EmbeddingConfig = {},
    // Corpus ids that are NOT registered projects (no row in the projects table)
    // yet still hold indexable docs on disk — e.g. the "standup" home for
    // Standup's own seeded docs. Folding them into knownProjectIds() is what
    // keeps them inside the rebuildable-index contract: syncAll re-indexes them,
    // a provider switch re-embeds them, and startWatching watches their dir.
    // Without this they would be indexed only on the one boot that seeds them and
    // silently drop out of search on any DB rebuild or embedding-provider change.
    private extraProjectIds: readonly string[] = []
  ) {
    this.store = new KnowledgeStore(db);
    this.loader = new KnowledgeLoader(knowledgeDir);
  }

  // False while embedding writes must wait for the embedding-space check:
  // from deferEmbeddingUntilChecked() until reindexOnProviderChange concludes,
  // and while an embedding-space change waits for a provider that can embed.
  // A doc synced meanwhile drops its stale chunks and is embedded by the
  // backfill, so no vector of an unverified space is ever written.
  private embeddingReady = true;

  // True while the last embedding-space check found nothing changed but its
  // canary could not embed, so drift the fingerprint cannot see (a same-name
  // model re-pulled to new weights) is still unchecked. The check runs again
  // before the next backfill and as soon as an embedding succeeds.
  private canaryInconclusive = false;

  // Docs whose every embedding failed while the provider could embed: tried
  // again on each pass, after every other doc, so a doc the provider always
  // rejects never holds up the rest of the corpus.
  private backfillFailedIds = new Set<string>();

  // Why the host is too short on headroom for batch embedding right now, or
  // null when it is fine (see setHostPressure). Unset never yields.
  private hostPressure: (() => string | null) | null = null;

  // Background indexer state, set once startBackgroundIndexing runs.
  private background: {
    stopped: boolean;
    checked: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    active: Promise<void> | null;
    rerun: boolean;
    retryMs: number;
  } | null = null;

  // Change tracking behind syncDirty. `watching` is set while the directory
  // watcher runs and reports reliably; `dirty` holds the projects it reported
  // changed since their last sync; `fullSyncDue` asks the next syncDirty for a
  // full sync (set when the watcher starts, since anything that changed before
  // it attached went unreported, and when an event names no project).
  // `syncedProjects` is the known-project set the last full sync covered, so a
  // project registered since is synced even though no file event named it.
  private watch: {
    watching: boolean;
    dirty: Set<string>;
    fullSyncDue: boolean;
    lastFullSyncAt: number;
    syncedProjects: Set<string>;
    flushTimer: ReturnType<typeof setTimeout> | null;
    onDocsChanged?: (projectId: string) => void;
  } = {
    watching: false,
    dirty: new Set(),
    fullSyncDue: true,
    lastFullSyncAt: 0,
    syncedProjects: new Set(),
    flushTimer: null,
  };
  // Serializes syncDirty calls, so a caller never returns while an earlier
  // call is still syncing a project it drained from `dirty`.
  private syncQueue: Promise<void> = Promise.resolve();

  private knownProjectIds(): string[] {
    const ids = new Set(getProjects(this.db).map((p) => p.id));
    ids.add(SCRATCH_PROJECT_ID);
    for (const id of this.extraProjectIds) ids.add(id);
    return [...ids];
  }

  /**
   * Re-reads a project's knowledge directory from disk and reconciles it
   * against the store. Cheap to call on every search — unchanged files are
   * skipped after a stat() comparison (no re-read, no re-embed), and this
   * is what lets new/edited/deleted knowledge docs show up without a
   * collector restart, unlike the fs.watch-based path (which can't attach
   * to a directory that doesn't exist yet, e.g. a project's first doc).
   */
  async syncProject(projectId: string): Promise<void> {
    const docs = await this.loader.loadProject(projectId);
    const seenSlugs = new Set<string>();

    for (const doc of docs) {
      seenSlugs.add(doc.slug);

      const existing = this.store.getDoc(projectId, doc.slug);
      const contentKey = `${projectId}/${doc.slug}`;
      const content = fileContentHash(doc);
      // A rewrite within the same millisecond as the last sync leaves the mtime
      // where it was; the content this process last indexed from the file tells
      // it apart. (Only file content is compared, so a DB-only edit made since
      // is not reverted by an unchanged file.)
      const rewrittenInPlace =
        this.syncedContent.has(contentKey) && this.syncedContent.get(contentKey) !== content;
      this.syncedContent.set(contentKey, content);
      if (existing && existing.updatedAt.getTime() >= doc.updatedAt.getTime() && !rewrittenInPlace) {
        // File unchanged since last sync — nothing to re-write. But the
        // file-authoritative columns (origin_class, source_kind, scope,
        // owner_user) can still have drifted from the stored row: a row first
        // written under an older default keeps that default forever here
        // because the body-level skip never rewrites it — e.g. a hand-authored
        // doc stored `untrusted` before the loader defaulted an unasserted
        // origin_class to `owner` stays `untrusted` and wrongly gated out of
        // auto-injection, and a reserved GLOBAL-corpus doc stamped
        // scope='project' before the loader inferred 'global' for it silently
        // falls out of the strict scope gate. Reconcile just those columns from
        // the file (see KnowledgeStore.reconcileFileColumns for why this is safe
        // here and does not touch cron-owned verdict/confidence).
        if (
          existing.originClass !== doc.originClass ||
          existing.sourceKind !== doc.sourceKind ||
          existing.scope !== doc.scope ||
          (existing.ownerUser ?? undefined) !== (doc.ownerUser ?? undefined)
        ) {
          this.store.reconcileFileColumns(
            projectId,
            doc.slug,
            doc.originClass ?? "untrusted",
            doc.sourceKind ?? DEFAULT_SOURCE_KIND,
            doc.scope ?? "project",
            doc.ownerUser
          );
        }
        // Chunks an unchanged doc is missing or holds at another chunker
        // version (a provider enabled later, an embedding that failed, a
        // chunker change) are left to the background backfill: a sync runs in
        // request handlers, which embed only the docs that changed.
        continue;
      }

      const storedId = this.store.upsertDoc(doc);

      // Best-effort embedding — skip silently if no provider or the call fails.
      if (!this.embeddingProvider) continue;

      await this.embedDoc(storedId, doc.title, doc.body);
    }

    // Remove docs whose file no longer exists, so deletions show up too.
    for (const stored of this.store.getDocsByProject(projectId)) {
      if (!seenSlugs.has(stored.slug)) {
        this.store.deleteDoc(projectId, stored.slug);
        this.syncedContent.delete(`${projectId}/${stored.slug}`);
      }
    }

    // Closed versions under .history/, indexed apart from the corpus.
    this.store.syncHistory(projectId, await this.loader.loadHistory(projectId));
  }

  /**
   * Chunks a changed doc with the production chunker and makes its stored
   * chunk set exactly that chunking: each chunk is embedded and upserted, a
   * chunk whose embedding call came back empty is dropped rather than left on
   * the vector of whatever text it held before, and chunks past the new count
   * are removed. A dropped chunk leaves the doc searchable by FTS (and its other
   * chunks) and schedules a background backfill to fill it. While embedding
   * waits on the embedding-space check, the doc's chunks — all of an older body
   * — are dropped and the backfill embeds it once the check concludes. Nothing
   * is written when the doc changed again while its embeddings were in flight:
   * the sync that changed it owns its chunks. Callers guarantee a provider is
   * set before calling.
   */
  private async embedDoc(knowledgeId: string, title: string, body: string): Promise<void> {
    if (!this.embeddingReady) {
      this.store.truncateChunks(knowledgeId, 0);
      return;
    }
    const chunks = chunkMarkdown(title, body);
    const embeddings = await embedChunks(
      chunks.map((chunk) => chunk.embedText),
      this.embeddingProvider!,
      this.embeddingConfig
    );
    if (!this.docStill(knowledgeId, title, body)) return;
    if (!this.embeddingReady) {
      this.store.truncateChunks(knowledgeId, 0);
      return;
    }
    const failed: number[] = [];
    chunks.forEach((chunk, index) => {
      const embedding = embeddings[index];
      if (!embedding) {
        failed.push(index);
        return;
      }
      this.store.upsertChunk({
        id: randomUUID(),
        knowledgeId,
        chunkIndex: index,
        text: chunk.text,
        embedding,
      });
    });
    this.store.deleteChunks(knowledgeId, failed);
    this.store.truncateChunks(knowledgeId, chunks.length);
    if (failed.length < chunks.length) this.noteEmbeddingSucceeded();
    if (failed.length > 0) this.scheduleBackfill();
  }

  // Whether the stored doc still carries this title and body.
  private docStill(knowledgeId: string, title: string, body: string): boolean {
    const doc = this.store.getDocById(knowledgeId);
    return doc !== null && doc.title === title && doc.body === body;
  }

  /**
   * Brings one stored doc's chunk set in line with the production chunker:
   * every chunk index that is missing, holds other text, or was written by
   * another chunker version is (re-)embedded, and a tail past the chunk count
   * is removed once every embedding succeeded. A failed embedding leaves the
   * stored chunk at that index in place — it was embedded from this same body
   * in the active space, so it keeps answering until a later pass replaces it.
   */
  private async backfillDoc(knowledgeId: string, title: string, body: string): Promise<DocBackfill> {
    const chunks = chunkMarkdown(title, body);
    const stored = new Map(this.store.chunkStates(knowledgeId).map((c) => [c.chunkIndex, c]));
    const todo = chunks
      .map((chunk, index) => ({ chunk, index }))
      .filter(({ chunk, index }) => {
        const have = stored.get(index);
        return !have || have.text !== chunk.text || have.chunkerVersion !== CHUNKER_VERSION;
      });
    const hasTail = [...stored.keys()].some((index) => index >= chunks.length);
    if (todo.length === 0) {
      if (hasTail) this.store.truncateChunks(knowledgeId, chunks.length);
      return "current";
    }

    const embeddings = await embedChunks(
      todo.map(({ chunk }) => chunk.embedText),
      this.embeddingProvider!,
      this.embeddingConfig
    );
    if (!this.embeddingReady || !this.docStill(knowledgeId, title, body)) return "skipped";
    let failed = 0;
    todo.forEach(({ chunk, index }, i) => {
      const embedding = embeddings[i];
      if (!embedding) {
        failed++;
        return;
      }
      this.store.upsertChunk({
        id: randomUUID(),
        knowledgeId,
        chunkIndex: index,
        text: chunk.text,
        embedding,
      });
    });
    if (failed === 0) this.store.truncateChunks(knowledgeId, chunks.length);
    return failed === todo.length ? "failed" : "embedded";
  }

  /**
   * One pass over every stored doc, embedding whatever its chunk set lacks
   * (see backfillDoc): docs synced while no provider was configured or while
   * embedding was deferred, chunks whose embedding failed, chunks of an older
   * chunker, and the whole corpus after an embedding-space reset. When a doc
   * fails entirely, one probe embedding tells a down provider (the pass stops)
   * from a doc the provider rejects (remembered, and tried after every other
   * doc on later passes). The pass also stops when `shouldStop` returns true.
   * A no-op without a usable provider or while embedding waits on the
   * embedding-space check. While the host is short on headroom (see
   * setHostPressure) the pass yields before its next doc and is retried with
   * the background indexer's backoff; docs already done stay done.
   */
  async backfillEmbeddings(options: { shouldStop?: () => boolean } = {}): Promise<BackfillResult> {
    const result: BackfillResult = { docs: 0, embedded: 0, failed: 0, aborted: false };
    if (!this.embeddingProvider || !resolveEmbeddingProvider(this.embeddingProvider)) return result;
    if (!this.embeddingReady) return { ...result, aborted: true };
    const docs = this.store.getAllDocs();
    const known = new Set(docs.map((doc) => doc.id));
    for (const id of this.backfillFailedIds) if (!known.has(id)) this.backfillFailedIds.delete(id);
    const ordered = [
      ...docs.filter((doc) => !this.backfillFailedIds.has(doc.id)),
      ...docs.filter((doc) => this.backfillFailedIds.has(doc.id)),
    ];
    for (const doc of ordered) {
      if (options.shouldStop?.() || !this.embeddingReady) return { ...result, aborted: true };
      const pressure = this.hostPressure?.();
      if (pressure) {
        console.log(`[knowledge] embedding backfill yielded after ${result.docs} doc(s): ${pressure}`);
        return { ...result, aborted: true };
      }
      result.docs++;
      const outcome = await this.backfillDoc(doc.id, doc.title, doc.body);
      if (outcome === "failed") {
        result.failed++;
        if (!(await this.providerCanEmbed())) {
          console.warn(
            `[knowledge] embedding backfill paused: ${this.embeddingProvider} cannot embed right now`
          );
          return { ...result, aborted: true };
        }
        this.backfillFailedIds.add(doc.id);
      } else {
        if (outcome !== "skipped") this.backfillFailedIds.delete(doc.id);
        if (outcome === "embedded") {
          result.embedded++;
          // Stop writing vectors until the re-run check confirms the space.
          if (this.noteEmbeddingSucceeded()) return { ...result, aborted: true };
        }
      }
      if (result.docs % BACKFILL_YIELD_EVERY === 0) await yieldToEventLoop();
    }
    return result;
  }

  // Whether one probe embedding succeeds under the active provider.
  private async providerCanEmbed(): Promise<boolean> {
    const [probe] = await embedChunks([EMBEDDING_PROBE_TEXT], this.embeddingProvider!, this.embeddingConfig);
    return !!probe;
  }

  // An embedding succeeded: if the last embedding-space check could not run
  // its canary, queue the check to run again now the provider answers, and
  // report that it did.
  private noteEmbeddingSucceeded(): boolean {
    if (!this.canaryInconclusive) return false;
    const bg = this.background;
    if (!bg || bg.stopped) return false;
    bg.checked = false;
    if (bg.active) {
      bg.rerun = true;
      return true;
    }
    if (bg.timer) clearTimeout(bg.timer);
    bg.timer = null;
    void this.runIndexPass();
    return true;
  }

  /**
   * Reconciles `.drafts/` against knowledge_drafts, the same shape as
   * syncProject but deliberately does not chunk or embed. That's not a TODO —
   * a draft is listed for review, never retrieved, so spending an embedding
   * call on text that might be deleted or rewritten before anyone reads it
   * would be pure waste, and skipping it is what keeps bootstrap cheap to
   * re-run.
   */
  async syncDrafts(projectId: string): Promise<void> {
    const drafts = await this.loader.loadDrafts(projectId);
    const seenSlugs = new Set<string>();

    for (const draft of drafts) {
      seenSlugs.add(draft.slug);
      this.store.upsertDraft(draft);
    }

    for (const stored of this.store.getDraftsByProject(projectId)) {
      if (!seenSlugs.has(stored.slug)) {
        this.store.deleteDraft(projectId, stored.slug);
      }
    }
  }

  /** Accepted docs for a project — the population the re-verification cron
   *  (roadmap r5) ranks and re-checks. Delegates to the store, which the lazy
   *  resyncs keep current with disk. */
  getDocs(projectId: string): KnowledgeDoc[] {
    return this.store.getDocsByProject(projectId);
  }

  /** Records a re-verification pass over an ACCEPTED doc (roadmap r5). The
   *  sibling of recordDraftVerdict: the verdict lives in the DB (upsertDoc omits
   *  the column, so a resync preserves it), while confidence + last_verified_at
   *  are written to the doc's frontmatter separately so decay survives a DB
   *  rebuild. `repoPath` is the checkout a fact-check verdict was produced
   *  against (KnowledgeStore.setDocVerdict). */
  recordDocVerdict(
    projectId: string,
    slug: string,
    verdict: string,
    disputes: unknown[],
    repoPath?: string | null
  ): void {
    this.store.setDocVerdict(projectId, slug, verdict, disputes, repoPath);
  }

  /** The checkout the doc's current verdict was produced against, if recorded. */
  getDocVerdictRepo(projectId: string, slug: string): string | null {
    return this.store.getDocVerdictRepo(projectId, slug);
  }

  /** Clears any re-verification verdict on an accepted doc (roadmap r5 review).
   *  A human accept/edit asserts the current body, so a verdict the cron recorded
   *  against the previous body must not keep marking the new text disputed. Must
   *  run after the write's resync — upsertDoc preserves the column, so only an
   *  explicit clear lifts a stale verdict. */
  clearDocVerdict(projectId: string, slug: string): void {
    this.store.clearDocVerdict(projectId, slug);
  }

  /** Records that `writer` wrote the doc as it now stands (KnowledgeStore.stampWriter). */
  stampWriter(projectId: string, slug: string, writer: string): boolean {
    return this.store.stampWriter(projectId, slug, writer);
  }

  /** Records an adversarial verification pass over a draft (phase-7 Step 4.5). */
  recordDraftVerdict(
    projectId: string,
    slug: string,
    verdict: string,
    disputes: unknown[]
  ): void {
    this.store.setDraftVerdict(projectId, slug, verdict, disputes);
  }

  /** Pending drafts for the review UI. Delegates straight to the store —
   * syncDrafts is what keeps this current with `.drafts/` on disk, not this
   * read itself. */
  getDrafts(projectId: string): KnowledgeDraft[] {
    return this.store.getDraftsByProject(projectId);
  }

  getDraft(projectId: string, slug: string): KnowledgeDraft | null {
    return this.store.getDraft(projectId, slug);
  }

  /**
   * Edited text is a claim that hasn't been checked — a verdict recorded
   * against the draft's *previous* body would otherwise sit on the card
   * looking current after the human changed what it says.
   */
  resetDraftVerdict(projectId: string, slug: string): void {
    this.store.setDraftVerdict(projectId, slug, "unverified", []);
  }

  /**
   * The fingerprint of the embedding space the active config produces, or null
   * when no provider is configured:
   *
   *   `<provider>:<model>:<width>|digest=<model digest>|chunker=<version>`
   *
   * Model resolves the same way embedChunks does — an explicit config.model,
   * else the plugin's default. Width is an explicit config.dimensions (the one
   * axis that changes the output width independently of the model id, e.g.
   * Titan v2's 256/512/1024), else the plugin's declared width. The digest
   * identifies the model WEIGHTS, which a mutable model name (an Ollama tag
   * re-pulled to new weights) does not; `unknown` when the lookup failed. The
   * chunker version moves whenever the embedded text for an unchanged body
   * would. The fingerprint therefore moves whenever the stored vectors stop
   * being reproducible by the query path.
   */
  private providerFingerprint(digest: string | null): string | null {
    if (!this.embeddingProvider) return null;
    const model = this.embeddingConfig.model ?? defaultModelFor(this.embeddingProvider);
    const width =
      this.embeddingConfig.dimensions ??
      resolveEmbeddingProvider(this.embeddingProvider)?.dimensions ??
      "native";
    return `${this.embeddingProvider}:${model}:${width}|digest=${digest ?? UNKNOWN_DIGEST}|chunker=${CHUNKER_VERSION}`;
  }

  // The fingerprint the active config would have been recorded under before
  // the width, digest and chunker parts existed: `<provider>:<model>`, plus
  // `:<dims>` only for an explicit config.dimensions.
  private legacySpace(): string {
    const model = this.embeddingConfig.model ?? defaultModelFor(this.embeddingProvider!);
    const base = `${this.embeddingProvider}:${model}`;
    return this.embeddingConfig.dimensions !== undefined
      ? `${base}:${this.embeddingConfig.dimensions}`
      : base;
  }

  /**
   * Re-embeds a few stored chunks with the active provider and returns the mean
   * cosine against their stored vectors, or null when nothing could be compared
   * (no chunks, the provider failed, or no sampled chunk is reproducible from
   * its doc's current body at the current chunker version). The text
   * re-embedded is re-derived through the production chunker, since the stored
   * chunk text omits the heading-path prefix the vector was computed over.
   */
  private async embeddingCanary(): Promise<number | null> {
    const sims: number[] = [];
    for (const sample of this.store.sampleChunks(EMBEDDING_CANARY_SAMPLES)) {
      if (sample.chunkerVersion !== CHUNKER_VERSION) continue;
      const chunk = chunkMarkdown(sample.title, sample.body)[sample.chunkIndex];
      if (!chunk || chunk.text !== sample.text) continue;
      const [fresh] = await embedChunks(
        [chunk.embedText],
        this.embeddingProvider!,
        this.embeddingConfig
      );
      if (!fresh) continue;
      sims.push(cosineSimilarity(fresh, sample.embedding));
    }
    if (sims.length === 0) return null;
    return sims.reduce((a, b) => a + b, 0) / sims.length;
  }

  // Classifies the recorded fingerprint against the active one (see IndexChange).
  private classifyChange(stored: string | null, digest: string | null, hasChunks: boolean): IndexChange {
    if (stored === null) {
      return hasChunks
        ? { kind: "space", reason: "no fingerprint on record for the stored chunks" }
        : { kind: "none" };
    }
    const was = parseFingerprint(stored);
    if (was.legacy) {
      return was.space === this.legacySpace()
        ? { kind: "chunker", reason: `chunks predate chunker versioning (recorded ${stored})` }
        : { kind: "space", reason: `embedding config changed from ${stored}` };
    }
    const now = parseFingerprint(this.providerFingerprint(digest)!);
    if (was.space !== now.space) {
      return { kind: "space", reason: `embedding config changed from ${stored}` };
    }
    if (was.digest !== null && now.digest !== null && was.digest !== now.digest) {
      return { kind: "space", reason: `model digest changed from ${was.digest} to ${now.digest}` };
    }
    if (was.chunker !== now.chunker) {
      return {
        kind: "chunker",
        reason: `chunker version changed from ${was.chunker ?? "unversioned"} to ${now.chunker}`,
      };
    }
    return { kind: "none" };
  }

  /**
   * Checks the stored chunk index against the active embedding config and
   * prepares it for the backfill. The comparison (see IndexChange):
   *
   *  - provider, model or width differ from the recorded fingerprint, both the
   *    recorded and the active fingerprint carry a model digest and they differ,
   *    or chunks exist with no fingerprint on record → an embedding-space change;
   *  - only the chunker version differs (a fingerprint recorded before chunker
   *    versioning included, when its provider and model match) → a chunker change;
   *  - a digest that is unknown on either side is no evidence of change: the
   *    rest of the fingerprint plus the canary decide, and a recorded digest is
   *    never overwritten with an unknown one;
   *  - with nothing else changed, the canary — a fresh embedding of up to
   *    EMBEDDING_CANARY_SAMPLES stored chunks — scoring a mean cosine below
   *    EMBEDDING_CANARY_MIN_COSINE is an embedding-space change (drift the
   *    fingerprint could not see). A canary that can't embed is inconclusive.
   *
   * A change is acted on only after one probe embedding succeeds. If the
   * provider cannot embed, nothing is cleared and the new fingerprint is not
   * recorded, so the existing index survives intact (and a reverted config
   * finds it current); for an embedding-space change, vector search is
   * suspended and embedding writes wait, so no query vector is scored against
   * vectors of the old space and no new-space vector joins them. The caller
   * retries on `pending`.
   *
   * With a working provider, an embedding-space change clears every chunk
   * (search runs on FTS until the backfill re-embeds each doc), while a chunker
   * change keeps every vector — they answer queries in the same space — and
   * leaves the per-chunk chunker version to tell the backfill which docs to
   * re-chunk. Either way the fingerprint is recorded at once; a rebuild cut
   * short is resumed by the next backfill, which finds the same gaps.
   *
   * A no-op when no provider is set (the query path never embeds, so stale
   * chunks are inert) or the provider id is not registered.
   */
  async reindexOnProviderChange(): Promise<IndexCheckOutcome> {
    if (!this.embeddingProvider) {
      this.embeddingReady = true;
      return "inactive";
    }

    // An unregistered provider id — a typo or case-mismatch in EMBEDDING_PROVIDER
    // ("Ollama", "bedrock-v2", "openai ") — is non-null but cannot embed anything:
    // generateEmbedding would only log and return null. Its fingerprint would
    // still differ from the stored one, so proceeding would clear a healthy index
    // and leave it empty with nothing able to refill it, silently degrading
    // semantic search to FTS-only. Bail without touching the chunks or the
    // recorded fingerprint, so the existing embeddings (and FTS) survive and a
    // corrected env var resolves back to an unchanged fingerprint — no re-embed.
    if (!resolveEmbeddingProvider(this.embeddingProvider)) {
      console.error(
        `[knowledge] EMBEDDING_PROVIDER "${this.embeddingProvider}" is not a registered provider — leaving the chunk index untouched (semantic search stays on the previous embeddings; fix the value to re-embed)`
      );
      this.embeddingReady = true;
      return "inactive";
    }

    const digest = await resolveModelDigest(this.embeddingProvider, this.embeddingConfig);
    if (digest === null) {
      console.warn(
        `[knowledge] could not determine the model digest for ${this.embeddingProvider} — comparing the embedding fingerprint without it`
      );
    }
    const stored = getSetting(this.db, EMBEDDING_FINGERPRINT_KEY);
    const hasChunks = this.store.storedChunkDimensions() !== null;
    // The digest to record: the active one, else a recorded one for the same
    // space, so an unreachable digest endpoint never erases a known digest.
    const recordedDigest = stored !== null ? parseFingerprint(stored).digest : null;

    let change = this.classifyChange(stored, digest, hasChunks);
    this.canaryInconclusive = false;
    if (change.kind === "none" && hasChunks) {
      const canary = await this.embeddingCanary();
      this.canaryInconclusive = canary === null;
      if (canary !== null && canary < EMBEDDING_CANARY_MIN_COSINE) {
        change = {
          kind: "space",
          reason: `embedding canary drifted: mean cosine ${canary.toFixed(4)} < ${EMBEDDING_CANARY_MIN_COSINE} against stored vectors`,
        };
      }
    }

    if (change.kind === "none") {
      setSetting(this.db, EMBEDDING_FINGERPRINT_KEY, this.providerFingerprint(digest ?? recordedDigest)!);
      this.store.setVectorSearchSuspended(false);
      this.embeddingReady = true;
      return "current";
    }

    const [probe] = await embedChunks(
      [EMBEDDING_PROBE_TEXT],
      this.embeddingProvider,
      this.embeddingConfig
    );
    if (!probe) {
      console.error(
        `[knowledge] EMBEDDING INDEX REBUILD PENDING — ${change.reason}, but ${this.embeddingProvider} cannot embed right now; ` +
          `the chunk index and its recorded fingerprint are left untouched` +
          (change.kind === "space"
            ? ` and vector search is suspended (text search only) until the provider can embed`
            : ``) +
          `; retrying in the background`
      );
      if (change.kind === "space") {
        this.store.setVectorSearchSuspended(true);
        this.embeddingReady = false;
      } else {
        this.embeddingReady = true;
      }
      return "pending";
    }

    if (change.kind === "space") {
      this.store.clearAllChunks();
      console.warn(
        `[knowledge] EMBEDDING INDEX RESET — ${change.reason}; cleared every chunk to re-embed the whole corpus in the background under ${this.providerFingerprint(digest)} (text search only until each doc is re-embedded)`
      );
      setSetting(this.db, EMBEDDING_FINGERPRINT_KEY, this.providerFingerprint(digest)!);
    } else {
      console.warn(
        `[knowledge] ${change.reason}; re-chunking the corpus in the background (the existing vectors keep serving meanwhile)`
      );
      setSetting(this.db, EMBEDDING_FINGERPRINT_KEY, this.providerFingerprint(digest ?? recordedDigest)!);
    }
    this.store.setVectorSearchSuspended(false);
    this.embeddingReady = true;
    return change.kind === "space" ? "respace" : "rechunk";
  }

  /**
   * Holds embedding writes until the background indexer has checked the
   * embedding space (see startBackgroundIndexing). Call before the boot sync, so
   * the boot sync and any request served before the check write no vectors: a
   * changed doc drops its stale chunks and the backfill embeds it.
   */
  deferEmbeddingUntilChecked(): void {
    if (!this.embeddingProvider || !resolveEmbeddingProvider(this.embeddingProvider)) return;
    this.embeddingReady = false;
    // A provider, model or width change is visible without the provider: stop
    // scoring queries against the old space now rather than once the check runs.
    const stored = getSetting(this.db, EMBEDDING_FINGERPRINT_KEY);
    const hasChunks = this.store.storedChunkDimensions() !== null;
    if (this.classifyChange(stored, null, hasChunks).kind === "space") {
      this.store.setVectorSearchSuspended(true);
    }
  }

  /**
   * Starts the background indexer: on the next turn of the event loop (after
   * the server is listening) it runs reindexOnProviderChange, then one
   * backfillEmbeddings pass. A pending check, a check whose canary could not
   * embed, a pass cut short by a failing provider, and a pass that left a doc
   * failed are retried with a delay doubling from EMBEDDING_RETRY_INITIAL_MS up
   * to EMBEDDING_RETRY_MAX_MS; request-path syncs whose embeddings failed
   * schedule another pass, and one whose embedding succeeded re-runs a check
   * whose canary could not embed. Returns a promise for the first run, for callers
   * (tests) that need to wait on it.
   */
  startBackgroundIndexing(): Promise<void> {
    if (!this.background) {
      this.background = {
        stopped: false,
        checked: false,
        timer: null,
        active: null,
        rerun: false,
        retryMs: EMBEDDING_RETRY_INITIAL_MS,
      };
    }
    if (!this.embeddingProvider) return Promise.resolve();
    this.deferEmbeddingUntilChecked();
    return new Promise((resolve) => {
      setTimeout(() => {
        void this.runIndexPass().then(resolve);
      }, 0);
    });
  }

  /**
   * Makes batch embedding yield while `pressure` names a reason (the host is
   * short on memory or CPU). Request-path syncs of a single doc are not held.
   */
  setHostPressure(pressure: () => string | null): void {
    this.hostPressure = pressure;
  }

  /** Stops the background indexer: cancels a scheduled pass and ends a running one at its next doc. */
  stopBackgroundIndexing(): void {
    if (!this.background) return;
    this.background.stopped = true;
    if (this.background.timer) clearTimeout(this.background.timer);
    this.background.timer = null;
  }

  // Queues a backfill pass after `delayMs` and reports whether it did. A no-op
  // unless the background indexer runs, and while a pass is already queued.
  private scheduleBackfill(delayMs = EMBEDDING_BACKFILL_DELAY_MS): boolean {
    const bg = this.background;
    if (!bg || bg.stopped || bg.timer) return false;
    bg.timer = setTimeout(() => {
      bg.timer = null;
      void this.runIndexPass();
    }, delayMs);
    bg.timer.unref?.();
    return true;
  }

  // Queues a retry at the current backoff delay; the delay doubles only when
  // this call queued the pass, not when one was already pending.
  private scheduleRetry(): void {
    const bg = this.background;
    if (!bg) return;
    if (this.scheduleBackfill(bg.retryMs)) bg.retryMs = Math.min(bg.retryMs * 2, EMBEDDING_RETRY_MAX_MS);
  }

  // One background run: the embedding-space check until it has concluded once,
  // then a backfill pass. Runs never overlap; a run requested meanwhile follows
  // the current one.
  private runIndexPass(): Promise<void> {
    const bg = this.background;
    if (!bg || bg.stopped) return Promise.resolve();
    if (bg.active) {
      bg.rerun = true;
      return bg.active;
    }
    bg.active = (async () => {
      try {
        if (!bg.checked) {
          const outcome = await this.reindexOnProviderChange();
          if (outcome === "pending") {
            this.scheduleRetry();
            return;
          }
          bg.checked = !this.canaryInconclusive;
        }
        const result = await this.backfillEmbeddings({ shouldStop: () => bg.stopped });
        if (result.embedded > 0) {
          console.log(
            `[knowledge] embedding backfill: ${result.embedded} doc(s) embedded, ${result.failed} failed, of ${result.docs} checked`
          );
        }
        // A pass cut short, a doc that still failed, or a check whose canary
        // could not embed is retried with backoff; a clean pass resets it.
        if (bg.stopped) return;
        if (result.aborted || result.failed > 0 || !bg.checked) this.scheduleRetry();
        else bg.retryMs = EMBEDDING_RETRY_INITIAL_MS;
        // Calibrate once nearly the whole corpus is embedded: a doc that fails
        // every pass must not keep the band unmeasured forever.
        if (!result.aborted && this.embeddedShare() >= CALIBRATION_MIN_EMBEDDED_SHARE) {
          await this.ensureRelevanceCalibration();
        }
      } catch (err) {
        console.error("[knowledge] background indexing failed:", err);
        this.scheduleRetry();
      } finally {
        bg.active = null;
        if (bg.rerun && !bg.stopped) {
          bg.rerun = false;
          void this.runIndexPass();
        }
      }
    })();
    return bg.active;
  }

  /**
   * Measures the cosine band relevance is read through (calibration.ts) once
   * the corpus is embedded, when it is missing or was measured under another
   * embedding fingerprint or a much smaller corpus. Best-effort: a provider that
   * cannot embed leaves the defaults in use and the next clean pass retries.
   */
  /** The share of docs with at least one embedded chunk. */
  private embeddedShare(): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS docs,
                (SELECT COUNT(DISTINCT knowledge_id) FROM knowledge_chunks) AS embedded
         FROM knowledge`
      )
      .get() as { docs: number; embedded: number } | null;
    return row && row.docs > 0 ? row.embedded / row.docs : 0;
  }

  async ensureRelevanceCalibration(): Promise<void> {
    if (!this.embeddingProvider || !resolveEmbeddingProvider(this.embeddingProvider)) return;
    try {
      const status = await ensureCosineCalibration(this.db, this.embeddingProvider, this.embeddingConfig);
      if (status.status === "calibrated") {
        console.log(
          `[knowledge] relevance cosine band ${status.low.toFixed(3)}–${status.high.toFixed(3)} for ${status.fingerprint}`
        );
      }
    } catch (err) {
      console.error("[knowledge] relevance calibration failed:", err);
    }
  }

  async syncAll(): Promise<void> {
    const projectIds = this.knownProjectIds();
    // Cleared before reading, so a change reported while the sync runs stays
    // dirty for the next syncDirty.
    this.watch.fullSyncDue = false;
    this.watch.lastFullSyncAt = Date.now();
    this.watch.dirty.clear();
    this.watch.syncedProjects = new Set(projectIds);
    for (const projectId of projectIds) {
      await this.syncProject(projectId);
    }
  }

  /**
   * Brings the store in line with disk before a read, re-reading only what can
   * have changed. While the watcher runs, that is the projects it reported
   * changed since their last sync, plus any project registered since the last
   * full sync; everything else is skipped without a file read. A full sync
   * runs instead when the watcher just started, an event named no project, or
   * KNOWLEDGE_FULL_SYNC_INTERVAL_MS passed since the last one. Without a
   * working watcher every call re-reads as syncAll (or, given `projectIds`,
   * as syncProject over just those) does. `projectIds` limits the sync to
   * those projects; dirty projects outside it stay dirty. Calls run one at a
   * time, so a change reported before a call is synced before it returns.
   */
  syncDirty(projectIds?: readonly string[]): Promise<void> {
    const run = this.syncQueue.then(() => this.drainDirty(projectIds));
    this.syncQueue = run.catch(() => {});
    return run;
  }

  private async drainDirty(projectIds?: readonly string[]): Promise<void> {
    const w = this.watch;
    // Every change made before this call must be reported before `dirty` is
    // read; when the watcher cannot show that in time, nothing is skipped.
    const reported = w.watching && (await this.loader.flushWatchEvents(KNOWLEDGE_WATCH_FENCE_TIMEOUT_MS));
    if (!w.watching || !reported) {
      if (projectIds) for (const id of projectIds) await this.syncProject(id);
      else await this.syncAll();
      return;
    }
    if (w.fullSyncDue || Date.now() - w.lastFullSyncAt >= KNOWLEDGE_FULL_SYNC_INTERVAL_MS) {
      await this.syncAll();
      return;
    }
    const known = this.knownProjectIds();
    const inScope = projectIds ? new Set(projectIds) : null;
    const todo = known.filter(
      (id) => (inScope === null || inScope.has(id)) && (w.dirty.has(id) || !w.syncedProjects.has(id))
    );
    for (const id of todo) {
      w.dirty.delete(id);
      w.syncedProjects.add(id);
    }
    for (const [i, id] of todo.entries()) {
      try {
        await this.syncProject(id);
      } catch (err) {
        // What this call drained but did not sync stays due.
        for (const left of todo.slice(i)) w.dirty.add(left);
        throw err;
      }
    }
  }

  /** Records a watcher report, scheduling the coalesced background flush. */
  private markDirty(projectId: string | null): void {
    const w = this.watch;
    if (projectId === null) w.fullSyncDue = true;
    else w.dirty.add(projectId);
    if (w.flushTimer) return;
    w.flushTimer = setTimeout(() => {
      w.flushTimer = null;
      void this.flushDirty();
    }, KNOWLEDGE_WATCH_COALESCE_MS);
  }

  // Syncs whatever the watcher marked dirty without waiting for a request, so
  // readers that never sync (launch injection) see a change too.
  private async flushDirty(): Promise<void> {
    const w = this.watch;
    if (!w.watching) return;
    const pending = w.fullSyncDue ? this.knownProjectIds() : [...w.dirty];
    try {
      await this.syncDirty();
      for (const id of pending) w.onDocsChanged?.(id);
    } catch (err) {
      console.error("[knowledge] watcher sync failed:", err);
    }
  }

  /**
   * Makes sure the sqlite-vec KNN index covers the current chunk corpus. A
   * no-op when sqlite-vec isn't loadable on this connection — search then
   * runs the brute-force cosine scan. Call once at startup after syncAll: a
   * corpus embedded before the extension was enabled has its chunks present
   * and unchanged, so syncProject's mtime skip never re-embeds them and the
   * incremental per-chunk indexing never fires. The mirror persists, and
   * runtime writes (accept/edit → syncProject → upsertChunk) keep it current,
   * so it is rebuilt only when missing, on an older schema, or out of step
   * with the chunks (KnowledgeStore.ensureVecIndex).
   */
  ensureVecIndex(): void {
    // Finishes a JSON-to-blob chunk conversion an earlier boot was stopped in
    // the middle of; a no-op once every chunk holds a blob.
    const converted = this.store.backfillEmbeddingBlobs();
    if (converted > 0) console.log(`[knowledge] Converted ${converted} chunk embeddings to float32 blobs`);
    const { action, reason } = this.store.ensureVecIndex();
    if (action === "rebuilt") console.log(`[knowledge] Rebuilt the sqlite-vec index: ${reason}`);
  }

  /**
   * Starts the knowledge-directory watcher that lets syncDirty skip unchanged
   * projects. The first syncDirty after it starts runs a full sync, covering
   * any change made before the watcher attached. If the watcher fails or
   * stops, syncDirty goes back to re-reading on every call.
   * `onDocsChanged` hears each project a coalesced background flush synced.
   */
  async startWatching(onDocsChanged?: (projectId: string) => void): Promise<void> {
    const w = this.watch;
    w.onDocsChanged = onDocsChanged;
    w.fullSyncDue = true;
    let failed = false;
    await this.loader.startWatching(
      (projectId) => {
        if (!failed) this.markDirty(projectId);
      },
      (err) => {
        failed = true;
        w.watching = false;
        console.error("[knowledge] watcher stopped; every search re-reads the corpus:", err);
      }
    );
    w.watching = !failed;
  }

  stopWatching(): void {
    const w = this.watch;
    w.watching = false;
    if (w.flushTimer) clearTimeout(w.flushTimer);
    w.flushTimer = null;
    this.loader.stopWatching();
  }
}
