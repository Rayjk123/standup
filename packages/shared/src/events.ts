import type {
  Actor,
  Ask,
  Checkpoint,
  Launch,
  ProjectWithCounts,
  Session,
  Ticket,
} from "./types.js";
import type { ReviewStatus } from "./review.js";
import type { ReviewTunnelStatus } from "./review-tunnel.js";

// ============================================================================
// Claude Code Hook Event Payloads
// Verify exact field names against: https://code.claude.com/docs/en/hooks
// ============================================================================

export interface BaseHookPayload {
  session_id: string;
  cwd: string;
  transcript_path: string;
  hook_event_name: string;
  /** Observed on the wire per docs/claude-code-internals.md; not documented, so optional. Shape is `{ level: "low"|"medium"|... }`, not a bare string. */
  effort?: { level?: string };
  permission_mode?: string;
}

export interface SessionStartPayload extends BaseHookPayload {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear";
}

export interface SessionEndPayload extends BaseHookPayload {
  hook_event_name: "SessionEnd";
  reason?: string;
}

export interface UserPromptSubmitPayload extends BaseHookPayload {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface ToolUsePayload extends BaseHookPayload {
  hook_event_name: "PreToolUse" | "PostToolUse";
  /**
   * Correlates a Pre with its Post. Verified field name — it is
   * `tool_use_id`, not `tool_call_id`.
   *
   * A PreToolUse whose id never appears in a PostToolUse means the tool
   * failed: Claude Code does not emit PostToolUse for a failed call. That
   * absence is the only signal a failure happened, so anything reasoning
   * about failures has to match on this rather than inspect tool_response.
   */
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown; // only on PostToolUse
  duration_ms?: number; // only on PostToolUse
}

export interface SubagentPayload extends BaseHookPayload {
  hook_event_name: "SubagentStart" | "SubagentStop";
  /**
   * The subagent's correlation id, stable across its SubagentStart/SubagentStop
   * pair. The LIVE field name is `agent_id` (verified on the wire) — not the
   * `subagent_id` an earlier revision of this type guessed, which never matched
   * a real payload.
   */
  agent_id: string;
  /**
   * The subagent's type/label. Empty for Claude Code's internal helper agents
   * (title generation, summarization), which is the gate for skipping them.
   * Live field name is `agent_type`, not `subagent_type`.
   */
  agent_type: string;
  /**
   * The subagent's OWN JSONL transcript, distinct from the parent session's
   * `transcript_path`. Present on the live payload so a subsession's transcript
   * can be read/ingested independently of its parent's.
   */
  agent_transcript_path?: string;
  /** The subagent's final assistant message, carried on SubagentStop. */
  last_assistant_message?: string;
  description?: string;
}

export interface StopPayload extends BaseHookPayload {
  hook_event_name: "Stop";
}

export interface NotificationPayload extends BaseHookPayload {
  hook_event_name: "Notification";
  notification_type: "permission_prompt" | "idle_prompt" | "auth_success";
  message?: string;
}

export interface ElicitationPayload extends BaseHookPayload {
  hook_event_name: "Elicitation" | "ElicitationResult";
  elicitation_id: string;
  result?: unknown; // only on ElicitationResult
}

export type HookPayload =
  | SessionStartPayload
  | SessionEndPayload
  | UserPromptSubmitPayload
  | ToolUsePayload
  | SubagentPayload
  | StopPayload
  | NotificationPayload
  | ElicitationPayload;

// ============================================================================
// WebSocket messages (collector -> UI)
// ============================================================================

export type WsMessageType =
  | "hello-ok"
  | "session:start"
  | "session:end"
  | "session:status"
  | "session:event"
  | "event:new"
  | "checkpoint:new"
  | "ask:new"
  | "ask:resolved"
  | "steer:queued"
  | "steer:delivered"
  | "session:message"
  | "note:updated"
  | "stall:detected"
  | "projects:updated"
  | "launch:started"
  | "launch:stopped"
  | "launch:reaped"
  | "session:deleted"
  | "launch:cleaned"
  | "knowledge:draft"
  | "knowledge:change"
  | "digest:posted"
  | "ticket:new"
  | "ticket:updated"
  | "finding:new"
  | "finding:updated"
  | "task:updated"
  | "plan:updated"
  | "presence:state"
  | "persona:message"
  | "persona:state"
  | "persona:job"
  | "persona:approval"
  | "persona:activity"
  | "persona:schedule"
  | "pipeline:updated"
  | "pipeline:blocked"
  | "pipeline:parked"
  | "pipeline_config:updated"
  | "review:updated"
  | "reviews:pending"
  | "board:task"
  | "review_tunnel:updated"
  | "docs:changed";

/**
 * Payload of a `review_tunnel:updated` frame — a review tunnel's record
 * changed (opening, open, closed, failed); addressed to the tunnel's owner
 * (with proof) and unsequenced, so the job's card can show or drop its link.
 */
export interface ReviewTunnelUpdatedPayload {
  jobId?: string;
  launchId?: string;
  status: ReviewTunnelStatus;
}

/**
 * Payload of a `pipeline_config:updated` frame — one of the owner's pipeline
 * layers changed (the owner's own, a project's, a job's or a launch's);
 * addressed to the owner, so open settings views re-read it.
 */
export interface PipelineConfigUpdatedPayload {
  owner: string;
  projectId: string | null;
  scope: "user" | "project" | "job" | "launch";
  jobId?: string;
}

/**
 * Payload of a `pipeline:parked` frame — a worker of a Persona job's launch
 * parked its own run to wait; addressed to the owner, so Persona learns of it.
 */
export interface PipelineParkedPayload {
  owner: string;
  jobId: string;
  runId: string;
  launchId: string;
  sessionId?: string;
  stage: string;
  reason: string;
  waitingOnJobId?: string;
}

/**
 * Payload of a `pipeline:blocked` frame — a run of a Persona job's launch
 * stopped on something Persona decides (see PipelineDecisionKind for the
 * options); addressed to the owner.
 */
export interface PipelineBlockedPayload {
  owner: string;
  jobId: string;
  runId: string;
  launchId: string;
  sessionId?: string;
  stage: string;
  waitingKind?: string;
  reason: string;
  options: string[];
}

/** Payload of a `review:updated` frame — a review packet was submitted, decided or superseded. */
export interface ReviewUpdatedPayload {
  packetId: string;
  owner: string;
  status: ReviewStatus;
}

/**
 * Payload of a `reviews:pending` frame — the owner's count of packets awaiting
 * a decision, sent alongside every `review:updated`. It names no packet, so it
 * is not a `review:*` frame and needs no Persona proof: it reaches every socket
 * whose personal viewer is the owner, which keeps the Review tab's badge live on
 * a console socket that never proved the owner's Persona. That includes the
 * host's unproven loopback sockets, so the frame is laxer than
 * GET /api/reviews/pending-count, which needs a human-channel proof; it carries
 * only the number.
 */
export interface ReviewsPendingPayload {
  count: number;
}

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  payload: T;
  timestamp: string;
  /**
   * Monotonic per server run, stamped on every broadcast (not on `hello-ok`,
   * which reports the baseline via `serverSeq`). The client tracks the last
   * seq it saw and refetches on a gap — a seq more than one past the last means
   * a broadcast was dropped while the socket was momentarily wedged.
   */
  seq?: number;
  /**
   * When set, the frame is delivered only to WebSocket clients whose resolved
   * identity equals this alias (e.g. Persona's frames go to their owner alone).
   * Absent means every client receives it.
   */
  audience?: string;
  /**
   * With `audience`: the frame reaches only clients that proved that user at
   * upgrade (the owner secret or the user's channel token), as `persona:*`
   * and `review:*` frames always do — a socket merely resolving to the user
   * is not enough.
   */
  requireProof?: boolean;
}

// ============================================================================
// hello-ok handshake: the first frame the server sends
// on connect. It carries the same collections App.tsx fetches on mount, so a
// client boots from one push instead of a fan-out of REST calls, and it hands
// back the current `serverSeq` as the baseline for gap detection. Sent again
// on every reconnect, so its snapshot doubles as the reconnect resync.
// ============================================================================

/** The mount-time view of shared state, delivered in `hello-ok`. */
export interface Snapshot {
  projects: ProjectWithCounts[];
  sessions: Session[];
  checkpoints: Checkpoint[];
  asks: Ask[];
  launches: Launch[];
  tickets: Ticket[];
  /**
   * The team's actor directory. Lets a client resolve the
   * `createdActor`/`ownerActor` alias on every session — and the participant
   * ids from GET /api/sessions/:id/participants — to a display without a
   * per-alias lookup at boot.
   */
  actors: Actor[];
}

/** Payload of the `hello-ok` frame. */
export interface HelloOkPayload {
  protocolVersion: number;
  /**
   * The client's starting `lastSeq`: the last broadcast seq at connect time,
   * or, on a resumed connection, the `since` the client reconnected with.
   */
  serverSeq: number;
  /** The connecting user's identity (tunnel alias, else the host user). */
  user: string;
  /** The full snapshot; absent on a resumed connection, which keeps its state. */
  snapshot?: Snapshot;
  /**
   * The collector's leadership epoch. Seqs are only comparable within one
   * epoch; a client reconnects with `?epoch=<epoch>&since=<lastSeq>` to resume.
   */
  epoch?: string;
  /**
   * True when the server honored `?epoch=&since=`: every sequenced frame after
   * `serverSeq` follows this hello-ok in order, so the client keeps its state.
   * `snapshot` may still be present (the cursor became resumable while it was
   * being built) and is then ignored. Absent or false for a fresh start.
   */
  resumed?: boolean;
}

// ============================================================================
// Transcript events: the durable, sequence-numbered
// mirror of a session's transcript. SQLite is the canonical served state;
// clients page forward from a cursor instead of tail-reading JSONL per view,
// which is what lets more than one device follow the same session.
// ============================================================================

/** One record in a session's append-only transcript log. */
export interface TranscriptEvent {
  /** Monotonic per session, 1-based. */
  seq: number;
  /** The source record's stable id — its JSONL uuid; null if it carried none. */
  eventId: string | null;
  /** The mirrored transcript record, parsed back from event_json. */
  event: unknown;
  createdAt: string;
}

/** A forward page of transcript events plus the cursor to resume from. */
export interface TranscriptEventsPage {
  events: TranscriptEvent[];
  /** Pass as `sinceSeq` next; the last event's seq, or the input when empty. */
  cursor: number;
  /**
   * Backward (tail) pages only: whether events exist BEFORE the first returned
   * one — i.e. whether there is earlier history left to page into. Absent on a
   * forward page.
   */
  hasEarlier?: boolean;
  /**
   * Backward (tail) pages only: the seq of the first (oldest) returned event.
   * Pass it back as `before` to page one step further into history. Absent on a
   * forward page.
   */
  firstSeq?: number;
  /**
   * Tail pages only: the session's head (max) seq at query time, so a client
   * that opened on the tail knows where to resume live forward-tailing from.
   * Absent on a forward page.
   */
  headSeq?: number;
}

/** Payload of a `session:event` WS nudge — new transcript state is available. */
export interface SessionEventNudge {
  sessionId: string;
  /** The session's head seq after the ingest that triggered this nudge. */
  seq: number;
}

// ============================================================================
// Presence: ephemeral, never persisted. Keyed by the request's
// identity-header user; the collector holds a live roster of connected clients
// and pushes the whole roster as an unsequenced `presence:state` frame on every
// change. It is deliberately outside the sequenced broadcast stream and the
// hello-ok snapshot — losing a presence frame is harmless (the next change
// re-sends the full roster), so it must never trip the seq-gap resync.
// ============================================================================

/** One connected teammate's live presence. */
export interface PresenceEntry {
  /** The tunnel alias (else host user) — the identity the facepile shows. */
  user: string;
  /** The session this user is currently viewing, or null when on a list view. */
  viewingSessionId: string | null;
  /** True while the user is composing a reply/steer. */
  typing: boolean;
  /** ISO timestamp of this user's last presence update — for stale-pruning. */
  updatedAt: string;
}

/**
 * A client → server presence update, sent as a JSON string over the same
 * socket (not an `/api` call — presence is ephemeral and per-connection). The
 * collector merges it into the sender's roster entry and re-broadcasts.
 */
export interface PresenceSet {
  kind: "presence:set";
  viewingSessionId: string | null;
  typing: boolean;
}
