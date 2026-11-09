// Shapes and pure transforms for the knowledge Graph view: which nodes and
// edges a set of filters leaves visible, a node's 1–2 hop neighborhood, node
// sizing, which docs to de-emphasize, search ranking, and per-community
// summaries. Everything here is pure (no canvas, no graph library), so it is
// unit-tested directly; layout and community detection live in
// knowledgeGraphLayout.ts.

// The layers layerOf (@standup/knowledge) places a doc in. `code` holds no
// stored doc, so a graph node is never in it.
export type KnowledgeLayer = "personal" | "intent" | "docs" | "activity";

// Display order for the layer filter: shared docs first, the personal layer last.
export const LAYER_ORDER: readonly KnowledgeLayer[] = ["docs", "intent", "activity", "personal"];

export interface GraphNode {
  id: string;
  slug: string;
  title: string;
  projectId: string;
  originClass: string;
  // Re-verification verdict, so the detail rail can flag a contradicted/disputed/
  // superseded neighbor. Undefined for a doc that has never been re-verified.
  verdict?:
    | "unverified"
    | "unverifiable"
    | "clean"
    | "disputed"
    | "error"
    | "contradicted"
    | "superseded";
  scope?: string;
  sourceKind?: string;
  layer?: KnowledgeLayer;
  // When the indexed row was last written (ISO or SQLite UTC datetime).
  updatedAt?: string;
  // Current derived confidence, 0..1. Undefined when the doc has no opinion.
  confidence?: number;
  // Decay took the doc below the injection floor with no re-verification to
  // lift it back.
  stale?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  // `semantic-similarity` is the de-float edge: an inferred link the compile
  // pass adds from an otherwise-disconnected doc to its nearest neighbor(s), so
  // a graph of singletons is still navigable. Weaker than the four authored/
  // derived kinds — see RELATION_RANK.
  kind: "related" | "co-citation" | "provenance" | "contradicts" | "semantic-similarity";
  weight: number;
  // Why the two docs are linked — the named shared tags, the dispute finding —
  // so hovering an edge and each neighbor row can read the relationship's value,
  // not just its colored kind. Undefined for an edge that recorded none.
  evidence?: string;
  confidence?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Case-insensitive substring match on title or slug, with an optional project
// filter. An empty query matches every node (subject to the project filter), so
// clearing the search box restores the full set.
export function nodeMatchesSearch(
  node: GraphNode,
  query: string,
  projectId?: string
): boolean {
  if (projectId && node.projectId !== projectId) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    node.title.toLowerCase().includes(q) || node.slug.toLowerCase().includes(q)
  );
}

// How well a node matches a query, lower is better, or null for no match: an
// exact title, then a title prefix, then a word in the title starting with the
// query, then a substring of the title, then a substring of the slug.
function searchRank(node: GraphNode, q: string): number | null {
  const title = node.title.toLowerCase();
  if (title === q) return 0;
  if (title.startsWith(q)) return 1;
  if (title.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
  if (title.includes(q)) return 3;
  if (node.slug.toLowerCase().includes(q)) return 4;
  return null;
}

// The best `limit` matches for a typeahead, best first. Ties go to the shorter
// title (the more specific doc), then alphabetical, so the order is stable.
export function rankSearchMatches(nodes: GraphNode[], query: string, limit = 8): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ node: GraphNode; rank: number }> = [];
  for (const node of nodes) {
    const rank = searchRank(node, q);
    if (rank !== null) scored.push({ node, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.node.title.length - b.node.title.length ||
      a.node.title.localeCompare(b.node.title)
  );
  return scored.slice(0, limit).map((s) => s.node);
}

// Undirected adjacency from the edge list, keyed by node id. Used to highlight a
// node's immediate neighborhood on hover/click.
export function buildNeighbors(edges: GraphEdge[]): Map<string, Set<string>> {
  const nbr = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!nbr.has(e.source)) nbr.set(e.source, new Set());
    if (!nbr.has(e.target)) nbr.set(e.target, new Set());
    nbr.get(e.source)!.add(e.target);
    nbr.get(e.target)!.add(e.source);
  }
  return nbr;
}

// Distinct neighbors per node — a pair linked more than one way counts once —
// for sizing nodes and picking hubs.
export function buildDegree(edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const [id, nbrs] of buildNeighbors(edges)) deg.set(id, nbrs.size);
  return deg;
}

// Rank so the strongest relation wins when a node pair is linked more than one
// way — a coherence-flagged 'contradicts' conflict is the most important thing
// to surface, then a concrete 'related' edge over a mere shared-citation or
// provenance link. Contradicting docs usually share a tag too, so a pair often
// carries both a co-citation and a contradicts edge; contradicts must win. A
// 'semantic-similarity' de-float edge is the weakest — an inferred link, so any
// authored/derived relation on the same pair outranks it.
export const RELATION_RANK: Record<GraphEdge["kind"], number> = {
  contradicts: 4,
  related: 3,
  "co-citation": 2,
  provenance: 1,
  "semantic-similarity": 0,
};

// The strongest relation connecting a node pair, plus that edge's own signal.
// Carries the winning edge's evidence + weight alongside the kind so the detail
// rail can say WHY each neighbor is related ("co-citation · dynamodb, cdk"), not
// just its kind.
export interface NeighborRelation {
  kind: GraphEdge["kind"];
  evidence?: string;
  weight: number;
}

// Neighbor id → the relation connecting it, keyed by node id. Lets the detail
// rail label HOW each neighbor is related (not just that it is) and surface the
// relation's evidence, so a reader can traverse along a specific relation kind
// and see its substance. When a pair is linked more than one way, the
// highest-ranked kind's edge wins (see RELATION_RANK), carrying its evidence.
export function buildNeighborRelations(
  edges: GraphEdge[]
): Map<string, Map<string, NeighborRelation>> {
  const m = new Map<string, Map<string, NeighborRelation>>();
  const add = (a: string, b: string, e: GraphEdge) => {
    if (!m.has(a)) m.set(a, new Map());
    const inner = m.get(a)!;
    const cur = inner.get(b);
    if (!cur || RELATION_RANK[e.kind] > RELATION_RANK[cur.kind]) {
      inner.set(b, { kind: e.kind, evidence: e.evidence, weight: e.weight });
    }
  };
  for (const e of edges) {
    add(e.source, e.target, e);
    add(e.target, e.source, e);
  }
  return m;
}

// The undirected key for a node pair, the same whichever end is the source.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Below this current confidence a doc is out of auto-injection (the knowledge
// package's MIN_INJECTION_CONFIDENCE default), so the graph fades it.
export const LOW_CONFIDENCE = 0.25;

export type DeemphasisReason = "contradicted" | "disputed" | "untrusted" | "stale" | "low confidence";

// Why the graph fades a doc — retrieval would distrust it — or null when it
// doesn't. A coherence/re-verification verdict wins over origin, origin over
// age, so the reason shown is the most serious one.
export function deemphasisReason(node: GraphNode): DeemphasisReason | null {
  if (node.verdict === "contradicted") return "contradicted";
  if (node.verdict === "disputed") return "disputed";
  if (node.originClass === "untrusted" || node.originClass === "system") return "untrusted";
  if (node.stale) return "stale";
  if (node.confidence !== undefined && node.confidence < LOW_CONFIDENCE) return "low confidence";
  return null;
}

export interface GraphFilters {
  hiddenKinds: ReadonlySet<string>;
  hiddenProjects: ReadonlySet<string>;
  hiddenLayers: ReadonlySet<string>;
  // Docs below this current confidence are hidden; a doc with no confidence
  // opinion always passes.
  minConfidence: number;
  // Hide docs left with no visible edge.
  hideOrphans: boolean;
  hideDeemphasized: boolean;
  // Restrict to a node's neighborhood within `hops` visible edges.
  ego: { center: string; hops: number } | null;
}

export const NO_FILTERS: GraphFilters = {
  hiddenKinds: new Set(),
  hiddenProjects: new Set(),
  hiddenLayers: new Set(),
  minConfidence: 0,
  hideOrphans: false,
  hideDeemphasized: false,
  ego: null,
};

// Node id → hop distance from `center` over `edges`, out to `hops`. The center
// is at 0. Empty when the center has no entry in the edge list and isn't given.
export function egoNetwork(edges: GraphEdge[], center: string, hops: number): Map<string, number> {
  const nbrs = buildNeighbors(edges);
  const dist = new Map<string, number>([[center, 0]]);
  let frontier = [center];
  for (let d = 1; d <= hops && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of nbrs.get(id) ?? []) {
        if (dist.has(nb)) continue;
        dist.set(nb, d);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return dist;
}

// Positions for a neighborhood view: the center at `origin`, each hop on its
// own ring `spacing` further out. Ring 1 is spread evenly; each ring-2 doc sits
// near the ring-1 doc that reaches it (its first by angle), so branches read as
// branches. Order within a ring is stable (by id), so a reopened neighborhood
// looks the same.
export function radialEgoLayout(
  edges: GraphEdge[],
  center: string,
  hops: number,
  origin: { x: number; y: number },
  spacing: number
): Map<string, { x: number; y: number }> {
  const dist = egoNetwork(edges, center, hops);
  const nbrs = buildNeighbors(edges);
  const out = new Map<string, { x: number; y: number }>([[center, origin]]);
  const angle = new Map<string, number>([[center, 0]]);
  for (let d = 1; d <= hops; d++) {
    const ring = [...dist.entries()].filter(([, h]) => h === d).map(([id]) => id);
    // Each doc's anchor angle: its parent's on the previous ring (the smallest
    // one, for determinism); ring 1 has no anchor and keeps id order.
    const anchor = (id: string) => {
      if (d === 1) return 0;
      const parents = [...(nbrs.get(id) ?? [])].filter((p) => dist.get(p) === d - 1);
      return Math.min(...parents.map((p) => angle.get(p) ?? 0));
    };
    ring.sort((a, b) => anchor(a) - anchor(b) || a.localeCompare(b));
    ring.forEach((id, i) => {
      const theta = (2 * Math.PI * i) / ring.length - Math.PI / 2;
      angle.set(id, theta + Math.PI / 2);
      out.set(id, { x: origin.x + d * spacing * Math.cos(theta), y: origin.y + d * spacing * Math.sin(theta) });
    });
  }
  return out;
}

// The subgraph the filters leave visible. Node filters (project, layer,
// confidence, de-emphasis) apply first; an edge survives when its kind is shown
// and both ends do; the neighborhood restriction then walks the surviving
// edges; orphan hiding runs last so it judges the edges actually on screen. The
// neighborhood center is kept even with no edge, so the view never empties
// under the reader's selection.
export function filterGraph(data: GraphData, f: GraphFilters): GraphData {
  let nodes = data.nodes.filter(
    (n) =>
      !f.hiddenProjects.has(n.projectId) &&
      !(n.layer && f.hiddenLayers.has(n.layer)) &&
      !(n.confidence !== undefined && n.confidence < f.minConfidence) &&
      !(f.hideDeemphasized && deemphasisReason(n) !== null)
  );
  let ids = new Set(nodes.map((n) => n.id));
  let edges = data.edges.filter((e) => !f.hiddenKinds.has(e.kind) && ids.has(e.source) && ids.has(e.target));

  if (f.ego && ids.has(f.ego.center)) {
    const reach = egoNetwork(edges, f.ego.center, f.ego.hops);
    nodes = nodes.filter((n) => reach.has(n.id));
    ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }

  if (f.hideOrphans) {
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    if (f.ego) linked.add(f.ego.center);
    nodes = nodes.filter((n) => linked.has(n.id));
  }
  return { nodes, edges };
}

export type SizeMode = "degree" | "recency";

const MIN_NODE_SIZE = 3;
const MAX_NODE_SIZE = 16;
// Recency sizing halves a doc's extra size every this many days.
const RECENCY_HALF_LIFE_DAYS = 45;

// A stored timestamp as epoch ms. SQLite's `YYYY-MM-DD HH:MM:SS` carries no zone
// but is UTC, so it is read as UTC rather than local time.
export function parseTimestamp(ts: string | undefined): number | null {
  if (!ts) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts) ? `${ts.replace(" ", "T")}Z` : ts;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Node radius in screen pixels. By degree it grows with the square root, so a
// hub reads as a hub without dwarfing the map; by recency a doc written today is
// largest and the size decays with age. Both are clamped to one range.
export function nodeSize(mode: SizeMode, degree: number, updatedAt: string | undefined, now: number): number {
  let size: number;
  if (mode === "degree") {
    size = MIN_NODE_SIZE + 2.4 * Math.sqrt(Math.max(0, degree));
  } else {
    const ms = parseTimestamp(updatedAt);
    if (ms === null) return MIN_NODE_SIZE;
    const ageDays = Math.max(0, (now - ms) / 864e5);
    size = MIN_NODE_SIZE + (MAX_NODE_SIZE - MIN_NODE_SIZE) * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  }
  return Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_SIZE, size));
}

// The community id for docs in no cluster large enough to name.
export const UNCLUSTERED = -1;

export interface CommunitySummary {
  id: number;
  size: number;
  // The best-connected doc in the community; its title names the community.
  hubId: string;
  label: string;
}

// One summary per community, largest first, with the unclustered bucket (if
// any) last. The hub is the highest-degree member, ties going to the
// alphabetically first title so the label is stable.
export function communitySummaries(
  data: GraphData,
  communities: ReadonlyMap<string, number>,
  degree: ReadonlyMap<string, number>
): CommunitySummary[] {
  const groups = new Map<number, GraphNode[]>();
  for (const n of data.nodes) {
    const c = communities.get(n.id) ?? UNCLUSTERED;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(n);
  }
  const out: CommunitySummary[] = [];
  for (const [id, members] of groups) {
    const hub = members.reduce((best, n) => {
      const d = degree.get(n.id) ?? 0;
      const bd = degree.get(best.id) ?? 0;
      return d > bd || (d === bd && n.title.localeCompare(best.title) < 0) ? n : best;
    });
    out.push({
      id,
      size: members.length,
      hubId: hub.id,
      label: id === UNCLUSTERED ? "Unclustered" : hub.title,
    });
  }
  out.sort((a, b) => {
    if (a.id === UNCLUSTERED) return 1;
    if (b.id === UNCLUSTERED) return -1;
    return b.size - a.size || a.id - b.id;
  });
  return out;
}
