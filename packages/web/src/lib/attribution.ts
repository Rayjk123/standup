import type { Launch, Session } from "@standup/shared";

/**
 * Whether a session belongs to `user` — the predicate behind the sidebar
 * "Mine" filter (Personalization/Multiplayer spec G). A session is mine when I
 * created it, currently own it, or have acted on it (a recorded participant).
 * Keyed by the current tunnel alias; an empty user (identity not yet resolved)
 * matches nothing rather than everything.
 */
export function isMine(session: Session, user: string): boolean {
  if (!user) return false;
  if (session.createdActor === user) return true;
  if (session.ownerActor === user) return true;
  return session.participantActors?.includes(user) ?? false;
}

/**
 * Whether a launch belongs to `user` — the predicate the "Mine" lens applies to
 * a still-provisioning, sessionless launch, which carries no session and so no
 * created/owner/participant attribution yet. A launch's only client-visible
 * actor is its `requester` (the tunnel user who dispatched it), so ownership is
 * judged by that alone. An empty user (identity unresolved) or a launch with no
 * requester (an automatic launch — adoption, a review-agent run) is nobody's,
 * so "Mine" hides it rather than showing every user's in-flight launch to all.
 */
export function isMineLaunch(launch: Launch, user: string): boolean {
  if (!user) return false;
  return launch.requester === user;
}

/**
 * The single human answerable for a session's asks — the target of a personal
 * "waiting on you" alert. Resolves in priority order: the current owner, else
 * the creator who first dispatched it, else the earliest recorded participant.
 * Returns undefined when the session carries no attribution at all (a legacy or
 * still-unclaimed session), meaning no one specific is on the hook for it.
 */
export function responsibleActor(session: Session | undefined): string | undefined {
  if (!session) return undefined;
  if (session.ownerActor) return session.ownerActor;
  if (session.createdActor) return session.createdActor;
  return session.participantActors?.[0];
}

/**
 * The session whose attribution decides who answers an ask of `id`: the
 * session itself when it has an owner or a creator, else its nearest parent
 * that has one. A subagent session has neither (only the participants who
 * answered it), so its asks are its root's. With no such parent it is the
 * asking session, participants and all.
 */
export function answerableSession(id: string, byId: ReadonlyMap<string, Session>): Session | undefined {
  const seen = new Set<string>();
  const asker = byId.get(id);
  let at = asker;
  while (at && !(at.ownerActor || at.createdActor) && at.parentSessionId && !seen.has(at.id)) {
    seen.add(at.id);
    at = byId.get(at.parentSessionId);
  }
  return at && (at.ownerActor || at.createdActor) ? at : asker;
}

/**
 * Whether the current user is the one answerable for a session's asks — the
 * predicate that decides whether a blocked/ask event fires the loud "waiting on
 * you" alarm for `user` or renders as a soft "waiting on <someone else>". A
 * session with no resolvable responsible actor (unattributed) is everyone's to
 * notice, so it counts as mine rather than vanishing; likewise an unresolved
 * viewer identity (empty `user`) sees every alarm rather than none, preserving
 * the pre-personalization broadcast until the tunnel alias arrives.
 */
export function isMyResponsibility(session: Session | undefined, user: string): boolean {
  const who = responsibleActor(session);
  if (!who) return true;
  if (!user) return true;
  return who === user;
}
