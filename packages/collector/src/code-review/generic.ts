import { writeFileSync } from "fs";
import { CODE_REVIEW_LINK_KIND, codeReviewOfUrl, type CodeReviewRef, type ReviewLink } from "@standup/shared";
import type { OrgProfile } from "../org-profile/types.js";
import { orgCodeReviewProject, orgCodeReviewRemote } from "../org-profile/match.js";
import { composeReviewDescription } from "../review-description.js";
import { shquote } from "../shell.js";
import { coAuthorTrailers } from "./co-authors.js";
import type { CodeReviewAdapter } from "./types.js";

/** The token stamped in for `{issueId}` when the ticket carries no tracking id. */
export const ISSUE_ID_PLACEHOLDER = "<issue-id>";

/** The description file a composed review command references, in the worktree. */
export const REVIEW_DESCRIPTION_FILE = ".standup-review-description.md";

/** `template` with each `{name}` replaced by its value, shell-quoted. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? shquote(values[name]!) : whole));
}

/**
 * The generic code-review adapter: a review is any http(s) URL (read under
 * the org profile's codeReview.linkFormat when it sets one). Off unless a
 * project opts in — `codeReviewAdapter = "generic"` — or the org profile's
 * codeReview.provisionPatterns or launchSubdirPatterns match an unpinned
 * project (detect; none do under the default profile); only then must the
 * project's review packets link the review. A checkout whose remote matches
 * codeReview.remotePatterns still has a review to cut (ownsRemote). The org
 * profile's cutCommand and
 * reviseCommand, when set, are the commands composed for the worker; without
 * them the worker cuts the review the repo's own way.
 */
export function genericCodeReviewAdapter(profile: OrgProfile): CodeReviewAdapter {
  const review = profile.codeReview;
  const noun = review.noun ?? "code review";
  const format = review.linkFormat;
  const example = (id: string) => format.urlTemplate?.split("{id}").join(id) ?? "https://<the review's page>";
  return {
    id: "generic",
    noun,
    linkFormat: format,
    detect: (project) => orgCodeReviewProject(profile, project),
    ownsRemote: (url) => orgCodeReviewRemote(profile, url),
    ownsRemotes: review.remotePatterns.length > 0,
    requiresLinkedReview: (project) =>
      project.codeReviewAdapter === "generic" || (!project.codeReviewAdapter && orgCodeReviewProject(profile, project)),
    // Only a cut command that attaches an issue id needs one.
    requiresIssueId: () => review.cutCommand?.includes("{issueId}") ?? false,
    howToCut({ prior }) {
      if (prior) {
        const revise = review.reviseCommand ? ` with \`${fill(review.reviseCommand, { reviewId: prior.id, descriptionFile: "<file>" })}\`` : "";
        return `Revise the launch's ${noun} ${prior.id}${revise} rather than cutting a new one.`;
      }
      if (review.cutCommand) {
        const cut = fill(review.cutCommand, { issueId: ISSUE_ID_PLACEHOLDER, descriptionFile: "<file>" });
        const ask = review.cutCommand.includes("{issueId}") ? " — if you don't have the issue id, ask the owner for it with ask_human" : "";
        return `Cut the ${noun} first with \`${cut}\`${ask}.`;
      }
      return `Open the ${noun} first, the way the repo's changes are reviewed.`;
    },
    exampleLink(ref?: CodeReviewRef | null): ReviewLink {
      return ref
        ? { kind: CODE_REVIEW_LINK_KIND, label: ref.id, url: ref.url }
        : { kind: CODE_REVIEW_LINK_KIND, label: "<review id>", url: example("<review id>") };
    },
    async compose(ctx, opts) {
      const trailers = coAuthorTrailers(ctx.participants, ctx.coAuthorEmailDomain ?? profile.identity.emailDomain);
      const descriptionPath = `${ctx.worktreePath.replace(/\/$/, "")}/${REVIEW_DESCRIPTION_FILE}`;
      const existing = ctx.reviewUrl ? codeReviewOfUrl(ctx.reviewUrl, format) : null;
      if (existing) {
        return {
          providerId: "generic",
          ...(review.reviseCommand ? { command: fill(review.reviseCommand, { reviewId: existing.id, descriptionFile: descriptionPath }) } : {}),
          reviseDescriptionFile: { path: descriptionPath, fallback: composeReviewDescription(ctx) },
          coAuthors: trailers,
          placeholders: [],
        };
      }
      // Co-author trailers are not baked into the description: review tools and
      // git credit co-authorship from the commit message, so they are surfaced
      // through `coAuthors` for the agent to place on the commit.
      const contents = composeReviewDescription(ctx);
      const issueId = ctx.issueId?.trim();
      const placeholders: string[] = [];
      let command: string | undefined;
      if (review.cutCommand) {
        // Every value is shell-quoted, so the composed line is inert when an
        // agent runs it verbatim: the issue id is free text from propose_ticket,
        // and the description path derives from a configurable worktree root.
        command = fill(review.cutCommand, { issueId: issueId || ISSUE_ID_PLACEHOLDER, descriptionFile: descriptionPath });
        if (!issueId && review.cutCommand.includes("{issueId}")) {
          placeholders.push(`${ISSUE_ID_PLACEHOLDER} — the tracking issue this ${noun} resolves`);
        }
      }
      if (!opts.dryRun) writeFileSync(descriptionPath, contents);
      return {
        providerId: "generic",
        ...(command ? { command } : {}),
        descriptionFile: { path: descriptionPath, contents },
        coAuthors: trailers,
        placeholders,
      };
    },
  };
}
