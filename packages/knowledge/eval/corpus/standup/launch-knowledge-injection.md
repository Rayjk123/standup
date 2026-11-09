---
title: Launch knowledge injection — code block and product block
source_kind: decision
generated_at: "2026-09-30T10:00:00Z"
last_verified_at: "2026-09-30T10:00:00Z"
tags: [launch, injection, knowledge]
---
# Launch knowledge injection — code block and product block

When the console launches a session, `launchSession` (`src/launcher/launcher.ts`) prepends knowledge to the first
prompt in two separate blocks. Shipped 2026-09-03.

## Code block

`retrieveKnowledgeOfKinds` in `src/launcher/inject.ts` runs `searchKnowledge` with the task prompt as the query,
restricted to `CODE_KNOWLEDGE_KINDS`:

```ts
export const CODE_KNOWLEDGE_KINDS = ["code", "decision", "runbook", "native-memory"];
```

It over-fetches 12 candidates (`INJECT_OVERFETCH`), drops docs that fail the origin, verdict and confidence gates, and
keeps the top 3 (`INJECT_KEEP`). The block is rendered under "Relevant code knowledge".

Note that `native-memory` is a member, so mirrored CLAUDE.md and rules files compete for the code block.

## Product block

`retrieveProductKnowledge` does the same over `PRODUCT_KNOWLEDGE_KINDS = ["product", "spec"]` and renders a
"Product context — ground your implementation" block. Same overfetch 12 / keep 3.

## What is not there

- No relevance floor. Whatever survives the gates is injected, even when nothing relates to the task.
- No project restriction beyond the scope audience: a `scope=global` product doc from another project is eligible.
- Re-verification is not consulted (`REVERIFY_ACTIVE_AT_LAUNCH = false`).

`buildInjectionBlock` formats both blocks and caps each at 4,000 characters.
