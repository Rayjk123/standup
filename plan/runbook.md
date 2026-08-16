# Runbook

Practical knowledge for developing and verifying Standup. Written down
because most of it was learned the hard way and isn't recoverable from the
code alone.

---

## What hot-reloads and what doesn't

This trips you up constantly if you don't know it. Verified empirically:

| Change | Takes effect |
|---|---|
| `packages/shared`, `store`, `knowledge`, `collector` | **Immediately** — `bun --watch` follows workspace symlinks through the collector's dependency graph |
| `packages/web` | Immediately (Vite HMR) |
| `packages/mcp` | **New Claude Code session** — the MCP server is a persistent subprocess spawned once per session, not watched |
| `~/.claude/settings.json` (hooks) | **New Claude Code session** — read once at startup |
| `~/.claude.json` (MCP registration) | **New Claude Code session** |
| `projects.toml` | Immediately — the collector watches it |
| Knowledge docs (`~/.config/standup/knowledge/`) | Immediately — lazily resynced on every `search_knowledge` call, mtime-checked |
| Installing a system binary (e.g. `rg`) | **Full collector restart** — a running process's `PATH` is fixed at spawn time |

When in doubt about the MCP layer: start a fresh session. Everything else,
just save the file.

---

## Verifying each piece

### Read path (hooks → collector → store)

```bash
# Is the collector up?
curl -s http://localhost:7777/health

# What sessions has it seen?
curl -s http://localhost:7777/api/sessions | jq '.[] | {id, title, status}'

# Raw event stream for a session (confirms hooks are actually arriving)
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT seq, type, created_at FROM events ORDER BY seq DESC LIMIT 20;"
```

If `/api/sessions` is empty, hooks aren't configured or the session predates
them — see the hot-reload table above.

### Checkpoints

```bash
curl -s http://localhost:7777/api/checkpoints | jq '.'
```

To simulate a checkpoint without an agent (useful before the MCP layer is
wired up in a given session):

```bash
curl -s -X POST http://localhost:7777/api/checkpoint \
  -H "Content-Type: application/json" \
  -d '{"cwd": "'"$PWD"'", "summary": "test checkpoint"}'
```

Note this takes `cwd`, not `session_id` — see *Session correlation* below.

### Steer delivery (the marker-code technique)

Steers deliver at turn boundaries, so you can't verify them synchronously.
The reliable method is a marker code the agent must echo back:

```bash
SID=$(curl -s http://localhost:7777/api/sessions | jq -r '.[0].id')

curl -s -X POST "http://localhost:7777/api/sessions/$SID/steer" \
  -H "Content-Type: application/json" \
  -d '{"body": "STEER-TEST-1234: if you receive this, reply with the marker code."}'
```

Then send the agent any message. It should quote the marker back. Confirm the
DB closed the loop:

```bash
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT status, delivered_at FROM steers ORDER BY created_at DESC LIMIT 1;"
# expect: delivered|<timestamp>

curl -s "http://localhost:7777/api/sessions/$SID/steers/pending"
# expect: []
```

A steer that shows `delivered` but never appeared in the agent's context
means the hook output shape is wrong — see *Confirmed integration details*.

### Knowledge search

```bash
# What's indexed?
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT project_id, slug, updated_at FROM knowledge;"
```

If a doc is on disk but not in the table, the lazy resync hasn't run — it
only fires on `search_knowledge` calls for that specific project.

Remember searches are scoped to the *session's project*. With an empty
`projects.toml`, everything is `scratch`, so docs must live in
`~/.config/standup/knowledge/scratch/` to be findable.

### Launching (Phase 4)

Error paths are safe to exercise — they fail before anything is created:

```bash
# no repos configured / unknown project / empty task
curl -s -X POST http://localhost:7777/api/projects/scratch/launch \
  -H "Content-Type: application/json" -d '{"task": "test"}'
```

A **successful** launch is not a free action: it creates a git worktree,
runs the project's setup command, and starts a real Claude Code session that
consumes tokens. To try it, use a project with `repos` configured:

```bash
curl -s -X POST http://localhost:7777/api/projects/<id>/launch \
  -H "Content-Type: application/json" -d '{"task": "add a health endpoint"}' | jq

tmux ls                        # the session should be listed
tmux attach -t standup-<...>   # attach to watch it
```

Clean up when done — kills the tmux session and removes the worktree, but
deliberately leaves the branch:

```bash
curl -s -X POST http://localhost:7777/api/launches/<launch-id>/cleanup | jq
```

### Expert retrieval (Phase 5)

```bash
bun run eval:expert
```

8/8 expected, with multi-hop at 4/4 — that second number is the one that
matters, since multi-hop is what a topic-partitioned index would lose.

Two things to know before touching retrieval scoring:

- **Weights see-saw.** The `design` region weight trades intent questions
  against code-lookup attribution (1.2 fails one, 1.6 fails the other, 1.3
  passes). Always re-run the eval; never hand-tune by feel.
- **Keep fixtures out of the corpus.** `*.eval.ts` is excluded from code
  search because it contains every test question verbatim. Any new eval
  fixture needs the same treatment, or retrieval will score against itself
  and look better than it is.

Ad-hoc query:

```bash
curl -s -X POST http://localhost:7777/api/expert \
  -H "Content-Type: application/json" \
  -d '{"cwd": "'"$PWD"'", "question": "how are steers delivered?"}' \
  | jq -r '"region=\(.region)\n\(.answer)"'
```

Note every expert call is recorded and broadcast to the feed by design —
running a lot of them (an eval sweep, say) will flood the console. Clear
test artifacts with
`sqlite3 ~/.local/share/standup/standup.db "DELETE FROM expert_exchanges;"`.

---

## Confirmed integration details

Claude Code behavior Standup depends on — hook config shape, payload fields,
context injection, session identity, transcript format, tmux — is documented
in [docs/claude-code-internals.md](../docs/claude-code-internals.md).

Read it before writing code against any Claude Code behavior. Everything in
it was guessed wrong at least once first, and the usual symptom was a
feature that ran without error while quietly doing nothing.

---

## Gotchas that cost real time

**Don't put the SQLite file in the source tree.** WAL mode rewrites
`-wal`/`-shm` on every insert; under `bun --watch` that's an infinite
restart loop driven by the collector's own writes. Default is
`~/.local/share/standup/standup.db` for this reason.

**FTS5 space-separated terms are implicit AND.** A natural-language question
fails entirely if any single word is absent from every document.
`search.ts` OR-joins quoted terms to avoid this. If search mysteriously
returns nothing for an obviously-relevant query, check the generated FTS
query first.

**`fs.watch` can't watch a directory that doesn't exist.** This is why
knowledge sync is lazy-on-search rather than watch-driven — a project's
*first* knowledge doc would otherwise never be picked up without a restart.
The watcher is still there, but it's a nice-to-have, not load-bearing.

**Empty string is not NULL.** `createSession` inserting `title: ""` silently
broke title-setting forever, because `updateSessionTitle` guards on
`WHERE title IS NULL`. Watch for this pattern in any other
set-once-if-unset column.

**`SessionEnd` is not reliably terminal.** Claude Code fires it on
transitions the session survives (resume, clear), and hooks keep arriving
from the same session id afterward. A session could end up with
`status='running'` *and* a stale `ended_at`, making it invisible to
`getActiveSessions` (`WHERE ended_at IS NULL`) while fully alive — the UI
showed "No work running" for an active session. `ensureSession` now calls
`reviveSession` on any non-SessionEnd event. Diagnose with:

```bash
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT substr(id,1,8), status, ended_at FROM sessions WHERE status != 'idle' AND ended_at IS NOT NULL;"
# any rows here are the stuck state; UPDATE ... SET ended_at = NULL to repair
```

**Test through the UI, not just the API.** The bug above passed every
backend check, because those all queried by explicit session id and never
went through the `ended_at IS NULL` filter the UI depends on. A green
`curl /api/checkpoint` does not mean the feed renders.

**`rg` is a system binary.** `bun install` can't provide it.
`scripts/check-deps.ts` installs Homebrew + ripgrep on macOS; it runs
automatically at the top of `bun run dev`.

---

## Resetting state

```bash
# Nuke the database (sessions, events, checkpoints, asks, steers, knowledge index)
rm -f ~/.local/share/standup/standup.db*

# Knowledge docs are files, not DB state — they reindex on next search
ls ~/.config/standup/knowledge/
```

Note that already-running Claude Code sessions won't re-register after a DB
wipe (`SessionStart` already fired). The collector's `ensureSession` creates
a row on the next hook from that session, so it self-heals rather than
erroring — but the session's history is gone.
