import type { Database } from "bun:sqlite";
import type {
  BoardJobFacts,
  BoardRunFacts,
  BoardTaskAreas,
  BoardTaskInput,
  BoardTaskLinks,
  CodeReviewLinkFormat,
  CodeReviewRef,
  PipelineRun,
  ReviewLink,
  Ticket,
} from "@standup/shared";
import {
  CODE_REVIEW_STAGE_KIND,
  boardAreas,
  codeReviewOfEvidence,
  deriveBoardStatus,
  leadRun,
  reviewPacketCodeReview,
  ticketBoardStatus,
} from "@standup/shared";
import {
  countStartingPersonaJobLaunches,
  getLaunch,
  getPersonaJob,
  getPersonaJobWaitingSource,
  getPlanApprovalByLaunch,
  getProject,
  getSession,
  latestReviewPacketForJob,
  listPipelineRunsByLaunches,
  listQueuedPersonaLaunches,
  liveReviewTunnelsForJob,
  pendingReviewPacketsForJob,
} from "@standup/store";
import { reportedChangedFiles } from "../pipeline/runners.js";
import { projectCodeReview } from "../review/code-review-requirement.js";
import type { GitRunner } from "../review/stage.js";

/** The kind of a run's stage: the definition's, else the stage id (built-in stages share id and kind). */
function stageKindOf(run: PipelineRun, stageId: string): string {
  return run.definition.stages.find((s) => s.id === stageId)?.kind ?? stageId;
}

/** The kind of the run's current stage. */
export function currentStageKind(run: PipelineRun): string {
  return stageKindOf(run, run.currentStage);
}

function runFacts(run: PipelineRun): BoardRunFacts {
  return {
    runId: run.id,
    stage: run.currentStage,
    stageKind: currentStageKind(run),
    status: run.status,
    ...(run.waitingReason ? { waitingReason: run.waitingReason } : {}),
    ...(run.waitingKind ? { waitingKind: run.waitingKind } : {}),
    ...(run.parked ? { parkedReason: run.parked.reason } : {}),
    updatedAt: run.updatedAt,
  };
}

const httpUrl = (v: unknown): string | undefined =>
  typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined;

/** The link format of a project's code-review adapter, by project id; the default format for no project. */
export type ReviewLinkFormatOf = (projectId: string | null | undefined) => CodeReviewLinkFormat;

/**
 * A ReviewLinkFormatOf over `db`, reading each project once: the link format
 * of the adapter projectCodeReview resolves for it over its checkouts'
 * remotes (read through `opts.git`), the adapter its review is composed, cut
 * and asked an issue id by.
 */
export function reviewLinkFormats(db: Database, opts: { git?: GitRunner } = {}): ReviewLinkFormatOf {
  const formats = new Map<string, CodeReviewLinkFormat>();
  return (projectId) => {
    if (!projectId) return {};
    let format = formats.get(projectId);
    if (!format) {
      format = projectCodeReview(db, getProject(db, projectId), { git: opts.git }).linkFormat;
      formats.set(projectId, format);
    }
    return format;
  };
}

/**
 * The code review the runs' code_review stages recorded (CodeReviewEvidence),
 * newest first, or null when none did. Each run's evidence is read under its
 * project's link format (`formatOf`), so a bare review id gets the adapter's
 * page for it; evidence that format reads no review from keeps the id and
 * http(s) URL it recorded.
 */
export function runsCodeReview(runs: readonly PipelineRun[], formatOf: ReviewLinkFormatOf = () => ({})): { id?: string; url?: string } | null {
  let best: { id?: string; url?: string; at: string } | null = null;
  for (const run of runs) {
    for (const attempt of run.attempts) {
      if (stageKindOf(run, attempt.stageId) !== CODE_REVIEW_STAGE_KIND) continue;
      const evidence = attempt.evidence as { reviewId?: unknown; url?: unknown } | undefined;
      const read = codeReviewOfEvidence(evidence, formatOf(run.projectId));
      const id = read?.id ?? (typeof evidence?.reviewId === "string" && evidence.reviewId.trim() ? evidence.reviewId.trim() : undefined);
      const url = read?.url ?? httpUrl(evidence?.url);
      if (!id && !url) continue;
      if (!best || attempt.createdAt > best.at) best = { ...(id ? { id } : {}), ...(url ? { url } : {}), at: attempt.createdAt };
    }
  }
  if (!best) return null;
  const { at: _at, ...review } = best;
  return review;
}

/**
 * The code review a packet's links name, read under the link format of
 * `projectId`'s code-review adapter (any http(s) code_review link when the
 * project is unknown or its adapter sets none), or null.
 */
export function packetCodeReview(
  db: Database,
  links: readonly ReviewLink[],
  projectId: string | null | undefined,
  formatOf: ReviewLinkFormatOf = reviewLinkFormats(db)
): CodeReviewRef | null {
  return reviewPacketCodeReview(links, formatOf(projectId));
}

const ms = (at: string | Date | undefined): number => (at === undefined ? Number.NaN : new Date(at).getTime());

export interface ProjectJobOptions {
  /** Files known to be touched beyond what the store records (the launches' git diffs). */
  extraFiles?: Iterable<string>;
}

/**
 * A Persona job's card, from the job's live facts in the store: its derived
 * view, its launches' pipeline runs, its review packets and plans, and its
 * launches still queued or starting. Its areas are the files its plans named,
 * its runs' reported changed files, its latest packet's change areas and
 * `extraFiles`. Undefined when the job doesn't exist.
 */
export function projectJobTask(db: Database, jobId: string, opts: ProjectJobOptions = {}): BoardTaskInput | undefined {
  const job = getPersonaJob(db, jobId);
  if (!job) return undefined;
  const runs = listPipelineRunsByLaunches(db, job.launchIds);
  const plans = job.launchIds.map((id) => getPlanApprovalByLaunch(db, id)).filter((p) => p !== null);
  const queued = listQueuedPersonaLaunches(db, job.owner).filter((q) => q.jobId === job.id || q.args.jobId === job.id).length;
  const launches = job.launchIds.map((id) => getLaunch(db, id));
  const launchById = new Map(launches.filter((l) => l !== null).map((l) => [l.id, l]));
  // A launch whose run is in flight shows through that run; one whose runs all finished (a
  // reused worker) or were disabled is live work while its session runs — except a launch
  // whose own run completed while the job has nothing newer: its worker is landing what the
  // run delivered (Persona messaging it to land the change), which is Persona's close-out.
  // A launch with no session bound yet is still starting, counted among the queued. "Newer"
  // is judged against when the run completed, so a parallel launch started before it
  // finished is not new work after it.
  const tracked = new Set(runs.filter((r) => r.status === "active" || r.status === "waiting_user").map((r) => r.launchId));
  const movedOnSince = (at: string): boolean =>
    runs.some((r) => ms(r.createdAt) > ms(at)) || launches.some((l) => l !== null && ms(l.createdAt) > ms(at));
  const landing = (launchId: string): boolean => {
    let completed: PipelineRun | undefined;
    for (const r of runs) {
      if (r.launchId !== launchId || r.status !== "complete") continue;
      if (!completed || ms(r.updatedAt) > ms(completed.updatedAt)) completed = r;
    }
    return !!completed && !movedOnSince(completed.updatedAt);
  };
  const liveLaunches = launches.filter(
    (l) =>
      l !== null &&
      l.status === "running" &&
      !!l.sessionId &&
      !tracked.has(l.id) &&
      !landing(l.id) &&
      getSession(db, l.sessionId)?.status === "running"
  ).length;
  // A plan awaits only while its launch is starting or running; a cleaned or failed launch's plan is stale.
  const planAwaiting = plans.some((p) => {
    const status = launchById.get(p.launchId)?.status;
    return (p.status === "awaiting_plan" || p.status === "awaiting_approval") && (status === "starting" || status === "running");
  });
  const waitingSource = getPersonaJobWaitingSource(db, job.id);
  const facts: BoardJobFacts = {
    status: job.status,
    viewState: job.view?.state,
    needs: job.view?.needs,
    ...(job.view?.actions ? { actions: job.view.actions } : {}),
    ...(waitingSource ? { waitingSource } : {}),
    runs: runs.map(runFacts),
    pendingPacket: pendingReviewPacketsForJob(db, job.owner, job.id, job.launchIds).length > 0,
    planAwaiting,
    queuedLaunches: queued + countStartingPersonaJobLaunches(db, job.id),
    liveLaunches,
  };
  const lifecycle = deriveBoardStatus(facts);
  const packet = latestReviewPacketForJob(db, job.owner, job.id, job.launchIds);
  const lead = leadRun(facts.runs);
  const leadProject = lead ? runs.find((r) => r.id === lead.runId)?.projectId : undefined;
  const firstLaunch = launches[0] ?? null;
  const projectId = leadProject ?? firstLaunch?.projectId ?? packet?.projectId ?? undefined;
  // The packet's code review, else the one a run's code_review stage
  // recorded, each read the way its project's code-review adapter writes
  // review links.
  const formatOf = reviewLinkFormats(db);
  const review =
    (packet ? packetCodeReview(db, packet.links, packet.projectId ?? projectId, formatOf) : null) ?? runsCodeReview(runs, formatOf);
  // Only a tunnel that answers is linked; one still opening has nothing to show yet.
  const tunnel = liveReviewTunnelsForJob(db, job.id).find((t) => t.status === "open");

  const files = new Set<string>(opts.extraFiles ?? []);
  for (const plan of plans) for (const f of plan.relevantFiles ?? []) files.add(f);
  for (const run of runs) for (const f of reportedChangedFiles(run)) files.add(f);
  for (const area of packet?.changes ?? []) for (const f of area.files ?? []) files.add(f);

  const links: BoardTaskLinks = {
    jobId: job.id,
    launchIds: job.launchIds,
    sessionIds: job.sessionIds,
    ...(packet ? { packetId: packet.id } : {}),
    ...(review ? { codeReview: { id: review.id, url: review.url } } : {}),
    ...(tunnel ? { tunnelUrl: tunnel.url } : {}),
    ...(lifecycle.runId ? { runId: lifecycle.runId } : {}),
  };
  return {
    source: "job",
    sourceId: job.id,
    owner: job.owner,
    projectId,
    title: job.title,
    goal: job.goal,
    status: lifecycle.status,
    flag: lifecycle.flag,
    stage: lifecycle.stage,
    waitingOn: lifecycle.waitingOn,
    links,
    areas: cappedAreas(files),
  };
}

/** The most file paths a card stores; its packages still come from every file. */
export const MAX_BOARD_TASK_FILES = 200;

function cappedAreas(files: Iterable<string>): BoardTaskAreas {
  const areas = boardAreas(files);
  return areas.files.length > MAX_BOARD_TASK_FILES ? { ...areas, files: areas.files.slice(0, MAX_BOARD_TASK_FILES) } : areas;
}

/**
 * A review ticket's card: its column from its status, team-wide (owner "")
 * unless `owner` is given, as the Tickets board is.
 */
export function projectTicketTask(ticket: Ticket, owner = ""): BoardTaskInput {
  const lifecycle = ticketBoardStatus(ticket.status);
  return {
    source: "ticket",
    sourceId: ticket.id,
    owner,
    projectId: ticket.projectId,
    title: ticket.title,
    goal: ticket.body || undefined,
    status: lifecycle.status,
    flag: lifecycle.flag,
    waitingOn: lifecycle.waitingOn,
    links: {
      ticketId: ticket.id,
      ...(ticket.launchId ? { launchIds: [ticket.launchId] } : {}),
      ...(ticket.sessionId ? { sessionIds: [ticket.sessionId] } : {}),
      ...(ticket.reviewUrl ? { codeReview: { url: ticket.reviewUrl } } : {}),
    },
    areas: { files: [], packages: [] },
  };
}
