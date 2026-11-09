import { useState } from "react";
import { LuLogIn, LuUsers } from "react-icons/lu";
import type { Session, Actor } from "@standup/shared";
import { alpha, theme } from "./theme";
import { ActorPips } from "./Facepile";
import { isMine } from "../lib/attribution";

/**
 * The "jump into anyone's thread" affordance (Personalization/Multiplayer spec
 * F). Sessions are shared, so any connected user can open a teammate's thread
 * and act in it — this makes that explicit. On someone else's thread it offers a
 * "Jump in" button that records the acting tunnel user as a participant
 * (`POST /join`, best-effort) and drops focus into the reply box, so the same
 * click that joins also lets you steer/reply. Once you're in — or on a thread
 * you already created/own — it collapses to a collaborator facepile of everyone
 * who has acted. Renders nothing for a solo thread of your own (no others, no
 * one else's work to join).
 *
 * Whether Standup can type into the session (owned vs monitored) is orthogonal:
 * joining a monitored session still records participation to follow it, the
 * reply box below just stays read-only.
 */
export function JoinThread({
  session,
  actors,
  currentUser,
  onJoined,
}: {
  session: Session;
  actors: Actor[];
  currentUser: string;
  /** Fired after a successful join so the caller can refresh + focus the reply. */
  onJoined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reflect the join immediately: participantActors only refreshes on the next
  // snapshot, so this flips the CTA off the instant the request succeeds.
  const [justJoined, setJustJoined] = useState(false);

  const participants = session.participantActors ?? [];
  const mine = isMine(session, currentUser) || justJoined;
  // Someone else brought this session into being — the case the "jump in"
  // affordance exists for. A session with no recorded creator predates the
  // collaboration model; treat it as joinable-if-anyone-else-is-here only.
  const someoneElses = !!session.createdActor && session.createdActor !== currentUser;
  const others = participants.filter((p) => p !== currentUser);

  // Nothing to offer: your own thread, no collaborators, no one else's work.
  if (!someoneElses && others.length === 0) return null;

  async function join() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/join`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Couldn't join this thread");
        return;
      }
      setJustJoined(true);
      onJoined();
    } catch {
      setError("Couldn't reach the collector — not joined.");
    } finally {
      setBusy(false);
    }
  }

  const canJoin = someoneElses && !mine;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        marginTop: 12,
        padding: "8px 11px",
        borderRadius: 7,
        border: `1px solid ${alpha(theme.expert, 0x44)}`,
        background: alpha(theme.expert, 0x12),
      }}
    >
      <LuUsers style={{ color: theme.expert, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: theme.dim, lineHeight: 1.45 }}>
        {canJoin
          ? "This is a shared thread — jump in to steer or reply."
          : "You're in this shared thread."}
      </span>

      {others.length > 0 && (
        <ActorPips
          aliases={mine ? [currentUser, ...others] : others}
          actors={actors}
          currentUser={currentUser}
          style={{ marginLeft: 2 }}
        />
      )}

      <span style={{ flex: 1 }} />

      {canJoin && (
        <button
          onClick={() => void join()}
          disabled={busy}
          title="Join this shared thread — you'll show up as a participant and can steer or reply in it"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            padding: "5px 12px",
            borderRadius: 999,
            border: "none",
            background: theme.expert,
            color: theme.ground,
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <LuLogIn /> {busy ? "Joining…" : "Jump in"}
        </button>
      )}

      {error && (
        <span
          style={{
            fontFamily: theme.mono,
            fontSize: 11,
            color: theme.waiting,
            width: "100%",
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
