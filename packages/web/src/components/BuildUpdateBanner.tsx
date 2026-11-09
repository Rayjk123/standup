import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { BUILD_CHECK_INTERVAL_MS, loadedEntry, newerBuildServed } from "../lib/buildUpdate";
import { reloadForNewBuild } from "../lib/chunkReload";
import { alpha, theme } from "./theme";

/** The console tab a path is on: its first segment ("/work/s/x" → "work"). */
export function tabOf(pathname: string): string {
  return pathname.split("/")[1] ?? "";
}

export interface BuildUpdateBannerProps {
  /** How often a visible page checks; BUILD_CHECK_INTERVAL_MS by default. */
  intervalMs?: number;
  /** The entry chunk this page loaded (loadedEntry by default). */
  loaded?: string;
  /** The check; newerBuildServed by default. */
  check?: (loaded: string | undefined) => Promise<boolean>;
  /** Reloads onto the current build unless that would lose typed text; reloadForNewBuild by default. */
  reload?: () => void;
}

/**
 * Notices when the console was rebuilt under an open page (see
 * lib/buildUpdate.ts): it checks once shortly after load, every `intervalMs`
 * while the page is visible, and whenever the page is shown or focused. Once
 * the page is on an older build it offers a reload, and the next switch to
 * another tab reloads by itself — unless a text field holds typed text, or a
 * reload already ran within the last 30s (reloadForNewBuild).
 */
export function BuildUpdateBanner({
  intervalMs = BUILD_CHECK_INTERVAL_MS,
  loaded: loadedProp,
  check = newerBuildServed,
  reload = () => void reloadForNewBuild(),
}: BuildUpdateBannerProps) {
  const [loaded] = useState(() => loadedProp ?? loadedEntry());
  const [stale, setStale] = useState(false);
  const checkRef = useRef(check);
  checkRef.current = check;

  useEffect(() => {
    if (!loaded || stale) return;
    let cancelled = false;
    let running = false;
    const run = () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      void checkRef.current(loaded).then(
        (newer) => {
          running = false;
          if (newer && !cancelled) setStale(true);
        },
        () => {
          running = false;
        }
      );
    };
    const first = setTimeout(run, Math.min(intervalMs, 5000));
    const timer = setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
    };
  }, [loaded, stale, intervalMs]);

  // A switch to another tab on an older build lands on the current one; a
  // move within the tab (a session, a review, a doc) leaves the page alone.
  const tab = tabOf(useLocation().pathname);
  const shownOn = useRef(tab);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!stale) {
      shownOn.current = tab;
      return;
    }
    if (tab !== shownOn.current) reloadRef.current();
  }, [stale, tab]);

  if (!stale) return null;
  return (
    <div
      data-testid="build-update-banner"
      role="status"
      style={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        borderRadius: 6,
        background: theme.raised,
        border: `1px solid ${theme.edge}`,
        color: theme.text,
        fontFamily: theme.sans,
        fontSize: 12,
        boxShadow: `0 4px 16px ${alpha(theme.shadow, 0.4)}`,
      }}
    >
      <span>Standup was updated. Reload to get the latest console.</span>
      <button
        type="button"
        data-testid="build-update-reload"
        onClick={() => window.location.reload()}
        style={{
          background: "transparent",
          border: `1px solid ${theme.edge}`,
          borderRadius: 4,
          color: theme.text,
          fontSize: 11,
          padding: "2px 8px",
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}
