// A deterministic synthetic knowledge graph shaped like the live corpus: ~370
// docs over three projects, ~540 edges, topic communities with a few hubs, a
// median degree around 3 and a handful of `contradicts` edges. Seeded, so tests
// and the offline screenshot harness see the same graph on every run.

import type { GraphData, GraphEdge, GraphNode } from "../knowledgeGraph";

const TOPICS = [
  "knowledge-graph",
  "launcher",
  "persona",
  "tickets",
  "embeddings",
  "slack",
  "mcp-tools",
  "review-loop",
  "worktrees",
  "cost",
  "schedules",
  "ui-console",
  "auth-tunnel",
  "eval-harness",
  "monorepo",
  "code-review",
  "infra",
  "sqlite-store",
];

const PROJECTS: Array<[string, number]> = [
  ["standup", 290],
  ["acme-web", 50],
  ["scratch", 30],
];

const LAYERS: NonNullable<GraphNode["layer"]>[] = ["docs", "docs", "docs", "intent", "activity", "personal"];

// Fixed "now" so recency-derived values never drift between runs.
export const SYNTHETIC_NOW = Date.parse("2026-10-01T00:00:00Z");

export function syntheticGraph(seed = 42): GraphData & { topicOf: Map<string, string> } {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;

  const nodes: GraphNode[] = [];
  const topicOf = new Map<string, string>();
  let i = 0;
  for (const [projectId, count] of PROJECTS) {
    for (let k = 0; k < count; k++) {
      const topic = TOPICS[Math.floor(rnd() ** 1.3 * TOPICS.length)];
      const id = `d${i++}`;
      const verdictRoll = rnd();
      nodes.push({
        id,
        slug: `${topic}-${k}`,
        title: `${topic.replace(/-/g, " ")} — note ${k}`,
        projectId,
        originClass: rnd() < 0.1 ? "untrusted" : "accepted",
        verdict: verdictRoll < 0.03 ? "contradicted" : verdictRoll < 0.08 ? "disputed" : verdictRoll < 0.5 ? "clean" : undefined,
        layer: LAYERS[Math.floor(rnd() * LAYERS.length)],
        confidence: Math.round((0.1 + rnd() * 0.9) * 100) / 100,
        stale: rnd() < 0.08,
        updatedAt: new Date(SYNTHETIC_NOW - rnd() * 200 * 864e5).toISOString(),
      });
      topicOf.set(id, topic);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, kind: GraphEdge["kind"]) => {
    if (a === b) return;
    const key = `${kind}|${Math.min(a, b)}|${Math.max(a, b)}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source: nodes[a].id,
      target: nodes[b].id,
      kind,
      weight: Math.round((0.3 + rnd() * 0.7) * 100) / 100,
      evidence: kind === "contradicts" ? "claims disagree on the default port" : `shared tags: ${topicOf.get(nodes[a].id)}`,
    });
  };

  const byTopic = new Map<string, number[]>();
  nodes.forEach((n, ix) => {
    const t = topicOf.get(n.id)!;
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t)!.push(ix);
  });
  for (let a = 0; a < nodes.length; a++) {
    const peers = byTopic.get(topicOf.get(nodes[a].id)!)!;
    const degree = Math.floor(rnd() * rnd() * 4) + 1;
    for (let d = 0; d < degree && edges.length < 620; d++) {
      const target = rnd() < 0.3 ? peers[0] : peers[Math.floor(rnd() * peers.length)];
      add(a, rnd() < 0.08 ? Math.floor(rnd() * nodes.length) : target, rnd() < 0.55 ? "co-citation" : "related");
    }
  }
  for (let c = 0; c < 8; c++) {
    const peers = byTopic.get(TOPICS[c]);
    if (peers && peers.length > 2) add(peers[1], peers[2], "contradicts");
  }

  return { nodes, edges, topicOf };
}
