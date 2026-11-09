---
title: "Slack native streaming for the mirror"
source_kind: decision
origin_class: owner
generated_at: "2026-09-17T10:00:00Z"
tags: [slack, streaming, mirror]
---
# Slack native streaming for the mirror

## Decision

The Slack mirror renders a session turn with Slack's native streaming API: `chat.startStream` opens a streamed
message in the thread, `appendStream` adds text as the assistant produces it, and tool calls render as
`task_update` cards with a title, status (in progress / complete / error) and a collapsed details field holding the
tool output.

## Why

Posting and editing a message every second hit rate limits and flickered. Native streaming gives a smooth render and
lets tool output collapse instead of flooding the thread.

## Fidelity rules

- Assistant text streams as-is; markdown is converted to Slack mrkdwn.
- Tool output is truncated to 3,000 characters in the card details, with a link to the console for the rest.
- A turn that ends with an error closes the stream with an error card.
