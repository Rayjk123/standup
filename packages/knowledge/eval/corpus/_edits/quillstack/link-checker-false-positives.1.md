---
title: Link checker false positives
source_kind: runbook
origin_class: owner
generated_at: "2026-07-06T10:15:00Z"
tags: [quillstack, link-checker, false-positives, ci]
---
# Link checker false positives

`quill check links` checks every internal and external link after a build and fails CI on the first broken one.

## Known false positives

- Hosts that rate-limit CI return 429. Retry the job.
- Servers that reject `HEAD` return 405. These are reported as errors for now.
- Anchors created by JavaScript cannot be seen by the checker.

## Skipping URLs

Pass `--skip <url-prefix>` to `quill check links`, once per prefix, in the CI script. Keep the list short and review it
every release.
