import type { CSSProperties } from "react";
import { theme } from "./theme";

/**
 * A placeholder bar for content still loading. It pulses through the
 * `standup-pulse` keyframes in index.html, which hold still under
 * prefers-reduced-motion.
 */
export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number; style?: CSSProperties }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        flexShrink: 0,
        borderRadius: 8,
        background: theme.raised,
        animation: "standup-pulse 1.4s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

/**
 * A tab's place until the console's first snapshot lands: a header bar and a
 * few rows, so the layout doesn't jump when the data fills in.
 */
export function ViewSkeleton() {
  return (
    <div data-testid="view-skeleton" aria-busy="true" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
      <Skeleton width={220} height={20} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} height={44} width={i % 2 ? "92%" : "100%"} />
      ))}
    </div>
  );
}
