---
title: OpenClaw architecture deep-read
origin_class: agent
confidence: 1
source_session_id: "sess-research-41c2"
generated_at: "2026-09-09T21:00:00Z"
tags: [research, openclaw, architecture, memory, agents]
---
# OpenClaw architecture deep-read

This is a deep read of **OpenClaw**, an open-source personal-assistant agent framework, done to understand how another
project structures sessions, memory, retrieval, tools, and scheduling. Everything below describes OpenClaw's codebase,
not ours. Module names and file paths are OpenClaw's. Where a design choice is interesting as a comparison point it is
noted inline, but this document is a description of a different system and should not be read as a description of how
anything in our own repository works.

The read covered the gateway, the channel adapters, the agent runtime, the memory workspace and memory search, the
tool and skill systems, cron, sandboxing, model selection and failover, and auth profiles. Roughly 60 source files were
read closely and another hundred skimmed.

---

## 1. High-level shape

OpenClaw runs as a single long-lived process called the **gateway**. The gateway owns:

- a set of **channel adapters** that connect to messaging surfaces (a chat app, SMS via a provider, email, a local web
  UI, and a CLI);
- a **session router** that maps an inbound message to an agent session;
- the **agent runtime**, which runs model turns, executes tools, and streams output back through the channel;
- the **memory subsystem**, a directory of markdown files on disk plus a search index over them;
- a **scheduler** for cron-style jobs and reminders;
- an optional **sandbox** for running tools in an isolated container.

All of this is TypeScript running on Node. State lives in a per-user home directory, by default
`~/.openclaw/`, with subdirectories for config, sessions, memory, skills, and logs. There is no external database; the
search index is a SQLite file in the memory directory.

The process model is deliberately simple: one gateway per user, many sessions inside it, each session a sequence of
turns. Concurrency is handled by a per-session queue so two inbound messages to the same session never run turns in
parallel.

## 2. The gateway

The gateway entry point is `src/gateway/server.ts`. On boot it:

1. loads config from `~/.openclaw/config.json5` and merges environment overrides;
2. resolves auth profiles (see section 13);
3. starts each enabled channel adapter;
4. opens the memory index and runs a sync pass over the memory workspace;
5. starts the scheduler and loads persisted jobs;
6. exposes a small local HTTP control API on a loopback port for the CLI and web UI.

The control API is not authenticated beyond binding to loopback, with an optional shared token. It exposes routes to
list sessions, send a message into a session, read a session transcript, trigger a memory reindex, and list or edit
cron jobs.

Graceful shutdown drains in-flight turns with a timeout, flushes transcripts, and closes the SQLite handle. If a turn is
mid-tool-call at shutdown, the tool result is recorded as interrupted and the next boot shows the turn as incomplete
rather than retrying it automatically.

## 3. Channel adapters

Each channel adapter implements a small interface in `src/channels/types.ts`: `start()`, `stop()`, an `onMessage`
callback the gateway registers, and `send(sessionKey, payload)`. Payloads are a channel-neutral structure with text,
optional attachments, and optional "rich" blocks that each adapter renders as well as it can.

Notable adapter behaviors:

- **Chat app adapter.** Uses the platform's socket API for inbound events and its web API for outbound. Long outputs
  are split at paragraph boundaries under the platform's message size limit. Tool activity is rendered as a collapsible
  block when the platform supports it, otherwise as a short status line. Outbound posts go through a retry helper that
  backs off on rate-limit responses.
- **SMS adapter.** Strips formatting, truncates aggressively, and appends a "reply MORE for the rest" affordance that
  stores the remainder in the session.
- **Email adapter.** Threads by message id; replies quote the previous turn.
- **Web UI adapter.** Streams tokens over server-sent events.
- **CLI adapter.** Used for local testing; reads stdin, writes stdout.

The session key is derived per channel: for the chat app it is the channel id plus thread id; for SMS the phone number;
for email the thread root. The router can be configured to map several channel keys onto one logical session, which is
how a user continues a conversation from their phone that they started at their desk.

## 4. Session router and session storage

`src/sessions/router.ts` resolves an inbound message to a session. Rules are evaluated in order: explicit mappings from
config, then a per-channel default, then "create a new session". Each session has an id, a channel key list, an agent
profile name, a created time, a last-active time, and a transcript.

Transcripts are stored as JSON lines in `~/.openclaw/sessions/<id>.jsonl`, one line per event: user message, assistant
message, tool call, tool result, system note. The runtime reads the tail of the transcript to rebuild the context for
each turn, bounded by a token budget. Older events are summarized into a rolling summary stored in a sidecar file,
regenerated when the unsummarized tail exceeds a threshold.

Sessions idle beyond a configurable period are marked dormant. A dormant session's next inbound message triggers a
"resume" step that loads the rolling summary and the most recent events instead of the full tail.

## 5. Agent runtime

The runtime lives in `src/agent/`. A turn proceeds:

1. build the system prompt from the agent profile, the user's persona file, and any always-on memory files;
2. optionally run a **memory recall** step that searches memory with the user's message and inserts the top results as a
   context block;
3. send the conversation to the model with the tool definitions enabled for this profile;
4. stream the response; on tool calls, execute them (possibly in the sandbox) and feed results back;
5. repeat until the model ends the turn or a tool-call budget is exhausted;
6. append all events to the transcript and run post-turn hooks (for example, a hook that decides whether to write
   anything to memory).

The system prompt assembly in step 1 is worth noting as a comparison point: OpenClaw always loads a small set of files
from the memory workspace unconditionally on every turn, specifically the user profile and a pinned-facts file, and only
uses ranked retrieval for the larger body of notes. Personal facts never compete with topical notes in a ranking.

Tool-call budget defaults to 25 calls per turn. Each tool call has its own timeout; the default is 120 seconds, and
tools that call out to the network wrap their fetch calls in an abort signal so a hung request cannot hold the turn.

## 6. The memory workspace

Memory in OpenClaw is a directory of markdown files, by default `~/.openclaw/memory/`. The layout is:

- `MEMORY.md` — the long-term memory file, curated, organized by headings;
- `USER.md` — the user profile (name, preferences, standing instructions);
- `PINNED.md` — short facts loaded every turn;
- `daily/YYYY-MM-DD.md` — daily notes, appended to during the day;
- `notes/*.md` — topical notes the agent or user creates;
- `archive/` — notes moved out of active retrieval.

The agent edits these files through dedicated memory tools rather than general file tools, so writes can be validated and
indexed immediately. The user can also edit them directly with any editor; a file watcher picks up changes.

Each file can carry front matter with `tags`, `pinned: true`, `expires`, and `supersedes` (a list of note paths this note
replaces). When a note declares `supersedes`, the superseded notes are moved to `archive/` on the next sync and drop out
of retrieval.

### 6.1 Daily notes

Daily notes are the agent's scratchpad. The post-turn hook appends a short line for turns it considers notable. At
midnight local time a consolidation job reads the previous day's note, extracts anything durable into `MEMORY.md` or a
topical note, and leaves the daily note as an archive. Daily notes older than a retention period (default 30 days) are
excluded from retrieval but kept on disk.

### 6.2 Standing instructions

When the user says something like "from now on" or "always", a classifier in the post-turn hook routes it to `USER.md`
under a "Standing instructions" heading. If an existing instruction on the same topic exists, the new one replaces it and
the old one is moved into a "Previous instructions" section with a date. Because `USER.md` is loaded every turn, a standing
instruction takes effect on the very next turn without depending on retrieval.

## 7. Memory search

OpenClaw's memory search is a hybrid of BM25 and vector similarity over chunks of the memory workspace files. It lives in
`src/memory/search/`.

### 7.1 Chunking

The chunker in `src/memory/search/chunker.ts` is markdown-aware. It first splits a file by headings, keeping a heading
path for each section ("MEMORY.md > Travel > Airlines"). Sections longer than a target size are split further at paragraph
boundaries, then sentences. Code fences are never split. Each chunk's indexed text is prefixed with the file title and
heading path, which measurably helps title-shaped queries.

Target chunk size is about 800 characters with no overlap; the heading path prefix provides context instead of overlap.

### 7.2 Index

The index is a SQLite file `memory/.index.sqlite` with three tables: `files` (path, mtime, content hash), `chunks` (file
id, ordinal, heading path, text), and an FTS5 virtual table over chunk text using the porter tokenizer. Vectors are stored
in a fourth table as blobs, one per chunk, alongside the name and a hash of the embedding model that produced them.

Sync compares each file's content hash against the stored hash. A changed file has all of its chunk rows deleted and
reinserted inside one transaction, including the FTS rows and vectors, so there is no window where old and new chunks
coexist and no orphaned rows. A removed file has its rows deleted. At the end of sync an integrity check compares the
FTS row count to the chunk row count and logs a warning if they differ.

### 7.3 Embeddings

Embeddings are pluggable. The default provider calls a hosted embeddings API; a local provider talks to a model server on
loopback. The provider interface distinguishes query embeddings from document embeddings, because some models expect a
different prefix or task type for each. The stored model hash is compared on boot; if it changed, all vectors are marked
stale and re-embedded in the background while search falls back to BM25 only.

### 7.4 Ranking

At query time OpenClaw runs BM25 and vector search separately, takes the top 50 of each, and fuses them with reciprocal
rank blending (RRF). Then it applies three adjustments:

- a recency factor for daily notes (newer daily notes rank higher, curated files are unaffected);
- a pin factor (pinned files are excluded from ranked results entirely because they are always loaded);
- an archive exclusion (archived files never appear).

A relevance floor is applied on the raw cosine similarity of the best chunk per file, not on the fused score. If no file
clears the floor, memory recall inserts nothing into the turn, and the memory search tool returns an explicit "no relevant
memory" result. The authors note in a comment that a fused score has no absolute meaning and so cannot be used for a floor.

### 7.5 Recall step

The automatic recall step in the agent runtime is conservative: at most three chunks, only when the best match clears the
floor, and never for messages under a minimum length. The model can always call the memory search tool explicitly for more.

## 8. Tools

Tools are defined in `src/tools/`, each as a module exporting a schema and a handler. The built-in set:

- `memory_search`, `memory_read`, `memory_write`, `memory_append_daily` — memory workspace operations;
- `web_fetch` — fetch a URL with a timeout and a size cap, return readable text;
- `web_search` — call a configured search provider;
- `shell` — run a command, in the sandbox if enabled;
- `file_read`, `file_write` — scoped to an allowed set of directories;
- `schedule` — create, list, or cancel cron jobs and reminders;
- `send_message` — post into another session or channel;
- `calendar`, `email_send` — optional integrations.

Each agent profile lists the tools it may use. Tool results are truncated to a per-tool limit before being returned to the
model, with a note that truncation happened.

### 8.1 Fetch handling

`web_fetch` is a thin wrapper around the runtime's fetch with three protections: an abort timeout (default 20 seconds), a
maximum response size (default 2 MB), and a content-type allowlist. The comment above it explains that without an
explicit abort signal a stalled server can hold the request for minutes, which would stall the whole turn. The same
wrapper is used by every integration that makes outbound HTTP calls.

## 9. Skills

Skills are packaged instructions plus optional tools, stored under `~/.openclaw/skills/<name>/`. A skill has a
`SKILL.md` with front matter (name, description, triggers) and a body of instructions, and optionally a `tools/` directory
of additional tool modules.

At turn time the runtime lists available skills in the system prompt by name and one-line description. When the model
decides a skill applies, it calls a `load_skill` tool that returns the skill body, which then becomes part of the turn's
context. Skills are not retrieved by similarity; the model chooses them from the list.

Skills can be installed from a registry or a git URL. Installation runs a static check on any bundled tool modules and
asks the user to approve the permissions they request.

## 10. Cron and reminders

The scheduler in `src/cron/` persists jobs to `~/.openclaw/cron.json`. A job has a schedule (cron expression or a one-shot
time), a target session or a fresh session, and a prompt. When a job fires, the scheduler injects the prompt into the
target session as a system-originated message, and the agent runs a normal turn.

Reminders are one-shot jobs created through the `schedule` tool. Recurring jobs include the nightly memory consolidation
(section 6.1), a weekly "review my notes" pass, and any user-defined routines.

The scheduler tracks last run, next run, and last result for every job, and the web UI shows them in one table. Missed
runs while the gateway was down are either skipped or run once on boot depending on a per-job flag.

## 11. Sandboxing

When enabled, tool execution for `shell`, `file_write`, and skill-provided tools happens inside a container. The sandbox
module in `src/sandbox/` manages a long-lived container per session, mounts an allowed working directory, and proxies
network access through an allowlist. Tool calls are executed with `docker exec` equivalents and a per-call timeout.

The sandbox has three modes: off, "tools only" (the default when enabled), and "strict" (also routes the model's own
outbound fetches through the proxy). Containers idle beyond a period are stopped; the next tool call restarts them.

## 12. Model selection and failover

Each agent profile names a primary model and an ordered list of fallbacks. The model client in `src/models/` wraps several
providers behind one interface. On a retryable error (rate limit, overload, transient network failure) the client retries
the same model with backoff; on a non-retryable error or after the retry budget, it fails over to the next model in the
list and records the failover in the transcript as a system note.

Authentication errors are explicitly non-retryable and do not trigger failover; instead the turn fails with a clear message
naming the auth profile involved, because silently failing over on an auth error would hide a configuration problem.

## 13. Auth profiles

Credentials are organized as named auth profiles in `~/.openclaw/auth.json5`. A profile has a provider, a method (API key,
OAuth token, or cloud credentials resolved from the environment), and optional settings such as region. Agent profiles and
tools reference auth profiles by name.

When OpenClaw spawns subprocesses that need credentials (for example a CLI-based model provider), it passes the resolved
credential environment explicitly rather than relying on inheritance from the gateway's own environment. A comment notes
that inheritance had caused intermittent permission failures when the gateway's environment pointed at a different profile
than the one the subprocess needed.

## 14. Configuration

Config is JSON5 with a schema in `src/config/schema.ts`. Every field has a default. The CLI has `openclaw config get` and
`openclaw config set` with schema validation, and the gateway hot-reloads a subset of fields (channel settings, cron, tool
limits) without restart. Fields that require a restart (auth profiles, sandbox mode) are flagged in the schema.

## 15. Observability

Logs are structured JSON lines under `~/.openclaw/logs/`. Each turn logs a summary: session id, model, token counts, tool
calls with durations, memory recall results with scores and whether each cleared the floor, and failovers. Memory search
logs every candidate considered with its BM25 rank, vector rank, fused score, raw cosine, and a drop reason if it was
filtered. A small `openclaw doctor` command reads recent logs and reports common problems.

## 16. Testing

The repository has unit tests per module and an integration suite that runs a gateway against a fake model provider and a
fake channel. The memory search has a labeled evaluation set of about 120 queries, including negative queries that should
return nothing, queries that should hit the user profile only through the always-loaded path and never through ranking, and
queries against edited files that check the new wording is findable and the old wording is not.

---

## 17. Module-by-module notes

### 17.1 `src/gateway/server.ts`

Boot order is strict and logged step by step. Each step has a timeout; a channel adapter that fails to start is disabled
with a warning rather than aborting boot. The control API is registered last so the CLI cannot send messages before the
runtime is ready.

### 17.2 `src/gateway/control-api.ts`

Routes are defined with a tiny router. Request bodies are validated against schemas. The send-message route accepts a
session id or a channel key and returns the turn id immediately; the result streams on a separate endpoint.

### 17.3 `src/channels/chat/adapter.ts`

Socket reconnect uses capped exponential backoff. Outbound posts are serialized per thread so messages appear in order.
When the platform returns a rate-limit response with a retry hint, the adapter waits at least that long. Messages that fail
after the retry budget are written to a dead-letter file with the payload so they can be replayed.

### 17.4 `src/channels/sms/adapter.ts`

Splits output into segments under the carrier limit, numbers them, and holds overflow in the session for a "MORE" reply.

### 17.5 `src/sessions/router.ts`

Mapping rules are compiled at boot into a lookup table. Unknown channel keys create a session with the default agent
profile for that channel.

### 17.6 `src/sessions/transcript.ts`

Append-only writes with an fsync per turn, not per event, which the authors chose as a balance between durability and
throughput.

### 17.7 `src/sessions/summary.ts`

The rolling summary is regenerated by a small model when the unsummarized tail exceeds about 6,000 tokens. The summary
prompt is instructed to preserve open commitments and standing instructions verbatim.

### 17.8 `src/agent/prompt.ts`

Builds the system prompt in fixed sections: identity, always-loaded memory (`USER.md`, `PINNED.md`), skill list, tool usage
notes, channel formatting notes. The always-loaded memory section is size-capped; if `USER.md` grows past the cap, the
runtime warns and asks the user to prune.

### 17.9 `src/agent/turn.ts`

The turn loop. Tool calls are executed sequentially by default; a profile flag allows parallel execution for tools marked
side-effect free.

### 17.10 `src/agent/hooks.ts`

Post-turn hooks run after the transcript is written. The memory-write hook and the standing-instruction classifier live
here. Hooks are allowed to fail without affecting the turn.

### 17.11 `src/memory/workspace.ts`

File operations on the memory directory with path validation. Writes are atomic (write temp file, rename).

### 17.12 `src/memory/watcher.ts`

Watches the memory directory recursively and debounces changes by 500 ms before triggering an incremental sync of the
changed files.

### 17.13 `src/memory/search/chunker.ts`

Described in 7.1. The heading-path prefix is stored separately from the chunk body so excerpts shown to the user do not
repeat it.

### 17.14 `src/memory/search/index.ts`

Schema creation, migrations, and the transactional per-file replace described in 7.2. Every write path goes through one
function that deletes by file id and reinserts, so ids are always derived from the stored file row.

### 17.15 `src/memory/search/embed.ts`

Provider selection, batching (64 texts per request), and the stored model hash check.

### 17.16 `src/memory/search/query.ts`

BM25 and vector queries, blending, adjustments, and the floor, as in 7.4. Stopwords are removed before building the FTS
match expression, and terms are combined with OR only after an initial AND query returns fewer than five results.

### 17.17 `src/tools/web-fetch.ts`

Described in 8.1.

### 17.18 `src/tools/shell.ts`

Routes through the sandbox when enabled. Captures stdout and stderr separately with size caps.

### 17.19 `src/cron/scheduler.ts`

Uses a single timer set to the next due job rather than polling. Jobs are persisted after every change.

### 17.20 `src/sandbox/container.ts`

Container lifecycle and exec. Network proxy configuration is generated per session.

### 17.21 `src/models/client.ts`

Provider abstraction, retry, and failover as in section 12.

### 17.22 `src/auth/profiles.ts`

Resolves profiles at boot and on demand. Cloud credentials are resolved through the provider's standard chain under the
named profile and cached with their expiry; a refresh happens a few minutes before expiry.

---

## 18. End-to-end walkthroughs

### 18.1 A chat message that triggers memory recall

1. The chat adapter receives a socket event for a new message in a thread and calls the gateway's `onMessage` with the
   channel key (channel id plus thread id) and the text.
2. The router looks up the key, finds an existing session, and enqueues the message on that session's queue.
3. When the queue reaches the message, the runtime builds the system prompt: identity, then `USER.md` and `PINNED.md`
   verbatim, then the skill list, then tool notes, then chat formatting notes.
4. The recall step runs memory search with the message text. BM25 and vector search each return up to 50 chunks; RRF fuses
   them; the recency factor nudges recent daily notes; pinned and archived files are excluded; the best chunk per file is
   compared to the cosine floor. Two files clear it. Their top chunks are inserted as a "Relevant memory" block with the
   heading path of each.
5. The model is called with the conversation tail, the rolling summary, and the recall block.
6. The model calls `web_fetch` once; the fetch wrapper applies its 20 second abort timeout and 2 MB cap; the result is
   truncated to the tool limit and returned.
7. The model writes its reply. The chat adapter splits it at paragraph boundaries and posts it in order.
8. The transcript is appended and fsynced. The post-turn hooks run: the memory-write hook decides the turn is notable and
   appends one line to today's daily note; the standing-instruction classifier finds nothing.

### 18.2 A standing instruction

1. The user writes "From now on, when you summarize articles for me, keep it to five bullet points."
2. The turn runs normally and the model acknowledges.
3. The standing-instruction classifier in the post-turn hook recognizes "from now on" plus an imperative and extracts the
   instruction with a topic label, "article summaries".
4. `USER.md` already has an instruction with topic "article summaries" from two weeks ago ("three bullet points"). The
   hook moves the old instruction into "Previous instructions" with its date and writes the new one under "Standing
   instructions".
5. The watcher sees the file change and reindexes it, but that hardly matters: `USER.md` is pinned to the prompt, not
   retrieved.
6. On the next turn, even in a different session, the system prompt contains the new instruction.

### 18.3 A note edit

1. The user opens `notes/travel.md` in an editor and changes "window seat" to "aisle seat, near the front".
2. The watcher debounces for 500 ms and triggers sync for that one file.
3. Sync computes the content hash, sees it changed, and within one transaction deletes every chunk row, FTS row, and vector
   row for the file id, then reinserts the new chunks and their vectors.
4. The integrity check confirms FTS and chunk counts match.
5. A search for "aisle seat" now finds the note; a search for "window seat" does not.

### 18.4 A cron job

1. At 08:00 the scheduler's timer fires for the "morning briefing" job, which targets a fresh session with the CLI agent
   profile and a prompt asking for today's calendar and reminders.
2. The scheduler creates a session and injects the prompt as a system-originated message.
3. The runtime runs a turn. The calendar tool is called; reminders are read from the scheduler.
4. The result is sent via `send_message` into the user's main chat thread.
5. The scheduler records last run, result status, and next run.

### 18.5 Model failover

1. A turn calls the primary model and gets an overload response.
2. The model client retries twice with backoff; both fail.
3. It fails over to the first fallback model, records a system note in the transcript ("primary overloaded; using
   fallback"), and continues the turn.
4. On the next turn it tries the primary again first.

### 18.6 An authentication error

1. A turn calls a model through a CLI-based provider. The subprocess is spawned with the credential environment resolved
   from the agent profile's auth profile.
2. The provider returns a permission error because the cached cloud credentials for that profile expired.
3. The model client classifies it as an auth error: no retry, no failover.
4. The turn fails with a message naming the auth profile and suggesting a refresh. The doctor command surfaces the same.

---

## 19. Data model reference

### 19.1 Session record

| Field | Type | Notes |
|---|---|---|
| id | string | ULID |
| channelKeys | string[] | one or more |
| agentProfile | string | name in config |
| createdAt | ISO time | |
| lastActiveAt | ISO time | updated per turn |
| state | enum | active, dormant, closed |
| summaryPath | string | sidecar file |

### 19.2 Transcript event

| Field | Type | Notes |
|---|---|---|
| ts | ISO time | |
| kind | enum | user, assistant, tool_call, tool_result, system |
| turnId | string | groups events of one turn |
| payload | object | kind-specific |

### 19.3 Memory index tables

| Table | Columns | Notes |
|---|---|---|
| files | id, path, mtime, hash, pinned, archived | one row per file |
| chunks | id, file_id, ordinal, heading_path, text | replaced per file |
| chunks_fts | text | FTS5, porter tokenizer, content table chunks |
| vectors | chunk_id, model_hash, dim, blob | replaced per file |

### 19.4 Cron job

| Field | Type | Notes |
|---|---|---|
| id | string | |
| schedule | string | cron expression or ISO time |
| target | object | session id or "fresh" plus agent profile |
| prompt | string | |
| runMissed | boolean | run once on boot if missed |
| lastRun, nextRun, lastResult | | maintained by scheduler |

---

## 20. Configuration reference (selected)

```json5
{
  gateway: { port: 18790, token: null },
  channels: {
    chat: { enabled: true, botTokenRef: "auth:chat-bot" },
    sms: { enabled: false },
    email: { enabled: false },
    web: { enabled: true },
  },
  agents: {
    default: {
      model: "primary-large",
      fallbacks: ["secondary-large", "small-fast"],
      tools: ["memory_search", "memory_read", "memory_write", "web_fetch", "schedule", "send_message"],
      toolCallBudget: 25,
    },
  },
  memory: {
    dir: "~/.openclaw/memory",
    chunkChars: 800,
    recall: { enabled: true, maxChunks: 3, minMessageChars: 20 },
    floor: { cosine: 0.32 },
    dailyRetentionDays: 30,
    embeddings: { provider: "hosted", authRef: "auth:embeddings" },
  },
  sandbox: { mode: "off" },
  cron: { file: "~/.openclaw/cron.json" },
  tools: { webFetch: { timeoutMs: 20000, maxBytes: 2097152 } },
}
```

---

## 21. Failure modes the authors designed against

The source has a recurring pattern of comments explaining why a guard exists. Collected here:

- **Hung outbound requests.** Every network call goes through an abort-timeout wrapper. Rationale: a single stalled server
  can otherwise hold a turn open for minutes.
- **Orphaned index rows.** All index writes replace by stored file id inside a transaction. Rationale: an earlier version
  derived ids differently on insert and delete and accumulated rows that matched old text.
- **Stale vectors after model changes.** The stored model hash is compared on boot. Rationale: two embeddings from
  different model builds under the same name are not comparable.
- **Personal facts competing in ranking.** The profile and pinned facts are loaded unconditionally and excluded from ranked
  search. Rationale: ranking personal facts against notes made them appear for unrelated queries and disappear for related
  ones.
- **Forgotten corrections.** Standing instructions replace older ones on the same topic and live in an always-loaded file.
- **Empty answers dressed up as answers.** Memory recall inserts nothing below the floor; memory search returns an explicit
  "no relevant memory".
- **Fused scores used as relevance.** The floor uses raw cosine because a fused score has no absolute meaning.
- **Silent auth failures.** Auth errors are non-retryable, never trigger failover, and name the profile in the error.
- **Subprocess credential mix-ups.** Credentials are passed explicitly to subprocesses.
- **Rate-limit storms.** Channel adapters honor retry hints and serialize posts per thread.
- **Unbounded tool output.** Every tool result is truncated with a note.
- **Runaway turns.** A tool-call budget per turn.

---

## 22. Comparison notes

These are the points where OpenClaw's choices are a useful contrast. They are recorded as observations about OpenClaw,
not as statements about our own system.

| Concern | OpenClaw's approach |
|---|---|
| Personal profile | Always-loaded file, never ranked |
| Standing instructions | Classifier writes to profile, replaces by topic |
| Topical memory | Hybrid BM25 + vector, RRF, raw-cosine floor |
| Chunking | Markdown-aware, heading path prefix, no overlap |
| Stemming | Porter tokenizer |
| Index integrity | Per-file transactional replace, count check |
| Embedding drift | Model hash per vector, re-embed on change |
| Negative queries | Explicit empty result |
| Code knowledge | None; the assistant is not a coding tool |
| Multi-user | Not supported; one gateway per user |
| Scheduling | Single scheduler, visible job table |
| Observability | Per-candidate scores and drop reasons |
| Subprocess auth | Explicit credential environment |
| Outbound HTTP | Shared abort-timeout wrapper |

---

## 23. Things OpenClaw does not do

- It has no notion of projects or repositories; memory is per user, not per codebase.
- It has no code index and no code search; the shell tool can run grep in the sandbox but nothing indexes source.
- It has no contradiction detection between notes; `supersedes` is explicit and manual (or set by the consolidation job).
- It has no confidence or decay model beyond the recency factor for daily notes.
- It has no multi-user scoping; sharing a gateway between people is explicitly unsupported.
- It has no graph over notes; related notes are only connected through tags and explicit links, which are not used in
  ranking.
- It does not inject memory into other agents; there is only one agent runtime per gateway, with several profiles.

---

## 24. Code quality observations

- Module boundaries are clean; each subsystem exposes a small interface and keeps its state private.
- Error handling is consistent: errors are classified (retryable, auth, user, internal) at the boundary where they are
  first seen, and the classification travels with them.
- Comments explain why rather than what. Many guards carry a short rationale tied to an observed failure.
- Tests are thorough for memory search and thinner for channel adapters, which depend on external platforms.
- The configuration schema doubles as documentation; every field has a description and a default.
- A few modules are large (`turn.ts`, the chat adapter) and would benefit from splitting, but they are readable.

---

## 25. Glossary (OpenClaw terms)

- **Gateway** — the single long-lived process.
- **Channel adapter** — connector to a messaging surface.
- **Channel key** — per-channel identifier mapped to a session.
- **Session** — a conversation with a transcript and rolling summary.
- **Turn** — one model invocation cycle including tool calls.
- **Agent profile** — named configuration of model, fallbacks, and tools.
- **Memory workspace** — the markdown directory of memory files.
- **Daily note** — the per-day scratchpad file.
- **Pinned** — loaded every turn, excluded from ranked search.
- **Recall step** — automatic memory search before a turn.
- **Standing instruction** — a "from now on" preference stored in the profile.
- **Consolidation** — the nightly job that moves durable facts out of daily notes.
- **Skill** — packaged instructions plus optional tools, loaded on demand.
- **Auth profile** — named credential configuration.
- **Sandbox** — optional container for tool execution.
- **Doctor** — diagnostic command that reads logs.

---

## 26. Reading order for someone new to the OpenClaw codebase

1. `src/gateway/server.ts` for boot order.
2. `src/agent/turn.ts` and `src/agent/prompt.ts` for the turn loop and prompt assembly.
3. `src/memory/workspace.ts` and `src/memory/search/` for memory.
4. `src/tools/` for the tool contract and the fetch wrapper.
5. `src/channels/chat/adapter.ts` for a full-featured adapter.
6. `src/cron/scheduler.ts`, `src/models/client.ts`, `src/auth/profiles.ts` as needed.

---

## 27. Open questions from the read

1. How does the consolidation job decide what is durable? The prompt is short and the heuristics are not documented.
2. The recency factor for daily notes has a hard-coded decay; is it tuned on anything?
3. The OR fallback in the FTS query (only when AND returns few results) is clever; how often does it trigger in practice?
4. The cosine floor default of 0.32 is model-specific; what happens when the embedding provider changes?
5. Parallel tool execution is opt-in per profile; are there races in the memory tools if a profile enables it?
6. The dead-letter file in the chat adapter is replayed manually; is there any automation?
7. How large can `USER.md` get before the size cap becomes a real problem for long-time users?

---

## 28. Session-level details worth recording

### 28.1 Queueing

Each session has an in-memory FIFO queue. A message arriving while a turn is running is held; when the turn ends the next
message starts a new turn with the held message appended. If more than one message accumulates, they are coalesced into a
single user event with a separator, so the model sees everything the user said while it was busy.

### 28.2 Interruption

A user can send a stop command in any channel. The runtime sets a cancellation flag checked between tool calls and aborts
the in-flight model stream. The partial assistant message is recorded with an "interrupted" marker. A subsequent message
starts a fresh turn that sees the partial output.

### 28.3 Resumption after restart

On boot the gateway scans transcripts for turns without an end event and appends a system note ("turn interrupted by
restart"). It does not resume them; the next user message starts normally.

### 28.4 Cross-session messages

`send_message` can post into another session. The receiving session treats it as a user-like message from a named source
and runs a turn. Loops are prevented by a per-turn cap on cross-session messages and a hop counter in the payload.

### 28.5 Presence

The web UI shows which sessions are active, dormant, or mid-turn, using the last-active time and the queue state. There is
no heartbeat from the model side; liveness is entirely gateway-side.

---

## 29. Memory tool schemas

### 29.1 `memory_search`

Input: `query` (string), optional `limit` (default 5, max 20), optional `paths` (glob filter). Output: a list of
`{ path, headingPath, excerpt, score, cosine }`, or `{ empty: true, reason: "no relevant memory" }` when nothing clears
the floor.

### 29.2 `memory_read`

Input: `path`. Output: the full file content with front matter parsed.

### 29.3 `memory_write`

Input: `path`, `content`, optional `frontMatter`, optional `mode` (replace or append). Validates the path is inside the
workspace, writes atomically, triggers immediate sync of that file, and returns the new content hash.

### 29.4 `memory_append_daily`

Input: `text`. Appends a timestamped line to today's daily note.

---

## 29a. Skill loading and channel formatting details

### 29a.1 Skill selection

The skill list in the system prompt contains only names and one-line descriptions, sorted by name. The authors chose not
to rank skills by similarity to the message because a ranked list hid skills the model would have chosen when the
message phrasing was unusual. When the model calls `load_skill`, the skill body is appended to the turn context and stays
loaded for the rest of the turn only; the next turn starts with the plain list again. Skills that bundle tools register
those tools for the duration of the turn in which they were loaded.

### 29a.2 Skill permissions

A skill's front matter can request permissions: network hosts, file directories, and shell access. Installation shows the
requested permissions and requires approval. At runtime, a tool from a skill that tries to exceed its permissions gets a
structured denial result rather than an exception, so the model can explain the problem to the user.

### 29a.3 Channel formatting notes

Each channel adapter contributes a short block to the system prompt describing what formatting renders on that surface:
markdown subset, maximum message length, whether code blocks render, whether rich blocks are available. The SMS block
tells the model to avoid markdown entirely. The email block allows longer replies and headings. The web UI block allows
full markdown. This keeps the model from producing output that the surface would mangle.

### 29a.4 Attachments

Inbound attachments are stored under the session directory and referenced in the user event by path. Images are passed to
models that accept them; other files are summarized by a small model on first reference. Outbound attachments are produced
by tools that write into a per-session outbox directory, which the adapter uploads after the reply.

## 30. Summary

OpenClaw is a single-user assistant with a disciplined memory design: a small always-loaded profile, a markdown workspace
with explicit supersession, a hybrid index that stays consistent under edits, a floor that allows empty answers, and
observability down to per-candidate drop reasons. Its scope is narrower than a multi-project agent console (no
repositories, no code, no teams), and it should be read as a reference for those specific design choices rather than as a
blueprint.
