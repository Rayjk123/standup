---
title: How long Quill Preview keeps a preview deployment
source_kind: decision
origin_class: owner
generated_at: "2026-07-27T08:30:00Z"
tags: [quillstack, preview, retention, hibernation, storage]
---
# How long Quill Preview keeps a preview deployment

Quill Preview builds every pull request on a connected repository and serves it at
`pr-<number>.<site>.preview.quillstack.example`. Pushes to non-default branches without a pull request get a branch
preview at `br-<slug>.<site>.preview.quillstack.example`. Storage, not compute, is the service's main cost, so
retention is deliberately shaped around how reviewers actually use previews.

## The rules

| Preview | Kept while | Deleted |
|---|---|---|
| Pull request, open | The pull request is open | — |
| Pull request, open but idle | No push for 45 days | Not deleted: **hibernated** (see below) |
| Pull request, closed or merged | — | 10 days after closing |
| Branch preview | — | 7 days after the last push to the branch |
| Default-branch preview | Always | Replaced on every push; only the latest build is kept |

A reopened pull request gets its preview back if it has not been deleted yet; otherwise the next push rebuilds it.

## Hibernation

An idle open preview is moved to cold storage. Its URL keeps working: the first request shows a "waking up" page and
the preview is served again within about 20 seconds. Hibernation was chosen over deletion because long-lived docs
pull requests (a new product's whole guide) sit for weeks waiting on a launch date, and reviewers came back to dead
links.

## Limits

- 200 live previews per organisation; hibernated previews do not count. At the limit, the oldest closed-PR previews are
  deleted first, then branch previews, never an open pull request's.
- A single preview may be at most 2 GiB of output. Larger builds fail with a message pointing at `quill build --stats`.

## Overrides

A site can shorten, not lengthen, the closed-PR window with `[preview] closed_retention_days` in `quill.toml`. Some
teams set it to 0 for repositories that preview unreleased products. Longer retention is a paid-plan setting on the
organisation, not in the repository.
