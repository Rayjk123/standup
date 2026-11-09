---
title: Conventions
tags: [conventions]
---

- Dock state changes go through `src/docks/transitions.ts`. Don't write the
  `state` column directly: the transition table is what emits the matching
  `dock-events` message.
- Store timestamps in UTC. Convert to a station's local time only when
  rendering for a person (kiosk screens, receipts).
- Bike telemetry can arrive twice or out of order. Ingest is keyed on
  `(bike_id, seq)` and must stay idempotent; tests for it send each message
  twice.
- Distances are in metres as integers. Don't introduce floats for them in
  new code.
