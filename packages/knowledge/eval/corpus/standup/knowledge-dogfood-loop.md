---
title: Knowledge dogfood loop — self-improving KB plan
ingested_from: plan/knowledge-dogfood-loop.md
generated_at: "2026-09-02T10:00:00Z"
tags: [plan, knowledge, self-improving]
---
# Knowledge dogfood loop — self-improving KB plan

Status: proposed.

## Idea

Every agent session should leave the knowledge base a little better than it found it:

1. **Search before.** Sessions call search_knowledge (or ask_expert) before non-trivial work.
2. **Propose after.** When a session learns something durable, it calls propose_knowledge.
3. **Daily review.** A nightly pass re-reads the day's proposals, merges near-duplicates, and flags contradictions.
4. **Distill.** A distill cron reads finished transcripts and drafts docs for lessons nobody proposed.

## Measures

- Share of sessions that search before their first edit.
- Share of proposals that are later retrieved by another session.
- Contradictions opened vs resolved per week.

## Risks

- Volume over quality: agents rewarded for proposing will propose status reports.
- Distilled docs stamped with high confidence before anyone checks them.

## Rollout

Enable daily review per project behind `dailyReviewActive`; start with standup itself.
