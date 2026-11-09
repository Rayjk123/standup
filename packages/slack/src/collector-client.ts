// Talks to the Standup collector: subscribes to its live event WebSocket
// (ws://…:7778) and calls its REST API (http://…:7777). This is the ONLY
// coupling to Standup — the adapter is otherwise a plain Slack app. Mirrors
// the web UI's useWebSocket.ts: reconnect with exponential backoff + jitter
// (capped), resync on reconnect, ping every 30s. The collector's WS has no
// replay, so resync-on-reconnect (re-fetch pending asks) is how we recover
// anything broadcast while down.

import {
  reconnectDelayMs,
  DEFAULT_RECONNECT_BACKOFF,
  SERVICE_CLIENT_HEADER,
  type WsMessage,
  type Ask,
  type Session,
  type PlanApproval,
  type TranscriptEventsPage,
  type Launch,
  type Project,
  type ClaudeModel,
  type ClaudeEffort,
  type CodexEffort,
  type HarnessId,
  type SessionKind,
  type SessionStatus,
  type ChannelFeaturesPatch,
  type PersonaState,
  type PersonaThread,
  type PersonaThreadRequest,
  type PersonaThreadSummary,
  type PersonaSendRequest,
  type PersonaUploadRequest,
  type PersonaUploadResponse,
  type PersonaAttachment,
  type PersonaMessage,
  type PersonaMessagesResponse,
  type PersonaApproval,
  type PersonaApprovalStatus,
  type PersonaJob,
  PERSONA_ATTACHMENT_MAX_BYTES,
  PERSONA_ATTACH_VIDEO_CEILING_BYTES,
  personaAttachmentPath,
} from "@standup/shared";
import { OWNER_TOKEN_HEADER, PERSONA_USER_HEADER, ownerTokenPath, readOwnerToken } from "@standup/shared/owner-token";

// Transcript shapes — mirror packages/collector/src/transcript.ts (readTranscript).
export interface TranscriptToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
}
export interface TranscriptMessage {
  uuid: string;
  role: "user" | "assistant";
  timestamp: string;
  text: string;
  toolCalls: TranscriptToolCall[];
  localCommand?: { name: string; args: string; stdout: string };
}
export interface TranscriptPage {
  messages: TranscriptMessage[];
  hasMore: boolean;
  totalMessages: number;
  outputTokens: number;
  contextTokens: number;
  owned?: boolean;
}

// Full-fidelity transcript shapes — mirror packages/collector/src/rich-transcript.ts
// (readRichTranscript). Where TranscriptMessage distills a turn (thinking folded,
// tool results flattened to one `output` string), a RichRow preserves the terminal's
// vocabulary: intra-turn block order, thinking, and the STRUCTURED tool outcome
// (diff hunks, split bash stdout/stderr, Read/Write line counts, todo items). This is
// what the Slack mirror reads so it can render what the terminal actually shows.
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each prefixed ` ` (context), `+` (added), or `-` (removed). */
  lines: string[];
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
  /** The chosen option label(s) once answered; undefined while pending. */
  answer?: string;
}

export type ToolResult =
  | { kind: "bash"; stdout: string; stderr: string; interrupted: boolean }
  | { kind: "diff"; filePath: string; hunks: DiffHunk[] }
  | { kind: "write"; filePath: string; lineCount: number }
  | { kind: "read"; filePath: string; numLines?: number; totalLines?: number }
  | { kind: "todo"; todos: { content?: string; status?: string }[] }
  | { kind: "question"; questions: AskQuestion[] }
  | { kind: "agent"; agentType?: string; status?: string }
  | { kind: "text"; text: string; isError: boolean }
  | { kind: "pending" };

interface RichRowBase {
  id: string;
  timestamp: string;
}

export type RichRow =
  | (RichRowBase & { kind: "user"; text: string; sentBy?: string })
  | (RichRowBase & { kind: "localCommand"; name: string; args: string; stdout: string })
  | (RichRowBase & { kind: "taskNotification"; summary: string; status: string })
  | (RichRowBase & { kind: "thinking"; text: string })
  | (RichRowBase & { kind: "text"; text: string })
  | (RichRowBase & {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      result: ToolResult;
    })
  | (RichRowBase & { kind: "compaction"; trigger: string; preTokens: number; postTokens: number })
  | (RichRowBase & { kind: "mode"; label: string });

export interface RichTranscriptPage {
  rows: RichRow[];
  hasMore: boolean;
  /** History exists before this window but isn't reachable by paging yet. */
  truncated: boolean;
  totalRows: number;
  outputTokens: number;
  contextTokens: number;
  model?: string;
  owned?: boolean;
}

/**
 * One row of the ephemeral cross-agent activity view — mirrors the collector's
 * `ActiveWorkItem` (packages/store/src/queries/sessions.ts). A ROOT session that
 * is active or recently active, derived from session + event recency (never the
 * durable knowledge path). `actor` is the canonical owner (owner_actor, else
 * created_actor); `harness` is the launch's agent CLI (unset for a default
 * Claude launch that recorded none).
 */
export interface ActiveWorkItem {
  sessionId: string;
  title: string;
  /** `paused` marks an idle-paused worker: its pane was reaped but a message resumes it. */
  status: SessionStatus | "paused";
  actor?: string;
  kind?: SessionKind;
  harness?: HarnessId;
  job?: { id: string; title: string };
  lastActivityAt: string;
}

export interface CollectorSettings {
  worktreeRoot: string;
  /** Feed channel id (`C…`) or "" if unset. Added to /api/settings by this feature. */
  slackFeedChannel: string;
  /** Ask-recipient user id (`U…`) or "" if none learned yet. */
  slackAskUser: string;
  /** Per-channel feature toggles as a JSON blob keyed by channel id, or "" for the quiet default. */
  slackChannelFeatures: string;
  /**
   * Monotonic version of the whole settings blob, bumped on every write. The
   * adapter records the version its own PUT returns and only adopts a polled
   * snapshot whose version has reached it, so a stale poll can't revert a
   * just-issued command while any newer external edit is always eventually taken.
   */
  settingsVersion: number;
}

/**
 * The result of a launch request: the created launch row on success, else an
 * error (with the HTTP status when the collector rejected it — e.g. 404 unknown
 * project, 403 reserved, 400 missing task).
 */
export type LaunchOutcome =
  | { ok: true; launch: Launch }
  | { ok: false; error?: string; status?: number };

/**
 * The result of a Persona write: the collector's payload on success, else the
 * HTTP status (when the collector answered) and its error text.
 */
export type PersonaWriteResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status?: number;
      error?: string;
      /** The request timed out: the collector may still have acted on it. */
      timedOut?: boolean;
    };

/** Page size for GET /api/persona/messages; a full page means there may be more. */
const PERSONA_MESSAGES_PAGE = 200;

const PING_MS = 30000;

// Bound every REST call so a collector that accepts the socket but stops
// responding (deadlocked collector, half-open tunnel) can't hang a request
// forever. Without this, a stalled settings PUT never settles, so the command
// handler that awaits it hangs mid-mutation — its confirmation never posts and
// its version stamp never records. On timeout the fetch rejects with an
// AbortError, which getJson/putJson catch and surface as null (unreachable) —
// the same outcome as any other failed call.
const REST_TIMEOUT_MS = 15000;
/** How long fetching an attachment's stored copy (a video may be large) from the collector may take. */
const ATTACHMENT_TIMEOUT_MS = 5 * 60_000;

/** `body` read to its end, or null (the rest cancelled) once it outgrows `max` bytes. */
async function readAtMost(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
// Approving a held Persona action executes it before the response returns
// (e.g. a launch), which can run well past the normal REST bound.
const PERSONA_DECISION_TIMEOUT_MS = 120000;
// An upload carries up to a video's worth of base64 and the collector reads
// frames from a video before it answers.
const PERSONA_UPLOAD_TIMEOUT_MS = 180000;

export class CollectorClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Consecutive failed-connect count, driving the backoff curve. Reset to 0 on
  // a successful open so a healthy reconnect starts the next drop at the base.
  private reconnectAttempts = 0;
  private hasConnectedBefore = false;
  private closed = false;
  private readonly sessionTitleCache = new Map<string, string>();

  constructor(
    private readonly httpBase: string,
    private readonly wsUrl: string,
    private readonly handlers: {
      onMessage: (msg: WsMessage) => void;
      /** Fires when the socket reopens after a prior connection — resync here. */
      onReconnect: () => void;
      onOpen?: () => void;
    },
    /**
     * Reads the owner secret (default: the collector's
     * `<dataDir>/secrets/owner.token`, or STANDUP_OWNER_TOKEN_FILE). Presented
     * on the WS upgrade (so the relay receives persona:* frames), on every
     * Persona route (each naming the user it speaks for, or none for the
     * host), and on an ask answer the caller passes `asOwner` for.
     */
    private readonly ownerToken: () => string | undefined = () => readOwnerToken(ownerTokenPath()),
  ) {}

  /** The owner-token header, or none when the secret can't be read. */
  private ownerHeaders(): Record<string, string> {
    const token = this.ownerToken();
    return token ? { [OWNER_TOKEN_HEADER]: token } : {};
  }

  /**
   * The headers a Persona call made for `user` carries: the owner secret plus
   * the alias it speaks for (the collector honors the alias only alongside the
   * secret). With no user, just the secret — the collector resolves a
   * loopback call without the alias header to the host.
   */
  private personaHeaders(user: string | undefined): Record<string, string> {
    return { ...this.ownerHeaders(), ...(user ? { [PERSONA_USER_HEADER]: user } : {}) };
  }

  // ---- WebSocket ----------------------------------------------------------

  connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      // Marked as a service relay: the feed it forwards is a shared channel, so
      // the collector sends it no other frame addressed to one user. Carrying
      // the owner secret, it also receives every user's persona:* frames
      // (each still addressed to its user), which the bridge routes per user.
      ws = new WebSocket(this.wsUrl, { headers: { [SERVICE_CLIENT_HEADER]: "slack", ...this.ownerHeaders() } });
    } catch (err) {
      console.error(`[collector] WS connect failed, retrying:`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      console.log(`[collector] WS connected → ${this.wsUrl}`);
      this.reconnectAttempts = 0;
      this.handlers.onOpen?.();
      if (this.hasConnectedBefore) this.handlers.onReconnect();
      this.hasConnectedBefore = true;
    };
    ws.onclose = () => {
      if (this.closed) return;
      console.log(`[collector] WS disconnected, reconnecting…`);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and drives the reconnect; avoid double-scheduling here.
    };
    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (!data || data === "pong") return;
      let msg: WsMessage;
      try {
        msg = JSON.parse(data) as WsMessage;
      } catch {
        return; // non-JSON keepalive noise
      }
      try {
        this.handlers.onMessage(msg);
      } catch (err) {
        console.error("[collector] handler threw for", msg.type, err);
      }
    };

    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
      }, PING_MS);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = reconnectDelayMs(++this.reconnectAttempts, DEFAULT_RECONNECT_BACKOFF);
    console.log(`[collector] reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  // ---- REST ---------------------------------------------------------------

  async getSettings(): Promise<CollectorSettings | null> {
    return this.getJson<CollectorSettings>("/api/settings");
  }

  /** PUT the feed channel id (or "" to clear). Returns the updated settings. */
  async setFeedChannel(channelId: string): Promise<CollectorSettings | null> {
    return this.putJson<CollectorSettings>("/api/settings", { slackFeedChannel: channelId });
  }

  /** PUT the ask-recipient user id (or "" to clear). Persists across adapter restarts. */
  async setAskUser(userId: string): Promise<CollectorSettings | null> {
    return this.putJson<CollectorSettings>("/api/settings", { slackAskUser: userId });
  }

  /**
   * PUT a per-channel feature-toggle DELTA — the channel(s) a command touched, as
   * a `set`/`clear` patch the collector merges onto the current stored blob. Sending
   * a delta (never the adapter's whole local snapshot) is what keeps a concurrent
   * external per-channel edit, or an overlapping command on another channel, from
   * being clobbered by a whole-blob overwrite. Returns the updated settings.
   */
  async patchChannelFeatures(patch: ChannelFeaturesPatch): Promise<CollectorSettings | null> {
    return this.putJson<CollectorSettings>("/api/settings", { slackChannelFeaturesPatch: patch });
  }

  /**
   * Pending asks, or null if the fetch FAILED. Callers MUST distinguish null
   * (collector unreachable — don't retire anything) from [] (genuinely none).
   */
  async getPendingAsks(): Promise<Ask[] | null> {
    return this.getJson<Ask[]>("/api/asks/pending");
  }

  /**
   * Answer an ask. Returns {ok} or an {error,status} — the caller decides how
   * to surface it (e.g. a 409 permission_prompt on a monitored session).
   *
   * `actor` names the teammate who answered so the collector can attribute the
   * contribution: off-tunnel there's no identity header, so a Slack
   * answerer would otherwise be recorded as the host user.
   *
   * `asOwner` presents the owner secret, which allowing a safety-floor hold
   * requires; the caller passes it only when the verified Slack actor is the
   * owner.
   */
  async resolveAsk(
    askId: string,
    answer: string,
    actor?: string,
    asOwner = false,
  ): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
      const res = await fetch(`${this.httpBase}/api/asks/${encodeURIComponent(askId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(asOwner ? this.ownerHeaders() : {}) },
        body: JSON.stringify(actor ? { answer, actor } : { answer }),
      });
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Plans awaiting a human, or null if the fetch FAILED. Same null-vs-[]
   * contract as getPendingAsks — a failed fetch must not retire live cards.
   */
  async getPendingPlans(): Promise<PlanApproval[] | null> {
    const res = await this.getJson<{ plans: PlanApproval[] }>("/api/plans/pending");
    return res ? res.plans : null;
  }

  /**
   * Approve (as submitted) or reject a plan from Slack. `actor` names the Slack
   * approver so the collector attributes approvedBy to them, not the host user
   * (off-tunnel there's no identity header). Editing the plan before
   * approval stays in the web UI; Slack offers only the as-is decisions.
   */
  async decidePlan(
    planId: string,
    decision: "approve" | "reject",
    actor?: string,
  ): Promise<{ ok: boolean; error?: string; status?: number }> {
    try {
      const res = await fetch(
        `${this.httpBase}/api/plans/${encodeURIComponent(planId)}/${decision}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(actor ? { actor } : {}),
        },
      );
      if (res.ok) return { ok: true };
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Steer a session: inject `text` into the live agent via POST
   * /api/sessions/:id/send. `actor` names the Slack teammate who typed it so the
   * collector attributes the contribution to them (off-tunnel there's no
   * identity header). `idempotencyKey` (the inbound Slack message id)
   * makes a redelivered event a no-op at the collector too — a second layer under
   * the adapter's own LRU dedup. A 409 means the session isn't Standup-launched.
   */
  async sendToSession(
    sessionId: string,
    text: string,
    actor?: string,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; deduped?: boolean; error?: string; status?: number }> {
    try {
      const res = await fetch(`${this.httpBase}/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(actor ? { actor } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { deduped?: boolean };
        return { ok: true, deduped: body.deduped };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fold one actor into another (identity reconciliation): a teammate
   * who answers in Slack mints a `slack:U…` actor while driving sessions over
   * the tunnel mints an alias actor — merging links the two so the person
   * counts as one collaborator, not two. Best-effort; returns whether it landed.
   */
  async mergeActor(fromId: string, intoId: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.httpBase}/api/actors/${encodeURIComponent(fromId)}/merge`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ into: intoId }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Launch a new task session in a project via POST /api/projects/:id/launch —
   * the task-LAUNCH surface for Slack (the console composer, over HTTP). `task`
   * is the agent's opening prompt; `actor` names the Slack teammate who fired it
   * so the collector attributes the launch to them (off-tunnel there's no
   * identity header, so without it a Slack launch would be miscounted
   * as the host user). The endpoint returns immediately with a `starting` row —
   * its `sessionId` attaches slightly later — so a caller reports the launch, not
   * a guaranteed-live session.
   *
   * `idempotencyKey` (the inbound Slack message id) makes a redelivered launch a
   * no-op at the collector: a second request with the same key resolves to the
   * SAME launch instead of spawning a second worktree/session — the guard the
   * steer path passes to /send, now for the far costlier launch.
   */
  async launch(
    projectId: string,
    task: string,
    opts: {
      model?: ClaudeModel;
      effort?: ClaudeEffort;
      harness?: HarnessId;
      codexModel?: string;
      codexEffort?: CodexEffort;
      actor?: string;
      idempotencyKey?: string;
    } = {},
  ): Promise<LaunchOutcome> {
    try {
      const res = await fetch(
        `${this.httpBase}/api/projects/${encodeURIComponent(projectId)}/launch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(opts.harness ? { harness: opts.harness } : {}),
            ...(opts.codexModel ? { codexModel: opts.codexModel } : {}),
            ...(opts.codexEffort ? { codexEffort: opts.codexEffort } : {}),
            ...(opts.actor ? { actor: opts.actor } : {}),
            ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          }),
        },
      );
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { launch?: Launch };
        return body.launch
          ? { ok: true, launch: body.launch }
          : { ok: false, error: "collector returned no launch" };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error, status: res.status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The registered projects (GET /api/projects), or null if the fetch FAILED —
   * used to resolve a launch command's project ref (by id or name) to an id.
   */
  async listProjects(): Promise<Project[] | null> {
    return this.getJson<Project[]>("/api/projects");
  }

  /**
   * The ephemeral, pull-first cross-agent activity view (GET /api/active-work) —
   * the ROOT sessions active or recently active in the scoped project, most-recent
   * first, or null if the fetch FAILED. The collector applies ALL the ownership /
   * visibility gating (it honors `project` only with standing there or the owned
   * `session_id`'s project, and excludes the caller's OWN work) — the SAME
   * server-side gating the MCP whats_happening tool relies on.
   *
   * `actor` is the collector identity the adapter resolved for the human who
   * invoked the command (the mapped Slack caller). The adapter is off-tunnel, so
   * it carries NO identity header of its own — without this the collector would
   * resolve the caller to the host operator and scope to the operator's standing,
   * leaking every project's sessions to any Slack member. Supplying it scopes the
   * read to the CALLER's own standing (the collector honors this override only for
   * a loopback caller carrying no identity header — i.e. this adapter). The adapter
   * passes a scope and renders exactly what comes back, never widening it.
   * Read-only: it writes nothing.
   */
  async getActiveWork(
    opts: { project?: string; sessionId?: string; actor?: string } = {},
  ): Promise<ActiveWorkItem[] | null> {
    const params = new URLSearchParams();
    if (opts.project) params.set("project", opts.project);
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.actor) params.set("actor", opts.actor);
    const query = params.toString();
    const res = await this.getJson<{ work: ActiveWorkItem[] }>(
      `/api/active-work${query ? `?${query}` : ""}`,
    );
    return res ? res.work : null;
  }

  /** The project a session belongs to, or undefined when the lookup FAILED / it's unknown. */
  async sessionProjectId(sessionId: string): Promise<string | undefined> {
    const session = await this.getJson<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return session?.projectId;
  }

  /** The session's reconstructed transcript (tail-first, up to `limit` messages). */
  async getTranscript(sessionId: string, limit = 40): Promise<TranscriptPage | null> {
    return this.getJson<TranscriptPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript?limit=${limit}`,
    );
  }

  /**
   * The session's FULL-FIDELITY transcript as an ordered RichRow window (tail of
   * up to `limit` rows). This is the terminal-mode feed — thinking, per-block
   * text, and structured tool results survive — so the mirror renders what the
   * TUI shows rather than the distilled card view. Backs the Slack mirror.
   */
  async getRichTranscript(sessionId: string, limit = 60): Promise<RichTranscriptPage | null> {
    return this.getJson<RichTranscriptPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/rich?limit=${limit}`,
    );
  }

  /**
   * A forward page of the durable transcript-event log after `sinceSeq`
   * (oldest-first) plus the `cursor` to resume from. The collector reconciles the
   * JSONL into the log before serving, so draining from a per-session cursor is an
   * incremental alternative to re-reading the whole rich window each nudge.
   */
  async getTranscriptEvents(sessionId: string, sinceSeq = 0, limit = 500): Promise<TranscriptEventsPage | null> {
    return this.getJson<TranscriptEventsPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/transcript/events?sinceSeq=${sinceSeq}&limit=${limit}`,
    );
  }

  /** Best-effort human title for a session, cached. Falls back to a short id. */
  async sessionTitle(sessionId: string): Promise<string> {
    const cached = this.sessionTitleCache.get(sessionId);
    if (cached) return cached;
    const session = await this.getJson<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const title = session?.title?.trim();
    if (title) {
      this.sessionTitleCache.set(sessionId, title);
      return title;
    }
    // Do NOT cache the fallback: a session's title is often set slightly after
    // its first events (async auto-titling), so a later lookup should get the
    // real one instead of being pinned to the short id forever.
    return sessionId.slice(0, 8);
  }

  /**
   * The human answerable for a session's asks — its RESPONSIBLE actor, resolved
   * owner → creator → earliest participant (the same routing server.ts
   * responsibleAlias and the web AlertStrip use). Returns that alias, `null` when
   * the session exists but is genuinely unattributed (no owner, creator, or
   * participant), or `undefined` when the lookup FAILED (collector unreachable).
   * The tri-state lets owner routing tell an unattributed session (suppress)
   * apart from a transient fetch failure (fall back to today's delivery) — a blip
   * must never silently suppress an ask. Resolving through creator/participant,
   * not owner_actor alone, matters because owner_actor is unset until a human
   * explicitly claims a session, so the common self-launched/auto-appeared
   * session still routes to the human who created or acted on it.
   */
  async sessionResponsible(sessionId: string): Promise<string | null | undefined> {
    const session = await this.getJson<Session>(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!session) return undefined;
    return session.ownerActor ?? session.createdActor ?? session.participantActors?.[0] ?? null;
  }

  // ---- Persona ------------------------------------------------------------
  //
  // Every user has their own Persona. Each call names the user it is made for
  // (their alias, sent with the owner secret as PERSONA_USER_HEADER), so the
  // collector acts on that user's Persona; writes must carry
  // `content-type: application/json` (a bodyless write sends `{}`).

  /**
   * A user's Persona run state (owner alias, console thread, run state), or
   * null if the fetch failed. With no user the call carries the owner secret
   * alone, which the collector resolves to the host — how the bridge learns
   * who the host is. A read never creates a Persona: a user without one gets
   * an idle state with no console thread.
   */
  async personaState(user?: string): Promise<PersonaState | null> {
    return this.getJson<PersonaState>("/api/persona/state", this.personaHeaders(user));
  }

  /**
   * The aliases that have a Persona on the collector (host only:
   * GET /api/persona/users) — a running runtime or a persisted state; a user
   * listed only for their access settings is left out. Null if the fetch failed.
   */
  async personaUsers(): Promise<string[] | null> {
    const res = await this.getJson<{ users?: unknown }>("/api/persona/users", this.ownerHeaders());
    if (!res || !Array.isArray(res.users)) return null;
    const out: string[] = [];
    for (const u of res.users as unknown[]) {
      const row = (u ?? {}) as { alias?: unknown; owner?: unknown; running?: unknown; state?: unknown };
      const state = typeof row.state === "object" && row.state !== null ? (row.state as { owner?: unknown }) : undefined;
      if (row.running !== true && !state) continue;
      const alias = typeof row.alias === "string" ? row.alias : typeof row.owner === "string" ? row.owner : state?.owner;
      if (typeof alias === "string" && alias) out.push(alias);
    }
    return out;
  }

  /** Find or create the Persona thread bound to a channel address, in `user`'s Persona. */
  async personaThread(user: string, req: PersonaThreadRequest): Promise<PersonaWriteResult<PersonaThread>> {
    const res = await this.postPersona<{ thread?: PersonaThread }>(user, "/api/persona/threads", req);
    if (!res.ok) return res;
    return res.data.thread ? { ok: true, data: res.data.thread } : { ok: false, error: "collector returned no thread" };
  }

  /**
   * `user`'s Persona threads, newest activity first, or null if the fetch
   * failed or took longer than `timeoutMs`.
   */
  async personaThreads(user: string, timeoutMs = REST_TIMEOUT_MS): Promise<PersonaThreadSummary[] | null> {
    const res = await this.getJson<{ threads?: PersonaThreadSummary[] }>("/api/persona/threads", this.personaHeaders(user), timeoutMs);
    return res?.threads ?? null;
  }

  /** Send `user`'s message (with optional untrusted context) to one of their Persona threads. */
  async personaSend(user: string, req: PersonaSendRequest): Promise<PersonaWriteResult<PersonaMessage>> {
    const res = await this.postPersona<{ message?: PersonaMessage }>(user, "/api/persona/messages", req);
    if (!res.ok) return res;
    return res.data.message ? { ok: true, data: res.data.message } : { ok: false, error: "collector returned no message" };
  }

  /**
   * Store one image or video `user` is about to send to a Persona thread; the
   * returned attachment's id goes in a later personaSend's `attachmentIds`.
   * Throws with the collector's own `error` text when it refuses the file (an
   * unsupported or mismatched type, a video it can't decode, too large), so
   * the reason can be shown to the user as is.
   */
  async personaUpload(user: string, req: PersonaUploadRequest): Promise<PersonaAttachment> {
    const res = await this.postPersona<PersonaUploadResponse>(user, "/api/persona/uploads", req, PERSONA_UPLOAD_TIMEOUT_MS);
    if (!res.ok) {
      if (res.timedOut) throw new Error("the collector took too long to take the file");
      if (res.error) throw new Error(res.error);
      throw new Error(res.status === 413 ? "the file is too large" : `the collector refused the file (HTTP ${res.status ?? "?"})`);
    }
    if (!res.data.attachment?.id) throw new Error("the collector returned no attachment");
    return res.data.attachment;
  }

  /**
   * A thread's messages after `afterSeq`, oldest first, following pages until
   * the thread is drained (bounded). Null when any page fails, so a caller
   * never mistakes a partial read for the whole tail.
   */
  async personaMessages(user: string, threadId: string, afterSeq = 0, maxPages = 10): Promise<PersonaMessage[] | null> {
    const out: PersonaMessage[] = [];
    let cursor = afterSeq;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ threadId, afterSeq: String(cursor), limit: String(PERSONA_MESSAGES_PAGE) });
      const res = await this.getJson<PersonaMessagesResponse>(`/api/persona/messages?${params.toString()}`, this.personaHeaders(user));
      if (!res) return null;
      out.push(...res.messages);
      if (res.messages.length < PERSONA_MESSAGES_PAGE) break;
      cursor = res.messages[res.messages.length - 1]!.seq;
    }
    return out;
  }

  /**
   * An attached image's or video's stored copy, by attachment id, or null
   * when the collector doesn't serve it (unknown id, missing copy, a failed
   * fetch) or what it sent isn't an image or video within its size limit. A
   * video's size was capped by the collector when it was attached (its own
   * STANDUP_PERSONA_ATTACH_VIDEO_MAX_MB), so here it is held only to the
   * highest cap that setting takes, whatever this process's env says.
   */
  async personaAttachment(user: string, id: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(`${this.httpBase}${personaAttachmentPath(id)}`, {
        headers: this.personaHeaders(user),
        signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
      });
      const type = res.headers.get("content-type") ?? "";
      const max = type.startsWith("image/")
        ? PERSONA_ATTACHMENT_MAX_BYTES
        : type.startsWith("video/")
          ? PERSONA_ATTACH_VIDEO_CEILING_BYTES
          : 0;
      const declared = Number(res.headers.get("content-length"));
      if (!res.ok || max === 0 || (Number.isFinite(declared) && declared > max) || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const bytes = await readAtMost(res.body, max);
      return bytes && bytes.length > 0 ? bytes : null;
    } catch {
      return null;
    }
  }

  /**
   * The approvals `user` owns or must decide (optionally one status), or null
   * if the fetch failed. Each carries its `owner` and, when someone else must
   * decide it, its `approver`.
   */
  async personaApprovals(user: string, status?: PersonaApprovalStatus): Promise<PersonaApproval[] | null> {
    const res = await this.getJson<{ approvals?: PersonaApproval[] }>(
      `/api/persona/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
      this.personaHeaders(user),
    );
    return res?.approvals ?? null;
  }

  /**
   * `user`'s Persona jobs (GET /api/persona/jobs, newest first), or null if the
   * fetch failed or took longer than `timeoutMs`.
   */
  async personaJobs(user: string, timeoutMs = REST_TIMEOUT_MS): Promise<PersonaJob[] | null> {
    const res = await this.getJson<{ jobs?: PersonaJob[] }>("/api/persona/jobs", this.personaHeaders(user), timeoutMs);
    return Array.isArray(res?.jobs) ? res.jobs : null;
  }

  /** Approve a held Persona action as `user` (its approver); the collector executes exactly the stored action. */
  async personaApprove(user: string, approvalId: string): Promise<PersonaWriteResult<PersonaApproval>> {
    const res = await this.postPersona<{ approval?: PersonaApproval }>(
      user,
      `/api/persona/approvals/${encodeURIComponent(approvalId)}/approve`,
      {},
      PERSONA_DECISION_TIMEOUT_MS,
    );
    if (!res.ok) return res;
    return res.data.approval ? { ok: true, data: res.data.approval } : { ok: false, error: "collector returned no approval" };
  }

  /** Deny a held Persona action as `user` (its approver). */
  async personaDeny(user: string, approvalId: string, reason?: string): Promise<PersonaWriteResult<PersonaApproval>> {
    const res = await this.postPersona<{ approval?: PersonaApproval }>(
      user,
      `/api/persona/approvals/${encodeURIComponent(approvalId)}/deny`,
      reason ? { reason } : {},
      PERSONA_DECISION_TIMEOUT_MS,
    );
    if (!res.ok) return res;
    return res.data.approval ? { ok: true, data: res.data.approval } : { ok: false, error: "collector returned no approval" };
  }

  private async postPersona<T>(user: string, path: string, body: unknown, timeoutMs = REST_TIMEOUT_MS): Promise<PersonaWriteResult<T>> {
    try {
      const res = await fetch(`${this.httpBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.personaHeaders(user) },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (res.ok) return { ok: true, data };
      return { ok: false, status: res.status, error: typeof data.error === "string" ? data.error : undefined };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...(timedOut ? { timedOut } : {}) };
    }
  }

  private async getJson<T>(path: string, headers: Record<string, string> = {}, timeoutMs = REST_TIMEOUT_MS): Promise<T | null> {
    try {
      const res = await fetch(`${this.httpBase}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private async putJson<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.httpBase}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
