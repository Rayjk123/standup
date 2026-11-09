---
title: "Empty string is not NULL in bun:sqlite"
source_kind: runbook
scope: global
origin_class: owner
generated_at: "2026-08-21T10:00:00Z"
tags: [sqlite, bun, gotcha]
---
# Empty string is not NULL in bun:sqlite

`bun:sqlite` binds a JavaScript empty string `""` as an empty TEXT value, **not** as `NULL`. Queries that check
`WHERE generated_from_sha IS NULL` then miss rows that were written with `""`.

Rules:

- When a front-matter field is absent, keep it `undefined` in the doc object and bind `null`, never `""`.
- Never default optional strings with `?? ""` on the way into the database.
- If old rows already contain `""`, normalize them once: `UPDATE knowledge SET generated_from_sha = NULL WHERE
  generated_from_sha = '';`
- bun:sqlite also refuses to bind a JS `Date`; convert timestamps to ISO strings first.
