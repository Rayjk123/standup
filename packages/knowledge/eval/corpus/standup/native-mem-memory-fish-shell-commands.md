---
title: Give Rae fish-compatible commands in this repo
source_kind: native-memory
scope: user
owner_user: owner
origin_class: agent
generated_at: "2026-07-19T14:10:00Z"
native_memory_from: auto-memory
tags: [feedback, shell, tooling]
---
# Give Rae fish-compatible commands in this repo

Rae pastes setup commands straight into fish. Twice this month a `bun run dev` instruction failed because it
was written as `export STANDUP_PORT=4318 && bun run dev`. Write `env STANDUP_PORT=4318 bun run dev` instead,
and put any multi-line config into a file she creates with `hx` rather than a heredoc.
