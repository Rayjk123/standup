import { useState } from "react";
import type { Session } from "@standup/shared";
import { theme } from "./theme";

interface SessionControlsProps {
  session: Session;
  onChanged: () => void;
}

const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontSize: 12,
  color: theme.faint,
};

/**
 * Stop and delete for a session.
 *
 * Stop only works on launched sessions — Standup owns their tmux pane. The
 * button is offered regardless so a monitored session gets a real
 * explanation rather than silently missing the control.
 *
 * Delete is refused while a session is live, because the next hook would
 * recreate the row: it would discard the history and change nothing else.
 */
export function SessionControls({ session, onChanged }: SessionControlsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const [freed, setFreed] = useState<string | null>(null);

  const ended = !!session.endedAt;

  async function act(kind: "stop" | "delete") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        kind === "stop"
          ? `/api/sessions/${session.id}/stop`
          : `/api/sessions/${session.id}`,
        { method: kind === "stop" ? "POST" : "DELETE" }
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error ?? `${kind} failed`);
        return;
      }

      if (kind === "delete" && data.deleted) {
        const d = data.deleted;
        const total =
          d.events + d.checkpoints + d.asks + d.steers + d.expertExchanges;
        setFreed(`${total} row${total === 1 ? "" : "s"} freed`);
      }

      setConfirm(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (freed) {
    return (
      <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.checkpoint }}>
        ✓ deleted · {freed}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {!ended && (
          <button
            onClick={() => setConfirm(confirm === "stop" ? null : "stop")}
            style={{ ...linkButton, color: theme.waiting }}
          >
            ■ stop
          </button>
        )}

        <button
          onClick={() => setConfirm(confirm === "delete" ? null : "delete")}
          title={
            ended
              ? "Remove this session and its stored events"
              : "Only ended sessions can be deleted"
          }
          style={{ ...linkButton, opacity: ended ? 1 : 0.45 }}
        >
          🗑 delete
        </button>
      </div>

      {confirm && (
        <div
          style={{
            display: "flex",
            gap: 9,
            alignItems: "center",
            marginTop: 9,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 11.5, color: theme.dim }}>
            {confirm === "stop"
              ? "Kills the agent. Worktree and branch are kept."
              : "Removes its events, checkpoints, asks, and steers. Not undoable."}
          </span>
          <button
            onClick={() => void act(confirm)}
            disabled={busy}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: theme.ground,
              background: theme.waiting,
              border: "none",
              borderRadius: 5,
              padding: "5px 11px",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "…" : confirm === "stop" ? "Stop agent" : "Delete"}
          </button>
          <button onClick={() => setConfirm(null)} style={linkButton}>
            cancel
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            marginTop: 8,
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
