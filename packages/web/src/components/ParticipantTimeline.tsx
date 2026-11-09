import { useCallback, useEffect, useState } from "react";
import { LuCrown, LuUserPlus } from "react-icons/lu";
import type { Actor, Session, SessionParticipant } from "@standup/shared";
import { alpha, theme } from "./theme";
import { ownershipView, buildParticipantTimeline, claimOwnership } from "../lib/ownership";

/**
 * The "Claim ownership" / owner-reassign control for a session header (Concept
 * 1). Sessions are shared and ownership is reassignable, so this offers the
 * acting tunnel user a one-click takeover: a bare POST to the assign-owner
 * endpoint attributes the claim to them. Reads as a state badge when they
 * already own it, a plain "claim" when the session is unowned, and a "take it
 * over from <owner>" when someone else holds it. Renders nothing until the
 * tunnel identity resolves (there's no one to attribute a claim to).
 */
export function ClaimOwnershipButton({
  session,
  currentUser,
  actors,
  onChanged,
}: {
  session: Session;
  currentUser: string;
  actors: Actor[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = ownershipView(session, currentUser, actors);

  if (view.kind === "none") return null;

  if (view.kind === "owned-by-you") {
    return (
      <span
        title="You own this session"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: theme.checkpoint,
        }}
      >
        <LuCrown /> {view.label}
      </span>
    );
  }

  async function claim() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await claimOwnership(session.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't claim ownership");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={() => void claim()}
        disabled={busy}
        title={
          view.kind === "reassign"
            ? `Take ownership over from ${view.currentOwner}`
            : "Claim ownership of this shared session"
        }
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          padding: "4px 11px",
          borderRadius: 999,
          border: `1px solid ${theme.checkpoint}`,
          background: alpha(theme.checkpoint, 0x1a),
          color: theme.checkpoint,
          cursor: busy ? "not-allowed" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <LuCrown /> {busy ? "Claiming…" : view.label}
      </button>
      {error && (
        <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.waiting }}>
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * The participant-history timeline (Concept 1): who joined or acted on a
 * session and when, read from `session_participants` via the participants
 * endpoint and merged with the session's creator/owner. Each row shows the
 * actor, a first-acted timestamp and contribution count when they actually
 * acted, and a crown/creator tag for the owner and origin. Refetches when a
 * hook event lands so a teammate jumping in appears without a manual reload.
 * Renders a quiet placeholder until anyone has been recorded.
 */
export function ParticipantTimeline({
  session,
  currentUser,
  eventSignal,
}: {
  session: Session;
  currentUser: string;
  eventSignal: number;
}) {
  const [data, setData] = useState<{
    participants: SessionParticipant[];
    actors: Actor[];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${session.id}/participants`);
      if (res.ok) setData(await res.json());
    } catch {
      // Leave the previous roster on screen rather than blanking it.
    }
  }, [session.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (eventSignal === 0) return;
    void load();
  }, [eventSignal, load]);

  const timeline = buildParticipantTimeline({
    participants: data?.participants ?? [],
    actors: data?.actors,
    createdActor: session.createdActor,
    ownerActor: session.ownerActor,
    currentUser,
  });

  if (timeline.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: theme.faint, lineHeight: 1.55 }}>
        No one has acted on this session yet.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {timeline.map((e) => (
        <div
          key={e.actorId}
          style={{ display: "flex", alignItems: "center", gap: 10 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 7,
              background: e.isOwner ? theme.checkpoint : theme.running,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 13, color: theme.text, fontWeight: 600 }}>
            {e.display}
            {e.isCurrentUser && (
              <span style={{ color: theme.faint, fontWeight: 400 }}> (you)</span>
            )}
          </span>
          {e.isCreator && (
            <span
              title="Started this session"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                color: theme.expert,
                border: `1px solid ${alpha(theme.expert, 0x44)}`,
                borderRadius: 3,
                padding: "1px 5px",
              }}
            >
              <LuUserPlus /> creator
            </span>
          )}
          {e.isOwner && (
            <span
              title="Currently owns this session"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                color: theme.checkpoint,
                border: `1px solid ${alpha(theme.checkpoint, 0x44)}`,
                borderRadius: 3,
                padding: "1px 5px",
              }}
            >
              <LuCrown /> owner
            </span>
          )}
          <span style={{ flex: 1 }} />
          {e.firstSeen ? (
            <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
              {e.contributionCount != null && `${e.contributionCount}× · `}
              joined{" "}
              {e.firstSeen.toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : (
            <span style={{ fontFamily: theme.mono, fontSize: 10.5, color: theme.faint }}>
              hasn't acted
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
