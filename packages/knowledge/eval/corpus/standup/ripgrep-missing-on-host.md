---
title: "ripgrep missing on the host"
source_kind: runbook
origin_class: agent
confidence: 1
source_session_id: "sess-std-95d7"
generated_at: "2026-10-04T10:00:00Z"
tags: [ripgrep, ask_expert, code-search]
---
# ripgrep missing on the host

## Symptom

The `ripgrep` MCP tool returns **500** with `Executable not found in $PATH: "rg"`. ask_expert answers say the context
"does not include code passages" for code questions.

## Cause

`runRipgrep()` in `src/expert/ripgrep.ts` spawns the bare binary name `rg` (`RG_BINARY = "rg"`). When ripgrep isn't
installed, or isn't on the collector service's PATH, the spawn throws. askExpert catches the error and logs it, so its
code arm **fails silently** and answers come from docs only.

## Fix

- Install ripgrep on the host and make sure the collector service's PATH includes it, or
- fall back to `git grep -n` when `rg` is missing, and
- report `codeSearch: unavailable` in the answer and in the health endpoint instead of failing silently.
