/**
 * The Board: every piece of work Standup tracks — a Persona job, a review
 * ticket, a program backlog item — as one task card whose column is derived
 * from the live state of the thing behind it. Pure data and functions only;
 * the web uses this module too, so it must stay free of node imports.
 */

import type { PersonaJobStatus } from "./persona.js";
import type { PersonaJobAction, PersonaJobNeed, PersonaJobWaitingSource } from "./job-state.js";
import type { TicketStatus } from "./types.js";
import { CODE_REVIEW_STAGE_KIND } from "./code-review.js";

/** The board's columns, in display order. */
export const BOARD_STATUSES = [
  "queued",
  "coding",
  "validation",
  "live_check",
  "in_review",
  "waiting",
  "done",
  "failed",
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  queued: "Queued",
  coding: "Coding",
  validation: "Validation / review",
  live_check: "Live check",
  in_review: "In review",
  waiting: "Waiting on owner",
  done: "Landed / done",
  failed: "Failed / cancelled",
};

/** Columns whose tasks are finished; they are never checked for conflicts. */
export const CLOSED_BOARD_STATUSES: readonly BoardStatus[] = ["done", "failed"];

export function isOpenBoardStatus(status: BoardStatus): boolean {
  return !CLOSED_BOARD_STATUSES.includes(status);
}

/**
 * Where a task comes from. `backlog` is a program backlog item: its producer
 * upserts it through the board module's `upsert` with `links.backlogItemId`
 * (and `links.jobId` once a job works it).
 */
export type BoardTaskSource = "job" | "ticket" | "backlog";

/** A finer reading of the column, shown as a chip on the card. */
export type BoardTaskFlag = "planned" | "cancelled" | "parked";

export interface BoardTaskLinks {
  jobId?: string;
  launchIds?: string[];
  sessionIds?: string[];
  /** The review packet the work is (or was last) in. */
  packetId?: string;
  /** The work's code review (pull request). */
  codeReview?: { id?: string; url?: string };
  /** A live review tunnel URL for the work. */
  tunnelUrl?: string;
  ticketId?: string;
  backlogItemId?: string;
  /** The pipeline run whose stage the card shows. */
  runId?: string;
}

/** What the work touches: repo-relative file paths and the packages they fall in. */
export interface BoardTaskAreas {
  files: string[];
  packages: string[];
}

/**
 * What a source hands the board for one task — the whole plug-in contract.
 * `(source, sourceId)` identifies the task; upserting the same pair again
 * replaces it.
 *
 * A backlog card (`source: "backlog"`) whose `links.jobId` names a Persona job
 * of the same owner represents that job on the board: the board keeps its
 * status, flag, stage, waiting-on, areas and links mirroring the job's own
 * card as the job moves (its own title, goal, owner and `links.backlogItemId`
 * are kept), and the job's own card is hidden from every board read and frame
 * while it is linked. A backlog card of another owner — a team-wide one —
 * linking the job is stored as given: it never takes the job's private links
 * and never hides the job's card.
 */
export interface BoardTaskInput {
  source: BoardTaskSource;
  sourceId: string;
  /** The user whose board shows the task; "" for a team-wide task (a review ticket), shown on every board. */
  owner: string;
  projectId?: string;
  title: string;
  goal?: string;
  status: BoardStatus;
  flag?: BoardTaskFlag;
  /** The current pipeline stage id, when a run drives the task. */
  stage?: string;
  /** What the task waits on, one short line. */
  waitingOn?: string;
  links: BoardTaskLinks;
  areas: BoardTaskAreas;
}

/** A task's id: its source and source id, so a source's task is found without a lookup. */
export function boardTaskId(source: BoardTaskSource, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/**
 * A backlog card as it follows its linked job: the job card's column, flag,
 * stage, waiting-on, areas and links, under the backlog card's own identity,
 * owner, title, goal and backlog item (its project, else the job's).
 */
export function mirrorJobOnBacklog(backlog: BoardTaskInput, job: BoardTaskInput): BoardTaskInput {
  const projectId = backlog.projectId ?? job.projectId;
  return {
    source: backlog.source,
    sourceId: backlog.sourceId,
    owner: backlog.owner,
    ...(projectId ? { projectId } : {}),
    title: backlog.title,
    ...(backlog.goal ? { goal: backlog.goal } : {}),
    status: job.status,
    ...(job.flag ? { flag: job.flag } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.waitingOn ? { waitingOn: job.waitingOn } : {}),
    links: {
      ...job.links,
      jobId: job.sourceId,
      ...(backlog.links.backlogItemId ? { backlogItemId: backlog.links.backlogItemId } : {}),
    },
    areas: job.areas,
  };
}

export interface BoardTask extends BoardTaskInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** When the task entered a closed column. */
  closedAt?: string;
}

/** A task as the list API serves it: with the open tasks it may collide with. */
export interface BoardTaskWithConflicts extends BoardTask {
  conflicts?: BoardConflict[];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** One pipeline run of a job, as the lifecycle sees it. */
export interface BoardRunFacts {
  runId: string;
  /** The current stage's id and kind (equal for the built-in stages). */
  stage: string;
  stageKind: string;
  status: "active" | "waiting_user" | "complete" | "disabled";
  waitingReason?: string;
  /**
   * Why a waiting run waits. Whatever the kind, a Persona job's blocked run is
   * Persona's to decide; only Persona's escalation (which sets the job
   * `waiting_user`) puts it to the owner.
   */
  waitingKind?: "owner_input" | "exhausted" | "stalled";
  parkedReason?: string;
  updatedAt: string;
}

/** The live facts a job's card is derived from. */
export interface BoardJobFacts {
  status: PersonaJobStatus;
  /** The job's derived view state (PersonaJobView.state), when known. */
  viewState?: string;
  needs?: PersonaJobNeed[];
  /** What the owner can act on, with the view (PersonaJobView.actions). */
  actions?: Pick<PersonaJobAction, "kind">[];
  /**
   * Who put a waiting job to its owner (persona_jobs.waiting_source): a
   * worker's hand-off, or Persona's own escalation.
   */
  waitingSource?: PersonaJobWaitingSource;
  runs: BoardRunFacts[];
  /** A review packet of the job waits on its owner. */
  pendingPacket: boolean;
  /** A plan of the job's launches awaits submission or approval. */
  planAwaiting: boolean;
  /** The job's launches still queued for host room or still starting. */
  queuedLaunches: number;
  /**
   * The job's launches whose bound session is running and which have no
   * pipeline run in flight (none at all, or only finished or disabled ones):
   * work the runs don't show. A launch whose own run completed counts only
   * once the job has a newer run or launch: until then its worker is landing
   * the work the run already delivered.
   */
  liveLaunches?: number;
}

export interface BoardLifecycle {
  status: BoardStatus;
  flag?: BoardTaskFlag;
  stage?: string;
  waitingOn?: string;
  runId?: string;
}

/**
 * The column of each stage kind while its run is at it. A worker at
 * `code_review` is opening the review and one at `human_review` is writing its packet: both are
 * validation until a packet waits on the owner, which alone makes a card in
 * review (beside a finished run's close-out).
 */
const STAGE_KIND_STATUS: Record<string, BoardStatus> = {
  start: "queued",
  coding: "coding",
  validation: "validation",
  review: "validation",
  live_check: "live_check",
  deploy: "live_check",
  screenshot: "live_check",
  code_review: "validation",
  human_review: "validation",
  complete: "done",
};

/** How far along a stage kind is, so the most-advanced run of a job wins. */
const STAGE_RANK: Record<string, number> = {
  start: 0,
  coding: 1,
  validation: 2,
  review: 3,
  live_check: 4,
  deploy: 5,
  screenshot: 6,
  code_review: 7,
  human_review: 8,
  complete: 9,
};

function stageStatus(kind: string): BoardStatus {
  return STAGE_KIND_STATUS[kind] ?? "coding";
}

function isLiveRun(run: BoardRunFacts): boolean {
  return run.status === "active" || run.status === "waiting_user";
}

/** The run a job's card shows: the most-advanced run still in flight, else the latest. */
export function leadRun(runs: BoardRunFacts[]): BoardRunFacts | undefined {
  const live = runs.filter(isLiveRun);
  const pool = live.length > 0 ? live : runs.filter((r) => r.status !== "disabled");
  let best: BoardRunFacts | undefined;
  for (const run of pool) {
    if (!best) {
      best = run;
      continue;
    }
    const a = STAGE_RANK[run.stageKind] ?? 1;
    const b = STAGE_RANK[best.stageKind] ?? 1;
    if (a > b || (a === b && run.updatedAt > best.updatedAt)) best = run;
  }
  return best;
}

const NEED_LABEL: Record<PersonaJobNeed, string> = {
  approval: "owner approval",
  question: "an answer from the owner",
  waiting: "the owner",
};

/**
 * What the owner is waiting to decide on the job, or undefined when nothing
 * is theirs beyond a pending review packet. A known view decides: needs_you
 * is the owner's, unless it is a worker's hand-off after submitting its
 * packet — waiting source `handoff`, its only ask a waiting whose every
 * action is the pending packet's review. Persona's own escalation is the
 * owner's whatever packet is pending. With no view known, a stored
 * `waiting_user` is the owner's.
 */
function ownerWaitingOn(facts: BoardJobFacts, run: BoardRunFacts | undefined): string | undefined {
  const known = facts.viewState !== undefined;
  if (known ? facts.viewState !== "needs_you" : facts.status !== "waiting_user") return undefined;
  const needs = facts.needs ?? [];
  const reviewOnly =
    known &&
    facts.waitingSource === "handoff" &&
    facts.pendingPacket &&
    !needs.includes("approval") &&
    !needs.includes("question") &&
    (facts.actions ?? []).length > 0 &&
    facts.actions!.every((a) => a.kind === "review");
  if (reviewOnly) return undefined;
  return needs.length > 0 ? needs.map((n) => NEED_LABEL[n]).join(", ") : run?.waitingReason ?? "the owner";
}

/** The column a run still in flight shows: its stage kind's, a closed kind reading as close-out. */
function liveColumn(run: BoardRunFacts): BoardStatus {
  const status = stageStatus(run.stageKind);
  return isOpenBoardStatus(status) ? status : "in_review";
}

/**
 * A job's column, by precedence:
 *  1. a closed job sits in its closed column (done; failed; failed and
 *     cancelled) — only the job's own status closes it;
 *  2. the owner has a decision that isn't just the pending packet (an
 *     approval card, a question, Persona's escalation, a hand-off with more
 *     behind it than the packet's review; a stored waiting_user when no view
 *     is known): waiting;
 *  3. a pending review packet: in review, on the owner's review of it;
 *  4. any run in flight that is parked: the lead run's stage column, flagged
 *     parked — it waits on another job, not on the owner;
 *  5. any run in flight that is blocked (whatever its wait kind or reason):
 *     Persona deciding, in that run's stage column — only Persona's
 *     escalation, which sets the job waiting_user, puts it to the owner;
 *  6. the lead run's stage: `code_review` and `human_review` (no packet pending) are
 *     validation, code_review noted "code review in progress";
 *  7. an open job whose runs have all finished is planned while a plan awaits
 *     approval, still at work while another launch's session runs, queued
 *     while a launch is, else in review awaiting Persona's close-out; with no
 *     run the job is queued ("planned" while a plan awaits approval; still
 *     queued while a launch starts and none runs), or coding while a worker
 *     runs.
 * Where several runs match, the lead run is preferred.
 */
export function deriveBoardStatus(facts: BoardJobFacts): BoardLifecycle {
  const run = leadRun(facts.runs);
  const stage = run?.stage;
  const runId = run?.runId;
  const live = facts.runs.filter(isLiveRun);
  const liveRun = (match: (r: BoardRunFacts) => boolean): BoardRunFacts | undefined =>
    run && isLiveRun(run) && match(run) ? run : live.find(match);
  if (facts.status === "done") return { status: "done", stage, runId };
  if (facts.status === "failed") return { status: "failed", stage, runId };
  if (facts.status === "cancelled") return { status: "failed", flag: "cancelled", stage, runId };

  const ownerWaits = ownerWaitingOn(facts, run);
  if (ownerWaits !== undefined) return { status: "waiting", stage, waitingOn: ownerWaits, runId };
  if (facts.pendingPacket) {
    return { status: "in_review", stage, waitingOn: "owner review of the packet", runId };
  }
  const parked = liveRun((r) => !!r.parkedReason);
  if (parked && run) {
    return { status: liveColumn(run), flag: "parked", stage, waitingOn: `parked: ${parked.parkedReason}`, runId };
  }
  const deciding = liveRun((r) => r.status === "waiting_user");
  if (deciding) {
    const waitingOn = `Persona deciding${deciding.waitingReason ? `: ${deciding.waitingReason}` : ""}`;
    return { status: liveColumn(deciding), stage: deciding.stage, waitingOn, runId: deciding.runId };
  }
  const liveLaunches = facts.liveLaunches ?? 0;
  if (run && (run.status === "complete" || !isOpenBoardStatus(stageStatus(run.stageKind)))) {
    if (facts.planAwaiting) return { status: "queued", flag: "planned", waitingOn: "plan approval" };
    if (liveLaunches > 0) return { status: "coding" };
    if (facts.queuedLaunches > 0) return { status: "queued", waitingOn: "host room to start" };
    return { status: "in_review", stage, waitingOn: "Persona to close out", runId };
  }
  if (run) {
    const status = stageStatus(run.stageKind);
    if (status === "queued" && facts.planAwaiting) {
      return { status, flag: "planned", stage, waitingOn: "plan approval", runId };
    }
    if (run.stageKind === CODE_REVIEW_STAGE_KIND) return { status, stage, waitingOn: "code review in progress", runId };
    return { status, stage, runId };
  }
  if (facts.planAwaiting) return { status: "queued", flag: "planned", waitingOn: "plan approval" };
  // The job's view also counts a starting launch as running; until a worker runs, it is queued.
  if (facts.queuedLaunches > 0 && liveLaunches === 0) return { status: "queued", waitingOn: "host room to start" };
  if (liveLaunches > 0 || facts.viewState === "running") return { status: "coding" };
  return { status: "queued" };
}

/** The column a review ticket sits in. */
export function ticketBoardStatus(status: TicketStatus): BoardLifecycle {
  switch (status) {
    case "proposed":
      return { status: "queued", waitingOn: "owner approval" };
    case "approved":
      return { status: "queued" };
    case "developing":
      return { status: "coding" };
    case "needs_review":
      return { status: "in_review", waitingOn: "owner review" };
    case "shipped":
      return { status: "done" };
    case "dismissed":
      return { status: "failed", flag: "cancelled" };
  }
}

/** The coarse column a job's stored status alone gives, before any live facts. */
export function jobStatusBoardStatus(status: PersonaJobStatus): BoardLifecycle {
  return deriveBoardStatus({
    status,
    runs: [],
    pendingPacket: false,
    planAwaiting: false,
    queuedLaunches: 0,
  });
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/** Normalizes a repo-relative path: forward slashes, no leading "./" or "/", no trailing "/". */
export function normalizeBoardPath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return p;
}

/** Top-level directories whose children are a monorepo's packages (`packages/web`, `apps/site`, `crates/core`). */
export const PACKAGE_CONTAINER_DIRS: ReadonlySet<string> = new Set(["packages", "apps", "libs", "services", "crates", "modules"]);

/**
 * The package a path falls in: `<container>/<x>` for a path below a
 * PACKAGE_CONTAINER_DIRS directory, else its top directory. A top-level file,
 * or one directly in a container directory, falls in no package.
 */
export function packageOfPath(path: string): string | undefined {
  const parts = normalizeBoardPath(path).split("/").filter(Boolean);
  if (parts.length <= 1) return undefined;
  if (PACKAGE_CONTAINER_DIRS.has(parts[0]!)) return parts.length > 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

/** Builds a task's areas from the file paths gathered for it, deduped and sorted. */
export function boardAreas(files: Iterable<string>, extraPackages: Iterable<string> = []): BoardTaskAreas {
  const fileSet = new Set<string>();
  for (const f of files) {
    const p = normalizeBoardPath(f);
    if (p) fileSet.add(p);
  }
  const pkgSet = new Set<string>();
  for (const f of fileSet) {
    const pkg = packageOfPath(f);
    if (pkg) pkgSet.add(pkg);
  }
  for (const p of extraPackages) {
    const n = normalizeBoardPath(p);
    if (n) pkgSet.add(n);
  }
  return { files: [...fileSet].sort(), packages: [...pkgSet].sort() };
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** What a caller is about to start, checked against the board's open tasks. */
export interface BoardConflictProbe {
  projectId?: string;
  title?: string;
  goal?: string;
  files?: string[];
  packages?: string[];
  /** The task being checked, so it never conflicts with itself. */
  excludeTaskId?: string;
  /** A job id whose own cards are skipped. */
  excludeJobId?: string;
}

export type BoardConflictReason =
  | { kind: "files"; overlap: string[] }
  | { kind: "packages"; overlap: string[] }
  | { kind: "goal"; score: number; sharedTerms: string[] };

export interface BoardConflict {
  taskId: string;
  title: string;
  status: BoardStatus;
  projectId?: string;
  jobId?: string;
  reasons: BoardConflictReason[];
  /** 0..1, higher is a likelier collision. */
  score: number;
}

/**
 * The weighted share of the smaller side's goal terms the other must also
 * name for two tasks to be reported as overlapping (see `overlap`), beside
 * the floor on shared evidence (sharedEvidence against minSharedTerms).
 * Terms are weighted by rarity across the open tasks compared (termWeights),
 * so what every card on the board says counts for little, and a whole brief's
 * head spreads its weight over some fifty terms — which is why the shares
 * are small. Measured on worker briefs (a probe of title plus the brief's
 * first 600 characters against whole briefs, on a board of the four fixture
 * briefs): two briefs about the same area (the Board's conflict check
 * against the Board's card lifecycle) share 0.077 of the probe's weight with
 * 4.75 of evidence against a floor of 2.5; reworded so they no longer share
 * the incidental "flagged", 0.053 with 3.0; two Standup briefs about
 * unrelated areas (Persona's Slack approval DMs against the Board's card
 * lifecycle), sharing only repo nouns, 0.030 with 1.25; unrelated briefs from
 * other packages 0.028 or less. 0.04 sits between them, and the evidence
 * floor rejects the unrelated pairs on its own.
 */
export const GOAL_OVERLAP_THRESHOLD = 0.04;
/**
 * The weighted share at which a goal overlap alone scores GOAL_NOTE_SCORE,
 * launch_session's cutoff for noting a conflict: the same-area pairs above
 * (0.077 and 0.053) score 0.55 and 0.53 and are noted; an overlap at the
 * reporting threshold scores 0.4 and is shown on the board but not noted.
 */
export const GOAL_STRONG_OVERLAP = 0.05;
/** The conflict score launch_session notes from; a goal overlap alone reaches it at GOAL_STRONG_OVERLAP. */
export const GOAL_NOTE_SCORE = 0.5;
/**
 * The highest score a goal overlap alone gives: enough for launch_session's
 * note, but under the 0.6 a single shared file scores, so a concrete file
 * collision always ranks above a goal overlap.
 */
const GOAL_MAX_SCORE = 0.55;
/** Taken off a goal overlap's score when the two tasks are in different projects. */
const GOAL_CROSS_PROJECT_PENALTY = 0.1;

/**
 * A goal overlap's conflict score: proportional to its share, GOAL_NOTE_SCORE
 * at GOAL_STRONG_OVERLAP, so an overlap short of that scores under the note's
 * cutoff.
 */
function goalConflictScore(share: number, sameProject: boolean): number {
  const score = Math.min(GOAL_MAX_SCORE, (GOAL_NOTE_SCORE * share) / GOAL_STRONG_OVERLAP);
  return Math.max(0, score - (sameProject ? 0 : GOAL_CROSS_PROJECT_PENALTY));
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do for from has have how i if in into is it its make " +
    "new not of on or our should so that the their them then there these this to up use " +
    "was we what when where which while will with without you your add fix update change " +
    "support work task job jobs allow also more all any each than out via one two " +
    "every whose show only both other same still just like need want really already instead " +
    // A worker brief's own scaffolding, which every brief shares whatever it is about.
    "goal acceptance criterion criteria context constraint bun run test typecheck src package " +
    "file read against keep never don cover pass green today main mainline trunk"
  ).split(" "),
);

/** The distinctive terms of a title and goal: lowercased words, stopwords and short words dropped. */
export function goalTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    // Plural and simple verb forms read as one term.
    const term = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(term)) continue;
    terms.add(term);
  }
  return terms;
}

/**
 * Nouns nearly every Standup brief uses whatever it is about — the repo's
 * packages, Persona's machinery, the console — weighted LOW_TERM_WEIGHT.
 * "board" is not among them: it names the Board feature (its module, tab and
 * cards) rather than something every task touches, so two briefs both about
 * the board are likelier to collide; where many open cards do mention it,
 * its rarity weight falls on its own. "card" is: approval cards, Slack cards
 * and board cards are all cards.
 */
const COMMON_REPO_TERMS = new Set(
  (
    "packages collector shared web store standup persona console owner pipeline worker session " +
    "review launch card test component queries index lib dist"
  )
    .split(" ")
    .flatMap((t) => [...goalTerms(t)]),
);
/** The weight of a common repo noun, or of a term a goal names only as a directory of a path. */
const LOW_TERM_WEIGHT = 0.25;
/**
 * Background documents added to the rarity count: with few open cards, a
 * term in all of them is not yet evidence that it is common, so a term in
 * both of two cards keeps most of its weight; as the board fills, a term on
 * most of its cards fades.
 */
const GOAL_BACKGROUND_DOCS = 8;

/** A path in free text: two or more slash-separated segments. */
const PATH_IN_TEXT = /[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/g;
/** A cited path: as PATH_IN_TEXT, any case, and not inside a URL (after "//" or "host:"). */
const CITED_PATH = /(?<![\w/:.-])[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/gi;
/** A path's last segment naming a file: a name and an extension. */
const FILE_SEGMENT = /[^/.][^/]*\.[a-z0-9]{1,8}$/i;
/** The most paths briefPaths returns. */
export const BRIEF_PATHS_MAX = 50;

/**
 * The repo-relative file paths a brief cites, normalized, in order of first
 * mention, at most `max`. Only paths ending in a file name count: a brief
 * names whole directories mostly to fence them off ("don't touch
 * packages/web"), and a directory would overlap every card below it.
 */
export function briefPaths(text: string, max = BRIEF_PATHS_MAX): string[] {
  const out = new Set<string>();
  for (const raw of text.match(CITED_PATH) ?? []) {
    if (out.size >= max) break;
    const path = normalizeBoardPath(raw.replace(/\.+$/, ""));
    const segments = path.split("/");
    if (segments.length >= 2 && !segments.includes("..") && FILE_SEGMENT.test(path)) out.add(path);
  }
  return [...out];
}

/**
 * The terms a text names only as directories of the paths in it (the
 * `collector` and `persona` of packages/collector/src/persona/notify.ts),
 * never in its prose or as a file's name.
 */
function pathOnlyTerms(text: string): Set<string> {
  const lower = text.toLowerCase();
  const dirs = new Set<string>();
  const named = new Set<string>();
  for (const path of lower.match(PATH_IN_TEXT) ?? []) {
    const segments = path.split("/");
    for (const t of goalTerms(segments.slice(0, -1).join(" "))) dirs.add(t);
    for (const t of goalTerms(segments.at(-1)!)) named.add(t);
  }
  if (dirs.size === 0) return dirs;
  for (const t of goalTerms(lower.replace(PATH_IN_TEXT, " "))) named.add(t);
  for (const t of named) dirs.delete(t);
  return dirs;
}

/** How many of the documents name each term, over `docs` documents. */
interface TermCounts {
  docs: number;
  df: Map<string, number>;
}

function countTerms(sets: Iterable<Set<string>>): TermCounts {
  const df = new Map<string, number>();
  let docs = 0;
  for (const set of sets) {
    docs++;
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { docs, df };
}

/**
 * Each of a side's terms' weights: its rarity across the compared tasks
 * (inverse document frequency, smoothed by GOAL_BACKGROUND_DOCS), scaled down
 * to LOW_TERM_WEIGHT for a common repo noun or a term the side names only as
 * a path's directory. Returns the weights and their total.
 */
function termWeights(side: PreparedAreas, counts: TermCounts): { weights: Map<string, number>; total: number } {
  const weights = new Map<string, number>();
  let total = 0;
  const n = counts.docs + GOAL_BACKGROUND_DOCS;
  for (const t of side.terms) {
    const df = Math.max(1, counts.df.get(t) ?? 1);
    const w = Math.log(n / df) * (isLowTerm(side, t) ? LOW_TERM_WEIGHT : 1);
    weights.set(t, w);
    total += w;
  }
  return { weights, total };
}

const isLowTerm = (side: PreparedAreas, term: string): boolean => COMMON_REPO_TERMS.has(term) || side.pathOnly.has(term);

/** A side's terms with their weights, for the weighted overlap. */
interface WeightedTerms {
  terms: Set<string>;
  weights: Map<string, number>;
  total: number;
}

/**
 * How much of the smaller side's term weight the other side covers (a
 * weighted overlap coefficient): a short title probe against a long brief, or
 * a brief's head against another whole brief, scores on what the shorter side
 * says rather than being diluted by everything else the longer one mentions.
 * A shared term counts at the lower of its two sides' weights.
 */
function overlap(a: WeightedTerms, b: WeightedTerms): { score: number; shared: string[] } {
  if (a.terms.size === 0 || b.terms.size === 0) return { score: 0, shared: [] };
  const [small, large] = a.total <= b.total ? [a, b] : [b, a];
  if (small.total <= 0) return { score: 0, shared: [] };
  const shared: string[] = [];
  let covered = 0;
  for (const t of small.terms) {
    const other = large.weights.get(t);
    if (other === undefined) continue;
    shared.push(t);
    covered += Math.min(other, small.weights.get(t)!);
  }
  return { score: covered / small.total, shared: shared.sort() };
}

/** The most a distinctive shared term counts as evidence: one named by no compared task but the two. */
const GOAL_RARE_TERM_EVIDENCE = 1.75;

/**
 * How much a shared distinctive term counts as evidence: one when every
 * compared task names it, rising linearly with its rarity to
 * GOAL_RARE_TERM_EVIDENCE when only the two compared name it. With fewer than
 * three tasks compared, every shared term is on all of them and its rarity
 * says nothing, so it counts one.
 */
function rareTermEvidence(term: string, counts: TermCounts): number {
  if (counts.docs <= 2) return 1;
  const df = Math.min(counts.docs, Math.max(2, counts.df.get(term) ?? 2));
  const rarity = (counts.docs - df) / (counts.docs - 2);
  return 1 + (GOAL_RARE_TERM_EVIDENCE - 1) * rarity;
}

/**
 * The shared terms as evidence, against minSharedTerms: a distinctive term
 * counts by its rarity across the compared tasks (rareTermEvidence, one to
 * GOAL_RARE_TERM_EVIDENCE), a common repo noun or path directory (on either
 * side) LOW_TERM_WEIGHT. The overlap coefficient alone can't tell two goals
 * made only of repo nouns from two made of distinctive terms — scaling every
 * term alike leaves the share unchanged — so low-weight terms add to an
 * overlap but never make one on their own. Rarity lets a goal pair sharing a
 * few terms no other card names clear the floor without leaning on a word
 * the two share by coincidence.
 */
function sharedEvidence(a: PreparedAreas, b: PreparedAreas, shared: readonly string[], counts: TermCounts): number {
  let evidence = 0;
  for (const t of shared) evidence += isLowTerm(a, t) || isLowTerm(b, t) ? LOW_TERM_WEIGHT : rareTermEvidence(t, counts);
  return evidence;
}

/** The fewest shared terms two goals need to overlap, given the smaller side's term count. */
function minSharedTerms(smaller: number): number {
  return smaller >= GOAL_LONG_TERMS ? GOAL_MIN_SHARED_TERMS_LONG : GOAL_MIN_SHARED_TERMS;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The most goal characters read for terms, so a pasted spec doesn't dominate the scan. */
const GOAL_TERMS_CHARS = 2000;
/** The fewest distinctive terms two goals must share to overlap. */
const GOAL_MIN_SHARED_TERMS = 2;
/**
 * From this many terms on the smaller side, two goals need
 * GOAL_MIN_SHARED_TERMS_LONG of evidence: more than two terms every compared
 * task names, or two that few others do.
 */
const GOAL_LONG_TERMS = 6;
const GOAL_MIN_SHARED_TERMS_LONG = 2.5;

/** One side of a conflict check with its comparison sets built once. */
interface PreparedAreas {
  projectId?: string;
  files: string[];
  fileSet: Set<string>;
  /** Each file's directories above it, parallel to `files`. */
  ancestors: string[][];
  /** Every directory above one of the files. */
  dirs: Set<string>;
  /**
   * Each file's first two segments (the whole path when it has one): two
   * paths of two or more segments overlap only within one bucket.
   */
  buckets: Set<string>;
  /** Each file's first segment. */
  tops: Set<string>;
  /** The one-segment paths, which overlap anything below them. */
  shallow: string[];
  packages: Set<string>;
  terms: Set<string>;
  /** The terms named only as a path's directory (pathOnlyTerms). */
  pathOnly: Set<string>;
}

function prepareAreas(
  projectId: string | undefined,
  title: string | undefined,
  goal: string | undefined,
  rawFiles: readonly string[],
  rawPackages: readonly string[],
): PreparedAreas {
  const fileSet = new Set<string>();
  for (const f of rawFiles) {
    const p = normalizeBoardPath(f);
    if (p) fileSet.add(p);
  }
  const files = [...fileSet];
  const ancestors: string[][] = [];
  const dirs = new Set<string>();
  const buckets = new Set<string>();
  const tops = new Set<string>();
  const shallow: string[] = [];
  const packages = new Set<string>();
  for (const f of files) {
    const above: string[] = [];
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) above.push(f.slice(0, i));
    ancestors.push(above);
    for (const d of above) dirs.add(d);
    tops.add(above[0] ?? f);
    buckets.add(above[1] ?? f);
    if (above.length === 0) shallow.push(f);
    const pkg = packageOfPath(f);
    if (pkg) packages.add(pkg);
  }
  for (const p of rawPackages) {
    const n = normalizeBoardPath(p);
    if (n) packages.add(n);
  }
  const text = `${title ?? ""} ${(goal ?? "").slice(0, GOAL_TERMS_CHARS)}`;
  return {
    ...(projectId ? { projectId } : {}),
    files,
    fileSet,
    ancestors,
    dirs,
    buckets,
    tops,
    shallow,
    packages,
    terms: goalTerms(text),
    pathOnly: pathOnlyTerms(text),
  };
}

const prepareTask = (task: BoardTask): PreparedAreas =>
  prepareAreas(task.projectId, task.title, task.goal, task.areas.files, task.areas.packages);

/** The paths where two file sets overlap: equal files, or a directory's files below it (the longer path of each pair). */
function fileOverlap(a: PreparedAreas, b: PreparedAreas): Set<string> {
  const overlap = new Set<string>();
  if (a.files.length === 0 || b.files.length === 0) return overlap;
  // The overlap is symmetric, so walk the smaller side.
  const [small, large] = a.files.length <= b.files.length ? [a, b] : [b, a];
  const mayOverlap =
    [...small.buckets].some((k) => large.buckets.has(k)) ||
    small.shallow.some((s) => large.tops.has(s)) ||
    large.shallow.some((s) => small.tops.has(s));
  if (!mayOverlap) return overlap;
  small.files.forEach((f, i) => {
    if (large.fileSet.has(f) || small.ancestors[i]!.some((d) => large.fileSet.has(d))) overlap.add(f);
    if (large.dirs.has(f)) for (const g of large.files) if (g.startsWith(`${f}/`)) overlap.add(g);
  });
  return overlap;
}

/** One side of a conflict check with its weighted goal terms. */
interface WeightedSide extends PreparedAreas {
  weighted: WeightedTerms;
  /** The term counts across the compared tasks the weights were taken from. */
  counts: TermCounts;
}

function weigh(side: PreparedAreas, counts: TermCounts): WeightedSide {
  return { ...side, counts, weighted: { terms: side.terms, ...termWeights(side, counts) } };
}

/** A goal comparison: the weighted share, the shared terms, their evidence and the floor it is held to. */
interface GoalMatch {
  share: number;
  sharedTerms: string[];
  evidence: number;
  floor: number;
}

function goalMatch(probe: WeightedSide, prepared: WeightedSide): GoalMatch {
  const { score: share, shared } = overlap(probe.weighted, prepared.weighted);
  return {
    share,
    sharedTerms: shared,
    evidence: sharedEvidence(probe, prepared, shared, probe.counts),
    floor: minSharedTerms(Math.min(probe.terms.size, prepared.terms.size)),
  };
}

const goalMatches = (m: GoalMatch): boolean => m.share >= GOAL_OVERLAP_THRESHOLD && m.evidence >= m.floor;

/** Why `task` may collide with the probe, or null when it may not. */
function conflictWith(
  probe: WeightedSide,
  task: BoardTask,
  prepared: WeightedSide,
  /** How many terms the two share, when already counted; fewer than the minimum skips the goal comparison. */
  sharedTermCount: number | undefined,
  /** The probe searches every project: a project-less probe sent through findConflicts. */
  probeWide: boolean,
): BoardConflict | null {
  // Otherwise the two share a project when both have the same one or neither has one, so the
  // relation is symmetric: a project-less task and a project's task never share one.
  const sameProject = probeWide || (probe.projectId ?? "") === (prepared.projectId ?? "");
  const reasons: BoardConflictReason[] = [];
  let score = 0;
  if (sameProject) {
    const overlap = fileOverlap(probe, prepared);
    if (overlap.size > 0) {
      reasons.push({ kind: "files", overlap: [...overlap].sort() });
      score = Math.max(score, 0.6 + Math.min(0.4, overlap.size * 0.1));
    }
  }
  if (sameProject && probe.packages.size > 0 && prepared.packages.size > 0) {
    const overlap = [...prepared.packages].filter((p) => probe.packages.has(p));
    if (overlap.length > 0) {
      reasons.push({ kind: "packages", overlap: overlap.sort() });
      score = Math.max(score, 0.4);
    }
  }
  const goalPossible = sharedTermCount === undefined || sharedTermCount >= GOAL_MIN_SHARED_TERMS;
  if (goalPossible && probe.terms.size > 0 && prepared.terms.size > 0) {
    const match = goalMatch(probe, prepared);
    if (goalMatches(match)) {
      reasons.push({ kind: "goal", score: Math.round(match.share * 100) / 100, sharedTerms: match.sharedTerms });
      score = Math.max(score, goalConflictScore(match.share, sameProject));
    }
  }
  if (reasons.length === 0) return null;
  // Each further independent reason makes a collision likelier.
  score = Math.min(1, score + 0.1 * (reasons.length - 1));
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    projectId: task.projectId,
    jobId: task.links.jobId,
    reasons,
    score: Math.round(score * 100) / 100,
  };
}

const byStrength = (a: BoardConflict, b: BoardConflict): number => b.score - a.score || a.taskId.localeCompare(b.taskId);

/**
 * The open tasks a probe may collide with, strongest first: tasks touching
 * the same files (or one's directory containing the other's file), tasks in
 * the same packages of the same project, and tasks whose title and goal
 * share enough distinctive terms. Closed tasks, the probe's own task and its
 * own job's cards are never reported. Goal terms are weighted by rarity
 * across the probe and the tasks it is compared with.
 */
export function findConflicts(probe: BoardConflictProbe, tasks: readonly BoardTask[]): BoardConflict[] {
  const { weightedProbe, candidates } = probeCandidates(probe, tasks);
  const out: BoardConflict[] = [];
  for (const c of candidates) {
    const found = conflictWith(weightedProbe, c.task, c.prepared, undefined, !probe.projectId);
    if (found) out.push(found);
  }
  return out.sort(byStrength);
}

/** The probe and the open tasks it is compared with, weighted by rarity across all of them. */
function probeCandidates(
  probe: BoardConflictProbe,
  tasks: readonly BoardTask[],
): { weightedProbe: WeightedSide; candidates: { task: BoardTask; prepared: WeightedSide }[] } {
  const prepared = prepareAreas(probe.projectId, probe.title, probe.goal, probe.files ?? [], probe.packages ?? []);
  const unweighted: { task: BoardTask; prepared: PreparedAreas }[] = [];
  for (const task of tasks) {
    if (!isOpenBoardStatus(task.status)) continue;
    if (probe.excludeTaskId && task.id === probe.excludeTaskId) continue;
    if (probe.excludeJobId && task.links.jobId === probe.excludeJobId) continue;
    unweighted.push({ task, prepared: prepareTask(task) });
  }
  const counts = countTerms([prepared.terms, ...unweighted.map((c) => c.prepared.terms)]);
  return {
    weightedProbe: weigh(prepared, counts),
    candidates: unweighted.map(({ task, prepared: p }) => ({ task, prepared: weigh(p, counts) })),
  };
}

/** How a probe's goal compares with one open task's, whether or not it is reported. */
export interface BoardGoalEvidence {
  taskId: string;
  /** The weighted share of the smaller side's terms the other names. */
  share: number;
  sharedTerms: string[];
  /** The shared terms' evidence (sharedEvidence). */
  evidence: number;
  /** The evidence the pair needs (minSharedTerms). */
  floor: number;
  /** Whether the goal overlap is reported. */
  reported: boolean;
}

/**
 * The goal comparison behind findConflicts for each open task the probe is
 * compared with, weighted the same way, so the margins of the goal check can
 * be read off rather than only its verdict.
 */
export function goalEvidence(probe: BoardConflictProbe, tasks: readonly BoardTask[]): BoardGoalEvidence[] {
  const { weightedProbe, candidates } = probeCandidates(probe, tasks);
  return candidates.map(({ task, prepared }) => {
    const m = goalMatch(weightedProbe, prepared);
    return { taskId: task.id, ...m, reported: goalMatches(m) };
  });
}

/** The most conflicts the board map keeps per task. */
export const MAX_TASK_CONFLICTS = 10;

/**
 * The conflicts of each open task against every other open task, keyed by
 * task id, the strongest `MAX_TASK_CONFLICTS` of each. Each task's comparison
 * sets are built once for the whole map, and an index of terms to tasks counts
 * the terms each pair shares, so only pairs sharing enough terms are compared
 * by goal, its terms weighted by rarity across the open tasks. Two tasks
 * share a project only when both name the same one or neither names one.
 */
export function boardConflictMap(tasks: readonly BoardTask[]): Map<string, BoardConflict[]> {
  const unweighted = tasks.filter((t) => isOpenBoardStatus(t.status)).map((task) => ({ task, prepared: prepareTask(task) }));
  const counts = countTerms(unweighted.map((o) => o.prepared.terms));
  const open = unweighted.map(({ task, prepared }) => ({ task, prepared: weigh(prepared, counts) }));
  const byTerm = new Map<string, number[]>();
  open.forEach(({ prepared }, i) => {
    for (const term of prepared.terms) {
      const list = byTerm.get(term);
      if (list) list.push(i);
      else byTerm.set(term, [i]);
    }
  });
  const map = new Map<string, BoardConflict[]>();
  const shared = new Uint32Array(open.length);
  for (const probe of open) {
    shared.fill(0);
    for (const term of probe.prepared.terms) for (const j of byTerm.get(term) ?? []) shared[j]!++;
    const found: BoardConflict[] = [];
    for (let j = 0; j < open.length; j++) {
      const other = open[j]!;
      if (other.task.id === probe.task.id) continue;
      if (probe.task.links.jobId && other.task.links.jobId === probe.task.links.jobId) continue;
      const conflict = conflictWith(probe.prepared, other.task, other.prepared, shared[j], false);
      if (conflict) found.push(conflict);
    }
    if (found.length > 0) map.set(probe.task.id, found.sort(byStrength).slice(0, MAX_TASK_CONFLICTS));
  }
  return map;
}

/** One line naming why a conflict was reported, for cards and tool results. */
export function describeConflict(c: BoardConflict): string {
  const parts = c.reasons.map((r) => {
    if (r.kind === "files") return `files ${r.overlap.slice(0, 3).join(", ")}${r.overlap.length > 3 ? "…" : ""}`;
    if (r.kind === "packages") return `packages ${r.overlap.join(", ")}`;
    return `similar goal (${r.sharedTerms.slice(0, 4).join(", ")})`;
  });
  return `${c.title} [${c.status}]: ${parts.join("; ")}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface BoardQuery {
  status?: BoardStatus[];
  source?: BoardTaskSource[];
  projectId?: string;
  /** Matches the title, goal, stage, waiting-on and file paths, case-insensitively. */
  text?: string;
  /** Tasks touching any of these paths (or a directory of them). */
  files?: string[];
  /** Include closed tasks (default true). */
  includeClosed?: boolean;
}

/** Whether a task matches a board query. */
export function matchesBoardQuery(task: BoardTask, q: BoardQuery): boolean {
  if (q.status && q.status.length > 0 && !q.status.includes(task.status)) return false;
  if (q.source && q.source.length > 0 && !q.source.includes(task.source)) return false;
  if (q.projectId && task.projectId !== q.projectId) return false;
  if (q.includeClosed === false && !isOpenBoardStatus(task.status)) return false;
  if (q.files && q.files.length > 0) {
    const want = q.files.map(normalizeBoardPath).filter(Boolean);
    const hit = want.some((f) => task.areas.files.some((g) => pathsOverlap(f, g)) || task.areas.packages.includes(f));
    if (!hit) return false;
  }
  if (q.text && q.text.trim()) {
    const needle = q.text.trim().toLowerCase();
    const hay = [task.title, task.goal ?? "", task.stage ?? "", task.waitingOn ?? "", task.projectId ?? "", ...task.areas.files]
      .join("\n")
      .toLowerCase();
    if (!needle.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** The WS payload of a `board:task` frame: the task as it is now, or its removal. */
export interface BoardTaskFrame {
  task?: BoardTask;
  removed?: { id: string };
}
