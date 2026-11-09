---
title: What Quillstack is and how its parts fit together
source_kind: product
origin_class: owner
generated_at: "2026-07-02T09:10:00Z"
tags: [quillstack, overview, cli, plugins, themes, preview]
---
# What Quillstack is and how its parts fit together

Quillstack is a static-site generator for documentation teams. A docs repository holds Markdown under `content/`, a
`quill.toml` at the root, and a theme reference; `quill build` turns it into a folder of HTML that any static host can
serve. The people it is built for write docs for a living and review them in pull requests, so most of the product is
about making a docs change easy to check before it ships.

## The pieces

| Piece | What it is | Where it lives |
|---|---|---|
| `quill` | The Go CLI: `build`, `serve`, `check links`, `migrate`, `theme` | `cmd/quill`, `internal/` |
| Plugin API | Out-of-process plugins that hook into the build | `pkg/pluginapi` |
| Themes | Versioned packages of templates, partials, styles and UI strings | the theme registry, pinned in `quill.lock` |
| Link checker | `quill check links`, internal and external links and anchors | `internal/linkcheck` |
| Quill Preview | The hosted service that builds every pull request and serves it at its own URL | a separate service repo |

## Who uses what

- **Writers** run `quill serve` locally, which rebuilds on save and shows broken internal links in the browser overlay.
- **Docs leads** own `quill.toml`, the theme pin and the link checker's ignore list.
- **Platform engineers** write plugins: an OpenAPI renderer, a glossary linker, a changelog importer.
- **Reviewers** mostly see Quill Preview: the bot comment on a pull request links the preview and lists the pages the
  change touched.

## Design principles

1. A build is reproducible from the repository alone: theme versions and plugin versions are pinned, and nothing is
   fetched at build time that is not in `quill.lock`.
2. A plugin cannot crash the CLI. Plugins run as child processes and the CLI owns the build.
3. A broken link is a build failure in CI, so the link checker has to be trustworthy; a check that cries wolf gets
   switched off.
4. Translations are first class. A page missing in one locale is served from a fallback, never a 404.

## Release cadence

Minor releases every six weeks, patch releases as needed. The CLI and the plugin API are versioned together; themes
version on their own.
