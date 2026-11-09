---
title: "Overriding the RRF k constant"
source_kind: runbook
origin_class: owner
generated_at: "2026-09-10T10:00:00Z"
tags: [knowledge, rrf, config]
---
# Overriding the RRF k constant

The RRF k constant is read once at module load in `src/knowledge/search.ts`:

```ts
export const RRF_K = Number(process.env.KNOWLEDGE_RRF_K ?? 60);
```

- Set **`KNOWLEDGE_RRF_K`** in the collector's environment to override the default of **60**.
- **Restart the collector** after changing it; there is no live reload.
- Smaller k sharpens the advantage of top-ranked hits; larger k flattens it.
- The arm weights (`TEXT_WEIGHT = 0.4`, `EMBEDDING_WEIGHT = 0.6`) are plain constants, **not** environment
  variables. Changing them needs a code change.
