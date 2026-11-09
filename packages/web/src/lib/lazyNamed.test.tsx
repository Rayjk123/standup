import { afterAll, beforeAll, expect, test } from "bun:test";
import { createElement, Suspense, type ComponentType } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before it loads.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => unknown) => Promise<void>;
let createRoot: (el: Element) => Root;
let lazyNamed: typeof import("./lazyNamed").lazyNamed;
let MAX_FAILED_CYCLES: number;
let ViewBoundary: typeof import("../components/ViewBoundary").ViewBoundary;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ lazyNamed, MAX_FAILED_CYCLES } = await import("./lazyNamed"));
  ({ ViewBoundary } = await import("../components/ViewBoundary"));
});

afterAll(() => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  window.close();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 5)));
};

/** Waits up to `ms` for `done()`, letting React settle in between. */
async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await act(() => new Promise((r) => setTimeout(r, 20)));
}

function mount(Lazy: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (resetKey: string) =>
    act(() =>
      root.render(
        createElement(ViewBoundary, {
          resetKey,
          children: createElement(Suspense, { fallback: "loading" }, createElement(Lazy)),
        })
      )
    );
  return { host, render, unmount: () => act(() => root.unmount()) };
}

test("a chunk that keeps failing stops after its retries and reaches the error boundary", async () => {
  let loads = 0;
  const Lazy = lazyNamed(
    async (): Promise<{ View: () => null }> => {
      loads++;
      throw new Error("boom");
    },
    "View",
    { retryDelaysMs: [5, 5] }
  );
  const view = mount(Lazy);
  await view.render("a");
  // An endless retry never shows the error: it keeps suspending and loading.
  await waitUntil(() => view.host.textContent!.includes("couldn't load"), 3000);
  expect(view.host.textContent).toContain("This view couldn't load: boom");
  expect(loads).toBe(3);
  // And it stays stopped: no load in the background.
  await waitUntil(() => false, 300);
  expect(loads).toBe(3);
  await view.unmount();
});

test("resets retry at most MAX_FAILED_CYCLES failed cycles in a row", async () => {
  let loads = 0;
  const Lazy = lazyNamed(
    async (): Promise<{ View: () => null }> => {
      loads++;
      throw new Error("boom");
    },
    "View",
    { retryDelaysMs: [] }
  );
  const view = mount(Lazy);
  for (let i = 0; i < MAX_FAILED_CYCLES + 3; i++) {
    await view.render(`tab-${i}`);
    await settle();
    expect(view.host.textContent).toContain("couldn't load");
  }
  expect(loads).toBe(MAX_FAILED_CYCLES);
  await view.unmount();
});

test("a view stopped at the cap recovers once the browser is back online and its chunk loads", async () => {
  let loads = 0;
  let fail = true;
  const View = () => createElement("p", null, "the view");
  const Lazy = lazyNamed(
    async () => {
      loads++;
      if (fail) throw new Error("boom");
      return { View };
    },
    "View",
    { retryDelaysMs: [] }
  );
  const view = mount(Lazy);
  // Up to the cap: further resets no longer load.
  for (let i = 0; i < MAX_FAILED_CYCLES + 1; i++) {
    await view.render(`tab-${i}`);
    await settle();
  }
  expect(loads).toBe(MAX_FAILED_CYCLES);
  expect(view.host.textContent).toContain("couldn't load");
  // The browser comes back online and the chunk loads; the next navigation renders the view.
  fail = false;
  window.dispatchEvent(new window.Event("online"));
  await settle();
  await view.render("reset-after-success");
  await settle();
  expect(view.host.textContent).toBe("the view");
  await view.unmount();
});

test("a recovery attempt that fails (online before fetches work) waits for the next chance", async () => {
  let loads = 0;
  let fail = true;
  const View = () => createElement("p", null, "the view");
  const Lazy = lazyNamed(
    async () => {
      loads++;
      if (fail) throw new Error("boom");
      return { View };
    },
    "View",
    { retryDelaysMs: [] }
  );
  const view = mount(Lazy);
  for (let i = 0; i < MAX_FAILED_CYCLES; i++) {
    await view.render(`tab-${i}`);
    await settle();
  }
  expect(loads).toBe(MAX_FAILED_CYCLES);
  // The interface comes up but fetches still fail: that attempt fails too.
  window.dispatchEvent(new window.Event("online"));
  await settle();
  expect(loads).toBe(MAX_FAILED_CYCLES + 1);
  // The tab is shown again later and the chunk loads; the next navigation renders the view.
  fail = false;
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  await settle();
  expect(loads).toBe(MAX_FAILED_CYCLES + 2);
  await view.render("after-recovery");
  await settle();
  expect(view.host.textContent).toBe("the view");
  await view.unmount();
});

test("a view whose chunk keeps failing shows its boundary's error once, then retries after a reset", async () => {
  let loads = 0;
  let fail = true;
  const View = () => createElement("p", null, "the view");
  const Lazy = lazyNamed(
    async () => {
      loads++;
      // Not a chunk-fetch message, so no reload is attempted.
      if (fail) throw new Error("boom");
      return { View };
    },
    "View",
    { retryDelaysMs: [] }
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (resetKey: string) =>
    createElement(ViewBoundary, {
      resetKey,
      children: createElement(Suspense, { fallback: "loading" }, createElement(Lazy)),
    });

  await act(() => root.render(render("a")));
  await settle();
  expect(host.textContent).toContain("This view couldn't load: boom");
  expect(loads).toBe(1);

  // Re-rendering with the same key keeps the error; no load storm.
  await act(() => root.render(render("a")));
  await settle();
  expect(loads).toBe(1);

  // A tab change resets the boundary, and the view loads afresh.
  fail = false;
  await act(() => root.render(render("b")));
  await settle();
  expect(host.textContent).toBe("the view");
  expect(loads).toBe(2);
  await act(() => root.unmount());
});
