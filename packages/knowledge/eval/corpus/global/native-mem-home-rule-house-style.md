---
title: House style for commits, summaries and changelogs
source_kind: native-memory
scope: user
owner_user: owner
origin_class: owner
generated_at: "2026-07-08T09:15:00Z"
native_memory_from: home
tags: [preferences, writing, git, changelog]
---
# House style for commits, summaries and changelogs

Rae Okafor's rules for anything an agent writes on her behalf.

| What | Rule |
|---|---|
| Commit subject | Imperative mood ("Add tide cache", not "Added tide cache"), under 60 characters, no trailing period |
| Commit body | Optional; when present, one short paragraph on why |
| End-of-task summary | A table, not a bullet list: one row per change, columns *Change*, *Where*, *Verified by* |
| Emoji | None, anywhere: commits, summaries, comments, chat replies |
| CHANGELOG | Every user-visible change adds a line under the `## Unreleased` heading at the top of `CHANGELOG.md` |

When the repo's own conventions allow a longer subject, still keep Rae's subjects under 60 characters; a
longer subject is truncated in the terminal log view she reads every morning.

If a summary genuinely has one item, a single sentence is fine; the table rule applies from two items up.
