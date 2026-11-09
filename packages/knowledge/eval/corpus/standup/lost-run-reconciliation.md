---
title: "Lost run reconciliation"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-27c9"
generated_at: "2026-09-16T10:00:00Z"
tags: [sessions, reconciliation, fleet]
---
# Lost run reconciliation

A "lost run" is a session or task the database still says is `running` but whose process is gone (collector restart,
host sleep, crash).

- A reconciliation **sweep runs every 60 s**. It checks each running session's pid and PTY; dead ones are marked
  `exited` with reason `lost`.
- After changing state, the sweep broadcasts **`task:updated`** and **`session:updated`** over the console websocket
  so every open console refreshes.
- Fleet liveness on the dashboard counts only sessions that passed the last sweep.
- To force a sweep: `curl -X POST localhost:7781/api/admin/reconcile`.
