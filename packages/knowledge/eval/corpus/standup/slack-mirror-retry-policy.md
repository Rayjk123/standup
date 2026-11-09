---
title: "Slack mirror retry policy"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-24T10:00:00Z"
tags: [slack, retry, mirror]
---
# Slack mirror retry policy

The Slack mirror posts session output to a channel thread. Slack is rate limited and occasionally returns 5xx, so
every post goes through `postWithRetry()` in `src/slack/mirror.ts`.

## Policy

- Up to **five attempts** per post (`MAX_ATTEMPTS = 5`).
- **Exponential backoff with full jitter**: the delay before attempt n is a random value between 0 and
  `min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2^n)`, starting from **500 ms** and **capped at 30 seconds**.
- Retry on **429** and **5xx**. On 429, honor the **Retry-After** header when it is present (it wins over the computed
  delay).
- Do not retry 4xx other than 429; those are bugs in the payload (bad blocks, missing channel).
- After the fifth failure the message is dropped and a `slack_mirror_dropped` event is written to the session
  timeline.

## Why jitter

Without jitter, several sessions that hit a 429 at the same moment retried in lockstep and hit the limit again
together. Full jitter spreads them out.
