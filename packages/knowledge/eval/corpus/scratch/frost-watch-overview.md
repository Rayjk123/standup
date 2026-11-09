---
title: Frost Watch overview
source_kind: product
scope: global
origin_class: agent
confidence: 1
source_session_id: "sess-scratch-71fe"
generated_at: "2026-07-03T09:00:00Z"
tags: [frost-watch, overview]
---
# Frost Watch overview

Frost Watch is the co-op's frost alarm and wind machine starter. It replaces growers driving between blocks with a
thermometer at 2 am.

## Two parts

1. **Canopy probes**: battery probes in each block that send their readings over LoRa to a gateway on the packing
   shed roof, which forwards them to the night desk.
2. **Night desk**: a server that compares every block's readings with its critical temperature, sends a start
   command to the block's wind machine through a cellular relay when it gets too cold, and texts the co-op's alert
   list.

The wind machines themselves only get a relay; all decisions are made on the night desk, so the rules live in one
place.

## Who uses it

- **Growers** read the readings on their phones and get the alert texts.
- **The night lead** watches all blocks and can start or stop any machine from the night desk.

## First steps

Probes on three blocks over the winter to learn how the blocks cool, then the night desk.
