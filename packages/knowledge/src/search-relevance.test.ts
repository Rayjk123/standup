import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore } from "@standup/store";
import { KnowledgeStore } from "./store.js";
import {
  searchKnowledge,
  orderingScore,
  OTHER_PROJECT_PREFERENCE,
  RANK_RRF_SHARE,
  TITLE_BOOST_WEIGHT,
} from "./search.js";
import { registerEmbeddingProvider } from "./embeddings.js";
import { formatContradictsClaim } from "./graph.js";
import { CONFIDENCE_FLOORS } from "./relevance.js";
import type { KnowledgeDoc } from "./types.js";

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "proj",
    slug: overrides.id ?? "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

/** A small corpus of distinct topics, enough docs that idf means something. */
function corpus(): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  const topics = [
    ["retry", "Slack mirror retry policy", "The Slack mirror retries a failed post three times with jittered exponential backoff."],
    ["fts", "FTS orphan rows", "Deleting a doc must delete its FTS row in the same transaction or search serves stale text."],
    ["deploy", "Collector deploy runbook", "Deploy the collector by building, migrating the database, then restarting the service."],
    ["embed", "Embedding provider choice", "Knowledge search embeds with nomic-embed-text through a local Ollama."],
    ["timeout", "Bun fetch timeout", "Bun's fetch has a default 360 second timeout, so outbound webhooks hang for six minutes."],
    ["scope", "Scope audience gate", "Scoped retrieval admits global, project and the requesting user's own docs."],
    ["graph", "Knowledge graph edges", "The graph links docs by shared tags, related fields and semantic similarity."],
    ["persona", "Persona architecture", "Persona is the always-on orchestrator that briefs workers and keeps a handoff note."],
  ];
  for (const [id, title, body] of topics) store.upsertDoc(doc({ id, slug: id, title, body }));
  return db;
}

describe("relevance is absolute, not relative to the batch", () => {
  test("a doc's relevance does not change with the result limit or what else matched", async () => {
    const db = corpus();
    const wide = await searchKnowledge(db, "proj", "slack mirror retry backoff", null, { limit: 8 });
    const narrow = await searchKnowledge(db, "proj", "slack mirror retry backoff", null, { limit: 1 });
    expect(narrow[0].id).toBe("retry");
    expect(narrow[0].relevance).toBeCloseTo(wide.find((r) => r.id === "retry")!.relevance!, 12);
    expect(narrow[0].relevanceSignals).toEqual(wide.find((r) => r.id === "retry")!.relevanceSignals);
  });

  test("an off-topic question's best lexical hit is not confident, though its batch-normalized rawScore is high", async () => {
    const db = corpus();
    const results = await searchKnowledge(db, "proj", "should I retry a failed sourdough rise with more yeast", null, {
      limit: 5,
    });
    // The retry doc is the best lexical match and the batch normalization puts
    // its rawScore at the text weight...
    expect(results[0].id).toBe("retry");
    expect(results[0].rawScore!).toBeGreaterThanOrEqual(0.4);
    // ...but it covers a fraction of the question, so it is not a confident match.
    expect(results[0].relevance!).toBeLessThan(CONFIDENCE_FLOORS.search);
    const gated = await searchKnowledge(db, "proj", "should I retry a failed sourdough rise with more yeast", null, {
      limit: 5,
      confidentFor: "search",
    });
    expect(gated).toEqual([]);
  });

  test("confidentFor gates before the limit, and lowConfidenceLimit appends the best weak hits after", async () => {
    const db = corpus();
    const q = "how long is the bun fetch timeout for outbound webhooks";
    const gated = await searchKnowledge(db, "proj", q, null, { limit: 3, confidentFor: "search", lowConfidenceLimit: 2 });
    expect(gated[0].id).toBe("timeout");
    const firstWeak = gated.findIndex((r) => r.relevance! < CONFIDENCE_FLOORS.search);
    // Every confident hit precedes every weak one, and at most two weak ones ride along.
    expect(gated.slice(0, firstWeak === -1 ? gated.length : firstWeak).every((r) => r.relevance! >= CONFIDENCE_FLOORS.search)).toBe(true);
    expect(gated.filter((r) => r.relevance! < CONFIDENCE_FLOORS.search).length).toBeLessThanOrEqual(2);
  });
});

describe("the order and the score agree", () => {
  test("results are sorted by `score`, which is the ordering score", async () => {
    const db = corpus();
    const results = await searchKnowledge(db, "proj", "knowledge search retrieval docs", null, { limit: 8 });
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("orderingScore adds the weighted fused rank, title match and local bonus to relevance", () => {
    const parts = { rrf: 0.5 / 61, rrfCeiling: 1 / 61, relevance: 0.6, chunks: 2, titleMatch: 0.5, trust: 1 };
    const foreign = orderingScore({ ...parts, local: false });
    expect(foreign).toBeCloseTo(0.6 + RANK_RRF_SHARE * 0.5 + TITLE_BOOST_WEIGHT * 0.5, 10);
    expect(orderingScore({ ...parts, local: true })).toBeCloseTo(foreign + OTHER_PROJECT_PREFERENCE, 10);
  });

  test("trust scales the evidence terms; the local bonus is added outside it", () => {
    const parts = { rrf: 1 / 61, rrfCeiling: 1 / 61, relevance: 0.5, chunks: 2, titleMatch: 1, local: true };
    const evidence = 0.5 + RANK_RRF_SHARE + TITLE_BOOST_WEIGHT;
    expect(orderingScore({ ...parts, trust: 0.5 })).toBeCloseTo(0.5 * evidence + OTHER_PROJECT_PREFERENCE, 10);
  });

  test("per-call weights replace the resolved ones", () => {
    const parts = { rrf: 1 / 61, rrfCeiling: 1 / 61, relevance: 0.4, chunks: 2, titleMatch: 1, local: true, trust: 1 };
    expect(orderingScore(parts, { rrf: 0, title: 0, local: 0 })).toBeCloseTo(0.4, 10);
    expect(orderingScore(parts, { rrf: 0.2, title: 0.1, local: 0.05 })).toBeCloseTo(0.75, 10);
  });
});

describe("boosts do not override a clear relevance gap", () => {
  // Shapes from the knowledge eval's failure analysis, scored with the same
  // fused rank for every doc so only relevance, title and project differ.
  const base = { rrf: 0.6 / 61, rrfCeiling: 1 / 61, chunks: 2, trust: 1 };

  test("a 0.70-relevance doc in another project leads a 0.51 local doc (X01)", () => {
    const foreign = orderingScore({ ...base, relevance: 0.7, titleMatch: 0, local: false });
    const local = orderingScore({ ...base, relevance: 0.51, titleMatch: 0, local: true });
    expect(foreign).toBeGreaterThan(local);
    // A near-tie still goes local.
    const nearTie = orderingScore({ ...base, relevance: 0.52, titleMatch: 0, local: false });
    expect(orderingScore({ ...base, relevance: 0.5, titleMatch: 0, local: true })).toBeGreaterThan(nearTie);
  });

  test("the most relevant of five docs is not held at #5 behind title-matched ones (P10)", () => {
    const docs = [
      { id: "answer", relevance: 0.34, titleMatch: 0 },
      { id: "restarts", relevance: 0.23, titleMatch: 0.5 },
      { id: "titled-b", relevance: 0.26, titleMatch: 0.5 },
      { id: "titled-c", relevance: 0.27, titleMatch: 0.5 },
      { id: "titled-d", relevance: 0.28, titleMatch: 0.5 },
    ];
    const ranked = docs
      .map((d) => ({ id: d.id, score: orderingScore({ ...base, ...d, local: true }) }))
      .sort((a, b) => b.score - a.score)
      .map((d) => d.id);
    expect(ranked[0]).toBe("answer");
  });
});

describe("a strong cross-project answer beats weak local docs (magnitude-aware project preference)", () => {
  test("the Bun fetch timeout doc from another project leads three weak local docs that mention timeouts", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    const q = [1, 0, 0];
    const vec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0];
    store.upsertDoc(
      doc({
        id: "bun",
        projectId: "standup",
        slug: "bun-fetch-default-360s-timeout",
        title: "Bun fetch default 360s timeout",
        body: "Bun fetch has a default 360s timeout; set an AbortSignal timeout on every outbound fetch.",
      })
    );
    store.upsertChunk({ id: "bun-c", knowledgeId: "bun", chunkIndex: 0, text: "bun fetch timeout", embedding: vec(0.9) });
    for (let i = 0; i < 3; i++) {
      store.upsertDoc(
        doc({
          id: `local-${i}`,
          projectId: "tidepool",
          slug: `local-${i}`,
          title: `Predictions API notes ${i}`,
          body: `The predictions API ${i} has a client timeout on paged responses among other settings.`,
        })
      );
      store.upsertChunk({ id: `local-${i}-c`, knowledgeId: `local-${i}`, chunkIndex: 0, text: "timeout", embedding: vec(0.55) });
    }
    for (let i = 0; i < 6; i++) {
      store.upsertDoc(doc({ id: `filler-${i}`, projectId: "tidepool", slug: `filler-${i}`, body: `unrelated topic ${i}` }));
    }
    registerEmbeddingProvider({ id: "bun-xproj-vec", defaultModel: "m", embed: async () => q });

    const results = await searchKnowledge(db, "tidepool", "Bun fetch 360s timeout", "bun-xproj-vec", { limit: 5 });
    expect(results[0].id).toBe("bun");
    expect(results[0].relevance!).toBeGreaterThan(results[1].relevance! * 1.5);
  });
});

describe("trust inputs in ranking", () => {
  function contradictedPair(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(
      doc({
        id: "old",
        slug: "always-on-orchestrator",
        title: "Persona orchestrator plan",
        body: "The persona orchestrator work is uncommitted and not merged.",
        generatedAt: "2026-09-29T09:00:00Z",
      })
    );
    store.upsertDoc(
      doc({
        id: "new",
        slug: "persona-architecture",
        title: "Persona orchestrator architecture",
        body: "The persona orchestrator work was merged in commit 834956f.",
        generatedAt: "2026-10-04T09:00:00Z",
      })
    );
    store.upsertDoc(doc({ id: "retired", slug: "persona-v0", title: "Persona orchestrator v0", body: "The persona orchestrator v0 plan.", }));
    for (let i = 0; i < 6; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `filler topic number ${i}` }));
    const dispute = (other: string) => [{ claim: formatContradictsClaim(other), finding: "", evidence: "" }];
    store.setDocVerdict("proj", "always-on-orchestrator", "contradicted", dispute("persona-architecture"));
    store.setDocVerdict("proj", "persona-architecture", "contradicted", dispute("always-on-orchestrator"));
    store.setDocVerdict("proj", "persona-v0", "superseded", []);
    return db;
  }

  test("each side of a contradiction knows its counterpart, and the older side is the losing one", async () => {
    const results = await searchKnowledge(contradictedPair(), "proj", "persona orchestrator merged", null, { limit: 5 });
    const old = results.find((r) => r.id === "old")!;
    const fresh = results.find((r) => r.id === "new")!;
    expect(old.contradiction).toEqual({ side: "losing", counterparts: ["proj/persona-architecture"] });
    expect(fresh.contradiction).toEqual({ side: "winning", counterparts: ["proj/always-on-orchestrator"] });
    expect(results.findIndex((r) => r.id === "new")).toBeLessThan(results.findIndex((r) => r.id === "old"));
  });

  test("a superseded doc is excluded from a gated search and kept for an ungated one", async () => {
    const db = contradictedPair();
    const gated = await searchKnowledge(db, "proj", "persona orchestrator v0 plan", null, {
      limit: 5,
      audience: { projectId: "proj" },
    });
    expect(gated.map((r) => r.id)).not.toContain("retired");
    const ungated = await searchKnowledge(db, "proj", "persona orchestrator v0 plan", null, { limit: 5 });
    expect(ungated.map((r) => r.id)).toContain("retired");
    const asked = await searchKnowledge(db, "proj", "persona orchestrator v0 plan", null, {
      limit: 5,
      audience: { projectId: "proj" },
      includeSuperseded: true,
    });
    expect(asked.map((r) => r.id)).toContain("retired");
  });

  test("results carry scope and layer", async () => {
    const results = await searchKnowledge(contradictedPair(), "proj", "persona orchestrator", null, { limit: 2 });
    expect(results[0].scope).toBe("project");
    expect(results[0].layer).toBe("docs");
  });
});

describe("terms in most docs carry no lexical evidence", () => {
  function common(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (let i = 0; i < 8; i++) {
      store.upsertDoc(doc({ id: `a${i}`, slug: `a${i}`, title: `Agent note ${i}`, body: `the agent does task ${i} with the runner` }));
    }
    store.upsertDoc(doc({ id: "timeout", slug: "timeout", title: "Fetch timeout", body: "the fetch timeout is 360 seconds" }));
    store.upsertDoc(doc({ id: "other", slug: "other", title: "Other", body: "the scope gate admits global docs" }));
    // Enough docs for idf to mean something (see SMALL_INDEX_DOCS); "agent" is
    // still in more than half of them.
    for (let i = 0; i < 6; i++) {
      store.upsertDoc(doc({ id: `agent-extra-${i}`, slug: `agent-extra-${i}`, body: `the agent handles batch ${i}` }));
    }
    for (let i = 0; i < 6; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `the office note ${i}` }));
    return db;
  }

  test("a stopword-only query has no terms and nothing is confident", async () => {
    const db = common();
    const results = await searchKnowledge(db, "proj", "the", null, { limit: 5 });
    expect(results.every((r) => r.relevanceSignals!.text === 0 && r.relevanceSignals!.queryTerms === 0)).toBe(true);
    expect(await searchKnowledge(db, "proj", "the", null, { limit: 5, confidentFor: "search" })).toEqual([]);
  });

  test("a query of only the corpus's common words has no bm25 share; without embeddings coverage stands in", async () => {
    const results = await searchKnowledge(common(), "proj", "what does the agent do", null, { limit: 5 });
    const agent = results.find((r) => r.id.startsWith("a"))!;
    expect(agent.relevanceSignals!.text).toBe(0);
    expect(agent.relevanceSignals!.informativeTerms).toBe(0);
    expect(agent.relevanceSignals!.coverage).toBe(1);
    // Half weight: a doc only reaches the floor by containing the whole query.
    expect(agent.relevance!).toBeCloseTo(0.5, 10);
  });

  test("an informative term in the same query still counts", async () => {
    const results = await searchKnowledge(common(), "proj", "what is the fetch timeout", null, {
      limit: 5,
      confidentFor: "search",
    });
    expect(results[0].id).toBe("timeout");
    expect(results[0].relevanceSignals!.queryTerms).toBe(2);
  });
});

describe("a query that is a doc's full title names it", () => {
  test("a long canonical doc found by its exact title leads despite the length prior", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "mega", slug: "product-gap-analysis", title: "Product gap analysis", body: "gap analysis ".repeat(50) }));
    for (let c = 0; c < 400; c++) {
      store.upsertChunk({ id: `mega-${c}`, knowledgeId: "mega", chunkIndex: c, text: "gap", embedding: [1, 0] });
    }
    for (let i = 0; i < 4; i++) {
      store.upsertDoc(doc({ id: `n${i}`, slug: `n${i}`, title: `Product gap note ${i}`, body: "product gap analysis notes" }));
    }
    for (let i = 0; i < 6; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `unrelated ${i}` }));
    const results = await searchKnowledge(db, "proj", "Product gap analysis", null, { limit: 5 });
    expect(results[0].id).toBe("mega");
    expect(results[0].relevanceSignals!.named).toBe(true);
    // Case and punctuation do not matter.
    const loose = await searchKnowledge(db, "proj", "product-gap analysis!", null, { limit: 5 });
    expect(loose[0].id).toBe("mega");
  });
});

describe("a forgotten (superseded-tagged) memory is left out before the result cap", () => {
  test("a gated search never spends a result slot on it", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "old", slug: "persona-x-reply-length", tags: ["superseded"], body: "replies stay under 150 words" }));
    store.upsertDoc(doc({ id: "new", slug: "persona-x-reply-length-v2", body: "replies stay under 200 words" }));
    for (let i = 0; i < 6; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `unrelated ${i}` }));
    const gated = await searchKnowledge(db, "proj", "replies words", null, { limit: 1, audience: { projectId: "proj" } });
    expect(gated.map((r) => r.id)).toEqual(["new"]);
    const browse = await searchKnowledge(db, "proj", "replies words", null, { limit: 5 });
    expect(browse.map((r) => r.id)).toContain("old");
  });
});

describe("a focused corpus answers questions about its own subject", () => {
  // Every doc is about the frost watch, so "frost" and "watch" are in
  // all of them: bm25 cannot score them and the semantic term must carry the
  // match. Toy vectors: each doc's chunk sits at its own angle; a query sits
  // next to the doc it is about, an off-topic question far from all of them.
  const topics = [
    "probe readings",
    "engine cranking",
    "night rosters",
    "buffer retention",
    "audit trail",
    "controller pairing",
    "start thresholds",
    "radio coverage",
  ];
  const at = (angle: number) => [Math.cos(angle), Math.sin(angle), 0];
  const angleOf = (i: number) => (i * Math.PI) / (topics.length * 2);
  function focused(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    for (let i = 0; i < 24; i++) {
      const t = i % topics.length;
      store.upsertDoc(
        doc({
          id: `fw-${i}`,
          slug: `fw-${i}`,
          title: `Frost watch ${topics[t]} ${i}`,
          body: `The frost watch handles ${topics[t]} for each block (${i}).`,
        })
      );
      store.upsertChunk({ id: `fw-${i}-c`, knowledgeId: `fw-${i}`, chunkIndex: 0, text: topics[t], embedding: at(angleOf(t) + i * 0.0001) });
    }
    return db;
  }
  const queries: Record<string, number[]> = {
    "how does the frost watch work": at(angleOf(0) + 0.35),
    frost: at(angleOf(0) + 0.4),
    "how do I bake sourdough bread": [0, 0.1, 1],
  };
  registerEmbeddingProvider({ id: "focused-vec", defaultModel: "m", embed: async (text: string) => queries[text] ?? [0, 0, 1] });

  test("its subject-only questions are confident, an off-topic question is not", async () => {
    const db = focused();
    for (const q of ["how does the frost watch work", "frost"]) {
      const results = await searchKnowledge(db, "proj", q, "focused-vec", { limit: 5, confidentFor: "search" });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].relevanceSignals!.informativeTerms).toBe(0);
      expect(results[0].relevance!).toBeGreaterThanOrEqual(CONFIDENCE_FLOORS.inject);
    }
    const off = await searchKnowledge(db, "proj", "how do I bake sourdough bread", "focused-vec", {
      limit: 5,
      confidentFor: "search",
    });
    expect(off).toEqual([]);
  });

  test("without embeddings, the subject's docs are confident by containing the whole query", async () => {
    const results = await searchKnowledge(focused(), "proj", "how does the frost watch work", null, {
      limit: 5,
      confidentFor: "inject",
    });
    expect(results.length).toBe(5);
    const off = await searchKnowledge(focused(), "proj", "how do I bake sourdough bread", null, {
      limit: 5,
      confidentFor: "search",
    });
    expect(off).toEqual([]);
  });
});

describe("title naming edge cases", () => {
  function titled(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "gap", slug: "product-gap-analysis", title: "Product gap analysis — October review", body: "gap analysis" }));
    store.upsertDoc(doc({ id: "err", projectId: "other", slug: "error-source", title: "Error source", body: "where errors come from" }));
    store.upsertDoc(doc({ id: "uml", slug: "umlaut", title: "Übersicht Ärger", body: "übersicht" }));
    for (let i = 0; i < 8; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `filler note ${i}` }));
    return db;
  }

  test("the first three or more words of a title name the doc", async () => {
    const r = await searchKnowledge(titled(), "proj", "Product gap analysis", null, { limit: 3 });
    expect(r[0].id).toBe("gap");
    expect(r[0].relevanceSignals!.named).toBe(true);
    // Two words are not enough.
    const two = await searchKnowledge(titled(), "proj", "Product gap", null, { limit: 3 });
    expect(two.find((h) => h.id === "gap")?.relevanceSignals?.named).toBeUndefined();
  });

  test("a common-phrase title in another project does not name its doc without semantic support", async () => {
    const r = await searchKnowledge(titled(), "proj", "error source", null, { limit: 3 });
    expect(r.find((h) => h.id === "err")?.relevanceSignals?.named).toBeUndefined();
  });

  test("titles match case-insensitively in any script", async () => {
    const r = await searchKnowledge(titled(), "proj", "ÜBERSICHT ärger", null, { limit: 3 });
    expect(r[0].id).toBe("uml");
    expect(r[0].relevanceSignals!.named).toBe(true);
  });
});

describe("query embeddings", () => {
  test("a caller's abort-signalled request is never shared", async () => {
    let calls = 0;
    registerEmbeddingProvider({
      id: "signal-vec",
      defaultModel: "m",
      embed: async () => {
        calls++;
        return [1, 0];
      },
    });
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", slug: "a", body: "alpha" }));
    store.upsertChunk({ id: "a-c", knowledgeId: "a", chunkIndex: 0, text: "alpha", embedding: [1, 0] });
    await searchKnowledge(db, "proj", "alpha signal", "signal-vec", {}, {});
    await searchKnowledge(db, "proj", "alpha signal", "signal-vec", {}, {});
    expect(calls).toBe(1);
    await searchKnowledge(db, "proj", "alpha signal", "signal-vec", {}, { signal: new AbortController().signal });
    expect(calls).toBe(2);
  });
});

describe("contradiction sides read content dates, not file mtimes", () => {
  test("a doc touched today but indexed long ago is the older side", async () => {
    const store = createStore(":memory:");
    const k = new KnowledgeStore(store.db);
    // The plan was indexed in August, the architecture in October...
    k.upsertDoc(doc({ id: "old", slug: "old-plan", title: "Orchestrator plan", body: "the orchestrator is uncommitted", updatedAt: new Date("2026-08-01T09:00:00Z") }));
    k.upsertDoc(doc({ id: "new", slug: "new-arch", title: "Orchestrator architecture", body: "the orchestrator was merged", updatedAt: new Date("2026-10-04T09:00:00Z") }));
    // ...then a checkout touched both files today without changing either body.
    k.upsertDoc(doc({ id: "old", slug: "old-plan", title: "Orchestrator plan", body: "the orchestrator is uncommitted", updatedAt: new Date("2026-10-04T10:00:00Z") }));
    k.upsertDoc(doc({ id: "new", slug: "new-arch", title: "Orchestrator architecture", body: "the orchestrator was merged", updatedAt: new Date("2026-10-04T10:05:00Z") }));
    for (let i = 0; i < 6; i++) k.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `filler ${i}` }));
    const dispute = (other: string) => [{ claim: formatContradictsClaim(other), finding: "", evidence: "" }];
    k.setDocVerdict("proj", "old-plan", "contradicted", dispute("new-arch"));
    k.setDocVerdict("proj", "new-arch", "contradicted", dispute("old-plan"));
    const r = await searchKnowledge(store.db, "proj", "orchestrator merged uncommitted", null, { limit: 5 });
    expect(r.find((h) => h.id === "old")!.contradiction!.side).toBe("losing");
    expect(r.find((h) => h.id === "new")!.contradiction!.side).toBe("winning");
  });

  test("without the index's content clock, the knowledge log dates the content", async () => {
    const store = createStore(":memory:");
    const k = new KnowledgeStore(store.db);
    // Both docs carry today's mtime (a checkout touched them)...
    k.upsertDoc(doc({ id: "old", slug: "old-plan", title: "Orchestrator plan", body: "the orchestrator is uncommitted", updatedAt: new Date("2026-10-04T10:00:00Z") }));
    k.upsertDoc(doc({ id: "new", slug: "new-arch", title: "Orchestrator architecture", body: "the orchestrator was merged", updatedAt: new Date("2026-10-04T10:05:00Z") }));
    for (let i = 0; i < 6; i++) k.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `filler ${i}` }));
    store.db.run("UPDATE knowledge SET content_first_seen = NULL");
    // ...but the knowledge log saw the plan accepted in August, the architecture in October.
    const log = store.db.query("INSERT INTO knowledge_changes (id, project_id, slug, kind, title, created_at) VALUES (?, 'proj', ?, 'accepted', ?, ?)");
    log.run("c1", "old-plan", "Orchestrator plan", "2026-08-01 09:00:00");
    log.run("c2", "new-arch", "Orchestrator architecture", "2026-10-04 09:00:00");
    const dispute = (other: string) => [{ claim: formatContradictsClaim(other), finding: "", evidence: "" }];
    k.setDocVerdict("proj", "old-plan", "contradicted", dispute("new-arch"));
    k.setDocVerdict("proj", "new-arch", "contradicted", dispute("old-plan"));
    const r = await searchKnowledge(store.db, "proj", "orchestrator merged uncommitted", null, { limit: 5 });
    expect(r.find((h) => h.id === "old")!.contradiction!.side).toBe("losing");
    expect(r.find((h) => h.id === "new")!.contradiction!.side).toBe("winning");
  });
});

describe("content_first_seen", () => {
  test("where the index records it, it dates the content for a contradiction", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "old", slug: "old-plan", body: "the orchestrator is uncommitted", updatedAt: new Date("2026-10-04T10:00:00Z") }));
    store.upsertDoc(doc({ id: "new", slug: "new-arch", body: "the orchestrator was merged", updatedAt: new Date("2026-10-04T10:05:00Z") }));
    for (let i = 0; i < 6; i++) store.upsertDoc(doc({ id: `f${i}`, slug: `f${i}`, body: `filler ${i}` }));
    db.run("UPDATE knowledge SET content_first_seen = '2026-08-01T00:00:00Z' WHERE slug = 'old-plan'");
    db.run("UPDATE knowledge SET content_first_seen = '2026-10-01T00:00:00Z' WHERE slug = 'new-arch'");
    const dispute = (other: string) => [{ claim: formatContradictsClaim(other), finding: "", evidence: "" }];
    store.setDocVerdict("proj", "old-plan", "contradicted", dispute("new-arch"));
    store.setDocVerdict("proj", "new-arch", "contradicted", dispute("old-plan"));
    const r = await searchKnowledge(db, "proj", "orchestrator merged uncommitted", null, { limit: 5 });
    expect(r.find((h) => h.id === "old")!.contradiction!.side).toBe("losing");
    expect(r.find((h) => h.id === "new")!.contradiction!.side).toBe("winning");
  });
});
