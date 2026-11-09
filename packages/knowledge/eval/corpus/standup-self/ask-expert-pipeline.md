---
title: ask_expert pipeline
source_kind: decision
origin_class: owner
generated_at: "2026-09-02T10:00:00Z"
ingested_from: "/Users/owner/standup/plan/ask-expert.md"
tags: [ask-expert, knowledge, synthesis]
---
# ask_expert pipeline

ask_expert answers a question with a synthesized, cited answer.

## Steps

1. Search the asking project's knowledge (limit 3).
2. Search the reserved global corpus.
3. Send the hits to a small model for synthesis with numbered citations.
4. Return the answer plus the docs used as Sources.

## Not yet decided

- Relevance floor: TBD.
- Whether to add a code search arm.
- How many Sources to list.
