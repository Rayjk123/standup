---
title: "Permission denied from Bedrock when spawning claude in print mode"
source_kind: runbook
scope: global
origin_class: agent
confidence: 1
source_session_id: "sess-std-71e4"
generated_at: "2026-09-26T10:00:00Z"
tags: [claude, bedrock, auth, credentials]
---
# Permission denied from Bedrock when spawning claude in print mode

## What you see

Background jobs that start `claude` in print mode (the expert synthesizer, the contradiction judge) get a
permission-denied (403) response from the Bedrock runtime. Answers fall back to the raw retrieved text, and the judge
reports "no contradiction" for the whole batch.

## Why it happens

The child process authenticates with the **default profile**, and the default profile's **credentials had expired**.
Interactive shells look fine because they were refreshed recently; the long-running collector keeps launching
children against the stale default credentials.

## What to do

1. Refresh the default profile's credentials before the synthesizer launches (a credential refresh at collector start
   and on a timer every 45 minutes).
2. Make the judge **retry** a 403 once after refreshing, and record the run as errored rather than "no contradiction"
   if it still fails.
3. Check the result by asking ask_expert one question and confirming the answer is synthesized.
