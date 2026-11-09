import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { DECIDER_BACKENDS } from "@standup/shared";
import type {
  DeciderConfigView,
  DeciderDecisionRecord,
  DeciderKindConfig,
  DecisionKind,
  UserUsage,
} from "@standup/shared";
import { alpha, theme } from "./theme";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let YouView: typeof import("./YouView").YouView;
let Router: typeof import("react-router-dom");

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ YouView } = await import("./YouView"));
  Router = await import("react-router-dom");
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  globalThis.fetch = savedFetch;
  await window.happyDOM.close();
});

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove();
  root = undefined;
  globalThis.fetch = savedFetch;
});

const usage: UserUsage = {
  user: "alice",
  sessions: [
    {
      sessionId: "s-1",
      projectId: "p",
      title: "alice's run",
      status: "running",
      model: "claude-sonnet-5",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1500,
      costUsd: 1.25,
      user: "alice",
    },
  ],
  totals: {
    sessionCount: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 1500,
    costUsd: 1.25,
    unpricedSessionCount: 0,
  },
};

const floorDecision = {
  id: "fd-1",
  owner: "alice",
  askId: "ask-floor-1",
  sessionId: "s1",
  jobId: "job-1",
  gate: "safety_floor",
  category: "destructive",
  call: "rm -rf /tmp/login-build",
  reason: "the job's own build dir",
  decidedBy: "persona:alice",
  createdAt: "2026-10-07T10:26:00.000Z",
};

const kind = (k: DecisionKind, extra: Partial<DeciderKindConfig> = {}): DeciderKindConfig => ({
  kind: k,
  backend: "claude",
  source: "default",
  defaultBackend: "claude",
  suggestionOnly: k === "effort" || k === "model",
  ...extra,
});

const deciderConfig: DeciderConfigView = {
  alias: "alice",
  isOwner: false,
  kinds: [kind("project"), kind("turn_end"), kind("effort", { source: "user" }), kind("model")],
  user: { effort: "claude" },
  global: {},
};

const deciderDecisions: DeciderDecisionRecord[] = [
  {
    id: "d-1",
    kind: "project",
    backend: "claude",
    routedTo: "claude",
    choice: "standup",
    confidence: 0.82,
    latencyMs: 4512,
    fallbackReason: null,
    detail: null,
    alias: "alice",
    sessionId: null,
    launchId: "L1",
    createdAt: new Date().toISOString(),
  },
];

/** The playbooks route's reply: a status and its JSON body. */
interface PlaybooksReply {
  status: number;
  body: unknown;
}

/**
 * Answers the You tab's reads; `usageStatus` decides the usage route's reply,
 * `playbooks` the playbooks route's (an empty library by default), and
 * `decision` the reply to a POST on a playbook. `opts.persona` is the usage
 * reply's Persona block, and `opts.extra` answers any other request first
 * (undefined falls through). GETs are recorded as their URL, other methods as
 * "METHOD url".
 */
function mockFetch(
  calls: string[],
  usageStatus = 200,
  playbooks: PlaybooksReply = { status: 200, body: { playbooks: [] } },
  decision: PlaybooksReply = { status: 200, body: { ok: true, title: "Playbook" } },
  opts: { persona?: unknown; extra?: (url: string, init?: RequestInit) => unknown } = {}
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(method === "GET" ? url : `${method} ${url}`);
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const answered = opts.extra?.(url, init);
    if (answered !== undefined) return reply(answered);
    if (method === "POST" && url.startsWith("/api/persona/playbooks/")) return reply(decision.body, decision.status);
    if (url.startsWith("/api/usage/me")) {
      if (usageStatus !== 200) return reply({ error: "Sign in", reason: "sign-in" }, usageStatus);
      return reply(opts.persona ? { ...usage, persona: opts.persona } : usage);
    }
    if (url.startsWith("/api/persona/playbooks")) return reply(playbooks.body, playbooks.status);
    if (url === "/api/whoami") return reply({ user: "alice", tunnel: true, record: { alias: "alice" } });
    if (url === "/api/users/me/prefs") return reply({ alias: "alice", updatedAt: new Date().toISOString() });
    if (url.startsWith("/api/orchestration/profiles")) return reply({ profiles: [] });
    if (url.startsWith("/api/orchestration/default")) return reply({ name: null });
    if (url.startsWith("/api/persona/floor-decisions")) return reply({ decisions: [floorDecision] });
    if (url.startsWith("/api/persona/jobs")) return reply({ jobs: [{ id: "job-1", title: "Ship the login fix" }] });
    if (url === "/api/decider/config") return reply(deciderConfig);
    if (url.startsWith("/api/decider/decisions")) return reply(deciderDecisions);
    return reply({}, 404);
  }) as typeof fetch;
}

async function render(path: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const { MemoryRouter, Routes, Route } = Router;
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(Routes, null, createElement(Route, { path: "/you/:section?", element: createElement(YouView) }))
      )
    );
  });
  // Let the self-fetching sections settle.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const recentIso = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

/** A library with one accepted and one pending playbook. */
function library(): PlaybooksReply {
  const recent = recentIso();
  return {
    status: 200,
    body: {
      playbooks: [
        {
          slug: "ship-a-console-tab",
          title: "Ship a console tab",
          status: "accepted",
          whenToUse: "Adding a new tab or section to the web console",
          updatedAt: recent,
          fromJobId: "job-1",
          usage: {
            count: 3,
            lastUsedAt: recent,
            lastOutcome: { jobId: "job-7", status: "done", outcome: "Tab merged with tests green" },
          },
        },
        {
          slug: "rotate-credentials",
          title: "Rotate credentials",
          status: "pending",
          whenToUse: "Credential drift breaks a deploy",
          updatedAt: null,
          fromJobId: "job-2",
          usage: { count: 0, lastUsedAt: null, lastOutcome: null },
        },
      ],
    },
  };
}

async function clickAction(el: HTMLElement, slug: string, decision: string) {
  const button = el.querySelector(`[data-playbook="${slug}"] button[data-playbook-action="${decision}"]`) as HTMLElement | null;
  expect(button).not.toBeNull();
  await act(() => button!.click());
  await settle();
}

const playbookGets = (calls: string[]) => calls.filter((u) => u === "/api/persona/playbooks").length;

describe("YouView", () => {
  test("the usage section shows the viewer's own figures from /api/usage/me, never the fleet route", async () => {
    const calls: string[] = [];
    mockFetch(calls);
    const el = await render("/you/usage");
    const text = el.textContent ?? "";
    expect(text).toContain("Profile");
    expect(text).toContain("Cost & usage");
    expect(text).toContain("alice's run");
    expect(text).toContain("$1.25");
    expect(text).toContain("1.5K");
    expect(calls.some((u) => u.startsWith("/api/usage/me"))).toBe(true);
    expect(calls.some((u) => u.startsWith("/api/usage/fleet"))).toBe(false);
  });

  test("the decisions section lists Persona's floor allows with call, reason and a link to the job", async () => {
    const calls: string[] = [];
    mockFetch(calls);
    const el = await render("/you/decisions");
    const row = el.querySelector("[data-testid=floor-decision]");
    expect(row).not.toBeNull();
    const text = row!.textContent ?? "";
    expect(text).toContain("rm -rf /tmp/login-build");
    expect(text).toContain("the job's own build dir");
    expect(text).toContain("Persona gate");
    expect(row!.querySelector("a")?.getAttribute("href")).toBe("/persona?job=job-1");
    expect(row!.querySelector("a")?.textContent).toBe("Ship the login fix");
    expect(calls.some((u) => u.startsWith("/api/persona/floor-decisions"))).toBe(true);
  });

  test("the decisions section re-reads on its own, keeping the list through a failed read", async () => {
    const { PersonaDecisionsSection } = await import("./PersonaFloorDecisions");
    let reads = 0;
    let decisions: unknown[] = [];
    // Read 4 is held until released, so the screen right after the failed
    // read 3 can be checked before a later read rebuilds the list.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.startsWith("/api/persona/floor-decisions")) {
        reads++;
        if (reads === 3) return reply({ error: "boom" }, 500);
        if (reads >= 4) await held;
        return reply({ decisions });
      }
      if (url.startsWith("/api/persona/jobs")) return reply({ jobs: [] });
      return reply({}, 404);
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const { MemoryRouter } = Router;
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(PersonaDecisionsSection, { pollMs: 20 })));
    });
    const wait = async (until: () => boolean) => {
      for (let i = 0; i < 100 && !until(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    };
    await wait(() => reads >= 1);
    expect(host.textContent).toContain("hasn't allowed any");
    decisions = [floorDecision];
    await wait(() => host!.querySelectorAll("[data-testid=floor-decision]").length === 1);
    expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
    // Read 4 starting means read 3 has failed and settled; reads 4+ are held.
    await wait(() => reads >= 4);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
    expect(host.textContent).not.toContain("boom");
    expect(host.textContent).not.toContain("Couldn't load");
    release();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(host.querySelectorAll("[data-testid=floor-decision]")).toHaveLength(1);
  });

  test("the decisions section asks an unproven viewer to sign in", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const status = url.startsWith("/api/persona/") ? 401 : 404;
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const el = await render("/you/decisions");
    expect(el.textContent).toContain("Sign in to the console to see your Persona's floor allows");
  });

  test("the decider section shows each decision's routing and recent decisions", async () => {
    const calls: string[] = [];
    mockFetch(calls);
    const el = await render("/you/decider");
    const text = el.textContent ?? "";
    const { isYouSectionId } = await import("../lib/youSections");
    expect(isYouSectionId("decider")).toBe(true);
    expect(el.querySelector("#you-decider-title")?.textContent).toBe("Decision routing");
    expect(text).toContain("Project routing");
    expect(text).toContain("Turn-end classifier");
    const effort = el.querySelector('[data-testid="decider-row-effort"]')!;
    expect(effort.textContent).toContain("suggestion only");
    expect(effort.textContent).toContain("your setting");
    const project = el.querySelector('[data-testid="decider-row-project"]')!;
    expect(project.textContent).toContain("default");
    // A non-owner edits their own layer only.
    const [yours, everyones] = Array.from(project.querySelectorAll("select")) as HTMLSelectElement[];
    expect(yours.disabled).toBe(false);
    expect(everyones.disabled).toBe(true);
    // Each select offers the inherit choice and every backend.
    expect(Array.from(yours.options).map((o) => o.value)).toEqual(["", ...DECIDER_BACKENDS]);
    expect(text).toContain("Default (claude -p)");
    // The audit row shows the answer, its latency and its confidence.
    expect(text).toContain("standup");
    expect(text).toContain("4.5 s");
    expect(text).toContain("0.82");
  });

  test("the Workspace group holds the host-wide toggles and the account-wide orchestration profiles, tagged for everyone", async () => {
    const calls: string[] = [];
    mockFetch(calls, 200, undefined, undefined, {
      extra: (url) => (url === "/api/settings" ? { multiplayer: false, multiplayerOverride: "" } : undefined),
    });
    const el = await render("/you/workspace");
    for (let i = 0; i < 20 && !el.querySelector("#you-orchestration")?.textContent?.includes("account-wide"); i++) await settle();
    // The desktop rail lists the viewer's own sections, then the Workspace ones.
    const nav = el.querySelector('nav[aria-label="You sections"]')!;
    // Group labels name the rail's groups without outranking the sections' h2s.
    expect([...nav.querySelectorAll('[role="group"] > p')].map((h) => h.textContent)).toEqual(["Yours", "Workspace"]);
    expect(nav.querySelectorAll("h1, h2, h3")).toHaveLength(0);
    const workspaceLinks = [...nav.querySelectorAll('[aria-labelledby="you-group-workspace"] a')].map((a) => a.getAttribute("href"));
    expect(workspaceLinks).toEqual(["/you/workspace", "/you/orchestration"]);
    expect(nav.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/you/workspace");
    const general = el.querySelector("#you-workspace")!;
    expect(general.querySelector("h2")?.textContent).toBe("Multiplayer Everyone on this Standup");
    expect(general.textContent).toContain("Multiplayer");
    expect(general.textContent).toContain("multiplayer auto");
    // Auto-checkpoint and knowledge-first steering are always on, so neither has a switch.
    expect(general.textContent?.toLowerCase()).not.toContain("auto-checkpoint");
    expect(general.textContent?.toLowerCase()).not.toContain("knowledge-first");
    expect(el.querySelector("#you-orchestration")?.textContent).toContain("Orchestration profiles · account-wide");
    expect(calls).toContain("/api/settings");
    expect(calls.some((u) => u.startsWith("/api/orchestration/profiles?scope=global"))).toBe(true);
    // The viewer's own sections carry no tag.
    expect(el.querySelector("#you-profile-title")?.textContent).toBe("Profile");
    const { LEGACY_SETTINGS_PATH } = await import("../lib/youSections");
    expect(LEGACY_SETTINGS_PATH).toBe("/you/workspace");
  });

  test("a second click on the current section's link jumps to it again and rings it for a moment", async () => {
    const proto = window.HTMLElement.prototype as unknown as { scrollIntoView?: (opts?: unknown) => void };
    const original = proto.scrollIntoView;
    const scrolled: string[] = [];
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id);
    };
    try {
      mockFetch([]);
      const el = await render("/you/workspace");
      const section = el.querySelector("#you-workspace") as HTMLElement;
      const ring = `0 0 0 2px ${alpha(theme.accent, 0x66)}`;
      const faded = `0 0 0 2px ${alpha(theme.accent, 0)}`;
      // Landing on the path jumps there and rings it; the ring fades after 1200ms.
      expect(scrolled).toContain("you-workspace");
      expect(section.style.boxShadow).toBe(ring);
      await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
      expect(section.style.boxShadow).toBe(faded);
      scrolled.length = 0;
      const current = el.querySelector('nav[aria-label="You sections"] a[href="/you/workspace"]') as HTMLElement;
      expect(current.getAttribute("aria-current")).toBe("page");
      await act(() => current.click());
      expect(scrolled).toEqual(["you-workspace"]);
      expect(section.style.boxShadow).toBe(ring);
      await act(async () => { await new Promise((r) => setTimeout(r, 1300)); });
      expect(section.style.boxShadow).toBe(faded);
    } finally {
      proto.scrollIntoView = original;
    }
  });

  test("on a phone the sections are a chip row with a rule between the groups", async () => {
    window.happyDOM.setViewport({ width: 400, height: 800 });
    try {
      mockFetch([]);
      const el = await render("/you");
      const nav = el.querySelector('nav[aria-label="You sections"]')!;
      expect(nav.querySelectorAll('[role="group"]')).toHaveLength(0);
      // Bare /you opens on Profile, so its chip is the current one.
      expect(nav.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/you/profile");
      const kids = [...nav.children];
      const rule = kids.findIndex((k) => k.tagName === "SPAN");
      expect(kids[rule - 1]?.getAttribute("href")).toBe("/you/playbooks");
      expect(kids[rule + 1]?.getAttribute("href")).toBe("/you/workspace");
    } finally {
      window.happyDOM.setViewport({ width: 1024, height: 768 });
    }
  });

  test("a viewer the collector can't prove sees a sign-in prompt, not figures", async () => {
    mockFetch([], 403);
    const el = await render("/you/usage");
    const text = el.querySelector("#you-usage")?.textContent ?? "";
    expect(text).toContain("Sign in to the console to see your own usage");
    expect(text).not.toContain("$");
  });

  test.each([
    {
      name: "over budget: sections collapsed, the budget, and the titles not shown",
      reply: {
        chars: 9_640,
        maxChars: 10_000,
        sections: [
          { section: "memory", heading: "What the owner asked you to remember (topic · kind · saved)", body: "- [tables · preference · 2026-10-01] Prefer tables.\n- [tone · preference · 2026-09-01] Be brief.", entries: 2 },
          { section: "feedback", source: "owner", heading: "Feedback notes", body: "- [2026-09-01] prefers bullets", entries: 1 },
          { section: "feedback", source: "auto-memory", heading: "Claude Code auto-memory feedback notes", body: "- [2026-09-01] Tone: short", entries: 1 },
          { section: "instructions", heading: "The owner's own CLAUDE.md and rules (workers load these themselves)", body: "#### CLAUDE.md — Global notes\n#### Sub-heading\nUse imports.", entries: 1 },
        ],
        omitted: [
          { ref: "global/persona-alice-old", section: "memory", reason: "budget", title: "Old rule" },
          { ref: "global/review-notes", section: "notes", reason: "section-cap", title: "Review notes" },
        ],
        trimmed: ["global/native-mem-home-claude-md"],
      },
      usage: "9,640 / 10,000 chars · 2 not shown · 1 trimmed to fit",
      has: [
        "Memories you asked Persona to keep",
        "Feedback notes in your knowledge files (unverified)",
        "Claude Code auto-memory notes (unverified)",
        "Your CLAUDE.md and rules1 file",
        "Old rule",
        "Review notes",
        "ask Persona to remember or forget",
      ],
      groups: ["budget", "section-cap"],
    },
    {
      name: "empty profile",
      reply: { chars: 0, maxChars: 10_000, sections: [], omitted: [], trimmed: [] },
      usage: "0 / 10,000 chars",
      has: ["Persona hasn't saved anything about you yet."],
      groups: [],
    },
  ])("the profile section shows what Persona knows: $name", async ({ reply, usage, has, groups }) => {
    const calls: string[] = [];
    mockFetch(calls, 200, undefined, undefined, { extra: (url) => (url === "/api/persona/profile" ? reply : undefined) });
    const el = await render("/you/profile");
    expect(calls).toContain("/api/persona/profile");
    const view = el.querySelector('[data-persona-profile="ready"]');
    expect(view).not.toBeNull();
    expect(view!.querySelector("[data-persona-profile-usage]")?.textContent).toBe(usage);
    for (const text of has) expect(view!.textContent).toContain(text);
    // Progressive disclosure: every section starts collapsed, and nothing on it edits.
    for (const d of view!.querySelectorAll("details")) expect(d.hasAttribute("open")).toBe(false);
    expect(view!.querySelectorAll("button, input, textarea")).toHaveLength(0);
    expect([...view!.querySelectorAll("[data-persona-profile-omitted]")].map((d) => d.getAttribute("data-persona-profile-omitted"))).toEqual([...groups]);
  });

  test.each([
    { name: "an unproven viewer is asked to sign in", status: 403, body: { error: "sign in", reason: "sign-in" }, state: "sign-in", text: "Sign in to the console as the owner" },
    { name: "another refusal shows its error", status: 403, body: { error: "Host not allowed" }, state: "error", text: "Host not allowed" },
    { name: "Persona off on the collector", status: 503, body: { error: "Persona is disabled (STANDUP_PERSONA=0)" }, state: "unavailable", text: "Persona is off on this collector." },
  ])("the profile view's refusals: $name", async ({ status, body, state, text }) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const profile = String(input) === "/api/persona/profile";
      return new Response(JSON.stringify(profile ? body : {}), { status: profile ? status : 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const el = await render("/you/profile");
    expect(el.querySelector(`[data-persona-profile="${state}"]`)?.textContent).toContain(text);
  });

  test("the playbooks section lists accepted and pending playbooks with their reuse", async () => {
    const calls: string[] = [];
    mockFetch(calls, 200, library());
    const el = await render("/you/playbooks");
    expect(calls).toContain("/api/persona/playbooks");
    expect(el.textContent ?? "").toContain("Playbooks");

    const accepted = el.querySelector('[data-playbook="ship-a-console-tab"]')?.textContent ?? "";
    expect(accepted).toContain("Ship a console tab");
    expect(accepted).toContain("Accepted");
    expect(accepted).toContain("Adding a new tab or section to the web console");
    expect(accepted).toContain("Used 3 times · last 3d ago");
    expect(accepted).toContain("done");
    expect(accepted).toContain("Tab merged with tests green");
    expect(accepted).not.toContain("approve Persona's card");
    expect(accepted).toContain("Retire");
    expect(accepted).not.toContain("Keep");
    expect(el.querySelector('[data-playbook="ship-a-console-tab"]')?.getAttribute("data-playbook-status")).toBe("accepted");

    const pending = el.querySelector('[data-playbook="rotate-credentials"]')?.textContent ?? "";
    expect(pending).toContain("Rotate credentials");
    expect(pending).toContain("Awaiting your OK");
    expect(pending).toContain("Used 0 times");
    expect(pending).not.toContain("· last");
    expect(pending).toContain("Keep it here, or approve Persona's card in your thread.");
    expect(pending).toContain("Keep");
    expect(pending).toContain("Drop");
    expect(pending).not.toContain("Retire");
    expect(el.querySelector('[data-playbook="rotate-credentials"]')?.getAttribute("data-playbook-status")).toBe("pending");
  });

  test("Keep on a pending playbook accepts it and reloads the library", async () => {
    const calls: string[] = [];
    mockFetch(calls, 200, library());
    const el = await render("/you/playbooks");
    const before = playbookGets(calls);
    await clickAction(el, "rotate-credentials", "accept");
    expect(calls).toContain("POST /api/persona/playbooks/rotate-credentials/accept");
    expect(playbookGets(calls)).toBe(before + 1);
  });

  test("Retire on an accepted playbook posts the retire decision", async () => {
    const calls: string[] = [];
    mockFetch(calls, 200, library());
    const el = await render("/you/playbooks");
    await clickAction(el, "ship-a-console-tab", "retire");
    expect(calls).toContain("POST /api/persona/playbooks/ship-a-console-tab/retire");
  });

  test("a failed decision shows the route's error on that playbook and doesn't reload", async () => {
    const calls: string[] = [];
    mockFetch(calls, 200, library(), { status: 409, body: { error: "That playbook was already decided." } });
    const el = await render("/you/playbooks");
    const before = playbookGets(calls);
    await clickAction(el, "rotate-credentials", "reject");
    expect(calls).toContain("POST /api/persona/playbooks/rotate-credentials/reject");
    expect(el.querySelector('[data-playbook="rotate-credentials"]')?.textContent ?? "").toContain(
      "That playbook was already decided."
    );
    expect(el.querySelector('[data-playbook="ship-a-console-tab"]')?.textContent ?? "").not.toContain("already decided");
    expect(playbookGets(calls)).toBe(before);
    const drop = el.querySelector('[data-playbook="rotate-credentials"] button[data-playbook-action="reject"]') as HTMLButtonElement;
    expect(drop.disabled).toBe(false);
  });

  test("an empty playbook library explains how playbooks get made", async () => {
    mockFetch([]);
    const el = await render("/you/playbooks");
    expect(el.textContent ?? "").toContain("No playbooks yet. When a multi-launch job closes as done");
  });

  test("a viewer who isn't the proven owner sees a sign-in prompt instead of playbooks", async () => {
    mockFetch([], 200, { status: 403, body: { error: "Sign in", reason: "sign-in" } });
    const el = await render("/you/playbooks");
    const text = el.textContent ?? "";
    expect(text).toContain("to see your playbooks");
    expect(text).not.toContain("No playbooks yet");
  });

  test("a collector with Persona off says so", async () => {
    mockFetch([], 200, { status: 503, body: { error: "Persona is not running", reason: "unavailable" } });
    const el = await render("/you/playbooks");
    expect(el.textContent ?? "").toContain("Persona is off on this collector");
  });

  test("the usage section shows Persona's own spend and each job against its budget", async () => {
    mockFetch([], 200, undefined, undefined, {
      persona: {
        turns: 3,
        costUsd: 0.42,
        inputTokens: 12_000,
        outputTokens: 800,
        jobs: [
          {
            jobId: "j1",
            title: "Ship the cost ledger",
            status: "active",
            budget: {
              usd: 1,
              minutes: 480,
              source: { usd: "job", minutes: "default" },
              spentUsd: 0.85,
              personaUsd: 0.1,
              workerUsd: 0.75,
              elapsedMinutes: 30,
              level: "near",
            },
          },
        ],
      },
    });
    const el = await render("/you/usage");
    const text = el.querySelector("#you-usage")?.textContent ?? "";
    expect(text).toContain("Persona (orchestrator)");
    expect(text).toContain("$0.42");
    expect(text).toContain("3 turns");
    expect(text).toContain("Ship the cost ledger");
    expect(text).toContain("workers $0.75");
    expect(text).toContain("Persona $0.10");
    expect(text).toContain("Over 80% of its budget");
  });

  test("the job budgets section edits your default layer and shows what a new job gets", async () => {
    const calls: string[] = [];
    const puts: unknown[] = [];
    mockFetch(calls, 200, undefined, undefined, {
      extra: (url, init) => {
        if (url.startsWith("/api/job-budget") && init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
        if (url.startsWith("/api/job-budget")) {
          return {
            global: { usd: 5, minutes: null },
            project: null,
            resolved: { usd: 5, minutes: 480, source: { usd: "user", minutes: "default" } },
            defaults: { usd: 25, minutes: 480 },
          };
        }
        if (url === "/api/projects") return [{ id: "standup", name: "Standup" }];
        return undefined;
      },
    });
    const el = await render("/you/budgets");
    const section = el.querySelector("#you-budgets")!;
    expect(section.textContent).toContain("Job budgets");
    expect((section.querySelector("#job-budget-usd") as HTMLInputElement).value).toBe("5");
    expect(section.querySelector("[data-testid=job-budget-resolved]")?.textContent).toContain("$5.00");
    expect(section.querySelector("[data-testid=job-budget-resolved]")?.textContent).toContain("8h");
    const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save budget")!;
    await act(async () => {
      save.click();
    });
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(puts).toEqual([{ usd: 5, minutes: null }]);
  });

  test("the job budgets section sets no spend limit and a time budget in hours or minutes", async () => {
    const calls: string[] = [];
    const puts: unknown[] = [];
    mockFetch(calls, 200, undefined, undefined, {
      extra: (url, init) => {
        if (url.startsWith("/api/job-budget") && init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
        if (url.startsWith("/api/job-budget")) {
          return {
            global: { usd: 0, minutes: 120 },
            project: null,
            resolved: { usd: null, minutes: 120, source: { usd: "user", minutes: "user" } },
            defaults: { usd: null, minutes: 480 },
          };
        }
        if (url === "/api/projects") return [];
        return undefined;
      },
    });
    const el = await render("/you/budgets");
    const section = el.querySelector("#you-budgets")!;
    const usd = section.querySelector("#job-budget-usd") as HTMLInputElement;
    const usdNoLimit = section.querySelector("#job-budget-usd-unlimited") as HTMLInputElement;
    const time = section.querySelector("#job-budget-minutes") as HTMLInputElement;
    const unit = section.querySelector("#job-budget-time-unit") as unknown as HTMLInputElement;
    const timeNoLimit = section.querySelector("#job-budget-minutes-unlimited") as HTMLInputElement;
    // A saved 0 shows as No limit; whole hours show in hours.
    expect(usdNoLimit.checked).toBe(true);
    expect(usd.disabled).toBe(true);
    expect(time.value).toBe("2");
    expect(unit.value).toBe("hours");
    expect(timeNoLimit.checked).toBe(false);
    expect(section.querySelector("[data-testid=job-budget-resolved]")?.textContent).toContain("no spend limit");
    expect(section.textContent).toContain("no spend limit, 8h");

    const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save budget")!;
    const flush = async () => {
      for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    };
    await act(() => setValue(time, "1.5", "input"));
    await act(async () => save.click());
    await flush();
    // Switching the unit keeps the same length of time.
    await act(() => setValue(unit, "minutes", "change"));
    expect(time.value).toBe("120");
    await act(() => setValue(time, "45", "input"));
    await act(async () => save.click());
    await flush();
    // The reply re-seeds the form (the mock's 120 minutes shows as 2 hours).
    expect(unit.value).toBe("hours");
    // A positive time that rounds to 0 minutes is refused rather than saved as no limit.
    await act(() => setValue(time, "0.001", "input"));
    await act(async () => save.click());
    await flush();
    expect(section.textContent).toContain("Time must be at least 1 minute.");
    // The same in minutes: 0.001 hours shows as 0.06 minutes and is refused too.
    await act(() => setValue(unit, "minutes", "change"));
    expect(time.value).toBe("0.06");
    await act(async () => save.click());
    await flush();
    expect(section.textContent).toContain("Time must be at least 1 minute.");
    expect(puts).toHaveLength(2);
    // Unticking No limit and typing an amount sets a dollar limit; ticking it on time clears the time limit.
    await act(async () => usdNoLimit.click());
    await act(() => setValue(usd, "12.50", "input"));
    await act(async () => timeNoLimit.click());
    expect(time.disabled).toBe(true);
    await act(async () => save.click());
    await flush();
    expect(puts).toEqual([
      { usd: 0, minutes: 90 },
      { usd: 0, minutes: 45 },
      { usd: 12.5, minutes: 0 },
    ]);
  });
});

function setValue(el: HTMLInputElement, value: string, event: "input" | "change") {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new window.Event(event, { bubbles: true }) as unknown as Event);
}
