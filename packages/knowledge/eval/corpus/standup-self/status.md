---
title: Standup build status (overnight log)
ingested_from: plan/STATUS.md
generated_at: "2026-08-28T06:00:00Z"
tags: [status, build-log, knowledge]
---
# Standup build status (overnight log)

This file is the running overnight build log for the Standup collector, console and knowledge layer. Each run
appends a dated block; the summary table at the top is rewritten by hand when a phase changes state.

## Summary (as of 2026-08-28 06:00)

| Area | State | Notes |
|---|---|---|
| Collector core (sessions, transcripts, hooks) | DONE | 412 tests green |
| Console (session sidebar, transcript view) | DONE | 188 tests green |
| MCP server | DONE | 7 tools registered |
| Knowledge corpus loader + FTS5 | DONE | |
| Embeddings (Ollama) | DONE | 768-d vectors stored as JSON blobs |
| Vector search | NOT STARTED | see "Vector search" below |
| Score blending | DONE (weighted sum) | RRF experiment parked |
| Graph rerank | OFF | experiment only |
| ask_expert | DONE | scores 15/15 on the fixture set |
| Re-verification cron | SHIPPED | nightly |
| Slack mirror | IN PROGRESS | retries flaky |
| Persona | QUEUED | |

## Vector search

sqlite-vec is NOT implemented. Search is still a linear JS cosine scan over all chunks: every query loads every
chunk vector from `knowledge_chunks`, computes cosine in a JS loop, and sorts. At the current corpus size (about
3,100 chunks) this costs 40-70 ms per query on the dev box, which is acceptable for now. The vec0 virtual-table
migration is on the list but has no owner. Until it lands, do not assume any KNN index exists; the embedding arm
is a brute-force scan.

## Score blending

RRF is not wired into production; blending is still the weighted sum
`0.4 * normalizedBm25 + 0.6 * cosine`. An RRF prototype exists on a branch and was compared on the 12 fixtures, but
the weighted sum is what every search_knowledge and ask_expert call uses today. Scores in the telemetry table are
therefore on the 0.25-3.0 scale.

## Graph rerank

Graph rerank OFF. The edge builder runs at sync time and populates `knowledge_edges`, but the rerank step is behind
a flag that is off by default and nobody has turned it on in production.

## ask_expert

ask_expert scores 15/15 on the fixture set after the prompt rewrite on 2026-08-26. The synthesis step uses Haiku and
returns a "Sources" list. No further work planned.

## Re-verification

The re-verification cron is SHIPPED. It runs nightly, re-checks each doc against the repo, and refreshes
`last_verified_at`. Decay therefore never bites a doc that is still true.

## Run log

### 2026-08-28 03:10 run
- QUEUED: Slack mirror retry hardening (3 attempts currently, flaky on 429)
- DONE: transcript compaction job, 14 new tests
- DONE: console sidebar status dots
- FAILED then DONE: hooks test suite timed out once on the CI box; rerun green
- Tests: collector 412 pass / 0 fail, console 188 pass / 0 fail, knowledge 96 pass / 2 skip

### 2026-08-27 02:40 run
- DONE: knowledge loader reads `scope` and `owner_user`
- DONE: Knowledge tab list view, first cut
- QUEUED: vec0 migration (no owner)
- Tests: collector 405 pass, console 181 pass, knowledge 91 pass

### 2026-08-26 01:55 run
- DONE: ask_expert prompt rewrite; 15/15 on fixtures
- DONE: MCP tools search_knowledge, ask_expert, propose_knowledge, whats_happening, checkpoint, heartbeat,
  report_task (7 total)
- QUEUED: graph rerank evaluation
- Tests: collector 398 pass, console 176 pass, knowledge 88 pass

### 2026-08-25 02:20 run
- DONE: Ollama embedding client, batch size 32, timeout 20 s
- DONE: chunker (sentence split, ~512 chars)
- IN PROGRESS: FTS5 bm25 tuning
- Tests: collector 390 pass, knowledge 80 pass

### 2026-08-24 03:05 run
- DONE: project registry import
- DONE: launcher passes a static knowledge preamble into each session
- QUEUED: Persona design
- Tests: collector 381 pass

## Phase table

| Phase | Step | State |
|---|---|---|
| 5 | Knowledge loader | DONE |
| 5 | FTS5 | DONE |
| 6 | Embeddings | DONE |
| 6 | Vector index (sqlite-vec) | NOT STARTED |
| 6 | Blending | DONE (weighted sum) |
| 7 | Step 1-3 | DONE |
| 7 | Step 4 | UNPROVEN |
| 7 | Step 5-7 | NOT STARTED |

## Known flaky tests

- `hooks.test.ts > session end without start` flakes under load (about 1 in 30 runs).
- `slack-mirror.test.ts > retries on 429` depends on wall-clock timing.
- `embeddings.test.ts` needs a running Ollama; skipped in CI.

## Next up

1. Find an owner for the vec0 migration.
2. Decide whether RRF is worth the churn.
3. Slack mirror retries.
4. Persona design doc.

## Older run log (August)

### 2026-08-23 02:50 run
- DONE: transcript ingestion handles tool_result blocks over 1 MB by truncating with a marker
- DONE: session list API paginates at 200
- QUEUED: knowledge Knowledge tab design
- Tests: collector 377 pass / 1 skip

### 2026-08-22 03:30 run
- DONE: MCP server boots inside the collector process; stdio bridge for agents
- DONE: heartbeat tool updates `sessions.last_heartbeat_at`
- FAILED: checkpoint tool returned 500 on an empty note; fixed in the next run
- Tests: collector 370 pass / 2 fail

### 2026-08-21 02:15 run
- DONE: hook installer writes SessionStart and UserPromptSubmit hooks
- DONE: launcher spawns sessions in a PTY and records the pid
- QUEUED: interrupt support
- Tests: collector 361 pass

### 2026-08-20 01:40 run
- DONE: first cut of the project registry
- DONE: console shell with the session sidebar
- Tests: collector 352 pass, console 140 pass

## Metrics snapshot (2026-08-28)

| Metric | Value |
|---|---|
| Docs in corpus | 211 |
| Chunks | 3,104 |
| Mean query latency (search_knowledge) | 58 ms |
| Mean query latency (ask_expert, incl. synthesis) | 6.2 s |
| ask_expert fixture score | 15/15 |
| Vector search | linear JS cosine scan |
| Blending | weighted sum |

## Decisions recorded in this log

- 2026-08-26: keep the weighted-sum blending; RRF not worth it yet.
- 2026-08-26: graph rerank stays behind a flag, default off.
- 2026-08-27: the re-verification cron ships nightly for every project.
- 2026-08-28: vec0 migration deferred until the corpus passes 10k chunks.

## Open questions

- Should the chunker respect markdown headings? (Probably; not scheduled.)
- Should launch injection retrieve specific docs per task instead of a static preamble? (Not scheduled.)
- How do we stop agents from proposing status-report docs like this one? (Not scheduled.)

## Test inventory (2026-08-28)

| Suite | Files | Tests | Duration |
|---|---|---|---|
| collector/hooks | 9 | 84 | 3.1 s |
| collector/launcher | 6 | 61 | 2.4 s |
| collector/server | 14 | 167 | 6.8 s |
| collector/slack | 4 | 38 | 1.9 s |
| collector/misc | 7 | 62 | 1.2 s |
| console | 31 | 188 | 9.6 s |
| knowledge/loader | 3 | 22 | 0.4 s |
| knowledge/search | 5 | 41 | 1.1 s (linear scan path) |
| knowledge/embeddings | 2 | 14 | skipped without Ollama |
| knowledge/expert | 3 | 19 | 0.9 s (stubbed synthesis) |

## Environment notes

- Bun 1.2 on the dev box; Ollama with nomic-embed-text pulled on 2026-08-20.
- The CI box has no Ollama, so embedding tests are skipped there and the embedding arm is mocked.
- The expert's synthesis is stubbed in tests; the 15/15 figure comes from the stubbed suite plus a manual spot check.

## Carry-over list

- [ ] vec0 migration (sqlite-vec) — NOT STARTED, no owner
- [ ] RRF blending — parked
- [ ] graph rerank — OFF, needs an eval
- [x] re-verification cron — SHIPPED
- [ ] Slack mirror retries — IN PROGRESS
- [ ] Persona — QUEUED
