---
title: "Decision: themes follow semver over their partials, CSS variables and UI strings"
source_kind: decision
origin_class: owner
generated_at: "2026-07-14T11:00:00Z"
tags: [quillstack, themes, semver, versioning, partials]
---
# Decision: themes follow semver over their partials, CSS variables and UI strings

## Problem

Sites override theme partials: a team copies `partials/footer.html` into its own `layouts/` and edits it. When the theme
renamed `footer.html` to `site-footer.html` in a minor release, every site with an override silently lost it, and the
theme's new footer appeared on pages that legal had signed off with the old one. Nothing failed, because an unused
override is not an error.

## What we decided

A theme's public surface is defined, and a change to it is versioned like an API:

- **Partials**: the names and the context each one receives. Removing or renaming a partial, or removing a field from
  its context, is a **major** change. Adding a partial is minor.
- **CSS custom properties** listed in the theme's `theme.toml` under `[public.css]`. Removing one or changing its unit
  is major; anything not listed is private and can change in any release.
- **UI string keys** in `i18n/<locale>.toml`. Removing a key is major, adding one is minor (a site's translations
  fall back for new keys; see the i18n fallback doc).
- **Front-matter keys** the theme reads (`hero`, `toc_depth`, `sidebar_order`). Same rules as partials.

## How it is enforced

- The theme registry runs `quill theme lint --against <previous version>` on publish and rejects a release whose
  version bump is smaller than its surface diff.
- `quill.lock` pins each theme to an exact version and its tarball sha256; `quill build` never resolves ranges.
- `quill theme upgrade` updates the pin and lists every local override whose partial changed or vanished between the
  two versions. `--dry-run` shows the list without touching the lock.
- An override of a partial the pinned theme does not have is now a build **warning**, and an error with
  `--strict-overrides`, which CI templates turn on.

## What we rejected

- **Date-based theme versions.** Easy to publish, impossible to reason about compatibility.
- **Forbidding overrides.** Teams need them; legal footers and cookie banners are always local.
