import type { Database } from "bun:sqlite";
import { getParticipants, getActor } from "@standup/store";
import type { Project } from "@standup/shared";
import { resolveProjectCodeReview, type CodeReviewRemotes } from "./code-review/adapter.js";
import { activeOrgProfile } from "./org-profile/load.js";
import type {
  ReviewArtifactContext,
  ReviewArtifactOptions,
  ReviewArtifactParticipant,
  ReviewArtifactResult,
} from "./code-review/types.js";

/**
 * A completed session's change turns into the review its project's
 * code-review adapter composes (code-review/adapter.ts). The adapter only
 * COMPOSES the review (the exact command plus description file, or the
 * draft-PR request); it never executes the outward action itself. In this
 * build every call runs with `dryRun` (the default), so the composed
 * command/request is RETURNED for the launched agent to run.
 */

export type {
  DraftPrRequest,
  ReviewArtifactContext,
  ReviewArtifactOptions,
  ReviewArtifactParticipant,
  ReviewArtifactResult,
} from "./code-review/types.js";
export { coAuthorTrailers, uncreditedParticipants } from "./code-review/co-authors.js";

/**
 * The participants of a session as attribution records — each resolved through
 * `getActor` so a merged duplicate credits the canonical collaborator once.
 */
export function participantsForCoAuthors(db: Database, sessionId: string): ReviewArtifactParticipant[] {
  const out: ReviewArtifactParticipant[] = [];
  const seen = new Set<string>();
  for (const part of getParticipants(db, sessionId)) {
    const actor = getActor(db, part.actorId);
    const actorId = actor?.id ?? part.actorId;
    if (seen.has(actorId)) continue;
    seen.add(actorId);
    out.push({
      actorId,
      display: actor?.display,
      githubLogin: actor?.githubLogin,
    });
  }
  return out;
}

/**
 * Compose the review for a project's change: resolve its adapter over its
 * checkouts' remotes (`checkouts.remotes`, see resolveProjectCodeReview) —
 * the adapter that also decides whether it is asked an issue id and how its
 * links read — and run it in the given mode (dryRun by default in this
 * build). Co-authors known only by an alias are credited at the org profile's
 * email domain unless the context names one. Returns null when the project
 * has no fitting adapter.
 */
export async function composeReviewArtifact(
  project: Project,
  ctx: ReviewArtifactContext,
  opts: ReviewArtifactOptions = { dryRun: true },
  checkouts: { remotes?: CodeReviewRemotes } = {}
): Promise<ReviewArtifactResult | null> {
  const profile = activeOrgProfile();
  const { adapter } = resolveProjectCodeReview(project, { profile, remotes: checkouts.remotes });
  if (!adapter) return null;
  return adapter.compose({ ...ctx, coAuthorEmailDomain: ctx.coAuthorEmailDomain ?? profile.identity.emailDomain }, opts);
}
