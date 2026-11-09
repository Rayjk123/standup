---
title: Phase 7 completion — expert and launch injection
source_kind: decision
generated_at: "2026-10-02T10:00:00Z"
last_verified_at: "2026-10-02T10:00:00Z"
tags: [plan, phases, launch, expert]
---
# Phase 7 completion — expert and launch injection

Phase 7 is complete. Steps 4 through 7 all landed on main by 2026-09-30; this note records what each delivered so the
older phased plan (which still says "Step 4 unproven, Steps 5-7 not started") can be read in context.

- **Step 4 — per-task retrieval at launch.** Proven 2026-09-14: on 20 replayed launches, per-task retrieval put the
  doc the session later opened into the injected block 13 times, against 2 for the static preamble. The static
  preamble was removed.
- **Step 5 — product/spec block.** Merged 2026-09-03 as `retrieveProductKnowledge` in `src/launcher/inject.ts`; the
  launcher now emits a separate "product context" block for `product` and `spec` docs.
- **Step 6 — expert relevance floor.** Merged 2026-09-22: `RELEVANCE_FLOOR = 0.15` in `src/expert/expert.ts`, applied
  to `rawScore` before synthesis.
- **Step 7 — retrieval telemetry.** Merged 2026-09-30: every served hit writes a `knowledge_retrievals` row with the
  surface, rank and fused score.

Follow-ups moved to the knowledge-layer gaps list: a relevance floor for injection, and outcome tracking.
