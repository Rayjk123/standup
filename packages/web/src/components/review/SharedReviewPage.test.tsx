import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ShareState, SharedReviewPacket } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { fixtureDetail } from "./review-fixtures";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Text",
  "Event",
  "KeyboardEvent",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let SharedReviewPage: typeof import("./SharedReviewPage").SharedReviewPage;
let ReviewDetail: typeof import("./ReviewDetail").ReviewDetail;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ SharedReviewPage } = await import("./SharedReviewPage"));
  ({ ReviewDetail } = await import("./ReviewDetail"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  globalThis.fetch = savedFetch;
});

async function render(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(element));
}

const q = (id: string) => host.querySelector(`[data-testid=${id}]`) as HTMLElement | null;
const OFF: ShareState = { enabled: false, path: null };
const TOKEN = "T".repeat(43);

describe("the owner's review page", () => {
  test("shows the share toggle only when the read carries share state", async () => {
    await render(createElement(ReviewDetail, { review: { ...fixtureDetail, share: OFF } }));
    expect(q("share")).not.toBeNull();
    expect(q("share-switch")?.getAttribute("aria-label")).toContain("review");
    await act(() => root.unmount());
    host.remove();
    await render(createElement(ReviewDetail, { review: fixtureDetail }));
    expect(q("share")).toBeNull();
  });
});

const SHARED: SharedReviewPacket = {
  title: "Shared title",
  intent: "Why it matters",
  changes: [{ area: "Area A", bullets: ["did a thing"], files: ["src/a.ts"] }],
  validation: { samples: [{ label: "sample", input: "in", output: "out" }] },
  media: [{ id: "m1", kind: "image", mime: "image/png", caption: "shot", position: 0, url: `/api/share/reviews/${TOKEN}/media/m1` }],
};

function stubFetch(status: number, body: unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

describe("SharedReviewPage", () => {
  test("shows only the packet's content: no navigation, no actions", async () => {
    const urls = stubFetch(200, { review: SHARED });
    await render(createElement(SharedReviewPage, { token: TOKEN }));
    await act(async () => {});
    expect(urls).toEqual([`/api/share/reviews/${TOKEN}`]);
    expect(q("shared-review")?.querySelector("h1")?.textContent).toBe("Shared title");
    expect(host.textContent).toContain("Why it matters");
    expect(host.textContent).toContain("did a thing");
    expect(host.textContent).toContain("sample");
    expect(host.querySelector("img")?.getAttribute("src")).toBe(SHARED.media[0]!.url);
    // Nothing leads into the console and nothing acts on the review.
    expect(host.querySelectorAll("a, nav")).toHaveLength(0);
    for (const b of host.querySelectorAll("button")) expect(b.getAttribute("aria-label")).toStartWith("Open image");
    expect(host.textContent).not.toMatch(/approve|request changes/i);
    expect(document.head.querySelector("meta[name=referrer]")?.getAttribute("content")).toBe("no-referrer");
  });

  test("an unknown or revoked link shows a bare not-found page", async () => {
    stubFetch(404, { error: "Not found" });
    await render(createElement(SharedReviewPage, { token: TOKEN }));
    await act(async () => {});
    expect(q("shared-review-missing")?.textContent).toContain("404");
    expect(q("shared-review")).toBeNull();
  });

  test("a malformed token never fetches", async () => {
    const urls = stubFetch(200, { review: SHARED });
    await render(createElement(SharedReviewPage, { token: null }));
    await act(async () => {});
    expect(urls).toEqual([]);
    expect(q("shared-review-missing")).not.toBeNull();
  });
});
