import type { KeyboardEvent } from "react";
import { LuMonitor, LuMoon, LuSun } from "react-icons/lu";
import { theme } from "./theme";
import { useThemeName, useThemePreference } from "../hooks/useTheme";
import { THEME_PREFERENCES, type ThemePreference } from "../lib/themePreference";

const OPTIONS: Record<ThemePreference, { label: string; icon: typeof LuSun }> = {
  light: { label: "Light", icon: LuSun },
  dark: { label: "Dark", icon: LuMoon },
  system: { label: "System", icon: LuMonitor },
};

/**
 * The Light / Dark / System switch: a radio group that applies a pick the
 * moment it is made and keeps it in this browser. System follows the OS
 * setting, live.
 */
export function ThemeControl() {
  const [pref, setPref] = useThemePreference();

  // Arrow keys move the pick along the group (wrapping), Home and End jump to
  // its ends, as in a native radio group.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = THEME_PREFERENCES.length;
    const i = THEME_PREFERENCES.indexOf(pref);
    const target =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1;
    if (target < 0) return;
    e.preventDefault();
    const next = THEME_PREFERENCES[target];
    setPref(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-theme-option="${next}"]`)?.focus();
  };

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Color theme"
        onKeyDown={onKeyDown}
        style={{
          display: "inline-flex", gap: 2, padding: 3, borderRadius: 8,
          background: theme.ground, border: `1px solid ${theme.edge}`,
        }}
      >
        {THEME_PREFERENCES.map((p) => {
          const { label, icon: Icon } = OPTIONS[p];
          const on = p === pref;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-theme-option={p}
              onClick={() => setPref(p)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                fontSize: 12.5, fontWeight: 600, fontFamily: theme.sans,
                color: on ? theme.accent : theme.dim,
                background: on ? theme.accentSoft : "transparent",
                border: `1px solid ${on ? theme.accent : "transparent"}`,
              }}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>
      <p style={{ fontSize: 11.5, color: theme.dim, marginTop: 8, lineHeight: 1.5 }}>
        System follows your operating system's light or dark setting. Saved in this browser.
      </p>
    </div>
  );
}

/** The pick after `pref` in the Light → Dark → System order, wrapping. */
export function nextThemePreference(pref: ThemePreference): ThemePreference {
  return THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(pref) + 1) % THEME_PREFERENCES.length];
}

/**
 * The top bar's quick theme switch: one button showing the current pick's
 * icon that steps to the next pick (Light → Dark → System) on each press. It
 * shares the pick with ThemeControl, so either one moves both.
 */
export function ThemeToggle() {
  const [pref, setPref] = useThemePreference();
  const shown = useThemeName();
  const { label, icon: Icon } = OPTIONS[pref];
  const next = OPTIONS[nextThemePreference(pref)].label;
  const current = pref === "system" ? `${label} (${OPTIONS[shown].label.toLowerCase()})` : label;
  return (
    <button
      type="button"
      onClick={() => setPref(nextThemePreference(pref))}
      aria-label={`Color theme: ${current}. Switch to ${next}`}
      title={`Theme: ${current} — click for ${next}`}
      data-theme-toggle={pref}
      style={{
        marginLeft: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: 28,
        height: 28,
        padding: 0,
        borderRadius: 5,
        border: `1px solid ${theme.edge}`,
        background: "transparent",
        color: theme.dim,
        cursor: "pointer",
      }}
    >
      <Icon size={14} aria-hidden />
    </button>
  );
}
