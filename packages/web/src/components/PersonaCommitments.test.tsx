import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { PersonaCommitment } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let mod: typeof import("./PersonaCommitments");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  mod = await import("./PersonaCommitments");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function commitment(id: string, over: Partial<PersonaCommitment>): PersonaCommitment {
  return {
    id,
    owner: "owner",
    assignee: "persona",
    action: `Step ${id}`,
    doneCheck: "it holds",
    status: "open",
    source: "persona",
    openedAt: minutes(-5),
    ...over,
  };
}

describe("commitment ordering", () => {
  test("Persona's overdue first, then Persona's, workers' and the owner's", () => {
    const now = Date.now();
    const list = [
      commitment("you", { assignee: "owner" }),
      commitment("worker", { assignee: "worker:s1", staleAfter: minutes(-1) }),
      commitment("mine", { staleAfter: minutes(5) }),
      commitment("late", { staleAfter: minutes(-2) }),
    ];
    expect(mod.sortCommitments(list, now).map((c) => c.id)).toEqual(["late", "mine", "worker", "you"]);
    expect(mod.commitmentState(list[1]!, now)).toBe("stale");
    expect(mod.commitmentState(list[3]!, now)).toBe("overdue");
    expect(mod.commitmentState(list[0]!, now)).toBe("fresh");
    expect(mod.commitmentOwnerLabel(list[1]!)).toBe("Worker s1");
  });
});

describe("CommitmentsPanel", () => {
  test("lists the open commitments read-only, overdue flagged; renders nothing when there are none", async () => {
    let served: PersonaCommitment[] = [
      commitment("c1", { action: "Land approved review /review/abc", jobId: "job-1", source: "auto", staleAfter: minutes(-3) }),
      commitment("c2", { assignee: "owner", action: "Decide the push card" }),
    ];
    globalThis.fetch = (async (input: string) => {
      expect(String(input)).toBe("/api/persona/commitments");
      return new Response(JSON.stringify({ commitments: served }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const opened: string[] = [];
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const render = async () => {
      await act(async () => {
        root.render(
          createElement(mod.CommitmentsPanel, {
            jobs: [{ id: "job-1", title: "Commitments ledger" } as never],
            onOpenJob: (id: string) => opened.push(id),
            pollMs: 60_000,
          })
        );
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    window.localStorage.clear();
    await render();
    const panel = el.querySelector('[data-testid="persona-commitments"]')!;
    expect(panel.textContent).toContain("Commitments · 2 open · 1 overdue");
    // Collapsed to its header on a fresh browser.
    const header = el.querySelector("button[aria-expanded]") as unknown as { click(): void; getAttribute(n: string): string | null };
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelectorAll('[data-testid="persona-commitment"]').length).toBe(0);
    await act(async () => header.click());
    expect(window.localStorage.getItem(mod.COMMITMENTS_EXPANDED_KEY)).toBe("1");
    const rows = [...el.querySelectorAll('[data-testid="persona-commitment"]')];
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["overdue", "fresh"]);
    expect(rows[0]!.textContent).toContain("Land approved review /review/abc");
    expect(rows[0]!.textContent).toContain("Done when: it holds");
    expect(rows[0]!.textContent).toContain("by Standup");
    expect(rows[1]!.textContent).toContain("You");
    // Read-only: past the header, the only control is the link to the job's drawer.
    const buttons = [...el.querySelectorAll("li button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Commitments ledger ›"]);
    await act(async () => {
      (buttons[0] as unknown as { click(): void }).click();
    });
    expect(opened).toEqual(["job-1"]);

    // The open choice survives a remount (a reload), and collapsing is kept too.
    await act(async () => root.unmount());
    const reloaded = document.createElement("div");
    document.body.appendChild(reloaded);
    const rootR = createRoot(reloaded);
    await act(async () => {
      rootR.render(createElement(mod.CommitmentsPanel, { jobs: [], onOpenJob: () => {}, pollMs: 60_000 }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(reloaded.querySelectorAll('[data-testid="persona-commitment"]').length).toBe(2);
    await act(async () => (reloaded.querySelector("button[aria-expanded]") as unknown as { click(): void }).click());
    expect(reloaded.querySelectorAll('[data-testid="persona-commitment"]').length).toBe(0);
    expect(window.localStorage.getItem(mod.COMMITMENTS_EXPANDED_KEY)).toBe("0");
    await act(async () => rootR.unmount());

    served = [];
    const again = document.createElement("div");
    document.body.appendChild(again);
    const root2 = createRoot(again);
    await act(async () => {
      root2.render(createElement(mod.CommitmentsPanel, { jobs: [], onOpenJob: () => {}, pollMs: 60_000 }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(again.innerHTML).toBe("");
    await act(async () => root2.unmount());
  });
});
