import { CODE_REVIEW_LINK_KIND, type CodeReviewRef, type ReviewLink } from "@standup/shared";
import { shquote } from "../shell.js";
import { coAuthorTrailers } from "./co-authors.js";
import type { CodeReviewAdapter, DraftPrRequest } from "./types.js";

/**
 * GitHub draft-PR adapter. Composes a draft-PR request (title/body/branch) and
 * the equivalent `gh pr create --draft` command. The title is single-quoted
 * with shquote (never `JSON.stringify`, whose double quotes still let a shell
 * run `$(...)`/backticks/`$VAR` inside an attacker-influenced title when the
 * agent runs the line). The multi-line body is passed via `--body-file`
 * (written from `descriptionFile`), never a shell-quoted `--body`. In dryRun it
 * returns the composed request WITHOUT calling `gh` or the GitHub API. It fits
 * any project with a repo, and never makes the review a packet requirement.
 * It carries no org vocabulary: the co-author email domain comes in the
 * compose context.
 */
export const GITHUB_PR_ADAPTER: CodeReviewAdapter = {
  id: "github-pr",
  noun: "pull request",
  // Any http(s) link reads as a review; a `/pull/<n>` URL's id is its number.
  linkFormat: {},
  detect: (project) => project.repos.length > 0,
  ownsRemote: () => false,
  ownsRemotes: false,
  requiresLinkedReview: () => false,
  requiresIssueId: () => false,
  howToCut({ prior }) {
    return prior
      ? `Push to the branch of pull request ${prior.id} rather than opening a new one.`
      : "Open a draft pull request first with `gh pr create --draft`.";
  },
  exampleLink(ref?: CodeReviewRef | null): ReviewLink {
    return ref
      ? { kind: CODE_REVIEW_LINK_KIND, label: `#${ref.id}`, url: ref.url }
      : { kind: CODE_REVIEW_LINK_KIND, label: "#<n>", url: "https://github.com/<owner>/<repo>/pull/<n>" };
  },
  async compose(ctx, opts) {
    // Co-authorship prefers a GitHub identity (login → no-reply email); a
    // participant known only by an alias is credited through the context's
    // email domain when it carries one.
    const trailers = coAuthorTrailers(ctx.participants, ctx.coAuthorEmailDomain);
    const body = ctx.body.trim() || ctx.title;
    const bodyPath = `${ctx.worktreePath.replace(/\/$/, "")}/.standup-pr-body.md`;
    const request: DraftPrRequest = {
      draft: true,
      title: ctx.title,
      body,
      base: ctx.baseBranch,
      head: ctx.branch,
    };

    // Every interpolated value is single-quoted with shquote so the composed
    // line is inert when an agent runs it verbatim: the base and head branches
    // are user/UI/env-configurable, and the body-file path derives from the
    // worktree root, which may hold a space.
    const parts = ["gh", "pr", "create", "--draft", "--title", shquote(ctx.title)];
    if (ctx.baseBranch) parts.push("--base", shquote(ctx.baseBranch));
    if (ctx.branch) parts.push("--head", shquote(ctx.branch));
    parts.push("--body-file", shquote(bodyPath));
    const command = parts.join(" ");

    if (!opts.dryRun) {
      // This build never performs the outward action — every call runs in
      // dryRun and the composed request is handed to the agent to run.
      throw new Error("github-pr adapter: live create is not enabled in this build");
    }

    return {
      providerId: "github-pr",
      command,
      descriptionFile: { path: bodyPath, contents: body },
      request,
      coAuthors: trailers,
      placeholders: [],
    };
  },
};
