import { statSync } from "fs";
import type { Database } from "bun:sqlite";
import { headSeq } from "@standup/store";
import type { WsMessage } from "@standup/shared";
import { transcriptPathForSession } from "./transcript.js";

type Broadcast = (message: WsMessage) => void;

interface WatchState {
  /** Resolved transcript file; null until the first successful resolve. */
  path: string | null;
  /** Last observed file size in bytes; -1 before the first stat (baseline). */
  size: number;
  /** Pending coalesce timer for this session's next nudge, or null. */
  debounce: ReturnType<typeof setTimeout> | null;
}

export interface TranscriptTailerOptions {
  /** How often watched files are stat'd for growth. */
  pollMs?: number;
  /** How long a burst of growth is coalesced before one nudge fires. */
  debounceMs?: number;
}

/**
 * Watches active sessions' transcript JSONL files for growth and emits a
 * content-free `session:event` nudge when one grows — the same frame the hook
 * path emits when the durable log advances.
 *
 * The mirror and web pull the rich transcript delta by re-reading the file
 * (readRichTranscript), so a long thinking/prose stretch with no tool calls —
 * which fires no Claude Code hook, hence no hook-driven nudge — still surfaces
 * near-live: the file grows, this tailer notices, and the nudge drives the pull.
 * The nudge alone suffices; hook-driven `transcript_events` ingest is untouched.
 *
 * Growth is detected by a single shared poll (fs.watch is unreliable across
 * platforms) and coalesced per session so Slack's append cadence and rate limit
 * stay near 1s. Watchers are keyed by session id and removed on end, so nothing
 * leaks once a session stops.
 */
export class TranscriptTailer {
  private readonly db: Database;
  private readonly broadcast: Broadcast;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private readonly watched = new Map<string, WatchState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database, broadcast: Broadcast, opts: TranscriptTailerOptions = {}) {
    this.db = db;
    this.broadcast = broadcast;
    this.pollMs = opts.pollMs ?? 500;
    this.debounceMs = opts.debounceMs ?? 800;
  }

  /**
   * Begin watching a session's transcript. Idempotent — a second call for an
   * already-watched session only fills in a path that wasn't known yet (e.g. the
   * first activation had no transcript_path). Starts the shared poll on the
   * first watched session.
   */
  watch(sessionId: string, path?: string): void {
    const existing = this.watched.get(sessionId);
    if (existing) {
      if (path && !existing.path) existing.path = path;
      return;
    }
    this.watched.set(sessionId, { path: path ?? null, size: -1, debounce: null });
    this.ensurePolling();
  }

  /** Stop watching a session and drop any pending nudge; a no-op if unwatched. */
  unwatch(sessionId: string): void {
    const state = this.watched.get(sessionId);
    if (!state) return;
    if (state.debounce) clearTimeout(state.debounce);
    this.watched.delete(sessionId);
    if (this.watched.size === 0) this.stopPolling();
  }

  /** Tear everything down — every watcher, every pending nudge, the poll. */
  stop(): void {
    for (const state of this.watched.values()) {
      if (state.debounce) clearTimeout(state.debounce);
    }
    this.watched.clear();
    this.stopPolling();
  }

  get watchCount(): number {
    return this.watched.size;
  }

  isWatching(sessionId: string): boolean {
    return this.watched.has(sessionId);
  }

  /**
   * One poll pass over every watched session. Runs on the shared interval;
   * exposed so a test can drive detection deterministically without waiting on
   * the poll clock. The first observation of a file only records its baseline
   * size, so pre-existing transcript content never triggers a nudge — only
   * growth after activation does.
   */
  tick(): void {
    for (const [sessionId, state] of this.watched) {
      if (!state.path) {
        state.path = transcriptPathForSession(this.db, sessionId);
        if (!state.path) continue;
      }
      let size: number;
      try {
        size = statSync(state.path).size;
      } catch {
        // File not present yet, or a transient stat error — try again next tick.
        continue;
      }
      if (state.size < 0) {
        state.size = size;
        continue;
      }
      if (size !== state.size) {
        // Growth is the live-turn signal; a shrink (truncation/rotation) just
        // re-baselines without a nudge.
        const grew = size > state.size;
        state.size = size;
        if (grew) this.armNudge(sessionId, state);
      }
    }
  }

  private fireNudge(sessionId: string, state: WatchState): void {
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
    try {
      this.broadcast({
        type: "session:event",
        payload: { sessionId, seq: headSeq(this.db, sessionId) },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // headSeq queries the db; if the store was closed before a pending nudge
      // fired (a test that tore down without stop()), swallow rather than throw
      // an uncaught error out of a timer — the nudge is best-effort live sugar.
    }
  }

  private armNudge(sessionId: string, state: WatchState): void {
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => this.fireNudge(sessionId, state), this.debounceMs);
    // The nudge is best-effort live sugar; never hold the process open for it.
    if (typeof state.debounce.unref === "function") state.debounce.unref();
  }

  /**
   * Synchronously fire any pending coalesced nudge, per watched session. A
   * deterministic test seam: a burst of growth re-arms one debounce, so this
   * fires exactly one nudge per session without waiting on the wall clock —
   * lets a test assert coalescing without a flaky real-timer race.
   */
  flush(): void {
    for (const [sessionId, state] of this.watched) {
      if (state.debounce) this.fireNudge(sessionId, state);
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.tick(), this.pollMs);
    if (typeof this.pollTimer.unref === "function") this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
