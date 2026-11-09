import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import { searchKnowledge, type SearchOptions } from "./search.js";
import {
  collapseDuplicateHits,
  contentOverlap,
  contentTokens,
  isDuplicatePair,
  prefersChallenger,
  docAudience,
  docText,
  type DocText,
  type DuplicateCandidate,
  type MirrorProjects,
} from "./duplicate-hits.js";
import type { KnowledgeDoc } from "./types.js";

const MIRRORS: MirrorProjects = { "standup-self": "standup" };

function doc(overrides: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: "standup",
    slug: overrides.id ?? "doc",
    title: "Doc",
    body: "body",
    updatedAt: new Date("2026-08-16T00:00:00Z"),
    filePath: "/x/doc.md",
    originClass: "owner",
    ...overrides,
  };
}

const CHUNKING = {
  title: "Knowledge chunking strategy",
  body: "The chunker splits a doc body into pieces of about 512 characters; neighbouring chunks overlap by ten words.",
};

/** Filler docs so the text arm's idf means something. */
function filler(store: KnowledgeStore, projectId: string): void {
  const topics = [
    "the collector deploy runbook restarts the service",
    "the slack mirror retries a failed post with backoff",
    "the scope gate admits global and project docs",
    "the session interrupt stops the current turn",
    "the reply idempotency key prevents duplicate replies",
    "the fts index keeps one row per doc",
  ];
  topics.forEach((body, i) => store.upsertDoc(doc({ id: `${projectId}-f${i}`, projectId, slug: `f${i}`, title: `Filler ${i}`, body })));
}

/** A canonical `standup` doc and its byte copy in the `standup-self` mirror. */
function mirroredPair(copyScope: "project" | "global" = "project"): Database {
  const db = new Database(":memory:");
  const store = new KnowledgeStore(db);
  store.upsertDoc(doc({ id: "canon", slug: "chunking-strategy", ...CHUNKING, scope: copyScope }));
  store.upsertDoc(
    doc({
      id: "copy",
      projectId: "standup-self",
      slug: "chunking-strategy",
      ...CHUNKING,
      scope: copyScope,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    })
  );
  filler(store, "standup");
  return db;
}

const QUERY = "how big are the chunks and how much do neighbouring chunks overlap";
const agent = (projectId: string, extra: SearchOptions = {}): SearchOptions => ({
  audience: { projectId },
  confidentFor: "search",
  lowConfidenceLimit: 10,
  limit: 10,
  ...extra,
});

describe("mirror projects are an alias of their canonical project", () => {
  test("a mirrored pair returns one hit, the canonical doc", async () => {
    const db = mirroredPair("global");
    const without = await searchKnowledge(db, "standup", QUERY, null, agent("standup"));
    expect(without.filter((r) => r.slug === "chunking-strategy").map((r) => r.projectId).sort()).toEqual([
      "standup",
      "standup-self",
    ]);
    const withMirrors = await searchKnowledge(db, "standup", QUERY, null, agent("standup", { mirrorProjects: MIRRORS }));
    const hits = withMirrors.filter((r) => r.slug === "chunking-strategy");
    expect(hits.map((r) => r.id)).toEqual(["canon"]);
  });

  test("the canonical doc is kept even where the mirror copy ranks first", async () => {
    const db = mirroredPair("global");
    const results = await searchKnowledge(db, "standup-self", QUERY, null, {
      ...agent("standup-self"),
      mirrorProjects: MIRRORS,
    });
    expect(results.filter((r) => r.slug === "chunking-strategy").map((r) => r.id)).toEqual(["canon"]);
  });

  test("a search from the mirror admits the canonical project's project-scoped docs", async () => {
    const db = mirroredPair("project");
    const gated = await searchKnowledge(db, "standup-self", QUERY, null, agent("standup-self"));
    expect(gated.filter((r) => r.slug === "chunking-strategy").map((r) => r.id)).toEqual(["copy"]);
    const aliased = await searchKnowledge(db, "standup-self", QUERY, null, {
      ...agent("standup-self"),
      mirrorProjects: MIRRORS,
    });
    expect(aliased.filter((r) => r.slug === "chunking-strategy").map((r) => r.id)).toEqual(["canon"]);
    // The canonical project's own audience is not widened by the mirror.
    const canonical = await searchKnowledge(db, "standup", QUERY, null, agent("standup", { mirrorProjects: MIRRORS }));
    expect(canonical.some((r) => r.projectId === "standup-self")).toBe(false);
  });

  test("a stale mirror copy of the same slug collapses onto the live doc", async () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "live", slug: "retry", title: "Slack retry", body: "Slack posts retry five times with jitter.", scope: "global" }));
    store.upsertDoc(
      doc({ id: "stale", projectId: "standup-self", slug: "retry", title: "Slack retry", body: "Slack posts retry three times.", scope: "global" })
    );
    filler(store, "standup");
    const results = await searchKnowledge(db, "standup", "how many times do slack posts retry", null, {
      ...agent("standup"),
      mirrorProjects: MIRRORS,
    });
    expect(results.filter((r) => r.slug === "retry").map((r) => r.id)).toEqual(["live"]);
  });

  test("the browse audience collapses mirror pairs too", async () => {
    const db = mirroredPair("project");
    const results = await searchKnowledge(db, "standup", QUERY, null, {
      audience: { projectId: "standup", browse: true },
      mirrorProjects: MIRRORS,
      limit: 10,
    });
    expect(results.filter((r) => r.slug === "chunking-strategy").map((r) => r.id)).toEqual(["canon"]);
  });
});

describe("near-identical hits within one project collapse on the agent surfaces", () => {
  function nearCopies(): Database {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "agent-copy", slug: "chunking-notes", ...CHUNKING, originClass: "agent" }));
    store.upsertDoc(doc({ id: "owner-doc", slug: "chunking-strategy", ...CHUNKING, body: `${CHUNKING.body}\n` }));
    store.upsertDoc(
      doc({
        id: "sibling",
        slug: "embedding-model",
        title: "Embedding model choice",
        body: "Chunks are embedded with nomic-embed-text; the overlap between neighbouring chunks is not configurable.",
      })
    );
    filler(store, "standup");
    return db;
  }

  test("one result per content, the higher-trust copy kept; a distinct doc on the subject stays", async () => {
    const results = await searchKnowledge(nearCopies(), "standup", QUERY, null, agent("standup"));
    const ids = results.map((r) => r.id);
    expect(ids).toContain("owner-doc");
    expect(ids).not.toContain("agent-copy");
    expect(ids).toContain("sibling");
  });

  test("a curation search (no confidence floor) still sees every copy", async () => {
    const results = await searchKnowledge(nearCopies(), "standup", QUERY, null, {
      audience: { projectId: "standup" },
      limit: 10,
    });
    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["owner-doc", "agent-copy"]));
  });

  test("collapseDuplicates overrides the default either way", async () => {
    const off = await searchKnowledge(nearCopies(), "standup", QUERY, null, agent("standup", { collapseDuplicates: false }));
    expect(off.map((r) => r.id)).toEqual(expect.arrayContaining(["owner-doc", "agent-copy"]));
    const on = await searchKnowledge(nearCopies(), "standup", QUERY, null, {
      audience: { projectId: "standup" },
      limit: 10,
      collapseDuplicates: true,
    });
    expect(on.map((r) => r.id)).not.toContain("agent-copy");
  });

  test("a doc the query names by slug is never collapsed", async () => {
    const results = await searchKnowledge(nearCopies(), "standup", "`chunking-notes`", null, agent("standup"));
    expect(results[0]?.id).toBe("agent-copy");
  });
});

describe("superseded docs never reach an agent surface", () => {
  function withRetiredCopy(): Database {
    const db = mirroredPair("global");
    new KnowledgeStore(db).setDocVerdict("standup-self", "chunking-strategy", "superseded", [
      { claim: "Superseded by standup/chunking-strategy", finding: "", evidence: "" },
    ]);
    return db;
  }

  const cases: Array<[string, SearchOptions, boolean]> = [
    ["agent search, corpus all", agent("standup", { corpus: "all" }), false],
    ["agent search, corpus project", agent("standup", { corpus: "project" }), false],
    ["floor-gated search with no audience", { confidentFor: "inject", lowConfidenceLimit: 10, limit: 10 }, false],
    ["browse audience", { audience: { projectId: "standup", browse: true }, limit: 10 }, false],
    ["browse audience, opted in", { audience: { projectId: "standup", browse: true }, limit: 10, includeSuperseded: true }, true],
    ["ungated curation search", { limit: 10 }, true],
  ];
  for (const [name, options, shown] of cases) {
    test(`${name}: superseded copy ${shown ? "shown" : "withheld"}`, async () => {
      const results = await searchKnowledge(withRetiredCopy(), "standup", QUERY, null, options);
      expect(results.some((r) => r.id === "copy")).toBe(shown);
      expect(results.some((r) => r.id === "canon")).toBe(true);
    });
  }
});

describe("collapseDuplicateHits", () => {
  const hit = (overrides: Partial<DuplicateCandidate>): DuplicateCandidate => ({
    id: "x",
    projectId: "p",
    slug: "x",
    score: 1,
    originClass: "owner",
    ...overrides,
  });

  test("keeper order: canonical, verdict, origin, confidence, newer, then rank", () => {
    const table: Array<[string, Partial<DuplicateCandidate>, Partial<DuplicateCandidate>, boolean]> = [
      ["canonical over mirror", { projectId: "standup-self" }, { projectId: "standup" }, true],
      ["mirror never over canonical", { projectId: "standup" }, { projectId: "standup-self", verdict: "clean" }, false],
      ["clean over disputed", { verdict: "disputed" }, {}, true],
      ["contradicted under clean", {}, { verdict: "contradicted" }, false],
      ["owner over agent", { originClass: "agent" }, { originClass: "owner" }, true],
      ["higher confidence", { confidence: 0.5 }, { confidence: 0.9 }, true],
      ["newer", { writtenAt: "2026-01-01" }, { writtenAt: "2026-06-01" }, true],
      ["full tie keeps the higher-ranked", {}, {}, false],
    ];
    for (const [name, incumbent, challenger, expected] of table) {
      expect(prefersChallenger(hit({ id: "a", ...incumbent }), hit({ id: "b", ...challenger }), MIRRORS), name).toBe(expected);
    }
  });

  test("duplicate pairs", () => {
    const same = docText("T", "alpha beta gamma delta epsilon");
    const reworded = docText("T", "alpha beta gamma delta zeta");
    const team = docText("T", "alpha beta gamma delta epsilon", docAudience("project", null));
    const global = docText("T", "alpha beta gamma delta epsilon", docAudience("global", null));
    const alice = docText("T", "alpha beta gamma delta epsilon", docAudience("user", "alice"));
    const bob = docText("T", "alpha beta gamma delta epsilon", docAudience("user", "bob"));
    const table: Array<[string, Partial<DuplicateCandidate>, Partial<DuplicateCandidate>, DocText | undefined, DocText | undefined, boolean]> = [
      ["mirror, same slug, different text", { projectId: "standup-self" }, { projectId: "standup" }, same, reworded, true],
      ["mirror, same slug, no text", { projectId: "standup-self" }, { projectId: "standup" }, undefined, undefined, true],
      ["same project, same body", { slug: "a" }, { slug: "b" }, same, same, true],
      ["same project, one word apart", { slug: "a" }, { slug: "b" }, same, reworded, false],
      ["other project, same body", { projectId: "p" }, { projectId: "q" }, same, same, false],
      ["mirror, other slug, lexical near-dup", { projectId: "standup-self", slug: "a" }, { projectId: "standup", slug: "b" }, same, reworded, true],
      ["same project, same body, both team docs", { slug: "a" }, { slug: "b" }, team, team, true],
      ["same project, same body, personal against team", { slug: "a" }, { slug: "b" }, alice, team, false],
      ["same project, same body, global against team", { slug: "a" }, { slug: "b" }, global, team, true],
      ["same project, same body, two users' personal docs", { slug: "a" }, { slug: "b" }, alice, bob, false],
      ["same project, same body, one user's personal docs", { slug: "a" }, { slug: "b" }, alice, alice, true],
    ];
    for (const [name, a, b, ta, tb, expected] of table) {
      expect(isDuplicatePair(hit({ id: "a", ...a }), hit({ id: "b", ...b }), ta, tb, MIRRORS), name).toBe(expected);
    }
  });

  test("the kept hit takes the earlier slot and the higher score", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "m", projectId: "standup-self", slug: "s", body: "same body" }));
    store.upsertDoc(doc({ id: "c", projectId: "standup", slug: "s", body: "same body" }));
    store.upsertDoc(doc({ id: "o", projectId: "standup", slug: "o", body: "another subject entirely" }));
    const out = collapseDuplicateHits(
      db,
      [hit({ id: "m", projectId: "standup-self", slug: "s", score: 0.9 }), hit({ id: "o", projectId: "standup", slug: "o", score: 0.5 }), hit({ id: "c", projectId: "standup", slug: "s", score: 0.4 })],
      { mirrors: MIRRORS }
    );
    expect(out.map((h) => [h.id, h.score])).toEqual([
      ["c", 0.9],
      ["o", 0.5],
    ]);
  });

  test("token overlap ignores stopwords and short words", () => {
    expect([...contentTokens("The cat and the hat")].sort()).toEqual(["cat", "hat"]);
    expect(contentOverlap(contentTokens("alpha beta"), contentTokens("alpha beta")).jaccard).toBe(1);
  });
});
