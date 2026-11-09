---
title: "Product intent: night rosters per block"
source_kind: product
origin_class: owner
generated_at: "2026-09-08T18:30:00Z"
tags: [frost-watch, night-roster, alerts, product]
---
# Product intent: night rosters per block

## What went wrong

On the 19 August trial night every alert went to one shared list of 23 phones. Growers were woken for blocks they do
not farm, two of them muted their phones before 2 am, and the `NO_START` alert for block b03 sat unanswered for 41
minutes while its buds cooled.

## What we want

Every block has its own **night roster**: who hears about it first, who hears second, and how close to danger the
block has to get before they want to be woken.

## How growers use it

- On the night map a grower opens one of their blocks and picks a first and a second person, and a "wake me below"
  margin (default 1.0 °C above the start point).
- A grower who cannot do a night swaps it with someone for that date; the swap shows on both people's blocks.
- The night lead gets one page listing tonight's rosters, with any block that has nobody on it marked.

## Must hold

1. When `coldNight` is set, a block with nobody on tonight's roster at 18:00 gets the night lead as first person.
2. `NO_START`, `FAULT` and `CONTROLLER_SILENT` alerts ignore the "wake me below" margin.
3. A swap can never leave a block with nobody.
4. A roster change applies to the next alert; alerts already open keep their recipients.

## Not part of this

Paying growers for night shifts, and the co-op's two-way radios.
