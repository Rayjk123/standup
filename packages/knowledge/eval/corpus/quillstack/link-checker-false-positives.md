---
title: Link checker false positives and how to silence them properly
source_kind: runbook
origin_class: owner
generated_at: "2026-07-21T16:40:00Z"
tags: [quillstack, link-checker, false-positives, links-ignore, ci]
---
# Link checker false positives and how to silence them properly

`quill check links` runs after a build. Internal links and anchors are checked against the output directory; external
links are requested over the network with a shared cache in `.quill/linkcache.json` (24 h for a success, 1 h for a
failure). A failure exits non-zero, which fails CI. Most reports are real. The ones below are not.

## Symptom: an external host returns 429 or 403 in CI and 200 in a browser

Code hosts and some vendor docs rate-limit or block datacenter IP ranges.

- 429 responses are retried three times with the `Retry-After` the host sends, then reported as **warnings**, not
  errors. If you see a 429 as an error, the site is on a CLI older than 1.2.
- 403 is an error, because it is also what an expired private link returns. If the host is known to block CI, add it
  to `links.ignore` with a reason.

## Symptom: "method not allowed" on a page that opens fine

Some servers reject `HEAD`. The checker falls back to `GET` on 405 and 501 only. A server that answers `HEAD` with 404
(seen on a few object stores) needs `[linkcheck] get_only_hosts = ["host"]` in `quill.toml`.

## Symptom: `#anchor` not found, but the anchor works in the browser

The anchor is created by JavaScript: tab widgets, collapsible API sections, client-rendered headings. The checker reads
static HTML and cannot see it. Fix it at the source: the theme's tab partial emits `data-quill-anchor="<id>"` on each
tab, and the checker accepts those. A custom widget can do the same. Do not ignore the whole page.

## Symptom: links to the preview host or `localhost` fail

Links to `*.preview.quillstack.example` or `localhost` are almost always a copy-paste from a preview. They are reported
as errors on purpose; replace them with a relative link.

## Silencing a real false positive

Add a line to `links.ignore` at the repository root:

```
# Vendor portal blocks datacenter ranges; checked by hand 2026-07.
https://portal.vendor.example/**
```

- Entries are globs over the full URL. Every entry must have a `#` comment on the line above it; the checker rejects an
  uncommented entry.
- `quill check links --report-ignored` lists every ignored URL that the build still contains, so stale entries can be
  removed.
- There is no command-line flag that skips URLs; an ignore that lives only in a CI script is invisible to writers.
