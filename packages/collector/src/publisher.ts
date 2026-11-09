import type { Database } from "bun:sqlite";
import { getReviewFindingsByTicket } from "@standup/store";
import type {
  DraftPrPayload,
  Launch,
  Project,
  ReviewFinding,
  ReviewFindingStatus,
  Ticket,
  TicketPublishPreview,
} from "@standup/shared";
import { randomBytes } from "crypto";
import { activeOrgProfile } from "./org-profile/load.js";
import {
  coAuthorTrailers,
  participantsForCoAuthors,
  uncreditedParticipants,
  type ReviewArtifactParticipant,
} from "./review-artifact.js";
import { shquote } from "./shell.js";

/**
 * The Publisher seam: the PR IS the unit of output. When a ticket ships, its
 * completed change is assembled into a DRAFT pull request — the branch, a commit
 * message carrying `Co-authored-by` trailers for every distinct session
 * participant (mirroring OpenClaw's github_publish), and a draft-PR payload whose
 * body links the ticket and its review findings.
 *
 * Everything here is DRY-RUN by default: composeTicketPublish returns the whole
 * payload WITHOUT touching git, the filesystem, or the network. The actual push
 * and `gh pr create --draft` are a human step done later — a live publish is
 * gated behind `opts.live`, which is OFF in this build (setting it throws before
 * anything external could run). So the composed `commands` are RETURNED for a
 * human to run, never executed here.
 *
 * The composed `commands` are a self-contained, runnable-verbatim sequence: write
 * the PR body file the `gh` command reads, bake the deduped `Co-authored-by`
 * trailers onto the branch's HEAD commit (so co-authorship lands where git/GitHub
 * read it), push, then open the draft PR.
 */

/** What the Publisher composes a ticket's draft PR from. */
export interface PublishContext {
  ticket: Ticket;
  project: Project;
  /**
   * The ticket's implementation launch — the source of the head branch, base
   * branch, and worktree. Absent (an externally-claimed ticket that never
   * dispatched a Standup launch) leaves the head unknown, surfaced as a warning.
   */
  launch?: Launch | null;
  /** Distinct collaborators on the change, resolved from `session_participants`. */
  participants: ReviewArtifactParticipant[];
  /** The ticket's review findings — listed in the PR body. */
  findings: ReviewFinding[];
}

export interface PublishOptions {
  /**
   * OFF in this build. When true, composeTicketPublish throws immediately: a live
   * publish (git push + `gh pr create --draft`) is a human step, never automated
   * here, so no path in this build performs the outward action.
   */
  live?: boolean;
}

/**
 * Whether a launch's `branch` is a real git branch usable as a PR head, as
 * opposed to a parenthetical marker the launcher records for a launch that has
 * no branch of its own — `(scratch — no repo)`, `(in-place — existing
 * workspace)`, `(adopted — no worktree)`, `(provisioned — no worktree)`. Only a
 * real branch can be pushed and set as `--head`.
 */
export function isRealBranch(branch: string | undefined): branch is string {
  return !!branch && !branch.trimStart().startsWith("(");
}

/**
 * The commit message a live publish would use: the ticket title as the subject,
 * the ticket body (when non-empty), then the `Co-authored-by` trailers separated
 * by a blank line. Trailers go on the COMMIT, not the PR body — git and GitHub
 * credit co-authorship from the commit message, so placing them in the PR body
 * would leave them inert.
 */
function composeCommitMessage(title: string, body: string, coAuthors: string[]): string {
  const parts: string[] = [title.trim()];
  const trimmedBody = body.trim();
  if (trimmedBody) parts.push("", trimmedBody);
  if (coAuthors.length) parts.push("", coAuthors.join("\n"));
  return parts.join("\n");
}

/**
 * Finding statuses that still represent a live concern in the change, so belong
 * in the PR body. A `superseded` finding was replaced by a fresh one on
 * re-review (needs_review -> developing -> needs_review) and a `dismissed` one is
 * a human "won't fix" verdict — listing either would misrepresent the change's
 * review state: a resolved issue shown as an open defect, or the same issue
 * duplicated across its old superseded row and its re-reviewed replacement.
 */
const ACTIVE_FINDING_STATUSES: ReadonlySet<ReviewFindingStatus> = new Set([
  "open",
  "dispatched",
]);

/**
 * The draft-PR body: the ticket body, then a linked reference to the ticket (its
 * id, lens, severity, and the tracking task when one is set) and a bulleted list
 * of its still-active review findings (superseded/dismissed rows are filtered
 * out — see ACTIVE_FINDING_STATUSES). This is what makes the PR self-describing —
 * a reviewer opening it sees the change's ticket and the open findings inline.
 * Co-author trailers are deliberately NOT here (they belong on the commit).
 */
function composePrBody(ticket: Ticket, findings: ReviewFinding[]): string {
  const lines: string[] = [];

  const body = ticket.body.trim();
  if (body) lines.push(body, "");

  lines.push("---");
  lines.push(`Ticket \`${ticket.id}\` · ${ticket.lens} · ${ticket.severity}`);
  if (ticket.issueId) {
    lines.push(
      ticket.taskUrl
        ? `Tracking: [${ticket.issueId}](${ticket.taskUrl})`
        : `Tracking: ${ticket.issueId}`
    );
  }

  const activeFindings = findings.filter((f) => ACTIVE_FINDING_STATUSES.has(f.status));
  if (activeFindings.length) {
    lines.push("", "## Review findings");
    for (const f of activeFindings) {
      const loc = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : "";
      lines.push(`- **${f.severity}** ${f.title}${loc}`);
    }
  }

  return lines.join("\n");
}

/** The path a live publish would write the PR body to, alongside the worktree. */
function prBodyPath(worktreePath: string | undefined): string {
  const root = worktreePath?.replace(/\/$/, "") || ".";
  return `${root}/.standup-pr-body.md`;
}

/** The base heredoc delimiter for the PR-body write — distinctive so it rarely collides with body text. */
const PR_BODY_HEREDOC_BASE = "STANDUP_PR_BODY";

/**
 * A heredoc delimiter that does not appear as its own line anywhere in `body`.
 * A fixed delimiter is unsafe: a body/finding whose text contains a line equal to
 * the delimiter would terminate the heredoc early and hand the shell the
 * remainder as commands to execute. Starting from the distinctive base, on any
 * collision it appends random hex and re-checks until the delimiter is absent, so
 * the terminator is always unambiguous. The common case (no collision) keeps the
 * bare base, so the composed command stays stable.
 */
function chooseHeredocDelimiter(body: string): string {
  const lines = new Set(body.split("\n"));
  let delimiter = PR_BODY_HEREDOC_BASE;
  while (lines.has(delimiter)) {
    delimiter = `${PR_BODY_HEREDOC_BASE}_${randomBytes(6).toString("hex").toUpperCase()}`;
  }
  return delimiter;
}

/**
 * The `cat` command that writes the PR body to the path `gh … --body-file` reads.
 * The path is shell-quoted as a single word — the worktree root is a
 * user/UI/env-configurable value, so a real path like `/Users/foo/My Code/widget/…`
 * would otherwise split into an ambiguous redirect. A quoted heredoc delimiter
 * (`<<'…'`) suppresses every shell expansion, so a multi-line body carrying
 * `$(...)`, backticks, or `$VAR` is written literally and cannot run code when a
 * human pastes the sequence — the same reason the body rides a file rather than a
 * shell-escaped `--body`. The delimiter is collision-checked against the body so
 * a body containing the delimiter line cannot close the heredoc early.
 */
function composeBodyFileWrite(path: string, body: string): string {
  const delimiter = chooseHeredocDelimiter(body);
  return `cat > ${shquote(path)} <<'${delimiter}'\n${body}\n${delimiter}`;
}

/**
 * `git commit --amend` that appends the deduped `Co-authored-by` trailers to the
 * branch's HEAD commit. `--no-edit` preserves the existing message and only adds
 * the trailers, so co-authorship lands on a real commit (git/GitHub read it from
 * the commit's trailer block, not the PR body) without rewriting the agent's
 * authored message. Each trailer is single-quoted so its `<email>` angle brackets
 * are inert to the shell.
 */
function composeTrailerAmend(gitCmd: string, coAuthors: string[]): string {
  const trailerFlags = coAuthors.map((t) => `--trailer ${shquote(t)}`).join(" ");
  return `${gitCmd} commit --amend --no-edit ${trailerFlags}`;
}

/**
 * Composes the DRY-RUN draft-PR preview for a ticket's change. Pure — no git, no
 * filesystem, no network — so it is fully unit-testable and safe to call in this
 * build. Setting `opts.live` throws: a live publish is a human step not enabled
 * here, so this function never performs the push or the `gh` call itself.
 */
export function composeTicketPublish(
  ctx: PublishContext,
  opts: PublishOptions = {}
): TicketPublishPreview {
  if (opts.live) {
    // A live publish would `git push` and call `gh pr create --draft` here. This
    // build never performs the outward action — a human runs the returned
    // commands — so refuse rather than silently doing nothing.
    throw new Error("Publisher: live publish is not enabled in this build");
  }

  const { ticket, project, launch } = ctx;

  const branch = isRealBranch(launch?.branch) ? launch!.branch : undefined;
  const baseBranch = launch?.baseBranch?.trim() || project.branch;

  // GitHub best-effort matches a `Co-authored-by` address; a participant
  // known only by a user alias is credited through the org profile's email
  // domain — the same path the code-review adapters use.
  const emailDomain = activeOrgProfile().identity.emailDomain;
  const coAuthors = coAuthorTrailers(ctx.participants, emailDomain);
  const commitMessage = composeCommitMessage(ticket.title, ticket.body, coAuthors);
  const body = composePrBody(ticket, ctx.findings);

  const pr: DraftPrPayload = {
    draft: true,
    title: ticket.title,
    body,
    base: baseBranch,
    head: branch,
  };

  const warnings: string[] = [];

  // A genuine collaborator with no derivable email — a scheme-prefixed id
  // (`slack:U…`) never reconciled to a user alias — is dropped from the
  // trailers rather than credited with a guessed address. Surface it as a
  // visible warning so the change is not silently under-credited; a human can
  // reconcile the identity or add the trailer by hand.
  const uncredited = uncreditedParticipants(ctx.participants, emailDomain);
  if (uncredited.length) {
    const names = uncredited.map((p) => p.display?.trim() || p.actorId).join(", ");
    warnings.push(
      `${uncredited.length} participant(s) could not be credited as Co-authored-by — no ` +
        `resolvable email (e.g. a slack:U… id never reconciled to a user alias): ${names}. ` +
        "Reconcile the identity or add the trailer by hand so they are not under-credited."
    );
  }

  // The multi-line body rides `--body-file` (never a shell-escaped `--body`,
  // which would embed literal `\n` a POSIX shell won't expand). The file is
  // paired with the body via `descriptionFile` AND written by the first composed
  // command, so the sequence is runnable as-is — this build composes it, never
  // executes it. Every interpolated value (title, base/head branch, worktree and
  // body-file path) is single-quoted with shquote (never `JSON.stringify`, whose
  // double quotes still let a shell run `$(...)`/backticks/`$VAR`): the branch and
  // worktree derive from launcher/UI/env-configurable input, so an
  // attacker-influenced value must be inert when the human pastes this line.
  const bodyFile = prBodyPath(launch?.worktreePath);
  const descriptionFile = { path: bodyFile, contents: body };
  const ghParts = ["gh", "pr", "create", "--draft", "--title", shquote(ticket.title)];
  ghParts.push("--base", shquote(baseBranch));
  if (branch) ghParts.push("--head", shquote(branch));
  ghParts.push("--body-file", shquote(bodyFile));

  // `-C <worktree>` is shell-quoted for the same reason — an unquoted path with a
  // space would split `-C` off from a stray second word and misdirect git.
  const gitCmd = launch?.worktreePath ? `git -C ${shquote(launch.worktreePath)}` : "git";
  const commands: string[] = [];
  if (branch) {
    // Bake the trailers onto the commit BEFORE pushing, so the pushed branch —
    // and the PR opened from it — carries the co-author credit. Skipped when
    // there is nothing to credit.
    if (coAuthors.length) commands.push(composeTrailerAmend(gitCmd, coAuthors));
    // The branch is shell-quoted for the same reason as the base — a branch name
    // carrying a space or shell metacharacter must not word-split or expand.
    commands.push(`${gitCmd} push -u origin ${shquote(branch)}`);
  } else {
    warnings.push(
      "No worktree branch is resolvable for this ticket (in-place/scratch/adopted or no launch), " +
        "so the PR head is unknown — bake the Co-authored-by trailers onto the commit, push the " +
        "change's branch, and set --head by hand."
    );
  }
  // The body file must exist before `gh` reads it; write it right before.
  commands.push(composeBodyFileWrite(bodyFile, body));
  commands.push(ghParts.join(" "));

  return {
    ticketId: ticket.id,
    branch,
    baseBranch,
    commitMessage,
    coAuthors,
    pr,
    descriptionFile,
    commands,
    live: false,
    warnings,
  };
}

/**
 * Store-backed convenience over composeTicketPublish: gathers the ticket's
 * distinct session participants (resolved through their canonical actor, so a
 * merged duplicate is credited once) and its review findings, then composes the
 * dry-run preview. This is what the /api/tickets/:id/publish route calls.
 */
export function publishTicket(
  db: Database,
  input: { ticket: Ticket; project: Project; launch?: Launch | null },
  opts: PublishOptions = {}
): TicketPublishPreview {
  const participants = input.ticket.sessionId
    ? participantsForCoAuthors(db, input.ticket.sessionId)
    : [];
  const findings = getReviewFindingsByTicket(db, input.ticket.id);
  return composeTicketPublish(
    { ticket: input.ticket, project: input.project, launch: input.launch, participants, findings },
    opts
  );
}
