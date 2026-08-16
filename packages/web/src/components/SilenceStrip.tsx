import type { SessionStatus } from "@standup/shared";
import { statusColors } from "./theme";
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
    <div className="flex items-end gap-[1.5px]" title="Activity by minute, last 40 min">
      {displayTicks.map((on, i) => (
        <div
          key={i}
          className={`w-0.5 rounded-[1px] ${on ? `h-2 ${color.bg} opacity-85` : "h-[3px] bg-edge"}`}
        />
      ))}
    </div>
  );
}
