import type { PersonaJobStatus } from "./persona.js";
import type { SessionStatus } from "./types.js";

/**
 * What a Persona job looks like to its owner right now, derived from live
 * facts rather than taken from the stored status alone:
 *  - `needs_you`: an approval card for the job waits on the owner, the job has
 *    an unanswered `ask_user` question, or the job was set `waiting_user` and
 *    nothing has answered it since — always with the thing to act on behind it
 *    (`actions`);
 *  - `running`: a worker session is running (or a launch is still starting);
 *  - `idle`: every worker is idle, waiting or ended and nothing needs the owner;
 *  - `done` / `failed` / `cancelled`: the job is closed.
 */
export type PersonaJobState = "needs_you" | "running" | "idle" | "done" | "failed" | "cancelled";

/** Why a job needs its owner. */
export type PersonaJobNeed = "approval" | "question" | "waiting";

/** What kind of thing the owner acts on: where the console opens it. */
export type PersonaJobActionKind = "approval" | "ask" | "review" | "pipeline" | "message" | "session";

/**
 * One thing the owner can act on for a job, so nothing is ever shown as
 * needing them with nothing behind it: an approval card, a pending ask, a
 * review packet waiting in the Review tab, a pipeline run waiting on them,
 * Persona's own note in the job's thread, or the worker session whose
 * hand-off asks them to do something outside Standup (merge, log in).
 */
export interface PersonaJobAction {
  kind: PersonaJobActionKind;
  /** The id to open: the card, ask, review packet, pipeline run, thread or session. */
  id: string;
  /** What acting on it means, one short line. */
  label: string;
}

/** Where a stored `waiting_user` came from. */
export type PersonaJobWaitingSource = "persona" | "handoff";

/** A job's derived state, as served on every PersonaJob (`view`). */
export interface PersonaJobView {
  state: PersonaJobState;
  /** The reasons the job needs its owner, set only when `state` is `needs_you`. */
  needs?: PersonaJobNeed[];
  /**
   * What the owner can act on, set only when `state` is `needs_you` — one
   * entry at least, so every "needs you" links to the thing behind it.
   */
  actions?: PersonaJobAction[];
  /** Latest activity on the job or its workers (ISO). */
  lastActivityAt: string;
  /** The job's latest worker checkpoint, set only when it is newer than Persona's note. */
  checkpoint?: { sessionId: string; summary: string; at: string };
}

/** One worker session of a job, as the derivation sees it. */
export interface JobStateSession {
  id: string;
  status: SessionStatus;
  endedAt?: string;
  /** The session's latest event or transcript entry (ISO). */
  lastActivityAt?: string;
}

/** The live facts a job's view is derived from. Every time is an ISO string. */
export interface JobStateFacts {
  status: PersonaJobStatus;
  createdAt: string;
  updatedAt: string;
  note?: string;
  /** When `note` was last set. */
  noteAt?: string;
  /** When the stored status became `waiting_user`, and who set it. */
  waiting?: { since: string; source: PersonaJobWaitingSource };
  /** When the worker whose hand-off set a `handoff` waiting started running again. */
  workerResumedAt?: string;
  /** Pending approval cards for the job that its owner decides. */
  pendingApprovals: number;
  /**
   * What the owner can act on right now (jobActions): the cards, asks, review
   * packets and pipeline runs behind a "needs you". A job with none of them is
   * never shown as needing the owner.
   */
  actions?: PersonaJobAction[];
  /** Latest decision the owner made on one of the job's approval cards. */
  lastApprovalDecidedAt?: string;
  /** When Persona asked the owner an `ask_user` question about the job still unanswered. */
  openAskAt?: string;
  /** Latest owner reply about the job (an answer to its question, or a message tagged to it). */
  ownerRespondedAt?: string;
  /** Launches still starting (not yet bound to a session). */
  startingLaunches: number;
  sessions: JobStateSession[];
  latestCheckpoint?: { sessionId: string; summary: string; at: string };
}

/** The derivation's result: the view, plus whether a stored `waiting_user` has been answered. */
export interface JobStateDerivation {
  view: PersonaJobView;
  /**
   * The stored status is `waiting_user` but something answered it since it was
   * set: the owner replied about the job or decided one of its cards, or — for
   * a waiting flagged from a worker's hand-off — that worker ran again.
   */
  waitingSuperseded: boolean;
}

const TERMINAL: ReadonlySet<PersonaJobStatus> = new Set(["done", "failed", "cancelled"]);

/** Milliseconds since the epoch, or NaN for an absent or unreadable time. */
function ms(at: string | undefined): number {
  return at ? Date.parse(at) : Number.NaN;
}

/** Whether `at` is strictly after `since` (false when either is unknown). */
function after(at: string | undefined, since: string): boolean {
  const a = ms(at);
  const b = ms(since);
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
}

function latest(times: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const t of times) {
    const v = ms(t);
    if (!Number.isNaN(v) && v > bestMs) {
      best = new Date(v).toISOString();
      bestMs = v;
    }
  }
  return best;
}

function sessionLive(s: JobStateSession): boolean {
  return !s.endedAt && s.status !== "done";
}

/** Derives a job's view from its live facts. Pure. */
export function deriveJobState(facts: JobStateFacts): JobStateDerivation {
  const lastActivityAt =
    latest([
      facts.updatedAt,
      facts.noteAt,
      facts.lastApprovalDecidedAt,
      facts.openAskAt,
      facts.ownerRespondedAt,
      facts.latestCheckpoint?.at,
      ...facts.sessions.map((s) => s.lastActivityAt),
    ]) ?? facts.createdAt;

  const checkpoint =
    facts.latestCheckpoint && (!facts.note || !facts.noteAt || after(facts.latestCheckpoint.at, facts.noteAt))
      ? facts.latestCheckpoint
      : undefined;

  const waiting = facts.status === "waiting_user" ? facts.waiting : undefined;
  const waitingSuperseded =
    !!waiting &&
    (after(facts.ownerRespondedAt, waiting.since) ||
      after(facts.lastApprovalDecidedAt, waiting.since) ||
      (waiting.source === "handoff" && after(facts.workerResumedAt, waiting.since)));

  const base = { lastActivityAt, ...(checkpoint ? { checkpoint } : {}) };

  if (TERMINAL.has(facts.status)) {
    return { view: { state: facts.status as PersonaJobState, ...base }, waitingSuperseded: false };
  }

  const actions = facts.actions ?? [];
  const needs: PersonaJobNeed[] = [];
  if (facts.pendingApprovals > 0) needs.push("approval");
  if (facts.openAskAt) needs.push("question");
  // A `waiting_user` with no recorded start predates the tracking and stands
  // until changed — but only while the owner has something to act on: a
  // waiting with nothing behind it would be a "needs you" leading nowhere.
  if (facts.status === "waiting_user" && !waitingSuperseded && actions.length > 0) needs.push("waiting");
  if (needs.length > 0) {
    return { view: { state: "needs_you", needs, ...(actions.length > 0 ? { actions } : {}), ...base }, waitingSuperseded };
  }

  const running =
    facts.startingLaunches > 0 || facts.sessions.some((s) => sessionLive(s) && s.status === "running");
  return { view: { state: running ? "running" : "idle", ...base }, waitingSuperseded };
}
