---
title: "Graph rerank default flipped ON"
source_kind: decision
origin_class: owner
verdict: contradicted
generated_at: "2026-09-20T12:00:00Z"
tags: [knowledge, graph, rerank, search]
---
# Graph rerank default flipped ON

## Decision

On 2026-09-20 the graph rerank stage of knowledge search was switched to **default ON**:
`GRAPH_RERANK_DEFAULT = true` in `src/knowledge/search.ts`. Callers can still pass `graph: false`.

## What the rerank does

After RRF blending, `graphRerank()` (in `src/knowledge/graph.ts`) adds a bounded bonus to candidates that are graph
neighbors of other top candidates. The intent is to pull in "bridge" docs that answer a question only in combination
with a higher-ranked doc.

## Evidence used

- Bridge fixtures: on 8 synthetic bridge questions the rerank moved the bridge doc into the top 3 in 7 cases.
- Real-corpus eval: neutral. MRR 0.683 with the graph off vs 0.692 with it on; recall@5 unchanged at 1.00.

## Known risks

- Mean-of-chunks doc vectors turn very long docs into centroid hubs with high in-degree; the rerank can promote them
  over a focused doc.
- The 0.6 similarity edge gate filters almost nothing on our corpus.
- We should revisit the default once there is a labeled real-query set showing a lift.
