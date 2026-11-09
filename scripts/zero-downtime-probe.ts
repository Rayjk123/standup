/**
 * Pure helpers for scripts/zero-downtime-check.ts: an HTTP probe loop that
 * classifies every failure, a WebSocket observer that reconnects like the web
 * client, bounded polling, port picking and report formatting. Every side
 * effect (fetch, WebSocket, timers, port checks) is injected, so this module
 * is unit-testable against ephemeral servers and holds no port numbers of a
 * real install.
 */
import { vitePortFor } from "../packages/shared/src/topology.js";

/** How one probe ended. `refused` is a connection refused: the acceptance criterion is zero of these. */
export type ProbeOutcome = "ok" | "refused" | "status" | "timeout" | "reset" | "error" | "unexpected";

export interface ProbeTarget {
  name: string;
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  intervalMs: number;
  /** Null when the response is what the target expects, else why not. Only called for 2xx responses. */
  check?(res: { status: number; contentType: string; body: string }): string | null;
}

export interface ProbeResult {
  target: string;
  /** Epoch ms the request was sent. */
  at: number;
  ms: number;
  outcome: ProbeOutcome;
  status?: number;
  detail?: string;
  /** The scenario phase the probe was sent in. */
  phase?: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classifies a fetch rejection. Bun reports a refused connect as
 * `code: "ConnectionRefused"`; Node-style errors carry `ECONNREFUSED`. An abort
 * from the probe's own timer is a timeout.
 */
export function classifyFetchError(err: unknown, timedOut = false): { outcome: ProbeOutcome; detail: string } {
  const e = (err ?? {}) as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  const code = String(e.code ?? e.cause?.code ?? "");
  const message = String(e.message ?? err);
  const detail = `${code ? `${code}: ` : ""}${message}`.slice(0, 300);
  if (timedOut || e.name === "TimeoutError" || e.name === "AbortError") return { outcome: "timeout", detail };
  if (code === "ConnectionRefused" || code === "ECONNREFUSED" || /ECONNREFUSED|connection refused/i.test(message)) {
    return { outcome: "refused", detail };
  }
  if (/ECONNRESET|ConnectionClosed|EPIPE|socket hang up|closed unexpectedly/i.test(`${code} ${message}`)) {
    return { outcome: "reset", detail };
  }
  return { outcome: "error", detail };
}

/** Sends one probe; never rejects. The timeout covers the whole response, body included. */
export async function probeOnce(
  target: ProbeTarget,
  deps: { fetch: FetchLike; clock: Clock; timeoutMs: number; phase?: string }
): Promise<ProbeResult> {
  const { clock } = deps;
  const at = clock.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs);
  const base = { target: target.name, at, ...(deps.phase ? { phase: deps.phase } : {}) };
  try {
    const res = await deps.fetch(target.url, {
      method: target.method ?? "GET",
      headers: target.headers,
      body: target.body,
      signal: controller.signal,
      redirect: "manual",
    });
    const body = await res.text();
    const ms = clock.now() - at;
    if (res.status < 200 || res.status >= 300) {
      return { ...base, ms, outcome: "status", status: res.status, detail: body.slice(0, 200) };
    }
    const problem = target.check?.({ status: res.status, contentType: res.headers.get("content-type") ?? "", body }) ?? null;
    return problem
      ? { ...base, ms, outcome: "unexpected", status: res.status, detail: problem.slice(0, 300) }
      : { ...base, ms, outcome: "ok", status: res.status };
  } catch (err) {
    const { outcome, detail } = classifyFetchError(err, timedOut);
    return { ...base, ms: clock.now() - at, outcome, detail };
  } finally {
    clock.clearTimeout(timer);
  }
}

export interface ProbeLoopOptions {
  targets: ProbeTarget[];
  fetch: FetchLike;
  clock: Clock;
  timeoutMs: number;
  /**
   * Per target: a tick that finds this many probes still in flight is skipped
   * (and counted). Default 1, so a held upstream yields one long probe rather
   * than a pile of concurrent ones.
   */
  maxInflight?: number;
  /** The current scenario phase, stamped on each result. */
  phase?: () => string;
  onResult?(result: ProbeResult): void;
}

/** Fires every target at its own fixed rate, concurrently, until stopped. */
export class ProbeLoop {
  readonly results: ProbeResult[] = [];
  readonly skipped: Record<string, number> = {};
  private readonly inflight = new Map<string, Set<Promise<void>>>();
  private readonly timers: unknown[] = [];
  private running = false;

  constructor(private readonly opts: ProbeLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const target of this.opts.targets) {
      this.inflight.set(target.name, new Set());
      this.skipped[target.name] = 0;
      this.tick(target);
    }
  }

  private tick(target: ProbeTarget): void {
    if (!this.running) return;
    const set = this.inflight.get(target.name)!;
    const max = this.opts.maxInflight ?? 1;
    if (set.size >= max) {
      this.skipped[target.name]++;
    } else {
      const p = probeOnce(target, { fetch: this.opts.fetch, clock: this.opts.clock, timeoutMs: this.opts.timeoutMs, phase: this.opts.phase?.() }).then(
        (result) => {
          this.results.push(result);
          try {
            this.opts.onResult?.(result);
          } catch {
            // A failing logger must not stop the loop.
          }
        }
      );
      set.add(p);
      void p.finally(() => set.delete(p));
    }
    this.timers.push(this.opts.clock.setTimeout(() => this.tick(target), target.intervalMs));
  }

  /** Stops scheduling and waits for in-flight probes (each bounded by the probe timeout). */
  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) this.opts.clock.clearTimeout(t);
    this.timers.length = 0;
    const pending = [...this.inflight.values()].flatMap((s) => [...s]);
    await Promise.allSettled(pending);
  }
}

export interface TargetSummary {
  total: number;
  ok: number;
  refused: number;
  status: number;
  timeout: number;
  reset: number;
  error: number;
  unexpected: number;
  skipped: number;
  maxMs: number;
  maxOkMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Successful probes slower than the soft budget: reported, not failed. */
  overBudget: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Per-target counts and latencies; `softBudgetMs` sets the over-budget threshold (default: none). */
export function summarize(
  results: readonly ProbeResult[],
  skipped: Record<string, number> = {},
  softBudgetMs: number = Number.POSITIVE_INFINITY
): Record<string, TargetSummary> {
  const out: Record<string, TargetSummary> = {};
  const names = new Set([...results.map((r) => r.target), ...Object.keys(skipped)]);
  for (const name of names) {
    const rs = results.filter((r) => r.target === name);
    const sorted = rs.map((r) => r.ms).sort((a, b) => a - b);
    const count = (o: ProbeOutcome) => rs.filter((r) => r.outcome === o).length;
    out[name] = {
      total: rs.length,
      ok: count("ok"),
      refused: count("refused"),
      status: count("status"),
      timeout: count("timeout"),
      reset: count("reset"),
      error: count("error"),
      unexpected: count("unexpected"),
      skipped: skipped[name] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
      maxOkMs: Math.max(0, ...rs.filter((r) => r.outcome === "ok").map((r) => r.ms)),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      overBudget: rs.filter((r) => r.outcome === "ok" && r.ms > softBudgetMs).length,
    };
  }
  return out;
}

// ── WebSocket observer ──────────────────────────────────────────────────────

export const WS_SERVICE_RESTART = 1012;
export const WS_RESTART_RECONNECT_MS = 250;
export const WS_BACKOFF_MIN_MS = 250;
export const WS_BACKOFF_MAX_MS = 2_000;

/** The client's reconnect plan: ~250ms after a 1012, else 250ms doubling up to 2s. */
export function nextReconnect(code: number, attempts: number): { delayMs: number; attempts: number } {
  if (code === WS_SERVICE_RESTART) return { delayMs: WS_RESTART_RECONNECT_MS, attempts: 0 };
  return { delayMs: Math.min(WS_BACKOFF_MAX_MS, WS_BACKOFF_MIN_MS * 2 ** attempts), attempts: attempts + 1 };
}

/** `base` with the `?epoch=&since=` resume cursor once both are known. */
export function resumeUrl(base: string, epoch: string | undefined, lastSeq: number | undefined): string {
  if (!epoch || lastSeq === undefined) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}epoch=${encodeURIComponent(epoch)}&since=${lastSeq}`;
}

/** The subset of the WebSocket API the observer uses. */
export interface WsLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
  send?(data: string): void;
}

export type WsFactory = (url: string) => WsLike;

/** Ids of the shared state a hello-ok snapshot carries that the check asserts on. */
export interface SnapshotSummary {
  /** Sessions without an `endedAt`. */
  sessions: string[];
  /** Asks whose status is pending (or unset). */
  asks: string[];
  checkpoints: string[];
}

function ids(list: unknown, keep: (item: Record<string, unknown>) => boolean = () => true): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string")
    .filter(keep)
    .map((item) => item.id as string);
}

/** The ids in a hello-ok `snapshot`, or undefined when it carries none. */
export function summarizeSnapshot(snapshot: unknown): SnapshotSummary | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const s = snapshot as { sessions?: unknown; asks?: unknown; checkpoints?: unknown };
  return {
    sessions: ids(s.sessions, (x) => x.endedAt === undefined || x.endedAt === null),
    asks: ids(s.asks, (x) => x.status === undefined || x.status === "pending"),
    checkpoints: ids(s.checkpoints),
  };
}

/** One frame other than hello-ok, as the observer received it. */
export interface WsFrame {
  /** Index into `connections` of the connection it arrived on. */
  conn: number;
  t: number;
  type: string;
  seq?: number;
  /** `payload.id`, when a string. */
  id?: string;
  /** `payload.sessionId`, when a string. */
  sessionId?: string;
}

export interface WsConnection {
  url: string;
  dialedAt: number;
  openedAt?: number;
  helloAt?: number;
  epoch?: string;
  resumed?: boolean;
  serverSeq?: number;
  snapshot?: SnapshotSummary;
  closedAt?: number;
  /** -1: the observer gave up on a connect that did not open in time. */
  closeCode?: number;
  /** Set when the observer itself closed this connection (stop or a deliberate disconnect). */
  closedBy?: "observer";
  frames: number;
}

/** Frames kept in `WsObserver.frameLog`; later ones are only counted. */
export const WS_FRAME_LOG_CAP = 50_000;

export interface WsObserverOptions {
  baseUrl: string;
  create: WsFactory;
  clock: Clock;
  /** A dial that has not opened by then is abandoned and retried. */
  connectTimeoutMs: number;
  onEvent?(event: Record<string, unknown>): void;
}

export interface WsHello {
  /** Index into `connections`. */
  conn: number;
  at: number;
  epoch?: string;
  resumed?: boolean;
  serverSeq?: number;
  snapshot?: SnapshotSummary;
}

export interface WsOutage {
  closedAt: number;
  code?: number;
  deliberate?: boolean;
  helloAt?: number;
  gapMs: number;
  epoch?: string;
  resumed?: boolean;
}

/** One logical client: connects, records hello-ok frames, reconnects like useWebSocket. */
export class WsObserver {
  readonly connections: WsConnection[] = [];
  readonly frameLog: WsFrame[] = [];
  /** Frames past WS_FRAME_LOG_CAP, counted but not kept. */
  framesDropped = 0;
  private ws?: WsLike;
  private attempts = 0;
  private epoch?: string;
  private lastSeq?: number;
  private timer?: unknown;
  private stopped = false;
  /** Set by disconnect(): the next close is not followed by a redial until reconnect(). */
  private paused = false;

  constructor(private readonly opts: WsObserverOptions) {}

  start(): void {
    this.stopped = false;
    this.dial();
  }

  /** The resume cursor the next dial sends. */
  cursor(): { epoch?: string; lastSeq?: number } {
    return { epoch: this.epoch, lastSeq: this.lastSeq };
  }

  /**
   * Closes the open connection from the client side (code 4000) and stays
   * disconnected until reconnect(). False when no connection is open.
   */
  disconnect(): boolean {
    if (!this.open || !this.ws) return false;
    this.paused = true;
    this.opts.clock.clearTimeout(this.timer);
    this.connections.at(-1)!.closedBy = "observer";
    try {
      this.ws.close(4000, "observer disconnect");
    } catch {
      // already closing
    }
    return true;
  }

  /** Dials again (with the resume cursor) after disconnect(). */
  reconnect(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.dial();
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.opts.onEvent?.({ t: this.opts.clock.now(), ...event });
    } catch {
      // logging is best-effort
    }
  }

  private dial(): void {
    if (this.stopped) return;
    const { clock } = this.opts;
    const url = resumeUrl(this.opts.baseUrl, this.epoch, this.lastSeq);
    const conn: WsConnection = { url, dialedAt: clock.now(), frames: 0 };
    const index = this.connections.push(conn) - 1;
    let settled = false;
    let connectTimer: unknown;
    const finish = (code: number, reason: string) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(connectTimer);
      conn.closedAt = clock.now();
      conn.closeCode = code;
      if (this.stopped) return;
      if (this.paused || index !== this.connections.length - 1) {
        // A deliberate disconnect, or a socket already superseded by a later
        // dial: nothing to reconnect.
        this.emit({ event: "close", code, reason, opened: conn.openedAt !== undefined, deliberate: conn.closedBy === "observer" });
        return;
      }
      const plan = nextReconnect(code, this.attempts);
      this.attempts = plan.attempts;
      this.emit({ event: "close", code, reason, opened: conn.openedAt !== undefined, reconnectInMs: plan.delayMs });
      this.timer = clock.setTimeout(() => this.dial(), plan.delayMs);
    };
    let ws: WsLike;
    try {
      ws = this.opts.create(url);
    } catch (err) {
      this.emit({ event: "dial-error", detail: String(err) });
      finish(-1, "dial error");
      return;
    }
    this.ws = ws;
    connectTimer = clock.setTimeout(() => {
      if (conn.openedAt !== undefined) return;
      this.emit({ event: "connect-timeout", url });
      try {
        ws.close();
      } catch {
        // already closing
      }
      finish(-1, "connect timeout");
    }, this.opts.connectTimeoutMs);
    ws.onopen = () => {
      conn.openedAt = clock.now();
      clock.clearTimeout(connectTimer);
      this.emit({ event: "open", url });
    };
    ws.onmessage = (ev) => {
      conn.frames++;
      // Answered as the console does: the collector closes a client that sends nothing for 90s.
      if (ev.data === "hb") {
        try {
          ws.send?.("hb-ack");
        } catch {
          // A socket going away; its close is handled below.
        }
        return;
      }
      let msg: {
        type?: unknown;
        seq?: unknown;
        payload?: { epoch?: unknown; serverSeq?: unknown; resumed?: unknown; snapshot?: unknown; id?: unknown; sessionId?: unknown };
      };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "hello-ok") {
        conn.helloAt = clock.now();
        conn.epoch = typeof msg.payload?.epoch === "string" ? msg.payload.epoch : undefined;
        conn.serverSeq = typeof msg.payload?.serverSeq === "number" ? msg.payload.serverSeq : undefined;
        conn.resumed = msg.payload?.resumed === true;
        conn.snapshot = summarizeSnapshot(msg.payload?.snapshot);
        this.epoch = conn.epoch;
        this.lastSeq = conn.serverSeq;
        this.attempts = 0;
        this.emit({ event: "hello-ok", epoch: conn.epoch, serverSeq: conn.serverSeq, resumed: conn.resumed, dialToHelloMs: conn.helloAt - conn.dialedAt });
        return;
      }
      const seq = typeof msg.seq === "number" ? msg.seq : undefined;
      if (seq !== undefined && this.epoch !== undefined) this.lastSeq = Math.max(this.lastSeq ?? 0, seq);
      const frame: WsFrame = {
        conn: index,
        t: clock.now(),
        type: typeof msg.type === "string" ? msg.type : "?",
        ...(seq !== undefined ? { seq } : {}),
        ...(typeof msg.payload?.id === "string" ? { id: msg.payload.id } : {}),
        ...(typeof msg.payload?.sessionId === "string" ? { sessionId: msg.payload.sessionId } : {}),
      };
      if (this.frameLog.length < WS_FRAME_LOG_CAP) this.frameLog.push(frame);
      else this.framesDropped++;
    };
    ws.onerror = () => {
      // A close event follows; the reconnect is planned there.
    };
    ws.onclose = (ev) => finish(ev.code, ev.reason ?? "");
  }

  /** Whether the latest connection is open and has its hello-ok. */
  get open(): boolean {
    const last = this.connections.at(-1);
    return !!last && last.helloAt !== undefined && last.closedAt === undefined && this.ws?.readyState === 1;
  }

  hellos(): WsHello[] {
    const out: WsHello[] = [];
    this.connections.forEach((c, conn) => {
      if (c.helloAt !== undefined) out.push({ conn, at: c.helloAt, epoch: c.epoch, resumed: c.resumed, serverSeq: c.serverSeq, snapshot: c.snapshot });
    });
    return out;
  }

  /** Connections that closed (or were given up on) without ever opening, except ones the observer closed itself. */
  neverOpened(): WsConnection[] {
    return this.connections.filter((c) => c.openedAt === undefined && c.closedAt !== undefined && c.closedBy !== "observer");
  }

  /**
   * Reconnect episodes: from a connection that had its hello-ok closing until
   * the next hello-ok (or `now`, when none came yet). `deliberate` marks a
   * close the observer made itself.
   */
  outages(now: number = this.opts.clock.now()): WsOutage[] {
    const out: WsOutage[] = [];
    for (let i = 0; i < this.connections.length; i++) {
      const c = this.connections[i];
      if (c.helloAt === undefined || c.closedAt === undefined) continue;
      if (this.stopped && i === this.connections.length - 1 && c.closedBy === "observer") continue;
      const next = this.connections.slice(i + 1).find((n) => n.helloAt !== undefined);
      out.push({
        closedAt: c.closedAt,
        code: c.closeCode,
        ...(c.closedBy === "observer" ? { deliberate: true } : {}),
        ...(next ? { helloAt: next.helloAt, epoch: next.epoch, resumed: next.resumed } : {}),
        gapMs: (next?.helloAt ?? now) - c.closedAt,
      });
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    this.opts.clock.clearTimeout(this.timer);
    const last = this.connections.at(-1);
    if (last && last.closedAt === undefined) last.closedBy = "observer";
    try {
      this.ws?.close(1000, "observer done");
    } catch {
      // already closed
    }
  }
}

// ── Polling, ports, reporting ───────────────────────────────────────────────

/**
 * Polls `fn` until it returns a value other than undefined, or throws after
 * `timeoutMs` naming `what` and the last error/undefined reason. `fn` may throw
 * to report why it is not ready yet.
 */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined> | T | undefined,
  opts: { timeoutMs: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? sleep;
  const deadline = now() + opts.timeoutMs;
  let last = "not ready";
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (now() >= deadline) throw new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${what} (last: ${last})`);
    await pause(opts.intervalMs ?? 250);
  }
}

export interface ChosenPorts {
  web: number;
  vite: number;
  collector: number;
  ws: number;
}

/** The ports a chosen set occupies: the public four plus slot a (+10000) and slot b (+20000) of collector and ws. */
export function occupiedPorts(p: ChosenPorts): number[] {
  return [p.web, p.vite, p.collector, p.ws, p.collector + 10_000, p.ws + 10_000, p.collector + 20_000, p.ws + 20_000];
}

/**
 * Throws unless every port is in [1024, maxPort], distinct and outside
 * `forbidden`. A `maxPort` below the kernel's ephemeral range keeps an
 * outgoing connection's source port from ever taking a port the run needs.
 */
export function assertPortsSafe(p: ChosenPorts, forbidden: ReadonlySet<number>, maxPort = 65_535): void {
  const all = occupiedPorts(p);
  for (const port of all) {
    if (!Number.isInteger(port) || port < 1024 || port > maxPort) throw new Error(`port ${port} is out of range`);
    if (forbidden.has(port)) throw new Error(`refusing to use port ${port}: it belongs to the live install`);
  }
  if (new Set(all).size !== all.length) throw new Error(`port set ${all.join(",")} has duplicates`);
}

/**
 * Picks web in [webLo, webHi) with vite at vitePortFor(web), as an install
 * derives it, and collector/ws adjacent in [colLo, colHi), such that every
 * occupied port is free (isFree) and safe (assertPortsSafe with `maxPort`).
 */
export async function pickPorts(opts: {
  isFree(port: number): Promise<boolean>;
  random?: () => number;
  forbidden: ReadonlySet<number>;
  collectorRange: [number, number];
  webRange: [number, number];
  maxPort?: number;
  attempts?: number;
}): Promise<ChosenPorts> {
  const rand = opts.random ?? Math.random;
  const pick = ([lo, hi]: [number, number]) => lo + Math.floor(rand() * (hi - lo - 1));
  for (let i = 0; i < (opts.attempts ?? 60); i++) {
    const collector = pick(opts.collectorRange);
    const web = pick(opts.webRange);
    const p: ChosenPorts = { web, vite: vitePortFor(web), collector, ws: collector + 1 };
    try {
      assertPortsSafe(p, opts.forbidden, opts.maxPort);
    } catch {
      continue;
    }
    let free = true;
    for (const port of occupiedPorts(p)) {
      if (!(await opts.isFree(port))) {
        free = false;
        break;
      }
    }
    if (free) return p;
  }
  throw new Error("could not find a free port set");
}

// ── Process ownership ───────────────────────────────────────────────────────

/**
 * The env var carrying the run id, which every process of a run inherits. It
 * labels the run's processes for a human inspecting them; the check itself
 * never reads another process's environment.
 */
export const RUN_MARKER_VAR = "STANDUP_ZD_RUN";

/** One row of `ps -A -ww -o pid=,ppid=,pgid=,sid=,args=`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  args: string;
}

/** The ps argv whose output parseProcessRows reads: ids and command lines only. */
export const PROCESS_TABLE_ARGV = ["ps", "-A", "-ww", "-o", "pid=,ppid=,pgid=,sid=,args="] as const;

export function parseProcessRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), sid: Number(m[4]), args: m[5]! });
  }
  return rows;
}

/**
 * Whether a command line runs code from the scratch install or from the
 * restart supervisor's copy under the scratch data dir.
 */
export function isRunCommandLine(args: string, root: string): boolean {
  return args.includes(`${root}/install/`) || args.includes(`${root}/data/restart/bin/`);
}

/** What the check knows about its own processes. */
export interface RunProcessIndex {
  root: string;
  /** Process groups / sessions the check started (the leader pid of each). */
  groups: ReadonlySet<number>;
  /** Pids already identified as the run's, with the command line they had then. */
  known: ReadonlyMap<number, string>;
  /** Never the run's, whatever else matches (the check itself). */
  exclude?: ReadonlySet<number>;
}

/**
 * The pids in `rows` that belong to the run: a process in a group or session
 * the check started, one already known with the same command line (so a
 * reused pid is not mistaken for it), one running scratch code
 * (isRunCommandLine), and every descendant of any of those.
 */
export function runProcessPids(rows: readonly ProcessRow[], index: RunProcessIndex): Set<number> {
  const exclude = index.exclude ?? new Set<number>();
  const ours = new Set<number>();
  for (const row of rows) {
    if (row.pid <= 1 || exclude.has(row.pid)) continue;
    if (index.groups.has(row.pgid) || index.groups.has(row.sid) || index.known.get(row.pid) === row.args || isRunCommandLine(row.args, index.root)) {
      ours.add(row.pid);
    }
  }
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const queue = [...ours];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (ours.has(child.pid) || exclude.has(child.pid)) continue;
      ours.add(child.pid);
      queue.push(child.pid);
    }
  }
  return ours;
}

// ── Live-state guard ────────────────────────────────────────────────────────

/**
 * Listening TCP ports from `ss -ltnpH` output, restricted to `ports`, with the
 * pids ss could attribute (none when it may not see the owning process).
 */
export function parseListeners(ssOutput: string, ports: ReadonlySet<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const line of ssOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[3];
    const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 10);
    if (!ports.has(port)) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    out.set(port, [...new Set([...(out.get(port) ?? []), ...pids])].sort((x, y) => x - y));
  }
  return out;
}

export interface Assertion {
  name: string;
  ok: boolean;
  detail: string;
}

/** The human summary block printed at the end of a run. */
export function formatSummary(input: {
  root: string;
  ok: boolean;
  targets: Record<string, TargetSummary>;
  failures: readonly ProbeResult[];
  assertions: readonly Assertion[];
  wsOutages: ReadonlyArray<{ closedAt: number; code?: number; gapMs: number; resumed?: boolean; deliberate?: boolean }>;
  /** Successful probes above this are flagged (not failed). */
  softBudgetMs?: number;
  warnings?: readonly string[];
  extra?: Record<string, unknown>;
}): string {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push(`ZERO-DOWNTIME CHECK: ${input.ok ? "PASS" : "FAIL"}`);
  lines.push("-".repeat(78));
  lines.push("Probes (target: total ok | refused status timeout reset error unexpected skipped | p50 p95 p99 max ms | over budget):");
  for (const [name, s] of Object.entries(input.targets)) {
    lines.push(
      `  ${name.padEnd(18)} ${String(s.total).padStart(5)} ${String(s.ok).padStart(5)} | ${s.refused} ${s.status} ${s.timeout} ${s.reset} ${s.error} ${s.unexpected} ${s.skipped} | ${s.p50Ms} ${s.p95Ms} ${s.p99Ms} ${s.maxMs} | ${s.overBudget}`
    );
  }
  const slow = Object.entries(input.targets).filter(([, s]) => s.overBudget > 0);
  if (input.softBudgetMs !== undefined && slow.length > 0) {
    lines.push(`FLAG: ${slow.map(([n, s]) => `${n} ${s.overBudget}`).join(", ")} probe(s) succeeded but took over the ${input.softBudgetMs}ms soft budget`);
  }
  if (input.failures.length > 0) {
    lines.push(`Failed probes (${input.failures.length}, first 40):`);
    for (const f of input.failures.slice(0, 40)) {
      lines.push(`  ${new Date(f.at).toISOString()} [${f.phase ?? "-"}] ${f.target} ${f.outcome}${f.status ? ` ${f.status}` : ""} ${f.ms}ms ${f.detail ?? ""}`.trimEnd());
    }
  }
  lines.push("WebSocket reconnects:");
  if (input.wsOutages.length === 0) lines.push("  (none)");
  for (const o of input.wsOutages) {
    lines.push(`  closed ${new Date(o.closedAt).toISOString()} code=${o.code ?? "?"} back after ${o.gapMs}ms${o.resumed ? " (resumed)" : ""}${o.deliberate ? " (deliberate)" : ""}`);
  }
  for (const [k, v] of Object.entries(input.extra ?? {})) lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  for (const w of input.warnings ?? []) lines.push(`WARNING: ${w}`);
  lines.push("Assertions:");
  for (const a of input.assertions) lines.push(`  [${a.ok ? "PASS" : "FAIL"}] ${a.name}: ${a.detail}`);
  lines.push(`Scratch root: ${input.root}`);
  lines.push("=".repeat(78));
  return lines.join("\n");
}

/**
 * migrations.ts's source with a no-op migration after the last entry of
 * VERSIONED_MIGRATIONS (the `];` that follows the last `  migration(<n>, …)`),
 * numbered one past it; null when there is no such entry.
 */
export function withNoOpMigration(source: string): { source: string; version: number } | null {
  const last = [...source.matchAll(/\n {2}migration\((\d+),/g)].at(-1);
  if (!last) return null;
  const listEnd = source.indexOf("\n];\n", last.index);
  if (listEnd < 0) return null;
  const version = Number.parseInt(last[1]!, 10) + 1;
  return { source: `${source.slice(0, listEnd)}\n  migration(${version}, "SELECT 1"),${source.slice(listEnd)}`, version };
}
