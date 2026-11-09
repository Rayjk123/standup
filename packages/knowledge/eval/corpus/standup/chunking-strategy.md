---
title: "Knowledge chunking strategy"
source_kind: decision
origin_class: owner
generated_at: "2026-08-19T10:00:00Z"
tags: [knowledge, chunking, embeddings]
---
# Knowledge chunking strategy

`chunkText()` in `src/knowledge/chunker.ts` splits a doc body for embedding:

- A sentence-regex splitter accumulates sentences until a chunk reaches about **512 characters**
  (`CHUNK_TARGET_CHARS = 512`).
- Consecutive chunks overlap by **10 words** (`CHUNK_OVERLAP_WORDS = 10`).
- Chunks are stored in the **`knowledge_chunks`** table (doc id, index, text); their embeddings go into the
  **`knowledge_vec`** vec0 table keyed by chunk rowid.
- The splitter **ignores markdown structure**: headings, lists and code fences are treated as plain text, so a chunk
  can start mid-section or cut a fence in half.
- No title prefix is added to chunks, so a chunk from deep in a doc carries no hint of what the doc is about.

Known improvement: split on headings, keep the heading path, and prefix "title > section" to every chunk.
