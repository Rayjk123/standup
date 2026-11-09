---
title: "Launch model selection"
source_kind: decision
origin_class: agent
confidence: 1
source_session_id: "sess-std-41c2"
generated_at: "2026-09-21T10:00:00Z"
tags: [launcher, model, effort]
---
# Launch model selection

Every console launch records a **model** and an **effort** level.

- Defaults come from the project config (`defaultModel`, `defaultEffort`); with none set, the launcher uses the
  host default model at `medium` effort.
- The launch dialog has a model picker and an effort segmented control (`low`, `medium`, `high`).
- The chosen pair is passed to the worker as `--model` plus the effort setting and stored on the `launches` row.
- A running session's model and effort can be switched from the session view; the switch applies from the next turn.
