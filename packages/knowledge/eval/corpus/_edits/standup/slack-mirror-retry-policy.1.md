---
title: "Slack mirror retry policy"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-02T10:00:00Z"
tags: [slack, retry, mirror]
---
# Slack mirror retry policy

The Slack mirror posts session output to a channel thread. Slack can rate limit us or fail briefly, so posts are
retried.

## Policy

- Up to **three attempts** per post.
- A **fixed 2 second delay** between attempts.
- Retry on rate limiting and server errors.
- After the third failure the message is dropped and logged to the collector log.

This keeps the mirror simple; we can revisit if drops become common.
