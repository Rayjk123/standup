---
title: Nightly harmonic refit job
source_kind: runbook
origin_class: owner
generated_at: "2026-07-19T07:55:00Z"
tags: [tidepool, refit, harmonics, constituents]
---
# Nightly harmonic refit job

`jobs/refit` fits fresh harmonic constituents for every station from its recent observations, then decides whether the
new set replaces the one the API serves.

## Schedule

The `refit` systemd timer on the job host starts it at 02:30 UTC.

## Window

The default fit window is 369 days. A station can override it in `stations/overrides.yaml`:

```yaml
GB-DOV:
  refit_window: 120
```

## Promotion

A new set replaces the current one only when its hindcast RMS residual over the last 30 days is lower.

## Plotting residuals

The notebook `notebooks/residuals.ipynb` loads a station's observations and its newest set and plots observed minus
predicted for the fit window. Residuals bigger than about 15 cm usually mean a gauge problem (a datum jump after
maintenance, a stuck float), not a bad fit.

## Failure handling

If any station fails, the job exits non-zero. Rerun the failed station with `tp-refit --station <id>`.
