import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { PersonaJob } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void) => void;
let createRoot: (el: Element) => Root;
let JobsPanel: typeof import("./PersonaView").JobsPanel;
let router: typeof import("react-router-dom");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ JobsPanel } = await import("./PersonaView"));
  router = await import("react-router-dom");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function job(id: string, over: Partial<PersonaJob>): PersonaJob {
  return {
    id,
    owner: "owner",
    threadId: "t1",
    title: `Job ${id}`,
    goal: "do it",
    status: "active",
    launchIds: [],
    sessionIds: [],
    createdAt: minutesAgo(120),
    updatedAt: minutesAgo(120),
    ...over,
  };
}

function render(jobs: PersonaJob[]): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  // The panel's action links are routes, so it renders inside a router as in the console.
  act(() =>
    root.render(
      createElement(
        router.MemoryRouter,
        { initialEntries: ["/persona"] },
        createElement(JobsPanel, { jobs, selected: null, onOpen: () => {} })
      )
    )
  );
  return host as unknown as HTMLElement;
}

describe("Jobs list", () => {
  test("shows each job's derived state, last activity and newest summary, needs-you first", () => {
    const host = render([
      job("idle", {
        title: "Idle job",
        note: "Persona: worker finished",
        view: { state: "idle", lastActivityAt: minutesAgo(90) },
      }),
      job("running", {
        title: "Running job",
        note: "Persona: started",
        view: {
          state: "running",
          lastActivityAt: minutesAgo(2),
          checkpoint: { sessionId: "s1", summary: "Tests green, writing docs", at: minutesAgo(2) },
        },
      }),
      job("needs", {
        title: "Needs-you job",
        // Stored active: the approval card alone puts it in front of the owner.
        status: "active",
        view: { state: "needs_you", needs: ["approval", "question"], lastActivityAt: minutesAgo(10) },
      }),
    ]);

    const rows = [...host.querySelectorAll("[data-job-state]")];
    expect(rows.map((r) => r.getAttribute("data-job-state"))).toEqual(["needs_you", "running", "idle"]);
    expect(rows.map((r) => r.querySelector("button span")!.textContent)).toEqual(["needs you", "running", "idle"]);

    const [needs, running, idle] = rows;
    expect(needs.querySelector("[data-testid=job-meta]")!.textContent).toBe(
      "approval waiting · question for you · active 10m ago"
    );
    expect(running.querySelector("[data-testid=job-summary]")!.textContent).toBe("Worker: Tests green, writing docs");
    expect(running.querySelector("[data-testid=job-meta]")!.textContent).toBe("active 2m ago");
    expect(idle.querySelector("[data-testid=job-summary]")!.textContent).toBe("Persona: worker finished");
    expect(idle.querySelector("[data-testid=job-meta]")!.textContent).toBe("active 1h 30m ago");
  });

  test("a needs-you job links to the review packet behind it", () => {
    const host = render([
      job("review", {
        title: "Review waiting",
        status: "waiting_user",
        view: {
          state: "needs_you",
          needs: ["waiting"],
          actions: [
            { kind: "review", id: "rp-77", label: "Review: tighten the waive policy" },
            { kind: "approval", id: "appr-3", label: "Approve: deploy to beta" },
          ],
          lastActivityAt: minutesAgo(3),
        },
      }),
    ]);

    const link = host.querySelector("a[data-testid=job-action]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/review/rp-77");
    expect(link.textContent).toBe("Review: tighten the waive policy");
    // The approval is decided in the drawer the row opens, so the row doesn't offer it.
    expect(host.querySelectorAll("[data-testid=job-action]")).toHaveLength(1);
  });

  test("a worker's hand-off links to the session that raised it", () => {
    const host = render([
      job("handoff", {
        title: "Merge the fix",
        status: "waiting_user",
        view: {
          state: "needs_you",
          needs: ["waiting"],
          actions: [{ kind: "session", id: "sess-42", label: "see what the worker handed you" }],
          lastActivityAt: minutesAgo(4),
        },
      }),
    ]);
    const link = host.querySelector("a[data-testid=job-action]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/work/s/sess-42");
    expect(link.getAttribute("data-kind")).toBe("session");
  });

  test("a job from a collector without a derived view falls back to its stored status", () => {
    const host = render([job("old", { status: "waiting_user", updatedAt: minutesAgo(5) })]);
    const row = host.querySelector("[data-job-state]")!;
    expect(row.getAttribute("data-job-state")).toBe("needs_you");
    expect(row.querySelector("[data-testid=job-meta]")!.textContent).toBe("active 5m ago");
  });
});
