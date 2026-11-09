---
title: "Collector runbook"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-05T10:00:00Z"
tags: [collector, runbook, operations]
---
# Collector runbook

## Basics

- The collector listens on **port 7781** by default. Override with `STANDUP_PORT=<port>`.
- Data dir: `~/.local/share/standup/` (database `standup.db`, logs in `logs/`, knowledge corpus mirrored under
  `knowledge/`).
- Logs: `logs/collector.log`, rotated daily, 7 days kept.
- Health: `curl -s localhost:7781/health`.

## Projects

The project list lives in `~/.config/standup/projects.toml`. **The collector watches `projects.toml`**; edit it and
the collector reloads projects within a second, no restart needed.

## Knowledge

- Knowledge sync runs at boot and lazily when a project's corpus dir changes.
- ask_expert drops candidates below a **relevance floor of 0.15** before synthesis.
- To force a full re-embed, delete the `knowledge_vec` rows and restart.

## Common problems

| Problem | Check |
|---|---|
| Console shows "disconnected" | collector process alive? port in use? |
| Knowledge search returns nothing new | was the file saved under the right project dir? |
| Synth answers are raw dumps | Bedrock credentials for headless claude |
| Slack mirror silent | bot token, channel id in settings |
