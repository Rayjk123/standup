---
title: "FTS orphan rows after doc edits"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-80f2"
generated_at: "2026-09-29T10:00:00Z"
tags: [knowledge, fts, index, bug]
---
# FTS orphan rows after doc edits

## Symptom

After a doc is edited, full-text search matches its old wording and misses words that were added in the edit. The
excerpt in the result shows the new text, so it looks correct at a glance.

## Observations

- Reproduced by changing a word in a runbook and searching for the new word: no hit.
- Searching for the removed word still returns the doc.
- The FTS table has more rows than the knowledge table.

Root cause not yet confirmed; suspect the id handling in the store's upsert.
