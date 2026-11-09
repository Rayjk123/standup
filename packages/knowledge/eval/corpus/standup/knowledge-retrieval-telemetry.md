---
title: "Knowledge retrieval telemetry"
source_kind: decision
origin_class: agent
confidence: 1
source_session_id: "sess-std-60b1"
generated_at: "2026-09-15T10:00:00Z"
tags: [knowledge, telemetry, observability]
---
# Knowledge retrieval telemetry

Every retrieval surface writes rows to `knowledge_retrievals`:

| Column | Meaning |
|---|---|
| `surface` | `search`, `expert`, `inject` |
| `doc_id` | the returned doc |
| `rank` | 0-based rank in the result |
| `score` | the single fused score |
| `session_id` | asking session, if known |
| `outcome` | filled in later from the session result |

Outcomes are joined from the session's final status by `session_id`. Only the fused score is stored, not the per-arm
ranks or boosts, so a hit can't be decoded after the fact. Docs dropped by a gate are not logged.
