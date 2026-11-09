/**
 * The gateway: a stateless proxy that owns Standup's public ports so a
 * collector (or vite) restart never surfaces as a refused connection.
 *
 * - `web` forwards to vite, `collector` to the leader's HTTP port and `ws` to
 *   the leader's WebSocket port. Every listener proxies both plain HTTP and
 *   WebSocket upgrades to its upstream.
 * - A request that never reached an upstream (connection refused, or a
 *   collector's `refused` 503 while it drains) is held and retried every
 *   100ms for up to `holdMs`. Anything an upstream may have started
 *   processing is passed through or failed, never retried.
 * - Holding only makes sense while a restart is plausibly in progress: once
 *   no collector leader has validated for `holdMs` (or since start), collector
 *   and ws requests are answered 503 at once instead of each waiting `holdMs`.
 * - `GATEWAY_STATS_PATH` on the collector and ws listeners serves the
 *   cumulative counters the restart supervisor diffs; it is answered here and
 *   never proxied. The web listener (which a tunnel or proxy may expose) proxies the
 *   path to vite like any other.
 * - Listeners never set SO_REUSEPORT: with it, any process of the same user
 *   could bind the public ports alongside the gateway and receive a share of
 *   the connections, cookies and tokens included. A port clash therefore
 *   always surfaces as EADDRINUSE.
 * - Each public port is bound on 127.0.0.1 and, where the host has an IPv6
 *   loopback, on [::1] too, both routed the same way. URLs advertise
 *   `localhost`, which many clients resolve to ::1 first; left unbound, [::1]
 *   on a public port could be taken by any other process (a worker's dev
 *   server) and receive those clients' traffic. A bind failing part way stops
 *   every listener it already opened.
 * - Every proxied WebSocket's client leg is pinged, and one that sends
 *   nothing for `wsClientIdleMs` is terminated along with its upstream, so a
 *   peer that vanished without closing (a tunnel's far end) never pins an
 *   upstream socket.
 */
import type { Server, ServerWebSocket } from "bun";
import {
  DRAINING_HEADER,
  DRAINING_REFUSED,
  GATEWAY_HOST,
  GATEWAY_HOST_IPV6,
  GATEWAY_REASON,
  GATEWAY_REASON_HEADER,
  GATEWAY_STATS_PATH,
  WS_CLOSE_SERVICE_RESTART,
  readJsonFile,
  type GatewayReason,
  type GatewayStats,
  type LeaderInfo,
  type PublicPorts,
} from "@standup/shared/topology";
import { PERSONA_UPLOAD_BODY_MAX_BYTES, PERSONA_UPLOADS_PATH } from "@standup/shared/persona";
import { DEFAULT_HOLD_MS, DEFAULT_MAX_HELD } from "./config.js";
import { LeaderResolver } from "./leader.js";

export type ListenerKind = "web" | "collector" | "ws";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BUFFERED_BYTES = 256 * 1024 * 1024;

/**
 * The per-request body cap for `req`: the owner's media upload carries a
 * base64 video larger than any other request, so it alone gets the upload
 * route's own cap when that is the larger one.
 */
export function bodyCapFor(req: Request, defaultCap: number): number {
  if (req.method !== "POST" || new URL(req.url).pathname !== PERSONA_UPLOADS_PATH) return defaultCap;
  return Math.max(defaultCap, PERSONA_UPLOAD_BODY_MAX_BYTES);
}
export const RETRY_INTERVAL_MS = 100;
export const DEFAULT_DRAIN_MS = 10_000;
/** Seconds a client is told to wait after a back-pressure or hold-timeout 503. */
export const RETRY_AFTER_SECONDS = 2;
/** How often every proxied client leg is sent a WebSocket ping. */
export const DEFAULT_WS_CLIENT_PING_MS = 15_000;
/**
 * How long a proxied client leg may go without sending anything (a pong, a
 * frame) before it counts as dead. Browsers answer pings themselves, but the
 * limit also outlasts the console's own text ping in a background tab whose
 * timers are throttled to one a minute, in case a proxy in front does not
 * forward control frames.
 */
export const DEFAULT_WS_CLIENT_IDLE_MS = 90_000;

export interface GatewayOptions {
  /** Ports to bind; 0 picks an ephemeral port (tests). */
  ports: PublicPorts;
  /** The web listener's upstream (vite). */
  vitePort: number;
  /** Bind and upstream host. Default GATEWAY_HOST. */
  hostname?: string;
  /**
   * Also bind GATEWAY_HOST_IPV6 on each public port, routed exactly like
   * `hostname`. Skipped (logged once) on a host without an IPv6 loopback.
   * Default: on when `hostname` is GATEWAY_HOST.
   */
  ipv6Loopback?: boolean;
  /** The data dir whose leader this gateway routes to; reported in stats. */
  dataDir?: string;
  /** Path of collector-leader.json. Ignored when `leaderSource` is given. */
  leaderFile?: string;
  /** Where the current leader record comes from; defaults to reading `leaderFile`. */
  leaderSource?: () => LeaderInfo | undefined;
  holdMs?: number;
  maxHeld?: number;
  retryIntervalMs?: number;
  healthTimeoutMs?: number;
  /** How long an upstream WebSocket may take to open before the attempt counts as failed. */
  wsOpenTimeoutMs?: number;
  /** How often proxied client legs are pinged. Default DEFAULT_WS_CLIENT_PING_MS. */
  wsClientPingMs?: number;
  /**
   * A proxied client leg that has sent nothing for this long is terminated and
   * its upstream closed. Default DEFAULT_WS_CLIENT_IDLE_MS.
   */
  wsClientIdleMs?: number;
  /** In-flight grace on stop(). */
  drainMs?: number;
  maxBodyBytes?: number;
  maxTotalBufferedBytes?: number;
  /** With `onIdle`: called once after this long without a validated collector leader. */
  idleExitMs?: number;
  onIdle?: () => void;
  /** How often the idle monitor re-checks the leader. Default min(5s, idleExitMs / 4). */
  idleCheckMs?: number;
  version?: string;
  startedAt?: string;
  log?: (message: string) => void;
}

export interface Gateway {
  /** The ports actually bound. */
  readonly ports: PublicPorts;
  stats(): GatewayStats;
  /** When a collector leader last validated, or when this gateway was created if none has; epoch ms. */
  lastLeaderValidAt(): number;
  /** A fresh /health check of the recorded leader; true when it validated just now. */
  checkLeader(): Promise<boolean>;
  /**
   * Stops listening at once (the ports are free for a successor as soon as
   * this is called), closes proxied WebSockets with 1012, lets in-flight
   * requests finish for up to `drainMs`, then force-closes what remains.
   */
  stop(opts?: { drainMs?: number }): Promise<void>;
}

/** Hop-by-hop headers: they describe one connection and are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Handshake headers the gateway's own WebSocket client generates for the upstream leg. */
const WS_HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "sec-websocket-protocol",
]);

/** `headers` without hop-by-hop fields (including those the Connection header names) or `extra`. */
export function stripHeaders(headers: Headers, extra: ReadonlySet<string> = new Set()): Headers {
  const out = new Headers(headers);
  const named = (headers.get("connection") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...named, ...extra]) out.delete(name);
  return out;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** A close code the WebSocket API lets an endpoint send (1005/1006/1015 are reserved). */
function sendableCloseCode(code: number): boolean {
  return code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** The slice of a client leg relayToClient drives. */
export interface ClientLeg {
  send(data: string | ArrayBuffer, compress?: boolean): number;
  close(code?: number, reason?: string): void;
}

/**
 * Sends an upstream frame on the client leg; false when it didn't go. Bun
 * answers a frame it dropped (the client's buffer past its backpressure limit,
 * a tunnel that stalled) with 0, which a successful empty frame also gets. A
 * dropped frame closes the client with 1011: the console's Persona frames
 * carry no seq, so one lost on a socket that stays open is never noticed and
 * the view stays stale, while the reconnect resyncs it. `compress` asks Bun to
 * deflate the frame, which it does only when the leg negotiated
 * permessage-deflate (and never without the flag, even then); the return
 * value is still the uncompressed length.
 */
export function relayToClient(client: ClientLeg, data: string | ArrayBuffer, compress = false): boolean {
  const size = typeof data === "string" ? data.length : data.byteLength;
  if (client.send(data, compress) !== 0 || size === 0) return true;
  client.close(1011, "frame dropped");
  return false;
}

/** Close reasons are capped at 123 UTF-8 bytes. */
function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.byteLength <= 123) return reason;
  return new TextDecoder().decode(bytes.slice(0, 120)).replace(/�$/, "");
}

/**
 * Whether a fetch failure proves the request never reached the upstream.
 * Bun reports a refused connect as `code: "ConnectionRefused"`. Every other
 * transport failure — including a peer that accepted and closed before
 * reading — surfaces as `ECONNRESET`, indistinguishable from a reset after
 * the request was delivered, so none of those count as safe.
 */
export function isConnectionRefused(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ConnectionRefused";
}

/**
 * Whether a web-listener request whose upstream failed before any response
 * headers may be sent again. vite restarting destroys its open sockets; a
 * GET or HEAD carries no body and is idempotent, so resending it is safe.
 * fetch only throws before the response starts, so nothing has reached the
 * client yet; a break mid-body is never retried.
 */
export function retriesAfterReset(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Bun's fetch accepts `timeout: false` to lift its default socket timeout (long-polls wait up to an hour). */
type ProxyFetchInit = BunFetchRequestInit & { timeout?: boolean };

interface Target {
  port: number;
  /** The upstream misbehaved: re-validate before routing there again. */
  fail(): void;
  /** Whether this upstream is still the one to route to, checked afresh. */
  stillCurrent(): Promise<boolean>;
}

type Attempt<T> = { retry: true } | { retry: false; value: T };
type HoldFailure = "timeout" | "cap" | "aborted" | "no-leader";
type HoldOutcome<T> = { value: T } | { failure: HoldFailure };

/** One proxied WebSocket: the upstream leg, and the client leg once upgraded. */
interface WsLink {
  upstream: WebSocket;
  client?: ServerWebSocket<WsLink>;
  /** Upstream frames that arrived before the client leg opened. */
  pending: Array<string | ArrayBuffer>;
  /** Set when the upstream closed before the client leg opened. */
  upstreamClosed?: { code: number; reason: string };
  clientClosed: boolean;
  /** When the client leg last sent anything (a frame or a pong), or opened; epoch ms. */
  lastHeardAt: number;
  /** Whether frames to the client leg are sent compressed (the web listener's). */
  compress?: boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Whether a bind failed because the host has no such address (no IPv6
 * loopback configured, or no IPv6 at all), as opposed to the port being taken.
 */
export function isAddrUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "EADDRNOTAVAIL" || e?.code === "EAFNOSUPPORT") return true;
  return typeof e?.message === "string" && /EADDRNOTAVAIL|EAFNOSUPPORT|address not available|cannot assign requested address|address family not supported/i.test(e.message);
}

let ipv6LoopbackMissingLogged = false;

function noteNoIpv6Loopback(log: (message: string) => void, err: unknown): void {
  if (ipv6LoopbackMissingLogged) return;
  ipv6LoopbackMissingLogged = true;
  log(`no IPv6 loopback on this host (${String(err)}); serving the public ports on ${GATEWAY_HOST} only`);
}

/**
 * Whether [::1] can be bound at all, asked with an ephemeral port that can't
 * be taken: Bun may report any failed listen as EADDRINUSE, so a failure on a
 * public port alone can't tell a missing IPv6 loopback from a port in use.
 * Asked again on each bind, since a failure here may have been transient (out
 * of file descriptors); logged once per process.
 */
function ipv6LoopbackUsable(log: (message: string) => void): boolean {
  try {
    const probe = Bun.serve({ hostname: GATEWAY_HOST_IPV6, port: 0, reusePort: false, fetch: () => new Response(null) });
    probe.stop(true);
    return true;
  } catch (err) {
    noteNoIpv6Loopback(log, err);
    return false;
  }
}

function textResponse(status: number, body: string, reason: GatewayReason, retryAfter = false): Response {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", [GATEWAY_REASON_HEADER]: reason };
  if (retryAfter) headers["retry-after"] = String(RETRY_AFTER_SECONDS);
  return new Response(body + "\n", { status, headers });
}

export function createGateway(opts: GatewayOptions): Gateway {
  const host = opts.hostname ?? GATEWAY_HOST;
  const createdAt = Date.now();
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
  const maxHeld = opts.maxHeld ?? DEFAULT_MAX_HELD;
  const retryIntervalMs = opts.retryIntervalMs ?? RETRY_INTERVAL_MS;
  const wsOpenTimeoutMs = opts.wsOpenTimeoutMs ?? 10_000;
  const wsClientPingMs = opts.wsClientPingMs ?? DEFAULT_WS_CLIENT_PING_MS;
  const wsClientIdleMs = opts.wsClientIdleMs ?? DEFAULT_WS_CLIENT_IDLE_MS;
  const defaultMaxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxTotalBuffered = opts.maxTotalBufferedBytes ?? MAX_TOTAL_BUFFERED_BYTES;
  const log = opts.log ?? (() => {});
  const leaderFile = opts.leaderFile;
  const source = opts.leaderSource ?? (() => (leaderFile ? readJsonFile<LeaderInfo>(leaderFile) : undefined));
  const resolver = new LeaderResolver({ source, host, healthTimeoutMs: opts.healthTimeoutMs });

  const counters = { held: 0, heldNow: 0, maxHoldMs: 0, failed: 0, retried: 0, wsUpstreamCloses: 0, wsClientIdleCloses: 0 };
  let bufferedBytes = 0;
  const links = new Set<WsLink>();
  /** Aborted on stop(): ends holds, pending upstream opens and upstream fetches. */
  const shutdown = new AbortController();
  let stopping: Promise<void> | undefined;
  const startedAt = opts.startedAt ?? new Date().toISOString();
  const version = opts.version ?? "dev";

  async function resolveTarget(kind: ListenerKind): Promise<Target | undefined> {
    if (kind === "web") {
      return { port: opts.vitePort, fail() {}, stillCurrent: async () => true };
    }
    const validated = await resolver.resolve();
    if (!validated) return undefined;
    return {
      port: kind === "ws" ? validated.leader.wsPort : validated.leader.httpPort,
      fail: () => resolver.invalidate(validated),
      async stillCurrent() {
        resolver.invalidate(validated);
        return (await resolver.resolve())?.key === validated.key;
      },
    };
  }

  /**
   * When collector traffic stops being held: `holdMs` after a leader last
   * validated (or after this gateway started). Past it no restart is
   * plausibly in progress (the unit was stopped, or every slot is
   * crash-looping), so callers get a prompt 503 rather than a `holdMs` stall.
   */
  function leaderWindowEnd(): number {
    return Math.max(resolver.lastValidAt, createdAt) + holdMs;
  }

  /**
   * Runs `attempt` against the listener's upstream, holding while there is
   * none or an attempt asks to retry. A request counts as held only while it
   * waits, never while an attempt is outstanding, so a routed long-poll
   * doesn't occupy a held slot. The held cap is applied once, when a request
   * first has to wait: a request already admitted is never turned away by it.
   */
  async function withUpstream<T>(
    kind: ListenerKind,
    signal: AbortSignal,
    attempt: (target: Target) => Promise<Attempt<T>>
  ): Promise<HoldOutcome<T>> {
    const start = Date.now();
    const needsLeader = kind !== "web";
    let everHeld = false;
    let holding = false;
    const leave = () => {
      if (!holding) return;
      holding = false;
      counters.heldNow--;
    };
    const finish = (end: number) => {
      if (everHeld) counters.maxHoldMs = Math.max(counters.maxHoldMs, end - start);
    };
    try {
      for (;;) {
        if (signal.aborted) {
          finish(Date.now());
          return { failure: "aborted" };
        }
        const target = await resolveTarget(kind);
        if (target && !signal.aborted) {
          const attemptStart = Date.now();
          leave();
          const result = await attempt(target);
          if (!result.retry) {
            finish(attemptStart);
            return { value: result.value };
          }
          counters.retried++;
        }
        if (signal.aborted) {
          finish(Date.now());
          return { failure: "aborted" };
        }
        const now = Date.now();
        const waited = now - start;
        if (waited >= holdMs) {
          finish(now);
          return { failure: "timeout" };
        }
        const windowLeft = needsLeader ? leaderWindowEnd() - now : Infinity;
        if (windowLeft <= 0) {
          finish(now);
          return { failure: "no-leader" };
        }
        if (!holding) {
          if (!everHeld && counters.heldNow >= maxHeld) {
            finish(now);
            return { failure: "cap" };
          }
          holding = true;
          counters.heldNow++;
          if (!everHeld) {
            everHeld = true;
            counters.held++;
          }
        }
        await sleep(Math.min(retryIntervalMs, holdMs - waited, windowLeft), signal);
      }
    } finally {
      leave();
    }
  }

  function holdFailure(failure: HoldFailure): Response {
    // A client that hung up mid-hold is not a request the gateway failed.
    if (failure !== "aborted" || shutdown.signal.aborted) counters.failed++;
    if (failure === "cap") return textResponse(503, "gateway busy", GATEWAY_REASON.heldCap, true);
    if (failure === "aborted") return textResponse(503, "gateway shutting down", GATEWAY_REASON.aborted, true);
    if (failure === "no-leader") return textResponse(503, "no collector leader", GATEWAY_REASON.noLeader, true);
    return textResponse(503, "no upstream available", GATEWAY_REASON.holdTimeout, true);
  }

  type Buffered = { bytes: Uint8Array | undefined; reserved: number };

  /** Reads the request body into memory under the per-request and total caps. */
  async function bufferBody(req: Request): Promise<Buffered | Response> {
    if (req.method === "GET" || req.method === "HEAD" || !req.body) return { bytes: undefined, reserved: 0 };
    const maxBodyBytes = bodyCapFor(req, defaultMaxBodyBytes);
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      counters.failed++;
      return textResponse(413, "request body too large", GATEWAY_REASON.bodyCap);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = req.body.getReader();
    const refuse = (res: Response, gatewayFailed = true) => {
      bufferedBytes -= size;
      if (gatewayFailed) counters.failed++;
      void reader.cancel().catch(() => {});
      return res;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBodyBytes) return refuse(textResponse(413, "request body too large", GATEWAY_REASON.bodyCap));
        if (bufferedBytes + value.byteLength > maxTotalBuffered) {
          return refuse(textResponse(503, "gateway busy", GATEWAY_REASON.bufferCap, true));
        }
        bufferedBytes += value.byteLength;
        size += value.byteLength;
        chunks.push(value);
      }
    } catch {
      // The body stream only errors when the client's side of the
      // connection does (it hung up or sent a malformed body).
      return refuse(textResponse(400, "request body aborted", GATEWAY_REASON.bodyAborted), false);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, reserved: size };
  }

  /**
   * Streams `body` through, counting a failure if the upstream breaks
   * mid-response. Pull-based, so each chunk is forwarded as it arrives.
   */
  function relayBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (err) {
            counters.failed++;
            controller.error(err);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 }
    );
  }

  async function proxyHttp(kind: ListenerKind, req: Request): Promise<Response> {
    const body = await bufferBody(req);
    if (body instanceof Response) return body;
    try {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      // The body is already buffered: fetch sets its length, and there is
      // nothing left to wait on a 100-continue for.
      const headers = stripHeaders(req.headers, new Set(["content-length", "expect"]));
      // Bun's fetch otherwise advertises gzip/br/zstd on the client's behalf,
      // and with decompression off the client would get an encoding it never asked for.
      if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
      const signal = AbortSignal.any([req.signal, shutdown.signal]);
      const outcome = await withUpstream<Response>(kind, signal, async (target) => {
        let res: Response;
        try {
          const init: ProxyFetchInit = {
            method: req.method,
            headers,
            body: body.bytes,
            redirect: "manual",
            decompress: false,
            // A fresh connection per request: a pooled socket the upstream
            // closed would fail as ECONNRESET, which is not safe to retry in general.
            keepalive: false,
            timeout: false,
            signal,
          };
          res = await fetch(`http://${host}:${target.port}${path}`, init);
        } catch (err) {
          if (isConnectionRefused(err)) {
            // Re-validate before the next try, so a leader that died stops
            // counting as valid and the no-leader window can run out.
            target.fail();
            return { retry: true };
          }
          if (signal.aborted) return { retry: false, value: textResponse(503, "request aborted", GATEWAY_REASON.aborted, true) };
          target.fail();
          if (kind === "web" && retriesAfterReset(req.method)) return { retry: true };
          counters.failed++;
          log(`${kind} ${req.method} ${url.pathname}: upstream :${target.port} failed after send: ${String(err)}`);
          return { retry: false, value: textResponse(502, "upstream connection failed", GATEWAY_REASON.upstreamReset) };
        }
        if (res.status === 503 && res.headers.get(DRAINING_HEADER) === DRAINING_REFUSED) {
          await res.body?.cancel().catch(() => {});
          target.fail();
          return { retry: true };
        }
        return {
          retry: false,
          value: new Response(res.body ? relayBody(res.body) : null, {
            status: res.status,
            statusText: res.statusText,
            headers: stripHeaders(res.headers),
          }),
        };
      });
      return "value" in outcome ? outcome.value : holdFailure(outcome.failure);
    } finally {
      bufferedBytes -= body.reserved;
    }
  }

  type OpenResult = { link: WsLink } | { retry: true } | { rejected: true };

  /** Opens the upstream leg; resolves once it is open or has failed. */
  function openUpstream(url: string, headers: Headers, protocols: string[], signal: AbortSignal): Promise<OpenResult> {
    return new Promise((resolve) => {
      const upstream = new WebSocket(url, { headers: Object.fromEntries(headers), protocols });
      upstream.binaryType = "arraybuffer";
      let settled = false;
      const settle = (result: OpenResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        upstream.close();
        settle({ retry: true });
      };
      const timer = setTimeout(() => {
        upstream.close();
        settle({ retry: true });
      }, wsOpenTimeoutMs);
      signal.addEventListener("abort", onAbort);
      upstream.addEventListener("open", () => {
        const link: WsLink = { upstream, pending: [], clientClosed: false, lastHeardAt: Date.now() };
        upstream.addEventListener("message", (event) => {
          const data = event.data as string | ArrayBuffer;
          // A client leg closed for a dropped frame takes nothing more.
          if (link.client) {
            if (!link.clientClosed && !relayToClient(link.client, data, link.compress)) link.clientClosed = true;
          } else link.pending.push(data);
        });
        upstream.addEventListener("close", (event) => onUpstreamClose(link, event.code, event.reason));
        settle({ link });
      });
      upstream.addEventListener("close", (event) => {
        // 1006 is a failed connect; anything else before open is the
        // upstream answering the handshake with a non-101 status.
        settle(event.code === 1006 ? { retry: true } : { rejected: true });
      });
    });
  }

  function onUpstreamClose(link: WsLink, code: number, reason: string): void {
    links.delete(link);
    if (link.clientClosed) return;
    if (!stopping) counters.wsUpstreamCloses++;
    // An abnormal upstream loss (1006) tells the client to reconnect promptly.
    const forwarded = sendableCloseCode(code) ? code : code === 1005 ? 1000 : WS_CLOSE_SERVICE_RESTART;
    if (link.client) link.client.close(forwarded, closeReason(reason));
    else link.upstreamClosed = { code: forwarded, reason: closeReason(reason) };
  }

  /**
   * Pings every open client leg, and tears down one that has sent nothing
   * for `wsClientIdleMs` along with its upstream. Outbound frames never prove
   * a client leg alive: a tunnel whose far end is gone can keep accepting
   * and discarding them, so Bun sees no backpressure and no close, and its
   * own idle timeout restarts on every send. Without this, each such leg
   * pins an upstream socket (and, behind it, a collector client) forever.
   * The leg is terminated rather than closed, since a dead peer never
   * completes a close handshake.
   */
  function sweepClientLegs(): void {
    const now = Date.now();
    let dead = 0;
    for (const link of [...links]) {
      const client = link.client;
      if (!client || link.clientClosed) continue;
      if (now - link.lastHeardAt < wsClientIdleMs) {
        client.ping();
        continue;
      }
      dead++;
      counters.wsClientIdleCloses++;
      link.clientClosed = true;
      links.delete(link);
      // Upstream first: terminate runs the close handler at once, which
      // would otherwise close the upstream with the abnormal-close code.
      link.upstream.close(1001, "client unresponsive");
      client.terminate();
    }
    if (dead > 0) log(`closed ${dead} WebSocket client leg(s) silent for ${Math.round(wsClientIdleMs / 1000)}s`);
  }

  async function proxyUpgrade(kind: ListenerKind, req: Request, server: Server<WsLink>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    const headers = stripHeaders(req.headers, WS_HANDSHAKE);
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const signal = AbortSignal.any([req.signal, shutdown.signal]);
    const outcome = await withUpstream<WsLink | Response>(kind, signal, async (target) => {
      const result = await openUpstream(`ws://${host}:${target.port}${path}`, headers, protocols, signal);
      if ("link" in result) return { retry: false, value: result.link };
      if ("rejected" in result && !(await target.stillCurrent())) return { retry: true };
      if ("rejected" in result) {
        counters.failed++;
        return { retry: false, value: textResponse(502, "upstream rejected the WebSocket handshake", GATEWAY_REASON.wsRejected) };
      }
      // A WebSocket handshake carries no application effect, so any failure
      // before the upstream opened is safe to retry.
      target.fail();
      return { retry: true };
    });
    if (!("value" in outcome)) return holdFailure(outcome.failure);
    if (outcome.value instanceof Response) return outcome.value;
    const link = outcome.value;
    if (stopping || req.signal.aborted) {
      link.clientClosed = true;
      link.upstream.close(1001);
      if (stopping) counters.failed++;
      return textResponse(503, "gateway shutting down", GATEWAY_REASON.aborted, true);
    }
    // An upstream that already closed has left `links`; the client is still
    // upgraded and websocket.open replays that close to it.
    if (!link.upstreamClosed) links.add(link);
    const protocol = link.upstream.protocol;
    const upgraded = server.upgrade(req, {
      data: link,
      headers: protocol ? { "sec-websocket-protocol": protocol } : undefined,
    });
    if (upgraded) return undefined;
    links.delete(link);
    link.clientClosed = true;
    link.upstream.close(1011);
    counters.failed++;
    return textResponse(400, "WebSocket upgrade failed", GATEWAY_REASON.upgradeFailed);
  }

  function stats(): GatewayStats {
    const leader = resolver.current()?.leader;
    return {
      pid: process.pid,
      version,
      startedAt,
      dataDir: opts.dataDir,
      held: counters.held,
      heldNow: counters.heldNow,
      maxHoldMs: counters.maxHoldMs,
      failed: counters.failed,
      retried: counters.retried,
      wsUpstreamCloses: counters.wsUpstreamCloses,
      wsClientIdleCloses: counters.wsClientIdleCloses,
      upstream: { collector: leader?.httpPort, ws: leader?.wsPort, web: opts.vitePort },
    };
  }

  function listen(kind: ListenerKind, port: number, hostname: string): Server<WsLink> {
    return Bun.serve<WsLink>({
      hostname,
      port,
      // See the module comment: never shared with another socket.
      reusePort: false,
      // Long-polls hold a request open for up to an hour.
      idleTimeout: 0,
      async fetch(req, server) {
        // The web listener is the one a tunnel forwards, so only the collector
        // and ws listeners answer the stats path.
        if (kind !== "web" && new URL(req.url).pathname === GATEWAY_STATS_PATH) {
          if (!isLoopbackAddress(server.requestIP(req)?.address)) return textResponse(403, "forbidden", GATEWAY_REASON.statsForbidden);
          return Response.json(stats(), { headers: { "cache-control": "no-store" } });
        }
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return proxyUpgrade(kind, req, server);
        return proxyHttp(kind, req);
      },
      websocket: {
        // Bun's defaults, stated: a client answering no protocol ping for 120s
        // is closed, and frames past 16 MB of backlog are dropped (relayToClient
        // then closes the leg with 1011). A leg that sends nothing for
        // wsClientIdleMs is torn down by sweepClientLegs. A client that answers
        // pings but has gone (the tunnel's leg of a closed browser socket) is
        // closed by the collector's silent-client check, and that close is
        // relayed here.
        idleTimeout: 120,
        sendPings: true,
        backpressureLimit: 16 * 1024 * 1024,
        closeOnBackpressureLimit: false,
        // The web listener's clients are browsers, mostly through the tunnel:
        // compressed, the multi-megabyte hello-ok snapshot of every reconnect
        // crosses it many times faster. Bun compresses only a send that asks
        // (link.compress). The other legs are loopback.
        perMessageDeflate: kind === "web",
        open(ws) {
          const link = ws.data;
          link.compress = kind === "web";
          link.client = ws;
          link.lastHeardAt = Date.now();
          for (const data of link.pending) {
            if (relayToClient(ws, data, link.compress)) continue;
            link.clientClosed = true;
            break;
          }
          link.pending = [];
          if (link.upstreamClosed) ws.close(link.upstreamClosed.code, link.upstreamClosed.reason);
        },
        message(ws, message) {
          ws.data.lastHeardAt = Date.now();
          const upstream = ws.data.upstream;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
        },
        pong(ws) {
          ws.data.lastHeardAt = Date.now();
        },
        close(ws, code, reason) {
          const link = ws.data;
          link.clientClosed = true;
          links.delete(link);
          const upstream = link.upstream;
          if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
            upstream.close(sendableCloseCode(code) ? code : 1000, closeReason(reason));
          }
        },
      },
      error(err) {
        log(`${kind} listener (${hostname}) error: ${err.stack ?? String(err)}`);
        counters.failed++;
        return textResponse(502, "gateway error", GATEWAY_REASON.internal);
      },
    });
  }

  // Every server is recorded the moment it binds, so a bind that fails part
  // way releases the ports already taken: a retry would otherwise keep
  // failing against this gateway's own sockets.
  const servers: Server<WsLink>[] = [];
  const ports: PublicPorts = { web: 0, collector: 0, ws: 0 };
  try {
    let ipv6 = (opts.ipv6Loopback ?? host === GATEWAY_HOST) && ipv6LoopbackUsable(log);
    for (const kind of ["web", "collector", "ws"] as const) {
      const server = listen(kind, opts.ports[kind], host);
      servers.push(server);
      ports[kind] = server.port ?? 0;
      if (!ipv6) continue;
      try {
        servers.push(listen(kind, ports[kind], GATEWAY_HOST_IPV6));
      } catch (err) {
        if (!isAddrUnavailable(err)) throw err;
        ipv6 = false;
        noteNoIpv6Loopback(log, err);
      }
    }
  } catch (err) {
    for (const server of servers) server.stop(true);
    throw err;
  }

  const liveness = setInterval(sweepClientLegs, wsClientPingMs);
  liveness.unref?.();

  let monitor: ReturnType<typeof setInterval> | undefined;
  if (opts.onIdle && opts.idleExitMs) {
    const idleExitMs = opts.idleExitMs;
    const onIdle = opts.onIdle;
    const sinceStart = Date.now();
    let checking = false;
    let fired = false;
    monitor = setInterval(async () => {
      if (checking || fired) return;
      checking = true;
      try {
        await resolver.check();
      } finally {
        checking = false;
      }
      const lastValid = Math.max(resolver.lastValidAt, sinceStart);
      if (!fired && !stopping && Date.now() - lastValid >= idleExitMs) {
        fired = true;
        onIdle();
      }
    }, opts.idleCheckMs ?? Math.max(10, Math.min(5000, Math.floor(idleExitMs / 4))));
  }

  async function stop(stopOpts: { drainMs?: number } = {}): Promise<void> {
    if (stopping) return stopping;
    const drainMs = stopOpts.drainMs ?? opts.drainMs ?? DEFAULT_DRAIN_MS;
    stopping = (async () => {
      clearInterval(liveness);
      if (monitor) clearInterval(monitor);
      // First, so the listening sockets close before anything else runs: a
      // successor gateway binding the ports retries until they do.
      const graceful = Promise.all(servers.map((server) => server.stop(false)));
      for (const link of [...links]) {
        link.clientClosed = true;
        link.client?.close(WS_CLOSE_SERVICE_RESTART, "gateway restart");
        link.upstream.close(1001, "gateway restart");
      }
      links.clear();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, drainMs);
      });
      await Promise.race([graceful, deadline]);
      clearTimeout(timer);
      shutdown.abort();
      await Promise.all(servers.map((server) => server.stop(true)));
    })();
    return stopping;
  }

  return {
    ports,
    stats,
    lastLeaderValidAt: () => Math.max(resolver.lastValidAt, createdAt),
    checkLeader: () => resolver.check(),
    stop,
  };
}
