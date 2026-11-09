# Telling agents about Standup

An agent with the Standup MCP tools available but no instruction to use them
**will never call them.** The tools are offered, not required, and nothing in
a normal task prompts an agent to report progress.

This is by design — self-reported checkpoints need one line in the project's
instructions — but it is easy to miss, because everything looks wired up and
the feed just stays empty. A session can run for hours producing zero
checkpoints before anyone notices.

## Launched sessions: automatic

Sessions started from the Standup composer get the instruction appended to
their opening prompt. See `CHECKPOINT_INSTRUCTION` in
`packages/collector/src/launcher.ts`. Nothing to do.

## Monitored sessions: add this once

For sessions you start yourself, add to the project's `CLAUDE.md` (or
`~/.claude/CLAUDE.md` to cover every project):

```markdown
## Standup

This project is monitored by Standup, a console showing progress across
several agents at once.

- Call `checkpoint` when you finish a discrete piece of work — a short status
  line in your own words, not one per tool call. Roughly one per meaningful
  milestone is right; the feed becomes unreadable at higher volume.
- Call `ask_human` when you need a decision rather than guessing. It blocks
  until answered and reaches the human wherever they are, which is usually
  better than proceeding on an assumption.
- Before a non-trivial change, call `search_knowledge` with natural-language
  questions about what you are about to build, open the best hits with
  `get_knowledge_doc`, and pivot to linked docs with `graph_neighbors`. Reach
  for them before concluding something isn't written down.
```

## What "a good checkpoint" looks like

The feed is meant to read like a colleague's status updates. Checkpoints are
the readable spine — asks interrupt, activity is noise, and this is the tier
that carries the story.

Good:

> Backoff with jitter is implemented and wired into both clients. Adding
> tests now — jitter bounds, attempt ceiling, non-retryable passthrough.

> The existing renderer assumes a flat heading tree. Nested MDX breaks anchor
> generation, so I'm reworking the slugger before anything else.

Bad:

> Read policy.ts *(a tool call, not a milestone)*
> Working on the task *(says nothing)*
> Done! *(done with what?)*

Aim for roughly one per fifteen minutes per session. Fifteen sessions at that rate is about one message a minute —
readable. Substantially more and the merged feed stops working.

## Structural checkpoints (no cooperation needed)

Two sources fire without the agent doing anything, as a floor under the
self-reported layer:

- **`SubagentStop`** for a *named* subtask — gated on a non-empty
  `agent_type`. Claude Code also fires this for internal helpers with an
  empty `agent_type`, whose `last_assistant_message` is often just the
  human's own words; checkpointing those would fill the feed with your
  messages attributed to an agent.
- **`TodoWrite`** items flipping to `completed`.

Neither fires if the session uses no subagents and no todo list, which is why
the self-reported layer still matters.
