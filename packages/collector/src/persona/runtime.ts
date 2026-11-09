import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type {
  Ask,
  PersonaApproval,
  PersonaContextMessage,
  PersonaInboxKind,
  PersonaJob,
  PersonaMessage,
  PersonaMessageJobTag,
  PersonaMessageNotify,
  PersonaReplyTo,
  PersonaRunState,
  PersonaState,
  WsMessage,
} from "@standup/shared";
import { PERSONA_SILENT_REPLY, approvalHeadline, describeCron, describeJobBudget, describeScheduleEnd } from "@standup/shared";
import {
  addPersonaMessageJobTags,
  addPersonaSessionImages,
  appendPersonaMessage,
  carryPersonaSessionImages,
  claimDuePersonaInboxForThread,
  claimPersonaBriefSlot,
  clearPersonaThreadSessions,
  countActivePersonaLaunches,
  countQueuedPersonaLaunches,
  countPendingPersonaInbox,
  countStartingPersonaJobLaunches,
  liveReviewTunnelsForJob,
  enqueuePersonaInbox,
  expirePersonaApprovals,
  failInterruptedPersonaApprovals,
  failPersonaInbox,
  getAsk,
  getFloorAskState,
  timeoutPendingAsk,
  getLatestCheckpoint,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaState,
  getPendingAsks,
  getPendingAsksBySession,
  getPersonaApproval,
  getPersonaInboxItem,
  getPersonaJob,
  getPersonaMessage,
  getPersonaThread,
  getPersonaThreadSessionId,
  getPlanApproval,
  getSession,
  getUserPrefs,
  hasDuePersonaInbox,
  listPendingPersonaInbox,
  personaInboxMentionedIds,
  latestPersonaBriefRun,
  listPersonaApprovals,
  listPersonaJobs,
  listPersonaCommitments,
  listPersonaMessages,
  listPersonaSchedules,
  dropPersonaCommitmentsByKeyPrefix,
  getLaunch,
  getLaunchBySession,
  getPipelineRunByLaunch,
  getReviewPacket,
  markPersonaCommitmentsNudged,
  markPersonaInboxDone,
  openPersonaCommitment,
  overduePersonaCommitmentsToNudge,
  pendingReviewPacketsForJob,
  prunePersonaCommitments,
  nextPersonaInboxDue,
  personaJobForSession,
  personaSessionImages,
  personaTappedQuestion,
  prunePersonaSessionImages,
  prunePersonaInbox,
  recordPersonaJobOwnerReply,
  listOpenPersonaQuestions,
  recordPersonaQuestionReply,
  recordPersonaTurn,
  releasePersonaJobOpenAsks,
  syncPersonaJobOpenAsk,
  refreshPersonaJob,
  removePersonaMessageJobTag,
  resetProcessingPersonaInbox,
  setPersonaThreadSessionId,
  settlePersonaBriefSlot,
  stagedPersonaAttachments,
  supersedePersonaApproval,
  transitionPersonaApproval,
  updatePersonaState,
} from "@standup/store";
import type { AppendPersonaMessageInput, PersonaInboxItem } from "@standup/store";
import { rotationTokens } from "./config.js";
import type { PersonaConfig } from "./config.js";
import { buildOwnerProfile, profilePromptText } from "./owner-profile.js";
import { JobBudgetMonitor } from "./budget.js";
import { captureApprovalDecision, captureOptionReply } from "./signals.js";
import { PERSONA_WRITER_HEADER } from "./memory-trust.js";
import {
  HANDOFF_OWNER_MESSAGES,
  HANDOFF_PROMPT,
  MAX_SNAPSHOT_COMMITMENTS,
  MAX_SNAPSHOT_OPEN_QUESTIONS,
  MAX_SNAPSHOT_SCHEDULES,
  OPEN_JOB_STATUSES,
  RECENT_CLOSED_JOB_WINDOW_MS,
  audienceLine,
  buildHandoffAnchors,
  buildSystemPrompt,
  buildTurnPrompt,
  composeHandoffNote,
} from "./prompt.js";
import type {
  SnapshotCommitment,
  SnapshotJob,
  SnapshotSchedule,
  ThreadHistoryMessage,
  TurnSnapshot,
  TurnThread,
} from "./prompt.js";
import {
  AUTO_KEYS,
  CLOSED_COMMITMENT_RETENTION_MS,
  COMMITMENTS_OVERDUE_EVENT,
  OVERDUE_RENUDGE_MS,
  autoCommitmentFor,
  commitmentHomeThread,
  commitmentVisibleIn,
  installAdvancedCommitment,
  launchKeyPrefix,
  settleCommitments,
} from "./commitments.js";
import type { TurnResult, TurnRunner } from "./turn.js";
import {
  SESSION_IMAGES_PRUNE_GRACE_MS,
  base64BytesOf,
  collectTurnMedia,
  withoutImages,
} from "./turn-media.js";
import type { TurnMedia } from "./turn-media.js";
import { composeReplyTags, jobMentions } from "./job-tags.js";
import type { MentionableJob } from "./job-tags.js";
import { RESTRICTED_ERROR_DETAIL, createPersonaTools } from "./tools.js";
import type { InProcessResponse, PersonaToolResult, PersonaTools } from "./tools.js";
import { askWakePayload, createPersonaEventRouter, isIdleNoticeAsk } from "./events.js";
import {
  DELEGATE_AGENTS,
  DELEGATE_ESCALATIONS_EVENT,
  ESCALATE_TOOL,
  FLOOR_ALLOW_REVIEW_EVENT,
  MAX_ESCALATIONS_PER_EVENT,
  delegateEventOf,
  routeEvent,
} from "./delegates.js";
import type { DelegateAgent } from "./delegates.js";
import { DelegateLane, laneContextSection } from "./delegate-lane.js";
import type { Escalation, LaneEvent } from "./delegate-lane.js";
import { PersonaScheduler, scheduleRunWakeKey } from "./scheduler.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { hostHeadroomView, hostMonitor, type HostMonitor } from "../host-headroom.js";
import { OWNER_TOKEN_HEADER, standupDataDir } from "@standup/shared/owner-token";
import { activeOwnerSecrets } from "../owner-secret.js";
import type { TurnSlots } from "./fleet.js";
import type { AllowChecker } from "./allow-check.js";
import { pipelineJobSummary, pipelineRunForSession } from "../pipeline/engine.js";
import { launchWorkLanded } from "../pipeline/runners.js";
import { isFloorGate } from "../floor/gate.js";
import { announceAskTimedOut } from "../asks.js";
import { closeSettledFloorCard, floorCardDeniesHold, ownerCardHoldsAsk, settleInterruptedFloorCards } from "./floor-cards.js";
import { APPROVAL_TTL_MS, BRIEF_GRACE_MS, briefEnabled, briefIsEmpty, briefSince, buildBriefDigest, jobNeedsOwner, latestBriefSlot, renderBriefDigest, sameLocalDay } from "./brief.js";
import { ownerTimezone } from "./cron.js";
import { notifyPrefsFor, pushIfRouted, routeUpdate } from "./notify.js";
import { decidePlaybook } from "./playbook-library.js";
import type { Board } from "../board/board.js";

type Broadcast = (message: WsMessage) => void;

/** Calls one of the collector's own routes in-process (Hono `app.request`). */
export type InProcessFetch = (path: string, init: RequestInit) => Response | Promise<Response>;

export interface PersonaRuntimeOptions {
  db: Database;
  owner: string;
  config: PersonaConfig;
  broadcast: Broadcast;
  turnRunner: TurnRunner;
  /** Authenticates the persona-mode MCP proxy; generated when omitted. */
  token?: string;
  /** The collector's local write token, presented on in-process writes. */
  writeToken?: string;
  /**
   * The owner secret, presented only while carrying out an action the owner
   * approved (`asOwner`). Defaults to the process's active secrets.
   */
  ownerToken?: () => string;
  /** Standup's data dir, where attached images are copied; defaults to the one holding DB_PATH. */
  dataDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Interval of the maintenance tick (due items, approval expiry). */
  tickMs?: number;
  /** Interval of the schedule loop's tick. */
  scheduleTickMs?: number;
  /** The host reading behind the budget line's effective cap; defaults to the collector's. */
  hostMonitor?: HostMonitor;
  /**
   * The host alias — the user whose credentials every worker runs with. A
   * runtime whose owner is someone else is a guest's. Defaults to `owner`.
   */
  host?: string;
  /** The host-wide turn slots this runtime takes one of around each turn; unlimited when omitted. */
  turnSlots?: TurnSlots;
  /** The directory this runtime's turns run in (see personaTurnCwd). */
  turnCwd?: string;
  /**
   * Whether the tick fires the owner's daily brief. On by default, except in
   * a test run (STANDUP_TEST), where a wall-clock brief would land in tests
   * that never asked for one.
   */
  dailyBrief?: boolean;
  /** The model layer of the second check on Persona's floor allows (allow-check.ts); absent runs the rules alone. */
  allowChecker?: AllowChecker;
  /** Interval of the job budget check (default JOB_BUDGET_CHECK_MS). */
  budgetCheckMs?: number;
  /** Reads a job's workers' cost (default jobWorkerCost, from their transcripts). */
  jobWorkerCost?: (jobId: string) => Promise<number>;
  /** The collector's Board, which search_board and launch_session's conflict note read; one over `db` when omitted. */
  board?: Board;
  /** The console's public base URL the doc tools link to (see PersonaToolEnv.consoleUrl); relative links when omitted. */
  consoleUrl?: string;
  /**
   * Builds a delegate agent's turn runner around the lane's token. Without
   * it no delegate lane runs, and every event goes to the main Persona.
   */
  delegateRunner?: (agent: DelegateAgent, token: string) => TurnRunner;
}

/** What a turn's cost-ledger row records beyond the turn's own result. */
interface TurnLedger {
  kind: "turn" | "handoff" | "delegate";
  threadId: string;
  epoch: number;
  /** The jobs the turn is attributed to, read once it has run. */
  jobIds: () => Iterable<string>;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;
/**
 * A schedule run's wake that fails transiently (expired credentials,
 * throttling, the model service or network down) is tried this many times in
 * all, SCHEDULE_WAKE_RETRY_BASE_MS·2^n apart: 4, 8 and 16 minutes, so the run gets
 * about half an hour to outlast a credential refresh. A wake that fails any
 * other way is not retried.
 */
export const SCHEDULE_WAKE_MAX_ATTEMPTS = 4;
export const SCHEDULE_WAKE_RETRY_BASE_MS = 4 * 60 * 1000;
/** How long before a carded safety-floor hold times out its decider is pushed a reminder. */
export const FLOOR_HOLD_REMIND_MS = 10 * 60 * 1000;
const IMMEDIATE_WORKER_EVENTS = new Set(["ask", "plan", "pipeline_blocked", DELEGATE_ESCALATIONS_EVENT]);
/** Most inbox items one turn takes; the rest stay pending for the next turn. */
export const MAX_TURN_ITEMS = 40;
/** Messages a non-private thread's fresh session is seeded with. */
const THREAD_HISTORY_MESSAGES = 10;
/** How long settled inbox items are kept before the tick prunes them. */
const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long after it closes a job still counts as named when a message mentions it. */
const MENTIONABLE_CLOSED_JOB_MS = 24 * 60 * 60 * 1000;

/** The jobs a thread's messages may be tagged with, and those mention matching looks for. */
interface TaggableJobs {
  allows(jobId: string): boolean;
  mentionable: MentionableJob[];
}

/** A reply whose last non-empty line is `[silent]` (any case) posts nothing. */
export function isSilentReply(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines[lines.length - 1]!.toLowerCase() === PERSONA_SILENT_REPLY.toLowerCase();
}

/** How far back a reply is compared against Persona's previous message in its thread. */
const DUPLICATE_REPLY_WINDOW_MS = 15 * 60 * 1000;
/** Share of words two replies must share to count as the same message. */
const DUPLICATE_REPLY_OVERLAP = 0.9;

function replyWords(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether `next` says the same as `previous`: equal once case, punctuation and
 * spacing are dropped, or sharing at least DUPLICATE_REPLY_OVERLAP of the
 * larger of their word sets.
 */
export function isNearDuplicateReply(previous: string, next: string): boolean {
  const a = replyWords(previous);
  const b = replyWords(next);
  if (a.join(" ") === b.join(" ")) return true;
  const setA = new Set(a);
  const setB = new Set(b);
  const larger = Math.max(setA.size, setB.size);
  if (larger === 0) return false;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / larger >= DUPLICATE_REPLY_OVERLAP;
}

/**
 * Persona's single-flight turn loop for one owner. Inbox items (owner
 * messages, worker events, wakeups, approval results) are durable and each
 * belongs to a thread: an owner message to the thread it was sent in, an item
 * about a job to that job's thread, anything else to the thread it was raised
 * from or the console thread. A turn claims the due items of one thread — the
 * thread of the oldest due item — runs one headless turn over them, replies in
 * that thread, and settles them done or back to pending with backoff. Only one
 * turn runs at a time; other threads' items and items arriving meanwhile are
 * picked up by follow-up turns.
 */
export class PersonaRuntime {
  readonly owner: string;
  /** The host alias; a runtime whose owner differs is a guest's. */
  readonly host: string;
  readonly token: string;
  /** Standup's data dir, holding the stored copies of attached images. */
  readonly dataDir: string;
  readonly config: PersonaConfig;
  readonly tools: PersonaTools;
  /** The owner's recurring schedules and the loop that fires them. */
  readonly schedules: PersonaScheduler;
  readonly budgets: JobBudgetMonitor;
  private readonly db: Database;
  private readonly broadcastFn: Broadcast;
  private readonly turnRunner: TurnRunner;
  private readonly writeToken?: string;
  /**
   * Secret on Persona's own in-process knowledge writes (PERSONA_WRITER_HEADER).
   * It never leaves this process, so no turn runner, worker or other caller
   * can present it.
   */
  private readonly writerSecret = randomBytes(32).toString("hex");
  private readonly ownerToken: () => string;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly hostMonitor: HostMonitor;
  private readonly turnSlots?: TurnSlots;
  /** The approval whose action is executing in the current async context (see approve()). */
  private readonly executing = new AsyncLocalStorage<PersonaApproval>();
  private fetcher?: InProcessFetch;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private thinking = false;
  private turnThreadId?: string;
  private batchKey?: string;
  private turnOwnerTexts: string[] = [];
  /** Jobs the running turn's tool calls acted on; its reply and owner messages are tagged with them. */
  private turnJobs = new Set<string>();
  /** Jobs the running turn closed, with the status each closed as; its reply is then a done update. */
  private turnClosedJobs = new Map<string, "done" | "failed" | "cancelled">();
  private readonly dailyBrief: boolean;
  /** The brief slot the tick last dealt with, so later ticks in the same slot write nothing. */
  private briefSlotHandled?: string;
  /** The running turn's tag_reply declarations for its reply. */
  private declaredReplyTags = { add: new Set<string>(), remove: new Set<string>() };
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeAt?: number;
  private tickTimer?: ReturnType<typeof setInterval>;
  private readonly selfActingIds = new Map<string, number>();
  private lastStateJson?: string;
  /** canAct() as of the last state publish; a fall to false re-announces asks Persona was holding. */
  private lastCanAct = false;
  /** Timers run only between start() and stop(); tests drive drain() directly. */
  private active = false;
  /** Set by quiesce(): no new turn starts until release(). */
  private held = false;
  /** Approved actions executing right now (see approve()). */
  private executingApprovals = 0;
  /** Owner approvals that came in while held, by approval id → who decided; run on release(). */
  private readonly deferredApprovals = new Map<string, string>();
  /** Cards whose safety-floor hold expiry reminder was pushed (remindExpiringHolds). */
  private readonly remindedHolds = new Set<string>();
  /**
   * Set on the host's runtime by its fleet (see expireUnservedApprovals):
   * whether an owner has a runtime of their own to expire their cards.
   */
  private hasRuntimeFor?: (owner: string) => boolean;
  /** The delegate agents' lanes that are on, by agent id (delegates.ts). */
  private readonly lanes = new Map<string, DelegateLane>();
  /** The lane whose tool call is running, so the tool layer acts for its turn rather than the main one. */
  private readonly laneCall = new AsyncLocalStorage<{ lane: DelegateLane; threadId: string; batchKey: string }>();

  constructor(opts: PersonaRuntimeOptions) {
    this.db = opts.db;
    this.owner = opts.owner;
    this.host = opts.host ?? opts.owner;
    this.turnSlots = opts.turnSlots;
    this.config = opts.config;
    this.broadcastFn = opts.broadcast;
    this.turnRunner = opts.turnRunner;
    this.token = opts.token ?? randomBytes(32).toString("hex");
    this.dataDir = opts.dataDir ?? standupDataDir();
    this.writeToken = opts.writeToken;
    this.ownerToken = opts.ownerToken ?? (() => activeOwnerSecrets().ownerToken);
    this.now = opts.now ?? (() => new Date());
    this.tickMs = opts.tickMs ?? 15_000;
    this.dailyBrief = opts.dailyBrief ?? process.env.STANDUP_TEST !== "1";
    this.hostMonitor = opts.hostMonitor ?? hostMonitor;
    this.tools = createPersonaTools({
      db: this.db,
      owner: this.owner,
      host: this.host,
      config: this.config,
      dataDir: this.dataDir,
      turnCwd: opts.turnCwd,
      allowChecker: opts.allowChecker,
      ...(opts.board ? { board: opts.board } : {}),
      ...(opts.consoleUrl ? { consoleUrl: opts.consoleUrl } : {}),
      request: (method, path, body, opts) => this.request(method, path, body, opts),
      // A delegate lane's call acts for its own turn: its thread and batch,
      // no owner words of the main turn, and nothing that tags the main reply.
      currentThreadId: () => this.laneCall.getStore()?.threadId ?? this.turnThreadId ?? this.consoleThreadId(),
      currentBatchKey: () => {
        const lane = this.laneCall.getStore();
        return lane ? lane.batchKey : this.batchKey;
      },
      currentTurnOwnerTexts: () => (this.laneCall.getStore() ? [] : [...this.turnOwnerTexts]),
      noteTurnJob: (jobId) => {
        if (this.batchKey && !this.laneCall.getStore()) this.turnJobs.add(jobId);
      },
      noteTurnClosedJob: (jobId, status) => {
        if (this.batchKey && !this.laneCall.getStore()) this.turnClosedJobs.set(jobId, status);
      },
      declareReplyTags: (change) => {
        if (!this.batchKey || this.laneCall.getStore()) return null;
        const { add, remove } = this.declaredReplyTags;
        for (const id of change.add) {
          add.add(id);
          remove.delete(id);
        }
        for (const id of change.remove) {
          remove.add(id);
          add.delete(id);
        }
        return { add: [...add], remove: [...remove] };
      },
      postMessage: (input) => this.postMessage(input),
      // A lane's calls show no "Persona is calling…" activity in the owner's thread.
      broadcast: (message) => {
        if (message.type === "persona:activity" && this.laneCall.getStore()) return;
        this.publish(message);
      },
      enqueue: (kind, payload, opts) => this.enqueue(kind, payload, opts),
      selfActing: (ids, fn) => this.withSelfActing(ids, fn),
      now: () => this.now(),
      schedules: () => this.schedules,
      budgetChanged: () => this.budgets.markDirty(),
      canReviewFlaggedAllow: (askId) => !!this.reviewLane(askId),
      reviewFlaggedAllow: (askId, review) => {
        const found = this.reviewLane(askId);
        if (!found) return false;
        found.lane.enqueue({ ...found.payload, type: FLOOR_ALLOW_REVIEW_EVENT, review }, this.jobThreadId(found.payload.jobId) ?? this.consoleThreadId());
        return true;
      },
      reviewInTurn: (askId) => this.laneCall.getStore()?.lane.reviewInTurn(askId),
    });
    this.schedules = new PersonaScheduler({
      db: this.db,
      owner: this.owner,
      now: () => this.now(),
      tickMs: opts.scheduleTickMs,
      launch: (schedule, run, launchOpts) =>
        this.tools.launchScheduled(schedule, run, { ...launchOpts, threadId: this.schedules.threadOf(schedule) }),
      wake: (schedule, run, threadId, changes) =>
        this.enqueue(
          "schedule",
          {
            note: schedule.note ?? "",
            scheduleId: schedule.id,
            scheduleTitle: schedule.title,
            runId: run.id,
            ...(changes ? { changes } : {}),
          },
          { threadId, coalesceKey: scheduleRunWakeKey(run.id) }
        ).id,
      notify: (schedule, run, threadId) =>
        void this.enqueue(
          "system",
          {
            type: "schedule_run",
            scheduleId: schedule.id,
            scheduleTitle: schedule.title,
            runId: run.id,
            status: run.status,
            ...(run.reason ? { reason: run.reason } : {}),
            ...(run.error ? { error: this.threadIsPrivate(threadId) ? run.error : RESTRICTED_ERROR_DETAIL } : {}),
          },
          { threadId }
        ),
      canFire: () => !this.held,
      isPaused: () => getOrCreatePersonaState(this.db, this.owner).paused,
      broadcast: (message) => this.publish(message),
    });
    this.budgets = new JobBudgetMonitor({
      db: this.db,
      owner: this.owner,
      now: () => this.now(),
      intervalMs: opts.budgetCheckMs,
      workerCost: opts.jobWorkerCost,
      notifyPersona: (job, budget, level, steered) =>
        void this.enqueue(
          "system",
          {
            type: "job_budget",
            level,
            jobId: job.id,
            jobTitle: job.title,
            spentUsd: budget.spentUsd,
            budgetUsd: budget.usd,
            elapsedMinutes: budget.elapsedMinutes,
            budgetMinutes: budget.minutes,
            steered,
          },
          { coalesceKey: `job-budget:${job.id}:${level}` }
        ),
      postSystem: (job, text) => void this.postMessage({ threadId: job.threadId, role: "system", text, jobIds: [job.id] }),
      broadcast: (message) => this.publish(message),
    });
    const delegateRunner = opts.delegateRunner;
    if (delegateRunner) {
      for (const agent of DELEGATE_AGENTS) {
        if (!this.config.delegates?.[agent.id]) continue;
        this.lanes.set(
          agent.id,
          new DelegateLane(
            agent,
            {
              db: this.db,
              now: () => this.now(),
              canRun: () => this.active && !this.held && !getOrCreatePersonaState(this.db, this.owner).paused,
              runTurn: (a, runner, threadId, events) => this.runLaneTurn(a, runner, threadId, events),
              escalate: (a, threadId, escalations) => this.deliverEscalations(a, threadId, escalations),
            },
            delegateRunner
          )
        );
      }
    }
  }

  /** Whether this is the host's own Persona (its owner's credentials are the workers'). */
  get isHost(): boolean {
    return this.owner === this.host;
  }

  /** Whether `value` is this runtime's writer secret, i.e. the request is Persona's own. */
  isOwnWrite(value: string | undefined): boolean {
    if (!value) return false;
    const given = Buffer.from(value);
    const secret = Buffer.from(this.writerSecret);
    return given.length === secret.length && timingSafeEqual(given, secret);
  }

  /** Binds the collector app whose routes the tool handlers call in-process. */
  bindApp(app: { request: InProcessFetch }): void {
    this.fetcher = (path, init) => app.request(path, init);
  }

  /** The broadcast-tap listener that turns owned-session frames into wakes. */
  eventListener(): (message: WsMessage) => void {
    return createPersonaEventRouter({
      db: this.db,
      owner: this.owner,
      dataDir: this.dataDir,
      coalesceMs: this.config.coalesceMs,
      enqueue: (kind, payload, opts) => {
        if (kind === "worker_event" && this.delegate(payload)) return;
        this.enqueue(kind, payload, {
          coalesceKey: opts?.coalesceKey,
          notBefore: opts?.delayMs ? new Date(this.now().getTime() + opts.delayMs).toISOString() : undefined,
        });
      },
      isSelfActing: (id) => this.selfActingIds.has(id),
      publishJob: (job) =>
        this.publish({ type: "persona:job", payload: job, timestamp: new Date().toISOString() }),
    });
  }

  // ── Delegate lanes ────────────────────────────────────────────────────────

  /** The delegate lanes that are on (delegates.ts), in registry order. */
  delegateLanes(): DelegateLane[] {
    return [...this.lanes.values()];
  }

  /**
   * Hands a worker event to the delegate agent the first matching route
   * names; false leaves it to the main Persona (no route matched, or its
   * agent is off).
   */
  private delegate(payload: Record<string, unknown>): boolean {
    if (this.lanes.size === 0) return false;
    const lane = this.laneFor(payload, (id) => this.lanes.has(id));
    if (!lane) return false;
    lane.enqueue(payload, this.jobThreadId(payload.jobId) ?? this.consoleThreadId());
    return true;
  }

  /** The lane the first route matching `payload` names among the agents `enabled` lets through. */
  private laneFor(payload: Record<string, unknown>, enabled: (agentId: string) => boolean): DelegateLane | undefined {
    const event = delegateEventOf(payload);
    const projectId = event.sessionId ? getSession(this.db, event.sessionId)?.projectId : undefined;
    const agentId = routeEvent({ ...event, ...(projectId ? { projectId } : {}) }, enabled);
    return agentId ? this.lanes.get(agentId) : undefined;
  }

  /**
   * The lane that is on and that the routes send the pending ask `askId` to,
   * with the ask's event as the router builds it: the reviewer of a flagged
   * high-risk allow of it. Undefined with the delegate off, so the owner's
   * card holds the hold as before.
   */
  private reviewLane(askId: string): { lane: DelegateLane; payload: Record<string, unknown> } | undefined {
    if (this.lanes.size === 0) return undefined;
    const ask = getAsk(this.db, askId);
    if (!ask || ask.status !== "pending") return undefined;
    const owned = personaJobForSession(this.db, ask.sessionId);
    if (!owned || owned.job.owner !== this.owner) return undefined;
    const payload = askWakePayload({ db: this.db, owner: this.owner, dataDir: this.dataDir }, ask, owned.job.id);
    const lane = this.laneFor(payload, (id) => this.lanes.has(id));
    return lane ? { lane, payload } : undefined;
  }

  /** Whether some route would hand `payload` to an agent, on or off. */
  private routable(payload: Record<string, unknown>): boolean {
    return routeEvent(delegateEventOf(payload), () => true) !== null;
  }

  /**
   * A tool call from a lane's turn: escalate is the lane's own; any other
   * tool on the agent's allowlist runs through the same tool layer as the
   * main Persona's calls, acting for the lane's turn (its thread and batch,
   * fixed when the call starts). Refused outside the lane's turn, for any
   * tool the agent doesn't have, and for an answer to an ask that isn't one
   * of the turn's own events.
   */
  async callForLane(lane: DelegateLane, name: string, args: Record<string, unknown>): Promise<PersonaToolResult> {
    const refuse = (text: string): PersonaToolResult => ({ content: [{ type: "text", text: `error: ${text}` }], isError: true });
    if (!lane.allows(name)) return refuse(`${name} is not one of ${lane.agent.id}'s tools`);
    const threadId = lane.currentThreadId();
    const batchKey = lane.currentBatchKey();
    if (!threadId || !batchKey) return refuse(`${lane.agent.id}'s tools run only inside its turn`);
    if (name === ESCALATE_TOOL) return lane.escalateCall(args);
    const askId = typeof args.askId === "string" ? args.askId.trim() : "";
    if (name === "answer_ask" && !lane.inTurn(askId)) return refuse(`${askId || "(no ask id)"} is not one of the events this turn is settling`);
    const refuseHeld = lane.agent.refuseHeld ? `Escalate it with ${ESCALATE_TOOL}, with your recommendation.` : undefined;
    return this.laneCall.run({ lane, threadId, batchKey }, () => this.tools.call(name, args, refuseHeld ? { refuseHeld } : {}));
  }

  /**
   * One turn of a delegate agent over `events` of `threadId`: Persona's own
   * system prompt (the thread's audience decides what of the owner's it
   * carries, as for a main turn) with the agent's role, and the main turn
   * prompt over the events and their jobs, with the agent's context. Fresh
   * session; charged to the events' jobs like any Persona turn on them.
   */
  private async runLaneTurn(
    agent: DelegateAgent,
    runner: TurnRunner,
    threadId: string,
    events: LaneEvent[]
  ): Promise<TurnResult | null> {
    const state = getOrCreatePersonaState(this.db, this.owner);
    const own = getPersonaThread(this.db, threadId);
    const thread: TurnThread =
      own && own.owner === this.owner
        ? { channel: own.channel, audience: own.audience, title: own.title }
        : { channel: "console", audience: "private" };
    const isPrivate = thread.audience === "private";
    const prefs = getUserPrefs(this.db, this.owner);
    const systemPrompt = [
      buildSystemPrompt({
        owner: this.owner,
        handoffNote: state.handoffNote,
        personalInstructions: prefs?.personalInstructions,
        audience: thread.audience,
        ...(isPrivate ? { ownerProfile: profilePromptText(buildOwnerProfile(this.db, this.owner)) } : {}),
      }),
      agent.role(this.owner),
    ].join("\n\n");
    const items: PersonaInboxItem[] = events.map((e) => ({
      id: e.id,
      owner: this.owner,
      kind: "worker_event",
      threadId,
      payload: e.payload,
      status: "processing",
      attempts: 0,
      createdAt: e.queuedAt,
    }));
    const jobIds = [...new Set(events.map((e) => e.payload.jobId).filter((id): id is string => typeof id === "string" && !!id))];
    const jobs = jobIds
      .map((id) => getPersonaJob(this.db, id))
      .filter((job): job is PersonaJob => !!job && job.owner === this.owner);
    const snapshot: TurnSnapshot = {
      jobs: jobs.map((job) => {
        const entry: SnapshotJob = OPEN_JOB_STATUSES.has(job.status)
          ? this.snapshotOpenJob(job, true)
          : { id: job.id, title: job.title, status: job.status, outcome: job.outcome, unboundLaunches: 0, sessions: [] };
        if (!agent.context.notes) delete entry.note;
        return entry;
      }),
      ...this.launchCapacity(),
    };
    const history = this.threadHistory(threadId, [], agent.context.ownerMessages);
    const prompt = buildTurnPrompt({
      items,
      snapshot,
      now: this.now(),
      owner: this.owner,
      thread,
      where: `You are deciding events for work in this thread; nothing you write is posted. ${audienceLine(thread, this.owner)}`,
      ...(history.length > 0 ? { history } : {}),
      extra: laneContextSection(this.db, agent, events, jobs),
    });
    return this.runTurn(
      {
        prompt,
        systemPrompt,
        model: this.config.model,
        effort: this.config.effort,
        timeoutMs: this.config.turnTimeoutMs,
        maxBudgetUsd: this.config.turnBudgetUsd,
      },
      { kind: "delegate", threadId, epoch: state.epoch, jobIds: () => jobIds },
      { runner }
    );
  }

  /**
   * Delivers a lane's escalations to its agent's target. Another agent's lane
   * gets each event back with the escalation on it; the main Persona gets
   * one delegate_escalations item per agent and thread (at most
   * MAX_ESCALATIONS_PER_EVENT escalations each), which later escalations
   * extend while it is still pending, so escalations that arrive together
   * wake the main thread once. Each escalated ask opens the commitment to
   * answer it, as an ask reaching the main Persona directly does. An event
   * goes to each agent once: one escalated back to an agent it already passed
   * through, or to an agent that is off, goes to the main Persona.
   */
  private deliverEscalations(agent: DelegateAgent, threadId: string, escalations: Escalation[]): void {
    const target = agent.escalateTo !== "main" ? this.lanes.get(agent.escalateTo) : undefined;
    const toMain: Escalation[] = [];
    for (const x of escalations) {
      // A review of a flagged high-risk allow that isn't settled goes to the owner's card, with the delegate's why.
      // One no card could take while its hold is still pending goes to the main Persona as the ask it is.
      if (x.event.type === FLOOR_ALLOW_REVIEW_EVENT) {
        let card: unknown = null;
        try {
          card = this.tools.raiseReviewedHold(x.eventId, x.why);
        } catch (err) {
          console.error(`[persona] raising the owner's card for a reviewed hold failed:`, err);
        }
        if (card || getAsk(this.db, x.eventId)?.status !== "pending") continue;
        const { review: _review, ...event } = x.event;
        toMain.push({ ...x, event: { ...event, type: "ask" } });
        continue;
      }
      const via = Array.isArray(x.event.escalatedVia) ? (x.event.escalatedVia as string[]) : [];
      if (!target || target.agent.id === agent.id || via.includes(target.agent.id)) {
        toMain.push(x);
        continue;
      }
      target.enqueue(
        { ...x.event, escalatedFrom: { agent: x.agent, recommendation: x.recommendation, why: x.why }, escalatedVia: [...via, agent.id] },
        threadId
      );
    }
    if (toMain.length === 0) return;
    for (const x of toMain) this.autoOpenCommitment("worker_event", x.event, threadId);
    const base = `${DELEGATE_ESCALATIONS_EVENT}:${agent.id}:${threadId}`;
    const pending = listPendingPersonaInbox(this.db, this.owner, "worker_event").filter(
      (i) => i.attempts === 0 && (i.coalesceKey === base || i.coalesceKey?.startsWith(`${base}:`))
    );
    const queue = [...toMain];
    for (const item of [...pending, null]) {
      if (queue.length === 0) return;
      const merged = new Map<string, Escalation>();
      for (const x of Array.isArray(item?.payload.escalations) ? (item.payload.escalations as Escalation[]) : []) merged.set(x.eventId, x);
      while (queue.length > 0 && (merged.size < MAX_ESCALATIONS_PER_EVENT || merged.has(queue[0]!.eventId))) {
        const x = queue.shift()!;
        merged.set(x.eventId, x);
      }
      const list = [...merged.values()];
      const jobIds = [...new Set(list.map((x) => x.jobId).filter((id): id is string => !!id))];
      this.enqueue(
        "worker_event",
        { type: DELEGATE_ESCALATIONS_EVENT, agent: agent.id, ...(jobIds[0] ? { jobId: jobIds[0] } : {}), jobIds, escalations: list },
        { threadId, coalesceKey: item?.coalesceKey ?? `${base}:${randomBytes(6).toString("hex")}` }
      );
    }
  }

  /**
   * Boot: a lane's queue lives in memory, so the owner's pending asks that a
   * route takes and that never reached the main Persona (no inbox item names
   * them, no owner card holds them) are routed again: to their lane, or, with
   * its agent off now, to the main Persona as the router would have.
   */
  private rerouteHeldAsks(): void {
    let mentioned: Set<string> | undefined;
    for (const ask of getPendingAsks(this.db)) {
      if (isIdleNoticeAsk(ask)) continue;
      const owned = personaJobForSession(this.db, ask.sessionId);
      if (!owned || owned.job.owner !== this.owner) continue;
      const payload = askWakePayload({ db: this.db, owner: this.owner, dataDir: this.dataDir }, ask, owned.job.id);
      if (!this.routable(payload)) continue;
      // Read once, on the first routable ask: boot runs before the collector
      // listens, so a scan of the inbox per ask would hold up its /health.
      mentioned ??= personaInboxMentionedIds(this.db, this.owner);
      if (mentioned.has(ask.id.toLowerCase()) || ownerCardHoldsAsk(this.db, this.owner, ask.id)) continue;
      if (!this.delegate(payload)) this.enqueue("worker_event", payload, { coalesceKey: `ask:${ask.id}` });
    }
  }

  /**
   * Boot: reclaim items a crashed turn left in `processing`, settle the
   * safety-floor cards a crash left mid-execution from their holds, fail the
   * other approvals it left so (their outcome is unknown, so they are not
   * re-run), start the tick, drain. A no-op while already started.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    resetProcessingPersonaInbox(this.db, this.owner);
    // A safety-floor card's outcome is read off its hold, and an allowed
    // criterion hold's worker is told to make the call that runs it.
    for (const card of settleInterruptedFloorCards(this.db, this.owner)) {
      this.publish({ type: "persona:approval", payload: card, timestamp: new Date().toISOString() });
      this.enqueueApprovalResult(card);
      if (card.status === "executed") {
        this.tools.tellCriterionRetry(card).catch((err) => {
          console.error(`[persona] telling the worker to retry ask ${String(card.args.askId)} failed:`, err);
        });
      }
    }
    for (const approval of failInterruptedPersonaApprovals(this.db, this.owner, "interrupted by a collector restart")) {
      this.publish({ type: "persona:approval", payload: approval, timestamp: new Date().toISOString() });
      this.enqueueApprovalResult(approval);
    }
    this.tickTimer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
    this.schedules.start();
    this.rerouteHeldAsks();
    this.kickLanes();
  }

  /** Starts each lane's loop that has events waiting and may run. */
  private kickLanes(): void {
    for (const lane of this.lanes.values()) lane.kick();
  }

  /**
   * Shutdown. Held asks are not re-announced: the process is exiting, and a
   * restart's boot re-reads them from the inbox and snapshot. A turn still
   * running (a restart's quiesce timed out on it) is killed with its whole
   * process group, so its tool calls can't reach the next leader and repeat
   * what it already did.
   */
  stop(): void {
    this.active = false;
    this.lastCanAct = false;
    this.schedules.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.tickTimer = undefined;
    this.wakeTimer = undefined;
    this.killTurns();
    this.publishState();
  }

  /** Kills every turn of this runtime still running, each with its process group; returns how many. */
  killTurns(): number {
    let killed = this.turnRunner.killRunning?.() ?? 0;
    for (const lane of this.lanes.values()) killed += lane.kill();
    if (killed > 0) console.log(`[persona] Killed ${killed} running turn(s) for ${this.owner} on shutdown`);
    return killed;
  }

  consoleThreadId(): string {
    return getOrCreatePersonaConsoleThread(this.db, this.owner).id;
  }

  // ── Inbox ─────────────────────────────────────────────────────────────────

  /**
   * Persists a wake item and schedules a drain for when it is due. Owner
   * messages, approval results and worker asks/plans are due now; other worker
   * events wait out the coalesce window (merging with a pending item under the
   * same key); a schedule is due at its `notBefore`. A wakeup fires in the
   * thread that scheduled it (`opts.threadId`) whatever job it names, since its
   * note was written for that thread's readers. An approval result goes to the
   * thread the approval was raised from (`opts.threadId`); another item naming
   * one of the owner's jobs (`payload.jobId`) belongs to the job's thread;
   * otherwise to `opts.threadId`, else the console thread.
   */
  enqueue(
    kind: PersonaInboxKind,
    payload: Record<string, unknown>,
    opts: { threadId?: string; coalesceKey?: string; notBefore?: string } = {}
  ): PersonaInboxItem {
    let notBefore = opts.notBefore;
    if (
      kind === "worker_event" &&
      notBefore === undefined &&
      !IMMEDIATE_WORKER_EVENTS.has(String(payload.type)) &&
      this.config.coalesceMs > 0
    ) {
      notBefore = new Date(this.now().getTime() + this.config.coalesceMs).toISOString();
    }
    const { item } = enqueuePersonaInbox(this.db, {
      owner: this.owner,
      kind,
      payload,
      threadId:
        kind === "user_message" || kind === "schedule" || (kind === "approval_result" && opts.threadId)
          ? opts.threadId
          : this.jobThreadId(payload.jobId) ?? opts.threadId,
      coalesceKey: opts.coalesceKey,
      notBefore,
    });
    this.autoOpenCommitment(kind, payload, item.threadId);
    this.scheduleWake();
    this.publishState();
    return item;
  }

  // ── Commitments ───────────────────────────────────────────────────────────

  /**
   * Opens the commitment a wake item predictably hands Persona (see
   * autoCommitmentFor), unless the same one is already open. A failure is
   * logged and never fails the enqueue.
   */
  private autoOpenCommitment(kind: PersonaInboxKind, payload: Record<string, unknown>, threadId: string | undefined): void {
    try {
      const input = autoCommitmentFor(kind, payload, { db: this.db, owner: this.owner, threadId, nowMs: this.now().getTime() });
      if (!input?.autoKey) return;
      const key = input.autoKey;
      const jobId = input.jobId;
      // Each launch of a job lands on its own; its landing and pipeline
      // commitments are keyed `<kind>:<launchId>/…`.
      const launch = launchKeyPrefix(AUTO_KEYS.pipelineComplete, key) ?? launchKeyPrefix(AUTO_KEYS.reviewApproved, key);
      // Approving a packet completes its pipeline in the same breath; the
      // landing commitment already carries what is left for that launch, so
      // the pipeline's verify-and-close would only contradict it.
      if (key.startsWith(AUTO_KEYS.pipelineComplete) && jobId && launch) {
        const landing = listPersonaCommitments(this.db, this.owner, { status: "open", jobId }).some((c) =>
          c.autoKey?.startsWith(`${AUTO_KEYS.reviewApproved}${launch}`)
        );
        if (landing) return;
      }
      const { created } = openPersonaCommitment(this.db, input);
      // A launch lands once: its newer approved packet supersedes its earlier
      // landing commitment and its pipeline's verify-and-close.
      if (created && key.startsWith(AUTO_KEYS.reviewApproved) && launch && launch !== "-/") {
        for (const kind of [AUTO_KEYS.reviewApproved, AUTO_KEYS.pipelineComplete]) {
          dropPersonaCommitmentsByKeyPrefix(this.db, {
            owner: this.owner,
            prefix: `${kind}${launch}`,
            keep: key,
            evidence: "superseded by the launch's newer approved review (checked by the collector)",
            closedAt: this.now().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error("[persona] could not open the commitment for a wake:", err);
    }
  }

  /**
   * Opens the commitment a fast-forward of the install's main to `head`
   * hands Persona: verify the restart, then close the landed batch's jobs.
   */
  noteInstallAdvanced(head: string): void {
    if (!/^[0-9a-f]{7,64}$/i.test(head)) return;
    try {
      const input = installAdvancedCommitment(this.owner, head, this.now().getTime());
      const { created } = openPersonaCommitment(this.db, { ...input, threadId: this.consoleThreadId() });
      // The newest head's restart report covers what the earlier ones brought in.
      if (created) {
        dropPersonaCommitmentsByKeyPrefix(this.db, {
          owner: this.owner,
          prefix: AUTO_KEYS.installAdvanced,
          keep: input.autoKey!,
          evidence: "superseded by a newer install head (checked by the collector)",
          closedAt: this.now().toISOString(),
        });
      }
    } catch (err) {
      console.error("[persona] could not open the commitment for an install fast-forward:", err);
    }
  }

  /** Settles the commitments the collector can check (see settleCommitments), reading a review's landing from its launch. */
  private settleCommitments(nowMs: number): void {
    settleCommitments(this.db, this.owner, new Date(nowMs).toISOString(), {
      reviewLanded: (packetId) => {
        const launchId = getReviewPacket(this.db, packetId, this.owner)?.launchId;
        const launch = launchId ? getLaunch(this.db, launchId) : null;
        const run = launchId ? getPipelineRunByLaunch(this.db, launchId) : null;
        return !!launch && !!run && launchWorkLanded(this.db, run, launch);
      },
    });
  }

  /**
   * Wakes Persona about the commitments it owes that went stale, once when
   * each goes overdue and again every OVERDUE_RENUDGE_MS while it stays so —
   * one system item per commitment's home thread (its job's thread, since a
   * turn elsewhere can't write to it; else the thread it was opened in; else
   * the console; see commitmentHomeThread), coalesced with any still pending
   * there.
   */
  private nudgeOverdueCommitments(nowMs: number): void {
    const now = new Date(nowMs).toISOString();
    const overdue = overduePersonaCommitmentsToNudge(
      this.db,
      this.owner,
      now,
      new Date(nowMs - OVERDUE_RENUDGE_MS).toISOString()
    );
    if (overdue.length === 0) return;
    const byThread = new Map<string, string[]>();
    const consoleId = this.consoleThreadId();
    for (const c of overdue) {
      const threadId = commitmentHomeThread(this.db, this.owner, c, consoleId).id;
      byThread.set(threadId, [...(byThread.get(threadId) ?? []), c.id]);
    }
    markPersonaCommitmentsNudged(this.db, overdue.map((c) => c.id), now);
    for (const [threadId, ids] of byThread) {
      this.enqueue(
        "system",
        { type: COMMITMENTS_OVERDUE_EVENT, commitmentIds: ids, count: ids.length },
        { threadId, coalesceKey: `${COMMITMENTS_OVERDUE_EVENT}:${threadId}` }
      );
    }
  }

  /** The thread of the owner's job `jobId`, when it names one. */
  private jobThreadId(jobId: unknown): string | undefined {
    if (typeof jobId !== "string" || !jobId) return undefined;
    const job = getPersonaJob(this.db, jobId);
    return job && job.owner === this.owner ? job.threadId : undefined;
  }

  /**
   * Arms one timer for the earliest pending item; a due item drains on the
   * next tick of the loop. Nothing is armed while held (release() re-arms), so
   * a held runtime with due items doesn't spin through empty drains.
   */
  private scheduleWake(): void {
    if (!this.active || this.held || getOrCreatePersonaState(this.db, this.owner).paused) return;
    const nowMs = this.now().getTime();
    const deferred = nextPersonaInboxDue(this.db, this.owner);
    const hasDueNow = hasDuePersonaInbox(this.db, this.owner, new Date(nowMs).toISOString());
    const at = hasDueNow ? nowMs : deferred ? Date.parse(deferred) : undefined;
    if (at === undefined) return;
    if (this.wakeTimer && this.wakeAt !== undefined && this.wakeAt <= at) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    // Armed outside any lane call's context, so the main drain it starts acts for the main turn.
    this.wakeTimer = this.laneCall.exit(() =>
      setTimeout(() => {
        this.wakeTimer = undefined;
        this.wakeAt = undefined;
        void this.drain();
      }, Math.max(0, at - nowMs))
    );
  }

  // ── Turn loop ─────────────────────────────────────────────────────────────

  /**
   * Single-flight: a call while a drain runs flags a follow-up and returns the
   * running drain's promise, so items enqueued mid-turn get their own turn
   * right after rather than racing it.
   */
  drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.runOnce();
        } while (this.drainAgain);
      } finally {
        this.draining = null;
        this.scheduleWake();
      }
    })();
    return this.draining;
  }

  private async runOnce(): Promise<void> {
    // Held for a collector restart: due items stay pending in the inbox and
    // the next collector's start() drains them.
    if (this.held) return;
    const state = getOrCreatePersonaState(this.db, this.owner);
    if (state.paused) {
      this.publishState({ onlyIfChanged: true });
      return;
    }
    let ids: string[] = [];
    let turnThreadId: string | undefined;
    try {
      const consoleId = this.consoleThreadId();
      const claimed = claimDuePersonaInboxForThread(
        this.db,
        this.owner,
        consoleId,
        this.now().toISOString(),
        MAX_TURN_ITEMS
      );
      if (!claimed || claimed.items.length === 0) return;
      // An ask answered elsewhere while Persona was paused or behind (a Slack
      // card, the console) is settled; relaying it again would ask twice.
      const settled = claimed.items.filter((i) => this.isSettledAskItem(i));
      if (settled.length > 0) markPersonaInboxDone(this.db, settled.map((i) => i.id));
      const items = claimed.items.filter((i) => !settled.includes(i)).map((i) => this.withoutSettledEscalations(i));
      if (items.length === 0) {
        if (hasDuePersonaInbox(this.db, this.owner, this.now().toISOString())) this.drainAgain = true;
        return;
      }
      ids = items.map((i) => i.id);
      const claimedThread = getPersonaThread(this.db, claimed.threadId);
      const ownThread = claimedThread && claimedThread.owner === this.owner ? claimedThread : null;
      const threadId = ownThread ? ownThread.id : consoleId;
      const thread: TurnThread = ownThread
        ? { channel: ownThread.channel, audience: ownThread.audience, title: ownThread.title }
        : { channel: "console", audience: "private" };
      // Private threads (the console, DMs) share the owner's session; any
      // other thread runs on its own, so it can't recall private history.
      const isPrivate = thread.audience === "private";
      turnThreadId = threadId;
      this.turnThreadId = threadId;
      this.batchKey = createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
      this.turnOwnerTexts = items
        .filter((i) => i.kind === "user_message" && typeof i.payload.text === "string")
        .map((i) => i.payload.text as string);
      this.turnJobs = new Set();
      this.turnClosedJobs = new Map();
      this.declaredReplyTags = { add: new Set(), remove: new Set() };
      this.thinking = true;
      // A reset() while this turn runs starts a new epoch; the turn's session
      // and context size then belong to the abandoned epoch and are not saved.
      let epoch = state.epoch;

      this.publishState();
      const prefs = getUserPrefs(this.db, this.owner);
      const systemPromptWith = (handoffNote: string | undefined) =>
        buildSystemPrompt({
          owner: this.owner,
          handoffNote,
          personalInstructions: prefs?.personalInstructions,
          audience: thread.audience,
          ...(isPrivate ? { ownerProfile: profilePromptText(buildOwnerProfile(this.db, this.owner)) } : {}),
          ...(this.lanes.size > 0 ? { delegates: this.delegateLanes().map((l) => ({ id: l.agent.id, purpose: l.agent.purpose })) } : {}),
        });
      let systemPrompt = systemPromptWith(state.handoffNote);
      const snapshot = { ...this.snapshot(isPrivate ? undefined : threadId), ...this.snapshotOpenQuestions(threadId) };
      // The images and videos the owner's messages carry, listed in the
      // prompt and shown as image blocks after it.
      let media: TurnMedia = { byMessage: new Map(), images: [] };
      try {
        // One turn never sends more than a whole session may be sent.
        media = collectTurnMedia({
          db: this.db,
          dataDir: this.dataDir,
          owner: this.owner,
          threadId,
          privateThread: isPrivate,
          items,
          sessionImageBudget: this.config.sessionImageBudget,
          sessionImageBytesBudget: this.config.sessionImageBytesBudget,
        });
      } catch (err) {
        console.error("[persona] could not read the turn's owner media:", err);
      }
      // A non-private thread's turn that starts a fresh session (first turn,
      // rotation, reset, a lost session) carries the thread's recent messages,
      // so the conversation survives the new session.
      const promptFor = (fresh: boolean) =>
        buildTurnPrompt({
          items,
          snapshot,
          now: this.now(),
          owner: this.owner,
          thread,
          ...(fresh && !isPrivate ? { history: this.threadHistory(threadId, items) } : {}),
          ...(media.byMessage.size > 0 ? { attachments: media.byMessage } : {}),
        });
      /** Drops the turn's stored session, so the next call starts a fresh one. */
      const forgetSession = () => {
        if (!isPrivate) setPersonaThreadSessionId(this.db, threadId, null);
        else if (this.epochIs(epoch)) updatePersonaState(this.db, this.owner, { claudeSessionId: null });
      };
      // The turn's cost is attributed to the jobs its items are about and the
      // jobs its calls acted on, read once the turn has run.
      const itemJobs = items
        .flatMap((i) => [i.payload.jobId, ...(Array.isArray(i.payload.jobIds) ? i.payload.jobIds : [])])
        .filter((id): id is string => typeof id === "string" && !!id);
      /**
       * One call of the turn. Its images count against the session they were
       * sent to as soon as the call ran (whatever its outcome): the resumed
       * session, or the fresh one a successful call reports.
       */
      const call = async (resumeSessionId: string | undefined) => {
        const sent = media.images;
        const ledger: TurnLedger = { kind: "turn", threadId, epoch, jobIds: () => [...itemJobs, ...this.turnJobs] };
        const result = await this.runTurn(
          {
            prompt: promptFor(!resumeSessionId),
            ...(sent.length > 0 ? { images: sent } : {}),
            systemPrompt,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            model: this.config.model,
            effort: this.config.effort,
            timeoutMs: this.config.turnTimeoutMs,
            maxBudgetUsd: this.config.turnBudgetUsd,
            autoCompactPct: this.config.autoCompactPct,
          },
          ledger
        );
        const counted = resumeSessionId ?? (result?.ok ? result.sessionId : undefined);
        const at = this.now().toISOString();
        if (result && counted) addPersonaSessionImages(this.db, counted, sent.length, base64BytesOf(sent), at);
        // A resumed call that reports another session id carries the history,
        // and so what that history was sent.
        if (resumeSessionId && result?.ok && result.sessionId !== resumeSessionId) {
          carryPersonaSessionImages(this.db, resumeSessionId, result.sessionId, at);
        }
        return result;
      };
      /**
       * Moves the turn off its resumed session: a private thread's is rotated
       * (a handoff note, then a fresh epoch), any other thread's dropped (its
       * fresh session gets the thread's history). "held" when the handoff
       * turn didn't run to an end (held for a restart, killed by a shutdown):
       * the session is kept, and the turn must give its items back.
       */
      const leaveSession = async (sessionId: string): Promise<"left" | "held"> => {
        if (!isPrivate) {
          forgetSession();
          return "left";
        }
        const outcome = await this.rotate(sessionId, systemPrompt, epoch);
        if (outcome === "held") return "held";
        const now = getOrCreatePersonaState(this.db, this.owner);
        if (now.epoch !== epoch) {
          epoch = now.epoch;
          systemPrompt = systemPromptWith(now.handoffNote);
        } else if (outcome === "rotated") {
          forgetSession();
        }
        return "left";
      };
      /** Gives the turn's items back to the inbox, with no attempt counted (as for a held or killed turn). */
      const giveBack = () => {
        resetProcessingPersonaInbox(this.db, this.owner, ids);
        ids = [];
      };

      prunePersonaSessionImages(this.db, [], new Date(this.now().getTime() - SESSION_IMAGES_PRUNE_GRACE_MS).toISOString());
      let resume = isPrivate ? state.claudeSessionId : getPersonaThreadSessionId(this.db, threadId);
      // The API's per-request image and size limits cover a resumed session's
      // whole history, so a session that this turn's images (with what it was
      // already sent) would take past its budget is left for a fresh one. A
      // session sent no images yet needs no leaving: the turn alone is held
      // to the budgets.
      if (resume && media.images.length > 0) {
        const sent = personaSessionImages(this.db, resume);
        if (
          sent.images > 0 &&
          (sent.images + media.images.length > this.config.sessionImageBudget ||
            sent.base64Bytes + base64BytesOf(media.images) > this.config.sessionImageBytesBudget)
        ) {
          if ((await leaveSession(resume)) === "held") {
            giveBack();
            return;
          }
          resume = undefined;
        }
      }
      let result = await call(resume);
      // A resumed session the CLI no longer knows gets one more try on a fresh
      // session; so does a request the API refused over its images or size,
      // leaving the session the way a budget would (images Persona saw there
      // may have come from anywhere in its history). A fresh session refused
      // over its images tries once more without them.
      if (result && !result.ok && resume && result.sessionNotFound) {
        forgetSession();
        resume = undefined;
        result = await call(undefined);
      } else if (result && !result.ok && resume && result.mediaRejected) {
        console.warn(`[persona] the model API refused a request on session ${resume}; moving to a fresh session: ${result.error}`);
        if ((await leaveSession(resume)) === "held") {
          giveBack();
          return;
        }
        resume = undefined;
        result = await call(undefined);
      }
      if (result && !result.ok && !resume && result.mediaRejected && media.images.length > 0) {
        console.warn(`[persona] the model API refused this turn's images; retrying without them: ${result.error}`);
        media = withoutImages(media, `the model API refused the images (${result.error.slice(0, 200)})`);
        result = await call(undefined);
      }

      // Held for a restart while waiting for a turn slot, or killed by a
      // shutdown: the items go back to pending with no attempt counted, for
      // the turn after release() or the next boot.
      if (!result || (!result.ok && result.killed)) {
        resetProcessingPersonaInbox(this.db, this.owner, ids);
        ids = [];
        return;
      }

      if (!result.ok) {
        this.settleFailure(ids, result.error, threadId, result.transient === true);
        return;
      }

      markPersonaInboxDone(this.db, ids);
      this.schedules.wakesHandled(
        items.flatMap((i) => (i.kind === "schedule" && typeof i.payload.scheduleId === "string" ? [i.payload.scheduleId] : []))
      );
      const sameEpoch = this.epochIs(epoch);
      // A backstop to the CLI's auto-compaction, which keeps a session below this size, so it
      // fires only when compaction failed.
      const pastRotation = (result.contextTokens ?? 0) > rotationTokens(this.config, result.contextWindow);
      updatePersonaState(this.db, this.owner, {
        ...(sameEpoch && isPrivate
          ? { claudeSessionId: result.sessionId, lastContextTokens: result.contextTokens ?? null }
          : {}),
        lastTurnAt: this.now().toISOString(),
        lastError: null,
      });
      if (!isPrivate && sameEpoch) {
        // A non-private thread has no handoff note: a session grown past the
        // rotation size starts fresh, and that next turn is seeded with the
        // thread's recent messages instead (see threadHistory).
        setPersonaThreadSessionId(this.db, threadId, pastRotation ? null : result.sessionId);
      }
      // A reply written beside a tool call, with no text after it, is still
      // the reply: only an explicit [silent] posts nothing.
      let reply = result.text.trim();
      if (!reply && result.earlierText?.trim()) {
        console.warn(`[persona] the turn's final message had no text; posting its last written text in thread ${threadId}`);
        reply = result.earlierText.trim();
      }
      // The items are settled: tagging is best-effort, and a failure to tag
      // posts the reply untagged rather than failing the turn.
      let taggable: TaggableJobs | undefined;
      try {
        taggable = this.taggableJobs(threadId, isPrivate);
        this.tagOwnerMessages(items, taggable);
      } catch (err) {
        console.error("[persona] could not tag the turn's owner messages:", err);
      }
      const tagsFor = (text: string): PersonaMessageJobTag[] => {
        if (!taggable) return [];
        try {
          return this.replyTags(items, text, taggable);
        } catch (err) {
          console.error("[persona] could not tag the turn's reply:", err);
          return [];
        }
      };
      // Images and videos attached this turn ride on its reply, which posts even when its
      // text alone would have been silent or a repeat.
      const attachmentIds = this.batchKey
        ? stagedPersonaAttachments(this.db, threadId, this.batchKey).map((a) => a.id)
        : [];
      let posted = false;
      if (attachmentIds.length > 0) {
        const text = isSilentReply(reply) ? "" : reply;
        const tags = tagsFor(text);
        this.postRouted({ threadId, role: "persona", text, attachmentIds }, tags, this.replyRoute(items, tags));
        posted = !!text;
      } else if (!isSilentReply(reply)) {
        if (this.repeatsLastReply(threadId, reply)) {
          console.warn(`[persona] dropped a reply that repeats the previous one in thread ${threadId}`);
        } else {
          const tags = tagsFor(reply);
          this.postRouted({ threadId, role: "persona", text: reply }, tags, this.replyRoute(items, tags));
          posted = true;
        }
      }
      this.settleBrief(items, posted);

      // The reply is posted: nothing staged from here on (a late attach, the
      // handoff turn) would ride on it.
      this.batchKey = undefined;
      if (isPrivate && sameEpoch && pastRotation) {
        await this.rotate(result.sessionId, systemPrompt, epoch);
      }
    } catch (err) {
      if (ids.length > 0) this.settleFailure(ids, (err as Error).message || "turn failed", turnThreadId);
      else console.error("[persona] could not start a turn:", err);
    } finally {
      // Due items left behind — another thread's, or past MAX_TURN_ITEMS — get the next turn.
      if (ids.length > 0 && hasDuePersonaInbox(this.db, this.owner, this.now().toISOString())) this.drainAgain = true;
      this.thinking = false;
      this.turnThreadId = undefined;
      this.batchKey = undefined;
      this.turnOwnerTexts = [];
      this.turnJobs = new Set();
      this.turnClosedJobs = new Map();
      this.declaredReplyTags = { add: new Set(), remove: new Set() };
      this.publishState();
    }
  }

  /**
   * One Claude turn, inside one of the host's turn slots when the runtime
   * shares them; null, with no turn run, when a quiesce() hold began while it
   * waited for the slot. A delegate lane's turn runs on its own runner and
   * outside the slots, so it and the main Persona never wait on each other.
   */
  private async runTurn(
    input: Parameters<TurnRunner>[0],
    ledger: TurnLedger,
    lane?: { runner: TurnRunner }
  ): Promise<TurnResult | null> {
    const release = this.turnSlots && !lane ? await this.turnSlots.acquire() : undefined;
    if (this.held) {
      release?.();
      return null;
    }
    const startedAt = this.now();
    let result: TurnResult | undefined;
    try {
      result = await (lane?.runner ?? this.turnRunner)(input);
      return result;
    } finally {
      release?.();
      this.recordTurn(ledger, startedAt, result, input.resumeSessionId);
    }
  }

  /**
   * Writes the turn's row to Persona's cost ledger, attributed to the jobs
   * `ledger` names that are this owner's. Best-effort: a ledger failure never
   * fails the turn.
   */
  private recordTurn(ledger: TurnLedger, startedAt: Date, result: TurnResult | undefined, resumedSessionId: string | undefined): void {
    try {
      const jobIds = [...new Set(ledger.jobIds())].filter((id) => {
        const job = getPersonaJob(this.db, id, { withView: false });
        return !!job && job.owner === this.owner;
      });
      const turn = recordPersonaTurn(this.db, {
        user: this.owner,
        threadId: ledger.threadId,
        jobIds,
        kind: ledger.kind,
        ok: !!result?.ok,
        startedAt: startedAt.toISOString(),
        durationMs: this.now().getTime() - startedAt.getTime(),
        // The turn's own cost is worked out from this and the session's previous report.
        reportedCostUsd: result?.costUsd ?? null,
        claudeSessionId: result?.claudeSessionId ?? resumedSessionId ?? (result?.ok ? result.sessionId : null),
        resumed: !!resumedSessionId,
        resumedSessionId: resumedSessionId ?? null,
        inputTokens: result?.inputTokens,
        outputTokens: result?.outputTokens,
        model: result?.model ?? this.config.model,
        epoch: ledger.epoch,
      });
      // The turn's share may have taken a job over a threshold: check on the next tick.
      if (jobIds.length > 0 && (turn.costUsd ?? 0) > 0) this.budgets.markDirty();
    } catch (err) {
      console.error("[persona] could not record the turn's cost:", err);
    }
  }

  private epochIs(epoch: number): boolean {
    return getOrCreatePersonaState(this.db, this.owner).epoch === epoch;
  }

  /**
   * Settles a failed turn's items. Once items give up, the thread hears of it:
   * a private thread gets the items and the error; a thread other people read
   * gets only a generic notice, since the error can carry paths, stderr and
   * the items' own text (the details stay in the console's state and logs).
   * A schedule run's wake is retried on its own terms: on a `transient`
   * failure (the turn runner's verdict) SCHEDULE_WAKE_MAX_ATTEMPTS times,
   * otherwise not at all; see reportFailedScheduleWake for its give-up.
   */
  private settleFailure(ids: string[], error: string, threadId = this.consoleThreadId(), transient = false): void {
    const nowMs = this.now().getTime();
    const wakeIds: string[] = [];
    const otherIds: string[] = [];
    for (const id of ids) {
      const item = getPersonaInboxItem(this.db, id);
      (item && scheduleRunOfWake(item) ? wakeIds : otherIds).push(id);
    }
    const { failed } = failPersonaInbox(this.db, otherIds, error, {
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: RETRY_BASE_MS,
      nowMs,
    });
    if (wakeIds.length > 0) {
      const wakes = failPersonaInbox(this.db, wakeIds, error, {
        maxAttempts: transient ? SCHEDULE_WAKE_MAX_ATTEMPTS : 1,
        baseDelayMs: SCHEDULE_WAKE_RETRY_BASE_MS,
        nowMs,
      });
      for (const item of wakes.failed) this.reportFailedScheduleWake(item, error);
    }
    updatePersonaState(this.db, this.owner, { lastError: error });
    // A brief given up on is settled, so it doesn't read as queued for good.
    for (const item of failed) {
      if (item.kind === "schedule" && item.payload.brief === true && typeof item.payload.slot === "string") {
        settlePersonaBriefSlot(this.db, this.owner, item.payload.slot, { status: "skipped", inboxId: item.id, detail: `failed: ${error}` });
      }
    }
    if (failed.length > 0) {
      const isPrivate = this.threadIsPrivate(threadId);
      if (!isPrivate) console.error(`[persona] gave up on ${failed.length} item(s) in thread ${threadId}: ${error}`);
      const what = failed.map((i) => describeItem(i)).join("; ");
      this.postMessage({
        threadId,
        role: "system",
        text: isPrivate
          ? `Persona could not process ${failed.length === 1 ? "an item" : `${failed.length} items`} after ${MAX_ATTEMPTS} attempts (${what}): ${error}`
          : "I hit an error and couldn't finish this — details are in the Standup console.",
      });
    }
  }

  /**
   * Reports a schedule run's wake given up on, in the schedule's thread: one
   * `schedule_run` event naming the schedule and the error, so Persona can
   * tell the owner or run the schedule again, and a system message naming
   * the schedule, which the owner sees even while Persona's turns keep
   * failing. As in settleFailure, the error itself goes only to a private
   * thread.
   */
  private reportFailedScheduleWake(item: PersonaInboxItem, error: string): void {
    const p = item.payload;
    const threadId = item.threadId ?? this.consoleThreadId();
    const isPrivate = this.threadIsPrivate(threadId);
    const tries = item.attempts === 1 ? "1 attempt" : `${item.attempts} attempts`;
    const detail = isPrivate ? error : RESTRICTED_ERROR_DETAIL;
    const title = typeof p.scheduleTitle === "string" ? p.scheduleTitle : "a schedule";
    if (!isPrivate) console.error(`[persona] schedule run ${String(p.runId)} gave up after ${tries}: ${error}`);
    this.enqueue(
      "system",
      {
        type: "schedule_run",
        scheduleId: p.scheduleId,
        scheduleTitle: p.scheduleTitle,
        runId: p.runId,
        status: "failed",
        error: `gave up after ${tries}: ${detail}`.slice(0, 500),
      },
      { threadId }
    );
    this.postMessage({
      threadId,
      role: "system",
      text: `Schedule "${title}" didn't run: Persona gave up after ${tries} (${detail}).`.slice(0, 700),
    });
  }

  /** Whether `threadId` is read by the owner alone (an unknown thread counts as private). */
  private threadIsPrivate(threadId: string): boolean {
    const thread = getPersonaThread(this.db, threadId);
    return !thread || thread.owner !== this.owner || thread.audience === "private";
  }

  /**
   * Whether `item` relays a worker ask that is no longer pending (answered or
   * cancelled elsewhere), or only escalations of such asks.
   */
  private isSettledAskItem(item: PersonaInboxItem): boolean {
    if (item.kind !== "worker_event") return false;
    if (item.payload.type === DELEGATE_ESCALATIONS_EVENT) {
      const escalations = Array.isArray(item.payload.escalations) ? (item.payload.escalations as Escalation[]) : [];
      return escalations.every((x) => this.isSettledAskPayload(x.event));
    }
    return item.payload.type === "ask" && this.isSettledAskPayload(item.payload);
  }

  /** Whether a worker-ask payload's ask is no longer pending; false for any other payload. */
  private isSettledAskPayload(payload: Record<string, unknown> | undefined): boolean {
    if (!payload || payload.type !== "ask") return false;
    const askId = (payload.ask as { id?: unknown } | undefined)?.id;
    if (typeof askId !== "string" || !askId) return false;
    const ask = getAsk(this.db, askId);
    return !!ask && ask.status !== "pending";
  }

  /** An escalations item as this turn shows it: without the escalated asks settled meanwhile. */
  private withoutSettledEscalations(item: PersonaInboxItem): PersonaInboxItem {
    if (item.kind !== "worker_event" || item.payload.type !== DELEGATE_ESCALATIONS_EVENT || !Array.isArray(item.payload.escalations)) return item;
    const open = (item.payload.escalations as Escalation[]).filter((x) => !this.isSettledAskPayload(x.event));
    return { ...item, payload: { ...item.payload, escalations: open } };
  }

  /**
   * The thread's last THREAD_HISTORY_MESSAGES messages before this turn's
   * own (the owner messages it is answering are listed separately). Slash
   * commands and their result cards are the owner's own reads, no part of
   * the conversation, so they are left out.
   */
  private threadHistory(threadId: string, items: PersonaInboxItem[], limit = THREAD_HISTORY_MESSAGES): ThreadHistoryMessage[] {
    if (limit <= 0) return [];
    const current = new Set(
      items.map((i) => i.payload.messageId).filter((id): id is string => typeof id === "string")
    );
    return listPersonaMessages(this.db, threadId, { limit: limit + current.size, excludeCommands: true })
      .filter((m) => !current.has(m.id))
      .slice(-limit)
      .map((m) => ({
        at: m.createdAt,
        role: m.role,
        actor: m.actor,
        text: m.text,
        id: m.id,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments.map((a) => a.name) } : {}),
      }));
  }

  /**
   * Closes the epoch: asks for a handoff note on the same session, then starts
   * fresh. Rotation happens even when the handoff turn fails or returns
   * nothing — retrying it on every later turn would never rotate and could
   * burn a full turn timeout each time — with a note built from the job
   * snapshot instead, marked as auto-generated.
   *
   * "rotated" when the epoch closed; "held" when the handoff turn didn't run
   * to an end (held for a restart, killed by a shutdown), leaving the epoch
   * open; "stale" when the epoch had already moved on (a reset meanwhile).
   */
  private async rotate(sessionId: string, systemPrompt: string, epoch: number): Promise<"rotated" | "held" | "stale"> {
    // Persona sets no auto-compact percent here: the session is already past
    // the rotation size, which sits above it, so its override would summarize
    // a session about to be retired and the note would be written from that.
    const result = await this.runTurn(
      {
        prompt: HANDOFF_PROMPT,
        systemPrompt,
        resumeSessionId: sessionId,
        model: this.config.model,
        effort: this.config.effort,
        timeoutMs: this.config.turnTimeoutMs,
        maxBudgetUsd: this.config.turnBudgetUsd,
      },
      { kind: "handoff", threadId: this.consoleThreadId(), epoch, jobIds: () => [] }
    );
    // A handoff turn killed by a shutdown leaves the epoch open: the session
    // is still past the rotation size, so the next turn rotates it.
    if (!result || (!result.ok && result.killed)) return "held";
    if (!this.epochIs(epoch)) return "stale";
    const note = composeHandoffNote(
      result.ok && result.text.trim()
        ? result.text.trim()
        : this.fallbackHandoffNote(result.ok ? "the handoff turn returned no note" : result.error),
      this.handoffAnchors()
    );
    updatePersonaState(this.db, this.owner, {
      handoffNote: note,
      claudeSessionId: null,
      lastContextTokens: null,
      epoch: epoch + 1,
    });
    return "rotated";
  }

  /** A handoff note assembled from the job snapshot when the model could not write one. */
  private fallbackHandoffNote(why: string): string {
    const snap = this.snapshot();
    const lines = [
      `(Auto-generated: the handoff turn failed — ${why}. This lists your jobs as they stood, with the anchors below; what you learned about the owner's preferences in the previous session is not included.)`,
    ];
    if (snap.jobs.length === 0) lines.push("- no active jobs");
    for (const job of snap.jobs) {
      const sessions = job.sessions.map((s) => `${s.id} ${s.status ?? "unknown"}`).join(", ") || "no sessions";
      const note = job.note ? ` — note: ${job.note}` : "";
      lines.push(`- job ${job.id} "${job.title}" (${job.status}) — ${sessions}${note}`);
    }
    return lines.join("\n");
  }

  /**
   * The anchors appended to a handoff note, from the private turn's snapshot
   * and the console thread; empty when they can't be read, so the rotation
   * still closes the epoch.
   */
  private handoffAnchors(): string {
    try {
      const threadId = this.consoleThreadId();
      const snap = this.snapshot();
      const reviews = snap.jobs
        .filter((job) => OPEN_JOB_STATUSES.has(job.status))
        .flatMap((job) =>
          pendingReviewPacketsForJob(this.db, this.owner, job.id, job.launchIds ?? []).map((id) => ({ id, jobId: job.id }))
        );
      const ownerMessages = listPersonaMessages(this.db, threadId, { limit: 50, excludeCommands: true })
        .filter((m) => m.role === "user")
        .slice(-HANDOFF_OWNER_MESSAGES)
        .map((m) => ({ id: m.id, at: m.createdAt, text: m.text }));
      return buildHandoffAnchors(
        {
          at: this.now().toISOString(),
          jobs: snap.jobs,
          reviews,
          commitments: snap.commitments,
          ...this.snapshotOpenQuestions(threadId),
          ownerMessages,
        },
        this.owner
      );
    } catch (err) {
      console.error("[persona] could not build the handoff anchors:", err);
      return "";
    }
  }

  /**
   * The job snapshot of a turn: the owner's open jobs in full, jobs closed
   * within RECENT_CLOSED_JOB_WINDOW_MS as one-liners, a count of the day's
   * older closed jobs, and the enabled schedules — or only `threadId`'s for a
   * turn in a non-private thread.
   */
  private snapshot(threadId?: string): TurnSnapshot {
    const nowMs = this.now().getTime();
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
    const jobs = listPersonaJobs(this.db, this.owner, {
      status: ["active", "waiting_user"],
      closedSince: since,
      limit: 200,
    }).filter((job) => !threadId || job.threadId === threadId);
    const open = jobs.filter((job) => OPEN_JOB_STATUSES.has(job.status)).slice(0, 30);
    const closed = jobs.filter((job) => !OPEN_JOB_STATUSES.has(job.status));
    const recentCutoff = nowMs - RECENT_CLOSED_JOB_WINDOW_MS;
    const recentClosed = closed.filter((job) => Date.parse(job.updatedAt) >= recentCutoff).slice(0, 30);
    const snapshotJobs: SnapshotJob[] = [
      ...open.map((job) => this.snapshotOpenJob(job)),
      ...recentClosed.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.status,
        outcome: job.outcome,
        unboundLaunches: 0,
        sessions: [],
      })),
    ];
    const schedules: SnapshotSchedule[] = listPersonaSchedules(this.db, this.owner, { enabledOnly: true, ...(threadId ? { threadId } : {}) })
      .slice(0, MAX_SNAPSHOT_SCHEDULES)
      .map((s) => {
        const end = describeScheduleEnd(s);
        return {
          id: s.id,
          title: s.title,
          kind: s.kind,
          cadence: describeCron(s.cron, s.timezone, this.now()),
          nextRunAt: s.nextRunAt,
          ...(end ? { end } : {}),
        };
      });
    const commitments = this.snapshotCommitments(threadId);
    return {
      ...(commitments.list.length > 0 ? { commitments: commitments.list } : {}),
      ...(commitments.more > 0 ? { moreCommitments: commitments.more } : {}),
      jobs: snapshotJobs,
      olderClosedJobs: closed.length - recentClosed.length,
      schedules,
      ...this.launchCapacity(),
    };
  }

  /**
   * The turn thread's newest questions still offering quick replies, oldest
   * first, for its Open questions section; older ones past the cap are counted.
   */
  private snapshotOpenQuestions(threadId: string): Pick<TurnSnapshot, "openQuestions" | "moreOpenQuestions"> {
    try {
      const open = listOpenPersonaQuestions(this.db, threadId, 100);
      const list = open.slice(-MAX_SNAPSHOT_OPEN_QUESTIONS).map((m) => ({ id: m.id, question: m.text, askedAt: m.createdAt }));
      const more = open.length - list.length;
      return { ...(list.length > 0 ? { openQuestions: list } : {}), ...(more > 0 ? { moreOpenQuestions: more } : {}) };
    } catch (err) {
      console.error("[persona] could not read the open questions:", err);
      return {};
    }
  }

  /**
   * The open commitments a turn shows, once the ones the collector can check
   * for itself are settled: for a private turn the private ones (a shared
   * thread's job's stay in that thread), for a turn in a non-private
   * `threadId` only the ones living there (commitmentVisibleIn). Persona's own
   * come first, so the cap never hides one it owes behind others'.
   */
  private snapshotCommitments(threadId?: string): { list: SnapshotCommitment[]; more: number } {
    try {
      this.settleCommitments(this.now().getTime());
      const consoleId = this.consoleThreadId();
      const turn = threadId ? { threadId, private: false } : { threadId: consoleId, private: true };
      const open = listPersonaCommitments(this.db, this.owner, { status: "open", limit: 1000 }).filter((c) =>
        commitmentVisibleIn(this.db, this.owner, c, turn, consoleId)
      );
      const ordered = [...open.filter((c) => c.assignee === "persona"), ...open.filter((c) => c.assignee !== "persona")];
      const list = ordered.slice(0, MAX_SNAPSHOT_COMMITMENTS).map((c) => ({
        id: c.id,
        ...(c.jobId ? { jobId: c.jobId } : {}),
        assignee: c.assignee,
        action: c.action,
        doneCheck: c.doneCheck,
        openedAt: c.openedAt,
        ...(c.staleAfter ? { staleAfter: c.staleAfter } : {}),
      }));
      return { list, more: ordered.length - list.length };
    } catch (err) {
      console.error("[persona] could not read the open commitments:", err);
      return { list: [], more: 0 };
    }
  }

  /**
   * An open job's snapshot entry: its newest live sessions in full, its ended
   * ones counted. For the main Persona (`forLane` unset) a pending ask a
   * delegate lane is deciding is marked with that lane's agent.
   */
  private snapshotOpenJob(job: PersonaJob, forLane = false): SnapshotJob {
    let endedSessions = 0;
    const live: SnapshotJob["sessions"] = [];
    for (const sessionId of job.sessionIds) {
      const session = getSession(this.db, sessionId);
      if (session && (session.endedAt || session.status === "done")) {
        endedSessions++;
        continue;
      }
      const checkpoint = getLatestCheckpoint(this.db, sessionId);
      const pending = getPendingAsksBySession(this.db, sessionId);
      live.push({
        id: sessionId,
        projectId: session?.projectId,
        status: session ? session.status : "unknown",
        lastCheckpoint: checkpoint
          ? { at: new Date(checkpoint.createdAt).toISOString(), summary: checkpoint.summary }
          : undefined,
        pendingAsks: pending.length,
        asks: pending
          .filter((ask) => !isIdleNoticeAsk(ask))
          .slice(-3)
          .map((ask) => {
            const lane = forLane ? undefined : [...this.lanes.values()].find((l) => l.holds(ask.id));
            return { id: ask.id, kind: ask.kind, question: ask.question, ...(lane ? { delegatedTo: lane.agent.id } : {}) };
          }),
      });
    }
    const pipeline = pipelineJobSummary(this.db, job.launchIds);
    const reviewTunnels = liveReviewTunnelsForJob(this.db, job.id)
      .filter((t) => t.owner === job.owner)
      .map((t) => ({ id: t.id, url: t.url, status: t.status, ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}) }));
    return {
      id: job.id,
      title: job.title,
      status: job.status,
      note: job.note,
      unboundLaunches: countStartingPersonaJobLaunches(this.db, job.id),
      endedSessions,
      launchIds: job.launchIds,
      sessions: live.slice(-4),
      ...(pipeline ? { pipeline } : {}),
      ...(job.view?.actions?.length ? { needs: job.view.actions } : {}),
      ...(reviewTunnels.length > 0 ? { reviewTunnels } : {}),
      ...(job.budget && job.budget.level !== "ok"
        ? { budget: { level: job.budget.level, used: describeJobBudget(job.budget) } }
        : {}),
    };
  }

  /** Active launches against the configured cap, with the host's effective cap and reading. */
  private launchCapacity(): Pick<PersonaState, "activeLaunches" | "maxActiveLaunches" | "host"> {
    const activeLaunches = countActivePersonaLaunches(this.db, this.owner);
    const queued = countQueuedPersonaLaunches(this.db, this.owner);
    return {
      activeLaunches,
      maxActiveLaunches: this.config.maxActive,
      host: hostHeadroomView(this.config.maxActive, activeLaunches, queued, this.hostMonitor),
    };
  }

  /**
   * The maintenance tick: expire stale approvals, prune settled inbox rows,
   * publish state if it changed, start queued launches that now have room,
   * fire the daily brief when its slot has passed, drain anything due.
   */
  async tick(): Promise<void> {
    const nowMs = this.now().getTime();
    const cutoff = new Date(nowMs - APPROVAL_TTL_MS).toISOString();
    for (const approval of expirePersonaApprovals(this.db, this.owner, cutoff)) {
      this.publish({ type: "persona:approval", payload: approval, timestamp: new Date().toISOString() });
      this.enqueueApprovalResult(approval);
      this.reannounceUncarded(approval);
    }
    this.supersedeStaleApprovals();
    this.denyHoldsOfDeniedCards();
    this.remindExpiringHolds(nowMs);
    if (this.hasRuntimeFor) this.expireUnservedApprovals(cutoff, nowMs);
    prunePersonaInbox(this.db, this.owner, new Date(nowMs - INBOX_RETENTION_MS).toISOString());
    try {
      this.settleCommitments(nowMs);
      this.nudgeOverdueCommitments(nowMs);
      prunePersonaCommitments(this.db, this.owner, new Date(nowMs - CLOSED_COMMITMENT_RETENTION_MS).toISOString());
    } catch (err) {
      console.error("[persona] commitment upkeep failed:", err);
    }
    this.publishState({ onlyIfChanged: true });
    if (!this.held) {
      // Single-flight and slow (it reads transcripts), so the tick doesn't wait on it.
      void this.budgets.maybeCheck().catch((err) => console.error("[persona] job budget check failed:", err));
      try {
        await this.tools.drainLaunchQueue();
      } catch (err) {
        console.error("[persona] launch queue drain failed:", err);
      }
      try {
        if (this.dailyBrief) this.maybeBrief();
      } catch (err) {
        console.error("[persona] brief check failed:", err);
      }
    }
    // A lane that stopped for a pause or a hold picks up again once it may run.
    this.kickLanes();
    if (hasDuePersonaInbox(this.db, this.owner, this.now().toISOString())) await this.drain();
  }

  /**
   * Makes this (the host's) runtime's tick expire stale pending cards of
   * owners with no runtime on this collector, whose own tick never runs.
   */
  serveOwnersWithoutRuntime(hasRuntimeFor: (owner: string) => boolean): void {
    this.hasRuntimeFor = hasRuntimeFor;
  }

  /**
   * Expires the pending cards created before `cutoff` of every other owner
   * without a runtime, and closes their safety-floor cards whose holds were
   * settled, as that owner's tick would (see announceUnserved).
   */
  private expireUnservedApprovals(cutoff: string, nowMs: number): void {
    const owners = this.db
      .query("SELECT DISTINCT owner FROM persona_approvals WHERE status = 'pending' AND created_at < ?")
      .all(cutoff) as Array<{ owner: string }>;
    for (const { owner } of owners) {
      if (owner === this.owner || this.hasRuntimeFor?.(owner)) continue;
      for (const approval of expirePersonaApprovals(this.db, owner, cutoff)) {
        this.announceUnserved(approval);
        this.reannounceUncarded(approval);
      }
    }
    // A safety-floor card is closed once its hold is settled, as its owner's
    // own tick would (supersedeStaleApprovals).
    const floorOwners = this.db
      .query("SELECT DISTINCT owner FROM persona_approvals WHERE status = 'pending' AND action = 'answer_ask'")
      .all() as Array<{ owner: string }>;
    for (const { owner } of floorOwners) {
      if (owner === this.owner || this.hasRuntimeFor?.(owner)) continue;
      for (const pending of listPersonaApprovals(this.db, owner, "pending")) {
        this.lapseExpiredFloorHold(pending, nowMs);
        const closed = closeSettledFloorCard(this.db, pending);
        if (closed) this.announceUnserved(closed);
      }
    }
  }

  /**
   * Tells the owner and approver of another owner's decided card, and leaves
   * its result in that owner's inbox: in the card's thread, else its job's,
   * else the console thread.
   */
  private announceUnserved(approval: PersonaApproval): void {
    const { owner } = approval;
    const frame = { type: "persona:approval", payload: approval, timestamp: new Date().toISOString() } as const;
    this.broadcastFn({ ...frame, audience: owner });
    if (approval.approver && approval.approver !== owner) this.broadcastFn({ ...frame, audience: approval.approver });
    const job = approval.jobId ? getPersonaJob(this.db, approval.jobId) : null;
    enqueuePersonaInbox(this.db, {
      owner,
      kind: "approval_result",
      payload: {
        approvalId: approval.id,
        ...(approval.jobId ? { jobId: approval.jobId } : {}),
        action: approval.action,
        summary: approval.summary,
        status: approval.status,
        result: approval.result,
        decidedBy: approval.decidedBy,
      },
      threadId: approval.threadId || (job && job.owner === owner ? job.threadId : undefined) || undefined,
    });
  }

  /**
   * Starts a quiesce() hold without waiting on anything: no new turn,
   * scheduled run or owner approval starts until release(). Work already
   * running carries on.
   */
  hold(): void {
    this.held = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = undefined;
  }

  /**
   * Readies Persona for its collector to exit: no new turn or scheduled run
   * starts, and the returned promise resolves once the running turn (with its
   * handoff, if any), every approved action executing and every scheduled run
   * starting have settled — true then, false when
   * `timeoutMs` passes first. A settled turn has marked its items done, so the
   * next collector neither loses nor replays them; items still pending stay
   * pending. release() lifts the hold.
   */
  async quiesce(timeoutMs: number, pollMs = 100): Promise<boolean> {
    this.hold();
    const deadline = Date.now() + timeoutMs;
    while (this.draining || this.executingApprovals > 0 || this.schedules.busy() || this.delegateLanes().some((l) => !l.idle())) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }

  /**
   * Lifts a quiesce() hold, runs the owner approvals that came in meanwhile
   * (see approve()), and drains anything that came due.
   */
  release(): void {
    if (!this.held) return;
    this.held = false;
    const deferred = [...this.deferredApprovals];
    this.deferredApprovals.clear();
    for (const [approvalId, decidedBy] of deferred) {
      void this.approve(approvalId, decidedBy).catch((err) =>
        console.error(`[persona] deferred approval ${approvalId} failed:`, err)
      );
    }
    this.scheduleWake();
    this.kickLanes();
  }

  // ── Owner-facing operations ───────────────────────────────────────────────

  /** Appends a message and broadcasts it. */
  /**
   * Whether `reply` repeats Persona's previous message in the thread, posted
   * within DUPLICATE_REPLY_WINDOW_MS: a turn woken by a follow-up event
   * often restates the update it just gave.
   */
  private repeatsLastReply(threadId: string, reply: string): boolean {
    const previous = listPersonaMessages(this.db, threadId, { limit: 50 })
      .reverse()
      .find((m) => m.role === "persona");
    if (!previous) return false;
    const age = this.now().getTime() - Date.parse(previous.createdAt);
    if (!(age <= DUPLICATE_REPLY_WINDOW_MS)) return false;
    return isNearDuplicateReply(previous.text, reply);
  }

  postMessage(input: AppendPersonaMessageInput): PersonaMessage {
    const { message, created } = appendPersonaMessage(this.db, input);
    if (created) this.publish({ type: "persona:message", payload: message, timestamp: new Date().toISOString() });
    return message;
  }

  /**
   * Appends a message carrying `tags` with their own sources (postMessage's
   * `jobIds` would all be explicit) and broadcasts it once, already tagged.
   * A failure to tag leaves the message posted untagged.
   */
  private postTagged(input: AppendPersonaMessageInput, tags: PersonaMessageJobTag[]): PersonaMessage {
    const { message, created } = this.db.transaction(() => {
      const appended = appendPersonaMessage(this.db, input);
      if (!appended.created || tags.length === 0) return appended;
      try {
        const tagged = addPersonaMessageJobTags(this.db, { messageId: appended.message.id, owner: this.owner, tags });
        return { message: tagged ?? appended.message, created: true };
      } catch (err) {
        console.error("[persona] could not tag a reply; posting it untagged:", err);
        return appended;
      }
    })();
    if (created) this.publish({ type: "persona:message", payload: message, timestamp: new Date().toISOString() });
    return message;
  }

  /**
   * Posts a turn's reply (see postTagged) routed as `route`'s notification,
   * and sends its push when the route has one.
   */
  private postRouted(
    input: AppendPersonaMessageInput,
    tags: PersonaMessageJobTag[],
    route: { notify: PersonaMessageNotify; title: string } | undefined
  ): PersonaMessage {
    const message = this.postTagged(route ? { ...input, notify: route.notify } : input, tags);
    if (route && message.text.trim()) pushIfRouted(route.notify, route.title, message.text, this.owner, this.host);
    return message;
  }

  /**
   * How the running turn's reply is routed as a notification: as the brief
   * when the brief woke the turn, as a done update when the turn closed a
   * job, and as a progress update when only its jobs' own events woke it and
   * the reply is about them. A reply to the owner's own message is a
   * conversation, not a notification, and is undefined.
   */
  private replyRoute(
    items: PersonaInboxItem[],
    tags: PersonaMessageJobTag[]
  ): { notify: PersonaMessageNotify; title: string } | undefined {
    try {
      if (items.some((i) => i.kind === "schedule" && i.payload.brief === true)) {
        return { notify: routeUpdate(this.db, this.owner, "brief"), title: "Your Persona brief" };
      }
      if (items.some((i) => i.kind === "user_message")) return undefined;
      if (this.turnClosedJobs.size > 0) {
        const closed = [...this.turnClosedJobs];
        const failed = closed.some(([, status]) => status !== "done");
        return {
          notify: routeUpdate(this.db, this.owner, "done", { jobIds: closed.map(([id]) => id), facts: { failed } }),
          title: failed ? "Persona: a job ended unfinished" : "Persona: job done",
        };
      }
      if (tags.length === 0) return undefined;
      const jobIds = tags.map((t) => t.jobId);
      const needsYou = jobIds.some((id) => jobNeedsOwner(getPersonaJob(this.db, id)));
      return { notify: routeUpdate(this.db, this.owner, "progress", { jobIds, facts: { needsYou } }), title: "Persona update" };
    } catch (err) {
      console.error("[persona] could not route the turn's reply; posting it unrouted:", err);
      return undefined;
    }
  }

  /**
   * The daily brief, from the maintenance tick: once the owner's brief slot
   * (their brief time, in their timezone) has passed, claims it, assembles
   * the digest of their own state, and wakes Persona in their private
   * console thread to write it — or, when the digest has nothing and the
   * route is `actionable`, settles it silent with no turn at all. A slot
   * past by more than BRIEF_GRACE_MS (the collector was down, or the brief
   * was turned on later in the day) is left alone, and a paused Persona
   * skips its brief rather than sending it late.
   */
  private maybeBrief(): void {
    const now = this.now();
    const prefs = notifyPrefsFor(this.db, this.owner);
    if (!briefEnabled(this.db, this.owner, prefs, now)) return;
    const timezone = prefs.timezone ?? ownerTimezone();
    const slot = latestBriefSlot(prefs.brief.time, timezone, now);
    if (!slot) return;
    const slotIso = slot.toISOString();
    if (slotIso === this.briefSlotHandled) return;
    const nowIso = now.toISOString();
    if (now.getTime() - slot.getTime() > BRIEF_GRACE_MS) return;
    // A brief time moved after today's brief went out names a new slot the
    // same day; the day already has its brief. The slot is marked handled
    // only once decided, so a failed read or claim is retried next tick.
    const latest = latestPersonaBriefRun(this.db, this.owner);
    if (latest && latest.slot !== slotIso && sameLocalDay(new Date(latest.slot), slot, timezone)) {
      this.briefSlotHandled = slotIso;
      return;
    }
    if (getOrCreatePersonaState(this.db, this.owner).paused) {
      claimPersonaBriefSlot(this.db, this.owner, slotIso, "skipped", nowIso, "Persona was paused");
      this.briefSlotHandled = slotIso;
      return;
    }
    const claimed = claimPersonaBriefSlot(this.db, this.owner, slotIso, "queued", nowIso, "assembling");
    this.briefSlotHandled = slotIso;
    if (!claimed) return;
    try {
      const since = briefSince(this.db, this.owner, slot);
      const digest = buildBriefDigest(this.db, this.owner, { since, now });
      if (briefIsEmpty(digest) && prefs.routes.brief.when === "actionable") {
        settlePersonaBriefSlot(this.db, this.owner, slotIso, { status: "silent", detail: "nothing changed and nothing waits on you" });
        return;
      }
      const item = this.enqueue(
        "schedule",
        { brief: true, slot: slotIso, since, digest: renderBriefDigest(digest), empty: briefIsEmpty(digest) },
        { threadId: this.consoleThreadId(), coalesceKey: `brief:${slotIso}` }
      );
      settlePersonaBriefSlot(this.db, this.owner, slotIso, { status: "queued", inboxId: item.id });
    } catch (err) {
      console.error("[persona] could not assemble the brief:", err);
      settlePersonaBriefSlot(this.db, this.owner, slotIso, { status: "skipped", detail: `failed: ${(err as Error).message}` });
    }
  }

  /**
   * Settles the brief slot a finished turn wrote: `sent` once its reply
   * posted, `silent` when Persona found nothing worth sending. Only a sent
   * brief moves the next digest's window on.
   */
  private settleBrief(items: PersonaInboxItem[], posted: boolean): void {
    const item = items.find((i) => i.kind === "schedule" && i.payload.brief === true);
    const slot = item?.payload.slot;
    if (!item || typeof slot !== "string") return;
    try {
      settlePersonaBriefSlot(
        this.db,
        this.owner,
        slot,
        posted ? { status: "sent", inboxId: item.id } : { status: "silent", inboxId: item.id, detail: "Persona found nothing worth sending" }
      );
    } catch (err) {
      console.error("[persona] could not settle the brief:", err);
    }
  }

  /**
   * The jobs a message in `threadId` may be tagged with — the owner's, and in
   * a non-private thread only that thread's own, since a tag names its job to
   * everyone reading the thread — and those mention matching looks for: the
   * open ones and the ones closed within the last day.
   */
  private taggableJobs(threadId: string, isPrivate: boolean): TaggableJobs {
    const allows = (jobId: string) => {
      const job = getPersonaJob(this.db, jobId);
      return !!job && job.owner === this.owner && (isPrivate || job.threadId === threadId);
    };
    const since = new Date(this.now().getTime() - MENTIONABLE_CLOSED_JOB_MS).toISOString();
    const mentionable = listPersonaJobs(this.db, this.owner, { status: ["active", "waiting_user"], closedSince: since, limit: 200 })
      .filter((job) => isPrivate || job.threadId === threadId)
      .map((job) => ({ id: job.id, title: job.title }));
    return { allows, mentionable };
  }

  /**
   * The running turn's reply's job tags (see composeReplyTags): the jobs its
   * calls acted on, the jobs its items are about (the job an owner message
   * was tagged to by its sender, and the job of a worker event, approval
   * result or wakeup), the jobs `text` names, and its tag_reply declarations.
   */
  private replyTags(items: PersonaInboxItem[], text: string, taggable: TaggableJobs): PersonaMessageJobTag[] {
    const events = items
      .map((i) => i.payload.jobId)
      .filter((id): id is string => typeof id === "string" && !!id);
    return composeReplyTags({
      acted: this.turnJobs,
      events,
      mentioned: jobMentions(text, taggable.mentionable),
      declaredAdd: this.declaredReplyTags.add,
      declaredRemove: this.declaredReplyTags.remove,
    }).filter((tag) => taggable.allows(tag.jobId));
  }

  /**
   * Tags the owner messages the turn answered with the jobs each names and,
   * when the turn answered just one, the jobs it acted on, as `inferred`;
   * re-broadcasts each one that changed. In a batch of several, which
   * message an action answered is unknown, so each gets only its own
   * mentions. A message the owner tagged to a job themselves is theirs to
   * label and is left as it is. Messages from anyone else in a shared thread
   * are neither tagged nor counted.
   */
  private tagOwnerMessages(items: PersonaInboxItem[], taggable: TaggableJobs): void {
    const messageItems = items.filter(
      (i) => i.kind === "user_message" && i.payload.actor === this.owner && typeof i.payload.messageId === "string"
    );
    const acted = messageItems.length === 1 ? this.turnJobs : [];
    for (const item of messageItems) {
      const message = getPersonaMessage(this.db, item.payload.messageId as string);
      if (!message || message.jobTags?.some((t) => t.source === "explicit")) continue;
      const tags = composeReplyTags({ acted, mentioned: jobMentions(message.text, taggable.mentionable) }).filter(
        (tag) => taggable.allows(tag.jobId) && !message.jobIds?.includes(tag.jobId)
      );
      if (tags.length === 0) continue;
      const updated = addPersonaMessageJobTags(this.db, { messageId: message.id, owner: this.owner, tags });
      if (updated) this.publish({ type: "persona:message", payload: updated, timestamp: new Date().toISOString() });
    }
  }

  /**
   * Takes job `jobId`'s tag off the owner's message `messageId`, broadcasting
   * the message when it had one. Undefined when the message isn't the owner's.
   */
  removeMessageJobTag(messageId: string, jobId: string): PersonaMessage | undefined {
    const before = getPersonaMessage(this.db, messageId);
    const message = removePersonaMessageJobTag(this.db, { messageId, jobId, owner: this.owner });
    if (message && before?.jobIds?.includes(jobId)) {
      this.publish({ type: "persona:message", payload: message, timestamp: new Date().toISOString() });
    }
    return message;
  }

  /**
   * The owner's job `jobId` when a message in `threadId` may be tagged with
   * it — in a private thread any of the owner's jobs, in any other only that
   * thread's own, since a tag names its job to everyone reading the thread —
   * or null. Null too when the thread is missing or isn't the owner's.
   */
  jobTaggableIn(threadId: string, jobId: string): PersonaJob | null {
    const job = getPersonaJob(this.db, jobId);
    if (!job || job.owner !== this.owner) return null;
    const thread = getPersonaThread(this.db, threadId);
    if (!thread || thread.owner !== this.owner) return null;
    return thread.audience === "private" || job.threadId === threadId ? job : null;
  }

  /**
   * Records an owner message and wakes Persona on it, labeled with the
   * thread's channel; `context` (the surrounding channel conversation, already
   * bounded by the caller) rides along in the inbox item. `replyTo` links a
   * quick-reply tap to the question it answers (an option_reply signal); a
   * valid one is stored as the message's `replyToMessageId`, and the
   * question and its jobs ride in the inbox item, so the turn names them.
   * `jobId` tags the message to one of this Persona's jobs (one
   * jobTaggableIn the thread allows; any other is dropped): it is stored as
   * the message's `jobIds` and the job's id and title ride in the inbox item,
   * so the turn names the workstream. `attachmentIds` (owner uploads of the
   * thread) ride on the message, and the ids it claimed ride in the inbox
   * item, so the turn shows Persona the media. A repeated idempotency key is a
   * no-op.
   */
  receiveUserMessage(input: {
    text: string;
    threadId?: string;
    idempotencyKey?: string;
    actor: string;
    context?: PersonaContextMessage[];
    replyTo?: PersonaReplyTo;
    jobId?: string;
    /** Owner uploads of the thread the message carries (claimed with it). */
    attachmentIds?: string[];
  }): PersonaMessage {
    const threadId = input.threadId ?? this.consoleThreadId();
    const channel = getPersonaThread(this.db, threadId)?.channel ?? "console";
    const taggedJob = input.jobId ? this.jobTaggableIn(threadId, input.jobId) : null;
    const tapped = personaTappedQuestion(this.db, threadId, input.replyTo);
    const { message, created } = appendPersonaMessage(this.db, {
      threadId,
      role: "user",
      text: input.text.trim(),
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      ...(taggedJob ? { jobIds: [taggedJob.id] } : {}),
      ...(tapped ? { replyToMessageId: tapped.id } : {}),
      ...(input.attachmentIds && input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
    });
    if (created) {
      // The questions the owner's message answers lose their quick replies;
      // they go out first, so no client shows them live past the answer.
      const answeredQuestions =
        input.actor === this.owner
          ? recordPersonaQuestionReply(this.db, this.owner, threadId, {
              seq: message.seq,
              replyToMessageId: input.replyTo?.messageId,
              optionIndex: input.replyTo?.optionIndex,
              jobId: taggedJob?.id,
            })
          : [];
      for (const question of answeredQuestions) {
        this.publish({ type: "persona:message", payload: question, timestamp: new Date().toISOString() });
      }
      this.publish({ type: "persona:message", payload: message, timestamp: new Date().toISOString() });
      if (input.actor === this.owner) {
        captureOptionReply(this.db, this.owner, message, input.replyTo, this.now());
        // The owner's reply answers the job's open question (and any waiting
        // it was set for), so the Jobs list stops showing it as needing them.
        const answered = recordPersonaJobOwnerReply(this.db, this.owner, threadId, {
          jobId: taggedJob?.id,
          replyToMessageId: tapped?.id,
        });
        // Any other job still pointing at a question the reply closed moves on too.
        const released = releasePersonaJobOpenAsks(
          this.db,
          this.owner,
          answeredQuestions.map((q) => q.id)
        ).filter((jobId) => !answered.includes(jobId));
        for (const jobId of [...answered, ...released]) {
          // A question about the job the reply didn't close keeps it needing the owner.
          syncPersonaJobOpenAsk(this.db, jobId);
          const refreshed = refreshPersonaJob(this.db, jobId);
          if (refreshed) this.publish({ type: "persona:job", payload: refreshed.job, timestamp: new Date().toISOString() });
        }
      }
      // A tap names the question it answers and that question's jobs, so the
      // turn knows which of several open questions sharing an option it is.
      // Only jobs the thread may name now: its audience may have widened
      // since the question was tagged.
      const questionJobs = tapped
        ? (tapped.jobIds ?? []).flatMap((id) => {
            const job = id === taggedJob?.id ? null : this.jobTaggableIn(threadId, id);
            return job ? [{ id: job.id, title: job.title }] : [];
          })
        : [];
      this.enqueue(
        "user_message",
        {
          text: message.text,
          actor: input.actor,
          channel,
          messageId: message.id,
          ...(taggedJob ? { jobId: taggedJob.id, jobTitle: taggedJob.title } : {}),
          ...(tapped ? { question: { id: tapped.id, text: tapped.text.slice(0, 400) } } : {}),
          ...(questionJobs.length > 0 ? { questionJobs } : {}),
          ...(input.context && input.context.length > 0 ? { context: input.context } : {}),
          ...(message.attachments && message.attachments.length > 0
            ? { attachmentIds: message.attachments.map((a) => a.id) }
            : {}),
        },
        { threadId }
      );
    }
    return message;
  }

  /**
   * Keeps, drops or retires one of the owner's playbooks on their own click in
   * the console, written as Persona's own knowledge write (playbook-library.ts
   * decidePlaybook), since only Persona writes the personal layer.
   */
  decidePlaybook(slug: string, decision: "accept" | "reject" | "retire"): ReturnType<typeof decidePlaybook> {
    return decidePlaybook(this.db, (method, path, body) => this.request(method, path, body), this.owner, slug, decision);
  }

  setPaused(paused: boolean): PersonaState {
    updatePersonaState(this.db, this.owner, { paused });
    this.publishState();
    if (!paused) void this.drain();
    return this.getState();
  }

  /**
   * Starts a fresh epoch without a handoff turn, dropping the previous
   * handoff note too. A turn in flight keeps running, but its session is
   * not carried into the new epoch.
   */
  reset(): PersonaState {
    const state = getOrCreatePersonaState(this.db, this.owner);
    updatePersonaState(this.db, this.owner, {
      claudeSessionId: null,
      lastContextTokens: null,
      handoffNote: null,
      epoch: state.epoch + 1,
      lastError: null,
    });
    clearPersonaThreadSessions(this.db, this.owner);
    this.publishState();
    return this.getState();
  }

  /**
   * Executes an approved action exactly as it was stored, then records the
   * outcome and wakes Persona with it. Returns null when the approval is not
   * this owner's, was not pending (already decided or expired), or is past its
   * 24h expiry — which is then recorded as expired rather than run.
   *
   * While Persona is held for a collector restart (quiesce()), nothing new
   * runs: the decision is queued and the approval returned still pending,
   * to run on release(). Should the collector stop instead, the approval
   * stays pending, for the owner to approve again on the next collector.
   */
  async approve(approvalId: string, decidedBy: string): Promise<PersonaApproval | null> {
    const existing = getPersonaApproval(this.db, approvalId);
    if (!existing || existing.owner !== this.owner || existing.status !== "pending") return null;
    const settled = this.closeSettledCard(existing);
    if (settled) return settled;
    if (this.held && this.now().getTime() - Date.parse(existing.createdAt) <= APPROVAL_TTL_MS) {
      this.deferredApprovals.set(approvalId, decidedBy);
      return existing;
    }
    if (this.now().getTime() - Date.parse(existing.createdAt) > APPROVAL_TTL_MS) {
      const expired = transitionPersonaApproval(this.db, approvalId, "pending", "expired", {
        result: "expired after 24h",
      });
      if (expired) {
        this.publish({ type: "persona:approval", payload: expired, timestamp: new Date().toISOString() });
        this.enqueueApprovalResult(expired);
        this.reannounceUncarded(expired);
      }
      return null;
    }
    const approval = transitionPersonaApproval(this.db, approvalId, "pending", "approved", { decidedBy });
    if (!approval) return null;
    if (decidedBy === this.owner) captureApprovalDecision(this.db, approval, "approved");
    this.publish({ type: "persona:approval", payload: approval, timestamp: new Date().toISOString() });
    let outcome: PersonaToolResult;
    this.executingApprovals++;
    try {
      outcome = await this.executing.run(approval, () => this.tools.call(approval.action, approval.args, { approval }));
    } catch (err) {
      outcome = { content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true };
    } finally {
      this.executingApprovals--;
    }
    const text = outcome.content.map((c) => c.text).join("\n").slice(0, 2000);
    const final =
      transitionPersonaApproval(this.db, approvalId, "approved", outcome.isError ? "failed" : "executed", { result: text }) ??
      getPersonaApproval(this.db, approvalId)!;
    this.publish({ type: "persona:approval", payload: final, timestamp: new Date().toISOString() });
    this.enqueueApprovalResult(final);
    this.reannounceUncarded(final);
    return final;
  }

  deny(approvalId: string, decidedBy: string, reason?: string): PersonaApproval | null {
    const existing = getPersonaApproval(this.db, approvalId);
    if (!existing || existing.owner !== this.owner) return null;
    if (existing.status === "pending") {
      const settled = this.closeSettledCard(existing);
      if (settled) return settled;
    }
    const denied = transitionPersonaApproval(this.db, approvalId, "pending", "denied", {
      decidedBy,
      result: reason?.trim() || undefined,
    });
    if (!denied) return null;
    if (decidedBy === this.owner) captureApprovalDecision(this.db, denied, "denied");
    this.publish({ type: "persona:approval", payload: denied, timestamp: new Date().toISOString() });
    this.enqueueApprovalResult(denied, reason);
    // Denying an allow card denies its hold; denying a card holding Persona's
    // own "Deny" overrules that deny, so the hold stays pending.
    if (floorCardDeniesHold(denied)) {
      this.tools.denyHeldFloorAsk(denied).catch((err) => {
        console.error(`[persona] denying the floor hold of approval ${denied.id} failed:`, err);
      });
    } else {
      this.reannounceUncarded(denied);
    }
    return denied;
  }

  /**
   * Re-broadcasts `ask:new`, marked `personaHandled: false`, for the ask an
   * answer_ask card answered once the card ends with the ask still pending
   * and no other card holding it, while the card owner's Persona can't act
   * (an owner without a runtime here has none that can). Its frames went out
   * as the card's, so the other surfaces skipped it; with the card gone and
   * no Persona to relay it, it would otherwise reach no one.
   */
  private reannounceUncarded(card: PersonaApproval): void {
    if (card.action !== "answer_ask" || typeof card.args.askId !== "string") return;
    if (card.owner === this.owner && this.canAct()) return;
    const ask = getAsk(this.db, card.args.askId);
    if (!ask || ask.status !== "pending" || ownerCardHoldsAsk(this.db, card.owner, ask.id)) return;
    this.broadcastFn({ type: "ask:new", payload: { ...ask, personaHandled: false }, timestamp: new Date().toISOString() });
  }

  /**
   * Closes a pending card whose safety-floor hold was settled some other way
   * with what happened to it (see closeSettledFloorCard), and wakes Persona
   * with that; null when the card still decides its hold.
   */
  private closeSettledCard(card: PersonaApproval): PersonaApproval | null {
    const closed = closeSettledFloorCard(this.db, card);
    if (!closed) return null;
    this.publish({ type: "persona:approval", payload: closed, timestamp: new Date().toISOString() });
    this.enqueueApprovalResult(closed);
    return closed;
  }

  /**
   * Why a pending approval no longer has anything to act on, or null while it
   * still does: the question it answers was answered or withdrawn, the plan it
   * decides was decided, or the worker it steers has ended.
   */
  private staleReason(approval: PersonaApproval): string | null {
    const id = (key: string) => (typeof approval.args[key] === "string" ? (approval.args[key] as string) : "");
    switch (approval.action) {
      case "answer_ask": {
        const ask = id("askId") ? getAsk(this.db, id("askId")) : null;
        return ask && ask.status !== "pending" ? "the worker's question was already answered or withdrawn" : null;
      }
      case "approve_plan":
      case "reject_plan": {
        const plan = id("planId") ? getPlanApproval(this.db, id("planId")) : null;
        return plan && plan.status !== "awaiting_approval" ? "the plan was already decided" : null;
      }
      case "send_to_session":
      case "interrupt_session":
      case "recover_session":
      case "stop_session": {
        const session = id("sessionId") ? getSession(this.db, id("sessionId")) : null;
        if (!session?.endedAt) return null;
        // A worker paused for idleness resumes on a message, and can still be
        // stopped; there is no turn of it to interrupt or recover.
        const paused = !!getLaunchBySession(this.db, session.id)?.reapedAt;
        if (paused && (approval.action === "send_to_session" || approval.action === "stop_session")) return null;
        return paused ? "the worker is paused" : "the worker has ended";
      }
      case "close_session": {
        // Every session the card names: sessionId and each sessionIds entry, as close_session reads them.
        const listed = [approval.args.sessionId, ...(Array.isArray(approval.args.sessionIds) ? approval.args.sessionIds : [])];
        const ids = listed.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim());
        const allEnded = ids.length > 0 && ids.every((sid) => getSession(this.db, sid)?.endedAt);
        return allEnded ? "the sessions have already ended" : null;
      }
      case "waive_pipeline_stage": {
        const run = id("sessionId") ? pipelineRunForSession(this.db, id("sessionId")) : null;
        return run && run.currentStage !== id("stage") ? `the pipeline has moved on to ${run.currentStage}` : null;
      }
      default:
        return null;
    }
  }

  /** Takes cards that have nothing left to act on off the owner's list (see staleReason). */
  private supersedeStaleApprovals(): void {
    const nowMs = this.now().getTime();
    for (const pending of listPersonaApprovals(this.db, this.owner, "pending")) {
      this.lapseExpiredFloorHold(pending, nowMs);
      if (this.closeSettledCard(pending)) continue;
      const reason = this.staleReason(pending);
      if (!reason) continue;
      const superseded = supersedePersonaApproval(this.db, pending.id, reason);
      if (!superseded) continue;
      this.publish({ type: "persona:approval", payload: superseded, timestamp: new Date().toISOString() });
      this.enqueueApprovalResult(superseded);
    }
  }

  /**
   * Times out the safety-floor hold `approval` answers once it is past its
   * deadline, and tells every console and Slack: such a hold has no waiter
   * left (an acceptance-criterion hold never had one; a hook's can die with a
   * restart).
   */
  private lapseExpiredFloorHold(approval: PersonaApproval, nowMs: number): void {
    if (approval.action !== "answer_ask" || typeof approval.args.askId !== "string") return;
    const ask = getAsk(this.db, approval.args.askId);
    if (!ask || ask.status !== "pending" || !isFloorGate(ask.gate)) return;
    const expiresAt = getFloorAskState(this.db, ask.id)?.expiresAt;
    if (!expiresAt || expiresAt.getTime() > nowMs || !timeoutPendingAsk(this.db, ask.id)) return;
    announceAskTimedOut(this.db, this.broadcastFn, ask);
  }

  /**
   * Denies again any safety-floor hold still pending under a denied
   * answer_ask card: deny() denies the hold right away, and this catches one
   * whose denial didn't go through (the collector was restarting, say).
   */
  private denyHoldsOfDeniedCards(): void {
    for (const card of listPersonaApprovals(this.db, this.owner, "denied")) {
      if (!floorCardDeniesHold(card) || typeof card.args.askId !== "string") continue;
      const ask = getAsk(this.db, card.args.askId);
      if (!ask || ask.status !== "pending" || !isFloorGate(ask.gate)) continue;
      this.tools.denyHeldFloorAsk(card).catch((err) => {
        console.error(`[persona] denying the floor hold of approval ${card.id} failed:`, err);
      });
    }
  }

  /**
   * Pushes the decider of every pending card holding a safety-floor hold that
   * times out within FLOOR_HOLD_REMIND_MS, once per card: an unseen card
   * otherwise lapses into a deny with nobody told.
   */
  private remindExpiringHolds(nowMs: number): void {
    const pendingCards = listPersonaApprovals(this.db, this.owner, "pending");
    const live = new Set(pendingCards.map((a) => a.id));
    for (const id of this.remindedHolds) if (!live.has(id)) this.remindedHolds.delete(id);
    for (const pending of pendingCards) {
      const at = typeof pending.args.holdExpiresAt === "string" ? Date.parse(pending.args.holdExpiresAt) : Number.NaN;
      if (Number.isNaN(at) || at - nowMs > FLOOR_HOLD_REMIND_MS || at <= nowMs) continue;
      // A card raised inside the window was just pushed when it was raised.
      if (nowMs - Date.parse(pending.createdAt) < FLOOR_HOLD_REMIND_MS) continue;
      if (this.remindedHolds.has(pending.id)) continue;
      this.remindedHolds.add(pending.id);
      const minutes = Math.max(1, Math.round((at - nowMs) / 60_000));
      const recipient = pending.approver ?? pending.owner;
      pushIfRouted(
        routeUpdate(this.db, recipient, "decision", { jobIds: [pending.jobId], facts: { approval: true } }),
        `A held command times out in ${minutes} min`,
        `${approvalHeadline(pending).slice(0, 240)} Approve or deny it in Standup before it is denied.`,
        recipient,
        this.host
      );
    }
  }

  /** Wakes Persona with a decision in the thread the approval was raised from (its job's thread for an approval with none recorded). */
  private enqueueApprovalResult(approval: PersonaApproval, reason?: string): void {
    this.enqueue(
      "approval_result",
      {
        approvalId: approval.id,
        ...(approval.jobId ? { jobId: approval.jobId } : {}),
        action: approval.action,
        summary: approval.summary,
        status: approval.status,
        result: approval.result,
        decidedBy: approval.decidedBy,
        reason: reason?.trim() || undefined,
      },
      { threadId: approval.threadId }
    );
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * Whether Persona is running and able to take its workers' turn ends right
   * now: started, not paused, and its last turn didn't fail. While it can't, its
   * workers' idle notices surface to the owner like any launched session's.
   */
  canAct(): boolean {
    if (!this.active) return false;
    const state = getOrCreatePersonaState(this.db, this.owner);
    return !state.paused && !state.lastError;
  }

  /** A turn in flight reads as `thinking` even once paused; `paused` shows after it settles. */
  runState(): PersonaRunState {
    const state = getOrCreatePersonaState(this.db, this.owner);
    if (this.thinking) return "thinking";
    if (state.paused) return "paused";
    if (state.lastError) return "error";
    return "idle";
  }

  getState(): PersonaState {
    const state = getOrCreatePersonaState(this.db, this.owner);
    return {
      owner: this.owner,
      runState: this.runState(),
      threadId: this.consoleThreadId(),
      claudeSessionId: state.claudeSessionId,
      epoch: state.epoch,
      lastContextTokens: state.lastContextTokens,
      pendingInbox: countPendingPersonaInbox(this.db, this.owner),
      lastTurnAt: state.lastTurnAt,
      lastError: state.lastError,
      ...this.launchCapacity(),
    };
  }

  /**
   * Broadcasts `persona:state`; called on every run-state change and on the
   * tick. The tick passes `onlyIfChanged`, so an idle Persona does not push an
   * identical frame (and a re-render) to every client every few seconds.
   */
  publishState(opts: { onlyIfChanged?: boolean } = {}): void {
    const canAct = this.canAct();
    if (this.lastCanAct && !canAct) this.reannounceHeldAsks();
    this.lastCanAct = canAct;
    const state = this.getState();
    // The host reading moves on every tick; only a change to the effective cap,
    // the host limit or the queue is worth a frame of its own.
    const json = JSON.stringify({
      ...state,
      host: state.host && { ...state.host, memAvailableBytes: undefined, load1: undefined },
    });
    if (opts.onlyIfChanged && json === this.lastStateJson) return;
    this.lastStateJson = json;
    this.publish({ type: "persona:state", payload: state, timestamp: new Date().toISOString() });
  }

  /**
   * Re-broadcasts `ask:new`, marked `personaHandled: false`, for every pending
   * ask on a session Persona owns. While Persona could act, those asks went out
   * marked as Persona's, so the other surfaces skipped them; once it can't
   * (paused, failing, stopped) they'd otherwise reach no one. Persona's own
   * event router ignores these frames — the asks are already in its inbox or
   * its job snapshot. An ask on the owner's approval card stays with the
   * card, which reaches the owner whatever Persona's state.
   */
  private reannounceHeldAsks(): void {
    const owned = (ask: Ask) => {
      const job = personaJobForSession(this.db, ask.sessionId);
      return !!job && job.job.owner === this.owner && !ownerCardHoldsAsk(this.db, this.owner, ask.id);
    };
    for (const ask of getPendingAsks(this.db).filter(owned)) {
      this.broadcastFn({
        type: "ask:new",
        payload: { ...ask, personaHandled: false },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * The one exit for frames leaving the runtime, its tools included. Every
   * `persona:*` frame is addressed to the owner alone (`audience`), since
   * Persona's conversation, jobs and approvals are the owner's business.
   */
  private publish(message: WsMessage): void {
    if (!message.type.startsWith("persona:")) {
      this.broadcastFn(message);
      return;
    }
    this.broadcastFn({ ...message, audience: this.owner });
    // A card someone else must decide (the host, for a guest's floor hold) reaches them too.
    const approver = message.type === "persona:approval" ? (message.payload as PersonaApproval).approver : undefined;
    if (approver && approver !== this.owner) this.broadcastFn({ ...message, audience: approver });
  }

  /**
   * Whether this runtime may present the owner secret right now: the host's
   * always (only an approved action asks to), a guest's only while carrying
   * out a card the host was the approver of and decided.
   */
  private mayActAsOwner(): boolean {
    if (this.isHost) return true;
    const approval = this.executing.getStore();
    return !!approval && approval.approver === this.host && approval.decidedBy === this.host;
  }

  // ── In-process requests ───────────────────────────────────────────────────

  private async withSelfActing<T>(ids: Array<string | undefined>, fn: () => Promise<T>): Promise<T> {
    const present = ids.filter((id): id is string => !!id);
    for (const id of present) this.selfActingIds.set(id, (this.selfActingIds.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      for (const id of present) {
        const n = (this.selfActingIds.get(id) ?? 1) - 1;
        if (n <= 0) this.selfActingIds.delete(id);
        else this.selfActingIds.set(id, n);
      }
    }
  }

  /**
   * Calls a collector route in-process. Every request carries this runtime's
   * writer secret, which the collector resolves to this runtime's owner (a
   * guest's Persona acts as the guest, never as the loopback host), and the
   * local write token clears the gated writes. `asPersona` also presents
   * Persona's own token, for the routes only Persona may call (they refuse a
   * caller without it). `asOwner` presents the owner secret instead; only an
   * action the owner approved (approve()) is carried out with it, and in a
   * guest's runtime only one the host approved (mayActAsOwner).
   */
  private async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    opts: { asPersona?: boolean; asOwner?: boolean } = {}
  ): Promise<InProcessResponse> {
    if (!this.fetcher) return { status: 503, body: { error: "collector routes are not bound" } };
    if (opts.asOwner && !this.mayActAsOwner()) {
      return {
        status: 403,
        body: { error: `only ${this.host}'s approval lets ${this.owner}'s Persona act with the host's authority` },
      };
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.writeToken) headers["x-standup-write-token"] = this.writeToken;
    headers[PERSONA_WRITER_HEADER] = this.writerSecret;
    if (opts.asOwner) headers[OWNER_TOKEN_HEADER] = this.ownerToken();
    else if (opts.asPersona) headers[PERSONA_TOKEN_HEADER] = this.token;
    const res = await this.fetcher(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    const asObject =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    return { status: res.status, body: asObject };
  }
}

/** The schedule run `item` wakes Persona for, when it is a schedule run's wake (not a brief). */
function scheduleRunOfWake(item: PersonaInboxItem): string | null {
  if (item.kind !== "schedule" || item.payload.brief === true) return null;
  const runId = item.payload.runId;
  return typeof runId === "string" && runId ? runId : null;
}

function describeItem(item: PersonaInboxItem): string {
  if (item.kind === "user_message") {
    const text = typeof item.payload.text === "string" ? item.payload.text : "";
    const media = Array.isArray(item.payload.attachmentIds) ? item.payload.attachmentIds.length : 0;
    if (!text.trim() && media > 0) return `your message with ${media === 1 ? "an attachment" : `${media} attachments`}`;
    return `your message "${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;
  }
  if (item.kind === "worker_event") return `worker ${String(item.payload.type ?? "event")}`;
  return item.kind.replace("_", " ");
}
