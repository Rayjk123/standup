import { useCallback, useSyncExternalStore } from "react";
import type { ThemeName } from "../components/theme";
import {
  appliedTheme,
  applyTheme,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  watchSystemTheme,
  writeThemePreference,
  type ThemePreference,
} from "../lib/themePreference";

/*
 * The theme as React state: one store per page shared by every hook caller,
 * so the You tab's control and any drawing surface that needs literal colors
 * (useThemeName) see a switch on the same render. While the page is open it
 * keeps a System pick tracking the OS, and follows a pick made in another tab.
 */

let preference: ThemePreference | null = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function current(): ThemePreference {
  if (preference === null) preference = readThemePreference();
  return preference;
}

function notify(): void {
  for (const l of listeners) l();
}

function onSystemChange(): void {
  if (current() !== "system") return;
  applyTheme(resolveTheme("system"));
  notify();
}

/** Another tab of this console stored a new pick: show it here too. */
function onStorage(e: StorageEvent): void {
  if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
  preference = readThemePreference();
  applyTheme(resolveTheme(preference));
  notify();
}

function startWatching(): void {
  if (stopWatching) return;
  const stopSystem = watchSystemTheme(onSystemChange);
  window.addEventListener("storage", onStorage);
  stopWatching = () => {
    stopSystem();
    window.removeEventListener("storage", onStorage);
  };
}

/*
 * The OS and storage watch lasts as long as the page, not as long as its
 * subscribers: no always-mounted component reads the theme, and the page
 * must keep following the OS after the last one that does unmounts.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startWatching();
  return () => {
    listeners.delete(listener);
  };
}

/** Picks, stores and applies `pref` at once. */
export function setThemePreference(pref: ThemePreference): void {
  preference = pref;
  writeThemePreference(pref);
  applyTheme(resolveTheme(pref));
  notify();
}

/**
 * Applies the stored pick (the boot script in index.html normally already
 * has) and starts following the OS for a System pick, before React renders.
 */
export function initTheme(): void {
  applyTheme(resolveTheme(current()));
  startWatching();
}

/** Forgets the cached pick and stops watching, as a fresh page load would start. */
export function resetThemeStore(): void {
  preference = null;
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
}

/** The viewer's pick and a setter that applies it instantly. */
export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, current, () => "system" as ThemePreference);
  return [pref, useCallback((p: ThemePreference) => setThemePreference(p), [])];
}

/** The palette on screen, for surfaces that draw with literal colors. */
export function useThemeName(): ThemeName {
  return useSyncExternalStore(subscribe, appliedTheme, () => "dark" as ThemeName);
}
