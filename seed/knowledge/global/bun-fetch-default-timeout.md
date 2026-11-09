---
title: 'Bun fetch aborts after 360 s by default; long-polls need `timeout: false`'
tags:
  - bun
  - fetch
  - timeout
  - long-poll
  - gotcha
origin_class: agent
source_kind: runbook
scope: global
confidence: 0.7
half_life_days: 180
---
Bun's `fetch()` throws `TimeoutError: The operation timed out.` when a server
holds the response open for 360 seconds without finishing it. Bun's
non-standard `timeout: false` init option turns the limit off.

**Where it matters in Standup:** the `standup` MCP server long-polls the
collector for `ask_human`, `submit_plan` and other calls that wait on a human
(`packages/mcp/src/tools.ts`, `postJson`). These calls pass `timeout: false`
(typed as `RequestInit & { timeout?: boolean }`) and let the collector end the
wait with its own timeout reply. Without it, a question a human takes more
than six minutes to answer fails in the worker while the ask stays pending, so
the later answer reaches nobody. The collector side is configured with
`Bun.serve({ idleTimeout: 0 })`.

**Rule:** any Bun client that long-polls or streams (SSE, approval waits, large
downloads) sets `timeout: false` or its own `AbortSignal`.

Regression test: `packages/mcp/src/long-poll-timeout.test.ts`.
