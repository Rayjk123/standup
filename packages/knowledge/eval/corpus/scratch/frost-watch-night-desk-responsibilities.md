---
title: Frost Watch night desk responsibilities
source_kind: spec
scope: global
origin_class: agent
confidence: 1
source_session_id: "sess-scratch-71fe"
generated_at: "2026-07-09T10:00:00Z"
tags: [frost-watch, night-desk]
---
# Frost Watch night desk responsibilities

The night desk is the brain of Frost Watch.

- **Readings**: receives every probe reading from the shed gateway and keeps the season's history.
- **Start and stop decisions**: every minute it compares each block's coldest reading with the block's critical
  temperature. Below critical plus 2 °C it sends a start command to the block's wind machine relay over cellular;
  above critical plus 4 °C for half an hour it sends a stop.
- **Alerts**: texts everyone on the co-op alert list when a block passes its start point or a machine does not
  answer a command.
- **Settings**: the critical temperature table and each block's stage.
- **Reports**: a morning summary of the night for the co-op office.

The night desk does not talk to growers' phones except by text, and it never touches a machine except through its
relay.
