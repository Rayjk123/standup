import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { DEFAULT_NOTIFY_PREFS, resolveNotifyPrefs } from "@standup/shared";
import type { NotifyOverride } from "@standup/shared";
import type { NotifyPrefsResponse } from "./NotificationSettings";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Text",
  "Event",
  "MutationObserver",
  "localStorage",
] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let NotificationSettings: typeof import("./NotificationSettings").NotificationSettings;
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
  ({ NotificationSettings } = await import("./NotificationSettings"));
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

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

const REPORT = { id: "sched-1", title: "Daily report (9am ET)", cron: "0 9 * * 1-5", timezone: "America/New_York" };

/** The prefs response for a stored global layer, with `reportSchedules` still running. */
function prefsResponse(global: NotifyOverride | null, reportSchedules: (typeof REPORT)[] = []): NotifyPrefsResponse {
  const resolved = resolveNotifyPrefs([global]);
  const enabled = resolved.brief.enabled ?? reportSchedules.length === 0;
  return {
    global,
    project: null,
    resolved,
    projects: [],
    brief: {
      enabled,
      auto: resolved.brief.enabled === undefined,
      timezone: "America/New_York",
      nextAt: enabled ? "2026-10-09T12:30:00.000Z" : null,
      reportSchedules,
      recent: [],
    },
  };
}

/**
 * A collector answering the notifications routes: a PUT stores its layer and
 * echoes the view, a schedule PATCH pauses the report schedule. Every call is
 * recorded in `calls`.
 */
function mockCollector(
  calls: Call[],
  opts: { global?: NotifyOverride | null; reports?: (typeof REPORT)[]; privatePush?: boolean } = {}
) {
  let global = opts.global ?? null;
  let reports = opts.reports ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    const reply = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/notify-prefs") {
      if (method === "PUT") global = (body as { override: NotifyOverride }).override;
      if (method === "DELETE") global = null;
      const view = prefsResponse(global, reports);
      return reply(opts.privatePush === undefined ? view : { ...view, privatePush: opts.privatePush });
    }
    if (url.startsWith("/api/persona/schedules/") && method === "PATCH") {
      const id = decodeURIComponent(url.slice("/api/persona/schedules/".length));
      reports = reports.filter((s) => s.id !== id);
      return reply({ schedule: { ...REPORT, enabled: false } });
    }
    if (url === "/api/projects") return reply([{ id: "p", name: "Project P" }]);
    if (url.startsWith("/api/usage/me")) return reply({ error: "Sign in", reason: "sign-in" }, 403);
    if (url === "/api/whoami") return reply({ user: "alice", tunnel: true, record: { alias: "alice" } });
    if (url === "/api/users/me/prefs") return reply({ alias: "alice", updatedAt: new Date().toISOString() });
    if (url.startsWith("/api/orchestration/profiles")) return reply({ profiles: [] });
    if (url.startsWith("/api/orchestration/default")) return reply({ name: null });
    return reply({}, 404);
  }) as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(el);
  });
  await settle();
  return host;
}

function byLabel(label: string): HTMLInputElement {
  const el = host!.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no element labelled ${label}`);
  return el;
}

function button(text: string): HTMLButtonElement {
  const el = [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`no button "${text}"`);
  return el as HTMLButtonElement;
}

describe("NotificationSettings", () => {
  test("renders as the Notifications section of the You tab, loading the viewer's prefs", async () => {
    const calls: Call[] = [];
    mockCollector(calls);
    const { MemoryRouter, Routes, Route } = Router;
    const el = await mount(
      createElement(
        MemoryRouter,
        { initialEntries: ["/you/notifications"] },
        createElement(Routes, null, createElement(Route, { path: "/you/:section?", element: createElement(YouView) }))
      )
    );
    const section = el.querySelector("#you-notifications");
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain("Notifications");
    expect(section!.querySelector("[data-testid=notification-settings]")).not.toBeNull();
    expect(section!.querySelector("[data-testid=brief-settings]")).not.toBeNull();
    expect(calls.some((c) => c.url === "/api/notify-prefs" && c.method === "GET")).toBe(true);
    // The defaults show: decisions go to Slack and push, progress and done stay in the console.
    expect(byLabel("Decisions: Slack DM").checked).toBe(true);
    expect(byLabel("Decisions: Push").checked).toBe(true);
    expect(byLabel("Progress: Slack DM").checked).toBe(false);
    expect(byLabel("Job done: Slack DM").checked).toBe(false);
    expect(byLabel("Job done: Push").checked).toBe(false);
    expect(byLabel("Daily brief enabled").checked).toBe(true);
  });

  test("toggling a channel and saving PUTs only that route's change to the global layer", async () => {
    const calls: Call[] = [];
    mockCollector(calls);
    await mount(createElement(NotificationSettings));
    await act(async () => byLabel("Job done: Push").click());
    expect(byLabel("Job done: Push").checked).toBe(true);
    // Nothing is sent until Save.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    await act(async () => button("Save notifications").click());
    await settle();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toEqual([
      { url: "/api/notify-prefs", method: "PUT", body: { override: { routes: { done: { channels: ["push"] } } } } },
    ]);
    expect(host!.textContent).toContain("Saved.");
    // The reloaded view keeps the saved choice.
    expect(byLabel("Job done: Push").checked).toBe(true);
  });

  test("unticking a default channel saves the remaining channels", async () => {
    const calls: Call[] = [];
    mockCollector(calls);
    await mount(createElement(NotificationSettings));
    await act(async () => byLabel("Decisions: Push").click());
    await act(async () => button("Save notifications").click());
    await settle();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ override: { routes: { decision: { channels: ["slack"] } } } });
    expect(DEFAULT_NOTIFY_PREFS.routes.decision.channels).toEqual(["slack", "push"]);
  });

  test("the switch-over turns the brief on and pauses the report schedule it replaces", async () => {
    const calls: Call[] = [];
    mockCollector(calls, { reports: [REPORT] });
    await mount(createElement(NotificationSettings));
    const notice = host!.querySelector("[data-testid=brief-switch-over]");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain("Daily report (9am ET)");
    expect(notice!.textContent).toContain("the brief is off for now");
    expect(byLabel("Daily brief enabled").checked).toBe(false);

    await act(async () => button("Switch to the brief").click());
    await settle();
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes).toEqual([
      { url: "/api/notify-prefs", method: "PUT", body: { override: { brief: { enabled: true } } } },
      { url: "/api/persona/schedules/sched-1", method: "PATCH", body: { enabled: false } },
    ]);
    expect(host!.textContent).toContain("Switched — the brief is on");
    expect(host!.querySelector("[data-testid=brief-switch-over]")).toBeNull();
    expect(byLabel("Daily brief enabled").checked).toBe(true);
  });

  test("without a private push topic, Push is disabled and unticked for brief, done and progress but not decisions", async () => {
    // Every route lists push, so an unticked box is the component's doing.
    const global: NotifyOverride = {
      routes: {
        decision: { channels: ["slack", "push"] },
        progress: { channels: ["push"], when: "always" },
        done: { channels: ["slack", "push"] },
        brief: { channels: ["slack", "push"] },
      },
    };
    mockCollector([], { global, privatePush: false });
    await mount(createElement(NotificationSettings));
    for (const title of ["Daily brief", "Job done", "Progress"]) {
      expect({ title, disabled: byLabel(`${title}: Push`).disabled, checked: byLabel(`${title}: Push`).checked }).toEqual({
        title,
        disabled: true,
        checked: false,
      });
      expect(byLabel(`${title}: Slack DM`).disabled).toBe(false);
    }
    expect(byLabel("Decisions: Push").disabled).toBe(false);
    expect(byLabel("Decisions: Push").checked).toBe(true);
    expect(host!.textContent).toContain("only once you have an ntfy topic of your own");
  });

  test("with a private push topic, or none reported, every Push box is enabled", async () => {
    for (const privatePush of [true, undefined]) {
      mockCollector([], { global: { routes: { brief: { channels: ["push"] } } }, privatePush });
      await mount(createElement(NotificationSettings));
      for (const title of ["Decisions", "Progress", "Job done", "Daily brief"]) {
        expect({ privatePush, title, disabled: byLabel(`${title}: Push`).disabled }).toEqual({ privatePush, title, disabled: false });
      }
      expect(byLabel("Daily brief: Push").checked).toBe(true);
      expect(host!.textContent).not.toContain("only once you have an ntfy topic of your own");
      await act(() => root!.unmount());
      host!.remove();
      root = undefined;
    }
  });

  test("an explicit off hides the switch-over even while a report schedule runs", async () => {
    mockCollector([], { global: { brief: { enabled: false } }, reports: [REPORT] });
    await mount(createElement(NotificationSettings));
    expect(host!.querySelector("[data-testid=brief-switch-over]")).toBeNull();
    expect(byLabel("Daily brief enabled").checked).toBe(false);
  });
});
