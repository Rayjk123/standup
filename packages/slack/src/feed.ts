// Forwards the Standup event feed into a Slack channel. The target channel is
// a collector setting (slackFeedChannel), so it can be turned on/off live from
// Slack (see app.ts's app_mention handler) without restarting the adapter.

import type { WebClient } from "@slack/web-api";
import type { WsMessage, Launch } from "@standup/shared";
import type { CollectorClient } from "./collector-client.js";
import type { ChannelFeatureStore } from "./channel-features.js";
import { feedKindForType } from "./channel-features.js";
import { feedLine } from "./format.js";

export class Feed {
  private channel: string | undefined;
  // Serialize posts: preserves feed order and avoids a burst of concurrent
  // chat.postMessage calls tripping Slack's per-channel rate limit.
  private tail: Promise<void> = Promise.resolve();
  // When the mirror is on, session-scoped feed lines are routed INTO the
  // session's thread (resolver returns its rootTs), and the ask:new line is
  // dropped (the ask card is posted in-thread by Asks). Unset = flat channel.
  private threadResolver?: (sessionId: string) => string | undefined;
  // Launch ids already fed. A launch re-broadcasts `launch:started` once per
  // provisioning phase (starting → each phase → running); without this the feed
  // posts a `launched:` line per frame (the ~4× duplication users saw). Keyed by
  // launch id so genuinely distinct launches each still get their own line.
  private readonly handledLaunches = new Set<string>();

  constructor(
    private readonly web: WebClient,
    private readonly collector: CollectorClient,
    // Per-channel toggles (shared with Mirror/Asks). Absent ⇒ everything on.
    private readonly features?: ChannelFeatureStore,
  ) {}

  /** Set (or clear, with "") the channel the feed writes into. */
  setChannel(channel: string | undefined): void {
    this.channel = channel && channel.trim() ? channel.trim() : undefined;
  }

  getChannel(): string | undefined {
    return this.channel;
  }

  /** Route session-scoped lines into per-session mirror threads (mirror mode). */
  setThreadResolver(resolver: (sessionId: string) => string | undefined): void {
    this.threadResolver = resolver;
  }

  /** Whether the mirror feature is on for the current feed channel (no feature store ⇒ on). */
  private mirrorEnabledHere(): boolean {
    return !this.features || this.features.mirrorEnabled(this.channel);
  }

  /** Whether the asks feature is on for the current feed channel (absent toggles ⇒ on). */
  private asksEnabledHere(): boolean {
    return !this.features || this.features.asksEnabled(this.channel);
  }

  /** Resolves once the currently-queued posts have drained (test seam). */
  whenIdle(): Promise<void> {
    return this.tail;
  }

  /** Route one collector event to the feed channel, if configured and forwardable. */
  handle(msg: WsMessage): void {
    if (!this.channel) return;
    // The feed channel is shared: a frame addressed to one user, or a change to
    // a personal-layer doc, is never posted to it.
    if (msg.audience || (msg.payload as { personal?: unknown } | null)?.personal === true) return;
    // Per-channel enablement (no feature store ⇒ all on): skip the whole feed for
    // this channel, or just a line whose event-kind is disabled here.
    const kind = feedKindForType(msg.type);
    // The daily digest can be turned on by itself (`feed digest on`) with the
    // per-event feed master off, so it skips that gate and answers only to its
    // own kind toggle (off by default); every other kind passes the master first.
    if (kind !== "digest" && this.features && !this.features.feedEnabled(this.channel)) return;
    if (kind && this.features && !this.features.feedKindEnabled(this.channel, kind)) return;
    // The flat "needs input" line is a duplicate surface ONLY when Asks actually
    // posts the ask card into the session thread — which it does only when the
    // mirror AND the channel's `asks` feature are both on (see asks.ts onAskNew,
    // gated on channelAsksEnabled). Suppress the flat line exactly in that case.
    // When either is off (mirror off ⇒ ask goes to a DM/nowhere; asks off ⇒ no
    // in-thread card is posted), this flat feed line is the channel's only in-channel
    // surface for the blocking ask, so it must be kept — dropping it on mirror state
    // alone would let a `feed on` + `asks off` channel silently swallow asks.
    if (msg.type === "ask:new" && this.threadResolver && this.mirrorEnabledHere() && this.asksEnabledHere()) return;
    // Collapse a launch's repeated `launch:started` frames to ONE feed line.
    if (msg.type === "launch:started") {
      const id = (msg.payload as Launch | null)?.id;
      if (id) {
        if (this.handledLaunches.has(id)) return;
        this.handledLaunches.add(id);
      }
    }
    const target = this.channel;
    this.tail = this.tail.then(async () => {
      try {
        const sessionId = sessionIdOf(msg);
        const title = sessionId ? await this.collector.sessionTitle(sessionId) : undefined;
        const line = feedLine(msg, title);
        if (!line) return;
        // Thread the line under the session's mirror thread when there is one;
        // otherwise (e.g. launches, or mirror off) post at channel root.
        const rootTs = sessionId && this.threadResolver ? this.threadResolver(sessionId) : undefined;
        await this.web.chat.postMessage({
          channel: target,
          ...(rootTs ? { thread_ts: rootTs } : {}),
          text: line,
          unfurl_links: false,
        });
      } catch (err) {
        console.error(`[feed] post failed (${msg.type}):`, err instanceof Error ? err.message : err);
      }
    });
  }
}

/** sessionId lives on the payload for the session-scoped events we forward. */
function sessionIdOf(msg: WsMessage): string | undefined {
  const p = msg.payload as { sessionId?: unknown } | null;
  return p && typeof p.sessionId === "string" ? p.sessionId : undefined;
}
