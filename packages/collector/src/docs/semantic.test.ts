import { afterEach, describe, expect, test } from "bun:test";
import { CHUNKER_VERSION, registerEmbeddingProvider } from "@standup/knowledge";
import type { DocSearchHit } from "@standup/shared";
import {
  DOC_SEARCH_LIMIT,
  createDoc,
  createDocFolder,
  createStore,
  deleteDoc,
  deleteDocFolder,
  replaceDocChunks,
  updateDoc,
} from "@standup/store";
import { DOC_EMBEDDER_REST_MS, DocsSemanticIndex, fuseDocHits, meaningFloor } from "./semantic.js";
import type { DocMeaningHit } from "./semantic.js";
import { docsHarness } from "./test-harness.js";

/**
 * A stand-in embedder: one dimension per topic, counting the topic's words in
 * the text, so texts on one topic point the same way whatever words they use.
 * `down` makes it fail the way an unreachable provider does; a text holding
 * "poison" always fails.
 */
const TOPICS: string[][] = [
  ["budget", "spend", "spending", "cost", "costs", "expenses", "money", "invoice"],
  ["trip", "flight", "flights", "travel", "vacation", "itinerary", "hotel"],
  ["dog", "puppy", "cat", "vet", "pet", "pets"],
];
const fake = { down: false, calls: 0 };
const PROVIDER = "docs-semantic-test";
registerEmbeddingProvider({
  id: PROVIDER,
  defaultModel: "topics-v1",
  dimensions: TOPICS.length,
  async embed(text) {
    fake.calls++;
    if (fake.down || /poison/i.test(text)) throw new Error("connect ECONNREFUSED");
    const words = text.toLowerCase().split(/[^a-z]+/);
    return TOPICS.map((topic) => words.filter((w) => topic.includes(w)).length);
  },
});

afterEach(() => {
  fake.down = false;
});

function setup(now?: () => number) {
  const store = createStore(":memory:");
  const index = new DocsSemanticIndex(store.db, PROVIDER, {}, now);
  return { db: store.db, index };
}

function chunks(db: ReturnType<typeof setup>["db"], docId: string) {
  return db.query("SELECT seq, revision, embedder, text FROM doc_chunks WHERE doc_id = ? ORDER BY seq").all(docId) as Array<{
    seq: number;
    revision: number;
    embedder: string;
    text: string;
  }>;
}

describe("the docs semantic index", () => {
  test("a created doc is embedded at its revision by the knowledge embedder", async () => {
    const { db, index } = setup();
    const doc = createDoc(db, { owner: "alice", folderId: null, name: "q3.md", body: "# Q3\n\nWhere the money went this quarter." });
    expect(await index.catchUp()).toBe(1);
    const rows = chunks(db, doc.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 0, revision: 1, embedder: index.embedder });
    expect(rows[0]!.text).toContain("Where the money went");
    expect(index.embedder).toBe(`${PROVIDER}:topics-v1:3|chunker=${CHUNKER_VERSION}`);
    expect(await index.catchUp()).toBe(0);
  });

  test("an updated doc is re-embedded at its new revision and searched as it now reads; a move alone keeps its chunks", async () => {
    const { db, index } = setup();
    const doc = createDoc(db, { owner: "alice", folderId: null, name: "plan.md", body: "Book the flight." });
    await index.catchUp();
    expect((await index.search("alice", "vacation")).map((h) => h.id)).toEqual([doc.id]);
    updateDoc(db, { id: doc.id, owner: "alice", body: "Walk the dog." });
    expect(await index.catchUp()).toBe(1);
    expect(chunks(db, doc.id).map((r) => [r.revision, r.text])).toEqual([[2, "Walk the dog."]]);
    expect(await index.search("alice", "vacation")).toEqual([]);
    expect((await index.search("alice", "puppy")).map((h) => h.id)).toEqual([doc.id]);
    const folder = createDocFolder(db, { owner: "alice", parentId: null, name: "f" });
    updateDoc(db, { id: doc.id, owner: "alice", folderId: folder.id });
    expect(await index.catchUp()).toBe(0);
  });

  test("a deleted doc's chunks go with it, also when its folder is deleted", async () => {
    const { db, index } = setup();
    const folder = createDocFolder(db, { owner: "alice", parentId: null, name: "f" });
    const a = createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "money" });
    const b = createDoc(db, { owner: "alice", folderId: folder.id, name: "b.md", body: "trip" });
    await index.catchUp();
    expect(await index.search("alice", "budget")).toHaveLength(1);
    deleteDoc(db, a.id, "alice");
    expect(chunks(db, a.id)).toEqual([]);
    expect(await index.search("alice", "budget")).toEqual([]);
    deleteDocFolder(db, folder.id, "alice");
    expect(chunks(db, b.id)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM doc_chunks").get()).toEqual({ n: 0 });
  });

  test("the first poke backfills docs written before the index; another embedder re-embeds them all", async () => {
    const { db } = setup();
    for (const name of ["a.md", "b.md", "c.md"]) createDoc(db, { owner: "alice", folderId: null, name, body: "" });
    const index = new DocsSemanticIndex(db, PROVIDER);
    index.poke();
    await index.idle();
    const keys = () => (db.query("SELECT DISTINCT embedder FROM doc_chunks").all() as Array<{ embedder: string }>).map((r) => r.embedder);
    expect(db.query("SELECT COUNT(DISTINCT doc_id) AS n FROM doc_chunks").get()).toEqual({ n: 3 });
    expect(keys()).toEqual([index.embedder]);
    // An empty doc is embedded by its name, so it still has one chunk.
    expect(db.query("SELECT COUNT(*) AS n FROM doc_chunks WHERE text = ''").get()).toEqual({ n: 3 });

    const other = new DocsSemanticIndex(db, PROVIDER, { model: "topics-v2" });
    expect(await other.catchUp()).toBe(3);
    expect(keys()).toEqual([other.embedder]);
  });

  test("a poke during a pass runs another pass after it", async () => {
    const { db, index } = setup();
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "money" });
    index.poke();
    const later = createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "trip" });
    index.poke();
    await index.idle();
    expect(chunks(db, later.id)).toHaveLength(1);
  });

  test("chunks embedded for a revision a newer save has passed are refused", () => {
    const { db } = setup();
    const doc = createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "money" });
    updateDoc(db, { id: doc.id, owner: "alice", body: "trip" });
    const chunk = { text: "money", embedding: new Uint8Array(12) };
    expect(replaceDocChunks(db, { docId: doc.id, revision: 1, embedder: "e", chunks: [chunk] })).toBe(false);
    expect(replaceDocChunks(db, { docId: "missing", revision: 1, embedder: "e", chunks: [chunk] })).toBe(false);
    expect(replaceDocChunks(db, { docId: doc.id, revision: 2, embedder: "e", chunks: [chunk] })).toBe(true);
  });

  test("a doc the embedder fails on is skipped, and the docs behind it are still embedded", async () => {
    const { db, index } = setup();
    const ok = createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "money" }, new Date("2026-01-01"));
    const bad = createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "poison" }, new Date("2026-02-01"));
    expect(await index.catchUp()).toBe(1);
    expect(chunks(db, ok.id)).toHaveLength(1);
    expect(chunks(db, bad.id)).toEqual([]);
    expect(index.resting).toBe(false);
  });

  test("search ranks the owner's docs by meaning, best chunk per doc, above the floor", async () => {
    const { db, index } = setup();
    const costs = createDoc(db, { owner: "alice", folderId: null, name: "q3.md", body: "Invoice totals and expenses.\n\n## Pets\n\nThe vet." });
    const trip = createDoc(db, { owner: "alice", folderId: null, name: "japan.md", body: "Hotel and itinerary." });
    createDoc(db, { owner: "bob", folderId: null, name: "bob.md", body: "My own expenses." });
    await index.catchUp();
    expect((await index.search("alice", "how much did we spend")).map((h) => h.id)).toEqual([costs.id]);
    expect((await index.search("alice", "vacation")).map((h) => h.id)).toEqual([trip.id]);
    expect(await index.search("alice", "quarterly")).toEqual([]);
    expect(await index.search("carol", "spend")).toEqual([]);
  });

  test("the floor is a sixth of the cosine band above its low end, or a sixth of the band below the best hit", () => {
    const band = { low: 0.45, high: 0.75 };
    expect(meaningFloor(band, 0.52)).toBeCloseTo(0.5);
    expect(meaningFloor(band, 0.64)).toBeCloseTo(0.59);
  });

  test("with the embedder down, nothing is indexed and the failed docs wait until they are due, then it catches up", async () => {
    let now = 1_000_000;
    const { db, index } = setup(() => now);
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) createDoc(db, { owner: "alice", folderId: null, name, body: "expenses" });
    fake.down = true;
    const calls = fake.calls;
    expect(await index.catchUp()).toBe(0);
    // Three failures in a row end the pass: the fourth doc is never sent.
    expect(fake.calls - calls).toBe(3);
    expect(db.query("SELECT COUNT(*) AS n FROM doc_chunks").get()).toEqual({ n: 0 });

    fake.down = false;
    expect(await index.catchUp()).toBe(1);
    now += DOC_EMBEDDER_REST_MS + 1;
    expect(await index.catchUp()).toBe(3);
    expect(await index.search("alice", "spend")).toHaveLength(4);
  });

  test("docs that keep failing don't hold back the ones behind them in later passes", async () => {
    const { db, index } = setup();
    const ok = createDoc(db, { owner: "alice", folderId: null, name: "ok.md", body: "money" }, new Date("2026-01-01"));
    for (const [i, name] of ["p1.md", "p2.md", "p3.md"].entries()) {
      createDoc(db, { owner: "alice", folderId: null, name, body: "poison" }, new Date(`2026-02-0${i + 1}`));
    }
    expect(await index.catchUp()).toBe(0);
    expect(await index.catchUp()).toBe(1);
    expect(chunks(db, ok.id)).toHaveLength(1);
  });

  test("a failing query rests meaning lookups until the rest ends, whatever indexing does meanwhile", async () => {
    let now = 1_000_000;
    const { db, index } = setup(() => now);
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "expenses" });
    await index.catchUp();
    fake.down = true;
    expect(await index.search("alice", "spend")).toEqual([]);
    expect(index.resting).toBe(true);
    fake.down = false;
    createDoc(db, { owner: "alice", folderId: null, name: "b.md", body: "trip" });
    expect(await index.catchUp()).toBe(1);
    const calls = fake.calls;
    expect(await index.search("alice", "spend")).toEqual([]);
    expect(fake.calls).toBe(calls);
    now += DOC_EMBEDDER_REST_MS + 1;
    expect(await index.search("alice", "spend")).toHaveLength(1);
  });

  test("a query the embedder fails on answers nothing and rests it", async () => {
    const { db, index } = setup();
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "expenses" });
    await index.catchUp();
    expect(await index.search("alice", "poison")).toEqual([]);
    expect(index.resting).toBe(true);
  });

  test("without an embedder the index does nothing", async () => {
    const { db } = setup();
    createDoc(db, { owner: "alice", folderId: null, name: "a.md", body: "expenses" });
    const off = new DocsSemanticIndex(db, null);
    expect(off.enabled).toBe(false);
    const calls = fake.calls;
    off.poke();
    expect(await off.search("alice", "spend")).toEqual([]);
    expect(fake.calls).toBe(calls);
  });
});

describe("fuseDocHits", () => {
  const path = (id: string): DocSearchHit => ({ id, path: `${id}.md`, match: "path" });
  const body = (id: string): DocSearchHit => ({ id, path: `${id}.md`, match: "body", snippet: `${id} words` });
  const meant = (id: string, text = `${id} passage`): DocMeaningHit => ({ id, cosine: 0.8, text });
  const paths = new Map(["n1", "n2", "b1", "b2", "m1", "m2"].map((id) => [id, `${id}.md`]));

  test("name and path matches stay on top; body matches are reordered by meaning; meaning-only docs come last", () => {
    const hits = fuseDocHits([path("n1"), path("n2"), body("b1"), body("b2")], [meant("m1"), meant("b2"), meant("n2")], paths);
    expect(hits.map((h) => [h.id, h.match])).toEqual([
      ["n1", "path"],
      ["n2", "path"],
      ["b2", "body"],
      ["b1", "body"],
      ["m1", "meaning"],
    ]);
    // A doc both arms found keeps its keyword snippet.
    expect(hits[2]!.snippet).toBe("b2 words");
    expect(hits[4]).toEqual({ id: "m1", path: "m1.md", match: "meaning", snippet: "m1 passage" });
  });

  test("with no meaning hits the keyword hits come back unchanged", () => {
    const keyword = [path("n1"), body("b1"), body("b2")];
    expect(fuseDocHits(keyword, [], paths)).toEqual(keyword);
  });

  test("a meaning hit's snippet skips headings and fences; one with no known path is left out", () => {
    expect(fuseDocHits([], [meant("gone"), meant("m1", "## Costs\n\n```\nx\n```\nWhere it went."), meant("m2", "# Only")], paths)).toEqual([
      { id: "m1", path: "m1.md", match: "meaning", snippet: "x" },
      { id: "m2", path: "m2.md", match: "meaning" },
    ]);
  });

  test("keyword hits are never pushed out by meaning-only ones", () => {
    const many = Array.from({ length: DOC_SEARCH_LIMIT }, (_, i) => body(`b${i}`));
    const hits = fuseDocHits(many, [meant("m1")], paths);
    expect(hits).toHaveLength(DOC_SEARCH_LIMIT);
    expect(hits.every((h) => h.match === "body")).toBe(true);
  });
});

describe("GET /api/docs/search with the semantic index", () => {
  async function seeded() {
    fake.down = false;
    const h = docsHarness({ embeddingProvider: PROVIDER });
    const alice = h.as("alice");
    const make = (name: string, body: string) =>
      h.ok<{ doc: { id: string } }>("POST", "/api/docs", alice, { folderId: null, name, body }).then((r) => r.doc);
    const costs = await make("q3-review.md", "Invoice totals and expenses for the quarter.");
    const trip = await make("japan.md", "Hotel and itinerary for Kyoto.");
    await make("review-notes.md", "Nothing here yet.");
    const embedded = async (n: number) => {
      const deadline = Date.now() + 5000;
      while ((h.store.db.query("SELECT COUNT(DISTINCT doc_id) AS n FROM doc_chunks").get() as { n: number }).n !== n) {
        if (Date.now() > deadline) throw new Error(`docs were never embedded (${n})`);
        await Bun.sleep(10);
      }
    };
    await embedded(3);
    const search = async (q: string) =>
      (await h.ok<{ hits: DocSearchHit[] }>("GET", `/api/docs/search?q=${encodeURIComponent(q)}`, alice)).hits;
    return { h, alice, costs, trip, search, embedded };
  }

  test("a query sharing no word with a doc finds it by meaning", async () => {
    const { costs, search } = await seeded();
    expect(await search("how much did we spend")).toEqual([
      { id: costs.id, path: "q3-review.md", match: "meaning", snippet: "Invoice totals and expenses for the quarter." },
    ]);
  });

  test("an exact-keyword query still lists its name matches first, in the keyword order", async () => {
    const { search } = await seeded();
    expect((await search("review")).map((h) => [h.path, h.match])).toEqual([
      ["review-notes.md", "path"],
      ["q3-review.md", "path"],
    ]);
  });

  test("a doc saved or deleted through the routes is re-embedded or dropped in the background", async () => {
    const { h, alice, costs, trip, search, embedded } = await seeded();
    await h.ok("PATCH", `/api/docs/${costs.id}`, alice, { body: "The vet bill for the puppy." });
    const deadline = Date.now() + 5000;
    while ((await search("pets")).length === 0) {
      if (Date.now() > deadline) throw new Error("the saved doc was never re-embedded");
      await Bun.sleep(10);
    }
    expect((await search("pets")).map((x) => x.id)).toEqual([costs.id]);
    await h.ok("DELETE", `/api/docs/${trip.id}`, alice);
    await embedded(2);
    expect(await search("vacation")).toEqual([]);
  });

  test("with the embedder down, search answers from keywords alone", async () => {
    const { trip, search } = await seeded();
    fake.down = true;
    expect(await search("vacation")).toEqual([]);
    expect(await search("kyoto")).toEqual([{ id: trip.id, path: "japan.md", match: "body", snippet: "Hotel and itinerary for Kyoto." }]);
  });

  test("another person's docs never come back by meaning", async () => {
    const { h, search } = await seeded();
    expect((await h.ok<{ hits: unknown[] }>("GET", "/api/docs/search?q=spend", h.as("bob"))).hits).toEqual([]);
    expect(await search("spend")).toHaveLength(1);
  });
});
