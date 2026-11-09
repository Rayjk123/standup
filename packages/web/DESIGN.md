---
name: Standup console
description: A dense, calm operations console, dark by default with a light theme, for supervising a fleet of agent sessions.
colors:
  ground: "#12141a"
  hover: "#181b22"
  surface: "#1a1d25"
  raised: "#262a35"
  edge: "#2f3543"
  edge-soft: "#20242f"
  text: "#e7e9ef"
  dim: "#8b90a0"
  faint: "#5b606e"
  accent: "#f59e32"
  accent-soft: "#f59e3222"
  running: "#4C9EF5"
  checkpoint: "#4fd39a"
  done: "#4fd39a"
  stalled: "#f59e0b"
  waiting: "#ff5c72"
  idle: "#454f63"
  expert: "#a78bfa"
typography:
  page-title:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
  hero:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  body:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  row:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
  meta:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
  section-label:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.4px"
  field-label:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
  mono-eyebrow:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "9.5px"
    fontWeight: 600
    letterSpacing: "0.14em"
  mono-chip:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "9px"
    fontWeight: 600
    letterSpacing: "0.08em"
  wordmark:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "0.2em"
rounded:
  chip: "3px"
  control-sm: "5px"
  control: "6px"
  popover: "8px"
  badge: "8px"
  card: "10px"
  pill: "999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "24": "24px"
components:
  button-primary:
    backgroundColor: "{colors.running}"
    textColor: "{colors.ground}"
    rounded: "{rounded.control}"
    padding: "6px 14px"
  button-confirm:
    backgroundColor: "{colors.checkpoint}"
    textColor: "{colors.ground}"
    rounded: "{rounded.control}"
    padding: "6px 14px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.dim}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.running}"
    padding: "0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  nav-tab:
    backgroundColor: "transparent"
    textColor: "{colors.faint}"
    typography: "{typography.row}"
    rounded: "{rounded.control-sm}"
    padding: "5px 12px"
  nav-tab-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.row}"
    rounded: "{rounded.control-sm}"
    padding: "5px 12px"
  count-badge:
    backgroundColor: "{colors.waiting}"
    textColor: "{colors.ground}"
    rounded: "{rounded.badge}"
    padding: "0 5px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    padding: "10px 14px"
  settings-card:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.popover}"
    padding: "14px 14px 12px"
  chip-mono:
    backgroundColor: "transparent"
    typography: "{typography.mono-chip}"
    rounded: "{rounded.chip}"
    padding: "1px 5px"
---

# Design System: Standup console

## Overview

**Creative North Star: "The Quiet Control Room"**

The console is a night-shift control room for one operator watching many machines. The room is dark, cool and still; nothing moves or glows unless it needs the operator. Information is packed tight in small type and monospace detail, but layered surfaces, thin hairline borders and a narrow palette keep the density calm instead of noisy. Color is a signal system, not decoration: blue means running or "act here", green means done, rose-red means a human is needed, amber is the brand and the highlight.

The look is adapted from MeshClaw's dashboard (dark, dense, framed) and translated into a React `theme` object (`src/components/theme.ts`) read by inline styles. It is an operate surface: scanability, consistency and the phone-in-hand check-in outrank expression. Brand lives only in the amber mono wordmark and amber section icons.

**Key Characteristics:**
- Cool near-black grounds in four tonal steps, separated by 1px hairlines rather than shadows.
- Small type (mostly 10.5–13px): 400 for copy, 600 and 700 for hierarchy, with heavy use of monospace for ids, labels and data.
- Uppercase, letter-spaced micro-labels as the section grammar.
- Status colors carry meaning; everything else is neutral.
- One breakpoint (760px): on a phone the top bar wraps and tabs become a sideways-scrolling row.

## Colors

A cool, desaturated night palette with one warm brand accent and a small set of saturated status signals.

### Primary
- **Signal Blue** (`running`): the "go" color. Running state, primary buttons, link buttons and active affordances. It is the action color, not the brand.

### Secondary
- **Ember Amber** (`accent`): the brand. The wordmark, section-header icons, checkbox accents, notices (`accentSoft` wash with an amber border) and a few highlight buttons (Schedules). Use sparingly.

### Tertiary (status signals)
- **Waiting Rose** (`waiting`): a human is needed. Count badges, waiting status, failed jobs. Its rarity is the point.
- **Checkpoint Mint** (`checkpoint`, `done`): progress made and work finished; also the confirm button.
- **Stall Amber** (`stalled`): stalled runs and the "needs you" job state.
- **Expert Violet** (`expert`): expert-consult tags and messages.
- **Idle Slate** (`idle`): idle sessions.

### Neutral
- **Ground** (`ground`): the view background and the inside of settings cards. The `body` rule in `index.html` paints `page`/`pageText` (in dark a slightly bluer `#101520` with `#E6EAF2` text), which shows before the app mounts and behind any gap; in dark it is out of step with `ground`/`text`.
- **Hover** (`hover`): row hover wash.
- **Surface** (`surface`): the top bar, cards, drawers, popovers and input fills.
- **Raised** (`raised`): the active nav tab and raised chips.
- **Edge** (`edge`): the standard 1px border on cards, controls and popovers.
- **Soft Edge** (`edgeSoft`): dividers inside cards and between list rows.
- **Text / Dim / Faint** (`text`, `dim`, `faint`): primary copy, secondary copy and meta, labels and inactive tabs.

Frontmatter keys are kebab-case (`edge-soft`, `accent-soft`); in code they are the camelCase `theme.edgeSoft` and `theme.accentSoft`.

Tinted states use the status color itself through `alpha()`: `alpha(color, 0x1f)` for a pill fill, `alpha(color, 0x44)` (or `0x33`/`0x55`/`0x66`) for a tinted border. Never append a hex suffix (`${color}1F`): `theme.X` is a CSS variable, so the suffix makes invalid CSS that the browser silently drops. A test in `theme.test.ts` fails on any such suffix.

The knowledge graph and project legend use the categorical hues in `categoricalColors`, and the terminal view uses faint mint/rose line washes (`termOk`, `termErr`). These are data-visualization exceptions, not system colors.

### Light and dark
Every token has a value in two palettes (`palettes.dark`, `palettes.light` in `theme.ts`). `theme.X` reads `var(--su-x)`, and `data-theme` on `<html>` picks the palette, so a switch restyles every inline style at once. The viewer picks Light, Dark or System on the You tab (Appearance); System follows `prefers-color-scheme`. The pick is kept in this browser (`localStorage["standup.theme"]`), and an inline script in `<head>` applies it before first paint.

- The dark palette is the one in this file's frontmatter. The light palette keeps each token's role, with every text and status token at 4.5:1 or better on every ground, and on its own `0x1f`–`0x33` wash.
- Filled status buttons use `color: theme.ground`, which reads on every status fill in both palettes.
- Canvas, WebGL and SVG drawn as an image can't resolve a CSS variable. They draw with `palettes[useThemeName()]` (or `categoricalColors[name]`) and redraw when the theme switches.
- Surfaces that stay dark in both themes (the media lightbox, overlays on video, the Burrow art) take their text colors from `palettes.dark`, not `theme`.

### Named Rules
**The Signal-Only Rule.** Saturated color appears only when it means a state: running, done, waiting, stalled, expert. A neutral element never borrows a status color for decoration.

**The Rare Rose Rule.** `waiting` rose is reserved for "a human is needed". If a screen shows rose, the owner has something to do there.

## Typography

**Body Font:** Inter, named first in the stack (with -apple-system, Segoe UI, system-ui fallbacks)
**Mono Font:** ui-monospace stack (SF Mono, JetBrains Mono, Cascadia Code, Menlo)

**Character:** A neutral grotesque for copy and a system monospace for anything machine-shaped: ids, labels, chips, the wordmark. Mono is the more common family in the code; it gives the console its operator-terminal flavor. Inter is named but no font file is loaded, so it renders only where Inter is installed locally; elsewhere the platform UI font takes over.

### Hierarchy
- **Hero** (700, 20–22px): empty-state headings and hero numbers.
- **Page title** (700, 15–17px, most often 17px): a view's `h2`; the review detail title runs larger (20–21px).
- **Body** (400, 13px, line-height 1.5): message and doc copy.
- **Row** (600, 12.5px): dense list rows and nav tabs.
- **Meta** (400, 11–11.5px, `dim` or `faint`): timestamps, counts, secondary facts.
- **Section label** (700, 11px, uppercase, 0.4px tracking, `dim`): card and section headers.
- **Field label** (600, 10.5px, uppercase, 0.06em, `faint`): form labels.
- **Mono eyebrow** (600, 9.5px, uppercase, 0.14em, `faint`): settings eyebrows.
- **Wordmark** (mono 700, 12px, uppercase, 0.2em, `accent`): "STANDUP" in the top bar.

### Named Rules
**The Two-Weight Rule.** Copy is 400; hierarchy comes from size, case and color at 600 and 700. The few 500 and 650 uses (reply composer, review detail, knowledge view) are drift; don't add more weights.

**The Mono-for-Machines Rule.** Ids, slugs, branch names, stage names and chips are set in mono; human sentences are not.

## Layout

The app is a full-height top bar over a single view. The top bar (`Console.tsx`) sits on `surface` with an `edge` bottom border and `11px 16px` padding. It holds the wordmark, live running/waiting/idle counts, the participant facepile, the tab row and the You button. Views that list and detail use a fixed list column about 280–300px wide (the code calls these the Work, jobs and feed sidebars) beside a fluid detail pane. The job drawer slides in from the right at `min(760px, 100vw)`; the Schedules run-history drawer at `min(520px, 96vw)`.

Spacing runs on a tight scale of 2, 4, 6, 8, 10, 12, 14, 16 and 24px. 8 and 6 are the workhorse gaps; 24 is page padding. Odd values (5, 7, 9) occur but are drift, not intent.

**Responsive:** one breakpoint, `max-width: 760px` (`hooks/useNarrow.ts`). Below it the top bar wraps, the tabs take their own full-width, horizontally scrolling row with the current tab scrolled into view, list/detail views stack, and some pickers become bottom sheets. `theme.sidebarWidth` (220) exists in the theme but no view reads it; the list columns serve as the sidebars.

### Named Rules
**The Phone-Is-Primary Rule.** Every decision path (answer an ask, approve a card, review a packet) must work at 760px and below. Desktop is the denser variant, not the only one.

## Elevation & Depth

Depth is tonal first: ground → surface → raised, separated by 1px `edge`/`edgeSoft` hairlines. Shadows appear only on things floating above the page, and they are dark, soft and neutral. There is no `backdrop-filter`, and the only colored shadow is the brief status ring below.

Shadows and scrims are `alpha(theme.shadow, a)` and `alpha(theme.scrim, a)`. The strengths below are the dark ones; the light `shadow` token is itself half-transparent, so the same call lands at half strength on a light page.

### Shadow Vocabulary
- **Popover** (`0 6px 24px`, shadow 0.35): command menu, tag pickers.
- **Banner** (`0 4px 16px`, shadow 0.4): connection and build-update banners.
- **Modal** (`0 18px 48px`, shadow 0.45): schedule modals over a 0.55 scrim.
- **Drawer** (`-12px 0 32px`, shadow 0.35): the right-hand job drawer over a 0.35 scrim.
- **Schedules drawer** (`-12px 0 36px`, shadow 0.4): the run-history drawer at `min(520px, 96vw)`.
- **Bottom sheet** (`0 -8px 28px`, shadow 0.4): phone pickers that rise from the bottom.
- **Decision bar** (`0 -6px 18px`, shadow 0.35): the docked review decision bar.
- **Selection ring** (`box-shadow: 0 0 0 2px <accent>`): a selected item.
- **Status ring** (`0 0 0 2px alpha(<status>, 0x33)`, or `3px`): a Board or pipeline card that just changed state, fading out over 600ms. This is the only colored shadow.

Drift outside this vocabulary: the knowledge view's heavier shadows (0x66, 0x88, 0xaa), the composer's `0 10px 30px` at 0.4, a `0 2px 8px` at 0.25 in the feed, and a `textShadow` on upload captions.

### Named Rules
**The Flat-at-Rest Rule.** Anything in the page flow is flat. A shadow means "this is floating above the page and will go away".

## Shapes

Small, consistent corners: 3px for chips and tags, 5–6px for buttons, tabs and inputs, 8px for popovers and settings cards, 10px for large state cards, and 999px for pills and status dots. Chat bubbles cut one corner to 3px to point at their sender. Borders are always 1px; an active list row gets a 2px left border in its status color.

## Components

There is no shared component library: each view defines its own style objects from `theme`. Keep new work on these shapes.

### Buttons
- **Shape:** gently rounded (6px; 5px for the small variant).
- **Primary:** Signal Blue fill with ground-colored 12px/700 text, `6px 14px`, no border.
- **Confirm:** the same shape in Checkpoint Mint, for approve and accept actions.
- **Secondary:** transparent with an `edge` border, 12px/600 `dim` text, `5px 12px`.
- **Link:** bare Signal Blue 11–12px/600 text with no padding, for inline actions.
- **Close:** an 18px "×" in a small bordered square.
- **Hover / Focus:** hover is a background or color shift (about 120ms ease), often JS-driven. There is no focus-visible ring today.

### Chips and badges
- **Mono chip:** 9px mono, uppercase, 0.08em, outlined, 3px radius (the `mono-chip` type role).
- **Tinted pill:** 10px/700 uppercase on the status color at `alpha(color, 0x1f)`, 4px radius.
- **Count badge:** 10.5px/700 ground text on Waiting Rose, min-width 16px, 8px radius, on the Persona, Review, Board and Docs tabs.
- **Status dot:** a 6–8px circle in the status color.

### Cards / Containers
- **State card:** `surface` fill, `edge` border, 10px radius; sections at `10px 14px` divided by `edgeSoft` top borders.
- **Settings card:** `ground` fill, `edgeSoft` border, 8px radius, `14px 14px 12px`.
- **Notice:** `accentSoft` fill with an amber border, 6px radius.

### Inputs / Fields
- **Style:** `surface` fill, `edge` border, 5–6px radius, 12–13px text, `5px 7px` to `8px 10px` padding. Checkboxes use the amber accent color.
- **Focus:** inputs set `outline: none` with no replacement (an accessibility gap to close, not a pattern to copy).

### Navigation
- **Top tabs:** 12.5px/600, `5px 12px`, 5px radius, capitalized. Inactive tabs are `faint` on transparent; the active tab is `text` on `raised`. Tabs needing the owner carry a rose count badge.
- **Mobile:** the tab row moves below the bar, spans full width and scrolls sideways.

### Skeleton
Loading placeholders pulse opacity 0.55↔1 over 1.4s (`standup-pulse`), flattened to a static 0.75 under `prefers-reduced-motion`. `standup-pulse` is the only keyframe set; the alert strip names an undefined `pulse` animation, so it does not animate.

## Do's and Don'ts

### Do:
- **Do** read every color, border and font from `theme` (`src/components/theme.ts`); add a token there rather than a hex literal in a component.
- **Do** separate surfaces with 1px `edge`/`edgeSoft` hairlines and tonal steps, not shadows.
- **Do** use Signal Blue for the primary action and Checkpoint Mint for approve/confirm.
- **Do** keep copy at 400 and labels/titles at 600/700 within the 10.5–13px working range; reserve 15px+ for page titles and empty states.
- **Do** check every new control at 760px and below.
- **Do** give new animation a `prefers-reduced-motion` fallback.

### Don't:
- **Don't** use a status color for decoration (The Signal-Only Rule).
- **Don't** show Waiting Rose unless the owner has something to do there.
- **Don't** add `backdrop-filter`, glows or colored shadows beyond the fading status ring.
- **Don't** add a third type family or new font weights.
- **Don't** copy `outline: none` without a visible focus replacement.
