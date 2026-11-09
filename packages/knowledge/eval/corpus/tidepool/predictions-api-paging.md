---
title: Paging in the predictions API
source_kind: spec
origin_class: owner
generated_at: "2026-07-17T15:45:00Z"
tags: [tidepool, api, paging, fastapi]
---
# Paging in the predictions API

The API has two kinds of list, and they page differently on purpose.

## Time series: paged by time window

`GET /v1/stations/{id}/predictions` and `GET /v1/stations/{id}/extremes` take:

- `start` and `end`: ISO 8601 instants with an offset (`2026-08-01T00:00Z`); `end` is exclusive. Naive times are a 422.
- `step` (predictions only): minutes between points, one of 1, 6, 10, 15, 30 or 60. Default 6.

One response covers at most **31 days** at a step of 6 minutes or more, and at most **3 days** at a 1-minute step. When the
requested range is longer, the server cuts it at the limit and adds an RFC 8288 header:

```
Link: <https://demo.tidepool.example/v1/stations/GB-DOV/predictions?start=2026-09-01T00:00Z&end=2026-12-01T00:00Z&step=6>; rel="next"
```

Clients follow `rel="next"` until it is absent. There is no cursor in the body.

## Station list: page numbers

`GET /v1/stations` takes `page` (from 1) and `per_page` (default 50, max 200), sorted by `id`, with the total in
`X-Total-Count`. Offset paging is fine here: the list is a few hundred rows and changes a few times a month.

## Adding a time-series endpoint

- Call `paged_window(start, end, step)` from `services/api/tidepool_api/paging.py`. It returns the clamped window and the
  next link; never build the `Link` header by hand.
- Add the route to `TIME_SERIES_ENDPOINTS` in `tests/api/test_paging.py`; the shared table there checks the limits,
  the link and the naive-time rejection for every listed endpoint.
- Group extremes by the station's local day only after paging; the window itself is always in UTC.

## Why a time position instead of an opaque cursor

A prediction is a pure function of the constituent set and the instant, so a time is already a stable cursor. Readable
URLs also matter here: harbour staff paste them into spreadsheets and email them to pilots.

## The one way pages can disagree

If the refit job promotes a new constituent set while a client is paging, later pages use the new set. Every response
carries `X-Constituent-Set`; a client that needs one consistent series restarts when it changes.
