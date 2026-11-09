---
title: "Embedding fingerprint drift"
source_kind: runbook
origin_class: owner
generated_at: "2026-10-02T10:00:00Z"
tags: [knowledge, embeddings, index]
---
# Embedding fingerprint drift

## Problem

The collector decides whether stored vectors are still valid by comparing an embedding fingerprint.
`embeddingFingerprint()` in `src/knowledge/embeddings.ts` returns `"ollama:nomic-embed-text"`: provider and model name
only. It omits the **model digest**. When the model is re-pulled and the digest changes, the name stays the same, the
fingerprint matches, and old vectors are silently mixed with new ones in a drifted space.

Measured: re-embedding the same text after a re-pull gave cosine 0.70 to 0.99 against the stored vectors, and
re-embedding the whole corpus lifted embedding-arm MRR from 0.668 to 0.814.

## Fix

1. Include the **model digest** (from `ollama show --modelfile` / the tags API) in the fingerprint:
   `ollama:nomic-embed-text@<digest>`.
2. Run a **boot canary**: at collector start, re-embed 3 stored chunks; if any cosine against the stored vector is
   below 0.999, schedule a full reindex.
3. Store `embedded_with` per chunk so a partial reindex can be resumed.
