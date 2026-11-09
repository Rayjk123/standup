---
title: Launch knowledge injection
source_kind: decision
origin_class: owner
generated_at: "2026-08-27T10:00:00Z"
ingested_from: "/Users/owner/standup/plan/launch-knowledge-injection.md"
tags: [launcher, injection, knowledge]
---
# Launch knowledge injection

When the console launches a session, the launcher searches the knowledge base with the task prompt and prepends
the best hits to the session's first message.

## Today

- A single "Relevant code knowledge" block.
- Searches the launch project's docs, keeps the top 3.
- Gated on origin class and confidence.

## Next

- A separate product/spec block so agents see product intent alongside code knowledge. Not built yet.
- Possibly a relevance floor.
