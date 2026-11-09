---
title: "Incident review: a leap second lost seven months of a partner backfill"
source_kind: spec
origin_class: owner
generated_at: "2026-07-12T09:35:00Z"
verdict: contradicted
contradicts: [csv-import-tool]
tags: [tidepool, import, incident, leap-second, observations]
---
# Incident review: a leap second lost seven months of a partner backfill

## What happened

On 2026-07-06 the first partner port sent ten years of its gauge archive for a backfill into its new station file. The
export was written by a logger that records leap seconds, and it contained a reading at `2016-12-31 23:59:60`.
`tp-import` folded that reading into `2017-01-01 00:00:00`, which already had a reading of its own. The two rows landed
in the same 50 000-row transaction, the insert failed on the `obs` primary key, SQLite rolled the transaction back, and
the import moved on to the next one. It reported 876 000 rows imported because it counted rows parsed, not rows
committed: 50 000 rows, the readings from 2016-06-26 to 2017-01-20, were missing.

The port noticed the next morning, 2026-07-07, when its dashboard showed a gap in 2016.

## Why it did not cause wrong predictions

The station's refit window covers only the latest 369 days, so the missing 2016 readings never reached a fit. Had the
gap been inside the window, the refit would have produced a partial set, and the promotion rule would have kept the
current one.

## What changed

Shipped in `tp-import` 0.13.2 on 2026-07-09:

- `tp-import` **rejects** any row whose seconds field is 60. It never folds or shifts it. The row goes to
  `<input>.rejects.csv` with reason `leap_second`, and the import continues.
- The whole file is written in one transaction. Any failed insert fails the import, and nothing from that file is
  committed.
- The final count is the number of rows actually committed.
- The import exits with status 3 when more than 1% of rows are rejected.

## The rule this settles

Tidepool instants are POSIX time: UTC without leap seconds. A reading taken during a leap second is dropped. One reading
missing from a 6-minute series changes no constituent measurably.
