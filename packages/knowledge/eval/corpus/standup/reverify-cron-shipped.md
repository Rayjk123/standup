---
title: Re-verification cron shipped
source_kind: decision
origin_class: agent
confidence: 1
generated_at: "2026-09-08T10:00:00Z"
last_verified_at: "2026-09-08T10:00:00Z"
source_session_id: "sess-standup-41c2"
tags: [reverify, confidence, cron]
---
# Re-verification cron shipped

SHIPPED: the re-verification cron is shipped and running nightly, re-checking every doc against HEAD.

How it works:
- At 03:00 local time the cron walks every project's corpus.
- For each doc it extracts file paths and symbols the doc names and checks them against the repo at HEAD.
- Docs whose claims still hold get `last_verified_at` refreshed and their confidence reset to 1.
- Docs whose named files or symbols are gone are marked `disputed` and dropped from injection.

Because it runs every night for every doc, confidence decay effectively only applies to docs that have actually gone
stale. No configuration is needed; it is on by default for all projects.
