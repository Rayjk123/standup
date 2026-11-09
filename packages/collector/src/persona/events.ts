import type { Database } from "bun:sqlite";
import type {
  Ask,
  Checkpoint,
  Launch,
  PersonaApproval,
  PersonaInboxKind,
  PersonaJob,
  PipelineBlockedPayload,
  PipelineParkedPayload,
  PipelineRun,
  PlanApproval,
  TaskRun,
  Ticket,
  WsMessage,
} from "@standup/shared";
import {
  countSteersWithBody,
  createSteer,
  flagPersonaJobWaitingUser,
  getAsk,
  getLatestCheckpoint,
  getLaunch,
  getLaunchBySession,
  getLaunchByWorktree,
  getPendingSteers,
  getPipelineRunByLaunch,
  latestSubmittedReviewPacketForLaunch,
  listParkedPipelineRunsOnJob,
  reviewPacketReadyForLaunch,
  markPersonaJobWorkerResumed,
  personaJobForLaunch,
  personaJobForSession,
  refreshPersonaJob,
  unansweredWorkerQuestionsForLaunch,
} from "@standup/store";
import { launchHasOwnChange, reviewPacketAwaitsCodeReview, reviewPacketNeeded } from "../pipeline/runners.js";
import { reviewOwnerForLaunch } from "../review/stage.js";
import { isFloorGate } from "../floor/gate.js";
import { isReviewHandoff, ownerHandoff } from "./handoff.js";
import { mediaProvenanceFor } from "./media-provenance.js";
import { IDLE_NOTICE_GATE } from "./policy.js";

type Broadcast = (message: WsMessage) => void;

/** The text Claude Code's `idle_prompt` notification carries. */
export const IDLE_PROMPT_NOTICE = "Claude is waiting for your input";

export { IDLE_NOTICE_GATE };

/**
 * Whether `ask` is the collector's own idle notice for a launched session (a
 * turn end) rather than a real prompt. Decided by the server-set gate alone:
 * an ask's question is worker text and can imitate the notice's wording.
 */
export function isIdleNoticeAsk(ask: Pick<Ask, "kind" | "gate">): boolean {
  return ask.kind === "permission_prompt" && ask.gate === IDLE_NOTICE_GATE;
}

/** Bounds on worker-supplied ask text carried into an inbox payload. */
export const MAX_ASK_QUESTION_CHARS = 2_000;
export const MAX_ASK_OPTIONS = 20;
export const MAX_ASK_OPTION_CHARS = 200;
/** Bound on other free text (summaries, errors, plan text) carried into an inbox payload. */
const MAX_FIELD_CHARS = 4_000;
/** Entries kept in each repeat-suppression set before the oldest are dropped. */
const MAX_SEEN = 2_000;
/** Bound on the hand-off sentence quoted in a job's note. */
const MAX_HANDOFF_CHARS = 200;
/** Checkpoint sources that speak for the worker's own turn (not a subagent's). */
const HANDOFF_SOURCES = new Set(["self-reported", "auto"]);

/** What a worker is told when it reports the change ready for review with nothing in the Review tab. */
export const REVIEW_PACKET_STEER =
  "Your report says the change is ready for review, but no review packet of this launch has reached the owner's " +
  "Review tab — so there is nothing there for them to look at. Call submit_review_packet with the packet for this " +
  "change (and its screenshots as media) before handing it over.";

/**
 * What the worker of a project that requires a linked code review is told
 * when it reports the change ready for review before its code_review stage:
 * the packet must link the review, so it comes after.
 */
export const REVIEW_PACKET_CODE_REVIEW_FIRST_STEER =
  "Your report says the change is ready for review, but this project's review packet must link its code review, and " +
  "the pipeline hasn't reached or finished its code_review stage yet — so there is nothing in the Review tab for the owner. " +
  "Advance the run with pipeline_advance until it reaches code_review, cut the code review and report it there, then submit the " +
  "review packet with the code review in its links.";

/**
 * Times a worker is pushed for its packet in one round of the work before its
 * hand-off reaches the owner anyway — a worker that can't submit one (at the
 * submission cap, say) is never left silent.
 */
export const MAX_REVIEW_PACKET_STEERS = 2;

/**
 * Pushes the worker of `sessionId` to submit its review packet, when the
 * launch of that session has no packet in the owner's Review tab and could
 * submit one: the steer says what to call, in place of telling the owner the
 * change is ready. Whether it was pushed (a steer still queued for the
 * session counts) — false when there is a packet already, no launch to read,
 * the launch has no trusted owner to submit to, its work already landed, a
 * launch outside the pipeline has no code change of its own (research or docs
 * handing something over), or the worker was already pushed
 * MAX_REVIEW_PACKET_STEERS times.
 */
function pushForReviewPacket(db: Database, sessionId: string, owner: string): boolean {
  const launch = getLaunchBySession(db, sessionId);
  if (!launch) return false;
  const run = getPipelineRunByLaunch(db, launch.id);
  let steer = REVIEW_PACKET_STEER;
  if (run && run.status !== "disabled") {
    // The pipeline's own gate decides: a packet is ready, the launch can't
    // submit one (no trusted owner), or its work already landed. A packet
    // that must link a code review not cut yet waits for the code_review
    // stage, which the worker is sent on to instead.
    if (reviewPacketAwaitsCodeReview(db, run)) steer = REVIEW_PACKET_CODE_REVIEW_FIRST_STEER;
    else if (!reviewPacketNeeded(db, run)) return false;
  } else {
    // A launch without the pipeline is held to the same rule — no review of
    // a change reaches the owner without its packet — wherever it can submit
    // one and has a change of its own that hasn't landed.
    if (reviewPacketReadyForLaunch(db, launch.id) || !reviewOwnerForLaunch(db, launch)) return false;
    if (!launchHasOwnChange(launch)) return false;
  }
  if (getPendingSteers(db, sessionId).some((s) => s.body === steer)) return true;
  // Counted per round: since the launch's newest packet last changed (its
  // submission, or the owner's send-back), as each round needs a packet of its own.
  const since = latestSubmittedReviewPacketForLaunch(db, launch.id)?.updatedAt;
  if (countSteersWithBody(db, sessionId, steer, since) >= MAX_REVIEW_PACKET_STEERS) return false;
  createSteer(db, sessionId, steer, { audience: owner });
  return true;
}

function clipField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function clipOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  return options
    .filter((o): o is string => typeof o === "string")
    .slice(0, MAX_ASK_OPTIONS)
    .map((o) => clipField(o, MAX_ASK_OPTION_CHARS)!);
}

/** An insertion-ordered map that forgets its oldest entries past `max`. */
class BoundedMap {
  private readonly items = new Map<string, string>();
  constructor(private readonly max: number) {}
  get(key: string): string | undefined {
    return this.items.get(key);
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  set(key: string, value = ""): void {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.max) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
  delete(key: string): void {
    this.items.delete(key);
  }
}

export interface BroadcastTap {
  broadcast: Broadcast;
  subscribe(listener: (message: WsMessage) => void): () => void;
}

export function createBroadcastTap(base: Broadcast): BroadcastTap {
  const listeners = new Set<(message: WsMessage) => void>();
  return {
    broadcast(message) {
      base(message);
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (err) {
          console.error("[broadcast-tap] listener failed:", err);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Marks an `ask:new` / `ask:resolved` frame `personaHandled` when a running
 * Persona handles the ask's session, so other surfaces (Slack ask cards,
 * pushes) leave it to Persona instead of delivering it to the owner too.
 * `ask:resolved` names only the ask, so its session is looked up. An
 * `ask:new` that `cardDecider` says is on an owner's approval card is marked
 * too, whether or not Persona can act, and carries the card's decider as
 * `cardDecider`: the card reaches its decider wherever it is shown, and a
 * surface the card doesn't reach can still deliver the ask itself. Every
 * other frame, and an ask Persona does not handle, passes through unchanged.
 */
export function withPersonaHandled(
  message: WsMessage,
  handles: (sessionId: string) => boolean,
  sessionOfAsk: (askId: string) => string | undefined,
  cardDecider?: (askId: string, sessionId: string) => string | undefined
): WsMessage {
  if (message.type !== "ask:new" && message.type !== "ask:resolved") return message;
  const payload = message.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") return message;
  const sessionId =
    message.type === "ask:new"
      ? typeof payload.sessionId === "string"
        ? payload.sessionId
        : undefined
      : typeof payload.askId === "string"
        ? sessionOfAsk(payload.askId)
        : undefined;
  if (!sessionId) return message;
  const decider = message.type === "ask:new" && typeof payload.id === "string" ? cardDecider?.(payload.id, sessionId) : undefined;
  if (decider) return { ...message, payload: { ...payload, personaHandled: true, cardDecider: decider } };
  if (!handles(sessionId)) return message;
  return { ...message, payload: { ...payload, personaHandled: true } };
}

/**
 * The wake payload of a pending worker ask on `jobId`'s session: the ask
 * clipped for the prompt and, for a hold on reading an owner upload, the
 * collector's word on whether Persona passed that file to this worker.
 */
export function askWakePayload(
  deps: Pick<PersonaEventRouterDeps, "db" | "owner" | "dataDir">,
  ask: Pick<Ask, "id" | "kind" | "question" | "options" | "gate" | "sessionId">,
  jobId: string
): Record<string, unknown> {
  const provenance =
    isFloorGate(ask.gate) && typeof ask.question === "string"
      ? mediaProvenanceFor(deps.db, deps.owner, ask.sessionId, ask.question, { dataDir: deps.dataDir })
      : null;
  return {
    type: "ask",
    ask: {
      id: ask.id,
      kind: ask.kind,
      question: clipField(ask.question, MAX_ASK_QUESTION_CHARS) ?? "",
      options: clipOptions(ask.options),
      ...(ask.gate ? { gate: ask.gate } : {}),
    },
    ...(provenance ? { mediaProvenance: provenance } : {}),
    jobId,
    sessionId: ask.sessionId,
  };
}

export interface PersonaEnqueue {
  (
    kind: PersonaInboxKind,
    payload: Record<string, unknown>,
    opts?: { coalesceKey?: string; delayMs?: number }
  ): void;
}

export interface PersonaEventRouterDeps {
  db: Database;
  owner: string;
  /** The data dir whose persona-attachments folder holds the owner's uploads; without it no media read is vouched for. */
  dataDir?: string;
  coalesceMs: number;
  enqueue: PersonaEnqueue;
  /**
   * Whether a Persona tool call is acting on this session or launch right now.
   * Frames its own action emits (a stop's `launch:stopped`, an interrupt's idle
   * status) arrive while it runs and need no reaction.
   */
  isSelfActing(id: string): boolean;
  /**
   * Publishes a refreshed job (e.g. once its launch binds a session). The
   * runtime's broadcaster, which addresses `persona:*` frames to the owner.
   */
  publishJob?(job: PersonaJob): void;
}

const TERMINAL_RUN = new Set(["succeeded", "failed", "lost", "cancelled"]);
/** Job statuses after which nothing waits on the job any more. */
const CLOSED_JOB = new Set(["done", "failed", "cancelled"]);
// `waiting` is not a turn end: it accompanies an ask, whose own frame wakes
// Persona (or, for the idle notice, is turned into the turn end).
const TURN_END_STATUS = new Set(["idle", "done"]);

/**
 * Turns broadcast frames about Persona-owned sessions into inbox items. Every
 * frame for a session no Persona job of `owner` owns is ignored, as are the
 * frames Persona's own actions produce that need no reaction (`ask:resolved`,
 * `steer:*`, `session:message`, `persona:*`, checkpoints). Frames that change
 * an owned job's live facts (asks, approvals, worker status, checkpoints)
 * also re-derive that job and publish it when its view changed.
 */
export function createPersonaEventRouter(deps: PersonaEventRouterDeps): (message: WsMessage) => void {
  // Terminal run / review-ready frames repeat (heartbeats, re-broadcasts); one
  // wake per run status and per review round of a ticket is enough.
  const seenRuns = new BoundedMap(MAX_SEEN);
  /** Ticket id → the review round (readyAt) that already woke Persona. */
  const ticketRounds = new BoundedMap(MAX_SEEN);
  /**
   * Sessions whose `ended` item is queued under their coalesce key. A later
   * turn end for the same session must not replace it: the end is the fact
   * Persona needs, and an idle status often trails it.
   */
  const endedSessions = new BoundedMap(MAX_SEEN);
  /** Pipeline runs whose completion already woke Persona (their frames repeat). */
  const completedRuns = new BoundedMap(MAX_SEEN);

  const ownedSession = (sessionId: string | undefined) => {
    if (!sessionId) return null;
    const owned = personaJobForSession(deps.db, sessionId);
    return owned && owned.job.owner === deps.owner ? owned : null;
  };
  const ownedLaunch = (launchId: string | undefined) => {
    if (!launchId) return null;
    const owned = personaJobForLaunch(deps.db, launchId);
    return owned && owned.job.owner === deps.owner ? owned : null;
  };
  const coalesced = { delayMs: deps.coalesceMs };
  /** The owner's review questions an ended worker leaves unanswered, for Persona to answer instead. */
  const reviewQuestionsLeft = (launchId: string | undefined) => {
    const questions = launchId ? unansweredWorkerQuestionsForLaunch(deps.db, launchId) : [];
    return questions.length > 0 ? { reviewQuestions: questions.slice(0, 10) } : {};
  };

  /** Job id → the last `persona:job` frame's fingerprint, so an unchanged re-derivation isn't re-sent. */
  const publishedJobs = new BoundedMap(MAX_SEEN);
  const fingerprint = (job: PersonaJob) =>
    JSON.stringify([job.status, job.updatedAt, job.note, job.sessionIds, job.view]);
  /** Publishes `job` unless the last frame for it already showed the same thing. */
  const publishJob = (job: PersonaJob) => {
    const print = fingerprint(job);
    if (publishedJobs.get(job.id) === print) return;
    publishedJobs.set(job.id, print);
    deps.publishJob?.(job);
  };

  /**
   * Marks an active job `waiting_user` when the worker's turn ended on a report
   * that hands the next step to the owner, so the job shows as needing them.
   */
  const flagHandoff = (jobId: string, checkpoint: Checkpoint): boolean => {
    if (!HANDOFF_SOURCES.has(checkpoint.source)) return false;
    const sentence = ownerHandoff(checkpoint.summary, deps.owner);
    if (!sentence) return false;
    // A worker that says the change is ready for review without a packet in
    // the Review tab is pushed to submit one; the owner isn't told yet,
    // because there would be nothing there for them to look at.
    if (isReviewHandoff(sentence) && pushForReviewPacket(deps.db, checkpoint.sessionId, deps.owner)) return false;
    const note = `Waiting on the owner — the worker handed off: "${clipField(sentence, MAX_HANDOFF_CHARS)}"`;
    const job = flagPersonaJobWaitingUser(deps.db, jobId, checkpoint.id, note);
    if (!job) return false;
    publishJob(job);
    return true;
  };

  const enqueueTurnEnd = (sessionId: string, jobId: string, status: string) => {
    if (endedSessions.has(sessionId)) return;
    const checkpoint = getLatestCheckpoint(deps.db, sessionId);
    const flagged = checkpoint ? flagHandoff(jobId, checkpoint) : false;
    deps.enqueue(
      "worker_event",
      {
        type: "turn_end",
        status,
        jobId,
        sessionId,
        lastCheckpoint: clipField(checkpoint?.summary, MAX_FIELD_CHARS),
        ...(checkpoint ? { checkpointId: checkpoint.id, checkpointChars: checkpoint.summary.length } : {}),
        ...(flagged ? { flaggedWaitingUser: true } : {}),
      },
      { ...coalesced, coalesceKey: `session:${sessionId}` }
    );
  };

  /**
   * Re-derives the job a frame touches and publishes it when what the owner
   * would see changed, so the Jobs list follows asks, approvals and worker
   * status live. A waiting_user the frame answered is cleared here (see
   * refreshPersonaJob).
   */
  const refreshJob = (jobId: string | undefined) => {
    if (!jobId) return;
    const refreshed = refreshPersonaJob(deps.db, jobId);
    if (refreshed && refreshed.job.owner === deps.owner) publishJob(refreshed.job);
  };

  /** The job whose live facts `message` changes, if it is one of this owner's. */
  const touchedJob = (message: WsMessage, payload: Record<string, unknown>): string | undefined => {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    switch (message.type) {
      case "ask:new":
      case "session:status":
      case "session:end":
      case "checkpoint:new":
        return ownedSession(str(payload.sessionId))?.job.id;
      case "ask:resolved": {
        const askId = str(payload.askId);
        return askId ? ownedSession(getAsk(deps.db, askId)?.sessionId)?.job.id : undefined;
      }
      case "launch:started":
        return ownedLaunch(str(payload.id))?.job.id;
      case "launch:stopped":
      case "launch:reaped":
        return ownedLaunch(str(payload.launchId))?.job.id;
      case "persona:approval": {
        const approval = payload as unknown as PersonaApproval;
        return approval.owner === deps.owner ? approval.jobId : undefined;
      }
      default:
        return undefined;
    }
  };

  return (message) => {
    const payload = message.payload as Record<string, unknown> | null | undefined;
    if (!payload || typeof payload !== "object") return;
    if (message.type === "persona:job") {
      const job = payload as unknown as PersonaJob;
      if (job.id && job.owner === deps.owner) {
        publishedJobs.set(job.id, fingerprint(job));
        dependencyClosed(job);
      }
      return;
    }
    route(message, payload);
    refreshJob(touchedJob(message, payload));
  };

  /**
   * A job closed: each of the owner's workers parked waiting on it wakes
   * Persona once per closing status, to un-park it with what to do next.
   */
  function dependencyClosed(job: PersonaJob): void {
    if (!CLOSED_JOB.has(job.status)) return;
    for (const run of listParkedPipelineRunsOnJob(deps.db, job.id)) {
      if (run.owner !== deps.owner || (run.status !== "active" && run.status !== "waiting_user")) continue;
      const seenKey = `parked:${run.id}:${job.id}:${job.status}:${run.parked?.at ?? ""}`;
      if (seenRuns.has(seenKey)) continue;
      const owned = ownedLaunch(run.launchId);
      if (!owned) continue;
      seenRuns.set(seenKey);
      deps.enqueue(
        "worker_event",
        {
          type: "parked_dependency_closed",
          jobId: owned.job.id,
          sessionId: getLaunch(deps.db, run.launchId)?.sessionId ?? undefined,
          closedJobId: job.id,
          status: job.status,
        },
        { coalesceKey: `parked:${run.id}` }
      );
    }
  }

  function route(message: WsMessage, payload: Record<string, unknown>): void {
    switch (message.type) {
      case "ask:new": {
        const ask = payload as unknown as Ask;
        if (ask.status && ask.status !== "pending") return;
        // Persona's own re-announcement of an ask it can no longer act on,
        // addressed to the other surfaces; the ask is already Persona's.
        if (payload.personaHandled === false) return;
        const owned = ownedSession(ask.sessionId);
        if (!owned) return;
        if (isIdleNoticeAsk(ask)) {
          if (owned.rootSessionId !== ask.sessionId || deps.isSelfActing(ask.sessionId)) return;
          enqueueTurnEnd(ask.sessionId, owned.job.id, "idle");
          return;
        }
        deps.enqueue("worker_event", askWakePayload(deps, ask, owned.job.id), { coalesceKey: `ask:${ask.id}` });
        return;
      }

      case "plan:updated": {
        const plan = payload as unknown as PlanApproval;
        if (plan.status !== "awaiting_approval") return;
        const owned = ownedLaunch(plan.launchId);
        if (!owned) return;
        const launch = getLaunch(deps.db, plan.launchId);
        deps.enqueue(
          "worker_event",
          {
            type: "plan",
            plan: {
              id: plan.id,
              launchId: plan.launchId,
              plan: clipField(plan.plan, MAX_FIELD_CHARS),
              planChars: plan.plan?.length ?? 0,
              acceptanceCriterion: clipField(plan.acceptanceCriterion, MAX_FIELD_CHARS),
            },
            jobId: owned.job.id,
            sessionId: launch?.sessionId,
            projectId: plan.projectId,
          },
          { coalesceKey: `plan:${plan.id}` }
        );
        return;
      }

      case "session:status": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
        const status = typeof payload.status === "string" ? payload.status : undefined;
        // A revived session (hooks again after an end) is no longer ended either.
        if (sessionId && payload.revived === true) endedSessions.delete(sessionId);
        if (!sessionId || !status) return;
        // A session that runs again (a resumed launch) is no longer ended.
        if (!TURN_END_STATUS.has(status)) {
          if (status === "running") {
            endedSessions.delete(sessionId);
            // A worker running again answers the hand-off it raised.
            const owned = ownedSession(sessionId);
            if (owned && owned.rootSessionId === sessionId) markPersonaJobWorkerResumed(deps.db, owned.job.id, sessionId);
          }
          return;
        }
        if (deps.isSelfActing(sessionId)) return;
        const owned = ownedSession(sessionId);
        // A subagent child settling is not its worker's turn ending.
        if (!owned || owned.rootSessionId !== sessionId) return;
        enqueueTurnEnd(sessionId, owned.job.id, status);
        return;
      }

      case "session:end": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
        if (!sessionId || deps.isSelfActing(sessionId)) return;
        // A worker paused for idleness ends its session on purpose and resumes
        // on its next message: not a worker lost.
        if (getLaunchBySession(deps.db, sessionId)?.reapedAt) return;
        const owned = ownedSession(sessionId);
        if (!owned || owned.rootSessionId !== sessionId) return;
        endedSessions.set(sessionId);
        deps.enqueue(
          "worker_event",
          { type: "ended", jobId: owned.job.id, sessionId, launchId: owned.launchId, ...reviewQuestionsLeft(owned.launchId) },
          { ...coalesced, coalesceKey: `session:${sessionId}` }
        );
        return;
      }

      case "launch:stopped": {
        const launchId = typeof payload.launchId === "string" ? payload.launchId : undefined;
        if (!launchId || deps.isSelfActing(launchId)) return;
        const owned = ownedLaunch(launchId);
        if (!owned) return;
        const launch = getLaunch(deps.db, launchId);
        if (launch?.sessionId && deps.isSelfActing(launch.sessionId)) return;
        if (launch?.reapedAt) return;
        if (launch?.sessionId) endedSessions.set(launch.sessionId);
        deps.enqueue(
          "worker_event",
          { type: "ended", jobId: owned.job.id, sessionId: launch?.sessionId, launchId, ...reviewQuestionsLeft(launchId) },
          { ...coalesced, coalesceKey: launch?.sessionId ? `session:${launch.sessionId}` : `launch:${launchId}` }
        );
        return;
      }

      case "launch:started": {
        const launch = payload as unknown as Launch;
        if (!launch.id) return;
        const owned = ownedLaunch(launch.id);
        if (!owned) return;
        // A bound worker session reaches the Jobs list through refreshJob.
        if (launch.status !== "failed") return;
        deps.enqueue(
          "worker_event",
          {
            type: "launch_failed",
            jobId: owned.job.id,
            launchId: launch.id,
            sessionId: launch.sessionId,
            projectId: launch.projectId,
            error: clipField(launch.error, MAX_FIELD_CHARS),
          },
          { ...coalesced, coalesceKey: `launch:${launch.id}` }
        );
        return;
      }

      case "task:updated": {
        const run = payload as unknown as TaskRun;
        if (!run.id || !TERMINAL_RUN.has(run.status)) return;
        const seenKey = `${run.id}:${run.status}`;
        if (seenRuns.has(seenKey)) return;
        let owned = ownedSession(run.sessionId);
        if (!owned && run.worktreePath) {
          const launch = getLaunchByWorktree(deps.db, run.worktreePath);
          const byLaunch = launch ? ownedLaunch(launch.id) : null;
          if (byLaunch && launch) {
            owned = { job: byLaunch.job, launchId: launch.id, rootSessionId: launch.sessionId ?? "", personaPlanGate: byLaunch.personaPlanGate };
          }
        }
        if (!owned) return;
        seenRuns.set(seenKey);
        deps.enqueue(
          "worker_event",
          {
            type: "run",
            status: run.status,
            jobId: owned.job.id,
            sessionId: run.sessionId ?? (owned.rootSessionId || undefined),
            summary: clipField(run.summary, MAX_FIELD_CHARS),
            error: clipField(run.error, MAX_FIELD_CHARS),
          },
          { ...coalesced, coalesceKey: `run:${run.id}` }
        );
        return;
      }

      case "pipeline:blocked": {
        // A run of an owned job's launch stopped on something Persona decides;
        // a later block of the same run replaces an undelivered one.
        const blocked = payload as unknown as PipelineBlockedPayload;
        if (!blocked.runId || !blocked.launchId || blocked.owner !== deps.owner) return;
        const owned = ownedLaunch(blocked.launchId);
        if (!owned) return;
        deps.enqueue(
          "worker_event",
          {
            type: "pipeline_blocked",
            jobId: owned.job.id,
            sessionId: blocked.sessionId,
            launchId: blocked.launchId,
            runId: blocked.runId,
            stage: clipField(blocked.stage, 80),
            waitingKind: clipField(blocked.waitingKind, 40),
            reason: clipField(blocked.reason, MAX_FIELD_CHARS),
            options: Array.isArray(blocked.options) ? blocked.options.slice(0, 10).map((o) => String(o).slice(0, 40)) : [],
          },
          { coalesceKey: `pipeline:${blocked.runId}` }
        );
        return;
      }

      case "pipeline:parked": {
        // A worker of an owned job parked its own run to wait; a later park of
        // the same run replaces an undelivered one.
        const parked = payload as unknown as PipelineParkedPayload;
        if (!parked.runId || !parked.launchId || parked.owner !== deps.owner) return;
        const owned = ownedLaunch(parked.launchId);
        if (!owned) return;
        deps.enqueue(
          "worker_event",
          {
            type: "worker_parked",
            jobId: owned.job.id,
            sessionId: parked.sessionId,
            launchId: parked.launchId,
            runId: parked.runId,
            stage: clipField(parked.stage, 80),
            reason: clipField(parked.reason, MAX_FIELD_CHARS),
            ...(parked.waitingOnJobId ? { waitingOnJobId: clipField(parked.waitingOnJobId, 80) } : {}),
          },
          { coalesceKey: `parked:${parked.runId}` }
        );
        return;
      }

      case "pipeline:updated": {
        const run = payload as unknown as PipelineRun;
        if (!run.id || run.status !== "complete" || completedRuns.has(run.id)) return;
        const owned = ownedLaunch(run.launchId);
        // A job already closed has nothing left to verify (a re-broadcast after a restart).
        if (!owned || (owned.job.status !== "active" && owned.job.status !== "waiting_user")) return;
        completedRuns.set(run.id);
        const launch = getLaunch(deps.db, run.launchId);
        deps.enqueue(
          "worker_event",
          {
            type: "pipeline_complete",
            jobId: owned.job.id,
            runId: run.id,
            launchId: run.launchId,
            sessionId: launch?.sessionId,
            projectId: run.projectId,
          },
          { ...coalesced, coalesceKey: `pipeline:${run.id}` }
        );
        return;
      }

      case "ticket:updated": {
        const ticket = payload as unknown as Ticket;
        if (!ticket.id) return;
        // A ticket can return to review after rework; each entry into
        // needs_review (its readyAt) is its own wake.
        if (ticket.status !== "needs_review") {
          ticketRounds.delete(ticket.id);
          return;
        }
        const round = ticket.readyAt ? String(ticket.readyAt) : "";
        if (ticketRounds.has(ticket.id) && ticketRounds.get(ticket.id) === round) return;
        const owned =
          (ticket.launchId ? ownedLaunch(ticket.launchId) : null) ?? (ticket.sessionId ? ownedSession(ticket.sessionId) : null);
        if (!owned) return;
        ticketRounds.set(ticket.id, round);
        deps.enqueue(
          "worker_event",
          {
            type: "ready_for_review",
            jobId: owned.job.id,
            sessionId: ticket.sessionId,
            ticket: {
              id: ticket.id,
              title: clipField(ticket.title, MAX_FIELD_CHARS),
              status: ticket.status,
              reviewUrl: clipField(ticket.reviewUrl, MAX_FIELD_CHARS),
            },
          },
          { ...coalesced, coalesceKey: `ticket:${ticket.id}:${round}` }
        );
        return;
      }

      default:
        return;
    }
  }
}
