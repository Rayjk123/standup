---
title: "Review artifact provider seam"
source_kind: decision
origin_class: owner
generated_at: "2026-09-11T10:00:00Z"
tags: [review, provider, integration]
---
# Review artifact provider seam

Sessions can produce a review artifact (a GitHub pull request or a GitLab merge request). Standup models this as a
pluggable **review-artifact provider**:

- Interface: `detect(sessionEvents)`, `fetchStatus(ref)`, `linkFor(ref)`.
- Implementations: `github-pr` (parses PR URLs, polls the GitHub API) and `gitlab-mr` (parses MR ids printed by the
  `glab` command line tool).
- The provider is chosen **per project** in project config (`reviewProvider`), defaulting to `github-pr`.
- The session view shows the artifact's state (open, approved, merged) next to the session title.
