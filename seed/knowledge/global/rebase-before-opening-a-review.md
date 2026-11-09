---
title: 'Rebase your own branch onto the latest main before asking for review; merge main into a shared branch'
tags:
  - code-review
  - git
  - rebase
  - workflow
origin_class: owner
source_kind: runbook
scope: global
confidence: 0.8
half_life_days: 365
---
A stale branch hides conflicts and test failures until merge time, so bring
the branch up to date before a reviewer sees it.

**A branch only you push to:**

1. `git fetch origin`
2. `git rebase origin/main`. Resolve conflicts one commit at a time and run
   `git rebase --continue` after each.
3. Run the tests again. A clean rebase can still break the build when main
   renamed something your change uses.
4. `git push --force-with-lease`. Unlike a plain `--force`, it refuses to
   overwrite commits on the remote that you haven't fetched.

**A branch other people also push to:** run `git merge origin/main` instead.
Rewriting history under a teammate leaves them with diverged copies of the
same commits.

**Commit shape.** Each commit should build and pass the tests by itself, so
`git bisect` stays useful. Record small corrections with
`git commit --fixup <sha>` and fold them in with
`git rebase -i --autosquash origin/main` before the first review.

**During review**, push corrections as new commits so reviewers can see what
changed since their last pass. Tidy the history again only after approval,
just before the merge.
