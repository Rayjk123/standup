// The Persona ↔ Slack bridge. Every user has their own always-on Persona;
// Slack is one of its channels. This class turns a mapped Slack user's events
// into messages to that user's Persona (with the surrounding thread as
// untrusted context) and posts each Persona's replies, quick-reply buttons and
// approval cards back to the Slack thread each Persona thread is bound to.
//
// Who is who: the host is SLACK_ASK_USER (else the host alias's
// SLACK_OWNER_MAP entry) and always has a Persona here. Another user has one
// only when SLACK_PERSONA_USERS lists their alias and SLACK_OWNER_MAP pairs it
// with their Slack id (opt-in); a mapped alias that isn't listed keeps only
// owner-routed asks. Anyone else has no Persona here (fail closed). Every
// collector call names the user it is made for (see CollectorClient), so each
// user reaches only their own Persona.
//
// Inbound:
//   • a user's DM → their Persona thread for that DM (`dm:<D…>`, private);
//     `login` alone instead gets a guest a console sign-in link (the host is
//     pointed at scripts/console-login.ts);
//   • an @-mention → the mentioning user's Persona thread bound to
//     `<channel>:<thread_ts ?? ts>`; a thread already bound to someone else's
//     Persona stays theirs (the newcomer's words are only context);
//   • the binding owner's follow-up in a bound thread → same thread, no mention
//     needed (unless `!mute`d);
//   • the "Send to Persona" message shortcut → the clicking user's DM thread;
//   • option buttons (the thread's owner only) and Approve/Deny buttons (the
//     approval's decider only).
// Outbound (persona:* WS frames, every user's, each addressed to one user by
// its `audience`; a frame for a user with no Persona here is dropped):
//   • persona/system messages of a Slack-bound thread post to that thread; a
//     reply tagged with jobs ends in a context line naming them (titles read
//     from the collector), limited to what the thread's audience may see;
//   • console-thread messages stay in the console, except questions with
//     options, which also reach the owner's DM;
//   • every approval becomes a card in its decider's DM (the approver, else the
//     owner), updated as its status changes; when it was raised from a channel
//     thread, that thread gets a detail-free pointer line ("waiting on
//     <@decider>'s approval").
//
// Audience: a DM thread is private to its user; a channel thread is shared
// with the channel (external for a Slack Connect channel). The audience is
// sent when the thread is created, so the collector keeps a channel thread's
// conversation apart from the user's DMs. Everything posted is scrubbed of
// secrets, broadcast mentions and disguised links.
//
// Trust: only the Persona owner's own words are sent as the message text;
// anything someone else wrote or chose (other messages, display names, a
// forwarded message and its author) travels as untrusted context.
//
// Delivery is per-thread ordered and idempotent: each binding keeps the highest
// seq delivered and the Slack ts of every posted Persona message, so a gap or a
// WS reconnect re-reads the thread from the collector and posts only what's
// missing.
//
// When the host's Slack id doesn't resolve, or SLACK_ASK_USER and the host's
// SLACK_OWNER_MAP entry disagree, the bridge stays inactive (fail closed) and
// the adapter behaves as before.

import type {
  PersonaApproval,
  PersonaAttachment,
  PersonaAudience,
  PersonaContextMessage,
  PersonaMessage,
  PersonaRunState,
  PersonaState,
  PersonaThreadSummary,
  WsMessage,
} from "@standup/shared";
import { PERSONA_ATTACHMENTS_PER_MESSAGE, PERSONA_SILENT_REPLY, isPersonaVideoMime } from "@standup/shared";
import { ownerTokenPath, readOwnerToken } from "@standup/shared/owner-token";
import { Buffer } from "node:buffer";
import type { CollectorClient } from "./collector-client.js";
import type { SlackApi, SlackCallResult } from "./stream-client.js";
import type { PersonaThreadBinding, PersonaThreadStore, PersonaBindingKind } from "./persona-store.js";
import { InboundDedup } from "./inbound-dedup.js";
import { userLoginLink } from "./login-link.js";
import {
  acceptedMime,
  byteCapFor,
  downloadSlackFile,
  inboundSlackFile,
  needsFileInfo,
  precheckFile,
  SlackDownloadError,
  type InboundSlackFile,
  type SlackFileDownloader,
} from "./persona-files.js";
import {
  absoluteConsoleLinks,
  approvalCardBlocks,
  approvalDecider,
  approvalFallbackBlocks,
  approvalPointerText,
  approvalText,
  capContext,
  clipMrkdwn,
  DEFAULT_CONTEXT_CAPS,
  markdownToMrkdwn,
  jobRefsBlock,
  mrkdwnSections,
  optionBlocks,
  optionChosenBlock,
  parseApprovalAction,
  parseOptionAction,
  personaMarkdownBlocks,
  personaOutboundText,
  slackToPlain,
  splitForSlack,
  type PersonaJobRef,
  type RoutedApproval,
} from "./persona-format.js";
import {
  audienceFitsBinding,
  channelThreadKey,
  dmKey,
  dmRoute,
  fileShareDmText,
  inboundKey,
  isLoginCommand,
  mentionRoute,
  offersNoPersonaNotice,
  parseExternalRef,
  parseMuteCommand,
  personaDirectory,
  personaIdempotencyKey,
  personaOwnerConflict,
  threadMessageRoute,
  tsAfter,
  type PersonaDirectory,
} from "./persona-routing.js";

/** The collector surface the bridge uses — narrowed so a test fake needs no HTTP. */
export type PersonaCollector = Pick<
  CollectorClient,
  | "personaState"
  | "personaUsers"
  | "personaThread"
  | "personaThreads"
  | "personaSend"
  | "personaUpload"
  | "personaMessages"
  | "personaApprovals"
  | "personaApprove"
  | "personaDeny"
  | "personaAttachment"
  | "personaJobs"
>;

export interface PersonaBridgeOptions {
  slack: SlackApi;
  collector: PersonaCollector;
  store: PersonaThreadStore;
  /** The app's bot user id (`auth.test` user_id) — its mention is stripped and its posts skipped. */
  botUserId: string;
  /**
   * Operator config the host's and every other user's Slack id are resolved
   * from. `personaUsers` (SLACK_PERSONA_USERS) lists the aliases besides the
   * host that get a Persona in Slack; empty means the host only.
   */
  ownerConfig: { askUser?: string; ownerMap: Map<string, string>; personaUsers?: readonly string[] };
  /** The web console's base URL, linked from clipped approval cards. */
  webUrl: string;
  /**
   * The configured console origin login links point at (STANDUP_WEB_URL, else
   * STANDUP_CONSOLE_ORIGIN). Without it no login link is sent: a localhost
   * default would be unreachable from a teammate's browser.
   */
  consoleOrigin?: string;
  /** Reads the owner secret login links are signed with (default: the collector's owner.token). */
  ownerToken?: () => string | undefined;
  /** Clock for login-link expiry. */
  now?: () => number;
  /**
   * Called when Persona stops being able to act (paused, errored, disabled).
   * Asks it was relaying are then the adapter's to deliver again.
   */
  onPersonaUnavailable?: () => void;
  /** Sends an attachment's bytes to a Slack upload URL; a test fake stands in for the network. */
  uploadFile?: (url: string, bytes: Uint8Array, mimeType: string) => Promise<boolean>;
  /**
   * The app's bot token (SLACK_BOT_TOKEN), sent only to Slack to download the
   * files a user shares in their DM. Without it those files can't be fetched.
   */
  botToken?: string;
  /** Fetches a shared file's bytes from Slack (default: downloadSlackFile); a test fake stands in for the network. */
  downloadFile?: SlackFileDownloader;
  log?: (line: string) => void;
}

/** Inbound Slack message, normalized from a `message` or `app_mention` event. */
export interface InboundSlackMessage {
  channel: string;
  user?: string;
  text: string;
  ts?: string;
  threadTs?: string;
  clientMsgId?: string;
  /** Files shared with the message (a DM's go to Persona as attachments). */
  files?: InboundSlackFile[];
}

/** What becomes of one file the owner shared: an upload's id, or what to tell them instead. */
type FileIntake = { id: string } | { notice: string };

/** A message-shortcut invocation (`persona_send`). */
export interface PersonaShortcut {
  userId?: string;
  channelId: string;
  channelName?: string;
  actionTs?: string;
  message: { ts: string; text?: string; user?: string; username?: string; threadTs?: string };
}

/** A button tap on a Persona card. */
export interface PersonaButtonTap {
  actionId: string;
  value?: string;
  userId?: string;
  channel?: string;
  messageTs?: string;
  /** The tapped message's blocks, so a quick-reply card can be redrawn without its buttons. */
  messageBlocks?: Record<string, unknown>[];
}

/** Slack message shape as returned by conversations.replies. */
interface SlackHistoryMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
  text?: string;
  bot_profile?: { name?: string };
}

/** Delivery attempts after which a message that keeps failing is skipped so later ones aren't stuck behind it. */
const MAX_DELIVERY_ATTEMPTS = 3;
/** Pages of conversations.replies read when gathering thread context. */
const MAX_REPLY_PAGES = 5;
/** Errors that mean `markdown` blocks aren't accepted, so the text fallback is used instead. */
const BLOCK_REJECTIONS = new Set(["invalid_blocks", "invalid_blocks_format", "invalid_arguments"]);
/** Run states in which Persona can't act on anything it was handed. */
const UNAVAILABLE: ReadonlySet<PersonaRunState> = new Set(["paused", "error", "disabled"]);
/** Live frames for not-yet-bound threads kept while the first resync runs. */
const MAX_HELD_FRAMES = 500;
/** What a channel thread shows when a send fails; the error itself may name private things. */
const PUBLIC_FAILURE = "⚠️ Persona couldn't take that — details are in the console.";
/** How long a user's job titles and thread audiences are reused for job lines. */
const JOB_LOOKUP_TTL_MS = 30_000;
/**
 * A read that failed, or lacks a tagged job or the thread (either may be new),
 * is retried no more often than this per user, so a job that never turns up
 * doesn't cost a read on every reply.
 */
const JOB_LOOKUP_REFRESH_MS = 1_000;
/** How long a job-line read may hold a reply up before it posts without one. */
const JOB_LOOKUP_TIMEOUT_MS = 2_500;

/** A user's jobs and thread audiences as last read for job lines; null where the read failed. */
interface JobLookup {
  jobs: Map<string, { title: string; threadId: string }> | null;
  audiences: Map<string, PersonaAudience> | null;
}
/** One user's last read of a job-line source, and the read under way, if any. */
interface CachedRead<T> {
  at: number;
  value: T | null;
  pending?: Promise<T | null>;
}
/** A Persona's state as GET /api/persona/state reports it, naming the collector's host. */
/** `GET /api/persona/state` as the bridge reads it, with the caller-relative fields. */
type HostedPersonaState = PersonaState & { hostAlias?: string; canWrite?: boolean; reason?: string };
/** An approval with its routing: whose Persona raised it and who must decide it. */
type Approval = PersonaApproval & Partial<RoutedApproval>;
/** The user's message for a forwarded Slack message; who wrote it and where travel as context. */
const FORWARD_TEXT = "Forwarded a message — what should I do with this?";
/** What stands in for an attached image when the app can't upload files. */
const ATTACHMENT_IN_CONSOLE = "🖼️ Persona attached an image to this reply — it's in the Standup console.";
/** What stands in for an attached video when the app can't upload files. */
const VIDEO_IN_CONSOLE = "🎬 Persona attached a video to this reply — it's in the Standup console.";
/** How long an upload to Slack may take: a minute, plus a second for every 256 KB (a 50 MB video gets about 4 min). */
export function uploadTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (256 * 1024)) * 1000;
}

/** Whether `url` is one of Slack's own upload endpoints (an attachment's bytes go nowhere else). */
export function isSlackUploadUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "files.slack.com" || u.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

const UPLOAD_EXTENSIONS: Record<PersonaAttachment["mimeType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** A file name for the upload: the source's base name made safe, ending in its real type's extension. */
export function uploadName(a: PersonaAttachment): string {
  const ext = UPLOAD_EXTENSIONS[a.mimeType];
  const base = a.name.split(/[\\/]/).pop() ?? "";
  const fallback = isPersonaVideoMime(a.mimeType) ? "video" : "image";
  const stem = base.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || fallback;
  return `${stem}.${ext}`;
}

/** POSTs an attachment's bytes to a Slack upload URL; true on a 2xx. */
async function postToUploadUrl(url: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": mimeType },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(uploadTimeoutMs(bytes.length)),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type Block = Record<string, unknown>;

export class PersonaBridge {
  private readonly slack: SlackApi;
  private readonly collector: PersonaCollector;
  private readonly store: PersonaThreadStore;
  private readonly log: (line: string) => void;
  private readonly uploadFile: (url: string, bytes: Uint8Array, mimeType: string) => Promise<boolean>;
  private readonly downloadFile: SlackFileDownloader;

  private readonly ownerToken: () => string | undefined;
  private readonly now: () => number;

  /** Who may direct which Persona; unset while the host is unknown or the config is ambiguous. */
  private dir: PersonaDirectory | undefined;
  /** The host's Persona state. */
  private state: HostedPersonaState | null = null;
  /** Every other user's Persona state, by alias, as last read. */
  private readonly guestStates = new Map<string, PersonaState>();
  /** Users with a Persona the last resync covered (the host first). */
  private knownUsers: string[] = [];
  /** Users who reached their Persona from Slack in this run. */
  private readonly engaged = new Set<string>();
  private activeFlag = false;
  private lastInactiveReason: string | undefined;
  /** Each Slack user's DM channel with the app, as opened. */
  private readonly dmChannels = new Map<string, string>();
  /** Bindings are set up (console cursor at its head); until then frames for unbound threads are held. */
  private initialized = false;
  private readonly heldFrames: WsMessage[] = [];
  private resyncing: Promise<void> | null = null;

  /** `chat:write.customize` usable — Persona posts as "Persona" until Slack says otherwise. */
  private customize = true;
  /** `markdown` blocks accepted by this workspace. */
  private markdownBlocks = true;
  private readonly warnedScopes = new Set<string>();

  private readonly inboundSeen = new InboundDedup();
  private readonly noticeShown = new InboundDedup();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly failures = new Map<string, number>();
  private readonly approvalCache = new Map<string, Approval>();
  private readonly cardInFlight = new Map<string, Promise<void>>();
  private readonly settleInFlight = new Map<string, { status: Approval["status"]; done: Promise<void> }>();
  private readonly userNames = new Map<string, string>();
  private readonly jobReads = new Map<string, CachedRead<NonNullable<JobLookup["jobs"]>>>();
  private readonly audienceReads = new Map<string, CachedRead<NonNullable<JobLookup["audiences"]>>>();

  constructor(private readonly opts: PersonaBridgeOptions) {
    this.slack = opts.slack;
    this.collector = opts.collector;
    this.store = opts.store;
    this.log = opts.log ?? ((line) => console.log(line));
    this.uploadFile = opts.uploadFile ?? postToUploadUrl;
    this.downloadFile = opts.downloadFile ?? ((url, o) => downloadSlackFile(url, o));
    this.ownerToken = opts.ownerToken ?? (() => readOwnerToken(ownerTokenPath()));
    this.now = opts.now ?? Date.now;
  }

  // ---- identity & lifecycle ---------------------------------------------------

  /** Whether Persona-in-Slack is on: the host's Persona is running and the host's Slack id is known. */
  get active(): boolean {
    return this.activeFlag;
  }

  /** The host's Slack id, once resolved. */
  get ownerSlackId(): string | undefined {
    return this.dir?.hostSlackId;
  }

  /** Whether `userId` is the host. Always false while the host is unknown. */
  isOwner(userId: string | undefined): boolean {
    return !!userId && !!this.dir?.hostSlackId && userId === this.dir.hostSlackId;
  }

  /** The alias whose Persona Slack user `userId` directs, or undefined when they have none here. */
  aliasFor(userId: string | undefined): string | undefined {
    return userId ? this.dir?.aliasBySlackId.get(userId) : undefined;
  }

  /** The Slack id of the user with alias `alias`, when they're mapped. */
  private slackIdOf(alias: string | undefined): string | undefined {
    return alias ? this.dir?.slackIdByAlias.get(alias) : undefined;
  }

  /** The alias whose Persona a binding's thread is in (absent on a binding means the host). */
  private ownerOf(b: PersonaThreadBinding): string | undefined {
    return b.owner ?? this.dir?.hostAlias;
  }

  /** The console binding key for `alias`: `console` for the host, `console:<alias>` for anyone else. */
  private consoleKey(alias: string): string {
    return alias === this.dir?.hostAlias ? "console" : `console:${alias}`;
  }

  /**
   * Fetch the host's Persona state and (re)resolve who directs which Persona.
   * Leaves the previous resolution in place when the collector can't be reached.
   */
  async refresh(): Promise<void> {
    const state = await this.collector.personaState();
    if (!state) {
      if (!this.state) this.setActive(false, "the collector's Persona state is unreachable");
      return;
    }
    this.applyState(state);
  }

  private applyState(state: HostedPersonaState): void {
    const prevRun = this.state?.runState;
    this.state = state;
    if (UNAVAILABLE.has(state.runState) && prevRun !== undefined && !UNAVAILABLE.has(prevRun)) {
      this.opts.onPersonaUnavailable?.();
    }
    // A read without a valid owner secret answers a bare sign-in state: the
    // bridge can't speak for anyone, which is a host config problem, not a
    // disabled Persona.
    if (state.canWrite === false || state.reason === "sign-in") {
      this.setActive(
        false,
        "owner secret unreadable; check STANDUP_OWNER_TOKEN_FILE / <dataDir>/secrets/owner.token",
      );
      return;
    }
    if (state.runState === "disabled" || !state.threadId) {
      this.setActive(false, "Persona is disabled on the collector");
      return;
    }
    const host = state.hostAlias || state.owner;
    const conflict = personaOwnerConflict(this.opts.ownerConfig, host);
    if (conflict) {
      this.dir = undefined;
      this.setActive(
        false,
        `SLACK_ASK_USER (${conflict.askUser}) and SLACK_OWNER_MAP's entry for ${host} (${conflict.mapped}) name different people — set them to the same member id`,
      );
      return;
    }
    const dir = personaDirectory(this.opts.ownerConfig, host);
    if (!dir.hostSlackId) {
      this.dir = undefined;
      this.setActive(
        false,
        `the host's Slack id is unknown — set SLACK_ASK_USER to your Slack member id (or SLACK_OWNER_MAP=${host}:U…)`,
      );
      return;
    }
    this.dir = dir;
    this.setActive(true);
  }

  /** Whether a persona:state frame is the host's (a frame without `hostAlias` predates per-user Persona). */
  private isHostState(s: HostedPersonaState): boolean {
    if (s.hostAlias) return s.owner === s.hostAlias;
    if (this.dir) return s.owner === this.dir.hostAlias;
    return !this.state || s.owner === (this.state.hostAlias || this.state.owner);
  }

  /**
   * The Slack user `alias`'s approval cards are delivered to, or undefined
   * while they reach nobody here (the bridge is off, or `alias` has no
   * Persona in Slack).
   */
  approvalCardRecipient(alias: string | undefined): string | undefined {
    return this.activeFlag ? this.slackIdOf(alias) : undefined;
  }

  /** Whether `alias` has a Persona in Slack: the host, or a listed user SLACK_OWNER_MAP maps. */
  private hasSlackPersona(alias: string | undefined): boolean {
    return !!this.slackIdOf(alias);
  }

  private setActive(on: boolean, reason?: string): void {
    if (on) {
      if (!this.activeFlag) {
        const others = Math.max(0, (this.dir?.slackIdByAlias.size ?? 1) - 1);
        this.log(
          `[persona] Persona in Slack is on — the host is <@${this.dir?.hostSlackId}>${others ? `, plus ${others} other Persona user${others === 1 ? "" : "s"}` : ""}.`,
        );
      }
      this.activeFlag = true;
      this.lastInactiveReason = undefined;
      return;
    }
    this.activeFlag = false;
    if (reason && reason !== this.lastInactiveReason) this.log(`[persona] Persona in Slack is off: ${reason}.`);
    this.lastInactiveReason = reason;
  }

  /**
   * Bring Slack up to date with the collector: adopt Slack threads the store
   * lost, post any Persona messages missed while disconnected, and create or
   * settle approval cards. Run on every WS (re)open.
   */
  async resync(): Promise<void> {
    if (this.resyncing) return this.resyncing;
    this.resyncing = this.runResync().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  private async runResync(): Promise<void> {
    await this.refresh();
    const dir = this.dir;
    if (!this.activeFlag || !this.state || !dir) return;
    const users = await this.usersWithPersona(dir);
    this.knownUsers = users;

    // Per user: adopt Slack threads the store lost, and place their console cursor.
    const summariesByUser = new Map<string, PersonaThreadSummary[] | null>();
    for (const alias of users) {
      const isHost = alias === dir.hostAlias;
      const state = isHost ? this.state : await this.collector.personaState(alias);
      if (!isHost && state) this.guestStates.set(alias, state);
      const summaries = await this.collector.personaThreads(alias);
      summariesByUser.set(alias, summaries);
      for (const t of summaries ?? []) {
        if (t.channel !== "slack" || !t.externalRef || this.store.byThreadId(t.id) || this.store.get(t.externalRef)) continue;
        if (t.owner && t.owner !== alias) continue;
        const addr = parseExternalRef(t.externalRef);
        if (!addr) continue;
        if (!audienceFitsBinding(addr.kind, t.audience)) {
          this.log(`[persona] not adopting Persona thread ${t.id}: its audience (${t.audience}) doesn't fit ${t.externalRef}.`);
          continue;
        }
        this.store.put({
          key: t.externalRef,
          kind: addr.kind,
          threadId: t.id,
          owner: alias,
          channel: addr.channel,
          threadTs: addr.kind === "channel" ? addr.threadTs : undefined,
          lastDeliveredSeq: t.lastMessage?.seq ?? 0,
        });
      }
      if (state?.threadId && state.runState !== "disabled") await this.ensureConsoleBinding(alias, state.threadId, summaries);
    }
    this.initialized = true;
    for (const held of this.heldFrames.splice(0)) this.onWsMessage(held);

    // Re-read only threads with something newer than what was delivered; with
    // no summaries to compare against, re-read them all. A binding whose
    // owner no longer has a Persona here is left alone.
    for (const b of this.store.all()) {
      const owner = this.ownerOf(b);
      if (!owner || !users.includes(owner)) continue;
      const row = summariesByUser.get(owner)?.find((t) => t.id === b.threadId);
      if (row && (row.lastMessage?.seq ?? 0) <= b.lastDeliveredSeq) continue;
      this.enqueue(b.key, () => this.catchUp(b.key));
    }

    const pendingIds = new Set<string>();
    for (const alias of users) {
      const pending = await this.collector.personaApprovals(alias, "pending");
      for (const a of pending ?? []) {
        if (pendingIds.has(a.id)) continue;
        pendingIds.add(a.id);
        this.approvalCache.set(a.id, a);
        this.track(this.ensureApprovalCard(a.id));
      }
    }
    // Cards still showing an open state whose approval moved on (or whose last
    // redraw failed) are redrawn from the collector's current state, read as
    // the card's decider.
    const unsettled = this.store
      .allApprovals()
      .filter((c) => (c.status === "pending" || c.status === "approved") && (c.status !== "pending" || !pendingIds.has(c.approvalId)));
    const byDecider = new Map<string, Approval[] | null>();
    for (const card of unsettled) {
      const decider = card.decider ?? dir.hostAlias;
      if (!byDecider.has(decider)) byDecider.set(decider, await this.collector.personaApprovals(decider));
      const a = byDecider.get(decider)?.find((x) => x.id === card.approvalId);
      if (a && a.status !== card.status) this.track(this.settleCard(a));
    }
  }

  /**
   * The users whose Personas the bridge keeps in sync: the host, then every
   * other Slack Persona user who has a Persona on the collector (GET
   * /api/persona/users) or has used theirs from Slack. Mapped users who never
   * have aren't read, so a resync never creates a Persona for them.
   */
  private async usersWithPersona(dir: PersonaDirectory): Promise<string[]> {
    const guests = [...dir.slackIdByAlias.keys()].filter((a) => a !== dir.hostAlias);
    if (!guests.length) return [dir.hostAlias];
    const seen = new Set<string>([...(await this.collector.personaUsers()) ?? [], ...this.engaged]);
    for (const b of this.store.all()) if (b.owner) seen.add(b.owner);
    for (const c of this.store.allApprovals()) if (c.decider) seen.add(c.decider);
    return [dir.hostAlias, ...guests.filter((a) => seen.has(a))];
  }

  /** Resolves once every queued delivery and inbound task has finished. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  // ---- inbound ------------------------------------------------------------------

  /**
   * Whether `userId`'s Persona can take work now: Persona-in-Slack is on, they
   * have a Persona, and its last known state isn't paused or in error.
   */
  canAct(userId: string | undefined): boolean {
    const alias = this.aliasFor(userId);
    if (!this.activeFlag || !alias) return false;
    const state = alias === this.dir?.hostAlias ? this.state : this.guestStates.get(alias);
    return !state || !UNAVAILABLE.has(state.runState);
  }

  /** Whether onMention would send this mention to the sender's own Persona (and not a notice). */
  takesMention(m: Pick<InboundSlackMessage, "channel" | "user" | "ts" | "threadTs">): boolean {
    if (!m.ts) return false;
    const bound = this.store.get(channelThreadKey(m.channel, m.threadTs ?? m.ts));
    return (
      mentionRoute({
        active: this.activeFlag,
        alias: this.aliasFor(m.user),
        boundOwner: bound ? this.ownerOf(bound) : undefined,
        noticeShown: false,
      }) === "persona"
    );
  }

  /** Whether a DM should go to Persona (see dmRoute). */
  takesDm(userId: string | undefined, hasPendingAsk: boolean): boolean {
    return dmRoute({ active: this.activeFlag, hasPersona: !!this.aliasFor(userId), hasPendingAsk }) === "persona";
  }

  /**
   * A Slack Persona user's DM: send it to their Persona thread for the DM, or, for
   * `login` alone, answer with their console sign-in link. Files shared with it
   * become the message's attachments (see intakeFiles); the message is sent
   * once, after them, and not at all when it has no text and no file made it.
   */
  async onDm(m: InboundSlackMessage): Promise<void> {
    const alias = this.aliasFor(m.user);
    if (!alias || !m.ts) return;
    if (this.inboundSeen.seen(inboundKey(m.channel, m.ts))) return;
    const text = slackToPlain(m.text, this.opts.botUserId);
    const files = m.files ?? [];
    if (!text && !files.length) return;
    if (!files.length && isLoginCommand(text)) return this.sendLoginLink(m.channel, m.user!, alias);
    this.engaged.add(alias);
    const key = dmKey(m.channel);
    await this.run(key, async () => {
      const b = await this.ensureBinding(alias, key, "dm", m.channel, undefined, "Slack DM", "private");
      if (!b) return this.failed({ channel: m.channel, ts: m.ts!, private: true }, "couldn't open a Persona thread for this DM");
      const idempotencyKey = personaIdempotencyKey(m.channel, m.ts, m.clientMsgId);
      if (!files.length) {
        await this.send(b, { text, idempotencyKey, ownerTs: m.ts! });
        return;
      }
      await this.react(m.channel, m.ts!, "eyes");
      const intake = await this.intakeFiles(alias, b, files);
      const body = fileShareDmText(text, intake.failed, intake.ids.length);
      if (text || intake.ids.length) {
        await this.send(b, { text: body, idempotencyKey, ownerTs: m.ts!, attachmentIds: intake.ids, reacted: true });
      } else {
        await this.unreact(m.channel, m.ts!, "eyes");
        await this.react(m.channel, m.ts!, "warning");
      }
      if (intake.notices.length) {
        await this.postPlain(m.channel, undefined, personaOutboundText(intake.notices.map((n) => `⚠️ ${n}`).join("\n"), m.user));
      }
    });
  }

  /**
   * The files of a DM, stored as uploads in `b`'s thread: at most
   * PERSONA_ATTACHMENTS_PER_MESSAGE of them, each checked from Slack's
   * metadata, fetched from Slack with the bot token and handed to the
   * collector. Returns the uploads' ids, how many files didn't make it, and
   * what to tell the user about those.
   */
  private async intakeFiles(
    owner: string,
    b: PersonaThreadBinding,
    files: InboundSlackFile[],
  ): Promise<{ ids: string[]; failed: number; notices: string[] }> {
    const taken = files.slice(0, PERSONA_ATTACHMENTS_PER_MESSAGE);
    const notices: string[] = [];
    if (files.length > taken.length) {
      notices.push(`Persona takes up to ${PERSONA_ATTACHMENTS_PER_MESSAGE} files per message; sent the first ${PERSONA_ATTACHMENTS_PER_MESSAGE}.`);
    }
    const token = this.opts.botToken?.trim();
    if (!token) {
      this.warnOnce("bot-token", "files shared in a DM can't be downloaded — the adapter has no SLACK_BOT_TOKEN.");
      notices.push("Couldn't fetch the files you sent from Slack — the Standup Slack adapter has no bot token to download them with.");
      return { ids: [], failed: files.length, notices };
    }
    const ids: string[] = [];
    for (const f of taken) {
      const r = await this.intakeFile(owner, b.threadId, f, token);
      if ("id" in r) ids.push(r.id);
      else notices.push(r.notice);
    }
    return { ids, failed: files.length - ids.length, notices };
  }

  /** One shared file: checked, downloaded and uploaded to the collector, or why it couldn't be. */
  private async intakeFile(owner: string, threadId: string, shared: InboundSlackFile, token: string): Promise<FileIntake> {
    let f = shared;
    if (needsFileInfo(f)) {
      const info = await this.call("files.info", { file: f.id });
      const full = info.ok ? inboundSlackFile(info.data.file) : undefined;
      if (!full) {
        if (info.error === "missing_scope") return { notice: this.filesReadNotice(f.name) };
        return { notice: `Couldn't send ${f.name} to Persona: Slack didn't say where to fetch it (${info.error ?? "no file details"})` };
      }
      f = full;
    }
    const why = precheckFile(f);
    if (why) return { notice: `Couldn't send ${f.name} to Persona: ${why}` };
    const url = f.urlPrivateDownload ?? f.urlPrivate;
    if (!url) return { notice: `Couldn't send ${f.name} to Persona: Slack gave no link to download it from` };
    let bytes: Uint8Array;
    try {
      bytes = await this.downloadFile(url, { token, maxBytes: byteCapFor(f) });
    } catch (err) {
      if (err instanceof SlackDownloadError && err.kind === "scope") return { notice: this.filesReadNotice(f.name) };
      const why = err instanceof Error ? err.message : String(err);
      if (err instanceof SlackDownloadError && err.kind === "too_large") return { notice: `Couldn't send ${f.name} to Persona: ${why}` };
      this.log(`[persona] downloading ${f.id} from Slack failed: ${why}`);
      return { notice: `Couldn't download ${f.name} from Slack: ${why}` };
    }
    const mimeType = acceptedMime(f);
    try {
      const a = await this.collector.personaUpload(owner, {
        threadId,
        name: f.name,
        ...(mimeType ? { mimeType } : {}),
        dataBase64: Buffer.from(bytes).toString("base64"),
      });
      return { id: a.id };
    } catch (err) {
      return { notice: `Couldn't send ${f.name} to Persona: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** What the user is told when the app can't download files (no files:read); logged once. */
  private filesReadNotice(name: string): string {
    this.warnOnce("files:read", "files shared in a DM can't be downloaded — add the files:read scope and reinstall the app.");
    return `Couldn't download ${name} from Slack — the Standup app needs the files:read scope (reinstall the app after updating its manifest)`;
  }

  /** Whether users besides the host can have a Persona here (SLACK_PERSONA_USERS lists someone). */
  private get multiUser(): boolean {
    return (this.opts.ownerConfig.personaUsers?.length ?? 0) > 0;
  }

  /**
   * A DM from a Slack user the operator hasn't configured (see
   * offersNoPersonaNotice), with no ask claiming it: tell them once per DM who
   * can add them, in place of the adapter's usual reply. True when the notice
   * was posted — the caller then gives the DM no other reply.
   */
  async noticeNoPersonaDm(channel: string, userId: string | undefined): Promise<boolean> {
    const offered = offersNoPersonaNotice({
      active: this.activeFlag,
      multiUser: this.multiUser,
      userId,
      hostSlackId: this.dir?.hostSlackId,
      ownerMap: this.opts.ownerConfig.ownerMap,
    });
    if (!offered) return false;
    const key = `${dmKey(channel)}:${userId}`;
    if (this.noticeShown.has(key)) return false;
    this.noticeShown.remember(key);
    return !!(await this.postPlain(channel, undefined, this.noPersonaText()));
  }

  /** What a Slack user with no Persona here is told. */
  private noPersonaText(): string {
    const host = `<@${this.dir?.hostSlackId}>`;
    return `You don't have a Persona in Slack yet. Your own Persona is in the Standup console; ask ${host} to add you here.`;
  }

  /**
   * Reply to `login` with a console sign-in link for `alias`, shown only to
   * the user who asked (ephemeral; a plain DM post when that fails). The host
   * signs in on the host machine instead, so they are pointed at the script.
   */
  private async sendLoginLink(channel: string, userId: string, alias: string): Promise<void> {
    if (alias === this.dir?.hostAlias) {
      await this.postPrivately(
        channel,
        userId,
        "🔑 You're the host — sign in to the Standup console by running `bun run scripts/console-login.ts` on the host machine.",
      );
      return;
    }
    const origin = this.opts.consoleOrigin?.trim();
    if (!origin) {
      this.log("[persona] can't send a login link: no console origin — set STANDUP_WEB_URL to the console URL teammates reach.");
      await this.postPrivately(
        channel,
        userId,
        `⚠️ I can't make a sign-in link yet — the host (<@${this.dir?.hostSlackId}>) must set STANDUP_WEB_URL to the console URL teammates reach.`,
      );
      return;
    }
    const token = this.ownerToken();
    if (!token) {
      this.log("[persona] can't mint a login link: the owner secret is unreadable.");
      await this.postPlain(channel, undefined, `⚠️ I can't make a sign-in link right now — ask <@${this.dir?.hostSlackId}>.`);
      return;
    }
    const link = userLoginLink(token, alias, origin, this.now());
    const text = `🔑 <${link}|Sign in to the Standup console as ${alias}> — the link is for you only and works for 10 minutes.`;
    await this.postPrivately(channel, userId, text);
  }

  /** An ephemeral post to `userId` in their DM, else a plain DM post. */
  private async postPrivately(channel: string, userId: string, text: string): Promise<void> {
    const res = await this.call("chat.postEphemeral", { channel, user: userId, text });
    if (!res.ok) await this.postPlain(channel, undefined, text);
  }

  /** Whether `<channel>:<threadTs>` is bound to a Persona thread. */
  isBoundThread(channel: string, threadTs: string | undefined): boolean {
    return !!threadTs && !!this.store.get(channelThreadKey(channel, threadTs));
  }

  /**
   * An @-mention that isn't an existing command. Returns false when Persona is
   * off so the caller keeps its help text; true when the bridge handled it.
   */
  async onMention(m: InboundSlackMessage): Promise<boolean> {
    if (!m.ts) return false;
    const rootTs = m.threadTs ?? m.ts;
    const key = channelThreadKey(m.channel, rootTs);
    const alias = this.aliasFor(m.user);
    const bound = this.store.get(key);
    const route = mentionRoute({
      active: this.activeFlag,
      alias,
      boundOwner: bound ? this.ownerOf(bound) : undefined,
      noticeShown: !!m.user && this.noticeShown.has(`${key}:${m.user}`),
    });
    if (route === "legacy") return false;
    if (route === "ignore") return true;
    if (route === "no-persona") {
      await this.threadNotice(m.channel, rootTs, m.user, this.noPersonaText());
      return true;
    }
    if (route === "foreign") {
      await this.foreignNotice(m.channel, rootTs, m.user, bound);
      return true;
    }
    if (this.inboundSeen.seen(inboundKey(m.channel, m.ts))) return true;
    const owner = alias!;
    this.engaged.add(owner);
    const text = slackToPlain(m.text, this.opts.botUserId);
    const mute = parseMuteCommand(text);
    await this.run(key, async () => {
      let b = this.store.get(key);
      if (b && this.ownerOf(b) !== owner) return this.foreignNotice(m.channel, rootTs, m.user, b);
      if (!b) {
        const info = await this.channelInfo(m.channel);
        b = await this.ensureBinding(owner, key, "channel", m.channel, rootTs, channelTitle(info.name, text), info.external ? "external" : "shared");
      }
      if (!b) return this.failed({ channel: m.channel, ts: m.ts!, threadTs: rootTs, private: false }, "couldn't open a Persona thread here");
      if (mute) return this.setMuted(b, mute === "mute");
      if (!text) return;
      await this.sendWithContext(b, m, text);
    });
    return true;
  }

  /** An ephemeral notice in a channel thread, shown to `userId` once per thread. */
  private async threadNotice(channel: string, threadTs: string, userId: string | undefined, text: string): Promise<void> {
    if (!userId) return;
    const key = `${channelThreadKey(channel, threadTs)}:${userId}`;
    if (this.noticeShown.has(key)) return;
    this.noticeShown.remember(key);
    await this.call("chat.postEphemeral", { channel, user: userId, thread_ts: threadTs, text });
  }

  /** Tell a mapped user once that this thread belongs to someone else's Persona. */
  private async foreignNotice(channel: string, threadTs: string, userId: string | undefined, bound: PersonaThreadBinding | undefined): Promise<void> {
    const owner = bound ? this.ownerOf(bound) : undefined;
    const ownerSlack = this.slackIdOf(owner);
    const whose = ownerSlack ? `<@${ownerSlack}>'s` : owner ? `${owner}'s` : "someone else's";
    await this.threadNotice(channel, threadTs, userId, `This thread is ${whose} Persona — DM me to use your own.`);
  }

  /**
   * A plain message in a channel thread. Returns true when the thread is
   * Persona's (whatever became of the message), false when it isn't so the
   * caller can keep routing (e.g. mirror threads).
   */
  async onThreadMessage(m: InboundSlackMessage): Promise<boolean> {
    if (!m.threadTs || !m.ts) return false;
    const key = channelThreadKey(m.channel, m.threadTs);
    const b = this.store.get(key);
    if (!b) return false;
    const sender = this.aliasFor(m.user);
    const route = threadMessageRoute({
      active: this.activeFlag,
      bound: true,
      isOwner: !!sender && sender === this.ownerOf(b),
      muted: !!b.muted,
      mentionsBot: m.text.includes(`<@${this.opts.botUserId}`),
      text: slackToPlain(m.text, this.opts.botUserId),
    });
    if (route === "ignore") return true;
    if (this.inboundSeen.seen(inboundKey(m.channel, m.ts))) return true;
    await this.run(key, async () => {
      const current = this.store.get(key);
      if (!current) return;
      if (route === "mute" || route === "unmute") return this.setMuted(current, route === "mute");
      const text = slackToPlain(m.text, this.opts.botUserId);
      if (text) await this.sendWithContext(current, m, text);
    });
    return true;
  }

  /** "Send to Persona": forward a message (and its thread) to the clicking user's DM thread. */
  async onShortcut(s: PersonaShortcut): Promise<void> {
    if (!this.activeFlag) {
      if (s.userId) {
        await this.call("chat.postEphemeral", {
          channel: s.channelId,
          user: s.userId,
          text: "Persona isn't available in Slack right now.",
        });
      }
      return;
    }
    const alias = this.aliasFor(s.userId);
    if (!alias) {
      if (s.userId) {
        await this.call("chat.postEphemeral", {
          channel: s.channelId,
          user: s.userId,
          text: this.noPersonaText(),
        });
      }
      return;
    }
    this.engaged.add(alias);
    const dm = await this.dmFor(s.userId!);
    if (!dm) return;
    const key = dmKey(dm);
    await this.run(key, async () => {
      const b = await this.ensureBinding(alias, key, "dm", dm, undefined, "Slack DM", "private");
      if (!b) return;
      const permalinkRes = await this.call("chat.getPermalink", { channel: s.channelId, message_ts: s.message.ts });
      const permalink = typeof permalinkRes.data.permalink === "string" ? permalinkRes.data.permalink : undefined;
      const author = s.message.user ? await this.userName(s.message.user) : s.message.username ?? "someone";
      const where = `#${s.channelName || s.channelId}`;

      let context: PersonaContextMessage[] = [];
      if (s.message.threadTs) {
        const replies = await this.threadReplies(s.channelId, s.message.threadTs, undefined);
        if (replies) context = await this.toContext(replies.filter((r) => r.user !== this.opts.botUserId));
      }
      // The forwarded message itself, marked as the one forwarded and where it
      // came from, is always part of the context — as are the thread's root.
      // The note leads so clipping a long message never cuts it.
      const note = `(the forwarded message — ${where}${permalink ? `, ${permalink}` : ""})`;
      const forwarded = context.find((c) => c.ts === s.message.ts);
      if (forwarded) {
        forwarded.text = `${note}\n${forwarded.text}`;
      } else {
        const text = slackToPlain(s.message.text ?? "", this.opts.botUserId, (id) => this.userNames.get(id));
        context.push({ author, text: text ? `${note}\n${text}` : note, ts: s.message.ts });
        context.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
      }
      const pinned = new Set([s.message.ts, ...(s.message.threadTs ? [s.message.threadTs] : [])]);
      const res = await this.collector.personaSend(alias, {
        threadId: b.threadId,
        text: FORWARD_TEXT,
        idempotencyKey: `forward:${s.channelId}:${s.message.ts}:${s.actionTs ?? ""}`,
        context: capContext(context, DEFAULT_CONTEXT_CAPS, pinned),
      });
      await this.call("chat.postEphemeral", {
        channel: s.channelId,
        user: s.userId,
        text: res.ok
          ? "📨 Sent to Persona — it'll reply in your DM."
          : `⚠️ Couldn't send that to Persona${res.error ? `: ${res.error}` : "."}`,
      });
    });
  }

  /** A quick-reply button: send the option's text as the thread's owner, then redraw the card without buttons. */
  async onOptionButton(tap: PersonaButtonTap): Promise<void> {
    const parsed = parseOptionAction(tap.actionId);
    if (!parsed || !tap.value) return;
    const owner = this.threadOwner(parsed.threadId);
    if (!owner || this.aliasFor(tap.userId) !== owner) {
      if (tap.channel && tap.userId) {
        const ownerSlack = this.slackIdOf(owner);
        await this.call("chat.postEphemeral", {
          channel: tap.channel,
          user: tap.userId,
          text: `Only ${ownerSlack ? `<@${ownerSlack}>` : "the Persona's owner"} can answer this Persona.`,
        });
      }
      return;
    }
    const res = await this.collector.personaSend(owner, {
      threadId: parsed.threadId,
      text: tap.value,
      idempotencyKey: `option:${tap.messageTs ?? ""}:${parsed.index}`,
      ...(parsed.messageId ? { replyTo: { messageId: parsed.messageId, optionIndex: parsed.index } } : {}),
    });
    if (!res.ok) {
      if (tap.channel && tap.userId) {
        await this.call("chat.postEphemeral", {
          channel: tap.channel,
          user: tap.userId,
          text: `⚠️ Couldn't send that to Persona${res.error ? `: ${res.error}` : "."}`,
        });
      }
      return;
    }
    if (tap.channel && tap.messageTs && tap.userId) {
      const kept = (tap.messageBlocks ?? []).filter((blk) => blk.type !== "actions");
      const chose = optionChosenBlock(tap.userId, tap.value);
      await this.call("chat.update", {
        channel: tap.channel,
        ts: tap.messageTs,
        text: "Chose an option",
        blocks: [...kept, chose],
      });
    }
  }

  /**
   * The alias whose Persona thread `threadId` is: a bound thread's owner, else
   * the user whose console thread it is.
   */
  private threadOwner(threadId: string): string | undefined {
    const b = this.store.byThreadId(threadId);
    if (b) return this.ownerOf(b);
    if (this.state && threadId === this.state.threadId) return this.dir?.hostAlias;
    for (const [alias, s] of this.guestStates) if (s.threadId === threadId) return alias;
    return undefined;
  }

  /**
   * Who decides an approval: its approver, else its owner — from the approval
   * as last seen, else the card's record, else the tapping user's own list.
   */
  private async deciderOf(approvalId: string, tapper: string | undefined): Promise<string | undefined> {
    const known = this.approvalCache.get(approvalId);
    if (known) return approvalDecider(known);
    const card = this.store.approval(approvalId);
    if (card) return card.decider ?? this.dir?.hostAlias;
    if (!tapper) return undefined;
    const found = (await this.collector.personaApprovals(tapper))?.find((a) => a.id === approvalId);
    if (!found) return undefined;
    this.approvalCache.set(found.id, found);
    return approvalDecider(found);
  }

  /** Approve / Deny on an approval card. Only its decider may; the card is redrawn with the result. */
  async onApprovalButton(tap: PersonaButtonTap): Promise<void> {
    const parsed = parseApprovalAction(tap.actionId);
    if (!parsed) return;
    const decider = await this.deciderOf(parsed.approvalId, this.aliasFor(tap.userId));
    const deciderSlack = this.slackIdOf(decider);
    if (!decider || !deciderSlack || tap.userId !== deciderSlack) {
      if (tap.channel && tap.userId) {
        await this.call("chat.postEphemeral", {
          channel: tap.channel,
          user: tap.userId,
          text: deciderSlack ? `🔒 Only <@${deciderSlack}> can decide this.` : "🔒 You can't decide this.",
        });
      }
      return;
    }
    const res =
      parsed.decision === "approve"
        ? await this.collector.personaApprove(decider, parsed.approvalId)
        : await this.collector.personaDeny(decider, parsed.approvalId);
    if (res.ok) {
      this.approvalCache.set(res.data.id, res.data);
      await this.settleCard(res.data);
      return;
    }
    if (res.timedOut) {
      // The collector may still be carrying the decision out (an approved
      // launch runs before the call returns): show it as taken and let the
      // persona:approval frames (or the next resync) settle the card.
      const known = this.approvalCache.get(parsed.approvalId);
      const card = this.store.approval(parsed.approvalId);
      if (known && card?.status === "pending") {
        await this.settleCard({ ...known, status: parsed.decision === "approve" ? "approved" : "denied" });
      }
      return;
    }
    // Already decided (or expired) elsewhere: show its real state.
    const all = await this.collector.personaApprovals(decider);
    const current = all?.find((a) => a.id === parsed.approvalId);
    if (current && current.status !== "pending") await this.settleCard(current);
    if (tap.channel && tap.userId) {
      await this.call("chat.postEphemeral", {
        channel: tap.channel,
        user: tap.userId,
        text:
          res.status === 409
            ? "That approval is no longer pending."
            : `⚠️ Couldn't record that decision${res.error ? `: ${res.error}` : "."}`,
      });
    }
  }

  // ---- outbound ---------------------------------------------------------------------

  /**
   * Route a collector WS frame. Non-Persona frames are ignored. The relay
   * receives every user's persona:* frames, each addressed (`audience`) to the
   * one user it is for — an approval to its owner and, separately, to its
   * approver — so a frame is used only when that user has a Persona here and
   * it agrees with the binding or approval it names.
   */
  onWsMessage(msg: WsMessage): void {
    const to = typeof msg.audience === "string" && msg.audience ? msg.audience : undefined;
    switch (msg.type) {
      case "persona:state": {
        const s = msg.payload as HostedPersonaState;
        if (!s || typeof s.owner !== "string") return;
        if (to && to !== s.owner) return;
        if (!this.isHostState(s)) {
          if (this.hasSlackPersona(s.owner)) this.guestStates.set(s.owner, s);
          return;
        }
        this.applyState(s);
        // Turned on after a resync that found Persona off: set bindings up now.
        if (this.activeFlag && !this.initialized) this.track(this.resync());
        return;
      }
      case "persona:message": {
        if (!this.activeFlag) return;
        const m = msg.payload as PersonaMessage;
        if (!m || typeof m.threadId !== "string" || typeof m.seq !== "number") return;
        if (to && !this.hasSlackPersona(to)) return;
        const bound = this.store.byThreadId(m.threadId);
        if (bound && to && this.ownerOf(bound) !== to) return;
        if (!this.initialized && !bound) {
          // Until resync has put the console cursor at its head, a frame for an
          // unbound thread can't be placed without replaying old history.
          if (this.heldFrames.length < MAX_HELD_FRAMES) this.heldFrames.push(msg);
          return;
        }
        // An owner message's frame may be a re-publish of an old one (its job
        // tags changed), as is an answered question's, so only a fresh Persona
        // message can start a binding.
        const republish = m.role === "user" || !!m.answeredAt;
        const b = bound ?? (republish ? undefined : this.consoleBindingFromFrame(m.threadId, m.seq, to));
        if (!b) {
          // A thread the store doesn't know (state lost / created elsewhere): its
          // escalations still reach their decider's DM.
          if (m.approvalId) this.track(this.ensureApprovalCard(m.approvalId, to));
          return;
        }
        this.enqueue(b.key, () => this.deliverLive(b.key, m));
        return;
      }
      case "persona:approval": {
        if (!this.activeFlag) return;
        const a = msg.payload as Approval;
        if (!a || typeof a.id !== "string") return;
        if (to && (!this.hasSlackPersona(to) || (to !== a.owner && to !== a.approver))) return;
        this.approvalCache.set(a.id, a);
        const card = this.store.approval(a.id);
        if (!card) {
          if (a.status === "pending") this.track(this.ensureApprovalCard(a.id));
          return;
        }
        if (card.status !== a.status) this.track(this.settleCard(a));
        return;
      }
      default:
        return;
    }
  }

  /**
   * The console binding for a live frame of an unbound thread: only a user's
   * console thread (its id changed since the last resync), and only when it is
   * the frame's addressee's. It starts just before that frame, so the frame
   * posts and nothing older replays.
   */
  private consoleBindingFromFrame(threadId: string, frameSeq: number, to: string | undefined): PersonaThreadBinding | undefined {
    const owner = this.threadOwner(threadId);
    if (!owner || (to && owner !== to)) return undefined;
    return this.store.put({
      key: this.consoleKey(owner),
      kind: "console",
      threadId,
      ...(owner === this.dir?.hostAlias ? {} : { owner }),
      lastDeliveredSeq: Math.max(0, frameSeq - 1),
    });
  }

  private async ensureConsoleBinding(alias: string, threadId: string, summaries: PersonaThreadSummary[] | null): Promise<void> {
    const key = this.consoleKey(alias);
    const existing = this.store.get(key);
    if (existing && existing.threadId === threadId) return;
    const seq = await this.headSeq(alias, threadId, summaries);
    if (seq === undefined) return;
    this.store.put({ key, kind: "console", threadId, ...(key === "console" ? {} : { owner: alias }), lastDeliveredSeq: seq });
  }

  /**
   * A thread's newest seq, from the thread list (`lastMessage.seq`) when it's
   * there, else by reading the thread. Undefined when neither can be read.
   */
  private async headSeq(owner: string, threadId: string, summaries?: PersonaThreadSummary[] | null): Promise<number | undefined> {
    const list = summaries === undefined ? await this.collector.personaThreads(owner) : summaries;
    const row = list?.find((t) => t.id === threadId);
    if (row) return row.lastMessage?.seq ?? 0;
    const msgs = await this.collector.personaMessages(owner, threadId, 0);
    if (!msgs) return undefined;
    return msgs.length ? msgs[msgs.length - 1]!.seq : 0;
  }

  /** Deliver a live frame in seq order; a gap re-reads the thread from the collector. */
  private async deliverLive(key: string, m: PersonaMessage): Promise<void> {
    const b = this.store.get(key);
    if (!b) return;
    if (m.seq <= b.lastDeliveredSeq) return;
    if (m.seq > b.lastDeliveredSeq + 1) return this.catchUp(key);
    if (await this.deliverOne(b, m)) this.store.update(key, { lastDeliveredSeq: m.seq });
  }

  /** Post everything after the binding's cursor, in order, stopping at the first failure. */
  private async catchUp(key: string): Promise<void> {
    const b = this.store.get(key);
    const owner = b ? this.ownerOf(b) : undefined;
    if (!b || !owner) return;
    const msgs = await this.collector.personaMessages(owner, b.threadId, b.lastDeliveredSeq);
    if (!msgs) return;
    for (const m of msgs.sort((x, y) => x.seq - y.seq)) {
      const cur = this.store.get(key);
      if (!cur || m.seq <= cur.lastDeliveredSeq) continue;
      if (!(await this.deliverOne(cur, m))) return;
      this.store.update(key, { lastDeliveredSeq: m.seq });
    }
  }

  /**
   * Put one Persona message where it belongs. True when it's done with (posted,
   * already posted, or deliberately not mirrored), false to retry later.
   */
  private async deliverOne(b: PersonaThreadBinding, m: PersonaMessage): Promise<boolean> {
    if (m.role === "user") return true;
    if (this.store.postedTs(b.key, m.id)) return true;
    const owner = this.ownerOf(b);
    if (m.approvalId) {
      await this.ensureApprovalCard(m.approvalId, owner);
      return true;
    }
    const attachments = m.attachments ?? [];
    const hasText = !!m.text.trim() && m.text.trim() !== PERSONA_SILENT_REPLY;
    if (!hasText && attachments.length === 0) return true;
    // A slash command and its result card are a console read, not a reply.
    if (m.command) return true;
    const ownerSlack = this.slackIdOf(owner);
    // A thread whose owner no longer has a Persona here posts nowhere.
    if (!owner || !ownerSlack) return true;

    let target: { channel: string; threadTs?: string } | undefined;
    if (b.kind === "console") {
      // A routed message (a brief, a done or progress update, a question)
      // reaches the DM when its owner routes that kind to Slack; an unrouted
      // one only when it asks the owner something.
      if (m.notify ? !m.notify.channels.includes("slack") : !m.options?.length) return true;
      const dm = await this.dmFor(ownerSlack);
      if (!dm) return this.noteFailure(m);
      target = { channel: dm };
    } else if (b.channel) {
      // The owner's DM is a conversation they hold with Persona, so it gets
      // every reply, except an update they route to other channels instead
      // of Slack (done → push only). A channel thread other people read
      // gets every reply.
      if (b.kind === "dm" && m.notify && m.notify.channels.length > 0 && !m.notify.channels.includes("slack")) return true;
      target = { channel: b.channel, threadTs: b.kind === "channel" ? b.threadTs : undefined };
    } else {
      return true;
    }

    const jobLine = hasText ? jobRefsBlock(await this.jobRefs(b, m, owner)) : undefined;
    const buttons = m.options?.length ? optionBlocks(m.threadId, m.options, m.id) : [];
    const extra = jobLine ? [jobLine, ...buttons] : buttons;
    // A split message resumes after the chunks already in Slack, and counts as
    // delivered only once every chunk is. Its images follow the text, each one
    // more step of the same progress, uploaded to the same channel and thread.
    const progress = this.store.chunkProgress(b.key, m.id);
    let first = progress?.ts;
    const from = progress?.done ?? 0;
    const text = hasText ? m.text : "";
    const res = await this.postPersona(
      target.channel,
      target.threadTs,
      text,
      extra,
      from,
      ownerSlack,
      (done, ts, total) => {
        first ??= ts;
        if (done < total + attachments.length) this.store.recordChunks(b.key, m.id, first, done);
      },
      jobLine ? buttons : undefined,
    );
    let complete = res.complete;
    for (let i = Math.max(0, from - res.chunks); complete && i < attachments.length; i++) {
      const uploaded = await this.uploadAttachment(owner, ownerSlack, target.channel, target.threadTs, attachments[i]!);
      if (!uploaded) {
        complete = false;
        break;
      }
      first ??= uploaded;
      const done = res.chunks + i + 1;
      if (done < res.chunks + attachments.length) this.store.recordChunks(b.key, m.id, first, done);
    }
    if (!complete || !first) {
      const giveUp = this.noteFailure(m);
      if (giveUp && first) this.store.recordPosted(b.key, m.id, first);
      return giveUp;
    }
    this.store.recordPosted(b.key, m.id, first);
    this.failures.delete(m.id);
    if (b.kind !== "console" && m.role === "persona" && b.pendingOwnerTs && b.channel) {
      const ownerTs = b.pendingOwnerTs;
      this.store.update(b.key, { pendingOwnerTs: undefined });
      await this.react(b.channel, ownerTs, "white_check_mark");
      await this.unreact(b.channel, ownerTs, "eyes");
    }
    return true;
  }

  /**
   * The jobs a Persona reply's job line names, as far as the thread's audience
   * may see them. A DM (and a console question sent to the owner's DM) is the
   * owner's alone, so every tagged job is named, by short id when its title
   * can't be read. A shared channel thread names only jobs started in that
   * thread, so nothing from the owner's DMs, console or other threads leaks
   * into it; an external (Slack Connect) thread, or one whose audience or jobs
   * can't be read, gets no job line. A failed or slow lookup holds the post up
   * at most JOB_LOOKUP_TIMEOUT_MS and never stops it.
   */
  private async jobRefs(b: PersonaThreadBinding, m: PersonaMessage, owner: string): Promise<PersonaJobRef[]> {
    if (m.role !== "persona") return [];
    const ids = m.jobTags?.length ? m.jobTags.map((t) => t.jobId) : (m.jobIds ?? []);
    const tagged = [...new Set(ids.filter((id) => typeof id === "string" && id))];
    if (!tagged.length) return [];
    const lookup = await this.jobLookup(owner, b.kind === "channel" ? m.threadId : undefined, tagged);
    if (b.kind !== "channel") return tagged.map((jobId) => ({ jobId, title: lookup.jobs?.get(jobId)?.title }));
    if (lookup.audiences?.get(m.threadId) !== "shared" || !lookup.jobs) return [];
    const jobs = lookup.jobs;
    return tagged.flatMap((jobId) => {
      const job = jobs.get(jobId);
      return job && job.threadId === m.threadId ? [{ jobId, title: job.title }] : [];
    });
  }

  /**
   * `owner`'s jobs and, for a channel thread (`threadId` set), thread
   * audiences. Each is read separately with a short timeout and reused for
   * JOB_LOOKUP_TTL_MS; see cachedRead for when it's read again sooner.
   */
  private async jobLookup(owner: string, threadId: string | undefined, jobIds: string[]): Promise<JobLookup> {
    const [jobs, audiences] = await Promise.all([
      this.cachedRead(
        this.jobReads,
        owner,
        (cached) => jobIds.every((id) => cached.has(id)),
        async () => {
          const list = await this.collector.personaJobs(owner, JOB_LOOKUP_TIMEOUT_MS);
          return list && new Map(list.map((j) => [j.id, { title: j.title, threadId: j.threadId }]));
        },
      ),
      threadId === undefined
        ? null
        : this.cachedRead(
            this.audienceReads,
            owner,
            (cached) => cached.has(threadId),
            async () => {
              const list = await this.collector.personaThreads(owner, JOB_LOOKUP_TIMEOUT_MS);
              return list && new Map(list.map((t) => [t.id, t.audience]));
            },
          ),
    ]);
    return { jobs, audiences };
  }

  /**
   * `owner`'s value from `cache`, read afresh when there is none or it's older
   * than JOB_LOOKUP_TTL_MS, or when the last read failed or doesn't `cover`
   * what's asked for — the latter at most once per JOB_LOOKUP_REFRESH_MS,
   * counted from when the last read settled. Concurrent callers share a read
   * already under way. A failed read keeps the previous value (null when
   * there is none) and restarts only its clock.
   */
  private cachedRead<T>(
    cache: Map<string, CachedRead<T>>,
    owner: string,
    covers: (value: T) => boolean,
    read: () => Promise<T | null>,
  ): Promise<T | null> {
    const now = this.now();
    const cached = cache.get(owner);
    if (cached?.pending) return cached.pending;
    if (cached && now - cached.at < JOB_LOOKUP_TTL_MS) {
      const covered = cached.value !== null && covers(cached.value);
      if (covered || now - cached.at < JOB_LOOKUP_REFRESH_MS) return Promise.resolve(cached.value);
    }
    const previous = cached?.value ?? null;
    const pending = read()
      .catch(() => null)
      .then((value) => value ?? previous);
    cache.set(owner, { at: cached?.at ?? now, value: previous, pending });
    void pending.then((value) => cache.set(owner, { at: this.now(), value }));
    return pending;
  }

  /** Count a failed delivery; after MAX_DELIVERY_ATTEMPTS give up on it so the thread isn't stuck. */
  private noteFailure(m: PersonaMessage): boolean {
    const n = (this.failures.get(m.id) ?? 0) + 1;
    this.failures.set(m.id, n);
    if (n >= MAX_DELIVERY_ATTEMPTS) {
      this.log(`[persona] giving up posting message ${m.id} (seq ${m.seq}) after ${n} attempts.`);
      this.failures.delete(m.id);
      return true;
    }
    return false;
  }

  // ---- approvals ----------------------------------------------------------------------

  /**
   * Create the approval's DM card (and channel pointer) once, however many
   * paths ask for it. `hint` is a user whose list the approval is likely in
   * (the owner of the thread that announced it).
   */
  private ensureApprovalCard(approvalId: string, hint?: string): Promise<void> {
    if (this.store.approval(approvalId)) return Promise.resolve();
    const inFlight = this.cardInFlight.get(approvalId);
    if (inFlight) return inFlight;
    const p = this.createApprovalCard(approvalId, hint).finally(() => this.cardInFlight.delete(approvalId));
    this.cardInFlight.set(approvalId, p);
    return p;
  }

  /** An approval by id, as last seen, else read from the hinted user's list and then every known user's. */
  private async findApproval(approvalId: string, hint: string | undefined): Promise<Approval | undefined> {
    const cached = this.approvalCache.get(approvalId);
    if (cached) return cached;
    const host = this.dir?.hostAlias;
    const order = [...new Set([hint, ...this.knownUsers, host].filter((a): a is string => !!a))];
    for (const alias of order) {
      const found = (await this.collector.personaApprovals(alias))?.find((a) => a.id === approvalId);
      if (found) {
        this.approvalCache.set(approvalId, found);
        return found;
      }
    }
    return undefined;
  }

  private async createApprovalCard(approvalId: string, hint: string | undefined): Promise<void> {
    const approval = await this.findApproval(approvalId, hint);
    if (!approval?.owner) return;
    const decider = approvalDecider(approval);
    const deciderSlack = this.slackIdOf(decider);
    if (!deciderSlack) {
      this.log(`[persona] no Slack user for ${decider}, who decides approval ${approvalId} — it stays in the console.`);
      return;
    }
    const dm = await this.dmFor(deciderSlack);
    if (!dm) return;
    const shown = approval;
    const res = await this.postWithFallbacks(
      dm,
      undefined,
      approvalText(shown),
      () => approvalCardBlocks(shown, this.opts.webUrl),
      () => approvalFallbackBlocks(shown, this.opts.webUrl),
    );
    if (!res) return;

    // The pointer goes only to the channel thread whose turn raised the
    // approval — never to some other thread the job happens to belong to.
    const from = approval.threadId ? this.store.byThreadId(approval.threadId) : undefined;
    let pointer: { channel: string; threadTs: string; ts: string } | undefined;
    if (from?.kind === "channel" && from.channel && from.threadTs) {
      const pts = await this.postPlain(from.channel, from.threadTs, approvalPointerText(approval, deciderSlack));
      if (pts) pointer = { channel: from.channel, threadTs: from.threadTs, ts: pts };
    }
    this.store.putApproval({ approvalId, channel: dm, decider, ts: res, pointer, status: approval.status });
    // A decision may have landed while the card was being posted.
    const latest = this.approvalCache.get(approvalId);
    if (latest && latest.status !== approval.status) await this.settleCard(latest);
  }

  /**
   * Redraw a bound card (and its pointer) for the approval's current status.
   * The new status is saved only once Slack took the redraw, so a failed
   * update is retried by the next resync instead of leaving stale buttons.
   */
  private settleCard(a: Approval): Promise<void> {
    // The owner's and the approver's copies of one frame (and a resync racing
    // them) all ask for the same redraw: one runs, a repeat joins it, and a
    // different status waits its turn so redraws land in order.
    const inFlight = this.settleInFlight.get(a.id);
    if (inFlight?.status === a.status) return inFlight.done;
    const done = (inFlight?.done.catch(() => {}) ?? Promise.resolve())
      .then(() => this.redrawCard(a))
      .finally(() => {
        if (this.settleInFlight.get(a.id)?.done === done) this.settleInFlight.delete(a.id);
      });
    this.settleInFlight.set(a.id, { status: a.status, done });
    return done;
  }

  private async redrawCard(a: Approval): Promise<void> {
    const card = this.store.approval(a.id);
    if (!card || card.status === a.status) return;
    const updated = await this.updateWithFallbacks(
      card.channel,
      card.ts,
      approvalText(a),
      approvalCardBlocks(a, this.opts.webUrl),
      approvalFallbackBlocks(a, this.opts.webUrl),
    );
    if (!updated) return;
    this.store.updateApproval(a.id, { status: a.status });
    const deciderSlack = this.slackIdOf(card.decider ?? this.dir?.hostAlias);
    if (card.pointer && deciderSlack) {
      await this.call("chat.update", {
        channel: card.pointer.channel,
        ts: card.pointer.ts,
        text: approvalPointerText(a, deciderSlack),
      });
    }
  }

  // ---- sending to Persona --------------------------------------------------------------

  /** The binding owner's message in a channel thread: gather the thread's other messages since last time as context, then send. */
  private async sendWithContext(b: PersonaThreadBinding, m: InboundSlackMessage, text: string): Promise<void> {
    const rootTs = b.threadTs ?? m.threadTs ?? m.ts!;
    const replies = await this.threadReplies(m.channel, rootTs, b.lastContextTs);
    // Everything since last time except the app's own posts and the owner's
    // messages Persona already has — the owner's other messages (e.g. the
    // thread root describing the problem, or ones sent while muted) count.
    const others = (replies ?? []).filter(
      (r) =>
        r.ts &&
        r.ts !== m.ts &&
        tsAfter(r.ts, b.lastContextTs) &&
        !tsAfter(r.ts, m.ts) &&
        r.user !== this.opts.botUserId &&
        !this.store.wasSent(b.key, r.ts),
    );
    // The thread's root (usually the problem being discussed) is kept however
    // long the thread has grown since.
    const context = capContext(await this.toContext(others), DEFAULT_CONTEXT_CAPS, new Set([rootTs]));
    await this.send(b, {
      text,
      idempotencyKey: personaIdempotencyKey(m.channel, m.ts, m.clientMsgId),
      ownerTs: m.ts!,
      context,
    });
    this.store.update(b.key, { lastContextTs: m.ts });
  }

  private async send(
    b: PersonaThreadBinding,
    a: {
      text: string;
      idempotencyKey: string;
      ownerTs: string;
      context?: PersonaContextMessage[];
      attachmentIds?: string[];
      /** The owner's message already carries the 👀. */
      reacted?: boolean;
    },
  ): Promise<void> {
    const channel = b.channel!;
    const owner = this.ownerOf(b);
    if (!owner) return;
    if (!a.reacted) await this.react(channel, a.ownerTs, "eyes");
    const res = await this.collector.personaSend(owner, {
      threadId: b.threadId,
      text: a.text,
      idempotencyKey: a.idempotencyKey,
      ...(a.context && a.context.length ? { context: a.context } : {}),
      ...(a.attachmentIds && a.attachmentIds.length ? { attachmentIds: a.attachmentIds } : {}),
    });
    if (res.ok) {
      this.store.update(b.key, { pendingOwnerTs: a.ownerTs });
      this.store.recordSent(b.key, a.ownerTs);
      return;
    }
    await this.failed(
      { channel, ts: a.ownerTs, threadTs: b.kind === "channel" ? b.threadTs : undefined, private: b.kind === "dm" },
      res.error ?? "the collector refused it",
    );
  }

  /**
   * Mark the owner's message ⚠️ and say so. The reason is shown only in the
   * owner's DM; a channel thread gets a generic line (the reason is logged).
   */
  private async failed(at: { channel: string; ts: string; threadTs?: string; private: boolean }, why: string): Promise<void> {
    await this.unreact(at.channel, at.ts, "eyes");
    await this.react(at.channel, at.ts, "warning");
    if (at.private) {
      await this.postPlain(at.channel, at.threadTs, `⚠️ Couldn't reach Persona: ${why}`);
      return;
    }
    this.log(`[persona] couldn't send a message in ${at.channel} to Persona: ${why}`);
    await this.postPlain(at.channel, at.threadTs, PUBLIC_FAILURE);
  }

  private async setMuted(b: PersonaThreadBinding, muted: boolean): Promise<void> {
    this.store.update(b.key, { muted });
    await this.postPlain(
      b.channel!,
      b.threadTs,
      muted
        ? "🔇 Muted — I'll only pick up messages here that @-mention me. `!unmute` to undo."
        : "🔊 Unmuted — your messages in this thread reach Persona again without a mention.",
    );
  }

  /**
   * The binding for a Slack address in `owner`'s Persona, creating the thread
   * on first use. A DM rebinds to whoever now owns it (it is that Slack user's
   * own DM); a channel thread bound to someone else is never taken over.
   */
  private async ensureBinding(
    owner: string,
    key: string,
    kind: PersonaBindingKind,
    channel: string,
    threadTs: string | undefined,
    title: string,
    audience: PersonaAudience,
  ): Promise<PersonaThreadBinding | undefined> {
    const existing = this.store.get(key);
    if (existing && this.ownerOf(existing) === owner) return existing;
    if (existing && kind !== "dm") return undefined;
    const res = await this.collector.personaThread(owner, { channel: "slack", externalRef: key, title, audience });
    if (!res.ok) {
      this.log(`[persona] couldn't open the Persona thread for ${key}: ${res.error ?? res.status ?? "unknown error"}`);
      return undefined;
    }
    if (res.data.owner && res.data.owner !== owner) {
      this.log(`[persona] not binding ${key}: the collector returned ${res.data.owner}'s thread for ${owner}.`);
      return undefined;
    }
    if (kind !== "console" && !audienceFitsBinding(kind, res.data.audience)) {
      this.log(`[persona] not binding ${key}: its Persona thread's audience (${res.data.audience}) doesn't fit it.`);
      return undefined;
    }
    // Start the cursor at the thread's current head so an existing thread's
    // history isn't replayed into Slack.
    const head = await this.headSeq(owner, res.data.id);
    if (head === undefined) {
      this.log(`[persona] couldn't read the Persona thread for ${key}.`);
      return undefined;
    }
    return this.store.put({ key, kind, threadId: res.data.id, owner, channel, threadTs, lastDeliveredSeq: head });
  }

  // ---- Slack helpers --------------------------------------------------------------------

  /**
   * Post a Persona message: markdown blocks (text fallback), split under Slack
   * limits, as "Persona" when allowed. Starts at chunk `from` (the ones before
   * it are already in Slack) and stops at the first chunk that fails;
   * `onPosted` hears each chunk that lands. `complete` once every chunk is in;
   * `chunks` is how many the message splits into (none for empty markdown
   * with no extra blocks). Only the Persona owner's own mention
   * (`ownerSlackId`) is left live. When Slack rejects the last chunk's
   * blocks, `plainExtraBlocks` (when given) stand in for `extraBlocks`.
   * Without markdown blocks, a chunk posted with extra blocks is carried in
   * as many mrkdwn sections as it needs.
   */
  private async postPersona(
    channel: string,
    threadTs: string | undefined,
    markdown: string,
    extraBlocks: Block[],
    from: number,
    ownerSlackId: string,
    onPosted: (done: number, ts: string, total: number) => void,
    plainExtraBlocks?: Block[],
  ): Promise<{ complete: boolean; chunks: number }> {
    const chunks = markdown.trim()
      ? splitForSlack(personaOutboundText(absoluteConsoleLinks(markdown, this.opts.consoleOrigin), ownerSlackId))
      : [];
    if (!chunks.length && extraBlocks.length) chunks.push("");
    for (let i = from; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const last = i === chunks.length - 1;
      const text = markdownToMrkdwn(chunk) || "Persona";
      const withExtras = (extras: Block[]) => () =>
        this.markdownBlocks && chunk
          ? [...personaMarkdownBlocks(chunk), ...extras]
          : extras.length
            ? [...mrkdwnSections(text), ...extras]
            : undefined;
      const plain = last && plainExtraBlocks ? withExtras(plainExtraBlocks) : undefined;
      const ts = await this.postWithFallbacks(channel, threadTs, text, withExtras(last ? extraBlocks : []), plain);
      if (!ts) return { complete: false, chunks: chunks.length };
      onPosted(i + 1, ts, chunks.length);
    }
    return { complete: true, chunks: chunks.length };
  }

  /**
   * Upload one attached image or video as a file in `channel` (in `threadTs` when set):
   * its stored copy is read from the collector by id, sent to the upload URL
   * Slack issues (files.getUploadURLExternal) and shared with
   * files.completeUploadExternal. Returns a marker for the upload, or undefined
   * to retry later. Without the files:write scope, a one-line notice that the
   * image or video is in the console stands in for it.
   */
  private async uploadAttachment(
    owner: string,
    ownerSlackId: string,
    channel: string,
    threadTs: string | undefined,
    a: PersonaAttachment,
  ): Promise<string | undefined> {
    const bytes = await this.collector.personaAttachment(owner, a.id);
    if (!bytes) {
      this.log(`[persona] couldn't read attachment ${a.id} from the collector.`);
      return undefined;
    }
    const video = isPersonaVideoMime(a.mimeType);
    const title = personaOutboundText(a.caption || a.name, ownerSlackId).replace(/\s+/g, " ").trim() || (video ? "video" : "image");
    const ticket = await this.call("files.getUploadURLExternal", {
      filename: uploadName(a),
      length: bytes.length,
      alt_text: clipMrkdwn(title, 1000),
    });
    if (!ticket.ok) {
      if (ticket.error === "missing_scope" || ticket.error === "not_allowed_token_type") {
        this.warnOnce("files:write", "Persona's images and videos can't be uploaded — add the files:write scope and reinstall; until then Slack gets a pointer to the console.");
        return this.postPlain(channel, threadTs, video ? VIDEO_IN_CONSOLE : ATTACHMENT_IN_CONSOLE);
      }
      this.log(`[persona] files.getUploadURLExternal failed: ${ticket.error ?? "unknown error"}`);
      return undefined;
    }
    const uploadUrl = typeof ticket.data.upload_url === "string" ? ticket.data.upload_url : "";
    const fileId = typeof ticket.data.file_id === "string" ? ticket.data.file_id : "";
    if (!fileId || !isSlackUploadUrl(uploadUrl)) {
      this.log("[persona] Slack returned no usable upload URL for an attachment.");
      return undefined;
    }
    if (!(await this.uploadFile(uploadUrl, bytes, a.mimeType))) {
      this.log(`[persona] uploading attachment ${a.id} to Slack failed.`);
      return undefined;
    }
    const shared = await this.call("files.completeUploadExternal", {
      files: JSON.stringify([{ id: fileId, title: clipMrkdwn(title, 250) }]),
      channel_id: channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    if (!shared.ok) {
      this.log(`[persona] files.completeUploadExternal to ${channel} failed: ${shared.error ?? "unknown error"}`);
      return undefined;
    }
    return `file:${fileId}`;
  }

  private async postPlain(channel: string, threadTs: string | undefined, text: string): Promise<string | undefined> {
    return this.postWithFallbacks(channel, threadTs, text, () => undefined);
  }

  /**
   * chat.postMessage with graceful degrades: without `chat:write.customize` the
   * post retries under the app's own name; rejected blocks retry with
   * `fallback` when there is one; a rejected `markdown` block (one still
   * refused once any fallback is) retries with the mrkdwn text, remembered for
   * the rest of the run.
   */
  private async postWithFallbacks(
    channel: string,
    threadTs: string | undefined,
    text: string,
    blocks: () => Block[] | undefined,
    fallback?: () => Block[] | undefined,
  ): Promise<string | undefined> {
    let useFallback = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const b = useFallback && fallback ? fallback() : blocks();
      const args: Record<string, unknown> = {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(b && b.length ? { blocks: b } : {}),
        ...(this.customize ? { username: "Persona" } : {}),
      };
      const res = await this.slack.call("chat.postMessage", args);
      if (res.ok) return res.ts;
      if (this.customize && (res.error === "missing_scope" || res.error === "not_allowed_token_type")) {
        this.customize = false;
        this.warnOnce("chat:write.customize", "Persona posts under the app's own name — add the chat:write.customize scope and reinstall to post as \"Persona\".");
        continue;
      }
      if (fallback && !useFallback && res.error && BLOCK_REJECTIONS.has(res.error)) {
        this.log(`[persona] Slack rejected a card in ${channel} (${res.error}) — posting the plain version.`);
        useFallback = true;
        continue;
      }
      if (this.markdownBlocks && res.error && BLOCK_REJECTIONS.has(res.error) && b?.some((x) => x.type === "markdown")) {
        // Any plain version has been rejected too, so the markdown block is
        // what Slack refuses; the full blocks get another try without it.
        this.markdownBlocks = false;
        this.warnOnce("markdown", "this workspace rejected `markdown` blocks — Persona replies fall back to mrkdwn text.");
        useFallback = false;
        continue;
      }
      this.log(`[persona] chat.postMessage to ${channel} failed: ${res.error ?? "unknown error"}`);
      return undefined;
    }
    return undefined;
  }

  /** chat.update, retried once with `fallback` blocks when Slack rejects the blocks. True when Slack took it. */
  private async updateWithFallbacks(channel: string, ts: string, text: string, blocks: Block[], fallback: Block[]): Promise<boolean> {
    let res = await this.call("chat.update", { channel, ts, text, blocks });
    if (!res.ok && res.error && BLOCK_REJECTIONS.has(res.error)) {
      res = await this.call("chat.update", { channel, ts, text, blocks: fallback });
    }
    if (!res.ok) this.log(`[persona] chat.update of ${channel}/${ts} failed: ${res.error ?? "unknown error"}`);
    return res.ok;
  }

  private async react(channel: string, ts: string, name: string): Promise<void> {
    const res = await this.call("reactions.add", { channel, timestamp: ts, name });
    if (!res.ok && res.error === "missing_scope") this.warnOnce("reactions:write", "no reactions:write scope — Persona's 👀/✅ status reactions are off.");
  }

  private async unreact(channel: string, ts: string, name: string): Promise<void> {
    await this.call("reactions.remove", { channel, timestamp: ts, name });
  }

  /** A thread's messages after `oldest` (oldest first), or null when Slack refused (e.g. a missing history scope). */
  private async threadReplies(channel: string, rootTs: string, oldest: string | undefined): Promise<SlackHistoryMessage[] | null> {
    const out: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_REPLY_PAGES; page++) {
      const res = await this.call("conversations.replies", {
        channel,
        ts: rootTs,
        limit: 200,
        ...(oldest ? { oldest, inclusive: false } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!res.ok) {
        if (res.error === "missing_scope" || res.error === "not_in_channel" || res.error === "channel_not_found") {
          this.warnOnce(
            `history:${res.error}`,
            `can't read thread history (${res.error}) — Persona gets the owner's message without thread context. Private channels need groups:history.`,
          );
        }
        return out.length ? out : null;
      }
      const messages = Array.isArray(res.data.messages) ? (res.data.messages as SlackHistoryMessage[]) : [];
      out.push(...messages);
      const meta = res.data.response_metadata as { next_cursor?: string } | undefined;
      cursor = meta?.next_cursor || undefined;
      if (!res.data.has_more || !cursor) break;
    }
    return out;
  }

  private async toContext(messages: SlackHistoryMessage[]): Promise<PersonaContextMessage[]> {
    const out: PersonaContextMessage[] = [];
    for (const r of messages) {
      if (r.subtype && r.subtype !== "bot_message" && r.subtype !== "thread_broadcast") continue;
      const text = slackToPlain(r.text ?? "", this.opts.botUserId, (id) => this.userNames.get(id));
      if (!text) continue;
      const author = r.user ? await this.userName(r.user) : r.username ?? r.bot_profile?.name ?? "unknown";
      out.push({ author, text, ...(r.ts ? { ts: r.ts } : {}) });
    }
    return out;
  }

  /** A user's display name (users.info, cached); the raw id when it can't be read. */
  private async userName(userId: string): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    const res = await this.call("users.info", { user: userId });
    const u = res.data.user as { name?: string; real_name?: string; profile?: { display_name?: string } } | undefined;
    const name = u?.profile?.display_name || u?.real_name || u?.name || userId;
    if (res.ok) this.userNames.set(userId, name);
    return name;
  }

  /**
   * A channel's name and whether it's shared with another organization (Slack
   * Connect), via conversations.info (needs channels:read / groups:read).
   * Without the scope it reads as an unnamed internal channel.
   */
  private async channelInfo(channel: string): Promise<{ name?: string; external: boolean }> {
    const res = await this.call("conversations.info", { channel });
    if (!res.ok) {
      if (res.error === "missing_scope") {
        this.warnOnce(
          "channels:read",
          "no channels:read / groups:read scope — Persona can't name channels or tell a Slack Connect channel from an internal one (all are treated as shared within the workspace).",
        );
      }
      return { external: false };
    }
    const c = res.data.channel as { name?: string; is_ext_shared?: boolean; is_pending_ext_shared?: boolean } | undefined;
    return { name: c?.name, external: !!(c?.is_ext_shared || c?.is_pending_ext_shared) };
  }

  /** Slack user `userId`'s DM channel with the app, opened (and cached) on first use. */
  private async dmFor(userId: string): Promise<string | undefined> {
    const cached = this.dmChannels.get(userId);
    if (cached) return cached;
    const res = await this.call("conversations.open", { users: userId });
    const id = (res.data.channel as { id?: string } | undefined)?.id;
    if (res.ok && typeof id === "string") {
      this.dmChannels.set(userId, id);
      return id;
    }
    this.log(`[persona] couldn't open a DM with <@${userId}>: ${res.error ?? "unknown error"}`);
    return undefined;
  }

  private async call(method: string, args: Record<string, unknown>): Promise<SlackCallResult> {
    try {
      return await this.slack.call(method, args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), data: {} };
    }
  }

  private warnOnce(key: string, line: string): void {
    if (this.warnedScopes.has(key)) return;
    this.warnedScopes.add(key);
    this.log(`[persona] ${line}`);
  }

  // ---- scheduling ------------------------------------------------------------------------

  /** Run `fn` after everything already queued for `key`; failures are logged, never thrown into the event loop. */
  private enqueue(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((err) => this.log(`[persona] ${key}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
    this.track(next);
    return next;
  }

  /** enqueue, awaited — for inbound handlers whose caller waits on the outcome. */
  private run(key: string, fn: () => Promise<void>): Promise<void> {
    return this.enqueue(key, fn);
  }

  private track(p: Promise<unknown>): void {
    const t = p.catch(() => {}).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }
}

/** `#name` for a channel when Slack said, else a snippet of the opening message. */
function channelTitle(name: string | undefined, text: string): string {
  if (name) return `#${name}`;
  const snippet = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return snippet ? `Slack thread · ${snippet}` : "Slack thread";
}
