import { useState } from "react";
import type { Launch } from "@standup/shared";
import { theme } from "./theme";

interface LaunchControlsProps {
  launch: Launch;
  onStopped: () => void;
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
 * Controls that exist only for launched sessions.
 *
 * Standup owns this session's tmux pane, so unlike a monitored session it
 * can show the screen, type into it, and stop it. That matters most here:
 * you have a terminal for a session you started yourself, and none for one
 * the console started for you.
 */
export function LaunchControls({ launch, onStopped }: LaunchControlsProps) {
  const [output, setOutput] = useState<string | null>(null);
  const [alive, setAlive] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);

  async function loadOutput() {
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/output`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not read the session");
        return;
      }
      setAlive(data.alive);
      setOutput(data.output || "(nothing on screen yet)");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Send failed");
        return;
      }
      setDraft("");
      setComposing(false);
      // Give the agent a beat to react, then show the result — otherwise
      // you'd see the screen from before your input landed.
      setTimeout(() => void loadOutput(), 1200);
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/launches/${launch.id}/stop`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Stop failed");
        return;
      }
      setConfirmStop(false);
      onStopped();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 9 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => (output ? setOutput(null) : void loadOutput())} style={linkButton}>
          {output ? "▾ hide output" : "▸ view output"}
        </button>

        <button onClick={() => setComposing((v) => !v)} style={linkButton}>
          ↩ send input
        </button>

        <span style={{ flex: 1 }} />

        {confirmStop ? (
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: theme.dim }}>Worktree is kept.</span>
            <button
              onClick={() => void stop()}
              disabled={busy}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: theme.ground,
                background: theme.waiting,
                border: "none",
                borderRadius: 5,
                padding: "5px 11px",
                cursor: "pointer",
              }}
            >
              Stop agent
            </button>
            <button onClick={() => setConfirmStop(false)} style={linkButton}>
              cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmStop(true)}
            style={{ ...linkButton, color: theme.waiting }}
          >
            ■ stop
          </button>
        )}
      </div>

      {composing && (
        <input
          autoFocus
          value={draft}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
            if (e.key === "Escape") setComposing(false);
          }}
          placeholder="Typed straight into the session — lands immediately, unlike a steer…"
          style={{
            width: "100%",
            marginTop: 8,
            fontSize: 13,
            color: theme.text,
            background: theme.ground,
            border: `1px solid ${theme.edge}`,
            borderRadius: 6,
            padding: "8px 11px",
            outline: "none",
          }}
        />
      )}

      {output !== null && (
        <div style={{ marginTop: 8 }}>
          <pre
            style={{
              fontFamily: theme.mono,
              fontSize: 11,
              lineHeight: 1.5,
              color: theme.dim,
              background: theme.ground,
              border: `1px solid ${theme.edgeSoft}`,
              borderRadius: 6,
              padding: "10px 12px",
              margin: 0,
              maxHeight: 320,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {output}
          </pre>
          <div style={{ display: "flex", gap: 12, marginTop: 6, alignItems: "center" }}>
            <button onClick={() => void loadOutput()} style={linkButton}>
              ↻ refresh
            </button>
            {!alive && (
              <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
                session no longer running
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            marginTop: 7,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
