// Persistent askId → posted-Slack-message bindings for the ask loop. Modeled on
// SessionThreads (session-threads.ts): a forward map keyed by askId, written
// atomically (tmp + rename). Lives in the adapter because the posted message's
// ts/channel is adapter-only state the collector never sees.
//
// Why it must persist: `bun run dev` restarts the adapter on any source change,
// and on every reconnect resync() re-fetches the still-pending asks and calls
// onAskNew for each. Without a durable record that a given ask ALREADY has a
// posted message, the in-memory dedup (handled/byAsk) is empty after a restart
// and every pending ask is re-posted — flooding the recipient with duplicate
// "permission needed" prompts. Rehydrating this store re-arms that dedup.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface AskBinding {
  channel: string; // DM channel (D…) or the feed channel (C…)
  ts: string; // message ts of the posted prompt (chat.update target)
  question: string;
  sessionTitle: string;
  sessionId: string;
  /** Set when delivered into a session thread; absent for a DM. */
  rootTs?: string;
  /**
   * A SECOND copy of the prompt posted into the session's mirror thread, present
   * only when an owner-routed ask is DM'd to the owner (the guaranteed ping) AND
   * also mirrored into the feed thread for team visibility. Retired in lockstep
   * with the primary so no zombie card is left in the thread.
   */
  mirror?: { channel: string; rootTs: string; ts: string };
  /**
   * Set when this DM channel was opened to deliver an owner-routed ask to a
   * mapped owner (not by the learned recipient introducing themselves). Drives
   * marking the channel in the durable owner-routed set (see markOwnerRouted) so
   * a mapped owner answering their routed DM is never mislearned as the ask
   * recipient (see Asks.noteDmSender).
   */
  ownerRouted?: boolean;
}

const MAX_BINDINGS = 500; // keep the newest beyond this on save
const SAVE_DEBOUNCE_MS = 1000;

function statePath(): string {
  const override = process.env.STANDUP_SLACK_ASK_STATE?.trim();
  if (override) return override;
  const db = process.env.DB_PATH?.trim();
  const dir = db ? dirname(db) : join(homedir(), ".local", "share", "standup");
  return join(dir, "slack-ask-bindings.json");
}

/** Durable store of open asks' posted-message bindings, keyed by askId. */
export class AskBindingStore {
  private readonly path = statePath();
  private readonly byId = new Map<string, AskBinding>();
  // DM channels opened to deliver an owner-routed ask, persisted INDEPENDENTLY of
  // the per-ask bindings. A binding is deleted the moment its ask resolves, but
  // the channel must stay marked for the life of the deployment so the anti-hijack
  // guard survives a resolve-then-restart: a later follow-up DM from that owner is
  // never mislearned as the ask recipient (see Asks.noteDmSender / rehydrate).
  private readonly ownerRouted = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  get(askId: string): AskBinding | undefined {
    return this.byId.get(askId);
  }

  has(askId: string): boolean {
    return this.byId.has(askId);
  }

  /** All bindings as [askId, binding] pairs — insertion order. */
  all(): [string, AskBinding][] {
    return [...this.byId];
  }

  set(askId: string, b: AskBinding): void {
    this.byId.set(askId, b);
    // The binding carries an already-posted (irreversible) message ts — persist
    // it synchronously so a restart within the debounce window can't lose it and
    // re-post the same ask.
    this.flush();
  }

  delete(askId: string): void {
    if (this.byId.delete(askId)) this.scheduleSave();
  }

  /**
   * Mark a DM channel as one opened to deliver an owner-routed ask. Persisted
   * synchronously (like set) because it guards against a hijack that a restart
   * within the debounce window would otherwise reopen.
   */
  markOwnerRouted(channel: string): void {
    if (this.ownerRouted.has(channel)) return;
    this.ownerRouted.add(channel);
    this.flush();
  }

  /** The persisted owner-routed DM channels — re-armed into the guard on boot. */
  ownerRoutedChannels(): string[] {
    return [...this.ownerRouted];
  }

  /** Persist immediately (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as {
        asks?: (AskBinding & { askId: string })[];
        ownerRouted?: string[];
      };
      for (const a of raw.asks ?? []) {
        if (a && a.askId && a.channel && a.ts && a.sessionId) {
          const { askId, ...binding } = a;
          this.byId.set(askId, binding);
        }
      }
      for (const channel of raw.ownerRouted ?? []) {
        if (typeof channel === "string" && channel) this.ownerRouted.add(channel);
      }
    } catch (err) {
      console.error("[asks] failed to load ask-binding state:", err instanceof Error ? err.message : err);
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
      const asks = [...this.byId].slice(-MAX_BINDINGS).map(([askId, b]) => ({ askId, ...b }));
      const ownerRouted = [...this.ownerRouted].slice(-MAX_BINDINGS);
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ asks, ownerRouted }, null, 2));
      renameSync(tmp, this.path); // atomic replace
    } catch (err) {
      console.error("[asks] failed to save ask-binding state:", err instanceof Error ? err.message : err);
    }
  }
}
