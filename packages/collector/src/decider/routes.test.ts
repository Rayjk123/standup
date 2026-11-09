import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context } from "hono";
import type { DeciderConfigView, DeciderDecisionRecord, LaunchSuggestion } from "@standup/shared";
import { createStore, getUserDeciderPrefs, recordDeciderDecision, type Store } from "@standup/store";
import { mountDeciderRoutes } from "./routes.js";

/**
 * The decider API over a bare Hono app: identity comes from an `x-test-user`
 * header, a person carries `x-test-human`, and the owner is `owner`.
 */
function app(
  store: Store,
  suggest?: (ctx: { alias: string }, task: string) => Promise<LaunchSuggestion>
): Hono {
  const a = new Hono();
  const personOf = (c: Context) => (c.req.header("x-test-human") ? c.req.header("x-test-user") ?? "host" : null);
  mountDeciderRoutes(a, {
    db: store.db,
    personOf,
    isOwner: (c) => personOf(c) === "owner",
    suggest,
  });
  return a;
}

const SUGGESTION: LaunchSuggestion = {
  effort: { choice: "medium", confidence: null, backend: "claude", latencyMs: 80 },
  model: { choice: "sonnet", confidence: null, backend: "claude", latencyMs: 80 },
};

const human = (user: string) => ({ "x-test-user": user, "x-test-human": "1", "content-type": "application/json" });

let store: Store;
const originalLog = console.log;
beforeEach(() => {
  store = createStore(":memory:");
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

function record(alias: string | null, kind: "project" | "turn_end" = "project") {
  recordDeciderDecision(store.db, {
    kind,
    backend: "claude",
    routedTo: "claude",
    choice: "standup",
    confidence: null,
    latencyMs: 90,
    fallbackReason: null,
    detail: null,
    alias,
    sessionId: null,
    launchId: null,
  });
}

describe("decider routes", () => {
  test("config shows the resolved routing, and needs a person", async () => {
    const a = app(store);
    expect((await a.request("/api/decider/config", { headers: { "x-test-user": "ana" } })).status).toBe(403);
    const res = await a.request("/api/decider/config", { headers: human("ana") });
    const view = (await res.json()) as DeciderConfigView;
    expect(view.alias).toBe("ana");
    expect(view).toEqual({ alias: "ana", isOwner: false, kinds: expect.any(Array), user: {}, global: {} });
    expect(view.kinds.find((k) => k.kind === "project")).toMatchObject({ backend: "claude", source: "default" });
    expect(view.kinds.find((k) => k.kind === "model")).toMatchObject({ backend: "claude", suggestionOnly: true });
  });

  test("PUT prefs writes only the caller's own layer and drops unknown values", async () => {
    const a = app(store);
    const res = await a.request("/api/decider/prefs", {
      method: "PUT",
      headers: human("ana"),
      body: JSON.stringify({ backends: { project: "claude", effort: "gpt", model: "retired-backend", bogus: "claude" } }),
    });
    expect(res.status).toBe(200);
    expect(getUserDeciderPrefs(store.db, "ana").backends).toEqual({ project: "claude" });
    expect(getUserDeciderPrefs(store.db, "bo").backends).toEqual({});
    const view = (await res.json()) as DeciderConfigView;
    expect(view.kinds.find((k) => k.kind === "project")).toMatchObject({ backend: "claude", source: "user" });
  });

  test("PUT prefs rejects a worker and a malformed body", async () => {
    const a = app(store);
    const worker = await a.request("/api/decider/prefs", {
      method: "PUT",
      headers: { "x-test-user": "ana", "content-type": "application/json" },
      body: JSON.stringify({ backends: { project: "claude" } }),
    });
    expect(worker.status).toBe(403);
    const bad = await a.request("/api/decider/prefs", { method: "PUT", headers: human("ana"), body: "[1]" });
    expect(bad.status).toBe(400);
  });

  test("PUT global is the owner's alone", async () => {
    const a = app(store);
    const body = JSON.stringify({ backends: { project: "claude" } });
    expect((await a.request("/api/decider/global", { method: "PUT", headers: human("ana"), body })).status).toBe(403);
    const res = await a.request("/api/decider/global", { method: "PUT", headers: human("owner"), body });
    expect(res.status).toBe(200);
    const view = (await res.json()) as DeciderConfigView;
    expect(view.global).toEqual({ project: "claude" });
  });

  test("decisions are scoped to the caller; all=1 is owner-only", async () => {
    record("ana");
    record("bo");
    record(null, "turn_end");
    const a = app(store);
    const mine = (await (await a.request("/api/decider/decisions", { headers: human("ana") })).json()) as DeciderDecisionRecord[];
    expect(mine.map((d) => d.alias)).toEqual(["ana"]);
    expect((await a.request("/api/decider/decisions?all=1", { headers: human("ana") })).status).toBe(403);
    const all = (await (await a.request("/api/decider/decisions?all=1", { headers: human("owner") })).json()) as DeciderDecisionRecord[];
    expect(all).toHaveLength(3);
    const turnEnds = (await (
      await a.request("/api/decider/decisions?all=1&kind=turn_end", { headers: human("owner") })
    ).json()) as DeciderDecisionRecord[];
    expect(turnEnds).toHaveLength(1);
  });

  test("config tells the viewer whether they are the owner", async () => {
    const a = app(store);
    const ana = (await (await a.request("/api/decider/config", { headers: human("ana") })).json()) as DeciderConfigView;
    const owner = (await (await a.request("/api/decider/config", { headers: human("owner") })).json()) as DeciderConfigView;
    expect(ana.isOwner).toBe(false);
    expect(owner.isOwner).toBe(true);
  });

  test("suggest needs a person and a task", async () => {
    const a = app(store, async () => SUGGESTION);
    const worker = await a.request("/api/decider/suggest", {
      method: "POST",
      headers: { "x-test-user": "ana", "content-type": "application/json" },
      body: JSON.stringify({ task: "x" }),
    });
    expect(worker.status).toBe(403);
    const res = await a.request("/api/decider/suggest", { method: "POST", headers: human("ana"), body: JSON.stringify({ task: "  " }) });
    expect(res.status).toBe(400);
    const ok = await a.request("/api/decider/suggest", { method: "POST", headers: human("ana"), body: JSON.stringify({ task: "Add a retry" }) });
    expect(await ok.json()).toEqual(SUGGESTION);
  });

  test("suggest runs one at a time per person and caps the window", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const a = app(store, async () => {
      await gate;
      return SUGGESTION;
    });
    const post = (user: string) =>
      a.request("/api/decider/suggest", { method: "POST", headers: human(user), body: JSON.stringify({ task: "t" }) });
    const first = post("ana");
    expect((await post("ana")).status).toBe(429);
    // Another person is not held up.
    const other = post("bo");
    release();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);

    const b = app(store, async () => SUGGESTION);
    const postB = () =>
      b.request("/api/decider/suggest", { method: "POST", headers: human("cy"), body: JSON.stringify({ task: "t" }) });
    for (let i = 0; i < 20; i++) expect((await postB()).status).toBe(200);
    expect((await postB()).status).toBe(429);
  });
});
