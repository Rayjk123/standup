---
title: Competitive analysis — agent consoles and memory layers
ingested_from: plan/competitive-analysis.md
generated_at: "2026-08-18T10:00:00Z"
tags: [plan, competitive, research]
---
# Competitive analysis — agent consoles and memory layers

How Standup compares to other ways of running many coding agents with shared context. Written to pick what to build
next, not to rank products.

## Dimensions

| Dimension | Plain terminal + tmux | Hosted agent dashboards | Personal-assistant frameworks | Standup (today) |
|---|---|---|---|---|
| See all sessions at once | manual | yes | partial | yes |
| Steer a running session | type into it | limited | chat | composer + mailbox |
| Shared knowledge across sessions | none | per workspace | per user memory files | per-project corpus |
| Knowledge injected at launch | none | system prompt | memory file loaded whole | static preamble |
| Code awareness | none | repo index | none | expert reads code |
| Runs locally | yes | no | yes | yes |

## Where Standup is behind

1. **Typed launch context.** Other tools separate "how the code works" from "what the product should do". Splitting
   launch knowledge by source_kind into a code block and a product/spec block is a planned feature, not yet
   implemented. Today every launch gets one undifferentiated preamble.
2. **Memory that learns from corrections.** Personal-assistant frameworks append a correction to a memory file the next
   turn reads. Standup has no equivalent.
3. **Remote access.** Hosted dashboards work from a phone.

## Where Standup is ahead

1. Local-first, no data leaves the host.
2. One console across projects.
3. The expert answers from the corpus and the code together.

## Recommendations

- Build the typed launch blocks (code vs product/spec) next.
- Prototype a correction memory for Persona.
- Keep remote access out of scope until multiplayer identity is designed.
