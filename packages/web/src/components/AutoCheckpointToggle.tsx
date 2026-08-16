import { useEffect, useState } from "react";
import { Switch } from "@headlessui/react";

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
    <Switch
      checked={enabled}
      onChange={toggle}
      disabled={saving}
      title={
        enabled
          ? "Auto-checkpoint is on — Haiku summarizes agents that never call checkpoint themselves, at real per-call cost. Click to turn off."
          : "Auto-checkpoint is off. When on, Haiku reads each session's transcript at every turn boundary and checkpoints it if nothing was self-reported — at real per-call cost."
      }
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-[5px] font-mono text-[11.5px] ${
        enabled ? "border-expert text-expert" : "border-edge text-faint"
      } ${saving ? "cursor-default opacity-60" : "cursor-pointer"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-expert" : "bg-faint"}`} />
      auto-checkpoint {enabled ? "on" : "off"}
    </Switch>
  );
}
