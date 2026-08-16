# Standup

A console for running many Claude Code agents at once. See every session in one place, get pinged only when an agent actually needs you, and let project-scoped experts answer questions agents get stuck on.

Agents as collaborators, not sessions in a hundred terminal tabs.

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
   |       search_knowledge / ripgrep              |
   +-----------------------------------------------+
```

Two independent paths:
- **Read path** — hooks push lifecycle events to the collector
- **Write path** — MCP server for agent-initiated communication

## Prerequisites

`bun run dev` checks for [Homebrew](https://brew.sh) and [ripgrep](https://github.com/BurntSushi/ripgrep)
on startup (macOS only) and installs whichever is missing — ripgrep backs the
`ripgrep` MCP tool and is a system binary `bun install` can't provide. This is
a visible, logged step (`[deps] ...`), not a silent background action; if
Homebrew needs installing you may be prompted for your password in the same
terminal. Run it standalone any time with `bun run scripts/check-deps.ts`.
On non-macOS, install ripgrep yourself for your platform.

## Quick Start

```bash
# Install dependencies
bun install

# Start all services (collector + web UI) — also checks/installs
# Homebrew + ripgrep on macOS, see Prerequisites above
bun run dev

# In another terminal, wire up Claude Code globally — hooks (read path)
# and the MCP server (write path) for every session on this machine
bun run scripts/setup-hooks.ts

# Start a new Claude Code session (hooks/MCP are read at session start,
# so sessions already running won't pick this up)
```

Services:
- Collector: http://localhost:7777
- WebSocket: ws://localhost:7778
- Web UI: http://localhost:5173

## Project Structure

```
standup/
├── packages/
│   ├── shared/      # Types and constants
│   ├── store/       # SQLite database layer
│   ├── knowledge/   # Project knowledge: markdown docs, text + embedding search
│   ├── collector/   # HTTP hook receiver + WebSocket server
│   ├── mcp/         # MCP server (checkpoint, ask_human, ask_expert,
│   │                #             search_knowledge, ripgrep)
│   └── web/         # React frontend
├── config/
│   ├── projects.example.toml   # Project registry template
│   ├── experts.example.toml    # Expert regions (anchors + rerank weights)
│   ├── hooks.example.json      # Claude Code hooks config
│   └── knowledge.example/      # Example project knowledge docs
├── scripts/
│   ├── dev.ts           # Run all services
│   └── setup-hooks.ts   # Wire up Claude Code globally: hooks + MCP server
└── plan/
    ├── high-level-design.md    # Full design document
    └── implementation.md       # Phase-by-phase plan with model assignments
```

## Configuration

### Project Registry

Copy `config/projects.example.toml` to `~/.config/standup/projects.toml`
(or point `STANDUP_PROJECTS_PATH` at a different location):

```toml
[[project]]
id      = "my-api"
name    = "my-api"
emoji   = "🛰️"
repos   = ["~/src/my-api"]
setup   = "bun install"
expert  = "my-api"
branch  = "main"
```

The collector loads this file on startup and watches it for changes — edits
take effect without a restart. Sessions are matched to a project by comparing
their `cwd` against each project's `repos`. Anything that doesn't match lands
in a catch-all `scratch` project, which is created automatically even if you
never define one.

### Wiring Up Claude Code

One script configures both halves, globally — every Claude Code session on
this machine, not just ones started in this repo:

```bash
bun run scripts/setup-hooks.ts
```

This writes to two files:

- **`~/.claude/settings.json`** — HTTP hooks for the read path (see
  `config/hooks.example.json` for the full event list). The hook definition
  must be nested under a `hooks` array on each matcher entry, not placed
  directly on it.
- **`~/.claude.json`** — registers the `standup` MCP server under
  `mcpServers`, giving every session the `checkpoint`, `ask_human`,
  `ask_expert`, `search_knowledge`, and `ripgrep` tools.

Idempotent — re-running it is safe, and it repairs hook entries an earlier
run may have written in the wrong shape. `COLLECTOR_URL` (default
`http://localhost:7777`) controls both the hook URL and the MCP server's
target, so overriding it once keeps both in sync:

```bash
COLLECTOR_URL=http://localhost:9000 bun run scripts/setup-hooks.ts
```

Hooks and MCP servers are both read once at session start, so a session
already running won't pick up changes — start a fresh one after running this.

To scope either one to a single project instead of globally, add the
equivalent config to a project-level `.mcp.json` / hooks entry in that repo
instead of the global files above:

```json
{
  "mcpServers": {
    "standup": {
      "command": "bun",
      "args": ["run", "/path/to/standup/packages/mcp/src/index.ts"],
      "env": { "COLLECTOR_URL": "http://localhost:7777" }
    }
  }
}
```

### Project Knowledge

Human-authored context per project — business intent, cross-project connections,
coding practices — that agents can query with `search_knowledge`. See
`config/knowledge.example/` for the expected layout:

```
~/.config/standup/knowledge/{project-id}/
├── overview.md        # what this project is, why it exists
├── connections.md      # how it relates to other projects
└── practices.md         # coding conventions to follow
```

Files are indexed on collector startup and reloaded automatically when changed.
Text search (SQLite FTS5) always works. Embedding search is optional — set
`EMBEDDING_PROVIDER` to enable it:

```bash
# Local, no API key needed (requires Ollama running with nomic-embed-text pulled)
EMBEDDING_PROVIDER=ollama bun run dev

# Or a remote provider
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=... bun run dev
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=... bun run dev
```

Without `EMBEDDING_PROVIDER` set, `search_knowledge` falls back to text-only search.

Agents also get a `ripgrep` MCP tool for exact pattern matching over code — useful
alongside `search_knowledge` when the question is about code structure rather than
intent.

### Launching Sessions

Type a task in the composer at the bottom of the Feed, pick a project, and
Standup will create a git worktree off the project's base branch, run its
`setup` command, and start a detached tmux session running Claude Code there.

Attach to a launched session with `tmux attach -t standup-<project>-<slug>`.

Worktrees live in `~/.local/share/standup/worktrees/` (override with
`STANDUP_WORKTREE_ROOT`). Cleaning up a launch removes the worktree and kills
the tmux session but **leaves the branch** — uncommitted work shouldn't
vanish because of a misclick.

Requires `tmux` (installed automatically by `check-deps.ts` on macOS) and a
project with at least one entry in `repos`.

### Expert Retrieval

`ask_expert` searches one shared corpus — your project knowledge docs plus
the code itself — and labels the answer with the *region* it came from.

Regions are configured in `~/.config/standup/experts.toml` (see
`config/experts.example.toml`). A region is **not** a separate index; it's an
anchor set plus a rerank bias over the shared corpus. `ask_expert`
deliberately takes no domain parameter, so a calling agent can't misroute —
the region is post-hoc attribution, not a route.

Tune region weights against the eval suite rather than by feel:

```bash
bun run eval:expert
```

The multi-hop pass rate is the number that matters — those are the
cross-domain questions a topic-partitioned index would lose.

### Proactive Nudging (opt-in)

When an agent looks stuck, Standup can add one line to its context telling it
an expert exists. It never injects the *answer* — a false positive then costs
a single ignorable sentence instead of derailing an agent that was fine.

Off by default. Check what it would do on your real sessions first:

```bash
bun run nudge:report
```

Every firing in that report is a sentence that would have been injected into
a working agent. If any look like normal work rather than being stuck, raise
the relevant threshold in `STUCKNESS` (`packages/shared/src/constants.ts`)
before enabling. Then:

```bash
STANDUP_NUDGE=1 bun run dev
```

Heuristics are cheap and computed from the stored event stream — no model
call is involved in detection. They cover: the same search repeatedly
returning nothing, consecutive failing shell commands, a long chain of tool
calls with no edit, and the same file read over and over.

Protections against the failure modes in the design's risk table:
- **Cooldown** per session *per topic* (default 15 min), so a nudge about
  failing tests doesn't mute one about search
- **Cap** of 2 nudges per turn as a runaway backstop
- Standup's own MCP tools are excluded from detection, so an `ask_expert`
  round trip can't trigger the nudge that caused it

### Checkpoints

Two sources feed the checkpoint feed, per the design's "structural is the floor,
self-reported is the layer worth reading":

- **Self-reported** — the agent calls the `checkpoint` MCP tool directly.
- **Structural** — the collector infers checkpoints without agent cooperation:
  `SubagentStop` (when a description is present) and `TodoWrite` calls where an
  item's status flips to `completed`.

### Push Notifications

Only asks push — checkpoints stay in the feed. Set `NTFY_TOPIC` to enable:

```bash
NTFY_TOPIC=your-private-topic bun run dev
```

Uses [ntfy.sh](https://ntfy.sh) by default; override the server with `NTFY_URL`
if you're self-hosting. Unset `NTFY_TOPIC` and push is a no-op.

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `COLLECTOR_PORT` | `7777` | HTTP hook + REST API port |
| `WS_PORT` | `7778` | WebSocket port |
| `COLLECTOR_URL` | `http://localhost:7777` | Base URL the MCP server and `setup-hooks.ts` target — override once to keep hooks and MCP in sync |
| `DB_PATH` | `~/.local/share/standup/standup.db` | SQLite file location |
| `STANDUP_PROJECTS_PATH` | `~/.config/standup/projects.toml` | Project registry file |
| `STANDUP_EXPERTS_PATH` | `~/.config/standup/experts.toml` | Expert region config |
| `STANDUP_WORKTREE_ROOT` | `~/.local/share/standup/worktrees` | Where launched sessions get their worktrees |
| `KNOWLEDGE_DIR` | `~/.config/standup/knowledge` | Project knowledge docs root |
| `EMBEDDING_PROVIDER` | unset (text-only) | `ollama` \| `voyage` \| `openai` |
| `NTFY_TOPIC` | unset (push disabled) | ntfy.sh topic for ask push notifications |
| `NTFY_URL` | `https://ntfy.sh` | ntfy server, for self-hosting |
| `STANDUP_NUDGE` | unset (off) | Set to `1` to enable proactive nudging |

## Documentation

- [High-Level Design](plan/high-level-design.md) — Full architecture and rationale
- [Implementation Plan](plan/implementation.md) — Phase-by-phase status and model assignments
- [Runbook](plan/runbook.md) — How to verify each piece, what hot-reloads, and gotchas that cost real time

## License

MIT
