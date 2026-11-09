import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ShareState } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

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
let ShareToggle: typeof import("./ShareToggle").ShareToggle;
let isLoopbackOrigin: typeof import("./ShareToggle").isLoopbackOrigin;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ ShareToggle, isLoopbackOrigin } = await import("./ShareToggle"));
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

describe("ShareToggle", () => {
  test("off: the switch is unchecked and no link shows", async () => {
    await render(createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: OFF }));
    expect(q("share-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(q("share-link")).toBeNull();
    expect(q("share-copy")).toBeNull();
  });

  test("turning it on shows the link with a Copy link button; off hides it again", async () => {
    const calls: boolean[] = [];
    const onToggle = async (enabled: boolean) => {
      calls.push(enabled);
      return { share: enabled ? { enabled: true, path: `/share/review/${TOKEN}` } : OFF };
    };
    await render(
      createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: OFF, origin: "https://owner-standup.example", onToggle })
    );
    await act(async () => q("share-switch")!.click());
    expect(calls).toEqual([true]);
    expect(q("share-switch")?.getAttribute("aria-checked")).toBe("true");
    expect((q("share-link") as HTMLInputElement).value).toBe(`https://owner-standup.example/share/review/${TOKEN}`);
    expect(q("share-copy")?.textContent).toBe("Copy link");
    await act(async () => q("share-switch")!.click());
    expect(calls).toEqual([true, false]);
    expect(q("share-link")).toBeNull();
  });

  test("by default it records the change at the share route for the resource's type", async () => {
    const requests: { url: string; method?: string; body?: string; contentType?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body as string | undefined,
        contentType: (init?.headers as Record<string, string> | undefined)?.["content-type"],
      });
      return new Response(JSON.stringify({ share: { enabled: true, path: `/share/doc/${TOKEN}` } }), { status: 200 });
    }) as typeof fetch;
    await render(createElement(ShareToggle, { resourceType: "doc", resourceId: "d/1", share: OFF, origin: "https://o.example" }));
    expect(host.textContent).toContain("only you can see this doc");
    await act(async () => q("share-switch")!.click());
    expect(requests).toEqual([{ url: "/api/shares/doc/d%2F1", method: "PUT", body: '{"enabled":true}', contentType: "application/json" }]);
    expect((q("share-link") as HTMLInputElement).value).toBe(`https://o.example/share/doc/${TOKEN}`);
    expect(host.textContent).toContain("Anyone with the link can read this doc.");
  });

  test("a refused request at the share route shows the collector's error", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Only the owner can share a doc" }), { status: 403 })) as unknown as typeof fetch;
    await render(createElement(ShareToggle, { resourceType: "doc", resourceId: "d1", share: OFF }));
    await act(async () => q("share-switch")!.click());
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Only the owner can share a doc");
    expect(q("share-switch")?.getAttribute("aria-checked")).toBe("false");
  });

  test("Copy link writes the share URL to the clipboard", async () => {
    const written: string[] = [];
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    await render(
      createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: { enabled: true, path: `/share/review/${TOKEN}` }, origin: "https://o.example" })
    );
    await act(async () => q("share-copy")!.click());
    expect(written).toEqual([`https://o.example/share/review/${TOKEN}`]);
    expect(q("share-copy")?.textContent).toBe("Copied");
  });

  test("a link built on a loopback origin warns that only this machine can open it", async () => {
    const on = { enabled: true, path: `/share/doc/${TOKEN}` };
    await render(createElement(ShareToggle, { resourceType: "doc", resourceId: "d1", share: on, origin: "http://localhost:5173" }));
    expect(q("share-loopback")?.textContent).toContain("only works on this machine");
    await act(() => root.unmount());
    host.remove();
    await render(createElement(ShareToggle, { resourceType: "doc", resourceId: "d1", share: on, origin: "https://owner-standup.tunnels.example.com" }));
    expect(q("share-loopback")).toBeNull();
  });

  test("with no origin given, the link uses the configured console URL, else the page's origin", async () => {
    const on = { enabled: true, path: `/share/review/${TOKEN}` };
    const g = globalThis as Record<string, unknown>;
    g.__STANDUP_WEB_URL__ = "https://alice-standup.tunnels.example.com";
    try {
      await render(createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: on }));
      expect((q("share-link") as HTMLInputElement).value).toBe(`https://alice-standup.tunnels.example.com/share/review/${TOKEN}`);
      // The page is on localhost, but the link isn't, so there is nothing to warn about.
      expect(q("share-loopback")).toBeNull();
      await act(() => root.unmount());
      host.remove();
      // An explicit origin still wins.
      await render(createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: on, origin: "https://o.example" }));
      expect((q("share-link") as HTMLInputElement).value).toBe(`https://o.example/share/review/${TOKEN}`);
      await act(() => root.unmount());
      host.remove();
      // A loopback configured URL loses to the page's origin (which may be the tunnel).
      g.__STANDUP_WEB_URL__ = "http://localhost:5173";
      window.happyDOM.setURL("https://alice-standup.tunnels.example.com/docs/d1");
      await render(createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: on }));
      expect((q("share-link") as HTMLInputElement).value).toBe(`https://alice-standup.tunnels.example.com/share/review/${TOKEN}`);
      await act(() => root.unmount());
      host.remove();
      window.happyDOM.setURL("http://localhost/");
      // Unset ("" is what the build bakes in then): the page's own origin, with the loopback warning.
      g.__STANDUP_WEB_URL__ = "";
      await render(createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: on }));
      expect((q("share-link") as HTMLInputElement).value).toBe(`http://localhost/share/review/${TOKEN}`);
      expect(q("share-loopback")?.textContent).toContain("set STANDUP_WEB_URL");
    } finally {
      delete g.__STANDUP_WEB_URL__;
    }
  });

  test("isLoopbackOrigin names only this machine's addresses", () => {
    for (const o of ["http://localhost:5173", "http://app.localhost", "http://127.0.0.1:5173", "http://0.0.0.0:5173", "http://[::1]:5173", "http://[::ffff:127.0.0.1]"]) {
      expect(isLoopbackOrigin(o)).toBe(true);
    }
    for (const o of ["https://owner-standup.tunnels.example.com", "http://10.0.0.5:5173"]) expect(isLoopbackOrigin(o)).toBe(false);
  });

  test("a toggle still in flight when the switch moves to another resource doesn't land on it", async () => {
    let finish: (value: { share: ShareState }) => void = () => {};
    const onToggle = () => new Promise<{ share: ShareState }>((resolve) => (finish = resolve));
    const element = (resourceId: string) => createElement(ShareToggle, { resourceType: "doc", resourceId, share: OFF, origin: "https://o.example", onToggle });
    await render(element("d1"));
    await act(async () => q("share-switch")!.click());
    expect(q("share-switch")?.hasAttribute("disabled")).toBe(true);
    await act(() => root.render(element("d2")));
    expect(q("share-switch")?.hasAttribute("disabled")).toBe(false);
    await act(async () => finish({ share: { enabled: true, path: `/share/doc/${TOKEN}` } }));
    expect(q("share-switch")?.getAttribute("aria-checked")).toBe("false");
    expect(q("share-link")).toBeNull();
  });

  test("a refused toggle shows the error and keeps the state", async () => {
    await render(
      createElement(ShareToggle, { resourceType: "review", resourceId: "r1", share: OFF, onToggle: async () => ({ error: "Only a person can share a review" }) })
    );
    await act(async () => q("share-switch")!.click());
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Only a person can share a review");
    expect(q("share-switch")?.getAttribute("aria-checked")).toBe("false");
  });
});
