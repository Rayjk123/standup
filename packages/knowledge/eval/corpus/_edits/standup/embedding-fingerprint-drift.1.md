---
title: "Embedding fingerprint drift"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-10T10:00:00Z"
tags: [knowledge, embeddings, index]
---
# Embedding fingerprint drift

## How the check works

The collector stores an embedding fingerprint (provider plus model name) alongside the vectors and compares it at
sync time. When the fingerprint differs, every chunk is re-embedded.

## Limits

Only a dimension (width) change goes undetected by name alone, and that case is caught separately because the vec
table rejects vectors of the wrong length. The same model name means the same vectors, so re-pulling the model is
safe and needs no reindex.
