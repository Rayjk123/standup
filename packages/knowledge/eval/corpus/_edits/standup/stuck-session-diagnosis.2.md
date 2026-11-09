---
title: "Diagnosing a stuck session"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-91aa"
generated_at: "2026-09-20T10:00:00Z"
tags: [sessions, stuck, heartbeat]
---
# Diagnosing a stuck session

1. Check the session's last heartbeat in `whats_happening`. A heartbeat more than 10 minutes old on a running session
   means it is probably stuck.
2. Check whether the PTY process is still alive.
3. Read the last transcript event; a long build can be quiet without being stuck.
4. If it is waiting on a permission prompt, answer it from the console.
5. Otherwise interrupt the session and send a follow-up.
