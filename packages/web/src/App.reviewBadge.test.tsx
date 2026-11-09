import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { HelloOkPayload, ReviewPacketSummary, Snapshot, WsMessage } from "@standup/shared";
import { pendingSummaries } from "./components/review/review-fixtures";
import { DEFAULT_CATCH_UP_INTERVAL_MS } from "./hooks/catchUp";

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
  push(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

// The pending-review count and packet list the stubbed collector reports.
let pendingCount = 0;
let reviewList: ReviewPacketSummary[] = [];

// Collections the console lists; every other read answers an empty object.
const LIST_ROUTES = [
  "/api/projects",
  "/api/sessions",
  "/api/checkpoints",
  "/api/asks/pending",
  "/api/launches",
  "/api/tickets",
  "/api/task-runs",
  "/api/review-findings",
];

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("?")[0];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/reviews/pending-count") return json({ count: pendingCount });
    if (path === "/api/reviews") return json({ reviews: reviewList });
    if (LIST_ROUTES.includes(path)) return json([]);
    if (path.startsWith("/api/persona")) return json({ error: "not found" }, 404);
    return json({});
  }) as typeof fetch;
}

const emptySnapshot: Snapshot = {
  projects: [],
  sessions: [],
  checkpoints: [],
  asks: [],
  launches: [],
  tickets: [],
  actors: [],
};

function frame(type: string, payload: unknown): WsMessage {
  return { type, payload, timestamp: new Date().toISOString() } as WsMessage;
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
  // App sets the shared pipeline viewer from its hello-ok; other files expect it unset.
  (await import("./lib/pipelineUpdates")).setPipelineViewer(null);
  FakeSocket.instances = [];
  pendingCount = 0;
  reviewList = [];
  // App records the hello-ok viewer module-wide; later files' views would ignore frames addressed to anyone else.
  (await import("./lib/pipelineUpdates")).setPipelineViewer(null);
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

function badge(): string | null {
  return host.querySelector('[data-testid="review-tab-badge"]')?.textContent ?? null;
}

// Polls until the badge reads `expected`, then returns what it last read.
async function badgeSettlesTo(expected: string | null, timeoutMs = 1000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (badge() !== expected && Date.now() < deadline) await settle();
  return badge();
}

function socket(): FakeSocket {
  const current = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!current) throw new Error("App opened no socket");
  return current;
}

// Mounts the console, opens its socket and boots it from an empty snapshot.
async function boot(path = "/"): Promise<FakeSocket> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter } = router;
  await act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))));
  const ws = socket();
  const hello: HelloOkPayload = { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e1" };
  await act(async () => {
    ws.open();
    ws.push(frame("hello-ok", hello));
  });
  await settle();
  return ws;
}

describe("App docs tab badge", () => {
  test("shows while unsaved doc text is held, and goes once it is dismissed", async () => {
    const { holdUnsavedDoc, dismissUnsavedDoc, unsavedDocs, clearUnsavedDocs } = await import("./lib/unsavedDocs");
    clearUnsavedDocs();
    await boot();
    const docsBadge = () => host.querySelector('[data-testid="docs-tab-badge"]')?.textContent ?? null;
    expect(docsBadge()).toBeNull();
    await act(async () => {
      holdUnsavedDoc({ docId: "d1", name: "a.md", text: "A", reason: "conflict", message: "" });
      holdUnsavedDoc({ docId: "d2", name: "b.md", text: "B", reason: "error", message: "offline" });
    });
    expect(docsBadge()).toBe("2");
    await act(async () => {
      for (const u of unsavedDocs()) dismissUnsavedDoc(u.id);
    });
    expect(docsBadge()).toBeNull();
  });
});

describe("App review tab badge", () => {
  test("a reviews:pending frame sets the badge live, and a zero count clears it", async () => {
    const ws = await boot();
    expect(badge()).toBeNull();

    // The stubbed collector still reports zero: the badge reads the frame's count.
    await act(async () => ws.push(frame("reviews:pending", { count: 3 })));
    expect(await badgeSettlesTo("3")).toBe("3");

    await act(async () => ws.push(frame("reviews:pending", { count: 0 })));
    expect(await badgeSettlesTo(null)).toBeNull();
  });

  test("a reviews:pending frame re-reads an open Review list", async () => {
    const ws = await boot("/review");
    await settle();
    expect(host.querySelectorAll('[data-testid="review-card"]').length).toBe(0);

    reviewList = pendingSummaries.slice(0, 1);
    await act(async () => ws.push(frame("reviews:pending", { count: 1 })));
    const deadline = Date.now() + 1000;
    while (host.querySelectorAll('[data-testid="review-card"]').length === 0 && Date.now() < deadline) await settle();
    expect(host.querySelectorAll('[data-testid="review-card"]').length).toBe(1);
  });

  test("the visible-page catch-up re-reads the pending count while the socket is silent", async () => {
    await boot();
    expect(badge()).toBeNull();

    // The console catches up at mount too, so a focus right after boot may
    // fall inside the minimum gap between runs; the catch-up's own interval
    // (DEFAULT_CATCH_UP_INTERVAL_MS) reads the count within one more tick.
    pendingCount = 2;
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    expect(await badgeSettlesTo("2", DEFAULT_CATCH_UP_INTERVAL_MS + 1_000)).toBe("2");
  });
});
