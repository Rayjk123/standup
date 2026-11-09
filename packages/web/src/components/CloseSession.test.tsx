import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Session } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let mod: typeof import("./CloseSession");
let SessionControls: typeof import("./SessionControls").SessionControls;

/** Whether the viewport reads as a phone to useNarrow. */
let narrow = false;
const calls: Array<{ url: string; body: unknown }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, closed: "record" } };

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  saved.set("fetch", globalThis.fetch);
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
    matches: narrow,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./CloseSession");
  ({ SessionControls } = await import("./SessionControls"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove();
  root = null;
  calls.length = 0;
  narrow = false;
  reply = { status: 200, body: { ok: true, closed: "record" } };
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  host = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(host as unknown as Node);
  root = createRoot(host as unknown as Element);
  await act(() => root!.render(node));
  return host;
}

const session = (extra: Partial<Session> = {}): Session =>
  ({ id: "s1", projectId: "p", title: "Compare settings table design approaches", cwd: "/x", status: "idle", startedAt: "2026-10-12T00:00:00Z", ...extra }) as Session;

const buttonByText = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

async function click(el: Element | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
}

describe("canCloseSession", () => {
  test("live root sessions only, never an open Persona job's worker", () => {
    expect(mod.canCloseSession(session())).toBe(true);
    expect(mod.canCloseSession(session({ owned: true }))).toBe(true);
    expect(mod.canCloseSession(session({ personaWorker: true }))).toBe(false);
    expect(mod.canCloseSession(session({ endedAt: new Date("2026-10-12T01:00:00Z") }))).toBe(false);
    expect(mod.canCloseSession(session({ parentSessionId: "root" }))).toBe(false);
  });

  test("not offered on someone else's session to a known viewer", () => {
    expect(mod.canCloseSession(session({ createdActor: "alice" }), "alice")).toBe(true);
    expect(mod.canCloseSession(session({ createdActor: "alice", ownerActor: "bob" }), "alice")).toBe(false);
    expect(mod.canCloseSession(session({ createdActor: "bob" }), "alice")).toBe(false);
    // An imported session has no attribution; an unknown viewer is the host on loopback.
    expect(mod.canCloseSession(session(), "alice")).toBe(true);
    expect(mod.canCloseSession(session({ createdActor: "bob" }), "")).toBe(true);
  });
});

describe("ClosableSessionRow", () => {
  const row = (s: Session, onClosed = () => {}) =>
    createElement(mod.ClosableSessionRow, { session: s, onClosed, children: createElement("button", null, "row") });

  test("hovering shows Close; confirming posts the close with the Delete from list choice", async () => {
    let closed = 0;
    const el = await render(row(session(), () => closed++));
    expect(el.querySelector('[aria-label="Close session"]')).toBeNull();
    await act(async () => {
      el.firstElementChild!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
    });
    await click(el.querySelector('[aria-label="Close session"]'));
    expect(el.textContent).toContain("Standup doesn't own its terminal");
    await act(async () => {
      (el.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    await click(buttonByText(el, "Close and delete"));
    expect(calls).toEqual([{ url: "/api/sessions/s1/close", body: { deleteFromList: true } }]);
    expect(closed).toBe(1);
  });

  test("no control for an open job's worker or on a phone", async () => {
    for (const [s, phone] of [
      [session({ personaWorker: true }), false],
      [session(), true],
    ] as const) {
      narrow = phone;
      const el = await render(row(s));
      await act(async () => {
        el.firstElementChild!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }) as unknown as Event);
      });
      expect(el.querySelector('[aria-label="Close session"]')).toBeNull();
      await act(() => root!.unmount());
      root = null;
    }
  });
});

describe("SessionControls close session", () => {
  test("a stuck orphaned session closes from the detail view; a refusal is shown", async () => {
    let changed = 0;
    const el = await render(createElement(SessionControls, { session: session({ status: "waiting" }), onChanged: () => changed++ }));
    await click(buttonByText(el, "close session"));
    reply = { status: 403, body: { error: "This session is owned by bob. Claim it back first to close it." } };
    await click(buttonByText(el, "Close session"));
    expect(el.textContent).toContain("owned by bob");
    expect(changed).toBe(0);
    reply = { status: 200, body: { ok: true, closed: "record" } };
    await click(buttonByText(el, "Close session"));
    expect(calls.at(-1)).toEqual({ url: "/api/sessions/s1/close", body: { deleteFromList: false } });
    expect(changed).toBe(1);
  });

  test("an open confirm closes when the session it was for can no longer be closed", async () => {
    const el = await render(createElement(SessionControls, { session: session(), onChanged: () => {} }));
    await click(buttonByText(el, "close session"));
    expect(el.querySelector('[data-testid="close-session-confirm"]')).toBeTruthy();
    await act(() =>
      root!.render(createElement(SessionControls, { session: session({ endedAt: new Date("2026-10-12T01:00:00Z") }), onChanged: () => {} }))
    );
    expect(el.querySelector('[data-testid="close-session-confirm"]')).toBeNull();
  });

  test("not offered for an open job's worker", async () => {
    const el = await render(createElement(SessionControls, { session: session({ personaWorker: true, owned: true }), onChanged: () => {} }));
    expect(buttonByText(el, "close session")).toBeUndefined();
    expect(buttonByText(el, "stop")).toBeTruthy();
  });
});
