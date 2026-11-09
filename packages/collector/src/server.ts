import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { CollectorSlot } from "@standup/shared/topology";
import { basename, dirname, join, resolve, sep } from "path";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { homedir } from "os";
import { mkdir, readdir, writeFile, rm } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { DocLimits, Store } from "@standup/store";
import { tokenMatches } from "@standup/shared/write-token";
import {
  OWNER_TOKEN_HEADER,
  PERSONA_USER_HEADER,
  USER_CHANNEL_HEADER,
  standupDataDir,
  userChannelTokenMatches,
} from "@standup/shared/owner-token";
import { PERSONA_TOKEN_HEADER, mountPersonaRoutes } from "./persona/routes.js";
import { reviewScratchDirFor } from "./review/media.js";
import { mountJobBudgetRoutes, personaUsageFor } from "./persona/budget-routes.js";
import { launchForWorkerToken, mountReviewRoutes } from "./review/routes.js";
import { mountShareRoutes } from "./share/routes.js";
import { CORS_ORIGINS, callerGuard } from "./caller-guard.js";
import { mountDocsRoutes } from "./docs/routes.js";
import { docAnswerer, type DocAnswerer } from "./docs/answer.js";
import { DocCommentAgent } from "./docs/comments.js";
import { DocsSemanticIndex } from "./docs/semantic.js";
import type { ReviewPipelinePort } from "./review/pipeline-port.js";
import { pipelineReviewPort } from "./review/pipeline-adapter.js";
import { defaultGitRunner, reviewOwnerForLaunch, type GitRunner } from "./review/stage.js";
import { localTargetBranch } from "./target-branch.js";
import { hostUserAlias } from "./host-user.js";
import {
  ANONYMOUS_ALIAS,
  actingAliasFor,
  hasTrustedIdentityFor,
  isLoopbackAddress,
  isLoopbackBind,
  requestRemoteAddress,
  resolveIdentityConfigFromEnv,
  resolveUserAlias,
  scopingUserFor,
} from "./identity.js";
export {
  ANONYMOUS_ALIAS,
  isLoopbackAddress,
  resolveIdentity,
  resolveIdentityConfigFromEnv,
  resolveUserAlias,
  trustedProxyAddresses,
  tunnelHeaderTrust,
} from "./identity.js";
import { createPublicKnowledgeApp, type PublicKnowledgeDeps } from "./public-knowledge/app.js";
import { readAccess, validateAccess, writeAccess } from "./public-knowledge/access.js";
import type { PublicKnowledgeAccess } from "./public-knowledge/identity.js";
import type { PublicKnowledgeListenerStatus } from "./public-knowledge/listener.js";
import { criterionFloorGate, type CriterionFloorResult } from "./floor/criterion.js";
import { mountFloorRoutes } from "./floor/routes.js";
import { authorizeHookEvent, liveLaunchForHookToken } from "./hook-auth.js";
import {
  checkPipelineLayers,
  clearReviewHandoff,
  launchLayerWeakens,
  ownerProjectLayers,
  gitChangedFiles,
  gitHeadState,
  markReviewHandoff,
  pickedAttemptUnreachable,
  pipelineMessageDelivered,
  pipelinePromptSubmitted,
  recordPaneSend,
  pipelineReadyBlock,
  pipelineRecheckBeforeStop,
  pipelineReviewGateFailed,
  pipelineReworkRequested,
  pipelineSteerLine,
  pipelineStopDecision,
  recordReviewUrl,
  reportedReviewUrlSource,
  staleApprovalError,
  unapprovedWeakens,
  type PipelineDeps,
} from "./pipeline/engine.js";
import { mountPipelineRoutes } from "./pipeline/routes.js";
import { closedJobHygieneStep } from "./job-hygiene.js";
import { createProcessSystem, type ProcessSystem } from "./process-registry.js";
import type { PaneAlive } from "./launch-holds.js";
import { mountProcessRoutes } from "./process-routes.js";
import { resolveInstallDir } from "./restart/state.js";
import { mountBoardRoutes } from "./board/routes.js";
import { createBoard, type Board } from "./board/board.js";
import {
  createReviewTunnels,
  createReviewTunnelSystem,
  mountReviewTunnelRoutes,
  reviewTunnelsEnabled,
  type ReviewTunnels,
} from "./review-tunnel/index.js";
import { mountNotifyRoutes } from "./persona/notify-routes.js";
import { pushIfRouted, routeUpdate } from "./persona/notify.js";
import { mountDeciderRoutes } from "./decider/routes.js";
import { pipelineScreenshotsDir, screenshotStore, validateScreenshotPath } from "./pipeline/screenshots.js";
import type { AwsIdentity } from "./floor/aws-identity.js";
import { HOOK_TOKEN_HEADER, SHELL_ESCAPE_REFUSAL, floorAnswerAllows, isFloorGate, startsWithShellEscape } from "./floor/gate.js";
import {
  askQuestionCall,
  askStandsFor,
  createPermissionAsk,
  describeCall,
  describeCandidates,
  noticeTarget,
  noticeToolName,
  retirePermissionAsks,
  staleCallReason,
  unanswerableReason,
  unfinishedToolCalls,
  type HeldToolCall,
} from "./held-call.js";
import { activeOwnerSecrets, ownerTokenMatches, scrubCredentialEnv, type OwnerSecrets } from "./owner-secret.js";
import { workerEnv } from "./worker-env.js";
import { IDLE_PROMPT_NOTICE, withPersonaHandled } from "./persona/events.js";
import { resolvePersonaConfig } from "./persona/config.js";
import { HOLD_ACCEPTANCE_CRITERION, IDLE_NOTICE_GATE } from "./persona/policy.js";
import {
  permissionAllowDigit,
  permissionAskReadOnly,
  permissionDenyDigit,
  permissionDenyTarget,
  permissionDialogRefusal,
} from "./persona/permission-read-only.js";
import {
  PERSONA_WRITER,
  PERSONA_WRITER_HEADER,
  knowledgeWriteTags,
  personaProposalRefusal,
  personalLayerRefusal,
  type PersonalLayerDoc,
} from "./persona/memory-trust.js";
import {
  PLAYBOOK_FIELDS,
  PLAYBOOK_TAG,
  PLAYBOOK_TITLE_MAX_CHARS,
  REQUIRED_PLAYBOOK_FIELDS,
  composePlaybook,
  isOwnersPlaybookSlug,
  parsePlaybook,
  playbookRelaxations,
  type PlaybookFields,
} from "./persona/playbook.js";
import { playbookHash } from "./persona/playbook-library.js";
import type { PersonaRuntime } from "./persona/runtime.js";
import { PersonaFleet, isPersonaAlias } from "./persona/fleet.js";
import { guestMayDecideFloor } from "./persona/tools.js";
import { ownerCardDecider } from "./persona/floor-cards.js";
import { mountRestartRoutes } from "./restart/routes.js";
import type { RestartService } from "./restart/service.js";
import {
  createSession,
  updateSessionStatus,
  updateSessionTitle,
  resetSessionTitle,
  endSession,
  getSession,
  reviveSession,
  getMostRecentActiveSessionByCwd,
  getActiveSessions,
  getAllSessions,
  getSessionsByProject,
  getActiveWork,
  getSubagentSessions,
  endSubagentSession,
  deleteSession,
  insertEvent,
  getSilenceTicksBySession,
  getLatestEventMarks,
  getProjects,
  getProject,
  setProjectShareable,
  listPublicKbCalls,
  getKnowledgeDefaultScope,
  upsertProject,
  deleteProject,
  rehomeScratchSessions,
  findProjectByCwd,
  getPendingAsks,
  getPendingAsksBySession,
  createAsk,
  getAsk,
  resolveAsk,
  claimPendingAsk,
  releaseAskClaim,
  getSurfacedAsksBySession,
  reopenClaimedAsk,
  cancelAsk,
  PERMISSION_ANY_REQUEST_PREFIX,
  PERMISSION_REQUEST_PREFIX,
  cancelAllPendingAsks,
  dismissAllPendingAsks,
  createCheckpoint,
  getRecentCheckpoints,
  createSteer,
  getPendingSteers,
  createSessionMessage,
  getPendingMessages,
  getSessionMessage,
  cancelSessionMessage,
  postSharedNote,
  getSharedNote,
  getSharedNotes,
  setSharedNoteDone,
  getLaunchList,
  getCodexLaunches,
  getLaunch,
  getLaunchByIdempotencyKey,
  findLaunchByCwd,
  attachSessionToLaunch,
  isLaunchedSession,
  getLaunchBySession,
  getLaunchesBySession,
  getLaunchInjectedDocs,
  updateLaunchModelEffort,
  getRecentKnowledgeChanges,
  getKnowledgeResolutions,
  getPendingResolutions,
  getKnowledgeResolution,
  markResolutionApplied,
  updateResolutionWinnerLoser,
  deleteKnowledgeResolution,
  getRetrievalUsage,
  getRetrievalBreakdown,
  type RetrievalRecord,
  getSetting,
  setSetting,
  getSettingsVersion,
  createTicket,
  getTicket,
  getTickets,
  getTicketsByProject,
  getTicketByLaunch,
  getTicketBySession,
  getTicketByAttemptGroup,
  updateTicketStatus,
  setTicketLaunch,
  setTicketSession,
  setTicketAttemptGroup,
  setReviewUrl,
  setTicketError,
  TicketTransitionError,
  getReviewFinding,
  getReviewFindingsByTicket,
  getOpenHighFindings,
  isHighSeverity,
  setFindingStatus,
  setFindingFixLaunch,
  getEventsSince,
  getEventsBefore,
  headSeq,
  appendPendingReply,
  releasePendingReply,
  attachSessionToTaskRun,
  getTaskRuns,
  getActiveTaskRunBySession,
  getActiveTaskRunByWorktree,
  updateTaskRunStatus,
  heartbeatTaskRun,
  TaskRunTransitionError,
  touchUser,
  getUserPrefs,
  putUserPrefs,
  getUserProjectPrefs,
  putUserProjectPrefs,
  getEffectiveUserPrefs,
  upsertActor,
  recordParticipant,
  getParticipants,
  getParticipantsBySession,
  getActor,
  actorResolver,
  getActors,
  mergeActors,
  setSessionCreatedActor,
  assignSessionOwner,
  getPlanApproval,
  getPlanReviewRemark,
  setPlanReviewRemark,
  markPlanReviewRemarkDelivered,
  deletePlanReviewRemark,
  getAskByRequestId,
  getPlanApprovalByLaunch,
  getPendingPlanApprovals,
  submitPlan,
  approvePlan,
  PlanChangedError,
  rejectPlan,
  setCriterionMet,
  resetCriterionMet,
  ownerKeyFor,
  listProfiles,
  upsertProfile,
  deleteProfile,
  getProjectDefaultProfile,
  getPersonalDefaultProfile,
  getGlobalDefaultProfile,
  getOrchestrationRun,
  updateOrchestrationRunStatus,
  supersedeOrchestrationRunsForTicket,
  setProjectDefaultProfile,
  setPersonalDefaultProfile,
  setGlobalDefaultProfile,
  validateOrchestrationProfileDefinition,
  resolveActiveProfile,
  personaJobForLaunch,
  personaJobForSession,
  openPersonaWorkerSessions,
  listPersonaApprovals,
  getPersonaUserAccess,
  setLaunchHookAuth,
  retireLaunchHookAuth,
  clearRevivedOutsideLaunch,
  reattachSessionToTaskRun,
  setSessionHookLaunch,
  getPersonaJob,
} from "@standup/store";
import {
  LocalMarkdownBackend,
  KnowledgeStore,
  listKnowledgeFiles,
  readKnowledgeFile,
  writeKnowledgeFile,
  updateDocFrontmatter,
  deleteKnowledgeFile,
  acceptDraftFile,
  archiveDocVersion,
  parseAsOf,
  deleteDraftFile,
  isValidSlug,
  normalizeTags,
  isSafePathSegment,
  defaultModelFor,
  runRetrievalEval,
  isConfident,
  calibrationStatus,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_BASE_CONFIDENCE,
  INITIAL_CONFIDENCE,
  MIN_INJECTION_CONFIDENCE,
  SOURCE_KINDS,
  DEFAULT_SOURCE_KIND,
  PLAYBOOK_SOURCE_KIND,
  SCOPES,
  DEFAULT_SCOPE,
  resolveAuthoredScope,
  docInAudience,
  scopeAudienceSql,
  ownerFilterSql,
  layerOf,
  mirrorAliasedAudience,
  NATIVE_MEMORY_HOME_SLUG_PREFIX,
  redactSecrets,
  redactSecretsWithCount,
  redactOptionsFor,
  loadPersonalFingerprint,
  withholdPersonalContent,
  judgmentCounts,
  verdictFlipRate,
  parseContradictsClaim,
  recordVerificationAttempt,
  recordVerificationRepo,
  UNVERIFIABLE_VERDICT,
  generateEmbedding,
  type SourceKind,
  type Scope,
  type ScopeAudience,
  type SearchOptions,
  type KnowledgeDoc,
  type KnowledgeDocFile,
  type Layer,
  type EmbeddingProvider,
  type EmbeddingConfig,
} from "@standup/knowledge";
import { resolveAcceptMode, isAcceptAllEligible } from "./draft-accept.js";
import {
  detectDuplicate,
  detectContradictions,
  flagContradictions,
  runClaudeContradictionJudge,
  withJudgmentLog,
  withJudgeDeadline,
  ContradictionJudgeError,
  type ContradictionJudge,
  type DocText,
} from "./knowledge-coherence.js";
import {
  duplicateRefusal,
  findNearestDocs,
  isUpdateCandidate,
  nearestSummary,
  updateHint,
  type NearestDoc,
} from "./knowledge-dedup.js";
import { AutoPublishCap } from "./knowledge-publish-cap.js";
import {
  landedClaimFor,
  landedClaimMarker,
  repoStateDisputes,
  unnamedUnmergedWarning,
} from "./knowledge-repo-claims.js";
import {
  draftVerdict,
  isPendingVerification,
  recordUnverifiable,
  unverifiableDispute,
  verifyPublishedDoc,
  type PublishVerifyDeps,
  type VerificationRepo,
} from "./knowledge-publish-verify.js";
import { dbVerificationInputs, resolveVerificationRepo, sourceSessionProject } from "./knowledge-verify-repos.js";
import {
  buildResolveDeps,
  resolveContradictionsAsync,
  runClaudeContradictionResolver,
  acceptResolution,
  rejectResolution,
  swapProposal,
  proposalFromResolution,
  clearContradictionEdge,
  type ResolveDeps,
} from "./knowledge-resolve.js";
import {
  htmlToText,
  extractHtmlTitle,
  deriveIngestSlug,
  buildIngestBody,
  isIngestableUrl,
  normalizeIngestSourceKind,
} from "./knowledge-ingest.js";
import {
  computeStaleness,
  hasProvenance,
  primaryRepoPath,
} from "./knowledge-staleness.js";
import { demoteStale, freshnessGate } from "./knowledge-freshness.js";
import { injectionGateReason, injectionStaleSince } from "./knowledge-injection-gate.js";
import { aboutFilePushHits, createKnowledgePusher, mergeHookContext, type PushHookPayload } from "./knowledge-push.js";
import { bootSteeringNotice } from "./steering-staleness.js";
import { demoteMissingMentions, docsAboutFile, missingMentionsFor } from "./knowledge-code-mentions.js";
import { federateSearch } from "./knowledge-federation.js";
import {
  HARNESS_IDS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  GLOBAL_PROJECT_ID,
  capTitle,
  isHttpUrl,
  parseChannelFeatureMap,
  mergeChannelFeaturesPatch,
  parseLaunchPipelineMode,
  pipelineLayerFromInput,
  specProjectRefusal,
  WORKER_TOKEN_HEADER,
} from "@standup/shared";
import type {
  ChannelFeaturesPatch,
  CheckpointSource,
  ClaudeEffort,
  ClaudeModel,
  CodexEffort,
  CodexModel,
  HarnessId,
  HookEventType,
  HookPayload,
  Launch,
  PipelineOverride,
  PlanApproval,
  Project,
  ProjectWithCounts,
  Session,
  SessionParticipant,
  SessionUsage,
  Steer,
  FleetUsage,
  UserUsage,
  FleetUsageTotals,
  Snapshot,
  Ticket,
  TicketSeverity,
  TicketStatus,
  ReviewFinding,
  ToolUsePayload,
  DeployTarget,
  IdentityProviderConfig,
  OrchestrationScope,
  OrchestrationStep,
  OrchestrationProfile,
  UserPrefs,
  WhoAmI,
  WsMessage,
  KnowledgeRetrievalUsage,
  KnowledgeUsageHealth,
} from "@standup/shared";

const CLAUDE_EFFORTS: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * The Standup repo itself, registered as a launchable "self" project — the
 * target of propose_standup_improvement's fix launches, so Standup can be
 * dogfooded into fixing itself. Its OWN reserved id/namespace
 * (STANDUP_SELF_PROJECT_ID, "standup-self") — deliberately NOT "standup" (a
 * plain id a dogfooding developer may have registered for their own live
 * checkout), so a self-fix can never be launched against a user's working tree.
 * The repo is ALWAYS this collector's own checkout (three dirs up from
 * packages/collector/src), overridable via STANDUP_SELF_REPO.
 */
const STANDUP_SELF_REPO =
  process.env.STANDUP_SELF_REPO ?? join(import.meta.dir, "..", "..", "..");
/** The kinds propose_standup_improvement accepts. */
const STANDUP_IMPROVEMENT_KINDS = ["bug", "kb-gap", "feature"] as const;
/** Ticket severities accepted by POST /api/tickets/propose (defaults to "medium"). */
const TICKET_SEVERITIES: TicketSeverity[] = ["low", "medium", "high", "critical"];
/** Ticket statuses accepted by the external status setter (POST /api/tickets/:id/status). */
const TICKET_STATUSES: TicketStatus[] = [
  "proposed",
  "approved",
  "developing",
  "needs_review",
  "shipped",
  "dismissed",
];
/**
 * Coerces a caller-supplied source_kind (propose / knowledge-edit routes) to a
 * valid SourceKind, or undefined when absent/invalid. Returning undefined (not
 * a thrown error) lets a route fall back to its own default — the stamped
 * `unclassified` on a fresh propose, or the doc's existing kind on an edit — so a
 * garbage value never lands in the corpus and never fails an otherwise-valid
 * write. This is the sole production entry point that lets an agent (via the
 * propose_knowledge MCP tool reading a product/spec source) or a human reviewer
 * classify a doc as product/spec, which is what makes product-knowledge
 * injection (roadmap r8) reach a non-empty corpus.
 */
function normalizeSourceKind(value: unknown): SourceKind | undefined {
  // `native-memory` says the native-memory ingest mirrored the doc from the
  // owner's own ~/.claude files; only the ingest may claim it (the owner
  // profile trusts it as the owner's words). `playbook` is written only by
  // Persona's playbook draft route, after its relaxation check.
  return typeof value === "string" &&
    value !== "native-memory" &&
    value !== PLAYBOOK_SOURCE_KIND &&
    (SOURCE_KINDS as readonly string[]).includes(value)
    ? (value as SourceKind)
    : undefined;
}
/**
 * Whether a caller-supplied `scope` (propose / knowledge-edit routes) is one of
 * the closed SCOPES set. Unlike normalizeSourceKind, an invalid scope is
 * REJECTED rather than coerced: scope decides retrieval audience, so silently
 * defaulting a garbage value would place a doc in the wrong window without the
 * author noticing. A route uses this to 400 an explicit bad value while still
 * letting an ABSENT scope fall through to the project/global default resolver —
 * so a raw, unvalidated scope never lands in the corpus.
 */
function isValidScope(value: unknown): value is Scope {
  return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}
/** Cap on a `command`-mode review gate so a wedged `gh pr create` can't hang forever. */
const REVIEW_GATE_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap on the ingest-URL fetch so an unresponsive source can't hang the route. */
const INGEST_FETCH_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.STANDUP_INGEST_FETCH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();
// Slack feed target channel id (`C…`), or "" when the feed is off. Read by the
// @standup/slack adapter via /api/settings so it can be toggled live from Slack.
const SLACK_FEED_CHANNEL_SETTING = "slackFeedChannel";
// Slack user id (`U…`) to DM for asks, or "" if none. The adapter learns this
// from whoever DMs the bot and persists it here so it survives adapter restarts.
const SLACK_ASK_USER_SETTING = "slackAskUser";
// Per-channel Slack feature toggles as a JSON blob keyed by channel id — coarse
// feed/mirror/asks switches plus per-event-type feed kinds. "" (or absent) means
// every channel keeps everything on (backward compatible). The adapter's
// per-channel toggle commands read and write it; the collector just persists it.
const SLACK_CHANNEL_FEATURES_SETTING = "slackChannelFeatures";
import {
  MIRROR_PROJECTS,
  SCRATCH_PROJECT_ID,
  STANDUP_SELF_PROJECT_ID,
  relatedProjects,
  type ProjectsRegistry,
} from "./projects-registry.js";
import { runRipgrep } from "./ripgrep.js";
import {
  broadRootReason,
  detectCodeSearchBackend,
  extraCodeSearchRoots,
  homeDir,
  isWithinRoots,
} from "./code-search.js";
import { waitForAskResolution } from "./asks.js";
import {
  DrainReleasedError,
  drainReleasedResponse,
  killGroupOnRelease,
  killProcessGroup,
  processDrain,
  type Drain,
} from "./drain.js";
import {
  waitForPlanApproval,
  checkAcceptanceCriterion,
  PLAN_APPROVAL_DEFAULT_TIMEOUT_S,
} from "./plan-gate.js";
import { pushNotification } from "./push.js";
import { maybeContributeNudge } from "./contribute-nudge.js";
import { statusBodyRefusal, statusBodyWarning, statusTitleRefusal } from "./knowledge-status-guard.js";
import { checkpointCompletedTodos, clearTodoCheckpointState } from "./todo-checkpoints.js";
import { takeSteerContext } from "./steers.js";
import { takeMailboxContext } from "./mailbox.js";
import { recoverSession, settleAfterInterrupt, startQueuedIfIdle, tmuxPaneDriver } from "./session-recovery.js";
import { stopSession, type StopSessionDeps } from "./session-stop.js";
import { closeRefusal, closeSession } from "./session-close.js";
import { queuedWorkSession, wakeForQueued, wakeIfReaped, type LaunchResumeDeps } from "./launch-resume.js";
import { markDoneAtTurnEnd } from "./turn-end-guard.js";
import { workerCopies } from "./worker-copies.js";
import {
  launchSession,
  cleanupLaunch,
  stopLaunch,
  adoptSession,
  captureLaunchOutput,
  sendToLaunch,
  launchMayBeBypassed,
  interruptLaunch,
  waitForClaudePromptReady,
  buildModalAnswerKeys,
  sendModalAnswerToLaunch,
  answerPermissionDialog,
  tmuxSessionExists,
  WORKTREE_ROOT_SETTING,
  launchCarriesKnowledgeSteering,
  buildSubagentKnowledgeContext,
  retrieveProductKnowledge,
  retrieveCodeKnowledge,
  LaunchRefusedError,
  personaHarnessRefusal,
} from "./launcher.js";
import { isMultiplayerMode, MULTIPLAYER_OVERRIDE_SETTING } from "./multiplayer.js";
import { isNativeMemoryDoc } from "./native-memory-ingest.js";
import {
  gatedRecords,
  hitRecordFields,
  placementsFor,
  recordKnowledgeRetrievals,
  type GatedCandidate,
} from "./retrieval-telemetry.js";
import { knowledgeUsageHealth } from "./knowledge-usage-health.js";
import { syncTicketForTerminalRun } from "./task-ticket-sync.js";
import {
  composeReviewArtifact,
  participantsForCoAuthors,
  type ReviewArtifactResult,
} from "./review-artifact.js";
import { projectCheckoutRemotes } from "./review/code-review-requirement.js";
import { publishTicket } from "./publisher.js";
import { reviewCommentsForTicket, reviewCommentsPrRefFromLaunch } from "./review-comments.js";
import { activeRunForTicket } from "./ticket-dispatch.js";
import {
  clampAttempts,
  dispatchTicketAttempts,
  collectAttemptDiffs,
  pickAttempt,
} from "./attempts.js";
import {
  runAutoReview,
  buildFixerPrompt,
  defaultAutoReviewDeps,
  type AutoReviewDeps,
} from "./auto-review.js";
import {
  runOrchestrationForTicket,
  ensureOrchestrationRun,
  orchestrationReadyBlock,
} from "./orchestration-gate.js";
import {
  isTrackerTicket,
  firesTrackerWriteback,
  ingestTaskAsWorkItem,
  composeTaskWriteback,
  writeBackTaskStatus,
  trackerWritebackFor,
} from "./tracker/sync.js";
import { resolveTrackerAdapter, type TrackerAdapter, type TrackerTask } from "./tracker/adapter.js";
import { bootstrapPrompt, reviseDraftPrompt } from "./bootstrap-prompt.js";
import { isInternalCwd } from "./internal-cwd.js";
import {
  verifyDraft,
  UNVERIFIED_CONFIDENCE,
  type DraftVerification,
} from "./draft-verify.js";
import { makeKnowledgeChangeEmitter } from "./knowledge-change-emit.js";
import {
  readTranscript,
  transcriptPathForSession,
  currentEffortForSession,
  currentModelForSession,
  ingestTranscriptEvents,
  retainTranscriptMemos,
} from "./transcript.js";
import {
  knownProjectIds,
  matchKnownProject,
  projectIdForPath,
  resolveSessionProject,
  scratchWarning,
  unknownProjectWarning,
  type SessionRehomedListener,
} from "./session-project.js";
import { rehomeSessionKnowledge } from "./knowledge-rehome.js";
import { readRichTranscript } from "./rich-transcript.js";
import {
  readSessionUsage,
  mapWithConcurrency,
  FLEET_USAGE_READ_CONCURRENCY,
} from "./usage.js";
import { readCodexSessionUsage } from "./harness/codex-usage.js";
import { TranscriptTailer } from "./transcript-tailer.js";
import {
  maybeNudge,
  isNudgingEnabled,
  resetTurnNudges,
  clearNudgeState,
} from "./nudge.js";
import {
  maybeAutoCheckpoint,
  beginTurnEnd,
  isLatestTurn,
  turnEndJudged,
  clearAutoCheckpointState,
  maybeSummarizeTitle,
  clearTitleSummaryState,
  isTitleSummaryEnabled,
  setTitleSummaryEnabled,
  classifyTurnEnd,
} from "./auto-checkpoint.js";

/** Standup's own MCP tools — nudging on these would feed back on itself. */
function isStandupTool(toolName: string): boolean {
  return /(^|__)(search_knowledge|get_knowledge_doc|ripgrep|checkpoint|ask_human|propose_knowledge)$/.test(
    toolName ?? ""
  );
}

/**
 * The single choke point that builds the ScopeAudience for the AGENT / injection
 * retrieval class. Its `user` is always the SERVER-RESOLVED identity
 * (scopingUser(c) — the tunnel-authenticated header / host `$USER`), never a
 * caller-supplied user/actor/owner field, and the anonymous sentinel maps to
 * undefined so an unauthenticated caller falls back SAFELY to global ∪ project
 * rather than to another user's docs. Every scope-routed retrieval an agent can
 * reach funnels through here, so identity is resolved in ONE place instead of
 * being re-derived (and potentially mis-derived) per call site.
 *
 * Retrieval/injection paths that return doc content OR metadata to an AGENT, and
 * how each is gated — the exhaustive audience-boundary checklist. Every entry is
 * either (a) resolves identity server-side AND applies the scope gate, or (b) a
 * deliberate permissive HUMAN-BROWSE path not reachable as an agent injection
 * path. Adding a new agent-facing retrieval path means adding it here and gating
 * it through this helper (or scopingUser for the user portion):
 *
 *   (a) AGENT / injection class — server-resolved identity + scope gate:
 *     - launch injection: launcher.ts retrieveCode/ProductKnowledge, audience
 *       `{ project, user: retrievalUser }` where the launch routes set
 *       retrievalUser = scopingUser(c) (decoupled from the body `actor`, which is
 *       kept only for ledger attribution / profile as `requester`).
 *     - POST /api/knowledge/search (scoped:true; MCP search_knowledge) — this helper.
 *     - GET  /api/knowledge/agent-view — this helper for the caller's own view.
 *       The caller's own identity is tunnel-authenticated, so their self-view is
 *       exact; naming ANOTHER user in the `user` param is an operator action, gated
 *       by isTrustedCoordinationWrite (the optional token, or a single-user
 *       loopback bind) — a soft team convenience, not a hard boundary, since the
 *       class-(b) browse paths already expose any doc to a teammate.
 *     - POST /api/knowledge/neighbors (scoped:true; MCP graph_neighbors) — this
 *       helper; scopeAudienceSql filters the far-end neighbor in getNeighbors.
 *
 *   (b) permissive HUMAN-BROWSE class — not an agent auto-injection path, and
 *       INTENTIONALLY not scope-gated under the one-trusted-team / loopback model
 *       so cross-team learning stays visible in the web UI: every project's docs
 *       and every scope. The personal layer is the exception — private by layer,
 *       not by retrieval scope — so each of these applies the browse audience
 *       (resolveBrowseAudience, ScopeAudience.browse) and returns a personal doc
 *       only to its owner:
 *     - GET /api/projects/:id/knowledge and GET /api/projects/:id/knowledge/:slug
 *       (the doc list and doc body by project+slug) — the Knowledge tab's list
 *       and read rail. No MCP/agent tool fetches a doc body through them, so they
 *       are human-browse-only; if an agent tool ever reads bodies through them,
 *       it must gate through here.
 *     - POST /api/knowledge/neighbors and POST /api/knowledge/doc WITHOUT scoped —
 *       the Knowledge graph browse view and full-body read.
 *     - GET /api/knowledge/graph — the Graph visualization.
 *     - POST /api/knowledge/search WITHOUT scoped, plus its `owner` filter — the
 *       "my knowledge" browse knob, which recalls across every scope/owner.
 *     GET /api/knowledge/stats and GET /api/knowledge/usage are corpus-wide
 *     aggregates (counts, per-doc retrieval tallies, the dead-doc view) whose
 *     per-doc rows apply the same rule: another user's personal-layer doc is
 *     never listed. GET /api/knowledge-changes and the
 *     knowledge:change frame show a personal doc's change only to its owner.
 *
 * DESIGN NOTE: the scope gate is a SOFT team ROUTING boundary, not a hard per-user
 * privacy wall. On class (a) it resolves identity server-side and routes an agent
 * to global ∪ project ∪ (the resolved user's own) docs. Because an
 * authenticating tunnel authenticates the connecting teammate and guarantees the
 * identity header, the resolved identity is the REAL caller — a
 * teammate cannot present a peer's alias — so an agent gets its OWN user's docs,
 * never a forged victim's. Per-user scope keeps one teammate's personal notes out
 * of another's default retrieval; it is not isolation. The class-(b) browse paths
 * INTENTIONALLY let teammates read each other's docs under the one-trusted-team
 * model, so nothing here is a secrecy boundary. A raw non-tunnel caller resolves to
 * anonymous → undefined, falling back to global ∪ project (no user docs). Global
 * and project docs reach their intended audience unchanged on both classes. The
 * trust model is resolveUserAlias's (identity.ts).
 */
function resolveAgentAudienceFor(projectId: string, user: string | undefined): ScopeAudience {
  return { projectId, user, hostUser: hostUserAlias() };
}

/**
 * Whether a single resolved doc falls inside a ScopeAudience — docInAudience,
 * the in-memory twin of scopeAudienceSql, evaluated against a doc already
 * fetched by id/slug rather than pushed into a candidate query. The by-id/by-slug
 * doc fetch uses it to enforce the SAME strict scope gate search and neighbors
 * apply, so reaching a doc by its id can never surface one outside the caller's
 * audience.
 */
function isDocInAudience(doc: Parameters<typeof docInAudience>[0], audience: ScopeAudience): boolean {
  return docInAudience(doc, audience);
}

// Foreign-machine absolute paths — a doc embedding one documents a fallback that
// exists only on the authoring machine. Always flagged.
const FOREIGN_ABSOLUTE_PATH = /(?:\/Volumes\/|\/Users\/)[^\s"'`)\]}<>]+/g;
// A repo-relative pointer: two-or-more path segments ending in a source/doc file
// extension. Conservative on purpose — it requires a real file extension so prose
// that merely contains a slash ("search/replace", "and/or") never matches. The
// trailing lookahead forces the extension to end at a word boundary, so a short
// alternative never matches a prefix of a longer one (`App.tsx` is not `App.ts`).
const REPO_RELATIVE_POINTER =
  /(?:[\w.@-]+\/)+[\w.@-]+\.(?:md|markdown|mdx|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|py|txt|yaml|yml|toml|go|rs|java|sh)(?![A-Za-z0-9_])/g;

// A path pointer is a single whitespace-free token; anything longer than this is
// not a real path and is skipped — which also bounds the pattern matcher so an
// adversarial run of non-whitespace characters can't drive it into quadratic
// backtracking.
const MAX_POINTER_TOKEN = 512;

/**
 * Whether `pointer` resolves to an existing file that stays inside the worktree.
 * A pointer that escapes the root via `..` is treated as unresolved (and never
 * stat-ed on the way out), so it neither passes as valid nor leaks the existence
 * of files outside the worktree.
 */
function resolvesUnderWorktree(worktreeRoot: string, pointer: string): boolean {
  const root = resolve(worktreeRoot);
  const target = resolve(root, pointer);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) return false;
  return existsSync(target);
}

/**
 * Non-fatal warnings for filesystem path pointers a doc's body embeds that do
 * not resolve — a documented "canonical full doc in-repo: …" fallback is
 * useless if the path is dead. Two conservative classes: (i) absolute macOS
 * paths under /Volumes/ or /Users/ (foreign-machine paths, always flagged); and
 * (ii) repo-relative pointers (e.g. `src/foo/bar.md`) that do not exist under the
 * worktree root. Detection stays deliberately narrow — it requires a real file
 * extension — so prose containing slashes is never flagged. Returns [] when
 * nothing looks dead.
 */
function detectDeadPathPointers(body: string, worktreeRoot: string | undefined): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const token of body.split(/\s+/)) {
    if (token.length === 0 || token.length > MAX_POINTER_TOKEN) continue;

    for (const match of token.matchAll(FOREIGN_ABSOLUTE_PATH)) {
      const pointer = match[0].replace(/[.,;:]+$/, "");
      if (seen.has(pointer)) continue;
      seen.add(pointer);
      warnings.push(
        `path pointer '${pointer}' is a foreign-machine absolute path that will not resolve on other machines; store repo-relative paths that resolve anywhere`
      );
    }

    for (const match of token.matchAll(REPO_RELATIVE_POINTER)) {
      const index = match.index ?? 0;
      // Skip a match that is the tail of an absolute path — the foreign-path pass
      // above already covers those, and a genuinely repo-relative pointer never
      // has a leading slash.
      if (index > 0 && token[index - 1] === "/") continue;
      const pointer = match[0].replace(/[.,;:]+$/, "");
      if (seen.has(pointer)) continue;
      // Only a worktree-relative pointer can be resolved; with no root we cannot
      // judge whether it is dead, so we do not flag it (conservative).
      if (!worktreeRoot || resolvesUnderWorktree(worktreeRoot, pointer)) continue;
      seen.add(pointer);
      warnings.push(
        `path pointer '${pointer}' does not resolve under the worktree; store repo-relative paths that resolve anywhere`
      );
    }
  }

  return warnings;
}

/**
 * The per-user local write token the collector persisted at startup (see
 * `@standup/shared/write-token`). It lives in a 0600 file under the collector
 * user's home, so only that user's local processes — its own agents' MCP servers
 * — can present it; remote and other-user callers cannot. Undefined until the
 * collector's entrypoint sets it (and in tests that don't), in which case only
 * STANDUP_WRITE_TOKEN / the single-user loopback rule can authorize a write.
 */
let localWriteToken: string | undefined;

export function setLocalWriteToken(token: string | undefined): void {
  localWriteToken = token?.trim() || undefined;
}

/**
 * Whether a request may WRITE a per-user profile. A profile is injected verbatim
 * into the opening prompt of every session its owner launches, so a cross-user
 * write is a stored prompt-injection into that user's future agents, not the
 * cosmetic pref change the READ path is — a higher bar than the read visibility
 * the spec deliberately leaves open ("teammates may see it; not a security
 * boundary").
 *
 * On an authenticating tunnel the identity header is authenticated and unforgeable
 * (the tunnel verifies the teammate and stamps it), so WHO is calling
 * is known. What this gate bounds is a CROSS-USER write — writing into ANOTHER
 * teammate's profile. Unlike knowledge authoring (which now trusts the tunnel
 * identity and enforces per-doc ownership via an acting===owner check), the
 * profile-write path has NOT yet been migrated to that per-owner authorization, so
 * it conservatively keeps the out-of-band token as the operator gate on shared
 * deployments rather than opening a blanket teammate write:
 *  - When `STANDUP_WRITE_TOKEN` is configured it gates EVERY write regardless of
 *    bind: only a request presenting a matching `x-standup-write-token` is
 *    trusted. This is the lockdown for a shared/multiplayer deployment or a
 *    collector exposed OUTSIDE the tunnel on a raw network bind (where a
 *    non-tunnel client, not the authenticated tunnel, could set the header).
 *  - When no token is configured, trust depends on whether the collector is
 *    serving more than one person. When `multiplayer` is true (≥2 tunnel users)
 *    every write is refused (fail closed) until the token is set — the collector
 *    does not yet authorize a teammate's own profile write without it. Only in the
 *    single-user default (multiplayer false) does a loopback bind trust the write;
 *    a network-exposed bind always refuses without the token.
 *
 * Migrating profile writes to the tunnel identity + acting===owner model (so a
 * teammate may edit their OWN profile tokenlessly, as knowledge authoring now
 * allows) is a deferred follow-up. The `_tunnelHeader` arg is kept for signature
 * symmetry with the header-keyed read path but is deliberately not read here. The
 * trust model is resolveUserAlias's (identity.ts).
 */
export function isTrustedProfileWrite(
  _tunnelHeader: string | null | undefined,
  bindHost: string | undefined = process.env.STANDUP_BIND_HOST,
  presentedToken?: string | null,
  configuredToken: string | undefined = process.env.STANDUP_WRITE_TOKEN,
  multiplayer = false,
  localToken: string | undefined = localWriteToken
): boolean {
  // The per-user local token (see setLocalWriteToken) is readable only by the
  // collector's own OS user, so presenting it proves a same-user local caller —
  // the operator themself — on any bind and in multiplayer.
  if (tokenMatches(presentedToken, localToken)) return true;
  // A configured secret is the out-of-band gate for every cross-user profile
  // write, on any bind — the operator authorization this path has not yet replaced
  // with a per-owner check.
  const secret = configuredToken?.trim();
  if (secret) return tokenMatches(presentedToken, secret);
  // No secret configured. In multiplayer the collector serves ≥2 people and does
  // not yet authorize a teammate's own profile write tokenlessly, so refuse (fail
  // closed) until the token is set rather than open a blanket write.
  if (multiplayer) return false;
  // Single-user default: trust a loopback write; refuse a network-exposed one,
  // where a raw non-tunnel client (not the authenticated tunnel) could set the
  // header (fail closed).
  return isLoopbackBind(bindHost);
}

/**
 * The launching user's saved review-rigor default for a launch (rigor
 * is injected as instruction AND is this user's default when they trigger a
 * review flow). Resolved from the session that reported in — its `created_actor`
 * is the dispatching alias — falling back to the launch's ledger `requester`.
 * Uses the EFFECTIVE profile for the launch's project (§H), so a per-project
 * overlay's rigor overrides the user's global default, matching the precedence
 * the launcher injects. Undefined when no launching user is known or they saved
 * no rigor. Pure so the review-agent gate's use of it is unit-testable without a
 * live gate.
 */
/**
 * The human answerable for a session's asks — the person a "waiting on you"
 * notification is really for. Resolves owner → creator → earliest participant,
 * the same routing the web AlertStrip uses, so a phone push names who's on the
 * hook rather than paging everyone generically. Undefined for an unattributed
 * session, where the notification falls back to a plain "you".
 */
export function responsibleAlias(
  db: Database,
  session: { id: string; ownerActor?: string; createdActor?: string } | undefined | null
): string | undefined {
  if (!session) return undefined;
  if (session.ownerActor) return session.ownerActor;
  if (session.createdActor) return session.createdActor;
  return getParticipants(db, session.id)[0]?.actorId;
}

/**
 * Sums per-session usage rows into fleet totals with the cost semantics the
 * cost view relies on: every token leg adds; `costUsd` sums only priceable
 * rows (`?? 0` keeps it a running number) and resolves to null when NO row in
 * the group is priceable — an all-unpriced group is spend of unknown size, not
 * a fabricated $0; `unpricedSessionCount` counts rows with real tokens but no
 * price so the figure can be shown as a partial lower bound. Shared by the
 * fleet grand total and each per-user bucket, so the buckets always reconcile
 * to the grand total (same rows, same reducer).
 */
export function reduceFleetTotals(rows: SessionUsage[]): FleetUsageTotals {
  const totals = rows.reduce<FleetUsageTotals>(
    (acc, r) => ({
      sessionCount: acc.sessionCount + 1,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUsd: (acc.costUsd ?? 0) + (r.costUsd ?? 0),
      unpricedSessionCount:
        acc.unpricedSessionCount + (r.costUsd === null && r.totalTokens > 0 ? 1 : 0),
    }),
    {
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedSessionCount: 0,
    }
  );
  // A group with no priceable session has unknown, not zero, cost.
  if (!rows.some((r) => r.costUsd !== null)) totals.costUsd = null;
  return totals;
}

/**
 * Buckets per-session usage rows by attributed user and re-sums each bucket
 * with the fleet totals reducer. The null bucket is unattributed work
 * (anonymous/host/single-player). Ordered heaviest-first by total tokens,
 * mirroring the per-session sort, so the biggest spender leads.
 */
export function usageByUser(
  rows: SessionUsage[]
): Array<{ user: string | null } & FleetUsageTotals> {
  const buckets = new Map<string | null, SessionUsage[]>();
  for (const r of rows) {
    const key = r.user ?? null;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }
  return Array.from(buckets, ([user, bucketRows]) => ({
    user,
    ...reduceFleetTotals(bucketRows),
  })).sort((a, b) => b.totalTokens - a.totalTokens);
}

export function reviewRigorForLaunch(db: Database, launch: Launch): string | undefined {
  const requester =
    (launch.sessionId ? getSession(db, launch.sessionId)?.createdActor : undefined) ??
    getActiveTaskRunByWorktree(db, launch.worktreePath)?.requester;
  const rigor = requester
    ? getEffectiveUserPrefs(db, requester, launch.projectId)?.reviewRigor?.trim()
    : undefined;
  return rigor || undefined;
}

/**
 * The injectable seam for propose_standup_improvement's launch. Defaults to the
 * real launchSession; a test passes a mock so the confirmation-gated flow can be
 * exercised WITHOUT provisioning a worktree or spawning a real `claude` — the
 * capabilities-only constraint on the self-improvement loop.
 */
export type LaunchFn = typeof launchSession;

/**
 * Whether a human's answer to a self-improvement confirmation is an approval.
 * The console's option button sends the approve option's text verbatim, so an
 * exact (case-insensitive) match is the primary signal; a typed free-text
 * "yes"/"go"/"do it" also counts, while "Not now"/"no"/an empty (dismissed)
 * answer does not. Pure so it is unit-testable.
 */
export function isProposalApproval(answer: string, approveOption: string): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return false;
  // An exact match to the offered approve option (a button click) is unambiguous.
  if (a === approveOption.trim().toLowerCase()) return true;
  // Free text FAILS CLOSED: this launches repo-modifying work, so any negation,
  // deferral, or hedge ANYWHERE disqualifies it — even when it opens with an
  // affirmative token ("approved but hold", "ok no wait", "do it later", "go away").
  if (/\b(no|nope|not|don'?t|stop|wait|hold|never|later|nvm|never\s*mind|cancel|abort|away|unless|but|actually|maybe)\b/.test(a)) {
    return false;
  }
  // Only a clean, leading affirmative counts.
  return /^(y|yes|yep|yeah|yup|approve[d]?|do it|go|go ahead|fire|ship|sure|ok|okay|confirm(ed)?|proceed)\b/.test(a);
}

/**
 * The opening prompt (task) for a Standup self-fix launch. Frames the launched
 * agent as fixing Standup itself, hands it the proposal, and points it at the
 * knowledge-first loop it is itself part of. Pure so it is unit-testable.
 */
export function buildStandupImprovementTask(input: {
  title: string;
  description: string;
  kind: string;
  requester?: string;
}): string {
  const kindLabel =
    input.kind === "bug"
      ? "a BUG in Standup"
      : input.kind === "kb-gap"
        ? "a KNOWLEDGE-BASE GAP in Standup"
        : "a FEATURE Standup should gain";
  const from = input.requester ? ` (proposed by ${input.requester})` : "";
  return (
    `You are fixing STANDUP ITSELF — the console you are running inside. An agent flagged ` +
    `${kindLabel}${from} and a human approved firing this fix.\n\n` +
    `Title: ${input.title}\n\n` +
    `Details:\n${input.description}\n\n` +
    `Ground yourself first: call search_knowledge for the affected area (and open the best hits ` +
    `with get_knowledge_doc) before ` +
    `changing code. Implement the fix, verify it (build + tests), and capture anything durable ` +
    `you learn with propose_knowledge. When the change is complete, call mark_ready_for_review.`
  );
}

/**
 * The nudge the review-agent gate sends to a still-live implementation session
 * to cut its own review. Carries the launching user's review-rigor default when
 * they saved one, so the agent reviews to that bar rather than a generic one.
 * When the project's code-review adapter composed the review, it is handed to
 * the agent verbatim — the exact command (plus the description-file contents
 * to write) or the draft-PR command — so the agent runs the right one for the
 * repo rather than improvising. For a ticket
 * ingested from an agent-driven issue tracker, `trackerWriteback` carries the
 * directive to close the loop on the task (update its status and link the
 * review with the session's own tracker tools). Pure so the rigor-, artifact-
 * and tracker-writeback injection are all unit-testable.
 */
export function reviewAgentNudge(
  reviewRigor?: string,
  artifact?: ReviewArtifactResult | null,
  trackerWriteback?: string
): string {
  const base = artifact?.reviseDescriptionFile
    ? "The change you were assigned is complete and marked ready for review again. " +
      "Push it as a new revision of the review already cut for it — never a new review. " +
      "Once the revision is pushed, report the review's URL with the report_ticket_status tool (reviewUrl) so Standup records it."
    : "The change you were assigned is complete and marked ready for review. " +
      "Prepare it for review following the repo's conventions — open a pull request or code review as appropriate. " +
      "Once it is opened, report its URL with the report_ticket_status tool (reviewUrl) so Standup records it.";
  const rigor = reviewRigor?.trim();
  let out = rigor
    ? `${base}\n\nReview to this bar (the requester's default review rigor): ${rigor}`
    : base;

  if (artifact) {
    const lines: string[] = [""];
    if (artifact.command) {
      lines.push(
        "",
        "Create the review artifact with this command — keep it as-is except for filling in any `<…>` placeholders (do not otherwise improvise a different command):",
        "",
        `    ${artifact.command}`
      );
    }
    if (artifact.command && artifact.placeholders.length > 0) {
      lines.push(
        "",
        "Before running it, replace these placeholders with real values (required — do not run the command with a placeholder left in):",
        "",
        ...artifact.placeholders.map((p) => `- ${p}`)
      );
    }
    if (artifact.descriptionFile) {
      lines.push(
        "",
        `First write this description file to \`${artifact.descriptionFile.path}\`:`,
        "",
        artifact.descriptionFile.contents
      );
    }
    if (artifact.reviseDescriptionFile) {
      lines.push(
        "",
        `This revises the review already cut, so don't write a fresh description: update the existing one at \`${artifact.reviseDescriptionFile.path}\` in place — same sections, with What changed and Validation brought up to date for this revision — before running it.`,
        "",
        "Only if that file is missing, write it from the review's current description, or else from this skeleton:",
        "",
        artifact.reviseDescriptionFile.fallback
      );
    }
    if (artifact.coAuthors.length > 0) {
      lines.push(
        "",
        "Add these Co-authored-by trailers to the COMMIT MESSAGE (as the trailing lines, after a blank line, of the commit that introduces the change) so every collaborator is credited — Git and the review tool read co-authorship from the commit message, not the review's description:",
        "",
        artifact.coAuthors.join("\n")
      );
    }
    out += lines.join("\n");
  }
  const writeback = trackerWriteback?.trim();
  if (writeback) out += `\n${writeback}`;
  return out;
}

/**
 * The stored file extension for an uploaded project icon, from its MIME type
 * (falling back to the filename's own extension), or null when it isn't an
 * image type we serve. Kept to a small allowlist — the icon is written to disk
 * and served back verbatim, so an unknown type is refused rather than guessed.
 */
export function iconExtension(mime: string, filename: string): string | null {
  const byMime: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  if (byMime[mime]) return byMime[mime];
  const m = filename.toLowerCase().match(/\.(png|jpe?g|gif|webp|svg)$/);
  if (!m) return null;
  return m[1] === "jpeg" ? ".jpg" : `.${m[1]}`;
}
import type { KnowledgeSync } from "./knowledge-sync.js";

type WsBroadcast = (message: WsMessage) => void;

/**
 * Project fields that decide what a launch runs, where, and under which
 * permissions, or what command the review gate runs; only the owner sets them.
 */
const LAUNCH_POSTURE_FIELDS = [
  "launchArgs",
  "setup",
  "provision",
  "bypassPermissions",
  "inPlace",
  "reviewProcess",
  "reviewCommand",
  "repos",
  "worktreeRoot",
  "launchSubdir",
] as const;

/** A project's value for a launch-posture field, with unset and its default read as the same. */
function postureValue(field: (typeof LAUNCH_POSTURE_FIELDS)[number], p: Partial<Project>): unknown {
  const value = p[field];
  if (field === "inPlace") return !!value;
  if (field === "bypassPermissions") return value === undefined ? true : !!value;
  if (field === "repos") return JSON.stringify(Array.isArray(value) ? value : []);
  // "pause" is the review gate's default, so unset and "pause" read as the same.
  if (field === "reviewProcess") return value === "" || value === null || value === "pause" ? undefined : value;
  return value === "" || value === null ? undefined : value;
}

/**
 * The launch-posture fields a project-create body sets away from their
 * defaults. Bypass is already the default, so `bypassPermissions` is never one:
 * a new project can't run looser than an unconfigured one.
 */
export function launchPostureFields(body: Partial<Project>): string[] {
  return LAUNCH_POSTURE_FIELDS.filter(
    (field) => field !== "bypassPermissions" && postureValue(field, body) !== postureValue(field, {})
  );
}

/** The launch-posture fields that differ between a project and its update. */
export function changedLaunchPostureFields(before: Project, after: Project): string[] {
  return LAUNCH_POSTURE_FIELDS.filter((field) => postureValue(field, before) !== postureValue(field, after));
}

/** `Ask.gate` of the human confirmation a Standup self-fix launch waits on. */
export const STANDUP_IMPROVEMENT_GATE = "standup_improvement";

/** The option of a Standup self-fix confirmation that releases its launch. */
const STANDUP_IMPROVEMENT_APPROVE = "Fire the fix";

export { CORS_ORIGINS };

/** How publishDraft publishes a draft. */
interface PublishOptions {
  /** The audience a fresh draft is deduplicated against (default: its project's agents). */
  audience?: ScopeAudience;
  /** Skip the fresh-draft dedup (the caller already ran it). */
  skipDedup?: boolean;
  /** Keep the replaced doc's verdict and re-judge its contradictions instead of
   *  clearing them — an agent updating its own doc asserts nothing. */
  keepVerdictHistory?: boolean;
  /** The checkout an unverified agent doc is fact-checked against, or why there
   *  is none (default: the project's repo). */
  verifyRepo?: VerificationRepo;
}

/** The write-path checks createServer runs over new knowledge (see its
 *  `knowledgeQuality` parameter). */
export interface KnowledgeQualityDeps {
  /** Fact-checks a doc body against a repository checkout. */
  verify?: (slug: string, body: string, repoPath: string, additionalRepos?: string[]) => Promise<DraftVerification>;
  /** Judges whether two docs contradict; wrapped with the repository-state
   *  check and the judgment ledger. */
  judge?: ContradictionJudge;
}

/** The leadership term /health reports beside the pid (see leader.ts). */
export interface CollectorHealth {
  slot?: CollectorSlot;
  epoch?: string;
  head?: string;
  /** Milliseconds from taking the leader lock to listening; set once the collector listens. */
  bootMs?: number;
  /** When this collector process started (ISO), for its uptime. */
  startedAt?: string;
}

/** createServer's pluggable integrations; each absent one resolves from the environment. */
export interface ServerIntegrations {
  /** The issue tracker tasks are ingested from and written back to (default: resolveTrackerAdapter). */
  tracker?: TrackerAdapter;
}

/** createServer's Review-tab options (see mountReviewRoutes). */
export interface ReviewServerOptions {
  pipelinePort?: ReviewPipelinePort;
  git?: GitRunner;
  push?: (title: string, message: string, actor: string) => void;
  dataDir?: string;
  mediaHome?: string;
  mediaEnv?: NodeJS.ProcessEnv;
  mediaTotalMaxBytes?: number;
  mediaOwnerQuotaBytes?: number;
  /** Per-owner caps on each user's Docs tree (see mountDocsRoutes). */
  docLimits?: Partial<DocLimits>;
  /** The doc agent that replies to comments on docs (default: one restricted model call, docs/answer.ts). */
  docAnswerer?: DocAnswerer;
  /** Receives the comment agent, so a test can wait for its replies. */
  onDocCommentAgent?: (agent: DocCommentAgent) => void;
}

export function createServer(
  store: Store,
  baseBroadcast: WsBroadcast,
  embeddingProvider: EmbeddingProvider | null = null,
  knowledgeSync?: KnowledgeSync,
  registry?: ProjectsRegistry,
  knowledgeDir = "",
  iconsDir = "",
  embeddingConfig: EmbeddingConfig = {},
  // The auto-review reviewer seam (git-diff + read-only reviewer). Injectable so
  // a test drives the ready-edge review with a fake reviewer instead of spawning
  // a real `claude`; production uses the default git-diff + headless reviewer.
  autoReviewDeps: AutoReviewDeps = defaultAutoReviewDeps(),
  // Live transcript-file tailer. Optional so tests that only exercise other
  // handlers can omit it; when present, hook activation/end drives its watch set.
  tailer?: TranscriptTailer,
  // The launch seam for the human-triggered launch paths — propose_standup_
  // improvement's self-fix, the opt-in approve = start work (approve?dispatch=true),
  // and a ticket dispatch (single launch or best-of-N fan-out). Injectable so a
  // test drives those flows with a mock instead of provisioning worktrees or
  // spawning a real `claude`; production uses the real launchSession.
  launchFn: LaunchFn = launchSession,
  // The identity provider for request-identity resolution. Resolved once from
  // env at startup (see resolveIdentityConfigFromEnv) and threaded here AND into
  // createWsServer as the SAME object, so REST and WS can't drift. Defaulted from
  // env so a test may omit it (unset env => defaultIdentityConfig()).
  identityConfig: IdentityProviderConfig = resolveIdentityConfigFromEnv(),
  // Persona, the always-on orchestrator. Its routes mount either way; without a
  // runtime they answer as disabled. Injectable so a test drives Persona with a
  // fake TurnRunner against this same app.
  // `restart` is the restart service behind POST /api/standup/restart (see
  // restart/service.ts); without it the route answers as unavailable.
  // `ownerSecrets` holds the owner secret owner-only decisions are checked
  // against and the floor's reply key (see owner-secret.ts); it defaults to the
  // process's active secrets. `awsIdentity` resolves the account of the credentials
  // a held AWS call runs with (floor/aws-identity.ts); it defaults to the collector's.
  // `fleet` holds every user's Persona (persona/fleet.ts); a bare `runtime` is
  // served as a fleet of the host's Persona alone.
  persona: {
    fleet?: PersonaFleet;
    runtime?: PersonaRuntime;
    restart?: RestartService;
    ownerSecrets?: OwnerSecrets;
    awsIdentity?: AwsIdentity;
  } = {},
  // The write-path quality checks — the fact-check an agent's published proposal
  // gets, and the contradiction judge. Injectable so a test drives them with
  // stubs instead of spawning `claude`; production uses the real ones.
  knowledgeQuality: KnowledgeQualityDeps = {},
  // Leadership and shutdown: `health` is what /health reports beside the pid
  // (see CollectorHealth); `drain` refuses new requests once a shutdown begins
  // and releases long waits. It defaults to the process drain, which the
  // long-poll waiters observe.
  // `resume` holds the seams resuming a paused idle worker uses (launch-resume.ts).
  // `stopLaunch` closes a launch's pane for the stop routes (default: the
  // launcher's stopLaunch over tmux); `processes` is the process system a
  // closed job's worker hygiene stops registered processes through (default:
  // the real host's); `paneAlive` is whether a running launch's pane still
  // exists, for that hygiene's liveness checks (default: an exact-name
  // has-session on the workers' tmux server). Injectable so a test stops
  // workers without tmux, ps or kill.
  lifecycle: {
    health?: CollectorHealth;
    drain?: Drain;
    resume?: LaunchResumeDeps;
    stopLaunch?: StopSessionDeps["stopLaunch"];
    processes?: ProcessSystem;
    paneAlive?: PaneAlive;
  } = {},
  // The delivery pipeline's side effects — the worktree's changed files, the
  // approved acceptance criterion, the validation stage's checks, screenshot
  // checks and the store of
  // screenshot copies. Injectable so a test advances a run without git, a
  // shell or the real data dir; production uses the real ones.
  pipelineOverrides: Partial<
    Pick<PipelineDeps, "changedFiles" | "headState" | "runCriterion" | "runCheck" | "validateScreenshot" | "screenshots">
  > = {},
  // The Review tab's seams: the delivery pipeline a decision is reported to
  // (this server's pipeline engine by default), git, push notifications, the data dir media copies
  // live under, and the home/env media paths are checked against.
  review: ReviewServerOptions = {},
  // The public knowledge API's seams — the group lookup and the clock,
  // injectable so a test drives the API without spawning `id` — and
  // `listenerStatus`, whether its listener is actually bound (the collector's
  // entry point starts it after this server exists). Without one, the API
  // reports itself not serving.
  publicKnowledge: Partial<Pick<PublicKnowledgeDeps, "groupsOf" | "now">> & {
    listenerStatus?: () => PublicKnowledgeListenerStatus;
  } = {},
  // Review tunnels to branch builds: the manager the collector's maintenance
  // timers share, or (absent) one on the real host under the data dir.
  // Injectable so a test opens and closes tunnels against a fake host.
  reviewTunnelsIn?: ReviewTunnels,
  // The Board the collector's adapter writes and every reader goes through,
  // or (absent) one over this server's store and broadcast.
  boardIn?: Board,
  // The pluggable integrations (see ServerIntegrations); each defaults to the
  // one the environment configures.
  integrations: ServerIntegrations = {}
) {
  const board = boardIn ?? createBoard({ db: store.db, publish: (m) => broadcast(m) });
  const tracker = integrations.tracker ?? resolveTrackerAdapter();
  /**
   * The collector-driven tracker writeback once a ticket's review URL is
   * known; a no-op unless the adapter writes back itself. Failures are
   * logged, never surfaced to the reporter.
   */
  const trackerWritebackFromCollector = (ticket: Ticket, reviewUrl: string): void => {
    if (tracker.writeback !== "collector" || !isTrackerTicket(ticket)) return;
    const atReview: Ticket = { ...ticket, reviewUrl, status: ticket.status === "shipped" ? "shipped" : "needs_review" };
    void writeBackTaskStatus(tracker, ticket.issueId!, composeTaskWriteback(tracker, atReview)).catch((e) =>
      console.error(`[tracker] writeback to ${tracker.name} task ${ticket.issueId} failed:`, e)
    );
  };
  const app = new Hono();
  const drain = lifecycle.drain ?? processDrain;
  // First in the chain, so a draining collector processes nothing new.
  app.use("*", drain.middleware());
  // A long wait the drain released answers 503 `released`; anything else
  // falls through to Hono's default handling.
  app.onError((err, c) => {
    if (err instanceof DrainReleasedError) return drainReleasedResponse();
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.text("Internal Server Error", 500);
  });
  // The fact-check of a doc against `repoPath` and any further checkouts it is about.
  const publishVerifier = (
    slug: string,
    body: string,
    repoPath: string,
    additionalRepos: string[] = []
  ): Promise<DraftVerification> => {
    if (knowledgeQuality.verify) {
      return additionalRepos.length > 0
        ? knowledgeQuality.verify(slug, body, repoPath, additionalRepos)
        : knowledgeQuality.verify(slug, body, repoPath);
    }
    return verifyDraft(slug, body, repoPath, additionalRepos.length > 0 ? { additionalRepos } : {});
  };
  const config = identityConfig;
  const ownerSecrets = persona.ownerSecrets ?? activeOwnerSecrets();
  const fleet = persona.fleet ?? (persona.runtime ? PersonaFleet.of(persona.runtime, store.db) : undefined);
  const ownerAlias = fleet?.host ?? resolveUserAlias(undefined);
  const hostPersona = fleet?.hostRuntime();
  // Where review media copies and each launch's review scratch dir live.
  const reviewDataDir = review.dataDir ?? hostPersona?.dataDir ?? standupDataDir();

  /**
   * The Persona runtime a request comes from: one of its own in-process calls
   * (its writer secret) or its turn's MCP proxy (its Persona token). Such a
   * request acts as that runtime's owner, whatever identity header or body
   * `actor` it carries. A request through an owner channel (the owner secret,
   * which a guest's runtime presents only to carry out a card the host
   * approved) acts as itself instead.
   */
  const personaRuntimeOf = (c: Context): PersonaRuntime | undefined => {
    if (!fleet || ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets)) return undefined;
    return fleet.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER)) ?? fleet.byToken(c.req.header(PERSONA_TOKEN_HEADER));
  };

  /**
   * The Persona runtime whose own in-process call (its writer secret) the
   * request is — Persona's tool layer, never its turn's MCP proxy (which holds
   * only the Persona token). Only such a call may say the owner approved it
   * on a card (an `ownerApproved` body field): the tool layer sets that only
   * when it carries out an approval the owner decided.
   */
  const personaRuntimeCallOf = (c: Context): PersonaRuntime | undefined => {
    if (!fleet || ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets)) return undefined;
    return fleet.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER));
  };

  /**
   * A 403 unless the request comes through an owner channel: it carries the
   * owner secret (OWNER_TOKEN_HEADER) and its own identity — never a body
   * `actor` — is the owner. A worker shares the owner's Unix user and loopback,
   * so only the secret, which no worker is handed, tells the two apart; the
   * identity check keeps a tunnel teammate whose requests pass through the
   * console's proxy (which adds the secret) from acting as the owner. Null when
   * the owner may proceed.
   */
  const ownerRefusal = (c: Context, what: string): Response | null => {
    if (!ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets)) {
      return c.json(
        {
          error: `Only the owner can ${what}: this request doesn't carry the owner token (${OWNER_TOKEN_HEADER}). Use the Standup console or Slack as the owner.`,
        },
        403
      );
    }
    if (actingAlias(c) !== ownerAlias) {
      return c.json({ error: `Only the owner (${ownerAlias}) can ${what}.` }, 403);
    }
    return null;
  };

  // Whether a Persona owns this session (its launch belongs to a Persona job)
  // and that Persona — its job owner's — can act for it right now. Such a
  // worker's turn ends wake its Persona, which answers for them; while that
  // Persona is off, paused or failing, its workers surface to the human as usual.
  const personaCanActFor = (owner: string | undefined): boolean => !!owner && !!fleet?.get(owner)?.canAct();
  const personaHandles = (sessionId: string): boolean =>
    personaCanActFor(personaJobForSession(store.db, sessionId)?.job.owner);
  const personaHandlesLaunch = (launchId: string): boolean =>
    personaCanActFor(personaJobForLaunch(store.db, launchId)?.job.owner);

  /**
   * Whether `runtime`'s Persona token may allow the floor hold `ask` (either
   * gate): only in a session its own job owns, and for a guest's runtime only
   * while it carries out the guest's own approved card for exactly this ask,
   * which exists only for a FLOOR_GATE hold under GUEST_FLOOR_SETTING split
   * (guestMayDecideFloor).
   */
  const personaTokenMayAllow = (runtime: PersonaRuntime, ask: { id: string; sessionId: string; gate?: string; question: string }): boolean => {
    const owned = personaJobForSession(store.db, ask.sessionId);
    if (!owned || owned.job.owner !== runtime.owner) return false;
    if (runtime.isHost) return true;
    if (!guestMayDecideFloor(store.db, ask)) return false;
    return listPersonaApprovals(store.db, runtime.owner, "approved").some(
      (a) => a.action === "answer_ask" && a.args.askId === ask.id && !a.approver && a.decidedBy === runtime.owner
    );
  };

  // Who decides the job owner's approval card that holds ask `askId`
  // (ownerCardDecider), if one does.
  const ownerCarded = (askId: string, sessionId: string): string | undefined => {
    const owner = personaJobForSession(store.db, sessionId)?.job.owner;
    return owner ? ownerCardDecider(store.db, owner, askId) : undefined;
  };

  // Every frame this server emits. Ask frames for a session Persona handles,
  // and a new ask on the owner's card, carry `personaHandled`, so the other
  // ask surfaces leave them to Persona or the card; a carded ask also names
  // the card's decider (`cardDecider`), so a surface the card doesn't reach
  // delivers it itself. A steer queued for a worker the idle reaper paused
  // wakes it (wakeOnQueued, set once resuming is wired below), whichever route
  // or stage queued it.
  let wakeOnQueued: ((sessionId: string) => void) | undefined;
  const broadcast: WsBroadcast = (message) => {
    baseBroadcast(withPersonaHandled(message, personaHandles, (askId) => getAsk(store.db, askId)?.sessionId, ownerCarded));
    const queuedFor = queuedWorkSession(message);
    if (queuedFor) wakeOnQueued?.(queuedFor);
  };

  // Settles a permission prompt Persona claimed (claimPendingAsk) whose answer
  // was not typed. While the claim still stands, the prompt goes back to
  // pending so the owner can answer it, or, when its call is over or the
  // safety floor holds it (staleCallReason), it is retired instead. Either
  // way the ask surfaces get the frame they get for any other ask that turns
  // pending or goes away. A failed staleness check leaves it pending.
  const settleUnusedClaim = (askId: string, claimedBy: string): void => {
    if (!reopenClaimedAsk(store.db, askId, claimedBy)) return;
    const reopened = getAsk(store.db, askId);
    if (!reopened) return;
    let stale: string | null = null;
    try {
      stale = staleCallReason(store.db, reopened);
    } catch {
      stale = null;
    }
    if (stale) {
      cancelAsk(store.db, askId);
      broadcast({ type: "ask:resolved", payload: { askId, answer: "" }, timestamp: new Date().toISOString() });
      return;
    }
    broadcast({ type: "ask:new", payload: reopened, timestamp: new Date().toISOString() });
  };

  // The per-request identity adapters, bound to this server's identity config so
  // every `/api` call site resolves identity the same way (and the same way the
  // WS path does). Thin wrappers over the config-parameterized resolvers above —
  // the names the handlers below call.
  // A Persona's own request acts as its owner first (personaRuntimeOf), so a
  // guest's Persona remembers, recalls and launches as the guest.
  const actingAlias = (c: Context, override?: string | null): string =>
    personaRuntimeOf(c)?.owner ?? actingAliasFor(c, config, override);
  // The resolved identity as an author: whose name a write carries and whose
  // own doc it may re-aim. Not a reader of the personal layer (see scopingUser).
  const authorUser = (c: Context): string | undefined => {
    const persona = personaRuntimeOf(c);
    return persona ? persona.owner : scopingUserFor(c, config);
  };
  /**
   * The user whose user-scoped docs (and so whose personal layer) a knowledge
   * read may return, or undefined for global ∪ project only. A worker shares
   * the host's Unix user and loopback, so it can put any alias in the identity
   * header; a non-host alias is therefore believed for reading only with a
   * proof a worker never holds: that user's own runtime (its writer secret or
   * Persona token), an owner channel naming them (the owner secret plus
   * PERSONA_USER_HEADER), or their user channel token. The host — the
   * header-less loopback fallback every worker already resolves to — reads as
   * the host.
   */
  const scopingUser = (c: Context): string | undefined => {
    const persona = personaRuntimeOf(c);
    if (persona) return persona.owner;
    if (ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets)) {
      const named = c.req.header(PERSONA_USER_HEADER)?.trim();
      if (named) return named === ownerAlias || isPersonaAlias(named) ? named : undefined;
    }
    const user = scopingUserFor(c, config);
    if (!user || user === ownerAlias) return user;
    return userChannelTokenMatches(ownerSecrets.ownerToken, user, c.req.header(USER_CHANNEL_HEADER)) ? user : undefined;
  };
  const hasTrustedIdentity = (c: Context): boolean => !!personaRuntimeOf(c) || hasTrustedIdentityFor(c, config);

  const reviewTunnels =
    reviewTunnelsIn ??
    createReviewTunnels(store.db, createReviewTunnelSystem(join(standupDataDir(), "review-tunnels")), (m) => broadcast(m));

  // Resuming a worker the idle reaper paused, on the next message to it: a
  // typed send waits for its prompt (wakeIfReaped); a queued steer or mailbox
  // message also starts its next turn (wakeForQueued).
  // The stop routes close panes through stopLaunchPane and a closed job's
  // hygiene stops registered processes through processSystem.
  const stopLaunchPane =
    lifecycle.stopLaunch ?? ((db: Database, launch: Launch, opts: { pause: boolean }) => stopLaunch(db, launch, undefined, opts));
  const processSystem = lifecycle.processes ?? createProcessSystem();
  const hygieneLiveness = lifecycle.paneAlive ? { paneAlive: lifecycle.paneAlive } : {};
  // A closed job's hygiene once one of its launches is stopped or found not live.
  const hygieneStep = () => closedJobHygieneStep(store.db, processSystem, { installDir: resolveInstallDir(), broadcast, ...hygieneLiveness });
  // A resume that leaves its launch not live runs the closed job's hygiene its hold deferred.
  const resumeDeps: LaunchResumeDeps = {
    broadcast,
    watch: (id) => tailer?.watch(id),
    afterNotLive: hygieneStep(),
    ...hygieneLiveness,
    ...lifecycle.resume,
  };
  const wakeQueued = (sessionId: string) =>
    wakeForQueued(store.db, sessionId, resumeDeps).catch((err) => {
      console.error(`[launch-resume] resuming ${sessionId.slice(0, 8)} failed: ${(err as Error).message}`);
    });
  // Only a paused worker is woken; a resume broadcasts no steer:queued, so this can't recur.
  wakeOnQueued = (sessionId) => {
    const launch = getLaunchBySession(store.db, sessionId);
    if (launch?.reapedAt && launch.status === "running") void wakeQueued(sessionId);
  };

  // The delivery pipeline's effects. The validation stage's criterion is the
  // launch's approved plan-gate criterion, run through evaluatePlanReadyGate so
  // it is floored and reported exactly as on the ready edge (its pass is
  // cached for that edge, but every validation attempt runs it again).
  const pipelineDeps: PipelineDeps = {
    openReviewTunnel: reviewTunnelsEnabled()
      ? (run) => {
          void reviewTunnels.open(run).catch((err) => console.error(`[review-tunnels] opening for run ${run.id} failed:`, err));
        }
      : undefined,
    broadcast: (message) => broadcast(message),
    checkpoint: (sessionId, text) => {
      if (!getSession(store.db, sessionId)) return;
      const checkpoint = createCheckpoint(store.db, sessionId, "structural", text);
      broadcast({ type: "checkpoint:new", payload: checkpoint, timestamp: new Date().toISOString() });
    },
    changedFiles: pipelineOverrides.changedFiles ?? gitChangedFiles,
    headState: pipelineOverrides.headState ?? gitHeadState,
    validateScreenshot: pipelineOverrides.validateScreenshot ?? ((path) => validateScreenshotPath(path)),
    screenshots: pipelineOverrides.screenshots ?? screenshotStore(pipelineScreenshotsDir(standupDataDir())),
    reviewScratchDir: (launchId) => reviewScratchDirFor(reviewDataDir, launchId),
    runCriterion:
      pipelineOverrides.runCriterion ??
      (async (launch) => {
        const gate = getPlanApprovalByLaunch(store.db, launch.id);
        const command = gate?.acceptanceCriterion?.trim();
        if (!gate || gate.status !== "approved" || !command) return null;
        // Each validation attempt judges the work as it is now: a pass cached
        // before a loop back through coding doesn't stand in for this one. A
        // floor hold on it is retried by reporting the validation stage again.
        // A criterion that ran and failed reports what it printed, not the ready gate's refusal.
        const block = await evaluatePlanReadyGate(gate, launch.worktreePath, {
          fresh: true,
          retryHint: "Report the validation stage again once it is allowed.",
          unmetMessage: (output) => output,
        });
        return { command, met: block === null, output: block ?? "acceptance criterion met" };
      }),
    // A check is the owner's configured command: floored like the criterion,
    // run with the same scrubbed environment, and never cached.
    runCheck:
      pipelineOverrides.runCheck ??
      (async (launch, command, timeoutMs) => {
        const cwd = launch.worktreePath;
        if (!cwd) return { met: false, output: "the launch has no worktree to run the check in" };
        const floored = floorOwnerCommand({
          key: `check:${launch.id}`,
          launch,
          cwd,
          command,
          ownerHold: false,
          subject: "validation check",
          retryHint: "Report the validation stage again once it is allowed.",
        });
        if (!floored.run) return { met: false, output: floored.message };
        const { met, output } = await checkAcceptanceCriterion(cwd, command, timeoutMs, scrubCredentialEnv(workerEnv()), drain.signal);
        return { met, output: redactSecrets(output, redactOptionsFor({ projectId: launch.projectId })) };
      }),
  };

  /**
   * A 403 unless the request is a human's through the console: it carries the
   * owner token (which the console's proxy adds for a signed-in browser and no
   * worker is handed) and not Persona's token. Who the human is comes from the
   * request's own identity (actingAlias), so each teammate acts as themself.
   */
  const humanRefusal = (c: Context, what: string): Response | null => {
    if (personaRuntimeOf(c) || c.req.header(PERSONA_TOKEN_HEADER)) {
      return c.json({ error: `Persona's token cannot be used to ${what}` }, 403);
    }
    if (!ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets)) {
      return c.json(
        {
          error: `Only a person can ${what}: this request doesn't carry the owner token (${OWNER_TOKEN_HEADER}). Use the Standup console.`,
        },
        403
      );
    }
    if (actingAlias(c) === ANONYMOUS_ALIAS) return c.json({ error: `An identified user is required to ${what}` }, 403);
    return null;
  };

  /**
   * Hands a code review url just recorded on a ticket to the launch's pipeline
   * (when its run is at its code_review stage). `fromReviewGate`: the project's review gate
   * produced it, so it needs no issue id; a url the worker reported itself
   * needs one (recordReviewUrl).
   */
  const pipelineReviewUrl = (ticket: Ticket, url: string, fromReviewGate: boolean): void => {
    if (!ticket.launchId) return;
    void recordReviewUrl(store.db, ticket.launchId, url, ticket.issueId?.trim() || undefined, pipelineDeps, {
      fromReviewGate,
    }).catch((err) => console.error("[pipeline] recording the review url failed:", err));
  };
  const resolveAgentAudience = (c: Context, projectId: string): ScopeAudience =>
    resolveAgentAudienceFor(projectId, scopingUser(c));
  // The audience an agent's knowledge read applies (search, doc fetch,
  // neighbors): the agent audience plus the project's related projects, so a
  // sibling doc a search returned or a launch injected is also fetchable by id.
  const resolveAgentReadAudience = (c: Context, projectId: string): ScopeAudience => ({
    ...resolveAgentAudience(c, projectId),
    relatedProjectIds: relatedProjects(projectId, getProjects(store.db)),
  });
  // The audience every human-browse read applies: every doc of every project
  // and scope except other users' personal layer (ScopeAudience.browse).
  const resolveBrowseAudience = (c: Context, projectId: string): ScopeAudience => ({
    ...resolveAgentAudience(c, projectId),
    browse: true,
  });
  // Whether `doc` is a personal doc with an owner other than the caller: the
  // browse audience hides it, so no edit or delete may land on it either. An
  // owner-less scope=user doc belongs to nobody and stays recoverable.
  // One answer for every slug a proposal may not take, so it says nothing about
  // what holds the slug.
  const slugUnavailable = (slug: string): string =>
    `the slug "${slug}" is not available for this proposal; propose under another slug`;
  const isAnotherUsersPersonalDoc = (
    c: Context,
    projectId: string,
    doc: { scope?: string; ownerUser?: string; sourceKind?: string; slug?: string }
  ): boolean =>
    !(doc.scope === "user" && !doc.ownerUser) &&
    !isDocInAudience({ ...doc, projectId }, resolveBrowseAudience(c, projectId));
  // Whether the request is Persona's own in-process knowledge write: it
  // carries the runtime's per-boot writer secret (persona/memory-trust.ts).
  const isPersonaWrite = (c: Context): boolean => !!fleet?.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER));
  // The `knowledge:draft` frame for a draft change. A personal draft's slug
  // can name its owner and what it is about, so its frame is addressed to
  // that owner's clients, as `knowledge:change` frames are.
  const personalDraftFrame = (projectId: string, slug: string, owner: string | undefined): WsMessage => ({
    type: "knowledge:draft",
    payload: { projectId, slug },
    timestamp: new Date().toISOString(),
    ...(owner ? { audience: owner } : {}),
  });
  // Why a write may not land in the personal layer, or null: only Persona's
  // own write may create, change or remove a doc there.
  const personalLayerWriteRefusal = (
    c: Context,
    target: { slug: string; requestedScope?: unknown; docs?: ReadonlyArray<PersonalLayerDoc | null | undefined> }
  ): string | null => (isPersonaWrite(c) ? null : personalLayerRefusal(target));

  // Ticket ids with a dispatch in flight RIGHT NOW in this process — the
  // synchronous reservation the /dispatch handler uses to refuse a concurrent
  // double-dispatch. A dispatch's task_run isn't created until after the
  // request body is read (an await that yields the loop), so activeRunForTicket
  // alone can't see an in-flight sibling that hasn't reserved its run yet; this
  // set is checked-and-added in the same synchronous step as that guard, so the
  // second concurrent request always sees the first. The collector is a single
  // process, so an in-memory set is the correct scope; entries are released in
  // the handler's finally.
  const ticketsDispatching = new Set<string>();

  // The knowledge retrieval/graph seam. Search, graph-neighbor lookups, and
  // doc reads all go through this one interface rather than the concrete
  // functions, so a future `backend:"gateway"`/`backend:"cloud"` can replace
  // it with no call-site edits. Today the only implementation is the local
  // markdown + SQLite backend, over the same db every other handler uses.
  const knowledgeBackend = new LocalMarkdownBackend(
    store.db,
    embeddingProvider,
    embeddingConfig,
    knowledgeDir
  );

  // A direct store handle for the stats/graph reads, which are plain aggregates
  // over the schema rather than retrieval — they don't fit the backend seam's
  // search/neighbors surface. Cheap to construct (ensureTables is idempotent).
  const knowledgeStore = new KnowledgeStore(store.db);

  // Sessions moved out of scratch take the scratch docs they (or their
  // subagents) authored with them. Runs in the background: the file moves and
  // resyncs must not hold up the hook or tool call that resolved the project.
  const rehomeKnowledge = (sessionIds: string[], projectId: string): void => {
    if (!knowledgeDir || sessionIds.length === 0) return;
    void rehomeSessionKnowledge(store.db, knowledgeDir, sessionIds, projectId, knowledgeSync)
      .then(({ moved, collisions }) => {
        if (moved.length > 0) {
          console.log(`[knowledge] Moved ${moved.length} scratch doc(s) into ${projectId}: ${moved.join(", ")}`);
        }
        if (collisions.length > 0) {
          console.warn(
            `[knowledge] Left ${collisions.length} scratch doc(s) in scratch; ${projectId} already has ` +
              `that slug: ${collisions.join(", ")}`
          );
        }
      })
      .catch((err) => console.error("[knowledge] scratch doc re-home failed:", err));
  };
  const onSessionRehomed: SessionRehomedListener = (sessionId, projectId) =>
    rehomeKnowledge([sessionId], projectId);

  // Automatic contradiction resolution (roadmap r7). When a NEW `contradicts`
  // edge is flagged (below), a detached resolver reconciles the pair: it
  // auto-applies a non-destructive fix (rescope / merge / supersede-with-
  // tombstone) and records it, or — for a destructive one (superseding a
  // human-authored or high-confidence claim) — records a needs-review entry for
  // a human. Constructed once; only meaningful when the knowledge sync is wired.
  const contradictionResolveDeps: ResolveDeps | null = knowledgeSync
    ? buildResolveDeps({
        db: store.db,
        backend: knowledgeBackend,
        knowledgeDir,
        recordDocVerdict: (pid, slug, verdict, disputes) =>
          knowledgeSync.recordDocVerdict(pid, slug, verdict, disputes),
        clearDocVerdict: (pid, slug) => knowledgeSync.clearDocVerdict(pid, slug),
        syncProject: (pid) => knowledgeSync.syncProject(pid),
        // Production spawns Haiku over the two doc texts + corpus grounding, with
        // no tools and no repo access (untrusted inputs, corpus-written output).
        // Fail-closed to null.
        resolve: (input) => runClaudeContradictionResolver(input),
        // A withheld resolution is a substantive feed line on both surfaces so a
        // human notices the conflict is waiting on their decision.
        onNeedsReview: (record) =>
          emitKnowledgeChange("contradiction", record.projectId, record.loserSlug, record.loserSlug, {
            contradicted: [record.winnerSlug],
          }),
      })
    : null;

  // Projects are edited from the UI now, so every mutation has to push the
  // new list to all connected clients. It carries the same computed counts as
  // GET /api/projects, since the console replaces its list with the payload.
  function broadcastProjects(): void {
    broadcast({
      type: "projects:updated",
      payload: projectsWithCounts(store),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Resolve (idempotently create) the launchable "self" project that
   * propose_standup_improvement targets. Reuses an existing "standup" project
   * when it is already launchable; otherwise upserts one pointing at this
   * collector's own checkout. Never reserved — the whole point is that it IS
   * launchable, so Standup can fix itself.
   */
  function ensureStandupSelfProject(): Project {
    const existing = getProject(store.db, STANDUP_SELF_PROJECT_ID);
    // Anchored + reserved by construction: the repo is ALWAYS this collector's own
    // checkout (never inherited from a drifted row), and `reserved` keeps it out of
    // the launch picker so nobody hand-launches it — the self-fix endpoint launches
    // it directly. We upsert only OUR reserved id, so a user's own "standup"
    // project is never read, reused, mutated, or un-reserved.
    const project: Project = {
      id: STANDUP_SELF_PROJECT_ID,
      name: existing?.name || "Standup (self-fix)",
      emoji: existing?.emoji || "🛠️",
      repos: [STANDUP_SELF_REPO],
      branch: existing?.branch || localTargetBranch(STANDUP_SELF_REPO, undefined, defaultGitRunner),
      // A fresh worktree of the repo needs its deps to build/test the fix.
      setup: existing?.setup || "bun install",
      launchArgs: existing?.launchArgs,
      worktreeRoot: existing?.worktreeRoot,
      reserved: true,
    };
    upsertProject(store.db, project);
    broadcastProjects();
    return project;
  }

  /** The dedup seams over this server's backend. */
  const dedupDeps = {
    search: (pid: string, query: string, options?: SearchOptions) =>
      knowledgeBackend.search(pid, query, options),
    readAcceptedDoc: (pid: string, slug: string) => knowledgeBackend.readAcceptedDoc(pid, slug),
    embeddingsEnabled: knowledgeBackend.embeddingsEnabled,
    getVerdict: (pid: string, slug: string) => knowledgeBackend.getDoc(pid, slug)?.verdict,
  };

  /** How many proposals each session has auto-published today (see knowledge-publish-cap.ts). */
  const autoPublishCap = new AutoPublishCap();

  /**
   * Whether accepting `subject` would duplicate an already-accepted doc visible
   * to `audience` (default: the project's agent audience — its own docs and
   * scope=global ones). `excludeSlugs` drops the doc's own slug (and any it
   * explicitly replaces) so a regenerate is never read as a duplicate of the
   * doc it replaces. Returns the duplicated doc, or null when distinct. No LLM —
   * search + token overlap — so it is cheap enough to run in the request.
   */
  async function findAcceptDuplicate(
    projectId: string,
    subject: DocText,
    excludeSlugs: readonly string[] = [],
    audience: ScopeAudience = { projectId }
  ): Promise<{ dupSlug: string; dupProjectId: string; score: number } | null> {
    try {
      const outcome = await detectDuplicate(dedupDeps, projectId, subject, excludeSlugs, audience);
      return outcome.status === "duplicate"
        ? { dupSlug: outcome.dupSlug, dupProjectId: outcome.dupProjectId, score: outcome.score }
        : null;
    } catch (err) {
      // Dedup is an anti-bloat optimization, never a correctness gate — a search
      // hiccup must not block a human's accept. Fall through as "distinct".
      console.error(`[knowledge-coherence] dedup check ${projectId}/${subject.slug} failed:`, err);
      return null;
    }
  }

  /** The accepted docs nearest `subject` in `audience`; empty when the search fails. */
  async function nearestDocs(
    projectId: string,
    subject: DocText,
    audience: ScopeAudience,
    exclude: readonly string[] = []
  ): Promise<NearestDoc[]> {
    try {
      return await findNearestDocs(dedupDeps, projectId, subject, { audience, exclude });
    } catch (err) {
      console.error(`[knowledge-dedup] nearest docs for ${projectId}/${subject.slug} failed:`, err);
      return [];
    }
  }

  // The contradiction judge every accept-time check uses: the model, retried
  // on error, with every outcome — judge errors included — written to the
  // judgment ledger.
  const baseJudge: ContradictionJudge = knowledgeQuality.judge ?? runClaudeContradictionJudge;
  const contradictionJudge: ContradictionJudge = withJudgmentLog(baseJudge, store.db);

  /** Every existing repo checkout of a project. */
  const projectRepos = (projectId: string): string[] =>
    (getProject(store.db, projectId)?.repos ?? [])
      .map((r) => r.replace(/^~/, homedir()))
      .filter((r) => existsSync(r));

  /**
   * Fire-and-forget contradiction detection over a just-accepted doc: find the
   * accepted docs most similar to it, ask the judge to confirm genuine
   * opposition (within a per-check time budget), and flag the losing side of
   * each confirmed pair. The accept request returns immediately; the flag lands
   * on the docs (and a client nudge) when the judge comes back. No-ops silently
   * when nothing contradicts.
   */
  async function runContradictionCheck(projectId: string, subject: DocText): Promise<void> {
    if (!knowledgeSync) return;
    try {
      const contradictions = await detectContradictions(
        {
          search: (pid, query, options) => knowledgeBackend.search(pid, query, options),
          readAcceptedDoc: (pid, slug) => knowledgeBackend.readAcceptedDoc(pid, slug),
          // The deadline sits inside the ledger, so a pair it leaves unjudged is
          // recorded and queued for re-judging.
          judge: withJudgmentLog(withJudgeDeadline(baseJudge), store.db),
          // Skip a tombstoned (superseded) candidate — a retired loser must not be
          // re-recalled into a fresh conflict.
          getDoc: (pid, slug) => knowledgeBackend.getDoc(pid, slug),
          // Text-only deployments cap rawScore below the hybrid floor, so the
          // candidate floor has to know the search's score scale.
          embeddingsEnabled: knowledgeBackend.embeddingsEnabled,
        },
        projectId,
        subject
      );
      const flagged = flagContradictions(
        {
          recordVerdict: (pid, slug, verdict, disputes) =>
            knowledgeSync.recordDocVerdict(pid, slug, verdict, disputes),
          // Read current verdict/disputes so flagging an opposing doc that is
          // already disputed folds onto its fact-check findings, never clobbers.
          getDoc: (pid, slug) => knowledgeBackend.getDoc(pid, slug),
        },
        projectId,
        subject,
        contradictions
      );
      if (flagged.length > 0) {
        console.log(
          `[knowledge-coherence] ${projectId}/${subject.slug}: flagged ${flagged.join(", ")} as contradicting`
        );
        broadcast({
          type: "knowledge:draft",
          payload: { projectId, slug: subject.slug, contradicted: flagged },
          timestamp: new Date().toISOString(),
        });
        // The knowledge:draft frame above only nudges the sidebar/Knowledge tab
        // to refetch; a confirmed conflict is also a substantive feed line on
        // both surfaces so a human notices it needs resolving.
        emitKnowledgeChange("contradiction", projectId, subject.slug, subject.title, {
          contradicted: flagged,
        });
        // Fire the automatic resolver over each freshly-flagged pair (roadmap
        // r7): it auto-applies a non-destructive fix (rescope / merge /
        // supersede-with-tombstone) and clears the edge, or records a
        // needs-review entry when superseding would touch an owner/high-confidence
        // claim. Detached — this contradiction check is already fire-and-forget.
        if (contradictionResolveDeps) {
          resolveContradictionsAsync(
            contradictionResolveDeps,
            projectId,
            subject.slug,
            contradictions.map((c) => c.slug)
          );
        }
      }
    } catch (err) {
      if (err instanceof ContradictionJudgeError) {
        // Logged per pair (judge_error) and queued for re-judging by the judge
        // wrapper; the doc simply stays unchecked until a judge answers.
        console.warn(`[knowledge-coherence] ${projectId}/${subject.slug}: ${err.message}`);
        return;
      }
      console.error(`[knowledge-coherence] contradiction check ${projectId}/${subject.slug} failed:`, err);
    }
  }

  function checkContradictionsAsync(projectId: string, subject: DocText): void {
    void runContradictionCheck(projectId, subject);
  }

  /**
   * Run contradiction detection over a batch of just-accepted docs (accept-all)
   * without launching them all at once. detectContradictions bounds judge
   * spawns PER doc (MAX_JUDGED), not across a batch, so firing every doc's check
   * concurrently would put dozens of `claude` judge subprocesses live at peak on
   * a large accept-all. Awaiting each in turn holds at most one doc's bounded
   * fan-out live — the same sequential discipline runReverifyContradictionPass
   * uses — while still returning the accept request immediately (fire-and-forget
   * over the whole loop).
   */
  function checkContradictionsBatchAsync(projectId: string, subjects: readonly DocText[]): void {
    if (!knowledgeSync) return;
    void (async () => {
      for (const subject of subjects) {
        await runContradictionCheck(projectId, subject);
      }
    })();
  }

  /** Nudges clients to refetch after sessions are reassigned between projects. */
  function broadcastSessions(): void {
    broadcast({
      type: "session:status",
      payload: {},
      timestamp: new Date().toISOString(),
    });
  }

  // Ticket create + every status transition and field-set (launch/session/
  // reviewUrl/error) is pushed to clients, which upsert by ticket.id. "ticket:new"
  // fires once at propose; everything else is "ticket:updated". Both are treated
  // identically by the web board, so keeping the two events is safe.
  const broadcastTicket = (
    ticket: Ticket,
    type: "ticket:new" | "ticket:updated" = "ticket:updated"
  ): void =>
    broadcast({ type, payload: ticket, timestamp: new Date().toISOString() });

  // Push a review-finding to clients, which upsert by finding.id. "finding:new"
  // fires only for a High/critical finding the auto-reviewer just recorded (the
  // de-noise choke point — low/medium are never pushed); "finding:updated" fires
  // when a human dispatches a fixer for one or dismisses it off the queue.
  const broadcastFinding = (
    finding: ReviewFinding,
    type: "finding:new" | "finding:updated" = "finding:updated"
  ): void =>
    broadcast({ type, payload: finding, timestamp: new Date().toISOString() });

  // Push a plan-approval row to clients so the Work UI's approve/edit affordance
  // appears the moment the agent submits a plan and disappears when a human
  // resolves it. Like ticket/task frames, it just tells the client to refetch
  // the pending set.
  const broadcastPlan = (plan: PlanApproval): void =>
    broadcast({ type: "plan:updated", payload: plan, timestamp: new Date().toISOString() });

  // Surface a TERMINAL state as a substantive feed event. A session's own
  // terminal report (a task run succeeded/failed) and a ticket ship broadcast
  // only task:/ticket: frames — which drive the boards but are not feed rows —
  // so the curated feed would silently omit the highest-value signals (a failed
  // run, a shipped change). Recording a checkpoint routes the terminal moment
  // through the one pipe both feed surfaces already read (the web feed's
  // checkpoint collection and Slack's feedLine), where it classifies as
  // substantive — only `structural` ticks are routine — and so surfaces alone
  // rather than folding into a collapsed run.
  const emitTerminalCheckpoint = (
    sessionId: string,
    source: CheckpointSource,
    summary: string
  ): void => {
    // A checkpoint's session_id is a FK into sessions, but a ticket can carry a
    // session id that was never registered as a Standup session — the decoupled
    // path (report_ticket_status / an external agent claiming a ticket) links an
    // arbitrary reporting session with no sessions row. There is no session to
    // attach the feed row to in that case, so skip rather than fail the FK.
    if (!getSession(store.db, sessionId)) return;
    const checkpoint = createCheckpoint(store.db, sessionId, source, summary);
    broadcast({
      type: "checkpoint:new",
      payload: checkpoint,
      timestamp: new Date().toISOString(),
    });
  };

  // Surface a knowledge-graph mutation (accept / remove / reconcile / flag a
  // contradiction / distill) as a substantive feed item on BOTH feed surfaces —
  // the web curated feed (a `knowledge` FeedItem) and Slack's feedLine. Unlike
  // emitTerminalCheckpoint this is project-scoped, not session-scoped, so a
  // change with no authoring session (an ingested doc, a human removal, a
  // cron-flagged contradiction) still surfaces. The `knowledge:draft` nudge
  // stays separate — it only tells the sidebar/Knowledge tab to refetch. The
  // shared emitter persists before broadcasting, so every emit path (this
  // request-handling server and the entrypoint crons) is durable at one choke
  // point — the feed row survives a reload/reconnect instead of living only on
  // the wire.
  const emitKnowledgeChange = makeKnowledgeChangeEmitter(store.db, broadcast);

  /**
   * Publishes a pending draft as accepted knowledge — the shared "plain accept"
   * path for a first-bootstrap draft (no replaces_slug) and an explicit replace.
   * Both the human single-draft accept route and propose's auto-accept default
   * call this, so the publish logic lives in exactly one place. It deliberately
   * does NOT handle merge: merging folds a regenerated draft into a
   * human-authored doc and needs a human-combined body, which only the accept
   * route has — that stays inline there.
   *
   * Mirrors the accept route step for step: dedup-suppress a fresh duplicate
   * (roadmap r7), move the draft file into place, resync the project + drafts,
   * clear any stale re-verification verdict, broadcast, emit the `accepted` feed
   * transition, and fire the fire-and-forget contradiction check. Returns what
   * happened so callers can report it. A draft that already names an accepted doc
   * (replaces_slug set) publishes as a straight replace — the plain rename
   * overwrites the doc of the same name.
   */
  async function publishDraft(
    projectId: string,
    slug: string,
    options: PublishOptions = {}
  ): Promise<
    | { published: true; mode: "accept" | "replace" }
    | { published: false; reason: "duplicate"; dupSlug: string; dupProjectId: string }
    | { published: false; reason: "not-found" }
  > {
    const draft = knowledgeSync?.getDraft(projectId, slug);
    if (!draft) return { published: false, reason: "not-found" };

    const replacing = !!draft.replacesSlug;

    // A replace overwrites an existing accepted doc, and acceptDraftFile is a plain
    // rename — so a replacement DRAFT that carries no scope of its own (e.g. an
    // ingest-url regenerate) would land the accepted file with no scope and the
    // loader would reset it to the 'project' default, silently widening a
    // scope='user' doc to the whole project (or demoting a 'global' doc). scope/owner
    // are the target's RETRIEVAL AUDIENCE, so a body-only regenerate must preserve
    // them. Capture the target's audience now; after the rename, restore it only when
    // the published file asserts NO scope of its own — a draft that DID assert one
    // (the propose path stamps one through resolveAuthoredAudience) keeps it, so this
    // never overrides a deliberate, already-gated audience.
    const priorAudience = replacing
      ? await knowledgeBackend.readAcceptedDoc(projectId, slug)
      : null;

    // Only a fresh draft (nothing to replace) is dedup-checked: a copy that
    // duplicates a doc the corpus already has is suppressed rather than added, so
    // the self-growing corpus doesn't bloat with a redundant doc at a new slug. A
    // replace deliberately targets an existing doc, so it is not a duplicate to
    // suppress.
    if (!replacing && !options.skipDedup) {
      const dup = await findAcceptDuplicate(
        projectId,
        { slug: draft.slug, title: draft.title, body: draft.body },
        [],
        options.audience
      );
      // The draft is kept: a near-duplicate is reported for whoever is
      // publishing to decide on, never discarded on their behalf.
      if (dup) {
        return { published: false, reason: "duplicate", dupSlug: dup.dupSlug, dupProjectId: dup.dupProjectId };
      }
    }

    // Fresh and replace are both a plain move of the draft file into place —
    // propose stamps replaces_slug === slug, so a replace overwrites the accepted
    // doc of the same name.
    const moved = await acceptDraftFile(knowledgeDir, projectId, slug);
    if (!moved) return { published: false, reason: "not-found" };

    // Restore the target doc's audience when the replacement draft carried none of
    // its own (see priorAudience above). Read the freshly-published file raw: a
    // scope of undefined means the draft asserted none, so re-stamp the prior
    // scope/owner via a frontmatter patch (which preserves the provenance the rename
    // just carried up) rather than let the loader default it to 'project'.
    if (priorAudience?.scope) {
      const published = await readKnowledgeFile(knowledgeDir, projectId, slug);
      if (published && published.scope === undefined) {
        await updateDocFrontmatter(knowledgeDir, projectId, slug, {
          scope: priorAudience.scope,
          ...(priorAudience.ownerUser ? { owner_user: priorAudience.ownerUser } : {}),
        });
      }
    }

    await knowledgeSync?.syncProject(projectId);
    // A human-accepted body is asserted current — clear any verdict the
    // re-verification cron recorded against a prior body. An agent's update of
    // its own doc asserts nothing: its contradiction and fact-check findings stay
    // until the edges are re-judged and the new body is fact-checked.
    const keepHistory = replacing && options.keepVerdictHistory;
    if (!keepHistory) knowledgeSync?.clearDocVerdict(projectId, slug);
    await knowledgeSync?.syncDrafts(projectId);
    broadcastProjects();
    broadcast(personalDraftFrame(projectId, slug, draft.scope === "user" ? draft.ownerUser : undefined));

    // A playbook is the owner's own method, not a claim about any repo or a
    // peer of the shared corpus: it is neither fact-checked nor weighed against
    // other docs, so it can never flag, demote or rewrite one, nor be
    // rewritten by one.
    if (draft.sourceKind === PLAYBOOK_SOURCE_KIND) return { published: true, mode: replacing ? "replace" : "accept" };

    const authoringSessionId = draft.generatedByLaunchId
      ? getLaunch(store.db, draft.generatedByLaunchId)?.sessionId ?? undefined
      : undefined;
    emitKnowledgeChange("accepted", projectId, slug, draft.title, {
      sessionId: authoringSessionId,
    });
    // Started before the contradiction check, so a conflict found meanwhile sees
    // the doc's fact-check as in flight and is not resolved against it.
    await settlePublishedVerification(projectId, slug, draft.verdict, options.verifyRepo);
    if (keepHistory) {
      // Sequenced so the edges carried over are re-judged before the new body's
      // own contradiction check folds anything new onto it.
      void (async () => {
        await rejudgeContradictionEdges(projectId, slug);
        await runContradictionCheck(projectId, { slug, title: draft.title, body: draft.body });
      })();
    } else {
      checkContradictionsAsync(projectId, { slug, title: draft.title, body: draft.body });
    }

    return { published: true, mode: replacing ? "replace" : "accept" };
  }

  /** Raises a doc to full confidence verified as of now. */
  async function stampVerified(projectId: string, slug: string): Promise<void> {
    await updateDocFrontmatter(knowledgeDir, projectId, slug, {
      confidence: INITIAL_CONFIDENCE,
      last_verified_at: new Date().toISOString(),
    });
    await knowledgeSync?.syncProject(projectId);
  }

  /**
   * After a publish: a pending agent doc whose draft already passed its
   * fact-check (a reviewed draft) is stamped verified now; otherwise, with a
   * checkout of its project to check against, its fact-check runs in the
   * background, and without one the doc is recorded unverifiable.
   */
  async function settlePublishedVerification(
    projectId: string,
    slug: string,
    draftVerdict: string | undefined,
    verifyRepo: VerificationRepo | undefined
  ): Promise<void> {
    const doc = await knowledgeBackend.readAcceptedDoc(projectId, slug);
    if (!isPendingVerification(doc)) return;
    if (draftVerdict === "clean") {
      await stampVerified(projectId, slug);
      return;
    }
    const target = verifyRepo ?? docVerificationRepo(projectId, doc!.body, doc!.sourceSessionId);
    if (target.repo !== null) {
      verifyPublishedAsync(projectId, slug, doc!.body, target.repo, target.additionalRepos, target.namedRepos);
    }
    else recordUnverifiable(publishVerifyDeps, projectId, slug, target.reason);
  }

  /** The checkout(s) an accepted doc is fact-checked against, resolved from the
   *  doc: its project's, or for a global/scratch doc, those of its source
   *  session's project and of the projects its body names. */
  function docVerificationRepo(projectId: string, body: string, sourceSessionId: string | undefined): VerificationRepo {
    return resolveVerificationRepo({
      targetProject: projectId,
      sourceProject: sourceSessionProject(store.db, sourceSessionId),
      body,
      ...dbVerificationInputs(store.db),
    });
  }

  /** The publish fact-check's seams over this server's backend. */
  const publishVerifyDeps: PublishVerifyDeps = {
    verify: (slug, body, repoPath, additionalRepos) => publishVerifier(slug, body, repoPath, additionalRepos),
    readAcceptedDoc: (pid, slug) => knowledgeBackend.readAcceptedDoc(pid, slug),
    currentDisputes: (pid, slug) => knowledgeBackend.getDoc(pid, slug)?.disputes ?? [],
    stampVerified,
    recordVerdict: (pid, slug, verdict, disputes, repoPath) =>
      knowledgeSync?.recordDocVerdict(pid, slug, verdict, disputes, repoPath),
    otherRepos: (pid) => projectRepos(pid),
    recordAttempt: (pid, slug, body, outcome, repoPath) =>
      recordVerificationAttempt(store.db, pid, slug, body, outcome, repoPath),
  };

  /** Fact-checks a just-published agent doc in the background (see
   *  knowledge-publish-verify.ts) and nudges clients with the result. */
  function verifyPublishedAsync(
    projectId: string,
    slug: string,
    body: string,
    repoPath: string,
    additionalRepos: string[] = [],
    namedRepos?: string[]
  ): void {
    // The checkout the doc was checked against, for a later retry.
    recordVerificationRepo(store.db, projectId, slug, body, repoPath);
    void verifyPublishedDoc(publishVerifyDeps, projectId, slug, body, repoPath, additionalRepos, namedRepos)
      .then(({ outcome, disputes }) => {
        if (outcome !== "clean" && outcome !== "disputed") return;
        broadcast({
          type: "knowledge:draft",
          payload: { projectId, slug, verdict: outcome, disputes },
          timestamp: new Date().toISOString(),
        });
      })
      .catch(() => {
        // The check outlives the request; a store closed meanwhile has nowhere
        // to record the result.
      });
  }

  /**
   * Re-judges each contradiction a doc carried into an update: the new body
   * against every doc its `Contradicts <slug>` disputes name. An edge the judge
   * now finds consistent is cleared from both docs; one it still confirms, or
   * could not judge, stays.
   */
  async function rejudgeContradictionEdges(projectId: string, slug: string): Promise<void> {
    if (!knowledgeSync) return;
    try {
      const doc = await knowledgeBackend.readAcceptedDoc(projectId, slug);
      const others = (knowledgeBackend.getDoc(projectId, slug)?.disputes ?? [])
        .map((d) => parseContradictsClaim(d.claim))
        .filter((o): o is string => o !== null);
      if (!doc) return;
      for (const other of new Set(others)) {
        const otherDoc = await knowledgeBackend.readAcceptedDoc(projectId, other);
        if (!otherDoc) continue;
        const judgment = await contradictionJudge(
          { slug, title: doc.title, body: doc.body, projectId },
          { slug: other, title: otherDoc.title, body: otherDoc.body, projectId }
        );
        if (judgment.error !== undefined || judgment.contradicts) continue;
        for (const [a, b] of [
          [slug, other],
          [other, slug],
        ] as const) {
          const cleared = clearContradictionEdge(knowledgeBackend.getDoc(projectId, a), b);
          if (cleared.verdict === null) knowledgeSync.clearDocVerdict(projectId, a);
          else knowledgeSync.recordDocVerdict(projectId, a, cleared.verdict, cleared.disputes);
        }
      }
    } catch (err) {
      console.error(`[knowledge-coherence] re-judging ${projectId}/${slug} failed:`, err);
    }
  }

  /**
   * Pushes a launch row to clients — fired by launchSession's onUpdate at
   * creation (status "starting") and again when the background provisioning
   * work lands (running/failed). Every launch: event just tells the client to
   * refetch, so this both surfaces a launch immediately and updates its state.
   */
  const broadcastLaunch = (launch: Launch): void => {
    broadcast({
      type: "launch:started",
      payload: launch,
      timestamp: new Date().toISOString(),
    });

    // An implementation launch that fails in the background (after the approve
    // response already returned) surfaces its error on the ticket and leaves it
    // in `approved` — the ticket only advances to developing when a session
    // actually attaches, so a failed launch never got there. The human can
    // dismiss it. DEFERRED: auto-retry.
    if (launch.status === "failed") {
      const t = getTicketByLaunch(store.db, launch.id);
      if (t && t.status === "approved") {
        setTicketError(store.db, t.id, launch.error ?? "launch failed");
        broadcastTicket(getTicket(store.db, t.id)!);
      }
    }
  };

  // Every route's Host, site and off-machine credential checks (caller-guard.ts),
  // ahead of every route. The credential is any proof a caller already sends.
  app.use(
    "*",
    callerGuard({
      hasCredential: (c) => {
        const writeToken = c.req.header("x-standup-write-token");
        const identity = c.req.header(config.userIdentifier.header)?.trim();
        return (
          ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets) ||
          !!personaRuntimeOf(c) ||
          (!!identity && userChannelTokenMatches(ownerSecrets.ownerToken, identity, c.req.header(USER_CHANNEL_HEADER))) ||
          tokenMatches(writeToken, localWriteToken) ||
          tokenMatches(writeToken, process.env.STANDUP_WRITE_TOKEN) ||
          !!launchForWorkerToken(store.db, c.req.header(WORKER_TOKEN_HEADER)) ||
          hasTrustedIdentityFor(c, config) ||
          (c.req.path === "/hook" && !!liveLaunchForHookToken(store.db, c.req.header(HOOK_TOKEN_HEADER)))
        );
      },
    })
  );

  // CORS for local development
  app.use("/*", cors({ origin: [...CORS_ORIGINS] }));

  // Record the acting user on every API request. Behind the tunnel this is the
  // visitor's alias (the identity header); off-tunnel it's the host user.
  // A cheap upsert (see the users table) whose first_seen/last_seen bracket a
  // teammate's activity — the identity foundation owner/participants build on.
  // Scoped to /api so the frequent local /hook traffic doesn't churn the row.
  app.use("/api/*", async (c, next) => {
    const header = c.req.header(config.userIdentifier.header)?.trim();
    const alias = actingAlias(c);
    // viaTunnel only when the header was actually honored — an untrusted
    // network source's header is ignored (alias falls to anonymous/$USER), so
    // it must not inflate the multiplayer count as a real tunnel visitor.
    touchUser(store.db, alias, { viaTunnel: !!header && alias === header });
    await next();
  });

  // Health check
  // `pid` lets a restart supervisor tell the collector it started from the one
  // it stopped, and the gateway match it to the leader file; slot, epoch and
  // head identify the leadership term and the code it runs.
  app.get("/health", (c) => c.json({ status: "ok", pid: process.pid, ...lifecycle.health }));

  // Who "me" is for this request — the resolved alias, whether it came from the
  // tunnel, and the stored users row. The UI reads this to label actions and
  // presence; the same alias rides the WS hello-ok frame (see ws.ts).
  app.get("/api/whoami", (c) => {
    const header = c.req.header(config.userIdentifier.header)?.trim();
    const user = actingAlias(c);
    // `tunnel` reflects a HONORED tunnel identity — the header resolved to the
    // acting user — not merely a header being present, since an untrusted
    // source's header is ignored (see actingAlias / resolveUserAlias).
    const viaTunnel = !!header && user === header;
    const record = touchUser(store.db, user, { viaTunnel });
    return c.json({ user, tunnel: viaTunnel, record } satisfies WhoAmI);
  });

  // Per-user profile — "a CLAUDE.md for each user", keyed by the acting alias
  // (the tunnel-injected alias, else the host user). Stored in the shared
  // DB so it follows the user across the gateway; the launcher injects it into
  // the opening prompt of the sessions that user launches.
  //
  // `?project=<id>` selects the per-(user, project) OVERLAY (§H) instead of the
  // global profile — "your instructions for <project>", layered on top of the
  // global one at launch (see getEffectiveUserPrefs). Omit it for the global
  // §A profile. Either way GET returns an empty-but-shaped profile for a user
  // who has never saved one, so the settings form always has something to bind
  // to. Both are the raw stored layer, NOT the merged view — the editor edits
  // one layer at a time.
  app.get("/api/users/me/prefs", (c) => {
    const alias = actingAlias(c);
    const projectId = c.req.query("project")?.trim();
    if (projectId) {
      const overlay =
        getUserProjectPrefs(store.db, alias, projectId) ??
        ({ alias, projectId, updatedAt: new Date() } satisfies UserPrefs);
      return c.json(overlay);
    }
    const prefs =
      getUserPrefs(store.db, alias) ??
      ({ alias, updatedAt: new Date() } satisfies UserPrefs);
    return c.json(prefs);
  });

  // Full-replace PUT — an omitted field clears it (see putUserPrefs), so the
  // settings form is the single source of the stored value. The deploy target
  // is stored as CONTEXT (account/role/command) only; no credentials are kept.
  app.put("/api/users/me/prefs", async (c) => {
    const header = c.req.header(config.userIdentifier.header);
    // A profile write injects into the owner's future sessions, and the
    // profile-write path is a CROSS-USER write not yet migrated to the tunnel
    // identity + acting===owner authorization knowledge authoring now uses. So it
    // conservatively keeps the token gate: when STANDUP_WRITE_TOKEN is configured
    // the caller must present a matching x-standup-write-token for ANY write; with
    // no token a loopback bind trusts the request ONLY in the single-user default;
    // once the collector is in multiplayer mode (≥2 people) it refuses every write
    // (fail closed) until the token is set, as does a network-exposed bind. See
    // isTrustedProfileWrite.
    if (
      !isTrustedProfileWrite(
        header,
        undefined,
        c.req.header("x-standup-write-token"),
        undefined,
        isMultiplayerMode(store.db)
      )
    ) {
      return c.json(
        {
          error:
            "profile writes to a shared/multiplayer or network-exposed collector require the " +
            "out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN); the " +
            `${config.userIdentifier.header} header is not trusted here`,
        },
        403
      );
    }
    // The profile owner is the request's acting identity under the same
    // source-trust check every `/api` path uses: an identity header from a
    // source the tunnel provider doesn't vouch for (and that isn't a trusted
    // proxy) is not believed. A request with no trusted identity has no
    // profile to write, so it is refused rather than stored under `anonymous`.
    const alias = actingAlias(c);
    if (alias === ANONYMOUS_ALIAS) {
      return c.json(
        {
          error:
            "profile writes need a trusted identity; the " +
            `${config.userIdentifier.header} header is not trusted from this source`,
        },
        403
      );
    }
    // `?project=<id>` writes the per-(user, project) OVERLAY (§H); omit it for
    // the global §A profile. The overlay's project_id has a FK on projects, so a
    // write for an unknown project is rejected 404 rather than surfacing a raw
    // constraint error.
    const projectId = c.req.query("project")?.trim();
    if (projectId && !getProject(store.db, projectId)) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }
    // Because the write is a full replace, coercing a parse failure to {}
    // would silently WIPE the saved profile and return 200 — a transport/client
    // error indistinguishable from an intentional clear. So a malformed/empty
    // body (or a non-object JSON value) is rejected as 400; an intentional clear
    // is still an explicit `{}` object, which parses and replaces as before.
    let body: {
      personalInstructions?: string;
      reviewRigor?: string;
      deployTarget?: DeployTarget;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const input = {
      personalInstructions: body.personalInstructions,
      reviewRigor: body.reviewRigor,
      deployTarget: body.deployTarget,
    };
    const prefs = projectId
      ? putUserProjectPrefs(store.db, alias, projectId, input)
      : putUserPrefs(store.db, alias, input);
    return c.json(prefs);
  });

  // ============================================================================
  // Orchestration profiles — named, scoped develop → deploy → review workflows
  // at global / personal / project scope. The owner_key a profile is stored
  // under is derived SERVER-SIDE from the scope + the acting alias + a projectId
  // param (never a client-supplied owner): global => `__global__`, personal =>
  // the acting alias, project => the project id. Writes clear the same
  // trusted-profile / write-token gate as the per-user profile writes.
  // ============================================================================

  /** Validates the `scope` query/body value, else null. */
  const parseScope = (raw: unknown): OrchestrationScope | null =>
    raw === "global" || raw === "personal" || raw === "project" ? raw : null;

  /**
   * Fails a write with the same gate as PUT /api/users/me/prefs — a matching
   * write token on a shared/multiplayer or network-exposed collector, else a
   * single-user loopback. Returns the 403 Response to send, or null to proceed.
   */
  const denyOrchestrationWrite = (c: Context): Response | null => {
    if (
      isTrustedProfileWrite(
        c.req.header(config.userIdentifier.header),
        undefined,
        c.req.header("x-standup-write-token"),
        undefined,
        isMultiplayerMode(store.db)
      )
    ) {
      return null;
    }
    return c.json(
      {
        error:
          "orchestration writes to a shared/multiplayer or network-exposed collector require " +
          "the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN); the " +
          `${config.userIdentifier.header} header is not trusted here`,
      },
      403
    );
  };

  /**
   * Resolves the owner key for a scope from the acting identity + a projectId,
   * validating the project exists for project scope. Returns the key, or a
   * Response to send on a bad/unknown scope/project.
   */
  const resolveOrchestrationOwner = (
    c: Context,
    scope: OrchestrationScope,
    projectId: string | undefined
  ): { ownerKey: string } | { error: Response } => {
    if (scope === "project") {
      if (!projectId) return { error: c.json({ error: "project scope requires projectId" }, 400) };
      if (!getProject(store.db, projectId)) {
        return { error: c.json({ error: `Unknown project: ${projectId}` }, 404) };
      }
    }
    return { ownerKey: ownerKeyFor(scope, { alias: actingAlias(c), projectId }) };
  };

  // The profiles for the resolved owner at a scope. `?scope=` is required;
  // `?projectId=` is required for project scope.
  app.get("/api/orchestration/profiles", (c) => {
    const scope = parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be one of: global, personal, project" }, 400);
    const projectId = c.req.query("projectId")?.trim() || undefined;
    const owner = resolveOrchestrationOwner(c, scope, projectId);
    if ("error" in owner) return owner.error;
    return c.json({ profiles: listProfiles(store.db, { scope, ownerKey: owner.ownerKey }) });
  });

  // Upsert a profile — a full replace of its definition, keyed on
  // (scope, owner, name). Body: { name, scope, projectId?, definition }.
  app.put("/api/orchestration/profiles", async (c) => {
    const denied = denyOrchestrationWrite(c);
    if (denied) return denied;

    let body: {
      name?: string;
      scope?: string;
      projectId?: string;
      definition?: {
        steps?: OrchestrationStep[];
        maxReviewRounds?: number;
        blockOnSeverity?: "high" | "medium";
      };
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const scope = parseScope(body.scope);
    if (!scope) return c.json({ error: "scope must be one of: global, personal, project" }, 400);
    const name = body.name?.trim();
    if (!name) return c.json({ error: "name is required" }, 400);
    const projectId = body.projectId?.trim() || undefined;
    const owner = resolveOrchestrationOwner(c, scope, projectId);
    if ("error" in owner) return owner.error;

    const definition = body.definition ?? {};
    const profile: OrchestrationProfile = {
      name,
      scope,
      steps: Array.isArray(definition.steps) ? definition.steps : [],
      maxReviewRounds: definition.maxReviewRounds,
      blockOnSeverity: definition.blockOnSeverity,
    };
    const valid = validateOrchestrationProfileDefinition(profile);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
    return c.json(upsertProfile(store.db, scope, owner.ownerKey, profile));
  });

  // Delete a profile by scope + name. `?projectId=` is required for project scope.
  app.delete("/api/orchestration/profiles/:scope/:name", (c) => {
    const denied = denyOrchestrationWrite(c);
    if (denied) return denied;

    const scope = parseScope(c.req.param("scope"));
    if (!scope) return c.json({ error: "scope must be one of: global, personal, project" }, 400);
    const name = decodeURIComponent(c.req.param("name"));
    const projectId = c.req.query("projectId")?.trim() || undefined;
    const owner = resolveOrchestrationOwner(c, scope, projectId);
    if ("error" in owner) return owner.error;
    deleteProfile(store.db, scope, owner.ownerKey, name);
    return c.json({ ok: true });
  });

  // The scoped DEFAULT profile name a launch adopts (the name only, resolved per
  // scope). `?scope=` required; `?projectId=` required for project scope.
  app.get("/api/orchestration/default", (c) => {
    const scope = parseScope(c.req.query("scope"));
    if (!scope) return c.json({ error: "scope must be one of: global, personal, project" }, 400);
    const projectId = c.req.query("projectId")?.trim() || undefined;
    let name: string | null;
    if (scope === "project") {
      if (!projectId) return c.json({ error: "project scope requires projectId" }, 400);
      if (!getProject(store.db, projectId)) {
        return c.json({ error: `Unknown project: ${projectId}` }, 404);
      }
      name = getProjectDefaultProfile(store.db, projectId);
    } else if (scope === "personal") {
      name = getPersonalDefaultProfile(store.db, actingAlias(c));
    } else {
      name = getGlobalDefaultProfile(store.db);
    }
    return c.json({ scope, projectId: projectId ?? null, name });
  });

  // Set (or clear, with name: null) the scoped default profile: project => the
  // projects column, personal => the user_prefs field, global => the setting.
  app.put("/api/orchestration/default", async (c) => {
    const denied = denyOrchestrationWrite(c);
    if (denied) return denied;

    let body: { scope?: string; projectId?: string; name?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "request body must be a JSON object" }, 400);
    }
    const scope = parseScope(body.scope);
    if (!scope) return c.json({ error: "scope must be one of: global, personal, project" }, 400);
    const projectId = body.projectId?.trim() || undefined;
    // A blank/whitespace name clears the default (null), never stores an empty name.
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;

    if (scope === "project") {
      if (!projectId) return c.json({ error: "project scope requires projectId" }, 400);
      if (!getProject(store.db, projectId)) {
        return c.json({ error: `Unknown project: ${projectId}` }, 404);
      }
      setProjectDefaultProfile(store.db, projectId, name);
    } else if (scope === "personal") {
      setPersonalDefaultProfile(store.db, actingAlias(c), name);
    } else {
      setGlobalDefaultProfile(store.db, name);
    }
    return c.json({ scope, projectId: projectId ?? null, name });
  });

  // Kick off the bounded develop -> deploy -> review loop for a ticket. Resolves
  // the ticket's active profile + its implementing worktree, creates (or reuses)
  // the run row so its id is in the response, then drives the loop ASYNCHRONOUSLY
  // off the request path — deploys, review rounds, and fixer sessions never block
  // this response. The completion choke (orchestrationReadyBlockForTicket) flips
  // to allow once this run reaches `succeeded`.
  app.post("/api/orchestration/runs", async (c) => {
    const denied = denyOrchestrationWrite(c);
    if (denied) return denied;

    let body: { ticketId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    const ticketId = body?.ticketId?.trim();
    if (!ticketId) return c.json({ error: "ticketId is required" }, 400);

    const ticket = getTicket(store.db, ticketId);
    if (!ticket) return c.json({ error: `Unknown ticket: ${ticketId}` }, 404);

    const alias = authorUser(c);
    const profile = resolveActiveProfile(store.db, {
      projectId: ticket.projectId,
      alias,
    });
    if (!profile) {
      return c.json({ error: "No orchestration profile resolves for this ticket." }, 409);
    }

    // The change lives in the ticket's implementing launch's worktree — the tree
    // gates/deploys run in and the review diff is taken from.
    const implementing = ticket.launchId ? getLaunch(store.db, ticket.launchId) : undefined;
    const cwd = implementing?.worktreePath;
    if (!cwd) {
      // Clarity fix (M4): the completion choke demands a passing run, yet this
      // 409s when the implementing worktree is gone (never launched, or pruned).
      // v1's recovery is to re-launch the ticket, which recreates a worktree —
      // say so rather than leave an opaque, un-actionable lockout.
      return c.json(
        {
          error:
            "Ticket has no implementing worktree to run orchestration in — " +
            "launch or re-launch the ticket to create one, then retry the run.",
        },
        409
      );
    }
    const baseBranch = implementing?.baseBranch?.trim() || getProject(store.db, ticket.projectId)?.branch;

    // Create (or reuse) the run synchronously so its id rides back on this
    // response; then drive the loop detached. runOrchestrationForTicket reuses
    // this same row rather than minting a second.
    const run = ensureOrchestrationRun(store.db, { ticket, profile, alias });
    void runOrchestrationForTicket(store.db, {
      ticketId,
      profile,
      cwd,
      baseBranch,
      alias,
    }).catch((err) => {
      console.error(`[orchestration] run for ticket ${ticketId} failed:`, err);
      // The detached controller rejected before the loop could terminate the run
      // itself — left alone the run would sit queued/running forever and lock the
      // completion choke permanently. Mark it failed so the agent can re-POST to
      // retry. Guard on a still-active status: the loop may have already reached a
      // terminal state, and re-transitioning a terminal run would throw.
      const stranded = getOrchestrationRun(store.db, run.id);
      if (stranded && (stranded.status === "queued" || stranded.status === "running")) {
        updateOrchestrationRunStatus(store.db, run.id, "failed", { error: String(err) });
      }
    });

    return c.json({ run });
  });

  // ============================================================================
  // Global settings, kept in their own small key/value table (see migration
  // 006) rather than env vars, so they can change live without a collector
  // restart.
  // ============================================================================
  app.get("/api/settings", (c) => {
    // Read the version BEFORE the values so it can only under-count a concurrent
    // write, never over-count: the values a caller reads are always at least as
    // fresh as this version, so a caller that adopts a snapshot whose version has
    // reached its own last write is guaranteed to see that write (never a value
    // that predates it) — the property the Slack adapter's reconcile relies on.
    const settingsVersion = getSettingsVersion(store.db);
    return c.json({
      // On by default — the cheap per-session Haiku title upgrade.
      titleSummary: isTitleSummaryEnabled(store.db),
      // "" (not null) so the client can render an empty input rather than
      // guessing; empty means "fall back to env/default" at launch time.
      worktreeRoot: getSetting(store.db, WORKTREE_ROOT_SETTING) ?? "",
      // "" when the Slack feed is off; a channel id (`C…`) when enabled.
      slackFeedChannel: getSetting(store.db, SLACK_FEED_CHANNEL_SETTING) ?? "",
      // "" if no ask recipient yet; a user id (`U…`) the adapter learned from a DM.
      slackAskUser: getSetting(store.db, SLACK_ASK_USER_SETTING) ?? "",
      // "" when every channel is all-on; else a JSON blob of per-channel toggles.
      slackChannelFeatures: getSetting(store.db, SLACK_CHANNEL_FEATURES_SETTING) ?? "",
      // Whether the launch default is currently the multiplayer-safe fresh
      // worktree (so the composer can pre-set its in-place toggle to match),
      // plus the raw manual override ("on"/"off"/"" = auto) driving it.
      multiplayer: isMultiplayerMode(store.db),
      multiplayerOverride: getSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING) ?? "",
      // Monotonic version of the whole settings blob, so a poller can tell a fresh
      // snapshot from one that predates its own last write (see settings.ts).
      settingsVersion,
    });
  });

  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // Where worktrees are created and whether launches run in place both shape
    // what a launch touches, so changing them is the owner's.
    const worktreeRootChange =
      typeof body.worktreeRoot === "string" &&
      body.worktreeRoot.trim() !== (getSetting(store.db, WORKTREE_ROOT_SETTING) ?? "");
    const multiplayerChange =
      typeof body.multiplayerOverride === "string" &&
      (body.multiplayerOverride.trim() === "on" || body.multiplayerOverride.trim() === "off"
        ? body.multiplayerOverride.trim()
        : "") !== (getSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING) ?? "");
    if (worktreeRootChange || multiplayerChange) {
      const refused = ownerRefusal(
        c,
        `change ${[worktreeRootChange && "worktreeRoot", multiplayerChange && "multiplayerOverride"].filter(Boolean).join(" and ")}`
      );
      if (refused) return refused;
    }
    if (typeof body.titleSummary === "boolean") {
      setTitleSummaryEnabled(store.db, body.titleSummary);
    }
    // A string (including "") sets it; "" clears the override, restoring the
    // env/default fallback. Trimmed so stray whitespace doesn't become a path.
    if (typeof body.worktreeRoot === "string") {
      setSetting(store.db, WORKTREE_ROOT_SETTING, body.worktreeRoot.trim());
    }
    // "" turns the Slack feed off; a channel id turns it on.
    if (typeof body.slackFeedChannel === "string") {
      setSetting(store.db, SLACK_FEED_CHANNEL_SETTING, body.slackFeedChannel.trim());
    }
    // "" clears the ask recipient; a user id sets whom the adapter DMs for asks.
    if (typeof body.slackAskUser === "string") {
      setSetting(store.db, SLACK_ASK_USER_SETTING, body.slackAskUser.trim());
    }
    // A JSON blob of per-channel toggles; "" restores the all-on default. Stored
    // verbatim (the adapter parses it and fails open on anything malformed). This
    // whole-blob replace is retained for a full external rewrite (e.g. the web UI).
    if (typeof body.slackChannelFeatures === "string") {
      setSetting(store.db, SLACK_CHANNEL_FEATURES_SETTING, body.slackChannelFeatures.trim());
    }
    // A per-channel DELTA (set/clear) applied on top of the CURRENT blob. The
    // adapter sends only the channel a command touched, so an overlapping command
    // on another channel — or a concurrent external per-channel edit — is preserved
    // instead of being clobbered by a whole-blob write built from a stale snapshot.
    // The read-merge-write runs synchronously here, so two concurrent patches apply
    // in series (no lost update) even though they arrive on overlapping requests.
    if (body.slackChannelFeaturesPatch && typeof body.slackChannelFeaturesPatch === "object") {
      const current = parseChannelFeatureMap(getSetting(store.db, SLACK_CHANNEL_FEATURES_SETTING));
      const merged = mergeChannelFeaturesPatch(current, body.slackChannelFeaturesPatch as ChannelFeaturesPatch);
      // "" (not "{}") when the merge leaves no overrides, so the empty state matches
      // the all-on default the readers already treat as "no blob".
      const keys = Object.keys(merged);
      setSetting(store.db, SLACK_CHANNEL_FEATURES_SETTING, keys.length ? JSON.stringify(merged) : "");
    }
    // "on"/"off" force the multiplayer launch default; "" (or any other value)
    // clears the override, restoring auto-detection by distinct-user count.
    if (typeof body.multiplayerOverride === "string") {
      const v = body.multiplayerOverride.trim();
      setSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING, v === "on" || v === "off" ? v : "");
    }
    return c.json({
      titleSummary: isTitleSummaryEnabled(store.db),
      worktreeRoot: getSetting(store.db, WORKTREE_ROOT_SETTING) ?? "",
      slackFeedChannel: getSetting(store.db, SLACK_FEED_CHANNEL_SETTING) ?? "",
      slackAskUser: getSetting(store.db, SLACK_ASK_USER_SETTING) ?? "",
      slackChannelFeatures: getSetting(store.db, SLACK_CHANNEL_FEATURES_SETTING) ?? "",
      multiplayer: isMultiplayerMode(store.db),
      multiplayerOverride: getSetting(store.db, MULTIPLAYER_OVERRIDE_SETTING) ?? "",
      // Read last so it reflects the writes just applied above: the version the
      // caller records for its mutation (see the Slack adapter's settings sync).
      settingsVersion: getSettingsVersion(store.db),
    });
  });

  // ============================================================================
  // Hook endpoint — Claude Code POSTs here
  // ============================================================================
  const knowledgePusher = createKnowledgePusher({
    db: store.db,
    search: (projectId, query, options) => knowledgeBackend.search(projectId, query, options),
    aboutFile: aboutFilePushHits(knowledgeStore, store.db),
    sessionStartNotice: bootSteeringNotice(),
  });
  app.post("/hook", async (c) => {
    try {
      const payload = (await c.req.json()) as HookPayload;
      // Standup's own internal `claude -p` runs are ignored outright (see
      // handleHookEvent), before any store lookup.
      if (isInternalCwd(payload.cwd)) return c.json({ ok: true });
      // A launched worker's events count only from its own token-presenting
      // hooks once its token is proven; the global hook's tokenless copy and
      // forgeries are refused before anything is recorded (hook-auth.ts). The
      // replies name no session or launch: the detail goes to the log.
      const hookToken = c.req.header(HOOK_TOKEN_HEADER)?.trim();
      // A launch's own hook that arrives without its token (its session's
      // env lacks it) duplicates the global hook's copy of the same event.
      if (!hookToken && c.req.query("via") === "worker") return c.json({ ignored: true }, 202);
      const authorize = () =>
        authorizeHookEvent(
          store.db,
          { sessionId: payload.session_id, cwd: payload.cwd, eventName: payload.hook_event_name },
          hookToken
        );
      const refused = (decision: Extract<ReturnType<typeof authorizeHookEvent>, { ok: false }>) => {
        if (decision.tokenlessCopy && payload.session_id) workerCopies.noteTokenless(payload.session_id);
        if (decision.status === 202) return c.json({ ignored: true }, 202);
        console.warn(`[hook] refused a ${payload.hook_event_name} event: ${decision.reason}`);
        return c.json({ error: "hook token refused" }, 403);
      };
      let auth = authorize();
      if (!auth.ok) return refused(auth);
      // A worker that waived its stages as not applicable and then changed
      // code is sent back to coding before its Stop is decided. The recheck
      // awaits, so the event is authorized again after it: the other copy of
      // this event may have proven or claimed in the meantime.
      if (payload.hook_event_name === "Stop" && payload.session_id) {
        await pipelineRecheckBeforeStop(store.db, payload.session_id, pipelineDeps);
        auth = authorize();
        if (!auth.ok) return refused(auth);
      }
      if (auth.prove) setLaunchHookAuth(store.db, auth.prove);
      if (auth.retire) retireLaunchHookAuth(store.db, auth.retire);
      // Returns a hook-output body when there's something to hand back to
      // the agent (queued steers); otherwise a bare ack. Still returns
      // immediately either way — the steer lookup is one indexed statement,
      // so this doesn't reintroduce blocking into the agent loop.
      const output = handleHookEvent(
        store,
        payload,
        broadcast,
        tailer,
        personaHandles,
        onSessionRehomed,
        auth,
        pipelineDeps.reviewScratchDir
      );
      if (auth.reportedBy && payload.session_id) {
        setSessionHookLaunch(store.db, payload.session_id, auth.reportedBy);
        workerCopies.noteToken(payload.session_id);
        // The session's own launch's token reported it: its worker runs it,
        // whatever a revive inferred.
        if (getLaunchBySession(store.db, payload.session_id)?.id === auth.reportedBy) {
          clearRevivedOutsideLaunch(store.db, payload.session_id);
        }
      }
      // Knowledge pushed into the agent's context on SessionStart,
      // UserPromptSubmit and a directory's first edit (knowledge-push.ts):
      // bounded by its own latency budget and fail-open, so a slow or failed
      // search leaves the hook's answer as it was.
      if (payload.hook_event_name === "SessionEnd" && payload.session_id) knowledgePusher.forget(payload.session_id);
      const pushed = await knowledgePusher.forHook(payload as PushHookPayload);
      return c.json(mergeHookContext(output, pushed) ?? { ok: true });
    } catch (err) {
      console.error("[hook] Error processing event:", err);
      // Still return 200 to not block the agent
      return c.json({ ok: true });
    }
  });

  // ============================================================================
  // REST API for the UI
  // ============================================================================

  // Projects — SQLite is authoritative; see ProjectsRegistry for why TOML
  // is only a seed/import path.
  app.get("/api/projects", (c) => c.json(projectsWithCounts(store)));

  /**
   * Why one of `repos` may not be registered, or null. A repo path is searched
   * by code search and indexed, so the filesystem root, a home directory or an
   * ancestor of one is refused as a repo.
   */
  function broadRepoPath(repos: string[] | undefined): string | null {
    for (const repo of repos ?? []) {
      const reason = broadRootReason(repo.replace(/^~(?=$|\/)/, homeDir()));
      if (reason) return `repo path ${repo} is not allowed: ${reason}`;
    }
    return null;
  }

  app.post("/api/projects", async (c) => {
    const body = await c.req.json<Partial<Project>>();

    const id = body.id?.trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      return c.json(
        { error: "id must be alphanumeric with hyphens (it is used in paths and branch names)" },
        400
      );
    }
    if (getProject(store.db, id)) {
      return c.json({ error: `Project "${id}" already exists` }, 409);
    }
    // A repo path no project may have is refused whoever asks; any other
    // posture away from the defaults is the owner's to set.
    const tooBroad = broadRepoPath(body.repos);
    if (tooBroad) return c.json({ error: tooBroad }, 400);

    const posture = launchPostureFields(body);
    if (posture.length > 0) {
      const refused = ownerRefusal(c, `create a project that sets ${posture.join(", ")}`);
      if (refused) return refused;
    }

    const project: Project = {
      id,
      name: body.name?.trim() || id,
      emoji: body.emoji || undefined,
      repos: body.repos ?? [],
      setup: body.setup || undefined,
      branch: localTargetBranch(body.repos?.[0]?.replace(/^~(?=$|\/)/, homeDir()), body.branch, defaultGitRunner),
      launchArgs: body.launchArgs || undefined,
      worktreeRoot: body.worktreeRoot || undefined,
      provision: body.provision || undefined,
      launchSubdir: body.launchSubdir || undefined,
      inPlace: body.inPlace || undefined,
      // Bypass is the default (unset); a present value is taken as a boolean.
      bypassPermissions:
        body.bypassPermissions !== undefined ? !!body.bypassPermissions : undefined,
      reviewProcess: body.reviewProcess || undefined,
      reviewCommand: body.reviewCommand || undefined,
      dailyReviewActive: body.dailyReviewActive ?? undefined,
      reviewLenses: body.reviewLenses ?? undefined,
    };

    upsertProject(store.db, project);

    // Sessions that started in this directory before the project existed are
    // sitting in scratch — which is the common case, since you create a
    // project because work is already happening there.
    const moved = rehomeScratchSessions(store.db, project);
    rehomeKnowledge(moved, project.id);
    if (moved.length > 0) {
      console.log(`[registry] Moved ${moved.length} session(s) into ${project.id}`);
      broadcastSessions();
    }

    broadcastProjects();
    return c.json({ ...project, movedSessions: moved.length }, 201);
  });

  app.patch("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getProject(store.db, id);
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json<Partial<Project>>();
    const tooBroad = broadRepoPath(body.repos);
    if (tooBroad) return c.json({ error: tooBroad }, 400);
    // id is intentionally immutable: launches and sessions reference it, and
    // worktree paths are derived from it.
    const updated: Project = {
      ...existing,
      name: body.name?.trim() || existing.name,
      emoji: body.emoji !== undefined ? body.emoji || undefined : existing.emoji,
      repos: body.repos ?? existing.repos,
      setup: body.setup !== undefined ? body.setup || undefined : existing.setup,
      branch: body.branch || existing.branch,
      launchArgs:
        body.launchArgs !== undefined ? body.launchArgs || undefined : existing.launchArgs,
      worktreeRoot:
        body.worktreeRoot !== undefined
          ? body.worktreeRoot || undefined
          : existing.worktreeRoot,
      provision:
        body.provision !== undefined ? body.provision || undefined : existing.provision,
      launchSubdir:
        body.launchSubdir !== undefined
          ? body.launchSubdir || undefined
          : existing.launchSubdir,
      inPlace:
        body.inPlace !== undefined ? !!body.inPlace : existing.inPlace,
      bypassPermissions:
        body.bypassPermissions !== undefined
          ? !!body.bypassPermissions
          : existing.bypassPermissions,
      reviewProcess:
        body.reviewProcess !== undefined
          ? body.reviewProcess || undefined
          : existing.reviewProcess,
      reviewCommand:
        body.reviewCommand !== undefined
          ? body.reviewCommand || undefined
          : existing.reviewCommand,
      dailyReviewActive:
        body.dailyReviewActive !== undefined
          ? body.dailyReviewActive
          : existing.dailyReviewActive,
      reviewLenses: body.reviewLenses ?? existing.reviewLenses,
      // The per-project default knowledge scope. Only 'global'/'project' are
      // project-level defaults; any other value (including "") clears the
      // override so authoring falls back to the account-wide setting, then
      // 'project'. Omitting the field entirely preserves the existing override.
      knowledgeScope:
        body.knowledgeScope !== undefined
          ? body.knowledgeScope === "global" || body.knowledgeScope === "project"
            ? body.knowledgeScope
            : undefined
          : existing.knowledgeScope,
    };
    const posture = changedLaunchPostureFields(existing, updated);
    if (posture.length > 0) {
      const refused = ownerRefusal(c, `change ${posture.join(", ")} on a project`);
      if (refused) return refused;
    }
    // Whether teammates can read the project's knowledge over the public
    // knowledge API is the owner's call. The reserved global corpus is always
    // shared (minus its personal docs), so it has no switch.
    if (body.shareable !== undefined) {
      if (typeof body.shareable !== "boolean") return c.json({ error: "shareable must be a boolean" }, 400);
      if (body.shareable !== existing.shareable) {
        if (id === GLOBAL_PROJECT_ID) return c.json({ error: "The global corpus is always shareable." }, 400);
        const refused = ownerRefusal(c, "change whether a project's knowledge is shareable");
        if (refused) return refused;
      }
      updated.shareable = body.shareable;
    }

    upsertProject(store.db, updated);
    if (updated.shareable !== existing.shareable) setProjectShareable(store.db, id, updated.shareable !== false);

    // Editing repos can newly cover a stranded session.
    const moved = rehomeScratchSessions(store.db, updated);
    rehomeKnowledge(moved, updated.id);
    if (moved.length > 0) broadcastSessions();

    broadcastProjects();
    return c.json({ ...updated, movedSessions: moved.length });
  });

  app.delete("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    if (id === "scratch") {
      return c.json(
        { error: "scratch cannot be deleted — unmatched sessions fall back to it" },
        400
      );
    }
    if (!getProject(store.db, id)) return c.json({ error: "Not found" }, 404);

    deleteProject(store.db, id);
    broadcastProjects();
    return c.json({ ok: true });
  });

  // ============================================================================
  // Custom project icon — an uploaded image shown in place of the emoji. The
  // file is stored under iconsDir as "<id>.<ext>"; Project.iconPath holds the
  // served URL (with a ?v= cache-buster so a re-upload isn't masked by a stale
  // cached image). Both routes list the directory rather than trusting the raw
  // :id in a path, so the param can never escape iconsDir.
  // ============================================================================

  /** Removes any stored icon file(s) for a project id (extension may vary). */
  async function removeIconFiles(id: string): Promise<void> {
    if (!iconsDir) return;
    for (const existing of await readdir(iconsDir).catch(() => [] as string[])) {
      if (existing === id || existing.startsWith(`${id}.`)) {
        await rm(join(iconsDir, existing)).catch(() => {});
      }
    }
  }

  app.post("/api/projects/:id/icon", async (c) => {
    const id = c.req.param("id");
    const project = getProject(store.db, id);
    if (!project) return c.json({ error: "Not found" }, 404);
    if (!iconsDir) return c.json({ error: "Icon storage is not configured" }, 503);

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("icon");
    if (!(file instanceof File)) {
      return c.json({ error: "icon file is required (multipart field 'icon')" }, 400);
    }

    const ext = iconExtension(file.type, file.name);
    if (!ext) {
      return c.json(
        { error: "Unsupported image type — use PNG, JPEG, GIF, WebP, or SVG" },
        400
      );
    }

    await mkdir(iconsDir, { recursive: true });
    // Drop any previous icon first so a re-upload with a different extension
    // can't leave two files the GET route would then pick between.
    await removeIconFiles(id);
    await writeFile(join(iconsDir, `${id}${ext}`), Buffer.from(await file.arrayBuffer()));

    const iconPath = `/api/projects/${id}/icon?v=${Date.now()}`;
    upsertProject(store.db, { ...project, iconPath });
    broadcastProjects();
    return c.json({ iconPath });
  });

  app.get("/api/projects/:id/icon", async (c) => {
    const id = c.req.param("id");
    if (!iconsDir) return c.json({ error: "Not found" }, 404);
    const match = (await readdir(iconsDir).catch(() => [] as string[])).find(
      (f) => f === id || f.startsWith(`${id}.`)
    );
    if (!match) return c.json({ error: "Not found" }, 404);
    const file = Bun.file(join(iconsDir, match));
    if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
    return new Response(file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        // Icons render only via <img>, where script never executes. These
        // headers neutralize the one place it otherwise could — a victim
        // navigating straight to this endpoint with a malicious SVG (SVGs can
        // carry <script>): attachment forces a download instead of an inline
        // same-origin render, the sandbox CSP disables scripts even if it did
        // render, and nosniff pins the declared type.
        "Content-Disposition": "attachment",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        // iconPath carries a ?v= buster on change; a short max-age keeps a bare
        // hit (an older cached iconPath) from serving a stale image for long.
        "Cache-Control": "public, max-age=60",
      },
    });
  });

  app.delete("/api/projects/:id/icon", async (c) => {
    const id = c.req.param("id");
    const project = getProject(store.db, id);
    if (!project) return c.json({ error: "Not found" }, 404);
    await removeIconFiles(id);
    upsertProject(store.db, { ...project, iconPath: undefined });
    broadcastProjects();
    return c.json({ ok: true });
  });

  // TOML remains available for dotfile portability, but only on request.
  app.post("/api/projects/import", async (c) => {
    // The TOML can set any project's launchArgs, setup and permission posture.
    const refused = ownerRefusal(c, "import projects from TOML");
    if (refused) return refused;
    if (!registry) return c.json({ error: "Registry unavailable" }, 503);
    const result = await registry.importFromToml();
    broadcastProjects();
    return c.json(result);
  });

  app.get("/api/projects/export", (c) => {
    if (!registry) return c.json({ error: "Registry unavailable" }, 503);
    return c.text(registry.exportToToml(), 200, { "Content-Type": "text/plain" });
  });

  // ============================================================================
  // Project knowledge — markdown files on disk stay the source of truth; the
  // database is an index rebuilt from them. Every mutation resyncs so a doc
  // is searchable the moment it's saved rather than at the next search.
  // ============================================================================

  // Staleness (phase-7 Step 6) is computed here, on every open of the tab,
  // rather than cached — it's two git commands per generated doc, and
  // nobody needs the answer while the tab is closed. Only docs carrying a
  // real generated_from_sha get an opinion at all; a human-authored doc's
  // staleness is always null.
  app.get("/api/projects/:id/knowledge", async (c) => {
    const projectId = c.req.param("id");
    const browse = resolveBrowseAudience(c, projectId);
    const docs = (await listKnowledgeFiles(knowledgeDir, projectId)).filter((doc) =>
      isDocInAudience({ ...doc, projectId }, browse)
    );

    const project = getProjects(store.db).find((p) => p.id === projectId);
    const repoPath = project ? primaryRepoPath(project) : null;

    const freshness = freshnessGate(store.db);
    const withStaleness = await Promise.all(
      docs.map(async (doc) => {
        // Current confidence is DERIVED on every read (roadmap r2), never
        // persisted: the doc's asserted base or the default, decayed from its
        // own dates and capped by the evidence pass's current findings — the
        // same value the injection gate judges.
        const currentConfidence = freshness.currentConfidence({ ...doc, projectId });

        // Re-verification result (roadmap r5) lives in the DB, not the file, so
        // surface it from the index rather than the on-disk doc — it's what a
        // human sees to know a doc was disputed by the last automatic pass.
        const stored = knowledgeStore.getDoc(projectId, doc.slug);
        const base = {
          ...doc,
          currentConfidence,
          verdict: stored?.verdict,
          disputes: stored?.disputes,
        };

        if (!hasProvenance(doc.generatedFromSha)) {
          return { ...base, staleness: null };
        }
        if (!repoPath) {
          // Has a sha but nowhere to check it against — same "can't tell"
          // outcome as a sha git can't resolve, not "not applicable".
          return {
            ...base,
            staleness: {
              sha: doc.generatedFromSha,
              reachable: false,
              commitsSince: null,
              filesChanged: null,
              changedFiles: null,
              stale: false,
            },
          };
        }
        return {
          ...base,
          staleness: await computeStaleness(repoPath, doc.generatedFromSha),
        };
      })
    );

    return c.json(withStaleness);
  });

  // ============================================================================
  // Drafts (phase-7 Step 5 review UI) — registered before
  // GET/PUT/DELETE /api/projects/:id/knowledge/:slug below on purpose. Hono
  // matches routes in registration order, and ":slug" is a wildcard segment
  // that would otherwise swallow "drafts" as if someone had a document
  // literally named that.
  // ============================================================================

  // Whether a draft is another user's personal draft: hidden from this caller's
  // listing, and every mutation of it answers as if it did not exist.
  const isAnotherUsersDraft = (
    c: Context,
    projectId: string,
    draft: { slug: string; scope?: string; ownerUser?: string; sourceKind?: string }
  ): boolean => isAnotherUsersPersonalDoc(c, projectId, draft);

  app.get("/api/projects/:id/knowledge/drafts", async (c) => {
    const projectId = c.req.param("id");
    await knowledgeSync?.syncDrafts(projectId);
    const drafts = (knowledgeSync?.getDrafts(projectId) ?? []).filter(
      (d) => !isAnotherUsersDraft(c, projectId, d)
    );

    return c.json(
      drafts.map((d) => ({
        ...d,
        // Resolved here so the review card can link to the launch that
        // generated it with a single fetch — the draft row only carries the
        // launch id, not where that launch's session lives.
        launchSessionId: d.generatedByLaunchId
          ? getLaunch(store.db, d.generatedByLaunchId)?.sessionId ?? null
          : null,
      }))
    );
  });

  app.put("/api/projects/:id/knowledge/drafts/:slug", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json<{
      title?: string;
      body?: string;
      tags?: string[];
      source_kind?: string;
    }>();

    const existing = knowledgeSync?.getDraft(projectId, slug);
    if (!existing || isAnotherUsersDraft(c, projectId, existing)) {
      return c.json({ error: "Not found" }, 404);
    }
    const draftTarget = await readKnowledgeFile(knowledgeDir, projectId, existing.replacesSlug ?? slug);
    if (draftTarget && isAnotherUsersPersonalDoc(c, projectId, draftTarget)) {
      return c.json({ error: `${draftTarget.slug} is another user's personal doc` }, 409);
    }
    const draftPersonalRefusal = personalLayerWriteRefusal(c, { slug, docs: [existing, draftTarget] });
    if (draftPersonalRefusal) return c.json({ error: draftPersonalRefusal }, 403);
    if (!body.body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }

    try {
      // Provenance frontmatter is carried over explicitly. writeDraft
      // only writes what it's given, and the point of an edit is changing
      // the text, not silently dropping where the draft came from.
      await knowledgeBackend.writeDraft(projectId, {
        slug,
        title: body.title?.trim() || existing.title,
        body: body.body,
        tags: body.tags ?? existing.tags,
        generatedFromSha: existing.generatedFromSha,
        generatedAt: existing.generatedAt,
        generatedByLaunchId: existing.generatedByLaunchId,
        replacesSlug: existing.replacesSlug,
        // Source kind + confidence bookkeeping (roadmap r2) carried over — an
        // edit changes the text, not where the draft came from or its
        // freshness stamp. The one exception: a reviewer may reclassify the
        // kind (e.g. mark a draft as product/spec so it becomes eligible for
        // launch-time product injection, roadmap r8); an omitted/invalid value
        // preserves the stamped kind.
        sourceKind: normalizeSourceKind(body.source_kind) ?? existing.sourceKind,
        confidence: existing.confidence,
        lastVerifiedAt: existing.lastVerifiedAt,
        halfLifeDays: existing.halfLifeDays,
        // scope/owner_user are the draft's authored RETRIEVAL AUDIENCE, not
        // content. writeDraft re-emits only what it is handed, so a full rewrite
        // that omitted them would drop them from the file and — on a fresh
        // accept — let the loader default the scopeless doc to 'project',
        // silently widening a scope='user' note to the whole project (or demoting
        // a scope='global' draft). The body edit takes no scope/owner from the
        // request (it is not behind the audience gate), so carrying the EXISTING
        // ones through can only PRESERVE the authored audience, never re-aim it —
        // the same discipline the merge-accept path applies to the target doc.
        scope: existing.scope,
        ownerUser: existing.ownerUser,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    await knowledgeSync?.syncDrafts(projectId);
    // Edited text is a claim nobody has checked yet — leaving the old
    // verdict attached would have it read as current when it describes a
    // body that no longer exists.
    knowledgeSync?.resetDraftVerdict(projectId, slug);

    broadcast({
      type: "knowledge:draft",
      payload: { projectId, slug },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  // A Persona playbook draft (persona/playbook.ts): a doc of source kind
  // `playbook` in the writing Persona owner's personal layer of the global
  // corpus, under one of their `playbook-<owner>--…` slugs. Only Persona's own
  // in-process write reaches it. The route takes the fields, not a body, and
  // composes the body itself, so no field can open another's section; a title
  // or field line that relaxes a delivery-pipeline stage, the safety floor or
  // an outward-step rule is refused here whatever the tool checked. It is
  // accepted through the draft accept route like any other draft.
  app.post("/api/knowledge/playbooks/drafts", async (c) => {
    const runtime = fleet?.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER));
    if (!runtime) return c.json({ error: "playbooks are written only by Persona" }, 403);
    const owner = runtime.owner;
    const input = await c.req
      .json<{ slug?: unknown; title?: unknown; fields?: unknown; source?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const slug = typeof input.slug === "string" ? input.slug : "";
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const rawFields = input.fields && typeof input.fields === "object" ? (input.fields as Record<string, unknown>) : {};
    const fields: PlaybookFields = {};
    for (const { key } of PLAYBOOK_FIELDS) {
      const value = rawFields[key];
      if (typeof value === "string" && value.trim()) fields[key] = value.trim();
    }
    const src = input.source && typeof input.source === "object" ? (input.source as Record<string, unknown>) : {};
    if (!isOwnersPlaybookSlug(owner, slug)) return c.json({ error: slugUnavailable(slug) }, 400);
    if (!title || title.length > PLAYBOOK_TITLE_MAX_CHARS || REQUIRED_PLAYBOOK_FIELDS.some((k) => !fields[k])) {
      return c.json({ error: `a title (at most ${PLAYBOOK_TITLE_MAX_CHARS} characters), whenToUse and steps are required` }, 400);
    }
    if (typeof src.jobId !== "string" || typeof src.jobTitle !== "string" || typeof src.closedAt !== "string" || typeof src.launches !== "number") {
      return c.json({ error: "source {jobId, jobTitle, closedAt, launches} is required" }, 400);
    }
    const relaxations = playbookRelaxations(fields, title);
    if (relaxations.length > 0) {
      return c.json({ error: "the playbook relaxes a pipeline stage, the safety floor or an outward-step rule", relaxations }, 400);
    }
    const body = composePlaybook(fields, { jobId: src.jobId, jobTitle: src.jobTitle, closedAt: src.closedAt, launches: src.launches });
    // One answer for every slug that isn't this owner's to write, so it says
    // nothing about what holds it.
    const existing = await readKnowledgeFile(knowledgeDir, GLOBAL_PROJECT_ID, slug);
    const pending = knowledgeSync?.getDraft(GLOBAL_PROJECT_ID, slug);
    const owns = (doc: { scope?: string; ownerUser?: string; sourceKind?: string } | null | undefined) =>
      !doc || (doc.scope === "user" && doc.ownerUser === owner && doc.sourceKind === PLAYBOOK_SOURCE_KIND);
    if (!owns(existing) || !owns(pending)) return c.json({ error: slugUnavailable(slug) }, 409);
    try {
      await knowledgeBackend.writeDraft(GLOBAL_PROJECT_ID, {
        slug,
        title,
        body,
        tags: [PLAYBOOK_TAG],
        generatedAt: new Date().toISOString(),
        ...(existing ? { replacesSlug: slug } : {}),
        originClass: "agent",
        sourceKind: PLAYBOOK_SOURCE_KIND,
        scope: "user",
        ownerUser: owner,
        confidence: UNVERIFIED_CONFIDENCE,
        halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await knowledgeSync?.syncDrafts(GLOBAL_PROJECT_ID);
    broadcast(personalDraftFrame(GLOBAL_PROJECT_ID, slug, owner));
    return c.json({ ok: true, projectId: GLOBAL_PROJECT_ID, slug, replaces: !!existing });
  });

  app.post("/api/projects/:id/knowledge/drafts/:slug/accept", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req
      .json<{ mode?: string; title?: string; body?: string; tags?: string[]; force?: boolean; expectedHash?: string }>()
      .catch(() => ({ mode: undefined, title: undefined, body: undefined, tags: undefined, force: undefined, expectedHash: undefined }));

    let draft = knowledgeSync?.getDraft(projectId, slug);
    if (!draft || isAnotherUsersDraft(c, projectId, draft)) {
      return c.json({ error: "Not found" }, 404);
    }
    // A playbook is kept only as it was checked: the draft is re-read from
    // disk first, and must still be the text whose hash the keeper pinned.
    const keptPlaybook = draft.sourceKind === PLAYBOOK_SOURCE_KIND;
    if (keptPlaybook) {
      await knowledgeSync?.syncDrafts(projectId);
      draft = knowledgeSync?.getDraft(projectId, slug);
      if (!draft || draft.sourceKind !== PLAYBOOK_SOURCE_KIND || isAnotherUsersDraft(c, projectId, draft)) {
        return c.json({ error: "Not found" }, 404);
      }
      if (typeof body.expectedHash !== "string" || body.expectedHash !== playbookHash(draft)) {
        return c.json({ error: `the playbook draft ${slug} changed since it was checked; decide it again` }, 409);
      }
    }
    const acceptTarget = await readKnowledgeFile(knowledgeDir, projectId, draft.replacesSlug ?? slug);
    if (acceptTarget && isAnotherUsersPersonalDoc(c, projectId, acceptTarget)) {
      return c.json({ error: `${acceptTarget.slug} is another user's personal doc` }, 409);
    }
    const acceptPersonalRefusal = personalLayerWriteRefusal(c, { slug, docs: [draft, acceptTarget] });
    if (acceptPersonalRefusal) return c.json({ error: acceptPersonalRefusal }, 403);

    const mode = resolveAcceptMode(draft.replacesSlug, body.mode);

    // Merge is the one accept mode that needs a human-combined body — it folds a
    // regenerated draft into a human-authored doc — so it stays inline here
    // rather than in the shared publishDraft path (which the fresh/replace
    // branches below and propose's auto-accept both call). The merge default is
    // deliberate: the first real bootstrap run showed a regenerated draft is
    // usually a supplement to what a human wrote, not a replacement, so accept
    // needs the human's combined text rather than silently picking a side.
    if (mode === "merge") {
      if (!body.body?.trim()) {
        return c.json(
          {
            error:
              "Merging requires a combined body — edit both versions into one before accepting, or choose replace instead.",
          },
          400
        );
      }
      const mergedTitle = body.title?.trim() || draft.title;
      // scope/owner_user are the TARGET doc's RETRIEVAL AUDIENCE, not content — a
      // merge folds two bodies into one but must never silently change WHO the doc
      // reaches. writeKnowledgeFile emits only what it is handed, so read the
      // target's audience and carry it through; otherwise the rewritten file lands
      // with no scope and the loader resets it to the 'project' default, widening a
      // scope='user' doc to the whole project (or demoting a 'global' doc). This
      // read is the one exception to the "no carry-over" merge rule below — audience
      // is not provenance.
      const target = await readKnowledgeFile(knowledgeDir, projectId, draft.replacesSlug!);
      // A merge that changes the body closes the prior version like a replace
      // does: it is kept under .history/ and the merged body is current from now.
      const mergedAt = new Date().toISOString();
      const versioned =
        target !== null &&
        (await archiveDocVersion(knowledgeDir, projectId, draft.replacesSlug!, {
          closedAt: mergedAt,
          nextBody: body.body,
        })) !== null;
      try {
        // Deliberately written without provenance, unlike the replace path
        // (whose rename carries generated_from_sha through) and unlike a plain
        // PUT .../knowledge/:slug edit (which round-trips it — see
        // writeKnowledgeFile's doc comment). A merged doc is partly the human's
        // own prose in a way a typo fix isn't, and staleness only ever flags docs
        // with a sha — calling someone's merge outdated because the machine half
        // of it aged is the second-guessing the design warns against. scope/owner
        // are the exception (see above): audience must survive a merge.
        await writeKnowledgeFile(knowledgeDir, projectId, {
          slug: draft.replacesSlug!,
          title: mergedTitle,
          body: body.body,
          tags: body.tags ?? draft.tags,
          scope: target?.scope,
          ownerUser: target?.ownerUser,
          ...(versioned ? { validFrom: mergedAt } : {}),
        });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
      await deleteDraftFile(knowledgeDir, projectId, slug);

      await knowledgeSync?.syncProject(projectId);
      // Accepting is a human asserting the doc's current body — clear any verdict
      // the re-verification cron recorded against the PRIOR body (roadmap r5
      // review). Must follow syncProject, whose upsertDoc preserves the column. A
      // merge writes to draft.replacesSlug, so that is where the doc landed.
      const acceptedSlug = draft.replacesSlug!;
      knowledgeSync?.clearDocVerdict(projectId, acceptedSlug);
      await knowledgeSync?.syncDrafts(projectId);
      broadcastProjects();
      broadcast({
        type: "knowledge:draft",
        payload: { projectId, slug },
        timestamp: new Date().toISOString(),
      });

      // A merge folds a regenerated draft into a human-authored doc — a
      // `reconciled` feed transition, attributed to the authoring session when
      // the draft's launch is known.
      const authoringSessionId = draft.generatedByLaunchId
        ? getLaunch(store.db, draft.generatedByLaunchId)?.sessionId ?? undefined
        : undefined;
      emitKnowledgeChange("reconciled", projectId, acceptedSlug, mergedTitle, {
        sessionId: authoringSessionId,
      });
      checkContradictionsAsync(projectId, {
        slug: acceptedSlug,
        title: mergedTitle,
        body: body.body,
      });

      return c.json({ ok: true, mode: "merge" });
    }

    // mode === null (a first-bootstrap draft, nothing to replace) or "replace" —
    // the plain publish path, shared with propose's auto-accept default via
    // publishDraft: dedup-suppress a fresh duplicate, move the file into place,
    // sync into search, clear any stale verdict, and emit the `accepted` feed
    // transition + contradiction check.
    const outcome = await publishDraft(projectId, slug, { skipDedup: body.force === true });
    if (!outcome.published) {
      if (outcome.reason === "duplicate") {
        return c.json(
          {
            error:
              `${outcome.dupProjectId}/${outcome.dupSlug} already covers this draft; it was kept. Accept again ` +
              "with force to publish it anyway, or discard it.",
            duplicateOf: { project: outcome.dupProjectId, slug: outcome.dupSlug },
          },
          409
        );
      }
      return c.json({ error: "Not found" }, 404);
    }
    // A playbook counts only while it carries Persona's stamp over its
    // content (playbook-library.ts), so a file dropped or edited on disk is
    // never offered for a brief.
    // The stamp goes only over the text that was checked: the published row
    // must hash as the draft did and still relax nothing.
    if (keptPlaybook && isPersonaWrite(c)) {
      const published = await readKnowledgeFile(knowledgeDir, projectId, slug);
      const intact =
        !!published &&
        playbookHash(published) === body.expectedHash &&
        playbookRelaxations(parsePlaybook(published.body), published.title).length === 0;
      if (!intact) return c.json({ error: `the playbook ${slug} changed while it was being kept; it is not offered for briefs` }, 409);
      knowledgeSync?.stampWriter(projectId, slug, PERSONA_WRITER);
    }
    return c.json({ ok: true, mode: mode ?? "accept" });
  });

  app.post("/api/projects/:id/knowledge/drafts/:slug/discard", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");

    const draft = knowledgeSync?.getDraft(projectId, slug);
    if (draft && isAnotherUsersDraft(c, projectId, draft)) {
      return c.json({ error: "Not found" }, 404);
    }
    const removed = await deleteDraftFile(knowledgeDir, projectId, slug);
    if (!removed) return c.json({ error: "Not found" }, 404);

    await knowledgeSync?.syncDrafts(projectId);
    broadcast(personalDraftFrame(projectId, slug, draft?.scope === "user" ? draft.ownerUser : undefined));

    return c.json({ ok: true });
  });

  // Revise a draft from review feedback (the "revise with feedback" box).
  //
  // Runs as a fresh bootstrap-kind launch whose prompt is the current draft +
  // the human's feedback, told to re-propose the SAME slug — so the draft is
  // replaced in place (propose_knowledge overwrites a draft of the same slug),
  // keeping its slug and re-running the fact-check. Bootstrap kind on purpose:
  // it's the only kind propose_knowledge accepts. This is regenerate-with-
  // guidance, not a live chat with the original session — see the design
  // discussion; the original session is usually gone and its worktree cleaned,
  // and an adopted session couldn't call propose_knowledge anyway (the gate is
  // bootstrap-only).
  app.post("/api/projects/:id/knowledge/drafts/:slug/revise", async (c) => {
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const { feedback, model, effort } = await c.req
      .json<{ feedback?: string; model?: string; effort?: string }>()
      .catch(() => ({ feedback: undefined, model: undefined, effort: undefined }));

    if (!feedback?.trim()) {
      return c.json({ error: "feedback is required" }, 400);
    }
    if (model && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${model}` }, 400);
    }
    if (effort && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort level: ${effort}` }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }

    const draft = knowledgeSync?.getDraft(projectId, slug);
    if (!draft || isAnotherUsersDraft(c, projectId, draft)) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      const result = await launchSession(
        store.db,
        {
          project,
          task: reviseDraftPrompt(
            project,
            { slug: draft.slug, title: draft.title, body: draft.body },
            feedback.trim()
          ),
          label: `Revise ${slug}.md for ${project.name}`,
          // Same judgment-work defaults as bootstrap; caller can override.
          model: (model as ClaudeModel | undefined) ?? "opus",
          effort: (effort as ClaudeEffort | undefined) ?? "high",
          kind: "bootstrap",
          // The user who asked for the revision — same alias resolution as the
          // other human-triggered launches — so it is attributed to them (not the
          // collector host) and carries their personalization.
          requester: actingAlias(c),
          // The server-resolved identity that scopes injected knowledge —
          // distinct from `requester` and never taken from the request body.
          retrievalUser: scopingUser(c),
          launchedBy: scopingUser(c),
        },
        broadcastLaunch
      );

      return c.json({ launch: result.launch });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // Accepts every pending draft that doesn't need a human decision first.
  // Per phase-7.md Step 5, that is a real subset, not "all of them" —
  // anything with replaces_slug set would silently overwrite existing work,
  // and anything the verifier disputed is exactly what review exists to
  // catch. Both are left pending and reported back so the UI can say why.
  app.post("/api/projects/:id/knowledge/drafts/accept-all", async (c) => {
    const projectId = c.req.param("id");
    // Another user's personal drafts are not this caller's to accept.
    const pending = (knowledgeSync?.getDrafts(projectId) ?? []).filter(
      (d) => !isAnotherUsersDraft(c, projectId, d)
    );

    const accepted: string[] = [];
    // The accepted docs' text, kept so contradiction detection can run over them
    // after the batch is synced (below) — mirroring the single-accept path.
    const acceptedDocs: DocText[] = [];
    const skipped: Array<{ slug: string; reason: "replaces" | "disputed" | "duplicate" | "personal" }> = [];

    for (const draft of pending) {
      if (personalLayerRefusal({ slug: draft.slug, docs: [draft] })) {
        skipped.push({ slug: draft.slug, reason: "personal" });
        continue;
      }
      if (!isAcceptAllEligible(draft)) {
        skipped.push({
          slug: draft.slug,
          reason: draft.replacesSlug ? "replaces" : "disputed",
        });
        continue;
      }
      // Dedup at accept: a fresh draft duplicating a doc the corpus already has
      // is left pending (never discarded) for a one-at-a-time decision. Only
      // fresh drafts reach here (replaces_slug ones are held above), so the
      // near-dup check has no deliberate-overwrite to exclude.
      const dup = await findAcceptDuplicate(projectId, {
        slug: draft.slug,
        title: draft.title,
        body: draft.body,
      });
      if (dup) {
        skipped.push({ slug: draft.slug, reason: "duplicate" });
        continue;
      }
      const moved = await acceptDraftFile(knowledgeDir, projectId, draft.slug);
      if (moved) {
        accepted.push(draft.slug);
        // Fresh drafts (no replacesSlug) land at their own slug.
        acceptedDocs.push({ slug: draft.slug, title: draft.title, body: draft.body });
        // Sync the just-accepted doc into the index BEFORE the next draft's dedup
        // check: findAcceptDuplicate searches the indexed corpus, so without this
        // an earlier accept in THIS batch is invisible and two near-duplicate
        // fresh drafts would both slip in. acceptDraftFile only renames on disk;
        // syncProject is what puts the doc where the search (and its embedding
        // arm) can see it. Unchanged files are skipped on the stat compare, so the
        // repeated call only does work for the one doc just added.
        await knowledgeSync?.syncProject(projectId);
      }
    }

    await knowledgeSync?.syncProject(projectId);
    // Each accepted doc's current body is now human-asserted — clear any stale
    // re-verification verdict the cron recorded against a prior body (roadmap r5
    // review). Only fresh drafts (no replacesSlug) reach here, so the doc landed
    // at its own slug. After syncProject, since upsertDoc preserves the column.
    for (const acceptedSlug of accepted) {
      knowledgeSync?.clearDocVerdict(projectId, acceptedSlug);
    }
    // An accepted agent draft still awaiting its fact-check is verified the same
    // way a single accept verifies it.
    for (const draft of pending.filter((d) => accepted.includes(d.slug))) {
      await settlePublishedVerification(projectId, draft.slug, draft.verdict, undefined);
    }
    await knowledgeSync?.syncDrafts(projectId);
    broadcastProjects();
    broadcast({
      type: "knowledge:draft",
      payload: { projectId, acceptedAll: true },
      timestamp: new Date().toISOString(),
    });
    // Each accepted doc is a substantive `accepted` transition — one feed line
    // apiece on both surfaces, the same as a single-draft accept.
    for (const doc of acceptedDocs) {
      emitKnowledgeChange("accepted", projectId, doc.slug, doc.title);
    }

    // Contradiction detection over each just-accepted doc (roadmap r7) — the same
    // accept-time coherence check the single-draft path runs, fire-and-forget.
    // Deferred until AFTER syncProject so every accepted doc is in the corpus the
    // search recalls against: a draft that opposes another draft in the same batch
    // is caught here, not just conflicts with pre-existing docs. Run sequentially
    // (not one fire-and-forget per doc): detectContradictions bounds judge spawns
    // per doc, so a concurrent fan-out over a large accept-all would hold dozens
    // of `claude` judge subprocesses live at once.
    checkContradictionsBatchAsync(projectId, acceptedDocs);

    return c.json({ accepted, skipped });
  });

  // The contradiction-resolver ledger for a project (roadmap r7). `?status=
  // needs_review` narrows to the human-review queue — the resolutions the
  // autonomy gate WITHHELD (superseding an owner/high-confidence claim), each
  // carrying the proposed rescope/merge/supersede in `detail` for a human to
  // review before accepting. Registered before the `/:slug` doc route so the
  // literal "resolutions" segment isn't swallowed as a doc slug.
  app.get("/api/projects/:id/knowledge/resolutions", (c) => {
    const projectId = c.req.param("id");
    const rows =
      c.req.query("status") === "needs_review"
        ? getPendingResolutions(store.db, projectId)
        : getKnowledgeResolutions(store.db, projectId);
    return c.json(rows);
  });

  // Why a resolution between `slugs` may not be applied, or null: superseding
  // or rewriting a doc of the personal layer is Persona's alone.
  const resolutionPersonalLayerRefusal = async (projectId: string, slugs: string[]): Promise<string | null> => {
    const files = await Promise.all(slugs.map((slug) => readKnowledgeFile(knowledgeDir, projectId, slug)));
    return personalLayerRefusal({ slug: slugs[0] ?? "", docs: [...files, ...slugs.map((slug) => ({ slug }))] });
  };

  // Accept a withheld (needs_review) resolution — the accept path the durable
  // queue exists to serve. Reconstructs the proposal from the ledger row and
  // applies the same non-destructive resolution the autonomy gate declined to
  // auto-apply (a human is the authority here), then flips the row to `applied`.

  app.post("/api/projects/:id/knowledge/resolutions/:rid/accept", async (c) => {
    const projectId = c.req.param("id");
    const rid = c.req.param("rid");
    if (!contradictionResolveDeps) {
      return c.json({ error: "knowledge sync is not wired on this collector" }, 503);
    }
    const row = getKnowledgeResolution(store.db, rid);
    if (!row || row.projectId !== projectId) return c.json({ error: "Not found" }, 404);
    if (row.status !== "needs_review") {
      return c.json({ error: "resolution is not pending review" }, 409);
    }
    const proposal = proposalFromResolution(row);
    if (!proposal) {
      return c.json({ error: "resolution detail is incomplete — cannot replay it" }, 422);
    }
    const acceptResolutionRefusal = await resolutionPersonalLayerRefusal(projectId, [row.winnerSlug, row.loserSlug]);
    if (acceptResolutionRefusal) return c.json({ error: acceptResolutionRefusal }, 403);
    const outcome = await acceptResolution(contradictionResolveDeps, projectId, proposal);
    if (outcome.status !== "applied") {
      return c.json({ error: `could not apply resolution: ${outcome.status}` }, 409);
    }
    markResolutionApplied(store.db, rid);
    // Nudge the Knowledge tab to refetch the now-resolved docs.
    broadcast({
      type: "knowledge:draft",
      payload: { projectId, slug: row.loserSlug, contradicted: [row.winnerSlug] },
      timestamp: new Date().toISOString(),
    });
    return c.json({ ok: true, outcome });
  });

  // ── Cross-project needs-review surface (held contradiction resolutions) ──────
  // The autonomy gate auto-applies only SAFE resolutions; a merge, a rescope of an
  // owner/high-confidence doc, or a supersede of a high-confidence claim is
  // WITHHELD as a `needs_review` ledger row with BOTH docs left flagged
  // "contradicted" awaiting a human. These routes are that human review surface.
  // They key on the globally-unique resolution id (sha1 of project + the UNORDERED
  // pair), so no project sits in the path — the project is read off the row.

  // The write half (confirm/reject/swap) applies the SAME corpus effects the
  // auto-resolver does, so it clears the same fail-closed bar the other
  // prompt-injection-capable coordination writes clear: on a shared/multiplayer or
  // network-exposed collector only a request carrying the out-of-band token may
  // release a held resolution (isTrustedCoordinationWrite). Single-user loopback
  // stays tokenless.
  const RESOLUTION_WRITE_TOKEN_ERROR =
    "confirming, rejecting, or swapping a held contradiction resolution on a " +
    "shared/multiplayer or network-exposed collector requires the out-of-band write " +
    "token (x-standup-write-token matching STANDUP_WRITE_TOKEN)";

  // Nudge the Knowledge tab (and the needs-review list) to refetch the two docs a
  // resolution just touched.
  function broadcastResolutionResolved(
    projectId: string,
    winnerSlug: string,
    loserSlug: string
  ): void {
    for (const slug of [winnerSlug, loserSlug]) {
      broadcast({
        type: "knowledge:draft",
        payload: { projectId, slug },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // The still-open human-review queue across every project (or one, via
  // ?project=), each row carrying the winner/loser doc titles alongside the
  // rationale + proposal `detail` a human needs to decide.
  app.get("/api/knowledge/needs-review", (c) => {
    const project = c.req.query("project") || undefined;
    const rows = getPendingResolutions(store.db, project).map((r) => ({
      ...r,
      winnerTitle: knowledgeBackend.getDoc(r.projectId, r.winnerSlug)?.title ?? r.winnerSlug,
      loserTitle: knowledgeBackend.getDoc(r.projectId, r.loserSlug)?.title ?? r.loserSlug,
    }));
    return c.json(rows);
  });

  // Confirm a held resolution: apply the withheld proposal exactly as the
  // auto-path would have (tombstone the loser, clear the winner's contradiction
  // edge), then flip the row to `applied` (auto_applied stays 0 — a human, not the
  // gate, released it). Reuses acceptResolution so the apply mechanics are not
  // duplicated.
  app.post("/api/knowledge/resolutions/:id/confirm", async (c) => {
    if (!isTrustedCoordinationWrite(c)) {
      return c.json({ error: RESOLUTION_WRITE_TOKEN_ERROR }, 403);
    }
    if (!contradictionResolveDeps) {
      return c.json({ error: "knowledge sync is not wired on this collector" }, 503);
    }
    const rid = c.req.param("id");
    const row = getKnowledgeResolution(store.db, rid);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "needs_review") {
      return c.json({ error: "resolution is not pending review" }, 409);
    }
    const proposal = proposalFromResolution(row);
    if (!proposal) {
      return c.json({ error: "resolution detail is incomplete — cannot replay it" }, 422);
    }
    const confirmResolutionRefusal = await resolutionPersonalLayerRefusal(row.projectId, [row.winnerSlug, row.loserSlug]);
    if (confirmResolutionRefusal) return c.json({ error: confirmResolutionRefusal }, 403);
    const outcome = await acceptResolution(contradictionResolveDeps, row.projectId, proposal);
    if (outcome.status !== "applied") {
      return c.json({ error: `could not apply resolution: ${outcome.status}`, outcome }, 409);
    }
    markResolutionApplied(store.db, rid);
    broadcastResolutionResolved(row.projectId, row.winnerSlug, row.loserSlug);
    return c.json({ ok: true, outcome });
  });

  // Reject a held resolution: dismiss it WITHOUT superseding either claim. Strips
  // the `Contradicts` edge off BOTH docs (so neither stays flagged "contradicted")
  // and voids the ledger row. No tombstone, no body rewrite; re-detection may
  // re-surface the pair later.
  app.post("/api/knowledge/resolutions/:id/reject", async (c) => {
    if (!isTrustedCoordinationWrite(c)) {
      return c.json({ error: RESOLUTION_WRITE_TOKEN_ERROR }, 403);
    }
    if (!contradictionResolveDeps) {
      return c.json({ error: "knowledge sync is not wired on this collector" }, 503);
    }
    const rid = c.req.param("id");
    const row = getKnowledgeResolution(store.db, rid);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "needs_review") {
      return c.json({ error: "resolution is not pending review" }, 409);
    }
    await rejectResolution(contradictionResolveDeps, row.projectId, row.winnerSlug, row.loserSlug);
    deleteKnowledgeResolution(store.db, rid);
    broadcastResolutionResolved(row.projectId, row.winnerSlug, row.loserSlug);
    return c.json({ ok: true });
  });

  // Swap-winner: confirm the held resolution but with the winner/loser reversed —
  // the human's opposite call on which claim wins. Applies the mirror-image
  // proposal (tombstoning the doc the resolver had picked as winner), records the
  // swapped roles on the row, and marks it applied.
  app.post("/api/knowledge/resolutions/:id/swap", async (c) => {
    if (!isTrustedCoordinationWrite(c)) {
      return c.json({ error: RESOLUTION_WRITE_TOKEN_ERROR }, 403);
    }
    if (!contradictionResolveDeps) {
      return c.json({ error: "knowledge sync is not wired on this collector" }, 503);
    }
    const rid = c.req.param("id");
    const row = getKnowledgeResolution(store.db, rid);
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "needs_review") {
      return c.json({ error: "resolution is not pending review" }, 409);
    }
    const proposal = proposalFromResolution(row);
    if (!proposal) {
      return c.json({ error: "resolution detail is incomplete — cannot replay it" }, 422);
    }
    const swapResolutionRefusal = await resolutionPersonalLayerRefusal(row.projectId, [row.winnerSlug, row.loserSlug]);
    if (swapResolutionRefusal) return c.json({ error: swapResolutionRefusal }, 403);
    const swapped = swapProposal(proposal);
    const outcome = await acceptResolution(contradictionResolveDeps, row.projectId, swapped);
    if (outcome.status !== "applied") {
      return c.json({ error: `could not apply resolution: ${outcome.status}`, outcome }, 409);
    }
    updateResolutionWinnerLoser(store.db, rid, swapped.winnerSlug, swapped.loserSlug);
    markResolutionApplied(store.db, rid);
    broadcastResolutionResolved(row.projectId, swapped.winnerSlug, swapped.loserSlug);
    return c.json({ ok: true, outcome });
  });

  /**
   * A 400 for a doc route whose project id or slug isn't one path segment:
   * the router decodes `%2F`, so `persona-..%2F..%2Fproj%2Fdoc` would name a
   * file in another project.
   */
  const unsafeDocPath = (c: Context) =>
    isSafePathSegment(c.req.param("id") ?? "") && isSafePathSegment(c.req.param("slug") ?? "")
      ? null
      : c.json({ error: "project id and slug must each be a single path segment" }, 400);

  app.get("/api/projects/:id/knowledge/:slug", async (c) => {
    const unsafe = unsafeDocPath(c);
    if (unsafe) return unsafe;
    const projectId = c.req.param("id");
    const doc = await readKnowledgeFile(knowledgeDir, projectId, c.req.param("slug"));
    // Another user's personal doc reads as absent, like a scoped fetch.
    if (!doc || !isDocInAudience({ ...doc, projectId }, resolveBrowseAudience(c, projectId))) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(doc);
  });

  app.put("/api/projects/:id/knowledge/:slug", async (c) => {
    const unsafe = unsafeDocPath(c);
    if (unsafe) return unsafe;
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json<{
      title?: string;
      body?: string;
      tags?: string[];
      source_kind?: string;
      scope?: string;
      origin_class?: string;
    }>();

    if (!getProject(store.db, projectId)) {
      return c.json({ error: "Unknown project" }, 404);
    }
    // Creating or editing a doc homed under the reserved GLOBAL corpus reaches
    // EVERY project's agents (scopeAudienceSql's reserved-corpus disjunct), so it
    // is an audience-widening write gated exactly like scope='global' — the HOME
    // half of the same guard resolveAuthoredAudience applies to the scope column.
    // An AUTHENTICATED tunnel identity may make this desired corpus-wide
    // contribution; only a caller with no authenticated identity (a raw non-tunnel
    // network bind) is refused, absent the optional write-token fallback.
    if (!mayWriteGlobalCorpus(c, projectId)) {
      return c.json(
        {
          error:
            "Writing into the reserved global corpus requires an authenticated identity (a tunnel-authenticated caller, a single-user loopback collector, or a matching write token).",
        },
        403
      );
    }
    if (!body.body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }
    // Reject a garbage explicit scope rather than coercing it (see the propose
    // route). An absent scope preserves the doc's existing scope on a plain edit,
    // or takes the project default on a first create — resolved below.
    if (body.scope !== undefined && !isValidScope(body.scope)) {
      return c.json({ error: `scope must be one of ${SCOPES.join(", ")}` }, 400);
    }

    // Carried over explicitly (phase-7 Step 6) — see writeKnowledgeFile's
    // doc comment. Editing text is a smaller act than the merge-accept path
    // below (which drops provenance on purpose), and losing it here would
    // make a typo fix silently exempt a generated doc from staleness for
    // good.
    const existing = await readKnowledgeFile(knowledgeDir, projectId, slug);
    // Another user's personal doc reads as absent to this caller (the GET
    // route), so a write that lands on its slug is refused rather than
    // replacing it.
    if (existing && isAnotherUsersPersonalDoc(c, projectId, existing)) {
      return c.json({ error: `${slug} is another user's personal doc` }, 409);
    }
    const fromPersona = isPersonaWrite(c);
    const putPersonalRefusal = personalLayerWriteRefusal(c, { slug, requestedScope: body.scope, docs: [existing] });
    if (putPersonalRefusal) return c.json({ error: putPersonalRefusal }, 403);

    // A human editing the body re-asserts the doc as correct as of now — the
    // same act that clears the re-verification verdict below. If the cron had
    // DISPUTED it, it wrote the confidence down below the injection floor
    // (DISPUTED_CONFIDENCE); a stored base under the floor is gated out of
    // auto-injection ALWAYS, independent of whether re-verification is active
    // (see isConfidenceEligibleForInjection). Clearing the verdict alone would
    // leave that refuted doc silently withheld from search/launch injection
    // with no recovery path once re-verification is off — so a human
    // re-assertion must also lift the confidence back, matching the "only a
    // human re-accepting the doc lifts a refuted fact back" contract. Reset a
    // refuted doc to full confidence stamped now (re-arming its half-life).
    // Any other change to the body is the author restating the doc as current:
    // its decay clock restarts now and an asserted base below the default is
    // lifted to it. An edit that leaves the body alone (title, tags, scope)
    // round-trips the existing confidence/freshness stamp. An agent-written doc
    // still waiting on its first fact-check (isPendingVerification:
    // UNVERIFIED_CONFIDENCE, never verified) is not promoted by an edit: it
    // stays pending, and the verification decides.
    const wasRefuted =
      typeof existing?.confidence === "number" &&
      Number.isFinite(existing.confidence) &&
      existing.confidence < MIN_INJECTION_CONFIDENCE;
    const reasserted =
      !isPendingVerification(existing) &&
      (wasRefuted || (existing !== null && existing.body.trim() !== body.body.trim()));

    // Scope + owning user on an EDIT/create. scope/owner_user are
    // file-authoritative dimensions that decide a doc's RETRIEVAL AUDIENCE, so a
    // full rewrite must not let a plain body edit silently change that audience.
    // resolveAuthoredAudience is the single choke point that both this route and
    // the propose create/replace path funnel through: it resolves the acting
    // identity server-side, applies the one audience gate, and preserves an
    // existing doc's scope+owner (clamping a brand-new doc to the visible
    // 'project' default) when the caller is not trusted to change the audience.
    // The client-supplied `body.scope` is honored only as a deliberate change; the
    // request's `owner_user` is ignored (owner is always the acting caller).
    const { scope: resolvedScope, ownerUser: resolvedOwner } = resolveAuthoredAudience(c, {
      projectId,
      requestedScope: isValidScope(body.scope) ? body.scope : undefined,
      existing,
    });

    // Persona's memories go through the same near-duplicate check as an agent's
    // proposal: a new memory restating one the owner's audience already holds is
    // refused with the doc to update instead (Persona re-saves under that topic).
    if (fromPersona && !existing) {
      const nearest = await nearestDocs(
        projectId,
        { slug, title: body.title?.trim() || slug, body: body.body },
        resolveAgentAudience(c, projectId)
      );
      const dup = nearest.find((n) => n.duplicate);
      if (dup) {
        return c.json(
          {
            error: `this restates ${dup.projectId}/${dup.slug} ("${dup.title}"); update that doc instead of saving a new one`,
            duplicateOf: nearestSummary(dup),
            nearest: nearest.map(nearestSummary),
          },
          422
        );
      }
    }

    try {
      await writeKnowledgeFile(knowledgeDir, projectId, {
        slug,
        title: body.title?.trim() || slug,
        body: body.body,
        // Only Persona's own write keeps the tag that marks one of its memories
        // (see persona/memory-trust.ts).
        tags: knowledgeWriteTags(body.tags, fromPersona),
        generatedFromSha: existing?.generatedFromSha,
        generatedAt: existing?.generatedAt,
        // Round-tripped alongside the provenance stamp: a full rewrite through
        // writeKnowledgeFile emits only what it is handed, so without this a
        // human typo-fix on an accepted distilled doc would sever its
        // cross-project `related:` edges and its session→doc provenance, and
        // silently revert origin_class to the loader's `owner` default —
        // destroying exactly the self-grown graph connectivity the distiller
        // built. undefined for a hand-authored doc leaves the frontmatter clean.
        related: existing?.related,
        // A writer may mark its doc as agent-written (Persona's memories) but
        // never raise a doc's trust: `agent` is honored from the body only
        // over an owner-written (or new) doc.
        originClass:
          body.origin_class === "agent" && (!existing?.originClass || existing.originClass === "owner")
            ? "agent"
            : existing?.originClass,
        sourceSessionId: existing?.sourceSessionId,
        // Round-tripped for the same reason as the provenance fields (roadmap
        // r2): a plain text edit must not silently reset a doc's source kind or
        // its confidence/freshness stamp — except a refuted doc, whose
        // sub-floor confidence the human edit re-asserts back to full. A
        // reviewer MAY reclassify the kind (e.g. promote a doc to product/spec
        // so it feeds launch-time product injection, roadmap r8); an
        // omitted/invalid value preserves the doc's existing kind. An edited
        // native-memory mirror is no longer a copy of the owner's file (the
        // write drops its native_memory_from marker), so it loses that kind.
        sourceKind:
          normalizeSourceKind(body.source_kind) ??
          (existing?.sourceKind === "native-memory" ? undefined : existing?.sourceKind),
        // Round-tripped for the same reason as the provenance fields: scope +
        // owning user are file-authoritative dimensions, so a full rewrite that
        // omitted them would silently demote a hand-promoted `scope: global` (or
        // a `scope: user`/`owner_user:` personal doc) back to the loader's
        // `project` default on the next resync — losing the deliberate
        // promotion/ownership on a plain typo fix. undefined for an unpromoted
        // project doc leaves the frontmatter clean. An explicit request scope
        // overrides this (change/promote); see the resolution above.
        scope: resolvedScope,
        ownerUser: resolvedOwner,
        confidence: wasRefuted
          ? INITIAL_CONFIDENCE
          : reasserted && existing?.confidence !== undefined
            ? Math.max(existing.confidence, DEFAULT_BASE_CONFIDENCE)
            : existing?.confidence,
        lastVerifiedAt: reasserted ? new Date().toISOString() : existing?.lastVerifiedAt,
        halfLifeDays: existing?.halfLifeDays,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    await knowledgeSync?.syncProject(projectId);
    // Edited text is a claim nobody has re-checked — a verdict the cron recorded
    // against the doc's previous body would otherwise keep marking the new text
    // disputed (roadmap r5 review), mirroring resetDraftVerdict on the draft edit
    // path. After syncProject, since upsertDoc preserves the verdict column.
    knowledgeSync?.clearDocVerdict(projectId, slug);
    // The one place a row is stamped as Persona's: its own write, as synced.
    if (fromPersona) knowledgeSync?.stampWriter(projectId, slug, PERSONA_WRITER);
    broadcastProjects();
    return c.json({ ok: true });
  });

  app.delete("/api/projects/:id/knowledge/:slug", async (c) => {
    const unsafe = unsafeDocPath(c);
    if (unsafe) return unsafe;
    const projectId = c.req.param("id");
    const slug = c.req.param("slug");
    // Read the title before deleting so the feed line names the doc rather than
    // its slug; falls back to the slug if the doc is already gone from the index.
    const removedTitle =
      knowledgeSync?.getDocs(projectId).find((d) => d.slug === slug)?.title ?? slug;
    // Another user's personal doc reads as absent to this caller.
    const existing = await readKnowledgeFile(knowledgeDir, projectId, slug);
    if (existing && isAnotherUsersPersonalDoc(c, projectId, existing)) {
      return c.json({ error: "Not found" }, 404);
    }
    const deletePersonalRefusal = personalLayerWriteRefusal(c, { slug, docs: [existing] });
    if (deletePersonalRefusal) return c.json({ error: deletePersonalRefusal }, 403);
    const removed = await deleteKnowledgeFile(knowledgeDir, projectId, slug);
    if (!removed) return c.json({ error: "Not found" }, 404);

    await knowledgeSync?.syncProject(projectId);
    broadcastProjects();
    // Removing an accepted doc shrinks the graph — a substantive change on both
    // feed surfaces.
    emitKnowledgeChange("removed", projectId, slug, removedTitle, { doc: existing });
    return c.json({ ok: true });
  });

  // Sessions. Ended ones are excluded by default so the console reflects
  // what's live; ?all=1 includes them so they can be reviewed and cleaned up.
  app.get("/api/sessions", async (c) => {
    const all = c.req.query("all") === "1";
    const roots = all ? getAllSessions(store.db) : getActiveSessions(store.db);
    // Subagent children are excluded from the flat root lists, but the client
    // needs them in the same payload to nest each under its parent. Include all
    // children for ?all=1; for the active view include only children whose parent
    // is present (a child of an ended parent has no row to nest under).
    const rootIds = new Set(roots.map((r) => r.id));
    const children = getSubagentSessions(store.db).filter(
      (ch) => all || (ch.parentSessionId != null && rootIds.has(ch.parentSessionId))
    );
    const sessions = [...roots, ...children];
    return c.json(await withActivityTicksBatch(store, sessions));
  });

  app.get("/api/sessions/:id", async (c) => {
    const session = getSession(store.db, c.req.param("id"));
    if (!session) return c.json({ error: "Not found" }, 404);
    return c.json(await withActivityTicks(store, session));
  });

  /**
   * Who has worked on a session: the best-effort participant set
   * plus the resolved actor records for everyone it references — the
   * participants themselves and the session's creator/owner — so a client can
   * render per-session attribution without a second lookup per alias. The
   * write side (recordParticipant on steer/reply/resolve/dispatch) had no read
   * path before this; this is it.
   */
  app.get("/api/sessions/:id/participants", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    // Resolve every participant through the actor-merge tombstones (getActor
    // follows `merged_into`) and fold rows that collapse to one canonical
    // identity — the same resolve-through-merge contract withActivityTicks and
    // getActors honor. Without it a since-merged id (e.g. a `slack:U…` folded
    // into a user alias) would surface as a second ghost row, rendered by its
    // raw id, alongside the canonical actor. Rows arrive ordered by first_seen,
    // so the first hit for a canonical id keeps the earliest timestamp; later
    // hits just add to its contribution count.
    const canonical = (id: string): string => getActor(store.db, id)?.id ?? id;
    const folded = new Map<string, SessionParticipant>();
    for (const p of getParticipants(store.db, sessionId)) {
      const id = canonical(p.actorId);
      const existing = folded.get(id);
      if (existing) {
        existing.contributionCount += p.contributionCount;
      } else {
        folded.set(id, { ...p, actorId: id });
      }
    }
    const participants = [...folded.values()];

    const ids = new Set<string>(participants.map((p) => p.actorId));
    if (session.createdActor) ids.add(canonical(session.createdActor));
    if (session.ownerActor) ids.add(canonical(session.ownerActor));
    const actors = [...ids]
      .map((id) => getActor(store.db, id))
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return c.json({ participants, actors });
  });

  /**
   * Jump into a shared session (Personalization/Multiplayer spec F). Records the
   * acting tunnel user as a participant so *opening* someone else's thread — not
   * only replying into it — counts as collaboration: they show up in the
   * participant set and the session flips to "Mine" the instant they enter,
   * rather than only once they've steered or sent. Best-effort and idempotent,
   * mirroring the steer/reply/resolve write paths (recordParticipant dedups on
   * the set). Works for a monitored session too, which a teammate can follow but
   * can't type into. Re-broadcasts the session's current status so every client
   * refreshes the participant set it renders.
   */
  app.post("/api/sessions/:id/join", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    recordParticipant(
      store.db,
      sessionId,
      actingAlias(c)
    );

    broadcast({
      type: "session:status",
      payload: { sessionId, status: session.status },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  app.get("/api/projects/:id/sessions", async (c) => {
    const sessions = getSessionsByProject(store.db, c.req.param("id"));
    return c.json(await withActivityTicksBatch(store, sessions));
  });

  /**
   * Stops the agent behind a session. Only possible for launched sessions —
   * Standup owns their tmux pane. A monitored session belongs to the human's
   * own terminal, and reaching into it is exactly what the design declines
   * to build on.
   */
  app.post("/api/sessions/:id/stop", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "This session wasn't launched by the console, so Standup doesn't own it — stop it from its own terminal.",
        },
        409
      );
    }

    // Pending asks are cancelled (the process that would answer them is gone);
    // queued steers and peer messages ride through to a resumed agent. A worker
    // its closed job kept running gets that job's hygiene once it is stopped.
    const result = await stopSession(
      store.db,
      {
        broadcast,
        unwatch: (id) => tailer?.unwatch(id),
        stopLaunch: stopLaunchPane,
        afterStop: hygieneStep(),
      },
      session,
      launch
    );
    return c.json(result);
  });

  /**
   * Closes any session that isn't a worker of an open Persona job: a launched
   * one has its pane killed as /stop does, and one Standup owns no process
   * for (monitored, imported, or left by a launch that is gone) has its record
   * ended. Body `{ deleteFromList: true }` also deletes it, as DELETE does.
   *
   * Only the owner may call it — through an owner channel, or through the
   * host's Persona tool layer carrying out a close the owner consented to.
   * Either way a session another user owns is refused.
   */
  app.post("/api/sessions/:id/close", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);
    const persona = personaRuntimeCallOf(c);
    if (!persona?.isHost) {
      const refused = ownerRefusal(c, "close a session");
      if (refused) return refused;
    }
    // Attribution read through actor merges, as session responses show it.
    const resolveActor = actorResolver(store.db);
    const canonical = (id: string | undefined) => (id ? resolveActor(id)?.id ?? id : id);
    const actor = canonical(persona?.owner ?? ownerAlias)!;
    const refusal = closeRefusal(
      store.db,
      { ...session, ownerActor: canonical(session.ownerActor), createdActor: canonical(session.createdActor) },
      actor,
      canonical(ownerAlias)!
    );
    if (refusal) return c.json({ error: refusal.error, code: refusal.code }, refusal.status);

    const body = (await c.req.json().catch(() => ({}))) as { deleteFromList?: unknown };
    const result = await closeSession(
      store.db,
      {
        broadcast,
        unwatch: (id) => tailer?.unwatch(id),
        stopLaunch: stopLaunchPane,
        afterStop: hygieneStep(),
        ...(lifecycle.paneAlive ? { paneExists: lifecycle.paneAlive } : {}),
        forget: (id) => {
          clearTodoCheckpointState(id);
          clearNudgeState(id);
          clearAutoCheckpointState(id);
          clearTitleSummaryState(id);
        },
      },
      session,
      { deleteFromList: body.deleteFromList === true }
    );
    if (result.refused) return c.json({ error: result.refused, code: "still_running" }, 409);
    if (!result.ok) return c.json({ error: result.log.join("; ") || "Couldn't stop the session's pane", log: result.log }, 500);
    return c.json(result);
  });

  /**
   * The session's current screen, when Standup owns its pane.
   *
   * Keyed by session rather than launch so callers holding an ask (which
   * references a session) can show what the agent is actually waiting on. A
   * Notification hook reports *that* an agent is blocked but never *what*
   * it's blocked on — without this, a prompt-ask is an alert with no
   * content, which is not something a human can act on.
   */
  app.get("/api/sessions/:id/output", async (c) => {
    const sessionId = c.req.param("id");
    const launch = getLaunchBySession(store.db, sessionId);

    // Not an error: monitored sessions simply have no pane to read, and the
    // caller renders that as "look at your own terminal".
    if (!launch) return c.json({ output: "", alive: false, owned: false });

    try {
      const result = await captureLaunchOutput(launch, 60);
      return c.json({ ...result, owned: true });
    } catch {
      return c.json({ output: "", alive: false, owned: true });
    }
  });

  /**
   * The session's actual conversation, read from Claude Code's transcript.
   *
   * Works for monitored sessions as well as launched ones, and with full
   * history either way: the transcript covers the whole session including
   * whatever happened before Standup started observing.
   *
   * `owned` tells the client whether replying is possible — Standup can only
   * type into panes it created.
   */
  app.get("/api/sessions/:id/transcript", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    const path = transcriptPathForSession(store.db, sessionId);
    if (!path) {
      return c.json({
        messages: [],
        hasMore: false,
        totalMessages: 0,
        totalTokens: 0,
        owned: false,
      });
    }

    // Capped: the reader only tails a fixed slice of the file, so asking for
    // more than it can hold would promise history it cannot return.
    const limit = Math.min(parseInt(c.req.query("limit") ?? "40"), 400);
    const page = await readTranscript(path, limit, transcriptFilterSessionId(session));

    return c.json({ ...page, owned: !!getLaunchBySession(store.db, sessionId) });
  });

  /**
   * The same conversation as /transcript, but full-fidelity: an ordered row
   * stream (thinking, per-block text, tool calls with their structured
   * results, compaction boundaries, mode changes) for the terminal-mode view.
   * See rich-transcript.ts.
   */
  app.get("/api/sessions/:id/transcript/rich", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    const path = transcriptPathForSession(store.db, sessionId);
    if (!path) {
      return c.json({
        rows: [],
        hasMore: false,
        truncated: false,
        totalRows: 0,
        outputTokens: 0,
        contextTokens: 0,
        owned: false,
      });
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "60"), 600);
    const page = await readRichTranscript(path, limit, transcriptFilterSessionId(session));

    return c.json({ ...page, owned: !!getLaunchBySession(store.db, sessionId) });
  });

  // ============================================================================
  // Fleet token/cost telemetry — per-session and fleet-wide token usage summed
  // from each session's transcript, with an estimated cost from a per-model
  // pricing map (see usage.ts). Derived on read from the transcript, not from a
  // mirror table. `?all=1` includes ended sessions; default is active only,
  // mirroring GET /api/sessions. Each session's transcript is streamed, and the
  // fan-out is capped (mapWithConcurrency) so `?all=1` over a large fleet can't
  // open every transcript at once — bounding file handles and resident memory.
  // ============================================================================
  /**
   * The usage rows for the fleet (active only unless `all`), heaviest first.
   * With `forActor`, only the rows whose persisted actor (owner, else creator,
   * else launch requester) is exactly that alias — filtered before any
   * transcript is read, so a per-user read never opens anyone else's. The
   * match is on the stored alias, not through actor-merge tombstones: a merge
   * needs no proof of either identity, so following it would let anyone fold
   * another user's spend into their own view.
   */
  const usageRows = async (all: boolean, forActor?: string): Promise<SessionUsage[]> => {
    const sessions = all ? getAllSessions(store.db) : getActiveSessions(store.db);
    const mine = (actor: string | null | undefined): boolean =>
      forActor === undefined || actor?.trim() === forActor;

    // Codex launches have no Claude session/transcript — their usage lives in the
    // JSONL sidecar the launcher tees `codex exec --json` stdout to. Reconcile
    // each into the SAME fleet telemetry (readCodexSessionUsage → codexUsageToRecord
    // → aggregateUsage), so a Codex run's tokens/cost land alongside Claude
    // sessions. `all` mirrors the session view: active (starting/running) only by
    // default, every codex launch with `?all=1`. Bounded by the same read pool.
    const allCodexLaunches = getCodexLaunches(store.db, { activeOnly: !all });

    // The observer attaches a real session row (the Codex thread id) to a codex
    // launch, so that session is also in `sessions` above — but it carries no hook
    // transcript, so the Claude path would emit a phantom zero-usage row keyed by
    // the same id as the sidecar-derived codex row below, double-listing the run
    // and over-counting sessionCount. Drop those ids from the Claude loop so an
    // observed codex run is listed once, carrying its real sidecar usage.
    const codexSessionIds = new Set(
      allCodexLaunches.map((l) => l.sessionId).filter((id): id is string => id != null)
    );
    const claudeSessions = sessions.filter(
      (s) => !codexSessionIds.has(s.id) && mine(s.ownerActor ?? s.createdActor)
    );
    // A codex run's actor is its observed session's owner → creator, else the
    // launch's requester — the same rule its row's `user` is attributed by.
    const codexLaunches = allCodexLaunches
      .map((l) => ({ l, observed: l.sessionId ? getSession(store.db, l.sessionId) : null }))
      .filter(({ l, observed }) => mine(observed?.ownerActor ?? observed?.createdActor ?? l.requester));

    const rows: SessionUsage[] = await mapWithConcurrency(
      claudeSessions,
      FLEET_USAGE_READ_CONCURRENCY,
      async (s) => {
        const path = transcriptPathForSession(store.db, s.id);
        const usage = await readSessionUsage(path, s.id);
        return {
          sessionId: s.id,
          projectId: s.projectId,
          title: s.title,
          status: s.status,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd,
          // Attributed to the session's persisted actor (owner, else creator),
          // read straight from the row — never re-resolved from the reading
          // request. Null for genuinely-unattributed spend: the anonymous
          // sentinel (a raw non-loopback client with no trusted tunnel identity)
          // OR the host fallback identity a no-tunnel / single-player session is
          // stamped with (`$USER` else "local"), both of which attributedUser
          // folds to null so that spend buckets on its own rather than being
          // pinned to the host operator. Only a real tunnel-authenticated alias
          // stays attributed.
          user: attributedUser(s.ownerActor ?? s.createdActor),
        } satisfies SessionUsage;
      }
    );

    const codexRows: SessionUsage[] = await mapWithConcurrency(
      codexLaunches,
      FLEET_USAGE_READ_CONCURRENCY,
      async ({ l, observed }) => {
        // No model arg: the composer's model aliases are Claude's, not the Codex
        // model the run actually used, so the honest label is unknown (unpriced)
        // rather than a mislabeled Claude alias.
        const usage = await readCodexSessionUsage(l.codexEventLog);
        // `observed` is the session the launch attached to (its Codex thread id),
        // if any — it carries the owner/creator a reassignment
        // (assignSessionOwner) may have set, which wins over the launch's
        // original requester.
        return {
          // Keyed by the observed session id when one attached (dropped from the
          // Claude loop above so it isn't double-listed), else the launch id for a
          // run that hasn't emitted thread.started yet.
          sessionId: l.sessionId ?? l.id,
          projectId: l.projectId,
          title: l.task,
          // A live launch (starting/running) reads as 'running'; a finished one
          // (failed/cleaned) as 'done' — the closest SessionStatus projections.
          status: l.status === "starting" || l.status === "running" ? "running" : "done",
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          totalTokens: usage.totalTokens,
          costUsd: usage.costUsd,
          // Owner → creator → requester, matching the Claude owner-wins rule: an
          // observed session reassigned via assignSessionOwner attributes to that
          // owner, else its creator, else the launch's requester. attributedUser
          // folds the anonymous sentinel and the host fallback identity to null,
          // so an automatic (adoption/review-agent) launch with no real identity
          // buckets as unattributed.
          user: attributedUser(observed?.ownerActor ?? observed?.createdActor ?? l.requester),
        } satisfies SessionUsage;
      }
    );
    rows.push(...codexRows);

    // Heaviest first — the cost view leads with what's spending the most.
    rows.sort((a, b) => b.totalTokens - a.totalTokens);
    return rows;
  };

  // Every user's spend, so the owner's alone to read; anyone else reads their
  // own through /api/usage/me.
  app.get("/api/usage/fleet", async (c) => {
    const refused = ownerRefusal(c, "read every user's cost");
    if (refused) return refused;
    const rows = await usageRows(c.req.query("all") === "1");

    // The fleet grand total and the per-user breakdown come from the SAME rows
    // through the SAME reducer, so summing every byUser bucket reconciles back
    // to `totals` — cost by person never drifts from the fleet headline.
    const totals = reduceFleetTotals(rows);
    const byUser = usageByUser(rows);

    return c.json({ sessions: rows, totals, byUser } satisfies FleetUsage);
  });

  // The signed-in viewer's own usage — the You tab's cost section. The viewer
  // is scopingUser: the host on loopback (or by its own tunnel alias), and any
  // other alias only with a proof a worker never holds (its user channel
  // token, its own Persona runtime, or an owner channel naming it). The
  // identity header alone can be forged by any loopback worker, so a viewer it
  // can't prove gets a 403 `sign-in` rather than that alias's spend. The host
  // fallback identity is not folded to unattributed here, so the host's own
  // sessions count as the host's even though the fleet view buckets them apart.
  app.get("/api/usage/me", async (c) => {
    const viewer = scopingUser(c)?.trim();
    if (!viewer || viewer === ANONYMOUS_ALIAS) {
      return c.json({ error: "Sign in to the console to see your own usage.", reason: "sign-in" }, 403);
    }
    const all = c.req.query("all") === "1";
    const rows = await usageRows(all, viewer);
    return c.json({
      user: viewer,
      sessions: rows,
      totals: reduceFleetTotals(rows),
      persona: personaUsageFor(store.db, viewer, { all }),
    } satisfies UserUsage);
  });

  /**
   * The durable, sequence-numbered transcript log: the
   * canonical SERVED transcript state, so more than one device can follow a
   * session without each tail-reading the JSONL itself. The JSONL is reconciled
   * into the log here, lazily, before serving — cheap (stat-gated, dedups by
   * uuid), the same pattern search_knowledge uses. Clients page forward from
   * `sinceSeq` and keep passing the returned `cursor` back.
   */
  app.get("/api/sessions/:id/transcript/events", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) {
      return c.json({ error: "Not found" }, 404);
    }

    const path = transcriptPathForSession(store.db, sessionId);
    // A subagent child's dedicated transcript file carries the parent's real
    // UUID, not the synthetic child id it stores under — skip the cross-session
    // filter for it (see transcriptFilterSessionId) so the durable log isn't
    // left empty. Records still store under `sessionId` (the child id).
    const { head, appended } = await ingestTranscriptEvents(store.db, sessionId, path, {
      skipSessionFilter: session.kind === "subagent",
    });

    // Nudge every connected client that new transcript state landed, so a
    // second device already viewing this session pulls its delta. Only when
    // the ingest actually advanced the head — a no-op read shouldn't chatter.
    if (appended > 0) {
      broadcast({
        type: "session:event",
        payload: { sessionId, seq: head },
        timestamp: new Date().toISOString(),
      });
    }

    const limit = Math.min(parseInt(c.req.query("limit") ?? "500") || 500, 2000);
    // A `before` query selects a backward (tail) page — the newest `limit`
    // events with seq < before, or the tail when before=0. This lets a client
    // open a long session in constant time (load the tail, page earlier on
    // demand) instead of walking the whole log forward from seq 0. Without it,
    // the request is the forward delta a live tail resumes from via `sinceSeq`.
    const beforeRaw = c.req.query("before");
    const owned = !!getLaunchBySession(store.db, sessionId);
    if (beforeRaw !== undefined) {
      const before = Math.max(0, parseInt(beforeRaw) || 0);
      const page = getEventsBefore(store.db, sessionId, before, limit);
      return c.json({ ...page, owned });
    }

    const sinceSeq = Math.max(0, parseInt(c.req.query("sinceSeq") ?? "0") || 0);
    const page = getEventsSince(store.db, sessionId, sinceSeq, limit);

    return c.json({ ...page, owned });
  });

  /**
   * Types into a session, keyed by session rather than launch so the
   * transcript view can reply without knowing about launches.
   */
  app.post("/api/sessions/:id/send", async (c) => {
    const sessionId = c.req.param("id");
    const { text, idempotencyKey, actor: actorOverride } = await c.req.json<{
      text: string;
      idempotencyKey?: string;
      actor?: string;
    }>();
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);
    const trimmed = text.trim();

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "Standup didn't launch this session, so it can't type into it — reply in its own terminal.",
        },
        409
      );
    }
    if (startsWithShellEscape(trimmed) && launchMayBeBypassed(store.db, launch)) {
      return c.json({ error: `Can't send this: ${SHELL_ESCAPE_REFUSAL}.` }, 400);
    }
    // A worker paused for idleness is resumed into its pane before the text goes in.
    if (launch.reapedAt) {
      const woke = await wakeIfReaped(store.db, sessionId, resumeDeps);
      // Not resumed by this call is fine when another call already resumed it.
      if (!woke.resumed && getLaunch(store.db, launch.id)?.reapedAt) {
        return c.json({ error: `This worker is paused and couldn't be resumed: ${woke.reason}.` }, 409);
      }
    }

    // An explicit `actor` (e.g. the Slack teammate steering from a thread) is
    // attributed as-is; off-tunnel there's no identity header, so
    // without it a Slack steerer would be miscounted as the host user.
    const actor = actingAlias(c, actorOverride);

    // Optimistic + idempotent send: claim the key by logging a pending reply
    // event BEFORE typing, so a retried or double-clicked send with the same key
    // finds the claim and returns a no-op instead of typing the text twice. The
    // pending event also shows the sender's message in the transcript at once,
    // and reconciles in place when the real turn ingests (see transcript.ts).
    if (idempotencyKey) {
      const claim = appendPendingReply(store.db, sessionId, {
        idempotencyKey,
        text: trimmed,
        actor,
      });
      if (!claim.inserted) {
        return c.json({ ok: true, deduped: true, seq: claim.seq });
      }
      const result = await sendToLaunch(launch, trimmed);
      if (!result.ok) {
        // The claim never became a real send — drop it so a genuine retry with
        // the same key isn't mistaken for a duplicate.
        releasePendingReply(store.db, sessionId, idempotencyKey);
        return c.json({ error: result.error }, 409);
      }
      // Nudge followers to pull the optimistic pending event.
      broadcast({
        type: "session:event",
        payload: { sessionId, seq: headSeq(store.db, sessionId) },
        timestamp: new Date().toISOString(),
      });
    } else {
      const result = await sendToLaunch(launch, trimmed);
      if (!result.ok) return c.json({ error: result.error }, 409);
    }

    // The message is in the worker's pane, so a park ends now rather than at
    // its prompt hook — which a harness without Claude Code's hooks never sends.
    // A busy worker submits it as a prompt later; noted, that prompt reads
    // as this message rather than one sent after a later park.
    recordPaneSend(sessionId, trimmed);
    pipelineMessageDelivered(store.db, sessionId, { broadcast });
    updateSessionStatus(store.db, sessionId, "running");
    // Best-effort collaboration record: the acting tunnel user touched this
    // session by replying into it.
    recordParticipant(store.db, sessionId, actor);
    broadcast({
      type: "session:status",
      payload: { sessionId, status: "running" },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  /**
   * Switches a running Claude session's model and/or effort mid-session by
   * typing Claude Code's own `/model` and `/effort` slash commands at its
   * prompt — the only way to change either once the TUI is up. The chosen
   * values are persisted on the launch so a later adopt resumes with them.
   * Keyed by session (like /send) so the session view can drive it without
   * knowing about launches.
   */
  app.post("/api/sessions/:id/settings", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req
      .json<{ model?: unknown; effort?: unknown }>()
      .catch(() => ({} as { model?: unknown; effort?: unknown }));
    const model = body.model === undefined || body.model === "" ? undefined : body.model;
    const effort = body.effort === undefined || body.effort === "" ? undefined : body.effort;

    if (model === undefined && effort === undefined) {
      return c.json({ error: "model or effort is required" }, 400);
    }
    if (model !== undefined && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${String(model)}` }, 400);
    }
    if (effort !== undefined && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort: ${String(effort)}` }, 400);
    }

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "Standup didn't launch this session, so it can't change its model or effort — use /model or /effort in its own terminal.",
        },
        409
      );
    }
    // A launch only stamps a harness when it isn't Claude; `/model` and
    // `/effort` are Claude Code commands with no meaning to another CLI.
    if (launch.harness && launch.harness !== "claude") {
      return c.json(
        { error: `Model/effort switching is only supported for Claude sessions, not ${launch.harness}.` },
        409
      );
    }

    // sendToLaunch refuses a pane that is no longer running, so a dead session
    // fails here before anything is persisted.
    if (model !== undefined) {
      const result = await sendToLaunch(launch, `/model ${model}`);
      if (!result.ok) return c.json({ error: result.error }, 409);
    }
    if (effort !== undefined) {
      const result = await sendToLaunch(launch, `/effort ${effort}`);
      if (!result.ok) {
        // The model switch (if any) already landed, so keep it on record.
        if (model !== undefined) {
          updateLaunchModelEffort(store.db, launch.id, { model: model as ClaudeModel });
        }
        return c.json({ error: result.error }, 409);
      }
    }

    updateLaunchModelEffort(store.db, launch.id, {
      model: model as ClaudeModel | undefined,
      effort: effort as ClaudeEffort | undefined,
    });
    recordParticipant(store.db, sessionId, actingAlias(c));

    const status = getSession(store.db, sessionId)?.status ?? "idle";
    broadcast({
      type: "session:status",
      payload: { sessionId, status },
      timestamp: new Date().toISOString(),
    });

    return c.json({
      ok: true,
      model: (model as ClaudeModel | undefined) ?? launch.model,
      effort: (effort as ClaudeEffort | undefined) ?? launch.effort,
    });
  });

  /**
   * Interrupts a session's current turn — the web equivalent of pressing Esc
   * in Claude Code. Keyed by session (like /send) so the transcript view can
   * fire it without knowing about launches. Sends the interrupt key into the
   * pane and leaves the agent idle at its prompt (not torn down, unlike /stop).
   */
  app.post("/api/sessions/:id/interrupt", async (c) => {
    const sessionId = c.req.param("id");

    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json(
        {
          error:
            "Standup didn't launch this session, so it can't interrupt it — press Esc in its own terminal.",
        },
        409
      );
    }

    const result = await interruptLaunch(launch);
    if (!result.ok) return c.json({ error: result.error }, 409);

    // Claude Code fires no Stop hook for a turn ended by Esc, so nothing else
    // will settle the session. Wait for the pane to return to its prompt and
    // settle it there, starting the next turn if steers are queued. A pane
    // still busy or on a dialog keeps its status for the resync sweep.
    const settled = await settleAfterInterrupt({ db: store.db, broadcast, pane: tmuxPaneDriver }, sessionId, launch);

    return c.json({ ok: true, settled: !!settled, delivered: settled?.delivered ?? 0 });
  });

  /**
   * Reads a launched session's pane and resyncs its recorded state to it:
   * closes a non-permission dialog with Escape, settles an idle prompt and
   * starts the next turn for queued steers and messages. A permission dialog
   * or a pending ask is reported and left untouched (see session-recovery.ts).
   */
  app.post("/api/sessions/:id/recover", async (c) => {
    const sessionId = c.req.param("id");
    const launch = getLaunchBySession(store.db, sessionId);
    if (!launch) {
      return c.json({ error: "Standup didn't launch this session, so it can't read or drive its pane." }, 409);
    }
    if (getSession(store.db, sessionId)?.endedAt) {
      return c.json({ error: "the session has ended; there is no pane to recover" }, 409);
    }
    const result = await recoverSession({ db: store.db, broadcast, pane: tmuxPaneDriver }, sessionId, launch);
    return c.json(result);
  });

  /**
   * Adopts a monitored session: resumes it under a tmux session Standup
   * owns, so it gains the read/type/stop capabilities a launched session
   * has. `claude --resume` reuses the session id, so existing history stays
   * attached.
   */
  app.post("/api/sessions/:id/adopt", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);
    // Adopting resumes a conversation under a bypass-mode pane in the session's
    // own directory, so it is the owner's call.
    const refused = ownerRefusal(c, "adopt a session");
    if (refused) return refused;

    // A session Standup previously launched can still be resumed once it has
    // died — `claude --resume <id>` reattaches to the same conversation. Only
    // refuse when it's still LIVE in an owned pane, since resuming that would
    // put two processes on one transcript. (Previously any launched session
    // was refused outright, which left a dead launched session unresumable.)
    const existing = getLaunchBySession(store.db, sessionId);
    if (existing?.tmuxSession && tmuxSessionExists(existing.tmuxSession)) {
      return c.json(
        { error: "This session is already running in a Standup-owned pane." },
        409
      );
    }

    try {
      const result = await adoptSession(store.db, session);

      broadcast({
        type: "launch:started",
        payload: result.launch,
        timestamp: new Date().toISOString(),
      });

      if (result.launch.status === "failed") {
        return c.json({ error: result.launch.error ?? "Adoption failed" }, 409);
      }

      // The resumed process reports in as the same session id, so clear the
      // ended marker rather than waiting for its first hook to revive it.
      reviveSession(store.db, sessionId);
      updateSessionStatus(store.db, sessionId, "running");
      broadcast({
        type: "session:status",
        payload: { sessionId, status: "running" },
        timestamp: new Date().toISOString(),
      });

      return c.json(result);
    } catch (err) {
      if (err instanceof LaunchRefusedError) return c.json(err.body, err.status);
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Frees the rows a session accumulated — events dominate the count. */
  app.delete("/api/sessions/:id", (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    // ensureSession recreates a row on the next hook from a live session, so
    // deleting one mid-flight discards its history and changes nothing else.
    if (!session.endedAt) {
      return c.json(
        {
          error:
            "Session is still active — stop or end it first, otherwise its next hook recreates the record.",
        },
        409
      );
    }

    const deleted = deleteSession(store.db, sessionId);
    clearTodoCheckpointState(sessionId);
    clearNudgeState(sessionId);

    broadcast({
      type: "session:deleted",
      payload: { sessionId, deleted },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true, deleted });
  });

  // Asks
  app.get("/api/asks/pending", (c) => {
    const handled = new Map<string, boolean>();
    const asks = getPendingAsks(store.db).map((ask) => {
      if (!handled.has(ask.sessionId)) handled.set(ask.sessionId, personaHandles(ask.sessionId));
      const cardDecider = ownerCarded(ask.id, ask.sessionId);
      if (cardDecider) return { ...ask, personaHandled: true, cardDecider };
      return handled.get(ask.sessionId) ? { ...ask, personaHandled: true } : ask;
    });
    return c.json(asks);
  });

  // The pending ask for a session, if any — lets the transcript view answer it
  // in place (with its ask id): a prompt-ask first, since the pane is blocked
  // on it, then the oldest ask_human (a floor hold included), then an idle
  // notice, which is stored as a permission_prompt but blocks nothing.
  app.get("/api/sessions/:id/pending-ask", (c) => {
    const sessionId = c.req.param("id");
    const asks = getPendingAsksBySession(store.db, sessionId);
    const ask =
      asks.find((a) => a.kind === "permission_prompt" && a.gate !== IDLE_NOTICE_GATE) ??
      asks.find((a) => a.kind === "ask_human") ??
      asks[0] ??
      null;
    // The structured questions come from the *current* block, not the
    // transcript — so an older, already-answered AskUserQuestion in history
    // can't be mistaken for the live prompt (which might be a plain Bash
    // approval the option panel must not try to answer with menu keystrokes).
    const questions = ask?.kind === "permission_prompt" ? pendingAskUserQuestion(store, sessionId) : null;
    return c.json({ ask, questions });
  });

  app.post("/api/asks/:id/resolve", async (c) => {
    const askId = c.req.param("id");
    // `actor` is optional — it lets a projecting client (e.g. the Slack adapter)
    // name the teammate who answered, since off-tunnel there's no
    // identity header to attribute the contribution to.
    const { answer, selections, override, actor } = await c.req.json<{
      answer?: string;
      // Per-question chosen option indices (0-based) for an AskUserQuestion
      // modal — one inner array per question, one element for single-select.
      // When present the answer is driven into the menu with keystrokes rather
      // than typed as free text (which the menu ignores).
      selections?: number[][];
      // Escape hatch for an AskUserQuestion the human doesn't want to answer on
      // its own terms: dismiss the menu and send `answer` as a fresh
      // instruction instead of a choice from the options.
      override?: boolean;
      actor?: string;
    }>();

    const ask = getAsk(store.db, askId);
    if (!ask) return c.json({ error: "Not found" }, 404);
    // Every check below reads `answer` as the text that gets stored; a number or
    // boolean would pass them as "not an allow" and then be stored as text the
    // waiter reads as one ("1").
    if (answer !== undefined && typeof answer !== "string") {
      return c.json({ error: "answer must be a string" }, 400);
    }
    // A safety-floor ask's waiter has already denied the call once it timed
    // out or was dismissed; a late answer must not turn the row into an allow
    // a re-attaching hook would read.
    if (isFloorGate(ask.gate) && ask.status !== "pending") {
      return c.json({ error: `This safety-floor hold is already ${ask.status}; the call was not run.` }, 409);
    }
    // Allowing a safety-floor hold runs the call, so it needs the owner token,
    // or Persona's own token — the host's Persona, for a session its own job
    // owns, on either floor gate, high-risk holds included (it records its
    // reason for the owner). A guest's Persona never allows
    // with its token (the call runs with the host's credentials), except to
    // carry out a split-mode card the guest approved (guestMayDecideFloor).
    // Denials need neither.
    const tokenRuntime = fleet?.byToken(c.req.header(PERSONA_TOKEN_HEADER));
    if (isFloorGate(ask.gate) && floorAnswerAllows(answer)) {
      if (tokenRuntime && !personaTokenMayAllow(tokenRuntime, ask)) {
        return c.json(
          {
            error: tokenRuntime.isHost
              ? "Persona may allow only a safety-floor hold in a session its own job owns."
              : `${tokenRuntime.owner}'s Persona can't allow a safety-floor hold: the call runs with ${ownerAlias}'s credentials, so ${ownerAlias} decides it.`,
          },
          403
        );
      }
      if (!tokenRuntime) {
        const refused = ownerRefusal(c, "allow this safety-floor hold (or Persona, with its token)");
        if (refused) return refused;
      }
    }

    // Answering a tool-permission prompt types into a dialog that lets a
    // worker's tool call run, and allowing a self-fix confirmation launches a
    // session against Standup's own repo; both are the owner's. Persona
    // answers neither itself: it raises an approval card, and the card the
    // owner approves is carried out with the owner token. The one exception is
    // the host's Persona allowing once, in a session its own job owns, a call
    // this collector classifies as plainly read-only from the call the
    // worker's hook recorded (permissionAskReadOnly), on a prompt still
    // pending whose call is still the only one in flight. It is typed as the
    // option's digit alone, once the pane shows that call's dialog. A deny
    // (the dialog's "No") runs nothing, so Persona types it the same way for
    // any call the deny can be told is behind the open dialog
    // (permissionDenyTarget), once that dialog's option is that "No".
    let personaReadOnly: { call: HeldToolCall; digit: string; want: "allow" | "deny" } | null = null;
    if (ask.kind === "permission_prompt" && ask.gate !== IDLE_NOTICE_GATE) {
      const digit = permissionAllowDigit(ask, answer);
      const denyDigit = permissionDenyDigit(ask, answer);
      if (
        tokenRuntime &&
        tokenRuntime.isHost &&
        override !== true &&
        selections === undefined &&
        (digit !== null || denyDigit !== null) &&
        personaJobForSession(store.db, ask.sessionId)?.job.owner === tokenRuntime.owner
      ) {
        if (denyDigit !== null) {
          const call = permissionDenyTarget(store.db, ask);
          if (call) personaReadOnly = { call, digit: denyDigit, want: "deny" };
        } else if (digit !== null) {
          const verdict = permissionAskReadOnly(store.db, ask);
          if (verdict.readOnly) personaReadOnly = { call: verdict.call, digit, want: "allow" };
        }
      }
      if (!personaReadOnly) {
        const refused = ownerRefusal(c, "answer a tool-permission prompt");
        if (refused) return refused;
      }
    }
    if (
      ask.gate === STANDUP_IMPROVEMENT_GATE &&
      isProposalApproval(answer ?? "", STANDUP_IMPROVEMENT_APPROVE)
    ) {
      const refused = ownerRefusal(c, "allow a Standup self-fix");
      if (refused) return refused;
    }

    // The record written to the ask row — the chosen labels for a modal answer,
    // otherwise the free text as sent.
    let answerText = answer ?? "";

    // An ask_human is a blocked MCP call: resolving the row is enough,
    // because the tool handler is long-polling for exactly this.
    //
    // A permission_prompt has no such waiter — it came from a Notification
    // hook, and the agent is sitting on a TUI dialog. Marking it answered
    // would clear the badge while leaving the agent just as stuck. For a
    // launched session we own the pane, so the answer can actually be typed
    // in; for a monitored one, only the human at that terminal can act.
    if (ask.kind === "permission_prompt") {
      // Persona's read-only allow once claims the prompt first, by marking it
      // answered only while it is still pending, so of two answers sent at
      // the same time exactly one goes on to the pane check and the
      // keystroke. Until the digit is typed, any way out of the route (a
      // refusal or an exception) settles the claim in the finally below: the
      // prompt goes back to pending so the owner can still answer it, or is
      // retired when its call is over.
      const claimedBy = personaReadOnly && tokenRuntime ? `persona:${tokenRuntime.owner}` : null;
      if (claimedBy && !claimPendingAsk(store.db, askId, answerText, claimedBy)) {
        return c.json({ error: "This permission prompt is already answered or gone; nothing was typed." }, 409);
      }
      let claimCarriedOut = false;
      try {
        // An ask tied to a call that has since finished, or that the safety
        // floor now holds, has no dialog behind it: typing the answer would land
        // in whatever the pane shows next. It is retired and nothing is typed.
        const stale = staleCallReason(store.db, ask);
        if (stale) {
          cancelAsk(store.db, ask.id);
          broadcast({ type: "ask:resolved", payload: { askId: ask.id, answer: "" }, timestamp: new Date().toISOString() });
          return c.json({ error: `${stale}, so this permission prompt is gone; nothing was typed.` }, 409);
        }
        // An override closes the dialog with Escape and types a message; with
        // other calls in flight the next queued dialog can take that message
        // and its Enter instead.
        const inFlight = override === true ? noticeTarget(store.db, ask.sessionId).candidates.length : 0;
        const unanswerable =
          override === true
            ? inFlight > 1
              ? `Other calls are in flight, so another dialog could open behind this one and take the message`
              : null
            : unanswerableReason(store.db, ask);
        if (unanswerable) return c.json({ error: `${unanswerable}. Nothing was typed.` }, 409);
        const launch = getLaunchBySession(store.db, ask.sessionId);
        if (!launch) {
          return c.json(
            {
              error:
                "This session wasn't launched by the console, so Standup can't answer for you — respond in its terminal.",
            },
            409
          );
        }

        if (override === true) {
          // Override the pending AskUserQuestion: rather than pick an option, the
          // human wants to redirect the agent. Dismiss the menu (Escape), wait for
          // the composer to settle, then type the text as a fresh instruction.
          const text = (answer ?? "").trim();
          if (!text) {
            return c.json({ error: "Enter a message to send the agent." }, 400);
          }
          await interruptLaunch(launch);
          // Best-effort settle so the typed text isn't dropped while the TUI is
          // still animating the menu closed; a false timeout still proceeds.
          await waitForClaudePromptReady(launch.tmuxSession ?? "");
          const sent = await sendToLaunch(launch, text);
          if (!sent.ok) {
            return c.json({ error: sent.error ?? "Could not reach the session" }, 409);
          }
          answerText = text;
        } else if (personaReadOnly) {
          // Persona's read-only allow once or deny: only the option's digit is
          // typed, and only while the pane shows this call's dialog, so no
          // allow can reach a dialog queued behind it.
          const { call, digit, want } = personaReadOnly;
          const sent = await answerPermissionDialog(launch, digit, (screen) => permissionDialogRefusal(screen, call, digit, want));
          // A typed deny is carried out even when a queued dialog with its own
          // "No" opened at once: the deny check can't tell that from this one
          // still open, and reopening the ask would let a later allow land on
          // the queued dialog.
          if (!sent.ok && !(want === "deny" && sent.typed)) {
            return c.json({ error: `${sent.error ?? "Could not reach the session"}. ${sent.typed ? "Its option key was sent." : "Nothing was typed."}` }, 409);
          }
          claimCarriedOut = true;
        } else if (selections && selections.length > 0) {
          // An AskUserQuestion modal answered from the transcript UI: map the
          // chosen option indices to the menu keystrokes the dialog understands.
          // Only when the ask is that question's: in any other dialog the keys
          // would pick a permission option.
          const questionCall = askQuestionCall(store.db, ask);
          if (!questionCall && pendingAskUserQuestion(store, ask.sessionId)) {
            return c.json(
              {
                error:
                  "Other calls are in flight, so Standup can't tell the open dialog is this question; answer it in the terminal, or once they finish.",
              },
              409
            );
          }
          const questions = (questionCall?.toolInput as AskUserQuestionInput | undefined)?.questions?.length
            ? (questionCall!.toolInput as AskUserQuestionInput).questions!
            : null;
          if (!questions) {
            return c.json(
              {
                error:
                  "The agent is no longer on that question — reload the session.",
              },
              409
            );
          }
          const groups = buildModalAnswerKeys(
            selections,
            questions.map((q) => !!q.multiSelect)
          );
          const sent = await sendModalAnswerToLaunch(launch, groups);
          if (!sent.ok) {
            return c.json({ error: sent.error ?? "Could not reach the session" }, 409);
          }
          answerText = questions
            .map((q, i) => {
              const labels = (selections[i] ?? []).map(
                (idx) => q.options?.[idx]?.label ?? `option ${idx + 1}`
              );
              return `${q.header ? `${q.header}: ` : ""}${labels.join(", ")}`;
            })
            .join("\n");
        } else {
          // A compound AskUserQuestion needs one reply per sub-question — see
          // describePendingTool, which tells the human to send one per line.
          // Each send needs a beat to land before the next one, or the TUI is
          // still animating onto the next question when the second answer
          // arrives and it's dropped.
          const parts = answerText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

          for (const [i, part] of parts.entries()) {
            const sent = await sendToLaunch(launch, part);
            if (!sent.ok) {
              return c.json({ error: sent.error ?? "Could not reach the session" }, 409);
            }
            if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 400));
          }
        }
      } finally {
        if (claimedBy) {
          releaseAskClaim(askId);
          if (!claimCarriedOut) settleUnusedClaim(askId, claimedBy);
        }
      }
    }

    // Who decided, for the audit: a Persona answering with its token is
    // recorded as that Persona; anyone else as the acting caller.
    resolveAsk(store.db, askId, answerText, tokenRuntime ? `persona:${tokenRuntime.owner}` : actingAlias(c, actor));
    updateSessionStatus(store.db, ask.sessionId, "running");
    // Best-effort collaboration record: answering an ask is a human contributing
    // to the session. Attribute it to the explicit `actor` (Slack),
    // else the acting tunnel user — mirroring /send and /steer.
    recordParticipant(store.db, ask.sessionId, actingAlias(c, actor));

    broadcast({
      type: "ask:resolved",
      payload: { askId, answer: answerText },
      timestamp: new Date().toISOString(),
    });
    broadcast({
      type: "session:status",
      payload: { sessionId: ask.sessionId, status: "running" },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  // Dismiss without answering — for when the question is stale, was
  // answered directly in the terminal, or just isn't worth a reply. An
  // ask_human has a real waiter (an MCP tool call long-polling this row),
  // and cancelAsk is the same terminal state waitForAskResolution already
  // treats as "done" for a stopped session, so the waiter unblocks cleanly
  // with an empty answer instead of hanging until its timeout.
  // Clear all — dismiss every pending ask at once, for when the human wants to
  // stop tracking the whole Blocked backlog rather than answer each. Broadcasts
  // one ask:resolved per row so every connected client drops them live, same as
  // a single dismiss. Registered before the :id route so "dismiss-all" is not
  // captured as an ask id.
  app.post("/api/asks/dismiss-all", async (c) => {
    // The client sends the caller's own responsible asks (the "Needs you" set)
    // so a clear-all ends only their queue, not a teammate's block. A missing
    // body falls back to clearing every pending ask (legacy/whole-backlog).
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const askIds = Array.isArray(body.askIds)
      ? (body.askIds as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
    const ids = dismissAllPendingAsks(store.db, askIds);
    for (const askId of ids) {
      broadcast({
        type: "ask:resolved",
        payload: { askId, answer: "" },
        timestamp: new Date().toISOString(),
      });
    }
    return c.json({ ok: true, dismissed: ids.length });
  });

  app.delete("/api/asks/:id", (c) => {
    const askId = c.req.param("id");
    const ask = getAsk(store.db, askId);
    if (!ask) return c.json({ error: "Not found" }, 404);

    cancelAsk(store.db, askId);

    broadcast({
      type: "ask:resolved",
      payload: { askId, answer: "" },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true });
  });

  // Checkpoints
  app.get("/api/checkpoints", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    const checkpoints = getRecentCheckpoints(store.db, limit);
    return c.json(checkpoints);
  });

  // Knowledge-graph changes — the durable feed leg the resync ledger re-reads.
  // A change to another user's personal doc is not listed (see
  // getRecentKnowledgeChanges for how a change is judged personal).
  app.get("/api/knowledge-changes", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    const viewer = scopingUser(c) ?? null;
    return c.json(getRecentKnowledgeChanges(store.db, limit, viewer));
  });

  // Steers
  app.post("/api/sessions/:id/steer", async (c) => {
    const { body } = await c.req.json<{ body: string }>();
    const sessionId = c.req.param("id");
    const steer = createSteer(store.db, sessionId, body);

    // Best-effort collaboration record: the acting tunnel user touched this
    // session by steering it.
    recordParticipant(
      store.db,
      sessionId,
      actingAlias(c)
    );

    // Queued, not delivered — it reaches the agent at its next turn
    // boundary (UserPromptSubmit) or next checkpoint call. The UI shows
    // "delivers at the next checkpoint" off the back of this.
    broadcast({
      type: "steer:queued",
      payload: steer,
      timestamp: new Date().toISOString(),
    });
    // A worker paused for idleness has no next turn until it is resumed.
    await wakeQueued(sessionId);

    return c.json(steer);
  });

  // A steer addressed to one user (a Human Review steer) is read in full only
  // by a request proving that user: the owner secret or their user channel
  // token, beside their own identity. Anyone else sees it with its body withheld.
  app.get("/api/sessions/:id/steers/pending", (c) => {
    const steers = getPendingSteers(store.db, c.req.param("id"));
    const alias = actingAlias(c);
    const proves = (audience: string) =>
      alias === audience &&
      (ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets) ||
        userChannelTokenMatches(ownerSecrets.ownerToken, audience, c.req.header(USER_CHANNEL_HEADER)));
    return c.json(steers.map((s) => (s.audience && !proves(s.audience) ? { ...s, body: "" } : s)));
  });

  // ============================================================================
  // Agent-to-agent coordination — a per-session mailbox plus a lightweight
  // shared task-list, mirroring Claude Code agent-teams cross-session messaging.
  // A message enqueued for a session is delivered on its NEXT TURN through the
  // same injection seam steers ride (takeMailboxContext, drained at the
  // UserPromptSubmit hook and the checkpoint call), attributed to the sender.
  // ============================================================================

  // Enqueue a message from one session for another. The sender is correlated
  // (best-effort) from the calling session so the message carries attribution;
  // an unknown target is reported gracefully rather than tripping the sessions
  // FK or 500-ing, so the tool can tell the agent to re-address.
  app.post("/api/messages", async (c) => {
    const { session_id, cwd, to_session, body } = await c.req.json<{
      session_id?: string;
      cwd?: string;
      to_session?: string;
      body?: string;
    }>();

    if (!to_session?.trim()) return c.json({ error: "to_session is required" }, 400);
    if (!body?.trim()) return c.json({ error: "body is required" }, 400);

    // A queued message is injected as an authoritatively-framed instruction into
    // the target's NEXT turn (see formatSessionMessages), so it clears the same
    // fail-closed write-token bar as the other prompt-injection-capable writes: on
    // a shared/multiplayer or network-exposed collector only a request carrying the
    // out-of-band token may enqueue one (see isTrustedCoordinationWrite).
    if (!isTrustedCoordinationWrite(c)) {
      return c.json(
        {
          error:
            "messaging another session on a shared/multiplayer or network-exposed collector requires " +
            "the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }

    // Derive the sender SERVER-SIDE from the trust-gated acting alias — never from
    // the client-supplied session_id, which is forgeable. A caller may only act as
    // a correlated session its OWN alias actually owns or created; a session_id it
    // merely names confers no project standing and no attribution.
    const actor = actingAlias(c);
    const claimed = resolveCallingSession(session_id, cwd ?? "");
    const sender = actorOwnsSession(actor, claimed) ? claimed : undefined;

    // An unknown target is reported as an outcome (200, ok:false) rather than a
    // thrown 404 — it never inserts, never trips the sessions FK, and hands the
    // tool a clean "re-address this" signal instead of a transport error.
    const target = getSession(store.db, to_session.trim());
    if (!target) {
      return c.json({
        ok: false,
        delivered: false,
        unknownTarget: true,
        error: `No session found with id "${to_session.trim()}"`,
      });
    }

    // A session messaging itself would just re-inject its own turn boundary.
    if (sender && sender.id === target.id) {
      return c.json({ error: "a session cannot message itself" }, 400);
    }

    // Scope the channel: a message must not cross a project or owner boundary, or
    // any process that can reach the collector could drive an unrelated user's
    // agent. Standing comes from the SERVER-DERIVED alias, not the claimed session:
    // the sender must own a session that shares the target's project, or the acting
    // alias must be the target's owner/creator. An uncorrelated caller (or one that
    // named a session it does not own) has no standing to inject anywhere.
    //
    // `scratch` is the catch-all bucket for every session that matched no
    // configured project, so two unrelated sessions — potentially different users
    // in tunnel/multiplayer mode — both land there. It is NOT a shared project:
    // treating it as one would let any scratch session drive any other, the exact
    // cross-user injection this guard exists to prevent. A scratch pair must clear
    // the owner check instead. (The one-trusted-team residual — a token holder
    // forging a peer's identity header off-tunnel — is the same deferred item
    // the profile write documents; closing it needs real per-user auth.)
    const sameProject =
      !!sender &&
      sender.projectId !== "scratch" &&
      sender.projectId === target.projectId;
    const targetActor = canonicalActor(target.ownerActor ?? target.createdActor);
    const sameOwner = !!targetActor && canonicalActor(actor) === targetActor;
    if (!sameProject && !sameOwner) {
      return c.json({
        ok: false,
        delivered: false,
        forbidden: true,
        error:
          "You can only message a session in your own project (or one you own) — nothing was queued.",
      });
    }

    const message = createSessionMessage(store.db, {
      toSessionId: target.id,
      fromSessionId: sender?.id,
      // Prefer the sender's human-readable title; fall back to its id.
      fromLabel: sender ? sender.title || sender.id : undefined,
      body: body.trim(),
    });

    // Queued, not delivered — it reaches the target agent at its next turn
    // boundary (UserPromptSubmit) or next checkpoint call, the same points
    // steers deliver on.
    broadcast({
      type: "session:message",
      payload: message,
      timestamp: new Date().toISOString(),
    });
    // A target paused for idleness has no next turn until it is resumed.
    await wakeQueued(target.id);

    return c.json({ ok: true, delivered: false, message });
  });

  // The recipient's pending mailbox, WITHOUT draining it — a peek for the UI or
  // an agent that wants to see what is queued before its next turn. A mailbox
  // holds coordination addressed TO a session (message bodies other agents wrote
  // for it), so it is scoped exactly like the shared board's reads: only a caller
  // with standing over the target session — its SERVER-DERIVED owner/creator, not
  // a session id anyone can name — may read it. This closes the cross-tenant read
  // leak where a teammate could GET a victim session's queued coordination.
  app.get("/api/sessions/:id/mailbox", (c) => {
    const target = getSession(store.db, c.req.param("id"));
    if (!actorOwnsSession(actingAlias(c), target)) {
      return c.json(
        { error: "You can only read the mailbox of a session you own." },
        403
      );
    }
    return c.json(getPendingMessages(store.db, c.req.param("id")));
  });

  // Drain the mailbox explicitly: claim every pending message and return them
  // with the formatted injection text. This is a state-mutating write that BOTH
  // reads the queued bodies AND marks them delivered (so the recipient's real
  // turn-boundary drain then finds nothing), so it clears the same fail-closed
  // write-token / isMultiplayerMode gate as enqueueing one AND is scoped to the
  // recipient: only a caller with standing over the target session may drain it.
  // Ungated, this let any caller both steal and destroy another tenant's queued
  // coordination. The turn-boundary seams (UserPromptSubmit hook, checkpoint)
  // drain implicitly as the recipient itself; this is the same claim exposed for
  // an out-of-band consumer acting AS that recipient.
  app.post("/api/sessions/:id/mailbox/drain", (c) => {
    if (!isTrustedCoordinationWrite(c)) {
      return c.json(
        {
          error:
            "draining a session's mailbox on a shared/multiplayer or network-exposed collector " +
            "requires the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }
    const target = getSession(store.db, c.req.param("id"));
    if (!actorOwnsSession(actingAlias(c), target)) {
      return c.json(
        { error: "You can only drain the mailbox of a session you own." },
        403
      );
    }
    const drained = takeMailboxContext(store.db, c.req.param("id"));
    if (!drained) return c.json({ messages: [], text: "" });
    for (const message of drained.messages) {
      broadcast({
        type: "session:message",
        payload: message,
        timestamp: new Date().toISOString(),
      });
    }
    return c.json({ messages: drained.messages, text: drained.text });
  });

  // Cancel a still-pending message (e.g. the sender changed course before the
  // target took its next turn). Cancelling destroys queued coordination, so it
  // clears the same fail-closed write-token gate as enqueueing one AND is scoped:
  // only a caller with standing over the message's sender OR recipient session
  // may cancel it — a bare message id anyone can name confers nothing. Idempotent
  // — cancelling an already-drained or unknown id is a no-op that leaks nothing.
  app.delete("/api/messages/:id", (c) => {
    if (!isTrustedCoordinationWrite(c)) {
      return c.json(
        {
          error:
            "cancelling a queued message on a shared/multiplayer or network-exposed collector " +
            "requires the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }
    const message = getSessionMessage(store.db, c.req.param("id"));
    // Unknown or already-consumed id: nothing to cancel and nothing to reveal.
    if (!message) return c.json({ ok: true });
    const actor = actingAlias(c);
    const sender = message.fromSessionId
      ? getSession(store.db, message.fromSessionId)
      : undefined;
    const recipient = getSession(store.db, message.toSessionId);
    if (!actorOwnsSession(actor, sender) && !actorOwnsSession(actor, recipient)) {
      return c.json(
        {
          error:
            "You can only cancel a message you sent or one addressed to a session you own.",
        },
        403
      );
    }
    cancelSessionMessage(store.db, c.req.param("id"));
    return c.json({ ok: true });
  });

  // The shared task-list board. GET lists it, scoped to the caller: a `?project=`
  // is honored ONLY when the acting alias has standing there, else it falls back
  // to the global (project-less) board — never another tenant's notes. POST
  // appends a note (behind the same write-token gate) and returns the caller's
  // scoped board so a posting agent sees the shared list in one round-trip; PATCH
  // flips a note done. Every read and write is scoped to the caller's project/
  // owner rather than dumping every project's board.
  app.get("/api/coordination/notes", (c) => {
    const openOnly = c.req.query("open") === "1";
    // A client-supplied project scope is honored only for a project the caller
    // belongs to; anything else reads the global board (getSharedNotes returns
    // the project's notes plus global for a scoped read, global-only otherwise).
    const requested = c.req.query("project")?.trim();
    const projectId =
      requested && actorHasProjectStanding(actingAlias(c), requested)
        ? requested
        : undefined;
    return c.json(getSharedNotes(store.db, { projectId, openOnly }));
  });

  app.post("/api/coordination/notes", async (c) => {
    const { session_id, cwd, project, body } = await c.req.json<{
      session_id?: string;
      cwd?: string;
      project?: string;
      body?: string;
    }>();
    if (!body?.trim()) return c.json({ error: "body is required" }, 400);

    // A shared-board note is agent-authored content other agents read and act on,
    // so it clears the same fail-closed write-token gate as the peer-message write.
    if (!isTrustedCoordinationWrite(c)) {
      return c.json(
        {
          error:
            "posting to the shared task-list on a shared/multiplayer or network-exposed collector " +
            "requires the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }

    const actor = actingAlias(c);
    // Only a correlated session the acting alias actually owns/created stands in
    // for the poster; a forged session_id attributes and scopes nothing.
    const claimed = resolveCallingSession(session_id, cwd ?? "");
    const poster = actorOwnsSession(actor, claimed) ? claimed : undefined;

    // An explicit `project` is honored ONLY when the caller has standing in it;
    // otherwise it is a cross-tenant post and refused. With no explicit project the
    // note lands on the poster's own project (or the global board for a scratch/
    // uncorrelated poster) — never an arbitrary project the client named.
    const requested = project?.trim();
    if (requested && requested !== "scratch" && !actorHasProjectStanding(actor, requested)) {
      return c.json(
        {
          error:
            "You can only post to a project you have a session in — nothing was posted.",
          forbidden: true,
        },
        403
      );
    }
    const projectId =
      requested && requested !== "scratch"
        ? requested
        : poster && poster.projectId !== "scratch"
          ? poster.projectId
          : undefined;

    const note = postSharedNote(store.db, {
      projectId,
      fromSessionId: poster?.id,
      fromLabel: poster ? poster.title || poster.id : undefined,
      body: body.trim(),
    });

    broadcast({
      type: "note:updated",
      payload: note,
      timestamp: new Date().toISOString(),
    });

    return c.json({ note, notes: getSharedNotes(store.db, { projectId: note.projectId }) });
  });

  app.patch("/api/coordination/notes/:id", async (c) => {
    // Flipping a note done mutates the shared board, so it clears the same
    // write-token gate as posting one.
    if (!isTrustedCoordinationWrite(c)) {
      return c.json(
        {
          error:
            "updating the shared task-list on a shared/multiplayer or network-exposed collector " +
            "requires the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }
    const existing = getSharedNote(store.db, c.req.param("id"));
    if (!existing) return c.json({ error: "Not found" }, 404);
    // A project-scoped note may only be flipped by a caller with standing in that
    // project; a global (project-less) note is shared, so any gated caller may.
    if (existing.projectId && !actorHasProjectStanding(actingAlias(c), existing.projectId)) {
      return c.json(
        { error: "You can only update a note in a project you have a session in." },
        403
      );
    }
    const { done } = await c.req
      .json<{ done?: boolean }>()
      .catch(() => ({ done: undefined }));
    const note = setSharedNoteDone(store.db, c.req.param("id"), done === true);
    if (!note) return c.json({ error: "Not found" }, 404);
    broadcast({
      type: "note:updated",
      payload: note,
      timestamp: new Date().toISOString(),
    });
    return c.json(note);
  });

  // The ephemeral, pull-first cross-agent activity view (active, paused, or seen
  // in the last 24h): what OTHER agents are working on in the caller's project
  // right now. Read-only, so it
  // does NOT apply the coordination write-token gate. This composes with — and
  // never touches — the shared_notes board ("what SHOULD be done") and the durable
  // knowledge path; it is a recency filter over existing sessions/events only.
  //
  // Scoped to the caller's project: a client-supplied `project` is honored ONLY
  // when the acting alias has standing there (actorHasProjectStanding), else the
  // caller's correlated session's project is used. The caller's OWN work is
  // excluded — an agent's by its own session id, a session-less caller's by
  // actor (through the merge tombstones).
  //
  // The acting alias is a launched worker's trusted launch owner when it
  // presents its worker token, else normally the tunnel-authenticated caller
  // (MCP whats_happening) or the host `$USER`. The off-tunnel co-located Slack adapter
  // has NO tunnel header of its own, so left alone it would resolve to the host
  // operator and scope the snapshot to the operator's standing — leaking every
  // project's sessions to any Slack member. It can instead PRESENT the identity it
  // resolved for the human who invoked the command via a supplied `actor`, so the
  // snapshot scopes to THAT teammate's standing.
  //
  // That override is honored ONLY for the adapter's shape of request: a LOOPBACK
  // source carrying NO identity header. A tunnel request always
  // arrives with the gateway-stamped header (the tunnel strips client copies and
  // stamps the authenticated user), so it keeps scoping to that header identity —
  // a tunnel client can NOT read another user's work by naming them in the body.
  // A non-loopback source is never trusted to self-identify. MCP whats_happening
  // supplies no `actor` and rides the tunnel, so it is unaffected.
  function respondActiveWork(
    c: Context,
    input: { session_id?: string; cwd?: string; project?: string; actor?: string }
  ) {
    const header = c.req.header(config.userIdentifier.header)?.trim();
    const override =
      !header && isLoopbackAddress(requestRemoteAddress(c))
        ? input.actor?.trim() || undefined
        : undefined;
    // A launched worker presents its worker token (WORKER_TOKEN_HEADER), which
    // names its launch unforgeably: its session is the launch's, and it reads
    // as the launch's trusted owner (reviewOwnerForLaunch — never the
    // caller-named `requester`), who need not be the host user its local MCP
    // call otherwise resolves to.
    const worker = launchForWorkerToken(store.db, c.req.header(WORKER_TOKEN_HEADER));
    const workerSession = worker?.sessionId ? getSession(store.db, worker.sessionId) ?? undefined : undefined;
    const workerOwner = worker ? reviewOwnerForLaunch(store.db, worker) ?? undefined : undefined;
    const actor = workerOwner ?? actingAlias(c, override);
    // Job titles are the job owner's private data, so they follow only a proof
    // a co-located process can't forge: the worker token's trusted owner, a
    // Persona runtime's owner, or the owner token. A header-less loopback call
    // (the Slack adapter, any process skipping its token) reads as the host
    // without proof, and a body `actor` or bare identity header is forgeable,
    // so none of those sees a title.
    const jobViewer = worker
      ? workerOwner
      : personaRuntimeOf(c)?.owner ??
        (ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets) ? scopingUser(c) : undefined);
    // The client-supplied session_id/cwd is forgeable — a caller can name any
    // session (learned from a /s/<id> share link or an "Open in Standup" line)
    // or pass any repo cwd — so it confers NO project scope on its own. Only a
    // resolved session the acting alias actually owns/created grants standing,
    // mirroring message_session's `sender = actorOwnsSession(...) ? claimed :
    // undefined`. Without this a named-but-unowned session would let a caller
    // read the active work of a project it has no standing in.
    const claimed = workerSession ?? resolveCallingSession(input.session_id, input.cwd ?? "");
    const session = workerSession ?? (actorOwnsSession(actor, claimed) ? claimed : undefined);
    const requested = input.project?.trim();
    const projectId =
      requested && actorHasProjectStanding(actor, requested)
        ? requested
        : session?.projectId;
    // `unresolved` tells "no project to look in" apart from "nothing is active".
    if (!projectId) return c.json({ work: [], unresolved: true });
    if (projectId === "scratch") return c.json({ work: [] });

    // A caller with a session of its own excludes only that session's root (the
    // list holds roots only, so a subagent caller excludes its parent): the
    // owner's other sessions are its sibling workers (every worker Persona
    // launches is owned by the owner it acts for), which is exactly what it asks
    // to see. A caller with no session — a human over the tunnel, or Slack's
    // unbound view — excludes its own work by actor. A row carries its Persona
    // job only for the job's owner.
    const work = session
      ? getActiveWork(store.db, projectId, { excludeSessionId: session.parentSessionId ?? session.id, jobViewer })
      : getActiveWork(store.db, projectId, { excludeActor: actor, jobViewer });
    return c.json({ work });
  }

  app.get("/api/active-work", (c) =>
    respondActiveWork(c, {
      session_id: c.req.query("session_id"),
      cwd: c.req.query("cwd"),
      project: c.req.query("project"),
      actor: c.req.query("actor"),
    })
  );

  app.post("/api/active-work", async (c) => {
    const body = await c.req
      .json<{ session_id?: string; cwd?: string; project?: string; actor?: string }>()
      .catch(() => ({}) as { session_id?: string; cwd?: string; project?: string; actor?: string });
    return respondActiveWork(c, body);
  });

  // Claims (or reassigns) a session's owner. The owner is `actor`
  // from the body when given, else the acting tunnel user — so a bare POST
  // means "I'll take this one." Touches only `owner_actor`; the session's
  // origin (`created_actor`) is left exactly as it was. Returns the updated
  // session and nudges clients to refetch.
  app.post("/api/sessions/:id/assign-owner", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(store.db, sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);

    const body = await c.req
      .json<{ actor?: string }>()
      .catch(() => ({}) as { actor?: string });
    const actor = actingAlias(c, body.actor);
    upsertActor(store.db, actor);
    assignSessionOwner(store.db, sessionId, actor);

    broadcast({
      type: "session:status",
      payload: { sessionId, status: session.status },
      timestamp: new Date().toISOString(),
    });

    return c.json(getSession(store.db, sessionId));
  });

  // Reconciles two actor rows that are the same human: folds the
  // path-param actor into `into`, so every created/owner/participant edge that
  // resolves through getActor now reads as `into` and the folded id drops out
  // of getActors — one person, one collaborator. The Slack adapter is the real
  // caller: it maps a Slack user's email to their user alias and folds the
  // `slack:U…` actor the ask path mints into the alias actor the tunnel mints,
  // so a teammate who answers in Slack and also drives sessions over the tunnel
  // isn't double-counted. Idempotent — a repeat or self-merge is a no-op (see
  // mergeActors).
  app.post("/api/actors/:id/merge", async (c) => {
    const fromId = c.req.param("id");
    const { into } = await c.req
      .json<{ into?: string }>()
      .catch(() => ({}) as { into?: string });
    if (!into?.trim()) return c.json({ error: "into is required" }, 400);
    return c.json(mergeActors(store.db, fromId, into.trim()));
  });

  // ============================================================================
  // Launching
  // ============================================================================

  // The list leaves out each launch's build log; GET /api/launches/:id has it.
  app.get("/api/launches", (c) => c.json(getLaunchList(store.db)));

  // The dispatcher lifecycle ledger — the state a coworker cares
  // about (queued/running/succeeded/failed/lost) with the liveness clock the
  // dispatchable board reads. Distinct from /api/launches (the tmux/worktree
  // provisioning record); the two share worktreePath.
  app.get("/api/task-runs", (c) => c.json(getTaskRuns(store.db)));

  // Shared by the project-scoped and project-less launch routes below. An
  // empty/omitted project id means "no project chosen" — default to the
  // `scratch` project. launchSession then runs launch-time project inference
  // for a scratch launch: on a confident single match it launches AS that
  // project (provisioning its workspace), else it stays in scratch as the
  // stable home for unmatched work. An explicitly-named project still launches
  // straight into it, uninferred.
  async function runLaunch(
    c: Context,
    rawProjectId: string | undefined
  ): Promise<Response> {
    const { task, label, model, effort, codexModel, codexEffort, inPlace, planGate, bypassPermissions, orchestrationProfile, harness, idempotencyKey, persona: personaLaunch, actor: actorOverride, pipeline, pipelineSpec, pipelineOverride, jobId: pipelineJobId, ownerApproved, approvedWeakens } = await c.req.json<{
      task: string;
      label?: string;
      model?: string;
      effort?: string;
      codexModel?: string;
      codexEffort?: string;
      inPlace?: boolean;
      planGate?: boolean;
      bypassPermissions?: boolean;
      orchestrationProfile?: string;
      harness?: string;
      idempotencyKey?: string;
      persona?: boolean;
      actor?: string;
      pipeline?: unknown;
      pipelineSpec?: unknown;
      pipelineOverride?: unknown;
      jobId?: unknown;
      ownerApproved?: unknown;
      approvedWeakens?: unknown;
    }>();

    const projectId = rawProjectId?.trim() || "scratch";
    // A guest's Persona launches only into a project the host allowlisted for
    // it (its tools check first; this is the collector's own check). Checked
    // before the idempotency dedupe, so a key can't resolve to a launch the
    // guest's Persona may not reach.
    const launchingPersona = personaRuntimeOf(c);
    if (launchingPersona && !launchingPersona.isHost) {
      const access = getPersonaUserAccess(store.db, launchingPersona.owner);
      if (!rawProjectId?.trim() || !access?.enabled || !access.launchProjects.includes(projectId)) {
        return c.json(
          { error: `${launchingPersona.owner}'s Persona may not launch into project ${projectId}: ask ${ownerAlias} to allow it` },
          403
        );
      }
    }

    // Idempotent launch: a redelivered "launch …" command (a missed Slack ack,
    // or a delivery that outlived the adapter's in-memory dedup across a restart)
    // must not mint a second worktree + tmux session. A key that already produced
    // a launch resolves to that same row instead of spawning again — the guard
    // the steer/send path has, for the far costlier launch. The UNIQUE index on
    // launches.idempotency_key is the hard backstop: launchSession inserts the
    // launch row (createLaunch) BEFORE it kicks off the detached worktree/tmux
    // provisioning, so a second concurrent request that raced past this check
    // loses the insert to the UNIQUE index and never spawns — the catch below
    // resolves it to the winning launch instead of surfacing a 500.
    //
    // A key resolves only to a launch the same user launched (launchedBy); a
    // key that produced someone else's launch is refused, never handed back.
    const launcher = scopingUser(c)?.trim() || undefined;
    const dedupedLaunch = (existing: Launch) =>
      (existing.launchedBy ?? undefined) === launcher
        ? c.json({ launch: existing, deduped: true })
        : c.json({ error: "This idempotency key was used by another user's launch" }, 409);
    if (idempotencyKey) {
      const existing = getLaunchByIdempotencyKey(store.db, idempotencyKey);
      if (existing) return dedupedLaunch(existing);
    }

    if (!task?.trim()) {
      return c.json({ error: "task is required" }, 400);
    }
    if (label !== undefined && typeof label !== "string") {
      return c.json({ error: "label must be a string" }, 400);
    }
    if (model && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${model}` }, 400);
    }
    if (effort && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort level: ${effort}` }, 400);
    }
    // Validate any PRESENT harness, including the empty string. `harness && …`
    // would treat "" as absent and let it through, where the downstream
    // `?? project.harness ?? "claude"` (nullish-coalescing does not fire on "")
    // keeps "" and every `harness !== "claude"` branch takes the non-Claude path
    // — stripping steering AND skipping the folder-trust pre-accept — while
    // buildSpawnArgv still falls through to spawn a real `claude` into an
    // untrusted cwd that then hangs. Reject the empty/invalid value here instead.
    if (harness !== undefined && !HARNESS_IDS.includes(harness as HarnessId)) {
      return c.json({ error: `Unknown harness: ${harness}` }, 400);
    }
    // An in-place launch puts the worker in the real repository rather than a
    // worktree of its own — its safety floor's own ground then IS the shared
    // checkout — so asking for one per launch is the owner's call, like setting
    // a project's inPlace.
    if (inPlace === true) {
      const refusal = ownerRefusal(c, "launch a session in place");
      if (refusal) return refusal;
    }
    // Codex's model is free-form (its ids version with the CLI), so it is NOT
    // validated against an allowlist — only that a present value is a non-empty
    // string. A whitespace-only value is rejected with a 400 (as Claude's own
    // `model` rejects an unknown/blank alias); omit the field entirely to fall
    // back to the Codex CLI's own default.
    if (codexModel !== undefined && (typeof codexModel !== "string" || !codexModel.trim())) {
      return c.json({ error: "codexModel must be a non-empty string" }, 400);
    }
    // Codex reasoning effort IS a closed set — reject an unknown level rather than
    // forwarding a bogus `-c model_reasoning_effort=` the CLI would choke on.
    if (codexEffort !== undefined && !CODEX_EFFORTS.includes(codexEffort as CodexEffort)) {
      return c.json({ error: `Unknown Codex effort level: ${codexEffort}` }, 400);
    }
    // A per-launch orchestration-profile override is a profile NAME; reject a
    // non-string so a malformed body can't ride through to resolution. Absent
    // falls back to the project -> personal -> global default inside
    // launchSession (resolveActiveProfile).
    if (orchestrationProfile !== undefined && typeof orchestrationProfile !== "string") {
      return c.json({ error: "orchestrationProfile must be a string" }, 400);
    }
    // The permission posture override must be a real boolean: a truthy string
    // like "false" must not silently turn bypass on.
    if (bypassPermissions !== undefined && typeof bypassPermissions !== "boolean") {
      return c.json({ error: "bypassPermissions must be a boolean" }, 400);
    }
    const pipelineMode = parseLaunchPipelineMode(pipeline);
    if (pipelineMode === null) {
      return c.json({ error: 'pipeline must be "auto", "off", "default" or a boolean' }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }
    // Reserved system projects (e.g. the GLOBAL knowledge corpus) are not
    // launchable — the UI already hides them from the picker; enforce the same
    // invariant server-side so a hand-crafted request can't start a session
    // against an empty reserved corpus.
    if (project.reserved) {
      return c.json({ error: `Project is not launchable: ${projectId}` }, 403);
    }
    if (pipelineJobId !== undefined && pipelineJobId !== null && typeof pipelineJobId !== "string") {
      return c.json({ error: "jobId must be a string" }, 400);
    }
    // A `scratch` launch whose project is inferred is checked against the
    // project the inference lands on (checkProject), scratch itself when it
    // finds none; any other launch against the project named here.
    const infersProject = project.id === "scratch" && !(launchingPersona && !launchingPersona.isHost);
    // The launch's own pipeline layer: a plain-words spec and/or a structured
    // override, which must merge with the requester's layers beneath it on
    // the project it goes to, and whose "for <project>:" must name that project.
    let launchLayer: PipelineOverride | undefined;
    let layerRefusal: (target: Project) => LaunchRefusedError | null = () => null;
    const hasLayer =
      (pipelineSpec !== undefined && pipelineSpec !== null) || (pipelineOverride !== undefined && pipelineOverride !== null);
    if (hasLayer) {
      const layer = pipelineLayerFromInput({ spec: pipelineSpec, override: pipelineOverride });
      if (!layer.ok) return c.json({ error: layer.error, ...(layer.unknown ? { unknown: layer.unknown } : {}) }, 400);
      const owner = actingAlias(c, actorOverride);
      const job = typeof pipelineJobId === "string" ? getPersonaJob(store.db, pipelineJobId, { withView: false }) : null;
      layerRefusal = (target) => {
        const checked = checkPipelineLayers(store.db, target.id, [
          ...ownerProjectLayers(store.db, owner, target.id),
          job && job.owner === owner ? (job.pipelineOverride ?? null) : null,
          layer.override,
        ]);
        if (!checked.ok) return new LaunchRefusedError(checked.error, { errors: checked.errors }, 400);
        const wrongProject = specProjectRefusal(layer.compiled, target);
        return wrongProject ? new LaunchRefusedError(wrongProject, {}, 400) : null;
      };
      const layerRefusedHere = infersProject ? null : layerRefusal(project);
      if (layerRefusedHere) return c.json(layerRefusedHere.body, layerRefusedHere.status);
      launchLayer = layer.override;
    }
    // Persona's launch may not weaken the pipeline of the project it goes to
    // through the job's layer or its own (launchLayerWeakens) unless the owner
    // approved this launch on its card — which only Persona's own in-process
    // call can say — and every weakening is one the card showed
    // (`approvedWeakens`). Checked against the project the launch goes to, as
    // the layer is (infersProject).
    const approvedByCard = ownerApproved === true && !!launchingPersona && personaRuntimeCallOf(c) === launchingPersona;
    const cardWeakens = Array.isArray(approvedWeakens) ? approvedWeakens.filter((w): w is string => typeof w === "string") : [];
    const pipelineRefusal = (target: Project): LaunchRefusedError | null => {
      if (!launchingPersona) return null;
      const weakens = launchLayerWeakens(store.db, launchingPersona.owner, {
        projectId: target.id,
        jobId: typeof pipelineJobId === "string" ? pipelineJobId.trim() || null : null,
        launchLayer: launchLayer ?? null,
      });
      if (weakens.length === 0) return null;
      if (!approvedByCard) {
        return new LaunchRefusedError(`This launch weakens ${target.id}'s pipeline (${weakens.join("; ")}) — only the owner's approval launches it`, { weakens });
      }
      const unapproved = unapprovedWeakens(weakens, cardWeakens);
      return unapproved.length > 0 ? new LaunchRefusedError(staleApprovalError(unapproved), { weakens }) : null;
    };
    const refusedHere = infersProject ? null : pipelineRefusal(project);
    if (refusedHere) return c.json(refusedHere.body, refusedHere.status);

    try {
      // onUpdate broadcasts the launch on creation (status "starting") and
      // again when the background work lands (running/failed) — so the feed
      // shows it immediately and this request returns without waiting on a
      // minutes-long provision.
      const result = await launchFn(
        store.db,
        {
          project,
          task: task.trim(),
          // A short display name for the worktree slug, branch and feed row;
          // the agent still receives the full task.
          label: label?.trim() || undefined,
          model: model as ClaudeModel | undefined,
          effort: effort as ClaudeEffort | undefined,
          // Codex's own model + reasoning effort, threaded through to the codex
          // spawn. Consulted only when the resolved harness is codex; a trimmed
          // free-string model, an already-validated effort. Unset → the Codex CLI
          // default (mirrors an omitted Claude --model/--effort).
          codexModel: (codexModel as CodexModel | undefined)?.trim() || undefined,
          codexEffort: codexEffort as CodexEffort | undefined,
          // Undefined falls back to the project's own default inside
          // launchSession — an explicit toggle in the composer wins.
          inPlace,
          // Persona's own launch: its floor only tightens (an in-place worker's hooks are read strictly).
          persona: personaLaunch === true,
          // A guest's Persona launches only into the project it named and was
          // allowed: a scratch launch is never re-targeted by inference.
          ...(launchingPersona && !launchingPersona.isHost ? { allowProjectInference: false } : {}),
          // The project a scratch launch lands on is held to the same pipeline checks.
          checkProject: (target: Project) => {
            // An inferred project's harness is known only here.
            const harnessRefused = launchingPersona ? personaHarnessRefusal(target, harness as HarnessId | undefined) : null;
            if (harnessRefused) throw harnessRefused;
            if (!infersProject && target.id === project.id) return;
            const refused = layerRefusal(target) ?? pipelineRefusal(target);
            if (refused) throw refused;
          },
          // Per-launch plan-gate override; undefined falls back to the project's
          // planGate default inside launchSession (resolvePlanGate).
          planGate,
          // Per-launch permission posture override; undefined falls back to the
          // project's bypassPermissions default, then to bypass
          // (resolveBypassPermissions).
          bypassPermissions,
          // Per-launch orchestration-profile override (a profile NAME); undefined
          // falls back to the project -> personal -> global default, resolved
          // inside launchSession (resolveActiveProfile) — the same place the plan
          // gate resolves. The resolved profile's steps are injected as steering
          // (buildOpeningPrompt).
          orchestrationProfile,
          // off runs this launch without a delivery pipeline (research, lookups,
          // docs); default runs it even on a provisioned workspace; omitted
          // lets the launch's kind decide (startLaunchPipeline).
          pipeline: pipelineMode,
          // The launch's own pipeline layer and the Persona job it is for,
          // whose layers its run resolves over the requester's.
          ...(launchLayer ? { pipelineOverride: launchLayer } : {}),
          ...(typeof pipelineJobId === "string" && pipelineJobId.trim() ? { pipelineJobId: pipelineJobId.trim() } : {}),
          // Per-launch harness choice from the composer; undefined falls back to
          // the project's own harness default, then to claude (the default
          // harness) — so omitting it is unchanged, and codex routes this one
          // launch through the Codex adapter.
          harness: harness as HarnessId | undefined,
          // The launching user: an explicit body `actor` (a Slack teammate
          // launching off-tunnel, where there's no identity header)
          // wins; otherwise the tunnel-injected alias, else the host user
          // ($USER) locally. Recorded on the ledger row AND used to inject that
          // user's profile into the opening prompt (see buildOpeningPrompt).
          requester: actingAlias(c, actorOverride),
          // Who launched it, as this server resolved it: never the body
          // `actor`. A Persona's launch is its owner's (scopingUser resolves a
          // Persona's request to its owner). Whose Review queue the launch's
          // packets land in follows this, not `requester`.
          launchedBy: scopingUser(c),
          // The scope-routing identity for injected knowledge is resolved
          // SERVER-SIDE and deliberately does NOT pass the body `actor` override:
          // the injected set follows the authenticated tunnel identity, not a
          // client-supplied `actor` field. Anonymous → undefined (global ∪ project
          // only). This is a SOFT team routing boundary, not a hard wall — the
          // tunnel-authenticated header is the real caller, so an agent gets its
          // own user's docs — see scopingUser's note.
          retrievalUser: scopingUser(c),
          // Stamp the dedup key so a later redelivery of this same command
          // resolves to this launch (getLaunchByIdempotencyKey) rather than
          // spawning a second worktree/session.
          idempotencyKey,
        },
        broadcastLaunch,
        // The active embedding provider/config, so the launcher can retrieve and
        // inject product/spec knowledge for the task (roadmap r8).
        { embeddingProvider, embeddingConfig }
      );

      // A launch the host had no room for is queued, not refused: still a 200,
      // with why it waits and how many launches are ahead of it.
      return c.json({ launch: result.launch, ...(result.queued ? { queued: result.queued } : {}) });
    } catch (err) {
      if (err instanceof LaunchRefusedError) return c.json(err.body, err.status);
      // A redelivery that raced past the pre-check (two identical requests with
      // the same key hitting createLaunch at once) loses the UNIQUE-index insert
      // rather than double-spawning: createLaunch throws before any worktree/tmux
      // is provisioned, so resolve to the launch the winner created — the same
      // deduped result the pre-check returns — instead of a 500.
      if (idempotencyKey) {
        const existing = getLaunchByIdempotencyKey(store.db, idempotencyKey);
        if (existing) return dedupedLaunch(existing);
      }
      // Otherwise thrown only for misconfiguration caught before a launch row
      // exists (no repos, missing path); in-flight failures resolve to a
      // "failed" launch row broadcast via onUpdate instead.
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  app.post("/api/projects/:id/launch", (c) => runLaunch(c, c.req.param("id")));

  // Project-less launch: the composer can start work without picking a
  // project. Routes to `scratch`; Haiku then infers the real project.
  app.post("/api/launch", (c) => runLaunch(c, undefined));

  // Starts a knowledge-bootstrap run (phase-7 Step 3). Deliberately its own
  // route rather than a `kind` flag on POST /launch — it needs a different
  // model/effort default and, per the design, must never be reachable by
  // anything automatic (no hook, no auto-run on project creation). It reuses
  // launchSession wholesale: a bootstrap run gets a real worktree so its
  // git HEAD is stable for the duration of the run, which is what makes
  // generated_from_sha (stamped by /api/knowledge/propose) mean something.
  //
  // The task string is a Step 4 placeholder — see bootstrap-prompt.ts.
  app.post("/api/projects/:id/bootstrap-knowledge", async (c) => {
    const projectId = c.req.param("id");
    const { model, effort } = await c.req.json<{ model?: string; effort?: string }>().catch(
      () => ({ model: undefined, effort: undefined })
    );

    if (model && !CLAUDE_MODELS.includes(model as ClaudeModel)) {
      return c.json({ error: `Unknown model: ${model}` }, 400);
    }
    if (effort && !CLAUDE_EFFORTS.includes(effort as ClaudeEffort)) {
      return c.json({ error: `Unknown effort level: ${effort}` }, 400);
    }

    const project = getProjects(store.db).find((p) => p.id === projectId);
    if (!project) {
      return c.json({ error: `Unknown project: ${projectId}` }, 404);
    }

    try {
      // Opus at high effort by default — deciding what NOT to write is the
      // whole task (phase-7.md Step 3), so this is judgment work, not the
      // kind of thing the CLI's own default model should be trusted with.
      // The caller can still override, same as a normal launch.
      const result = await launchSession(
        store.db,
        {
          project,
          task: bootstrapPrompt(project),
          // Without this the branch would be named after the prompt's first
          // forty characters and the feed would show the whole page of it.
          label: `Bootstrap knowledge for ${project.name}`,
          model: (model as ClaudeModel | undefined) ?? "opus",
          effort: (effort as ClaudeEffort | undefined) ?? "high",
          kind: "bootstrap",
          // The user who kicked off the bootstrap — same alias resolution as the
          // other human-triggered launches — so it is attributed to them (not the
          // collector host) and carries their personalization.
          requester: actingAlias(c),
          // The server-resolved identity that scopes injected knowledge —
          // distinct from `requester` and never taken from the request body.
          retrievalUser: scopingUser(c),
          launchedBy: scopingUser(c),
        },
        broadcastLaunch
      );

      return c.json({ launch: result.launch });
    } catch (err) {
      // Same shape as POST /launch: thrown only for misconfiguration caught
      // before a launch row exists (no repos, missing path).
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // The launch row incl. its accumulated provision/build `log` — lets a
  // console that opens a provisioning launch show the output so far, then keep
  // up via the streamed launch:log events.
  app.get("/api/launches/:id", (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);
    return c.json(launch);
  });

  app.post("/api/launches/:id/cleanup", async (c) => {
    const launch = getLaunch(store.db, c.req.param("id"));
    if (!launch) return c.json({ error: "Not found" }, 404);

    const project = getProjects(store.db).find((p) => p.id === launch.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 400);

    // The branch build a review tunnel serves runs from the worktree: stop it before the worktree goes.
    reviewTunnels.closeForLaunch(launch.id, "launch_ended");
    const result = await cleanupLaunch(store.db, launch, project);

    broadcast({
      type: "launch:cleaned",
      payload: { launchId: launch.id },
      timestamp: new Date().toISOString(),
    });

    return c.json(result);
  });

  // ============================================================================
  // Tickets (review kanban)
  //
  // Lifecycle: proposed -> approved -> developing -> needs_review -> shipped,
  // plus a terminal dismissed (reachable from any active state). Review agents
  // file `proposed` tickets (propose_ticket); a human approves, which fires an
  // implementation launch; that launch's session attaching auto-advances the
  // ticket to developing (in the /hook SessionStart path); the implementation
  // agent self-reports via mark_ready_for_review (-> needs_review + review gate);
  // a human ships. updateTicketStatus is the single guarded transition point, so
  // every caller below maps TicketTransitionError -> HTTP 409.
  // ============================================================================

  app.get("/api/tickets", (c) => c.json(getTickets(store.db)));
  app.get("/api/projects/:id/tickets", (c) =>
    c.json(getTicketsByProject(store.db, c.req.param("id")))
  );

  // The review gate run on developing -> needs_review, keyed on the project's
  // reviewProcess. Fire-and-forget from the /ready route — the implementation
  // agent (blocked inside the MCP call) must not wait on a code review being cut, and
  // reviewUrl is orthogonal to status, so it can land while the ticket already
  // sits in needs_review. Every branch broadcasts the ticket after mutating it.
  async function runReviewGate(ticket: Ticket, project: Project): Promise<void> {
    const rebroadcast = () => {
      const fresh = getTicket(store.db, ticket.id);
      if (fresh) broadcastTicket(fresh);
    };

    if (project.reviewProcess === "command") {
      const cmd = project.reviewCommand?.trim();
      if (!cmd) return;
      if (!ticket.launchId) return;
      const launch = getLaunch(store.db, ticket.launchId);
      if (!launch) return;
      const cwd = project.launchSubdir
        ? join(launch.worktreePath, project.launchSubdir)
        : launch.worktreePath;

      // Raw shell in the ticket's worktree — same trust level as project.setup /
      // provision (the user's own machine). Run in its own process group, which
      // the timeout or a drain kills whole. The ticket already sits in
      // needs_review, so nothing re-runs a gate the drain cut on the next
      // leader; the card says so.
      const interrupted = () => {
        setTicketError(
          store.db,
          ticket.id,
          "The review command was interrupted by a Standup restart before it finished, so no review URL was recorded. " +
            "Run it by hand, or move the ticket back to developing and mark it ready again."
        );
        rebroadcast();
      };
      if (drain.draining) return interrupted();
      const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: workerEnv(),
        detached: true,
      });
      const timer = setTimeout(() => killProcessGroup(proc.pid), REVIEW_GATE_TIMEOUT_MS);
      const stopListening = killGroupOnRelease(proc.pid, drain.signal);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).finally(() => {
        clearTimeout(timer);
        stopListening();
      });

      // A command that finished cleanly as the drain began keeps its result.
      if (drain.draining && proc.exitCode !== 0) return interrupted();

      if (proc.exitCode === 0) {
        const url = stdout.match(/(https?:\/\/\S+)/)?.[1];
        if (url) {
          setReviewUrl(store.db, ticket.id, url);
          pipelineReviewUrl(ticket, url, true);
          // The tracker sync's return leg for a command-mode project: the
          // review command just produced the review URL, so the task gets its
          // status — pushed by the collector, or by the still-live session
          // for an agent-driven tracker. A no-op for a non-tracker ticket.
          trackerWritebackFromCollector(ticket, url);
          const directive = trackerWritebackFor(tracker, ticket, url);
          if (directive && launch.tmuxSession) {
            await sendToLaunch(launch, directive.trim());
          }
        } else {
          setTicketError(
            store.db,
            ticket.id,
            `review command exited 0 but produced no URL:\n${stdout.trim().slice(-500)}`
          );
          pipelineReviewGateFailed(store.db, ticket.launchId, { broadcast });
        }
      } else {
        const tail = (stderr.trim() || stdout.trim()).slice(-500);
        setTicketError(
          store.db,
          ticket.id,
          tail || `review command exited ${proc.exitCode}`
        );
        pipelineReviewGateFailed(store.db, ticket.launchId, { broadcast });
      }
      rebroadcast();
      return;
    }

    if (project.reviewProcess === "review-agent") {
      if (!ticket.launchId) return;
      const launch = getLaunch(store.db, ticket.launchId);
      if (!launch?.tmuxSession) {
        setTicketError(
          store.db,
          ticket.id,
          "review-agent gate: the implementation session is gone, so no review could be prepared."
        );
        pipelineReviewGateFailed(store.db, ticket.launchId, { broadcast });
        rebroadcast();
        return;
      }
      // Compose the exact review for this project's target repo through its
      // code-review adapter (code-review/adapter.ts), in dryRun so
      // nothing is cut here — the still-live implementation session runs it.
      // The adapter is resolved over the project's checkouts' remotes, the
      // launch's own among them, as its code_review stage's issue-id ask is.
      // The composed command carries Co-authored-by trailers from the
      // session's participants so every collaborator is credited.
      const cwd = project.launchSubdir
        ? join(launch.worktreePath, project.launchSubdir)
        : launch.worktreePath;
      const artifact = await composeReviewArtifact(
        project,
        {
          worktreePath: cwd,
          title: ticket.title,
          body: ticket.body,
          participants: ticket.sessionId
            ? participantsForCoAuthors(store.db, ticket.sessionId)
            : [],
          issueId: ticket.issueId,
          reviewUrl: ticket.reviewUrl,
          baseBranch: launch.baseBranch?.trim() || project.branch,
        },
        { dryRun: true },
        { remotes: projectCheckoutRemotes(store.db, project, { checkout: launch.worktreePath }) }
      ).catch((e) => {
        console.error("[review-artifact]", e);
        return null;
      });
      // Nudge the still-live implementation session to cut the review itself
      // (needed where cutting a review is itself agentic), held
      // to the launching user's saved review-rigor default when they have one,
      // and handed the composed artifact so it cuts the right one.
      // The nudge asks the agent to report the URL back with
      // report_ticket_status; the hand-off recorded first makes that one
      // report the gate's record of the code review for the launch's delivery pipeline.
      // For a ticket ingested from an agent-driven tracker, fold in the
      // writeback directive so the session closes the loop on its task with
      // its own tracker tools — the tracker sync's return leg.
      const trackerWriteback = trackerWritebackFor(tracker, ticket, ticket.reviewUrl);
      markReviewHandoff(store.db, ticket.launchId);
      const sent = await sendToLaunch(
        launch,
        reviewAgentNudge(reviewRigorForLaunch(store.db, launch), artifact, trackerWriteback)
      ).catch((err) => ({ ok: false, error: (err as Error).message }));
      if (!sent.ok) {
        clearReviewHandoff(store.db, ticket.launchId);
        setTicketError(
          store.db,
          ticket.id,
          sent.error ?? "review-agent gate: could not reach the implementation session."
        );
        pipelineReviewGateFailed(store.db, ticket.launchId, { broadcast });
        rebroadcast();
      }
      return;
    }

    // "pause" or unset: no gate — a human marks the ticket complete.
  }

  // The auto-review reviewer, fired alongside the review gate on the developing
  // -> needs_review edge. A READ-ONLY reviewer passes over the ticket's diff and
  // records findings; only High/critical ones are broadcast to the review-queue
  // (de-noise). This never dispatches a fixer — the fixer is a separate, human-
  // triggered path (POST /api/review-findings/:id/fix). Fire-and-forget like the
  // review gate; guarded on a resolvable worktree (nothing to diff otherwise), so
  // an externally-claimed ticket with no launch is a no-op rather than a spawn.
  async function runAutoReviewGate(ticket: Ticket, project: Project): Promise<void> {
    if (!ticket.launchId) return;
    const launch = getLaunch(store.db, ticket.launchId);
    if (!launch?.worktreePath) return;
    const cwd = project.launchSubdir
      ? join(launch.worktreePath, project.launchSubdir)
      : launch.worktreePath;
    const result = await runAutoReview(
      store.db,
      { ticket, worktreePath: cwd, baseBranch: launch.baseBranch?.trim() || project.branch },
      autoReviewDeps,
      (finding) => broadcastFinding(finding, "finding:new")
    );
    // A re-review superseded the prior pass's still-open findings; push the
    // High/critical ones (the only severities that ever reached the queue) as
    // updates so a stale duplicate drops off the client's live queue too.
    for (const stale of result.superseded) {
      if (isHighSeverity(stale.severity)) broadcastFinding(stale, "finding:updated");
    }
  }

  // The single gated entry to the developing -> needs_review edge, shared by the
  // agent's mark_ready_for_review and the terminal-run sync so the review gate
  // runs exactly once no matter which fires first. Broadcasts the transition and
  // kicks off runReviewGate (fire-and-forget). Idempotent: a ticket already in
  // needs_review is returned unchanged — the caller that performed the edge
  // already ran the gate, so a racing second caller is a no-op, not a
  // needs_review -> needs_review self-loop TicketTransitionError (which would
  // otherwise skip the gate entirely). An illegal edge from any other status
  // still throws for the caller to map to 409.
  function advanceTicketToReview(
    ticket: Ticket,
    opts?: { readyReason?: string; note?: string; actor?: string; sessionId?: string }
  ): Ticket {
    if (ticket.status === "needs_review") return ticket;
    const updated = updateTicketStatus(store.db, ticket.id, "needs_review", {
      readyReason: opts?.readyReason,
      note: opts?.note,
      actor: opts?.actor,
      sessionId: opts?.sessionId,
    });
    broadcastTicket(updated);
    // "Ready for review" is a spec terminal state and the single highest-value
    // human-facing moment — a change is ready for you to look at. Emitting here,
    // at the one choke point every developing -> needs_review caller shares
    // (mark_ready_for_review, the /status needs_review edge, and the terminal-run
    // sync), surfaces it as a substantive feed row through the same checkpoint
    // pipe both feed surfaces read — no matter which path fired the edge, and
    // without relying on a coincident report-task success. `self-reported` (the
    // agent/reporter asserted readiness, not a System inference); only when a
    // session is known — a checkpoint needs one, and the idempotent early return
    // above means a racing second caller never double-emits.
    if (updated.sessionId) {
      emitTerminalCheckpoint(
        updated.sessionId,
        "self-reported",
        `🔍 Ready for review — ${updated.title}`
      );
    }
    const project = getProject(store.db, updated.projectId);
    if (project) {
      // Tracked so a drain waits for the gate to record its interruption.
      drain.track(runReviewGate(updated, project)).catch((e) => console.error("[review-gate]", e));
      // Independent of the code review gate: a read-only reviewer over the diff that
      // records findings for the review-queue. Non-destructive, never dispatches
      // a fixer — kept a separate fire-and-forget so a reviewer failure can't
      // block the ticket advancing.
      runAutoReviewGate(updated, project).catch((e) => console.error("[auto-review]", e));
    }
    return updated;
  }

  // Ship is a spec terminal state the feed must surface. It's a ticket
  // lifecycle action, not the agent's own turn, so it attributes to System via
  // `auto`. Shared by every path that can reach the shipped edge — the /ship
  // button (guardedTransition) and the decoupled report_ticket_status setter —
  // so a ship surfaces one '🚢 Shipped' feed row regardless of how it was
  // reported. Only when the ticket carries the implementing session — a
  // checkpoint needs one, and that session is where the shipped work lived.
  const emitShipCheckpoint = (ticket: Ticket): void => {
    if (ticket.sessionId) {
      emitTerminalCheckpoint(ticket.sessionId, "auto", `🚢 Shipped — ${ticket.title}`);
    }
  };

  // Load a ticket, attempt a guarded transition, map an illegal edge to 409,
  // and broadcast + return the updated ticket. Shared by ship and dismiss. The
  // acting alias is attributed so a ship/dismiss records who did it — the same
  // decoupled attribution the external status setter uses (no launch required).
  const guardedTransition = (c: Context, to: TicketStatus) => {
    const id = c.req.param("id");
    if (!id || !getTicket(store.db, id)) return c.json({ error: "Not found" }, 404);
    let updated: Ticket;
    try {
      updated = updateTicketStatus(store.db, id, to, {
        actor: actingAlias(c),
      });
    } catch (e) {
      if (e instanceof TicketTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }
    broadcastTicket(updated);
    if (to === "shipped") emitShipCheckpoint(updated);
    return c.json({ ticket: updated });
  };

  // Propose — creates a `proposed` ticket. Called by the propose_ticket MCP tool
  // (headless review agents), which may send session_id: null (untracked
  // provenance — that's expected and fine).
  app.post("/api/tickets/propose", async (c) => {
    const body = await c.req.json<{
      projectId?: string;
      lens?: string;
      title?: string;
      body?: string;
      severity?: string;
      issueId?: string;
      session_id?: string | null;
      cwd?: string | null;
    }>();

    const projectId = body.projectId?.trim();
    if (!projectId || !getProject(store.db, projectId)) {
      return c.json({ error: `Unknown project: ${body.projectId ?? ""}` }, 404);
    }
    const lens = body.lens?.trim();
    if (!lens) return c.json({ error: "lens is required" }, 400);
    const title = body.title?.trim();
    if (!title) return c.json({ error: "title is required" }, 400);
    const severity = (body.severity ?? "medium") as TicketSeverity;
    if (!TICKET_SEVERITIES.includes(severity)) {
      return c.json({ error: `Unknown severity: ${body.severity}` }, 400);
    }

    const ticket = createTicket(store.db, {
      projectId,
      lens,
      title,
      body: body.body ?? "",
      severity,
      proposedBySessionId: body.session_id ?? undefined,
      issueId: body.issueId?.trim() || undefined,
    });
    broadcastTicket(ticket, "ticket:new");
    return c.json({ ticket }, 201);
  });

  // Ingest an issue-tracker task as a work item — "assign a task to Standup".
  // Refused (409) when no tracker is configured (the built-in `none`). The
  // task's fields are handed over (id + title required), or — with only an id —
  // fetched through the tracker adapter when it can reach the tracker. The
  // task's `url` is stored on the ticket (surfaced on the card as a link back).
  // Routed through the idempotent ingestTaskAsWorkItem so re-assigning the same
  // task resolves to its existing work item (scoped per project) rather than a
  // duplicate. Returns { ticket, created, autoWriteback, warning? }: 201 + a
  // ticket:new broadcast on a fresh create, 200 with the existing ticket when
  // already ingested. `autoWriteback` reports whether the project's review
  // process fires the return leg automatically; when it doesn't, `warning`
  // says so.
  //
  // An inbound task `status` is not accepted: an ingested task always begins
  // as a `proposed` work item and Standup owns its lifecycle from there.
  app.post("/api/tickets/ingest-task", async (c) => {
    if (!tracker.enabled) {
      return c.json({ error: "No issue tracker is configured (STANDUP_TRACKER), so no task can be ingested." }, 409);
    }
    const body = await c.req.json<{
      projectId?: string;
      taskId?: string;
      title?: string;
      description?: string;
      url?: string;
      severity?: string;
    }>();

    const projectId = body.projectId?.trim();
    const project = projectId ? getProject(store.db, projectId) : undefined;
    if (!projectId || !project) {
      return c.json({ error: `Unknown project: ${body.projectId ?? ""}` }, 404);
    }
    const taskId = body.taskId?.trim();
    if (!taskId) return c.json({ error: "taskId is required" }, 400);

    let severity: TicketSeverity | undefined;
    if (body.severity !== undefined) {
      severity = body.severity as TicketSeverity;
      if (!TICKET_SEVERITIES.includes(severity)) {
        return c.json({ error: `Unknown severity: ${body.severity}` }, 400);
      }
    }

    let task: TrackerTask;
    const title = body.title?.trim();
    if (title) {
      task = { id: taskId, title, description: body.description, url: body.url };
    } else {
      try {
        task = await tracker.getTask(taskId);
      } catch (e) {
        return c.json({ error: `title is required (${tracker.name} could not be read: ${(e as Error).message})` }, 400);
      }
    }
    const { ticket, created } = ingestTaskAsWorkItem(store.db, task, { projectId, severity });
    if (created) broadcastTicket(ticket, "ticket:new");
    const autoWriteback = firesTrackerWriteback(tracker, project.reviewProcess);
    const warning = autoWriteback
      ? undefined
      : `Project "${project.name}" has no automated review gate (review process: ${project.reviewProcess ?? "pause"}), so the ${tracker.name} task status will not be written back automatically — update the task by hand once the work ships.`;
    return c.json({ ticket, created, autoWriteback, warning }, created ? 201 : 200);
  });

  // Approve — advances proposed -> approved. Decoupled from dispatch: by default
  // it does NOT launch an implementation session, so an external approver (an
  // agent or a user with no Standup-owned worktree) can approve a ticket without
  // owning a dispatch. The old one-click "approve = start work" is opt-in via
  // ?dispatch=true (the board passes it) — then it fires the implementation
  // launch first and links it, exactly as before. Actual work on an approved
  // ticket otherwise starts via POST /api/tickets/:id/dispatch or an external
  // status report to /status.
  app.post("/api/tickets/:id/approve", async (c) => {
    const id = c.req.param("id");
    const t = getTicket(store.db, id);
    if (!t) return c.json({ error: "Not found" }, 404);
    if (t.status !== "proposed") {
      return c.json({ error: `ticket is ${t.status}, not proposed` }, 409);
    }
    // The approving user — same alias resolution as dispatch/launch — recorded
    // as the reporter and, when dispatching, as the launch requester so the
    // implementation session's created_actor is the approver (spec E/G) and
    // their profile / review rigor is injected (spec A/B).
    const actor = actingAlias(c);
    const dispatch = c.req.query("dispatch") === "true";

    if (!dispatch) {
      let updated: Ticket;
      try {
        updated = updateTicketStatus(store.db, id, "approved", { actor });
      } catch (e) {
        if (e instanceof TicketTransitionError) return c.json({ error: e.message }, 409);
        throw e;
      }
      broadcastTicket(updated);
      return c.json({ ticket: updated });
    }

    const project = getProject(store.db, t.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 404);

    // Same double-dispatch guard POST /dispatch uses — the opt-in "approve = start
    // work" launches an implementation session, and the ticket only advances
    // proposed -> approved at the END of this handler. Two rapid clicks would both
    // read status 'proposed' (the check above is across an await on the launch, so
    // neither has transitioned yet), both launch, and spawn two agents on one
    // ticket — the loser only 409s afterward, once its agent is already live.
    // Refuse when a run is already live for the ticket OR another dispatch for it
    // is in flight in THIS process, and reserve the ticket synchronously (no await
    // between the check and the add) so the second concurrent request sees it.
    if (activeRunForTicket(store.db, t) || ticketsDispatching.has(id)) {
      return c.json({ error: "A run is already active for this ticket — stop it before re-dispatching." }, 409);
    }
    ticketsDispatching.add(id);
    try {
      let launch: Launch;
      try {
        // launchFn FIRST — its synchronous precondition failures (no repo, no
        // tmux) throw BEFORE any launch row exists, leaving the ticket in
        // 'proposed' (retryable). Only once a launch exists do we link + advance.
        // Fired through the injectable launch seam (default launchSession) so this
        // path shares the dispatch route's testable launcher.
        const result = await launchFn(
          store.db,
          {
            project,
            task: `${t.title}\n\n${t.body}\n\nImplement this fix.`,
            label: t.title,
            requester: actor,
            launchedBy: scopingUser(c),
          },
          broadcastLaunch,
          // Product-knowledge injection (roadmap r8): pass the active embedding
          // provider so a ticket-fired launch gets the same semantic recall an
          // ordinary launch does, and drive that retrieval off the LINKED
          // ticket's own title+body rather than the task string (which appends
          // "Implement this fix.") — the linked-ticket targeting the item calls
          // for.
          {
            embeddingProvider,
            embeddingConfig,
            contextQuery: `${t.title}\n\n${t.body}`,
          }
        );
        launch = result.launch;
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      setTicketLaunch(store.db, id, launch.id);
      let updated: Ticket;
      try {
        updated = updateTicketStatus(store.db, id, "approved", { actor });
      } catch (e) {
        if (e instanceof TicketTransitionError) return c.json({ error: e.message }, 409);
        throw e;
      }
      broadcastTicket(updated);
      return c.json({ ticket: updated, launch });
    } finally {
      ticketsDispatching.delete(id);
    }
  });

  // Ready — developing -> needs_review + review gate. The ticket is resolved
  // from :id (unless it's the "_" placeholder the MCP tool posts), else
  // body.ticketId, else the calling session's launch. Registered with and
  // without :id so mark_ready_for_review can post to either.
  const readyHandler = async (c: Context) => {
    const idParam = c.req.param("id");
    const body = await c.req
      .json<{
        session_id?: string | null;
        cwd?: string | null;
        ticketId?: string;
        readyReason?: string;
      }>()
      .catch(() => ({}) as {
        session_id?: string | null;
        cwd?: string | null;
        ticketId?: string;
        readyReason?: string;
      });

    let t: Ticket | null = null;
    if (idParam && idParam !== "_") t = getTicket(store.db, idParam);
    if (!t && body.ticketId) t = getTicket(store.db, body.ticketId);
    if (!t) {
      const launch = body.session_id
        ? getLaunchBySession(store.db, body.session_id)
        : body.cwd
          ? findLaunchByCwd(store.db, body.cwd)
          : null;
      if (launch) t = getTicketByLaunch(store.db, launch.id);
    }
    if (!t) return c.json({ error: "Could not resolve a ticket for this request" }, 404);

    // Plan-gate: a gated launch may not mark its work ready until the human has
    // approved the plan AND the approved acceptance criterion passes in the
    // worktree. The gate is keyed to the ticket's implementing launch so every
    // path that can reach developing -> needs_review (mark_ready_for_review,
    // report_ticket_status, report_task) enforces it identically, and the check
    // isn't fooled by a caller whose session/cwd is unrelated to the ticket.
    // The same check holds the launch's delivery pipeline to its code_review stage.
    const gateBlock = await planReadyBlockForTicket(t);
    if (gateBlock) return c.json({ error: gateBlock }, 409);
    // Orchestration enforcement: a ticket governed by an orchestration profile
    // may not become review-ready until its bounded develop -> deploy -> review
    // run has succeeded (the choke reads the ledger; the loop runs async).
    const orchBlock = orchestrationReadyBlockForTicket(t);
    if (orchBlock) return c.json({ error: orchBlock }, 409);

    let updated: Ticket;
    try {
      updated = advanceTicketToReview(t, {
        readyReason: body.readyReason,
        actor: actingAlias(c),
        // Link the reporting session when one was resolved, so an externally-
        // claimed ticket (no dispatched launch) still resolves by session.
        sessionId: body.session_id ?? undefined,
      });
    } catch (e) {
      if (e instanceof TicketTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }

    return c.json({ ticket: updated });
  };
  app.post("/api/tickets/ready", readyHandler);
  app.post("/api/tickets/:id/ready", readyHandler);

  // ── Plan-approval gate ────────────────────────────────────────────────────
  // The submit_plan MCP target: the gated agent posts its relevant files, plan,
  // and machine-checkable acceptance criterion, then this handler BLOCKS (long-
  // poll, like /api/ask) until a human approves or rejects — the pause that
  // holds the run at the gate. It returns the resolved plan (carrying any human
  // edits) so the agent implements against the approved version. A launch with
  // no gate returns `no_gate` so the tool tells the agent to just proceed.
  // The reviewer's feedback (rejection) or note (approval) for a plan, held
  // until the blocked submit_plan call returns it to the agent. Stored in
  // plan_review_remarks, so a remark written before a collector restart
  // reaches the call the worker re-sends to the next collector. A remark
  // outlives the reply that carries it (`delivered`), so an agent retrying a
  // call it gave up on still gets it; it expires after a day.
  const setPlanRemark = (id: string, remark: { feedback?: string; note?: string }) =>
    setPlanReviewRemark(store.db, id, remark);
  const MAX_PLAN_REMARK_CHARS = 8_000;
  const planRemark = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_PLAN_REMARK_CHARS) : undefined;

  app.post("/api/plan/submit", async (c) => {
    const { session_id, cwd, relevant_files, plan, acceptance_criterion, timeout_s } =
      await c.req.json<{
        session_id?: string | null;
        cwd?: string | null;
        relevant_files?: string[];
        plan?: string;
        acceptance_criterion?: string;
        timeout_s?: number;
      }>();

    const gate = resolvePlanGateFor(session_id, cwd);
    if (!gate) return c.json({ status: "no_gate" });
    if (!plan?.trim()) return c.json({ error: "plan is required" }, 400);

    // A submit_plan the agent's client gave up on (an MCP tool timeout) is
    // retried with the same plan, often reworded. The version under review
    // stays: a retry while it awaits a decision just waits on it again, one
    // after the approval gets the approval, and one after a rejection no reply
    // has carried yet gets that rejection — so a reviewer's decision is never
    // invalidated or lost by the agent's retry. Revising takes a rejection
    // the agent has seen. Every rejection records a remark (feedback or not),
    // so an undelivered one marks a rejection no reply has carried yet.
    const undelivered = getPlanReviewRemark(store.db, gate.id);
    if (gate.status === "rejected" && gate.plan && undelivered && !undelivered.delivered) {
      markPlanReviewRemarkDelivered(store.db, gate.id);
      return c.json({
        status: "rejected",
        plan: gate.plan,
        acceptanceCriterion: gate.acceptanceCriterion,
        relevantFiles: gate.relevantFiles,
        ...(undelivered.feedback ? { feedback: undelivered.feedback } : {}),
      });
    }
    if (gate.status === "awaiting_plan" || gate.status === "rejected") {
      // A remark left for an earlier round (one no submit_plan was waiting on)
      // belongs to that round, not to this submission's review.
      deletePlanReviewRemark(store.db, gate.id);
      const submitted = submitPlan(store.db, gate.id, {
        relevantFiles: Array.isArray(relevant_files)
          ? relevant_files.filter((f) => typeof f === "string")
          : [],
        plan,
        acceptanceCriterion: acceptance_criterion,
      });
      broadcastPlan(submitted);
      // Persona reviews its own workers' plans and pushes the owner itself when
      // it escalates one.
      if (!personaHandlesLaunch(gate.launchId)) {
        const planSession = session_id ? getSession(store.db, session_id) : null;
        void pushNotification(
          "Plan awaiting your approval",
          plan.split("\n")[0]?.slice(0, 140) ?? "An agent submitted a plan for review.",
          responsibleAlias(store.db, planSession) ?? null
        );
      }
    }

    // A call re-sent while its plan awaits review is the same waiter back
    // (its connection dropped, e.g. across a collector restart).
    if (gate.status === "awaiting_approval") persona.restart?.noteReattached(gate.id);

    const resolution = await waitForPlanApproval(
      store.db,
      gate.id,
      timeout_s ?? PLAN_APPROVAL_DEFAULT_TIMEOUT_S
    );
    if (resolution.status === "timeout") return c.json({ status: "timeout" });

    const a = resolution.approval;
    const remarks = getPlanReviewRemark(store.db, gate.id);
    if (remarks) markPlanReviewRemarkDelivered(store.db, gate.id);
    return c.json({
      status: resolution.status,
      plan: a.plan,
      acceptanceCriterion: a.acceptanceCriterion,
      relevantFiles: a.relevantFiles,
      ...(resolution.status === "rejected" && remarks?.feedback ? { feedback: remarks.feedback } : {}),
      ...(resolution.status === "approved" && remarks?.note ? { note: remarks.note } : {}),
    });
  });

  // Plans awaiting a human — powers the Work approve/edit affordance.
  app.get("/api/plans/pending", (c) =>
    c.json({ plans: getPendingPlanApprovals(store.db) })
  );

  // Approve a submitted plan, optionally editing the relevant files, plan text,
  // or acceptance criterion first — releasing the paused run with the edited
  // version. Composes with wave-2 owner routing via the acting alias.
  app.post("/api/plans/:id/approve", async (c) => {
    const id = c.req.param("id");
    const gate = getPlanApproval(store.db, id);
    if (!gate) return c.json({ error: "Not found" }, 404);
    type ApproveBody = {
      relevantFiles?: string[];
      plan?: string;
      acceptanceCriterion?: string;
      actor?: string;
      note?: unknown;
      expectedPlanHash?: unknown;
    };
    const edits = await c.req.json<ApproveBody>().catch(() => ({}) as ApproveBody);
    // The acceptance criterion is a shell command the collector runs once the
    // worker finishes, so changing it is the owner's; approving the criterion
    // as submitted (Persona's approval) is not.
    if (
      typeof edits.acceptanceCriterion === "string" &&
      edits.acceptanceCriterion.trim() !== (gate.acceptanceCriterion ?? "").trim()
    ) {
      const refused = ownerRefusal(c, "approve a plan with an edited acceptance criterion");
      if (refused) return refused;
    }
    const note = planRemark(edits.note);
    let updated: PlanApproval;
    try {
      updated = approvePlan(store.db, id, {
        relevantFiles: edits.relevantFiles,
        plan: edits.plan,
        acceptanceCriterion: edits.acceptanceCriterion,
        // actor overrides the tunnel alias so an off-tunnel approver (e.g. from
        // Slack, which carries no tunnel header) is attributed correctly.
        approvedBy: actingAlias(c, edits.actor),
        // An approver that reviewed a specific version (planApprovalHash)
        // approves only that version.
        expectedHash: typeof edits.expectedPlanHash === "string" ? edits.expectedPlanHash : undefined,
      });
    } catch (err) {
      if (err instanceof PlanChangedError) return c.json({ error: err.message }, 409);
      throw err;
    }
    if (note) setPlanRemark(id, { note });
    broadcastPlan(updated);
    return c.json({ plan: updated });
  });

  // Reject a submitted plan — submit_plan returns the rejection (with the
  // reviewer's `feedback`, when given) so the agent can revise and resubmit
  // against the same gate.
  app.post("/api/plans/:id/reject", async (c) => {
    const id = c.req.param("id");
    const gate = getPlanApproval(store.db, id);
    if (!gate) return c.json({ error: "Not found" }, 404);
    const body = await c.req
      .json<{ actor?: string; feedback?: unknown }>()
      .catch(() => ({}) as { actor?: string; feedback?: unknown });
    const feedback = planRemark(body.feedback);
    // Recorded with or without feedback: an undelivered remark is what tells a
    // retried submit_plan (one whose waiter was released, e.g. by a restart)
    // that this rejection is still owed to the agent.
    setPlanRemark(id, feedback ? { feedback } : {});
    const updated = rejectPlan(store.db, id, { approvedBy: actingAlias(c, body.actor) });
    broadcastPlan(updated);
    return c.json({ plan: updated });
  });

  // Ship / Dismiss — guarded terminal transitions.
  app.post("/api/tickets/:id/ship", (c) => guardedTransition(c, "shipped"));
  app.post("/api/tickets/:id/dismiss", (c) => guardedTransition(c, "dismissed"));

  // Status — the decoupled, transition-guarded status setter. Unlike /approve
  // and /dispatch it owns NO Standup launch: any external agent or user reports
  // or advances a ticket through the SAME state machine (the single guard in
  // updateTicketStatus), attributed to the reporting alias and an optional
  // session, with an optional note and reviewUrl. This is the wave-3 review-
  // artifact seam — status is reported, not inferred from a dispatched launch.
  //
  // The developing -> needs_review edge still runs the project review gate via
  // advanceTicketToReview, so an external "needs_review" is gated exactly like
  // the agent's own mark_ready_for_review (and is idempotent — a ticket already
  // in needs_review is a no-op, not a 409). Every other legal edge — including
  // the rework edges (needs_review -> developing, dismissed -> proposed/
  // approved) — goes through updateTicketStatus. reviewUrl is orthogonal to
  // status, so it is recorded whether or not the edge itself changes anything.
  app.post("/api/tickets/:id/status", async (c) => {
    const id = c.req.param("id");
    const t = getTicket(store.db, id);
    if (!t) return c.json({ error: "Not found" }, 404);

    const body = await c.req
      .json<{
        status?: string;
        note?: string;
        reviewUrl?: string;
        session_id?: string | null;
      }>()
      .catch(() => ({}) as { status?: string; note?: string; reviewUrl?: string; session_id?: string | null });

    const to = body.status?.trim() as TicketStatus | undefined;
    if (!to || !TICKET_STATUSES.includes(to)) {
      return c.json({ error: `Unknown status: ${body.status ?? ""}` }, 400);
    }
    const actor = actingAlias(c);
    const sessionId = body.session_id?.trim() || undefined;
    const note = body.note?.trim() || undefined;
    const reviewUrl = body.reviewUrl?.trim();

    if (reviewUrl) {
      setReviewUrl(store.db, id, reviewUrl);
      if (isHttpUrl(reviewUrl)) trackerWritebackFromCollector(t, reviewUrl);
      // Only the ticket's own worker reaches its run: as the review gate's
      // record when it is a review-agent project's session reporting the code review
      // the gate handed it, as its own report otherwise. Only an http(s) url
      // can be recorded, so nothing else takes the gate's hand-off.
      const source = isHttpUrl(reviewUrl) ? reportedReviewUrlSource(store.db, t, sessionId) : null;
      if (source) pipelineReviewUrl(t, reviewUrl, source === "review_gate");
    }

    try {
      if (to === "needs_review") {
        // A plan-gated ticket must clear the acceptance-criterion gate on THIS
        // edge too — otherwise report_ticket_status would be an unguarded
        // sibling that bypasses the gate mark_ready_for_review enforces.
        const gateBlock = await planReadyBlockForTicket(t);
        if (gateBlock) return c.json({ error: gateBlock }, 409);
        // Same orchestration enforcement as mark_ready — this decoupled status
        // report must not be an unguarded sibling that bypasses the gate.
        const orchBlock = orchestrationReadyBlockForTicket(t);
        if (orchBlock) return c.json({ error: orchBlock }, 409);
        // On the review edge the note doubles as the ready summary (readyReason),
        // and is also kept as the general status note like every other edge.
        advanceTicketToReview(t, { readyReason: note, note, actor, sessionId });
      } else {
        const updated = updateTicketStatus(store.db, id, to, { note, actor, sessionId });
        broadcastTicket(updated);
        // Rework edge (needs_review -> developing): invalidate any cached
        // acceptance-criterion pass so the gate re-runs it on the next
        // mark_ready. Otherwise a criterion verified against the pre-rework work
        // stays cached true and a broken rework would ride it into review.
        if (t.status === "needs_review" && to === "developing" && t.launchId) {
          const gate = getPlanApprovalByLaunch(store.db, t.launchId);
          if (gate?.criterionMet) broadcastPlan(resetCriterionMet(store.db, gate.id));
        }
        // Rework edge, orchestration analog (NOT gated on launchId): a prior
        // `succeeded` orchestration run passed against the pre-rework change, so
        // it must not keep authorizing completion of the new, un-reviewed work.
        // Supersede it so the completion choke re-blocks until a fresh run passes.
        if (t.status === "needs_review" && to === "developing") {
          supersedeOrchestrationRunsForTicket(store.db, id);
        }
        // Rework edge, delivery-pipeline analog: the launch's run goes back to
        // coding, so the reworked change comes through every stage again —
        // only when a person sent it back through the console. Any other
        // caller counts as a worker, whatever session it names (or none): a
        // worker could otherwise reset its own loop budgets at will.
        const byPerson = humanRefusal(c, "send the work back for rework") === null;
        if (t.status === "needs_review" && to === "developing" && t.launchId && byPerson) {
          const reworkLaunchId = t.launchId;
          void pipelineReworkRequested(store.db, reworkLaunchId, pipelineDeps)
            .then(async () => {
              // The rework steer reaches a worker paused for idleness once it is resumed.
              const reworkSession = getLaunch(store.db, reworkLaunchId)?.sessionId;
              if (reworkSession) await wakeQueued(reworkSession);
            })
            .catch((err) => console.error("[pipeline] moving the run back for rework failed:", err));
        }
        // shipped is a spec terminal state; surface it on this decoupled path
        // too, so report_ticket_status=shipped yields the same '🚢 Shipped' feed
        // row the /ship button does. updateTicketStatus preserves the ticket's
        // existing session_id when this report carried none, so a dispatched
        // ticket's implementing session is still found.
        if (to === "shipped") emitShipCheckpoint(updated);
      }
    } catch (e) {
      if (e instanceof TicketTransitionError) return c.json({ error: e.message }, 409);
      throw e;
    }

    // Re-read after every mutation (status edge + any reviewUrl write) so the
    // response is whole. Broadcast the fresh row when reviewUrl landed on an edge
    // that was itself a no-op (already needs_review), which wouldn't have.
    const fresh = getTicket(store.db, id)!;
    if (reviewUrl) broadcastTicket(fresh);
    return c.json({ ticket: fresh });
  });

  // Dispatch / re-dispatch — fire a fresh implementation launch for a stranded
  // ticket: one whose approval launch failed (still `approved`, error on the
  // card) or whose implementation run failed/was lost (still `developing`).
  // Mirrors approve's launch but keeps the ticket's status — the new session
  // attaching relinks it (and advances approved -> developing) via the
  // SessionStart hook. Refused while a run is still live so a double-click can't
  // spawn two agents on the same ticket.
  app.post("/api/tickets/:id/dispatch", async (c) => {
    const id = c.req.param("id");
    const t = getTicket(store.db, id);
    if (!t) return c.json({ error: "Not found" }, 404);
    if (t.status !== "approved" && t.status !== "developing") {
      return c.json(
        { error: `ticket is ${t.status}; only an approved or developing ticket can be re-dispatched` },
        409
      );
    }
    // Best-of-N: `attempts: N` (N in 1..4) fans the dispatch out to N parallel
    // attempts, each its own worktree + ledger run grouped by an attempt id, for
    // side-by-side comparison and a later pick. attempts <= 1 keeps the single
    // launch below unchanged. Parse the body BEFORE the double-dispatch guard:
    // c.req.json() yields the event loop, so reading it first keeps the guard and
    // the run it reserves in one synchronous step. Were this await left between
    // them, a concurrent dispatch of the same ticket could clear the guard, park
    // on this await, and both go on to reserve a run — two agents on one ticket.
    const body = await c.req
      .json<{ attempts?: number }>()
      .catch(() => ({}) as { attempts?: number });
    const attempts = clampAttempts(body.attempts ?? 1);

    // Refuse a double-dispatch of THIS ticket. Two synchronous checks, run with
    // no await before the reservation below so a concurrent request can't slip
    // between check and reserve: a run already live for the ticket
    // (activeRunForTicket — resolved through its current launch, so a run just
    // dispatched with no session attached yet is still seen), OR another dispatch
    // for this same ticket already in flight in THIS process (ticketsDispatching,
    // reserved below before the first await, so the second concurrent request
    // sees it even though neither has created a task_run yet).
    if (activeRunForTicket(store.db, t) || ticketsDispatching.has(id)) {
      return c.json({ error: "A run is already active for this ticket — stop it before re-dispatching." }, 409);
    }
    const project = getProject(store.db, t.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 404);

    const requester = actingAlias(c);
    // The scope-gate identity for injected knowledge, resolved server-side and
    // distinct from the attributable `requester` (anonymous → undefined).
    const retrievalUser = scopingUser(c);
    // Reserve the ticket synchronously — no await since the guard above — so a
    // concurrent dispatch is refused; released once this dispatch settles.
    ticketsDispatching.add(id);
    try {
      // Retrieval is driven off the linked ticket's own title+body, like the
      // approve path, rather than the "Implement this fix." task string.
      if (attempts > 1) {
        try {
          const { launches, attemptGroup } = await dispatchTicketAttempts(
            store.db,
            {
              ticket: t,
              project,
              attempts,
              requester,
              retrievalUser,
              launchedBy: retrievalUser,
              retrieval: {
                embeddingProvider,
                embeddingConfig,
                contextQuery: `${t.title}\n\n${t.body}`,
              },
            },
            broadcastLaunch,
            // The same injectable launch seam every other route uses, so a test
            // drives the fan-out without provisioning worktrees or spawning tmux.
            launchFn
          );
          const updated = getTicket(store.db, id)!;
          broadcastTicket(updated);
          return c.json({ ticket: updated, launches, attemptGroup });
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      }

      let launch: Launch;
      try {
        const result = await launchFn(
          store.db,
          {
            project,
            task: `${t.title}\n\n${t.body}\n\nImplement this fix.`,
            label: t.title,
            // Resolve to the acting alias — same as the project-launch path — so
            // profile injection (buildOpeningPrompt) and ledger attribution are
            // uniform across both human-triggered launch paths, on and off tunnel.
            requester,
            // The server-resolved identity that scopes injected knowledge —
            // distinct from `requester` and never taken from the request body.
            retrievalUser,
            launchedBy: retrievalUser,
          },
          broadcastLaunch
        );
        launch = result.launch;
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }

      // Point the ticket at the new launch and clear the prior failure — the
      // new session attaching resolves the ticket by this launch id. Clear any
      // best-of-N group too: this ticket may have been dispatched as N attempts
      // earlier, and a single re-dispatch replaces that group with one launch. Left
      // set, the stale group would keep the compare/pick panel live over dead
      // attempts, and picking one would repoint the ticket back at a superseded
      // launch — orphaning this fresh launch and feeding the Publisher the wrong
      // branch.
      setTicketLaunch(store.db, id, launch.id);
      setTicketAttemptGroup(store.db, id, null);
      setTicketError(store.db, id, "");
      const updated = getTicket(store.db, id)!;
      broadcastTicket(updated);
      return c.json({ ticket: updated, launch });
    } finally {
      ticketsDispatching.delete(id);
    }
  });

  // Attempts compare — the diffs of a ticket's best-of-N attempts, side by side.
  // Reads each attempt's worktree diff (against its base branch) so the human can
  // compare the N parallel implementations before picking a winner. A ticket that
  // was never dispatched as multiple attempts has no group, returned as empty.
  app.get("/api/tickets/:id/attempts", async (c) => {
    const id = c.req.param("id");
    const t = getTicket(store.db, id);
    if (!t) return c.json({ error: "Not found" }, 404);
    if (!t.attemptGroup) return c.json({ attemptGroup: null, attempts: [] });
    // Awaited: collectAttemptDiffs shells out to git asynchronously (async spawn,
    // bounded per-attempt), so a large multi-attempt diff never blocks the
    // single-threaded event loop while every other request stalls behind it.
    return c.json({
      attemptGroup: t.attemptGroup,
      attempts: await collectAttemptDiffs(store.db, t.attemptGroup),
    });
  });

  // Pick attempt — choose the winner of a ticket's best-of-N group. The picked
  // run is marked SELECTED and the ticket is repointed at its launch/session so
  // its branch becomes the ticket output (feeding the Publisher); the losers are
  // superseded (and any still-live loser's run cancelled). The losers' panes are
  // then stopped best-effort — a live tmux action, skipped cleanly when a pane is
  // already gone. Only a person picks, through the console: the pick turns the
  // winner's delivery pipeline on and stops the other attempts.
  app.post("/api/tickets/:id/pick-attempt", async (c) => {
    const refused = humanRefusal(c, "pick a Best-of-N attempt");
    if (refused) return refused;
    const id = c.req.param("id");
    const t = getTicket(store.db, id);
    if (!t) return c.json({ error: "Not found" }, 404);
    const body = await c.req
      .json<{ taskRunId?: string }>()
      .catch(() => ({}) as { taskRunId?: string });
    const taskRunId = body.taskRunId?.trim();
    if (!taskRunId) return c.json({ error: "taskRunId is required" }, 400);

    let result;
    try {
      result = pickAttempt(store.db, { ticketId: id, taskRunId }, { broadcast });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    // Stop the superseded, still-live attempts' panes so no losing agent keeps
    // running. Best-effort and guarded — their ledger runs are already cancelled,
    // so a stop that finds the pane already gone is a harmless no-op.
    for (const losing of result.stopLaunches) {
      try {
        await stopLaunch(store.db, losing);
      } catch {
        // A pane that already exited or a stop race is fine — the run is cancelled.
      }
    }
    // A winner whose session isn't mid-turn gets the pipeline brief typed into
    // its pane, since a queued steer would sit undelivered; when that fails
    // the run waits on the owner.
    // A winner paused for idleness is resumed first: into its prompt for a
    // typed brief, or with its next turn started for a queued one.
    const winnerSession = result.winnerLaunch?.sessionId;
    if (winnerSession && result.winnerLaunch?.reapedAt) {
      if (result.pipelineBriefToType) await wakeIfReaped(store.db, winnerSession, resumeDeps);
      else await wakeQueued(winnerSession);
    }
    if (result.pipelineBriefToType && result.winnerLaunch) {
      const sent = await sendToLaunch(result.winnerLaunch, result.pipelineBriefToType).catch((err) => ({
        ok: false,
        error: (err as Error).message,
      }));
      if (!sent.ok) {
        console.error(`[pipeline] could not brief picked launch ${result.winnerLaunch.id}: ${sent.error ?? "unknown"}`);
        pickedAttemptUnreachable(store.db, result.winnerLaunch.id, { broadcast });
      }
    }

    broadcastTicket(result.ticket);
    for (const run of [result.selected, ...result.superseded]) {
      broadcast({ type: "task:updated", payload: run, timestamp: new Date().toISOString() });
    }
    return c.json({
      ticket: result.ticket,
      selected: result.selected,
      superseded: result.superseded,
    });
  });

  // Publish — the PR IS the unit of output. Composes a DRAFT pull request for a
  // ticket's completed change and returns a DRY-RUN preview: the head branch, a
  // commit message carrying deduped Co-authored-by trailers for every distinct
  // session participant, and the draft-PR payload whose body links the ticket +
  // its review findings. Never pushes and never calls gh/the GitHub API in this
  // build — a live publish (git push + `gh pr create --draft`) is a human step,
  // so the composed commands are RETURNED for a human to run, not executed.
  app.post("/api/tickets/:id/publish", (c) => {
    const id = c.req.param("id");
    const ticket = getTicket(store.db, id);
    if (!ticket) return c.json({ error: "Not found" }, 404);
    const project = getProject(store.db, ticket.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 404);
    const launch = ticket.launchId ? getLaunch(store.db, ticket.launchId) : null;
    const preview = publishTicket(store.db, { ticket, project, launch });
    return c.json({ preview });
  });

  // Review comments — the review-comment counterpart to Publish, posting the
  // auto-review findings to the PR the Publisher mints. Composes the ticket's
  // High/critical, still-active findings into a DRY-RUN GitHub reviews-API
  // payload — inline {path,line,body} comments, low/medium excluded — targeting
  // that same minted PR: the head branch + worktree ride the ticket's launch
  // (reviewCommentsPrRefFromLaunch), and the composed `gh api … /reviews`
  // references it, carrying <owner/repo>/<pr-number> placeholders for a human to
  // fill once the draft PR is opened. Never posts and never calls gh in this
  // build — a live post is a human step, so the composed command is RETURNED for
  // a human to run, not executed.
  app.post("/api/tickets/:id/review-comments", (c) => {
    const id = c.req.param("id");
    const ticket = getTicket(store.db, id);
    if (!ticket) return c.json({ error: "Not found" }, 404);
    const launch = ticket.launchId ? getLaunch(store.db, ticket.launchId) : null;
    const payload = reviewCommentsForTicket(store.db, {
      ticket,
      ref: reviewCommentsPrRefFromLaunch(launch),
    });
    return c.json({ payload });
  });

  // ============================================================================
  // Auto-review findings (reviewer/fixer split)
  //
  // The read-only reviewer records findings on the developing -> needs_review
  // edge (runAutoReviewGate). Only High/critical open findings are surfaced here
  // — the Work review-queue's de-noise. The reviewer is SEPARATE from the fixer:
  // recording a finding never dispatches anything. A fixer session is fired ONLY
  // by the explicit "fix this finding" click (POST .../fix), never automatically.
  // ============================================================================

  // The review-queue snapshot: every High/critical, still-open finding across all
  // tickets, newest first. Low/medium are recorded but deliberately never listed.
  app.get("/api/review-findings", (c) => c.json(getOpenHighFindings(store.db)));

  // Every finding for a ticket (all severities) — the ticket's full review record.
  app.get("/api/tickets/:id/findings", (c) =>
    c.json(getReviewFindingsByTicket(store.db, c.req.param("id")))
  );

  // Fix this finding — the ONLY path that dispatches a fixer, and only on this
  // explicit human click. Fires a FRESH implementation session seeded with the
  // specific finding + the reviewed diff (buildFixerPrompt), then marks the
  // finding `dispatched` so it drops off the queue. The reviewer never reaches
  // this; there is no automatic caller.
  app.post("/api/review-findings/:id/fix", async (c) => {
    const id = c.req.param("id");
    const finding = getReviewFinding(store.db, id);
    if (!finding) return c.json({ error: "Not found" }, 404);
    if (finding.status !== "open") {
      return c.json({ error: `finding is ${finding.status}, not open` }, 409);
    }
    const ticket = getTicket(store.db, finding.ticketId);
    if (!ticket) return c.json({ error: "Ticket no longer exists" }, 404);
    const project = getProject(store.db, ticket.projectId);
    if (!project) return c.json({ error: "Project no longer configured" }, 404);

    // Run the fixer IN the ticket's implementation worktree — the tree that
    // actually holds the change under review. A fresh base-branch worktree would
    // not contain it, so the agent would open pristine baseline files and never
    // reach (let alone amend) the reviewed change; the diff text in the prompt
    // is context, not a substitute for the working tree. Absent a resolvable
    // worktree (e.g. an externally-claimed ticket with no launch), fall back to
    // a normal launch — the fixer then works from the prompt's diff alone.
    const implWorktree = ticket.launchId
      ? getLaunch(store.db, ticket.launchId)?.worktreePath
      : undefined;

    let launch: Launch;
    let done: Promise<void> | undefined;
    try {
      // launchSession FIRST — a synchronous precondition failure (no repo/tmux)
      // throws BEFORE the finding is marked dispatched, leaving it `open` and
      // re-dispatchable rather than stranded as a fixer that never launched.
      const result = await launchSession(
        store.db,
        {
          project,
          task: buildFixerPrompt(finding),
          label: `Fix: ${finding.title}`,
          requester: actingAlias(c),
          // The server-resolved identity that scopes injected knowledge —
          // distinct from `requester` and never taken from the request body.
          retrievalUser: scopingUser(c),
          launchedBy: scopingUser(c),
          reuseWorktreePath: implWorktree,
        },
        broadcastLaunch
      );
      launch = result.launch;
      done = result.done;
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    setFindingFixLaunch(store.db, id, launch.id);
    const updated = setFindingStatus(store.db, id, "dispatched");
    if (updated) broadcastFinding(updated, "finding:updated");

    // launchSession returns the instant the launch row exists, before the slow
    // spawn work runs detached; that work can still fail (worktree add,
    // provision, tmux) and mark the launch `failed` in the background. The
    // synchronous try/catch above only catches precondition throws, so without
    // this the finding would stay `dispatched` — dropped off the queue and
    // wedged (a retry hits the `status !== "open"` 409) — even though its fixer
    // never actually ran. Watch the detached work: if it lands `failed`, revert
    // the finding to `open` so it re-surfaces and is re-dispatchable, honoring
    // this endpoint's guarantee that a launch failure leaves the finding open.
    // Guarded so a concurrent human re-triage isn't clobbered: only revert while
    // the finding is still `dispatched` on THIS launch.
    void done
      ?.then(() => {
        const settled = getLaunch(store.db, launch.id);
        if (settled?.status !== "failed") return;
        const current = getReviewFinding(store.db, id);
        if (current?.status !== "dispatched" || current.fixLaunchId !== launch.id) return;
        const reopened = setFindingStatus(store.db, id, "open");
        if (reopened) broadcastFinding(reopened, "finding:updated");
      })
      .catch(() => {
        // done never rejects (its own catch swallows), but keep the promise
        // chain from becoming an unhandled rejection under any future change.
      });

    return c.json({ finding: updated, launch });
  });

  // Dismiss a finding — a human judged it noise; it drops off the review-queue.
  app.post("/api/review-findings/:id/dismiss", (c) => {
    const id = c.req.param("id");
    const finding = getReviewFinding(store.db, id);
    if (!finding) return c.json({ error: "Not found" }, 404);
    const updated = setFindingStatus(store.db, id, "dismissed");
    if (updated) broadcastFinding(updated, "finding:updated");
    return c.json({ finding: updated });
  });

  // ============================================================================
  // MCP-facing endpoints — called by the standup MCP server on the agent's behalf
  //
  // The MCP server sends the real session_id when it can resolve one (read
  // from the transcript filename Claude Code writes under
  // ~/.claude/projects/ — see packages/mcp/src/session-id.ts), which is an
  // exact match. cwd is sent alongside as a fallback for when that
  // resolution fails, in which case we fall back to "most recently started
  // active session in this cwd" — a heuristic that can misattribute if two
  // sessions share a cwd, unlike the session_id path.
  // ============================================================================

  function resolveCallingSession(sessionId: string | null | undefined, cwd: string) {
    if (sessionId) {
      const session = getSession(store.db, sessionId);
      if (session) return session;
    }
    return getMostRecentActiveSessionByCwd(store.db, cwd);
  }

  /**
   * The project a tool call runs under. An explicit `project` naming a known
   * project (knownProjectIds, matched case-insensitively) wins. Otherwise the
   * calling session's project, which resolveSessionProject moves out of scratch
   * (and persists on the session) when any path the session touches — the
   * request cwd, its hook cwds, its transcript's working/additional directories —
   * names a project. With no session, the request cwd alone decides. `warning` is
   * set when an explicit project was unknown (the call runs under the resolved
   * one instead, never under the invented id) or when nothing resolved and the
   * call defaults to scratch. `verb` words the unknown-project warning.
   */
  function resolveCallingProject(
    session: Session | null | undefined,
    cwd: string | undefined,
    explicit?: string,
    verb = "searched"
  ): { projectId: string; warning?: string } {
    const named = explicit?.trim();
    if (named) {
      const known = knownProjectIds(store.db);
      const match = matchKnownProject(known, named);
      if (match) return { projectId: match };
      const resolved = resolveCallingProject(session, cwd);
      const related = relatedProjects(resolved.projectId, getProjects(store.db));
      const warning = unknownProjectWarning(named, resolved.projectId, known, related, verb);
      return { projectId: resolved.projectId, warning: resolved.warning ? `${warning} ${resolved.warning}` : warning };
    }
    if (session) {
      const resolved = resolveSessionProject(store.db, session.id, {
        paths: [cwd],
        onRehomed: onSessionRehomed,
      });
      if (resolved.moved) broadcastSessions();
      return { projectId: resolved.projectId, warning: resolved.warning };
    }
    const fromCwd = cwd ? projectIdForPath(store.db, cwd) : null;
    if (fromCwd) return { projectId: fromCwd };
    return { projectId: "scratch", warning: scratchWarning(cwd ? [cwd] : []) };
  }

  /**
   * Whether `audience` can retrieve any stored doc homed in `projects` (every
   * project when omitted), narrowed to `owners` when given — the same scope gate
   * and owner filter a search pushes into its candidate queries. A search over a
   * corpus this says is empty cannot match anything, however it is phrased.
   */
  function hasSearchableDocs(
    audience: ScopeAudience,
    projects?: readonly string[],
    owners?: readonly string[]
  ): boolean {
    const gate = scopeAudienceSql(audience, "k");
    const where = [gate.sql];
    const params: string[] = [...gate.params];
    if (projects) {
      where.push(`k.project_id IN (${projects.map(() => "?").join(", ")})`);
      params.push(...projects);
    }
    const ownerFilter = owners ? ownerFilterSql(owners, "k") : null;
    if (ownerFilter) {
      where.push(ownerFilter.sql);
      params.push(...ownerFilter.params);
    }
    const row = store.db.query(`SELECT 1 AS found FROM knowledge k WHERE ${where.join(" AND ")} LIMIT 1`).get(...params);
    return row !== null;
  }

  /**
   * Whether an out-of-band coordination write is trusted on this collector. These
   * writes (contradiction resolve/reject/swap, self-fix, queued peer messages, the
   * shared board) now trust the SAME anchor knowledge authoring does under the
   * one-trusted-team model: an AUTHENTICATED tunnel identity. An authenticating tunnel
   * verifies the connecting teammate and stamps an unforgeable identity header
   * (host `$USER` on a single-user loopback box), so a resolved identity is a real
   * user — no out-of-band token needed for the team. This completes the migration
   * the profile-write comment names as a deferred follow-up.
   *
   * The STANDUP_WRITE_TOKEN path is kept as a FALLBACK for the sole case
   * hasTrustedIdentity does not cover — a raw non-tunnel network bind where the
   * header is absent or untrusted — so a configured token still authorizes such a
   * caller, and a multiplayer collector no longer fails closed on its own
   * authenticated teammates.
   */
  function isTrustedCoordinationWrite(c: Context): boolean {
    if (hasTrustedIdentity(c)) return true;
    return isTrustedProfileWrite(
      c.req.header(config.userIdentifier.header),
      undefined,
      c.req.header("x-standup-write-token"),
      undefined,
      isMultiplayerMode(store.db)
    );
  }

  /**
   * Whether the caller may WRITE a doc physically HOMED under the reserved GLOBAL
   * corpus (project_id === GLOBAL_PROJECT_ID). Homing a doc there widens its
   * audience INDEPENDENT of the doc's `scope` column: scopeAudienceSql's
   * reserved-corpus disjunct (`project_id = GLOBAL_PROJECT_ID AND scope != 'user'`)
   * puts every non-user row homed there in-audience for EVERY project's launch
   * injection and scoped search. Under the one-trusted-team model this is a DESIRED
   * contribution — global knowledge the whole team benefits from — not an attack, so
   * a global-home write is allowed for any AUTHENTICATED tunnel identity
   * (hasTrustedIdentity: the tunnel-guaranteed identity header, or the host
   * `$USER` on a loopback box), the SAME trust anchor resolveAuthoredAudience's
   * scope-column half uses. The optional STANDUP_WRITE_TOKEN (isTrustedCoordinationWrite)
   * is only a FALLBACK for a caller with no authenticated identity — a raw
   * non-tunnel network bind where the header is absent/untrusted. This is the HOME
   * half of the audience guard whose SCOPE-COLUMN half resolveAuthoredAudience
   * enforces. A write to any NON-global project reaches only that project, so it is
   * never audience-widening and is always permitted.
   */
  function mayWriteGlobalCorpus(c: Context, projectId: string): boolean {
    return (
      projectId !== GLOBAL_PROJECT_ID ||
      hasTrustedIdentity(c) ||
      isTrustedCoordinationWrite(c)
    );
  }

  /**
   * The single choke point that resolves the scope + owning user a knowledge
   * WRITE lands with, behind the ONE audience gate every scope/owner change must
   * clear. Both the PUT edit route and the propose create/replace path funnel
   * through here, so no write can stamp an audience without the gate and the
   * decision lives in one place rather than duplicated per route.
   *
   * scope/owner_user decide a doc's RETRIEVAL AUDIENCE — a 'global' doc injects
   * into every project's agents, a 'user' doc into its owner's window alone — so
   * an audience-changing write is a stored prompt-injection surface, not a
   * cosmetic edit. The acting identity is resolved SERVER-SIDE (scopingUser — the
   * trust-gated tunnel header / host $USER), never from a client body field: the
   * request's own `owner_user` is ignored, and a doc becoming 'user'-scoped is
   * owned by the acting caller alone (you cannot take another user's doc).
   *
   * The gate is hasTrustedIdentity: an AUTHENTICATED tunnel identity (the
   * tunnel-guaranteed identity header, or the host $USER on a loopback box) may
   * author and scope its own knowledge freely — mark its docs scope='user' owned
   * by itself, and contribute scope='global' knowledge the whole team benefits
   * from — with no operator token. This is a single trusted team behind
   * an authenticating tunnel, which authenticates the teammate, so per-user scope is a
   * SOFT routing boundary, not a wall against a forged peer. The optional
   * STANDUP_WRITE_TOKEN (isTrustedCoordinationWrite) is only a FALLBACK for a
   * caller with NO authenticated identity — a raw non-tunnel network bind where the
   * header is absent/untrusted and the acting alias resolves to anonymous.
   *
   * When the gate passes, the authored outcome is resolved from the request +
   * existing doc: a real change goes through resolveAuthoredScope (which stamps
   * the 'user' owner from the acting alias and demotes an owner-less 'user'
   * request to 'project'); a re-sent scope='user' on an already-owned doc is a
   * NO-OP that keeps the owner; a black-hole 'user' doc (scope='user' with no
   * resolvable owner, in no retrieval window) is recovered by a resolvable caller;
   * a plain edit with no explicit scope preserves the doc's audience; a brand-new
   * doc with no explicit scope takes the project default. As DATA HYGIENE — even
   * with a trusted identity — a caller editing SOMEONE ELSE'S user-scoped doc
   * (acting !== owner) never re-aims it: its scope + owner are preserved, so a body
   * refresh cannot silently reassign or widen another teammate's private doc; only
   * the owner re-scopes their own. When the gate fails (no authenticated identity)
   * the write still lands, but on a SAFE audience: an existing doc keeps its
   * scope+owner, and a brand-new doc is clamped to the visible 'project' default
   * with NO owner.
   *
   * A doc's audience has TWO dimensions, and this gate governs only the SCOPE
   * COLUMN. The second is its physical HOME: a doc homed under the reserved GLOBAL
   * corpus (project_id === GLOBAL_PROJECT_ID) reaches EVERY project regardless of
   * its scope column (scopeAudienceSql's reserved-corpus disjunct), so choosing the
   * global home is an equivalent audience-widening act. That dimension is guarded by
   * mayWriteGlobalCorpus at each write route (the same fail-closed bar), NOT here —
   * this helper resolves scope/owner, not where the file lands.
   *
   * AUDIENCE-WRITE SURFACE — every path that persists a doc's scope/owner_user OR
   * chooses its home, and how each is bounded (audited exhaustively so a new writer
   * is added here):
   *   (a) resolved through THIS gate (scope/owner column):
   *     - PUT /api/projects/:id/knowledge/:slug (edit + first create).
   *     - POST /api/knowledge/propose (create/replace; MCP propose_knowledge,
   *       which forwards only `scope`, never an owner).
   *   (a2) gated by mayWriteGlobalCorpus (physical home = the GLOBAL corpus):
   *     - PUT /api/projects/:id/knowledge/:slug — allows an authenticated identity
   *       to write into project_id 'global'; refuses only a no-identity caller.
   *     - POST /api/knowledge/propose — reroutes a no-identity `project: "global"`
   *       to the caller's own project (an authenticated caller homes it in global).
   *     - POST /api/knowledge/ingest-url — refuses a no-identity `project_id:
   *       "global"` (the accept route is ungated, so this stops a global-homed
   *       draft from being planted by an unauthenticated caller to later self-accept).
   *   (b) provably cannot WIDEN scope/owner (no gate needed):
   *     - POST /api/knowledge/ingest-url — writeDraft with NO scope/owner; a
   *       human-accept draft. A first create lands the 'project' default; a replace
   *       of an existing scoped doc PRESERVES that doc's scope/owner on publish
   *       (see publishDraft), so it can only refresh the body, never re-aim it.
   *     - PUT .../knowledge/drafts/:slug (draft body edit) — writeDraft carrying
   *       the EXISTING draft's scope/owner through (never any from the request),
   *       so it PRESERVES the authored audience and can neither widen it nor plant
   *       one; the loadDrafts round-trip is what makes the draft's scope survive
   *       the edit into a fresh accept instead of defaulting to 'project'.
   *     - accept .../drafts/:slug MERGE branch — writeKnowledgeFile carrying the
   *       TARGET doc's scope/owner through (a merge preserves audience, never resets
   *       it to 'project'); the fresh/replace accept branches publish the
   *       already-gated propose draft in place, preserving scope on replace.
   *     - distill-cron writeDraft — an in-process trusted author,
   *       project-scoped, not request-driven.
   *     - contradiction resolver rewriteBody (knowledge-resolve.ts, the auto
   *       rescope + merge actions, and Item 1's nightly graph-wide sweep) —
   *       an in-process trusted author that re-emits the EXISTING doc's
   *       scope/owner through writeKnowledgeFile (readKnowledgeFile surfaces
   *       both), so an automatic resolution PRESERVES the doc's audience and
   *       can neither widen a 'user'/owner doc to 'project' nor demote a
   *       'global' one — it is not request-driven and takes no scope from input.
   *     - native-memory ingest (native-memory-ingest.ts, run at boot from
   *       index.ts) — writeKnowledgeFile with NO scope/owner. It DOES home the
   *       HOME CLAUDE.md tier under the reserved GLOBAL corpus (an
   *       audience-widening HOME choice), but that homing is code-fixed and runs
   *       at local-operator trust, not from request input — so it sits outside
   *       the request-gated (a2) set (which guards the routes a remote caller can
   *       reach), the same in-process trust as distill. Setting no
   *       scope/owner column, loadProject infers scope='global' for the
   *       global-homed tier and 'project' for the per-project tiers; it can
   *       neither stamp a 'user' scope nor an owner.
   *     - knowledge-sync syncProject/reconcileFileColumns and store
   *       upsertDoc/upsertDraft — reconcile scope/owner FROM the on-disk file
   *       (the loader), which is only written through (a); a disk→index mirror,
   *       not a request-settable surface.
   *
   * KNOWN RESIDUALS — what this gate bounds is a doc's AUDIENCE (its scope/owner
   * column via resolveAuthoredAudience, and its physical home via
   * mayWriteGlobalCorpus); a doc's BODY is deliberately NOT gated. The collector's
   * KB write surface stays open under one-trusted-team, so two pre-existing
   * behaviors are intentionally OUT OF SCOPE here and remain open, tracked as
   * follow-ups that need real per-user write auth to close — not claimed closed by
   * this change:
   *   (i) Any teammate can overwrite the BODY of an EXISTING doc: a content refresh
   *       via propose/replace, a PUT edit, a draft-body edit, or an accept-merge
   *       (except a doc of the personal layer, which every one of those routes
   *       refuses unless the write is Persona's own — persona/memory-trust.ts).
   *       The doc's AUDIENCE is preserved (a replace/merge keeps the target's
   *       scope+owner — see publishDraft's prior-audience restore and the merge
   *       branch's carry-through), so the doc is never re-aimed at a new window; but
   *       refreshing the body of another owner's 'user' doc still edits content that
   *       injects into that owner's agents. On this one trusted team that is
   *       intended collaboration; distinguishing a refresh a teammate should not
   *       make would need real per-user write auth, deferred.
   *   (ii) The accept-MERGE and draft-body-edit paths are NOT themselves behind
   *       isTrustedCoordinationWrite. They cannot demote or widen audience: the
   *       merge re-emits the target doc's scope/owner, and the body edit re-emits
   *       the EXISTING draft's scope/owner (carried through from loadDrafts, taking
   *       none from the request), so each PRESERVES the authored audience rather
   *       than resetting it — they open no audience hole, but share the same
   *       body-refresh surface as (i). Gating them per-user is the same deferred
   *       follow-up.
   */
  function resolveAuthoredAudience(
    c: Context,
    opts: {
      projectId: string;
      requestedScope: Scope | undefined;
      existing?: { scope?: Scope; ownerUser?: string } | null;
    }
  ): { scope: Scope | undefined; ownerUser: string | undefined } {
    const { projectId, requestedScope, existing } = opts;
    const acting = authorUser(c);
    // An authenticated tunnel identity (or the host $USER on loopback) is trusted
    // to author + scope its own knowledge on this one trusted team; the optional
    // write token is only the fallback when no identity resolved at all.
    const mayChangeAudience = hasTrustedIdentity(c) || isTrustedCoordinationWrite(c);

    const ownedUserDoc =
      existing?.scope === "user" &&
      typeof existing.ownerUser === "string" &&
      existing.ownerUser.trim() !== "";

    // The scope + owner an AUTHORIZED caller's request resolves to, before the gate.
    let authoredScope: Scope | undefined;
    let authoredOwner: string | undefined;
    if (ownedUserDoc) {
      // Only the doc's OWN owner may re-aim their user-scoped doc. The acting
      // identity is tunnel-authenticated (unforgeable), so `acting === ownerUser`
      // is a trustworthy check — no write token needed. A teammate editing someone
      // else's user doc (acting !== owner) keeps its scope + owner (data hygiene:
      // a body refresh must not silently reassign or widen another's private doc),
      // as does a re-sent scope='user' or an omitted scope (not a change at all).
      const actingIsOwner = acting !== undefined && acting === existing!.ownerUser;
      const changingScope =
        actingIsOwner && requestedScope !== undefined && requestedScope !== "user";
      if (changingScope) {
        ({ scope: authoredScope, ownerUser: authoredOwner } = resolveAuthoredScope(
          requestedScope,
          acting
        ));
      } else {
        authoredScope = "user";
        authoredOwner = existing!.ownerUser;
      }
    } else if (existing?.scope === "user") {
      // A black-hole 'user' doc lands in no retrieval window. A resolvable caller
      // recovers it — honoring an explicit target scope and, for a 'user' target,
      // taking ownership; an unresolved caller leaves it untouched rather than
      // dropping/forging the owner.
      if (acting !== undefined) {
        ({ scope: authoredScope, ownerUser: authoredOwner } = resolveAuthoredScope(
          requestedScope ?? "user",
          acting
        ));
      } else {
        authoredScope = existing.scope;
        authoredOwner = existing.ownerUser;
      }
    } else if (requestedScope !== undefined) {
      // A non-user existing doc (or a brand-new one) with an explicit scope: a
      // deliberate change/promotion — into 'user' stamps the owner from the acting
      // identity, project<->global re-aims the audience.
      ({ scope: authoredScope, ownerUser: authoredOwner } = resolveAuthoredScope(
        requestedScope,
        acting
      ));
    } else if (existing) {
      // A plain edit with no explicit scope preserves the doc's audience.
      authoredScope = existing.scope;
      authoredOwner = existing.ownerUser;
    } else {
      // A brand-new doc with no explicit scope takes the project/global default.
      ({ scope: authoredScope, ownerUser: authoredOwner } = resolveAuthoredScope(
        getKnowledgeDefaultScope(store.db, projectId),
        acting
      ));
    }

    // The single audience gate. An authorized caller's authored outcome lands;
    // otherwise the body write still succeeds on a SAFE audience — an existing doc
    // keeps its scope+owner, and a brand-new doc is clamped to the 'project'
    // default with no owner. An undefined scope leaves the frontmatter clean,
    // exactly as an unscoped doc had none before.
    if (mayChangeAudience) {
      return { scope: authoredScope, ownerUser: authoredOwner };
    }
    if (existing) {
      return { scope: existing.scope, ownerUser: existing.ownerUser };
    }
    return { scope: DEFAULT_SCOPE, ownerUser: undefined };
  }

  /**
   * An actor id resolved through the actor-merge tombstones (getActor follows
   * `merged_into`), so a since-merged alias compares equal to its canonical
   * identity. Undefined/blank stays undefined. The anonymous sentinel
   * (ANONYMOUS_ALIAS) is not a real identity — a header-less/untrusted request
   * resolves to it rather than impersonating the host — so it too resolves to
   * undefined, matching scopingUser's null semantics: unattributed work stays
   * unattributed and never confers ownership or gets pinned to a named user.
   */
  function canonicalActor(id: string | null | undefined): string | undefined {
    const trimmed = id?.trim();
    if (!trimmed || trimmed === ANONYMOUS_ALIAS) return undefined;
    return getActor(store.db, trimmed)?.id ?? trimmed;
  }

  /**
   * The user a fleet-cost row is attributed to, or null for genuinely
   * unattributed spend. Folds the actor through canonicalActor (merge tombstones
   * plus the anonymous sentinel → undefined), then ALSO treats the host fallback
   * identity — resolveUserAlias(undefined), i.e. `$USER` else "local", the alias
   * a no-tunnel / single-player session is stamped with — as unattributed. So
   * work carrying a real tunnel-authenticated alias is attributed to that person,
   * while host / single-player / no-tunnel work buckets on its own (null) rather
   * than being pinned to the host operator. Distinct from canonicalActor, which
   * keeps resolving the host user for owner-routing / responsibleAlias; only the
   * fleet-cost path folds the host fallback to null.
   */
  function attributedUser(actor: string | null | undefined): string | null {
    const a = canonicalActor(actor);
    if (!a) return null;
    return a === canonicalActor(resolveUserAlias(undefined)) ? null : a;
  }

  /**
   * Whether `actor` is the owner or creator of `session` — the standing an agent
   * needs to act AS that session. Compared through the actor-merge tombstones so a
   * folded alias still matches. This is the SERVER-SIDE identity check that a
   * client-supplied session_id must clear before it confers any scope: naming a
   * session the acting alias does not own grants nothing.
   */
  function actorOwnsSession(
    actor: string | null | undefined,
    session: { ownerActor?: string; createdActor?: string } | null | undefined
  ): boolean {
    const a = canonicalActor(actor);
    if (!a || !session) return false;
    return (
      canonicalActor(session.ownerActor) === a ||
      canonicalActor(session.createdActor) === a
    );
  }

  /**
   * Whether `actor` has standing in `projectId` — owns or created at least one
   * session there. Gates honoring a client-supplied project scope on the shared
   * board so a caller can neither read nor post into a project it has no session
   * in. `scratch` is the unmatched-session catch-all, never a real project scope.
   */
  function actorHasProjectStanding(
    actor: string | null | undefined,
    projectId: string | null | undefined
  ): boolean {
    const pid = projectId?.trim();
    if (!pid || pid === "scratch") return false;
    const a = canonicalActor(actor);
    if (!a) return false;
    return getSessionsByProject(store.db, pid).some((s) => actorOwnsSession(a, s));
  }

  /**
   * The plan-approval gate governing the calling session, or null when the
   * launch is un-gated (the common case). A gate governs ONLY the launch it was
   * opened for: resolve that launch by session then cwd — the same two-step
   * correlation the ticket/knowledge routes use — and return that launch's own
   * gate. findLaunchByCwd already matches a launch whose session hasn't attached
   * yet (session_id IS NULL) and excludes ended/cleaned launches, so it covers
   * the not-yet-attached case without a bare worktree match. Matching a gate by
   * worktree containment alone is deliberately NOT done: every in_place launch
   * shares the repo as its worktree_path, so a bare-worktree fallback would let
   * a stale or unrelated launch's gate govern a different launch in the same
   * tree.
   */
  function resolvePlanGateFor(
    sessionId: string | null | undefined,
    cwd: string | null | undefined
  ): PlanApproval | null {
    const launch = sessionId
      ? getLaunchBySession(store.db, sessionId)
      : cwd
        ? findLaunchByCwd(store.db, cwd)
        : null;
    return launch ? getPlanApprovalByLaunch(store.db, launch.id) : null;
  }

  /**
   * The plan gate as it applies to a tool call that must wait for approval
   * (ask_human) — blocks until a human approves the plan, but does NOT run the
   * acceptance criterion (an agent legitimately needs to reach a human while the
   * criterion is still failing). Returns a refusal message, or null when the
   * gate is approved / absent.
   */
  function planApprovalBlock(
    sessionId: string | null | undefined,
    cwd: string | null | undefined
  ): string | null {
    const gate = resolvePlanGateFor(sessionId, cwd);
    if (!gate || gate.status === "approved") return null;
    return gate.status === "awaiting_plan"
      ? "This launch is plan-gated: call submit_plan and get your plan approved before doing anything else."
      : "Your plan is awaiting human approval — this is paused until the plan is approved.";
  }

  /**
   * Whether `command`, run as the owner in `cwd` for `launch`, may run now: the
   * floor classifies it as the launch's own Bash call, and a hold becomes a
   * safety-floor ask on the launch's session keyed by `key` (see
   * floor/criterion.ts).
   */
  function floorOwnerCommand(input: {
    key: string;
    launch: Launch;
    cwd: string;
    command: string;
    ownerHold: boolean;
    subject?: string;
    retryHint?: string;
  }): CriterionFloorResult {
    return criterionFloorGate({
      db: store.db,
      gateId: input.key,
      launch: input.launch,
      sessionId: input.launch.sessionId,
      cwd: input.cwd,
      criterion: input.command,
      ownerHold: input.ownerHold,
      subject: input.subject,
      retryHint: input.retryHint,
      broadcast,
      personaHandles,
      notifyOwner: (id, question) => {
        const session = getSession(store.db, id);
        if (!session) return;
        void pushNotification(
          session.title || `Agent needs ${responsibleAlias(store.db, session) ?? "you"}`,
          question,
          responsibleAlias(store.db, session) ?? null
        );
      },
    });
  }

  /** Why a gate whose plan isn't approved yet refuses the ready edge, or null once it is approved (or there's no gate). */
  function unapprovedPlanRefusal(gate: PlanApproval | null): string | null {
    if (!gate || gate.status === "approved") return null;
    return gate.status === "awaiting_plan"
      ? "This launch is plan-gated: submit a plan with submit_plan and get it approved before marking the work ready."
      : "Your plan is awaiting human approval — mark_ready_for_review is blocked until the plan is approved.";
  }

  /**
   * The plan gate as it applies to the developing -> needs_review edge: the
   * change may not become review-ready until a human approved the plan AND the
   * approved, machine-checkable acceptance criterion passes in `runCwd` (falling
   * back to the gate's own worktree). Runs the criterion (best-effort; throws
   * only DrainReleasedError when the drain releases it) and caches a pass on
   * the gate so a retry doesn't re-run it; with `fresh` the cached pass is
   * ignored and the criterion runs again (and a stale pass is cleared when it
   * now fails). `retryHint` tells the worker how to retry the criterion once a
   * floor hold on it is allowed (default: mark_ready_for_review again), and
   * `unmetMessage` words the refusal from a failing criterion's output
   * (default: fix the work, then mark_ready_for_review again). Returns
   * a refusal message, or null when satisfied / un-gated. Shared by every path
   * that can reach that edge so the criterion is enforced identically no matter
   * which tool advances the ticket.
   */
  async function evaluatePlanReadyGate(
    gate: PlanApproval | null,
    runCwd: string | null | undefined,
    opts: { fresh?: boolean; retryHint?: string; unmetMessage?: (output: string) => string } = {}
  ): Promise<string | null> {
    if (!gate) return null;
    const unapproved = unapprovedPlanRefusal(gate);
    if (unapproved) return unapproved;
    if (gate.criterionMet && !opts.fresh) return null;
    const unmet = (message: string): string => {
      if (gate.criterionMet) broadcastPlan(resetCriterionMet(store.db, gate.id));
      return message;
    };
    const cwd = runCwd || gate.worktreePath;
    const criterion = gate.acceptanceCriterion?.trim();
    if (criterion) {
      // The criterion runs as the owner, outside the worker's floor, so the
      // floor classifies it first, as the worker's own Bash call.
      const launch = getLaunch(store.db, gate.launchId);
      const personaLaunch = !!launch && !!personaJobForLaunch(store.db, launch.id);
      const floored = floorOwnerCommand({
        key: gate.id,
        launch: launch ?? ({ id: gate.launchId, projectId: gate.projectId, worktreePath: gate.worktreePath } as Launch),
        cwd,
        command: criterion,
        ownerHold: personaLaunch && resolvePersonaConfig().hold.includes(HOLD_ACCEPTANCE_CRITERION),
        retryHint: opts.retryHint,
      });
      if (!floored.run) return unmet(floored.message);
    }
    // A drain kills the criterion's process group and throws DrainReleasedError
    // (503 released): nothing has changed yet, so the caller's retry runs it
    // again on the next leader.
    const { met, output: printed } = await checkAcceptanceCriterion(
      cwd,
      gate.acceptanceCriterion,
      undefined,
      scrubCredentialEnv(workerEnv()),
      drain.signal
    );
    // The refusal is shown to the worker, stored on the ticket and the run, so what the criterion printed is redacted first.
    const output = redactSecrets(printed, redactOptionsFor({ projectId: gate.projectId }));
    if (met) {
      if (!gate.criterionMet) broadcastPlan(setCriterionMet(store.db, gate.id));
      return null;
    }
    return unmet(
      opts.unmetMessage?.(output) ??
        "The approved acceptance criterion has not passed yet, so this change is " +
          "not ready for review. Fix the work until it passes, then call " +
          `mark_ready_for_review again.\n\n$ ${gate.acceptanceCriterion}\n${output}`
    );
  }

  /**
   * The plan-ready gate keyed to a TICKET's implementing launch — the single
   * enforcement point for every developing -> needs_review edge
   * (mark_ready_for_review, report_ticket_status, and the terminal-run sync
   * fired by report_task). Keying to the ticket's launch rather than the caller's
   * session ensures a plan-gated agent can't bypass the acceptance criterion by
   * advancing the same ticket through a sibling tool. It also holds the
   * launch's delivery pipeline to its code_review stage (pipelineReadyBlock). A ticket
   * with no launch (externally claimed, never dispatched by us) has no gate.
   */
  async function planReadyBlockForTicket(ticket: Ticket): Promise<string | null> {
    const gate = ticket.launchId
      ? getPlanApprovalByLaunch(store.db, ticket.launchId)
      : null;
    // A plan not yet approved is refused first, before the delivery pipeline
    // is re-checked (which may send a waived run back to coding). The run must
    // then have reached its code_review stage before the criterion runs: a run short of
    // it refuses anyway, and running the criterion here would spend an allow
    // its validation stage is waiting for.
    const unapproved = unapprovedPlanRefusal(gate);
    if (unapproved) return unapproved;
    const pipelineBlock = ticket.launchId ? await pipelineReadyBlock(store.db, ticket.launchId, pipelineDeps) : null;
    if (pipelineBlock) return pipelineBlock;
    return evaluatePlanReadyGate(gate, gate?.worktreePath);
  }

  /**
   * The orchestration-enforcement analog of planReadyBlockForTicket, wired at the
   * SAME developing -> needs_review choke sites: a PURE, synchronous state check
   * that returns a refusal message when a ticket governed by an orchestration
   * profile has not cleared its bounded develop -> deploy -> review loop, else
   * null (pass-through).
   *
   * It NEVER runs the loop — that is the slow, async runOrchestrationForTicket
   * (kicked off by POST /api/orchestration/runs); this only READS the ledger that
   * loop writes, so it is safe on the sync HTTP path. The rule: if a run exists
   * for this ticket it must be `succeeded` to allow the transition; if no run has
   * been kicked off yet but a project/global profile is active, the transition is
   * blocked until one is started and succeeds. (A personal-scope-only default
   * with no run yet is not caught here — the ticket carries no alias to resolve
   * it — but is enforced the moment its run is kicked off.)
   */
  const orchestrationReadyBlockForTicket = (ticket: Ticket): string | null =>
    orchestrationReadyBlock(store.db, ticket);

  /**
   * Records retrieval-usage rows without ever throwing into the read path.
   * Telemetry is a soft signal for ranking/staleness (#4/#5), not a
   * correctness dependency — a search or doc read must return even if the
   * write fails (a locked DB, a schema drift), so the insert is swallowed and
   * logged rather than propagated.
   */
  /**
   * Per-doc retrieval usage the caller may see. A personal-layer row is kept
   * only for its recorded owner (the store's viewer filter); a row whose doc
   * still exists must also pass the caller's browse audience, which covers
   * rows recorded before the layer was; and a row for a deleted home
   * CLAUDE.md / rules mirror with no recorded layer is left out, since its
   * owner is unknown.
   */
  function visibleRetrievalUsage(c: Context, projectId: string | undefined): KnowledgeRetrievalUsage[] {
    const browse = resolveBrowseAudience(c, projectId ?? GLOBAL_PROJECT_ID);
    return getRetrievalUsage(store.db, projectId, { viewer: scopingUser(c) ?? null }).filter((u) => {
      const doc = knowledgeStore.getDoc(u.docProject, u.docSlug);
      if (doc) return isDocInAudience(doc, browse);
      return u.layer === "personal" || !u.docSlug.startsWith(NATIVE_MEMORY_HOME_SLUG_PREFIX);
    });
  }

  /** The dead-doc / hub view over the caller's browsable docs (see knowledgeUsageHealth). */
  function retrievalUsageHealth(
    c: Context,
    projectId: string | undefined,
    usage: KnowledgeRetrievalUsage[],
    windowDaysParam: string | undefined
  ): KnowledgeUsageHealth {
    const browse = resolveBrowseAudience(c, projectId ?? GLOBAL_PROJECT_ID);
    const corpus = knowledgeStore.getAllDocs();
    const windowDays = Number(windowDaysParam);
    return knowledgeUsageHealth({
      docs: corpus.filter((d) => (!projectId || d.projectId === projectId) && isDocInAudience(d, browse)),
      usage,
      corpusKeys: new Set(corpus.map((d) => `${d.projectId}/${d.slug}`)),
      ...(Number.isFinite(windowDays) && windowDays > 0 ? { windowDays } : {}),
    });
  }

  function recordRetrievalsBestEffort(records: RetrievalRecord[], requester: string | undefined): void {
    try {
      recordKnowledgeRetrievals(store.db, records, requester);
    } catch (err) {
      console.error("[knowledge] failed to record retrieval usage:", err);
    }
  }

  app.post("/api/checkpoint", async (c) => {
    const { session_id, cwd, summary } = await c.req.json<{
      session_id?: string;
      cwd: string;
      summary: string;
    }>();

    // A checkpoint with no summary is meaningless and, worse, hits a NOT NULL
    // constraint that surfaces as a 500 SQLite crash rather than a usable
    // error. Reject it cleanly so the agent gets told what went wrong.
    if (!summary?.trim()) {
      return c.json({ error: "summary is required" }, 400);
    }

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const checkpoint = createCheckpoint(store.db, session.id, "self-reported", summary.trim());

    broadcast({
      type: "checkpoint:new",
      payload: checkpoint,
      timestamp: new Date().toISOString(),
    });

    // A checkpoint marks a completed unit of work — the other turn boundary
    // the design nominates for delivery, and the one that reaches an agent
    // mid-task that isn't waiting on a new user prompt. Both the human's steers
    // and any teammate-agent messages queued for it drain here and ride back on
    // the response together.
    const pendingSteer = takeSteerContext(store.db, session.id);
    const pendingMail = takeMailboxContext(store.db, session.id);

    for (const steer of pendingSteer?.steers ?? []) broadcastSteerDelivered(broadcast, steer);
    for (const message of pendingMail?.messages ?? []) {
      broadcast({
        type: "session:message",
        payload: message,
        timestamp: new Date().toISOString(),
      });
    }

    const blocks = [pendingSteer?.text, pendingMail?.text].filter(
      (t): t is string => !!t
    );
    if (blocks.length > 0) {
      console.log(
        `[coordination] Delivered ${pendingSteer?.steers.length ?? 0} steer(s) + ` +
          `${pendingMail?.messages.length ?? 0} message(s) to ${session.id} at checkpoint`
      );
      // A message reached the worker mid-turn, with no prompt: a park ends
      // here — unless it was already queued when the park was set.
      pipelineMessageDelivered(
        store.db,
        session.id,
        { broadcast },
        {
          messageIds: [...(pendingSteer?.steers ?? []).map((s) => s.id), ...(pendingMail?.messages ?? []).map((m) => m.id)],
        }
      );
      // Reuses the `steers` response field so the MCP checkpoint handler surfaces
      // the combined block back to the agent unchanged.
      return c.json({ ok: true, steers: blocks.join("\n\n") });
    }

    return c.json({ ok: true });
  });

  // A launched agent reports its own run's lifecycle. `running` is idempotent —
  // a re-report of the current state just heartbeats — so the agent can call it
  // to say "still going" without tripping the no-self-loop transition guard.
  // `succeeded`/`failed` are terminal.
  app.post("/api/report-task", async (c) => {
    const { session_id, cwd, status, summary } = await c.req.json<{
      session_id?: string;
      cwd: string;
      status?: string;
      summary?: string;
    }>();

    if (status !== "running" && status !== "succeeded" && status !== "failed") {
      return c.json(
        { error: `status must be one of running, succeeded, failed (got ${status})` },
        400
      );
    }

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const run = getActiveTaskRunBySession(store.db, session.id);
    if (!run) {
      return c.json(
        { error: "No active task run for this session — it may already be finished, or this session wasn't launched by the console." },
        404
      );
    }

    try {
      const updated =
        status === "running" && run.status === "running"
          ? heartbeatTaskRun(store.db, run.id)
          : updateTaskRunStatus(store.db, run.id, status, {
              summary,
              // Surface the reason on the ledger card when a run fails.
              error: status === "failed" ? summary : undefined,
            });
      // Push the run's new state to the dispatchable board so its liveness and
      // terminal status update without a poll.
      broadcast({
        type: "task:updated",
        payload: updated,
        timestamp: new Date().toISOString(),
      });
      // Sync a terminal run back to the ticket it was implementing: success
      // advances a developing ticket to needs_review through the gated
      // advanceTicketToReview (which broadcasts + runs the review gate itself);
      // a failure only stamps the reason on the card, which we broadcast here. A
      // heartbeat (running) changes nothing on the ticket.
      if (updated.status === "succeeded" || updated.status === "failed") {
        // The run reported its own terminal state — a substantive session
        // signal the feed must show. Self-reported so it attributes to the
        // project (the agent stated it), not to System.
        const reason = summary?.trim();
        emitTerminalCheckpoint(
          session.id,
          "self-reported",
          updated.status === "succeeded"
            ? `✓ Succeeded${reason ? ` — ${reason}` : ""}`
            : `✗ Failed${reason ? ` — ${reason}` : ""}`
        );
        // A succeeded run on a plan-gated ticket must still clear the acceptance-
        // criterion gate — otherwise report_task({succeeded}) is a sibling that
        // bypasses the gate mark_ready_for_review enforces. When the gate
        // blocks, don't advance the ticket; stamp the criterion output as the
        // ticket error so a human sees why review is refused.
        const linkedTicket =
          updated.status === "succeeded"
            ? getTicketBySession(store.db, session.id)
            : null;
        // The run's state is already recorded, so a criterion run the drain
        // releases is not answered with a retryable 503 (a re-sent report
        // would be a repeat terminal transition); the ticket stays developing
        // with the reason on its card instead.
        const gateBlock =
          linkedTicket && linkedTicket.status === "developing"
            ? (await planReadyBlockForTicket(linkedTicket).catch((err: unknown) => {
                if (err instanceof DrainReleasedError) {
                  return (
                    "The acceptance criterion was interrupted by a Standup restart before it finished, " +
                    "so this ticket was not moved to review. Call mark_ready_for_review to run it again."
                  );
                }
                throw err;
              })) ??
              orchestrationReadyBlockForTicket(linkedTicket)
            : null;
        if (gateBlock && linkedTicket) {
          setTicketError(store.db, linkedTicket.id, gateBlock);
          broadcastTicket(getTicket(store.db, linkedTicket.id)!);
        } else {
          const ticket = syncTicketForTerminalRun(store.db, updated, (t, readyReason) =>
            advanceTicketToReview(t, { readyReason })
          );
          if (ticket && ticket.status !== "needs_review") broadcastTicket(ticket);
        }
      }
      return c.json({ ok: true, taskRun: updated });
    } catch (err) {
      if (err instanceof TaskRunTransitionError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // Liveness ping from a launched agent — distinguishes "working quietly" from
  // "dead pane" so the reconciliation sweep doesn't call a slow-but-alive run
  // lost. Bumps last_event_at without changing status.
  app.post("/api/heartbeat", async (c) => {
    const { session_id, cwd } = await c.req.json<{
      session_id?: string;
      cwd: string;
    }>();

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const run = getActiveTaskRunBySession(store.db, session.id);
    if (!run) {
      return c.json({ ok: false, error: "No active task run for this session." }, 404);
    }

    const beat = heartbeatTaskRun(store.db, run.id);
    // A heartbeat only bumps the liveness clock, but the board shows
    // last-activity age off it, so push the refreshed row.
    broadcast({
      type: "task:updated",
      payload: beat,
      timestamp: new Date().toISOString(),
    });
    return c.json({ ok: true });
  });

  /**
   * A caller's ask request id, bounded; undefined when absent, not a string,
   * or in the range reserved for permission asks tied to a call.
   */
  const askRequestId = (raw: unknown): string | undefined =>
    typeof raw === "string" &&
    raw.trim() &&
    !raw.trim().startsWith(PERMISSION_REQUEST_PREFIX) &&
    !raw.trim().startsWith(PERMISSION_ANY_REQUEST_PREFIX)
      ? raw.trim().slice(0, 200)
      : undefined;

  /**
   * Waits on an ask a re-sent call re-attached to: an answered ask returns its
   * answer at once, a settled-unanswered one reads as a timeout, a pending one
   * is waited on again for the caller's timeout.
   */
  const reattachAsk = async (
    askId: string,
    timeoutS: number | undefined
  ): Promise<{ answer: string; timed_out?: boolean }> => {
    const result = await waitForAskResolution(store.db, askId, timeoutS);
    return result.timedOut ? { answer: "", timed_out: true } : { answer: result.answer };
  };

  app.post("/api/ask", async (c) => {
    const { session_id, cwd, question, options, timeout_s, request_id } = await c.req.json<{
      session_id?: string;
      cwd: string;
      question: string;
      options?: string[];
      timeout_s?: number;
      request_id?: string;
    }>();

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    // A waiter whose connection dropped (the collector restarted, the network
    // blipped) re-sends its call with the same request_id: it re-attaches to
    // the ask it already raised — reading the answer given meanwhile, or
    // waiting on it again — rather than raising a second one.
    const requestId = askRequestId(request_id);
    const existing = requestId ? getAskByRequestId(store.db, session.id, requestId) : null;
    if (existing && (existing.kind !== "ask_human" || existing.gate)) {
      return c.json({ error: "request_id names an ask this route did not raise" }, 409);
    }
    if (existing) {
      persona.restart?.noteReattached(existing.id);
      return c.json(await reattachAsk(existing.id, timeout_s));
    }

    // Plan-gate: a gated launch must have its plan approved before the agent may
    // escalate to a human. (The acceptance criterion is NOT enforced here — the
    // agent may legitimately need help while it's still failing.)
    const gateBlock = planApprovalBlock(session_id, cwd);
    if (gateBlock) return c.json({ error: gateBlock }, 409);

    const ask = createAsk(store.db, session.id, "ask_human", question, options, { requestId });

    updateSessionStatus(store.db, session.id, "waiting");
    broadcast({
      type: "ask:new",
      payload: ask,
      timestamp: new Date().toISOString(),
    });
    broadcast({
      type: "session:status",
      payload: { sessionId: session.id, status: "waiting" },
      timestamp: new Date().toISOString(),
    });

    // Persona answers its own workers' questions and pushes the owner itself
    // when it escalates one.
    if (!personaHandles(session.id)) {
      void pushNotification(
        session.title || `Agent needs ${responsibleAlias(store.db, session) ?? "you"}`,
        question,
        responsibleAlias(store.db, session) ?? null
      );
    }

    // Block the MCP tool call until answered or timed out.
    const result = await waitForAskResolution(store.db, ask.id, timeout_s);

    if (result.timedOut) {
      return c.json({ answer: "", timed_out: true });
    }

    return c.json({ answer: result.answer });
  });

  // propose_standup_improvement — the self-improvement loop. An agent proposes a
  // fix to Standup ITSELF; this surfaces it to the human as a confirmation ask
  // and BLOCKS (reusing the ask_human waiter). Only on approval does it launch a
  // Claude session against the launchable "self" project (the Standup repo), so
  // it can never start a self-fix without a human's yes. Declined / dismissed /
  // timed-out proposals launch nothing.
  /** The settings key recording the launch a self-fix confirmation released. */
  const improveLaunchKey = (askId: string) => `standup-improve-launch:${askId}`;
  /** The launch idempotency key of a self-fix confirmation; createLaunch's UNIQUE index backs it. */
  const improveIdempotencyKey = (askId: string) => `improve:${askId}`;
  /** Tells this server's in-progress claims from those a previous collector process left behind. */
  const improveClaimOwner = randomUUID();

  type ImproveLaunch = { projectId: string; launch: { id: string } };
  type ImproveClaim =
    | { kind: "claimed" }
    | { kind: "launched"; record: ImproveLaunch }
    | { kind: "busy" };

  /** The launch stamped with `askId`'s idempotency key, if any, recorded as the launch it released. */
  const stampedImproveLaunch = (askId: string): ImproveLaunch | null => {
    const stamped = getLaunchByIdempotencyKey(store.db, improveIdempotencyKey(askId));
    if (!stamped) return null;
    const record = { projectId: stamped.projectId, launch: { id: stamped.id } };
    setSetting(store.db, improveLaunchKey(askId), JSON.stringify(record));
    return record;
  };

  /**
   * Claims the right to launch the self-fix `askId` released, before launchFn
   * runs. A launch row stamped with the confirmation's idempotency key is that
   * launch, whoever made it. Otherwise the settings row is inserted only if
   * absent (INSERT OR IGNORE), so of concurrent handlers exactly one
   * launches. A row that already records a launch is that launch. A claim
   * this server holds is a launch in flight here (busy); a claim left by an
   * earlier collector process with no stamped launch is taken over
   * (compare-and-set), since that process died before launching.
   */
  const claimImproveLaunch = (askId: string): ImproveClaim => {
    const key = improveLaunchKey(askId);
    const stamped = stampedImproveLaunch(askId);
    if (stamped) return { kind: "launched", record: stamped };
    const claim = JSON.stringify({ claim: improveClaimOwner });
    if (store.db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, claim]).changes > 0) {
      return { kind: "claimed" };
    }
    const stored = getSetting(store.db, key) ?? "";
    let parsed: { claim?: unknown; launch?: { id?: unknown }; projectId?: unknown } = {};
    try {
      parsed = JSON.parse(stored);
    } catch {
      // An unreadable row is a stale claim.
    }
    if (typeof parsed.launch?.id === "string") {
      return { kind: "launched", record: { projectId: String(parsed.projectId ?? ""), launch: { id: parsed.launch.id } } };
    }
    if (parsed.claim === improveClaimOwner) return { kind: "busy" };
    const taken = store.db.run("UPDATE settings SET value = ? WHERE key = ? AND value = ?", [claim, key, stored]).changes > 0;
    return taken ? { kind: "claimed" } : { kind: "busy" };
  };

  app.post("/api/standup/improve", async (c) => {
    const { session_id, cwd, title, description, kind, request_id } = await c.req.json<{
      session_id?: string;
      cwd: string;
      title?: string;
      description?: string;
      kind?: string;
      request_id?: string;
    }>();

    if (!title?.trim()) return c.json({ error: "title is required" }, 400);
    if (!description?.trim()) return c.json({ error: "description is required" }, 400);
    if (!kind || !(STANDUP_IMPROVEMENT_KINDS as readonly string[]).includes(kind)) {
      return c.json(
        { error: `kind must be one of ${STANDUP_IMPROVEMENT_KINDS.join(", ")}` },
        400
      );
    }

    // A self-fix launches repo-modifying agent work — at least as sensitive as a
    // profile write — so it requires the out-of-band write token on a shared/
    // multiplayer or network-exposed collector (a single-user loopback dev box is
    // trusted, matching isTrustedProfileWrite). Prevents a reachable client on a
    // shared collector from proposing (and, by also resolving the ask, forging
    // approval of) a launch.
    if (
      !isTrustedProfileWrite(
        c.req.header(config.userIdentifier.header),
        undefined,
        c.req.header("x-standup-write-token"),
        undefined,
        isMultiplayerMode(store.db)
      )
    ) {
      return c.json(
        {
          error:
            "firing a Standup self-fix on a shared/multiplayer or network-exposed collector requires " +
            "the out-of-band write token (x-standup-write-token matching STANDUP_WRITE_TOKEN)",
        },
        403
      );
    }

    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    const kindLabel =
      kind === "bug" ? "bug" : kind === "kb-gap" ? "knowledge gap" : "feature";
    const APPROVE = STANDUP_IMPROVEMENT_APPROVE;
    const DECLINE = "Not now";
    const question =
      `Standup self-improvement proposed (${kindLabel}): ${title.trim()}\n\n` +
      `${description.trim()}\n\n` +
      `Fire a Claude session against the Standup repo to work this fix?`;

    // Confirmation gate: a real ask_human waiter the human resolves from the
    // console (or Slack). Nothing is launched until it resolves affirmatively.
    // Marked as a confirmation gate so a delegate allowed to answer the
    // session's ordinary questions (Persona) holds it for the human instead.
    // A re-sent call (its connection dropped, e.g. across a collector restart)
    // carries the same request_id and re-attaches to the confirmation it
    // already raised; a launch that call already made is returned, not redone.
    const requestId = askRequestId(request_id);
    const existing = requestId ? getAskByRequestId(store.db, session.id, requestId) : null;
    // Only the confirmation this route raised can release a launch.
    if (existing && existing.gate !== STANDUP_IMPROVEMENT_GATE) {
      return c.json({ error: "request_id names an ask this route did not raise" }, 409);
    }
    // A re-sent call re-attaches only with the proposal it first made: the
    // owner confirmed that text, and a launch is built from this call's.
    if (existing && existing.question !== question) {
      return c.json({ error: "request_id names a different self-fix proposal" }, 409);
    }
    if (existing) {
      persona.restart?.noteReattached(existing.id);
      const launchedBefore = getSetting(store.db, improveLaunchKey(existing.id));
      if (launchedBefore) {
        try {
          const record = JSON.parse(launchedBefore) as Partial<ImproveLaunch>;
          if (typeof record.launch?.id === "string") {
            return c.json({ launched: true, status: "launched", askId: existing.id, projectId: record.projectId, launch: record.launch });
          }
        } catch {
          // An unreadable record is treated as no launch yet.
        }
      }
    }
    const ask =
      existing ??
      createAsk(store.db, session.id, "ask_human", question, [APPROVE, DECLINE], {
        gate: STANDUP_IMPROVEMENT_GATE,
        requestId,
      });
    if (!existing) {
      updateSessionStatus(store.db, session.id, "waiting");
      broadcast({
        type: "ask:new",
        payload: ask,
        timestamp: new Date().toISOString(),
      });
      broadcast({
        type: "session:status",
        payload: { sessionId: session.id, status: "waiting" },
        timestamp: new Date().toISOString(),
      });
      void pushNotification(
        session.title || `Standup self-fix proposed`,
        `${title.trim()} — ${kindLabel}`,
        responsibleAlias(store.db, session) ?? null
      );
    }

    const result = await waitForAskResolution(store.db, ask.id);

    if (result.timedOut) {
      return c.json({ launched: false, status: "timeout", askId: ask.id });
    }
    if (!isProposalApproval(result.answer, APPROVE)) {
      return c.json({
        launched: false,
        status: "declined",
        askId: ask.id,
        answer: result.answer,
      });
    }

    // Approved — dogfood: launch a fix session against the Standup repo itself,
    // reusing the same launch path every other launch uses (via the injectable
    // seam, so a test can mock it). One confirmation releases one launch:
    // the launch is claimed first and carries the confirmation's idempotency
    // key, so neither concurrent handlers nor a collector restart mid-launch
    // can launch it twice.
    const claim = claimImproveLaunch(ask.id);
    if (claim.kind === "launched") {
      return c.json({ launched: true, status: "launched", askId: ask.id, ...claim.record });
    }
    if (claim.kind === "busy") {
      // A 5xx, so the caller's MCP re-sends the call and gets the launch once it exists.
      return c.json({ error: "this self-fix's launch is already in progress; re-send the call to get it" }, 503);
    }
    const project = ensureStandupSelfProject();
    try {
      const launched = await launchFn(
        store.db,
        {
          project,
          task: buildStandupImprovementTask({
            title: title.trim(),
            description: description.trim(),
            kind,
            requester: actingAlias(c),
          }),
          label: `Standup self-fix: ${title.trim()}`,
          requester: actingAlias(c),
          launchedBy: scopingUser(c),
          // Never edit the collector's own checkout in place — provision a fresh
          // worktree so the self-fix can't disturb the running Standup dev tree.
          inPlace: false,
          idempotencyKey: improveIdempotencyKey(ask.id),
        },
        broadcastLaunch,
        { embeddingProvider, embeddingConfig }
      );
      setSetting(
        store.db,
        improveLaunchKey(ask.id),
        JSON.stringify({ projectId: project.id, launch: { id: launched.launch.id } })
      );
      return c.json({
        launched: true,
        status: "launched",
        askId: ask.id,
        projectId: project.id,
        launch: launched.launch,
      });
    } catch (err) {
      // A launch row stamped with the key exists (this call raced one that
      // got there first): that is the launch.
      const stamped = stampedImproveLaunch(ask.id);
      if (stamped) return c.json({ launched: true, status: "launched", askId: ask.id, ...stamped });
      // The proposal was approved but the launch couldn't start (misconfig
      // caught before a launch row exists) — surface it as a tool error, and
      // drop the claim so a re-sent call can try again.
      store.db.run("DELETE FROM settings WHERE key = ?", [improveLaunchKey(ask.id)]);
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  const relevanceCalibration = () => {
    const { status, low, high } = calibrationStatus(store.db);
    return { status, low, high };
  };

  app.post("/api/knowledge/search", async (c) => {
    const searchStartedAt = performance.now();
    const {
      session_id,
      cwd,
      query,
      project,
      corpus,
      owner,
      scoped,
      excludeUserScope,
      includePersonal,
      includeActivity,
      excludeActivity,
      lowConfidence,
      includeSuperseded,
      as_of,
    } = await c.req.json<{
      session_id?: string;
      cwd: string;
      query: string;
      project?: string;
      corpus?: "project" | "all";
      // Permissive browse filter: restrict to these owners' docs ("my
      // knowledge"). A string or array; does NOT engage the injection gate.
      owner?: string | string[];
      // When true, apply the STRICT scope gate (global ∪ project ∪ requesting
      // user) — the agent path (MCP search_knowledge) sets it. Omitted/false is
      // the human-browse path that recalls across every scope, short of other
      // users' personal layer.
      scoped?: boolean;
      // With `scoped`, narrows the gate to global ∪ project and drops the
      // native-memory mirrors: Persona answering in a thread other people read
      // never recalls the owner's personal docs or ~/.claude config. It can
      // only narrow, so a caller gains nothing by forging it.
      excludeUserScope?: boolean;
      // With `scoped`, whether the personal layer (scope=user docs, home
      // CLAUDE.md / rules mirrors) may be returned. See the default below.
      includePersonal?: boolean;
      // With `scoped`, whether the activity layer (auto-memory session notes
      // and diaries) may be returned. On unless `excludeActivity` is true or
      // `includeActivity` is false.
      includeActivity?: boolean;
      excludeActivity?: boolean;
      // With `scoped`, how many hits below the confidence floor to return as
      // `lowConfidence`, after the confident ones. Default 0: an agent's search
      // that matches nothing confidently gets nothing.
      lowConfidence?: number;
      // Without `scoped`, also return superseded docs (marked by their
      // verdict) — the browse UI's opt-in. Ignored on the agent path, which
      // never receives a superseded doc.
      includeSuperseded?: boolean;
      // An ISO-8601 instant: search the corpus as it stood then, closed
      // history versions included (SearchOptions.asOf). Omitted = valid now.
      as_of?: string;
    }>();
    const asOfParsed = parseAsOf(as_of);
    if (!asOfParsed.ok) return c.json({ error: asOfParsed.error }, 400);

    // Resolve the calling session for retrieval attribution even when an
    // explicit project was passed (the Knowledge tab passes one and has no
    // session, which correctly leaves the correlation null). Missing session
    // correlation degrades to "scratch" rather than failing outright — this is
    // a read-only convenience tool, not worth blocking on.
    const session = resolveCallingSession(session_id, cwd);
    const { projectId, warning: projectWarning } = resolveCallingProject(session, cwd, project);

    // Default corpus spans every project (favoring the current one via the
    // ranking multiplier), so reconcile ALL projects, not just this one —
    // otherwise a sibling project's new docs wouldn't be recalled. "project"
    // only needs the current one and its related projects.
    const relatedIds = relatedProjects(projectId, getProjects(store.db));
    await knowledgeSync?.syncDirty(corpus === "project" ? [projectId, ...relatedIds] : undefined);

    // The strict scope gate (agent path) resolves the requesting user
    // server-side — never from a forgeable body field — and falls back to
    // global ∪ project when the identity can't be trusted. The owner filter is
    // the permissive browse knob and stays independent of the gate.
    const owners = owner === undefined ? undefined : Array.isArray(owner) ? owner : [owner];
    // A scoped search leaves the personal layer out of its results unless the
    // caller asks for its own personal context: an explicit `owner` filter (the
    // gate already limits user-scoped docs to the caller's own), a search of the
    // reserved global project (the owner's cross-project view, which Persona's
    // recall posts), or `includePersonal`. The scope gate still decides whose
    // personal docs those are — only ever the resolved caller's.
    // The activity layer (session diaries, dated notes) is returned, marked
    // with its date, unless the caller opts out with `excludeActivity` (or
    // `includeActivity: false`); launch injection never carries it.
    const personalAllowed =
      excludeUserScope !== true &&
      (includePersonal ?? ((owners?.length ?? 0) > 0 || projectId === GLOBAL_PROJECT_ID));
    const excludeLayers: Layer[] = [
      ...(personalAllowed ? [] : ["personal" as const]),
      ...(excludeActivity === true || includeActivity === false ? ["activity" as const] : []),
    ];
    // The unscoped browse search recalls across every scope and owner but
    // never another user's personal layer.
    // An agent's scoped search also admits its related projects' project-scoped
    // docs (relatedProjects), the restricted excludeUserScope search included.
    const audience: ScopeAudience = scoped
      ? {
          ...(excludeUserScope === true
            ? { projectId, relatedProjectIds: relatedIds }
            : { ...resolveAgentAudience(c, projectId), relatedProjectIds: relatedIds }),
          ...(excludeLayers.length > 0 ? { excludeLayers } : {}),
        }
      : resolveBrowseAudience(c, projectId);

    // A restricted (excludeUserScope) search also drops every native-memory
    // mirror, the repo CLAUDE.md / rules and typed project notes included: a
    // thread other people read gets curated knowledge only. A wider window
    // keeps the result count after the drop.
    // The agent path returns only confident matches: a search whose best hit
    // is merely the best of a weak batch answers "no confident match" rather
    // than handing the agent noise to read as an answer. The floor is applied
    // before the result limit, and up to `lowConfidence` hits below it ride
    // after the confident ones when the caller asks for them. The human-browse
    // path returns everything, each hit flagged.
    const restricted = scoped === true && excludeUserScope === true;
    const lowConfidenceLimit = Number.isFinite(lowConfidence) ? Math.max(0, Math.floor(lowConfidence!)) : 0;
    // A corpus:"project" search of a project (and its related projects) this
    // audience can retrieve nothing from searches every project instead and says
    // so: an empty project corpus would otherwise answer "no confident match"
    // as if the project's knowledge did not cover the question. A mirror
    // project's corpus includes its canonical project, as the search reads it
    // (mirrorAliasedAudience), so a standup-self search with standup docs to
    // find stays on its own corpus.
    let searchedCorpus: "project" | "all" = corpus === "project" ? "project" : "all";
    let corpusFallback: string | undefined;
    const corpusAudience = mirrorAliasedAudience(audience, projectId, MIRROR_PROJECTS) ?? audience;
    const mirrorCanonical = corpusAudience === audience ? undefined : MIRROR_PROJECTS[projectId];
    const corpusProjects = [projectId, ...relatedIds, ...(mirrorCanonical ? [mirrorCanonical] : [])];
    if (searchedCorpus === "project" && !hasSearchableDocs(corpusAudience, corpusProjects, owners)) {
      await knowledgeSync?.syncDirty();
      searchedCorpus = "all";
      corpusFallback = `${projectId} has no knowledge docs; searched all projects instead.`;
    }
    const searched = await knowledgeBackend.search(projectId, query, {
      corpus: searchedCorpus,
      audience,
      owners,
      mirrorProjects: MIRROR_PROJECTS,
      ...(restricted ? { limit: 15 } : {}),
      ...(scoped ? { confidentFor: "search" as const, lowConfidenceLimit } : {}),
      ...(!scoped && includeSuperseded === true ? { includeSuperseded: true } : {}),
      ...(asOfParsed.asOf ? { asOf: asOfParsed.asOf } : {}),
    });
    const results = restricted ? searched.filter((r) => !isNativeMemoryDoc(r)) : searched;
    const nativeMemoryGated: GatedCandidate<(typeof searched)[number]>[] = restricted
      ? searched.filter((r) => isNativeMemoryDoc(r)).map((r) => ({ hit: r, reason: "native-memory" as const }))
      : [];

    // Annotate each result with its verification state so the agent-facing
    // search_knowledge tool is not blind to disputes (roadmap r5 review). The
    // knowledge-first steering names search_knowledge as a first-class step, so
    // a doc the re-verification pass REFUTED against current code must not reach
    // that agent as authoritative and indistinguishable from an affirmed doc.
    // Unlike launch injection, search does not filter on trust — it recalls every
    // origin_class — but it carries the current (decayed) confidence, the
    // re-verification verdict, and a single injectionEligible flag (trust +
    // freshness + coherence) the MCP formatter turns into a visible marker. The
    // freshness gate's recovery-path signal is resolved per the OWNING project
    // (projectReverifyOperational — its repo resolves here and it has not opted
    // out) so a cross-project hit is judged by its own cron: decay only gates
    // out a doc the cron will re-verify and lift back. A doc that decayed below
    // the floor where nothing will re-verify it stays injectable but is moved
    // after fresher hits from its own project (demoteStale) and marked with the
    // date it went stale.
    const freshness = freshnessGate(store.db);
    const annotatedInRankOrder = results.map((r) => {
      // A closed history version (an as_of hit carries validTo) is not the
      // stored doc of its slug, so it takes none of that doc's state.
      const stored = r.validTo ? null : knowledgeStore.getDoc(r.projectId, r.slug);
      // The launcher's own trust gates, so the flag says whether launch
      // injection would admit the doc (a disputed doc is admitted, marked). A
      // closed history version is never injected: it is no longer current.
      const injectionEligible = !r.validTo && injectionGateReason(r, freshness) === null;
      // A doc whose not-merged claims have landed is marked as such rather than
      // dated stale: its merge-status wording is what is out of date.
      const landedRec = stored ? landedClaimFor(store.db, stored) : undefined;
      const staleSince = landedRec ? undefined : injectionStaleSince(r, freshness)?.slice(0, 10);
      // An activity note records a moment, so it carries the date it was
      // written for the reader to weigh it by.
      const layer = layerOf(stored ?? r);
      const activityDate =
        layer === "activity" ? (stored?.generatedAt ?? stored?.updatedAt.toISOString())?.slice(0, 10) : undefined;
      return {
        ...r,
        currentConfidence: freshness.currentConfidence(r),
        verdict: stored?.verdict,
        injectionEligible,
        // An agent doc no fact-check has passed yet reads as unverified.
        ...(r.originClass === "agent" && !r.lastVerifiedAt ? { verification: "pending" as const } : {}),
        confident: isConfident(r, "search"),
        layer,
        ...(activityDate ? { activityDate } : {}),
        ...(staleSince ? { staleSince } : {}),
        ...(landedRec ? { landed: landedClaimMarker(landedRec) } : {}),
      };
    });
    // A hit naming files or symbols that are gone from its project's HEAD code
    // index carries them (the MCP formatter turns them into a marker) and moves
    // down a little (MISSING_MENTION_DEMOTION) past hits that name none.
    const missingByDoc = missingMentionsFor(knowledgeStore, annotatedInRankOrder);
    const annotated = demoteMissingMentions(
      demoteStale(annotatedInRankOrder, (r) => injectionStaleSince(r, freshness)).map((r) => {
        const missingMentions = missingByDoc.get(r.id);
        return missingMentions ? { ...r, missingMentions } : r;
      }),
      (r) => "missingMentions" in r
    );

    const confidentResults = scoped ? annotated.filter((r) => r.confident).slice(0, 5) : annotated;
    const lowConfidenceResults = scoped ? annotated.filter((r) => !r.confident).slice(0, lowConfidenceLimit) : [];
    const returned = [...confidentResults, ...lowConfidenceResults];
    // What the agent path held back, for telemetry: the native-memory mirrors a
    // restricted search drops, the confident hits past the result limit, and
    // the hits below the floor beyond the requested `lowConfidence` count.
    const returnedSet = new Set<(typeof annotated)[number]>(returned);
    const searchGated: GatedCandidate<(typeof searched)[number]>[] = [
      ...nativeMemoryGated,
      ...annotated
        .filter((r) => !returnedSet.has(r))
        .map((r) => ({ hit: r, reason: r.confident ? ("cutoff" as const) : ("floor" as const) })),
    ];

    // Retrieval-usage telemetry — record which docs this query surfaced so
    // ranking and staleness prioritization have a signal. Best-effort: a
    // logging failure must never fail the search it is observing.
    const placementOf = placementsFor(store.db, [...results, ...searchGated.map((g) => g.hit)]);
    const searchPlacement = (r: { projectId: string; slug: string }) => placementOf(r.projectId, r.slug);
    const searchBase = {
      query,
      surface: "search" as const,
      sessionId: session?.id,
      queryProject: projectId,
      latencyMs: performance.now() - searchStartedAt,
    };
    recordRetrievalsBestEffort(
      [
        ...returned.map((r, rank) => ({
          ...searchBase,
          docProject: r.projectId,
          docSlug: r.slug,
          rank,
          ...hitRecordFields(r, searchPlacement(r), hostUserAlias()),
        })),
        ...gatedRecords(searchGated, searchBase, searchPlacement, hostUserAlias()),
      ],
      audience.user
    );

    // A search that recalled nothing says whether the corpus it searched holds
    // no doc this audience can retrieve, so "no match" is not read as "nothing
    // cleared the confidence bar".
    const emptyCorpus =
      annotated.length === 0 &&
      !hasSearchableDocs(audience, searchedCorpus === "project" ? [projectId, ...relatedIds] : undefined, owners);

    // External retrievers (knowledge-federation): only for a project that opted
    // in, never a Standup-internal or reserved one or a restricted search. Their
    // hits are fused with the returned local results by rank and labeled with
    // their source; nothing is ingested, and each source is bounded by its own
    // budget. Undefined (the response unchanged) when the search does not federate.
    const federation = await federateSearch({
      query,
      projectId,
      localIds: confidentResults.map((r) => r.id),
      reserved: getProject(store.db, projectId)?.reserved === true,
      restricted,
    });

    return c.json({
      ...(federation ?? {}),
      results: confidentResults,
      ...(lowConfidenceResults.length > 0 ? { lowConfidence: lowConfidenceResults } : {}),
      ...(scoped && confidentResults.length === 0 ? { noConfidentMatch: true } : {}),
      ...(embeddingProvider ? { calibration: relevanceCalibration() } : {}),
      project: projectId,
      corpus: searchedCorpus,
      ...(corpusFallback ? { corpusFallback } : {}),
      ...(emptyCorpus ? { emptyCorpus: true } : {}),
      ...(projectWarning ? { projectWarning } : {}),
    });
  });

  // Graph neighbors of a doc (cross-project). Rebuilds the edge set lazily —
  // like search, edges are a rebuildable projection of markdown + provenance,
  // so recompiling on read keeps them current without a restart.
  app.post("/api/knowledge/neighbors", async (c) => {
    const { docId, session_id, cwd, project, scoped } = await c.req.json<{
      docId: string;
      session_id?: string;
      cwd?: string;
      project?: string;
      // When true, apply the STRICT scope gate (global ∪ project ∪ requesting
      // user) to the far-end neighbor docs — the agent path (MCP graph_neighbors)
      // sets it, exactly as search_knowledge does. Omitted/false is the
      // web-browse path (the Knowledge tab) that lists every neighbor short of
      // other users' personal layer.
      scoped?: boolean;
    }>();

    if (!docId) {
      return c.json({ error: "docId is required" }, 400);
    }

    // Reconcile every project's markdown into the store first (local-backend
    // ingest, so edits show without a restart), then recompile + read the
    // graph through the seam.
    await knowledgeSync?.syncDirty();
    knowledgeBackend.compile();

    // The strict scope gate (agent path) resolves the requesting user
    // server-side — never from a forgeable body field — and the project from the
    // calling session, then filters neighbors OUTSIDE that user's global ∪
    // project ∪ user set. Without the gate a user-scoped doc that shares a tag,
    // session, or `related` link with a doc the caller CAN see would leak its
    // slug/title/project across the scope boundary — the exact hole
    // search_knowledge is already gated against, so the pivot from it must be too.
    // The browse view applies the browse audience instead, on the far end and
    // on the doc itself: another user's personal doc has no visible neighbors.
    const session = resolveCallingSession(session_id, cwd ?? "");
    const { projectId, warning } = resolveCallingProject(session, cwd, project, "scoped neighbors to");
    // Neighbors report an unknown explicit project, not a scratch default.
    const projectWarning = project?.trim() ? warning : undefined;
    const audience = scoped ? resolveAgentReadAudience(c, projectId) : resolveBrowseAudience(c, projectId);
    const origin = knowledgeStore.getDocById(docId);
    if (!scoped && origin && !isDocInAudience(origin, audience)) {
      return c.json({ neighbors: [], ...(projectWarning ? { projectWarning } : {}) });
    }
    const neighbors = knowledgeBackend.neighbors(docId, audience);

    return c.json({ neighbors, ...(projectWarning ? { projectWarning } : {}) });
  });

  // A single knowledge doc's FULL markdown body, by stable id or by (project,
  // slug) — the complete text a search_knowledge hit only surfaces elided with
  // "…". Reconciles disk first (like search and neighbors) so a doc edited on
  // disk serves current without a restart. offset/limit page a very large body by
  // character. The agent path sets scoped:true so the strict scope gate applies
  // per-doc — this returns only a doc the caller could already retrieve, never
  // widening past what search_knowledge surfaces; omitted/false is the
  // web-browse path, which hides only other users' personal docs.
  app.post("/api/knowledge/doc", async (c) => {
    const { id, slug, session_id, cwd, project, offset, limit, scoped } = await c.req.json<{
      id?: string;
      slug?: string;
      session_id?: string;
      cwd?: string;
      project?: string;
      offset?: number;
      limit?: number;
      scoped?: boolean;
    }>();

    if (!id && !slug) {
      return c.json({ error: "Pass an id or a slug to identify the doc." }, 400);
    }

    const session = resolveCallingSession(session_id, cwd ?? "");
    const { projectId, warning: projectWarning } = resolveCallingProject(session, cwd, project, "looked in");

    // An id can name a doc in ANY project, and the scope gate spans projects
    // (global docs and the user's own docs live anywhere), so reconcile every
    // project's markdown — a stale sibling would hide or misreport the doc.
    await knowledgeSync?.syncDirty();

    // The docs the calling session's launch was briefed with (a subagent's are
    // its parent's). They were retrieved against the launch's project, which
    // the session's resolved project can differ from (a scratch session moved
    // into a project, or the reverse), so a slug is also looked up among them,
    // and each is read against its own project's audience.
    const launch = session ? getLaunchBySession(store.db, session.parentSessionId ?? session.id) : null;
    const injected = launch ? getLaunchInjectedDocs(store.db, launch.id, 50) : [];
    // A `project/slug` ref, as the brief and the knowledge pushes print them
    // (a slug never holds a `/`), names its project as `project` does.
    const cut = slug ? slug.lastIndexOf("/") : -1;
    const ref =
      slug && cut > 0
        ? { project: matchKnownProject(knownProjectIds(store.db), slug.slice(0, cut)) ?? slug.slice(0, cut), slug: slug.slice(cut + 1) }
        : null;
    const injectedMatch = slug
      ? injected.find((i) => (ref ? i.docProject === ref.project && i.docSlug === ref.slug : i.docSlug === slug))
      : undefined;
    const ownAudience = scoped ? resolveAgentReadAudience(c, projectId) : resolveBrowseAudience(c, projectId);
    // Whether the caller may read `d`: in its own project's audience, or — for
    // the doc a ref names or one its brief carried — in that doc's project's.
    const readable = (d: KnowledgeDoc): boolean =>
      isDocInAudience(d, ownAudience) ||
      (!!scoped &&
        ((ref?.project === d.projectId && ref.slug === d.slug) ||
          injected.some((i) => i.docProject === d.projectId && i.docSlug === d.slug)) &&
        isDocInAudience(d, resolveAgentReadAudience(c, d.projectId)));
    const fromRef = ref ? knowledgeStore.getDoc(ref.project, ref.slug) : null;
    const fromBrief = injectedMatch ? knowledgeStore.getDoc(injectedMatch.docProject, injectedMatch.docSlug) : null;
    const fromProject = slug && !ref ? knowledgeStore.getDoc(projectId, slug) : null;
    // A bare slug prefers the doc the brief carried unless a project was named.
    const candidates = id
      ? [knowledgeStore.getDocById(id)]
      : project?.trim()
        ? [fromProject, fromRef, fromBrief]
        : [fromRef, fromBrief, fromProject];
    const doc = candidates.find((d): d is KnowledgeDoc => !!d && readable(d)) ?? null;
    const notFound = () =>
      c.json(
        {
          error:
            (id
              ? `No knowledge doc with id "${id}".`
              : ref
                ? `No knowledge doc "${ref.slug}" in project "${ref.project}".`
                : `No knowledge doc "${slug}" in project "${projectId}".`) +
            (projectWarning ? ` ${projectWarning}` : ""),
        },
        404
      );
    // The strict scope gate (readable) resolves the requesting user server-side
    // and drops a doc outside the caller's audience — the same boundary search
    // and neighbors enforce. A blocked fetch reports "not found" rather than a
    // distinct 403, so the id of an out-of-scope doc leaks nothing beyond what
    // search already withheld.
    // The browse fetch hides only another user's personal doc.
    if (!doc) {
      return notFound();
    }

    const body = doc.body ?? "";
    const start = Math.max(0, offset ?? 0);

    // An agent's full-body read is the strongest "this doc was used" signal;
    // a paged read is counted once, at its first page.
    if (scoped && start === 0) {
      recordRetrievalsBestEffort(
        [
          {
            docProject: doc.projectId,
            docSlug: doc.slug,
            query: id ?? slug ?? "",
            rank: 0,
            surface: "doc_get",
            sessionId: session?.id,
            queryProject: projectId,
            ...hitRecordFields(doc, doc, hostUserAlias()),
          },
        ],
        ownAudience.user
      );
    }
    // A defined, non-negative limit caps the slice; limit 0 returns nothing, and
    // an absent (or negative) limit returns the rest of the body.
    const end = typeof limit === "number" && limit >= 0 ? start + limit : undefined;
    const slice = body.slice(start, end);
    const returnedLength = slice.length;

    return c.json({
      id: doc.id,
      slug: doc.slug,
      title: doc.title,
      projectId: doc.projectId,
      body: slice,
      totalLength: body.length,
      offset: start,
      returnedLength,
      hasMore: start + returnedLength < body.length,
      ...(projectWarning ? { projectWarning } : {}),
    });
  });

  // Docs about one file (MCP knowledge_for_file): docs naming the file or a
  // symbol defined in it, then docs naming a sibling file, resolved through the
  // doc→code mentions. `scoped` applies the agent read gate, as /doc does.
  // GET takes the same fields as query parameters.
  const knowledgeAboutFile = async (
    c: Context,
    input: { path?: string; project?: string; session_id?: string; cwd?: string; limit?: number; scoped?: boolean }
  ) => {
    const path = input.path?.trim();
    if (!path) return c.json({ error: "Pass the file path." }, 400);
    const session = resolveCallingSession(input.session_id, input.cwd ?? "");
    const { projectId, warning: projectWarning } = resolveCallingProject(session, input.cwd, input.project, "looked in");
    await knowledgeSync?.syncDirty([projectId]);
    const audience = input.scoped ? resolveAgentReadAudience(c, projectId) : resolveBrowseAudience(c, projectId);
    const repos = getProjects(store.db).find((p) => p.id === projectId)?.repos ?? [];
    const limit = Number.isFinite(input.limit) && input.limit! > 0 ? Math.min(Math.floor(input.limit!), 20) : undefined;
    const result = docsAboutFile(knowledgeStore, { projectId, path, audience, repos, limit });
    return c.json({
      project: projectId,
      path: result.path ?? path,
      docs: result.docs,
      ...(projectWarning ? { projectWarning } : {}),
    });
  };
  app.post("/api/knowledge/about-file", async (c) =>
    knowledgeAboutFile(
      c,
      await c.req.json<{ path?: string; project?: string; session_id?: string; cwd?: string; limit?: number; scoped?: boolean }>()
    )
  );
  app.get("/api/knowledge/about-file", (c) =>
    knowledgeAboutFile(c, {
      path: c.req.query("path"),
      project: c.req.query("project"),
      session_id: c.req.query("session_id"),
      cwd: c.req.query("cwd"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      scoped: c.req.query("scoped") === "true",
    })
  );

  // Corpus health stats for the Knowledge tab's Health panel. Reconcile
  // markdown from disk and recompile edges on read — the same currency guarantee
  // search/neighbors give — so the counts reflect what's on disk without a
  // restart. All values are simple COUNTs over the existing schema (see
  // KnowledgeStore.getStats); provider/model are the only runtime facts stamped
  // here, since the store can't know the active EmbeddingProvider.
  app.get("/api/knowledge/stats", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    await knowledgeSync?.syncDirty();
    knowledgeBackend.compile();

    const stats = knowledgeStore.getStats(projectId);
    const usage = visibleRetrievalUsage(c, projectId);
    return c.json({
      ...stats,
      // Retrieval usage lives in the collector store (not the knowledge index),
      // so it's joined here rather than inside knowledgeStore.getStats: per-doc
      // retrieval counts + last_retrieved_at for the Health panel and #4/#5.
      // Limited to what the caller may browse (visibleRetrievalUsage).
      retrievalUsage: usage,
      // Rows per layer and per drop reason, and the dead-doc / hub view.
      retrievalBreakdown: getRetrievalBreakdown(store.db, projectId, { viewer: scopingUser(c) ?? null }),
      usageHealth: retrievalUsageHealth(c, projectId, usage, c.req.query("windowDays")),
      // Corpus-wide consistency of the derived indexes (FTS, chunks, vec mirror)
      // against the doc rows — every defect count is 0 on a healthy index.
      // Reused until the corpus changes; `?integrity=fresh` forces a rescan.
      integrity: knowledgeStore.checkIndexIntegrity({ fresh: c.req.query("integrity") === "fresh" }),
      provider: embeddingProvider,
      model: embeddingProvider ? defaultModelFor(embeddingProvider) : null,
      // Which engine code search (the ripgrep tool) has on this host. "degraded"
      // means ripgrep is missing and a fallback is carrying it, which is a
      // narrower view of the tree — visible in the Health panel rather than
      // only in a log line nobody reads.
      codeSearch: detectCodeSearchBackend(),
      codeSymbols: knowledgeStore.codeSymbolStats(projectId),
      // Contradiction-judge outcomes by pair: judgeError counts pairs the judge
      // could not answer (left unjudged and queued), rejudgeQueued the docs
      // waiting to be judged again.
      // Agent docs no fact-check has passed yet (published unverified, or never
      // checked for lack of a repo).
      verification: {
        pending: (
          store.db
            .query(
              `SELECT COUNT(*) AS n FROM knowledge WHERE origin_class = 'agent' AND last_verified_at IS NULL${projectId ? " AND project_id = ?" : ""}`
            )
            .get(...(projectId ? [projectId] : [])) as { n: number }
        ).n,
      },
      // Share of docs whose verdict changed more than once in the last 30 days:
      // a measure of how noisy the fact-check and contradiction verdicts are.
      verdictFlipRate: verdictFlipRate(store.db, { projectId }),
      contradictionJudge: (() => {
        const counts = judgmentCounts(store.db, projectId);
        return {
          contradicts: counts.contradicts,
          consistent: counts.consistent,
          judgeError: counts.judge_error,
          rejudgeQueued: counts.queued,
        };
      })(),
      // The cosine band relevance is read through: measured on this corpus under
      // the current embedding fingerprint, stale, or the model defaults.
      relevanceCalibration: embeddingProvider ? relevanceCalibration() : null,
    });
  });

  // Retrieval-usage read path: per-doc retrieval counts and the last time each
  // doc was retrieved, scoped to a project when `projectId` is passed. The
  // signal ranking (#4) and staleness re-verification prioritization (#5)
  // consume; served standalone so a consumer can poll it without the fuller
  // (disk-reconciling) stats payload.
  app.get("/api/knowledge/usage", (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const usage = visibleRetrievalUsage(c, projectId);
    return c.json({
      usage,
      breakdown: getRetrievalBreakdown(store.db, projectId, { viewer: scopingUser(c) ?? null }),
      health: retrievalUsageHealth(c, projectId, usage, c.req.query("windowDays")),
    });
  });

  // The cross-project knowledge graph for the Graph visualization: nodes are
  // docs, edges come straight from knowledge_edges. Recompiled on read like
  // /neighbors so a doc edit shows without a restart. Other users' personal
  // docs are not nodes (the browse audience).
  app.get("/api/knowledge/graph", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    await knowledgeSync?.syncDirty();
    knowledgeBackend.compile();

    const graph = knowledgeStore.getGraph(projectId, resolveBrowseAudience(c, projectId ?? GLOBAL_PROJECT_ID));
    // Each node's current confidence and staleness, judged by the same
    // freshness gate search and injection use, so the graph can fade the docs
    // retrieval would distrust. The gate reads the stored confidence columns
    // from the hit, so they're fetched in one pass rather than per node.
    const freshness = freshnessGate(store.db);
    const confidenceRows = store.db
      .query("SELECT id, confidence, last_verified_at, half_life_days FROM knowledge")
      .all() as Array<{
      id: string;
      confidence: number | null;
      last_verified_at: string | null;
      half_life_days: number | null;
    }>;
    const confidenceById = new Map(confidenceRows.map((r) => [r.id, r]));
    for (const node of graph.nodes) {
      const row = confidenceById.get(node.id);
      const hit = {
        projectId: node.projectId,
        slug: node.slug,
        scope: node.scope,
        sourceKind: node.sourceKind,
        confidence: row?.confidence ?? undefined,
        lastVerifiedAt: row?.last_verified_at ?? undefined,
        halfLifeDays: row?.half_life_days ?? undefined,
      };
      node.confidence = freshness.currentConfidence(hit);
      node.stale = freshness.staleSince(hit) !== undefined;
    }
    return c.json(graph);
  });

  // The exact doc set an agent would retrieve/inject for a (project, user) pair:
  // the CODE + PRODUCT knowledge the launcher injects, run through the SAME scope
  // gate and the SAME origin/verdict/freshness injection gates real retrieval
  // applies (retrieveCodeKnowledge / retrieveProductKnowledge). Reusing those
  // functions is what keeps this view from ever drifting from what a launch
  // actually injects. Read-only introspection.
  //
  // Identity is resolved SERVER-SIDE, never from a client-supplied field — the
  // same discipline the agent search path follows (scopingUser). The
  // `user` query param is a preview knob, not an identity claim: previewing your
  // OWN view (blank or your own alias) resolves to your tunnel-authenticated
  // identity, but naming ANOTHER user in `user` is an operator action gated behind
  // isTrustedCoordinationWrite (the optional write token, or a single-user loopback
  // bind). An unauthenticated/anonymous caller resolves to the safe global ∪
  // project set (scopingUser maps anonymous → undefined).
  //
  // That `user`-param gate is a SOFT team convenience, not a hard boundary: on the
  // tunnel a teammate's own identity is authenticated (unforgeable), so their
  // self-view is exact — they see their own docs, never a forged peer's — and the
  // permissive class-(b) browse paths already let teammates read each other's docs
  // under the one-trusted-team model (see resolveAgentAudience's DESIGN NOTE). The
  // trust model is resolveUserAlias's (identity.ts).
  app.get("/api/knowledge/agent-view", async (c) => {
    const projectId = c.req.query("project") || c.req.query("projectId") || "scratch";
    const requested = c.req.query("user")?.trim() || undefined;
    const query = c.req.query("query") ?? c.req.query("q") ?? "";

    // The self-view audience comes from the SAME server-resolved choke point as
    // every other agent path (resolveAgentAudience → scopingUser); a client-supplied
    // `user` naming someone else can never widen scope on the default path.
    const audience: ScopeAudience = resolveAgentAudience(c, projectId);
    const self = audience.user;
    if (requested && requested !== self) {
      // Previewing a DIFFERENT user's agent view — only a trusted operator may.
      if (!isTrustedCoordinationWrite(c)) {
        return c.json(
          {
            error:
              "Previewing another user's agent-view requires operator trust (a matching write token, or a single-user loopback collector).",
          },
          403
        );
      }
      audience.user = requested;
    }
    const user = audience.user;

    // Reconcile every project's markdown first — the gate spans projects (global
    // docs and the user's own docs can live anywhere), so a stale sibling
    // project would hide in-scope docs, exactly as the cross-project search does.
    await knowledgeSync?.syncDirty();
    const [codeDocs, productDocs] = await Promise.all([
      retrieveCodeKnowledge(store.db, projectId, query, embeddingProvider, embeddingConfig, audience),
      retrieveProductKnowledge(store.db, projectId, query, embeddingProvider, embeddingConfig, audience),
    ]);

    return c.json({
      project: projectId,
      user: user ?? null,
      query,
      code: codeDocs,
      product: productDocs,
    });
  });

  // Live retrieval eval — runs the labeled fixtures through the real search
  // path and returns recall@5 / top-1, so the Health panel shows current
  // retrieval quality rather than a by-hand dogfood judgment. Reconciles disk
  // first so it scores the current corpus. When no embedding provider is
  // configured this exercises the FTS-only path, which is honest: it's what
  // retrieval actually runs on in that configuration.
  app.get("/api/knowledge/eval", async (c) => {
    await knowledgeSync?.syncDirty();
    const result = await runRetrievalEval(store.db, embeddingProvider, { embeddingConfig });
    return c.json(result);
  });

  // Runs `git rev-parse HEAD` in a launch's own worktree. Provenance is
  // stamped here rather than trusted from the agent's tool call — that is
  // the entire reason propose_knowledge is a collector-mediated tool and not
  // the agent writing a file directly. Returns null (not a thrown error) on
  // any failure so a git hiccup degrades to an unstamped draft rather than
  // losing the draft's content.
  async function gitHeadSha(cwd: string): Promise<string | null> {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return proc.exitCode === 0 ? stdout.trim() : null;
    } catch {
      return null;
    }
  }

  app.post("/api/knowledge/propose", async (c) => {
    const { session_id, cwd, slug: requestedSlug, title, body, tags: rawTags, source_kind, scope, project, request_human_review } =
      await c.req.json<{
        session_id?: string;
        cwd: string;
        slug: string;
        title: string;
        body: string;
        tags?: string[] | string;
        source_kind?: string;
        scope?: string;
        project?: string;
        request_human_review?: boolean;
      }>();

    // Any TRACKED session may propose — the only hard requirement is that we can
    // attribute the doc to a real session. This gate only resolves the doc's
    // project, source sha, and provenance; whether it publishes immediately
    // (the default) or waits for a human (request_human_review) is decided at the
    // tail below. Reject only when NO session resolves — an unregistered caller
    // has nothing to attribute the doc to.
    const session = resolveCallingSession(session_id, cwd);
    if (!session) {
      return c.json(
        { error: `No active session found for cwd "${cwd}". Is the collector running and did this session register at startup?` },
        400
      );
    }

    // A running launch is preferred when one exists for this worktree: its
    // worktree can sit OUTSIDE the project's configured repos (a bootstrap run
    // always does — see findLaunchByCwd's doc comment in launches.ts), so it is
    // the reliable source for the sha and worktree. But a launch is no longer
    // REQUIRED — a monitored/adopted/re-homed session with no running launch
    // falls back to the tracked session itself. Keyed on cwd (the launch's
    // worktree), not session_id, so an unrelated session can't claim another
    // launch's slot.
    const foundLaunch = findLaunchByCwd(store.db, cwd);
    const launch = foundLaunch && foundLaunch.status === "running" ? foundLaunch : null;

    if (!isValidSlug(requestedSlug)) {
      return c.json(
        { error: "Slug must be letters, numbers and hyphens — it becomes a filename." },
        400
      );
    }
    let slug: string = requestedSlug;
    const normalizedTags = normalizeTags(rawTags);
    if (!normalizedTags.ok) {
      return c.json({ error: normalizedTags.error }, 400);
    }
    const tags = normalizedTags.tags;
    // A proposal never passes for one of Persona's memories of its owner.
    const personaRefusal = personaProposalRefusal(slug, tags, scope);
    if (personaRefusal) {
      return c.json({ error: personaRefusal }, 400);
    }
    if (!title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }
    if (!body?.trim()) {
      return c.json({ error: "body is required" }, 400);
    }
    // A status-note title, or a body carrying several status markers, is
    // refused; a body with a single one draws a warning. Persona's own writes
    // are exempt.
    const exemptFromStatusGuard = isPersonaWrite(c);
    const titleRefusal = exemptFromStatusGuard ? null : statusTitleRefusal(title);
    if (titleRefusal) {
      return c.json({ error: titleRefusal }, 400);
    }
    const bodyRefusal = exemptFromStatusGuard ? null : statusBodyRefusal(body);
    if (bodyRefusal) {
      return c.json({ error: bodyRefusal }, 400);
    }
    const statusWarning = exemptFromStatusGuard ? null : statusBodyWarning(body);
    // Reject a garbage explicit scope up front rather than coercing it — scope
    // decides retrieval audience, so a bad value must not silently land the doc
    // in the wrong window. An ABSENT scope is fine; it falls through to the
    // project/global default below.
    if (scope !== undefined && !isValidScope(scope)) {
      return c.json({ error: `scope must be one of ${SCOPES.join(", ")}` }, 400);
    }

    // The draft lands in the TARGET project. An explicit `project` param wins
    // (any project may contribute knowledge about another as domains shift) and
    // must be a registered project; when omitted, default to the caller's own
    // project — the running launch's when there is one (a launch worktree can
    // sit outside the project's configured repos, so it is the reliable source),
    // else the tracked session's. Provenance still attributes the CALLER below.
    // Normalize once so "" and whitespace-only collapse to undefined ("omitted")
    // for BOTH the unknown-project 404 guard and the ?? default chain below.
    // Otherwise the two disagree: `project &&` treats "" as omitted (no 404),
    // but `"" ?? …` treats "" as present, so an empty-string project would
    // escape both and land an orphaned draft under project id "".
    const targetProject = project?.trim() || undefined;
    if (targetProject && !getProject(store.db, targetProject)) {
      return c.json({ error: `Unknown target project "${targetProject}".` }, 404);
    }
    const sessionHome = launch
      ? { projectId: launch.projectId, warning: undefined }
      : resolveCallingProject(session, cwd);
    let projectId = targetProject ?? sessionHome.projectId;
    const projectWarning = targetProject ? undefined : sessionHome.warning;

    // Homing a doc under the reserved GLOBAL corpus reaches EVERY project's agents
    // (scopeAudienceSql's reserved-corpus disjunct), so it is an audience-widening
    // write gated exactly like scope='global' — the HOME half of the same guard.
    // An authenticated tunnel identity may home a doc there (a desired team-wide
    // contribution); a caller with NO authenticated identity (a raw non-tunnel
    // network bind, absent the optional token) is rerouted to the caller's OWN
    // project so the body still lands (mirroring how the scope column is clamped to
    // 'project'), never the corpus-wide home. A tracked session's own home is never
    // the reserved corpus; clamp to scratch if it somehow is, so the reroute is
    // total and can never leave the doc in global.
    if (!mayWriteGlobalCorpus(c, projectId)) {
      const ownHome = sessionHome.projectId;
      projectId = ownHome === GLOBAL_PROJECT_ID ? SCRATCH_PROJECT_ID : ownHome;
    }

    // A scope=global proposal homed in scratch is refused rather than
    // downgraded. Scratch is where sessions land when no project matched, so a
    // "global" doc from there is unanchored work promoted to every project's
    // agents with no project to own or correct it; a silent downgrade would
    // instead bury it in scratch where no project's agents look. Refusing tells
    // the agent to pick a target project, and nothing lands half-scoped.
    if (scope === "global" && projectId === SCRATCH_PROJECT_ID) {
      return c.json(
        {
          error:
            'scope "global" is not accepted for a doc homed in the scratch project. Pass `project` ' +
            "with the project this knowledge belongs to (and omit scope, or use scope \"project\"), " +
            "or ask a human to promote it to global.",
        },
        400
      );
    }

    // Stamp the sha from the launch's worktree when running there, else the
    // tracked session's own cwd.
    const worktreeRoot = launch?.worktreePath ?? session.cwd ?? cwd;
    const generatedFromSha = await gitHeadSha(worktreeRoot);
    // The fact-check runs against a checkout of the project the doc is about,
    // resolved from the doc (see knowledge-verify-repos.ts): the proposer's for
    // a doc about its own project, the target's repo for a doc about another,
    // and for a global or scratch doc those of the proposer's project and of
    // the projects its body names.
    const verifyRepo = resolveVerificationRepo({
      targetProject: projectId,
      proposerProject: sessionHome.projectId,
      proposerRepo: worktreeRoot,
      body,
      ...dbVerificationInputs(store.db),
    });

    // Non-fatal: warn on filesystem path pointers the body embeds that do not
    // resolve here (a foreign-machine absolute path, or a repo-relative path that
    // is not present under the worktree). A dead pointer makes a documented
    // fallback unusable; surfaced as `warnings` on the response rather than
    // blocking the proposal.
    const pathWarnings = detectDeadPathPointers(body, worktreeRoot);
    // A "not yet merged" claim that names no branch cannot be expired when the
    // work lands, so the proposer is asked to name it.
    const unmergedWarning = unnamedUnmergedWarning(body);
    const bodyWarnings = [
      ...pathWarnings,
      ...(statusWarning ? [statusWarning] : []),
      ...(unmergedWarning ? [unmergedWarning] : []),
    ];

    // An accepted doc with this slug already existing means this draft would
    // replace it on accept — the regenerate case, distinct from a first
    // bootstrap where replacesSlug stays unset (see phase-7.md Step 5).
    // replacesSlug is the data-loss gate: leave it unset and accept-all does a
    // plain rename that clobbers the existing accepted doc with no merge. So
    // this must read GROUND TRUTH, not the rebuildable SQLite index (getDoc) —
    // an index lagging disk would miss the doc and drop the guard. readAcceptedDoc
    // is the seam's authoritative read (disk for local-markdown, the remote
    // store for a gateway/cloud backend), so the whole propose path still routes
    // through knowledgeBackend without trading away the guard's ground truth.
    let existingDoc = await knowledgeBackend.readAcceptedDoc(projectId, slug);
    // Any personal-layer slug — someone's personal doc, a Persona memory — gets
    // the one refusal a request for the personal layer gets, naming nothing
    // about the doc that holds it.
    const proposePersonalRefusal = personalLayerRefusal({ slug, docs: [existingDoc, knowledgeSync?.getDraft(projectId, slug)] });
    if (proposePersonalRefusal) return c.json({ error: proposePersonalRefusal }, 400);
    if (existingDoc && isAnotherUsersPersonalDoc(c, projectId, { ...existingDoc, slug })) {
      return c.json({ error: slugUnavailable(slug) }, 409);
    }

    // The session the doc is attributed to (and that owns it for an update).
    const authoringSessionId = launch ? (launch.sessionId ?? session.id) : session.id;

    // A proposal over a doc this session did not write — a human's, another
    // session's — never publishes over it. It becomes a review draft that
    // replaces the doc once a human accepts it (`review` on the response). Only
    // the writing session, or the owner of a personal doc, updates in place.
    const reviewReason = (doc: KnowledgeDocFile): string | null => {
      if (doc.originClass !== "agent") return "it is owner-written";
      const own =
        (!!doc.sourceSessionId && doc.sourceSessionId === authoringSessionId) ||
        (doc.scope === "user" && !!doc.ownerUser && doc.ownerUser === actingAlias(c));
      return own ? null : "another session wrote it";
    };
    // Whether the pending review draft at `draftSlug` was written by this
    // session: stamped with this launch, or (an unlaunched session) carrying
    // this session as its source_session_id. A retried proposal whose first
    // response was lost meets its own draft here and updates it rather than
    // being refused as someone else's open proposal. readKnowledgeFile reads
    // the draft by treating the project's `.drafts` directory as a project.
    const isOwnPendingDraft = async (draftSlug: string): Promise<boolean> => {
      const draft = knowledgeSync?.getDraft(projectId, draftSlug);
      if (!draft) return false;
      if (launch && draft.generatedByLaunchId === launch.id) return true;
      if (draft.generatedByLaunchId || !knowledgeDir) return false;
      const file = await readKnowledgeFile(join(knowledgeDir, projectId), ".drafts", draftSlug);
      return !!file?.sourceSessionId && file.sourceSessionId === authoringSessionId;
    };
    let autoReview: { replaces: string; reason: string } | null = null;
    if (existingDoc && !request_human_review) {
      const reason = reviewReason(existingDoc);
      if (reason) {
        // A pending review draft at the slug is someone's open proposal; it is
        // not overwritten. This session's own draft is the same proposal.
        if (knowledgeSync?.getDraft(projectId, slug) && !(await isOwnPendingDraft(slug))) {
          return c.json({ error: slugUnavailable(slug) }, 409);
        }
        autoReview = { replaces: slug, reason };
      }
    }

    // The doc as it would be stored at `target` over `existing`: its audience,
    // the owner's personal lines withheld and secrets redacted.
    const prepare = (target: string, existing: KnowledgeDocFile | null) => {
      // Scope + owning user for the doc, behind the SAME audience gate the PUT edit
      // route funnels every scope/owner change through — resolveAuthoredAudience is
      // that single choke point. This create/replace path AUTO-PUBLISHES by default
      // (publishDraft below, absent request_human_review), so a caller must not stamp
      // an audience it does not hold: the helper resolves the acting identity
      // server-side, honors an explicit request `scope` only as an authorized
      // change, and otherwise lands the body on a SAFE audience — a replace keeps
      // the existing accepted doc's scope+owner (a tokenless caller can refresh a
      // body but never reassign/widen an owned or 'global' doc), and a brand-new doc
      // is clamped to the visible 'project' default with NO owner. The
      // client-supplied `owner_user` is ignored; the owner of a 'user' doc is always
      // the acting caller.
      const { scope: authoredScope, ownerUser: authoredOwner } = resolveAuthoredAudience(c, {
        projectId,
        requestedScope: isValidScope(scope) ? scope : undefined,
        existing,
      });

      // The owner's own words stay in the personal layer: a body bound for a
      // shared scope loses every line that reproduces a personal-layer sentence
      // (an injected brief, a restated home CLAUDE.md rule) before redaction, and
      // the count is reported back. A body that is nothing but such lines is
      // refused, since publishing the empty remainder would only add noise.
      const withheldBody =
        authoredScope === "user" ? { text: body, withheld: 0 } : withholdPersonalContent(body, loadPersonalFingerprint(store.db));
      if (!withheldBody.text.trim()) {
        return {
          refusal: c.json(
            {
              error:
                "every line of this body restates the owner's personal notes, which stay in their personal layer; " +
                "nothing was proposed.",
              withheld: withheldBody.withheld,
            },
            400
          ),
        };
      }

      // Secrets never ride into the published corpus: the title and body are
      // redacted (account ids too when the doc lands in the personal layer or
      // global) before the draft is written, and the count is reported back so
      // the proposer knows the stored text differs from what it sent.
      const redactOpts = redactOptionsFor({
        projectId,
        slug: target,
        scope: authoredScope,
        sourceKind: normalizeSourceKind(source_kind) ?? DEFAULT_SOURCE_KIND,
      });
      const redactedTitle = redactSecretsWithCount(title.trim(), redactOpts);
      const redactedBody = redactSecretsWithCount(withheldBody.text, redactOpts);
      const redactions = redactedTitle.redactions + redactedBody.redactions;
      const warningFields = {
        ...(bodyWarnings.length > 0 ? { warnings: bodyWarnings } : {}),
        ...(projectWarning ? { projectWarning } : {}),
        ...(redactions > 0 ? { redactions } : {}),
        ...(withheldBody.withheld > 0 ? { withheld: withheldBody.withheld } : {}),
      };
      return { authoredScope, authoredOwner, redactedTitle, redactedBody, warningFields };
    };
    let prepared = prepare(slug, existingDoc);
    if ("refusal" in prepared) return prepared.refusal;

    // Near-duplicate check, on the text as it would be stored (personal lines
    // withheld, secrets redacted), across everything the caller's agents can
    // see — its project, scope=global docs and its own personal docs. The
    // nearest docs are returned on every response so the proposer sees what
    // already exists. A fresh doc that duplicates one is not published, and
    // nothing is rewritten: the response names the doc and how the two differ,
    // so the proposer can update that doc if this one corrects it. A proposal
    // that asks for human review still lands as a draft, neighbors attached.
    const audience = resolveAgentAudience(c, projectId);
    const nearest = existingDoc
      ? []
      : await nearestDocs(
          projectId,
          { slug, title: prepared.redactedTitle.text, body: prepared.redactedBody.text },
          audience
        );

    // A copy of a published doc (isHighConfidenceDuplicate) is refused before
    // anything is written, review requested or not: no doc, no draft, and the
    // response names the doc to update instead. Only a doc the proposer can
    // retrieve and update counts — one in the target project, a related
    // project or the global corpus, or a scope=global doc — so the refusal
    // never points at a doc the proposer cannot reach. A personal-layer doc is
    // never the target either: only Persona writes there, so "update it" would
    // dead-end. Those fall through to the near-duplicate handling below. An
    // update of an existing doc never gets here (nearest is empty for it).
    const retrievable = new Set([projectId, GLOBAL_PROJECT_ID, ...relatedProjects(projectId, getProjects(store.db))]);
    for (const n of nearest) {
      if (!n.highConfidence || (!retrievable.has(n.projectId) && n.scope !== "global")) continue;
      const copied = await knowledgeBackend.readAcceptedDoc(n.projectId, n.slug);
      if (!copied || personalLayerRefusal({ slug: n.slug, docs: [copied] })) continue;
      return c.json({ ...duplicateRefusal(projectId, n), nearest: nearest.map(nearestSummary), ...prepared.warningFields });
    }

    const dup = nearest.find((n) => n.duplicate);
    // A distinct proposal close to a doc the proposer could update instead
    // still lands; the response suggests that doc.
    const closeTo = dup ? undefined : nearest.find((n) => isUpdateCandidate(n.features) && n.scope !== "user");
    const closeHint = closeTo ? updateHint(projectId, closeTo) : undefined;
    let differences: string[] = [];
    if (dup && !request_human_review) {
      const differs = dup.differences.length > 0 ? ` It differs in: ${dup.differences.join(", ")}.` : "";
      const dupDoc = dup.projectId === projectId ? await knowledgeBackend.readAcceptedDoc(projectId, dup.slug) : null;
      const reason = dupDoc ? reviewReason(dupDoc) : null;
      const reviewable =
        !!dupDoc &&
        !!reason &&
        !personalLayerRefusal({ slug: dup.slug, docs: [dupDoc] }) &&
        (!knowledgeSync?.getDraft(projectId, dup.slug) || (await isOwnPendingDraft(dup.slug)));
      if (reviewable) {
        // Another session's (or a human's) doc in this project already covers
        // this: the proposal becomes a review draft replacing that doc, for a
        // human to accept if it corrects or extends it.
        slug = dup.slug;
        existingDoc = dupDoc;
        autoReview = { replaces: dup.slug, reason: reason! };
        differences = dup.differences;
        prepared = prepare(slug, existingDoc);
        if ("refusal" in prepared) return prepared.refusal;
      } else {
        const own = !!dupDoc && !reason;
        return c.json({
          ok: true,
          slug: requestedSlug,
          published: false,
          duplicateOf: nearestSummary(dup),
          ...(dup.differences.length > 0 ? { differences: dup.differences } : {}),
          nearest: nearest.map(nearestSummary),
          hint: own
            ? `${dup.projectId}/${dup.slug} (your own doc) already covers this: nothing was added.${differs} If this ` +
              `corrects or extends it, propose_knowledge with slug "${dup.slug}" to update it in place.`
            : dup.projectId !== projectId
              ? `${dup.projectId}/${dup.slug} already covers this: nothing was added.${differs} If this corrects or ` +
                `extends it, propose_knowledge with slug "${dup.slug}" and project "${dup.projectId}" — it is saved as a ` +
                "review draft replacing that doc."
              : `${dup.projectId}/${dup.slug} already covers this and a review of a change to it is already pending: ` +
                `nothing was added.${differs}`,
          ...prepared.warningFields,
        });
      }
    }
    const { authoredScope, authoredOwner, redactedTitle, redactedBody, warningFields } = prepared;
    const replacesSlug = existingDoc ? slug : undefined;
    // Past the session's daily auto-publish cap a proposal that would publish
    // is saved as a review draft instead.
    const capped = !request_human_review && !autoReview && autoPublishCap.reached(authoringSessionId);
    const reviewOnly = request_human_review || !!autoReview || capped;
    const reviewFields = autoReview
      ? {
          published: false,
          review: autoReview,
          ...(differences.length > 0 ? { differences } : {}),
          hint:
            `Saved as a review draft replacing ${projectId}/${autoReview.replaces} (${autoReview.reason}); it goes ` +
            "live when a human accepts it.",
        }
      : capped
        ? {
            published: false,
            capped: true,
            hint: [autoPublishCap.message(), closeHint].filter(Boolean).join(" "),
          }
        : closeHint
          ? { hint: closeHint }
          : {};

    try {
      await knowledgeBackend.writeDraft(projectId, {
        slug,
        title: redactedTitle.text,
        body: redactedBody.text,
        tags,
        generatedFromSha: generatedFromSha ?? undefined,
        generatedAt: new Date().toISOString(),
        generatedByLaunchId: launch?.id,
        replacesSlug,
        // Stamp the authoring session and trust class so acceptDraftFile
        // carries them into the accepted doc's frontmatter, where loadProject
        // reads them back — this is what makes session→doc and doc→doc
        // provenance edges form for agent-authored docs, not just for
        // hand-written frontmatter. An agent proposed it: 'agent', never the
        // fail-closed 'untrusted' default.
        sourceSessionId: authoringSessionId,
        originClass: "agent",
        // Source kind (roadmap r2/r8). The proposer classifies the draft as
        // code/product/spec/decision/runbook; an omitted kind is stored
        // 'unclassified', which is searchable but never injected as code
        // knowledge — an unlabeled proposal is not presumed to be a verified
        // code fact. This is the production path that lets product/spec docs
        // enter the corpus so launch-time product injection has something to
        // retrieve. Nothing has checked the claims yet, so the doc starts at
        // UNVERIFIED_CONFIDENCE with no last_verified_at; only a passing
        // fact-check (after publish, or a reviewed draft's) raises it to full
        // confidence and stamps the verification time.
        sourceKind: normalizeSourceKind(source_kind) ?? DEFAULT_SOURCE_KIND,
        // Scope + owning user (per-user knowledge). Resolved above from the
        // explicit request scope or the project/global default; the owner is
        // server-resolved for a 'user' doc. Carried into the draft frontmatter so
        // it survives the propose→accept lifecycle into the accepted doc, exactly
        // like source_kind. undefined owner for a global/project doc.
        scope: authoredScope,
        ownerUser: authoredOwner,
        confidence: UNVERIFIED_CONFIDENCE,
        halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    // Write-then-sync, the same pattern PUT /api/projects/:id/knowledge/:slug
    // uses for accepted docs: the file is the source of truth, this just
    // reconciles knowledge_drafts to match what's now on disk.
    await knowledgeSync?.syncDrafts(projectId);

    // Publish-by-default: an agent's proposal is auto-accepted and becomes
    // searchable project knowledge immediately, at UNVERIFIED_CONFIDENCE. Its
    // fact-check then runs in the background against `verifyRepo`;
    // only a pass raises it to full confidence (a dispute records the
    // mismatches as its verdict). The escape hatch is request_human_review: the
    // proposal stays a DRAFT (invisible to search_knowledge and injection until a
    // human accepts it), fact-checked in the background for the reviewer.
    // Auto-accept reuses the shared publishDraft path — moved into place, synced
    // into search, feed transition + contradiction check fired. A slug naming
    // the proposer's own existing doc is an update in place that keeps that
    // doc's verdict history and re-judges its contradictions.
    if (!reviewOnly) {
      const outcome = await publishDraft(projectId, slug, {
        audience,
        skipDedup: true,
        keepVerdictHistory: true,
        verifyRepo,
      });

      // The proposing session's own feed line — the substantive "agent
      // contributed knowledge" transition, recorded as a self-reported checkpoint
      // on the one pipe both the web feed and Slack's feedLine read.
      // (publishDraft's emitKnowledgeChange is project-scoped and attributes the
      // AUTHORING launch's session, which may not be this calling session.)
      emitTerminalCheckpoint(
        session.id,
        "self-reported",
        `📚 Published knowledge — ${title.trim()}`
      );

      if (!outcome.published) {
        // A fresh proposal duplicating an existing accepted doc is suppressed
        // rather than added (roadmap r7 dedup); report which doc already covers it
        // so the agent knows nothing new landed.
        return c.json({
          ok: true,
          slug,
          published: false,
          suppressedDupOf: outcome.reason === "duplicate" ? outcome.dupSlug : undefined,
          nearest: nearest.map(nearestSummary),
          ...warningFields,
        });
      }
      autoPublishCap.record(authoringSessionId);
      return c.json({
        ok: true,
        slug,
        published: true,
        mode: outcome.mode,
        verification: "pending",
        nearest: nearest.map(nearestSummary),
        ...(closeHint ? { hint: closeHint } : {}),
        ...warningFields,
      });
    }

    // request_human_review (or past the daily auto-publish cap) — keep it a
    // DRAFT for a human to accept.
    //
    // Fact-check in the background. Deliberately not awaited: the proposing
    // agent is blocked inside this tool call, and making it wait ~a minute
    // per document to be checked would stall the run for a result it is not
    // the audience for. The human is, at review — and by then it has landed.
    void (async () => {
      try {
        if (verifyRepo.repo === null) {
          const disputes = [unverifiableDispute(verifyRepo.reason)];
          knowledgeSync?.recordDraftVerdict(projectId, slug, UNVERIFIABLE_VERDICT, disputes);
          broadcast({
            type: "knowledge:draft",
            payload: { projectId, slug, verdict: UNVERIFIABLE_VERDICT, disputes },
            timestamp: new Date().toISOString(),
          });
          return;
        }
        const repo = verifyRepo.repo;
        const additionalRepos = verifyRepo.additionalRepos ?? [];
        const checked = await publishVerifier(slug, redactedBody.text, repo, additionalRepos);
        // Repository-state claims git refutes are listed for the reviewer too,
        // without making the draft disputed on their own; findings against a
        // repository the doc only names are notes (see
        // knowledge-publish-verify.ts).
        const gitFindings = await repoStateDisputes(redactedBody.text, [
          ...new Set([repo, ...additionalRepos, ...projectRepos(projectId)]),
        ]);
        const result = draftVerdict(checked, gitFindings, projectId, repo, additionalRepos, verifyRepo.namedRepos);
        knowledgeSync?.recordDraftVerdict(projectId, slug, result.verdict, result.disputes);
        broadcast({
          type: "knowledge:draft",
          payload: { projectId, slug, verdict: result.verdict, disputes: result.disputes },
          timestamp: new Date().toISOString(),
        });
      } catch {
        // This fact-check deliberately outlives the request: verifyDraft shells
        // out to `claude` for up to a minute, so by the time recordDraftVerdict
        // writes the verdict the request has long since returned. If the store
        // was closed in the meantime the write throws "Database has closed", and
        // in Bun's single shared test process that unhandled rejection is
        // re-attributed to whatever unrelated test is running then. Swallow it:
        // the verdict is best-effort sugar for a human at review, and a closed
        // store has nowhere to record it.
      }
    })();

    broadcast({
      type: "knowledge:draft",
      payload: {
        projectId,
        slug,
        title: title.trim(),
        generatedFromSha,
        launchId: launch?.id ?? null,
        replacesSlug: replacesSlug ?? null,
      },
      timestamp: new Date().toISOString(),
    });

    // A knowledge-graph change is a substantive event (this item's spec), but
    // the `knowledge:draft` frame above only nudges the Knowledge tab to refetch
    // — it is overloaded across noisy sub-events (fact-check verdicts, edits) and
    // never reaches the curated feed. An agent deliberately proposing a doc is
    // the substantive `doc added` transition, so record it as a self-reported
    // checkpoint on the proposing session — the one pipe both the web feed and
    // Slack's feedLine already read — where it surfaces un-collapsed and is
    // persisted (survives reload) rather than being a live-only nudge.
    emitTerminalCheckpoint(session.id, "self-reported", `📚 Proposed knowledge — ${title.trim()}`);

    return c.json({ ok: true, slug, nearest: nearest.map(nearestSummary), ...reviewFields, ...warningFields });
  });

  // The ingest-URL puller — the AUTOMATIC product-knowledge ingestion path
  // named gap #3 (roadmap r8) prescribes alongside the propose seam. Unlike
  // propose (which only fires from inside a running launch), this brings an
  // external PRODUCT/SPEC source into the corpus on demand: fetch a URL, reduce
  // it to text, and land a draft tagged source_kind=product|spec through the
  // same KnowledgeBackend.writeDraft seam. A human still accepts the draft
  // before it is searchable or injectable — ingest only closes the "nothing
  // ingests reachable product sources into the graph" gap so launch-time
  // product injection has something organic to retrieve.
  app.post("/api/knowledge/ingest-url", async (c) => {
    const { project_id, url, title, slug, source_kind, tags } = await c.req.json<{
      project_id?: string;
      url?: string;
      title?: string;
      slug?: string;
      source_kind?: string;
      tags?: string[];
    }>();

    if (!project_id || !getProject(store.db, project_id)) {
      return c.json({ error: "project_id is required and must name a known project." }, 400);
    }
    // Ingesting into the reserved GLOBAL corpus homes a doc that reaches EVERY
    // project's agents (scopeAudienceSql's reserved-corpus disjunct), so it is an
    // audience-widening write gated exactly like a propose/PUT into global — the
    // HOME half of the audience guard. The accept route is itself ungated, so this
    // is the chokepoint that stops a caller with NO authenticated identity (a raw
    // non-tunnel network bind) from planting a global-corpus draft to later
    // self-accept; an authenticated tunnel identity may ingest there.
    if (!mayWriteGlobalCorpus(c, project_id)) {
      return c.json(
        {
          error:
            "Ingesting into the reserved global corpus requires an authenticated identity (a tunnel-authenticated caller, a single-user loopback collector, or a matching write token).",
        },
        403
      );
    }
    if (!url || !isIngestableUrl(url)) {
      return c.json({ error: "url is required and must be an http(s) URL." }, 400);
    }

    let text: string;
    let fetchedTitle: string | undefined;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { Accept: "text/html, text/markdown, text/plain, */*" },
        signal: AbortSignal.timeout(INGEST_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return c.json({ error: `Fetching ${url} failed: HTTP ${res.status}.` }, 502);
      }
      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      if (contentType.includes("html")) {
        text = htmlToText(raw);
        fetchedTitle = extractHtmlTitle(raw);
      } else {
        // text/markdown, text/plain, or an unlabeled body: take it verbatim.
        text = raw.trim();
      }
    } catch (err) {
      return c.json({ error: `Fetching ${url} failed: ${(err as Error).message}` }, 502);
    }

    if (!text.trim()) {
      return c.json({ error: `No readable text could be extracted from ${url}.` }, 422);
    }

    const resolvedTitle = title?.trim() || fetchedTitle || url;
    const resolvedSlug = deriveIngestSlug(url, { explicitSlug: slug, title: resolvedTitle });
    if (!resolvedSlug || !isValidSlug(resolvedSlug)) {
      return c.json(
        { error: "Could not derive a valid slug; pass an explicit slug (letters, numbers, hyphens)." },
        400
      );
    }

    const fetchedAt = new Date().toISOString();
    // An external page can carry credentials (a pasted config, a URL with a
    // password); redact before it reaches the corpus. The draft is project
    // scoped, so account ids are the project's to keep.
    const body = redactSecrets(buildIngestBody(text, url, fetchedAt), redactOptionsFor({ projectId: project_id }));

    // Same replaces-slug data-loss guard the propose path uses: an accepted doc
    // with this slug means this draft would overwrite it on accept, so mark it
    // as a regenerate rather than let accept-all clobber the existing doc.
    const existingDoc = await knowledgeBackend.readAcceptedDoc(project_id, resolvedSlug);
    const ingestPersonalRefusal =
      personaProposalRefusal(resolvedSlug, tags) ??
      personalLayerRefusal({ slug: resolvedSlug, docs: [existingDoc, knowledgeSync?.getDraft(project_id, resolvedSlug)] });
    if (ingestPersonalRefusal) return c.json({ error: ingestPersonalRefusal }, 400);
    const replacesSlug = existingDoc ? resolvedSlug : undefined;

    try {
      await knowledgeBackend.writeDraft(project_id, {
        slug: resolvedSlug,
        title: resolvedTitle,
        body,
        tags,
        generatedAt: fetchedAt,
        replacesSlug,
        // A human operator deliberately curated this external source into the
        // project's product corpus, and the human-accept review is the publish
        // gate — so it earns `owner`, the same trust class a hand-authored doc
        // carries, which is what lets the accepted product doc reach launch-time
        // injection (isOriginEligibleForInjection admits owner|agent). It is NOT
        // stamped agent (no launch authored it) and NOT untrusted (untrusted
        // would land it un-injectable even after a human accepts, defeating the
        // gap-#3 payoff of getting product context in front of an implementer).
        originClass: "owner",
        // Product-first: an ingested URL is by definition an external
        // product/spec source, never code-derived.
        sourceKind: normalizeIngestSourceKind(source_kind),
        confidence: INITIAL_CONFIDENCE,
        lastVerifiedAt: fetchedAt,
        halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    await knowledgeSync?.syncDrafts(project_id);

    broadcast({
      type: "knowledge:draft",
      payload: {
        projectId: project_id,
        slug: resolvedSlug,
        title: resolvedTitle,
        replacesSlug: replacesSlug ?? null,
      },
      timestamp: new Date().toISOString(),
    });

    return c.json({ ok: true, slug: resolvedSlug, sourceKind: normalizeIngestSourceKind(source_kind) });
  });

  /**
   * Why code search may not run in `cwd`, or null when it may. The allowed
   * roots are an explicit list, and a cwd must be one of them or below one:
   * a registered project's repo paths, the worktree of an active launch for a
   * registered project (which the collector provisioned itself), and roots named
   * in STANDUP_CODE_SEARCH_ROOTS. Nothing a request or a hook can create — a
   * session, its cwd, an unregistered launch — widens the list. Inside an allowed
   * root, searchCode still refuses home directories, dot-directories, credential
   * stores and system directories.
   */
  function codeSearchCwdRefusal(cwd: string): string | null {
    if (!cwd) return "no cwd to search";
    const projects = getProjects(store.db);
    const roots = [...projects.flatMap((p) => p.repos), ...extraCodeSearchRoots()];
    const launch = findLaunchByCwd(store.db, cwd);
    if (launch && projects.some((p) => p.id === launch.projectId)) roots.push(launch.worktreePath);
    if (isWithinRoots(cwd, roots)) return null;
    return `code search is limited to registered project repos and their launched worktrees; ${cwd} is neither`;
  }

  app.post("/api/ripgrep", async (c) => {
    const { cwd, pattern, path, flags } = await c.req.json<{
      cwd: string;
      pattern: string;
      path?: string;
      flags?: string[];
    }>();

    const refusal = codeSearchCwdRefusal(cwd);
    if (refusal) {
      return c.json({ matches: [], truncated: false, backend: null, status: "unavailable", error: refusal }, 400);
    }

    try {
      // Carries the backend that answered: a search served by `git grep` or the
      // JS walker on a host without ripgrep is a narrower view of the tree than
      // rg's, and the caller is told which it got rather than guessing.
      const result = await runRipgrep(pattern, cwd, path, flags);
      return c.json(result);
    } catch (err) {
      return c.json(
        { matches: [], truncated: false, backend: null, status: "unavailable", error: String(err) },
        500
      );
    }
  });

  // The public knowledge API's owner controls: who may call it, and what they
  // asked. The API itself is a separate app (publicKnowledgeApp below) served
  // only on its own Unix socket, never on this one.
  // The allowlist and whether the listener is serving, one shape for GET and PUT.
  const { listenerStatus, ...publicKnowledgeSeams } = publicKnowledge;
  const accessView = (access: PublicKnowledgeAccess) => {
    const status = listenerStatus?.() ?? { enabled: false };
    return {
      ...access,
      enabled: status.enabled,
      ...(status.socketPath ? { socketPath: status.socketPath } : {}),
      ...(status.error ? { error: status.error } : {}),
    };
  };

  app.get("/api/public-knowledge/access", (c) => {
    const refused = ownerRefusal(c, "read who may use the public knowledge API");
    if (refused) return refused;
    return c.json(accessView(readAccess(store.db)));
  });

  app.put("/api/public-knowledge/access", async (c) => {
    const refused = ownerRefusal(c, "change who may use the public knowledge API");
    if (refused) return refused;
    const parsed = validateAccess(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    writeAccess(store.db, parsed.access);
    return c.json(accessView(parsed.access));
  });

  app.get("/api/public-knowledge/usage", (c) => {
    const refused = ownerRefusal(c, "read the public knowledge API's usage");
    if (refused) return refused;
    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    return c.json({ calls: listPublicKbCalls(store.db, Number.isFinite(requested) && requested > 0 ? requested : 100) });
  });

  // Reads the same knowledge index as this app.
  const publicKnowledgeApp = createPublicKnowledgeApp({
    db: store.db,
    knowledgeStore,
    ...(embeddingProvider ? { embedQuery: (text: string) => generateEmbedding(text, embeddingProvider, embeddingConfig) } : {}),
    ...(knowledgeSync ? { sync: () => knowledgeSync.syncDirty() } : {}),
    drain,
    ...publicKnowledgeSeams,
  });

  mountPersonaRoutes(app, {
    db: store.db,
    host: ownerAlias,
    fleet,
    ownerToken: ownerSecrets.ownerToken,
    // The request's own identity only — a body `actor` never directs Persona.
    identityOf: (c) => actingAlias(c),
    broadcast,
    health: lifecycle.health,
    ...(persona.restart ? { latestRestart: () => persona.restart!.current() } : {}),
    processes: processSystem,
    installDir: resolveInstallDir(),
  });
  // Restarting Standup is the host's: only the host's Persona may ask for it.
  mountRestartRoutes(app, {
    owner: ownerAlias,
    runtime: hostPersona,
    service: persona.restart,
    ownerRefusal: (c) => ownerRefusal(c, "read Standup's restarts"),
  });
  // The Review tab: workers submit review packets, the owner decides them.
  mountReviewRoutes(app, {
    db: store.db,
    broadcast,
    dataDir: reviewDataDir,
    identityOf: (c) => actingAlias(c),
    ownerChannel: (c) => ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets),
    userChannel: (c, alias) => userChannelTokenMatches(ownerSecrets.ownerToken, alias, c.req.header(USER_CHANNEL_HEADER)),
    resolveCallingSession,
    fleet,
    pipelinePort: review.pipelinePort ?? pipelineReviewPort(store.db, pipelineDeps),
    // A decided review is done with its tunnel; a rework round opens a new one at its screenshot stage.
    onDecided: (packet) => {
      if (packet.launchId) reviewTunnels.closeForLaunch(packet.launchId, "review_decided");
    },
    startQueuedIfIdle: async (sessionId) => {
      const launch = getLaunchBySession(store.db, sessionId);
      if (launch) await startQueuedIfIdle({ db: store.db, broadcast, pane: resumeDeps.pane ?? tmuxPaneDriver }, sessionId, launch);
    },
    git: review.git,
    // A packet awaiting its owner's decision pushes as that owner routes decisions.
    push:
      review.push ??
      ((title, message, actor) =>
        pushIfRouted(routeUpdate(store.db, actor, "decision", { facts: { approval: true } }), title, message, actor, resolveUserAlias(undefined))),
    mediaHome: review.mediaHome,
    mediaEnv: review.mediaEnv,
    mediaTotalMaxBytes: review.mediaTotalMaxBytes,
    mediaOwnerQuotaBytes: review.mediaOwnerQuotaBytes,
  });
  // Share links: a shared resource's public, read-only view (the share token is
  // the only credential), and its owner's toggle.
  const ownerChannel = (c: Context) => ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets);
  const userChannel = (c: Context, alias: string) =>
    userChannelTokenMatches(ownerSecrets.ownerToken, alias, c.req.header(USER_CHANNEL_HEADER));
  mountShareRoutes(app, { db: store.db, dataDir: reviewDataDir, identityOf: (c) => actingAlias(c), ownerChannel, userChannel, broadcast });
  // Comments on shareable docs, and the doc agent that replies from the doc alone.
  const docComments = new DocCommentAgent(store.db, review.docAnswerer ?? docAnswerer());
  review.onDocCommentAgent?.(docComments);
  docComments.resume();
  // Each user's docs: the console's editor, Persona's and workers' doc tools,
  // and the owner's import from this host's disk. The semantic index embeds
  // with the knowledge base's embedder; the first poke backfills every doc
  // not yet embedded, in the background.
  const docsSemantic = new DocsSemanticIndex(store.db, embeddingProvider, embeddingConfig);
  docsSemantic.poke();
  mountDocsRoutes(app, {
    semantic: docsSemantic,
    db: store.db,
    broadcast,
    dataDir: reviewDataDir,
    identityOf: (c) => actingAlias(c),
    ownerChannel,
    userChannel,
    fleet,
    ownerRefusal: (c, what) => ownerRefusal(c, what),
    home: review.mediaHome,
    env: review.mediaEnv,
    limits: review.docLimits,
    host: ownerAlias,
    docComments,
  });
  fleet?.bindApp(app);

  // The safety floor's hold route: a bypass-mode worker's floored tool call
  // waits here as a gated ask, resolved like any other.
  mountFloorRoutes(app, {
    db: store.db,
    secrets: ownerSecrets,
    awsIdentity: persona.awsIdentity,
    broadcast,
    personaHandles,
    resolveCallingSession,
    drainSignal: drain.signal,
    onReattached: (askId) => persona.restart?.noteReattached(askId),
    notifyOwner: (session, question) => {
      void pushNotification(
        session.title || `Agent needs ${responsibleAlias(store.db, session) ?? "you"}`,
        question,
        responsibleAlias(store.db, session) ?? null
      );
    },
  });

  // The delivery pipeline: workers report stages through the standup MCP
  // server; the console reads runs, waives stages and edits each user's config.
  mountPipelineRoutes(app, {
    db: store.db,
    deps: pipelineDeps,
    resolveCallingSession,
    humanRefusal,
    identityOf: (c) => actingAlias(c),
    personaOwnerOf: (c) => personaRuntimeOf(c)?.owner,
    personaRuntimeCallOf: (c) => personaRuntimeCallOf(c)?.owner,
  });

  // The Board: the console's reads of the user's task cards and conflict checks.
  mountBoardRoutes(app, {
    board,
    identityOf: (c) => actingAlias(c),
    ownerChannel: (c) => ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets),
    userChannel: (c, alias) => userChannelTokenMatches(ownerSecrets.ownerToken, alias, c.req.header(USER_CHANNEL_HEADER)),
  });

  // Review tunnels: the console's and Persona's reads and manual teardown.
  mountReviewTunnelRoutes(app, {
    db: store.db,
    tunnels: reviewTunnels,
    humanRefusal,
    identityOf: (c) => actingAlias(c),
    personaOwnerOf: (c) => personaRuntimeOf(c)?.owner,
  });

  // The worker process registry: workers register what they start; a closed job's hygiene stops it.
  mountProcessRoutes(app, {
    db: store.db,
    sys: processSystem,
    installDir: resolveInstallDir(),
    ...hygieneLiveness,
    humanRefusal,
    identityOf: (c) => actingAlias(c),
    personaOwnerOf: (c) => personaRuntimeOf(c)?.owner,
    broadcast,
  });

  // Each user's notification routing and daily brief (You → Notifications).
  mountNotifyRoutes(app, {
    db: store.db,
    humanRefusal,
    identityOf: (c) => actingAlias(c),
    host: fleet?.host ?? resolveUserAlias(undefined),
  });

  // A person at the console: the owner through an owner channel, or a teammate
  // through their own signed-in browser (their user channel token). Never a
  // Persona token or a bare identity header, which any loopback worker can send.
  const deciderPerson = (c: Context): string | null => {
    if (personaRuntimeOf(c) || c.req.header(PERSONA_TOKEN_HEADER)) return null;
    // The owner channel speaks for the owner only; any other alias proves itself below.
    if (ownerTokenMatches(c.req.header(OWNER_TOKEN_HEADER), ownerSecrets) && actingAlias(c) === ownerAlias) {
      return ownerAlias;
    }
    const user = scopingUserFor(c, config);
    if (!user || user === ownerAlias || user === ANONYMOUS_ALIAS) return null;
    return userChannelTokenMatches(ownerSecrets.ownerToken, user, c.req.header(USER_CHANNEL_HEADER)) ? user : null;
  };
  mountDeciderRoutes(app, {
    db: store.db,
    personOf: deciderPerson,
    isOwner: (c) => deciderPerson(c) !== null && ownerRefusal(c, "") === null,
  });

  // Each user's default Persona job budget (the You tab), global and per project.
  mountJobBudgetRoutes(app, {
    db: store.db,
    humanRefusal,
    identityOf: (c) => actingAlias(c),
    onChange: (owner) => fleet?.get(owner)?.budgets.markDirty(),
  });

  return Object.assign(app, { publicKnowledgeApp });
}

/**
 * Projects with their computed knowledge/draft counts — the shape the UI's
 * sidebar reads. Counts are joined here rather than persisted because a
 * bootstrap run that finishes on another tab is otherwise invisible until the
 * Knowledge panel is next opened.
 */
export function projectsWithCounts(store: Store): ProjectWithCounts[] {
  const counts = new Map(
    (
      store.db
        .query("SELECT project_id, COUNT(*) AS n FROM knowledge GROUP BY project_id")
        .all() as Array<{ project_id: string; n: number }>
    ).map((r) => [r.project_id, r.n])
  );

  const pendingDraftCounts = new Map(
    (
      store.db
        .query(
          "SELECT project_id, COUNT(*) AS n FROM knowledge_drafts WHERE status = 'pending' GROUP BY project_id"
        )
        .all() as Array<{ project_id: string; n: number }>
    ).map((r) => [r.project_id, r.n])
  );

  return getProjects(store.db).map((p) => ({
    ...p,
    knowledgeDocs: counts.get(p.id) ?? 0,
    pendingDrafts: pendingDraftCounts.get(p.id) ?? 0,
  }));
}

/**
 * The mount-time view of shared state the collector pushes in `hello-ok`. It
 * mirrors exactly the collections App.tsx fetches on load, so a client
 * boots from one WS frame instead of a fan-out of REST calls. Sessions include
 * `all=1` history for the same reason the Projects tab needs it: an ended
 * session that never appears can never be reviewed or cleaned up.
 */
export async function buildSnapshot(store: Store): Promise<Snapshot> {
  // Roots plus every subagent child: the flat lists exclude children, but the
  // client needs them in the same snapshot to nest each under its parent (it
  // filters to roots for the top-level list and groups children by parentSessionId).
  const all = [...getAllSessions(store.db), ...getSubagentSessions(store.db)];
  const sessions = await withActivityTicksBatch(store, all);
  // This is every session row, so it is the point to forget lookups memoized
  // for sessions that have since been deleted.
  retainTranscriptMemos(store.db, all.map((s) => s.id));
  return {
    projects: projectsWithCounts(store),
    sessions,
    checkpoints: getRecentCheckpoints(store.db, 50),
    asks: getPendingAsks(store.db),
    launches: getLaunchList(store.db),
    tickets: getTickets(store.db),
    actors: getActors(store.db),
  };
}

async function withActivityTicks(store: Store, session: Session): Promise<Session> {
  return (await withActivityTicksBatch(store, [session]))[0]!;
}

/**
 * Decorates sessions for the session list and hello-ok in a fixed number of
 * queries however many sessions there are: launches, participants, silence
 * ticks and newest-event marks each load for the whole list in one query, and
 * actors load once. The transcript path and effort lookups are memoized per
 * session on its newest event (see transcriptPathForSession), so only a
 * session with new events since the last call scans its events again.
 */
async function withActivityTicksBatch(store: Store, sessions: Session[]): Promise<Session[]> {
  const ids = sessions.map((s) => s.id);
  const marks = getLatestEventMarks(store.db, ids);
  const launches = getLaunchesBySession(store.db, ids);
  const participants = getParticipantsBySession(store.db, ids);
  const personaWorkers = openPersonaWorkerSessions(store.db, ids);
  const ticks = getSilenceTicksBySession(store.db, ids);
  // Resolve every attribution id through the actor merge tombstones — the
  // resolver follows `merged_into` as getActor does — so created/owner/participant
  // read as the canonical identity, the same resolve-through-merge contract the
  // /participants endpoint and getActors honor. Without it a since-merged id
  // (e.g. a `slack:U…` folded into a user alias) would render its raw id via
  // the client actor directory and miss the owning user's "Mine" filter.
  const resolveActor = actorResolver(store.db);
  const canonical = (id: string | undefined): string | undefined =>
    id ? resolveActor(id)?.id ?? id : id;
  return Promise.all(
    sessions.map(async (session) => {
      const mark = marks.get(session.id) ?? null;
      const transcriptPath = transcriptPathForSession(store.db, session.id, mark);
      const launch = launches.get(session.id);
      return {
        ...session,
        createdActor: canonical(session.createdActor),
        ownerActor: canonical(session.ownerActor),
        activityTicks: ticks.get(session.id)!,
        // Everyone who has acted on this session (steer/reply/resolve/dispatch),
        // so the UI's "Mine" filter can match created/owned/participated without a
        // per-session participants round-trip. Resolved and de-duped so a participant
        // recorded under a since-merged identity counts as its canonical actor.
        participantActors: [
          ...new Set(
            (participants.get(session.id) ?? []).map((p) => canonical(p.actorId)!)
          ),
        ],
        // Whether Standup owns this session's terminal: it has a launch. Drives
        // which controls the UI offers, so it belongs on every session response
        // rather than being fetched separately per session.
        owned: launch !== undefined,
        personaWorker: personaWorkers.has(session.id),
        liveEffort: currentEffortForSession(store.db, session.id, mark) ?? undefined,
        liveModel: (await currentModelForSession(transcriptPath)) ?? undefined,
        // Which harness drove this session, from the launch that started it. A
        // monitored session (no launch) and a Claude launch both read as claude —
        // only a codex launch stamped a harness — so this is set only when codex.
        harness: launch?.harness,
        launchModel: launch?.model,
        launchEffort: launch?.effort,
      };
    })
  );
}

// ============================================================================
// Hook event handler
// ============================================================================

/**
 * Guarantees a sessions row exists before any FK-dependent insert (events,
 * checkpoints, asks). Normally SessionStart creates it first, but a session
 * that was already running before the collector's DB was reset/restarted
 * never re-fires SessionStart — its later hooks would otherwise violate the
 * events.session_id foreign key. Safe to call unconditionally; no-ops if the
 * row is already there. Returns whether it revived an ended row.
 */
function ensureSession(
  store: Store,
  sessionId: string,
  cwd: string,
  eventName: string,
  // Which launch a new session joins (authorizeHookEvent): the one its hook
  // token claims, else the one whose worktree holds `cwd` unless
  // `attachToLaunch` is false, when the session is one of its own.
  link: { attachToLaunch: boolean; claim?: string } = { attachToLaunch: true }
): boolean {
  const existing = getSession(store.db, sessionId);

  if (existing) {
    // Any event other than SessionEnd proves the session is still alive.
    // Clear a stale ended_at from an earlier non-terminal SessionEnd
    // (resume/clear) or the reaper's silence end, which would otherwise hide
    // it from the UI forever.
    if (eventName !== "SessionEnd" && existing.endedAt) {
      // A launch that isn't live, or whose pane is gone, can't be what sent
      // it: the session was resumed by hand, and the pane reaper must leave it
      // alone. (A retired token proof is read live by resumedOutsideLaunch; a
      // token event from the launch clears this mark.)
      const launch = getLaunchBySession(store.db, sessionId);
      const outsideLaunch =
        !!launch &&
        (!(launch.status === "starting" || launch.status === "running") ||
          (!!launch.tmuxSession && !tmuxSessionExists(launch.tmuxSession)));
      reviveSession(store.db, sessionId, { outsideLaunch });
      return true;
    }
    return false;
  }

  // A console-launched session runs in a git worktree, which by definition
  // isn't among the project's configured `repos` — so check launches first,
  // or deliberately-launched work would land in `scratch`. A session that may
  // not join that launch still belongs to its project.
  const worktreeLaunch = link.claim ? getLaunch(store.db, link.claim) : findLaunchByCwd(store.db, cwd);
  const launch = link.attachToLaunch ? worktreeLaunch : null;
  const project = worktreeLaunch ? null : findProjectByCwd(store.db, cwd);

  createSession(store.db, {
    id: sessionId,
    projectId: worktreeLaunch?.projectId ?? project?.id ?? "scratch",
    // A plain console/Slack launch carries no label, so its task is the full raw
    // prompt — cap it so a launched session's title is never a wall of text
    // (the async summarizer upgrades it afterward). createSession normalizes ""
    // to NULL, so an unlaunched session still titles from its first prompt.
    title: capTitle(launch?.task ?? ""),
    cwd,
    status: "running",
  });

  if (launch) {
    attachSessionToLaunch(store.db, launch.id, sessionId);
    // Link the dispatcher-ledger row for this launch to the session too, so
    // report_task/heartbeat can find it by session id and the sweep can probe
    // its pane. Write-once; a run that already carries a session is left alone.
    attachSessionToTaskRun(store.db, launch.worktreePath, sessionId);
  }

  // Stamp who first brought this session into being: the tunnel
  // user who dispatched its launch — recorded on the ledger row, the only place
  // a dispatching teammate's alias survives down to this local hook — else the
  // host user for a session that appeared on its own. Write-once, and the
  // creator counts as its first participant.
  const creator =
    (launch && getActiveTaskRunByWorktree(store.db, launch.worktreePath)?.requester) ||
    resolveUserAlias(undefined);
  setSessionCreatedActor(store.db, sessionId, creator);
  recordParticipant(store.db, sessionId, creator);
  return false;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

/**
 * The structured questions of the `AskUserQuestion` modal the session is
 * currently blocked inside, or null if the main thread's newest unfinished
 * tool call isn't one (see unfinishedToolCalls). Returned structurally so an
 * answer can be mapped to menu keystrokes and to a readable record of what was
 * chosen.
 */
export function pendingAskUserQuestion(
  store: Store,
  sessionId: string
): NonNullable<AskUserQuestionInput["questions"]> | null {
  const pending = unfinishedToolCalls(store.db, sessionId).find((c) => !c.agentId);
  if (pending?.toolName !== "AskUserQuestion") return null;
  const questions = (pending.toolInput as AskUserQuestionInput)?.questions ?? [];
  return questions.length > 0 ? questions : null;
}

/**
 * The Notification hook reports only *that* an agent is blocked, never
 * *what* it's blocked on — that lives on the PreToolUse event of the call it
 * is about (see noticeTarget). Reading it back turns "Claude needs your
 * permission" into something a human can actually act on, for
 * AskUserQuestion's real questions/options as well as any other tool waiting on
 * approval (Bash, Write, ...).
 */
export function describeHeldCall(call: HeldToolCall | null): string | null {
  if (!call?.toolName) return null;
  const p = { tool_name: call.toolName, tool_input: call.toolInput };

  if (p.tool_name === "AskUserQuestion") {
    const questions = (p.tool_input as AskUserQuestionInput)?.questions ?? [];
    if (questions.length === 0) return null;

    const body = questions
      .map((q, i) => {
        const opts = (q.options ?? [])
          .map((o, j) => `${j + 1}. ${o.label ?? ""}`)
          .join("  ");
        const prefix = questions.length > 1 ? `${i + 1}) ` : "";
        return `${prefix}${q.header ? `${q.header}: ` : ""}${q.question ?? ""}${
          opts ? `\n   ${opts}` : ""
        }`;
      })
      .join("\n");

    return questions.length > 1
      ? `${body}\n\nMultiple questions — reply with one answer per line, in order (option number or free text).`
      : body;
  }

  // Any other tool needing approval — show what it's asking to do, not just
  // that it's asking.
  return describeCall(call);
}

/**
 * Titles a session from its first user prompt.
 *
 * Two stages. First, a readable title lands immediately: the first prompt,
 * capped, becomes the title (updateSessionTitle no-ops once one is set, so
 * later prompts don't overwrite it, and a launched session already carries its
 * capped task from ensureSession). Then, off the hook's critical path, a cheap
 * Haiku call upgrades it to a succinct task-specific title — for launched
 * sessions too, whose immediate title is the raw task. This second stage is
 * gated by its own setting (title_summary_enabled, default on), decoupled from
 * auto-checkpoint, and falls back to the capped title on any failure. The hook
 * returns at once; the upgrade broadcasts a status nudge when it lands.
 */
function setInitialTitle(
  store: Store,
  sessionId: string,
  prompt: string,
  broadcast: WsBroadcast
): void {
  const session = getSession(store.db, sessionId);
  if (!session?.title) {
    updateSessionTitle(store.db, sessionId, capTitle(prompt));
  }

  // Fire-and-forget: maybeSummarizeTitle no-ops when the setting is off, the
  // session was already summarized this run, or its title already fits (a short
  // label / prompt), and swallows generator failure internally — leaving the
  // capped title as the final one. The outer catch covers a write that resolves
  // seconds later against a store that has since been closed (the title is
  // best-effort, and a closed store has nowhere to record it).
  void maybeSummarizeTitle(store.db, sessionId, prompt, {
    onUpgraded: (id) => {
      const s = getSession(store.db, id);
      broadcast({
        type: "session:status",
        payload: { sessionId: id, status: s?.status ?? "running" },
        timestamp: new Date().toISOString(),
      });
    },
  }).catch(() => {});
}

/**
 * The session id to filter a transcript's records by, or `undefined` for no
 * filter.
 *
 * A root session can share its JSONL with a resumed/compacted parent
 * conversation, whose copied records keep their original sessionId — so a root
 * is filtered to its own id to keep another session's turns out of its view
 * (see recordBelongsToSession).
 *
 * A subagent child is different: its transcript comes from the subagent's OWN
 * dedicated per-invocation file (agent_transcript_path), whose records carry the
 * parent's (or the subagent's) real session UUID — NEVER the synthetic child id
 * `${parent}:${agentId}` the child row is keyed by. Filtering that file by the
 * child id would reject every record and render the subsession empty. The file
 * belongs wholly to this one subagent, so it needs no cross-session filter.
 */
function transcriptFilterSessionId(session: Session): string | undefined {
  return session.kind === "subagent" ? undefined : session.id;
}

/**
 * Idempotently materializes the child session for a subagent and mirrors the
 * subagent's own transcript.
 *
 * The synthetic id `${parentId}:${agentId}` keys the child, so a redelivered
 * SubagentStart/SubagentStop (a missed ack) resolves to the SAME row rather than
 * duplicating it, and either hook can be the one that first creates it (Stop can
 * arrive with no preceding Start). The child inherits the parent's project and
 * cwd and is flagged kind='subagent' with parent_session_id set — deliberately
 * NOT via ensureSession, which would instead stamp a ROOT row on the parent's own
 * id and re-run its launch/task-run attach.
 *
 * Persisting a child event that carries the subagent's own `transcript_path` is
 * what lets transcriptPathForSession — and thus the existing /transcript,/rich,
 * /events endpoints — serve the subsession with no new read code; the JSONL is
 * then mirrored into the durable log the /events endpoint pages from. A hook
 * without `agent_transcript_path` (SubagentStart) names the file where Claude
 * Code writes it, `<parent's transcript dir>/<parent id>/subagents/agent-<id>.jsonl`,
 * so a running subagent's calls can be read before it stops.
 */
function upsertSubagentSession(
  store: Store,
  parentId: string,
  agentId: string,
  agentType: string,
  description: string | undefined,
  hookTranscriptPath: string | undefined,
  payload: HookPayload,
  broadcast: WsBroadcast
): Session | null {
  const parent = getSession(store.db, parentId);
  if (!parent) return null;
  const parentTranscript = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
  const agentTranscriptPath =
    hookTranscriptPath ||
    (parentTranscript.endsWith(".jsonl") && /^[\w-]+$/.test(agentId)
      ? join(dirname(parentTranscript), basename(parentTranscript, ".jsonl"), "subagents", `agent-${agentId}.jsonl`)
      : undefined);

  const childId = `${parentId}:${agentId}`;
  if (!getSession(store.db, childId)) {
    createSession(store.db, {
      id: childId,
      projectId: parent.projectId,
      title: description?.trim() || agentType,
      cwd: parent.cwd,
      parentSessionId: parentId,
      status: "running",
      kind: "subagent",
      agentType,
      agentId,
    });
  }

  if (agentTranscriptPath) {
    // Stamp the child's own transcript pointer onto its event stream so
    // transcriptPathForSession resolves it, then mirror the JSONL into the
    // durable log — both keyed by the child id, so the parent's transcript is
    // untouched. Fire-and-forget ingest, like the parent's at the top of the
    // hook handler, and like it nudges followers when the head advances: a
    // reader that joins this pass is told `appended: 0`, so this is the one
    // place the pass's new records are announced.
    insertEvent(store.db, childId, payload.hook_event_name as HookEventType, {
      ...payload,
      session_id: childId,
      transcript_path: agentTranscriptPath,
    });
    // The subagent's own JSONL records carry the parent's (or the subagent's)
    // real UUID, not this synthetic child id — store under the child id but
    // skip the cross-session filter, or the durable log would ingest 0 rows.
    void ingestTranscriptEvents(store.db, childId, agentTranscriptPath, {
      skipSessionFilter: true,
    })
      .then(({ head, appended }) => {
        if (appended > 0) {
          broadcast({
            type: "session:event",
            payload: { sessionId: childId, seq: head },
            timestamp: new Date().toISOString(),
          });
        }
      })
      .catch(() => {});
  }

  return getSession(store.db, childId);
}

/**
 * Broadcasts a delivered steer's event, addressed to its audience and
 * proof-gated when it has one (Steer.audience), so a Human Review steer's body
 * reaches only its owner's sockets; an ordinary steer's goes to everyone.
 */
function broadcastSteerDelivered(broadcast: WsBroadcast, steer: Steer): void {
  broadcast({
    type: "steer:delivered",
    payload: steer,
    timestamp: new Date().toISOString(),
    ...(steer.audience ? { audience: steer.audience, requireProof: true } : {}),
  });
}

/**
 * Announces the steers and teammate messages just handed to `sessionId` at a
 * turn boundary (a prompt, or a Stop the pipeline blocked): each is pushed
 * to clients as delivered.
 */
function announceTurnDelivery(
  broadcast: WsBroadcast,
  sessionId: string,
  pendingSteer: ReturnType<typeof takeSteerContext>,
  pendingMail: ReturnType<typeof takeMailboxContext>
): void {
  for (const steer of pendingSteer?.steers ?? []) broadcastSteerDelivered(broadcast, steer);
  for (const message of pendingMail?.messages ?? []) {
    broadcast({ type: "session:message", payload: message, timestamp: new Date().toISOString() });
  }
  if (pendingSteer || pendingMail) {
    console.log(
      `[coordination] Delivered ${pendingSteer?.steers.length ?? 0} steer(s) + ` +
        `${pendingMail?.messages.length ?? 0} message(s) to ${sessionId} at turn boundary`
    );
  }
}

function handleHookEvent(
  store: Store,
  payload: HookPayload,
  broadcast: WsBroadcast,
  tailer?: TranscriptTailer,
  // Whether a running Persona owns the session; its workers' idle notices are
  // left to Persona rather than raised as asks.
  personaHandles: (sessionId: string) => boolean = () => false,
  // Notified when this hook moves the session out of scratch.
  onRehomed?: SessionRehomedListener,
  // Whether the session may join the launch whose worktree holds its cwd, and
  // the launch its hook token claims it for (authorizeHookEvent).
  auth: { attachToLaunch: boolean; claim?: string } = { attachToLaunch: true },
  // The launch's review scratch dir, named in the review brief a blocked Stop steers.
  reviewScratchDir: (launchId: string) => string | undefined = () => undefined
): Record<string, unknown> | null {
  const { session_id, hook_event_name, cwd } = payload;

  // Standup's own auto-checkpoint summarizer is a real `claude -p`
  // invocation, and Standup's hooks are installed globally — every
  // invocation fires them, not just interactive sessions (see
  // scripts/setup-hooks.ts). It always runs from this one reserved cwd, so
  // that's the signal to ignore it entirely: no session row, no events,
  // nothing. Without this, its own Stop event would trigger another
  // auto-checkpoint call on itself and recurse without bound.
  // Prefix-matched over the reserved root rather than a single path, so a
  // new internal subprocess is covered by existing;  matching one constant
  // is what would silently reopen the loop for the next one.
  if (isInternalCwd(cwd)) return null;

  // A SessionEnd for a session the collector has never seen has nothing to end.
  // Headless one-shot `claude -p` runs often deliver only this final hook, and
  // materializing a row from it fills the sidebar with untitled, empty sessions.
  if (hook_event_name === "SessionEnd" && !getSession(store.db, session_id)) return null;

  if (ensureSession(store, session_id, cwd, hook_event_name, auth)) {
    // Announced so the console refetches its list and the Slack mirror reopens
    // the thread. It carries no status: Slack and Persona read a status as a
    // transition (done is a "finished" line and a turn end).
    broadcast({
      type: "session:status",
      payload: { sessionId: session_id, revived: true },
      timestamp: new Date().toISOString(),
    });
  }
  // A session already seen (through the global hook's tokenless copy, before
  // the launch's token was proven or after its own session ended) joins the
  // launch its hook token claims it for.
  if (auth.claim) {
    const claimed = getLaunch(store.db, auth.claim);
    if (claimed && getLaunchBySession(store.db, session_id)?.id !== claimed.id) {
      attachSessionToLaunch(store.db, claimed.id, session_id);
    }
    // ensureSession's write-once link may have kept a session linked from the
    // worktree path alone; the claim names the worker's own. A run whose
    // session belongs to another launch (in-place launches share a path) is
    // that launch's, and one with no session yet may be another launch's
    // waiting for its own; both are left alone.
    const run = claimed ? getActiveTaskRunByWorktree(store.db, claimed.worktreePath) : null;
    const holder = run?.sessionId ? getLaunchBySession(store.db, run.sessionId) : null;
    if (run?.sessionId && run.sessionId !== session_id && (!holder || holder.id === claimed!.id)) {
      reattachSessionToTaskRun(store.db, run.id, session_id);
    }
  }

  // A session homed in scratch (e.g. started from $HOME) is re-resolved from each
  // new hook cwd — a `cd` into a launch worktree or project repo moves it — and,
  // once per prompt, from the transcript's working/additional directories. The
  // move persists on the session row, so later cwd changes never revert it.
  if (getSession(store.db, session_id)?.projectId === "scratch") {
    const resolved = resolveSessionProject(store.db, session_id, {
      paths: [cwd],
      eventCwds: false,
      transcript: hook_event_name === "UserPromptSubmit",
      onRehomed,
    });
    if (resolved.moved) {
      broadcast({
        type: "session:status",
        payload: {},
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Any hook is the per-session activity signal that this transcript may grow —
  // start tailing its file so a mid-turn thinking/prose stretch (which fires no
  // further hook) still surfaces near-live. Idempotent; the transcript_path from
  // the payload primes the watcher before the SessionStart event is even
  // persisted. SessionEnd unwatches below.
  tailer?.watch(session_id, payload.transcript_path);

  // Active transcript projection: a hook firing is the per-session
  // activity signal, so mirror the JSONL delta into the durable log now rather
  // than waiting for a client to GET the events endpoint — otherwise a passive
  // second viewer is only told new state landed by the coarse event:new signal
  // plus a 10s backstop poll. Fire-and-forget: the /hook response must not block
  // on file I/O (the whole point of the non-blocking hook contract), and the
  // ingest is stat-gated so an unchanged file is a cheap no-op. When the head
  // advances, push session:event so every following device pulls just the delta
  // — the same nudge the read path emits (transcript/events endpoint).
  void ingestTranscriptEvents(store.db, session_id, payload.transcript_path)
    .then(({ head, appended }) => {
      if (appended > 0) {
        broadcast({
          type: "session:event",
          payload: { sessionId: session_id, seq: head },
          timestamp: new Date().toISOString(),
        });
      }
    })
    .catch(() => {});

  // Returned to Claude Code as the hook's output: UserPromptSubmit's
  // additionalContext (waiting steers, mail and the pipeline line), or a
  // Stop's block decision (an unfinished delivery pipeline, or steers and
  // mail still to deliver).
  let hookOutput: Record<string, unknown> | null = null;

  switch (hook_event_name) {
    case "SessionStart": {
      // Claude Code reuses the same session_id across /clear, so without
      // this the title stays pinned to whatever the very first prompt was —
      // increasingly stale and unrelated as a long-lived session gets
      // cleared and reused for something new.
      const p = payload as { source?: "startup" | "resume" | "clear" } & typeof payload;
      if (p.source === "clear") {
        resetSessionTitle(store.db, session_id);
        // Let the next prompt's title be summarized afresh — the reset title is
        // about to be re-set from a new first prompt for whatever the cleared
        // session is now doing.
        clearTitleSummaryState(session_id);
      }

      const session = getSession(store.db, session_id);

      broadcast({
        type: "session:start",
        payload: { sessionId: session_id, projectId: session?.projectId, cwd },
        timestamp: new Date().toISOString(),
      });

      // ensureSession just attached this session to its launch (if any). That
      // is the moment the launch's feed card should collapse into the session,
      // but session:start only refreshes sessions on the client, not launches —
      // so push the now-attached launch row too. Without it the stale card
      // lingers until the next reconciliation sweep (~1 min later).
      const attachedLaunch = getLaunchBySession(store.db, session_id);
      if (attachedLaunch) {
        broadcast({
          type: "launch:started",
          payload: attachedLaunch,
          timestamp: new Date().toISOString(),
        });
      }

      // approved -> developing auto-advance. ensureSession (called above for
      // every hook) has already attached this session to its approval launch,
      // so that launch now carries the ticket. Guard on status === "approved":
      // SessionStart also fires on resume/clear, and re-transitioning an
      // already-developing ticket would throw TicketTransitionError and 500 the
      // hook. broadcastTicket lives in the server closure and isn't in scope
      // here, so the ticket:updated event is broadcast directly.
      // A re-dispatch (POST /api/tickets/:id/dispatch) points the ticket at a
      // fresh launch, so a `developing` ticket also relinks here — to the new
      // session — without a status change; only the first launch advances
      // approved -> developing.
      const ticketLaunch = auth.claim
        ? getLaunch(store.db, auth.claim)
        : auth.attachToLaunch
          ? findLaunchByCwd(store.db, cwd)
          : null;
      if (ticketLaunch) {
        // Normally the ticket's launch_id points straight at it. A best-of-N
        // ticket anchors to attempt 1's launch, so a NON-anchor attempt's launch
        // resolves the ticket through its run's attempt group instead —
        // otherwise only attempt 1 starting could advance approved -> developing,
        // wedging the ticket in `approved` if attempt 1 is the one that never
        // starts while the others work.
        let t = getTicketByLaunch(store.db, ticketLaunch.id);
        const isAnchor = t !== null;
        if (!t) {
          const run = getActiveTaskRunByWorktree(store.db, ticketLaunch.worktreePath);
          if (run?.attemptGroup) t = getTicketByAttemptGroup(store.db, run.attemptGroup);
        }
        if (t && (t.status === "approved" || t.status === "developing")) {
          // Track the anchor attempt's session; a non-anchor attempt fills in a
          // session only when the ticket has none, so the ticket keeps a live
          // session to steer even if the anchor never starts, without churning
          // it on every attempt that reports in.
          if (isAnchor || !t.sessionId) setTicketSession(store.db, t.id, session_id);
          const payload =
            t.status === "approved"
              ? updateTicketStatus(store.db, t.id, "developing")
              : getTicket(store.db, t.id)!;
          broadcast({
            type: "ticket:updated",
            payload,
            timestamp: new Date().toISOString(),
          });
        }
      }
      break;
    }

    case "SessionEnd": {
      endSession(store.db, session_id);
      tailer?.unwatch(session_id);
      clearTodoCheckpointState(session_id);
      clearNudgeState(session_id);
      clearAutoCheckpointState(session_id);
      clearTitleSummaryState(session_id);

      // The session is gone, so nothing will ever resolve a pending ask it
      // raised — left pending it sits in "Needs you" forever pointing at a
      // session that has ended. Mirrors the console stop endpoints.
      for (const ask of cancelAllPendingAsks(store.db, session_id)) {
        broadcast({
          type: "ask:resolved",
          payload: { askId: ask.id, answer: "" },
          timestamp: new Date().toISOString(),
        });
      }

      // Pending peer messages are NOT cancelled here, unlike asks. SessionEnd
      // is not terminal — Claude Code fires it on /clear and resume, after
      // which the same session id keeps taking turns (see ensureSession's
      // revive). Cancelling would silently drop a hand-off the sender was told
      // landed; instead the message survives to the next turn exactly as a
      // queued steer does, and is delivered when the session continues.

      broadcast({
        type: "session:end",
        payload: { sessionId: session_id },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case "UserPromptSubmit": {
      const p = payload as { prompt: string } & typeof payload;
      // First prompt becomes the session title; later prompts don't overwrite
      // it. Succinct Haiku title when title summaries are on
      // (isTitleSummaryEnabled), else truncated.
      setInitialTitle(store, session_id, p.prompt, broadcast);
      // A new turn is starting — the session is no longer idle/waiting, and
      // the last turn end's verdict no longer applies.
      updateSessionStatus(store.db, session_id, "running");
      resetTurnNudges(session_id);
      beginTurnEnd(session_id);

      // The prompt-asks this new turn makes moot are retired once the event is
      // recorded (see retireMootPermissionAsks).
      broadcast({
        type: "session:status",
        payload: { sessionId: session_id, status: "running" },
        timestamp: new Date().toISOString(),
      });

      // Deliver queued steers AND any teammate-agent messages here: a new prompt
      // is a turn boundary by definition, which is exactly the constraint the
      // design imposes (never inject mid-turn — see "Steer injected mid-turn
      // derails a run" in the failure-modes table). Both ride the same
      // additionalContext block so human steering and cross-session coordination
      // reach the agent together at the safe boundary.
      const pendingSteer = takeSteerContext(store.db, session_id);
      const pendingMail = takeMailboxContext(store.db, session_id);
      // Where the session's delivery pipeline stands rides the same block. A
      // prompt means the turn is driven from outside, so the run's
      // consecutive Stop blocks start over and a parked run is un-parked.
      pipelinePromptSubmitted(store.db, session_id, { broadcast }, { prompt: typeof p.prompt === "string" ? p.prompt : undefined });
      const pipelineLine = pipelineSteerLine(store.db, session_id);
      const blocks = [pendingSteer?.text, pendingMail?.text, pipelineLine].filter(
        (t): t is string => !!t
      );
      if (blocks.length > 0) {
        hookOutput = {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: blocks.join("\n\n"),
          },
        };
        announceTurnDelivery(broadcast, session_id, pendingSteer, pendingMail);
      }
      break;
    }

    case "PostToolUse": {
      const p = payload as ToolUsePayload;

      // The prompt-ask this call's finishing makes moot is retired once the
      // event is recorded (see retireMootPermissionAsks).

      if (p.tool_name === "TodoWrite") {
        for (const checkpoint of checkpointCompletedTodos(store.db, session_id, p.tool_input)) {
          broadcast({
            type: "checkpoint:new",
            payload: checkpoint,
            timestamp: new Date().toISOString(),
          });
        }
      }

      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });

      // Proactive nudging. Off unless STANDUP_NUDGE=1.
      //
      // Deliberately does not fire for the agent's own Standup tool calls: a
      // search_knowledge round trip generates PostToolUse events, and nudging
      // on those is precisely the chime-in feedback loop the design warns
      // about. The event is still recorded below either way.
      if (isNudgingEnabled() && !isStandupTool(p.tool_name)) {
        // insertEvent runs at the end of this function, so the event that
        // triggered this check isn't in the window yet. That's fine — it
        // makes detection lag by exactly one tool call rather than miss
        // anything.
        const nudge = maybeNudge(store.db, session_id);
        if (nudge) {
          console.log(
            `[nudge] ${session_id.slice(0, 8)} — ${nudge.signal.reason}`
          );

          // Visible to the human too: the design says the only way to tune
          // the false-positive rate is to watch it happen.
          broadcast({
            type: "stall:detected",
            payload: {
              sessionId: session_id,
              reason: nudge.signal.reason,
              topic: nudge.signal.topic,
              nudged: true,
            },
            timestamp: new Date().toISOString(),
          });

          hookOutput = {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: nudge.text,
            },
          };
        }
      }
      break;
    }

    case "Stop": {
      // A launched worker that edited files but never proposed knowledge gets
      // its stop blocked once with a contribute reminder. Claude Code continues
      // the turn with the reason as its next instruction, so the session is
      // still running: it is not marked idle and the turn is not classified;
      // the stop that follows comes back through here and takes the normal path.
      const contributeNudge = maybeContributeNudge(
        store.db,
        session_id,
        (payload as { stop_hook_active?: boolean }).stop_hook_active === true
      );
      if (contributeNudge) {
        console.log(`[contribute-nudge] ${session_id.slice(0, 8)} — blocked stop once`);
        hookOutput = contributeNudge;
        break;
      }

      // A launched worker whose delivery pipeline isn't finished is sent back
      // to it (one synchronous read and write; bounded by the run's
      // consecutive-block count, after which the run goes to the owner and the
      // Stop proceeds). The turn continues, so the session stays running. It
      // follows the contribute reminder, which only fires on a stop that is
      // not already a continuation, so both still apply.
      // A blocked Stop is a turn boundary too: queued steers and teammate
      // messages ride the block's reason, after the pipeline's text. The
      // owner's review steer (a question or requested changes on a packet)
      // queued mid-turn blocks the Stop by itself, before the pipeline reads
      // this Stop as the worker stopping: an idle worker has no next turn to
      // read the steer at.
      const ownerSteer = getPendingSteers(store.db, session_id).some((s) => s.audience);
      const pipelineStop = ownerSteer ? null : pipelineStopDecision(store.db, session_id, { broadcast, reviewScratchDir });
      if (pipelineStop || ownerSteer) {
        const pendingSteer = takeSteerContext(store.db, session_id);
        const pendingMail = takeMailboxContext(store.db, session_id);
        const reason = [pipelineStop?.reason, pendingSteer?.text, pendingMail?.text].filter((t): t is string => !!t).join("\n\n");
        hookOutput = { decision: "block", reason };
        announceTurnDelivery(broadcast, session_id, pendingSteer, pendingMail);
        break;
      }
      updateSessionStatus(store.db, session_id, "idle");
      broadcast({
        type: "session:status",
        payload: { sessionId: session_id, status: "idle" },
        timestamp: new Date().toISOString(),
      });

      // Auto-checkpointing + turn-end classification (real cost per call, see
      // auto-checkpoint.ts). Fired without awaiting: it shells out to
      // `claude -p` and takes seconds, and the hook response must not wait on
      // that or every turn boundary gets slower for the agent. Run
      // sequentially in one task so the classifier can dedupe its feed entry
      // against whatever auto-checkpoint already wrote. The last turn end's
      // verdict is forgotten first, so the idle notice's coarse fallback
      // covers this one until the classifier judges it.
      const turn = beginTurnEnd(session_id);
      const stoppedAt = new Date().toISOString();
      void (async () => {
        try {
          const checkpoint = await maybeAutoCheckpoint(store.db, session_id);
          if (checkpoint) {
            broadcast({
              type: "checkpoint:new",
              payload: checkpoint,
              timestamp: new Date().toISOString(),
            });
          }

          // Classify the turn end (needs-you / done / idle) and reflect it.
          // This is what surfaces a monitored session that needs input — the
          // coarse launched/monitored default can't tell "asked a question"
          // from "just stopped".
          const result = await classifyTurnEnd(store.db, session_id, turn);
          // A verdict that lands after a newer turn boundary is about a turn
          // the session has moved past, so it neither flags nor finishes it.
          if (!result || !isLatestTurn(session_id, turn)) return;

          // The idle notice can arrive while this task still runs, so the
          // coarse fallback may already have flagged this turn end. A done or
          // idle verdict on it retires that idle-notice ask and, if nothing
          // else holds the session waiting, puts it back to idle.
          if (result.state !== "needs_you") {
            const fallbackAsks = store.db
              .query("SELECT id FROM asks WHERE session_id = ? AND status = 'pending' AND gate = ? AND created_at >= datetime(?)")
              .all(session_id, IDLE_NOTICE_GATE, stoppedAt) as Array<{ id: string }>;
            for (const stale of fallbackAsks) {
              cancelAsk(store.db, stale.id);
              broadcast({ type: "ask:resolved", payload: { askId: stale.id, answer: "" }, timestamp: new Date().toISOString() });
            }
            if (
              fallbackAsks.length > 0 &&
              getSession(store.db, session_id)?.status === "waiting" &&
              getSurfacedAsksBySession(store.db, session_id).length === 0
            ) {
              updateSessionStatus(store.db, session_id, "idle");
              broadcast({
                type: "session:status",
                payload: { sessionId: session_id, status: "idle" },
                timestamp: new Date().toISOString(),
              });
            }
          }
          const session = getSession(store.db, session_id);

          if (result.state === "needs_you") {
            // One ask per block — the same idempotency guard the live
            // Notification path uses.
            if (getPendingAsksBySession(store.db, session_id).length > 0) return;
            // Persona already woke on this turn end (the idle status above)
            // and reads the worker itself; a pseudo permission prompt would
            // only stand between it and the worker's pane.
            if (personaHandles(session_id)) return;
            const launched = isLaunchedSession(store.db, session_id);
            const note = launched
              ? "\n\n(launched by the console — nobody is at its terminal)"
              : "\n\n(running in your own terminal — answer it there)";
            // A turn end the classifier judged as waiting on someone, not a
            // tool-permission dialog: marked so nothing mistakes it for one.
            const ask = createAsk(
              store.db,
              session_id,
              "permission_prompt",
              `${result.reason}${note}`,
              undefined,
              { gate: IDLE_NOTICE_GATE }
            );
            updateSessionStatus(store.db, session_id, "waiting");
            broadcast({
              type: "ask:new",
              payload: ask,
              timestamp: new Date().toISOString(),
            });
            broadcast({
              type: "session:status",
              payload: { sessionId: session_id, status: "waiting" },
              timestamp: new Date().toISOString(),
            });
            void pushNotification(
              session?.title || `Agent needs ${responsibleAlias(store.db, session) ?? "you"}`,
              result.reason,
              responsibleAlias(store.db, session) ?? null
            );
          } else if (result.state === "done") {
            // Only from idle — never stomp a status the session moved on to
            // (a new turn started, or it's already waiting on something) —
            // and never while it still has live work: the classifier reads
            // only the transcript.
            if (!markDoneAtTurnEnd(store.db, session_id)) return;
            broadcast({
              type: "session:status",
              payload: { sessionId: session_id, status: "done" },
              timestamp: new Date().toISOString(),
            });
            // Make "done" visible in the feed. If auto-checkpoint already
            // wrote a checkpoint for this turn, that's the entry — don't
            // duplicate it; otherwise record the completion as one.
            if (!checkpoint) {
              const doneCheckpoint = createCheckpoint(
                store.db,
                session_id,
                "auto",
                `✓ Done — ${result.reason}`
              );
              broadcast({
                type: "checkpoint:new",
                payload: doneCheckpoint,
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch (err) {
          console.error(`[turn-end] ${session_id.slice(0, 8)}:`, err);
        }
      })();
      break;
    }

    case "SubagentStart": {
      // A spawned subagent gets its OWN child session nested under this one.
      // Gated on a NAMED subagent (non-empty agent_type + agent_id) — the same
      // filter SubagentStop applies, since Claude Code fires Subagent* for
      // internal helpers (title generation, summarization) with an empty
      // agent_type, which must not each become a subsession row.
      const p = payload as {
        agent_type?: string;
        agent_id?: string;
        agent_transcript_path?: string;
        description?: string;
      } & typeof payload;

      if (p.agent_type && p.agent_id) {
        const child = upsertSubagentSession(
          store,
          session_id,
          p.agent_id,
          p.agent_type,
          p.description,
          p.agent_transcript_path,
          payload,
          broadcast
        );
        if (child) {
          broadcast({
            type: "session:start",
            payload: { sessionId: child.id, projectId: child.projectId, cwd: child.cwd },
            timestamp: new Date().toISOString(),
          });
        }
      }

      // A subagent never sees its parent's opening prompt, so the knowledge-first
      // steering and the docs injected into that prompt reach it here instead.
      // Only for a named subagent of a launched session whose own launch carries
      // the steering (launchCarriesKnowledgeSteering). Best-effort: a failure
      // here leaves the subagent without the context but still reaches the
      // parent's event:new broadcast below.
      if (p.agent_type && p.agent_id) {
        try {
          const launch = getLaunchBySession(store.db, session_id);
          if (
            launch &&
            launchCarriesKnowledgeSteering(launch, getProject(store.db, launch.projectId))
          ) {
            hookOutput = {
              hookSpecificOutput: {
                hookEventName: "SubagentStart",
                additionalContext: buildSubagentKnowledgeContext(
                  getLaunchInjectedDocs(store.db, launch.id)
                ),
              },
            };
          }
        } catch (err) {
          console.error(`[subagent-start] ${session_id.slice(0, 8)} knowledge context:`, err);
        }
      }

      // The parent's transcript view refreshes on event:new; the default case
      // emits it for every otherwise-unhandled hook, so preserve it here.
      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    case "SubagentStop": {
      // Structural checkpoint from a subagent finishing.
      //
      // There is no `description` field — verified payload carries
      // `agent_type`, `agent_id`, and `last_assistant_message`. An earlier
      // version keyed on `description` and so silently skipped every event.
      //
      // Gated on a non-empty agent_type, which is what the design means by
      // "a *named* subtask". Claude Code fires SubagentStop for internal
      // helpers too (title generation, summarization); those carry an empty
      // agent_type and a last_assistant_message that is often just the
      // human's own words echoed back. Checkpointing those would fill the
      // feed with the user's own messages attributed to an agent.
      const p = payload as {
        agent_type?: string;
        agent_id?: string;
        agent_transcript_path?: string;
        last_assistant_message?: string;
      } & typeof payload;

      const summary = p.last_assistant_message?.trim();
      if (p.agent_type && summary) {
        const checkpoint = createCheckpoint(
          store.db,
          session_id,
          "structural",
          summary.length > 280 ? `${summary.slice(0, 277)}…` : summary
        );

        broadcast({
          type: "checkpoint:new",
          payload: checkpoint,
          timestamp: new Date().toISOString(),
        });
      }

      // Close the subsession this Stop belongs to. Upsert-from-either-hook: a
      // Stop with no preceding Start (an edge Claude Code may skip) still
      // materializes the child so its transcript isn't orphaned, then marks it
      // done. The child ingests the subagent's final transcript here too, since
      // agent_transcript_path is present on Stop.
      if (p.agent_type && p.agent_id) {
        const child = upsertSubagentSession(
          store,
          session_id,
          p.agent_id,
          p.agent_type,
          undefined,
          p.agent_transcript_path,
          payload,
          broadcast
        );
        if (child) {
          endSubagentSession(store.db, child.id);
          broadcast({
            type: "session:end",
            payload: { sessionId: child.id },
            timestamp: new Date().toISOString(),
          });
        }
      }
      break;
    }

    case "Notification": {
      const p = payload as { notification_type: string; message?: string } & typeof payload;

      // Verified payloads (see runbook): permission_prompt carries "Claude
      // needs your permission"; idle_prompt carries "Claude is waiting for
      // your input"; auth_success is informational.
      //
      // idle_prompt means different things depending on who started the
      // session, which is why it isn't handled uniformly:
      //   - monitored: routine. You are at that terminal and will type when
      //     ready; badging every turn end would be constant noise.
      //   - launched:  nobody is at that terminal. Left unflagged it waits
      //     forever — exactly the blocked-and-invisible case.
      const isPermission = p.notification_type === "permission_prompt";
      const isIdle = p.notification_type === "idle_prompt";
      const launched = isLaunchedSession(store.db, session_id);

      // The Stop turn-end classifier decides needs-you/done/idle for every
      // session (launched and monitored), so once it has judged this turn end
      // the coarse "launched idle → needs-you" rule stands down to avoid
      // double-flagging a launch it judged done or idle; with no verdict (the
      // call failed or is still running) the coarse rule flags it, and a done
      // or idle verdict that lands later retires that flag. A real
      // permission_prompt is a mid-turn tool gate, not a turn end, so it always
      // surfaces regardless.
      // A Persona-owned worker's idle notice is not raised while Persona runs:
      // Persona is its owner-of-record and already wakes on the turn end (the
      // Stop hook's idle status), so the ask would only duplicate it as a fake
      // permission prompt.
      // A session already done stays done: its verdict outlives a collector
      // restart, which empties the in-memory judged set.
      const idleNeedsYou =
        isIdle &&
        launched &&
        !turnEndJudged(session_id) &&
        getSession(store.db, session_id)?.status !== "done" &&
        !personaHandles(session_id);

      // The call a permission notice is about (see noticeTarget), never just
      // the newest PreToolUse: background subagents keep starting and
      // finishing other calls meanwhile. Asks whose call is already over are
      // retired first, so they can't stand in for this dialog.
      const target = isPermission ? noticeTarget(store.db, session_id, noticeToolName(p.message)) : null;
      if (isPermission) {
        for (const stale of retirePermissionAsks(store.db, session_id)) {
          broadcast({ type: "ask:resolved", payload: { askId: stale.id, answer: "" }, timestamp: new Date().toISOString() });
        }
      }

      if (isPermission || idleNeedsYou) {
        updateSessionStatus(store.db, session_id, "waiting");
        broadcast({
          type: "session:status",
          payload: { sessionId: session_id, status: "waiting" },
          timestamp: new Date().toISOString(),
        });

        // Claude Code re-emits the Notification hook while a prompt sits
        // unanswered — idle_prompt fires at every turn end, and a permission
        // prompt re-notifies — so without an idempotency guard a single block
        // stacks up several pending asks and shows as two (or more) "blocked"
        // events for the same wait. This is the same duplicate that
        // reconcileBlockedSessions already guards against at startup; the live
        // path needs the identical check. If this session already has a
        // pending ask, the block is surfaced — don't raise another.
        //
        // A real permission dialog is deduped only against a pending real
        // permission ask that stands for the same dialog (see askStandsFor):
        // one appearing while a question or an idle notice is pending is a
        // new block that needs its own row, or a delegate would see none and
        // type straight into the dialog. Claude Code shows one dialog at a
        // time, so a pending permission ask for a different dialog is moot.
        //
        // A prompt Persona has claimed while it types the answer
        // (claimPendingAsk) still stands for its dialog, which is still on
        // screen until the digit lands: it counts here as pending, so a
        // re-notification meanwhile raises no second ask for the same dialog.
        const pendingAsks = getSurfacedAsksBySession(store.db, session_id);
        const pendingPermission = pendingAsks.filter((a) => a.kind === "permission_prompt" && a.gate !== IDLE_NOTICE_GATE);
        const alreadySurfaced = target
          ? pendingPermission.some((a) => askStandsFor(store.db, a, target))
          : pendingAsks.length > 0;
        if (target && !alreadySurfaced) {
          for (const moot of pendingPermission) {
            cancelAsk(store.db, moot.id);
            broadcast({ type: "ask:resolved", payload: { askId: moot.id, answer: "" }, timestamp: new Date().toISOString() });
          }
        }
        if (!alreadySurfaced) {
          const session = getSession(store.db, session_id);
          const detail =
            (target ? (target.call ? describeHeldCall(target.call) : describeCandidates(store.db, session_id, target.candidates)) : null) ??
            p.message ??
            (isPermission ? "Permission requested" : IDLE_PROMPT_NOTICE);
          const question = launched
            ? `${detail}\n\n(this session was launched by the console, so nobody is at its terminal)`
            : detail;

          // Surfaced as an ask so it lands in the Blocked view and the alert
          // strip. Answering it isn't possible from here for a monitored
          // session — but a launched one can be answered with send input. A
          // permission ask records the call it is about, or the calls it could
          // be about, so only those ending retires it.
          const ask = createPermissionAsk(
            store.db,
            session_id,
            question,
            target,
            isPermission ? {} : { gate: IDLE_NOTICE_GATE }
          );
          broadcast({
            type: "ask:new",
            payload: ask,
            timestamp: new Date().toISOString(),
          });

          void pushNotification(
            session?.title || `Agent needs ${responsibleAlias(store.db, session) ?? "you"}`,
            detail,
            responsibleAlias(store.db, session) ?? null
          );
        }
      }

      // The transcript view refreshes on event:new (see TranscriptView's
      // eventSignal). A block is exactly when the human opens the session to
      // see what the agent is stuck on, so the transcript has to refresh here
      // too. Every other observable hook branch broadcasts this; the
      // Notification case was the one that didn't, so a freshly blocked
      // session's last turn stayed absent until the 10s backstop timer.
      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });
      break;
    }

    default: {
      broadcast({
        type: "event:new",
        payload: { sessionId: session_id, type: hook_event_name },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Record every event for the silence meter and per-session scrollback.
  // SessionStart always creates the session row above first, so the events
  // table's session_id FK is satisfied no matter which branch ran.
  insertEvent(store.db, session_id, hook_event_name, payload);
  retireMootPermissionAsks(store, session_id, payload, broadcast);

  return hookOutput;
}

/**
 * Retires the permission asks a just-recorded event makes moot, so a prompt
 * answered in the terminal doesn't badge the Blocked view forever. A tied ask
 * goes once its own call is over (it finished, or its thread ended), never
 * because some other subagent's call finished. An ask tied to no call goes on
 * a new main-thread prompt, on a PostToolUse that names no call, or once no
 * call it could be about is still in flight.
 */
function retireMootPermissionAsks(store: Store, sessionId: string, payload: HookPayload, broadcast: WsBroadcast): void {
  const event = payload.hook_event_name as string;
  const finishing = event === "PostToolUse" || event === "PostToolUseFailure";
  if (!finishing && event !== "SubagentStop" && event !== "UserPromptSubmit" && event !== "Stop") return;
  const namesCall = typeof (payload as { tool_use_id?: unknown }).tool_use_id === "string";
  const untied = event === "UserPromptSubmit" || (finishing && !namesCall) ? "always" : "when-idle";
  const idleNotices = event === "UserPromptSubmit" || finishing;
  for (const stale of retirePermissionAsks(store.db, sessionId, { untied, idleNotices })) {
    broadcast({
      type: "ask:resolved",
      payload: { askId: stale.id, answer: "" },
      timestamp: new Date().toISOString(),
    });
  }
}
