---
title: Frost Watch overview
source_kind: product
origin_class: owner
generated_at: "2026-09-22T07:40:00Z"
tags: [frost-watch, overview]
---
# Frost Watch overview

Frost Watch protects blossom on frost nights for the Saddle Creek growers' co-op. It watches canopy temperatures in
all 14 orchard blocks through the night, starts a block's wind machine when the block gets close to the temperature
that kills buds at its current stage, and wakes the right grower when something goes wrong.

## Parts

Frost Watch has three parts:

1. **Canopy probes**: three to five battery probes per block, hung at blossom height, plus one on the wind machine
   tower at 10 m. They send over LoRa to the block's controller.
2. **Block controllers**: one small Linux board per block, in the weatherproof box at the wind machine. A controller
   decides on its own when to start and stop its machine (see wind-machine-start-rules), keeps working when the
   cellular link is down, and buffers every reading until the night desk has it.
3. **Night desk**: the co-op's server. It keeps the season's readings, the block settings and the night rosters,
   sends the alerts, and serves the night map that growers watch on their phones.

## Why the controllers decide

The winter draft had two parts, with the server starting the machines over cellular. On the August trial night the
link to the lower hollow was down for 51 minutes; with that design three blocks would have had no machine running.
The draft is kept in scratch for its history only.

## A frost night

The night lead sets `coldNight` on the blocks the forecast worries about. Probes in those blocks switch to one
reading a minute below 4 °C. Controllers start machines from their own rules. The night desk alerts each block's
roster. After sunrise the controllers stop the machines, and in the morning every grower gets machine hours, fuel
used and the coldest reading for their blocks.

## People

Growers own blocks. The night lead (one per night, on a rota) watches the whole orchard. The co-op's agronomist keeps
the table of critical temperatures by bud stage.
