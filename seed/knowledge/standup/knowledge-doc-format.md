---
title: 'Knowledge doc format: one markdown file per fact, YAML frontmatter on top'
tags:
  - knowledge
  - format
  - seed
origin_class: owner
source_kind: spec
scope: project
confidence: 0.9
half_life_days: 365
---
Every knowledge doc is one markdown file at `<knowledge-dir>/<project-id>/<slug>.md`.
The directory name is the project id, and the file name (without `.md`) is the
slug. Standup indexes a doc only when its project id is registered in
`projects.toml`, so every directory under `seed/knowledge/` has a matching
`[[project]]` entry in `seed/projects.toml`.

## Frontmatter

| Field | Meaning |
|---|---|
| `title` | One line that states the fact, not just the topic. Search shows it first. |
| `tags` | Free-form keywords that help retrieval. |
| `origin_class` | Who wrote it: `owner`, `agent`, `untrusted` or `system`. Only `owner` and `agent` docs are injected into an agent's context automatically. |
| `source_kind` | What it was distilled from: `code`, `product`, `spec`, `decision`, `runbook` or `unclassified`. A doc with no kind reads as `unclassified` and is never injected as code knowledge. |
| `scope` | Who retrieves it: `project` (the default), `global` (every project) or `user` (one person). Seed docs never use `user`. |
| `confidence` | Base confidence from 0 to 1, as of `last_verified_at`. |
| `half_life_days` | How fast that confidence decays when nobody re-verifies the doc. |
| `last_verified_at` | Optional date the doc was last checked against the code. |

## Body

Write the fact, why it holds, and where in the code it lives. Link related
docs with `[[slug]]`. Leave out status reports, session narration, dates of
"validated on" checks, and personal account or resource ids.

## Seeding

`bun run kb:seed` copies every `.md` file under `seed/knowledge/` into the
knowledge dir (`KNOWLEDGE_DIR`, default `~/.config/standup/knowledge`). It
never overwrites a doc that already exists at the same path, so it is safe to
re-run after local edits.
