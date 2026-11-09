---
title: Working hours, shell and editor
source_kind: native-memory
scope: user
owner_user: owner
origin_class: owner
generated_at: "2026-07-15T17:40:00Z"
native_memory_from: home
tags: [preferences, schedule, tooling, shell]
---
# Working hours, shell and editor

## Hours

I work from Lagos, UTC+1 all year (no daylight saving). Quiet hours are 22:00 to 07:00 local: no Slack
messages, no pings and no review requests in that window. Long-running jobs that finish overnight should
queue their report for 07:00 instead of sending it when they finish.

## Shell

My shell is fish. Commands you hand me to paste must run in fish:

- `set -x NAME value` (or `env NAME=value cmd`), not `export NAME=value`.
- No heredocs; fish has none. Give me a file to create instead.
- `and` / `or` or `;` are fine between commands; so is `&&`.

## Editor

I edit with helix (`hx`). When a step says "open the file", write `hx path/to/file:LINE`, never a VS Code
or vim command.

## Dependencies

I batch dependency upgrades once a month, on the first Monday. Outside that window, don't bump a version
unless it fixes a security advisory or the task is the upgrade itself.
