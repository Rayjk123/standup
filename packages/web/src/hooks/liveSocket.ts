import {
  reconnectDelayMs,
  DEFAULT_RECONNECT_BACKOFF,
  type BackoffConfig,
  type HelloOkPayload,
  type WsMessage,
} from "@standup/shared";

/**
 * Close code a collector or the gateway sends when it goes away for a restart
 * (RFC 6455 1012 "service restart"). Mirrors `WS_CLOSE_SERVICE_RESTART` in
 * `@standup/shared/topology`, which is node-only and can't be imported here.
 */
export const SERVICE_RESTART_CLOSE = 1012;

/**
 * Reconnect delay window after a service-restart close. The gateway holds the
 * upgrade until the new leader is listening, so there is no point backing off;
 * the delay is jittered across the window only so every open tab doesn't
 * re-dial the fresh leader in the same instant.
 */
export const SERVICE_RESTART_RECONNECT_MIN_MS = 100;
export const SERVICE_RESTART_RECONNECT_MAX_MS = 750;

/**
 * The collector's keepalive frame and the console's answer to it. Mirror
 * `HEARTBEAT_FRAME` and `HEARTBEAT_ACK_FRAME` in the collector's ws.ts. The
 * collector closes a socket that sends it nothing for 90s; answering every
 * heartbeat keeps a live tab well inside that even while a background tab's
 * timers (and so its pings) are throttled, since message events are not.
 */
export const HEARTBEAT_FRAME = "hb";
export const HEARTBEAT_ACK_FRAME = "hb-ack";

/**
 * Why the live socket is down, in words for the reconnect banner: the close
 * code the connection ended with, or which of the controller's own checks
 * gave up on it.
 */
export function closeCause(code: number): string {
  if (code === SERVICE_RESTART_CLOSE) return "Standup restarted";
  if (code === 1006 || code === 0) return "connection lost (1006)";
  if (code === 1011) return "server dropped a frame (1011)";
  if (code === 4000) return "server closed a silent connection (4000)";
  return `connection closed (${code})`;
}

/**
 * A frame's seq is a gap when it lands more than one past the last seq seen —
 * a broadcast was dropped while the socket was briefly wedged — or below it:
 * seqs only climb within one server epoch, so a lower one means the server
 * restarted its counter without this connection getting a fresh hello-ok.
 * Either way the affected collections must be refetched. A repeat of the last
 * seq is a duplicate delivery, not a gap. Unknown baseline (`null`, before the
 * first hello-ok) is never a gap: there is nothing to compare against yet.
 */
export function isSeqGap(lastSeq: number | null, seq: number): boolean {
  return lastSeq !== null && (seq > lastSeq + 1 || seq < lastSeq);
}

/** Where a reconnect resumes from: the server's boot epoch and the last seq applied in it. */
export interface ReplayCursor {
  epoch: string | null;
  lastSeq: number | null;
}

/**
 * The URL to dial: `base` plus `?epoch=<e>&since=<lastSeq>` once both are
 * known (after a hello-ok), so the server can replay the frames missed while
 * disconnected instead of sending a full snapshot. Before the first handshake
 * there is nothing to resume, and `base` is dialed as is.
 */
export function wsUrlWithCursor(base: string, cursor: ReplayCursor): string {
  if (!cursor.epoch || cursor.lastSeq === null) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}epoch=${encodeURIComponent(cursor.epoch)}&since=${cursor.lastSeq}`;
}

/**
 * When to re-dial after a close, and the failed-attempt count to carry. A
 * service-restart close is a planned handoff, not a failure: re-dial almost at
 * once (jittered within the restart window) and reset the count so a restart
 * never inherits an earlier backoff. Anything else is a failed connection and
 * climbs the backoff curve.
 */
export function reconnectPlan(
  closeCode: number,
  failedAttempts: number,
  rand: () => number = Math.random,
  backoff: BackoffConfig = DEFAULT_RECONNECT_BACKOFF,
): { delayMs: number; attempts: number } {
  if (closeCode === SERVICE_RESTART_CLOSE) {
    const span = SERVICE_RESTART_RECONNECT_MAX_MS - SERVICE_RESTART_RECONNECT_MIN_MS;
    return { delayMs: SERVICE_RESTART_RECONNECT_MIN_MS + Math.floor(rand() * span), attempts: 0 };
  }
  const attempts = failedAttempts + 1;
  return { delayMs: reconnectDelayMs(attempts, backoff, rand), attempts };
}

/**
 * How to apply a hello-ok: `resume` keeps the client's state and lets the
 * replayed frames that follow flow through `onMessage`; `snapshot` replaces
 * state from the payload. Resume only when the server says so AND this
 * connection asked for it with a cursor — a `resumed` flag on a connection
 * that sent none has nothing to resume onto.
 */
export function helloAction(payload: HelloOkPayload, sentCursor: boolean): "resume" | "snapshot" {
  return payload.resumed === true && sentCursor ? "resume" : "snapshot";
}

export type LiveSocketHandlers = {
  // Fires synchronously for every broadcast frame, in order — unlike a single
  // `lastMessage` state slot, two frames that arrive in the same task (e.g. a
  // hook handler broadcasting ask:resolved then checkpoint:new back-to-back)
  // don't coalesce into just the last one. Frames the server replays after a
  // resumed hello-ok arrive here too.
  onMessage: (message: WsMessage) => void;
  // Fires on connect and on every reconnect the server answers with a full
  // snapshot (the first connect, a new server epoch, or a cursor the server's
  // replay buffer no longer covers). The snapshot is authoritative, so it
  // doubles as reconnect resync.
  onHello: (payload: HelloOkPayload) => void;
  // Fires instead of `onHello` when the server resumed this client's cursor:
  // its state is current up to `serverSeq` and the missed frames follow, so
  // the caller keeps its state and only refreshes what the socket never carries.
  onResume: (payload: HelloOkPayload) => void;
  // Fires when a live frame's seq jumps past the expected next value — a
  // dropped broadcast — so the caller can refetch the affected collections.
  onGap: () => void;
  // Fires when an open socket is replaced for going quiet (see staleAfterMs);
  // useWebSocket routes LiveSocketOptions.onStale here.
  onStale?: () => void;
};

/**
 * Whether the socket is up. `downSince` is when the current outage began (the
 * controller's start, the first close, or the first failed attempt), null once
 * a hello-ok has landed. A socket that opens but drops before its hello-ok
 * doesn't end the outage. `cause` is why the latest attempt failed (see
 * closeCause), null while up or before the first failure.
 */
export interface LiveSocketStatus {
  connected: boolean;
  downSince: number | null;
  cause?: string | null;
}

/** The slice of the WebSocket API the controller drives. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Where the controller hears that the page came back (tab shown, network up). */
export interface WakeSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface LiveSocketOptions {
  url: string;
  handlers: () => LiveSocketHandlers;
  onStatus?: (status: LiveSocketStatus) => void;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  backoff?: BackoffConfig;
  /** How often a keepalive ping goes out. */
  pingIntervalMs?: number;
  /**
   * A ping left unanswered (no pong, no frame) for this long marks the socket
   * dead, and it is replaced: a half-open connection — a laptop that slept, a
   * proxy that lost its upstream without closing the client side — otherwise
   * reads as connected forever while delivering nothing. Measured from the
   * ping, not from the last frame, so a background tab whose timers are
   * throttled to one a minute doesn't drop a socket that answered every ping.
   */
  pongTimeoutMs?: number;
  /**
   * An open socket that has heard nothing — no frame, no pong, no server
   * heartbeat (the collector sends one every 10s) — for this long is stale and
   * replaced at the next check or wake. Unlike the pong timeout it doesn't
   * wait on a ping of its own, which a throttled background tab may send a
   * minute late: a tab that comes back to a quiet socket reconnects at once.
   */
  staleAfterMs?: number;
  /**
   * Called when an open socket is replaced for going quiet (stale, or a ping
   * unanswered), so the caller can read back what it may have missed without
   * waiting for the new socket's handshake.
   */
  onStale?: () => void;
  /** A socket still connecting after this long is abandoned and redialled. */
  connectTimeoutMs?: number;
  /**
   * An open socket whose hello-ok hasn't arrived after this long is abandoned
   * and redialled. Until the hello-ok lands the staleness and ping checks wait:
   * the hello carries the whole snapshot, megabytes that can take longer than
   * staleAfterMs to come through a tunnel, and nothing (a pong included) is
   * heard before all of it has.
   */
  helloTimeoutMs?: number;
  /** Event sources and the events on each that retry a down socket at once (tab shown, network up, focus). */
  wakeOn?: Array<{ source: WakeSource; events: string[] }>;
  isVisible?: () => boolean;
  log?: (line: string) => void;
}

const OPEN = 1;
const CONNECTING = 0;

export const DEFAULT_PING_INTERVAL_MS = 15_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_HELLO_TIMEOUT_MS = 60_000;
// Two of the collector's 10s heartbeats missed in a row.
export const DEFAULT_STALE_AFTER_MS = 20_000;

/**
 * The shortest gap a wake (tab shown, focus, network up, a catch-up read)
 * leaves after the last failure, given `attempts` failed dials so far: the low end
 * of the backoff window for the next attempt, from the second failure in a row
 * on (one drop is a blip, and a wake redials it at once). A wake still skips a
 * backoff a throttled background tab stretched, but a tab whose connection
 * keeps failing doesn't redial on every focus.
 */
export function wakeGapMs(attempts: number, backoff: BackoffConfig = DEFAULT_RECONNECT_BACKOFF): number {
  if (attempts <= 1) return 0;
  const exp = backoff.baseMs * Math.pow(backoff.factor ?? 2, attempts - 1);
  return Math.min(exp, backoff.maxMs) / 2;
}

/**
 * The console's connection to the collector's live socket: connects, decodes
 * frames, tracks seq gaps, reconnects with backoff, and reports status.
 *
 * A socket this controller replaced or closed on `dispose` never reconnects
 * on its own: its late `close` event is ignored. Otherwise every effect
 * cleanup (React StrictMode's double mount, an HMR update) would leave a socket
 * that reconnects itself and feeds duplicate frames forever. Only the current
 * socket schedules a retry.
 */
export function createLiveSocket(opts: LiveSocketOptions) {
  const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const backoff = opts.backoff ?? DEFAULT_RECONNECT_BACKOFF;
  const pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.log(line));

  let socket: SocketLike | null = null;
  let disposed = false;
  let attempts = 0;
  // When the last retry was scheduled (a close or failed dial); a wake within
  // wakeGapMs of it waits for that retry.
  let lastFailAt = Number.NEGATIVE_INFINITY;
  // When the open socket opened, while its hello-ok is still to come; null otherwise.
  let awaitingHelloSince: number | null = null;
  let retryTimer: unknown = null;
  let pingTimer: unknown = null;
  let connectTimer: unknown = null;
  // When the outstanding ping went out; null when none is awaiting an answer.
  let pingSentAt: number | null = null;
  let lastPingAt = now();
  // When the open socket last heard anything at all (set on open).
  let lastHeardAt = now();
  // The last broadcast seq applied. Reset by each hello-ok to the server's
  // baseline; null until the first handshake lands.
  let lastSeq: number | null = null;
  // The server's boot epoch from the last hello-ok; seqs only compare within one.
  let epoch: string | null = null;
  let status: LiveSocketStatus = { connected: false, downSince: now(), cause: null };

  const setStatus = (next: LiveSocketStatus) => {
    if (next.connected === status.connected && next.downSince === status.downSince && next.cause === status.cause) return;
    status = next;
    opts.onStatus?.(status);
  };

  // `since` backdates the outage to when a quiet socket last heard anything,
  // so the banner shows (and counts) how long updates have really been paused.
  // `cause` is the latest failure's: what is keeping the socket down now.
  const markDown = (cause: string, since?: number) => {
    setStatus({ connected: false, downSince: status.downSince ?? since ?? now(), cause });
  };

  const isStale = () => now() - lastHeardAt >= staleAfterMs;

  // Replaces an open socket that went quiet, and tells the caller.
  const dropQuiet = (target: SocketLike, cause: string) => {
    drop(target, cause, lastHeardAt);
    opts.onStale?.();
  };

  // `closeCode` is the close event's code; 0 for a failure with none.
  const scheduleRetry = (closeCode = 0) => {
    if (disposed || retryTimer !== null) return;
    const plan = reconnectPlan(closeCode, attempts, Math.random, backoff);
    attempts = plan.attempts;
    lastFailAt = now();
    const delay = plan.delayMs;
    log(`[ws] Disconnected (${closeCode}), reconnecting in ${delay}ms...`);
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  // Drops an open socket that has heard nothing for staleAfterMs, or whose
  // outstanding ping has gone unanswered past the timeout; otherwise pings it
  // when the interval is up (or `immediate` asks for one).
  const probe = (immediate = false) => {
    const current = socket;
    if (!current || current.readyState !== OPEN) return;
    if (awaitingHelloSince !== null) {
      if (now() - awaitingHelloSince >= helloTimeoutMs) {
        const cause = `no hello-ok within ${Math.round(helloTimeoutMs / 1000)}s`;
        log(`[ws] ${cause}, reconnecting`);
        dropQuiet(current, cause);
      }
      return;
    }
    if (isStale()) {
      const cause = `nothing heard for ${Math.round((now() - lastHeardAt) / 1000)}s`;
      log(`[ws] ${cause}, reconnecting`);
      dropQuiet(current, cause);
      return;
    }
    if (pingSentAt !== null) {
      if (now() - pingSentAt >= pongTimeoutMs) {
        const cause = `no answer to a ping for ${Math.round((now() - pingSentAt) / 1000)}s`;
        log(`[ws] ${cause}, reconnecting`);
        dropQuiet(current, cause);
      }
      return;
    }
    if (!immediate && now() - lastPingAt < pingIntervalMs) return;
    try {
      current.send("ping");
      pingSentAt = lastPingAt = now();
    } catch {
      drop(current, "a ping couldn't be sent");
    }
  };

  // The next check lands when the hello-ok is overdue while one is awaited,
  // else when the outstanding ping times out, else when the next ping is due,
  // or sooner when the socket would turn stale first; with no open socket it
  // idles at the ping interval (an open restarts the schedule).
  const schedulePing = () => {
    if (disposed) return;
    const pingDue = pingSentAt !== null ? pingSentAt + pongTimeoutMs : lastPingAt + pingIntervalMs;
    const due =
      awaitingHelloSince !== null ? awaitingHelloSince + helloTimeoutMs : Math.min(pingDue, lastHeardAt + staleAfterMs);
    const delay = socket?.readyState === OPEN ? Math.max(0, due - now()) : pingIntervalMs;
    pingTimer = setTimer(() => {
      pingTimer = null;
      probe();
      schedulePing();
    }, delay);
  };

  const armPongCheck = () => {
    if (pingTimer !== null) clearTimer(pingTimer);
    pingTimer = null;
    schedulePing();
  };

  // Abandons `target`: it is no longer the current socket, so its own close
  // event (whenever it lands) is ignored, and the retry starts now.
  const drop = (target: SocketLike, cause: string, quietSince?: number) => {
    if (socket !== target) return;
    forget();
    try {
      target.close();
    } catch {
      // Already closed.
    }
    markDown(cause, quietSince);
    scheduleRetry();
  };

  // Lets go of the current socket and what was pending on it.
  const forget = () => {
    socket = null;
    pingSentAt = null;
    awaitingHelloSince = null;
    if (connectTimer !== null) clearTimer(connectTimer);
    connectTimer = null;
  };

  const connect = () => {
    if (disposed) return;
    const target = wsUrlWithCursor(opts.url, { epoch, lastSeq });
    const sentCursor = target !== opts.url;
    let ws: SocketLike;
    try {
      ws = createSocket(target);
    } catch (err) {
      log(`[ws] Failed to connect: ${String(err)}`);
      markDown("couldn't open a connection");
      scheduleRetry();
      return;
    }
    forget();
    socket = ws;
    // A handshake nothing answers (a wedged collector behind a proxy that
    // holds the upgrade open, a SYN lost after a network change) would
    // otherwise stall every retry until the browser gives up.
    connectTimer = setTimer(() => {
      connectTimer = null;
      if (socket === ws && ws.readyState !== OPEN) {
        log("[ws] Connect timed out, retrying");
        drop(ws, "connecting timed out");
      }
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (socket !== ws) return;
      log("[ws] Connected");
      lastPingAt = lastHeardAt = now();
      awaitingHelloSince = now();
      if (connectTimer !== null) clearTimer(connectTimer);
      connectTimer = null;
      armPongCheck();
      // The outage and the backoff count end at the hello-ok, so an
      // open-then-drop loop keeps backing off.
      setStatus({ connected: true, downSince: status.downSince, cause: status.cause });
    };

    ws.onclose = (ev) => {
      if (socket !== ws) return;
      forget();
      const raw = (ev as { code?: unknown } | null)?.code;
      const code = typeof raw === "number" ? raw : 0;
      markDown(closeCause(code));
      scheduleRetry(code);
    };

    ws.onerror = () => {
      // The close event that follows does the bookkeeping.
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      // Anything heard (the pong, a heartbeat or any frame) answers the
      // outstanding ping and keeps the socket fresh.
      pingSentAt = null;
      lastHeardAt = now();
      if (typeof event.data !== "string") return;
      if (event.data === HEARTBEAT_FRAME) {
        try {
          ws.send(HEARTBEAT_ACK_FRAME);
        } catch {
          // A socket that can't take it is found by the next probe.
        }
        return;
      }
      let message: WsMessage;
      try {
        message = JSON.parse(event.data) as WsMessage;
      } catch {
        // Ignore non-JSON messages (like pong)
        return;
      }
      const handlers = opts.handlers();
      if (message.type === "hello-ok") {
        const payload = message.payload as HelloOkPayload;
        // On resume serverSeq is the cursor the client sent, so the replayed
        // frames continue the seq run and gap detection still applies to them.
        lastSeq = payload.serverSeq;
        epoch = payload.epoch ?? null;
        attempts = 0;
        // The liveness checks start now, from the hello-ok, not from the open.
        if (awaitingHelloSince !== null) {
          awaitingHelloSince = null;
          lastPingAt = now();
          armPongCheck();
        }
        setStatus({ connected: true, downSince: null, cause: null });
        if (helloAction(payload, sentCursor) === "resume") handlers.onResume(payload);
        else handlers.onHello(payload);
        return;
      }
      if (typeof message.seq === "number") {
        if (isSeqGap(lastSeq, message.seq)) handlers.onGap();
        lastSeq = message.seq;
      }
      handlers.onMessage(message);
    };
  };

  // Replaces an open socket at once when it has gone stale, else pings it
  // now, so a connection that died without closing is found within the pong
  // timeout. A socket that is down or still connecting is left alone.
  const checkNow = () => {
    if (disposed || socket?.readyState !== OPEN) return;
    probe(true);
    armPongCheck();
  };

  // A page coming back (tab shown, network up, window focused) retries a
  // down socket at once rather than waiting out a backoff that a background
  // tab's throttled timers stretched — unless the last failure was within
  // wakeGapMs, so a connection that keeps failing still backs off. The failed
  // count carries over either way: only a hello-ok resets it. `immediate`
  // (the banner's "Retry now") skips the gap. A socket that still reads open
  // is checked (see checkNow), so a connection that died while the laptop
  // slept is found within the pong timeout.
  const redial = (immediate: boolean) => {
    if (disposed) return;
    if (opts.isVisible && !opts.isVisible()) return;
    if (socket?.readyState === OPEN) {
      checkNow();
      return;
    }
    if (socket?.readyState === CONNECTING) return;
    if (!immediate && retryTimer !== null && now() - lastFailAt < wakeGapMs(attempts, backoff)) return;
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    connect();
  };
  const wake = () => redial(false);
  for (const { source, events } of opts.wakeOn ?? []) for (const type of events) source.addEventListener(type, wake);

  connect();
  schedulePing();

  return {
    /** Sends a raw frame if the socket is open; a no-op otherwise. */
    send(data: string): void {
      if (socket && socket.readyState === OPEN) socket.send(data);
    },
    status(): LiveSocketStatus {
      return status;
    },
    /** Retries a down socket now, unless it last failed within wakeGapMs; checks an open one. */
    wake,
    /** Retries a down socket now, however recently it failed. */
    retryNow: () => redial(true),
    /**
     * Checks an open socket now (pings it, or replaces it when stale) and
     * never dials: for a caller that saw evidence of lost frames, which says
     * nothing about whether a down socket's next dial would fare better.
     */
    check: checkNow,
    dispose(): void {
      disposed = true;
      for (const { source, events } of opts.wakeOn ?? []) for (const type of events) source.removeEventListener(type, wake);
      if (retryTimer !== null) clearTimer(retryTimer);
      if (pingTimer !== null) clearTimer(pingTimer);
      retryTimer = pingTimer = null;
      const current = socket;
      forget();
      current?.close();
    },
  };
}

export type LiveSocket = ReturnType<typeof createLiveSocket>;
