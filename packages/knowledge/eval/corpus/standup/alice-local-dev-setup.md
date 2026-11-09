---
title: alice's local dev setup (second collector)
source_kind: runbook
scope: user
owner_user: alice
origin_class: owner
generated_at: "2026-09-24T10:00:00Z"
tags: [dev-setup, collector]
---
# alice's local dev setup (second collector)

How alice runs her own Standup collector next to the shared one on the team dev box.

- Start a second collector on port 7790: `STANDUP_PORT=7790 STANDUP_DATA_DIR=~/.standup-alice bun run collector`.
- Separate data dir `~/.standup-alice` so her sessions and knowledge DB never mix with the shared one.
- Console at `http://localhost:7790`; the MCP bridge config in her Claude settings points at 7790 too.
- pnpm alias `sd` (`alias sd="pnpm --filter @standup/collector"`) for running collector scripts.
- She keeps the Ollama model pinned by digest locally so her embeddings don't drift when the shared box re-pulls.
- To reset: stop the process, `rm -rf ~/.standup-alice/standup.db*`, restart; the corpus re-syncs from disk.
