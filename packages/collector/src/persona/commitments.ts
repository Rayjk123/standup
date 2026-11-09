import type { Database } from "bun:sqlite";
import type { PersonaCommitment, PersonaCommitmentAssignee, PersonaInboxKind } from "@standup/shared";
import { flattenWorkerText, quoteWorkerText } from "@standup/shared";
import {
  closePersonaCommitment,
  getAsk,
  getPersonaJob,
  getPersonaThread,
  listPersonaCommitments,
  personaOwnerRepliedAfter,
  reassignPersonaCommitment,
} from "@standup/store";
import type { OpenPersonaCommitmentInput } from "@standup/store";
import { ownerCardHoldsAsk } from "./floor-cards.js";

/** An 8-char id for prose (prompt.ts shortId, which imports this module). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** How long a commitment Persona owes stays fresh unless it says otherwise. */
export const PERSONA_STALE_MS = 10 * 60 * 1000;
/** How long one a worker owes stays fresh unless Persona says otherwise. */
export const WORKER_STALE_MS = 60 * 60 * 1000;
/**
 * How long one the owner owes stays fresh: past it the turn asks Persona to
 * re-check that the owner really holds it, since a stale "waiting on the
 * owner" is how a step Persona owed gets lost.
 */
export const OWNER_STALE_MS = 4 * 60 * 60 * 1000;
/** The longest Persona may keep one it owes fresh: a day. */
export const MAX_PERSONA_STALE_MS = 24 * 60 * 60 * 1000;
/** How often the collector wakes Persona again about a commitment it still owes past its stale time. */
export const OVERDUE_RENUDGE_MS = 60 * 60 * 1000;
/** How long a closed commitment is kept, with its evidence, before the tick prunes it. */
export const CLOSED_COMMITMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest a commitment may stay fresh: a week. */
export const MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds on a commitment's texts. */
export const MAX_ACTION_CHARS = 300;
export const MAX_DONE_CHECK_CHARS = 300;
export const MAX_EVIDENCE_CHARS = 1_000;
/** The shortest evidence or reason that closes a commitment: a clause, not a token. */
export const MIN_EVIDENCE_CHARS = 12;

/** The system inbox item type the collector wakes Persona with for overdue commitments. */
export const COMMITMENTS_OVERDUE_EVENT = "commitments_overdue";

const WORKER_ASSIGNEE = /^worker:[A-Za-z0-9._:-]{1,120}$/;

/** `raw` as an assignee (persona, owner, worker:<sessionId>), or null. */
export function parseAssignee(raw: string): PersonaCommitmentAssignee | null {
  if (raw === "persona" || raw === "owner") return raw;
  return WORKER_ASSIGNEE.test(raw) ? (raw as PersonaCommitmentAssignee) : null;
}

/** When a commitment owed by `assignee`, opened at `nowMs`, goes stale by default. */
export function defaultStaleAfter(assignee: PersonaCommitmentAssignee, nowMs: number): string {
  const ms = assignee === "persona" ? PERSONA_STALE_MS : assignee === "owner" ? OWNER_STALE_MS : WORKER_STALE_MS;
  return new Date(nowMs + ms).toISOString();
}

/** Whether `c` is one Persona owes that went stale by `nowMs`. */
export function isOverdue(c: { assignee: string; status: string; staleAfter?: string }, nowMs: number): boolean {
  return c.status === "open" && c.assignee === "persona" && !!c.staleAfter && Date.parse(c.staleAfter) <= nowMs;
}

/** Whether `c` went stale by `nowMs`, whoever owes it. */
export function isStale(c: { status: string; staleAfter?: string }, nowMs: number): boolean {
  return c.status === "open" && !!c.staleAfter && Date.parse(c.staleAfter) <= nowMs;
}

/**
 * The part of a landing or pipeline autoKey that names its launch
 * (`review-approved:<launchId>/`, `pipeline-complete:<launchId>/`): a job can
 * run several launches, and each lands on its own.
 */
export function launchKeyPrefix(prefix: string, key: string): string | null {
  if (!key.startsWith(prefix)) return null;
  const slash = key.indexOf("/", prefix.length);
  return slash < 0 ? null : key.slice(prefix.length, slash + 1);
}

/** The autoKey prefixes of the transitions that open a commitment on their own. */
export const AUTO_KEYS = {
  reviewApproved: "review-approved:",
  pipelineComplete: "pipeline-complete:",
  ask: "ask:",
  installAdvanced: "install-advanced:",
} as const;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The commitment a wake item predictably hands Persona, or null: a review the
 * owner approved is Persona's to land, a coded launch whose pipeline completed
 * is Persona's to verify and close, and a worker's question is Persona's to
 * answer. Keyed to the transition, so a repeat of it opens nothing new; none
 * is opened for a job that is already closed.
 */
export function autoCommitmentFor(
  kind: PersonaInboxKind,
  payload: Record<string, unknown>,
  ctx: { db: Database; owner: string; threadId?: string; nowMs: number }
): OpenPersonaCommitmentInput | null {
  if (kind !== "worker_event") return null;
  const jobId = str(payload.jobId);
  const base = {
    owner: ctx.owner,
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
    ...(jobId ? { jobId } : {}),
    assignee: "persona" as const,
    source: "auto" as const,
    openedAt: new Date(ctx.nowMs).toISOString(),
    staleAfter: defaultStaleAfter("persona", ctx.nowMs),
  };
  const job = jobId ? ` of job ${shortId(jobId)}` : "";
  if (jobClosed(ctx.db, jobId)) return null;
  switch (payload.type) {
    case "review_decided": {
      const packetId = str(payload.packetId);
      if (payload.decision !== "approved" || !packetId) return null;
      const rev = typeof payload.revision === "number" ? payload.revision : 0;
      const title = str(payload.title) ? ` (worker-written title: ${quoteWorkerText(payload.title as string, 60)})` : "";
      return {
        ...base,
        autoKey: `${AUTO_KEYS.reviewApproved}${str(payload.launchId) ?? "-"}/${packetId}:${rev}`,
        action: flattenWorkerText(
          `Approved review /review/${packetId}${job}${title} is ready to land: queue it for the next landing batch, then put the merge to the owner (ask_user with its commitmentIds)`,
          MAX_ACTION_CHARS
        ),
        doneCheck: `the change of /review/${packetId} is on its target branch (install main, for Standup), or the owner said not to land it`,
      };
    }
    case "pipeline_complete": {
      const runId = str(payload.runId);
      if (!runId || !jobId) return null;
      return {
        ...base,
        autoKey: `${AUTO_KEYS.pipelineComplete}${str(payload.launchId) ?? "-"}/${runId}`,
        action: `Verify job ${shortId(jobId)} against its acceptance criterion and close it (its delivery pipeline completed)`,
        doneCheck: `job ${jobId} is closed after session_status shows its acceptance criterion met`,
      };
    }
    case "ask": {
      const ask = (payload.ask ?? {}) as Record<string, unknown>;
      const askId = str(ask.id);
      if (!askId) return null;
      const session = str(payload.sessionId);
      return {
        ...base,
        autoKey: `${AUTO_KEYS.ask}${askId}`,
        action: `Answer ask ${askId}${session ? ` from session ${shortId(session)}` : ""}${job}, or escalate it to the owner (ask_user with its commitmentIds)`,
        doneCheck: `ask ${askId} is answered`,
      };
    }
    default:
      return null;
  }
}

/** The commitment a fast-forward of the install's main to `head` hands Persona. */
export function installAdvancedCommitment(owner: string, head: string, nowMs: number): OpenPersonaCommitmentInput {
  const short = head.slice(0, 12);
  return {
    owner,
    assignee: "persona",
    source: "auto",
    autoKey: `${AUTO_KEYS.installAdvanced}${head}`,
    openedAt: new Date(nowMs).toISOString(),
    staleAfter: defaultStaleAfter("persona", nowMs),
    action: `Install main moved to ${short} and is redeploying: check the restart report, then close the jobs that landed in it; if it FAILED or ROLLED BACK, tell the owner instead`,
    doneCheck: `the restart report says Standup runs ${short} healthy and the landed jobs are closed, or the owner was told it failed`,
  };
}

/** What settleCommitments reads beyond the store. */
export interface SettleDeps {
  /**
   * Whether the change of review packet `packetId` is on its target branch
   * (the launch's work landed). Without it no landing counts as verified.
   */
  reviewLanded?(packetId: string): boolean;
}

/**
 * Settles what the collector can read for itself.
 *
 * - Holds: a commitment Persona escalated with ask_user (holdMessageId) is
 *   the owner's until the owner writes in that thread, then Persona's again
 *   (relaying the answer is), on a fresh stale time. A worker ask the owner's
 *   approval card holds is the owner's while the card does.
 * - Closes: an ask's once it is answered (dropped when it timed out or was
 *   cancelled); a completed pipeline's once its job is done; an approved
 *   review's only once its change landed (reviewLanded) — a job closed done
 *   without that leaves it open for Persona to verify. Both are dropped when
 *   the job failed or was cancelled.
 *
 * Returns what it closed.
 */
export function settleCommitments(db: Database, owner: string, nowIso: string, deps: SettleDeps = {}): PersonaCommitment[] {
  const closed: PersonaCommitment[] = [];
  const nowMs = Date.parse(nowIso);
  const hand = (c: PersonaCommitment, assignee: PersonaCommitmentAssignee) =>
    reassignPersonaCommitment(db, { id: c.id, owner, assignee, staleAfter: defaultStaleAfter(assignee, nowMs) });
  for (const c of listPersonaCommitments(db, owner, { status: "open", limit: 1000 })) {
    const held = !!c.holdMessageId && !personaOwnerRepliedAfter(db, c.holdMessageId, owner);
    if (c.holdMessageId && !held) hand(c, "persona");
    if (c.source !== "auto" || !c.autoKey) continue;
    let settled: { status: "done" | "dropped"; evidence: string } | null = null;
    if (c.autoKey.startsWith(AUTO_KEYS.ask)) {
      const askId = c.autoKey.slice(AUTO_KEYS.ask.length);
      const ask = getAsk(db, askId);
      if (!ask) settled = { status: "dropped", evidence: `ask ${askId} no longer exists (checked by the collector)` };
      else if (ask.status === "answered") settled = { status: "done", evidence: `ask ${askId} is answered (checked by the collector)` };
      else if (ask.status !== "pending") settled = { status: "dropped", evidence: `ask ${askId} is ${ask.status} (checked by the collector)` };
      else if (!held) {
        // Only the persona/owner split follows the card; a worker Persona
        // handed the step to (update_commitment) keeps it.
        const current = c.holdMessageId ? "persona" : c.assignee;
        const assignee: PersonaCommitmentAssignee = ownerCardHoldsAsk(db, owner, askId) ? "owner" : "persona";
        if (!current.startsWith("worker:") && current !== assignee) hand(c, assignee);
      }
    } else if (c.jobId && (c.autoKey.startsWith(AUTO_KEYS.pipelineComplete) || c.autoKey.startsWith(AUTO_KEYS.reviewApproved))) {
      const job = getPersonaJob(db, c.jobId);
      const review = c.autoKey.startsWith(AUTO_KEYS.reviewApproved);
      if (!job) settled = { status: "dropped", evidence: `job ${c.jobId} no longer exists (checked by the collector)` };
      else if (job.status === "failed" || job.status === "cancelled") {
        settled = { status: "dropped", evidence: `job ${c.jobId} is closed ${job.status} (checked by the collector)` };
      } else if (job.status === "done" && !review) {
        settled = { status: "done", evidence: `job ${c.jobId} is closed done (checked by the collector)` };
      } else if (job.status === "done" && review) {
        const packetId = c.autoKey.slice(c.autoKey.indexOf("/") + 1).split(":")[0]!;
        if (deps.reviewLanded?.(packetId)) {
          settled = { status: "done", evidence: `the change of /review/${packetId} is on its target branch and job ${c.jobId} is closed done (checked by the collector)` };
        }
      }
    }
    if (!settled) continue;
    const row = closePersonaCommitment(db, { id: c.id, owner, status: settled.status, evidence: settled.evidence, closedAt: nowIso });
    if (row) closed.push(row);
  }
  return closed;
}

/**
 * The thread a commitment lives in: its job's thread when it has a job of
 * the owner's, else the owner's thread it was opened in, else the console.
 * Wakes about it go there, and only that thread (or, for a private one, any
 * of the owner's private threads, which share one conversation) sees and
 * acts on it.
 */
export function commitmentHomeThread(
  db: Database,
  owner: string,
  c: Pick<PersonaCommitment, "jobId" | "threadId">,
  consoleThreadId: string
): { id: string; private: boolean } {
  const job = c.jobId ? getPersonaJob(db, c.jobId) : null;
  const candidates = [job && job.owner === owner ? job.threadId : undefined, c.threadId];
  for (const id of candidates) {
    if (!id) continue;
    const thread = getPersonaThread(db, id);
    if (thread && thread.owner === owner) return { id: thread.id, private: thread.audience === "private" };
  }
  return { id: consoleThreadId, private: true };
}

/**
 * Whether a turn in `turnThreadId` (private or not) may see and act on `c`:
 * a commitment of a thread other people read only from that thread, a
 * private one from any private thread.
 */
export function commitmentVisibleIn(
  db: Database,
  owner: string,
  c: Pick<PersonaCommitment, "jobId" | "threadId">,
  turn: { threadId: string; private: boolean },
  consoleThreadId: string
): boolean {
  const home = commitmentHomeThread(db, owner, c, consoleThreadId);
  return home.private ? turn.private : home.id === turn.threadId;
}

/** Whether `jobId` names a job that is closed (done, failed or cancelled). */
export function jobClosed(db: Database, jobId: string | undefined): boolean {
  if (!jobId) return false;
  const status = getPersonaJob(db, jobId)?.status;
  return status === "done" || status === "failed" || status === "cancelled";
}

/** How long ago `iso` was, compactly ("4m", "2h", "3d"). */
export function ageLabel(iso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(iso));
  if (!Number.isFinite(ms)) return "?";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
