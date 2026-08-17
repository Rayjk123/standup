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

### Spawning `claude` from inside Standup

Hooks are global, so every `claude` Standup spawns reports back as a session
unless stopped. Two internal subprocesses exist — auto-checkpoint's summarizer
and draft verification — and they suppress it differently, for a reason worth
knowing before adding a third.

- **Reserved cwd** (`isInternalCwd`, prefix-matched under
  `~/.local/share/standup/internal`) — the collector ignores hooks whose cwd
  is under it. Sufficient for a subprocess that needs no repository access.
- **`--setting-sources project --strict-mcp-config`** — hooks live in
  `~/.claude/settings.json`, the `user` source, so excluding it means they
  never fire at all. Also drops the MCP registration, which an internal
  subprocess should not have.

**The cwd guard alone is not enough once `--add-dir` is involved.** A
subprocess given `--add-dir <repo>` reports *the added directory* as its cwd,
so it registers as an ordinary session in that repo and walks straight past a
cwd-based guard. Measured: two verifier runs created two phantom sessions in
the Standup repo. That matters beyond feed noise — `cwd` is the correlation
key and is not unique, so a phantom session can absorb correlation intended
for your real session in that directory.

Flags are per-invocation. Nothing about this makes ordinary or launched
sessions invisible; `launcher.ts` passes none of them.

### Testing an MCP tool without a fresh session

The table above is about a *live agent* seeing a tool. The server itself is
just a process speaking JSON-RPC over stdio, so you can exercise it directly
and skip the session dance entirely — which covers tool registration, schema,
dispatch, and how a collector error surfaces back to the agent:

```bash
{ echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 2
} | COLLECTOR_URL=http://localhost:7777 bun run packages/mcp/src/index.ts
```

Add a `tools/call` line to invoke one for real. Run it with `cwd` set to the
directory you want the call attributed to — correlation is derived from the
process's cwd, so this is also how you test a tool that gates on which launch
the caller is inside.

What this does **not** cover is an agent *choosing* to call the tool, which is
a prompt question rather than a plumbing one. `~/.claude.json` registers the
server globally as `bun run <source path>`, so a fresh session anywhere picks
up a new tool with no build step.

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

12/12 expected, with multi-hop at 4/4 — that second number is the one that
matters, since multi-hop is what a topic-partitioned index would lose.

**Re-run it before trusting the number written down.** The recorded 8/8 was
stale by the time Phase 7 started: the corpus had grown and the real score was
7/8. An eval result is a measurement with a date on it, not a property.

**The score depends on the embedding index, not just the corpus.** The
`single-hop: intent from knowledge` case cannot pass on text search alone, and
this is arithmetic rather than tuning: FTS5 does no stemming, so a question
asking why Standup "observes" sessions instead of "owning" them matches only
the common words in `overview.md` — raw bm25 lands around 6.6e-6. `mergeResults`
then normalises by `Math.max(...scores, 1)`, whose `1` was meant to guard the
empty case but also clamps any corpus whose bm25 magnitudes are below 1, so the
score stays ~2.6e-6 against a `KNOWLEDGE_RELEVANCE_FLOOR` of 0.15. Only the
embedding half can carry that case.

**Correction: "cannot pass on text search alone" is wrong.** It is not
arithmetic, it is corpus size, and the dependency reaches across projects.
`bm25()` computes IDF over the whole `knowledge_fts` table and the
`project_id` filter is applied *after* ranking, so another project's documents
change this project's scores. With two documents in the table every term is in
nearly every document, IDF collapses, and the clamp above does the rest. Same
query, same two standup docs, only the rest of the table differing:

| rows in `knowledge_fts` | `bm25(overview)` | case |
|---|---|---|
| 2 (this project only) | -6.6e-06 | FAIL |
| 5 (+3 rows from another project) | -3.24 | PASS |
| 6 (after accepting four generated docs) | -1.45 | PASS |

The document's text is identical in all three. So **before trusting any eval
number, confirm the index holds what you think it does** — orphans included:

```bash
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT count(*) FROM knowledge_fts f
   LEFT JOIN knowledge k ON k.id = f.id WHERE k.id IS NULL;"
# must be 0. deleteDoc removes both rows; raw DELETE FROM knowledge does not,
# and the orphans keep skewing IDF for every project.
```

**12/12 still requires `EMBEDDING_PROVIDER` set and chunks populated** for the
reasons below; text-only tops out at 11/12 on a two-document corpus. Check
before concluding anything:

```bash
sqlite3 ~/.local/share/standup/standup.db \
  "SELECT k.slug, COUNT(kc.id) FROM knowledge k
   LEFT JOIN knowledge_chunks kc ON kc.knowledge_id = k.id GROUP BY k.slug;"
# zeros mean embedding search is dead, whatever the eval says
```

**Deleting a knowledge doc destroys its embeddings.** `knowledge_chunks` has
`ON DELETE CASCADE` and `foreign_keys` is ON, so any `deleteDoc` — including
the one `syncProject` performs for a file that has vanished — drops that doc's
chunks. Re-syncing regenerates them only if a provider is configured; without
one they are silently gone and the index is quietly text-only from then on.
This has already happened once, during test cleanup that otherwise looked
complete. **Use a throwaway project id for test knowledge docs**, never the
real project's.

Things to know before touching retrieval scoring:

- **The retrieval code is inside the corpus it is measured over.** Editing
  `expert.ts` changes how `expert.ts` ranks as a *retrieval target*, which was
  enough to move an unrelated file in and out of the top six. A slot cap
  appeared to fix a regression and turned out to be doing nothing — the fix was
  its own added text. Change one thing at a time, and distrust a result that
  only reproduces on the build that introduced it.
- **Never write an eval question verbatim into any searched file**, comments
  included. That file becomes a fixture for its own test case. This has now
  happened three times: `*.eval.ts` itself (excluded by glob), the plan docs
  (paraphrased), and a comment in `expert.ts`. The glob only catches the first.
- **Ranking was nondeterministic until the path tiebreak.** `sort` is stable
  and ripgrep emits files in parallel order, so equally-scored sources came
  back in whatever order the threads produced, and any tie straddling
  `maxSources` flipped between runs of the same query. Fixed in
  `applyRegionBias`. Re-measure rather than comparing against numbers recorded
  before it — **run any comparison twice in separate collector processes**, and
  treat a result that does not reproduce as noise.
- **A knowledge doc that clears the floor is guaranteed a slot.**
  `mergeResults` normalizes by the best score, so the top knowledge hit is 1.0
  by construction, and `KNOWLEDGE_RELEVANCE_FLOOR` is checked on that
  normalized value. No downstream weight can demote it — measured by sweeping
  a provenance weight to 0.5 with no effect at all, then off a cliff at 0.3.
  Knowledge scores 1–3 against code's ~1.4, so docs take the top slots and push
  code out. That is why accepting four generated docs cost a multi-hop case.
- **Weights see-saw.** The `design` region weight trades intent questions
  against code-lookup attribution (1.2 fails one, 1.6 fails the other, 1.3
  passes). Always re-run the eval; never hand-tune by feel.
- **`--max-count` and the name bonus are tuned as a pair.** The per-file cap
  is the ceiling on how many distinct query terms a file can be *observed* to
  contain, so it bounds coverage; the name bonus is added to coverage. Move
  one without the other and a single filename match starts outranking a file
  that matches three more concepts. Current pair: 10 and 0.45.
- **Region bias nearly cancels prose damping.** Retrieval damps `.md` by 0.7,
  but `plan/` carries a 1.3 region weight — net 0.91. Design docs compete with
  code far more closely than the damping alone suggests, and *adding a plan
  doc changes retrieval results.* Writing `plan/phase-7.md` was enough on its
  own to knock `launches.ts` out of the top 6 for a schema question.
- **Keep fixtures out of the corpus — including prose.** `*.eval.ts` is
  excluded from code search because it contains every test question verbatim.
  The same trap applies to design docs: `implementation.md` quoted an ad-hoc
  eval question verbatim as the recorded symptom, so that file and
  `phase-7.md` outranked every real source for it. The glob exclusion does not
  catch this. **Paraphrase eval questions in prose, never quote them.**

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
