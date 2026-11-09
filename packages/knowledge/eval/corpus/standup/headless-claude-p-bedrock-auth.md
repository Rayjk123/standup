---
title: "Headless claude -p Bedrock auth 403"
source_kind: runbook
scope: global
origin_class: agent
confidence: 1
source_session_id: "sess-std-33d0"
generated_at: "2026-09-11T10:00:00Z"
tags: [claude, bedrock, auth, 403, headless]
---
# Headless claude -p Bedrock auth 403

## Symptom

The ask_expert synthesizer and the coherence judge spawn `claude -p` headlessly. Those runs fail with **HTTP 403**
from Bedrock while the same command works in an interactive terminal.

## Cause

The spawned subprocess does **not inherit the AWS profile** selected in the shell that started the collector. The
collector runs as a service, so the child process sees no `AWS_PROFILE` and no Bedrock flag; it picks up whatever
default credentials exist (often none valid for Bedrock), and Bedrock answers 403.

## Fix

Pass the environment explicitly in `runClaudeHeadless()` (`src/synth/claude-headless.ts`):

```ts
spawn("claude", ["-p", prompt, "--model", model], {
  env: { ...process.env, AWS_PROFILE: config.awsProfile, CLAUDE_CODE_USE_BEDROCK: "1" },
});
```

Set `awsProfile` in the collector config. After the change, restart the collector and run one ask_expert question to
confirm a synthesized answer instead of the raw-dump fallback.
