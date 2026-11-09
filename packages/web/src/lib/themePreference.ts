import type { ThemeName } from "../components/theme";

/*
 * Which palette the console shows. The viewer picks Light, Dark or System;
 * System follows the OS's `prefers-color-scheme`. The pick is a display
 * setting of this browser, so it lives in localStorage alongside the
 * console's other per-browser view settings, and applies as `data-theme` on
 * <html>, which selects the token palette (see components/theme.ts).
 *
 * THEME_BOOT_SCRIPT runs the same resolution inline in index.html before the
 * first paint, so a page never flashes the other palette while the bundle
 * loads.
 */

/** What the viewer picked. */
export type ThemePreference = "light" | "dark" | "system";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["light", "dark", "system"];

/** The localStorage key holding the pick. */
export const THEME_STORAGE_KEY = "standup.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** A stored value as a preference; anything unknown is System, the default. */
export function parseThemePreference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** The stored pick, or System when none is stored or storage is unavailable. */
export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Stores the pick; System clears the key so the default stays the default. */
export function writeThemePreference(pref: ThemePreference): void {
  try {
    if (pref === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* private mode: the pick holds for this page only */
  }
}

/**
 * The palette the OS asks for. An OS that states no preference (or a browser
 * without matchMedia) gets dark.
 */
export function systemTheme(): ThemeName {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches && !window.matchMedia(DARK_QUERY).matches ? "light" : "dark";
}

/** The palette a preference shows right now. */
export function resolveTheme(pref: ThemePreference): ThemeName {
  return pref === "system" ? systemTheme() : pref;
}

/** Shows `name` on the page. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
}

/** The palette the page is showing. */
export function appliedTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Calls `onChange` whenever the OS switches between light and dark; returns
 * the unsubscribe.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const queries = [window.matchMedia(DARK_QUERY), window.matchMedia(LIGHT_QUERY)];
  for (const q of queries) q.addEventListener?.("change", onChange);
  return () => {
    for (const q of queries) q.removeEventListener?.("change", onChange);
  };
}

/**
 * The inline <head> script that applies the stored pick before first paint:
 * readThemePreference + resolveTheme + applyTheme, in plain ES5.
 */
export const THEME_BOOT_SCRIPT =
  `(function(){var t;try{t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}` +
  `if(t!=="light"&&t!=="dark"){var m=window.matchMedia;` +
  `t=m&&m(${JSON.stringify(LIGHT_QUERY)}).matches&&!m(${JSON.stringify(DARK_QUERY)}).matches?"light":"dark"}` +
  `document.documentElement.setAttribute("data-theme",t)})();`;
