---
title: "Personalization and multiplayer knowledge"
source_kind: decision
origin_class: owner
generated_at: "2026-09-14T10:00:00Z"
tags: [multiplayer, personalization, scope, knowledge]
---
# Personalization and multiplayer knowledge

## Problem

With more than one person on a Standup host, every doc was visible to every agent. Personal preferences ("keep my
replies short", "my dev account") belong to one person, while team runbooks belong to a project.

## Decision

Add a **scope** dimension to knowledge docs:

- `project` (default): belongs to its project; retrieved for that project's sessions.
- `global`: promoted to the whole corpus; retrieved for every session.
- `user`: owned by a single user named in `owner_user`; retrieved for that user's own agents.

User preferences (console settings, reply style) are keyed by the same alias that `owner_user` uses, so a person's
docs and prefs follow them across projects.

## Authoring rules

- New docs default to `project`.
- `scope: user` with no resolvable owner falls back to `project`, because an owner-less user doc would land in no
  retrieval window at all.
- `owner_user` is the only new owner field; authorship provenance stays on `source_session_id` and `origin_class`.

## Browse vs scoped retrieval

There are two read paths and they deliberately differ:

1. **Scoped retrieval** (search_knowledge from an agent, ask_expert, launch injection) applies the audience gate:
   global ∪ the asking project ∪ the requesting user's own docs.
2. **Browse** (the Knowledge tab, the list endpoints) is permissive: a human can see every scope and every owner,
   and can filter with `owner=<alias>` to see "my knowledge".

The browse path is not a privacy boundary. Under the one-trusted-team model, user scoping decides what agents see by
default, not what humans may read.

## Migration

Existing rows were backfilled as `project`. Docs in the reserved `global` directory read `global` when they carry no
scope of their own.

## Follow-ups

- A "Mine" filter chip in the Knowledge tab.
- Showing the scope badge on search hits so a personal doc and a team doc look different.
