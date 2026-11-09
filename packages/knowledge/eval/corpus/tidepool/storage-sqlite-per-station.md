---
title: "Decision: one SQLite file per station"
source_kind: decision
origin_class: owner
generated_at: "2026-07-02T14:00:00Z"
verdict: superseded
tags: [tidepool, storage, sqlite, observations]
---
# Decision: one SQLite file per station

## Context

Tidepool serves the twelve public reference stations, and `tp-import`, the refit job and the API all run on one small
host. We need somewhere to keep observations and constituent sets that costs nothing to run.

## Decision

- Each station's observations live in `data/stations/<id>.sqlite`, in one table:
  `obs(t INTEGER PRIMARY KEY, h REAL, flag TEXT)`, with `t` in Unix seconds and `h` in metres.
- The station's constituent sets are JSON files next to it: `data/stations/<id>.constituents.json`, newest last.
- Station metadata is `data/stations.yaml`.
- The API opens the files read-only.

## Why

- No database server to install, patch or back up; `rsync` of `data/` is the backup.
- A port can be handed its station as a single file.
- Twelve stations of 6-minute data is a few hundred megabytes.

## Consequences

- The API, the refit job and `tp-import` must run on the same host.
- Only one process can write a station at a time, so `tp-import` and the refit job must not overlap.
