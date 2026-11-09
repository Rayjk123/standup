import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { DocsChangedPayload, HelloOkPayload, Snapshot, WsMessage } from "@standup/shared";
import { DEFAULT_CATCH_UP_INTERVAL_MS } from "./hooks/catchUp";

/*
 * docs:changed frames are addressed to the owner and never replayed, so App
 * hands each one to the Docs tab and tells it to re-read on every hello-ok,
 * seq gap and visible-page catch-up.
 */

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
let docsUpdates: typeof import("./lib/docsUpdates");

/** The live socket the console dials: records every instance so a test can push frames into the newest. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
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

const LIST_ROUTES = [
  "/api/projects",
  "/api/sessions",
  "/api/checkpoints",
  "/api/asks/pending",
  "/api/expert/exchanges",
  "/api/launches",
  "/api/tickets",
  "/api/task-runs",
  "/api/review-findings",
];

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/reviews/pending-count") return json({ count: 0 });
    if (path === "/api/reviews") return json({ reviews: [] });
    if (path === "/api/docs/tree") return json({ folders: [], docs: [], assets: [] });
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

function frame(type: string, payload: unknown, seq?: number): WsMessage {
  return { type, payload, timestamp: new Date().toISOString(), ...(seq === undefined ? {} : { seq }) } as WsMessage;
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
  docsUpdates = await import("./lib/docsUpdates");
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
let heard: (DocsChangedPayload | null)[] = [];
let unsubscribe: () => void = () => {};

afterEach(async () => {
  unsubscribe();
  await act(() => root.unmount());
  host.remove();
  FakeSocket.instances = [];
  heard = [];
  (await import("./lib/pipelineUpdates")).setPipelineViewer(null);
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

function socket(): FakeSocket {
  const current = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!current) throw new Error("App opened no socket");
  return current;
}

/** Mounts the console listening for docs updates, opens its socket and boots it from an empty snapshot. */
async function boot(): Promise<FakeSocket> {
  unsubscribe = docsUpdates.subscribeDocsUpdates((change) => heard.push(change));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter } = router;
  await act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(App))));
  const ws = socket();
  const hello: HelloOkPayload = { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e1" };
  await act(async () => {
    ws.open();
    ws.push(frame("hello-ok", hello));
  });
  await settle();
  return ws;
}

describe("App docs wiring", () => {
  test("hello-ok tells the Docs tab to re-read", async () => {
    const ws = await boot();
    // The catch-up also runs at mount; a later hello-ok (a fresh connection's snapshot) must re-read on its own.
    heard = [];
    const hello: HelloOkPayload = { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e2" };
    await act(async () => ws.push(frame("hello-ok", hello)));
    expect(heard).toEqual([null]);
  });

  test("a docs:changed frame reaches the Docs tab as it came", async () => {
    const ws = await boot();
    heard = [];
    const change: DocsChangedPayload = { tree: false, docId: "d1", revision: 4 };
    await act(async () => ws.push(frame("docs:changed", change)));
    expect(heard).toContainEqual(change);
  });

  test("a seq gap re-reads the Docs tab", async () => {
    const ws = await boot();
    heard = [];
    await act(async () => ws.push(frame("projects:updated", [], 7)));
    await settle();
    expect(heard).toContain(null);
  });

  test("the visible-page catch-up re-reads the Docs tab while the socket is silent", async () => {
    await boot();
    heard = [];
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    const deadline = Date.now() + DEFAULT_CATCH_UP_INTERVAL_MS + 1_000;
    while (!heard.includes(null) && Date.now() < deadline) await settle();
    expect(heard).toContain(null);
  });
});
