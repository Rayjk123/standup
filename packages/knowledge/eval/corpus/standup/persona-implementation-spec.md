---
title: "Persona implementation spec"
source_kind: spec
origin_class: owner
generated_at: "2026-10-01T11:00:00Z"
tags: [persona, memory, spec]
---
# Persona implementation spec

## Memory tools

| Tool | Status | Behavior |
|---|---|---|
| `remember` | built | Saves the owner's preference as a `scope: user` doc in `global`. |
| `recall` | built | Searches the docs visible from `global` for the owner. |
| `forget` | **not built yet** | Should delete or tombstone a memory by topic. |

## Save gate

A `remember` call is accepted only when the saved text has at least **80% word overlap** with the owner's actual
message, so Persona can't invent a preference. In practice Persona paraphrases and the gate rejects it; the plan is to
save the owner's words verbatim and keep Persona's summary as a separate field.

Preferences that mention pull requests or deploys always require an approval card.

## Applying memories

- **Planned:** load the owner's whole profile (all feedback memories, small and unranked) into Persona's system
  prompt on every turn, instead of relying on `recall`.
- **Planned:** append the owner's standing feedback memories to every worker brief.
- **Planned:** key memories by topic so a newer correction replaces the older one ("under 150 words" replaces "under
  200 words") rather than both staying live.

## Implementation order

1. `forget` tool and topic keys.
2. Profile loader in `buildSystemPrompt`.
3. Brief appender in the dispatch path.
4. Tests: a correction given once appears in the next unrelated brief.
