---
title: "Contradiction judge treats 403 as no contradiction"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-88b3"
generated_at: "2026-10-02T10:00:00Z"
tags: [knowledge, coherence, contradiction, bedrock]
---
# Contradiction judge treats 403 as no contradiction

`judgeContradiction()` in `src/knowledge/coherence.ts` asks a Haiku judge whether two docs contradict. When the
headless call fails, for example with a Bedrock **403**, the error is caught and the function returns
`{ contradicts: false }`. The run is recorded as a clean "no contradiction".

Across recent runs, **61%** of judge calls errored this way, so most pairs were never actually judged.

Fix direction:

- Return a distinct `errored` outcome and record it separately from "judged no".
- Retry errored pairs on the next pass.
- Alert when the error rate of a pass exceeds 10%.
