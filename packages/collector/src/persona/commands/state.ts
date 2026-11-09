import type { Database } from "bun:sqlite";
import { STATE_STALL_MINUTES, restartLooksOff, stateVerdictLine } from "@standup/shared";
import type {
  PersonaJob,
  StateHealth,
  StateInFlightItem,
  StateItem,
  StateReport,
  StateStageGroup,
} from "@standup/shared";
import {
  countActivePersonaLaunches,
  countQueuedPersonaLaunches,
  getPendingAsks,
  listPendingPersonaApprovalsAwaiting,
  listPersonaCommitments,
  listPersonaJobs,
  listPersonaSchedules,
  listPipelineRunsByLaunches,
  listReviewPackets,
  listUnansweredPersonaQuestions,
  pendingReviewPacketsForJob,
} from "@standup/store";
import { isFloorGate } from "../../floor/gate.js";
import { hostHeadroomView, hostMonitor as defaultHostMonitor } from "../../host-headroom.js";
import { APPROVAL_TTL_MS } from "../brief.js";
import { AUTO_KEYS, isStale, isOverdue } from "../commitments.js";
import { ownerCardHoldsAsk } from "../floor-cards.js";
import { resolvePersonaConfig } from "../config.js";
import { isIdleNoticeAsk } from "../events.js";
import { MISS_GRACE_MS } from "../scheduler.js";
import type { PersonaCommandContext, PersonaCommandHandler } from "./registry.js";

// `/state`: one card of what is waiting on the owner, what is running, what
// is held, and whether the collector, host, schedules, budgets and
// commitments look healthy. Every read is scoped to the owner and nothing is
// written.

/** How far back an unanswered question still counts. */
const QUESTION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function jobHref(jobId: string): string {
  return `/persona?job=${encodeURIComponent(jobId)}`;
}

/** "human_review" → "Human review". */
export function stageTitle(stage: string): string {
  if (!stage) return "No pipeline";
  const words = stage.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** SQLite `datetime('now')` text or ISO → ISO. */
function iso(at: string | Date): string {
  if (at instanceof Date) return at.toISOString();
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function waitingOnYou(
  db: Database,
  owner: string,
  jobs: PersonaJob[],
  nowMs: number
): { waiting: StateReport["waiting"]; cardAskIds: Set<string> } {
  const titleOf = (jobId?: string) => (jobId ? jobs.find((j) => j.id === jobId)?.title : undefined);
  const covered = new Set<string>();
  const cardAskIds = new Set<string>();

  const approvals: StateItem[] = [];
  for (const a of listPendingPersonaApprovalsAwaiting(db, owner)) {
    // A card past its TTL expires on the next tick; it no longer waits on anyone.
    if (Date.parse(a.createdAt) + APPROVAL_TTL_MS <= nowMs) continue;
    if (a.jobId) covered.add(a.jobId);
    if (a.action === "answer_ask" && typeof a.args.askId === "string") cardAskIds.add(a.args.askId);
    const mine = a.owner === owner;
    approvals.push({
      id: a.id,
      title: clip(a.summary || a.action),
      detail: mine ? (titleOf(a.jobId) ? `For “${titleOf(a.jobId)}”` : "Approval card") : `Asked by ${a.owner}'s Persona`,
      at: a.createdAt,
      href: mine && a.jobId ? jobHref(a.jobId) : "/persona",
    });
  }

  const questions: StateItem[] = [];
  for (const q of listUnansweredPersonaQuestions(db, owner, new Date(nowMs - QUESTION_LOOKBACK_MS).toISOString(), 50)) {
    const jobId = q.jobIds?.find((id) => jobs.some((j) => j.id === id));
    if (jobId) covered.add(jobId);
    questions.push({
      id: q.id,
      title: clip(q.text),
      detail: titleOf(jobId) ? `About “${titleOf(jobId)}”` : "Persona asked you",
      at: q.createdAt,
      href: jobId ? jobHref(jobId) : "/persona",
    });
  }

  const reviews: StateItem[] = listReviewPackets(db, { owner, status: "pending", limit: 50 }).map((p) => ({
    id: p.id,
    title: clip(p.title),
    detail: "Ready for your review",
    at: p.updatedAt,
    href: `/review/${encodeURIComponent(p.id)}`,
  }));

  // A job waiting on an approval, a question or a review already listed is shown there, once.
  const waitingJobs: StateItem[] = jobs
    .filter(
      (j) =>
        j.status === "waiting_user" &&
        !covered.has(j.id) &&
        (reviews.length === 0 || pendingReviewPacketsForJob(db, owner, j.id, j.launchIds).length === 0)
    )
    .map((j) => ({
      id: j.id,
      title: clip(j.title),
      detail: j.note ? clip(j.note) : "Waiting for your answer",
      at: j.updatedAt,
      href: jobHref(j.id),
    }));

  return { waiting: { jobs: waitingJobs, questions, approvals, reviews }, cardAskIds };
}

function inFlight(db: Database, jobs: PersonaJob[], nowMs: number): StateReport["inFlight"] {
  const groups = new Map<string, StateStageGroup>();
  let stalled = 0;
  let total = 0;
  for (const job of jobs) {
    if (job.status !== "active") continue;
    total++;
    const runs = listPipelineRunsByLaunches(db, job.launchIds).filter((r) => r.status === "active" || r.status === "waiting_user");
    // The newest open run is the job's current one.
    const run = runs[runs.length - 1];
    const stage = run?.currentStage ?? "";
    const last = job.view?.lastActivityAt;
    const quietMs = last ? nowMs - Date.parse(last) : 0;
    const running = job.view?.state === "running";
    const isStalled = running && quietMs >= STATE_STALL_MINUTES * 60_000;
    if (isStalled) stalled++;
    const item: StateInFlightItem = {
      id: job.id,
      title: clip(job.title),
      detail: isStalled
        ? "Looks stuck: running but quiet"
        : running
          ? "Working"
          : run?.status === "waiting_user"
            ? "Pipeline is waiting"
            : job.launchIds.length === 0
              ? "No worker started yet"
              : "Idle between steps",
      ...(last ? { at: last, lastActivityAt: last } : {}),
      href: jobHref(job.id),
      stalled: isStalled,
    };
    const group = groups.get(stage) ?? { stage, title: stageTitle(stage), jobs: [] };
    group.jobs.push(item);
    groups.set(stage, group);
  }
  // Jobs with no pipeline go last; stalled jobs lead their stage.
  const stages = [...groups.values()].sort((a, b) => (a.stage === "" ? 1 : b.stage === "" ? -1 : a.title.localeCompare(b.title)));
  for (const g of stages) g.jobs.sort((a, b) => Number(b.stalled) - Number(a.stalled));
  return { total, stalled, stages };
}

/**
 * Pending worker asks and floor holds on the owner's open jobs that Persona
 * hasn't answered. One an approval card holds is left out: the card is
 * listed under Waiting on you.
 */
function holds(db: Database, owner: string, jobs: PersonaJob[]): StateItem[] {
  const jobBySession = new Map<string, PersonaJob>();
  for (const j of jobs) {
    for (const s of j.sessionIds) jobBySession.set(s, j);
  }
  if (jobBySession.size === 0) return [];
  const out: StateItem[] = [];
  for (const ask of getPendingAsks(db)) {
    const job = jobBySession.get(ask.sessionId);
    if (!job || isIdleNoticeAsk(ask) || ownerCardHoldsAsk(db, owner, ask.id)) continue;
    out.push({
      id: ask.id,
      title: clip(ask.question),
      detail: `${isFloorGate(ask.gate) ? "Safety hold" : "Worker question"} on “${clip(job.title, 80)}”`,
      at: iso(ask.createdAt),
      href: `/work/s/${encodeURIComponent(ask.sessionId)}`,
    });
  }
  return out;
}

function health(ctx: PersonaCommandContext, jobs: PersonaJob[], listedAsks: ReadonlySet<string>, nowMs: number): StateHealth {
  const { db, owner } = ctx;
  const startedAt = ctx.health?.startedAt;
  const collector: StateHealth["collector"] = {
    ...(startedAt ? { startedAt, uptimeMs: Math.max(0, nowMs - Date.parse(startedAt)) } : {}),
    ...(ctx.health?.head ? { head: ctx.health.head } : {}),
  };

  let restart: StateHealth["restart"] = null;
  const record = ctx.latestRestart?.() ?? null;
  if (record) {
    restart = {
      id: record.id,
      ...(record.outcome ? { outcome: record.outcome } : {}),
      phase: record.phase,
      at: record.finishedAt ?? record.requestedAt,
      ...(record.error ? { error: clip(record.error, 240) } : {}),
    };
  }

  const cap = ctx.runtime?.config.maxActive ?? resolvePersonaConfig({}).maxActive;
  const active = countActivePersonaLaunches(db, owner);
  const queued = countQueuedPersonaLaunches(db, owner);
  const view = hostHeadroomView(cap, active, queued, ctx.hostMonitor ?? defaultHostMonitor);
  const host: StateHealth["host"] = {
    ...(view.memAvailableBytes !== undefined ? { memAvailableBytes: view.memAvailableBytes } : {}),
    ...(view.memTotalBytes !== undefined ? { memTotalBytes: view.memTotalBytes } : {}),
    ...(view.load1 !== undefined ? { load1: view.load1 } : {}),
    ...(view.cores !== undefined ? { cores: view.cores } : {}),
    active,
    cap,
    effectiveCap: view.effectiveMaxActive,
    hostLimited: view.hostLimited,
    queued,
  };

  const schedules: StateItem[] = [];
  for (const s of listPersonaSchedules(db, owner)) {
    if (s.endedAt) continue;
    if (s.lastOutcome === "failed") {
      schedules.push({
        id: s.id,
        title: clip(s.title),
        detail: `Last run failed${s.lastOutcomeDetail ? `: ${clip(s.lastOutcomeDetail, 120)}` : ""}`,
        ...(s.lastRunAt ? { at: s.lastRunAt } : {}),
        href: "/schedules",
      });
    } else if (s.enabled && s.nextRunAt && Date.parse(s.nextRunAt) < nowMs - MISS_GRACE_MS) {
      schedules.push({ id: s.id, title: clip(s.title), detail: "Missed its last slot", at: s.nextRunAt, href: "/schedules" });
    } else if (s.lastOutcome === "skipped" && s.lastOutcomeDetail?.startsWith("missed ")) {
      // The scheduler records slots missed while Standup was down as a skipped run.
      schedules.push({
        id: s.id,
        title: clip(s.title),
        detail: `Missed while Standup was down: ${clip(s.lastOutcomeDetail.replace(/^missed /, ""), 80)}`,
        ...(s.lastRunAt ? { at: s.lastRunAt } : {}),
        href: "/schedules",
      });
    }
  }

  const budgets: StateItem[] = [];
  for (const j of jobs) {
    if (j.status !== "active" && j.status !== "waiting_user") continue;
    const level = j.budget?.level;
    if (level !== "near" && level !== "exceeded") continue;
    budgets.push({
      id: j.id,
      title: clip(j.title),
      detail: level === "exceeded" ? "Over budget" : "Close to its budget",
      href: jobHref(j.id),
    });
  }

  const commitments: StateItem[] = [];
  for (const c of listPersonaCommitments(db, owner, { status: "open", limit: 500 })) {
    if (!isStale(c, nowMs)) continue;
    // A commitment to answer a hold that is listed already is the same thing, once.
    if (c.autoKey?.startsWith(AUTO_KEYS.ask) && listedAsks.has(c.autoKey.slice(AUTO_KEYS.ask.length))) continue;
    const who = c.assignee === "persona" ? "Persona" : c.assignee === "owner" ? "You" : "A worker";
    commitments.push({
      id: c.id,
      title: clip(c.action),
      detail: isOverdue(c, nowMs) ? "Overdue: Persona promised this" : `${who} owe${who === "You" ? "" : "s"} this; it's gone quiet`,
      ...(c.staleAfter ? { at: c.staleAfter } : {}),
      ...(c.jobId ? { href: jobHref(c.jobId) } : {}),
    });
  }

  return { collector, restart, host, schedules, budgets, commitments };
}

/** The `/state` report for `ctx.owner` at `ctx.now`. */
export function buildStateReport(ctx: PersonaCommandContext): StateReport {
  const nowMs = ctx.now.getTime();
  const jobs = listPersonaJobs(ctx.db, ctx.owner, { status: ["active", "waiting_user"], limit: 1000 });
  const { waiting, cardAskIds } = waitingOnYou(ctx.db, ctx.owner, jobs, nowMs);
  const flight = inFlight(ctx.db, jobs, nowMs);
  const held = holds(ctx.db, ctx.owner, jobs);
  const h = health(ctx, jobs, new Set([...cardAskIds, ...held.map((x) => x.id)]), nowMs);

  // Holds are Persona's to answer, so they need the owner only once they have
  // waited long; until then they are listed, not counted.
  const longHolds = held.filter((x) => x.at && nowMs - Date.parse(x.at) >= STATE_STALL_MINUTES * 60_000).length;
  const needYou = waiting.jobs.length + waiting.questions.length + waiting.approvals.length + waiting.reviews.length;
  const lookOff =
    flight.stalled +
    longHolds +
    (restartLooksOff(h.restart, nowMs) ? 1 : 0) +
    (h.host?.hostLimited ? 1 : 0) +
    h.schedules.length +
    jobs.filter((j) => j.budget?.level === "exceeded").length +
    h.commitments.length;

  return {
    generatedAt: ctx.now.toISOString(),
    waiting,
    inFlight: flight,
    holds: held,
    health: h,
    verdict: { needYou, lookOff, line: stateVerdictLine(needYou, lookOff) },
  };
}

export const stateCommand: PersonaCommandHandler = {
  name: "state",
  run(ctx) {
    const report = buildStateReport(ctx);
    return { data: report, summary: report.verdict.line };
  },
};
