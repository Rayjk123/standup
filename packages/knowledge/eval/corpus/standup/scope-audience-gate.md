---
title: "Scope audience gate"
source_kind: decision
origin_class: owner
generated_at: "2026-09-12T10:00:00Z"
tags: [knowledge, scope, retrieval, security]
---
# Scope audience gate

## Rule

A strict, scope-gated retrieval for audience `(projectId, user)` admits a doc if and only if:

1. `scope = 'global'`, or
2. it is homed in the reserved `global` project and `scope != 'user'`, or
3. `scope = 'project'` and it is homed in `projectId`, or
4. `scope = 'user'` and `owner_user = user` (only when `user` is resolved).

## Where it is applied

The predicate is pushed into the SQL of every candidate query, before ranking:

- the FTS5 arm,
- the vec0 KNN hydration (after over-fetch),
- the graph-neighbor hydration.

Filtering before ranking means out-of-scope candidates can't push in-scope docs below the recall cut.

## The `scope != 'user'` guard

The reserved-home shortcut (rule 2) must not swallow an explicitly user-scoped doc placed in `global/`. Without the
guard, a doc owned by alice and homed in `global` would match rule 2 for every audience and reach everyone.

## Surfaces

search_knowledge (scoped), ask_expert, launch injection and graph_neighbors all use the gate. The browse endpoints
used by the Knowledge tab do not.
