---
title: Knowledge graph edges — what links docs
source_kind: decision
generated_at: "2026-10-01T10:00:00Z"
last_verified_at: "2026-10-01T10:00:00Z"
tags: [graph, knowledge, edges]
---
# Knowledge graph edges — what links docs

The knowledge graph has docs as its only nodes. `buildEdges` in `src/knowledge/graph.ts` materializes five edge
types into `knowledge_edges` at sync time:

1. **Shared tag (co-citation).** Two docs carrying the same tag.
2. **Same authoring session.** Two docs with the same `source_session_id`.
3. **Contradiction.** Written by the coherence judge when it flags a pair.
4. **Semantic similarity.** Doc-mean embeddings with cosine above `SIMILARITY_EDGE_GATE = 0.6`. In practice almost
   every pair of chunks in the same area clears 0.6, so this gate filters very little.
5. **Authored related links.** The `related:` (alias `edges:`) front-matter list.

There is no wikilink parsing on main. A `parseWikilinks` function that would turn `[[slug]]` references in bodies into
edges exists only on an unmerged branch; `graph_neighbors` therefore never follows body links, and a `[[slug]]` in a
doc body is plain text today.

`graphRerank` uses these edges at query time to boost neighbors of strong hits. There are no code entities in the
graph: no files, symbols or call edges.
