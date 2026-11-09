---
title: Quill Preview launch notes
source_kind: product
origin_class: agent
generated_at: "2026-07-03T17:50:00Z"
verdict: superseded
tags: [quillstack, preview, retention, launch]
---
# Quill Preview launch notes

Summary of the Quill Preview beta as it launched.

- Every pull request on a connected repository gets a preview at `pr-<number>.<site>.preview.quillstack.example`.
- Previews are kept for **7 days after the last push** and then deleted, whether the pull request is open or not. A new
  push rebuilds it.
- There is no cold storage; a deleted preview is gone until the next build.
- Branch previews are not supported yet; only pull requests are built.
- Each organisation can have 50 live previews. At the limit, new builds queue until one expires.
- The bot comment links the preview and the build log.

Open items for after the beta: longer retention for paid plans, branch previews, and a way to keep a preview alive for
a pull request that is waiting on a launch.
