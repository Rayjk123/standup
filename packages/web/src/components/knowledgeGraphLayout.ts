// Community detection and layout for the knowledge Graph view, on graphology.
// Both are deterministic: Louvain runs on a seeded RNG and ForceAtlas2 starts
// from seeded positions, so the same corpus lays out the same way on every
// load. They run in a worker (knowledgeGraphLayout.worker.ts) so the main
// thread stays responsive, and are plain functions so tests can call them.

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { RELATION_RANK, UNCLUSTERED, pairKey, type GraphData, type GraphEdge } from "./knowledgeGraph";

export type Positions = Record<string, { x: number; y: number }>;

// Communities smaller than this are folded into UNCLUSTERED: a pair or a lone
// doc isn't a topic worth a color and a legend row.
export const MIN_COMMUNITY_SIZE = 3;

// mulberry32: a small seeded PRNG, uniform on [0, 1).
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MergedEdgeAttributes {
  weight: number;
  // The strongest kind on the pair (RELATION_RANK) and every kind it carries.
  kind: GraphEdge["kind"];
  kinds: GraphEdge["kind"][];
}

// An undirected simple graph of the corpus: one edge per linked pair, keyed by
// pairKey, carrying the pair's strongest kind and largest weight. Self-loops and
// edges to a doc not in `data.nodes` are dropped.
export function buildGraphology(data: GraphData): Graph<Record<string, unknown>, MergedEdgeAttributes> {
  const g = new Graph<Record<string, unknown>, MergedEdgeAttributes>({ type: "undirected", multi: false });
  for (const n of data.nodes) g.addNode(n.id);
  for (const e of data.edges) {
    if (e.source === e.target || !g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    const key = pairKey(e.source, e.target);
    if (g.hasEdge(key)) {
      const cur = g.getEdgeAttributes(key);
      g.mergeEdgeAttributes(key, {
        weight: Math.max(cur.weight, e.weight),
        kind: RELATION_RANK[e.kind] > RELATION_RANK[cur.kind] ? e.kind : cur.kind,
        kinds: cur.kinds.includes(e.kind) ? cur.kinds : [...cur.kinds, e.kind],
      });
    } else {
      g.addUndirectedEdgeWithKey(key, e.source, e.target, { weight: e.weight, kind: e.kind, kinds: [e.kind] });
    }
  }
  return g;
}

// Node id → community id from Louvain modularity over the whole graph (every
// edge kind, weighted). Communities are renumbered largest first, ties broken by
// their alphabetically first member, so ids — and the colors keyed on them —
// are stable for a given corpus. Members of a community under minSize get
// UNCLUSTERED.
export function detectCommunities(
  data: GraphData,
  { seed = 7, minSize = MIN_COMMUNITY_SIZE }: { seed?: number; minSize?: number } = {}
): Map<string, number> {
  const out = new Map<string, number>();
  const g = buildGraphology(data);
  if (g.size === 0) {
    for (const n of data.nodes) out.set(n.id, UNCLUSTERED);
    return out;
  }
  const raw = louvain(g, { rng: seededRandom(seed), getEdgeWeight: "weight" });
  const groups = new Map<number, string[]>();
  for (const [id, c] of Object.entries(raw)) {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(id);
  }
  const ordered = [...groups.values()]
    .map((members) => members.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  let next = 0;
  for (const members of ordered) {
    const id = members.length >= minSize ? next++ : UNCLUSTERED;
    for (const m of members) out.set(m, id);
  }
  return out;
}

// How much an edge between two communities pulls in the layout, relative to an
// edge inside one. Damping the bridges lets each community settle as its own
// island instead of the whole corpus collapsing into one disk; the edges are
// still drawn at their real weight.
const CROSS_COMMUNITY_PULL = 0.15;

// Positions for every node. Connected docs get ForceAtlas2 from a seeded start
// that already groups each community around its own point on a circle, which
// both speeds convergence and keeps the arrangement stable. Strong gravity keeps
// the islands compact around the center rather than drifting apart. Docs with
// no edge at all would otherwise be dragged into the middle by gravity, so they
// are set on a ring around the connected layout instead.
export function computeLayout(
  data: GraphData,
  communities: ReadonlyMap<string, number>,
  { seed = 11, iterations }: { seed?: number; iterations?: number } = {}
): Positions {
  const rnd = seededRandom(seed);
  const g = buildGraphology(data);
  const connected = data.nodes.filter((n) => g.hasNode(n.id) && g.degree(n.id) > 0).map((n) => n.id);
  const isolated = data.nodes.filter((n) => !g.hasNode(n.id) || g.degree(n.id) === 0);
  for (const id of isolated.map((n) => n.id)) if (g.hasNode(id)) g.dropNode(id);

  const clusterIds = [...new Set(connected.map((id) => communities.get(id) ?? UNCLUSTERED))].sort((a, b) => a - b);
  const radius = 60 * Math.sqrt(Math.max(1, clusterIds.length));
  const centers = new Map<number, { x: number; y: number }>();
  clusterIds.forEach((c, i) => {
    const angle = (2 * Math.PI * i) / clusterIds.length;
    centers.set(c, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  });
  for (const id of connected) {
    const c = centers.get(communities.get(id) ?? UNCLUSTERED)!;
    const angle = rnd() * 2 * Math.PI;
    const r = 20 * Math.sqrt(rnd());
    g.mergeNodeAttributes(id, { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) });
  }

  const positions: Positions = {};
  if (g.order > 0) {
    const n = g.order;
    const pull = (source: string, target: string, weight: number) => {
      const c = communities.get(source) ?? UNCLUSTERED;
      return c !== UNCLUSTERED && c === communities.get(target) ? weight : weight * CROSS_COMMUNITY_PULL;
    };
    const result = forceAtlas2(g, {
      iterations: iterations ?? (n <= 600 ? 300 : 200),
      getEdgeWeight: (_edge, attrs, source, target) => pull(source, target, attrs.weight),
      settings: {
        ...forceAtlas2.inferSettings(g),
        linLogMode: false,
        strongGravityMode: true,
        gravity: 0.05,
        scalingRatio: 10,
        edgeWeightInfluence: 1,
        barnesHutOptimize: n > 800,
      },
    });
    Object.assign(positions, result);
  }

  // Ring the isolated docs just outside the connected layout, ordered by
  // project then title so floaters from one project sit together.
  if (isolated.length > 0) {
    let cx = 0;
    let cy = 0;
    let extent = 1;
    const pts = Object.values(positions);
    if (pts.length > 0) {
      cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      extent = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy)), 1);
    }
    const ringR = pts.length > 0 ? extent * 1.15 : 50;
    const sorted = [...isolated].sort(
      (a, b) => a.projectId.localeCompare(b.projectId) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    );
    sorted.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2;
      positions[node.id] = { x: cx + ringR * Math.cos(angle), y: cy + ringR * Math.sin(angle) };
    });
  }
  return positions;
}

export interface LayoutResult {
  communities: Array<[string, number]>;
  positions: Positions;
}

// Communities then positions — the worker's whole job, and the main-thread
// fallback where workers are unavailable.
export function layoutGraph(data: GraphData): LayoutResult {
  const communities = detectCommunities(data);
  return { communities: [...communities], positions: computeLayout(data, communities) };
}
