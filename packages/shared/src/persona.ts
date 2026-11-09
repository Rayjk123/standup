// ============================================================================
// Persona — the always-on orchestrator agent.
//
// One persistent agent per owner that the human talks to instead of picking a
// project and a session. It turns requests into jobs, delegates each job to
// ordinary worker sessions, wakes on their events, handles what policy lets it,
// and escalates the rest. These are the wire contracts shared by the collector
// (state + REST + WS), the MCP proxy, and the web console.
//
// Timestamps are ISO-8601 strings (they cross the wire as JSON).
// ============================================================================

import type { PersonaJobView } from "./job-state.js";
import type { PersonaMessageNotify } from "./notify.js";
import type { PersonaMessageCommand } from "./persona-commands.js";
import type { PersonaJobBudget } from "./job-budget.js";
import type { PipelineOverride } from "./pipeline.js";

/** Who authored a message in a Persona thread. */
export type PersonaMessageRole = "user" | "persona" | "system";

/**
 * How a message came to be tagged with a job, strongest first. `explicit`:
 * the owner picked the job (a "re job" reply) or the message was created
 * about it. `declared`: Persona tagged its own reply (`tag_reply`).
 * `inferred`: derived from the turn's actions or mentions; the owner may
 * remove it. A tag is only ever upgraded toward `explicit`, never downgraded.
 */
export type PersonaJobTagSource = "explicit" | "declared" | "inferred";

/** One job a message is tagged with. */
export interface PersonaMessageJobTag {
  jobId: string;
  source: PersonaJobTagSource;
}

export interface PersonaMessage {
  id: string;
  threadId: string;
  /** Monotonic per thread, 1-based. */
  seq: number;
  role: PersonaMessageRole;
  /** Markdown body. */
  text: string;
  /** Alias of the human who sent a `user` message. */
  actor?: string;
  /**
   * Quick replies offered with a Persona question (`ask_user`). Choosing one
   * sends its text back as an ordinary user message.
   */
  options?: string[];
  /** The index in `options` Persona recommends, when it named one. */
  recommendedOption?: number;
  /**
   * When a question with `options` stopped needing an answer: the owner
   * answered it, Persona set it aside, or every job it is about closed.
   * Absent while it is open, when its quick replies stay live.
   */
  answeredAt?: string;
  /**
   * On a quick-reply tap: the id of the Persona question (a message of the
   * same thread with `options`) whose option the owner tapped.
   */
  replyToMessageId?: string;
  /**
   * Jobs this message opened or reports on, so the UI can link them: the job
   * ids of `jobTags`, in the same order.
   */
  jobIds?: string[];
  /** The message's job tags with how each was made, oldest first. */
  jobTags?: PersonaMessageJobTag[];
  /** Set on the `system` message that announces a pending approval. */
  approvalId?: string;
  /**
   * Media on the message, in the order attached: images Persona attached to a
   * reply (`attach_image`), or images and videos the owner uploaded with a
   * `user` message.
   */
  attachments?: PersonaAttachment[];
  /** The sender's dedupe key, echoed so a client can reconcile its optimistic copy. */
  idempotencyKey?: string;
  /**
   * The notification this message is: its update kind and the channels it
   * goes to beyond the console, from the owner's notification prefs. Absent
   * on a message that is no notification (a reply in a conversation).
   */
  notify?: PersonaMessageNotify;
  /**
   * The slash command this message is: the owner's `/state` line carries its
   * name and args, the result message also the result card's data. Command
   * messages are no part of the conversation — Persona's turns never see them.
   */
  command?: PersonaMessageCommand;
  createdAt: string;
}

/** The transport a thread lives on. Channels are thin; the brain is shared. */
export type PersonaChannel = "console" | "slack";

/**
 * Who can read a thread's replies. `private`: only the owner (the console, a
 * DM). `shared`: other people in the owner's workspace (a channel thread).
 * `external`: people outside it too (e.g. a Slack Connect channel). Persona
 * never carries private context, other threads' jobs, or personal memory into
 * a thread whose audience isn't private.
 */
export type PersonaAudience = "private" | "shared" | "external";

export interface PersonaThread {
  id: string;
  owner: string;
  channel: PersonaChannel;
  /** Channel-specific address (e.g. Slack `channel:thread_ts`); absent for console. */
  externalRef?: string;
  title?: string;
  /** Who can read this thread's replies; the console and DMs are private. */
  audience: PersonaAudience;
  createdAt: string;
  updatedAt: string;
}

/**
 * - `idle`: nothing queued; costs nothing.
 * - `thinking`: a turn is running.
 * - `error`: the last turn failed (see `lastError`); queued items retry with backoff.
 * - `paused`: the owner paused Persona; inbox items accumulate but no turn runs.
 * - `disabled`: turned off for this collector (STANDUP_PERSONA=0).
 */
export type PersonaRunState = "idle" | "thinking" | "error" | "paused" | "disabled";

export interface PersonaState {
  owner: string;
  runState: PersonaRunState;
  /** The owner's default console thread. */
  threadId: string;
  /** Claude session id of the current epoch; absent before the first turn or right after a rotation. */
  claudeSessionId?: string;
  /** Increments each time the conversation is rotated onto a fresh session seeded with a handoff note. */
  epoch: number;
  /** Context size observed on the last turn (input + cache tokens); drives epoch rotation. */
  lastContextTokens?: number;
  /** Inbox items waiting for a turn. */
  pendingInbox: number;
  lastTurnAt?: string;
  lastError?: string;
  /** Persona-owned launches still running, against the concurrency cap. */
  activeLaunches: number;
  maxActiveLaunches: number;
  /** The host's room for more workers; absent where the collector reports none. */
  host?: HostHeadroomView;
}

/** The host's room for workers, as Persona's budget line and the console show it. */
export interface HostHeadroomView {
  /** The active cap after host headroom: min(configured cap, running + workers the host has room for). */
  effectiveMaxActive: number;
  /** True when the host, not the configured cap, sets effectiveMaxActive. */
  hostLimited: boolean;
  /** The host reading; all of it is absent where the platform gives none. */
  memAvailableBytes?: number;
  /** The host's total RAM (`MemTotal`), next to `memAvailableBytes`. */
  memTotalBytes?: number;
  load1?: number;
  cores?: number;
  /** Persona-owned launches waiting for host room (included in activeLaunches). */
  queued: number;
}

/** "3.1 GB": binary gigabytes, as `free -h` reports them. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "3.1 GB free, load 1.2/4". */
export function formatHostReading(m: { memAvailableBytes: number; load1: number; cores: number }): string {
  return `${formatGb(m.memAvailableBytes)} free, load ${m.load1.toFixed(1)}/${m.cores}`;
}

/**
 * The active part of the budget line: running launches against the effective
 * cap, with the host reading, e.g. "active 2/3 (host-limited; 3.1 GB free,
 * load 1.2/4) · 1 queued for host room". Queued launches are counted apart
 * from running ones.
 */
export function activeBudgetLine(activeLaunches: number, maxActiveLaunches: number, host?: HostHeadroomView): string {
  if (!host) return `active ${activeLaunches}/${maxActiveLaunches}`;
  const running = Math.max(0, activeLaunches - host.queued);
  const reading =
    host.memAvailableBytes !== undefined && host.load1 !== undefined && host.cores !== undefined
      ? formatHostReading({ memAvailableBytes: host.memAvailableBytes, load1: host.load1, cores: host.cores })
      : undefined;
  const detail = host.hostLimited
    ? ` (host-limited${reading ? `; ${reading}` : ""})`
    : reading
      ? ` (host: ${reading})`
      : "";
  const queued = host.queued > 0 ? ` · ${host.queued} queued for host room` : "";
  return `active ${running}/${host.effectiveMaxActive}${detail}${queued}`;
}

export type PersonaJobStatus = "active" | "waiting_user" | "done" | "failed" | "cancelled";

/** A unit of work the owner handed Persona; delegated to one or more worker sessions. */
export interface PersonaJob {
  id: string;
  owner: string;
  threadId: string;
  title: string;
  goal: string;
  /** How Persona will know the job is done — checked before reporting success. */
  acceptance?: string;
  status: PersonaJobStatus;
  /** Launches Persona started for this job, oldest first. */
  launchIds: string[];
  /** Sessions those launches bound to (a launch binds when its session starts). */
  sessionIds: string[];
  outcome?: string;
  /**
   * Persona's latest progress note on the job (`update_job`), replaced on each
   * update; distinct from `outcome`, which records how a closed job ended.
   */
  note?: string;
  /** When `note` was last set; absent for notes written before it was tracked. */
  noteAt?: string;
  /**
   * The job's state derived from live facts (pending approvals, open
   * questions, worker sessions); see deriveJobState. Absent from older
   * collectors.
   */
  view?: PersonaJobView;
  /** The job's time and spend budget and its use; absent from older collectors. */
  budget?: PersonaJobBudget;
  /** The job's pipeline layer, over the owner's and the project's, for the job's launches (see resolvePipelineFor). */
  pipelineOverride?: PipelineOverride;
  createdAt: string;
  updatedAt: string;
}

export type PersonaApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed"
  | "expired"
  /** A newer request for the same thing replaced it, or what it would act on has moved on. */
  | "superseded";

/**
 * A Persona action the policy engine held for the owner's decision. Approving
 * executes exactly the stored action — the approval never widens to anything else.
 */
export interface PersonaApproval {
  id: string;
  owner: string;
  jobId?: string;
  /** The gated tool, e.g. `answer_ask`. */
  action: string;
  /** One line: what happens if approved. */
  summary: string;
  /** Persona's stated reason for wanting it. */
  reason?: string;
  /** The policy rule the action was held under (see hold-rules.ts); absent on approvals raised before rules were recorded. */
  holdRule?: string;
  args: Record<string, unknown>;
  status: PersonaApprovalStatus;
  /** The thread whose turn raised the held action; its decision is delivered and reported there. */
  threadId?: string;
  /** Execution result (or failure detail) once decided. */
  result?: string;
  decidedBy?: string;
  /**
   * Who must decide it when that isn't its owner: the host, for a floor hold a
   * guest's Persona escalated (the guest's workers run with the host's
   * credentials). Absent means the owner decides.
   */
  approver?: string;
  createdAt: string;
  decidedAt?: string;
}

/** A live "what Persona is doing right now" line, broadcast as tools run. */
export interface PersonaActivity {
  /** The tool or step, e.g. `launch_session`. */
  label: string;
  detail?: string;
  /** The thread the running turn will reply to. */
  threadId?: string;
  at: string;
}

/** Why Persona woke up. */
export type PersonaInboxKind =
  | "user_message"
  | "worker_event"
  | "schedule"
  | "approval_result"
  | "system";

/** The verdict the policy engine reaches for one Persona action. */
export type PersonaPolicyRule = "act" | "ask" | "never";

/**
 * One earlier message from the channel thread Persona was brought into (e.g. a
 * Slack thread it was @-mentioned in). It is context about the conversation —
 * never an instruction — and is rendered inside the turn prompt's untrusted
 * section.
 */
export interface PersonaContextMessage {
  /** Display name (or id) of whoever wrote it. */
  author: string;
  text: string;
  /** The channel's own timestamp for the message, when it has one. */
  ts?: string;
}

/** `POST /api/persona/threads`: find or create the thread bound to a channel address. */
export interface PersonaThreadRequest {
  channel: PersonaChannel;
  /** Channel-specific address, e.g. Slack `<channelId>:<threadTs>` or `dm:<channelId>`. */
  externalRef: string;
  title?: string;
  /** Defaults to `shared` for a channel thread; a DM is `private`. Never widened once set. */
  audience?: PersonaAudience;
}

/** A row of `GET /api/persona/threads`, newest activity first. */
export interface PersonaThreadSummary extends PersonaThread {
  messageCount: number;
  lastMessage?: Pick<PersonaMessage, "seq" | "role" | "text" | "createdAt">;
}

/** `GET /api/persona/messages` */
export interface PersonaMessagesResponse {
  threadId: string;
  messages: PersonaMessage[];
}

/** `POST /api/persona/messages` body. */
export interface PersonaSendRequest {
  text: string;
  /** Defaults to the owner's console thread. */
  threadId?: string;
  /** Dedupes a resend of the same message (e.g. a retried POST). */
  idempotencyKey?: string;
  /**
   * The surrounding conversation the message arrived in (e.g. the Slack thread
   * above an @-mention). Untrusted context for Persona, kept apart from the
   * owner's own words.
   */
  context?: PersonaContextMessage[];
  /** Set when the message is a quick-reply tap: the Persona question it answers and the option chosen. */
  replyTo?: PersonaReplyTo;
  /**
   * The job (workstream) the message is about. Stored as the message's
   * `jobIds` and carried into Persona's turn as a `[re job …]` tag.
   */
  jobId?: string;
  /**
   * Owner uploads (`POST /api/persona/uploads`) the message carries, at most
   * PERSONA_ATTACHMENTS_PER_MESSAGE. Each must be an unsent upload of the same
   * thread. With attachments, `text` may be empty.
   */
  attachmentIds?: string[];
}

/**
 * `POST /api/persona/uploads` body: one image or video the owner is about to
 * send. The bytes travel base64-encoded because owner writes are JSON-only.
 * The content decides the type; a `mimeType` that disagrees with it is
 * refused.
 */
export interface PersonaUploadRequest {
  /** Defaults to the owner's console thread. Must be a private thread. */
  threadId?: string;
  /** The file's name as the owner had it; only its base name is kept. */
  name: string;
  /** The type the sender declared (browser `File.type`, Slack `mimetype`), if any. */
  mimeType?: string;
  dataBase64: string;
}

/** `POST /api/persona/uploads` response (201). Errors are `{error}` with 400 or 413. */
export interface PersonaUploadResponse {
  attachment: PersonaAttachment;
}

/** The `ask_user` question a quick reply answers, and which of its options was tapped. */
export interface PersonaReplyTo {
  messageId: string;
  optionIndex: number;
}

/** One action's share of a hold-report row. */
export interface PersonaHoldReportAction {
  action: string;
  decided: number;
  approved: number;
}

/**
 * One row of the noisy-hold report: the owner's decisions on approvals held
 * under one rule. Read-only — the report suggests, it never changes policy.
 */
export interface PersonaHoldReportRow {
  holdRule: string;
  /** Some approvals in the row carried no stored rule; it was read from their reason text. */
  inferred: boolean;
  /** The rule no longer exists in the policy (see RETIRED_HOLD_RULES). */
  retired: boolean;
  /** Why the rule is never suggested for loosening, when it isn't. */
  excluded?: string;
  /** Approvals the owner decided (approved, executed, failed after approval, denied). */
  decided: number;
  approved: number;
  denied: number;
  /** approved / decided; null with no decisions. */
  approveRate: number | null;
  /** Median ms from the hold to the owner's decision; null with no timed decisions. */
  medianDecideMs: number | null;
  pending: number;
  expired: number;
  superseded: number;
  /** At least NOISY_HOLD_MIN_SAMPLES decisions, at least NOISY_HOLD_MIN_APPROVE_RATE approved, loosenable and current. */
  noisy: boolean;
  actions: PersonaHoldReportAction[];
  lastAt: string;
}

/** `GET /api/persona/hold-report` */
export interface PersonaHoldReport {
  since?: string;
  minSamples: number;
  minApproveRate: number;
  rows: PersonaHoldReportRow[];
  /** Approvals whose rule could not be stored or inferred. */
  unattributed: number;
}

/**
 * A decision Persona made on a pending knowledge draft (decide_knowledge_draft),
 * kept with its reason for the owner to audit. `GET /api/persona/knowledge-decisions`.
 */
export interface PersonaKnowledgeDecision {
  id: string;
  owner: string;
  projectId: string;
  draftSlug: string;
  /** The accepted doc the draft replaced (or would have replaced, on a reject). */
  targetSlug?: string;
  title: string;
  decision: "accept" | "reject";
  /** `new`: the draft added a doc; `replace`: it overwrote `targetSlug`. */
  mode: "new" | "replace";
  /** Persona rewrote the body before accepting; `editedBody` is what was published. */
  edited: boolean;
  editedBody?: string;
  /** Persona's stated reason. */
  reason: string;
  /** The draft's fact-check verdict when it was decided. */
  verdict?: string;
  /** The launch that proposed the draft. */
  generatedByLaunchId?: string;
  threadId?: string;
  jobId?: string;
  createdAt: string;
}

/**
 * A safety-floor hold Persona allowed once on its own (answer_ask with no
 * owner card), kept with its reason for the owner to audit. These post nothing
 * in the thread; the job drawer and the You tab list them.
 * `GET /api/persona/floor-decisions`.
 */
export interface PersonaFloorDecision {
  id: string;
  owner: string;
  askId: string;
  sessionId: string;
  jobId?: string;
  /** The thread whose turn made the decision. */
  threadId?: string;
  /** `safety_floor` or `safety_floor_owner`. */
  gate: string;
  /** The floor's category for the held call (outward, aws, destructive, …). */
  category?: string;
  /** The held call as the floor showed it. */
  call: string;
  /** Persona's stated reason. */
  reason: string;
  /** Who answered the hold, as asks.answered_by records it (`persona:<owner>`). */
  decidedBy: string;
  /** Why the advisory second check flagged the allow; absent when it flagged nothing. The call ran either way. */
  checkFlag?: string;
  createdAt: string;
}

export type PersonaCommitmentStatus = "open" | "done" | "dropped";

/**
 * Who owes a commitment's next step: Persona itself, one worker session
 * (`worker:<sessionId>`), or the owner.
 */
export type PersonaCommitmentAssignee = "persona" | "owner" | `worker:${string}`;

/**
 * One open loop in Persona's commitments ledger: a next step someone owes,
 * with a checkable condition that says it is done. The ledger is an unordered
 * set read by staleness; every Persona turn shows the open ones first.
 * `GET /api/persona/commitments`.
 */
export interface PersonaCommitment {
  id: string;
  owner: string;
  /** The thread it was opened for; a non-private thread's turns see only their own. */
  threadId?: string;
  jobId?: string;
  assignee: PersonaCommitmentAssignee;
  /** The next step, in a sentence. */
  action: string;
  /** The checkable condition that says the step is done. */
  doneCheck: string;
  status: PersonaCommitmentStatus;
  /** `persona` when Persona opened it; `auto` when the collector did on a transition. */
  source: "persona" | "auto";
  /** The transition an auto-opened commitment is keyed to (one open row per key). */
  autoKey?: string;
  openedAt: string;
  /** When it goes stale (overdue, for one Persona owes); absent never goes stale. */
  staleAfter?: string;
  closedAt?: string;
  /** How the done-check was verified (done), or why it was dropped. */
  closedEvidence?: string;
  /** When the collector last woke Persona about it being overdue. */
  nudgedAt?: string;
  /** The ask_user question Persona escalated it with; the owner holds it until they reply. */
  holdMessageId?: string;
}

/**
 * Text Persona ends a turn with when nothing needs saying to the owner. The
 * runtime drops it instead of posting it.
 */
export const PERSONA_SILENT_REPLY = "[silent]";

/** The image types Persona can attach to a reply. */
export type PersonaAttachmentMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The video types the owner can send Persona. */
export type PersonaVideoMime = "video/mp4" | "video/quicktime" | "video/webm";

/** Any media type a Persona message can carry. */
export type PersonaMediaMime = PersonaAttachmentMime | PersonaVideoMime;

/** The image types the owner can upload, in the order the console lists them. */
export const PERSONA_UPLOAD_IMAGE_MIMES: readonly PersonaAttachmentMime[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
/** The video types the owner can upload. */
export const PERSONA_UPLOAD_VIDEO_MIMES: readonly PersonaVideoMime[] = ["video/mp4", "video/quicktime", "video/webm"];

/** What is known of a video on a message: one the owner uploaded, or one Persona attached. */
export interface PersonaVideoInfo {
  /** Length in seconds, when ffmpeg could read it. */
  durationSec?: number;
  /** How many still frames were extracted for Persona to look at (none for a video Persona attached). */
  frames: number;
  /** Why there are no (or fewer) frames, e.g. "ffmpeg is not available on the collector host". */
  note?: string;
  /** Whether the collector serves a still frame to show before it plays (personaAttachmentPosterPath). */
  poster?: boolean;
}

/**
 * Media attached to a Persona message. The collector keeps its own copy of
 * the file; clients fetch it by `id` (personaAttachmentPath), never by path.
 */
export interface PersonaAttachment {
  id: string;
  mimeType: PersonaMediaMime;
  /** Size of the stored copy in bytes. */
  bytes: number;
  /** The source file's base name, used as the download and Slack upload name. */
  name: string;
  caption?: string;
  /** Set on a video. */
  video?: PersonaVideoInfo;
}

/** True for an image attachment type. */
export function isPersonaImageMime(mime: string): mime is PersonaAttachmentMime {
  return (PERSONA_UPLOAD_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** True for a video attachment type. */
export function isPersonaVideoMime(mime: string): mime is PersonaVideoMime {
  return (PERSONA_UPLOAD_VIDEO_MIMES as readonly string[]).includes(mime);
}

/** The data-dir subdirectory holding every attachment's stored copy. */
export const PERSONA_ATTACHMENTS_DIRNAME = "persona-attachments";

/** Largest image Persona may attach, or the owner may upload, in bytes. */
export const PERSONA_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Largest video the owner may upload, in bytes. */
export const PERSONA_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
/** The owner upload route. */
export const PERSONA_UPLOADS_PATH = "/api/persona/uploads";
/**
 * Largest request body the upload route takes: the largest video as base64
 * plus room for the JSON around it.
 */
export const PERSONA_UPLOAD_BODY_MAX_BYTES = Math.ceil(PERSONA_VIDEO_MAX_BYTES / 3) * 4 + 64 * 1024;
/** Still frames extracted from an uploaded video for Persona to look at. */
export const PERSONA_VIDEO_FRAMES = 5;
/** Most images one Persona reply may carry, or attachments one owner message may. */
export const PERSONA_ATTACHMENTS_PER_MESSAGE = 4;
/** Most videos one Persona reply may carry, beside its images. */
export const PERSONA_VIDEOS_PER_REPLY = 1;
/** Longest attachment caption, in characters. */
export const PERSONA_ATTACHMENT_CAPTION_CHARS = 300;
/**
 * Largest `STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB` taken, and the most the Slack
 * bridge fetches of a video: the collector reads and hashes a video whole, so
 * it is held well under Slack's own 1 GB per-file limit.
 */
export const PERSONA_ATTACH_VIDEO_CEILING_BYTES = 250 * 1024 * 1024;
/** Smallest `STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB` taken. */
const PERSONA_ATTACH_VIDEO_FLOOR_BYTES = 1024 * 1024;

/**
 * Largest video Persona may attach to a reply, in bytes:
 * `STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB` (a positive number of MB, held to
 * 1–250) when set, else PERSONA_VIDEO_MAX_BYTES.
 */
export function personaAttachVideoMaxBytes(env: Record<string, string | undefined>): number {
  const mb = Number.parseFloat(env.STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB?.trim() ?? "");
  if (!Number.isFinite(mb) || mb <= 0) return PERSONA_VIDEO_MAX_BYTES;
  const bytes = Math.floor(mb * 1024 * 1024);
  return Math.min(Math.max(bytes, PERSONA_ATTACH_VIDEO_FLOOR_BYTES), PERSONA_ATTACH_VIDEO_CEILING_BYTES);
}

/** The collector route serving an attachment's stored copy. */
export function personaAttachmentPath(id: string): string {
  return `/api/persona/attachments/${encodeURIComponent(id)}`;
}

/** The collector route serving a video attachment's poster frame (when `video.poster` says it has one). */
export function personaAttachmentPosterPath(id: string): string {
  return `${personaAttachmentPath(id)}/poster`;
}
