// Mirrors a Claude Code session into a per-session Slack thread. Driven by the
// collector's content-free event:new nudge: on it, debounce, PULL the rich
// transcript (GET /transcript/rich), project it to the channel-neutral
// OutputEvent model (turn-model.ts), and render each turn.
//
// A turn is ONE live message streamed through Slack's native Agent/Assistant API
// — chat.startStream(plan) → chat.appendStream (markdown_text for prose,
// task_update cards per tool call with running elapsed) → chat.stopStream, with
// assistant.threads.setStatus driving the "is …" line and a status-reaction
// lifecycle on the thread root. We NEVER chat.update after stopStream (it
// downgrades the streamed formatting). When chat.startStream is unavailable the
// mirror degrades to an edited Block-Kit placeholder (chat.update), rendered from
// the SAME event model. Completed turns are finalized in order — every
// intermediate one, so a burst of turns between renders never drops any. Because
// the tail is re-read each nudge, per-turn stream bookkeeping is in-memory (a
// stream can't survive a process restart); only durable facts persist.
// All content is redacted.

import type { KnownBlock } from "@slack/types";
import type { RichTranscriptPage } from "./collector-client.js";
import type { SessionThreads, SessionThread } from "./session-threads.js";
import type { SlackApi, StreamChunk, TaskCardChunk } from "./stream-client.js";
import { startStream, appendStream, stopStream, setThreadStatus } from "./stream-client.js";
import {
  renderTurn,
  turnFallback,
  planTitleForTurn,
  toolCardTitle,
  resultBodyMarkdown,
  markdownForEvent,
  statusLineForEvent,
  streamChunksForTurn,
  cardIdFor,
  humanDuration,
} from "./mirror-format.js";
import { parseRichTurns, turnPromptText, turnSignature, type OutputEvent, type Turn } from "./turn-model.js";
import type { ChannelFeatureStore } from "./channel-features.js";
import { redact } from "./redact.js";
import { sessionShareUrl } from "@standup/shared";

const DEBOUNCE_MS = 1500; // coalesce a burst of hook events into one re-render
const TRANSCRIPT_LIMIT = 120; // tail window pulled per re-render (rich rows — a turn is several)
const BACKFILL_TURNS = 6; // cap the initial history posted when a thread opens
const POST_GAP_MS = 250; // gentle spacing between Slack calls within one pass
const STATUS_DEBOUNCE_MS = 700; // debounce status-reaction flapping
const SEEN_CAP = 400; // bound the per-session posted-turn set

/** SessionStatus (+ synthetic "stalled") → reaction name on the thread root. */
const STATUS_REACTION: Record<string, string> = {
  running: "gear",
  waiting: "hourglass_flowing_sand",
  idle: "zzz",
  done: "checkered_flag",
  stalled: "snail",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The collector surface the mirror reads — narrowed so a fake needs no WebSocket. */
export interface MirrorTranscriptSource {
  getRichTranscript(sessionId: string, limit?: number): Promise<RichTranscriptPage | null>;
  sessionTitle(sessionId: string): Promise<string>;
}

/** Optional identity + clock the streaming API needs; injectable for tests. */
export interface MirrorOptions {
  /** Bot user id — the stream recipient placeholder (channel threads have no assistant recipient). */
  botUserId?: string;
  /** Workspace team id from auth.test — chat.startStream's recipient_team_id. */
  teamId?: string;
  /** Wall clock, injectable so elapsed/footers are deterministic in tests. */
  now?: () => number;
  /** Per-channel toggles (shared with Feed/Asks). Absent ⇒ mirror always on. */
  features?: ChannelFeatureStore;
}

/** In-memory bookkeeping for a session's one open live turn (not persisted). */
interface LiveStream {
  mode: "stream" | "fallback";
  /** ts of the streamed / placeholder message. */
  ts: string;
  /** Turn key this message belongs to. */
  turnKey: string;
  /** Count of leading turn events already emitted at least once. */
  emitted: number;
  /** Card ids emitted as `in_progress` whose result was still pending. */
  pending: Set<string>;
  /** Card id → its stable `Name · detail` title, so a `complete` update matches. */
  cardTitle: Map<string, string>;
  /** Card id → wall clock at open, for the running-elapsed suffix. */
  cardOpenedAt: Map<string, number>;
  /** Fallback path only: last rendered turn signature, to skip no-op chat.update. */
  sig?: string;
  /**
   * Leading turn events this message leaves out, because an earlier message
   * (finalized when the session ended) already shows them. `emitted` and `sig`
   * count from here.
   */
  from?: number;
}

/** The part of `turn` a live message starting at event `from` shows. */
function shownPart(turn: Turn, from: number | undefined): Turn {
  return from ? { ...turn, events: turn.events.slice(from) } : turn;
}

/**
 * Where a message continuing the turn that was live when the session ended
 * starts, or null when the turn has nothing new since: the first event the
 * ended message didn't show, or the call of the earliest tool still in
 * progress then (its result resolves in place, below that point), so the
 * card is shown again with its result.
 */
function endedTailFrom(b: SessionThread, turn: Turn): number | null {
  if (b.endedEmitted === undefined) return null;
  const pending = new Set(b.endedPending ?? []);
  const callAt = turn.events.findIndex((e) => e.kind === "tool_call" && pending.has(cardIdFor(e.id)));
  const resolved = turn.events.some(
    (e) => e.kind === "tool_result" && pending.has(cardIdFor(e.id)) && e.result.kind !== "pending",
  );
  if (turn.events.length <= b.endedEmitted && !resolved) return null;
  return callAt >= 0 ? Math.min(callAt, b.endedEmitted) : b.endedEmitted;
}

/**
 * Card ids of the tools in `turn` still running. The fallback message tracks
 * them so an end records them as the streamed path's `pending` does.
 */
function pendingCards(turn: Turn): Set<string> {
  const pending = new Set<string>();
  for (const e of turn.events) {
    if (e.kind === "tool_result" && e.result.kind === "pending") pending.add(cardIdFor(e.id));
  }
  return pending;
}

function clearEndedTail(b: SessionThread): void {
  b.endedEmitted = undefined;
  b.endedPending = undefined;
}

export class Mirror {
  private channel: string | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly creating = new Map<string, Promise<SessionThread | null>>();
  private readonly statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly desiredStatus = new Map<string, string>();
  // Last SessionStatus seen per session — a turn-phase root reaction / "is …" line
  // is only asserted while it is "running"; anything else is a between-turns idle state.
  private readonly lastStatus = new Map<string, string>();
  // Per-session open live turn + posted-turn set (in-memory: a stream can't
  // survive a restart, so this state is rebuilt lazily on the next nudge).
  private readonly live = new Map<string, LiveStream>();
  private readonly seenKeys = new Map<string, Set<string>>();
  // Workspace capability for the native streaming API: null = untested,
  // true = use it, false = permanently degraded to the Block-Kit fallback.
  private streamingAvailable: boolean | null = null;
  private readonly botUserId?: string;
  private readonly teamId?: string;
  private readonly now: () => number;
  private readonly features?: ChannelFeatureStore;

  constructor(
    private readonly api: SlackApi,
    private readonly collector: MirrorTranscriptSource,
    private readonly store: SessionThreads,
    // Base URL of the web console, for the "Open in Standup" link on the root.
    private readonly webUrl: string,
    opts: MirrorOptions = {},
  ) {
    this.botUserId = opts.botUserId;
    this.teamId = opts.teamId;
    this.now = opts.now ?? Date.now;
    this.features = opts.features;
  }

  setChannel(channel: string | undefined): void {
    this.channel = channel && channel.trim() ? channel.trim() : undefined;
  }

  /** On only when a channel is set AND its mirror feature isn't turned off there. */
  isEnabled(): boolean {
    return this.isEnabledFor(this.channel);
  }

  /** Whether the mirror feature is on for a specific channel (a binding's own channel). */
  private isEnabledFor(channel: string | undefined): boolean {
    return !!channel && (!this.features || this.features.mirrorEnabled(channel));
  }

  /**
   * The single gate every mirror method that touches Slack for a SPECIFIC binding
   * must use: the binding belongs to the current feed channel AND the mirror
   * feature is on for that channel. Keying the feature lookup on the binding's OWN
   * channel (not the global this.channel) is what stops a render / event / status /
   * end path from streaming into a binding whose channel has mirror off after the
   * operator moved the feed elsewhere or muted the old channel. Requiring the
   * binding to equal the current feed channel is what keeps a `standup off` — which
   * clears the channel's overrides AND unsets the feed channel — from leaking into
   * a channel the operator tore down, and a feed moved to another channel from
   * leaking into the old one whatever its own toggle says.
   */
  private enabledForBinding(b: SessionThread): boolean {
    return b.channel === this.channel && this.isEnabledFor(b.channel);
  }

  /** The root ts of a session's thread while it is still mirrored, else undefined. */
  liveRootFor(sessionId: string): string | undefined {
    const b = this.store.get(sessionId);
    return b && this.enabledForBinding(b) ? b.rootTs : undefined;
  }

  sessionForRoot(rootTs: string): string | undefined {
    return this.store.sessionForRoot(rootTs);
  }

  /** Heal any thread whose root still shows a placeholder title (real title now ready). */
  async reconcileTitles(): Promise<void> {
    if (!this.isEnabled()) return;
    for (const b of this.store.all()) {
      if (b.titleFinal || !this.enabledForBinding(b)) continue;
      const real = await this.collector.sessionTitle(b.sessionId);
      if (!real || real === b.sessionId.slice(0, 8)) continue;
      if (real !== b.title) {
        b.title = real;
        await this.update(b, b.rootTs, this.rootBlocks(b.sessionId, real), `🧵 session: ${redact(real)}`);
        await sleep(POST_GAP_MS);
      }
      b.titleFinal = true;
      this.store.set(b);
    }
  }

  /** Ensure the session has a thread (create + persist if not). Deduped per session. */
  async ensureThread(sessionId: string): Promise<SessionThread | null> {
    if (!this.isEnabled()) return null;
    const existing = this.store.get(sessionId);
    if (existing && this.enabledForBinding(existing)) return existing;
    const inflight = this.creating.get(sessionId);
    if (inflight) return inflight;
    const p = this.doCreateThread(sessionId).finally(() => this.creating.delete(sessionId));
    this.creating.set(sessionId, p);
    return p;
  }

  private async doCreateThread(sessionId: string): Promise<SessionThread | null> {
    if (!this.channel) return null;
    const existing = this.store.get(sessionId);
    if (existing && existing.channel === this.channel) return existing;

    // The collector's real (Haiku) title lands a few seconds after the first
    // prompt, so it's usually not ready yet. Seed from the first prompt so the
    // root isn't a bare id; render() upgrades it once the real title lands.
    const real = await this.collector.sessionTitle(sessionId);
    const shortId = sessionId.slice(0, 8);
    const titleFinal = real !== shortId;
    const title = titleFinal ? real : ((await this.firstPromptTitle(sessionId)) ?? shortId);
    const res = await this.api.call("chat.postMessage", {
      channel: this.channel,
      text: `🧵 session: ${redact(title)}`,
      blocks: this.rootBlocks(sessionId, title),
    });
    if (!res.ok || !res.ts) {
      console.error(`[mirror] failed to open thread for ${sessionId}: ${res.error}`);
      return null;
    }
    const now = new Date().toISOString();
    const binding: SessionThread = {
      sessionId,
      channel: this.channel,
      rootTs: res.ts,
      title,
      titleFinal,
      createdAt: now,
      lastActivityAt: now,
      backfilled: false,
    };
    this.store.set(binding); // set() persists new bindings synchronously
    return binding;
  }

  /**
   * Reflect session status as a single emoji reaction on the thread root: zero
   * extra messages, debounced. `status` is a SessionStatus or "stalled". The
   * live-turn phase (thinking / tool) overrides this while a turn runs (render()).
   */
  onStatus(sessionId: string, status: string): void {
    // Gate on the binding's OWN channel when one exists — a session bound to a muted
    // or moved-away channel must not schedule a status reaction there just because
    // the current feed channel still has the mirror on. With no binding yet (status
    // arriving before the thread is created), gate on the current feed channel.
    const b = this.store.get(sessionId);
    if (b ? !this.enabledForBinding(b) : !this.isEnabled()) return;
    this.lastStatus.set(sessionId, status);
    const name = STATUS_REACTION[status];
    if (!name) return;
    this.desiredStatus.set(sessionId, name);
    if (this.statusTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.statusTimers.delete(sessionId);
      void this.applyStatus(sessionId);
    }, STATUS_DEBOUNCE_MS);
    this.statusTimers.set(sessionId, t);
  }

  private async applyStatus(sessionId: string): Promise<void> {
    const b = this.store.get(sessionId);
    if (!b) return; // thread not created yet — reapplied at the end of render()
    // A status timer scheduled while the mirror was ON can still fire after the
    // channel is muted (`mirror off`) or torn down (`standup off`, which clears the
    // channel's feature entry AND unsets the mirror channel). The per-binding gate
    // skips the Slack side-effects unless the mirror is live for this binding's own
    // channel, so a late timer can't clear the "is …" line or swap a reaction on a
    // thread the operator muted or removed.
    if (!this.enabledForBinding(b)) return;
    // A non-running session has no live turn, so clear any stale "is …" line the
    // last append left behind (the lifecycle's terminal "clear" phase).
    const st = this.lastStatus.get(sessionId);
    if (st && st !== "running") await setThreadStatus(this.api, b.channel, b.rootTs, "");
    const name = this.desiredStatus.get(sessionId);
    if (!name || b.statusReaction === name) return;
    const prev = b.statusReaction;
    b.statusReaction = name;
    this.store.set(b);
    if (prev) {
      await this.api.call("reactions.remove", { channel: b.channel, timestamp: b.rootTs, name: prev });
    }
    await this.api.call("reactions.add", { channel: b.channel, timestamp: b.rootTs, name });
  }

  /**
   * Re-render every active mirror thread from its current transcript. Driven by
   * WS reconnect (via refreshAndResync) and a slow backstop timer: the mirror
   * self-heals per nudge for a session that keeps emitting, but a session that
   * advanced then went idle DURING an outage emits no further nudge, so its
   * thread would strand on stale content. Re-enqueueing a render pulls the fresh
   * tail and streams the delta through the same s2 path. Ended threads and
   * threads bound to a different channel are skipped; the render is a no-op when
   * nothing changed (emitDelta sends no chunks past the emitted offset). Awaits
   * every enqueued render so callers/tests can sequence after the resync.
   */
  async resyncActive(): Promise<void> {
    if (!this.isEnabled()) return;
    const pending: Promise<void>[] = [];
    for (const b of this.store.all()) {
      if (b.ended || !this.enabledForBinding(b)) continue;
      this.enqueue(b.sessionId);
      const p = this.chains.get(b.sessionId);
      if (p) pending.push(p);
    }
    await Promise.all(pending);
  }

  /** A hook event arrived for this session — schedule a coalesced re-render. */
  onEvent(sessionId: string): void {
    // Gate on the binding's OWN channel when one exists — a nudge for a session
    // bound to a muted or moved-away channel must not re-render there just because
    // the current feed channel still has the mirror on. With no binding yet (a
    // brand-new session), gate on the current feed channel, where renderSession
    // will create the thread.
    const b = this.store.get(sessionId);
    if (b ? !this.enabledForBinding(b) : !this.isEnabled()) return;
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.enqueue(sessionId);
    }, DEBOUNCE_MS);
    this.timers.set(sessionId, timer);
  }

  /**
   * An ended session sent hooks again (SessionEnd is not terminal, and the
   * collector ends a long-silent session on a guess) — reopen its thread so
   * renders and resyncs pick it back up, and render what it has done since.
   */
  onRevived(sessionId: string): void {
    const b = this.store.get(sessionId);
    if (!b?.ended) return;
    b.ended = false;
    this.store.set(b);
    this.onEvent(sessionId);
  }

  /**
   * Session ended — finalize the open stream + post a marker once (idempotent).
   * `marker: false` finalizes without the "session ended" post.
   */
  async onSessionEnd(sessionId: string, { marker = true }: { marker?: boolean } = {}): Promise<void> {
    const b = this.store.get(sessionId);
    if (!b || b.ended) return;
    b.ended = true;
    this.store.set(b);
    const ls = this.live.get(sessionId);
    // Emit the visible finalization (stopStream, status clear, "session ended"
    // marker) only when the per-binding gate is live for this binding's own channel.
    // A channel that was muted (`mirror off`) or torn down (`standup off`, which
    // clears the channel's feature entry AND unsets the mirror channel) receives
    // nothing. Local bookkeeping below (flip ended, drop in-memory + persisted live
    // state) runs unconditionally so a re-enabled render can't re-stream a finalized
    // session.
    const enabled = this.enabledForBinding(b);
    // The last turn is finished as far as this thread goes: a revive that brings
    // no new turn (onRevived) must not reopen it as a whole-turn duplicate. How
    // much of it the live message showed is kept, so a revive that carries on
    // with the turn posts only the rest. With no live message in memory, the
    // persisted live record says how far it got (a restart drops the memory,
    // and the seen-set with it); with neither, an earlier end's record stands,
    // and a turn never shown is shown whole.
    if (b.lastTurnKey) {
      if (ls && ls.turnKey === b.lastTurnKey) {
        b.endedEmitted = (ls.from ?? 0) + ls.emitted;
        b.endedPending = ls.pending.size ? [...ls.pending] : undefined;
      } else if (b.liveTs && b.liveMode) {
        b.endedEmitted = (b.liveFrom ?? 0) + (b.liveEmitted ?? 0);
        b.endedPending = b.livePending?.length ? b.livePending.map((c) => c.id) : undefined;
        // A stream adopted from before a restart is finalized too.
        if (enabled && b.liveMode === "stream") await stopStream(this.api, b.channel, b.liveTs);
      } else if (b.endedEmitted === undefined && !this.hasSeen(sessionId, b.lastTurnKey)) {
        b.endedEmitted = 0;
        b.endedPending = undefined;
      }
      this.markSeen(sessionId, b.lastTurnKey);
    }
    this.store.set(b);
    // Its last status is over too; a revived thread takes the next one it is sent.
    this.lastStatus.delete(sessionId);
    this.desiredStatus.delete(sessionId);
    if (enabled && ls && ls.mode === "stream") {
      await stopStream(this.api, b.channel, ls.ts);
    }
    this.live.delete(sessionId);
    this.clearPersistedLive(b);
    // A revive landing while the stream stopped takes the thread back; it gets no end marker.
    if (!enabled || !b.ended) return;
    await setThreadStatus(this.api, b.channel, b.rootTs, ""); // no live turn — clear the "is …" line
    if (!b.ended || !marker) return;
    await this.api.call("chat.postMessage", { channel: b.channel, thread_ts: b.rootTs, text: "🏁 session ended" });
  }

  /**
   * Session deleted at the collector — unlink its thread binding (clearing BOTH
   * the forward map and the reverse rootTs→session index) and drop all in-memory
   * per-session state so a stale link can't misroute a later thread reply or leak
   * a pending timer. No Slack calls: the session is gone, there's nothing to post.
   */
  onSessionDeleted(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) clearTimeout(t);
    this.timers.delete(sessionId);
    const st = this.statusTimers.get(sessionId);
    if (st) clearTimeout(st);
    this.statusTimers.delete(sessionId);
    this.live.delete(sessionId);
    this.seenKeys.delete(sessionId);
    this.chains.delete(sessionId);
    this.creating.delete(sessionId);
    this.desiredStatus.delete(sessionId);
    this.lastStatus.delete(sessionId);
    this.store.delete(sessionId);
  }

  // Serialize re-renders per session so two passes can't race on the binding.
  private enqueue(sessionId: string): void {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(() => this.renderSession(sessionId)).catch((err) => {
      console.error(`[mirror] render failed for ${sessionId}:`, err instanceof Error ? err.message : err);
    });
    this.chains.set(sessionId, next);
  }

  /**
   * Re-render a session's thread from the current rich-transcript tail. Public
   * because the debounce chain (and the golden test) drive it directly.
   */
  async renderSession(sessionId: string): Promise<void> {
    if (!this.isEnabled()) return;
    const page = await this.collector.getRichTranscript(sessionId, TRANSCRIPT_LIMIT);
    if (!page || page.rows.length === 0) return;

    const binding = this.store.get(sessionId) ?? (await this.ensureThread(sessionId));
    if (!binding) return;
    // Gate on the binding's OWN channel, not the current feed channel: a nudge for a
    // session bound to a channel the operator muted (`mirror off`) or moved away from
    // must never stream into that channel just because the CURRENT feed channel still
    // has the mirror on. The top-of-method isEnabled() short-circuit is a cheap
    // current-channel guard; this is the authoritative per-binding gate.
    if (!this.enabledForBinding(binding)) return;
    // A late nudge can land after onSessionEnd (the final transcript write and the
    // end signal race) — never re-stream a finalized session below the end marker.
    if (binding.ended) return;

    const turns = parseRichTurns(page.rows);
    if (turns.length === 0) return;
    const last = turns[turns.length - 1]!;

    await this.maybeUpgradeTitle(binding, turns);

    // Re-adopt a live stream whose in-memory bookkeeping was lost to a restart, so
    // the turn resumes from its persisted offset instead of re-streaming from zero.
    this.resumeLiveIfLost(sessionId, binding);

    // Post-restart idempotency. The posted-turn set (seenKeys) is in-memory only,
    // so it is empty after this adapter restarts — and `bun run --watch` restarts
    // it on every source change. Without this, the reconnect resync would treat
    // every already-mirrored thread's tail as unposted and re-stream it (the
    // `else if (!hasSeen(last.key)) openLive` path below), flooding every idle
    // thread with a duplicate — and, for tool-only turns, an empty — message on
    // each restart. The persisted `lastTurnKey` is the durable record of how far
    // we posted: every turn at or before it was already streamed last time. Seed
    // the seen-set from it exactly once per session per process (the first render
    // is the only time seenKeys has no entry yet).
    if (binding.backfilled && binding.lastTurnKey && !this.seenKeys.has(sessionId)) {
      const postedThrough = turns.findIndex((t) => t.key === binding.lastTurnKey);
      // Not found → lastTurnKey aged out of the window, so every turn here is newer
      // than it (genuinely unposted) — mark nothing. Found → mark it and all prior.
      if (postedThrough >= 0) {
        for (const t of turns.slice(0, postedThrough + 1)) this.markSeen(sessionId, t.key);
      }
    }

    // Post initial history ONCE (in order), capped. Mark ALL completed turns in
    // the window as seen so older history is never posted on a later render.
    if (!binding.backfilled) {
      const completed = turns.slice(0, -1);
      for (const t of completed) this.markSeen(sessionId, t.key);
      for (const t of completed.slice(-(BACKFILL_TURNS - 1))) {
        await this.postCompletedTurn(binding, t);
        await sleep(POST_GAP_MS);
      }
      binding.backfilled = true;
      this.store.set(binding);
    }

    // Did this pass actually stream live turn activity? Gates the root reaction so
    // a content-free re-render (e.g. a reconnect resync of a dormant session) can't
    // fabricate a live phase — see the tail below.
    let advanced = false;
    if (binding.lastTurnKey !== last.key) {
      // A new live turn appeared. Finalize the previous one, then post EVERY
      // intermediate completed turn — the turn-skip fix (a burst or a
      // post-reconnect catch-up must not drop whole turns), then open the new one.
      await this.finalizeLive(sessionId, binding, turns);
      if (binding.lastTurnKey) this.markSeen(sessionId, binding.lastTurnKey);
      // The turn live when the session ended, finished after a revive: post
      // what it did after the end.
      if (binding.endedEmitted !== undefined) {
        const endedTurn = turns.find((t) => t.key === binding.lastTurnKey);
        const from = endedTurn ? endedTailFrom(binding, endedTurn) : null;
        if (endedTurn && from !== null) {
          await this.postCompletedTurn(binding, shownPart(endedTurn, from));
          await sleep(POST_GAP_MS);
        }
        clearEndedTail(binding);
      }
      for (const t of turns.slice(0, -1)) {
        if (!this.hasSeen(sessionId, t.key)) {
          await this.postCompletedTurn(binding, t);
          this.markSeen(sessionId, t.key);
          await sleep(POST_GAP_MS);
        }
      }
      await this.openLive(sessionId, binding, last, page.contextTokens);
      binding.lastTurnKey = last.key;
      this.store.set(binding);
      advanced = true;
    } else {
      // The same live turn continues — emit the delta. A stream- or fallback-mode turn
      // whose in-memory record was lost to a restart was already re-adopted above. Reach
      // the open here only with NO resumable record: either its live message was never
      // opened, or its stream was permanently abandoned mid-turn (and marked seen). Only
      // open a fresh message for a turn we have NOT already emitted — otherwise a
      // content-free resync (the s4 backstop / reconnect) would re-post a whole-turn
      // duplicate of an already-shown turn.
      const ls = this.live.get(sessionId);
      if (ls) advanced = await this.emitDelta(sessionId, binding, ls, last);
      else if (!this.hasSeen(sessionId, last.key)) {
        await this.openLive(sessionId, binding, last, page.contextTokens);
        advanced = true;
      } else {
        // The turn live when the session ended carries on after a revive: a
        // fresh message continues it from where the ended one stopped.
        const from = endedTailFrom(binding, last);
        if (from !== null && (await this.openLive(sessionId, binding, last, page.contextTokens, from))) {
          clearEndedTail(binding);
          this.store.set(binding);
          advanced = this.live.has(sessionId);
        }
      }
    }

    // Root reaction reflects the live turn's phase only while we have positive
    // evidence the turn is progressing — a live "running" status, or a delta THIS
    // render just streamed. A known non-running status (idle/waiting/done) shows the
    // session-status reaction instead. With NO live status AND nothing streamed this
    // pass (e.g. a reconnect resync re-rendering a session that has been dormant
    // since before this process started, so lastStatus — in-memory only — is empty),
    // the persisted root reaction is left untouched rather than overwritten with a
    // fabricated live phase.
    const st = this.lastStatus.get(sessionId);
    if (st && st !== "running") {
      this.desiredStatus.set(sessionId, STATUS_REACTION[st] ?? turnReaction(last));
      await this.applyStatus(sessionId);
    } else if (st === "running" || advanced) {
      this.desiredStatus.set(sessionId, turnReaction(last));
      await this.applyStatus(sessionId);
    }
  }

  /** Rebuild a lost-in-memory live stream from its persisted ts + offset (post-restart resume). */
  private resumeLiveIfLost(sessionId: string, b: SessionThread): void {
    if (this.live.has(sessionId)) return;
    if (!b.liveTs || !b.liveMode || !b.lastTurnKey) return;
    // A live record for the turn supersedes an ended-turn offset: the adopted
    // message carries on from its own.
    clearEndedTail(b);
    if (b.liveMode === "fallback") {
      // Re-adopt the edited Block-Kit placeholder so the turn keeps editing the SAME
      // message (chat.update) instead of posting a fresh duplicate. The persisted
      // signature makes a content-free resync a true no-op (emitDelta skips), while a
      // turn that grew during the outage still re-renders in place.
      const ls = newLiveStream("fallback", b.liveTs, b.lastTurnKey);
      ls.emitted = b.liveEmitted ?? 0;
      ls.from = b.liveFrom;
      ls.sig = b.liveSig;
      this.live.set(sessionId, ls);
      return;
    }
    if (this.streamingAvailable === false) return; // streaming known dead — a stream can't be resumed
    const ls = newLiveStream("stream", b.liveTs, b.lastTurnKey);
    ls.emitted = b.liveEmitted ?? 0; // resume from the offset — do NOT re-emit prior events
    ls.from = b.liveFrom;
    // Restore the in-flight tool cards. Their tool_result sits below `emitted`, so
    // without this the pending-resolution loop finds nothing and the newly-appended
    // loop skips past it — the card would stay in_progress forever and its output
    // body (bash stdout / diff / …) would be dropped when the tool finally resolves.
    for (const c of b.livePending ?? []) {
      ls.pending.add(c.id);
      ls.cardTitle.set(c.id, c.title);
      ls.cardOpenedAt.set(c.id, c.openedAt);
    }
    this.live.set(sessionId, ls);
  }

  // ---- live-turn streaming ------------------------------------------------

  /** Open a stream for the live turn; degrade to a Block-Kit placeholder if unavailable. */
  /**
   * Opens the live message for `turn` from event `from`. Returns whether it
   * tried (the shown part had something to render) and the session did not
   * end meanwhile — the caller's cue to drop an ended-turn record it was
   * continuing, whether or not Slack took the message, so a message Slack
   * keeps refusing isn't retried on every render.
   */
  private async openLive(sessionId: string, b: SessionThread, turn: Turn, contextTokens: number, from = 0): Promise<boolean> {
    const shown = shownPart(turn, from);
    // Don't open a message for a turn with nothing to show yet (e.g. its only
    // in-window event is a pending tool_result whose call aged out): a stream
    // would open blank, and the caller leaves lastTurnKey pointing here so the
    // next nudge re-opens it once real content lands.
    if (!turnHasRenderableContent(shown)) return false;
    if (this.streamingAvailable !== false) {
      const res = await startStream(this.api, {
        channel: b.channel,
        threadTs: b.rootTs,
        recipientTeamId: this.teamId,
        recipientUserId: this.botUserId,
        planTitle: planTitleForTurn(shown),
      });
      // The session ended while the stream opened (onSessionEnd isn't
      // serialized with renders): close it unused and leave the end's record.
      if (b.ended) {
        if (res.ts) await stopStream(this.api, b.channel, res.ts);
        return false;
      }
      if (res.ts) {
        if (this.streamingAvailable !== true)
          console.error("[mirror] native streaming active — chat.startStream ok (task cards)");
        this.streamingAvailable = true;
        const ls = newLiveStream("stream", res.ts, turn.key);
        if (from) ls.from = from;
        this.live.set(sessionId, ls);
        await this.emitDelta(sessionId, b, ls, turn);
        return true;
      }
      // Only a true availability block flips us to the fallback permanently; a
      // transient/param error just degrades this one turn.
      if (res.unavailable) {
        console.error(
          `[mirror] native streaming unavailable (chat.startStream → ${res.error}) — using the Block-Kit fallback permanently. Enable the Slack Assistant/streaming API for this app (agent feature + required scope/token type) to get task cards.`,
        );
        this.streamingAvailable = false;
      } else if (res.error) {
        console.error(`[mirror] chat.startStream failed this turn (${res.error}) — Block-Kit fallback for this turn only`);
      }
    }
    const ts = await this.post(b, renderTurn(shown, this.footer(shown, contextTokens)), turnFallback(shown));
    if (b.ended) {
      // Ended while the message posted: it shows the whole shown part, so
      // that is how far a revive's continuation starts.
      if (ts) {
        b.endedEmitted = from + shown.events.length;
        const pending = pendingCards(shown);
        b.endedPending = pending.size ? [...pending] : undefined;
        this.markSeen(sessionId, turn.key);
        this.store.set(b);
      }
      return false;
    }
    if (ts) {
      const ls = newLiveStream("fallback", ts, turn.key);
      if (from) ls.from = from;
      ls.emitted = shown.events.length;
      ls.sig = turnSignature(shown);
      ls.pending = pendingCards(shown);
      this.live.set(sessionId, ls);
      this.persistLive(b, ls);
    }
    return true;
  }

  /**
   * Emit the not-yet-streamed part of the live turn, preserving row order.
   * Returns whether this pass actually streamed turn activity (new chunks, or a
   * fallback re-render) — a no-op delta returns false, which the caller uses to
   * decide the root reaction (see renderSession's tail).
   */
  private async emitDelta(sessionId: string, b: SessionThread, ls: LiveStream, fullTurn: Turn): Promise<boolean> {
    const turn = shownPart(fullTurn, ls.from);
    if (ls.mode === "fallback") {
      const sig = turnSignature(turn);
      if (sig !== ls.sig) {
        await this.update(b, ls.ts, renderTurn(turn, this.footer(turn)), turnFallback(turn));
        ls.sig = sig;
        ls.emitted = turn.events.length;
        ls.pending = pendingCards(turn);
        if (b.ended) return true; // ended during the update: its live record stays cleared
        this.persistLive(b, ls); // persist the latest signature so a post-restart resync no-ops
        return true;
      }
      return false;
    }

    const chunks: StreamChunk[] = [];
    let status: string | undefined;

    // 1) Resolve pending cards FIRST, so a late result never lands after newer
    //    prose (a tool blocks the turn, so its result predates any later rows).
    for (const cardId of [...ls.pending]) {
      const ev = turn.events.find(
        (e): e is Extract<OutputEvent, { kind: "tool_result" }> =>
          e.kind === "tool_result" && cardIdFor(e.id) === cardId,
      );
      if (ev && ev.result.kind !== "pending") {
        chunks.push(this.completeCard(ls, cardId, ev.name, resultBodyMarkdown(ev.result)));
        ls.pending.delete(cardId);
      }
    }

    // 2) Newly-appended events, in order.
    for (let i = ls.emitted; i < turn.events.length; i++) {
      const e = turn.events[i]!;
      if (e.kind === "tool_call") {
        const cardId = cardIdFor(e.id);
        const title = toolCardTitle(e.name, e.input);
        ls.cardTitle.set(cardId, title);
        ls.cardOpenedAt.set(cardId, this.now());
        chunks.push({ type: "task_update", id: cardId, title, status: "in_progress" });
        status = statusLineForEvent(e) ?? status;
      } else if (e.kind === "tool_result") {
        const cardId = cardIdFor(e.id);
        if (e.result.kind === "pending") {
          ls.pending.add(cardId); // leave its card in_progress until it resolves
        } else {
          chunks.push(this.completeCard(ls, cardId, e.name, resultBodyMarkdown(e.result)));
        }
      } else {
        const md = markdownForEvent(e);
        if (md) chunks.push({ type: "markdown_text", text: md });
        status = statusLineForEvent(e) ?? status;
      }
    }
    ls.emitted = turn.events.length;

    if (chunks.length) {
      let ok = await appendStream(this.api, b.channel, ls.ts, chunks);
      // The session ended during the append (onSessionEnd isn't serialized with
      // renders): its stream is stopped and its live record cleared, so neither
      // rotate into a fresh stream nor persist this one back.
      if (b.ended) return false;
      if (!ok) ok = await this.rotateStream(sessionId, b, ls, turn, chunks);
      if (!ok) {
        // Rotation gave up: the live message is abandoned mid-turn. Mark the turn seen
        // so a content-free resync won't re-open a whole-turn duplicate of it; a
        // genuinely new turn later still finalizes and advances past it normally.
        this.markSeen(sessionId, turn.key);
        this.clearPersistedLive(b);
        return false;
      }
    }
    this.persistLive(b, ls);
    if (status) await setThreadStatus(this.api, b.channel, b.rootTs, status);
    return chunks.length > 0;
  }

  /**
   * A `chat.appendStream` died mid-turn: finalize the orphaned message so it isn't
   * stuck "in progress", then continue the SAME turn in a fresh stream from the
   * current offset — the already-streamed prefix stays in the stopped message, so
   * nothing is re-emitted (no whole-turn duplication) and no message is abandoned.
   * Re-opens still-open task cards on the new stream so their later `complete`
   * flips in place. Returns false only when a fresh stream can't be opened.
   */
  private async rotateStream(
    sessionId: string,
    b: SessionThread,
    ls: LiveStream,
    turn: Turn,
    failedChunks: StreamChunk[],
  ): Promise<boolean> {
    await stopStream(this.api, b.channel, ls.ts);
    const res = await startStream(this.api, {
      channel: b.channel,
      threadTs: b.rootTs,
      recipientTeamId: this.teamId,
      recipientUserId: this.botUserId,
      planTitle: planTitleForTurn(turn),
    });
    if (!res.ts) {
      if (res.unavailable) {
        console.error(
          `[mirror] native streaming unavailable on rotate (chat.startStream → ${res.error}) — Block-Kit fallback permanently`,
        );
        this.streamingAvailable = false;
      }
      this.live.delete(sessionId);
      return false;
    }
    ls.ts = res.ts;
    // Cards whose in_progress lived in the now-finalized stream (still pending, or
    // completed only in the resent chunks) need re-opening so their complete flips
    // within the fresh message; skip those the resent chunks already open.
    const openedInChunks = new Set(
      failedChunks
        .filter((c): c is Extract<StreamChunk, { type: "task_update" }> => c.type === "task_update" && c.status === "in_progress")
        .map((c) => c.id),
    );
    const needReopen = new Set<string>(ls.pending);
    for (const c of failedChunks) if (c.type === "task_update" && c.status === "complete") needReopen.add(c.id);
    const reopen: StreamChunk[] = [];
    for (const id of needReopen) {
      if (openedInChunks.has(id)) continue;
      const title = ls.cardTitle.get(id);
      if (title) reopen.push({ type: "task_update", id, title, status: "in_progress" });
    }
    const ok = await appendStream(this.api, b.channel, ls.ts, [...reopen, ...failedChunks]);
    if (!ok) {
      this.live.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Persist the live stream's ts + offset + in-flight cards so a restart can resume it (durable fact). */
  private persistLive(b: SessionThread, ls: LiveStream): void {
    const livePending = ls.pending.size
      ? [...ls.pending].map((id) => ({
          id,
          title: ls.cardTitle.get(id) ?? id,
          openedAt: ls.cardOpenedAt.get(id) ?? this.now(),
        }))
      : undefined;
    if (
      b.liveTs === ls.ts &&
      b.liveMode === ls.mode &&
      b.liveEmitted === ls.emitted &&
      b.liveFrom === ls.from &&
      b.liveSig === ls.sig &&
      samePending(b.livePending, livePending)
    ) {
      return;
    }
    b.liveTs = ls.ts;
    b.liveMode = ls.mode;
    b.liveEmitted = ls.emitted;
    b.liveFrom = ls.from;
    b.liveSig = ls.sig;
    b.livePending = livePending;
    this.store.set(b);
  }

  /** Forget the persisted live stream — the turn finalized, ended, or its stream was abandoned. */
  private clearPersistedLive(b: SessionThread): void {
    if (
      b.liveTs === undefined &&
      b.liveMode === undefined &&
      b.liveEmitted === undefined &&
      b.liveFrom === undefined &&
      b.liveSig === undefined &&
      b.livePending === undefined
    ) {
      return;
    }
    b.liveTs = undefined;
    b.liveMode = undefined;
    b.liveEmitted = undefined;
    b.liveFrom = undefined;
    b.liveSig = undefined;
    b.livePending = undefined;
    this.store.set(b);
  }

  /**
   * A `complete` task_update reusing the card's opening title + running elapsed,
   * carrying the tool's result body as the card's collapsible `output` so it
   * renders inside the task block rather than as a loose inline code fence.
   */
  private completeCard(ls: LiveStream, cardId: string, name: string, output?: string): TaskCardChunk {
    const base = ls.cardTitle.get(cardId) ?? name;
    const opened = ls.cardOpenedAt.get(cardId);
    const elapsed = opened !== undefined ? this.now() - opened : undefined;
    const title = elapsed !== undefined && elapsed > 500 ? `${base} · ${humanDuration(elapsed)}` : base;
    const card: TaskCardChunk = { type: "task_update", id: cardId, title, status: "complete" };
    if (output) card.output = output;
    return card;
  }

  /** Flush the previous live turn's tail and finalize it (stopStream); mark it seen. */
  private async finalizeLive(sessionId: string, b: SessionThread, turns: Turn[]): Promise<void> {
    const ls = this.live.get(sessionId);
    if (!ls) return;
    const oldTurn = turns.find((t) => t.key === ls.turnKey);
    if (oldTurn) await this.emitDelta(sessionId, b, ls, oldTurn);
    if (ls.mode === "stream") {
      const cur = this.live.get(sessionId); // emitDelta may have dropped it on append failure
      if (cur && cur.ts === ls.ts) await stopStream(this.api, b.channel, ls.ts);
    }
    this.live.delete(sessionId);
    this.clearPersistedLive(b);
    this.markSeen(sessionId, ls.turnKey);
  }

  /** Post a completed (historical) turn as one finalized stream, or a static block set. */
  private async postCompletedTurn(b: SessionThread, turn: Turn): Promise<void> {
    // Nothing to say — e.g. a turn that is only a pending tool_result whose opening
    // call aged out of the tail window. Posting it would either open an empty
    // stream (startStream + stopStream, no chunks → a blank message) or a bare "…"
    // Block-Kit filler. Skip it entirely rather than mirror a content-free bubble.
    if (!turnHasRenderableContent(turn)) return;
    const chunks = streamChunksForTurn(turn);
    // A renderable turn with no STREAM chunks (a lone tool_call — the card only
    // emits once its result lands) must not open an empty stream; fall through to
    // the Block-Kit path, where renderTurn still shows the tool-call line.
    if (this.streamingAvailable !== false && chunks.length > 0) {
      const res = await startStream(this.api, {
        channel: b.channel,
        threadTs: b.rootTs,
        recipientTeamId: this.teamId,
        recipientUserId: this.botUserId,
        planTitle: planTitleForTurn(turn),
      });
      if (res.ts) {
        this.streamingAvailable = true;
        await appendStream(this.api, b.channel, res.ts, chunks);
        await stopStream(this.api, b.channel, res.ts);
        return;
      }
      if (res.unavailable) this.streamingAvailable = false;
    }
    await this.post(b, renderTurn(turn), turnFallback(turn));
  }

  // ---- posted-turn bookkeeping --------------------------------------------

  private markSeen(sessionId: string, key: string): void {
    let s = this.seenKeys.get(sessionId);
    if (!s) {
      s = new Set();
      this.seenKeys.set(sessionId, s);
    }
    s.add(key);
    if (s.size > SEEN_CAP) {
      // Keep the most recent half — turn keys age out of the tail window anyway.
      this.seenKeys.set(sessionId, new Set([...s].slice(-SEEN_CAP / 2)));
    }
  }

  private hasSeen(sessionId: string, key: string): boolean {
    return this.seenKeys.get(sessionId)?.has(key) ?? false;
  }

  // ---- root message + titles ----------------------------------------------

  /** Root-message blocks — shared by thread creation and title upgrades. */
  private rootBlocks(sessionId: string, title: string): KnownBlock[] {
    const shareUrl = sessionShareUrl(this.webUrl, sessionId);
    return [
      // Cap the (agent-authored) title before escaping so an over-long one can't
      // grow the section past Slack's 3000-char limit and reject the whole block.
      { type: "section", text: { type: "mrkdwn", text: `🧵 *${escapeMrkdwn(redact(title).slice(0, 200))}*` } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `\`${sessionId.slice(0, 8)}\` · <${shareUrl}|Open in Standup> · mirrored live · reply in-thread to answer`,
          },
        ],
      },
    ];
  }

  /** A short title cut from the session's first user prompt (pre-Haiku seed). */
  private async firstPromptTitle(sessionId: string): Promise<string | undefined> {
    const page = await this.collector.getRichTranscript(sessionId, 40);
    const prompt = page
      ? parseRichTurns(page.rows)
          .map(turnPromptText)
          .find((t): t is string => !!t)
      : undefined;
    if (!prompt) return undefined;
    const line = prompt.replace(/\s+/g, " ").trim();
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  }

  /** Replace the placeholder root title with the collector's real title when ready. */
  private async maybeUpgradeTitle(binding: SessionThread, turns: Turn[]): Promise<void> {
    if (binding.titleFinal) return;
    const shortId = binding.sessionId.slice(0, 8);
    const real = await this.collector.sessionTitle(binding.sessionId);
    let next = binding.title;
    let final = false;
    if (real && real !== shortId) {
      next = real;
      final = true;
    } else {
      const prompt = turns.map(turnPromptText).find((t): t is string => !!t);
      if (prompt) {
        const line = prompt.replace(/\s+/g, " ").trim();
        next = line.length > 80 ? `${line.slice(0, 79)}…` : line;
      }
    }
    if (final || (next !== binding.title && next !== shortId)) {
      binding.title = next;
      binding.titleFinal = final;
      this.store.set(binding);
      await this.update(binding, binding.rootTs, this.rootBlocks(binding.sessionId, next), `🧵 session: ${redact(next)}`);
    }
  }

  private async post(b: SessionThread, blocks: KnownBlock[], text: string): Promise<string | undefined> {
    const res = await this.api.call("chat.postMessage", {
      channel: b.channel,
      thread_ts: b.rootTs,
      blocks,
      text,
      unfurl_links: false,
    });
    if (!res.ok) console.error("[mirror] chat.postMessage failed:", res.error);
    return res.ts;
  }

  private async update(b: SessionThread, ts: string, blocks: KnownBlock[], text: string): Promise<void> {
    const res = await this.api.call("chat.update", { channel: b.channel, ts, blocks, text });
    if (!res.ok) console.error("[mirror] chat.update failed:", res.error);
  }

  /** Live-turn footer (elapsed / context) — used only on the fallback path. */
  private footer(turn: Turn, contextTokens = 0): string | undefined {
    return footerText(turn.startedAt, contextTokens, this.now);
  }
}

/**
 * Whether a turn has anything worth mirroring: a tool call (its card shows even
 * before the result), a resolved tool result, or any non-tool event that renders
 * to markdown. A turn of only a pending tool_result (its call aged out) has
 * nothing to show yet and must not post a content-free message.
 */
function turnHasRenderableContent(turn: Turn): boolean {
  return turn.events.some(
    (e) =>
      e.kind === "tool_call" ||
      (e.kind === "tool_result" && e.result.kind !== "pending") ||
      (e.kind !== "tool_result" && e.kind !== "done" && markdownForEvent(e) !== undefined),
  );
}

/** The root reaction for the live turn's phase (thinking / tool / responding). */
function turnReaction(turn: Turn): string {
  const hasPendingTool = turn.events.some((e) => e.kind === "tool_result" && e.result.kind === "pending");
  if (hasPendingTool) return "hammer_and_wrench"; // tool
  const last = turn.events[turn.events.length - 1];
  if (last?.kind === "thinking") return "thought_balloon"; // thinking
  return "speech_balloon"; // responding / working
}

/** Membership equality of two persisted in-flight-card lists (titles/openedAt are set once, so ids suffice). */
function samePending(a: SessionThread["livePending"], b: SessionThread["livePending"]): boolean {
  const ax = a ?? [];
  const bx = b ?? [];
  if (ax.length !== bx.length) return false;
  const bi = new Set(bx.map((c) => c.id));
  return ax.every((c) => bi.has(c.id));
}

function newLiveStream(mode: "stream" | "fallback", ts: string, turnKey: string): LiveStream {
  return { mode, ts, turnKey, emitted: 0, pending: new Set(), cardTitle: new Map(), cardOpenedAt: new Map() };
}

/** Escape mrkdwn control chars in the (agent-authored) title. */
function escapeMrkdwn(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Live-turn footer: elapsed since the turn started + current context size. */
function footerText(startedAt: string | undefined, contextTokens: number, now: () => number): string | undefined {
  const parts: string[] = [];
  if (startedAt) {
    const ms = now() - new Date(startedAt).getTime();
    if (Number.isFinite(ms) && ms >= 0) parts.push(`⏱ ${humanDuration(ms)}`);
  }
  if (contextTokens > 0) parts.push(`🧠 ${Math.round(contextTokens / 1000)}k ctx`);
  return parts.length ? parts.join("  ·  ") : undefined;
}
