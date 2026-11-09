import { useCallback, useEffect, useState } from "react";
import type { PlanApproval } from "@standup/shared";
import { alpha, theme } from "./theme";

/**
 * The Live workers drawer's plan-approval affordance: lists plans an agent has submitted
 * and is BLOCKED on, and lets a human approve (optionally editing the plan or
 * acceptance criterion first) or reject. Approving releases the paused run.
 *
 * Self-refreshing on the `planSignal` bump (a plan:updated WS frame) plus a slow
 * backstop, so a freshly submitted plan appears without a manual reload and a
 * resolved one drops off. Renders nothing when no plan is pending, so it costs a
 * gated workflow only when it's actually waiting on someone.
 */
export function PlanApprovalPanel({ planSignal }: { planSignal: number }) {
  const [plans, setPlans] = useState<PlanApproval[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/plans/pending");
      if (res.ok) {
        const body = (await res.json()) as { plans: PlanApproval[] };
        setPlans(body.plans ?? []);
      }
    } catch {
      // Leave the last set on screen rather than blanking it.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, planSignal]);

  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  if (plans.length === 0) return null;

  return (
    <div
      style={{
        borderBottom: `1px solid ${theme.edge}`,
        background: alpha(theme.waiting, 0x0f),
        padding: "10px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: theme.waiting,
        }}
      >
        {plans.length === 1 ? "Plan awaiting your approval" : `${plans.length} plans awaiting approval`}
      </div>
      {plans.map((plan) => (
        <PlanCard key={plan.id} plan={plan} onResolved={load} />
      ))}
    </div>
  );
}

function PlanCard({ plan, onResolved }: { plan: PlanApproval; onResolved: () => void }) {
  const [planText, setPlanText] = useState(plan.plan ?? "");
  const [criterion, setCriterion] = useState(plan.acceptanceCriterion ?? "");
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    try {
      await fetch(`/api/plans/${plan.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planText, acceptanceCriterion: criterion }),
      });
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await fetch(`/api/plans/${plan.id}/reject`, { method: "POST" });
      onResolved();
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    fontFamily: theme.mono,
    fontSize: 12,
    color: theme.text,
    background: theme.ground,
    border: `1px solid ${theme.edge}`,
    borderRadius: 5,
    padding: "6px 8px",
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.edge}`,
        borderRadius: 7,
        background: theme.surface,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {plan.relevantFiles.length > 0 && (
        <div style={{ fontSize: 11, color: theme.faint, fontFamily: theme.mono }}>
          {plan.relevantFiles.join("  ·  ")}
        </div>
      )}
      <label style={{ fontSize: 10.5, fontWeight: 600, color: theme.dim }}>Plan</label>
      <textarea
        value={planText}
        onChange={(e) => setPlanText(e.target.value)}
        rows={5}
        style={{ ...fieldStyle, resize: "vertical" }}
      />
      <label style={{ fontSize: 10.5, fontWeight: 600, color: theme.dim }}>
        Acceptance criterion (shell command — must exit 0 before ready)
      </label>
      <input
        value={criterion}
        onChange={(e) => setCriterion(e.target.value)}
        placeholder="e.g. bun test"
        style={fieldStyle}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button
          onClick={approve}
          disabled={busy}
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "6px 14px",
            borderRadius: 6,
            border: "none",
            background: theme.running,
            color: theme.ground,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Approve & release
        </button>
        <button
          onClick={reject}
          disabled={busy}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 14px",
            borderRadius: 6,
            border: `1px solid ${theme.edge}`,
            background: "transparent",
            color: theme.faint,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
