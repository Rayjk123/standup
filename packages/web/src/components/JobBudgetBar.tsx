import type { PersonaJobBudget } from "@standup/shared";
import { formatMinutes } from "@standup/shared";
import { theme } from "./theme";

/** The colour of a budget at `level`: calm below 80%, amber near it, red once reached. */
function levelColor(level: PersonaJobBudget["level"]): string {
  if (level === "exceeded") return theme.waiting;
  if (level === "near") return theme.stalled;
  return theme.checkpoint;
}

function Meter({ label, used, limit, fraction, color }: { label: string; used: string; limit: string; fraction: number; color: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5, color: theme.dim }}>
        <span>{label}</span>
        <span style={{ fontFamily: theme.mono, color: theme.text }}>
          {used} <span style={{ color: theme.faint }}>/ {limit}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(fraction, 1) * 100)}
        aria-valuetext={`${used} of ${limit}`}
        style={{ height: 6, borderRadius: 3, background: theme.edgeSoft, marginTop: 4, overflow: "hidden" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

/**
 * A job's spend and wall-clock time against its budget, one meter per limited
 * dimension, with a line saying where the job stands once it nears or
 * reaches the budget.
 */
export function JobBudgetBar({
  budget,
  compact = false,
  open = true,
}: {
  budget: PersonaJobBudget;
  compact?: boolean;
  /** Whether the job is still open; a closed job's bar says nothing about launches. */
  open?: boolean;
}) {
  const color = levelColor(budget.level);
  const meters = [];
  if (budget.usd !== null) {
    meters.push(
      <Meter
        key="usd"
        label="Spend"
        used={`$${budget.spentUsd.toFixed(2)}`}
        limit={`$${budget.usd.toFixed(2)}`}
        fraction={budget.spentUsd / budget.usd}
        color={color}
      />
    );
  }
  if (budget.minutes !== null) {
    meters.push(
      <Meter
        key="minutes"
        label="Time"
        used={formatMinutes(budget.elapsedMinutes)}
        limit={formatMinutes(budget.minutes)}
        fraction={budget.elapsedMinutes / budget.minutes}
        color={color}
      />
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {meters.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {meters}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: theme.dim }}>
          ${budget.spentUsd.toFixed(2)} spent · no limit
        </div>
      )}
      {!compact && (
        <div style={{ fontSize: 11, color: theme.faint }}>
          Workers ${budget.workerUsd.toFixed(2)} · Persona ${budget.personaUsd.toFixed(2)}
        </div>
      )}
      {open && budget.level !== "ok" && (
        <div style={{ fontSize: 12, color, fontWeight: 600 }}>
          {budget.level === "exceeded"
            ? "Budget reached — its workers were asked to checkpoint and stop; more work on it needs your approval. To extend it, tell Persona."
            : "Over 80% of its budget — Persona has been told."}
        </div>
      )}
      {!open && budget.level === "exceeded" && <div style={{ fontSize: 11.5, color: theme.faint }}>Closed over its budget.</div>}
    </div>
  );
}
