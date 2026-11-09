import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, type ComponentProps } from "react";
import type { BoardConflict, BoardTaskWithConflicts, Lens, ReviewFinding, Ticket } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { TicketActions } from "./TicketCard";
import { CLOSED_COLUMN_CAP, type BoardFilter, type BoardListState } from "../lib/board";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window", "document", "navigator", "Node", "HTMLElement", "HTMLInputElement", "HTMLSelectElement",
  "Element", "Text", "Event", "MouseEvent", "MutationObserver",
] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let BoardView: typeof import("./BoardView").BoardView;
let upsertBoardTask: typeof import("../lib/board").upsertBoardTask;
let router: typeof import("react-router-dom");
type BoardViewProps = ComponentProps<typeof import("./BoardView").BoardView>;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ BoardView } = await import("./BoardView"));
  ({ upsertBoardTask } = await import("../lib/board"));
  router = await import("react-router-dom");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function task(id: string, over: Partial<BoardTaskWithConflicts> = {}): BoardTaskWithConflicts {
  return {
    id,
    source: "job",
    sourceId: `src-${id}`,
    owner: "owner",
    projectId: "standup",
    title: `Task ${id}`,
    status: "coding",
    links: {},
    areas: { files: [], packages: [] },
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(5),
    ...over,
  };
}

const ticket: Ticket = {
  id: "tk1",
  projectId: "standup",
  lens: "security" as Lens,
  title: "Harden the upload route",
  body: "Validate the content type.",
  severity: "high",
  status: "proposed",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const conflict: BoardConflict = {
  taskId: "b",
  title: "Board tab",
  status: "coding",
  reasons: [{ kind: "files", overlap: ["packages/web/src/App.tsx"] }],
  score: 0.7,
};

const approved: string[] = [];
const dismissed: string[] = [];
const ok = async () => ({});
const actions: TicketActions = {
  onApprove: async (id) => {
    approved.push(id);
    return {};
  },
  onDismiss: async (id) => {
    dismissed.push(id);
    return {};
  },
  onShip: ok,
  onDispatch: ok,
  onFetchAttempts: async () => ({ attempts: [] }),
  onPickAttempt: ok,
  onStatus: ok,
  onPublish: async () => ({}),
  onReviewComments: async () => ({}),
  onFixFinding: ok,
  onDismissFinding: ok,
};

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  approved.length = 0;
  dismissed.length = 0;
});

type ViewExtras = Partial<Pick<BoardViewProps, "findings" | "closedMore" | "onLoadOlder">>;

function view(tasks: BoardTaskWithConflicts[], tickets: Ticket[] = [], listState?: BoardListState, extras: ViewExtras = {}) {
  return createElement(BoardView, {
    tasks,
    tickets,
    findings: [],
    sessions: [],
    projects: [],
    launches: [],
    taskRuns: [],
    ticketActions: actions,
    listState,
    ...extras,
  });
}

async function render(
  tasks: BoardTaskWithConflicts[],
  path = "/board",
  tickets: Ticket[] = [],
  listState?: BoardListState,
  extras: ViewExtras = {}
) {
  host = document.createElement("div") as unknown as HTMLElement;
  document.body.appendChild(host as unknown as Node);
  root = createRoot(host as unknown as Element);
  const { MemoryRouter, Routes, Route } = router;
  // The view rerenders inside the same router so URL filter state survives.
  const tree = (t: BoardTaskWithConflicts[]) =>
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(Routes, null, createElement(Route, { path: "/board", element: view(t, tickets, listState, extras) }))
    );
  await act(() => root.render(tree(tasks)));
  return { rerender: (t: BoardTaskWithConflicts[]) => act(() => root.render(tree(t))) };
}

function column(status: string): Element {
  const el = host.querySelector(`[data-testid="board-column-${status}"]`);
  if (!el) throw new Error(`no column ${status}`);
  return el;
}

function cardIds(status: string): string[] {
  return [...column(status).querySelectorAll('[data-testid^="board-card-"]')].map((el) =>
    (el.getAttribute("data-testid") ?? "").replace("board-card-", "")
  );
}

async function change(selector: string, value: string) {
  const el = host.querySelector(selector) as unknown as HTMLInputElement | HTMLSelectElement;
  const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }) as unknown as Event);
  });
}

describe("BoardView", () => {
  test("renders every column and puts each card in its status column", async () => {
    await render([
      task("q", { status: "queued", flag: "planned", waitingOn: "plan approval" }),
      task("c", { status: "coding", stage: "coding" }),
      task("w", { status: "waiting" }),
      task("d", { status: "done" }),
    ]);
    for (const s of ["queued", "coding", "validation", "live_check", "in_review", "waiting", "done", "failed"]) column(s);
    expect(cardIds("queued")).toEqual(["q"]);
    expect(cardIds("coding")).toEqual(["c"]);
    expect(cardIds("waiting")).toEqual(["w"]);
    expect(cardIds("done")).toEqual(["d"]);
    const q = host.querySelector('[data-testid="board-card-q"]')!;
    expect(q.querySelector('[data-testid="board-flag"]')?.textContent).toBe("planned");
    expect(q.querySelector('[data-testid="board-waiting-on"]')?.textContent).toBe("waiting on plan approval");
    expect(host.querySelector('[data-testid="board-card-c"] [data-testid="board-stage"]')?.textContent).toBe("coding");
    expect(host.querySelector('[data-testid="board-column-count-coding"]')?.textContent).toBe("1");
  });

  test("a long waiting-on line is clamped to two lines, its whole text in the title", async () => {
    const long = `the validation gate ${"reported a flaky retry on the upload route ".repeat(6)}`;
    await render([task("w", { status: "in_review", waitingOn: long })]);
    const line = host.querySelector('[data-testid="board-card-w"] [data-testid="board-waiting-on"]') as unknown as HTMLElement;
    expect(line.getAttribute("title")).toBe(`waiting on ${long}`);
    // The DOM here drops the -webkit- box properties, so the clamp is read from the rendered markup.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MemoryRouter } = router;
    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: ["/board"] }, view([task("w", { status: "in_review", waitingOn: long })]))
    );
    const tag = markup.match(/<div[^>]*data-testid="board-waiting-on"[^>]*>/)?.[0] ?? "";
    expect(tag).toContain("display:-webkit-box");
    expect(tag).toContain("-webkit-line-clamp:2");
    expect(tag).toContain("-webkit-box-orient:vertical");
    expect(tag).toContain("overflow:hidden");
  });

  test("a Persona-deciding wait reads muted and on its own, not as waiting on the viewer", async () => {
    const tasks = [
      task("p", { status: "validation", stage: "review", waitingOn: "Persona deciding: wontfix waiver" }),
      task("o", { status: "waiting", waitingOn: "the issue id for the code review" }),
    ];
    await render(tasks);
    const persona = host.querySelector('[data-testid="board-column-validation"] [data-testid="board-card-p"] [data-testid="board-waiting-on"]');
    expect(persona?.textContent).toBe("Persona deciding: wontfix waiver");
    expect(persona?.getAttribute("data-tone")).toBe("persona");
    const owner = host.querySelector('[data-testid="board-card-o"] [data-testid="board-waiting-on"]');
    expect(owner?.textContent).toBe("waiting on the issue id for the code review");
    expect(owner?.getAttribute("data-tone")).toBe("viewer");
    // The muted style differs from the owner wait's, read from the rendered markup.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MemoryRouter } = router;
    const markup = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/board"] }, view(tasks)));
    const tags = markup.match(/<div[^>]*data-testid="board-waiting-on"[^>]*>/g) ?? [];
    const personaTag = tags.find((t) => t.includes('data-tone="persona"')) ?? "";
    const ownerTag = tags.find((t) => t.includes('data-tone="viewer"')) ?? "";
    expect(personaTag).toContain("font-style:italic");
    expect(ownerTag).not.toContain("font-style:italic");
  });

  test("a code review in progress and Persona closing out read in the muted tone, never as the viewer's wait", async () => {
    await render([
      task("rev", { status: "in_review", waitingOn: "code review in progress" }),
      task("close", { status: "in_review", waitingOn: "Persona to close out" }),
      task("host", { status: "queued", waitingOn: "host room to start" }),
    ]);
    const line = (id: string) => host.querySelector(`[data-testid="board-card-${id}"] [data-testid="board-waiting-on"]`);
    expect({ text: line("rev")?.textContent, tone: line("rev")?.getAttribute("data-tone") }).toEqual({ text: "code review in progress", tone: "persona" });
    expect({ text: line("close")?.textContent, tone: line("close")?.getAttribute("data-tone") }).toEqual({
      text: "waiting on Persona to close out",
      tone: "persona",
    });
    expect({ text: line("host")?.textContent, tone: line("host")?.getAttribute("data-tone") }).toEqual({
      text: "waiting on host room to start",
      tone: "persona",
    });
  });

  test("a parked task shows the parked flag and its parked reason in its stage column", async () => {
    await render([task("k", { status: "coding", flag: "parked", waitingOn: "parked: host restarted" })]);
    const card = host.querySelector('[data-testid="board-column-coding"] [data-testid="board-card-k"]')!;
    expect(card.querySelector('[data-testid="board-flag"]')?.textContent).toBe("parked");
    const line = card.querySelector('[data-testid="board-waiting-on"]');
    expect(line?.textContent).toBe("parked: host restarted");
    expect(line?.getAttribute("data-tone")).toBe("parked");
  });

  test("a card moves column when an upserted frame changes its status", async () => {
    const list = [task("a", { status: "coding" }), task("b", { status: "queued" })];
    const { rerender } = await render(list);
    expect(cardIds("coding")).toEqual(["a"]);
    const next = upsertBoardTask(list, { task: task("a", { status: "in_review", updatedAt: minutesAgo(0) }) });
    await rerender(next);
    expect(cardIds("coding")).toEqual([]);
    expect(cardIds("in_review")).toEqual(["a"]);
    expect(host.querySelector('[data-testid="board-card-a"]')?.getAttribute("data-moved")).toBe("true");
    const removed = upsertBoardTask(next, { removed: { id: "b" } });
    await rerender(removed);
    expect(cardIds("queued")).toEqual([]);
  });

  test("filters by the URL's source, then by text and source from the filter bar", async () => {
    await render(
      [task("j", { title: "Job work" }), task("t", { source: "ticket", sourceId: "tk1", title: "Ticket work" })],
      "/board?source=ticket"
    );
    expect(cardIds("coding")).toEqual(["t"]);
    expect((host.querySelector('[data-testid="board-source"]') as unknown as HTMLSelectElement).value).toBe("ticket");

    await change('[data-testid="board-source"]', "");
    expect(cardIds("coding").sort()).toEqual(["j", "t"]);

    await change('[data-testid="board-search"]', "job work");
    expect(cardIds("coding")).toEqual(["j"]);
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("1 of 2 tasks");
  });

  test("shows a conflict badge whose tooltip names each conflict", async () => {
    await render([task("a", { conflicts: [conflict] }), task("b")]);
    const badge = host.querySelector('[data-testid="board-conflicts-a"]');
    expect(badge?.textContent).toContain("1 conflict");
    expect(badge?.getAttribute("title")).toBe("Board tab [coding]: files packages/web/src/App.tsx");
    expect(host.querySelector('[data-testid="board-conflicts-b"]')).toBeNull();
  });

  test("links the job drawer, sessions, review packet and code review", async () => {
    await render([
      task("a", {
        links: { jobId: "j1", sessionIds: ["s1"], packetId: "p1", codeReview: { id: "R-1", url: "https://review.example.com/1" } },
      }),
    ]);
    const card = host.querySelector('[data-testid="board-card-a"]')!;
    expect(card.querySelector('[data-testid="board-link-job"]')?.getAttribute("href")).toBe("/persona?job=j1");
    expect(card.querySelector('[data-testid="board-link-session"]')?.getAttribute("href")).toBe("/board?workers=1&session=s1");
    expect(card.querySelector('[data-testid="board-link-review"]')?.getAttribute("href")).toBe("/review/p1");
    expect(card.querySelector('[data-testid="board-link-code_review"]')?.getAttribute("href")).toBe("https://review.example.com/1");
  });

  test("a ticket card expands into the ticket card with its actions", async () => {
    await render(
      [task("t", { source: "ticket", sourceId: "tk1", status: "queued", title: ticket.title })],
      "/board",
      [ticket]
    );
    expect(host.querySelector('[data-testid="ticket-card-tk1"]')).toBeNull();
    const toggle = host.querySelector('[data-testid="board-ticket-toggle-t"]') as unknown as HTMLElement;
    await act(async () => toggle.click());
    const card = host.querySelector('[data-testid="ticket-card-tk1"]');
    expect(card?.textContent).toContain("Validate the content type.");
    const approve = [...card!.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve")) as unknown as HTMLElement;
    await act(async () => approve.click());
    expect(approved).toEqual(["tk1"]);
  });

  test("a collapsed proposed ticket shows its severity and lens with Approve and a confirmed Dismiss", async () => {
    await render(
      [task("t", { source: "ticket", sourceId: "tk1", status: "queued", title: ticket.title })],
      "/board",
      [ticket]
    );
    const quick = host.querySelector('[data-testid="board-card-t"] [data-testid="ticket-quick-tk1"]')!;
    expect(quick.querySelector('[data-testid="ticket-severity"]')?.getAttribute("title")).toBe("high severity");
    expect(quick.querySelector('[data-testid="ticket-lens"]')?.textContent).toBe("security");
    const button = (label: string) =>
      [...host.querySelectorAll('[data-testid="ticket-quick-tk1"] button')].find((b) => b.textContent?.includes(label)) as unknown as HTMLElement;
    await act(async () => button("Approve").click());
    expect(approved).toEqual(["tk1"]);
    // Dismiss asks first; cancel backs out, the confirmed Dismiss fires.
    const quickText = () => host.querySelector('[data-testid="ticket-quick-tk1"]')?.textContent ?? "";
    await act(async () => button("dismiss").click());
    expect(quickText()).toContain("Abandon this?");
    expect(dismissed).toEqual([]);
    await act(async () => button("cancel").click());
    expect(quickText()).not.toContain("Abandon this?");
    await act(async () => button("dismiss").click());
    await act(async () => button("Dismiss").click());
    expect(dismissed).toEqual(["tk1"]);
    // Expanded, the full ticket card replaces the glance.
    await act(async () => (host.querySelector('[data-testid="board-ticket-toggle-t"]') as unknown as HTMLElement).click());
    expect(host.querySelector('[data-testid="ticket-quick-tk1"]')).toBeNull();
    expect(host.querySelector('[data-testid="ticket-card-tk1"]')).not.toBeNull();
  });

  test("a collapsed needs_review ticket counts its open high findings", async () => {
    const reviewed: Ticket = { ...ticket, status: "needs_review" };
    const finding = (id: string, over: Partial<ReviewFinding> = {}): ReviewFinding => ({
      id,
      ticketId: "tk1",
      severity: "high",
      title: `Finding ${id}`,
      body: "",
      status: "open",
      evidence: { checks: [], screenshots: [] },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
    const findings = [finding("f1"), finding("f2", { severity: "critical" }), finding("f3", { severity: "medium" }), finding("f4", { status: "dismissed" })];
    await render(
      [task("t", { source: "ticket", sourceId: "tk1", status: "in_review", title: ticket.title })],
      "/board",
      [reviewed],
      undefined,
      { findings }
    );
    expect(host.querySelector('[data-testid="board-high-findings-t"]')?.textContent).toBe("2 high findings");
    expect(host.querySelector('[data-testid="ticket-quick-tk1"]')).toBeNull();
    // Severity and lens show on every collapsed ticket card; Approve and Dismiss only on a proposed one.
    const lens = host.querySelector('[data-testid="board-card-t"] [data-testid="board-ticket-lens-tk1"]')!;
    expect(lens.querySelector('[data-testid="ticket-severity"]')?.getAttribute("title")).toBe("high severity");
    expect(lens.querySelector('[data-testid="ticket-lens"]')?.textContent).toBe("security");
    expect(lens.querySelectorAll("button").length).toBe(0);
    await act(async () => (host.querySelector('[data-testid="board-ticket-toggle-t"]') as unknown as HTMLElement).click());
    expect(host.querySelector('[data-testid="board-ticket-lens-tk1"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-high-findings-t"]')).toBeNull();
    expect(host.querySelector('[data-testid="ticket-card-tk1"]')).not.toBeNull();
  });

  test("Load older shows on the closed columns while more remain, and expands the column it was pressed in", async () => {
    const done = Array.from({ length: CLOSED_COLUMN_CAP + 2 }, (_, i) => task(`d${i}`, { status: "done", updatedAt: minutesAgo(i + 1) }));
    let loads = 0;
    const filters: BoardFilter[] = [];
    await render(done, "/board?source=job&q=d", [], "ok", {
      closedMore: true,
      onLoadOlder: async (filter) => {
        loads++;
        filters.push(filter);
      },
    });
    // Past the client cap, "+N older" comes first; the failed column, under it, offers Load older.
    expect(host.querySelector('[data-testid="board-column-load-older-done"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-column-load-older-failed"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="board-column-load-older-coding"]')).toBeNull();
    await act(async () => (host.querySelector('[data-testid="board-column-older-done"]') as unknown as HTMLElement).click());
    const load = host.querySelector('[data-testid="board-column-load-older-done"]') as unknown as HTMLElement;
    expect(load.textContent).toBe("Load older");
    await act(async () => load.click());
    expect(loads).toBe(1);
    // The page is asked for under the view's active filter.
    expect(filters).toEqual([{ text: "d", projectId: "", source: "job", status: "" }]);
    expect(cardIds("done").length).toBe(CLOSED_COLUMN_CAP + 2);
    await act(() => root.unmount());
    host.remove();
    await render(done, "/board", [], "ok", { closedMore: false, onLoadOlder: async () => {} });
    expect(host.querySelector('[data-testid^="board-column-load-older-"]')).toBeNull();
  });

  test("no Load older under a filter on an open status, whose cards a closed page never holds", async () => {
    const closed = [task("d", { status: "done", updatedAt: minutesAgo(1) }), task("c", { status: "coding" })];
    await render(closed, "/board?status=coding", [], "ok", { closedMore: true, onLoadOlder: async () => {} });
    expect(cardIds("coding")).toEqual(["c"]);
    expect(host.querySelector('[data-testid^="board-column-load-older-"]')).toBeNull();
    await act(() => root.unmount());
    host.remove();
    // A closed status still offers it.
    await render(closed, "/board?status=done", [], "ok", { closedMore: true, onLoadOlder: async () => {} });
    expect(host.querySelector('[data-testid="board-column-load-older-done"]')).not.toBeNull();
  });

  test("a Load older press that sends no read neither expands the column nor shows it loading", async () => {
    let presses = 0;
    const few = [task("d0", { status: "done", updatedAt: minutesAgo(1) })];
    const { rerender } = await render(few, "/board", [], "ok", {
      closedMore: true,
      onLoadOlder: () => {
        presses++;
        return undefined;
      },
    });
    const load = () => host.querySelector('[data-testid="board-column-load-older-done"]') as unknown as HTMLButtonElement;
    await act(async () => load().click());
    expect(presses).toBe(1);
    expect(load().textContent).toBe("Load older");
    expect(load().disabled).toBe(false);
    // More cards arriving later stay under the cap: the press didn't expand the column.
    await rerender(Array.from({ length: CLOSED_COLUMN_CAP + 2 }, (_, i) => task(`d${i}`, { status: "done", updatedAt: minutesAgo(i + 1) })));
    expect(cardIds("done").length).toBe(CLOSED_COLUMN_CAP);
    expect(host.querySelector('[data-testid="board-column-older-done"]')?.textContent).toBe("+2 older");
  });

  test("a closed column's +N older button expands it to every loaded card and collapses it again", async () => {
    const done = Array.from({ length: CLOSED_COLUMN_CAP + 3 }, (_, i) =>
      task(`d${i}`, { status: "done", updatedAt: minutesAgo(i + 1) })
    );
    await render(done);
    expect(cardIds("done").length).toBe(CLOSED_COLUMN_CAP);
    const older = () => host.querySelector('[data-testid="board-column-older-done"]') as unknown as HTMLButtonElement;
    expect(older().tagName).toBe("BUTTON");
    expect(older().textContent).toBe("+3 older");
    await act(async () => older().click());
    expect(cardIds("done").length).toBe(CLOSED_COLUMN_CAP + 3);
    expect(older().getAttribute("aria-expanded")).toBe("true");
    expect(older().textContent).toBe("Show fewer");
    await act(async () => older().click());
    expect(cardIds("done").length).toBe(CLOSED_COLUMN_CAP);
    expect(older().textContent).toBe("+3 older");
  });

  test("filters by the URL's status, as /tickets?view=dismissed opens it", async () => {
    await render(
      [
        task("open", { source: "ticket", sourceId: "tk1", status: "queued" }),
        task("dismissed", { source: "ticket", sourceId: "tk2", status: "failed", flag: "cancelled" }),
      ],
      "/board?source=ticket&status=failed"
    );
    expect(cardIds("failed")).toEqual(["dismissed"]);
    expect(cardIds("queued")).toEqual([]);
    expect((host.querySelector('[data-testid="board-status"]') as unknown as HTMLSelectElement).value).toBe("failed");
    await change('[data-testid="board-status"]', "");
    expect(cardIds("queued")).toEqual(["open"]);
  });

  test("a team-scoped or refused list read shows its own sign-in notice; a read list shows none", async () => {
    const cases = [
      { state: "team" as const, below: true, lead: "Sign in to the console to see your Persona's jobs here." },
      { state: "refused" as const, below: false, lead: "You're not signed in, so the board can't show your Persona's jobs or the ticket queue." },
    ];
    for (const c of cases) {
      await render([task("t", { source: "ticket", sourceId: "tk1" })], "/board", [], c.state);
      const notice = host.querySelector('[data-testid="board-list-notice"]');
      const text = notice?.textContent ?? "";
      expect({ state: notice?.getAttribute("data-state"), lead: text.startsWith(c.lead) }).toEqual({ state: c.state, lead: true });
      expect({ state: c.state, refusedWording: text.includes("refused") }).toEqual({ state: c.state, refusedWording: false });
      expect({ state: c.state, link: text.includes("bun run scripts/console-login.ts --user <you>") }).toEqual({ state: c.state, link: true });
      // Only a team-scoped read has a ticket queue to show below.
      expect({ state: c.state, below: text.includes("shows below") }).toEqual({ state: c.state, below: c.below });
      await act(() => root.unmount());
      host.remove();
    }
    await render([task("t")], "/board", [], "ok");
    expect(host.querySelector('[data-testid="board-list-notice"]')).toBeNull();
  });
});
