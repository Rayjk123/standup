---
title: Plugin lifecycle in plugin API 2
source_kind: spec
origin_class: owner
generated_at: "2026-07-09T14:25:00Z"
tags: [quillstack, plugins, lifecycle, pluginapi, rpc]
---
# Plugin lifecycle in plugin API 2

A Quillstack plugin is an executable the CLI starts as a child process. They talk JSON-RPC over the plugin's stdin and
stdout; stderr goes to the build log, prefixed with the plugin's name. The Go SDK in `pkg/pluginapi` hides the wire
format, but any language that can read and write lines of JSON can implement a plugin.

## Declaring a plugin

A plugin ships a `quill-plugin.toml` next to its binary:

```toml
name = "openapi-pages"
plugin_api = 2
hooks = ["configure", "transform", "postbuild"]
optional = false
```

A site enables it in `quill.toml` under `[[plugins]]`, and `quill.lock` records the plugin's version and the sha256 of
its binary. The CLI refuses to start a plugin whose hash does not match the lock.

## The hooks, in order

1. **configure** — called once, with the plugin's own table from `quill.toml`. The plugin validates it and returns
   errors as structured diagnostics; any error stops the build before a single page is read.
2. **discover** — called once with the list of content files. A plugin may add virtual pages here (the OpenAPI plugin
   adds one page per operation). Pages added after this hook are not linked into navigation.
3. **transform** — called per page with its parsed front matter and Markdown AST. This is the only hook that runs in
   parallel: the CLI sends up to `GOMAXPROCS` pages at once, so a plugin must not keep per-page state between calls.
4. **render** — called per page after templates run, with the HTML. Use it sparingly; rewriting HTML is slow.
5. **postbuild** — called once with the output directory. Search indexes and sitemaps are written here.

A plugin only receives the hooks it lists. The CLI sends `shutdown` after `postbuild`, or on the first fatal error.

## Timeouts and failures

| Situation | What the CLI does |
|---|---|
| A hook takes longer than 30 s (`hook_timeout` per plugin) | Kills the process and fails the build |
| The plugin exits mid-build | Fails the build, unless `optional = true`, which logs a warning and skips the plugin's remaining hooks |
| A `transform` call returns an error for one page | Fails the build and names the page |
| The plugin writes non-JSON to stdout | Treated as a protocol error; write logs to stderr |

## Caching

`transform` results are cached in `.quill/cache/` keyed by the page's content hash, the plugin's binary hash and its
configuration table. A plugin that reads anything else (an external API, a file outside `content/`) must declare
`cache = false` in its manifest, or its stale output will be reused.
