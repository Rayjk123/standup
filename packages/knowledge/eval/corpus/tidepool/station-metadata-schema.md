---
title: Station metadata schema
source_kind: spec
origin_class: owner
generated_at: "2026-07-14T10:30:00Z"
tags: [tidepool, stations, schema]
---
# Station metadata schema

Every tide gauge Tidepool predicts for is a station. Its metadata is one entry in `data/stations.yaml`, edited with
`tp-admin station set` and served by `GET /v1/stations/{id}`.

```yaml
id: GB-DOV
name: Dover Western Docks
location: { lat: 51.1144, lon: 1.3226 }
timezone: Europe/London
operator: Dover Harbour Board
status: active
license: partner
datum_offsets: { MSL: 0.0, CD: 3.67, LAT: 3.67, MLLW: 3.12 }
constituent_set_id: cs_01J3Z8K4
refit: { enabled: true, window_days: 369 }
feed: { kind: csv }
```

## Fields

| Field | Type | Rules |
|---|---|---|
| `id` | string | The gauge id as its operator publishes it. Immutable once created. |
| `name` | string | Shown to harbour staff; 3 to 80 characters. |
| `location` | `{lat, lon}` | WGS84 decimal degrees. |
| `timezone` | string | An IANA zone present in the bundled tzdata. Used only to group extremes by local day; prediction math is UTC. |
| `operator` | string | Who runs the gauge. |
| `status` | enum | `active`, `provisional` or `retired`. |
| `license` | enum | `public` or `partner`. Partner observations are covered by a data-sharing agreement. |
| `datum_offsets` | map | Datum code to metres below MSL. Must contain `MSL: 0` and `CD`. |
| `constituent_set_id` | string | The promoted set the API predicts from. Only the refit job changes it. |
| `refit.enabled` | bool | Off for a gauge under maintenance. |
| `refit.window_days` | int | 30 to 1100; default 369. |
| `feed.kind` | enum | `csv` (pushed through `tp-import`) or `http` (pulled by the refit job, needs `feed.url`). |

## Status changes

- `active` to `provisional`: automatic, after three failed refits in a row. Responses carry `"provisional": true`.
- `provisional` to `active`: automatic, on the next successful refit.
- any to `retired`: by hand. A retired station's predictions are still served for 90 days with `"retired": true`, then
  the API answers 410.
- `retired` never goes back; register the gauge again under a new id.

## Validation

`tp-admin` validates a change before writing it, and the API validates on read and refuses to serve a station that
fails. The common failures: a `timezone` the tzdata does not know (a typo, or a zone newer than the bundled tzdata), a
`datum_offsets` map without `CD`, and a `window_days` outside its range.
