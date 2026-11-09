import type { Ask, Launch, PersonaJob, PipelineRun, ReviewPacketSummary, Session } from "@standup/shared";
import { isLiveActive } from "./sessionTree";
import { jobState } from "./persona";
import { answerableSession, isMyResponsibility, responsibleActor } from "./attribution";

/**
 * The Burrow: every open worker session drawn as a bunny whose activity
 * reads what the worker is doing. Pure data only — the canvas view
 * (components/BurrowView.tsx) draws what this module decides.
 */

/**
 * What a bunny is doing, which decides its station in the room
 * (lib/burrowRoom.ts) and what it holds (components/burrow/room.ts).
 */
export type BunnyActivity =
  | "smithing" // coding: hammering at the forge
  | "fishing" // validation: fishing at the pond
  | "cooking" // adversarial review, or a packet waiting on the owner's review: reading in the nook
  | "gardening" // live check or deploy: carrying crates to the garden cart
  | "painting" // screenshots, the code review, the packet: writing up in the studio
  | "idle" // nothing in flight: with a mug by the living room fire
  | "sign" // waiting on the owner or a teammate: in the front hall with a letter
  | "sleeping" // paused (reaped, or a parked run): asleep in the bedroom, with Zzz
  | "quiet"; // gone quiet (stalled): dozing in the bedroom under a "…" bubble

export const BUNNY_ACTIVITIES: readonly BunnyActivity[] = [
  "smithing",
  "fishing",
  "cooking",
  "gardening",
  "painting",
  "idle",
  "sign",
  "sleeping",
  "quiet",
];

/** The state words of an activity not set by a pipeline stage (see STAGE for those). */
export const ACTIVITY_LABEL: Record<BunnyActivity, string> = {
  smithing: "coding",
  fishing: "running tests",
  cooking: "reviewing",
  gardening: "running a live check",
  painting: "taking screenshots",
  idle: "idle",
  sign: "waiting on you",
  sleeping: "paused",
  quiet: "gone quiet",
};

/**
 * What a run at each pipeline stage kind is doing, and in which words. A
 * live check and a deploy carry crates to the garden cart; the screenshot
 * stage, the code review and the review packet are written up in the studio (a packet
 * waiting on the owner's review sends the bunny to the nook, see bunnyState).
 * A stage kind not listed falls back to the session's status.
 */
const STAGE: Record<string, { activity: BunnyActivity; state: string }> = {
  coding: { activity: "smithing", state: "coding" },
  validation: { activity: "fishing", state: "running tests" },
  review: { activity: "cooking", state: "reviewing" },
  live_check: { activity: "gardening", state: "running a live check" },
  deploy: { activity: "gardening", state: "deploying" },
  screenshot: { activity: "painting", state: "taking screenshots" },
  code_review: { activity: "painting", state: "opening the code review" },
  human_review: { activity: "painting", state: "writing the review packet" },
  start: { activity: "idle", state: "starting" },
  complete: { activity: "idle", state: "landing the work" },
};

export interface BunnyFacts {
  session: Pick<Session, "status" | "endedAt">;
  /** The pipeline run of the session's launch, when it has one. */
  run?: Pick<PipelineRun, "status" | "currentStage" | "definition" | "parked">;
  /** The Persona job the session works for, when it has one. */
  job?: PersonaJob;
  /**
   * Whether this session is its job's lead worker (see buildBurrow): a job that
   * needs the owner raises one sign, on that bunny. Absent counts as the lead.
   */
  jobLead?: boolean;
  /** A pending ask of the session (or one of its subagents) that the viewer answers. */
  ownerAsk?: boolean;
  /** A pending ask of the session that Persona handles (the owner's card, if any, comes from the job). */
  personaAsk?: boolean;
  /**
   * Who answers the session's questions when it isn't the viewer: a
   * teammate's alias (see isMyResponsibility, the alert strip's rule). Its
   * pending asks and a waiting status wait on them, not on the viewer.
   */
  teammate?: string;
  /** A pending ask of the session that a teammate answers (the alert strip shows it as theirs, not the viewer's). */
  teammateAsk?: boolean;
  /** The idle reaper stopped the worker; its job can resume it. */
  reaped?: boolean;
  /** A Persona worker whose job isn't known yet (Persona's jobs haven't loaded): its held run may be Persona's to decide. */
  jobPending?: boolean;
  /** A review packet of the worker's awaits the owner's decision (see packetWorkers). */
  reviewPending?: boolean;
}

/** The stage kind a run is at, or undefined when its definition doesn't name the stage. */
export function currentStageKind(run: Pick<PipelineRun, "currentStage" | "definition">): string | undefined {
  return run.definition?.stages?.find((s) => s.id === run.currentStage)?.kind;
}

/** A job still in progress; a closed job's worker reads as one with no job. */
function isOpenJob(job: PersonaJob | undefined): job is PersonaJob {
  return job?.status === "active" || job?.status === "waiting_user";
}

/**
 * Whether the worker waits on the owner. Any worker does while an ask the
 * owner answers is pending, or while its session waits on an ask Persona
 * doesn't handle. Beyond that, by the Board's rule (see deriveBoardStatus):
 * a worker of an open job only by the job's derived state, on the job's
 * lead worker — a held run under a job is Persona's to decide until Persona
 * puts it to the owner; a worker with no open job, by a held run. A
 * question or held run of a session a teammate answers for waits on them.
 */
function waitsOnOwner({ session, run, job, jobLead, ownerAsk, personaAsk, teammate, teammateAsk, jobPending }: BunnyFacts): WaitReason | undefined {
  if (ownerAsk) return "question";
  if (teammateAsk) return "teammate";
  if (session.status === "waiting" && !personaAsk) return teammate ? "teammate" : "question";
  if (isOpenJob(job)) return jobLead !== false && jobState(job) === "needs_you" ? "decision" : undefined;
  if (jobPending) return undefined;
  // A teammate's held run is theirs to decide, as their question would be.
  if (run?.status === "waiting_user") return teammate ? "teammate" : "decision";
  return undefined;
}

/**
 * Why a worker waits on the owner: a question it asked (an ask Persona
 * doesn't handle, or its session waiting on one), or a decision its job or
 * held run needs. Questions are routed like the console's alert strip
 * routes asks (isMyResponsibility): one a teammate answers is "teammate",
 * at the door but not counted as needing the viewer. The Burrow counts
 * workers, not asks, and words its figure as workers that need you.
 */
export type WaitReason = "question" | "decision" | "teammate";

export interface BunnyState {
  activity: BunnyActivity;
  /** What the worker is doing, in words. */
  state: string;
  /** Set when it waits at the front door: on the viewer, or on a teammate. */
  wait?: WaitReason;
}

/**
 * A worker's activity and its words, most urgent first: a worker waiting on
 * the owner or a teammate waits in the front hall with a letter; a reaped
 * worker or a parked run sleeps; a session gone quiet dozes; a run in flight (or held for Persona) does its
 * stage's activity; otherwise a running session is coding and any other
 * session is idle. A worker at rest (idle, asleep, dozing, its session
 * ended, or its run held once its packet was sent) whose review packet
 * awaits the owner reads in the nook instead.
 */
export function bunnyState(facts: BunnyFacts): BunnyState {
  const wait = waitsOnOwner(facts);
  if (wait) {
    const state =
      wait === "question" ? "has a question for you" : wait === "decision" ? "needs your decision" : `waiting on ${facts.teammate ?? "a teammate"}`;
    return { activity: "sign", state, wait };
  }
  const at = workState(facts);
  if (facts.reviewPending && (facts.session.endedAt != null || AT_REST.has(at.activity) || at.state === PACKET_SENT)) {
    return { activity: "cooking", state: PACKET_WAITING };
  }
  return at;
}

const PACKET_WAITING = "review packet waiting on you";
const PACKET_SENT = "review packet sent";

/** The activities of a worker with nothing in flight. */
const AT_REST = new Set<BunnyActivity>(["idle", "sleeping", "quiet"]);

/** What a worker nobody waits on is doing (see bunnyState). */
function workState(facts: BunnyFacts): BunnyState {
  const { session, run, reaped } = facts;
  if (reaped || run?.parked) return { activity: "sleeping", state: ACTIVITY_LABEL.sleeping };
  if (session.status === "stalled") return { activity: "quiet", state: ACTIVITY_LABEL.quiet };
  if (run && (run.status === "active" || run.status === "waiting_user")) {
    const kind = currentStageKind(run);
    const stage = kind ? STAGE[kind] : undefined;
    // A held run at human review has sent its packet: it waits on the review, not on writing.
    if (stage && kind === "human_review" && run.status === "waiting_user") return { ...stage, state: PACKET_SENT };
    if (stage) return stage;
  }
  const activity = session.status === "running" ? "smithing" : "idle";
  return { activity, state: ACTIVITY_LABEL[activity] };
}

/** The activity alone (see bunnyState). */
export function bunnyActivity(facts: BunnyFacts): BunnyActivity {
  return bunnyState(facts).activity;
}

export interface Bunny {
  sessionId: string;
  /** The job title when the session works for a Persona job, else the session's title. */
  title: string;
  activity: BunnyActivity;
  /** What the worker is doing, in words: its expanded name tag and its accessible name share it. */
  state: string;
  /** Set when it waits on someone at the front door: the viewer (a question or a decision) or a teammate. */
  wait?: WaitReason;
  /** When it started waiting (on the viewer or a teammate, ms), when known: the longest-waiting get the front door's spots first. */
  waitingSince?: number;
  /** Where clicking the bunny goes: its packet while it waits on the owner's review, else the job's drawer, else the session. */
  href: string;
  /** How many of the session's subagents are running now (each a tiny bunny). */
  subagents: number;
  /** Names the worker and its state, for screen readers. */
  ariaLabel: string;
}

export interface BurrowInputs {
  sessions: Session[];
  launches: Launch[];
  runs: PipelineRun[];
  asks: Ask[];
  jobs: PersonaJob[];
  /** The viewer's alias, for routing questions as the alert strip does; absent or empty treats every question as the viewer's. */
  viewer?: string;
  /** Whether Persona's jobs are in (or Persona is off, or failed to load); until then a Persona worker's held run isn't the viewer's decision. Absent counts as in. */
  jobsKnown?: boolean;
  /** The viewer's review packets awaiting a decision (the Review tab's pending list). */
  pendingReviews?: PendingReview[];
}

/** A review packet awaiting the owner's decision, and the worker it came from. */
export type PendingReview = Pick<ReviewPacketSummary, "id" | "launchId" | "jobId" | "sessionId">;

/** "1 subagent" / "3 subagents": the same words in the expanded name tag, the summary and the accessible name. */
export function subagentCount(n: number): string {
  return `${n} subagent${n === 1 ? "" : "s"}`;
}

/** The newest run of each launch: a relaunch's run replaces the earlier one. */
function runsByLaunch(runs: PipelineRun[]): Map<string, PipelineRun> {
  const out = new Map<string, PipelineRun>();
  for (const run of runs) {
    const prev = out.get(run.launchId);
    if (!prev || prev.createdAt <= run.createdAt) out.set(run.launchId, run);
  }
  return out;
}

/** Each session's newest launch. */
function launchesBySession(launches: Launch[]): Map<string, Launch> {
  const out = new Map<string, Launch>();
  for (const launch of launches) {
    if (!launch.sessionId) continue;
    const prev = out.get(launch.sessionId);
    if (!prev || new Date(prev.createdAt).getTime() <= new Date(launch.createdAt).getTime()) {
      out.set(launch.sessionId, launch);
    }
  }
  return out;
}

/** A launch whose idle worker the reaper stopped, still resumable: its session ended, but the worker is paused, not gone. */
function isReaped(launch: Launch | undefined): boolean {
  return !!launch?.reapedAt && launch.status === "running";
}

/** Each session's Persona job: the job naming it, else the one naming its launch. Jobs come newest first: the first to name one wins. */
function jobsOf(jobs: PersonaJob[], launchOf: Map<string, Launch>) {
  const ofSession = new Map<string, PersonaJob>();
  const ofLaunch = new Map<string, PersonaJob>();
  for (const job of jobs) {
    for (const id of job.sessionIds) if (!ofSession.has(id)) ofSession.set(id, job);
    for (const id of job.launchIds) if (!ofLaunch.has(id)) ofLaunch.set(id, job);
  }
  return {
    sessions: new Set(ofSession.keys()),
    of: (session: Session): PersonaJob | undefined => {
      const launch = launchOf.get(session.id);
      return ofSession.get(session.id) ?? (launch ? ofLaunch.get(launch.id) : undefined);
    },
  };
}

/**
 * A root that is a worker: one Standup owns (launched or adopted), that a
 * launch bound to, or that works for a Persona job — not the owner's own
 * monitored terminals. It is open while it has no end stamp, whatever its
 * status (a turn-complete `done` root is often one waiting on a review), or
 * while its launch is reaped and resumable.
 */
function isWorkerRoot(s: Session, launchOf: Map<string, Launch>, jobSessions: Set<string>): boolean {
  return !s.parentSessionId && (!!s.owned || !!s.personaWorker || launchOf.has(s.id) || jobSessions.has(s.id));
}

function isOpen(s: Session, launchOf: Map<string, Launch>): boolean {
  return s.endedAt == null || isReaped(launchOf.get(s.id));
}

/**
 * The worker each pending packet shows on, by session id: of the worker roots
 * it came from (its session, else its launch's, else its job's), an open one,
 * else the newest, so a packet raises one bunny however many sessions its
 * launch or job had, ended ones included.
 */
function packetWorkers(pending: PendingReview[], roots: Session[], launchOf: Map<string, Launch>, jobOf: (s: Session) => PersonaJob | undefined): Map<string, PendingReview> {
  const out = new Map<string, PendingReview>();
  for (const packet of pending) {
    const from = (match: (s: Session) => boolean) => roots.filter(match);
    let mine = packet.sessionId ? from((s) => s.id === packet.sessionId) : [];
    if (mine.length === 0 && packet.launchId) mine = from((s) => launchOf.get(s.id)?.id === packet.launchId);
    if (mine.length === 0 && packet.jobId) mine = from((s) => jobOf(s)?.id === packet.jobId);
    const newest = [...mine].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const pick = newest.find((s) => isOpen(s, launchOf)) ?? newest[0];
    if (pick && !out.has(pick.id)) out.set(pick.id, packet);
  }
  return out;
}

/** The burrow's workers: every open worker root, and the one each pending packet shows on. */
function workerRoots(sessions: Session[], launchOf: Map<string, Launch>, jobs: ReturnType<typeof jobsOf>, pending: PendingReview[]) {
  const roots = sessions.filter((s) => isWorkerRoot(s, launchOf, jobs.sessions));
  const packets = packetWorkers(pending, roots, launchOf, jobs.of);
  return { roots: roots.filter((s) => isOpen(s, launchOf) || packets.has(s.id)), packets };
}

/**
 * The launch ids whose runs the burrow needs: the launches bound to its
 * workers. Sorted, so the read keyed on it repeats only when the set changes.
 */
export function burrowLaunchIds(sessions: Session[], launches: Launch[], jobs: PersonaJob[] = [], pendingReviews: PendingReview[] = []): string[] {
  const launchOf = launchesBySession(launches);
  const ids = workerRoots(sessions, launchOf, jobsOf(jobs, launchOf), pendingReviews).roots.flatMap((s) => {
    const launch = launchOf.get(s.id);
    return launch ? [launch.id] : [];
  });
  return [...new Set(ids)].sort();
}

/**
 * One bunny per worker (see workerRoots), oldest first (ties by id), so the
 * order holds however the session list is re-sorted; a subagent
 * child is not a bunny of its own but counts toward its parent's tiny
 * bunnies while it runs, and its pending ask raises its parent's sign.
 */
export function buildBurrow({ sessions, launches, runs, asks, jobs, viewer = "", jobsKnown = true, pendingReviews = [] }: BurrowInputs): Bunny[] {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const runOf = runsByLaunch(runs);
  const launchOf = launchesBySession(launches);
  const jobIndex = jobsOf(jobs, launchOf);
  const jobFor = jobIndex.of;
  const parentOf = new Map<string, string>();
  for (const s of sessions) if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  /** The root a session nests under, however deep (a cycle stops the walk). */
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (parentOf.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at)!;
    }
    return at;
  };
  // Every live subagent below a root counts toward its tiny bunnies, a subagent's own subagents too.
  const liveChildren = new Map<string, number>();
  for (const s of sessions) {
    if (!s.parentSessionId || !isLiveActive(s)) continue;
    const root = rootOf(s.id);
    liveChildren.set(root, (liveChildren.get(root) ?? 0) + 1);
  }
  const ownerAsks = new Set<string>();
  const personaAsks = new Set<string>();
  // When each root's oldest pending question was asked: how long it has waited.
  const askedAt = new Map<string, number>();
  const teammateAsks = new Set<string>();
  for (const ask of asks) {
    if (ask.status !== "pending") continue;
    const root = rootOf(ask.sessionId);
    // Routed as the alert strip routes it: by who answers for the asking session.
    const mine = isMyResponsibility(answerableSession(ask.sessionId, sessionById), viewer);
    (ask.personaHandled ? personaAsks : mine ? ownerAsks : teammateAsks).add(root);
    if (!ask.personaHandled) {
      const at = new Date(ask.createdAt).getTime();
      if (Number.isFinite(at)) askedAt.set(root, Math.min(askedAt.get(root) ?? at, at));
    }
  }

  const workers = workerRoots(sessions, launchOf, jobIndex, pendingReviews);
  const roots = workers.roots.sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime() || a.id.localeCompare(b.id)
  );
  // Each job's lead worker: the one that is stuck (its run held, an ask
  // Persona holds, its session waiting), else the newest — roots are oldest
  // first, so among equals the last one seen wins.
  const stuck = (session: Session): boolean => {
    const launch = launchOf.get(session.id);
    const run = launch ? runOf.get(launch.id) : undefined;
    return run?.status === "waiting_user" || personaAsks.has(session.id) || session.status === "waiting";
  };
  const jobLead = new Map<string, { id: string; stuck: boolean }>();
  for (const session of roots) {
    const job = jobFor(session);
    if (!job) continue;
    const isStuck = stuck(session);
    const prev = jobLead.get(job.id);
    if (!prev || isStuck || !prev.stuck) jobLead.set(job.id, { id: session.id, stuck: isStuck });
  }
  /**
   * Since when a waiting worker has waited (ms): its oldest question, else
   * when its run or job last moved. A session waiting on a question not in
   * the list has no known time: its run's times would date it too early.
   */
  const waitingSince = (session: Session, wait: WaitReason, run: PipelineRun | undefined, job: PersonaJob | undefined): number | undefined => {
    const t = (s: string | undefined) => (s ? new Date(s).getTime() : NaN);
    const asked = askedAt.get(session.id);
    // Only a wait that comes from the session's waiting status (see waitsOnOwner) lacks a time of its own.
    if (asked === undefined && wait !== "decision" && session.status === "waiting" && !personaAsks.has(session.id)) return undefined;
    const at = asked ?? (t(run?.stageEnteredAt) || t(job?.updatedAt));
    return at !== undefined && Number.isFinite(at) ? at : undefined;
  };
  return roots.map((session) => {
    const launch = launchOf.get(session.id);
    const run = launch ? runOf.get(launch.id) : undefined;
    const job = jobFor(session);
    const facts: BunnyFacts = {
      session,
      run,
      job,
      jobLead: job ? jobLead.get(job.id)?.id === session.id : undefined,
      ownerAsk: ownerAsks.has(session.id),
      personaAsk: personaAsks.has(session.id),
      teammateAsk: teammateAsks.has(session.id),
      ...(isMyResponsibility(session, viewer) ? {} : { teammate: responsibleActor(session) }),
      reaped: session.endedAt != null && isReaped(launch),
      jobPending: !jobsKnown && !job && !!session.personaWorker,
      reviewPending: workers.packets.has(session.id),
    };
    const { activity, state, wait } = bunnyState(facts);
    // One reading its packet's review opens the packet.
    const packet = state === PACKET_WAITING ? workers.packets.get(session.id) : undefined;
    const title = (job?.title || session.title || "Untitled session").trim();
    const subagents = liveChildren.get(session.id) ?? 0;
    const helpers = subagents === 0 ? "" : `, ${subagentCount(subagents)}`;
    return {
      sessionId: session.id,
      title,
      activity,
      state,
      ...(wait ? { wait, waitingSince: waitingSince(session, wait, run, job) } : {}),
      href: packet ? `/review/${encodeURIComponent(packet.id)}` : job ? `/persona?job=${encodeURIComponent(job.id)}` : `/work/s/${encodeURIComponent(session.id)}`,
      subagents,
      ariaLabel: `${title}: ${state}${helpers}`,
    };
  });
}
