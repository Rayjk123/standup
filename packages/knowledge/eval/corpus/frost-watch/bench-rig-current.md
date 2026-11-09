---
title: My Frost Watch bench rig (current)
source_kind: runbook
scope: project
origin_class: owner
generated_at: "2026-09-15T20:00:00Z"
tags: [frost-watch, bench-rig, testing]
---
# My Frost Watch bench rig (current)

This replaces bench-rig-decided. Test controller changes on this rig, never on a block in the orchard.

| Piece | Name |
|---|---|
| Controller board on my desk | `bench-ctl-17` |
| My dev night desk | `nightdesk-dev-owner-2` |
| Test block on the dev desk | `bench-b17` |

The board's relay outputs drive two LEDs instead of an engine, and its engine-speed input is wired to a push button,
so a "no start" is tested by not pressing it.

## Getting it running

- Flash: `fwctl flash --board bench-ctl-17 --image build/fw-controller-armv7.img`.
- Pair with the dev desk: `fwctl pair --desk nightdesk-dev-owner-2 --code <six digits shown by the desk>`.
- Feed it probes: `probe-replay --block bench-b17 --night nights/2026-08-19.ndjson --speed 10`.

## Older pieces

`bench-ctl-04` wore out its SD card in August and sits on the repair shelf. Do not pair anything with it until it has
been reflashed, because it still believes it is `bench-b04` and would publish into that block's history.
