/**
 * The Review tab's HTTP routes (mountReviewRoutes).
 *
 * Trust boundary. A worker proves which launch it speaks for with that
 * launch's review token, read from `<dataDir>/worker-tokens/<launchId>`. The
 * file is owner-only, but every worker runs as the same OS user, so the only
 * thing keeping one worker out of another's token file is the safety floor,
 * which holds tool calls naming the dir. The floor is not a sandbox: a worker
 * that builds the path at runtime can read another launch's token and submit
 * a packet into that launch's owner's queue. What limits such a forgery:
 *   - server-side refs: a submission's branch, head, base and changed files
 *     are read by the collector from the launch's own checkout, never taken
 *     from the request, so a forged packet still names the real change;
 *   - provenance: each revision records the session that submitted it,
 *     whether that was the launch's root worker session, and whether it came
 *     from a different session than the previous revision, which the console
 *     shows;
 *   - rotation: every accepted submission replaces the launch's token, so a
 *     copied token submits at most once and the real worker's next request
 *     reads the fresh one;
 *   - the owner's decision: nothing a packet says is acted on until its owner
 *     approves it in the console.
 * The same limit applies to the owner secret under `<dataDir>/secrets`, which
 * the decision routes accept as human-channel proof: it too is guarded only by
 * the floor's literal-path checks, so a same-user worker that reads it could
 * decide reviews. Closing that needs per-worker OS isolation, not route checks.
 */
import type { Context, Hono } from "hono";
import type { Database } from "bun:sqlite";
import { closeSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, relative, resolve } from "path";
import { scratchRoot } from "@standup/shared/scratch";
import type {
  Launch,
  ReviewComment,
  ReviewDecision,
  ReviewMediaInput,
  ReviewPacket,
  ReviewPacketDetail,
  ReviewPacketDraft,
  ReviewPipelineSummary,
  ReviewStatus,
  ReviewUpdatedPayload,
  ReviewsPendingPayload,
  Session,
  WsMessage,
} from "@standup/shared";
import {
  HUMAN_REVIEW_STAGE_KIND,
  pipelineWaivers,
  REVIEW_MAX_SUBMISSIONS_PER_LAUNCH,
  REVIEW_OWNER_MEDIA_QUOTA_BYTES,
  REVIEW_SUBMIT_MEDIA_MAX_BYTES,
  WORKER_TOKEN_HEADER,
  flattenWorkerText,
  quoteWorkerText,
  validateReviewPacketDraft,
} from "@standup/shared";
import { tokenMatches } from "@standup/shared/write-token";
import {
  addReviewComment,
  addReviewMedia,
  cancelSteer,
  clearReviewMedia,
  countLaunchReviewSubmissions,
  countPendingReviews,
  countReviewMediaRefs,
  createReviewPacket,
  createSteer,
  getPendingSteers,
  decideReviewPacket,
  findDraftReviewPacketForLaunch,
  findReviewComment,
  getLaunch,
  getLaunchByReviewTokenHash,
  getLaunchReviewTokenHash,
  getPipelineRunByLaunch,
  getReviewComment,
  getReviewMedia,
  getReviewPacket,
  getSession,
  heldReviewMedia,
  listReviewComments,
  listReviewMedia,
  listReviewPackets,
  personaJobForLaunch,
  submitReviewPacket,
  toReviewMediaInfo,
} from "@standup/store";
import { packetCodeReview } from "../board/projection.js";
import { workerTokenHash } from "../floor/gate.js";
import { AttachmentError, formatBytes } from "../persona/attachments.js";
import type { PersonaFleet } from "../persona/fleet.js";
import { PERSONA_WRITER_HEADER } from "../persona/memory-trust.js";
import { PERSONA_TOKEN_HEADER, isCrossSiteWrite } from "../persona/routes.js";
import type { PersonaRuntime } from "../persona/runtime.js";
import { shareStateOf } from "../share/state.js";
import { codeReviewRequirementRefusal } from "./code-review-requirement.js";
import {
  commitStagedReviewMedia,
  deleteStoredReviewMedia,
  discardStagedReviewMedia,
  isReviewMediaMime,
  openStoredReviewMedia,
  reviewMediaStream,
  reviewScratchDirFor,
  stageReviewMedia,
  statMediaForReview,
} from "./media.js";
import type { ReadReviewMediaOptions, StagedReviewMedia } from "./media.js";
import { nullPipelinePort } from "./pipeline-port.js";
import type { ReviewPipelinePort } from "./pipeline-port.js";
import {
  ANONYMOUS_ALIAS,
  defaultGitRunner,
  launchOwnsWorktree,
  onEnterHumanReview,
  resolveReviewWorker,
  reviewMediaLaunchScratch,
  reviewMediaWorktree,
  reviewRefs,
} from "./stage.js";
import type { GitRunner, ReviewRefs, ReviewWorker } from "./stage.js";
import { issueReviewToken } from "./token-file.js";

/** A packet or media id as the store mints it (a UUID). */
const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVIEW_STATUSES: readonly ReviewStatus[] = ["draft", "pending", "approved", "changes_requested", "superseded"];
/** The largest submit body accepted (the packet plus its media list). */
export const REVIEW_SUBMIT_MAX_BYTES = 512 * 1024;
export const REVIEW_COMMENT_MAX_CHARS = 8000;
const NOTIFY_INTENT_CHARS = 200;
/** A question steer's packet and question ids (see questionSteerHead). */
// The ids lead the steer, ahead of anything worker-written.
const QUESTION_STEER = /^The owner asked a question \(packet_id ([0-9a-f-]{36}), question_id ([0-9a-f-]{36})\)/;
const NOTIFY_TITLE_CHARS = 120;
const MEDIA_CACHE_SECONDS = 3600;

export interface ReviewRoutesOptions {
  db: Database;
  broadcast: (message: WsMessage) => void;
  /** Standup's data dir: stored media copies live under `<dataDir>/review-media/`. */
  dataDir: string;
  /** The request's own identity (the server's actingAlias) — never a body field. */
  identityOf(c: Context): string;
  /** Whether the request carries the owner secret (OWNER_TOKEN_HEADER). */
  ownerChannel(c: Context): boolean;
  /** Whether the request carries `alias`'s user channel token (USER_CHANNEL_HEADER). */
  userChannel(c: Context, alias: string): boolean;
  /** The calling session for a worker request, by id and then by cwd. */
  resolveCallingSession: (sessionId: string | null | undefined, cwd: string) => Session | null;
  /** Every user's Persona; undefined when Persona is disabled. */
  fleet?: PersonaFleet;
  pipelinePort?: ReviewPipelinePort;
  git?: GitRunner;
  /** Sends a push notification to `actor`. */
  push?: (title: string, message: string, actor: string) => void;
  /** The home directory and environment media paths are checked against (defaults: the process's). */
  mediaHome?: string;
  mediaEnv?: NodeJS.ProcessEnv;
  /**
   * The root of the launches' TMPDIR scratch dirs (default: scratchRoot of
   * mediaEnv and mediaHome, which is the launcher's own for the defaults).
   */
  scratchRoot?: string;
  /** The most media bytes one submission may attach, all files together (default REVIEW_SUBMIT_MEDIA_MAX_BYTES). */
  mediaTotalMaxBytes?: number;
  /** The most stored media bytes one owner's packets may hold (default REVIEW_OWNER_MEDIA_QUOTA_BYTES). */
  mediaOwnerQuotaBytes?: number;
  /** Called once the owner decided a packet (approved or changes requested), e.g. to tear down its review tunnel. */
  onDecided?: (packet: ReviewPacket) => void;
  /** Starts the session's next turn when its worker sits idle at its prompt, so a queued steer is read now. */
  startQueuedIfIdle?: (sessionId: string) => Promise<void>;
}

/** A review worker whose launch has a trusted owner. */
type OwnedReviewWorker = ReviewWorker & { owner: string };

/** `path` relative to `dir` when it lies strictly inside it, else null. */
function pathBelow(path: string, dir: string): string | null {
  const rel = relative(dir, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) ? rel : null;
}

/** `path` through its symlinks; null when it doesn't exist. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Whether a worktree recorded under the data dir is exempt from the data-dir
 * deny. Some ancestor of the recorded path must be the data dir (by real path,
 * so either may be named through a symlinked home), and the worktree's real
 * path must be either at that same place below the data dir's real path, or
 * wholly outside the data dir (a worktrees dir symlinked to another disk; a
 * file there whose own real path is in the data dir is still refused). A
 * worktree, or a dir between it and the data dir, re-pointed by a symlink to
 * somewhere else inside the data dir, or to a dir containing it, is not exempt.
 */
function worktreeInDataDir(worktree: string, dataDir: string): boolean {
  const realDataDir = realOrNull(dataDir);
  const realWorktree = realOrNull(worktree);
  if (!realDataDir || !realWorktree) return false;
  const recorded = resolve(worktree);
  for (let dir = dirname(recorded); dir !== dirname(dir); dir = dirname(dir)) {
    if (realOrNull(dir) !== realDataDir) continue;
    const below = pathBelow(realWorktree, realDataDir);
    if (below !== null) return below === relative(dir, recorded);
    return realWorktree !== realDataDir && pathBelow(realDataDir, realWorktree) === null;
  }
  return false;
}

/**
 * The request body, read from its stream and given up on (the stream
 * cancelled, nothing more buffered) as soon as it passes `max` bytes,
 * whatever Content-Length said or whether it is chunked; null when it did.
 */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The launch whose worker token (WORKER_TOKEN_HEADER's value) `presented` is,
 * while that launch has a worker to speak for it; null for a missing or
 * unknown token, or a launch that has failed or been cleaned up.
 */
export function launchForWorkerToken(db: Database, presented: string | undefined): Launch | null {
  const token = presented?.trim();
  if (!token) return null;
  const hash = workerTokenHash(token);
  const launch = getLaunchByReviewTokenHash(db, hash);
  const expected = launch ? getLaunchReviewTokenHash(db, launch.id) : null;
  if (!launch || !expected || !tokenMatches(hash, expected)) return null;
  // A stopped, failed or cleaned-up launch has no worker left to speak for it.
  if (launch.status === "failed" || launch.status === "cleaned") return null;
  return launch;
}

/** Who a read comes from: a person through a human channel, or a user's Persona (acting as its owner). */
interface ReviewCaller {
  alias: string;
  persona?: PersonaRuntime;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The packet content fields of a submitted draft, nothing else. */
function draftFields(p: ReviewPacketDraft): ReviewPacketDraft {
  return {
    title: p.title.trim(),
    intent: p.intent.trim(),
    changes: p.changes,
    validation: p.validation,
    risks: p.risks,
    links: p.links,
  };
}

/** A single `bytes=` range over `size` bytes; "unsatisfiable", or null to serve the whole file. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  // A multi-range or malformed header is ignored: the whole file is served.
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (m[2] !== "" && Number(m[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/**
 * The response serving a media row's stored copy, honoring a single byte
 * range. The digest was checked when the copy was stored; here it must still
 * be a regular file (not a symlink) of the recorded size, and is streamed,
 * never read whole. `extraHeaders` set caching and the like.
 */
export function storedMediaResponse(
  c: Context,
  dataDir: string,
  media: { sha256: string; mime: string; bytes: number },
  extraHeaders: Record<string, string>
): Response {
  if (!isReviewMediaMime(media.mime)) return c.json({ error: "The media's stored type is not servable" }, 410);
  const stored = openStoredReviewMedia(dataDir, media.sha256, media.mime, media.bytes);
  if (!stored) return c.json({ error: "The media's stored copy is missing" }, 410);
  return openedFileResponse(c, stored, media.mime, extraHeaders);
}

/**
 * The response serving an opened stored copy (`fd`, closed here or by the
 * stream) as `mime`, honoring a single byte range: inline, never sniffed,
 * sandboxed. `extraHeaders` set caching and the like.
 */
export function openedFileResponse(
  c: Context,
  stored: { fd: number; size: number },
  mime: string,
  extraHeaders: Record<string, string>
): Response {
  const { fd, size } = stored;
  const headers: Record<string, string> = {
    "content-type": mime,
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    ...extraHeaders,
  };
  const range = parseByteRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    closeSync(fd);
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  const status = range ? 206 : 200;
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const sent: Record<string, string> = {
    ...headers,
    "content-length": String(end - start + 1),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  };
  // Hono answers a HEAD by running the GET handler and dropping its body
  // unread, so a HEAD gets its headers here and no stream (or open file).
  if (c.req.method === "HEAD") {
    closeSync(fd);
    return new Response(null, { status, headers: sent });
  }
  return new Response(reviewMediaStream(fd, start, end), { status, headers: sent });
}

/**
 * The Review tab's API. Reads are scoped to the caller: a person through a
 * human channel (the owner secret or their user channel token, with a
 * non-anonymous identity), or a user's Persona, which reads as its owner. A
 * packet of anyone else's reads as unknown. Deciding a packet is a person's
 * alone (humanRefusal): no Persona credential may be on the request, and the
 * person must be the packet's owner. Workers fetch their review brief and
 * submit packets with their session (session_id/cwd), resolved server-side to
 * their launch, whose trusted launcher (reviewOwnerForLaunch) owns the
 * packet; the request must carry that launch's review token
 * (WORKER_TOKEN_HEADER), so naming another worker's session proves nothing.
 */
export function mountReviewRoutes(app: Hono, opts: ReviewRoutesOptions): void {
  const { db, fleet } = opts;
  const port = opts.pipelinePort ?? nullPipelinePort;
  const git = opts.git ?? defaultGitRunner;

  const hasPersonaCredential = (c: Context) => !!c.req.header(PERSONA_TOKEN_HEADER) || !!c.req.header(PERSONA_WRITER_HEADER);

  /** The caller of a read, or the refusal. */
  const callerOf = (c: Context): ReviewCaller | Response => {
    if (hasPersonaCredential(c)) {
      const runtime =
        fleet?.byToken(c.req.header(PERSONA_TOKEN_HEADER)) ?? fleet?.byWriterSecret(c.req.header(PERSONA_WRITER_HEADER));
      if (!runtime) return c.json({ error: "invalid persona token" }, 401);
      return { alias: runtime.owner, persona: runtime };
    }
    const alias = opts.identityOf(c);
    if (!alias || alias === ANONYMOUS_ALIAS) {
      return c.json({ error: "Reviews need a signed-in user: this request has no authenticated identity.", reason: "unauthenticated" }, 401);
    }
    if (!opts.ownerChannel(c) && !opts.userChannel(c, alias)) {
      return c.json({ error: "Reviews are read through the Standup console: this request carries no human-channel proof.", reason: "sign-in" }, 403);
    }
    return { alias };
  };

  /**
   * A refusal unless the request is a person's through a human channel: no
   * Persona credential, the owner secret or the caller's user channel token,
   * a same-site JSON write, and an identified alias. Null when they may proceed.
   */
  const humanRefusal = (c: Context, what: string): Response | null => {
    if (hasPersonaCredential(c)) return c.json({ error: `Persona's token cannot be used to ${what}` }, 403);
    const alias = opts.identityOf(c);
    if (!opts.ownerChannel(c) && !(alias && opts.userChannel(c, alias))) {
      return c.json({ error: `Only a person can ${what}: use the Standup console.` }, 403);
    }
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    if (!alias || alias === ANONYMOUS_ALIAS) return c.json({ error: `An identified user is required to ${what}` }, 403);
    return null;
  };

  /** The packet's launch's pipeline run as the reviewer sees it, when it belongs to the packet's owner. */
  const pipelineSummary = (packet: ReviewPacket): ReviewPipelineSummary | null => {
    const run = packet.launchId ? getPipelineRunByLaunch(db, packet.launchId) : null;
    if (!run || run.owner !== packet.owner) return null;
    return {
      status: run.status,
      ...(run.disabledReason ? { disabledReason: run.disabledReason } : {}),
      currentStage: run.currentStage,
      waivers: pipelineWaivers(run),
    };
  };

  // The packet's code review is read under its project's (else its launch's
  // project's) code-review adapter, as the board reads it. The packet's share
  // state is the owner's: shown to a person, never to Persona.
  const detail = (packet: ReviewPacket, caller: ReviewCaller): ReviewPacketDetail => ({
    ...packet,
    media: listReviewMedia(db, packet.id, packet.owner).map(toReviewMediaInfo),
    comments: listReviewComments(db, packet.id),
    pipeline: pipelineSummary(packet),
    codeReview: packetCodeReview(db, packet.links, packet.projectId ?? (packet.launchId ? getLaunch(db, packet.launchId)?.projectId : null)),
    ...(caller.persona ? {} : { share: shareStateOf(db, "review", packet.id, packet.owner) }),
  });

  // Addressed to the packet's owner alone: other users' sockets never learn it
  // exists. The pending count follows on its own frame, which needs no Persona
  // proof, so the Review tab's badge stays live on any of the owner's sockets.
  const broadcastUpdate = (packet: ReviewPacket) => {
    const timestamp = new Date().toISOString();
    const payload: ReviewUpdatedPayload = { packetId: packet.id, owner: packet.owner, status: packet.status };
    opts.broadcast({ type: "review:updated", payload, timestamp, audience: packet.owner });
    const pending: ReviewsPendingPayload = { count: countPendingReviews(db, packet.owner) };
    opts.broadcast({ type: "reviews:pending", payload: pending, timestamp, audience: packet.owner });
  };

  const workerTokenRefusal = (c: Context) =>
    c.json(
      {
        error: `Review requests come from a Standup-launched worker and must carry its launch's worker token (${WORKER_TOKEN_HEADER}).`,
        reason: "worker-token",
      },
      403
    );

  /**
   * The launch whose review token the request carries (WORKER_TOKEN_HEADER),
   * from the header alone, so a request is authenticated before its body is
   * read; a refusal for Persona, a missing or unknown token, or a launch that
   * has failed or been cleaned up.
   */
  const tokenLaunchOf = (c: Context): Launch | Response => {
    if (hasPersonaCredential(c)) return c.json({ error: "Review packets are submitted by the worker that made the change, not Persona" }, 403);
    return launchForWorkerToken(db, c.req.header(WORKER_TOKEN_HEADER)) ?? workerTokenRefusal(c);
  };

  /**
   * The worker a request is from: its session_id/cwd resolved to a launch
   * (a subagent through its parents), which must be the launch whose review
   * token the request carries (`tokenLaunch`), and which must have a trusted
   * owner. A refusal for a session of another launch's or of none (403 alike,
   * so the route reveals nothing about sessions it can't attribute), or for a
   * launch no trusted identity launched.
   */
  const workerOf = (
    c: Context,
    tokenLaunch: Launch,
    input: { sessionId?: unknown; cwd?: unknown }
  ): OwnedReviewWorker | Response => {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId : null;
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    if (!sessionId && !cwd) return c.json({ error: "session_id or cwd is required" }, 400);
    const worker = resolveReviewWorker(db, { sessionId, cwd }, opts.resolveCallingSession);
    if (!worker || worker.launch.id !== tokenLaunch.id) return workerTokenRefusal(c);
    const { owner } = worker;
    if (!owner) {
      return c.json(
        {
          error: "no trusted owner for this launch: it was not launched by an authenticated user or a Persona, so its review has nowhere to go",
          reason: "no-owner",
        },
        403
      );
    }
    return { ...worker, owner };
  };

  /**
   * The worker's change as the collector reads it from the checkout Standup
   * made for its launch (launchOwnsWorktree): branch, head, merge base and
   * changed files. Null for a launch with no such checkout. Nothing here
   * comes from the request.
   */
  const serverRefsFor = (worker: OwnedReviewWorker): ReviewRefs | null =>
    worker.worktree && launchOwnsWorktree(worker.launch) ? reviewRefs(worker.worktree, git, worker.launch.baseBranch) : null;

  /** The launch's review scratch dir, created when missing; undefined when it can't be (an unsafe id or dir). */
  const scratchFor = (launchId: string): string | undefined => reviewScratchDirFor(opts.dataDir, launchId);

  /** The root the launches' TMPDIR scratch dirs are under. */
  const launchScratchRoot = opts.scratchRoot ?? scratchRoot(opts.mediaEnv ?? process.env, opts.mediaHome ?? homedir());

  /** Tells `owner`'s Persona, when one runs, with a console line and a worker event it can relay. */
  const tellPersona = (owner: string, line: string, event: Record<string, unknown>) => {
    const runtime = fleet?.get(owner);
    if (!runtime) return;
    try {
      runtime.postMessage({ threadId: runtime.consoleThreadId(), role: "system", text: line });
      runtime.enqueue("worker_event", event);
    } catch (err) {
      console.error("[review] notifying Persona failed:", err);
    }
  };

  /** Queues `body` for the session's worker, readable only by `owner`'s proven sockets. */
  const steerWorker = (sessionId: string, owner: string, body: string) => {
    const steer = createSteer(db, sessionId, body, { audience: owner });
    opts.broadcast({ type: "steer:queued", payload: steer, timestamp: new Date().toISOString(), audience: owner, requireProof: true });
  };

  /**
   * A packet's launch and the session its worker is steered at: the launch's
   * current one, which moves on when a new session reports in from the same
   * pane, else the session that submitted.
   */
  const workerOfPacket = (packet: ReviewPacket) => {
    const launch = packet.launchId ? getLaunch(db, packet.launchId) : null;
    return { launch, sessionId: launch?.sessionId ?? packet.sessionId ?? undefined };
  };

  /**
   * The session a packet's worker can still be reached at: its Claude launch
   * is starting or running and its session has not ended, or the idle reaper
   * paused it (a queued steer resumes it). Null when the worker is gone, or
   * is Codex, which takes no steer.
   */
  const reachableWorkerSession = (packet: ReviewPacket): string | null => {
    const { launch, sessionId } = workerOfPacket(packet);
    if (!launch || !sessionId || launch.harness === "codex" || (launch.status !== "starting" && launch.status !== "running")) return null;
    return launch.reapedAt || !getSession(db, sessionId)?.endedAt ? sessionId : null;
  };

  /** The steer a question goes to the worker in; QUESTION_STEER reads its ids back. */
  const questionSteerHead = (packet: ReviewPacket, questionId: string) =>
    `The owner asked a question (packet_id ${packet.id}, question_id ${questionId}) on review "${packet.title}" (rev ${packet.revision}):`;

  /**
   * Cancels the packet's question steers its worker hasn't read: once it is
   * decided they would contradict the decision. They are matched by question,
   * since a steer queued before a resubmission names the earlier packet.
   */
  const cancelQuestionSteers = (packet: ReviewPacket, sessionId: string | undefined) => {
    if (!sessionId) return;
    const questions = new Set(listReviewComments(db, packet.id).filter((r) => r.kind === "question").map((r) => r.id));
    for (const steer of getPendingSteers(db, sessionId)) {
      const questionId = QUESTION_STEER.exec(steer.body)?.[2];
      if (questionId && questions.has(questionId)) cancelSteer(db, steer.id);
    }
  };

  /** The packet owner's own Persona job for the packet's launch: a job of someone else's that shares the launch is not it. */
  const ownerJobOf = (packet: ReviewPacket) => {
    const job = packet.launchId ? personaJobForLaunch(db, packet.launchId)?.job : undefined;
    return job && job.owner === packet.owner ? job : undefined;
  };

  // ── Reads ────────────────────────────────────────────────────────────────

  app.get("/api/reviews", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const raw = c.req.query("status")?.trim() || "all";
    let status: ReviewStatus | undefined;
    if (raw !== "all") {
      if (!(REVIEW_STATUSES as readonly string[]).includes(raw)) {
        return c.json({ error: `status must be all or one of ${REVIEW_STATUSES.join(", ")}` }, 400);
      }
      status = raw as ReviewStatus;
    }
    return c.json({ reviews: listReviewPackets(db, { owner: caller.alias, status }) });
  });

  app.get("/api/reviews/pending-count", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    return c.json({ count: countPendingReviews(db, caller.alias) });
  });

  // A worker's review-writer brief, so it can start review on its own: the
  // owner's draft packet for its launch is created (or reused) and the brief
  // returned, not queued.
  app.get("/api/reviews/brief", async (c) => {
    const tokenLaunch = tokenLaunchOf(c);
    if (tokenLaunch instanceof Response) return tokenLaunch;
    const worker = workerOf(c, tokenLaunch, { sessionId: c.req.query("session_id"), cwd: c.req.query("cwd") });
    if (worker instanceof Response) return worker;
    const sessionId = worker.session?.id ?? worker.launch.sessionId;
    if (!sessionId) return c.json({ error: "This launch has no session yet" }, 404);
    const { packet, brief } = onEnterHumanReview(
      db,
      {
        owner: worker.owner,
        launchId: worker.launch.id,
        sessionId,
        jobId: worker.jobId,
        projectId: worker.projectId,
        worktree: worker.worktree,
        scratchDir: scratchFor(worker.launch.id),
        scratchRoot: launchScratchRoot,
      },
      { git, queueSteer: false, changesNoCode: (await port.changesNoCode?.(worker.launch.id)) ?? false }
    );
    return c.json({ packetId: packet.id, brief });
  });

  app.get("/api/reviews/:id", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const id = c.req.param("id");
    const packet = REVIEW_ID.test(id) ? getReviewPacket(db, id, caller.alias) : null;
    if (!packet) return c.json({ error: "Unknown review" }, 404);
    return c.json({ review: detail(packet, caller) });
  });

  // A media file's stored copy, addressed by packet and media id only: the row
  // must be the caller's, and the file served is the collector's own copy,
  // found by its digest and type, never a path a request names.
  app.get("/api/reviews/:id/media/:mediaId", (c) => {
    const caller = callerOf(c);
    if (caller instanceof Response) return caller;
    const packetId = c.req.param("id");
    const mediaId = c.req.param("mediaId");
    const media =
      REVIEW_ID.test(packetId) && REVIEW_ID.test(mediaId)
        ? getReviewMedia(db, { packetId, mediaId, owner: caller.alias })
        : null;
    if (!media) return c.json({ error: "Unknown media" }, 404);
    return storedMediaResponse(c, opts.dataDir, media, { "cache-control": `private, max-age=${MEDIA_CACHE_SECONDS}` });
  });

  // ── Worker submission ────────────────────────────────────────────────────

  app.post("/api/reviews/submit", async (c) => {
    if (hasPersonaCredential(c)) return c.json({ error: "Review packets are submitted by the worker that made the change, not Persona" }, 403);
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    // The token is a header: the request is authenticated before any of its body is read.
    const tokenLaunch = tokenLaunchOf(c);
    if (tokenLaunch instanceof Response) return tokenLaunch;
    const tooLarge = () => c.json({ error: `the submission is over ${REVIEW_SUBMIT_MAX_BYTES} bytes` }, 413);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > REVIEW_SUBMIT_MAX_BYTES) return tooLarge();
    const raw = await readBodyCapped(c.req.raw, REVIEW_SUBMIT_MAX_BYTES);
    if (raw === null) return tooLarge();
    let body: { session_id?: unknown; cwd?: unknown; packet?: unknown; media?: unknown };
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as typeof body;
    } catch {
      return c.json({ error: "malformed request body" }, 400);
    }
    // Only the session and cwd are read from the body to find the worker; any
    // branch, commit, base or file list it carries is ignored.
    const worker = workerOf(c, tokenLaunch, { sessionId: body.session_id, cwd: body.cwd });
    if (worker instanceof Response) return worker;
    const refs = serverRefsFor(worker);

    if (countLaunchReviewSubmissions(db, worker.launch.id) >= REVIEW_MAX_SUBMISSIONS_PER_LAUNCH) {
      return c.json(
        {
          error: `This launch has already submitted ${REVIEW_MAX_SUBMISSIONS_PER_LAUNCH} review packets or revisions, the most one launch may.`,
          reason: "submission-cap",
        },
        429
      );
    }

    if (body.media !== undefined && !Array.isArray(body.media)) {
      return c.json({ error: "media must be an array", problems: ["media must be an array of {path, caption}"] }, 400);
    }
    const media = (body.media ?? []) as ReviewMediaInput[];
    const problems = validateReviewPacketDraft(body.packet, {
      ...(refs?.changedFiles ? { changedFiles: refs.changedFiles } : {}),
      media,
    });
    const packetLinks = (body.packet as { links?: unknown } | null)?.links;
    const reviewRefusal = await codeReviewRequirementRefusal(db, {
      projectId: worker.projectId,
      launchId: worker.launch.id,
      links: Array.isArray(packetLinks) ? (packetLinks as ReviewPacketDraft["links"]) : [],
      ...(port.changesNoCode ? { changesNoCode: () => port.changesNoCode!(worker.launch.id) } : {}),
    });
    if (problems.length > 0) {
      return c.json({ error: "The review packet has problems", problems: [...problems, ...(reviewRefusal ? [reviewRefusal.error] : [])] }, 400);
    }
    if (reviewRefusal) {
      const { status, ...refusal } = reviewRefusal;
      return c.json(refusal, status);
    }

    // Media may come only from the launch's own TMPDIR scratch dir, its review
    // scratch dir and, for a launch whose working dir is its own, that whole
    // dir (an adopted session's cwd is wherever that session ran, and an
    // in-place launch's is the project's real repo, so neither is one) — the
    // roots the review brief names. Inside the data dir only the review
    // scratch dir and the worktree are reachable, whatever else the worktree
    // contains.
    const scratch = scratchFor(worker.launch.id);
    const worktree = reviewMediaWorktree(worker.launch);
    const launchScratch = reviewMediaLaunchScratch(db, worker.launch, launchScratchRoot);
    const mediaOpts: ReadReviewMediaOptions = {
      dataDir: opts.dataDir,
      home: opts.mediaHome,
      env: opts.mediaEnv,
      allowedRoots: [...(worktree ? [worktree] : []), ...(scratch ? [scratch] : []), ...(launchScratch ? [launchScratch] : [])],
      dataDirExcept: [...(scratch ? [scratch] : []), ...(worktree && worktreeInDataDir(worktree, opts.dataDir) ? [worktree] : [])],
    };
    const m = (i: number) => media[i]!;
    const mediaRefusal = (i: number, err: unknown) => {
      const why = err instanceof AttachmentError ? err.message : "it could not be read";
      const label = `media[${i}] ("${clip(m(i).caption, 80)}")`;
      return c.json({ error: `${label} can't be attached: ${why}`, problems: [`${label}: ${why}`] }, 400);
    };
    const totalMax = opts.mediaTotalMaxBytes ?? REVIEW_SUBMIT_MEDIA_MAX_BYTES;
    const overTotal = (bytes: number) => {
      const why = `the media total ${formatBytes(bytes)}, over the ${formatBytes(totalMax)} one submission may attach`;
      return c.json({ error: `The review packet's media can't be attached: ${why}`, problems: [why] }, 413);
    };
    // The distinct media of the owner's open (draft and pending) reviews, plus
    // this submission's new copies, stays under the owner's quota. Decided
    // and superseded reviews don't count, nor do the draft this submission
    // replaces and the launch's pending packet it supersedes.
    const quota = opts.mediaOwnerQuotaBytes ?? REVIEW_OWNER_MEDIA_QUOTA_BYTES;
    const replacing = findDraftReviewPacketForLaunch(db, worker.owner, worker.launch.id);
    const heldCopies = heldReviewMedia(db, worker.owner, { packetId: replacing?.id, launchId: worker.launch.id });
    let held = 0;
    for (const bytes of heldCopies.values()) held += bytes;
    const overQuota = (bytes: number) => {
      const why = `the media of the owner's open reviews would reach ${formatBytes(held + bytes)}, over the ${formatBytes(quota)} quota; deciding pending reviews frees their share`;
      return c.json({ error: `The review packet's media can't be stored: ${why}`, problems: [why], reason: "quota" }, 413);
    };

    // Every file's path and size are checked, and the total capped, before any byte is read.
    let total = 0;
    for (let i = 0; i < media.length; i++) {
      try {
        total += statMediaForReview(m(i).path, mediaOpts);
      } catch (err) {
        return mediaRefusal(i, err);
      }
      if (total > totalMax) return overTotal(total);
    }

    // Then each is checked by content and copied, one at a time, through its
    // digest into a staged temp file; nothing is in place until all pass.
    const staged: StagedReviewMedia[] = [];
    const discardAll = () => {
      for (const s of staged) discardStagedReviewMedia(s);
    };
    let stagedTotal = 0;
    for (let i = 0; i < media.length; i++) {
      try {
        const s = stageReviewMedia(m(i).path, mediaOpts);
        staged.push(s);
        stagedTotal += s.size;
      } catch (err) {
        discardAll();
        return mediaRefusal(i, err);
      }
      if (stagedTotal > totalMax) {
        discardAll();
        return overTotal(stagedTotal);
      }
    }
    // A copy the owner's open reviews already hold, or one this submission
    // attaches twice, is stored once and counts once.
    const added = new Map<string, number>();
    for (const s of staged) if (!heldCopies.has(s.sha256)) added.set(s.sha256, s.size);
    let addedBytes = 0;
    for (const bytes of added.values()) addedBytes += bytes;
    if (held + addedBytes > quota) {
      discardAll();
      return overQuota(addedBytes);
    }

    // The copies are put in place before the packet changes: when that fails
    // the packet is left as it was. A copy no row names (after a failure, or
    // one the submission replaced) is removed.
    const pruneUnreferenced = (copies: Array<{ sha256: string; mime: string }>) => {
      for (const copy of copies) {
        if (countReviewMediaRefs(db, copy.sha256) === 0) deleteStoredReviewMedia(opts.dataDir, copy.sha256, copy.mime);
      }
    };
    const committed: StagedReviewMedia[] = [];
    try {
      for (const s of staged) {
        commitStagedReviewMedia(opts.dataDir, s);
        committed.push(s);
      }
    } catch (err) {
      discardAll();
      pruneUnreferenced(committed);
      console.error("[review] storing a submission's media failed:", (err as Error).message);
      return c.json({ error: "The review packet's media could not be stored; the packet was not changed" }, 500);
    }

    const packetDraft = draftFields(body.packet as ReviewPacketDraft);
    const sessionId = worker.session?.id ?? worker.launch.sessionId;
    // The submitter is the session the request resolved to, never the launch's
    // session filled in for it: a cwd-only request records none.
    const submittedBySession = worker.session?.id ?? null;
    const submittedByRootSession = !!submittedBySession && submittedBySession === worker.launch.sessionId;
    // The copies named by the media rows of the pending packet this submission supersedes.
    const supersededMedia: Array<{ sha256: string; mime: string }> = [];
    const record = db.transaction(() => {
      const draft =
        replacing ??
        createReviewPacket(db, {
          owner: worker.owner,
          launchId: worker.launch.id,
          sessionId,
          jobId: worker.jobId,
          projectId: worker.projectId,
        });
      const submitted = submitReviewPacket(db, {
        id: draft.id,
        owner: draft.owner,
        draft: packetDraft,
        branch: refs?.branch ?? null,
        commitSha: refs?.headSha ?? null,
        baseSha: refs?.baseSha ?? null,
        submittedBySession,
        submittedByRootSession,
        removedMedia: supersededMedia,
      });
      if (!submitted) return null;
      const replaced = [
        ...supersededMedia,
        ...listReviewMedia(db, submitted.id, submitted.owner).map((r) => ({ sha256: r.sha256, mime: r.mime })),
      ];
      clearReviewMedia(db, submitted.id, submitted.owner);
      staged.forEach((s, i) =>
        addReviewMedia(db, {
          packetId: submitted.id,
          owner: submitted.owner,
          kind: s.kind,
          mime: s.mime,
          sha256: s.sha256,
          bytes: s.size,
          caption: m(i).caption.trim(),
          position: i,
        })
      );
      return { packet: submitted, replaced };
    });
    let recorded: ReturnType<typeof record>;
    try {
      recorded = record();
    } catch (err) {
      pruneUnreferenced(committed);
      throw err;
    }
    if (!recorded) {
      pruneUnreferenced(committed);
      return c.json({ error: "The review packet was already decided" }, 409);
    }
    const { packet } = recorded;
    pruneUnreferenced(recorded.replaced);
    // The token that made this submission is spent: a fresh one replaces it in
    // the launch's token file (which the worker's MCP server re-reads per
    // request) and on the launch row, so a copied token submits at most once.
    try {
      issueReviewToken(db, opts.dataDir, worker.launch.id);
    } catch (err) {
      console.error(`[review] rotating the review token of launch ${worker.launch.id} failed:`, (err as Error).message);
    }
    broadcastUpdate(packet);

    const url = `/review/${packet.id}`;
    opts.push?.(
      `Review ready: ${flattenWorkerText(packet.title, NOTIFY_TITLE_CHARS)}`,
      flattenWorkerText(packet.intent, NOTIFY_INTENT_CHARS),
      packet.owner
    );
    // The title is the worker's own words: quoted and labelled as such, never read as instructions.
    tellPersona(packet.owner, `Review ready: ${url} (worker-written title: ${quoteWorkerText(packet.title, NOTIFY_TITLE_CHARS)})`, {
      type: "review_ready",
      packetId: packet.id,
      title: flattenWorkerText(packet.title, NOTIFY_TITLE_CHARS),
      workerWritten: ["title"],
      revision: packet.revision,
      url,
      ...(packet.jobId ? { jobId: packet.jobId } : {}),
      ...(packet.sessionId ? { sessionId: packet.sessionId } : {}),
      ...(packet.projectId ? { projectId: packet.projectId } : {}),
    });
    return c.json({ packetId: packet.id, status: packet.status, revision: packet.revision, url });
  });

  // ── Decisions: the owner's, through the console ─────────────────────────

  const decide = async (c: Context, decision: ReviewDecision) => {
    const what = decision === "approved" ? "approve a review" : "request changes on a review";
    const refused = humanRefusal(c, what);
    if (refused) return refused;
    const actor = opts.identityOf(c);
    const id = c.req.param("id") ?? "";
    const existing = REVIEW_ID.test(id) ? getReviewPacket(db, id, actor) : null;
    if (!existing) return c.json({ error: "Unknown review" }, 404);
    const body = await c.req.json<{ comment?: unknown }>().catch(() => ({}) as { comment?: unknown });
    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") {
      return c.json({ error: "comment must be a string" }, 400);
    }
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (comment.length > REVIEW_COMMENT_MAX_CHARS) {
      return c.json({ error: `comment must be at most ${REVIEW_COMMENT_MAX_CHARS} characters` }, 400);
    }
    if (decision === "changes_requested" && !comment) {
      return c.json({ error: "Say what to change: a comment is required to request changes" }, 400);
    }
    // An approval that couldn't pass the run's human review — the checkout
    // moved past the packet — is refused before it is recorded, and the
    // worker is asked for a packet that shows the change as it stands.
    const stale =
      decision === "approved" && existing.status === "pending" && existing.launchId
        ? (port.approvalRefusal?.(existing.launchId, existing.id) ?? null)
        : null;
    if (stale) {
      const { sessionId } = workerOfPacket(existing);
      const body =
        `The owner tried to approve review "${existing.title}" (rev ${existing.revision}), but your checkout no longer ` +
        "stands where that packet showed it (new commits, or uncommitted edits to tracked files). Commit the edits " +
        "that belong to this change — never discard edits you didn't make — then resubmit the review packet with " +
        "submit_review_packet so it shows the change as it stands.";
      if (sessionId && !getPendingSteers(db, sessionId).some((s) => s.body === body)) steerWorker(sessionId, existing.owner, body);
      return c.json({ error: stale }, 409);
    }
    const result = decideReviewPacket(db, { id, owner: actor, decision, comment, actor });
    if (!result.ok) {
      return result.reason === "not_pending"
        ? c.json({ error: `This review is ${existing.status}, not pending` }, 409)
        : c.json({ error: "Unknown review" }, 404);
    }
    const packet = result.packet;
    const { sessionId } = workerOfPacket(packet);
    const url = `/review/${packet.id}`;
    try {
      opts.onDecided?.(packet);
    } catch (err) {
      console.error(`[review] after deciding ${packet.id}:`, err);
    }
    cancelQuestionSteers(packet, sessionId);

    if (decision === "changes_requested") {
      if (sessionId) {
        steerWorker(
          sessionId,
          packet.owner,
          `Owner requested changes on review "${packet.title}" (rev ${packet.revision}):\n${comment}\n\nAddress them, then return to the coding stage and resubmit the review packet.`
        );
      }
    }
    const job = ownerJobOf(packet);
    if (job) {
      const verdict = decision === "approved" ? "approved" : `changes requested: ${clip(comment, 300)}`;
      tellPersona(packet.owner, `Review ${verdict} — ${url} (worker-written title: ${quoteWorkerText(packet.title, NOTIFY_TITLE_CHARS)})`, {
        type: "review_decided",
        packetId: packet.id,
        title: flattenWorkerText(packet.title, NOTIFY_TITLE_CHARS),
        workerWritten: ["title"],
        revision: packet.revision,
        decision,
        url,
        jobId: job.id,
        ...(packet.launchId ? { launchId: packet.launchId } : {}),
        ...(comment ? { comment: clip(comment, 2000) } : {}),
        ...(packet.sessionId ? { sessionId: packet.sessionId } : {}),
      });
    }

    let pipeline: { ok: boolean; error?: string; runId?: string } | undefined;
    const run = packet.launchId ? port.runForLaunch(packet.launchId) : null;
    if (run) {
      try {
        const advanced = await port.advance(run.runId, { stage: HUMAN_REVIEW_STAGE_KIND, evidence: { packetId: packet.id, decision } });
        pipeline = { runId: run.runId, ok: advanced.ok, ...(advanced.error ? { error: advanced.error } : {}) };
      } catch (err) {
        pipeline = { runId: run.runId, ok: false, error: (err as Error).message };
      }
    }
    broadcastUpdate(packet);
    return c.json({ review: detail(packet, { alias: actor }), ...(pipeline ? { pipeline } : {}) });
  };

  app.post("/api/reviews/:id/approve", (c) => decide(c, "approved"));
  app.post("/api/reviews/:id/request-changes", (c) => decide(c, "changes_requested"));

  // ── Questions: the owner asks, the job's worker (or Persona) answers ─────
  // A question leaves the packet pending. It goes to the worker while it can
  // be reached, as a steer that starts its next turn; once the worker is gone
  // it goes to the owner's Persona instead, when the packet is its job's.

  /** A packet's comment, when it is a question (an opening one when `opening`). */
  const questionOf = (packetId: string, id: unknown, opening = false): ReviewComment | null => {
    const q = typeof id === "string" && REVIEW_ID.test(id) ? getReviewComment(db, packetId, id) : null;
    return q && q.kind === "question" && (!opening || q.replyTo === null) ? q : null;
  };

  /** The text of a question or answer, or the refusal. */
  const replyText = (c: Context, value: unknown, what: string): string | Response => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return c.json({ error: `${what} is required` }, 400);
    if (text.length > REVIEW_COMMENT_MAX_CHARS) return c.json({ error: `${what} must be at most ${REVIEW_COMMENT_MAX_CHARS} characters` }, 400);
    return text;
  };

  app.post("/api/reviews/:id/ask", async (c) => {
    const refused = humanRefusal(c, "ask a question on a review");
    if (refused) return refused;
    const actor = opts.identityOf(c);
    const id = c.req.param("id");
    const packet = REVIEW_ID.test(id) ? getReviewPacket(db, id, actor) : null;
    if (!packet) return c.json({ error: "Unknown review" }, 404);
    if (packet.status !== "pending") return c.json({ error: `This review is ${packet.status}, not pending` }, 409);
    const body = await c.req.json<{ question?: unknown; replyTo?: unknown }>().catch(() => ({}) as { question?: unknown; replyTo?: unknown });
    const text = replyText(c, body.question, "question");
    if (text instanceof Response) return text;
    const opening = body.replyTo === undefined || body.replyTo === null ? null : questionOf(packet.id, body.replyTo, true);
    if (body.replyTo !== undefined && body.replyTo !== null && !opening) return c.json({ error: "replyTo must be a question on this review" }, 400);

    const sessionId = reachableWorkerSession(packet);
    const job = ownerJobOf(packet);
    const via = sessionId ? "worker" : job && fleet?.get(packet.owner) ? "persona" : "none";
    const question = addReviewComment(db, { packetId: packet.id, author: actor, body: text, kind: "question", replyTo: opening?.id, via });
    const url = `/review/${packet.id}`;

    if (sessionId) {
      // The thread so far, so a follow-up reads in context.
      const thread = new Set(opening ? [opening.id] : []);
      const earlier: string[] = [];
      for (const r of listReviewComments(db, packet.id)) {
        if (r.id === question.id || r.kind === "comment" || !(thread.has(r.id) || (r.replyTo && thread.has(r.replyTo)))) continue;
        if (r.kind === "question") thread.add(r.id);
        earlier.push(`${r.kind === "answer" ? (r.via === "persona" ? "Persona" : "You") : "Owner"}: ${clip(r.body, 1000)}`);
      }
      steerWorker(
        sessionId,
        packet.owner,
        `${questionSteerHead(packet, question.id)}\n${text}\n\n` +
          (earlier.length > 0 ? `Earlier in this thread:\n${earlier.join("\n")}\n\n` : "") +
          "Reply only: answer it with answer_review_question (packet_id, question_id, answer). Do not change code, commit, push, " +
          "touch the code review or resubmit the review packet for it: the review stays pending for the owner's decision. If the answer " +
          "is that something should change, say so in the answer; the owner decides whether to request changes."
      );
      try {
        await opts.startQueuedIfIdle?.(sessionId);
      } catch (err) {
        console.error(`[review] starting ${sessionId.slice(0, 8)}'s turn for a question failed:`, err);
      }
    } else if (via === "persona" && job) {
      tellPersona(
        packet.owner,
        `Review question — ${url}: the owner asked "${clip(text, 300)}"; its worker has ended or takes no questions, so answer it with answer_review_question (worker-written title: ${quoteWorkerText(packet.title, NOTIFY_TITLE_CHARS)})`,
        {
          type: "review_question",
          packetId: packet.id,
          questionId: question.id,
          title: flattenWorkerText(packet.title, NOTIFY_TITLE_CHARS),
          workerWritten: ["title"],
          revision: packet.revision,
          question: clip(text, 2000),
          url,
          jobId: job.id,
          ...(packet.launchId ? { launchId: packet.launchId } : {}),
          ...(packet.sessionId ? { sessionId: packet.sessionId } : {}),
        }
      );
    }
    broadcastUpdate(packet);
    return c.json({ review: detail(packet, { alias: actor }), question });
  });

  // The answer to a question: from the packet's own worker (its launch's
  // review token and session) or from the owner's Persona.
  app.post("/api/reviews/:id/answer", async (c) => {
    const forged = isCrossSiteWrite(c);
    if (forged) return c.json({ error: `refused: ${forged}` }, 403);
    const id = c.req.param("id");
    const body = await c.req
      .json<{ session_id?: unknown; cwd?: unknown; question_id?: unknown; answer?: unknown }>()
      .catch(() => ({}) as { session_id?: unknown; cwd?: unknown; question_id?: unknown; answer?: unknown });
    // Persona answers any of its owner's packets; a worker only its own launch's.
    let from: { owner: string; author: string; via: "worker" | "persona"; launchId?: string };
    if (hasPersonaCredential(c)) {
      const caller = callerOf(c);
      if (caller instanceof Response) return caller;
      from = { owner: caller.alias, author: "persona", via: "persona" };
    } else {
      const tokenLaunch = launchForWorkerToken(db, c.req.header(WORKER_TOKEN_HEADER));
      if (!tokenLaunch) return workerTokenRefusal(c);
      const worker = workerOf(c, tokenLaunch, { sessionId: body.session_id, cwd: body.cwd });
      if (worker instanceof Response) return worker;
      const author = worker.session?.id ?? worker.launch.sessionId ?? "worker";
      from = { owner: worker.owner, author, via: "worker", launchId: worker.launch.id };
    }
    // The question is found by its id: a resubmission since it was asked has
    // carried it to the launch's new revision, which `id` may predate.
    const found = REVIEW_ID.test(id) && typeof body.question_id === "string" && REVIEW_ID.test(body.question_id) ? findReviewComment(db, body.question_id) : null;
    const packet = found ? getReviewPacket(db, found.packetId, from.owner) : null;
    const asked = packet && getReviewPacket(db, id, from.owner);
    if (!packet || !asked || packet.launchId !== asked.launchId || (from.launchId && packet.launchId !== from.launchId)) {
      return c.json({ error: "Unknown review or question" }, 404);
    }
    const question = questionOf(packet.id, body.question_id);
    if (!question) return c.json({ error: "question_id must be a question on this review" }, 400);
    if (listReviewComments(db, packet.id).some((r) => r.kind === "answer" && r.replyTo === question.id)) {
      return c.json({ error: "That question is already answered" }, 409);
    }
    const text = replyText(c, body.answer, "answer");
    if (text instanceof Response) return text;
    const answer = addReviewComment(db, { packetId: packet.id, author: from.author, body: text, kind: "answer", replyTo: question.id, via: from.via });
    broadcastUpdate(packet);
    opts.push?.(
      `Answer on review: ${flattenWorkerText(packet.title, NOTIFY_TITLE_CHARS)}`,
      flattenWorkerText(text, NOTIFY_INTENT_CHARS),
      packet.owner
    );
    return c.json({ ok: true, answerId: answer.id, url: `/review/${packet.id}` });
  });
}
