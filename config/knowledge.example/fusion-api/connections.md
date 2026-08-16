---
title: How this connects to other projects
tags: [context, architecture]
---

- **content-tools** reads from fusion-api's `/documents` endpoint. Breaking
  changes there need a heads-up in #content-tools before shipping.
- **milestone-tracker** does not talk to fusion-api directly — it goes
  through the `fusion-graph` service, which is fusion-api's sibling repo in
  this project. Treat fusion-api and fusion-graph as one deployable unit.
- Auth is shared across all Fusion projects via the `fusion-auth` package.
  Do not reimplement token validation locally.
