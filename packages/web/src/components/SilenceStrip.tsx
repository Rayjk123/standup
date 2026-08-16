import type { SessionStatus } from "@standup/shared";
import { theme, statusColors } from "./theme";
import { SILENCE_METER_MINUTES } from "@standup/shared";

interface SilenceStripProps {
  status: SessionStatus;
  ticks?: boolean[];
}

export function SilenceStrip({ status, ticks }: SilenceStripProps) {
  const color = statusColors[status];

  // Falls back to all-dark ticks until the API's activityTicks lands (e.g.
  // brand-new session with no events yet), rather than fabricating activity.
  const displayTicks = ticks ?? Array.from({ length: SILENCE_METER_MINUTES }, () => false);

  return (
    <div
      style={{ display: "flex", gap: 1.5, alignItems: "flex-end" }}
      title="Activity by minute, last 40 min"
    >
      {displayTicks.map((on, i) => (
        <div
          key={i}
          style={{
            width: 2,
            height: on ? 8 : 3,
            borderRadius: 1,
            background: on ? color : theme.edge,
            opacity: on ? 0.85 : 1,
          }}
        />
      ))}
    </div>
  );
}
