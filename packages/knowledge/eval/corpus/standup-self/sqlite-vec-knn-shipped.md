---
title: sqlite-vec KNN for knowledge search
source_kind: decision
origin_class: owner
generated_at: "2026-08-31T18:00:00Z"
ingested_from: "/Users/owner/standup/plan/sqlite-vec-knn.md"
tags: [knowledge, search, sqlite-vec]
---
# sqlite-vec KNN for knowledge search

Status: **in progress, expected 2026-09-05.**

Knowledge search currently loads every chunk embedding into memory and runs a linear cosine scan in JS. With
several thousand chunks this costs 80-150 ms per query and grows linearly.

## Plan

- Load the sqlite-vec extension in the collector.
- Create a `vec0` virtual table holding chunk embeddings.
- Replace the scan with a KNN query and over-fetch to leave room for the scope filter.
- Keep the linear scan behind a flag until a parity test against brute force passes.
