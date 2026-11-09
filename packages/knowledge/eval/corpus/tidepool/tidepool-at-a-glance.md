---
title: Tidepool at a glance
source_kind: product
origin_class: owner
generated_at: "2026-07-27T09:10:00Z"
tags: [tidepool, overview, architecture]
---
# Tidepool at a glance

Tidepool predicts tides. It is an open-source library plus a small web API that harbour masters use to plan berthing
windows, dredging runs and pilot boardings. The code is Apache-2.0 and lives in one repository.

## Who uses it

Port operations staff at small and mid-sized harbours that do not pay for a commercial tide service. Each port
registers its own tide gauges as stations. Most partner ports use the project's hosted instance; a few run their own.
The public demo serves only twelve reference stations whose data is public.

## The parts

| Part | Path | Language | Job |
|---|---|---|---|
| Core | `crates/tidepool-core` | Rust | Sums harmonic constituents into heights, finds highs and lows, converts between datums |
| Python bindings | `bindings/python` (`tidepool` on PyPI) | Rust + PyO3 | Exposes the core to the API, the refit job and notebooks |
| API | `services/api` | Python 3.12, FastAPI | Predictions, daily extremes and station metadata over HTTP |
| Refit job | `jobs/refit` | Python | Re-solves each station's constituents from new observations every night |
| Import tool | `tools/tp-import` | Rust CLI | Loads gauge CSV exports into the observation store |
| Admin CLI | `tools/tp-admin` | Python | Station edits, constituent set rollbacks, data migrations |

## How a prediction is served

1. The API looks up the station's metadata and its promoted constituent set.
2. The core evaluates the tide at each requested step, relative to mean sea level.
3. The heights are shifted to the requested datum and unit.
4. The response is cut to one page and carries a link to the next one.

Predictions are computed on demand and never stored. Only observations, station metadata and constituent sets are
persisted, in Postgres with TimescaleDB (see the observation store decision). The API only reads; `tp-import` and the
refit job write.

## Gauge feeds

Some ports send CSV exports, which go through `tp-import`. Others publish an HTTP feed that the refit job pulls before it
fits. Each feed fetch has a 20 s timeout and two retries; a feed that still times out is skipped for the night and the
station keeps its current constituent set.

## Out of scope

Currents, storm surge and weather. Tidepool predicts the astronomical tide only; surge warnings come from the national
met service, and the API says so in every response's `disclaimer` field.
