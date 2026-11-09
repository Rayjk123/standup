import type { ReviewArtifactParticipant } from "./types.js";

/**
 * Actor ids that are neutral fallbacks, not real people, so they are never
 * turned into an email. Mirrors the collector's identity fallbacks
 * (`resolveUserAlias`: `anonymous` off-tunnel, host `$USER`/`local` on
 * loopback) — crediting `anonymous@<domain>` would attribute a non-person.
 */
const NEUTRAL_ACTOR_IDS = new Set(["anonymous", "local", "unknown"]);

/** A bare user alias: no scheme prefix (`slack:`), no `@`, no whitespace. */
const BARE_ALIAS = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * The email used in a `Co-authored-by` trailer for a participant, or null when
 * none can be formed without guessing. Prefers an explicit address, then the
 * GitHub no-reply address from the login. Failing both, and only when an
 * `aliasDomain` is given (the org profile's identity.emailDomain), a
 * bare-alias actor id yields `<alias>@<domain>`.
 */
function coAuthorEmail(p: ReviewArtifactParticipant, aliasDomain?: string): string | null {
  if (p.email?.trim()) return p.email.trim();
  if (p.githubLogin?.trim()) return `${p.githubLogin.trim()}@users.noreply.github.com`;
  const alias = p.actorId?.trim();
  if (aliasDomain && alias && BARE_ALIAS.test(alias) && !NEUTRAL_ACTOR_IDS.has(alias.toLowerCase())) {
    return `${alias}@${aliasDomain}`;
  }
  return null;
}

/**
 * `Co-authored-by: <name> <<email>>` trailers for the participants that can be
 * attributed, deduped by trailer text and in participant order. A participant
 * with no derivable email is skipped rather than credited with a fake address.
 * `aliasDomain` enables the bare-alias fallback so collaborators known only by
 * their alias are credited.
 */
export function coAuthorTrailers(participants: ReviewArtifactParticipant[], aliasDomain?: string): string[] {
  const seen = new Set<string>();
  const trailers: string[] = [];
  for (const p of participants) {
    const email = coAuthorEmail(p, aliasDomain);
    if (!email) continue;
    const name = p.display?.trim() || p.githubLogin?.trim() || p.actorId;
    const trailer = `Co-authored-by: ${name} <${email}>`;
    if (seen.has(trailer)) continue;
    seen.add(trailer);
    trailers.push(trailer);
  }
  return trailers;
}

/**
 * Real collaborators `coAuthorTrailers` could NOT credit — no explicit email,
 * no github login, and no bare-alias actor id (with an alias domain) to fall
 * back on. The neutral fallbacks (`anonymous`/`local`/`unknown`) are excluded —
 * they are non-persons. Surfaced so a caller warns rather than silently
 * dropping a genuine participant from the co-author list.
 */
export function uncreditedParticipants(participants: ReviewArtifactParticipant[], aliasDomain?: string): ReviewArtifactParticipant[] {
  return participants.filter(
    (p) => coAuthorEmail(p, aliasDomain) === null && !NEUTRAL_ACTOR_IDS.has(p.actorId?.trim().toLowerCase() ?? "")
  );
}
