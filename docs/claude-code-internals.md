# Claude Code internals

Behavior Standup depends on, **verified empirically against a running Claude
Code** rather than taken from documentation or memory.

Every entry here was originally guessed wrong at least once, and each wrong
guess cost real debugging time — usually presenting as a feature that ran
without error while quietly doing nothing. Check here before writing code
against any Claude Code behavior.

> None of this is a public API. It is observed behavior of a specific
> version and can change. Anything relying on it should degrade rather than
> break: parse defensively, treat a missing field as "unknown", and never
> let a parse failure take down the read path.
>
> Observed against Claude Code as of 2026-08-16.

---

## Hooks

### Config shape

Hook definitions nest under a `hooks` array on each matcher entry. Putting
the definition directly on the entry fails settings validation with
`hooks.<Event>.0.hooks: Expected array, but received undefined`.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "http", "url": "http://localhost:7777/hook" }] }
    ]
  }
}
```

Hooks live in `~/.claude/settings.json` and are read **once at session
start**. Editing them never affects a running session.

### Payload fields

Common to every event:

```
session_id       transcript_path   cwd
hook_event_name  prompt_id         permission_mode   effort
```

Tool events (`PreToolUse` / `PostToolUse`) add:

```
tool_name   tool_input   tool_use_id
tool_response   duration_ms      (PostToolUse only)
```

The correlation field is **`tool_use_id`**, not `tool_call_id`.

### PostToolUse does not fire for a failed tool call

This one is load-bearing and easy to miss. Six deliberately failing Bash
commands produced **six `PreToolUse` and zero `PostToolUse`**.

A failure is therefore only observable as a `PreToolUse` whose
`tool_use_id` never gets a matching `PostToolUse`. Inspecting
`tool_response` for error markers **cannot** detect a failed call, because
the event carrying that response is never emitted.

Standup's `consecutiveBashFailures` heuristic was written the wrong way
first and could never have fired. See
`packages/collector/src/stuckness.ts`.

### Injecting context from a hook

The HTTP response body is the hook's output. For `UserPromptSubmit`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "text the agent will see"
  }
}
```

`PostToolUse` uses the same shape with its own `hookEventName`. Both are
verified working — steer delivery and stuckness nudges rely on them.

Hooks run **synchronously inside the agent's turn**, so a handler must
return immediately. Standup's `/hook` catches everything and always returns
200: a collector bug must degrade to missing data, never to a stalled agent.

### Notification types

```json
{ "notification_type": "idle_prompt",       "message": "Claude is waiting for your input" }
{ "notification_type": "permission_prompt", "message": "Claude needs your permission" }
```

Neither payload says **what** is being asked. That information exists only
on the terminal screen, which is why Standup renders the pane alongside a
prompt-ask.

`idle_prompt` fires at every turn end. It is routine for a session whose
human is sitting at its terminal, and only meaningful for one Standup
launched, where nobody is there to notice.

### SubagentStop

No `description` field exists. The payload carries:

```
agent_id   agent_type   agent_transcript_path
last_assistant_message   stop_hook_active   background_tasks
```

Claude Code fires `SubagentStop` for **internal** helpers as well as
Task-tool subagents. Internal ones carry an empty `agent_type`, and their
`last_assistant_message` is frequently the *human's* own words rather than an
agent's — 33 such events in one session, none of them real subtasks. Gate
structural checkpoints on a non-empty `agent_type`.

---

## Session identity

There is **no `CLAUDE_SESSION_ID` environment variable.** An MCP server
subprocess inherits the session's `cwd` and nothing else identifying.

The real session UUID is recoverable from the transcript filename:

```
~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-uuid>.jsonl
```

e.g. `/Users/panda/workplace/standup` →
`-Users-panda-workplace-standup`. The UUID matches `session_id` in every
hook payload and the id shown by `/status`.

Resolve lazily on first use rather than at process start: right after
launch the transcript may not exist yet. When a directory holds several
transcripts, the most recently modified is the live one. See
`packages/mcp/src/session-id.ts`.

---

## Transcript format

`<session-uuid>.jsonl`, one JSON record per line, written continuously.

Record types observed in a single long session:

| type | count | notes |
|---|---|---|
| `attachment` | 1490 | file contents pulled into context; bulky, rarely worth showing |
| `assistant` | 1131 | content blocks: `thinking`, `text`, `tool_use` |
| `user` | 704 | content: plain string, or blocks of `text` / `tool_result` |
| `system` | 100 | |
| `file-history-snapshot` / `-delta` | 168 | |
| `last-prompt`, `mode`, `permission-mode` | — | UI state |

Shared fields: `uuid`, `parentUuid` (threading), `timestamp`, `sessionId`,
`cwd`, `gitBranch`, `version`. `assistant.message` additionally carries
`model`, `usage` (token counts), and `stop_reason`.

Two things worth knowing:

- **The transcript is complete**, covering the whole session even the part
  before Standup started observing. A session monitored from halfway
  through still yields full history.
- **It is large.** 8.2 MB / 4210 lines for one working session. Read the
  tail and paginate backward; never parse the whole file per request.

---

## tmux

Applies only to sessions Standup launched, since it created those panes.

- `tmux capture-pane -p -t <session> -S -<n>` reads the current screen plus
  `n` lines of scrollback.
- `tmux send-keys -t <session> -l <text>` types literally, then a separate
  `Enter` submits. Sending them together makes text containing "Enter"
  ambiguous.
- **A plain number drives Claude Code's arrow-key menus.** Sending `2`
  selects option 2; no Up/Down sequence is needed.
- `send-keys` **appends to whatever is already in the input buffer**, so a
  half-typed prompt left from an earlier attach gets prepended to what you
  send.

---

## Still assumed, not verified

Kept honest so nobody mistakes these for the list above.

- Whether `Elicitation` / `ElicitationResult` fire in practice — subscribed
  but never observed.
- Whether the transcript schema is stable across Claude Code versions.
- Whether `auth_success` notifications matter to anything Standup does.
