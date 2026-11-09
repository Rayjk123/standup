import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import {
  DEFAULT_PIPELINE,
  DEFAULT_UI_PATHS,
  HUMAN_REVIEW_STAGE_KIND,
  CODE_REVIEW_STAGE_KIND,
  MAX_EVIDENCE_STRING,
  MIN_PARK_REASON,
  MIN_PERSONA_WAIVE_REASON,
  MIN_WAIVE_REASON,
  MIN_WONTFIX_ACCEPT_REASON,
  PIPELINE_PRESETS,
  PipelineConfigError,
  blockingReviewFindingsByReviewer,
  computeFacts,
  currentEpochAttempts,
  describeStage,
  evaluateOutcome,
  incompleteRequiredStages,
  isHttpUrl,
  isOutwardStage,
  loopBudget,
  nonDeployableOnly,
  pipelineLayerFromInput,
  pipelineStageSummary,
  planTransition,
  resolvePipelineLayers,
  reviewBlockedOnlyByWontfix,
  runIsLive,
  reviewTunnelSeed,
  specProjectRefusal,
  stageMaxAttempts,
  stageStates,
  validateEvidence,
} from "@standup/shared";
import type {
  CompiledPipelineSpec,
  Launch,
  LaunchCheckoutSnapshot,
  PersonaJob,
  PipelineAttemptStatus,
  PipelineBlockedPayload,
  PipelineConfigUpdatedPayload,
  PipelineParkedPayload,
  PipelineDecision,
  PipelineLanding,
  PipelineDefinition,
  PipelineDisabledReason,
  PipelineEdge,
  PipelineFacts,
  PipelineOutcome,
  PipelineOverride,
  PipelinePark,
  PipelineParkBy,
  PipelinePresetId,
  PipelineRun,
  PipelineStageDef,
  PipelineStageState,
  PipelineWaitingKind,
  PipelineStageAttempt,
  PipelineWaiverBy,
  PipelineWaiverCheckout,
  PipelineWaiverEvidence,
  PipelineWontfixFinding,
} from "@standup/shared";
import {
  createPipelineRun,
  createSteer,
  getLaunch,
  setLaunchProvisionSnapshot,
  getLaunchBySession,
  getPendingMessages,
  getPendingSteers,
  getPersonaJob,
  getPipelineConfig,
  getPipelineRun,
  getPipelineRunByLaunch,
  getProject,
  getSession,
  getTicketByLaunch,
  latestSubmittedReviewPacketForLaunch,
  pendingReviewPacketLaunchesForJob,
  listOpenPipelineRuns,
  listPipelineConfigs,
  listPipelineDecisions,
  listPipelineRunsByLaunches,
  personaJobForLaunch,
  recordPipelineAttempt,
  recordPipelineDecision,
  setPersonaJobPipeline,
  setPipelineConfig,
  setPipelineRunFlaggedJob,
  setPipelineRunPark,
  setPipelineRunReviewHandoff,
  takePipelineRunReviewHandoff,
  updatePersonaJob,
  updatePipelineRunIf,
  type UpdatePipelineRunPatch,
} from "@standup/store";
import { REVIEW_DESCRIPTION_BRIEF } from "../review-description.js";
import { canonicalJson } from "../floor/gate.js";
import { projectPipelinePreset, type CodeReviewRemotes } from "../code-review/adapter.js";
import { projectCheckoutRemotes, projectCodeReview } from "../review/code-review-requirement.js";
import { defaultGitRunner, type GitRunner } from "../review/stage.js";
import { localTargetBranch } from "../target-branch.js";
import { definitionWeakens, guardedStageKinds } from "./guard.js";
import {
  MAX_SESSION_DEPTH,
  changeFacts,
  definitionUiPaths,
  getPipelineStageRunner,
  gitBranchLanded,
  gitChangedFiles,
  gitHeadState,
  knownIssueId,
  launchWorkLanded,
  approvalIsCurrent,
  briefReviewPacket,
  codeReviewApplies,
  codeReviewNotApplicable,
  prepareOutwardEvidence,
  reportedChangedFiles,
  reviewPacketNeeded,
  sessionTree,
  type EvidenceSource,
  type HeadState,
  type PipelineDeps,
  type PipelineNotify,
  type PreparedEvidence,
  checkoutChangedFiles,
  launchChangedFiles,
  pathsToMatch,
  workingDirCheckouts,
  workingFileDigests,
} from "./runners.js";

export {
  approvalIsCurrent,
  floorAsksDuringStage,
  gitBranchLanded,
  gitChangedFiles,
  gitHeadState,
  hasOwnerAllowedFloorAsk,
  knownIssueId,
  registerPipelineStageRunner,
} from "./runners.js";
export type { CheckResult, CriterionResult, HeadState, PipelineDeps, PipelineNotify, PipelineStageRunner } from "./runners.js";

/**
 * The delivery-pipeline engine: starts a run per launch, checks the evidence a
 * worker reports for its current stage, picks the next stage through the
 * shared interpreter and persists the move. It also answers the hooks that
 * keep a worker on the pipeline (ready refusal, Stop block, prompt steer) and
 * hands a stuck run to the owner's Persona when a Persona job owns its launch
 * (Persona decides: decidePipelineStage), else to the owner.
 *
 * Every write is a compare-and-set on the run as it was read (its current
 * stage and updated_at, see updatePipelineRunIf), made in one transaction
 * with the attempts it records: an advance whose run moved while it awaited
 * git or the acceptance criterion writes nothing and is refused.
 */

/** Consecutive Stop blocks after which the run is handed to the owner instead. */
export const MAX_STOP_BLOCKS = 3;

/** The Standup checkout's screenshot helper, named in the worker's brief. */
const SCREENSHOT_SCRIPT = join(import.meta.dir, "..", "..", "..", "..", "scripts", "pipeline-screenshot.ts");

const STALE_RUN = "the run moved while this advance was running; call pipeline_status";
/** Who settles a run that is blocked: the owner's Persona, through its decisions — or the owner in the console. */
const PERSONA_DECIDES = "Persona decides (skip, waive, close out or escalate) — or the owner in the console";
const OWNER_NEEDED = PERSONA_DECIDES;
const ISSUE_ID_REASON = "code review stage needs an issue id — Persona asks the owner for it";
/**
 * The issue-id and wontfix wait reasons runs carried before blocks went to
 * Persona: such runs are still recognized as waiting for those (and are
 * handed to Persona by routeLegacyBlocksToPersona).
 */
const LEGACY_ISSUE_ID_PREFIX = "code review stage needs an issue id from you";
const LEGACY_WONTFIX_PREFIX = "review has wontfix High/Medium findings — waive review in the console";
/** The note a pipeline block leaves on its Persona job (kept active) while Persona decides. */
const PERSONA_DECIDING_NOTE = "Persona deciding: ";
/** The note a pipeline block left on its Persona job (set waiting on the owner) before blocks went to Persona. */
const LEGACY_FLAG_NOTE = "Pipeline needs you: ";
/** The note Persona's escalation leaves on the job it sets waiting on the owner. */
const ESCALATED_NOTE = "Persona escalated: ";
/** Why a run at code_review whose work already landed waits on its owner: there is no review left to cut. */
export const REVIEW_LANDED_REASON =
  "the change already landed in its target branch, so there is no code review left to cut — close the job done (it closes as landed) or waive the stage";
export const PICKED_ENDED_REASON = "the picked attempt's worker has ended — resume it or waive the stages";
const PICKED_UNREACHABLE_REASON = "the picked attempt's worker can't be reached — resume it or waive the stages";
const WONTFIX_REASON = "review has wontfix High/Medium findings — Persona decides whether to accept them";
const REVIEW_GATE_NO_REVIEW_REASON = "the review gate didn't record a code review — needs you";

/** Whether a wait reason is the code review's missing issue id, in today's wording or the earlier one. */
function isIssueIdReason(reason: string | undefined): boolean {
  return reason === ISSUE_ID_REASON || (reason?.startsWith(LEGACY_ISSUE_ID_PREFIX) ?? false);
}

/** Whether a wait reason is a review held on wontfix findings, in today's wording or the earlier one. */
function isWontfixReason(reason: string | undefined): boolean {
  return reason === WONTFIX_REASON || (reason?.startsWith(LEGACY_WONTFIX_PREFIX) ?? false);
}

export type AdvanceResult =
  | {
      ok: true;
      run: PipelineRun;
      from: string;
      to: string;
      outcome: PipelineOutcome | "skipped" | "waived";
      skipped: Array<{ stageId: string; reason: string }>;
      message: string;
    }
  | { ok: false; status: 404 | 409 | 422; error: string; missing?: string[] };

export interface AdvanceInput {
  stage: string;
  evidence?: unknown;
  skip?: { reason?: unknown } | null;
  sessionId?: string;
  /** Who reports the evidence (default the worker); see EvidenceSource. */
  source?: EvidenceSource;
}

// ----------------------------------------------------------------------------
// Definitions and run start.
// ----------------------------------------------------------------------------

/** sha256 of the definition's key-sorted JSON, first 16 hex characters. */
export function pipelineDefinitionHash(def: PipelineDefinition): string {
  return createHash("sha256").update(canonicalJson(def), "utf8").digest("hex").slice(0, 16);
}

/**
 * The built-in layer for `projectId` beneath the owner's project layer, or
 * null when it has nothing: its review-tunnel seed (reviewTunnelSeed, read
 * from REVIEW_TUNNEL_PROJECT_SEEDS, which Standup ships empty: a build that
 * serves a project's UI a fixed way puts its defaults there), and a
 * code_review stage that needs the
 * owner's issue id where the project's code-review adapter attaches one to
 * the review it cuts (codeReviewAdapterLayer). `remotes` are its checkouts'
 * remotes or a reader of them (projectCheckoutRemotes), read when omitted.
 */
export function projectSeedLayer(
  db: Database,
  projectId: string | null | undefined,
  opts: { remotes?: CodeReviewRemotes; checkout?: string | null; git?: GitRunner } = {}
): PipelineOverride | null {
  const tunnel = reviewTunnelSeed(projectId);
  const adapter = codeReviewAdapterLayer(db, projectId, opts);
  if (!tunnel && !adapter) return null;
  return { ...(tunnel ? { reviewTunnel: tunnel } : {}), ...(adapter ?? {}) };
}

/**
 * What `projectId`'s code-review adapter adds to its pipeline: a code_review
 * stage that needs the owner's issue id (ownerInput) when its review tool
 * attaches one — the adapter projectCodeReview resolves over its checkouts'
 * remotes, the one that also composes its review and tells the worker how to
 * cut it. Null otherwise, so a pull request or a review the repo cuts its
 * own way never waits on one.
 */
export function codeReviewAdapterLayer(
  db: Database,
  projectId: string | null | undefined,
  opts: { remotes?: CodeReviewRemotes; checkout?: string | null; git?: GitRunner } = {}
): PipelineOverride | null {
  const project = projectId ? getProject(db, projectId) : null;
  if (!project) return null;
  return projectCodeReview(db, project, opts).requiresIssueId ? { stages: { [CODE_REVIEW_STAGE_KIND]: { ownerInput: "issue_id" } } } : null;
}

/**
 * The preset `projectId`'s pipeline starts from when no layer names one (see
 * projectPipelinePreset): read from the project's registration and the
 * remotes of every checkout git can read among the launch's own (`checkout`),
 * the project's registered repos and its recent launches' worktrees, so a
 * project registered without repos is still read from where it was launched.
 * Any remote on a code-review host makes it full, so no one checkout's
 * remotes can relabel a project the others show cuts code reviews. An unknown
 * project gets the full flow.
 */
export function autoPipelinePreset(
  db: Database,
  projectId: string | null | undefined,
  opts: { checkout?: string | null; git?: GitRunner; remotes?: CodeReviewRemotes } = {}
): PipelinePresetId {
  const project = projectId ? getProject(db, projectId) : null;
  if (!project) return "full";
  return projectPipelinePreset(project, { remotes: opts.remotes !== undefined ? opts.remotes : projectCheckoutRemotes(db, project, opts) });
}

export interface ResolvedPipelineFor {
  enabled: boolean;
  definition: PipelineDefinition;
  /** The preset the definition was resolved from. */
  preset: PipelinePresetId;
  /** The project's own preset (autoPipelinePreset), which a layer may override. */
  autoPreset: PipelinePresetId;
  /** Why the stored layers didn't merge cleanly, when fewer layers were used. */
  error?: string;
}

/**
 * The pipeline `owner` gets for `projectId`: the catalog under the project's
 * preset (autoPipelinePreset, unless a layer names another), then the
 * owner's global layer, the project's built-in seed (projectSeedLayer), the
 * owner's project layer, the job's layer (`jobId`, read only when the job is
 * the owner's) and the launch's (`launchOverride`). A stored combination that
 * no longer merges cleanly falls back to fewer layers — dropping the
 * launch's, then the job's, the project's, the global one and the seed — and
 * reports why in `error`. `checkout` is the launch's worktree, read first for
 * the project's own preset.
 */
export function resolvePipelineFor(
  db: Database,
  owner: string,
  projectId: string | null | undefined,
  opts: { jobId?: string | null; launchOverride?: PipelineOverride | null; checkout?: string | null } = {}
): ResolvedPipelineFor {
  const global = getPipelineConfig(db, owner, null);
  const registered = projectId ? getProject(db, projectId) : null;
  const remotes = registered ? projectCheckoutRemotes(db, registered, { checkout: opts.checkout }) : null;
  const seed = projectSeedLayer(db, projectId, { remotes });
  const project = projectId ? getPipelineConfig(db, owner, projectId) : null;
  const job = opts.jobId ? getPersonaJob(db, opts.jobId, { withView: false }) : null;
  const jobLayer = job && job.owner === owner ? (job.pipelineOverride ?? null) : null;
  const launchLayer = opts.launchOverride ?? null;
  const autoPreset = autoPipelinePreset(db, projectId, { remotes });
  const attempts: Array<Array<PipelineOverride | null>> = [
    [global, seed, project, jobLayer, launchLayer],
    [global, seed, project, jobLayer],
    [global, seed, project],
    [global, seed],
    [seed],
    [],
  ];
  let error: string | undefined;
  for (const layers of attempts) {
    try {
      const resolved = resolvePipelineLayers(layers, autoPreset);
      return { ...resolved, autoPreset, ...(error ? { error } : {}) };
    } catch (e) {
      if (!(e instanceof PipelineConfigError)) throw e;
      error ??= e.message;
    }
  }
  return { enabled: true, definition: DEFAULT_PIPELINE, preset: "full", autoPreset, error };
}

/**
 * The launch's run, started on first call with the owner's resolved pipeline
 * frozen into it — with the job's layer (`jobId`, else the Persona job the
 * launch is linked to) and the launch's own (`pipelineOverride`), which is
 * kept on the run. The run is `disabled` when the launch asked for none
 * (`disabled`, for `disabledReason` — opt_out by default) or the owner's
 * configuration turns the pipeline off (other).
 */
export function startPipelineForLaunch(
  db: Database,
  input: {
    launchId: string;
    owner: string;
    projectId?: string | null;
    disabled?: boolean;
    disabledReason?: PipelineDisabledReason;
    jobId?: string | null;
    pipelineOverride?: PipelineOverride | null;
  }
): PipelineRun {
  const existing = getPipelineRunByLaunch(db, input.launchId);
  if (existing) return existing;
  const jobId = input.jobId ?? personaJobForLaunch(db, input.launchId)?.job.id;
  const { enabled, definition, preset } = resolvePipelineFor(db, input.owner, input.projectId, {
    jobId,
    launchOverride: input.pipelineOverride,
    checkout: getLaunch(db, input.launchId)?.worktreePath,
  });
  try {
    return createPipelineRun(db, {
      launchId: input.launchId,
      owner: input.owner,
      projectId: input.projectId ?? null,
      definition,
      definitionHash: pipelineDefinitionHash(definition),
      status: enabled && !input.disabled ? "active" : "disabled",
      disabledReason: input.disabled ? (input.disabledReason ?? "opt_out") : "other",
      preset,
      launchOverride: input.pipelineOverride ?? null,
    });
  } catch (e) {
    // A concurrent start for the same launch lost the UNIQUE insert.
    const raced = getPipelineRunByLaunch(db, input.launchId);
    if (raced) return raced;
    throw e;
  }
}

/**
 * Turns the launch's pipeline on at `stage` (default coding) — for a
 * Best-of-N attempt the owner picked, which ran without one until now. Starts
 * the run when there is none; a run disabled as an attempt becomes active at
 * `stage`, with a passed attempt recorded at start. A run that was on before
 * (an earlier pick, turned off when another won) starts a new epoch, so it
 * gets fresh loop and attempt budgets. Any other disabled run stays off: the
 * launch's own opt-out or a provisioned launch's `not_coding` default (unless
 * `allowOptOut`, for a person turning it on), a
 * worker that can't reach the standup MCP server, or a pipeline the owner's
 * configuration turns off. A run that is already on is returned as it is.
 */
export function enablePipelineForLaunch(
  db: Database,
  input: { launchId: string; owner: string; projectId?: string | null; stage?: string; allowOptOut?: boolean },
  notify: PipelineNotify
): PipelineRun {
  const run = startPipelineForLaunch(db, {
    launchId: input.launchId,
    owner: input.owner,
    projectId: input.projectId,
    disabled: true,
    disabledReason: "attempt",
  });
  if (run.status !== "disabled") return run;
  const enableable =
    run.disabledReason === "attempt" ||
    (input.allowOptOut === true && (run.disabledReason === "opt_out" || run.disabledReason === "not_coding"));
  if (!enableable) return run;
  if (!resolvePipelineFor(db, run.owner, run.projectId).enabled) return run;
  const wanted = input.stage ?? "coding";
  const stage = stageOf(run, wanted) ? wanted : "start";
  const updated = db.transaction(() => {
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      currentStage: stage,
      status: "active",
      waitingReason: null,
      waitingKind: null,
      disabledReason: null,
      reviewHandoffAt: null,
      stopBlocks: 0,
      stageEnteredAt: new Date().toISOString(),
      ...(run.attempts.length > 0 ? { epoch: (run.epoch ?? 0) + 1 } : {}),
    });
    if (!moved) return null;
    if (stage !== "start") {
      recordPipelineAttempt(db, run.id, { stageId: "start", status: "passed", reason: "pipeline turned on for this launch", nextStage: stage });
    }
    return getPipelineRun(db, run.id);
  })();
  const result = updated ?? getPipelineRun(db, run.id) ?? run;
  if (updated) publishRun(updated, notify);
  return result;
}

/**
 * Turns the launch's open run off (status disabled, as an attempt — a later
 * pick may turn it on again) — an earlier Best-of-N pick the owner replaced.
 * A Persona job the run had set waiting is released as when the run moves
 * on. Null when there was no open run to turn off.
 */
export function disablePipelineForLaunch(db: Database, launchId: string, notify: PipelineNotify): PipelineRun | null {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || (run.status !== "active" && run.status !== "waiting_user")) return null;
  const out = db.transaction(() => {
    const flag = storedFlag(db, run.id);
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      status: "disabled",
      disabledReason: "attempt",
      waitingReason: null,
      waitingKind: null,
      flaggedJob: null,
      reviewHandoffAt: null,
      stopBlocks: 0,
    });
    if (!moved) return null;
    return { run: moved, restored: restoreFlaggedJob(db, run, flag, "another attempt was picked") };
  })();
  if (!out) return null;
  publishRun(out.run, notify);
  publishRestored(out.restored, notify);
  return out.run;
}

export interface PickedAttemptPipeline {
  run: PipelineRun;
  /**
   * The pipeline brief, when the run was just turned on for a live worker;
   * `steered` says whether it was queued to the worker's session as a steer
   * (false when the worker's session isn't mid-turn — idle, or not attached
   * yet — so a steer would sit undelivered: the caller types it into the
   * launch's pane instead, see pickedAttemptUnreachable).
   */
  brief?: string;
  steered: boolean;
}

/** Session statuses whose next turn boundary delivers a queued steer: mid-turn, or held on an ask. */
const STEERABLE_SESSION_STATUSES: ReadonlySet<string> = new Set(["running", "waiting"]);

/**
 * The delivery pipeline for the Best-of-N attempt the owner picked: the runs
 * of `previousLaunchIds` (earlier picks) are turned off, then the winner's
 * run is turned on at coding (enablePipelineForLaunch). A worker mid-turn
 * gets the pipeline brief queued as a steer on its session — delivered at its
 * next turn boundary or checkpoint — so it drives the stages from there. One
 * that isn't (its session idle, or none attached yet) gets the brief back for
 * the caller to type into its pane, when the launch has a pane running a
 * Claude harness; otherwise, and when its worker has ended (the launch failed
 * or was cleaned up, or its session is done), the run waits on the owner
 * instead. Null when the pipeline stays off (see enablePipelineForLaunch).
 */
export function startPickedAttemptPipeline(
  db: Database,
  input: { launch: Launch; owner: string; sessionId?: string | null; previousLaunchIds?: string[] },
  notify: PipelineNotify
): PickedAttemptPipeline | null {
  for (const id of input.previousLaunchIds ?? []) {
    if (id !== input.launch.id) disablePipelineForLaunch(db, id, notify);
  }
  // A provisioned launch runs without the pipeline by default (not_coding),
  // picked or not.
  if (input.launch.provisioned) return null;
  const before = getPipelineRunByLaunch(db, input.launch.id);
  const wasOn = before?.status === "active" || before?.status === "waiting_user";
  const run = enablePipelineForLaunch(
    db,
    { launchId: input.launch.id, owner: input.owner, projectId: input.launch.projectId, stage: "coding" },
    notify
  );
  if (run.status !== "active") return run.status === "disabled" ? null : { run, steered: false };
  if (wasOn) return { run, steered: false };
  const sessionId = input.sessionId ?? input.launch.sessionId;
  const session = sessionId ? getSession(db, sessionId) : null;
  const ended = TERMINAL_LAUNCH_STATUSES.has(input.launch.status) || session?.status === "done";
  if (ended) {
    const waiting = markRunWaiting(db, run, PICKED_ENDED_REASON, "owner_input", notify);
    return { run: waiting ?? getPipelineRun(db, run.id) ?? run, steered: false };
  }
  const brief =
    "Your attempt was picked as the winner, so Standup's delivery pipeline now tracks this launch from the coding stage." +
    formatPipelineInstruction(run.definition, {
      reviewGate: projectReviewGate(db, run.projectId),
      codeReviewNotApplicable: codeReviewNotApplicable(db, run, input.launch),
    });
  if (session && STEERABLE_SESSION_STATUSES.has(session.status)) {
    const steer = createSteer(db, session.id, brief);
    notify.broadcast({ type: "steer:queued", payload: steer, timestamp: new Date().toISOString() });
    return { run, brief, steered: true };
  }
  const claudeHarness = !input.launch.harness || input.launch.harness === "claude";
  if (input.launch.tmuxSession && claudeHarness) return { run, brief, steered: false };
  const waiting = pickedAttemptUnreachable(db, input.launch.id, notify);
  return { run: waiting ?? getPipelineRun(db, run.id) ?? run, steered: false };
}

/**
 * The picked attempt's worker couldn't be handed its pipeline brief (no pane
 * to type it into, or typing it failed): its active run waits on the owner,
 * who resumes the worker or waives the stages. Null when the run isn't active.
 */
export function pickedAttemptUnreachable(db: Database, launchId: string, notify: PipelineNotify): PipelineRun | null {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || run.status !== "active") return null;
  return markRunWaiting(db, run, PICKED_UNREACHABLE_REASON, "owner_input", notify);
}

// ----------------------------------------------------------------------------
// Lookups.
// ----------------------------------------------------------------------------

const RUN_RANK: Record<string, number> = { active: 0, waiting_user: 0, complete: 1, disabled: 2 };

/** The run that speaks for a session among `runs`: an open one first, then complete, then disabled; newest among equals. */
function preferredRun(runs: PipelineRun[]): PipelineRun | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => RUN_RANK[a.status]! - RUN_RANK[b.status]! || (a.createdAt < b.createdAt ? 1 : -1))[0]!;
}

/** The ids of every launch bound to `sessionId` — adopting an ended session reuses its id, so there may be several. */
function launchIdsOfSession(db: Database, sessionId: string): string[] {
  const rows = db.query("SELECT id FROM launches WHERE session_id = ?").all(sessionId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * The run of a launch whose own session is `sessionId` (a worker's root
 * session, not a subagent), across every launch that shares that session id
 * (preferredRun picks among them).
 */
export function rootPipelineRun(db: Database, sessionId: string): PipelineRun | null {
  return preferredRun(listPipelineRunsByLaunches(db, launchIdsOfSession(db, sessionId)));
}

/**
 * The run for `sessionId`: its own launches' (rootPipelineRun), else the
 * nearest parent session's that has one — a subagent reports for its
 * worker's launch.
 */
export function pipelineRunForSession(db: Database, sessionId: string): PipelineRun | null {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < MAX_SESSION_DEPTH; depth++) {
    const run = rootPipelineRun(db, current);
    if (run) return run;
    const row = db.query("SELECT parent_session_id FROM sessions WHERE id = ?").get(current) as
      | { parent_session_id: string | null }
      | null;
    current = row?.parent_session_id ?? null;
  }
  return null;
}

/** Whether `sessionId` — or the worker session it is a subagent of — is a session of launch `launchId`. */
export function sessionBelongsToLaunch(db: Database, sessionId: string, launchId: string): boolean {
  let current: string | null = sessionId;
  for (let depth = 0; current && depth < MAX_SESSION_DEPTH; depth++) {
    if (launchIdsOfSession(db, current).includes(launchId)) return true;
    const row = db.query("SELECT parent_session_id FROM sessions WHERE id = ?").get(current) as
      | { parent_session_id: string | null }
      | null;
    current = row?.parent_session_id ?? null;
  }
  return false;
}

/**
 * Who a review url reported through a ticket's status (report_ticket_status) is
 * recorded as, for the ticket's launch's run: the review gate's only when the
 * project runs a review agent, the ticket is in review and the gate handed
 * the worker the review to cut (markReviewHandoff) — each hand-off is taken by
 * one report — and the caller is that launch's session; the worker's when
 * the caller is otherwise the launch's own session (or one of its
 * subagents). Null — no pipeline effect — for any other caller.
 */
export function reportedReviewUrlSource(
  db: Database,
  ticket: { launchId?: string; projectId: string; status: string },
  sessionId: string | undefined
): EvidenceSource | null {
  if (!ticket.launchId || !sessionId || !sessionBelongsToLaunch(db, sessionId, ticket.launchId)) return null;
  const reviewAgent = getProject(db, ticket.projectId)?.reviewProcess === "review-agent";
  if (!reviewAgent || ticket.status !== "needs_review") return "worker";
  const run = getPipelineRunByLaunch(db, ticket.launchId);
  return run && takePipelineRunReviewHandoff(db, run.id) ? "review_gate" : "worker";
}

/**
 * Records that the review-agent gate is handing the launch's worker the
 * review to cut, when its run is open at its code_review stage; true when it
 * was recorded. The worker's next report of a review url is then the gate's
 * (see reportedReviewUrlSource).
 */
export function markReviewHandoff(db: Database, launchId: string): boolean {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || (run.status !== "active" && run.status !== "waiting_user")) return false;
  if (stageOf(run, run.currentStage)?.kind !== CODE_REVIEW_STAGE_KIND) return false;
  setPipelineRunReviewHandoff(db, run.id, new Date().toISOString());
  return true;
}

/** Withdraws an open review hand-off — the gate couldn't reach the worker after all. */
export function clearReviewHandoff(db: Database, launchId: string): void {
  const run = getPipelineRunByLaunch(db, launchId);
  if (run) setPipelineRunReviewHandoff(db, run.id, null);
}

/**
 * The project's review gate failed to produce a code review (its command
 * failed or printed no url, or the review agent couldn't be reached): a run
 * open at its code_review stage waits on the owner. Null when no run was set waiting.
 */
export function pipelineReviewGateFailed(db: Database, launchId: string, notify: PipelineNotify): PipelineRun | null {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || (run.status !== "active" && run.status !== "waiting_user")) return null;
  if (stageOf(run, run.currentStage)?.kind !== CODE_REVIEW_STAGE_KIND) return null;
  if (run.status === "waiting_user" && run.waitingReason === REVIEW_GATE_NO_REVIEW_REASON) return null;
  return markRunWaiting(db, run, REVIEW_GATE_NO_REVIEW_REASON, "owner_input", notify);
}

function stageOf(run: PipelineRun, id: string): PipelineStageDef | undefined {
  return run.definition.stages.find((s) => s.id === id);
}

function attemptsAt(run: PipelineRun, stageId: string): number {
  return run.attempts.filter((a) => a.stageId === stageId).length;
}

function expectedOf(run: PipelineRun): { currentStage: string; updatedAt: string } {
  return { currentStage: run.currentStage, updatedAt: run.updatedAt };
}

/**
 * How the project's review gate finishes the code review after mark_ready_for_review:
 * `command` — its review command cuts it and Standup records the url it
 * prints; `review-agent` — the worker is handed the review to cut and reports
 * its url. Null without a gate.
 */
export type ReviewGateMode = "command" | "review-agent";

/** The project's review gate (see ReviewGateMode), or null when it has none. */
export function projectReviewGate(db: Database, projectId: string | null | undefined): ReviewGateMode | null {
  const process = projectId ? getProject(db, projectId)?.reviewProcess : undefined;
  return process === "command" || process === "review-agent" ? process : null;
}

/** Whether the project's review gate (a review command or review agent) cuts the code review on mark_ready_for_review. */
export function projectUsesReviewGate(db: Database, projectId: string | null | undefined): boolean {
  return projectReviewGate(db, projectId) !== null;
}

/**
 * Whether a review url on the launch's ticket is the review gate's record: the
 * ticket is in review on a review-gate project — for a review agent, also
 * only while the gate's hand-off to the worker is open (taken here).
 */
function ticketUrlFromReviewGate(db: Database, run: PipelineRun): boolean {
  const mode = projectReviewGate(db, run.projectId);
  if (!mode || getTicketByLaunch(db, run.launchId)?.status !== "needs_review") return false;
  return mode === "command" || takePipelineRunReviewHandoff(db, run.id);
}

// ----------------------------------------------------------------------------
// Waiting and hand-off.
// ----------------------------------------------------------------------------

/** Pushes the run to clients — addressed to its owner alone, like a Persona job. */
export function publishRun(run: PipelineRun, notify: PipelineNotify): void {
  notify.broadcast({ type: "pipeline:updated", payload: run, timestamp: new Date().toISOString(), audience: run.owner });
}

function publishJob(job: PersonaJob | null, notify: PipelineNotify): void {
  // A persona:* frame is addressed to the job's owner alone.
  if (job) notify.broadcast({ type: "persona:job", payload: job, timestamp: new Date().toISOString(), audience: job.owner });
}

type JobFlag = { id: string; note: string };

/**
 * The run's flagged job as stored now — another run of the same job may have
 * handed it the job's flag since `run` was read (restoreFlaggedJob).
 */
function storedFlag(db: Database, runId: string): JobFlag | undefined {
  const row = db.query("SELECT flagged_job_id, flagged_job_note FROM pipeline_runs WHERE id = ?").get(runId) as
    | { flagged_job_id: string | null; flagged_job_note: string | null }
    | null;
  return row?.flagged_job_id ? { id: row.flagged_job_id, note: row.flagged_job_note ?? "" } : undefined;
}

/** Whether `job` waits on exactly the note another of its runs (not `runId`) left there while that run waits too. */
function flaggedByOtherRun(db: Database, job: PersonaJob, runId: string): boolean {
  return listPipelineRunsByLaunches(db, job.launchIds).some(
    (r) => r.id !== runId && r.status === "waiting_user" && r.flaggedJob?.id === job.id && r.flaggedJob.note === job.note
  );
}

/**
 * Inside a write transaction: notes the run's block on the launch's Persona
 * job, which stays active — Persona decides what happens (see
 * decidePipelineStage), and only its escalation sets the job waiting on the
 * owner. An active job, or one still carrying this run's earlier note (a
 * job a block set waiting before blocks went to Persona is made active
 * again), gets "Persona deciding: <reason>". A job already noted for another
 * of its runs' blocks keeps that run's note, and this run is recorded as
 * flagging it too, so the note stays until every one of them moves on; a job
 * waiting on the owner for anything else is left as it is. Returns the job
 * when it changed and the flag to keep on the run, or null when no job is
 * involved (none, or someone other than a run moved it).
 */
function flagJob(db: Database, run: PipelineRun, reason: string): { job: PersonaJob | null; flag: JobFlag } | null {
  const owned = personaJobForLaunch(db, run.launchId);
  if (!owned) return null;
  const flag = storedFlag(db, run.id);
  const current = owned.job;
  const ours = !!flag && flag.id === current.id && current.note === flag.note;
  const legacyOurs = ours && current.status === "waiting_user" && (current.note ?? "").startsWith(LEGACY_FLAG_NOTE);
  if ((current.status === "active" && (ours || !flaggedByOtherRun(db, current, run.id))) || legacyOurs) {
    const note = `${PERSONA_DECIDING_NOTE}${reason}`;
    const job = updatePersonaJob(db, current.id, { ...(current.status === "active" ? {} : { status: "active" as const }), note });
    return job ? { job, flag: { id: job.id, note } } : null;
  }
  if ((current.status === "active" || current.status === "waiting_user") && flaggedByOtherRun(db, current, run.id)) {
    return { job: null, flag: { id: current.id, note: current.note ?? "" } };
  }
  return null;
}

/**
 * Inside a write transaction: the Persona job `run` had flagged (`flag`, as
 * stored before the move) once the run moved on — when the job still carries
 * exactly that note (the owner or Persona didn't touch it since): Persona's
 * deciding note, its escalation (the job waiting on the owner), or a legacy
 * flag. While another of the job's runs is still blocked — one whose worker
 * hasn't ended (launchEnded) — the job is noted for that run's block (active,
 * Persona deciding) and that run takes over the flag (`flagger`, re-read, to
 * be published); otherwise the job is active again. Null when there is
 * nothing to change.
 */
function restoreFlaggedJob(
  db: Database,
  run: PipelineRun,
  flag: JobFlag | undefined,
  stageTitle: string
): { job: PersonaJob | null; flagger: PipelineRun | null } | null {
  if (!flag) return null;
  const job = getPersonaJob(db, flag.id);
  if (!job || (job.status !== "waiting_user" && job.status !== "active") || job.note !== flag.note) return null;
  const other = listPipelineRunsByLaunches(db, job.launchIds).find(
    (r) => r.id !== run.id && r.status === "waiting_user" && !launchEnded(db, r.launchId)
  );
  if (other) {
    const note = `${PERSONA_DECIDING_NOTE}${other.waitingReason ?? `launch ${other.launchId}'s pipeline is waiting`}`;
    const kept = updatePersonaJob(db, job.id, { ...(job.status === "active" ? {} : { status: "active" as const }), note });
    if (!kept) return null;
    setPipelineRunFlaggedJob(db, other.id, { id: kept.id, note });
    return { job: kept, flagger: getPipelineRun(db, other.id) };
  }
  return { job: updatePersonaJob(db, job.id, { status: "active", note: `Pipeline moved on: ${stageTitle}` }), flagger: null };
}

/**
 * Tells the owner's Persona that `run` is blocked (a `pipeline:blocked`
 * frame, which its event router turns into an immediate inbox item) — when
 * the run waits and its launch belongs to an open Persona job. A run with no
 * Persona job waits for the owner in the console, as it always has.
 */
function publishBlocked(db: Database, run: PipelineRun, notify: PipelineNotify): void {
  if (run.status !== "waiting_user") return;
  const owned = personaJobForLaunch(db, run.launchId);
  if (!owned || owned.job.owner !== run.owner) return;
  if (owned.job.status !== "active" && owned.job.status !== "waiting_user") return;
  const launch = getLaunch(db, run.launchId);
  const payload: PipelineBlockedPayload = {
    owner: run.owner,
    jobId: owned.job.id,
    runId: run.id,
    launchId: run.launchId,
    ...(launch?.sessionId ? { sessionId: launch.sessionId } : {}),
    stage: run.currentStage,
    ...(run.waitingKind ? { waitingKind: run.waitingKind } : {}),
    reason: run.waitingReason ?? `the run is waiting at ${run.currentStage}`,
    options: ["skip", "waive", "close_out", ...(wontfixHold(run) ? ["accept_wontfix"] : []), "escalate"],
  };
  notify.broadcast({ type: "pipeline:blocked", payload, timestamp: new Date().toISOString(), audience: run.owner });
}

/** Pushes what restoreFlaggedJob changed: the job, and the run that took over its flag. */
function publishRestored(restored: { job: PersonaJob | null; flagger: PipelineRun | null } | null, notify: PipelineNotify): void {
  if (!restored) return;
  publishJob(restored.job, notify);
  if (restored.flagger) publishRun(restored.flagger, notify);
}

/**
 * Sets the run waiting (`kind`, `reason`), when it is still as read. When the
 * launch belongs to a Persona job, the block goes to Persona: the job stays
 * active, noted "Persona deciding: <reason>" (flagJob) and pushed to
 * clients, and a `pipeline:blocked` frame wakes Persona to decide
 * (publishBlocked). Without one the run waits for the owner in the console.
 * Returns the updated run, or null when the run moved since `run` was read.
 */
export function markRunWaiting(
  db: Database,
  run: PipelineRun,
  reason: string,
  kind: PipelineWaitingKind,
  notify: PipelineNotify,
  extra: UpdatePipelineRunPatch = {}
): PipelineRun | null {
  const result = db.transaction(() => {
    const flagged = flagJob(db, run, reason);
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      ...extra,
      status: "waiting_user",
      waitingReason: reason,
      waitingKind: kind,
      ...(flagged ? { flaggedJob: flagged.flag } : {}),
    });
    if (!moved) throw new StaleRun();
    return { run: moved, job: flagged?.job ?? null };
  });
  let out: { run: PipelineRun; job: PersonaJob | null };
  try {
    out = result();
  } catch (e) {
    if (e instanceof StaleRun) return null;
    throw e;
  }
  publishRun(out.run, notify);
  publishJob(out.job, notify);
  publishBlocked(db, out.run, notify);
  return out.run;
}

/** Thrown inside a write transaction to roll it back when the run's compare-and-set missed. */
class StaleRun extends Error {}

// ----------------------------------------------------------------------------
// Advancing.
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type AttemptRecord = {
  id?: string;
  status: PipelineAttemptStatus;
  evidence?: unknown;
  reason: string;
  sessionId?: string;
  /**
   * Writes made in the same transaction as the attempt (Persona's decision
   * audit), so neither lands without the other; given the stage the run is
   * left at.
   */
  alongside?: (to: string) => void;
};

/**
 * Commits a move of `run` from `from` along a planned transition, if the run
 * is still as read: the attempt at `from`, each auto-skipped stage, and the
 * run's new stage — complete on reaching the complete stage, active
 * otherwise, which also returns a Persona job the run had set waiting.
 * Publishes the run (and job) and runs the entered stage's onEnter. Null when
 * the run moved since it was read.
 */
async function commitMove(
  db: Database,
  run: PipelineRun,
  from: PipelineStageDef,
  attempt: AttemptRecord,
  to: string,
  skipped: Array<{ stageId: string; reason: string }>,
  facts: PipelineFacts,
  deps: PipelineDeps,
  opts: { newEpoch?: number } = {}
): Promise<PipelineRun | null> {
  const target = stageOf(run, to);
  const chain = [...skipped.map((s) => s.stageId), to];
  const tx = db.transaction(() => {
    const flag = storedFlag(db, run.id);
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      currentStage: to,
      status: target?.kind === "complete" ? "complete" : "active",
      waitingReason: null,
      waitingKind: null,
      flaggedJob: null,
      reviewHandoffAt: null,
      facts,
      stopBlocks: 0,
      stageEnteredAt: new Date().toISOString(),
      ...(opts.newEpoch !== undefined ? { epoch: opts.newEpoch } : {}),
    });
    if (!moved) throw new StaleRun();
    // The attempt that moved the run belongs to the epoch it was made in.
    recordPipelineAttempt(db, run.id, {
      id: attempt.id,
      stageId: from.id,
      status: attempt.status,
      evidence: attempt.evidence,
      reason: attempt.reason,
      sessionId: attempt.sessionId,
      nextStage: chain[0],
      epoch: run.epoch ?? 0,
    });
    skipped.forEach((s, i) => {
      recordPipelineAttempt(db, run.id, { stageId: s.stageId, status: "skipped", reason: s.reason, nextStage: chain[i + 1] });
    });
    attempt.alongside?.(to);
    const restored = restoreFlaggedJob(db, run, flag, target?.title ?? to);
    return { run: getPipelineRun(db, run.id)!, restored };
  });
  let out: { run: PipelineRun; restored: ReturnType<typeof restoreFlaggedJob> };
  try {
    out = tx();
  } catch (e) {
    if (e instanceof StaleRun) return null;
    throw e;
  }
  publishRun(out.run, deps);
  publishRestored(out.restored, deps);
  if (target) await enterStage(db, out.run, target, deps);
  return getPipelineRun(db, run.id) ?? out.run;
}

/**
 * Runs the entered stage's runner onEnter — or, when the stage can't apply to
 * the launch, skips it at once (settleNotApplicableStage). A failure there is
 * logged and never undoes the move.
 */
async function enterStage(db: Database, run: PipelineRun, stage: PipelineStageDef, deps: PipelineDeps): Promise<void> {
  try {
    if (stageNotApplicable(db, run, stage)) {
      await settleNotApplicableStage(db, run, deps);
      return;
    }
  } catch (err) {
    console.error(`[pipeline] skipping ${stage.id} of run ${run.id} as not applicable failed:`, err);
    return;
  }
  const onEnter = getPipelineStageRunner(stage.kind)?.onEnter;
  if (!onEnter) return;
  try {
    await onEnter({
      db,
      run,
      stage,
      launch: getLaunch(db, run.launchId),
      deps,
      // The ticket's url is the review gate's only once the gate ran (see
      // ticketUrlFromReviewGate); before that it can only be a worker's
      // report, which needs an issue id.
      recordReviewUrl: async (url) => {
        await recordReviewUrl(db, run.launchId, url, undefined, deps, { fromReviewGate: ticketUrlFromReviewGate(db, run) });
      },
    });
  } catch (err) {
    console.error(`[pipeline] entering ${stage.id} of run ${run.id} failed:`, err);
  }
}

/**
 * Commits an attempt that leads nowhere — a loop or attempt budget ran out
 * (`exhausted`), or wontfix review findings (`owner_input`) — and sets the
 * run waiting with `reason`, if the run is still as read: through the
 * launch's Persona job to Persona, else to the owner (as markRunWaiting).
 * Null when it moved.
 */
function commitExhausted(
  db: Database,
  run: PipelineRun,
  from: PipelineStageDef,
  attempt: AttemptRecord,
  facts: PipelineFacts,
  reason: string,
  deps: PipelineDeps,
  kind: PipelineWaitingKind = "exhausted"
): PipelineRun | null {
  const tx = db.transaction(() => {
    const flagged = flagJob(db, run, reason);
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      status: "waiting_user",
      waitingReason: reason,
      waitingKind: kind,
      facts,
      stopBlocks: 0,
      ...(flagged ? { flaggedJob: flagged.flag } : {}),
    });
    if (!moved) throw new StaleRun();
    recordPipelineAttempt(db, run.id, {
      id: attempt.id,
      stageId: from.id,
      status: attempt.status,
      evidence: attempt.evidence,
      reason: attempt.reason,
      sessionId: attempt.sessionId,
    });
    attempt.alongside?.(from.id);
    return { run: getPipelineRun(db, run.id)!, job: flagged?.job ?? null };
  });
  let out: { run: PipelineRun; job: PersonaJob | null };
  try {
    out = tx();
  } catch (e) {
    if (e instanceof StaleRun) return null;
    throw e;
  }
  publishRun(out.run, deps);
  publishJob(out.job, deps);
  publishBlocked(db, out.run, deps);
  return out.run;
}

function checkpointFor(db: Database, run: PipelineRun, sessionId: string | undefined, text: string, deps: PipelineDeps): void {
  const target = sessionId ?? getLaunch(db, run.launchId)?.sessionId;
  if (target) deps.checkpoint(target, text);
}

/**
 * The facts a transition is planned with: the run's, or — when none were
 * computed yet and some stage auto-skips on a fact — computed now from the
 * worktree (the worker's changed files from earlier coding attempts filling
 * in when git can't tell).
 */
async function factsForPlanning(run: PipelineRun, launch: Launch | null, facts: PipelineFacts, deps: PipelineDeps): Promise<PipelineFacts> {
  if (Object.keys(facts).length > 0) return facts;
  if (!run.definition.stages.some((s) => (s.skipWhen ?? []).length > 0)) return facts;
  const computed = await changeFacts(launch, reportedChangedFiles(run), definitionUiPaths(run.definition), deps);
  return computed.facts ?? facts;
}

/**
 * Why the transition to `to` would overrun its target's attempt cap (counted
 * in the run's current epoch), or null. Entering complete is never capped.
 */
function attemptCapReason(run: PipelineRun, to: string): string | null {
  const target = stageOf(run, to);
  const used = currentEpochAttempts(run).filter((a) => a.stageId === to).length;
  if (target && target.kind !== "complete" && used >= stageMaxAttempts(target)) {
    return `${target.id} already ran ${stageMaxAttempts(target)} times (its attempt cap) without the pipeline converging`;
  }
  return null;
}

/**
 * Advances `runId` from its current stage `input.stage` with the worker's
 * evidence (or a skip). The stage kind's runner completes the evidence where
 * the server can — the changed files and facts on coding, the approved
 * acceptance criterion on validation, stored screenshot copies, the floor
 * asks of an outward stage — then the kind's rule gives the outcome and the
 * matching edge is followed (auto-skipping stages whose skipWhen holds). A
 * transition whose loop or attempt budget is spent records the attempt and
 * hands the run to its owner (exhausted). Refuses (409) a stage that isn't
 * current, a worker's advance while the run waits on its owner for a
 * decision (a budget ran out: exhausted), and an advance whose run moved
 * meanwhile — a stalled run takes the worker's valid advance and is active
 * again (the job it flagged with it);
 * refuses (422) missing or invalid evidence, naming each field in `missing` —
 * and a code review without the owner's issue id also hands the run to the owner for it.
 */
export async function advancePipeline(
  db: Database,
  runId: string,
  input: AdvanceInput,
  deps: PipelineDeps
): Promise<AdvanceResult> {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (run.status === "disabled") return { ok: false, status: 409, error: "The delivery pipeline is disabled for this launch" };
  if (run.status === "complete") return { ok: false, status: 409, error: "The delivery pipeline is already complete" };
  if (input.stage !== run.currentStage) {
    return {
      ok: false,
      status: 409,
      error: `"${input.stage}" is not the current stage — the run is at "${run.currentStage}". Call pipeline_status to see what it needs.`,
    };
  }
  const source: EvidenceSource = input.source ?? "worker";
  if (source === "worker" && run.status === "waiting_user" && run.waitingKind === "exhausted") {
    return { ok: false, status: 409, error: `The run is waiting on its owner (${run.waitingReason ?? run.waitingKind}) — ${OWNER_NEEDED}` };
  }
  const stage = stageOf(run, run.currentStage);
  if (!stage) return { ok: false, status: 409, error: `The run's current stage "${run.currentStage}" is not in its definition` };
  const launch = getLaunch(db, run.launchId);
  const from = stage.id;
  const attemptId = randomUUID();
  const stale = (): AdvanceResult => ({ ok: false, status: 409, error: STALE_RUN });

  // A skip moves along the passed edge without evidence.
  if (input.skip) {
    const reason = typeof input.skip.reason === "string" ? input.skip.reason.trim() : "";
    if (!stage.skippable) return { ok: false, status: 422, error: `The ${stage.id} stage can't be skipped`, missing: [] };
    // A layer may have made a protected stage skippable; the worker still can't skip it.
    const config = currentPipelineConfig(db, run);
    const guarded = protectedStageReason(db, run, stage, config);
    if (guarded) {
      return { ok: false, status: 422, error: `The ${stage.id} stage can't be skipped: ${guarded} — report its evidence, or ask_human`, missing: [] };
    }
    if (!reason) return { ok: false, status: 422, error: "A skip needs a reason", missing: ["skip.reason (why the stage doesn't apply)"] };
    if (reason.length > MAX_EVIDENCE_STRING) {
      return { ok: false, status: 422, error: "The skip reason is too long", missing: [`skip.reason (at most ${MAX_EVIDENCE_STRING} characters)`] };
    }
    // On a full run the worker's skip of a deploy or screenshot stage its change touches is refused as Persona's is.
    const refusal = await changeRefusal(db, run, stage, config, "skipped", deps);
    if (refusal) {
      return { ok: false, status: 422, error: `Refused: ${refusal} — report its evidence, or ask Persona to escalate it to the owner`, missing: [] };
    }
    return (await commitSkip(db, run, stage, { id: attemptId, status: "skipped", reason, sessionId: input.sessionId }, deps)) ?? stale();
  }

  // A stage that can't apply to this launch (a code_review stage with no review to cut) is
  // skipped by the server, whatever the worker reported for it.
  const settled = await settleNotApplicableStage(db, run, deps);
  if (settled) return settled.ok ? { ...settled, message: `${settled.message} Call pipeline_status for the stage you're at now.` } : settled;

  // `source` is the server's to set: a worker can't pass its evidence off as
  // the review gate's. Nor can it name a stored screenshot copy or its
  // dimensions — those are the collector's, set by the screenshot runner.
  const reported: Record<string, unknown> = isRecord(input.evidence) ? { ...input.evidence } : {};
  delete reported.source;
  if (Array.isArray(reported.screenshots)) {
    reported.screenshots = reported.screenshots.map((shot) => {
      if (!isRecord(shot)) return shot;
      const { storedPath: _stored, width: _width, height: _height, ...rest } = shot;
      return rest;
    });
  }
  if (source === "review_gate") reported.source = "review_gate";
  const missing = validateEvidence(stage, reported);
  if (missing.length > 0) {
    const gate = stage.kind === CODE_REVIEW_STAGE_KIND ? projectReviewGate(db, run.projectId) : null;
    if (gate && missing.some((m) => m.startsWith("evidence.issueId"))) {
      // The project's review gate cuts and records the review (with or without
      // an issue id), so a missing id is no reason to hand the run to the owner.
      const inReview = getTicketByLaunch(db, run.launchId)?.status === "needs_review";
      return { ok: false, status: 422, error: `The ${stage.id} stage is finished by the review gate: ${reviewGateCodeReviewStep(gate, inReview)}.`, missing };
    }
    if (source === "worker" && stage.ownerInput === "issue_id" && missing.some((m) => m.startsWith("evidence.issueId")) && !knownIssueId(db, run.launchId)) {
      const launch = getLaunch(db, run.launchId);
      if (stage.kind === CODE_REVIEW_STAGE_KIND && launch && launchWorkLanded(db, run, launch)) {
        // Already landed: no review left to cut, so nobody is asked for an issue id.
        const waiting =
          run.status === "waiting_user" && run.waitingReason === REVIEW_LANDED_REASON ? run : markRunWaiting(db, run, REVIEW_LANDED_REASON, "owner_input", deps);
        const note = waiting ? " The owner has been told to close the job, which closes it as landed." : "";
        return { ok: false, status: 409, error: `The change already landed in its target branch, so there is no code review to cut.${note}` };
      }
      const waiting = run.status === "waiting_user" && run.waitingKind === "owner_input" ? run : markRunWaiting(db, run, ISSUE_ID_REASON, "owner_input", deps);
      const note = waiting ? " The owner has been asked for it; ask_human for it too, then advance again with it." : "";
      return { ok: false, status: 422, error: `The ${stage.id} stage needs the owner's issue id.${note}`, missing };
    }
    return { ok: false, status: 422, error: `The ${stage.id} stage's evidence is incomplete`, missing };
  }

  const ctx = { db, run, stage, launch, facts: run.facts, sessionId: input.sessionId, source, attemptId, deps };
  const cleanups: Array<() => void> = [];
  const cleanup = () => cleanups.forEach((fn) => fn());
  let evidence = reported;
  let facts = run.facts;
  const steps: Array<(c: typeof ctx & { evidence: Record<string, unknown> }) => Promise<PreparedEvidence> | PreparedEvidence> = [];
  const runner = getPipelineStageRunner(stage.kind);
  if (runner?.prepareEvidence) steps.push(runner.prepareEvidence);
  if (isOutwardStage(stage)) steps.push(prepareOutwardEvidence);
  for (const step of steps) {
    const prepared = await step({ ...ctx, evidence, facts });
    if ("error" in prepared) {
      cleanup();
      return { ok: false, status: prepared.status, error: prepared.error, ...(prepared.missing ? { missing: prepared.missing } : {}) };
    }
    evidence = prepared.evidence;
    if (prepared.facts) facts = prepared.facts;
    if (prepared.cleanup) cleanups.push(prepared.cleanup);
  }
  facts = await factsForPlanning(run, launch, facts, deps);

  const { outcome, reason } = evaluateOutcome(stage, evidence);
  const attempt: AttemptRecord = { id: attemptId, status: outcome, evidence, reason, sessionId: input.sessionId };
  if (outcome === "failed" && reviewBlockedOnlyByWontfix(stage, evidence)) {
    // Another coding round can't settle findings the worker won't fix: the
    // run holds here for the owner, and the worker may still re-advance.
    const updated = commitExhausted(db, run, stage, attempt, facts, WONTFIX_REASON, deps, "owner_input");
    if (!updated) {
      cleanup();
      return stale();
    }
    const message = `Pipeline: ${from} ${outcome} (${reason}); held at ${from} for the owner.`;
    checkpointFor(db, updated, input.sessionId, message, deps);
    return { ok: true, run: updated, from, to: from, outcome, skipped: [], message };
  }
  const plan = planTransition(run.definition, { currentStage: from, attempts: currentEpochAttempts(run), facts }, outcome);
  const stuck = plan.kind === "exhausted" ? plan.reason : attemptCapReason(run, plan.to);
  if (stuck !== null || plan.kind === "exhausted") {
    const why = stuck ?? "no transition";
    const updated = commitExhausted(db, run, stage, attempt, facts, `${why} — ${PERSONA_DECIDES}`, deps);
    if (!updated) {
      cleanup();
      return stale();
    }
    const message = `Pipeline: ${from} ${outcome} (${reason}); ${why}. The run is waiting for Persona or the owner to decide.`;
    checkpointFor(db, updated, input.sessionId, message, deps);
    return { ok: true, run: updated, from, to: from, outcome, skipped: [], message };
  }
  const blocked = entryBlock(db, run, plan.to);
  if (blocked) {
    cleanup();
    // The refused advance records nothing, so screenshots it carried aren't
    // among the run's: the worker is told to attach those it just took.
    const shots = Array.isArray(reported.screenshots) ? reported.screenshots.length : 0;
    const carried =
      shots > 0
        ? ` Attach the ${shots === 1 ? "screenshot" : `${shots} screenshots`} you just reported as the packet's media, then report ${from} again.`
        : "";
    return entryRefusal(db, run, plan.to, `${blocked}${carried}`, deps);
  }
  const updated = await commitMove(db, run, stage, attempt, plan.to, plan.skipped, facts, deps);
  if (!updated) {
    cleanup();
    return stale();
  }
  const { to, message } = landing(updated, from, plan.to, outcome, reason, plan.skipped);
  checkpointFor(db, updated, input.sessionId, message, deps);
  return { ok: true, run: updated, from, to, outcome, skipped: plan.skipped, message };
}

/**
 * Records `attempt` (a skip) at the run's current `stage` and moves along its
 * passed edge — or, when that edge's loop or attempt budget is spent, hands
 * the run to its owner. Null when the run moved since it was read.
 */
async function commitSkip(
  db: Database,
  run: PipelineRun,
  stage: PipelineStageDef,
  attempt: AttemptRecord,
  deps: PipelineDeps
): Promise<AdvanceResult | null> {
  const from = stage.id;
  const facts = await factsForPlanning(run, getLaunch(db, run.launchId), run.facts, deps);
  const plan = planTransition(run.definition, { currentStage: from, attempts: currentEpochAttempts(run), facts }, "passed");
  const stuck = plan.kind === "exhausted" ? plan.reason : attemptCapReason(run, plan.to);
  if (stuck !== null || plan.kind === "exhausted") {
    const why = stuck ?? "no transition";
    const updated = commitExhausted(db, run, stage, attempt, facts, `${why} — ${PERSONA_DECIDES}`, deps);
    if (!updated) return null;
    const message = `Pipeline: ${from} skipped (${attempt.reason}); ${why}. The run is waiting for Persona or the owner to decide.`;
    checkpointFor(db, updated, attempt.sessionId, message, deps);
    return { ok: true, run: updated, from, to: from, outcome: "skipped", skipped: [], message };
  }
  const blocked = entryBlock(db, run, plan.to);
  if (blocked) return entryRefusal(db, run, plan.to, blocked, deps);
  const updated = await commitMove(db, run, stage, attempt, plan.to, plan.skipped, facts, deps);
  if (!updated) return null;
  const { to, message } = landing(updated, from, plan.to, "skipped", attempt.reason, plan.skipped);
  checkpointFor(db, updated, attempt.sessionId, message, deps);
  return { ok: true, run: updated, from, to, outcome: "skipped", skipped: plan.skipped, message };
}

/**
 * The refusal of a move onto `stageId` the stage won't take yet (see
 * entryBlock) — the review packet it waits for, whose draft is opened and
 * the worker briefed on (briefReviewPacket).
 */
function entryRefusal(db: Database, run: PipelineRun, stageId: string, why: string, deps: PipelineDeps): AdvanceResult {
  briefReviewPacket(db, run, deps);
  return { ok: false, status: 422, error: `The run can't move on to ${stageId}: ${why}`, missing: ["a submitted review packet"] };
}

/**
 * Why the run may not enter `stageId` yet (its runner's entryBlock), or null.
 * Stages auto-skipped on the way there are passed over, since the run doesn't
 * stop at them.
 */
function entryBlock(db: Database, run: PipelineRun, stageId: string): string | null {
  const stage = stageOf(run, stageId);
  const check = stage ? getPipelineStageRunner(stage.kind)?.entryBlock : undefined;
  return check && stage ? check({ db, run, stage, launch: getLaunch(db, run.launchId) }) : null;
}

/** Why the run's current stage can't apply to its launch (its runner's notApplicable), or null. */
function stageNotApplicable(db: Database, run: PipelineRun, stage: PipelineStageDef): string | null {
  const check = getPipelineStageRunner(stage.kind)?.notApplicable;
  return check ? check({ db, run, stage, launch: getLaunch(db, run.launchId) }) : null;
}

/**
 * Skips the open run's current stage when it can't apply to the launch
 * (stageNotApplicable): recorded `skipped` with the reason — never passed —
 * and the run moves on along the stage's passed edge, which also lifts a wait
 * on the owner the stage had caused. Null when the stage applies (or the run
 * isn't open); a stale result when the run moved meanwhile.
 */
export async function settleNotApplicableStage(db: Database, run: PipelineRun, deps: PipelineDeps): Promise<AdvanceResult | null> {
  if (run.status !== "active" && run.status !== "waiting_user") return null;
  // A budget that already ran out on the owner stays theirs: skipping again
  // would only record another exhausted attempt and notify them again.
  if (run.status === "waiting_user" && run.waitingKind === "exhausted") return null;
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind === "start" || stage.kind === "complete") return null;
  const reason = stageNotApplicable(db, run, stage);
  if (!reason) return null;
  return (await commitSkip(db, run, stage, { status: "skipped", reason }, deps)) ?? { ok: false, status: 409, error: STALE_RUN };
}

/**
 * Settles every open run sitting at a stage that can't apply to its launch
 * (settleNotApplicableStage) — run once at boot, for runs that reached such a
 * stage before Standup could tell. Returns how many moved; a failure on one
 * run is logged and the rest still settle.
 */
export async function settleNotApplicableRuns(db: Database, deps: PipelineDeps): Promise<number> {
  let moved = 0;
  for (const run of listOpenPipelineRuns(db)) {
    try {
      if ((await settleNotApplicableStage(db, run, deps))?.ok) moved++;
    } catch (err) {
      console.error(`[pipeline] settling run ${run.id}'s not-applicable stage failed:`, err);
    }
  }
  return moved;
}

/**
 * Where the run ended up after a move to `to` and that move's message: the
 * stage entered may have settled itself on entry (a code_review stage with no
 * review to cut), leaving the run further along than `to`.
 */
function landing(
  run: PipelineRun,
  from: string,
  to: string,
  outcome: string,
  reason: string,
  skipped: Array<{ stageId: string; reason: string }>
): { to: string; message: string } {
  const message = transitionMessage(run, from, to, outcome, reason, skipped);
  if (run.currentStage === to) return { to, message };
  return { to: run.currentStage, message: `${message} ${to} settled itself; the run is at ${run.currentStage}.` };
}

function transitionMessage(
  run: PipelineRun,
  from: string,
  to: string,
  outcome: string,
  reason: string,
  skipped: Array<{ stageId: string; reason: string }>
): string {
  const skips = skipped.length > 0 ? `; skipped ${skipped.map((s) => `${s.stageId} (${s.reason})`).join(", ")}` : "";
  const waiting = run.status === "waiting_user" && run.waitingReason ? ` Waiting for the owner: ${run.waitingReason}.` : "";
  const done = run.status === "complete" ? " The delivery pipeline is complete." : "";
  return `Pipeline: ${from} ${outcome} (${reason}) → ${to}${skips}.${waiting}${done}`;
}

/** Files named in a coding attempt's evidence (changedFiles, commits) across the whole run. */
function reportedChanges(run: PipelineRun): string[] {
  return run.attempts.flatMap((a) => {
    const ev = a.evidence as { changedFiles?: unknown; commits?: unknown } | undefined;
    return [ev?.changedFiles, ev?.commits].flatMap((list) =>
      Array.isArray(list) ? list.filter((f): f is string => typeof f === "string" && f.trim() !== "") : []
    );
  });
}

/**
 * The not-applicable waivers recorded in the run's current epoch — the ones
 * that rest on the launch changing no code — oldest first. A close-out's
 * waivers (stages no longer in the project's pipeline) don't: they hold
 * whatever the change is.
 */
function notApplicableWaivers(run: PipelineRun): Array<{ attempt: PipelineStageAttempt; waiver: PipelineWaiverEvidence["waiver"] }> {
  return currentEpochAttempts(run).flatMap((a) => {
    const waiver = (a.evidence as Partial<PipelineWaiverEvidence> | undefined)?.waiver;
    return a.status === "waived" && waiver?.notApplicable === true && waiver.kind !== "close_out" ? [{ attempt: a, waiver }] : [];
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What readLaunchCheckouts reads of a launch's checkouts. */
type LaunchCheckoutsRead =
  | { kind: "read"; files: string[]; head: string; reflog: number; states: Array<{ key: string; state: HeadState }> }
  | { kind: "unknown"; why: string };

/**
 * The launch's checkouts (workingDirCheckouts) as git reads them now: their
 * changed files (checkoutChangedFiles, labelled by package on a workspace),
 * their HEADs and reflog lengths in the form a waiver pins — a workspace's
 * packages all together — and each checkout's HEAD state keyed as a
 * LaunchCheckoutSnapshot keys it. `unknown` when git can't read one of them.
 */
async function readLaunchCheckouts(launch: Launch, deps: Pick<PipelineDeps, "changedFiles" | "headState">): Promise<LaunchCheckoutsRead> {
  const checkouts = workingDirCheckouts(launch);
  if (checkouts.length === 0) return { kind: "unknown", why: "Standup can't read this launch's checkout (its workspace has no package checked out)" };
  const files: string[] = [];
  const heads: string[] = [];
  const states: Array<{ key: string; state: HeadState }> = [];
  let reflog = 0;
  for (const checkout of checkouts) {
    let state: HeadState;
    try {
      files.push(...(await checkoutChangedFiles(checkout, deps.changedFiles)));
      state = await (deps.headState ?? gitHeadState)(checkout.path);
    } catch (err) {
      const where = checkout.label ? ` ${checkout.label}` : "";
      return { kind: "unknown", why: `Standup can't read this launch's checkout${where} (${(err as Error).message})` };
    }
    heads.push(checkout.label ? `${checkout.label}@${state.head}#${checkout.gitDirId}:${state.reflog.length}` : state.head);
    states.push({ key: [checkout.label, checkout.gitDirId ?? ""].join("#"), state });
    reflog += state.reflog.length;
  }
  return { kind: "read", files, head: heads.join(" "), reflog, states };
}

/** Whether a HEAD reflog entry commits, or leaves `head` (a commit, switch or reset). */
function reflogMoves(entry: string, head: string): boolean {
  return entry.split(" ", 1)[0] !== head || /^\S+ (commit|cherry-pick|merge|revert|rebase)/.test(entry);
}

/** A digest of reflog entries, oldest last, as a LaunchCheckoutSnapshot holds them. */
function reflogDigest(entries: string[]): string {
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * How many times the checkouts moved since `snapshot`: each reflog entry
 * written since that commits or leaves the current commit, and one for each
 * checkout that is new, gone, re-cloned, whose HEAD changed with no entry to
 * show for it, or whose reflog no longer ends in the entries the snapshot
 * read (some were deleted or rewritten). With no snapshot, every entry counts.
 */
function movesSince(states: Array<{ key: string; state: HeadState }>, snapshot: LaunchCheckoutSnapshot | undefined): number {
  if (!snapshot) return states.reduce((n, { state }) => n + state.reflog.filter((e) => reflogMoves(e, state.head)).length, 0);
  const keys = new Set(states.map((s) => s.key));
  let moved = Object.keys(snapshot.checkouts).filter((key) => !keys.has(key)).length;
  for (const { key, state } of states) {
    const base = Object.hasOwn(snapshot.checkouts, key) ? snapshot.checkouts[key] : undefined;
    const fresh = base ? state.reflog.length - base.reflog : -1;
    if (!base || fresh < 0 || reflogDigest(state.reflog.slice(fresh)) !== base.log || (fresh === 0 && state.head !== base.head)) moved++;
    else moved += state.reflog.slice(0, fresh).filter((e) => reflogMoves(e, state.head)).length;
  }
  return moved;
}

/**
 * What the launch's checkout shows about code changes, read for a
 * not-applicable waiver: `unknown` when git can't read it (a missing
 * checkout, a workspace package that isn't a git checkout or has no base);
 * `changed` with why when the run reported changed files or commits, git
 * finds files changed against the base (committed, staged, unstaged or
 * untracked), or HEAD has moved. HEAD is held to `pinned` (the checkout as
 * the first waiver found it) when given, else no reflog entry of the
 * checkout's own HEAD may commit or leave the current commit (a commit,
 * switch or reset; a fresh worktree has none) — counting, on a launch with a
 * provision snapshot, only what was written since it (movesSince), so
 * provisioning's own pulls and checkouts aren't the agent's.
 * A file the provision snapshot already found changed doesn't count while
 * its content is as the snapshot found it; once it is committed, HEAD has
 * moved. `clean` carries the checkout as read, to pin. A provisioned
 * workspace is read package by package (readLaunchCheckouts).
 */
async function readNoCodeCheckout(
  db: Database,
  launchId: string,
  run: PipelineRun | null,
  deps: Pick<PipelineDeps, "changedFiles" | "headState">,
  pinned?: PipelineWaiverCheckout
): Promise<{ kind: "clean"; checkout: PipelineWaiverCheckout } | { kind: "changed" | "unknown"; why: string }> {
  const reported = run ? reportedChanges(run) : [];
  if (reported.length > 0) {
    return { kind: "changed", why: `this run reported a code change (${reported.slice(0, 3).join(", ")}${reported.length > 3 ? ", …" : ""})` };
  }
  const launch = getLaunch(db, launchId);
  if (!launch?.worktreePath) return { kind: "unknown", why: "Standup can't read this launch's checkout" };
  const read = await readLaunchCheckouts(launch, deps);
  if (read.kind === "unknown") return read;
  const snapshot = launch.provisionSnapshot;
  const setupDirty = snapshot ? read.files.filter((f) => Object.hasOwn(snapshot.dirty, f)) : [];
  const now = workingFileDigests(launch.worktreePath, setupDirty);
  const files = read.files.filter((f) => !setupDirty.includes(f) || now[f] !== snapshot!.dirty[f]);
  if (files.length > 0) {
    const named = files.slice(0, 5).join(", ") + (files.length > 5 ? ", …" : "");
    return { kind: "changed", why: `this launch changes ${plural(files.length, "file")} (${named})` };
  }
  if (pinned) {
    if (read.head !== pinned.head || read.reflog !== pinned.reflog) {
      return { kind: "changed", why: "this launch's checkout has moved (a commit, switch, reset or stash) since its stages were waived" };
    }
  } else {
    const moved = movesSince(read.states, snapshot);
    if (moved > 0) {
      const since = snapshot ? "since it was provisioned" : "in its history";
      return { kind: "changed", why: `this launch's checkout has ${plural(moved, "commit, switch or reset")} ${since}` };
    }
  }
  return { kind: "clean", checkout: { head: read.head, reflog: read.reflog } };
}

/** The most files setup may leave changed for a provision snapshot to discount; past it, none are. */
export const MAX_SNAPSHOT_DIRTY = 500;

/**
 * Records a provisioned launch's checkouts as provisioning and setup left
 * them (readLaunchCheckouts, with a digest of each file already changed —
 * none past MAX_SNAPSHOT_DIRTY of them), as the baseline its not-applicable
 * waivers are read against. Null, recording nothing, for a launch that isn't
 * provisioned or that git can't read.
 */
export async function captureProvisionSnapshot(
  db: Database,
  launchId: string,
  deps: Pick<PipelineDeps, "changedFiles" | "headState"> = { changedFiles: gitChangedFiles, headState: gitHeadState }
): Promise<LaunchCheckoutSnapshot | null> {
  const launch = getLaunch(db, launchId);
  if (!launch?.provisioned || !launch.worktreePath) return null;
  const read = await readLaunchCheckouts(launch, deps);
  if (read.kind === "unknown") return null;
  const dirty = read.files.length > MAX_SNAPSHOT_DIRTY ? {} : workingFileDigests(launch.worktreePath, read.files);
  const checkouts = Object.fromEntries(
    read.states.map(({ key, state }) => [key, { head: state.head, reflog: state.reflog.length, log: reflogDigest(state.reflog) }])
  );
  const snapshot: LaunchCheckoutSnapshot = { checkouts, dirty };
  setLaunchProvisionSnapshot(db, launchId, snapshot);
  return snapshot;
}

/**
 * Whether the launch's checkout reads as changing no code (readNoCodeCheckout
 * reads it clean): false when it changes code, or git can't tell.
 */
export async function launchChangesNoCode(
  db: Database,
  launchId: string,
  deps: Pick<PipelineDeps, "changedFiles" | "headState">
): Promise<boolean> {
  return (await readNoCodeCheckout(db, launchId, getPipelineRunByLaunch(db, launchId), deps)).kind === "clean";
}

/**
 * Whether the launch of `run` may have a stage waived as not applicable:
 * the refusal when it may not, else the checkout to pin on the waiver. The
 * checkout must read clean (readNoCodeCheckout) — and unchanged since the
 * run's first not-applicable waiver of this epoch, which pinned it.
 */
export async function notApplicableRefusal(
  db: Database,
  run: PipelineRun,
  deps: PipelineDeps
): Promise<{ refusal: string } | { checkout: PipelineWaiverCheckout }> {
  const ownerOnly = PERSONA_DECIDES;
  const pinned = notApplicableWaivers(run).find((w) => w.waiver.checkout)?.waiver.checkout;
  const read = await readNoCodeCheckout(db, run.launchId, run, deps, pinned);
  if (read.kind === "clean") return { checkout: read.checkout };
  if (read.kind === "unknown") return { refusal: `${read.why} to confirm it changed no code — ${ownerOnly}` };
  return { refusal: `${read.why} — a stage of a real change can't be waived as not applicable; report its evidence, or ${ownerOnly}` };
}

/**
 * Whether code turned up after the run's not-applicable waivers of this
 * epoch: null when there are none, or the checkout still matches what the
 * first one pinned; `changed` with why when it doesn't; `unknown` when git
 * can't read the checkout any more.
 */
export async function notApplicableDrift(
  db: Database,
  run: PipelineRun,
  deps: Pick<PipelineDeps, "changedFiles" | "headState"> & Partial<PipelineDeps>
): Promise<{ kind: "changed" | "unknown"; why: string; stages: string[] } | null> {
  const waivers = notApplicableWaivers(run);
  if (waivers.length === 0) return null;
  const stages = [...new Set(waivers.map((w) => w.attempt.stageId))];
  const pinned = waivers.find((w) => w.waiver.checkout)?.waiver.checkout;
  const read = await readNoCodeCheckout(db, run.launchId, run, deps, pinned);
  return read.kind === "clean" ? null : { kind: read.kind, why: read.why, stages };
}

export interface WaiveInput {
  stage: string;
  reason: string;
  /** Who is recorded as waiving: the owner's alias, or the worker / Persona. */
  actor: string;
  /**
   * `owner` (the default) — a person in the console, who may waive any stage;
   * `worker` or `persona` — only as not applicable, on a launch that changed
   * no code (notApplicableRefusal), never while a budget ran out on the owner,
   * and with a reason of at least MIN_WAIVE_REASON characters.
   */
  by?: PipelineWaiverBy;
  sessionId?: string;
}

/**
 * Waives the run's current stage (any stage short of complete): records it
 * `waived` — never passed — with the waiver (who, why, and whether it was
 * waived as not applicable) as its evidence, and moves along the stage's
 * passed edge, which also lifts an exhausted or stalled wait. The owner may
 * waive anything; the worker and Persona only what doesn't apply to a launch
 * that changed no code (see WaiveInput.by) — Persona's waiver of a review
 * held on wontfix findings is acceptWontfixReview. Refuses (409) a stage that isn't
 * current, a run that moved meanwhile, or a not-applicable waiver the launch
 * doesn't qualify for; (422) a reason that is too short or too long.
 */
export async function waivePipelineStage(db: Database, runId: string, input: WaiveInput, deps: PipelineDeps): Promise<AdvanceResult> {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (run.status === "disabled" || run.status === "complete") {
    return { ok: false, status: 409, error: `The run is ${run.status}; there is nothing to waive` };
  }
  if (input.stage !== run.currentStage) {
    return { ok: false, status: 409, error: `"${input.stage}" is not the current stage — the run is at "${run.currentStage}"` };
  }
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind === "complete") return { ok: false, status: 409, error: "There is no stage to waive" };
  const given = input.reason.trim();
  if (given.length > MAX_EVIDENCE_STRING) {
    return { ok: false, status: 422, error: `The waive reason is too long (at most ${MAX_EVIDENCE_STRING} characters)` };
  }
  const by: PipelineWaiverBy = input.by ?? "owner";
  if (by !== "owner") {
    if (given.length < MIN_WAIVE_REASON) {
      return {
        ok: false,
        status: 422,
        error: "A not-applicable waiver needs a reason",
        missing: [`waive.reason (why the stage doesn't apply, at least ${MIN_WAIVE_REASON} characters)`],
      };
    }
    if (run.status === "waiting_user" && run.waitingKind === "exhausted") {
      return { ok: false, status: 409, error: `The run is waiting on its owner (${run.waitingReason ?? run.waitingKind}) — ${OWNER_NEEDED}` };
    }
  }
  if (by === "persona") {
    const guarded = protectedStageReason(db, run, stage, currentPipelineConfig(db, run));
    if (guarded) return { ok: false, status: 409, error: `The ${stage.id} stage can't be waived by Persona: ${guarded} — ${ESCALATE_HINT}.` };
  }
  let checkout: PipelineWaiverCheckout | undefined;
  if (by !== "owner") {
    if (wontfixHold(run)) {
      return {
        ok: false,
        status: 409,
        error:
          by === "persona"
            ? `The ${stage.id} stage is held on wontfix findings, not inapplicable: accept them with waive_pipeline_stage kind "accept_wontfix", or leave it for the owner to waive in the console.`
            : `The ${stage.id} stage is held on wontfix findings, not inapplicable: the owner or their Persona decides it — fix the findings and report review again, or wait.`,
      };
    }
    const allowed = await notApplicableRefusal(db, run, deps);
    if ("refusal" in allowed) {
      return { ok: false, status: 409, error: `The ${stage.id} stage can't be waived as not applicable: ${allowed.refusal}.` };
    }
    checkout = allowed.checkout;
  }
  const facts = await factsForPlanning(run, getLaunch(db, run.launchId), run.facts, deps);
  const plan = planTransition(run.definition, { currentStage: stage.id, attempts: currentEpochAttempts(run), facts }, "passed");
  if (plan.kind === "exhausted") return { ok: false, status: 409, error: plan.reason };
  // No entryBlock here: the owner may waive onto any stage, and a worker's or
  // Persona's waiver is only ever for a launch that changed no code
  // (notApplicableRefusal) — there is no change for a review packet to show.
  const notApplicable = by !== "owner";
  const evidence: PipelineWaiverEvidence = {
    waiver: {
      by,
      actor: input.actor,
      reason: given,
      notApplicable,
      ...(checkout ? { checkout } : {}),
      ...(by === "persona" ? { kind: "not_applicable" as const } : {}),
    },
  };
  const reason = notApplicable ? `not applicable — waived by ${input.actor}: ${given}` : `waived by ${input.actor}: ${given}`;
  const updated = await commitMove(
    db,
    run,
    stage,
    { status: "waived", evidence, reason, sessionId: input.sessionId },
    plan.to,
    plan.skipped,
    facts,
    deps
  );
  if (!updated) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
  if (by === "persona") recordRunDecision(db, run, { stage: stage.id, kind: "not_applicable", reason: given, actor: input.actor });
  const message = transitionMessage(updated, stage.id, plan.to, "waived", reason, plan.skipped);
  checkpointFor(db, updated, input.sessionId, message, deps);
  return { ok: true, run: updated, from: stage.id, to: plan.to, outcome: "waived", skipped: plan.skipped, message };
}

/** Appends one of Persona's decisions about `run` to its owner's audit (pipeline_decisions). */
function recordRunDecision(
  db: Database,
  run: PipelineRun,
  input: { stage?: string; kind: PipelineDecision["kind"]; reason: string; actor: string; detail?: Record<string, unknown> }
): PipelineDecision {
  return recordPipelineDecision(db, {
    owner: run.owner,
    runId: run.id,
    jobId: personaJobForLaunch(db, run.launchId)?.job.id ?? null,
    projectId: run.projectId ?? null,
    stage: input.stage ?? null,
    kind: input.kind,
    reason: input.reason,
    actor: input.actor,
    detail: input.detail,
  });
}

/**
 * The blocking findings of a run held at its review stage for the owner on
 * wontfix findings (WONTFIX_REASON): the ones marked wontfix and any still
 * open, from the stage's last attempt of the current epoch. Null when the run
 * isn't held that way.
 */
export function wontfixHold(run: PipelineRun): { wontfix: PipelineWontfixFinding[]; open: PipelineWontfixFinding[] } | null {
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind !== "review") return null;
  if (run.status !== "waiting_user" || run.waitingKind !== "owner_input" || !isWontfixReason(run.waitingReason)) return null;
  const last = currentEpochAttempts(run)
    .filter((a) => a.stageId === stage.id)
    .at(-1);
  if (!last || last.status !== "failed") return null;
  const blocking = blockingReviewFindingsByReviewer(stage, last.evidence);
  if (blocking.length === 0) return null;
  const strip = ({ reviewer, severity, title, note }: PipelineWontfixFinding) => ({ reviewer, severity, title, ...(note ? { note } : {}) });
  return {
    wontfix: blocking.filter((f) => f.status === "wontfix").map(strip),
    open: blocking.filter((f) => f.status !== "wontfix").map(strip),
  };
}

/** "High" for a review stage that blocks on High only, else "High/Medium". */
function blockingLabel(stage: PipelineStageDef): string {
  return stage.blockOn === "high" ? "High" : "High/Medium";
}

/** Lowercased with runs of whitespace collapsed, for matching a finding's title inside a reason. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The titles `reason` doesn't name, each matched case- and
 * whitespace-insensitively as a whole phrase (not inside a longer word).
 * Longest first, each match blanked out before the next, so naming
 * "missing auth check" doesn't also count as naming "missing auth".
 */
function unnamedTitles(reason: string, titles: string[]): string[] {
  let said = normalizeForMatch(reason);
  const unnamed: string[] = [];
  const byPhrase = new Map(titles.map((t) => [normalizeForMatch(t), t]));
  const distinct = [...byPhrase.values()].sort((a, b) => normalizeForMatch(b).length - normalizeForMatch(a).length);
  for (const title of distinct) {
    const phrase = normalizeForMatch(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = phrase ? new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, "u").exec(said) : null;
    if (!match) {
      unnamed.push(title);
      continue;
    }
    const start = match.index + match[1]!.length;
    said = said.slice(0, start) + " ".repeat(match[0].length - match[1]!.length) + said.slice(start + match[0].length - match[1]!.length);
  }
  return titles.filter((t, i) => titles.indexOf(t) === i && unnamed.includes(t));
}

export interface AcceptWontfixInput {
  stage: string;
  /** Why each wontfix finding, named by title, is out of scope or tracked elsewhere (at least MIN_WONTFIX_ACCEPT_REASON characters). */
  reason: string;
  /** Who is recorded as waiving: the owner's Persona. */
  actor: string;
  sessionId?: string;
}

/**
 * Persona's waiver of a review held on wontfix findings, on a launch with a
 * real code change: allowed only while the run's current stage is a review
 * stage held for the owner because its last attempt blocked on findings that
 * are all marked wontfix (none left open), and with a reason of at least
 * MIN_WONTFIX_ACCEPT_REASON characters that names each of those findings by
 * title. A run whose budget ran out stays the
 * owner's. Recorded `waived` — never passed, never not applicable — with the
 * findings it covered, and moves along the stage's passed edge as an owner
 * waiver does.
 */
export async function acceptWontfixReview(
  db: Database,
  runId: string,
  input: AcceptWontfixInput,
  deps: PipelineDeps
): Promise<AdvanceResult> {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (run.status === "disabled" || run.status === "complete") {
    return { ok: false, status: 409, error: `The run is ${run.status}; there is nothing to waive` };
  }
  if (input.stage !== run.currentStage) {
    return { ok: false, status: 409, error: `"${input.stage}" is not the current stage — the run is at "${run.currentStage}"` };
  }
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind !== "review") {
    return {
      ok: false,
      status: 409,
      error: `The ${input.stage} stage isn't a review stage — only a review held on wontfix findings can have them accepted`,
    };
  }
  if (run.status === "waiting_user" && run.waitingKind === "exhausted") {
    return { ok: false, status: 409, error: `The run is waiting on its owner (${run.waitingReason ?? run.waitingKind}) — ${OWNER_NEEDED}` };
  }
  const hold = wontfixHold(run);
  if (!hold) {
    return { ok: false, status: 409, error: `The ${stage.id} stage isn't held for the owner on wontfix findings; there is nothing to accept` };
  }
  if (hold.open.length > 0) {
    const named = hold.open.map((f) => `[${f.severity}] ${f.title}`).join("; ");
    return { ok: false, status: 409, error: `The ${stage.id} stage still has open ${blockingLabel(stage)} findings (${named}) — fix them, or ${OWNER_NEEDED}` };
  }
  // A wontfix hold is taken before the budgets are checked, so a run whose
  // review → coding loop (or the next stage's attempt cap) is spent still
  // reads owner_input: recompute the failed edge to keep it the owner's.
  const facts = await factsForPlanning(run, getLaunch(db, run.launchId), run.facts, deps);
  const failedPlan = planTransition(run.definition, { currentStage: stage.id, attempts: currentEpochAttempts(run), facts }, "failed");
  const spent = failedPlan.kind === "exhausted" ? failedPlan.reason : attemptCapReason(run, failedPlan.to);
  if (spent !== null) {
    const loopSpent = failedPlan.kind === "exhausted" && !!failedPlan.reason.match(/loop did not converge/);
    const what = failedPlan.kind === "move" || loopSpent ? "budget ran out" : "failed path needs the owner";
    return { ok: false, status: 409, error: `The ${stage.id} stage's ${what} (${spent}) — ${OWNER_NEEDED}` };
  }
  const given = input.reason.trim();
  if (given.length > MAX_EVIDENCE_STRING) {
    return { ok: false, status: 422, error: `The waive reason is too long (at most ${MAX_EVIDENCE_STRING} characters)` };
  }
  if (given.length < MIN_WONTFIX_ACCEPT_REASON) {
    return {
      ok: false,
      status: 422,
      error: `Accepting wontfix findings needs a reason that covers each one (at least ${MIN_WONTFIX_ACCEPT_REASON} characters)`,
      missing: [`why (why each wontfix finding is out of scope or tracked elsewhere, at least ${MIN_WONTFIX_ACCEPT_REASON} characters)`],
    };
  }
  // Naming each finding ties the waiver to the findings Persona weighed: one
  // a re-advanced review added since goes unnamed and refuses it.
  const unnamed = unnamedTitles(given, hold.wontfix.map((f) => f.title));
  if (unnamed.length > 0) {
    return {
      ok: false,
      status: 422,
      error: `The reason must name each wontfix finding it accepts, by title; it doesn't name: ${unnamed.map((t) => `"${t}"`).join(", ")}`,
      missing: unnamed.map((t) => `why (name "${t}" and say why it is out of scope or where it is tracked)`),
    };
  }
  const findings = hold.wontfix;
  const plan = planTransition(run.definition, { currentStage: stage.id, attempts: currentEpochAttempts(run), facts }, "passed");
  if (plan.kind === "exhausted") return { ok: false, status: 409, error: plan.reason };
  const evidence: PipelineWaiverEvidence = {
    waiver: { by: "persona", actor: input.actor, reason: given, notApplicable: false, wontfixAccepted: { findings }, kind: "accept_wontfix" },
  };
  const covered = findings.map((f) => `[${f.severity}] ${f.title}`).join("; ");
  const reason = `waived by Persona (wontfix accepted) — ${input.actor}: ${given} (covers ${covered})`;
  const updated = await commitMove(
    db,
    run,
    stage,
    {
      status: "waived",
      evidence,
      reason,
      sessionId: input.sessionId,
      alongside: () => {
        recordRunDecision(db, run, { stage: stage.id, kind: "accept_wontfix", reason: given, actor: input.actor, detail: { findings } });
      },
    },
    plan.to,
    plan.skipped,
    facts,
    deps
  );
  if (!updated) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
  const message = transitionMessage(updated, stage.id, plan.to, "waived", reason, plan.skipped);
  checkpointFor(db, updated, input.sessionId, message, deps);
  return { ok: true, run: updated, from: stage.id, to: plan.to, outcome: "waived", skipped: plan.skipped, message };
}

// ----------------------------------------------------------------------------
// Persona's decisions on a blocked run.
// ----------------------------------------------------------------------------

/**
 * The pipeline `run`'s launch would get now — the owner's, the project's, the
 * job's and the launch's layers as they stand, not the definition the run
 * froze when it started. Persona's decisions are held to this.
 */
export function currentPipelineConfig(db: Database, run: PipelineRun): ResolvedPipelineFor {
  return resolvePipelineFor(db, run.owner, run.projectId, {
    jobId: personaJobForLaunch(db, run.launchId)?.job.id,
    launchOverride: run.launchOverride,
    checkout: getLaunch(db, run.launchId)?.worktreePath,
  });
}

/**
 * Whether `run` must still cut a code review: the project's current pipeline
 * (`config`, currentPipelineConfig by default) has a code_review stage and
 * it applies to the launch (codeReviewNotApplicable gives no reason).
 */
export function runRequiresCodeReview(db: Database, run: PipelineRun, config: ResolvedPipelineFor = currentPipelineConfig(db, run)): boolean {
  return (
    config.definition.stages.some((s) => s.kind === CODE_REVIEW_STAGE_KIND) &&
    codeReviewNotApplicable(db, run, getLaunch(db, run.launchId)) === null
  );
}

/**
 * Why Persona may never skip, waive or close out `stage` of `run`, or null:
 * the human review is the owner's own decision, and a stage protected
 * (PipelinePreset.protectedStages) by the project's own preset or by the
 * preset its layers resolve to is the owner's while the project's current
 * pipeline still has it — a code_review stage only while it applies (runRequiresCodeReview).
 */
function protectedStageReason(db: Database, run: PipelineRun, stage: PipelineStageDef, config: ResolvedPipelineFor): string | null {
  if (stage.kind === HUMAN_REVIEW_STAGE_KIND) return `${stage.id} is the owner's decision on the review packet, in the Review tab`;
  const by = [config.autoPreset, config.preset].find((p) => PIPELINE_PRESETS[p].protectedStages.includes(stage.id));
  if (!by) return null;
  if (!config.definition.stages.some((s) => s.id === stage.id)) return null;
  if (stage.kind === CODE_REVIEW_STAGE_KIND && !runRequiresCodeReview(db, run, config)) return null;
  return `${stage.id} is protected in the project's ${by} pipeline`;
}

/** The launch's changed files — git's against its base (launchChangedFiles) unioned with the run's reported ones — or null when git can't read them. */
async function decisionChangedFiles(db: Database, run: PipelineRun, deps: PipelineDeps): Promise<string[] | null> {
  const launch = getLaunch(db, run.launchId);
  if (!launch?.worktreePath) return null;
  let files: string[];
  try {
    files = await launchChangedFiles(launch, deps.changedFiles);
  } catch {
    return null;
  }
  return [...new Set([...files, ...reportedChangedFiles(run)])];
}

const named = (files: string[]) => files.slice(0, 5).join(", ") + (files.length > 5 ? ", …" : "");

/**
 * Why `stage` (`verb`: skipped, waived, closed out) may not be passed over
 * without its evidence on a full run — the project's own preset or the one
 * its layers resolve to is `full`, so a layer relabelling the preset doesn't
 * lift it — because of what the change touches, or null: a deploy stage only
 * when every changed file is docs, tests or configuration
 * (nonDeployableOnly), a screenshot stage only when no changed file is UI
 * (the ui_changed fact). Fails closed when git can't read the change.
 */
async function changeRefusal(
  db: Database,
  run: PipelineRun,
  stage: PipelineStageDef,
  config: ResolvedPipelineFor,
  verb: string,
  deps: PipelineDeps
): Promise<string | null> {
  if (config.preset !== "full" && config.autoPreset !== "full") return null;
  if (stage.kind !== "deploy" && stage.kind !== "screenshot") return null;
  const files = await decisionChangedFiles(db, run, deps);
  if (files === null) return `Standup can't read this launch's changed files to confirm the ${stage.id} stage doesn't apply`;
  const launch = getLaunch(db, run.launchId);
  const paths = launch ? pathsToMatch(launch) : (f: string) => [f];
  if (stage.kind === "deploy") {
    const deployable = files.filter((f) => !nonDeployableOnly(paths(f)));
    return deployable.length > 0 ? `the change touches deployable code (${named(deployable)}), so its ${stage.id} stage can't be ${verb}` : null;
  }
  // The defaults always count as UI here, so paths a layer narrowed can't hide a UI change from this check.
  const ui = [...new Set([...DEFAULT_UI_PATHS, ...(stage.uiPaths ?? definitionUiPaths(run.definition) ?? [])])];
  const uiFiles = files.filter((f) => computeFacts(paths(f), ui).ui_changed);
  return uiFiles.length > 0 ? `the change touches UI (${named(uiFiles)}), so its ${stage.id} stage can't be ${verb}` : null;
}

export type PersonaDecisionKind = "skip" | "waive" | "close_out" | "escalate";

export const PERSONA_DECISION_KINDS: readonly PersonaDecisionKind[] = ["skip", "waive", "close_out", "escalate"];

export interface PersonaDecisionInput {
  stage: string;
  kind: PersonaDecisionKind;
  reason: string;
  /** Who is recorded as deciding: "<owner>'s Persona". */
  actor: string;
  sessionId?: string;
}

export type PersonaDecisionResult =
  | {
      ok: true;
      run: PipelineRun;
      kind: PersonaDecisionKind;
      from: string;
      to: string;
      /** The stages a close-out waived, in order. */
      closedOut?: string[];
      skipped: Array<{ stageId: string; reason: string }>;
      message: string;
      decision: PipelineDecision;
    }
  | { ok: false; status: 404 | 409 | 422; error: string; missing?: string[] };

const ESCALATE_HINT = "escalate it to the owner";

/**
 * Persona's decision on `runId`'s blocked (or active) run, recorded in the
 * owner's audit (pipeline_decisions) and on the attempts it writes as `by:
 * persona`:
 *  - `skip` — the current stage doesn't apply to this change: recorded
 *    `skipped` with the decision as evidence, and the run follows the passed
 *    edge as a worker's skip does (budgets still count, and an overrun
 *    hands the run back). Refused for a protected stage
 *    (protectedStageReason); for validation or review once the launch has a
 *    code change (or git can't tell) — those are reported, waived with a
 *    reason, or escalated; and on a full run for a deploy or screenshot
 *    stage the change touches (changeRefusal).
 *  - `waive` — the current stage stands waived on Persona's judgment, even
 *    exhausted or stalled, as an owner's waiver does (never not applicable).
 *    Refused for a protected stage and as for skip on a full run's deploy and
 *    screenshot stages.
 *  - `close_out` — the stages the run has left that the project's current
 *    pipeline (currentPipelineConfig) no longer has, or a code_review stage that
 *    doesn't apply, are waived as not applicable from the current stage on,
 *    up to the first one that still applies, which the run enters normally
 *    (or complete). Refused when the current stage itself still applies,
 *    and as for skip on a full run's deploy and screenshot stages.
 *  - `escalate` — the run's Persona job waits on the owner with the reason;
 *    the only way a pipeline block sets a job waiting_user.
 * Skip and escalate need a reason of at least MIN_WAIVE_REASON characters;
 * waive and close_out at least MIN_PERSONA_WAIVE_REASON. `stage` must be the
 * current stage.
 */
export async function decidePipelineStage(
  db: Database,
  runId: string,
  input: PersonaDecisionInput,
  deps: PipelineDeps
): Promise<PersonaDecisionResult> {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (!PERSONA_DECISION_KINDS.includes(input.kind)) {
    return { ok: false, status: 422, error: `kind must be one of ${PERSONA_DECISION_KINDS.join(", ")}` };
  }
  if (run.status === "disabled" || run.status === "complete") {
    return { ok: false, status: 409, error: `The run is ${run.status}; there is nothing to decide` };
  }
  if (input.stage !== run.currentStage) {
    return { ok: false, status: 409, error: `"${input.stage}" is not the current stage — the run is at "${run.currentStage}"` };
  }
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind === "complete") return { ok: false, status: 409, error: "There is no stage to decide on" };
  const reason = input.reason.trim();
  const min = input.kind === "waive" || input.kind === "close_out" ? MIN_PERSONA_WAIVE_REASON : MIN_WAIVE_REASON;
  if (reason.length > MAX_EVIDENCE_STRING) {
    return { ok: false, status: 422, error: `The reason is too long (at most ${MAX_EVIDENCE_STRING} characters)` };
  }
  if (reason.length < min) {
    return {
      ok: false,
      status: 422,
      error: `A ${input.kind.replace("_", " ")} needs a reason of at least ${min} characters`,
      missing: [`reason (at least ${min} characters)`],
    };
  }
  switch (input.kind) {
    case "escalate":
      return escalateRun(db, run, stage, reason, input.actor, deps);
    case "close_out":
      return closeOutRun(db, run, reason, input, deps);
    default:
      return skipOrWaive(db, run, stage, reason, input, deps);
  }
}

/** decidePipelineStage's `skip` and `waive`. */
async function skipOrWaive(
  db: Database,
  run: PipelineRun,
  stage: PipelineStageDef,
  reason: string,
  input: PersonaDecisionInput,
  deps: PipelineDeps
): Promise<PersonaDecisionResult> {
  const kind = input.kind;
  const verb = kind === "skip" ? "skipped" : "waived";
  if (stage.kind === "start") return { ok: false, status: 409, error: "The start stage can't be skipped or waived — advance it" };
  const config = currentPipelineConfig(db, run);
  const guarded = protectedStageReason(db, run, stage, config);
  if (guarded) return { ok: false, status: 409, error: `The ${stage.id} stage can't be ${verb} by Persona: ${guarded} — ${ESCALATE_HINT}.` };
  if (kind === "skip" && (stage.kind === "validation" || stage.kind === "review")) {
    const files = await decisionChangedFiles(db, run, deps);
    if (files === null || files.length > 0) {
      const why = files === null ? "Standup can't read this launch's changed files" : `this launch changes ${plural(files.length, "file")} (${named(files)})`;
      return {
        ok: false,
        status: 409,
        error: `The ${stage.id} stage of a code change can't be skipped (${why}) — report evidence, waive it with a reason, or escalate.`,
      };
    }
  }
  const refusal = await changeRefusal(db, run, stage, config, verb, deps);
  if (refusal) return { ok: false, status: 409, error: `${refusal} — report its evidence, or ${ESCALATE_HINT}.` };

  if (kind === "skip") {
    const evidence = { decision: { by: "persona" as const, actor: input.actor, kind: "skip" as const, reason } };
    const audit: { decision?: PipelineDecision } = {};
    const result = await commitSkip(
      db,
      run,
      stage,
      {
        status: "skipped",
        evidence,
        reason: `skipped by ${input.actor}: ${reason}`,
        sessionId: input.sessionId,
        alongside: (to) => {
          audit.decision = recordRunDecision(db, run, { stage: stage.id, kind: "skip", reason, actor: input.actor, detail: { to } });
        },
      },
      deps
    );
    if (!result) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
    if (!result.ok) return result;
    const decision = audit.decision;
    if (!decision) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
    return { ok: true, run: result.run, kind, from: result.from, to: result.to, skipped: result.skipped, message: result.message, decision };
  }

  const facts = await factsForPlanning(run, getLaunch(db, run.launchId), run.facts, deps);
  const plan = planTransition(run.definition, { currentStage: stage.id, attempts: currentEpochAttempts(run), facts }, "passed");
  if (plan.kind === "exhausted") return { ok: false, status: 409, error: plan.reason };
  const blocked = entryBlock(db, run, plan.to);
  if (blocked) {
    const refused = entryRefusal(db, run, plan.to, blocked, deps);
    return refused.ok ? { ok: false, status: 409, error: blocked } : refused;
  }
  const evidence: PipelineWaiverEvidence = {
    waiver: { by: "persona", actor: input.actor, reason, notApplicable: false, kind: "waive" },
  };
  const why = `waived by Persona — ${input.actor}: ${reason}`;
  const audit: { decision?: PipelineDecision } = {};
  const updated = await commitMove(
    db,
    run,
    stage,
    {
      status: "waived",
      evidence,
      reason: why,
      sessionId: input.sessionId,
      alongside: () => {
        audit.decision = recordRunDecision(db, run, { stage: stage.id, kind: "waive", reason, actor: input.actor, detail: { to: plan.to } });
      },
    },
    plan.to,
    plan.skipped,
    facts,
    deps
  );
  const decision = audit.decision;
  if (!updated || !decision) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
  const { to, message } = landing(updated, stage.id, plan.to, "waived", why, plan.skipped);
  checkpointFor(db, updated, input.sessionId, message, deps);
  return { ok: true, run: updated, kind, from: stage.id, to, skipped: plan.skipped, message, decision };
}

/** The stage a stage's unconditional passed edge leads to, if it has one. */
function passedEdgeTarget(stage: PipelineStageDef): string | undefined {
  return stage.edges.find((e) => !e.when || (e.when.outcome === "passed" && !e.when.fact))?.to;
}

/** decidePipelineStage's `close_out`. */
async function closeOutRun(
  db: Database,
  run: PipelineRun,
  reason: string,
  input: PersonaDecisionInput,
  deps: PipelineDeps
): Promise<PersonaDecisionResult> {
  const config = currentPipelineConfig(db, run);
  const inConfig = new Set(config.definition.stages.map((s) => s.id));
  const launch = getLaunch(db, run.launchId);
  const notInPipeline = (s: PipelineStageDef): string | null => {
    if (s.kind === "start" || s.kind === HUMAN_REVIEW_STAGE_KIND) return null;
    if (!inConfig.has(s.id)) return `not in the project's ${config.preset} pipeline`;
    if (s.kind === CODE_REVIEW_STAGE_KIND) return codeReviewNotApplicable(db, run, launch);
    return null;
  };
  // The stages left, along the frozen definition's passed edges.
  const walk: PipelineStageDef[] = [];
  const seen = new Set<string>();
  let at = stageOf(run, run.currentStage);
  while (at && at.kind !== "complete" && !seen.has(at.id)) {
    seen.add(at.id);
    walk.push(at);
    const next = passedEdgeTarget(at);
    at = next ? stageOf(run, next) : undefined;
  }
  const closing: Array<{ stage: PipelineStageDef; why: string }> = [];
  for (const s of walk) {
    const why = notInPipeline(s);
    if (!why) break;
    closing.push({ stage: s, why });
  }
  if (closing.length === 0) {
    const still = walk.filter((s) => !notInPipeline(s) && s.kind !== "start").map((s) => s.id);
    const current = stageOf(run, run.currentStage);
    const guarded = current ? protectedStageReason(db, run, current, config) : null;
    return {
      ok: false,
      status: 409,
      error:
        `The ${run.currentStage} stage still applies to this run${guarded ? ` (${guarded})` : ""} — ${still.join(", ") || run.currentStage} ` +
        `${still.length === 1 ? "is" : "are"} in the project's ${config.preset} pipeline: report their evidence, or waive them one by one ` +
        `with a reason — or ${ESCALATE_HINT}.`,
    };
  }
  // Validation and review close out only on a run with no code change: a
  // change's tests and review are reported, waived with a reason, or the owner's.
  const checked = closing.filter((c) => c.stage.kind === "validation" || c.stage.kind === "review").map((c) => c.stage.id);
  if (checked.length > 0) {
    const files = await decisionChangedFiles(db, run, deps);
    if (files === null || files.length > 0) {
      const why = files === null ? "Standup can't read this launch's changed files" : `this launch changes ${plural(files.length, "file")} (${named(files)})`;
      return {
        ok: false,
        status: 409,
        error: `${checked.join(" and ")} of a code change can't be closed out (${why}) — report evidence, waive with a reason, or ${ESCALATE_HINT}.`,
      };
    }
  }
  // A full run's deploy and screenshot close out only as they skip: not over deployable code or a UI change.
  for (const c of closing) {
    const refusal = await changeRefusal(db, run, c.stage, config, "closed out", deps);
    if (refusal) return { ok: false, status: 409, error: `${refusal} — report its evidence, or ${ESCALATE_HINT}.` };
  }
  const complete = run.definition.stages.find((s) => s.kind === "complete");
  const target = walk[closing.length] ?? at ?? complete;
  if (!target) return { ok: false, status: 409, error: "The run's definition has no complete stage" };
  if (target.kind !== "complete") {
    const blocked = entryBlock(db, run, target.id);
    if (blocked) {
      const refused = entryRefusal(db, run, target.id, blocked, deps);
      return refused.ok ? { ok: false, status: 409, error: blocked } : refused;
    }
  }
  const closedOut = closing.map((c) => c.stage.id);
  const tx = db.transaction(() => {
    const flag = storedFlag(db, run.id);
    const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
      currentStage: target.id,
      status: target.kind === "complete" ? "complete" : "active",
      waitingReason: null,
      waitingKind: null,
      flaggedJob: null,
      reviewHandoffAt: null,
      stopBlocks: 0,
      stageEnteredAt: new Date().toISOString(),
    });
    if (!moved) throw new StaleRun();
    closing.forEach(({ stage, why }, i) => {
      const evidence: PipelineWaiverEvidence = {
        waiver: { by: "persona", actor: input.actor, reason: `${reason} — ${why}`, notApplicable: true, kind: "close_out" },
      };
      recordPipelineAttempt(db, run.id, {
        stageId: stage.id,
        status: "waived",
        evidence,
        reason: `closed out by ${input.actor}: ${why}`,
        sessionId: input.sessionId,
        nextStage: closing[i + 1]?.stage.id ?? target.id,
        epoch: run.epoch ?? 0,
      });
    });
    const decision = recordRunDecision(db, run, {
      stage: run.currentStage,
      kind: "close_out",
      reason,
      actor: input.actor,
      detail: { closedOut, now: target.id, preset: config.preset },
    });
    const restored = restoreFlaggedJob(db, run, flag, target.title);
    return { run: getPipelineRun(db, run.id)!, restored, decision };
  });
  let out: { run: PipelineRun; restored: ReturnType<typeof restoreFlaggedJob>; decision: PipelineDecision };
  try {
    out = tx();
  } catch (e) {
    if (e instanceof StaleRun) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
    throw e;
  }
  publishRun(out.run, deps);
  publishRestored(out.restored, deps);
  if (target.kind !== "complete") await enterStage(db, out.run, target, deps);
  const updated = getPipelineRun(db, run.id) ?? out.run;
  const decision = out.decision;
  const message =
    `Pipeline: ${closedOut.join(", ")} closed out by ${input.actor} (${closedOut.length === 1 ? "it isn't" : "they aren't"} in the project's ` +
    `${config.preset} pipeline any more, or no code review applies) → ${updated.currentStage}.` +
    (updated.status === "complete" ? " The delivery pipeline is complete." : "");
  checkpointFor(db, updated, input.sessionId, message, deps);
  return { ok: true, run: updated, kind: "close_out", from: run.currentStage, to: updated.currentStage, closedOut, skipped: [], message, decision };
}

/** decidePipelineStage's `escalate`: the run's Persona job waits on the owner. */
function escalateRun(
  db: Database,
  run: PipelineRun,
  stage: PipelineStageDef,
  reason: string,
  actor: string,
  notify: PipelineNotify
): PersonaDecisionResult {
  const owned = personaJobForLaunch(db, run.launchId);
  if (!owned || owned.job.owner !== run.owner) {
    return { ok: false, status: 409, error: "The run's launch has no Persona job to escalate; it waits for the owner in the console" };
  }
  if (owned.job.status !== "active" && owned.job.status !== "waiting_user") {
    return { ok: false, status: 409, error: `The run's Persona job is ${owned.job.status}; there is nothing to escalate` };
  }
  const note = `${ESCALATED_NOTE}${reason}`;
  let out: { job: PersonaJob | null; decision: PipelineDecision };
  try {
    out = db.transaction(() => {
      // Only the run as it was read is escalated: one that moved since is the stage Persona didn't decide on.
      const moved = updatePipelineRunIf(db, run.id, expectedOf(run), { flaggedJob: { id: owned.job.id, note } });
      if (!moved) throw new StaleRun();
      // The run moving on (any move) makes the job active again, as a block's note did.
      const job = updatePersonaJob(db, owned.job.id, { status: "waiting_user", note });
      if (!job) throw new StaleRun();
      const decision = recordRunDecision(db, run, { stage: stage.id, kind: "escalate", reason, actor });
      return { job, decision };
    })();
  } catch (e) {
    if (e instanceof StaleRun) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
    throw e;
  }
  publishJob(out.job, notify);
  const updated = getPipelineRun(db, run.id) ?? run;
  publishRun(updated, notify);
  const decision = out.decision;
  return {
    ok: true,
    run: updated,
    kind: "escalate",
    from: stage.id,
    to: stage.id,
    skipped: [],
    message: `Pipeline: ${stage.id} escalated to the owner by ${actor}: ${reason}`,
    decision,
  };
}

// ----------------------------------------------------------------------------
// Pipeline layers set through Persona, and the routes' views of a layer.
// ----------------------------------------------------------------------------

export type PipelineLayerScope = "user" | "project" | "job" | "launch";

export const PIPELINE_LAYER_SCOPES: readonly PipelineLayerScope[] = ["user", "project", "job", "launch"];

export interface PipelineLayerInput {
  scope: PipelineLayerScope;
  projectId?: string;
  jobId?: string;
  /** For `launch`: a session of the launch whose run takes the layer. */
  sessionId?: string;
  spec?: unknown;
  override?: unknown;
  reason: string;
  /** "<owner>'s Persona". */
  actor: string;
  /**
   * The owner approved this exact change on its approval card, so a change
   * that weakens the pipeline (pipelineLayerWeakens) is set anyway. Only
   * Persona's runtime sets it, for a card's execution (see the
   * /api/pipeline/config route).
   */
  ownerApproved?: boolean;
  /**
   * The weakenings the owner's card showed (pinned when the card was raised).
   * An approved change is set only while every weakening it makes now is one
   * of them; anything more is refused for Persona to ask again.
   */
  approvedWeakens?: string[];
}

/** The refusal of an approved pipeline change whose weakenings outgrew the card the owner approved. */
export function staleApprovalError(unapproved: string[]): string {
  return `The pipeline changed since the owner approved this (${unapproved.join("; ")} wasn't on the card) — Persona must ask again`;
}

/** The weakenings in `weakens` the owner's card didn't show (`approved`, the card's pinned list). */
export function unapprovedWeakens(weakens: string[], approved: readonly string[] | undefined): string[] {
  return weakens.filter((w) => !(approved ?? []).includes(w));
}

export type PipelineLayerResult =
  | {
      ok: true;
      scope: PipelineLayerScope;
      override: PipelineOverride;
      compiled?: CompiledPipelineSpec;
      preset: PipelinePresetId;
      stages: Array<{ id: string; title: string; required: boolean }>;
      /** For `launch`: the run whose definition was replaced. */
      run?: PipelineRun;
      decision: PipelineDecision;
    }
  | {
      ok: false;
      status: 400 | 404 | 409 | 422;
      error: string;
      unknown?: string[];
      errors?: string[];
      /** How the change weakens the pipeline, when that is why it was refused. */
      weakens?: string[];
      /** The owner's projects whose layers would no longer merge, when that is why it was refused. */
      projects?: string[];
    };

/**
 * Resolves `layers` over the project's own preset (read first from
 * `checkout`, the launch's worktree), strictly (no fallback): the resolved
 * pipeline, or the 400 refusal naming why the layers don't merge.
 */
export function checkPipelineLayers(
  db: Database,
  projectId: string | null | undefined,
  layers: Array<PipelineOverride | null | undefined>,
  checkout?: string | null
): { ok: true; resolved: ReturnType<typeof resolvePipelineLayers> } | { ok: false; status: 400; error: string; errors: string[] } {
  try {
    return { ok: true, resolved: resolvePipelineLayers(layers, autoPipelinePreset(db, projectId, { checkout })) };
  } catch (e) {
    if (e instanceof PipelineConfigError) return { ok: false, status: 400, error: e.message, errors: e.errors };
    throw e;
  }
}

type PipelineLayers = Array<PipelineOverride | null | undefined>;

/**
 * How changing `before` to `after` (layers lowest first, as
 * resolvePipelineLayers takes them) weakens `projectId`'s pipeline, in words
 * a person reads (definitionWeakens over both resolved pipelines); empty when
 * it doesn't, or when `after` doesn't merge (the caller refuses that with
 * why). The guarded stages are those every project keeps, plus code_review, deploy
 * and screenshot where the project's own preset (autoPipelinePreset, read
 * first from `checkout`) is full — whatever preset the layers name — and
 * there, layers newly resolving to another preset weaken it too. A layer
 * that reaches every project (`everyProject`, the owner's own) is held to the
 * full set; one for no known project yet (a job before its first launch)
 * only to the stages every project keeps.
 */
export function pipelineLayerWeakens(
  db: Database,
  input: {
    owner: string;
    projectId: string | null | undefined;
    checkout?: string | null;
    everyProject?: boolean;
    before: PipelineLayers;
    after: PipelineLayers;
  }
): string[] {
  const known = !!input.projectId && !!getProject(db, input.projectId);
  const autoPreset: PipelinePresetId | null = known
    ? autoPipelinePreset(db, input.projectId, { checkout: input.checkout })
    : input.everyProject
      ? "full"
      : null;
  const base = autoPreset ?? "full";
  const resolve = (layers: PipelineLayers) => {
    try {
      return resolvePipelineLayers(layers, base);
    } catch (e) {
      if (e instanceof PipelineConfigError) return null;
      throw e;
    }
  };
  const after = resolve(input.after);
  if (!after) return [];
  const before = resolve(input.before) ?? resolvePipelineLayers([], base);
  const reasons = definitionWeakens(before, after, guardedStageKinds(autoPreset));
  // A full project's pipeline relabelled to another preset sheds what full
  // keeps (its protected stages, the deploy and screenshot rules), whatever
  // stages the layers leave in place.
  if (autoPreset === "full" && after.preset !== "full" && after.preset !== before.preset) {
    reasons.unshift(`the full project's pipeline is relabelled ${after.preset}`);
  }
  return reasons;
}

/**
 * The owner's projects whose own layer would no longer merge over `global`
 * as the owner's layer, by id.
 */
export function projectsBrokenByGlobal(db: Database, owner: string, global: PipelineOverride): string[] {
  return listPipelineConfigs(db, owner)
    .filter((c): c is typeof c & { projectId: string } => c.projectId !== null)
    .filter((c) => !checkPipelineLayers(db, c.projectId, [global, projectSeedLayer(db, c.projectId), c.override]).ok)
    .map((c) => c.projectId);
}

/**
 * The owner's layers for `projectId`, lowest first, as resolvePipelineFor
 * stacks them beneath a job's and a launch's: the owner's global layer, the
 * project's built-in seed (projectSeedLayer) and the owner's project layer.
 */
export function ownerProjectLayers(db: Database, owner: string, projectId: string | null): PipelineLayers {
  return [getPipelineConfig(db, owner, null), projectSeedLayer(db, projectId), projectId ? getPipelineConfig(db, owner, projectId) : null];
}

/** Tells the owner's open settings views one of their pipeline layers changed. */
export function publishPipelineConfig(notify: PipelineNotify, payload: PipelineConfigUpdatedPayload): void {
  notify.broadcast({ type: "pipeline_config:updated", payload, timestamp: new Date().toISOString(), audience: payload.owner });
}

/**
 * The weakenings of the owner's job layer the owner approved: the list its
 * last recorded change pinned when it was set on the owner's approval card
 * (ownerApproved, `approvedWeakens`) — while the job's layer is still exactly
 * that change, and only for `projectIds` that are all among the projects the
 * card judged it against (its `projects`): approval over one project's
 * pipeline says nothing about another's.
 */
function approvedJobWeakens(db: Database, owner: string, job: PersonaJob, projectIds: Array<string | null>): string[] {
  const last = listPipelineDecisions(db, owner, { jobId: job.id })
    .filter((d) => d.kind === "config" && d.detail?.scope === "job")
    .at(-1);
  const detail = last?.detail;
  if (!detail || detail.ownerApproved !== true) return [];
  if (canonicalJson(detail.override ?? null) !== canonicalJson(job.pipelineOverride ?? null)) return [];
  const judged = Array.isArray(detail.projects) ? (detail.projects as unknown[]) : [];
  if (!projectIds.every((id) => judged.includes(id))) return [];
  const approved = detail.approvedWeakens;
  return Array.isArray(approved) ? approved.filter((w): w is string => typeof w === "string") : [];
}

/**
 * How a launch into `projectId` weakens the project's pipeline through the
 * job's layer (`jobId`, the owner's job) and the launch's own
 * (`launchLayer`): over the owner's own and project layers, less what the
 * owner approved for the job's layer over this project (approvedJobWeakens).
 * A job layer approved against other projects, or before the job had one, is
 * held to the project the launch goes to with nothing approved.
 */
export function launchLayerWeakens(
  db: Database,
  owner: string,
  input: { projectId: string | null | undefined; jobId?: string | null; launchLayer?: PipelineOverride | null; checkout?: string | null }
): string[] {
  const job = input.jobId ? getPersonaJob(db, input.jobId, { withView: false }) : null;
  const jobLayer = job && job.owner === owner ? (job.pipelineOverride ?? null) : null;
  const launchLayer = input.launchLayer ?? null;
  if (!jobLayer && !launchLayer) return [];
  const beneath = ownerProjectLayers(db, owner, input.projectId ?? null);
  const reasons = pipelineLayerWeakens(db, {
    owner,
    projectId: input.projectId,
    checkout: input.checkout,
    before: beneath,
    after: [...beneath, jobLayer, launchLayer],
  });
  const approved = job && jobLayer ? approvedJobWeakens(db, owner, job, [input.projectId ?? null]) : [];
  return reasons.filter((r) => !approved.includes(r));
}

type LayerTarget =
  | {
      ok: true;
      projectId: string | null;
      /** The project a spec's "for <project>:" must name: null for the owner's own layer, undefined when not known yet. */
      specTarget: { id: string; name?: string | null } | null | undefined;
      checkout?: string | null;
      /** The layers beneath the one being set, lowest first. */
      beneath: PipelineLayers;
      /** The layer being replaced. */
      current: PipelineOverride | null;
      /**
       * Every project the layer lands on, with the layers beneath it there:
       * for a job, each project among its launches (or none known yet);
       * otherwise just `projectId` over `beneath`.
       */
      reach: Array<{ projectId: string | null; checkout?: string | null; beneath: PipelineLayers }>;
      job?: PersonaJob;
      run?: PipelineRun;
    }
  | { ok: false; status: 404 | 409; error: string };

/** Where one of Persona's layer changes lands (see setPipelineLayerByPersona), or why it can't. */
function personaLayerTarget(
  db: Database,
  owner: string,
  input: { scope: PipelineLayerScope; projectId?: string; jobId?: string; sessionId?: string },
  runForSession: (sessionId: string) => PipelineRun | null
): LayerTarget {
  const global = getPipelineConfig(db, owner, null);
  if (input.scope === "user") return { ok: true, projectId: null, specTarget: null, beneath: [], current: global, reach: [{ projectId: null, beneath: [] }] };
  if (input.scope === "project") {
    const projectId = input.projectId?.trim();
    const project = projectId ? getProject(db, projectId) : null;
    if (!projectId || !project) return { ok: false, status: 404, error: `Unknown project: ${projectId ?? "(none given)"}` };
    return {
      ok: true,
      projectId,
      specTarget: project,
      beneath: [global, projectSeedLayer(db, projectId)],
      current: getPipelineConfig(db, owner, projectId),
      reach: [{ projectId, beneath: [global, projectSeedLayer(db, projectId)] }],
    };
  }
  const beneathFor = (projectId: string | null): PipelineLayers => ownerProjectLayers(db, owner, projectId);
  if (input.scope === "job") {
    const job = input.jobId ? getPersonaJob(db, input.jobId.trim(), { withView: false }) : null;
    // Another owner's job reads as none.
    if (!job || job.owner !== owner) return { ok: false, status: 404, error: "Unknown job" };
    const launchProjects = job.launchIds.map((id) => getLaunch(db, id)?.projectId ?? null);
    const projectId = launchProjects.at(-1) ?? null;
    const project = projectId ? getProject(db, projectId) : null;
    const reached = [...new Set(launchProjects.length > 0 ? launchProjects : [null])];
    return {
      ok: true,
      projectId,
      specTarget: project ?? undefined,
      beneath: beneathFor(projectId),
      current: job.pipelineOverride ?? null,
      reach: reached.map((id) => ({ projectId: id, beneath: beneathFor(id) })),
      job,
    };
  }
  const sessionId = input.sessionId?.trim();
  const run = sessionId ? runForSession(sessionId) : null;
  // Another owner's run reads as none.
  if (!run || run.owner !== owner) return { ok: false, status: 404, error: "That session's launch has no delivery pipeline run" };
  const jobId = personaJobForLaunch(db, run.launchId)?.job.id ?? null;
  const job = jobId ? getPersonaJob(db, jobId, { withView: false }) : null;
  const project = run.projectId ? getProject(db, run.projectId) : null;
  const checkout = getLaunch(db, run.launchId)?.worktreePath;
  const beneath = [...beneathFor(run.projectId ?? null), job && job.owner === owner ? (job.pipelineOverride ?? null) : null];
  return {
    ok: true,
    projectId: run.projectId ?? null,
    specTarget: project ?? undefined,
    checkout,
    beneath,
    current: run.launchOverride ?? null,
    reach: [{ projectId: run.projectId ?? null, checkout, beneath }],
    ...(job ? { job } : {}),
    run,
  };
}

/**
 * How one of Persona's layer changes (see setPipelineLayerByPersona) would
 * weaken the pipeline it lands on: the scope's pipeline as it resolves now
 * against the one with `override` in place of the layer it replaces
 * (pipelineLayerWeakens). Empty when the target is unknown or the layer
 * doesn't merge — setting it is refused then, with why.
 */
export function personaLayerWeakens(
  db: Database,
  owner: string,
  input: { scope: PipelineLayerScope; projectId?: string; jobId?: string; sessionId?: string },
  override: PipelineOverride,
  runForSession: (sessionId: string) => PipelineRun | null = (id) => pipelineRunForSession(db, id)
): string[] {
  if (!PIPELINE_LAYER_SCOPES.includes(input.scope)) return [];
  const target = personaLayerTarget(db, owner, input, runForSession);
  if (!target.ok) return [];
  return targetWeakens(db, owner, input.scope, target, override, "current");
}

/**
 * How `override` weakens the pipeline of every project `target` reaches
 * (pipelineLayerWeakens), together: against the layer it replaces
 * (`against` current), or against none at all (`beneath`, what a launch
 * later holds a job's layer to).
 */
function targetWeakens(
  db: Database,
  owner: string,
  scope: PipelineLayerScope,
  target: Extract<LayerTarget, { ok: true }>,
  override: PipelineOverride,
  against: "current" | "beneath"
): string[] {
  const reasons = new Set<string>();
  for (const at of target.reach) {
    const weakens = pipelineLayerWeakens(db, {
      owner,
      projectId: at.projectId,
      checkout: at.checkout,
      everyProject: scope === "user",
      before: against === "current" ? [...at.beneath, target.current] : at.beneath,
      after: [...at.beneath, override],
    });
    for (const w of weakens) reasons.add(w);
  }
  return [...reasons];
}

/**
 * Whether the run has got past coding — its current stage, or a stage it
 * recorded an attempt at or moved onto, is neither start nor coding — so its
 * frozen pipeline may no longer be reshaped by a launch layer.
 */
function runPastCoding(run: PipelineRun): boolean {
  const kindOf = (id: string) => stageOf(run, id)?.kind;
  const early = (id: string) => kindOf(id) === "start" || kindOf(id) === "coding";
  return !early(run.currentStage) || run.attempts.some((a) => !early(a.stageId) || (a.nextStage !== undefined && !early(a.nextStage)));
}

/**
 * Persona sets one of its owner's pipeline layers from a plain-words `spec`
 * and/or a structured `override` (pipelineLayerFromInput), recorded in the
 * owner's audit with `reason` (at least MIN_WAIVE_REASON characters):
 *  - `user` / `project` — the owner's global or project layer;
 *  - `job` — the job's own layer, for the owner's job `jobId` (404 for any
 *    other), which the job's later launches resolve;
 *  - `launch` — the launch layer of the run of `sessionId`'s launch: only
 *    while the run is still at start or coding with nothing past coding run,
 *    and its frozen definition is replaced with the re-resolved one (its
 *    project's preset read from the launch's own checkout); otherwise 409.
 * The layer must merge with the ones beneath it (400 with why) — the owner's
 * own layer also under each of their project layers (400 naming the
 * projects) — and a spec naming a project ("for <project>:") must name the
 * one it lands on (specProjectRefusal, 400). A change that weakens the
 * pipeline it lands on (personaLayerWeakens) — for a job, the pipeline of
 * any project among its launches — is refused (409 with
 * `weakens`) unless the owner approved it (`ownerApproved`). Each change is
 * pushed to the owner's open settings views (pipeline_config:updated).
 * Returns the stored layer, what a spec compiled to, and the preset and
 * stages the scope's pipeline now resolves to.
 */
export function setPipelineLayerByPersona(
  db: Database,
  owner: string,
  input: PipelineLayerInput,
  notify: PipelineNotify,
  runForSession: (sessionId: string) => PipelineRun | null = (id) => pipelineRunForSession(db, id)
): PipelineLayerResult {
  if (!PIPELINE_LAYER_SCOPES.includes(input.scope)) {
    return { ok: false, status: 400, error: `scope must be one of ${PIPELINE_LAYER_SCOPES.join(", ")}` };
  }
  const reason = input.reason.trim();
  if (reason.length < MIN_WAIVE_REASON || reason.length > MAX_EVIDENCE_STRING) {
    return { ok: false, status: 422, error: `A pipeline change needs a reason of ${MIN_WAIVE_REASON} to ${MAX_EVIDENCE_STRING} characters` };
  }
  const layer = pipelineLayerFromInput({ spec: input.spec, override: input.override });
  if (!layer.ok) return { ok: false, status: 400, error: layer.error, ...(layer.unknown ? { unknown: layer.unknown } : {}) };
  const override = layer.override;
  const target = personaLayerTarget(db, owner, input, runForSession);
  if (!target.ok) return target;
  const checked = checkPipelineLayers(db, target.projectId, [...target.beneath, override], target.checkout);
  if (!checked.ok) return checked;
  const wrongProject = specProjectRefusal(layer.compiled, target.specTarget);
  if (wrongProject) return { ok: false, status: 400, error: wrongProject };
  const weakens = targetWeakens(db, owner, input.scope, target, override, "current");
  if (weakens.length > 0 && input.ownerApproved !== true) {
    return {
      ok: false,
      status: 409,
      error: `The change weakens the pipeline (${weakens.join("; ")}) — only the owner's approval sets it`,
      weakens,
    };
  }
  const unapproved = input.ownerApproved === true ? unapprovedWeakens(weakens, input.approvedWeakens) : [];
  if (unapproved.length > 0) return { ok: false, status: 409, error: staleApprovalError(unapproved), weakens };
  // What a launch later holds the job's layer to (launchLayerWeakens): its
  // weakenings over the project's pipeline itself, not just over the job's last layer.
  const recorded =
    input.scope === "job" ? [...new Set([...weakens, ...targetWeakens(db, owner, input.scope, target, override, "beneath")])] : weakens;
  // Of those, what the owner approved for the job: what this card showed,
  // and what they approved for the job's layer this change replaces over the
  // same projects.
  const reached = target.reach.map((r) => r.projectId);
  const carried = new Set(
    input.scope === "job" && input.ownerApproved === true
      ? [...(input.approvedWeakens ?? []), ...approvedJobWeakens(db, owner, target.job!, reached)]
      : []
  );
  const jobApproved = recorded.filter((w) => carried.has(w));
  const audit = (extra: { runId?: string; jobId?: string | null; projectId?: string | null; stage?: string }) =>
    recordPipelineDecision(db, {
      owner,
      runId: extra.runId ?? null,
      jobId: extra.jobId ?? null,
      projectId: extra.projectId ?? null,
      stage: extra.stage ?? null,
      kind: "config",
      reason,
      actor: input.actor,
      detail: {
        scope: input.scope,
        override,
        ...(input.ownerApproved === true ? { ownerApproved: true } : {}),
        ...(recorded.length > 0 ? { weakens: recorded } : {}),
        ...(jobApproved.length > 0 ? { approvedWeakens: jobApproved } : {}),
        ...(input.scope === "job" ? { projects: reached } : {}),
      },
    });
  const published = (projectId: string | null, jobId?: string) =>
    publishPipelineConfig(notify, { owner, projectId, scope: input.scope, ...(jobId ? { jobId } : {}) });
  const done = (
    resolved: { definition: PipelineDefinition; preset: PipelinePresetId },
    decision: PipelineDecision,
    run?: PipelineRun
  ): PipelineLayerResult => ({
    ok: true,
    scope: input.scope,
    override,
    ...(layer.compiled ? { compiled: layer.compiled } : {}),
    preset: resolved.preset,
    stages: pipelineStageSummary(resolved.definition),
    ...(run ? { run } : {}),
    decision,
  });

  if (input.scope === "user") {
    const broken = projectsBrokenByGlobal(db, owner, override);
    if (broken.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `The owner's layer would break the pipeline of ${broken.join(", ")}: their project layers no longer merge over it`,
        projects: broken,
      };
    }
    setPipelineConfig(db, owner, null, override);
    const decision = audit({});
    published(null);
    return done(checked.resolved, decision);
  }
  if (input.scope === "project") {
    const projectId = target.projectId!;
    setPipelineConfig(db, owner, projectId, override);
    const decision = audit({ projectId });
    published(projectId);
    return done(resolvePipelineFor(db, owner, projectId), decision);
  }
  if (input.scope === "job") {
    const job = target.job!;
    setPersonaJobPipeline(db, job.id, override);
    const decision = audit({ jobId: job.id, projectId: target.projectId });
    published(target.projectId, job.id);
    return done(resolvePipelineFor(db, owner, target.projectId, { jobId: job.id }), decision);
  }

  const run = target.run!;
  if (run.status === "disabled" || run.status === "complete") {
    return { ok: false, status: 409, error: `The run is ${run.status}; change the job or project pipeline instead` };
  }
  if (runPastCoding(run)) return { ok: false, status: 409, error: "the run is past coding; change the job or project pipeline instead" };
  const jobId = target.job?.id ?? null;
  if (!checked.resolved.enabled) {
    return { ok: false, status: 422, error: "A launch layer can't turn a running pipeline off; the worker's launch keeps it" };
  }
  const definition = checked.resolved.definition;
  if (!definition.stages.some((s) => s.id === run.currentStage)) {
    return { ok: false, status: 409, error: `The new pipeline has no "${run.currentStage}" stage for the run to stay at` };
  }
  const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
    definition: { definition, hash: pipelineDefinitionHash(definition), preset: checked.resolved.preset },
    launchOverride: override,
  });
  if (!moved) return { ok: false, status: 409, error: "The run moved meanwhile; reload it and try again" };
  publishRun(moved, notify);
  const decision = audit({ runId: run.id, jobId, projectId: run.projectId ?? null, stage: run.currentStage });
  published(run.projectId ?? null, jobId ?? undefined);
  return done(checked.resolved, decision, moved);
}

/**
 * The boot sweep that hands runs blocked before blocks went to Persona over
 * to it: each open run waiting on an issue id or wontfix findings
 * (owner_input, in today's wording or the earlier one), a spent budget
 * (exhausted) or a stalled worker, whose launch's Persona job waits on the
 * owner with the pipeline's own legacy note ("Pipeline needs you: …"), has
 * its job made active with "Persona deciding: <reason>" and a
 * `pipeline:blocked` frame emitted so Persona wakes to decide. Nothing is
 * waived or advanced, and frozen definitions stay as they are. Only the run
 * that left the job's note lifts it (its stored flag is the job's id and
 * note, as flagJob reads ours), so a job flagged by another of its runs
 * stays as it is; and only for owners whose Persona runs here
 * (`personaRuns`) — anyone else's job keeps waiting on them. Idempotent: a
 * job already noted "Persona deciding" (or touched by anyone since) is left
 * alone and nothing is emitted again. Returns how many runs were handed over.
 */
export function routeLegacyBlocksToPersona(db: Database, deps: PipelineNotify, personaRuns: (owner: string) => boolean): number {
  let handed = 0;
  for (const run of listOpenPipelineRuns(db)) {
    try {
      if (run.status !== "waiting_user") continue;
      const blocked =
        (run.waitingKind === "owner_input" && (isIssueIdReason(run.waitingReason) || isWontfixReason(run.waitingReason))) ||
        run.waitingKind === "exhausted" ||
        run.waitingKind === "stalled";
      if (!blocked) continue;
      if (!personaRuns(run.owner)) continue;
      const owned = personaJobForLaunch(db, run.launchId);
      if (!owned || owned.job.owner !== run.owner || owned.job.status !== "waiting_user") continue;
      if (!(owned.job.note ?? "").startsWith(LEGACY_FLAG_NOTE)) continue;
      const flag = storedFlag(db, run.id);
      if (!flag || flag.id !== owned.job.id || flag.note !== owned.job.note) continue;
      const note = `${PERSONA_DECIDING_NOTE}${run.waitingReason ?? `the run is waiting at ${run.currentStage}`}`;
      const job = db.transaction(() => {
        const updated = updatePersonaJob(db, owned.job.id, { status: "active", note });
        if (updated) setPipelineRunFlaggedJob(db, run.id, { id: updated.id, note });
        return updated;
      })();
      if (!job) continue;
      publishJob(job, deps);
      publishBlocked(db, getPipelineRun(db, run.id) ?? run, deps);
      handed++;
    } catch (err) {
      console.error(`[pipeline] handing run ${run.id}'s block to Persona failed:`, err);
    }
  }
  return handed;
}

/**
 * Records a code review (`url`, http(s) only) as the launch's code_review
 * evidence when its run sits at its code_review stage. `fromReviewGate`: Standup's review gate cut
 * it (the project's review command or review agent), so it is recorded as
 * the gate's — with the ticket's issue id when there is one, and without one
 * otherwise. A url a worker reported itself is recorded only with an issue id
 * (`issueId`, else the ticket's); without one it is left for the worker's own
 * pipeline_advance. Null when nothing was recorded.
 */
export async function recordReviewUrl(
  db: Database,
  launchId: string,
  url: string,
  issueId: string | undefined,
  deps: PipelineDeps,
  opts: { fromReviewGate: boolean }
): Promise<AdvanceResult | null> {
  if (!isHttpUrl(url)) return null;
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || (run.status !== "active" && run.status !== "waiting_user")) return null;
  const stage = stageOf(run, run.currentStage);
  if (stage?.kind !== CODE_REVIEW_STAGE_KIND) return null;
  const id = issueId?.trim() || knownIssueId(db, launchId);
  if (!opts.fromReviewGate && !id) return null;
  return advancePipeline(
    db,
    run.id,
    {
      stage: stage.id,
      evidence: { url: url.trim(), ...(id ? { issueId: id } : {}) },
      source: opts.fromReviewGate ? "review_gate" : undefined,
    },
    deps
  );
}

/**
 * The reviewer sent the launch's work back (its ticket went needs_review →
 * developing): an open or complete run returns to its coding stage, with a
 * failed "rework requested" attempt recorded at the stage it was at. The run
 * starts a new epoch, so the rework gets fresh loop and attempt budgets (the
 * owner asked for it); its history stays. A run already at coding only
 * starts the new epoch. Null when there is no run to move (none, disabled,
 * no coding stage, or it moved meanwhile).
 *
 * Only a reviewer's decision (a human, or the review gate) may call this —
 * never the worker's own session.
 */
export async function pipelineReworkRequested(
  db: Database,
  launchId: string,
  deps: PipelineDeps,
  reason = "rework requested: the review sent the change back"
): Promise<PipelineRun | null> {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || run.status === "disabled") return null;
  const coding = run.definition.stages.find((s) => s.kind === "coding");
  const current = stageOf(run, run.currentStage);
  if (!coding || !current) return null;
  const newEpoch = (run.epoch ?? 0) + 1;
  if (current.id === coding.id) {
    const bumped = updatePipelineRunIf(db, run.id, expectedOf(run), { epoch: newEpoch, stopBlocks: 0 });
    if (bumped) publishRun(bumped, deps);
    return bumped;
  }
  const updated = await commitMove(
    db,
    run,
    current,
    { status: "failed", reason },
    coding.id,
    [],
    run.facts,
    deps,
    { newEpoch }
  );
  if (updated) checkpointFor(db, updated, undefined, `Pipeline: ${reason} at ${current.id} → ${coding.id}.`, deps);
  return updated;
}

// ----------------------------------------------------------------------------
// Views and hooks.
// ----------------------------------------------------------------------------

export interface PipelineStatusView {
  run: PipelineRun;
  stage: PipelineStageDef | null;
  exitCriteria: string;
  next: PipelineEdge[];
  loopBudget: Array<{ edge: string; from: string; to: string; used: number; max: number }>;
  incomplete: string[];
  stages: Record<string, { state: PipelineStageState; attempts: number }>;
  /** The launch's live review tunnel, when one is open or opening. */
  reviewTunnel?: { url: string; port: number; status: string; expiresAt?: string };
}

/** The run as its worker and the console read it: the current stage, its exit criteria, ways out and budgets. */
export function pipelineStatusView(run: PipelineRun): PipelineStatusView {
  const stage = stageOf(run, run.currentStage) ?? null;
  return {
    run,
    stage,
    exitCriteria: stage ? describeStage(stage) : "",
    next: stage?.edges ?? [],
    loopBudget: loopBudget(run.definition, currentEpochAttempts(run), run.facts).map((b) => ({ edge: `${b.from} → ${b.to}`, ...b })),
    incomplete: incompleteRequiredStages(run.definition, run),
    stages: stageStates(run.definition, run),
  };
}

/**
 * Whether the worker's own part of a run is behind it at a stage of `kind`:
 * the code review is cut, and what is left is the owner's (human review) or the end.
 */
function pastWorkerStages(kind: string | undefined): boolean {
  return kind === CODE_REVIEW_STAGE_KIND || kind === HUMAN_REVIEW_STAGE_KIND || kind === "complete";
}

/**
 * Re-checks a run with not-applicable waivers in its current epoch
 * (notApplicableDrift). When code has turned up since, the run goes back to
 * its coding stage in a new epoch, so the change runs the stages it skipped —
 * unless a budget already ran out on the owner, whose wait it keeps. Returns
 * why the work can't go on as finished (code turned up, or git can't confirm
 * it didn't), or null when the waivers still hold.
 */
export async function reopenAfterNotApplicable(db: Database, run: PipelineRun, deps: PipelineDeps): Promise<string | null> {
  if (run.status === "disabled") return null;
  const drift = await notApplicableDrift(db, run, deps);
  if (!drift) return null;
  const waived = `${drift.stages.join(", ")} ${drift.stages.length === 1 ? "was" : "were"} waived as not applicable`;
  if (drift.kind === "unknown") {
    return `${waived}, but ${drift.why} to confirm it still changes no code — ask_human: the owner decides whether the work goes on.`;
  }
  const why = `${waived}, but ${drift.why}`;
  if (run.status === "waiting_user" && run.waitingKind === "exhausted") {
    return `${why}; the run is waiting on its owner — ${OWNER_NEEDED}.`;
  }
  const reopened = await pipelineReworkRequested(db, run.launchId, deps, `${why} — the change runs the pipeline`);
  return `${why}, so the delivery pipeline ${reopened ? "is back" : "goes back"} at coding — run its stages with real evidence before finishing the work.`;
}

/**
 * Re-checks the run of the launch whose root session is `sessionId` before
 * its Stop is decided: a stage that can't apply to the launch is skipped
 * (settleNotApplicableStage), and a worker that waived stages as not
 * applicable and then changed code is held to them (reopenAfterNotApplicable).
 * A failure is logged and never fails the hook.
 */
export async function pipelineRecheckBeforeStop(db: Database, sessionId: string, deps: PipelineDeps): Promise<void> {
  const found = rootPipelineRun(db, sessionId);
  if (!found) return;
  try {
    await settleNotApplicableStage(db, found, deps);
    const run = getPipelineRun(db, found.id) ?? found;
    if (notApplicableWaivers(run).length > 0) await reopenAfterNotApplicable(db, run, deps);
  } catch (err) {
    console.error(`[pipeline] re-checking run ${found.id} failed:`, err);
  }
}

/**
 * Whether launch `launchId` runs a delivery pipeline whose worker stages are
 * still ahead of it: its acceptance criterion then runs from the validation
 * stage, so the worker reports that stage to run it, not
 * mark_ready_for_review. A run at its code_review stage or past it (validation waived,
 * say) lets mark_ready_for_review through (pipelineReadyBlock), so its
 * criterion runs from there.
 */
export function launchAwaitsValidation(db: Database, launchId: string): boolean {
  const run = getPipelineRunByLaunch(db, launchId);
  if (!run || run.status === "disabled" || run.status === "complete") return false;
  const stage = stageOf(run, run.currentStage);
  return !!stage && !pastWorkerStages(stage.kind);
}

/**
 * Why the launch may not mark its work ready for review yet, or null: an
 * active or waiting run must first reach its code_review (or complete) stage, and a
 * run whose stages were waived as not applicable must still show no code
 * change (reopenAfterNotApplicable, which sends it back to coding otherwise).
 */
export async function pipelineReadyBlock(db: Database, launchId: string, deps: PipelineDeps): Promise<string | null> {
  const open = getPipelineRunByLaunch(db, launchId);
  if (!open || open.status === "disabled") return null;
  await settleNotApplicableStage(db, open, deps);
  const found = getPipelineRun(db, open.id) ?? open;
  const reopened = await reopenAfterNotApplicable(db, found, deps);
  if (reopened) return reopened;
  const run = getPipelineRun(db, found.id) ?? found;
  if (run.status === "complete") return null;
  const stage = stageOf(run, run.currentStage);
  if (!stage || pastWorkerStages(stage.kind)) return null;
  const ahead = incompleteRequiredStages(run.definition, run).filter((id) => !pastWorkerStages(stageOf(run, id)?.kind));
  return (
    `The delivery pipeline is at ${stage.title} (${stage.id}); finish ${ahead.join(", ") || stage.id} with ` +
    `pipeline_advance first — mark the work ready once the run reaches its ${CODE_REVIEW_STAGE_KIND} stage.`
  );
}

/** Whether any session under `rootId` (not the root itself) is still running. */
function childStillRunning(db: Database, tree: string[], rootId: string): boolean {
  const children = tree.filter((id) => id !== rootId);
  if (children.length === 0) return false;
  const row = db
    .query(`SELECT 1 AS found FROM sessions WHERE id IN (${children.map(() => "?").join(", ")}) AND status = 'running' LIMIT 1`)
    .get(...children) as { found: number } | null;
  return row !== null;
}

/** Whether an ask is pending on any of `sessionIds`. */
function askPending(db: Database, sessionIds: string[]): boolean {
  const row = db
    .query(`SELECT 1 AS found FROM asks WHERE session_id IN (${sessionIds.map(() => "?").join(", ")}) AND status = 'pending' LIMIT 1`)
    .get(...sessionIds) as { found: number } | null;
  return row !== null;
}

/**
 * Why a Stop at `stage` should go to the owner rather than be blocked: input
 * only they have (the code review's issue id — unless the project's review
 * gate cuts the review, which needs none), or the kind's runner says so.
 */
function stopToOwner(db: Database, run: PipelineRun, stage: PipelineStageDef, reviewGate: boolean): string | null {
  if (!reviewGate && stage.ownerInput === "issue_id" && !knownIssueId(db, run.launchId) && !stageNotApplicable(db, run, stage)) {
    // Work that already landed has no review left to cut: the owner closes the
    // job (it closes as landed) rather than being asked for an issue id.
    const launch = getLaunch(db, run.launchId);
    return launch && launchWorkLanded(db, run, launch) ? REVIEW_LANDED_REASON : ISSUE_ID_REASON;
  }
  const stopReason = getPipelineStageRunner(stage.kind)?.stopReason;
  return stopReason ? stopReason({ db, run, stage, launch: getLaunch(db, run.launchId) }) : null;
}

/** Whether `run` waits on the owner for an issue id that Standup has learned since (the ticket now carries one). */
function issueIdArrived(db: Database, run: PipelineRun): boolean {
  return (
    run.status === "waiting_user" &&
    run.waitingKind === "owner_input" &&
    isIssueIdReason(run.waitingReason) &&
    knownIssueId(db, run.launchId) !== undefined
  );
}

/**
 * Whether `run` waits on the owner for an issue id its code review no longer needs: its
 * work landed since, so the owner is to be told to close the job instead.
 */
function issueIdMoot(db: Database, run: PipelineRun): boolean {
  if (run.status !== "waiting_user" || !isIssueIdReason(run.waitingReason)) return false;
  const launch = getLaunch(db, run.launchId);
  return !!launch && launchWorkLanded(db, run, launch);
}

/**
 * Whether the Stop of `sessionId` should be blocked to keep its worker on the
 * pipeline: only a launch's root session — never one a human drives (its
 * newest launch is adopted) — with an active run short of complete (or one
 * waiting on an issue id that has since arrived), no ask pending on it or its
 * subagents and no subagent still running. A stage that needs the owner's
 * input the worker lacks (the code review's issue id) hands the run to the owner
 * instead. At the code_review stage of a project whose review gate cuts the review, the
 * worker is sent to mark_ready_for_review; once the ticket is in review with
 * no review recorded yet, the Stop goes through and the run waits on the owner
 * (a review the gate records later still completes it). Each block counts; once
 * MAX_STOP_BLOCKS consecutive blocks went unanswered by an advance (or a
 * prompt), the run is handed to its owner (stalled) and the Stop goes through.
 * A parked run (PipelineRun.parked) lets every Stop through untouched: its
 * worker was told to wait, so the Stop neither counts nor hands it on.
 */
export function pipelineStopDecision(
  db: Database,
  sessionId: string,
  notify: Pick<PipelineDeps, "broadcast" | "reviewScratchDir">
): { block: true; reason: string } | null {
  const run = rootPipelineRun(db, sessionId);
  if (!run || run.parked) return null;
  if (run.status !== "active" && !issueIdArrived(db, run) && !issueIdMoot(db, run)) return null;
  const stage = stageOf(run, run.currentStage);
  if (!stage || stage.kind === "complete") return null;
  if (getLaunchBySession(db, sessionId)?.kind === "adopted") return null;
  const tree = sessionTree(db, sessionId);
  if (askPending(db, tree) || childStillRunning(db, tree, sessionId)) return null;
  const gate = stage.kind === CODE_REVIEW_STAGE_KIND ? projectReviewGate(db, run.projectId) : null;
  const reviewGate = gate !== null;
  const gateWithoutReview = gate !== null && getTicketByLaunch(db, run.launchId)?.status === "needs_review";
  const toOwner = gateWithoutReview ? REVIEW_GATE_NO_REVIEW_REASON : stopToOwner(db, run, stage, reviewGate);
  if (toOwner) {
    // Nothing is handed to the owner for review while the Review tab would be
    // empty: the worker is held here to submit its packet first. A worker that
    // keeps stopping without one still reaches the owner — as the stall it is,
    // never as a review waiting for them.
    const needsPacket = reviewPacketNeeded(db, run);
    if (needsPacket && run.stopBlocks < MAX_STOP_BLOCKS) {
      briefReviewPacket(db, run, notify);
      updatePipelineRunIf(db, run.id, expectedOf(run), { stopBlocks: run.stopBlocks + 1 });
      return { block: true, reason: `The delivery pipeline can't hand this to the owner yet: ${needsPacket}` };
    }
    const reason = needsPacket
      ? `worker stopped ${MAX_STOP_BLOCKS} times at ${stage.id} without submitting a review packet — ${PERSONA_DECIDES}`
      : toOwner;
    markRunWaiting(db, run, reason, needsPacket ? "stalled" : "owner_input", notify);
    return null;
  }
  if (run.stopBlocks >= MAX_STOP_BLOCKS) {
    markRunWaiting(db, run, `worker stopped ${MAX_STOP_BLOCKS} times at ${stage.id} without advancing — ${PERSONA_DECIDES}`, "stalled", notify);
    return null;
  }
  updatePipelineRunIf(db, run.id, expectedOf(run), { stopBlocks: run.stopBlocks + 1 });
  const at = `The delivery pipeline isn't finished: you're at ${stage.title} (${stage.id}).`;
  const hint = getPipelineStageRunner(stage.kind)?.stopHint?.({ db, run, stage, launch: getLaunch(db, run.launchId) });
  return {
    block: true,
    reason: gate
      ? `${at} To finish it, ${reviewGateCodeReviewStep(gate)} — or ask_human if you're blocked, before stopping.`
      : hint
        ? `${at} ${hint} Or ask_human if you're blocked, before stopping.`
        : `${at} ${describeStage(stage)} ` +
          "Report it with pipeline_advance (pipeline_status shows what it needs), or ask_human if you're blocked, before stopping.",
  };
}

/**
 * A prompt reached the launch's root session `sessionId` — the turn is being
 * driven from outside (a human or a steer), so the run's consecutive Stop
 * blocks start over, and a parked run is un-parked: every way a message
 * reaches a launched worker (the console's send, Persona's send_to_session,
 * a queued steer or teammate message riding the next prompt, someone typing
 * in its pane) ends in this prompt. A park Persona set is kept when the
 * prompt (`prompt`, the hook's text) is only messages typed into the pane
 * before the park (recordPaneSend): a busy worker submits what was sent to
 * it at its next turn, and that is the message the park was set after.
 */
export function pipelinePromptSubmitted(
  db: Database,
  sessionId: string,
  notify?: PipelineNotify,
  opts: { prompt?: string } = {}
): void {
  const sends = opts.prompt !== undefined ? takePaneSends(sessionId, opts.prompt) : null;
  const run = rootPipelineRun(db, sessionId);
  if (!run) return;
  if (run.parked && !sentBeforePersonaPark(run.parked, sends)) clearRunPark(db, run, notify);
  const current = getPipelineRun(db, run.id) ?? run;
  if (current.stopBlocks > 0) updatePipelineRunIf(db, current.id, expectedOf(current), { stopBlocks: 0 });
}

// ----------------------------------------------------------------------------
// Parking: a worker told to wait (on another job landing, say) ends its turns
// without the Stop hook sending it back to the pipeline.
// ----------------------------------------------------------------------------

/**
 * How long a message typed into a worker's pane is remembered while it waits
 * to be submitted as the worker's prompt (a busy worker submits it at its
 * next turn); one older than this is forgotten.
 */
export const PANE_SEND_TTL_MS = 30 * 60 * 1000;

/** The most pane sends remembered per session. */
const MAX_PANE_SENDS = 20;

/** The longest job id a park may name. */
const MAX_PARK_JOB_ID = 200;

interface PaneSend {
  text: string;
  at: number;
}

/** Messages typed into each session's pane not yet seen submitted as its prompt, oldest first. */
const paneSends = new Map<string, PaneSend[]>();

const promptText = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/**
 * Notes that `text` was typed into `sessionId`'s pane (the console's send,
 * Persona's send_to_session `now`), for pipelinePromptSubmitted to know the
 * prompt it becomes. Kept in memory only: after a restart such a prompt reads
 * as a new message, which un-parks the run.
 */
export function recordPaneSend(sessionId: string, text: string, at: number = Date.now()): void {
  const normalized = promptText(text);
  if (!normalized) return;
  const live = (paneSends.get(sessionId) ?? []).filter((s) => at - s.at < PANE_SEND_TTL_MS);
  live.push({ text: normalized, at });
  paneSends.set(sessionId, live.slice(-MAX_PANE_SENDS));
}

/**
 * Takes the pane sends `prompt` carries (one or more, as a busy worker joins
 * what was typed while it worked) from `sessionId`'s record: those sends, and
 * whether the prompt is made of nothing else.
 */
function takePaneSends(sessionId: string, prompt: string): { sends: PaneSend[]; whole: boolean } {
  const now = Date.now();
  const live = (paneSends.get(sessionId) ?? []).filter((s) => now - s.at < PANE_SEND_TTL_MS);
  let rest = promptText(prompt);
  const taken: PaneSend[] = [];
  const left: PaneSend[] = [];
  for (const send of live) {
    const at = rest.indexOf(send.text);
    if (at < 0) {
      left.push(send);
      continue;
    }
    rest = rest.slice(0, at) + rest.slice(at + send.text.length);
    taken.push(send);
  }
  if (left.length > 0) paneSends.set(sessionId, left);
  else paneSends.delete(sessionId);
  return { sends: taken, whole: taken.length > 0 && rest.trim().length === 0 };
}

/** Whether a prompt of pane sends `sends` is only messages typed before Persona set `park`. */
function sentBeforePersonaPark(park: PipelinePark, sends: { sends: PaneSend[]; whole: boolean } | null): boolean {
  if (park.by !== "persona" || !sends?.whole) return false;
  const at = Date.parse(park.at);
  return Number.isFinite(at) && sends.sends.every((s) => s.at <= at);
}

/** Clears `run`'s park and publishes the run when there was one; the run as it now stands. */
function clearRunPark(db: Database, run: PipelineRun, notify?: PipelineNotify): PipelineRun {
  if (!setPipelineRunPark(db, run.id, null)) return getPipelineRun(db, run.id) ?? run;
  const updated = getPipelineRun(db, run.id) ?? { ...run, parked: undefined };
  if (notify) publishRun(updated, notify);
  return updated;
}

export type ParkResult = { ok: true; run: PipelineRun; cleared?: boolean } | { ok: false; status: 404 | 409 | 422; error: string };

export interface ParkInput {
  reason: unknown;
  waitingOnJobId?: unknown;
  by: PipelineParkBy;
  actor: string;
}

/**
 * Parks run `runId`: its worker waits (on job `waitingOnJobId` when named), so
 * its Stops go through unblocked and uncounted (pipelineStopDecision) until a
 * message reaches it, it is un-parked or it advances. The run's stage and
 * waiting state are left as they are. On Persona's park the steers and
 * teammate messages already queued for the worker are noted, so their
 * delivery doesn't end the park (pipelineMessageDelivered). A worker's own
 * park ends with any message delivered after it, and is recorded in the
 * owner's audit and told to Persona once (publishParked) — parking again on
 * the same wait is a no-op. Refused on a run that is complete or disabled
 * (nothing holds its Stop), with a reason under MIN_PARK_REASON or over
 * MAX_EVIDENCE_STRING characters, or naming a job its owner doesn't have or
 * that already closed.
 */
export function parkPipelineRun(db: Database, runId: string, input: ParkInput, notify: PipelineNotify): ParkResult {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (run.status === "complete") return { ok: false, status: 409, error: "The delivery pipeline is already complete — nothing holds the worker's turn" };
  if (run.status === "disabled") return { ok: false, status: 409, error: "The delivery pipeline is disabled for this launch — nothing holds the worker's turn" };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MIN_PARK_REASON) {
    return { ok: false, status: 422, error: `A park needs a reason of at least ${MIN_PARK_REASON} characters: what the worker waits for` };
  }
  if (reason.length > MAX_EVIDENCE_STRING) {
    return { ok: false, status: 422, error: `The park reason is too long (at most ${MAX_EVIDENCE_STRING} characters)` };
  }
  let waitingOnJobId: string | undefined;
  if (input.waitingOnJobId !== undefined && input.waitingOnJobId !== null && input.waitingOnJobId !== "") {
    if (typeof input.waitingOnJobId !== "string" || input.waitingOnJobId.trim().length > MAX_PARK_JOB_ID) {
      return { ok: false, status: 422, error: "waitingOnJobId must be a job id" };
    }
    waitingOnJobId = input.waitingOnJobId.trim();
    const job = getPersonaJob(db, waitingOnJobId);
    // Another owner's job reads as unknown.
    if (!job || job.owner !== run.owner) return { ok: false, status: 422, error: `No job ${waitingOnJobId} to wait on` };
    if (job.status !== "active" && job.status !== "waiting_user") {
      return { ok: false, status: 422, error: `that job already closed (${job.status}) — carry on` };
    }
  }
  // The worker parking again on the same wait changes nothing: Persona heard of it once.
  const prior = run.parked;
  if (input.by === "worker" && prior && prior.by === "worker" && prior.reason === reason && prior.waitingOnJobId === waitingOnJobId) {
    return { ok: true, run };
  }
  const park: PipelinePark = {
    reason,
    ...(waitingOnJobId ? { waitingOnJobId } : {}),
    by: input.by,
    actor: input.actor,
    at: new Date().toISOString(),
  };
  // Persona parks a worker after what it sent it; a worker parking itself
  // hasn't read what is still queued for it, so that ends its park.
  const queued = input.by === "persona" ? queuedMessageIds(db, run) : [];
  if (queued.length > 0) park.queuedMessageIds = queued;
  db.transaction(() => {
    setPipelineRunPark(db, run.id, park);
    if (input.by === "worker") {
      recordRunDecision(db, run, {
        stage: run.currentStage,
        kind: "park",
        reason,
        actor: input.actor,
        detail: { by: "worker", ...(waitingOnJobId ? { waitingOnJobId } : {}) },
      });
    }
  })();
  const updated = getPipelineRun(db, run.id) ?? { ...run, parked: park };
  publishRun(updated, notify);
  if (input.by === "worker") publishParked(db, updated, park, notify);
  return { ok: true, run: updated };
}

/**
 * Tells the owner's Persona that `run`'s worker parked itself (a
 * `pipeline:parked` frame, which its event router turns into a worker
 * event) — when the run's launch belongs to an open Persona job of the
 * run's owner.
 */
function publishParked(db: Database, run: PipelineRun, park: PipelinePark, notify: PipelineNotify): void {
  const owned = personaJobForLaunch(db, run.launchId);
  if (!owned || owned.job.owner !== run.owner) return;
  if (owned.job.status !== "active" && owned.job.status !== "waiting_user") return;
  const launch = getLaunch(db, run.launchId);
  const payload: PipelineParkedPayload = {
    owner: run.owner,
    jobId: owned.job.id,
    runId: run.id,
    launchId: run.launchId,
    ...(launch?.sessionId ? { sessionId: launch.sessionId } : {}),
    stage: run.currentStage,
    reason: park.reason,
    ...(park.waitingOnJobId ? { waitingOnJobId: park.waitingOnJobId } : {}),
  };
  notify.broadcast({ type: "pipeline:parked", payload, timestamp: new Date().toISOString(), audience: run.owner });
}

/** Un-parks run `runId`; `cleared` says whether it was parked (un-parking a run that isn't is a no-op). */
export function unparkPipelineRun(db: Database, runId: string, notify: PipelineNotify): ParkResult {
  const run = getPipelineRun(db, runId);
  if (!run) return { ok: false, status: 404, error: "No delivery pipeline run found" };
  if (!run.parked) return { ok: true, run, cleared: false };
  return { ok: true, run: clearRunPark(db, run, notify), cleared: true };
}

/** Persona parks (`park`) or un-parks one of its owner's runs, recorded in the owner's audit (pipeline_decisions). */
export function personaParkDecision(
  db: Database,
  runId: string,
  input: { park: boolean; why: unknown; waitingOnJobId?: unknown; actor: string },
  notify: PipelineNotify
): ParkResult & { decision?: PipelineDecision } {
  if (input.park) {
    const result = parkPipelineRun(db, runId, { reason: input.why, waitingOnJobId: input.waitingOnJobId, by: "persona", actor: input.actor }, notify);
    if (!result.ok) return result;
    const park = result.run.parked!;
    const decision = recordRunDecision(db, result.run, {
      stage: result.run.currentStage,
      kind: "park",
      reason: park.reason,
      actor: input.actor,
      ...(park.waitingOnJobId ? { detail: { waitingOnJobId: park.waitingOnJobId } } : {}),
    });
    return { ...result, decision };
  }
  const why = typeof input.why === "string" ? input.why.trim() : "";
  if (why.length < MIN_PARK_REASON) {
    return { ok: false, status: 422, error: `Un-parking needs a reason of at least ${MIN_PARK_REASON} characters` };
  }
  const before = getPipelineRun(db, runId);
  const result = unparkPipelineRun(db, runId, notify);
  if (!result.ok || !result.cleared) return result;
  const decision = recordRunDecision(db, result.run, {
    stage: result.run.currentStage,
    kind: "unpark",
    reason: why,
    actor: input.actor,
    ...(before?.parked ? { detail: { parked: before.parked } } : {}),
  });
  return { ...result, decision };
}

/**
 * A message reached `sessionId`'s worker another way than a prompt (see
 * pipelinePromptSubmitted): its run is un-parked — unless every message
 * delivered (`messageIds`, the steers and teammate messages delivered) was
 * already queued when Persona set the park (PipelinePark.queuedMessageIds),
 * as when a steer is sent and the run parked after it ("send then park"):
 * that message is what the park was set after, not a new one.
 */
export function pipelineMessageDelivered(
  db: Database,
  sessionId: string,
  notify: PipelineNotify,
  opts: { messageIds?: string[] } = {}
): void {
  const run = rootPipelineRun(db, sessionId);
  if (!run?.parked) return;
  const queued = new Set(run.parked.queuedMessageIds ?? []);
  const delivered = opts.messageIds ?? [];
  if (delivered.length > 0 && delivered.every((id) => queued.has(id))) return;
  clearRunPark(db, run, notify);
}

/** The ids of the steers and teammate messages queued for `run`'s worker now. */
function queuedMessageIds(db: Database, run: PipelineRun): string[] {
  const sessionId = getLaunch(db, run.launchId)?.sessionId;
  if (!sessionId) return [];
  return [...getPendingSteers(db, sessionId).map((s) => s.id), ...getPendingMessages(db, sessionId).map((m) => m.id)];
}

/**
 * How the worker finishes the code_review stage of a project with review gate `mode`;
 * `inReview`: the ticket is already in review, so mark_ready_for_review is
 * behind it.
 */
export function reviewGateCodeReviewStep(mode: ReviewGateMode, inReview = false): string {
  if (mode === "command") {
    return inReview
      ? "the ticket is already in review — the project's review command cuts the code review and Standup records it; if it failed, ask_human"
      : "call mark_ready_for_review — the project's review gate cuts the code review and Standup records it";
  }
  const report = "report its url with report_ticket_status (reviewUrl) so Standup records it";
  return inReview
    ? `the ticket is already in review — cut the code review the review gate handed you, then ${report}`
    : `call mark_ready_for_review — the project's review gate then hands you the code review to cut; once it's cut, ${report}`;
}

/** One line telling the worker where its pipeline stands, for the prompt's additional context; null without an open run. */
export function pipelineSteerLine(db: Database, sessionId: string): string | null {
  const run = pipelineRunForSession(db, sessionId);
  if (!run || run.status === "disabled" || run.status === "complete") return null;
  const stage = stageOf(run, run.currentStage);
  if (!stage) return null;
  const attempt = attemptsAt(run, stage.id) + 1;
  const round = attempt > 1 ? `, attempt ${attempt}` : "";
  const waiting = run.status === "waiting_user" && run.waitingReason ? ` Waiting for the owner: ${run.waitingReason}.` : "";
  const gate = stage.kind === CODE_REVIEW_STAGE_KIND ? projectReviewGate(db, run.projectId) : null;
  const inReview = gate !== null && getTicketByLaunch(db, run.launchId)?.status === "needs_review";
  const next = gate
    ? `To finish it, ${reviewGateCodeReviewStep(gate, inReview)}.`
    : "When its exit criteria hold, report it with pipeline_advance; pipeline_status shows the evidence it needs.";
  return `[Standup delivery pipeline] Current stage: ${stage.title} (${stage.id}${round}).${waiting} ${next}`;
}

// ----------------------------------------------------------------------------
// Persona job views.
// ----------------------------------------------------------------------------

/** Launch statuses after which a worker will never finish its run (it failed, or its worktree is gone). */
const TERMINAL_LAUNCH_STATUSES: ReadonlySet<string> = new Set(["failed", "cleaned"]);

function launchEnded(db: Database, launchId: string): boolean {
  const launch = getLaunch(db, launchId);
  return !launch || TERMINAL_LAUNCH_STATUSES.has(launch.status);
}

/**
 * Each of the job's launches whose (enabled) run still has required stages to
 * finish — a launch that ended (failed or cleaned up) is no longer expected to.
 */
export function incompletePipelinesForJob(db: Database, jobId: string): Array<{ launchId: string; stages: string[] }> {
  const job = getPersonaJob(db, jobId);
  if (!job) return [];
  return listPipelineRunsByLaunches(db, job.launchIds)
    .filter((run) => run.status !== "disabled" && run.status !== "complete" && !launchEnded(db, run.launchId))
    .map((run) => ({ launchId: run.launchId, stages: incompleteRequiredStages(run.definition, run) }))
    .filter((entry) => entry.stages.length > 0);
}

/**
 * Why the job can't be closed done, or null: a live worker's run still has
 * required stages (incompletePipelinesForJob), a run whose stages were waived
 * as not applicable no longer shows its launch changed no code
 * (notApplicableDrift, read through `git`), or the job's workers ran the
 * pipeline and none of them finished it.
 *
 * A run whose launch's work already landed outside the pipeline
 * (landedCloses) is not held against the close: it is closed with its moot
 * stages recorded `waived`, never passed (closeLandedPipelines, which the
 * caller runs once the close goes through). Read-only: a refused close
 * changes nothing.
 */
export async function pipelineDoneRefusal(
  db: Database,
  jobId: string,
  git: LandingGit = DEFAULT_LANDING_GIT,
  /** The close's landedCloses, read once by the caller so the check and the close agree; read here when omitted. */
  closes?: LandedClose[]
): Promise<string | null> {
  const job = getPersonaJob(db, jobId, { withView: false });
  if (!job) return null;
  const planned = closes ?? (await landedCloses(db, jobId, git));
  const closing = new Set(planned.map((c) => c.run.launchId));
  const incomplete = incompletePipelinesForJob(db, jobId).filter((p) => !closing.has(p.launchId));
  if (incomplete.length > 0) {
    const runs = incomplete.map((p) => `launch ${p.launchId}: ${p.stages.join(", ")}`).join("; ");
    const approvedElsewhere = incomplete
      .filter((p) => latestSubmittedReviewPacketForLaunch(db, p.launchId)?.status === "approved")
      .map((p) => p.launchId);
    const pending = blockingPendingPackets(db, job, planned);
    const why =
      (pending.length > 0
        ? ` Review packet ${pending.join(", ")} still waits on the owner's decision in the Review tab; nothing closes as landed until it is decided.`
        : "") +
      (approvedElsewhere.length > 0
        ? ` Launch ${approvedElsewhere.join(", ")} has an approved review packet that doesn't count as landed: it was approved at another commit than its checkout stands at now, or a code review is still to cut.`
        : "");
    return (
      `cannot close done: the delivery pipeline is incomplete — ${runs}. Finish the stages, close as failed/cancelled, ` +
      "or ask the owner to waive them in the console. A launch whose own work already landed (its branch merged into " +
      `its target, or its review packet approved at the commit it stands at) is closed as landed.${why}`
    );
  }
  for (const run of listPipelineRunsByLaunches(db, job.launchIds)) {
    if (run.status === "disabled" || closing.has(run.launchId)) continue;
    const drift = await notApplicableDrift(db, run, git);
    // A cleaned-up launch's checkout is gone: there is nothing left to read.
    if (drift && !(drift.kind === "unknown" && launchEnded(db, run.launchId))) {
      return (
        `cannot close done: launch ${run.launchId}'s ${drift.stages.join(", ")} ${drift.stages.length === 1 ? "was" : "were"} ` +
        `waived as not applicable, but ${drift.kind === "unknown" ? `${drift.why} to confirm it changed no code` : drift.why}. ` +
        "The change has to run its stages (its worker's next stop or ready sends the run back to coding), or close the job as failed/cancelled."
      );
    }
  }
  const enabled = listPipelineRunsByLaunches(db, job.launchIds).filter((run) => run.status !== "disabled");
  if (enabled.length > 0 && !enabled.some((run) => run.status === "complete") && closing.size === 0) {
    const runs = enabled.map((r) => `launch ${r.launchId}: stopped at ${r.currentStage}`).join("; ");
    return `cannot close done: no worker finished its delivery pipeline — ${runs}. Close as failed/cancelled, or relaunch the work.`;
  }
  return null;
}

/** Whether `branch`'s work, read in checkout `dir`, landed in `target` (gitBranchLanded, the default). */
export type BranchLanded = (dir: string, branch: string, target: string, opts?: { remoteOnly?: boolean }) => Promise<boolean>;

/** The git reads a close-out makes, injectable for tests. */
export type LandingGit = Pick<PipelineDeps, "changedFiles" | "headState"> & {
  branchLanded?: BranchLanded;
  /** The synchronous git an approval's currency is read with (approvalIsCurrent). */
  git?: GitRunner;
};

const DEFAULT_LANDING_GIT: LandingGit = { changedFiles: gitChangedFiles, headState: gitHeadState };

/** One open run the close settles, and how its launch's work landed. */
export interface LandedClose {
  run: PipelineRun;
  landing: PipelineLanding;
}

/** The checkouts a launch's branch can be read in: its own, then its project's repos. */
function launchCheckouts(db: Database, launch: Launch): string[] {
  const repos = (launch.projectId ? getProject(db, launch.projectId)?.repos : undefined) ?? [];
  return [...new Set([launch.worktreePath, ...repos])].filter((d): d is string => !!d && existsSync(d));
}

/**
 * How the work of `run`'s launch landed outside the pipeline, or null when it
 * didn't (or Standup can't tell):
 *  - `review_packet`: the launch's newest submitted packet was approved, its
 *    checkout still stands at the commit the packet was submitted at (when
 *    git can read it), and no code_review stage that applies is left to run —
 *    an approval is not a code review;
 *  - `branch`: the launch's branch carries a commit of its own that is in
 *    its target branch (`branchLanded`, read in its checkout else the
 *    project's repos) — only the remote target where a code-review stage
 *    applies at all. A launch working on the target itself never counts;
 *  - `moot` (only with `allowMoot`): the run never got past its start stage
 *    and the launch changed nothing — no file against its base, or its
 *    checkout is gone with the launch.
 */
async function launchLanding(db: Database, run: PipelineRun, git: LandingGit, allowMoot: boolean): Promise<PipelineLanding | null> {
  const launch = getLaunch(db, run.launchId);
  if (!launch) return null;
  // A code_review stage that applies and hasn't run: an approval is not a code review.
  const reviewLeft = incompleteRequiredStages(run.definition, run).some((id) => {
    const stage = stageOf(run, id);
    return stage?.kind === CODE_REVIEW_STAGE_KIND && !stageNotApplicable(db, run, stage);
  });
  const packet = latestSubmittedReviewPacketForLaunch(db, launch.id);
  // The same rule human_review holds an approval to (approvalIsCurrent): this
  // round of the work, no uncommitted edits, the change it was given on.
  if (packet?.status === "approved" && !reviewLeft && approvalIsCurrent(launch, packet, git.git, run, db)) {
    return { via: "review_packet", packetId: packet.id, why: `its review packet ${packet.id} was approved` };
  }
  const branch = launch.branch?.trim();
  const target = localTargetBranch(launch.worktreePath, launch.baseBranch, git.git ?? defaultGitRunner);
  if (branch && branch !== target && !launch.inPlace && launch.kind !== "adopted") {
    // Where a code review applies (cut or not), only the remote counts: a
    // reviewed change lands upstream, and a local target branch can be moved
    // from inside the checkout.
    const remoteOnly = codeReviewApplies(db, run, launch);
    for (const dir of launchCheckouts(db, launch)) {
      if (await (git.branchLanded ?? gitBranchLanded)(dir, branch, target, { remoteOnly })) {
        return { via: "branch", branch, target, why: `branch ${branch} is merged into ${target}` };
      }
    }
  }
  if (allowMoot && stageOf(run, run.currentStage)?.kind === "start") {
    if (launchEnded(db, launch.id)) return { via: "moot", why: "the launch ended without getting past its start stage" };
    if (launch.worktreePath) {
      try {
        if ((await launchChangedFiles(launch, git.changedFiles)).length === 0) {
          return { via: "moot", why: "the launch never got past its start stage and changed nothing" };
        }
      } catch {
        // git can't read the checkout: nothing shows the launch changed nothing.
      }
    }
  }
  return null;
}

/**
 * The open runs of the job a close-done settles as landed (launchLanding),
 * each with how its launch's work landed. Settling needs an anchor — a run
 * whose own work landed, or one that finished its pipeline — and then also
 * takes the follow-up runs that work made moot. A run whose launch has
 * unlanded work is never in it (pipelineDoneRefusal refuses the close for it), and
 * nothing is settled while one of the job's review packets still waits on
 * the owner. Read-only.
 */
export async function landedCloses(db: Database, jobId: string, git: LandingGit = DEFAULT_LANDING_GIT): Promise<LandedClose[]> {
  const job = getPersonaJob(db, jobId, { withView: false });
  if (!job) return [];
  const runs = listPipelineRunsByLaunches(db, job.launchIds);
  const open = runs.filter((r) => r.status === "active" || r.status === "waiting_user");
  const closes: LandedClose[] = [];
  for (const run of open) {
    const landing = await launchLanding(db, run, git, true);
    if (landing) closes.push({ run, landing });
  }
  if (blockingPendingPackets(db, job, closes).length > 0) return [];
  const anchored = runs.some((r) => r.status === "complete") || closes.some((c) => c.landing.via !== "moot");
  return anchored ? closes : [];
}

/**
 * The job's packets still waiting on the owner that hold a close back: any,
 * except one whose launch's branch already landed — there is nothing left
 * for the owner to decide on work that merged.
 */
function blockingPendingPackets(db: Database, job: { owner: string; id: string; launchIds: string[] }, closes: LandedClose[]): string[] {
  const merged = new Set(closes.filter((c) => c.landing.via === "branch").map((c) => c.run.launchId));
  return pendingReviewPacketLaunchesForJob(db, job.owner, job.id, job.launchIds)
    .filter((p) => !p.launchId || !merged.has(p.launchId))
    .map((p) => p.id);
}

/**
 * Closes the runs a close-done settles as landed (landedCloses): each
 * required stage a run hadn't finished — its current one first — is recorded
 * `waived` (never passed) with how its launch's work landed as the evidence,
 * and the run is complete. Run once the close's check passed, with the same
 * `closes` it was checked with. All of them close or none do: returns the
 * runs it closed, or none when one moved meanwhile.
 */
export async function closeLandedPipelines(
  db: Database,
  jobId: string,
  actor: string,
  notify: PipelineNotify,
  git: LandingGit = DEFAULT_LANDING_GIT,
  /** The landedCloses the close was checked with (pipelineDoneRefusal); read here when omitted. */
  closes?: LandedClose[]
): Promise<PipelineRun[]> {
  const planned = closes ?? (await landedCloses(db, jobId, git));
  const job = getPersonaJob(db, jobId, { withView: false });
  // Every run closes in one transaction, each only as it was read: one that
  // moved since rolls the whole close back, so a refused close changes nothing.
  // What the reading rested on outside the run row is read again inside it —
  // no packet of the job waiting on the owner, and each approval the close
  // counts still the newest packet and still current — so a packet submitted
  // or a commit made while the close was being checked can't slip through.
  const tx = db.transaction((): PipelineRun[] => {
    if (!job || blockingPendingPackets(db, job, planned).length > 0) throw new StaleRun();
    return planned.map(({ run, landing }) => {
      if (landing.via === "review_packet") {
        const launch = getLaunch(db, run.launchId);
        const packet = latestSubmittedReviewPacketForLaunch(db, run.launchId);
        if (!launch || packet?.id !== landing.packetId || packet.status !== "approved" || !approvalIsCurrent(launch, packet, git.git, run, db)) {
          throw new StaleRun();
        }
      }
      const label = landing.via === "review_packet" ? "approved" : landing.via === "branch" ? "merged" : "moot";
      const reason = `${label} — ${landing.why}, which made the stage moot`;
      const evidence: PipelineWaiverEvidence = {
        waiver: { by: "persona", actor, reason: `${label}: ${landing.why}`, notApplicable: false, landed: landing },
      };
      const complete = run.definition.stages.find((s) => s.kind === "complete");
      if (!complete) throw new StaleRun();
      const open = [run.currentStage, ...incompleteRequiredStages(run.definition, run)].filter(
        (id, i, all) => all.indexOf(id) === i && id !== complete.id && stageOf(run, id)?.kind !== "start"
      );
      const moved = updatePipelineRunIf(db, run.id, expectedOf(run), {
        currentStage: complete.id,
        status: "complete",
        waitingReason: null,
        waitingKind: null,
        flaggedJob: null,
        reviewHandoffAt: null,
        stopBlocks: 0,
        stageEnteredAt: new Date().toISOString(),
      });
      if (!moved) throw new StaleRun();
      open.forEach((stageId, i) => {
        recordPipelineAttempt(db, run.id, {
          stageId,
          status: "waived",
          evidence,
          reason,
          nextStage: open[i + 1] ?? complete.id,
          epoch: run.epoch ?? 0,
        });
      });
      return getPipelineRun(db, run.id)!;
    });
  });
  let closed: PipelineRun[];
  try {
    closed = tx();
  } catch (e) {
    if (e instanceof StaleRun) return [];
    throw e;
  }
  for (const run of closed) publishRun(run, notify);
  return closed;
}


/**
 * The pipeline line for a job snapshot, from the most pressing enabled run of
 * `launchIds` (a live worker's run first, see runIsLive — waiting on the
 * owner, then active, then complete, the newest among equals; with no live
 * worker, the newest run, as the job drawer shows it): its stage,
 * status, the waiting reason as `blocker`, `round` — the attempt in progress
 * at the stage — when it is past the first, and `parked` — what its worker
 * was told to wait for — while it is parked.
 * Undefined when no launch has an enabled run.
 */
export function pipelineJobSummary(
  db: Database,
  launchIds: string[]
): { stage: string; status: string; blocker?: string; round?: number; parked?: Pick<PipelinePark, "reason" | "waitingOnJobId" | "by"> } | undefined {
  const rank: Record<string, number> = { waiting_user: 0, active: 1, complete: 2 };
  const runs = listPipelineRunsByLaunches(db, launchIds).filter((r) => r.status !== "disabled");
  if (runs.length === 0) return undefined;
  const dead = (r: PipelineRun) => (runIsLive(r) ? 0 : 1);
  const newestFirst = (a: PipelineRun, b: PipelineRun) => (a.createdAt < b.createdAt ? 1 : -1);
  const run = [...runs].sort(
    (a, b) =>
      dead(a) - dead(b) || (dead(a) ? newestFirst(a, b) : rank[a.status]! - rank[b.status]! || newestFirst(a, b))
  )[0]!;
  const attempt = attemptsAt(run, run.currentStage) + 1;
  return {
    stage: run.currentStage,
    status: run.status,
    ...(run.status === "waiting_user" && run.waitingReason ? { blocker: run.waitingReason } : {}),
    ...(run.status !== "complete" && attempt > 1 ? { round: attempt } : {}),
    ...(run.parked
      ? { parked: { reason: run.parked.reason, ...(run.parked.waitingOnJobId ? { waitingOnJobId: run.parked.waitingOnJobId } : {}), by: run.parked.by } }
      : {}),
  };
}

// ----------------------------------------------------------------------------
// The worker's brief.
// ----------------------------------------------------------------------------

/** The directory the brief tells workers to write screenshots to: the helper's per-user default. */
function screenshotDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return `/tmp/standup-screenshots-${uid}`;
}

/**
 * The opening-prompt block that tells a worker the stages it moves through
 * and how to report each. `reviewGate`: the project's review gate (its mode,
 * see projectReviewGate; true for a review command) finishes the code review
 * after mark_ready_for_review, so the code_review stage is finished that way
 * rather than by reporting a review cut by hand.
 */
export function formatPipelineInstruction(
  def: PipelineDefinition,
  opts: { reviewGate?: boolean | ReviewGateMode | null; codeReviewNotApplicable?: string | null } = {}
): string {
  const stages = def.stages.filter((s) => s.kind !== "start" && s.kind !== "complete");
  const noReview = opts.codeReviewNotApplicable?.trim();
  const lines = stages.map((s, i) => {
    if (s.kind === CODE_REVIEW_STAGE_KIND && noReview) {
      return `${i + 1}. ${s.title} (${s.id}): ${noReview}. Standup skips it itself — don't report it, and don't ask anyone for an issue id.`;
    }
    return `${i + 1}. ${describeStage(s)}`;
  });
  const gate: ReviewGateMode | null = opts.reviewGate === true ? "command" : opts.reviewGate || null;
  const hasReview = stages.some((s) => s.kind === CODE_REVIEW_STAGE_KIND);
  const review = !hasReview
    ? ""
    : noReview
      ? " This project has no code review to cut, so no issue id is needed."
      : gate
        ? ` For the code review stage, ${reviewGateCodeReviewStep(gate)} (with the ticket's issue id when it has one).`
        : ` ${REVIEW_DESCRIPTION_BRIEF}`;
  const outward = hasReview ? "Deploying and cutting the code review still go" : "Outward steps (a deploy) still go";
  return (
    "\n\n---\nDelivery pipeline — Standup tracks this launch through these stages:\n" +
    lines.join("\n") +
    "\n\nWhen a stage's exit criteria hold, report it with the `pipeline_advance` tool ({stage, evidence}); " +
    "`pipeline_status` shows where the run stands and the evidence the current stage takes. Start by advancing " +
    "the `start` stage. The server works out the outcome from your evidence — a failed validation, review or " +
    "deploy loops back to coding, so fix it and come round again; report real exit codes and real findings. " +
    "When a loop or attempt budget runs out the run waits for Persona to decide (skip, waive, close out, or " +
    "escalate to the owner) — or for the owner in the console when no Persona job owns this launch. " +
    "If this launch turns out to change no code at all, waive each stage that doesn't apply with " +
    "`pipeline_advance` {stage, waive: {reason}} — recorded as waived, not passed, and shown to the owner; never " +
    "report evidence for work you didn't do. Standup refuses the waiver once the launch has a code change.\n" +
    "If you're told to wait on something outside this launch (another job landing, say), call `pipeline_park` " +
    "{reason, waitingOnJobId?} and end your turn — don't ask again each turn; the next message to you un-parks the run.\n" +
    `${outward} through the safety floor exactly as they always do; the pipeline only sequences them.${review}\n` +
    `Screenshots: \`bun ${SCREENSHOT_SCRIPT} <local url> --out ${screenshotDir()}/<name>.png\` (that directory ` +
    "is the helper's default, created owner-only; it shoots only localhost and data: URLs), then report " +
    "the absolute .png paths.\n" +
    `Recordings: for a perf, load-time or interaction-flow change, attach a short recording to the review packet by ` +
    `default (static UI stays on screenshots): \`bun ${SCREENSHOT_SCRIPT} --record <local url> --cold ` +
    `[--login-url <the console sign-in URL Vite prints>] [--preset persona | --mark "<label>=<css selector>"]... ` +
    `--out <review scratch dir>/<name>.webm\` records a desktop WebM with the measured ms burned in (navigation ` +
    "start, first paint, and each mark). Save it in the review scratch dir `review_brief` names, or the worktree — " +
    "the only places packet media is read from — and attach it with submit_review_packet's media.\n" +
    "Keep editing files with the Edit/Write tools as above. mark_ready_for_review is refused until the run " +
    `reaches its ${hasReview ? CODE_REVIEW_STAGE_KIND : "review packet"} stage, and stopping before the run is complete is blocked.`
  );
}
