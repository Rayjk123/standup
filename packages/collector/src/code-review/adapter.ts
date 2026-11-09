import type { CodeReviewLinkFormat, PipelinePresetId, Project } from "@standup/shared";
import { activeOrgProfile } from "../org-profile/load.js";
import type { OrgProfile } from "../org-profile/types.js";
import { genericCodeReviewAdapter } from "./generic.js";
import { GITHUB_PR_ADAPTER } from "./github-pr.js";
import type { CodeReviewAdapter } from "./types.js";

/**
 * The built-in code-review adapters over `profile`, in detection order. The
 * `generic` adapter detects only a project the profile's
 * codeReview.provisionPatterns or launchSubdirPatterns match (none under the
 * default profile; a project opts in with `codeReviewAdapter = "generic"`);
 * `github-pr` fits any project with a repo.
 */
export function codeReviewAdapters(profile: OrgProfile = activeOrgProfile()): readonly CodeReviewAdapter[] {
  return [genericCodeReviewAdapter(profile), GITHUB_PR_ADAPTER];
}

/**
 * A project's checkouts' remotes, as selection reads them: the urls, null
 * when git could read no checkout, or a function that reads them — called at
 * most once per resolve, and only when selection gets to an adapter that can
 * own a remote (CodeReviewAdapter.ownsRemotes): a pinned project, one an
 * earlier adapter detects, or one under a profile where no adapter owns any
 * remote never reads them.
 */
export type CodeReviewRemotes = string[] | null | (() => string[] | null);

/** The urls `remotes` holds, calling it when it is a reader; undefined stays undefined (not read). */
export function readCodeReviewRemotes(remotes: CodeReviewRemotes | undefined): string[] | null | undefined {
  return typeof remotes === "function" ? remotes() : remotes;
}

/** What selecting a project's adapter reads: its checkouts' remotes and the org profile (the active one when omitted). */
export interface CodeReviewResolveOptions {
  remotes?: CodeReviewRemotes;
  profile?: OrgProfile;
}

/**
 * The adapter for a project, the one source for how its review is composed,
 * how a worker is told to cut it and whether cutting it needs an issue id:
 * the adapter it pins via `codeReviewAdapter`, else the first, in detection
 * order, whose `detect` matches or that owns one of its checkouts' remotes
 * (`opts.remotes`, see CodeReviewAdapter.ownsRemote), so a checkout on the
 * org's code host is reviewed with the org's review tool. Null when nothing
 * fits (a repo-less scratch project whose remotes no adapter owns).
 */
export function selectCodeReviewAdapter(
  project: Project,
  profile: OrgProfile = activeOrgProfile(),
  opts: { remotes?: CodeReviewRemotes } = {}
): CodeReviewAdapter | null {
  const adapters = codeReviewAdapters(profile);
  if (project.codeReviewAdapter) return adapters.find((a) => a.id === project.codeReviewAdapter) ?? null;
  let read: string[] | undefined;
  const remotes = (): string[] => {
    if (read === undefined) read = readCodeReviewRemotes(opts.remotes) ?? [];
    return read;
  };
  return adapters.find((a) => a.detect(project) || (a.ownsRemotes && remotes().some((url) => a.ownsRemote(url)))) ?? null;
}

/**
 * A project's code review as its adapter has it: the adapter
 * (selectCodeReviewAdapter, over its checkouts' remotes) and what that one
 * adapter says about the project. Every question about a project's review —
 * whether it needs an issue id, whether its packets must link it, how its
 * links read, how it is composed and cut — is answered from one resolution,
 * so none of them comes from a different adapter than another.
 */
export interface ProjectCodeReview {
  /** The project's adapter, or null when nothing fits (or there is no project). */
  readonly adapter: CodeReviewAdapter | null;
  /** Whether its review packets must link the change's code review (CodeReviewAdapter.requiresLinkedReview). */
  readonly requiresLinkedReview: boolean;
  /** Whether cutting its code review needs an issue id from the owner (CodeReviewAdapter.requiresIssueId). */
  readonly requiresIssueId: boolean;
  /** How its review links read: the adapter's format, else any http(s) URL. */
  readonly linkFormat: CodeReviewLinkFormat;
}

/** `project`'s code review (see ProjectCodeReview): its adapter selected once over `opts.remotes`, and that adapter's answers. */
export function resolveProjectCodeReview(project: Project | null | undefined, opts: CodeReviewResolveOptions = {}): ProjectCodeReview {
  const adapter = project ? selectCodeReviewAdapter(project, opts.profile ?? activeOrgProfile(), { remotes: opts.remotes }) : null;
  return {
    adapter,
    requiresLinkedReview: !!project && !!adapter?.requiresLinkedReview(project),
    requiresIssueId: !!project && !!adapter?.requiresIssueId(project),
    linkFormat: adapter?.linkFormat ?? {},
  };
}

/** Whether `project`'s review packets must link the change's code review: resolveProjectCodeReview's say over `opts.remotes`. */
export function projectRequiresLinkedReview(project: Project | null | undefined, opts: CodeReviewResolveOptions = {}): boolean {
  return resolveProjectCodeReview(project, opts).requiresLinkedReview;
}

/**
 * Whether cutting `project`'s code review needs an issue id from the owner
 * (see CodeReviewAdapter.requiresIssueId): the say of the adapter
 * resolveProjectCodeReview picks for it and its checkouts' remotes
 * (`opts.remotes`), the same adapter that composes the review and tells the
 * worker how to cut it given those remotes, so a project is asked for an
 * issue id exactly when its cut command takes one.
 */
export function projectRequiresIssueId(project: Project | null | undefined, opts: CodeReviewResolveOptions = {}): boolean {
  return resolveProjectCodeReview(project, opts).requiresIssueId;
}

/** How `project`'s review links read: resolveProjectCodeReview's format over `opts.remotes`, else any http(s) URL. */
export function projectReviewLinkFormat(project: Project | null | undefined, opts: CodeReviewResolveOptions = {}): CodeReviewLinkFormat {
  return resolveProjectCodeReview(project, opts).linkFormat;
}

/**
 * Whether a git remote URL is on a code host some adapter reviews on (see
 * CodeReviewAdapter.ownsRemote): a change there is pushed for review, not
 * merged straight to its target branch.
 */
export function codeReviewRemote(url: string, profile: OrgProfile = activeOrgProfile()): boolean {
  return codeReviewAdapters(profile).some((a) => a.ownsRemote(url));
}

/**
 * The pipeline preset a project gets when no layer names one. `full` when it
 * cuts code reviews — its adapter requires a linked review, a review gate (a
 * review command or review agent) finishes them, or one of its checkout's
 * remotes (`opts.remotes`) is on a code host an adapter reviews on — and
 * whenever that can't be ruled out: an unknown project, or one whose
 * checkout's remotes weren't read (null or omitted: no repo git could read),
 * fails toward the stricter flow. `light` for a plain git repo, whose remotes
 * were read and are none of those (or it has none). A reader for `remotes`
 * is called only past the review gate check, and at most once.
 */
export function projectPipelinePreset(
  project: Project | null | undefined,
  opts: { remotes?: CodeReviewRemotes; profile?: OrgProfile } = {}
): PipelinePresetId {
  if (!project) return "full";
  const profile = opts.profile ?? activeOrgProfile();
  if (project.reviewProcess === "command" || project.reviewProcess === "review-agent") return "full";
  const remotes = readCodeReviewRemotes(opts.remotes);
  if (projectRequiresLinkedReview(project, { profile, remotes })) return "full";
  if (!remotes || remotes.some((url) => codeReviewRemote(url, profile))) return "full";
  return "light";
}
