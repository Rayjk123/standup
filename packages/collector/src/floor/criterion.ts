import type { Database } from "bun:sqlite";
import type { Ask, Launch, WsMessage } from "@standup/shared";
import { claimFloorAllowDelivery, createAsk, getAskByRequestId } from "@standup/store";
import { classifyToolCall } from "./classify.js";
import {
  CRITERION_OWNER_HOLD_REASON,
  FLOOR_GATE,
  FLOOR_OPTIONS,
  FLOOR_OWNER_GATE,
  floorAnswerAllows,
  floorCallHash,
  floorQuestion,
} from "./gate.js";
import type { FloorCall, FloorHold, FloorVerdict } from "./gate.js";
import { serverFloorConfig } from "./routes.js";

/*
 * A plan's acceptance criterion is a shell command the collector runs as the
 * owner, outside any worker's floor. Before it runs it is classified exactly
 * as the worker's own Bash call would be: a criterion the floor would hold
 * doesn't run, and the hold becomes the same safety-floor ask a worker's call
 * raises, decided the same way: Persona allows it once or denies it, or
 * escalates it to the owner with ask_user. Under the owner's
 * STANDUP_PERSONA_HOLD every criterion is held so. An allow is used once: the
 * next readiness check runs the criterion.
 */

/** How long a criterion hold stays open before the start-up sweep times it out. */
const CRITERION_HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** Most holds one gate raises for the same criterion before the search for the latest stops. */
const MAX_CRITERION_HOLDS = 200;

export interface CriterionFloorInput {
  db: Database;
  /** The plan gate's id; with the call's hash it keys the ask. */
  gateId: string;
  launch: Launch;
  /** The worker's session the ask is raised on; without one a held criterion is refused with no ask. */
  sessionId?: string;
  cwd: string;
  criterion: string;
  /**
   * The owner asked for every criterion to be reviewed before it runs
   * (STANDUP_PERSONA_HOLD=acceptance_criterion): even one the floor allows
   * waits on a floor ask Persona decides.
   */
  ownerHold?: boolean;
  /** What the command is, in the refusal messages (default "acceptance criterion"). */
  subject?: string;
  /** What the worker does once a hold is allowed (default: call mark_ready_for_review again). */
  retryHint?: string;
  collectorUrl?: string;
  standupDataDir?: string;
  env?: Record<string, string | undefined>;
  broadcast?(message: WsMessage): void;
  /** Whether a running Persona owns the session; it escalates itself, so the owner isn't pushed. */
  personaHandles?(sessionId: string): boolean;
  notifyOwner?(sessionId: string, question: string): void;
}

export type CriterionFloorResult =
  | { run: true }
  | { run: false; message: string; ask?: Ask };

/** The floor's verdict on running `criterion` in `cwd` as the launch's Bash call. */
export function classifyCriterion(
  db: Database,
  launch: Launch,
  cwd: string,
  criterion: string,
  overrides: { collectorUrl?: string; standupDataDir?: string } = {},
  env: Record<string, string | undefined> = process.env
): { call: FloorCall; verdict: FloorVerdict } {
  const call: FloorCall = { toolName: "Bash", toolInput: { command: criterion }, cwd };
  try {
    const config = serverFloorConfig(db, launch, overrides, env);
    return { call, verdict: classifyToolCall(call, config, { awsAccount: () => null }) };
  } catch (err) {
    return {
      call,
      verdict: {
        action: "hold",
        category: "unclassified",
        ownerOnly: true,
        reason: `the floor couldn't classify the criterion (${(err as Error).message})`,
        step: criterion.slice(0, 200),
      },
    };
  }
}

/**
 * Whether the criterion may run now. Null-safe on every store read; never
 * throws for a classification failure (that is an owner-only hold).
 */
export function criterionFloorGate(input: CriterionFloorInput): CriterionFloorResult {
  const { db, launch, sessionId, cwd, criterion } = input;
  const { call, verdict } = classifyCriterion(
    db,
    launch,
    cwd,
    criterion,
    { collectorUrl: input.collectorUrl, standupDataDir: input.standupDataDir },
    input.env
  );
  let hold: FloorHold | null = verdict.action === "hold" ? verdict : null;
  // The owner's hold covers every criterion, the ones the floor holds too: its
  // reason leads, and a high-risk hold the floor raised stays labeled so.
  if (input.ownerHold) {
    hold = {
      category: hold?.category ?? "unclassified",
      ownerOnly: true,
      reason: hold ? `${CRITERION_OWNER_HOLD_REASON}; the floor also holds it: ${hold.reason}` : CRITERION_OWNER_HOLD_REASON,
      step: hold?.step ?? criterion.slice(0, 200),
      ...(hold?.ownerReserved ? { ownerReserved: true } : {}),
    };
  }
  if (!hold) return { run: true };
  const notRun = `The ${input.subject ?? "acceptance criterion"} was not run`;
  const retry = input.retryHint ?? "Call mark_ready_for_review again once it is allowed.";
  const shown = `$ ${criterion}\nThe safety floor holds it (${hold.category}): ${hold.reason}`;
  if (!sessionId) {
    return { run: false, message: `${notRun}: the safety floor holds it, and its launch has no session to raise the decision on.\n\n${shown}` };
  }

  const callHash = floorCallHash(call);
  const prefix = `criterion:${input.gateId}:${callHash}:`;
  let latest: Ask | null = null;
  let next = 0;
  for (; next < MAX_CRITERION_HOLDS; next++) {
    const ask = getAskByRequestId(db, sessionId, `${prefix}${next}`);
    if (!ask) break;
    latest = ask;
  }
  if (latest?.status === "pending") {
    return {
      run: false,
      ask: latest,
      message: `${notRun}: it waits on a safety-floor decision (ask ${latest.id}). ${retry}\n\n${shown}`,
    };
  }
  if (latest?.status === "answered") {
    if (floorAnswerAllows(latest.answer) && claimFloorAllowDelivery(db, latest.id)) return { run: true };
    if (!floorAnswerAllows(latest.answer)) {
      return {
        run: false,
        ask: latest,
        message: `${notRun}: running it was denied (ask ${latest.id}${latest.answer ? `, answer ${JSON.stringify(latest.answer)}` : ""}). Ask the owner with ask_human how to proceed.\n\n${shown}`,
      };
    }
  }
  if (next >= MAX_CRITERION_HOLDS) {
    return { run: false, message: `${notRun}: it has been held too many times.\n\n${shown}` };
  }

  const gate = hold.ownerOnly ? FLOOR_OWNER_GATE : FLOOR_GATE;
  const question = floorQuestion(call, hold);
  const ask = createAsk(db, sessionId, "ask_human", question, [...FLOOR_OPTIONS], {
    gate,
    requestId: `${prefix}${next}`,
    callHash,
    floorExpiresAt: new Date(Date.now() + CRITERION_HOLD_TTL_MS),
  });
  input.broadcast?.({ type: "ask:new", payload: ask, timestamp: new Date().toISOString() });
  if (!input.personaHandles?.(sessionId)) input.notifyOwner?.(sessionId, question);
  return {
    run: false,
    ask,
    message: `${notRun}: the safety floor holds it, and Persona or the owner decides on ask ${ask.id}. ${retry}\n\n${shown}`,
  };
}
