import type { Context, Hono } from "hono";
import type {
  PersonaApproval,
  PersonaApprovalStatus,
  PersonaAudience,
  PersonaChannel,
  PersonaCommandRequest,
  PersonaCommandResponse,
  PersonaCommandsResponse,
  PersonaContextMessage,
  PersonaJobStatus,
  PersonaMessagesResponse,
  PersonaRunState,
  PersonaSendRequest,
  PersonaState,
  PersonaThreadRequest,
  PersonaUploadRequest,
  PersonaUploadResponse,
  WsMessage,
} from "@standup/shared";
import {
  PERSONA_COMMANDS,
  parsePersonaCommand,
  PERSONA_ATTACHMENT_MAX_BYTES,
  PERSONA_ATTACHMENTS_PER_MESSAGE,
  PERSONA_UPLOAD_BODY_MAX_BYTES,
  PERSONA_UPLOADS_PATH,
  PERSONA_VIDEO_MAX_BYTES,
} from "@standup/shared";
import {
  countPendingPersonaInbox,
  enqueuePersonaInbox,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaState,
  getOrCreatePersonaThreadByRef,
  getPersonaApproval,
  getPersonaAttachment,
  getPersonaJob,
  getPersonaMessageByIdempotencyKey,
  getPersonaThread,
  getPersonaUserAccess,
  getProject,
  isOwnerUpload,
  personaAttachmentPoster,
  listPendingPersonaApprovalsAwaiting,
  listPersonaApprovals,
  listPersonaApprovalsForDecider,
  listPersonaJobs,
  listPersonaKnowledgeDecisions,
  listPersonaCommitments,
  listPersonaFloorDecisions,
  listPersonaMessages,
  listPersonaOwners,
  listPersonaThreads,
  listPersonaUserAccess,
  mergePersonaAudience,
  personaHoldReport,
  publicPersonaAttachment,
  putPersonaUserAccess,
  deleteUnsentOwnerUpload,
  stageOwnerUpload,
  unsentOwnerUploadBytes,
  transitionPersonaApproval,
  updatePersonaState,
} from "@standup/store";
import { closeSettledFloorCard, floorCardDeniesHold } from "./floor-cards.js";
import type { PersonaAttachmentRecord, PersonaUserAccess } from "@standup/store";
import type { Database } from "bun:sqlite";
import { tokenMatches } from "@standup/shared/write-token";
import {
  OWNER_TOKEN_HEADER,
  PERSONA_USER_HEADER,
  USER_CHANNEL_HEADER,
  userChannelTokenMatches,
} from "@standup/shared/owner-token";
import type { PersonaRuntime } from "./runtime.js";
import type { PersonaFleet } from "./fleet.js";
import { isPersonaAlias } from "./fleet.js";
import { verifiedStoredAttachment } from "./attachments.js";
import {
  discardStoredFiles,
  formatMediaSize,
  prepareOwnerMedia,
  removeStaleOwnerUploads,
  resolveFfmpeg,
  validateOwnerUpload,
} from "./media.js";
import type { ValidOwnerUpload } from "./media.js";
import { mountScheduleRoutes } from "./schedule-routes.js";
import { APPROVAL_TTL_MS } from "./brief.js";
import { COMMAND_HANDLERS, runPersonaCommand } from "./commands/registry.js";
import type { ProcessSystem } from "../process-registry.js";
import type { RestartRecord } from "../restart/state.js";
import type { CollectorHealth } from "../server.js";
import { listPlaybooks } from "./playbook-library.js";
import { buildOwnerProfile } from "./owner-profile.js";

export const PERSONA_TOKEN_HEADER = "x-standup-persona-token";

const DISABLED_ERROR = "Persona is disabled (STANDUP_PERSONA=0)";
const JOB_STATUSES: readonly PersonaJobStatus[] = ["active", "waiting_user", "done", "failed", "cancelled"];
const APPROVAL_STATUSES: readonly PersonaApprovalStatus[] = [
  "pending",
  "approved",
  "denied",
  "executed",
  "failed",
  "expired",
];

export interface PersonaRoutesOptions {
  db: Database;
  /** The host alias: the user whose credentials every worker runs with. */
  host: string;
  /** Every user's Persona; undefined when Persona is disabled. */
  fleet?: PersonaFleet;
  /** The server's acting-identity resolver for a request (no body override). */
  identityOf(c: Context): string;
  /**
   * The owner secret (OWNER_TOKEN_HEADER): the host's write proof, an owner
   * channel's when it names the user it speaks for (PERSONA_USER_HEADER), and
   * the key of every user channel token. Without one configured, human writes
   * are refused.
   */
  ownerToken?: string;
  /**
   * Sends a frame to the WS clients: used for a decision made on a card whose
   * owner has no runtime to publish it.
   */
  broadcast?: (message: WsMessage) => void;
  /** What /health reports (the install head, when the process started), for `/state`. */
  health?: CollectorHealth;
  /** The newest restart record, read in-process, for `/state`. */
  latestRestart?: () => RestartRecord | null;
  /** The host's processes, for `/ram`; the real host when unset. */
  processes?: ProcessSystem;
  /** Standup's install dir, for `/ram`. */
  installDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/** Who a Persona request is from, resolved server-side (see mountPersonaRoutes). */
export interface PersonaCaller {
  alias: string;
  /**
   * Whether the request carries a human-channel proof for `alias`. Every human
   * route needs one, so a caller a route acts for always has it.
   */
  canWrite: boolean;
}

/** One user's Persona, as GET /api/persona/users lists it for the host. */
export interface PersonaUserSummary {
  alias: string;
  isHost: boolean;
  /** Whether a runtime runs for the user on this collector. */
  running: boolean;
  /** Null for a user with neither a runtime nor stored Persona state (listed only by their allowlist). */
  state: {
    runState: PersonaRunState;
    paused: boolean;
    pendingInbox: number;
    activeLaunches: number;
    lastTurnAt?: string;
    lastError?: string;
  } | null;
  /** Pending cards the user must decide. */
  pendingApprovals: number;
  /** The host's launch allowlist for the user; null when none is set (no launches). */
  access: PersonaUserAccess | null;
}

/**
 * Whether a state-changing request could have been forged by a page on another
 * site. A form or `text/plain` POST is a CORS "simple" request that a foreign
 * page can send without a preflight; requiring `application/json` makes every
 * cross-origin browser write preflight first, and the collector's CORS
 * allowlist refuses foreign origins there, so the write is never sent. The
 * `Origin` header itself is not compared: the console reaches the collector
 * through the web dev server's proxy (which rewrites `Host`), often from a
 * tunnel origin the allowlist doesn't name, and a non-browser caller can set
 * any `Origin` it likes anyway.
 */
export function isCrossSiteWrite(c: Context): string | null {
  const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/json" ? null : "Content-Type must be application/json";
}

/** Hostnames that only ever name this machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Splits `host[:port]` (IPv6 hosts in brackets) into a lowercased hostname and its port. */
function splitHost(raw: string): { hostname: string; port?: string } {
  const host = raw.trim().toLowerCase();
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(host);
  if (!m) return { hostname: host };
  return { hostname: m[1], port: m[2] || undefined };
}

/** Wildcard bind addresses, which name no particular host. */
const WILDCARD_BIND = new Set(["", "0.0.0.0", "::", "[::]"]);

/** The hostname a specific bind address appears as in `Host` (IPv6 bracketed), or null for a wildcard. */
function boundHostname(bindHost: string | undefined): string | null {
  const raw = (bindHost ?? "").trim().toLowerCase();
  if (WILDCARD_BIND.has(raw)) return null;
  return raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
}

/**
 * Whether a request's `Host` names this collector rather than some other name
 * that merely resolves here. A page on a foreign site can rebind its own DNS
 * name to 127.0.0.1 and then reach loopback routes as same-origin; its requests
 * still carry its own name in `Host`. Loopback names are allowed on any port;
 * `STANDUP_ALLOWED_HOSTS` (comma-separated `host[:port]`, a bare host matching
 * any port) adds the names a tunnel or proxy forwards under. A specific
 * `STANDUP_BIND_HOST` (not a wildcard) is allowed on any port too: it is the
 * address the collector listens on, and Persona's MCP proxy calls it there.
 */
export function isAllowedHost(
  host: string | null | undefined,
  allowed = process.env.STANDUP_ALLOWED_HOSTS,
  bindHost = process.env.STANDUP_BIND_HOST
): boolean {
  if (!host) return false;
  const { hostname, port } = splitHost(host);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  const bound = boundHostname(bindHost);
  if (bound && bound === hostname) return true;
  for (const entry of (allowed ?? "").split(",")) {
    if (!entry.trim()) continue;
    const want = splitHost(entry);
    if (want.hostname === hostname && (want.port === undefined || want.port === port)) return true;
  }
  return false;
}

/** The request's `Host`, falling back to its URL's (an in-process request carries no header). */
export function requestHost(c: Context): string {
  return c.req.header("host") ?? new URL(c.req.url).host;
}

const HOST_ERROR =
  "refused: this Host is not a loopback name; add it to STANDUP_ALLOWED_HOSTS (comma-separated host[:port]) to reach Persona through it";

/** Channels a thread can be bound to by external address; the console thread has none. */
const EXTERNAL_CHANNELS: readonly PersonaChannel[] = ["slack"];
/**
 * A Slack DM (IM) channel id, the only ref a private thread binds to. It starts
 * with `D`, so a `dm:` ref can never name a channel (`C…`/`G…`) and pass as
 * private — the same rule the Slack bridge applies when it adopts a binding.
 */
const SLACK_DM_ID = /^D[^\s:]+$/;
const AUDIENCES: readonly PersonaAudience[] = ["private", "shared", "external"];
const MAX_EXTERNAL_REF_CHARS = 200;
const MAX_THREAD_TITLE_CHARS = 200;
/** An attachment id as the store mints it (a UUID). */
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UPLOAD_TOO_LARGE_ERROR = `That file is too large to send: images can be at most ${formatMediaSize(PERSONA_ATTACHMENT_MAX_BYTES)} and videos ${formatMediaSize(PERSONA_VIDEO_MAX_BYTES)}`;
const PRIVATE_ONLY_ERROR = "Images and videos can only be sent in your console or Slack DM thread with Persona";

/** Whether `code` is a character of the standard base64 alphabet (not padding). */
function isBase64Char(code: number): boolean {
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    (code >= 48 && code <= 57) || // 0-9
    code === 43 || // +
    code === 47 // /
  );
}

/**
 * The bytes `data` encodes as standard, padded base64 (the only encoding an
 * upload body's data may use), or null when it is anything else. Checked by a
 * scan rather than a regex, which a body tens of megabytes long would defeat.
 */
export function decodeStrictBase64(data: string): Uint8Array | null {
  if (data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const end = data.length - padding;
  for (let i = 0; i < end; i++) {
    if (!isBase64Char(data.charCodeAt(i))) return null;
  }
  return Buffer.from(data, "base64");
}

/**
 * An inline Content-Disposition for a stored copy named `name`: an ASCII
 * `filename` (anything but word characters, dots and dashes as `_`) for old
 * clients, and the real name as RFC 5987 `filename*` for the rest.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\w.-]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Most uploads one owner may have in progress at once. */
export const UPLOADS_IN_FLIGHT_MAX = 4;
const TOO_MANY_UPLOADS_ERROR = "Too many uploads at once; try again in a moment";
/** Most bytes of uploads one owner may have stored unsent. */
export const PERSONA_UNSENT_UPLOAD_QUOTA_BYTES = 300 * 1024 * 1024;

/**
 * The request body, read until it ends or passes `max` bytes ("too-large",
 * the rest left unread), whatever Content-Length said.
 */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | "too-large"> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * A message's `attachmentIds`, deduplicated in order: none when absent, else
 * an array of at most PERSONA_ATTACHMENTS_PER_MESSAGE attachment ids; a string
 * saying what is wrong otherwise.
 */
export function parseAttachmentIds(raw: unknown): string[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !ATTACHMENT_ID.test(id))) {
    return "attachmentIds must be an array of attachment ids";
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > PERSONA_ATTACHMENTS_PER_MESSAGE) {
    return `A message can carry at most ${PERSONA_ATTACHMENTS_PER_MESSAGE} images or videos`;
  }
  return ids;
}

/**
 * The one byte range a `Range` header asks of a `size`-byte body: null to
 * send it whole (no header, another unit, several ranges, or a malformed
 * one), "unsatisfiable" when the range lies past its end.
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = header ? /^\s*bytes=(\d*)-(\d*)\s*$/.exec(header) : null;
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (m[2] && Number(m[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/** Bounds on the channel context a message may carry. */
export const CONTEXT_LIMITS = {
  messages: 50,
  textChars: 2_000,
  totalChars: 12_000,
  authorChars: 120,
  tsChars: 64,
} as const;

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Validates and bounds a message's `context`: entries need a string `text`
 * and `author` (and a string `ts` when present). The newest entries are kept —
 * at most CONTEXT_LIMITS.messages, each clipped, while their texts total no
 * more than CONTEXT_LIMITS.totalChars — and returned oldest first.
 */
export function boundContext(raw: unknown): { context?: PersonaContextMessage[]; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { error: "context must be an array" };
  const valid: PersonaContextMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: "context entries must be objects" };
    const e = entry as Record<string, unknown>;
    if (typeof e.text !== "string" || typeof e.author !== "string") {
      return { error: "context entries need string text and author" };
    }
    if (e.ts !== undefined && typeof e.ts !== "string") return { error: "context ts must be a string" };
    if (!e.text.trim()) continue;
    valid.push({
      author: clipText(e.author.trim() || "unknown", CONTEXT_LIMITS.authorChars),
      text: clipText(e.text, CONTEXT_LIMITS.textChars),
      ...(typeof e.ts === "string" && e.ts ? { ts: clipText(e.ts, CONTEXT_LIMITS.tsChars) } : {}),
    });
  }
  const kept: PersonaContextMessage[] = [];
  let total = 0;
  for (let i = valid.length - 1; i >= 0 && kept.length < CONTEXT_LIMITS.messages; i--) {
    total += valid[i]!.text.length;
    if (total > CONTEXT_LIMITS.totalChars) break;
    kept.push(valid[i]!);
  }
  kept.reverse();
  return kept.length > 0 ? { context: kept } : {};
}

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The caller's own Persona, as a write acts on it (built on first use). */
export interface PersonaGated {
  /** The caller, whose Persona this is. */
  owner: string;
  runtime: PersonaRuntime;
  caller: PersonaCaller;
}

/** The Persona a read-only route shows: the caller's own, or (`?user=`, the host only) another user's. */
export interface PersonaViewed {
  owner: string;
  /** Absent when the viewed user has no runtime running. */
  runtime?: PersonaRuntime;
  caller: PersonaCaller;
}

/**
 * Persona's REST surface under `/api/persona`. Every user has their own
 * Persona (PersonaFleet), and every human route acts on the caller's: its
 * threads, messages, jobs, approvals and schedules, and nobody else's — an id
 * of another user's row reads as unknown. The caller is resolved server-side,
 * never from a body field: an owner channel holding the owner secret may name
 * the user it speaks for (PERSONA_USER_HEADER); otherwise it is the request's
 * own identity (`identityOf`), and an anonymous caller is refused. Human
 * routes refuse any request carrying a persona token, so a Persona can never
 * approve its own requests or unpause itself.
 *
 * Every human route, read or write, needs a human-channel proof for the
 * caller: the owner secret (the host, or the user an owner channel names) or
 * the caller's own user channel token. A worker shares the host's Unix user
 * and loopback, so it could forge the identity header, but it holds neither.
 * A read never builds a runtime or writes a row: a user without a runtime
 * reads their stored rows, and their state reads as idle. The host's admin
 * routes (every user's Persona, their launch allowlists) need the host with
 * the owner secret. Persona's own routes (the tool catalog and tool calls a
 * turn's MCP proxy makes) are authenticated by the calling runtime's token
 * instead.
 */
export function mountPersonaRoutes(app: Hono, opts: PersonaRoutesOptions): void {
  const { db, host, fleet } = opts;

  const disabledState = (): PersonaState => ({
    owner: host,
    runState: "disabled",
    threadId: "",
    epoch: 0,
    pendingInbox: 0,
    activeLaunches: 0,
    maxActiveLaunches: 0,
  });

  const now = opts.now ?? (() => new Date());
  const isWrite = (c: Context) => c.req.method !== "GET" && c.req.method !== "HEAD";
  const ownerChannel = (c: Context) => tokenMatches(c.req.header(OWNER_TOKEN_HEADER), opts.ownerToken);

  /**
   * Who a human route's request is from: the user an owner channel names
   * (owner secret plus PERSONA_USER_HEADER), else the request's own identity,
   * with whether it carries a human-channel proof for that alias; a Response
   * when there is no one to act as.
   */
  const identify = (c: Context): { alias: string; proven: boolean } | Response => {
    const named = c.req.header(PERSONA_USER_HEADER)?.trim();
    if (named && ownerChannel(c)) {
      if (named !== host && !isPersonaAlias(named)) return c.json({ error: `${PERSONA_USER_HEADER} must name a user` }, 400);
      return { alias: named, proven: true };
    }
    const alias = opts.identityOf(c);
    // The host is whoever the collector runs as, whatever its alias looks like
    // (an `@` address, say); the alias rule shapes only guests' runtimes.
    if (!(alias === host && alias !== "anonymous") && !isPersonaAlias(alias)) {
      return c.json(
        { error: "Persona needs a signed-in user: this request has no authenticated identity.", reason: "unauthenticated" },
        401
      );
    }
    const proven =
      (alias === host && ownerChannel(c)) ||
      (!!opts.ownerToken && userChannelTokenMatches(opts.ownerToken, alias, c.req.header(USER_CHANNEL_HEADER)));
    return { alias, proven };
  };

  /** The caller of a human route, which must carry a human-channel proof; else the refusal. */
  const callerOf = (c: Context): PersonaCaller | Response => {
    const who = identify(c);
    if (who instanceof Response) return who;
    return who.proven ? { alias: who.alias, canWrite: true } : signInRefusal(c, who.alias);
  };

  /** A refusal for a request without a channel proof, worded for the host or a guest. */
  const signInRefusal = (c: Context, alias: string): Response =>
    c.json(
      {
        error:
          alias === host
            ? `Sign in to the Standup console as ${host} to see or direct your Persona (run \`bun run scripts/console-login.ts\`): this request doesn't carry the owner token (${OWNER_TOKEN_HEADER}).`
            : `To use your Persona, sign in to the Standup console as ${alias} (with a login link from ${host}, or by sending "login" to the Standup Slack app): this request carries no proof that it comes from your own browser or Slack.`,
        reason: "sign-in",
      },
      403
    );

  const hostOnlyRefusal = (c: Context): Response =>
    c.json({ error: `Only ${host}, the host, can see or change other users' Personas.`, reason: "host-only" }, 403);

  /** Checks shared by every human route: Persona on, a local Host, a same-site write, no persona token. */
  const baseRefusal = (c: Context): Response | null => {
    if (!fleet) return c.json({ error: DISABLED_ERROR }, 503);
    if (!isAllowedHost(requestHost(c))) return c.json({ error: HOST_ERROR }, 403);
    if (isWrite(c)) {
      const forged = isCrossSiteWrite(c);
      if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    }
    if (c.req.header(PERSONA_TOKEN_HEADER)) {
      return c.json({ error: "Persona's token cannot be used on owner routes" }, 403);
    }
    return null;
  };

  /** The caller's own Persona for a write (its runtime built on first use), or the refusal. */
  const humanGate = (c: Context): PersonaGated | Response => {
    const refused = baseRefusal(c);
    if (refused) return refused;
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const runtime = fleet!.getOrCreate(caller.alias);
    if (!runtime) {
      return c.json({ error: `No Persona for ${caller.alias}: ${fleet!.unavailableReason(caller.alias)}`, reason: "unavailable" }, 503);
    }
    return { owner: caller.alias, runtime, caller };
  };

  /** Whether the request is the host's own, through an owner channel (the admin routes' proof). */
  const isHostAdmin = (c: Context, caller: PersonaCaller) => caller.alias === host && ownerChannel(c);

  /** The host's admin gate; the caller (the host) or the refusal. */
  const adminGate = (c: Context): PersonaCaller | Response => {
    const refused = baseRefusal(c);
    if (refused) return refused;
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    return isHostAdmin(c, caller) ? caller : hostOnlyRefusal(c);
  };

  /** The caller's own Persona for a read, its runtime only when one already runs; or the refusal. */
  const readGate = (c: Context): PersonaViewed | Response => {
    const refused = baseRefusal(c);
    if (refused) return refused;
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    return { owner: caller.alias, runtime: fleet!.get(caller.alias), caller };
  };

  /** A read-only route's Persona: `?user=<alias>` shows another user's to the host alone. */
  const viewGate = (c: Context): PersonaViewed | Response => {
    const user = c.req.query("user")?.trim();
    if (!user) return readGate(c);
    const refused = baseRefusal(c);
    if (refused) return refused;
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    if (user === caller.alias) return readGate(c);
    if (!isHostAdmin(c, caller)) return hostOnlyRefusal(c);
    if (!isPersonaAlias(user)) return c.json({ error: "user must name a user" }, 400);
    return { owner: user, runtime: fleet!.get(user), caller };
  };

  /** The runtime a Persona-token request comes from, or the refusal. */
  const personaGate = (c: Context): PersonaRuntime | Response => {
    if (!fleet) return c.json({ error: DISABLED_ERROR }, 503);
    if (!isAllowedHost(requestHost(c))) return c.json({ error: HOST_ERROR }, 403);
    const runtime = fleet.byToken(c.req.header(PERSONA_TOKEN_HEADER));
    if (!runtime) return c.json({ error: "invalid persona token" }, 401);
    return runtime;
  };

  /** `owner`'s thread `threadId` (their console thread when absent), or null when it isn't theirs. */
  const resolveThread = (owner: string, threadId: string | undefined): string | null => {
    if (!threadId) return getOrCreatePersonaConsoleThread(db, owner).id;
    const thread = getPersonaThread(db, threadId);
    return thread && thread.owner === owner ? thread.id : null;
  };

  /**
   * Why `owner` can't send `ids` in `threadId`, or null when the thread is
   * private and each is an unsent upload of theirs to it. Persona's own
   * attachments and another user's uploads read as unknown.
   */
  const attachmentRefusal = (owner: string, threadId: string, ids: readonly string[]): string | null => {
    // A DM thread widened to shared after the upload was staged is read by others now.
    if (ids.length > 0 && getPersonaThread(db, threadId)?.audience !== "private") return PRIVATE_ONLY_ERROR;
    for (const id of ids) {
      const record = getPersonaAttachment(db, id);
      if (!record || record.owner !== owner || !isOwnerUpload(record)) return `Unknown attachment ${id}`;
      if (record.threadId !== threadId) return `Attachment ${id} was uploaded to another thread`;
      if (record.messageId) return `Attachment ${id} was already sent`;
    }
    return null;
  };

  /** `owner`'s console thread, created only for an owner with a runtime; "" when there is none yet. */
  const consoleThreadFor = (owner: string, runtime: PersonaRuntime | undefined): string => {
    if (runtime) return runtime.consoleThreadId();
    const first = listPersonaThreads(db, owner)
      .filter((t) => t.channel === "console")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return first?.id ?? "";
  };

  /**
   * The state of a user with no runtime on this collector, from their stored
   * row when they have one; nothing is built or written.
   */
  const idleState = (owner: string): PersonaState => {
    const stored = listPersonaOwners(db).includes(owner) ? getOrCreatePersonaState(db, owner) : null;
    return {
      owner,
      runState: stored?.paused ? "paused" : stored?.lastError ? "error" : "idle",
      threadId: consoleThreadFor(owner, undefined),
      epoch: stored?.epoch ?? 0,
      pendingInbox: countPendingPersonaInbox(db, owner),
      activeLaunches: 0,
      maxActiveLaunches: fleet!.hostRuntime().config.maxActive,
      ...(stored?.lastTurnAt ? { lastTurnAt: stored.lastTurnAt } : {}),
      ...(stored?.lastError ? { lastError: stored.lastError } : {}),
    };
  };

  /** Cards `alias` owns or must decide, newest first. */
  const approvalsFor = (alias: string, status?: PersonaApprovalStatus): PersonaApproval[] => {
    const byId = new Map<string, PersonaApproval>();
    for (const a of [...listPersonaApprovals(db, alias, status), ...listPersonaApprovalsForDecider(db, alias, status)]) {
      byId.set(a.id, a);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  /** One user's Persona for the host's People list. */
  const userSummary = (alias: string, owners: ReadonlySet<string>): PersonaUserSummary => {
    const runtime = fleet!.get(alias);
    const stored = runtime || owners.has(alias) ? getOrCreatePersonaState(db, alias) : null;
    const live = runtime?.getState();
    const runState: PersonaRunState = live
      ? live.runState
      : stored?.paused
        ? "paused"
        : stored?.lastError
          ? "error"
          : "idle";
    return {
      alias,
      isHost: alias === host,
      running: !!runtime,
      state: stored
        ? {
            runState,
            paused: stored.paused,
            pendingInbox: live?.pendingInbox ?? countPendingPersonaInbox(db, alias),
            activeLaunches: live?.activeLaunches ?? 0,
            ...(stored.lastTurnAt ? { lastTurnAt: stored.lastTurnAt } : {}),
            ...(stored.lastError ? { lastError: stored.lastError } : {}),
          }
        : null,
      pendingApprovals: listPendingPersonaApprovalsAwaiting(db, alias).length,
      access: getPersonaUserAccess(db, alias),
    };
  };

  // ── Human routes ──────────────────────────────────────────────────────────

  // The caller's Persona state. A caller without a channel proof gets only
  // whether Persona runs here (`runState`, no owner data) with `canWrite:
  // false` and the sign-in reason: the restart supervisor's health probe
  // reads that, and the console shows its sign-in prompt from it.
  app.get("/api/persona/state", (c) => {
    if (!fleet) return c.json(disabledState());
    const refused = baseRefusal(c);
    if (refused) return refused;
    const who = identify(c);
    if (who instanceof Response) return who;
    const isHost = who.alias === host;
    if (!who.proven) {
      return c.json({ runState: "idle", hostAlias: host, isHost, canWrite: false, reason: "sign-in" });
    }
    // `?user=<alias>`: the host's read-only view of another user's state.
    const user = c.req.query("user")?.trim();
    let owner = who.alias;
    if (user && user !== who.alias) {
      if (!isHostAdmin(c, { alias: who.alias, canWrite: true })) return hostOnlyRefusal(c);
      if (!isPersonaAlias(user)) return c.json({ error: "user must name a user" }, 400);
      owner = user;
    }
    const runtime = fleet.get(owner);
    const state = runtime ? runtime.getState() : idleState(owner);
    return c.json({ ...state, hostAlias: host, isHost: owner === host, canWrite: true });
  });

  app.get("/api/persona/messages", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const requested = c.req.query("threadId");
    let threadId: string;
    if (requested) {
      const thread = getPersonaThread(db, requested);
      if (!thread || thread.owner !== g.owner) return c.json({ error: "Unknown thread" }, 404);
      threadId = thread.id;
    } else {
      threadId = consoleThreadFor(g.owner, g.runtime);
    }
    // `afterSeq`/`beforeSeq` bound the page (see listPersonaMessages); a non-integer is ignored.
    // `jobId` (repeated, comma-separated, or both) keeps only the messages tagged with one of those jobs.
    const jobIds = (c.req.queries("jobId") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
    const response: PersonaMessagesResponse = {
      threadId,
      messages: threadId
        ? listPersonaMessages(db, threadId, {
            afterSeq: parseIntParam(c.req.query("afterSeq")),
            beforeSeq: parseIntParam(c.req.query("beforeSeq")),
            limit: parseIntParam(c.req.query("limit")) ?? 200,
            ...(jobIds.length > 0 ? { jobIds } : {}),
          })
        : [],
    };
    return c.json(response);
  });

  // Takes a job tag off one of the caller's messages; the message, as it now
  // stands, goes back and to the caller's clients.
  app.delete("/api/persona/messages/:id/jobs/:jobId", (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const message = g.runtime.removeMessageJobTag(c.req.param("id"), c.req.param("jobId"));
    if (!message) return c.json({ error: "Unknown message" }, 404);
    return c.json({ message });
  });

  // An attachment's stored copy (an image, or a video the owner sent), by
  // attachment id only: the row must be one a message of the owner's carries,
  // and the bytes served are the collector's own copy, never a path a caller
  // names. A single `Range: bytes=a-b` is honoured (206), so a video can seek.
  app.get("/api/persona/attachments/:id", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    const { owner } = g;
    const id = c.req.param("id");
    const attachment = ATTACHMENT_ID.test(id) ? getPersonaAttachment(db, id) : null;
    const thread = attachment?.messageId ? getPersonaThread(db, attachment.threadId) : null;
    if (!attachment || !thread || thread.owner !== owner || attachment.owner !== owner) {
      return c.json({ error: "Unknown attachment" }, 404);
    }
    const dataDir = (g.runtime ?? fleet!.hostRuntime()).dataDir;
    const stored = verifiedStoredAttachment(dataDir, attachment.sha256, attachment.mimeType);
    if (!stored) return c.json({ error: "The attachment's stored copy is missing" }, 410);
    const file = Bun.file(stored.path);
    const size = stored.size;
    const headers: Record<string, string> = {
      "content-type": attachment.mimeType,
      "accept-ranges": "bytes",
      "content-disposition": contentDisposition(attachment.name),
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    const range = parseByteRange(c.req.header("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    if (range) {
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    return new Response(file, { headers: { ...headers, "content-length": String(size) } });
  });

  // A video attachment's poster frame (personaAttachmentPoster), under the
  // same gate and checks as the video itself.
  app.get("/api/persona/attachments/:id/poster", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    const { owner } = g;
    const id = c.req.param("id");
    const attachment = ATTACHMENT_ID.test(id) ? getPersonaAttachment(db, id) : null;
    const thread = attachment?.messageId ? getPersonaThread(db, attachment.threadId) : null;
    const poster = attachment ? personaAttachmentPoster(attachment) : undefined;
    if (!attachment || !thread || thread.owner !== owner || attachment.owner !== owner || !poster) {
      return c.json({ error: "Unknown poster" }, 404);
    }
    const dataDir = (g.runtime ?? fleet!.hostRuntime()).dataDir;
    const stored = verifiedStoredAttachment(dataDir, poster.sha256, poster.mimeType);
    if (!stored) return c.json({ error: "The poster's stored copy is missing" }, 410);
    return new Response(Bun.file(stored.path), {
      headers: {
        "content-type": poster.mimeType,
        "content-length": String(stored.size),
        "cache-control": "private, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  // Uploads each owner has in progress (UPLOADS_IN_FLIGHT_MAX at most), and
  // their bytes, which the unsent-upload quota counts before they are staged.
  const uploadsInFlight = new Map<string, number>();
  const uploadBytesInFlight = new Map<string, number>();

  // Withdraws one of the owner's own unsent uploads: its row goes, and each
  // of its stored files no other row uses and no upload in progress holds.
  app.delete(`${PERSONA_UPLOADS_PATH}/:id`, (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const id = c.req.param("id");
    const removed = ATTACHMENT_ID.test(id) ? deleteUnsentOwnerUpload(db, g.owner, id) : null;
    if (!removed) return c.json({ error: "Unknown upload" }, 404);
    discardStoredFiles(db, g.runtime.dataDir, [
      { sha256: removed.sha256, mimeType: removed.mimeType },
      ...(removed.media?.frames ?? []),
      ...(removed.media?.modelCopy ? [removed.media.modelCopy] : []),
    ]);
    return c.body(null, 204);
  });

  // One image or video the owner is about to send, base64 in a JSON body
  // (owner writes are JSON-only). It is validated by content, stored, has its
  // frames or model copy derived, and is staged unsent for a later message of
  // the same private thread to carry (attachmentIds).
  app.post(PERSONA_UPLOADS_PATH, async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const { owner, runtime } = g;
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > PERSONA_UPLOAD_BODY_MAX_BYTES) {
      return c.json({ error: UPLOAD_TOO_LARGE_ERROR }, 413);
    }
    const inFlight = uploadsInFlight.get(owner) ?? 0;
    if (inFlight >= UPLOADS_IN_FLIGHT_MAX) return c.json({ error: TOO_MANY_UPLOADS_ERROR }, 429);
    uploadsInFlight.set(owner, inFlight + 1);
    try {
      return await handleUpload(c, owner, runtime);
    } finally {
      const left = (uploadsInFlight.get(owner) ?? 1) - 1;
      if (left > 0) uploadsInFlight.set(owner, left);
      else uploadsInFlight.delete(owner);
    }
  });

  const handleUpload = async (c: Context, owner: string, runtime: PersonaRuntime): Promise<Response> => {
    const raw = await readBodyCapped(c.req.raw, PERSONA_UPLOAD_BODY_MAX_BYTES);
    if (raw === "too-large") return c.json({ error: UPLOAD_TOO_LARGE_ERROR }, 413);
    let body: Partial<PersonaUploadRequest>;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<PersonaUploadRequest>) : {};
    } catch {
      return c.json({ error: "The upload body must be JSON" }, 400);
    }
    if (body.name !== undefined && typeof body.name !== "string") return c.json({ error: "name must be a string" }, 400);
    if (body.mimeType !== undefined && typeof body.mimeType !== "string") {
      return c.json({ error: "mimeType must be a string" }, 400);
    }
    if (body.threadId !== undefined && typeof body.threadId !== "string") {
      return c.json({ error: "threadId must be a string" }, 400);
    }
    if (typeof body.dataBase64 !== "string" || !body.dataBase64) return c.json({ error: "dataBase64 is required" }, 400);
    const bytes = decodeStrictBase64(body.dataBase64);
    if (!bytes) return c.json({ error: "dataBase64 is not valid base64" }, 400);
    const threadId = resolveThread(owner, body.threadId || undefined);
    if (!threadId) return c.json({ error: "Unknown thread" }, 404);
    if (getPersonaThread(db, threadId)?.audience !== "private") return c.json({ error: PRIVATE_ONLY_ERROR }, 400);
    const upload = validateOwnerUpload({ name: body.name, declaredMime: body.mimeType, bytes });
    if (!upload.ok) return c.json({ error: upload.error }, upload.status);
    removeStaleOwnerUploads(db, runtime.dataDir, owner, now());
    // Uploads still being prepared count toward the quota too.
    const unsent = unsentOwnerUploadBytes(db, owner) + (uploadBytesInFlight.get(owner) ?? 0);
    if (unsent + upload.bytes.length > PERSONA_UNSENT_UPLOAD_QUOTA_BYTES) {
      return c.json(
        {
          error: `Your unsent images and videos already take ${formatMediaSize(unsent)} (at most ${formatMediaSize(PERSONA_UNSENT_UPLOAD_QUOTA_BYTES)}); send them, or wait a day for them to expire, before uploading more`,
        },
        413
      );
    }
    uploadBytesInFlight.set(owner, (uploadBytesInFlight.get(owner) ?? 0) + upload.bytes.length);
    try {
      return await stageUpload(c, owner, runtime, threadId, upload);
    } finally {
      const left = (uploadBytesInFlight.get(owner) ?? 0) - upload.bytes.length;
      if (left > 0) uploadBytesInFlight.set(owner, left);
      else uploadBytesInFlight.delete(owner);
    }
  };

  const stageUpload = async (
    c: Context,
    owner: string,
    runtime: PersonaRuntime,
    threadId: string,
    upload: ValidOwnerUpload
  ): Promise<Response> => {
    const prepared = await prepareOwnerMedia(upload, { db, dataDir: runtime.dataDir, ffmpeg: resolveFfmpeg() });
    if (!prepared.ok) return c.json({ error: prepared.error }, prepared.status);
    let record: PersonaAttachmentRecord;
    try {
      record = stageOwnerUpload(db, {
        owner,
        threadId,
        sha256: upload.sha256,
        mimeType: upload.mimeType,
        bytes: upload.bytes.length,
        name: upload.name,
        media: prepared.media,
      });
    } catch (err) {
      prepared.release();
      discardStoredFiles(db, runtime.dataDir, prepared.files);
      throw err;
    }
    prepared.release();
    const response: PersonaUploadResponse = { attachment: publicPersonaAttachment(record) };
    return c.json(response, 201);
  };

  app.post("/api/persona/messages", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const { owner, runtime } = g;
    const body = await c.req.json<PersonaSendRequest>().catch(() => ({}) as PersonaSendRequest);
    const attachmentIds = parseAttachmentIds(body.attachmentIds);
    if (typeof attachmentIds === "string") return c.json({ error: attachmentIds }, 400);
    const text = body.text === undefined && attachmentIds.length > 0 ? "" : body.text;
    if (typeof text !== "string") return c.json({ error: "text is required" }, 400);
    if (!text.trim() && attachmentIds.length === 0) return c.json({ error: "text is required" }, 400);
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
      return c.json({ error: "idempotencyKey must be a string" }, 400);
    }
    const bounded = boundContext(body.context);
    if (bounded.error) return c.json({ error: bounded.error }, 400);
    const replyTo = body.replyTo;
    if (
      replyTo !== undefined &&
      (typeof replyTo !== "object" ||
        replyTo === null ||
        typeof replyTo.messageId !== "string" ||
        !replyTo.messageId ||
        typeof replyTo.optionIndex !== "number" ||
        !Number.isInteger(replyTo.optionIndex) ||
        replyTo.optionIndex < 0)
    ) {
      return c.json({ error: "replyTo must be { messageId: string, optionIndex: non-negative integer }" }, 400);
    }
    if (body.jobId !== undefined && (typeof body.jobId !== "string" || !body.jobId)) {
      return c.json({ error: "jobId must be a non-empty string" }, 400);
    }
    const threadId = resolveThread(owner, body.threadId);
    if (!threadId) return c.json({ error: "Unknown thread" }, 404);
    // A shared thread's message may name only that thread's jobs.
    if (body.jobId !== undefined && !runtime.jobTaggableIn(threadId, body.jobId)) {
      return c.json({ error: "Unknown job" }, 404);
    }
    const idempotencyKey = body.idempotencyKey?.trim() || undefined;
    // A retried send returns the message it first made, whatever it names now.
    const replayed = idempotencyKey ? getPersonaMessageByIdempotencyKey(db, threadId, idempotencyKey) : null;
    // A slash command's key never stands in for a message to Persona.
    if (replayed?.command) return c.json({ error: "idempotencyKey was used by a slash command" }, 409);
    if (!replayed) {
      const refused = attachmentRefusal(owner, threadId, attachmentIds);
      if (refused) return c.json({ error: refused }, 400);
    }
    const message = runtime.receiveUserMessage({
      text,
      threadId,
      idempotencyKey,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      actor: owner,
      context: bounded.context,
      ...(replyTo ? { replyTo: { messageId: replyTo.messageId, optionIndex: replyTo.optionIndex } } : {}),
      ...(body.jobId ? { jobId: body.jobId } : {}),
    });
    return c.json({ message }, 201);
  });

  app.get("/api/persona/commands", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    const response: PersonaCommandsResponse = { commands: [...PERSONA_COMMANDS] };
    return c.json(response);
  });

  // A slash command: run deterministically from the store and kept in the
  // thread as the owner's line plus a result card. Never a Persona turn — the
  // messages are posted without an inbox item, and turns leave them out of
  // the history they read.
  app.post("/api/persona/commands", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const { owner, runtime } = g;
    const body = await c.req.json<PersonaCommandRequest>().catch(() => ({}) as PersonaCommandRequest);
    if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text is required" }, 400);
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
      return c.json({ error: "idempotencyKey must be a string" }, 400);
    }
    const parsed = parsePersonaCommand(body.text);
    if (!parsed || !COMMAND_HANDLERS.has(parsed.name)) return c.json({ error: "Unknown command" }, 400);
    const threadId = resolveThread(owner, body.threadId);
    if (!threadId) return c.json({ error: "Unknown thread" }, 404);
    // A command's card reads the owner's private state, so it runs only where only they read.
    if (getPersonaThread(db, threadId)?.audience !== "private") {
      return c.json({ error: "Slash commands run only in your console or Slack DM thread with Persona" }, 400);
    }
    // The owner's line keeps the client's key, so the console reconciles its
    // pending copy from the echo; the card's key is derived from it.
    const idempotencyKey = body.idempotencyKey?.trim() || undefined;
    const resultKey = idempotencyKey ? `cmd-result:${idempotencyKey}` : undefined;
    if (idempotencyKey) {
      const message = getPersonaMessageByIdempotencyKey(db, threadId, idempotencyKey);
      const result = resultKey ? getPersonaMessageByIdempotencyKey(db, threadId, resultKey) : null;
      if ((message && !message.command) || (result && !result.command)) {
        return c.json({ error: "idempotencyKey was used by another message" }, 409);
      }
      if (message && result) {
        const replay: PersonaCommandResponse = { message, result };
        return c.json(replay, 200);
      }
    }
    const command = { name: parsed.name, args: parsed.args };
    const message = runtime.postMessage({
      threadId,
      role: "user",
      text: body.text.trim(),
      actor: owner,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      command,
    });
    const outcome = runPersonaCommand(parsed.name, {
      db,
      owner,
      now: opts.now?.() ?? new Date(),
      args: parsed.args,
      runtime,
      ...(opts.health ? { health: opts.health } : {}),
      ...(opts.latestRestart ? { latestRestart: opts.latestRestart } : {}),
      host: opts.host,
      ...(opts.processes ? { processes: opts.processes } : {}),
      ...(opts.installDir ? { installDir: opts.installDir } : {}),
    });
    if (!outcome) return c.json({ error: "Unknown command" }, 400);
    const result = runtime.postMessage({
      threadId,
      role: "system",
      text: outcome.summary,
      ...(resultKey ? { idempotencyKey: resultKey } : {}),
      command: { ...command, result: outcome },
    });
    const response: PersonaCommandResponse = { message, result };
    return c.json(response, 201);
  });

  app.get("/api/persona/threads", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    // A running Persona always has its console thread; a read never creates one for a user without a runtime.
    if (g.runtime) consoleThreadFor(g.owner, g.runtime);
    return c.json({ threads: listPersonaThreads(db, g.owner) });
  });

  app.post("/api/persona/threads", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const { owner } = g;
    // An external thread binds Persona to a Slack address, and only the bridge
    // (an owner channel) has verified that the address belongs to this user. A
    // user channel token from a browser can't bind one, or a guest could point
    // their Persona's replies at someone else's DM or a private channel.
    if (!ownerChannel(c)) {
      return c.json(
        { error: "Only an owner channel (the Slack bridge) can bind an external thread.", reason: "host-only" },
        403
      );
    }
    const body = await c.req.json<Partial<PersonaThreadRequest>>().catch(() => ({}) as Partial<PersonaThreadRequest>);
    if (!EXTERNAL_CHANNELS.includes(body.channel as PersonaChannel)) {
      return c.json({ error: `channel must be one of ${EXTERNAL_CHANNELS.join(", ")}` }, 400);
    }
    const externalRef = typeof body.externalRef === "string" ? body.externalRef.trim() : "";
    if (!externalRef) return c.json({ error: "externalRef is required" }, 400);
    if (externalRef.length > MAX_EXTERNAL_REF_CHARS) {
      return c.json({ error: `externalRef must be at most ${MAX_EXTERNAL_REF_CHARS} characters` }, 400);
    }
    if (body.title !== undefined && typeof body.title !== "string") return c.json({ error: "title must be a string" }, 400);
    const title = body.title?.trim() ? clipText(body.title.trim(), MAX_THREAD_TITLE_CHARS) : undefined;
    if (body.audience !== undefined && !AUDIENCES.includes(body.audience)) {
      return c.json({ error: `audience must be one of ${AUDIENCES.join(", ")}` }, 400);
    }
    // The ref decides who reads the thread: only a Slack DM (`dm:D…`) is the
    // owner's alone, and a caller can widen that but never narrow a channel
    // ref (`C…`/`G…`, or anything else) below shared. The store only ever
    // widens an existing thread's audience.
    const isDm = externalRef.startsWith("dm:");
    if (isDm && !SLACK_DM_ID.test(externalRef.slice(3))) {
      return c.json({ error: "a dm: externalRef must name a Slack DM id (D…)" }, 400);
    }
    const audience: PersonaAudience = mergePersonaAudience(isDm ? "private" : "shared", body.audience);
    const thread = getOrCreatePersonaThreadByRef(db, owner, body.channel as PersonaChannel, externalRef, title, audience);
    return c.json({ thread });
  });

  app.get("/api/persona/jobs", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const status = c.req.query("status");
    if (status && !JOB_STATUSES.includes(status as PersonaJobStatus)) {
      return c.json({ error: `status must be one of ${JOB_STATUSES.join(", ")}` }, 400);
    }
    return c.json({ jobs: listPersonaJobs(db, g.owner, { status: status as PersonaJobStatus | undefined }) });
  });

  // The caller's cards: those of their own Persona and those they must decide
  // (a guest's floor allow is the host's). A host viewing `?user=` sees that
  // user's own cards.
  app.get("/api/persona/approvals", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const status = c.req.query("status");
    if (status && !APPROVAL_STATUSES.includes(status as PersonaApprovalStatus)) {
      return c.json({ error: `status must be one of ${APPROVAL_STATUSES.join(", ")}` }, 400);
    }
    const wanted = status as PersonaApprovalStatus | undefined;
    return c.json({
      approvals: g.owner === g.caller.alias ? approvalsFor(g.owner, wanted) : listPersonaApprovals(db, g.owner, wanted),
    });
  });

  // The noisy-hold report: the owner's decisions grouped by the rule each
  // hold was raised under. Read-only — it suggests, and never changes policy.
  app.get("/api/persona/hold-report", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    const { owner } = g;
    const since = c.req.query("since");
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
      return c.json({ error: "since must be an ISO date" }, 400);
    }
    return c.json(personaHoldReport(db, owner, since ? { since: new Date(since).toISOString() } : {}));
  });

  // The caller's own playbooks for the You tab: accepted ones and pending
  // drafts, each with how often launches reused it and how the last job that
  // used it ended. Only ever the caller's: playbooks are personal.
  app.get("/api/persona/playbooks", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    return c.json({
      playbooks: listPlaybooks(db, g.owner).map((p) => ({
        slug: p.slug,
        title: p.title,
        status: p.status,
        whenToUse: p.fields.whenToUse ?? "",
        updatedAt: p.updatedAt,
        fromJobId: p.fromJobId,
        usage: p.usage,
      })),
    });
  });

  // What Persona knows about the caller, read-only for the You tab: the
  // profile its system prompt carries, by section, redacted as the prompt is,
  // with the budget and what did not fit. Edits go through Persona.
  app.get("/api/persona/profile", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    const profile = buildOwnerProfile(db, g.owner);
    return c.json({
      chars: profile.text.length,
      maxChars: profile.maxChars,
      sections: profile.sections,
      omitted: profile.omittedDocs.map(({ ref, section, reason, title }) => ({ ref, section, reason, title })),
      trimmed: profile.docs.filter((d) => d.trimmed).map((d) => d.ref),
    });
  });

  // The owner's own click on one of their playbooks in the You tab: keep or
  // drop a draft, or retire an accepted one. Only the proven human owner; the
  // write itself is Persona's, the one writer of the personal layer.
  app.post("/api/persona/playbooks/:slug/:decision", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const decision = c.req.param("decision");
    if (decision !== "accept" && decision !== "reject" && decision !== "retire") {
      return c.json({ error: "decision must be accept, reject or retire" }, 400);
    }
    const done = await g.runtime.decidePlaybook(c.req.param("slug"), decision);
    return done.ok ? c.json({ ok: true, title: done.title }) : c.json({ error: done.error }, 409);
  });

  // The knowledge drafts Persona accepted or rejected, newest first, each with
  // its reason: the owner's audit of decide_knowledge_draft.
  app.get("/api/persona/knowledge-decisions", (c) => {
    const g = readGate(c);
    if (g instanceof Response) return g;
    return c.json({
      decisions: listPersonaKnowledgeDecisions(db, g.owner, {
        projectId: c.req.query("projectId") || undefined,
        limit: parseIntParam(c.req.query("limit")) ?? 100,
      }),
    });
  });

  // The safety-floor holds Persona allowed once on its own, newest first, each
  // with its call and reason: the owner's audit of those allows, which post
  // nothing in the thread. `?jobId=` narrows to one job (the job drawer).
  app.get("/api/persona/floor-decisions", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    return c.json({
      decisions: listPersonaFloorDecisions(db, g.owner, {
        jobId: c.req.query("jobId") || undefined,
        limit: parseIntParam(c.req.query("limit")) ?? 100,
      }),
    });
  });

  // Persona's commitments ledger, read-only: the open loops (default) stalest
  // first, or `?status=closed|all` with their evidence. `?jobId=` narrows to
  // one job.
  app.get("/api/persona/commitments", (c) => {
    const g = viewGate(c);
    if (g instanceof Response) return g;
    const status = c.req.query("status") || "open";
    if (!["open", "closed", "all"].includes(status)) return c.json({ error: "status must be open, closed or all" }, 400);
    return c.json({
      commitments: listPersonaCommitments(db, g.owner, {
        status: status as "open" | "closed" | "all",
        jobId: c.req.query("jobId") || undefined,
        limit: parseIntParam(c.req.query("limit")) ?? 100,
      }),
    });
  });

  /**
   * The card `id` as its decider reaches it, with the runtime of the Persona
   * it belongs to, or the refusal: unknown to anyone who neither owns nor
   * decides it, and refused to its owner when someone else (the host) decides.
   */
  const decidable = (c: Context, id: string, caller: string): { approval: PersonaApproval; runtime?: PersonaRuntime } | Response => {
    const approval = getPersonaApproval(db, id);
    const decider = approval ? approval.approver ?? approval.owner : undefined;
    if (!approval || (approval.owner !== caller && decider !== caller)) return c.json({ error: "Unknown approval" }, 404);
    if (decider !== caller) {
      return c.json({ error: `${decider} decides this card: it runs with ${decider}'s credentials.`, reason: "approver" }, 403);
    }
    return { approval, runtime: fleet!.getOrCreate(approval.owner) };
  };

  const noRuntime = (c: Context, owner: string): Response =>
    c.json({ error: `No Persona for ${owner}: ${fleet!.unavailableReason(owner)}`, reason: "unavailable" }, 503);

  /**
   * Denies a pending card whose owner has no runtime on this collector (the
   * fleet is full, say): nothing runs, so no runtime is needed. The result
   * waits in the owner's inbox for their Persona's next turn, as a running
   * Persona's deny() leaves it: in the thread the card was raised from, else
   * its job's thread, else the console thread.
   */
  const denyWithoutRuntime = (approval: PersonaApproval, decidedBy: string, reason?: string): PersonaApproval | null => {
    if (approval.status === "pending") {
      const settled = closeSettledFloorCard(db, approval);
      if (settled) return announceWithoutRuntime(settled);
    }
    const denied = transitionPersonaApproval(db, approval.id, "pending", "denied", {
      decidedBy,
      result: reason?.trim() || undefined,
    });
    if (!denied) return null;
    // A denied floor-allow card denies the hold it was holding, so the
    // worker's call is refused now rather than at the hold's timeout, the way
    // a running Persona's deny does it (denyHeldFloorAsk, through the host's
    // tools). A card holding Persona's own "Deny" leaves the hold pending.
    if (floorCardDeniesHold(denied)) {
      fleet!
        .hostRuntime()
        .tools.denyHeldFloorAsk(denied)
        .catch((err) => console.error(`[persona] denying the floor hold of approval ${denied.id} failed:`, err));
    }
    return announceWithoutRuntime(denied, reason);
  };

  /**
   * Puts a decided card's result in its owner's inbox for their Persona's
   * next turn and tells the owner's and the approver's consoles.
   */
  const announceWithoutRuntime = (decided: PersonaApproval, reason?: string): PersonaApproval => {
    const job = decided.jobId ? getPersonaJob(db, decided.jobId) : null;
    const threadId = decided.threadId || (job && job.owner === decided.owner ? job.threadId : undefined) || undefined;
    enqueuePersonaInbox(db, {
      owner: decided.owner,
      kind: "approval_result",
      payload: {
        approvalId: decided.id,
        ...(decided.jobId ? { jobId: decided.jobId } : {}),
        action: decided.action,
        summary: decided.summary,
        status: decided.status,
        result: decided.result,
        decidedBy: decided.decidedBy,
        reason: reason?.trim() || undefined,
      },
      threadId,
    });
    const frame = { type: "persona:approval", payload: decided, timestamp: now().toISOString() } as const;
    opts.broadcast?.({ ...frame, audience: decided.owner });
    if (decided.approver && decided.approver !== decided.owner) opts.broadcast?.({ ...frame, audience: decided.approver });
    return decided;
  };

  app.post("/api/persona/approvals/:id/approve", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const target = decidable(c, c.req.param("id"), g.owner);
    if (target instanceof Response) return target;
    const pending = target.approval;
    if (pending.status !== "pending") return c.json({ error: "Approval is not pending" }, 409);
    if (now().getTime() - Date.parse(pending.createdAt) > APPROVAL_TTL_MS) {
      return c.json({ error: "Approval has expired" }, 409);
    }
    if (!target.runtime) {
      // A card whose safety-floor hold was settled meanwhile needs no runtime to close.
      const settled = closeSettledFloorCard(db, pending);
      return settled ? c.json({ approval: announceWithoutRuntime(settled) }) : noRuntime(c, pending.owner);
    }
    const approval = await target.runtime.approve(pending.id, g.owner);
    if (!approval) return c.json({ error: "Approval is not pending" }, 409);
    return c.json({ approval });
  });

  app.post("/api/persona/approvals/:id/deny", async (c) => {
    const g = humanGate(c);
    if (g instanceof Response) return g;
    const target = decidable(c, c.req.param("id"), g.owner);
    if (target instanceof Response) return target;
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const approval = target.runtime
      ? target.runtime.deny(target.approval.id, g.owner, reason)
      : denyWithoutRuntime(target.approval, g.owner, reason);
    if (!approval) return c.json({ error: "Approval is not pending" }, 409);
    return c.json({ approval });
  });

  const own = (c: Context, act: (runtime: PersonaRuntime) => PersonaState): Response => {
    const g = humanGate(c);
    return g instanceof Response ? g : c.json(act(g.runtime));
  };
  app.post("/api/persona/pause", (c) => own(c, (r) => r.setPaused(true)));
  app.post("/api/persona/resume", (c) => own(c, (r) => r.setPaused(false)));
  app.post("/api/persona/reset", (c) => own(c, (r) => r.reset()));

  mountScheduleRoutes(app, { db, gate: humanGate, viewGate });

  // ── The host's admin routes ───────────────────────────────────────────────

  // Every user's Persona: the host's, each running guest's, each with stored
  // Persona state, and each the host has set an allowlist for.
  app.get("/api/persona/users", (c) => {
    const g = adminGate(c);
    if (g instanceof Response) return g;
    const owners = new Set(listPersonaOwners(db));
    const aliases = new Set<string>([
      host,
      ...fleet!.all().map((r) => r.owner),
      ...owners,
      ...listPersonaUserAccess(db).map((a) => a.alias),
    ]);
    const users = [...aliases]
      .sort((a, b) => (a === host ? -1 : b === host ? 1 : a.localeCompare(b)))
      .map((alias) => userSummary(alias, owners));
    return c.json({ users });
  });

  const setUserPaused = (c: Context, paused: boolean): Response => {
    const g = adminGate(c);
    if (g instanceof Response) return g;
    const alias = c.req.param("alias") ?? "";
    if (!isPersonaAlias(alias)) return c.json({ error: "alias must name a user" }, 400);
    const runtime = fleet!.get(alias);
    if (runtime) runtime.setPaused(paused);
    else updatePersonaState(db, alias, { paused });
    return c.json({ user: userSummary(alias, new Set(listPersonaOwners(db))) });
  };
  app.post("/api/persona/users/:alias/pause", (c) => setUserPaused(c, true));
  app.post("/api/persona/users/:alias/resume", (c) => setUserPaused(c, false));

  // The projects a guest's Persona may launch workers into: its workers run
  // with the host's credentials, so the host names each one.
  app.put("/api/persona/users/:alias/access", async (c) => {
    const g = adminGate(c);
    if (g instanceof Response) return g;
    const alias = c.req.param("alias");
    if (!isPersonaAlias(alias)) return c.json({ error: "alias must name a user" }, 400);
    if (alias === host) return c.json({ error: `${host}'s own Persona launches anywhere; the allowlist is for guests` }, 400);
    const body = await c.req.json<{ launchProjects?: unknown; enabled?: unknown }>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
    const projects = body.launchProjects;
    if (!Array.isArray(projects) || !projects.every((p): p is string => typeof p === "string")) {
      return c.json({ error: "launchProjects must be an array of project ids" }, 400);
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    for (const id of projects) {
      const project = getProject(db, id.trim());
      if (!project || project.reserved) return c.json({ error: `no launchable project ${JSON.stringify(id)}` }, 400);
    }
    const access = putPersonaUserAccess(db, {
      alias,
      launchProjects: projects,
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      updatedBy: g.alias,
    });
    return c.json({ access });
  });

  // ── Persona routes (the MCP proxy) ────────────────────────────────────────

  /** A delegate lane's token on the tool routes: its runtime and lane, or undefined (see PersonaFleet.byDelegateToken). */
  const delegateGate = (c: Context) =>
    fleet && isAllowedHost(requestHost(c)) ? fleet.byDelegateToken(c.req.header(PERSONA_TOKEN_HEADER)) : undefined;

  app.get("/api/persona/tools", (c) => {
    const delegated = delegateGate(c);
    if (delegated) return c.json({ tools: delegated.lane.tools(delegated.runtime.tools.list()) });
    const runtime = personaGate(c);
    return runtime instanceof Response ? runtime : c.json({ tools: runtime.tools.list() });
  });

  app.post("/api/persona/tool", async (c) => {
    const delegated = delegateGate(c);
    const runtime = delegated ? delegated.runtime : personaGate(c);
    if (runtime instanceof Response) return runtime;
    const body = await c.req
      .json<{ name?: unknown; arguments?: unknown }>()
      .catch(() => ({}) as { name?: unknown; arguments?: unknown });
    if (typeof body.name !== "string" || !body.name) return c.json({ error: "name is required" }, 400);
    const args =
      body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
    if (delegated) return c.json(await runtime.callForLane(delegated.lane, body.name, args));
    return c.json(await runtime.tools.call(body.name, args));
  });
}
