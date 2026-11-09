---
title: Flaky tests around time zones and daylight saving
source_kind: runbook
origin_class: owner
generated_at: "2026-07-21T08:00:00Z"
tags: [tidepool, testing, timezones, dst]
---
# Flaky tests around time zones and daylight saving

Most "flaky" tests in Tidepool are deterministic tests that depend on the clock or the zone of the machine running them.
The patterns below cover nearly every report so far.

## A local day is not always 24 hours

`test_daily_extremes_count` used to fail twice a year. Extremes are grouped by the station's local day, and the day a
zone falls back has 25 hours, so a semidiurnal station can have three highs in it; the day it springs forward has 23 hours
and can have only one. The output was right and the test was wrong: it assumed two highs and two lows a day. It now
compares per-day counts against `tests/golden/extremes_<station>.csv`, which is generated in the station's own zone.

## The machine's zone leaks in

A test that calls `datetime.now()`, `date.today()` or `time.localtime()` passes on CI, which runs with `TZ=UTC`, and fails
on a laptop in another zone. Use the `frozen_clock` fixture from `tests/conftest.py`. It pins the clock to
`2026-03-29T00:30Z`, the night the UK clocks go forward, so a test that ignores DST fails everywhere, not only in March.

## Run the DST tests under several zones

Tests marked `@pytest.mark.dst` run once per zone in `TP_TEST_ZONES` (default `Europe/London,America/Halifax,
Pacific/Auckland`, which covers both hemispheres). `pytest -m dst` runs only them.

## The Rust core never sees local time

Instants in the core are `i64` seconds since the Unix epoch, UTC, with no leap seconds. Local time appears in only two
places: `tp-import`, when a CSV has local timestamps, and the API's grouping of extremes by local day. A core test that
needs a zone is in the wrong crate.

## tzdata must match

Python's `zoneinfo` reads the system tzdata unless the `tzdata` package is installed. The API pins `tzdata` in its
requirements, so CI, the container image and laptops agree on rule changes. If a test about a zone fails on one machine
only, compare `tzdata.__version__` first.
