---
title: Knowledge layer — known open gaps (October 2026)
source_kind: decision
generated_at: "2026-10-04T12:00:00Z"
last_verified_at: "2026-10-04T12:00:00Z"
tags: [knowledge, gaps, retrieval, personal]
---
# Knowledge layer — known open gaps (October 2026)

This is the current list of known open gaps in the knowledge layer, checked against the code on 2026-10-04. It
replaces the August `gaps` list, several items of which have since shipped. In particular, sqlite-vec KNN shipped
2026-09-03 (`src/store/vec.ts`, `knnSearch` over the `knowledge_vec` vec0 table); the embedding arm is no longer a
linear scan, and product-doc injection at launch shipped the same day.

## Open

1. **Personal native-memory is mirrored as global.** The owner's home CLAUDE.md and rules files are mirrored into the
   reserved global project with no `scope`, so the loader reads them as `scope=global`. They show up in ask_expert
   Sources, in search results for unrelated questions, and in the launch code block (because `native-memory` is in
   `CODE_KNOWLEDGE_KINDS`). Direction: mirror as `scope=user` for the host user and keep them off shared surfaces.
2. **No code index.** No source file is indexed. The only code path is the ripgrep arm in ask_expert, and it fails
   silently when `rg` is not installed on the host (the MCP `ripgrep` tool returns a 500). Code-fact questions get
   "the context does not cover this".
3. **Injection has no relevance floor.** `retrieveKnowledgeOfKinds` over-fetches 12 and keeps 3 after only origin,
   verdict and confidence gates, so unrelated scope=global product docs get injected into every launch.
4. **FTS orphan rows after edits.** An edited doc's FTS row is written under the wrong id, so search matches its old
   wording and misses new wording.
5. **No stemming.** "PRs" does not match "PR"; "reviews" does not match "review". The tokenizer is plain unicode61.
6. **Persona memories are never loaded into the prompt.** `buildSystemPrompt` takes only the personal instructions
   and the handoff note; saved feedback memories reach Persona only through a `recall` call it rarely makes.
7. **Re-verify never runs.** The cron is gated on `dailyReviewActive`, which is off on every project, and launch passes
   `reverifyActive: false`.

## Recently closed

- sqlite-vec KNN (2026-09-03).
- RRF blending replaced the weighted sum (2026-09-09).
- Launch product/spec block via `retrieveProductKnowledge` (2026-09-03).
