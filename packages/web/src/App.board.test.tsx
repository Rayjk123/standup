import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import type { BoardConflict, BoardTaskWithConflicts, HelloOkPayload, Lens, Session, Snapshot, Ticket, WsMessage } from "@standup/shared";
import {
  BOARD_CONFLICT_REFRESH_MAX_WAIT_MS,
  BOARD_CONFLICT_REFRESH_MS,
  BOARD_READ_RETRY_MS,
  BOARD_READ_TIMEOUT_MS,
  closedOrder,
} from "./lib/board";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before App and react-dom load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Element",
  "Text",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "matchMedia",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const saved = new Map<string, unknown>();
const realFetch = globalThis.fetch;
const realWebSocket = (globalThis as Record<string, unknown>).WebSocket;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let App: typeof import("./App").default;
let router: typeof import("react-router-dom");

/** The live socket the console dials; a test pushes frames into the newest one. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(message: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const LIST_ROUTES = [
  "/api/projects",
  "/api/sessions",
  "/api/checkpoints",
  "/api/asks/pending",
  "/api/launches",
  "/api/tickets",
  "/api/task-runs",
  "/api/review-findings",
];

// What the stubbed board list route serves, how often it was read, the
// status it answers with, and an optional gate each read waits on. The scope
// and closedMore ride on the list; a closedBefore read is a closed page,
// served from boardClosed (in updatedAt DESC, id DESC order, strictly past the
// closedBefore/closedBeforeId cursor) with pageScope, after pageGate, and its
// query recorded in closedPageReads; a body queued in pageQueue answers the
// next page read instead.
let boardList: BoardTaskWithConflicts[] = [];
let boardReads = 0;
let boardStatus = 200;
let boardGate: Promise<void> | null = null;
let boardScope: "user" | "team" = "user";
let boardClosedMore = false;
let boardClosed: BoardTaskWithConflicts[] = [];
let closedPageReads: Record<string, string>[] = [];
let pageGate: Promise<void> | null = null;
let pageScope: "user" | "team" = "user";
let pageQueue: unknown[] = [];
let networkDown = false;
// The board's change counter the version route and each list read report,
// how often the version route was read, and whether list reads hang until
// their signal aborts them (a read stuck on a dead connection).
let boardVersion = 0;
let versionReads = 0;
let boardHang = false;
// Each list read's query string (a closed page's excluded), in order, and how
// often the Review tab's pending count was read.
let boardListQueries: string[] = [];
let pendingCountReads = 0;
// Every request's path and query, in order, and whether the persona routes
// serve the viewer ("tester") their own running Persona.
let fetchLog: string[] = [];
let personaOwner = false;
// Whether the You sections' own reads get real shapes: the orchestration
// routes an empty editor, the rest a 404 each section reports in place.
let youServed = false;

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    fetchLog.push(path + url.search);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/board/version") {
      versionReads++;
      if (networkDown) throw new TypeError("Failed to fetch");
      return json({ version: `boot.${boardVersion}` });
    }
    if (path === "/api/board/tasks" && url.searchParams.get("closedBefore") === null) boardListQueries.push(url.search);
    if (path === "/api/board/tasks" && boardHang && url.searchParams.get("closedBefore") === null) {
      boardReads++;
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
      });
    }
    if (path === "/api/board/tasks") {
      if (networkDown) throw new TypeError("Failed to fetch");
      const closedBefore = url.searchParams.get("closedBefore");
      if (closedBefore !== null) {
        closedPageReads.push(Object.fromEntries(url.searchParams));
        const beforeAt = new Date(closedBefore).getTime();
        const beforeId = url.searchParams.get("closedBeforeId") ?? "";
        const queued = pageQueue.shift();
        if (queued !== undefined) return json(queued);
        const source = url.searchParams.get("source");
        const status = url.searchParams.get("status");
        const older = boardClosed
          .slice()
          .sort(closedOrder)
          .filter((t) => {
            const at = new Date(t.updatedAt).getTime();
            return (at < beforeAt || (at === beforeAt && t.id < beforeId)) && (!source || t.source === source) && (!status || t.status === status);
          });
        const page = older.slice(0, Number(url.searchParams.get("closedLimit") ?? ""));
        const scope = pageScope;
        if (pageGate) await pageGate;
        const last = page.at(-1);
        const next = last ? { nextClosedBefore: last.updatedAt, nextClosedBeforeId: last.id } : { nextClosedBefore: closedBefore, nextClosedBeforeId: beforeId };
        return json({ tasks: page, scope, more: older.length > page.length, ...next });
      }
      boardReads++;
      // The response is what the route held when the read arrived, filtered by status as the route does.
      const statuses = url.searchParams.get("status")?.split(",");
      const served = statuses ? boardList.filter((t) => statuses.includes(t.status)) : boardList;
      const status = boardStatus;
      const scope = boardScope;
      const closedMore = boardClosedMore;
      const version = `boot.${boardVersion}`;
      if (boardGate) await boardGate;
      if (status !== 200) return json({ error: "sign in" }, status);
      return json(scope === "team" ? { tasks: served, scope, version } : { tasks: served, scope, closedMore, version });
    }
    if (path === "/api/reviews/pending-count") {
      pendingCountReads++;
      return json({ count: 0 });
    }
    if (path === "/api/reviews") return json({ reviews: [] });
    if (LIST_ROUTES.includes(path)) return json([]);
    if (personaOwner && path.startsWith("/api/persona")) {
      if (path === "/api/persona/state") {
        return json({ owner: "tester", runState: "idle", threadId: "t1", epoch: 1, pendingInbox: 0, activeLaunches: 0, maxActiveLaunches: 4 });
      }
      const list = path.slice("/api/persona/".length);
      return json({ [list]: [] });
    }
    if (path.startsWith("/api/persona")) return json({ error: "not found" }, 404);
    if (youServed) {
      if (path === "/api/orchestration/profiles") return json({ profiles: [] });
      if (path === "/api/orchestration/default") return json({ name: null });
      if (/^\/api\/(usage\/me|notify-prefs|public-knowledge)/.test(path)) return json({ error: "not found" }, 404);
    }
    return json({});
  }) as typeof fetch;
}

const emptySnapshot: Snapshot = {
  projects: [],
  sessions: [],
  checkpoints: [],
  asks: [],
  launches: [],
  tickets: [],
  actors: [],
};

function frame(type: string, payload: unknown): WsMessage {
  return { type, payload, timestamp: new Date().toISOString() } as WsMessage;
}

function task(id: string, over: Partial<BoardTaskWithConflicts> = {}): BoardTaskWithConflicts {
  return {
    id,
    source: "job",
    sourceId: `src-${id}`,
    owner: "tester",
    title: `Task ${id}`,
    status: "coding",
    links: {},
    areas: { files: [], packages: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const conflict: BoardConflict = {
  taskId: "b",
  title: "Other",
  status: "coding",
  reasons: [{ kind: "packages", overlap: ["packages/web"] }],
  score: 0.4,
};

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  router = await import("react-router-dom");
  ({ default: App } = await import("./App"));
  stubFetch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  // A fake clock left installed would stall every later DOM file's waits, so it goes even when unmount throws.
  try {
    await act(() => root?.unmount());
  } finally {
    jest.useRealTimers();
  }
  host?.remove();
  FakeSocket.instances = [];
  boardList = [];
  boardReads = 0;
  boardStatus = 200;
  boardGate = null;
  boardScope = "user";
  boardClosedMore = false;
  boardClosed = [];
  closedPageReads = [];
  pageGate = null;
  pageScope = "user";
  pageQueue = [];
  networkDown = false;
  boardVersion = 0;
  versionReads = 0;
  boardHang = false;
  boardListQueries = [];
  pendingCountReads = 0;
  fetchLog = [];
  personaOwner = false;
  youServed = false;
  // App records the hello-ok viewer module-wide; later files' views would ignore frames addressed to anyone else.
  (await import("./lib/pipelineUpdates")).setPipelineViewer(null);
});

// Captured at load, so the turn stays a real one whatever the fake clock
// replaces: it lets the fetch stub's responses and React's work land while
// fake time stands still.
const realSetImmediate = globalThis.setImmediate;
const turn = () => new Promise<void>((r) => realSetImmediate(() => r()));

/** The fake clock's step: each step's timers fire, then what they started gets one real turn to settle before the next. */
const FAKE_STEP_MS = 25;

/** Lets `ms` pass: on the fake clock step by step, otherwise as a real wait. */
async function wait(ms: number) {
  if (!jest.isFakeTimers()) {
    await act(async () => new Promise((r) => setTimeout(r, ms)));
    return;
  }
  for (let left = ms; left > 0; left -= FAKE_STEP_MS) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(left, FAKE_STEP_MS));
      await turn();
    });
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await wait(5);
}

async function until(check: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await settle();
}

async function boot(path: string, snapshot: Snapshot = emptySnapshot): Promise<FakeSocket> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter } = router;
  await act(() => root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(App))));
  const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!ws) throw new Error("App opened no socket");
  const hello: HelloOkPayload = { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot, epoch: "e1" };
  await act(async () => {
    ws.open();
    ws.push(frame("hello-ok", hello));
  });
  await settle();
  return ws;
}

const drawer = () => host.querySelector('[data-testid="live-workers"]');

function workerSession(id: string, title: string): Session {
  return { id, projectId: "p", title, cwd: "/tmp", status: "running", startedAt: new Date(), owned: true } as Session;
}

/** A read only the Work view (inside the Live workers drawer) sends: its panels' polls and a session's detail. */
const isWorkRead = (url: string) =>
  /^\/api\/(plans\/pending|settings|persona\/commitments|pipeline\/runs|launches\/[^/?]+)/.test(url) ||
  /^\/api\/sessions\/[^/]+\/(transcript|pending-ask|participants)/.test(url);

const inColumn = (status: string, id: string) =>
  !!host.querySelector(`[data-testid="board-column-${status}"] [data-testid="board-card-${id}"]`);

// The board's debounces, read timeout and retry backoff run on a fake clock,
// so a test waits them out without the real seconds.
describe("App board", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.now() });
  });

  test("the Board is a top-level tab right after Schedules, there is no Work tab, and /tickets opens it filtered to tickets", async () => {
    boardList = [task("j"), task("t", { source: "ticket", sourceId: "tk1" })];
    await boot("/tickets");
    const tabs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(tabs.indexOf("/board")).toBe(tabs.indexOf("/schedules") + 1);
    expect(tabs).not.toContain("/work");
    await until(() => !!host.querySelector('[data-testid="board-source"]'));
    expect((host.querySelector('[data-testid="board-source"]') as unknown as HTMLSelectElement).value).toBe("ticket");
    await until(() => inColumn("coding", "t"));
    expect(inColumn("coding", "t")).toBe(true);
    expect(inColumn("coding", "j")).toBe(false);
    expect(drawer()?.getAttribute("data-open")).toBe("false");
  });

  test("You is the bar's far-end button, not a tab, there is no Settings gear, and /settings opens You's Workspace settings", async () => {
    youServed = true;
    await boot("/settings");
    expect(host.querySelector('[aria-label="Settings"]')).toBeNull();
    const links = [...host.querySelectorAll("a")];
    const you = links.filter((a) => a.getAttribute("href") === "/you");
    expect(you).toHaveLength(1);
    expect(you[0].textContent).toContain("You");
    expect(you[0].getAttribute("aria-label")).toBe("You and settings");
    // Nothing follows it in the bar: it closes the row the tabs sit in.
    expect(you[0].nextElementSibling).toBeNull();
    // /settings lands in You (its sections are YouView's own tests), and the
    // Workspace section's toggles read the host-wide settings.
    await until(() => you[0].getAttribute("aria-current") === "page");
    expect(you[0].getAttribute("aria-current")).toBe("page");
    const currentSection = () => host.querySelector('nav[aria-label="You sections"] a[aria-current="page"]');
    await until(() => !!currentSection());
    expect(currentSection()?.getAttribute("href")).toBe("/you/workspace");
    await until(() => fetchLog.includes("/api/settings"));
    expect(fetchLog).toContain("/api/settings");
    expect(host.querySelector('[data-testid="board-source"]')).toBeNull();
  });

  test("/work/s/<id> opens the Board with the Live workers drawer open on that session", async () => {
    const snapshot = { ...emptySnapshot, sessions: [workerSession("sess-redirect", "Redirected worker")] };
    await boot("/work/s/sess-redirect", snapshot);
    await until(() => drawer()?.getAttribute("data-open") === "true");
    expect(drawer()?.getAttribute("data-open")).toBe("true");
    expect(host.querySelector('[data-testid="board-search"]')).not.toBeNull();
    await until(() => fetchLog.some((u) => u.startsWith("/api/sessions/sess-redirect/transcript/events")));
    expect(fetchLog.some((u) => u.startsWith("/api/sessions/sess-redirect/transcript/events"))).toBe(true);
    expect(drawer()?.textContent).toContain("Redirected worker");
  });

  test("/work opens the drawer on the filtered list, and Show all sessions lists every session", async () => {
    personaOwner = true;
    const snapshot = { ...emptySnapshot, sessions: [workerSession("sess-free", "Untied terminal")] };
    await boot("/work", snapshot);
    await until(() => !!host.querySelector('[data-testid="live-workers-show-all"]'));
    // Persona has no jobs here, so nothing is tied to them and the filtered list is empty.
    expect(drawer()?.querySelector('[data-testid="live-workers-empty"]')).not.toBeNull();
    expect(drawer()?.textContent).not.toContain("Untied terminal");
    await act(async () => (host.querySelector('[data-testid="live-workers-show-all"]') as unknown as HTMLElement).click());
    await until(() => !!drawer()?.textContent?.includes("Untied terminal"));
    expect(drawer()?.textContent).toContain("Untied terminal");
    expect(host.querySelector('[data-testid="live-workers-show-all"]')?.getAttribute("aria-checked")).toBe("true");
  });

  test("an open job card's worker is listed with its job and stage, and Esc collapses the drawer", async () => {
    personaOwner = true;
    boardList = [task("j1", { title: "Ship the drawer", stage: "coding", links: { jobId: "job-1", sessionIds: ["sess-tied"] } })];
    const snapshot = { ...emptySnapshot, sessions: [workerSession("sess-tied", "Tied worker"), workerSession("sess-other", "Other terminal")] };
    await boot("/board?workers=1", snapshot);
    await until(() => !!drawer()?.querySelector('[data-testid="live-worker-tie"]'));
    expect(drawer()?.querySelector('[data-testid="live-worker-tie"]')?.textContent).toContain("job · Ship the drawer");
    expect(drawer()?.textContent).toContain("Tied worker");
    expect(drawer()?.textContent).not.toContain("Other terminal");
    // Esc from inside the Work view (a row, a menu) leaves the drawer open.
    const row = drawer()?.querySelector("#live-workers-panel button") as unknown as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    expect(drawer()?.getAttribute("data-open")).toBe("true");
    const toggle = () => host.querySelector('[data-testid="live-workers-toggle"]') as unknown as HTMLElement;
    await act(async () => {
      toggle().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    await until(() => drawer()?.getAttribute("data-open") === "false");
    expect(drawer()?.getAttribute("data-open")).toBe("false");
    await settle();
    expect(document.activeElement).toBe(toggle());
  });

  test("a viewer without a Persona lands on the drawer showing every session", async () => {
    // A teammate: no Persona of their own, and the Board serves them only the team's tasks.
    boardScope = "team";
    const snapshot = { ...emptySnapshot, sessions: [workerSession("sess-free", "Untied terminal")] };
    await boot("/", snapshot);
    await until(() => !!drawer()?.textContent?.includes("Untied terminal"));
    // No Persona of their own to filter to: every session, and no switch.
    expect(host.querySelector('[data-testid="live-workers-show-all"]')).toBeNull();
    // Commitments are the owner's: none is read for this viewer.
    expect(fetchLog.some((u) => u.startsWith("/api/persona/commitments"))).toBe(false);
  });

  test("the collapsed drawer sends no Work data request; opening it reads, and collapsing it stops the polling", async () => {
    personaOwner = true;
    const snapshot = { ...emptySnapshot, sessions: [workerSession("sess-quiet", "Quiet worker")] };
    await boot("/board", snapshot);
    await until(() => !!host.querySelector('[data-testid="live-workers-toggle"]'));
    // Past every Work poll's period (plans 15 s, settings 5 s, commitments 15 s).
    await wait(20_000);
    expect(fetchLog.filter(isWorkRead)).toEqual([]);
    expect(drawer()?.getAttribute("data-open")).toBe("false");

    await act(async () => (host.querySelector('[data-testid="live-workers-toggle"]') as unknown as HTMLElement).click());
    await until(() => fetchLog.some((u) => u.startsWith("/api/plans/pending")));
    expect(fetchLog.some((u) => u.startsWith("/api/plans/pending"))).toBe(true);
    expect(fetchLog.some((u) => u.startsWith("/api/persona/commitments"))).toBe(true);

    await act(async () => (host.querySelector('[data-testid="live-workers-toggle"]') as unknown as HTMLElement).click());
    expect(drawer()?.getAttribute("data-open")).toBe("false");
    await settle();
    fetchLog = [];
    await wait(20_000);
    expect(fetchLog.filter(isWorkRead)).toEqual([]);
  });

  test("a board:task frame moves its card, keeps its conflicts, and re-reads the list once after the burst", async () => {
    boardList = [task("a", { conflicts: [conflict] })];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    expect(inColumn("coding", "a")).toBe(true);
    const readsAfterBoot = boardReads;
    expect(host.querySelector('[data-testid="board-tab-badge"]')).toBeNull();

    // The list route keeps serving the old state, so the card's place comes from the frames.
    await act(async () => {
      ws.push(frame("board:task", { task: task("a", { status: "validation" }) }));
      ws.push(frame("board:task", { task: task("a", { status: "waiting", waitingOn: "owner approval" }) }));
    });
    await settle();
    expect(inColumn("waiting", "a")).toBe(true);
    expect(host.querySelector('[data-testid="board-conflicts-a"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="board-tab-badge"]')?.textContent).toBe("1");
    expect(boardReads).toBe(readsAfterBoot);

    boardList = [task("a", { status: "waiting" })];
    await until(() => boardReads > readsAfterBoot, BOARD_CONFLICT_REFRESH_MS + 1000);
    expect(boardReads).toBe(readsAfterBoot + 1);
    await until(() => !host.querySelector('[data-testid="board-conflicts-a"]'));
    expect(host.querySelector('[data-testid="board-conflicts-a"]')).toBeNull();
  });

  test("a removal frame drops the card", async () => {
    boardList = [task("a")];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    await act(async () => ws.push(frame("board:task", { removed: { id: "a" } })));
    await settle();
    expect(host.querySelector('[data-testid="board-card-a"]')).toBeNull();
  });

  const queuedTicket: Ticket = {
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

  const notice = () => host.querySelector('[data-testid="board-list-notice"]');
  const cardCount = () => host.querySelectorAll('[data-testid^="board-card-"]').length;

  test("a team-scoped list shows the team's ticket cards under the sign-in notice", async () => {
    boardScope = "team";
    boardList = [task("ticket:tk2", { source: "ticket", sourceId: "tk2", owner: "", status: "queued" })];
    await boot("/board", { ...emptySnapshot, tickets: [queuedTicket] });
    await until(() => inColumn("queued", "ticket:tk2"));
    expect(inColumn("queued", "ticket:tk2")).toBe(true);
    expect(notice()?.getAttribute("data-state")).toBe("team");
    expect(notice()?.textContent).toContain("Sign in to the console to see your Persona's jobs");
    // The held ticket the route didn't serve gets no card.
    expect(host.querySelector('[data-testid="board-card-ticket:tk1"]')).toBeNull();
    expect(cardCount()).toBe(1);
  });

  test("a read list is the board, and no card is built from the held tickets", async () => {
    boardList = [task("job:j1")];
    await boot("/board", { ...emptySnapshot, tickets: [queuedTicket] });
    await until(() => inColumn("coding", "job:j1"));
    expect(inColumn("coding", "job:j1")).toBe(true);
    expect(host.querySelector('[data-testid="board-card-ticket:tk1"]')).toBeNull();
    expect(cardCount()).toBe(1);
    expect(notice()).toBeNull();
  });

  test("a refused list read shows the sign-in notice and no cards built from the held tickets", async () => {
    boardStatus = 403;
    await boot("/board", { ...emptySnapshot, tickets: [queuedTicket] });
    await until(() => notice()?.getAttribute("data-state") === "refused");
    expect(notice()?.getAttribute("data-state")).toBe("refused");
    expect(cardCount()).toBe(0);
  });

  test("a network failure before any read succeeded shows the failed notice, then retries until the board fills in", async () => {
    networkDown = true;
    boardList = [task("a")];
    await boot("/board", { ...emptySnapshot, tickets: [queuedTicket] });
    await until(() => notice()?.getAttribute("data-state") === "failed");
    expect(notice()?.getAttribute("data-state")).toBe("failed");
    expect(notice()?.textContent).toContain("Retrying");
    expect(cardCount()).toBe(0);
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).not.toContain("0 tasks");

    // No reconnect, no reload: the next retry lands the board.
    networkDown = false;
    await until(() => inColumn("coding", "a"), BOARD_READ_RETRY_MS[0]! + 1500);
    expect(inColumn("coding", "a")).toBe(true);
    expect(notice()).toBeNull();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("a collector without the board routes says so, and is not asked again on the failure backoff", async () => {
    boardStatus = 404;
    await boot("/board");
    await until(() => notice()?.getAttribute("data-state") === "unavailable");
    expect(notice()?.textContent).toContain("doesn't serve the board");
    const reads = boardReads;
    await wait(BOARD_READ_RETRY_MS[0]! + 300);
    expect(boardReads).toBe(reads);
  });

  test("off the Board, a hello-ok reads only the waiting tasks the badge counts; opening the Board reads the whole list", async () => {
    boardList = [task("a"), task("w", { status: "waiting" }), task("d", { status: "done" })];
    const ws = await boot("/persona");
    expect(boardListQueries).toEqual(["?status=waiting&open=1"]);
    await until(() => !!host.querySelector('[data-testid="board-tab-badge"]'));
    expect(host.querySelector('[data-testid="board-tab-badge"]')?.textContent).toBe("1");

    // A reconnect before the Board opens reads only the waiting tasks again.
    await act(async () => {
      ws.push(frame("hello-ok", { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e1" }));
    });
    await settle();
    expect(boardListQueries).toEqual(["?status=waiting&open=1", "?status=waiting&open=1"]);

    const tab = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/board");
    if (!tab) throw new Error("no Board tab");
    await act(async () => (tab as unknown as HTMLElement).click());
    await until(() => inColumn("coding", "a") && inColumn("done", "d"), 3000);
    expect(boardListQueries.at(-1)).toBe("");
    expect(inColumn("waiting", "w")).toBe(true);
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("3 tasks");
    expect(host.querySelector('[data-testid="board-tab-badge"]')?.textContent).toBe("1");

    // Once it has opened, a reconnect reads the whole list, and frames keep it live.
    const reads = boardListQueries.length;
    await act(async () => {
      ws.push(frame("hello-ok", { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e1" }));
    });
    await settle();
    expect(boardListQueries.slice(reads)).toEqual([""]);
    await act(async () => {
      ws.push(frame("board:task", { task: task("a", { status: "waiting" }) }));
    });
    await until(() => inColumn("waiting", "a"));
    expect(inColumn("waiting", "a")).toBe(true);
    expect(host.querySelector('[data-testid="board-tab-badge"]')?.textContent).toBe("2");
  });

  test("a console loaded on the Board reads the whole list once, not the waiting tasks first", async () => {
    boardList = [task("a"), task("w", { status: "waiting" })];
    await boot("/board");
    await until(() => inColumn("coding", "a"));
    expect(boardListQueries).toEqual([""]);
  });

  test("a console loaded on /tickets reads the whole list once too", async () => {
    boardList = [task("t", { source: "ticket", sourceId: "tk1" })];
    await boot("/tickets");
    await until(() => inColumn("coding", "t"));
    expect(boardListQueries).toEqual([""]);
  });

  test("a whole-list read that fails over the waiting tasks shows the failure, then fills in", async () => {
    boardList = [task("a"), task("w", { status: "waiting" })];
    await boot("/persona");
    await until(() => !!host.querySelector('[data-testid="board-tab-badge"]'));
    networkDown = true;
    const tab = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/board");
    if (!tab) throw new Error("no Board tab");
    await act(async () => (tab as unknown as HTMLElement).click());
    const notice = () => host.querySelector('[data-testid="board-list-notice"]');
    await until(() => notice()?.getAttribute("data-state") === "failed", 3000);
    expect(notice()?.getAttribute("data-state")).toBe("failed");
    networkDown = false;
    await wait(BOARD_READ_RETRY_MS[0]! + 300);
    await until(() => inColumn("coding", "a"));
    expect(inColumn("coding", "a")).toBe(true);
    expect(notice()).toBeNull();
  });

  test("while only the waiting tasks have loaded, the Board says it is loading", async () => {
    boardList = [task("a"), task("w", { status: "waiting" })];
    await boot("/persona");
    await until(() => !!host.querySelector('[data-testid="board-tab-badge"]'));
    // The whole list's read hangs until released.
    let release!: () => void;
    boardGate = new Promise<void>((r) => (release = r));
    const tab = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/board");
    if (!tab) throw new Error("no Board tab");
    await act(async () => (tab as unknown as HTMLElement).click());
    await until(() => !!host.querySelector('[data-testid="board-count"]'), 3000);
    await settle();
    // The waiting card alone is not the board.
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("loading…");
    expect(host.querySelector('[data-testid="board-column-load-older-done"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-list-notice"]')?.getAttribute("data-state")).toBe("pending");
    await act(async () => release());
    await until(() => inColumn("coding", "a"));
    expect(host.querySelector('[data-testid="board-list-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("2 tasks");
  });

  test("the catch-up's pending-count reads wait for the hello-ok", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const { MemoryRouter } = router;
    await act(() => root.render(createElement(MemoryRouter, { initialEntries: ["/persona"] }, createElement(App))));
    // Past one catch-up interval, before the REST fallback, and with a focus wake: no read yet.
    await wait(1000);
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await wait(1200);
    expect(pendingCountReads).toBe(0);
    const ws = FakeSocket.instances.at(-1)!;
    await act(async () => {
      ws.open();
      ws.push(frame("hello-ok", { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e1" }));
    });
    await settle();
    const afterHello = pendingCountReads;
    expect(afterHello).toBeGreaterThanOrEqual(1);
    await wait(2100);
    expect(pendingCountReads).toBeGreaterThan(afterHello);
  });

  test("the Board renders on first navigation from another tab, with no reload", async () => {
    boardList = [task("a"), task("b", { status: "in_review" })];
    await boot("/persona");
    expect(host.querySelector('[data-testid="board-count"]')).toBeNull();
    const tab = [...host.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/board");
    if (!tab) throw new Error("no Board tab");
    await act(async () => (tab as unknown as HTMLElement).click());
    // The view's chunk loads on first open; the cards come from the read hello-ok started.
    await until(() => inColumn("coding", "a") && inColumn("in_review", "b"), 3000);
    expect(inColumn("coding", "a")).toBe(true);
    expect(inColumn("in_review", "b")).toBe(true);
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("2 tasks");
    expect(notice()).toBeNull();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test("while the first read is in flight the board says it is loading, never a silent 0 tasks", async () => {
    let release!: () => void;
    boardGate = new Promise((r) => (release = r));
    boardList = [task("a")];
    await boot("/board");
    await until(() => !!notice());
    expect(notice()?.getAttribute("data-state")).toBe("pending");
    expect(notice()?.textContent).toContain("Loading the board");
    expect(host.querySelector('[data-testid="board-count"]')?.textContent).toBe("loading…");
    await act(async () => release());
    await until(() => inColumn("coding", "a"));
    expect(notice()).toBeNull();
  });

  test("a read that hangs times out and is retried, and the board fills in without a reload", async () => {
    boardHang = true;
    boardList = [task("a")];
    await boot("/board");
    const hung = boardReads;
    expect(hung).toBe(1);
    expect(notice()?.getAttribute("data-state")).toBe("pending");
    boardHang = false;
    // Short of the read timeout the hung read is still waited on.
    await wait(BOARD_READ_TIMEOUT_MS - 500);
    expect(boardReads).toBe(hung);
    expect(notice()?.getAttribute("data-state")).toBe("pending");
    // Past it the hung read fails; the retry reads again.
    await until(() => inColumn("coding", "a"), BOARD_READ_RETRY_MS[0]! + 2000);
    expect(inColumn("coding", "a")).toBe(true);
    expect(boardReads).toBe(hung + 1);
    expect(notice()).toBeNull();
  });

  test("a board:task frame the socket lost still shows: the catch-up sees the version move and re-reads once", async () => {
    boardVersion = 3;
    boardList = [task("a")];
    await boot("/board");
    await until(() => inColumn("coding", "a"));
    const reads = boardReads;
    // Nothing moved: the catch-up's version reads re-read nothing.
    await until(() => versionReads >= 1, 3000);
    await settle();
    expect(boardReads).toBe(reads);

    // The card moved on the collector, and its frame never arrived.
    boardList = [task("a", { status: "validation" })];
    boardVersion = 4;
    await until(() => inColumn("validation", "a"), 3000);
    expect(inColumn("validation", "a")).toBe(true);
    expect(boardReads).toBe(reads + 1);
    const versionsSeen = versionReads;
    await until(() => versionReads > versionsSeen, 3000);
    await settle();
    expect(boardReads).toBe(reads + 1);
  });

  test("Load older pages closed tasks in before the oldest loaded one, until the route has no more", async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    boardList = [task("open"), task("d0", { status: "done", updatedAt: minutesAgo(10) })];
    boardClosedMore = true;
    boardClosed = [
      task("f1", { status: "failed", updatedAt: minutesAgo(20) }),
      task("d2", { status: "done", updatedAt: minutesAgo(30) }),
    ];
    await boot("/board");
    await until(() => inColumn("done", "d0"));
    const loadButton = () => host.querySelector('[data-testid="board-column-load-older-done"]') as unknown as HTMLElement | null;
    expect(loadButton()).not.toBeNull();
    await act(async () => loadButton()!.click());
    await until(() => inColumn("failed", "f1") && inColumn("done", "d2"));
    expect(closedPageReads).toEqual([{ closedBefore: boardList[1].updatedAt, closedBeforeId: "d0", closedLimit: "30" }]);
    expect(inColumn("failed", "f1")).toBe(true);
    expect(inColumn("done", "d2")).toBe(true);
    // The page said no more remain.
    expect(loadButton()).toBeNull();
    // A later list re-read keeps the paged-in tasks.
    const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
    const readsBefore = boardReads;
    await act(async () => ws.push(frame("board:task", { task: task("open", { status: "validation" }) })));
    await until(() => boardReads > readsBefore, BOARD_CONFLICT_REFRESH_MS + 1000);
    await settle();
    expect(inColumn("done", "d2")).toBe(true);
    expect(inColumn("failed", "f1")).toBe(true);
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const loadButton = (status = "done") =>
    host.querySelector(`[data-testid="board-column-load-older-${status}"]`) as unknown as HTMLElement | null;
  const cardsWithId = (id: string) => host.querySelectorAll(`[data-testid="board-card-${id}"]`).length;

  test("after Load older, a re-read that pushes the edge closed card past the route's cap keeps it, once", async () => {
    // The route caps the list's closed portion at one task.
    const edge = task("d-edge", { status: "done", updatedAt: minutesAgo(10) });
    boardList = [task("j", { status: "coding" }), edge];
    boardClosedMore = true;
    boardClosed = [task("d-old", { status: "done", updatedAt: minutesAgo(20) })];
    const ws = await boot("/board");
    await until(() => inColumn("done", "d-edge"));
    await act(async () => loadButton()!.click());
    await until(() => inColumn("done", "d-old"));
    // The job closes; the route's list now ends at the job, the edge card past its cap.
    const closed = task("j", { status: "done", updatedAt: minutesAgo(0) });
    boardList = [closed];
    const readsBefore = boardReads;
    await act(async () => ws.push(frame("board:task", { task: closed })));
    await until(() => boardReads > readsBefore, BOARD_CONFLICT_REFRESH_MS + 1000);
    await settle();
    expect(inColumn("done", "j")).toBe(true);
    expect(inColumn("done", "d-edge")).toBe(true);
    expect(cardsWithId("d-edge")).toBe(1);
    expect(inColumn("done", "d-old")).toBe(true);
    // The page started past the edge card, by its updatedAt and id.
    expect(closedPageReads).toEqual([{ closedBefore: edge.updatedAt, closedBeforeId: "d-edge", closedLimit: "30" }]);
  });

  test("Load older pages under the view's active filter", async () => {
    boardList = [task("d0", { status: "done", source: "ticket", sourceId: "tk0", projectId: "standup", updatedAt: minutesAgo(10) })];
    boardClosedMore = true;
    await boot("/board?source=ticket&status=done&project=standup&q=Task");
    await until(() => inColumn("done", "d0"));
    await act(async () => loadButton()!.click());
    await until(() => closedPageReads.length === 1);
    expect(closedPageReads).toEqual([
      {
        closedBefore: boardList[0].updatedAt,
        closedBeforeId: "d0",
        closedLimit: "30",
        status: "done",
        source: "ticket",
        project: "standup",
        q: "Task",
      },
    ]);
  });

  test("Load older starts at the list's own closed edge, not at an older closed card a frame brought in", async () => {
    const closed = (i: number) => task(`c${i}`, { status: "done", updatedAt: minutesAgo(i) });
    boardList = Array.from({ length: 200 }, (_, i) => closed(i + 1));
    boardClosedMore = true;
    const stray = closed(900);
    boardClosed = [...Array.from({ length: 40 }, (_, i) => closed(201 + i)), stray];
    const ws = await boot("/board");
    await until(() => inColumn("done", "c1"));
    // A refined closed card keeps its old updatedAt, so its frame lands far past the list's window.
    await act(async () => ws.push(frame("board:task", { task: stray })));
    await settle();
    await act(async () => (host.querySelector('[data-testid="board-column-older-done"]') as unknown as HTMLElement).click());
    expect(inColumn("done", "c900")).toBe(true);
    await act(async () => loadButton()!.click());
    await until(() => inColumn("done", "c201"));
    expect(closedPageReads[0]).toEqual({ closedBefore: boardList[199].updatedAt, closedBeforeId: "c200", closedLimit: "30" });
    expect(inColumn("done", "c201")).toBe(true);
    expect(inColumn("done", "c230")).toBe(true);
    // The stray card stays shown, once.
    expect(cardsWithId("c900")).toBe(1);
  });

  test("Load older reaches filtered cards older than everything loaded when none loaded matches", async () => {
    const d0 = task("d0", { status: "done", updatedAt: minutesAgo(10) });
    boardList = [task("open"), d0];
    boardClosedMore = true;
    const dismissed = task("ticket:tk-x", { source: "ticket", sourceId: "tk-x", status: "failed", flag: "cancelled", updatedAt: minutesAgo(40) });
    boardClosed = [task("j-old", { status: "done", updatedAt: minutesAgo(20) }), dismissed];
    // The first page matched nothing but says more remain past the row it scanned to.
    const scanned = minutesAgo(30);
    pageQueue = [{ tasks: [], scope: "user", more: true, nextClosedBefore: scanned, nextClosedBeforeId: "j-scan" }];
    await boot("/board?source=ticket&status=failed");
    await until(() => !!loadButton("failed"));
    expect(inColumn("done", "d0")).toBe(false);
    await act(async () => loadButton("failed")!.click());
    await until(() => closedPageReads.length === 1);
    await settle();
    // The cursor is the oldest closed task held under any filter; the route does the filtering.
    expect(closedPageReads[0]).toEqual({ closedBefore: d0.updatedAt, closedBeforeId: "d0", closedLimit: "30", status: "failed", source: "ticket" });
    expect(loadButton("failed")).not.toBeNull();
    await act(async () => loadButton("failed")!.click());
    await until(() => inColumn("failed", "ticket:tk-x"));
    // The second click goes on from where the empty page said to.
    expect(closedPageReads[1]).toEqual({ closedBefore: scanned, closedBeforeId: "j-scan", closedLimit: "30", status: "failed", source: "ticket" });
    expect(inColumn("failed", "ticket:tk-x")).toBe(true);
    expect(cardsWithId("j-old")).toBe(0);
    expect(loadButton("failed")).toBeNull();
  });

  test("switching filter clears the paged-in set, and the next page starts from the list again", async () => {
    const t0 = task("t0", { status: "done", source: "ticket", sourceId: "tk0", updatedAt: minutesAgo(10) });
    const j0 = task("j0", { status: "done", updatedAt: minutesAgo(15) });
    boardList = [t0, j0];
    boardClosedMore = true;
    boardClosed = [
      task("t1", { status: "done", source: "ticket", sourceId: "tk1", updatedAt: minutesAgo(20) }),
      task("j1", { status: "done", updatedAt: minutesAgo(25) }),
    ];
    await boot("/board?source=ticket");
    await until(() => inColumn("done", "t0"));
    await act(async () => loadButton()!.click());
    await until(() => inColumn("done", "t1"));
    // The cursor is the oldest closed task held, whatever the filter.
    expect(closedPageReads).toEqual([{ closedBefore: j0.updatedAt, closedBeforeId: "j0", closedLimit: "30", source: "ticket" }]);
    // The ticket-only page said no more remain.
    expect(loadButton()).toBeNull();

    const select = host.querySelector('[data-testid="board-source"]') as unknown as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(select, "");
      select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
    });
    await settle();
    // The paged-in ticket is gone, and Load older follows the list's closedMore again.
    expect(cardsWithId("t1")).toBe(0);
    expect(inColumn("done", "j0")).toBe(true);
    expect(loadButton()).not.toBeNull();
    await act(async () => loadButton()!.click());
    await until(() => closedPageReads.length === 2);
    // The cursor is the list's own oldest closed task, not the cleared page's.
    expect(closedPageReads[1]).toEqual({ closedBefore: j0.updatedAt, closedBeforeId: "j0", closedLimit: "30" });
    await until(() => inColumn("done", "t1") && inColumn("done", "j1"));
    expect(cardsWithId("t1")).toBe(1);
    expect(inColumn("done", "j1")).toBe(true);
  });

  test("a closed page never brings back a task a frame removed while it was in flight", async () => {
    boardList = [task("d0", { status: "done", updatedAt: minutesAgo(10) })];
    boardClosedMore = true;
    boardClosed = [task("d1", { status: "done", updatedAt: minutesAgo(20) }), task("d2", { status: "done", updatedAt: minutesAgo(30) })];
    const ws = await boot("/board");
    await until(() => inColumn("done", "d0"));
    let release!: () => void;
    pageGate = new Promise((r) => (release = r));
    await act(async () => loadButton()!.click());
    await until(() => closedPageReads.length === 1);
    // The page is in flight: d1 is removed, and a list re-read settles before the page lands.
    const readsBefore = boardReads;
    await act(async () => ws.push(frame("board:task", { removed: { id: "d1" } })));
    await until(() => boardReads > readsBefore, BOARD_CONFLICT_REFRESH_MS + 1000);
    await settle();
    await act(async () => release());
    await until(() => inColumn("done", "d2"));
    expect(inColumn("done", "d2")).toBe(true);
    expect(cardsWithId("d1")).toBe(0);
  });

  test("a closed page is dropped when it isn't the viewer's own or the list state changed under it", async () => {
    const cases = [
      { name: "a team-scoped page", scope: "team" as const, refuseMidPage: false },
      { name: "a read refused while the page was in flight", scope: "user" as const, refuseMidPage: true },
    ];
    for (const c of cases) {
      boardList = [task("d0", { status: "done", updatedAt: minutesAgo(10) })];
      boardClosedMore = true;
      boardStatus = 200;
      boardClosed = [task("d1", { status: "done", updatedAt: minutesAgo(20) })];
      closedPageReads = [];
      pageScope = c.scope;
      const ws = await boot("/board");
      await until(() => inColumn("done", "d0"));
      let release!: () => void;
      pageGate = new Promise((r) => (release = r));
      await act(async () => loadButton()!.click());
      await until(() => closedPageReads.length === 1);
      if (c.refuseMidPage) {
        boardStatus = 403;
        const readsBefore = boardReads;
        await act(async () => ws.push(frame("board:task", { task: task("x", { status: "queued" }) })));
        await until(() => boardReads > readsBefore, BOARD_CONFLICT_REFRESH_MS + 1000);
        await until(() => notice()?.getAttribute("data-state") === "refused");
      }
      await act(async () => release());
      await settle();
      expect({ name: c.name, d1: cardsWithId("d1") }).toEqual({ name: c.name, d1: 0 });
      pageGate = null;
      // afterEach unmounts the last case's root.
      if (c !== cases[cases.length - 1]) {
        await act(() => root.unmount());
        host.remove();
        FakeSocket.instances = [];
      }
    }
  });

  test("an unknown frame type leaves the board as it was", async () => {
    boardList = [task("a")];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    await act(async () => ws.push(frame("review_tunnel:updated", { packetId: "p1", url: "https://tunnel.example.com" })));
    await act(async () => ws.push(frame("board:task", { task: task("a", { status: "validation" }) })));
    await settle();
    expect(inColumn("validation", "a")).toBe(true);
  });

  test("a failed read never holds off an older read still in flight", async () => {
    boardList = [task("a", { status: "coding" })];
    let release!: () => void;
    boardGate = new Promise((r) => (release = r));
    const ws = await boot("/board");
    // The boot read is in flight; a frame's re-read fails first.
    boardGate = null;
    boardStatus = 500;
    await act(async () => ws.push(frame("board:task", { task: task("b", { status: "queued" }) })));
    await until(() => boardReads >= 2, BOARD_CONFLICT_REFRESH_MAX_WAIT_MS + 1000);
    await settle();
    expect(inColumn("coding", "a")).toBe(false);
    await act(async () => release());
    await until(() => inColumn("coding", "a"));
    expect(inColumn("coding", "a")).toBe(true);
    expect(inColumn("queued", "b")).toBe(true);
  });

  test("/tickets?view=dismissed opens the board on dismissed ticket cards", async () => {
    boardList = [
      task("ticket:tk1", { source: "ticket", sourceId: "tk1", status: "queued" }),
      task("ticket:tk2", { source: "ticket", sourceId: "tk2", status: "failed", flag: "cancelled" }),
    ];
    await boot("/tickets?view=dismissed");
    await until(() => inColumn("failed", "ticket:tk2"));
    expect((host.querySelector('[data-testid="board-status"]') as unknown as HTMLSelectElement).value).toBe("failed");
    expect(inColumn("failed", "ticket:tk2")).toBe(true);
    expect(host.querySelector('[data-testid="board-card-ticket:tk1"]')).toBeNull();
  });

  test("a list response keeps a frame applied after its read was issued", async () => {
    boardList = [task("a", { status: "coding" })];
    let release!: () => void;
    boardGate = new Promise((r) => (release = r));
    const ws = await boot("/board");
    // The boot read is in flight; a frame moves the card meanwhile.
    await act(async () => ws.push(frame("board:task", { task: task("a", { status: "in_review" }) })));
    await settle();
    expect(inColumn("in_review", "a")).toBe(true);
    await act(async () => release());
    await settle();
    expect(inColumn("in_review", "a")).toBe(true);
  });

  test("an older list response never lands over a newer one", async () => {
    boardList = [task("a", { status: "coding" })];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    // The frame's re-read is held open, serving the list as it was when it arrived.
    let releaseSlow!: () => void;
    boardGate = new Promise((r) => (releaseSlow = r));
    await act(async () => ws.push(frame("board:task", { task: task("b", { status: "queued" }) })));
    await until(() => boardReads >= 2, BOARD_CONFLICT_REFRESH_MAX_WAIT_MS + 1000);
    // The list moves on and a later frame's re-read answers first.
    boardGate = null;
    boardList = [task("a", { status: "done" }), task("b", { status: "queued" })];
    await act(async () => ws.push(frame("board:task", { task: task("b", { status: "queued" }) })));
    await until(() => inColumn("done", "a"), BOARD_CONFLICT_REFRESH_MAX_WAIT_MS + 1000);
    expect(inColumn("done", "a")).toBe(true);
    await act(async () => releaseSlow());
    await settle();
    expect(inColumn("done", "a")).toBe(true);
    expect(inColumn("queued", "b")).toBe(true);
  });

  test("a steady stream of frames still re-reads the list within the max wait", async () => {
    boardList = [task("a")];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    const readsAfterBoot = boardReads;
    const started = Date.now();
    // A frame every 400ms keeps resetting the debounce.
    while (boardReads === readsAfterBoot && Date.now() - started < BOARD_CONFLICT_REFRESH_MAX_WAIT_MS + 1500) {
      await act(async () => ws.push(frame("board:task", { task: task("a", { title: `t${Date.now()}` }) })));
      await wait(400);
    }
    expect(boardReads).toBe(readsAfterBoot + 1);
    // The frames held the re-read off until the max wait, and no longer.
    expect(Date.now() - started).toBeGreaterThanOrEqual(BOARD_CONFLICT_REFRESH_MAX_WAIT_MS);
    expect(Date.now() - started).toBeLessThan(BOARD_CONFLICT_REFRESH_MAX_WAIT_MS + 800);
  });
});

// A smoke check on real timers: a reconnect's REST resync fills the board, and
// frames on the new socket keep applying after it, with no fake clock driving them.
describe("App board on real timers", () => {
  test("a dropped socket resyncs the board on reconnect, and frames on the new socket keep moving cards", async () => {
    boardList = [task("a")];
    const ws = await boot("/board");
    await until(() => inColumn("coding", "a"));
    const reads = boardReads;

    // While the socket is down the card moves; its frame is lost with the socket.
    await act(async () => {
      ws.readyState = 3;
      ws.onclose?.({ code: 1006 });
    });
    boardList = [task("a", { status: "in_review" })];
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await until(() => FakeSocket.instances.length > 1, 3000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1]!;
    const hello: HelloOkPayload = { protocolVersion: 1, serverSeq: 0, user: "tester", snapshot: emptySnapshot, epoch: "e2" };
    await act(async () => {
      next.open();
      next.push(frame("hello-ok", hello));
    });
    await until(() => inColumn("in_review", "a"));
    expect(inColumn("in_review", "a")).toBe(true);
    expect(boardReads).toBeGreaterThan(reads);

    await act(async () => next.push(frame("board:task", { task: task("a", { status: "done" }) })));
    await settle();
    expect(inColumn("done", "a")).toBe(true);
    // Its waits add up past bun's 5s default; a failure should fail an expect, not time out mid-act.
  }, 10_000);
});
