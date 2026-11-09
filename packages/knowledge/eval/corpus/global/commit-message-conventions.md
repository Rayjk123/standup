---
title: Commit message conventions
source_kind: decision
scope: global
origin_class: owner
tags: [conventions, git]
---
# Commit message conventions

- Subject line in the imperative mood ("Add retry to the mirror", not "Added retries"), at most 72 characters, no
  trailing period.
- Blank line, then a body that explains why the change is needed and anything surprising about how it works. The diff
  already shows what changed.
- Reference the tracking issue in a trailer at the end of the body: `Issue: <issue-id>`.
- No WIP or "fix typo" commits on shared branches; squash them before the branch is shared.
- One logical change per commit, so a revert undoes exactly one thing.
