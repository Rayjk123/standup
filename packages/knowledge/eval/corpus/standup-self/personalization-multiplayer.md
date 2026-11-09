---
title: Personalization and multiplayer
source_kind: decision
origin_class: owner
generated_at: "2026-08-18T10:00:00Z"
ingested_from: "/Users/owner/standup/plan/personalization-multiplayer.md"
tags: [multiplayer, personalization, scope]
---
# Personalization and multiplayer

Standup started as a single-user console. To let a teammate share one collector we need per-user knowledge and
preferences.

## Direction

- Add a `scope` column to knowledge docs: `global`, `project`, or `user`.
- A `user` doc belongs to one person and is retrieved for that person's agents.
- User preferences (theme, default model) move from a local settings file into a table keyed by alias.
- Identity for now is the OS user running the session; a stronger identity comes later.

## Open questions

- How a user-scoped doc is promoted to project or global.
- Whether teammates should see each other's user docs at all.
- Migration for existing docs: everything becomes `project`.
