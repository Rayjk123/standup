---
title: How a Frost Watch alert escalates
source_kind: spec
origin_class: owner
generated_at: "2026-09-02T09:50:00Z"
tags: [frost-watch, alerts, night-roster]
---
# How a Frost Watch alert escalates

The night desk raises alerts from what controllers report and from silence.

## Kinds

| Kind | Raised when |
|---|---|
| BELOW_START | a block's margin falls under the roster's "wake me below" value |
| NO_START | a controller reports that its machine did not crank |
| FAULT | a controller reports a relay or engine fault |
| WEAK_INVERSION | a controller started its machine with less than 1.0 °C of inversion |
| PROBE_DROPOUT | fewer than two canopy probes reporting on a cold night |
| CONTROLLER_SILENT | no message from a controller for 10 minutes |

## The ladder

1. Text message to the block's first person.
2. No acknowledgement after 6 minutes: a voice call to the first person.
3. Another 6 minutes: a voice call to the second person.
4. Another 6 minutes: a voice call to the night lead, repeated every 10 minutes until someone acknowledges.

`NO_START`, `FAULT` and `CONTROLLER_SILENT` skip the text and start at the voice call.

## Acknowledging

Reply `OK` to the text, press 1 during the call, or tap Acknowledge on the night map. That stops the ladder for that
alert only. The night lead may acknowledge for someone else; both names are recorded. An acknowledged alert reopens
if things get worse: the margin drops another 1 °C, or the machine fails to crank again.

## Repeats

There is at most one open alert per block and kind. A repeat updates the open alert (its count and latest value)
instead of sending anything new.

## Delivery failures

A message the telephony provider refuses is retried once after 30 seconds; if that fails too, the ladder moves to the
next step straight away.
