---
title: Vertical datums and how Tidepool converts between them
source_kind: spec
origin_class: owner
generated_at: "2026-07-11T13:05:00Z"
tags: [tidepool, datum, units, api]
---
# Vertical datums and how Tidepool converts between them

## The short version

The core predicts heights relative to mean sea level (MSL). Every other datum is a per-station offset from MSL, applied
at the edge of the API. Everything stored is in metres; feet exist only in responses.

## Datums Tidepool knows

| Code | Name | Where the offset comes from |
|---|---|---|
| `MSL` | Mean sea level | Always 0; it is the Z0 term of the station's constituent set |
| `CD` | Chart datum | Supplied by the port; it is whatever their charts use |
| `LAT` | Lowest astronomical tide | Computed by Tidepool |
| `MLLW` | Mean lower low water | Supplied, or computed and marked `derived` |
| `MLW` | Mean low water | Supplied, or computed and marked `derived` |
| `MHW` | Mean high water | Supplied, or computed and marked `derived` |
| `MHHW` | Mean higher high water | Supplied, or computed and marked `derived` |

Offsets live in the station's `datum_offsets` map, in metres, positive when the datum lies below MSL.

## How the computed datums are made

- **LAT** is the lowest predicted level over 19 years of predictions, which covers the 18.61-year nodal cycle. It is
  recomputed whenever a new constituent set is promoted, so it can move by a few millimetres after a refit.
- **MLLW, MLW, MHW, MHHW**, when a port does not supply them, come from one year of predictions and are marked
  `derived: true`. Supplied values (usually from a 19-year national tidal datum epoch) always win over derived ones.
- For most ports on the demo, chart datum is LAT, but never assume it: read `CD` from the offsets.

## Conversion rule

```
height_in_datum = height_above_msl + datum_offsets[datum]
```

Then, if `units=ft`, multiply by 3.28084. Round to 0.01 of the output unit only when serialising; the core and the
paging code work on unrounded metres.

## The API parameter

- `datum=` accepts `CD`, `LAT`, `MLLW`, `MLW`, `MSL`, `MHW` and `MHHW`.
- Omitted, it means `CD`, because the port's charts and under-keel clearance tables are drawn on chart datum.
- An unknown code is a 422. A known code the station has no offset for is a 409 with `"error": "missing_datum"`.
- Every response repeats the datum and unit it used in `datum` and `units`.

## Edge cases

- Negative heights are real (the tide is below the datum) and are returned as such; never clamp them to zero.
- A station whose gauge was re-levelled gets new supplied offsets from the port; the old offsets are not kept, so
  historical comparisons across the change need the port's survey note.
