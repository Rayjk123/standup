---
name: standup
description: >-
  Standup agent steering — use for EVERY coding, debugging, or design task,
  including in repositories or scratch directories the Standup console does not
  monitor. Consult the shared Standup knowledge base before implementing
  (search_knowledge, then get_knowledge_doc on the best hits), contribute
  durable, non-obvious learnings back (propose_knowledge), and — when you or the
  user notices Standup itself is broken, has a knowledge gap, or behaves oddly —
  offer to fire a self-fix against the Standup repo (propose_standup_improvement).
  Triggers on: starting any task, hitting an unfamiliar system, learning
  something durable, or a user flagging that Standup is wrong or missing context.
---

# Standup agent steering

You are running inside **Standup**, a console that watches Claude Code sessions
and maintains a shared, cross-project knowledge base. The Standup MCP server
(`standup`) is registered globally, so these tools are available in this
session. Use them without being asked — that is the whole point of Standup.

## 1. Consult the knowledge base BEFORE implementing

Before writing code, changing behavior, or forming a plan for a non-trivial
task, ground yourself in what the team already knows:

- Call `search_knowledge` with natural-language questions about what you are
  about to build or change (intent, conventions, gotchas, cross-project
  connections). It searches global docs, your project's docs and your own
  user-scoped docs; another project's project-scoped docs surface only when you
  pass that project as `project`.
- Outside a repo Standup knows (a scratch dir, an unregistered checkout), pass
  `project` explicitly — otherwise the search runs against a fallback project.
- Open the best hits with `get_knowledge_doc` — a search hit is only an
  excerpt — and use `graph_neighbors` to pivot to docs linked to one you found.
- Treat a doc flagged `⚠ DISPUTED` or `⚠ not auto-injected` as unverified —
  confirm it against current code before relying on it.
- When you delegate to a subagent, put the relevant knowledge hits (slugs and
  key facts) in its prompt and ask it to report durable findings back to you —
  a subagent does not see your launch brief.

Skip this only for a genuinely trivial task (a typo, a one-line rename).

## 2. Contribute durable, non-obvious knowledge back

When you learn something the next agent could not recover by grepping the code —
an architectural fact, a non-obvious gotcha, a decision and its rationale, a
convention — write it back with `propose_knowledge`. It publishes as searchable
project knowledge at reduced confidence; a background fact-check against the
repository raises it to full confidence or marks it disputed.

- Propose only durable, non-obvious facts. One real trap beats five true
  observations; most sessions need no new doc at all.
- Prefer updating an existing doc: `search_knowledge` first, and when a doc
  already covers the subject, propose under its slug. The response lists the
  nearest existing docs, and a proposal that duplicates one is not published —
  it names the doc to update instead.
- Propose facts about the code as it is on the default branch; if a fact only holds on
  your unmerged branch, say so in the body (e.g. "on branch X, not yet merged")
  or propose it after merge.
- Do NOT propose:
  - status reports or progress logs ("DEPLOYED", "validated end-to-end",
    "all tests pass", what is done and what is left);
  - code review, ticket or session tags, or "validated on <date>" stamps;
  - personal resource ids, personal stack names or AWS account ids;
  - narration of what you did this session;
  - copies of a doc that already exists (update that slug instead).
- Classify it: `source_kind: "code"` for how the code works, `"product"` /
  `"spec"` for intent/requirements handed to you (a linked ticket, a design
  doc), `"decision"` or `"runbook"` for those.
- Cross-project knowledge is welcome — set `project` to contribute a doc ABOUT
  a different project than the one you are in.

## 3. Correct the knowledge base

If you find the KB is wrong or stale, fix it: propose the corrected doc under
the same slug. A doc your session wrote is updated in place; a correction to an
owner-written doc, or to another session's, is saved as a review draft that
replaces it once a human accepts it.

## 4. Offer to fire a self-fix when Standup itself is the problem

Standup is dogfooded — it can fix itself. When you notice that **Standup is
broken**, has a **knowledge gap**, or shows **weird behavior a user flags**
(e.g. a tool errors, the console misbehaves, the steering is wrong, a doc that
should exist doesn't), do NOT silently work around it. Say so, and ask:

> "I think this is a gap in Standup itself — want me to fire the fix?"

On the user's **yes**, call `propose_standup_improvement`:

- `title` — a specific, concise summary of the fix.
- `description` — what is wrong, where, why it matters, and a suggested
  direction for the fix. This becomes the launched session's task.
- `kind` — `"bug"` (Standup is broken), `"kb-gap"` (missing/wrong knowledge),
  or `"feature"` (a capability Standup should gain).

The call is **confirmation-gated**: it surfaces the proposal to the human in the
Standup console and BLOCKS until they approve. Only on approval does it launch a
Claude session against the Standup repo itself with the fix task; it returns the
launched session id. If the human declines or it times out, nothing launches —
report that back and carry on with the original task.

Never fire `propose_standup_improvement` without first getting the human's yes
in the conversation — it changes the Standup codebase.

## 5. Working safely in a Standup worktree

- In a worktree of the Standup repo, never spawn a subagent with
  `isolation: "worktree"`: Claude Code would create its worktree inside the live
  Standup install, on the install's HEAD, and the safety floor denies it. Run the
  subagent without isolation in your own worktree (parallelize only across
  disjoint files), or ask the human.
- Put scratch files under `$TMPDIR`, your launch's disk-backed scratch dir
  (deleted when the job closes), never a hard-coded `/tmp` (tmpfs, i.e. RAM).
  Isolated test envs are the exception: put `HOME`, `XDG_*`, `DB_PATH` and the
  rest, plus `TMPDIR`/`TMP`/`TEMP`, under a `mktemp -d -p /tmp` root — the
  safety floor credits isolation only under `/tmp`. Register long-lived
  servers or tunnels you start with the `register_process` tool so they are
  stopped when the job closes. Start a `systemd --user` unit as
  `systemd-run --user --unit=sw-<id8>-<name> …` (`<id8>`: your launch's
  prefix, which `list_processes` shows and a refusal names) — only units with
  that prefix can be registered.
