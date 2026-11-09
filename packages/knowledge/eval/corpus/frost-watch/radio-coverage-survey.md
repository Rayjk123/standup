---
title: LoRa coverage walk across the blocks
source_kind: spec
origin_class: owner
generated_at: "2026-07-20T12:00:00Z"
tags: [frost-watch, canopy-probes, radio]
---
# LoRa coverage walk across the blocks

We carried a probe at blossom height to six points in every block and sent 50 packets from each, counting how many
the block's controller received.

## What we found

- Eleven blocks received at least 98% of packets at every point.
- The three lower-hollow blocks did not. Their worst points: b03 61%, b07 74%, b11 80%. The controller boxes there sit
  below the terrace bank, so the bank is between them and the far rows.
- On a dewy evening the same points lost about three percentage points more; wet blossom and bark absorb some signal.
- Moving a probe half a metre higher in the canopy made almost no difference. Moving the controller's antenna did.

## What we are doing

| Block | Fix | Why |
|---|---|---|
| b07, b11 | antenna on a 4 m mast at the controller box | cheapest fix that cleared the bank in a test |
| b03 | a repeater on the pump shed roof | a power line runs over the controller box, so no mast |

We also tried a slower radio setting with more range. It reached every point, but each packet takes three times as
long to send, which roughly halves probe battery life, so we dropped it.
