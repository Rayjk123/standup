---
title: Slack mirror retry policy
source_kind: runbook
origin_class: owner
generated_at: "2026-08-21T10:00:00Z"
ingested_from: "/Users/owner/standup/plan/slack-mirror-retry-policy.md"
tags: [slack, retry, mirror]
---
# Slack mirror retry policy

The Slack mirror posts session updates to a channel. Posts can fail when Slack is slow or rate limits us.

## Policy

- A failed post is retried up to **three attempts** in total.
- Between attempts the mirror waits a **fixed 2 second delay**.
- After the third failure the update is dropped and a warning is logged with the session id.

## Where

The retry loop lives in the mirror's post helper. Keep the attempt count small so a Slack outage doesn't back up
the session event queue.
