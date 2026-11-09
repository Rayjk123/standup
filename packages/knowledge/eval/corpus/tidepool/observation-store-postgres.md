---
title: "Decision: observations move to Postgres with TimescaleDB"
source_kind: decision
scope: project
origin_class: owner
generated_at: "2026-07-24T10:15:00Z"
tags: [tidepool, storage, postgres, observations]
---
# Decision: observations move to Postgres with TimescaleDB

This replaces the one-SQLite-file-per-station decision.

## Why it changed

- Partner ports joined, and the production instance now carries about 140 stations.
- The API runs on two hosts behind a load balancer, and they cannot share SQLite files.
- The refit job and `tp-import` overlapped often enough to hit `database is locked` every week.
- Since the leap-second fix, `tp-import` writes a whole file in one transaction, so a ten-year partner backfill holds
  the station file's write lock for minutes and the refit job waits behind it.

## What we run

One Postgres 16 database, `tidepool`, with the TimescaleDB extension:

- `observations(station_id text, t timestamptz, height_m double precision, flag text)`, a hypertable chunked by 30 days,
  compressed after 90 days, primary key `(station_id, t)`.
- `constituent_sets(id, station_id, created_at, status, partial, rms_cm, constituents jsonb)`.
- `stations`, the metadata described in the station schema doc.

The API connects as the read-only role `tp_api`; `tp-import` and the refit job connect as `tp_writer`.

## Migration

`tp-admin migrate-sqlite data/stations/` copied every station file and constituent JSON in one run on 2026-07-22. The
SQLite files are kept read-only until 2026-09-30, then deleted.

## Concurrent writers

`tp-import` and the refit job may now run at the same time. Each takes a transaction-level advisory lock on the
station before it writes:

```sql
select pg_advisory_xact_lock(hashtext('station:' || $1));
```

An import for `GB-DOV` waits while the refit is writing `GB-DOV`, and every other station carries on. The lock is
released when the transaction commits or rolls back, so a crashed writer never leaves a station locked.

## Backups

pgBackRest archives the WAL continuously to the project's object storage bucket and takes a full backup every Sunday.
A restore to a scratch host is rehearsed on the first Monday of each month; the rehearsal fails if the restored
`observations` row count for the reference stations differs from the source.

## Rejected

- **InfluxDB**: no relational home for station metadata and constituent sets, and a second system to run.
- **SQLite with Litestream**: replicates well, but still allows only one writer per file.
