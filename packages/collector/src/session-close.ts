import type { Database } from "bun:sqlite";
import {
  cancelAllPendingAsks,
  deleteSession,
  endSession,
  getChildSessions,
  getLaunchBySession,
  personaJobForSession,
} from "@standup/store";
import type { DeletedSessionCounts } from "@standup/store";
import type { Session } from "@standup/shared";
import { tmuxSessionExists } from "./launcher.js";
import { OPEN_JOB_STATUSES } from "./persona/prompt.js";
import { stopSession, type StopSessionDeps } from "./session-stop.js";

export interface CloseSessionDeps extends StopSessionDeps {
  /** Whether a tmux session by this name is alive; defaults to the real probe. */
  paneExists?: (name: string) => boolean;
  /** Drops the per-process state the collector keeps for a live session. */
  forget?: (sessionId: string) => void;
}

export interface CloseSessionResult {
  ok: boolean;
  /** How the session was ended: its Standup-owned pane was killed, or only its record was marked ended. */
  closed: "pane" | "record" | "already_ended";
  /** Rows freed when the session was also deleted from the list. */
  deleted?: DeletedSessionCounts;
  /** Why nothing was done: deleting a session still running outside Standup's reach. */
  refused?: string;
  log: string[];
}

export interface CloseRefusal {
  status: 403 | 409;
  code: "subagent" | "persona_worker" | "other_user";
  error: string;
}

/**
 * Who a session belongs to: its claimed owner, else whoever brought it into
 * being, else the host — a session that appeared on its own in the host's
 * terminal (or was imported) before attribution existed is the host's.
 */
export function sessionOwner(session: Pick<Session, "ownerActor" | "createdActor">, host: string): string {
  return session.ownerActor ?? session.createdActor ?? host;
}

/** The open Persona job `sessionId` is a worker of (or a subagent under one), if any. */
function openPersonaJob(db: Database, sessionId: string) {
  const job = personaJobForSession(db, sessionId)?.job;
  return job && OPEN_JOB_STATUSES.has(job.status) ? job : null;
}

/**
 * Whether a live session is a worker of an open Persona job. Only a session
 * with a launch, or a subagent under one, can be, so the lookup is skipped
 * for the rest of a long session list.
 */
export function isOpenPersonaWorker(
  db: Database,
  session: Pick<Session, "id" | "endedAt" | "parentSessionId">,
  launch: unknown
): boolean {
  if (session.endedAt || (!launch && !session.parentSessionId)) return false;
  return openPersonaJob(db, session.id) !== null;
}

/**
 * Why `actor` may not close `session`, or null when they may. A subagent ends
 * with its parent. A worker of an open Persona job is its job's to stop —
 * closing it under the job would leave Persona waiting on a worker that is
 * gone — and a session another user owns is theirs until it is claimed back.
 */
export function closeRefusal(db: Database, session: Session, actor: string, host: string): CloseRefusal | null {
  if (session.parentSessionId) {
    return { status: 409, code: "subagent", error: "This is a subagent; it ends with the session that started it. Close that one instead." };
  }
  const job = openPersonaJob(db, session.id);
  if (job) {
    return {
      status: 409,
      code: "persona_worker",
      error: `This is a worker of Persona's open job "${job.title}". Stop it from Persona or close the job instead.`,
    };
  }
  const owner = sessionOwner(session, host);
  if (owner !== actor) {
    return { status: 403, code: "other_user", error: `This session is owned by ${owner}. Claim it back first to close it.` };
  }
  return null;
}

/**
 * Ends a session whatever started it. A session whose Standup-owned pane is
 * live is stopped as /stop does (pane killed, worktree kept). Any other — one
 * started in the user's own terminal, imported from another app, or left
 * behind by a launch that is gone — has no process Standup can reach, so only
 * its record is ended: the session leaves the live list and its pending asks
 * are cancelled. If such a session is in fact still running, its next hook
 * revives the row.
 *
 * Open subagent children are ended with it. `deleteFromList` then removes the
 * session and its stored history, as DELETE /api/sessions/:id does.
 */
export async function closeSession(
  db: Database,
  deps: CloseSessionDeps,
  session: Session,
  { deleteFromList = false }: { deleteFromList?: boolean } = {}
): Promise<CloseSessionResult> {
  const paneExists = deps.paneExists ?? tmuxSessionExists;
  const launch = getLaunchBySession(db, session.id);
  const paneLive =
    !!launch &&
    (launch.status === "starting" ||
      launch.status === "running" ||
      (!!launch.tmuxSession && paneExists(launch.tmuxSession)));

  // A session mid-turn (running, or waiting on a prompt) with no pane of
  // Standup's is live in someone's own terminal: its next hook recreates the
  // row, so deleting it now would only throw its history away (DELETE refuses
  // a live session for the same reason). An idle one is the orphan case.
  if (deleteFromList && !paneLive && !session.endedAt && (session.status === "running" || session.status === "waiting")) {
    return {
      ok: false,
      closed: "record",
      refused: "This session is mid-turn in a terminal Standup doesn't own, so its next hook would bring it back without its history. Close it without deleting, or delete it once it has stopped.",
      log: [],
    };
  }

  let closed: CloseSessionResult["closed"];
  let log: string[] = [];
  if (launch && paneLive) {
    const result = await stopSession(db, deps, session, launch);
    log = result.log;
    closed = "pane";
    if (!result.ok) {
      // stopSession ended the session even so; its state and subagents go with it.
      deps.forget?.(session.id);
      for (const child of openDescendants(db, session.id)) endRecord(db, deps, child);
      return { ok: false, closed, log };
    }
  } else if (!session.endedAt) {
    endRecord(db, deps, session.id);
    log.push("Ended the session's record; Standup owns no process for it");
    closed = "record";
  } else {
    log.push("Session had already ended");
    closed = "already_ended";
  }
  deps.forget?.(session.id);

  for (const child of openDescendants(db, session.id)) {
    endRecord(db, deps, child);
    deps.forget?.(child);
  }

  if (!deleteFromList) return { ok: true, closed, log };

  const deleted = deleteSession(db, session.id);
  deps.broadcast({
    type: "session:deleted",
    payload: { sessionId: session.id, deleted },
    timestamp: new Date().toISOString(),
  });
  log.push("Deleted from the list");
  return { ok: true, closed, deleted, log };
}

/** Ends one session's record and cancels its pending asks, as SessionEnd does. */
function endRecord(db: Database, deps: CloseSessionDeps, sessionId: string): void {
  endSession(db, sessionId);
  deps.unwatch?.(sessionId);
  for (const ask of cancelAllPendingAsks(db, sessionId)) {
    deps.broadcast({
      type: "ask:resolved",
      payload: { askId: ask.id, answer: "" },
      timestamp: new Date().toISOString(),
    });
  }
  deps.broadcast({
    type: "session:end",
    payload: { sessionId },
    timestamp: new Date().toISOString(),
  });
}

/** Ids of the subagent sessions under `sessionId` that haven't ended, at any depth. */
export function openDescendants(db: Database, sessionId: string): string[] {
  const open: string[] = [];
  const seen = new Set<string>([sessionId]);
  const visit = (id: string): void => {
    for (const child of getChildSessions(db, id)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (!child.endedAt) open.push(child.id);
      visit(child.id);
    }
  };
  visit(sessionId);
  return open;
}
