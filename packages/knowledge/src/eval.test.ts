import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { KnowledgeStore } from "./store.js";
import { KnowledgeLoader } from "./loader.js";
import {
  runRetrievalEval,
  STANDUP_EVAL_FIXTURES,
  RECALL_AT_5_FLOOR,
  TOP_1_FLOOR,
  type EvalFixture,
} from "./eval.js";
import { SEEDED_EVAL_FIXTURES } from "./eval-seeded-fixtures.js";
import { registerEmbeddingProvider, type EmbeddingProviderPlugin } from "./embeddings.js";
import {
  memoizedSemanticNeighborIndex,
  semanticNeighborIndexFromStore,
  type SemanticNeighborIndex,
} from "./graph.js";
import { GRAPH_RERANK_MIN_SIM } from "./search.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * The eval guard. Seeds a DETERMINISTIC corpus of invented docs (a fictional
 * docs site generator, a fictional tide-prediction library, and a few standup docs) with the
 * keys {@link SEEDED_EVAL_FIXTURES} reference, then runs the fixtures through
 * the real search path (searchKnowledge, FTS-only here since no embedding
 * provider runs offline) and asserts recall@5 / top-1 clear the documented
 * floor. This catches a retrieval regression without depending on the
 * developer's on-disk ~/.config corpus and without hard-failing on ordinary
 * score drift. A second guard runs the default fixtures over the repo's real
 * seed knowledge base.
 */

const SEED_KNOWLEDGE_DIR = join(import.meta.dir, "..", "..", "..", "seed", "knowledge");

/** The seed knowledge base as an install has it after `bun run kb:seed`. */
async function seedKnowledgeBase(): Promise<Database> {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  const loader = new KnowledgeLoader(SEED_KNOWLEDGE_DIR);
  for (const projectId of ["global", "standup"]) {
    for (const d of await loader.loadProject(projectId)) {
      store.upsertDoc({ ...d, id: `${d.projectId}/${d.slug}` });
    }
  }
  return db;
}

describe("default fixtures over the seed knowledge base", () => {
  test("every default fixture names a seed doc", async () => {
    const db = await seedKnowledgeBase();
    const keys = new Set(
      (db.query("SELECT project_id, slug FROM knowledge").all() as { project_id: string; slug: string }[]).map(
        (r) => `${r.project_id}/${r.slug}`
      )
    );
    const missing = STANDUP_EVAL_FIXTURES.flatMap((f) => f.expected).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  test("the default fixtures clear the floors and every keyword fixture hits", async () => {
    const db = await seedKnowledgeBase();
    const result = await runRetrievalEval(db, null);

    expect(result.total).toBe(STANDUP_EVAL_FIXTURES.length);
    expect(result.recallAtK).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    expect(result.top1).toBeGreaterThanOrEqual(TOP_1_FLOOR);
    const keywordMisses = result.perFixture
      .filter((r) => r.kind === "keyword" && !r.hitAtK)
      .map((r) => r.query);
    expect(keywordMisses).toEqual([]);
  });
});

function doc(overrides: Partial<KnowledgeDoc> & Pick<KnowledgeDoc, "projectId" | "slug">): KnowledgeDoc {
  return {
    id: overrides.id ?? `${overrides.projectId}/${overrides.slug}`,
    title: overrides.title ?? overrides.slug,
    body: overrides.body ?? "",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    filePath: `/x/${overrides.projectId}/${overrides.slug}.md`,
    originClass: "owner",
    ...overrides,
  };
}

// Invented bodies that carry the keywords each fixture targets; distractor docs
// share vocabulary so top-1 precision is a real test, not a walkover.
function seedCorpus(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);

  const docs: KnowledgeDoc[] = [
    doc({
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
    }),
    doc({
      projectId: "quillstack",
      slug: "build-pipeline",
      title: "One build pass, from Markdown to HTML",
      body:
        "A build is one process from start to finish. The loader reads content/ into a page graph, " +
        "the plugin host streams each page over stdio to every plugin registered for the render hook, " +
        "and the renderer writes HTML into public/. The link checker walks public/ last, so a Markdown " +
        "page becomes HTML end to end inside a single quill build.",
      tags: ["build", "plugins", "renderer", "page-graph"],
    }),
    doc({
      projectId: "quillstack",
      slug: "external-services",
      title: "What Quillstack reads and calls",
      body:
        "Quillstack fetches theme tarballs from the theme registry and posts preview builds to Quill " +
        "Preview. Locally it reads the lock file and the theme cache that holds unpacked versions.",
      tags: ["services", "theme-cache"],
    }),
    doc({
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
    }),
    doc({
      projectId: "tidepool",
      slug: "gotchas",
      title: "Gotchas: a fit made against the wrong datum",
      body:
        "The nightly refit job fits a constituent set to gauge observations as if they were relative " +
        "to mean sea level. Gauge observations arrive relative to chart datum, so a station imported " +
        "without the datum shift gets a set whose mean level is off by the datum offset.",
      tags: ["gotchas", "datum", "refit"],
    }),
    doc({
      projectId: "standup",
      slug: "status",
      title: "Overnight full build — status",
      body:
        "Progress log for the autonomous overnight build on branch overnight/first-pass-multiplayer. " +
        "Transcript-events substrate landed: a durable per-session sequence-numbered event log, " +
        "migration transcript_events(session_id, seq, event_json) plus transcript_event_identities " +
        "with an idempotency key. Queries appendEvent, getEventsSince, headSeq. Lazy stat-gated ingest " +
        "from the JSONL transcript into the event log, mirroring the multiplayer feed.",
      tags: ["status", "build-log", "implementation", "multiplayer"],
    }),
    doc({
      projectId: "standup",
      slug: "ui-components",
      title: "Standup web UI as-built: Console tabs, ProjectsView, FeedView",
      body:
        "How the console React components are structured today in packages/web/src. The App shell and " +
        "routing: App.tsx holds all top-level state (projects, sessions, checkpoints, asks, launches, " +
        "tickets, presence) and the WebSocket wiring. It boots from a single hello-ok snapshot, falls " +
        "back to REST, and renders exactly one child Console wrapped in a PresenceProvider. Console " +
        "holds the tab strip; ProjectsView is the two-pane mega-view.",
      tags: ["ui", "web", "components", "console", "frontend"],
    }),
    doc({
      projectId: "standup",
      slug: "openclaw-architecture",
      title: "OpenClaw 2.0 — Verified Architecture Deep-Read",
      body:
        "A verified deep-read of OpenClaw 2.0. Memory architecture, storage and provenance: every " +
        "memory chunk carries an origin_class trust class that gates whether it may be auto-injected " +
        "into an agent's context. Owner- and agent-authored content is eligible; untrusted content is " +
        "recalled but never silently injected. The knowledge graph and mesh retrieval span projects.",
      tags: ["openclaw", "architecture", "memory", "provenance", "agent-runtime"],
    }),
    doc({
      projectId: "standup",
      slug: "remote-runners",
      title: "RunnerPool + rented runners for agent sessions",
      body:
        "Durable capture of what RunnerPool is, how it leases short-lived container runners, and the " +
        "JobQueue API that hands an agent session to one. Evaluation of whether rented runners can " +
        "host OpenClaw 2.0 agents that pick up queued work. Rented compute that clones the " +
        "repository and runs the build inside the runner.",
      tags: ["runners", "rented-compute", "research", "agent-runtime"],
    }),
    doc({
      projectId: "standup",
      slug: "first-pass-implementation",
      title: "First-pass full build spec",
      body:
        "Executable spec for an autonomous overnight dynamic workflow building all three concepts: " +
        "gateway dispatch and collaboration, the cross-project knowledge graph, and " +
        "transcript-as-shared-state. Each phase is a bounded implement, build, review, fix loop.",
      tags: ["spec", "implementation", "multiplayer"],
    }),
  ];

  for (const d of docs) store.upsertDoc(d);
  return db;
}

const SEEDED = { fixtures: SEEDED_EVAL_FIXTURES };

describe("retrieval eval harness", () => {
  test("recall@5 and top-1 clear the documented floor over the seeded corpus", async () => {
    const db = seedCorpus();
    const result = await runRetrievalEval(db, null, SEEDED);

    expect(result.total).toBe(SEEDED_EVAL_FIXTURES.length);
    expect(result.k).toBe(5);

    // The guard: a real regression trips this; ordinary score drift does not,
    // because the floor sits below the measured score with margin.
    expect(result.recallAtK).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    expect(result.top1).toBeGreaterThanOrEqual(TOP_1_FLOOR);
  });

  test("every keyword fixture recalls its expected doc — these must never regress", async () => {
    const db = seedCorpus();
    const result = await runRetrievalEval(db, null, SEEDED);

    const keywordMisses = result.perFixture
      .filter((r) => r.kind === "keyword" && !r.hitAtK)
      .map((r) => r.query);
    expect(keywordMisses).toEqual([]);
  });

  test("every paraphrase fixture is top-1 — the precision edge the rank-merge fix targets", async () => {
    // The abstract paraphrase queries must return the intended doc FIRST, not merely
    // somewhere in the top-k. This is stricter than the aggregate TOP_1_FLOOR and
    // guards precision specifically on the phrasings that historically let a
    // tangential doc out-rank the focused one — so a future rank-merge change that
    // regresses paraphrase ranking trips here even if keyword top-1 masks it in
    // the aggregate.
    const db = seedCorpus();
    const result = await runRetrievalEval(db, null, SEEDED);

    const paraphraseMisses = result.perFixture
      .filter((r) => r.kind === "paraphrase" && !r.hitTop1)
      .map((r) => ({ query: r.query, got: r.topResults[0] ?? null }));
    expect(paraphraseMisses).toEqual([]);
  });

  test("returns per-fixture detail so the Health panel can show where retrieval is weak", async () => {
    const db = seedCorpus();
    const result = await runRetrievalEval(db, null, SEEDED);

    expect(result.perFixture).toHaveLength(SEEDED_EVAL_FIXTURES.length);
    for (const r of result.perFixture) {
      expect(typeof r.hitAtK).toBe("boolean");
      expect(r.topResults.length).toBeLessThanOrEqual(5);
      if (r.hitAtK) expect(r.rank).not.toBeNull();
    }
  });

  test("an empty corpus scores zero rather than throwing", async () => {
    const db = new Database(":memory:");
    new KnowledgeStore(db);
    const result = await runRetrievalEval(db, null);
    expect(result.recallAtK).toBe(0);
    expect(result.top1).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Embedding-arm eval. The bun-test path has no live embedding provider, so the
// guard above measures the FTS-only path — the embedding half and the weighted
// text+embedding merge are never exercised. This section closes that gap the
// same way eval-graph.test.ts does: a FROZEN, hand-authored vector geometry
// stands in for a real provider so recall@k / top-1 / MRR / Hit-Rate@k are
// measured through the FULL hybrid merge, deterministically and with no
// network. The geometry is interpretable — each dimension is a topic axis, and
// both the query vector and each doc's chunk vectors are authored as sparse
// topic-weight maps, so cosine is high exactly when a query and a doc share a
// topic. vec() is pure, so the whole geometry is a frozen constant.
// ---------------------------------------------------------------------------
const TOPICS = [
  "override", // 0  copied theme overrides / upgrade shadowing
  "render", // 1  build pass / page graph / plugin host / render hook
  "refit", // 2  nightly refit job → constituent set, predictions computed per request
  "transcript", // 3  transcript-events substrate
  "webui", // 4  react console / App.tsx / ProjectsView
  "trust", // 5  provenance / trust classes / auto-injection
  "themecache", // 6  shared-store confounder (the theme cache and lock file)
  "kgraph", // 7  cross-project knowledge graph
  "runner", // 8  rented runners for agent sessions
  "datum", // 9  fit against the wrong datum (tidepool gotcha)
] as const;
type Topic = (typeof TOPICS)[number];

function vec(weights: Partial<Record<Topic, number>>): number[] {
  return TOPICS.map((t) => weights[t] ?? 0);
}

// The query-side geometry: a term → topic-weight lexicon. The frozen provider
// tokenizes a query the same way retrieval does (lowercase, split on non-word
// characters) and SUMS the topic weights of the terms it recognizes, so a query
// embeds onto the topic axis of the doc it should recall. Terms absent here
// (stopwords, incidental words) contribute nothing. Authored so each canonical
// fixture's discriminating terms land on its expected doc's axis; a term shared
// by two topics (e.g. "theme", "partial") is split across axes so it never
// drags a query onto the wrong doc.
const QUERY_LEXICON: Record<string, Partial<Record<Topic, number>>> = {
  // copied-override gotcha (quillstack/override-shadowing)
  overrides: { override: 1.0 },
  partial: { override: 0.6, render: 0.2 },
  shadows: { override: 1.0 },
  theme: { themecache: 0.4, override: 0.3 },
  upgrade: { override: 0.8 },
  upgrading: { override: 1.0 },
  pin: { override: 0.4, themecache: 0.3 },
  old: { override: 0.6 },
  header: { override: 1.0 },
  still: { override: 0.4 },
  site: { override: 0.2, render: 0.2 },
  // build pass (quillstack/build-pipeline)
  page: { render: 0.8 },
  graph: { render: 0.4 },
  plugin: { render: 1.0 },
  host: { render: 0.8 },
  stdio: { render: 0.8 },
  render: { render: 0.8 },
  hook: { render: 0.6 },
  // on-demand predictions and the nightly refit (tidepool/architecture)
  refit: { refit: 1.0 },
  nightly: { refit: 0.8 },
  job: { refit: 0.6 },
  constituent: { refit: 0.8 },
  set: { refit: 0.3 },
  gauge: { refit: 0.6 },
  observations: { refit: 0.6 },
  forecasts: { refit: 1.0 },
  saved: { refit: 0.6 },
  computed: { refit: 0.6 },
  request: { refit: 0.3 },
  // transcript-events substrate (standup/status)
  transcript: { transcript: 1.0 },
  events: { transcript: 0.8 },
  sequence: { transcript: 0.8 },
  number: { transcript: 0.3 },
  durable: { transcript: 0.6 },
  log: { transcript: 0.6 },
  landed: { transcript: 0.5 },
  overnight: { transcript: 1.0 },
  autonomous: { transcript: 0.6 },
  build: { transcript: 0.5 },
  // web UI (standup/ui-components)
  console: { webui: 1.0 },
  tabs: { webui: 0.8 },
  projectsview: { webui: 1.0 },
  app: { webui: 0.6 },
  tsx: { webui: 0.8 },
  websocket: { webui: 0.8 },
  components: { webui: 0.7 },
  react: { webui: 1.0 },
  frontend: { webui: 1.0 },
  organized: { webui: 0.4 },
  state: { webui: 0.6 },
  live: { webui: 0.2 },
  // trust / provenance (standup/openclaw-architecture)
  trust: { trust: 1.0 },
  classes: { trust: 0.6 },
  provenance: { trust: 1.0 },
  agent: { trust: 0.3 },
  authored: { trust: 0.4 },
  memory: { trust: 0.6, kgraph: 0.2 },
};

function embedQuery(text: string): number[] {
  const weights: Partial<Record<Topic, number>> = {};
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const entry = QUERY_LEXICON[token];
    if (!entry) continue;
    for (const [topic, w] of Object.entries(entry) as [Topic, number][]) {
      weights[topic] = (weights[topic] ?? 0) + w;
    }
  }
  return vec(weights);
}

// How many times the frozen provider embedded a query — proves the eval ran the
// embedding arm, not the FTS-only fallback.
let embedCalls = 0;
const FROZEN_PROVIDER_ID = "frozen-eval";
const frozenProvider: EmbeddingProviderPlugin = {
  id: FROZEN_PROVIDER_ID,
  defaultModel: "frozen-topic-geometry",
  dimensions: TOPICS.length,
  async embed(text) {
    embedCalls++;
    return embedQuery(text);
  },
};
registerEmbeddingProvider(frozenProvider);

// The per-doc chunk vectors. A doc's semantic footprint is authored here, not
// derived from its body, so a distractor can share body vocabulary yet sit on a
// distinct axis (e.g. tidepool/gotchas is the "datum" axis, keeping it off
// tidepool/architecture's "refit" axis) — the same technique eval-graph uses.
const CHUNK_VECTORS: Record<string, number[][]> = {
  "quillstack/override-shadowing": [vec({ override: 1.0, themecache: 0.4 })],
  "quillstack/build-pipeline": [vec({ render: 1.0, themecache: 0.3 })],
  "quillstack/external-services": [vec({ themecache: 1.0, override: 0.2 })],
  "tidepool/architecture": [vec({ refit: 0.7, render: 0.2 }), vec({ refit: 1.0, render: 0.2 })],
  "tidepool/gotchas": [vec({ datum: 1.0, refit: 0.3 })],
  "standup/status": [vec({ transcript: 1.0 })],
  "standup/ui-components": [vec({ webui: 1.0 })],
  "standup/openclaw-architecture": [vec({ trust: 1.0, kgraph: 0.3 })],
  "standup/remote-runners": [vec({ runner: 1.0 })],
  "standup/first-pass-implementation": [vec({ kgraph: 0.6, transcript: 0.3 })],
};

// The canonical corpus (identical bodies to seedCorpus, so the FTS arm is the
// same one the guard above measures) plus the frozen chunk vectors, so the
// embedding arm has vectors to score. vec0 is default-off in tests, so
// searchEmbeddings runs the deterministic brute-force cosine scan.
function seedChunkedCorpus(): Database {
  const db = seedCorpus();
  const store = new KnowledgeStore(db);
  for (const [knowledgeId, chunks] of Object.entries(CHUNK_VECTORS)) {
    chunks.forEach((embedding, i) => {
      store.upsertChunk({
        id: `${knowledgeId}#${i}`,
        knowledgeId,
        chunkIndex: i,
        text: `${knowledgeId} chunk ${i}`,
        embedding,
      });
    });
  }
  return db;
}

describe("retrieval eval harness — hybrid merge (frozen embedding arm)", () => {
  test("recall@5 / top-1 / MRR / Hit-Rate@5 clear the floors through the full text+embedding merge", async () => {
    const db = seedChunkedCorpus();
    embedCalls = 0;
    const result = await runRetrievalEval(db, FROZEN_PROVIDER_ID, SEEDED);

    // The embedding arm actually ran: one query embedding per fixture.
    expect(embedCalls).toBe(SEEDED_EVAL_FIXTURES.length);

    expect(result.total).toBe(SEEDED_EVAL_FIXTURES.length);
    expect(result.recallAtK).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    expect(result.top1).toBeGreaterThanOrEqual(TOP_1_FLOOR);
    // Hit-Rate@k is reported next to recall@k; for single-expected fixtures the
    // two coincide, so it clears the same floor.
    expect(result.hitRateAtK).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    // MRR is a genuine metric in [top1, 1]: a rank-1 hit contributes 1 to both
    // top1 and MRR, and every deeper hit contributes a positive fraction to MRR
    // only. With this well-aligned geometry the answers rank high, so MRR is
    // strong — floored well below the measured value so drift doesn't trip it.
    expect(result.mrr).toBeGreaterThanOrEqual(result.top1);
    expect(result.mrr).toBeLessThanOrEqual(1);
    expect(result.mrr).toBeGreaterThanOrEqual(0.8);
  });

  test("the embedding arm does not regress recall or top-1 versus FTS-only on the same corpus", async () => {
    // The gate B1/B2/B4 lean on: adding the (correctly-aligned) embedding arm to
    // the merge must not drop what FTS alone already recalls. Both runs are over
    // the identical chunked corpus; only the provider differs.
    const db = seedChunkedCorpus();
    const fts = await runRetrievalEval(db, null, SEEDED);
    const hybrid = await runRetrievalEval(db, FROZEN_PROVIDER_ID, SEEDED);

    expect(hybrid.recallAtK).toBeGreaterThanOrEqual(fts.recallAtK);
    expect(hybrid.top1).toBeGreaterThanOrEqual(fts.top1);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(fts.mrr);
  });

  test("the embedding arm materially changes ranking on this corpus (guards a silent embedding drop)", async () => {
    // This eval is the measurement other retrieval changes are gated on. If a
    // rank-merge change embeds the query but drops its contribution (a wrong-dimension
    // vector zeroing every cosine, or embeddingResults never merged), the query is
    // still embedded, so embedCalls stays correct and every floor/no-regression
    // assertion above still holds — hybrid silently collapses to the FTS result.
    // The geometry here is chosen so the embedding arm lifts top-1 and MRR strictly
    // above FTS-only; equality therefore means the embedding arm contributed
    // nothing, flipping that silent drop from green to red.
    const db = seedChunkedCorpus();
    const fts = await runRetrievalEval(db, null, SEEDED);
    const hybrid = await runRetrievalEval(db, FROZEN_PROVIDER_ID, SEEDED);

    expect(hybrid.top1).toBeGreaterThan(fts.top1);
    expect(hybrid.mrr).toBeGreaterThan(fts.mrr);
  });

  test("B2 gate: enabling the graph-rerank arm does not regress the hybrid eval", async () => {
    // The default-decision + no-regression gate for the graph-rerank arm (item
    // B2). Runs the SAME hybrid eval with the graph arm off and on, through the
    // real search path, over the memoized all-pairs neighbor index. The arm is
    // admit/boost-only, so enabling it must never drop recall/top-1/MRR. On THIS
    // corpus the answers already rank at the top, so the arm is inert here (on ==
    // off) — which is why the default-on decision rests on the bridge fixtures
    // below (where it turns off-graph misses into hits), not on this gate. This
    // gate's job is the no-regression floor, not the lift.
    const db = seedChunkedCorpus();
    const store = new KnowledgeStore(db);
    const index = memoizedSemanticNeighborIndex(store);

    const off = await runRetrievalEval(db, FROZEN_PROVIDER_ID, {
      ...SEEDED,
      graphNeighbors: index,
      graphRerank: false,
    });
    const on = await runRetrievalEval(db, FROZEN_PROVIDER_ID, {
      ...SEEDED,
      graphNeighbors: index,
      graphRerank: true,
    });

    console.log("\n=== B2 graph-rerank arm on the hybrid eval (seedChunkedCorpus) ===");
    console.log(
      `  off: recall@5=${off.recallAtK.toFixed(3)} top1=${off.top1.toFixed(3)} mrr=${off.mrr.toFixed(3)} hit@5=${off.hitRateAtK.toFixed(3)}`
    );
    console.log(
      `  on : recall@5=${on.recallAtK.toFixed(3)} top1=${on.top1.toFixed(3)} mrr=${on.mrr.toFixed(3)} hit@5=${on.hitRateAtK.toFixed(3)}`
    );

    // No-regression gate: enabling the arm may only hold or raise each metric.
    expect(on.recallAtK).toBeGreaterThanOrEqual(off.recallAtK);
    expect(on.top1).toBeGreaterThanOrEqual(off.top1);
    expect(on.mrr).toBeGreaterThanOrEqual(off.mrr);
    expect(on.hitRateAtK).toBeGreaterThanOrEqual(off.hitRateAtK);
  });

  // The B2 gate above runs over fixtures whose answers already rank top-1, so
  // there is nothing for a graph promotion to DISPLACE and `on >= off` holds by
  // corpus construction — it never exercises the admit-only property under load.
  // This gate does: a purpose-built corpus where the true answer is a WEAK
  // single-arm (embedding-only) hit competing against a graph-connected lexical
  // distractor. Run through the SAME real search path (runRetrievalEval), the
  // no-regression assertions now have teeth — at the old co-equal graph weight
  // (0.6) the distractor's promotion would leap the true answer, flipping it out
  // of top-1 (top1/MRR would regress from 1.0 to 0.0/0.5 and this test would go
  // red). The subordinate weight keeps the answer top-1 with the arm on.
  const FROZEN_DISP_PROVIDER_ID = "frozen-displacement";
  registerEmbeddingProvider({
    id: FROZEN_DISP_PROVIDER_ID,
    defaultModel: "frozen-displacement-geometry",
    // The query embeds onto the answer's single axis; the answer is the only doc
    // carrying a chunk, so it is the embedding arm's sole (rank-1) hit.
    async embed() {
      return [1, 0, 0];
    },
  });

  function seedDisplacementCorpus(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];
    // Tangential lexical seed: one query term in a short body (text rank 1), no
    // chunk. It carries a third of the query, so its relevance stays below the
    // answer's and the answer leads with the arm off.
    store.upsertDoc(
      doc({
        projectId: "disp",
        slug: "seed",
        title: "Seed notes",
        body: "alpha pipeline subsystem overview",
      })
    );
    // Weak distractor: one query term in a long unrelated body (text rank 2), the
    // neighbor the seed promotes. No chunk, so the graph is its only lift.
    store.upsertDoc(
      doc({
        projectId: "disp",
        slug: "distractor",
        title: "Distractor notes",
        body:
          "alpha appears once here among an otherwise long and unrelated description " +
          "of assorted subjects kept deliberately far from the other query terms",
      })
    );
    // The true answer: no query terms (absent from the text arm), one high-cosine
    // chunk → the embedding arm's rank-1 hit. The low-lexical-overlap answer the
    // graph arm exists to protect, not to displace.
    store.upsertDoc(
      doc({
        projectId: "disp",
        slug: "answer",
        title: "Answer notes",
        body: "an unrelated body about assorted subjects deliberately far from the terms",
      })
    );
    store.upsertChunk({
      id: "disp/answer#0",
      knowledgeId: "disp/answer",
      chunkIndex: 0,
      text: "answer chunk",
      embedding: cosVec(0.9),
    });
    return db;
  }

  test("B2 gate has teeth: the graph arm does not displace a weak-arm true answer", async () => {
    const db = seedDisplacementCorpus();
    // Only the tangential seed points at the weak distractor.
    const index: SemanticNeighborIndex = new Map([
      ["disp/seed", [{ docId: "disp/distractor", similarity: 0.9 }]],
    ]);
    const fixtures: EvalFixture[] = [
      {
        query: "alpha beta gamma",
        expected: ["disp/answer"],
        kind: "paraphrase",
        project: "disp",
        note: "true answer is embedding-rank-1 only; a graph-connected distractor must not displace it",
      },
    ];

    const off = await runRetrievalEval(db, FROZEN_DISP_PROVIDER_ID, {
      fixtures,
      graphNeighbors: index,
      graphRerank: false,
    });
    const on = await runRetrievalEval(db, FROZEN_DISP_PROVIDER_ID, {
      fixtures,
      graphNeighbors: index,
      graphRerank: true,
    });

    console.log("\n=== B2 displacement gate (weak-arm answer vs graph-connected distractor) ===");
    console.log(
      `  off: recall@5=${off.recallAtK.toFixed(3)} top1=${off.top1.toFixed(3)} mrr=${off.mrr.toFixed(3)}`
    );
    console.log(
      `  on : recall@5=${on.recallAtK.toFixed(3)} top1=${on.top1.toFixed(3)} mrr=${on.mrr.toFixed(3)}`
    );

    // Baseline: with the arm off the strong embedding answer already leads.
    expect(off.top1).toBe(1);
    // No-regression gate WITH something at stake — these fail at the old weight.
    expect(on.recallAtK).toBeGreaterThanOrEqual(off.recallAtK);
    expect(on.top1).toBeGreaterThanOrEqual(off.top1);
    expect(on.mrr).toBeGreaterThanOrEqual(off.mrr);
    expect(on.hitRateAtK).toBeGreaterThanOrEqual(off.hitRateAtK);
    // The answer is still ranked first with the arm on — the displacement the
    // subordinate weight prevents.
    expect(on.top1).toBe(1);
  });

  test("per-fixture MRR terms are consistent with rank and hit flags", async () => {
    const db = seedChunkedCorpus();
    const result = await runRetrievalEval(db, FROZEN_PROVIDER_ID, SEEDED);
    for (const r of result.perFixture) {
      if (r.rank === null) {
        expect(r.reciprocalRank).toBe(0);
        expect(r.hitAtK).toBe(false);
      } else {
        expect(r.reciprocalRank).toBeCloseTo(1 / r.rank, 10);
        expect(r.hitAtK).toBe(true);
      }
      // Single-expected fixtures: per-fixture recall is exactly the hit indicator.
      expect(r.recall).toBe(r.hitAtK ? 1 : 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Graph-rerank BRIDGE fixtures (frozen embedding arm). The B2 gate above runs
// over fixtures whose answers already rank at/near the top, so the graph arm has
// nothing to promote and its on/off delta is ~0 by construction. These fixtures
// build the exact case KNOWLEDGE_GRAPH_RERANK targets, exercised through the SAME
// real search path (runRetrievalEval with the embedding arm live): a query whose
// true answer shares little/no lexical vocabulary with it and is only a WEAK
// direct retrieval hit, but sits one semantic-graph hop (a cosine edge clearing
// the rerank's minSim) from a STRONG hit that DOES own the query's terms. The
// strong hit seeds the graph arm, which lends its weak semantic sibling the lift
// that pulls the true answer up.
//
// The geometry decouples the two roles a doc plays. A doc's RETRIEVAL score is
// its BEST chunk's cosine to the query; its GRAPH position is the MEAN of its
// chunk vectors. Each cluster is a pair — a doc with a chunk on a DEDICATED query
// axis plus a chunk on a SHARED axis (plugin-handshake: handq + order;
// theme-registry: regq + lock), and its sibling with a chunk on that shared axis
// plus only a sliver of the dedicated axis (hook-order: order + handq·0.08;
// lock-edits: lock + regq·0.08). The two doc-MEANS are therefore cosine-near (a >=minSim semantic
// edge) while the sibling's best chunk is far from the dedicated-axis query. Each
// cluster is probed from BOTH ends, and the two directions exercise the arm
// DIFFERENTLY:
//
//   FORWARD (#1, #3): the query embeds onto the pair-doc's DEDICATED axis, so that
//   doc is a strong EMBEDDING seed and its sibling (only a sliver on that axis) is
//   a weak direct hit. Distractors own that query axis at a moderate cosine, so
//   they OUT-retrieve the weak answer but sit on their own noise axes (NOT the
//   seed's graph neighbors) — the pool the graph must lift the answer over.
//
//   REVERSE (#2, #4): the seed here is the SLIVER doc (hook-order / lock-
//   edits), whose only strong axis is the SHARED edge axis — which the answer
//   fully occupies too, so the query CANNOT embed there without making the answer
//   a strong direct hit. Instead the seed retrieves via the FTS TEXT arm (its body
//   owns the query's distinctive words), and the query embeds onto axes owned only
//   by the graph-inert distractors, so the answer is an OFF-AXIS near-zero direct
//   hit those distractors out-retrieve. Only the semantic hop from the strong FTS
//   seed lifts the answer — exactly the low-lexical-overlap case the arm exists for.
//
// The measurement below reports the recall@k / top-1 / MRR delta between the two
// modes and asserts only that both run, produce valid metrics, and that the
// fixtures are genuine bridges (answer one qualifying hop from a seed) — never a
// gameable "graph must win".
// ---------------------------------------------------------------------------
const BRIDGE_TOPICS = [
  "handq", // 0  query axis for the plugin-handshake seed
  "order", // 1  axis shared by the plugin-handshake seed and its hook-order answer
  "regq", // 2  query axis for the theme-registry seed
  "lock", // 3  axis shared by the theme-registry seed and its lock-edits answer
  "noiseA", // 4  distractor-only axes, so a distractor's doc-mean is off every seed's
  "noiseB", // 5
  "noiseC", // 6
  "noiseD", // 7
] as const;
type BridgeTopic = (typeof BRIDGE_TOPICS)[number];

function bvec(weights: Partial<Record<BridgeTopic, number>>): number[] {
  return BRIDGE_TOPICS.map((t) => weights[t] ?? 0);
}

// The bridge queries phrase their question in the SEED's vocabulary, so they
// embed onto the seed's query axis — never onto the answer, which omits these
// terms. Only the discriminating terms carry weight; incidental words contribute
// nothing, exactly like QUERY_LEXICON above.
const BRIDGE_LEXICON: Record<string, Partial<Record<BridgeTopic, number>>> = {
  handshake: { handq: 1.0 },
  editing: { handq: 0.3 },
  protocol: { handq: 0.8 },
  declare: { handq: 0.9 },
  version: { handq: 0.5 },
  registry: { regq: 1.0 },
  tarball: { regq: 0.9 },
  checksum: { regq: 0.6 },
  serves: { regq: 0.4 },
  theme: { regq: 0.3 },
  // Reverse-direction cluster-1 query (hook-order → plugin-handshake). The seed
  // hook-order's own axis is `order`, but that is the SHARED edge axis its
  // answer plugin-handshake fully occupies too, so a query there would make the
  // answer a STRONG direct hit — no bridge. Instead these terms embed onto the
  // axes owned only by the graph-inert distractors (d1/d2/d3/d5), so the answer
  // sits off-axis (a near-zero direct hit the distractors out-retrieve) while
  // the seed retrieves via the FTS text arm (its body owns these words). Only
  // the semantic hop from that strong seed lifts the answer.
  equal: { noiseA: 1.0 },
  priority: { noiseA: 0.6 },
  hooks: { noiseB: 1.0 },
  alphabetically: { noiseB: 0.6 },
  run: { noiseC: 1.0 },
};

let bridgeEmbedCalls = 0;
const BRIDGE_PROVIDER_ID = "frozen-bridge";
registerEmbeddingProvider({
  id: BRIDGE_PROVIDER_ID,
  defaultModel: "frozen-bridge-geometry",
  dimensions: BRIDGE_TOPICS.length,
  async embed(text) {
    bridgeEmbedCalls++;
    const weights: Partial<Record<BridgeTopic, number>> = {};
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const entry = BRIDGE_LEXICON[token];
      if (!entry) continue;
      for (const [topic, w] of Object.entries(entry) as [BridgeTopic, number][]) {
        weights[topic] = (weights[topic] ?? 0) + w;
      }
    }
    return bvec(weights);
  },
});

// Each doc's title/body carry (seeds) or deliberately OMIT (answers) the query's
// signature terms, and its chunk vectors set its retrieval score and graph
// position per the note above.
interface BridgeSeed {
  slug: string;
  title: string;
  body: string;
  chunks: number[][];
}
const BRIDGE_DOCS: BridgeSeed[] = [
  // Cluster 1 — plugin start-up. Seed owns handshake/protocol/declare; answer omits them.
  {
    slug: "plugin-handshake",
    title: "The plugin handshake",
    // Body owns the cluster-1 query axis (handshake/protocol/declare/version) so
    // it seeds cluster 1's forward query, but deliberately carries NONE of the
    // reverse query's words (equal/priority/hooks/run/alphabetically) so that as
    // the reverse fixture's ANSWER it earns no FTS term and stays a purely
    // off-axis hit only the graph hop can lift.
    body:
      "Each plugin process opens with a handshake: it must declare its protocol version first, over stdin, before any pages arrive.",
    chunks: [bvec({ handq: 1.0 }), bvec({ order: 1.0 })],
  },
  {
    slug: "hook-order",
    title: "Hook order is deterministic",
    body:
      "Hooks run by priority, lowest number earliest. Plugins at equal priority run alphabetically by name, so " +
      "ordering never depends on start-up timing.",
    chunks: [bvec({ order: 1.0, handq: 0.08 })],
  },
  // Cluster 2 — theme resolution. Seed owns registry/tarball/checksum; answer omits them.
  {
    slug: "theme-registry",
    title: "The theme registry",
    body:
      "The theme registry serves each theme release as a tarball with its sha256 checksum whenever a build resolves a pin.",
    chunks: [bvec({ regq: 1.0 }), bvec({ lock: 1.0 })],
  },
  {
    slug: "lock-edits",
    title: "Edits to quill.toml need a fresh lock",
    body:
      "Editing a range in quill.toml changes nothing by itself: builds read only quill.lock. Rerun quill lock after " +
      "any edit, then commit both files.",
    chunks: [bvec({ lock: 1.0, regq: 0.08 })],
  },
  // Distractors — own a query term and a moderate query-axis cosine (so they
  // out-retrieve the weak answers) but sit on their own noise axes (so they are
  // NOT any seed's graph neighbor and the arm cannot lift them).
  {
    slug: "d1",
    title: "Webhook protocol notes",
    body: "Notes on the webhook protocol for assorted unrelated archive integrations.",
    chunks: [bvec({ handq: 0.6, noiseA: 1.0 })],
  },
  {
    slug: "d2",
    title: "Handshake retry policy",
    body: "The handshake retry policy for an unrelated upload path kept far from other subjects.",
    chunks: [bvec({ handq: 0.5, noiseB: 1.0 })],
  },
  {
    slug: "d3",
    title: "Version badge cache",
    body: "A version badge cache for assorted lookups unrelated to publishing.",
    chunks: [bvec({ handq: 0.45, noiseC: 1.0 })],
  },
  {
    slug: "d4",
    title: "Registry uptime dashboard",
    body: "A dashboard of registry uptime for unrelated operational metrics.",
    chunks: [bvec({ regq: 0.6, noiseD: 1.0 })],
  },
  {
    slug: "d5",
    title: "Tarball fixture gallery",
    body: "A gallery of tarball fixtures for unrelated demos.",
    chunks: [bvec({ regq: 0.5, noiseA: 0.9 })],
  },
];

function seedBridgeCorpus(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  for (const d of BRIDGE_DOCS) {
    store.upsertDoc(doc({ projectId: "quill", slug: d.slug, title: d.title, body: d.body }));
    d.chunks.forEach((embedding, i) => {
      store.upsertChunk({
        id: `quill/${d.slug}#${i}`,
        knowledgeId: `quill/${d.slug}`,
        chunkIndex: i,
        text: `quill/${d.slug} chunk ${i}`,
        embedding,
      });
    });
  }
  return db;
}

// Bridge fixtures, both directions of each cluster's edge: the query owns one
// doc's signature terms, and the EXPECTED answer is its same-cluster sibling,
// whose body omits those terms. Marked paraphrase (low lexical overlap with the
// answer) and noted as bridges.
const BRIDGE_FIXTURES: EvalFixture[] = [
  {
    query: "why declare the protocol version in the handshake first",
    expected: ["quill/hook-order"],
    kind: "paraphrase",
    project: "quill",
    note: "bridge: seed quill/plugin-handshake owns handshake/protocol/declare; the answer omits them, bound by the order axis",
  },
  {
    query: "why do equal priority hooks run alphabetically",
    expected: ["quill/plugin-handshake"],
    kind: "paraphrase",
    project: "quill",
    note: "reverse bridge: seed quill/hook-order owns equal/priority/hooks/alphabetically (a strong FTS hit); the query embeds onto the distractor axes so the answer quill/plugin-handshake is an off-axis weak hit only the order-edge hop promotes",
  },
  {
    query: "which registry serves the theme tarball and its checksum",
    expected: ["quill/lock-edits"],
    kind: "paraphrase",
    project: "quill",
    note: "bridge: seed quill/theme-registry owns registry/tarball/checksum; the answer omits them, bound by the lock axis",
  },
  {
    query: "editing quill.toml changes nothing until you rerun quill lock",
    expected: ["quill/theme-registry"],
    kind: "paraphrase",
    project: "quill",
    note: "bridge: seed quill/lock-edits owns the stale-lock phrasing; the answer omits it",
  },
];

describe("retrieval eval harness — graph-rerank bridge fixtures (frozen embedding arm)", () => {
  test("bridge fixtures are genuine one-hop bridges: each answer is a >=minSim semantic neighbor of some other doc", () => {
    // Non-gameable structural check: for every fixture, SOME doc (its seed) has a
    // semantic edge to the expected answer that clears the rerank's minSim — the
    // hop the graph arm can traverse. This proves the fixtures exercise the arm
    // without asserting the arm wins.
    const db = seedBridgeCorpus();
    const store = new KnowledgeStore(db);
    const index = semanticNeighborIndexFromStore(store);

    for (const fixture of BRIDGE_FIXTURES) {
      const answer = fixture.expected[0];
      let hop: { seed: string; similarity: number } | null = null;
      for (const [seed, neighbors] of index) {
        if (seed === answer) continue;
        const edge = neighbors.find(
          (n) => n.docId === answer && n.similarity >= GRAPH_RERANK_MIN_SIM
        );
        if (edge && (!hop || edge.similarity > hop.similarity)) hop = { seed, similarity: edge.similarity };
      }
      expect(hop).not.toBeNull();
    }
  });

  test("measures graph-rerank OFF vs ON over the bridge fixtures and reports recall@k / top-1 / MRR", async () => {
    const db = seedBridgeCorpus();
    const store = new KnowledgeStore(db);
    const index = memoizedSemanticNeighborIndex(store);

    bridgeEmbedCalls = 0;
    const off = await runRetrievalEval(db, BRIDGE_PROVIDER_ID, {
      fixtures: BRIDGE_FIXTURES,
      graphNeighbors: index,
      graphRerank: false,
    });
    const on = await runRetrievalEval(db, BRIDGE_PROVIDER_ID, {
      fixtures: BRIDGE_FIXTURES,
      graphNeighbors: index,
      graphRerank: true,
    });

    console.log("\n=== graph-rerank on the bridge fixtures (seedBridgeCorpus) ===");
    console.log(
      `  off: recall@5=${off.recallAtK.toFixed(3)} top1=${off.top1.toFixed(3)} mrr=${off.mrr.toFixed(3)} hit@5=${off.hitRateAtK.toFixed(3)}`
    );
    console.log(
      `  on : recall@5=${on.recallAtK.toFixed(3)} top1=${on.top1.toFixed(3)} mrr=${on.mrr.toFixed(3)} hit@5=${on.hitRateAtK.toFixed(3)}`
    );
    for (let i = 0; i < BRIDGE_FIXTURES.length; i++) {
      console.log(
        `    ${BRIDGE_FIXTURES[i].expected[0]}: offRank=${off.perFixture[i].rank} onRank=${on.perFixture[i].rank}`
      );
    }

    // The fixtures exist and both modes ran over all of them.
    expect(BRIDGE_FIXTURES.length).toBeGreaterThan(0);
    expect(off.total).toBe(BRIDGE_FIXTURES.length);
    expect(on.total).toBe(BRIDGE_FIXTURES.length);
    // The embedding arm ran in BOTH modes: one query embedding per fixture, the
    // second run reusing the first run's vector for the same query text.
    expect(bridgeEmbedCalls).toBe(BRIDGE_FIXTURES.length);

    // Valid metrics in both modes — the numbers are the deliverable, not a
    // hardcoded win. MRR is always in [top1, 1] by construction.
    for (const r of [off, on]) {
      for (const metric of [r.recallAtK, r.top1, r.hitRateAtK, r.mrr]) {
        expect(metric).toBeGreaterThanOrEqual(0);
        expect(metric).toBeLessThanOrEqual(1);
      }
      expect(r.mrr).toBeGreaterThanOrEqual(r.top1);
    }
  });
});
