import type { Database } from "bun:sqlite";
import { getReviewFindingsByTicket, isHighSeverity } from "@standup/store";
import type {
  Launch,
  ReviewCommentEvent,
  ReviewCommentsPayload,
  ReviewFinding,
  ReviewFindingStatus,
  ReviewInlineComment,
  Ticket,
} from "@standup/shared";
import { isRealBranch } from "./publisher.js";
import { shquote } from "./shell.js";

/**
 * Posting the auto-review findings to the minted PR.
 *
 * Once the Publisher seam has minted a ticket's draft PR, this module maps that
 * ticket's `review_findings` onto GitHub inline review comments and assembles the
 * reviews-API payload that would post them. It is the review-comment counterpart
 * to the Publisher: the PR is the unit of output, and the auto-reviewer's
 * highest-severity findings become the review that lands on it.
 *
 * De-noise carries over from the reviewer/fixer split: only the highest-severity
 * tier — High/critical, the blocking findings — is posted, and only the ones that
 * anchor to a `file:line` become inline comments (a High finding with no location
 * is summarized into the review body rather than dropped). Low/medium findings are
 * recorded in the store but never pushed at the PR.
 *
 * Everything here is DRY-RUN by default: composeReviewComments returns the exact
 * inline-comment payload WITHOUT touching the network. The actual post is a human
 * step done later — gated behind `opts.live`, which is OFF in this build (setting
 * it throws before anything external could run), the same flag the Publisher uses.
 * So the composed `commands` are RETURNED for a human to run, never executed here.
 */

/** Reference to the minted PR the review lands on. */
export interface ReviewCommentsPrRef {
  /**
   * The PR's number, once a human has opened the minted draft. Absent pre-mint —
   * the composer then leaves a `<pr-number>` placeholder in the command for the
   * human to fill after opening the PR.
   */
  number?: number;
  /**
   * The `owner/repo` slug for the reviews-API path. Absent when it can't be
   * resolved from the project — a `<owner/repo>` placeholder rides the command.
   */
  repo?: string;
  /** The PR head branch the change lives on (from the publish preview), for reference. */
  branch?: string;
  /**
   * Where the payload file is written — the change's worktree, alongside the
   * Publisher's PR-body file. Defaults to the current directory when unknown.
   */
  worktreePath?: string;
}

export interface ReviewCommentsOptions {
  /**
   * OFF in this build. When true, composeReviewComments throws immediately: a live
   * post (`gh api … reviews`) is a human step, never automated here, so no path in
   * this build performs the outward action.
   */
  live?: boolean;
  /**
   * Override the review verdict. Defaults to REQUEST_CHANGES when there is any
   * blocking finding, else COMMENT.
   */
  event?: ReviewCommentEvent;
}

/**
 * Finding statuses that still represent a live concern in the change, so belong
 * on the PR review. Mirrors the Publisher's PR-body filter: a `superseded`
 * finding was replaced on re-review and a `dismissed` one is a human "won't fix",
 * so posting either would misrepresent the change's review state.
 */
const ACTIVE_FINDING_STATUSES: ReadonlySet<ReviewFindingStatus> = new Set([
  "open",
  "dispatched",
]);

/** The path a live post writes the reviews-API payload to, alongside the worktree. */
function payloadPath(worktreePath: string | undefined): string {
  const root = worktreePath?.replace(/\/$/, "") || ".";
  return `${root}/.standup-pr-review.json`;
}

/** The heredoc delimiter for the payload write — distinctive so it won't collide with body text. */
const REVIEW_PAYLOAD_HEREDOC = "STANDUP_PR_REVIEW";

/**
 * The `cat` command that writes the reviews-API JSON to the path `gh api
 * --input` reads. The path is shell-quoted as a single word — the worktree root
 * is a user/UI/env-configurable value, so a real path like `/Users/foo/My
 * Code/widget/…` would otherwise split into an ambiguous redirect. A quoted
 * heredoc delimiter (`<<'…'`) suppresses every shell expansion, so a finding body
 * carrying `$(...)`, backticks, or `$VAR` is written literally and cannot run code
 * when a human pastes the sequence.
 */
function composePayloadFileWrite(path: string, contents: string): string {
  return `cat > ${shquote(path)} <<'${REVIEW_PAYLOAD_HEREDOC}'\n${contents}\n${REVIEW_PAYLOAD_HEREDOC}`;
}

/** Placeholder tokens the command carries when the PR ref isn't fully known yet. */
const REPO_PLACEHOLDER = "<owner/repo>";
const PR_NUMBER_PLACEHOLDER = "<pr-number>";

/**
 * The inline-comment body for a finding: the severity-tagged title as a bold
 * lead, then the finding body when it has one. This is the text GitHub renders on
 * the diff line the finding anchors to.
 */
function composeCommentBody(finding: ReviewFinding): string {
  const head = `**[${finding.severity}] ${finding.title.trim()}**`;
  const body = finding.body.trim();
  return body ? `${head}\n\n${body}` : head;
}

/**
 * Maps a ticket's review findings onto the DRY-RUN GitHub reviews-API payload for
 * its minted PR. Pure — no network, no filesystem — so it is fully unit-testable
 * and safe to call in this build. Setting `opts.live` throws: a live post is a
 * human step not enabled here.
 *
 * Only the highest-severity tier survives the filter — High/critical findings
 * that are still active (open or fixer-in-flight). Of those, the ones that anchor
 * to a `file:line` become inline `comments`; a High finding with no location is
 * folded into the review `body` (so it isn't lost) and noted in `warnings`.
 * Low/medium findings are excluded entirely — they are recorded but never posted.
 */
export function composeReviewComments(
  findings: ReviewFinding[],
  ref: ReviewCommentsPrRef,
  opts: ReviewCommentsOptions = {}
): ReviewCommentsPayload {
  if (opts.live) {
    // A live post would call `gh api … /reviews` here. This build never performs
    // the outward action — a human runs the returned commands — so refuse rather
    // than silently doing nothing.
    throw new Error("Review comments: live post is not enabled in this build");
  }

  // The highest-severity tier only: High/critical, still-active findings. This is
  // the same de-noise the Work review-queue applies — low/medium are recorded but
  // never pushed at the human.
  const blocking = findings.filter(
    (f) => isHighSeverity(f.severity) && ACTIVE_FINDING_STATUSES.has(f.status)
  );

  const comments: ReviewInlineComment[] = [];
  const unanchored: ReviewFinding[] = [];
  for (const f of blocking) {
    const path = f.file?.trim();
    // An inline comment must anchor to a diff line: GitHub needs both a path and a
    // line. A blocking finding with no location can't be pinned to the diff, so it
    // rides the review body instead of being dropped.
    if (path && typeof f.line === "number") {
      comments.push({ path, line: f.line, body: composeCommentBody(f) });
    } else {
      unanchored.push(f);
    }
  }

  const warnings: string[] = [];
  const bodyLines: string[] = [];
  const totalBlocking = comments.length + unanchored.length;
  bodyLines.push(
    totalBlocking === 0
      ? "Standup auto-review found no blocking findings on this change."
      : `Standup auto-review flagged ${totalBlocking} blocking finding${totalBlocking === 1 ? "" : "s"} on this change.`
  );
  if (unanchored.length) {
    // Surfaced in the review body (they have no diff line to anchor to) and called
    // out as a warning so a human knows they weren't posted inline.
    bodyLines.push("", "Findings without a code location:");
    for (const f of unanchored) bodyLines.push(`- **[${f.severity}]** ${f.title.trim()}`);
    warnings.push(
      `${unanchored.length} High finding${unanchored.length === 1 ? "" : "s"} had no file/line to anchor inline — listed in the review body instead.`
    );
  }
  const body = bodyLines.join("\n");

  // REQUEST_CHANGES whenever a blocking finding is present — the change should not
  // merge as-is; COMMENT only when nothing blocking survives the filter. An
  // explicit opts.event wins.
  const event: ReviewCommentEvent =
    opts.event ?? (totalBlocking > 0 ? "REQUEST_CHANGES" : "COMMENT");

  const reviewRequest = { event, body, comments };

  // `gh pr review` cannot carry inline comments, so the review rides the REST
  // reviews endpoint via `gh api --input`. The PR number and repo are placeholders
  // when unknown pre-mint — a human fills them once the draft PR is opened.
  const repo = ref.repo?.trim() || REPO_PLACEHOLDER;
  const prNumber = ref.number != null ? String(ref.number) : PR_NUMBER_PLACEHOLDER;
  const placeholders: string[] = [];
  if (repo === REPO_PLACEHOLDER) {
    placeholders.push(`${REPO_PLACEHOLDER} — the GitHub owner/repo the PR lives in`);
  }
  if (prNumber === PR_NUMBER_PLACEHOLDER) {
    placeholders.push(`${PR_NUMBER_PLACEHOLDER} — the minted PR's number (after it is opened)`);
  }

  const file = payloadPath(ref.worktreePath);
  const contents = JSON.stringify(reviewRequest, null, 2);
  // The reviews-API path carries the owner/repo slug, which can be a
  // free-text/mis-resolved value — so the whole path is shell-quoted as a single
  // word (the same defense the Publisher applies to the PR title). A legitimate
  // slug is unaffected: the shell strips the quotes back to the literal path,
  // and gh receives `/repos/owner/repo/pulls/n/reviews`. A hostile slug like
  // `foo;rm -rf ~` stays inert instead of running on paste. The `<owner/repo>`/
  // `<pr-number>` placeholders ride inside the quotes for a human to replace.
  const apiPath = shquote(`/repos/${repo}/pulls/${prNumber}/reviews`);
  // The payload file path is shell-quoted too: the worktree root it derives from
  // is user/UI/env-configurable, so a path with a space (`/Users/foo/My Code/…`)
  // would otherwise split into two args and gh would fail to find the input.
  const apiCmd = ["gh", "api", "--method", "POST", apiPath, "--input", shquote(file)].join(" ");

  // The payload file must exist before `gh api` reads it; write it right before.
  const commands = [composePayloadFileWrite(file, contents), apiCmd];

  return {
    ticketId: undefined,
    event,
    body,
    comments,
    prNumber: ref.number,
    repo: ref.repo?.trim() || undefined,
    branch: ref.branch,
    reviewRequest,
    payloadFile: { path: file, contents },
    commands,
    placeholders,
    live: false,
    warnings,
  };
}

/**
 * Store-backed convenience over composeReviewComments: reads the ticket's review
 * findings and composes the dry-run payload for its minted PR. The composer does
 * the highest-severity filtering, so the full finding set is passed through.
 */
export function reviewCommentsForTicket(
  db: Database,
  input: { ticket: Ticket; ref: ReviewCommentsPrRef },
  opts: ReviewCommentsOptions = {}
): ReviewCommentsPayload {
  const findings = getReviewFindingsByTicket(db, input.ticket.id);
  const payload = composeReviewComments(findings, input.ref, opts);
  payload.ticketId = input.ticket.id;
  return payload;
}

/**
 * Builds the PR ref from a ticket's implementation launch — the linkage to the
 * minted PR. The head branch and worktree are the SAME ones the Publisher mints
 * the draft PR from (isRealBranch skips the launcher's parenthetical markers for
 * a scratch/in-place/adopted launch), so the composed review targets that PR and
 * its payload file lands beside the PR body in the change's worktree.
 *
 * The PR number and owner/repo slug are left unresolved: the draft PR is not
 * opened until a human runs the Publisher's commands, and no owner/repo resolver
 * is wired — so the composer carries `<pr-number>`/`<owner/repo>` placeholders a
 * human fills in once the PR exists.
 */
export function reviewCommentsPrRefFromLaunch(
  launch: Launch | null | undefined
): ReviewCommentsPrRef {
  const branch = isRealBranch(launch?.branch) ? launch!.branch : undefined;
  return { branch, worktreePath: launch?.worktreePath };
}
