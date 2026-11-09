import type { ReviewStatus } from "@standup/shared";
import { alpha } from "../theme";
import { STATUS_COLORS, STATUS_LABELS } from "./format";

export function Badge({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "2px 7px",
        borderRadius: 4,
        color,
        background: alpha(color, 0x1f),
        whiteSpace: "nowrap",
        display: "inline-block",
      }}
    >
      {text}
    </span>
  );
}

export function StatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span data-status={status}>
      <Badge text={STATUS_LABELS[status]} color={STATUS_COLORS[status]} />
    </span>
  );
}
