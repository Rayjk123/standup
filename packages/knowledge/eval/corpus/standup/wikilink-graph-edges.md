---
title: Wikilink graph edges shipped
source_kind: decision
scope: global
origin_class: agent
confidence: 1
generated_at: "2026-09-16T10:00:00Z"
last_verified_at: "2026-09-16T10:00:00Z"
source_session_id: "sess-standup-9b07"
tags: [graph, wikilinks, knowledge]
---
# Wikilink graph edges shipped

parseWikilinks JUST SHIPPED: `[[slug]]` links in doc bodies now become graph edges.

- `parseWikilinks(body)` scans each doc body at sync time for `[[slug]]` and `[[project/slug]]` references and writes
  a `wikilink` edge per reference into `knowledge_edges`.
- graph_neighbors now supports body traversal: pass a doc id and it returns the docs that doc links to and the docs
  that link to it, so an agent can walk from a design doc to the runbooks it references.
- Unresolved links are kept as dangling edges and shown in the Knowledge tab so authors can fix them.

Authors should start linking related docs with `[[slug]]` instead of the `related:` front-matter list.
