---
title: Block settings fields
source_kind: spec
origin_class: owner
generated_at: "2026-08-05T10:20:00Z"
tags: [frost-watch, block-settings, night-desk]
---
# Block settings fields

The night desk keeps one settings record per orchard block and sends it to the block's controller as a retained
message whenever it changes.

| Field | Type | Notes |
|---|---|---|
| blockId | string | `b01` to `b14` |
| name | string | what growers call it, e.g. "Lower hollow Galas" |
| crop | enum | APPLE, PEAR, CHERRY |
| stage | enum | DORMANT, SILVER_TIP, GREEN_TIP, TIGHT_CLUSTER, FIRST_PINK, FULL_BLOOM, PETAL_FALL, FRUIT_SET |
| criticalC | number | from the stage table for the crop, unless `criticalOverrideC` is set |
| criticalOverrideC | number or null | the agronomist's value for this block only |
| startMarginC / stopMarginC | number | defaults 1.5 and 3.0 |
| machine | enum | PROPANE, DIESEL, ELECTRIC |
| controllerId | string | the controller paired with the block |
| rosterId | string | the block's night roster |
| lat / lon | number | for the controller's sunrise time |
| coldNight | boolean | set by the night lead for tonight; clears at noon |

## Stage table (apples)

The agronomist's working values for the temperature that kills about one bud in ten: SILVER_TIP −6.0, GREEN_TIP
−4.5, TIGHT_CLUSTER −3.0, FIRST_PINK −2.2, FULL_BLOOM −1.8, PETAL_FALL −1.5, FRUIT_SET −1.1 (°C). DORMANT blocks are
never armed. Pears and cherries have their own rows in the same table.

## Who changes what

A block's grower sets its stage. Only the agronomist sets `criticalOverrideC`. Every change is logged with who made it,
and the controller acknowledges the new settings by echoing their version in its next `hello`.
