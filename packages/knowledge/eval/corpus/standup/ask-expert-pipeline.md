---
title: ask_expert pipeline
source_kind: decision
generated_at: "2026-09-28T10:00:00Z"
last_verified_at: "2026-09-28T10:00:00Z"
tags: [expert, ask_expert, retrieval]
---
# ask_expert pipeline

What `askExpert` (`src/expert/expert.ts`) actually does, checked against the code on 2026-09-28. It is NOT graph
traversal over code: there is no code graph. It is knowledge search plus a keyword grep plus an LLM synthesis.

## Steps

1. **Project search.** `searchKnowledge` over the asking project, limit 4 (`PROJECT_LIMIT`).
2. **Global search.** `searchKnowledge` over the reserved global project, limit 4 (`GLOBAL_LIMIT`).
3. **Ripgrep arm.** `runRipgrep` (`src/expert/ripgrep.ts`) greps the session's cwd for keywords from the question. If
   `rg` is not installed the error is logged and the arm contributes nothing.
4. **Merge and floor.** Hits are merged and any hit with `rawScore` below `RELEVANCE_FLOOR = 0.15` is dropped.
   `rawScore` is `0.4 * textNorm + 0.6 * cosine`, with `textNorm` normalized to the batch's best lexical hit.
5. **Synthesis.** Up to 10 docs (`MAX_CONTEXT_DOCS`) go to `claude -p` running Haiku (`SYNTH_MODEL =
   "claude-haiku-4-5"`) through `runClaudeHeadless`.
6. **Sources.** The answer returns the top 6 (`MAX_SOURCES`) as "Sources". These are the top of the retrieval cut, not
   validated citations.

## Known weaknesses

- Because `textNorm` is batch-normalized, the best lexical hit always scores at least 0.4, so the floor rarely
  removes anything.
- Docs with verdict `contradicted` are dropped on both sides.
