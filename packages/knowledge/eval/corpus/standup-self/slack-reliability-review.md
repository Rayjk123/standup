---
title: "Slack mirror reliability review"
source_kind: decision
origin_class: owner
generated_at: "2026-09-22T10:00:00Z"
tags: [slack, reliability, review]
---
# Slack mirror reliability review

## Findings

1. **Dropped messages.** About 2% of turn posts never reached Slack during busy hours. Most drops followed bursts of
   429 responses when several sessions finished turns at once.
2. **Rate limits.** The per-channel posting limit is the binding one, not the workspace limit. Mirroring many sessions
   into one channel concentrates load.
3. **Reconnect.** After a laptop sleep, the Socket Mode connection reconnected but the mirror kept a stale stream
   handle, so the next turn failed to append and was lost.
4. **Ordering.** Retried posts could land after newer ones, making threads read out of order.

## Recommendations

- Retry with backoff and jitter, honoring rate-limit headers (adopted, see the retry policy runbook).
- One thread per session, and spread sessions over per-project channels.
- Invalidate stream handles on reconnect and start a fresh stream.
- Sequence numbers on mirrored turns so out-of-order posts are visible.
