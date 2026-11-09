import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "./store.js";
import {
  deriveEdges,
  compileGraph,
  deriveDefloatEdges,
  CO_CITATION_MAX_FANOUT,
  CO_CITATION_MAX_TAG_DOCS,
  CO_CITATION_MIN_COSINE,
  CO_CITATION_AMBIGUOUS_TAGS,
  CO_CITATION_TAG_MEDIAN_MARGIN,
  PROVENANCE_MAX_FANOUT,
  PROVENANCE_WEIGHT,
  WIKILINK_WEIGHT,
  WIKILINK_EVIDENCE_MAX_CHARS,
  parseWikilinks,
  DEFLOAT_MIN_COSINE,
  DEFLOAT_MAX_IN_DEGREE,
  CONTRADICTS_CLAIM_PREFIX,
  formatContradictsClaim,
  parseContradictsClaim,
} from "./graph.js";
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

describe("deriveEdges", () => {
  test("an explicit frontmatter `related` link becomes a directed edge", () => {
    const a = doc({ id: "a", projectId: "p1", slug: "arch", related: ["intent"] });
    const b = doc({ id: "b", projectId: "p1", slug: "intent" });

    const edges = deriveEdges([a, b]);
    const related = edges.filter((e) => e.kind === "related");

    expect(related).toHaveLength(1);
    expect(related[0].srcDocId).toBe("a");
    expect(related[0].dstDocId).toBe("b");
  });

  test("a `related` target can point across projects via projectId/slug", () => {
    const a = doc({ id: "a", projectId: "p1", slug: "arch", related: ["p2/patterns"] });
    const b = doc({ id: "b", projectId: "p2", slug: "patterns" });

    const related = deriveEdges([a, b]).filter((e) => e.kind === "related");
    expect(related).toHaveLength(1);
    expect(related[0].dstDocId).toBe("b");
  });

  test("an ambiguous bare-slug target across projects is dropped, not guessed", () => {
    const a = doc({ id: "a", projectId: "p1", slug: "arch", related: ["patterns"] });
    const b = doc({ id: "b", projectId: "p2", slug: "patterns" });
    const c = doc({ id: "c", projectId: "p3", slug: "patterns" });

    const related = deriveEdges([a, b, c]).filter((e) => e.kind === "related");
    expect(related).toHaveLength(0);
  });

  test("docs sharing a tag get one undirected co-citation edge, weighted by overlap", () => {
    const a = doc({ id: "a", projectId: "p1", slug: "a", tags: ["auth", "retry"] });
    const b = doc({ id: "b", projectId: "p2", slug: "b", tags: ["auth", "retry"] });

    const co = deriveEdges([a, b]).filter((e) => e.kind === "co-citation");
    expect(co).toHaveLength(1);
    expect(co[0].weight).toBe(2);
    // Undirected: canonicalized so A–B and B–A collapse to one row.
    expect([co[0].srcDocId, co[0].dstDocId].sort()).toEqual(["a", "b"]);
    // The evidence names the ACTUAL shared tags (sorted, stable), not a count.
    expect(co[0].evidence).toBe("shared tags: auth, retry");
  });

  test("docs authored by the same session get one undirected provenance edge", () => {
    const a = doc({ id: "a", projectId: "p1", slug: "a", sourceSessionId: "s1" });
    const b = doc({ id: "b", projectId: "p2", slug: "b", sourceSessionId: "s1" });
    const c = doc({ id: "c", projectId: "p1", slug: "c", sourceSessionId: "s2" });

    const edges = deriveEdges([a, b, c]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: "provenance:a:b",
      kind: "provenance",
      srcDocId: "a",
      dstDocId: "b",
      weight: PROVENANCE_WEIGHT,
      evidence: "same authoring session",
    });
  });

  test("docs with no (or a blank) source session get no provenance edge", () => {
    const docs = [
      doc({ id: "a", slug: "a" }),
      doc({ id: "b", slug: "b" }),
      doc({ id: "c", slug: "c", sourceSessionId: "  " }),
      doc({ id: "d", slug: "d", sourceSessionId: "" }),
    ];
    expect(deriveEdges(docs).filter((e) => e.kind === "provenance")).toHaveLength(0);
  });

  test("a prolific session keeps at most PROVENANCE_MAX_FANOUT provenance edges per doc", () => {
    const n = PROVENANCE_MAX_FANOUT + 6;
    const docs = Array.from({ length: n }, (_, i) =>
      doc({ id: `d${String(i).padStart(2, "0")}`, slug: `d${i}`, sourceSessionId: "bulk" })
    );
    const prov = deriveEdges(docs).filter((e) => e.kind === "provenance");
    const degree = new Map<string, number>();
    for (const e of prov) {
      degree.set(e.srcDocId, (degree.get(e.srcDocId) ?? 0) + 1);
      degree.set(e.dstDocId, (degree.get(e.dstDocId) ?? 0) + 1);
    }
    expect(Math.max(...degree.values())).toBe(PROVENANCE_MAX_FANOUT);
    expect(prov.length).toBeLessThan((n * (n - 1)) / 2);
    expect(prov.length).toBeLessThanOrEqual((n * PROVENANCE_MAX_FANOUT) / 2);
  });

  test("with doc vectors, provenance links the closest siblings and drops content-unrelated ones", () => {
    const docs = ["a", "b", "c", "u"].map((id) => doc({ id, slug: id, sourceSessionId: "s1" }));
    const docVectors = new Map<string, number[]>([
      ["a", [1, 0]],
      ["b", [0.95, 0.31]],
      ["c", [0, 1]],
    ]);
    const pairs = deriveEdges(docs, { docVectors, provenanceMaxFanout: 2 })
      .filter((e) => e.kind === "provenance")
      .map((e) => `${e.srcDocId}-${e.dstDocId}`);
    // a–b first (closest); c is unrelated to a and b; the unembedded u fills the
    // remaining slots by id until each endpoint reaches the cap of 2.
    expect(pairs).toEqual(["a-b", "a-u", "b-u"]);
  });

  test("a body [[slug]] wikilink becomes a directed related edge citing its line", () => {
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "arch",
      body: "# Arch\n\n  Extends [[intent]] with the retry rules.  \n",
    });
    const b = doc({ id: "b", projectId: "p1", slug: "intent" });
    const related = deriveEdges([a, b]).filter((e) => e.kind === "related");
    expect(related).toEqual([
      {
        id: "related:a:b",
        srcDocId: "a",
        dstDocId: "b",
        kind: "related",
        weight: WIKILINK_WEIGHT,
        evidence: "Extends [[intent]] with the retry rules.",
      },
    ]);
  });

  test("wikilink forms: project-qualified, |label and #heading resolve; code, unresolved and self links do not", () => {
    const src = doc({
      id: "src",
      projectId: "p1",
      slug: "src",
      body: [
        "See [[p2/patterns]] and [[intent|the intent doc]].",
        "Section link: [[heading-target#usage]].",
        "Unknown: [[no-such-doc]]. Self: [[src]] and [[p1/src]].",
        "Inline code is syntax, not a link: `[[inline-only]]` or ``a [[inline-only]] b``.",
        "```toml",
        "[[fenced-only]]",
        "```",
        "~~~",
        "[[tilde-fenced]]",
        "~~~",
        "Spaces are not a slug: [[two words]].",
      ].join("\n"),
    });
    const targets = ["patterns", "intent", "heading-target", "inline-only", "fenced-only", "tilde-fenced"];
    const docs = [
      src,
      ...targets.map((slug) => doc({ id: slug, projectId: slug === "patterns" ? "p2" : "p1", slug })),
    ];

    const dsts = deriveEdges(docs)
      .filter((e) => e.kind === "related" && e.srcDocId === "src")
      .map((e) => e.dstDocId)
      .sort();
    expect(dsts).toEqual(["heading-target", "intent", "patterns"]);
  });

  test("a bare wikilink resolves same project, then the global project, then a unique slug", () => {
    const src = doc({ id: "src", projectId: "p1", slug: "src", body: "[[shared]] [[conv]] [[lone]] [[split]]" });
    const docs = [
      src,
      doc({ id: "p1-shared", projectId: "p1", slug: "shared" }),
      doc({ id: "p2-shared", projectId: "p2", slug: "shared" }),
      doc({ id: "global-conv", projectId: "global", slug: "conv" }),
      doc({ id: "p2-conv", projectId: "p2", slug: "conv" }),
      doc({ id: "p3-lone", projectId: "p3", slug: "lone" }),
      doc({ id: "p2-split", projectId: "p2", slug: "split" }),
      doc({ id: "p3-split", projectId: "p3", slug: "split" }),
    ];
    const dsts = deriveEdges(docs)
      .filter((e) => e.kind === "related" && e.srcDocId === "src")
      .map((e) => e.dstDocId)
      .sort();
    // `split` is ambiguous across two non-global projects and is dropped.
    expect(dsts).toEqual(["global-conv", "p1-shared", "p3-lone"]);
  });

  test("a target named in frontmatter and as a wikilink yields one edge, the frontmatter one", () => {
    const a = doc({
      id: "a",
      slug: "arch",
      related: ["intent"],
      body: "Companion to [[intent]].\nAgain: [[intent]].",
    });
    const b = doc({ id: "b", slug: "intent" });
    const related = deriveEdges([a, b]).filter((e) => e.kind === "related");
    expect(related).toHaveLength(1);
    expect(related[0].weight).toBe(1);
    expect(related[0].evidence).toBe("frontmatter related: intent");

    // Without the frontmatter line, the first linking line is the evidence.
    a.related = undefined;
    const wiki = deriveEdges([a, b]).filter((e) => e.kind === "related");
    expect(wiki).toHaveLength(1);
    expect(wiki[0].evidence).toBe("Companion to [[intent]].");
  });

  test("a long wikilink line is capped in the evidence", () => {
    const a = doc({ id: "a", slug: "a", body: `${"x".repeat(400)} [[b]]` });
    const b = doc({ id: "b", slug: "b" });
    const [edge] = deriveEdges([a, b]).filter((e) => e.kind === "related");
    expect(edge.evidence!.length).toBe(WIKILINK_EVIDENCE_MAX_CHARS);
    expect(edge.evidence!.endsWith("…")).toBe(true);
  });

  test("parseWikilinks returns each link's target and trimmed line, skipping code", () => {
    expect(parseWikilinks("  a [[x]] b [[p/y|Y]]\n```\n[[z]]\n```\n`[[w]]`")).toEqual([
      { target: "x", line: "a [[x]] b [[p/y|Y]]" },
      { target: "p/y", line: "a [[x]] b [[p/y|Y]]" },
    ]);
  });

  test("an ambiguous tag never links a pair on its own, but counts alongside a specific one", () => {
    expect([...CO_CITATION_AMBIGUOUS_TAGS].sort()).toEqual(["gateway", "hooks", "roadmap"]);
    const a = doc({ id: "a", slug: "a", tags: ["hooks"] });
    const b = doc({ id: "b", slug: "b", tags: ["hooks"] });
    const c = doc({ id: "c", slug: "c", tags: ["gateway", "ws-restart"] });
    const d = doc({ id: "d", slug: "d", tags: ["gateway", "ws-restart"] });
    const co = deriveEdges([a, b, c, d]).filter((e) => e.kind === "co-citation");
    expect(co).toHaveLength(1);
    expect([co[0].srcDocId, co[0].dstDocId]).toEqual(["c", "d"]);
    expect(co[0].weight).toBe(2);
    expect(co[0].evidence).toBe("shared tags: gateway, ws-restart");
  });

  test("the per-tag cosine floor drops a cross-meaning pair that the global floor would keep", () => {
    // a, b, c share one meaning of `x` (cosine ~0.99 to each other); d shares
    // the tag but sits at ~0.75 to each — above the global floor, far below
    // the tag's own median.
    const docs = ["a", "b", "c", "d"].map((id) => doc({ id, slug: id, tags: ["x"] }));
    const docVectors = new Map<string, number[]>([
      ["a", [1, 0, 0, 0]],
      ["b", [1, 0.1, 0, 0]],
      ["c", [1, 0, 0.1, 0]],
      ["d", [0.75, 0, 0, Math.sqrt(1 - 0.75 ** 2)]],
    ]);
    const pairs = (opts: Parameters<typeof deriveEdges>[1]) =>
      deriveEdges(docs, opts)
        .filter((e) => e.kind === "co-citation")
        .map((e) => `${e.srcDocId}-${e.dstDocId}`)
        .sort();

    expect(pairs({ docVectors })).toEqual(["a-b", "a-c", "b-c"]);
    // The d pairs (~0.75) clear the global floor; the tag's floor is its median
    // (~0.87, between the two groups) minus the margin, which they miss.
    expect(CO_CITATION_MIN_COSINE).toBeLessThan(0.74);
    expect(0.75).toBeLessThan(0.87 - CO_CITATION_TAG_MEDIAN_MARGIN);
    // A single-meaning tag keeps every pair: the spread sits within the margin.
    const tight = new Map(docVectors);
    tight.set("d", [1, 0.05, 0.05, 0]);
    expect(pairs({ docVectors: tight })).toEqual(["a-b", "a-c", "a-d", "b-c", "b-d", "c-d"]);
  });

  test("a tag carried by more than CO_CITATION_MAX_TAG_DOCS docs links nothing on its own", () => {
    const docs = Array.from({ length: CO_CITATION_MAX_TAG_DOCS + 1 }, (_, i) =>
      doc({ id: `d${i}`, slug: `d${i}`, tags: ["cdk"] })
    );
    expect(deriveEdges(docs).filter((e) => e.kind === "co-citation")).toHaveLength(0);

    // A specific tag still links the two docs that share it, and the generic
    // tag stays out of the edge's weight and evidence.
    docs[0].tags = ["cdk", "bootstrap-race"];
    docs[1].tags = ["cdk", "bootstrap-race"];
    const co = deriveEdges(docs).filter((e) => e.kind === "co-citation");
    expect(co).toHaveLength(1);
    expect([co[0].srcDocId, co[0].dstDocId].sort()).toEqual(["d0", "d1"]);
    expect(co[0].weight).toBe(1);
    expect(co[0].evidence).toBe("shared tags: bootstrap-race");
  });

  test("with doc vectors, a shared tag links two embedded docs only when their content agrees", () => {
    const a = doc({ id: "a", slug: "a", tags: ["testing"] });
    const b = doc({ id: "b", slug: "b", tags: ["testing"] });
    const c = doc({ id: "c", slug: "c", tags: ["testing"] });
    const u = doc({ id: "u", slug: "u", tags: ["testing"] });
    const docVectors = new Map<string, number[]>([
      ["a", [1, 0]],
      ["b", [0.95, 0.31]], // cosine ~0.95 with a
      ["c", [0, 1]], // orthogonal to a, ~0.31 with b
    ]);
    expect(CO_CITATION_MIN_COSINE).toBeGreaterThan(0.31);

    const pairs = deriveEdges([a, b, c, u], { docVectors })
      .filter((e) => e.kind === "co-citation")
      .map((e) => [e.srcDocId, e.dstDocId].sort().join("-"))
      .sort();
    // a–b agree; c disagrees with both; the unembedded u is judged on tags alone.
    expect(pairs).toEqual(["a-b", "a-u", "b-u", "c-u"]);
  });

  test("co-citation keeps at most CO_CITATION_MAX_FANOUT edges per doc, strongest and rarest first", () => {
    // The hub shares one tag with each of many spokes; spoke s0 also shares a
    // second tag, and s1's tag is rarer than the rest.
    const hub = doc({ id: "hub", slug: "hub", tags: [] });
    const spokes = Array.from({ length: CO_CITATION_MAX_FANOUT + 4 }, (_, i) =>
      doc({ id: `s${i}`, slug: `s${i}` })
    );
    for (let i = 0; i < spokes.length; i++) {
      const tag = `t${Math.floor(i / 2)}`;
      spokes[i].tags = [tag];
      hub.tags!.push(tag);
    }
    // s0 also shares `extra`; s1 is given a tag only it and the hub carry.
    spokes[0].tags!.push("extra");
    hub.tags!.push("extra", "rare");
    spokes[1].tags = ["rare"];

    const co = deriveEdges([hub, ...spokes]).filter((e) => e.kind === "co-citation");
    const hubEdges = co.filter((e) => e.srcDocId === "hub" || e.dstDocId === "hub");
    expect(hubEdges).toHaveLength(CO_CITATION_MAX_FANOUT);
    const neighbors = hubEdges.map((e) => (e.srcDocId === "hub" ? e.dstDocId : e.srcDocId));
    expect(neighbors[0]).toBe("s0");
    expect(neighbors[1]).toBe("s1");
  });

  test("reciprocal `Contradicts` disputes (the coherence-pass shape) become an undirected edge, both ways, weight 2", () => {
    // The coherence pass stamps `Contradicts <other>` on BOTH docs of a
    // conflicting pair — the shape production actually produces. Each doc's
    // dispute maps to the same ordered pair, so the pair's weight is 2.
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "uses-bun",
      disputes: [{ claim: "Contradicts uses-node", finding: "opposing", evidence: "e" }],
    });
    const b = doc({
      id: "b",
      projectId: "p1",
      slug: "uses-node",
      disputes: [{ claim: "Contradicts uses-bun", finding: "opposing", evidence: "e" }],
    });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    // Emitted in both directions, like a mutual `related` pair.
    expect(con).toHaveLength(2);
    expect(con.map((e) => `${e.srcDocId}->${e.dstDocId}`).sort()).toEqual([
      "a->b",
      "b->a",
    ]);
    // Both docs name the pair, so weight is 2.
    expect(con.every((e) => e.weight === 2)).toBe(true);
    // The dispute finding rides onto the edge, both directions.
    expect(con.every((e) => e.evidence === "opposing")).toBe(true);
  });

  test("a contradicts edge's evidence carries the dispute finding — the 'what's the contradiction'", () => {
    // The finding is the human-legible reason the two docs conflict; it must
    // land on the edge instead of the old constant "coherence flagged".
    const finding = "This doc says the runtime is Bun; uses-node says Node.";
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "uses-bun",
      disputes: [{ claim: "Contradicts uses-node", finding, evidence: "rg runtime" }],
    });
    const b = doc({ id: "b", projectId: "p1", slug: "uses-node" });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    expect(con).toHaveLength(2);
    expect(con.every((e) => e.evidence === finding)).toBe(true);
  });

  test("a contradicts dispute with no finding falls back to its evidence command, then the constant", () => {
    // No finding → use the evidence (the command a human can re-run). Neither →
    // the legacy constant, so the edge is never left with an empty reason.
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "uses-bun",
      disputes: [{ claim: "Contradicts uses-node", finding: "", evidence: "rg -n runtime src/" }],
    });
    const b = doc({
      id: "b",
      projectId: "p1",
      slug: "uses-node",
      disputes: [{ claim: "Contradicts uses-bun", finding: "", evidence: "" }],
    });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    // The pair's detail is the first non-empty one found across both docs.
    expect(con.every((e) => e.evidence === "rg -n runtime src/")).toBe(true);
  });

  test("a single-sided `Contradicts` dispute still yields the undirected edge at weight 1", () => {
    // Only one doc names the counterpart (e.g. mid-recompile, before the pass
    // has stamped the reciprocal dispute). The edge is still emitted both ways.
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "uses-bun",
      disputes: [{ claim: "Contradicts uses-node", finding: "opposing", evidence: "e" }],
    });
    const b = doc({ id: "b", projectId: "p1", slug: "uses-node" });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    expect(con).toHaveLength(2);
    expect(con.every((e) => e.weight === 1)).toBe(true);
  });

  test("a non-`Contradicts` dispute claim yields no contradicts edge (prefix guard)", () => {
    // A doc↔code fact-check writes a `disputed` dispute whose claim quotes the
    // draft text, NOT the `Contradicts ` prefix — it must never fabricate a
    // doc↔doc edge to a doc that merely happens to share the slug.
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "arch",
      disputes: [{ claim: "Claims retries are unbounded", finding: "code caps at 3", evidence: "rg" }],
    });
    const b = doc({ id: "b", projectId: "p1", slug: "Claims retries are unbounded" });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    expect(con).toHaveLength(0);
  });

  test("a `Contradicts <slug>` naming a non-existent slug is dropped, not a half-edge", () => {
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "arch",
      disputes: [{ claim: "Contradicts renamed-away", finding: "opposing", evidence: "e" }],
    });
    const b = doc({ id: "b", projectId: "p1", slug: "intent" });

    const con = deriveEdges([a, b]).filter((e) => e.kind === "contradicts");
    expect(con).toHaveLength(0);
  });

  test("a `Contradicts` bare slug resolves same-project-first, per resolveTarget", () => {
    // A bare-slug target that exists in both the source's own project and
    // another resolves to the same-project doc — the exact preference
    // resolveTarget applies to a frontmatter `related` link.
    const a = doc({
      id: "a",
      projectId: "p1",
      slug: "arch",
      disputes: [{ claim: "Contradicts patterns", finding: "opposing", evidence: "e" }],
    });
    const own = doc({ id: "own", projectId: "p1", slug: "patterns" });
    const other = doc({ id: "other", projectId: "p2", slug: "patterns" });

    const con = deriveEdges([a, own, other]).filter((e) => e.kind === "contradicts");
    expect(con).toHaveLength(2);
    const endpoints = new Set(con.flatMap((e) => [e.srcDocId, e.dstDocId]));
    expect(endpoints).toEqual(new Set(["a", "own"]));
  });
});

describe("compileGraph + getNeighbors", () => {
  test("graph_neighbors returns the docs linked to a doc, across projects", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: ["p2/intent"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p2", slug: "intent", title: "Intent" }));

    compileGraph(store);

    const neighbors = store.getNeighbors("a");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].slug).toBe("intent");
    expect(neighbors[0].projectId).toBe("p2");
    expect(neighbors[0].kind).toBe("related");

    // The edge is reachable from both ends.
    expect(store.getNeighbors("b").map((n) => n.slug)).toEqual(["arch"]);
  });

  test("recompiling drops an edge whose source `related` line was removed", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);

    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: ["intent"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "intent" }));
    compileGraph(store);
    expect(store.getNeighbors("a")).toHaveLength(1);

    // Author removes the link; a full recompile must not leave the stale
    // `related` edge. (De-float may still attach the now-floating docs by
    // semantic similarity — a separate, additive kind — so assert on the
    // related edge specifically rather than a bare neighbor count.)
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: [] }));
    compileGraph(store);
    expect(store.getNeighbors("a").some((n) => n.kind === "related")).toBe(false);
  });
});

describe("deriveDefloatEdges (float-targeted semantic edges)", () => {
  test("an embedded doc that shares no tag/session/link/contradiction gains a semantic edge to its near neighbor", () => {
    // x/y/z share NO tag, session, related link, or contradiction, so deriveEdges
    // leaves all three floating. x and y are cosine-near; z is orthogonal.
    const x = doc({ id: "x", slug: "x" });
    const y = doc({ id: "y", slug: "y" });
    const z = doc({ id: "z", slug: "z" });
    const vectors = new Map<string, number[]>([
      ["x", [1, 0]],
      ["y", [0.98, 0.2]], // cosine with x ≈ 0.98 (>= floor)
      ["z", [0, 1]], // cosine with x = 0, with y ≈ 0.2 (below floor)
    ]);

    const meta = deriveEdges([x, y, z]);
    expect(meta).toHaveLength(0); // everything floats before de-float

    const edges = deriveDefloatEdges([x, y, z], meta, vectors);
    // Every de-float edge is a semantic-similarity edge — no other kind is minted.
    expect(edges.every((e) => e.kind === "semantic-similarity")).toBe(true);
    // x and y attach to each other; x is no longer floating.
    expect(edges.some((e) => e.srcDocId === "x" && e.dstDocId === "y")).toBe(true);
    expect(edges.some((e) => e.srcDocId === "y" && e.dstDocId === "x")).toBe(true);
    // The below-floor singleton z connects to NOTHING and stays floating — a
    // de-float must not connect every node to everything.
    expect(edges.some((e) => e.srcDocId === "z" || e.dstDocId === "z")).toBe(false);
    expect(edges.length).toBeLessThan(3 * 2); // far from the fully-connected 6 directed pairs
    // The edge carries the cosine as its weight for the visualization.
    const xy = edges.find((e) => e.srcDocId === "x" && e.dstDocId === "y")!;
    expect(xy.weight).toBeGreaterThanOrEqual(DEFLOAT_MIN_COSINE);
  });

  test("a floater keeps at most maxNeighbors edges — the strongest — even with many near peers", () => {
    const hub = doc({ id: "hub", slug: "hub" });
    const peers = [1, 2, 3, 4, 5].map((i) => doc({ id: `p${i}`, slug: `p${i}` }));
    const vectors = new Map<string, number[]>([["hub", [1, 0]]]);
    // All five clear the cosine floor; smaller y ⇒ higher cosine with [1,0], so
    // p1 is the strongest neighbor and p5 the weakest.
    vectors.set("p1", [1, 0.05]);
    vectors.set("p2", [1, 0.1]);
    vectors.set("p3", [1, 0.15]);
    vectors.set("p4", [1, 0.2]);
    vectors.set("p5", [1, 0.25]);

    const docs = [hub, ...peers];
    const edges = deriveDefloatEdges(docs, deriveEdges(docs), vectors, { maxNeighbors: 2 });
    const fromHub = edges.filter((e) => e.srcDocId === "hub");
    // Bounded: exactly maxNeighbors, and they are the two strongest peers.
    expect(fromHub).toHaveLength(2);
    expect(fromHub.map((e) => e.dstDocId).sort()).toEqual(["p1", "p2"]);
  });

  test("only otherwise-floating docs get a semantic edge — a connected doc emits none", () => {
    // a and b share a tag → a co-citation edge connects them; c floats.
    const a = doc({ id: "a", slug: "a", tags: ["shared"] });
    const b = doc({ id: "b", slug: "b", tags: ["shared"] });
    const c = doc({ id: "c", slug: "c" });
    const vectors = new Map<string, number[]>([
      ["a", [1, 0]],
      ["b", [1, 0]],
      ["c", [0.95, 0.1]], // near a and b, but a/b are already connected
    ]);

    const meta = deriveEdges([a, b, c]);
    expect(meta.some((e) => e.kind === "co-citation")).toBe(true);

    const edges = deriveDefloatEdges([a, b, c], meta, vectors);
    // Every semantic edge originates from the floater c; the connected a/b get none.
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.srcDocId === "c")).toBe(true);
  });

  test("fallback: a doc with no embedding de-floats by title/tag token overlap", () => {
    const t1 = doc({ id: "t1", slug: "t1", title: "Harmonic refit station drift" });
    const t2 = doc({ id: "t2", slug: "t2", title: "Harmonic refit gauge backlog" });
    const t3 = doc({ id: "t3", slug: "t3", title: "React console tab strip" });

    const meta = deriveEdges([t1, t2, t3]);
    expect(meta).toHaveLength(0);

    // No vectors at all — the fallback token path is the only way to de-float.
    const edges = deriveDefloatEdges([t1, t2, t3], meta, new Map());
    // t1 and t2 share "harmonic"/"refit" (Jaccard ≈ 0.33 ≥ floor) and link both ways.
    expect(edges.some((e) => e.srcDocId === "t1" && e.dstDocId === "t2")).toBe(true);
    expect(edges.some((e) => e.srcDocId === "t2" && e.dstDocId === "t1")).toBe(true);
    // t3 shares no meaningful token with either — it stays floating.
    expect(edges.some((e) => e.srcDocId === "t3" || e.dstDocId === "t3")).toBe(false);
    // The evidence names the fallback so a reader can tell it apart from cosine.
    const t1t2 = edges.find((e) => e.srcDocId === "t1" && e.dstDocId === "t2")!;
    expect(t1t2.evidence).toContain("title/tag overlap");
  });

  test("no floaters ⇒ no de-float edges", () => {
    const a = doc({ id: "a", slug: "a", related: ["b"] });
    const b = doc({ id: "b", slug: "b" });
    const meta = deriveEdges([a, b]);
    expect(deriveDefloatEdges([a, b], meta, new Map([["a", [1, 0]], ["b", [1, 0]]]))).toEqual([]);
  });

  test("in-degree cap: when a hub is each floater's ONLY neighbor, the cap yields rather than re-strand them", () => {
    // t sits on the shared direction; each floater fi = [1, 0.7·e_i] is near t
    // (cosine ≈ 0.82 ≥ floor) but far from every OTHER floater (cosine ≈ 0.67 <
    // floor), so t is each floater's ONLY qualifying neighbor — a would-be hub.
    const target = doc({ id: "t", slug: "t" });
    const floaters = [1, 2, 3, 4, 5].map((i) => doc({ id: `f${i}`, slug: `f${i}` }));
    const vec = (dim: number) => {
      const v = new Array<number>(6).fill(0);
      v[0] = 1;
      v[dim] = 0.7;
      return v;
    };
    const vectors = new Map<string, number[]>([["t", [1, 0, 0, 0, 0, 0]]]);
    floaters.forEach((f, idx) => vectors.set(f.id, vec(idx + 1)));

    const docs = [target, ...floaters];
    const meta = deriveEdges(docs);
    expect(meta).toHaveLength(0); // everything floats before de-float

    // Uncapped, all five floaters point at t — proof the cluster really is a star.
    const uncapped = deriveDefloatEdges(docs, meta, vectors, { maxInDegree: 100 });
    expect(uncapped.filter((e) => e.dstDocId === "t")).toHaveLength(5);

    // With the default cap, t is over DEFLOAT_MAX_IN_DEGREE — but each dropped edge
    // would be its floater's SOLE de-float edge, so the cap yields and keeps all
    // five rather than re-stranding f4/f5. De-float's contract (every floater keeps
    // >=1 neighbor) outranks the star-hub cap when they conflict.
    const capped = deriveDefloatEdges(docs, meta, vectors);
    const incoming = capped.filter((e) => e.dstDocId === "t");
    expect(incoming).toHaveLength(5);
    expect(incoming.length).toBeGreaterThan(DEFLOAT_MAX_IN_DEGREE); // cap intentionally yielded
    expect(incoming.map((e) => e.srcDocId).sort()).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    // The invariant: NO floater is left floating — each still has an edge.
    for (const f of floaters) {
      expect(capped.some((e) => e.srcDocId === f.id)).toBe(true);
    }
  });

  test("in-degree cap: when floaters have an alternative neighbor, the hub IS capped without stranding", () => {
    // A hub h that every floater is strongly near (cosine ≈ 0.82), PLUS two
    // disjoint pairs — {f1,f2} share dim 1, {f3,f4} share dim 2 — so each floater
    // clears the floor with h AND with its pair partner, but not across pairs
    // (orthogonal off-axes ⇒ cosine ≈ 0.67 < floor). Every floater therefore has a
    // second qualifying neighbor, so the cap can shed weak h-edges without leaving
    // anyone floating.
    const hub = doc({ id: "h", slug: "h" });
    const floaters = [1, 2, 3, 4].map((i) => doc({ id: `f${i}`, slug: `f${i}` }));
    // dims: [shared, pairA, pairB]; R=0.7 off-axis ⇒ cos(fi,h)=0.819 for all i.
    const vectors = new Map<string, number[]>([
      ["h", [1, 0, 0]],
      ["f1", [1, 0.7, 0]],
      ["f2", [1, 0.65, 0]], // near f1 (same axis) and h
      ["f3", [1, 0, 0.7]],
      ["f4", [1, 0, 0.65]], // near f3 (same axis) and h
    ]);

    const docs = [hub, ...floaters];
    const meta = deriveEdges(docs);
    expect(meta).toHaveLength(0);

    // maxInDegree 2: h attracts all four floaters (in-degree 4) and must be capped.
    const capped = deriveDefloatEdges(docs, meta, vectors, { maxInDegree: 2 });
    const incoming = capped.filter((e) => e.dstDocId === "h");
    // The cap fired — h is held at exactly the cap (star-hub prevention still works).
    expect(incoming).toHaveLength(2);
    // ...and NO floater was stranded: the two whose weak h-edge was dropped keep
    // their pair-partner edge, so every floater still has a de-float edge.
    for (const f of floaters) {
      expect(capped.some((e) => e.srcDocId === f.id)).toBe(true);
    }
    // Concretely: the weakest incoming (f1->h, f3->h at cosine 0.819 vs f2/f4's
    // 0.838) are the ones shed, and their sources fall back onto the pair edge that
    // kept them off the drop list.
    const droppedFromHub = floaters
      .map((f) => f.id)
      .filter((id) => !incoming.some((e) => e.srcDocId === id));
    for (const id of droppedFromHub) {
      expect(capped.some((e) => e.srcDocId === id && e.dstDocId !== "h")).toBe(true);
    }
    // Both pairs keep their mutual edges — nothing but h-incoming was ever a drop
    // candidate, so the pair edges (the fallback attachment) always survive.
    expect(capped.some((e) => e.srcDocId === "f1" && e.dstDocId === "f2")).toBe(true);
    expect(capped.some((e) => e.srcDocId === "f3" && e.dstDocId === "f4")).toBe(true);
  });
});

describe("compileGraph de-float (persisted graph)", () => {
  test("a tagless embedded pair is de-floated and getGraph/getNeighbors expose the semantic edge", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Disjoint tags + no session ⇒ deriveEdges leaves both floating; near chunk
    // vectors ⇒ the de-float pass links them.
    store.upsertDoc(doc({ id: "n1", projectId: "p1", slug: "n1", title: "Alpha", tags: ["uniq-a"] }));
    store.upsertDoc(doc({ id: "n2", projectId: "p1", slug: "n2", title: "Beta", tags: ["uniq-b"] }));
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [1, 0, 0] });
    store.upsertChunk({ id: "n2#0", knowledgeId: "n2", chunkIndex: 0, text: "t", embedding: [0.97, 0.1, 0] });

    const edges = compileGraph(store);
    expect(edges.some((e) => e.kind === "semantic-similarity")).toBe(true);

    // The graph the /api/knowledge/graph endpoint returns includes the new edges.
    const graph = store.getGraph("p1");
    expect(graph.edges.some((e) => e.kind === "semantic-similarity")).toBe(true);

    // n1 is no longer floating — its semantic neighbor is reachable.
    const nbrs = store.getNeighbors("n1");
    expect(nbrs.some((n) => n.slug === "n2" && n.kind === "semantic-similarity")).toBe(true);
  });

  test("a connected (tag-sharing) pair keeps its co-citation edge and gains no semantic edge", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "a", tags: ["shared"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "b", tags: ["shared"] }));
    // Even with identical vectors, a connected doc must NOT gain a semantic edge.
    store.upsertChunk({ id: "a#0", knowledgeId: "a", chunkIndex: 0, text: "t", embedding: [1, 0] });
    store.upsertChunk({ id: "b#0", knowledgeId: "b", chunkIndex: 0, text: "t", embedding: [1, 0] });

    const edges = compileGraph(store);
    expect(edges.some((e) => e.kind === "co-citation")).toBe(true);
    expect(edges.some((e) => e.kind === "semantic-similarity")).toBe(false);
  });
});

describe("getGraph node fields", () => {
  test("each node carries its scope, source kind, derived layer and updatedAt", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "s", projectId: "p1", slug: "spec", sourceKind: "spec" }));
    store.upsertDoc(doc({ id: "c", projectId: "p1", slug: "code", sourceKind: "code" }));
    store.upsertDoc(doc({ id: "u", projectId: "p1", slug: "mine", scope: "user", ownerUser: "me" }));
    store.upsertDoc(doc({ id: "x", projectId: "p1", slug: "plain" }));

    const byId = new Map(store.getGraph("p1").nodes.map((n) => [n.id, n]));
    expect(byId.get("s")).toMatchObject({ scope: "project", sourceKind: "spec", layer: "intent" });
    expect(byId.get("c")).toMatchObject({ sourceKind: "code", layer: "docs" });
    expect(byId.get("u")).toMatchObject({ scope: "user", layer: "personal" });
    expect(byId.get("x")).toMatchObject({ scope: "project", sourceKind: "unclassified", layer: "docs" });
    expect(byId.get("x")!.updatedAt).toBeString();
    // Confidence and staleness are the route's to fill, not the store's.
    expect(byId.get("x")!.confidence).toBeUndefined();
    expect(byId.get("x")!.stale).toBeUndefined();
  });
});

describe("compileGraph memoization (per-request recompile is cached)", () => {
  // A store whose two disjoint-tag docs float with near chunk vectors, so the
  // de-float pass runs and reads the chunk embeddings — the exact per-request
  // cost the memo removes. Returns a scan counter wired around the embedding read.
  function floatingStore() {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "n1", projectId: "p1", slug: "n1", title: "Alpha", tags: ["uniq-a"] }));
    store.upsertDoc(doc({ id: "n2", projectId: "p1", slug: "n2", title: "Beta", tags: ["uniq-b"] }));
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [1, 0, 0] });
    store.upsertChunk({ id: "n2#0", knowledgeId: "n2", chunkIndex: 0, text: "t", embedding: [0.97, 0.1, 0] });

    const counter = { scans: 0 };
    const realScan = store.getAllChunksWithEmbeddings.bind(store);
    store.getAllChunksWithEmbeddings = ((...args: Parameters<typeof realScan>) => {
      counter.scans++;
      return realScan(...args);
    }) as typeof store.getAllChunksWithEmbeddings;
    return { store, counter };
  }

  test("a repeated compile over an unchanged corpus reuses the memo and does NOT re-scan chunk embeddings", () => {
    const { store, counter } = floatingStore();

    const first = compileGraph(store);
    expect(counter.scans).toBe(1); // de-float read every embedding once
    expect(first.some((e) => e.kind === "semantic-similarity")).toBe(true);

    // A burst of graph/stats/neighbors reads recompiles each time; the memo must
    // collapse them into ONE embedding scan while returning the same edges.
    const second = compileGraph(store);
    const third = compileGraph(store);
    expect(counter.scans).toBe(1); // no further scans
    expect(second).toBe(first); // the very same memoized array, not a recompute
    expect(third).toBe(first);
  });

  test("adding a doc changes the revision, so the next compile re-runs and re-reads embeddings", () => {
    const { store, counter } = floatingStore();
    compileGraph(store);
    expect(counter.scans).toBe(1);

    // A new floating doc changes corpusRevision ⇒ cache miss ⇒ recompute.
    store.upsertDoc(doc({ id: "n3", projectId: "p1", slug: "n3", title: "Gamma", tags: ["uniq-c"] }));
    store.upsertChunk({ id: "n3#0", knowledgeId: "n3", chunkIndex: 0, text: "t", embedding: [0.9, 0.2, 0] });

    const edges = compileGraph(store);
    expect(counter.scans).toBe(2); // recompiled, not served stale
    expect(edges.some((e) => e.srcDocId === "n3")).toBe(true);
  });

  test("corpusRevision changes on a verdict/disputes edit — which does NOT bump updated_at — so contradicts edges are never served stale", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // The doc helper stamps a FIXED updatedAt, so MAX(updated_at) alone would not
    // move — this pins that the revision folds in disputes independently.
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "uses-bun", related: ["uses-node"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "uses-node", related: ["uses-bun"] }));

    compileGraph(store);
    const before = store.corpusRevision();
    expect(compileGraph(store).some((e) => e.kind === "contradicts")).toBe(false);

    // setDocVerdict updates verdict + disputes_json WITHOUT touching updated_at.
    store.setDocVerdict("p1", "uses-bun", "disputed", [
      { claim: formatContradictsClaim("uses-node"), finding: "opposing", evidence: "e" },
    ]);
    expect(store.corpusRevision()).not.toBe(before);

    // The recompile surfaces the contradicts edge the dispute implies — proof the
    // memo was invalidated rather than serving the pre-dispute edge set.
    expect(compileGraph(store).some((e) => e.kind === "contradicts")).toBe(true);
  });

  test("corpusRevision changes on a SAME-LENGTH verdict/disputes re-target — COUNT(verdict) and the summed disputes length are unchanged, yet the contradicts edge moves", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // uses-node and uses-deno are the SAME length, so re-pointing the dispute from
    // one to the other keeps disputes_json's LENGTH — and COUNT(verdict) — exactly
    // constant. Only the disputes CONTENT moves, which a count/length fingerprint
    // cannot see; the per-row content fold must.
    expect("uses-node".length).toBe("uses-deno".length);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "uses-bun", title: "Bun" }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "uses-node", title: "Node" }));
    store.upsertDoc(doc({ id: "c", projectId: "p1", slug: "uses-deno", title: "Deno" }));

    // The resolve/reverify cron writes verdict + disputes_json WITHOUT touching
    // updated_at — here naming b (uses-node) as the contradiction target.
    store.setDocVerdict("p1", "uses-bun", "disputed", [
      { claim: formatContradictsClaim("uses-node"), finding: "opposing", evidence: "e" },
    ]);
    const before = store.corpusRevision();
    expect(
      compileGraph(store).some((e) => e.kind === "contradicts" && e.dstDocId === "b")
    ).toBe(true);

    // Re-target the SAME doc's contradiction to c (uses-deno): verdict string
    // unchanged ('disputed'), disputes_json byte-length identical, no updated_at
    // bump. The revision must still move so the memo re-derives.
    store.setDocVerdict("p1", "uses-bun", "disputed", [
      { claim: formatContradictsClaim("uses-deno"), finding: "opposing", evidence: "e" },
    ]);
    expect(store.corpusRevision()).not.toBe(before);

    // The recompile re-points the contradicts edge from b to c rather than serving
    // the stale pre-re-target edge set.
    const edges = compileGraph(store);
    expect(edges.some((e) => e.kind === "contradicts" && e.dstDocId === "c")).toBe(true);
    expect(edges.some((e) => e.kind === "contradicts" && e.dstDocId === "b")).toBe(false);
  });

  test("corpusRevision changes when the chunk embedding width changes (a provider switch), at unchanged chunk count", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "n1", projectId: "p1", slug: "n1", title: "Alpha", tags: ["uniq-a"] }));
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [1, 0, 0] });
    const before = store.corpusRevision();

    // A provider switch clears the corpus then re-embeds at a NEW width; the chunk
    // count returns to 1, so only the sampled width distinguishes the two states.
    store.clearAllChunks();
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [1, 0, 0, 0] });
    expect(store.corpusRevision()).not.toBe(before);
  });

  test("corpusRevision changes on a SAME-WIDTH re-embed — clearAllChunks + re-embed at the same width and chunk count (a swap to an equal-dimension model) still invalidates", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "n1", projectId: "p1", slug: "n1", title: "Alpha", tags: ["uniq-a"] }));
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [1, 0, 0] });
    const before = store.corpusRevision();

    // Swap to a DIFFERENT model of the SAME dimensionality: the chunk is dropped
    // then re-embedded at the SAME width (3) with a different VALUE. Chunk COUNT (1)
    // and the sampled width (3) return byte-identical and no updated_at is bumped,
    // so only the chunk-generation counter — bumped by both writes — can move the
    // revision. The de-float semantic edges ride these vectors, so a stale memo
    // here would serve wrong edges.
    store.clearAllChunks();
    store.upsertChunk({ id: "n1#0", knowledgeId: "n1", chunkIndex: 0, text: "t", embedding: [0, 1, 0] });
    expect(store.corpusRevision()).not.toBe(before);
  });

  test("corpusRevision changes on an mtime-preserving slug rename, even when every count/length is byte-identical", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Two co-cited docs (shared tag). The doc helper stamps a FIXED updatedAt —
    // exactly what an mv/rsync -a/git mv preserves — so MAX(updated_at) can't move.
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "auth-arch", title: "Arch", tags: ["auth"] }));
    store.upsertDoc(doc({ id: "b-old", projectId: "p1", slug: "auth-intent", title: "Intent", tags: ["auth"] }));
    compileGraph(store);
    const before = store.corpusRevision();

    // Rename B's file: syncProject deletes the old (id, slug) row and inserts a NEW
    // row with a fresh UUID at a SAME-LENGTH slug, title/tags unchanged. COUNT,
    // MAX(updated_at) and every text-length sum (title/tags/related/session AND even
    // SUM(LENGTH(slug)) and SUM(LENGTH(id))) stay byte-identical — only the id/slug
    // VALUES move. A length-only fingerprint would miss it; the identity fold can't.
    expect("auth-signin".length).toBe("auth-intent".length); // length-preserving
    expect("b-new".length).toBe("b-old".length);
    store.deleteDoc("p1", "auth-intent");
    store.upsertDoc(doc({ id: "b-new", projectId: "p1", slug: "auth-signin", title: "Intent", tags: ["auth"] }));

    expect(store.corpusRevision()).not.toBe(before);
  });

  test("corpusRevision moves on a same-length tag rewrite that does NOT bump updated_at (the FTS-only out-of-band sync case), so the stale co-citation edge is dropped on the next compile", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    // Two docs co-cited by a shared tag. The doc helper stamps a FIXED updatedAt —
    // exactly what an mtime-preserving, FTS-only out-of-band sync preserves — so
    // MAX(updated_at) cannot move when the tag is rewritten below.
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "signin", title: "Sign-in", tags: ["auth"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "session", title: "Session", tags: ["auth"] }));

    const first = compileGraph(store);
    const isAB = (e: (typeof first)[number]) =>
      e.kind === "co-citation" && [e.srcDocId, e.dstDocId].sort().join() === "a,b";
    expect(first.some(isAB)).toBe(true);
    const before = store.corpusRevision();

    // Rewrite a's tag to a SAME-LENGTH value (`auth` -> `pass`, both 4 chars, so
    // tags_json keeps its byte length) WITHOUT bumping updated_at. COUNT,
    // MAX(updated_at) and every length aggregate stay byte-identical — only the
    // per-row VALUE fold over tags_json can see it.
    expect("auth".length).toBe("pass".length);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "signin", title: "Sign-in", tags: ["pass"] }));
    expect(store.corpusRevision()).not.toBe(before);

    // The moved revision misses the memo, so the recompile drops the now-stale
    // co-citation edge (a and b no longer share a tag) rather than serving the
    // cached pre-rewrite edge set.
    const recompiled = compileGraph(store);
    expect(recompiled.some(isAB)).toBe(false);
  });

  test("corpusRevision is stable on an unchanged corpus and a no-op re-upsert (the identity fold never falsely invalidates the memo)", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "auth-arch", title: "Arch", tags: ["auth"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "auth-intent", title: "Intent", tags: ["auth"] }));

    const r1 = store.corpusRevision();
    // Order-independent + deterministic: a second read over the same rows matches.
    expect(store.corpusRevision()).toBe(r1);

    // A no-op resync re-upserts identical docs; upsertDoc's ON CONFLICT(project_id,
    // slug) preserves the existing id, so the identity fold — and the whole revision
    // — must not move (else the memo would recompile on every idempotent resync).
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "auth-arch", title: "Arch", tags: ["auth"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "auth-intent", title: "Intent", tags: ["auth"] }));
    expect(store.corpusRevision()).toBe(r1);
  });

  test("graph_neighbors reflects a fresh write — the memo never serves a stale neighbor set", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: ["intent"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "intent", title: "Intent" }));
    compileGraph(store); // populate the memo
    expect(store.getNeighbors("a").map((n) => n.slug)).toEqual(["intent"]);

    // A newly-written doc that `a` now links to must appear on the next compile:
    // the corpus changed, so the cache must miss, recompile, and re-persist edges
    // — the graph_neighbors (agent) read path must not serve the pre-write set.
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: ["intent", "runbook"] }));
    store.upsertDoc(doc({ id: "c", projectId: "p1", slug: "runbook", title: "Runbook" }));
    compileGraph(store);
    expect(store.getNeighbors("a").map((n) => n.slug).sort()).toEqual(["intent", "runbook"]);
  });

  test("deleting a doc drops its edges on the next compile — no stale neighbor survives the memo", () => {
    const db = new Database(":memory:");
    const store = new KnowledgeStore(db);
    store.upsertDoc(doc({ id: "a", projectId: "p1", slug: "arch", related: ["intent"] }));
    store.upsertDoc(doc({ id: "b", projectId: "p1", slug: "intent", title: "Intent" }));
    compileGraph(store); // populate the memo
    expect(store.getNeighbors("a").map((n) => n.slug)).toEqual(["intent"]);

    // Remove the target doc; the related edge must vanish rather than be served
    // from the cache (COUNT drops ⇒ corpusRevision changes ⇒ cache miss).
    store.deleteDoc("p1", "intent");
    compileGraph(store);
    expect(store.getNeighbors("a").some((n) => n.kind === "related")).toBe(false);
  });
});

describe("contradiction claim contract (writer<->reader binding)", () => {
  // The coherence WRITER (knowledge-coherence.contradictionDispute) and this
  // graph READER both go through these helpers, so the `Contradicts <slug>`
  // literal can't drift apart across the package boundary. These pin the format
  // and the prefix guard that keeps a doc<->code "disputed" claim from being read
  // as a doc<->doc contradiction.
  test("format then parse round-trips the target slug (incl. project-qualified)", () => {
    expect(formatContradictsClaim("gotchas")).toBe(`${CONTRADICTS_CLAIM_PREFIX}gotchas`);
    expect(parseContradictsClaim(formatContradictsClaim("gotchas"))).toBe("gotchas");
    expect(parseContradictsClaim(formatContradictsClaim("quillstack/build-pipeline"))).toBe(
      "quillstack/build-pipeline",
    );
  });

  test("only the exact prefix is a contradiction claim — a fact-check 'disputed' claim is not", () => {
    expect(parseContradictsClaim("The doc says X but the code says Y")).toBeNull();
    expect(parseContradictsClaim("Contradiction between A and B")).toBeNull(); // no trailing space
    expect(parseContradictsClaim("contradicts foo")).toBeNull(); // case-sensitive
  });

  test("a prefix with no target resolves to null (never a half-edge)", () => {
    expect(parseContradictsClaim(CONTRADICTS_CLAIM_PREFIX)).toBeNull();
    expect(parseContradictsClaim(`${CONTRADICTS_CLAIM_PREFIX}   `)).toBeNull();
  });
});
