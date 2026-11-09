import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { FIXTURE_NOW, fixtureSummaries, pendingSummaries } from "./review-fixtures";

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
let ReviewList: typeof import("./ReviewList").ReviewList;

const realFetch = globalThis.fetch;
let requested: string[] = [];
let respond: (url: string) => unknown = () => ({ reviews: [] });

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    return new Response(JSON.stringify(respond(url)), { headers: { "content-type": "application/json" } });
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
  ({ ReviewList } = await import("./ReviewList"));
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
  requested = [];
});

async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
}

async function renderList(selected: string[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() =>
    root.render(createElement(ReviewList, { onSelect: (id: string) => selected.push(id), now: FIXTURE_NOW }))
  );
  await settle();
}

function cards(): HTMLElement[] {
  return [...host.querySelectorAll("[data-testid=review-card]")] as HTMLElement[];
}

describe("ReviewList", () => {
  test("fetches pending packets and renders title, ref, age, status badge and media counts", async () => {
    respond = (url) => ({ reviews: url.includes("status=all") ? fixtureSummaries : pendingSummaries });
    await renderList();
    expect(requested).toEqual(["/api/reviews?status=pending"]);
    expect(cards()).toHaveLength(2);
    const first = cards()[0];
    expect(first.textContent).toContain("Add the Review tab for human sign-off");
    expect(first.textContent).toContain("standup/review-tab@9c41f2e");
    expect(first.textContent).toContain("12m ago");
    expect(first.querySelector("[data-status=pending]")?.textContent).toBe("Pending");
    expect(first.querySelector("[data-testid=review-image-count]")?.textContent).toBe("3");
    expect(first.querySelector("[data-testid=review-video-count]")?.textContent).toBe("1");
    // A packet with no video shows no video count.
    expect(cards()[1].querySelector("[data-testid=review-video-count]")).toBeNull();
  });

  test("the All filter refetches with status=all and shows every status", async () => {
    respond = (url) => ({ reviews: url.includes("status=all") ? fixtureSummaries : pendingSummaries });
    await renderList();
    const all = [...host.querySelectorAll("button")].find((b) => b.textContent === "All")!;
    await act(() => all.click());
    await settle();
    expect(requested).toContain("/api/reviews?status=all");
    expect(all.getAttribute("aria-pressed")).toBe("true");
    const statuses = [...host.querySelectorAll("[data-status]")].map((el) => el.getAttribute("data-status"));
    expect(statuses).toEqual(["pending", "pending", "changes_requested", "approved", "superseded"]);
  });

  test("clicking a card selects it", async () => {
    respond = () => ({ reviews: pendingSummaries });
    const selected: string[] = [];
    await renderList(selected);
    await act(() => cards()[1].click());
    expect(selected).toEqual(["rp-19d0b4"]);
  });

  test("an empty queue says nothing is waiting", async () => {
    respond = () => ({ reviews: [] });
    await renderList();
    expect(cards()).toHaveLength(0);
    expect(host.querySelector("[data-testid=review-list-empty]")?.textContent).toContain("No reviews are waiting on you");
  });

  test("a failed fetch shows the server's error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "reviews unavailable" }), { status: 503 })) as unknown as typeof fetch;
    try {
      await renderList();
      expect(host.querySelector("[role=alert]")?.textContent).toContain("reviews unavailable");
    } finally {
      stubFetch();
    }
  });
});
