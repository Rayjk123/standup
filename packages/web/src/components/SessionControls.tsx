import { useState } from "react";
import type { Session } from "@standup/shared";

interface SessionControlsProps {
  session: Session;
  onChanged: () => void;
}

const linkButtonClass = "cursor-pointer border-none bg-transparent p-0 text-xs text-faint";

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
  const owned = !!session.owned;

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
      <div className="font-mono text-[11px] text-checkpoint">✓ deleted · {freed}</div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3.5">
        {/* Which capabilities exist depends entirely on whether Standup owns
            this session's terminal, so say so rather than leaving the user to
            infer it from which buttons happen to work. */}
        <span
          title={
            owned
              ? "Standup owns this session's terminal — it can read the screen, type into it, and stop it."
              : "You started this session in your own terminal. Standup observes it but can't type into it."
          }
          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] ${
            owned ? "border-checkpoint/25 text-checkpoint" : "border-edge/25 text-faint"
          }`}
        >
          {owned ? "owned" : "monitored"}
        </span>

        {/* Adoption resumes an ended session under a tmux pane Standup owns,
            converting monitored → owned. Only offered where it can work. */}
        {!owned && ended && (
          <button onClick={() => void adopt()} disabled={busy} className={linkButtonClass}>
            {busy ? "adopting…" : "⇄ adopt"}
          </button>
        )}

        {!ended && (
          <button
            onClick={() => setConfirm(confirm === "stop" ? null : "stop")}
            className={`${linkButtonClass} text-waiting`}
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
          className={`${linkButtonClass} ${ended ? "opacity-100" : "opacity-45"}`}
        >
          🗑 delete
        </button>
      </div>

      {confirm && (
        <div className="mt-[9px] flex flex-wrap items-center gap-[9px]">
          <span className="text-[11.5px] text-dim">
            {confirm === "stop"
              ? "Kills the agent. Worktree and branch are kept."
              : "Removes its events, checkpoints, asks, and steers. Not undoable."}
          </span>
          <button
            onClick={() => void act(confirm)}
            disabled={busy}
            className={`rounded-md border-none bg-waiting px-2.5 py-[5px] text-xs font-semibold text-ground ${
              busy ? "cursor-not-allowed opacity-60" : "cursor-pointer opacity-100"
            }`}
          >
            {busy ? "…" : confirm === "stop" ? "Stop agent" : "Delete"}
          </button>
          <button onClick={() => setConfirm(null)} className={linkButtonClass}>
            cancel
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 font-mono text-[11px] leading-relaxed text-waiting">{error}</div>
      )}
    </div>
  );
}
