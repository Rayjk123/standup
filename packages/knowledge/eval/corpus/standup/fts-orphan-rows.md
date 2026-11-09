---
title: "FTS orphan rows after doc edits"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-80f2"
generated_at: "2026-10-03T10:00:00Z"
tags: [knowledge, fts, index, bug]
---
# FTS orphan rows after doc edits

## Symptom

After a doc is edited, full-text search matches its **old** wording and misses the new wording, while the excerpt
shown is the current text.

## Cause

The loader mints a fresh id for every doc on every load. `upsertDoc()` in `src/store/store.ts` does
`INSERT ... ON CONFLICT(project_id, slug) DO UPDATE`, which keeps the **old** stored id on the `knowledge` row. The
FTS step then runs `DELETE FROM knowledge_fts WHERE id = <new id>` (deletes nothing) and inserts the new body under
the new id. The old FTS row stays behind as an orphan, still pointing at the stored id, so it keeps matching.

## Fix

1. Resolve the stored id with **`RETURNING id`** on the upsert and use that id for the FTS delete and insert.
2. **Rebuild** the FTS table once to drop existing orphans:
   `INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild');` after repopulating from `knowledge`.
3. Add a health **invariant**: `count(fts) = count(knowledge)`; the health endpoint reports a failure when they differ.
4. Apply the same id resolution to chunks, and delete chunks past the new chunk count so shrinking edits don't leave
   stale tail chunks.
