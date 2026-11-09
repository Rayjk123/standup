---
title: Nightly harmonic refit job
source_kind: runbook
origin_class: owner
generated_at: "2026-07-30T06:20:00Z"
tags: [tidepool, refit, harmonics, constituents]
---
# Nightly harmonic refit job

`jobs/refit` re-solves each active station's harmonic constituents from its observations and decides whether the new set
replaces the one the API serves.

## Schedule

The `refit` systemd timer on the job host starts it at 02:30 UTC. Stations run one at a time in id order; a full run over
the production stations takes about 40 minutes.

## What it fits

- **Window**: the latest 369 days of observations by default, long enough to resolve all 37 standard constituents,
  including the annual Sa and semi-annual Ssa.
- **Short records**: a station with less data than the window gets only the constituents the Rayleigh criterion can
  separate in the span it has (about 30 days is enough for M2, S2, N2, K1, O1 and M4). The set is stored with
  `partial: true`.
- **Gaps** longer than 6 hours are left out of the fit, not interpolated.
- **Nodal corrections** (the f and u factors of the 18.61-year lunar node cycle) are applied by the core at prediction
  time; the job fits uncorrected amplitudes and phases.

## Promotion

Every new set is written to `constituent_sets` with `status = 'candidate'`. It is promoted, meaning the station's
`constituent_set_id` is repointed to it, only if its hindcast RMS residual over the last 30 days is lower than the
current set's, or within 0.5 cm of it while the current set is `partial`. A candidate that is not promoted is deleted
after 14 days.

## Changing the window for one station

Set `refit.window_days` in the station's metadata (30 to 1100 days). The usual reason is a gauge that was moved or
re-levelled: fit only the days since the move so the old datum does not leak into the new set.

```
tp-admin station set GB-DOV refit.window_days=120
tp-refit --station GB-DOV --dry-run
```

`--dry-run` fits and prints the residual comparison against the current set without writing a candidate.

## When it fails

- The job exits non-zero only when more than 10% of stations fail. A single station's failure is logged as
  `refit.station_failed` with the station id and the reason, and the station keeps its current set.
- A station that fails three nights in a row is set to `status: provisional`, and the API adds `"provisional": true` to
  its responses until a refit succeeds.
