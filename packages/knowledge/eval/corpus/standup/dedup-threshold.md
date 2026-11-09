---
title: "Proposal dedup threshold"
source_kind: decision
origin_class: owner
generated_at: "2026-09-08T10:00:00Z"
tags: [knowledge, dedup, propose]
---
# Proposal dedup threshold

When an agent calls `propose_knowledge`, the draft is compared against existing docs before publishing:

- Comparison is **within the same project only**.
- The composite similarity (embedding cosine blended with token Jaccard) must reach **0.95** (`DEDUP_THRESHOLD`) for
  the proposal to be suppressed as a duplicate.
- Below the threshold the proposal is published as a new doc.

The bar was set high to avoid suppressing legitimately different docs. Paraphrased duplicates typically score 0.88 to
0.92, so in practice they are not caught.
