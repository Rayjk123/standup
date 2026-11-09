// Persistent session→Slack-thread bindings for the mirror: a forward map keyed
// by Claude Code sessionId plus an in-memory reverse index (rootTs → sessionId) rebuilt on load, written
// atomically (tmp + rename). Lives in the adapter (not the collector DB) because
// the mirror's per-turn message-ts bookkeeping is adapter-only state.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface SessionThread {
  sessionId: string;
  channel: string;
  /** ts of the thread's root message — the Slack thread identity. */
  rootTs: string;
  title: string;
  createdAt: string;
  /** Bumped on every mutation; LRU prune key so an active session isn't evicted. */
  lastActivityAt: string;
  /** True once `title` is the collector's real (Haiku) title, not a short-id/prompt seed. */
  titleFinal?: boolean;
  /** Slack ts of the CURRENT live turn's message — the streamed message, or the edited-in-place fallback card. */
  liveTs?: string;
  /** Surface of the current live turn's message — so a restart resumes the right path. */
  liveMode?: "stream" | "fallback";
  /** Count of the live turn's events already streamed — the resume offset after a restart drops in-memory state. */
  liveEmitted?: number;
  /** Leading live-turn events the live message leaves out (an ended session's earlier message shows them); `liveEmitted` counts from here. */
  liveFrom?: number;
  /**
   * Tool cards streamed as `in_progress` whose result was still pending when the
   * live turn was persisted. Their `tool_result` sits BELOW `liveEmitted`, so on
   * resume the newly-appended loop never re-examines it — restoring these lets
   * their completion (checkmark + elapsed) and output body still stream after a
   * restart instead of leaving the card stuck in_progress. Absent on old records.
   */
  livePending?: { id: string; title: string; openedAt: number }[];
  /** Key (first-row id) of the turn currently mirrored as live — detects a new turn. */
  lastTurnKey?: string;
  /** User-prompt uuid of the current live turn (undefined if its opener aged out). */
  lastUserUuid?: string;
  /** Last rendered signature of the live turn, to skip no-op chat.update calls. */
  liveSig?: string;
  /** True once initial history has been posted into a freshly-opened thread. */
  backfilled?: boolean;
  /** True once the "session ended" marker has been posted (idempotency). */
  ended?: boolean;
  /**
   * How many of the live turn's (`lastTurnKey`) events were shown when the
   * session ended. A revived session that carries on with that turn posts
   * only the events after it. Unset when no turn was live at the end.
   */
  endedEmitted?: number;
  /**
   * Tool cards of that turn still in progress at the end. A tool's result
   * event sits right after its call and resolves in place, so it is below
   * `endedEmitted`; the continuation starts at the earliest of these calls.
   */
  endedPending?: string[];
  /** Emoji name of the status reaction currently applied to the root message. */
  statusReaction?: string;
}

const MAX_SESSIONS = 300; // prune oldest beyond this on load
const SAVE_DEBOUNCE_MS = 1500;

/** LRU key: last activity, falling back to creation time for older records. */
function activity(s: SessionThread): string {
  return s.lastActivityAt || s.createdAt;
}

function statePath(): string {
  const override = process.env.STANDUP_SLACK_STATE?.trim();
  if (override) return override;
  const db = process.env.DB_PATH?.trim();
  const dir = db ? dirname(db) : join(homedir(), ".local", "share", "standup");
  return join(dir, "slack-session-threads.json");
}

export class SessionThreads {
  private readonly path = statePath();
  private readonly byId = new Map<string, SessionThread>();
  private readonly byRoot = new Map<string, string>(); // rootTs → sessionId
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  get(sessionId: string): SessionThread | undefined {
    return this.byId.get(sessionId);
  }

  all(): SessionThread[] {
    return [...this.byId.values()];
  }

  /**
   * Resolve the session that owns a thread root — the reverse route, cross-checked
   * against the forward binding. A stale or aliased reverse entry (the session was
   * rebound to a new rootTs, recycled, or removed) resolves to `undefined` rather
   * than naming a session whose CURRENT rootTs differs — so an inbound reply fails
   * safe (ignored) instead of routing to the WRONG session. This is the single
   * authority every router path (index.ts, asks, steer via ownsRoot) funnels through.
   */
  sessionForRoot(rootTs: string): string | undefined {
    const sessionId = this.byRoot.get(rootTs);
    if (sessionId === undefined) return undefined;
    const t = this.byId.get(sessionId);
    if (!t || t.rootTs !== rootTs) return undefined;
    return sessionId;
  }

  /** Whether `sessionId`'s CURRENT binding owns `rootTs` — the router cross-check. */
  ownsRoot(sessionId: string, rootTs: string): boolean {
    return this.byId.get(sessionId)?.rootTs === rootTs;
  }

  set(t: SessionThread): void {
    const prev = this.byId.get(t.sessionId);
    const isNew = prev === undefined;
    t.lastActivityAt = new Date().toISOString();
    // Rebinding this session to a NEW rootTs (e.g. a channel change mints a fresh
    // thread): unlink its OLD reverse route so a reply to the stale thread can't
    // still resolve to it and accumulate as an orphan route.
    if (prev && prev.rootTs !== t.rootTs && this.byRoot.get(prev.rootTs) === t.sessionId) {
      this.byRoot.delete(prev.rootTs);
    }
    this.byId.set(t.sessionId, t);
    // One live session per rootTs: the newest binding wins the reverse route. This
    // last-write-wins rule is identical at runtime and after a reload — load()
    // rebuilds byRoot most-recently-active-first, and set() bumps lastActivityAt.
    this.byRoot.set(t.rootTs, t.sessionId);
    // A brand-new binding carries the rootTs of an already-posted (irreversible)
    // Slack message — persist it SYNCHRONOUSLY so a crash within the debounce
    // window can't lose it and spawn a duplicate thread on restart. High-frequency
    // live-turn updates stay debounced.
    if (isNew) this.flush();
    else this.scheduleSave();
  }

  delete(sessionId: string): void {
    if (!this.byId.has(sessionId)) return;
    this.byId.delete(sessionId);
    // Clear EVERY reverse route pointing at this session — its current rootTs and
    // any stale prior one — so no orphan route survives. A rootTs a newer session
    // re-bound points at that other session, so it's left intact.
    for (const [rootTs, sid] of this.byRoot) {
      if (sid === sessionId) this.byRoot.delete(rootTs);
    }
    this.scheduleSave();
  }

  /** Persist immediately (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  // ---- persistence --------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: SessionThread[] };
      const list = (raw.sessions ?? [])
        .filter((s) => s && s.sessionId && s.rootTs && s.channel)
        .sort((a, b) => (activity(a) < activity(b) ? 1 : -1)) // most-recently-active first
        .slice(0, MAX_SESSIONS);
      // `list` is sorted most-recently-active first. Build byRoot first-wins so a
      // rootTs shared by more than one binding resolves to the most-recently-active
      // owner — identical to runtime's last-write-wins, not the opposite (oldest).
      for (const s of list) {
        s.lastActivityAt ??= s.createdAt;
        this.byId.set(s.sessionId, s);
        if (!this.byRoot.has(s.rootTs)) this.byRoot.set(s.rootTs, s.sessionId);
      }
    } catch (err) {
      console.error("[mirror] failed to load session-thread state:", err instanceof Error ? err.message : err);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const sessions = [...this.byId.values()]
        .sort((a, b) => (activity(a) < activity(b) ? 1 : -1))
        .slice(0, MAX_SESSIONS);
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
      renameSync(tmp, this.path); // atomic replace
    } catch (err) {
      console.error("[mirror] failed to save session-thread state:", err instanceof Error ? err.message : err);
    }
  }
}
