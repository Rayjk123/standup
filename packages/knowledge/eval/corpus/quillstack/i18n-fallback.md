---
title: Locale fallback for pages and UI strings
source_kind: spec
origin_class: owner
generated_at: "2026-07-16T13:15:00Z"
verdict: contradicted
contradicts: [migrating-to-1-0]
tags: [quillstack, i18n, locales, fallback, translations]
---
# Locale fallback for pages and UI strings

A translated site has one content tree per locale: `content/en/`, `content/pt/`, `content/pt-BR/`. `default_locale` in
`quill.toml` names the source language, and `locales` lists the ones to build. Translations always lag the source, so
the build has to decide what a `pt-BR` reader sees for a page nobody has translated yet.

## Pages

For each page path in the default locale, and each locale being built, the CLI picks the first file that exists:

1. `content/<locale>/<path>` — `content/pt-BR/guide/install.md`
2. `content/<base language>/<path>` — `content/pt/guide/install.md`, when the locale has a region
3. `content/<default_locale>/<path>` — `content/en/guide/install.md`

A page served from step 2 or 3 is still written under the reader's locale (`/pt-BR/guide/install/`), so navigation and
the language switcher stay in that locale. It carries `<meta name="quill:fallback" content="<source locale>">`, and
the theme shows a banner ("This page is not yet available in your language"). Search indexes fallback pages under
their source locale, not the reader's, so the same text is not indexed twice.

A page that exists only in a translation and not in the default locale is built for that locale alone and reported by
`quill check i18n` as an orphan.

## UI strings

Labels such as "Next page" come from the theme's `i18n/<locale>.toml`, which a site can override in its own
`i18n/`. The lookup chain is the same as for pages: locale, base language, default locale. A key missing from all
three is rendered as the key itself, and logged.

## Strict mode

`quill build --strict-i18n` turns a UI string key missing from a locale's own file into an error. It does not fail on
missing pages: page fallback is expected and is what the banner is for. CI templates run strict mode on release
branches only.

## Dates and numbers

Formatted with the reader's locale, never the fallback's: a `pt-BR` reader of an English fallback page sees
`27/07/2026`.
