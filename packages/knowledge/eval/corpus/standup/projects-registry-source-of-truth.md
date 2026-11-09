---
title: "Projects registry: SQLite is the source of truth"
source_kind: decision
origin_class: owner
generated_at: "2026-10-01T10:00:00Z"
last_verified_at: "2026-10-01T10:00:00Z"
tags: [projects, registry, config]
---
# Projects registry: SQLite is the source of truth

## Decision

The **SQLite `projects` table** is the source of truth for the project registry. `loadProjects()` in
`src/collector/projects-registry.ts` reads it on every request that needs project config.

`projects.toml` is a **one-time import**: `importProjectsToml()` runs only when the `projects` table is empty (first
boot or a fresh data dir). **Nothing watches the file.** Editing `projects.toml` after the first boot has no effect.

## How to change a project

- In the console: Settings -> Projects -> edit repos, name, default model.
- Over HTTP: `PUT /api/projects/:id` with the full project JSON.

## Why

The file watcher we had early on raced with console edits and silently reverted them. Keeping one writable store
removed the race. Older design notes and runbooks that say the TOML is watched predate this.
