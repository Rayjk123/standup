---
title: Agent Session Manager — Design
ingested_from: plan/high-level-design.md
generated_at: "2026-08-20T10:00:00Z"
tags: [design, architecture, collector, console]
---
# Agent Session Manager — Design

## 1. Purpose

Standup is an agent session manager: one place to see every Claude Code session running on the host, launch new
ones into a project, steer them, and give them shared context. The owner should be able to glance at the console and
know what each agent is doing, what it is blocked on, and what it learned.

## 2. Components

### 2.1 Collector

A single Bun process. It receives Claude Code hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
Stop, SessionEnd), tails transcripts, and stores everything in one SQLite database. It also hosts the MCP server that
agents talk to and the HTTP API the console uses. The collector listens on port 7780 on localhost; the console and
the MCP bridge both connect there.

### 2.2 Console

A React single-page app served by the collector. Left: the session sidebar grouped by project. Center: the transcript
view of the selected session with a composer for steering messages. Right: a context panel (tickets, checkpoints,
knowledge hits).

### 2.3 MCP server

Exposes tools to agents: knowledge search, the expert, checkpoints, heartbeats, task reports. Every tool call is logged
against the calling session.

### 2.4 Project registry

projects.toml is the registry and a file watcher reloads it. Each `[[project]]` table names an id, a display name and
one or more repo paths. The collector watches the file and reloads projects within a second of a save, so adding a
project is just editing projects.toml; there is no API for it and none is planned.

## 3. Knowledge

### 3.1 Corpus

A directory of markdown files per project under the knowledge dir, with YAML front matter (title, tags). The loader
reads them on boot and on change and writes them into SQLite: one row per doc, FTS5 for text search, and an embedding
per chunk.

### 3.2 Search

search_knowledge combines FTS5 bm25 with embedding similarity and returns the top hits with a short excerpt.

### 3.3 ask_expert

ask_expert performs graph traversal over code structure. Given a question, it locates the code entities the question
names (files, classes, functions), walks the call and import graph outward two hops, and summarizes what it finds,
citing the code it visited. The knowledge corpus is consulted only for intent questions; code questions are answered
from the code graph.

### 3.4 Launch injection

When the console launches a session, the launcher prepends a short knowledge preamble to the first prompt. Launch
injection is a static preamble, not retrieval of specific product docs: every launch in a project gets the same
project summary and conventions, regardless of the task. Retrieving per-task docs was considered and rejected as too
noisy.

## 4. Data model

| Table | Purpose |
|---|---|
| sessions | one row per Claude Code session (id, project, cwd, status, started_at) |
| transcript_events | parsed transcript lines |
| hooks | raw hook payloads |
| knowledge | one row per doc (project_id, slug, title, body, tags) |
| knowledge_chunks | chunk text + embedding JSON |
| knowledge_fts | FTS5 over title + body |
| launches | console launches (prompt, model, project) |

There is no vector table; embeddings live as JSON arrays in `knowledge_chunks`.

## 5. Session lifecycle

1. The console calls `POST /api/launch` with a project and a prompt.
2. The launcher spawns `claude` in a PTY in the project's first repo, with the preamble prepended.
3. Hooks report SessionStart; the collector links the session to the launch.
4. Heartbeats arrive through the MCP heartbeat tool; a session without a heartbeat for a while is shown amber.
5. Stop and SessionEnd close the session.

## 6. Steering

The owner types into the composer; the collector writes the message into the session's mailbox, and the
UserPromptSubmit hook drains the mailbox into the next prompt.

## 7. Security

Everything binds to localhost. There is one user, the host user; no authentication is needed. Multiplayer is out of
scope for this design.

## 8. Non-goals

- Remote access.
- Multiple users.
- Indexing source code as knowledge (the expert reads code directly through the code graph).
- A vector database.

## 10. Hooks contract

Each hook posts its JSON payload to `POST /api/hooks/<event>` on the collector. The collector answers within 200 ms or
the hook gives up; a slow collector must never block the agent. SessionStart may return `additionalContext`, which
Claude Code prepends to the session; this is how the launch preamble reaches sessions started from a plain terminal.

| Hook | Collector action |
|---|---|
| SessionStart | create or link the session row, return the preamble |
| UserPromptSubmit | drain the mailbox into the prompt |
| PreToolUse / PostToolUse | record tool calls for the transcript view |
| Stop | mark the turn finished |
| SessionEnd | close the session |

## 11. Storage sizing

Transcript events dominate: roughly 2 MB per active session-day. Knowledge is small (a few hundred docs). One SQLite
file in WAL mode is enough; the collector checkpoints the WAL every 5 minutes.

## 12. Failure modes

- Collector down: hooks time out silently, sessions keep running, the console shows a banner on reconnect.
- Ollama down: knowledge search falls back to FTS only.
- Corrupt transcript line: skipped and counted, never fatal.

## 9. Open questions

- How long to retain transcript events (currently forever).
- Whether to mirror sessions into Slack.
- Whether the expert should also read the knowledge corpus for code questions.
