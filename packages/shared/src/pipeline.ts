// ============================================================================
// Delivery pipeline — the stage graph a launched worker moves through
// (start → coding → validation → review → deploy → screenshot → code_review →
// human_review → complete), the evidence each stage needs to be advanced, and
// the pure rules that pick the next stage. The collector's engine persists
// runs and calls these; the console renders them. No node imports: the web
// bundles this file.
// ============================================================================

import { HUMAN_REVIEW_STAGE_DEF, HUMAN_REVIEW_STAGE_KIND, humanReviewStageKind } from "./review.js";
import { CODE_REVIEW_STAGE_KIND } from "./code-review.js";
import { mergeReviewTunnelConfig, validateReviewTunnelConfig, type ReviewTunnelConfig, type ReviewTunnelLayer } from "./review-tunnel.js";

/** The stage kinds Standup ships; each is registered through registerPipelineStageKind below. */
export type BuiltinPipelineStageKind =
  | "start"
  | "coding"
  | "validation"
  | "review"
  | "live_check"
  | "deploy"
  | "screenshot"
  | typeof CODE_REVIEW_STAGE_KIND
  | "complete";
/**
 * A stage kind: a built-in one or any kind registered with
 * registerPipelineStageKind. validateDefinition refuses unregistered kinds.
 */
export type PipelineStageKind = string;
export type PipelineFact = "ui_changed" | "docs_only";
export type PipelineOutcome = "passed" | "failed";

/** All given fields must match. `not` negates the fact test only. */
export interface PipelineCondition {
  outcome?: PipelineOutcome;
  fact?: PipelineFact;
  not?: boolean;
}

export interface PipelineEdge {
  to: string;
  when?: PipelineCondition;
  /** Marks an edge that closes a cycle; it may be taken at most `maxTraversals` times per run. */
  loop?: { maxTraversals: number };
}

export interface PipelineStageDef {
  id: string;
  kind: PipelineStageKind;
  title: string;
  required: boolean;
  /** Exit criteria in prose, used in briefs and the console. */
  description?: string;
  /** Per-stage attempt cap (default DEFAULT_STAGE_MAX_ATTEMPTS). */
  maxAttempts?: number;
  edges: PipelineEdge[];
  /** Fact conditions; ANY match auto-skips the stage on entry. */
  skipWhen?: PipelineCondition[];
  /** The worker may skip the stage with `{skip: {reason}}`. */
  skippable?: boolean;
  /** Deploy/code review: the action runs through the safety floor; the pipeline only sequences it. */
  outward?: boolean;
  /** Requires an owner-gate floor ask during the stage (default false). */
  requireOwnerGate?: boolean;
  ownerInput?: "issue_id";
  /** Review: fewest reviewers the evidence must name (default 2). */
  minReviewers?: number;
  /** Review: lowest open severity that fails the stage (default "medium"). */
  blockOn?: "high" | "medium";
  /** Globs whose change sets `ui_changed` (default DEFAULT_UI_PATHS). */
  uiPaths?: string[];
  /** Screenshot: fewest screenshots the evidence must carry (default 1). */
  minScreenshots?: number;
  /**
   * Validation: commands the server runs in the worktree (through the safety
   * floor, as the acceptance criterion is) when the change touches one of
   * their `paths` (every change when `paths` is absent); one that exits
   * non-zero fails the stage. Only the owner's configuration sets them.
   */
  checks?: PipelineStageCheck[];
}

/** One validation check (see PipelineStageDef.checks). */
export interface PipelineStageCheck {
  command: string;
  /** Globs of repo-relative files; the check runs when any changed file matches one. */
  paths?: string[];
  /** Kill the command after this long (default: the acceptance criterion's timeout). */
  timeoutMs?: number;
}

/** A pipeline graph; the stage with id "start" (kind start) is the entry. */
export interface PipelineDefinition {
  version: 1;
  stages: PipelineStageDef[];
  /**
   * How the project's UI is served for review (the layers' reviewTunnel
   * merged); absent when no layer configures one. Frozen with the run, so the
   * screenshot stage opens the tunnel the launch was started with.
   */
  reviewTunnel?: ReviewTunnelConfig;
}

export type PipelineStagePatch = Partial<Omit<PipelineStageDef, "id" | "kind">> & { skip?: boolean };

/**
 * A named base flow (see pipeline-presets.ts): `full` — deploy, screenshots
 * and a code review, for projects whose changes go through one; `light` — an
 * isolated live check instead of a deploy and no code review, for projects
 * with none to open.
 */
export type PipelinePresetId = "full" | "light";

export const PIPELINE_PRESET_IDS: readonly PipelinePresetId[] = ["full", "light"];

/** One configuration layer (the user's, a project's, a job's or a launch's) applied over the pipeline catalog. */
export interface PipelineOverride {
  enabled?: boolean;
  /**
   * The base flow; the last layer that names one wins, else the project's own
   * (see autoPipelinePreset). It applies just before that layer, so it resets
   * what the layers beneath set (see resolvePipelineLayers).
   */
  preset?: PipelinePresetId;
  /** The plain-words spec this layer was compiled from (see compilePipelineSpec), kept for the owner to read. */
  spec?: string;
  /**
   * Every loop edge's bound (1 to MAX_PIPELINE_LOOP_TRAVERSALS), applied
   * after the layers merge: the last layer that sets it wins, over any
   * `edges` a layer gave.
   */
  maxRounds?: number;
  stages?: Record<string, PipelineStagePatch>;
  add?: Array<{ after: string; stage: PipelineStageDef }>;
  /** Review-tunnel fields this layer sets (see ReviewTunnelConfig); merged field by field over the layers beneath, null clearing one. */
  reviewTunnel?: ReviewTunnelLayer;
}

export type PipelineFacts = Partial<Record<PipelineFact, boolean>>;

export type PipelineRunStatus = "active" | "waiting_user" | "complete" | "disabled";
export type PipelineAttemptStatus = "passed" | "failed" | "skipped" | "waived";

export interface PipelineStageAttempt {
  id: string;
  runId: string;
  stageId: string;
  /** 1-based count of attempts at this stage within the run. */
  attempt: number;
  status: PipelineAttemptStatus;
  evidence?: unknown;
  reason?: string;
  sessionId?: string;
  nextStage?: string;
  /** The run's epoch when the attempt was recorded (see PipelineRun.epoch); 0 when absent. */
  epoch?: number;
  createdAt: string;
}

export interface PipelineRun {
  id: string;
  launchId: string;
  owner: string;
  projectId?: string;
  /** The resolved definition, frozen when the run started. */
  definition: PipelineDefinition;
  definitionHash: string;
  currentStage: string;
  status: PipelineRunStatus;
  waitingReason?: string;
  /** Why the run waits on its owner, when it does (see PipelineWaitingKind). */
  waitingKind?: PipelineWaitingKind;
  /** The Persona job this run set waiting and the note it left there, until the run moves again. */
  flaggedJob?: { id: string; note: string };
  facts: PipelineFacts;
  stopBlocks: number;
  stageEnteredAt: string;
  /**
   * Bumped each time a reviewer sends the work back for rework: loop and
   * attempt budgets count only the attempts of the current epoch, while the
   * stage views keep the whole history. 0 when absent.
   */
  epoch?: number;
  /** Why a disabled run is off (see PipelineDisabledReason); absent on runs that aren't disabled. */
  disabledReason?: PipelineDisabledReason;
  /**
   * When the review-agent gate last handed the worker the code review to open,
   * until the worker's report of that review is taken as the gate's record (once per
   * hand-off).
   */
  reviewHandoffAt?: string;
  /**
   * Whether the run's launch still has a worker, read from the stored launch
   * and session rows (see PipelineWorkerState) each time the run is read;
   * absent when the launch row is gone.
   */
  worker?: PipelineWorker;
  /** The preset the run's definition was resolved from (see pipeline-presets.ts); absent on runs started before presets. */
  preset?: PipelinePresetId;
  /** The launch's own configuration layer, over the owner's, the project's and the job's; absent when it had none. */
  launchOverride?: PipelineOverride;
  /**
   * The worker was told to wait (on another job landing, say): while parked
   * its Stop goes through unblocked and uncounted. Cleared by the next message
   * delivered to the worker, an unpark, or any advance of the run.
   */
  parked?: PipelinePark;
  createdAt: string;
  updatedAt: string;
  attempts: PipelineStageAttempt[];
}

/** Who parked a run: its `worker` (pipeline_park) or the owner's `persona` (park_session). */
export type PipelineParkBy = "worker" | "persona";

/** A run's parked state (see PipelineRun.parked). */
export interface PipelinePark {
  reason: string;
  /** The Persona job the worker waits on, when it names one. */
  waitingOnJobId?: string;
  by: PipelineParkBy;
  actor: string;
  at: string;
  /**
   * The steers and teammate messages already queued for the worker when
   * Persona set the park: their delivery is the message the park was set
   * after, so it doesn't un-park the run. Never set on a worker's own park.
   */
  queuedMessageIds?: string[];
}

/** The fewest characters a park's reason may have. */
export const MIN_PARK_REASON = 10;

/**
 * The state of a run's launch: `live` while the launch is starting or running
 * and its session (if any) hasn't ended; `superseded` once it isn't live and a
 * newer launch was linked to the same Persona job; `ended` otherwise. Derived
 * on read, so a session that resumes (SessionEnd is undone by /clear, resume
 * or adopt) reads live again.
 */
export type PipelineWorkerState = "live" | "ended" | "superseded";

export interface PipelineWorker {
  state: PipelineWorkerState;
  /** When the launch's session ended, when it has. */
  endedAt?: string;
}

/** Whether the run's launch still has a worker; a run read without its launch state counts as live. */
export function runIsLive(run: Pick<PipelineRun, "worker">): boolean {
  return (run.worker?.state ?? "live") === "live";
}

/**
 * Why a run is disabled: `opt_out` — the launch asked for no pipeline;
 * `not_coding` — the launch's kind can't produce a change of its own to ship
 * (a provisioned working dir, not a git worktree of the project's repo) and
 * it didn't ask for the pipeline; `no_mcp` — its worker can't reach the
 * standup MCP server, so it could never report a stage; `attempt` — a
 * Best-of-N attempt, turned on when it is picked; `other` — the owner's
 * configuration turned the pipeline off.
 */
export type PipelineDisabledReason = "opt_out" | "not_coding" | "no_mcp" | "attempt" | "other";

/**
 * What a launch asks of its delivery pipeline: `auto` — the launch's kind
 * decides (a worktree or in-place launch of a project with a repo gets the
 * owner's pipeline; a provisioned, scratch or reused-worktree launch doesn't);
 * `off` — none, for research, lookups, read-only or docs work; `default` —
 * the owner's resolved pipeline even where `auto` would leave it off (a
 * provisioned workspace that will ship a change). A scratch launch (no repo)
 * and a fixer's reused worktree never get one.
 */
export type LaunchPipelineMode = "auto" | "off" | "default";

export const LAUNCH_PIPELINE_MODES: readonly LaunchPipelineMode[] = ["auto", "off", "default"];

/**
 * A launch request's `pipeline` field as a mode: undefined when absent, null
 * when it is neither a mode nor a boolean. A boolean is the older form:
 * false is `off`, true is `auto`.
 */
export function parseLaunchPipelineMode(value: unknown): LaunchPipelineMode | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === false) return "off";
  if (value === true) return "auto";
  return typeof value === "string" && (LAUNCH_PIPELINE_MODES as readonly string[]).includes(value)
    ? (value as LaunchPipelineMode)
    : null;
}

/**
 * Who waived a stage: the run's `owner` in the console (any stage, any time),
 * or — only as not applicable, on a launch that changed no code — its
 * `worker` through pipeline_advance or the owner's `persona`. The `persona`
 * may also accept a review held on wontfix findings (wontfixAccepted).
 */
export type PipelineWaiverBy = "owner" | "worker" | "persona";

/** The fewest characters a not-applicable waiver's reason may have. */
export const MIN_WAIVE_REASON = 10;

/** The fewest characters Persona's reason for accepting a review's wontfix findings may have. */
export const MIN_WONTFIX_ACCEPT_REASON = 40;

/** The fewest characters Persona's reason for waiving a stage or closing a run out may have. */
export const MIN_PERSONA_WAIVE_REASON = 40;

/**
 * What Persona decided about a run's stage, or its pipeline configuration:
 * `skip` — the stage doesn't apply to this change; `waive` — the stage stands
 * waived on Persona's judgment; `close_out` — the stages left are no longer in
 * the project's pipeline; `escalate` — the owner decides; `accept_wontfix`
 * and `not_applicable` — the waivers of those names; `config` — a change to a
 * pipeline layer; `park` / `unpark` — Persona parked a run's worker to wait,
 * or let it go on.
 */
export type PipelineDecisionKind =
  | "skip"
  | "waive"
  | "close_out"
  | "escalate"
  | "accept_wontfix"
  | "not_applicable"
  | "config"
  | "park"
  | "unpark";

/** How a waived attempt came about, when Persona waived it (see PipelineDecisionKind). */
export type PipelineWaiverKind = "skip" | "waive" | "close_out" | "accept_wontfix" | "not_applicable";

/** One recorded Persona decision about a pipeline (the pipeline_decisions audit). */
export interface PipelineDecision {
  id: string;
  owner: string;
  runId?: string;
  jobId?: string;
  projectId?: string;
  stage?: string;
  kind: PipelineDecisionKind;
  reason: string;
  actor: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

/** A blocking review finding a wontfix-accepted waiver covered, with the reviewer who raised it. */
export interface PipelineWontfixFinding {
  reviewer: string;
  severity: PipelineReviewFinding["severity"];
  title: string;
  /** The worker's note on the finding (why it is out of scope, or where it is tracked). */
  note?: string;
}

/**
 * The launch's checkout as a not-applicable waiver found it: its HEAD commit
 * and how many entries its own HEAD reflog had. Any later commit, switch,
 * reset or stash in it changes one of them.
 */
export interface PipelineWaiverCheckout {
  head: string;
  reflog: number;
}

/** The evidence a waived attempt records. */
export interface PipelineWaiverEvidence {
  waiver: {
    by: PipelineWaiverBy;
    actor: string;
    reason: string;
    /** Waived as not applicable: the launch had no code change when it was waived. */
    notApplicable: boolean;
    /** For a not-applicable waiver, the checkout it found clean. */
    checkout?: PipelineWaiverCheckout;
    /** Waived because the launch's work landed outside the pipeline (see PipelineLanding), which made the stage moot. */
    landed?: PipelineLanding;
    /**
     * Persona accepted a review held on wontfix findings: every blocking
     * finding of the review attempt it waived, each one marked wontfix.
     */
    wontfixAccepted?: { findings: PipelineWontfixFinding[] };
    /** Which of Persona's decisions recorded the waiver (see PipelineWaiverKind); absent on the owner's and older waivers. */
    kind?: PipelineWaiverKind;
  };
}

/**
 * How one launch's run was settled when its job closed done outside the
 * pipeline: the owner approved the launch's review packet at the commit it
 * still stands at, the launch's branch is contained in its target branch, or
 * the launch never got past its start stage and changed nothing — a follow-up
 * that the work landing elsewhere in the job made moot.
 */
export type PipelineLanding =
  | { via: "review_packet"; packetId: string; why: string }
  | { via: "branch"; branch: string; target: string; why: string }
  | { via: "moot"; why: string };

/** A waived stage of a run, as the console and the Review tab show it. */
export interface PipelineWaiver {
  stageId: string;
  title: string;
  by: PipelineWaiverBy;
  actor: string;
  reason: string;
  notApplicable: boolean;
  /** The wontfix findings Persona accepted, when it waived a held review. */
  wontfixFindings?: PipelineWontfixFinding[];
  /** Which of Persona's decisions recorded it, when one did. */
  kind?: PipelineWaiverKind;
  at: string;
}

/**
 * How a waiver reads to the owner: "waived by Persona (wontfix accepted)",
 * "waived by Persona" (its waive or close-out), "waived · not applicable" or
 * "waived".
 */
export function waiverLabel(waiver: Pick<PipelineWaiver, "notApplicable" | "wontfixFindings"> & { kind?: PipelineWaiverKind }): string {
  if (waiver.wontfixFindings) return "waived by Persona (wontfix accepted)";
  if (waiver.kind === "waive" || waiver.kind === "close_out") return "waived by Persona";
  return waiver.notApplicable ? "waived · not applicable" : "waived";
}

/** The wontfix findings of a waived attempt's evidence, when it records Persona accepting them. */
export function wontfixAcceptedFindings(evidence: unknown): PipelineWontfixFinding[] | undefined {
  const waiver = (evidence as Partial<PipelineWaiverEvidence> | undefined)?.waiver;
  const accepted = waiver?.by === "persona" ? waiver.wontfixAccepted : undefined;
  return accepted && Array.isArray(accepted.findings) ? accepted.findings : undefined;
}

/**
 * Every waived attempt of `run`, oldest first. An attempt recorded without
 * waiver evidence is an owner's console waiver, whose reason reads
 * "waived by <actor>: <reason>".
 */
export function pipelineWaivers(run: Pick<PipelineRun, "definition" | "attempts">): PipelineWaiver[] {
  const titles = new Map(run.definition.stages.map((s) => [s.id, s.title]));
  return run.attempts
    .filter((a) => a.status === "waived")
    .map((a) => {
      const w = (a.evidence as Partial<PipelineWaiverEvidence> | undefined)?.waiver;
      const legacy = /^waived by ([^:]+): ([\s\S]*)$/.exec(a.reason ?? "");
      const wontfixFindings = wontfixAcceptedFindings(a.evidence);
      return {
        stageId: a.stageId,
        title: titles.get(a.stageId) ?? a.stageId,
        by: w?.by ?? "owner",
        actor: w?.actor ?? legacy?.[1] ?? "owner",
        reason: w?.reason ?? legacy?.[2] ?? a.reason ?? "",
        notApplicable: w?.notApplicable === true,
        ...(wontfixFindings ? { wontfixFindings } : {}),
        ...(w?.kind ? { kind: w.kind } : {}),
        at: a.createdAt,
      };
    });
}

/** The attempts of `run` recorded in its current epoch — the ones its loop and attempt budgets count. */
export function currentEpochAttempts(run: Pick<PipelineRun, "epoch" | "attempts">): PipelineStageAttempt[] {
  const epoch = run.epoch ?? 0;
  return run.attempts.filter((a) => (a.epoch ?? 0) === epoch);
}

/**
 * What a waiting run waits for: `owner_input` — a value only the owner has
 * (the code review's issue id), which the worker may still bring in through an
 * advance; `exhausted` — a loop or attempt budget ran out; `stalled` — the
 * worker kept stopping without advancing. An exhausted run takes no worker
 * advance until the owner waives the stage or closes the job; a stalled one
 * is active again once the worker reports the stage with valid evidence.
 */
export type PipelineWaitingKind = "owner_input" | "exhausted" | "stalled";

// ----------------------------------------------------------------------------
// Evidence shapes, one per stage kind.
// ----------------------------------------------------------------------------

export interface CodingEvidence {
  summary: string;
  commits?: string[];
  changedFiles?: string[];
}
export interface ValidationEvidence {
  commands: ValidationCommand[];
  criterion?: { command: string; met: boolean; output: string };
  /** The stage's checks as the server ran them; `skipped` when no changed file matched the check's paths. */
  checks?: ValidationCheckResult[];
}
/**
 * A command the worker ran for validation. A non-zero exit still passes when
 * the same command also failed on the base commit (`baseline`) and every test
 * in `failing` is one that failed there too: nothing fails only on the branch.
 */
export interface ValidationCommand {
  command: string;
  exitCode: number;
  summary: string;
  /** The tests that failed in this run of the command. */
  failing?: string[];
  /** The same command run on the base commit: its exit code and the tests that failed there. */
  baseline?: { commit: string; exitCode: number; failing: string[] };
}
export interface ValidationCheckResult {
  command: string;
  met: boolean;
  output: string;
  skipped?: boolean;
}
/** A reviewer's finding in review-stage evidence (distinct from the ticket auto-reviewer's ReviewFinding). */
export interface PipelineReviewFinding {
  severity: "high" | "medium" | "low";
  title: string;
  status: "open" | "fixed" | "wontfix";
  /** For a wontfix finding: why it is out of scope, or where it is tracked. */
  note?: string;
}
export interface ReviewEvidence {
  reviewers: Array<{ name: string; findings: PipelineReviewFinding[] }>;
}
export interface FloorAskRecord {
  askId: string;
  gate: string;
  question: string;
  answer?: string;
  status: string;
}
export interface DeployEvidence {
  account: string;
  region?: string;
  stacks: string[];
  liveSamples: Array<{ request: string; response: string; ok: boolean }>;
  floorAsks?: FloorAskRecord[];
}
export interface ScreenshotEvidence {
  /**
   * `path` is the file the worker named; `storedPath` the collector's own copy
   * of the validated bytes, which is all the console is ever served.
   */
  screenshots: Array<{ path: string; storedPath?: string; caption?: string; width?: number; height?: number }>;
}
/** Evidence for a code_review stage: the review (pull request) opened for the change. */
export interface CodeReviewEvidence {
  /** The review's id in its tool (a pull request number, a review id). */
  reviewId?: string;
  /** The review's page, an http(s) URL. */
  url?: string;
  /** Required from a worker; a review the review gate opened is recorded without one when the ticket has none. */
  issueId?: string;
  /** "review_gate" when Standup recorded the review its review gate opened, rather than the worker reporting it. */
  source?: "worker" | "review_gate";
  floorAsks?: FloorAskRecord[];
}

// ----------------------------------------------------------------------------
// Constants and the default pipeline.
// ----------------------------------------------------------------------------

/** Ceiling for any loop edge's maxTraversals. */
export const MAX_PIPELINE_LOOP_TRAVERSALS = 10;
/** Attempt cap for a stage that sets no maxAttempts. */
export const DEFAULT_STAGE_MAX_ATTEMPTS = 6;
export const DEFAULT_MIN_REVIEWERS = 2;
export const DEFAULT_BLOCK_ON: "high" | "medium" = "medium";
export const DEFAULT_MIN_SCREENSHOTS = 1;
/** Most checks one validation stage may declare. */
export const MAX_STAGE_CHECKS = 10;
/**
 * The time one validation's criterion and checks may take together. They run
 * inside the worker's pipeline_advance call, so the whole set must answer
 * before the MCP client's tool timeout (about 25 minutes) gives up and the
 * worker calls again; a check still due when it runs out is unmet.
 */
export const VALIDATION_CHECK_BUDGET_MS = 20 * 60 * 1000;
/**
 * Bounds of a check's configured timeoutMs. A run clamps each check to what
 * is left of VALIDATION_CHECK_BUDGET_MS, so a larger value never runs longer;
 * the bound stays wide because a stored layer that stops validating is
 * dropped whole (resolvePipelineFor falls back to fewer layers).
 */
export const MIN_CHECK_TIMEOUT_MS = 1000;
export const MAX_CHECK_TIMEOUT_MS = 60 * 60 * 1000;
/** A check's timeout when it names none. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
/** Globs whose change marks the work as UI-visible (`ui_changed`). */
export const DEFAULT_UI_PATHS: readonly string[] = ["packages/web/**", "**/*.tsx", "**/*.css", "**/*.html"];
/** Globs of documentation files; a change touching only these is `docs_only`. */
export const DOCS_PATHS: readonly string[] = ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "docs/**"];

/** Evidence limits: the whole evidence as JSON, any one array, any one string. */
export const MAX_EVIDENCE_BYTES = 64 * 1024;
export const MAX_EVIDENCE_ARRAY = 50;
export const MAX_EVIDENCE_STRING = 8 * 1024;

export const BUILTIN_PIPELINE_STAGE_KINDS: readonly BuiltinPipelineStageKind[] = [
  "start",
  "coding",
  "validation",
  "review",
  "deploy",
  "live_check",
  "screenshot",
  CODE_REVIEW_STAGE_KIND,
  "complete",
];
/** The built-in kinds; registeredPipelineStageKinds() also lists registered ones. */
export const PIPELINE_STAGE_KINDS: readonly PipelineStageKind[] = BUILTIN_PIPELINE_STAGE_KINDS;
export const PIPELINE_FACTS: readonly PipelineFact[] = ["ui_changed", "docs_only"];

const START_ID = "start";
const COMPLETE_ID = "complete";

const passed: PipelineCondition = { outcome: "passed" };
const failed: PipelineCondition = { outcome: "failed" };
const LOOP_ROUNDS = 4;

export const DEFAULT_PIPELINE: PipelineDefinition = {
  version: 1,
  stages: [
    {
      id: "start",
      kind: "start",
      title: "Start",
      required: false,
      description: "The run has started; advance to begin coding.",
      edges: [{ to: "coding", when: passed }],
    },
    {
      id: "coding",
      kind: "coding",
      title: "Coding",
      required: true,
      description: "The change is implemented and committed in the worktree.",
      edges: [{ to: "validation", when: passed }],
    },
    // The default declares no checks: a check's command belongs to one repo.
    // A project adds its own through its owner's project layer, e.g. for the
    // Standup repo, PUT /api/pipeline-config?project=<id> with
    //   {"override": {"stages": {"validation": {"checks": [{"command": "bun run test:live",
    //     "timeoutMs": 900000,
    //     "paths": ["packages/web/**", "packages/collector/src/ws*.ts",
    //       "packages/collector/src/persona/runtime.ts", "packages/gateway/src/**"]}]}}}}
    {
      id: "validation",
      kind: "validation",
      title: "Validation",
      required: true,
      description:
        "Build, typecheck and tests ran green (every command exited 0) and the approved plan's acceptance criterion, if any, is met.",
      edges: [
        { to: "review", when: passed },
        { to: "coding", when: failed, loop: { maxTraversals: LOOP_ROUNDS } },
      ],
    },
    {
      id: "review",
      kind: "review",
      title: "Adversarial review",
      required: true,
      description:
        "At least two independent reviewers tried to refute the change; every High or Medium finding is fixed (one left open or marked wontfix fails the stage — only the owner, or Persona accepting the wontfix findings, can waive it).",
      minReviewers: DEFAULT_MIN_REVIEWERS,
      blockOn: DEFAULT_BLOCK_ON,
      edges: [
        { to: "deploy", when: passed },
        { to: "coding", when: failed, loop: { maxTraversals: LOOP_ROUNDS } },
      ],
    },
    {
      id: "deploy",
      kind: "deploy",
      title: "Deploy and live-validate",
      required: true,
      description:
        "The change is deployed to a lower environment and representative live requests behave as expected. A change with nothing to deploy (no deploy target) skips the stage with a reason.",
      outward: true,
      skipWhen: [{ fact: "docs_only" }],
      skippable: true,
      edges: [
        { to: "screenshot", when: passed },
        { to: "coding", when: failed, loop: { maxTraversals: LOOP_ROUNDS } },
      ],
    },
    {
      id: "screenshot",
      kind: "screenshot",
      title: "Screenshots",
      required: true,
      description:
        "Desktop PNG screenshots show the changed UI working (recordings go in the review packet's media, not this stage's evidence).",
      skipWhen: [{ fact: "ui_changed", not: true }, { fact: "docs_only" }],
      skippable: true,
      minScreenshots: DEFAULT_MIN_SCREENSHOTS,
      edges: [{ to: CODE_REVIEW_STAGE_KIND, when: passed }],
    },
    {
      id: CODE_REVIEW_STAGE_KIND,
      kind: CODE_REVIEW_STAGE_KIND,
      title: "Code review",
      required: true,
      description: "A code review (pull request) is opened for the change.",
      outward: true,
      edges: [{ to: HUMAN_REVIEW_STAGE_DEF.id, when: passed }],
    },
    HUMAN_REVIEW_STAGE_DEF,
    {
      id: "complete",
      kind: "complete",
      title: "Complete",
      required: false,
      description: "Every stage is done.",
      edges: [],
    },
  ],
};

/** Raised when a pipeline configuration (or its merged result) is invalid; `errors` lists each problem. */
export class PipelineConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[] | string) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(`invalid pipeline configuration: ${list.join("; ")}`);
    this.name = "PipelineConfigError";
    this.errors = list;
  }
}

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The stage's attempt cap. */
export function stageMaxAttempts(stage: PipelineStageDef): number {
  return stage.maxAttempts ?? DEFAULT_STAGE_MAX_ATTEMPTS;
}

/**
 * The edge a stage takes when it passes regardless of facts: the first edge
 * whose condition names no fact and no outcome other than "passed". Used to
 * rewire around a skipped stage and to chain auto-skips.
 */
export function passedEdge(stage: PipelineStageDef): PipelineEdge | undefined {
  return stage.edges.find((e) => !e.when?.fact && (e.when?.outcome === undefined || e.when.outcome === "passed"));
}

/** True when `c` holds for `outcome` and `facts`. An unknown fact matches neither way. */
export function conditionMatches(
  c: PipelineCondition,
  outcome: PipelineOutcome | null,
  facts: PipelineFacts
): boolean {
  if (c.outcome !== undefined && c.outcome !== outcome) return false;
  if (c.fact !== undefined) {
    const value = facts[c.fact];
    if (value === undefined) return false;
    if ((c.not ? !value : value) !== true) return false;
  }
  return true;
}

function describeCondition(c: PipelineCondition): string {
  const parts: string[] = [];
  if (c.outcome) parts.push(`outcome ${c.outcome}`);
  if (c.fact) parts.push(`${c.fact} is ${c.not ? "false" : "true"}`);
  return parts.join(" and ") || "always";
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` (repo-relative) matches `glob` (`**` spans directories, `*` and `?` do not). */
export function globMatches(glob: string, path: string): boolean {
  return globToRegExp(glob.replace(/^\.\//, "")).test(path.replace(/^\.\//, ""));
}

/**
 * Facts about a change from its changed files: `ui_changed` when any file
 * matches `uiPaths`, `docs_only` when there are files and every one is
 * documentation (DOCS_PATHS).
 */
export function computeFacts(changedFiles: string[], uiPaths?: string[]): PipelineFacts {
  const ui = uiPaths && uiPaths.length > 0 ? uiPaths : DEFAULT_UI_PATHS;
  const files = changedFiles.filter((f) => f.trim().length > 0);
  return {
    ui_changed: files.some((f) => ui.some((g) => globMatches(g, f))),
    docs_only: files.length > 0 && files.every((f) => DOCS_PATHS.some((g) => globMatches(g, f))),
  };
}

/** Test files: what a change to only these (and docs and config) has nothing to deploy for. */
export const TEST_PATHS: readonly string[] = ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**"];

/** Configuration and CI files (see nonDeployableOnly). */
export const CONFIG_PATHS: readonly string[] = ["**/*.json", "**/*.yaml", "**/*.yml", "**/*.toml", "**/.github/**"];

/** Whether every changed file is documentation, a test, or configuration — a change with nothing to deploy. */
export function nonDeployableOnly(changedFiles: string[]): boolean {
  const globs = [...DOCS_PATHS, ...TEST_PATHS, ...CONFIG_PATHS];
  return changedFiles
    .filter((f) => f.trim().length > 0)
    .every((f) => globs.some((g) => globMatches(g, f)));
}

// ----------------------------------------------------------------------------
// Definition validation.
// ----------------------------------------------------------------------------

function validateCondition(c: unknown, field: string, errors: string[]): void {
  if (!isRecord(c)) {
    errors.push(`${field}: must be an object like {outcome?, fact?, not?}`);
    return;
  }
  if (c.outcome !== undefined && c.outcome !== "passed" && c.outcome !== "failed") {
    errors.push(`${field}.outcome: must be "passed" or "failed"`);
  }
  if (c.fact !== undefined && !PIPELINE_FACTS.includes(c.fact as PipelineFact)) {
    errors.push(`${field}.fact: must be one of ${PIPELINE_FACTS.join(", ")}`);
  }
  if (c.not !== undefined && typeof c.not !== "boolean") errors.push(`${field}.not: must be a boolean`);
}

function validateChecks(checks: unknown, kind: unknown, name: string, errors: string[]): void {
  if (!Array.isArray(checks)) {
    errors.push(`${name}.checks: must be an array of {command, paths?, timeoutMs?}`);
    return;
  }
  if (kind !== "validation" && checks.length > 0) errors.push(`${name}.checks: only a validation stage runs checks`);
  if (checks.length > MAX_STAGE_CHECKS) errors.push(`${name}.checks: at most ${MAX_STAGE_CHECKS} checks`);
  checks.forEach((c, i) => {
    const cf = `${name}.checks[${i}]`;
    if (!isRecord(c)) {
      errors.push(`${cf}: must be an object {command, paths?, timeoutMs?}`);
      return;
    }
    for (const key of Object.keys(c)) {
      if (key !== "command" && key !== "paths" && key !== "timeoutMs") errors.push(`${cf}.${key}: unknown check field`);
    }
    if (!isNonEmptyString(c.command) || c.command.trim().length === 0) errors.push(`${cf}.command: must be a non-empty string`);
    if (c.paths !== undefined && (!Array.isArray(c.paths) || c.paths.length === 0 || !c.paths.every(isNonEmptyString))) {
      errors.push(`${cf}.paths: must be a non-empty array of non-empty glob strings`);
    }
    if (
      c.timeoutMs !== undefined &&
      (!isPositiveInt(c.timeoutMs) || c.timeoutMs < MIN_CHECK_TIMEOUT_MS || c.timeoutMs > MAX_CHECK_TIMEOUT_MS)
    ) {
      errors.push(`${cf}.timeoutMs: must be an integer from ${MIN_CHECK_TIMEOUT_MS} to ${MAX_CHECK_TIMEOUT_MS}`);
    }
  });
}

/**
 * Whether `check` applies to a change of `changedFiles`: it has no paths, or
 * a file matches one of them. An empty list means the files are unknown, and
 * every check applies.
 */
export function checkApplies(check: PipelineStageCheck, changedFiles: string[]): boolean {
  const files = changedFiles.filter((f) => f.trim().length > 0);
  if (!check.paths || files.length === 0) return true;
  return files.some((f) => check.paths!.some((g) => globMatches(g, f)));
}

/**
 * Problems with a pipeline definition, each naming its field — empty when the
 * definition is valid. Checks the shape of every stage and edge, unique ids,
 * the "start" and "complete" stages, that every stage is reachable from start
 * and can reach complete, and that every cycle passes through a `loop` edge.
 */
export function validateDefinition(def: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(def)) return ["definition: must be an object {version: 1, stages: [...]}"];
  if (def.version !== 1) errors.push("version: must be 1");
  if (!Array.isArray(def.stages) || def.stages.length === 0) {
    errors.push("stages: must be a non-empty array");
    return errors;
  }
  if (def.reviewTunnel !== undefined) errors.push(...validateReviewTunnelConfig(def.reviewTunnel, "reviewTunnel"));

  const ids = new Set<string>();
  const stages: PipelineStageDef[] = [];
  def.stages.forEach((raw, i) => {
    const at = `stages[${i}]`;
    if (!isRecord(raw)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const name = isNonEmptyString(raw.id) ? `${at} ("${raw.id}")` : at;
    if (!isNonEmptyString(raw.id)) errors.push(`${at}.id: must be a non-empty string`);
    else if (ids.has(raw.id)) errors.push(`${name}.id: duplicate stage id "${raw.id}"`);
    else ids.add(raw.id);
    if (typeof raw.kind !== "string" || !STAGE_KINDS.has(raw.kind)) {
      errors.push(`${name}.kind: must be a registered stage kind (${registeredPipelineStageKinds().join(", ")})`);
    }
    if (!isNonEmptyString(raw.title)) errors.push(`${name}.title: must be a non-empty string`);
    if (typeof raw.required !== "boolean") errors.push(`${name}.required: must be a boolean`);
    if (raw.description !== undefined && typeof raw.description !== "string") {
      errors.push(`${name}.description: must be a string`);
    }
    if (raw.maxAttempts !== undefined && !isPositiveInt(raw.maxAttempts)) {
      errors.push(`${name}.maxAttempts: must be a positive integer`);
    }
    for (const flag of ["skippable", "outward", "requireOwnerGate"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") errors.push(`${name}.${flag}: must be a boolean`);
    }
    if (raw.ownerInput !== undefined && raw.ownerInput !== "issue_id") {
      errors.push(`${name}.ownerInput: must be "issue_id"`);
    }
    if (raw.minReviewers !== undefined && !isPositiveInt(raw.minReviewers)) {
      errors.push(`${name}.minReviewers: must be a positive integer`);
    }
    if (raw.blockOn !== undefined && raw.blockOn !== "high" && raw.blockOn !== "medium") {
      errors.push(`${name}.blockOn: must be "high" or "medium"`);
    }
    if (raw.uiPaths !== undefined && (!Array.isArray(raw.uiPaths) || !raw.uiPaths.every(isNonEmptyString))) {
      errors.push(`${name}.uiPaths: must be an array of non-empty glob strings`);
    }
    if (raw.minScreenshots !== undefined && !isPositiveInt(raw.minScreenshots)) {
      errors.push(`${name}.minScreenshots: must be a positive integer`);
    }
    if (raw.checks !== undefined) validateChecks(raw.checks, raw.kind, name, errors);
    if (raw.skipWhen !== undefined) {
      if (!Array.isArray(raw.skipWhen)) errors.push(`${name}.skipWhen: must be an array of fact conditions`);
      else {
        raw.skipWhen.forEach((c, j) => {
          validateCondition(c, `${name}.skipWhen[${j}]`, errors);
          if (isRecord(c) && c.fact === undefined) errors.push(`${name}.skipWhen[${j}].fact: is required`);
        });
        if ((raw.kind === "start" || raw.kind === "complete") && raw.skipWhen.length > 0) {
          errors.push(`${name}.skipWhen: the ${raw.kind} stage cannot be skipped`);
        }
      }
    }
    if (!Array.isArray(raw.edges)) {
      errors.push(`${name}.edges: must be an array`);
      return;
    }
    raw.edges.forEach((e, j) => {
      const ef = `${name}.edges[${j}]`;
      if (!isRecord(e)) {
        errors.push(`${ef}: must be an object {to, when?, loop?}`);
        return;
      }
      if (!isNonEmptyString(e.to)) errors.push(`${ef}.to: must be a stage id`);
      if (e.when !== undefined) validateCondition(e.when, `${ef}.when`, errors);
      if (e.loop !== undefined) {
        const max = isRecord(e.loop) ? e.loop.maxTraversals : undefined;
        if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_PIPELINE_LOOP_TRAVERSALS) {
          errors.push(`${ef}.loop.maxTraversals: must be an integer from 1 to ${MAX_PIPELINE_LOOP_TRAVERSALS}`);
        }
      }
    });
    stages.push(raw as unknown as PipelineStageDef);
  });
  if (errors.length > 0) return errors;

  const byId = new Map(stages.map((s) => [s.id, s]));
  const label = (s: PipelineStageDef) => `stages[${stages.indexOf(s)}] ("${s.id}")`;

  const start = byId.get(START_ID);
  if (!start) errors.push(`stages: a stage with id "${START_ID}" (kind start) is required`);
  else if (start.kind !== "start") errors.push(`${label(start)}.kind: the "${START_ID}" stage must be kind start`);
  const complete = byId.get(COMPLETE_ID);
  if (!complete) errors.push(`stages: a stage with id "${COMPLETE_ID}" (kind complete) is required`);
  else if (complete.kind !== "complete") {
    errors.push(`${label(complete)}.kind: the "${COMPLETE_ID}" stage must be kind complete`);
  }
  for (const s of stages) {
    if (s.kind === "start" && s.id !== START_ID) errors.push(`${label(s)}.kind: only the "${START_ID}" stage may be kind start`);
    if (s.kind === "complete" && s.id !== COMPLETE_ID) {
      errors.push(`${label(s)}.kind: only the "${COMPLETE_ID}" stage may be kind complete`);
    }
    s.edges.forEach((e, j) => {
      if (!byId.has(e.to)) errors.push(`${label(s)}.edges[${j}].to: unknown stage "${e.to}"`);
      else if (e.to === START_ID) errors.push(`${label(s)}.edges[${j}].to: no edge may lead back to "${START_ID}"`);
    });
    if (s.kind === "complete") {
      if (s.edges.length > 0) errors.push(`${label(s)}.edges: the complete stage has no outgoing edges`);
    } else if (!passedEdge(s)) {
      errors.push(`${label(s)}.edges: needs an edge taken when the stage passes (when absent or {outcome: "passed"}, no fact)`);
    }
  }
  if (errors.length > 0) return errors;

  // Reachability from start, and to complete.
  const reach = new Set<string>([START_ID]);
  const queue = [START_ID];
  while (queue.length > 0) {
    for (const e of byId.get(queue.shift()!)!.edges) {
      if (!reach.has(e.to)) {
        reach.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const s of stages) if (!reach.has(s.id)) errors.push(`${label(s)}: unreachable from "${START_ID}"`);
  const reachesComplete = new Set<string>([COMPLETE_ID]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of stages) {
      if (!reachesComplete.has(s.id) && s.edges.some((e) => reachesComplete.has(e.to))) {
        reachesComplete.add(s.id);
        grew = true;
      }
    }
  }
  for (const s of stages) {
    if (reach.has(s.id) && !reachesComplete.has(s.id)) errors.push(`${label(s)}: cannot reach "${COMPLETE_ID}"`);
  }

  // Every cycle must pass through a loop edge: the graph without them is acyclic.
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    color.set(id, 1);
    for (const e of byId.get(id)!.edges) {
      if (e.loop) continue;
      const c = color.get(e.to) ?? 0;
      if (c === 1) {
        const cycle = [...path.slice(path.indexOf(e.to)), e.to].join(" → ");
        errors.push(`edges: unbounded cycle ${cycle} — mark one of its edges with loop: {maxTraversals}`);
      } else if (c === 0) visit(e.to, [...path, e.to]);
    }
    color.set(id, 2);
  };
  for (const s of stages) if ((color.get(s.id) ?? 0) === 0) visit(s.id, [s.id]);

  return errors;
}

// ----------------------------------------------------------------------------
// Layered configuration.
// ----------------------------------------------------------------------------

const PATCH_KEYS: ReadonlySet<string> = new Set([
  "title",
  "required",
  "description",
  "maxAttempts",
  "edges",
  "skipWhen",
  "skippable",
  "outward",
  "requireOwnerGate",
  "ownerInput",
  "minReviewers",
  "blockOn",
  "uiPaths",
  "minScreenshots",
  "checks",
  "skip",
]);

/**
 * Applies configuration layers (lowest first, e.g. global then project) over
 * `base`. Per stage, a patch's fields replace the stage's (a later layer wins;
 * `edges` and other arrays are replaced wholesale). `skip: true` removes a
 * stage, redirecting every edge into it to its passed successor (transitively
 * through other skipped stages, keeping the edge's condition and loop bound);
 * `skip: false` in a later layer restores it. `add` inserts a stage after
 * another (its kind's registered `defaults` fill the fields it omits): that
 * stage's passed edge leads to the new one, whose passed edge leads to the
 * old target unless it declares edges. `enabled` is the last
 * layer's that sets it (default true), and so is `maxRounds`, which then
 * bounds every loop edge of the merged definition. `reviewTunnel` merges field
 * by field over the base's (see mergeReviewTunnelConfig) into the definition's
 * reviewTunnel. Throws PipelineConfigError when a layer
 * is malformed or the merged definition fails validateDefinition.
 */
export function resolvePipeline(
  base: PipelineDefinition,
  layers: Array<PipelineOverride | null | undefined>
): { enabled: boolean; definition: PipelineDefinition } {
  const stages: PipelineStageDef[] = clone(base.stages);
  const skipped = new Set<string>();
  let enabled = true;
  let maxRounds: number | undefined;
  const errors: string[] = [];
  const find = (id: string) => stages.find((s) => s.id === id);
  const tunnelLayers: Array<ReviewTunnelLayer | undefined> = [base.reviewTunnel];

  layers.forEach((layer, li) => {
    if (layer == null) return;
    const at = `layer[${li}]`;
    if (!isRecord(layer)) {
      errors.push(`${at}: must be an object {enabled?, stages?, add?, reviewTunnel?}`);
      return;
    }
    if (layer.enabled !== undefined) {
      if (typeof layer.enabled !== "boolean") errors.push(`${at}.enabled: must be a boolean`);
      else enabled = layer.enabled;
    }
    if (layer.reviewTunnel !== undefined) {
      const problems = validateReviewTunnelConfig(layer.reviewTunnel, `${at}.reviewTunnel`);
      if (problems.length > 0) errors.push(...problems);
      else tunnelLayers.push(layer.reviewTunnel as ReviewTunnelLayer);
    }
    if (layer.preset !== undefined && !(PIPELINE_PRESET_IDS as readonly unknown[]).includes(layer.preset)) {
      errors.push(`${at}.preset: must be one of ${PIPELINE_PRESET_IDS.join(", ")}`);
    }
    if (layer.spec !== undefined && (typeof layer.spec !== "string" || layer.spec.length > MAX_EVIDENCE_STRING)) {
      errors.push(`${at}.spec: must be a string of at most ${MAX_EVIDENCE_STRING} characters`);
    }
    if (layer.maxRounds !== undefined) {
      const n = layer.maxRounds;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PIPELINE_LOOP_TRAVERSALS) {
        errors.push(`${at}.maxRounds: must be an integer from 1 to ${MAX_PIPELINE_LOOP_TRAVERSALS}`);
      } else maxRounds = n;
    }

    if (layer.add !== undefined) {
      if (!Array.isArray(layer.add)) errors.push(`${at}.add: must be an array of {after, stage}`);
      else {
        layer.add.forEach((entry, ai) => {
          const af = `${at}.add[${ai}]`;
          if (!isRecord(entry) || !isRecord(entry.stage)) {
            errors.push(`${af}: must be {after: <stage id>, stage: {...}}`);
            return;
          }
          // The kind's registered defaults fill whatever the added stage leaves out.
          const declared = clone(entry.stage) as unknown as PipelineStageDef;
          const kindDefaults = typeof declared.kind === "string" ? STAGE_KINDS.get(declared.kind)?.defaults : undefined;
          const stage = { ...clone(kindDefaults ?? {}), ...declared } as PipelineStageDef;
          const anchor = isNonEmptyString(entry.after) ? find(entry.after) : undefined;
          if (!anchor) {
            errors.push(`${af}.after: unknown stage "${String(entry.after)}"`);
            return;
          }
          if (!isNonEmptyString(stage.id)) {
            errors.push(`${af}.stage.id: must be a non-empty string`);
            return;
          }
          if (find(stage.id)) {
            errors.push(`${af}.stage.id: stage "${stage.id}" already exists`);
            return;
          }
          if (stage.kind === "start" || stage.kind === "complete") {
            errors.push(`${af}.stage.kind: an added stage cannot be kind ${stage.kind}`);
            return;
          }
          const edge = passedEdge(anchor);
          if (!edge) {
            errors.push(`${af}.after: stage "${anchor.id}" has no passed edge to insert after`);
            return;
          }
          const oldTarget = edge.to;
          edge.to = stage.id;
          if (!Array.isArray(stage.edges) || stage.edges.length === 0) {
            stage.edges = [{ to: oldTarget, when: { outcome: "passed" } }];
          }
          stages.splice(stages.indexOf(anchor) + 1, 0, stage);
        });
      }
    }

    if (layer.stages !== undefined) {
      if (!isRecord(layer.stages)) {
        errors.push(`${at}.stages: must be an object keyed by stage id`);
        return;
      }
      for (const [id, patch] of Object.entries(layer.stages)) {
        const pf = `${at}.stages.${id}`;
        const stage = find(id);
        if (!stage) {
          errors.push(`${pf}: unknown stage "${id}"`);
          continue;
        }
        if (!isRecord(patch)) {
          errors.push(`${pf}: must be an object of stage fields`);
          continue;
        }
        for (const [key, value] of Object.entries(patch)) {
          if (!PATCH_KEYS.has(key)) {
            errors.push(`${pf}.${key}: ${key === "id" || key === "kind" ? "cannot be changed" : "unknown stage field"}`);
            continue;
          }
          if (value === undefined) continue;
          if (key === "skip") {
            if (typeof value !== "boolean") errors.push(`${pf}.skip: must be a boolean`);
            else if (value && (stage.kind === "start" || stage.kind === "complete")) {
              errors.push(`${pf}.skip: the ${stage.kind} stage cannot be skipped`);
            } else if (value) skipped.add(id);
            else skipped.delete(id);
            continue;
          }
          (stage as unknown as Record<string, unknown>)[key] = clone(value);
        }
      }
    }
  });
  if (errors.length > 0) throw new PipelineConfigError(errors);

  // Each skipped stage's successor: follow passed edges past other skipped stages.
  const successor = new Map<string, string>();
  for (const id of skipped) {
    const seen = new Set<string>([id]);
    let cur = find(id)!;
    let target: string | undefined;
    for (;;) {
      const edge = passedEdge(cur);
      if (!edge) {
        errors.push(`stages.${id}.skip: stage "${cur.id}" has no passed edge to route around it`);
        break;
      }
      if (!skipped.has(edge.to)) {
        target = edge.to;
        break;
      }
      if (seen.has(edge.to)) {
        errors.push(`stages.${id}.skip: skipped stages form a cycle through "${edge.to}"`);
        break;
      }
      seen.add(edge.to);
      const next = find(edge.to);
      if (!next) {
        target = edge.to;
        break;
      }
      cur = next;
    }
    if (target !== undefined) successor.set(id, target);
  }
  if (errors.length > 0) throw new PipelineConfigError(errors);

  const kept = stages.filter((s) => !skipped.has(s.id));
  for (const s of kept) {
    if (!Array.isArray(s.edges)) continue;
    for (const e of s.edges) {
      if (isRecord(e) && skipped.has(e.to)) e.to = successor.get(e.to)!;
      if (maxRounds !== undefined && isRecord(e) && isRecord(e.loop)) e.loop = { maxTraversals: maxRounds };
    }
  }
  const reviewTunnel = mergeReviewTunnelConfig(tunnelLayers);
  const definition: PipelineDefinition = { version: 1, stages: kept, ...(reviewTunnel ? { reviewTunnel } : {}) };
  const problems = validateDefinition(definition);
  if (problems.length > 0) throw new PipelineConfigError(problems);
  return { enabled, definition };
}

// ----------------------------------------------------------------------------
// Evidence.
// ----------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateFloorAsks(v: unknown, errors: string[]): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    errors.push("evidence.floorAsks (array of {askId, gate, question, answer?, status})");
    return;
  }
  v.forEach((a, i) => {
    if (!isRecord(a) || !isNonEmptyString(a.askId) || typeof a.gate !== "string" || typeof a.question !== "string" || typeof a.status !== "string") {
      errors.push(`evidence.floorAsks[${i}] ({askId, gate, question, answer?, status})`);
    }
  });
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
}

/** Size problems with `evidence`: over MAX_EVIDENCE_BYTES as JSON, or an array or string over its cap. */
function evidenceSizeErrors(evidence: unknown): string[] {
  if (evidence === undefined) return [];
  let json: string;
  try {
    json = JSON.stringify(evidence) ?? "";
  } catch {
    return ["evidence (must be plain JSON)"];
  }
  const errors: string[] = [];
  if (new TextEncoder().encode(json).length > MAX_EVIDENCE_BYTES) {
    errors.push(`evidence (at most ${MAX_EVIDENCE_BYTES / 1024} KB as JSON — summarize instead of pasting logs)`);
  }
  const walk = (v: unknown, at: string): void => {
    if (errors.length >= 10) return;
    if (typeof v === "string") {
      if (v.length > MAX_EVIDENCE_STRING) errors.push(`${at} (at most ${MAX_EVIDENCE_STRING} characters)`);
    } else if (Array.isArray(v)) {
      if (v.length > MAX_EVIDENCE_ARRAY) errors.push(`${at} (at most ${MAX_EVIDENCE_ARRAY} entries)`);
      v.slice(0, MAX_EVIDENCE_ARRAY).forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (isRecord(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    }
  };
  walk(evidence, "evidence");
  return errors;
}

/**
 * Missing or invalid evidence fields for advancing `stage`, as readable
 * descriptions of what is expected (e.g. "evidence.commands (non-empty array
 * of {command, exitCode, summary})") — empty when the evidence is acceptable.
 * Checks the size limits, then the stage kind's own rules (its registered
 * PipelineStageKindSpec).
 */
export function validateEvidence(stage: PipelineStageDef, evidence: unknown): string[] {
  const size = evidenceSizeErrors(evidence);
  if (size.length > 0) return size;
  const spec = STAGE_KINDS.get(stage.kind);
  if (!spec) return [`stage kind "${stage.kind}" is not registered`];
  return spec.validateEvidence(stage, isRecord(evidence) ? evidence : {});
}

/**
 * The outcome valid `evidence` gives `stage`, by its kind's registered rule:
 * validation fails on a non-zero exit code or an unmet criterion; review
 * fails on a finding at or above `blockOn` left open or marked wontfix;
 * deploy fails on a live sample that was not ok; the other built-in kinds
 * pass.
 */
export function evaluateOutcome(
  stage: PipelineStageDef,
  evidence: unknown
): { outcome: PipelineOutcome; reason: string } {
  const spec = STAGE_KINDS.get(stage.kind);
  if (!spec) return { outcome: "passed", reason: `${stage.kind} reached` };
  return spec.evaluateOutcome(stage, isRecord(evidence) ? evidence : {});
}

// ----------------------------------------------------------------------------
// Stage kinds — the registry.
//
// A stage kind is what a stage IS: the evidence it takes, how that evidence
// decides the outcome, and how the stage is described to a worker. Adding a
// stage type (say a "human_review" gate after code_review) takes three pieces:
//   1. here (shared): registerPipelineStageKind({kind, validateEvidence,
//      evaluateOutcome, describe, outward?, defaults?}) — after which
//      validateDefinition accepts stages of the kind and an override's `add`
//      can insert one (its `defaults` fill the fields the stage leaves out);
//   2. the collector (packages/collector/src/pipeline/runners.ts):
//      registerPipelineStageRunner(kind, {prepareEvidence?, onEnter?,
//      stopReason?}) when the server must complete or check the evidence
//      itself, react to the stage being entered, or say why a Stop there
//      should go to the owner — a kind with no runner takes the worker's
//      evidence as is;
//   3. the console (packages/web/src/components/pipelineRenderers.tsx):
//      registerStageEvidenceRenderer(kind, Component) to render its evidence —
//      without one the console shows the evidence as JSON.
// Both sides must register the kind: the collector to accept it, the web
// bundle to describe it.
// ----------------------------------------------------------------------------

/** The rules of one stage kind. `evidence` is always an object (a non-object reads as {}). */
export interface PipelineStageKindSpec {
  kind: string;
  /** Missing or invalid fields, each naming what is expected; empty when acceptable. */
  validateEvidence: (stage: PipelineStageDef, evidence: Record<string, unknown>) => string[];
  /** The outcome evidence that passed validateEvidence gives the stage. */
  evaluateOutcome: (stage: PipelineStageDef, evidence: Record<string, unknown>) => { outcome: PipelineOutcome; reason: string };
  /** The evidence the stage takes, in a phrase for briefs and status ("" when it takes none). */
  describe: (stage: PipelineStageDef) => string;
  /** Stages of the kind act outside the worktree (through the safety floor) unless the stage sets `outward`. */
  outward?: boolean;
  /** Fields a stage of the kind gets when it omits them (an added stage's title, required, description, …). */
  defaults?: Partial<PipelineStageDef>;
}

const STAGE_KINDS = new Map<string, PipelineStageKindSpec>();
const BUILTIN_KIND_SET: ReadonlySet<string> = new Set(BUILTIN_PIPELINE_STAGE_KINDS);

/**
 * Registers a stage kind (see the registry notes above). Registering a kind
 * again replaces it; a built-in kind can't be replaced once registered.
 */
export function registerPipelineStageKind(spec: PipelineStageKindSpec): void {
  if (!isNonEmptyString(spec.kind)) throw new Error("a stage kind needs a non-empty name");
  if (BUILTIN_KIND_SET.has(spec.kind) && STAGE_KINDS.has(spec.kind)) {
    throw new Error(`"${spec.kind}" is a built-in stage kind and can't be replaced`);
  }
  STAGE_KINDS.set(spec.kind, spec);
}

/** The registered spec of `kind`, or undefined. */
export function getPipelineStageKind(kind: string): PipelineStageKindSpec | undefined {
  return STAGE_KINDS.get(kind);
}

/** Every registered kind, built-ins first. */
export function registeredPipelineStageKinds(): string[] {
  return [...STAGE_KINDS.keys()];
}

/** Whether `stage` acts through the safety floor: its own `outward`, else its kind's. */
export function isOutwardStage(stage: PipelineStageDef): boolean {
  return stage.outward ?? STAGE_KINDS.get(stage.kind)?.outward ?? false;
}

const SEVERITY_RANK: Record<PipelineReviewFinding["severity"], number> = { low: 0, medium: 1, high: 2 };

const noEvidence = (): string[] => [];

registerPipelineStageKind({
  kind: "start",
  validateEvidence: noEvidence,
  evaluateOutcome: () => ({ outcome: "passed", reason: "start reached" }),
  describe: () => "",
  defaults: { title: "Start", required: false, description: "The run has started." },
});

registerPipelineStageKind({
  kind: "coding",
  validateEvidence: (_stage, ev) => {
    const errors: string[] = [];
    if (!isNonEmptyString(ev.summary)) errors.push("evidence.summary (non-empty string describing the change)");
    if (ev.commits !== undefined && !isStringArray(ev.commits)) errors.push("evidence.commits (array of commit ids)");
    if (ev.changedFiles !== undefined && !isStringArray(ev.changedFiles)) {
      errors.push("evidence.changedFiles (array of repo-relative paths)");
    }
    return errors;
  },
  evaluateOutcome: () => ({ outcome: "passed", reason: "coding reported done" }),
  describe: () => "{summary, commits?, changedFiles?}",
  defaults: { title: "Coding", required: true, description: "The change is implemented." },
});

/** How much of a failed criterion's or check's output its failure reason carries, from the end. */
const FAILED_OUTPUT_TAIL = 1200;

/**
 * The tail of a failed command's output, as a suffix to its failure reason:
 * the end is where a test runner prints what failed, so a failure never
 * reads without what the command printed.
 */
function lastOutput(output: string): string {
  const text = output.trim();
  if (!text) return "; it printed nothing";
  return `; last output:\n${text.length > FAILED_OUTPUT_TAIL ? `…${text.slice(-FAILED_OUTPUT_TAIL)}` : text}`;
}

/**
 * Whether a failed command failed only as it does on the base commit: the
 * baseline run exited with the same code, the command names the tests that
 * failed, and each of them also failed on the base.
 */
function failsOnlyAsOnBase(c: ValidationCommand): boolean {
  const failing = Array.isArray(c.failing) ? c.failing : [];
  const onBase = new Set(Array.isArray(c.baseline?.failing) ? c.baseline.failing : []);
  return !!c.baseline && c.baseline.exitCode === c.exitCode && failing.length > 0 && failing.every((t) => onBase.has(t));
}

/** The failing tests a command names that didn't fail on its baseline, as a suffix to its failure reason. */
function branchOnlyFailures(c: ValidationCommand): string {
  if (!c.baseline || !Array.isArray(c.failing)) return "";
  const onBase = new Set(Array.isArray(c.baseline.failing) ? c.baseline.failing : []);
  const only = c.failing.filter((t) => !onBase.has(t));
  return only.length > 0 ? ` (failing only on the branch: ${only.slice(0, 5).join(", ")}${only.length > 5 ? ", …" : ""})` : "";
}

registerPipelineStageKind({
  kind: "validation",
  validateEvidence: (_stage, ev) => {
    const errors: string[] = [];
    if (!Array.isArray(ev.commands) || ev.commands.length === 0) {
      errors.push("evidence.commands (non-empty array of {command, exitCode, summary})");
    } else {
      ev.commands.forEach((c, i) => {
        if (!isRecord(c)) {
          errors.push(`evidence.commands[${i}] ({command, exitCode, summary})`);
          return;
        }
        if (!isNonEmptyString(c.command)) errors.push(`evidence.commands[${i}].command (non-empty string)`);
        if (typeof c.exitCode !== "number" || !Number.isInteger(c.exitCode)) {
          errors.push(`evidence.commands[${i}].exitCode (integer)`);
        }
        if (typeof c.summary !== "string") errors.push(`evidence.commands[${i}].summary (string)`);
        if (c.failing !== undefined && !isStringArray(c.failing)) {
          errors.push(`evidence.commands[${i}].failing (array of the failing test names)`);
        }
        if (c.baseline !== undefined) {
          const b = c.baseline;
          if (
            !isRecord(b) ||
            typeof b.commit !== "string" ||
            !/^[0-9a-f]{7,40}$/i.test(b.commit) ||
            typeof b.exitCode !== "number" ||
            !Number.isInteger(b.exitCode) ||
            !isStringArray(b.failing)
          ) {
            errors.push(`evidence.commands[${i}].baseline ({commit: the base commit's sha, exitCode, failing: [test names]} from the base commit)`);
          }
        }
      });
    }
    if (ev.criterion !== undefined) {
      const c = ev.criterion;
      if (!isRecord(c) || typeof c.command !== "string" || typeof c.met !== "boolean" || typeof c.output !== "string") {
        errors.push("evidence.criterion ({command, met: boolean, output})");
      }
    }
    if (ev.checks !== undefined) {
      if (!Array.isArray(ev.checks)) errors.push("evidence.checks (array of {command, met: boolean, output, skipped?})");
      else {
        ev.checks.forEach((c, i) => {
          if (
            !isRecord(c) ||
            typeof c.command !== "string" ||
            typeof c.met !== "boolean" ||
            typeof c.output !== "string" ||
            (c.skipped !== undefined && typeof c.skipped !== "boolean")
          ) {
            errors.push(`evidence.checks[${i}] ({command, met: boolean, output, skipped?})`);
          }
        });
      }
    }
    return errors;
  },
  evaluateOutcome: (_stage, ev) => {
    const v = ev as unknown as ValidationEvidence;
    const commands = Array.isArray(v.commands) ? v.commands : [];
    const checks = Array.isArray(v.checks) ? v.checks : [];
    const onBase = commands.filter((c) => c.exitCode !== 0 && failsOnlyAsOnBase(c));
    const problems = commands
      .filter((c) => c.exitCode !== 0 && !onBase.includes(c))
      .map((c) => `\`${c.command}\` exited ${c.exitCode}${branchOnlyFailures(c)}`);
    if (v.criterion && !v.criterion.met) {
      problems.push(`acceptance criterion not met (\`${v.criterion.command}\`)${lastOutput(v.criterion.output)}`);
    }
    for (const c of checks) if (c.met === false) problems.push(`validation check failed (\`${c.command}\`)${lastOutput(c.output)}`);
    if (problems.length > 0) return { outcome: "failed", reason: problems.join("; ") };
    const ran = checks.filter((c) => !c.skipped).length;
    const base = onBase.map((c) => `; \`${c.command}\` exited ${c.exitCode} failing only what also fails on ${c.baseline!.commit}`).join("");
    return {
      outcome: "passed",
      reason: `${commands.length - onBase.length} command(s) exited 0${base}${v.criterion ? "; acceptance criterion met" : ""}${ran > 0 ? `; ${ran} check(s) passed` : ""}`,
    };
  },
  describe: () =>
    "{commands: [{command, exitCode, summary}]} — every command you ran, with its real exit code (the server runs the approved acceptance criterion and the stage's checks itself); a command whose only failing tests also fail on the base commit passes when it adds failing: [those tests] and baseline: {commit, exitCode, failing} from the same command run to completion (no bail) on the base",
  defaults: { title: "Validation", required: true, description: "Build and tests ran green." },
});

/** The review evidence's findings at or above the stage's blockOn severity that are still open or marked wontfix. */
function blockingReviewFindings(stage: PipelineStageDef, evidence: ReviewEvidence): PipelineReviewFinding[] {
  const floor = SEVERITY_RANK[stage.blockOn ?? DEFAULT_BLOCK_ON];
  const reviewers = Array.isArray(evidence.reviewers) ? evidence.reviewers : [];
  return reviewers.flatMap((rv) =>
    (Array.isArray(rv.findings) ? rv.findings : []).filter(
      (f) => (f.status === "open" || f.status === "wontfix") && SEVERITY_RANK[f.severity] >= floor
    )
  );
}

/**
 * Whether review evidence blocks only on findings the worker marked wontfix
 * (at least one, none left open): looping back to coding can't resolve those,
 * so the run holds at review for the owner to waive it or send the worker back.
 */
export function reviewBlockedOnlyByWontfix(stage: PipelineStageDef, evidence: unknown): boolean {
  if (stage.kind !== "review" || !isRecord(evidence)) return false;
  const blocking = blockingReviewFindings(stage, evidence as unknown as ReviewEvidence);
  return blocking.length > 0 && blocking.every((f) => f.status === "wontfix");
}

/**
 * The review evidence's blocking findings (at or above the stage's blockOn
 * severity, not fixed), each with the reviewer who raised it — what a
 * wontfix-accepted waiver must find all marked wontfix.
 */
export function blockingReviewFindingsByReviewer(
  stage: PipelineStageDef,
  evidence: unknown
): Array<PipelineWontfixFinding & { status: PipelineReviewFinding["status"] }> {
  if (stage.kind !== "review" || !isRecord(evidence)) return [];
  const reviewers = Array.isArray(evidence.reviewers) ? (evidence.reviewers as ReviewEvidence["reviewers"]) : [];
  return reviewers.filter(isRecord).flatMap((rv) =>
    blockingReviewFindings(stage, { reviewers: [rv] }).map((f) => ({
      reviewer: typeof rv.name === "string" ? rv.name : "",
      severity: f.severity,
      title: f.title,
      status: f.status,
      ...(typeof f.note === "string" && f.note.trim() ? { note: f.note.trim() } : {}),
    }))
  );
}

registerPipelineStageKind({
  kind: "review",
  validateEvidence: (stage, ev) => {
    const errors: string[] = [];
    const min = stage.minReviewers ?? DEFAULT_MIN_REVIEWERS;
    if (!Array.isArray(ev.reviewers)) {
      return [`evidence.reviewers (array of at least ${min} {name, findings: [{severity, title, status}]})`];
    }
    if (ev.reviewers.length < min) {
      errors.push(`evidence.reviewers (at least ${min} independent reviewers; got ${ev.reviewers.length})`);
    }
    const names = new Set<string>();
    ev.reviewers.forEach((r, i) => {
      if (!isRecord(r)) {
        errors.push(`evidence.reviewers[${i}] ({name, findings})`);
        return;
      }
      if (!isNonEmptyString(r.name)) errors.push(`evidence.reviewers[${i}].name (non-empty string)`);
      else if (names.has(r.name)) errors.push(`evidence.reviewers[${i}].name (reviewer names must be distinct)`);
      else names.add(r.name);
      if (!Array.isArray(r.findings)) {
        errors.push(`evidence.reviewers[${i}].findings (array of {severity, title, status}; empty when none)`);
        return;
      }
      r.findings.forEach((f, j) => {
        const ff = `evidence.reviewers[${i}].findings[${j}]`;
        if (!isRecord(f)) {
          errors.push(`${ff} ({severity, title, status})`);
          return;
        }
        if (f.severity !== "high" && f.severity !== "medium" && f.severity !== "low") {
          errors.push(`${ff}.severity ("high", "medium" or "low")`);
        }
        if (!isNonEmptyString(f.title)) errors.push(`${ff}.title (non-empty string)`);
        if (f.status !== "open" && f.status !== "fixed" && f.status !== "wontfix") {
          errors.push(`${ff}.status ("open", "fixed" or "wontfix")`);
        }
        if (f.note !== undefined && typeof f.note !== "string") errors.push(`${ff}.note (a string, when given)`);
      });
    });
    return errors;
  },
  evaluateOutcome: (stage, ev) => {
    const r = ev as unknown as ReviewEvidence;
    const reviewers = Array.isArray(r.reviewers) ? r.reviewers : [];
    const floor = SEVERITY_RANK[stage.blockOn ?? DEFAULT_BLOCK_ON];
    const label = floor === SEVERITY_RANK.high ? "High" : "High/Medium";
    // A blocking finding the worker marked wontfix still blocks: the owner, or Persona accepting it, waives it.
    const blocking = blockingReviewFindings(stage, r);
    if (blocking.length > 0) {
      return {
        outcome: "failed",
        reason: `${blocking.length} unresolved ${label} finding(s): ${blocking.map((f) => `[${f.severity}${f.status === "wontfix" ? ", wontfix" : ""}] ${f.title}`).join("; ")}`,
      };
    }
    return { outcome: "passed", reason: `no unresolved ${label} findings from ${reviewers.length} reviewer(s)` };
  },
  describe: (s) =>
    `{reviewers: [{name, findings: [{severity: high|medium|low, title, status: open|fixed|wontfix, note?}]}]} (note: for wontfix, why it is out of scope or where it is tracked) from at least ${s.minReviewers ?? DEFAULT_MIN_REVIEWERS} independent reviewers; a ${(s.blockOn ?? DEFAULT_BLOCK_ON) === "high" ? "High" : "High or Medium"} finding left open fails the stage, and one marked wontfix holds the run at review for the owner (or Persona, accepting the wontfix) to waive`,
  defaults: { title: "Review", required: true, description: "Independent reviewers found nothing blocking." },
});

registerPipelineStageKind({
  kind: "deploy",
  outward: true,
  validateEvidence: (_stage, ev) => {
    const errors: string[] = [];
    if (!isNonEmptyString(ev.account)) errors.push("evidence.account (the account deployed to)");
    if (ev.region !== undefined && typeof ev.region !== "string") errors.push("evidence.region (string)");
    if (!isStringArray(ev.stacks) || ev.stacks.length === 0 || !ev.stacks.every(isNonEmptyString)) {
      errors.push("evidence.stacks (non-empty array of deployed stack names)");
    }
    if (!Array.isArray(ev.liveSamples) || ev.liveSamples.length === 0) {
      errors.push("evidence.liveSamples (non-empty array of {request, response, ok})");
    } else {
      ev.liveSamples.forEach((s, i) => {
        if (!isRecord(s) || typeof s.request !== "string" || typeof s.response !== "string" || typeof s.ok !== "boolean") {
          errors.push(`evidence.liveSamples[${i}] ({request, response, ok: boolean})`);
        }
      });
    }
    validateFloorAsks(ev.floorAsks, errors);
    return errors;
  },
  evaluateOutcome: (_stage, ev) => {
    const d = ev as unknown as DeployEvidence;
    const samples = Array.isArray(d.liveSamples) ? d.liveSamples : [];
    const bad = samples.filter((s) => s.ok === false);
    if (bad.length > 0) {
      return {
        outcome: "failed",
        reason: `${bad.length} of ${samples.length} live sample(s) failed: ${bad.map((s) => s.request).join("; ")}`,
      };
    }
    return { outcome: "passed", reason: `${samples.length} live sample(s) ok` };
  },
  describe: () => "{account, region?, stacks: [..], liveSamples: [{request, response, ok}]} — a sample with ok false fails the stage",
  defaults: { title: "Deploy", required: true, description: "The change is deployed and live-validated." },
});

/** Live-check evidence: the change running on an isolated local instance, and the requests it answered. */
export interface LiveCheckEvidence {
  /** What ran the change, e.g. "isolated collector on :17801". */
  environment: string;
  /** How it was kept apart from the shared instance: its own ports and a private tmux socket. */
  isolation?: { ports?: number[]; tmuxSocket?: string };
  liveSamples: Array<{ request: string; response: string; ok: boolean }>;
}

registerPipelineStageKind({
  kind: "live_check",
  validateEvidence: (_stage, ev) => {
    const errors: string[] = [];
    if (!isNonEmptyString(ev.environment)) errors.push("evidence.environment (what ran the change, e.g. an isolated collector and its port)");
    if (ev.isolation !== undefined) {
      const iso = ev.isolation;
      if (
        !isRecord(iso) ||
        (iso.ports !== undefined && (!Array.isArray(iso.ports) || !iso.ports.every((p) => Number.isInteger(p) && (p as number) > 0))) ||
        (iso.tmuxSocket !== undefined && typeof iso.tmuxSocket !== "string")
      ) {
        errors.push("evidence.isolation ({ports?: [port numbers], tmuxSocket?: path})");
      }
    }
    if (!Array.isArray(ev.liveSamples) || ev.liveSamples.length === 0) {
      errors.push("evidence.liveSamples (non-empty array of {request, response, ok})");
    } else {
      ev.liveSamples.forEach((s, i) => {
        if (!isRecord(s) || typeof s.request !== "string" || typeof s.response !== "string" || typeof s.ok !== "boolean") {
          errors.push(`evidence.liveSamples[${i}] ({request, response, ok: boolean})`);
        }
      });
    }
    return errors;
  },
  evaluateOutcome: (_stage, ev) => {
    const samples = Array.isArray(ev.liveSamples) ? (ev.liveSamples as LiveCheckEvidence["liveSamples"]) : [];
    const bad = samples.filter((s) => s.ok === false);
    if (bad.length > 0) {
      return {
        outcome: "failed",
        reason: `${bad.length} of ${samples.length} live sample(s) failed: ${bad.map((s) => s.request).join("; ")}`,
      };
    }
    return { outcome: "passed", reason: `${samples.length} live sample(s) ok on ${String(ev.environment)}` };
  },
  describe: () =>
    "{environment, isolation?: {ports, tmuxSocket}, liveSamples: [{request, response, ok}]} — the change running on an isolated instance (its own ports, env -i, a private tmux socket via -S; never the shared tmux server or the live collector); a sample with ok false fails the stage",
  defaults: {
    title: "Live check",
    required: true,
    description: "The change runs on an isolated instance and representative live requests behave as expected.",
  },
});

registerPipelineStageKind({
  kind: "screenshot",
  validateEvidence: (stage, ev) => {
    const errors: string[] = [];
    const min = stage.minScreenshots ?? DEFAULT_MIN_SCREENSHOTS;
    if (!Array.isArray(ev.screenshots) || ev.screenshots.length < min) {
      return [`evidence.screenshots (array of at least ${min} {path, caption?} with absolute .png paths)`];
    }
    ev.screenshots.forEach((s, i) => {
      if (!isRecord(s) || !isNonEmptyString(s.path)) {
        errors.push(`evidence.screenshots[${i}].path (absolute path to a .png)`);
        return;
      }
      if (s.caption !== undefined && typeof s.caption !== "string") errors.push(`evidence.screenshots[${i}].caption (string)`);
      for (const dim of ["width", "height"] as const) {
        if (s[dim] !== undefined && typeof s[dim] !== "number") errors.push(`evidence.screenshots[${i}].${dim} (number)`);
      }
    });
    return errors;
  },
  evaluateOutcome: (_stage, ev) => {
    const n = Array.isArray(ev.screenshots) ? ev.screenshots.length : 0;
    return { outcome: "passed", reason: `${n} screenshot(s) recorded` };
  },
  describe: (s) =>
    `{screenshots: [{path, caption?}]} with at least ${s.minScreenshots ?? DEFAULT_MIN_SCREENSHOTS} absolute .png path(s)`,
  defaults: { title: "Screenshots", required: true, description: "Screenshots show the change working." },
});

registerPipelineStageKind({
  kind: CODE_REVIEW_STAGE_KIND,
  outward: true,
  validateEvidence: (stage, ev) => {
    const errors: string[] = [];
    // A stage that needs the owner's issue id (ownerInput, set where the project's review tool attaches one)
    // refuses a worker's report without it; the review gate's own record of the review it opened may lack one.
    if (stage.ownerInput === "issue_id" && ev.source !== "review_gate" && !isNonEmptyString(ev.issueId)) {
      errors.push("evidence.issueId (the issue id the owner gave for the code review)");
    }
    if (ev.issueId !== undefined && typeof ev.issueId !== "string") errors.push("evidence.issueId (string)");
    if (!isNonEmptyString(ev.reviewId) && !isNonEmptyString(ev.url)) errors.push("evidence.reviewId or evidence.url (the code review)");
    if (ev.reviewId !== undefined && typeof ev.reviewId !== "string") errors.push("evidence.reviewId (string)");
    if (ev.url !== undefined && !isHttpUrl(ev.url)) errors.push("evidence.url (an http:// or https:// URL)");
    validateFloorAsks(ev.floorAsks, errors);
    return errors;
  },
  evaluateOutcome: (_stage, ev) => ({
    outcome: "passed",
    reason: `code review ${String(ev.reviewId ?? ev.url ?? "(unnamed)")} recorded`,
  }),
  describe: (s) => (s.ownerInput === "issue_id" ? "{reviewId or url, issueId}" : "{reviewId or url, issueId?}"),
  defaults: { title: "Code review", required: true, description: "A code review is opened." },
});

registerPipelineStageKind({
  kind: HUMAN_REVIEW_STAGE_KIND,
  validateEvidence: (_stage, ev) => humanReviewStageKind.validateEvidence(ev),
  evaluateOutcome: (_stage, ev) => {
    const outcome = humanReviewStageKind.evaluateOutcome(ev);
    return {
      outcome,
      reason: outcome === "passed" ? `review ${String(ev.packetId)} approved` : `changes requested on review ${String(ev.packetId)}`,
    };
  },
  describe: () => "{packetId, decision} — recorded when the owner decides the review packet in the Review tab",
  defaults: { title: humanReviewStageKind.title, required: true, description: humanReviewStageKind.description },
});

registerPipelineStageKind({
  kind: "complete",
  validateEvidence: noEvidence,
  evaluateOutcome: () => ({ outcome: "passed", reason: "complete reached" }),
  describe: () => "",
  defaults: { title: "Complete", required: false, description: "Every stage is done." },
});

// ----------------------------------------------------------------------------
// Transitions.
// ----------------------------------------------------------------------------

export type PipelineTransition =
  | { kind: "move"; to: string; edge: PipelineEdge; skipped: Array<{ stageId: string; reason: string }> }
  | { kind: "exhausted"; reason: string };

/**
 * From `state.currentStage` with `outcome`: takes the first edge whose
 * condition matches. A loop edge from X to Y is refused (exhausted) once prior
 * attempts at X that moved to Y reach its maxTraversals. Then, while the
 * target is a stage whose skipWhen matches the facts (never start or
 * complete), records the skip and moves along that stage's passed edge.
 */
export function planTransition(
  def: PipelineDefinition,
  state: {
    currentStage: string;
    attempts: Array<{ stageId: string; nextStage?: string | null; status: string }>;
    facts: PipelineFacts;
  },
  outcome: PipelineOutcome
): PipelineTransition {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const stage = byId.get(state.currentStage);
  if (!stage) return { kind: "exhausted", reason: `unknown stage "${state.currentStage}"` };
  const edge = stage.edges.find((e) => conditionMatches(e.when ?? {}, outcome, state.facts));
  if (!edge) return { kind: "exhausted", reason: `${stage.id} has no transition for outcome ${outcome}` };

  const skipped: Array<{ stageId: string; reason: string }> = [];
  let to = edge.to;
  const seen = new Set<string>([stage.id]);
  for (;;) {
    const target = byId.get(to);
    if (!target) return { kind: "exhausted", reason: `${stage.id} leads to unknown stage "${to}"` };
    if (target.kind === "start" || target.kind === "complete") break;
    const match = (target.skipWhen ?? []).find((c) => conditionMatches(c, null, state.facts));
    if (!match) break;
    if (seen.has(to)) return { kind: "exhausted", reason: `auto-skip from ${stage.id} cycles through ${to}` };
    seen.add(to);
    skipped.push({ stageId: to, reason: `auto-skipped: ${describeCondition(match)}` });
    const next = target.edges.find((e) => conditionMatches(e.when ?? {}, "passed", state.facts));
    if (!next) return { kind: "exhausted", reason: `skipped stage ${to} has no passed edge` };
    to = next.to;
  }

  if (edge.loop) {
    const used = loopTraversals(state.attempts, stage.id, edge.to, to);
    if (used >= edge.loop.maxTraversals) {
      return {
        kind: "exhausted",
        reason: `${stage.id} → ${edge.to} loop did not converge after ${edge.loop.maxTraversals} rounds`,
      };
    }
  }
  return { kind: "move", to, edge, skipped };
}

/**
 * Prior traversals of the edge `from` → `to`: attempts at `from` that moved to
 * `to`, or to `landed` — where the edge ends up once stages that auto-skip
 * are passed through.
 */
function loopTraversals(
  attempts: Array<{ stageId: string; nextStage?: string | null }>,
  from: string,
  to: string,
  landed: string
): number {
  return attempts.filter((a) => a.stageId === from && (a.nextStage === to || a.nextStage === landed)).length;
}

/** Where an edge into `to` ends up under `facts`: `to`, or past every stage there that auto-skips. */
function landingStage(def: PipelineDefinition, to: string, facts: PipelineFacts): string {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const seen = new Set<string>();
  let at = to;
  for (;;) {
    const target = byId.get(at);
    if (!target || target.kind === "start" || target.kind === "complete" || seen.has(at)) return at;
    if (!(target.skipWhen ?? []).some((c) => conditionMatches(c, null, facts))) return at;
    seen.add(at);
    const next = target.edges.find((e) => conditionMatches(e.when ?? {}, "passed", facts));
    if (!next) return at;
    at = next.to;
  }
}

/**
 * Prior traversals of each loop edge in `def`, for status views — counted as
 * planTransition counts them under `facts` (the run's), so an edge whose
 * target auto-skips also counts the attempts that landed past it.
 */
export function loopBudget(
  def: PipelineDefinition,
  attempts: Array<{ stageId: string; nextStage?: string | null }>,
  facts: PipelineFacts = {}
): Array<{ from: string; to: string; used: number; max: number }> {
  const out: Array<{ from: string; to: string; used: number; max: number }> = [];
  for (const s of def.stages) {
    for (const e of s.edges) {
      if (!e.loop) continue;
      const used = loopTraversals(attempts, s.id, e.to, landingStage(def, e.to, facts));
      out.push({ from: s.id, to: e.to, used, max: e.loop.maxTraversals });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Run views.
// ----------------------------------------------------------------------------

export type PipelineStageState = "pending" | "current" | "passed" | "failed" | "skipped" | "waived";

type RunView = { currentStage: string; status: PipelineRunStatus; attempts: PipelineStageAttempt[] };

/** Stages reachable from `from` along non-loop edges, excluding `from` — the stages still ahead. */
function stagesAhead(def: PipelineDefinition, from: string): Set<string> {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const ahead = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const s = byId.get(queue.shift()!);
    if (!s) continue;
    for (const e of s.edges) {
      if (e.loop || ahead.has(e.to) || e.to === from) continue;
      ahead.add(e.to);
      queue.push(e.to);
    }
  }
  return ahead;
}

function latestAttempts(attempts: PipelineStageAttempt[]): Map<string, PipelineStageAttempt> {
  const ordered = [...attempts].sort((a, b) =>
    a.createdAt === b.createdAt ? a.attempt - b.attempt : a.createdAt < b.createdAt ? -1 : 1
  );
  const latest = new Map<string, PipelineStageAttempt>();
  for (const a of ordered) latest.set(a.stageId, a);
  return latest;
}

/**
 * Each stage's state in `run`: the current stage is "current" (the complete
 * stage of a complete run is "passed"); stages still ahead of it are
 * "pending" even when an earlier round passed them; any other stage shows its
 * latest attempt's status, or "pending" when never attempted.
 */
export function stageStates(
  def: PipelineDefinition,
  run: RunView
): Record<string, { state: PipelineStageState; attempts: number }> {
  const latest = latestAttempts(run.attempts);
  const ahead = run.status === "complete" ? new Set<string>() : stagesAhead(def, run.currentStage);
  const out: Record<string, { state: PipelineStageState; attempts: number }> = {};
  for (const s of def.stages) {
    const attempts = run.attempts.filter((a) => a.stageId === s.id).length;
    let state: PipelineStageState;
    if (s.id === run.currentStage) {
      state = run.status === "complete" ? "passed" : "current";
    } else if (ahead.has(s.id)) {
      state = "pending";
    } else {
      state = latest.get(s.id)?.status ?? "pending";
    }
    out[s.id] = { state, attempts };
  }
  return out;
}

/**
 * Required stage ids not yet passed, skipped or waived in `run` — the current
 * stage and every required stage still ahead of it count as not done. The
 * complete stage counts as done when the run is complete.
 */
export function incompleteRequiredStages(def: PipelineDefinition, run: RunView): string[] {
  const states = stageStates(def, run);
  return def.stages
    .filter((s) => s.required)
    .filter((s) => {
      if (s.kind === "complete") return run.status !== "complete";
      const st = states[s.id]!.state;
      return st !== "passed" && st !== "skipped" && st !== "waived";
    })
    .map((s) => s.id);
}

/** A stage's exit criteria and the evidence that advances it (its kind's describe), in one paragraph. */
export function describeStage(stage: PipelineStageDef): string {
  const spec = STAGE_KINDS.get(stage.kind);
  const description = stage.description ?? spec?.defaults?.description ?? `A ${stage.kind} stage.`;
  const parts = [`${stage.title} (${stage.id}): ${description}`];
  const shape = spec ? spec.describe(stage) : "";
  if (shape) parts.push(`Evidence: ${shape}.`);
  if (isOutwardStage(stage)) {
    parts.push(
      stage.requireOwnerGate
        ? "Runs through the safety floor, and needs an owner-approved floor ask during the stage."
        : "Runs through the safety floor; the pipeline only sequences it."
    );
  }
  if (stage.ownerInput === "issue_id") parts.push("Needs an issue id from the owner — ask_human for it if you don't have one.");
  if (stage.skipWhen && stage.skipWhen.length > 0) {
    parts.push(`Skipped automatically when ${stage.skipWhen.map(describeCondition).join(" or ")}.`);
  }
  if (stage.skippable) parts.push("May be skipped with {skip: {reason}}.");
  if (!stage.required) parts.push("Optional.");
  return parts.join(" ");
}
