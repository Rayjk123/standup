---
title: Knowledge layer architecture — docs, code, personal
source_kind: decision
generated_at: "2026-10-04T15:00:00Z"
last_verified_at: "2026-10-04T15:00:00Z"
tags: [knowledge, architecture, layers, personal]
---
# Knowledge layer architecture — docs, code, personal

## As built

The knowledge layer is one `knowledge` table and one hybrid ranker. There are no separate stores per layer. Three
orthogonal columns describe a row:

- `scope` — audience: `global`, `project`, or `user` (with `owner_user`).
- `source_kind` — what it was distilled from: `code`, `product`, `spec`, `decision`, `runbook`, `native-memory`;
  defaults to `code` when unasserted.
- `origin_class` — trust: `owner`, `agent`, `untrusted`.

Every surface (search_knowledge, ask_expert, launch injection, Persona recall) ranks over the same table with the same
blending, then applies its own gates.

## Docs vs code vs personal

- **Docs** are any rows: runbooks, decisions, specs.
- **Code** is not a layer today. "Code knowledge" means prose docs labeled `source_kind=code` (often just the default)
  plus a ripgrep arm in ask_expert. No source file is indexed.
- **Personal** is the owner's mirrored CLAUDE.md and rules (stored global) plus Persona memories (scope=user).

## Target shape

| Layer | Source of truth | Retrieval | Delivery |
|---|---|---|---|
| Code (live) | the repo at HEAD | symbol/path index + grep | expert code slots |
| Intent | per-project product/spec docs | same-project only | launch product block with a floor |
| Team docs | KB docs | hybrid, section chunks | search, expert, gated injection |
| Personal profile | CLAUDE.md, rules, feedback memories | not ranked; loaded whole | Persona prompt, appended to briefs |
| Activity | sessions, checkpoints | recency | whats_happening, Persona |
