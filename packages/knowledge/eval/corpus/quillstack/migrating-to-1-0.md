---
title: Migrating a site from Quillstack 0.9 to 1.0
source_kind: runbook
origin_class: owner
generated_at: "2026-07-24T10:05:00Z"
verdict: contradicted
contradicts: [i18n-fallback]
tags: [quillstack, migration, upgrade, plugins, i18n, config]
---
# Migrating a site from Quillstack 0.9 to 1.0

1.0 is the first release with a compatibility promise, and it removes the things that made one impossible. Most sites
migrate in an afternoon. Work on a branch; Quill Preview will build it like any other pull request.

## 1. Convert the configuration

`site.yaml` is replaced by `quill.toml`.

```
quill migrate config        # writes quill.toml next to site.yaml and prints what it could not map
```

Keys it cannot map are printed, not dropped silently. The usual one is `theme_dir`, which no longer exists: themes come
from the registry and are pinned in `quill.lock`. Delete `site.yaml` once the build passes.

## 2. Replace in-process plugins

0.9 loaded plugins as Go shared objects (`.so`) through the standard library's `plugin` package. They had to be built
with the exact Go version and flags of the CLI, which is why every CLI release broke someone. 1.0 removes this loader.
Plugins now run as child processes under plugin API 2.

- Plugins from the official set have API 2 releases; bump them in `quill.toml` and run `quill lock`.
- An in-house plugin needs its entry point rewritten against `pkg/pluginapi`. The old `BeforePage` and `AfterPage`
  callbacks map to the `transform` and `render` hooks.

## 3. Update templates

Template functions moved from the `.Site` object to a `site` function: `{{ .Site.BaseURL }}` is now
`{{ site.base_url }}`. `quill migrate templates --check` lists every occurrence; `--write` rewrites them in place.

## 4. Locales

1.0 simplifies locale fallback. A regional locale no longer falls back to its base language: a page missing from
`content/pt-BR/` is served from the default locale directly, even when `content/pt/` has it. Teams that relied on the
base-language step should copy those pages into the regional tree, or drop the regional locale and build `pt` only.

## 5. Check and ship

- `quill check links` and `quill check i18n` must both pass.
- Compare the 0.9 and 1.0 builds with `quill diff-build old/ new/`; only template whitespace should differ.
