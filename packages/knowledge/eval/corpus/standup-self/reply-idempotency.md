---
title: "Reply idempotency and optimistic pending events"
source_kind: decision
origin_class: agent
confidence: 1
source_session_id: "sess-std-27c9"
generated_at: "2026-09-13T10:00:00Z"
tags: [console, replies, idempotency]
---
# Reply idempotency and optimistic pending events

When the owner sends a reply from the console, the UI appends an **optimistic pending** transcript event right away,
tagged with a client-generated nonce. The collector forwards the reply to the session and records the real
transcript event with the same nonce. The UI reconciles the two by nonce, replacing the pending event instead of
showing a duplicate. A retried POST with a nonce that already exists is a no-op, so double-clicks and network retries
never send the reply twice. Attribution (which user sent it) comes from the tunnel identity header.
