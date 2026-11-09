import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { DETAIL_ID, fixtureDetail, pendingSummaries } from "./review-fixtures";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "Element",
  "Text",
  "Event",
  "KeyboardEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let ReviewView: typeof import("./ReviewView").ReviewView;
let router: typeof import("react-router-dom");
let publishReviewUpdate: typeof import("../../lib/reviewUpdates").publishReviewUpdate;
let publishReviewResync: typeof import("../../lib/reviewUpdates").publishReviewResync;

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];
let decideResponse: { status: number; body: unknown } | null = null;

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && decideResponse) return json(decideResponse.body, decideResponse.status);
    if (method === "POST") {
      const status = url.endsWith("/approve") ? "approved" : "changes_requested";
      return json({ review: { ...fixtureDetail, status, decidedBy: "sam", decidedAt: fixtureDetail.updatedAt } });
    }
    if (url.startsWith("/api/reviews?")) return json({ reviews: pendingSummaries });
    if (url === `/api/reviews/${DETAIL_ID}`) return json({ review: fixtureDetail });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
}

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  router = await import("react-router-dom");
  ({ ReviewView } = await import("./ReviewView"));
  ({ publishReviewUpdate, publishReviewResync } = await import("../../lib/reviewUpdates"));
  stubFetch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  calls = [];
  decideResponse = null;
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

async function renderAt(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter, Routes, Route } = router;
  await act(() =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Routes, null, createElement(Route, { path: "/review/:id?", element: createElement(ReviewView) }))
      )
    )
  );
  await settle();
}

function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
}

async function type(value: string) {
  const el = host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  await act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}

describe("ReviewView", () => {
  test("shows the list beside the packet named in the path", async () => {
    await renderAt(`/review/${DETAIL_ID}`);
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(["/api/reviews?status=pending", `/api/reviews/${DETAIL_ID}`]));
    expect(host.querySelectorAll("[data-testid=review-card]")).toHaveLength(2);
    expect(host.querySelector("[data-testid=review-detail] h2")?.textContent).toBe(fixtureDetail.title);
  });

  test("Approve POSTs the comment to the packet's approve route and shows the decided packet", async () => {
    await renderAt(`/review/${DETAIL_ID}`);
    await type("Ship it");
    calls = [];
    await act(async () => button("Approve").click());
    await settle();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/reviews/${DETAIL_ID}/approve`);
    expect(post.body).toEqual({ comment: "Ship it" });
    // The list refetches after the decision, and the bar goes away.
    expect(calls.some((c) => c.url === "/api/reviews?status=pending")).toBe(true);
    expect(host.querySelector("[data-testid=decision-bar]")).toBeNull();
    expect(host.querySelector("[data-testid=review-detail] [data-status=approved]")).not.toBeNull();
  });

  test("Request changes POSTs to request-changes with the required comment", async () => {
    await renderAt(`/review/${DETAIL_ID}`);
    await type("Pin the bar on phones");
    await act(async () => button("Request changes").click());
    await settle();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/reviews/${DETAIL_ID}/request-changes`);
    expect(post.body).toEqual({ comment: "Pin the bar on phones" });
  });

  test("a refused decision surfaces the collector's error in the bar", async () => {
    decideResponse = { status: 409, body: { error: "packet is no longer pending" } };
    await renderAt(`/review/${DETAIL_ID}`);
    await act(async () => button("Approve").click());
    await settle();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({});
    expect(host.querySelector("[data-testid=decision-bar] [role=alert]")?.textContent).toBe("packet is no longer pending");
  });

  test("a review:updated frame refetches the list and the open packet", async () => {
    await renderAt(`/review/${DETAIL_ID}`);
    calls = [];
    await act(() => publishReviewUpdate({ packetId: DETAIL_ID, owner: "owner", status: "superseded" }));
    await settle();
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("/api/reviews?status=pending");
    expect(urls).toContain(`/api/reviews/${DETAIL_ID}`);
  });

  test("a resync (a reconnect: frames sent while down are gone) refetches the list and the open packet", async () => {
    await renderAt(`/review/${DETAIL_ID}`);
    calls = [];
    await act(() => publishReviewResync());
    await settle();
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("/api/reviews?status=pending");
    expect(urls).toContain(`/api/reviews/${DETAIL_ID}`);
  });

  test("an unknown packet shows the not-found error", async () => {
    await renderAt("/review/rp-missing");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("not found");
  });
});
