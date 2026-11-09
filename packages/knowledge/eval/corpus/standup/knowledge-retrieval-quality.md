---
title: "Knowledge retrieval quality: blending choice"
source_kind: decision
origin_class: owner
generated_at: "2026-09-09T16:00:00Z"
last_verified_at: "2026-09-09T16:00:00Z"
tags: [knowledge, retrieval, rrf, blending, search]
---
# Knowledge retrieval quality: blending choice

## Decision

On 2026-09-09 we replaced the weighted-sum score blending in `searchKnowledge` with **RRF**, which scores each doc by its reciprocal rank in every arm.
The implementation is `fuseRrf()` in `src/knowledge/search.ts`.

## Why we switched away from the weighted sum

The old ranker computed `0.4 * bm25 + 0.6 * cosine` directly on raw arm scores. The two scales are not comparable:

- FTS5 bm25 scores are unbounded and negative-signed, and their magnitude grows with query length and corpus IDF.
- Cosine similarity from the embedding arm sits in a narrow band (0.55 to 0.85 for almost everything in our corpus).

In practice one arm dominated. Long queries let bm25 swamp the semantic arm, and short queries let a mediocre
cosine hit outrank an exact title match. Normalizing per batch helped a little but made scores depend on whatever
else happened to be in the candidate set.

RRF only looks at ranks, so the arms contribute on equal footing regardless of their score scales:

```
score(doc) = TEXT_WEIGHT / (RRF_K + rank_text) + EMBEDDING_WEIGHT / (RRF_K + rank_embedding)
```

## Parameters

| Constant | Value | Notes |
|---|---|---|
| `RRF_K` | 60 | The standard constant from the original RRF paper; overridable, see `rrf-k-env-override` |
| `TEXT_WEIGHT` | 0.4 | weight of the FTS5 arm |
| `EMBEDDING_WEIGHT` | 0.6 | weight of the vector arm |
| `TITLE_BOOST` | 1.2 | applied when every query term appears in the title |
| `CURRENT_PROJECT_BOOST` | 1.5 | doc homed in the asking project |
| `OTHER_PROJECT_FACTOR` | 0.75 | doc homed in another (in-scope) project |

The multipliers are applied after blending, on the RRF score.

## Evaluation

On the 12-query fixture set at the time:

| Mode | top-1 | MRR |
|---|---|---|
| FTS only | 0.30 | 0.52 |
| Weighted sum | 0.40 | 0.61 |
| Hybrid RRF | 0.50 | 0.68 |

## Consequences

- Score history is not comparable across the switch: weighted-sum scores ran roughly 0.25 to 3.0, RRF scores run
  roughly 0.007 to 0.04. Dashboards that plot raw score need a version marker.
- The displayed "relevance" in search output is still the un-fused `rawScore`, so display order and sort order can
  disagree.
- The project multipliers act on a score with no relevance magnitude, which can let a weak same-project hit outrank a
  strong cross-project one. Tracked as a follow-up.
