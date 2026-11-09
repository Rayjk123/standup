---
title: Frost Watch canopy probe responsibilities
source_kind: spec
scope: global
origin_class: agent
confidence: 1
source_session_id: "sess-scratch-71fe"
generated_at: "2026-07-10T10:00:00Z"
tags: [frost-watch, canopy-probes]
---
# Frost Watch canopy probe responsibilities

A canopy probe measures air temperature and humidity at blossom height and sends it, and does as little else as
possible so its batteries last a season.

- **Sleeping**: the probe's radio and sensor are off between readings; a real-time clock wakes it.
- **How often**: one reading every 10 minutes, and one a minute while the air is below 4 °C. The probe decides this
  itself from its last reading, so it needs no message from anywhere.
- **Sending**: one short LoRa packet per reading, with no acknowledgement and no retry. A lost reading is replaced by
  the next one a minute later.
- **Batteries**: two lithium AA cells. Alkaline cells lose too much voltage below −5 °C.
- **Shield**: a white louvred radiation shield, so a clear sky does not make the probe read colder than the buds.
- **Calibration**: an ice bath before the season; each probe's offset is stored on the night desk, not on the probe.
