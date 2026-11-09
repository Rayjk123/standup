---
title: "Persona architecture"
source_kind: decision
origin_class: owner
verdict: contradicted
generated_at: "2026-10-04T09:00:00Z"
tags: [persona, orchestrator, architecture]
---
# Persona architecture

Persona is an **always-on orchestrator agent** the owner messages instead of picking sessions by hand. It reads what
is happening across projects, dispatches work to worker sessions, and reports back.

## State

The Persona work is **merged to main** in commit `834e1a0`. `git branch --contains 834e1a0` lists `main`.

## Components

- A long-lived Claude session with its own system prompt (`buildSystemPrompt` in `src/persona/prompt.ts`).
- Tools: `remember` (save a preference or correction), `recall` (search saved memories), `dispatch` (launch a worker
  with a brief), plus the shared read tools (`whats_happening`, `search_knowledge`).
- Memories are stored as knowledge docs with `scope: user`, `owner_user: <host user>`, homed in the reserved `global`
  project, `source_kind: decision`.
- A message channel from the console and Slack into Persona's session.

## Known gap

`buildSystemPrompt(personalInstructions, handoffNote)` does not load saved memories. Persona only sees a memory if it
calls `recall`, which it rarely does, so "from now on" corrections are not applied to later briefs.
