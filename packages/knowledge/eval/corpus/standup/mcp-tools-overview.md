---
title: MCP tools overview
ingested_from: plan/mcp-tools.md
generated_at: "2026-08-22T10:00:00Z"
tags: [mcp, tools, agents]
---
# MCP tools overview

The collector's MCP server registers 7 tools for agents. This is the full list.

| Tool | Purpose |
|---|---|
| search_knowledge | Hybrid text + semantic search over the project's knowledge corpus. |
| ask_expert | Ask a question; the expert synthesizes an answer with Sources. |
| propose_knowledge | Propose a new doc or an update to an existing slug. |
| whats_happening | What other sessions in the project are doing right now. |
| checkpoint | Record a progress note the console shows on the session card. |
| heartbeat | Tell the collector the session is alive; sessions without one go amber. |
| report_task | Report a task's final status and summary. |

## Conventions

- Every tool takes the session id implicitly from the MCP connection.
- Tools return plain text, not JSON, so agents can quote them.
- Write tools (propose_knowledge, checkpoint, report_task) are rate limited to 30 calls per minute per session.

## Not planned

- A raw doc fetch tool (search excerpts are enough).
- Messaging between sessions.
