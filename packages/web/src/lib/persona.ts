import type {
  PersonaActivity,
  PersonaApproval,
  PersonaApprovalStatus,
  PersonaAttachment,
  PersonaAudience,
  PersonaJob,
  PersonaJobState,
  PersonaMessage,
  PersonaMessageJobTag,
  PersonaHoldReportRow,
  PersonaMessagesResponse,
  PersonaReplyTo,
  PersonaRunState,
  PersonaState,
  PersonaThread,
  PersonaThreadSummary,
  WsMessage,
} from "@standup/shared";

/**
 * Client-side model of the Persona view: the thread, the owner's unconfirmed
 * sends, jobs, approvals, and the live run state.
 *
 * Everything here is a pure function so the merge rules — the part that goes
 * wrong under reconnects, duplicate frames and racing REST responses — are
 * pinned by unit tests rather than by eyeballing the UI.
 */

/**
 * A message the owner sent that the server hasn't confirmed yet. Shown at the
 * tail of the thread until its echo (the `persona:message` frame or the POST
 * response) lands, then dropped in favor of the server row.
 */
export interface PersonaOutboxItem {
  idempotencyKey: string;
  text: string;
  createdAt: string;
  /**
   * The highest thread seq known when this was sent. Its echo must sort after
   * it, which keeps an identical older message ("yes") from being mistaken
   * for the confirmation of a new one.
   */
  afterSeq: number;
  status: "sending" | "failed";
  error?: string;
  /** The thread it was sent to; absent means the thread selected when it was queued. */
  threadId?: string;
  /** Set on a quick-reply tap: the question it answers and the option chosen. */
  replyTo?: PersonaReplyTo;
  /** The job the message is tagged to. */
  jobId?: string;
  /**
   * The job came from the thread's job filter, not a tag the owner picked: if
   * the collector won't take it on this thread, the message goes untagged
   * rather than not at all.
   */
  routed?: boolean;
  /** The owner's uploads the message carries; every delivery attempt re-sends them. */
  attachmentIds?: string[];
  /** Those uploads' public details, for the pending bubble. */
  attachments?: PersonaAttachment[];
  /** A slash command (`/state`): delivered to the command route, never as a message to Persona. */
  command?: boolean;
}

/** A thread's held messages and unconfirmed sends while another thread is selected. */
export interface PersonaThreadBuffer {
  messages: PersonaMessage[];
  outbox: PersonaOutboxItem[];
}

/** Messages fetched for one thread's job filter, beyond the loaded window. */
export interface PersonaBackfill {
  threadId: string;
  /** The filter they answer, as `tagFilterKey` writes it. */
  key: string;
  /** Ascending by seq, unique by id. */
  messages: PersonaMessage[];
}

export interface PersonaViewState {
  /** Set once the first REST snapshot (successful or not) has been applied. */
  loaded: boolean;
  state: PersonaState | null;
  /**
   * The selected thread: the console thread until the owner picks another.
   * `messages` and `outbox` belong to it.
   */
  threadId: string | null;
  /** The owner's console thread (from the state), listed first in the switcher. */
  consoleThreadId: string | null;
  /** Ascending by seq, unique by id. */
  messages: PersonaMessage[];
  outbox: PersonaOutboxItem[];
  /**
   * Every other thread's messages and sends, by thread id. Frames for a
   * thread that isn't selected land here, so switching back shows them
   * without waiting on a refetch.
   */
  others: Record<string, PersonaThreadBuffer>;
  /** Every thread Persona talks on, newest activity first as the server sent it. */
  threads: PersonaThreadSummary[];
  /**
   * A message arrived for a thread the list doesn't hold yet; the view
   * refetches the list to learn its channel and title.
   */
  threadsStale: boolean;
  /** Highest seq the owner has seen, by thread id; drives the unread dots. */
  lastViewed: Record<string, number>;
  /**
   * The Persona view is on screen. Only then does a message arriving in the
   * selected thread count as seen.
   */
  viewing: boolean;
  /** Newest first. */
  jobs: PersonaJob[];
  /** Set once a snapshot carried the jobs list (the first-paint one doesn't). */
  jobsLoaded?: boolean;
  /** Every approval seen this session, any status. */
  approvals: PersonaApproval[];
  /** The latest "what Persona is doing" line; cleared when a turn ends. */
  activity: PersonaActivity | null;
  /** The collector's explanation when the routes answer its 503 (Persona disabled). */
  disabledReason?: string;
  /**
   * The 503 was reason `unavailable`: Persona is on, but this host can't run
   * one more (at capacity). Shown as its own note rather than "disabled".
   */
  unavailable?: boolean;
  /** Last failure reaching the Persona routes, for a non-blocking notice. */
  loadError?: string;
  /**
   * The reads answered 403: the viewer has no Persona to see (an anonymous
   * caller, or a collector that refuses this viewer outright). Holds the
   * server's explanation; the view shows a note instead of a composer or an
   * error.
   */
  forbidden?: string;
  /** The refusal's machine-readable `reason`, when the server sent one. */
  forbiddenReason?: PersonaRefusal;
  /**
   * A write answered 403 `sign-in`: the viewer may read their Persona but this
   * browser can't direct it yet. Cleared by a state that says it can write.
   */
  signInNeeded?: boolean;
  /**
   * Older matches for the thread's job filter, fetched past the loaded window.
   * Kept apart from `messages` so clearing the filter leaves the contiguous
   * window and no gap; live frames and tag edits still patch them by id.
   */
  backfill?: PersonaBackfill;
  /**
   * Count of `persona:*` frames applied. A REST snapshot records it when its
   * requests start; if frames arrived meanwhile, the snapshot may be older
   * than what's on screen, so it is merged additively instead of replacing.
   */
  frames: number;
  /**
   * Set while the view is the one this browser kept from its last open
   * (`personaViewFromCache`): what it painted with, by id. The first snapshot
   * that loads replaces those rows and cards with the server's and clears it.
   */
  cached?: {
    messageIds: ReadonlySet<string>;
    approvalIds: ReadonlySet<string>;
    /** A live `persona:state` frame replaced the kept state. */
    stateLive?: boolean;
  };
  /** Threads whose first message is loaded (an older read came back short). */
  oldestReached: Record<string, true>;
}

export const initialPersonaViewState: PersonaViewState = {
  loaded: false,
  state: null,
  threadId: null,
  consoleThreadId: null,
  messages: [],
  outbox: [],
  others: {},
  threads: [],
  threadsStale: false,
  lastViewed: {},
  viewing: false,
  jobs: [],
  approvals: [],
  activity: null,
  frames: 0,
  oldestReached: {},
};

export interface PersonaSnapshot {
  state?: PersonaState;
  messages?: PersonaMessagesResponse;
  /** Absent when the route failed or the collector predates it. */
  threads?: PersonaThreadSummary[];
  jobs?: PersonaJob[];
  /** Every approval still pending; authoritative for what can be decided. */
  pendingApprovals?: PersonaApproval[];
  /** Recent approvals of every status, newest first (server-capped). */
  recentApprovals?: PersonaApproval[];
  disabledReason?: string;
  /** The 503 was reason `unavailable` (the host is at capacity). */
  unavailable?: boolean;
  loadError?: string;
  /** Set when a read answered 401 or 403 (the viewer has no Persona to see). */
  forbidden?: string;
  /** The 403's `reason`, when the server sent one. */
  forbiddenReason?: PersonaRefusal;
}

/**
 * Why the collector refused a Persona call: `unauthenticated` (no trusted
 * identity, e.g. the console opened outside the tunnel), `sign-in` (a write
 * from a browser without the user's channel proof), `host-only` (a route only
 * the host may use).
 */
export type PersonaRefusal = "unauthenticated" | "sign-in" | "host-only";

const REFUSALS: ReadonlySet<string> = new Set(["unauthenticated", "sign-in", "host-only"]);

/** The refusal `reason` in a response body, when it is one the console knows. */
export function refusalReason(body: unknown): PersonaRefusal | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === "string" && REFUSALS.has(reason) ? (reason as PersonaRefusal) : undefined;
}

/**
 * The caller-relative fields `GET /state` adds to a Persona's state: the host's
 * alias, whether the caller is the host, and whether this browser may direct
 * the Persona. Absent on collectors that predate per-user Persona.
 */
export interface PersonaCallerFields {
  hostAlias?: string;
  isHost?: boolean;
  canWrite?: boolean;
}

/** The caller-relative fields of a state, read defensively. */
export function callerFields(state: PersonaState | null | undefined): PersonaCallerFields {
  const raw = (state ?? {}) as PersonaState & Record<string, unknown>;
  return {
    hostAlias: typeof raw.hostAlias === "string" && raw.hostAlias ? raw.hostAlias : undefined,
    isHost: typeof raw.isHost === "boolean" ? raw.isHost : undefined,
    canWrite: typeof raw.canWrite === "boolean" ? raw.canWrite : undefined,
  };
}

/**
 * Whether the viewer must sign in before directing their Persona: the state
 * says this browser can't write, or a write was refused with `sign-in`.
 */
export function needsSignIn(view: Pick<PersonaViewState, "state" | "signInNeeded">): boolean {
  return Boolean(view.signInNeeded) || callerFields(view.state).canWrite === false;
}

/** Whether the viewer is the host, per the state (false when the collector doesn't say). */
export function isHostViewer(view: Pick<PersonaViewState, "state" | "forbidden">): boolean {
  return !view.forbidden && callerFields(view.state).isHost === true;
}

/**
 * Whether `currentUser` is the host, as far as is known: their alias against
 * the state's `hostAlias`, else the state's `isHost`; undefined while neither
 * is known (no state loaded yet, or the reads were refused).
 */
export function viewerIsHost(view: Pick<PersonaViewState, "state">, currentUser: string): boolean | undefined {
  const { hostAlias, isHost } = callerFields(view.state);
  if (hostAlias && currentUser) return currentUser === hostAlias;
  return isHost;
}

/** The header the collector's host-worded `sign-in` refusal names. */
const OWNER_TOKEN_HEADER_NAME = "x-standup-owner-token";

/**
 * Who this browser must sign in as before it can direct the Persona: `owner`
 * (the host, through `scripts/console-login.ts`), `user` (a guest, with a
 * login link), or undefined when it needn't. Sign-in is needed when the state
 * says the browser can't write, a write was refused `sign-in`, or the reads
 * themselves were. With no state to say who the viewer is, a refusal naming
 * the owner-token header is the host's.
 */
export function signInNeededAs(
  view: Pick<PersonaViewState, "state" | "signInNeeded" | "forbidden" | "forbiddenReason">,
  currentUser: string
): "owner" | "user" | undefined {
  const refused = view.forbiddenReason === "sign-in";
  if (!refused && !needsSignIn(view)) return undefined;
  const host = viewerIsHost(view, currentUser) ?? (refused && Boolean(view.forbidden?.includes(OWNER_TOKEN_HEADER_NAME)));
  return host ? "owner" : "user";
}

/** The sign-in command a host runs for `alias` (a placeholder when unknown). */
export function userLoginCommand(alias: string | undefined): string {
  return `bun run scripts/console-login.ts --user ${alias || "<you>"}`;
}

export type PersonaAction =
  /**
   * `superseded`: a newer read started after this one, so this only adds rows
   * and cards; its load error, refusal or disabled word is left to the newer read.
   */
  | { type: "snapshot"; snapshot: PersonaSnapshot; frameMark: number; superseded?: boolean }
  | { type: "frame"; message: WsMessage }
  | { type: "state"; state: PersonaState }
  | { type: "disabled"; reason: string; unavailable?: boolean }
  | { type: "forbidden"; reason: string; refusal?: PersonaRefusal }
  | { type: "signInNeeded" }
  | { type: "queue"; item: PersonaOutboxItem }
  | { type: "sent"; idempotencyKey: string; message: PersonaMessage; also?: PersonaMessage[] }
  | { type: "sendFailed"; idempotencyKey: string; error: string }
  | { type: "resend"; idempotencyKey: string }
  | { type: "discard"; idempotencyKey: string }
  | { type: "approval"; approval: PersonaApproval }
  | { type: "select"; threadId: string }
  | { type: "threadMessages"; response: PersonaMessagesResponse }
  /** A page of `threadId`'s messages older than the window, read `limit` at a time. */
  | { type: "older"; threadId: string; messages: PersonaMessage[]; limit: number }
  | { type: "catchUp"; messages: PersonaMessage[] }
  | { type: "messageUpdated"; message: PersonaMessage }
  | { type: "tagRemove"; messageId: string; jobId: string }
  | { type: "tagRestore"; messageId: string; tag: PersonaMessageJobTag }
  | { type: "backfill"; threadId: string; key: string; messages: PersonaMessage[] }
  | { type: "backfillClear" }
  | { type: "threads"; threads: PersonaThreadSummary[] }
  | { type: "viewing"; active: boolean };

/** The server echo may carry the key it was sent with; it isn't in the shared type. */
type MaybeKeyed = PersonaMessage & { idempotencyKey?: string };

/** Highest seq in an ascending message list, 0 when empty. */
export function maxSeq(messages: PersonaMessage[]): number {
  return messages.length === 0 ? 0 : messages[messages.length - 1].seq;
}

/**
 * `m`, keeping the `answeredAt` of the copy held before it. The collector
 * never reopens a question, so a copy without it (a response read before the
 * answer) must not bring its quick replies back.
 */
function keepAnswered(m: PersonaMessage, prev: PersonaMessage | undefined): PersonaMessage {
  return prev?.answeredAt && !m.answeredAt ? { ...m, answeredAt: prev.answeredAt } : m;
}

/**
 * Unions `incoming` into `existing` by id, incoming winning (save a held
 * `answeredAt`, see keepAnswered), and returns them ascending by seq. A row
 * whose seq is claimed by a different incoming id is dropped too — seq is
 * unique per thread, so the server's latest word wins. Returns `existing`
 * itself when nothing changed, so React can skip a render.
 */
export function mergeMessages(
  existing: PersonaMessage[],
  incoming: PersonaMessage[]
): PersonaMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, PersonaMessage>();
  for (const m of existing) byId.set(m.id, m);
  let changed = false;
  for (const fresh of incoming) {
    const prev = byId.get(fresh.id);
    const m = keepAnswered(fresh, prev);
    if (prev && sameMessage(prev, m)) continue;
    byId.set(m.id, m);
    changed = true;
  }
  if (!changed) return existing;
  const bySeq = new Map<number, PersonaMessage>();
  const incomingIds = new Set(incoming.map((m) => m.id));
  for (const m of byId.values()) {
    const holder = bySeq.get(m.seq);
    if (holder && incomingIds.has(holder.id) && !incomingIds.has(m.id)) continue;
    bySeq.set(m.seq, m);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function sameMessage(a: PersonaMessage, b: PersonaMessage): boolean {
  return (
    a.seq === b.seq &&
    a.text === b.text &&
    a.role === b.role &&
    a.approvalId === b.approvalId &&
    !!a.command === !!b.command &&
    a.answeredAt === b.answeredAt &&
    (a.options ?? []).join("\u0000") === (b.options ?? []).join("\u0000") &&
    (a.jobIds ?? []).join("\u0000") === (b.jobIds ?? []).join("\u0000") &&
    jobTagsKey(a) === jobTagsKey(b)
  );
}

/** A message's tags as one comparable string: each job id with its source, in order. */
export function jobTagsKey(m: Pick<PersonaMessage, "jobTags">): string {
  return (m.jobTags ?? []).map((t) => `${t.jobId}:${t.source}`).join("\u0000");
}

/**
 * The job ids a message is tagged with, oldest tag first: its `jobTags`, else
 * its bare `jobIds` (an older collector that sends no sources).
 */
export function messageJobIds(m: Pick<PersonaMessage, "jobIds" | "jobTags">): string[] {
  if (m.jobTags && m.jobTags.length > 0) return m.jobTags.map((t) => t.jobId);
  return m.jobIds ?? [];
}

/**
 * A message's tags with their sources. A bare `jobIds` entry with no tag
 * record reads as `explicit`, the only kind older collectors stored.
 */
export function messageJobTags(m: Pick<PersonaMessage, "jobIds" | "jobTags">): PersonaMessageJobTag[] {
  if (m.jobTags && m.jobTags.length > 0) return m.jobTags;
  return (m.jobIds ?? []).map((jobId) => ({ jobId, source: "explicit" as const }));
}

/** `m` with one job's tag removed from both `jobTags` and `jobIds`. */
export function withoutJobTag(m: PersonaMessage, jobId: string): PersonaMessage {
  const next: PersonaMessage = { ...m };
  if (m.jobTags) next.jobTags = m.jobTags.filter((t) => t.jobId !== jobId);
  if (m.jobIds) next.jobIds = m.jobIds.filter((id) => id !== jobId);
  return next;
}

/**
 * `m` with `tag` added back, at the end of its tags. A message that already
 * carries that job (under any source) comes back unchanged.
 */
export function withJobTag(m: PersonaMessage, tag: PersonaMessageJobTag): PersonaMessage {
  if (messageJobIds(m).includes(tag.jobId)) return m;
  const next: PersonaMessage = { ...m, jobTags: [...messageJobTags(m), tag] };
  next.jobIds = [...(m.jobIds ?? []).filter((id) => id !== tag.jobId), tag.jobId];
  return next;
}

/** A job filter as one comparable string, the same whatever order it was picked in. */
export function tagFilterKey(jobIds: readonly string[]): string {
  return [...jobIds].sort().join(",");
}

/**
 * What a filtered thread shows. `matches` are the rows tagged with any of
 * `filter`, drawn from the loaded window and the older `extra` rows (the
 * window's copy winning by id). `rows` adds the owner's own messages newer
 * than `keepAfterSeq`, so a message sent while filtering stays in view, and
 * the untagged rows after the first of them, so the reply to it shows even
 * when nothing tagged it with the filter's jobs. A row tagged only with other
 * jobs is about them, and stays filtered out.
 */
export function filteredThread(
  messages: PersonaMessage[],
  extra: PersonaMessage[],
  filter: ReadonlySet<string>,
  keepAfterSeq: number
): { rows: PersonaMessage[]; matches: number } {
  const all = extra.length > 0 ? mergeMessages(extra, messages) : messages;
  let matches = 0;
  // The seq of the first message sent while filtering; rows are ascending, so it is set before any row after it.
  let sentSeq = Number.POSITIVE_INFINITY;
  const rows = all.filter((m) => {
    const sent = m.role === "user" && m.seq > keepAfterSeq;
    if (sent) sentSeq = Math.min(sentSeq, m.seq);
    if (messageHasAnyJob(m, filter)) {
      matches++;
      return true;
    }
    if (sent) return true;
    return m.seq > sentSeq && messageJobIds(m).length === 0;
  });
  return { rows, matches };
}

/** Whether a message is tagged with any of `jobIds`. */
export function messageHasAnyJob(m: Pick<PersonaMessage, "jobIds" | "jobTags">, jobIds: ReadonlySet<string>): boolean {
  return messageJobIds(m).some((id) => jobIds.has(id));
}

/**
 * The jobs a thread's messages are tagged with and how many messages carry
 * each, most-tagged first (ties by the earliest message tagged).
 */
export function threadJobCounts(messages: PersonaMessage[]): { jobId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    for (const id of new Set(messageJobIds(m))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([jobId, count]) => ({ jobId, count })).sort((a, b) => b.count - a.count);
}

/** A `?tags=` value as the job ids it names: comma-separated, trimmed, deduped. */
export function parseTagFilter(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** The messages route filtered to messages tagged with any of `jobIds`. */
export function taggedMessagesPath(threadId: string | null | undefined, jobIds: string[]): string {
  const params = new URLSearchParams();
  if (threadId) params.set("threadId", threadId);
  params.set("jobId", jobIds.join(","));
  return `/messages?${params.toString()}`;
}

/** The route that removes one job tag from a message. */
export function messageJobPath(messageId: string, jobId: string): string {
  return `/messages/${encodeURIComponent(messageId)}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Drops outbox items confirmed by any of `confirmed` (server rows). A row
 * confirms an item when it carries the item's idempotency key, or — since the
 * shared message type doesn't promise the key — when it is a `user` row with
 * the same text and attachments sorting after the item's `afterSeq` — the
 * text fallback applies only to a row with no key at all. Each row confirms at most
 * one item, oldest first, so sending the same text twice keeps one pending
 * until the second echo lands.
 */
export function reconcileOutbox(
  outbox: PersonaOutboxItem[],
  confirmed: PersonaMessage[]
): PersonaOutboxItem[] {
  if (outbox.length === 0 || confirmed.length === 0) return outbox;
  const remaining = outbox.slice();
  let changed = false;
  for (const raw of confirmed) {
    const m = raw as MaybeKeyed;
    if (m.role !== "user") continue;
    // A keyed echo confirms only its own send: one carrying some other key
    // (another tab's, or an earlier session's) must not clear a pending bubble
    // that merely shares its text.
    let i: number;
    if (m.idempotencyKey) {
      i = remaining.findIndex((o) => o.idempotencyKey === m.idempotencyKey);
    } else {
      const text = m.text.trim();
      const ids = (m.attachments ?? []).map((a) => a.id).join(",");
      i = remaining.findIndex(
        (o) => o.text.trim() === text && (o.attachmentIds ?? []).join(",") === ids && m.seq > o.afterSeq
      );
    }
    if (i === -1) continue;
    remaining.splice(i, 1);
    changed = true;
  }
  return changed ? remaining : outbox;
}

/** The attachment ids every unconfirmed send carries, in any thread. */
export function pendingAttachmentIds(view: Pick<PersonaViewState, "outbox" | "others">): Set<string> {
  const ids = new Set<string>();
  const add = (outbox: PersonaOutboxItem[]) => {
    for (const item of outbox) for (const id of item.attachmentIds ?? []) ids.add(id);
  };
  add(view.outbox);
  for (const buffer of Object.values(view.others)) add(buffer.outbox);
  return ids;
}

/**
 * Inserts or replaces a job by id, keeping the list newest-first. A stale copy
 * (older `updatedAt` than the one held) is ignored so a late REST response
 * can't roll a job back.
 */
export function upsertJob(jobs: PersonaJob[], job: PersonaJob): PersonaJob[] {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i !== -1) {
    if (jobs[i].updatedAt > job.updatedAt) return jobs;
    const next = jobs.slice();
    next[i] = job;
    return next;
  }
  return [...jobs, job].sort(newestFirst);
}

export function mergeJobs(existing: PersonaJob[], incoming: PersonaJob[]): PersonaJob[] {
  let next = existing;
  for (const job of incoming) next = upsertJob(next, job);
  return next;
}

function newestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/** How far an approval has progressed; a decision never reverts to pending. */
const APPROVAL_RANK: Record<PersonaApprovalStatus, number> = {
  pending: 0,
  approved: 1,
  denied: 2,
  executed: 2,
  failed: 2,
  expired: 2,
  superseded: 2,
};

/**
 * Inserts or replaces an approval by id. A copy that is less far along than
 * the one held (a `pending` row arriving after the decision) is ignored.
 */
export function upsertApproval(
  approvals: PersonaApproval[],
  approval: PersonaApproval
): PersonaApproval[] {
  const i = approvals.findIndex((a) => a.id === approval.id);
  if (i === -1) return [...approvals, approval];
  if (APPROVAL_RANK[approvals[i].status] > APPROVAL_RANK[approval.status]) return approvals;
  const next = approvals.slice();
  next[i] = approval;
  return next;
}

/**
 * Applies a list of approvals. With `authoritative`, the list is the complete
 * set of pending approvals: one held as pending but absent from it is no
 * longer pending on the server (decided or expired), so it is dropped rather
 * than left offering buttons that would only 409.
 */
export function mergeApprovals(
  existing: PersonaApproval[],
  list: PersonaApproval[],
  authoritative: boolean
): PersonaApproval[] {
  const ids = new Set(list.map((a) => a.id));
  let next = authoritative
    ? existing.filter((a) => a.status !== "pending" || ids.has(a.id))
    : existing;
  for (const a of list) next = upsertApproval(next, a);
  return next;
}

/**
 * Folds a snapshot's two approval lists into what's held. The pending list is
 * the only authority on what is still pending; the recent list is capped and
 * newest-first, so an older approval that is still pending can be missing from
 * it and must not be pruned on that basis. The recent list only adds history
 * (and advances a held approval to its decided status).
 */
export function mergeApprovalSnapshot(
  existing: PersonaApproval[],
  pending: PersonaApproval[] | undefined,
  recent: PersonaApproval[] | undefined,
  fresh: boolean
): PersonaApproval[] {
  let next = existing;
  if (pending) next = mergeApprovals(next, pending, fresh);
  if (recent) next = mergeApprovals(next, recent, false);
  return next;
}

/** Approvals awaiting the owner, oldest first (the order they were asked). */
export function pendingApprovals(approvals: PersonaApproval[]): PersonaApproval[] {
  return approvals
    .filter((a) => a.status === "pending")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * Whether `approval` is the card Standup raised on a safety-floor hold Persona
 * can't allow: approving answers the hold "Allow once", denying it denies the call.
 */
export function isOwnerFloorCard(approval: Pick<PersonaApproval, "action" | "args">): boolean {
  return approval.action === "answer_ask" && approval.args?.floorHold === true;
}

/** Who must decide an approval: its `approver` when set (the host, for an escalated hold), else its owner. */
export function approvalDecider(approval: Pick<PersonaApproval, "approver" | "owner">): string {
  return approval.approver ?? approval.owner;
}

/** Whether `viewer` is the one who decides `approval` (the collector refuses anyone else). */
export function isApprovalDecider(approval: Pick<PersonaApproval, "approver" | "owner">, viewer: string | undefined): boolean {
  return Boolean(viewer) && approvalDecider(approval) === viewer;
}

/** The pending approvals `viewer` must decide themselves, oldest first; the "needs you" count. */
export function approvalsNeedingViewer(approvals: PersonaApproval[], viewer: string | undefined): PersonaApproval[] {
  return pendingApprovals(approvals).filter((a) => isApprovalDecider(a, viewer));
}

/** The pending strip's heading: how many cards await the viewer, and how many wait on someone else. */
export function pendingStripTitle(approvals: PersonaApproval[], viewer: string | undefined): string {
  const mine = approvals.filter((a) => isApprovalDecider(a, viewer)).length;
  const others = approvals.length - mine;
  const parts: string[] = [];
  if (mine > 0) parts.push(mine === 1 ? "Awaiting your approval" : `${mine} awaiting your approval`);
  if (others > 0) parts.push(`${others} waiting on ${others === 1 ? "someone else" : "others"}`);
  return parts.join(" · ");
}

/** The note on a pending card someone else decides, or undefined when `viewer` decides it. */
export function approvalWaitingLabel(
  approval: Pick<PersonaApproval, "approver" | "owner" | "status">,
  viewer: string | undefined
): string | undefined {
  if (approval.status !== "pending" || isApprovalDecider(approval, viewer)) return undefined;
  return `Waiting on ${approvalDecider(approval)}`;
}

/**
 * The messages whose quick-reply options are still live: every Persona
 * question with options the collector hasn't marked answered, however many
 * are open at once. A question with a quick reply to it still sending (or
 * failed and awaiting a retry) shows none, so it can't be answered twice.
 */
export function openOptionsMessageIds(
  messages: PersonaMessage[],
  outbox: PersonaOutboxItem[] = []
): Set<string> {
  const replying = new Set(outbox.flatMap((o) => (o.replyTo ? [o.replyTo.messageId] : [])));
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role !== "persona" || !m.options || m.options.length === 0) continue;
    if (m.answeredAt || replying.has(m.id)) continue;
    open.add(m.id);
  }
  return open;
}

export type PersonaChipTone = "idle" | "running" | "waiting" | "stalled" | "faint";

export interface PersonaChip {
  label: string;
  tone: PersonaChipTone;
}

const CHIPS: Record<PersonaRunState, PersonaChip> = {
  idle: { label: "Idle", tone: "idle" },
  thinking: { label: "Thinking", tone: "running" },
  error: { label: "Error", tone: "waiting" },
  paused: { label: "Paused", tone: "stalled" },
  disabled: { label: "Disabled", tone: "faint" },
};

/** The run-state chip; the collector's 503 from any route reads as disabled too, or unavailable when the host is at capacity. */
export function runStateChip(view: Pick<PersonaViewState, "state" | "disabledReason" | "unavailable">): PersonaChip {
  if (view.unavailable) return { label: "Unavailable", tone: "faint" };
  if (view.disabledReason) return CHIPS.disabled;
  if (!view.state) return { label: "Connecting", tone: "faint" };
  return CHIPS[view.state.runState];
}

/** The alias the collector resolves a caller with no trusted identity to. */
export const ANONYMOUS_VIEWER = "anonymous";

/**
 * Whether the loaded Persona is `viewer`'s own, as far as is known. Every
 * authenticated user has one and `GET /state` serves the caller's, so a loaded
 * state naming the viewer is theirs; a forbidden view is nobody's. An empty
 * `viewer` (no hello-ok yet) defers to the state alone — the REST routes served
 * it for this connection's identity.
 */
export function isPersonaOwner(
  view: Pick<PersonaViewState, "state" | "forbidden">,
  viewer: string
): boolean {
  if (view.forbidden || !view.state) return false;
  return !viewer || view.state.owner === viewer;
}

/**
 * Where `/` lands: on the viewer's own Persona for any authenticated user, on
 * Work for an anonymous viewer, or any viewer while Persona is disabled,
 * refused or unreachable. `undefined` while the first snapshot is still
 * loading, so the redirect waits rather than guessing.
 */
export function personaLanding(
  view: Pick<PersonaViewState, "loaded" | "state" | "forbidden" | "forbiddenReason" | "disabledReason" | "unavailable">,
  viewer: string
): "/persona" | "/work" | undefined {
  // A `sign-in` refusal is a user whose browser isn't signed in yet: the
  // Persona tab is where they're told how to sign in.
  if (view.forbidden) return view.forbiddenReason === "sign-in" && viewer !== ANONYMOUS_VIEWER ? "/persona" : "/work";
  if (viewer === ANONYMOUS_VIEWER) return "/work";
  if (!view.loaded) return undefined;
  if (isPersonaDisabled(view)) return "/work";
  return isPersonaOwner(view, viewer) ? "/persona" : "/work";
}

/**
 * The "from <owner>'s Persona" label for a card a viewer must decide on
 * another user's behalf (a guest Persona's floor hold escalated to the host),
 * or undefined for the viewer's own card.
 */
export function approvalFromLabel(approval: Pick<PersonaApproval, "owner">, viewerOwner: string | undefined): string | undefined {
  if (!approval.owner || !viewerOwner || approval.owner === viewerOwner) return undefined;
  return `from ${approval.owner}'s Persona`;
}

/** `path` with `user=<alias>` appended, for the host's read-only view of another user's Persona. */
export function withUser(path: string, user?: string | null): string {
  if (!user) return path;
  return `${path}${path.includes("?") ? "&" : "?"}user=${encodeURIComponent(user)}`;
}

/** One user's Persona as the host's People panel lists it (`GET /api/persona/users`). */
export interface PersonaUserEntry {
  alias: string;
  state: { paused?: boolean; runState?: PersonaRunState; [key: string]: unknown } | null;
  pendingApprovals: number;
  access: { enabled: boolean; launchProjects: string[] } | null;
}

/** Whether a People entry's Persona is paused. */
export function isUserPaused(entry: Pick<PersonaUserEntry, "state">): boolean {
  return entry.state?.paused === true || entry.state?.runState === "paused";
}

/**
 * Whether the host has disabled a People entry's access (its access row says
 * `enabled: false`): its Persona may launch into no project, whatever the
 * allowlist holds.
 */
export function isUserDisabled(entry: Pick<PersonaUserEntry, "access">): boolean {
  return entry.access?.enabled === false;
}

/**
 * A People row's status: paused, its run state, or that it has never run
 * (`state: null`), led by "disabled" when its access is.
 */
export function userStatusLabel(entry: Pick<PersonaUserEntry, "access" | "state">): string {
  const run = isUserPaused(entry) ? "paused" : (entry.state?.runState ?? "no Persona yet");
  return isUserDisabled(entry) ? `disabled · ${run}` : run;
}

/**
 * The access route's body for a change to one user: the full allowlist and
 * the enabled flag, each kept from `entry` unless `change` sets it, so editing
 * one never resets the other.
 */
export function accessUpdate(
  entry: Pick<PersonaUserEntry, "access">,
  change: { launchProjects?: string[]; enabled?: boolean }
): { launchProjects: string[]; enabled: boolean } {
  return {
    launchProjects: change.launchProjects ?? entry.access?.launchProjects ?? [],
    enabled: change.enabled ?? !isUserDisabled(entry),
  };
}

/** The People entries other than the host's own. */
export function otherUsers(users: PersonaUserEntry[], hostAlias: string | undefined): PersonaUserEntry[] {
  return users.filter((u) => u.alias !== hostAlias);
}

/** A comma- or whitespace-separated project list as the access route takes it: trimmed, deduped, no blanks. */
export function parseProjectList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))];
}

/** A job's latest progress note; read defensively since older collectors omit it. */
export function jobNote(job: PersonaJob): string | undefined {
  const note = (job as PersonaJob & { note?: unknown }).note;
  return typeof note === "string" && note.trim() ? note : undefined;
}

export function isPersonaDisabled(
  view: Pick<PersonaViewState, "state" | "disabledReason" | "unavailable">
): boolean {
  return Boolean(view.disabledReason) || Boolean(view.unavailable) || view.state?.runState === "disabled";
}

/** What a viewer whose Persona the host has no room for is told (503 `unavailable`). */
export function unavailableMessage(hostAlias: string | undefined): string {
  return `Persona is at capacity on this host — ask ${hostAlias || "the host"}`;
}

/** The activity line to show, only while a turn is running. */
export function activityLabel(view: Pick<PersonaViewState, "state" | "activity">): string | undefined {
  if (view.state?.runState !== "thinking" || !view.activity) return undefined;
  const { label, detail } = view.activity;
  return detail ? `${label} · ${detail}` : label;
}

/** One labelled reading in the header's host-capacity readout, with its one-line tooltip. */
export interface CapacityReading {
  text: string;
  title: string;
}

/** The header's host-capacity readout: worker count, CPU load and RAM, each spelled out. */
export interface HostCapacity {
  workers: CapacityReading;
  /** Present when the host, not the configured cap, sets the worker cap. */
  hostLimited?: CapacityReading;
  queued?: CapacityReading;
  cpu?: CapacityReading;
  ram?: CapacityReading;
}

/** Binary gigabytes as a bare number: "224" from 10 GB up, "3.1" below, so small figures keep their decimal. */
export function formatGbNumber(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 9.95 ? gb.toFixed(0) : gb.toFixed(1);
}

export function hostCapacity(state: PersonaState): HostCapacity {
  const host = state.host;
  const configured = state.maxActiveLaunches;
  const cap = host?.effectiveMaxActive ?? configured;
  const queuedCount = host?.queued ?? 0;
  const running = Math.max(0, state.activeLaunches - queuedCount);
  const out: HostCapacity = {
    workers: {
      text: `Workers ${running} / ${cap}`,
      title: `Persona's running workers against the active cap (configured ${configured}; it shrinks while the host is short on memory or CPU)`,
    },
  };
  if (host?.hostLimited) {
    out.hostLimited = {
      text: "host-limited",
      title: `The host's free memory or CPU lowered the worker cap from ${configured} to ${cap}`,
    };
  }
  if (queuedCount > 0) {
    out.queued = {
      text: `${queuedCount} queued`,
      title: "Persona launches waiting for host room; they start on their own when it frees up",
    };
  }
  if (host?.load1 !== undefined && host.cores !== undefined) {
    out.cpu = {
      text: `CPU load ${host.load1.toFixed(1)} / ${host.cores} cores`,
      title: "1-minute CPU load average against the host's core count; new workers wait while load runs past the cores",
    };
  }
  if (host?.memAvailableBytes !== undefined) {
    const total = host.memTotalBytes;
    out.ram = {
      text:
        total === undefined
          ? `RAM ${formatGbNumber(host.memAvailableBytes)} GB free`
          : `RAM ${formatGbNumber(host.memAvailableBytes)} / ${formatGbNumber(total)} GB free`,
      title: "Memory the host can hand new workers without swapping (MemAvailable), out of its total RAM (MemTotal)",
    };
  }
  return out;
}

/** "42 s", "14 min", "3.5 h", "2.1 d": a time to decide, coarse. */
export function formatDecideTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  const min = s / 60;
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

/** One noisy-hold report row as the console shows it. */
export interface HoldReportLine {
  rule: string;
  count: string;
  rate: string;
  median: string;
  /** "noisy", "retired", "kept" (excluded from loosening) or "" for an ordinary rule. */
  tag: "noisy" | "retired" | "kept" | "";
  note?: string;
}

/**
 * A hold-report row for display: "9/10 approved", "90%", the median time to
 * decide, and a tag saying whether the rule looks like noise, no longer
 * exists, or is one that always stays the owner's.
 */
export function holdReportLine(row: PersonaHoldReportRow): HoldReportLine {
  const undecided = row.pending + row.expired + row.superseded;
  const count = `${row.approved}/${row.decided} approved${undecided > 0 ? ` · ${undecided} undecided` : ""}`;
  const rate = row.approveRate === null ? "—" : `${Math.round(row.approveRate * 100)}%`;
  const tag = row.noisy ? "noisy" : row.retired ? "retired" : row.excluded ? "kept" : "";
  const note = row.retired
    ? "rule removed from the policy"
    : row.excluded
      ? row.excluded
      : row.inferred
        ? "some rules read from older reasons"
        : undefined;
  return { rule: row.holdRule, count, rate, median: formatDecideTime(row.medianDecideMs), tag, ...(note ? { note } : {}) };
}

const JOB_ORDER: Record<PersonaJobState, number> = {
  needs_you: 0,
  running: 1,
  idle: 2,
  failed: 3,
  done: 4,
  cancelled: 5,
};

/**
 * A job's derived state (`view.state`), which the stored status never
 * overrides — the collector only derives `needs_you` with something for the
 * owner to open behind it (`view.actions`). A collector too old to derive a
 * view serves only the stored status: waiting_user reads as needs-you, active
 * as running.
 */
export function jobState(job: PersonaJob): PersonaJobState {
  const state = job.view?.state;
  if (state && state in JOB_ORDER) return state;
  if (job.status === "waiting_user") return "needs_you";
  if (job.status === "active") return "running";
  return job.status;
}

/** When the job or its workers last did anything; the job's own update time on an older collector. */
export function jobLastActivity(job: PersonaJob): string {
  return job.view?.lastActivityAt ?? job.updatedAt;
}

/**
 * The line a Jobs row shows under its title: the latest worker checkpoint
 * when it is newer than Persona's note (the server only sends one then),
 * else the note.
 */
export function jobSummaryLine(job: PersonaJob): { text: string; source: "checkpoint" | "note" } | undefined {
  const checkpoint = job.view?.checkpoint?.summary?.trim();
  if (checkpoint) return { text: checkpoint, source: "checkpoint" };
  const note = jobNote(job);
  return note ? { text: note, source: "note" } : undefined;
}

/** Jobs that need the owner first, then running, idle, then closed; most recently active first within each. */
export function sortJobs(jobs: PersonaJob[]): PersonaJob[] {
  return jobs
    .slice()
    .sort(
      (a, b) =>
        JOB_ORDER[jobState(a)] - JOB_ORDER[jobState(b)] ||
        Date.parse(jobLastActivity(b)) - Date.parse(jobLastActivity(a)) ||
        newestFirst(a, b)
    );
}

export function isOpenJob(job: PersonaJob): boolean {
  return job.status === "active" || job.status === "waiting_user";
}

/** Jobs most recently active first, whatever their state. */
export function byRecentActivity(jobs: PersonaJob[]): PersonaJob[] {
  return jobs
    .slice()
    .sort((a, b) => Date.parse(jobLastActivity(b)) - Date.parse(jobLastActivity(a)) || newestFirst(a, b));
}

/**
 * Where the composer's messages go while the thread is filtered by job. To
 * the one filtered job when the collector takes it as a tag on this thread's
 * messages (runtime.jobTaggableIn: a job it knows, on a private thread or the
 * job's own thread) — it refuses a send naming any other. Otherwise to the
 * thread untagged, with why: `several` jobs filtered, an `unknown` job, or a
 * job of another thread on a shared one. Null while unfiltered.
 *
 * Each refusal is decided only from what is loaded: before the jobs list
 * (`jobsKnown`) a job missing from it isn't called unknown, and while the
 * thread's audience is unknown (`private` undefined) a job isn't called
 * another thread's. Either way the send carries the job and the collector
 * decides, so a first paint never drops a tag the collector would keep.
 */
export type ComposerRoute =
  | { kind: "job"; jobId: string; job?: PersonaJob }
  | { kind: "untagged"; reason: "several" | "unknown" | "otherThread"; jobId?: string };

export function composerRoute(
  filter: readonly string[],
  jobsById: Map<string, PersonaJob>,
  jobsKnown: boolean,
  thread: { id: string | null | undefined; private: boolean | undefined }
): ComposerRoute | null {
  if (filter.length === 0) return null;
  if (filter.length > 1) return { kind: "untagged", reason: "several" };
  const jobId = filter[0]!;
  const job = jobsById.get(jobId);
  if (!job) return jobsKnown ? { kind: "untagged", reason: "unknown", jobId } : { kind: "job", jobId };
  if (!jobTaggableOn(job, thread)) return { kind: "untagged", reason: "otherThread", jobId };
  return { kind: "job", jobId, job };
}

/** Whether a `#` tag (or a route) to `job` is one the collector takes on this thread; see composerRoute. */
export function jobTaggableOn(job: PersonaJob, thread: { id: string | null | undefined; private: boolean | undefined }): boolean {
  return thread.private !== false || job.threadId === thread.id;
}

/** Folds server rows into one thread's buffer; returns `buffer` itself when nothing changed. */
function mergeIntoBuffer(
  buffer: PersonaThreadBuffer,
  incoming: PersonaMessage[],
  reconcile: boolean
): PersonaThreadBuffer {
  // A row already held has confirmed whatever it was going to; letting a
  // redelivery match again would swallow a later send of the same text.
  const known = new Set(buffer.messages.map((m) => m.id));
  const unseen = incoming.filter((m) => !known.has(m.id));
  const messages = mergeMessages(buffer.messages, incoming);
  const outbox = reconcile ? reconcileOutbox(buffer.outbox, unseen) : buffer.outbox;
  if (messages === buffer.messages && outbox === buffer.outbox) return buffer;
  return { messages, outbox };
}

/**
 * Routes server rows to their threads' buffers. With `reconcile`, unseen rows
 * also confirm matching outbox items; a POST response doesn't, since its key
 * already named the one item it confirms. A `page` is a fetched run of a
 * thread's latest messages rather than live rows.
 */
function applyMessages(
  view: PersonaViewState,
  incoming: PersonaMessage[],
  reconcile = true,
  page = false
): PersonaViewState {
  if (incoming.length === 0) return view;
  ({ view, incoming } = patchBackfill(view, incoming, page));
  if (incoming.length === 0) return view;
  // Before the selected thread is known, every row is held under its own
  // thread: a frame for some other thread must not surface in the view once
  // the state names the console thread. adoptSelected promotes the selected
  // thread's held rows when it becomes known.
  const selected = view.threadId;
  const byThread = new Map<string, PersonaMessage[]>();
  for (const m of incoming) {
    const list = byThread.get(m.threadId);
    if (list) list.push(m);
    else byThread.set(m.threadId, [m]);
  }
  let next = view;
  for (const [threadId, rows] of byThread) {
    if (selected && threadId === selected) {
      let buffer = mergeIntoBuffer({ messages: next.messages, outbox: next.outbox }, rows, reconcile);
      if (page) buffer = withoutStrayAnswers(buffer, rows);
      if (buffer.messages !== next.messages || buffer.outbox !== next.outbox) {
        next = { ...next, messages: buffer.messages, outbox: buffer.outbox };
      }
    } else {
      const held = next.others[threadId] ?? { messages: [], outbox: [] };
      let buffer = mergeIntoBuffer(held, rows, reconcile);
      if (page) buffer = withoutStrayAnswers(buffer, rows);
      if (buffer !== held) next = { ...next, others: { ...next.others, [threadId]: buffer } };
    }
  }
  next = touchThreads(next, incoming);
  return markSelectedViewed(trimBackfill(next));
}

/**
 * Drops from `buffer` the answered questions held apart below a fetched
 * `page`: re-publishes of old questions (one close can answer several asked
 * back to back) that landed before the thread's window did. Each run of
 * consecutive rows that doesn't reach the page and holds nothing but answered
 * questions goes, since keeping it would open a hole the catch-up would read
 * the whole span to fill; such rows are outside the window, which only the
 * backfill shows. A loaded run holds more than questions.
 */
function withoutStrayAnswers(buffer: PersonaThreadBuffer, page: PersonaMessage[]): PersonaThreadBuffer {
  if (page.length === 0) return buffer;
  const start = Math.min(...page.map((m) => m.seq));
  const below = buffer.messages.filter((m) => m.seq < start);
  const stray = new Set<string>();
  let run: PersonaMessage[] = [];
  const settle = (reachesPage: boolean) => {
    if (!reachesPage && run.length > 0 && run.every((m) => m.role === "persona" && m.options && m.answeredAt)) {
      for (const m of run) stray.add(m.id);
    }
    run = [];
  };
  for (const m of below) {
    if (run.length > 0 && m.seq !== run[run.length - 1].seq + 1) settle(false);
    run.push(m);
  }
  settle(run.length > 0 && run[run.length - 1].seq === start - 1);
  if (stray.size === 0) return buffer;
  return { ...buffer, messages: buffer.messages.filter((m) => !stray.has(m.id)) };
}

/**
 * Applies `incoming` rows that are backfilled filter matches to the backfill.
 * A live row for a backfilled message older than the whole loaded window is
 * an edit the window doesn't reach, so it updates the backfill only and is
 * taken out of `incoming`. Every other row passes through to the thread: a
 * page is a contiguous run of it, and holding any row of one back, or a row
 * when no window is loaded yet, would open a gap once the backfill clears.
 */
function patchBackfill(
  view: PersonaViewState,
  incoming: PersonaMessage[],
  page: boolean
): { view: PersonaViewState; incoming: PersonaMessage[] } {
  const backfill = view.backfill;
  if (!backfill || backfill.messages.length === 0) return { view, incoming };
  const held = new Set(backfill.messages.map((m) => m.id));
  const hits = incoming.filter((m) => m.threadId === backfill.threadId && held.has(m.id));
  if (hits.length === 0) return { view, incoming };
  const messages = mergeMessages(backfill.messages, hits);
  const next = messages === backfill.messages ? view : { ...view, backfill: { ...backfill, messages } };
  const windowStart = windowStartSeq(view, backfill.threadId);
  if (page || windowStart === null) return { view: next, incoming };
  const older = new Set(hits.filter((m) => m.seq < windowStart));
  return { view: next, incoming: older.size > 0 ? incoming.filter((m) => !older.has(m)) : incoming };
}

/** The first seq of a thread's loaded window, null when nothing is loaded. */
function windowStartSeq(view: PersonaViewState, threadId: string): number | null {
  const rows = threadId === view.threadId ? view.messages : view.others[threadId]?.messages ?? [];
  return rows.length === 0 ? null : rows[0].seq;
}

/**
 * Drops backfilled rows the loaded window reaches: from the window's first
 * seq on, the window's copy is the one shown, so the backfill only ever
 * holds messages older than it.
 */
function trimBackfill(view: PersonaViewState): PersonaViewState {
  const backfill = view.backfill;
  if (!backfill || backfill.messages.length === 0) return view;
  const windowStart = windowStartSeq(view, backfill.threadId);
  if (windowStart === null || backfill.messages[backfill.messages.length - 1].seq < windowStart) return view;
  return { ...view, backfill: { ...backfill, messages: backfill.messages.filter((m) => m.seq < windowStart) } };
}

/**
 * Rewrites the held copies of one message (in the selected thread and its
 * backfill) with `fn`, applied to each copy as it is now.
 */
function patchHeldMessage(
  view: PersonaViewState,
  messageId: string,
  fn: (m: PersonaMessage) => PersonaMessage
): PersonaViewState {
  const patch = (rows: PersonaMessage[]): PersonaMessage[] => {
    const i = rows.findIndex((m) => m.id === messageId);
    if (i === -1) return rows;
    const patched = fn(rows[i]);
    if (patched === rows[i]) return rows;
    const next = rows.slice();
    next[i] = patched;
    return next;
  };
  let next = view;
  const messages = patch(view.messages);
  if (messages !== view.messages) next = { ...next, messages };
  const backfill = view.backfill;
  if (backfill) {
    const rows = patch(backfill.messages);
    if (rows !== backfill.messages) next = { ...next, backfill: { ...backfill, messages: rows } };
  }
  return next;
}

/**
 * Advances each thread's summary to the newest of `incoming`: its last
 * message, count and activity time, re-sorting the list newest-first. A
 * message for a thread the list doesn't hold flags the list stale.
 */
function touchThreads(view: PersonaViewState, incoming: PersonaMessage[]): PersonaViewState {
  if (!view.threadId) return view;
  let threads = view.threads;
  let stale = view.threadsStale;
  for (const m of incoming) {
    const i = threads.findIndex((t) => t.id === m.threadId);
    if (i === -1) {
      stale = true;
      continue;
    }
    const t = threads[i];
    if (t.lastMessage && t.lastMessage.seq >= m.seq) continue;
    const next = threads.slice();
    next[i] = {
      ...t,
      messageCount: Math.max(t.messageCount + 1, m.seq),
      lastMessage: { seq: m.seq, role: m.role, text: m.text, createdAt: m.createdAt },
      updatedAt: m.createdAt > t.updatedAt ? m.createdAt : t.updatedAt,
    };
    threads = next.sort((a, b) => threadActivity(b).localeCompare(threadActivity(a)));
  }
  if (threads === view.threads && stale === view.threadsStale) return view;
  return { ...view, threads, threadsStale: stale };
}

/**
 * Moves rows held for the selected thread (stashed while no thread was
 * selected) into the visible buffer, so frames that beat the first snapshot
 * aren't lost once their thread turns out to be the one shown.
 */
function adoptSelected(view: PersonaViewState): PersonaViewState {
  const selected = view.threadId;
  if (!selected) return view;
  const held = view.others[selected];
  if (!held) return view;
  const others = { ...view.others };
  delete others[selected];
  const buffer = mergeIntoBuffer({ messages: view.messages, outbox: view.outbox }, held.messages, true);
  return {
    ...view,
    messages: buffer.messages,
    outbox: [...buffer.outbox, ...held.outbox],
    others,
  };
}

/** Whether `m` is held anywhere: the selected thread, another thread's buffer, or the backfill. */
export function holdsMessage(view: PersonaViewState, m: Pick<PersonaMessage, "id" | "threadId">): boolean {
  const has = (rows: PersonaMessage[] | undefined) => rows?.some((r) => r.id === m.id) === true;
  if (m.threadId === view.threadId && has(view.messages)) return true;
  if (has(view.others[m.threadId]?.messages)) return true;
  return view.backfill?.threadId === m.threadId && has(view.backfill.messages);
}

/** Rows held for threads other than the selected one, for refreshing summaries. */
function heldRows(view: PersonaViewState): PersonaMessage[] {
  return Object.values(view.others).flatMap((b) => b.messages);
}

/** Records the selected thread's tail as seen while the view is on screen. */
function markSelectedViewed(view: PersonaViewState): PersonaViewState {
  if (!view.viewing || !view.threadId) return view;
  return markViewed(view, view.threadId, maxSeq(view.messages));
}

function markViewed(view: PersonaViewState, threadId: string, seq: number): PersonaViewState {
  if (seq <= (view.lastViewed[threadId] ?? 0)) return view;
  return { ...view, lastViewed: { ...view.lastViewed, [threadId]: seq } };
}

/** The newest seq known for a thread: its summary's last message or its held rows. */
function knownTailSeq(view: PersonaViewState, threadId: string): number {
  const summary = view.threads.find((t) => t.id === threadId);
  const held = threadId === view.threadId ? view.messages : view.others[threadId]?.messages;
  return Math.max(summary?.lastMessage?.seq ?? 0, held ? maxSeq(held) : 0);
}

/** Makes `threadId` the selected thread, parking the current one's buffer. */
function selectThread(view: PersonaViewState, threadId: string): PersonaViewState {
  if (view.threadId === threadId) return view;
  const others = { ...view.others };
  if (view.threadId) others[view.threadId] = { messages: view.messages, outbox: view.outbox };
  const incoming = others[threadId] ?? { messages: [], outbox: [] };
  delete others[threadId];
  const next: PersonaViewState = {
    ...view,
    threadId,
    messages: incoming.messages,
    outbox: incoming.outbox,
    others,
    // The backfill answers the previous thread's filter.
    backfill: undefined,
  };
  return markViewed(next, threadId, knownTailSeq(next, threadId));
}

/** Applies `fn` to the outbox of every thread, selected or not. */
function mapOutboxes(
  view: PersonaViewState,
  fn: (outbox: PersonaOutboxItem[]) => PersonaOutboxItem[]
): PersonaViewState {
  const outbox = fn(view.outbox);
  let others = view.others;
  for (const [id, buffer] of Object.entries(view.others)) {
    const next = fn(buffer.outbox);
    if (next !== buffer.outbox) {
      if (others === view.others) others = { ...view.others };
      others[id] = { ...buffer, outbox: next };
    }
  }
  if (outbox === view.outbox && others === view.others) return view;
  return { ...view, outbox, others };
}

function mapOutboxItem(
  outbox: PersonaOutboxItem[],
  key: string,
  fn: (item: PersonaOutboxItem) => PersonaOutboxItem
): PersonaOutboxItem[] {
  return outbox.some((o) => o.idempotencyKey === key)
    ? outbox.map((o) => (o.idempotencyKey === key ? fn(o) : o))
    : outbox;
}

function dropOutboxItem(outbox: PersonaOutboxItem[], key: string): PersonaOutboxItem[] {
  return outbox.some((o) => o.idempotencyKey === key)
    ? outbox.filter((o) => o.idempotencyKey !== key)
    : outbox;
}

/**
 * `incoming` with the caller-relative fields of `held` carried over where it
 * has none: a `persona:state` frame is the Persona's state alone, and must not
 * drop what `GET /state` said about this viewer.
 */
function keepCallerFields(held: PersonaState | null, incoming: PersonaState): PersonaState {
  const kept = callerFields(held);
  const fresh = callerFields(incoming);
  const merged: PersonaState & PersonaCallerFields = { ...incoming };
  if (fresh.hostAlias === undefined && kept.hostAlias !== undefined) merged.hostAlias = kept.hostAlias;
  if (fresh.isHost === undefined && kept.isHost !== undefined) merged.isHost = kept.isHost;
  if (fresh.canWrite === undefined && kept.canWrite !== undefined) merged.canWrite = kept.canWrite;
  return merged;
}

function applyState(view: PersonaViewState, incoming: PersonaState): PersonaViewState {
  // Another user's Persona state (a frame meant for its own viewer) never
  // replaces this viewer's.
  if (view.state && incoming.owner && view.state.owner && incoming.owner !== view.state.owner) return view;
  const adopting = !view.threadId;
  const state = keepCallerFields(view.state, incoming);
  // A user with no running Persona gets a synthesized idle state whose console
  // thread doesn't exist until the first write: keep what's known.
  const consoleThreadId = state.threadId || view.consoleThreadId || null;
  const disabled = state.runState === "disabled";
  const next: PersonaViewState = {
    ...view,
    state,
    signInNeeded: callerFields(incoming).canWrite === true ? false : view.signInNeeded,
    threadId: view.threadId || consoleThreadId,
    consoleThreadId,
    activity: state.runState === "thinking" ? view.activity : null,
    disabledReason: disabled ? view.disabledReason : undefined,
    unavailable: disabled ? view.unavailable : undefined,
  };
  if (!adopting) return next;
  // The rows stashed before a thread was selected never touched the thread
  // list; fold them in now that there is a selection to compare against.
  return markSelectedViewed(touchThreads(adoptSelected(next), heldRows(view)));
}

function applyFrame(view: PersonaViewState, message: WsMessage): PersonaViewState {
  switch (message.type) {
    case "persona:message": {
      const m = message.payload as PersonaMessage;
      // A re-publish (a tag edit) of a message older than the loaded window
      // that isn't held: nothing on screen shows it, and adding it would open
      // a hole the catch-up would read the whole span to fill.
      const start = windowStartSeq(view, m.threadId);
      if (start !== null && m.seq < start && !holdsMessage(view, m)) return view;
      // The same for a thread nothing is loaded for yet, when the frame is
      // older than its newest message (an answered question re-published):
      // the thread's first page brings it, without a hole to fill.
      if (start === null && m.threadId !== view.threadId && !holdsMessage(view, m)) {
        const tail = view.threads.find((t) => t.id === m.threadId)?.lastMessage?.seq;
        if (tail !== undefined && m.seq < tail) return view;
      }
      return applyMessages(view, [m]);
    }
    case "persona:state":
      return applyState(view, message.payload as PersonaState);
    case "persona:job": {
      const jobs = upsertJob(view.jobs, message.payload as PersonaJob);
      return jobs === view.jobs ? view : { ...view, jobs };
    }
    case "persona:approval": {
      const approvals = upsertApproval(view.approvals, message.payload as PersonaApproval);
      return approvals === view.approvals ? view : { ...view, approvals };
    }
    case "persona:activity":
      return { ...view, activity: message.payload as PersonaActivity };
    default:
      return view;
  }
}

/**
 * The view with what was painted from the kept view taken out: its messages,
 * its cards and its state, so the answering snapshot lays down the server's
 * own. Rows and cards that arrived live since stay. When the server's thread
 * isn't the kept one, nothing of the kept thread stays.
 */
function withoutCached(view: PersonaViewState, snapshot: PersonaSnapshot): PersonaViewState {
  const cached = view.cached;
  if (!cached) return view;
  const threadId = snapshot.messages?.threadId;
  const sameThread = threadId === undefined || threadId === view.threadId;
  // What a read that failed didn't answer stays as kept until one does; a
  // refusal answers for all of it.
  const refused = snapshot.forbidden !== undefined || snapshot.disabledReason !== undefined;
  const stateAnswered = refused || snapshot.state !== undefined;
  const cardsAnswered = refused || snapshot.pendingApprovals !== undefined;
  return {
    ...view,
    cached: undefined,
    state: cached.stateLive || !stateAnswered ? view.state : null,
    threadId: sameThread ? view.threadId : null,
    consoleThreadId: sameThread ? view.consoleThreadId : null,
    messages: sameThread ? view.messages.filter((m) => !cached.messageIds.has(m.id)) : [],
    approvals: cardsAnswered ? view.approvals.filter((a) => !cached.approvalIds.has(a.id)) : view.approvals,
  };
}

/**
 * The kept-view marks with what a live frame just rewrote taken off: the row,
 * card or state the frame carried is the server's word now, so the first
 * snapshot must weigh it as live (merging over it) rather than drop it.
 */
function liveOverCached(cached: NonNullable<PersonaViewState["cached"]>, message: WsMessage): PersonaViewState["cached"] {
  const without = (ids: ReadonlySet<string>, id: string | undefined) => {
    if (!id || !ids.has(id)) return ids;
    const next = new Set(ids);
    next.delete(id);
    return next;
  };
  switch (message.type) {
    case "persona:message":
      return { ...cached, messageIds: without(cached.messageIds, (message.payload as PersonaMessage).id) };
    case "persona:approval":
      return { ...cached, approvalIds: without(cached.approvalIds, (message.payload as PersonaApproval).id) };
    case "persona:state":
      return { ...cached, stateLive: true };
    default:
      return cached;
  }
}

function isPersonaFrame(message: WsMessage): boolean {
  return message.type.startsWith("persona:");
}

export function personaReducer(view: PersonaViewState, action: PersonaAction): PersonaViewState {
  switch (action.type) {
    case "snapshot": {
      const { snapshot, superseded } = action;
      // A newer read's refusal or disabled word stands over an older read's rows.
      if (superseded && (view.forbidden || view.disabledReason)) return view;
      // Frames landed after these requests started: what's held may be newer
      // than the response, so only add to it.
      const fresh = action.frameMark === view.frames;
      // The server answered for the thread (or refused it): what was painted
      // from the kept view gives way. A read that failed keeps it on screen,
      // still marked kept, under the load error.
      const answered = snapshot.messages !== undefined || snapshot.forbidden !== undefined || snapshot.disabledReason !== undefined;
      const base = view.cached && answered ? withoutCached(view, snapshot) : view;
      let next: PersonaViewState = superseded
        ? { ...base, loaded: true }
        : {
            ...base,
            loaded: true,
            loadError: snapshot.loadError,
            forbidden: snapshot.forbidden,
            forbiddenReason: snapshot.forbidden ? snapshot.forbiddenReason : undefined,
          };
      // A superseded read leaves whether Persona is on to the newer read.
      if (!superseded && snapshot.disabledReason) {
        next.disabledReason = snapshot.disabledReason;
        next.unavailable = snapshot.unavailable === true;
      } else if (!superseded && snapshot.state && !snapshot.loadError && !view.unavailable) {
        // Persona answered as on: a refusal an earlier read met is over, even
        // when frames landed meanwhile and the state isn't applied (a fresh
        // state clears it in applyState). A capacity refusal comes only from
        // writes, so this branch leaves it to the next write to repeat.
        next.disabledReason = undefined;
        next.unavailable = undefined;
      }
      if (snapshot.state && (fresh || !next.state)) next = applyState(next, snapshot.state);
      // A list fetched before a held frame's thread existed must not clear
      // the stale flag that frame earned.
      if (snapshot.threads) next = touchThreads(applyThreads(next, snapshot.threads), heldRows(next));
      if (snapshot.messages) {
        if (!next.threadId) {
          // A user with no Persona yet gets an empty thread id; leave the
          // selection open so the first write's console thread is adopted.
          next = adoptSelected({ ...next, threadId: snapshot.messages.threadId || null });
          next = touchThreads(next, heldRows(next));
        }
        next = applyMessages(next, snapshot.messages.messages, true, true);
        // Replacing a kept view: below the server's page, only a row a live
        // frame re-published can remain, and it would stand alone above a hole.
        const pageStart = snapshot.messages.messages[0]?.seq;
        if (base !== view && pageStart !== undefined && next.threadId === snapshot.messages.threadId) {
          const kept = next.messages.filter((m) => m.seq >= pageStart);
          if (kept.length !== next.messages.length) next = { ...next, messages: kept };
        }
      }
      if (snapshot.jobs) {
        next.jobs = mergeJobs(next.jobs, snapshot.jobs);
        next.jobsLoaded = true;
      }
      next.approvals = mergeApprovalSnapshot(
        next.approvals,
        snapshot.pendingApprovals,
        snapshot.recentApprovals,
        fresh
      );
      return next;
    }
    case "frame": {
      if (!isPersonaFrame(action.message)) return view;
      const next = { ...applyFrame(view, action.message), frames: view.frames + 1 };
      if (!view.cached) return next;
      // A state frame the view refused (another owner's) leaves the kept state as kept.
      if (action.message.type === "persona:state" && next.state === view.state) return next;
      return { ...next, cached: liveOverCached(view.cached, action.message) };
    }
    case "state":
      return applyState(view, action.state);
    case "disabled":
      return { ...view, loaded: true, disabledReason: action.reason, unavailable: action.unavailable === true };
    case "forbidden":
      return { ...view, loaded: true, forbidden: action.reason, forbiddenReason: action.refusal };
    case "signInNeeded":
      return { ...view, signInNeeded: true };
    case "queue":
      return {
        ...view,
        outbox: [
          ...view.outbox,
          { ...action.item, threadId: action.item.threadId || view.threadId || undefined },
        ],
      };
    case "sent": {
      // Matched by key only: a text match here could also consume a second,
      // still-unconfirmed send of the same words.
      let next = mapOutboxes(view, (outbox) => dropOutboxItem(outbox, action.idempotencyKey));
      // A write with no thread selected landed on the console thread, which
      // the first write creates: its id is the console thread's.
      const item = view.outbox.find((o) => o.idempotencyKey === action.idempotencyKey);
      if (!view.threadId && item && !item.threadId && action.message.threadId) {
        next = {
          ...next,
          threadId: action.message.threadId,
          consoleThreadId: next.consoleThreadId || action.message.threadId,
        };
        next = touchThreads(adoptSelected(next), heldRows(next));
      }
      // A command's result card arrives with its line, as a live row too.
      next = applyMessages(next, [action.message, ...(action.also ?? [])], false);
      // A delivered quick reply answered its question; the collector's frame
      // saying so may still be on its way, and the reply no longer hides it.
      // The owner may have switched threads while it was sending.
      const replyTo = (
        item ?? Object.values(view.others).flatMap((b) => b.outbox).find((o) => o.idempotencyKey === action.idempotencyKey)
      )?.replyTo;
      if (!replyTo) return next;
      const answered = (m: PersonaMessage) =>
        m.answeredAt || !m.options ? m : { ...m, answeredAt: action.message.createdAt };
      next = patchHeldMessage(next, replyTo.messageId, answered);
      const parked = next.others[action.message.threadId];
      if (!parked) return next;
      const i = parked.messages.findIndex((m) => m.id === replyTo.messageId);
      if (i === -1 || answered(parked.messages[i]) === parked.messages[i]) return next;
      const messages = parked.messages.slice();
      messages[i] = answered(messages[i]);
      return { ...next, others: { ...next.others, [action.message.threadId]: { ...parked, messages } } };
    }
    case "sendFailed":
      return mapOutboxes(view, (outbox) =>
        mapOutboxItem(outbox, action.idempotencyKey, (o) => ({
          ...o,
          status: "failed",
          error: action.error,
        }))
      );
    case "resend":
      return mapOutboxes(view, (outbox) =>
        mapOutboxItem(outbox, action.idempotencyKey, (o) => ({
          ...o,
          status: "sending",
          error: undefined,
        }))
      );
    case "discard":
      return mapOutboxes(view, (outbox) => dropOutboxItem(outbox, action.idempotencyKey));
    case "approval": {
      const approvals = upsertApproval(view.approvals, action.approval);
      // A decision's answer is the server's word on its card, as a frame is.
      const cached = view.cached
        ? liveOverCached(view.cached, { type: "persona:approval", payload: action.approval } as WsMessage)
        : undefined;
      return approvals === view.approvals && cached === view.cached ? view : { ...view, approvals, cached };
    }
    case "select":
      return selectThread(view, action.threadId);
    case "threadMessages":
      return applyMessages(view, action.response.messages, true, true);
    case "older": {
      // A page for a thread no longer selected answers nothing on screen.
      if (action.threadId !== view.threadId) return view;
      const rows = action.messages.filter((m) => m.threadId === action.threadId);
      const next = rows.length > 0 ? applyMessages(view, rows, false, true) : view;
      if (rows.length >= action.limit) return next;
      return { ...next, oldestReached: { ...next.oldestReached, [action.threadId]: true } };
    }
    case "catchUp": {
      // Only rows not held yet: a held row may already carry a newer word
      // (a tag edit's frame) than the read that raced it.
      const unseen = action.messages.filter((m) => !holdsMessage(view, m));
      return unseen.length === 0 ? view : applyMessages(view, unseen, true, true);
    }
    case "messageUpdated": {
      // A held row changed (its tags edited): nothing in the outbox to confirm.
      // A row no longer held (its backfill dropped since) stays out, and one
      // held only in the backfill is rewritten there, so neither can open a
      // gap in the thread.
      const { id, threadId } = action.message;
      const holds = (rows: PersonaMessage[] | undefined) => rows?.some((m) => m.id === id) === true;
      if (holds(view.messages) || holds(view.others[threadId]?.messages)) {
        return applyMessages(view, [action.message], false);
      }
      if (view.backfill?.threadId === threadId && holds(view.backfill.messages)) {
        return patchHeldMessage(view, id, (m) => keepAnswered(action.message, m));
      }
      return view;
    }
    case "tagRemove":
      return patchHeldMessage(view, action.messageId, (m) =>
        messageJobIds(m).includes(action.jobId) ? withoutJobTag(m, action.jobId) : m
      );
    case "tagRestore":
      // Only the one tag comes back, onto the message as it is now: other
      // edits since the removal (another tag dropped, a source upgraded) stay.
      return patchHeldMessage(view, action.messageId, (m) => withJobTag(m, action.tag));
    case "backfill": {
      // A response for a thread no longer selected answers nothing on screen.
      if (action.threadId !== view.threadId) return view;
      // The rows are replaced, but an answer a frame brought meanwhile stays.
      const prior = new Map((view.backfill?.messages ?? []).map((m) => [m.id, m]));
      const messages = mergeMessages([], action.messages).map((m) => keepAnswered(m, prior.get(m.id)));
      return trimBackfill({ ...view, backfill: { threadId: action.threadId, key: action.key, messages } });
    }
    case "backfillClear":
      return view.backfill ? { ...view, backfill: undefined } : view;
    case "threads":
      return applyThreads(view, action.threads);
    case "viewing": {
      if (view.viewing === action.active) return view;
      return markSelectedViewed({ ...view, viewing: action.active });
    }
  }
}

/**
 * Replaces the thread list with the server's, keeping a held summary that is
 * further along (a live frame newer than the response).
 */
function applyThreads(view: PersonaViewState, incoming: PersonaThreadSummary[]): PersonaViewState {
  const held = new Map(view.threads.map((t) => [t.id, t]));
  const threads = incoming
    .map((t) => {
      const prev = held.get(t.id);
      const prevSeq = prev?.lastMessage?.seq ?? 0;
      return prev && prevSeq > (t.lastMessage?.seq ?? 0)
        ? { ...t, lastMessage: prev.lastMessage, messageCount: prev.messageCount }
        : t;
    })
    .sort((a, b) => threadActivity(b).localeCompare(threadActivity(a)));
  return { ...view, threads, threadsStale: false };
}

/** When a thread last saw activity: its last message, else its own update time. */
function threadActivity(thread: PersonaThreadSummary): string {
  const last = thread.lastMessage?.createdAt;
  return last && last > thread.updatedAt ? last : thread.updatedAt;
}

/**
 * The console thread's id: the state's, else the listed thread on the
 * console channel (the host's view of another user's Persona may have no
 * state to read it from), else null.
 */
export function consoleThreadOf(view: Pick<PersonaViewState, "consoleThreadId" | "threads">): string | null {
  return view.consoleThreadId ?? view.threads.find((t) => t.channel === "console")?.id ?? null;
}

/**
 * The switcher's rows: the console thread first (synthesized from the state
 * when the list doesn't carry it), then every other thread newest activity
 * first.
 */
export function orderThreads(
  threads: PersonaThreadSummary[],
  consoleThreadId: string | null,
  owner = ""
): PersonaThreadSummary[] {
  const rest = threads
    .filter((t) => t.id !== consoleThreadId)
    .sort((a, b) => threadActivity(b).localeCompare(threadActivity(a)));
  if (!consoleThreadId) return rest;
  const consoleRow =
    threads.find((t) => t.id === consoleThreadId) ??
    ({
      id: consoleThreadId,
      owner,
      channel: "console",
      audience: "private",
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
    } satisfies PersonaThreadSummary);
  return [consoleRow, ...rest];
}

/**
 * A thread's name in the switcher. Console is "Console"; a Slack DM is "DM";
 * a Slack channel thread uses its title (shown as `#channel` when the title
 * is a bare channel name), falling back to the channel id in its external
 * ref (`<channel>:<thread_ts>`).
 */
export function threadLabel(
  thread: Pick<PersonaThread, "channel" | "externalRef" | "title">,
  consoleThread = false
): string {
  if (consoleThread || thread.channel === "console") return "Console";
  const ref = thread.externalRef?.trim() ?? "";
  if (ref.startsWith("dm:")) return "DM";
  const title = thread.title?.trim();
  if (title) return /^[\w.-]+$/.test(title) ? `#${title}` : title;
  const channel = ref.split(":")[0];
  if (channel) return `#${channel}`;
  return "Slack thread";
}

export interface AudienceBadge {
  icon: string;
  /** Spoken in place of the icon, and shown as its tooltip. */
  label: string;
}

const AUDIENCE_BADGES: Record<PersonaAudience, AudienceBadge> = {
  private: { icon: "\u{1F512}", label: "Private: only you can read this thread" },
  shared: { icon: "\u{1F465}", label: "Shared: people in your workspace can read this thread" },
  external: { icon: "\u{1F310}", label: "External: people outside your workspace can read this thread" },
};

/**
 * Who can read a thread, as the switcher marks it. Undefined for a row
 * without a recognized audience (an older collector), which shows no badge
 * rather than a guess.
 */
export function audienceBadge(audience: PersonaAudience | undefined): AudienceBadge | undefined {
  return audience ? AUDIENCE_BADGES[audience] : undefined;
}

/**
 * The Slack channel a thread posts into, as `#name`: a channel-name title
 * (`#eng` / `eng`), else the channel id from its external ref.
 */
export function threadChannelName(thread: Pick<PersonaThread, "externalRef" | "title">): string {
  const title = thread.title?.trim();
  if (title && /^#?[\w.-]+$/.test(title)) return title.startsWith("#") ? title : `#${title}`;
  const channel = thread.externalRef?.trim().split(":")[0];
  return channel ? `#${channel}` : "this channel";
}

/**
 * The warning shown above the composer when the selected thread isn't
 * private: what's typed there is posted to the Slack channel, where others
 * read it. Undefined for private threads (the console and DMs).
 */
export function composerAudienceWarning(
  thread: Pick<PersonaThread, "audience" | "externalRef" | "title"> | undefined
): string | undefined {
  if (!thread || (thread.audience !== "shared" && thread.audience !== "external")) return undefined;
  const base = `Replies here are posted to ${threadChannelName(thread)} and visible to others in it`;
  return thread.audience === "external" ? `${base}, including people outside your workspace.` : `${base}.`;
}

/** The selected thread's header: its name and who can read it. */
export function threadHeaderLabel(
  thread: Pick<PersonaThread, "audience" | "channel" | "externalRef" | "title">,
  consoleThread = false
): string {
  const name = threadLabel(thread, consoleThread);
  if (consoleThread || thread.channel === "console") return name;
  if (thread.audience === "external") return `${name} · External — people outside your workspace can read it`;
  if (thread.audience === "shared") return `${name} · Shared — everyone in the channel can read it`;
  if (thread.audience === "private") return `${name} · Private`;
  return name;
}

/** A one-line preview of a thread's last message, prefixed "You:" for the owner's own. */
export function threadPreview(thread: PersonaThreadSummary, max = 80): string {
  const last = thread.lastMessage;
  if (!last) return "";
  const body = last.text.replace(/\s+/g, " ").trim();
  const clipped = body.length > max ? `${body.slice(0, max - 1)}…` : body;
  return last.role === "user" ? `You: ${clipped}` : clipped;
}

/**
 * Whether a thread has a message the owner hasn't seen: a non-owner message
 * newer than the last one viewed there. The selected thread never reads as
 * unread while it is on screen.
 */
export function isThreadUnread(
  thread: PersonaThreadSummary,
  view: Pick<PersonaViewState, "lastViewed" | "threadId" | "viewing">
): boolean {
  if (view.viewing && thread.id === view.threadId) return false;
  const last = thread.lastMessage;
  if (!last || last.role === "user") return false;
  return last.seq > (view.lastViewed[thread.id] ?? 0);
}

const LAST_VIEWED_KEY = "standup:personaLastViewed";

/** The persisted last-viewed seqs, `{}` when absent or unreadable. */
export function loadLastViewed(storage: Pick<Storage, "getItem"> | undefined): Record<string, number> {
  try {
    const raw = storage?.getItem(LAST_VIEWED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveLastViewed(
  storage: Pick<Storage, "setItem"> | undefined,
  lastViewed: Record<string, number>
): void {
  try {
    storage?.setItem(LAST_VIEWED_KEY, JSON.stringify(lastViewed));
  } catch {
    // Storage full or blocked: unread dots just reset next load.
  }
}

/**
 * Messages a snapshot or an older page reads at a time: enough to fill the
 * thread on screen, few enough to fetch and render at once on open.
 */
export const PERSONA_PAGE = 50;

/**
 * The messages route for a thread's latest `limit` messages; the bare route
 * serves the console thread.
 */
export function messagesPath(threadId?: string | null, limit?: number): string {
  const params = [
    ...(threadId ? [`threadId=${encodeURIComponent(threadId)}`] : []),
    ...(limit !== undefined ? [`limit=${limit}`] : []),
  ];
  return params.length > 0 ? `/messages?${params.join("&")}` : "/messages";
}

/**
 * The first-paint snapshot's reads, which index.html starts before the bundle
 * downloads (into `window.__standupBoot`, by URL). The two lists must match.
 */
export const BOOT_READS = [
  "/api/persona/state",
  `/api/persona${messagesPath(null, PERSONA_PAGE)}`,
  "/api/persona/approvals?status=pending",
] as const;

/**
 * `fetchFn` answering a GET that index.html already started with that
 * response, each one once; a boot read that failed is made again.
 */
export function withBootReads(
  fetchFn: FetchFn,
  boot: Record<string, Promise<Response>> | undefined = (globalThis as { __standupBoot?: Record<string, Promise<Response>> })
    .__standupBoot
): FetchFn {
  return (input, init) => {
    const started = boot?.[input];
    if (!started || (init?.method ?? "GET") !== "GET") return fetchFn(input, init);
    delete boot![input];
    return started.catch(() => fetchFn(input, init));
  };
}

/** The page of `threadId`'s messages just older than `beforeSeq`. */
export function olderMessagesPath(threadId: string, beforeSeq: number, limit = PERSONA_PAGE): string {
  const params = new URLSearchParams({ threadId, beforeSeq: String(beforeSeq), limit: String(limit) });
  return `/messages?${params.toString()}`;
}

/**
 * Whether the selected thread may hold messages older than those loaded: a
 * thread's seqs start at 1 and run without gaps, so a window starting past 1
 * has more above it, unless an older read already came back short.
 */
export function hasOlderMessages(view: Pick<PersonaViewState, "threadId" | "messages" | "oldestReached" | "cached">): boolean {
  const first = view.messages[0];
  // A kept view pages nothing until the server's page replaces it.
  if (!view.threadId || !first || view.cached) return false;
  return first.seq > 1 && !view.oldestReached[view.threadId];
}

const SNAPSHOT_CACHE_KEY = "standup:personaSnapshot:v1";

/** What the console keeps of the last Persona view, to paint the next open with. */
export interface PersonaCache {
  state: PersonaState;
  threadId: string;
  consoleThreadId: string | null;
  /** The thread's newest messages, ascending. */
  messages: PersonaMessage[];
  /** The pending approvals, for the cards those messages carry. */
  approvals: PersonaApproval[];
}

/**
 * The view to open with: the last one this browser saw, marked `cached` until
 * the first snapshot replaces it, or the empty initial view when none is kept
 * (or it doesn't parse).
 */
export function personaViewFromCache(
  storage: Pick<Storage, "getItem"> | undefined,
  lastViewed: Record<string, number>
): PersonaViewState {
  const empty = { ...initialPersonaViewState, lastViewed };
  try {
    const raw = storage?.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) return empty;
    const c = JSON.parse(raw) as Partial<PersonaCache>;
    if (!c || typeof c.threadId !== "string" || !c.state || typeof c.state !== "object") return empty;
    if (!Array.isArray(c.messages) || !Array.isArray(c.approvals)) return empty;
    const messages = c.messages.filter((m) => m && m.threadId === c.threadId && typeof m.seq === "number");
    return {
      ...empty,
      loaded: true,
      cached: { messageIds: new Set(messages.map((m) => m.id)), approvalIds: new Set(c.approvals.map((a) => a.id)) },
      state: c.state,
      threadId: c.threadId,
      consoleThreadId: c.consoleThreadId ?? null,
      messages: mergeMessages([], messages),
      approvals: c.approvals,
    };
  } catch {
    return empty;
  }
}

/**
 * Keeps the view's newest page and pending cards for the next open. Only a
 * confirmed view of the console thread is kept; a refused, disabled or
 * signed-out one removes what was kept, so it can't paint next time.
 */
export function savePersonaCache(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, view: PersonaViewState): void {
  try {
    if (view.forbidden || view.disabledReason || needsSignIn(view)) {
      storage?.removeItem(SNAPSHOT_CACHE_KEY);
      return;
    }
    if (view.cached || !view.loaded || !view.state || !view.threadId || view.threadId !== view.consoleThreadId) return;
    const cache: PersonaCache = {
      state: view.state,
      threadId: view.threadId,
      consoleThreadId: view.consoleThreadId,
      messages: view.messages.slice(-PERSONA_PAGE),
      approvals: view.approvals.filter((a) => a.status === "pending"),
    };
    storage?.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the next open waits on the network instead,
    // rather than painting an ever older view.
    try {
      storage?.removeItem(SNAPSHOT_CACHE_KEY);
    } catch {
      // Blocked outright: nothing was kept.
    }
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Shown when `GET /state` reports `disabled` but no route supplied its own reason. */
const DISABLED_FALLBACK = "Persona is disabled (STANDUP_PERSONA=0)";

export interface PersonaCallResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /** The collector answered 503 with its JSON error: Persona is disabled on it, or (`unavailable`) can't run this user's. */
  disabled?: boolean;
  /** The 503 carried reason `unavailable`: Persona is on but the host is at capacity. */
  unavailable?: boolean;
  /** The route answered 401 (no trusted identity) or 403. */
  forbidden?: boolean;
  /** The refusal's `reason`, when the server sent a known one. */
  reason?: PersonaRefusal;
}

/** The `reason` a 503 body carries when Persona is on but can't run the caller's. */
function isUnavailable(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { reason?: unknown }).reason === "unavailable";
}

/**
 * Header a collector sets on the 503 it answers while draining for a restart.
 * Mirrors `DRAINING_HEADER` in `@standup/shared/topology`, which is node-only
 * and can't be imported here.
 */
export const DRAINING_HEADER = "x-standup-draining";

/**
 * Whether a 503 is a draining collector's (`{"error":"draining"}`, with
 * DRAINING_HEADER): it is about to hand over to its successor, so the read
 * failed and is retried; it says nothing about whether Persona is on.
 */
function isDrainingResponse(res: Response, body: unknown): boolean {
  if (res.headers.get(DRAINING_HEADER)) return true;
  return typeof body === "object" && body !== null && (body as { error?: unknown }).error === "draining";
}

/**
 * One call to a `/api/persona` route. Never throws: a network failure comes
 * back as `status: 0` with the error, and a non-2xx carries the server's
 * `error` field when it sent one.
 */
export async function personaCall<T>(
  path: string,
  init?: { method?: string; body?: unknown },
  fetchFn: FetchFn = fetch
): Promise<PersonaCallResult<T>> {
  try {
    const method = init?.method ?? "GET";
    // Every write carries a JSON body, even a bodyless action like pause: the
    // collector refuses Persona writes that aren't `application/json`, which is
    // what keeps a cross-site form post from driving Persona.
    const body = method === "GET" ? undefined : JSON.stringify(init?.body ?? {});
    const res = await fetchFn(`/api/persona${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body,
    });
    const data = (await res.json().catch(() => undefined)) as
      | (T & { error?: string })
      | undefined;
    if (res.ok) return { ok: true, status: res.status, data };
    // 401 is the collector's `unauthenticated` refusal (no trusted identity);
    // it reads like a 403 so the view shows why rather than a load error.
    const forbidden = res.status === 401 || res.status === 403;
    const reason = forbidden ? refusalReason(data) : undefined;
    // Only the collector's own 503 (a JSON error) means Persona is off; one from
    // a proxy or tunnel in front of a restarting collector, or from a draining
    // collector itself, is a failed read.
    const disabled = res.status === 503 && typeof data?.error === "string" && !isDrainingResponse(res, data);
    return {
      ok: false,
      status: res.status,
      error: data?.error ?? `Request failed (${res.status})`,
      disabled,
      ...(disabled && isUnavailable(data) ? { unavailable: true } : {}),
      forbidden,
      ...(reason ? { reason } : {}),
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The REST equivalent of a Persona snapshot: state, the selected thread (the
 * console thread by default), the thread list, jobs, pending approvals and
 * recent approvals, fetched together. A collection whose request
 * failed is left out so what's on screen is kept rather than blanked.
 *
 * With `user`, the host's read-only view of that user's Persona: every
 * collection carries `?user=<alias>`. Its state is asked for the same way and
 * kept only when it names that user (a collector that doesn't take `?user` on
 * `/state` answers with the host's own); without it the view finds the
 * console thread in the thread list (see `consoleThreadOf`).
 */
export async function fetchPersonaSnapshot(
  fetchFn: FetchFn = fetch,
  threadId?: string | null,
  user?: string | null,
  opts: { firstPaint?: boolean } = {}
): Promise<PersonaSnapshot> {
  // The first paint needs only the thread and the cards it can decide; the
  // jobs, card history and thread list are left to the full snapshot after.
  const skipped = Promise.resolve(undefined);
  const [rawState, messages, jobs, pending, approvals, threads] = await Promise.all([
    personaCall<PersonaState>(withUser("/state", user), undefined, fetchFn),
    // The host's read-only view of a user pages nothing older, so it keeps
    // the server's longer default window.
    personaCall<PersonaMessagesResponse>(withUser(messagesPath(threadId, user ? undefined : PERSONA_PAGE), user), undefined, fetchFn),
    opts.firstPaint ? skipped : personaCall<{ jobs: PersonaJob[] }>(withUser("/jobs", user), undefined, fetchFn),
    personaCall<{ approvals: PersonaApproval[] }>(withUser("/approvals?status=pending", user), undefined, fetchFn),
    opts.firstPaint ? skipped : personaCall<{ approvals: PersonaApproval[] }>(withUser("/approvals", user), undefined, fetchFn),
    opts.firstPaint ? skipped : personaCall<{ threads: PersonaThreadSummary[] }>(withUser("/threads", user), undefined, fetchFn),
  ]);
  const state: PersonaCallResult<PersonaState> =
    user && !(rawState.ok && rawState.data?.owner === user) ? { ok: false, status: 0 } : rawState;
  // A user whose Persona has never run has no console thread yet, so the bare
  // messages route may answer 404: that's an empty thread, not a failure.
  const noConsoleThread = !threadId && messages.status === 404;
  const candidates: (PersonaCallResult<unknown> | undefined)[] = noConsoleThread
    ? [jobs, pending, approvals]
    : [messages, jobs, pending, approvals];
  const reads = candidates.filter((r): r is PersonaCallResult<unknown> => r !== undefined);
  const results: PersonaCallResult<unknown>[] = user ? reads : [state, ...reads];
  const disabled = results.find((r) => r.disabled);
  const forbidden = results.find((r) => r.forbidden);
  const failed = results.find((r) => !r.ok && !r.disabled && !r.forbidden);
  // The thread list is an extra: a collector without the route (404) or a
  // failed fetch leaves the switcher as it was and reports nothing.
  return {
    state: state.ok ? state.data : undefined,
    messages: messages.ok ? messages.data : undefined,
    threads: threads?.ok && Array.isArray(threads.data?.threads) ? threads.data.threads : undefined,
    jobs: jobs?.ok ? jobs.data?.jobs : undefined,
    pendingApprovals: pending.ok ? pending.data?.approvals : undefined,
    recentApprovals: approvals?.ok ? approvals.data?.approvals : undefined,
    disabledReason:
      disabled?.error ?? (state.data?.runState === "disabled" ? DISABLED_FALLBACK : undefined),
    ...(disabled?.unavailable ? { unavailable: true } : {}),
    loadError: failed ? failed.error : undefined,
    forbidden: forbidden ? (forbidden.error ?? "Persona refused this viewer") : undefined,
    forbiddenReason: forbidden?.reason,
  };
}

/** Waits between retries of a Persona resync whose reads failed: 1 s doubling to 15 s. */
export const PERSONA_SYNC_RETRY_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000];

/**
 * Fetches a Persona snapshot and applies it, retrying while its reads fail
 * outright. A collector that just restarted can take the socket's reconnect
 * (and its hello-ok) before its HTTP routes answer, and a resync lost to that
 * one 5xx would leave everything Persona posted during the outage off screen
 * until a reload. Each attempt is applied, so the error banner shows while it
 * lasts and a later success clears it. Stops when a snapshot loads (or is
 * refused, which a retry won't change), when the retries run out, or once
 * `current()` reports a newer resync took over. Resolves whether one loaded.
 */
export async function syncPersonaSnapshot(opts: {
  fetchSnapshot: () => Promise<PersonaSnapshot>;
  apply: (snapshot: PersonaSnapshot, frameMark: number) => void;
  frameMark: () => number;
  current: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  retryMs?: readonly number[];
}): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryMs = opts.retryMs ?? PERSONA_SYNC_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    const frameMark = opts.frameMark();
    const snapshot = await opts.fetchSnapshot();
    if (!opts.current()) return false;
    opts.apply(snapshot, frameMark);
    if (!snapshot.loadError) return true;
    if (attempt >= retryMs.length) return false;
    await sleep(retryMs[attempt]!);
    if (!opts.current()) return false;
  }
}

/** Rows one catch-up read asks for. */
export const CATCH_UP_PAGE = 100;
/** Reads one catch-up makes at most before leaving the rest to the next. */
export const CATCH_UP_MAX_PAGES = 5;
/** How long one catch-up read may take. */
export const CATCH_UP_READ_TIMEOUT_MS = 10_000;

/**
 * The read a catch-up makes for `threadId`: the rows after `afterSeq`, oldest
 * first; with no `afterSeq` (nothing held yet), the newest page.
 */
export function catchUpPath(threadId: string, afterSeq: number | null, limit = CATCH_UP_PAGE): string {
  const params = new URLSearchParams({ threadId, limit: String(limit) });
  if (afterSeq !== null) params.set("afterSeq", String(afterSeq));
  return `/messages?${params.toString()}`;
}

/**
 * Where a catch-up reads from in `messages` (ascending): the seq before the
 * first hole, else the newest. A thread's seqs run without gaps (each is the
 * previous MAX + 1), so a hole in the held run is a message whose frame was
 * lost while a later one arrived — the reply lost before the owner's next
 * send came back on its POST, say.
 */
export function catchUpFromSeq(messages: PersonaMessage[]): number {
  for (let i = 0; i + 1 < messages.length; i++) {
    if (messages[i + 1]!.seq !== messages[i]!.seq + 1) return messages[i]!.seq;
  }
  return maxSeq(messages);
}

/**
 * Reads the selected thread's messages from the first hole in what's held (or
 * after the newest) and applies them, so a message whose frame the live
 * socket lost shows without a reload. One small read in the common case
 * (nothing new); a run longer than a page is read on, up to
 * CATCH_UP_MAX_PAGES. Stops when the view moves to another thread. A read
 * that found a message the view didn't hold means frames went missing, so
 * `onMissed` is called (the socket may be dead) and `resync` runs: the cards,
 * jobs and tag edits lost alongside it come back too. A view whose last
 * resync failed (its retries ran out), or that shows a refusal when
 * `refusedResyncDue` allows, runs `resync` first, so a refusal a restarting
 * collector caused can't stop the catch-up for good. `resync` should be
 * one attempt that resolves whether a snapshot loaded: the next catch-up is
 * its retry. Each read gives up after
 * CATCH_UP_READ_TIMEOUT_MS, so a request stuck on a dead pooled connection
 * can't hold the catch-up off. Resolves whether the reads succeeded.
 */
export async function catchUpPersonaThread(opts: {
  view: () => PersonaViewState;
  apply: (messages: PersonaMessage[]) => void;
  resync: () => Promise<unknown>;
  /**
   * Whether a view showing a refusal (Persona disabled, or this viewer
   * refused) should resync now to see if it still holds; default always.
   */
  refusedResyncDue?: () => boolean;
  fetchFn?: FetchFn;
  onMissed?: () => void;
  /**
   * Called once the run is over when the collector answered it: a messages
   * read came back, or `resync` resolved `true` (a snapshot loaded). Not
   * called for a run that made no request.
   */
  onAnswered?: () => void;
  pageSize?: number;
  maxPages?: number;
  readTimeoutMs?: number;
}): Promise<boolean> {
  const pageSize = opts.pageSize ?? CATCH_UP_PAGE;
  const maxPages = opts.maxPages ?? CATCH_UP_MAX_PAGES;
  const baseFetch = opts.fetchFn ?? fetch;
  const readTimeoutMs = opts.readTimeoutMs ?? CATCH_UP_READ_TIMEOUT_MS;
  const fetchFn: FetchFn = (input, init) => baseFetch(input, { ...init, signal: AbortSignal.timeout(readTimeoutMs) });
  let resynced = false;
  let answered = false;
  const done = (ok: boolean): boolean => {
    if (answered) opts.onAnswered?.();
    return ok;
  };
  const before = opts.view();
  // A capacity refusal (`unavailable`) comes from writes alone: no read can say it ended.
  const refused = !!((before.disabledReason && !before.unavailable) || before.forbidden);
  if (before.loadError || (refused && (opts.refusedResyncDue?.() ?? true))) {
    if ((await opts.resync()) === true) answered = true;
    resynced = true;
  }
  const start = opts.view();
  const threadId = start.threadId;
  if (!start.loaded || !threadId || start.disabledReason || start.forbidden) return done(!start.loadError);
  let afterSeq: number | null = start.messages.length > 0 ? catchUpFromSeq(start.messages) : null;
  let missed = false;
  for (let page = 0; page < maxPages; page++) {
    const res = await personaCall<PersonaMessagesResponse>(catchUpPath(threadId, afterSeq, pageSize), undefined, fetchFn);
    if (!res.ok || !Array.isArray(res.data?.messages)) return done(false);
    answered = true;
    const view = opts.view();
    if (view.threadId !== threadId) return done(true);
    const rows = res.data.messages.filter((m) => m.threadId === threadId);
    if (rows.some((m) => !holdsMessage(view, m))) missed = true;
    if (rows.length > 0) opts.apply(rows);
    // The newest page answers a view that held nothing; anything newer than it came live.
    if (afterSeq === null || rows.length < pageSize) break;
    afterSeq = maxSeq(rows);
  }
  if (missed) {
    opts.onMissed?.();
    if (!resynced) await opts.resync();
  }
  return done(true);
}

/**
 * A fresh idempotency key for a send. `crypto.randomUUID` only exists in
 * secure contexts, and a teammate reaching the console over plain-http
 * tunnel has none, so fall back to time + randomness.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
