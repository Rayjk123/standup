// Durable Slack ↔ Persona bindings. Modeled on SessionThreads / AskBindingStore:
// a JSON file next to the adapter's other state, written atomically (tmp +
// rename) and capped so a long-lived install can't grow it without bound.
//
// The file is owner-only (0600) and written through a fresh, exclusively
// created temp file, so a planted file or symlink at the temp path is never
// written through. On load a binding whose key disagrees with its channel is
// dropped: replies are posted to `channel`, so a tampered record must not be
// able to point a DM's thread at a public channel.
//
// Two record kinds live here:
//   • thread bindings — a Slack address (`dm:<channel>`, `<channel>:<thread_ts>`,
//     or a user's console thread under `console` for the host and
//     `console:<alias>` for anyone else) ↔ its Persona threadId and the alias
//     whose Persona it is, plus
//     the delivery cursor (`lastDeliveredSeq`), the context cursor
//     (`lastContextTs`), mute state, and the Slack ts each Persona message was
//     posted as (so a resync never posts the same message twice);
//   • approval cards — approvalId → the DM card (and the optional pointer line in
//     the originating channel thread), so a decision made anywhere updates them.
//
// Posted-message ts are irreversible facts (the message is already in Slack), so
// every mutation that records one persists synchronously; cursor-only changes
// are debounced.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PersonaApprovalStatus } from "@standup/shared";
import { parseExternalRef } from "./persona-routing.js";

/** What kind of Slack surface a Persona thread is bound to. */
export type PersonaBindingKind = "dm" | "channel" | "console";

export interface PersonaThreadBinding {
  /** `dm:<channel>`, `<channel>:<thread_ts>`, `console` (the host's) or `console:<alias>`. */
  key: string;
  kind: PersonaBindingKind;
  threadId: string;
  /** The alias whose Persona the thread is in; absent means the host's. */
  owner?: string;
  /** Slack channel the thread posts into (the owner's DM for `dm`; unset for `console`). */
  channel?: string;
  /** Thread root ts for a channel thread; absent for a DM / console. */
  threadTs?: string;
  /** Owner muted follow-ups without a mention (`!mute`). */
  muted?: boolean;
  /** Highest Persona message seq already delivered (or deliberately skipped). */
  lastDeliveredSeq: number;
  /** ts of the newest Slack message already sent to Persona as context (or as the owner's message). */
  lastContextTs?: string;
  /** ts of the owner's newest message Persona hasn't replied to yet — gets ✅ on the reply. */
  pendingOwnerTs?: string;
  /** Persona message id → first Slack ts it was posted as (every chunk of it is in Slack). */
  posted: Record<string, string>;
  /** A split message only partly posted: its first chunk's ts and how many chunks are in Slack. */
  partial?: Record<string, { ts: string; done: number }>;
  /** Slack ts of the owner's messages already sent to Persona from this thread (so context skips them). */
  sentTs?: string[];
  updatedAt: string;
}

export interface PersonaApprovalCard {
  approvalId: string;
  /** The deciding user's DM channel. */
  channel: string;
  /** The alias who decides it (the approval's approver, else its owner); absent means the host. */
  decider?: string;
  ts: string;
  /** The one-line "waiting on approval" note in the originating channel thread. */
  pointer?: { channel: string; threadTs: string; ts: string };
  /** The status the card currently shows. */
  status: PersonaApprovalStatus;
  updatedAt: string;
}

const MAX_THREADS = 500;
const MAX_POSTED_PER_THREAD = 200;
const MAX_APPROVALS = 300;
const MAX_SENT_TS = 200;
const SAVE_DEBOUNCE_MS = 1000;

function defaultPath(): string {
  const override = process.env.STANDUP_SLACK_PERSONA_STATE?.trim();
  if (override) return override;
  const db = process.env.DB_PATH?.trim();
  const dir = db ? dirname(db) : join(homedir(), ".local", "share", "standup");
  return join(dir, "slack-persona-threads.json");
}

/** Oldest-first by updatedAt, so trimming from the front drops the stalest. */
function byUpdated<T extends { updatedAt: string }>(a: T, b: T): number {
  return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
}

export class PersonaThreadStore {
  private readonly byKey = new Map<string, PersonaThreadBinding>();
  private readonly approvals = new Map<string, PersonaApprovalCard>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly path: string = defaultPath(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.load();
  }

  // ---- thread bindings ------------------------------------------------------

  get(key: string): PersonaThreadBinding | undefined {
    return this.byKey.get(key);
  }

  byThreadId(threadId: string): PersonaThreadBinding | undefined {
    for (const b of this.byKey.values()) if (b.threadId === threadId) return b;
    return undefined;
  }

  all(): PersonaThreadBinding[] {
    return [...this.byKey.values()];
  }

  /** Insert or replace a binding; persisted immediately (a new binding is cheap and rare). */
  put(b: Omit<PersonaThreadBinding, "updatedAt" | "posted"> & { posted?: Record<string, string> }): PersonaThreadBinding {
    const record: PersonaThreadBinding = { ...b, posted: b.posted ?? {}, updatedAt: this.now().toISOString() };
    this.byKey.set(record.key, record);
    this.flush();
    return record;
  }

  /** Patch a binding's cursors/flags. Debounced — losing one is recovered by the posted map. */
  update(key: string, patch: Partial<Omit<PersonaThreadBinding, "key" | "posted">>): void {
    const b = this.byKey.get(key);
    if (!b) return;
    Object.assign(b, patch, { updatedAt: this.now().toISOString() });
    this.scheduleSave();
  }

  postedTs(key: string, messageId: string): string | undefined {
    return this.byKey.get(key)?.posted[messageId];
  }

  /** Record that a Persona message is now in Slack. Persisted synchronously. */
  recordPosted(key: string, messageId: string, ts: string): void {
    const b = this.byKey.get(key);
    if (!b) return;
    b.posted[messageId] = ts;
    if (b.partial?.[messageId]) {
      const { [messageId]: _done, ...rest } = b.partial;
      b.partial = Object.keys(rest).length ? rest : undefined;
    }
    const ids = Object.keys(b.posted);
    if (ids.length > MAX_POSTED_PER_THREAD) {
      for (const id of ids.slice(0, ids.length - MAX_POSTED_PER_THREAD)) delete b.posted[id];
    }
    b.updatedAt = this.now().toISOString();
    this.flush();
  }

  /** Chunks of a split message already in Slack. */
  chunkProgress(key: string, messageId: string): { ts: string; done: number } | undefined {
    return this.byKey.get(key)?.partial?.[messageId];
  }

  /** Record that the first `done` chunks of a split message are in Slack. Persisted synchronously. */
  recordChunks(key: string, messageId: string, ts: string, done: number): void {
    const b = this.byKey.get(key);
    if (!b) return;
    b.partial = { ...b.partial, [messageId]: { ts, done } };
    b.updatedAt = this.now().toISOString();
    this.flush();
  }

  /** Whether the owner's Slack message `ts` was already sent to Persona from this binding's thread. */
  wasSent(key: string, ts: string): boolean {
    return !!this.byKey.get(key)?.sentTs?.includes(ts);
  }

  /** Remember that the owner's Slack message `ts` reached Persona. */
  recordSent(key: string, ts: string): void {
    const b = this.byKey.get(key);
    if (!b) return;
    const sent = [...(b.sentTs ?? []).filter((t) => t !== ts), ts];
    b.sentTs = sent.slice(-MAX_SENT_TS);
    b.updatedAt = this.now().toISOString();
    this.scheduleSave();
  }

  // ---- approval cards -------------------------------------------------------

  approval(approvalId: string): PersonaApprovalCard | undefined {
    return this.approvals.get(approvalId);
  }

  allApprovals(): PersonaApprovalCard[] {
    return [...this.approvals.values()];
  }

  putApproval(card: Omit<PersonaApprovalCard, "updatedAt">): void {
    this.approvals.set(card.approvalId, { ...card, updatedAt: this.now().toISOString() });
    this.flush();
  }

  updateApproval(approvalId: string, patch: Partial<Omit<PersonaApprovalCard, "approvalId">>): void {
    const card = this.approvals.get(approvalId);
    if (!card) return;
    Object.assign(card, patch, { updatedAt: this.now().toISOString() });
    this.flush();
  }

  // ---- persistence ----------------------------------------------------------

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as {
        threads?: PersonaThreadBinding[];
        approvals?: PersonaApprovalCard[];
      };
      for (const t of raw.threads ?? []) {
        if (!t || typeof t.key !== "string" || typeof t.threadId !== "string") continue;
        if (!bindingIsConsistent(t)) continue;
        this.byKey.set(t.key, {
          ...t,
          lastDeliveredSeq: typeof t.lastDeliveredSeq === "number" ? t.lastDeliveredSeq : 0,
          posted: t.posted && typeof t.posted === "object" ? t.posted : {},
          updatedAt: t.updatedAt || "",
        });
      }
      for (const a of raw.approvals ?? []) {
        if (a && typeof a.approvalId === "string" && a.channel && a.ts) this.approvals.set(a.approvalId, a);
      }
    } catch (err) {
      console.error("[persona] failed to load Slack Persona state:", err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const threads = [...this.byKey.values()].sort(byUpdated).slice(-MAX_THREADS);
      const approvals = [...this.approvals.values()].sort(byUpdated).slice(-MAX_APPROVALS);
      if (threads.length < this.byKey.size) {
        const keep = new Set(threads.map((t) => t.key));
        for (const k of [...this.byKey.keys()]) if (!keep.has(k)) this.byKey.delete(k);
      }
      if (approvals.length < this.approvals.size) {
        const keep = new Set(approvals.map((a) => a.approvalId));
        for (const k of [...this.approvals.keys()]) if (!keep.has(k)) this.approvals.delete(k);
      }
      writeAtomic(this.path, JSON.stringify({ version: 1, threads, approvals }, null, 2));
    } catch (err) {
      console.error("[persona] failed to save Slack Persona state:", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Whether a loaded binding's key, kind and Slack address agree: `dm:X` posts
 * into X, `<C>:<ts>` into C's thread ts, a console binding nowhere (keyed
 * `console` for the host, `console:<owner>` for anyone else).
 */
function bindingIsConsistent(t: PersonaThreadBinding): boolean {
  if (t.kind === "console") return (t.key === "console" ? !t.owner : t.key === `console:${t.owner}`) && !t.channel;
  const addr = parseExternalRef(t.key);
  if (!addr || addr.kind !== t.kind || addr.channel !== t.channel) return false;
  return addr.kind === "dm" ? !t.threadTs : t.threadTs === addr.threadTs;
}

/**
 * Write `data` to `path` via a uniquely named temp file created exclusively
 * (O_EXCL never follows or reuses an existing file or symlink) with mode
 * 0600, then rename it into place.
 */
function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw err;
  }
}
