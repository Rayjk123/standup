---
title: Session sidebar UI spec
source_kind: spec
generated_at: "2026-09-18T10:00:00Z"
tags: [console, ui, sidebar, css]
---
# Session sidebar UI spec

The session sidebar is the console's left rail. It lists every session the collector knows about.

## Layout

- Sessions are grouped by project; each group header shows the project name and a count badge.
- Within a group, sessions sort by last activity, newest first.
- Each row: status dot, title, relative time ("4m"), and a model chip.
- Long titles truncate with an ellipsis at 2 lines (`display: -webkit-box; -webkit-line-clamp: 2;
  overflow: hidden`). Never wrap to a third line; the full title shows in a tooltip.
- Width 280 px, resizable between 220 and 420 px; the width persists in local storage.

## Status dot colors

| State | Token | Light | Dark |
|---|---|---|---|
| running | `--status-running` | green 600 | green 400 |
| waiting for input | `--status-waiting` | amber 500 | amber 300 |
| stalled (no heartbeat) | `--status-stalled` | red 600 | red 400 |
| ended | `--status-ended` | gray 400 | gray 600 |

## Styling

- CSS lives in `console/src/styles/sidebar.css`; use the design tokens from `tokens.css`, never raw hex values.
- Dark mode uses the same tokens under `[data-theme="dark"]`.
- Selected row: `--surface-selected` background and a 2 px left accent border.

## Keyboard

- `j` / `k` move the selection down / up; `Enter` opens the session; `/` focuses the filter box.
- Focus ring must be visible in both themes.

## Acceptance

- 500 sessions render without jank (virtualized list).
- Truncation holds for titles with no spaces (break-word).
