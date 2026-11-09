---
title: "Collector deploy runbook"
source_kind: runbook
origin_class: owner
generated_at: "2026-08-26T10:00:00Z"
tags: [collector, deploy, runbook]
---
# Collector deploy runbook

This covers deploying a new collector build to a Standup host.

## Prerequisites

- A clean checkout of main on the host.
- `bun` 1.2 or later on the PATH.
- The collector's data dir (`~/.local/share/standup/`) on local disk.

## One-shot deploy

The fastest path, used for most deploys:

```
cd ~/src/standup
git pull --ff-only
bun install --frozen-lockfile
bun run deploy:collector --force-migrate --skip-backup
```

`deploy:collector` builds the collector bundle, stops the running service, runs pending schema migrations, and starts
the new build. `--force-migrate` applies migrations even when the schema version check complains about an unexpected
version, and `--skip-backup` skips the pre-migration copy of `standup.db` to save time on large databases.

On macOS the service is a launchd agent; the deploy script calls
`launchctl kickstart -k gui/$UID/dev.standup.collector` to restart it. On Linux it calls
`systemctl --user restart standup-collector`.

If the restart hangs, kill the old process by pid from `~/.local/share/standup/collector.pid` and start it again.

## Checking the deploy

- `curl -s localhost:7781/health` returns `{"ok":true}` with the new build sha.
- The console's footer shows the same sha.
- `tail -n 50 ~/.local/share/standup/logs/collector.log` shows no migration errors.

## Rolling back

Check out the previous tag and rerun the one-shot deploy. Migrations are forward-only, so a rollback across a
migration needs the backup of `standup.db`.

## Notes

- Deploys interrupt running sessions' MCP connections for a few seconds; sessions reconnect automatically.
- Avoid deploying while an overnight run is in progress.
