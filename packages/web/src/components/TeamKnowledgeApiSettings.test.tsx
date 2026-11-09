import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the component modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();
const savedFetch = globalThis.fetch;

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let TeamKnowledgeApiSettings: typeof import("./TeamKnowledgeApiSettings").TeamKnowledgeApiSettings;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ TeamKnowledgeApiSettings } = await import("./TeamKnowledgeApiSettings"));
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

/** The collector's reply to both GET and PUT /api/public-knowledge/access. */
interface Access {
  aliases: string[];
  posixGroups: string[];
  enabled: boolean;
  socketPath?: string;
  error?: string;
  synthesis?: { degraded: boolean; lastFailureAt?: string };
}

interface Replies {
  access?: Partial<Access>;
  accessStatus?: number;
  putStatus?: number;
  patchStatus?: number;
  calls?: unknown[];
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers the section's routes from `replies`, recording every request in `log`. */
function mockFetch(log: Call[], replies: Replies = {}) {
  let access: Access = {
    aliases: ["bob"],
    posixGroups: ["team-x"],
    enabled: true,
    socketPath: "/tmp/standup-kb.sock",
    ...replies.access,
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    log.push({ url, method, body });
    if (url === "/api/public-knowledge/access" && method === "GET") {
      return replies.accessStatus ? reply({ error: "owner only" }, replies.accessStatus) : reply(access);
    }
    if (url === "/api/public-knowledge/access" && method === "PUT") {
      if (replies.putStatus) return reply({ error: "bad alias list" }, replies.putStatus);
      const lists = body as { aliases: string[]; posixGroups: string[] };
      // The server stores lowercased aliases and replies with the whole access view, listener status included.
      access = {
        aliases: lists.aliases.map((a) => a.toLowerCase()),
        posixGroups: lists.posixGroups,
        enabled: access.enabled,
        ...(access.socketPath ? { socketPath: access.socketPath } : {}),
        ...(access.error ? { error: access.error } : {}),
      };
      return reply(access);
    }
    if (url.startsWith("/api/public-knowledge/usage")) return reply({ calls: replies.calls ?? [] });
    if (url === "/api/projects") {
      return reply([
        { id: "alpha", name: "Alpha", shareable: true },
        { id: "beta", name: "Beta" },
        { id: "gamma", name: "Gamma", shareable: false },
        { id: "global", name: "Global", reserved: true, shareable: false },
        { id: "house", name: "House", reserved: true, shareable: false },
      ]);
    }
    if (url.startsWith("/api/projects/") && method === "PATCH") {
      return replies.patchStatus ? reply({ error: "nope" }, replies.patchStatus) : reply({});
    }
    return reply({}, 404);
  }) as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(TeamKnowledgeApiSettings));
  });
  await settle();
  return host;
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  await settle();
}

async function typeAndSubmit(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => {
    input.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();
}

describe("TeamKnowledgeApiSettings", () => {
  test("renders status, the example call, projects and the empty usage state", async () => {
    mockFetch([]);
    const el = await render();
    const text = el.textContent ?? "";
    expect(text).toContain("Serving");
    expect(text).toContain("/tmp/standup-kb.sock");
    expect(text).toContain("Example call");
    expect(text).toContain("curl -s 'https://<proxy-url>/api/public/knowledge/v1/search?q=...'");
    expect(text).toContain("put the proxy's URL in place of https://<proxy-url>");
    expect(text).toContain("STANDUP_PUBLIC_KB_IDENTITY_HEADER names that header");
    expect(buttonByText(el, "Copy").disabled).toBe(false);
    expect(text).toContain("bob");
    expect(text).toContain("team-x");
    expect(text).toContain("No calls yet");
    const boxes = [...el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((b) => b.checked);
    expect(boxes).toEqual([true, true, false, true, false]);
    expect(buttonByText(el, "Save allowlist").disabled).toBe(true);
  });

  test("the example call survives a save", async () => {
    mockFetch([]);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "carol");
    await click(buttonByText(el, "Save allowlist"));
    expect(el.textContent).toContain("curl -s 'https://<proxy-url>/api/public/knowledge/v1/search?q=...'");
  });

  test("adding and removing an alias then saving PUTs the edited lists", async () => {
    const log: Call[] = [];
    mockFetch(log);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "carol");
    await click(el.querySelector('button[aria-label="Remove bob"]')!);
    expect(el.textContent).toContain("carol");
    const save = buttonByText(el, "Save allowlist");
    expect(save.disabled).toBe(false);
    await click(save);
    const put = log.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/public-knowledge/access");
    expect(put?.body).toEqual({ aliases: ["carol"], posixGroups: ["team-x"] });
    expect(el.textContent).toContain("Saved");
    expect(buttonByText(el, "Save allowlist").disabled).toBe(true);
  });

  test("the serving status survives a save because PUT replies with the full access view", async () => {
    mockFetch([]);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "Carol");
    await click(buttonByText(el, "Save allowlist"));
    const text = el.textContent ?? "";
    expect(text).toContain("Saved");
    expect(text).toContain("Serving");
    expect(text).not.toContain("Not serving");
    expect(text).toContain("/tmp/standup-kb.sock");
    expect(text).toContain("carol");
    expect(buttonByText(el, "Save allowlist").disabled).toBe(true);
  });

  test("a listener that failed to start shows the reason", async () => {
    const reason = "/run/standup/public is accessible to group or others (mode 755); it must be 0700";
    mockFetch([], { access: { enabled: false, socketPath: "/run/standup/public/kb.sock", error: reason } });
    const el = await render();
    const text = el.textContent ?? "";
    expect(text).toContain(`Not serving: ${reason}`);
    expect(text).not.toContain("set STANDUP_PUBLIC_KB=1");
  });

  test("a disabled API without an error explains how to turn it on", async () => {
    mockFetch([], { access: { enabled: false, socketPath: undefined } });
    const el = await render();
    const text = el.textContent ?? "";
    expect(text).toContain("Not serving");
    expect(text).not.toContain("Not serving:");
    expect(text).toContain("set STANDUP_PUBLIC_KB=1 and STANDUP_PUBLIC_KB_IDENTITY_HEADER, then restart");
  });

  test("the global project is always shared and can't be unticked", async () => {
    const log: Call[] = [];
    mockFetch(log);
    const el = await render();
    const global = el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[3];
    expect(global.checked).toBe(true);
    expect(global.disabled).toBe(true);
    expect(global.title).toBe("Always shared");
    await click(global);
    expect(log.some((c) => c.method === "PATCH")).toBe(false);
    expect(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[3].checked).toBe(true);
  });

  test("a reserved project other than the global corpus is toggleable", async () => {
    const log: Call[] = [];
    mockFetch(log);
    const el = await render();
    const house = el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[4];
    expect(house.checked).toBe(false);
    expect(house.disabled).toBe(false);
    expect(house.title).toBe("");
    await click(house);
    expect(log.find((c) => c.method === "PATCH")).toEqual({ url: "/api/projects/house", method: "PATCH", body: { shareable: true } });
    expect(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[4].checked).toBe(true);
  });

  test("aliases dedupe whatever their case; POSIX groups, which are case-sensitive, don't", async () => {
    const log: Call[] = [];
    mockFetch(log);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "BOB");
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add group"]')!, "Team-X");
    await click(buttonByText(el, "Save allowlist"));
    expect(log.find((c) => c.method === "PUT")?.body).toEqual({ aliases: ["bob"], posixGroups: ["team-x", "Team-X"] });
  });

  test("a degraded public synthesis says so, with when and why", async () => {
    mockFetch([], { access: { synthesis: { degraded: true, lastFailureAt: "2026-10-01T12:00:00.000Z" } } });
    const text = (await render()).querySelector('[role="status"]')?.textContent ?? "";
    expect(text).toContain("Answers are falling back to raw passages");
    expect(text).toContain("claude --bare");
    expect(text).toContain("ANTHROPIC_API_KEY");
  });

  test("a working public synthesis shows no warning", async () => {
    mockFetch([], { access: { synthesis: { degraded: false, lastFailureAt: "2026-10-01T12:00:00.000Z" } } });
    expect((await render()).querySelector('[role="status"]')).toBeNull();
  });

  test("an invalid name is refused without being added", async () => {
    mockFetch([]);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add group"]')!, "-bad group");
    expect(el.textContent).toContain("isn't a valid group");
    expect(buttonByText(el, "Save allowlist").disabled).toBe(true);
  });

  test("a group may start with '_' but an alias may not", async () => {
    const log: Call[] = [];
    mockFetch(log);
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add group"]')!, "_kb-team");
    expect(el.textContent).not.toContain("isn't a valid group");
    expect(el.textContent).toContain("_kb-team");
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "_carol");
    expect(el.textContent).toContain("isn't a valid user name");
    await click(buttonByText(el, "Save allowlist"));
    expect(log.find((c) => c.method === "PUT")?.body).toEqual({ aliases: ["bob"], posixGroups: ["team-x", "_kb-team"] });
  });

  test("the help text covers default sharing, group membership and the advisory call log", async () => {
    mockFetch([]);
    const text = (await render()).textContent ?? "";
    expect(text).toContain("New projects are shared by default; untick a project to withhold its knowledge.");
    expect(text).toContain("id -Gn, which includes each user's primary group");
    expect(text).toContain("The call log is advisory: callers on this host can write to it.");
  });

  test("a rejected save shows the collector's error", async () => {
    mockFetch([], { putStatus: 400 });
    const el = await render();
    await typeAndSubmit(el.querySelector<HTMLInputElement>('input[aria-label="Add user name"]')!, "dave");
    await click(buttonByText(el, "Save allowlist"));
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("bad alias list");
  });

  test("a failed share toggle reverts the checkbox", async () => {
    const log: Call[] = [];
    mockFetch(log, { patchStatus: 500 });
    const el = await render();
    const first = el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0];
    await click(first);
    expect(log.find((c) => c.method === "PATCH")).toEqual({
      url: "/api/projects/alpha",
      method: "PATCH",
      body: { shareable: false },
    });
    expect(el.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0].checked).toBe(true);
    expect(el.textContent).toContain("Alpha: nope");
  });

  test("recent calls render with alias, endpoint, query and status", async () => {
    mockFetch([], {
      calls: [
        { at: Date.now() - 5 * 60_000, alias: "bob", endpoint: "/v1/search", query: "deploy runbook", status: 200 },
        { at: new Date().toISOString(), alias: "eve", endpoint: "/v1/docs", query: "secret", status: 403 },
      ],
    });
    const el = await render();
    const rows = [...el.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("5m ago");
    expect(rows[0]).toContain("deploy runbook");
    expect(rows[1]).toContain("eve");
    expect(rows[1]).toContain("403");
  });

  test("a non-owner sees only the owner-only notice", async () => {
    mockFetch([], { accessStatus: 403 });
    const el = await render();
    const text = el.textContent ?? "";
    expect(text).toContain("Only the owner can manage this");
    expect(text).not.toContain("Save allowlist");
    expect(el.querySelector("table")).toBeNull();
  });
});
