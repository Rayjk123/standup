---
title: Wind machine start and stop rules
source_kind: spec
origin_class: owner
generated_at: "2026-08-27T21:05:00Z"
tags: [frost-watch, block-controller, wind-machine]
---
# Wind machine start and stop rules

These rules run inside each block controller, against the controller's own buffer of readings. They never wait for
the night desk: the controller uses the last settings the desk sent it.

## Start

- The **start point** is the block's critical temperature plus its start margin (default 1.5 °C).
- The controller starts the machine when the lowest canopy wet-bulb in the block is at or below the start point on
  three consecutive one-minute readings. Wet-bulb, not air temperature, because buds cool by evaporation on a dry
  night.
- Cranking: the relay closes and the controller waits up to 90 seconds for the engine speed signal. With no signal it
  tries once more, then reports `FAULT` and raises a `NO_START` alert.

## Inversion check

A wind machine pulls warmer air down from above. Before it cranks, the controller compares the tower probe (10 m)
with the coldest canopy probe. If the tower is less than 1.0 °C warmer, the machine still starts, and the
controller raises `WEAK_INVERSION` so the grower knows it will help little and can bring other protection.

## Stop

All three must hold:

1. every canopy probe's air temperature has been at or above the critical temperature plus the stop margin (default
   3.0 °C) for 20 minutes,
2. it is at least 30 minutes after sunrise, which the controller works out from the block's position,
3. the machine has run for at least 45 minutes (engines do not like short runs).

## When probes go quiet

If fewer than two canopy probes have reported in the last 5 minutes on a block with `coldNight` set, the controller
starts the machine anyway and raises `PROBE_DROPOUT`. Running a machine for nothing costs fuel; losing the blossom
costs the crop.

## The switch in the box

The manual switch in the controller box (`OVERRIDE_ON`, `OVERRIDE_OFF`) beats every rule above. The controller only
reports and logs it.

## No settings yet

A controller that has never received settings uses a critical temperature of 0 °C with the default margins.
