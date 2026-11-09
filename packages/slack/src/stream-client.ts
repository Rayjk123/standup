// Slack native streaming wrapper (chat.startStream / chat.appendStream /
// chat.stopStream) plus the "is …" thread-status line. The typed @slack/web-api
// SDK doesn't expose these methods, so every call goes through a single
// `SlackApi.call(method, args)` seam — WebClient.apiCall in production, a
// recording fake in tests. One method keeps the fake trivial and lets a golden
// test capture the exact ordered (method, args) sequence a turn produces.
//
// Param contract (verified against a live workspace; see src/probe.ts):
// startStream needs channel + thread_ts + recipient_team_id + recipient_user_id
// and streams a reply INSIDE the thread; appends MUST go via `chunks` only
// (mixing top-level text throws streaming_mode_mismatch). A card is a
// task_update chunk keyed by a stable `id` — re-send the same id to flip
// in_progress → complete. The streaming METHODS aren't in web-api's typed
// surface, but the chunk TYPES are (`@slack/types`), so chunk shapes below
// derive from the SDK.

import type { MarkdownTextChunk, PlanUpdateChunk, TaskUpdateChunk } from "@slack/types";

/** Normalized result of one Web API call — unifies WebClient's throw-on-`ok:false`. */
export interface SlackCallResult {
  ok: boolean;
  error?: string;
  /** `ts` of a posted/streamed message when present. */
  ts?: string;
  /** Full response body (success) or `err.data` (platform error) — carries needed/provided. */
  data: Record<string, unknown>;
}

/** The single Slack surface the mirror depends on. Trivial to record or fake. */
export interface SlackApi {
  call(method: string, args: Record<string, unknown>): Promise<SlackCallResult>;
}

/**
 * A `task_update` card, narrowed to the two statuses this mirror ever emits.
 * Its fields — including the optional markdown bodies `details` (a subtitle
 * under the title) and `output` (the collapsible result body Slack hides behind
 * the card, keeping tool output out of the inline transcript) — are inherited
 * from Slack's published `TaskUpdateChunk` contract, so the field names are
 * checked against the SDK rather than hand-copied and cannot silently drift.
 * Set `details`/`output` on the `complete` update so the finished card owns its
 * result.
 */
export type TaskCardChunk = Omit<TaskUpdateChunk, "status"> & {
  status: "in_progress" | "complete";
};

/**
 * A typed streaming chunk. Slack renders GitHub-flavored markdown natively.
 * Each arm is (a narrowing of) a `@slack/types` chunk, so `StreamChunk` is by
 * construction assignable to `AnyChunk` — the wire shape `chat.appendStream`
 * accepts.
 */
export type StreamChunk = MarkdownTextChunk | TaskCardChunk | PlanUpdateChunk;

/**
 * Errors that prove the streaming method is NOT usable by this app — the caller
 * degrades to the non-streaming fallback permanently. Everything else
 * (invalid_thread_ts, missing_recipient_*, streaming_mode_mismatch, a transient
 * network/429) is a per-call problem, not an availability block.
 */
const UNAVAILABLE_ERRORS = new Set([
  "unknown_method",
  "method_not_supported",
  "method_deprecated",
  "not_allowed_token_type",
  "missing_scope",
  "no_permission",
  "restricted_action",
  "access_denied",
]);

export function isStreamingUnavailable(error: string | undefined): boolean {
  return !!error && UNAVAILABLE_ERRORS.has(error);
}

/** Adapt a real @slack/web-api WebClient to the SlackApi seam via apiCall. */
export function webApi(web: { apiCall(method: string, args?: Record<string, unknown>): Promise<unknown> }): SlackApi {
  return {
    async call(method, args) {
      try {
        const data = (await web.apiCall(method, args)) as Record<string, unknown>;
        return {
          ok: data.ok === true,
          error: data.ok ? undefined : String(data.error),
          ts: typeof data.ts === "string" ? data.ts : undefined,
          data,
        };
      } catch (err) {
        const e = err as { data?: Record<string, unknown>; message?: string };
        if (e.data && typeof e.data === "object") {
          return { ok: false, error: String(e.data.error ?? e.message ?? "unknown"), data: e.data };
        }
        return { ok: false, error: e.message ?? String(err), data: {} };
      }
    },
  };
}

export interface StartStreamOptions {
  channel: string;
  threadTs: string;
  recipientTeamId?: string;
  recipientUserId?: string;
  /** Initial plan-mode card title (plan_update chunk). */
  planTitle: string;
}

export interface StartStreamResult {
  ts?: string;
  /** True only when the method itself is blocked for this app — go to fallback. */
  unavailable: boolean;
  error?: string;
}

/** Open one plan-mode streaming message. Returns its ts, or an availability verdict. */
export async function startStream(api: SlackApi, opts: StartStreamOptions): Promise<StartStreamResult> {
  const args: Record<string, unknown> = {
    channel: opts.channel,
    thread_ts: opts.threadTs,
    task_display_mode: "plan",
    chunks: [{ type: "plan_update", title: opts.planTitle }],
  };
  if (opts.recipientTeamId) args.recipient_team_id = opts.recipientTeamId;
  if (opts.recipientUserId) args.recipient_user_id = opts.recipientUserId;
  const res = await api.call("chat.startStream", args);
  if (res.ok && res.ts) return { ts: res.ts, unavailable: false };
  return { unavailable: isStreamingUnavailable(res.error), error: res.error };
}

/**
 * Drop any chunk that would render as a blank bubble — the transmit-seam guard
 * against empty Slack messages. A `markdown_text` chunk whose body is empty or
 * whitespace-only carries no visible content but still posts an empty message;
 * per-event formatters normalize blanks upstream, this is the last line of
 * defense so no builder path can leak one through. Task/plan chunks always
 * render a card, so they pass untouched.
 */
function dropBlankChunks(chunks: StreamChunk[]): StreamChunk[] {
  return chunks.filter((c) => c.type !== "markdown_text" || c.text.trim().length > 0);
}

/** Append chunks to an open stream. Returns false on failure (caller may rotate). */
export async function appendStream(
  api: SlackApi,
  channel: string,
  ts: string,
  chunks: StreamChunk[],
): Promise<boolean> {
  const send = dropBlankChunks(chunks);
  if (send.length === 0) return true;
  const res = await api.call("chat.appendStream", { channel, ts, chunks: send });
  return res.ok;
}

/** Finalize a stream. Deliberately the last write — no chat.update follows (it downgrades formatting). */
export async function stopStream(api: SlackApi, channel: string, ts: string): Promise<void> {
  await api.call("chat.stopStream", { channel, ts });
}

/**
 * Set (or clear, with "") the assistant thread's "is …" status line. Best-effort:
 * a plain channel thread may reject it, which is harmless.
 */
export async function setThreadStatus(
  api: SlackApi,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await api.call("assistant.threads.setStatus", { channel_id: channelId, thread_ts: threadTs, status });
}
