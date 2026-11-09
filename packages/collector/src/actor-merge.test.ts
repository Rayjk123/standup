import { expect, test, describe } from "bun:test";
import {
  createStore,
  upsertProject,
  upsertActor,
  getActor,
  getActors,
} from "@standup/store";
import type { Store } from "@standup/store";
import type { Actor } from "@standup/shared";
import { createServer } from "./server.js";

/**
 * Identity reconciliation: POST /api/actors/:id/merge folds
 * one actor row into another so a teammate who answers in Slack (a `slack:U…`
 * actor) and drives sessions over the tunnel (a user-alias actor) counts as
 * one collaborator, not two. This is mergeActors' real call path — the Slack
 * adapter POSTs it once it maps a Slack user's email to their alias.
 */

function setUp(): { store: Store; app: ReturnType<typeof createServer> } {
  const store = createStore(":memory:");
  upsertProject(store.db, { id: "p", name: "p", branch: "main", repos: [] });
  return { store, app: createServer(store, () => {}, null) };
}

describe("POST /api/actors/:id/merge", () => {
  test("folds the Slack actor into the alias: getActor resolves, getActors hides it", async () => {
    const { store, app } = setUp();
    upsertActor(store.db, "slack:U1");
    upsertActor(store.db, "alice");

    const res = await app.request("/api/actors/slack%3AU1/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ into: "alice" }),
    });

    expect(res.status).toBe(200);
    const canonical = (await res.json()) as Actor;
    expect(canonical.id).toBe("alice");

    // Attribution that pointed at the Slack row now resolves to the human, and
    // the folded row no longer lists as a separate collaborator.
    expect(getActor(store.db, "slack:U1")?.id).toBe("alice");
    const ids = getActors(store.db).map((a) => a.id);
    expect(ids).toContain("alice");
    expect(ids).not.toContain("slack:U1");
    store.close();
  });

  test("400 when `into` is missing", async () => {
    const { store, app } = setUp();
    const res = await app.request("/api/actors/slack%3AU1/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    store.close();
  });
});
