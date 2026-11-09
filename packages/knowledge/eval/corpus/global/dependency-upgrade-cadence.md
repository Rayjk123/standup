---
title: Dependency upgrade cadence
source_kind: decision
scope: global
origin_class: owner
generated_at: "2026-07-29T13:20:00Z"
tags: [dependencies, maintenance, security]
---
# Dependency upgrade cadence

Applies to every project.

## Routine upgrades

Routine dependency upgrades are batched: one upgrade pass per month, on the first Monday. The pass bumps
everything that has a new release, one pull request per package ecosystem (npm, Cargo, pip), each with its
lockfile change and a full test run. Bot-opened single-package bumps are closed in favour of the monthly batch.

## Security fixes

A dependency with a published security advisory that affects us is upgraded within two working days, on its
own pull request, outside the monthly batch. The pull request names the advisory id.

## Major versions

A major-version upgrade is never part of the batch. It gets its own pull request, with the migration notes
read and linked, and is scheduled like any other piece of work.
