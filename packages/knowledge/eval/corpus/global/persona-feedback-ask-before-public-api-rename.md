---
title: Ask before renaming a public API
source_kind: decision
scope: user
owner_user: owner
origin_class: owner
generated_at: "2026-07-22T15:05:00Z"
tags: [feedback, api, compatibility]
---
Renaming anything other people call — an exported function or type, a CLI flag, an HTTP route, a config
key, an event name — needs Rae's yes first, even when the new name is clearly better. Ask with the old
name, the new name and the callers you found, then wait.

Private helpers, local variables and test names can be renamed freely. When a rename is approved, keep the
old name as a deprecated alias for one release unless she says otherwise.
