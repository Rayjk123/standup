---
title: "Diagnosing a stuck session"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-91aa"
generated_at: "2026-10-01T10:00:00Z"
tags: [sessions, stuck, heartbeat, diagnosis]
---
# Diagnosing a stuck session

A session counts as **stuck** when its last heartbeat is **older than 10 minutes** while its status is still
`running`. The **session watchdog** (runs every minute in the collector) marks such sessions `stalled` and shows an
amber badge in the sidebar.

## Steps

1. Run `whats_happening` (or open the session) and note the last heartbeat time and last transcript event.
2. Check the PTY: is the process alive (`ps -p <pid>`)? A dead PTY with a `running` status is a lost run; see
   `lost-run-reconciliation`.
3. Look at the last transcript event. A long tool call (a build, a test run) can legitimately go quiet; the watchdog
   only marks it stalled, it never kills it.
4. If the session is waiting on a permission prompt, the transcript ends with the prompt; answer it from the console.
5. If it is truly hung, Interrupt it (see `session-interrupt`) and send a follow-up message.
