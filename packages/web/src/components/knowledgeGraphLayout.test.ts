import { expect, test, describe } from "bun:test";
import {
  buildGraphology,
  detectCommunities,
  computeLayout,
  layoutGraph,
  seededRandom,
  MIN_COMMUNITY_SIZE,
} from "./knowledgeGraphLayout.js";
import { UNCLUSTERED, type GraphData, type GraphNode } from "./knowledgeGraph.js";
import { syntheticGraph } from "./__fixtures__/kg-synthetic.js";

const node = (id: string, projectId = "p1"): GraphNode => ({ id, slug: id, title: id, projectId, originClass: "owner" });

// Two triangles joined by one weak bridge, plus a linked pair and a loner.
const twoTriangles: GraphData = {
  nodes: ["a1", "a2", "a3", "b1", "b2", "b3", "p", "q", "z"].map((id) => node(id)),
  edges: [
    { source: "a1", target: "a2", kind: "related", weight: 1 },
    { source: "a2", target: "a3", kind: "related", weight: 1 },
    { source: "a1", target: "a3", kind: "related", weight: 1 },
    { source: "b1", target: "b2", kind: "related", weight: 1 },
    { source: "b2", target: "b3", kind: "related", weight: 1 },
    { source: "b1", target: "b3", kind: "related", weight: 1 },
    { source: "a3", target: "b1", kind: "co-citation", weight: 0.1 },
    { source: "p", target: "q", kind: "related", weight: 1 },
  ],
};

describe("seededRandom", () => {
  test("is deterministic per seed and stays in [0, 1)", () => {
    const a = seededRandom(5);
    const b = seededRandom(5);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(seededRandom(6)()).not.toBe(xs[0]);
  });
});

describe("buildGraphology", () => {
  test("merges a pair linked several ways into one edge carrying its strongest kind", () => {
    const g = buildGraphology({
      nodes: [node("a"), node("b")],
      edges: [
        { source: "a", target: "b", kind: "co-citation", weight: 0.4 },
        { source: "b", target: "a", kind: "contradicts", weight: 0.2 },
        { source: "a", target: "a", kind: "related", weight: 1 },
        { source: "a", target: "ghost", kind: "related", weight: 1 },
      ],
    });
    expect(g.size).toBe(1);
    const attrs = g.getEdgeAttributes(g.edges()[0]);
    expect(attrs.kind).toBe("contradicts");
    expect(attrs.weight).toBe(0.4);
    expect(attrs.kinds.sort()).toEqual(["co-citation", "contradicts"]);
  });
});

describe("detectCommunities", () => {
  test("separates two triangles and leaves small groups unclustered", () => {
    const c = detectCommunities(twoTriangles);
    expect(c.get("a1")).toBe(c.get("a2"));
    expect(c.get("a1")).toBe(c.get("a3"));
    expect(c.get("b1")).toBe(c.get("b3"));
    expect(c.get("a1")).not.toBe(c.get("b1"));
    // The pair and the loner are below MIN_COMMUNITY_SIZE.
    expect(c.get("p")).toBe(UNCLUSTERED);
    expect(c.get("z")).toBe(UNCLUSTERED);
    expect(new Set([c.get("a1"), c.get("b1")])).toEqual(new Set([0, 1]));
  });

  test("is deterministic and numbers communities largest first", () => {
    const g = syntheticGraph();
    const first = detectCommunities(g);
    const second = detectCommunities(syntheticGraph());
    expect([...second]).toEqual([...first]);

    const sizes = new Map<number, number>();
    for (const c of first.values()) if (c !== UNCLUSTERED) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const ordered = [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]).toBeLessThanOrEqual(ordered[i - 1]);
    for (const s of ordered) expect(s).toBeGreaterThanOrEqual(MIN_COMMUNITY_SIZE);
    // A topic-structured corpus splits into a handful of real clusters, not one
    // blob and not hundreds of crumbs.
    expect(sizes.size).toBeGreaterThanOrEqual(5);
    expect(sizes.size).toBeLessThanOrEqual(40);
  });

  test("a graph with no edges is entirely unclustered", () => {
    const c = detectCommunities({ nodes: [node("x"), node("y")], edges: [] });
    expect([...c.values()]).toEqual([UNCLUSTERED, UNCLUSTERED]);
  });

  test("recovers the planted topics of the synthetic corpus", () => {
    // Most docs of one planted topic should share a community.
    const g = syntheticGraph();
    const c = detectCommunities(g);
    const byTopic = new Map<string, Map<number, number>>();
    for (const n of g.nodes) {
      const t = g.topicOf.get(n.id)!;
      if (!byTopic.has(t)) byTopic.set(t, new Map());
      const m = byTopic.get(t)!;
      const cid = c.get(n.id)!;
      m.set(cid, (m.get(cid) ?? 0) + 1);
    }
    let agree = 0;
    for (const m of byTopic.values()) agree += Math.max(...m.values());
    expect(agree / g.nodes.length).toBeGreaterThan(0.7);
  });
});

describe("computeLayout", () => {
  test("positions every node with finite coordinates, deterministically", () => {
    const g = syntheticGraph();
    const c = detectCommunities(g);
    const a = computeLayout(g, c, { iterations: 60 });
    const b = computeLayout(g, c, { iterations: 60 });
    expect(Object.keys(a)).toHaveLength(g.nodes.length);
    for (const n of g.nodes) {
      expect(Number.isFinite(a[n.id].x) && Number.isFinite(a[n.id].y)).toBe(true);
    }
    expect(b).toEqual(a);
  });

  test("rings unlinked docs outside the connected layout", () => {
    const c = detectCommunities(twoTriangles);
    const pos = computeLayout(twoTriangles, c, { iterations: 100 });
    const linked = ["a1", "a2", "a3", "b1", "b2", "b3", "p", "q"].map((id) => pos[id]);
    const cx = linked.reduce((s, p) => s + p.x, 0) / linked.length;
    const cy = linked.reduce((s, p) => s + p.y, 0) / linked.length;
    const extent = Math.max(...linked.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    expect(Math.hypot(pos.z.x - cx, pos.z.y - cy)).toBeGreaterThan(extent);
  });

  test("a community sits closer to itself than to another community", () => {
    const c = detectCommunities(twoTriangles);
    const pos = computeLayout(twoTriangles, c, { iterations: 200 });
    const d = (u: string, v: string) => Math.hypot(pos[u].x - pos[v].x, pos[u].y - pos[v].y);
    expect(d("a1", "a2")).toBeLessThan(d("a1", "b2"));
    expect(d("b2", "b3")).toBeLessThan(d("b2", "a2"));
  });

  test("layoutGraph returns communities and positions for every node", () => {
    const r = layoutGraph(twoTriangles);
    expect(r.communities).toHaveLength(twoTriangles.nodes.length);
    expect(Object.keys(r.positions).sort()).toEqual(twoTriangles.nodes.map((n) => n.id).sort());
  });
});
