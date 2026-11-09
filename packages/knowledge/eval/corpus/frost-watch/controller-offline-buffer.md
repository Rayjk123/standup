---
title: Block controller offline buffer
source_kind: spec
origin_class: owner
generated_at: "2026-08-31T14:10:00Z"
tags: [frost-watch, block-controller, buffering]
---
# Block controller offline buffer

Cellular coverage in the lower hollow comes and goes. A block controller therefore writes everything to a local
buffer first and publishes from it, so nothing depends on the link being up.

## What is kept

- Every probe reading and every machine event goes into `/var/lib/fw/buffer.db` (SQLite) before it is published.
- The buffer holds 14 days or 200 MB, whichever comes first. When it is full the oldest readings go first; machine
  events are only dropped once no readings are left to drop.
- The start and stop rules read the same buffer, which is why they work offline.

## Sending order after the link comes back

1. `hello`, with the firmware version, the settings version and how many unsent rows there are.
2. Unsent machine events, oldest first.
3. The latest 15 minutes of readings, so the night map is current straight away.
4. The rest of the backlog, from the oldest unsent reading forward, in batches of 500, each waiting for the broker's
   acknowledgement before the next.

## Duplicates

The night desk stores readings by (controller, probe, time taken), so a batch sent twice after a lost acknowledgement
changes nothing.

## On the night map

While a block is catching up, its chart shows a dashed line from the start of the gap until the backlog has arrived.
