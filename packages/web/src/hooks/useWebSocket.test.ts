import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { HelloOkPayload, WsMessage } from "@standup/shared";
import {
  helloAction,
  isSeqGap,
  reconnectPlan,
  resolveWsUrl,
  SERVICE_RESTART_CLOSE,
  SERVICE_RESTART_RECONNECT_MAX_MS,
  SERVICE_RESTART_RECONNECT_MIN_MS,
  useWebSocket,
  wsUrlWithCursor,
} from "./useWebSocket.js";

function hello(fields: { serverSeq: number; epoch?: string; resumed?: boolean }): HelloOkPayload {
  return { protocolVersion: 1, user: "alice", snapshot: {}, ...fields } as unknown as HelloOkPayload;
}

describe("isSeqGap", () => {
  test("no gap before the first hello-ok establishes a baseline", () => {
    // lastSeq is null until hello-ok lands; any incoming seq is accepted.
    expect(isSeqGap(null, 1)).toBe(false);
    expect(isSeqGap(null, 999)).toBe(false);
  });

  test("the very next seq is contiguous, not a gap", () => {
    expect(isSeqGap(5, 6)).toBe(false);
  });

  test("a seq more than one past the last is a gap → refresh", () => {
    expect(isSeqGap(5, 7)).toBe(true);
    expect(isSeqGap(5, 50)).toBe(true);
  });

  test("a repeated seq is a duplicate delivery, not a gap", () => {
    expect(isSeqGap(5, 5)).toBe(false);
  });

  test("a seq below the last is a gap: the server's counter restarted", () => {
    // Seqs only climb within an epoch, so a lower one means a new epoch began
    // on a connection that never got its hello-ok snapshot.
    expect(isSeqGap(5, 4)).toBe(true);
    expect(isSeqGap(40, 1)).toBe(true);
  });

  test("serverSeq baseline of 0 then first broadcast (1) is contiguous", () => {
    // A fresh server run starts at seq 0; hello-ok reports serverSeq 0 and the
    // first stamped broadcast is seq 1 — no gap on a clean start.
    expect(isSeqGap(0, 1)).toBe(false);
    expect(isSeqGap(0, 2)).toBe(true);
  });
});

describe("resolveWsUrl", () => {
  test("local http page → ws:// on the same host:port at /ws", () => {
    // Vite dev origin; the /ws path is proxied to the collector's WS port.
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/ws"
    );
  });

  test("https page → wss:// so a secure origin isn't downgraded", () => {
    // Reached through a tunnel host on a teammate's machine: the socket
    // follows the tunnel host, and https implies wss (browsers block ws on an
    // https page as mixed content).
    expect(
      resolveWsUrl({ protocol: "https:", host: "alias.tunnels.example.com" })
    ).toBe("wss://alias.tunnels.example.com/ws");
  });

  test("host is preserved verbatim, never a hardcoded localhost", () => {
    // The whole point: a remote host must not resolve to the visitor's own
    // loopback, so whatever host served the page is exactly what's dialed.
    expect(resolveWsUrl({ protocol: "http:", host: "10.0.0.4:5173" })).toBe(
      "ws://10.0.0.4:5173/ws"
    );
  });
});

describe("wsUrlWithCursor", () => {
  const base = "ws://localhost:5173/ws";

  test("no cursor before the first hello-ok → the plain base", () => {
    expect(wsUrlWithCursor(base, { epoch: null, lastSeq: null })).toBe(base);
  });

  test("half a cursor is no cursor", () => {
    // An old server sends no epoch; a seq alone can't be resumed.
    expect(wsUrlWithCursor(base, { epoch: null, lastSeq: 12 })).toBe(base);
    expect(wsUrlWithCursor(base, { epoch: "e1", lastSeq: null })).toBe(base);
  });

  test("epoch and lastSeq → ?epoch=&since=, including seq 0", () => {
    expect(wsUrlWithCursor(base, { epoch: "e1", lastSeq: 12 })).toBe(`${base}?epoch=e1&since=12`);
    expect(wsUrlWithCursor(base, { epoch: "e1", lastSeq: 0 })).toBe(`${base}?epoch=e1&since=0`);
  });

  test("the epoch is URL-encoded and an existing query is extended", () => {
    expect(wsUrlWithCursor(`${base}?x=1`, { epoch: "a b&c", lastSeq: 3 })).toBe(
      `${base}?x=1&epoch=a%20b%26c&since=3`
    );
  });
});

describe("reconnectPlan", () => {
  test("a service-restart close re-dials fast and resets the attempt count", () => {
    expect(reconnectPlan(SERVICE_RESTART_CLOSE, 5, () => 0)).toEqual({
      delayMs: SERVICE_RESTART_RECONNECT_MIN_MS,
      attempts: 0,
    });
  });

  test("a service-restart re-dial is jittered across the restart window", () => {
    // Every tab gets the same 1012 at once; spreading the re-dials keeps them
    // from landing on the fresh leader in one burst.
    expect(SERVICE_RESTART_RECONNECT_MIN_MS).toBe(100);
    expect(SERVICE_RESTART_RECONNECT_MAX_MS).toBe(750);
    expect(reconnectPlan(SERVICE_RESTART_CLOSE, 0, () => 0.5).delayMs).toBe(425);
    const top = reconnectPlan(SERVICE_RESTART_CLOSE, 0, () => 0.9999).delayMs;
    expect(top).toBeLessThan(SERVICE_RESTART_RECONNECT_MAX_MS);
    expect(top).toBeGreaterThan(740);
  });

  test("any other close climbs the backoff curve", () => {
    expect(reconnectPlan(1006, 0, () => 0)).toEqual({ delayMs: 500, attempts: 1 });
    expect(reconnectPlan(1000, 2, () => 0)).toEqual({ delayMs: 2000, attempts: 3 });
    expect(reconnectPlan(1006, 50, () => 1)).toEqual({ delayMs: 30000, attempts: 51 });
  });
});

describe("helloAction", () => {
  test("resumed and a cursor was sent → resume", () => {
    expect(helloAction(hello({ serverSeq: 7, epoch: "e1", resumed: true }), true)).toBe("resume");
  });

  test("not resumed → snapshot, cursor or not", () => {
    expect(helloAction(hello({ serverSeq: 7, epoch: "e2" }), true)).toBe("snapshot");
    expect(helloAction(hello({ serverSeq: 7, epoch: "e2", resumed: false }), true)).toBe("snapshot");
  });

  test("resumed without a cursor → snapshot (nothing to resume onto)", () => {
    expect(helloAction(hello({ serverSeq: 7, epoch: "e1", resumed: true }), false)).toBe("snapshot");
  });
});

// ---------------------------------------------------------------------------
// The hook end to end: happy-dom + a fake WebSocket the test drives by hand.
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1005 });
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code: number) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before it loads.
const domWindow = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event"] as const;
const saved = new Map<string, unknown>();
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (domWindow as unknown as Record<string, unknown>)[name];
  }
  saved.set("WebSocket", globalThis.WebSocket);
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await domWindow.happyDOM.close();
});

const BASE = "ws://localhost:5173/ws";
type HookState = ReturnType<typeof useWebSocket>;

interface Harness {
  state: () => HookState;
  hellos: HelloOkPayload[];
  resumes: HelloOkPayload[];
  messages: WsMessage[];
  gaps: number;
  unmount: () => Promise<void>;
}

let mounted: Harness | null = null;
let silenced: Array<["log" | "error", (...args: unknown[]) => void]> = [];

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  // The hook logs every connect and close; keep the test output readable.
  silenced = (["log", "error"] as const).map((k) => [k, console[k]]);
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  if (mounted) await mounted.unmount();
  mounted = null;
  jest.useRealTimers();
  for (const [k, fn] of silenced) console[k] = fn;
});

async function mountHook(): Promise<Harness> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let latest: HookState | undefined;
  const h: Harness = {
    state: () => latest!,
    hellos: [],
    resumes: [],
    messages: [],
    gaps: 0,
    unmount: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
  function Probe() {
    latest = useWebSocket(BASE, {
      onMessage: (m) => h.messages.push(m),
      onHello: (p) => h.hellos.push(p),
      onResume: (p) => h.resumes.push(p),
      onGap: () => h.gaps++,
    });
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  mounted = h;
  return h;
}

const sockets = () => FakeWebSocket.instances;
const last = () => sockets()[sockets().length - 1]!;
const frame = (seq: number): WsMessage => ({ type: "checkpoint:new", payload: { id: `c${seq}` }, seq }) as unknown as WsMessage;

async function advance(ms: number) {
  await act(() => {
    jest.advanceTimersByTime(ms);
  });
}

/** Opens the current socket and answers a full-snapshot hello-ok. */
async function handshake(serverSeq: number, epoch = "e1", extra: { resumed?: boolean } = {}) {
  const ws = last();
  await act(() => {
    ws.open();
    ws.receive({ type: "hello-ok", payload: hello({ serverSeq, epoch, ...extra }) });
  });
}

describe("useWebSocket — reconnect cursor", () => {
  test("the first connect is plain; a reconnect carries epoch + last seq", async () => {
    await mountHook();
    expect(sockets()).toHaveLength(1);
    expect(sockets()[0]!.url).toBe(BASE);

    await handshake(5);
    await act(() => {
      last().receive(frame(6));
      last().receive(frame(7));
    });
    await act(() => last().serverClose(1006));
    await advance(1000);

    expect(sockets()).toHaveLength(2);
    expect(sockets()[1]!.url).toBe(`${BASE}?epoch=e1&since=7`);
  });

  test("a socket that fails before any hello-ok re-dials plain", async () => {
    await mountHook();
    await act(() => last().serverClose(1006));
    await advance(1000);
    expect(sockets()).toHaveLength(2);
    expect(sockets()[1]!.url).toBe(BASE);
  });
});

describe("useWebSocket — close-code policy", () => {
  test("1012 re-dials within the jittered restart window", async () => {
    await mountHook();
    await handshake(0);
    await act(() => last().serverClose(SERVICE_RESTART_CLOSE));
    await advance(SERVICE_RESTART_RECONNECT_MIN_MS - 1);
    expect(sockets()).toHaveLength(1);
    await advance(SERVICE_RESTART_RECONNECT_MAX_MS - SERVICE_RESTART_RECONNECT_MIN_MS + 1);
    expect(sockets()).toHaveLength(2);
  });

  test("a socket that opens but drops before hello-ok keeps backing off", async () => {
    await mountHook();
    await handshake(0);
    // Attempt 1 (500ms–1s), then an open that never handshakes: the count is
    // kept, so the next drop waits attempt 2's 1–2s, not attempt 1's again.
    await act(() => last().serverClose(1006));
    await advance(1000);
    expect(sockets()).toHaveLength(2);
    await act(() => last().open());
    await act(() => last().serverClose(1006));
    await advance(999);
    expect(sockets()).toHaveLength(2);
    await advance(1001);
    expect(sockets()).toHaveLength(3);
  });

  test("1012 resets the attempt count built by earlier failures", async () => {
    await mountHook();
    // Two failed dials: attempt 1 (≤1s), attempt 2 (≤2s).
    await act(() => last().serverClose(1006));
    await advance(1000);
    await act(() => last().serverClose(1006));
    await advance(2000);
    expect(sockets()).toHaveLength(3);
    // A restart close, then one more failure: back to attempt 1's ≤1s window,
    // not attempt 3's 2–4s.
    await act(() => last().serverClose(SERVICE_RESTART_CLOSE));
    await advance(SERVICE_RESTART_RECONNECT_MAX_MS);
    expect(sockets()).toHaveLength(4);
    await act(() => last().serverClose(1006));
    await advance(1000);
    expect(sockets()).toHaveLength(5);
  });

  test("a normal close backs off (≥500ms on the first attempt)", async () => {
    await mountHook();
    await handshake(0);
    await act(() => last().serverClose(1006));
    await advance(499);
    expect(sockets()).toHaveLength(1);
    await advance(501);
    expect(sockets()).toHaveLength(2);
  });

  test("unmounting never schedules a re-dial", async () => {
    const h = await mountHook();
    await handshake(0);
    await h.unmount();
    mounted = null;
    await advance(60_000);
    expect(sockets()).toHaveLength(1);
  });
});

describe("useWebSocket — resumed hello-ok", () => {
  test("resumed → onResume, not onHello; replayed frames apply and gaps still detect", async () => {
    const h = await mountHook();
    await handshake(5);
    await act(() => last().receive(frame(6)));
    expect(h.hellos).toHaveLength(1);

    await act(() => last().serverClose(SERVICE_RESTART_CLOSE));
    await advance(SERVICE_RESTART_RECONNECT_MAX_MS);
    expect(last().url).toBe(`${BASE}?epoch=e1&since=6`);
    await handshake(6, "e1", { resumed: true });

    expect(h.hellos).toHaveLength(1);
    expect(h.resumes).toHaveLength(1);
    expect(h.resumes[0]!.serverSeq).toBe(6);

    // Replayed frames continue the run from `since`: no gap.
    await act(() => {
      last().receive(frame(7));
      last().receive(frame(8));
    });
    expect(h.messages.map((m) => m.seq)).toEqual([6, 7, 8]);
    expect(h.gaps).toBe(0);

    // A later dropped broadcast is still caught.
    await act(() => last().receive(frame(10)));
    expect(h.gaps).toBe(1);
  });

  test("a new epoch after a restart → full snapshot via onHello", async () => {
    const h = await mountHook();
    await handshake(40, "e1");
    await act(() => last().serverClose(SERVICE_RESTART_CLOSE));
    await advance(SERVICE_RESTART_RECONNECT_MAX_MS);
    await handshake(0, "e2");

    expect(h.hellos).toHaveLength(2);
    expect(h.resumes).toHaveLength(0);
    // The baseline follows the new epoch: its seq 1 is contiguous.
    await act(() => last().receive(frame(1)));
    expect(h.gaps).toBe(0);
    await act(() => last().serverClose(1006));
    await advance(1000);
    expect(last().url).toBe(`${BASE}?epoch=e2&since=1`);
  });

  test("a frame below the last seq (new epoch, no hello-ok) → onGap, and it becomes the baseline", async () => {
    const h = await mountHook();
    await handshake(40, "e1");
    await act(() => last().receive(frame(41)));
    expect(h.gaps).toBe(0);
    await act(() => last().receive(frame(1)));
    expect(h.gaps).toBe(1);
    expect(h.messages.map((m) => m.seq)).toEqual([41, 1]);
    // The new counter continues contiguously from there.
    await act(() => last().receive(frame(2)));
    expect(h.gaps).toBe(1);
  });

  test("a duplicate of the last seq is not a gap", async () => {
    const h = await mountHook();
    await handshake(5);
    await act(() => {
      last().receive(frame(6));
      last().receive(frame(6));
    });
    expect(h.gaps).toBe(0);
  });

  test("resumed on a connection that sent no cursor → treated as a snapshot", async () => {
    const h = await mountHook();
    await handshake(3, "e1", { resumed: true });
    expect(h.hellos).toHaveLength(1);
    expect(h.resumes).toHaveLength(0);
  });
});

describe("useWebSocket — connection state", () => {
  test("downSince: mount time → null on hello-ok → first failure, held across retries → null", async () => {
    const t0 = Date.now();
    const h = await mountHook();
    expect(h.state().isConnected).toBe(false);
    expect(h.state().downSince).toBe(t0);

    await advance(300);
    await handshake(0);
    expect(h.state().isConnected).toBe(true);
    expect(h.state().downSince).toBeNull();

    await advance(1000);
    const down = Date.now();
    await act(() => last().serverClose(1006));
    expect(h.state().isConnected).toBe(false);
    expect(h.state().downSince).toBe(down);

    // A failed re-dial keeps the outage's start, not the latest failure.
    await advance(1000);
    await act(() => last().serverClose(1006));
    expect(h.state().downSince).toBe(down);

    // A socket that opens but drops before its hello-ok doesn't end the outage.
    await advance(2000);
    await act(() => last().open());
    expect(h.state().isConnected).toBe(true);
    expect(h.state().downSince).toBe(down);
    await act(() => last().serverClose(1006));
    expect(h.state().downSince).toBe(down);

    await advance(4000);
    await handshake(0);
    expect(h.state().isConnected).toBe(true);
    expect(h.state().downSince).toBeNull();
  });

  test("downSince clears on a resumed hello-ok too", async () => {
    const h = await mountHook();
    await handshake(5);
    await act(() => last().serverClose(SERVICE_RESTART_CLOSE));
    expect(h.state().downSince).not.toBeNull();
    await advance(SERVICE_RESTART_RECONNECT_MAX_MS);
    await act(() => last().open());
    expect(h.state().downSince).not.toBeNull();
    await act(() => last().receive({ type: "hello-ok", payload: hello({ serverSeq: 5, epoch: "e1", resumed: true }) }));
    expect(h.resumes).toHaveLength(1);
    expect(h.state().downSince).toBeNull();
  });

  test("send reaches only an open socket", async () => {
    const h = await mountHook();
    h.state().send("early");
    await act(() => last().open());
    h.state().send("hi");
    expect(last().sent).toEqual(["hi"]);
  });
});
