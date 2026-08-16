import { useEffect, useState } from "react";
import { theme } from "./theme";

/**
 * Global on/off for Haiku-generated auto-checkpoints (see
 * packages/collector/src/auto-checkpoint.ts). Off by default — it costs a
 * real model call per turn boundary across every session — so this needs to
 * be flippable from the UI without a collector restart, unlike the
 * STANDUP_NUDGE=1 env var it sits next to conceptually.
 */
export function AutoCheckpointToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => setEnabled(!!data.autoCheckpoint))
      .catch(() => setEnabled(false));
  }, []);

  if (enabled === null) return null;

  async function toggle() {
    setSaving(true);
    const next = !enabled;
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCheckpoint: next }),
      });
      const data = await res.json();
      setEnabled(!!data.autoCheckpoint);
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={saving}
      title={
        enabled
          ? "Auto-checkpoint is on — Haiku summarizes agents that never call checkpoint themselves, at real per-call cost. Click to turn off."
          : "Auto-checkpoint is off. When on, Haiku reads each session's transcript at every turn boundary and checkpoints it if nothing was self-reported — at real per-call cost."
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "none",
        border: `1px solid ${enabled ? theme.expert : theme.edge}`,
        borderRadius: 5,
        padding: "5px 10px",
        cursor: saving ? "default" : "pointer",
        fontSize: 11.5,
        fontFamily: theme.mono,
        color: enabled ? theme.expert : theme.faint,
        opacity: saving ? 0.6 : 1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: enabled ? theme.expert : theme.faint,
        }}
      />
      auto-checkpoint {enabled ? "on" : "off"}
    </button>
  );
}
