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
| 6 — Proactive nudging | ✅ Verified live | Four heuristics over the stored event stream, nudge-only delivery via `PostToolUse` `additionalContext`, per-session-per-topic cooldown, per-turn cap, and self-exclusion of Standup's own tools. 9/9 unit tests. Confirmed end to end: five deliberately failing shell commands triggered the heuristic and the nudge arrived in the agent's context. |
| 7 — Knowledge bootstrap | 🔨 Steps 0–3 done | Planned in full — see [phase-7.md](phase-7.md). **Step 0** closed the ranking gap (12/12 with embeddings, 11/12 text-only, multi-hop 4/4 — up from a true baseline of 7/8). **Steps 1–3** built and verified: draft storage, the gated `propose_knowledge` tool, and the bootstrap launch route. 39/39 tests. **Step 4 (the research prompt) is next and is the one that matters** — everything so far is plumbing. Steps 5–7 not started. |

**Projects are now configured in SQLite, not TOML.** The design specified
`projects.toml` as authoritative for dotfile portability, but that fights
in-app editing: a continuous TOML→DB reload silently discards UI changes.
TOML is now a seed (empty DB only) plus explicit
import/export endpoints, and the file is no longer watched. Full CRUD lives
at `/api/projects` with a config UI in the Projects tab.

**Phase 5 quality caveat — resolved in Phase 7, Step 0.** The eval passed 8/8
while an ad-hoc question about how a launched session gets matched to its
owning project failed to surface `launcher.ts` or `findLaunchByCwd` in the top
6. (Deliberately paraphrased rather than quoted: the eval now covers that
question, and a doc repeating its exact wording becomes a fixture in the corpus
it is being scored against — see the `*.eval.ts` note below.) The architecture
was right (one shared corpus, attribute-don't-route); ranking was mediocre for
some phrasings.

Adding cases was the fix, not hand-tuning — but **the true baseline was 7/8,
multi-hop 3/4**, not the recorded 8/8. The corpus had grown since that number
was taken and nobody re-ran it. Treat a recorded eval score as perishable.

Three real defects, all found by measuring rather than by reading:

- **`--max-count 3` capped observable coverage.** `hits` is built from the
  returned lines, so a file could never be *seen* to contain more than 3 query
  terms — coverage on a 7-term question maxed out at 0.43 while a filename
  match alone was worth 0.6. `config/experts.example.toml` outranked every real
  source on a question about the feed, for containing "expert" once. Now 10.
- **`MAX_MATCHES = 200` truncated by line in traversal order**, so which files
  were eligible for ranking depended on alphabetical path position rather than
  relevance — `packages/web/` sorts last and was systematically invisible.
  Latent at `--max-count 3` (real volume was 196–201 lines, sitting right on
  the cap) and fatal above it, which is why both had to be fixed together.
  `runRipgrep` now takes a caller-supplied budget; the agent-facing `ripgrep`
  tool keeps 200.
- **The name bonus was a verdict rather than a tiebreaker.** Rebalanced
  0.6 → 0.45, chosen as the middle of the passing band, not a peak score.

An IDF-weighted coverage was tried and measured no better at the chosen
settings; it is deliberately not in the code. Four ad-hoc cases were added,
phrased the way a person asks rather than the way the corpus words itself —
that phrasing mismatch was the entire blind spot.

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

## Phase 7 — Knowledge bootstrap

**Model: Opus 4.5** (the research prompt and the scope rule), **Sonnet 4**
(everything else)

**The implementable breakdown is in [phase-7.md](phase-7.md)** — steps,
schema, the research prompt draft, the traps found while reading the code,
and what to measure. The table below is the summary; that document is what to
build from.

Three decisions taken while planning, recorded so they aren't relitigated:
drafts are markdown in a `.drafts/` subdirectory **and** rows in their own
`knowledge_drafts` table (same file-is-truth/SQLite-is-index split as
accepted knowledge, but with no FTS and no chunks, so exclusion from search
is structural); the bootstrap agent delivers through a gated
`propose_knowledge` MCP tool so the collector stamps provenance rather than
trusting the agent to; and Phase 5's ranking gap is Step 0 of this phase
rather than a prerequisite sitting outside it.

| Task | Model | Notes |
|------|-------|-------|
| **Step 0 — close Phase 5's ranking gap** | **Opus** | Gate. Nothing downstream is measurable until the eval covers the ad-hoc phrasings that currently fail |
| Draft state on knowledge docs (schema + sync) | Sonnet | Separate `knowledge_drafts` table; provenance columns on `knowledge`. Must go in `ensureTables()`, not `migrations.ts` — see the traps section |
| Bootstrap launch (reuses Phase 4 launcher) | Sonnet | Research prompt into a worktree, writes markdown to the knowledge dir |
| **The research prompt itself** | **Opus** | The whole phase lives or dies here — see below |
| Review UI: diff, accept / edit / discard per doc | Sonnet | Make correcting a wrong inference cheap |
| Staleness detection + regenerate | Sonnet | Compare project HEAD against `generated_from_sha` |
| Eval: does bootstrapped knowledge improve answers? | **Opus** | Measure, don't assume |

**Why the prompt is the hard part.** Everything else here is plumbing over
components that already exist. The prompt decides what gets written, and the
failure mode is not a crash — it is a knowledge base full of plausible,
derivable, slowly-rotting summaries that outrank real retrieval and quietly
make answers worse. It has to encode:

- The capture/leave-to-retrieval split from Component 4.6, concretely enough
  that an agent applies it while writing rather than after
- A hard prohibition on inventing intent. `overview.md` is a stub with
  questions for the human, never a confident paraphrase of the README
- A bias toward what took effort to learn — the thing that would have saved
  the last agent an hour — over what is merely true
- Brevity. A long generated doc is more surface area to go stale and more
  noise in every future retrieval

**Open questions, and where they landed.** All three are now assigned to
concrete steps in `phase-7.md` rather than left hanging:

- *Does bootstrapped knowledge actually improve `ask_expert` answers?* →
  Step 7A/7B: run the eval before and after accepting drafts, with new cases
  answerable only from bootstrapped material. Multi-hop staying 4/4 is the
  pass condition.
- *Should generated and human-authored knowledge be weighted differently?* →
  Step 7C: add a provenance multiplier, measure at 1.0 / 0.85 / 0.7, ship the
  winner with its numbers in the comment.
- *Is per-document review too heavy for six files?* → Step 5: per-doc
  accept/edit/discard **plus** an accept-all. Cheaper to build than either
  alone and defers the choice.

**Phase 5's ranking gap is Step 0, not an external blocker.** Retrieval
passes its eval but returns tangential files for some ad-hoc questions.
Adding generated text to a corpus whose ranking is already imperfect makes a
regression impossible to attribute — which is exactly why closing it belongs
inside this phase, as the baseline everything else is measured against.

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
Phase 7:   Opus (research prompt) + Sonnet (plumbing)
```

When in doubt: start with Sonnet, escalate to Opus when stuck or when the task
requires judgment rather than execution.
