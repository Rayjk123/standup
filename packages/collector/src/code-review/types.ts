import type { CodeReviewAdapterId, CodeReviewLinkFormat, CodeReviewRef, Project, ReviewLink } from "@standup/shared";

/**
 * One collaborator on the change, resolved from `session_participants`. Used
 * to emit `Co-authored-by` trailers (see coAuthorTrailers).
 */
export interface ReviewArtifactParticipant {
  actorId: string;
  display?: string;
  email?: string;
  githubLogin?: string;
}

/** What an adapter is handed to compose a review. */
export interface ReviewArtifactContext {
  /** The ticket's worktree — where a description file would be written. */
  worktreePath: string;
  title: string;
  body: string;
  participants: ReviewArtifactParticipant[];
  /** Tracking issue/task id, linked from the review when present. */
  issueId?: string;
  /** The review already cut for the ticket (its `reviewUrl`), which a re-run revises rather than duplicates. */
  reviewUrl?: string;
  /** The change's branch, used as the PR head. */
  branch?: string;
  /** The PR base branch (defaults to the project's branch). */
  baseBranch?: string;
  /**
   * The email domain a participant known only by an alias is credited at
   * (the org profile's identity.emailDomain); unset, such a participant
   * isn't credited.
   */
  coAuthorEmailDomain?: string;
}

export interface ReviewArtifactOptions {
  /** When true (the default in this build and all tests), compose only — never write a file or spawn a CLI. */
  dryRun: boolean;
}

/** A composed draft-PR request, ready to hand to `gh`/the GitHub API. */
export interface DraftPrRequest {
  draft: true;
  title: string;
  body: string;
  base?: string;
  head?: string;
}

export interface ReviewArtifactResult {
  providerId: CodeReviewAdapterId;
  /** The shell command that would create the review (composed, not run); absent when the adapter composes none. */
  command?: string;
  /** The description/body file the command references, when the adapter uses one. */
  descriptionFile?: { path: string; contents: string };
  /**
   * The existing description file a revision of an already-cut review updates
   * in place, so the agent's edits stay; `fallback` is the skeleton to start
   * from only when that file is gone (a new worktree, a hand-cut review).
   */
  reviseDescriptionFile?: { path: string; fallback: string };
  /** The structured draft-PR request (GitHub adapter). */
  request?: DraftPrRequest;
  /** `Co-authored-by:` trailer lines derived from the participants. */
  coAuthors: string[];
  /**
   * Human-fill placeholders present in `command` (as `<…>` tokens) that the
   * launched agent MUST resolve before running it — e.g. the tracking issue id
   * when none was known at compose time. Empty when the command is ready as-is.
   */
  placeholders: string[];
  /** Set only when the adapter actually created the review (never in dryRun). */
  url?: string;
  id?: string;
}

/**
 * The code-review seam: how a project's changes are reviewed — whether its
 * review packets must link a review, how a review link reads, how a worker
 * cuts one, and the composed command a review gate hands the worker. An
 * adapter only composes; it never runs the outward action itself.
 */
export interface CodeReviewAdapter {
  readonly id: CodeReviewAdapterId;
  /** What one review is called in prose ("code review", "pull request"). */
  readonly noun: string;
  /** How this adapter's review links read. */
  readonly linkFormat: CodeReviewLinkFormat;
  /** Whether the adapter fits a project that pins none (the first that fits is used). */
  detect(project: Project): boolean;
  /**
   * Whether a git remote URL is on a code host this adapter reviews on: a
   * checkout with such a remote has a review to cut, so its code_review stage
   * applies and its project gets the full pipeline preset.
   */
  ownsRemote(url: string): boolean;
  /**
   * Whether ownsRemote can be true for any url. Selection reads a project's
   * checkouts' remotes (git) only to ask an adapter that can own one.
   */
  readonly ownsRemotes: boolean;
  /**
   * Whether the project's review packets must link the change's review, and
   * its code_review stage applies whatever its checkout shows.
   */
  requiresLinkedReview(project: Project): boolean;
  /**
   * Whether cutting a review needs an issue id from the owner (the review
   * tool attaches one): the project's code_review stage then refuses a
   * worker's report without `issueId`, and the run waits for the owner to
   * give one. False for a review that names no issue (a pull request).
   */
  requiresIssueId(project: Project): boolean;
  /** How a worker cuts a new review — or revises `prior`, the launch's own — as one sentence. */
  howToCut(opts: { prior: CodeReviewRef | null }): string;
  /** The link a packet adds for `ref`, or a template one when no review is known yet. */
  exampleLink(ref?: CodeReviewRef | null): ReviewLink;
  /** Composes the review for the change (dryRun: returned, never run). */
  compose(ctx: ReviewArtifactContext, opts: ReviewArtifactOptions): Promise<ReviewArtifactResult>;
}
