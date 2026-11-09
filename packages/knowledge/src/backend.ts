import type { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import {
  searchKnowledge,
  GRAPH_RERANK_ENABLED,
  type SearchResult,
  type SearchOptions,
} from "./search.js";
import { compileGraph, memoizedSemanticNeighborIndex } from "./graph.js";
import {
  writeDraftFile,
  readKnowledgeFile,
  type KnowledgeDraftInput,
  type KnowledgeDocFile,
} from "./writer.js";
import type { EmbeddingProvider, EmbeddingConfig } from "./embeddings.js";
import type { KnowledgeDoc, KnowledgeEdge, KnowledgeNeighbor, ScopeAudience } from "./types.js";

/**
 * The seam a future remote hub plugs into. Retrieval, doc reads, and graph
 * neighbor lookups go through this interface so a `backend:"gateway"` or
 * `backend:"cloud"` implementation can replace the local one with zero
 * call-site changes. Today the only implementation is markdown + SQLite.
 */
export interface KnowledgeBackend {
  /** Identifies the implementation, e.g. "local-markdown". */
  readonly kind: string;
  /**
   * Whether retrieval fuses an embedding arm. False = FTS-only recall, which
   * caps a hit's fused `rawScore` at the text weight (see search.ts) — absolute
   * relevance bars (the contradiction candidate floor) read this to pick the
   * score scale they compare against.
   */
  readonly embeddingsEnabled: boolean;
  /** Cross-project search, favoring `projectId` (see SearchOptions.corpus). */
  search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** A single doc by project + slug, or null. */
  getDoc(projectId: string, slug: string): KnowledgeDoc | null;
  /**
   * The accepted doc `{slug}.md` read from the backend's AUTHORITATIVE store —
   * ground truth, unlike `getDoc`, which reads the rebuildable SQLite index. The
   * propose path's replaces-slug guard depends on this distinction: a proposal
   * whose slug already names an accepted doc must be flagged as a regenerate so
   * accept merges rather than silently overwriting the human-authored doc. An
   * index that lagged disk (a post-boot project the watcher never picked up, a
   * dropped fs event, a multi-writer gateway) would miss the doc and let the
   * overwrite through — so this reads the source of truth, not the index. For
   * `local-markdown` that is the file on disk; a remote backend answers from its
   * own authoritative store. Returns null when no accepted doc exists.
   */
  readAcceptedDoc(projectId: string, slug: string): Promise<KnowledgeDocFile | null>;
  /**
   * The graph neighbors of a doc. With an `audience` the far-end doc is
   * filtered through its gate (scopeAudienceSql): the agent/MCP path passes a
   * strict audience (scope=global docs, its project's, its own personal docs),
   * the web-browse path a browse audience (every doc but other users' personal
   * layer). Omitting it lists every neighbor.
   */
  neighbors(docId: string, audience?: ScopeAudience): KnowledgeNeighbor[];
  /** Recompiles the cross-project graph from current docs; returns the edges. */
  compile(): KnowledgeEdge[];
  /**
   * Writes a proposal as a `.drafts` entry (the WRITE side of the seam). A
   * proposal only ever creates a draft — invisible to search/getDoc until a
   * human accepts it — so a remote hub can capture proposals through the same
   * interface it serves reads from. Callers pass the resolved projectId +
   * provenance; the backend owns where the draft lands.
   */
  writeDraft(projectId: string, draft: KnowledgeDraftInput): Promise<void>;
}

/**
 * The default backend: markdown files on disk as the source of truth, a
 * rebuildable SQLite index, and hybrid FTS + embedding retrieval. Exactly the
 * behavior Standup shipped before the backend seam existed — the interface is
 * new, the storage is not.
 */
export class LocalMarkdownBackend implements KnowledgeBackend {
  readonly kind = "local-markdown";
  private store: KnowledgeStore;

  constructor(
    private db: Database,
    private embeddingProvider: EmbeddingProvider | null = null,
    private embeddingConfig: EmbeddingConfig = {},
    private knowledgeDir = ""
  ) {
    this.store = new KnowledgeStore(db);
  }

  get embeddingsEnabled(): boolean {
    return this.embeddingProvider != null;
  }

  search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]> {
    // Feed the graph-rerank arm its neighbor index ONLY when the arm is on:
    // honor an index a caller already supplied, otherwise build (and memoize on
    // corpusRevision) the shared one — but skip that build entirely when the
    // flag is off, so a disabled corpus never pays the all-pairs cosine cost and
    // the feature is inert on a live-DB reload.
    const graphRerankOn = options?.graphRerank ?? GRAPH_RERANK_ENABLED;
    const graphNeighbors =
      options?.graphNeighbors ??
      (graphRerankOn ? memoizedSemanticNeighborIndex(this.store) : undefined);
    return searchKnowledge(
      this.db,
      projectId,
      query,
      this.embeddingProvider,
      { ...options, graphNeighbors },
      this.embeddingConfig
    );
  }

  getDoc(projectId: string, slug: string): KnowledgeDoc | null {
    return this.store.getDoc(projectId, slug);
  }

  readAcceptedDoc(projectId: string, slug: string): Promise<KnowledgeDocFile | null> {
    return readKnowledgeFile(this.knowledgeDir, projectId, slug);
  }

  neighbors(docId: string, audience?: ScopeAudience): KnowledgeNeighbor[] {
    return this.store.getNeighbors(docId, audience);
  }

  compile(): KnowledgeEdge[] {
    return compileGraph(this.store);
  }

  writeDraft(projectId: string, draft: KnowledgeDraftInput): Promise<void> {
    return writeDraftFile(this.knowledgeDir, projectId, draft);
  }
}
