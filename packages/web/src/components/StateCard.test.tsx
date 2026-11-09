import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { PersonaMessage, StateReport } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let MemoryRouter: typeof import("react-router-dom").MemoryRouter;
let card: typeof import("./StateCard");
let CommandResultCard: typeof import("./CommandResultCard").CommandResultCard;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter } = await import("react-router-dom"));
  card = await import("./StateCard");
  ({ CommandResultCard } = await import("./CommandResultCard"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const NOW = "2026-10-12T15:00:00.000Z";
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();

function report(): StateReport {
  return {
    generatedAt: NOW,
    waiting: {
      jobs: [{ id: "j1", title: "Pick a name", detail: "Two names to choose from", at: ago(20), href: "/persona?job=j1" }],
      questions: [{ id: "q1", title: "Which branch should I use?", detail: "Persona asked you", at: ago(5), href: "/persona" }],
      approvals: [{ id: "a1", title: "Launch the deploy worker", detail: "For “Deploy beta”", at: ago(65), href: "/persona?job=j2" }],
      reviews: [{ id: "r1", title: "Add the Review tab", detail: "Ready for your review", at: ago(180), href: "/review/r1" }],
    },
    inFlight: {
      total: 2,
      stalled: 1,
      stages: [
        { stage: "coding", title: "Coding", jobs: [{ id: "j3", title: "Fresh worker", detail: "Working", lastActivityAt: ago(2), href: "/persona?job=j3", stalled: false }] },
        { stage: "review", title: "Review", jobs: [{ id: "j4", title: "Quiet worker", detail: "Looks stuck: running but quiet", lastActivityAt: ago(45), href: "/persona?job=j4", stalled: true }] },
      ],
    },
    holds: [{ id: "h1", title: "Bash: git push origin main", detail: "Safety hold on “Fresh worker”", at: ago(12), href: "/work/s/s1" }],
    health: {
      collector: { startedAt: ago(190), uptimeMs: 190 * 60_000, head: "0123456789abcdef" },
      restart: { id: "x", outcome: "rolled-back", phase: "done", at: ago(30), error: "health check failed" },
      host: { memAvailableBytes: 40 * 1024 ** 3, memTotalBytes: 64 * 1024 ** 3, load1: 1.5, cores: 16, active: 2, cap: 6, effectiveCap: 6, hostLimited: false, queued: 0 },
      schedules: [{ id: "s1", title: "Nightly sweep", detail: "Last run failed: worker crashed", at: ago(600), href: "/schedules" }],
      budgets: [],
      commitments: [],
    },
    verdict: { needYou: 5, lookOff: 3, line: "5 things need you · 3 things look off" },
  };
}

let host: HTMLElement;
let root: Root;
let mounted = false;

afterEach(async () => {
  if (!mounted) return;
  await act(() => root.unmount());
  host.remove();
  mounted = false;
});

async function render(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  await act(() => root.render(createElement(MemoryRouter, null, node)));
}

const section = (id: string) => host.querySelector(`[data-testid=${id}]`) as HTMLElement;

describe("agoLabel / durationLabel", () => {
  test("word times plainly", () => {
    const now = Date.parse(NOW);
    expect(card.agoLabel(ago(0), now)).toBe("just now");
    expect(card.agoLabel(ago(12), now)).toBe("12 min ago");
    expect(card.agoLabel(ago(180), now)).toBe("3 h ago");
    expect(card.agoLabel(ago(3 * 24 * 60), now)).toBe("3 days ago");
    expect(card.durationLabel(190 * 60_000)).toBe("3 h 10 min");
    expect(card.durationLabel(50 * 3_600_000)).toBe("2 days 2 h");
  });
});

describe("StateCard", () => {
  test("shows each section with counts, linked items and the verdict", async () => {
    await render(createElement(card.StateCard, { report: report() }));
    const waiting = section("state-waiting");
    expect(waiting.textContent).toContain("4 things");
    expect(waiting.textContent).toContain("Approvals (1)");
    expect(waiting.textContent).toContain("Launch the deploy worker");
    expect(waiting.textContent).toContain("1 h ago");
    const links = [...waiting.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/persona?job=j2", "/persona", "/review/r1", "/persona?job=j1"]);

    const flight = section("state-in-flight");
    expect(flight.textContent).toContain("2 jobs, 1 stalled");
    expect([...flight.querySelectorAll("[data-testid=state-stage]")].map((g) => g.firstElementChild!.textContent)).toEqual(["Coding (1)", "Review (1)"]);
    expect(flight.textContent).toContain("Stalled");
    expect(flight.textContent).toContain("last worker activity 45 min ago");

    expect(section("state-holds").textContent).toContain("Safety hold on “Fresh worker”");

    const health = section("state-health");
    expect(health.textContent).toContain("Up for 3 h 10 min · version 01234567");
    expect(health.textContent).toContain("Rolled back to the previous version, 30 min ago: health check failed");
    expect(health.textContent).toContain("40.0 GB free of 64.0 GB · CPU load 1.5 across 16 cores · 2 of 6 sessions running");
    expect(health.textContent).toContain("Last run failed: worker crashed");
    expect(health.textContent).toContain("No job is near its budget");
    expect(health.textContent).toContain("Nothing overdue");
    const rows = [...health.querySelectorAll("[data-testid=state-health-row]")].map((r) => r.getAttribute("data-ok"));
    expect(rows).toEqual(["true", "false", "true", "false", "true", "true"]);

    expect(section("state-verdict").textContent).toBe("5 things need you · 3 things look off");
  });

  test("an empty report reads as all good", async () => {
    const empty: StateReport = {
      ...report(),
      waiting: { jobs: [], questions: [], approvals: [], reviews: [] },
      inFlight: { total: 0, stalled: 0, stages: [] },
      holds: [],
      health: { ...report().health, restart: null, schedules: [] },
      verdict: { needYou: 0, lookOff: 0, line: "All good" },
    };
    await render(createElement(card.StateCard, { report: empty }));
    expect(section("state-waiting").textContent).toContain("Nothing is waiting on you.");
    expect(section("state-in-flight").textContent).toContain("No jobs are running.");
    expect(section("state-holds").textContent).toContain("No worker is held");
    expect(section("state-health").textContent).toContain("No restarts on record");
    expect(section("state-verdict").textContent).toBe("All good");
  });
});

describe("CommandResultCard", () => {
  const base: PersonaMessage = { id: "m1", threadId: "t", seq: 2, role: "system", text: "5 things need you", createdAt: NOW };

  test("draws the command's renderer", async () => {
    await render(
      createElement(CommandResultCard, {
        message: { ...base, command: { name: "state", args: "", result: { ok: true, data: report(), summary: "x", ranAt: NOW, ms: 3 } } },
      })
    );
    expect(host.querySelector("[data-testid=state-card]")).not.toBeNull();
  });

  test("a card stored in an older shape still draws, with missing sections empty", async () => {
    await render(
      createElement(CommandResultCard, {
        message: { ...base, command: { name: "state", args: "", result: { ok: true, data: { generatedAt: NOW, verdict: { line: "All good" } }, summary: "All good", ranAt: NOW, ms: 1 } } },
      })
    );
    expect(host.querySelector("[data-testid=state-card]")).not.toBeNull();
    expect(section("state-waiting").textContent).toContain("Nothing is waiting on you.");
  });

  test("a card that can't be drawn falls back to its summary line", async () => {
    // An object where text belongs throws while rendering.
    const broken = { generatedAt: NOW, inFlight: { total: 1, stages: [{ stage: "x", title: "X", jobs: [{ id: "j", title: { nested: true } }] }] } };
    const origError = console.error;
    console.error = () => {};
    try {
      await render(
        createElement(CommandResultCard, {
          message: { ...base, command: { name: "state", args: "", result: { ok: true, data: broken, summary: "2 things need you", ranAt: NOW, ms: 1 } } },
        })
      );
    } finally {
      console.error = origError;
    }
    expect(host.querySelector("[data-testid=state-card]")).toBeNull();
    expect(host.querySelector("[data-testid=command-summary]")!.textContent).toBe("2 things need you");
  });

  test("a job link from the Persona view keeps its other params", () => {
    expect(card.stateLinkTarget("/persona?job=j1", { pathname: "/persona", search: "?tags=a,b&job=old" })).toBe("/persona?tags=a%2Cb&job=j1");
    expect(card.stateLinkTarget("/persona?job=j1", { pathname: "/review", search: "?x=1" })).toBe("/persona?job=j1");
    expect(card.stateLinkTarget("/review/r1", { pathname: "/persona", search: "?tags=a" })).toBe("/review/r1");
  });

  test("a failed run shows its reason instead of a card", async () => {
    await render(
      createElement(CommandResultCard, {
        message: { ...base, command: { name: "state", args: "", result: { ok: false, data: null, summary: "/state couldn't run: boom", ranAt: NOW, ms: 1 } } },
      })
    );
    expect(host.querySelector("[data-testid=state-card]")).toBeNull();
    expect(host.textContent).toBe("/state couldn't run: boom");
  });
});
