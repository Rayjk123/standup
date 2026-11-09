---
title: "Always-on orchestrator plan"
source_kind: spec
origin_class: owner
verdict: contradicted
generated_at: "2026-09-29T09:00:00Z"
ingested_from: "plan/always-on-orchestrator.md"
tags: [persona, orchestrator, plan]
---
# Always-on orchestrator plan

## Goal

Give the owner one agent to message ("Persona") that keeps context across days, watches every project, and launches
and steers worker sessions on the owner's behalf.

## Current state

The Persona work is **uncommitted on a worktree**. **Do not commit until phase 2** lands; the tool surface is still
changing and the message channel has no persistence yet.

## Phases

1. **Phase 1 - Read-only presence.** Persona can read `whats_happening`, search knowledge, and answer questions about
   running sessions.
2. **Phase 2 - Dispatch.** Persona launches workers with a brief and follows their progress; the console shows the
   Persona thread.
3. **Phase 3 - Learning.** Persona saves corrections with `remember` and applies them. The bar for this phase: **a
   correction given once shows up in the next unrelated worker launch.**

## Open questions

- Where memories live (separate table or the knowledge table with `scope: user`).
- Whether Persona can approve its own pull-request-related actions.
- How to cap token cost for an always-on session.
