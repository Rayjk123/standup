import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { GLOBAL_PROJECT_ID } from "@standup/shared";
import { KnowledgeStore } from "./store.js";
import {
  searchKnowledge,
  resolveMultiplier,
  resolveWeight,
  extractExcerpt,
  EXCERPT_MAX_LENGTH,
  OTHER_PROJECT_PREFERENCE,
  RANK_RRF_SHARE,
  TITLE_BOOST_WEIGHT,
  RRF_K,
} from "./search.js";
import {
  registerEmbeddingProvider,
  type EmbeddingConfig,
} from "./embeddings.js";
import type { SemanticNeighborIndex } from "./graph.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    ...overrides,
  };
}

describe("searchKnowledge cross-project recall", () => {
  function seed(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Two docs with identical bodies in different projects — only the project
    // multiplier should separate them.
    store.upsertDoc(
      doc({
        id: "a",
        projectId: "alpha",
        slug: "alpha-retry",
        title: "Alpha retry",
        body: "The retry policy uses exponential backoff on rate limits.",
      })
    );
    store.upsertDoc(
      doc({
        id: "b",
        projectId: "beta",
        slug: "beta-retry",
        title: "Beta retry",
        body: "The retry policy uses exponential backoff on rate limits.",
      })
    );
    return db;
  }

  test("a doc in another project surfaces, ranked below the current project's", async () => {
    const db = seed();

    // Searching from beta: both docs are recalled (recall spans projects), and
    // beta's own doc ranks above alpha's (boosted by CURRENT_PROJECT_MULTIPLIER,
    // alpha discounted by OTHER_PROJECT_MULTIPLIER).
    const results = await searchKnowledge(db, "beta", "retry policy backoff", null);

    expect(results.map((r) => r.projectId).sort()).toEqual(["alpha", "beta"]);
    expect(results[0].projectId).toBe("beta");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test("the favored project flips with the searching project", async () => {
    const db = seed();

    const fromAlpha = await searchKnowledge(db, "alpha", "retry policy backoff", null);
    expect(fromAlpha[0].projectId).toBe("alpha");
  });

  test("corpus:'project' restores the hard partition — only the current project", async () => {
    const db = seed();

    const results = await searchKnowledge(db, "beta", "retry policy backoff", null, {
      corpus: "project",
    });

    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe("beta");
  });

  test("results carry the doc id so callers can pivot into graph_neighbors", async () => {
    const db = seed();
    const results = await searchKnowledge(db, "beta", "retry policy backoff", null);
    expect(results.every((r) => r.id.length > 0)).toBe(true);
  });

  // The reserved GLOBAL corpus is just another project id to search — no special
  // casing — so a doc there is recalled from any other project under the default
  // corpus:"all", which is what makes generic best-practices reach every session.
  test("a doc in the reserved 'global' corpus surfaces from a different project (corpus:'all')", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "g",
        projectId: "global",
        slug: "review-workflow",
        title: "Review workflow best practice",
        body: "The retry policy uses exponential backoff on rate limits.",
      })
    );

    // Search from an unrelated project; "all" is the default corpus.
    const results = await searchKnowledge(db, "some-other-project", "retry policy backoff", null);
    expect(results.some((r) => r.projectId === "global" && r.slug === "review-workflow")).toBe(true);
  });

  test("results carry origin_class so the auto-injection gate can act on it", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "owned",
        projectId: "beta",
        slug: "owned",
        body: "retry policy backoff exponential",
        originClass: "owner",
      })
    );
    // No originClass asserted → the store's fail-closed default applies.
    store.upsertDoc(
      doc({ id: "bare", projectId: "beta", slug: "bare", body: "retry policy backoff exponential" })
    );

    const results = await searchKnowledge(db, "beta", "retry policy backoff", null);

    expect(results.find((r) => r.id === "owned")!.originClass).toBe("owner");
    expect(results.find((r) => r.id === "bare")!.originClass).toBe("untrusted");
  });

  test("the cross-project discount applies only to other projects' docs, and only under corpus:'all'", async () => {
    const db = seed();
    const all = await searchKnowledge(db, "beta", "retry policy backoff", null, { corpus: "all" });
    const proj = await searchKnowledge(db, "beta", "retry policy backoff", null, { corpus: "project" });

    const allAlpha = all.find((r) => r.projectId === "alpha")!;
    const allBeta = all.find((r) => r.projectId === "beta")!;
    expect(proj.map((r) => r.projectId)).toEqual(["beta"]);
    // Identical bodies → identical relevance; alpha wins the bm25 tie on id and
    // takes text rank 1, so only the local bonus puts beta (the searching
    // project) first.
    expect(allAlpha.relevance).toBeCloseTo(allBeta.relevance!, 10);
    expect(allBeta.score).toBeGreaterThan(allAlpha.score);
    expect(allAlpha.score + OTHER_PROJECT_PREFERENCE).toBeGreaterThan(allBeta.score);
    // Under "project" beta is the sole hit at text rank 1, with the bonus.
    expect(proj[0].score).toBeGreaterThan(allBeta.score);
  });

  test("rawScore is the absolute relevance — carries neither the project bonus nor the title term", async () => {
    const db = seed();

    // rawScore is the scale the distiller's near-dup bar is calibrated on, so
    // it must be invariant to both the project bonus AND the title term —
    // otherwise that absolute bar drifts with corpus scope or an incidental
    // title match. The beta doc's title ("Beta retry") carries the query term
    // "retry", so its ranking score carries the title term; rawScore must not.
    const all = await searchKnowledge(db, "beta", "retry policy backoff", null, {
      corpus: "all",
    });
    const proj = await searchKnowledge(db, "beta", "retry policy backoff", null, {
      corpus: "project",
    });

    const allBeta = all.find((r) => r.projectId === "beta")!;

    // Same doc, same rawScore regardless of corpus scope.
    expect(proj[0].rawScore!).toBeCloseTo(allBeta.rawScore!, 10);
    // And the title term and bonus that lift its ranking `score` are absent
    // from rawScore, so rawScore sits strictly below the score.
    expect(proj[0].rawScore!).toBeLessThan(proj[0].score);
  });
});

describe("searchKnowledge favors the active project over cross-project noise", () => {
  // The active project's on-topic doc matches only part of the query; an
  // unrelated doc in another project matches every term, so it scores higher on
  // raw bm25 and on relevance. The project preference is a near-tie lever, so
  // the far more complete cross-project match leads while the local doc is
  // still recalled.
  function seedNoise(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "mine-topic",
        projectId: "mine",
        slug: "widget-overview",
        title: "Widget overview",
        body: "The widget subsystem owns rendering.",
      })
    );
    store.upsertDoc(
      doc({
        id: "other-noise",
        projectId: "other",
        slug: "unrelated",
        title: "Unrelated deployment runbook",
        body: "The widget subsystem owns rendering and the deploy pipeline scheduler queue.",
      })
    );
    // Unrelated docs, so the query's words are rare enough to carry evidence.
    for (let i = 0; i < 6; i++) {
      store.upsertDoc(doc({ id: `filler-${i}`, projectId: "other", slug: `filler-${i}`, body: `office note ${i}` }));
    }
    return db;
  }

  test("a cross-project doc that matches the question far more completely leads; the local doc is still recalled", async () => {
    const db = seedNoise();

    const results = await searchKnowledge(
      db,
      "mine",
      "widget subsystem rendering deploy pipeline scheduler queue",
      null
    );

    // Both are recalled (cross-project recall survives)...
    expect(results.map((r) => r.projectId).sort()).toEqual(["mine", "other"]);
    // ...and the discount is a preference, not a verdict: the other project's
    // doc covers every term, the local one three of seven, so it leads.
    const mine = results.find((r) => r.id === "mine-topic")!;
    const other = results.find((r) => r.id === "other-noise")!;
    expect(other.relevance!).toBeGreaterThan(mine.relevance!);
    expect(results[0].id).toBe("other-noise");
  });

  test("the cross-project preference favors the local project without overriding a relevance gap", () => {
    // Every boost is added on relevance's scale, so even a local doc that takes
    // the full fused-rank, title and project terms cannot pass a 0.9-relevance
    // sibling from 0.35, while a near-tie goes local.
    expect(OTHER_PROJECT_PREFERENCE).toBeGreaterThan(0);
    expect(OTHER_PROJECT_PREFERENCE + RANK_RRF_SHARE + TITLE_BOOST_WEIGHT).toBeLessThan(0.9 - 0.35);
  });
});

describe("the cross-project bias is overturnable by a clearly-more-relevant sibling (finding 4)", () => {
  // The regression finding 4 pins: a project preference larger than the
  // achievable relevance gap kept a cross-project doc that is rank 1 in BOTH
  // arms below a weak single-arm current-project hit — it was suppressed, and
  // past the limit dropped entirely (a recall regression, not merely a
  // reorder). The preference must stay below that gap, so the stronger sibling
  // surfaces while the current project still wins ties/near-ties (guarded
  // above).
  const query = "nightly refit job";
  const queryVec = [1, 0, 0];
  const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

  function seed(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Other project: matches every query term (text rank 1) AND carries a
    // high-cosine chunk (embedding rank 1) — strong in BOTH arms.
    store.upsertDoc(
      doc({
        id: "oth-answer",
        projectId: "oth",
        slug: "answer",
        title: "Notes",
        body: "the nightly refit job reweights each harmonic constituent against yesterday's gauge readings",
      })
    );
    store.upsertChunk({
      id: "oth-c",
      knowledgeId: "oth-answer",
      chunkIndex: 0,
      text: "nightly refit job",
      embedding: cosVec(0.9),
    });
    // Current project: matches ONE term in an otherwise unrelated body (text
    // rank 2), no chunk — weak, single-arm. Neutral title so no title boost tips it.
    store.upsertDoc(
      doc({
        id: "cur-weak",
        projectId: "cur",
        slug: "weak",
        title: "Notes",
        body: "a sidebar width tweak, a font swap, and one passing mention of a refit, nothing more",
      })
    );
    return db;
  }

  test("the stronger cross-project doc surfaces above a weak current-project hit", async () => {
    const db = seed();
    registerEmbeddingProvider({
      id: "finding4-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "cur", query, "finding4-vec", { limit: 5 });

    // Both recalled (cross-project recall survives)...
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(["oth-answer", "cur-weak"]));
    // ...and the clearly-more-relevant sibling leads despite the current-project
    // boost on the weak local hit. This FLIPS under the pre-fix 4× spread, where
    // the weak current hit (×2.0) always outsorted the strong sibling (×0.5).
    expect(results[0].id).toBe("oth-answer");
  });
});

describe("searchKnowledge respects a distinct project namespace", () => {
  // Two projects, each with its own doc, both matching the query. A search must
  // not return the same ranked set regardless of which project asks — the
  // "project=A looks just like project=B" collapse. Under corpus:"all" the
  // active project's doc leads; under corpus:"project" the other project's doc
  // is absent entirely.
  function seedTwo(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "self-doc",
        projectId: "standup-self",
        slug: "status",
        title: "Status",
        body: "Project status: the collector and web UI ship the multiplayer feed.",
      })
    );
    store.upsertDoc(
      doc({
        id: "quillstack-doc",
        projectId: "quillstack",
        slug: "architecture",
        // The same title as the other project's doc, so the title boost lifts
        // both alike and the project preference decides.
        title: "Status",
        body: "Project status: the quillstack preview service ships multiplayer review comments.",
      })
    );
    return db;
  }

  test("the top result flips with the searching project — no identical bucket", async () => {
    const db = seedTwo();

    const fromSelf = await searchKnowledge(db, "standup-self", "project status multiplayer", null);
    const fromQuillstack = await searchKnowledge(db, "quillstack", "project status multiplayer", null);

    expect(fromSelf[0].projectId).toBe("standup-self");
    expect(fromQuillstack[0].projectId).toBe("quillstack");
    // The two result sets are genuinely reordered, not identical.
    expect(fromSelf.map((r) => r.projectId)).not.toEqual(fromQuillstack.map((r) => r.projectId));
  });

  test("corpus:'project' hard-partitions to the asking namespace", async () => {
    const db = seedTwo();

    const self = await searchKnowledge(db, "standup-self", "project status multiplayer", null, {
      corpus: "project",
    });
    const quillstack = await searchKnowledge(db, "quillstack", "project status multiplayer", null, {
      corpus: "project",
    });

    expect(self.map((r) => r.projectId)).toEqual(["standup-self"]);
    expect(quillstack.map((r) => r.projectId)).toEqual(["quillstack"]);
  });
});

describe("searchKnowledge does not starve the current project", () => {
  test("a current-project hit outside the flooded global window is still recalled and boosted", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    // Ten other-project docs match all four query terms in four words; the
    // current project's single doc matches them too but in a longer body, so on
    // raw bm25 it ranks 11th — just past the width-10 (limit*2) candidate window.
    // Fetching only the global top-N would drop it before the project preference
    // could act. It must survive, and on a near-tie the preference seats it first.
    for (let i = 0; i < 10; i++) {
      store.upsertDoc(
        doc({
          id: `o${i}`,
          projectId: "other",
          slug: `o${i}`,
          body: "retry policy backoff exponential",
        })
      );
    }
    store.upsertDoc(
      doc({ id: "mine", projectId: "mine", slug: "mine", body: "retry policy backoff exponential for the client" })
    );

    const results = await searchKnowledge(db, "mine", "retry policy backoff exponential", null);

    expect(results.some((r) => r.projectId === "mine")).toBe(true);
    expect(results[0].projectId).toBe("mine");
  });
});

describe("searchKnowledge graph-rerank arm (admit-only third RRF signal)", () => {
  // A lexical SEED that owns the query terms (ranks first), a graph-connected
  // ANSWER with weak lexical overlap (ranks low without the graph), and a
  // graph-ISOLATED doc the neighbor index never names. Only seed→answer is an
  // edge, so only the answer can be lifted.
  function seedGraphCorpus(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "seed",
        projectId: "proj",
        slug: "seed",
        title: "Retry backoff policy",
        body: "Retry policy exponential backoff. The retry policy sets exponential backoff on rate limits.",
      })
    );
    store.upsertDoc(
      doc({
        id: "distractor-a",
        projectId: "proj",
        slug: "distractor-a",
        title: "Rate limit policy",
        body: "Retry policy exponential handling for throttled callers.",
      })
    );
    store.upsertDoc(
      doc({
        id: "distractor-b",
        projectId: "proj",
        slug: "distractor-b",
        title: "Policy notes",
        body: "Retry policy overview and general notes.",
      })
    );
    store.upsertDoc(
      doc({
        id: "answer",
        projectId: "proj",
        slug: "answer",
        title: "Circuit breaker",
        body: "The circuit breaker trips after a retry storm, shedding load until recovery.",
      })
    );
    store.upsertDoc(
      doc({
        id: "isolated",
        projectId: "proj",
        slug: "isolated",
        title: "Backoff appendix",
        body: "Backoff appendix: a standalone note the graph never links.",
      })
    );
    return db;
  }

  // seed's only semantic neighbor is the answer; nothing points at the isolated doc.
  const index: SemanticNeighborIndex = new Map([
    ["seed", [{ docId: "answer", similarity: 0.9 }]],
  ]);
  const query = "retry policy exponential backoff";

  const rankOf = (rs: Awaited<ReturnType<typeof searchKnowledge>>, id: string) =>
    rs.findIndex((r) => r.id === id);

  test("a graph-connected relevant doc is promoted, and the flag toggles the behavior", async () => {
    const db = seedGraphCorpus();

    // Baseline (no index) and the arm explicitly off with the index present must
    // be byte-identical — the flag, not the presence of an index, gates the arm.
    const baseline = await searchKnowledge(db, "proj", query, null, { corpus: "all" });
    const off = await searchKnowledge(db, "proj", query, null, {
      corpus: "all",
      graphNeighbors: index,
      graphRerank: false,
    });
    expect(off.map((r) => r.id)).toEqual(baseline.map((r) => r.id));
    expect(off.map((r) => r.score)).toEqual(baseline.map((r) => r.score));

    const on = await searchKnowledge(db, "proj", query, null, {
      corpus: "all",
      graphNeighbors: index,
      graphRerank: true,
    });

    // The answer starts below the top (weak lexical overlap) and the graph lifts
    // its score — a strict gain, never a fall in rank.
    const answerOff = rankOf(off, "answer");
    const answerOn = rankOf(on, "answer");
    expect(answerOff).toBeGreaterThan(0);
    expect(answerOn).toBeGreaterThanOrEqual(0);
    expect(answerOn).toBeLessThanOrEqual(answerOff);
    expect(on[answerOn].score).toBeGreaterThan(off[answerOff].score);
  });

  test("a graph-isolated doc is never demoted below its base rank (admit/boost-only)", async () => {
    const db = seedGraphCorpus();
    const off = await searchKnowledge(db, "proj", query, null, {
      corpus: "all",
      graphNeighbors: index,
      graphRerank: false,
    });
    const on = await searchKnowledge(db, "proj", query, null, {
      corpus: "all",
      graphNeighbors: index,
      graphRerank: true,
    });

    const offById = new Map(off.map((r) => [r.id, r]));
    // The arm only ADDS a reciprocal-rank term, so NO doc's score may fall: a doc
    // the graph does not touch is unchanged, a touched doc can only rise.
    for (const r of on) {
      const base = offById.get(r.id);
      if (!base) continue;
      expect(r.score).toBeGreaterThanOrEqual(base.score);
    }
    // The isolated doc is named by no edge, so its score is IDENTICAL — never
    // actively demoted, only (possibly) overtaken by the promoted neighbor.
    const isoOff = offById.get("isolated")!;
    const isoOn = on.find((r) => r.id === "isolated")!;
    expect(isoOn.score).toBe(isoOff.score);
  });

  // The double-count regression the graph weight guards against. The offline
  // admit-only invariant (a promoted doc's own score never falls) is NOT enough:
  // a graph term priced at a full retrieval arm's weight lets a weakly-retrieved
  // neighbor of a merely-TANGENTIAL seed OVERTAKE — and, with a few such lifts,
  // push past the limit — a genuinely strong single-arm answer. This reproduces
  // the finding's exact hybrid scenario and asserts the true answer survives.
  //
  //   answer A   embedding rank-1 ONLY (no query terms)     baseRrf = 0.6/(k+1)
  //   seed   S   text rank-1, TANGENTIAL, graph→B (cos 0.9) baseRrf = 0.4/(k+1)
  //   distr  B   text rank-2, weak, the promoted neighbor   baseRrf = 0.4/(k+2)
  //
  // With the arm on, S promotes B at graph-rank-1 (+GRAPH_RERANK_WEIGHT/(k+1)).
  // The true answer A is retrieved by NEITHER lexical term — only the embedding
  // arm — so it is exactly the low-lexical-overlap answer the feature exists to
  // protect, and it must stay top-1. The graph term enters the fused rank, which
  // the ordering score adds to relevance at a small weight, so B's lift is
  // bounded by that weight and B (one query term in a long body) stays below A.
  test("a graph-promoted weak neighbor does NOT displace a strong embedding-arm answer", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const queryVec = [1, 0, 0];
    const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

    // Tangential lexical seed: one query term in a short body (text rank 1), no
    // chunk. It carries a third of the query, so its relevance stays below A's.
    store.upsertDoc(
      doc({
        id: "S",
        projectId: "proj",
        slug: "seed-doc",
        title: "Seed notes",
        body: "alpha pipeline subsystem overview",
      })
    );
    // Weak distractor: one query term in a long unrelated body (text rank 2), the
    // neighbor the seed promotes. No chunk, so the graph is its ONLY lift.
    store.upsertDoc(
      doc({
        id: "B",
        projectId: "proj",
        slug: "distractor-doc",
        title: "Distractor notes",
        body:
          "alpha appears once here among an otherwise long and unrelated description " +
          "of assorted subjects kept deliberately far from the other query terms",
      })
    );
    // The true answer: matches NO query term (absent from the text arm) but its
    // high-cosine chunk makes it the embedding arm's rank-1 hit.
    store.upsertDoc(
      doc({
        id: "A",
        projectId: "proj",
        slug: "answer-doc",
        title: "Answer notes",
        body: "an unrelated body about assorted subjects deliberately far from the terms",
      })
    );
    store.upsertChunk({
      id: "A-c",
      knowledgeId: "A",
      chunkIndex: 0,
      text: "answer chunk",
      embedding: cosVec(0.9),
    });

    registerEmbeddingProvider({
      id: "disp-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    // Only the tangential seed points at the weak distractor.
    const dispIndex: SemanticNeighborIndex = new Map([["S", [{ docId: "B", similarity: 0.9 }]]]);
    const dq = "alpha beta gamma";
    // corpus:"project" → every hit is local; titles carry no query term, so
    // only relevance and the fused rank separate the hits.
    const common = { corpus: "project" as const, graphNeighbors: dispIndex };

    const off = await searchKnowledge(db, "proj", dq, "disp-vec", {
      ...common,
      graphRerank: false,
    });
    const on = await searchKnowledge(db, "proj", dq, "disp-vec", {
      ...common,
      graphRerank: true,
    });

    // Off: the strong embedding answer already leads.
    expect(off[0].id).toBe("A");
    // On: the answer is NOT displaced — the whole point of the fix.
    expect(on[0].id).toBe("A");
    // The arm still did its job: the promoted neighbor's score rose.
    const offById = new Map(off.map((r) => [r.id, r]));
    const onById = new Map(on.map((r) => [r.id, r]));
    expect(onById.get("B")!.score).toBeGreaterThan(offById.get("B")!.score);
    expect(onById.get("A")!.score).toBe(offById.get("A")!.score);
  });
});

// #6: excerpts return the enclosing Markdown section, not a 200-char keyhole,
// so a hit is a coherent unit a brief or a synthesized answer can be built on.
describe("extractExcerpt returns the enclosing section, not a 200-char window", () => {
  const doc = [
    "# Overview",
    "",
    "Standup observes sessions rather than owning them.",
    "",
    "## Retry policy",
    "",
    "The retry policy uses exponential backoff on rate limits, capped at five",
    "attempts before the request is surfaced to the operator as a failure.",
    "",
    "## Storage",
    "",
    "SQLite is a rebuildable index; markdown stays the source of truth.",
  ].join("\n");

  test("returns the whole matched section, well past the old 200-char cap on real docs", () => {
    const excerpt = extractExcerpt(doc, "retry policy backoff");
    // The full section body, not a truncated first sentence.
    expect(excerpt).toContain("exponential backoff on rate limits");
    expect(excerpt).toContain("surfaced to the operator");
    // It stops at the next heading — the unrelated Storage section is excluded.
    expect(excerpt).not.toContain("source of truth");
  });

  test("a match above the first heading yields the opening section without a leading ellipsis", () => {
    const excerpt = extractExcerpt(doc, "observes sessions");
    expect(excerpt).toContain("observes sessions rather than owning them");
    expect(excerpt.startsWith("…")).toBe(false);
    // The Retry section that follows is a different section, so it's excluded.
    expect(excerpt).not.toContain("exponential backoff");
  });

  test("a long section is capped near the budget and marked truncated with an ellipsis", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `line ${i} padding padding padding`).join(
      "\n"
    );
    const big = `# Big\n\nneedle is here\n${filler}`;
    const excerpt = extractExcerpt(big, "needle");

    expect(excerpt).toContain("needle is here");
    // Bounded by the budget (plus the short ellipsis affixes), not the whole doc.
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_LENGTH + 8);
    expect(big.length).toBeGreaterThan(EXCERPT_MAX_LENGTH);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  test("the budget is meaningfully larger than the old 200-char preview", () => {
    expect(EXCERPT_MAX_LENGTH).toBeGreaterThan(200);
  });
});

describe("resolveMultiplier validates env overrides", () => {
  // The multipliers are read from the environment so the spread is tunable
  // without a rebuild. A bare Number() would coerce an empty or garbage
  // override into a value that breaks ranking: Number("") === 0 zeroes the
  // boost so own docs sort last, and Number("nope") === NaN poisons the
  // comparator. Only a finite, strictly-positive override may replace the
  // default; everything else falls back.
  test("an absent override uses the default", () => {
    expect(resolveMultiplier(undefined, 2.0)).toBe(2.0);
  });

  test("an empty string does not zero the multiplier", () => {
    // Number("") === 0 — the current-project boost must not silently vanish.
    expect(resolveMultiplier("", 2.0)).toBe(2.0);
  });

  test("a non-numeric override does not become NaN", () => {
    expect(resolveMultiplier("nope", 0.5)).toBe(0.5);
  });

  test("zero and negatives fall back rather than invert ranking", () => {
    expect(resolveMultiplier("0", 2.0)).toBe(2.0);
    expect(resolveMultiplier("-1", 2.0)).toBe(2.0);
  });

  test("a finite positive override is honored", () => {
    expect(resolveMultiplier("3.5", 2.0)).toBe(3.5);
  });

  test("the module-level ranking weights are finite and non-negative", () => {
    // Whatever the environment held at import time, the resolved constants must
    // be usable — a NaN here is the ranking bug this guards against.
    expect(Number.isFinite(OTHER_PROJECT_PREFERENCE)).toBe(true);
    expect(OTHER_PROJECT_PREFERENCE).toBeGreaterThan(0);
    expect(RANK_RRF_SHARE).toBeGreaterThanOrEqual(0);
    expect(RANK_RRF_SHARE).toBeLessThanOrEqual(1);
    expect(Number.isFinite(TITLE_BOOST_WEIGHT)).toBe(true);
    expect(TITLE_BOOST_WEIGHT).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveWeight validates env overrides of additive weights", () => {
  const cases: Array<{ name: string; env: string | undefined; expected: number }> = [
    { name: "absent uses the default", env: undefined, expected: 0.1 },
    { name: "empty uses the default", env: "", expected: 0.1 },
    { name: "blank uses the default", env: "  ", expected: 0.1 },
    { name: "non-numeric uses the default", env: "nope", expected: 0.1 },
    { name: "negative uses the default", env: "-0.2", expected: 0.1 },
    { name: "zero turns the term off", env: "0", expected: 0 },
    { name: "a finite positive value is honored", env: "0.25", expected: 0.25 },
  ];
  for (const c of cases) test(c.name, () => expect(resolveWeight(c.env, 0.1)).toBe(c.expected));
});

describe("the project bonus is a cross-project lever, not an intra-project one", () => {
  // The bonus is added to every current-project hit alike, so it reorders
  // projects against each other but never reorders two docs within the same
  // project. Intra-project relative rank is therefore decided by relevance and
  // the fused rank under both corpus modes — the bonus neither creates nor
  // cures same-project noise (that is the corpus:"project" isolation path's and
  // the content's job, not this lever's). This pins that boundary so a future
  // edit can't quietly claim the bonus does more than it does.
  function seedSameProject(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Two docs in the SAME (current) project. `strong` matches the query more
    // completely than `weak`, so raw bm25 ranks it higher. Their titles are
    // IDENTICAL so both carry the same title-match ratio: this isolates the
    // project bonus under test from the title term.
    store.upsertDoc(
      doc({
        id: "strong",
        projectId: "mine",
        slug: "widget-rendering",
        title: "Widget rendering pipeline",
        body: "The widget subsystem owns rendering and the render pipeline.",
      })
    );
    store.upsertDoc(
      doc({
        id: "weak",
        projectId: "mine",
        slug: "widget-mention",
        title: "Widget rendering pipeline",
        body: "A short note that mentions the widget once.",
      })
    );
    return db;
  }

  test("intra-project order is the same under corpus:'all' and corpus:'project'", async () => {
    const db = seedSameProject();

    const all = await searchKnowledge(db, "mine", "widget subsystem rendering pipeline", null, {
      corpus: "all",
    });
    const proj = await searchKnowledge(db, "mine", "widget subsystem rendering pipeline", null, {
      corpus: "project",
    });

    // Both docs recalled, more-relevant first, and the bonus under "all" did not
    // reorder the same-project pair relative to the "project" order.
    expect(all.map((r) => r.id)).toEqual(["strong", "weak"]);
    expect(all.map((r) => r.id)).toEqual(proj.map((r) => r.id));
  });

  test("the bonus is uniform within a project — the gap between two same-project docs is unchanged", async () => {
    const db = seedSameProject();

    const all = await searchKnowledge(db, "mine", "widget subsystem rendering pipeline", null, {
      corpus: "all",
    });
    const proj = await searchKnowledge(db, "mine", "widget subsystem rendering pipeline", null, {
      corpus: "project",
    });

    const gap = (rs: { id: string; score: number }[]) =>
      rs.find((r) => r.id === "strong")!.score - rs.find((r) => r.id === "weak")!.score;

    // Every current-project score takes the same bonus and — the titles being
    // identical — the same title term, so the strong−weak gap is identical
    // under both corpus modes.
    expect(gap(all)).toBeCloseTo(gap(proj), 10);
    expect(gap(all)).toBeGreaterThan(0);
  });
});

describe("searchKnowledge sourceKinds filter (SQL-level, not a post-filter)", () => {
  test("FTS: restricts recall to the named kinds even amid a matching majority of another kind", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (let i = 0; i < 20; i++) {
      store.upsertDoc(
        doc({
          id: `code-${i}`,
          slug: `code-${i}`,
          title: `Code ${i}`,
          body: "checkout payment flow module code",
          sourceKind: "code",
        })
      );
    }
    store.upsertDoc(
      doc({
        id: "spec",
        slug: "spec",
        title: "Spec",
        body: "checkout payment flow requirements",
        sourceKind: "spec",
      })
    );

    // A small limit that a code majority would fill in a mixed pool; the SQL
    // kind filter draws only spec rows, so the spec survives.
    const results = await searchKnowledge(db, "proj", "checkout payment flow", null, {
      limit: 3,
      sourceKinds: ["product", "spec"],
    });
    expect(results.length).toBe(1);
    expect(results[0].slug).toBe("spec");
    expect(results[0].sourceKind).toBe("spec");
  });

  test("embedding path applies the same kind filter to the chunk pool", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "code", slug: "code", title: "Code", sourceKind: "code" }));
    store.upsertChunk({
      id: "cc",
      knowledgeId: "code",
      chunkIndex: 0,
      text: "vector body",
      embedding: [1, 0, 0],
    });
    store.upsertDoc(doc({ id: "spec", slug: "spec", title: "Spec", sourceKind: "spec" }));
    store.upsertChunk({
      id: "sc",
      knowledgeId: "spec",
      chunkIndex: 0,
      text: "vector body",
      embedding: [1, 0, 0],
    });

    registerEmbeddingProvider({
      id: "unit-vec",
      defaultModel: "m",
      async embed() {
        return [1, 0, 0];
      },
    });

    const results = await searchKnowledge(db, "proj", "vector body", "unit-vec", {
      sourceKinds: ["product", "spec"],
    });
    expect(results.map((r) => r.slug)).toEqual(["spec"]);
  });
});

describe("hybrid merge precision — a focused doc is not out-ranked by a tangential one", () => {
  // The precision edge: on a
  // paraphrased query the embedding model can seat a topically-adjacent doc a
  // hair above the doc the question actually wants — the reported case where a
  // tangential `remote-runners` research doc outranked the relevant spec. The focused
  // doc names the subject in its TITLE; the tangential one does not. A fixed
  // query vector stands in for the embedder so the ranking, not the model, is
  // under test.
  //
  // The two fixtures below share a chunk-embedding scheme: the query vector is
  // [1,0,0]; the FOCUSED doc's chunk sits at a slightly LOWER cosine (0.68) than
  // the TANGENTIAL doc's (0.74), reproducing the embedder putting the wrong doc
  // first. Under a weighted sum (raw cosine, no title signal) the tangential doc
  // wins; the title-match boost lifts the focused doc — whose title carries the
  // query's discriminating terms — back to the top without dropping the
  // tangential doc from recall.
  const query = "trim the preview retention";
  const queryVec = [1, 0, 0];
  const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

  function seedFocusedVsTangential(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "focused",
        projectId: "proj",
        slug: "trim-preview-retention",
        title: "Trim preview retention",
        body: "Each branch build carries a keep-days count, and the sweeper deletes its rendered pages once that count runs out.",
      })
    );
    store.upsertChunk({
      id: "focused-c",
      knowledgeId: "focused",
      chunkIndex: 0,
      text: "keep-days count sweeper rendered pages",
      embedding: cosVec(0.68),
    });
    store.upsertDoc(
      doc({
        id: "tangential",
        projectId: "proj",
        slug: "remote-runners",
        title: "Remote runners agent runtime research",
        body: "An evaluation of rented container compute that runs agent sessions and clones repositories.",
      })
    );
    store.upsertChunk({
      id: "tangential-c",
      knowledgeId: "tangential",
      chunkIndex: 0,
      text: "rented container compute agent sessions",
      embedding: cosVec(0.74),
    });
    return db;
  }

  test("the focused doc is top-1 even though the tangential doc has the higher raw cosine", async () => {
    const db = seedFocusedVsTangential();
    registerEmbeddingProvider({
      id: "fixed-query-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "fixed-query-vec", { limit: 5 });

    // The title-match boost seats the focused doc first...
    expect(results[0].id).toBe("focused");
    // ...without excluding the tangential doc — recall is preserved, only the
    // ordering is corrected.
    expect(results.map((r) => r.id).sort()).toEqual(["focused", "tangential"]);
    // The focused doc's fused score clears the tangential doc's.
    const focused = results.find((r) => r.id === "focused")!;
    const tangential = results.find((r) => r.id === "tangential")!;
    expect(focused.score).toBeGreaterThan(tangential.score);
  });

  test("the focused doc is top-1 under corpus:'project' too", async () => {
    // Launch injection's product/spec retrieval scopes corpus:"project". This
    // pins the same paraphrase-precision behavior under that scope: the focused
    // doc leads even though the tangential doc has the higher raw cosine.
    const db = seedFocusedVsTangential();
    registerEmbeddingProvider({
      id: "fixed-query-vec-proj",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "fixed-query-vec-proj", {
      limit: 5,
      corpus: "project",
    });

    expect(results[0].id).toBe("focused");
    const focused = results.find((r) => r.id === "focused")!;
    const tangential = results.find((r) => r.id === "tangential")!;
    // The ranking score seats the focused doc first...
    expect(focused.score).toBeGreaterThan(tangential.score);
    // ...but rawScore — an absolute bar — still reflects the raw cosine, so the
    // tangential doc's rawScore stays the higher of the two and the title term
    // has NOT leaked into the absolute scale.
    expect(tangential.rawScore!).toBeGreaterThan(focused.rawScore!);
  });

  test("the title boost matches whole words, not substrings — an 'agent' term is not lifted by an 'agentic' title", async () => {
    // Guards the substring hazard: `"agentic".includes("agent")` is true, so a
    // naive title check would boost a tangential 'agentic' doc on an 'agent'
    // query — the exact miss the word-level match exists to prevent. Two docs
    // with identical bodies (so FTS/embedding are a wash), separated only by
    // whether their title carries the query terms as whole words.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "whole-word",
        projectId: "proj",
        slug: "agent-runtime",
        title: "Agent runtime notes",
        body: "Shared body describing the same subsystem in identical words.",
      })
    );
    store.upsertDoc(
      doc({
        id: "substring-only",
        projectId: "proj",
        slug: "agentic-pipeline",
        title: "Agentic pipeline overview",
        body: "Shared body describing the same subsystem in identical words.",
      })
    );

    const results = await searchKnowledge(db, "proj", "agent runtime", null, { limit: 5 });

    // The whole-word title match ("agent", "runtime") is boosted; the
    // "agentic" title is not, so the whole-word doc leads.
    expect(results[0].id).toBe("whole-word");
  });

  test('the title term rides the ranking score under BOTH corpora — a local doc scores the same under "all" and "project"', async () => {
    // The confidence floors read `relevance` and the near-dup bar reads
    // rawScore as ABSOLUTE values, so the title term must ride the ranking
    // `score` and stay out of both. It applies under both corpus modes, and the
    // asking project's doc is local under both, so the two scores are equal. A
    // single doc whose title carries both query terms (ratio 1) isolates these
    // terms independent of bm25 magnitude.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "titled",
        projectId: "proj",
        slug: "constituent-cache",
        title: "Constituent cache",
        body: "Fitted harmonics sit in memory per station until the next refit replaces them.",
      })
    );

    const proj = await searchKnowledge(db, "proj", "constituent cache", null, {
      corpus: "project",
      limit: 5,
    });
    const all = await searchKnowledge(db, "proj", "constituent cache", null, {
      corpus: "all",
      limit: 5,
    });

    expect(proj[0].id).toBe("titled");
    expect(all[0].id).toBe("titled");

    // The term rides the ORDERING score: "titled" is the sole hit at text rank 1
    // (the default text weight 0.4 over a ceiling of 0.4 + 0.6), so its score is
    // exactly relevance plus the weighted fused rank, the full title term
    // (ratio 1) and the local bonus. None of it is in `relevance` or `rawScore`.
    const fusedRank = 0.4 / (0.4 + 0.6);
    expect(proj[0].score).toBeCloseTo(
      proj[0].relevance! + RANK_RRF_SHARE * fusedRank + TITLE_BOOST_WEIGHT + OTHER_PROJECT_PREFERENCE,
      10
    );
    expect(all[0].score).toBeCloseTo(proj[0].score, 10);
  });
});

describe("RRF — the text and embedding arms merge by rank position", () => {
  // RRF (Cormack 2009) ranks each arm INDEPENDENTLY by its own score and scores a
  // doc 1/(RRF_K + rank) summed over the arms that returned it — 0 from an arm
  // that did not. The whole point is that only rank POSITION fuses: BM25 and cosine
  // magnitudes never share a unit. The fixture pins the three behaviors that define
  // it, with everything else fixed (corpus:"project" → every hit takes the local
  // bonus; titles carry no query term → no title term) so a hit's fused rank is
  // recoverable from `score` − `relevance` − the bonus (fusedRrf below).
  //
  //   text-only  matches FTS strongly (text rank 1) and has NO chunk    → embedding absent
  //   embed-only matches NO FTS term but has a high-cosine chunk         → text absent
  //   both       matches FTS weakly (text rank 2) and has a lower-cosine → both arms, rank 2 each
  //
  // Weighted RRF (weights 0.4 text / 0.6 embedding): text-only = 0.4/(k+1)+0,
  // embed-only = 0+0.6/(k+1), both = 0.4/(k+2)+0.6/(k+2) = 1/(k+2). The doc
  // present in BOTH arms has the highest fused rank even though it is only
  // SECOND in each — the signature RRF result a weighted sum of a strong
  // single-arm score would miss. The final order adds that fused rank to
  // relevance at RANK_RRF_SHARE, so relevance decides between clearly unequal
  // matches.
  const query = "widget rendering";
  // The raw weighted RRF value of a hit, from its ordering score (trust 1, no
  // title term, local bonus): score = relevance + share·rrf·(RRF_K + 1) + bonus.
  const fusedRrf = (r: { score: number; relevance?: number }) =>
    (r.score - r.relevance! - OTHER_PROJECT_PREFERENCE) / RANK_RRF_SHARE / (RRF_K + 1);
  const queryVec = [1, 0, 0];
  const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

  function seedRrf(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Dense in both query terms, short → the strongest BM25 hit (text rank 1). No
    // chunk, so it never enters the embedding arm.
    store.upsertDoc(
      doc({
        id: "text-only",
        projectId: "proj",
        slug: "text-only",
        title: "Notes one",
        body: "widget rendering widget rendering pipeline subsystem",
      })
    );
    // Matches "widget" once inside a long, otherwise unrelated body → a weaker
    // BM25 hit (text rank 2). Also carries a chunk, so it is in BOTH arms.
    store.upsertDoc(
      doc({
        id: "both",
        projectId: "proj",
        slug: "both",
        title: "Notes two",
        body:
          "widget appears once here among an otherwise long and unrelated description " +
          "of assorted topics kept deliberately far from the query terms",
      })
    );
    store.upsertChunk({
      id: "both-c",
      knowledgeId: "both",
      chunkIndex: 0,
      text: "both chunk",
      embedding: cosVec(0.5),
    });
    // Matches NEITHER query term → absent from the text arm. Its high-cosine chunk
    // makes it the embedding arm's rank-1 hit.
    store.upsertDoc(
      doc({
        id: "embed-only",
        projectId: "proj",
        slug: "embed-only",
        title: "Notes three",
        body: "an unrelated body about assorted topics deliberately far from the terms",
      })
    );
    store.upsertChunk({
      id: "embed-only-c",
      knowledgeId: "embed-only",
      chunkIndex: 0,
      text: "embed chunk",
      embedding: cosVec(0.9),
    });
    return db;
  }

  test("k is 60 — the Cormack default", () => {
    expect(RRF_K).toBe(60);
  });

  test("a doc in BOTH arms at rank 2 has a higher fused rank than docs at rank 1 in a single arm", async () => {
    const db = seedRrf();
    registerEmbeddingProvider({
      id: "rrf-fixed-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "rrf-fixed-vec", {
      corpus: "project",
      textWeight: 0.4,
      embeddingWeight: 0.6,
    });
    const byId = new Map(results.map((r) => [r.id, r]));

    // All three recalled; the both-arms doc has the highest fused rank.
    expect(new Set(results.map((r) => r.id))).toEqual(
      new Set(["text-only", "both", "embed-only"])
    );

    // The fused rank in each ordering score is exactly the WEIGHTED RRF term:
    // each arm contributes weight/(RRF_K + rank).
    const rrf = (id: string) => fusedRrf(byId.get(id)!);
    expect(rrf("both")).toBeCloseTo(0.4 / (RRF_K + 2) + 0.6 / (RRF_K + 2), 10);
    // A missing arm contributes 0: each single-arm doc carries only its own arm's
    // weighted term — 0.4/(k+1) for the text-only doc, 0.6/(k+1) for the embedding one.
    expect(rrf("text-only")).toBeCloseTo(0.4 / (RRF_K + 1), 10);
    expect(rrf("embed-only")).toBeCloseTo(0.6 / (RRF_K + 1), 10);
    expect(rrf("both")).toBeGreaterThan(Math.max(rrf("text-only"), rrf("embed-only")));

    // The source label reflects which arm actually returned the doc.
    expect(byId.get("text-only")!.source).toBe("text");
    expect(byId.get("embed-only")!.source).toBe("embedding");
  });

  test("rawScore is unchanged by RRF — it stays the weighted absolute relevance", async () => {
    const db = seedRrf();
    registerEmbeddingProvider({
      id: "rrf-fixed-vec-raw",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "rrf-fixed-vec-raw", {
      corpus: "project",
      textWeight: 0.4,
      embeddingWeight: 0.6,
    });
    const embedOnly = results.find((r) => r.id === "embed-only")!;

    // embed-only has no text share, so its rawScore is exactly rawCosine ×
    // embeddingWeight (0.9 × 0.6) — the documented absolute-relevance formula,
    // untouched by the rank merge that sets `score`. Chunk vectors are stored
    // as float32, so the cosine is exact to float32 precision.
    expect(embedOnly.rawScore!).toBeCloseTo(0.9 * 0.6, 6);
    // `score` is built from relevance and the fused rank, not from rawScore:
    // absolute-bar consumers must read rawScore or relevance, never `score`.
    expect(embedOnly.score).toBeCloseTo(
      embedOnly.relevance! + RANK_RRF_SHARE * 0.6 + OTHER_PROJECT_PREFERENCE,
      10
    );
  });

  test("arm weights decide ordering between single-arm hits (finding 3)", async () => {
    // Finding 3: an UNweighted RRF dropped the tuned text/embedding weights from
    // the fused ORDERING — they survived only in rawScore — so a text-arm rank-1
    // hit and an embedding-arm rank-1 hit fused identically (1/(k+1) each) and
    // tie-broke on id, a coin flip. Weighted RRF puts the arm balance back in the
    // ordering: the embedding-arm rank-1 hit (0.6/(k+1)) outranks the text-arm
    // rank-1 hit (0.4/(k+1)) per the tuned 0.4/0.6 split.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Pure text hit: matches both query terms (text rank 1), no chunk.
    store.upsertDoc(
      doc({
        id: "text-hit",
        projectId: "proj",
        slug: "text-hit",
        title: "Notes one",
        body: "widget rendering widget rendering pipeline",
      })
    );
    // Pure embedding hit: body shares no query term (absent from the text arm),
    // high-cosine chunk (embedding rank 1). Neutral title so no title boost tips it.
    store.upsertDoc(
      doc({
        id: "embed-hit",
        projectId: "proj",
        slug: "embed-hit",
        title: "Notes two",
        body: "an unrelated body of assorted topics far from the terms",
      })
    );
    store.upsertChunk({
      id: "embed-hit-c",
      knowledgeId: "embed-hit",
      chunkIndex: 0,
      text: "embed chunk",
      embedding: cosVec(0.9),
    });

    registerEmbeddingProvider({
      id: "finding3-arm-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "finding3-arm-vec", {
      corpus: "project",
      textWeight: 0.4,
      embeddingWeight: 0.6,
    });
    const byId = new Map(results.map((r) => [r.id, r]));

    // The embedding-arm rank-1 hit's fused rank carries its heavier weight — not
    // a coin flip with the text-arm rank-1 hit.
    expect(fusedRrf(byId.get("embed-hit")!)).toBeCloseTo(0.6 / (RRF_K + 1), 10);
    expect(fusedRrf(byId.get("text-hit")!)).toBeCloseTo(0.4 / (RRF_K + 1), 10);
  });

  test("the title term is added on top of relevance and the fused rank (finding 3)", async () => {
    // Finding 3's ordering hazard: with UNweighted RRF the two single-arm hits
    // fused identically, so the title boost alone decided the order — a
    // tangential lexical hit whose title merely shares a query term could be
    // seated above a genuinely stronger embedding-only answer. The title term is
    // now added at TITLE_BOOST_WEIGHT · ratio, so it moves a hit by at most that.
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Tangential text hit: matches both query terms in the body (text rank 1) and
    // its title carries ONE of them (ratio 0.5), no chunk.
    store.upsertDoc(
      doc({
        id: "tangential-titled",
        projectId: "proj",
        slug: "tangential-titled",
        title: "Widget overview",
        body: "widget rendering widget rendering pipeline subsystem",
      })
    );
    // Stronger embedding answer: absent from the text arm, embedding rank 1, no
    // title match.
    store.upsertDoc(
      doc({
        id: "embed-answer",
        projectId: "proj",
        slug: "embed-answer",
        title: "Notes",
        body: "an unrelated body of assorted topics far from the terms",
      })
    );
    store.upsertChunk({
      id: "embed-answer-c",
      knowledgeId: "embed-answer",
      chunkIndex: 0,
      text: "embed chunk",
      embedding: cosVec(0.9),
    });

    registerEmbeddingProvider({
      id: "finding3-title-vec",
      defaultModel: "m",
      async embed() {
        return queryVec;
      },
    });

    const results = await searchKnowledge(db, "proj", query, "finding3-title-vec", {
      corpus: "project",
      textWeight: 0.4,
      embeddingWeight: 0.6,
    });

    // The title term adds TITLE_BOOST_WEIGHT · 0.5 to the tangential doc's
    // ordering score; it reorders hits that are otherwise close.
    const byId = new Map(results.map((r) => [r.id, r]));
    const t = byId.get("tangential-titled")!;
    const untitled = t.relevance! + RANK_RRF_SHARE * 0.4 + OTHER_PROJECT_PREFERENCE;
    expect(t.score).toBeCloseTo(untitled + TITLE_BOOST_WEIGHT * 0.5, 10);
    expect(results.map((r) => r.id).sort()).toEqual(["embed-answer", "tangential-titled"]);
  });
});

describe("searchKnowledge threads EmbeddingConfig into the query embedding", () => {
  // The query path must embed with the same model/baseUrl/apiKey/region the
  // corpus was indexed with; a divergent config here embeds the query in a
  // different vector space and silently degrades retrieval to FTS-only.
  test("the configured model/baseUrl/apiKey/region reach the provider at query time", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "d1", projectId: "proj", slug: "d1", title: "D1", body: "vector body" })
    );
    store.upsertChunk({
      id: "c1",
      knowledgeId: "d1",
      chunkIndex: 0,
      text: "vector body",
      embedding: [1, 0, 0],
    });

    let seen: EmbeddingConfig | undefined;
    registerEmbeddingProvider({
      id: "config-capture",
      defaultModel: "capture-default",
      async embed(_text, config) {
        seen = config;
        return [1, 0, 0];
      },
    });

    const config: EmbeddingConfig = {
      model: "custom-model",
      apiKey: "custom-key",
      baseUrl: "https://custom.example",
      region: "us-west-2",
    };
    const results = await searchKnowledge(db, "proj", "vector body", "config-capture", {}, config);

    // The configured fields reach the provider. generateEmbedding also supplies
    // a default timeout `signal` when the caller passes none — it bounds the
    // request but is not part of the corpus fingerprint — so assert on the
    // fields rather than deep-equality against the input.
    expect(seen).toMatchObject(config);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(results.some((r) => r.id === "d1")).toBe(true);
  });
});

describe("scoped retrieval — the strict audience gate (global ∪ project ∪ user)", () => {
  // A corpus spanning two projects and two users, every doc sharing the FTS
  // term so recall is decided by the scope gate, not by relevance. Runs FTS-only
  // (null provider) so the result set is deterministic.
  function seed(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "g", projectId: "alpha", slug: "global-doc", title: "Global",
        body: "scopeterm applies everywhere", scope: "global" })
    );
    store.upsertDoc(
      doc({ id: "ap", projectId: "alpha", slug: "alpha-proj", title: "Alpha project",
        body: "scopeterm for alpha", scope: "project" })
    );
    store.upsertDoc(
      doc({ id: "bp", projectId: "beta", slug: "beta-proj", title: "Beta project",
        body: "scopeterm for beta", scope: "project" })
    );
    store.upsertDoc(
      doc({ id: "au", projectId: "alpha", slug: "alice-doc", title: "Alice private",
        body: "scopeterm for alice", scope: "user", ownerUser: "alice" })
    );
    store.upsertDoc(
      doc({ id: "bu", projectId: "beta", slug: "bob-doc", title: "Bob private",
        body: "scopeterm for bob", scope: "user", ownerUser: "bob" })
    );
    return db;
  }

  const ids = (rs: Array<{ id: string }>) => new Set(rs.map((r) => r.id));

  // (a) A user-scoped doc is retrieved for its owner but not another user, and
  // not for a different project's non-owner agent.
  test("a user's doc reaches only that user's agent", async () => {
    const db = seed();

    const forAlice = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "alice" },
    });
    expect(ids(forAlice).has("au")).toBe(true);
    expect(ids(forAlice).has("bu")).toBe(false);

    // Same project, different user — Alice's doc must not leak to Bob.
    const forBobSameProject = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "bob" },
    });
    expect(ids(forBobSameProject).has("au")).toBe(false);

    // A different project's agent (different user) also never sees Alice's doc.
    const forOtherProject = await searchKnowledge(db, "beta", "scopeterm", null, {
      audience: { projectId: "beta", user: "carol" },
    });
    expect(ids(forOtherProject).has("au")).toBe(false);
  });

  // (b) A global doc is retrieved for every project/user combination.
  test("a global doc reaches everyone", async () => {
    const db = seed();
    for (const audience of [
      { projectId: "alpha", user: "alice" },
      { projectId: "beta", user: "bob" },
      { projectId: "beta", user: undefined },
      { projectId: "gamma", user: "dave" },
    ]) {
      const rs = await searchKnowledge(db, audience.projectId, "scopeterm", null, { audience });
      expect(ids(rs).has("g")).toBe(true);
    }
  });

  // (c) A project-scoped doc is retrieved only within its own project under the
  // gate — the regression guard for today's project isolation. Without the gate,
  // cross-project recall is unchanged.
  test("a project doc stays in its project under the gate", async () => {
    const db = seed();

    const gated = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "alice" },
    });
    expect(ids(gated).has("ap")).toBe(true);
    expect(ids(gated).has("bp")).toBe(false);

    // Regression: with no audience, cross-project recall is exactly as before —
    // beta's project doc still surfaces when searching from alpha.
    const ungated = await searchKnowledge(db, "alpha", "scopeterm", null);
    expect(ids(ungated).has("bp")).toBe(true);
  });

  // (d) An unresolved identity (no user) falls back safely to global ∪ project
  // with no cross-user leak.
  test("unresolved identity → global ∪ project only, no user docs leak", async () => {
    const db = seed();
    const rs = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha" },
    });
    const got = ids(rs);
    expect(got.has("g")).toBe(true); // global
    expect(got.has("ap")).toBe(true); // this project
    expect(got.has("bp")).toBe(false); // other project
    expect(got.has("au")).toBe(false); // no user resolved — no user docs
    expect(got.has("bu")).toBe(false);
  });

  // (e) The scope gate is enforced on the EMBEDDING arm too, not just FTS. A
  // gated search routes the embedding candidate pool through the brute-force
  // scan (the vec0 mirror has no scope/owner column, so a KNN gate could only be
  // a post-filter on a fixed top-K that starves in-scope docs); the scan pushes
  // the gate into SQL pre-rank, so the semantic arm returns exactly the
  // in-audience set. Runs on the active in-process path (brute-force under bun's
  // default SQLite), the same path a gated search takes on a vec-enabled host.
  test("the embedding arm respects the scope gate — a gated semantic search returns only in-audience docs", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const cosVec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];

    // Every doc carries a chunk near the query axis so the embedding arm would
    // recall all of them absent the gate; scope is what decides the result set.
    // The out-of-scope docs are given the HIGHER cosine so a starving/post-filter
    // bug would surface them over the in-scope ones.
    const seedEmbedded = (d: Partial<KnowledgeDoc>, cos: number) => {
      store.upsertDoc(doc({ ...d, body: "semantic body", originClass: "owner" }));
      store.upsertChunk({
        id: `${d.id}-c`,
        knowledgeId: d.id!,
        chunkIndex: 0,
        text: "semantic body",
        embedding: cosVec(cos),
      });
    };
    seedEmbedded({ id: "g", projectId: "alpha", slug: "global-doc", title: "Global", scope: "global" }, 0.5);
    seedEmbedded({ id: "ap", projectId: "alpha", slug: "alpha-proj", title: "Alpha", scope: "project" }, 0.5);
    seedEmbedded({ id: "au", projectId: "alpha", slug: "alice-doc", title: "Alice", scope: "user", ownerUser: "alice" }, 0.5);
    // Out-of-scope, higher cosine — must NOT surface for Alice's alpha agent.
    seedEmbedded({ id: "bp", projectId: "beta", slug: "beta-proj", title: "Beta", scope: "project" }, 0.99);
    seedEmbedded({ id: "bu", projectId: "beta", slug: "bob-doc", title: "Bob", scope: "user", ownerUser: "bob" }, 0.99);

    registerEmbeddingProvider({
      id: "scope-embed-fake",
      defaultModel: "m",
      async embed() {
        return [1, 0, 0];
      },
    });

    const forAlice = await searchKnowledge(db, "alpha", "semantic body", "scope-embed-fake", {
      limit: 5,
      audience: { projectId: "alpha", user: "alice" },
    });
    const got = new Set(forAlice.map((r) => r.id));
    expect(got.has("g")).toBe(true); // global
    expect(got.has("ap")).toBe(true); // this project
    expect(got.has("au")).toBe(true); // the requesting user's own
    expect(got.has("bp")).toBe(false); // another project's project doc — gated out despite higher cosine
    expect(got.has("bu")).toBe(false); // another user's user doc — gated out despite higher cosine
  });

  // (f) The owner filter is the permissive browse knob — it must NOT apply the
  // injection gate. Filtering to an owner returns that owner's user docs across
  // every project, regardless of the searching identity.
  test("owner filter returns the owner's docs permissively, without the gate", async () => {
    const db = seed();

    // "My knowledge" for alice — only her user doc.
    const alice = await searchKnowledge(db, "alpha", "scopeterm", null, { owners: ["alice"] });
    expect(alice.map((r) => r.id)).toEqual(["au"]);

    // Filtering to bob from alpha still returns bob's doc that lives in beta —
    // proof the browse path is permissive, not the strict cross-project gate.
    const bob = await searchKnowledge(db, "alpha", "scopeterm", null, { owners: ["bob"] });
    expect(bob.map((r) => r.id)).toEqual(["bu"]);

    // The two knobs compose: gate to alice's audience AND filter to alice.
    const both = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "alice" },
      owners: ["alice"],
    });
    expect(both.map((r) => r.id)).toEqual(["au"]);
  });

  // (g) Defense-in-depth for the reserved GLOBAL corpus: a doc physically homed
  // there reaches every audience even when its `scope` column reads 'project'
  // (the value a legacy backfill or a loader-bypassing write leaves). The loader
  // infers scope='global' for such a doc; this guards the gate when that
  // inference never ran. Restores the pre-scope cross-project visibility of the
  // global KB, which surfaced everywhere under corpus:'all' before the gate.
  test("a doc homed in the GLOBAL corpus reaches every project/user even with scope='project'", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // The pathological row the disjunct defends: homed in the reserved GLOBAL
    // project but stamped scope='project' rather than 'global'.
    store.upsertDoc(
      doc({ id: "gh", projectId: GLOBAL_PROJECT_ID, slug: "global-homed",
        title: "Global homed", body: "scopeterm best practice", scope: "project" })
    );
    // A control: an ordinary project's project doc must still NOT cross into
    // another project's gate, so the disjunct widens ONLY the reserved home.
    store.upsertDoc(
      doc({ id: "bp", projectId: "beta", slug: "beta-proj",
        title: "Beta project", body: "scopeterm for beta", scope: "project" })
    );

    for (const audience of [
      { projectId: "alpha", user: "alice" },
      { projectId: "beta", user: "bob" },
      { projectId: "gamma", user: undefined },
    ]) {
      const rs = await searchKnowledge(db, audience.projectId, "scopeterm", null, { audience });
      const got = new Set(rs.map((r) => r.id));
      expect(got.has("gh")).toBe(true); // the global-homed doc reaches everyone
      if (audience.projectId !== "beta") {
        expect(got.has("bp")).toBe(false); // an ordinary project doc stays put
      }
    }
  });

  // (h) The reserved-home disjunct must NOT swallow scope='user'. A user-scoped
  // doc explicitly homed in the GLOBAL corpus (the loader honors `scope: user`
  // even under knowledge/global/) reaches ONLY its owner — never every user via
  // the `project_id = 'global'` shortcut. The bug this guards: an unconditional
  // global-home disjunct returned Alice's private doc to Bob and to unrelated
  // projects, defeating scope='user' isolation at its exact boundary.
  test("a user-scoped doc homed in the GLOBAL corpus reaches only its owner, not every user/project", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Reachable state: the loader keeps an explicit `scope: user` on a file
    // placed under knowledge/global/, so the row is (scope='user',
    // owner_user='alice', project_id='global').
    store.upsertDoc(
      doc({ id: "gu", projectId: GLOBAL_PROJECT_ID, slug: "alice-secret",
        title: "Alice secret", body: "scopeterm private to alice",
        scope: "user", ownerUser: "alice" })
    );

    // The owner still gets it (via the owner disjunct, not the reserved home).
    const forAlice = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "alice" },
    });
    expect(ids(forAlice).has("gu")).toBe(true);

    // A different user in the same project must NOT see it.
    const forBob = await searchKnowledge(db, "alpha", "scopeterm", null, {
      audience: { projectId: "alpha", user: "bob" },
    });
    expect(ids(forBob).has("gu")).toBe(false);

    // A different project (and different user) must NOT see it either.
    const forOtherProject = await searchKnowledge(db, "beta", "scopeterm", null, {
      audience: { projectId: "beta", user: "carol" },
    });
    expect(ids(forOtherProject).has("gu")).toBe(false);

    // An unresolved identity must NOT see it (no user disjunct, and the
    // reserved-home disjunct now excludes user scope).
    const forNobody = await searchKnowledge(db, "gamma", "scopeterm", null, {
      audience: { projectId: "gamma" },
    });
    expect(ids(forNobody).has("gu")).toBe(false);
  });
});

describe("searchKnowledge — scripts with combining marks and shared docs named by slug", () => {
  test("a Devanagari query whose vowel signs are combining marks still matches its doc", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "hi", slug: "hindi-notes", title: "Notes", body: "यह हिन्दी में लिखा गया दस्तावेज़ है" }));
    store.upsertDoc(doc({ id: "en", slug: "english-notes", title: "Other", body: "an English document about releases" }));
    const results = await searchKnowledge(db, "proj", "हिन्दी", null);
    expect(results.map((r) => r.id)).toContain("hi");
  });

  test("a whole-query slug names a shared doc from another project, but not another project's own doc", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({ id: "g", projectId: "other", slug: "release-train", title: "Cadence", body: "Weekly cadence.", scope: "global" })
    );
    store.upsertDoc(
      doc({ id: "c", projectId: GLOBAL_PROJECT_ID, slug: "oncall-rota", title: "Rota", body: "Who is on call." })
    );
    store.upsertDoc(doc({ id: "p", projectId: "other", slug: "private-plan", title: "Plan", body: "Internal plan." }));
    store.upsertDoc(
      doc({
        id: "local",
        projectId: "proj",
        slug: "release-train-faq",
        title: "Release train release train",
        body: "The release train, release train FAQ, oncall rota and the oncall rota schedule.",
      })
    );
    const audience = { audience: { projectId: "proj" } };
    expect((await searchKnowledge(db, "proj", "release-train", null, audience))[0]?.id).toBe("g");
    expect((await searchKnowledge(db, "proj", "`oncall-rota`", null, audience))[0]?.id).toBe("c");
    expect((await searchKnowledge(db, "proj", "private-plan", null, audience)).map((r) => r.id)).not.toContain("p");
  });
});
