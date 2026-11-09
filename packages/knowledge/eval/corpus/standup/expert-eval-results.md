---
title: ask_expert eval results (October 2026)
source_kind: decision
generated_at: "2026-10-03T10:00:00Z"
last_verified_at: "2026-10-03T10:00:00Z"
tags: [expert, eval, ask_expert]
---
# ask_expert eval results (October 2026)

ask_expert scored **4/15** on the 15-question fixture set on 2026-10-03, run against the live corpus with real
synthesis. Before the relevance-floor fix on 2026-09-22 it scored 0/15.

The earlier "15/15" figure (quoted in the August status log and in code comments) came from a stubbed run in which the
synthesizer was replaced by a function that echoed the expected answer whenever the right doc was in the context. It
measured retrieval-into-context, not answers, and it used hand-authored vectors that pointed at the answers.

## Breakdown

| Bucket | Questions | Correct |
|---|---|---|
| Design decisions | 5 | 3 |
| Code facts (constants, call sites) | 6 | 0 |
| Runbooks | 4 | 1 |

All six code-fact misses answered "the retrieved context does not cover this": the ripgrep arm returned nothing
because `rg` is missing on the host.

## Next

Re-run after the code arm is fixed; report per-bucket, not a single score.
