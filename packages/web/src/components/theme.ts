/**
 * The console's color tokens, in two palettes: the dark one adapted from
 * MeshClaw's dashboard.pen design spec (cooler near-black grounds of its
 * `#12141a`/`#181b22`/`#262a35` family, a warm amber brand accent `#f59e32`,
 * zinc-toned text), and a light one that keeps each token's role with every
 * text token at WCAG AA (4.5:1) or better on every ground.
 *
 * Components read `theme.X`, which is a CSS variable reference
 * (`var(--su-X)`), so a theme switch is one attribute on <html>
 * (`data-theme`, see lib/themePreference.ts) and every inline style follows
 * without a re-render. `themeTokensCss()` writes the variables for both
 * palettes; it is injected into index.html ahead of first paint. A tint of a
 * token is `alpha(theme.X, 0x22)`, never a hex suffix on the variable.
 * Filled status/accent buttons keep `color: theme.ground`: the ground reads
 * on every status color in both palettes.
 *
 * Drawing surfaces that need a literal color (canvas, WebGL, an SVG drawn as
 * an image) read the active palette from `palettes[name]` instead
 * (`useThemeName` in hooks/useTheme.ts says which one is active).
 */

/** The two palettes the console can show. */
export type ThemeName = "dark" | "light";

const dark = {
  /** The <body> behind every view (index.html). */
  page: "#101520",
  pageText: "#E6EAF2",
  ground: "#12141a",
  hover: "#181b22",
  surface: "#1a1d25",
  raised: "#262a35",
  edge: "#2f3543",
  edgeSoft: "#20242f",
  text: "#e7e9ef",
  dim: "#8b90a0",
  faint: "#5b606e",
  running: "#4C9EF5",
  checkpoint: "#4fd39a",
  stalled: "#f59e0b",
  waiting: "#ff5c72",
  idle: "#454f63",
  done: "#4fd39a",
  expert: "#a78bfa",
  /** Warm amber brand accent (MeshClaw's `#f59e32`) — the wordmark + primary highlight. */
  accent: "#f59e32",
  /** A translucent amber wash for accent-tinted backgrounds/borders. */
  accentSoft: "#f59e3222",
  /** Drop shadows; sites pick their own strength with `alpha(theme.shadow, …)`. */
  shadow: "#000000",
  /** The dimming layer behind a modal or drawer, also at a site's own strength. */
  scrim: "#000000",
  /** Knowledge-graph node labels, and the gray a distrusted or unclustered node fades to. */
  graphLabel: "#c9ccd6",
  graphMuted: "#6b7080",
  /** The banner asking the owner to sign in. */
  noticeBg: "#7a4b00",
  noticeText: "#ffffff",
  /** Code (CodeMirror): One Dark's palette. */
  codeBg: "#282c34",
  codeGutter: "#21252b",
  codeLine: "#2c313a",
  codeSelection: "#3E4451",
  codeCursor: "#528bff",
  codeTooltip: "#353a42",
  codeText: "#abb2bf",
  codeComment: "#7d8799",
  codeKeyword: "#c678dd",
  codeName: "#e06c75",
  codeFunction: "#61afef",
  codeString: "#98c379",
  codeNumber: "#d19a66",
  codeType: "#e5c07b",
  codeOperator: "#56b6c2",
  codeInvalid: "#ffffff",
  /** Terminal rows: the stdout and stderr washes. */
  termOk: "rgba(95,220,164,0.08)",
  termErr: "rgba(255,107,132,0.08)",
};

export type ThemeToken = keyof typeof dark;

/** A palette: every token as a literal color. */
export type Palette = Readonly<Record<ThemeToken, string>>;

const light: Palette = {
  page: "#f5f6f8",
  pageText: "#181b22",
  ground: "#f5f6f8",
  hover: "#eceef2",
  surface: "#ffffff",
  raised: "#e7eaef",
  edge: "#cfd4dc",
  edgeSoft: "#e2e5eb",
  text: "#181b22",
  dim: "#4a5060",
  faint: "#626876",
  running: "#1652a4",
  checkpoint: "#0d613b",
  stalled: "#814500",
  waiting: "#9f1a32",
  idle: "#4e5562",
  done: "#0d613b",
  expert: "#6036be",
  accent: "#844200",
  accentSoft: "#84420022",
  // Half-transparent, so each site's dark-tuned strength lands at half on a light page.
  shadow: "rgba(27,34,51,0.5)",
  scrim: "#1b2233",
  graphLabel: "#4a5060",
  graphMuted: "#4e5562",
  noticeBg: "#ffe8c2",
  noticeText: "#5a3500",
  codeBg: "#fafafa",
  codeGutter: "#f0f1f3",
  codeLine: "#eef0f3",
  codeSelection: "#d7e3f8",
  codeCursor: "#2f5fd0",
  codeTooltip: "#f0f1f3",
  codeText: "#383a42",
  codeComment: "#62656f",
  codeKeyword: "#9a259a",
  codeName: "#c0392b",
  codeFunction: "#2a5bc7",
  codeString: "#3b7a32",
  codeNumber: "#965d00",
  codeType: "#8a5a00",
  codeOperator: "#0b6f8f",
  codeInvalid: "#c01f3c",
  termOk: "rgba(15,114,70,0.08)",
  termErr: "rgba(192,31,60,0.07)",
};

/** The literal palettes, for surfaces that can't take a CSS variable. */
export const palettes: Readonly<Record<ThemeName, Palette>> = { dark, light };

/**
 * Categorical hues for charts and graphs (projects, communities). The dark
 * set is bright for a near-black ground; the light set keeps the hue order,
 * darkened to read on white.
 */
export const categoricalColors: Readonly<Record<ThemeName, readonly string[]>> = {
  dark: [
    "#4C9EF5", "#4fd39a", "#a78bfa", "#f59e32", "#ff5c72", "#38bdf8", "#f472b6", "#facc15",
    "#2dd4bf", "#c084fc", "#fb923c", "#a3e635", "#e879f9", "#93c5fd", "#fca5a5", "#fde68a",
  ],
  light: [
    "#1a5fbf", "#0f7246", "#6a3bd1", "#9e4908", "#c01f3c", "#0369a1", "#be185d", "#8e5606",
    "#0f766e", "#9333ea", "#c2410c", "#4d7c0f", "#a21caf", "#3b6fd4", "#b91c1c", "#854d0e",
  ],
};

/** The CSS variable a token is stored in: `edgeSoft` → `--su-edge-soft`. */
export function tokenVar(token: ThemeToken): string {
  return `--su-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

const tokens = Object.fromEntries(
  (Object.keys(dark) as ThemeToken[]).map((k) => [k, `var(${tokenVar(k)})`]),
) as Record<ThemeToken, string>;

/** The variable holding the active palette's name, as a `color-scheme` value. */
const SCHEME_VAR = "--su-color-scheme";

export const theme = {
  ...tokens,
  /** `dark` or `light`, following the palette: for a native control's `colorScheme`. */
  colorScheme: `var(${SCHEME_VAR})`,
  /** Default sidebar width — MeshClaw's ~220px framed nav column. */
  sidebarWidth: 220,
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace",
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

/**
 * `color` at `opacity` — a fraction (0.35; anything up to 1) or a byte (0x22,
 * the `#rrggbbaa` suffix it stands in for; above 1). Works on a token's
 * variable, which a hex suffix can't.
 */
export function alpha(color: string, opacity: number): string {
  const fraction = opacity > 1 ? opacity / 255 : opacity;
  const pct = Math.round(fraction * 1000) / 10;
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/** A literal `#rrggbb` color at `opacity` (as in `alpha`), for canvas and WebGL. */
export function hexAlpha(hex: string, opacity: number): string {
  const byte = Math.max(0, Math.min(255, Math.round(opacity > 1 ? opacity : opacity * 255)));
  return `${hex.slice(0, 7)}${byte.toString(16).padStart(2, "0")}`;
}

/** The id of the <style> element holding `themeTokensCss()`. */
export const THEME_TOKENS_STYLE_ID = "standup-theme-tokens";

/**
 * Adds the token <style> to the page unless index.html already carries it
 * (a page served without the theme-html plugin, or a test document).
 */
export function ensureThemeTokens(doc: Document = document): void {
  if (doc.getElementById(THEME_TOKENS_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = THEME_TOKENS_STYLE_ID;
  style.textContent = themeTokensCss();
  doc.head.prepend(style);
}

function declarations(p: Palette): string {
  return (Object.keys(p) as ThemeToken[]).map((k) => `${tokenVar(k)}:${p[k]};`).join("");
}

/**
 * Both palettes as CSS: dark on `:root` (and `[data-theme="dark"]`), light
 * under `[data-theme="light"]`. The page itself keeps the browser's default
 * `color-scheme`, so native controls look as they always have; a control
 * that wants the scheme matching the palette sets `colorScheme:
 * theme.colorScheme`.
 */
export function themeTokensCss(): string {
  return (
    `:root,:root[data-theme="dark"]{${SCHEME_VAR}:dark;${declarations(dark)}}` +
    `:root[data-theme="light"]{${SCHEME_VAR}:light;${declarations(light)}}`
  );
}

export const statusColors = {
  running: theme.running,
  idle: theme.idle,
  waiting: theme.waiting,
  stalled: theme.stalled,
  done: theme.done,
} as const;
