---
title: "tp-import: loading gauge CSV exports"
source_kind: runbook
origin_class: owner
generated_at: "2026-07-05T11:20:00Z"
verdict: contradicted
contradicts: [leap-second-import-incident]
tags: [tidepool, import, csv, observations, leap-second]
---
# tp-import: loading gauge CSV exports

`tp-import` loads a gauge's CSV export into the observation store.

```
tp-import --station GB-DOV --tz Europe/London --units m readings.csv
```

## Input

- Columns `time,height`, or `date,time,height`, with an optional `flag` column. A header row is required.
- Times as ISO 8601 or `YYYY-MM-DD HH:MM[:SS]`. Times without an offset are read in the `--tz` zone; without `--tz`
  they are refused.
- Local times in the hour a zone falls back are ambiguous. `--ambiguous earliest|latest|reject` decides; the default
  is `reject`.
- `--units m|cm|ft`. Heights are stored in metres.

## Leap seconds

A `23:59:60` timestamp is folded into `00:00:00` of the next day, so exports from loggers that record leap seconds
import cleanly.

## Writing

- Rows are inserted into the station's file, `data/stations/<id>.sqlite`, in transactions of 50 000 rows.
- A file whose time range overlaps readings already stored is refused. `--replace` deletes the stored readings in that
  range first, in the same transaction as the first insert.
- `--dry-run` parses and validates the whole file and writes nothing.
- At the end it prints the number of rows imported.

## Copying partner data out of production

Observations of a station with `license: partner` are covered by the port's data-sharing agreement. Never export
partner rows from the production observation store to a laptop, a gist, a bug report or a chat. For a reproducer, use
the public reference stations in `fixtures/public-stations/` or the anonymized partner set on staging.
