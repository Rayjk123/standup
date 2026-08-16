# Agent Session Manager — Design

A local control plane for running many Claude Code sessions at once: one unified
view of every session, a Slack-style chat where agents can reach you, and
project-scoped expert services agents can consult when they get stuck.

---

## Problem

Multi-agent work today is one session per terminal tab. There is no unified
view, no way to know which agent is blocked, and no way to answer a question
without finding and attaching to the right pane. Attention is the bottleneck,
not agent capability.

## Goals

- See every running session in one place, with live status
- Get notified when an agent needs a decision, without watching terminals
- Reply to a blocked agent from one interface (including from a phone)
- Let agents consult project-specific knowledge without a human relaying it

## Non-goals

- Replacing Claude Code's TUI. We observe and message; we do not reimplement.
- Autonomous multi-agent task decomposition. Humans still assign work.
- Being a general-purpose observability platform. Single-user, local-first.

---

## Architecture

```
 projects.toml ---> registry (grouping · launch · expert scoping)
                       |
 Claude Code sessions (N)
   |  HTTP hooks (fire-and-forget POST)
   v
 Collector  --->  SQLite  --->  WebSocket  --->  Chat UI
   ^                                               |
   |  MCP: checkpoint / ask_human / ask_expert     |
   +-----------------------------------------------+
                      |
                      v
              Retrieval backend (graph RAG)
```

Two independent paths:

- **Read path** — hooks push lifecycle events to the collector. One-directional,
  cheap, works on any session that has the hooks configured.
- **Write path** — an MCP server the agent calls when it wants something. The
  tool call blocks until the collector resolves it.

The critical design decision: **the manager observes rather than owns.** It does
not spawn sessions. Any session started anywhere — a terminal, an IDE, a script
— joins the view automatically as long as global hooks are configured. The cost
is that we cannot write to a session's stdin, which is why the write path goes
through MCP instead.

---

## Component 1 — Event collector

Claude Code supports **HTTP hooks**: rather than a shell command, a hook can
POST its JSON payload to a URL. Configure once in `~/.claude/settings.json` and
every session on the machine reports in.

Events to subscribe to:

| Event | Purpose |
|---|---|
| `SessionStart` | Register session; capture cwd, source (startup/resume/clear) |
| `SessionEnd` | Mark session closed; capture termination reason |
| `UserPromptSubmit` | Session title (first prompt), turn boundaries |
| `PreToolUse` | Activity stream; drives "typing" indicator |
| `PostToolUse` | Tool results; the ground truth for what actually happened |
| `SubagentStart` / `SubagentStop` | Parent/child hierarchy for threading |
| `Stop` | Turn complete — agent is now idle and waiting |
| `Notification` | Agent needs the human. Matchers: `permission_prompt`, `idle_prompt`, `auth_success` |
| `Elicitation` / `ElicitationResult` | Brackets an MCP server asking the user for input |

Every payload carries `session_id`, `cwd`, `transcript_path`, and
`hook_event_name`; tool events add `tool_name` / `tool_input` / `tool_response`.
Reference: <https://code.claude.com/docs/en/hooks>

Several integration details here were originally guessed wrong and cost real
debugging time. The ones now confirmed empirically — hook config shape, the
`additionalContext` response format, session correlation from MCP — are
written down in `runbook.md` under *Confirmed integration details*. Check
there before re-deriving them.

**Implementation notes**

- Hooks run synchronously in the agent's loop. The collector must return
  immediately — accept, enqueue, respond. Never block on a write.
- Hooks run with full user permissions and no sandbox. Bind the collector to
  localhost only.
- Merge `PreToolUse` and `PostToolUse` into a single row client-side, keyed on
  tool call id, so the UI shows one entry that fills in rather than two.

## Component 2 — Project registry

Projects are first-class, not a derived grouping. A single `projects.toml`
checked in wherever you keep dotfiles:

```toml
[[project]]
id      = "fusion-api"
name    = "fusion-api"
emoji   = "🛰️"          # or icon = "icons/fusion.png"
repos   = ["~/src/fusion-api", "~/src/fusion-graph"]
setup   = "uv sync && docker compose up -d"
expert  = "fusion-api"   # retrieval index name, omit if none
branch  = "main"
```

This one file serves three separate features, which is why it is a component
rather than a config detail:

- **Grouping.** Sessions group by project, never by IDE window or cwd. A
  microservice fleet means several repos behind one project; the fact that two
  IDE windows are open is an artifact of how work got started, not a fact about
  the work.
- **Launching.** The console can start a session for a project because it knows
  the repo path, the setup command, and the base branch. Without this, launch is
  impossible and you are back to spawning terminals by hand.
- **Expert scoping.** `expert` names the retrieval index that `ask_expert`
  anchors against for sessions in this project. Same registry, no second source
  of truth.

Sessions map to projects by matching `cwd` against `repos` at `SessionStart`.
Unmatched sessions land in a catch-all `scratch` project rather than being
dropped — the throwaway tunnel session still needs to be visible.

## Component 3 — Store

SQLite is sufficient. Single writer, local, survives restarts.

```
projects(id, name, emoji, icon_path, expert, branch)
sessions(id, project_id, title, cwd, parent_session_id, status,
         started_at, ended_at)
events(id, session_id, seq, type, payload_json, created_at)
checkpoints(id, session_id, source, summary, created_at)
asks(id, session_id, kind, question, answer, status,
     created_at, resolved_at)
steers(id, session_id, body, status, created_at, delivered_at)
```

`asks` is the blocking-question table and the heart of the write path. `status`
moves `pending -> answered | timeout | cancelled`.

`steers` holds unsolicited replies waiting for a turn boundary — see Component 5.

Session titles describe the **work**, not the session: "Exponential backoff for
the async client", not `session_a4f2`. Derive from the first `UserPromptSubmit`,
or take it from the launcher when the session was started from the console.
Titles never change on later prompts.

## Component 4 — Checkpoints

The unit that makes everything else work. A checkpoint is a milestone-level
summary in the agent's own words — "adding tests now", "milestone 3 scoped" —
emitted at natural task boundaries, not per tool call.

**Two sources, wire both:**

- **Structural.** Fire on `SubagentStop` for a named subtask, or when a
  plan/todo tool marks an item complete. Always fires, needs no cooperation from
  the agent, but the text is inferred.
- **Self-reported.** A `checkpoint(summary: string)` MCP tool the agent calls
  when it judges it has finished a discrete unit of work. Requires one line in
  project instructions. Gives you the agent's actual framing of its own
  progress, which is what makes the feed readable.

Structural is the floor; self-reported is the layer worth reading.

**Why they matter beyond nice narration:**

1. **They make the merged feed viable.** At roughly one checkpoint per fifteen
   minutes per session, fifteen sessions produce about one message a minute —
   readable. Merge in raw tool calls and the feed is unusable in seconds.
2. **They are the better stall signal.** "No checkpoint in N minutes while still
   running" beats counting tool calls, because an agent looping on a failing
   test is *busy* and quiet at the same time.
3. **They are the delivery point for steering.** See Component 5.

## Component 4.5 — Project Knowledge

Human-authored knowledge that agents can query — institutional context that
can't be derived from code analysis.

**Storage structure:**

```
~/.config/standup/knowledge/{project-id}/
├── overview.md        # business intent, what this project is
├── connections.md     # how it relates to other projects
├── practices.md       # coding conventions, patterns to follow
└── *.md               # any other knowledge docs
```

Each markdown file is a knowledge document. The filename (minus `.md`) becomes
the slug. Front matter is optional but can include `title` and `tags`.

**Database schema:**

```sql
knowledge(id, project_id, slug, title, body, embedding, updated_at)
knowledge_chunks(id, knowledge_id, chunk_index, text, embedding)
```

Full documents go in `knowledge`; chunked versions with embeddings go in
`knowledge_chunks` for semantic search.

**Three search modes, all available to agents:**

| Tool | What it does | When to use |
|------|--------------|-------------|
| `search_knowledge` | Text + embedding hybrid over knowledge docs | "What's the business goal of this project?" |
| `ripgrep` | Fast regex/literal search over code | "Find all uses of AuthMiddleware" |
| `ask_expert` (Phase 5) | Graph traversal over code structure | "Why did auth break after schema change?" |

**`search_knowledge` MCP tool:**

```
search_knowledge(query: string, project?: string) -> {
  results: [{ slug, title, excerpt, score, source: "text" | "embedding" }],
  project: string
}
```

If `project` is omitted, uses the session's project. Returns top-k results from
both text search (BM25 or simple substring) and embedding similarity, merged
and deduplicated.

**`ripgrep` MCP tool:**

```
ripgrep(pattern: string, path?: string, flags?: string[]) -> {
  matches: [{ file, line, text }],
  truncated: boolean
}
```

Runs `rg` in the session's cwd. Useful for code search, symbol lookup, and
anything where exact pattern matching beats semantic similarity. Limit output
to avoid flooding context.

**Indexing:**

Knowledge docs are indexed on startup and when files change (fswatch). Embeddings
are computed lazily — on first query or via a background job. Use a local
embedding model (e.g., `nomic-embed-text` via Ollama) or a remote API.

**UI:**

- **Knowledge tab** in the Projects view shows docs per project
- **Inline editor** for quick edits without leaving the console
- **Search box** to test queries before agents use them

**Why separate from Phase 5 experts:**

Phase 5 experts are about code structure — imports, calls, type relationships.
Project knowledge is about *intent* — why this exists, how it fits, what to
avoid. Both are useful; they answer different questions.

## Component 5 — Chat UI

Slack's register, not just its layout: project avatars, bold sender names,
grouped consecutive messages, hover-revealed timestamps.

**Three message tiers, and the separation is load-bearing:**

| Tier | Contents | Behaviour |
|---|---|---|
| Activity | tool calls, subagent spawns | ambient; per-session only, never in the merged feed, never badges |
| Checkpoints | milestone summaries | the readable spine; merged feed carries these |
| Asks | `ask_human`, permission prompts | badge, push, sound |

**Views:**

- **Feed** — merged across all projects. Checkpoints, asks, and expert exchanges
  only. This is the landing view; it is what removes the tab-juggling.
- **Blocked** — filtered to pending asks, answerable inline. Its own view, not a
  panel that expands over the feed.
- **Projects** — registry-grouped session list, with per-session detail.

**A persistent alert strip** sits under the top bar in every view: how many
agents are waiting, which projects (by emoji), how long the oldest has waited,
and a handoff to the Blocked view. It never expands in place — it carries enough
to decide whether to break flow, then gets out of the way.

**Reply semantics differ by target, and this is the subtle part:**

- Replying to an **ask** resolves a blocked tool call. Lands immediately, clean
  semantics, agent resumes.
- Replying to a **checkpoint** is unsolicited injection — the same push-mode
  failure described in Component 7. So steers **queue and deliver at the next
  turn boundary**, and the UI says so ("delivers at the next checkpoint"). You
  still get to redirect an agent going off the rails; you just don't derail it
  mid-thought to do it.

**The silence meter.** Each session carries a strip of the last 40 minutes, one
tick per minute, lit if the agent did anything. A long dark run is visible
across every session at once. This is the direct answer to discovering an hour
late that a session did nothing.

Transport is WebSocket with client-side append; reconnect on a timer and refetch
missed events by `seq` rather than replaying everything.

Push to phone via ntfy or a Telegram bot. Only asks push. Once events are
centralized this is a few lines, and it is the feature that actually changes the
working day.

**On making agents feel like collaborators:** the working lever is naming by
intent. `🛰️ fusion-api · Exponential backoff for the async client` reads as a
colleague's status update; `session_a4f2` reads as a process. Resist adding
personalities, chattier agent copy, or invented names — it reads as costume
within a day and makes the feed harder to scan. The collaborative quality comes
from agents reporting intent, asking good questions, and consulting each other
where you can see it happen.

## Component 6 — Write path (`ask_human`)

An MCP server exposing two tools:

```
ask_human(question: string, options?: string[], timeout_s?: int) -> string
checkpoint(summary: string) -> void
```

Flow for `ask_human`:

1. Agent hits something it needs a human for and calls `ask_human`.
2. The tool handler inserts a row into `asks` with status `pending` and
   long-polls the collector.
3. The UI badges the Blocked view, shows it in the alert strip, and pushes.
4. Human replies. Collector resolves the row. The tool call returns the answer
   as its result and the agent continues.

Blocking semantics come free — the agent is genuinely paused inside a tool call,
not polling or guessing. Set a generous timeout and return a sentinel like
`"no response — proceed with your best judgment"` on expiry so a forgotten
question does not hang a session overnight.

**Steer delivery.** Queued steers are handed to the agent at its next turn
boundary — practically, appended as `additionalContext` on the next
`UserPromptSubmit` or returned alongside the next `checkpoint` call. Never
injected mid-turn.

**Escape hatch:** for sessions running in tmux, `tmux send-keys` can inject text
into a pane the manager did not launch. Useful for nudging a session that has no
pending `ask_human`. Do not build on it as the primary mechanism.

## Component 7 — Expert services

The goal is that a stuck agent can get project-specific knowledge without a
human relaying it.

**Build these as tools, not as agents.** A long-lived expert *agent* per project
means session state, cost, and drift for no benefit. What you actually want is a
thin MCP server over a retrieval index, scoped per repo:

```
ask_expert(question: string) -> { answer: string, region: string, sources: [...] }
```

Backed by whatever retrieval you already have — graph RAG, hybrid vector +
keyword, or just ripgrep over docs to start. The "expert agent" is a rendering
choice in the chat UI, not an architectural one.

### How specialists are constructed

**Do not partition the graph by domain.** The value of a graph index is the
edges, and domain boundaries are exactly where the interesting edges live. "Why
did auth start failing after the schema change?" is an auth question *and* a
data-model question; splitting those into separate subgraphs deletes the edge
that answers it. Topic partitioning destroys the multi-hop capability that
justified using a graph instead of a vector store.

This is measurable rather than a matter of taste: run the multi-hop and
entity-resolution cases in the eval suite against a partitioned variant. Those
are the cases that regress.

**A specialist is a traversal policy over one shared graph.** Three parameters:

- **Anchor set** — node labels, path prefixes, or doc namespaces it starts from.
  Directory paths are a fine v1; a curated ontology is not required.
- **Hop budget** — how far it will wander from the anchors.
- **Edge-type weights** — a code specialist favors call/import edges, a docs
  specialist favors reference/mention edges.

Query flow: resolve the question to seed nodes, traverse the *whole* graph, then
rerank with a bias toward the anchor neighborhood. Cross-domain answers still
surface; they rank below home-turf ones.

**Attribute, don't route.** Note that `ask_expert` takes no `domain` parameter.
If the calling agent has to pick a specialist, it is routing against a taxonomy
it does not know, and misroutes become the dominant failure mode. Instead:
retrieval finds the neighborhood, and the response is *labeled* with the region
it came from. Specialist identity is post-hoc attribution, not a priori routing.
In the chat UI this renders identically — `@auth-expert` replying in thread —
but it cannot misroute, because there was no route.

**When real segmentation is justified.** Segment on provenance and permission,
never on topic:

- Restricted repos or docs that should not be retrievable — hard partition,
  non-negotiable
- Disjoint corpora with different trust levels (public docs vs. internal
  service wiki) — separate so they can be weighted and cited differently
- Index size hurting latency — real, but almost certainly premature

Everything else stays in one graph.

### Stuckness detection

Do not run a watcher model over every tool call — expensive and noisy. Gate on
cheap heuristics computed from the event stream:

- Same grep/glob pattern repeated with empty results
- N consecutive non-zero Bash exit codes
- Long `PreToolUse` chain with no `Edit`/`Write` (reading, not progressing)
- Same file read 4+ times within a turn
- `Stop` fired with the task visibly incomplete

Only after a heuristic fires do you spend a model call.

### Push the nudge, pull the content

The tempting design is: detect stuckness, inject the answer. It fails three
ways — latency (the answer must land inside a hook's window or it arrives too
late), context pollution (a false positive derails an agent that was fine), and
feedback loops (the chime-in generates events that trigger another chime-in).

The design that holds up:

1. Heuristic fires.
2. A `PostToolUse` hook returns one line of `additionalContext`:
   *"A repo expert for the auth layer is available — call `ask_expert` if
   you're blocked."*
3. The agent decides whether to call it.

Cheap, low pollution, and the expert never has to infer intent from tool calls
alone. Apply a per-session, per-topic cooldown so the nudge does not fire
repeatedly.

Route every expert exchange through the channel as a visible message. You need
to see when the expert is wrong before it costs a bad edit, and the false
positive rate on the heuristics is only tunable by watching it.

---

## Failure modes to design against

| Risk | Mitigation |
|---|---|
| Collector blocks the agent loop | Accept-and-enqueue; hard timeout on the handler |
| Chime-in feedback loop | Cooldown per session per topic; cap nudges per turn |
| Context pollution from false positives | Nudge only, never inject content; feature-flag auto-push |
| Forgotten `ask_human` hangs a session | Timeout with a "proceed anyway" sentinel |
| Hook config drift across machines | Ship hooks as a Claude Code plugin, not hand-edited settings |
| Event volume from long sessions | Cap retained scrollback per session; roll old events into summaries |
| Agent stops calling `checkpoint` | Structural checkpoints from `SubagentStop` as the floor |
| Merged feed becomes unreadable | Activity tier never enters the feed — enforce at the query, not the view |
| Steer injected mid-turn derails a run | Queue in `steers`, deliver only at turn boundaries |
| Session with no matching project | Falls back to a `scratch` project rather than being dropped |

---

## Build phases

**Phase 1 — Registry and visibility (weekend)**
`projects.toml` → HTTP hooks → collector → SQLite → WebSocket → project-grouped
session list with live status and the silence meter. Read-only. This alone
eliminates the terminal-tabbing problem.

**Phase 2 — Checkpoints and the feed**
`checkpoint` MCP tool plus structural checkpoints from `SubagentStop`. Merged
feed across projects in the Slack register, three-tier message separation,
persistent alert strip, push to phone. Checkpoints come before the write path
because the feed is not readable without them.

**Phase 2.5 — Project knowledge**
Human-authored knowledge base per project: business intent, cross-project
connections, coding practices, institutional context that can't be derived from
code. Stored as markdown files, indexed for both text and embedding search.
Agents query via `search_knowledge`. Also adds `ripgrep` as a general-purpose
code search tool. See Component 4.5.

**Phase 3 — Write path**
`ask_human` MCP server, the Blocked view, blocking resolution, and queued
steers delivered at turn boundaries. This is where the tool stops being a
dashboard and starts being a control plane.

**Phase 4 — Launching**
Start sessions from the composer using the registry's repo path and setup
command. Worktree checkout per session. Closes the loop: you no longer leave the
console to begin work.

**Phase 5 — Experts**
`ask_expert` MCP server over the retrieval backend, single shared index, no
domain routing. Manual invocation only — the agent must be told about it in its
project instructions. Anchor sets and edge weights can start as a flat config
file; tune them against the eval suite rather than by feel.

**Phase 6 — Proactive nudging**
Stuckness heuristics + `additionalContext` nudge. Behind a feature flag. Run it
in demo mode first and measure the false positive rate before making it default.

---

## Reference mockup

`console-mockup-v4.jsx` is a working React mockup of the Slack-register UI:
merged feed, Blocked view, project registry rail with per-project icons, the
composer-as-launcher, checkpoint/ask/expert message tiers, and the silence
meter. Treat it as the visual and interaction spec for Phases 2–4. The data is
hardcoded; the component structure and interaction semantics are the part to
keep, in particular the two distinct reply paths.

### What the real UI actually implements

`packages/web` is a **partial** port of the mockup, wired to live data. Don't
assume a mockup feature exists in the app — this is the gap as of
2026-08-16:

| Mockup feature | Real app |
|---|---|
| Feed / Blocked / Projects views | ✅ |
| Live data + WebSocket updates | ✅ (mockup was hardcoded) |
| Alert strip | ✅ |
| Silence meter | ✅ real per-minute activity |
| Ask resolution (option buttons) | ✅ wired to the blocking `ask_human`, in both Blocked view and the feed |
| Steer reply ("↩ steer") | ✅ via the shared `Replier` component, with queued-vs-delivered copy |
| Composer-as-launcher | ❌ missing (Phase 4 depends on this) |
| Expert / stall message tiers | ❌ only checkpoint + ask render |
| Grouped consecutive messages | ❌ every message is a full entry |
| Hover-revealed timestamps | ❌ always visible |
| Thread replies ("N replies") | ❌ |
| Per-project emoji picker | ❌ emoji come from `projects.toml`, not editable in-app |

The composer gap is the notable one: Phase 4 assumes a composer-as-launcher
that doesn't exist yet, so that phase starts by building it rather than
extending it.

### Monitored vs. launched sessions

These are not the same thing, and conflating them produced a real gap: the
console could start an agent you then had no way to see or stop.

The asymmetries run *opposite* to each other:

| | Your access to it | Standup's capability over it |
|---|---|---|
| **Monitored** (you started it) | Full — it's your terminal | Least — cannot write to its stdin |
| **Launched** (console started it) | None — detached tmux | Most — Standup created the pane |

So the side where you have the least visibility is exactly the side where
Standup can offer the most, and it should:

- **Monitored** — observe only. Answer a blocking `ask_human`, or queue a
  steer for the next turn boundary. This is the original design constraint
  and it stands: Standup does not own the process.
- **Launched** — Standup owns the tmux session, so it additionally exposes
  reading the screen (`tmux capture-pane`), typing into it
  (`tmux send-keys`, landing immediately rather than at a turn boundary),
  and stopping it.

The design elsewhere calls `tmux send-keys` an escape hatch not to build on,
for "a pane the manager did not launch". That caution is about reaching into
someone else's terminal. For a pane Standup created, it is ownership rather
than intrusion — and the capability functions refuse to act on any launch
without a `tmuxSession` recorded, so the distinction is enforced rather than
assumed.

Stopping a launch kills the agent but keeps the worktree and branch;
cleaning up removes the worktree and still keeps the branch. Neither ever
deletes work.

---

## Open questions

- **Cross-session awareness.** When agent A's expert lookup surfaces something
  agent B is also touching, is posting to both channels genuinely useful or just
  noise? Worth prototyping, not worth committing to.
- **Multi-provider.** Codex, Gemini CLI, and OpenCode all write transcripts but
  do not share Claude Code's hook system. Supporting them means a transcript
  tailer as a second ingestion path. Defer until the Claude-only version earns
  its keep.
- **Permission prompts.** `Notification: permission_prompt` tells you a prompt
  is up but not what it is asking. Answering from the UI likely requires the
  tmux escape hatch. Investigate before promising it.

---

## Prior art worth reading before building

- `simple10/agents-observe` — hook-based real-time dashboard, closest to
  Phase 1. MIT.
- `buhuipao/agent-console` — local control plane, session discovery and resume.
- `sky-xo/june` — minimal subagent viewer TUI.
- `winfunc/opcode` — Tauri desktop GUI over `~/.claude/projects/`.
- `andyrewlee/awesome-agent-orchestrators` — catalog of the wider space.

If Phase 1 is all you want, `agents-observe` may get you there without writing
anything. The case for building is Phases 2–5: checkpoints, the write path, and
project-scoped experts are where existing tools stop.