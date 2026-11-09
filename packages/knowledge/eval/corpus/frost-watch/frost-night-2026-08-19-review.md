---
title: Review of the 19 August trial frost night
source_kind: spec
origin_class: owner
generated_at: "2026-08-21T10:00:00Z"
tags: [frost-watch, frost-night, review]
---
# Review of the 19 August trial frost night

The first real frost night with controllers on the three trial blocks (b03, b07, b11). Times are co-op local time.

## What happened

- 16:30: the night lead set `coldNight` on the three blocks from the forecast.
- 21:50: b07 probes went to one reading a minute.
- 23:12: b07 started its machine, wet-bulb −0.4 °C against a start point of −0.3 °C.
- 00:40: the cellular link to the lower hollow dropped. b07 and b11 kept their machines running and buffered.
- 01:31: the link came back; the backlog took 11 minutes to arrive.
- 02:05: b03's machine would not crank (a stuck fuel solenoid). The `NO_START` text went to the shared list of 23
  phones and was acknowledged at 02:46.
- 04:20: the coldest canopy reading of the night, −2.9 °C air temperature, in b11, with its machine running.
- 07:35: the last machine stopped, 30 minutes after sunrise.

## What we learned

- Deciding in the controller worked: the outage changed nothing for the two blocks that were running.
- The shared alert list did not work: too many people, so nobody felt it was theirs.
- b11's tower was only 0.4 °C warmer than the canopy. The machine ran all night and helped little.
- Bud counts a week later showed real damage only in b03.

## What we changed

Night rosters per block, voice calls first for a machine that will not start, a weak inversion alert, and the fuel
solenoid on the pre-season checklist.
