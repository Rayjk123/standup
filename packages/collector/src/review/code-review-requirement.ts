import type { Database } from "bun:sqlite";
import {
  CODE_REVIEW_STAGE_KIND,
  codeReviewOfEvidence,
  reviewPacketCodeReviews,
  stageStates,
  type CodeReviewLinkFormat,
  type CodeReviewRef,
  type PipelineRun,
  type Project,
  type ReviewLink,
} from "@standup/shared";
import { getLaunch, getPipelineRunByLaunch, getProject, recentLaunchWorktrees } from "@standup/store";
import { projectReviewGate, reviewGateCodeReviewStep, runRequiresCodeReview } from "../pipeline/engine.js";
import { allCheckoutRemotes } from "../pipeline/runners.js";
import {
  resolveProjectCodeReview,
  type CodeReviewRemotes,
  type ProjectCodeReview,
} from "../code-review/adapter.js";
import type { CodeReviewAdapter } from "../code-review/types.js";
import type { OrgProfile } from "../org-profile/types.js";
import type { GitRunner } from "./stage.js";

/** Where a project's checkouts are read from: a launch's own checkout, and the git runner that reads them. */
export interface ProjectCheckoutOptions {
  checkout?: string | null;
  git?: GitRunner;
}

/**
 * A reader of the remotes of every checkout git can read among a launch's
 * own (`checkout`), the project's registered repos and its recent launches'
 * worktrees (null when git could read none). It reads git on its first call
 * only and returns that result on every later call, so one reader can be
 * shared by every question asked about the project in one pass (its adapter,
 * its issue-id ask, its pipeline preset), and a question that never needs
 * the remotes never spawns git.
 */
export function projectCheckoutRemotes(db: Database, project: Project, opts: ProjectCheckoutOptions = {}): () => string[] | null {
  let read: { remotes: string[] | null } | undefined;
  return () => {
    read ??= { remotes: allCheckoutRemotes([opts.checkout ?? undefined, ...project.repos, ...recentLaunchWorktrees(db, project.id)], opts.git) };
    return read.remotes;
  };
}

/**
 * `project`'s code review (resolveProjectCodeReview) over its checkouts'
 * remotes — `opts.remotes` when given, else read from its checkouts
 * (projectCheckoutRemotes) only if the selection needs them. Every caller
 * that asks about a project's code review — the review it composes and how
 * the worker cuts it, whether it is asked an issue id, whether its packets
 * must link it and how its links read (the board's among them) — resolves
 * the adapter here, so none of the answers comes from a different adapter.
 */
export function projectCodeReview(
  db: Database,
  project: Project | null | undefined,
  opts: ProjectCheckoutOptions & { remotes?: CodeReviewRemotes; profile?: OrgProfile } = {}
): ProjectCodeReview {
  const remotes = opts.remotes !== undefined ? opts.remotes : project ? projectCheckoutRemotes(db, project, opts) : null;
  return resolveProjectCodeReview(project, { remotes, profile: opts.profile });
}

/**
 * Whether a project's review packets must link their code review: its
 * code-review adapter requires one (a project opted in to the generic
 * adapter), the same choice that decides what its code_review stage records.
 */
export function projectRequiresCodeReview(db: Database, projectId: string | null | undefined, opts: ProjectCheckoutOptions = {}): boolean {
  const project = projectId ? getProject(db, projectId) : null;
  return projectCodeReview(db, project, opts).requiresLinkedReview;
}

const DONE_STATES = new Set(["passed", "skipped", "waived"]);

/** The review the run's code_review stage last passed with, in any round, or null when it recorded none. */
function recordedReviewOf(run: PipelineRun, format: CodeReviewLinkFormat): CodeReviewRef | null {
  const stages = new Set(run.definition.stages.filter((s) => s.kind === CODE_REVIEW_STAGE_KIND).map((s) => s.id));
  const newestFirst = run.attempts
    .filter((a) => stages.has(a.stageId) && a.status === "passed")
    .sort((a, b) => (a.createdAt === b.createdAt ? b.attempt - a.attempt : a.createdAt < b.createdAt ? 1 : -1));
  for (const attempt of newestFirst) {
    const ref = codeReviewOfEvidence(attempt.evidence, format);
    if (ref) return ref;
  }
  return null;
}

/**
 * What a launch's review packet owes its code review, or null when it owes
 * none: a project whose adapter requires no linked review, or a run whose
 * code_review stages all ended skipped or waived (the review was waived with
 * them).
 */
export interface CodeReviewRequirement {
  /** The run's code_review stages not yet done in its current round; the packet waits on them. */
  pendingStages: string[];
  /** The run's current stage, when it has an enabled run. */
  currentStage?: string;
  /** The review the run's code_review stage recorded, which the packet must link (null when none is known). */
  recorded: CodeReviewRef | null;
  /** How the review is cut and recorded: by the worker, or by the project's review gate. */
  howToCut: string;
  /** The project's adapter, whose noun and link format the refusal names. */
  adapter: CodeReviewAdapter;
  /**
   * Set when no enabled run's code_review stage decides it (no run, or a
   * disabled one): the review is owed only for a launch that changes code, so
   * a launch whose checkout reads as changing none (a draft or a lookup) owes none.
   */
  onlyForCode?: true;
}

/** How the review is cut; `reported`: the launch has an enabled run with a code_review stage to report it to. */
function howToCut(db: Database, projectId: string | null | undefined, adapter: CodeReviewAdapter, prior: CodeReviewRef | null, reported: boolean): string {
  const gate = projectReviewGate(db, projectId);
  if (gate) return `The project's review gate cuts the ${adapter.noun}: ${reviewGateCodeReviewStep(gate)}.`;
  const cut = adapter.howToCut({ prior });
  if (!reported) return cut;
  return `${cut.replace(/\.$/, "")} — and report it with pipeline_advance {stage: "${CODE_REVIEW_STAGE_KIND}", evidence: {url, issueId}} when the run reaches the ${CODE_REVIEW_STAGE_KIND} stage.`;
}

/**
 * What the launch's packet owes its code review (see CodeReviewRequirement),
 * or null when it owes none. A launch with an enabled pipeline run owes one
 * only while the run's project pipeline still has a code_review stage that
 * applies (runRequiresCodeReview) — a project the owner put on the light
 * preset cuts none; a launch with no run, or a disabled one, follows the
 * project's rule (projectRequiresCodeReview) when it changes code (onlyForCode).
 * The project's adapter is resolved over its checkouts' remotes, the launch's
 * own checkout among them (projectCodeReview).
 */
export function codeReviewRequirement(
  db: Database,
  projectId: string | null | undefined,
  launchId: string,
  opts: { git?: GitRunner; remotes?: CodeReviewRemotes } = {}
): CodeReviewRequirement | null {
  const project = projectId ? getProject(db, projectId) : null;
  if (!project) return null;
  const review = projectCodeReview(db, project, { checkout: getLaunch(db, launchId)?.worktreePath, git: opts.git, remotes: opts.remotes });
  const adapter = review.adapter;
  if (!adapter || !review.requiresLinkedReview) return null;
  const run = getPipelineRunByLaunch(db, launchId);
  if (run && run.status !== "disabled" && !runRequiresCodeReview(db, run)) return null;
  if (!run || run.status === "disabled") {
    const recorded = run ? recordedReviewOf(run, adapter.linkFormat) : null;
    return { pendingStages: [], recorded, adapter, howToCut: howToCut(db, projectId, adapter, recorded, false), onlyForCode: true };
  }
  const states = stageStates(run.definition, run);
  const stages = run.definition.stages.filter((s) => s.kind === CODE_REVIEW_STAGE_KIND);
  const pendingStages = stages.filter((s) => !DONE_STATES.has(states[s.id]!.state)).map((s) => s.id);
  if (stages.length > 0 && pendingStages.length === 0 && stages.every((s) => states[s.id]!.state !== "passed")) return null;
  const recorded = recordedReviewOf(run, adapter.linkFormat);
  return {
    pendingStages,
    currentStage: run.currentStage,
    recorded,
    adapter,
    howToCut: howToCut(db, projectId, adapter, recorded, stages.length > 0),
  };
}

/** A submission's refusal: the HTTP status, the error and the problems the worker is handed. */
export interface CodeReviewRefusal {
  status: 400 | 409;
  error: string;
  problems: string[];
  reason: "review-required" | "review-mismatch" | "review-stage-pending";
}

/**
 * Why a launch's review packet with `links` can't be accepted yet, or null.
 * A packet that owes a code review (codeReviewRequirement) waits until the
 * run's code_review stage is done in its current round — a run sent back to
 * coding revises the review before the packet is resubmitted — and must link
 * the review: the one the stage recorded when it recorded one, else any
 * review link the adapter's format reads. One owed only for code
 * (onlyForCode) is waived when `changesNoCode` says the launch's checkout
 * changes none.
 */
export async function codeReviewRequirementRefusal(
  db: Database,
  input: {
    projectId: string | null | undefined;
    launchId: string;
    links: readonly ReviewLink[];
    changesNoCode?: () => Promise<boolean>;
    git?: GitRunner;
  }
): Promise<CodeReviewRefusal | null> {
  const need = codeReviewRequirement(db, input.projectId, input.launchId, { git: input.git });
  if (!need) return null;
  if (need.onlyForCode && input.changesNoCode && (await input.changesNoCode())) return null;
  const noun = need.adapter.noun;
  const subject = `This project requires its review packets to link their ${noun}`;
  if (need.pendingStages.length > 0) {
    const stages = need.pendingStages.join(", ");
    const atStage = !!need.currentStage && need.pendingStages.includes(need.currentStage);
    const advance = atStage ? "" : `Advance the run with pipeline_advance, one stage at a time, until it reaches the ${CODE_REVIEW_STAGE_KIND} stage. `;
    return {
      status: 409,
      error:
        `${subject}: its review packet is accepted only after the pipeline's ${CODE_REVIEW_STAGE_KIND} stage (${stages}) is done; the run is at ` +
        `${need.currentStage}. ${advance}${need.howToCut} Then submit the packet with the ${noun} in its links.`,
      problems: [`the ${CODE_REVIEW_STAGE_KIND} stage (${stages}) is not done yet`],
      reason: "review-stage-pending",
    };
  }
  const linkedAll = reviewPacketCodeReviews(input.links, need.adapter.linkFormat);
  const linked = linkedAll[0] ?? null;
  if (need.recorded) {
    if (linkedAll.some((ref) => ref.id === need.recorded!.id)) return null;
    const entry = JSON.stringify(need.adapter.exampleLink(need.recorded));
    return {
      status: 400,
      error:
        `${subject}: it must link the ${noun} the ${CODE_REVIEW_STAGE_KIND} stage recorded, ${need.recorded.id}` +
        `${linked ? `, not ${linked.id}` : ""}. Add ${entry} to links and submit again.`,
      problems: [`links must include the recorded ${noun} ${need.recorded.id} (${need.recorded.url})`],
      reason: linked ? "review-mismatch" : "review-required",
    };
  }
  if (linked) return null;
  const example = need.adapter.exampleLink(null);
  return {
    status: 400,
    error: `${subject}. ${need.howToCut} Then add ${JSON.stringify(example)} to links and submit again.`,
    problems: [`links must include the ${noun} (a "${example.kind}" link to ${example.url})`],
    reason: "review-required",
  };
}
