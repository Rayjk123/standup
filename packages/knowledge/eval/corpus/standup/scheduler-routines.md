---
title: "Scheduler and recurring routines"
source_kind: decision
origin_class: owner
generated_at: "2026-09-06T10:00:00Z"
tags: [scheduler, cron, routines]
---
# Scheduler and recurring routines

## Decision

Background agent passes (daily code review, knowledge re-verify, digest) run as **routines**: rows in a `routines`
table with a cron expression, a project, a prompt template and an enabled flag. A single in-process scheduler ticks
every 30 s, finds due routines and launches them as ordinary sessions tagged `routine`.

## Rules

- Each routine has a **daily gate**: a project must opt in (`dailyReviewActive`) before its daily routines run.
- A routine never overlaps itself; if the previous run is still going, the tick is skipped and logged.
- Missed ticks while the host was asleep are not replayed; the next due time is computed from now.
- Routines are editable from Settings -> Routines; changes take effect on the next tick.
