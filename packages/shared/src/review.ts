// ============================================================================
// Review packets — what a worker hands a human for sign-off: the intent, the
// change areas (with optional diff hunks), how it was validated, open risks,
// links and captioned media. The collector persists packets and serves them to
// the Review tab; the human_review pipeline stage waits on the decision.
// No node imports: the web bundles this file.
// ============================================================================

import type { CodeReviewRef } from "./code-review.js";
import type { PipelineDisabledReason, PipelineRunStatus, PipelineWaiver } from "./pipeline.js";
import type { ShareState } from "./share.js";

export type ReviewStatus = "draft" | "pending" | "approved" | "changes_requested" | "superseded";
export type ReviewDecision = "approved" | "changes_requested";

export interface ReviewHunk {
  file: string;
  /** The hunk's `@@ … @@` line or a short label. */
  header?: string;
  diff: string;
}

/** One area of the change, explained in bullets, with the files it covers. */
export interface ReviewChangeArea {
  area: string;
  bullets: string[];
  files?: string[];
  hunks?: ReviewHunk[];
}

export interface ReviewValidationSample {
  label: string;
  input: string;
  output: string;
}

export interface ReviewValidation {
  samples: ReviewValidationSample[];
  tests?: { summary: string; passed?: number; failed?: number };
}

export interface ReviewRisks {
  risks: string[];
  questions: string[];
}

/** A link's kind: `code_review` names the change's code review (see code-review.ts). */
export type ReviewLinkKind = "code_review" | "deploy" | "stack" | "other";

export interface ReviewLink {
  kind: ReviewLinkKind;
  label: string;
  url: string;
}

export type ReviewMediaKind = "image" | "video";

export interface ReviewMediaInfo {
  id: string;
  kind: ReviewMediaKind;
  mime: string;
  bytes: number;
  caption: string;
  position: number;
  /** `/api/reviews/<packetId>/media/<id>`. */
  url: string;
}

/** A remark (left with a decision or not), the owner's question, or an answer to one. */
export type ReviewCommentKind = "comment" | "question" | "answer";

/** Who a question was sent to (none: nobody could take it), or who wrote an answer. */
export type ReviewCommentVia = "worker" | "persona" | "none";

export interface ReviewComment {
  id: string;
  /** The person for a remark or question; the answering worker's session id, or "persona", for an answer. */
  author: string;
  body: string;
  /** Set when the comment was left with a decision. */
  decision: ReviewDecision | null;
  kind: ReviewCommentKind;
  /** A follow-up's thread-opening question, or the question an answer answers; null otherwise. */
  replyTo: string | null;
  via: ReviewCommentVia | null;
  createdAt: string;
}

/** The content a review-writer submits for a packet. */
export interface ReviewPacketDraft {
  title: string;
  /** 1–3 sentences: what the change is for. */
  intent: string;
  changes: ReviewChangeArea[];
  validation: ReviewValidation;
  risks: ReviewRisks;
  links: ReviewLink[];
}

/** A media file the review-writer attaches by local path. */
export interface ReviewMediaInput {
  path: string;
  caption: string;
}

export interface ReviewPacket extends ReviewPacketDraft {
  id: string;
  owner: string;
  projectId: string | null;
  launchId: string | null;
  jobId: string | null;
  sessionId: string | null;
  pipelineRunId: string | null;
  branch: string | null;
  commitSha: string | null;
  baseSha: string | null;
  /**
   * The session that submitted the packet's latest revision, as the collector
   * resolved it from the request (null while a draft, or when only a cwd named it).
   */
  submittedBySession: string | null;
  /** Whether that session is its launch's own root worker session, not a subagent or another of the launch's sessions. */
  submittedByRootSession: boolean;
  /** Whether this revision came from a different session than the launch's previous revision did. */
  resubmittedFromOtherSession: boolean;
  status: ReviewStatus;
  /** 1-based submission count across the owner's packets for the same launch; 0 while a draft. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface ReviewPacketSummary {
  id: string;
  owner: string;
  projectId: string | null;
  /** The worker it came from (the Burrow puts a worker with a pending packet in the reading nook). */
  launchId: string | null;
  jobId: string | null;
  sessionId: string | null;
  branch: string | null;
  commitSha: string | null;
  title: string;
  intent: string;
  status: ReviewStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  imageCount: number;
  videoCount: number;
  /** While it is pending, the owner's questions on it that a worker or Persona was sent and has not answered yet. */
  openQuestions: number;
}

/**
 * Where the packet's launch stands in its delivery pipeline, for the
 * reviewer: whether the run was on, and every stage that was waived rather
 * than passed — by whom and why.
 */
export interface ReviewPipelineSummary {
  status: PipelineRunStatus;
  disabledReason?: PipelineDisabledReason;
  currentStage: string;
  waivers: PipelineWaiver[];
}

export type ReviewPacketDetail = ReviewPacket & {
  media: ReviewMediaInfo[];
  comments: ReviewComment[];
  /** The launch's pipeline run; null when the launch has none (or the packet no launch). */
  pipeline?: ReviewPipelineSummary | null;
  /**
   * The code review the packet's links name, read under the link format of
   * its project's code-review adapter (reviewPacketCodeReview); null when
   * they name none.
   */
  codeReview?: CodeReviewRef | null;
  /** Whether the packet is shared by link, and its share path; only on a person's own read. */
  share?: ReviewShareState;
};

// ── Sharing a packet by link ────────────────────────────────────────────────

/** Whether a packet is shared read-only by link (`/share/review/<token>` while on). */
export type ReviewShareState = ShareState;

export * from "./share.js";

/** A shared packet's media file, served only through the share token. */
export interface SharedReviewMedia {
  id: string;
  kind: ReviewMediaKind;
  mime: string;
  caption: string;
  position: number;
  /** `/api/share/reviews/<token>/media/<id>`. */
  url: string;
}

/**
 * Everything a share link shows: the packet's display content and nothing
 * else — no ids, owner, status, decisions, comments, links, risks, refs or
 * pipeline.
 */
export interface SharedReviewPacket {
  title: string;
  intent: string;
  changes: ReviewChangeArea[];
  validation: ReviewValidation;
  media: SharedReviewMedia[];
}

export const REVIEW_MAX_MEDIA = 20;
export const REVIEW_TITLE_MAX = 120;
export const REVIEW_INTENT_MAX = 600;
export const REVIEW_HUNK_MAX_CHARS = 4000;
export const REVIEW_MAX_HUNKS = 40;
export const REVIEW_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
/** The most media bytes, all files together, one submission may attach. */
export const REVIEW_SUBMIT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

/** The most packets and revisions one launch may submit for review. */
export const REVIEW_MAX_SUBMISSIONS_PER_LAUNCH = 20;
/**
 * The most stored media bytes one owner's packets may hold, superseded
 * packets' media included until pruned.
 */
export const REVIEW_OWNER_MEDIA_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The header a worker's review requests carry its launch's review token in.
 * The review token is the launch's own, distinct from the safety floor's
 * worker token: it lives only in an owner-only file (WORKER_TOKEN_FILE_ENV),
 * never in a command line or an environment.
 */
export const WORKER_TOKEN_HEADER = "x-standup-worker-token";
/**
 * The env var naming the file a launched worker's standup MCP server reads
 * its launch's review token from, at call time. It holds a path, never the token.
 */
export const WORKER_TOKEN_FILE_ENV = "STANDUP_WORKER_TOKEN_FILE";

/** C0/C1 controls, the line and paragraph separators, and bidi embeddings, overrides and isolates. */
function isUnsafeTextCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Worker-written text (a packet's title or intent) made safe to embed in a
 * line another agent reads: control characters and line breaks become spaces,
 * whitespace collapses, and it is clipped to `max` characters.
 */
export function flattenWorkerText(text: string, max: number): string {
  let cleaned = "";
  for (const ch of text) cleaned += isUnsafeTextCode(ch.codePointAt(0)!) ? " " : ch;
  const flat = cleaned.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** flattenWorkerText, JSON-quoted, so it reads as one quoted value and never as instructions. */
export function quoteWorkerText(text: string, max: number): string {
  return JSON.stringify(flattenWorkerText(text, max));
}

const REVIEW_LINK_KINDS: readonly ReviewLinkKind[] = ["code_review", "deploy", "stack", "other"];
const INTENT_MAX_SENTENCES = 3;
/** How many uncovered changed files a problem message names before summarizing the rest. */
const MISSING_FILES_SHOWN = 10;

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === "approved" || value === "changes_requested";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Abbreviations whose trailing dot does not end a sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\./gi;

/**
 * Counts sentences: runs of `.`, `!` or `?` followed by whitespace or the end,
 * plus trailing text with no terminator. A dot inside a token (`a.ts`, `v1.2`)
 * and the dot of a common abbreviation (`e.g.`) do not end a sentence.
 */
export function countSentences(text: string): number {
  const stripped = text.replace(ABBREVIATIONS, (m) => m.slice(0, -1)).trim();
  if (stripped.length === 0) return 0;
  const terminators = stripped.match(/[.!?]+["')\]]*(?=\s|$)/g)?.length ?? 0;
  const endsTerminated = /[.!?]["')\]]*$/.test(stripped);
  return terminators + (endsTerminated ? 0 : 1);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function stringArrayProblems(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [`${path} must be an array of strings`];
  return value.some((v) => typeof v !== "string") ? [`${path} must contain only strings`] : [];
}

/**
 * Checks a review packet draft before it is submitted. Returns human-readable
 * problems; empty means the draft is acceptable. `changedFiles`, when given,
 * must each be covered by some change area's `files` or a hunk's `file`;
 * `media`, when given, is checked for count and captions.
 */
export function validateReviewPacketDraft(
  p: unknown,
  opts: { changedFiles?: string[]; media?: ReviewMediaInput[] } = {}
): string[] {
  const problems: string[] = [];
  if (!isRecord(p)) return ["packet must be an object"];

  if (!isNonEmptyString(p.title)) problems.push("title must be a non-empty string");
  else if (p.title.length > REVIEW_TITLE_MAX) problems.push(`title must be at most ${REVIEW_TITLE_MAX} characters`);

  if (!isNonEmptyString(p.intent)) problems.push("intent must be a non-empty string");
  else {
    if (p.intent.length > REVIEW_INTENT_MAX) problems.push(`intent must be at most ${REVIEW_INTENT_MAX} characters`);
    const sentences = countSentences(p.intent);
    if (sentences > INTENT_MAX_SENTENCES) {
      problems.push(`intent must be 1–${INTENT_MAX_SENTENCES} sentences (found ${sentences})`);
    }
  }

  const covered = new Set<string>();
  if (!Array.isArray(p.changes) || p.changes.length === 0) {
    problems.push("changes must be a non-empty array of change areas");
  } else {
    let hunkCount = 0;
    p.changes.forEach((change: unknown, i: number) => {
      const path = `changes[${i}]`;
      if (!isRecord(change)) {
        problems.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(change.area)) problems.push(`${path}.area must be a non-empty string`);
      if (!Array.isArray(change.bullets) || !change.bullets.some(isNonEmptyString)) {
        problems.push(`${path}.bullets must contain at least one non-empty string`);
      } else if (change.bullets.some((b) => typeof b !== "string")) {
        problems.push(`${path}.bullets must contain only strings`);
      }
      if (change.files !== undefined) {
        const fileProblems = stringArrayProblems(change.files, `${path}.files`);
        problems.push(...fileProblems);
        if (fileProblems.length === 0) for (const f of change.files as string[]) covered.add(f);
      }
      if (change.hunks !== undefined) {
        if (!Array.isArray(change.hunks)) {
          problems.push(`${path}.hunks must be an array`);
          return;
        }
        change.hunks.forEach((hunk: unknown, j: number) => {
          hunkCount++;
          const hunkPath = `${path}.hunks[${j}]`;
          if (!isRecord(hunk)) {
            problems.push(`${hunkPath} must be an object`);
            return;
          }
          if (!isNonEmptyString(hunk.file)) problems.push(`${hunkPath}.file must be a non-empty string`);
          else covered.add(hunk.file);
          if (hunk.header !== undefined && typeof hunk.header !== "string") {
            problems.push(`${hunkPath}.header must be a string`);
          }
          if (typeof hunk.diff !== "string") problems.push(`${hunkPath}.diff must be a string`);
          else if (hunk.diff.length > REVIEW_HUNK_MAX_CHARS) {
            problems.push(`${hunkPath}.diff must be at most ${REVIEW_HUNK_MAX_CHARS} characters`);
          }
        });
      }
    });
    if (hunkCount > REVIEW_MAX_HUNKS) problems.push(`at most ${REVIEW_MAX_HUNKS} hunks in total (found ${hunkCount})`);
  }

  if (opts.changedFiles) {
    const missing = opts.changedFiles.filter((f) => !covered.has(f));
    if (missing.length > 0) {
      const shown = missing.slice(0, MISSING_FILES_SHOWN).join(", ");
      const more = missing.length > MISSING_FILES_SHOWN ? ` and ${missing.length - MISSING_FILES_SHOWN} more` : "";
      problems.push(`changed files not covered by any change area or hunk: ${shown}${more}`);
    }
  }

  if (!isRecord(p.validation)) {
    problems.push("validation must be an object");
  } else {
    const { samples, tests } = p.validation;
    let sampleCount = 0;
    if (!Array.isArray(samples)) problems.push("validation.samples must be an array");
    else {
      sampleCount = samples.length;
      samples.forEach((sample: unknown, i: number) => {
        const path = `validation.samples[${i}]`;
        if (!isRecord(sample)) {
          problems.push(`${path} must be an object`);
          return;
        }
        for (const key of ["label", "input", "output"] as const) {
          if (typeof sample[key] !== "string") problems.push(`${path}.${key} must be a string`);
        }
      });
    }
    let hasTests = false;
    if (tests !== undefined) {
      if (!isRecord(tests)) problems.push("validation.tests must be an object");
      else {
        if (typeof tests.summary !== "string") problems.push("validation.tests.summary must be a string");
        else hasTests = tests.summary.trim().length > 0;
        for (const key of ["passed", "failed"] as const) {
          if (tests[key] !== undefined && (typeof tests[key] !== "number" || !Number.isFinite(tests[key]))) {
            problems.push(`validation.tests.${key} must be a number`);
          }
        }
      }
    }
    if (sampleCount === 0 && !hasTests) {
      problems.push("validation must include at least one sample or a non-empty tests.summary");
    }
  }

  if (!isRecord(p.risks)) {
    problems.push("risks must be an object with risks and questions arrays");
  } else {
    problems.push(...stringArrayProblems(p.risks.risks, "risks.risks"));
    problems.push(...stringArrayProblems(p.risks.questions, "risks.questions"));
  }

  if (!Array.isArray(p.links)) {
    problems.push("links must be an array");
  } else {
    p.links.forEach((link: unknown, i: number) => {
      const path = `links[${i}]`;
      if (!isRecord(link)) {
        problems.push(`${path} must be an object`);
        return;
      }
      if (typeof link.kind !== "string" || !REVIEW_LINK_KINDS.includes(link.kind as ReviewLinkKind)) {
        problems.push(`${path}.kind must be one of ${REVIEW_LINK_KINDS.join(", ")}`);
      }
      if (typeof link.label !== "string") problems.push(`${path}.label must be a string`);
      if (typeof link.url !== "string" || !isHttpUrl(link.url)) problems.push(`${path}.url must be an http(s) URL`);
    });
  }

  if (opts.media) {
    if (opts.media.length > REVIEW_MAX_MEDIA) {
      problems.push(`at most ${REVIEW_MAX_MEDIA} media files (found ${opts.media.length})`);
    }
    opts.media.forEach((m: unknown, i: number) => {
      const path = `media[${i}]`;
      if (!isRecord(m)) {
        problems.push(`${path} must be an object`);
        return;
      }
      if (!isNonEmptyString(m.path)) problems.push(`${path}.path must be a non-empty string`);
      if (!isNonEmptyString(m.caption)) problems.push(`${path}.caption must be a non-empty string`);
    });
  }

  return problems;
}

// ----------------------------------------------------------------------------
// The human_review stage kind, for the delivery pipeline's stage-kind registry.
// ----------------------------------------------------------------------------

export const HUMAN_REVIEW_STAGE_KIND = "human_review";

/** A stage kind's contract: how its evidence is checked and how it decides the stage's outcome. */
export interface ReviewStageKindSpec {
  kind: string;
  title: string;
  description: string;
  /** Problems with the evidence; empty means it can be evaluated. */
  validateEvidence(evidence: unknown): string[];
  /** The stage outcome for valid evidence. */
  evaluateOutcome(evidence: unknown): "passed" | "failed";
}

/** Evidence for a human_review stage: the packet and the human's decision on it. */
export interface HumanReviewEvidence {
  packetId: string;
  decision: ReviewDecision;
}

const HUMAN_REVIEW_DESCRIPTION =
  "A human reviews the submitted review packet in the Review tab and approves it or requests changes. " +
  "A project that requires a linked code review refuses a packet that doesn't link the review its code_review stage recorded.";

export const humanReviewStageKind: ReviewStageKindSpec = {
  kind: HUMAN_REVIEW_STAGE_KIND,
  title: "Human review",
  description: HUMAN_REVIEW_DESCRIPTION,
  validateEvidence(evidence: unknown): string[] {
    if (!isRecord(evidence)) return ["evidence must be an object with packetId and decision"];
    const problems: string[] = [];
    if (!isNonEmptyString(evidence.packetId)) problems.push("evidence.packetId (non-empty string)");
    if (!isReviewDecision(evidence.decision)) problems.push("evidence.decision (approved | changes_requested)");
    return problems;
  },
  evaluateOutcome(evidence: unknown): "passed" | "failed" {
    return isRecord(evidence) && evidence.decision === "approved" ? "passed" : "failed";
  },
};

/** The subset of a pipeline stage definition the human_review stage declares. */
export interface ReviewStageDef {
  id: string;
  kind: string;
  title: string;
  required: boolean;
  description?: string;
  edges: Array<{
    to: string;
    when?: { outcome?: "passed" | "failed" };
    loop?: { maxTraversals: number };
  }>;
}

/** The default human_review stage: approval completes the run, changes requested loop back to coding. */
export const HUMAN_REVIEW_STAGE_DEF: ReviewStageDef = {
  id: "human_review",
  kind: HUMAN_REVIEW_STAGE_KIND,
  title: "Human review",
  required: true,
  description: HUMAN_REVIEW_DESCRIPTION,
  edges: [
    { to: "complete", when: { outcome: "passed" } },
    { to: "coding", when: { outcome: "failed" }, loop: { maxTraversals: 4 } },
  ],
};
