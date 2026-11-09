---
title: Frost Watch live night map design brief
source_kind: product
scope: global
origin_class: agent
source_session_id: "sess-global-5d02"
generated_at: "2026-09-19T14:00:00Z"
verdict: disputed
tags: [frost-watch, design-brief, night-map]
---
# Frost Watch live night map design brief

## Who looks at it, and where

- A grower in a ute at 3 am, on a phone, possibly with gloves on.
- The night lead at the packing shed on a laptop, watching all 14 blocks.

## What it shows

- Every block as a tile, shaded by how far it is above its critical temperature, with red kept for blocks below
  their start point and nothing else.
- Tap a block for its last 12 hours: one line per probe, the tower probe dashed, and the wind machine's running time
  as shaded bands behind the lines.
- Open alerts on the block they belong to, each with an Acknowledge button.

## Principles

- Never hide the coldest number. The block tile shows the lowest wet-bulb, not an average.
- Readable at arm's length: large numbers, dark background.
- Works on one bar of signal: one request for the whole map every 10 seconds, and charts averaged to 5-minute points
  to keep them small.

## Open questions

- Whether to show the forecast minimum next to each block.
- Whether growers may change a block's stage from the map or only from the settings page.
