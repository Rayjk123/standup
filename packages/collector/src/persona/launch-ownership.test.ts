import { describe, expect, test } from "bun:test";
import { createLaunch, createStore, personaJobForLaunch, upsertProject } from "@standup/store";
import { resolvePersonaConfig } from "./config.js";
import { PersonaRuntime } from "./runtime.js";

/*
 * A launch joins a Persona job only when it was launched as that Persona's
 * owner: a launch route answering with someone else's launch (a redelivered
 * key, a misrouted request) is refused, and no job of the owner's names it.
 */

const OWNER = "alice";

function harness(launchedBy: string | undefined) {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  const runtime = new PersonaRuntime({
    db: store.db,
    owner: OWNER,
    config: { ...resolvePersonaConfig({}), maxActive: 5 },
    broadcast: () => {},
    turnRunner: async () => ({ ok: true, text: "ok", sessionId: "sid", contextTokens: 1 }),
  });
  runtime.bindApp({
    request: async (path: string, init?: RequestInit) => {
      if (!/\/launch$/.test(path)) return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { task: string };
      createLaunch(store.db, { id: "L1", projectId: "p", task: body.task, worktreePath: "/wt/L1", branch: "b", launchedBy });
      return new Response(JSON.stringify({ launch: { id: "L1", projectId: "p", status: "starting", branch: "b" } }), { status: 200 });
    },
  });
  const launch = async (task: string) => {
    const result = await runtime.tools.call("launch_session", { task, projectId: "p" });
    return { isError: result.isError === true, text: result.content[0]!.text };
  };
  return { store, launch };
}

describe("linking a launch to a Persona job", () => {
  test("another user's launch is refused and joins no job", async () => {
    const h = harness("bob");
    const result = await h.launch("do the thing");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not launched as alice");
    expect(personaJobForLaunch(h.store.db, "L1")).toBeNull();
  });

  test("a launch with no recorded launcher is refused too", async () => {
    const h = harness(undefined);
    expect((await h.launch("do the thing")).isError).toBe(true);
    expect(personaJobForLaunch(h.store.db, "L1")).toBeNull();
  });

  test("the owner's own launch opens and links a job", async () => {
    const h = harness(OWNER);
    const result = await h.launch("do the thing");
    expect(result.isError).toBe(false);
    expect(personaJobForLaunch(h.store.db, "L1")?.job.owner).toBe(OWNER);
  });
});
