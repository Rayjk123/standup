import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { HelloOkPayload, ProjectWithCounts, Session, Snapshot, WsMessage } from "@standup/shared";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before App and react-dom load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Element",
  "Text",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const realWebSocket = (globalThis as Record<string, unknown>).WebSocket;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let App: typeof import("./App").default;
let Console: typeof import("./components/Console").Console;
let router: typeof import("react-router-dom");

/**
 * The live socket the console dials: records every instance so a test can
 * open the newest one and push frames into it.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  push(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

// The collections resyncAll reads, in the order it reads them.
const RESYNC_ROUTES = [
  "/api/projects",
  "/api/sessions",
  "/api/checkpoints",
  "/api/asks/pending",
  "/api/launches",
  "/api/tickets",
];
const LIST_ROUTES = [...RESYNC_ROUTES, "/api/task-runs", "/api/review-findings"];

// Reads per path (query dropped), and the answers a test overrides.
let reads = new Map<string, number>();
let overrides = new Map<string, { status: number; body: unknown }>();

function readsOf(path: string): number {
  return reads.get(path) ?? 0;
}

function personaReads(): number {
  let n = 0;
  for (const [path, count] of reads) if (path.startsWith("/api/persona")) n += count;
  return n;
}

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("?")[0]!;
    reads.set(path, readsOf(path) + 1);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const override = overrides.get(path);
    if (override) return json(override.body, override.status);
    if (path === "/api/reviews/pending-count") return json({ count: 0 });
    if (path === "/api/reviews") return json({ reviews: [] });
    if (LIST_ROUTES.includes(path)) return json([]);
    if (path.startsWith("/api/persona")) return json({ error: "not found" }, 404);
    return json({});
  }) as typeof fetch;
}

const heldSession = {
  id: "s-held",
  projectId: "p1",
  title: "Held session",
  cwd: "/tmp/p1",
  status: "running",
  startedAt: "2026-10-12T00:00:00.000Z",
} as unknown as Session;

const heldProject: ProjectWithCounts = {
  id: "p1",
  name: "Held project",
  repos: ["/tmp/p1"],
  branch: "main",
  knowledgeDocs: 0,
  pendingDrafts: 0,
};

const snapshot: Snapshot = {
  projects: [heldProject],
  sessions: [heldSession],
  checkpoints: [],
  asks: [],
  launches: [],
  tickets: [],
  actors: [],
};

function frame(type: string, payload: unknown, seq?: number): WsMessage {
  return { type, payload, timestamp: new Date().toISOString(), ...(seq === undefined ? {} : { seq }) } as WsMessage;
}

function hello(fields: Partial<HelloOkPayload> = {}): HelloOkPayload {
  return { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot, epoch: "e1", ...fields };
}

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  router = await import("react-router-dom");
  ({ default: App } = await import("./App"));
  ({ Console } = await import("./components/Console"));
  stubFetch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  // App records the hello-ok viewer module-wide; later files' views would ignore frames addressed to anyone else.
  (await import("./lib/pipelineUpdates")).setPipelineViewer(null);
  FakeSocket.instances = [];
  reads = new Map();
  overrides = new Map();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

type ConsoleProps = Parameters<typeof Console>[0];
type Fiber = {
  type: unknown;
  memoizedProps: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
  stateNode?: { current?: Fiber };
};

/** The props App last rendered Console with — the state it holds. */
function consoleProps(): ConsoleProps {
  const key = Object.keys(host).find((k) => k.startsWith("__reactContainer$"));
  if (!key) throw new Error("host holds no React root");
  // The container holds the root fiber it was created with, which after a
  // commit may be the alternate tree; the root's `current` is the committed one.
  const container = (host as unknown as Record<string, Fiber>)[key]!;
  const stack: Fiber[] = [container.stateNode?.current ?? container];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (fiber.type === Console) return fiber.memoizedProps as ConsoleProps;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  throw new Error("Console is not rendered");
}

function socket(): FakeSocket {
  const current = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!current) throw new Error("App opened no socket");
  return current;
}

// Mounts the console, opens its socket, boots it from the snapshot and
// forgets the boot's reads.
async function boot(path = "/"): Promise<FakeSocket> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter } = router;
  await act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))));
  const ws = socket();
  await act(async () => {
    ws.open();
    ws.push(frame("hello-ok", hello()));
  });
  await settle();
  reads = new Map();
  return ws;
}

// Drops the socket and dials the next one at once (a focus wakes it).
async function reconnect(ws: FakeSocket): Promise<FakeSocket> {
  await act(async () => ws.drop());
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
  });
  const next = socket();
  if (next === ws) throw new Error("App did not redial");
  await act(async () => next.open());
  return next;
}

describe("App resync", () => {
  test("a gap resync that meets a 503 leaves the held sessions alone", async () => {
    const ws = await boot();
    expect(consoleProps().sessions).toEqual([heldSession]);

    overrides.set("/api/sessions", { status: 503, body: { error: "collector draining" } });
    await act(async () => ws.push(frame("checkpoint:new", { id: "c-gap" }, 5)));
    await settle();

    expect(readsOf("/api/sessions")).toBe(1);
    expect(consoleProps().sessions).toEqual([heldSession]);
  });

  test("an error body from a lifecycle refetch leaves the held sessions alone", async () => {
    const ws = await boot();
    overrides.set("/api/sessions", { status: 503, body: { error: "collector draining" } });
    await act(async () => ws.push(frame("session:start", { sessionId: "s-new" })));
    await settle();

    expect(readsOf("/api/sessions")).toBe(1);
    expect(consoleProps().sessions).toEqual([heldSession]);
  });

  test("an error body from a draft-driven projects refetch leaves the held projects alone", async () => {
    const ws = await boot();
    expect(consoleProps().projects).toEqual([heldProject]);
    overrides.set("/api/projects", { status: 503, body: { error: "collector draining" } });
    await act(async () => ws.push(frame("knowledge:draft", { projectId: heldProject.id })));
    await settle();

    expect(readsOf("/api/projects")).toBe(1);
    expect(consoleProps().projects).toEqual([heldProject]);
  });

  test("ten session:status frames in one tick read each collection at most twice", async () => {
    const ws = await boot();
    await act(async () => {
      for (let i = 0; i < 10; i++) ws.push(frame("session:status", { sessionId: heldSession.id }));
    });
    await settle();

    // The first frame's read, plus one trailing read for the other nine.
    expect(readsOf("/api/sessions")).toBe(2);
    expect(readsOf("/api/task-runs")).toBe(2);
  });

  test("ten launch frames in one tick read launches at most twice", async () => {
    const ws = await boot();
    await act(async () => {
      for (let i = 0; i < 10; i++) ws.push(frame("launch:started", { id: `l${i}` }));
    });
    await settle();

    expect(readsOf("/api/launches")).toBe(2);
  });

  test("a frame that lands after the in-flight read still gets a read of its own", async () => {
    const ws = await boot();
    const sessionsAfter: Session = { ...heldSession, id: "s-after", title: "After" };
    // The first read answers the old list; anything read later carries the new session.
    let answered = 0;
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/sessions")) {
        reads.set("/api/sessions", readsOf("/api/sessions") + 1);
        const body = answered++ === 0 ? [heldSession] : [heldSession, sessionsAfter];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return stub(input, init);
    }) as typeof fetch;
    try {
      await act(async () => {
        ws.push(frame("session:status", { sessionId: heldSession.id }));
        ws.push(frame("session:start", { sessionId: sessionsAfter.id }));
      });
      await settle();
    } finally {
      globalThis.fetch = stub;
    }

    expect(readsOf("/api/sessions")).toBe(2);
    expect(consoleProps().sessions.map((s) => s.id)).toEqual([heldSession.id, sessionsAfter.id]);
  });

  test("a seq-gap frame runs exactly one round of the resync reads", async () => {
    const ws = await boot();
    await act(async () => ws.push(frame("checkpoint:new", { id: "c-gap" }, 5)));
    await settle();

    for (const path of RESYNC_ROUTES) expect({ path, reads: readsOf(path) }).toEqual({ path, reads: 1 });
  });

  test("a resumed hello-ok reads what the replay never carries, but not sessions", async () => {
    const ws = await boot();
    const next = await reconnect(ws);
    expect(next.url).toContain("epoch=e1");
    // The drop and the focus run the catch-up, which reads the pending count
    // and Persona on its own; count only what the resumed hello-ok reads.
    await settle();
    reads = new Map();
    await act(async () => next.push(frame("hello-ok", hello({ resumed: true, snapshot: undefined }))));
    await settle();

    expect(readsOf("/api/task-runs")).toBeGreaterThanOrEqual(1);
    expect(readsOf("/api/review-findings")).toBeGreaterThanOrEqual(1);
    expect(readsOf("/api/reviews/pending-count")).toBeGreaterThanOrEqual(1);
    expect(personaReads()).toBeGreaterThanOrEqual(1);
    expect(readsOf("/api/sessions")).toBe(0);
  });

  test("the first snapshot hello-ok leaves the signals; a second one bumps them", async () => {
    const ws = await boot();
    const first = consoleProps();
    expect(first.planSignal).toBe(0);
    expect(first.scheduleSignal).toBe(0);
    expect(first.lastEvent.n).toBe(0);
    expect(first.draftSignal.n).toBe(0);

    const next = await reconnect(ws);
    await act(async () => next.push(frame("hello-ok", hello({ epoch: "e2" }))));
    await settle();

    const second = consoleProps();
    expect(second.planSignal).toBe(1);
    expect(second.scheduleSignal).toBe(1);
    expect(second.lastEvent).toEqual({ sessionId: "*", n: 1 });
    expect(second.draftSignal).toEqual({ projectId: "*", n: 1 });
  });
});
