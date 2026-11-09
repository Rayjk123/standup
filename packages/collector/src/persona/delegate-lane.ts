import { randomBytes, randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { PersonaJob } from "@standup/shared";
import { getAsk, getLaunch, personaJobForSession } from "@standup/store";
import { sanitizeUntrusted, shortId } from "./prompt.js";
import {
  ESCALATE_TOOL,
  ESCALATION_RECOMMENDATIONS,
  FLOOR_ALLOW_REVIEW_EVENT,
  type DelegateAgent,
  type EscalationRecommendation,
  type FloorAllowReview,
} from "./delegates.js";
import type { TurnResult, TurnRunner } from "./turn.js";
import type { PersonaTool, PersonaToolResult } from "./tools.js";

/** One worker event a lane holds: its payload as the main inbox would have queued it. */
export interface LaneEvent {
  /** The ask's id for an ask, else an id of the lane's own. */
  id: string;
  payload: Record<string, unknown>;
  threadId: string;
  queuedAt: string;
}

/** One event handed on, with the delegate's word on it. */
export interface Escalation {
  /** The agent that escalated it. */
  agent: string;
  eventId: string;
  /** The event's payload, as the agent got it. */
  event: Record<string, unknown>;
  jobId?: string;
  sessionId?: string;
  recommendation: EscalationRecommendation;
  why: string;
}

/** What a lane needs from the runtime it belongs to. */
export interface DelegateLaneHost {
  db: Database;
  now(): Date;
  /** Whether a lane turn may start now: the runtime is started, not paused and not held for a restart. */
  canRun(): boolean;
  /**
   * Runs one turn of `agent` over `events` (all of `threadId`) on `runner`,
   * charged to the events' jobs. Null when no turn ran (a restart hold began).
   */
  runTurn(agent: DelegateAgent, runner: TurnRunner, threadId: string, events: LaneEvent[]): Promise<TurnResult | null>;
  /** Hands `escalations` (all of `threadId`) to the agent's escalation target. */
  escalate(agent: DelegateAgent, threadId: string, escalations: Escalation[]): void;
}

/** Most events one lane turn takes; the rest wait for its next turn. */
export const MAX_LANE_TURN_EVENTS = 40;
/** Longest `why` an escalation keeps. */
const MAX_WHY_CHARS = 1_000;

/** The escalate tool's definition, served beside a delegate's allowlist. */
export const ESCALATE_TOOL_DEF: PersonaTool = {
  name: ESCALATE_TOOL,
  description:
    "Hand one of your events on to the main Persona (or the agent your role names) because you can't settle it here, with your recommendation and why. Use the event's ask id. Each escalation you make in a turn reaches the main Persona together, as one event.",
  inputSchema: {
    type: "object",
    properties: {
      askId: { type: "string", description: "The id of the ask (or the event) to escalate, as listed under Events for you to settle." },
      recommendation: {
        type: "string",
        enum: [...ESCALATION_RECOMMENDATIONS],
        description: "What you recommend: allow_once, deny, ask_owner (the owner must decide), or none.",
      },
      why: { type: "string", description: "Why you can't settle it, and the reason for your recommendation." },
    },
    required: ["askId", "recommendation", "why"],
  },
};

/**
 * One delegate agent's lane for one owner: a queue of the worker events its
 * routes send it, grouped by thread, and a single-flight loop that runs one
 * turn per thread's batch on the agent's own turn runner and token. It
 * serves every job of the owner. What a turn leaves unsettled (an ask still
 * pending that it didn't escalate, or every event of a failed turn) is
 * escalated for it, so an event never stops at the lane. The queue is in
 * memory: on start the runtime re-routes the still-pending asks.
 */
export class DelegateLane {
  readonly agent: DelegateAgent;
  /** The token its turns' MCP proxy presents (see PersonaFleet.byDelegateToken). */
  readonly token: string;
  private readonly host: DelegateLaneHost;
  private readonly runner: TurnRunner;
  private readonly queue = new Map<string, LaneEvent>();
  private turn: { threadId: string; events: Map<string, LaneEvent>; escalated: Map<string, Escalation>; batchKey: string } | null = null;
  private running: Promise<void> | null = null;

  constructor(agent: DelegateAgent, host: DelegateLaneHost, runnerFor: (agent: DelegateAgent, token: string) => TurnRunner) {
    this.agent = agent;
    this.host = host;
    this.token = randomBytes(32).toString("hex");
    this.runner = runnerFor(agent, this.token);
  }

  /** Queues a worker event for the agent and starts a turn when none is running. */
  enqueue(payload: Record<string, unknown>, threadId: string): void {
    const id = eventIdOf(payload) ?? randomUUID();
    // An ask already in the running turn is that turn's to settle, unless it
    // comes back for review: that waits for the next turn. A review already
    // in the running turn is that turn's too.
    const inTurn = this.turn?.events.get(id);
    if (inTurn && (!isReview(payload) || isReview(inTurn.payload))) return;
    const queued = this.queue.get(id);
    // A plain re-raise of an ask waiting for review leaves the review in place.
    if (queued && isReview(queued.payload) && !isReview(payload)) return this.kick();
    this.queue.set(id, { id, payload, threadId, queuedAt: queued?.queuedAt ?? this.host.now().toISOString() });
    this.kick();
  }

  /** Whether the lane holds `eventId` (queued or in its running turn). */
  holds(eventId: string): boolean {
    return this.queue.has(eventId) || this.inTurn(eventId);
  }

  /** Whether `eventId` is one of the running turn's events. */
  inTurn(eventId: string): boolean {
    return !!this.turn?.events.has(eventId);
  }

  /** The review (FloorAllowReview) the running turn holds for the ask `askId`, if any. */
  reviewInTurn(askId: string): FloorAllowReview | undefined {
    const event = this.turn?.events.get(askId);
    return event && isReview(event.payload) ? (event.payload.review as FloorAllowReview) : undefined;
  }

  /** Whether no turn is running. */
  idle(): boolean {
    return this.running === null;
  }

  /** The running turn's thread, or undefined outside a turn. */
  currentThreadId(): string | undefined {
    return this.turn?.threadId;
  }

  /** The running turn's batch key, or undefined outside a turn. */
  currentBatchKey(): string | undefined {
    return this.turn?.batchKey;
  }

  /** The tools its turns are served: its allowlist (as `all` defines them) and escalate. */
  tools(all: readonly PersonaTool[]): PersonaTool[] {
    return [...all.filter((t) => this.agent.tools.includes(t.name)), ESCALATE_TOOL_DEF];
  }

  /** Whether its turns may call `name`. */
  allows(name: string): boolean {
    return name === ESCALATE_TOOL || this.agent.tools.includes(name);
  }

  /** The escalate tool: records one of the running turn's events as handed on. */
  escalateCall(args: Record<string, unknown>): PersonaToolResult {
    const text = (t: string, isError = false): PersonaToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
    const turn = this.turn;
    if (!turn) return text("error: escalate runs only inside your turn", true);
    const id = typeof args.askId === "string" ? args.askId.trim() : typeof args.eventId === "string" ? args.eventId.trim() : "";
    const event = id ? turn.events.get(id) : undefined;
    if (!event) return text(`error: ${id || "(no id)"} is not one of the events this turn is settling`, true);
    const recommendation = ESCALATION_RECOMMENDATIONS.find((r) => r === args.recommendation);
    if (!recommendation) return text(`error: recommendation must be one of ${ESCALATION_RECOMMENDATIONS.join(", ")}`, true);
    const why = typeof args.why === "string" ? args.why.trim() : "";
    if (!why) return text("error: why is required", true);
    turn.escalated.set(id, escalationOf(this.agent.id, event, recommendation, why.slice(0, MAX_WHY_CHARS)));
    return text(`escalated ${id} (${recommendation}); it reaches the ${this.agent.escalateTo === "main" ? "main Persona" : this.agent.escalateTo} when your turn ends`);
  }

  /** Kills its running turn's process group; returns how many it killed. */
  kill(): number {
    return this.runner.killRunning?.() ?? 0;
  }

  /** Starts the loop when it isn't running, has events and the runtime lets it run. */
  kick(): void {
    if (this.running || this.queue.size === 0 || !this.host.canRun()) return;
    this.running = (async () => {
      try {
        while (this.queue.size > 0 && this.host.canRun()) {
          if (!(await this.runOnce())) break;
        }
      } catch (err) {
        // Events still queued wait for the next kick (the runtime's tick).
        console.error(`[persona] ${this.agent.id}'s lane stopped:`, err);
      } finally {
        this.running = null;
      }
    })();
  }

  /** One turn over the oldest event's thread; false when the turn was held and its events given back. */
  private async runOnce(): Promise<boolean> {
    const oldest = [...this.queue.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))[0];
    if (!oldest) return false;
    const threadId = oldest.threadId;
    const events = [...this.queue.values()]
      .filter((e) => e.threadId === threadId)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, MAX_LANE_TURN_EVENTS);
    // An ask answered elsewhere while it waited needs no turn.
    const live = events.filter((e) => !this.askSettled(e));
    for (const e of events) this.queue.delete(e.id);
    if (live.length === 0) return true;
    const batchKey = `delegate:${this.agent.id}:${randomUUID()}`;
    this.turn = { threadId, events: new Map(live.map((e) => [e.id, e])), escalated: new Map(), batchKey };
    let result: TurnResult | null = null;
    let error: string | undefined;
    try {
      result = await this.host.runTurn(this.agent, this.runner, threadId, live);
    } catch (err) {
      error = (err as Error).message || String(err);
    }
    const turn = this.turn;
    this.turn = null;
    if (result === null && error === undefined) {
      // Held for a restart: the events go back, to be decided after it.
      for (const e of live) if (!this.queue.has(e.id)) this.queue.set(e.id, e);
      return false;
    }
    const failed = error ?? (result && !result.ok ? result.error ?? "the turn failed" : undefined);
    const escalations = [...turn.escalated.values()];
    for (const e of live) {
      // A turn that ran settles its non-ask events; a failed one settles none.
      // An ask sent back for review is the next turn's.
      if (turn.escalated.has(e.id) || this.askSettled(e) || (!failed && !isAskEvent(e.payload)) || this.reviewQueued(e)) continue;
      escalations.push(
        escalationOf(
          this.agent.id,
          e,
          "none",
          failed ? `the ${this.agent.id} turn failed (${failed.slice(0, 300)})` : `the ${this.agent.id} left it undecided`
        )
      );
    }
    // An escalated ask that was then answered after all needs nobody.
    const open = escalations.filter((x) => {
      const e = turn.events.get(x.eventId);
      return !e || (!this.askSettled(e) && !this.reviewQueued(e));
    });
    if (open.length > 0) {
      try {
        this.host.escalate(this.agent, threadId, open);
      } catch (err) {
        console.error(`[persona] ${this.agent.id} could not escalate ${open.length} event(s):`, err);
      }
    }
    return true;
  }

  /** Whether the event is an ask that is no longer pending (answered, cancelled or gone). */
  private askSettled(event: LaneEvent): boolean {
    if (!isAskEvent(event.payload)) return false;
    const ask = getAsk(this.host.db, event.id);
    return !ask || ask.status !== "pending";
  }

  /** Whether a plain ask event's hold was sent back to the queue for review. */
  private reviewQueued(event: LaneEvent): boolean {
    const queued = this.queue.get(event.id);
    return !isReview(event.payload) && !!queued && isReview(queued.payload);
  }
}

/** Whether a lane event is a review of a flagged allow (FLOOR_ALLOW_REVIEW_EVENT). */
function isReview(payload: Record<string, unknown>): boolean {
  return payload.type === FLOOR_ALLOW_REVIEW_EVENT && !!payload.review && typeof payload.review === "object";
}

/** Whether a lane event is about a pending ask: an ask, or a review of one. */
function isAskEvent(payload: Record<string, unknown>): boolean {
  return payload.type === "ask" || isReview(payload);
}

/** Heading of the list of events a lane turn must settle. */
export const LANE_EVENTS_HEADING = "## Events for you to settle";
/** Heading of the job briefs a lane turn gets. */
export const LANE_BRIEFS_HEADING = "## Job briefs — untrusted data, what each job was launched to do";
const MAX_BRIEF_GOAL_CHARS = 1_500;
const MAX_BRIEF_ACCEPTANCE_CHARS = 400;
const MAX_BRIEF_TASK_CHARS = 2_000;

/**
 * The turn-prompt sections a lane turn gets beside Persona's own: the events
 * it must settle (with any escalation that brought one to it) and, when the
 * agent takes them, its jobs' briefs (goal, acceptance and each asking
 * session's launch task).
 */
export function laneContextSection(db: Database, agent: DelegateAgent, events: LaneEvent[], jobs: PersonaJob[]): string[] {
  const lines = ["", LANE_EVENTS_HEADING, "```text"];
  for (const e of events) {
    const job = typeof e.payload.jobId === "string" ? ` · job ${shortId(e.payload.jobId)}` : "";
    const from = e.payload.escalatedFrom && typeof e.payload.escalatedFrom === "object" ? (e.payload.escalatedFrom as Record<string, unknown>) : null;
    const via = from
      ? ` — escalated to you by ${sanitizeUntrusted(String(from.agent ?? ""), 40)}, who recommends ${sanitizeUntrusted(String(from.recommendation ?? "none"), 20)}: ${sanitizeUntrusted(String(from.why ?? ""), 300)}`
      : "";
    if (isReview(e.payload)) {
      const review = e.payload.review as FloorAllowReview;
      lines.push(
        `- review ${sanitizeUntrusted(e.id, 80)}${job} — ${sanitizeUntrusted(String(review.allowedBy ?? ""), 40)} allowed this high-risk hold (${sanitizeUntrusted(String(review.allowReason ?? ""), 300)}); the second check flagged the allow: ${sanitizeUntrusted(String(review.checkReason ?? ""), 600)}`
      );
      continue;
    }
    lines.push(`- ${e.payload.type === "ask" ? "ask" : "event"} ${sanitizeUntrusted(e.id, 80)}${job}${via}`);
  }
  lines.push("```");
  if (!agent.context.brief || jobs.length === 0) return lines;
  lines.push("", LANE_BRIEFS_HEADING, "```text");
  for (const job of jobs) {
    lines.push(`- job ${shortId(job.id)} "${sanitizeUntrusted(job.title, 120)}": goal: ${sanitizeUntrusted(job.goal, MAX_BRIEF_GOAL_CHARS)}`);
    if (job.acceptance) lines.push(`  acceptance: ${sanitizeUntrusted(job.acceptance, MAX_BRIEF_ACCEPTANCE_CHARS)}`);
    const sessions = new Set(events.filter((e) => e.payload.jobId === job.id).map((e) => e.payload.sessionId).filter((s): s is string => typeof s === "string"));
    for (const sessionId of sessions) {
      const owned = personaJobForSession(db, sessionId);
      const launch = owned && owned.job.id === job.id ? getLaunch(db, owned.launchId) : null;
      if (launch?.task) lines.push(`  session ${shortId(sessionId)}'s task: ${sanitizeUntrusted(launch.task, MAX_BRIEF_TASK_CHARS)}`);
    }
  }
  lines.push("```");
  return lines;
}

/** The id a worker event is known by in a lane: its ask's id. */
export function eventIdOf(payload: Record<string, unknown>): string | undefined {
  const ask = payload.ask && typeof payload.ask === "object" ? (payload.ask as { id?: unknown }) : undefined;
  return typeof ask?.id === "string" && ask.id ? ask.id : typeof payload.eventId === "string" && payload.eventId ? payload.eventId : undefined;
}

function escalationOf(agent: string, event: LaneEvent, recommendation: EscalationRecommendation, why: string): Escalation {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    agent,
    eventId: event.id,
    event: event.payload,
    ...(str(event.payload.jobId) ? { jobId: str(event.payload.jobId) } : {}),
    ...(str(event.payload.sessionId) ? { sessionId: str(event.payload.sessionId) } : {}),
    recommendation,
    why,
  };
}
