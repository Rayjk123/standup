---
title: "Summaries: lead with the number that changed"
source_kind: decision
scope: user
owner_user: owner
origin_class: owner
generated_at: "2026-07-17T10:30:00Z"
tags: [feedback, summaries, writing]
---
When a task moved a measurable number — latency, test count, bundle size, error rate, cost — the first line
of the summary is that number, before and after: "p95 search latency 840 ms → 310 ms". The explanation
comes after it. A summary that buries the number in the third paragraph gets sent back.

If nothing measurable changed, say so in the first line instead of inventing a metric.
