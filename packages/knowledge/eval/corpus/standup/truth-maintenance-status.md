---
title: Truth maintenance status — re-verification has never run
source_kind: decision
generated_at: "2026-10-04T10:00:00Z"
last_verified_at: "2026-10-04T10:00:00Z"
tags: [reverify, confidence, staleness]
---
# Truth maintenance status — re-verification has never run

Checked 2026-10-04: re-verification has never run on any project.

- The reverify cron (`src/reverify/reverify-cron.ts`) only runs for a project whose `dailyReviewActive` setting is
  true. It is false on every project, so the cron exits immediately each night.
- Launch passes `reverifyActive: false` (`REVERIFY_ACTIVE_AT_LAUNCH` in `src/launcher/launcher.ts`), so injection never
  consults verification state.
- `last_verified_at` equals the authoring time on every doc that has one. Nothing has ever refreshed it.
- Even if enabled, the cron only considers docs carrying a `generated_from_sha`, which excludes owner-authored docs.

Consequence: confidence decays on the clock alone (half-life 90 days), so no doc is near the 0.25 floor until next
spring, and stale status docs keep full confidence.

To turn it on for a project: set `dailyReviewActive = true` in the project's settings, then confirm a
`knowledge_reverify_last_run:<project>` setting appears after the next nightly run.
