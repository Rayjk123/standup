import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { PersonaMessage, RamReport } from "@standup/shared";
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
let card: typeof import("./RamCard");
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
  card = await import("./RamCard");
  ({ CommandResultCard } = await import("./CommandResultCard"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const NOW = "2026-10-14T12:00:00.000Z";
const GB = 1024 ** 3;

function report(): RamReport {
  const worker = { id: "worker:L1", label: "Fix the build", detail: "Job active · session running", rssBytes: 2 * GB, processCount: 3, pids: [2100], command: "node …/2.1/cli.js", startedAt: "2026-10-14T09:00:00.000Z", href: "/persona?job=J1" };
  const leftover = { id: "leftover:L2:5000", label: "Old job", detail: "Job done · session ended", rssBytes: 0.6 * GB, processCount: 1, pids: [5000], command: "node …/.bin/vite --port 5200", reason: "job_closed" as const, kind: "vite server" };
  return {
    generatedAt: NOW,
    host: { totalBytes: 64 * GB, usedBytes: 48 * GB, availableBytes: 16 * GB, swapTotalBytes: 4 * GB, swapUsedBytes: 1 * GB, standupBytes: 4 * GB },
    top: [{ ...worker, section: "worker" }, { ...leftover, section: "leftover" }],
    workers: [worker],
    standup: [{ id: "standup:Collector", label: "Collector", rssBytes: 0.9 * GB, processCount: 1, pids: [4000], command: "bun run src/index.ts" }],
    leftovers: [leftover],
    other: [],
    otherRest: { count: 0, rssBytes: 0 },
    freeable: [{ kind: "vite server", reason: "job_closed", count: 1, rssBytes: 0.6 * GB, pids: [5000], line: "" }],
    processError: null,
    summary: "48.0 GB used of 64.0 GB · Standup 4.0 GB · 1 leftover could free 0.6 GB",
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

describe("RamCard", () => {
  test("leads with the totals, the heaviest groups and what could be freed; the rest folds away", async () => {
    await render(createElement(card.RamCard, { report: report() }));
    expect(section("ram-totals").textContent).toContain("48.0 GB");
    expect(section("ram-totals").textContent).toContain("used of 64.0 GB");
    expect(section("ram-totals").textContent).toContain("Standup 4.0 GB (6% of the total)");
    expect(section("ram-totals").textContent).toContain("Swap 1.0 GB of 4.0 GB");
    const top = section("ram-top").querySelectorAll("[data-testid=ram-row]");
    expect(top).toHaveLength(2);
    expect(top[0]!.textContent).toContain("Fix the build");
    expect(top[0]!.textContent).toContain("pid 2100 · 3 processes · started 3 h ago");
    expect(top[0]!.querySelector("a")?.getAttribute("href")).toBe("/persona?job=J1");
    expect(section("ram-freeable").textContent).toContain("1 leftover vite server from a closed job · pid 5000");
    for (const id of ["ram-leftovers", "ram-workers", "ram-standup", "ram-other"]) {
      expect(section(id).tagName).toBe("DETAILS");
      expect(section(id).hasAttribute("open")).toBe(false);
    }
    expect(section("ram-leftovers").textContent).toContain("vite server: Old job");
    expect(section("ram-other").textContent).toContain("Nothing else is running.");
  });

  test("the Everything else fold counts the trees it doesn't list", async () => {
    const base = report();
    await render(createElement(card.RamCard, { report: { ...base, other: [{ ...base.standup[0]!, id: "other:1" }], otherRest: { count: 4, rssBytes: 1 * GB } } }));
    const summary = section("ram-other").querySelector("summary")!.textContent;
    expect(summary).toContain("5");
    expect(summary).toContain("1.9 GB");
    expect(section("ram-other").textContent).toContain("And 4 smaller process trees, 1.0 GB together.");
  });

  test("a leftover kept by its parent says so", async () => {
    const base = report();
    await render(createElement(card.RamCard, { report: { ...base, leftovers: [{ ...base.leftovers[0]!, hasParent: true }], freeable: [] } }));
    expect(section("ram-leftovers").textContent).toContain("job closed, kept by its parent");
  });

  test("a freeable leftover of an open job says cleanup won't stop it on its own", async () => {
    const base = report();
    await render(createElement(card.RamCard, { report: { ...base, freeable: [{ ...base.freeable[0]!, reason: "session_ended" }] } }));
    expect(section("ram-freeable-note").textContent).toContain("close its job first, or stop the pids");
  });

  test("a closed job's freeable leftovers carry no such note", async () => {
    await render(createElement(card.RamCard, { report: report() }));
    expect(section("ram-freeable-note")).toBeNull();
  });

  test("the top five leave the command line to the folds; a sliver share, no swap and a long pid list read plainly", async () => {
    const base = report();
    const many = { ...base.leftovers[0]!, pids: [1, 2, 3, 4, 5, 6, 7] };
    await render(
      createElement(card.RamCard, {
        report: { ...base, host: { ...base.host!, standupBytes: 0.1 * GB, swapTotalBytes: 0, swapUsedBytes: 0 }, leftovers: [many], freeable: [{ ...base.freeable[0]!, pids: many.pids }] },
      })
    );
    expect(section("ram-top").textContent).not.toContain("node …/2.1/cli.js");
    expect(section("ram-leftovers").textContent).toContain("node …/.bin/vite --port 5200");
    expect(section("ram-totals").textContent).toContain("Standup 0.1 GB (under 1% of the total)");
    expect(section("ram-totals").textContent).toContain("No swap");
    expect(section("ram-freeable").textContent).toContain("pid 1, 2, 3, 4, 5 +2 more");
  });

  test("the stop command names every pid of the row", () => {
    expect(card.stopCommand([5000, 5001])).toBe("kill 5000 5001");
  });

  test("no leftovers says so", async () => {
    await render(createElement(card.RamCard, { report: { ...report(), leftovers: [], freeable: [] } }));
    expect(section("ram-freeable").textContent).toContain("Nothing: no leftovers from closed jobs or ended sessions.");
    expect(section("ram-leftovers").textContent).toContain("No process outlived its job, session or tmux pane.");
  });

  test("a process error replaces the sections but keeps the totals", async () => {
    await render(createElement(card.RamCard, { report: { ...report(), processError: "Process details are shown only to the host's owner." } }));
    expect(section("ram-totals")).not.toBeNull();
    expect(section("ram-error").textContent).toContain("shown only to the host's owner");
    expect(section("ram-top")).toBeNull();
  });

  test("a closed job's live worker is listed as still live, and nothing is offered to free", async () => {
    const base = report();
    await render(createElement(card.RamCard, { report: { ...base, leftovers: [{ ...base.leftovers[0]!, stillLive: true }], freeable: [] } }));
    expect(section("ram-leftovers").textContent).toContain("job closed, still live");
    expect(section("ram-freeable").textContent).toContain("Nothing cleanup would stop: each leftover's worker is still live, or its parent still runs.");
  });

  test("Standup's share is capped at 100% when summed RSS passes the total", async () => {
    const base = report();
    await render(createElement(card.RamCard, { report: { ...base, host: { ...base.host!, standupBytes: 80 * GB } } }));
    expect(section("ram-totals").textContent).toContain("Standup 80.0 GB (100% of the total)");
  });

  test("toRamReport reads partial data as empty sections and fields", async () => {
    const r = card.toRamReport({ host: null }, NOW);
    expect(r).toMatchObject({ generatedAt: NOW, host: null, top: [], leftovers: [], otherRest: { count: 0, rssBytes: 0 }, processError: null });
    const partial = card.toRamReport(
      { ...report(), workers: [{ label: "No pids" }], leftovers: [{ label: "No kind", reason: "job_closed" }], freeable: [{ reason: "job_closed", count: 1 }] },
      NOW
    );
    expect(partial.workers[0]).toMatchObject({ label: "No pids", pids: [], rssBytes: 0, processCount: 0, command: "" });
    expect(partial.leftovers[0]!.kind).toBe("process");
    expect(partial.freeable[0]).toMatchObject({ kind: "process", pids: [], rssBytes: 0 });
    expect(card.toRamReport({ host: {} }, NOW).host).toBeNull();
    expect(card.toRamReport({ host: { totalBytes: 8 * GB } }, NOW).host).toMatchObject({ totalBytes: 8 * GB, usedBytes: 0, standupBytes: 0 });
    await render(createElement(card.RamCard, { report: partial }));
    expect(section("ram-workers").textContent).toContain("No pids");
  });

  test("CommandResultCard draws a /ram result with its card", async () => {
    const message = {
      id: "m1",
      threadId: "t1",
      role: "system",
      text: "x",
      createdAt: NOW,
      command: { name: "ram", args: "", result: { ok: true, data: report(), summary: "x", ranAt: NOW, ms: 4 } },
    } as unknown as PersonaMessage;
    await render(createElement(CommandResultCard, { message }));
    expect(section("ram-card")).not.toBeNull();
  });
});
