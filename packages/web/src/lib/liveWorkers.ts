import {
  BOARD_STATUS_LABEL,
  isOpenBoardStatus,
  type BoardTask,
  type Launch,
  type PersonaCommitment,
  type PersonaJob,
  type BoardStatus,
  type Session,
} from "@standup/shared";
import { isOpenJob } from "./persona";

/**
 * The Board's Live workers drawer keeps its state in the Board's query, next
 * to the board filter: `workers=1` opens it on Persona's work, `workers=all`
 * opens it on every session, and `session=<id>` or `launch=<id>` selects what
 * its detail pane shows. A session and a launch have separate keys so their
 * ids can never be confused.
 */
export const WORKERS_PARAM = "workers";
export const WORKER_SESSION_PARAM = "session";
export const WORKER_LAUNCH_PARAM = "launch";

/** What the drawer's detail pane shows: a session, a sessionless launch, or the new-chat composer. */
export type WorkerSelection = { kind: "s"; id: string } | { kind: "l"; id: string } | null;

export interface LiveWorkersState {
  open: boolean;
  /** Lists every session, not only Persona's workers. */
  showAll?: boolean;
  selection: WorkerSelection;
}

export function parseLiveWorkers(params: URLSearchParams): LiveWorkersState {
  const session = params.get(WORKER_SESSION_PARAM);
  const launch = params.get(WORKER_LAUNCH_PARAM);
  const selection: WorkerSelection = session ? { kind: "s", id: session } : launch ? { kind: "l", id: launch } : null;
  const workers = params.get(WORKERS_PARAM);
  return { open: workers === "1" || workers === "all", showAll: workers === "all", selection };
}

/** `params` with the drawer's keys set to `state`; every other key (the board filter) is kept. */
export function writeLiveWorkers(params: URLSearchParams, state: LiveWorkersState): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(WORKERS_PARAM);
  next.delete(WORKER_SESSION_PARAM);
  next.delete(WORKER_LAUNCH_PARAM);
  if (!state.open) return next;
  next.set(WORKERS_PARAM, state.showAll ? "all" : "1");
  if (state.selection?.kind === "s") next.set(WORKER_SESSION_PARAM, state.selection.id);
  if (state.selection?.kind === "l") next.set(WORKER_LAUNCH_PARAM, state.selection.id);
  return next;
}

/** The Board with the drawer open on `selection` (or on the new-chat composer), on every session when `showAll`. */
export function liveWorkersPath(selection: WorkerSelection = null, showAll = false): string {
  return `/board?${writeLiveWorkers(new URLSearchParams(), { open: true, showAll, selection }).toString()}`;
}

/** The session a `worker:<sessionId>` commitment assignee names; undefined for Persona or the owner. */
export function commitmentWorker(assignee: PersonaCommitment["assignee"]): string | undefined {
  return assignee.startsWith("worker:") ? assignee.slice("worker:".length) : undefined;
}

/** What a session is doing for Persona: the open job it works on, or the open commitment that names it. */
export interface WorkerTie {
  kind: "job" | "commitment";
  /** The job's title, or the commitment's next step. */
  label: string;
  jobId?: string;
  /** The job's pipeline stage, else its Board column. */
  stage?: string;
  /** The job card's Board column, when the Board holds one. */
  status?: BoardStatus;
}

/** What ties live work to Persona: the open jobs' sessions and launches, and the sessions open commitments name. */
export interface PersonaTies {
  sessionIds: ReadonlySet<string>;
  launchIds: ReadonlySet<string>;
  /** Each tied session's tie; a job tie wins over a commitment's. */
  bySession: ReadonlyMap<string, WorkerTie>;
}

/**
 * The sessions and launches tied to Persona's open jobs, and the sessions an
 * open commitment's `worker:<sessionId>` assignee names. A job counts from
 * Persona's job list or from its open Board card's links (the Board holds
 * them even while the Persona snapshot doesn't). A launch of an open job ties
 * the session it bound to, even before the job's own sessionIds catch up.
 */
export function personaTies(
  jobs: readonly PersonaJob[],
  commitments: readonly PersonaCommitment[] | null,
  launches: readonly Launch[],
  boardTasks: readonly BoardTask[] = []
): PersonaTies {
  const launchIds = new Set<string>();
  const bySession = new Map<string, WorkerTie>();
  const launchTie = new Map<string, WorkerTie>();
  // A Board card speaks for its job first: it carries the stage the job is in.
  const tieAll = (tie: WorkerTie, sessionIds: readonly string[], jobLaunchIds: readonly string[]) => {
    for (const id of sessionIds) if (!bySession.has(id)) bySession.set(id, tie);
    for (const id of jobLaunchIds) {
      launchIds.add(id);
      if (!launchTie.has(id)) launchTie.set(id, tie);
    }
  };
  for (const task of boardTasks) {
    const jobId = task.links.jobId;
    if (!jobId || !isOpenBoardStatus(task.status)) continue;
    const stage = task.stage ?? BOARD_STATUS_LABEL[task.status];
    tieAll({ kind: "job", label: task.title, jobId, stage, status: task.status }, task.links.sessionIds ?? [], task.links.launchIds ?? []);
  }
  for (const job of jobs) {
    if (!isOpenJob(job)) continue;
    tieAll({ kind: "job", label: job.title, jobId: job.id }, job.sessionIds, job.launchIds);
  }
  for (const launch of launches) {
    const tie = launchTie.get(launch.id);
    if (launch.sessionId && tie && !bySession.has(launch.sessionId)) bySession.set(launch.sessionId, tie);
  }
  for (const c of commitments ?? []) {
    const id = commitmentWorker(c.assignee);
    if (c.status !== "open" || !id) continue;
    if (!bySession.has(id)) bySession.set(id, { kind: "commitment", label: c.action, jobId: c.jobId });
  }
  return { sessionIds: new Set(bySession.keys()), launchIds, bySession };
}

/** A root session the filtered drawer lists: tied to Persona's work and not ended. */
export function isTiedWorker(session: Session, ties: PersonaTies): boolean {
  return !session.parentSessionId && session.endedAt == null && ties.sessionIds.has(session.id);
}

/** A sessionless launch the filtered drawer lists: one an open job started. */
export function isTiedLaunch(launch: Launch, ties: PersonaTies): boolean {
  return ties.launchIds.has(launch.id);
}
