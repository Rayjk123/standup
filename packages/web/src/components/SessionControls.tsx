import { useState } from "react";
import { LuCheck, LuArrowLeftRight, LuSquare, LuTrash2, LuCopy } from "react-icons/lu";
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
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
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
  const [copied, setCopied] = useState(false);

  const ended = !!session.endedAt;
  const owned = !!session.owned;

  function copyId() {
    void navigator.clipboard?.writeText(session.id).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  }

  async function adopt() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/adopt`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Adoption failed");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

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
      <div
        style={{
          fontFamily: theme.mono,
          fontSize: 11,
          color: theme.checkpoint,
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <LuCheck /> deleted · {freed}
      </div>
    );
  }

  return (
    <div>
      {/* The session id, always visible and copyable — it's what
          `claude --resume <id>` needs to reattach to this conversation from a
          terminal, and what the resume button below uses. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 11,
          fontFamily: theme.mono,
          fontSize: 11,
          color: theme.faint,
        }}
      >
        <span style={{ letterSpacing: "0.06em" }}>id</span>
        <code
          title={session.id}
          style={{
            color: theme.dim,
            background: theme.ground,
            border: `1px solid ${theme.edgeSoft}`,
            borderRadius: 3,
            padding: "1px 6px",
            userSelect: "all",
          }}
        >
          {session.id}
        </code>
        <button
          onClick={copyId}
          title={`Copy session id (resume with: claude --resume ${session.id})`}
          style={{ ...linkButton, color: copied ? theme.checkpoint : theme.faint }}
        >
          {copied ? <><LuCheck /> copied</> : <><LuCopy /> copy</>}
        </button>
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {/* Which capabilities exist depends entirely on whether Standup owns
            this session's terminal, so say so rather than leaving the user to
            infer it from which buttons happen to work. */}
        <span
          title={
            owned
              ? "Standup owns this session's terminal — it can read the screen, type into it, and stop it."
              : "You started this session in your own terminal. Standup observes it but can't type into it."
          }
          style={{
            fontFamily: theme.mono,
            fontSize: 9.5,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: owned ? theme.checkpoint : theme.faint,
            border: `1px solid ${owned ? theme.checkpoint : theme.edge}44`,
            borderRadius: 3,
            padding: "2px 6px",
          }}
        >
          {owned ? "owned" : "monitored"}
        </span>

        {/* Resume runs `claude --resume <id>` under a tmux pane Standup owns,
            reattaching to the same conversation (history, checkpoints, and
            events all stay). Offered for ANY ended session — whether it was
            monitored or one Standup launched that has since died — since the
            session id is all `--resume` needs. Not shown while it's live: two
            processes on one transcript would collide. */}
        {ended && (
          <button onClick={() => void adopt()} disabled={busy} style={linkButton}>
            {busy ? "resuming…" : <><LuArrowLeftRight /> resume</>}
          </button>
        )}

        {!ended && (
          <button
            onClick={() => setConfirm(confirm === "stop" ? null : "stop")}
            style={{ ...linkButton, color: theme.waiting }}
          >
            <LuSquare /> stop
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
          <LuTrash2 /> delete
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
