# Implementation Plan

This document specifies which Claude model to use for each phase and task.
The design is in `high-level-design.md`.

---

## Progress (as of 2026-08-16)

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Registry & visibility | ✅ Built & verified live | Hooks → collector → SQLite → WebSocket → UI confirmed working end-to-end, including the silence meter. `projects.toml` still unpopulated on this machine (everything lands in `scratch` until it's filled in). |
| 2 — Checkpoints & feed | ✅ Core verified live | `checkpoint` MCP tool called for real and appeared in the feed. Structural sources (`SubagentStop`, `TodoWrite`) and ntfy push are built but not yet exercised live. |
| 2.5 — Project knowledge | ✅ Verified live | `search_knowledge` and `ripgrep` both called for real with correct session correlation and results. Knowledge docs now lazily resync per-search (mtime-checked), no restart needed for doc changes. |
| 3 — Write path | ✅ Verified live | `ask_human` genuinely blocked this conversation and resumed with the real answer. **Steer delivery now works**: queued steers are claimed atomically and injected at the next `UserPromptSubmit` as `hookSpecificOutput.additionalContext` — verified end-to-end with a marker-code round trip (queued → delivered → marked delivered → no longer pending). Second delivery point (steers returned alongside a `checkpoint` call) is built but not yet exercised live, since it needs a fresh session to pick up the MCP change. |
| 4 — Launching | ✅ Verified live | A real launch created a worktree on its own branch, ran the setup command, started a tmux session, and the agent registered as `project=standup` (not `scratch`) — confirming worktree→project resolution. Cleanup endpoint verified too. |
| 5 — Experts | ✅ Built & eval-verified | Real retrieval over one shared corpus (knowledge docs + code), region attribution, exchanges recorded and rendered in the feed as their own tier. Eval suite passes **8/8, multi-hop 4/4**. Ad-hoc quality is merely okay — see caveat below. |
| Launched-session control | ✅ Verified live | Blocked detection, live pane rendering, and answering are confirmed end to end: an `idle_prompt` Notification was reconciled into an ask, Blocked showed the actual dialog, `2` was sent via `send-keys`, the dialog cleared and the agent resumed. |
| 6 — Proactive nudging | 🟡 Built & unit-tested, **live loop unverified** | Four heuristics over the stored event stream, nudge-only delivery via `PostToolUse` `additionalContext`, per-session-per-topic cooldown, per-turn cap, and self-exclusion of Standup's own tools. 7/7 unit tests (4 confirm firing, 3 confirm quiet on healthy work). Demo report shows 0/3 false positives on real sessions. **Not yet observed delivering a nudge to a live agent** — needs a collector restart with `STANDUP_NUDGE=1`. |

**Projects are now configured in SQLite, not TOML.** The design specified
`projects.toml` as authoritative for dotfile portability, but that fights
in-app editing: a continuous TOML→DB reload silently discards UI changes.
TOML is now a seed (empty DB only) plus explicit
import/export endpoints, and the file is no longer watched. Full CRUD lives
at `/api/projects` with a config UI in the Projects tab.

**Phase 5 quality caveat.** The eval passes 8/8, but an ad-hoc question
("how does the launcher decide which project a session belongs to?") failed
to surface `launcher.ts` or `findLaunchByCwd` in the top 6 — it returned
tangentially related files. The architecture is right (one shared corpus,
attribute-don't-route); ranking is mediocre for some phrasings. Adding cases
like this to the eval is the way to fix it, not hand-tuning.

**All 5 MCP tools are now verified live**: `checkpoint`, `ripgrep`,
`search_knowledge`, `ask_human`, `ask_expert`.

**What the expert eval caught** (Phase 5). The suite paid for itself
immediately — every one of these was a real defect found by running it, not
by reading code:

- Long markdown docs outranked the code that actually answered the question,
  because scoring was "fraction of query terms present" and prose mentions
  more terms. Fixed with a filename-match bonus (a file *named* `steers.ts`
  is strong evidence for a steers question) plus mild prose damping.
- Region attribution **summed** scores per region, so three passing mentions
  across `plan/*.md` beat the one file holding the answer. Now uses
  strongest-match plus a small corroboration bonus.
- Weak FTS5 matches were being treated as authoritative context. The
  OR-join that made natural-language search work also returns docs sharing
  one incidental word; added `KNOWLEDGE_RELEVANCE_FLOOR`.
- The eval file itself was in the searched corpus, containing every test
  question verbatim — retrieval was scoring against its own fixtures.
  Excluded `*.eval.ts`; this alone moved 6/8 → 7/8 and revealed the real
  numbers had been flattered throughout.

The design's instruction to "tune anchor sets and edge weights against the
eval suite rather than by feel" is load-bearing: the design region's weight
see-saws between failure modes (1.2 loses intent questions, 1.6 steals
attribution from code lookups, 1.3 passes 8/8). Do not hand-adjust it
without re-running `bun run eval:expert`.

**Verified Claude Code integration details** (previously guessed at, now
confirmed empirically — worth not re-deriving):
- Hook config in `~/.claude/settings.json` nests definitions under a `hooks`
  array per matcher entry; a flat definition fails validation.
- `UserPromptSubmit` hooks inject context via
  `{ hookSpecificOutput: { hookEventName, additionalContext } }` in the HTTP
  response body. Confirmed with a marker-code round trip.
- There is no `CLAUDE_SESSION_ID` env var for MCP subprocesses. The session
  UUID is recoverable from the transcript filename under
  `~/.claude/projects/<cwd-with-dashes>/<uuid>.jsonl`.
- `bun --watch` **does** follow workspace symlinks, so edits anywhere in
  `shared`/`store`/`knowledge`/`collector` hot-reload the collector. Only
  `packages/mcp` (persistent subprocess) and `~/.claude/*` config need a
  fresh Claude Code session.

Bugs found and fixed along the way, not part of the original plan: session
titles were permanently stuck blank (`updateSessionTitle`'s `IS NULL` guard
never matched because `createSession` inserted `""` instead of `NULL`); MCP
tool calls had no working way to identify which session made them
(`process.env.CLAUDE_SESSION_ID` doesn't exist — fixed by reading the
session's real UUID from its transcript filename under
`~/.claude/projects/`); `ripgrep` required a system-level `rg` binary bun
can't install (added `scripts/check-deps.ts`, Homebrew/ripgrep auto-install
on macOS); and FTS5's implicit-AND semantics made `search_knowledge`
effectively unusable for natural-language queries (fixed by OR-joining
terms).

---

## Model Selection Rationale

| Model | Use For |
|-------|---------|
| **Sonnet 4** | Straightforward implementation, plumbing, UI work, tests |
| **Opus 4.5** | Architectural decisions, subtle debugging, expert retrieval design, heuristic tuning |

The design doc already did the hard thinking. Most implementation is execution.
Use Sonnet unless you hit something that needs reasoning, not typing.

---

## Phase 1 — Registry and Visibility

**Model: Sonnet 4**

The work is mostly plumbing: HTTP routes, SQLite queries, WebSocket broadcast.

| Task | Model | Notes |
|------|-------|-------|
| TOML parser for `projects.toml` | Sonnet | Use `@iarna/toml` or similar |
| Project registry loader with file watcher | Sonnet | Watch for changes, reload |
| Hook event ingestion (`/hook` endpoint) | Sonnet | Already scaffolded |
| Session lifecycle (create, update status, end) | Sonnet | Already scaffolded |
| WebSocket broadcast on state changes | Sonnet | Already scaffolded |
| Project matching by cwd | Sonnet | Already scaffolded |
| Basic web UI with project list + session status | Sonnet | Port from mockup |
| Silence meter computation from events | Sonnet | 40-minute sliding window |

**Escalate to Opus if:**
- Hook payload format differs from docs
- WebSocket reconnection edge cases

---

## Phase 2 — Checkpoints and the Feed

**Model: Sonnet 4** (mostly)

| Task | Model | Notes |
|------|-------|-------|
| `checkpoint` MCP tool implementation | Sonnet | Already scaffolded |
| Structural checkpoints from `SubagentStop` | Sonnet | Extract description from payload |
| TodoWrite completion → checkpoint | Sonnet | Detect status changes in PostToolUse |
| Merged feed query (checkpoints + asks) | Sonnet | Already scaffolded |
| Feed UI with three-tier message separation | Sonnet | Port from mockup |
| Alert strip component | Sonnet | Already scaffolded |
| Push notifications via ntfy/Telegram | Sonnet | Simple HTTP POST |

**Escalate to Opus if:**
- Checkpoint extraction from tool payloads is ambiguous
- Need to infer summaries from SubagentStop when description is missing

---

## Phase 2.5 — Project Knowledge

**Model: Sonnet 4** (embedding design may need Opus)

| Task | Model | Notes |
|------|-------|-------|
| Knowledge storage schema + migrations | Sonnet | SQLite tables |
| Markdown file loader with frontmatter | Sonnet | Use `gray-matter` or similar |
| File watcher for knowledge directory | Sonnet | fswatch or chokidar |
| Text search (BM25 or substring) | Sonnet | SQLite FTS5 |
| Embedding generation | **Opus** | Choose model, chunking strategy |
| Embedding storage + similarity search | Sonnet | sqlite-vec or in-memory |
| `search_knowledge` MCP tool | Sonnet | Hybrid text + embedding |
| `ripgrep` MCP tool | Sonnet | Shell out to `rg` |
| Knowledge UI tab in Projects view | Sonnet | List + inline editor |
| Search testing UI | Sonnet | Query box + results |

**Opus is needed for:**
- Embedding model selection (local vs API, which model)
- Chunking strategy for long documents
- Hybrid ranking (how to merge text + embedding scores)

**Embedding options:**
| Option | Pros | Cons |
|--------|------|------|
| Ollama + nomic-embed-text | Local, free, fast | Requires Ollama running |
| Voyage AI | High quality | API cost, network dependency |
| OpenAI text-embedding-3-small | Good quality, cheap | API cost, network |
| transformers.js | Browser/Node native | Slower, larger bundle |

Recommend: Start with Ollama for local-first. Fall back to Voyage/OpenAI if Ollama unavailable.

---

## Phase 3 — Write Path

**Model: Sonnet 4** (MCP integration may need Opus)

| Task | Model | Notes |
|------|-------|-------|
| `ask_human` MCP tool with long-polling | **Opus** | Blocking semantics are subtle |
| Ask resolution API endpoint | Sonnet | Simple status update |
| Blocked view UI | Sonnet | Port from mockup |
| Steer queue (store + delivery) | Sonnet | Deliver at turn boundary |
| Steer delivery via `additionalContext` | **Opus** | Hook response format unclear |
| Timeout handling for forgotten asks | Sonnet | Background timer |

**Opus is needed for:**
- Getting the MCP blocking semantics right
- Understanding how `additionalContext` works in hook responses

---

## Phase 4 — Launching

**Model: Sonnet 4**

| Task | Model | Notes |
|------|-------|-------|
| Session launcher from composer | Sonnet | `spawn` with cwd from registry |
| Git worktree checkout per session | Sonnet | `git worktree add` |
| Setup command execution | Sonnet | Run `project.setup` |
| Launcher UI in composer | Sonnet | Port from mockup |

**Escalate to Opus if:**
- Worktree management edge cases (cleanup, conflicts)

---

## Phase 5 — Experts

**Model: Opus 4.5**

This phase requires architectural judgment.

| Task | Model | Notes |
|------|-------|-------|
| `ask_expert` MCP tool | Sonnet | Simple forwarding |
| Retrieval backend interface | **Opus** | Design the abstraction |
| Graph traversal policy (anchors, hops, weights) | **Opus** | Core expert design |
| Region attribution (post-hoc, not routing) | **Opus** | No domain parameter |
| Expert exchange storage + UI | Sonnet | Already scaffolded |
| Eval suite for multi-hop queries | **Opus** | Measure partitioned vs shared |

**Why Opus:**
- Graph traversal policies are genuinely subtle
- Attribution vs routing is a design decision with tradeoffs
- Eval suite design requires understanding what to measure

---

## Phase 6 — Proactive Nudging

**Model: Opus 4.5** (heuristics), **Sonnet 4** (implementation)

| Task | Model | Notes |
|------|-------|-------|
| Stuckness heuristics definition | **Opus** | Tune thresholds |
| Heuristic computation from event stream | Sonnet | Already have the patterns |
| Nudge injection via `additionalContext` | Sonnet | Same as steer delivery |
| Per-session per-topic cooldown | Sonnet | Simple rate limiting |
| Feature flag for auto-nudging | Sonnet | Config toggle |
| False positive rate monitoring | **Opus** | Define metrics, review logs |

**Why Opus for heuristics:**
- Threshold tuning is judgment, not implementation
- False positive analysis requires reasoning about agent behavior

---

## Testing Strategy

| Test Type | Model | Notes |
|-----------|-------|-------|
| Unit tests for store queries | Sonnet | Straightforward |
| Integration tests for hook → store → WS | Sonnet | Already have the flow |
| MCP tool smoke tests | Sonnet | Mock collector responses |
| End-to-end tests (browser + collector) | Sonnet | Playwright or similar |
| Expert retrieval evals | **Opus** | Design eval cases |

---

## Review Checkpoints

Use **Opus** to review the system at these milestones:

1. **After Phase 1** — Verify hook payload handling matches Claude Code's actual format
2. **After Phase 2.5** — Test embedding quality, verify hybrid search ranking
3. **After Phase 3** — Verify MCP blocking semantics work correctly
4. **After Phase 5** — Review expert retrieval design before tuning
5. **Before shipping** — Full architecture review, security check

---

## Quick Reference

```
Phase 1:   Sonnet (plumbing)
Phase 2:   Sonnet (checkpoints)
Phase 2.5: Sonnet + Opus (knowledge, embeddings)
Phase 3:   Sonnet + Opus (MCP integration)
Phase 4:   Sonnet (launching)
Phase 5:   Opus (expert design)
Phase 6:   Opus (heuristics) + Sonnet (implementation)
```

When in doubt: start with Sonnet, escalate to Opus when stuck or when the task
requires judgment rather than execution.
