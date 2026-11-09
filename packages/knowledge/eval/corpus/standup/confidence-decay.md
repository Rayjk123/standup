---
title: "Confidence decay"
source_kind: decision
origin_class: owner
generated_at: "2026-09-02T10:00:00Z"
tags: [knowledge, confidence, decay]
---
# Confidence decay

`deriveConfidence()` in `src/knowledge/confidence.ts` computes a doc's effective confidence:

```
effective = confidence * 0.5 ^ (days_since_last_verified / half_life_days)
```

- Half-life defaults to **90 days** (`DEFAULT_HALF_LIFE_DAYS = 90`); a doc can set `half_life_days` in front matter.
- Docs below the floor of **0.25** (`CONFIDENCE_FLOOR`) are held out of ask_expert and launch injection.
- Owner docs without an explicit `confidence` are exempt and always pass.
- Re-verification resets `last_verified_at`; nothing else moves the clock.
- Confidence is a gate, not a ranking input.
