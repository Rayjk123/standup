---
title: 2026-07-21 release script session
source_kind: native-memory
origin_class: agent
generated_at: "2026-07-21T16:30:00Z"
last_verified_at: "2026-07-21T16:30:00Z"
native_memory_from: auto-memory
tags: [activity, release]
---
# 2026-07-21 release script session

- Added a summary table to the end of the release script's output: package, old version, new version.
- Moved the `## Unreleased` CHANGELOG entries under the new version heading as part of the dry run; the real
  run is still manual.
- Left open: the script does not yet refuse to run with a dirty work tree.
