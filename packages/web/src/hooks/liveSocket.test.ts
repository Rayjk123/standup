import { describe, expect, test } from "bun:test";
import type { WsMessage } from "@standup/shared";
import { createLiveSocket, type LiveSocketStatus, type SocketLike, type WakeSource } from "./liveSocket";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** The connection ending from the far side (or a close event landing late). */
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  frame(m: Partial<WsMessage>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

/** Manual clock and timers. */
function harness(opts: { visible?: () => boolean; defaultTimings?: boolean } = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  const statuses: LiveSocketStatus[] = [];
  const messages: WsMessage[] = [];
  let hellos = 0;
  let resumes = 0;
  let gaps = 0;
  let stales = 0;
  const listeners = new Map<string, Set<() => void>>();
  const wakeSource: WakeSource = {
    addEventListener: (t, l) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t, l) => listeners.get(t)?.delete(l),
  };
  const socket = createLiveSocket({
    url: "ws://x/ws",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    handlers: () => ({
      onMessage: (m) => messages.push(m),
      onHello: () => hellos++,
      onResume: () => resumes++,
      onGap: () => gaps++,
    }),
    onStatus: (s) => statuses.push(s),
    onStale: () => stales++,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => timers.delete(h as number),
    ...(opts.defaultTimings
      ? {}
      : { backoff: { baseMs: 1000, maxMs: 8000, factor: 2 }, pingIntervalMs: 1000, pongTimeoutMs: 3000, connectTimeoutMs: 5000 }),
    wakeOn: [{ source: wakeSource, events: ["visibilitychange", "online"] }],
    isVisible: opts.visible,
    log: () => {},
  });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = until;
  };
  /** Moves the clock without running timers: what a throttled tab's timers see when they finally run. */
  const jump = (ms: number) => {
    now += ms;
  };
  const fire = (type: string) => listeners.get(type)?.forEach((l) => l());
  return {
    socket,
    sockets,
    statuses,
    messages,
    advance,
    jump,
    fire,
    hellos: () => hellos,
    resumes: () => resumes,
    gaps: () => gaps,
    stales: () => stales,
    last: () => sockets[sockets.length - 1]!,
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("createLiveSocket", () => {
  test("delivers hello and frames, and flags a seq gap", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 4 } as never });
    h.last().frame({ type: "ask:new", seq: 5 });
    h.last().frame({ type: "ask:new", seq: 7 });
    h.last().frame({ type: "persona:message", payload: { id: "m" } });
    expect(h.hellos()).toBe(1);
    expect(h.messages.map((m) => m.type)).toEqual(["ask:new", "ask:new", "persona:message"]);
    expect(h.gaps()).toBe(1);
  });

  test("reports when an outage began, retries with backoff, and clears it on the reconnect's hello-ok", () => {
    const h = harness();
    expect(h.socket.status()).toEqual({ connected: false, downSince: 0, cause: null });
    h.last().open();
    expect(h.socket.status()).toEqual({ connected: true, downSince: 0, cause: null });
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    expect(h.socket.status()).toEqual({ connected: true, downSince: null, cause: null });
    h.advance(500);
    h.last().onclose?.({ code: 1011 });
    const down = h.socket.status();
    expect(down.connected).toBe(false);
    expect(down.downSince).toBe(500);
    expect(down.cause).toBe("server dropped a frame (1011)");
    // A failed attempt keeps the outage's start; the cause is the latest failure's.
    h.advance(1000);
    expect(h.sockets.length).toBe(2);
    h.last().drop();
    expect(h.socket.status().downSince).toBe(500);
    expect(h.socket.status().cause).toBe("connection lost (1006)");
    h.advance(2000);
    expect(h.sockets.length).toBe(3);
    h.last().open();
    expect(h.socket.status()).toEqual({ connected: true, downSince: 500, cause: "connection lost (1006)" });
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    expect(h.socket.status()).toEqual({ connected: true, downSince: null, cause: null });
    // The next outage gets its own cause.
    h.last().onclose?.({ code: 1006 });
    expect(h.socket.status().cause).toBe("connection lost (1006)");
  });

  test("a hello-ok still coming through a slow tunnel isn't judged stale; it has its own deadline", () => {
    const h = harness({ defaultTimings: true });
    h.last().open();
    // Megabytes of snapshot on the wire: nothing is heard, not even a pong, for 45s.
    h.advance(45_000);
    expect(h.sockets.length).toBe(1);
    expect(h.last().closed).toBe(false);
    expect(h.last().sent).toEqual([]);
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    expect(h.socket.status()).toEqual({ connected: true, downSince: null, cause: null });
    // The liveness checks run from the hello-ok on.
    h.advance(15_000);
    expect(h.last().sent).toEqual(["ping"]);
    h.last().onmessage?.({ data: "pong" });
    expect(h.sockets.length).toBe(1);

    const slow = harness({ defaultTimings: true });
    slow.last().open();
    slow.advance(59_999);
    expect(slow.last().closed).toBe(false);
    slow.advance(1);
    expect(slow.sockets[0]!.closed).toBe(true);
    expect(slow.socket.status().cause).toBe("no hello-ok within 60s");
  });

  test("answers every server heartbeat with an ack, and only the heartbeat", () => {
    const h = harness();
    h.last().open();
    h.last().onmessage?.({ data: "hb" });
    h.last().onmessage?.({ data: "pong" });
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.last().onmessage?.({ data: "hb" });
    expect(h.last().sent).toEqual(["hb-ack", "hb-ack"]);
    expect(h.hellos()).toBe(1);
  });

  test("a ping left unanswered past the timeout replaces the socket", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.advance(1000);
    expect(h.last().sent).toEqual(["ping"]);
    // The pong answers it; the next ping goes out a ping interval later, not sooner.
    h.last().onmessage?.({ data: "pong" });
    h.advance(500);
    expect(h.last().sent).toEqual(["ping"]);
    h.advance(2500);
    expect(h.last().sent).toEqual(["ping", "ping"]);
    // Then no answer past pongTimeoutMs: dropped and redialled.
    h.advance(4500);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.socket.status().connected).toBe(false);
    h.advance(1000);
    expect(h.sockets.length).toBe(2);
  });

  test("a late timer (a throttled background tab) doesn't drop a socket that answered", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.advance(1000);
    h.last().onmessage?.({ data: "pong" });
    // No timer runs for a minute, but the server's heartbeats keep arriving
    // (socket events aren't throttled); then the tick lands: it pings rather than drops.
    for (let i = 0; i < 6; i++) {
      h.jump(10_000);
      h.last().onmessage?.({ data: "hb" });
    }
    h.advance(0);
    expect(h.sockets.length).toBe(1);
    expect(h.last().sent.filter((f) => f === "ping")).toEqual(["ping", "ping"]);
    expect(h.last().sent.filter((f) => f === "hb-ack")).toHaveLength(6);
    expect(h.socket.status().connected).toBe(true);
    expect(h.stales()).toBe(0);
  });

  test("a throttled tick that finds the socket has heard nothing for staleAfterMs replaces it at once", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.advance(1000);
    h.last().onmessage?.({ data: "pong" });
    const quietSince = 1000;
    h.jump(60_000);
    h.advance(0);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.stales()).toBe(1);
    // The outage is dated from when the socket went quiet, so the banner shows at once.
    expect(h.socket.status()).toEqual({ connected: false, downSince: quietSince, cause: "nothing heard for 60s" });
  });

  test("a page coming back to a quiet socket reconnects at once instead of pinging and waiting", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.jump(45_000);
    h.fire("visibilitychange");
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets[0]!.sent).toEqual([]);
    expect(h.stales()).toBe(1);
  });

  test("server heartbeats alone keep a socket fresh", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    for (let i = 0; i < 20; i++) {
      h.advance(900);
      h.last().onmessage?.({ data: i % 2 ? "hb" : "pong" });
    }
    expect(h.sockets.length).toBe(1);
    expect(h.stales()).toBe(0);
  });

  test("a handshake nothing answers is abandoned and redialled", () => {
    const h = harness();
    h.advance(5001);
    expect(h.sockets[0]!.closed).toBe(true);
    h.advance(1000);
    expect(h.sockets.length).toBe(2);
  });

  test("waking with an open socket pings it at once", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.fire("visibilitychange");
    expect(h.last().sent).toEqual(["ping"]);
    h.advance(4500);
    expect(h.sockets[0]!.closed).toBe(true);
  });

  test("a replaced or disposed socket's late close never reconnects", () => {
    const h = harness();
    const first = h.last();
    first.open();
    first.frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.advance(10_000); // pings unanswered: replaced
    const count = h.sockets.length;
    first.drop(); // its close event lands late
    h.advance(100);
    expect(h.sockets.length).toBe(count);

    h.socket.dispose();
    h.last().drop();
    h.advance(60_000);
    expect(h.sockets.length).toBe(count);
    expect(h.listenerCount()).toBe(0);
  });

  test("a frame from a socket that was replaced is ignored", () => {
    const h = harness();
    const first = h.last();
    first.open();
    first.drop();
    h.advance(1000);
    first.frame({ type: "persona:message", payload: {} });
    expect(h.messages).toHaveLength(0);
  });

  test("the page coming back retries a down socket at once once its backoff was stretched", () => {
    const h = harness();
    h.last().open();
    h.last().drop();
    for (let i = 0; i < 4; i++) {
      h.advance(8000);
      h.last().drop();
    }
    // A throttled background tab: its retry timer is late.
    h.jump(60_000);
    const count = h.sockets.length;
    h.fire("visibilitychange");
    expect(h.sockets.length).toBe(count + 1);
    // Not while one is already connecting.
    h.fire("online");
    expect(h.sockets.length).toBe(count + 1);
  });

  test("check() pings an open socket and never dials a down or connecting one", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.socket.check();
    expect(h.last().sent).toEqual(["ping"]);
    h.last().drop();
    // Lost frames found while down (a catch-up read every 2s) leave the backoff alone.
    for (let i = 0; i < 5; i++) h.socket.check();
    expect(h.sockets.length).toBe(1);
    h.advance(1000);
    expect(h.sockets.length).toBe(2);
    h.socket.check();
    expect(h.sockets.length).toBe(2);
    expect(h.last().sent).toEqual([]);
  });

  test("a redial that doesn't end the outage keeps the backoff climbing", () => {
    const h = harness();
    h.last().open();
    h.last().drop();
    h.advance(1000);
    h.last().drop();
    h.advance(2000);
    h.last().drop();
    // Three failed attempts in, Retry now dials now...
    h.socket.retryNow();
    expect(h.sockets.length).toBe(4);
    h.last().drop();
    // ...and its failure, the fourth, waits 4-8s rather than restarting at 0.5-1s.
    h.advance(3999);
    expect(h.sockets.length).toBe(4);
    h.advance(4001);
    expect(h.sockets.length).toBe(5);
    // A hello-ok resets the count.
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.last().drop();
    h.advance(1000);
    expect(h.sockets.length).toBe(6);
  });

  test("one drop is a blip: a wake right after it redials at once", () => {
    const h = harness();
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    h.last().drop();
    h.fire("visibilitychange");
    expect(h.sockets.length).toBe(2);
  });

  test("a connection that keeps failing keeps its backoff when the page wakes, and Retry now still dials", () => {
    const h = harness();
    h.last().open();
    h.last().drop();
    for (let i = 0; i < 3; i++) {
      h.advance(8000);
      h.last().drop();
    }
    // Four failures: the next attempt is 4-8s out, and a wake within 4s of the last dial waits for it.
    const count = h.sockets.length;
    h.fire("visibilitychange");
    h.fire("online");
    h.advance(3000);
    h.fire("visibilitychange");
    expect(h.sockets.length).toBe(count);
    // The retry that follows still backs off from four failures, not from zero.
    h.advance(5000);
    expect(h.sockets.length).toBe(count + 1);
    h.last().drop();
    h.advance(3999);
    expect(h.sockets.length).toBe(count + 1);
    h.socket.retryNow();
    expect(h.sockets.length).toBe(count + 2);
  });

  test("a hidden page waits for the backoff", () => {
    const h = harness({ visible: () => false });
    h.last().drop();
    const count = h.sockets.length;
    h.fire("visibilitychange");
    expect(h.sockets.length).toBe(count);
  });

  test("with the default timings, a socket that goes silent without closing is replaced within 30s", () => {
    const h = harness({ defaultTimings: true });
    h.last().open();
    h.last().frame({ type: "hello-ok", payload: { serverSeq: 0 } as never });
    // It answers the first ping; from then on nothing arrives and no close lands.
    h.advance(15_000);
    h.last().onmessage?.({ data: "pong" });
    let silentFor = 0;
    while (!h.sockets[0]!.closed && silentFor < 60_000) {
      h.advance(500);
      silentFor += 500;
    }
    expect(h.sockets[0]!.closed).toBe(true);
    expect(silentFor).toBeLessThanOrEqual(30_000);
    // And the redial follows straight after.
    h.advance(1_000);
    expect(h.sockets.length).toBe(2);
  });

  test("send reaches only an open socket", () => {
    const h = harness();
    h.socket.send("early");
    h.last().open();
    h.socket.send("presence");
    expect(h.last().sent).toEqual(["presence"]);
  });
});
