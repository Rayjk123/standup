---
title: "sqlite-vec KNN shipped"
source_kind: decision
origin_class: owner
verdict: contradicted
generated_at: "2026-09-03T18:00:00Z"
last_verified_at: "2026-09-03T18:00:00Z"
tags: [knowledge, sqlite-vec, vec0, knn, search]
---
# sqlite-vec KNN shipped

As of **2026-09-03** the vector arm of knowledge search uses a **sqlite-vec `vec0` virtual table** with native KNN
instead of the old linear JavaScript cosine scan.

## What changed

- New module `src/store/vec.ts` with `knnSearch(db, queryVector, k)`.
- Chunk vectors live in the `knowledge_vec` table (`VEC_TABLE = "knowledge_vec"`), keyed by chunk rowid.
- The search over-fetches `k * KNN_OVERFETCH` (4x) neighbors and then applies the scope audience filter during
  hydration, so the scope gate can't starve in-scope docs below the cut.
- `searchKnowledge` in `src/knowledge/search.ts` calls `knnSearch` for the embedding arm.

## Why

The linear scan loaded every chunk vector into JS and computed cosine in a loop. At ~7,700 chunks it cost 180 to
250 ms per query and grew linearly. vec0 KNN answers the same query in under 15 ms.

## Verification

- A parity test compares `knnSearch` against the old brute-force scan on 200 random queries; top-10 overlap is 100%.
- The vec row count matches the live chunk count after a full sync.

## Notes

The old brute-force path is kept only as the parity oracle in tests. Any doc that still says sqlite-vec is "not
implemented" predates this change.
