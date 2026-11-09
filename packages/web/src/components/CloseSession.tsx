import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LuX } from "react-icons/lu";
import type { Session } from "@standup/shared";
import { theme } from "./theme";
import { useNarrow } from "../hooks/useNarrow";
import { usePresence } from "../hooks/presence";

/**
 * Whether the console offers "Close session" for a session: it is live, a
 * root (a subagent ends with its parent), not a worker of an open Persona
 * job (which Persona stops through the job), and — when the viewer is known
 * — the viewer's own: the server refuses a session someone else owns.
 */
export function canCloseSession(session: Session, viewer?: string | null): boolean {
  if (session.endedAt || session.parentSessionId || session.personaWorker) return false;
  const owner = session.ownerActor ?? session.createdActor;
  return !viewer || !owner || owner === viewer;
}

/** Rows a delete freed, as the close and delete routes report them. */
export interface FreedRows {
  events: number;
  checkpoints: number;
  asks: number;
  steers: number;
}

/** Ends the session (and, with `deleteFromList`, deletes it); the server's error when refused. */
export async function requestCloseSession(
  sessionId: string,
  deleteFromList: boolean
): Promise<{ ok: true; deleted?: FreedRows } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteFromList }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; deleted?: FreedRows };
    return res.ok ? { ok: true, deleted: data.deleted } : { ok: false, error: data.error ?? "Close failed" };
  } catch {
    return { ok: false, error: "Couldn't reach Standup" };
  }
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
 * The confirm step of "Close session": what closing does for this session,
 * the "Delete from list" choice, and the button that does it.
 */
export function CloseSessionConfirm({
  session,
  onDone,
  onCancel,
}: {
  session: Session;
  /** Called once it closed; `deleted` holds the rows freed when it was also deleted. */
  onDone: (deleted?: FreedRows) => void;
  onCancel: () => void;
}) {
  const [deleteFromList, setDeleteFromList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close() {
    setBusy(true);
    setError(null);
    const result = await requestCloseSession(session.id, deleteFromList);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDone(result.deleted);
  }

  return (
    <div
      data-testid="close-session-confirm"
      onClick={(e) => e.stopPropagation()}
      style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 11.5, color: theme.dim }}
    >
      <span style={{ lineHeight: 1.45 }}>
        {session.owned
          ? "Stops its terminal if it's still running and ends the session. Worktree and branch are kept."
          : "Marks the session ended. Standup doesn't own its terminal, so nothing is killed."}
      </span>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={deleteFromList}
          onChange={(e) => setDeleteFromList(e.target.checked)}
        />
        Delete from list (removes its stored history; not undoable — a session still running in your own terminal comes back without it)
      </label>
      <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
        <button
          onClick={() => void close()}
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
          {busy ? "…" : deleteFromList ? "Close and delete" : "Close session"}
        </button>
        <button onClick={onCancel} style={linkButton}>
          cancel
        </button>
      </div>
      {error && (
        <div style={{ fontFamily: theme.mono, fontSize: 11, color: theme.waiting, lineHeight: 1.5 }}>{error}</div>
      )}
    </div>
  );
}

/**
 * A Sessions-list row with a "Close session" control on hover. Desktop only:
 * the phone layout has no hover, and its list stays read-and-open.
 */
export function ClosableSessionRow({
  session,
  onClosed,
  children,
}: {
  session: Session;
  onClosed?: () => void;
  children: ReactNode;
}) {
  const narrow = useNarrow();
  const [hover, setHover] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { currentUser } = usePresence();
  const closable = !narrow && canCloseSession(session, currentUser);
  // A session that stops being closable (it ended, or became a worker) drops
  // its open confirm, so the confirm can't reappear if the row comes back.
  useEffect(() => {
    if (!closable) setConfirming(false);
  }, [closable]);

  if (!closable) return <>{children}</>;
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Focus inside the row shows the control too, so it is reachable by keyboard.
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false);
      }}
    >
      {children}
      {(hover || confirming) && (
        <button
          aria-label="Close session"
          title="Close session"
          onClick={() => setConfirming(!confirming)}
          style={{
            position: "absolute",
            top: 6,
            right: 8,
            background: theme.raised,
            border: `1px solid ${theme.edge}`,
            borderRadius: 4,
            padding: "2px 4px",
            cursor: "pointer",
            color: theme.dim,
            display: "flex",
            alignItems: "center",
            fontSize: 12,
          }}
        >
          <LuX />
        </button>
      )}
      {confirming && (
        <div style={{ padding: "4px 12px 10px 28px", background: theme.raised }}>
          <CloseSessionConfirm
            session={session}
            onCancel={() => setConfirming(false)}
            onDone={() => {
              setConfirming(false);
              onClosed?.();
            }}
          />
        </div>
      )}
    </div>
  );
}
