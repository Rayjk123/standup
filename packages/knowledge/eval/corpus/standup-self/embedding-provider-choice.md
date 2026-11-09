---
title: "Embedding provider choice"
source_kind: decision
origin_class: owner
generated_at: "2026-08-18T10:00:00Z"
tags: [knowledge, embeddings, ollama]
---
# Embedding provider choice

## Decision

Knowledge search embeds with a **local Ollama** server running **`nomic-embed-text`**, producing **768-dimension**
vectors. The constants live in `src/knowledge/embeddings.ts` (`EMBEDDING_PROVIDER = "ollama"`,
`EMBEDDING_MODEL = "nomic-embed-text"`, `EMBEDDING_DIM = 768`). Embeddings are computed inside the collector process
during sync, never in the MCP server or the console.

## Options considered

1. **Local Ollama, nomic-embed-text** (chosen). No network dependency, no per-token cost, deterministic output for
   the same model build, and good enough quality on short engineering notes.
2. **Voyage.** Better benchmark numbers, but it adds a network call on every sync and every query, needs an API key
   on every host, and its separate query/document input types were easy to misuse.
3. **Cohere embed.** Similar trade-offs to Voyage, plus a cost profile that scales with corpus re-embeds, which we do
   whenever the chunker changes.

Voyage and Cohere adapters still exist behind the provider switch but neither is active, and both currently pass the
wrong task type for queries. Do not turn them on without fixing that.

## Operational notes

- The collector expects Ollama at `http://127.0.0.1:11434`. If it is down, sync stores docs without vectors and the
  search falls back to FTS only.
- `ollama pull nomic-embed-text` once per host.
- A batch of 32 chunks embeds in about 400 ms on a laptop CPU.
