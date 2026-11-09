import { useEffect, useState } from "react";
import { theme } from "./theme";

type Override = "" | "on" | "off";

/**
 * Global control for the multiplayer launch default (see
 * packages/collector/src/multiplayer.ts). Multiplayer flips new launches to a
 * fresh worktree per project so shared users don't collide on one working tree;
 * single-user local keeps launching in-place. Auto-detected from the count of
 * distinct aliases that have connected, this pill cycles a manual override —
 * auto → on → off → auto — for the cases the count can't see (forcing it on
 * before a teammate connects, or back off for a solo user whose collector once
 * saw a second alias). A global live switch that flips without a collector
 * restart.
 */
export function MultiplayerToggle() {
  const [override, setOverride] = useState<Override | null>(null);
  const [active, setActive] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setOverride((data.multiplayerOverride as Override) ?? "");
        setActive(!!data.multiplayer);
      })
      .catch(() => setOverride(""));
  }, []);

  if (override === null) return null;

  const next: Override = override === "" ? "on" : override === "on" ? "off" : "";

  async function cycle() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiplayerOverride: next }),
      });
      const data = await res.json();
      setOverride((data.multiplayerOverride as Override) ?? "");
      setActive(!!data.multiplayer);
    } finally {
      setSaving(false);
    }
  }

  const mode = override === "" ? "auto" : override;

  return (
    <button
      onClick={cycle}
      disabled={saving}
      title={
        `Multiplayer is ${active ? "ON" : "off"} (${
          override === "" ? "auto-detected from connected users" : `forced ${override} by override`
        }). When on, new launches default to a fresh worktree per project so ` +
        "shared users don't collide; single-user local launches in-place. " +
        "Click to cycle the override: auto → on → off."
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "none",
        border: `1px solid ${active ? theme.accent : theme.edge}`,
        borderRadius: 5,
        padding: "5px 10px",
        cursor: saving ? "default" : "pointer",
        fontSize: 11.5,
        fontFamily: theme.mono,
        color: active ? theme.accent : theme.faint,
        opacity: saving ? 0.6 : 1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: active ? theme.accent : theme.faint,
        }}
      />
      multiplayer {mode}
    </button>
  );
}
