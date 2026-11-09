import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReviewDecision } from "@standup/shared";
import type { Root } from "react-dom/client";
import type { DecisionBarProps } from "./DecisionBar";
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
let DecisionBar: typeof import("./DecisionBar").DecisionBar;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ DecisionBar } = await import("./DecisionBar"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

type Decide = (decision: ReviewDecision, comment: string) => Promise<{ error?: string }>;

async function renderBar(onDecide: Decide, extra: Omit<DecisionBarProps, "onDecide"> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(DecisionBar, { onDecide, ...extra })));
}

function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
}

/** Types `value` into the comment box the way React sees it. */
async function type(value: string) {
  const el = host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  await act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}

describe("DecisionBar", () => {
  test("Request changes stays disabled until the comment has text", async () => {
    await renderBar(async () => ({}));
    expect(button("Request changes").disabled).toBe(true);
    await type("   ");
    expect(button("Request changes").disabled).toBe(true);
    await type("Rename the flag");
    expect(button("Request changes").disabled).toBe(false);
    expect(button("Approve").disabled).toBe(false);
  });

  test("Approve calls onDecide with the trimmed comment and clears it on success", async () => {
    const calls: Array<[ReviewDecision, string]> = [];
    await renderBar(async (d, c) => {
      calls.push([d, c]);
      return {};
    });
    await type("  Looks good  ");
    await act(async () => button("Approve").click());
    expect(calls).toEqual([["approved", "Looks good"]]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  test("Request changes sends the comment", async () => {
    const calls: Array<[ReviewDecision, string]> = [];
    await renderBar(async (d, c) => {
      calls.push([d, c]);
      return {};
    });
    await type("Split the migration out");
    await act(async () => button("Request changes").click());
    expect(calls).toEqual([["changes_requested", "Split the migration out"]]);
  });

  test("disables both buttons while submitting and shows a returned error", async () => {
    let resolve!: (r: { error?: string }) => void;
    await renderBar(() => new Promise((r) => (resolve = r)));
    await type("Keep the comment");
    await act(async () => button("Approve").click());
    expect(button("Approving…").disabled).toBe(true);
    expect(button("Request changes").disabled).toBe(true);
    await act(async () => resolve({ error: "packet was superseded" }));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("packet was superseded");
    expect(button("Approve").disabled).toBe(false);
    // A failed decision keeps what the reviewer typed.
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Keep the comment");
  });

  test("Ask sits beside the decisions only when asking is offered", async () => {
    await renderBar(async () => ({}));
    expect(button("Ask")).toBeUndefined();
    await act(() => root.unmount());
    host.remove();
    await renderBar(async () => ({}), { onAsk: async () => ({}) });
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Ask", "Request changes", "Approve"]);
  });

  test("Ask needs text, sends the trimmed question without deciding, and clears the box", async () => {
    const decided: string[] = [];
    const asked: Array<[string, string | undefined]> = [];
    await renderBar(
      async (d) => {
        decided.push(d);
        return {};
      },
      {
        onAsk: async (q, replyTo) => {
          asked.push([q, replyTo]);
          return {};
        },
      }
    );
    expect(button("Ask").disabled).toBe(true);
    await type("  Why pinned?  ");
    await act(async () => button("Ask").click());
    expect(asked).toEqual([["Why pinned?", undefined]]);
    expect(decided).toEqual([]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  test("a follow-up names its thread, asks into it, and can be dropped for a new question", async () => {
    const asked: Array<[string, string | undefined]> = [];
    let cleared = 0;
    await renderBar(async () => ({}), {
      onAsk: async (q, replyTo) => {
        asked.push([q, replyTo]);
        return {};
      },
      followUp: { id: "q-1", excerpt: "Why is the bar pinned?" },
      onClearFollowUp: () => cleared++,
    });
    expect(host.querySelector("[data-testid=follow-up-target]")?.textContent).toContain("Why is the bar pinned?");
    await type("On phones too?");
    await act(async () => button("Ask").click());
    expect(asked).toEqual([["On phones too?", "q-1"]]);
    expect(cleared).toBe(1);
    await act(async () => (host.querySelector("[aria-label='Ask a new question instead']") as HTMLButtonElement).click());
    expect(cleared).toBe(2);
  });
});
