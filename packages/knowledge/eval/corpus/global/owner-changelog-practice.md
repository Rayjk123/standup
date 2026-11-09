---
title: How Rae keeps a CHANGELOG
source_kind: decision
scope: user
owner_user: owner
origin_class: owner
generated_at: "2026-07-11T08:05:00Z"
tags: [changelog, release, writing]
---
# How Rae keeps a CHANGELOG

Every repo Rae maintains has a `CHANGELOG.md` in the Keep a Changelog shape.

- The top section is always `## Unreleased`. New entries go there, in the same commit as the change, never
  in a separate "update changelog" commit.
- Under `Unreleased`, entries are grouped by `### Added`, `### Changed`, `### Fixed` and `### Removed`, in that
  order. Empty groups are left out.
- One line per entry, written for someone upgrading: what they will notice, not which file changed.
- At release time the `Unreleased` heading is renamed to `## <version> — <YYYY-MM-DD>` and a fresh, empty
  `## Unreleased` is added above it. Nothing else is rewritten.
- Internal refactors, test-only changes and CI tweaks get no entry.
