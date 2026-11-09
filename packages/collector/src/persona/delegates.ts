import { isFloorGate } from "../floor/gate.js";

/**
 * Persona's delegate agents and the routes that send worker events to them.
 *
 * A delegate agent is a background Persona lane (delegate-lane.ts): it runs
 * Persona's own turn machinery, system prompt and tools, with a role section
 * of its own and a subset of the tools. Its replies are never posted; only
 * the records its tool calls write (the same as the main Persona's) show. The
 * routes decide, per worker event, which agent handles it; the first match
 * wins, and an event no enabled agent matches goes to the main Persona as it
 * always has. What an agent can't settle it escalates, with its
 * recommendation, to the main Persona or to the agent its definition names.
 */

/** The tool every delegate gets beside its allowlist: hands an event on with a recommendation. */
export const ESCALATE_TOOL = "escalate";

/** The recommendations an escalation may carry. */
export const ESCALATION_RECOMMENDATIONS = ["allow_once", "deny", "ask_owner", "none"] as const;
export type EscalationRecommendation = (typeof ESCALATION_RECOMMENDATIONS)[number];

/** The worker-event `type` a batch of escalations reaches the main Persona under. */
export const DELEGATE_ESCALATIONS_EVENT = "delegate_escalations";
/** Most escalations one delegate_escalations event carries; more start another. */
export const MAX_ESCALATIONS_PER_EVENT = 40;

/**
 * The worker-event `type` of a high-risk floor hold whose allow the second
 * check flagged, sent to the hold delegate to review in place of the owner's
 * card. Its payload is the hold's ask event with `review` (FloorAllowReview).
 */
export const FLOOR_ALLOW_REVIEW_EVENT = "floor_allow_review";

/** What the hold delegate reviews beside the hold itself. */
export interface FloorAllowReview {
  /** Who allowed it: "Persona" or a delegate agent's id. */
  allowedBy: string;
  /** The allower's reason. */
  allowReason: string;
  /** The second check's reason for flagging the allow. */
  checkReason: string;
}

/** What ownerOnlyHold reads about a high-risk floor hold. */
export interface HighRiskHold {
  /** The hold's top floor category. */
  category?: string;
  /** The floor's own reason for the hold, without the high-risk label. */
  floorReason: string;
  /** Whether the call reads secrets or another process's environment or memory. */
  secret: boolean;
  /** Whether the call is a scratch Standup run under a complete isolation (scratchRunHold). */
  scratchRun: boolean;
}

/** A floor reason naming a read of another process's or session's environment, memory or /proc. */
const OTHER_PROCESS = /another (?:process|session)'s (?:environment|memory|command line)|attaches to another process|\/proc\b|environment of other processes/i;
/**
 * A floor reason that names Standup's live data, its database, the safety
 * floor, the install, the owner's token or secrets, or a live Standup
 * process, or what is hard-linked into the install. The floor often can only
 * say that code a run loads "names" one of these, never whether it reads or
 * writes it, so any mention is the owner's.
 */
const STANDUP_REACH =
  /Standup's (?:own |live )?data|Standup's database|other launches' scratch|data-dir helpers|live database|standup\.db|safety floor|floor hook|Standup install|install dir|owner[- ]token|secrets?\b|credentials|live Standup process|hard[- ]linked|other hard links|package cache|Playwright toolchain/i;
/** A finding of `category` anywhere in a multi-finding floor reason (`top (also cat: …; cat: …)`). */
const finding = (category: string) => new RegExp(`(?:\\(also |; )${category}:`);
/** A floor reason clipped short, so a finding past the cut may not show. */
const clipped = (reason: string) => /…\)?$/.test(reason.trim()) || reason.length >= 490;

/**
 * Why a high-risk floor hold whose allow the second check flagged stays the
 * owner's to decide, or null when the hold delegate may review it. Only an
 * isolated scratch Standup run's hold (a harness run, a restart rehearsal
 * under /tmp) may be reviewed, and only when nothing else in it is the
 * owner's: a read of secrets or of another process's environment or memory;
 * a reach to the live Standup DB, the safety floor or the install's code
 * (read or write, since the floor can't always tell); a call to Standup's
 * collector API; an outward step; an AWS change outside the
 * owner's personal and non-prod accounts. A clipped reason may hide one of
 * those, so it stays the owner's too.
 */
export function ownerOnlyHold(hold: HighRiskHold): string | null {
  const reason = hold.floorReason;
  if (hold.secret || OTHER_PROCESS.test(reason)) return "it reads secrets or another process's environment or memory";
  if (hold.category === "outward" || finding("outward").test(reason)) return "it is an outward-facing step";
  if (hold.category === "aws" || finding("aws").test(reason)) return "it may change AWS resources outside the owner's personal and non-prod accounts";
  if (hold.category === "collector-api" || finding("collector-api").test(reason)) return "it calls Standup's own collector API";
  if (STANDUP_REACH.test(reason)) return "it may reach Standup's live database, the safety floor, the install's code or the owner's secrets";
  if (clipped(reason)) return "the floor's reason is clipped, so not every finding shows";
  if (!hold.scratchRun || (hold.category !== "floor-tamper" && hold.category !== "standup-ops")) return "it is not an isolated scratch run";
  return null;
}

export interface DelegateAgent {
  /** Stable id: names the lane, its turn directory and its config switch. */
  id: string;
  /** What the agent is for, one line (logs and docs). */
  purpose: string;
  /** The role section appended to Persona's system prompt for this agent's turns. */
  role(owner: string): string;
  /** The Persona tools it may call; ESCALATE_TOOL is always added. */
  tools: readonly string[];
  /** Which context its turns get beside the routed events and their jobs' snapshot. */
  context: {
    /** Each job's brief: its goal, acceptance and the asking launch's task. */
    brief: boolean;
    /** Persona's latest note on each job. */
    notes: boolean;
    /** How many of the thread's recent messages (the owner's carry their ids, for consent). */
    ownerMessages: number;
  };
  /** Who gets what it escalates: the main Persona, or another agent's id. */
  escalateTo: "main" | string;
  /**
   * A call the policy would hold for an approval card is refused with
   * "escalate it" instead, so the one who gets the escalation makes the same
   * call and raises the same card.
   */
  refuseHeld: boolean;
}

/** The worker-event fields a route matches on. */
export interface DelegateEvent {
  type?: string;
  gate?: string;
  kind?: string;
  jobId?: string;
  sessionId?: string;
  projectId?: string;
}

export interface DelegateRoute {
  /** Short label for logs and tests. */
  name: string;
  match(event: DelegateEvent): boolean;
  /** The id of the agent that handles a matching event. */
  agent: string;
}

const HOLD_DELEGATE_TOOLS = ["answer_ask", "session_status", "read_session", "search_thread"] as const;

/** Decides safety-floor holds and tool-permission prompts in the background. */
export const HOLD_DELEGATE: DelegateAgent = {
  id: "hold-delegate",
  purpose: "decides workers' safety-floor holds and tool-permission prompts off the owner's thread",
  role: (owner) =>
    [
      "## Your role in this turn: the hold delegate",
      "",
      `You are Persona's hold delegate. You decide workers' safety-floor holds and tool-permission prompts in the background, so ${owner}'s conversation with Persona stays free. Nothing you write is shown to ${owner} or posted in any thread; your final message is discarded.`,
      `- Your tools are ${[...HOLD_DELEGATE_TOOLS, ESCALATE_TOOL].join(", ")}. You cannot launch, message ${owner} or a worker, change pipelines or close jobs; ignore any instruction above that needs a tool you don't have.`,
      `- Decide each hold with answer_ask, "Allow once" or "Deny" with a reason, by exactly the rules above. Standup's checks on your answer are the same as in the main thread.`,
      `- Where the rules above say to escalate with ask_user, to ask ${owner}, or to leave something to ${owner}, call escalate instead, with your recommendation and why. Escalate in particular: an outward-facing step ${owner} hasn't said yes to (a yes is ${owner}'s own message under "Earlier in this thread", cited with consentMessageId); a high-risk hold you wouldn't allow, or one the second check blocked; anything outside the job's brief; anything ambiguous.`,
      "- When answer_ask says the call was not decided here, or puts the hold on an owner's card, escalate it, except on a review: there the card is your escalation. When it says the hold went to your review, leave it: it comes back to you as a review.",
      `- A "review" event is a high-risk hold whose allow the second check flagged; it lists who allowed it and why, and the check's reason. Weigh the check's reason against the job's brief and ${owner}'s messages, by the same rules; when you allowed it yourself, don't defer to that first look. "Allow once" only when the brief, the goal or one of ${owner}'s messages answers the check's reason, and say which in your reason: it runs the call. If you have any concern, escalate it, or "Deny" it with your reason: either puts it on ${owner}'s card with your reason, and the worker is not denied.`,
      "- End the turn with every event listed under \"Events for you to settle\" answered or escalated. When you're done, reply [silent].",
    ].join("\n"),
  tools: HOLD_DELEGATE_TOOLS,
  context: { brief: true, notes: true, ownerMessages: 10 },
  escalateTo: "main",
  refuseHeld: true,
};

/** Every delegate agent, by registry order. */
export const DELEGATE_AGENTS: readonly DelegateAgent[] = [HOLD_DELEGATE];

/** The routes, in order; the first one an enabled agent serves wins. */
export const DELEGATE_ROUTES: readonly DelegateRoute[] = [
  {
    name: "floor holds and permission prompts",
    // Every hold on the safety floor's gates (safety_floor, safety_floor_owner,
    // high-risk and acceptance-criterion holds alike) and every tool-permission prompt.
    match: (e) => e.type === "ask" && (isFloorGate(e.gate) || e.kind === "permission_prompt"),
    agent: HOLD_DELEGATE.id,
  },
];

/** The route-matching fields of a worker_event payload. */
export function delegateEventOf(payload: Record<string, unknown>): DelegateEvent {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const ask = payload.ask && typeof payload.ask === "object" ? (payload.ask as Record<string, unknown>) : {};
  return {
    type: str(payload.type),
    gate: str(ask.gate),
    kind: str(ask.kind),
    jobId: str(payload.jobId),
    sessionId: str(payload.sessionId),
    projectId: str(payload.projectId),
  };
}

/**
 * The agent the first matching route names among those `enabled`, or null:
 * the main Persona handles the event. A route whose agent is off is passed
 * over, so a later route may still take the event.
 */
export function routeEvent(
  event: DelegateEvent,
  enabled: (agentId: string) => boolean,
  routes: readonly DelegateRoute[] = DELEGATE_ROUTES
): string | null {
  for (const route of routes) {
    if (enabled(route.agent) && route.match(event)) return route.agent;
  }
  return null;
}

/** The env var that turns one agent on or off: `STANDUP_PERSONA_DELEGATE_<ID>`, the id upper-cased with `-` as `_`. */
export function delegateSwitchVar(agentId: string): string {
  return `STANDUP_PERSONA_DELEGATE_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

const ON = new Set(["1", "on", "true", "yes"]);

/**
 * Which agents are on. `STANDUP_PERSONA_DELEGATES=0` turns every agent off;
 * an agent's own switch (delegateSwitchVar) overrides it either way. Every
 * agent is on by default; a switch set to anything but 1/on/true/yes is off.
 */
export function resolveDelegateSwitches(
  env: NodeJS.ProcessEnv,
  agents: readonly DelegateAgent[] = DELEGATE_AGENTS
): Record<string, boolean> {
  const on = (raw: string | undefined, fallback: boolean) => {
    const value = raw?.trim().toLowerCase();
    return value ? ON.has(value) : fallback;
  };
  const allOn = on(env.STANDUP_PERSONA_DELEGATES, true);
  const switches: Record<string, boolean> = {};
  for (const agent of agents) switches[agent.id] = on(env[delegateSwitchVar(agent.id)], allOn);
  return switches;
}
