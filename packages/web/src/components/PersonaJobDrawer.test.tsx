import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type {
  Ask,
  Checkpoint,
  PersonaApproval,
  PersonaFloorDecision,
  PersonaJob,
  PipelineRun,
  PipelineWorker,
  PlanApproval,
  Session,
} from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { sampleRunUiChange } from "./pipeline-fixtures";

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
let PersonaJobDrawer: typeof import("./PersonaJobDrawer").PersonaJobDrawer;
let TranscriptView: typeof import("./TranscriptView").TranscriptView;
let router: typeof import("react-router-dom");

const realFetch = globalThis.fetch;

const SESSION_ID = "sess-1111-aaaa";
const LAUNCH_ID = "launch-1";

const job: PersonaJob = {
  id: "job-1",
  owner: "alice",
  threadId: "t1",
  title: "Fix the flaky login test",
  goal: "Make the login test pass reliably on CI",
  acceptance: "bun test passes ten runs in a row",
  status: "active",
  launchIds: [LAUNCH_ID],
  sessionIds: [SESSION_ID],
  note: "Worker found a race in the session cookie setup",
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:30:00.000Z",
};

const session = {
  id: SESSION_ID,
  title: "flaky-login worker",
  status: "running",
} as unknown as Session;

const checkpoint = {
  id: "cp-1",
  sessionId: SESSION_ID,
  source: "self-reported",
  summary: "Reproduced the race; adding a retry-free fix",
  createdAt: "2026-10-07T10:20:00.000Z",
} as unknown as Checkpoint;

const ask = {
  id: "ask-1",
  sessionId: SESSION_ID,
  kind: "ask_human",
  question: "Should I also fix the logout test?",
  status: "pending",
  createdAt: "2026-10-07T10:25:00.000Z",
} as unknown as Ask;

const plan = { id: "plan-1", launchId: LAUNCH_ID, plan: "1. Patch cookie setup\n2. Run tests", status: "pending" } as unknown as PlanApproval;

const approval = {
  id: "appr-1",
  owner: "alice",
  jobId: "job-1",
  action: "send_to_session",
  summary: "Send the worker a nudge",
  args: { sessionId: SESSION_ID, text: "keep going" },
  status: "pending",
} as unknown as PersonaApproval;

const floorDecision: PersonaFloorDecision = {
  id: "fd-1",
  owner: "alice",
  askId: "ask-floor-1",
  sessionId: SESSION_ID,
  jobId: "job-1",
  threadId: "t1",
  gate: "safety_floor_owner",
  category: "outward",
  call: "git push origin HEAD:fix-login",
  reason: "alice asked for the push in the brief",
  decidedBy: "persona:alice",
  createdAt: "2026-10-07T10:26:00.000Z",
};

/** A job relaunched twice: two launches ended at coding, the third is live at screenshots. */
const RELAUNCHED: PersonaJob = {
  ...job,
  id: "job-3",
  launchIds: ["launch-a", "launch-b", "launch-c"],
  sessionIds: ["sess-a", "sess-b", "sess-c"],
};

function relaunchRun(n: string, stage: string, worker: PipelineWorker): PipelineRun {
  return {
    ...sampleRunUiChange,
    id: `run-${n}`,
    launchId: `launch-${n}`,
    currentStage: stage,
    status: "active",
    waitingReason: undefined,
    waitingKind: undefined,
    attempts: sampleRunUiChange.attempts.slice(0, stage === "coding" ? 1 : 7),
    worker,
  };
}

/** What the collector returns for RELAUNCHED's runs; a test may replace it. */
let relaunchedRuns: PipelineRun[] = [];

const LIVE_RELAUNCH = [
  relaunchRun("a", "coding", { state: "superseded", endedAt: "2026-10-09T09:00:00.000Z" }),
  relaunchRun("b", "coding", { state: "superseded", endedAt: "2026-10-09T09:30:00.000Z" }),
  relaunchRun("c", "screenshot", { state: "live" }),
];

const relaunchSessions = (cEnded?: string) =>
  ["a", "b", "c"].map(
    (n) =>
      ({
        id: `sess-${n}`,
        title: `worker ${n}`,
        status: n === "c" && !cEnded ? "running" : "idle",
        endedAt: n === "c" ? cEnded : "2026-10-09T09:00:00.000Z",
      }) as unknown as Session
  );

/** Bodies of the waive requests the drawer sent. */
const waives: unknown[] = [];

/** URLs of the floor-decisions reads the drawer sent. */
const floorReads: string[] = [];
const TUNNEL_URL = "https://alice-fix-the-flaky-login-test.tunnels.example.com";
const tunnel = {
  id: "rt-1",
  launchId: LAUNCH_ID,
  owner: "alice",
  name: "alice-fix-the-flaky-login-test",
  url: TUNNEL_URL,
  port: 5200,
  status: "open",
  expiresAt: "2026-10-08T10:30:00.000Z",
  createdAt: "2026-10-07T10:30:00.000Z",
  updatedAt: "2026-10-07T10:30:00.000Z",
};
/** The review tunnels the stubbed collector reports, and the teardown requests the drawer sent. */
let tunnels: Array<Record<string, unknown>> = [tunnel];
const tunnelCloses: string[] = [];
/** Persona's pipeline decisions for job-1, as GET /api/pipeline/decisions returns them (oldest first). */
const decisions = [
  {
    id: "dec-1",
    owner: "alice",
    jobId: "job-1",
    runId: sampleRunUiChange.id,
    stage: "screenshot",
    kind: "skip",
    reason: "API-only change, no UI to capture",
    actor: "alice's Persona",
    createdAt: "2026-10-07T10:10:00.000Z",
  },
  {
    id: "dec-2",
    owner: "alice",
    jobId: "job-1",
    runId: sampleRunUiChange.id,
    stage: "code_review",
    kind: "escalate",
    reason: "the code review stage needs an issue id only you can give",
    actor: "alice's Persona",
    createdAt: "2026-10-07T10:28:00.000Z",
  },
];

/** Sets a controlled input's value the way a user edit does, so React's onChange fires. */
function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
}

/** The collector routes the drawer and the transcript read, answered from fixtures. */
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === `/api/pipeline/runs/${sampleRunUiChange.id}/waive` && init?.method === "POST") {
      waives.push(JSON.parse(String(init.body)));
      return json({ run: { ...sampleRunUiChange, launchId: LAUNCH_ID, currentStage: "complete", status: "complete" } });
    }
    if (url === `/api/review-tunnels?launchIds=${LAUNCH_ID}`) return json({ tunnels });
    if (url.startsWith("/api/review-tunnels/") && url.endsWith("/close") && init?.method === "POST") {
      tunnelCloses.push(url);
      tunnels = tunnels.map((t) => ({ ...t, status: "closed", closeReason: "manual", closedAt: "2026-10-07T11:00:00.000Z" }));
      return json({ closed: true });
    }
    if (url === "/api/pipeline/decisions?jobId=job-1") return json({ decisions });
    if (url.startsWith("/api/pipeline/decisions")) return new Response("boom", { status: 500 });
    if (url.startsWith("/api/checkpoints")) return json([checkpoint, { ...checkpoint, id: "cp-other", sessionId: "someone-else" }]);
    if (url.startsWith("/api/asks/pending")) return json([ask]);
    if (url.startsWith("/api/plans/pending")) return json({ plans: [plan] });
    if (url.startsWith("/api/persona/floor-decisions")) {
      floorReads.push(url);
      return json({ decisions: url.includes("jobId=job-1") ? [floorDecision] : [] });
    }
    if (url.startsWith(`/api/pipeline/runs?launchIds=${encodeURIComponent(RELAUNCHED.launchIds.join(","))}`)) {
      return json({ runs: relaunchedRuns });
    }
    if (url.startsWith(`/api/pipeline/runs?launchIds=${LAUNCH_ID}`)) {
      return json({ runs: [{ ...sampleRunUiChange, launchId: LAUNCH_ID }] });
    }
    if (url.includes("/pending-ask")) return json({ ask, questions: null });
    if (url.includes("/transcript/events?sinceSeq=")) return json({ owned: true, cursor: 1, events: [] });
    if (url.includes("/transcript/events")) {
      return json({
        owned: true,
        cursor: 1,
        hasEarlier: false,
        events: [
          {
            seq: 1,
            eventId: "u1",
            createdAt: "2026-10-07T10:21:00.000Z",
            event: {
              type: "assistant",
              uuid: "u1",
              timestamp: "2026-10-07T10:21:00.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "Looking at the cookie race now." }] },
            },
          },
        ],
      });
    }
    return json({});
  }) as typeof fetch;
}

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ PersonaJobDrawer } = await import("./PersonaJobDrawer"));
  ({ TranscriptView } = await import("./TranscriptView"));
  router = await import("react-router-dom");
  stubFetch();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

let host: HTMLElement;
let root: Root;

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

/** Lets the drawer's and transcript's fetches resolve and render. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

/** Polls until `until` holds, letting fetches resolve between checks. */
async function waitFor(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

/** Wraps `stub` so floor-decisions reads never answer; `onHold` runs for each one held. */
function holdFloorReads(stub: typeof fetch, onHold: () => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/persona/floor-decisions")) {
      onHold();
      return new Promise<Response>(() => {});
    }
    return stub(input, init);
  }) as typeof fetch;
}

type DrawerProps = Parameters<typeof PersonaJobDrawer>[0];

function drawerProps(props: Partial<DrawerProps> = {}): DrawerProps {
  return {
    jobId: job.id,
    job,
    sessions: [session],
    approvals: [approval],
    onClose: () => {},
    onDiscuss: () => {},
    pollMs: 60_000,
    ...props,
  };
}

/**
 * The drawer inside a router, as the console renders it (its review action is
 * a route). Re-rendering with this keeps the same tree, so the drawer's state
 * survives a props change.
 */
function drawerTree(props: Partial<DrawerProps> = {}) {
  return createElement(router.MemoryRouter, { initialEntries: ["/persona"] }, createElement(PersonaJobDrawer, drawerProps(props)));
}

async function renderDrawer(props: Partial<DrawerProps> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const calls = { closed: 0, discussed: [] as string[] };
  await act(() =>
    root.render(
      drawerTree({
        onClose: () => calls.closed++,
        onDiscuss: (id: string) => calls.discussed.push(id),
        ...props,
      })
    )
  );
  await settle();
  return calls;
}

function buttons(): string[] {
  return [...host.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
}

describe("PersonaJobDrawer", () => {
  test("shows the job's title, intent and current state", async () => {
    await renderDrawer();
    const text = host.textContent ?? "";
    expect(host.querySelector("[role=dialog] h2")?.textContent).toBe("Fix the flaky login test");
    expect(text).toContain("Make the login test pass reliably on CI");
    expect(text).toContain("bun test passes ten runs in a row");
    expect(text).toContain("Worker found a race in the session cookie setup");
    expect(text).toContain("Reproduced the race; adding a retry-free fix");
    expect(text).toContain("Should I also fix the logout test?");
    expect(text).toContain("Patch cookie setup");
    expect(text).toContain("Approval");
    expect(text).toContain("flaky-login worker");
    expect(text).toContain("Looking at the cookie race now.");
  });

  test("a floor hold on the owner's card shows as that card, and its ask isn't listed again", async () => {
    const floorCard: PersonaApproval = {
      ...approval,
      id: "appr-floor",
      action: "answer_ask",
      args: { askId: ask.id, answer: "Allow once", floorHold: true },
    };
    const rendered: string[] = [];
    await renderDrawer({
      approvals: [approval, floorCard],
      renderFloorCard: (a) => {
        rendered.push(a.id);
        return createElement("button", { type: "button" }, "Allow once");
      },
    });
    expect(rendered).toContain("appr-floor");
    const cards = host.querySelector("[data-testid=job-floor-cards]");
    expect(cards?.textContent).toContain("Safety-floor hold only the owner can let run");
    expect(buttons()).toContain("Allow once");
    // Its ask is decided on the card; the other approval is still listed.
    expect(host.textContent).not.toContain("Question from flaky-login worker — Should I also fix the logout test?");
    expect(host.textContent).toContain("Approval");
  });

  test("the Persona chat's own card in the drawer: Allow once decides it, and Escape in its Deny box keeps the drawer open", async () => {
    const { ApprovalCard } = await import("./PersonaView");
    const floorCard: PersonaApproval = {
      ...approval,
      id: "appr-floor",
      action: "answer_ask",
      summary: 'Answer safety-floor hold "Safety floor held a Bash call" on session sess-111 with exactly "Allow once"',
      reason: "Persona can't allow this safety-floor hold: the call reads or moves secrets (the SSO cookie)",
      args: { askId: ask.id, answer: "Allow once", floorHold: true, sessionTitle: "flaky-login worker", askQuestion: "Safety floor held a Bash call (floor-tamper): reads the SSO cookie" },
    };
    const decided: Array<[string, string]> = [];
    const calls = await renderDrawer({
      approvals: [floorCard],
      renderFloorCard: (a) =>
        createElement(ApprovalCard, {
          approval: a,
          busy: new Set<string>(),
          errors: {},
          onDecide: (x: PersonaApproval, verdict: string) => void decided.push([x.id, verdict]),
          viewer: "alice",
          viewerOwner: "alice",
        }),
    });
    const cards = host.querySelector("[data-testid=job-floor-cards]")!;
    expect(cards.textContent).toContain("only you can let it run");
    expect(cards.textContent).toContain("It touches secrets: the SSO cookie.");
    const inCard = () => [...cards.querySelectorAll("button")];
    expect(inCard().map((b) => b.textContent)).toEqual(["Allow once", "Deny"]);
    await act(async () => void inCard()[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(decided).toEqual([["appr-floor", "approve"]]);
    // Deny opens its reason box; Escape there cancels the box, not the drawer.
    await act(async () => void inCard()[1]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const input = cards.querySelector("input")!;
    await act(async () => void input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
    expect(calls.closed).toBe(0);
    expect(cards.querySelector("input")).toBeNull();
  });

  test("without a card renderer (a read-only view) a floor card is listed as a line", async () => {
    const floorCard: PersonaApproval = { ...approval, id: "appr-floor", action: "answer_ask", args: { askId: ask.id, answer: "Allow once", floorHold: true } };
    await renderDrawer({ approvals: [floorCard] });
    expect(host.querySelector("[data-testid=job-floor-cards]")).toBeNull();
    expect(host.textContent).toContain("Question from flaky-login worker — Should I also fix the logout test?");
  });

  test("lists the floor holds Persona allowed once for the job, with call and reason", async () => {
    floorReads.length = 0;
    await renderDrawer();
    expect(floorReads[0]).toBe("/api/persona/floor-decisions?jobId=job-1");
    const rows = host.querySelectorAll("[data-testid=floor-decision]");
    expect(rows).toHaveLength(1);
    const text = rows[0]!.textContent ?? "";
    expect(text).toContain("Allowed once");
    expect(text).toContain("outward");
    expect(text).toContain("owner gate");
    expect(text).toContain("persona:alice");
    expect(text).toContain("git push origin HEAD:fix-login");
    expect(text).toContain("alice asked for the push in the brief");
    expect(host.textContent).toContain("Allowed once by Persona · 1");
  });

  test("reads another user's floor holds with ?user=, and shows no section when there are none", async () => {
    floorReads.length = 0;
    await renderDrawer({ job: { ...job, id: "job-2" }, jobId: "job-2", user: "bob" });
    expect(floorReads[0]).toBe("/api/persona/floor-decisions?jobId=job-2&user=bob");
    expect(host.querySelector("[data-testid=floor-decisions]")).toBeNull();
    expect(host.textContent).not.toContain("Allowed once by Persona");
  });

  test("a failed floor-decisions read on a later poll keeps the list on screen", async () => {
    const stub = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/persona/floor-decisions") && ++reads > 1) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      return stub(input, init);
    }) as typeof fetch;
    try {
      await renderDrawer({ pollMs: 15 });
      await waitFor(() => reads >= 3);
      expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
      expect(host.textContent).toContain("Allowed once by Persona · 1");
    } finally {
      globalThis.fetch = stub;
    }
  });

  test("the same job gaining a worker keeps its activity on screen until the next read lands", async () => {
    await renderDrawer();
    expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
    const stub = globalThis.fetch;
    let held = 0;
    globalThis.fetch = holdFloorReads(stub, () => held++);
    try {
      const grown = { ...job, sessionIds: [SESSION_ID, "sess-2222-bbbb"], launchIds: [LAUNCH_ID, "launch-2"] };
      await act(() => root.render(drawerTree({ job: grown })));
      await settle();
      expect(held).toBe(1);
      expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
      expect(host.textContent).toContain("Reproduced the race; adding a retry-free fix");
    } finally {
      globalThis.fetch = stub;
    }
  });

  test("switching to another job, or another user, clears the previous job's list", async () => {
    const stub = globalThis.fetch;
    let held = 0;
    try {
      await renderDrawer();
      expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
      globalThis.fetch = holdFloorReads(stub, () => held++);
      const other = { ...job, id: "job-3" };
      await act(() => root.render(drawerTree({ job: other, jobId: other.id })));
      await settle();
      expect(held).toBe(1);
      expect(host.querySelector("[data-testid=floor-decisions]")).toBeNull();
      expect(host.textContent).not.toContain("Reproduced the race; adding a retry-free fix");

      await act(() => root.unmount());
      host.remove();
      globalThis.fetch = stub;
      await renderDrawer();
      expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
      globalThis.fetch = holdFloorReads(stub, () => held++);
      await act(() => root.render(drawerTree({ user: "bob" })));
      await settle();
      expect(held).toBe(2);
      expect(host.querySelector("[data-testid=floor-decisions]")).toBeNull();
    } finally {
      globalThis.fetch = stub;
    }
  });

  test("shows the job's spend and time against its budget, and says when it is reached", async () => {
    await renderDrawer({
      job: {
        ...job,
        budget: {
          usd: 1,
          minutes: 120,
          source: { usd: "job", minutes: "user" },
          spentUsd: 1.2,
          personaUsd: 0.2,
          workerUsd: 1,
          elapsedMinutes: 45,
          level: "exceeded",
        },
      },
    });
    const meters = [...host.querySelectorAll("[role=meter]")];
    expect(meters.map((m) => m.getAttribute("aria-label"))).toEqual(["Spend used", "Time used"]);
    expect(meters[0]!.getAttribute("aria-valuenow")).toBe("100");
    expect(meters[1]!.getAttribute("aria-valuenow")).toBe("38");
    const text = host.textContent ?? "";
    expect(text).toContain("$1.20");
    expect(text).toContain("45m");
    expect(text).toContain("2h");
    expect(text).toContain("Workers $1.00 · Persona $0.20");
    expect(text).toContain("Budget reached");
  });

  test("shows a compact pipeline strip above the job, and the full pipeline after the workers", async () => {
    await renderDrawer();
    const strip = host.querySelector("[data-testid=job-drawer-pipeline-strip]")!;
    expect(strip).not.toBeNull();
    // The strip comes before the job's sections and carries no stage detail.
    const intent = [...host.querySelectorAll("section > div:first-child")].find((d) => d.textContent === "Intent")!;
    expect(strip.compareDocumentPosition(intent) & 4).toBe(4);
    expect(strip.querySelector('[data-stage="code_review"]')?.getAttribute("data-state")).toBe("current");
    expect(strip.textContent).toContain("code review stage needs an issue id from you");
    expect(strip.querySelector("[data-testid=pipeline-stage-detail]")).toBeNull();

    const titles = [...host.querySelectorAll("section > div:first-child")].map((d) => d.textContent);
    const at = titles.indexOf("Pipeline detail");
    expect(at).toBeGreaterThan(titles.findIndex((t) => t?.startsWith("Workers")));
    expect(host.querySelector("[data-testid=pipeline-view] [data-testid=pipeline-stage-detail]")).not.toBeNull();
  });

  test("shows the job's review tunnel URL and tears it down on request", async () => {
    tunnels = [tunnel];
    await renderDrawer();
    const link = host.querySelector<HTMLAnchorElement>("[data-testid=review-tunnel-url]")!;
    expect(link.getAttribute("href")).toBe(TUNNEL_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    // Also linked in the header, where it stays in view above the pipeline strips.
    expect(host.querySelector("[data-testid=job-drawer-review-tunnel]")?.getAttribute("href")).toBe(TUNNEL_URL);
    expect(host.textContent).toContain("serves the branch build on 127.0.0.1:5200");
    const tearDown = [...host.querySelectorAll("button")].find((b) => b.textContent === "Tear down")!;
    await act(async () => tearDown.click());
    await settle();
    expect(tunnelCloses).toEqual(["/api/review-tunnels/rt-1/close"]);
    expect(host.querySelector("[data-testid=review-tunnel-url]")).toBeNull();
    expect(host.querySelector("[data-testid=job-drawer-review-tunnel]")).toBeNull();
    expect(host.querySelector("[data-testid=review-tunnel-ended]")?.textContent).toContain("it was torn down by hand");
  });

  test("a read-only view shows the tunnel without the teardown button", async () => {
    tunnels = [tunnel];
    await renderDrawer({ onDiscuss: undefined });
    expect(host.querySelector("[data-testid=review-tunnel-url]")).not.toBeNull();
    expect(buttons()).not.toContain("Tear down");
  });

  test("the owner can waive the flagged stage from the pipeline detail", async () => {
    await renderDrawer();
    const view = host.querySelector("[data-testid=pipeline-view]")!;
    const open = [...view.querySelectorAll("button")].find((b) => b.textContent === "Waive this stage…")!;
    expect(open).toBeDefined();
    await act(() => open.click());
    const input = view.querySelector("input") as HTMLInputElement;
    await act(() => setNativeValue(input, "issue tracked elsewhere"));
    const submit = [...view.querySelectorAll("button")].find((b) => b.textContent === "Waive")!;
    await act(() => submit.click());
    await settle();
    expect(waives).toEqual([{ stage: "code_review", reason: "issue tracked elsewhere" }]);
    expect(host.querySelector('[data-testid=pipeline-view] [data-stage="complete"]')?.getAttribute("data-state")).toBe("passed");
  });

  test("lists Persona's pipeline decisions newest first, with what, which stage, why, who and when", async () => {
    await renderDrawer();
    const section = host.querySelector("[data-testid=job-drawer-pipeline-decisions]")!;
    expect(section.querySelector("section > div:first-child")?.textContent).toBe("Pipeline decisions");
    const rows = [...section.querySelectorAll("[data-decision]")] as HTMLElement[];
    expect(rows.map((r) => r.dataset.decision)).toEqual(["dec-2", "dec-1"]);
    expect(rows[0]!.textContent).toContain("Escalated to you · code_review — the code review stage needs an issue id only you can give");
    expect(rows[1]!.textContent).toContain("Skipped · screenshot — API-only change, no UI to capture");
    expect(rows[1]!.textContent).toContain("alice's Persona");
    // The pipeline detail says who decides its gates.
    expect(host.querySelector("[data-testid=job-drawer-pipeline-detail]")?.textContent).toContain(
      "Persona decides pipeline gates and escalates when it needs you."
    );
  });

  test("a new decision shows without reopening the drawer when the pipeline resyncs", async () => {
    await renderDrawer();
    const { publishPipelineResync } = await import("../lib/pipelineUpdates");
    decisions.push({
      id: "dec-3",
      owner: "alice",
      jobId: "job-1",
      runId: sampleRunUiChange.id,
      stage: "review",
      kind: "accept_wontfix",
      reason: "the token race is tracked in its own job",
      actor: "alice's Persona",
      createdAt: "2026-10-07T10:29:00.000Z",
    });
    try {
      await act(() => publishPipelineResync());
      await settle();
      const rows = [...host.querySelectorAll("[data-decision]")] as HTMLElement[];
      expect(rows[0]!.dataset.decision).toBe("dec-3");
      expect(rows[0]!.textContent).toContain("Accepted wontfix · review");
    } finally {
      decisions.pop();
    }
  });

  test("a parked run shows its badge live from a pipeline update, and clears when un-parked; park decisions are labelled", async () => {
    await renderDrawer();
    const { publishPipelineUpdate } = await import("../lib/pipelineUpdates");
    const strip = () => host.querySelector("[data-testid=job-drawer-pipeline-strip]")!;
    expect(strip().querySelector("[data-testid=pipeline-parked]")).toBeNull();
    const parked = {
      ...sampleRunUiChange,
      launchId: LAUNCH_ID,
      parked: { reason: "the schema change lands first", waitingOnJobId: "job-9", by: "persona" as const, actor: "alice's Persona", at: "2026-10-07T10:30:00.000Z" },
    };
    decisions.push({
      id: "dec-4",
      owner: "alice",
      jobId: "job-1",
      runId: sampleRunUiChange.id,
      stage: "code_review",
      kind: "park",
      reason: "the schema change lands first",
      actor: "alice's Persona",
      createdAt: "2026-10-07T10:30:00.000Z",
    });
    try {
      await act(() => publishPipelineUpdate(parked));
      await settle();
      expect(strip().querySelector("[data-testid=pipeline-parked]")?.textContent).toBe(
        "Parked by Persona — waiting on job job-9: the schema change lands first"
      );
      const rows = [...host.querySelectorAll("[data-decision]")] as HTMLElement[];
      expect(rows[0]!.textContent).toContain("Parked the worker · code_review — the schema change lands first");

      await act(() => publishPipelineUpdate({ ...parked, parked: undefined }));
      expect(strip().querySelector("[data-testid=pipeline-parked]")).toBeNull();
    } finally {
      decisions.pop();
    }
  });

  test("a change to the job's pipeline layer re-reads its decisions at once; a worker's own park reads as the worker's", async () => {
    await renderDrawer();
    const { publishPipelineConfigUpdate } = await import("../lib/pipelineUpdates");
    decisions.push({
      id: "dec-5",
      owner: "alice",
      jobId: "job-1",
      runId: sampleRunUiChange.id,
      stage: "coding",
      kind: "park",
      reason: "waiting for the schema job to land on main",
      actor: "sess-1",
      detail: { by: "worker" },
      createdAt: "2026-10-07T10:31:00.000Z",
    } as (typeof decisions)[number]);
    try {
      // Another job's layer leaves this drawer's list as it was.
      await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: null, scope: "job", jobId: "job-2" }));
      await settle();
      expect(host.querySelector('[data-decision="dec-5"]')).toBeNull();
      await act(() => publishPipelineConfigUpdate({ owner: "alice", projectId: null, scope: "job", jobId: "job-1" }));
      await settle();
      const rows = [...host.querySelectorAll("[data-decision]")] as HTMLElement[];
      expect(rows[0]!.dataset.decision).toBe("dec-5");
      expect(rows[0]!.textContent).toContain("Worker parked itself · coding — waiting for the schema job to land on main");
    } finally {
      decisions.pop();
    }
  });

  test("no decisions section when the read fails or the job has none", async () => {
    await renderDrawer({ jobId: "job-2", job: { ...job, id: "job-2" } });
    expect(host.querySelector("[data-testid=job-drawer-pipeline-decisions]")).toBeNull();
    expect(host.textContent).not.toContain("Pipeline decisions");
  });

  test("is read-only: no input, textarea or worker controls render", async () => {
    await renderDrawer();
    expect(host.querySelectorAll("input, textarea, select, [contenteditable=true]")).toHaveLength(0);
    const labels = buttons().join(" | ");
    for (const control of ["Send", "Interrupt", "Approve", "Deny", "Reject", "Submit", "Stop"]) {
      expect(labels).not.toMatch(new RegExp(`\\b${control}\\b`));
    }
    expect(host.textContent).toContain("Read-only");
  });

  test("the same transcript, not read-only, does render a reply box", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(createElement(TranscriptView, { sessionId: SESSION_ID, sessionEnded: false, eventSignal: 0 }))
    );
    await settle();
    expect(host.querySelectorAll("textarea").length).toBeGreaterThan(0);
  });

  /**
   * Renders the writable transcript with `pending` as its pending ask, recording
   * each resolve body and dismiss; `noTranscript` serves an empty transcript.
   */
  async function renderPendingAsk(pending: Ask, { noTranscript = false } = {}) {
    const base = globalThis.fetch;
    const resolves: { url: string; body: unknown }[] = [];
    const dismissals: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/pending-ask")) return json({ ask: pending, questions: null });
      if (url.endsWith("/resolve") && init?.method === "POST") {
        resolves.push({ url, body: JSON.parse(String(init.body)) });
        return json({ ok: true });
      }
      if (init?.method === "DELETE") {
        dismissals.push(url);
        return json({ ok: true });
      }
      if (noTranscript && url.includes("/transcript/events")) return json({ owned: true, cursor: 0, hasEarlier: false, events: [] });
      return base(input, init);
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(() =>
      root.render(createElement(TranscriptView, { sessionId: SESSION_ID, sessionEnded: false, eventSignal: 0 }))
    );
    await settle();
    return { resolves, dismissals, restore: () => void (globalThis.fetch = base) };
  }

  test("a pending ask_human is answerable with no transcript yet, and Dismiss ends it", async () => {
    const { dismissals, restore } = await renderPendingAsk(ask, { noTranscript: true });
    try {
      expect(host.textContent).toContain("No transcript found");
      expect(host.textContent).toContain("Should I also fix the logout test?");
      expect(host.querySelector("textarea")).not.toBeNull();
      const dismiss = [...host.querySelectorAll("button")].find((b) => b.textContent === "Dismiss")!;
      await act(async () => (dismiss as unknown as HTMLElement).click());
      await settle();
      expect(dismissals).toEqual(["/api/asks/ask-1"]);
    } finally {
      restore();
    }
  });

  test("a pending ask_human is answered in the transcript: the answer resolves the ask", async () => {
    const { resolves, restore } = await renderPendingAsk(ask);
    try {
      expect(host.textContent).toContain("Needs you");
      expect(host.textContent).toContain("Should I also fix the logout test?");
      const box = host.querySelector("textarea") as unknown as HTMLInputElement;
      await act(async () => setNativeValue(box, "yes, both"));
      await act(async () => {
        box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
      });
      await settle();
      expect(resolves).toEqual([{ url: "/api/asks/ask-1/resolve", body: { answer: "yes, both" } }]);
    } finally {
      restore();
    }
  });

  test("a pending floor hold offers only Allow once and Deny, and is labeled when high-risk", async () => {
    const hold = {
      ...ask,
      id: "ask-floor",
      gate: "safety_floor",
      question: "Safety floor held a Bash call (outward): HIGH RISK — git push origin main",
      options: ["Allow once", "Deny", "Allow always"],
    } as unknown as Ask;
    const { resolves, restore } = await renderPendingAsk(hold);
    try {
      expect(host.textContent).toContain("Needs you · high-risk floor hold");
      expect(host.querySelector("textarea")).toBeNull();
      const choices = [...host.querySelectorAll("button")].map((b) => b.textContent);
      expect(choices).toContain("Allow once");
      expect(choices).toContain("Deny");
      expect(choices).not.toContain("Allow always");
      const allow = [...host.querySelectorAll("button")].find((b) => b.textContent === "Allow once")!;
      await act(async () => (allow as unknown as HTMLElement).click());
      await settle();
      expect(resolves).toEqual([{ url: "/api/asks/ask-floor/resolve", body: { answer: "Allow once" } }]);
    } finally {
      restore();
    }
  });

  test("Esc, the backdrop and the close button dismiss it; Discuss hands back the job id", async () => {
    const calls = await renderDrawer();
    await act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(calls.closed).toBe(1);
    await act(() => (host.querySelector("[data-testid=job-drawer-backdrop]") as HTMLElement).click());
    await act(() => (host.querySelector("button[aria-label=Close]") as HTMLElement).click());
    expect(calls.closed).toBe(3);
    const discuss = [...host.querySelectorAll("button")].find((b) => b.textContent === "Discuss in Persona")!;
    await act(() => discuss.click());
    expect(calls.discussed).toEqual(["job-1"]);
  });

  test("Messages in thread shows the tagged count and hands back the job id", async () => {
    const shown: string[] = [];
    await renderDrawer({ messageCount: 4, onShowMessages: (id: string) => shown.push(id) });
    const link = host.querySelector("[data-testid=job-drawer-messages]") as HTMLElement;
    expect(link.textContent).toBe("Messages in thread (4)");
    await act(() => link.click());
    expect(shown).toEqual(["job-1"]);
  });

  test("Messages in thread omits the count when unknown, and is absent without a handler", async () => {
    await renderDrawer({ onShowMessages: () => {} });
    expect(host.querySelector("[data-testid=job-drawer-messages]")?.textContent).toBe("Messages in thread");
    await act(() => root.unmount());
    host.remove();
    await renderDrawer();
    expect(host.querySelector("[data-testid=job-drawer-messages]")).toBeNull();
  });

  test("a needs-you job offers every action behind the badge", async () => {
    const shown: string[] = [];
    const needsYou: PersonaJob = {
      ...job,
      status: "waiting_user",
      view: {
        state: "needs_you",
        needs: ["waiting"],
        actions: [
          { kind: "review", id: "rp-77", label: "Review: tighten the waive policy" },
          { kind: "approval", id: approval.id, label: "Approve: send the worker a nudge" },
          { kind: "message", id: "t1", label: "Answer Persona in the thread" },
          { kind: "pipeline", id: sampleRunUiChange.id, label: "Pipeline: code review stage needs an issue id" },
        ],
        lastActivityAt: "2026-10-07T10:30:00.000Z",
      },
    };
    const calls = await renderDrawer({ job: needsYou, onShowMessages: (id: string) => shown.push(id) });

    const actions = [...host.querySelectorAll("[data-testid=job-action]")] as HTMLElement[];
    expect(actions.map((a) => a.dataset.kind)).toEqual(["review", "approval", "message", "pipeline"]);
    expect(actions[0].getAttribute("href")).toBe("/review/rp-77");
    expect(actions[0].textContent).toBe("Review: tighten the waive policy");
    // The badge still names the state; the actions sit beside it.
    expect(host.querySelector("[role=dialog] span")?.textContent).toBe("needs you");

    await act(() => actions[1].click());
    expect(calls.discussed).toEqual([job.id]);
    await act(() => actions[2].click());
    expect(shown).toEqual([job.id]);
  });

  test("a single-launch job shows its one DAG and no earlier launches", async () => {
    await renderDrawer();
    expect(host.querySelectorAll("[data-testid=job-drawer-pipeline-strip] [data-testid=pipeline-strip]").length).toBe(1);
    expect(host.querySelectorAll("[data-testid=job-drawer-pipeline-detail] [data-testid=pipeline-view]").length).toBe(1);
    expect(host.querySelector("[data-testid=pipeline-earlier]")).toBeNull();
  });

  test("a relaunched job shows the live launch's DAG and folds the superseded ones away", async () => {
    relaunchedRuns = LIVE_RELAUNCH;
    await renderDrawer({ jobId: RELAUNCHED.id, job: RELAUNCHED, sessions: relaunchSessions() });
    const strips = [...host.querySelectorAll("[data-testid=job-drawer-pipeline-strip] [data-testid=pipeline-strip]")];
    expect(strips.map((s) => s.getAttribute("data-run"))).toEqual(["run-c"]);
    expect(strips[0]!.textContent).toContain("In progress · Screenshots");

    const detail = host.querySelector("[data-testid=job-drawer-pipeline-detail]")!;
    const earlier = detail.querySelector("details[data-testid=pipeline-earlier]") as HTMLDetailsElement;
    expect(earlier.open).toBe(false);
    expect(earlier.querySelector("summary")?.textContent).toBe("Earlier launches (2)");
    const folded = [...earlier.querySelectorAll("[data-testid=pipeline-view]")];
    expect(folded.map((v) => v.getAttribute("data-run"))).toEqual(["run-a", "run-b"]);
    for (const view of folded) {
      expect(view.textContent).toContain("Superseded at Coding");
      expect(view.textContent).not.toContain("In progress");
    }
    // The current DAG sits outside the fold.
    const current = [...detail.querySelectorAll("[data-testid=pipeline-view]")].filter((v) => !earlier.contains(v));
    expect(current.map((v) => v.getAttribute("data-run"))).toEqual(["run-c"]);
  });

  test("a live launch with its pipeline off doesn't promote a superseded launch's DAG to the strip", async () => {
    relaunchedRuns = [
      ...LIVE_RELAUNCH.slice(0, 2),
      { ...LIVE_RELAUNCH[2]!, status: "disabled", disabledReason: "opt_out" },
    ];
    await renderDrawer({ jobId: RELAUNCHED.id, job: RELAUNCHED, sessions: relaunchSessions() });
    expect(host.querySelector("[data-testid=job-drawer-pipeline-strip]")).toBeNull();
    const detail = host.querySelector("[data-testid=job-drawer-pipeline-detail]")!;
    const earlier = detail.querySelector("[data-testid=pipeline-earlier]")!;
    expect(earlier.querySelector("summary")?.textContent).toBe("Earlier launches (2)");
    const off = detail.querySelector("[data-testid=pipeline-off]")!;
    expect(earlier.contains(off)).toBe(false);
  });

  test("the live worker's session ending re-reads the runs and shows where it ended, without a refresh", async () => {
    relaunchedRuns = LIVE_RELAUNCH;
    await renderDrawer({ jobId: RELAUNCHED.id, job: RELAUNCHED, sessions: relaunchSessions() });
    expect(host.querySelector("[data-testid=job-drawer-pipeline-strip]")?.textContent).toContain("In progress · Screenshots");

    relaunchedRuns = [...LIVE_RELAUNCH.slice(0, 2), { ...LIVE_RELAUNCH[2]!, worker: { state: "ended", endedAt: "2026-10-09T11:00:00.000Z" } }];
    await act(() =>
      root.render(
        createElement(
          router.MemoryRouter,
          { initialEntries: ["/persona"] },
          createElement(PersonaJobDrawer, {
            jobId: RELAUNCHED.id,
            job: RELAUNCHED,
            sessions: relaunchSessions("2026-10-09T11:00:00.000Z"),
            approvals: [],
            onClose: () => {},
            pollMs: 60_000,
          })
        )
      )
    );
    await settle();
    const strip = host.querySelector("[data-testid=job-drawer-pipeline-strip]")!;
    // No worker is live: the newest launch stays the one DAG, labelled truthfully.
    expect([...strip.querySelectorAll("[data-testid=pipeline-strip]")].map((s) => s.getAttribute("data-run"))).toEqual(["run-c"]);
    expect(strip.textContent).toContain("Ended at Screenshots");
    expect(host.textContent).not.toContain("In progress");
    expect(host.querySelector("[data-testid=pipeline-earlier] summary")?.textContent).toBe("Earlier launches (2)");
  });

  test("an unknown job id says so", async () => {
    await renderDrawer({ jobId: "nope", job: undefined });
    expect(host.textContent).toContain("Job not found");
    expect(buttons()).not.toContain("Discuss in Persona");
    expect(buttons()).not.toContain("View worker");
  });
});

describe("PersonaJobDrawer layout", () => {
  test("the pipeline strip scrolls with the job's sections, below the fixed header", async () => {
    await renderDrawer();
    const scroll = host.querySelector("[data-testid=job-drawer-scroll]") as HTMLElement;
    expect(scroll.style.overflowY).toBe("auto");
    expect(scroll.querySelector("[data-testid=job-drawer-pipeline-strip]")).not.toBeNull();
    expect(scroll.textContent).toContain("Intent");
    expect(scroll.contains(host.querySelector("[role=dialog] h2"))).toBe(false);
    const transcript = host.querySelector("[data-testid=job-drawer-transcript]") as HTMLElement;
    expect(scroll.contains(transcript)).toBe(false);
    expect(transcript.textContent).toContain("Looking at the cookie race now.");
  });

  test("the transcript holds half the panel, a decision waiting or not, and gives way first on a cramped screen", async () => {
    // The fixtures' ask, plan and approval wait on the owner.
    await renderDrawer();
    const transcript = host.querySelector("[data-testid=job-drawer-transcript]") as HTMLElement;
    expect(transcript.style.flexBasis).toBe("50%");
    expect(transcript.style.flexShrink).toBe("1");
    expect(transcript.style.minHeight).toBe("min(200px, 30dvh)");
    const scroll = host.querySelector("[data-testid=job-drawer-scroll]") as HTMLElement;
    expect(scroll.style.minHeight).toBe("min(160px, 25dvh)");
  });

  test("floor-hold cards stay first in the scroll region, above the pipeline strip", async () => {
    const floorCard: PersonaApproval = { ...approval, id: "appr-floor", action: "answer_ask", args: { askId: ask.id, answer: "Allow once", floorHold: true } };
    await renderDrawer({ approvals: [floorCard], renderFloorCard: () => createElement("button", { type: "button" }, "Allow once") });
    const scroll = host.querySelector("[data-testid=job-drawer-scroll]")!;
    const cards = scroll.querySelector("[data-testid=job-floor-cards]")!;
    const strip = scroll.querySelector("[data-testid=job-drawer-pipeline-strip]")!;
    expect(cards.compareDocumentPosition(strip) & 4).toBe(4);
  });

  test("the strip's status line shows in the header only once the strip has scrolled past, and brings it back", async () => {
    await renderDrawer();
    const scroll = host.querySelector("[data-testid=job-drawer-scroll]") as HTMLElement;
    const strip = host.querySelector("[data-testid=job-drawer-pipeline-strip]") as HTMLElement;
    // happy-dom lays nothing out: place the strip at 12–212px of the scroll region.
    Object.defineProperty(strip, "offsetTop", { configurable: true, value: 12 });
    Object.defineProperty(strip, "offsetHeight", { configurable: true, value: 200 });
    const head = () => host.querySelector("[data-testid=job-drawer-head-stage]") as HTMLElement | null;
    const scrollTo = async (top: number) => {
      scroll.scrollTop = top;
      await act(() => {
        scroll.dispatchEvent(new window.Event("scroll") as unknown as Event);
      });
    };
    // The line shows exactly once the strip's bottom edge (12 + 200) has scrolled past.
    await scrollTo(211);
    expect(head()).toBeNull();
    await scrollTo(212);
    const line = head()!;
    // The same words the strip's banner shows, read out with what the click does.
    const text = line.textContent!.replace(/ ↑$/, "");
    expect(strip.textContent).toContain(text);
    expect(line.getAttribute("aria-label")).toBe(`${text}. Scroll back to the pipeline`);
    expect(line.querySelector("[aria-hidden=true]")?.textContent).toBe("↑");
    await scrollTo(100);
    expect(head()).toBeNull();

    await scrollTo(400);
    const scrolledTo: unknown[] = [];
    scroll.scrollTo = ((opts: unknown) => void scrolledTo.push(opts)) as typeof scroll.scrollTo;
    head()!.focus();
    await act(() => head()!.click());
    expect(scrolledTo).toEqual([{ top: 0, behavior: "smooth" }]);
    // Focus lands on the strip rather than on a header line that is about to go.
    expect(document.activeElement).toBe(strip);
  });

  test("on a phone the header actions take their own row under the title", async () => {
    window.happyDOM.setViewport({ width: 390, height: 844 });
    try {
      await renderDrawer({ onViewWorker: () => {} });
      const title = host.querySelector("[role=dialog] h2")!;
      const column = title.parentElement!;
      const labels = [...column.querySelectorAll("button")].map((b) => b.textContent);
      expect(labels).toContain("View worker");
      expect(labels).toContain("Discuss in Persona");
      // Once each: not also beside the title column.
      expect(buttons().filter((b) => b === "View worker")).toHaveLength(1);
      expect(buttons().filter((b) => b === "Discuss in Persona")).toHaveLength(1);
    } finally {
      window.happyDOM.setViewport({ width: 1024, height: 768 });
    }
  });

  test("with no worker yet the transcript pane takes only the room its note needs", async () => {
    await renderDrawer({ job: { ...job, sessionIds: [] } });
    const transcript = host.querySelector("[data-testid=job-drawer-transcript]") as HTMLElement;
    expect(transcript.style.flexBasis).toBe("auto");
    expect(transcript.textContent).toContain("The worker's live activity shows here");
  });
});

describe("PersonaJobDrawer View worker", () => {
  const LIVE = "sess-live-2222";
  const OLD = "sess-old-3333";
  const twoWorkers: PersonaJob = { ...job, sessionIds: [OLD, LIVE] };
  const oldSession = { id: OLD, title: "first worker", status: "done", endedAt: "2026-10-07T10:10:00.000Z" } as unknown as Session;
  const liveSession = { id: LIVE, title: "second worker", status: "running" } as unknown as Session;
  const viewWorker = () => [...host.querySelectorAll("button")].find((b) => b.textContent === "View worker") as HTMLButtonElement | undefined;

  test("opens the job's live worker", async () => {
    const opened: string[] = [];
    await renderDrawer({ job: twoWorkers, sessions: [oldSession, liveSession], onViewWorker: (id: string) => opened.push(id) });
    const button = viewWorker()!;
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.title).toBe("Open second worker in Live workers");
    await act(() => button.click());
    expect(opened).toEqual([LIVE]);
  });

  test("opens the newest worker when none is live", async () => {
    const opened: string[] = [];
    const ended = { ...liveSession, status: "done", endedAt: "2026-10-07T10:40:00.000Z" } as unknown as Session;
    await renderDrawer({ job: twoWorkers, sessions: [oldSession, ended], onViewWorker: (id: string) => opened.push(id) });
    await act(() => viewWorker()!.click());
    expect(opened).toEqual([LIVE]);
  });

  test("follows the worker picked in the Workers list", async () => {
    const opened: string[] = [];
    await renderDrawer({ job: twoWorkers, sessions: [oldSession, liveSession], onViewWorker: (id: string) => opened.push(id) });
    const tab = [...host.querySelectorAll("[role=tab]")].find((b) => b.textContent?.includes("first worker")) as HTMLElement;
    await act(() => tab.click());
    await act(() => viewWorker()!.click());
    expect(opened).toEqual([OLD]);
  });

  test("is disabled with a tooltip while the job has no worker", async () => {
    const opened: string[] = [];
    await renderDrawer({ job: { ...job, sessionIds: [] }, onViewWorker: (id: string) => opened.push(id) });
    const button = viewWorker()!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.title).toBe("No worker session yet");
    const note = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(note?.textContent).toContain("The worker's live activity shows here");
    await act(() => button.click());
    expect(opened).toEqual([]);
  });

  test("is absent without a handler", async () => {
    await renderDrawer();
    expect(viewWorker()).toBeUndefined();
  });
});
