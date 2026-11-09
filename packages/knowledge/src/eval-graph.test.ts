import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge, searchKnowledgeWithGraph } from "./search.js";
import { semanticNeighborIndexFromStore, type SemanticNeighborIndex } from "./graph.js";
import { runRetrievalEval, RECALL_AT_5_FLOOR, TOP_1_FLOOR } from "./eval.js";
import { SEEDED_EVAL_FIXTURES } from "./eval-seeded-fixtures.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * OFFLINE, DETERMINISTIC experiment: does a graph-aware retrieval rerank —
 * expanding FTS hits with their SEMANTIC-SIMILARITY graph neighbors — improve
 * recall@5 / top-1 WITHOUT regressing the cases pure retrieval already gets?
 *
 * Everything here is frozen and provider-free:
 *   - runs FTS-only (searchKnowledge/…WithGraph with a null provider), exactly
 *     what `bun test` exercises with no network — so there is NO query-side
 *     embedding available on this path,
 *   - the corpus seeds CHUNKS with HAND-SET embedding vectors (topic-basis
 *     constants), so the per-doc semantic vector is the mean of REAL chunk
 *     vectors — the same storage searchEmbeddings reads in production, NOT the
 *     doc-level embedding_json column that no ingest path ever populates,
 *   - the doc↔doc semantic edge is precomputed once from those chunk vectors, so
 *     it is query-INDEPENDENT and CAN lift a low-lexical-overlap answer that the
 *     FTS-only path would never surface. That lift is the mechanism under test.
 *
 * The rerank is measured against a C0 (no-graph) baseline over three cuts —
 * overall, per-kind (keyword vs paraphrase), and an engineered BRIDGE subset —
 * plus a no-regression list that MUST be empty.
 */

// ---------------------------------------------------------------------------
// Frozen embedding geometry. Each dimension is an interpretable topic axis; a
// doc's chunk embedding is authored as a sparse topic-weight map. Two docs on
// the same axis are cosine-near; docs on different axes are far. These vectors
// ARE the frozen constants — vec() is pure, so the whole geometry is
// deterministic with no provider call. cosineSimilarity normalizes internally,
// so raw (un-normalized) topic weights are fine.
// ---------------------------------------------------------------------------
const TOPICS = [
  "trust", // 0  provenance / auto-injection / poisoning defense
  "render", // 1  build pass / page graph / incremental rebuilds
  "override", // 2  copied theme overrides / theme cache
  "refit", // 3  nightly refit → residual check → promoted constituent set
  "webui", // 4  react console / App.tsx / ProjectsView
  "transcript", // 5  transcript-events substrate
  "kgraph", // 6  cross-project knowledge graph edges
  "merge", // 7  hybrid FTS+embedding retrieval merge
  "embed", // 8  chunk embeddings / vec KNN / cosine
  "runner", // 9  rented runners for agent sessions
  "offsets", // 10 tidepool secondary-station offset chains
  "themecache", // 11 shared store confounder (the theme cache and lock file)
  "worker", // 12 shared infra confounder
  "agentrt", // 13 agent runtime loop / tool dispatch
] as const;
type Topic = (typeof TOPICS)[number];

function vec(weights: Partial<Record<Topic, number>>): number[] {
  return TOPICS.map((t) => weights[t] ?? 0);
}

interface SeedDoc {
  projectId: string;
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  /** One entry per chunk. A doc's semantic vector is the MEAN of these. */
  chunks: number[][];
}

function upsertSeed(store: KnowledgeStore, d: SeedDoc): void {
  const id = `${d.projectId}/${d.slug}`;
  const doc: KnowledgeDoc = {
    id,
    projectId: d.projectId,
    slug: d.slug,
    title: d.title,
    body: d.body,
    tags: d.tags,
    originClass: "owner",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: `/x/${d.projectId}/${d.slug}.md`,
  };
  store.upsertDoc(doc);
  d.chunks.forEach((embedding, i) => {
    store.upsertChunk({
      id: `${id}#${i}`,
      knowledgeId: id,
      chunkIndex: i,
      text: `${d.title} — chunk ${i}`,
      embedding,
    });
  });
}

// ---------------------------------------------------------------------------
// The expanded corpus (~24 docs across four projects). Bodies carry the
// discriminating terms each keyword fixture targets; bridge SIBLINGS
// deliberately OMIT their partner's signature terms so FTS ranks them low while
// the semantic edge still binds them. Distractors share incidental vocabulary
// so top-1 is a real test, not a walkover.
// ---------------------------------------------------------------------------
function seedExpanded(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);

  const docs: SeedDoc[] = [
    // ---- Cluster A: trust / provenance / injection (project openclaw) ----
    {
      projectId: "openclaw",
      slug: "injection-boundary",
      title: "Auto-injection boundary and the poisoning defense",
      body:
        "The relevance floor in injectionGate gates what may be silently injected. An untrusted agent " +
        "draft is recalled but never auto-injected into a prompt — the poisoning defense that the " +
        "origin trust class exists to enable. Only owner and agent classes clear the injection gate.",
      tags: ["trust", "injection", "poisoning"],
      // Two chunks (poisoning-gate emphasis + trust-class emphasis) whose MEAN
      // is the doc's trust vector — exercises the per-doc aggregate.
      chunks: [vec({ trust: 1.0, agentrt: 0.4 }), vec({ trust: 1.0, agentrt: 0.2 })],
    },
    {
      projectId: "openclaw",
      slug: "provenance-classes",
      title: "Provenance stamps on stored memory",
      body:
        "Every stored note carries a stamp recording who authored it. Owner-written and model-written " +
        "content is eligible for silent context inclusion; anything of unknown origin is surfaced for a " +
        "human but held back from automatic use. The stamp travels with the note wherever it is read.",
      tags: ["provenance", "memory"],
      chunks: [vec({ trust: 1.0 })],
    },
    {
      projectId: "openclaw",
      slug: "memory-mesh",
      title: "Cross-project memory mesh retrieval",
      body:
        "Retrieval fans across every project's memory rather than one silo. The mesh recalls a neighbor " +
        "note from a sibling project when it is a better answer than anything local.",
      tags: ["mesh", "retrieval"],
      chunks: [vec({ trust: 0.55, kgraph: 0.45, agentrt: 0.2 })],
    },
    {
      projectId: "openclaw",
      slug: "agent-loop",
      title: "The agent runtime loop",
      body:
        "The loop drives an agent through tool calls and turn boundaries. Each turn assembles a fresh " +
        "prompt from the running context and the model's last reply.",
      tags: ["agent", "loop", "prompt"],
      chunks: [vec({ agentrt: 1.0, trust: 0.2 })],
    },
    {
      projectId: "openclaw",
      slug: "tool-dispatch",
      title: "Tool dispatch and permission prompts",
      body:
        "The runtime dispatches a requested tool through a permission check. A tool outside the allowlist " +
        "raises a permission prompt to the human before it runs.",
      tags: ["tools", "permissions", "prompt"],
      chunks: [vec({ agentrt: 0.9 })],
    },

    // ---- Cluster B: the build pass (project quillstack) ----
    {
      projectId: "quillstack",
      slug: "build-pipeline",
      title: "Build pipeline: one pass from Markdown to HTML",
      body:
        "A build is one process from start to finish. The loader reads content/ into a page graph, the " +
        "plugin host streams each page over stdio to every plugin registered for the render hook, and " +
        "the renderer writes HTML into public/. A Markdown page becomes HTML end to end in one pass.",
      tags: ["architecture", "plugins", "renderer", "page-graph"],
      chunks: [vec({ render: 1.0, themecache: 0.4, worker: 0.4 })],
    },
    {
      projectId: "quillstack",
      slug: "incremental-rebuilds",
      title: "Incremental rebuilds in quill serve",
      body:
        "quill serve keeps a dependency index from every output file to the partials and data files it " +
        "read. On save, only outputs whose inputs changed are rebuilt; saving a shared partial " +
        "invalidates every output that included it.",
      tags: ["serve", "incremental"],
      chunks: [vec({ render: 1.0, themecache: 0.25 })],
    },

    // ---- Cluster C: theme overrides and the theme cache (project quillstack) ----
    {
      projectId: "quillstack",
      slug: "override-shadowing",
      title: "Gotchas: a copied override hides a theme upgrade",
      body:
        "Partials copied into overrides/ resolve before the theme package does, so a local copy shadows " +
        "whatever the theme ships. After quill theme upgrade moves the pin, the site still renders the " +
        "old header partial. The upgrade did land; delete the stale override, or copy the new partial " +
        "and reapply the local edit.",
      tags: ["gotchas", "overrides", "partials", "upgrade"],
      chunks: [vec({ override: 1.0, themecache: 0.5 })],
    },
    {
      projectId: "quillstack",
      slug: "theme-cache",
      title: "The theme cache and lookup order",
      body:
        "ThemeCache unpacks each pinned theme version under the user cache directory at resolve time. " +
        "Which partial wins for a given output is a separate concern, settled by lookup order.",
      tags: ["themes", "cache", "resolve"],
      chunks: [vec({ override: 1.0, themecache: 0.3 })],
    },
    {
      projectId: "quillstack",
      slug: "external-services",
      title: "What Quillstack reads and calls",
      body:
        "Quillstack fetches theme tarballs from the theme registry and posts preview builds to Quill " +
        "Preview. Locally it reads the lock file and the theme cache that holds unpacked versions.",
      tags: ["services", "theme-cache"],
      chunks: [vec({ render: 0.3, override: 0.3, themecache: 0.5 })],
    },

    // ---- Cluster D: on-demand predictions and the nightly refit (project tidepool) ----
    {
      projectId: "tidepool",
      slug: "architecture",
      title: "Architecture: predictions on demand, fits overnight",
      body:
        "A forecast is computed per request from the station's promoted constituent set: the core sums " +
        "the harmonic constituents into heights and the datum shift converts them to the requested " +
        "datum. No forecast is ever saved. The constituent set itself comes from a nightly refit job " +
        "that re-solves the constituents from fresh gauge observations and promotes the candidate set " +
        "once it passes.",
      tags: ["architecture", "predictions", "refit", "constituents"],
      // Per-request serving chunk + nightly refit chunk; mean lands refit-heavy.
      chunks: [vec({ refit: 0.7, worker: 0.5 }), vec({ refit: 1.0, worker: 0.2 })],
    },
    {
      projectId: "tidepool",
      slug: "residual-check",
      title: "The residual check before promotion",
      body:
        "The refit computes an RMS residual between hindcast heights and observed heights over the last " +
        "thirty days. A candidate whose residual exceeds the threshold is held back, and the station stays " +
        "on its previous constituent set.",
      tags: ["refit", "residual", "threshold"],
      chunks: [vec({ refit: 1.0 })],
    },
    {
      projectId: "tidepool",
      slug: "drifting-gauge",
      title: "Gotchas: a drifting gauge freezes its station",
      body:
        "When a gauge drifts, every nightly fit is rejected, so the API goes on serving an old one. " +
        "Predictions look plausible yet slowly part from the water. Recalibrate the gauge, then rerun " +
        "the job by hand.",
      tags: ["gotchas", "gauge", "drift"],
      chunks: [vec({ refit: 0.95 })],
    },
    {
      projectId: "tidepool",
      slug: "secondary-stations",
      title: "Secondary stations and their reference chain",
      body:
        "A secondary station has no fitted set of its own; it stores time and height offsets from a " +
        "reference station. Offsets can chain, so the resolver follows parent links from a secondary " +
        "station up to the first reference that has one.",
      tags: ["stations", "offsets", "reference"],
      chunks: [vec({ offsets: 1.0, kgraph: 0.2 })],
    },

    // ---- Cluster E: web UI (project standup) ----
    {
      projectId: "standup",
      slug: "ui-components",
      title: "Standup web UI as-built: Console tabs, ProjectsView",
      body:
        "App.tsx holds all top-level state — projects, sessions, checkpoints — and the WebSocket wiring. " +
        "It boots from a hello-ok snapshot, falls back to REST, and renders one Console. Console holds " +
        "the tab strip; ProjectsView is the two-pane mega-view.",
      tags: ["ui", "web", "console", "components"],
      chunks: [vec({ webui: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "frontend-state",
      title: "Where the client keeps its state",
      body:
        "A single shell owns the whole client tree. It bootstraps from one snapshot, degrades to REST " +
        "polling when the socket drops, and threads a presence context down to every pane.",
      tags: ["ui", "state"],
      chunks: [vec({ webui: 1.0 })],
    },

    // ---- Cluster F: transcript-events substrate (project standup) ----
    {
      projectId: "standup",
      slug: "status",
      title: "Overnight full build — status",
      body:
        "Progress log for the autonomous overnight build. Transcript-events substrate landed: a durable " +
        "per-session sequence-numbered event log, migration transcript_events(session_id, seq, " +
        "event_json). Queries appendEvent, getEventsSince, headSeq. Lazy stat-gated ingest from the JSONL.",
      tags: ["status", "transcript", "build-log"],
      chunks: [vec({ transcript: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "transcript-substrate",
      title: "Transcript as shared state",
      body:
        "The event log is the shared substrate every reader tails. Ordering is guaranteed by a monotonic " +
        "number and an idempotency key deduplicates a replayed write, so many consumers converge.",
      tags: ["transcript", "substrate", "idempotency"],
      chunks: [vec({ transcript: 1.0 })],
    },

    // ---- Cluster G: knowledge graph + retrieval merge (project standup) ----
    {
      projectId: "standup",
      slug: "knowledge-graph",
      title: "Cross-project knowledge graph",
      body:
        "Edges span projects. Co-citation edges come from shared tags, provenance edges from a shared " +
        "authoring session, and related edges from links an author writes in frontmatter.",
      tags: ["kgraph", "edges", "co-citation"],
      chunks: [vec({ kgraph: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "retrieval-merge",
      title: "Hybrid retrieval merge",
      body:
        "Retrieval fuses FTS bm25 with embedding cosine. Both score spaces are normalized before a " +
        "weighted sum, then a title boost and a project multiplier reorder the topically-close hits.",
      tags: ["merge", "bm25", "ranking"],
      chunks: [vec({ merge: 1.0, embed: 0.4 })],
    },

    // ---- Cluster H: embeddings / vec index (project standup) ----
    {
      projectId: "standup",
      slug: "embeddings",
      title: "Chunk embeddings and the vector index",
      body:
        "Each doc is chunked and every chunk is embedded. The sqlite-vec KNN returns the nearest chunks " +
        "by cosine similarity, with a brute-force scan as the fallback when the extension is absent.",
      tags: ["embeddings", "vec", "cosine"],
      chunks: [vec({ embed: 1.0, merge: 0.3 })],
    },

    // ---- Distractors that share vocabulary but sit on a different axis ----
    {
      projectId: "standup",
      slug: "remote-runners",
      title: "RunnerPool + rented runners for agent sessions",
      body:
        "RunnerPool leases short-lived container runners and the JobQueue API hands an agent session to " +
        "one. A runner clones the repository, runs the build inside the container, and works queued jobs.",
      tags: ["runners", "rented-compute", "agent"],
      chunks: [vec({ runner: 1.0, agentrt: 0.5 })],
    },
    {
      projectId: "standup",
      slug: "openclaw-architecture",
      title: "OpenClaw 2.0 — Verified Architecture Deep-Read",
      body:
        "A verified deep-read of OpenClaw 2.0. Memory architecture and origin_class trust classes gate " +
        "auto-injection; the knowledge graph and mesh retrieval span projects.",
      tags: ["openclaw", "architecture", "memory", "trust"],
      chunks: [vec({ trust: 0.5, kgraph: 0.4, agentrt: 0.3 })],
    },
  ];

  for (const d of docs) upsertSeed(store, d);
  return db;
}

// ---------------------------------------------------------------------------
// The canonical seeded corpus, now WITH chunk embeddings so semantic edges are
// live — the setting in which constraint 3 (the rerank can't drop the seeded
// fixtures below the floor) is actually tested. Same doc keys/bodies as
// eval.test.ts's seedCorpus.
// ---------------------------------------------------------------------------
function seedCanonicalChunked(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  const docs: SeedDoc[] = [
    {
      projectId: "quillstack",
      slug: "override-shadowing",
      title: "A copied override hides a theme upgrade",
      body:
        "Partials copied into overrides/ resolve before the theme package does, so a local copy " +
        "shadows whatever the theme ships. After quill theme upgrade moves the pin, the site still " +
        "renders the old header partial from overrides/. The upgrade did land: the lock file and the " +
        "theme cache both hold the new version. Delete the stale override, or copy the new partial " +
        "and reapply the local edit on top of it.",
      tags: ["themes", "overrides", "partials", "upgrade"],
      chunks: [vec({ override: 1.0, themecache: 0.5 })],
    },
    {
      projectId: "quillstack",
      slug: "build-pipeline",
      title: "One build pass, from Markdown to HTML",
      body:
        "A build is one process from start to finish. The loader reads content/ into a page graph, " +
        "the plugin host streams each page over stdio to every plugin registered for the render hook, " +
        "and the renderer writes HTML into public/. The link checker walks public/ last, so a Markdown " +
        "page becomes HTML end to end inside a single quill build.",
      tags: ["build", "plugins", "renderer", "page-graph"],
      chunks: [vec({ render: 1.0, themecache: 0.4, worker: 0.4 })],
    },
    {
      projectId: "quillstack",
      slug: "external-services",
      title: "What Quillstack reads and calls",
      body:
        "Quillstack fetches theme tarballs from the theme registry and posts preview builds to Quill " +
        "Preview. Locally it reads the lock file and the theme cache that holds unpacked versions.",
      tags: ["services", "theme-cache"],
      chunks: [vec({ render: 0.3, override: 0.3, themecache: 0.5 })],
    },
    {
      projectId: "tidepool",
      slug: "architecture",
      title: "Architecture: predictions on demand, fits overnight",
      body:
        "Tidepool computes every prediction on demand and never stores one. A request loads the " +
        "station's promoted constituent set, and the core sums the harmonic constituents into heights " +
        "at each step. What is persisted is observations, station metadata and the fitted coefficients. " +
        "The nightly refit job re-solves the constituents from fresh gauge observations, scores the " +
        "candidate set against a residual check, and promotes it, so a forecast changes only after a " +
        "promotion.",
      tags: ["architecture", "predictions", "refit", "constituents"],
      chunks: [vec({ refit: 0.7, worker: 0.5 }), vec({ refit: 1.0, worker: 0.2 })],
    },
    {
      projectId: "tidepool",
      slug: "gotchas",
      title: "Gotchas: a fit made against the wrong datum",
      body:
        "The nightly refit job fits a constituent set to gauge observations as if they were relative " +
        "to mean sea level. Gauge observations arrive relative to chart datum, so a station imported " +
        "without the datum shift gets a set whose mean level is off by the datum offset.",
      tags: ["gotchas", "datum", "refit"],
      chunks: [vec({ refit: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "status",
      title: "Overnight full build — status",
      body:
        "Progress log for the autonomous overnight build on branch overnight/first-pass-multiplayer. " +
        "Transcript-events substrate landed: a durable per-session sequence-numbered event log, " +
        "migration transcript_events(session_id, seq, event_json). Queries appendEvent, getEventsSince, " +
        "headSeq. Lazy stat-gated ingest from the JSONL transcript into the event log.",
      tags: ["status", "build-log", "implementation"],
      chunks: [vec({ transcript: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "ui-components",
      title: "Standup web UI as-built: Console tabs, ProjectsView, FeedView",
      body:
        "How the console React components are structured today in packages/web/src. App.tsx holds all " +
        "top-level state (projects, sessions, checkpoints, asks, launches, tickets, presence) and the " +
        "WebSocket wiring. It boots from a single hello-ok snapshot, falls back to REST, and renders one " +
        "child Console wrapped in a PresenceProvider. Console holds the tab strip; ProjectsView is the " +
        "two-pane mega-view.",
      tags: ["ui", "web", "components", "console", "frontend"],
      chunks: [vec({ webui: 1.0 })],
    },
    {
      projectId: "standup",
      slug: "openclaw-architecture",
      title: "OpenClaw 2.0 — Verified Architecture Deep-Read",
      body:
        "A verified deep-read of OpenClaw 2.0. Memory architecture, storage and provenance: every memory " +
        "chunk carries an origin_class trust class that gates whether it may be auto-injected into an " +
        "agent's context. Owner- and agent-authored content is eligible; untrusted content is recalled " +
        "but never silently injected. The knowledge graph and mesh retrieval span projects.",
      tags: ["openclaw", "architecture", "memory", "provenance", "agent-runtime"],
      chunks: [vec({ trust: 0.6, kgraph: 0.4, agentrt: 0.3 })],
    },
    {
      projectId: "standup",
      slug: "remote-runners",
      title: "RunnerPool + rented runners for agent sessions",
      body:
        "Durable capture of what RunnerPool is, how it leases short-lived container runners, and the " +
        "JobQueue API that hands an agent session to one. Rented compute that clones the repository " +
        "and runs the build inside the runner.",
      tags: ["runners", "rented-compute", "research", "agent-runtime"],
      chunks: [vec({ runner: 1.0, agentrt: 0.5 })],
    },
    {
      projectId: "standup",
      slug: "first-pass-implementation",
      title: "First-pass full build spec",
      body:
        "Executable spec for an autonomous overnight dynamic workflow building all three concepts: " +
        "gateway dispatch and collaboration, the cross-project knowledge graph, and " +
        "transcript-as-shared-state. Each phase is a bounded implement, build, review, fix loop.",
      tags: ["spec", "implementation", "multiplayer"],
      chunks: [vec({ kgraph: 0.5, transcript: 0.4 })],
    },
  ];
  for (const d of docs) upsertSeed(store, d);
  return db;
}

// ---------------------------------------------------------------------------
// The expanded, frozen fixture set: 12 keyword, 12 paraphrase, 10 bridge.
// A bridge's query carries a term that lands in a SEED doc; its expected answer
// is that seed's same-cluster sibling, whose body OMITS that term — so FTS ranks
// the answer low while the semantic edge still binds the two.
// ---------------------------------------------------------------------------
type Kind = "keyword" | "paraphrase" | "bridge";
interface GFixture {
  query: string;
  expected: string;
  kind: Kind;
  project?: string;
  note?: string;
}

const FIXTURES: GFixture[] = [
  // ---------- keyword (high overlap; C0 should already nail these) ----------
  { query: "loader page graph plugin host stdio render hook renderer public", expected: "quillstack/build-pipeline", kind: "keyword" },
  { query: "overrides partial shadows quill theme upgrade pin", expected: "quillstack/override-shadowing", kind: "keyword" },
  { query: "ThemeCache unpacks pinned theme version resolve time", expected: "quillstack/theme-cache", kind: "keyword" },
  { query: "promoted constituent set harmonic core datum shift refit job gauge observations", expected: "tidepool/architecture", kind: "keyword" },
  { query: "App.tsx Console tab strip ProjectsView WebSocket hello-ok snapshot", expected: "standup/ui-components", kind: "keyword" },
  { query: "transcript_events appendEvent getEventsSince headSeq sequence log", expected: "standup/status", kind: "keyword" },
  { query: "co-citation provenance related edges cross-project knowledge graph", expected: "standup/knowledge-graph", kind: "keyword" },
  { query: "sqlite-vec KNN chunk embeddings cosine similarity brute-force fallback", expected: "standup/embeddings", kind: "keyword" },
  { query: "hybrid FTS bm25 embedding cosine normalized title boost project multiplier", expected: "standup/retrieval-merge", kind: "keyword" },
  { query: "RunnerPool runners JobQueue container leases", expected: "standup/remote-runners", kind: "keyword" },
  { query: "secondary station time height offsets reference chain parent links", expected: "tidepool/secondary-stations", kind: "keyword" },
  { query: "relevance floor injectionGate untrusted agent auto-injected poisoning", expected: "openclaw/injection-boundary", kind: "keyword" },

  // ---------- paraphrase (moderate overlap; the precision edge) ----------
  { query: "are forecasts saved somewhere or computed fresh for each request", expected: "tidepool/architecture", kind: "paraphrase" },
  { query: "why does my site still show the old header after upgrading the theme", expected: "quillstack/override-shadowing", kind: "paraphrase" },
  { query: "how is the react frontend organized and where does top-level state live", expected: "standup/ui-components", kind: "paraphrase" },
  { query: "what landed in the overnight autonomous build", expected: "standup/status", kind: "paraphrase" },
  { query: "how does a markdown page turn into html end to end", expected: "quillstack/build-pipeline", kind: "paraphrase" },
  { query: "how are documents linked together across different projects", expected: "standup/knowledge-graph", kind: "paraphrase" },
  { query: "how are topically similar hits scored and reordered together", expected: "standup/retrieval-merge", kind: "paraphrase" },
  { query: "how does semantic search find nearest matching passages", expected: "standup/embeddings", kind: "paraphrase" },
  { query: "what keeps low-trust content out of an agent's context automatically", expected: "openclaw/injection-boundary", kind: "paraphrase" },
  { query: "how does rented compute run agent sessions", expected: "standup/remote-runners", kind: "paraphrase" },
  { query: "what external services and caches does quillstack rely on", expected: "quillstack/external-services", kind: "paraphrase" },
  { query: "how does the runtime drive an agent turn by turn", expected: "openclaw/agent-loop", kind: "paraphrase" },

  // ---------- bridge (answer omits the query's signature term; edge to a lexical seed) ----------
  // A: seed injection-boundary (poisoning) -> answer provenance-classes
  { query: "how do we prevent context poisoning by an untrusted agent", expected: "openclaw/provenance-classes", kind: "bridge",
    note: "seed openclaw/injection-boundary owns 'poisoning'; answer omits it, bound by trust axis" },
  // A: seed provenance-classes (provenance/stamp) -> answer injection-boundary
  { query: "where is the provenance stamp of a stored note recorded", expected: "openclaw/injection-boundary", kind: "bridge",
    note: "seed openclaw/provenance-classes owns 'provenance/stamp'; answer omits it" },
  // B: seed build-pipeline (stdio/plugin host) -> answer incremental-rebuilds
  { query: "why stream each page over stdio to the plugin host", expected: "quillstack/incremental-rebuilds", kind: "bridge",
    note: "seed quillstack/build-pipeline owns 'stdio/plugin host'; answer omits it, bound by render axis" },
  // B: seed incremental-rebuilds (dependency index/invalidate) -> answer build-pipeline
  { query: "what does the dependency index invalidate when a shared partial is saved", expected: "quillstack/build-pipeline", kind: "bridge",
    note: "seed quillstack/incremental-rebuilds owns 'dependency index/invalidate'; answer omits it" },
  // C: seed override-shadowing (copied override) -> answer theme-cache
  { query: "why does a copied override shadow the upgrade", expected: "quillstack/theme-cache", kind: "bridge",
    note: "seed quillstack/override-shadowing owns 'copied/override/shadow'; answer omits it, bound by override axis" },
  // C: seed theme-cache (ThemeCache/unpacks) -> answer override-shadowing
  { query: "where does ThemeCache unpack each pinned version", expected: "quillstack/override-shadowing", kind: "bridge",
    note: "seed quillstack/theme-cache owns 'ThemeCache/unpack'; answer omits it" },
  // D: seed residual-check (RMS residual/threshold) -> answer drifting-gauge
  { query: "why does an RMS residual over the threshold hold a candidate back", expected: "tidepool/drifting-gauge", kind: "bridge",
    note: "seed tidepool/residual-check owns 'RMS residual/threshold'; answer omits it, bound by refit axis" },
  // D: seed drifting-gauge (drifting gauge/old fit) -> answer residual-check
  { query: "why does a drifting gauge keep serving an old fit", expected: "tidepool/residual-check", kind: "bridge",
    note: "seed tidepool/drifting-gauge owns 'drifting gauge/old fit'; answer omits it" },
  // F: seed status (appendEvent/getEventsSince) -> answer transcript-substrate
  { query: "how do readers tail the appendEvent and getEventsSince log", expected: "standup/transcript-substrate", kind: "bridge",
    note: "seed standup/status owns 'appendEvent/getEventsSince'; answer omits it, bound by transcript axis" },
  // F: seed transcript-substrate (idempotency/substrate) -> answer status
  { query: "how does an idempotency key deduplicate a replayed shared substrate write", expected: "standup/status", kind: "bridge",
    note: "seed standup/transcript-substrate owns 'idempotency/substrate'; answer omits it" },
];

// ---------------------------------------------------------------------------
// The compare harness. Runs each fixture through C0 (searchKnowledge) and the
// candidate (searchKnowledgeWithGraph) and computes recall@5 / top-1 per group.
// ---------------------------------------------------------------------------
interface FixtureRun {
  fx: GFixture;
  c0Keys: string[];
  candKeys: string[];
  c0Hit: boolean;
  candHit: boolean;
  c0Top1: boolean;
  candTop1: boolean;
  c0Rank: number | null;
  candRank: number | null;
}

const GRAPH_OPTS = { alpha: 0.3, minSim: 0.6, windowFactor: 4 };

async function runFixture(
  db: Database,
  index: SemanticNeighborIndex,
  fx: GFixture,
  graphOpts: { alpha: number; minSim: number; windowFactor: number } = GRAPH_OPTS
): Promise<FixtureRun> {
  const project = fx.project ?? fx.expected.split("/")[0];
  const opts = { limit: 5, corpus: "all" as const };
  const c0 = await searchKnowledge(db, project, fx.query, null, opts);
  const cand = await searchKnowledgeWithGraph(db, project, fx.query, null, opts, {}, {
    neighbors: index,
    ...graphOpts,
  });
  const c0Keys = c0.map((r) => `${r.projectId}/${r.slug}`);
  const candKeys = cand.map((r) => `${r.projectId}/${r.slug}`);
  const c0Idx = c0Keys.indexOf(fx.expected);
  const candIdx = candKeys.indexOf(fx.expected);
  return {
    fx,
    c0Keys,
    candKeys,
    c0Hit: c0Idx !== -1,
    candHit: candIdx !== -1,
    c0Top1: c0Keys[0] === fx.expected,
    candTop1: candKeys[0] === fx.expected,
    c0Rank: c0Idx === -1 ? null : c0Idx + 1,
    candRank: candIdx === -1 ? null : candIdx + 1,
  };
}

interface GroupMetrics {
  label: string;
  n: number;
  c0RecallAt5: number;
  candRecallAt5: number;
  c0Top1: number;
  candTop1: number;
}

function metricsFor(label: string, runs: FixtureRun[]): GroupMetrics {
  const n = runs.length;
  const frac = (xs: boolean[]) => (n === 0 ? 0 : xs.filter(Boolean).length / n);
  return {
    label,
    n,
    c0RecallAt5: frac(runs.map((r) => r.c0Hit)),
    candRecallAt5: frac(runs.map((r) => r.candHit)),
    c0Top1: frac(runs.map((r) => r.c0Top1)),
    candTop1: frac(runs.map((r) => r.candTop1)),
  };
}

function pct(x: number): string {
  return (x * 100).toFixed(1).padStart(5) + "%";
}

function printTable(groups: GroupMetrics[]): void {
  const d = (a: number, b: number) => {
    const delta = (b - a) * 100;
    const s = (delta >= 0 ? "+" : "") + delta.toFixed(1);
    return s.padStart(6);
  };
  console.log("\n=== C0 (no-graph) vs CANDIDATE (graph-rerank) — alpha=%s minSim=%s window=%s ===",
    GRAPH_OPTS.alpha, GRAPH_OPTS.minSim, GRAPH_OPTS.windowFactor);
  console.log(
    "group".padEnd(12) + "n".padStart(4) +
    "  recall@5 C0→cand  Δ".padEnd(28) + "   top1 C0→cand  Δ"
  );
  for (const g of groups) {
    console.log(
      g.label.padEnd(12) +
      String(g.n).padStart(4) + "   " +
      pct(g.c0RecallAt5) + " → " + pct(g.candRecallAt5) + " " + d(g.c0RecallAt5, g.candRecallAt5) + "   " +
      pct(g.c0Top1) + " → " + pct(g.candTop1) + " " + d(g.c0Top1, g.candTop1)
    );
  }
}

describe("graph-rerank retrieval experiment (offline, frozen)", () => {
  test("C0 vs candidate: overall, per-kind, bridge, and no-regression list", async () => {
    const db = seedExpanded();
    const store = new KnowledgeStore(db);
    const index = semanticNeighborIndexFromStore(store, { topN: 8, minSim: 0.5 });

    const runs: FixtureRun[] = [];
    for (const fx of FIXTURES) runs.push(await runFixture(db, index, fx));

    const keyword = runs.filter((r) => r.fx.kind === "keyword");
    const paraphrase = runs.filter((r) => r.fx.kind === "paraphrase");
    const bridge = runs.filter((r) => r.fx.kind === "bridge");
    const nonBridge = runs.filter((r) => r.fx.kind !== "bridge");

    const groups = [
      metricsFor("overall", runs),
      metricsFor("keyword", keyword),
      metricsFor("paraphrase", paraphrase),
      metricsFor("non-bridge", nonBridge),
      metricsFor("bridge", bridge),
    ];
    printTable(groups);

    // The no-regression list: every fixture C0 recalled@5 that the candidate
    // now misses. MUST be empty for a "ship (gated)" verdict.
    const regressions = runs.filter((r) => r.c0Hit && !r.candHit);
    const top1Regressions = runs.filter((r) => r.c0Top1 && !r.candTop1);

    console.log("\n--- regressions (C0 recall@5 hit, candidate miss) ---");
    if (regressions.length === 0) console.log("  none");
    for (const r of regressions) {
      console.log(`  [${r.fx.kind}] "${r.fx.query}" expected ${r.fx.expected} c0Rank=${r.c0Rank} candRank=${r.candRank}`);
    }
    console.log("--- top-1 demotions (C0 top-1, candidate not) ---");
    if (top1Regressions.length === 0) console.log("  none");
    for (const r of top1Regressions) {
      console.log(`  [${r.fx.kind}] "${r.fx.query}" expected ${r.fx.expected} c0Rank=${r.c0Rank} candRank=${r.candRank}`);
    }

    // The bridge wins the graph is supposed to buy: C0 miss → candidate hit.
    const bridgeWins = bridge.filter((r) => !r.c0Hit && r.candHit);
    console.log(`\n--- bridge lifts (C0 miss → candidate recall@5): ${bridgeWins.length}/${bridge.length} ---`);
    for (const r of bridge) {
      console.log(`  [${!r.c0Hit && r.candHit ? "LIFT" : r.c0Hit ? "already" : "miss "}] "${r.fx.query}" -> ${r.fx.expected} c0Rank=${r.c0Rank} candRank=${r.candRank}`);
    }

    // Assertions. The hard requirement: no recall@5 regression on ANY fixture.
    expect(regressions.map((r) => `${r.fx.kind}:${r.fx.expected}`)).toEqual([]);
    // Keyword recall must never regress (it starts at/near ceiling).
    const kw = metricsFor("keyword", keyword);
    expect(kw.candRecallAt5).toBeGreaterThanOrEqual(kw.c0RecallAt5);
  });

  test("boost frontier: how alpha trades bridge lift against regression risk", async () => {
    const db = seedExpanded();
    const store = new KnowledgeStore(db);
    const index = semanticNeighborIndexFromStore(store, { topN: 8, minSim: 0.5 });
    const bridgeN = FIXTURES.filter((f) => f.kind === "bridge").length;

    console.log("\n=== boost frontier (minSim=0.6, window=4) — recall@5 & top1 by alpha ===");
    console.log(
      "alpha".padEnd(7) +
      "overall r@5".padStart(13) + "nonbrdg r@5".padStart(13) + "bridge r@5".padStart(12) +
      "overall t1".padStart(12) + "regr".padStart(6) + "  t1-demote".padStart(11)
    );
    for (const alpha of [0.0, 0.15, 0.3, 0.6, 1.0]) {
      const runs: FixtureRun[] = [];
      for (const fx of FIXTURES) {
        runs.push(await runFixture(db, index, fx, { alpha, minSim: 0.6, windowFactor: 4 }));
      }
      const nonBridge = runs.filter((r) => r.fx.kind !== "bridge");
      const bridge = runs.filter((r) => r.fx.kind === "bridge");
      const r = (xs: FixtureRun[], f: (x: FixtureRun) => boolean) =>
        xs.length === 0 ? 0 : xs.filter(f).length / xs.length;
      const regr = runs.filter((x) => x.c0Hit && !x.candHit).length;
      const t1demote = runs.filter((x) => x.c0Top1 && !x.candTop1).length;
      console.log(
        String(alpha).padEnd(7) +
        pct(r(runs, (x) => x.candHit)).padStart(13) +
        pct(r(nonBridge, (x) => x.candHit)).padStart(13) +
        pct(r(bridge, (x) => x.candHit)).padStart(12) +
        pct(r(runs, (x) => x.candTop1)).padStart(12) +
        String(regr).padStart(6) +
        String(t1demote).padStart(11)
      );
    }
    console.log(`  (bridge fixtures: ${bridgeN}; alpha=0.0 is the C0 baseline reproduced through the wrapper)`);
    expect(true).toBe(true);
  });

  test("constraint 3: rerank keeps the canonical seeded fixtures above the floor with live edges", async () => {
    const db = seedCanonicalChunked();
    const store = new KnowledgeStore(db);
    const index = semanticNeighborIndexFromStore(store, { topN: 8, minSim: 0.5 });

    // C0 baseline (the existing guard, but now against a chunked corpus).
    const c0 = await runRetrievalEval(db, null, { fixtures: SEEDED_EVAL_FIXTURES });

    // Candidate over the same canonical fixtures.
    const runs: FixtureRun[] = [];
    for (const fx of SEEDED_EVAL_FIXTURES) {
      runs.push(
        await runFixture(db, index, {
          query: fx.query,
          expected: fx.expected[0],
          kind: fx.kind,
          project: fx.project,
        })
      );
    }
    const n = runs.length;
    const candRecall = runs.filter((r) => r.candHit).length / n;
    const candTop1 = runs.filter((r) => r.candTop1).length / n;

    console.log("\n=== constraint 3: canonical seeded fixtures (chunked corpus, live edges) ===");
    console.log(`  C0        recall@5=${pct(c0.recallAtK)} top1=${pct(c0.top1)}`);
    console.log(`  candidate recall@5=${pct(candRecall)} top1=${pct(candTop1)}  (floors: recall>=${RECALL_AT_5_FLOOR} top1>=${TOP_1_FLOOR})`);

    // Per-fixture no-regression vs the C0 run.
    const c0ByQuery = new Map(c0.perFixture.map((p) => [p.query, p]));
    const regressed = runs.filter((r) => {
      const base = c0ByQuery.get(r.fx.query);
      return base?.hitAtK === true && !r.candHit;
    });
    console.log(`  canonical regressions (C0 hit -> candidate miss): ${regressed.length}`);
    for (const r of regressed) console.log(`    "${r.fx.query}" -> ${r.fx.expected}`);

    expect(candRecall).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    expect(candTop1).toBeGreaterThanOrEqual(TOP_1_FLOOR);
    expect(regressed.length).toBe(0);
  });
});
