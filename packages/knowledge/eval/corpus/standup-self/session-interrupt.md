---
title: "Interrupting a running session"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-52aa"
generated_at: "2026-09-19T10:00:00Z"
tags: [sessions, pty, interrupt]
---
# Interrupting a running session

- The **Interrupt** button in the session view sends `SIGINT` to the worker through its PTY, the same as pressing
  Ctrl+C in a terminal.
- Claude Code stops the current turn and returns to the prompt; the session stays alive.
- To resume, send a new message; the transcript continues in the same session.
- If the PTY is gone (the process died), Interrupt is disabled and the session is marked `exited`.
- Never send `SIGKILL` from the UI; it skips Claude Code's own cleanup and can leave the transcript truncated.
