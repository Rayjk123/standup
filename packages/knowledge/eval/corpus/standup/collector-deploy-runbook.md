---
title: "Collector deploy runbook"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-30T10:00:00Z"
tags: [collector, deploy, runbook]
---
# Collector deploy runbook

1. `git pull --ff-only` and `bun install --frozen-lockfile`.
2. `bun run build:collector`.
3. Back up the database: `cp ~/.local/share/standup/standup.db ~/.local/share/standup/backups/standup-$(date +%F).db`.
4. Run migrations **separately**: `bun run db:migrate`. Read its output; stop if it reports an unexpected schema version.
5. Restart the collector service (`systemctl --user restart standup-collector`, or the launchd agent on macOS).
6. Check `curl -s localhost:7781/health` reports the new build sha.

**Never combine migrate and deploy in one step**, and never skip the backup: migrations are forward-only and the
backup is the only rollback across a schema change.
