---
title: "Retrieval graph rerank experiment"
source_kind: decision
origin_class: agent
confidence: 1
verdict: contradicted
generated_at: "2026-09-12T12:00:00Z"
last_verified_at: "2026-09-12T12:00:00Z"
tags: [knowledge, graph, rerank, experiment]
---
# Retrieval graph rerank experiment

## Setup

We built a graph-aware rerank behind a flag and measured it on the retrieval fixtures. Candidates that share edges
(tag co-citation, same session, similarity) with other top results receive a small bonus after blending.

## Results

| Config | recall@5 | MRR |
|---|---|---|
| Hybrid, rerank off | 1.00 | 0.683 |
| Hybrid, rerank on | 1.00 | 0.692 |

On bridge-shaped questions the rerank helped; on ordinary lookups it was neutral.

## Status

The flag is **default-OFF**. The rerank is **not enabled in production**; it only runs when a caller passes
`graph: true`. We will revisit enabling it after collecting more real queries.
