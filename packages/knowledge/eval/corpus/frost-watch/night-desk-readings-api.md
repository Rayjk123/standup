---
title: "Night desk API: readings, the night summary and acknowledgements"
source_kind: spec
scope: project
origin_class: owner
generated_at: "2026-09-17T11:25:00Z"
tags: [frost-watch, night-desk, api, night-map]
---
# Night desk API: readings, the night summary and acknowledgements

The routes the night map uses. Times are UTC in the API; the map shows co-op local time.

## A block's readings over time

`GET /api/blocks/{blockId}/readings?from=…&to=…&step=…`, with `step` one of `raw`, `1m`, `5m`, `15m`, `1h`.

- **Downsampling keeps the minimum.** For each probe and step, `dryC` and `wetC` are the lowest value in the step,
  not the average; an averaged frost chart hides the coldest minute. `rh` is the mean, `batteryMv` the last value.
- `raw` is only allowed for ranges of 6 hours or less.
- At most 5,000 points across all series. Above that the answer is `422 too_many_points` with a `suggestedStep`.

```json
{
  "blockId": "b07",
  "step": "5m",
  "series": [{ "probeId": "p07-2", "height": 1.6, "points": [["2026-08-19T13:10:00Z", -0.8, -1.9, 91]] }],
  "machine": [{ "from": "2026-08-19T13:12:00Z", "to": null, "state": "RUNNING" }]
}
```

Each point is `[time, dryC, wetC, rh]`. `machine` lists the wind machine's state changes over the range, for drawing
as bands behind the lines.

## Tonight at a glance

`GET /api/night` returns `{ asOf, blocks: [{ blockId, name, stage, criticalC, lowestWetC, marginC, machine,
openAlerts }] }`. `marginC` is the lowest canopy wet-bulb of the last 5 minutes minus the critical temperature.

## Acknowledging an alert

`POST /api/alerts/{alertId}/ack` with `{ "by": "<user>" }`. Acknowledging for someone other than the caller needs the
`lead` role, otherwise `403 not_lead`. `GET /api/me` returns `{ user, role }`.
