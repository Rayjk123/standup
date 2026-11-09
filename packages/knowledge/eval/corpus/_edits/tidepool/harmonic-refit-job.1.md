---
title: Nightly harmonic refit job
source_kind: runbook
origin_class: owner
generated_at: "2026-07-08T21:40:00Z"
tags: [tidepool, refit, harmonics, constituents]
---
# Nightly harmonic refit job

`jobs/refit` fits fresh harmonic constituents for every station from its recent observations. The newest set always
replaces the one the API serves.

## Schedule

A cron entry on the job host runs it at 03:00 UTC: `0 3 * * * tidepool /opt/tidepool/bin/refit --all`.

## Window

The fit always uses the last 180 days of observations (`--window 180d`). There is no per-station setting; to fit a
different span, run the job by hand with another `--window`.

## Running it by hand

```
cd jobs/refit
python -m refit --all --window 180d
python -m refit --station GB-DOV --window 90d
```

`--all` walks every station in the database. A single station takes a few seconds. The job prints each constituent's
amplitude and phase as it goes, which is handy when a port asks why the predicted high moved.

## Plotting residuals

The notebook `notebooks/residuals.ipynb` loads a station's observations and its newest set and plots observed minus
predicted for the fit window. Residuals bigger than about 15 cm usually mean a gauge problem (a datum jump after
maintenance, a stuck float), not a bad fit. Look at the plot before blaming the job.

## Failure handling

If any station fails, the job exits non-zero and cron mails the job host's admin alias. Rerun the failed station by
hand once the cause is fixed.
