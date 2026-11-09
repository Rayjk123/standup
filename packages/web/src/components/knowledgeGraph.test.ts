import { expect, test, describe } from "bun:test";
import {
  nodeMatchesSearch,
  buildNeighbors,
  buildDegree,
  buildNeighborRelations,
  rankSearchMatches,
  egoNetwork,
  radialEgoLayout,
  filterGraph,
  deemphasisReason,
  nodeSize,
  parseTimestamp,
  communitySummaries,
  NO_FILTERS,
  UNCLUSTERED,
  type GraphData,
  type GraphFilters,
  type GraphNode,
} from "./knowledgeGraph.js";
import { syntheticGraph, SYNTHETIC_NOW } from "./__fixtures__/kg-synthetic.js";

const node = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: "a",
  slug: "slug-a",
  title: "Title A",
  projectId: "p1",
  originClass: "owner",
  ...over,
});

const sample: GraphData = {
  nodes: [
    node({ id: "a", slug: "auth-flow", title: "Auth flow", projectId: "p1" }),
    node({ id: "b", slug: "db-schema", title: "DB schema", projectId: "p1" }),
    node({ id: "c", slug: "slack-adapter", title: "Slack adapter", projectId: "p2" }),
  ],
  edges: [
    {
      source: "a",
      target: "b",
      kind: "related",
      weight: 0.5,
      evidence: "frontmatter related: db-schema",
      confidence: 1,
    },
    { source: "b", target: "c", kind: "co-citation", weight: 0.2, evidence: "shared tags: retry" },
  ],
};

const filters = (over: Partial<GraphFilters> = {}): GraphFilters => ({ ...NO_FILTERS, ...over });

// a — b — c — d, plus an unlinked e.
const chain: GraphData = {
  nodes: ["a", "b", "c", "d", "e"].map((id) => node({ id, slug: id, title: id.toUpperCase() })),
  edges: [
    { source: "a", target: "b", kind: "related", weight: 1 },
    { source: "b", target: "c", kind: "co-citation", weight: 1 },
    { source: "c", target: "d", kind: "related", weight: 1 },
  ],
};
const ids = (d: GraphData) => d.nodes.map((n) => n.id).sort();

describe("filterGraph", () => {
  test("no filters keeps every node and edge", () => {
    const out = filterGraph(sample, NO_FILTERS);
    expect(out.nodes).toHaveLength(3);
    expect(out.edges).toHaveLength(2);
  });

  test("a hidden edge kind drops its edges and keeps every node", () => {
    const out = filterGraph(sample, filters({ hiddenKinds: new Set(["co-citation"]) }));
    expect(out.nodes).toHaveLength(3);
    expect(out.edges.map((e) => e.kind)).toEqual(["related"]);
  });

  test("a hidden project drops its docs and every edge touching them", () => {
    const out = filterGraph(sample, filters({ hiddenProjects: new Set(["p2"]) }));
    expect(ids(out)).toEqual(["a", "b"]);
    expect(out.edges).toHaveLength(1);
  });

  test("a hidden layer drops its docs; a doc with no layer is kept", () => {
    const data: GraphData = {
      nodes: [node({ id: "x", layer: "personal" }), node({ id: "y", layer: "docs" }), node({ id: "z" })],
      edges: [],
    };
    expect(ids(filterGraph(data, filters({ hiddenLayers: new Set(["personal"]) })))).toEqual(["y", "z"]);
  });

  test("min confidence drops docs below it; a doc with no confidence opinion passes", () => {
    const data: GraphData = {
      nodes: [node({ id: "lo", confidence: 0.2 }), node({ id: "hi", confidence: 0.9 }), node({ id: "none" })],
      edges: [],
    };
    expect(ids(filterGraph(data, filters({ minConfidence: 0.5 })))).toEqual(["hi", "none"]);
  });

  test("hiding de-emphasized docs drops contradicted, stale and untrusted ones", () => {
    const data: GraphData = {
      nodes: [
        node({ id: "ok" }),
        node({ id: "bad", verdict: "contradicted" }),
        node({ id: "old", stale: true }),
        node({ id: "anon", originClass: "untrusted" }),
      ],
      edges: [],
    };
    expect(ids(filterGraph(data, filters({ hideDeemphasized: true })))).toEqual(["ok"]);
  });

  test("hiding orphans judges the edges left after the kind filter", () => {
    expect(ids(filterGraph(chain, filters({ hideOrphans: true })))).toEqual(["a", "b", "c", "d"]);
    // With co-citation hidden the chain splits, but every doc still has an edge.
    expect(ids(filterGraph(chain, filters({ hideOrphans: true, hiddenKinds: new Set(["co-citation"]) })))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    // With every kind hidden nothing is linked.
    expect(ids(filterGraph(chain, filters({ hideOrphans: true, hiddenKinds: new Set(["co-citation", "related"]) })))).toEqual(
      []
    );
  });

  test("neighborhood mode keeps the center's hops over the visible edges", () => {
    expect(ids(filterGraph(chain, filters({ ego: { center: "a", hops: 1 } })))).toEqual(["a", "b"]);
    expect(ids(filterGraph(chain, filters({ ego: { center: "a", hops: 2 } })))).toEqual(["a", "b", "c"]);
    // A hidden kind cuts the walk: b—c is co-citation.
    expect(
      ids(filterGraph(chain, filters({ ego: { center: "a", hops: 2 }, hiddenKinds: new Set(["co-citation"]) })))
    ).toEqual(["a", "b"]);
  });

  test("neighborhood mode keeps an unlinked center even when orphans are hidden", () => {
    expect(ids(filterGraph(chain, filters({ ego: { center: "e", hops: 2 }, hideOrphans: true })))).toEqual(["e"]);
  });

  test("a neighborhood whose center is filtered out leaves the rest of the filters in force", () => {
    const out = filterGraph(chain, filters({ ego: { center: "a", hops: 1 }, hiddenProjects: new Set(["p1"]) }));
    expect(out.nodes).toHaveLength(0);
  });

  test("on the synthetic corpus every surviving edge has both ends visible", () => {
    const g = syntheticGraph();
    const out = filterGraph(g, filters({ hiddenProjects: new Set(["scratch"]), minConfidence: 0.4, hideOrphans: true }));
    const visible = new Set(out.nodes.map((n) => n.id));
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(out.nodes.length).toBeLessThan(g.nodes.length);
    for (const e of out.edges) {
      expect(visible.has(e.source) && visible.has(e.target)).toBe(true);
    }
    for (const n of out.nodes) {
      expect(n.projectId).not.toBe("scratch");
      if (n.confidence !== undefined) expect(n.confidence).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe("egoNetwork", () => {
  test("maps each reached node to its hop distance", () => {
    const d = egoNetwork(chain.edges, "b", 2);
    expect(Object.fromEntries(d)).toEqual({ b: 0, a: 1, c: 1, d: 2 });
  });

  test("zero hops is just the center", () => {
    expect([...egoNetwork(chain.edges, "b", 0).keys()]).toEqual(["b"]);
  });
});

describe("radialEgoLayout", () => {
  // b at the center: a and c on ring 1, d (reached through c) on ring 2.
  const pos = radialEgoLayout(chain.edges, "b", 2, { x: 10, y: 20 }, 5);
  const r = (id: string) => Math.hypot(pos.get(id)!.x - 10, pos.get(id)!.y - 20);

  test("puts the center at the origin and each hop on its own ring", () => {
    expect(pos.get("b")).toEqual({ x: 10, y: 20 });
    expect(r("a")).toBeCloseTo(5);
    expect(r("c")).toBeCloseTo(5);
    expect(r("d")).toBeCloseTo(10);
    expect(pos.has("e")).toBe(false);
  });

  test("is deterministic", () => {
    expect(radialEgoLayout(chain.edges, "b", 2, { x: 10, y: 20 }, 5)).toEqual(pos);
  });

  test("on the synthetic corpus every reached doc is placed on its hop's ring", () => {
    const g = syntheticGraph();
    const center = g.nodes[0].id;
    const dist = egoNetwork(g.edges, center, 2);
    const placed = radialEgoLayout(g.edges, center, 2, { x: 0, y: 0 }, 1);
    expect(placed.size).toBe(dist.size);
    for (const [id, d] of dist) {
      const p = placed.get(id)!;
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(d);
    }
  });
});

describe("deemphasisReason", () => {
  test("ranks verdict over origin over age", () => {
    expect(deemphasisReason(node({ verdict: "contradicted", stale: true, originClass: "untrusted" }))).toBe("contradicted");
    expect(deemphasisReason(node({ verdict: "disputed" }))).toBe("disputed");
    expect(deemphasisReason(node({ originClass: "system", stale: true }))).toBe("untrusted");
    expect(deemphasisReason(node({ stale: true, confidence: 0.1 }))).toBe("stale");
    expect(deemphasisReason(node({ confidence: 0.1 }))).toBe("low confidence");
  });

  test("a clean, confident or opinion-less doc is not faded", () => {
    expect(deemphasisReason(node({ verdict: "clean", confidence: 0.9 }))).toBeNull();
    expect(deemphasisReason(node())).toBeNull();
  });
});

describe("nodeSize", () => {
  const day = 864e5;
  test("grows with degree, sub-linearly, within bounds", () => {
    const sizes = [0, 1, 4, 9, 50, 500].map((d) => nodeSize("degree", d, undefined, 0));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    expect(sizes[0]).toBe(3);
    expect(sizes[5]).toBe(16);
    // Square-root growth: 4 links adds less than 4× what 1 link adds.
    expect(sizes[2] - sizes[0]).toBeLessThan(4 * (sizes[1] - sizes[0]));
  });

  test("by recency a newer doc is larger, and a missing date is the minimum", () => {
    const now = SYNTHETIC_NOW;
    const fresh = nodeSize("recency", 0, new Date(now - day).toISOString(), now);
    const old = nodeSize("recency", 0, new Date(now - 180 * day).toISOString(), now);
    expect(fresh).toBeGreaterThan(old);
    expect(nodeSize("recency", 0, undefined, now)).toBe(3);
    // A future timestamp (clock skew) never exceeds the maximum.
    expect(nodeSize("recency", 0, new Date(now + 10 * day).toISOString(), now)).toBe(16);
  });

  test("reads a SQLite UTC datetime as UTC", () => {
    expect(parseTimestamp("2026-10-01 00:00:00")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(parseTimestamp("nope")).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe("rankSearchMatches", () => {
  const nodes = [
    node({ id: "1", title: "Persona launcher policy", slug: "persona-launch" }),
    node({ id: "2", title: "Launcher", slug: "launcher" }),
    node({ id: "3", title: "Launcher worker cap", slug: "cap" }),
    node({ id: "4", title: "Relaunching sessions", slug: "relaunch" }),
    node({ id: "5", title: "Cost view", slug: "launcher-cost" }),
  ];

  test("exact, then prefix, then word start, then substring, then slug", () => {
    expect(rankSearchMatches(nodes, "launcher").map((n) => n.id)).toEqual(["2", "3", "1", "5"]);
    expect(rankSearchMatches(nodes, "launch").map((n) => n.id)).toEqual(["2", "3", "1", "4", "5"]);
  });

  test("respects the limit and returns nothing for an empty query", () => {
    expect(rankSearchMatches(nodes, "launch", 2)).toHaveLength(2);
    expect(rankSearchMatches(nodes, "   ")).toEqual([]);
  });
});

describe("communitySummaries", () => {
  test("largest community first, unclustered last, hub by degree names it", () => {
    const communities = new Map([
      ["a", 1],
      ["b", 0],
      ["c", 0],
      ["d", 0],
      ["e", UNCLUSTERED],
    ]);
    const degree = buildDegree(chain.edges);
    const out = communitySummaries(chain, communities, degree);
    expect(out.map((c) => c.id)).toEqual([0, 1, UNCLUSTERED]);
    // b and c tie on degree; the alphabetically first title wins.
    expect(out[0]).toMatchObject({ size: 3, hubId: "b", label: "B" });
    expect(out[2].label).toBe("Unclustered");
  });
});

describe("nodeMatchesSearch", () => {
  const n = node({ title: "Auth flow", slug: "auth-flow", projectId: "p1" });

  test("case-insensitive substring on the title", () => {
    expect(nodeMatchesSearch(n, "AUTH")).toBe(true);
    expect(nodeMatchesSearch(n, "flow")).toBe(true);
  });

  test("case-insensitive substring on the slug", () => {
    expect(nodeMatchesSearch(n, "auth-fl")).toBe(true);
  });

  test("no match returns false", () => {
    expect(nodeMatchesSearch(n, "schema")).toBe(false);
  });

  test("empty or whitespace query matches everything", () => {
    expect(nodeMatchesSearch(n, "")).toBe(true);
    expect(nodeMatchesSearch(n, "   ")).toBe(true);
  });

  test("optional project filter excludes other projects even on a text hit", () => {
    expect(nodeMatchesSearch(n, "auth", "p1")).toBe(true);
    expect(nodeMatchesSearch(n, "auth", "p2")).toBe(false);
  });

  test("project filter with an empty query keeps only that project's nodes", () => {
    expect(nodeMatchesSearch(n, "", "p1")).toBe(true);
    expect(nodeMatchesSearch(n, "", "p2")).toBe(false);
  });
});

describe("buildNeighbors", () => {
  test("adjacency is undirected", () => {
    const nbr = buildNeighbors(sample.edges);
    expect([...(nbr.get("a") ?? [])]).toEqual(["b"]);
    expect([...(nbr.get("b") ?? [])].sort()).toEqual(["a", "c"]);
    expect([...(nbr.get("c") ?? [])]).toEqual(["b"]);
  });
});

describe("buildDegree", () => {
  test("counts every incident edge", () => {
    const deg = buildDegree(sample.edges);
    expect(deg.get("a")).toBe(1);
    expect(deg.get("b")).toBe(2);
    expect(deg.get("c")).toBe(1);
  });
});

describe("buildNeighborRelations", () => {
  test("maps each neighbor to its relation kind, both directions, carrying evidence", () => {
    const rel = buildNeighborRelations(sample.edges);
    expect(rel.get("a")?.get("b")?.kind).toBe("related");
    expect(rel.get("b")?.get("a")?.kind).toBe("related");
    expect(rel.get("b")?.get("c")?.kind).toBe("co-citation");
    expect(rel.get("c")?.get("b")?.kind).toBe("co-citation");
    // The winning edge's evidence rides along so the rail can show WHY.
    expect(rel.get("a")?.get("b")?.evidence).toBe("frontmatter related: db-schema");
    expect(rel.get("b")?.get("c")?.evidence).toBe("shared tags: retry");
  });

  test("keeps the strongest relation when a pair is linked more than one way", () => {
    const rel = buildNeighborRelations([
      { source: "a", target: "b", kind: "provenance", weight: 1 },
      { source: "a", target: "b", kind: "related", weight: 1, evidence: "frontmatter related: b" },
      { source: "a", target: "b", kind: "co-citation", weight: 1 },
    ]);
    // The strongest kind wins AND its own evidence comes with it.
    expect(rel.get("a")?.get("b")?.kind).toBe("related");
    expect(rel.get("a")?.get("b")?.evidence).toBe("frontmatter related: b");
  });

  test("a contradicts edge outranks a co-citation edge on the same pair", () => {
    // Contradicting docs usually share a tag, so deriveEdges emits BOTH a
    // co-citation and a contradicts edge for the pair (co-citation first). The
    // conflict must still win the label AND surface its finding.
    const rel = buildNeighborRelations([
      { source: "a", target: "b", kind: "co-citation", weight: 1, evidence: "shared tags: runtime" },
      { source: "a", target: "b", kind: "contradicts", weight: 2, evidence: "Bun vs Node" },
    ]);
    expect(rel.get("a")?.get("b")?.kind).toBe("contradicts");
    expect(rel.get("b")?.get("a")?.kind).toBe("contradicts");
    expect(rel.get("a")?.get("b")?.evidence).toBe("Bun vs Node");
    expect(rel.get("a")?.get("b")?.weight).toBe(2);
  });
});
