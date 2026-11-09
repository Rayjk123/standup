import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useReducer } from "react";
import type { Dispatch } from "react";
import type { PersonaApproval, PersonaJob, PersonaMessage, WsMessage } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { initialPersonaViewState, personaReducer, type PersonaAction, type PersonaViewState } from "../lib/persona";

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
const realFetch = globalThis.fetch;

let act: (fn: () => unknown) => Promise<void>;
let createRoot: (el: Element) => Root;
let Thread: typeof import("./PersonaView").Thread;
let PersonaView: typeof import("./PersonaView").PersonaView;
let JobFilterControl: typeof import("./MessageJobTags").JobFilterControl;
let router: typeof import("react-router-dom");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ Thread, PersonaView } = await import("./PersonaView"));
  ({ JobFilterControl } = await import("./MessageJobTags"));
  router = await import("react-router-dom");
  // Messages render through the markdown chunk, not its plain-text stand-in.
  await (await import("./Markdown")).markdownReady;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

function message(seq: number, text: string, extra: Partial<PersonaMessage> = {}): PersonaMessage {
  return {
    id: `m${seq}`,
    threadId: "t1",
    seq,
    role: "persona",
    text,
    createdAt: "2026-10-06T12:00:00.000Z",
    ...extra,
  };
}

function viewState(messages: PersonaMessage[]): PersonaViewState {
  return { ...initialPersonaViewState, loaded: true, threadId: "t1", consoleThreadId: "t1", messages };
}

const noop = () => {};

/**
 * Renders `Thread` the way PersonaView does on every App re-render: a new
 * view state, new lookup maps and a new approval-props object each time.
 */
function renderThread(root: Root, messages: PersonaMessage[], jobs: PersonaJob[] = []) {
  act(() => {
    root.render(
      createElement(Thread, {
        persona: viewState(messages),
        approvalsById: new Map<string, PersonaApproval>(),
        jobsById: new Map(jobs.map((j) => [j.id, j])),
        approvalProps: { busy: new Set<string>(), errors: {}, onDecide: noop },
        narrow: false,
        consoleThread: true,
        onQuickReply: noop,
        onResend: noop,
        onDiscard: noop,
        onRevealJob: noop,
      })
    );
  });
}

/** Stands in for layout: a 1000px-tall thread in a 200px viewport, recording every scrollTop write. */
function fakeScroller(el: HTMLElement): number[] {
  const writes: number[] = [];
  let top = 800;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
      writes.push(v);
    },
  });
  return writes;
}

/** Selects part of the first paragraph's text, as a mouse drag would. */
function selectInside(p: Element) {
  const text = p.firstChild!;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 5);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

describe("Persona thread rendering", () => {
  let host: HTMLElement;
  let root: Root;

  const first = message(1, "First paragraph of the reply.\n\nSecond paragraph, with `code`.");
  const second = message(2, "- one\n- two");
  const job: PersonaJob = {
    id: "j1",
    title: "Fix the thing",
    status: "active",
  } as PersonaJob;

  function setup() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    act(() => root.unmount());
    host.remove();
  });

  test("unchanged messages keep their DOM nodes across updates", () => {
    setup();
    renderThread(root, [first, second], [job]);
    const paragraph = host.querySelector("p")!;
    const code = host.querySelector("code")!;
    const item = host.querySelector("li")!;
    expect(paragraph.textContent).toBe("First paragraph of the reply.");

    // A parent re-render with nothing new (an activity or session frame).
    renderThread(root, [first, second], [job]);
    // A new message arrives, and an unrelated job changes.
    renderThread(root, [first, second, message(3, "Third.")], [{ ...job, status: "done" } as PersonaJob]);

    expect(host.querySelector("p")).toBe(paragraph);
    expect(host.querySelector("code")).toBe(code);
    expect(host.querySelector("li")).toBe(item);
    expect(paragraph.isConnected).toBe(true);
    expect(host.textContent).toContain("Third.");
  });

  test("auto-scroll follows the tail without a selection", () => {
    setup();
    renderThread(root, [first]);
    const writes = fakeScroller(host.firstElementChild as HTMLElement);
    renderThread(root, [first, second]);
    expect(writes).toEqual([1000]);
  });

  test("auto-scroll is suppressed while text in the thread is selected, then catches up", () => {
    setup();
    renderThread(root, [first]);
    const scroller = host.firstElementChild as HTMLElement;
    const writes = fakeScroller(scroller);

    selectInside(host.querySelector("p")!);
    renderThread(root, [first, second]);
    renderThread(root, [first, second, message(3, "Third.")]);
    expect(writes).toEqual([]);
    expect(document.getSelection()!.toString()).toBe("First");

    act(() => {
      document.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(writes).toEqual([1000]);
  });

  test("a selection outside the thread doesn't hold the scroll", () => {
    setup();
    const outside = document.createElement("p");
    outside.textContent = "Elsewhere on the page";
    document.body.appendChild(outside);
    renderThread(root, [first]);
    const writes = fakeScroller(host.firstElementChild as HTMLElement);

    selectInside(outside);
    renderThread(root, [first, second]);
    expect(writes).toEqual([1000]);
    outside.remove();
  });

  test("attached images render inline from the collector's attachment route, with their captions", () => {
    setup();
    const withImages = message(4, "Here is the settings history page.", {
      attachments: [
        { id: "a-1", mimeType: "image/png", bytes: 1200, name: "ui-settings-history.png", caption: "Settings history, after the fix" },
        { id: "a/2", mimeType: "image/jpeg", bytes: 800, name: "before.jpg" },
      ],
    });
    renderThread(root, [withImages]);
    const images = [...host.querySelectorAll("img")];
    expect(images.map((i) => i.getAttribute("src"))).toEqual(["/api/persona/attachments/a-1", "/api/persona/attachments/a%2F2"]);
    expect(images.map((i) => i.getAttribute("alt"))).toEqual(["Settings history, after the fix", "before.jpg"]);
    expect(host.querySelector("figcaption")!.textContent).toBe("Settings history, after the fix");
    const link = host.querySelector("figure a")!;
    expect(link.getAttribute("href")).toBe("/api/persona/attachments/a-1");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(host.textContent).toContain("Here is the settings history page.");
  });

  test("a reply that is only images renders no empty text block", () => {
    setup();
    renderThread(root, [message(5, "", { attachments: [{ id: "a3", mimeType: "image/gif", bytes: 10, name: "x.gif" }] })]);
    expect(host.querySelectorAll("img").length).toBe(1);
    expect(host.querySelector("p")).toBeNull();
  });

  test("auto-scroll waits while the mouse is held down in the thread", () => {
    setup();
    renderThread(root, [first]);
    const scroller = host.firstElementChild as HTMLElement;
    const writes = fakeScroller(scroller);

    act(() => {
      host.querySelector("p")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    });
    renderThread(root, [first, second]);
    expect(writes).toEqual([]);

    act(() => {
      document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }) as unknown as Event);
    });
    expect(writes).toEqual([1000]);
  });
});

describe("several open ask_user questions in the thread", () => {
  let host: HTMLElement;
  let root: Root;
  const replies: Array<{ text: string; messageId: string; optionIndex: number }> = [];
  const jobs: PersonaJob[] = [
    { id: "ja", title: "Ship the docs fix", status: "waiting_user" } as PersonaJob,
    { id: "jb", title: "Rotate the token", status: "active" } as PersonaJob,
  ];
  const qa = message(1, "Which docs branch?", { options: ["main", "beta"], jobIds: ["ja"], jobTags: [{ jobId: "ja", source: "explicit" }] });
  const qb = message(2, "Rotate now or tonight?", { options: ["Now", "Tonight"], jobIds: ["jb"], jobTags: [{ jobId: "jb", source: "explicit" }] });
  const qc = message(3, "Keep the old key?", { options: ["Keep", "Drop"] });

  function render(messages: PersonaMessage[], quickReplies?: boolean) {
    act(() => {
      root.render(
        createElement(Thread, {
          ...(quickReplies === undefined ? {} : { quickReplies }),
          persona: viewState(messages),
          approvalsById: new Map<string, PersonaApproval>(),
          jobsById: new Map(jobs.map((j) => [j.id, j])),
          approvalProps: { busy: new Set<string>(), errors: {}, onDecide: noop },
          narrow: false,
          consoleThread: true,
          onQuickReply: (text, replyTo) => replies.push({ text, ...replyTo }),
          onResend: noop,
          onDiscard: noop,
          onRevealJob: noop,
        })
      );
    });
  }

  /** The option labels shown under each question, by message id. */
  function shown(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const row of host.querySelectorAll("[data-message-id]")) {
      const labels = [...row.querySelectorAll("button")]
        .map((b) => b.textContent ?? "")
        .filter((t) => [qa, qb, qc].some((q) => q.options!.includes(t)));
      if (labels.length > 0) out[row.getAttribute("data-message-id")!] = labels;
    }
    return out;
  }

  function click(label: string) {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    act(() => (button as unknown as { click(): void }).click());
  }

  test("two, then three open questions all keep their options", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render([qa, qb]);
    expect(shown()).toEqual({ m1: ["main", "beta"], m2: ["Now", "Tonight"] });
    render([qa, qb, qc]);
    expect(shown()).toEqual({ m1: ["main", "beta"], m2: ["Now", "Tonight"], m3: ["Keep", "Drop"] });
    // Each tagged question names the job it is about.
    const rowA = host.querySelector('[data-message-id="m1"]')!;
    const rowB = host.querySelector('[data-message-id="m2"]')!;
    expect(rowA.textContent).toContain("Ship the docs fix");
    expect(rowB.textContent).toContain("Rotate the token");
    act(() => root.unmount());
    host.remove();
  });

  test("answering the oldest replies to that question and leaves the others' options", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    replies.length = 0;
    render([qa, qb, qc]);
    click("beta");
    expect(replies).toEqual([{ text: "beta", messageId: "m1", optionIndex: 1 }]);
    // The collector marks the first question answered and echoes the reply.
    const answered = { ...qa, answeredAt: "2026-10-06T12:05:00.000Z" };
    render([answered, qb, qc, message(4, "beta", { role: "user" })]);
    expect(shown()).toEqual({ m2: ["Now", "Tonight"], m3: ["Keep", "Drop"] });
    click("Drop");
    expect(replies[1]).toEqual({ text: "Drop", messageId: "m3", optionIndex: 1 });
    act(() => root.unmount());
    host.remove();
  });

  test("a read-only view of the thread offers no quick replies", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render([qa, qb, qc], false);
    expect(shown()).toEqual({});
    expect(host.textContent).toContain("Which docs branch?");
    act(() => root.unmount());
    host.remove();
  });
});

describe("an owner-only safety-floor hold's card in the thread", () => {
  const expiresAt = new Date(Date.now() + 42 * 60_000).toISOString();
  const card: PersonaApproval = {
    id: "ap1",
    owner: "alice",
    jobId: "j1",
    threadId: "t1",
    action: "answer_ask",
    summary: 'Answer safety-floor hold "Safety floor held a Bash call" on session 3f2a9c1b with exactly "Allow once"',
    reason: "a safety-floor hold (floor-tamper) that could outlast one allow: only the owner may allow it",
    holdRule: "floor:floor-tamper",
    status: "pending",
    args: {
      askId: "a1",
      answer: "Allow once",
      sessionTitle: "Fix the floor",
      askQuestion:
        "Safety floor held a Bash call (floor-tamper): writes the floor hook\n\nvim gate.ts\n\nOnly the owner can allow this; Persona may deny it or escalate it. Nothing runs unless it is allowed.",
      floorHold: true,
      holdExpiresAt: expiresAt,
    },
    createdAt: "2026-10-08T19:25:19.000Z",
  } as PersonaApproval;

  test("renders the floor's headline, the held call and its deadline, and Allow once/Deny decide it", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const decided: Array<[string, string]> = [];
    act(() => {
      root.render(
        createElement(Thread, {
          persona: viewState([message(1, "held", { role: "system", approvalId: card.id })]),
          approvalsById: new Map([[card.id, card]]),
          jobsById: new Map(),
          approvalProps: {
            busy: new Set<string>(),
            errors: {},
            onDecide: (a, verdict) => decided.push([a.id, verdict]),
            viewer: "alice",
            viewerOwner: "alice",
          },
          narrow: false,
          consoleThread: true,
          onQuickReply: noop,
          onResend: noop,
          onDiscard: noop,
          onRevealJob: noop,
        })
      );
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Standup's safety floor is holding a command from the worker on “Fix the floor”, and only you can let it run.");
    expect(text).toContain("What the safety floor held");
    expect(text).toContain("vim gate.ts");
    const deadline = host.querySelector('[data-testid="hold-deadline"]')!;
    expect(deadline.textContent).toMatch(/^Decide by .+ \(in 4[12] min\): after that the hold times out and the call is denied\.$/);
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Approve");
    expect(labels).toContain("Deny");
    const approve = [...host.querySelectorAll("button")].find((b) => b.textContent === "Allow once")!;
    act(() => approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(decided).toEqual([["ap1", "approve"]]);
    act(() => root.unmount());
    host.remove();
  });
});

describe("Persona thread job tags and the job filter", () => {
  const J1 = "j1aaaaaaaaaa";
  const J2 = "j2bbbbbbbbbb";
  const J4 = "j4dddddddddd";
  const GONE = "j9zzzzzzzzzz";
  const J2_SESSION = "s2bbbbbbbbbb";
  const jobs = [
    { id: J1, threadId: "t1", title: "Fix login", goal: "", status: "active", sessionIds: [], launchIds: [], createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z" },
    { id: J2, threadId: "t1", title: "Ship docs", goal: "", status: "active", sessionIds: [J2_SESSION], launchIds: [], createdAt: "2026-10-06T10:01:00.000Z", updatedAt: "2026-10-06T10:01:00.000Z" },
    { id: J4, threadId: "t2", title: "New thing", goal: "", status: "active", sessionIds: [], launchIds: [], createdAt: "2026-10-06T10:02:00.000Z", updatedAt: "2026-10-06T10:02:00.000Z" },
  ] as unknown as PersonaJob[];
  const ownerMsg = message(10, "Please fix login", { role: "user", jobIds: [J1], jobTags: [{ jobId: J1, source: "explicit" }] });
  const reply = message(11, "On it, and the docs too.", {
    jobIds: [J1, J2, GONE],
    jobTags: [
      { jobId: J1, source: "declared" },
      { jobId: J2, source: "inferred" },
      { jobId: GONE, source: "explicit" },
    ],
  });
  const unrelated = message(12, "Unrelated chatter.");
  const systemRow = message(13, "Persona asked to run a deploy.", { role: "system", jobIds: [J2], jobTags: [{ jobId: J2, source: "declared" }] });
  const older = message(2, "An older login note.", { jobIds: [J1], jobTags: [{ jobId: J1, source: "explicit" }] });

  let host: HTMLElement;
  let root: Root;
  let calls: { url: string; method: string; body?: Record<string, unknown> }[];
  /** What the filter's backfill request answers. */
  let backfillRows: PersonaMessage[];
  /** What a read for the page above the loaded window answers: none, by default. */
  let olderRows: PersonaMessage[] = [];
  /** Per-test DELETE answers, by URL. */
  let deletes: Record<string, () => Promise<Response>>;
  let initialMessages: PersonaMessage[];
  /** Extra view state for one test (e.g. a shared thread selected); none by default. */
  let extraState: Partial<PersonaViewState> = {};
  /** A test's own answer to a message POST; a bare 201 by default. */
  let postAnswer: ((body: Record<string, unknown>) => Response) | undefined;
  let dispatch: Dispatch<PersonaAction>;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function stubFetch() {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = method === "POST" ? (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>) : undefined;
      calls.push({ url, method, ...(body ? { body } : {}) });
      if (method === "POST" && url === "/api/persona/messages") return postAnswer?.(body!) ?? json({}, 201);
      if (method === "DELETE" && deletes[url]) return deletes[url]();
      if (method === "DELETE" && url === `/api/persona/messages/m11/jobs/${J2}`) {
        return json({ message: { ...reply, jobIds: [J1, GONE], jobTags: [reply.jobTags![0], reply.jobTags![2]] } });
      }
      // The thread's page above the loaded window; the filter's backfill is apart from it.
      if (url.startsWith("/api/persona/messages?") && url.includes("beforeSeq=")) return json({ threadId: "t1", messages: olderRows });
      if (url.startsWith("/api/persona/messages?")) return json({ threadId: "t1", messages: backfillRows });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  }

  function Harness() {
    const [persona, d] = useReducer(personaReducer, { ...viewState(initialMessages), jobs, jobsLoaded: true, ...extraState });
    dispatch = d;
    return createElement(PersonaView, { persona, sessions: [], onAction: d, onRefresh });
  }

  function LocationProbe() {
    const location = router.useLocation();
    return createElement("output", { "data-testid": "location", "data-path": location.pathname }, location.search);
  }

  async function renderView(url = "/persona", messages = [ownerMsg, reply, unrelated, systemRow]) {
    initialMessages = messages;
    backfillRows ??= [older];
    deletes ??= {};
    stubFetch();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(
        createElement(router.MemoryRouter, { initialEntries: [url] }, createElement(Harness), createElement(LocationProbe))
      )
    );
    await settle();
    // The job drawer is its own chunk: a URL that opens it waits for it to load.
    if (new URLSearchParams(url.split("?")[1] ?? "").has("job")) await waitFor("[role=dialog]");
  }

  async function settle() {
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  }

  /** Settles until `selector` matches, failing after about two seconds. */
  async function waitFor(selector: string): Promise<Element> {
    for (let i = 0; i < 200; i++) {
      const el = host.querySelector(selector);
      if (el) return el;
      await act(async () => new Promise((r) => setTimeout(r, 10)));
    }
    throw new Error(`${selector} never rendered`);
  }

  const search = () => decodeURIComponent(host.querySelector("[data-testid=location]")!.textContent ?? "");
  const rowChips = (messageId: string) =>
    [...host.querySelectorAll(`[data-message-id=${messageId}] [data-testid=message-job-tag]`)] as HTMLElement[];
  /** A chip's label: the text of its open button, without the remove ×. */
  const label = (chip: HTMLElement) => chip.querySelector("button")!.textContent;
  const threadText = () => (host.querySelector("[data-testid=job-filter-bar]")?.nextElementSibling?.textContent ?? "");

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
    backfillRows = [older];
    olderRows = [];
    deletes = {};
    extraState = {};
    postAnswer = undefined;
  });

  test("a multi-tag reply shows one chip per tag with the job's title and short id", async () => {
    await renderView();
    const chips = rowChips("m11");
    expect(chips.map(label)).toEqual(["Fix login·j1aaaaaa", "Ship docs·j2bbbbbb", "j9zzzzzz"]);
    expect(chips.map((c) => c.dataset.source)).toEqual(["declared", "inferred", "explicit"]);
    expect(chips.map((c) => c.querySelector("button")!.getAttribute("aria-label"))).toEqual([
      "Fix login, tagged by Persona",
      "Ship docs, suggested tag",
      "job j9zzzzzz, tagged",
    ]);
    expect(rowChips("m10").map(label)).toEqual(["Fix login·j1aaaaaa"]);
    expect(rowChips("m13").map((c) => c.dataset.jobId)).toEqual([J2]);
    expect(rowChips("m12")).toHaveLength(0);
    // The open-job buttons the chips replace don't render beside them.
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent === "Fix login")).toHaveLength(0);
  });

  test("clicking a chip opens the job's drawer", async () => {
    await renderView();
    await act(() => (rowChips("m10")[0].querySelector("button") as HTMLElement).click());
    expect(search()).toBe(`?job=${J1}`);
    expect((await waitFor("[role=dialog] h2")).textContent).toBe("Fix login");
  });

  test("an inferred tag is dashed with a remove button that DELETEs it and takes the server's copy", async () => {
    await renderView();
    const [declared, inferred] = rowChips("m11");
    expect(inferred.style.border).toContain("dashed");
    expect(declared.style.border).not.toContain("dashed");
    expect(inferred.title).toContain("inferred");
    expect(declared.querySelector("button[aria-label^='Remove tag']")).toBeNull();
    const remove = inferred.querySelector("button[aria-label='Remove tag Ship docs']") as HTMLElement;
    expect(remove).not.toBeNull();
    await act(() => remove.click());
    await settle();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/persona/messages/m11/jobs/${J2}`]);
    expect(rowChips("m11").map((c) => c.dataset.jobId)).toEqual([J1, GONE]);
  });

  test("the filter lists All, then active jobs, then closed and unknown ones, with counts, and syncs ?tags", async () => {
    await renderView(`/persona?job=${J4}`);
    await act(() => (host.querySelector("[aria-label=Close]") as HTMLElement).click());
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    const popover = host.querySelector("[data-testid=job-filter-popover]")!;
    expect(popover.getAttribute("data-variant")).toBe("popover");
    const all = popover.querySelector("[data-testid=job-filter-all] input") as HTMLInputElement;
    expect(all.checked).toBe(true);
    const options = [...popover.querySelectorAll("[data-testid=job-filter-option]")] as HTMLElement[];
    // Open jobs most recently active first, then the tagged job the list doesn't know.
    expect(options.map((o) => o.dataset.jobId)).toEqual([J4, J2, J1, GONE]);
    expect(options[0].textContent).toBe("New thingj4dddddd");
    expect(options[2].textContent).toBe("Fix loginj1aaaaaa2");
    expect(options[3].textContent).toBe("Unknown jobj9zzzzzz1");
    expect([...popover.querySelectorAll("div")].map((d) => d.textContent).filter((t) => t === "Active" || t === "Recently closed")).toEqual([
      "Active",
      "Recently closed",
    ]);

    await act(() => (options[2].querySelector("input") as HTMLElement).click());
    await settle();
    expect(search()).toBe(`?tags=${J1}`);
    // Older matches beyond the loaded window are fetched and merged in.
    expect(calls.some((c) => c.url === `/api/persona/messages?threadId=t1&jobId=${J1}`)).toBe(true);
    const text = threadText();
    expect(text).toContain("An older login note.");
    expect(text).toContain("Please fix login");
    expect(text).toContain("On it, and the docs too.");
    expect(text).not.toContain("Unrelated chatter.");
    expect(text).not.toContain("Persona asked to run a deploy.");
    expect(host.querySelector("[data-testid=job-filter-bar]")!.textContent).toContain("Showing 3 messages for");

    // A second job widens the filter to messages tagged with either.
    const second = host.querySelector(`[data-testid=job-filter-option][data-job-id=${J2}] input`) as HTMLElement;
    await act(() => second.click());
    expect(search()).toBe(`?tags=${J1},${J2}`);
    expect(threadText()).toContain("Persona asked to run a deploy.");

    await act(() => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector("[data-testid=job-filter-popover]")).toBeNull();

    await act(() => (host.querySelector("[data-testid=job-filter-clear]") as HTMLElement).click());
    expect(search()).toBe("");
    expect(host.querySelector("[data-testid=job-filter-bar]")).toBeNull();
    expect(host.textContent).toContain("Unrelated chatter.");
    // The backfilled match was never part of the window, so Clear leaves no gap.
    expect(host.textContent).not.toContain("An older login note.");
  });

  const frameOf = (payload: unknown): PersonaAction => ({
    type: "frame",
    message: { type: "persona:message", payload, timestamp: "2026-10-06T12:00:00.000Z" } as WsMessage,
  });

  test("while filtering, the owner's pending and failed sends show, and a send confirmed meanwhile stays", async () => {
    await renderView(`/persona?tags=${J2}`);
    const createdAt = "2026-10-06T12:01:00.000Z";
    await act(() => dispatch({ type: "queue", item: { idempotencyKey: "k1", text: "Any update?", createdAt, afterSeq: 13, status: "sending" } }));
    await act(() => dispatch({ type: "queue", item: { idempotencyKey: "k2", text: "Hello?", createdAt, afterSeq: 13, status: "sending" } }));
    await act(() => dispatch({ type: "sendFailed", idempotencyKey: "k2", error: "offline" }));
    let text = threadText();
    expect(text).toContain("Any update?");
    expect(text).toContain("sending…");
    expect(text).toContain("Hello?");
    expect(text).toContain("Not sent — offline");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Retry", "Discard"]));

    // k1's echo carries no tag; it replaces the pending bubble and stays in view.
    await act(() => dispatch(frameOf(message(14, "Any update?", { role: "user" }))));
    text = threadText();
    expect(text).toContain("Any update?");
    expect(text).not.toContain("sending…");
    // The owner's messages from before the filter stay filtered out.
    expect(text).not.toContain("Please fix login");
    expect(host.querySelector("[data-testid=job-filter-bar]")!.textContent).toContain("Showing 2 messages for");
  });

  test("widening the filter keeps the owner's sends from while filtering", async () => {
    await renderView(`/persona?tags=${J2}`);
    await act(() => dispatch(frameOf(message(14, "Sent while filtering.", { role: "user" }))));
    expect(threadText()).toContain("Sent while filtering.");
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    await act(() => (host.querySelector(`[data-testid=job-filter-option][data-job-id=${J1}] input`) as HTMLElement).click());
    await settle();
    expect(search()).toBe(`?tags=${J2},${J1}`);
    expect(threadText()).toContain("Sent while filtering.");
  });

  test("a disabled Persona offers no tag removal", async () => {
    await renderView();
    expect(rowChips("m11")[1].querySelector("button[aria-label^='Remove tag']")).not.toBeNull();
    await act(() => dispatch({ type: "disabled", reason: "Persona is off for this account." }));
    expect(rowChips("m11")[1].querySelector("button[aria-label^='Remove tag']")).toBeNull();
  });

  test("the drawer's and the checklist's counts include backfilled matches, as the filter bar does", async () => {
    await renderView(`/persona?tags=${J1}&job=${J1}`);
    expect(host.querySelector("[data-testid=job-filter-bar]")!.textContent).toContain("Showing 3 messages for");
    expect(host.querySelector("[data-testid=job-drawer-messages]")!.textContent).toBe("Messages in thread (3)");
    await act(() => (host.querySelector("[aria-label=Close]") as HTMLElement).click());
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    const option = host.querySelector(`[data-testid=job-filter-option][data-job-id=${J1}]`) as HTMLElement;
    expect(option.textContent).toBe("Fix loginj1aaaaaa3");
  });

  test("live frames and tag removal apply to backfilled rows, which never join the thread", async () => {
    const suggested = message(3, "An older suggested note.", { jobIds: [J1], jobTags: [{ jobId: J1, source: "inferred" }] });
    backfillRows = [older, suggested];
    deletes[`/api/persona/messages/m3/jobs/${J1}`] = async () => json({ message: { ...suggested, jobIds: [], jobTags: [] } });
    await renderView(`/persona?tags=${J1}`);
    expect(threadText()).toContain("An older login note.");
    expect(threadText()).toContain("An older suggested note.");

    await act(() => dispatch(frameOf({ ...older, text: "An older login note, edited." })));
    expect(threadText()).toContain("An older login note, edited.");

    const remove = host.querySelector("[data-message-id=m3] button[aria-label='Remove tag Fix login']") as HTMLElement;
    await act(() => remove.click());
    await settle();
    expect(threadText()).not.toContain("An older suggested note.");

    await act(() => (host.querySelector("[data-testid=job-filter-clear]") as HTMLElement).click());
    await settle();
    expect(host.textContent).not.toContain("An older login note");
    expect(host.textContent).not.toContain("An older suggested note.");
    expect(host.querySelectorAll("[data-message-id]")).toHaveLength(4);
  });

  test("removing X then Y, where Y succeeds and X fails, restores X and keeps Y removed", async () => {
    const tagged = message(20, "Two suggestions.", {
      jobIds: [J1, J2],
      jobTags: [
        { jobId: J1, source: "inferred" },
        { jobId: J2, source: "inferred" },
      ],
    });
    let failX!: () => void;
    deletes[`/api/persona/messages/m20/jobs/${J1}`] = () =>
      new Promise((resolve) => {
        failX = () => resolve(json({ error: "boom" }, 500));
      });
    deletes[`/api/persona/messages/m20/jobs/${J2}`] = async () =>
      json({ message: { ...tagged, jobIds: [J1], jobTags: [tagged.jobTags![0]] } });
    await renderView("/persona", [tagged]);

    await act(() => (host.querySelector("[data-message-id=m20] button[aria-label='Remove tag Fix login']") as HTMLElement).click());
    await act(() => (host.querySelector("[data-message-id=m20] button[aria-label='Remove tag Ship docs']") as HTMLElement).click());
    await settle();
    await act(async () => failX());
    await settle();
    expect(rowChips("m20").map((c) => c.dataset.jobId)).toEqual([J1]);
    expect(host.textContent).toContain("Couldn't remove that tag");
  });

  test("?tags in the URL filters on load and keeps other params", async () => {
    await renderView(`/persona?tags=${J2}&job=${J2}`);
    await act(() => (host.querySelector("[aria-label=Close]") as HTMLElement).click());
    expect(search()).toBe(`?tags=${J2}`);
    const text = threadText();
    expect(text).toContain("On it, and the docs too.");
    expect(text).toContain("Persona asked to run a deploy.");
    expect(text).not.toContain("Please fix login");
  });

  async function typeAndEnter(value: string) {
    const el = host.querySelector("[data-testid=persona-composer] textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, value);
      el.setSelectionRange(value.length, value.length);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(() => {
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();
  }

  const sends = () => calls.filter((c) => c.method === "POST" && c.url === "/api/persona/messages").map((c) => c.body!);
  const routeChip = () => host.querySelector("[data-testid=composer-route-chip]") as HTMLElement | null;
  const composerInput = () => host.querySelector("[data-testid=persona-composer] textarea") as HTMLTextAreaElement;

  test("unfiltered, the composer shows no route and a send carries no job", async () => {
    await renderView();
    expect(routeChip()).toBeNull();
    expect(composerInput().placeholder).toBe("Ask Persona for anything…");
    await typeAndEnter("Hello");
    await typeAndEnter("And again");
    expect(sends().map((b) => [b.text, "jobId" in b])).toEqual([
      ["Hello", false],
      ["And again", false],
    ]);
  });

  test("filtered to one job, the composer is routed to it and every send carries its id", async () => {
    await renderView(`/persona?tags=${J1}`);
    const chip = routeChip()!;
    expect(chip.dataset.jobId).toBe(J1);
    expect(chip.textContent).toBe("→Fix loginj1aaaaaa×");
    expect(composerInput().placeholder).toBe("Message Persona about Fix login…");
    await typeAndEnter("How is it going?");
    await typeAndEnter("Also check the logout path");
    expect(sends().map((b) => [b.text, b.jobId])).toEqual([
      ["How is it going?", J1],
      ["Also check the logout path", J1],
    ]);
    // The route outlives each send, unlike a one-off # tag.
    expect(routeChip()).not.toBeNull();
    // The sent messages stay in the filtered thread, each shown about the job.
    expect(threadText()).toContain("How is it going?");
  });

  test("the route chip's × clears the filter and sends go to the thread untagged again", async () => {
    await renderView(`/persona?tags=${J2}&job=${J2}`);
    await act(() => (host.querySelector("[aria-label=Close]") as HTMLElement).click());
    await act(() => (routeChip()!.querySelector("button[aria-label='Stop sending to Ship docs']") as HTMLElement).click());
    await settle();
    expect(search()).toBe("");
    expect(routeChip()).toBeNull();
    expect(host.querySelector("[data-testid=job-filter-bar]")).toBeNull();
    await typeAndEnter("Back to the thread");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).not.toHaveProperty("jobId");
  });

  test("All in the filter clears it, and with it the route", async () => {
    await renderView(`/persona?tags=${J1}`);
    expect(routeChip()).not.toBeNull();
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    const all = host.querySelector("[data-testid=job-filter-all] input") as HTMLInputElement;
    expect(all.checked).toBe(false);
    await act(() => all.click());
    await settle();
    expect(search()).toBe("");
    expect(routeChip()).toBeNull();
    expect((host.querySelector("[data-testid=job-filter-all] input") as HTMLInputElement).checked).toBe(true);
  });

  test("filtered to two jobs, the composer says sends go untagged and none carries a job", async () => {
    await renderView(`/persona?tags=${J1},${J2}`);
    expect(routeChip()).toBeNull();
    expect(host.querySelector("[data-testid=composer-route-note]")!.textContent).toContain("Filtered to several jobs");
    await typeAndEnter("Status on both?");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).not.toHaveProperty("jobId");
  });

  test("filtered to a job the jobs list doesn't know, sends go untagged rather than to a refused jobId", async () => {
    await renderView(`/persona?tags=${GONE}`);
    expect(routeChip()).toBeNull();
    expect(host.querySelector("[data-testid=composer-route-note]")!.textContent).toContain("isn't one of your jobs");
    expect(composerInput().placeholder).toBe("Ask Persona for anything…");
    await typeAndEnter("Hello?");
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).not.toHaveProperty("jobId");
  });

  const sharedThread = (id: string) =>
    ({
      id,
      owner: "alice",
      channel: "slack",
      externalRef: "C42:1.2",
      title: "#eng",
      audience: "shared",
      createdAt: "2026-10-06T10:00:00.000Z",
      updatedAt: "2026-10-06T10:00:00.000Z",
      messageCount: 0,
    }) as unknown as PersonaViewState["threads"][number];

  test("before the jobs list loads, a filtered job is still routed, by its short id", async () => {
    extraState = { jobs: [], jobsLoaded: false };
    await renderView(`/persona?tags=${J1}`);
    expect(host.querySelector("[data-testid=composer-route-note]")).toBeNull();
    expect(routeChip()!.textContent).toBe("→j1aaaaaa×");
    expect(composerInput().placeholder).toBe("Message Persona about job j1aaaaaa…");
    await typeAndEnter("Early send");
    expect(sends()[0]!.jobId).toBe(J1);
  });

  test("on a thread the threads list doesn't name yet, another thread's job is still routed", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [] };
    await renderView(`/persona?tags=${J1}`);
    expect(routeChip()!.dataset.jobId).toBe(J1);
    await typeAndEnter("From the DM");
    expect(sends()[0]!.jobId).toBe(J1);
  });

  test("a routed send the collector refuses for its job (404) is sent again untagged, once, and says so", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [] };
    postAnswer = (body) => (body.jobId ? json({ error: "Unknown job" }, 404) : json({}, 201));
    await renderView(`/persona?tags=${J1}`);
    await typeAndEnter("Before the threads list");
    expect(sends().map((b) => [b.text, b.jobId, b.idempotencyKey === sends()[0]!.idempotencyKey])).toEqual([
      ["Before the threads list", J1, true],
      ["Before the threads list", undefined, true],
    ]);
    expect(host.textContent).toContain("Sent without the job tag");
    expect(host.textContent).not.toContain("Not sent");
  });

  test("a # tag the collector refuses fails the send as before, even while routed; nothing is dropped behind the owner's pick", async () => {
    postAnswer = (body) => (body.jobId ? json({ error: "Unknown job" }, 404) : json({}, 201));
    await renderView(`/persona?tags=${J2}`);
    expect(routeChip()!.dataset.jobId).toBe(J2);
    const el = composerInput();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, "#Fix");
      el.setSelectionRange(4, 4);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      el.dispatchEvent(new window.Event("select", { bubbles: true }) as unknown as Event);
    });
    await act(() => {
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await typeAndEnter("Picked by hand");
    expect(sends().map((b) => b.jobId)).toEqual([J1]);
    expect(host.textContent).toContain("Not sent");
    expect(host.textContent).not.toContain("Sent without the job tag");
  });

  test("Discuss in Persona on a shared thread for another thread's job says why no tag is set", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [sharedThread("t2")] };
    await renderView(`/persona?job=${J1}`);
    const discuss = [...host.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "Discuss in Persona") as HTMLElement;
    await act(() => discuss.click());
    await settle();
    expect(host.querySelector("[data-testid=job-tag-chip]")).toBeNull();
    expect(host.textContent).toContain('"Fix login" belongs to another thread');
    await typeAndEnter("Untagged here");
    expect(sends()[0]).not.toHaveProperty("jobId");
  });

  test("on a shared thread the # picker offers only the thread's own jobs", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [sharedThread("t2")] };
    await renderView("/persona");
    const el = composerInput();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, "#");
      el.setSelectionRange(1, 1);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      el.dispatchEvent(new window.Event("select", { bubbles: true }) as unknown as Event);
    });
    const menu = host.querySelector("[role=listbox][aria-label='Tag a job']")!;
    expect(menu.textContent).toContain("New thing");
    expect(menu.textContent).not.toContain("Fix login");
    expect(menu.textContent).not.toContain("Ship docs");
  });

  test("on a private non-console thread (a DM), another thread's job is routed", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [{ ...sharedThread("t2"), audience: "private", externalRef: "dm:D1", title: "DM" }] };
    await renderView(`/persona?tags=${J1}`);
    expect(routeChip()!.dataset.jobId).toBe(J1);
    expect(host.querySelector("[data-testid=composer-route-note]")).toBeNull();
    await typeAndEnter("From the DM");
    expect(sends()[0]!.jobId).toBe(J1);
  });

  test("on a shared thread, another thread's job isn't routed; the thread's own job is", async () => {
    extraState = { threadId: "t2", consoleThreadId: "t1", threads: [sharedThread("t2")] };
    await renderView(`/persona?tags=${J1}`);
    expect(routeChip()).toBeNull();
    expect(host.querySelector("[data-testid=composer-route-note]")!.textContent).toContain("Fix login belongs to another thread");
    await typeAndEnter("For the channel");
    expect(sends()[0]).not.toHaveProperty("jobId");
    await act(() => (host.querySelector("[data-testid=job-filter-clear]") as HTMLElement).click());
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    await act(() => (host.querySelector(`[data-testid=job-filter-option][data-job-id=${J4}] input`) as HTMLElement).click());
    await settle();
    expect(routeChip()!.dataset.jobId).toBe(J4);
    expect(composerInput().placeholder).toBe("Message Persona in #eng about New thing…");
    await typeAndEnter("About the new thing");
    expect(sends().map((b) => [b.text, b.jobId])).toEqual([
      ["For the channel", undefined],
      ["About the new thing", J4],
    ]);
  });

  test("a # tag picked while routed wins for that one message, then the route resumes", async () => {
    await renderView(`/persona?tags=${J1}`);
    const el = composerInput();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, "#Ship");
      el.setSelectionRange(5, 5);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
      el.dispatchEvent(new window.Event("select", { bubbles: true }) as unknown as Event);
    });
    await act(() => {
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(host.querySelector("[data-testid=job-tag-chip]")).not.toBeNull();
    expect(routeChip()).toBeNull();
    await typeAndEnter("Docs question");
    await typeAndEnter("Login question");
    expect(sends().map((b) => [b.text, b.jobId])).toEqual([
      ["Docs question", J2],
      ["Login question", J1],
    ]);
    expect(routeChip()).not.toBeNull();
  });

  test("the drawer's Messages in thread link shows the job's messages and closes the drawer", async () => {
    await renderView(`/persona?job=${J1}`);
    const link = host.querySelector("[data-testid=job-drawer-messages]") as HTMLElement;
    expect(link.textContent).toBe("Messages in thread (2)");
    await act(() => link.click());
    await settle();
    expect(search()).toBe(`?tags=${J1}`);
    expect(host.querySelector("[role=dialog][aria-modal=true]")).toBeNull();
    expect(threadText()).not.toContain("Unrelated chatter.");
  });

  test("the drawer's View worker opens the job's worker session in the Work tab", async () => {
    await renderView(`/persona?job=${J2}`);
    const button = [...host.querySelectorAll("[role=dialog] button")].find((b) => b.textContent === "View worker") as HTMLElement;
    await act(() => button.click());
    await settle();
    expect(host.querySelector("[data-testid=location]")!.getAttribute("data-path")).toBe(`/work/s/${J2_SESSION}`);
  });

  test("on a narrow screen the filter opens as a bottom sheet over a backdrop", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const changes: string[][] = [];
    await act(() =>
      root.render(
        createElement(JobFilterControl, {
          messages: [ownerMsg, reply],
          jobs,
          jobsById: new Map(jobs.map((j) => [j.id, j])),
          selected: [],
          narrow: true,
          onChange: (ids: string[]) => changes.push(ids),
        })
      )
    );
    await act(() => (host.querySelector("[data-testid=job-filter-button]") as HTMLElement).click());
    const sheet = host.querySelector("[data-testid=job-filter-popover]") as HTMLElement;
    expect(sheet.getAttribute("data-variant")).toBe("sheet");
    expect(sheet.style.position).toBe("fixed");
    // Focus lands on the first row, "All".
    expect(document.activeElement).toBe(sheet.querySelector("[data-testid=job-filter-all] input"));
    await act(() => (sheet.querySelector(`[data-testid=job-filter-option][data-job-id=${J1}] input`) as HTMLElement).click());
    expect(changes).toEqual([[J1]]);
    await act(() => (host.querySelector("[data-testid=job-filter-backdrop]") as HTMLElement).click());
    expect(host.querySelector("[data-testid=job-filter-popover]")).toBeNull();
  });
});

describe("slash commands in the Persona composer", () => {
  let host: HTMLElement;
  let root: Root;
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  const question = message(1, "Ship it?", { options: ["yes", "no"] });
  const stateReport = {
    generatedAt: "2026-10-06T12:01:00.000Z",
    waiting: { jobs: [], questions: [{ id: "m1", title: "Ship it?", href: "/persona" }], approvals: [], reviews: [] },
    inFlight: { total: 0, stalled: 0, stages: [] },
    holds: [],
    health: { collector: {}, restart: null, host: null, schedules: [], budgets: [], commitments: [] },
    verdict: { needYou: 1, lookOff: 0, line: "1 thing needs you" },
  };

  async function renderView() {
    posts = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        posts.push({ url, body });
        if (url === "/api/persona/commands") {
          const command = { name: "state", args: "" };
          return new Response(
            JSON.stringify({
              message: message(2, "/state", { role: "user", actor: "alice", idempotencyKey: String(body.idempotencyKey), command }),
              result: message(3, "1 thing needs you", {
                role: "system",
                command: { ...command, result: { ok: true, data: stateReport, summary: "1 thing needs you", ranAt: stateReport.generatedAt, ms: 4 } },
              }),
            }),
            { status: 201, headers: { "content-type": "application/json" } }
          );
        }
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    function Harness() {
      const [persona, d] = useReducer(personaReducer, viewState([question]));
      return createElement(PersonaView, { persona, sessions: [], onAction: d, onRefresh });
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => root.render(createElement(router.MemoryRouter, { initialEntries: ["/persona"] }, createElement(Harness))));
    await settle();
  }

  async function settle() {
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  }

  async function typeAndEnter(value: string) {
    const el = host.querySelector("[data-testid=persona-composer] textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, value);
      el.setSelectionRange(value.length, value.length);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(() => {
      el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();
  }

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  });

  test("/state runs on the command route and its card joins the thread; the question stays open", async () => {
    await renderView();
    await typeAndEnter("/state");
    expect(posts.map((p) => p.url)).toEqual(["/api/persona/commands"]);
    expect(posts[0]!.body).toMatchObject({ text: "/state", threadId: "t1" });
    expect(host.querySelector("[data-testid=state-card]")).not.toBeNull();
    expect(host.querySelector("[data-testid=state-verdict]")!.textContent).toBe("1 thing needs you");
    // The quick replies of Persona's open question are still offered.
    expect([...host.querySelectorAll(`[data-message-id=m1] button`)].map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["yes", "no"])
    );
  });

  test("an unknown /word goes to Persona as an ordinary message", async () => {
    await renderView();
    await typeAndEnter("/deploy beta");
    expect(posts.map((p) => [p.url, p.body.text])).toEqual([["/api/persona/messages", "/deploy beta"]]);
  });
});

describe("Persona before its first snapshot", () => {
  let host: HTMLElement;
  let root: Root;
  let posts: { url: string; body: unknown }[];
  let gets: string[];
  let dispatch: Dispatch<PersonaAction>;
  let current: PersonaViewState;

  function Harness() {
    const [persona, d] = useReducer(personaReducer, initialPersonaViewState);
    dispatch = d;
    current = persona;
    return createElement(PersonaView, { persona, sessions: [], onAction: d, onRefresh });
  }

  async function render(url = "/persona") {
    posts = [];
    gets = [];
    // Sends stay in flight: the outbox item is what the test reads.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Promise<Response>(() => {});
      }
      gets.push(url);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() => root.render(createElement(router.MemoryRouter, { initialEntries: [url] }, createElement(Harness))));
  }

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  });

  const type = async (el: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
    await act(() => {
      setter.call(el, value);
      el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  };

  test("the shell, the thread skeleton and a working composer render before anything loads", async () => {
    await render();
    expect(current.loaded).toBe(false);
    expect(host.textContent).not.toContain("Loading Persona…");
    expect(host.querySelector("[data-testid=persona-thread-loading]")).not.toBeNull();
    expect(host.querySelector("[data-testid=persona-thread]")).toBeNull();
    const composer = host.querySelector("[data-testid=persona-composer] textarea") as HTMLTextAreaElement;
    expect(composer).not.toBeNull();

    await type(composer, "Are you there?");
    const sendButton = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    await act(() => sendButton.click());

    expect(current.outbox).toHaveLength(1);
    expect(current.outbox[0]).toMatchObject({ text: "Are you there?", status: "sending", afterSeq: 0 });
    expect(posts.map((p) => p.url)).toEqual(["/api/persona/messages"]);
    expect(posts[0]!.body).toMatchObject({ text: "Are you there?", idempotencyKey: current.outbox[0]!.idempotencyKey });
    expect(composer.value).toBe("");

    // The first page lands: the skeleton gives way, and the queued send shows on the thread.
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Earlier reply.")] }, pendingApprovals: [] },
      })
    );
    expect(host.querySelector("[data-testid=persona-thread-loading]")).toBeNull();
    const thread = host.querySelector("[data-testid=persona-thread]")!;
    expect(thread.textContent).toContain("Earlier reply.");
    expect(thread.textContent).toContain("Are you there?");
    expect(thread.textContent).toContain("sending…");
  });

  test("the jobs list is a skeleton until a snapshot carries it, even once the thread has loaded", async () => {
    await render();
    expect(host.querySelector("[data-testid=jobs-loading]")).not.toBeNull();
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Hi.")] }, pendingApprovals: [] },
      })
    );
    expect(current.loaded).toBe(true);
    expect(host.querySelector("[data-testid=jobs-loading]")).not.toBeNull();
    const job = { id: "j1", title: "Fix login", goal: "", status: "active", sessionIds: [], launchIds: [], createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z" } as unknown as PersonaJob;
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Hi.")] }, jobs: [job], pendingApprovals: [], recentApprovals: [] },
      })
    );
    expect(host.querySelector("[data-testid=jobs-loading]")).toBeNull();
    expect(host.textContent).toContain("Fix login");
  });

  test("a ?job= deep link opens its drawer only once the jobs list has loaded", async () => {
    const job = { id: "j1aaaaaaaaaa", title: "Fix login", goal: "", status: "active", sessionIds: [], launchIds: [], createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z" } as unknown as PersonaJob;
    await render(`/persona?job=${job.id}`);
    // The first-paint snapshot carries no jobs list.
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Hi.")] }, pendingApprovals: [] },
      })
    );
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(current.jobsLoaded).toBeUndefined();
    expect(host.querySelector("[role=dialog]")).toBeNull();
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Hi.")] }, jobs: [job], pendingApprovals: [], recentApprovals: [] },
      })
    );
    let dialog: Element | null = null;
    for (let i = 0; i < 200 && !dialog; i++) {
      await act(async () => new Promise((r) => setTimeout(r, 10)));
      dialog = host.querySelector("[role=dialog]");
    }
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Fix login");
  });

  test("the commitments panel reads nothing until the server's first snapshot lands", async () => {
    await render();
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(gets.filter((u) => u.includes("/api/persona/commitments"))).toEqual([]);
    await act(() =>
      dispatch({
        type: "snapshot",
        frameMark: current.frames,
        snapshot: { messages: { threadId: "t1", messages: [message(1, "Hi.")] }, pendingApprovals: [] },
      })
    );
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(gets.some((u) => u.includes("/api/persona/commitments"))).toBe(true);
  });

  test("a failed load shows the jobs list as held rather than a skeleton that never ends", async () => {
    await render();
    await act(() => dispatch({ type: "snapshot", frameMark: current.frames, snapshot: { loadError: "network down" } }));
    expect(host.querySelector("[data-testid=jobs-loading]")).toBeNull();
  });
});

describe("Persona thread paging", () => {
  let host: HTMLElement;
  let root: Root;
  let reads: string[];
  let current: PersonaViewState;

  const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i, `Row ${from + i}.`));

  function Harness({ start }: { start: PersonaViewState }) {
    const [persona, d] = useReducer(personaReducer, start);
    current = persona;
    return createElement(PersonaView, { persona, sessions: [], onAction: d, onRefresh });
  }

  /** `older` answers a page above the window, or null for a read that fails. */
  async function render(start: PersonaViewState, older: (beforeSeq: number) => PersonaMessage[] | null) {
    reads = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      reads.push(url);
      const parsed = new URL(url, "http://console");
      const before = parsed.searchParams.get("beforeSeq");
      if (parsed.pathname === "/api/persona/messages" && before !== null) {
        const page = older(Number(before));
        if (page === null) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        return new Response(JSON.stringify({ threadId: "t1", messages: page }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(createElement(router.MemoryRouter, { initialEntries: ["/persona"] }, createElement(Harness, { start })))
    );
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  }

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
    globalThis.fetch = realFetch;
  });

  test("a window too short to scroll reads the older pages above it until the thread's start", async () => {
    await render(viewState(rows(81, 90)), (before) => rows(Math.max(1, before - 50), before - 1));
    // A full page, then a short one that reaches seq 1.
    expect(reads.filter((u) => u.includes("beforeSeq="))).toEqual([
      "/api/persona/messages?threadId=t1&beforeSeq=81&limit=50",
      "/api/persona/messages?threadId=t1&beforeSeq=31&limit=50",
    ]);
    expect(current.messages.map((m) => m.seq)).toEqual(rows(1, 90).map((m) => m.seq));
    expect(current.oldestReached.t1).toBe(true);
    expect(host.querySelector("[data-testid=older-loading]")).toBeNull();
  });

  test("a thread loaded from its first message reads nothing older and shows no indicator", async () => {
    await render(viewState(rows(1, 5)), () => {
      throw new Error("must not read");
    });
    expect(reads.filter((u) => u.includes("beforeSeq="))).toEqual([]);
    expect(host.querySelector("[data-testid=older-loading]")).toBeNull();
  });

  test("an older read that fails shows Retry and reads nothing more on its own; Retry reads again", async () => {
    let fail = true;
    await render(viewState(rows(81, 90)), (before) => (fail ? null : rows(Math.max(1, before - 50), before - 1)));
    const olderReads = () => reads.filter((u) => u.includes("beforeSeq="));
    expect(olderReads()).toEqual(["/api/persona/messages?threadId=t1&beforeSeq=81&limit=50"]);
    const indicator = host.querySelector("[data-testid=older-loading]")!;
    expect(indicator.textContent).toContain("Couldn't load earlier messages.");
    // The window still can't scroll, yet a failed read isn't retried by itself.
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(olderReads()).toHaveLength(1);
    expect(current.messages[0]!.seq).toBe(81);

    fail = false;
    const retry = [...indicator.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(olderReads().slice(0, 2)).toEqual([
      "/api/persona/messages?threadId=t1&beforeSeq=81&limit=50",
      "/api/persona/messages?threadId=t1&beforeSeq=81&limit=50",
    ]);
    // Once a read succeeds, paging carries on to the thread's start.
    expect(current.messages[0]!.seq).toBe(1);
    expect(host.textContent).not.toContain("Couldn't load earlier messages.");
  });
});

async function onRefresh() {}
