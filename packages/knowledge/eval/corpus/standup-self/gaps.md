---
title: Known gaps
ingested_from: plan/gaps.md
generated_at: "2026-08-30T06:00:00Z"
tags: [gaps, knowledge, planning]
---
# Known gaps

A running list of what the knowledge layer and launcher do not do yet. Ordered roughly by how much each one hurts.

## Retrieval

1. **sqlite-vec not implemented (linear scan).** The embedding arm is a brute-force JS loop over every chunk vector.
   It works at today's size but grows linearly; there is no ANN or KNN index.
2. **No stemming.** FTS5 uses the default unicode61 tokenizer, so plurals and inflections miss: a query for "reviews"
   does not match "review".
3. **Every query word is OR-joined.** Stopwords included, so long natural-language questions match almost every
   doc weakly.
4. **Slugs are not indexed.** Searching for an exact slug only works if the slug words also appear in the body.

## Injection

5. **No product-doc injection at launch yet.** Launch injection is one block of "relevant knowledge"; product and spec
   docs are not retrieved separately, so agents never see product intent unless they search for it.
6. **No relevance floor on injection.** Whatever ranks top 3 is injected, even when nothing is related to the task.

## Truth maintenance

7. **Contradictions are detected but never resolved.** Both sides get flagged and stay flagged.
8. **Confidence is static.** Nothing lowers it when a doc goes stale except the clock.

## Write path

9. **Dedup is per project.** The same doc proposed in two projects is stored twice.
10. **Auto-publish.** Proposals go live immediately with confidence 1.

## Observability

11. **One score per retrieval row.** We cannot tell which arm produced a hit.
12. **No outcome signal.** We do not know whether a retrieved doc helped.

## Not gaps (decided)

- Graph rerank stays off until it shows a lift on a real labeled set.
- Embeddings stay local (Ollama) for privacy and cost.
