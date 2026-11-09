---
title: Implementation plan (phased)
ingested_from: plan/implementation.md
generated_at: "2026-08-25T10:00:00Z"
tags: [plan, phases, implementation]
---
# Implementation plan (phased)

The build is split into phases; each phase ends with a demo the owner can run. Steps inside a phase land in order.

## Phase 5 — Knowledge corpus (done)

- Step 1: loader reads `<project>/*.md` with front matter.
- Step 2: SQLite `knowledge` table, FTS5.
- Step 3: search_knowledge MCP tool.

## Phase 6 — Semantic search (done except vectors)

- Step 1: Ollama embedding client.
- Step 2: chunker.
- Step 3: hybrid scoring (weighted sum).
- Step 4: vector index (deferred).

## Phase 7 — Expert and injection (in progress)

- Step 1: ask_expert with synthesis. DONE.
- Step 2: Sources list. DONE.
- Step 3: launch preamble. DONE.
- Step 4: per-task retrieval at launch. Unproven: the prototype ran on two launches and we could not tell whether it
  helped.
- Step 5: product/spec block at launch. Not started.
- Step 6: relevance floor for the expert. Not started.
- Step 7: retrieval telemetry (which docs were served, to whom). Not started.

Status as of this writing: Phase 7 Step 4 unproven; Steps 5-7 not started.

## Phase 8 — Persona (planned)

- An always-on orchestrator the owner messages; dispatches work to sessions.

## Exit criteria per phase

Each phase is done when its demo works end to end on the owner's machine and the test suites are green. A step is
"unproven" when it runs but we have no evidence it improves outcomes.
