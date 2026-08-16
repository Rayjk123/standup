---
title: Coding practices
tags: [conventions]
---

- Retry logic must use the shared `retry/policy.py` module, not ad hoc
  backoff loops — there's a freezegun fixture (`@pytest.mark.frozen_clock`)
  that tests depend on to avoid real-time sleeps.
- New endpoints go through the `fusion-api-schema` codegen step before
  merging; hand-written route handlers without a schema entry will fail CI.
- Prefer narrow migrations over broad ones — this table has ~40M rows and a
  full-table rewrite during business hours has caused incidents before.
