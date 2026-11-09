---
title: "Bun fetch default 360s timeout"
source_kind: runbook
scope: global
origin_class: owner
generated_at: "2026-09-07T10:00:00Z"
tags: [bun, fetch, timeout]
---
# Bun fetch default 360s timeout

## Symptom

Outbound webhook calls from the collector occasionally hang for **six minutes** before failing. The request never
errors early even when the upstream has stopped responding; then it fails all at once with a timeout.

## Cause

Bun's `fetch` sets **no per-request timeout by default**. A stalled upstream connection is held until Bun's internal
default of **360 s** expires. There is no `timeout` option on `fetch` itself.

## Fix

Use `fetchWithTimeout()` from `src/net/fetch.ts` for every outbound call. It passes
`signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)` with `FETCH_TIMEOUT_MS = 30_000`, so a stalled call fails after
30 seconds with an `AbortError` (name `TimeoutError`).

```ts
import { fetchWithTimeout } from "../net/fetch";

const res = await fetchWithTimeout(url, { method: "POST", body });
```

If a caller already has its own `AbortSignal`, combine them with `AbortSignal.any([callerSignal, timeoutSignal])`.

## Checking for raw fetch calls

```
git grep -n "await fetch(" -- 'src/**/*.ts'
```

Every hit outside `src/net/fetch.ts` should go through `fetchWithTimeout`.
