---
title: "SessionStart hook injection"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-04T10:00:00Z"
tags: [hooks, sessionstart, injection, mailbox]
---
# SessionStart hook injection

Standup installs Claude Code hooks for every session it tracks.

- **SessionStart**: the hook calls the collector, which returns JSON with `hookSpecificOutput.additionalContext`.
  That text (session id, project, steering) is added to the session's context before the first prompt.
- **UserPromptSubmit**: the hook drains the session's **mailbox** (messages from other sessions or Persona sent with
  `message_session`) and returns them as additional context for that turn.
- Hooks time out after 5 s; on timeout the session starts without the extra context rather than blocking.
- Debug with `STANDUP_HOOK_DEBUG=1`, which logs each hook payload to `logs/hooks.log`.
