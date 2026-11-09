---
title: "Tunnel-authenticated identity trust model"
source_kind: decision
origin_class: owner
generated_at: "2026-09-10T14:00:00Z"
tags: [multiplayer, identity, trust, security]
---
# Tunnel-authenticated identity trust model

## Decision

In multiplayer mode the identity of the requesting user comes **only** from the tunnel-authenticated header
`X-Standup-User`, which the tunnel sets after authenticating the connection. The collector never trusts a
caller-supplied `user`, `actor`, or `owner` field in a request body for retrieval scoping.

## Consequences

- MCP tools forward `scoped: true` and the query, never a user field; the server resolves the identity from the header.
- A missing or untrusted header resolves to "no user". Retrieval then falls back to **global ∪ project**, dropping
  the user disjunct, so another user's user-scoped docs are never routed to an unidentified caller.
- Sessions all run as the host user; the trust boundary is the team, not the individual. User scoping is a soft
  routing boundary, not a privacy wall: the browse UI can still show every user's docs.

## Rejected alternatives

- Per-request signed tokens from the MCP client: too much key management for a single-team tool.
- Trusting the `user` field from the console: any agent could impersonate another user.
