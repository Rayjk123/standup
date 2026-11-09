import { useEffect, useState } from "react";
import { alpha, theme } from "./theme";

/** How long the live socket may be down before the console says so: a blip during a restart stays quiet. */
export const RECONNECTING_AFTER_MS = 3000;

/**
 * The banner text for a socket down since `downSince`, or null while it is up
 * or has been down for less than `RECONNECTING_AFTER_MS`. `cause` (why the
 * outage began, see closeCause in liveSocket.ts) follows the span.
 */
export function reconnectingLabel(downSince: number | null, now: number, cause?: string | null): string | null {
  if (downSince === null) return null;
  const down = now - downSince;
  if (down < RECONNECTING_AFTER_MS) return null;
  const seconds = Math.floor(down / 1000);
  const span = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Reconnecting to Standup… live updates paused for ${span}${cause ? ` — ${cause}` : ""}`;
}

const SR_ONLY = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/**
 * A strip pinned to the top of the window while the collector's live socket
 * is down, so a console that has stopped updating says so instead of looking
 * current. "Retry now" reconnects at once instead of waiting out the backoff.
 */
export function ConnectionBanner({
  downSince,
  cause,
  onRetry,
}: {
  downSince: number | null;
  cause?: string | null;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (downSince === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [downSince]);

  const label = reconnectingLabel(downSince, now, cause);
  // The live region stays mounted (empty while connected) so screen readers
  // announce the text when it appears; it holds static text, not the ticking
  // counter, so it isn't re-announced every second.
  const announcement = (
    <div role="status" aria-live="polite" style={SR_ONLY}>
      {label ? "Reconnecting to Standup. Live updates are paused." : ""}
    </div>
  );
  if (!label) return announcement;
  return (
    <>
    {announcement}
    <div
      data-testid="connection-banner"
      style={{
        position: "fixed",
        // Just under the header bar, clear of the view tabs.
        top: 54,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        borderRadius: 6,
        background: theme.raised,
        border: `1px solid ${theme.stalled}`,
        color: theme.text,
        fontFamily: theme.sans,
        fontSize: 12,
        boxShadow: `0 4px 16px ${alpha(theme.shadow, 0.4)}`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: theme.stalled, flexShrink: 0 }} />
      <span aria-hidden="true">{label}</span>
      <button
        type="button"
        onClick={onRetry}
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
        Retry now
      </button>
    </div>
    </>
  );
}
