import type { Actor, Session, SessionParticipant } from "@standup/shared";

/** A user's friendly name — the actor's `display` when set, else the raw alias. */
function displayFor(actors: Actor[] | undefined, alias: string): string {
  return actors?.find((a) => a.id === alias)?.display ?? alias;
}

/**
 * What the ownership control in a session header should offer the current user
 * (Concept 1 — owner reassign). Ownership is reassignable, so the button reads
 * differently depending on where the current user stands:
 *  - `owned-by-you` — the current user already owns it; the control is a state
 *    badge, not an action.
 *  - `claim` — no one owns it yet; the current user can take it.
 *  - `reassign` — someone else owns it; the current user can take it over, and
 *    the current owner's display name is surfaced so the takeover is explicit.
 * An empty `currentUser` (identity not yet resolved off the tunnel) can't be
 * attributed, so the control offers nothing.
 */
export type OwnershipView =
  | { kind: "none" }
  | { kind: "owned-by-you"; label: string }
  | { kind: "claim"; label: string }
  | { kind: "reassign"; label: string; currentOwner: string };

export function ownershipView(
  session: Pick<Session, "ownerActor" | "createdActor"> | undefined,
  currentUser: string,
  actors?: Actor[]
): OwnershipView {
  if (!session || !currentUser) return { kind: "none" };
  const owner = session.ownerActor;
  if (owner && owner === currentUser) {
    return { kind: "owned-by-you", label: "You own this" };
  }
  if (owner) {
    return {
      kind: "reassign",
      label: "Claim ownership",
      currentOwner: displayFor(actors, owner),
    };
  }
  return { kind: "claim", label: "Claim ownership" };
}

/**
 * One row of a session's participant-history timeline: an actor, when they
 * first acted on the session, how many times, and whether they are the
 * session's creator and/or current owner.
 */
export interface TimelineEntry {
  actorId: string;
  display: string;
  /** When this actor first acted; absent for a creator/owner who never acted. */
  firstSeen?: Date;
  contributionCount?: number;
  isCreator: boolean;
  isOwner: boolean;
  isCurrentUser: boolean;
}

/**
 * Merges the recorded participant set with the session's creator and owner into
 * a single chronological timeline (Concept 1 — participant history). Participant
 * records carry a first-acted timestamp and a contribution count and drive the
 * ordering (earliest first); the creator and owner are flagged on their rows.
 * A creator or owner who never actually acted (so has no participant record —
 * e.g. an owner who claimed the session without steering it) still earns a
 * timestamp-less row so the attribution is complete, the creator leading and
 * the owner trailing the acted-on rows.
 */
export function buildParticipantTimeline(args: {
  participants: SessionParticipant[];
  actors?: Actor[];
  createdActor?: string;
  ownerActor?: string;
  currentUser?: string;
}): TimelineEntry[] {
  const { participants, actors, createdActor, ownerActor, currentUser } = args;

  const acted = [...participants]
    .sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime())
    .map((p): TimelineEntry => ({
      actorId: p.actorId,
      display: displayFor(actors, p.actorId),
      firstSeen: new Date(p.firstSeen),
      contributionCount: p.contributionCount,
      isCreator: p.actorId === createdActor,
      isOwner: p.actorId === ownerActor,
      isCurrentUser: !!currentUser && p.actorId === currentUser,
    }));

  const seen = new Set(acted.map((e) => e.actorId));
  const roleOnly = (actorId: string, isCreator: boolean, isOwner: boolean): TimelineEntry => ({
    actorId,
    display: displayFor(actors, actorId),
    isCreator,
    isOwner,
    isCurrentUser: !!currentUser && actorId === currentUser,
  });

  const lead: TimelineEntry[] = [];
  if (createdActor && !seen.has(createdActor)) {
    lead.push(roleOnly(createdActor, true, createdActor === ownerActor));
    seen.add(createdActor);
  }
  const trail: TimelineEntry[] = [];
  if (ownerActor && !seen.has(ownerActor)) {
    trail.push(roleOnly(ownerActor, ownerActor === createdActor, true));
    seen.add(ownerActor);
  }

  return [...lead, ...acted, ...trail];
}

/**
 * Claims (or reassigns) a session's owner from the acting tunnel user, hitting
 * the collector's assign-owner endpoint. A bare POST means "I'll take this
 * one" — the server attributes the claim to the tunnel alias — so `actor` is
 * only sent when an explicit owner is chosen. Returns the updated session on
 * success; throws on a non-OK response so callers can surface the error.
 */
export async function claimOwnership(
  sessionId: string,
  actor?: string
): Promise<Session> {
  const res = await fetch(`/api/sessions/${sessionId}/assign-owner`, {
    method: "POST",
    ...(actor
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ actor }) }
      : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Couldn't claim ownership");
  }
  return (await res.json()) as Session;
}
